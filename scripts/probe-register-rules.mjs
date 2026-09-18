/**
 * Prove that the deployed `registerEntries` rules enforce, against LIVE
 * Firestore, with a real signed-in identity.
 *
 *   node --env-file-if-exists=.env.local scripts/probe-register-rules.mjs
 *
 * ── Why REST and not the client SDK ─────────────────────────────────────────
 * This probe was written against `firebase/auth` first, and it cannot work
 * that way any more: reCAPTCHA Enterprise was turned on for this project on
 * 2026-09-15, so the JS SDK answers `signInWithPassword` by starting a
 * reCAPTCHA flow and throws `RecaptchaVerifier is only supported in browser`
 * under Node. MEASURED 2026-09-18, and it applies to every client-SDK probe in
 * this repo, not only this one.
 *
 * REST is the same enforcement path: Identity Platform mints the same ID
 * token, and Firestore's REST API evaluates the same security rules as the
 * SDK. What is lost is the SDK's own query builder, and nothing that matters
 * here — `GET /documents/registerEntries` IS a list, so the `list` half of
 * `allow read` is still exercised, which the Rules test API cannot do at all.
 *
 * ── The read technique: no fixtures, and none needed ────────────────────────
 * Firestore evaluates rules BEFORE it looks for the document. On an ABSENT
 * path a permitted read returns 404 NOT_FOUND while a refused one returns 403
 * PERMISSION_DENIED, and that difference is the entire signal. This is how
 * `firestore.rules` was first proven on 2026-08-23 with `pets` holding zero
 * documents.
 *
 * ── Controls, because a probe of nothing but denials proves nothing ─────────
 * A suite that only expects 403 passes just as well when the network is down,
 * when the token is junk, or when the rules deny the entire database. Three
 * controls rule those out — an anonymous ALLOW, a member ALLOW and an admin
 * DENY — and each one fails if the thing it controls for is broken.
 *
 * ── What it creates ─────────────────────────────────────────────────────────
 * Two throwaway accounts and ONE document, all deleted in a `finally` and read
 * back at zero. The document id is `regprobe-<run>`, deliberately NOT a
 * number: every real row is `registerEntries/{no}` with an integer id, so a
 * probe document can never be mistaken for register row 226 by a person, by
 * the roster, or by `import-register.mjs --delete`.
 *
 * Needs GOOGLE_CLOUD_PROJECT=wawitas, ADC for an account that may create
 * users, and NEXT_PUBLIC_FIREBASE_API_KEY. Releases nothing, deploys nothing.
 */

import { randomBytes } from 'node:crypto';

import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT;
const KEY = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;

if (PROJECT !== 'wawitas') {
  console.error('GOOGLE_CLOUD_PROJECT must be `wawitas`. Refusing to guess.');
  process.exit(2);
}
if (!KEY) {
  console.error('NEXT_PUBLIC_FIREBASE_API_KEY is not set — it is what signs a probe account in.');
  process.exit(2);
}

const RUN = randomBytes(3).toString('hex');
const DOC = `regprobe-${RUN}`;
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

if (!getApps().length) initializeApp({ projectId: PROJECT });
const adminAuth = getAuth();
const adminDb = getFirestore();

async function signIn(email, password) {
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const body = await r.json();
  if (!r.ok) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(body)}`);
  return body.idToken;
}

/** Status code only: what the rules decided is all this probe reads. */
async function status(path, token, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { ...init, headers });
  return r.status;
}

const ALLOWED_ABSENT = [404]; // the rule said yes; the document is not there
const DENIED = [403];
const OK = [200];

const results = [];
function check(name, actual, expected, meaning) {
  const ok = expected.includes(actual);
  results.push({ ok, name, actual, expected });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} → ${actual}  (${meaning})`);
}

let member = null;
let admin = null;

try {
  console.log(`run: ${RUN}  project: ${PROJECT}\n`);

  const password = `${randomBytes(12).toString('hex')}Aa1!`;
  member = await adminAuth.createUser({ email: `regprobe-m-${RUN}@example.com`, password });
  admin = await adminAuth.createUser({ email: `regprobe-a-${RUN}@example.com`, password });
  await adminAuth.setCustomUserClaims(admin.uid, { admin: true });

  const memberToken = await signIn(`regprobe-m-${RUN}@example.com`, password);
  const adminToken = await signIn(`regprobe-a-${RUN}@example.com`, password);

  // ── controls ──────────────────────────────────────────────────────────────
  check(
    'CONTROL anonymous may read a public pet',
    await status('/pets/no-such-pet-probe', null),
    ALLOWED_ABSENT,
    'the endpoint and the network work at all',
  );
  check(
    'CONTROL a signed-in member may read the medical tier',
    await status('/pets/no-such-pet-probe/medical/x', memberToken),
    ALLOWED_ABSENT,
    'the member token is real and carries a signed-in identity',
  );
  check(
    'CONTROL even an admin is refused an undeclared collection',
    await status('/noSuchCollection/x', adminToken),
    DENIED,
    'default-deny still applies, so a 404 elsewhere means a rule said yes',
  );

  // ── the rules under test ──────────────────────────────────────────────────
  check('anonymous read of a register row', await status(`/registerEntries/${DOC}`, null), DENIED,
    'the register is not public');
  check('anonymous list of the register', await status('/registerEntries?pageSize=1', null), DENIED,
    'nobody may enumerate the animals this shelter has held');
  check('member read of a register row', await status(`/registerEntries/${DOC}`, memberToken), DENIED,
    'an adopter account may not open a row');
  check('member list of the register', await status('/registerEntries?pageSize=1', memberToken), DENIED,
    'an adopter account may not enumerate 225 animals, the dead among them');
  check(
    'member write to a register row',
    await status(`/registerEntries/${DOC}?updateMask.fieldPaths=petId`, memberToken, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { petId: { stringValue: 'nope' } } }),
    }),
    DENIED,
    'an adopter may not link a row to an animal',
  );

  check('admin read of an absent row', await status(`/registerEntries/${DOC}`, adminToken),
    ALLOWED_ABSENT, 'the rule allows; the document simply is not there');
  check('admin list of the register', await status('/registerEntries?pageSize=1', adminToken),
    OK, 'the roster can load');

  // One real write, because "may an admin link a row" is the rule the roster
  // depends on, and an absent-document read cannot prove an allow on create.
  check(
    'admin create of a register row',
    await status(`/registerEntries?documentId=${DOC}`, adminToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { no: { integerValue: '9999' } } }),
    }),
    OK,
    'the importer and the roster can write',
  );
  check(
    'admin delete of that row',
    await status(`/registerEntries/${DOC}`, adminToken, { method: 'DELETE' }),
    OK,
    'and can clean up after itself',
  );
} finally {
  console.log('\n── cleanup ──');
  for (const user of [member, admin]) {
    if (user) await adminAuth.deleteUser(user.uid).catch(() => {});
  }
  await adminDb.doc(`registerEntries/${DOC}`).delete().catch(() => {});

  const probeDoc = await adminDb.doc(`registerEntries/${DOC}`).get();
  const accounts = await adminAuth.listUsers(1000);
  const strays = accounts.users.filter((u) => (u.email ?? '').includes('regprobe-'));
  console.log(`probe document left behind: ${probeDoc.exists ? 'YES' : 'no'}`);
  console.log(`probe accounts left behind: ${strays.length}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} as expected`);
for (const f of failed) console.log(`  FAILED: ${f.name} → ${f.actual}, expected ${f.expected}`);
process.exit(failed.length === 0 ? 0 : 1);
