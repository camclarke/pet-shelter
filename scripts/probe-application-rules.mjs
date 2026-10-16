/**
 * Exercise the adoption-application and ownership rules against LIVE Firestore,
 * with real signed-in identities, through the REST API — for use AFTER
 * `firestore.rules` is deployed.
 *
 * `scripts/test-application-rules.mjs` proves the rules with the Rules test API
 * before anything is released. It cannot prove what this can: that Firestore
 * evaluates an unconstrained LIST as refused (the test API has no query), and
 * that `get()` / `existsAfter()` / `getAfter()` really return what its mocks
 * assume — the approval batch, run for real.
 *
 * ── Why REST and not the client SDK ────────────────────────────────────────
 * The first version of this probe used `firebase/auth` and `firebase/firestore`.
 * Since reCAPTCHA Enterprise was enabled on 2026-09-15, the JS SDK answers
 * `signInWithPassword` under Node by starting a reCAPTCHA flow and throwing
 * "RecaptchaVerifier is only supported in browser" — MEASURED 2026-09-18 on the
 * other client-SDK probes, and INFERRED to apply here, since this one signed
 * in the same way. REST is the same enforcement path: Identity Platform mints
 * the same ID token, and Firestore's REST API evaluates the same rules. It is
 * the pattern of `scripts/probe-register-rules.mjs`. (It also removes the
 * two-module-instances trap the SDK version had to work around.)
 *
 * ⚠️ If reCAPTCHA is ever moved to ENFORCE, REST sign-in may need a token too.
 *
 * ── What the deployed rules let it show, and what they do not ──────────────
 * While `applicationsEnabled()` is false and `acceptedContracts()` is empty —
 * both true until portion 4f — EVERY applicant create is refused. So this probe
 * shows only DENY on create: it cannot tell "refused because the switch is
 * off" from "refused because the batch is wrong". The create ALLOW branch, the
 * contract check and the batch pairing of `private/home` are proven by the
 * Rules test API until the switch-on release. Everything after the create —
 * reads, lists, the home document, withdrawal, admin moves, the ID marker and
 * the approval batch — runs for real here, on documents the Admin SDK seeds.
 *
 * It never flips a pet to `available`: the probe pet stays `shelter` and never
 * reaches the public wall.
 *
 * ── Sections ──────────────────────────────────────────────────────────────
 *   ownership     `adoptions/{petId}` and `ownsPet()`
 *   applications  `adoptionApplications`, `internal/notes`, `private/home`
 *
 * ── What it creates, and removes ──────────────────────────────────────────
 * Three auth accounts (ana, beto, admin — the admin claim on the last), a pet
 * "Appprobe 4a" with status `shelter` and its identity and custody, an
 * `adoptions/{petId}`, and two applications (ana's and beto's), each with its
 * `private/home` and ana's with `internal/notes`. Every id and email carries
 * `appprobe-4a-<run>`. Nothing is written to Storage. Everything is deleted in a
 * `finally`, subcollections included (Firestore does not cascade), and READ
 * BACK to zero.
 *
 * Usage (from the repo root):
 *   node --import tsx --env-file-if-exists=.env.local scripts/probe-application-rules.mjs
 *        → dry run, prints the plan, touches nothing
 *   ... --run --sections ownership
 *   ... --run --sections ownership,applications
 *
 * Needs GOOGLE_CLOUD_PROJECT, ADC for an account that can create users, and
 * NEXT_PUBLIC_FIREBASE_API_KEY and NEXT_PUBLIC_FIREBASE_PROJECT_ID. Refuses if
 * the two project ids differ.
 */

import { createHash, randomBytes } from 'node:crypto';

import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, GeoPoint, getFirestore } from 'firebase-admin/firestore';

import {
  SERVER_TIME,
  adminStatusPatch,
  applicationIdFor,
  buildApplicationCreate,
  buildApprovalWrites,
  buildHomeCreate,
  isServerTime,
  validateHome,
  withdrawalPatch,
} from '../src/lib/applications.ts';

const args = process.argv.slice(2);
const RUN = args.includes('--run');
const sectionsArg = args[args.indexOf('--sections') + 1];
const SECTIONS = new Set(
  args.includes('--sections') && sectionsArg ? sectionsArg.split(',') : ['ownership', 'applications'],
);

