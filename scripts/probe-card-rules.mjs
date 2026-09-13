/**
 * Prove what the DEPLOYED security rules do for the card-extraction path,
 * without deploying or writing anything. Build-order step 9.
 *
 *   npm run probe:card-rules
 *
 * ── What it does ────────────────────────────────────────────────────────────
 * Fetches the rulesets that are LIVE right now for `cloud.firestore` and for
 * the Storage bucket, and evaluates test cases against each through the
 * Firebase Rules test API (`projects.test`). Nothing is released, no document
 * or object is created, and nothing needs cleaning up.
 *
 * Every suite carries ALLOW cases as well as DENY cases, on purpose: a probe
 * whose request shape the API misreads denies everything, and a run with only
 * DENY expectations would then pass while proving nothing.
 *
 * ── Why this and not a client-SDK probe ─────────────────────────────────────
 * Step 9 needed NO rules change — the deployed `medical` rule is
 * `allow write: if isAdmin()` and the Storage `medical/{petId}/{fileName}` rule
 * is admin-only — so this measures the rules that already exist against the
 * exact documents and paths the new code writes and reads.
 *
 * ⚠️ `x-goog-user-project` is required on every call. Without it, a user
 * credential gets a 403 "requires a quota project", which reads exactly like a
 * permission problem and is not one.
 *
 * Needs ADC for the project owner (`gcloud auth application-default login`)
 * and GOOGLE_CLOUD_PROJECT (defaults to reading `.firebaserc`-free config:
 * pass `--project` otherwise).
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const argv = process.argv.slice(2);
const projectFlag = argv.indexOf('--project');
const PROJECT =
  (projectFlag >= 0 ? argv[projectFlag + 1] : undefined) ?? process.env.GOOGLE_CLOUD_PROJECT;
if (!PROJECT) {
  console.error('Set GOOGLE_CLOUD_PROJECT or pass --project <id>.');
  process.exit(2);
}

// The bucket comes from firebase.json, like scripts/release-storage-rules.mjs,
// so a forking shelter cannot silently test against wawitas-app.
const BUCKET = JSON.parse(readFileSync('firebase.json', 'utf8')).storage?.bucket;
if (!BUCKET) {
  console.error('firebase.json has no storage.bucket.');
  process.exit(2);
}

const token = execSync('gcloud auth application-default print-access-token', {
  encoding: 'utf8',
}).trim();
const headers = {
  Authorization: `Bearer ${token}`,
  'x-goog-user-project': PROJECT,
  'Content-Type': 'application/json',
};
const API = 'https://firebaserules.googleapis.com/v1';

async function call(method, url, body) {
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${url}\n${JSON.stringify(json, null, 2)}`);
  return json;
}

async function liveSource(release) {
  const rel = await call('GET', `${API}/projects/${PROJECT}/releases/${release}`);
  const ruleset = await call('GET', `${API}/${rel.rulesetName}`);
  return { name: rel.rulesetName, files: ruleset.source.files };
}

// ── identities ───────────────────────────────────────────────────────────────
const ADMIN = { uid: 'probe-admin', token: { admin: true, email: 'admin@example.com' } };
const MEMBER = { uid: 'probe-member', token: { email: 'member@example.com' } };
// Signed out: no `auth` key at all, so request.auth is null.

// ── Firestore: pets/{petId}/medical/{recordId} ───────────────────────────────
const RECORD = '/databases/(default)/documents/pets/probe-pet/medical/probe-record';

/** A candidate exactly as the route writes it — unconfirmed. */
const CANDIDATE = {
  kind: 'vaccination',
  name: 'Vacuna de prueba',
  performedAt: null,
  nextDueAt: null,
  validFrom: null,
  validUntil: null,
  veterinarian: null,
  clinic: null,
  batch: null,
  manufacturer: null,
  notes: null,
  codes: [],
  source: 'llm-extracted',
  confirmedBy: null,
  confirmedAt: null,
  sourceDocument: 'medical/probe-pet/card-0123abcd.jpg',
  extractedByModel: 'flash-lite',
  extractedAt: null,
  extractedFrom: 'vaccination-card',
  extractionEvidence: { name: { snippet: 'Vacuna de prueba', confidence: 0.9, withheld: null } },
  recordedBy: 'admin@example.com',
};
const CONFIRMED = { ...CANDIDATE, confirmedBy: 'admin@example.com' };

