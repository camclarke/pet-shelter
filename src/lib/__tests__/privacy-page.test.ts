/**
 * Guards for `src/app/privacy/page.tsx`.
 *
 * The page is prose about the code, so no type checks it. These tests pin the
 * claims that would otherwise turn false silently: a tracking script added
 * while the page says there is none, or account deletion starting to remove
 * the adoption applications the page says are kept.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const read = (path: string) => readFileSync(path, 'utf8');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
    return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [path] : [];
  });
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

test('the page says applications survive account deletion, and the deletion handler agrees', () => {
  assert.match(read('src/app/privacy/page.tsx'), /la conservamos como registro/);
  const handler = read('src/lib/account-delete.ts');
  assert.doesNotMatch(handler, /adoptionApplications|deleteApplication/, 'deleting an account now removes applications: update the privacy page');
});
