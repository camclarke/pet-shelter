/**
 * Test the ROLE conditions in firestore.rules WITHOUT deploying them.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * Roles (the role-based access plan of 2026-10-22) change who passes
 * `isAdmin()` and add narrower conditions for rescuers and event staff. None of
 * that is released when this runs: the Rules `:test` endpoint compiles the
 * LOCAL firestore.rules, evaluates every case server-side, and releases
 * nothing. Same harness as `rules-test-events.mjs`.
 *
 * ── Where the expectations come from ──────────────────────────────────────
 * Not from this file. Every ALLOW/DENY below is computed by `dataAllows()` in
 * `src/config/roles.ts` — the same table the panel reads — from the persona's
 * claims and the facts of the case (whose draft, linked to the register or
 * not, event ended or not). A rule and the matrix that disagree therefore fail
 * here, by name, whichever of the two is wrong.
 *
 * A few cases carry a fixed expectation, each for a reason the matrix does not
 * model: a PUBLISHED event is readable by anyone and deletable by no one;
 * every write that breaks the document shape is denied whoever sends it.
 *
 * ── Personas ──────────────────────────────────────────────────────────────
 * anonymous, a signed-in account with no role, rescuer A, rescuer B, event
 * staff, a rescuer who is also event staff, coordination (`admin`), the shelter
 * owner, the superuser, Tesorería alone, with coordination and with the
 * superuser — plus two near-misses that must grant nothing: the STRING "true"
 * as a claim, and every role explicitly `false`. Donation details
 * (`donationSettings/current` and its `pending` and `history`) are covered
 * for every persona, on every verb.
 *
 * ── What it CANNOT check ──────────────────────────────────────────────────
 * A real `list` QUERY. The test API evaluates one hypothetical document, not a
 * query, so a rescuer's `where('createdBy', '==', uid)` list is modelled as a
 * list whose candidate document is their own. After the rules are released,
 * a REST `:runQuery` as a rescuer with that constraint should answer 200 and
 * one without it 403.
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=wawitas node --import tsx scripts/rules-test-roles.mjs
 *   ... --rules path/to/other.rules   test an edited copy (break-probing)
 *   ... --verbose                     print every case, and visited expressions on failure
 *
 * Exits 0 when every case meets its expectation, 1 when one does not, 2 when
 * the harness itself could not run (the controls failed, or the API refused).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { GoogleAuth } from 'google-auth-library';

import { COORDINATOR_PLUS, dataAllows, hasAnyRole, publicCanRead, rolesFromClaims } from '../src/config/roles.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const rulesArg = args.indexOf('--rules');
const rulesPath = rulesArg >= 0 ? resolve(args[rulesArg + 1]) : join(REPO_ROOT, 'firestore.rules');
const verbose = args.includes('--verbose');

const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
if (!project) {
  console.error('GOOGLE_CLOUD_PROJECT is not set. Refusing to guess which project to bill.');
  process.exit(2);
}

const DOCS = '/databases/(default)/documents';
const TIME = '2026-10-15T12:00:00Z';
const EARLIER = '2026-10-14T12:00:00Z';
// An upcoming fair, 31 October 2026, 15:00–19:00 La Paz (UTC−4).
const UP_STARTS = '2026-10-31T19:00:00Z';
const UP_ENDS = '2026-10-31T23:00:00Z';
// One that ended on 1 October.
const PAST_STARTS = '2026-10-01T19:00:00Z';
const PAST_ENDS = '2026-10-01T23:00:00Z';
// Edges of "ended": exactly now is not ended, one second earlier is.
const NOW_EDGE_STARTS = '2026-10-15T10:00:00Z';
const ONE_SECOND_AGO = '2026-10-15T11:59:59Z';

const PET = 'nightprobe-roles-pet';
const DRAFT = 'nightprobe-roles-draft';
const EVENT = 'nightprobe-roles-feria-2026-10-31';

// ── personas ────────────────────────────────────────────────────────────────
const persona = (name, uid, claims) => ({
  name,
  auth: uid ? { uid, token: claims } : null,
  uid: uid ?? null,
  roles: rolesFromClaims(uid ? claims : null),
});

const ANON = persona('anonymous', null, {});
const USER = persona('signed-in, no role', 'nightprobe-roles-user', {});
const RESCUER_A = persona('rescuer A', 'nightprobe-roles-rescuer-a', { rescuer: true });
const RESCUER_B = persona('rescuer B', 'nightprobe-roles-rescuer-b', { rescuer: true });
const EVENTS = persona('event staff', 'nightprobe-roles-events', { events: true });
const RESCUER_EVENTS = persona('rescuer + event staff', 'nightprobe-roles-both', { rescuer: true, events: true });
const ADMIN = persona('coordination (admin)', 'nightprobe-roles-admin', { admin: true });
const OWNER = persona('shelter owner', 'nightprobe-roles-owner', { owner: true });
const SU = persona('superuser', 'nightprobe-roles-su', { su: true });
// Tesorería (2026-10-24): donation details only. Alone, with coordination
// (must still be refused nothing coordination has, and gain nothing beyond
// donations), and with su.
const FINANCE = persona('Tesorería (finance)', 'nightprobe-roles-finance', { finance: true });
const FINANCE_ADMIN = persona('Tesorería + coordination', 'nightprobe-roles-finance-admin', { finance: true, admin: true });
const FINANCE_SU = persona('Tesorería + superuser', 'nightprobe-roles-finance-su', { finance: true, su: true });
const STRING_CLAIMS = persona('every role as the STRING "true"', 'nightprobe-roles-string', {
  su: 'true', owner: 'true', admin: 'true', finance: 'true', rescuer: 'true', events: 'true',
});
const FALSE_CLAIMS = persona('every role explicitly false', 'nightprobe-roles-false', {
  su: false, owner: false, admin: false, finance: false, rescuer: false, events: false,
});

const PERSONAS = [
  ANON, USER, RESCUER_A, RESCUER_B, EVENTS, RESCUER_EVENTS, ADMIN, OWNER, SU,
  FINANCE, FINANCE_ADMIN, FINANCE_SU, STRING_CLAIMS, FALSE_CLAIMS,
];

// The near-miss personas must grant nothing in the matrix too, or the
// expectations below would be computed from a wrong premise.
for (const p of [STRING_CLAIMS, FALSE_CLAIMS, USER, ANON]) {
  if (Object.values(p.roles).some(Boolean)) {
    console.error(`persona "${p.name}" reads as holding a role — rolesFromClaims is wrong, nothing below would mean anything`);
    process.exit(2);
  }
}

const expect = (allowed) => (allowed ? 'ALLOW' : 'DENY');

function req(method, who, path, newData) {
  const request = { method, path, time: TIME };
  if (who.auth) request.auth = who.auth;
  if (newData !== undefined) request.resource = { data: newData };
  return request;
}

/** [name, expectation, request, stored data | undefined] */
const CASES = [];
const add = (name, allowed, request, stored) => CASES.push([name, expect(allowed), request, stored]);

