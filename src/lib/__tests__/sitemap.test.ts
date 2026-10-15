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
  for (const r of ['/adopt', '/lost', '/help', '/about', '/privacy']) {
    assert.ok(u.includes(`${SITE}${r}`), r);
  }
  assert.equal(STATIC_SITEMAP_ROUTES.length, 6);
});

test('a trailing slash on siteUrl does not double up', () => {
  assert.ok(buildSitemap('https://wawitas.org/', []).every((e) => !e.url.includes('org//')));
});

test('private, internal and future routes never appear', () => {
  const u = urls([{ slug: 'luna' }]).join('\n');
  for (const bad of ['/account', '/admin', '/api', '/id/', '/apply', '/events']) {
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

test('app/sitemap.ts exports revalidate = 3600', () => {
  const src = readFileSync(new URL('../../app/sitemap.ts', import.meta.url), 'utf8');
  assert.match(src, /export const revalidate = 3600;/);
});

test('getSitemapPets filters on exactly available+lost and avoids getAllSlugs', () => {
  const src = readFileSync(new URL('../pets-server.ts', import.meta.url), 'utf8');
  const start = src.indexOf('export async function getSitemapPets');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.match(body, /where\('status', 'in', \['available', 'lost'\]\)/);
  assert.match(body, /\.limit\(1000\)/);
  assert.ok(!body.includes('getAllSlugs'));
});
