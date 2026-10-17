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
 * ── Portion 4a ────────────────────────────────────────────────────────────
 * The contract (version + hash in acceptedContracts()), the frozen ID marker,
 * `private/home` (created in the same batch, admin-corrected, never deleted),
 * and "no approval without a received ID". Each case below runs against one of
 * three COPIES of the file, never the file as it ships:
 *   - switch ON, acceptedContracts() holding the test pair      (the default)
 *   - switch OFF, test pair                                      (`OFF`)
 *   - switch ON, acceptedContracts() forced EMPTY                (`NO_CONTRACT`)
 * The file itself ships with the switch off, so against it EVERY create DENY
 * would pass for the wrong reason.
 *
 * ── Portion 4c-1 ──────────────────────────────────────────────────────────
 * `private/identity` (the C.I., age, civil status, landline, two references
 * and a renter's landlord): created in the same batch as the application and
 * `private/home`, READ BY ADMINS ONLY, never updated, never deleted. The answer
 * keys are now the paper form's. And the contract map holds the REAL pair, so
 * two more variants run:
 *   - switch ON, acceptedContracts() exactly as the file ships     (`SHIPPED_CONTRACT`)
 *   - the file EXACTLY as it ships: switch off, real pair           (`SHIPPED_FILE`)
 * The second is the proof that releasing these rules while the switch is off
 * changes no create outcome: a complete three-document batch carrying the
 * real contract is refused, and the existing reads answer as before.
 *
 * ── Encoding (MEASURED 2026-10-16 on this API) ─────────────────────────────
 * A JSON map with exactly `latitude` and `longitude` numbers arrives in the
 * rules as a `latlng`: it passes `is latlng`, fails `is map`, and `.latitude`
 * on it is a TYPE ERROR — only `.latitude()` works. pinWithinServiceArea()
 * uses the method form; withinServiceArea() (sightings) was fixed to match.
 *
 * ── What it CANNOT show ────────────────────────────────────────────────────
 * - LIST requests. The real backend checks a query's CONSTRAINTS against the
 *   rule; this API only evaluates a single `resource`. The list cases below
 *   prove the predicate, not that an unconstrained query is refused. That is
 *   what `scripts/probe-application-rules.mjs` checks after the deploy.
 * - `get()` / `exists()` / `getAfter()` / `existsAfter()` are MOCKED here. The
 *   cases pin what the rules do with each answer; they cannot prove Firestore
 *   returns that answer — in particular, that a batch's `existsAfter` sees the
 *   sibling document. The live REST probe does, once a create can be allowed.
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

import { createHash } from 'node:crypto';
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
const HOME_PATH = `${APP_PATH}/private/home`;
const IDENTITY_PATH = `${APP_PATH}/private/identity`;

// The contract pair the evaluated COPY accepts. Not a contract: a label hashed
// so the value has the shape of one. The real map ships empty.
const TEST_CONTRACT = {
  version: '2000-01-01',
  sha256: createHash('sha256').update('rules-test fixture, not a contract').digest('hex'),
};
const OTHER_SHA = createHash('sha256').update('some other text').digest('hex');

/**
 * The pair the evaluated FILE ships in acceptedContracts() — the real contract
 * since portion 4c-1. Read out of the rules source, because this script cannot
 * import TypeScript; application-config.test.ts pins that the file's pair is
 * the one in src/config/adoption-contract.ts. Exactly one pair, or nothing the
 * shipped cases prove would mean anything.
 */
const SHIPPED_CONTRACT = (() => {
  const fn = /function acceptedContracts\(\) \{\s*return \{([^{}]*)\};\s*\}/.exec(source);
  const pairs = fn ? [...fn[1].matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)] : [];
  if (pairs.length !== 1) {
    console.error(`expected exactly one contract pair in acceptedContracts() of ${rulesPath}, found ${pairs.length}`);
    process.exit(2);
  }
  return { version: pairs[0][1], sha256: pairs[0][2] };
})();

/** Whether the evaluated file ships with applicationsEnabled() returning false. */
const SHIPPED_SWITCH_ON = /function applicationsEnabled\(\) \{\s*return true;\s*\}/.test(source);

/** What the upload route records through the Admin SDK once the front arrives. */
const RECEIVED = { receivedAt: EARLIER, bytes: 120000, generation: '1760000000000000' };

/** Inside SHELTER.bounds, rounded to 4 decimals. */
const PIN = { latitude: -17.3935, longitude: -66.1571 };

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

// The six `store: 'application'` keys of the paper form (portion 4c-1).
const ANSWERS = {
  fullName: 'Ana Pérez',
  whatsapp: '+591 7000 0000',
  housingType: 'house',
  housingTenure: 'rented',
  movingSoon: false,
  walled: true,
};

// The twelve `store: 'identity'` keys — invented people, never real ones.
const IDENTITY_ANSWERS = {
  ciNumber: '1234567 LP',
  age: 30,
  civilStatus: 'soltera',
  landline: '4 4251234',
  personalRefName: 'Rosa Quispe',
  personalRefPhone: '70000001',
  personalRefRelation: 'amiga',
  familyRefName: 'Luis Pérez',
  familyRefPhone: '70000002',
  familyRefRelation: 'hermano',
  landlordName: 'Pedro Rojas',
  landlordPhone: '70000003',
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
    contractVersion: TEST_CONTRACT.version,
    contractSha256: TEST_CONTRACT.sha256,
    termsAcceptedAt: NOW,
    idDocument: { front: null },
    identityErasedAt: null,
    ...over,
  };
}

/** `created()` without some keys. */
function createdWithout(...keys) {
  const d = created();
  for (const key of keys) delete d[key];
  return d;
}

/** The application as it already sits in Firestore. */
function stored(over = {}) {
  return { ...created(), submittedAt: EARLIER, updatedAt: EARLIER, termsAcceptedAt: EARLIER, ...over };
}

/** Stored, with the ID photo received — the only state an approval can come from. */
function storedWithId(over = {}) {
  return stored({ idDocument: { front: RECEIVED }, ...over });
}

function mockPet(status, petId = PET) {
  const path = `${DB}/pets/${petId}`;
  if (status === null) {
    return [{ function: 'exists', args: [{ exactValue: path }], result: { value: false } }];
  }
  return [
    { function: 'exists', args: [{ exactValue: path }], result: { value: true } },
    { function: 'get', args: [{ exactValue: path }], result: { value: { data: { status } } } },
  ];
}

/**
 * Everything an application create reads: the pet, and whether the batch also
 * writes private/home and private/identity. Every create case gets ALL of
 * these, so a DENY can only come from the one thing the case gets wrong — never
 * from a missing mock.
 */
function mockCreate(
  petStatus = 'available',
  { homeAfter = true, identityAfter = true, appId = APP, petId = PET } = {},
) {
  // The private mocks are built from the application id the CASE writes to,
  // never from the default one: a case whose id differs must not be denied by
  // a missing mock instead of by the rule it names. Same for the pet.
  return [
    ...mockPet(petStatus, petId),
    {
      function: 'existsAfter',
      args: [{ exactValue: `${DB}/adoptionApplications/${appId}/private/home` }],
      result: { value: homeAfter },
    },
    {
      function: 'existsAfter',
      args: [{ exactValue: `${DB}/adoptionApplications/${appId}/private/identity` }],
      result: { value: identityAfter },
    },
  ];
}

