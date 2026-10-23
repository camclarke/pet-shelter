/**
 * Test the ROLE conditions in storage.rules — pet photos — WITHOUT deploying.
 *
 * The Storage counterpart of `rules-test-roles.mjs`: the Rules `:test`
 * endpoint compiles the LOCAL storage.rules and releases nothing.
 *
 * ── What it checks ────────────────────────────────────────────────────────
 * On `pets/{petId}/{file}` and `pets/{petId}/private/{file}`, for every
 * persona: create with the caller's own `uploadedBy` metadata, with someone
 * else's, with none; overwrite (update); delete of an own upload 1 hour old,
 * exactly 24 hours old and 25 hours old, of someone else's recent upload, and
 * of one with no metadata; plus reads. The shape limits (image only, under
 * 8 MB) are checked for the rescuer AND for coordination, whose rule they
 * also bound.
 *
 * Expectations come from `dataAllows('petPhotos', …)` in
 * `src/config/roles.ts`, except reads (public / signed-in, unchanged by roles)
 * and the shape cases, which are denied whoever sends them.
 *
 * ── Encoding ──────────────────────────────────────────────────────────────
 * `request.resource` is the incoming object; the test case's top-level
 * `resource` is the object as stored, which a delete reads. Custom metadata
 * is `metadata: { uploadedBy }`; `timeCreated` is an ISO-8601 timestamp.
 * Controls on untouched rules run first and gate the rest; an ALLOW on a
 * rescuer delete is itself proof that `resource.metadata` and `timeCreated`
 * reached the rule, because without them the rule errors and denies.
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=wawitas node --import tsx scripts/rules-test-storage-roles.mjs
 *   ... --rules path/to/edited.rules   test an edited copy (break-probing)
 *   ... --verbose                      print every case
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { GoogleAuth } from 'google-auth-library';

import { dataAllows, rolesFromClaims } from '../src/config/roles.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const verbose = args.includes('--verbose');

const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
if (!project) {
  console.error('GOOGLE_CLOUD_PROJECT is not set. Refusing to guess.');
  process.exit(2);
}

// The bucket comes from firebase.json, like scripts/release-storage-rules.mjs.
const BUCKET = JSON.parse(readFileSync(join(REPO_ROOT, 'firebase.json'), 'utf8')).storage?.bucket;
if (!BUCKET) {
  console.error('firebase.json has no storage.bucket.');
  process.exit(2);
}

const rulesPath = resolve(flag('--rules') ?? join(REPO_ROOT, 'storage.rules'));
const source = readFileSync(rulesPath, 'utf8');

const TIME = '2026-10-15T12:00:00Z';
const ONE_HOUR_AGO = '2026-10-15T11:00:00Z';
const EXACTLY_24H_AGO = '2026-10-14T12:00:00Z';
const JUST_UNDER_24H_AGO = '2026-10-14T12:00:01Z';
const TWENTY_FIVE_HOURS_AGO = '2026-10-14T11:00:00Z';

const persona = (name, uid, claims) => ({
  name,
  auth: uid ? { uid, token: claims } : null,
  uid: uid ?? null,
  roles: rolesFromClaims(uid ? claims : null),
});

const ANON = persona('anonymous', null, {});
const USER = persona('signed-in, no role', 'ProbeRolesUser', {});
const RESCUER_A = persona('rescuer A', 'ProbeRolesRescuerA', { rescuer: true });
const RESCUER_B = persona('rescuer B', 'ProbeRolesRescuerB', { rescuer: true });
const EVENTS = persona('event staff', 'ProbeRolesEvents', { events: true });
const RESCUER_EVENTS = persona('rescuer + event staff', 'ProbeRolesBoth', { rescuer: true, events: true });
const ADMIN = persona('coordination (admin)', 'ProbeRolesAdmin', { admin: true });
const OWNER = persona('shelter owner', 'ProbeRolesOwner', { owner: true });
const SU = persona('superuser', 'ProbeRolesSu', { su: true });
const STRING_CLAIMS = persona('every role as the STRING "true"', 'ProbeRolesString', {
  su: 'true', owner: 'true', admin: 'true', rescuer: 'true', events: 'true',
});

const PERSONAS = [ANON, USER, RESCUER_A, RESCUER_B, EVENTS, RESCUER_EVENTS, ADMIN, OWNER, SU, STRING_CLAIMS];

const object = (name) => `/b/${BUCKET}/o/${name}`;
const jpeg = (name, over = {}) => ({ name, bucket: BUCKET, size: 600_000, contentType: 'image/jpeg', ...over });
const withUploader = (uid) => (uid ? { metadata: { uploadedBy: uid } } : {});

function request(method, who, name, incoming) {
  const r = { method, path: object(name), time: TIME };
  if (who.auth) r.auth = who.auth;
  if (incoming) r.resource = incoming;
  return r;
}

/** [expectation, name, request, stored object | undefined] */
const CONTROLS = [
  ['ALLOW', 'CONTROL: signed out reads a public pet photo', request('get', ANON, 'pets/probePet01/cover.jpg'), jpeg('pets/probePet01/cover.jpg')],
  ['DENY', 'CONTROL: signed out reads a medical scan', request('get', ANON, 'medical/probePet01/card.jpg'), jpeg('medical/probePet01/card.jpg')],
  ['ALLOW', 'CONTROL: the old admin token shape reads a medical scan', request('get', ADMIN, 'medical/probePet01/card.jpg'), jpeg('medical/probePet01/card.jpg')],
  ['DENY', 'CONTROL: signed out uploads a pet photo', request('create', ANON, 'pets/probePet01/x.jpg', jpeg('pets/probePet01/x.jpg')), undefined],
];