const project = process.env.GOOGLE_CLOUD_PROJECT;
const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
if (!project) {
  console.error('GOOGLE_CLOUD_PROJECT is not set. Refusing to guess.');
  process.exit(2);
}
if (process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID !== project) {
  console.error(
    `NEXT_PUBLIC_FIREBASE_PROJECT_ID (${process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID}) is not GOOGLE_CLOUD_PROJECT (${project}).`,
  );
  process.exit(2);
}
if (!apiKey) {
  console.error('NEXT_PUBLIC_FIREBASE_API_KEY is not set — it is what signs a probe account in.');
  process.exit(2);
}

const RUN_ID = `appprobe-4a-${randomBytes(3).toString('hex')}`;
const PET_ID = `${RUN_ID}-pet`;
const PASSWORD = `${randomBytes(12).toString('hex')}Aa1!`;
const PEOPLE = {
  ana: `${RUN_ID}-ana@example.com`,
  beto: `${RUN_ID}-beto@example.com`,
  admin: `${RUN_ID}-admin@example.com`,
};

// The deployed acceptedContracts() is empty, so no pair can be accepted. This
// one only gives the builder the SHAPE of a contract; it is not a contract.
const PROBE_CONTRACT = {
  version: '2000-01-01',
  sha256: createHash('sha256').update('probe-application-rules, not a contract').digest('hex'),
};
const PROBE_HOME = { addressText: 'Calle Appprobe 1, zona Probe', reference: '', pin: { latitude: -17.3935, longitude: -66.1571 } };

console.log(`run: ${RUN_ID}  project: ${project}  sections: ${[...SECTIONS].join(', ')}`);
if (!RUN) {
  console.log('\nDRY RUN. Would create:');
  console.log(`  auth accounts   ${Object.values(PEOPLE).join(', ')}  (admin claim on the last)`);
  console.log(`  pets/${PET_ID}  status shelter (never on the wall), + identity, custody`);
  console.log(`  adoptions/${PET_ID}`);
  if (SECTIONS.has('applications')) {
    console.log(`  adoptionApplications/${PET_ID}__<ana uid>  + private/home + internal/notes`);
    console.log(`  adoptionApplications/${PET_ID}__<beto uid> + private/home`);
  }
  console.log('\nNothing in Storage. Add --run to execute. Everything is deleted and read back afterwards.');
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// REST plumbing
// ─────────────────────────────────────────────────────────────────────────────

const DOCS = `projects/${project}/databases/(default)/documents`;
const BASE = `https://firestore.googleapis.com/v1/${DOCS}`;

async function signIn(email) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`sign-in failed for ${email}: ${body?.error?.message ?? r.status}`);
  return body.idToken;
}

/** A point, so `toValue` can tell it from an ordinary map. */
class Geo {
  constructor(latitude, longitude) {
    this.latitude = latitude;
    this.longitude = longitude;
  }
}

function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (v instanceof Geo) return { geoPointValue: { latitude: v.latitude, longitude: v.longitude } };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (isServerTime(v)) throw new Error('toValue: a nested SERVER_TIME marker cannot be encoded');
  const fields = {};
  for (const [k, x] of Object.entries(v)) fields[k] = toValue(x);
  return { mapValue: { fields } };
}

/**
 * One REST write. SERVER_TIME markers at the top level become REQUEST_TIME
 * transforms — what the SDK's serverTimestamp() sends — so the rules see
 * `== request.time`. `mask` true is the SDK's updateDoc / set-with-merge;
 * false is a plain set, which on an existing document is an UPDATE.
 */
function restWrite(path, data, { mask = false, mustExist = false } = {}) {
  const fields = {};
  const transforms = [];
  for (const [key, value] of Object.entries(data)) {
    if (isServerTime(value)) transforms.push({ fieldPath: key, setToServerValue: 'REQUEST_TIME' });
    else fields[key] = toValue(value);
  }
  const write = { update: { name: `${DOCS}/${path}`, fields } };
  if (mask) write.updateMask = { fieldPaths: Object.keys(fields) };
  if (transforms.length) write.updateTransforms = transforms;
  if (mustExist) write.currentDocument = { exists: true };
  return write;
}

const restDelete = (path) => ({ delete: `${DOCS}/${path}` });

