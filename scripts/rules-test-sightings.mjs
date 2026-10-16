/**
 * Test the `sightings` block of firestore.rules WITHOUT deploying it.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * withinServiceArea() read `geo.latitude` / `geo.longitude` as PROPERTIES. A
 * stored GeoPoint is a rules `latlng`, which has only the METHODS
 * `latitude()` and `longitude()`; property access on it is a type error
 * ("Received: [latlng] Expected: [map,path]"), and an error denies. So the
 * public sighting create — the lost-pet feature — could never succeed, and an
 * out-of-area sighting was denied by that same error rather than by the
 * bounds. MEASURED 2026-10-16 on this API. Nothing writes sightings yet, so no
 * user was affected.
 *
 * ── What it checks ────────────────────────────────────────────────────────
 * A valid anonymous in-area sighting is ALLOWED; a point exactly ON each of
 * the four bounds is allowed (the comparison is inclusive) and a point just
 * PAST each one is denied; a `geo` that is not a latlng (a string, a map with
 * an extra key) is denied; plus the other create guards a public endpoint
 * leans on: self-confirmation, an extra key, an empty or over-long note, a
 * backdated `reportedAt`. Two CONTROL cases run first against the
 * long-deployed `pets` rule, so a green run cannot be a harness that silently
 * evaluates nothing.
 *
 * ── Encoding (measured 2026-10-16, see test-application-rules.mjs) ────────
 * A JSON map with exactly `latitude` and `longitude` numbers arrives as a
 * `latlng`. An ISO-8601 string is a `timestamp`, so `reportedAt == TIME`
 * meets `== request.time`. `x-goog-user-project` is sent on every call, or
 * user credentials get a 403 that reads like a permissions failure.
 *
 * ── What it CANNOT check ──────────────────────────────────────────────────
 * App Check. It is enforced outside the rules, by the service.
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=wawitas node scripts/rules-test-sightings.mjs
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
const TIME = '2026-10-16T12:00:00Z';
const EARLIER = '2026-10-16T11:00:00Z';
const PET = 'nightprobe-sightings-pet'; // never written anywhere
const ID = 'nightprobe-sighting';

const ADMIN = { uid: 'nightprobe-sightings-admin', token: { admin: true } };

// SHELTER.bounds, as firestore.rules enforces them.
const MIN_LAT = -17.75;
const MAX_LAT = -17.15;
const MIN_LNG = -66.45;
const MAX_LNG = -65.85;
const MID_LAT = -17.39; // Cochabamba centre
const MID_LNG = -66.16;
const PAST = 0.01;

const geo = (latitude = MID_LAT, longitude = MID_LNG) => ({ latitude, longitude });

/** The exact shape a public sighting report is created with. */
const sighting = (over = {}) => ({
  geo: geo(),
  note: 'Lo vi cerca del mercado, con collar rojo.',
  photoUrl: null,
  contact: null,
  reportedAt: TIME,
  status: 'pending',
  reviewedBy: null,
  ...over,
});

function req(method, auth, path, newData) {
  const request = { method, path, time: TIME };
  if (auth) request.auth = auth;
  if (newData !== undefined) request.resource = { data: newData };
  return request;
}

const sightingPath = `${DOCS}/pets/${PET}/sightings/${ID}`;
const create = (data) => req('create', null, sightingPath, data);

/** name → [expectation, request, existing resource data | undefined] */
const CASES = [
  // ── controls on a rule that has been deployed and proven since 2026-08-23 ──
  ['CONTROL anonymous get pets/{id} is allowed', 'ALLOW', req('get', null, `${DOCS}/pets/${PET}`), { status: 'shelter' }],
  ['CONTROL anonymous create pets/{id} is denied', 'DENY', req('create', null, `${DOCS}/pets/${PET}`, { name: 'x' })],

  // ── the service area ──
  ['anonymous create of a valid in-area sighting is allowed', 'ALLOW', create(sighting())],
  ['create with only the required keys is allowed', 'ALLOW', create({ geo: geo(), note: 'Visto.', reportedAt: TIME, status: 'pending', reviewedBy: null })],
  ['create ON the south edge (minLat) is allowed', 'ALLOW', create(sighting({ geo: geo(MIN_LAT) }))],
  ['create ON the north edge (maxLat) is allowed', 'ALLOW', create(sighting({ geo: geo(MAX_LAT) }))],
  ['create ON the west edge (minLng) is allowed', 'ALLOW', create(sighting({ geo: geo(MID_LAT, MIN_LNG) }))],
  ['create ON the east edge (maxLng) is allowed', 'ALLOW', create(sighting({ geo: geo(MID_LAT, MAX_LNG) }))],
  ['create just SOUTH of the area is denied', 'DENY', create(sighting({ geo: geo(MIN_LAT - PAST) }))],
  ['create just NORTH of the area is denied', 'DENY', create(sighting({ geo: geo(MAX_LAT + PAST) }))],
  ['create just WEST of the area is denied', 'DENY', create(sighting({ geo: geo(MID_LAT, MIN_LNG - PAST) }))],
  ['create just EAST of the area is denied', 'DENY', create(sighting({ geo: geo(MID_LAT, MAX_LNG + PAST) }))],
  ['create with geo as a string is denied', 'DENY', create(sighting({ geo: '-17.39,-66.16' }))],
  ['create with geo as a map (an extra key) is denied', 'DENY', create(sighting({ geo: { ...geo(), accuracy: 5 } }))],

  // ── the other guards on a public write ──
  ['create that self-confirms is denied', 'DENY', create(sighting({ status: 'confirmed' }))],
  ['create that names a reviewer is denied', 'DENY', create(sighting({ reviewedBy: ADMIN.uid }))],
  ['create with an extra key is denied', 'DENY', create(sighting({ reporterUid: 'x' }))],
  ['create with an empty note is denied', 'DENY', create(sighting({ note: '' }))],
  ['create with a 501-character note is denied', 'DENY', create(sighting({ note: 'a'.repeat(501) }))],
  ['create with a backdated reportedAt is denied', 'DENY', create(sighting({ reportedAt: EARLIER }))],

  // ── triage ──
  ['anonymous get of a sighting is allowed', 'ALLOW', req('get', null, sightingPath), sighting()],
  ['admin update (triage) is allowed', 'ALLOW', req('update', ADMIN, sightingPath, sighting({ status: 'confirmed', reviewedBy: ADMIN.uid })), sighting()],
  ['anonymous update is denied', 'DENY', req('update', null, sightingPath, sighting({ note: 'editado' })), sighting()],
];

const source = readFileSync(rulesPath, 'utf8');

const testCases = CASES.map(([, expectation, request, existing]) => ({
  expectation,
  request,
  resource: existing === undefined ? null : { data: existing },
  expressionReportLevel: verbose ? 'VISITED' : 'NONE',
}));

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