// ── controls: rules deployed and proven since 2026-08-23, untouched here ──
const CONTROLS = [
  ['CONTROL anonymous get pets/{id} is allowed', 'ALLOW', req('get', ANON, `${DOCS}/pets/${PET}`), { status: 'shelter' }],
  ['CONTROL anonymous create pets/{id} is denied', 'DENY', req('create', ANON, `${DOCS}/pets/${PET}`, { name: 'x' })],
  ['CONTROL the old admin token shape still opens areas', 'ALLOW', req('get', ADMIN, `${DOCS}/areas/a1`), { name: 'Cuarentena 1' }],
];

// ─────────────────────────────────────────────────────────────────────────────
// petDrafts
// ─────────────────────────────────────────────────────────────────────────────

const draftPath = `${DOCS}/petDrafts/${DRAFT}`;
const REGISTER = { no: 17, linkConfidence: 'confirmed' };
/** The shape the wizard writes, cut to what the rules read plus two fields. */
const draftDoc = (createdBy, over = {}) => ({
  id: DRAFT,
  name: 'Luna',
  status: 'shelter',
  register: null,
  ...(createdBy === undefined ? {} : { createdBy }),
  ...over,
});

for (const p of PERSONAS) {
  const ownA = p.uid === RESCUER_A.uid;
  const tag = `[${p.name}]`;

  // read — a draft rescuer A created
  add(`${tag} get rescuer A's draft`, dataAllows('petDrafts', 'read', p.roles, { own: ownA }),
    req('get', p, draftPath), draftDoc(RESCUER_A.uid));
  add(`${tag} list, candidate rescuer A's draft`, dataAllows('petDrafts', 'read', p.roles, { own: ownA }),
    req('list', p, draftPath), draftDoc(RESCUER_A.uid));
  add(`${tag} get rescuer A's REGISTER-LINKED draft`, dataAllows('petDrafts', 'read', p.roles, { own: ownA }),
    req('get', p, draftPath), draftDoc(RESCUER_A.uid, { register: REGISTER }));
  // A draft from before roles: no createdBy at all.
  add(`${tag} get a legacy draft with no createdBy`, dataAllows('petDrafts', 'read', p.roles, { own: false }),
    req('get', p, draftPath), draftDoc(undefined));
  add(`${tag} list, candidate a legacy draft`, dataAllows('petDrafts', 'read', p.roles, { own: false }),
    req('list', p, draftPath), draftDoc(undefined));

  // create — as the caller
  add(`${tag} create a draft as themselves`, dataAllows('petDrafts', 'create', p.roles, { own: p.uid !== null }),
    req('create', p, draftPath, draftDoc(p.uid)));
  add(`${tag} create a draft attributed to someone else`, dataAllows('petDrafts', 'create', p.roles, { own: false }),
    req('create', p, draftPath, draftDoc(RESCUER_B.uid === p.uid ? RESCUER_A.uid : RESCUER_B.uid)));
  add(`${tag} create a draft with no createdBy`, dataAllows('petDrafts', 'create', p.roles, { own: false }),
    req('create', p, draftPath, draftDoc(undefined)));
  add(`${tag} create a draft as themselves, LINKED to the register`,
    dataAllows('petDrafts', 'create', p.roles, { own: p.uid !== null, touchesRegister: true }),
    req('create', p, draftPath, draftDoc(p.uid, { register: REGISTER })));

  // update — rescuer A's draft
  add(`${tag} update rescuer A's draft (name, readyForReview)`,
    dataAllows('petDrafts', 'update', p.roles, { own: ownA }),
    req('update', p, draftPath, draftDoc(RESCUER_A.uid, { name: 'Nube', readyForReview: true })), draftDoc(RESCUER_A.uid));
  add(`${tag} update rescuer A's draft, handing createdBy to rescuer B`,
    dataAllows('petDrafts', 'update', p.roles, { own: false }),
    req('update', p, draftPath, draftDoc(RESCUER_B.uid)), draftDoc(RESCUER_A.uid));
  add(`${tag} update rescuer A's draft, removing createdBy`,
    dataAllows('petDrafts', 'update', p.roles, { own: false }),
    req('update', p, draftPath, draftDoc(undefined)), draftDoc(RESCUER_A.uid));
  add(`${tag} update rescuer A's draft, ADDING a register link`,
    dataAllows('petDrafts', 'update', p.roles, { own: ownA, touchesRegister: true }),
    req('update', p, draftPath, draftDoc(RESCUER_A.uid, { register: REGISTER })), draftDoc(RESCUER_A.uid));
  add(`${tag} update rescuer A's linked draft, keeping the link`,
    dataAllows('petDrafts', 'update', p.roles, { own: ownA }),
    req('update', p, draftPath, draftDoc(RESCUER_A.uid, { register: REGISTER, name: 'Nube' })),
    draftDoc(RESCUER_A.uid, { register: REGISTER }));
  add(`${tag} update rescuer A's linked draft, REMOVING the link`,
    dataAllows('petDrafts', 'update', p.roles, { own: ownA, touchesRegister: true }),
    req('update', p, draftPath, draftDoc(RESCUER_A.uid)), draftDoc(RESCUER_A.uid, { register: REGISTER }));
  add(`${tag} update a legacy draft, claiming it`,
    dataAllows('petDrafts', 'update', p.roles, { own: false }),
    req('update', p, draftPath, draftDoc(p.uid ?? RESCUER_A.uid)), draftDoc(undefined));

  // delete
  add(`${tag} delete rescuer A's draft`, dataAllows('petDrafts', 'delete', p.roles, { own: ownA }),
    req('delete', p, draftPath), draftDoc(RESCUER_A.uid));
  add(`${tag} delete rescuer A's REGISTER-LINKED draft`,
    dataAllows('petDrafts', 'delete', p.roles, { own: ownA, touchesRegister: true }),
    req('delete', p, draftPath), draftDoc(RESCUER_A.uid, { register: REGISTER }));
  add(`${tag} delete a legacy draft`, dataAllows('petDrafts', 'delete', p.roles, { own: false }),
    req('delete', p, draftPath), draftDoc(undefined));
}

