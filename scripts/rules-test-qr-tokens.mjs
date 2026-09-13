/**
 * Test the `qrTokens` block of firestore.rules WITHOUT deploying it.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * A client-SDK probe can only meet the rules that are RELEASED, and a new
 * collection's rules are not released until a human deploys them. Probing
 * `qrTokens` from a client today would meet default-deny on every branch and
 * "prove" nothing. The Firebase Rules `:test` endpoint evaluates an inline
 * `source` against inline test cases and releases nothing, so it can check
 * both the ALLOW and the DENY branch of a rule that has never shipped.
 *
 * ── What it checks ────────────────────────────────────────────────────────
 * The enumeration guard (public `get`, no public `list`), admin-only minting
 * in the exact written shape, one-way revocation, and delete refused to
 * everyone. Two CONTROL cases run first against the long-deployed `pets`
 * rule: if the request shape this script sends were wrong, those would fail
 * too, so a green run cannot be a harness that silently evaluates nothing.
 *
 * ── Two traps it handles ──────────────────────────────────────────────────
 *  - `x-goog-user-project` is required on every call. Without it, user
 *    credentials get a 403 "requires a quota project", which reads exactly
 *    like a permissions failure and is not one.
 *  - A timestamp in the test API's JSON is a STRING unless the rule compares
 *    it against `request.time`, which the service types as a timestamp. See
 *    `TIME` below for how the cases stay comparable.
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=wawitas node scripts/rules-test-qr-tokens.mjs
 *   ... --rules path/to/other.rules   test an edited copy (break-probing)
 *   ... --verbose                     print visited expressions on failure
 *
 * Exits non-zero if any case does not meet its expectation.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { GoogleAuth } from 'google-auth-library';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const rulesArg = args.indexOf('--rules');
const rulesPath = rulesArg >= 0 ? resolve(args[rulesArg + 1]) : join(REPO_ROOT, 'firestore.rules');
const verbose = args.includes('--verbose');

const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
if (!project) {
  throw new Error('GOOGLE_CLOUD_PROJECT is not set. Refusing to guess which project to bill.');
}

const DOCS = '/databases/(default)/documents';
const TIME = '2026-09-12T12:00:00Z';
const LATER = '2026-09-12T13:00:00Z';
const TOKEN = 'NP5S12QRTK'; // Crockford base32, 10 chars. Never written anywhere.
const PET = 'nightprobe-s12-pet';

const ADMIN = { uid: 'nightprobe-s12-admin', token: { admin: true } };
const USER = { uid: 'nightprobe-s12-user', token: {} };

const petExists = (value) => ({
  function: 'exists',
  args: [{ exactValue: `${DOCS}/pets/${PET}` }],
  result: { value },
});

const validToken = (over = {}) => ({
  petId: PET,
  revokedAt: null,
  createdAt: TIME,
  createdBy: ADMIN.uid,
  ...over,
});

function req(method, auth, path, newData) {
  const request = { method, path, time: TIME };
  if (auth) request.auth = auth;
  if (newData !== undefined) request.resource = { data: newData };
  return request;
}

const tokenPath = (id = TOKEN) => `${DOCS}/qrTokens/${id}`;

/** name → [expectation, request, existing resource data | undefined, functionMocks] */
const CASES = [
  // ── controls on a rule that has been deployed and proven since 2026-08-23 ──
  ['CONTROL anonymous get pets/{id} is allowed', 'ALLOW', req('get', null, `${DOCS}/pets/${PET}`), { status: 'shelter' }],
  ['CONTROL anonymous create pets/{id} is denied', 'DENY', req('create', null, `${DOCS}/pets/${PET}`, { name: 'x' })],

  // ── the enumeration guard ──
  ['anonymous get of a token is allowed', 'ALLOW', req('get', null, tokenPath()), validToken()],
  ['anonymous get of a revoked token is allowed', 'ALLOW', req('get', null, tokenPath()), validToken({ revokedAt: TIME })],
  ['anonymous LIST is denied', 'DENY', req('list', null, tokenPath())],
  ['signed-in non-admin LIST is denied', 'DENY', req('list', USER, tokenPath())],
  ['admin list is allowed', 'ALLOW', req('list', ADMIN, tokenPath())],

  // ── minting ──
  ['admin create in the written shape is allowed', 'ALLOW', req('create', ADMIN, tokenPath(), validToken()), undefined, [petExists(true)]],
  ['non-admin create is denied', 'DENY', req('create', USER, tokenPath(), validToken({ createdBy: USER.uid })), undefined, [petExists(true)]],
  ['anonymous create is denied', 'DENY', req('create', null, tokenPath(), validToken()), undefined, [petExists(true)]],
  ['admin create for a pet that does not exist is denied', 'DENY', req('create', ADMIN, tokenPath(), validToken()), undefined, [petExists(false)]],
  ['admin create with a lowercase id is denied', 'DENY', req('create', ADMIN, tokenPath('np5s12qrtk'), validToken()), undefined, [petExists(true)]],
  ['admin create with a confusable I in the id is denied', 'DENY', req('create', ADMIN, tokenPath('NP5S12QRTI'), validToken()), undefined, [petExists(true)]],
  ['admin create with a 9-character id is denied', 'DENY', req('create', ADMIN, tokenPath('NP5S12QRT'), validToken()), undefined, [petExists(true)]],
  ['admin create already revoked is denied', 'DENY', req('create', ADMIN, tokenPath(), validToken({ revokedAt: TIME })), undefined, [petExists(true)]],
  ['admin create with an extra field is denied', 'DENY', req('create', ADMIN, tokenPath(), validToken({ microchip: '068000000000042' })), undefined, [petExists(true)]],
  ['admin create missing revokedAt is denied', 'DENY', req('create', ADMIN, tokenPath(), { petId: PET, createdAt: TIME, createdBy: ADMIN.uid }), undefined, [petExists(true)]],
  ['admin create attributed to someone else is denied', 'DENY', req('create', ADMIN, tokenPath(), validToken({ createdBy: USER.uid })), undefined, [petExists(true)]],
  ['admin create with a client-chosen createdAt is denied', 'DENY', req('create', ADMIN, tokenPath(), validToken({ createdAt: LATER })), undefined, [petExists(true)]],

  // ── revocation ──
  ['admin revoke (null → request.time, revokedAt only) is allowed', 'ALLOW', req('update', ADMIN, tokenPath(), validToken({ revokedAt: TIME })), validToken()],
  ['admin UN-revoke is denied', 'DENY', req('update', ADMIN, tokenPath(), validToken()), validToken({ revokedAt: TIME })],
  ['admin re-revoke with a new date is denied', 'DENY', req('update', ADMIN, tokenPath(), validToken({ revokedAt: TIME })), validToken({ revokedAt: LATER })],
  ['non-admin revoke is denied', 'DENY', req('update', USER, tokenPath(), validToken({ revokedAt: TIME })), validToken()],
  ['admin revoke with a client-chosen date is denied', 'DENY', req('update', ADMIN, tokenPath(), validToken({ revokedAt: LATER })), validToken()],
  ['admin revoke that also moves the token to another pet is denied', 'DENY', req('update', ADMIN, tokenPath(), validToken({ revokedAt: TIME, petId: 'other' })), validToken()],
  ['admin update that moves an active token to another pet is denied', 'DENY', req('update', ADMIN, tokenPath(), validToken({ petId: 'other' })), validToken()],

  // ── delete ──
  ['admin delete is denied', 'DENY', req('delete', ADMIN, tokenPath()), validToken({ revokedAt: TIME })],
  ['anonymous delete is denied', 'DENY', req('delete', null, tokenPath()), validToken()],
];