/** The pure layer's WriteOps, as the SDK's applyWriteOps would send them. */
function fromWriteOps(ops) {
  return ops.map((op) =>
    op.op === 'update'
      ? restWrite(op.path.join('/'), op.data, { mask: true, mustExist: true })
      : restWrite(op.path.join('/'), op.data, { mask: op.merge }),
  );
}

async function call(url, token, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body) headers['Content-Type'] = 'application/json';
  const r = await fetch(url, { ...init, headers });
  let message = '';
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    message = body?.error?.status ?? body?.[0]?.error?.status ?? '';
  }
  return { status: r.status, message };
}

const getDoc = (path, token) => call(`${BASE}/${path}`, token);
const listCollection = (path, token) => call(`${BASE}/${path}?pageSize=1`, token);
const commit = (token, writes) => call(`${BASE}:commit`, token, { method: 'POST', body: JSON.stringify({ writes }) });
const queryByApplicant = (token, uid) =>
  call(`${BASE}:runQuery`, token, {
    method: 'POST',
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'adoptionApplications' }],
        where: { fieldFilter: { field: { fieldPath: 'applicantUid' }, op: 'EQUAL', value: { stringValue: uid } } },
        limit: 10,
      },
    }),
  });

// ─────────────────────────────────────────────────────────────────────────────
// Outcomes
// ─────────────────────────────────────────────────────────────────────────────

const results = [];

/**
 * 200 is ALLOW. 404 on a READ is also ALLOW: Firestore evaluates rules before
 * existence, so a permitted read of an absent document is NOT_FOUND. 403 is
 * DENY. Anything else — a 400 from a malformed request, a 409 from a failed
 * precondition — is an ERROR, never counted as either.
 */
function classify({ status }, { read = false } = {}) {
  if (status === 200 || (read && status === 404)) return 'ALLOW';
  if (status === 403) return 'DENY';
  return 'ERROR';
}

