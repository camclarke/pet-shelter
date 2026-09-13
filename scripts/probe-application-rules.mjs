/**
 * Exercise the adoption-application and ownership rules with the REAL client
 * SDK against LIVE Firestore — for use AFTER `firestore.rules` is deployed.
 *
 * `scripts/test-application-rules.mjs` proves the rules with the Rules test API
 * before anything is released. It cannot prove two things this can: that
 * Firestore evaluates an unconstrained LIST query as refused (the test API has
 * no query), and that `get()`/`getAfter()` really return what the mocks assume.
 *
 * ── Sections ──────────────────────────────────────────────────────────────
 *   ownership     `adoptions/{petId}` and `ownsPet()` — rules ALREADY DEPLOYED.
 *                 Safe to run today.
 *   applications  `adoptionApplications` — needs the new rules deployed. Before
 *                 that, every case here meets default-deny and the run fails.
 *
 * ── What it creates, and removes ──────────────────────────────────────────
 * Three auth accounts, a pet named "Nightprobe …" with status `shelter` (never
 * on the wall) and the documents under it, an `adoptions/{petId}` document and,
 * in the applications section, one application with its internal notes. Every
 * id and email carries `nightprobe-s14-<run>`. Everything is deleted at the end,
 * subcollections included (Firestore does not cascade), and READ BACK.
 *
 * `--with-available-pet` also runs the ALLOW branch of the create rule, which
 * requires a pet with status `available` — that is, a pet on the PUBLIC WALL.
 * It flips the probe pet to `available` for the one write and back, a few
 * seconds, but an ISR regeneration inside that window would publish it for up
 * to five minutes. Off by default; run it only when that is acceptable.
 *
 * Usage (from the repo root):
 *   node --import tsx --env-file-if-exists=.env.local scripts/probe-application-rules.mjs
 *        → dry run, prints the plan
 *   ... --run --sections ownership
 *   ... --run --sections ownership,applications [--with-available-pet]
 *
 * Needs GOOGLE_CLOUD_PROJECT, ADC for an account that can create users, and the
 * six NEXT_PUBLIC_FIREBASE_* values. Refuses if they name different projects.
 */

import { randomBytes } from 'node:crypto';

import { initializeApp as initAdmin, getApps as adminApps } from 'firebase-admin/app';
import { getAuth as adminAuthFor } from 'firebase-admin/auth';
import { FieldValue, getFirestore as adminDbFor } from 'firebase-admin/firestore';

import { initializeApp as initClient } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  serverTimestamp,
  setDoc,
  terminate,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';

import {
  adminStatusPatch,
  applicationIdFor,
  buildApplicationCreate,
  buildApprovalWrites,
  withdrawalPatch,
} from '../src/lib/applications.ts';
import { applyWriteOps, resolveServerTime } from '../src/lib/server-time.ts';

const args = process.argv.slice(2);
const RUN = args.includes('--run');
const WITH_AVAILABLE = args.includes('--with-available-pet');
const sectionsArg = args[args.indexOf('--sections') + 1];
const SECTIONS = new Set(
  args.includes('--sections') && sectionsArg ? sectionsArg.split(',') : ['ownership', 'applications'],
);

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
  console.error(`NEXT_PUBLIC_FIREBASE_PROJECT_ID (${config.projectId}) is not GOOGLE_CLOUD_PROJECT (${project}).`);
  process.exit(2);
}

const RUN_ID = `nightprobe-s14-${randomBytes(3).toString('hex')}`;
const PET_ID = `${RUN_ID}-pet`;
const PASSWORD = randomBytes(18).toString('base64url');
const PEOPLE = {
  ana: `${RUN_ID}-ana@example.com`,
  beto: `${RUN_ID}-beto@example.com`,
  admin: `${RUN_ID}-admin@example.com`,
};

