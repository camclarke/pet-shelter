/**
 * Evaluate firestore.rules for the adoption-application path with the Firebase
 * Rules TEST API. Nothing is released: `projects.test` compiles the source and
 * runs the cases in isolation, so this is safe to run against the live project
 * before a rules deploy — which is the whole point of it.
 *
 * ── Why this and not the client-SDK probe ──────────────────────────────────
 * New rules are not live until someone deploys them, and against the DEPLOYED
 * ruleset every `adoptionApplications` read and write meets default-deny. So a
 * client probe before the deploy proves nothing about these rules. This does,
 * on both branches, including the ones that matter most: an applicant writing
 * `decidedBy`, escalating their own status, reading the shelter's internal
 * notes, and naming themselves in `adoptions/{petId}`.
 *
 * ── What it CANNOT show ────────────────────────────────────────────────────
 * - LIST requests. The real backend checks a query's CONSTRAINTS against the
 *   rule; this API only evaluates a single `resource`. The list cases below
 *   prove the predicate, not that an unconstrained query is refused. That is
 *   what `scripts/probe-application-rules.mjs` checks after the deploy.
 * - `get()` / `exists()` / `getAfter()` are MOCKED here. The cases pin what the
 *   rules do with each answer; they cannot prove Firestore returns that answer.
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=wawitas node scripts/test-application-rules.mjs
 *   ... --rules path/to/other.rules   evaluate a different file (break probes)
 *   ... --only withdraw               run cases whose name contains a substring
 *
 * Needs ADC for an account that can call the Rules API on the project. Sends
 * `x-goog-user-project`, without which a user credential gets a 403 that reads
 * like a permissions problem and is not one.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { GoogleAuth } from 'google-auth-library';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
if (!project) {
  console.error('GOOGLE_CLOUD_PROJECT is not set. Refusing to guess.');
  process.exit(2);
}

const rulesPath = resolve(flag('--rules') ?? join(REPO_ROOT, 'firestore.rules'));
const only = flag('--only');
const source = readFileSync(rulesPath, 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const DB = '/databases/(default)/documents';
const NOW = '2026-09-12T03:00:00Z';
const EARLIER = '2026-09-10T15:00:00Z';

const PET = 'petLuna';
const ANA = 'uidAna';
const BETO = 'uidBeto';
const ADMIN = 'uidAdmin';
const APP = `${PET}__${ANA}`;
const APP_PATH = `/adoptionApplications/${APP}`;

const WHO = {
  ana: { uid: ANA, token: { email: 'ana@example.com', email_verified: true } },
  anaUnverified: { uid: ANA, token: { email: 'ana@example.com', email_verified: false } },
  beto: { uid: BETO, token: { email: 'beto@example.com', email_verified: true } },
  admin: { uid: ADMIN, token: { email: 'admin@example.com', email_verified: true, admin: true } },
};

function request(who, method, path, data) {
  const r = { method, path: `${DB}${path}`, time: NOW };
  if (who) r.auth = who;
  if (data !== undefined) r.resource = { data };
  return r;
}

const ANSWERS = {
  fullName: 'Ana Pérez',
  whatsapp: '+591 7000 0000',
  housingType: 'house',
  adults: 2,
  everyoneAgrees: true,
  whyThisAnimal: 'Porque sí.',
};

function created(over = {}) {
  return {
    petId: PET,
    applicantUid: ANA,
    applicantEmail: 'ana@example.com',
    applicantEmailVerified: true,
    answers: ANSWERS,
    status: 'submitted',
    submittedAt: NOW,
    updatedAt: NOW,
    withdrawnAt: null,
    decidedAt: null,
    decidedBy: null,
    ...over,
  };
}

/** The application as it already sits in Firestore. */
function stored(over = {}) {
  return { ...created(), submittedAt: EARLIER, updatedAt: EARLIER, ...over };
}

function mockPet(status) {
  const path = `${DB}/pets/${PET}`;
  if (status === null) {
    return [{ function: 'exists', args: [{ exactValue: path }], result: { value: false } }];
  }
  return [
    { function: 'exists', args: [{ exactValue: path }], result: { value: true } },
    { function: 'get', args: [{ exactValue: path }], result: { value: { data: { status } } } },
  ];
}