async function expect(expected, name, operation, options) {
  let outcome;
  let detail = '';
  try {
    const response = await operation();
    outcome = classify(response, options);
    detail = `${response.status}${response.message ? ` ${response.message}` : ''}`;
  } catch (error) {
    outcome = 'ERROR';
    detail = String(error?.message ?? error);
  }
  const ok = expected === outcome;
  results.push({ ok, name });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  expect ${expected.padEnd(5)} got ${outcome.padEnd(5)}  ${name}  (${detail})`);
}
const read = { read: true };

// ─────────────────────────────────────────────────────────────────────────────

if (!getApps().length) initializeApp({ projectId: project });
const adminAuth = getAuth();
const adminDb = getFirestore();

const uids = {};
let exitCode = 0;

try {
  // ── fixtures ─────────────────────────────────────────────────────────────
  for (const [who, email] of Object.entries(PEOPLE)) {
    uids[who] = (await adminAuth.createUser({ email, password: PASSWORD, emailVerified: true })).uid;
  }
  await adminAuth.setCustomUserClaims(uids.admin, { admin: true });
  // Signed in AFTER the claim is set, so the admin's token carries it.
  const token = { ana: await signIn(PEOPLE.ana), beto: await signIn(PEOPLE.beto), admin: await signIn(PEOPLE.admin), anon: null };

  const petRef = adminDb.collection('pets').doc(PET_ID);
  await petRef.set({
    slug: RUN_ID,
    name: 'Appprobe 4a',
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
    holder: 'Appprobe',
    holderUid: null,
    startedAt: FieldValue.serverTimestamp(),
    endedAt: null,
    note: null,
    recordedBy: 'appprobe',
  });

  const microchip = `pets/${PET_ID}/identity/microchip`;

  // ── controls: a run of nothing but denials would prove nothing ──────────
  await expect('ALLOW', 'CONTROL anonymous reads a public pet (absent)', () => getDoc('pets/no-such-pet-appprobe', token.anon), read);
  await expect('DENY', 'CONTROL even an admin is refused an undeclared collection', () => getDoc('noSuchCollection/x', token.admin), read);

  // ── ownership ────────────────────────────────────────────────────────────
  if (SECTIONS.has('ownership')) {
    console.log('\n── ownership ──');
    await expect('DENY', 'before adoption: applicant reads the microchip', () => getDoc(microchip, token.ana), read);

    await adminDb.collection('adoptions').doc(PET_ID).set({
      petId: PET_ID,
      ownerUid: uids.ana,
      adoptedAt: FieldValue.serverTimestamp(),
      approvedBy: 'appprobe',
      applicationId: null,
    });

    await expect('ALLOW', 'owner reads the microchip', () => getDoc(microchip, token.ana), read);
    await expect('DENY', 'signed-in stranger reads the microchip', () => getDoc(microchip, token.beto), read);
    await expect('DENY', 'anonymous reads the microchip', () => getDoc(microchip, token.anon), read);
    await expect('ALLOW', 'owner reads own adoption', () => getDoc(`adoptions/${PET_ID}`, token.ana), read);
    await expect('DENY', 'stranger reads the adoption', () => getDoc(`adoptions/${PET_ID}`, token.beto), read);
    await expect('ALLOW', 'owner reads the custody chain', () => getDoc(`pets/${PET_ID}/custody/c-shelter`, token.ana), read);
    await expect('DENY', 'stranger reads the custody chain', () => getDoc(`pets/${PET_ID}/custody/c-shelter`, token.beto), read);
    await expect('DENY', 'stranger writes adoptions/{petId} naming THEMSELVES', () =>
      commit(token.beto, [restWrite(`adoptions/${PET_ID}`, { petId: PET_ID, ownerUid: uids.beto })]),
    );
    await expect('DENY', 'owner rewrites own adoption', () =>
      commit(token.ana, [restWrite(`adoptions/${PET_ID}`, { petId: PET_ID, ownerUid: uids.ana })]),
    );

    await adminDb.collection('adoptions').doc(PET_ID).delete();
    await expect('DENY', 'after the adoption is removed: former owner reads the microchip', () => getDoc(microchip, token.ana), read);
  }

  // ── applications ─────────────────────────────────────────────────────────
  if (SECTIONS.has('applications')) {
    console.log('\n── applications ──');
    const anaApp = applicationIdFor(PET_ID, uids.ana);
    const betoApp = applicationIdFor(PET_ID, uids.beto);
    const appPath = (id) => `adoptionApplications/${id}`;
    const homePath = (id) => `adoptionApplications/${id}/private/home`;
    const validHome = validateHome(PROBE_HOME).home;
    if (!validHome) throw new Error('the probe home does not validate');

    /** The submit batch the browser sends: the application and its home, together. */
    const submitBatch = (who) => {
      const app = buildApplicationCreate({
        petId: PET_ID,
        applicantUid: uids[who],
        applicantEmail: PEOPLE[who],
        applicantEmailVerified: true,
        answers: { fullName: 'Appprobe', whatsapp: '70000000', adults: 1, everyoneAgrees: true },
        contract: PROBE_CONTRACT,
      });
      const home = buildHomeCreate({ applicantUid: uids[who], home: validHome });
      const id = applicationIdFor(PET_ID, uids[who]);
      return [
        restWrite(appPath(id), app),
        restWrite(homePath(id), { ...home, geo: home.geo ? new Geo(home.geo.latitude, home.geo.longitude) : null }),
      ];
    };

    // With the switch off and no contract accepted, this can only be DENY.
    // It cannot say WHICH condition refused it; see the header.
    await expect('DENY', 'submit batch (application + home) — refused while the switch is off', () =>
      commit(token.ana, submitBatch('ana')),
    );

    // Seed both applications the way an allowed create would leave them, so
    // every later case has something to act on.
    for (const who of ['ana', 'beto']) {
      const id = applicationIdFor(PET_ID, uids[who]);
      await adminDb.collection('adoptionApplications').doc(id).set({
        petId: PET_ID,
        applicantUid: uids[who],
        applicantEmail: PEOPLE[who],
        applicantEmailVerified: true,
        answers: { fullName: 'Appprobe' },
        status: 'submitted',
        submittedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        withdrawnAt: null,
        decidedAt: null,
        decidedBy: null,
        contractVersion: PROBE_CONTRACT.version,
        contractSha256: PROBE_CONTRACT.sha256,
        termsAcceptedAt: FieldValue.serverTimestamp(),
        idDocument: { front: null },
        identityErasedAt: null,
      });
      await adminDb.doc(homePath(id)).set({
        applicantUid: uids[who],
        addressText: validHome.addressText,
        reference: validHome.reference,
        geo: new GeoPoint(validHome.geo.latitude, validHome.geo.longitude),
        precision: 'exact',
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    await adminDb.doc(`${appPath(anaApp)}/internal/notes`).set({
      text: 'appprobe',
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: uids.admin,
    });
    console.log('      (both applications seeded by the Admin SDK — create ALLOW is the Rules test API\'s to prove until 4f)');

    // reads
    await expect('DENY', 'duplicate: a second submit batch over the first', () => commit(token.ana, submitBatch('ana')));
    await expect('ALLOW', 'applicant reads own application', () => getDoc(appPath(anaApp), token.ana), read);
    await expect('ALLOW', 'applicant checks an own id that does not exist', () =>
      getDoc(appPath(applicationIdFor(`${PET_ID}x`, uids.ana)), token.ana), read);
    await expect('DENY', 'stranger reads the application', () => getDoc(appPath(anaApp), token.beto), read);
    await expect('DENY', 'anonymous reads the application', () => getDoc(appPath(anaApp), token.anon), read);
    await expect('ALLOW', 'applicant lists own, constrained by uid', () => queryByApplicant(token.ana, uids.ana));
    await expect('DENY', 'applicant lists WITHOUT the uid constraint', () => listCollection('adoptionApplications', token.ana));
    await expect('DENY', "stranger lists the applicant's applications", () => queryByApplicant(token.beto, uids.ana));
    await expect('DENY', 'applicant reads the internal notes', () => getDoc(`${appPath(anaApp)}/internal/notes`, token.ana), read);
    await expect('ALLOW', 'admin reads the internal notes', () => getDoc(`${appPath(anaApp)}/internal/notes`, token.admin), read);

    // private/home
    await expect('ALLOW', 'home: the applicant reads their own', () => getDoc(homePath(anaApp), token.ana), read);
    await expect('DENY', 'home: a stranger reads it', () => getDoc(homePath(anaApp), token.beto), read);
    await expect('DENY', 'home: anonymous reads it', () => getDoc(homePath(anaApp), token.anon), read);
    await expect('ALLOW', 'home: an admin reads it', () => getDoc(homePath(anaApp), token.admin), read);
    await expect('ALLOW', 'home: an admin lists private documents', () => listCollection(`${appPath(anaApp)}/private`, token.admin));
    await expect('DENY', 'home: the applicant lists private documents', () => listCollection(`${appPath(anaApp)}/private`, token.ana));
    await expect('DENY', 'home: the applicant edits their own address', () =>
      commit(token.ana, [restWrite(homePath(anaApp), { addressText: 'Otra calle 456' }, { mask: true, mustExist: true })]),
    );
    await expect('DENY', 'home: the applicant deletes it', () => commit(token.ana, [restDelete(homePath(anaApp))]));
    await expect('DENY', 'home: an admin deletes it from a browser', () => commit(token.admin, [restDelete(homePath(anaApp))]));
    await expect('ALLOW', 'home: an admin corrects the address, attributed', () =>
      commit(token.admin, [
        restWrite(
          homePath(anaApp),
          { addressText: 'Calle Appprobe 2, zona Probe', correctedBy: uids.admin, correctedAt: SERVER_TIME },
          { mask: true, mustExist: true },
        ),
      ]),
    );

    // application updates
    const anaUpdate = (who, data) => commit(token[who], [restWrite(appPath(anaApp), data, { mask: true, mustExist: true })]);
    await expect('DENY', 'applicant self-escalates to approved', () =>
      anaUpdate('ana', { status: 'approved', updatedAt: SERVER_TIME }),
    );
    await expect('DENY', 'applicant withdraws AND writes decidedBy', () =>
      anaUpdate('ana', { ...withdrawalPatch('submitted'), decidedBy: uids.ana }),
    );
    await expect('DENY', 'applicant withdraws AND marks the ID received', () =>
      anaUpdate('ana', { ...withdrawalPatch('submitted'), idDocument: { front: { bytes: 1, generation: '1' } } }),
    );
    await expect('ALLOW', 'a withdrawal still succeeds (beto withdraws his own)', () =>
      commit(token.beto, [restWrite(appPath(betoApp), { ...withdrawalPatch('submitted') }, { mask: true, mustExist: true })]),
    );
    await expect('ALLOW', 'admin moves submitted → reviewing', () =>
      anaUpdate('admin', { ...adminStatusPatch('submitted', 'reviewing', uids.admin) }),
    );
    await expect('DENY', 'admin moves AND writes the ID marker from a browser', () =>
      anaUpdate('admin', { ...adminStatusPatch('reviewing', 'interview', uids.admin), idDocument: { front: { bytes: 1, generation: '1' } } }),
    );

    // approval
    const approvalBatch = () =>
      fromWriteOps(
        buildApprovalWrites({
          application: {
            id: anaApp,
            petId: PET_ID,
            applicantUid: uids.ana,
            applicantEmail: PEOPLE.ana,
            applicantEmailVerified: true,
            status: 'reviewing',
            // What the PURE check is told, so it builds the batch; the RULES
            // read the stored marker, which is what the next cases vary.
            idDocument: { front: { probe: true } },
          },
          pet: { id: PET_ID, status: 'shelter' },
          otherApplications: [],
          hasRecordedLocation: false,
          adminUid: uids.admin,
          holder: 'Appprobe',
          newCustodyId: 'c-adopter',
          openCustodyIds: ['c-shelter'],
          openPlacementIds: [],
        }),
      );

    await expect('DENY', 'admin approves: the full batch, but the ID photo has NOT been received', () =>
      commit(token.admin, approvalBatch()),
    );

    // What the upload route (portion 4b) will write through the Admin SDK.
    await adminDb.doc(appPath(anaApp)).update({
      'idDocument.front': { receivedAt: FieldValue.serverTimestamp(), bytes: 1234, generation: '0' },
    });

    await expect('DENY', 'admin approves WITHOUT the adoption in the batch', () =>
      anaUpdate('admin', { ...adminStatusPatch('reviewing', 'approved', uids.admin) }),
    );
    await expect('ALLOW', 'admin approves: the full batch from buildApprovalWrites, ID received', () =>
      commit(token.admin, approvalBatch()),
    );
    await expect('ALLOW', 'THE APPROVED APPLICANT now reads the microchip', () => getDoc(microchip, token.ana), read);
    await expect('DENY', 'applicant withdraws an approved application', () =>
      anaUpdate('ana', { ...withdrawalPatch('reviewing') }),
    );
    await expect('DENY', 'admin deletes the application', () => commit(token.admin, [restDelete(appPath(anaApp))]));
  }
} catch (error) {
  console.error('\nPROBE ABORTED:', error?.message ?? error);
  exitCode = 2;
} finally {
  // ── cleanup, then read it back ─────────────────────────────────────────────
  console.log('\n── cleanup ──');
  const appIds = Object.values(uids).map((uid) => `${PET_ID}__${uid}`);
  await adminDb.recursiveDelete(adminDb.collection('pets').doc(PET_ID)).catch(() => {});
  await adminDb.collection('adoptions').doc(PET_ID).delete().catch(() => {});
  for (const id of appIds) {
    await adminDb.recursiveDelete(adminDb.collection('adoptionApplications').doc(id)).catch(() => {});
  }
  for (const uid of Object.values(uids)) {
    await adminDb.collection('users').doc(uid).delete().catch(() => {});
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
    const ref = adminDb.collection('adoptionApplications').doc(id);
    if ((await ref.get()).exists) leftovers.push(`adoptionApplications/${id}`);
    for (const sub of ['internal', 'private']) {
      const snap = await ref.collection(sub).get();
      if (!snap.empty) leftovers.push(`adoptionApplications/${id}/${sub} (${snap.size})`);
    }
  }
  for (const [who, uid] of Object.entries(uids)) {
    if ((await adminDb.collection('users').doc(uid).get()).exists) leftovers.push(`users/${uid}`);
    if (await adminAuth.getUser(uid).then(() => true, () => false)) leftovers.push(`auth ${who}`);
  }
  const strays = (await adminAuth.listUsers(1000)).users.filter((u) => (u.email ?? '').includes(RUN_ID));
  if (strays.length > 0) leftovers.push(`auth accounts matching ${RUN_ID} (${strays.length})`);

  console.log(leftovers.length === 0 ? 'readback: nothing left behind' : `READBACK FOUND LEFTOVERS: ${leftovers.join(', ')}`);
  if (leftovers.length > 0) exitCode = 3;

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  if (failed > 0 && exitCode === 0) exitCode = 1;
  process.exit(exitCode);
}