const firestoreCases = [
  ['admin writes an UNCONFIRMED candidate with the new fields', 'ALLOW', { auth: ADMIN, method: 'create', resource: { data: CANDIDATE } }],
  ['admin CONFIRMS a candidate (sets confirmedBy)', 'ALLOW', { auth: ADMIN, method: 'update', resource: { data: CONFIRMED } }, { data: CANDIDATE }],
  ['admin DISCARDS a candidate', 'ALLOW', { auth: ADMIN, method: 'delete' }, { data: CANDIDATE }],
  ['admin reads the history', 'ALLOW', { auth: ADMIN, method: 'get' }, { data: CANDIDATE }],
  ['a signed-in NON-admin reads a candidate (the recorded exposure: medical is the authenticated tier)', 'ALLOW', { auth: MEMBER, method: 'get' }, { data: CANDIDATE }],
  ['a signed-in NON-admin confirms a candidate', 'DENY', { auth: MEMBER, method: 'update', resource: { data: CONFIRMED } }, { data: CANDIDATE }],
  ['a signed-in NON-admin writes a candidate', 'DENY', { auth: MEMBER, method: 'create', resource: { data: CANDIDATE } }],
  ['a signed-in NON-admin discards a candidate', 'DENY', { auth: MEMBER, method: 'delete' }, { data: CANDIDATE }],
  ['signed out reads a candidate', 'DENY', { method: 'get' }, { data: CANDIDATE }],
  ['signed out writes a candidate', 'DENY', { method: 'create', resource: { data: CANDIDATE } }],
].map(([name, expectation, request, resource]) => ({
  name,
  testCase: {
    expectation,
    request: { path: RECORD, ...request },
    ...(resource ? { resource } : {}),
  },
}));

// ── Storage: medical/{petId}/{fileName} ──────────────────────────────────────
const object = (name) => `/b/${BUCKET}/o/${name}`;
const CARD = 'medical/probe-pet/card-0123abcd.jpg';
const JPEG = (name) => ({ name, bucket: BUCKET, size: 400_000, contentType: 'image/jpeg' });

const storageCases = [
  ['admin reads a card photo', 'ALLOW', { auth: ADMIN, method: 'get', path: object(CARD) }],
  ['admin uploads a card photo', 'ALLOW', { auth: ADMIN, method: 'create', path: object(CARD), resource: JPEG(CARD) }],
  ['admin deletes a card photo', 'ALLOW', { auth: ADMIN, method: 'delete', path: object(CARD) }],
  ['a signed-in NON-admin reads a card photo', 'DENY', { auth: MEMBER, method: 'get', path: object(CARD) }],
  ['a signed-in NON-admin uploads a card photo', 'DENY', { auth: MEMBER, method: 'create', path: object(CARD), resource: JPEG(CARD) }],
  ['signed out reads a card photo', 'DENY', { method: 'get', path: object(CARD) }],
  // The flat path is load-bearing: `{fileName}` is ONE segment.
  ['admin uploads to a NESTED medical/{pet}/cards/ path — no rule matches', 'DENY', { auth: ADMIN, method: 'create', path: object('medical/probe-pet/cards/card-0123abcd.jpg'), resource: JPEG('medical/probe-pet/cards/card-0123abcd.jpg') }],
  // Controls, so a DENY above means the rule and not a misread request shape.
  ['CONTROL: signed out reads a public pet photo', 'ALLOW', { method: 'get', path: object('pets/probe-pet/cover.jpg') }],
  ['CONTROL: signed out reads a private intake photo', 'DENY', { method: 'get', path: object('pets/probe-pet/private/0123abcd.jpg') }],
].map(([name, expectation, request]) => ({ name, testCase: { expectation, request } }));

// ── run ──────────────────────────────────────────────────────────────────────
async function suite(label, release, cases) {
  const source = await liveSource(release);
  const result = await call('POST', `${API}/projects/${PROJECT}:test`, {
    source: { files: source.files },
    testSuite: { testCases: cases.map((c) => c.testCase) },
  });

  console.log(`\n── ${label} — live ruleset ${source.name.split('/').pop()} ──`);
  if (result.issues?.length) console.log('issues:', JSON.stringify(result.issues, null, 2));

  let failures = 0;
  result.testResults.forEach((r, i) => {
    const ok = r.state === 'SUCCESS';
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${cases[i].testCase.expectation.padEnd(5)}  ${cases[i].name}`);
    if (!ok && r.debugMessages?.length) console.log(`          ${r.debugMessages.join(' | ')}`);
  });
  return { failures, total: cases.length };
}

const fs = await suite('Firestore pets/{petId}/medical', 'cloud.firestore', firestoreCases);
const st = await suite(`Storage ${BUCKET}`, `firebase.storage/${BUCKET}`, storageCases);

const failures = fs.failures + st.failures;
console.log(`\n${fs.total + st.total - failures}/${fs.total + st.total} as expected`);
process.exit(failures === 0 ? 0 : 1);
