/**
 * Evaluate the FOOD rules in firestore.rules with the Firebase Rules TEST API.
 *
 *   npm run probe:food-rules
 *
 * ── What this proves, and what it does not ─────────────────────────────────
 * `POST projects/{project}:test` compiles the LOCAL firestore.rules and runs
 * each case against it server-side. Nothing is released and no document is
 * read or written. So a green run proves the PREDICATES do what the cases
 * say, on both the allow and the deny branch. It does not prove the rules are
 * deployed — they are not until someone runs `firebase deploy --only
 * firestore:rules` — and it does not prove the client writes the shapes these
 * cases describe. `src/lib/food-admin.ts` types its writes for that half.
 *
 * ── Encoding, measured 2026-09-12 ──────────────────────────────────────────
 * Values in `request.resource.data` are plain JSON: an ISO-8601 string is a
 * rules `timestamp` (it passes `is timestamp` and compares `== request.time`),
 * a JSON integer is an `int`, and 12.5 is a `float`. A `{seconds, nanos}` map
 * is NOT a timestamp. The existing document on an update goes in the case's
 * top-level `resource`.
 *
 * ⚠️ Every call sends `x-goog-user-project`. Without it, user credentials get a
 * 403 "requires a quota project", which reads like a permissions problem and
 * is not one.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { GoogleAuth } from 'google-auth-library';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? 'wawitas';
// FOOD_RULES_FILE lets a deliberate-break probe hand in a copy of the rules with
// one predicate removed, and confirm a case fails. Defaults to the real file.
const rules = readFileSync(process.env.FOOD_RULES_FILE ?? join(REPO, 'firestore.rules'), 'utf8');

const T = '2026-09-13T01:00:00Z';
const T_PLUS_1H = '2026-09-13T02:00:00Z';
const T_MINUS_1D = '2026-09-12T01:00:00Z';

const ADMIN = { uid: 'nightprobe-s13-admin', token: { admin: true, email: 'nightprobe-s13-admin@example.com' } };
const USER = { uid: 'nightprobe-s13-user', token: { email: 'nightprobe-s13-user@example.com' } };
const ADMIN_EMAIL = ADMIN.token.email;

const doc = (path) => `/databases/(default)/documents/${path}`;

function req(auth, path, method, data) {
  return {
    ...(auth ? { auth } : {}),
    path: doc(path),
    method,
    time: T,
    ...(data ? { resource: { data } } : {}),
  };
}

// ── fixtures ────────────────────────────────────────────────────────────────
const donation = {
  donor: 'Mercado Cancha',
  receivedAt: T_MINUS_1D,
  rawText: '3 bolsas de arroz de 5 kg, 2 kg de hígado',
  lines: [{ food: 'arroz', grams: 15000 }],
  source: 'llm-parsed',
  extractedByModel: 'flash-lite',
  notes: null,
  recordedBy: ADMIN_EMAIL,
  createdAt: T,
  updatedAt: T,
};

const entry = (over = {}) => ({
  kind: 'donation',
  category: 'grain',
  label: 'arroz',
  deltaG: 15000,
  occurredAt: T_MINUS_1D,
  recordedAt: T,
  expiresAt: null,
  sourceId: 'donation-1',
  note: null,
  recordedBy: ADMIN_EMAIL,
  ...over,
});

const cook = (over = {}) => ({
  cookedAt: T_MINUS_1D,
  inputs: [{ category: 'grain', label: 'arroz', rawG: 5000 }],
  potFillLevel: 0.75,
  cookedWeightG: null,
  ladlesYielded: null,
  dogsServed: null,
  cookedBy: null,
  notes: null,
  recordedBy: ADMIN_EMAIL,
  createdAt: T,
  updatedAt: T,
  ...over,
});

const day = (over = {}) => ({
  date: '2026-09-12',
  batchIds: ['batch-1'],
  servings: [{ petId: 'p1', petName: 'Lobo', ladles: 3, adjustedReason: null }],
  dogsPresent: 38,
  shortfallNote: null,
  updatedBy: ADMIN_EMAIL,
  updatedAt: T,
  ...over,
});

const ALLOW = 'ALLOW';
const DENY = 'DENY';

/** [name, expectation, request, existing resource data?] */
const CASES = [
  // ── regression: rules that already existed still behave ──────────────────
  ['regression: anyone reads pets/{id}', ALLOW, req(null, 'pets/p1', 'get')],
  ['regression: a non-admin cannot read petDrafts', DENY, req(USER, 'petDrafts/d1', 'get')],
  ['regression: an undeclared collection is default-deny', DENY, req(ADMIN, 'nightprobe-s13-x/y', 'get')],

  // ── foodDonations ─────────────────────────────────────────────────────────
  ['donation: admin creates a reviewed donation', ALLOW, req(ADMIN, 'foodDonations/d1', 'create', donation)],
  ['donation: signed-in NON-admin cannot create', DENY, req(USER, 'foodDonations/d1', 'create', { ...donation, recordedBy: USER.token.email })],
  ['donation: signed-out cannot create', DENY, req(null, 'foodDonations/d1', 'create', donation)],
  ['donation: attributed to SOMEONE ELSE is refused', DENY, req(ADMIN, 'foodDonations/d1', 'create', { ...donation, recordedBy: 'otra@example.com' })],
  ['donation: attributed by uid is accepted', ALLOW, req(ADMIN, 'foodDonations/d1', 'create', { ...donation, recordedBy: ADMIN.uid })],
  ['donation: an extra field is refused', DENY, req(ADMIN, 'foodDonations/d1', 'create', { ...donation, stockTotal: 99 })],
  ['donation: no lines is refused', DENY, req(ADMIN, 'foodDonations/d1', 'create', { ...donation, lines: [] })],
  ['donation: backdated createdAt is refused', DENY, req(ADMIN, 'foodDonations/d1', 'create', { ...donation, createdAt: T_MINUS_1D })],
  ['donation: received TOMORROW is refused', DENY, req(ADMIN, 'foodDonations/d1', 'create', { ...donation, receivedAt: '2026-09-14T01:00:00Z' })],
  ['donation: manual source carrying a model key is refused', DENY, req(ADMIN, 'foodDonations/d1', 'create', { ...donation, source: 'manual' })],
  ['donation: admin reads', ALLOW, req(ADMIN, 'foodDonations/d1', 'get')],
  ['donation: NON-admin cannot read (donor names)', DENY, req(USER, 'foodDonations/d1', 'get')],
  ['donation: admin edits the donor and notes', ALLOW, req(ADMIN, 'foodDonations/d1', 'update', { ...donation, donor: 'Doña Rosa', notes: 'llegó en taxi', updatedAt: T }), { ...donation, updatedAt: T_MINUS_1D }],
  ['donation: admin CANNOT rewrite the lines', DENY, req(ADMIN, 'foodDonations/d1', 'update', { ...donation, lines: [{ food: 'arroz', grams: 150000 }], updatedAt: T }), { ...donation, updatedAt: T_MINUS_1D }],
  ['donation: admin cannot delete', DENY, req(ADMIN, 'foodDonations/d1', 'delete'), donation],

  // ── the ledger ────────────────────────────────────────────────────────────
  ['ledger: a donation ADDS stock', ALLOW, req(ADMIN, 'foodStock/grain/stockEntries/e1', 'create', entry())],
  ['ledger: a donation cannot SUBTRACT', DENY, req(ADMIN, 'foodStock/grain/stockEntries/e1', 'create', entry({ deltaG: -15000 }))],
  ['ledger: a cook entry subtracts', ALLOW, req(ADMIN, 'foodStock/grain/stockEntries/e1', 'create', entry({ kind: 'cook', deltaG: -5000, sourceId: 'batch-1' }))],
  ['ledger: a cook entry cannot ADD', DENY, req(ADMIN, 'foodStock/grain/stockEntries/e1', 'create', entry({ kind: 'cook', deltaG: 5000, sourceId: 'batch-1' }))],
  ['ledger: a discard subtracts with no source', ALLOW, req(ADMIN, 'foodStock/grain/stockEntries/e1', 'create', entry({ kind: 'discard', deltaG: -2500, sourceId: null }))],
  ['ledger: a discard naming a source is refused', DENY, req(ADMIN, 'foodStock/grain/stockEntries/e1', 'create', entry({ kind: 'discard', deltaG: -2500 }))],
  ['ledger: a correction WITH a reason, either sign', ALLOW, req(ADMIN, 'foodStock/grain/stockEntries/e1', 'create', entry({ kind: 'correction', deltaG: 1000, sourceId: null, note: 'conteo del sábado' }))],
  ['ledger: a correction with NO reason is refused', DENY, req(ADMIN, 'foodStock/grain/stockEntries/e1', 'create', entry({ kind: 'correction', deltaG: 1000, sourceId: null, note: null }))],
  ['ledger: fractional grams are refused', DENY, req(ADMIN, 'foodStock/grain/stockEntries/e1', 'create', entry({ deltaG: 12.5 }))],
  ['ledger: zero grams is refused', DENY, req(ADMIN, 'foodStock/grain/stockEntries/e1', 'create', entry({ deltaG: 0 }))],
  ['ledger: 2 000 000 g is the edge and is allowed', ALLOW, req(ADMIN, 'foodStock/grain/stockEntries/e1', 'create', entry({ deltaG: 2000000 }))],
  ['ledger: over two tonnes is refused', DENY, req(ADMIN, 'foodStock/grain/stockEntries/e1', 'create', entry({ deltaG: 2000001 }))],
  ['ledger: category in the body must match the PATH', DENY, req(ADMIN, 'foodStock/grain/stockEntries/e1', 'create', entry({ category: 'meat' }))],
  ['ledger: an unknown category path is refused', DENY, req(ADMIN, 'foodStock/sweets/stockEntries/e1', 'create', entry({ category: 'sweets' }))],
  ['ledger: a backdated recordedAt is refused', DENY, req(ADMIN, 'foodStock/grain/stockEntries/e1', 'create', entry({ recordedAt: T_MINUS_1D }))],
  ['ledger: attributed to someone else is refused', DENY, req(ADMIN, 'foodStock/grain/stockEntries/e1', 'create', entry({ recordedBy: 'otra@example.com' }))],
  ['ledger: NON-admin cannot append', DENY, req(USER, 'foodStock/grain/stockEntries/e1', 'create', entry({ recordedBy: USER.token.email }))],
  ['ledger: admin cannot EDIT an entry', DENY, req(ADMIN, 'foodStock/grain/stockEntries/e1', 'update', entry({ deltaG: 1500 })), entry()],
  ['ledger: admin cannot DELETE an entry', DENY, req(ADMIN, 'foodStock/grain/stockEntries/e1', 'delete'), entry()],
  ['ledger: admin lists a category (sum reads)', ALLOW, req(ADMIN, 'foodStock/grain/stockEntries/e1', 'list')],
  ['ledger: NON-admin cannot list', DENY, req(USER, 'foodStock/grain/stockEntries/e1', 'list')],
  ['ledger: the parent foodStock/{category} doc is not writable', DENY, req(ADMIN, 'foodStock/grain', 'create', { total: 5 })],

  // ── cook batches ──────────────────────────────────────────────────────────
  ['cook: admin records a batch', ALLOW, req(ADMIN, 'cookBatches/b1', 'create', cook())],
  ['cook: a batch with no inputs is refused', DENY, req(ADMIN, 'cookBatches/b1', 'create', cook({ inputs: [] }))],
  ['cook: a pot filled to 150% is refused', DENY, req(ADMIN, 'cookBatches/b1', 'create', cook({ potFillLevel: 1.5 }))],
  ['cook: outcomes added later — half ladles allowed', ALLOW, req(ADMIN, 'cookBatches/b1', 'update', cook({ cookedWeightG: 31500, ladlesYielded: 120.5, dogsServed: 38, createdAt: T_MINUS_1D })), cook({ createdAt: T_MINUS_1D, updatedAt: T_MINUS_1D })],
  ['cook: zero ladles is not an outcome', DENY, req(ADMIN, 'cookBatches/b1', 'update', cook({ ladlesYielded: 0, createdAt: T_MINUS_1D })), cook({ createdAt: T_MINUS_1D, updatedAt: T_MINUS_1D })],
  ['cook: half a dog is not an outcome', DENY, req(ADMIN, 'cookBatches/b1', 'update', cook({ dogsServed: 3.5, createdAt: T_MINUS_1D })), cook({ createdAt: T_MINUS_1D, updatedAt: T_MINUS_1D })],
  ['cook: the INPUTS cannot be rewritten', DENY, req(ADMIN, 'cookBatches/b1', 'update', cook({ inputs: [{ category: 'grain', label: 'arroz', rawG: 1 }], createdAt: T_MINUS_1D })), cook({ createdAt: T_MINUS_1D, updatedAt: T_MINUS_1D })],
  ['cook: cannot be deleted', DENY, req(ADMIN, 'cookBatches/b1', 'delete'), cook()],
  ['cook: NON-admin cannot read', DENY, req(USER, 'cookBatches/b1', 'get')],

  // ── feeding log ───────────────────────────────────────────────────────────
  ['day: admin writes today', ALLOW, req(ADMIN, 'feedingLog/2026-09-12', 'create', day())],
  ['day: admin edits it later in the day', ALLOW, req(ADMIN, 'feedingLog/2026-09-12', 'update', day({ dogsPresent: 39 })), day({ updatedAt: T_MINUS_1D })],
  ['day: the date in the body must match the id', DENY, req(ADMIN, 'feedingLog/2026-09-12', 'create', day({ date: '2026-09-11' }))],
  ['day: a malformed id is refused', DENY, req(ADMIN, 'feedingLog/12-09-2026', 'create', day({ date: '12-09-2026' }))],
  ['day: NON-admin cannot write', DENY, req(USER, 'feedingLog/2026-09-12', 'create', day({ updatedBy: USER.token.email }))],
  ['day: admin may delete a mistaken day', ALLOW, req(ADMIN, 'feedingLog/2026-09-12', 'delete'), day()],
  ['day: NON-admin cannot delete', DENY, req(USER, 'feedingLog/2026-09-12', 'delete'), day()],
];