function home(over = {}) {
  return {
    applicantUid: ANA,
    addressText: 'Calle Sucre 123, zona Central',
    reference: 'frente a la cancha',
    geo: null,
    precision: null,
    createdAt: NOW,
    ...over,
  };
}

function homeWithout(...keys) {
  const d = home();
  for (const key of keys) delete d[key];
  return d;
}

function storedHome(over = {}) {
  return home({ createdAt: EARLIER, ...over });
}

/** The application before the batch, and after it, for the home create. */
function mockHomeCreate({ parentBefore = false, parentAfter = true, appId = APP } = {}) {
  const parent = `${DB}/adoptionApplications/${appId}`;
  return [
    { function: 'exists', args: [{ exactValue: parent }], result: { value: parentBefore } },
    { function: 'existsAfter', args: [{ exactValue: parent }], result: { value: parentAfter } },
  ];
}

function homeCreate(who, data, mocks = mockHomeCreate(), path = HOME_PATH) {
  return { request: request(who, 'create', path, data), functionMocks: mocks };
}

function homeUpdate(who, before, after) {
  return { request: request(who, 'update', HOME_PATH, after), resource: { data: before } };
}

/** private/identity as the batch writes it. `answers` merges over the complete fixture. */
function identity(answers = IDENTITY_ANSWERS, over = {}) {
  return { applicantUid: ANA, answers, createdAt: NOW, ...over };
}

function identityWithout(...keys) {
  const d = identity();
  for (const key of keys) delete d[key];
  return d;
}

/** The identity fixture's answers, with some replaced or (value `undefined`) removed. */
function identityAnswers(over = {}) {
  const answers = { ...IDENTITY_ANSWERS, ...over };
  for (const [key, value] of Object.entries(over)) if (value === undefined) delete answers[key];
  return answers;
}

function storedIdentity(over = {}) {
  return identity(IDENTITY_ANSWERS, { createdAt: EARLIER, ...over });
}

// The parent before and after the batch is exactly what a home create reads,
// so the identity create uses the same mock.
function identityCreate(who, data, mocks = mockHomeCreate(), path = IDENTITY_PATH) {
  return { request: request(who, 'create', path, data), functionMocks: mocks };
}

function identityUpdate(who, before, after) {
  return { request: request(who, 'update', IDENTITY_PATH, after), resource: { data: before } };
}