/**
 * The pet before the batch, and what the batch will have written, for
 * approvalIsOneBatch().
 */
function mockAfter({
  petStatusBefore = 'available',
  adoptionExists = true,
  ownerUid = ANA,
  applicationId = APP,
  petStatus = 'adopted',
} = {}) {
  const adoption = `${DB}/adoptions/${PET}`;
  const pet = `${DB}/pets/${PET}`;
  return [
    { function: 'get', args: [{ exactValue: pet }], result: { value: { data: { status: petStatusBefore } } } },
    { function: 'existsAfter', args: [{ exactValue: adoption }], result: { value: adoptionExists } },
    {
      function: 'getAfter',
      args: [{ exactValue: adoption }],
      result: { value: { data: { petId: PET, ownerUid, applicationId, approvedBy: ADMIN } } },
    },
    { function: 'getAfter', args: [{ exactValue: pet }], result: { value: { data: { status: petStatus } } } },
  ];
}

/** ownsPet() for the identity / custody paths. */
function mockOwner(ownerUid) {
  const path = `${DB}/adoptions/${PET}`;
  if (ownerUid === null) {
    return [{ function: 'exists', args: [{ exactValue: path }], result: { value: false } }];
  }
  return [
    { function: 'exists', args: [{ exactValue: path }], result: { value: true } },
    { function: 'get', args: [{ exactValue: path }], result: { value: { data: { ownerUid, petId: PET } } } },
  ];
}

