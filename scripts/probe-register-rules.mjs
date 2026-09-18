/**
 * Prove that the deployed `registerEntries` rules enforce, with the REAL client
 * SDK against LIVE Firestore.
 *
 *   node --import tsx --env-file-if-exists=.env.local scripts/probe-register-rules.mjs
 *   ... --run
 *
 * ── Why the client SDK, and not the Rules test API ──────────────────────────
 * `scripts/probe-card-rules.mjs` evaluates cases through `projects.test`, which
 * is the right instrument BEFORE a release: it answers what a ruleset would do
 * without deploying it. This answers a different question — what the ruleset
 * Firestore is actually serving does, to a real signed-in browser — and it is
 * the only instrument that can. Two things the test API cannot reach:
 *
 *   • **`list` is a query, and the test API has no queries.** `allow read`
 *     covers `get` AND `list`, so a rule that looks admin-only per document can
 *     still be the difference between "an adopter cannot open row 47" and "an
 *     adopter can enumerate every animal this shelter has ever held". Only a
 *     real `getDocs` exercises it.
 *   • **A custom claim has to survive a token.** `isAdmin()` reads
 *     `request.auth.token.admin`, and the test API is handed that token as a
 *     literal. Here the claim is set with the Admin SDK, minted into an ID
 *     token by Identity Platform, and sent by the SDK — which is the path that
 *     actually runs, and the one with the hour-long staleness this project has
 *     measured before. `getIdToken(true)` forces the refresh.
 *
 * ── The read technique: no fixtures, and none needed ────────────────────────
 * Firestore evaluates rules BEFORE it looks for the document. So an allowed
 * read of a document that does not exist returns an empty snapshot, while a
 * denied read of the same absent path throws `permission-denied` — and that
 * difference is the entire signal. This is how `firestore.rules` was first
 * proven on 2026-08-23 with `pets` holding zero documents, and it is why this
 * probe needs no register row, no pet and no seeded data.
 *
 * The same trick reaches the WRITE rules, from the 2026-09-12 measurement pass:
 * for a caller the rules ALLOW, `updateDoc` on an absent document fails
 * `not-found` rather than `permission-denied`. `not-found` therefore means the
 * rule said yes and the document simply was not there — an allow branch proven
 * without writing anything at all.
 *
 * ── What it creates ─────────────────────────────────────────────────────────
 * Two throwaway auth accounts, and ONE `registerEntries` document — see
 * `probeCreate` for why that one is worth its cleanup. Both accounts and the
 * document are deleted at the end, in a `finally`, and READ BACK at zero. Ids
 * carry `regprobe-<run>` so anything ever left behind is obviously this.
 *
 * ⚠️ The document id is `regprobe-…`, deliberately NOT a number. Every real row
 * is `registerEntries/{no}` with `no` an integer, so a probe document cannot be
 * mistaken for register row 226 by a person, by the roster, or by a `--delete`.
 *
 * ── Controls, because a broken probe denies everything ──────────────────────
 * A suite of nothing but DENY expectations passes just as well when the client
 * cannot reach Firestore, when the member account never signed in, and when the
 * rules deny the whole database. Three controls rule those out — an anonymous
 * ALLOW, a signed-in ALLOW, and an admin DENY — and every one of them is a case
 * that fails if the thing it controls for is broken. See `CONTROL` below.
 *
 * Needs GOOGLE_CLOUD_PROJECT, ADC for an account that can create users, and the
 * six NEXT_PUBLIC_FIREBASE_* values. Refuses if they name different projects.
 * No gcloud or Firebase CLI, and it releases nothing.
 */

import { randomBytes } from 'node:crypto';

import { initializeApp as initAdmin, getApps as adminApps } from 'firebase-admin/app';
import { getAuth as adminAuthFor } from 'firebase-admin/auth';
import { getFirestore as adminDbFor } from 'firebase-admin/firestore';

import { initializeApp as initClient } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  query,
  setDoc,
  terminate,
  updateDoc,
} from 'firebase/firestore';

// ⚠️ NOTHING is imported from `src/lib` on purpose, and that is worth a line.
// On 2026-09-13 a probe run under `node --import tsx` ended up holding TWO
// instances of a `src/lib` module and of `firebase/firestore`, reached through
// an extensionless import inside another module — and the deployed rules then
// correctly refused writes that the app itself would have made correctly. Three
// real-looking rule failures, all of them the harness. This probe writes its
// own literal document instead, so there is no second module graph to diverge.

