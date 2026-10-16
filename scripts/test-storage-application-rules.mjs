/**
 * Evaluate storage.rules for the adoption ID-photo prefix, `adoption-ids/**`,
 * with the Firebase Rules TEST API. Nothing is released and nothing is
 * written: `projects.test` compiles the source and runs the cases in
 * isolation, so this is safe before a `npm run deploy:storage-rules` — which is
 * the point of it.
 *
 *   GOOGLE_CLOUD_PROJECT=wawitas node scripts/test-storage-application-rules.mjs
 *   ... --rules path/to/edited.rules   evaluate a different file (break probes)
 *
 * ── What it checks ─────────────────────────────────────────────────────────
 *   - an admin may GET and LIST an ID photo;
 *   - the applicant whose id names the folder, another signed-in account, an
 *     account whose claim is the string "true", and a signed-out visitor are
 *     all DENIED both;
 *   - EVERY create, update and delete is DENIED — admins included, because the
 *     only writer is the upload route through the Admin SDK, which bypasses
 *     these rules;
 *   - a path one level deeper or shallower than `adoption-ids/{id}/{file}`
 *     matches nothing and falls to the catch-all deny.
 *
 * ── CONTROLS RUN FIRST, and gate everything else ───────────────────────────
 * A probe whose request shape the API misreads denies everything, and a suite
 * of mostly-DENY expectations would then pass while proving nothing. So four
 * controls on rules this change does not touch run first — a public pet photo
 * readable signed out, `medical/**` denied signed out, `medical/**` ALLOWED to
 * an admin (the admin token shape works), a private intake photo ALLOWED to a
 * signed-in account (the user token shape works) — and if any of them is not
 * as expected the script stops with exit 2 before judging a single real case.
 *
 * ── What it CANNOT show ────────────────────────────────────────────────────
 * - A real LIST. This API refuses a prefix path ending in `/` ("invalid
 *   argument", MEASURED 2026-10-16) and evaluates `list` only at a CHILD path,
 *   `adoption-ids/{id}/{name}`. The cases prove the predicate a list meets.
 * - That the rules are DEPLOYED. `npm run deploy:storage-rules` does that, and
 *   the release pointer must be read back afterwards.
 * - Download tokens. A token bypasses these rules entirely; that no token is
 *   ever minted is the upload route's and the viewer's job (guard tests).
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

// The bucket comes from firebase.json, like scripts/release-storage-rules.mjs.
const BUCKET = JSON.parse(readFileSync(join(REPO_ROOT, 'firebase.json'), 'utf8')).storage?.bucket;
if (!BUCKET) {
  console.error('firebase.json has no storage.bucket.');
  process.exit(2);
}

const rulesPath = resolve(flag('--rules') ?? join(REPO_ROOT, 'storage.rules'));
const source = readFileSync(rulesPath, 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — a valid-shaped application id: {petId}__{uid}
// ─────────────────────────────────────────────────────────────────────────────

const APPLICANT_UID = 'ProbeApplicant1';
const APPLICATION = `probePet01__${APPLICANT_UID}`;
const PHOTO = `adoption-ids/${APPLICATION}/front.jpg`;
const BACK = `adoption-ids/${APPLICATION}/back.jpg`;

// A real non-admin ID token has NO `admin` field, and reading a missing token
// field is an error, which denies. One account below carries `admin: false`
// so at least one DENY comes from the comparison rather than from that error.
const APPLICANT = { uid: APPLICANT_UID, token: { email: 'probe-applicant@example.com', email_verified: true } };
const APPLICANT_FALSE_CLAIM = { uid: APPLICANT_UID, token: { email: 'probe-applicant@example.com', admin: false } };
const OTHER = { uid: 'ProbeOther02', token: { email: 'probe-other@example.com' } };
const STRING_CLAIM = { uid: 'ProbeOther03', token: { email: 'probe-string@example.com', admin: 'true' } };
const ADMIN = { uid: 'ProbeAdmin9', token: { email: 'probe-admin@example.com', admin: true } };

const object = (name) => `/b/${BUCKET}/o/${name}`;
const jpeg = (name, over = {}) => ({ name, bucket: BUCKET, size: 600_000, contentType: 'image/jpeg', ...over });

const get = (auth, name) => ({ ...(auth ? { auth } : {}), method: 'get', path: object(name) });
// A list is only accepted at a child path — see the header.
const list = (auth, name) => ({ ...(auth ? { auth } : {}), method: 'list', path: object(name) });
const write = (auth, method, name) => ({
  ...(auth ? { auth } : {}),
  method,
  path: object(name),
  ...(method === 'delete' ? {} : { resource: jpeg(name) }),
});

/** [expectation, name, request] */
const CONTROLS = [
  ['ALLOW', 'CONTROL: signed out reads a public pet photo', get(null, 'pets/probePet01/cover.jpg')],
  ['DENY', 'CONTROL: signed out reads a medical scan', get(null, 'medical/probePet01/card.jpg')],
  ['ALLOW', 'CONTROL: an admin reads a medical scan (the admin token shape works)', get(ADMIN, 'medical/probePet01/card.jpg')],
  ['ALLOW', 'CONTROL: a signed-in account reads a private intake photo (the user token shape works)', get(OTHER, 'pets/probePet01/private/0123abcd.jpg')],
];