// ─────────────────────────────────────────────────────────────────────────────
// publishing and medical records: coordination only
// ─────────────────────────────────────────────────────────────────────────────

const PUBLISH_PATHS = [
  ['pets/{id}', `${DOCS}/pets/${PET}`, { name: 'Luna', status: 'available' }],
  ['pets/{id}/detail/main', `${DOCS}/pets/${PET}/detail/main`, { story: '' }],
  ['pets/{id}/media/{m}', `${DOCS}/pets/${PET}/media/m1`, { tier: 'public', path: 'pets/x/m1.jpg' }],
  ['pets/{id}/identity/microchip', `${DOCS}/pets/${PET}/identity/microchip`, { code: '068000000000042' }],
];
for (const p of PERSONAS) {
  for (const [label, path, data] of PUBLISH_PATHS) {
    add(`[${p.name}] create ${label} (publish)`, dataAllows('publish', 'create', p.roles), req('create', p, path, data));
  }
  add(`[${p.name}] update pets/{id} (status)`, dataAllows('publish', 'update', p.roles),
    req('update', p, `${DOCS}/pets/${PET}`, { name: 'Luna', status: 'adopted' }), { name: 'Luna', status: 'available' });
  add(`[${p.name}] create a medical record`, dataAllows('medical', 'create', p.roles),
    req('create', p, `${DOCS}/pets/${PET}/medical/r1`, { kind: 'vaccination', name: 'Antirrábica' }));
  add(`[${p.name}] delete a medical record`, dataAllows('medical', 'delete', p.roles),
    req('delete', p, `${DOCS}/pets/${PET}/medical/r1`), { kind: 'vaccination' });
  // Unchanged collections follow isAdmin(): coordination or higher.
  add(`[${p.name}] read areas`, hasAnyRole(p.roles, COORDINATOR_PLUS),
    req('get', p, `${DOCS}/areas/a1`), { name: 'Cuarentena 1' });
  add(`[${p.name}] update a register row`, hasAnyRole(p.roles, COORDINATOR_PLUS),
    req('update', p, `${DOCS}/registerEntries/17`, { no: 17, petId: PET }), { no: 17, petId: null });
  add(`[${p.name}] the identity collection group`, hasAnyRole(p.roles, COORDINATOR_PLUS),
    req('list', p, `${DOCS}/pets/${PET}/identity/microchip`), { code: '068000000000042' });
}

