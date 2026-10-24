import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSitemap, STATIC_SITEMAP_ROUTES } from '../sitemap';

const SITE = 'https://wawitas.org';
const urls = (pets: { slug: string; updatedAt?: Date }[] = []) =>
  buildSitemap(SITE, pets).map((e) => e.url);

test('static public routes are present with the siteUrl prefix', () => {
  const u = urls();
  assert.ok(u.includes('https://wawitas.org'));
  for (const r of ['/adopt', '/events', '/lost', '/help', '/donate', '/about', '/privacy']) {
    assert.ok(u.includes(`${SITE}${r}`), r);
  }
  assert.equal(STATIC_SITEMAP_ROUTES.length, 8);
});

// Flipped deliberately in PR 3b: /events used to be asserted ABSENT, as a
// "future" route, until the page existed. It is listed now.
test('/events is a listed static route, after /adopt', () => {
  assert.deepEqual([...STATIC_SITEMAP_ROUTES], ['/', '/adopt', '/events', '/lost', '/help', '/donate', '/about', '/privacy']);
});

test('published event pages are listed with their id encoded and lastModified when known', () => {
  const when = new Date('2026-10-14T00:00:00Z');
  const s = buildSitemap(SITE, [{ slug: 'luna' }], [
    { id: 'adopcion-de-halloween-2026-10-31', updatedAt: when },
    { id: 'feria-2026-11-07' },
  ]);
  const events = s.filter((e) => e.url.includes('/events/'));
  assert.deepEqual(
    events.map((e) => e.url),
    [`${SITE}/events/adopcion-de-halloween-2026-10-31`, `${SITE}/events/feria-2026-11-07`],
  );
  assert.equal(events[0]!.lastModified, when);
  assert.equal(events[1]!.lastModified, undefined);
  // Without events (the default), only the static /events route mentions them.
  assert.deepEqual(
    buildSitemap(SITE, []).filter((e) => e.url.includes('/events')).map((e) => e.url),
    [`${SITE}/events`],
  );
});

test('app/sitemap.ts reads events on their own try, so a failure keeps the pets', () => {
  const src = readFileSync(new URL('../../app/sitemap.ts', import.meta.url), 'utf8');
  assert.match(src, /getSitemapPets\(\)/);
  assert.match(src, /try \{\s*events = await getSitemapEvents\(\);\s*\} catch/);
});

test('a trailing slash on siteUrl does not double up', () => {
  assert.ok(buildSitemap('https://wawitas.org/', []).every((e) => !e.url.includes('org//')));
});

test('private and internal routes never appear', () => {
  const u = urls([{ slug: 'luna' }]).join('\n');
  for (const bad of ['/account', '/admin', '/api', '/id/', '/apply']) {
    assert.ok(!u.includes(bad), bad);
  }
});

test('only the passed pets appear, with slug encoded and lastModified when known', () => {
  const when = new Date('2026-10-01T00:00:00Z');
  const s = buildSitemap(SITE, [{ slug: 'ñoño peque', updatedAt: when }, { slug: 'luna' }]);
  const pets = s.filter((e) => e.url.includes('/adopt/'));
  assert.equal(pets.length, 2);
  assert.equal(pets[0]!.url, `${SITE}/adopt/${encodeURIComponent('ñoño peque')}`);
  assert.equal(pets[0]!.lastModified, when);
  assert.equal(pets[1]!.lastModified, undefined);
});

test('app/sitemap.ts renders per request (CDN cache is set in next.config.ts)', () => {
  const src = readFileSync(new URL('../../app/sitemap.ts', import.meta.url), 'utf8');
  assert.match(src, /export const dynamic = 'force-dynamic';/);
});

test('getSitemapPets filters on exactly available+lost and avoids getAllSlugs', () => {
  const src = readFileSync(new URL('../pets-server.ts', import.meta.url), 'utf8');
  const start = src.indexOf('export async function getSitemapPets');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.match(body, /where\('status', 'in', \['available', 'lost'\]\)/);
  assert.match(body, /\.limit\(1000\)/);
  assert.ok(!body.includes('getAllSlugs'));
});
