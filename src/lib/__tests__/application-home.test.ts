/**
 * The home address an adoption application carries — portion 4a, plan §2.2.
 *
 * Run with:  node --test --import tsx src/lib/__tests__/application-home.test.ts
 *
 * What is pinned here is what the RULES will see: `validHome()` refuses an
 * address of 4 or 301 characters, a pin outside SHELTER.bounds, and a geo
 * without its precision. The browser must refuse the same things first, with
 * a reason the person can act on, and must never send a value that differs
 * from what they typed except by whitespace and the 4-decimal rounding.
 *
 * Every threshold is a LITERAL here. A test that compares a function against
 * the constant it uses cannot fail when the constant is wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  HOME_ADDRESS_MAX_CHARS,
  HOME_ADDRESS_MIN_CHARS,
  HOME_REFERENCE_MAX_CHARS,
  InvalidHomeError,
  buildHomeCreate,
  isServerTime,
  roundPin4,
  validateHome,
  type HomeDraft,
  type ValidHome,
} from '../applications';
import { SHELTER } from '@/config/shelter';
import { es } from '@/i18n/es';
import { findVoseo } from '../ai/spanish-register';

// The middle of Cochabamba's plaza, near enough.
const PLAZA = { latitude: -17.39351234, longitude: -66.15712345 };

function draft(over: Partial<HomeDraft> = {}): HomeDraft {
  return { addressText: 'Calle Sucre 123, zona Central', reference: '', pin: null, ...over };
}

// ─── roundPin4 ──────────────────────────────────────────────────────────────

test('a pin keeps 4 decimals (about 11 m)', () => {
  assert.deepEqual(roundPin4(PLAZA), { latitude: -17.3935, longitude: -66.1571 });
  assert.deepEqual(roundPin4({ latitude: -17.39356, longitude: -66.15718 }), {
    latitude: -17.3936,
    longitude: -66.1572,
  });
});

test('rounding is symmetric about zero and never yields -0', () => {
  assert.deepEqual(roundPin4({ latitude: 1.23456, longitude: -1.23456 }), { latitude: 1.2346, longitude: -1.2346 });
  const tiny = roundPin4({ latitude: -0.00001, longitude: 0.00001 });
  assert.ok(Object.is(tiny.latitude, 0), 'latitude came back as -0');
  assert.ok(Object.is(tiny.longitude, 0));
});

test('rounding is idempotent: a stored pin re-validates to itself', () => {
  const once = roundPin4(PLAZA);
  assert.deepEqual(roundPin4(once), once);
});

// ─── validateHome ───────────────────────────────────────────────────────────

test('the configured limits are the ones the rules enforce', () => {
  // Literals, on purpose: firestore.rules says 5 and 300 and 300.
  assert.equal(HOME_ADDRESS_MIN_CHARS, 5);
  assert.equal(HOME_ADDRESS_MAX_CHARS, 300);
  assert.equal(HOME_REFERENCE_MAX_CHARS, 300);
});

test('an address of 5 or 300 characters is accepted; 4 or 301 is refused', () => {
  assert.equal(validateHome(draft({ addressText: 'a'.repeat(5) })).valid, true);
  assert.equal(validateHome(draft({ addressText: 'a'.repeat(300) })).valid, true);
  assert.equal(validateHome(draft({ addressText: 'a'.repeat(4) })).errors.addressText, 'address-too-short');
  assert.equal(validateHome(draft({ addressText: 'a'.repeat(301) })).errors.addressText, 'address-too-long');
});

test('an empty address is required, and whitespace does not count toward the minimum', () => {
  assert.equal(validateHome(draft({ addressText: '   ' })).errors.addressText, 'address-required');
  // The rules trim before counting, so the browser must too.
  assert.equal(validateHome(draft({ addressText: '   abcd   ' })).errors.addressText, 'address-too-short');
});

test('the address and reference are tidied to one line, never cut', () => {
  const { home } = validateHome(
    draft({ addressText: '  Calle   Sucre\n 123  ', reference: '\tfrente a\n\nla cancha ' }),
  );
  assert.deepEqual(home && { a: home.addressText, r: home.reference }, {
    a: 'Calle Sucre 123',
    r: 'frente a la cancha',
  });
});

test('the reference may be empty, and is refused past 300 characters', () => {
  assert.equal(validateHome(draft({ reference: '' })).valid, true);
  assert.equal(validateHome(draft({ reference: 'b'.repeat(300) })).valid, true);
  assert.equal(validateHome(draft({ reference: 'b'.repeat(301) })).errors.reference, 'reference-too-long');
});

test('no pin is a valid answer: geo and precision are both null', () => {
  const { home, valid } = validateHome(draft());
  assert.equal(valid, true);
  assert.equal(home?.geo, null);
  assert.equal(home?.precision, null);
});

test('a pin inside the service area is stored rounded, with precision exact', () => {
  const { home } = validateHome(draft({ pin: PLAZA }));
  assert.deepEqual(home?.geo, { latitude: -17.3935, longitude: -66.1571 });
  assert.equal(home?.precision, 'exact');
});

test('a pin past each of the four edges is refused', () => {
  // SHELTER.bounds as literals: −17.75 / −17.15 latitude, −66.45 / −65.85 longitude.
  const outside = [
    { latitude: -17.7501, longitude: -66.1 }, // south
    { latitude: -17.1499, longitude: -66.1 }, // north
    { latitude: -17.4, longitude: -66.4501 }, // west
    { latitude: -17.4, longitude: -65.8499 }, // east
  ];
  for (const pin of outside) {
    assert.equal(validateHome(draft({ pin })).errors.pin, 'pin-outside-area', JSON.stringify(pin));
  }
});

test('a pin exactly on an edge is inside, as the rules say (>= and <=)', () => {
  for (const pin of [
    { latitude: -17.75, longitude: -66.45 },
    { latitude: -17.15, longitude: -65.85 },
  ]) {
    assert.equal(validateHome(draft({ pin })).valid, true, JSON.stringify(pin));
  }
});

test('the area is checked AFTER rounding, because the rounded value is what is stored', () => {
  // 0.00004° north of the edge rounds onto it; 0.00006° north rounds past it.
  assert.equal(validateHome(draft({ pin: { latitude: -17.14996, longitude: -66.1 } })).valid, true);
  assert.equal(
    validateHome(draft({ pin: { latitude: -17.14994, longitude: -66.1 } })).errors.pin,
    'pin-outside-area',
  );
});

test('a pin that is not a point on Earth is refused as invalid, not as outside', () => {
  for (const pin of [
    { latitude: Number.NaN, longitude: -66.1 },
    { latitude: -17.4, longitude: Number.POSITIVE_INFINITY },
    { latitude: -91, longitude: -66.1 },
    { latitude: -17.4, longitude: 181 },
  ]) {
    assert.equal(validateHome(draft({ pin })).errors.pin, 'pin-invalid', JSON.stringify(pin));
  }
});

test('the default service area is SHELTER.bounds', () => {
  assert.deepEqual(SHELTER.bounds, { minLat: -17.75, maxLat: -17.15, minLng: -66.45, maxLng: -65.85 });
});

// ─── buildHomeCreate ────────────────────────────────────────────────────────

function valid(over: Partial<HomeDraft> = {}): ValidHome {
  const { home } = validateHome(draft(over));
  assert.ok(home, 'fixture did not validate');
  return home;
}

test('the home document has exactly the six keys the rules require', () => {
  const write = buildHomeCreate({ applicantUid: 'uidAna', home: valid({ pin: PLAZA }) });
  assert.deepEqual(Object.keys(write).sort(), [
    'addressText',
    'applicantUid',
    'createdAt',
    'geo',
    'precision',
    'reference',
  ]);
  assert.equal(write.applicantUid, 'uidAna');
  assert.ok(isServerTime(write.createdAt), 'createdAt must be the server clock');
  assert.deepEqual(write.geo, { latitude: -17.3935, longitude: -66.1571 });
  assert.equal(write.precision, 'exact');
});

test('the home builder re-validates instead of trusting its argument', () => {
  // A caller that skipped validateHome must not be able to write.
  const forged = [
    { addressText: 'abc', reference: '', geo: null, precision: null },
    { addressText: 'Calle Sucre 123', reference: '', geo: { latitude: 10, longitude: 10 }, precision: 'exact' },
    { addressText: 'Calle Sucre 123', reference: '', geo: { latitude: -17.4, longitude: -66.1 }, precision: null },
    { addressText: 'Calle Sucre 123', reference: '', geo: null, precision: 'exact' },
  ] as ValidHome[];
  for (const home of forged) {
    assert.throws(() => buildHomeCreate({ applicantUid: 'uidAna', home }), InvalidHomeError, JSON.stringify(home));
  }
  assert.throws(() => buildHomeCreate({ applicantUid: '', home: valid() }));
});

test('the home builder never writes a finer pin than 4 decimals', () => {
  const sneaky = { ...valid(), geo: PLAZA, precision: 'exact' } as ValidHome;
  assert.deepEqual(buildHomeCreate({ applicantUid: 'uidAna', home: sneaky }).geo, {
    latitude: -17.3935,
    longitude: -66.1571,
  });
});

// ─── copy ───────────────────────────────────────────────────────────────────

const HOME_ERRORS = [
  'address-required',
  'address-too-short',
  'address-too-long',
  'reference-too-long',
  'pin-invalid',
  'pin-outside-area',
] as const;

test('every home error has Spanish copy in neutral tuteo', () => {
  for (const error of HOME_ERRORS) {
    const text = es.applicationHomeError(error);
    assert.ok(text.length > 0, error);
    assert.deepEqual(findVoseo(text), [], text);
  }
  assert.deepEqual(findVoseo(es.approvalBlocker('id-document-missing')), []);
});

test('the length errors name the limits the module enforces', () => {
  assert.ok(es.applicationHomeError('address-too-long').includes(`${HOME_ADDRESS_MAX_CHARS} caracteres`));
  assert.ok(es.applicationHomeError('reference-too-long').includes(`${HOME_REFERENCE_MAX_CHARS} caracteres`));
});

test('an out-of-area pin offers WhatsApp rather than a dead end', () => {
  assert.match(es.applicationHomeError('pin-outside-area'), /WhatsApp/);
  assert.ok(es.applicationHomeError('pin-outside-area').includes(SHELTER.city));
});

// ─── the rules copy of the same limits ──────────────────────────────────────

test('validHome() in firestore.rules carries the same limits', () => {
  const rules = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8').replace(/\r\n/g, '\n');
  const start = rules.indexOf('function validHome(d) {');
  assert.ok(start >= 0, 'firestore.rules no longer defines validHome()');
  const body = rules.slice(start, rules.indexOf('}', start));
  assert.ok(body.includes('d.addressText.trim().size() >= 5'), 'address minimum drifted');
  assert.ok(body.includes('d.addressText.size() <= 300'), 'address maximum drifted');
  assert.ok(body.includes('d.reference.size() <= 300'), 'reference maximum drifted');
  assert.ok(body.includes("d.precision == 'exact'"), 'precision is no longer pinned to exact');
  assert.ok(body.includes('d.geo is latlng && pinWithinServiceArea(d.geo)'), 'the pin is no longer type- and area-checked');
});