// ─────────────────────────────────────────────────────────────────────────────
// events
// ─────────────────────────────────────────────────────────────────────────────

const eventPath = `${DOCS}/events/${EVENT}`;
const event = (by, over = {}) => ({
  title: 'Feria de adopción',
  description: 'Ven a conocer a los animalitos.',
  startsAt: UP_STARTS,
  endsAt: UP_ENDS,
  allDay: false,
  placeName: 'Plaza Colón',
  address: null,
  status: 'scheduled',
  published: false,
  createdAt: TIME,
  createdBy: by,
  updatedAt: TIME,
  updatedBy: by,
  ...over,
});
const PAST = { startsAt: PAST_STARTS, endsAt: PAST_ENDS };
/** Stored: written earlier by coordination. */
const storedEvent = (over = {}) => event(ADMIN.uid, { createdAt: EARLIER, updatedAt: EARLIER, ...over });
/** An update as the client sends it: the merged doc, re-stamped by the caller. */
const updatedEvent = (p, over = {}) => event(ADMIN.uid, { createdAt: EARLIER, updatedAt: TIME, updatedBy: p.uid, ...over });

for (const p of PERSONAS) {
  const tag = `[${p.name}]`;
  const readDraft = (ended) => dataAllows('events', 'read', p.roles, { ended });

  // read
  add(`${tag} get an upcoming DRAFT event`, readDraft(false), req('get', p, eventPath), storedEvent());
  add(`${tag} get a past DRAFT event`, readDraft(true), req('get', p, eventPath), storedEvent(PAST));
  add(`${tag} list, candidate a draft`, readDraft(false), req('list', p, eventPath), storedEvent());
  add(`${tag} get a PUBLISHED event (public, whoever asks)`, true, req('get', p, eventPath), storedEvent({ published: true }));
  add(`${tag} get a MISSING event id`, readDraft(false), req('get', p, eventPath));

  // create — attributed to the caller
  add(`${tag} create an upcoming draft`, dataAllows('events', 'create', p.roles, { ended: false }),
    req('create', p, eventPath, event(p.uid)));
  add(`${tag} create a draft that already ended`, dataAllows('events', 'create', p.roles, { ended: true }),
    req('create', p, eventPath, event(p.uid, PAST)));
  add(`${tag} create a draft ending exactly now (not ended)`, dataAllows('events', 'create', p.roles, { ended: false }),
    req('create', p, eventPath, event(p.uid, { startsAt: NOW_EDGE_STARTS, endsAt: TIME })));
  add(`${tag} create a draft that ended one second ago`, dataAllows('events', 'create', p.roles, { ended: true }),
    req('create', p, eventPath, event(p.uid, { startsAt: NOW_EDGE_STARTS, endsAt: ONE_SECOND_AGO })));
  // Shape: refused whoever sends it.
  add(`${tag} create an upcoming draft attributed to someone else`, false,
    req('create', p, eventPath, event(p.uid === ADMIN.uid ? OWNER.uid : ADMIN.uid)));
  // createdBy alone wrong, updatedBy the caller: isolates the createdBy check
  // from validEvent's updatedBy check (a break probe found the case above
  // could not tell them apart).
  add(`${tag} create an upcoming draft with ONLY createdBy someone else`, false,
    req('create', p, eventPath, event(p.uid, { createdBy: 'nightprobe-roles-someone-else' })));
  add(`${tag} create an upcoming event already published`, false,
    req('create', p, eventPath, event(p.uid, { published: true })));

  // update
  add(`${tag} edit the title of an upcoming event`, dataAllows('events', 'update', p.roles, { ended: false }),
    req('update', p, eventPath, updatedEvent(p, { title: 'Feria navideña' })), storedEvent());
  add(`${tag} publish an upcoming event`, dataAllows('events', 'update', p.roles, { ended: false }),
    req('update', p, eventPath, updatedEvent(p, { published: true })), storedEvent());
  add(`${tag} cancel a published upcoming event`, dataAllows('events', 'update', p.roles, { ended: false }),
    req('update', p, eventPath, updatedEvent(p, { published: true, status: 'cancelled' })), storedEvent({ published: true }));
  add(`${tag} fix a typo on a PAST event`, dataAllows('events', 'update', p.roles, { ended: true }),
    req('update', p, eventPath, updatedEvent(p, { ...PAST, title: 'Feria de adopción!' })), storedEvent(PAST));
  add(`${tag} move an upcoming event INTO the past`, dataAllows('events', 'update', p.roles, { ended: true }),
    req('update', p, eventPath, updatedEvent(p, PAST)), storedEvent());
  add(`${tag} move a past event into the future`, dataAllows('events', 'update', p.roles, { ended: true }),
    req('update', p, eventPath, updatedEvent(p)), storedEvent(PAST));
  add(`${tag} update an upcoming event, changing createdBy`, false,
    req('update', p, eventPath, updatedEvent(p, { createdBy: 'nightprobe-roles-someone-else' })), storedEvent());

  // delete
  add(`${tag} delete an upcoming DRAFT`, dataAllows('events', 'delete', p.roles, { ended: false }),
    req('delete', p, eventPath), storedEvent());
  add(`${tag} delete a past DRAFT`, dataAllows('events', 'delete', p.roles, { ended: true }),
    req('delete', p, eventPath), storedEvent(PAST));
  add(`${tag} delete a PUBLISHED upcoming event (nobody: hide it first)`, false,
    req('delete', p, eventPath), storedEvent({ published: true }));
  // A missing doc: coordination gets a no-op (rules-test-events.mjs pins it);
  // event staff are refused, because their rule reads the stored endsAt.
  add(`${tag} delete a MISSING event`, hasAnyRole(p.roles, COORDINATOR_PLUS), req('delete', p, eventPath));
}

