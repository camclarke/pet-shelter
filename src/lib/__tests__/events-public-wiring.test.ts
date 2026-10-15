import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Source guards for the public events pages (PR 3b). No component-test setup
 * exists, and the pages read Firestore through the Admin SDK, so what can be
 * checked offline is the wiring: the reads say `published == true`, the
 * detail page 404s on a draft, user text never goes through
 * dangerouslySetInnerHTML, every route carries `revalidate`, and the homepage
 * cannot break because of events.
 */

// LF-normalised, so a CRLF checkout reads the same as CI.
const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
/** Source with comments removed, so a guard cannot be satisfied by a comment. */
const code = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const SERVER = 'src/lib/events-server.ts';
const LIST_PAGE = 'src/app/events/page.tsx';
const DETAIL_PAGE = 'src/app/events/[slug]/page.tsx';
const HOME_CARD = 'src/components/UpcomingEvents.tsx';

function body(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `CONTROL: found ${signature}`);
  const end = src.indexOf('\n}', start);
  return src.slice(start, end === -1 ? undefined : end);
}

test('every new events route exports revalidate = 300', () => {
  for (const file of [LIST_PAGE, DETAIL_PAGE]) {
    assert.match(read(file), /^export const revalidate = 300;$/m, file);
  }
  // The homepage that now hosts the card keeps its own.
  assert.match(read('src/app/page.tsx'), /^export const revalidate = 300;$/m);
});

test('the reader is server-only and goes through the Admin SDK', () => {
  const src = read(SERVER);
  assert.match(src, /^import 'server-only';$/m);
  assert.match(src, /from '\.\/firebase-admin'/);
});

test('getUpcomingEvents filters on published, cuts at La Paz start of day, and sorts by START after the endsAt query', () => {
  const fn = body(code(SERVER), 'export async function getUpcomingEvents');
  const where = fn.indexOf(".where('published', '==', true)");
  const range = fn.indexOf(".where('endsAt', '>=', cutoff)");
  const order = fn.indexOf(".orderBy('endsAt')");
  const sort = fn.indexOf('sortUpcoming(events, limit)');
  assert.ok(where > 0, 'the query says published == true');
  assert.ok(range > where, 'the range on endsAt follows the equality');
  assert.ok(order > range, 'ordered by endsAt, the range field');
  assert.ok(sort > order, 'sorted by startsAt (and only then cut) AFTER the query');
  assert.match(fn, /startOfDayInZone\(now, SHELTER\.timeZone\)/);
  assert.match(fn, /\.limit\(UPCOMING_READ_CAP\)/);
  // The query's own limit is the generous read cap, never the caller's.
  assert.doesNotMatch(fn, /\.limit\(limit\)/);
});

test('getPublishedEvent checks published === true itself — the Admin SDK would return a draft', () => {
  const src = code(SERVER);
  const start = src.indexOf('export const getPublishedEvent');
  assert.ok(start >= 0, 'CONTROL');
  const fn = src.slice(start, src.indexOf('\n});', start));
  assert.match(fn, /if \(data\?\.published !== true\) return null;/);
  assert.match(fn, /\.collection\('events'\)\.doc\(id\)\.get\(\)/);
});

test('the sitemap reader is bounded and filters on published', () => {
  const fn = body(code(SERVER), 'export async function getSitemapEvents');
  assert.match(fn, /\.where\('published', '==', true\)/);
  assert.match(fn, /\.limit\(500\)/);
});

test('nothing returned carries createdBy or updatedBy', () => {
  const pub = read('src/lib/events-public.ts');
  const iface = /export interface PublicEvent \{([\s\S]*?)\n\}/.exec(pub)?.[1] ?? '';
  assert.ok(iface.includes('placeName'), 'CONTROL: the interface was found');
  assert.doesNotMatch(iface, /createdBy|updatedBy|published/);
  assert.doesNotMatch(code(SERVER), /createdBy|updatedBy/);
  // Copied field by field, never spread from the document.
  const fromData = body(code('src/lib/events-public.ts'), 'export function publicEventFromData');
  assert.doesNotMatch(fromData, /\.\.\.data/);
});

test('the detail page 404s unless the getter returned a published event', () => {
  const src = code(DETAIL_PAGE);
  const page = body(src, 'export default async function EventPage');
  assert.match(page, /const event = await getPublishedEvent\(slug\);\s*if \(!event\) notFound\(\);/);
  // generateMetadata uses the same getter, so a draft's title never reaches <title>.
  const meta = body(src, 'export async function generateMetadata');
  assert.match(meta, /await getPublishedEvent\(slug\)/);
  assert.match(meta, /if \(!event\) return \{\};/);
});

test("the detail page's link preview names a cancellation — previews never read the JSON-LD", () => {
  const meta = body(code(DETAIL_PAGE), 'export async function generateMetadata');
  assert.match(meta, /buildEventShareText\(card, event\.description, copy\.cancelledBadge\)/);
  assert.match(meta, /title: share\.title,/);
  assert.match(meta, /description: share\.description,/);
  // The raw title alone would preview a cancelled fair as a scheduled one.
  assert.doesNotMatch(meta, /title: event\.title/);
});

