/**
 * Test the `events` block of firestore.rules WITHOUT deploying it.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * Same reason as `rules-test-qr-tokens.mjs`, which this follows: a new
 * collection's rules are not released until a human deploys them, so a
 * client-SDK probe today would meet default-deny on every branch and prove
 * nothing. The Rules `:test` endpoint evaluates an inline `source` against
 * inline cases and releases nothing, so it checks both the ALLOW and the DENY
 * branch of a rule that has never shipped.
 *
 * ── What it checks ────────────────────────────────────────────────────────
 * Public read of published events only; admin-only drafts; create born a
 * draft, in the exact shape, attributed to the caller and the server clock;
 * every length cap on BOTH sides of its edge (title 3/120, place 2/120,
 * address 200, description 4000, id 120) and the 31-day span to the second;
 * the minimums on TRIMMED text; length counted in UTF-16 units (60 emoji
 * fit 120, 61 do not); the id's lowercase pattern; a wrong TYPE on allDay,
 * published, description, placeName and title; immutable createdAt and
 * createdBy on update; delete only once unpublished, and an admin delete of
 * a missing doc as a no-op. Two CONTROL cases run
 * first against the long-deployed `pets` rule: if the request shape this
 * script sends were wrong, those would fail too, so a green run cannot be a
 * harness that silently evaluates nothing.
 *
 * Two guards are covered by NO case, because no case can reach them: the
 * `is string` on title and placeName (a non-string has no `trim()`, so the
 * next clause errors and denies anyway) and the `is timestamp` on startsAt /
 * endsAt (comparing a non-timestamp errors). Likewise `hasAll`: every one of
 * the 13 keys is read by some clause, and reading a missing key errors. They
 * are kept for the reader.
 * A break probe on 2026-10-15 measured this: every other mutation of the
 * block is caught by a named case below.
 *
 * ── What it CANNOT check ──────────────────────────────────────────────────
 * A real `list` QUERY. The test API takes a single hypothetical `resource`,
 * not query constraints. So "a list constrained to published == true" is
 * modelled as a list whose candidate document is published, and "an
 * unconstrained list" as one whose candidate is a draft (or absent). The real
 * query-shape check is a REST call after the deploy:
 * unauthenticated GET …/documents/events → 403, `:runQuery` with
 * `published == true` → 200.
 *
 * ── Encoding (measured 2026-09-12, see probe-food-rules.mjs) ──────────────
 * An ISO-8601 string in `request.resource.data` is a rules `timestamp`: it
 * passes `is timestamp`, compares with `== request.time`, and takes
 * `+ duration`. `x-goog-user-project` is sent on every call, or user
 * credentials get a 403 that reads like a permissions failure and is not one.
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=wawitas node scripts/rules-test-events.mjs
 *   ... --rules path/to/other.rules   test an edited copy (break-probing)
 *   ... --verbose                     print visited expressions on failure
 *
 * Exits non-zero if any case does not meet its expectation.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { GoogleAuth } from 'google-auth-library';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const rulesArg = args.indexOf('--rules');
const rulesPath = rulesArg >= 0 ? resolve(args[rulesArg + 1]) : join(REPO_ROOT, 'firestore.rules');
const verbose = args.includes('--verbose');

const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
if (!project) {
  throw new Error('GOOGLE_CLOUD_PROJECT is not set. Refusing to guess which project to bill.');
}

const DOCS = '/databases/(default)/documents';
const TIME = '2026-10-15T12:00:00Z';
const EARLIER = '2026-10-14T12:00:00Z';
// A fair on 31 October 2026, 15:00–19:00 La Paz (UTC−4).
const STARTS = '2026-10-31T19:00:00Z';
const ENDS = '2026-10-31T23:00:00Z';
const STARTS_PLUS_31D = '2026-12-01T19:00:00Z';
const STARTS_PLUS_31D_1S = '2026-12-01T19:00:01Z';
const STARTS_PLUS_40D = '2026-12-10T19:00:00Z';
const ID = 'nightprobe-feria-2026-10-31'; // never written anywhere
const PET = 'nightprobe-events-pet';

const ADMIN = { uid: 'nightprobe-events-admin', token: { admin: true } };
const OTHER_ADMIN = { uid: 'nightprobe-events-admin-2', token: { admin: true } };
const USER = { uid: 'nightprobe-events-user', token: {} };

/** The exact shape `events-admin.ts` writes on create. */
const draft = (over = {}) => ({
  title: 'Feria de adopción',
  description: 'Ven a conocer a los animalitos.\nTrae tu carnet.',
  startsAt: STARTS,
  endsAt: ENDS,
  allDay: false,
  placeName: 'Plaza Colón',
  address: null,
  status: 'scheduled',
  published: false,
  createdAt: TIME,
  createdBy: ADMIN.uid,
  updatedAt: TIME,
  updatedBy: ADMIN.uid,
  ...over,
});