const args = process.argv.slice(2);
const RUN = args.includes('--run');

const project = process.env.GOOGLE_CLOUD_PROJECT;
const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

if (!project) {
  console.error('GOOGLE_CLOUD_PROJECT is not set. Refusing to guess.');
  process.exit(2);
}
if (config.projectId !== project) {
  console.error(
    `NEXT_PUBLIC_FIREBASE_PROJECT_ID (${config.projectId ?? 'unset'}) is not ` +
      `GOOGLE_CLOUD_PROJECT (${project}). The Admin SDK would create the accounts in one ` +
      'project and the client would sign in to the other, so every case would fail for a ' +
      'reason that has nothing to do with the rules.',
  );
  process.exit(2);
}

const RUN_ID = `regprobe-${randomBytes(3).toString('hex')}`;
const PASSWORD = randomBytes(18).toString('base64url');
const PEOPLE = {
  member: `${RUN_ID}-member@example.com`,
  admin: `${RUN_ID}-admin@example.com`,
};

/** Absent throughout: the target for every read and for the `not-found` technique. */
const ABSENT = `${RUN_ID}-absent`;
/** The one document that is genuinely created, by the admin, and then removed. */
const CREATED = `${RUN_ID}-created`;

console.log(`run: ${RUN_ID}  project: ${project}`);

