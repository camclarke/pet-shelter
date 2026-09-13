/**
 * Prove what the security rules do for card extraction and its review, without
 * deploying or writing anything. Build-order step 9.
 *
 *   GOOGLE_CLOUD_PROJECT=wawitas npm run probe:card-rules
 *
 * Evaluates test cases through the Firebase Rules test API (`projects.test`).
 * Nothing is released, no document or object is created, nothing needs
 * cleaning up.
 *
 * ── Three suites ────────────────────────────────────────────────────────────
 *   1. Firestore, LOCAL `firestore.rules` — the PROPOSED ruleset, which adds
 *      the admin-only `medicalCandidates` rule (step-9 evaluation, 2026-09-13).
 *      Candidates: admin allowed every verb, everyone else denied. `medical`:
 *      unchanged for signed-in readers.
 *   2. Firestore, LIVE ruleset — what is deployed today. An admin's read of a
 *      candidate is DENIED here until the new rule is deployed; that case is
 *      the measurement that a deploy is still owed, and it will FAIL (correctly)
 *      once the deploy happens.
 *   3. Storage, LIVE ruleset — the card photo paths, unchanged by this PR.
 *
 * Every suite carries ALLOW cases as well as DENY cases, and controls: a probe
 * whose request shape the API misreads denies everything, and a run with only
 * DENY expectations would then pass while proving nothing.
 *
 * ⚠️ `x-goog-user-project` is required on every call. Without it a user
 * credential gets a 403 "requires a quota project", which reads exactly like a
 * permission problem and is not one.
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
  return { name: rel.rulesetName.split('/').pop(), files: ruleset.source.files };
}

const lf = (s) => s.replace(/\r\n/g, '\n');

// ── identities ───────────────────────────────────────────────────────────────
const ADMIN = { uid: 'probe-admin', token: { admin: true, email: 'admin@example.com' } };
const MEMBER = { uid: 'probe-member', token: { email: 'member@example.com' } };
const ADMIN_FALSE = { uid: 'probe-admin-false', token: { admin: false, email: 'nope@example.com' } };
// Signed out: no `auth` key at all, so request.auth is null.

// ── Firestore paths and documents ────────────────────────────────────────────
const DOCS = '/databases/(default)/documents';
const RECORD = `${DOCS}/pets/probe-pet/medical/probe-record`;
const CANDIDATE = `${DOCS}/pets/probe-pet/medicalCandidates/card-0123abcd-0`;
const UNDECLARED = `${DOCS}/pets/probe-pet/undeclared/probe-doc`;

/** A candidate exactly as the route writes it. */
const CANDIDATE_DOC = {
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
  sourceDocument: 'medical/probe-pet/card-0123abcd.jpg',
  extractedByModel: 'flash-lite',
  extractedAt: null,
  extractedFrom: 'vaccination-card',
  extractionEvidence: { name: { snippet: 'Vacuna de prueba', confidence: 0.9, withheld: null } },
  sourceIndex: 0,
  recordedBy: 'admin@example.com',
};

/** The record a confirmation creates. */
const CONFIRMED_RECORD = {
  ...CANDIDATE_DOC,
  sourceIndex: undefined,
  codes: [],
  source: 'llm-extracted',
  confirmedBy: 'admin@example.com',
  confirmedAt: null,
};
delete CONFIRMED_RECORD.sourceIndex;

function fsCase(name, expectation, path, request, existing) {
  return {
    name,
    testCase: {
      expectation,
      request: { path, ...request },
      ...(existing ? { resource: { data: existing } } : {}),
    },
  };
}

const proposedFirestore = [
  // candidates — admin, every verb
  fsCase('admin reads a candidate', 'ALLOW', CANDIDATE, { auth: ADMIN, method: 'get' }, CANDIDATE_DOC),
  fsCase('admin creates a candidate', 'ALLOW', CANDIDATE, { auth: ADMIN, method: 'create', resource: { data: CANDIDATE_DOC } }),
  fsCase('admin updates a candidate', 'ALLOW', CANDIDATE, { auth: ADMIN, method: 'update', resource: { data: CANDIDATE_DOC } }, CANDIDATE_DOC),
  fsCase('admin deletes (discards) a candidate', 'ALLOW', CANDIDATE, { auth: ADMIN, method: 'delete' }, CANDIDATE_DOC),
  // candidates — everyone else
  fsCase('a signed-in NON-admin reads a candidate', 'DENY', CANDIDATE, { auth: MEMBER, method: 'get' }, CANDIDATE_DOC),
  fsCase('a signed-in NON-admin creates a candidate', 'DENY', CANDIDATE, { auth: MEMBER, method: 'create', resource: { data: CANDIDATE_DOC } }),
  fsCase('a signed-in NON-admin updates a candidate', 'DENY', CANDIDATE, { auth: MEMBER, method: 'update', resource: { data: CANDIDATE_DOC } }, CANDIDATE_DOC),
  fsCase('a signed-in NON-admin deletes a candidate', 'DENY', CANDIDATE, { auth: MEMBER, method: 'delete' }, CANDIDATE_DOC),
  fsCase('a token with admin:false reads a candidate', 'DENY', CANDIDATE, { auth: ADMIN_FALSE, method: 'get' }, CANDIDATE_DOC),
  fsCase('signed out reads a candidate', 'DENY', CANDIDATE, { method: 'get' }, CANDIDATE_DOC),
  // medical — unchanged
  fsCase('medical UNCHANGED: a signed-in NON-admin reads a confirmed record', 'ALLOW', RECORD, { auth: MEMBER, method: 'get' }, CONFIRMED_RECORD),
  fsCase('medical UNCHANGED: signed out reads a record', 'DENY', RECORD, { method: 'get' }, CONFIRMED_RECORD),
  fsCase('admin creates the confirmed record', 'ALLOW', RECORD, { auth: ADMIN, method: 'create', resource: { data: CONFIRMED_RECORD } }),
  fsCase('a signed-in NON-admin creates a record', 'DENY', RECORD, { auth: MEMBER, method: 'create', resource: { data: CONFIRMED_RECORD } }),
  fsCase('a signed-in NON-admin self-confirms a record', 'DENY', RECORD, { auth: MEMBER, method: 'update', resource: { data: CONFIRMED_RECORD } }, CANDIDATE_DOC),
  // control: the candidates ALLOW is the new rule, not something broader
  fsCase('CONTROL: admin reads an undeclared subcollection', 'DENY', UNDECLARED, { auth: ADMIN, method: 'get' }, CANDIDATE_DOC),
];