/** A stored doc as an update finds it: written earlier, by ADMIN. */
const stored = (over = {}) => draft({ createdAt: EARLIER, updatedAt: EARLIER, ...over });

/** An update as the client sends it: the merged doc, re-stamped by the caller. */
const updated = (over = {}, by = ADMIN) =>
  draft({ createdAt: EARLIER, updatedAt: TIME, updatedBy: by.uid, ...over });

function req(method, auth, path, newData) {
  const request = { method, path, time: TIME };
  if (auth) request.auth = auth;
  if (newData !== undefined) request.resource = { data: newData };
  return request;
}

const eventPath = (id = ID) => `${DOCS}/events/${id}`;
const chars = (n, ch = 'a') => ch.repeat(n);

/** name → [expectation, request, existing resource data | undefined] */
const CASES = [
  // ── controls on a rule that has been deployed and proven since 2026-08-23 ──
  ['CONTROL anonymous get pets/{id} is allowed', 'ALLOW', req('get', null, `${DOCS}/pets/${PET}`), { status: 'shelter' }],
  ['CONTROL anonymous create pets/{id} is denied', 'DENY', req('create', null, `${DOCS}/pets/${PET}`, { name: 'x' })],

  // ── reads ──
  ['anonymous get of a PUBLISHED event is allowed', 'ALLOW', req('get', null, eventPath()), stored({ published: true })],
  ['anonymous get of a DRAFT is denied', 'DENY', req('get', null, eventPath()), stored()],
  ['anonymous get of a missing event is denied (ids cannot be probed)', 'DENY', req('get', null, eventPath())],
  ['admin get of a missing event is allowed (createEvent reads candidate ids)', 'ALLOW', req('get', ADMIN, eventPath())],
  ['signed-in non-admin get of a draft is denied', 'DENY', req('get', USER, eventPath()), stored()],
  ['admin get of a draft is allowed', 'ALLOW', req('get', ADMIN, eventPath()), stored()],
  ['anonymous list, candidate published (models where published == true) is allowed', 'ALLOW', req('list', null, eventPath()), stored({ published: true })],
  ['anonymous list, candidate a draft (models an unconstrained list) is denied', 'DENY', req('list', null, eventPath()), stored()],
  ['anonymous list with no candidate is denied', 'DENY', req('list', null, eventPath())],
  ['admin list of drafts is allowed', 'ALLOW', req('list', ADMIN, eventPath()), stored()],

  // ── create ──
  ['admin create of a valid draft is allowed', 'ALLOW', req('create', ADMIN, eventPath(), draft())],
  ['admin create of a valid all-day draft with an address is allowed', 'ALLOW', req('create', ADMIN, eventPath(), draft({ allDay: true, address: 'Av. Heroínas esq. Ayacucho' }))],
  ['admin create already published is denied', 'DENY', req('create', ADMIN, eventPath(), draft({ published: true }))],
  ['signed-in non-admin create is denied', 'DENY', req('create', USER, eventPath(), draft({ createdBy: USER.uid, updatedBy: USER.uid }))],
  ['anonymous create is denied', 'DENY', req('create', null, eventPath(), draft())],
  ['admin create with an extra key is denied', 'DENY', req('create', ADMIN, eventPath(), draft({ featuredPetIds: [] }))],
  ['admin create missing a key (address) is denied', 'DENY', req('create', ADMIN, eventPath(), (() => { const d = draft(); delete d.address; return d; })())],
  ['admin create with endsAt before startsAt is denied', 'DENY', req('create', ADMIN, eventPath(), draft({ startsAt: ENDS, endsAt: STARTS }))],
  ['admin create with endsAt == startsAt is allowed', 'ALLOW', req('create', ADMIN, eventPath(), draft({ endsAt: STARTS }))],
  ['admin create spanning exactly 31 days is allowed', 'ALLOW', req('create', ADMIN, eventPath(), draft({ endsAt: STARTS_PLUS_31D }))],
  ['admin create spanning 31 days + 1 second is denied', 'DENY', req('create', ADMIN, eventPath(), draft({ endsAt: STARTS_PLUS_31D_1S }))],
  ['admin create spanning 40 days is denied', 'DENY', req('create', ADMIN, eventPath(), draft({ endsAt: STARTS_PLUS_40D }))],
  ['admin create with a 3-char title is allowed', 'ALLOW', req('create', ADMIN, eventPath(), draft({ title: 'abc' }))],
  ['admin create with a 2-char title is denied', 'DENY', req('create', ADMIN, eventPath(), draft({ title: 'ab' }))],
  ['admin create with a title of 3 spaces is denied (the minimum is on trimmed text)', 'DENY', req('create', ADMIN, eventPath(), draft({ title: '   ' }))],
  ['admin create with "  ab  " as title is denied (6 long, 2 once trimmed)', 'DENY', req('create', ADMIN, eventPath(), draft({ title: '  ab  ' }))],
  ['admin create with a 120-char title is allowed', 'ALLOW', req('create', ADMIN, eventPath(), draft({ title: chars(120) }))],
  ['admin create with a 120-char ACCENTED title is allowed (ñ is one UTF-16 unit)', 'ALLOW', req('create', ADMIN, eventPath(), draft({ title: chars(120, 'ñ') }))],
  ['admin create with a 60-emoji title is allowed (120 UTF-16 units)', 'ALLOW', req('create', ADMIN, eventPath(), draft({ title: chars(60, '🐶') }))],
  ['admin create with a 61-emoji title is denied (size() counts UTF-16 units: 122)', 'DENY', req('create', ADMIN, eventPath(), draft({ title: chars(61, '🐶') }))],
  ['admin create with a 121-char title is denied', 'DENY', req('create', ADMIN, eventPath(), draft({ title: chars(121) }))],
  ['admin create with a 4000-char description is allowed', 'ALLOW', req('create', ADMIN, eventPath(), draft({ description: chars(4000) }))],
  ['admin create with a 4001-char description is denied', 'DENY', req('create', ADMIN, eventPath(), draft({ description: chars(4001) }))],
  ['admin create with a 2-char place is allowed', 'ALLOW', req('create', ADMIN, eventPath(), draft({ placeName: 'ab' }))],
  ['admin create with a 1-char place is denied', 'DENY', req('create', ADMIN, eventPath(), draft({ placeName: 'x' }))],
  ['admin create with a place of 2 spaces is denied (the minimum is on trimmed text)', 'DENY', req('create', ADMIN, eventPath(), draft({ placeName: '  ' }))],
  ['admin create with a 120-char place is allowed', 'ALLOW', req('create', ADMIN, eventPath(), draft({ placeName: chars(120) }))],
  ['admin create with a 121-char place is denied', 'DENY', req('create', ADMIN, eventPath(), draft({ placeName: chars(121) }))],
  ['admin create with a 200-char address is allowed', 'ALLOW', req('create', ADMIN, eventPath(), draft({ address: chars(200) }))],
  ['admin create with a 201-char address is denied', 'DENY', req('create', ADMIN, eventPath(), draft({ address: chars(201) }))],
  // ── types: each on its own, the rest of the document valid ──
  ['admin create with allDay as a string is denied', 'DENY', req('create', ADMIN, eventPath(), draft({ allDay: 'true' }))],
  ['admin create with published as a string is denied', 'DENY', req('create', ADMIN, eventPath(), draft({ published: 'false' }))],
  ['admin create with description as a number is denied', 'DENY', req('create', ADMIN, eventPath(), draft({ description: 42 }))],
  ['admin create with description as a list is denied (a list has size() too)', 'DENY', req('create', ADMIN, eventPath(), draft({ description: ['a'] }))],
  ['admin create with placeName as a number is denied', 'DENY', req('create', ADMIN, eventPath(), draft({ placeName: 42 }))],
  ['admin create with title as a number is denied', 'DENY', req('create', ADMIN, eventPath(), draft({ title: 42 }))],
  ['admin create with status postponed is denied', 'DENY', req('create', ADMIN, eventPath(), draft({ status: 'postponed' }))],
  ['admin create with a string startsAt (not a timestamp) is denied', 'DENY', req('create', ADMIN, eventPath(), draft({ startsAt: 'sábado' }))],
  ['admin create with a client-chosen createdAt is denied', 'DENY', req('create', ADMIN, eventPath(), draft({ createdAt: EARLIER }))],
  ['admin create attributed to another admin is denied', 'DENY', req('create', ADMIN, eventPath(), draft({ createdBy: OTHER_ADMIN.uid }))],
  ['admin create with updatedBy someone else is denied', 'DENY', req('create', ADMIN, eventPath(), draft({ updatedBy: OTHER_ADMIN.uid }))],
  ['admin create with a bad id "Hola Mundo" is denied', 'DENY', req('create', ADMIN, eventPath('Hola Mundo'), draft())],
  ['admin create with a 120-char id is allowed', 'ALLOW', req('create', ADMIN, eventPath(chars(120)), draft())],
  ['admin create with a 121-char id is denied', 'DENY', req('create', ADMIN, eventPath(chars(121)), draft())],
  ['admin create with an uppercase id "Feria-2026-10-31" is denied', 'DENY', req('create', ADMIN, eventPath('Feria-2026-10-31'), draft())],

  // ── update ──
  ['admin publish (published false → true) is allowed', 'ALLOW', req('update', ADMIN, eventPath(), updated({ published: true })), stored()],
  ['a DIFFERENT admin edits the title is allowed', 'ALLOW', req('update', OTHER_ADMIN, eventPath(), updated({ title: 'Feria navideña' }, OTHER_ADMIN)), stored()],
  ['admin cancel is allowed', 'ALLOW', req('update', ADMIN, eventPath(), updated({ status: 'cancelled', published: true })), stored({ published: true })],
  ['admin update changing createdBy is denied', 'DENY', req('update', ADMIN, eventPath(), updated({ createdBy: OTHER_ADMIN.uid })), stored()],
  ['admin update changing createdAt is denied', 'DENY', req('update', ADMIN, eventPath(), updated({ createdAt: TIME })), stored()],
  ['admin update keeping the OLD updatedAt is denied', 'DENY', req('update', ADMIN, eventPath(), updated({ updatedAt: EARLIER })), stored()],
  ['admin update attributed to another admin is denied', 'DENY', req('update', ADMIN, eventPath(), updated({ updatedBy: OTHER_ADMIN.uid })), stored()],
  ['admin update to a 40-day span is denied', 'DENY', req('update', ADMIN, eventPath(), updated({ endsAt: STARTS_PLUS_40D })), stored()],
  ['admin update adding a key is denied', 'DENY', req('update', ADMIN, eventPath(), updated({ coverPhoto: 'x' })), stored()],
  ['admin update setting published to a string is denied', 'DENY', req('update', ADMIN, eventPath(), updated({ published: 'true' })), stored()],
  ['admin update of a MISSING event is denied (the screen reloads)', 'DENY', req('update', ADMIN, eventPath(), updated({ title: 'Otra' }))],
  ['signed-in non-admin update is denied', 'DENY', req('update', USER, eventPath(), updated({ title: 'Otra' }, USER)), stored({ published: true })],

  // ── delete ──
  ['admin delete of a PUBLISHED event is denied', 'DENY', req('delete', ADMIN, eventPath()), stored({ published: true })],
  ['admin delete of a draft is allowed', 'ALLOW', req('delete', ADMIN, eventPath()), stored()],
  ['signed-in non-admin delete of a draft is denied', 'DENY', req('delete', USER, eventPath()), stored()],
  ['anonymous delete of a draft is denied', 'DENY', req('delete', null, eventPath()), stored()],
  ['admin delete of a MISSING event is allowed (a no-op, not a permission error)', 'ALLOW', req('delete', ADMIN, eventPath())],
  ['anonymous delete of a missing event is denied', 'DENY', req('delete', null, eventPath())],
  ['signed-in non-admin delete of a missing event is denied', 'DENY', req('delete', USER, eventPath())],
];