if (!RUN) {
  console.log('\nDRY RUN. Would create:');
  console.log(`  auth accounts          ${Object.values(PEOPLE).join(', ')}  (admin claim on the last)`);
  console.log(`  registerEntries/${CREATED}   one document, deleted and read back at zero`);
  console.log('\nReads and the write-allow technique need NO documents: Firestore evaluates');
  console.log('rules before existence, so an allowed read of an absent path returns an empty');
  console.log(`snapshot and a denied one throws. registerEntries/${ABSENT} is never created.`);
  console.log('\nAdd --run to execute.');
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────

const adminApp = adminApps()[0] ?? initAdmin({ projectId: project });
const adminAuth = adminAuthFor(adminApp);
const adminDb = adminDbFor(adminApp);

const results = [];
function record(expect, name, outcome, detail = '') {
  const ok = expect === outcome;
  results.push({ ok, name, expect, outcome });
  console.log(
    `${ok ? 'ok  ' : 'FAIL'}  expect ${expect.padEnd(5)} got ${outcome.padEnd(5)}  ${name}` +
      (detail ? `  (${detail})` : ''),
  );
}

/**
 * Run one client operation and classify it.
 *
 * `not-found` counts as ALLOW and that is the load-bearing line: it is what the
 * rules returning YES looks like when the document is absent. Anything that is
 * neither `permission-denied` nor a clean resolve nor `not-found` is reported as
 * ERROR rather than folded into either column — an `unavailable` scored as DENY
 * is a network problem reported as a security property.
 */
async function expect(expected, name, operation) {
  try {
    await operation();
    record(expected, name, 'ALLOW');
  } catch (error) {
    const code = error?.code ?? '';
    if (code === 'permission-denied' || code === 'firestore/permission-denied') {
      record(expected, name, 'DENY');
    } else if (code === 'not-found' || code === 'firestore/not-found') {
      record(expected, name, 'ALLOW', 'not-found: the rule allowed it, the document is absent');
    } else {
      record(expected, name, 'ERROR', code || String(error?.message ?? error));
    }
  }
}

const clients = {};
async function clientFor(who) {
  if (clients[who]) return clients[who];
  const app = initClient(config, `${RUN_ID}-${who}`);
  const db = getFirestore(app);
  let user = null;
  if (who !== 'anon') {
    const auth = getAuth(app);
    user = (await signInWithEmailAndPassword(auth, PEOPLE[who], PASSWORD)).user;
    // ⚠️ Forced, not incidental. A custom claim is baked into the ID token when
    // it is issued, and the token minted at sign-in can predate the claim this
    // script set seconds earlier — the hour-long staleness recorded on
    // 2026-08-23. Without this refresh the admin cases fail as DENY and the
    // rules look broken.
    await user.getIdToken(true);
  }
  clients[who] = { app, db, user };
  return clients[who];
}

const uids = {};
let exitCode = 0;

try {
  for (const [who, email] of Object.entries(PEOPLE)) {
    const user = await adminAuth.createUser({ email, password: PASSWORD, emailVerified: true });
    uids[who] = user.uid;
  }
  await adminAuth.setCustomUserClaims(uids.admin, { admin: true });

  const anon = await clientFor('anon');
  const member = await clientFor('member');
  const admin = await clientFor('admin');

  const entryRef = (c, id) => doc(c.db, 'registerEntries', id);
  const entryList = (c) => query(collection(c.db, 'registerEntries'), limit(1));

  // ── controls, first, so a broken probe is caught before it "proves" anything ─
  console.log('\n── controls ──');

  // If this fails, the anonymous client cannot reach Firestore at all, and every
  // signed-out DENY below is a connection error wearing a security result.
  await expect('ALLOW', 'CONTROL signed out reads a public pet document', () =>
    getDoc(doc(anon.db, 'pets', `${RUN_ID}-nonexistent`)),
  );

  // If this fails, the member never actually signed in, and every member DENY
  // below is really an anonymous DENY — the whole non-admin half proves nothing.
  await expect('ALLOW', 'CONTROL a signed-in NON-admin reads the medical tier', () =>
    getDoc(doc(member.db, 'pets', `${RUN_ID}-nonexistent`, 'medical', 'none')),
  );

  // If this fails, the admin is allowed everywhere and the admin ALLOWs below
  // say nothing about the registerEntries rule in particular.
  await expect('DENY', 'CONTROL an admin reads an undeclared collection', () =>
    getDoc(doc(admin.db, `${RUN_ID}-undeclared`, 'none')),
  );

  // ── signed out ────────────────────────────────────────────────────────────
  console.log('\n── signed out ──');
  await expect('DENY', 'signed out reads a register entry', () => getDoc(entryRef(anon, ABSENT)));
  await expect('DENY', 'signed out LISTS registerEntries', () => getDocs(entryList(anon)));
  await expect('DENY', 'signed out writes a register entry', () =>
    updateDoc(entryRef(anon, ABSENT), { name: 'probe' }),
  );
  await expect('DENY', 'signed out creates a register entry', () =>
    setDoc(entryRef(anon, ABSENT), { no: 226, name: 'probe' }),
  );
  await expect('DENY', 'signed out deletes a register entry', () => deleteDoc(entryRef(anon, ABSENT)));

  // ── signed in, no admin claim ─────────────────────────────────────────────
  //
  // The section that matters most. `registerEntries` is admin-only for READ as
  // well as write — stricter than `medical`, which any signed-in account can
  // read — because these rows are internal operating history: who rescued an
  // animal, and what happened to the twenty that died. An adopter with an
  // account must not be able to open one, and must not be able to enumerate
  // them either, which is what the LIST case is for.
  console.log('\n── signed in, WITHOUT the admin claim ──');
  await expect('DENY', 'a signed-in NON-admin reads a register entry', () => getDoc(entryRef(member, ABSENT)));
  await expect('DENY', 'a signed-in NON-admin LISTS registerEntries', () => getDocs(entryList(member)));
  await expect('DENY', 'a signed-in NON-admin writes a register entry', () =>
    updateDoc(entryRef(member, ABSENT), { name: 'probe' }),
  );
  await expect('DENY', 'a signed-in NON-admin creates a register entry', () =>
    setDoc(entryRef(member, ABSENT), { no: 226, name: 'probe' }),
  );
  await expect('DENY', 'a signed-in NON-admin deletes a register entry', () =>
    deleteDoc(entryRef(member, ABSENT)),
  );

  // ── signed in, with the admin claim ───────────────────────────────────────
  console.log('\n── signed in, WITH the admin claim ──');
  await expect('ALLOW', 'an admin reads a register entry', () => getDoc(entryRef(admin, ABSENT)));
  await expect('ALLOW', 'an admin LISTS registerEntries', () => getDocs(entryList(admin)));
  await expect('ALLOW', 'an admin writes a register entry (absent → not-found)', () =>
    updateDoc(entryRef(admin, ABSENT), { name: 'probe' }),
  );

  // ── the one real write ────────────────────────────────────────────────────
  //
  // `not-found` above already proves the rule said yes, so why create anything?
  // Because `create` is the verb the import actually uses — `import-register.mjs`
  // writes every document with `.create()` and never `.set()` — and a rule that
  // permitted `update` while refusing `create` would pass every case above and
  // fail the real import on its first row. One document, by the admin only,
  // deleted immediately and read back at zero.
  //
  // The shape is a literal rather than a real `RegisterEntry`, because the rule
  // carries no field whitelist: `allow read, write: if isAdmin()` decides on the
  // caller alone, so a faithful 30-field document would test nothing extra and
  // would be one more thing that could drift.
  console.log('\n── one real create, by the admin ──');
  await expect('ALLOW', 'an admin CREATES a register entry', () =>
    setDoc(entryRef(admin, CREATED), { no: null, probe: RUN_ID, note: 'rules probe, deleted immediately' }),
  );
  await expect('ALLOW', 'an admin reads back the entry it created', () => getDoc(entryRef(admin, CREATED)));
  await expect('DENY', 'a signed-in NON-admin reads the entry that now EXISTS', () =>
    getDoc(entryRef(member, CREATED)),
  );
  await expect('ALLOW', 'an admin DELETES the entry it created', () => deleteDoc(entryRef(admin, CREATED)));
} catch (error) {
  console.error('\nPROBE ABORTED:', error?.code ?? error?.message ?? error);
  exitCode = 2;
} finally {
  console.log('\n── cleanup ──');

  for (const c of Object.values(clients)) {
    try {
      if (c.user) await signOut(getAuth(c.app));
      await terminate(c.db);
    } catch {
      /* closing a client is best-effort and must never mask a result */
    }
  }

  // Deleted with the Admin SDK rather than through a client, so cleanup cannot
  // fail for the very reason the probe is investigating.
  await adminDb.collection('registerEntries').doc(CREATED).delete().catch(() => {});
  await adminDb.collection('registerEntries').doc(ABSENT).delete().catch(() => {});
  for (const uid of Object.values(uids)) {
    // Deleting an auth account does NOT cascade to users/{uid}; the app creates
    // that document on sign-in, and two orphans from an earlier probe survived a
    // cleanup this project recorded as "verified at zero".
    await adminDb.collection('users').doc(uid).delete().catch(() => {});
    await adminAuth.deleteUser(uid).catch(() => {});
  }

  const leftovers = [];
  for (const id of [CREATED, ABSENT]) {
    if ((await adminDb.collection('registerEntries').doc(id).get()).exists) {
      leftovers.push(`registerEntries/${id}`);
    }
  }
  for (const [who, uid] of Object.entries(uids)) {
    if ((await adminDb.collection('users').doc(uid).get()).exists) leftovers.push(`users/${uid}`);
    const stillThere = await adminAuth.getUser(uid).then(() => true, () => false);
    if (stillThere) leftovers.push(`auth ${who}`);
  }
  console.log(
    leftovers.length === 0
      ? 'readback: nothing left behind'
      : `READBACK FOUND LEFTOVERS: ${leftovers.join(', ')}`,
  );
  if (leftovers.length > 0) exitCode = 3;

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} as expected`);

  // ── the diagnosis, so a wall of FAILs is not read as a broken rule ─────────
  //
  // Until `firestore.rules` is deployed, `registerEntries` meets the closing
  // default-deny and EVERY admin case comes back DENY while every other case
  // passes. That is a deploy that is still owed, not a rule that is wrong, and
  // the two look identical in a list of results.
  const adminDenied = failed.filter((r) => r.expect === 'ALLOW' && r.outcome === 'DENY');
  if (adminDenied.length > 0 && adminDenied.length === failed.length) {
    console.log(
      '\nEvery failure is an ALLOW that came back DENY, and nothing else failed.\n' +
        'That is what an undeployed ruleset looks like: registerEntries falls through to the\n' +
        "closing `match /{document=**} { allow read, write: if false; }`. Deploy firestore.rules\n" +
        '(`firebase deploy --only firestore:rules`) and run this again.',
    );
  }

  if (failed.length > 0 && exitCode === 0) exitCode = 1;
  process.exit(exitCode);
}
