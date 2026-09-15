/**
 * Prove what the account rules do, without deploying or writing anything.
 *
 *   GOOGLE_CLOUD_PROJECT=wawitas npm run probe:account-rules
 *
 * Evaluates the LOCAL `firestore.rules` (users/{uid}) and `storage.rules`
 * (users/{uid}/avatar/{fileName}) through the Firebase Rules test API,
 * `projects.test`. Nothing is released, no document or object is created,
 * nothing needs cleaning up.
 *
 * Every suite carries ALLOW cases as well as DENY cases, plus controls on
 * rules this change does not touch: a probe whose request shape the API
 * misreads denies everything, and a run with only DENY expectations would then
 * pass while proving nothing.
 *
 * A green run proves the PREDICATES. It does not prove the rules are
 * deployed — `firebase deploy --only firestore:rules` and
 * `npm run deploy:storage-rules` do that — and it does not prove the client
 * writes these shapes; `account-wiring.test.ts` couples the two.
 *
 * ⚠️ `x-goog-user-project` is required on every call. Without it a user
 * credential gets a 403 "requires a quota project", which reads exactly like a
 * permission problem and is not one.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
if (!PROJECT) {
  console.error('Set GOOGLE_CLOUD_PROJECT.');
  process.exit(2);
}

// The bucket comes from firebase.json, like scripts/release-storage-rules.mjs.
const BUCKET = JSON.parse(readFileSync('firebase.json', 'utf8')).storage?.bucket;
if (!BUCKET) {
  console.error('firebase.json has no storage.bucket.');
  process.exit(2);
}

const token = execSync('gcloud auth application-default print-access-token', { encoding: 'utf8' }).trim();
const headers = {
  Authorization: `Bearer ${token}`,
  'x-goog-user-project': PROJECT,
  'Content-Type': 'application/json',
};
const API = 'https://firebaserules.googleapis.com/v1';

const T = '2026-09-15T12:00:00Z';
const UID = 'ProbeAcct01';
const OTHER = 'ProbeAcct02';
const EMAIL = 'probe-acct-01@example.com';

const USER = { uid: UID, token: { email: EMAIL } };
const OTHER_USER = { uid: OTHER, token: { email: 'probe-acct-02@example.com' } };
const ADMIN = { uid: 'ProbeAdmin9', token: { email: 'probe-admin@example.com', admin: true } };

const GOOGLE_PHOTO = 'https://lh3.googleusercontent.com/a/ACg8ocProbe=s96-c';
const avatarUrl = (uid) =>
  `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/users%2F${uid}%2Favatar%2F1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed.jpg?alt=media&token=t`;

const profile = (over = {}) => ({
  uid: UID,
  email: EMAIL,
  displayName: 'Probe',
  photoURL: null,
  createdAt: T,
  ...over,
});

// ── Firestore ───────────────────────────────────────────────────────────────
const docPath = (path) => `/databases/(default)/documents/${path}`;

function fsCase(name, expectation, path, request, existing) {
  return {
    name,
    testCase: {
      expectation,
      request: { path: docPath(path), time: T, ...request },
      ...(existing ? { resource: { data: existing } } : {}),
    },
  };
}

const create = (auth, data, path = `users/${UID}`) => ({ auth, method: 'create', resource: { data } });
const update = (auth, data) => ({ auth, method: 'update', resource: { data } });

const firestoreCases = [
  // create
  fsCase('self creates a minimal profile (no name, no photo)', 'ALLOW', `users/${UID}`, create(USER, profile({ displayName: null }))),
  fsCase('self creates with a name and a Google photo', 'ALLOW', `users/${UID}`, create(USER, profile({ photoURL: GOOGLE_PHOTO }))),
  fsCase('self creates naming an email that is NOT in the token', 'DENY', `users/${UID}`, create(USER, profile({ email: 'someone-else@example.com' }))),
  fsCase('self creates with a tracking-pixel photo', 'DENY', `users/${UID}`, create(USER, profile({ photoURL: 'https://tracker.example/p.gif' }))),
  fsCase("self creates with ANOTHER user's avatar URL", 'DENY', `users/${UID}`, create(USER, profile({ photoURL: avatarUrl(OTHER) }))),
  fsCase('self creates with a 61-character name', 'DENY', `users/${UID}`, create(USER, profile({ displayName: 'a'.repeat(61) }))),
  fsCase('self creates with an empty-string name', 'DENY', `users/${UID}`, create(USER, profile({ displayName: '' }))),
  fsCase('self creates with a 60-character name', 'ALLOW', `users/${UID}`, create(USER, profile({ displayName: 'a'.repeat(60) }))),
  fsCase('self creates with role: admin', 'DENY', `users/${UID}`, create(USER, profile({ role: 'admin' }))),
  fsCase("creates another user's profile", 'DENY', `users/${OTHER}`, create(USER, profile({ uid: OTHER }))),

  // update
  fsCase('self changes the name', 'ALLOW', `users/${UID}`, update(USER, profile({ displayName: 'Luna' })), profile()),
  fsCase('self sets an own uploaded photo', 'ALLOW', `users/${UID}`, update(USER, profile({ photoURL: avatarUrl(UID) })), profile()),
  fsCase('self removes the photo', 'ALLOW', `users/${UID}`, update(USER, profile({ photoURL: null })), profile({ photoURL: GOOGLE_PHOTO })),
  fsCase("self sets ANOTHER user's uploaded photo", 'DENY', `users/${UID}`, update(USER, profile({ photoURL: avatarUrl(OTHER) })), profile()),
  fsCase('self sets a photo over plain http', 'DENY', `users/${UID}`, update(USER, profile({ photoURL: 'http://lh3.googleusercontent.com/a/x' })), profile()),
  fsCase('self heals email to the token address', 'ALLOW', `users/${UID}`, update(USER, profile({ email: EMAIL })), profile({ email: 'old@example.com' })),
  fsCase('self changes email to an address NOT in the token', 'DENY', `users/${UID}`, update(USER, profile({ email: 'else@example.com' })), profile()),
  fsCase('self rewrites createdAt', 'DENY', `users/${UID}`, update(USER, profile({ createdAt: '2020-01-01T00:00:00Z' })), profile()),
  fsCase('self adds role: admin', 'DENY', `users/${UID}`, update(USER, profile({ role: 'admin' })), profile()),
  fsCase("another user changes this user's name", 'DENY', `users/${UID}`, update(OTHER_USER, profile({ displayName: 'x' })), profile()),
  fsCase('a pre-2026-09-15 profile (empty email) can still change its name', 'ALLOW', `users/${UID}`, update(USER, profile({ email: '', displayName: 'Luna' })), profile({ email: '', displayName: null })),

  // read / delete
  fsCase('self reads', 'ALLOW', `users/${UID}`, { auth: USER, method: 'get' }, profile()),
  fsCase('admin reads', 'ALLOW', `users/${UID}`, { auth: ADMIN, method: 'get' }, profile()),
  fsCase('another user reads', 'DENY', `users/${UID}`, { auth: OTHER_USER, method: 'get' }, profile()),
  fsCase('self deletes (the Admin SDK route does that)', 'DENY', `users/${UID}`, { auth: USER, method: 'delete' }, profile()),

  // controls
  fsCase('CONTROL: signed out reads a public pet', 'ALLOW', 'pets/probe-pet', { method: 'get' }, { name: 'x' }),
  fsCase('CONTROL: signed out reads a profile', 'DENY', `users/${UID}`, { method: 'get' }, profile()),
];

// ── Storage ─────────────────────────────────────────────────────────────────
const object = (name) => `/b/${BUCKET}/o/${name}`;
const AVATAR = `users/${UID}/avatar/1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed.jpg`;
const file = (name, over = {}) => ({ name, bucket: BUCKET, size: 60_000, contentType: 'image/jpeg', ...over });

const storageCases = [
  ['self uploads a JPEG avatar', 'ALLOW', { auth: USER, method: 'create', path: object(AVATAR), resource: file(AVATAR) }],
  ["another user uploads into this user's folder", 'DENY', { auth: OTHER_USER, method: 'create', path: object(AVATAR), resource: file(AVATAR) }],
  ['signed out uploads an avatar', 'DENY', { method: 'create', path: object(AVATAR), resource: file(AVATAR) }],
  ['self uploads a PNG', 'DENY', { auth: USER, method: 'create', path: object(AVATAR), resource: file(AVATAR, { contentType: 'image/png' }) }],
  ['self uploads 3 MB', 'DENY', { auth: USER, method: 'create', path: object(AVATAR), resource: file(AVATAR, { size: 3_000_000 }) }],
  ['self uploads a name outside the pattern', 'DENY', { auth: USER, method: 'create', path: object(`users/${UID}/avatar/a b.jpg`), resource: file(`users/${UID}/avatar/a b.jpg`) }],
  ['self uploads into a nested folder (no rule matches)', 'DENY', { auth: USER, method: 'create', path: object(`users/${UID}/avatar/sub/a.jpg`), resource: file(`users/${UID}/avatar/sub/a.jpg`) }],
  ['self overwrites (no update rule)', 'DENY', { auth: USER, method: 'update', path: object(AVATAR), resource: file(AVATAR) }],
  ['self deletes', 'ALLOW', { auth: USER, method: 'delete', path: object(AVATAR) }],
  ['another user deletes', 'DENY', { auth: OTHER_USER, method: 'delete', path: object(AVATAR) }],
  ['self reads', 'ALLOW', { auth: USER, method: 'get', path: object(AVATAR) }],
  ['admin reads', 'ALLOW', { auth: ADMIN, method: 'get', path: object(AVATAR) }],
  ['another user reads', 'DENY', { auth: OTHER_USER, method: 'get', path: object(AVATAR) }],
  ['signed out reads', 'DENY', { method: 'get', path: object(AVATAR) }],
  ['CONTROL: signed out reads a public pet photo', 'ALLOW', { method: 'get', path: object('pets/probe-pet/cover.jpg') }],
  ['CONTROL: signed out reads a private intake photo', 'DENY', { method: 'get', path: object('pets/probe-pet/private/0123abcd.jpg') }],
].map(([name, expectation, request]) => ({ name, testCase: { expectation, request } }));

// ── run ─────────────────────────────────────────────────────────────────────
async function suite(label, files, cases) {
  const response = await fetch(`${API}/projects/${PROJECT}:test`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ source: { files }, testSuite: { testCases: cases.map((c) => c.testCase) } }),
  });
  const result = await response.json();

  console.log(`\n── ${label} ──`);
  if (!response.ok) {
    console.log(`  HTTP ${response.status}: ${JSON.stringify(result?.error ?? result).slice(0, 500)}`);
    return { failures: cases.length, total: cases.length };
  }
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

const firestoreFile = process.env.ACCOUNT_FIRESTORE_RULES ?? 'firestore.rules';
const storageFile = process.env.ACCOUNT_STORAGE_RULES ?? 'storage.rules';

const results = [
  await suite(
    `Firestore — LOCAL ${firestoreFile}`,
    [{ name: 'firestore.rules', content: readFileSync(firestoreFile, 'utf8') }],
    firestoreCases
  ),
  await suite(
    `Storage ${BUCKET} — LOCAL ${storageFile}`,
    [{ name: 'storage.rules', content: readFileSync(storageFile, 'utf8') }],
    storageCases
  ),
];

const failures = results.reduce((n, r) => n + r.failures, 0);
const total = results.reduce((n, r) => n + r.total, 0);
console.log(`\n${total - failures}/${total} as expected`);
process.exit(failures === 0 ? 0 : 1);
