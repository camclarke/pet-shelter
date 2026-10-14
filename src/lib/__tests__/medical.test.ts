import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RABIES_MIN_AGE_WEEKS,
  RABIES_PROTECTION_DELAY_DAYS,
  byMostRecent,
  draftFromRecord,
  formWarnings,
  medicalEditFields,
  productExpiredBeforeDose,
  isOverdue,
  medicalDraftDefaults,
  medicalWarnings,
  offersRabiesProtectionStart,
  nextDue,
  protectionLapsed,
  rabiesAgeIsValid,
  rabiesProtectionStart,
  validateMedicalDraft,
  type MedicalRecordDraft,
} from '../medical';
import { parseDateInput } from '../date-input';
import { CLOCK_SKEW_TOLERANCE_MS } from '../placements';

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-26T12:00:00Z');

function draft(over: Partial<MedicalRecordDraft> = {}): MedicalRecordDraft {
  return {
    ...medicalDraftDefaults(),
    kind: 'vaccination',
    name: 'Rabia',
    performedAt: NOW - 30 * DAY,
    ...over,
  };
}

// ─── the Bolivia campaign case ───────────────────────────────────────────────

test('a vaccination with NO vet and NO batch is valid', () => {
  // Bolivia's free national rabies campaign produces exactly this. Rejecting it
  // would reject most of the real records this shelter holds.
  const errors = validateMedicalDraft(
    draft({ veterinarian: null, batch: null, clinic: null, manufacturer: null }),
    NOW
  );
  assert.deepEqual(errors, []);
});

// ─── structural errors ───────────────────────────────────────────────────────

test('kind, name and date are required', () => {
  const errors = validateMedicalDraft(
    draft({ kind: null, name: '   ', performedAt: null }),
    NOW
  );
  assert.ok(errors.includes('kind-required'));
  assert.ok(errors.includes('name-required'));
  assert.ok(errors.includes('performed-required'));
});

test('a dose dated in the future is rejected', () => {
  const errors = validateMedicalDraft(draft({ performedAt: NOW + 3 * DAY }), NOW);
  assert.ok(errors.includes('performed-in-future'));
});

test('a dose dated seconds ahead is NOT rejected — clocks drift', () => {
  // Firestore measured 2.7s ahead of this machine; a browser clock drifts by
  // minutes. Without tolerance a vet entering "today" is told it is the future.
  const errors = validateMedicalDraft(
    draft({ performedAt: NOW + CLOCK_SKEW_TOLERANCE_MS - 1000 }),
    NOW
  );
  assert.equal(errors.includes('performed-in-future'), false);
});

// ─── regression: a record dated TODAY must be saveable before noon ──────────
//
// `parseDateInput` stamps a picked `YYYY-MM-DD` at LOCAL NOON. The old
// `performedAt > now + tolerance` check compared that noon stamp against an
// INSTANT, so a shelter recording a vaccination given this morning was told
// the date "hasn't arrived yet" until the clock caught up to noon. Built with
// the LOCAL `Date` constructor throughout, never `Date.parse('...Z')`, so
// this passes or fails the same way in any timezone — CI runs UTC and this
// machine does not.

function localTime(hour: number, minute: number): number {
  return new Date(2026, 8, 15, hour, minute).getTime(); // 2026-09-15, fixed
}

test('a record dated today is accepted at 00:01, 09:00, 11:59 and 23:59', () => {
  const performedAt = parseDateInput('2026-09-15').getTime();
  for (const [hour, minute] of [[0, 1], [9, 0], [11, 59], [23, 59]] as const) {
    const errors = validateMedicalDraft(draft({ performedAt }), localTime(hour, minute));
    assert.equal(
      errors.includes('performed-in-future'),
      false,
      `today at ${hour}:${minute} should be accepted`
    );
  }
});

test('a record dated tomorrow is still rejected at 09:00 and 23:00', () => {
  const performedAt = parseDateInput('2026-09-16').getTime();
  for (const [hour, minute] of [[9, 0], [23, 0]] as const) {
    const errors = validateMedicalDraft(draft({ performedAt }), localTime(hour, minute));
    assert.ok(
      errors.includes('performed-in-future'),
      `tomorrow at ${hour}:${minute} should still be rejected`
    );
  }
});