// ─────────────────────────────────────────────────────────────────────────────
// roleAudit — the grant script's log
// ─────────────────────────────────────────────────────────────────────────────

const auditPath = `${DOCS}/roleAudit/nightprobe-audit-1`;
const auditEntry = { action: 'grant', role: 'rescuer', targetUid: RESCUER_A.uid, at: EARLIER };
for (const p of PERSONAS) {
  add(`[${p.name}] get a roleAudit entry`, dataAllows('roleAudit', 'read', p.roles), req('get', p, auditPath), auditEntry);
  add(`[${p.name}] list roleAudit`, dataAllows('roleAudit', 'read', p.roles), req('list', p, auditPath), auditEntry);
  add(`[${p.name}] create a roleAudit entry`, dataAllows('roleAudit', 'create', p.roles), req('create', p, auditPath, auditEntry));
  add(`[${p.name}] edit a roleAudit entry`, dataAllows('roleAudit', 'update', p.roles),
    req('update', p, auditPath, { ...auditEntry, action: 'revoke' }), auditEntry);
  add(`[${p.name}] delete a roleAudit entry`, dataAllows('roleAudit', 'delete', p.roles), req('delete', p, auditPath), auditEntry);
}

// ─────────────────────────────────────────────────────────────────────────────
// donationSettings — current (public), pending and history (Tesorería + su)
// ─────────────────────────────────────────────────────────────────────────────
//
// Expectations: a read is allowed when the resource is public
// (`publicCanRead`) or the matrix grants it to the persona's roles; every
// write is whatever the matrix says, which for donations is NOTHING — only the
// routes write, through the Admin SDK. The owner and coordination are
// deliberately DENIED pending and history.