// ── run ─────────────────────────────────────────────────────────────────────
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const client = await auth.getClient();

const testCases = CASES.map(([, expectation, request, resource]) => ({
  expectation,
  request,
  ...(resource ? { resource: { data: resource } } : {}),
}));

// Sanity-check the fixture times against the clock the cases claim, so a
// fixture that drifted into the future does not turn an ALLOW into a DENY.
if (!(T_MINUS_1D < T && T < T_PLUS_1H)) throw new Error('fixture times are out of order');

let response;
try {
  response = await client.request({
    url: `https://firebaserules.googleapis.com/v1/projects/${PROJECT}:test`,
    method: 'POST',
    headers: { 'x-goog-user-project': PROJECT },
    data: {
      source: { files: [{ name: 'firestore.rules', content: rules }] },
      testSuite: { testCases },
    },
  });
} catch (err) {
  console.error('Rules test API call failed:', err?.response?.status, JSON.stringify(err?.response?.data ?? err.message));
  process.exit(2);
}

const { issues = [], testResults = [] } = response.data;
const errors = issues.filter((i) => i.severity === 'ERROR');
for (const issue of issues) {
  console.log(`[${issue.severity}] ${issue.description} @ line ${issue.sourcePosition?.line}`);
}
if (errors.length > 0) {
  console.error('\nfirestore.rules did not compile; no case was evaluated.');
  process.exit(1);
}

let failed = 0;
testResults.forEach((result, i) => {
  const [name, expectation] = CASES[i];
  const ok = result.state === 'SUCCESS';
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${expectation.padEnd(5)} ${name}`);
  if (!ok && result.debugMessages) console.log(`        ${JSON.stringify(result.debugMessages)}`);
});

const allows = CASES.filter(([, e]) => e === ALLOW).length;
console.log(`\n${testResults.length - failed}/${testResults.length} as expected (${allows} allow, ${CASES.length - allows} deny)`);
if (testResults.length !== CASES.length) {
  console.error(`Expected ${CASES.length} results, got ${testResults.length}.`);
  process.exit(1);
}
process.exit(failed === 0 ? 0 : 1);