const source = readFileSync(rulesPath, 'utf8');

const testCases = CASES.map(([, expectation, request, existing]) => {
  // A case with no stored doc sends `resource: null` EXPLICITLY. Left out, the
  // API errors on any expression that mentions `resource` — so `resource ==
  // null` could never be true, and the missing-doc branches could not be
  // tested at all.
  const testCase = {
    expectation,
    request,
    resource: existing === undefined ? null : { data: existing },
    expressionReportLevel: verbose ? 'VISITED' : 'NONE',
  };
  return testCase;
});

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const client = await auth.getClient();

let response;
try {
  response = await client.request({
    url: `https://firebaserules.googleapis.com/v1/projects/${project}:test`,
    method: 'POST',
    headers: { 'x-goog-user-project': project },
    data: {
      source: { files: [{ name: 'firestore.rules', content: source }] },
      testSuite: { testCases },
    },
  });
} catch (err) {
  console.error('Rules test API call failed:', err?.response?.status, JSON.stringify(err?.response?.data ?? err.message));
  process.exit(2);
}

const { testResults = [], issues = [] } = response.data;
for (const issue of issues) {
  console.log(`issue [${issue.severity}] ${issue.description} @${JSON.stringify(issue.sourcePosition)}`);
}
if (testResults.length !== CASES.length) {
  console.error(`expected ${CASES.length} results, got ${testResults.length} — refusing to call that a pass`);
  process.exit(2);
}

let failures = 0;
testResults.forEach((result, i) => {
  const [name, expectation] = CASES[i];
  const ok = result.state === 'SUCCESS';
  if (!ok) failures++;
  console.log(`${ok ? 'ok    ' : 'FAILED'}  [${expectation}] ${name}`);
  if (!ok || verbose) {
    for (const message of result.debugMessages ?? []) console.log(`          debug: ${message}`);
    if (result.errorPosition) console.log(`          error at line ${result.errorPosition.line}`);
    if (verbose && result.visitedExpressions) {
      for (const v of result.visitedExpressions) {
        console.log(`          line ${v.sourcePosition?.line}:${v.sourcePosition?.column} → ${JSON.stringify(v.value)}`);
      }
    }
  }
});

console.log(`\n${CASES.length - failures}/${CASES.length} cases met their expectation (${rulesPath})`);
process.exit(failures === 0 ? 0 : 1);