// Fixture data only — never a real account.
const METHOD = {
  kind: 'bank', bankName: 'Banco de Prueba', accountHolder: 'Titular de Prueba', accountNumber: '0000000000',
  accountType: 'caja de ahorro', currency: 'BOB', note: '',
};
const DONATION_DOCS = [
  ['donationCurrent', 'donationSettings/current', `${DOCS}/donationSettings/current`,
    { methods: [METHOD], version: 1, updatedAt: EARLIER, active: true, qrPath: null, qrExpiresAt: null }],
  ['donationPending', 'donationSettings/current/pending/{id}', `${DOCS}/donationSettings/current/pending/nightprobe-p1`,
    { proposedBy: FINANCE.uid, status: 'pending', proposal: { methods: [METHOD], active: true, qrExpiresAt: null, qrAction: 'keep' }, qrPath: null }],
  ['donationHistory', 'donationSettings/current/history/{id}', `${DOCS}/donationSettings/current/history/v000001`,
    { kind: 'confirmed', pendingId: 'nightprobe-p1', version: 1, proposedBy: FINANCE.uid, decidedBy: SU.uid }],
];
for (const p of PERSONAS) {
  const tag = `[${p.name}]`;
  for (const [resource, label, path, data] of DONATION_DOCS) {
    const canRead = publicCanRead(resource) || dataAllows(resource, 'read', p.roles);
    add(`${tag} get ${label}`, canRead, req('get', p, path), data);
    add(`${tag} list ${label}`, canRead, req('list', p, path), data);
    add(`${tag} get a MISSING ${label}`, canRead, req('get', p, path));
    add(`${tag} create ${label}`, dataAllows(resource, 'create', p.roles), req('create', p, path, data));
    add(`${tag} update ${label}`, dataAllows(resource, 'update', p.roles),
      req('update', p, path, { ...data, active: false }), data);
    add(`${tag} delete ${label}`, dataAllows(resource, 'delete', p.roles), req('delete', p, path), data);
  }
  // A path under donationSettings that is not one of the three is default-denied.
  add(`${tag} get donationSettings/other`, false, req('get', p, `${DOCS}/donationSettings/other`), { x: 1 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

const source = readFileSync(rulesPath, 'utf8');
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const client = await auth.getClient();

/** The API caps a suite's size, so the cases go in chunks. */
const CHUNK = 200;

async function evaluate(cases) {
  const results = [];
  for (let i = 0; i < cases.length; i += CHUNK) {
    const chunk = cases.slice(i, i + CHUNK);
    let response;
    try {
      response = await client.request({
        url: `https://firebaserules.googleapis.com/v1/projects/${project}:test`,
        method: 'POST',
        headers: { 'x-goog-user-project': project },
        data: {
          source: { files: [{ name: 'firestore.rules', content: source }] },
          testSuite: {
            // A case with no stored doc sends `resource: null` EXPLICITLY, or
            // the API errors on any expression mentioning `resource`.
            testCases: chunk.map(([, expectation, request, stored]) => ({
              expectation,
              request,
              resource: stored === undefined ? null : { data: stored },
              expressionReportLevel: verbose ? 'VISITED' : 'NONE',
            })),
          },
        },
      });
    } catch (err) {
      // Never print the error object: it carries the request, and the request
      // carries the whole rules file.
      console.error('Rules test API call failed:', err?.response?.status, JSON.stringify(err?.response?.data?.error?.message ?? err.message));
      process.exit(2);
    }
    const { testResults = [], issues = [] } = response.data;
    const errors = issues.filter((issue) => issue.severity === 'ERROR');
    for (const issue of errors) {
      console.error(`RULES DO NOT COMPILE: ${issue.description} at line ${issue.sourcePosition?.line}`);
    }
    if (errors.length > 0) process.exit(1);
    if (testResults.length !== chunk.length) {
      console.error(`expected ${chunk.length} results, got ${testResults.length} — refusing to call that a pass`);
      process.exit(2);
    }
    results.push(...testResults);
  }
  return results;
}

function report(cases, results) {
  let failures = 0;
  let allow = 0;
  let deny = 0;
  results.forEach((result, i) => {
    const [name, expectation] = cases[i];
    const ok = result.state === 'SUCCESS';
    if (expectation === 'ALLOW') allow++;
    else deny++;
    if (!ok) failures++;
    if (!ok || verbose) console.log(`${ok ? 'ok    ' : 'FAILED'}  [${expectation}] ${name}`);
    if (!ok) {
      for (const message of result.debugMessages ?? []) console.log(`          debug: ${message}`);
      if (result.errorPosition) console.log(`          error at line ${result.errorPosition.line}`);
      if (verbose && result.visitedExpressions) {
        for (const v of result.visitedExpressions) {
          console.log(`          line ${v.sourcePosition?.line}:${v.sourcePosition?.column} → ${JSON.stringify(v.value)}`);
        }
      }
    }
  });
  return { failures, allow, deny };
}

console.log(`rules: ${rulesPath}`);
console.log(`project: ${project} (projects:test — nothing is released)\n`);

const controlResults = await evaluate(CONTROLS);
const controls = report(CONTROLS, controlResults);
if (controls.failures > 0) {
  console.error(`\n${controls.failures} control(s) not as expected: the request shape is wrong, so no other result would mean anything.`);
  process.exit(2);
}
console.log(`controls: ${CONTROLS.length}/${CONTROLS.length}`);

const results = await evaluate(CASES);
const { failures, allow, deny } = report(CASES, results);

console.log(
  `\n${CASES.length - failures}/${CASES.length} cases met their expectation ` +
    `(${allow} ALLOW, ${deny} DENY; ${PERSONAS.length} personas; plus ${CONTROLS.length} controls)`,
);
process.exit(failures === 0 ? 0 : 1);