const liveFirestore = [
  // Flipped 2026-09-13, when firestore.rules with `medicalCandidates` was
  // released (ruleset 4b3cdb65). Before that deploy this case was DENY, and
  // its failing was the planned sign that the deploy had landed.
  fsCase('LIVE: admin reads a candidate', 'ALLOW', CANDIDATE, { auth: ADMIN, method: 'get' }, CANDIDATE_DOC),
  fsCase('LIVE medical unchanged: a signed-in NON-admin reads a record', 'ALLOW', RECORD, { auth: MEMBER, method: 'get' }, CONFIRMED_RECORD),
];

// ── Storage: medical/{petId}/{fileName} ──────────────────────────────────────
const object = (name) => `/b/${BUCKET}/o/${name}`;
const CARD = 'medical/probe-pet/card-0123abcd.jpg';
const JPEG = (name) => ({ name, bucket: BUCKET, size: 400_000, contentType: 'image/jpeg' });

const liveStorage = [
  ['admin reads a card photo', 'ALLOW', { auth: ADMIN, method: 'get', path: object(CARD) }],
  ['admin uploads a card photo', 'ALLOW', { auth: ADMIN, method: 'create', path: object(CARD), resource: JPEG(CARD) }],
  ['admin deletes a card photo', 'ALLOW', { auth: ADMIN, method: 'delete', path: object(CARD) }],
  ['a signed-in NON-admin reads a card photo', 'DENY', { auth: MEMBER, method: 'get', path: object(CARD) }],
  ['a signed-in NON-admin uploads a card photo', 'DENY', { auth: MEMBER, method: 'create', path: object(CARD), resource: JPEG(CARD) }],
  ['signed out reads a card photo', 'DENY', { method: 'get', path: object(CARD) }],
  ['admin uploads to a NESTED medical/{pet}/cards/ path — no rule matches', 'DENY', { auth: ADMIN, method: 'create', path: object('medical/probe-pet/cards/card-0123abcd.jpg'), resource: JPEG('medical/probe-pet/cards/card-0123abcd.jpg') }],
  ['CONTROL: signed out reads a public pet photo', 'ALLOW', { method: 'get', path: object('pets/probe-pet/cover.jpg') }],
  ['CONTROL: signed out reads a private intake photo', 'DENY', { method: 'get', path: object('pets/probe-pet/private/0123abcd.jpg') }],
].map(([name, expectation, request]) => ({ name, testCase: { expectation, request } }));

// ── run ──────────────────────────────────────────────────────────────────────
async function suite(label, files, cases) {
  const result = await call('POST', `${API}/projects/${PROJECT}:test`, {
    source: { files },
    testSuite: { testCases: cases.map((c) => c.testCase) },
  });

  console.log(`\n── ${label} ──`);
  if (result.issues?.length) console.log('issues:', JSON.stringify(result.issues, null, 2));

  let failures = 0;
  (result.testResults ?? []).forEach((r, i) => {
    const ok = r.state === 'SUCCESS';
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${cases[i].testCase.expectation.padEnd(5)}  ${cases[i].name}`);
    if (!ok && r.debugMessages?.length) console.log(`          ${r.debugMessages.join(' | ')}`);
  });
  if (!result.testResults) failures = cases.length;
  return { failures, total: cases.length };
}

const localFirestore = [{ name: 'firestore.rules', content: readFileSync('firestore.rules', 'utf8') }];
const liveFs = await liveSource('cloud.firestore');
const liveSt = await liveSource(`firebase.storage/${BUCKET}`);

const liveLines = new Set(lf(liveFs.files[0].content).split('\n'));
const added = lf(localFirestore[0].content)
  .split('\n')
  .filter((line) => !liveLines.has(line));
console.log(
  `local firestore.rules vs live ${liveFs.name}: ${added.length} line(s) not in the deployed ruleset` +
    (added.length ? ` — first: ${JSON.stringify(added.find((l) => l.includes('match')) ?? added[0])}` : '')
);

const results = [
  await suite('Firestore — LOCAL firestore.rules (proposed)', localFirestore, proposedFirestore),
  await suite(`Firestore — LIVE ruleset ${liveFs.name}`, liveFs.files, liveFirestore),
  await suite(`Storage ${BUCKET} — LIVE ruleset ${liveSt.name}`, liveSt.files, liveStorage),
];

const failures = results.reduce((n, r) => n + r.failures, 0);
const total = results.reduce((n, r) => n + r.total, 0);
console.log(`\n${total - failures}/${total} as expected`);
process.exit(failures === 0 ? 0 : 1);
