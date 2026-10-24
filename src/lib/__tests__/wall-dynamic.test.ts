import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * The pages that read Firestore must render per request. The CI build has no
 * Firestore access, so a prerender bakes the wall's error state ("No pudimos
 * cargar los animalitos") into static HTML (measured in the CI deploy log,
 * 2026-10-21). A 5-minute CDN cache keeps the reads bounded, and it must be
 * set in next.config.ts because Next marks dynamic pages `private, no-store`.
 */
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const ROUTES = ['src/app/page.tsx', 'src/app/adopt/page.tsx', 'src/app/events/page.tsx', 'src/app/donate/page.tsx', 'src/app/sitemap.ts'];
const PATHS = ['/', '/adopt', '/events', '/donate', '/sitemap.xml'];

test('the five Firestore-reading routes export dynamic = force-dynamic and no revalidate', () => {
  for (const f of ROUTES) {
    const src = read(f);
    assert.match(src, /^export const dynamic = 'force-dynamic';$/m, f);
    assert.ok(!/^export const revalidate\b/m.test(src), `${f} must not export revalidate`);
  }
});

test('next.config.ts sets s-maxage=300 for exactly those five paths', async () => {
  const mod = (await import('../../../next.config')).default;
  const rules = await mod.headers!();
  assert.deepEqual(rules.map((r) => r.source).sort(), [...PATHS].sort());
  for (const r of rules) {
    const cc = r.headers.find((h) => h.key === 'Cache-Control')?.value ?? '';
    assert.match(cc, /public, s-maxage=300, stale-while-revalidate=\d+/, r.source);
  }
});