const CASES = [];
const add = (allowed, name, req, stored) => CASES.push([allowed ? 'ALLOW' : 'DENY', name, req, stored]);

const FOLDERS = [
  ['public', 'pets/probePet01/0123abcd.jpg'],
  ['private', 'pets/probePet01/private/0123abcd.jpg'],
];

for (const [folder, file] of FOLDERS) {
  for (const p of PERSONAS) {
    const tag = `[${p.name}] ${folder}:`;
    const other = p.uid === RESCUER_B.uid ? RESCUER_A.uid : RESCUER_B.uid;
    const allows = (verb, facts) => dataAllows('petPhotos', verb, p.roles, facts);

    // reads — unchanged by roles
    add(folder === 'public' || p.uid !== null, `${tag} read`, request('get', p, file), jpeg(file, withUploader(RESCUER_A.uid)));

    // create
    add(allows('create', { own: p.uid !== null }), `${tag} upload stamped with their own uid`,
      request('create', p, file, jpeg(file, withUploader(p.uid))));
    add(allows('create', { own: false }), `${tag} upload stamped with someone else's uid`,
      request('create', p, file, jpeg(file, withUploader(other))));
    add(allows('create', { own: false }), `${tag} upload with no metadata`,
      request('create', p, file, jpeg(file)));
    // Shape — refused whoever sends it.
    add(false, `${tag} upload a PDF stamped with their own uid`,
      request('create', p, file, jpeg(file, { contentType: 'application/pdf', ...withUploader(p.uid) })));
    add(false, `${tag} upload 8 MB stamped with their own uid`,
      request('create', p, file, jpeg(file, { size: 8 * 1024 * 1024, ...withUploader(p.uid) })));

    // update — overwrite
    add(allows('update', { own: true }), `${tag} overwrite their own upload`,
      request('update', p, file, jpeg(file, withUploader(p.uid))), jpeg(file, { ...withUploader(p.uid), timeCreated: ONE_HOUR_AGO }));

    // delete
    const stored = (uid, at) => jpeg(file, { ...withUploader(uid), timeCreated: at });
    add(allows('delete', { own: p.uid !== null, recent: true }), `${tag} delete their own upload, 1 h old`,
      request('delete', p, file), stored(p.uid, ONE_HOUR_AGO));
    add(allows('delete', { own: p.uid !== null, recent: true }), `${tag} delete their own upload, 23:59:59 old`,
      request('delete', p, file), stored(p.uid, JUST_UNDER_24H_AGO));
    add(allows('delete', { own: p.uid !== null, recent: false }), `${tag} delete their own upload, exactly 24 h old`,
      request('delete', p, file), stored(p.uid, EXACTLY_24H_AGO));
    add(allows('delete', { own: p.uid !== null, recent: false }), `${tag} delete their own upload, 25 h old`,
      request('delete', p, file), stored(p.uid, TWENTY_FIVE_HOURS_AGO));
    add(allows('delete', { own: false, recent: true }), `${tag} delete someone else's upload, 1 h old`,
      request('delete', p, file), stored(other, ONE_HOUR_AGO));
    add(allows('delete', { own: false, recent: true }), `${tag} delete an upload with no metadata, 1 h old`,
      request('delete', p, file), jpeg(file, { timeCreated: ONE_HOUR_AGO }));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const client = await auth.getClient();

/** The API caps a suite's size, so the cases go in chunks. */
const CHUNK = 100;

async function evaluate(cases) {
  const totals = { failed: 0, allow: 0, deny: 0 };
  for (let i = 0; i < cases.length; i += CHUNK) {
    const part = await evaluateChunk(cases.slice(i, i + CHUNK));
    totals.failed += part.failed;
    totals.allow += part.allow;
    totals.deny += part.deny;
  }
  return totals;
}

async function evaluateChunk(cases) {
  let data;
  try {
    const res = await client.request({
      url: `https://firebaserules.googleapis.com/v1/projects/${project}:test`,
      method: 'POST',
      headers: { 'x-goog-user-project': project },
      data: {
        source: { files: [{ name: 'storage.rules', content: source }] },
        testSuite: {
          testCases: cases.map(([expectation, , req, stored]) => ({
            expectation,
            request: req,
            ...(stored === undefined ? {} : { resource: stored }),
          })),
        },
      },
    });
    data = res.data;
  } catch (error) {
    // Never print the error object: it carries the whole rules file.
    console.error('Rules API call failed:', error?.response?.status, JSON.stringify(error?.response?.data?.error?.message ?? error?.message));
    process.exit(2);
  }

  const errors = (data.issues ?? []).filter((issue) => issue.severity === 'ERROR');
  if (errors.length > 0) {
    for (const issue of errors) console.error(`RULES DO NOT COMPILE: ${issue.description} at line ${issue.sourcePosition?.line}`);
    process.exit(1);
  }
  const results = data.testResults ?? [];
  if (results.length !== cases.length) {
    console.error(`API returned ${results.length} results for ${cases.length} cases`);
    process.exit(2);
  }

  let failed = 0;
  let allow = 0;
  let deny = 0;
  results.forEach((result, i) => {
    const [expectation, name] = cases[i];
    if (expectation === 'ALLOW') allow++;
    else deny++;
    const debug = (result.debugMessages ?? []).join(' | ');
    // A missing function mock denies for the wrong reason and proves nothing.
    const wrongReason = expectation === 'DENY' && /Function not found|Service call error/i.test(debug);
    const ok = result.state === 'SUCCESS' && !wrongReason;
    if (!ok) failed++;
    if (!ok || verbose) console.log(`${ok ? 'ok    ' : 'FAILED'}  [${expectation}] ${name}`);
    if (!ok) {
      if (wrongReason) console.log('          denied by a missing mock, not by a rule');
      if (debug) console.log(`          ${debug}`);
    }
  });
  return { failed, allow, deny };
}

console.log(`rules: ${rulesPath}`);
console.log(`bucket: ${BUCKET}`);
console.log(`project: ${project} (projects:test — nothing is released)\n`);

const controls = await evaluate(CONTROLS);
if (controls.failed > 0) {
  console.error(`\n${controls.failed} control(s) not as expected: the request shape is wrong, so no other result would mean anything.`);
  process.exit(2);
}
console.log(`controls: ${CONTROLS.length}/${CONTROLS.length}`);

const { failed, allow, deny } = await evaluate(CASES);
console.log(
  `\n${CASES.length - failed}/${CASES.length} cases met their expectation ` +
    `(${allow} ALLOW, ${deny} DENY; ${PERSONAS.length} personas; plus ${CONTROLS.length} controls)`,
);
process.exit(failed === 0 ? 0 : 1);