test('a record dated 3 days ahead is still rejected', () => {
  const performedAt = parseDateInput('2026-09-18').getTime();
  const errors = validateMedicalDraft(draft({ performedAt }), localTime(9, 0));
  assert.ok(errors.includes('performed-in-future'));
});

test('the clock-skew allowance still works across midnight: 23:57 accepts tomorrow, 23:50 does not', () => {
  const performedAt = parseDateInput('2026-09-16').getTime();
  const near = validateMedicalDraft(draft({ performedAt }), localTime(23, 57));
  assert.equal(near.includes('performed-in-future'), false);
  const notYet = validateMedicalDraft(draft({ performedAt }), localTime(23, 50));
  assert.ok(notYet.includes('performed-in-future'));
});

test('a due date before the dose is rejected', () => {
  const errors = validateMedicalDraft(
    draft({ performedAt: NOW - 10 * DAY, nextDueAt: NOW - 20 * DAY }),
    NOW
  );
  assert.ok(errors.includes('due-before-performed'));
});

test('protection ending before it begins is rejected', () => {
  const errors = validateMedicalDraft(
    draft({ validFrom: NOW, validUntil: NOW - DAY }),
    NOW
  );
  assert.ok(errors.includes('valid-until-before-valid-from'));
});

// ─── warnings never block ────────────────────────────────────────────────────

test('a rabies dose given BEFORE the chip warns, and does not error', () => {
  const d = draft({ performedAt: NOW - 30 * DAY });
  const warnings = medicalWarnings(d, { microchipImplantedAt: NOW - 10 * DAY });
  assert.ok(warnings.includes('rabies-before-microchip'));
  // Crucially: still saveable.
  assert.deepEqual(validateMedicalDraft(d, NOW), []);
});

test('a chip implanted before the dose produces no warning', () => {
  const warnings = medicalWarnings(draft({ performedAt: NOW - 10 * DAY }), {
    microchipImplantedAt: NOW - 30 * DAY,
  });
  assert.equal(warnings.includes('rabies-before-microchip'), false);
});

test('an UNKNOWN implant date produces no opinion either way', () => {
  const warnings = medicalWarnings(draft(), { microchipImplantedAt: null });
  assert.equal(warnings.includes('rabies-before-microchip'), false);
});

// ─── the EU 2026/131 minimum-age rule ────────────────────────────────────────

test('rabies age validity is THREE-state, not a boolean', () => {
  // null means "cannot be evaluated", which is different from "too young".
  // Most street rescues have no birthdate at all.
  assert.equal(rabiesAgeIsValid(null, NOW), null);
});

test('an animal younger than 12 weeks at vaccination is flagged', () => {
  const birth = NOW - 8 * 7 * DAY; // 8 weeks old
  assert.equal(rabiesAgeIsValid(birth, NOW), false);
  const warnings = medicalWarnings(draft({ performedAt: NOW }), {
    birthdateApprox: birth,
  });
  assert.ok(warnings.includes('rabies-under-age'));
});

test('an animal at exactly 12 weeks is old enough', () => {
  const birth = NOW - RABIES_MIN_AGE_WEEKS * 7 * DAY;
  assert.equal(rabiesAgeIsValid(birth, NOW), true);
});

test('an unknown birthdate never produces an under-age warning', () => {
  const warnings = medicalWarnings(draft({ performedAt: NOW }), {
    birthdateApprox: null,
  });
  assert.equal(warnings.includes('rabies-under-age'), false);
});

test('a birthdate after the vaccination is unanswerable, not a violation', () => {
  assert.equal(rabiesAgeIsValid(NOW + DAY, NOW), null);
});

// ─── derived dates ───────────────────────────────────────────────────────────

test('rabies protection begins 21 days after the dose, not on the day', () => {
  // ⚠️ The 21 is written LITERALLY here, deliberately. Asserting against
  // RABIES_PROTECTION_DELAY_DAYS would be a tautology: changing the constant
  // would change both sides and the test could never fail. A break-probe
  // caught exactly that. 21 days is a legal figure from Reg. (EU) 2026/131,
  // so pinning it is the point.
  assert.equal(rabiesProtectionStart(NOW), NOW + 21 * DAY);
  assert.equal(RABIES_PROTECTION_DELAY_DAYS, 21);
});

test('a rabies record with no protection-start date is flagged', () => {
  const warnings = medicalWarnings(draft({ validFrom: null }));
  assert.ok(warnings.includes('rabies-no-valid-from'));
});