const source = readFileSync(rulesPath, 'utf8');

const testCases = CASES.map(([, expectation, request, existing, functionMocks]) => {
  const testCase = { expectation, request, expressionReportLevel: verbose ? 'VISITED' : 'NONE' };
  if (existing !== undefined) testCase.resource = { data: existing };
  if (functionMocks) testCase.functionMocks = functionMocks;
  return testCase;
});

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const client = await auth.getClient();

let response;
try {
  response = await client.request({
    url: `https://firebaserules.googleapis.com/v1/projects/${project}:test`,
    method: 'POST',
    headers: { 'x-goog-user-project': project },
    data: {
      source: { files: [{ name: 'firestore.rules', content: source }] },
      testSuite: { testCases },
    },
  });
} catch (err) {
  console.error('Rules test API call failed:', err?.response?.status, JSON.stringify(err?.response?.data ?? err.message));
  process.exit(2);
}

const { testResults = [], issues = [] } = response.data;
for (const issue of issues) {
  console.log(`issue [${issue.severity}] ${issue.description} @${JSON.stringify(issue.sourcePosition)}`);
}
if (testResults.length !== CASES.length) {
  console.error(`expected ${CASES.length} results, got ${testResults.length} — refusing to call that a pass`);
  process.exit(2);
}

let failures = 0;
testResults.forEach((result, i) => {
  const [name, expectation] = CASES[i];
  const ok = result.state === 'SUCCESS';
  if (!ok) failures++;
  console.log(`${ok ? 'ok    ' : 'FAILED'}  [${expectation}] ${name}`);
  if (!ok || verbose) {
    for (const message of result.debugMessages ?? []) console.log(`          debug: ${message}`);
    if (result.errorPosition) console.log(`          error at line ${result.errorPosition.line}`);
    if (verbose && result.visitedExpressions) {
      for (const v of result.visitedExpressions) {
        console.log(`          line ${v.sourcePosition?.line}:${v.sourcePosition?.column} → ${JSON.stringify(v.value)}`);
      }
    }
  }
});

console.log(`\n${CASES.length - failures}/${CASES.length} cases met their expectation (${rulesPath})`);
process.exit(failures === 0 ? 0 : 1);