test('both events routes restate og:type and og:locale; the list has its canonical and og:url', () => {
  // Next merges openGraph SHALLOWLY: a page-level object replaces the layout's.
  for (const file of [LIST_PAGE, DETAIL_PAGE]) {
    assert.match(code(file), /openGraph: eventsOpenGraph\(\{\s*locale: SHELTER\.locale,/, file);
  }
  const list = code(LIST_PAGE);
  assert.match(list, /alternates: \{ canonical: '\/events' \}/);
  assert.match(list, /url: '\/events',/);
});

test('dangerouslySetInnerHTML appears once, for JSON-LD, fed only by serializeJsonLd', () => {
  const src = code(DETAIL_PAGE);
  const uses = src.match(/dangerouslySetInnerHTML/g) ?? [];
  assert.equal(uses.length, 1);
  assert.match(src, /<script type="application\/ld\+json" dangerouslySetInnerHTML=\{\{ __html: jsonLd \}\} \/>/);
  assert.match(src, /const jsonLd = serializeJsonLd\(buildEventJsonLd\(event, SHELTER\)\);/);
  // The description renders as text nodes.
  assert.match(src, /descriptionParagraphs\(event\.description\)/);
  for (const file of [LIST_PAGE, HOME_CARD]) {
    assert.doesNotMatch(code(file), /dangerouslySetInnerHTML/, file);
  }
});

test('one .btn--action on the detail page, none on the list or the homepage card', () => {
  assert.equal((code(DETAIL_PAGE).match(/btn--action/g) ?? []).length, 1);
  assert.doesNotMatch(code(LIST_PAGE), /btn--action/);
  assert.doesNotMatch(code(HOME_CARD), /btn--action/);
  // The card's WhatsApp is the compact brand button.
  assert.match(code(LIST_PAGE), /className="btn btn--brand btn--compact event-card__cta"/);
});

test('external links open in a new tab with noopener', () => {
  for (const file of [LIST_PAGE, DETAIL_PAGE]) {
    const src = code(file);
    const blanks = src.match(/target="_blank"/g) ?? [];
    const safe = src.match(/target="_blank"\s+rel="noopener noreferrer"/g) ?? [];
    assert.ok(blanks.length > 0, `CONTROL: ${file} has new-tab links`);
    assert.equal(safe.length, blanks.length, file);
  }
});

test('the empty state keeps the approved copy, renders each network only if configured, and has no /adopt line', () => {
  const src = code(LIST_PAGE);
  const empty = body(src, 'function EventsEmpty');
  assert.match(empty, /copy\.emptyTitle/);
  assert.match(empty, /copy\.emptyBody/);
  assert.match(empty, /SHELTER\.instagram && \(/);
  assert.match(empty, /SHELTER\.facebook && \(/);
  assert.match(empty, /SHELTER\.whatsapp && \(/);
  assert.doesNotMatch(empty, /\/adopt/);
  // The error state is its own branch, never the empty one.
  assert.match(src, /\{failed && <p className="events__failed">\{copy\.loadFailed\}<\/p>\}/);
  assert.match(src, /\{!failed && cards\.length === 0 && <EventsEmpty \/>\}/);
});

test('the homepage card renders nothing without events, and nothing when the query throws', () => {
  const src = code(HOME_CARD);
  assert.match(src, /catch \(err\) \{[\s\S]*?return null;\s*\}/);
  assert.match(src, /if \(events\.length === 0\) return null;/);
  assert.match(read('src/app/page.tsx'), /<UpcomingEvents limit=\{3\} \/>/);
});

test('the public pages never import the admin write layer', () => {
  for (const file of [LIST_PAGE, DETAIL_PAGE, HOME_CARD, SERVER, 'src/lib/events-public.ts', 'src/app/sitemap.ts']) {
    assert.doesNotMatch(code(file), /events-admin/, file);
  }
});

test('the nav carries Eventos, and the narrow-width fade is in the stylesheet', () => {
  assert.match(read('src/components/SiteChrome.tsx'), /\{ href: '\/events', label: 'Eventos' \}/);
  const css = read('src/app/globals.css');
  const block = /@media \(max-width: 430px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  // Both declarations, each on its own line: the unprefixed one is a separate
  // needle so `-webkit-mask-image` alone cannot satisfy it.
  const fade = 'mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent);';
  assert.ok(block.includes(`\n    ${fade}`), 'unprefixed mask-image');
  assert.ok(block.includes(`\n    -webkit-${fade}`), '-webkit-mask-image');
  assert.match(block, /\.header__nav::after \{[\s\S]*?content: '';/);
  // The type is not shrunk to make five links fit.
  assert.doesNotMatch(block, /font-size/);
});

test('on a phone each nav link is a 44px tap target, at the same 12px type', () => {
  const css = read('src/app/globals.css');
  // The FIRST ≤760px block is the header's.
  const start = css.indexOf('@media (max-width: 760px) {');
  assert.ok(start >= 0, 'CONTROL: the phone block exists');
  const block = css.slice(start, css.indexOf('\n}', start));
  const rule = /\n  \.header__nav a \{([\s\S]*?)\n  \}/.exec(block)?.[1] ?? '';
  assert.ok(rule.includes('white-space: nowrap;'), 'CONTROL: the phone nav-link rule was found');
  assert.match(rule, /\n    display: inline-flex;/);
  assert.match(rule, /\n    align-items: center;/);
  assert.match(rule, /\n    min-height: 44px;/);
  assert.match(rule, /\n    font-size: 12px;/);
});

test('the sitemap guards the event query on its own', () => {
  const src = code('src/app/sitemap.ts');
  assert.match(src, /try \{\s*events = await getSitemapEvents\(\);\s*\} catch/);
  assert.match(src, /buildSitemap\(SHELTER\.siteUrl, pets, events\)/);
});