const CORRECTED = { correctedAt: NOW, correctedBy: ADMIN };

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
  acceptance = true,
} = {}) {
  const adoption = `${DB}/adoptions/${PET}`;
  const pet = `${DB}/pets/${PET}`;
  // acceptanceRecorded(): the consent's audit trail (2026-10-17).
  const receipt = `${DB}/adoptionApplications/${APP}/private/acceptance`;
  return [
    { function: 'exists', args: [{ exactValue: receipt }], result: { value: acceptance } },
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

// Each case is [expectation, name, body, options]. `options.switch` picks
// applicationsEnabled(): 'on' (the default) forced true, 'off' forced false.
// `options.contracts` picks acceptedContracts(): 'test' (the default) forced to
// hold TEST_CONTRACT, 'empty' forced to `{}` — the state it ships in.
//
// ⚠️ Every ordinary create case runs with the switch ON and the test contract
// accepted. Run against the file as it ships, every create DENY would pass
// because the switch is off and the contract map is empty, not because of the
// condition it names — the passing-for-the-wrong-reason trap. Whether the FILE
// agrees with shelter.ts and adoption-contract.ts is the drift tests' job.
const OFF = { switch: 'off' };
const NO_CONTRACT = { contracts: 'empty' };
// Portion 4c-1. `shipped` means "leave that function exactly as the file has it".
const SHIPPED_CONTRACT_ON = { contracts: 'shipped' };
const SHIPPED_FILE = { switch: 'shipped', contracts: 'shipped' };

/** The real contract pair, on a complete application. */
const withShippedContract = (over = {}) =>
  created({ contractVersion: SHIPPED_CONTRACT.version, contractSha256: SHIPPED_CONTRACT.sha256, ...over });

const cases = [
  // ── the public switch: create is refused while applicationsEnabled() is false ─
  ['DENY', 'switch off: applicant applies for an available pet', {
    request: request(WHO.ana, 'create', APP_PATH, created()),
    functionMocks: mockCreate('available'),
  }, OFF],
  ['DENY', 'switch off: the home address cannot be written either', homeCreate(WHO.ana, home()), OFF],
  ['ALLOW', 'switch off: applicant still reads own application', {
    request: request(WHO.ana, 'get', APP_PATH),
    resource: { data: stored() },
  }, OFF],
  ['ALLOW', 'switch off: applicant still reads own home address', {
    request: request(WHO.ana, 'get', HOME_PATH),
    resource: { data: storedHome() },
  }, OFF],
  ['ALLOW', 'switch off: applicant still withdraws an open application', update(
    WHO.ana, stored(), stored({ status: 'withdrawn', withdrawnAt: NOW, updatedAt: NOW }),
  ), OFF],
  ['ALLOW', 'switch off: admin still reviews an application', update(
    WHO.admin, stored(), stored({ status: 'reviewing', updatedAt: NOW }),
  ), OFF],
  ['DENY', 'switch off: the personal details cannot be written either', identityCreate(WHO.ana, identity()), OFF],
  ['ALLOW', 'switch off: an admin still reads the personal details', {
    request: request(WHO.admin, 'get', IDENTITY_PATH),
    resource: { data: storedIdentity() },
  }, OFF],

  // ── portion 4c-1: the REAL contract, as the file ships it ────────────────
  // Switch forced ON, acceptedContracts() untouched: the complete batch with
  // the real pair is what 4f will allow.
  ['ALLOW', 'shipped contract: the application carrying the REAL contract pair', {
    request: request(WHO.ana, 'create', APP_PATH, withShippedContract()),
    functionMocks: mockCreate('available'),
  }, SHIPPED_CONTRACT_ON],
  ['ALLOW', 'shipped contract: its private/home in the same batch', homeCreate(WHO.ana, home()), SHIPPED_CONTRACT_ON],
  ['ALLOW', 'shipped contract: its private/identity in the same batch', identityCreate(WHO.ana, identity()), SHIPPED_CONTRACT_ON],
  ['DENY', 'shipped contract: the test fixture pair is not in the shipped map', {
    request: request(WHO.ana, 'create', APP_PATH, created()),
    functionMocks: mockCreate('available'),
  }, SHIPPED_CONTRACT_ON],
  ['DENY', 'shipped contract: the real hash under another version', {
    request: request(WHO.ana, 'create', APP_PATH, withShippedContract({ contractVersion: '2026-10-15' })),
    functionMocks: mockCreate('available'),
  }, SHIPPED_CONTRACT_ON],
  ['DENY', 'shipped contract: the real version with another hash', {
    request: request(WHO.ana, 'create', APP_PATH, withShippedContract({ contractSha256: OTHER_SHA })),
    functionMocks: mockCreate('available'),
  }, SHIPPED_CONTRACT_ON],

  // ── the file EXACTLY as it ships (switch ON since 2026-10-17, real pair) ──
  // Since the switch-on, the complete three-document batch with the real
  // contract is accepted; the other cases are unchanged.
  ['ALLOW', 'SHIPPED FILE: the application, complete, with the real contract', {
    request: request(WHO.ana, 'create', APP_PATH, withShippedContract()),
    functionMocks: mockCreate('available'),
  }, SHIPPED_FILE],
  ['ALLOW', 'SHIPPED FILE: its private/home', homeCreate(WHO.ana, home()), SHIPPED_FILE],
  ['ALLOW', 'SHIPPED FILE: its private/identity', identityCreate(WHO.ana, identity()), SHIPPED_FILE],
  ['ALLOW', 'SHIPPED FILE: the applicant still reads own application', {
    request: request(WHO.ana, 'get', APP_PATH),
    resource: { data: stored() },
  }, SHIPPED_FILE],
  ['ALLOW', 'SHIPPED FILE: the applicant still reads own home address', {
    request: request(WHO.ana, 'get', HOME_PATH),
    resource: { data: storedHome() },
  }, SHIPPED_FILE],
  ['DENY', 'SHIPPED FILE: the applicant cannot read own personal details', {
    request: request(WHO.ana, 'get', IDENTITY_PATH),
    resource: { data: storedIdentity() },
  }, SHIPPED_FILE],
  ['ALLOW', 'SHIPPED FILE: an admin reads the personal details', {
    request: request(WHO.admin, 'get', IDENTITY_PATH),
    resource: { data: storedIdentity() },
  }, SHIPPED_FILE],
  ['ALLOW', 'SHIPPED FILE: the applicant still withdraws an open application', update(
    WHO.ana, stored(), stored({ status: 'withdrawn', withdrawnAt: NOW, updatedAt: NOW }),
  ), SHIPPED_FILE],
  ['ALLOW', 'SHIPPED FILE: an admin still approves, in one batch, ID received', update(
    WHO.admin,
    storedWithId({ status: 'interview' }),
    storedWithId({ status: 'approved', updatedAt: NOW, decidedAt: NOW, decidedBy: ADMIN }),
    mockAfter(),
  ), SHIPPED_FILE],

  // ── the third lock: the contract (portion 4a) ────────────────────────────
  ['DENY', 'contract lock: with acceptedContracts() EMPTY, a complete create is refused', {
    request: request(WHO.ana, 'create', APP_PATH, created()),
    functionMocks: mockCreate('available'),
  }, NO_CONTRACT],
  ['DENY', 'contract: a version that is not listed', {
    request: request(WHO.ana, 'create', APP_PATH, created({ contractVersion: '1999-12-31' })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'contract: an unlisted version with an EMPTY hash (the get() default trap)', {
    request: request(WHO.ana, 'create', APP_PATH, created({ contractVersion: '1999-12-31', contractSha256: '' })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'contract: the listed version with a hash that does not match', {
    request: request(WHO.ana, 'create', APP_PATH, created({ contractSha256: OTHER_SHA })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'contract: contractVersion missing', {
    request: request(WHO.ana, 'create', APP_PATH, createdWithout('contractVersion')),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'contract: contractSha256 missing', {
    request: request(WHO.ana, 'create', APP_PATH, createdWithout('contractSha256')),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'contract: the hash sent as a number', {
    request: request(WHO.ana, 'create', APP_PATH, created({ contractSha256: 12345 })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'contract: termsAcceptedAt backdated (not request.time)', {
    request: request(WHO.ana, 'create', APP_PATH, created({ termsAcceptedAt: EARLIER })),
    functionMocks: mockCreate('available'),
  }],

  // ── the ID marker and the erasure marker at create ───────────────────────
  ['DENY', 'idDocument: the front already marked received at create', {
    request: request(WHO.ana, 'create', APP_PATH, created({ idDocument: { front: RECEIVED } })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'idDocument: the back already marked received at create', {
    request: request(WHO.ana, 'create', APP_PATH, created({ idDocument: { front: null, back: RECEIVED } })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'idDocument: an extra side', {
    request: request(WHO.ana, 'create', APP_PATH, created({ idDocument: { front: null, selfie: null } })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'idDocument: not a map', {
    request: request(WHO.ana, 'create', APP_PATH, created({ idDocument: null })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'idDocument: missing', {
    request: request(WHO.ana, 'create', APP_PATH, createdWithout('idDocument')),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'identityErasedAt: non-null at create', {
    request: request(WHO.ana, 'create', APP_PATH, created({ identityErasedAt: NOW })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'identityErasedAt: missing', {
    request: request(WHO.ana, 'create', APP_PATH, createdWithout('identityErasedAt')),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'create: an application WITHOUT private/home in the same batch', {
    request: request(WHO.ana, 'create', APP_PATH, created()),
    functionMocks: mockCreate('available', { homeAfter: false }),
  }],
  ['DENY', 'create: an application WITHOUT private/identity in the same batch', {
    request: request(WHO.ana, 'create', APP_PATH, created()),
    functionMocks: mockCreate('available', { identityAfter: false }),
  }],
  ['DENY', 'create: the C.I. inside answers instead of private/identity', {
    request: request(WHO.ana, 'create', APP_PATH, created({ answers: { ...ANSWERS, ciNumber: '1234567' } })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', "create: a reference's phone inside answers", {
    request: request(WHO.ana, 'create', APP_PATH, created({ answers: { ...ANSWERS, personalRefPhone: '70000001' } })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'create: an answer under a REMOVED draft key (whyThisAnimal)', {
    request: request(WHO.ana, 'create', APP_PATH, created({ answers: { ...ANSWERS, whyThisAnimal: 'Porque sí.' } })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'create: an answer under a REMOVED draft key (adults)', {
    request: request(WHO.ana, 'create', APP_PATH, created({ answers: { ...ANSWERS, adults: 2 } })),
    functionMocks: mockCreate('available'),
  }],

  // ── private/identity: create (portion 4c-1) ─────────────────────────────
  ['ALLOW', 'identity: created in the same batch, all twelve answers', identityCreate(WHO.ana, identity())],
  ['ALLOW', 'identity: only the two required answers (no optional ones)', identityCreate(
    WHO.ana, identity({ ciNumber: '1234567', age: 30 }),
  )],
  ['ALLOW', 'identity: a C.I. of exactly 4 characters', identityCreate(WHO.ana, identity(identityAnswers({ ciNumber: '1234' })))],
  ['ALLOW', 'identity: a C.I. of exactly 20 characters', identityCreate(
    WHO.ana, identity(identityAnswers({ ciNumber: '1'.repeat(20) })),
  )],
  ['ALLOW', 'identity: age exactly 18', identityCreate(WHO.ana, identity(identityAnswers({ age: 18 })))],
  ['ALLOW', 'identity: age exactly 99', identityCreate(WHO.ana, identity(identityAnswers({ age: 99 })))],
  ['ALLOW', 'identity: an answer of exactly 120 characters', identityCreate(
    WHO.ana, identity(identityAnswers({ familyRefName: 'n'.repeat(120) })),
  )],
  ['ALLOW', 'identity: an empty optional answer (the rules allow it; the form never sends one)', identityCreate(
    WHO.ana, identity(identityAnswers({ landline: '' })),
  )],
  ['DENY', 'identity: attached to an application that ALREADY exists', identityCreate(
    WHO.ana, identity(), mockHomeCreate({ parentBefore: true }),
  )],
  ['DENY', 'identity: without the application in the same batch', identityCreate(
    WHO.ana, identity(), mockHomeCreate({ parentAfter: false }),
  )],
  ['DENY', "identity: under ANOTHER user's application id", identityCreate(WHO.beto, identity(IDENTITY_ANSWERS, { applicantUid: BETO }))],
  ['DENY', 'identity: own id, but applicantUid names someone else', identityCreate(
    WHO.ana, identity(IDENTITY_ANSWERS, { applicantUid: BETO }),
  )],
  ['DENY', 'identity: anonymous', identityCreate(null, identity())],
  ['DENY', 'identity: a third private document (private/extra)', identityCreate(
    WHO.ana, identity(), mockHomeCreate(), `${APP_PATH}/private/extra`,
  )],
  ['DENY', 'identity: an extra top-level key', identityCreate(WHO.ana, identity(IDENTITY_ANSWERS, { note: 'x' }))],
  ['DENY', 'identity: createdAt missing', identityCreate(WHO.ana, identityWithout('createdAt'))],
  ['DENY', 'identity: answers missing', identityCreate(WHO.ana, identityWithout('answers'))],
  ['DENY', 'identity: backdated createdAt', identityCreate(WHO.ana, identity(IDENTITY_ANSWERS, { createdAt: EARLIER }))],
  ['DENY', 'identity: answers is not a map', identityCreate(WHO.ana, identity('1234567, 30'))],
  ['DENY', 'identity: an extra answer key (an application key, fullName)', identityCreate(
    WHO.ana, identity(identityAnswers({ fullName: 'Ana Pérez' })),
  )],
  ['DENY', 'identity: an extra answer key (a removed draft key, whyThisAnimal)', identityCreate(
    WHO.ana, identity(identityAnswers({ whyThisAnimal: 'Porque sí.' })),
  )],
  ['DENY', 'identity: ciNumber missing', identityCreate(WHO.ana, identity(identityAnswers({ ciNumber: undefined })))],
  ['DENY', 'identity: age missing', identityCreate(WHO.ana, identity(identityAnswers({ age: undefined })))],
  ['DENY', 'identity: a C.I. of 3 characters', identityCreate(WHO.ana, identity(identityAnswers({ ciNumber: '123' })))],
  ['DENY', 'identity: a C.I. of 21 characters', identityCreate(
    WHO.ana, identity(identityAnswers({ ciNumber: '1'.repeat(21) })),
  )],
  ['DENY', 'identity: a C.I. sent as a number', identityCreate(WHO.ana, identity(identityAnswers({ ciNumber: 1234567 })))],
  ['DENY', 'identity: age 17 (under age)', identityCreate(WHO.ana, identity(identityAnswers({ age: 17 })))],
  ['DENY', 'identity: age 100', identityCreate(WHO.ana, identity(identityAnswers({ age: 100 })))],
  ['DENY', 'identity: age sent as the string "18"', identityCreate(WHO.ana, identity(identityAnswers({ age: '18' })))],
  ['DENY', 'identity: age 18.5', identityCreate(WHO.ana, identity(identityAnswers({ age: 18.5 })))],
  ['DENY', 'identity: an answer of 121 characters', identityCreate(
    WHO.ana, identity(identityAnswers({ familyRefName: 'n'.repeat(121) })),
  )],
  ['DENY', 'identity: a number under a string key (personalRefPhone)', identityCreate(
    WHO.ana, identity(identityAnswers({ personalRefPhone: 70000001 })),
  )],
  ['DENY', 'identity: a nested map under a string key (landlordName)', identityCreate(
    WHO.ana, identity(identityAnswers({ landlordName: { first: 'Pedro' } })),
  )],
  // ── nobody creates on someone's behalf, admins included (review 4c-1 #2) ─
  // An appended `|| isAdmin()` on either create rule would allow these; the
  // reviewer's mutants M1 and M2 survived the suite until they were added.
  ['DENY', 'admin: creates private/identity WITHOUT the application in the batch', identityCreate(
    WHO.admin, identity(), mockHomeCreate({ parentAfter: false }),
  )],
  ['DENY', 'admin: creates private/identity on an application that ALREADY exists', identityCreate(
    WHO.admin, identity(), mockHomeCreate({ parentBefore: true }),
  )],
  ['DENY', 'admin: creates private/home', homeCreate(WHO.admin, home())],
  ['DENY', 'admin: creates an application', {
    request: request(WHO.admin, 'create', APP_PATH, created()),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'switch off: an admin cannot create an application either', {
    request: request(WHO.admin, 'create', APP_PATH, created()),
    functionMocks: mockCreate('available'),
  }, OFF],
  ['DENY', 'switch off: an admin cannot create private/identity either', identityCreate(WHO.admin, identity()), OFF],
  ['DENY', 'identity: a home-shaped document written as private/identity', identityCreate(WHO.ana, home())],
  ['DENY', 'home: an identity-shaped document written as private/home', homeCreate(WHO.ana, identity())],

  // ── private/identity: read — ADMINS ONLY (D2) ────────────────────────────
  ['DENY', 'identity: the APPLICANT reads their own personal details', {
    request: request(WHO.ana, 'get', IDENTITY_PATH),
    resource: { data: storedIdentity() },
  }],
  ['DENY', 'identity: ANOTHER USER reads it', {
    request: request(WHO.beto, 'get', IDENTITY_PATH),
    resource: { data: storedIdentity() },
  }],
  ['DENY', 'identity: anonymous reads it', {
    request: request(null, 'get', IDENTITY_PATH),
    resource: { data: storedIdentity() },
  }],
  ['ALLOW', 'identity: an admin reads it', {
    request: request(WHO.admin, 'get', IDENTITY_PATH),
    resource: { data: storedIdentity() },
  }],

  // ── private/identity: never updated (D15), never deleted from a browser ──
  ['DENY', 'identity: the applicant edits their own C.I.', identityUpdate(
    WHO.ana, storedIdentity(), storedIdentity({ answers: identityAnswers({ ciNumber: '7654321' }) }),
  )],
  ['DENY', 'identity: an ADMIN edits the C.I.', identityUpdate(
    WHO.admin, storedIdentity(), storedIdentity({ answers: identityAnswers({ ciNumber: '7654321' }) }),
  )],
  ['DENY', 'identity: an admin edits it, attributed like a home correction', identityUpdate(
    WHO.admin,
    storedIdentity(),
    storedIdentity({ answers: identityAnswers({ ciNumber: '7654321' }), correctedAt: NOW, correctedBy: ADMIN }),
  )],
  ['DENY', 'identity: the applicant deletes it', {
    request: request(WHO.ana, 'delete', IDENTITY_PATH),
    resource: { data: storedIdentity() },
  }],
  ['DENY', 'identity: an admin deletes it from a browser', {
    request: request(WHO.admin, 'delete', IDENTITY_PATH),
    resource: { data: storedIdentity() },
  }],

  // ── private/home: create ─────────────────────────────────────────────────
  ['ALLOW', 'home: created in the same batch as the application, no pin', homeCreate(WHO.ana, home())],
  ['ALLOW', 'home: with a pin inside the area, precision exact', homeCreate(WHO.ana, home({ geo: PIN, precision: 'exact' }))],
  ['ALLOW', 'home: an address of exactly 5 characters', homeCreate(WHO.ana, home({ addressText: 'a'.repeat(5) }))],
  ['ALLOW', 'home: an address of exactly 300 characters', homeCreate(WHO.ana, home({ addressText: 'a'.repeat(300) }))],
  ['ALLOW', 'home: an empty reference', homeCreate(WHO.ana, home({ reference: '' }))],
  ['ALLOW', 'home: a reference of exactly 300 characters', homeCreate(WHO.ana, home({ reference: 'r'.repeat(300) }))],
  ['ALLOW', 'home: a pin on the south-west corner of the area', homeCreate(
    WHO.ana, home({ geo: { latitude: -17.75, longitude: -66.45 }, precision: 'exact' }),
  )],
  ['ALLOW', 'home: a pin on the north-east corner of the area', homeCreate(
    WHO.ana, home({ geo: { latitude: -17.15, longitude: -65.85 }, precision: 'exact' }),
  )],
  ['DENY', 'home: attached to an application that ALREADY exists', homeCreate(
    WHO.ana, home(), mockHomeCreate({ parentBefore: true }),
  )],
  ['DENY', 'home: without the application in the same batch', homeCreate(
    WHO.ana, home(), mockHomeCreate({ parentAfter: false }),
  )],
  ['DENY', "home: under ANOTHER user's application id", homeCreate(WHO.beto, home({ applicantUid: BETO }))],
  ['DENY', 'home: own id, but applicantUid names someone else', homeCreate(WHO.ana, home({ applicantUid: BETO }))],
  ['DENY', 'home: anonymous', homeCreate(null, home())],
  ['DENY', 'home: a second private document', homeCreate(WHO.ana, home(), mockHomeCreate(), `${APP_PATH}/private/work`)],
  ['DENY', 'home: an extra key', homeCreate(WHO.ana, home({ city: 'Cochabamba' }))],
  ['DENY', 'home: a missing key (reference)', homeCreate(WHO.ana, homeWithout('reference'))],
  ['DENY', 'home: a missing key (precision)', homeCreate(WHO.ana, homeWithout('precision'))],
  ['DENY', 'home: backdated createdAt', homeCreate(WHO.ana, home({ createdAt: EARLIER }))],
  ['DENY', 'home: an address of 4 characters', homeCreate(WHO.ana, home({ addressText: 'a'.repeat(4) }))],
  ['DENY', 'home: 4 characters padded with spaces (trimmed before counting)', homeCreate(
    WHO.ana, home({ addressText: '   abcd   ' }),
  )],
  ['DENY', 'home: an address of 301 characters', homeCreate(WHO.ana, home({ addressText: 'a'.repeat(301) }))],
  ['DENY', 'home: a reference of 301 characters', homeCreate(WHO.ana, home({ reference: 'r'.repeat(301) }))],
  ['DENY', 'home: the address sent as a number', homeCreate(WHO.ana, home({ addressText: 12345 }))],
  ['DENY', 'home: a pin past the SOUTH edge', homeCreate(
    WHO.ana, home({ geo: { latitude: -17.7501, longitude: -66.1 }, precision: 'exact' }),
  )],
  ['DENY', 'home: a pin past the NORTH edge', homeCreate(
    WHO.ana, home({ geo: { latitude: -17.1499, longitude: -66.1 }, precision: 'exact' }),
  )],
  ['DENY', 'home: a pin past the WEST edge', homeCreate(
    WHO.ana, home({ geo: { latitude: -17.4, longitude: -66.4501 }, precision: 'exact' }),
  )],
  ['DENY', 'home: a pin past the EAST edge', homeCreate(
    WHO.ana, home({ geo: { latitude: -17.4, longitude: -65.8499 }, precision: 'exact' }),
  )],
  ['DENY', 'home: a pin with a null precision', homeCreate(WHO.ana, home({ geo: PIN, precision: null }))],
  ['DENY', "home: no pin, but precision 'exact'", homeCreate(WHO.ana, home({ geo: null, precision: 'exact' }))],
  ['DENY', "home: a pin with precision 'approx'", homeCreate(WHO.ana, home({ geo: PIN, precision: 'approx' }))],
  ['DENY', 'home: geo is not a latlng (a {lat, lng} map)', homeCreate(
    WHO.ana, home({ geo: { lat: -17.39, lng: -66.15 }, precision: 'exact' }),
  )],
  ['DENY', 'home: geo is a string', homeCreate(WHO.ana, home({ geo: '-17.39,-66.15', precision: 'exact' }))],

  // ── private/home: read ───────────────────────────────────────────────────
  ['ALLOW', 'home: the applicant reads their own', {
    request: request(WHO.ana, 'get', HOME_PATH),
    resource: { data: storedHome() },
  }],
  ['DENY', 'home: ANOTHER USER reads it', {
    request: request(WHO.beto, 'get', HOME_PATH),
    resource: { data: storedHome() },
  }],
  ['DENY', "home: another user reads a home naming THEM, under someone else's id", {
    request: request(WHO.beto, 'get', HOME_PATH),
    resource: { data: storedHome({ applicantUid: BETO }) },
  }],
  ['DENY', 'home: anonymous reads it', {
    request: request(null, 'get', HOME_PATH),
    resource: { data: storedHome() },
  }],
  ['ALLOW', 'home: an admin reads it', {
    request: request(WHO.admin, 'get', HOME_PATH),
    resource: { data: storedHome() },
  }],
  ['ALLOW', 'home: an admin lists private documents', {
    request: request(WHO.admin, 'list', `${APP_PATH}/private/any`),
    resource: { data: storedHome() },
  }],
  ['DENY', 'home: the applicant lists private documents', {
    request: request(WHO.ana, 'list', `${APP_PATH}/private/any`),
    resource: { data: storedHome() },
  }],

  // ── private/home: update and delete ──────────────────────────────────────
  ['DENY', 'home: the APPLICANT edits their own address', homeUpdate(
    WHO.ana, storedHome(), storedHome({ addressText: 'Otra calle 456' }),
  )],
  ['DENY', 'home: the applicant edits it, even attributing the correction to themselves', homeUpdate(
    WHO.ana, storedHome(), storedHome({ addressText: 'Otra calle 456', correctedAt: NOW, correctedBy: ANA }),
  )],
  ['DENY', 'home: the applicant deletes it', {
    request: request(WHO.ana, 'delete', HOME_PATH),
    resource: { data: storedHome() },
  }],
  ['DENY', 'home: an admin deletes it from a browser', {
    request: request(WHO.admin, 'delete', HOME_PATH),
    resource: { data: storedHome() },
  }],
  ['ALLOW', 'home: an admin corrects the address, attributed', homeUpdate(
    WHO.admin, storedHome(), storedHome({ addressText: 'Calle Sucre 125, zona Central', ...CORRECTED }),
  )],
  ['ALLOW', 'home: an admin adds a pin inside the area', homeUpdate(
    WHO.admin, storedHome(), storedHome({ geo: PIN, precision: 'exact', ...CORRECTED }),
  )],
  ['DENY', 'home: an admin correction without correctedBy', homeUpdate(
    WHO.admin, storedHome(), storedHome({ addressText: 'Calle Sucre 125', correctedAt: NOW }),
  )],
  ['DENY', 'home: an admin correction attributed to someone else', homeUpdate(
    WHO.admin, storedHome(), storedHome({ addressText: 'Calle Sucre 125', correctedAt: NOW, correctedBy: BETO }),
  )],
  ['DENY', 'home: an admin correction moves the pin outside the area', homeUpdate(
    WHO.admin, storedHome(), storedHome({ geo: { latitude: -16.5, longitude: -68.15 }, precision: 'exact', ...CORRECTED }),
  )],
  ['DENY', 'home: an admin correction rewrites applicantUid', homeUpdate(
    WHO.admin, storedHome(), storedHome({ applicantUid: BETO, ...CORRECTED }),
  )],
  ['DENY', 'home: an admin correction to a 4-character address', homeUpdate(
    WHO.admin, storedHome(), storedHome({ addressText: 'abcd', ...CORRECTED }),
  )],

  // ── the five portion-4a fields are frozen for every browser ──────────────
  ['DENY', 'frozen: applicant withdraws AND rewrites contractVersion', update(
    WHO.ana, stored(), stored({ status: 'withdrawn', withdrawnAt: NOW, updatedAt: NOW, contractVersion: '2001-01-01' }),
  )],
  ['DENY', 'frozen: applicant withdraws AND marks the ID received', update(
    WHO.ana, stored(), stored({ status: 'withdrawn', withdrawnAt: NOW, updatedAt: NOW, idDocument: { front: RECEIVED } }),
  )],
  ['DENY', 'frozen: admin moves to review AND sets the ID marker', update(
    WHO.admin, stored(), stored({ status: 'reviewing', updatedAt: NOW, idDocument: { front: RECEIVED } }),
  )],
  ['DENY', 'frozen: admin moves to review AND sets identityErasedAt', update(
    WHO.admin, stored(), stored({ status: 'reviewing', updatedAt: NOW, identityErasedAt: NOW }),
  )],
  ['DENY', 'frozen: admin moves to review AND rewrites termsAcceptedAt', update(
    WHO.admin, stored(), stored({ status: 'reviewing', updatedAt: NOW, termsAcceptedAt: NOW }),
  )],
  ['DENY', 'frozen: admin moves to review AND rewrites contractSha256', update(
    WHO.admin, stored(), stored({ status: 'reviewing', updatedAt: NOW, contractSha256: OTHER_SHA }),
  )],
  ['DENY', 'frozen: admin APPROVES and marks the ID received in the same write', update(
    WHO.admin,
    stored({ status: 'interview' }),
    stored({ status: 'approved', updatedAt: NOW, decidedAt: NOW, decidedBy: ADMIN, idDocument: { front: RECEIVED } }),
    mockAfter(),
  )],

  // ── no approval without the recorded consent (2026-10-17) ────────────────
  ['DENY', 'approve: the consent audit trail (private/acceptance) was never recorded', update(
    WHO.admin,
    storedWithId(),
    storedWithId({ status: 'approved', updatedAt: NOW, decidedAt: NOW, decidedBy: ADMIN }),
    mockAfter({ acceptance: false }),
  )],

  // ── no approval without a received ID ────────────────────────────────────
  ['DENY', 'approve: the ID photo has NOT been received (front null)', update(
    WHO.admin,
    stored({ status: 'interview' }),
    stored({ status: 'approved', updatedAt: NOW, decidedAt: NOW, decidedBy: ADMIN }),
    mockAfter(),
  )],
  ['DENY', 'approve: the front marker is `false`, not a received map', update(
    WHO.admin,
    stored({ status: 'interview', idDocument: { front: false } }),
    stored({ status: 'approved', updatedAt: NOW, decidedAt: NOW, decidedBy: ADMIN, idDocument: { front: false } }),
    mockAfter(),
  )],
  ['DENY', 'approve: an application from before the ID marker existed', update(
    WHO.admin,
    (() => { const d = stored({ status: 'interview' }); delete d.idDocument; return d; })(),
    (() => { const d = stored({ status: 'approved', updatedAt: NOW, decidedAt: NOW, decidedBy: ADMIN }); delete d.idDocument; return d; })(),
    mockAfter(),
  )],
  ['ALLOW', 'withdraw: still succeeds with every portion-4a field present', update(
    WHO.ana, storedWithId(), storedWithId({ status: 'withdrawn', withdrawnAt: NOW, updatedAt: NOW }),
  )],
  ['ALLOW', 'admin: rejects an application that has an ID, attributed', update(
    WHO.admin, storedWithId({ status: 'reviewing' }), storedWithId({ status: 'rejected', updatedAt: NOW, decidedAt: NOW, decidedBy: ADMIN }),
  )],

  // ── create ────────────────────────────────────────────────────────────────
  ['ALLOW', 'create: applicant applies for an available pet', {
    request: request(WHO.ana, 'create', APP_PATH, created()),
    functionMocks: mockCreate('available'),
  }],
  ['ALLOW', 'create: an unverified email is recorded as unverified, not refused', {
    request: request(WHO.anaUnverified, 'create', APP_PATH, created({ applicantEmailVerified: false })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'create: anonymous', {
    request: request(null, 'create', APP_PATH, created()),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'create: under ANOTHER user\'s id', {
    request: request(WHO.beto, 'create', APP_PATH, created({ applicantUid: BETO, applicantEmail: 'beto@example.com' })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'create: own id but applicantUid names someone else', {
    request: request(WHO.ana, 'create', APP_PATH, created({ applicantUid: BETO })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'create: id names a different pet than petId', {
    request: request(WHO.ana, 'create', `/adoptionApplications/petOther__${ANA}`, created()),
    functionMocks: mockCreate('available', { appId: `petOther__${ANA}` }),
  }],
  // Everything else here is satisfied: the id equals petId + '__' + uid, the pet
  // exists and is available, the home is in the batch. ONLY ownApplicationId()
  // (the id splits into three parts) refuses it.
  ['DENY', 'create: an id with an extra separator (only ownApplicationId() refuses it)', {
    request: request(WHO.ana, 'create', `/adoptionApplications/a__${PET}__${ANA}`, created({ petId: `a__${PET}` })),
    functionMocks: mockCreate('available', { appId: `a__${PET}__${ANA}`, petId: `a__${PET}` }),
  }],
  ['DENY', 'create: SELF-ESCALATING status to approved', {
    request: request(WHO.ana, 'create', APP_PATH, created({ status: 'approved' })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'create: applicant WRITES decidedBy', {
    request: request(WHO.ana, 'create', APP_PATH, created({ decidedBy: ANA })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'create: applicant writes decidedAt', {
    request: request(WHO.ana, 'create', APP_PATH, created({ decidedAt: NOW })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'create: applicant writes internalNotes onto the application', {
    request: request(WHO.ana, 'create', APP_PATH, { ...created(), internalNotes: 'buena familia' }),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'create: a required field missing', {
    request: request(WHO.ana, 'create', APP_PATH, (() => { const d = created(); delete d.withdrawnAt; return d; })()),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'create: backdated submittedAt', {
    request: request(WHO.ana, 'create', APP_PATH, created({ submittedAt: EARLIER })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'create: email that is not the token\'s', {
    request: request(WHO.ana, 'create', APP_PATH, created({ applicantEmail: 'otra@example.com' })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'create: claims a verified email the token says is not', {
    request: request(WHO.anaUnverified, 'create', APP_PATH, created({ applicantEmailVerified: true })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'create: pet not available (shelter)', {
    request: request(WHO.ana, 'create', APP_PATH, created()),
    functionMocks: mockCreate('shelter'),
  }],
  ['DENY', 'create: pet already adopted', {
    request: request(WHO.ana, 'create', APP_PATH, created()),
    functionMocks: mockCreate('adopted'),
  }],
  ['DENY', 'create: pet does not exist', {
    request: request(WHO.ana, 'create', APP_PATH, created()),
    functionMocks: mockCreate(null),
  }],
  ['DENY', 'create: an answer under an unknown key', {
    request: request(WHO.ana, 'create', APP_PATH, created({ answers: { ...ANSWERS, idNumber: '1234567' } })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'create: an answer under the RETIRED zone key (removed in portion 4a)', {
    request: request(WHO.ana, 'create', APP_PATH, created({ answers: { ...ANSWERS, zone: 'Sarco' } })),
    functionMocks: mockCreate('available'),
  }],
  // The rules cannot see a question's kind, so these bound ANY answer key:
  // a string of at most 1500, a whole number 0..99, or a boolean.
  ['ALLOW', 'create: an answer exactly at the 1500-character bound', {
    request: request(WHO.ana, 'create', APP_PATH, created({ answers: { ...ANSWERS, fullName: 'a'.repeat(1500) } })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'create: an answer over the 1500-character bound', {
    request: request(WHO.ana, 'create', APP_PATH, created({ answers: { ...ANSWERS, fullName: 'a'.repeat(1501) } })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'create: a nested map as an answer', {
    request: request(WHO.ana, 'create', APP_PATH, created({ answers: { ...ANSWERS, movingSoon: { street: 'x' } } })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'create: an explicit null answer', {
    request: request(WHO.ana, 'create', APP_PATH, created({ answers: { ...ANSWERS, movingSoon: null } })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'create: a number above 99', {
    request: request(WHO.ana, 'create', APP_PATH, created({ answers: { ...ANSWERS, movingSoon: 100 } })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'create: a negative number', {
    request: request(WHO.ana, 'create', APP_PATH, created({ answers: { ...ANSWERS, movingSoon: -1 } })),
    functionMocks: mockCreate('available'),
  }],
  ['ALLOW', 'create: the optional "amurallado" left out (an apartment is never asked it)', {
    request: request(WHO.ana, 'create', APP_PATH, created({
      answers: { fullName: 'Ana Pérez', whatsapp: '+591 7000 0000', housingType: 'apartment', housingTenure: 'owned', movingSoon: true },
    })),
    functionMocks: mockCreate('available'),
  }],
  ['DENY', 'duplicate: a second submission over an existing application is an UPDATE and is refused', update(
    WHO.ana,
    stored({ status: 'reviewing' }),
    created({ answers: { ...ANSWERS, fullName: 'otra vez' } }),
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
    WHO.ana, stored(), stored({ status: 'withdrawn', withdrawnAt: NOW, updatedAt: NOW, answers: { ...ANSWERS, fullName: 'otra' } }),
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
    WHO.admin, storedWithId(), storedWithId({ status: 'approved', updatedAt: NOW, decidedAt: NOW, decidedBy: ADMIN }), mockAfter(),
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
    WHO.admin, stored({ status: 'reviewing' }), stored({ status: 'interview', updatedAt: NOW, answers: { ...ANSWERS, fullName: 'Otra persona' } }),
  )],
  ['DENY', 'admin: a same-status write', update(
    WHO.admin, stored({ status: 'reviewing' }), stored({ status: 'reviewing', updatedAt: NOW }),
  )],
  // Every approval case below starts from an application WITH the ID received,
  // so each DENY is caused by the batch condition it names and not by the
  // missing marker. The marker's own cases are in the portion-4a block above.
  ['ALLOW', 'approve: in ONE batch with the adoption and the pet status, ID received', update(
    WHO.admin,
    storedWithId({ status: 'interview' }),
    storedWithId({ status: 'approved', updatedAt: NOW, decidedAt: NOW, decidedBy: ADMIN }),
    mockAfter(),
  )],
  ['DENY', 'approve: without writing adoptions/{petId} in the batch', update(
    WHO.admin,
    storedWithId({ status: 'interview' }),
    storedWithId({ status: 'approved', updatedAt: NOW, decidedAt: NOW, decidedBy: ADMIN }),
    mockAfter({ adoptionExists: false }),
  )],
  ['DENY', 'approve: the adoption names someone other than the applicant', update(
    WHO.admin,
    storedWithId({ status: 'interview' }),
    storedWithId({ status: 'approved', updatedAt: NOW, decidedAt: NOW, decidedBy: ADMIN }),
    mockAfter({ ownerUid: BETO }),
  )],
  ['DENY', 'approve: the adoption is linked to a different application', update(
    WHO.admin,
    storedWithId({ status: 'interview' }),
    storedWithId({ status: 'approved', updatedAt: NOW, decidedAt: NOW, decidedBy: ADMIN }),
    mockAfter({ applicationId: `${PET}__${BETO}` }),
  )],
  ['DENY', 'approve: the pet ALREADY belonged to a family before the batch', update(
    WHO.admin,
    storedWithId({ status: 'interview' }),
    storedWithId({ status: 'approved', updatedAt: NOW, decidedAt: NOW, decidedBy: ADMIN }),
    mockAfter({ petStatusBefore: 'adopted' }),
  )],
  ['ALLOW', 'approve: a returned animal (shelter again) can be adopted anew', update(
    WHO.admin,
    storedWithId({ status: 'reviewing' }),
    storedWithId({ status: 'approved', updatedAt: NOW, decidedAt: NOW, decidedBy: ADMIN }),
    mockAfter({ petStatusBefore: 'shelter' }),
  )],
  ['DENY', 'approve: the pet is not set to adopted in the batch', update(
    WHO.admin,
    storedWithId({ status: 'interview' }),
    storedWithId({ status: 'approved', updatedAt: NOW, decidedAt: NOW, decidedBy: ADMIN }),
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

  // ── re-admission ends ownership ──────────────────────────────────────────
  // reopenPet() deletes adoptions/{petId} in its batch. The first case is that
  // delete; the rest are the former owner afterwards, when exists() on the
  // adoption answers false. (Mocked here. Against the DEPLOYED rules the same
  // revocation was measured live: "after the adoption is removed: former owner
  // reads the microchip" → DENY, probe-application-rules.mjs, 11/11.)
  ['ALLOW', 'readmission: admin deletes adoptions/{petId} in the re-admission batch', {
    request: request(WHO.admin, 'delete', `/adoptions/${PET}`),
    resource: { data: { petId: PET, ownerUid: ANA, applicationId: APP } },
  }],
  ['DENY', 'readmission: the owner deletes their own adoption', {
    request: request(WHO.ana, 'delete', `/adoptions/${PET}`),
    resource: { data: { petId: PET, ownerUid: ANA, applicationId: APP } },
  }],
  ['ALLOW', 'readmission: BEFORE it, the owner reads location/current', {
    request: request(WHO.ana, 'get', `/pets/${PET}/location/current`),
    resource: { data: { address: 'x' } },
    functionMocks: mockOwner(ANA),
  }],
  ['DENY', 'readmission: the FORMER OWNER reads the microchip after re-admission', {
    request: request(WHO.ana, 'get', `/pets/${PET}/identity/microchip`),
    resource: { data: { code: '068000000000001' } },
    functionMocks: mockOwner(null),
  }],
  ['DENY', 'readmission: the former owner reads location/current after re-admission', {
    request: request(WHO.ana, 'get', `/pets/${PET}/location/current`),
    resource: { data: { address: 'x' } },
    functionMocks: mockOwner(null),
  }],
  ['DENY', 'readmission: the former owner reads scans after re-admission', {
    request: request(WHO.ana, 'get', `/pets/${PET}/scans/s1`),
    resource: { data: { context: 'intake' } },
    functionMocks: mockOwner(null),
  }],
  ['DENY', 'readmission: the former owner reads custody after re-admission', {
    request: request(WHO.ana, 'get', `/pets/${PET}/custody/c1`),
    resource: { data: { kind: 'adopter', holderUid: ANA } },
    functionMocks: mockOwner(null),
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

// Lint: a create on /adoptionApplications/{id} must mock BOTH private documents
// of THAT id, or the case is denied by a missing mock and not by its own rule.
// A create on /adoptionApplications/{id}/private/{doc} must mock the parent
// before and after the batch, for the same reason.
for (const [, name, body] of cases) {
  const path = body.request?.path?.replace(DB, '') ?? '';
  if (body.request?.method !== 'create') continue;
  const mocked = (fn, exactValue) =>
    (body.functionMocks ?? []).some((f) => f.function === fn && f.args?.[0]?.exactValue === exactValue);
  const parent = /^\/adoptionApplications\/([^/]+)$/.exec(path);
  if (parent) {
    for (const doc of ['home', 'identity']) {
      if (!mocked('existsAfter', `${DB}/adoptionApplications/${parent[1]}/private/${doc}`)) {
        console.error(`case "${name}" writes ${parent[1]} but mocks no existsAfter for its own private/${doc}`);
        process.exit(2);
      }
    }
  }
  const child = /^\/adoptionApplications\/([^/]+)\/private\/[^/]+$/.exec(path);
  if (child) {
    const want = `${DB}/adoptionApplications/${child[1]}`;
    if (!mocked('exists', want) || !mocked('existsAfter', want)) {
      console.error(`case "${name}" writes under ${child[1]}/private but mocks no exists/existsAfter for that parent`);
      process.exit(2);
    }
  }
}

// The SHIPPED_FILE cases prove the file AS SHIPPED only if it ships switched on
// (2026-10-17: they were "inert while off" cases before the switch-on).
if (!SHIPPED_SWITCH_ON && selected.some(([, , , options]) => options?.switch === 'shipped')) {
  console.error(`${rulesPath} ships with applicationsEnabled() not returning true — the SHIPPED FILE cases would prove nothing`);
  process.exit(2);
}

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const client = await auth.getClient();

const CHUNK = 25;
let failures = 0;
let passed = 0;

console.log(`rules: ${rulesPath}`);
console.log(`project: ${project} (projects.test — nothing is released)\n`);

// Force applicationsEnabled() to a known value in a copy. Exactly one
// definition must be found, or the variants would silently equal the file.
const SWITCH_PATTERN = /function applicationsEnabled\(\) \{\s*return (?:true|false);\s*\}/g;
function withSwitch(content, on) {
  const found = content.match(SWITCH_PATTERN) ?? [];
  if (found.length !== 1) {
    console.error(`expected exactly one applicationsEnabled() in ${rulesPath}, found ${found.length}`);
    process.exit(2);
  }
  return content.replace(SWITCH_PATTERN, `function applicationsEnabled() {\n        return ${on};\n      }`);
}

// Force acceptedContracts() the same way: exactly one definition returning a
// map literal, replaced by the test pair or by `{}`.
const CONTRACTS_PATTERN = /function acceptedContracts\(\) \{\s*return \{[^{}]*\};\s*\}/g;
function withContracts(content, mapLiteral) {
  const found = content.match(CONTRACTS_PATTERN) ?? [];
  if (found.length !== 1) {
    console.error(`expected exactly one acceptedContracts() in ${rulesPath}, found ${found.length}`);
    process.exit(2);
  }
  return content.replace(CONTRACTS_PATTERN, `function acceptedContracts() {\n        return ${mapLiteral};\n      }`);
}
const CONTRACT_MAPS = {
  test: `{'${TEST_CONTRACT.version}': '${TEST_CONTRACT.sha256}'}`,
  empty: '{}',
};

// `shipped` leaves that function exactly as the file has it.
const variantKey = (options) => `${options?.switch ?? 'on'}/${options?.contracts ?? 'test'}`;
const variantSource = (key) => {
  const [sw, contracts] = key.split('/');
  const switched = sw === 'shipped' ? source : withSwitch(source, sw === 'on');
  return contracts === 'shipped' ? switched : withContracts(switched, CONTRACT_MAPS[contracts]);
};

const work = [];
const keys = [...new Set(selected.map(([, , , options]) => variantKey(options)))];
for (const key of keys) {
  const content = variantSource(key);
  const inVariant = selected.filter(([, , , options]) => variantKey(options) === key);
  for (let i = 0; i < inVariant.length; i += CHUNK) {
    work.push({ content, chunk: inVariant.slice(i, i + CHUNK) });
  }
}

for (const { content, chunk } of work) {
  let data;
  try {
    const res = await client.request({
      url: `https://firebaserules.googleapis.com/v1/projects/${project}:test`,
      method: 'POST',
      headers: { 'x-goog-user-project': project },
      data: {
        source: { files: [{ name: 'firestore.rules', content }] },
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

  const results = data.testResults ?? [];
  if (results.length !== chunk.length) {
    // An empty or short list must never read as "nothing failed".
    console.error(`API returned ${results.length} results for ${chunk.length} cases`);
    failures += Math.max(chunk.length - results.length, 1);
  }

  results.forEach((result, j) => {
    const entry = chunk[j];
    if (!entry) return;
    const [expectation, name] = entry;
    const debug = (result.debugMessages ?? []).join('\n');
    // A DENY must come from a rule. A "Service call error" means a get()/exists()
    // had no mock, which denies for the wrong reason and proves nothing.
    // Measured: an UNMOCKED get()/exists() surfaces as "Function not found
    // error" on this API; "Service call error" is the other spelling.
    const wrongReason = expectation === 'DENY' && /Service call error|Function not found/i.test(debug);
    if (result.state === 'SUCCESS' && !wrongReason) {
      passed += 1;
      console.log(`ok     ${expectation.padEnd(5)} ${name}`);
    } else {
      failures += 1;
      console.log(`FAIL   ${expectation.padEnd(5)} ${name}`);
      if (wrongReason) console.log('         denied by a missing function mock (Service call error), not by a rule');
      for (const message of result.debugMessages ?? []) console.log(`         ${message}`);
      if (result.errorPosition) console.log(`         error at line ${result.errorPosition.line}`);
    }
  });
}

console.log(`\n${passed} passed, ${failures} failed, ${selected.length} cases`);
if (passed + failures !== selected.length) {
  console.error(`accounting mismatch: ${passed} + ${failures} != ${selected.length}`);
  process.exit(1);
}
process.exit(failures === 0 ? 0 : 1);
