/**
 * Guards for `src/app/privacy/page.tsx`.
 *
 * The page is prose about the code, so no type checks it. These tests pin the
 * claims that would otherwise turn false silently: a tracking script added
 * while the page says there is none, or an adoption application becoming
 * erasable while the page says it is kept.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// LF-normalised, so a CRLF checkout on Windows reads the same as CI.
const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
    return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

/** The top-level `match /adoptionApplications/{applicationId}` block, nested matches included. */
function applicationRules(): string {
  const rules = read('firestore.rules');
  const start = rules.indexOf('\n    match /adoptionApplications/{applicationId} {');
  assert.ok(start >= 0, 'firestore.rules no longer has the adoptionApplications block');
  const end = rules.indexOf('\n    match /', start + 1);
  return rules.slice(start, end === -1 ? undefined : end);
}

test('the privacy page keeps the revalidate that stops a year-long Hosting cache', () => {
  assert.match(read('src/app/privacy/page.tsx'), /export const revalidate = 300;/);
});

test('the site footer links to the privacy page', () => {
  assert.match(read('src/components/SiteChrome.tsx'), /<Link href="\/privacy">Privacidad<\/Link>/);
});

test('the page says there is no analytics, so no analytics or ad script may exist in src', () => {
  assert.match(read('src/app/privacy/page.tsx'), /No usamos herramientas de analítica ni de publicidad/);
  const tracking = /gtag\(|googletagmanager|getAnalytics\(|firebase\/analytics|fbq\(/;
  const offenders = sourceFiles('src').filter((file) => tracking.test(read(file)));
  assert.deepEqual(offenders, [], 'update src/app/privacy/page.tsx in the same change that adds tracking');
});

test('the page says an application survives account deletion, and no handler or rule can erase it', () => {
  assert.match(read('src/app/privacy/page.tsx'), /no se borra cuando\s+borras tu cuenta/);

  for (const file of ['src/lib/account-delete.ts', 'src/app/api/account/delete/route.ts']) {
    const src = read(file);
    assert.doesNotMatch(
      src,
      /adoptionApplications|deleteApplication|deleteAdoption/,
      `${file} now touches applications: update the privacy page`,
    );
    // Since 2026-10-17 the route READS adoptions — one query, to refuse a
    // deletion while an animal is in the person's custody. It must never
    // write or delete one.
    for (const use of src.matchAll(/collection\(['"]adoptions['"]\)[^;]*;/g)) {
      assert.match(use[0], /^collection\('adoptions'\)\.where\('ownerUid', '==', uid\)\.limit\(1\)\.get\(\);$/, `${file}: ${use[0]}`);
    }
  }

  // The application's own rules sit six spaces deep; nested blocks sit deeper.
  // Any delete or write grant there other than `if false` makes it erasable.
  const block = applicationRules();
  assert.match(block, /^ {6}allow delete: if false;$/m);
  assert.doesNotMatch(
    block,
    /^ {6}allow [a-z, ]*\b(?:delete|write)\b[a-z, ]*: if (?!false;)/m,
    'the rules now let someone erase an application: update the privacy page',
  );
});

test('SWITCH-ON GUARD: the form is not switched on before /privacy explains the custody rule', async () => {
  // Since 2026-10-17 an account cannot be deleted while an adopted animal is
  // with its owner (the contract's third additional clause). Today no adoption
  // can exist, because the form is off; the /privacy rewrite of the switch-on
  // release (4f) must say this before the first one can.
  const { SHELTER } = await import('@/config/shelter');
  const page = read('src/app/privacy/page.tsx');
  assert.ok(
    !SHELTER.adoptionApplications.enabled || /devolver|devuelvas|devolución/.test(page),
    'adoptionApplications.enabled is true but /privacy does not explain that deleting your data while the animal is with you means returning it',
  );
});

// ─── The online application section (2026-10-17) ─────────────────────────────
// Each test pins one claim the page makes about the application to the file
// that makes it true, so a change there fails here until the page follows.

test('the page names OpenStreetMap while the map loads its tiles', async () => {
  const { SHELTER } = await import('@/config/shelter');
  const page = read('src/app/privacy/page.tsx');
  const usesLeaflet = /"leaflet"\s*:/.test(read('package.json'));
  const usesOsmTiles = /openstreetmap\.org/.test(SHELTER.map.tileUrl);
  assert.ok(
    !(usesLeaflet || usesOsmTiles || SHELTER.adoptionApplications.enabled) || /OpenStreetMap/.test(page),
    'the address map loads OpenStreetMap tiles: /privacy must say so',
  );
});

test('the page lists the consent record the acceptance route stores (time, IP, browser, account, contract)', () => {
  const page = read('src/app/privacy/page.tsx');
  const start = page.indexOf('Tu aceptación del compromiso de adopción');
  assert.ok(start >= 0, 'the consent-record section is gone');
  const sectionText = page.slice(start, page.indexOf('</section>', start));
  for (const phrase of [/fecha y la hora/, /dirección IP/, /navegador/, /tu cuenta/, /versión del compromiso/]) {
    assert.match(sectionText, phrase);
  }
  const handler = read('src/lib/acceptance-handler.ts');
  const receipt = handler.slice(handler.indexOf('export interface AcceptanceReceipt'), handler.indexOf('export interface AcceptanceDeps'));
  for (const field of ['applicantUid', 'applicantEmail', 'contractVersion', 'contractSha256', 'ip', 'userAgent']) {
    assert.match(receipt, new RegExp(`\\b${field}:`), `AcceptanceReceipt no longer stores ${field}: update /privacy`);
  }
});

test('the backup tail the page states is the one terraform declares', () => {
  const page = read('src/app/privacy/page.tsx');
  assert.match(page, /una copia diaria durante 14 días y una semanal durante 14 semanas/);
  const tf = read('terraform/firestore.tf');
  assert.match(tf, /retention = "1209600s"/, 'the daily Firestore backup is no longer 14 days: update /privacy');
  assert.match(tf, /retention = "8467200s"/, 'the weekly Firestore backup is no longer 14 weeks: update /privacy');
});

test('the page says the pin is rounded to about 11 m, and PIN_DECIMALS is still 4', async () => {
  const { PIN_DECIMALS } = await import('../applications');
  assert.match(read('src/app/privacy/page.tsx'), /redondeado a unos 11 metros/);
  assert.equal(PIN_DECIMALS, 4, 'the pin rounding changed: update /privacy');
});

test('the page says no application data reaches Gemini, so nothing under src/lib/ai names applications', () => {
  assert.match(read('src/app/privacy/page.tsx'), /Ningún dato de las postulaciones de adopción se envía a\s+Gemini/);
  const offenders = sourceFiles('src/lib/ai').filter((file) =>
    /adoptionApplications|adoption-ids|private\/home|id-document|applications-(?:admin|client)/.test(read(file)),
  );
  assert.deepEqual(offenders, [], 'an AI module now touches adoption applications: update /privacy');
});

test('the page lists what an application stores, and the rules still ask for it', () => {
  assert.match(read('src/app/privacy/page.tsx'), /Guarda tu nombre, tu WhatsApp, tu correo/);
  const keys = applicationRules().match(/applicationAnswerKeys\(\) \{\s*return \[([^\]]*)\]/);
  const listed = keys?.[1];
  assert.ok(listed, 'applicationAnswerKeys() not found in firestore.rules');
  for (const key of ['fullName', 'whatsapp']) {
    assert.ok(listed.includes(`'${key}'`), `the application no longer asks for ${key}: update the privacy page`);
  }
});