test('a non-rabies vaccination is not held to the rabies rules', () => {
  const warnings = medicalWarnings(
    draft({ name: 'Quíntuple', validFrom: null, nextDueAt: NOW + 365 * DAY }),
    { birthdateApprox: NOW - 4 * 7 * DAY }
  );
  assert.equal(warnings.includes('rabies-no-valid-from'), false);
  assert.equal(warnings.includes('rabies-under-age'), false);
});

// ─── due vs lapsed are different questions ───────────────────────────────────

test('a booster past its date is overdue', () => {
  assert.equal(isOverdue(NOW - DAY, NOW), true);
});

test('a booster due in the future is not overdue', () => {
  assert.equal(isOverdue(NOW + DAY, NOW), false);
});

test('a record with no due date is never overdue', () => {
  // A consultation has no booster and must not appear in a reminder list.
  assert.equal(isOverdue(null, NOW), false);
});

test('overdue tolerates clock skew', () => {
  assert.equal(isOverdue(NOW - 1000, NOW), false);
});

test('protection lapsing is a DIFFERENT question from a booster being due', () => {
  // Immunity commonly outlasts the booster interval. Conflating them is how an
  // animal gets revaccinated needlessly, or travels on cover that expired.
  const dueYesterday = NOW - DAY;
  const stillProtected = NOW + 200 * DAY;
  assert.equal(isOverdue(dueYesterday, NOW), true);
  assert.equal(protectionLapsed(stillProtected, NOW), false);
});

test('a record with no validUntil is not treated as lapsed', () => {
  assert.equal(protectionLapsed(null, NOW), false);
});

// ─── ordering ────────────────────────────────────────────────────────────────

test('history reads most recent first', () => {
  const sorted = byMostRecent([
    { performedAt: NOW - 100 * DAY, kind: 'vaccination' as const },
    { performedAt: NOW - 10 * DAY, kind: 'consultation' as const },
    { performedAt: NOW - 50 * DAY, kind: 'deworming' as const },
  ]);
  assert.deepEqual(
    sorted.map((r) => r.kind),
    ['consultation', 'deworming', 'vaccination']
  );
});

test('byMostRecent does not mutate its input', () => {
  const input = [
    { performedAt: 1, kind: 'vaccination' as const },
    { performedAt: 2, kind: 'consultation' as const },
  ];
  byMostRecent(input);
  assert.equal(input[0]!.performedAt, 1);
});

test('nextDue picks the soonest and ignores records with no due date', () => {
  const soonest = nextDue([
    { nextDueAt: null, confirmedBy: 'vet' },
    { nextDueAt: NOW + 300 * DAY, confirmedBy: 'vet' },
    { nextDueAt: NOW + 30 * DAY, confirmedBy: 'vet' },
  ]);
  assert.equal(soonest?.nextDueAt, NOW + 30 * DAY);
});

test('nextDue returns null when nothing is scheduled', () => {
  assert.equal(
    nextDue([
      { nextDueAt: null, confirmedBy: 'vet' },
      { nextDueAt: null, confirmedBy: 'vet' },
    ]),
    null
  );
});

// ─── frozen register records ask for nothing ─────────────────────────────────

const imported = { imported: true };
const typedNow = { imported: false };

function rabiesDraft(over: Partial<MedicalRecordDraft> = {}): MedicalRecordDraft {
  return { ...medicalDraftDefaults(), kind: 'vaccination', name: 'Antirrábica', performedAt: NOW - DAY, ...over };
}

test('an imported record raises no warning, even one a new record would', () => {
  const draft = rabiesDraft({ name: 'Octavalente' });
  // Control: the same draft, as a new record, IS warned about its next date.
  assert.ok(formWarnings(draft, {}, null).includes('vaccination-no-next-due'));
  assert.ok(formWarnings(draft, {}, typedNow).includes('vaccination-no-next-due'));
  assert.deepEqual(formWarnings(draft, {}, imported), []);
});

test('the +21 offer is for a rabies dose only', () => {
  assert.equal(offersRabiesProtectionStart(rabiesDraft(), null), true);
  for (const name of ['Octavalente', 'Vanguard Plus 5 L4']) {
    assert.equal(offersRabiesProtectionStart(rabiesDraft({ name }), null), false, name);
  }
  assert.equal(offersRabiesProtectionStart(rabiesDraft({ kind: 'deworming', name: 'Rabia' }), null), false);
});