function update(who, before, after, mocks) {
  return {
    request: request(who, 'update', APP_PATH, after),
    resource: { data: before },
    functionMocks: mocks,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The cases. Every DENY names what it is refusing.
// ─────────────────────────────────────────────────────────────────────────────

const cases = [
  // ── create ────────────────────────────────────────────────────────────────
  ['ALLOW', 'create: applicant applies for an available pet', {
    request: request(WHO.ana, 'create', APP_PATH, created()),
    functionMocks: mockPet('available'),
  }],
  ['ALLOW', 'create: an unverified email is recorded as unverified, not refused', {
    request: request(WHO.anaUnverified, 'create', APP_PATH, created({ applicantEmailVerified: false })),
    functionMocks: mockPet('available'),
  }],
  ['DENY', 'create: anonymous', {
    request: request(null, 'create', APP_PATH, created()),
    functionMocks: mockPet('available'),
  }],
  ['DENY', 'create: under ANOTHER user\'s id', {
    request: request(WHO.beto, 'create', APP_PATH, created({ applicantUid: BETO, applicantEmail: 'beto@example.com' })),
    functionMocks: mockPet('available'),
  }],
  ['DENY', 'create: own id but applicantUid names someone else', {
    request: request(WHO.ana, 'create', APP_PATH, created({ applicantUid: BETO })),
    functionMocks: mockPet('available'),
  }],
  ['DENY', 'create: id names a different pet than petId', {
    request: request(WHO.ana, 'create', `/adoptionApplications/petOther__${ANA}`, created()),
    functionMocks: mockPet('available'),
  }],
  ['DENY', 'create: an id with an extra separator', {
    request: request(WHO.ana, 'create', `/adoptionApplications/a__${PET}__${ANA}`, created({ petId: `a__${PET}` })),
    functionMocks: mockPet('available'),
  }],
  ['DENY', 'create: SELF-ESCALATING status to approved', {
    request: request(WHO.ana, 'create', APP_PATH, created({ status: 'approved' })),
    functionMocks: mockPet('available'),
  }],
  ['DENY', 'create: applicant WRITES decidedBy', {
    request: request(WHO.ana, 'create', APP_PATH, created({ decidedBy: ANA })),
    functionMocks: mockPet('available'),
  }],
  ['DENY', 'create: applicant writes decidedAt', {
    request: request(WHO.ana, 'create', APP_PATH, created({ decidedAt: NOW })),
    functionMocks: mockPet('available'),
  }],
  ['DENY', 'create: applicant writes internalNotes onto the application', {
    request: request(WHO.ana, 'create', APP_PATH, { ...created(), internalNotes: 'buena familia' }),
    functionMocks: mockPet('available'),
  }],
  ['DENY', 'create: a required field missing', {
    request: request(WHO.ana, 'create', APP_PATH, (() => { const d = created(); delete d.withdrawnAt; return d; })()),
    functionMocks: mockPet('available'),
  }],
  ['DENY', 'create: backdated submittedAt', {
    request: request(WHO.ana, 'create', APP_PATH, created({ submittedAt: EARLIER })),
    functionMocks: mockPet('available'),
  }],
  ['DENY', 'create: email that is not the token\'s', {
    request: request(WHO.ana, 'create', APP_PATH, created({ applicantEmail: 'otra@example.com' })),
    functionMocks: mockPet('available'),
  }],
  ['DENY', 'create: claims a verified email the token says is not', {
    request: request(WHO.anaUnverified, 'create', APP_PATH, created({ applicantEmailVerified: true })),
    functionMocks: mockPet('available'),
  }],
  ['DENY', 'create: pet not available (shelter)', {
    request: request(WHO.ana, 'create', APP_PATH, created()),
    functionMocks: mockPet('shelter'),
  }],
  ['DENY', 'create: pet already adopted', {
    request: request(WHO.ana, 'create', APP_PATH, created()),
    functionMocks: mockPet('adopted'),
  }],
  ['DENY', 'create: pet does not exist', {
    request: request(WHO.ana, 'create', APP_PATH, created()),
    functionMocks: mockPet(null),
  }],
  ['DENY', 'create: an answer under an unknown key', {
    request: request(WHO.ana, 'create', APP_PATH, created({ answers: { ...ANSWERS, idNumber: '1234567' } })),
    functionMocks: mockPet('available'),
  }],
  ['ALLOW', 'create: an answer exactly at the 1500-character bound', {
    request: request(WHO.ana, 'create', APP_PATH, created({ answers: { ...ANSWERS, previousPets: 'a'.repeat(1500) } })),
    functionMocks: mockPet('available'),
  }],
  ['DENY', 'create: an answer over the 1500-character bound', {
    request: request(WHO.ana, 'create', APP_PATH, created({ answers: { ...ANSWERS, previousPets: 'a'.repeat(1501) } })),
    functionMocks: mockPet('available'),
  }],
  ['DENY', 'create: a nested map as an answer', {
    request: request(WHO.ana, 'create', APP_PATH, created({ answers: { ...ANSWERS, zone: { street: 'x' } } })),
    functionMocks: mockPet('available'),
  }],
  ['DENY', 'create: an explicit null answer', {
    request: request(WHO.ana, 'create', APP_PATH, created({ answers: { ...ANSWERS, otherPets: null } })),
    functionMocks: mockPet('available'),
  }],
  ['DENY', 'create: a count above 99', {
    request: request(WHO.ana, 'create', APP_PATH, created({ answers: { ...ANSWERS, children: 100 } })),
    functionMocks: mockPet('available'),
  }],
  ['DENY', 'create: a negative count', {
    request: request(WHO.ana, 'create', APP_PATH, created({ answers: { ...ANSWERS, children: -1 } })),
    functionMocks: mockPet('available'),
  }],
  ['DENY', 'duplicate: a second submission over an existing application is an UPDATE and is refused', update(
    WHO.ana,
    stored({ status: 'reviewing' }),
    created({ answers: { ...ANSWERS, whyThisAnimal: 'otra vez' } }),
  )],

  // ── read ──────────────────────────────────────────────────────────────────
  ['ALLOW', 'get: applicant reads own application', {
    request: request(WHO.ana, 'get', APP_PATH),
    resource: { data: stored() },
  }],
  // ⚠️ `resource: null` must be EXPLICIT. Omitted, the test API leaves the
  // variable undefined and every read of it errors — which made the first run
  // of this case fail and would make its DENY twin pass for the wrong reason.
  // Production evaluates a get of a missing document with `resource == null`.
  ['ALLOW', 'get: applicant checks an own id that does not exist yet', {
    request: request(WHO.ana, 'get', APP_PATH),
    resource: null,
  }],
  ['DENY', 'get: ANOTHER USER reads the application', {
    request: request(WHO.beto, 'get', APP_PATH),
    resource: { data: stored() },
  }],
  ['DENY', 'get: another user probes a nonexistent id', {
    request: request(WHO.beto, 'get', APP_PATH),
    resource: null,
  }],
  ['DENY', 'get: ANONYMOUS reads the application', {
    request: request(null, 'get', APP_PATH),
    resource: { data: stored() },
  }],
  ['ALLOW', 'get: admin reads any application', {
    request: request(WHO.admin, 'get', APP_PATH),
    resource: { data: stored() },
  }],
  ['ALLOW', 'list: applicant, constrained to own uid', {
    request: request(WHO.ana, 'list', '/adoptionApplications/any'),
    resource: { data: stored() },
  }],
  ['DENY', 'list: applicant reaching someone else\'s applications', {
    request: request(WHO.beto, 'list', '/adoptionApplications/any'),
    resource: { data: stored() },
  }],
  ['DENY', 'list: anonymous', {
    request: request(null, 'list', '/adoptionApplications/any'),
    resource: { data: stored() },
  }],
  ['ALLOW', 'list: admin', {
    request: request(WHO.admin, 'list', '/adoptionApplications/any'),
    resource: { data: stored() },
  }],

  // ── internal notes ────────────────────────────────────────────────────────
  ['DENY', 'notes: the APPLICANT reads the shelter\'s internal notes', {
    request: request(WHO.ana, 'get', `${APP_PATH}/internal/notes`),
    resource: { data: { text: 'dudoso', updatedAt: EARLIER, updatedBy: ADMIN } },
  }],
  ['DENY', 'notes: anonymous reads internal notes', {
    request: request(null, 'get', `${APP_PATH}/internal/notes`),
    resource: { data: { text: 'dudoso', updatedAt: EARLIER, updatedBy: ADMIN } },
  }],
  ['ALLOW', 'notes: admin reads internal notes', {
    request: request(WHO.admin, 'get', `${APP_PATH}/internal/notes`),
    resource: { data: { text: 'dudoso', updatedAt: EARLIER, updatedBy: ADMIN } },
  }],
  ['ALLOW', 'notes: admin writes internal notes', {
    request: request(WHO.admin, 'create', `${APP_PATH}/internal/notes`, { text: 'Llamar el lunes', updatedAt: NOW, updatedBy: ADMIN }),
  }],
  ['DENY', 'notes: applicant writes internal notes', {
    request: request(WHO.ana, 'create', `${APP_PATH}/internal/notes`, { text: 'soy genial', updatedAt: NOW, updatedBy: ANA }),
  }],
  ['DENY', 'notes: admin writes notes attributed to someone else', {
    request: request(WHO.admin, 'create', `${APP_PATH}/internal/notes`, { text: 'x', updatedAt: NOW, updatedBy: BETO }),
  }],
  ['DENY', 'notes: admin writes a second notes document', {
    request: request(WHO.admin, 'create', `${APP_PATH}/internal/other`, { text: 'x', updatedAt: NOW, updatedBy: ADMIN }),
  }],
  ['DENY', 'notes: admin deletes internal notes', {
    request: request(WHO.admin, 'delete', `${APP_PATH}/internal/notes`),
    resource: { data: { text: 'x', updatedAt: EARLIER, updatedBy: ADMIN } },
  }],

  // ── applicant updates: withdraw only ──────────────────────────────────────
  ['ALLOW', 'withdraw: applicant withdraws a submitted application', update(
    WHO.ana, stored(), stored({ status: 'withdrawn', withdrawnAt: NOW, updatedAt: NOW }),
  )],
  ['ALLOW', 'withdraw: applicant withdraws during interview', update(
    WHO.ana, stored({ status: 'interview' }), stored({ status: 'withdrawn', withdrawnAt: NOW, updatedAt: NOW }),
  )],
  ['DENY', 'withdraw: an APPROVED application cannot be withdrawn by the applicant', update(
    WHO.ana,
    stored({ status: 'approved', decidedAt: EARLIER, decidedBy: ADMIN }),
    stored({ status: 'withdrawn', withdrawnAt: NOW, updatedAt: NOW, decidedAt: EARLIER, decidedBy: ADMIN }),
  )],
  ['DENY', 'escalate: applicant sets own status to approved', update(
    WHO.ana, stored({ status: 'interview' }), stored({ status: 'approved', updatedAt: NOW }),
  )],
  ['DENY', 'escalate: applicant moves own application into review', update(
    WHO.ana, stored(), stored({ status: 'reviewing', updatedAt: NOW }),
  )],
  ['DENY', 'escalate: applicant WRITES decidedBy while withdrawing', update(
    WHO.ana, stored(), stored({ status: 'withdrawn', withdrawnAt: NOW, updatedAt: NOW, decidedBy: ANA }),
  )],
  ['DENY', 'withdraw: applicant rewrites answers while withdrawing', update(
    WHO.ana, stored(), stored({ status: 'withdrawn', withdrawnAt: NOW, updatedAt: NOW, answers: { ...ANSWERS, zone: 'otra' } }),
  )],
  ['DENY', 'withdraw: ANOTHER USER withdraws my application', update(
    WHO.beto, stored(), stored({ status: 'withdrawn', withdrawnAt: NOW, updatedAt: NOW }),
  )],
  ['DENY', 'withdraw: backdated withdrawnAt', update(
    WHO.ana, stored(), stored({ status: 'withdrawn', withdrawnAt: EARLIER, updatedAt: NOW }),
  )],

  // ── admin updates ─────────────────────────────────────────────────────────
  ['ALLOW', 'admin: submitted → reviewing', update(
    WHO.admin, stored(), stored({ status: 'reviewing', updatedAt: NOW }),
  )],
  ['ALLOW', 'admin: reviewing → interview', update(
    WHO.admin, stored({ status: 'reviewing' }), stored({ status: 'interview', updatedAt: NOW }),
  )],
  ['ALLOW', 'admin: reviewing → rejected, attributed', update(
    WHO.admin, stored({ status: 'reviewing' }), stored({ status: 'rejected', updatedAt: NOW, decidedAt: NOW, decidedBy: ADMIN }),
  )],
  ['DENY', 'admin: rejects WITHOUT decidedBy', update(
    WHO.admin, stored({ status: 'reviewing' }), stored({ status: 'rejected', updatedAt: NOW, decidedAt: NOW }),
  )],
  ['DENY', 'admin: rejects in someone else\'s name', update(
    WHO.admin, stored({ status: 'reviewing' }), stored({ status: 'rejected', updatedAt: NOW, decidedAt: NOW, decidedBy: BETO }),
  )],
  ['ALLOW', 'admin: reopens a rejection, clearing the decision', update(
    WHO.admin,
    stored({ status: 'rejected', decidedAt: EARLIER, decidedBy: ADMIN }),
    stored({ status: 'reviewing', updatedAt: NOW, decidedAt: null, decidedBy: null }),
  )],
  ['DENY', 'admin: reopens a rejection but keeps the stale decision', update(
    WHO.admin,
    stored({ status: 'rejected', decidedAt: EARLIER, decidedBy: ADMIN }),
    stored({ status: 'reviewing', updatedAt: NOW, decidedAt: EARLIER, decidedBy: ADMIN }),
  )],
  ['ALLOW', 'admin: records a withdrawal the applicant asked for', update(
    WHO.admin, stored({ status: 'interview' }), stored({ status: 'withdrawn', updatedAt: NOW, withdrawnAt: NOW }),
  )],
  ['DENY', 'admin: submitted → approved skips review', update(
    WHO.admin, stored(), stored({ status: 'approved', updatedAt: NOW, decidedAt: NOW, decidedBy: ADMIN }), mockAfter(),
  )],
  ['DENY', 'admin: approved → reviewing (approval is terminal)', update(
    WHO.admin,
    stored({ status: 'approved', decidedAt: EARLIER, decidedBy: ADMIN }),
    stored({ status: 'reviewing', updatedAt: NOW }),
  )],
  ['DENY', 'admin: withdrawn → reviewing (withdrawal is terminal)', update(
    WHO.admin, stored({ status: 'withdrawn', withdrawnAt: EARLIER }), stored({ status: 'reviewing', updatedAt: NOW, withdrawnAt: null }),
  )],
  ['DENY', 'admin: rewrites the applicant\'s answers', update(
    WHO.admin, stored({ status: 'reviewing' }), stored({ status: 'interview', updatedAt: NOW, answers: { ...ANSWERS, children: 0 } }),
  )],
  ['DENY', 'admin: a same-status write', update(
    WHO.admin, stored({ status: 'reviewing' }), stored({ status: 'reviewing', updatedAt: NOW }),
  )],
  ['ALLOW', 'approve: in ONE batch with the adoption and the pet status', update(
    WHO.admin,
    stored({ status: 'interview' }),
    stored({ status: 'approved', updatedAt: NOW, decidedAt: NOW, decidedBy: ADMIN }),
    mockAfter(),
  )],
  ['DENY', 'approve: without writing adoptions/{petId} in the batch', update(
    WHO.admin,
    stored({ status: 'interview' }),
    stored({ status: 'approved', updatedAt: NOW, decidedAt: NOW, decidedBy: ADMIN }),
    mockAfter({ adoptionExists: false }),
  )],
  ['DENY', 'approve: the adoption names someone other than the applicant', update(
    WHO.admin,
    stored({ status: 'interview' }),
    stored({ status: 'approved', updatedAt: NOW, decidedAt: NOW, decidedBy: ADMIN }),
    mockAfter({ ownerUid: BETO }),
  )],
  ['DENY', 'approve: the adoption is linked to a different application', update(
    WHO.admin,
    stored({ status: 'interview' }),
    stored({ status: 'approved', updatedAt: NOW, decidedAt: NOW, decidedBy: ADMIN }),
    mockAfter({ applicationId: `${PET}__${BETO}` }),
  )],
  ['DENY', 'approve: the pet ALREADY belonged to a family before the batch', update(
    WHO.admin,
    stored({ status: 'interview' }),
    stored({ status: 'approved', updatedAt: NOW, decidedAt: NOW, decidedBy: ADMIN }),
    mockAfter({ petStatusBefore: 'adopted' }),
  )],
  ['ALLOW', 'approve: a returned animal (shelter again) can be adopted anew', update(
    WHO.admin,
    stored({ status: 'reviewing' }),
    stored({ status: 'approved', updatedAt: NOW, decidedAt: NOW, decidedBy: ADMIN }),
    mockAfter({ petStatusBefore: 'shelter' }),
  )],
  ['DENY', 'approve: the pet is not set to adopted in the batch', update(
    WHO.admin,
    stored({ status: 'interview' }),
    stored({ status: 'approved', updatedAt: NOW, decidedAt: NOW, decidedBy: ADMIN }),
    mockAfter({ petStatus: 'available' }),
  )],

  // ── delete ────────────────────────────────────────────────────────────────
  ['DENY', 'delete: admin deletes an application', {
    request: request(WHO.admin, 'delete', APP_PATH),
    resource: { data: stored() },
  }],
  ['DENY', 'delete: applicant deletes own application', {
    request: request(WHO.ana, 'delete', APP_PATH),
    resource: { data: stored() },
  }],

  // ── the approval path through the EXISTING rules ─────────────────────────
  ['DENY', 'adoptions: applicant creates adoptions/{petId} naming THEMSELVES', {
    request: request(WHO.ana, 'create', `/adoptions/${PET}`, { petId: PET, ownerUid: ANA, adoptedAt: NOW, approvedBy: ANA, applicationId: APP }),
  }],
  ['ALLOW', 'adoptions: admin creates the adoption', {
    request: request(WHO.admin, 'create', `/adoptions/${PET}`, { petId: PET, ownerUid: ANA, adoptedAt: NOW, approvedBy: ADMIN, applicationId: APP }),
  }],
  ['ALLOW', 'adoptions: the owner reads their adoption', {
    request: request(WHO.ana, 'get', `/adoptions/${PET}`),
    resource: { data: { petId: PET, ownerUid: ANA } },
  }],
  ['DENY', 'adoptions: another user reads it', {
    request: request(WHO.beto, 'get', `/adoptions/${PET}`),
    resource: { data: { petId: PET, ownerUid: ANA } },
  }],
  ['ALLOW', 'ownsPet: the NEW OWNER reads the microchip', {
    request: request(WHO.ana, 'get', `/pets/${PET}/identity/microchip`),
    resource: { data: { code: '068000000000001' } },
    functionMocks: mockOwner(ANA),
  }],
  ['DENY', 'ownsPet: an applicant NOT YET approved reads the microchip', {
    request: request(WHO.ana, 'get', `/pets/${PET}/identity/microchip`),
    resource: { data: { code: '068000000000001' } },
    functionMocks: mockOwner(null),
  }],
  ['DENY', 'ownsPet: a signed-in stranger reads the microchip', {
    request: request(WHO.beto, 'get', `/pets/${PET}/identity/microchip`),
    resource: { data: { code: '068000000000001' } },
    functionMocks: mockOwner(ANA),
  }],
  ['ALLOW', 'ownsPet: the new owner reads the custody chain', {
    request: request(WHO.ana, 'get', `/pets/${PET}/custody/c1`),
    resource: { data: { kind: 'adopter', holderUid: ANA } },
    functionMocks: mockOwner(ANA),
  }],
  ['DENY', 'custody: applicant writes their own custody record', {
    request: request(WHO.ana, 'create', `/pets/${PET}/custody/c9`, { kind: 'adopter', holderUid: ANA }),
  }],
  ['DENY', 'pets: applicant sets the pet to adopted', {
    request: request(WHO.ana, 'update', `/pets/${PET}`, { status: 'adopted' }),
    resource: { data: { status: 'available' } },
  }],
  ['ALLOW', 'pets: admin sets the pet to adopted', {
    request: request(WHO.admin, 'update', `/pets/${PET}`, { status: 'adopted' }),
    resource: { data: { status: 'available' } },
  }],
];

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

const selected = cases.filter(([, name]) => !only || name.includes(only));
if (selected.length === 0) {
  console.error(`no case name contains ${JSON.stringify(only)}`);
  process.exit(2);
}

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const client = await auth.getClient();

const CHUNK = 25;
let failures = 0;
let passed = 0;

console.log(`rules: ${rulesPath}`);
console.log(`project: ${project} (projects.test — nothing is released)\n`);

for (let i = 0; i < selected.length; i += CHUNK) {
  const chunk = selected.slice(i, i + CHUNK);
  let data;
  try {
    const res = await client.request({
      url: `https://firebaserules.googleapis.com/v1/projects/${project}:test`,
      method: 'POST',
      headers: { 'x-goog-user-project': project },
      data: {
        source: { files: [{ name: 'firestore.rules', content: source }] },
        testSuite: {
          testCases: chunk.map(([expectation, , body]) => ({ expectation, ...body })),
        },
      },
    });
    data = res.data;
  } catch (error) {
    console.error('Rules API call failed:', error?.response?.status, JSON.stringify(error?.response?.data ?? error?.message));
    process.exit(2);
  }

  const errors = (data.issues ?? []).filter((issue) => issue.severity === 'ERROR');
  if (errors.length > 0) {
    for (const issue of errors) {
      console.error(`RULES DO NOT COMPILE: ${issue.description} at line ${issue.sourcePosition?.line}`);
    }
    process.exit(1);
  }

  (data.testResults ?? []).forEach((result, j) => {
    const [expectation, name] = chunk[j];
    if (result.state === 'SUCCESS') {
      passed += 1;
      console.log(`ok     ${expectation.padEnd(5)} ${name}`);
    } else {
      failures += 1;
      console.log(`FAIL   ${expectation.padEnd(5)} ${name}`);
      for (const message of result.debugMessages ?? []) console.log(`         ${message}`);
      if (result.errorPosition) console.log(`         error at line ${result.errorPosition.line}`);
    }
  });
}

console.log(`\n${passed} passed, ${failures} failed, ${selected.length} cases`);
process.exit(failures === 0 ? 0 : 1);