console.log(`run: ${RUN_ID}  project: ${project}  sections: ${[...SECTIONS].join(', ')}`);
if (!RUN) {
  console.log('\nDRY RUN. Would create:');
  console.log(`  auth accounts   ${Object.values(PEOPLE).join(', ')}  (admin claim on the last)`);
  console.log(`  pets/${PET_ID}  status shelter, name "Nightprobe S14", + identity, custody`);
  console.log(`  adoptions/${PET_ID}`);
  if (SECTIONS.has('applications')) console.log(`  adoptionApplications/${PET_ID}__<ana uid> + internal/notes`);
  if (WITH_AVAILABLE) console.log('  ⚠️ and flip the pet to AVAILABLE for one write (public wall exposure)');
  console.log('\nAdd --run to execute. Everything is deleted and read back afterwards.');
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────

const adminApp = adminApps()[0] ?? initAdmin({ projectId: project });
const adminAuth = adminAuthFor(adminApp);
const adminDb = adminDbFor(adminApp);

const results = [];
function record(expect, name, outcome, detail = '') {
  const ok = expect === outcome;
  results.push({ ok, name });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  expect ${expect.padEnd(5)} got ${outcome.padEnd(5)}  ${name}${detail ? `  (${detail})` : ''}`);
}

/** Run a client operation and classify it as ALLOW or DENY. Anything else is a failure. */
async function expectOutcome(expect, name, operation) {
  try {
    await operation();
    record(expect, name, 'ALLOW');
  } catch (error) {
    const code = error?.code ?? '';
    if (code === 'permission-denied' || code === 'firestore/permission-denied') {
      record(expect, name, 'DENY');
    } else {
      record(expect, name, 'ERROR', code || String(error?.message ?? error));
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
    await user.getIdToken(true);
  }
  clients[who] = { app, db, user };
  return clients[who];
}

const uids = {};
let exitCode = 0;

try {
  // ── fixtures ─────────────────────────────────────────────────────────────
  for (const [who, email] of Object.entries(PEOPLE)) {
    const user = await adminAuth.createUser({ email, password: PASSWORD, emailVerified: true });
    uids[who] = user.uid;
  }
  await adminAuth.setCustomUserClaims(uids.admin, { admin: true });

  const petRef = adminDb.collection('pets').doc(PET_ID);
  await petRef.set({
    slug: RUN_ID,
    name: 'Nightprobe S14',
    status: 'shelter',
    species: 'dog',
    sex: 'female',
    size: 'medium',
    breed: 'mestiza',
    formerNames: [],
    hasMicrochip: false,
    coverPhoto: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await petRef.collection('identity').doc('microchip').set({ code: RUN_ID, standard: 'iso-fdx-b' });
  await petRef.collection('custody').doc('c-shelter').set({
    kind: 'shelter',
    holder: 'Nightprobe',
    holderUid: null,
    startedAt: FieldValue.serverTimestamp(),
    endedAt: null,
    note: null,
    recordedBy: 'nightprobe',
  });

  const ana = await clientFor('ana');
  const beto = await clientFor('beto');
  const anon = await clientFor('anon');
  const admin = await clientFor('admin');

  // ── ownership: rules deployed today ──────────────────────────────────────
  if (SECTIONS.has('ownership')) {
    console.log('\n── ownership (deployed rules) ──');
    const identity = (c) => getDoc(doc(c.db, 'pets', PET_ID, 'identity', 'microchip'));

    await expectOutcome('DENY', 'before adoption: applicant reads the microchip', () => identity(ana));

    await adminDb.collection('adoptions').doc(PET_ID).set({
      petId: PET_ID,
      ownerUid: uids.ana,
      adoptedAt: FieldValue.serverTimestamp(),
      approvedBy: 'nightprobe',
      applicationId: null,
    });

    await expectOutcome('ALLOW', 'owner reads the microchip', () => identity(ana));
    await expectOutcome('DENY', 'signed-in stranger reads the microchip', () => identity(beto));
    await expectOutcome('DENY', 'anonymous reads the microchip', () => identity(anon));
    await expectOutcome('ALLOW', 'owner reads own adoption', () => getDoc(doc(ana.db, 'adoptions', PET_ID)));
    await expectOutcome('DENY', 'stranger reads the adoption', () => getDoc(doc(beto.db, 'adoptions', PET_ID)));
    await expectOutcome('ALLOW', 'owner reads the custody chain', () =>
      getDoc(doc(ana.db, 'pets', PET_ID, 'custody', 'c-shelter')),
    );
    await expectOutcome('DENY', 'stranger reads the custody chain', () =>
      getDoc(doc(beto.db, 'pets', PET_ID, 'custody', 'c-shelter')),
    );
    await expectOutcome('DENY', 'stranger writes adoptions/{petId} naming THEMSELVES', () =>
      setDoc(doc(beto.db, 'adoptions', PET_ID), { petId: PET_ID, ownerUid: uids.beto }),
    );
    await expectOutcome('DENY', 'owner rewrites own adoption', () =>
      setDoc(doc(ana.db, 'adoptions', PET_ID), { petId: PET_ID, ownerUid: uids.ana }),
    );

    await adminDb.collection('adoptions').doc(PET_ID).delete();
    await expectOutcome('DENY', 'after the adoption is removed: former owner reads the microchip', () =>
      identity(ana),
    );
  }

  // ── applications: needs the new rules deployed ───────────────────────────
  if (SECTIONS.has('applications')) {
    console.log('\n── applications (needs the new rules deployed) ──');
    const appId = applicationIdFor(PET_ID, uids.ana);
    const appRef = (c) => doc(c.db, 'adoptionApplications', appId);
    const create = (c, uid, email) =>
      setDoc(
        doc(c.db, 'adoptionApplications', applicationIdFor(PET_ID, uid)),
        resolveServerTime(
          buildApplicationCreate({
            petId: PET_ID,
            applicantUid: uid,
            applicantEmail: email,
            applicantEmailVerified: true,
            answers: { fullName: 'Nightprobe', whatsapp: '70000000', adults: 1, everyoneAgrees: true },
          }),
        ),
      );

    await expectOutcome('DENY', 'create while the pet is NOT available', () => create(beto, uids.beto, PEOPLE.beto));

    if (WITH_AVAILABLE) {
      await petRef.update({ status: 'available' });
      try {
        await expectOutcome('ALLOW', 'create for an available pet', () => create(ana, uids.ana, PEOPLE.ana));
      } finally {
        await petRef.update({ status: 'shelter' });
      }
    } else {
      // The allow branch is covered by the Rules test API; seed the document
      // through the Admin SDK so every later case has something to act on.
      await adminDb.collection('adoptionApplications').doc(appId).set({
        petId: PET_ID,
        applicantUid: uids.ana,
        applicantEmail: PEOPLE.ana,
        applicantEmailVerified: true,
        answers: { fullName: 'Nightprobe' },
        status: 'submitted',
        submittedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        withdrawnAt: null,
        decidedAt: null,
        decidedBy: null,
      });
      console.log('      (create ALLOW skipped — seeded by Admin SDK; see --with-available-pet)');
    }
    await adminDb.collection('adoptionApplications').doc(appId).collection('internal').doc('notes')
      .set({ text: 'nightprobe', updatedAt: FieldValue.serverTimestamp(), updatedBy: uids.admin });

    await expectOutcome('DENY', 'duplicate: a second submission over the first', () => create(ana, uids.ana, PEOPLE.ana));
    await expectOutcome('ALLOW', 'applicant reads own application', () => getDoc(appRef(ana)));
    await expectOutcome('ALLOW', 'applicant checks an own id that does not exist', () =>
      getDoc(doc(ana.db, 'adoptionApplications', applicationIdFor(`${PET_ID}x`, uids.ana))),
    );
    await expectOutcome('DENY', 'stranger reads the application', () => getDoc(appRef(beto)));
    await expectOutcome('DENY', 'anonymous reads the application', () => getDoc(appRef(anon)));
    await expectOutcome('ALLOW', 'applicant lists own, constrained by uid', () =>
      getDocs(query(collection(ana.db, 'adoptionApplications'), where('applicantUid', '==', uids.ana))),
    );
    await expectOutcome('DENY', 'applicant lists WITHOUT the uid constraint', () =>
      getDocs(collection(ana.db, 'adoptionApplications')),
    );
    await expectOutcome('DENY', "stranger lists the applicant's applications", () =>
      getDocs(query(collection(beto.db, 'adoptionApplications'), where('applicantUid', '==', uids.ana))),
    );
    await expectOutcome('DENY', 'applicant reads the internal notes', () =>
      getDoc(doc(ana.db, 'adoptionApplications', appId, 'internal', 'notes')),
    );
    await expectOutcome('ALLOW', 'admin reads the internal notes', () =>
      getDoc(doc(admin.db, 'adoptionApplications', appId, 'internal', 'notes')),
    );
    await expectOutcome('DENY', 'applicant self-escalates to approved', () =>
      updateDoc(appRef(ana), { status: 'approved', updatedAt: serverTimestamp() }),
    );
    await expectOutcome('DENY', 'applicant writes decidedBy', () =>
      updateDoc(appRef(ana), { status: 'withdrawn', withdrawnAt: serverTimestamp(), updatedAt: serverTimestamp(), decidedBy: uids.ana }),
    );
    await expectOutcome('ALLOW', 'admin moves submitted → reviewing', () =>
      updateDoc(appRef(admin), resolveServerTime({ ...adminStatusPatch('submitted', 'reviewing', uids.admin) })),
    );
    await expectOutcome('DENY', 'admin approves WITHOUT the adoption in the batch', () =>
      updateDoc(appRef(admin), resolveServerTime({ ...adminStatusPatch('reviewing', 'approved', uids.admin) })),
    );

    await expectOutcome('ALLOW', 'admin approves: the full batch from buildApprovalWrites', async () => {
      const batch = writeBatch(admin.db);
      applyWriteOps(
        admin.db,
        batch,
        buildApprovalWrites({
          application: {
            id: appId,
            petId: PET_ID,
            applicantUid: uids.ana,
            applicantEmail: PEOPLE.ana,
            applicantEmailVerified: true,
            status: 'reviewing',
          },
          pet: { id: PET_ID, status: 'shelter' },
          otherApplications: [],
          adminUid: uids.admin,
          holder: 'Nightprobe',
          newCustodyId: 'c-adopter',
          openCustodyIds: ['c-shelter'],
          openPlacementIds: [],
        }),
      );
      await batch.commit();
    });
    await expectOutcome('ALLOW', 'THE APPROVED APPLICANT now reads the microchip', () =>
      getDoc(doc(ana.db, 'pets', PET_ID, 'identity', 'microchip')),
    );
    await expectOutcome('DENY', 'applicant withdraws an approved application', () =>
      updateDoc(appRef(ana), resolveServerTime({ ...withdrawalPatch('reviewing') })),
    );
    await expectOutcome('DENY', 'admin deletes the application', async () => {
      const { deleteDoc } = await import('firebase/firestore');
      await deleteDoc(appRef(admin));
    });
  }
} catch (error) {
  console.error('\nPROBE ABORTED:', error?.code ?? error?.message ?? error);
  exitCode = 2;
} finally {
  // ── cleanup, then read it back ─────────────────────────────────────────────
  console.log('\n── cleanup ──');
  for (const c of Object.values(clients)) {
    try {
      if (c.user) await signOut(getAuth(c.app));
      await terminate(c.db);
    } catch {
      /* closing a client is best-effort */
    }
  }

  const appIds = Object.values(uids).map((uid) => `${PET_ID}__${uid}`);
  await adminDb.recursiveDelete(adminDb.collection('pets').doc(PET_ID));
  await adminDb.collection('adoptions').doc(PET_ID).delete();
  for (const id of appIds) await adminDb.recursiveDelete(adminDb.collection('adoptionApplications').doc(id));
  for (const uid of Object.values(uids)) {
    await adminDb.collection('users').doc(uid).delete();
    await adminAuth.deleteUser(uid).catch(() => {});
  }

  const leftovers = [];
  if ((await adminDb.collection('pets').doc(PET_ID).get()).exists) leftovers.push(`pets/${PET_ID}`);
  for (const sub of ['identity', 'custody', 'placements', 'scans']) {
    const snap = await adminDb.collection('pets').doc(PET_ID).collection(sub).get();
    if (!snap.empty) leftovers.push(`pets/${PET_ID}/${sub} (${snap.size})`);
  }
  if ((await adminDb.collection('adoptions').doc(PET_ID).get()).exists) leftovers.push(`adoptions/${PET_ID}`);
  for (const id of appIds) {
    if ((await adminDb.collection('adoptionApplications').doc(id).get()).exists) leftovers.push(`adoptionApplications/${id}`);
    const notes = await adminDb.collection('adoptionApplications').doc(id).collection('internal').get();
    if (!notes.empty) leftovers.push(`adoptionApplications/${id}/internal (${notes.size})`);
  }
  for (const [who, uid] of Object.entries(uids)) {
    if ((await adminDb.collection('users').doc(uid).get()).exists) leftovers.push(`users/${uid}`);
    const stillThere = await adminAuth.getUser(uid).then(() => true, () => false);
    if (stillThere) leftovers.push(`auth ${who}`);
  }
  console.log(leftovers.length === 0 ? 'readback: nothing left behind' : `READBACK FOUND LEFTOVERS: ${leftovers.join(', ')}`);
  if (leftovers.length > 0) exitCode = 3;

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  if (failed > 0 && exitCode === 0) exitCode = 1;
  process.exit(exitCode);
}