const CASES = [
  // read
  ['ALLOW', 'admin gets the front', get(ADMIN, PHOTO)],
  ['ALLOW', 'admin gets the back', get(ADMIN, BACK)],
  ['ALLOW', 'admin lists the application folder', list(ADMIN, PHOTO)],
  ['DENY', 'the applicant gets their own photo', get(APPLICANT, PHOTO)],
  ['DENY', 'the applicant gets their own photo (admin: false in the token)', get(APPLICANT_FALSE_CLAIM, PHOTO)],
  ['DENY', 'the applicant lists their own folder', list(APPLICANT, PHOTO)],
  ['DENY', 'another signed-in account gets it', get(OTHER, PHOTO)],
  ['DENY', 'another signed-in account lists it', list(OTHER, PHOTO)],
  ['DENY', 'a claim of the STRING "true" gets it', get(STRING_CLAIM, PHOTO)],
  ['DENY', 'signed out gets it', get(null, PHOTO)],
  ['DENY', 'signed out lists it', list(null, PHOTO)],

  // write — nobody, through these rules
  ['DENY', 'the applicant uploads their own photo', write(APPLICANT, 'create', PHOTO)],
  ['DENY', 'the applicant overwrites their own photo', write(APPLICANT, 'update', PHOTO)],
  ['DENY', 'the applicant deletes their own photo', write(APPLICANT, 'delete', PHOTO)],
  ['DENY', 'admin uploads a photo', write(ADMIN, 'create', PHOTO)],
  ['DENY', 'admin overwrites a photo', write(ADMIN, 'update', PHOTO)],
  ['DENY', 'admin deletes a photo (erasure is the Admin SDK’s)', write(ADMIN, 'delete', PHOTO)],
  ['DENY', 'another account uploads into the folder', write(OTHER, 'create', PHOTO)],
  ['DENY', 'signed out uploads', write(null, 'create', PHOTO)],
  ['DENY', 'signed out deletes', write(null, 'delete', PHOTO)],

  // shape — nothing deeper or shallower matches
  ['DENY', 'admin gets a nested path (no rule matches; catch-all)', get(ADMIN, `adoption-ids/${APPLICATION}/sub/front.jpg`)],
  ['DENY', 'admin gets a file directly under adoption-ids/', get(ADMIN, 'adoption-ids/front.jpg')],
];

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const client = await auth.getClient();

async function evaluate(cases) {
  let data;
  try {
    const res = await client.request({
      url: `https://firebaserules.googleapis.com/v1/projects/${project}:test`,
      method: 'POST',
      headers: { 'x-goog-user-project': project },
      data: {
        source: { files: [{ name: 'storage.rules', content: source }] },
        testSuite: { testCases: cases.map(([expectation, , request]) => ({ expectation, request })) },
      },
    });
    data = res.data;
  } catch (error) {
    // Never print the error object itself: gaxios errors carry the request,
    // and the request carries the whole rules file.
    console.error('Rules API call failed:', error?.response?.status, JSON.stringify(error?.response?.data?.error?.message ?? error?.message));
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
  if (results.length !== cases.length) {
    console.error(`API returned ${results.length} results for ${cases.length} cases`);
    process.exit(2);
  }

  let passed = 0;
  let failed = 0;
  results.forEach((result, i) => {
    const [expectation, name] = cases[i];
    const debug = (result.debugMessages ?? []).join(' | ');
    // A missing function mock denies for the wrong reason and proves nothing.
    const wrongReason = expectation === 'DENY' && /Function not found|Service call error/i.test(debug);
    if (result.state === 'SUCCESS' && !wrongReason) {
      passed += 1;
      console.log(`ok     ${expectation.padEnd(5)} ${name}`);
    } else {
      failed += 1;
      console.log(`FAIL   ${expectation.padEnd(5)} ${name}`);
      if (wrongReason) console.log('         denied by a missing mock, not by a rule');
      if (debug) console.log(`         ${debug}`);
    }
  });
  return { passed, failed };
}

console.log(`rules: ${rulesPath}`);
console.log(`bucket: ${BUCKET}`);
console.log(`project: ${project} (projects.test — nothing is released)\n`);

console.log('── controls ──');
const controls = await evaluate(CONTROLS);
if (controls.failed > 0) {
  console.error(`\n${controls.failed} control(s) not as expected: the request shape is wrong, so no other result would mean anything.`);
  process.exit(2);
}

console.log('\n── adoption-ids/** ──');
const cases = await evaluate(CASES);

const total = CONTROLS.length + CASES.length;
const passed = controls.passed + cases.passed;
console.log(`\n${passed}/${total} as expected (${CONTROLS.length} controls + ${CASES.length} cases)`);
process.exit(cases.failed === 0 ? 0 : 1);
