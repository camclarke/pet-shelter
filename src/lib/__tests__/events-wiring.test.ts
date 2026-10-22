import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Source guards for the events admin (PR 3a). There is no component-test
 * setup and `/admin/events` needs a password, so what can be checked is the
 * wiring: the limits the rules enforce are the limits the client checks, the
 * index the public page will need is declared and nothing single-field is,
 * and the screen goes through the zone-safe converter.
 */

// LF-normalised, so a CRLF checkout reads the same as CI.
const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

function eventsRulesBlock(): string {
  const rules = read('firestore.rules');
  const start = rules.indexOf('match /events/{eventId} {');
  const end = rules.indexOf('// ── default deny', start);
  assert.ok(start > 0 && end > start, 'CONTROL: the events block was found, before the default deny');
  return rules.slice(start, end);
}

test('the rules carry the same caps as EVENT_LIMITS', () => {
  const block = eventsRulesBlock();
  for (const needle of [
    'd.title.trim().size() >= 3 && d.title.size() <= 120',
    'd.description.size() <= 4000',
    'd.placeName.trim().size() >= 2 && d.placeName.size() <= 120',
    'optionalString(d.address, 200)',
    "d.endsAt <= d.startsAt + duration.value(31, 'd')",
    'd.endsAt >= d.startsAt',
    'eventId.size() <= 120',
    "eventId.matches('^[a-z0-9]+(-[a-z0-9]+)*$')",
  ]) {
    assert.ok(block.includes(needle), `rules lost: ${needle}`);
  }
});

test('the rules: drafts are admin-only, creates are born drafts, deletes only drafts', () => {
  const block = eventsRulesBlock();
  assert.match(block, /allow get, list: if isAdmin\(\) \|\| resource\.data\.published == true;/);
  assert.match(block, /allow create: if isAdmin\(\)[\s\S]*?request\.resource\.data\.published == false/);
  assert.match(block, /allow delete: if isAdmin\(\) && \(resource == null \|\| resource\.data\.published == false\);/);
  assert.match(block, /request\.resource\.data\.createdBy == resource\.data\.createdBy/);
  assert.match(block, /request\.resource\.data\.createdAt == resource\.data\.createdAt/);
});

test('every key the rules require is a key the create writes', () => {
  const block = eventsRulesBlock();
  const list = /function eventKeys\(\) \{\s*return \[([\s\S]*?)\];/.exec(block)?.[1] ?? '';
  const keys = [...list.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]).sort();
  assert.equal(keys.length, 13, 'CONTROL: the key list was parsed');
  const admin = read('src/lib/events-admin.ts');
  const create = /const write: EventCreateWrite = \{([\s\S]*?)\};/.exec(admin)?.[1] ?? '';
  const written = [...create.matchAll(/^\s*([a-zA-Z]+):/gm)].map((m) => m[1]).sort();
  assert.deepEqual(written, keys);
});

test('the public index is declared, and the events single-field orderings are not', () => {
  const file = JSON.parse(read('firestore.indexes.json')) as {
    indexes: { collectionGroup: string; queryScope: string; fields: { fieldPath: string; order: string }[] }[];
  };
  const events = file.indexes.filter((i) => i.collectionGroup === 'events');
  assert.deepEqual(
    events.map((i) => ({ scope: i.queryScope, fields: i.fields.map((f) => `${f.fieldPath} ${f.order}`) })),
    [{ scope: 'COLLECTION', fields: ['published ASCENDING', 'endsAt ASCENDING'] }],
  );
  // A declared single-field index gets the WHOLE file rejected at deploy.
  for (const index of file.indexes) assert.ok(index.fields.length >= 2, JSON.stringify(index));
});

test('create goes through a transaction, never a blind setDoc that would overwrite a twin', () => {
  const admin = read('src/lib/events-admin.ts');
  assert.match(admin, /export async function createEvent[\s\S]*?runTransaction\(db,/);
  assert.match(admin, /if \(existing\.exists\(\)\) continue;/);
  assert.doesNotMatch(admin, /\bsetDoc\(/);
  assert.match(admin, /published: false,/);
});

test('the admin page is noindex, gated, and carries revalidate = 300', () => {
  const page = read('src/app/admin/events/page.tsx');
  assert.match(page, /^export const revalidate = 300;$/m);
  assert.match(page, /robots: \{ index: false, follow: false \}/);
  assert.match(page, /<AdminGate section="events">/);
});

test('the screen converts times only through zoned-time, never with new Date(input)', () => {
  const panel = read('src/app/admin/events/EventsPanel.tsx')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(panel, /new Date\(/);
  assert.doesNotMatch(panel, /toLocale(Date|Time)?String/);
  assert.match(panel, /formatEventWhen\(/);
  assert.match(panel, /SHELTER\.timeZone/);
  // Publishing is its own action, not part of saving.
  assert.match(panel, /setEventPublished\(/);
  // The confirms are inline and name the event — never window.confirm, which
  // a dialog-blocking browser answers with a silent false.
  assert.doesNotMatch(panel, /window\.confirm/);
  assert.match(panel, /publish: copy\.publishConfirm,\s*cancel: copy\.cancelConfirm,\s*delete: copy\.deleteConfirm,\s*\}\[confirming\]\(event\.title\)/);
  // Publishing from the list waits for the confirm; only hiding runs at once.
  assert.match(panel, /: ask\(event, 'publish'\)/);
  assert.match(panel, /event\.status === 'scheduled' && event\.published\s*\? ask\(event, 'cancel'\)/);
  assert.match(panel, /onDelete: \(\) => ask\(event, 'delete'\)/);
  // An open editor disables every row action, so unsaved edits are never dropped.
  assert.match(panel, /disabled: busyId !== null \|\| saving \|\| mode !== null,/);
  // A stale document reloads with a neutral message, not "sign out".
  assert.match(panel, /code === 'permission-denied' \|\| code === 'not-found'/);
  assert.match(panel, /setMessage\(copy\.eventChanged\);\s*await load\(\)/);
});

test('the panel uses the admin write layer; the homepage and the site chrome do not', () => {
  const panel = read('src/app/admin/events/EventsPanel.tsx');
  assert.match(panel, /from '@\/lib\/events-admin'/);
  for (const file of ['src/app/page.tsx', 'src/components/SiteChrome.tsx']) {
    assert.doesNotMatch(read(file), /events-admin/, file);
  }
});

test('the dashboard links to /admin/events as a muted button', () => {
  const dashboard = read('src/app/admin/AdminDashboard.tsx');
  assert.match(dashboard, /<Link href="\/admin\/events" className="btn btn--muted">/);
});
