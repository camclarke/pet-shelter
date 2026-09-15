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
    assert.doesNotMatch(
      read(file),
      /adoptionApplications|['"]adoptions['"]|deleteApplication|deleteAdoption/,
      `${file} now touches adoption records: update the privacy page`,
    );
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

test('the page lists what an application stores, and the rules still ask for it', () => {
  assert.match(read('src/app/privacy/page.tsx'), /Guarda tu nombre, tu WhatsApp, tu correo/);
  const keys = applicationRules().match(/applicationAnswerKeys\(\) \{\s*return \[([^\]]*)\]/);
  const listed = keys?.[1];
  assert.ok(listed, 'applicationAnswerKeys() not found in firestore.rules');
  for (const key of ['fullName', 'whatsapp']) {
    assert.ok(listed.includes(`'${key}'`), `the application no longer asks for ${key}: update the privacy page`);
  }
});