test('the +21 offer never appears on an imported record, nor once a start date is set', () => {
  assert.equal(offersRabiesProtectionStart(rabiesDraft(), imported), false);
  assert.equal(offersRabiesProtectionStart(rabiesDraft({ validFrom: NOW }), null), false);
  assert.equal(offersRabiesProtectionStart(rabiesDraft({ performedAt: null }), null), false);
});

// ─── the label's product and the vial's expiry (C2, 2026-10-14) ──────────────
//
// Dates are built with the LOCAL constructor so the file means the same in CI
// (UTC) and in Bolivia (UTC-4). Hours are deliberate: a date typed for today is
// local midday, a date read off a label is 08:00.

const localDay = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h, 0).getTime();

test('a vial that expires ON the day of the dose is not expired — judged by calendar day', () => {
  // Expiry stamped 08:00, dose at 12:00 on the same day: comparing instants
  // would call this expired. The label means "good all day on the 14th".
  assert.equal(productExpiredBeforeDose(localDay(2026, 10, 14, 8), localDay(2026, 10, 14, 12)), false);
  assert.equal(productExpiredBeforeDose(localDay(2026, 10, 14, 23), localDay(2026, 10, 14, 0)), false);
});

test('a vial that expired the day BEFORE the dose is expired', () => {
  assert.equal(productExpiredBeforeDose(localDay(2026, 10, 13, 23), localDay(2026, 10, 14, 0)), true);
});

test('a vial that expires the day AFTER the dose is not expired', () => {
  assert.equal(productExpiredBeforeDose(localDay(2026, 10, 15, 0), localDay(2026, 10, 14, 23)), false);
});

test('no expiry, or no dose date, means no opinion', () => {
  assert.equal(productExpiredBeforeDose(null, localDay(2026, 10, 14)), false);
  assert.equal(productExpiredBeforeDose(localDay(2020, 1, 1), null), false);
});

test('an expired vial warns on any kind, and never blocks the save', () => {
  const expired = {
    performedAt: localDay(2026, 10, 14),
    productExpiresAt: localDay(2026, 9, 30),
  };
  for (const kind of ['vaccination', 'deworming'] as const) {
    const d = draft({ kind, name: 'Producto', ...expired });
    assert.ok(medicalWarnings(d).includes('product-expired-before-dose'), kind);
  }
  // A warning, not an error: the form stays saveable.
  assert.deepEqual(
    validateMedicalDraft(draft({ ...expired }), localDay(2026, 10, 14, 18)),
    []
  );
});

test('an imported register record never shows the expired-vial warning', () => {
  const d = draft({ performedAt: localDay(2026, 10, 14), productExpiresAt: localDay(2026, 9, 30) });
  assert.deepEqual(formWarnings(d, {}, { imported: true }), []);
});

test('the vial expiry is its own field: it never fills validUntil or nextDueAt', () => {
  const fields = medicalEditFields(
    draft({ product: '  Vanguard Plus 5 L4 ', productExpiresAt: localDay(2027, 5, 11) })
  );
  assert.equal(fields.product, 'Vanguard Plus 5 L4');
  assert.equal(fields.productExpiresAt, localDay(2027, 5, 11));
  assert.equal(fields.validUntil, null);
  assert.equal(fields.nextDueAt, null);
});

test('a blank product is stored as empty, not as spaces', () => {
  assert.equal(medicalEditFields(draft({ product: '   ' })).product, null);
});

test('a record with no product fields — imported, older, or a card reading — drafts as empty', () => {
  const draftOf = draftFromRecord({
    kind: 'vaccination',
    name: 'Octavalente',
    performedAt: localDay(2025, 8, 16),
    nextDueAt: null,
    validFrom: null,
    validUntil: null,
    veterinarian: null,
    clinic: null,
    batch: null,
    manufacturer: null,
    notes: null,
  });
  assert.equal(draftOf.product, null);
  assert.equal(draftOf.productExpiresAt, null);
});

test('a stored product and expiry survive the round trip into the edit form', () => {
  const draftOf = draftFromRecord({
    ...draft(),
    product: 'Defensor 3',
    productExpiresAt: localDay(2027, 1, 31),
  });
  assert.equal(draftOf.product, 'Defensor 3');
  assert.equal(draftOf.productExpiresAt, localDay(2027, 1, 31));
});
