import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COOK_BATCH_FAILURE_HEADER,
  handleCookBatchPost,
  parseCookBatchBody,
  type CookBatchDeps,
  type CookBatchPlan,
  type VerifiedToken,
} from '../cook-batch-handler';
import type { CookBatchDraft } from '../food-stock';

/**
 * The server-side cook-batch gate. Both branches of the toxic acknowledgement
 * are asserted here — unacknowledged is refused with nothing written,
 * acknowledged is written — because since 2026-09-13 this handler, not the
 * screen, is where that gate holds. `firestore.rules` denies client create;
 * `probe-food-rules.mjs` asserts that denial.
 */

const NOW = Date.parse('2026-09-13T15:00:00Z');
const COOKED_AT = NOW - 3_600_000;

function draft(over: Partial<CookBatchDraft> = {}): CookBatchDraft {
  return {
    cookedAt: COOKED_AT,
    inputs: [{ category: 'grain', label: 'arroz', kgText: '5', toxicAcknowledged: false }],
    potFillLevel: 0.75,
    cookedKgText: '',
    ladlesText: '',
    dogsServedText: '',
    cookedBy: null,
    notes: null,
    ...over,
  };
}

const ONION = { category: 'vegetable' as const, label: 'cebolla', kgText: '1', toxicAcknowledged: false };

function harness(token: VerifiedToken = { uid: 'u1', email: 'admin@example.com', admin: true }) {
  const calls = { verify: [] as [string, boolean][], commits: [] as CookBatchPlan[] };
  let commitError: Error | null = null;
  const deps: CookBatchDeps = {
    verifyIdToken: async (t, checkRevoked) => {
      calls.verify.push([t, checkRevoked]);
      return token;
    },
    commit: async (plan) => {
      if (commitError) throw commitError;
      calls.commits.push(plan);
      return 'batch-1';
    },
    now: () => NOW,
    log: () => {},
  };
  return { calls, deps, failCommit: (err: Error) => (commitError = err) };
}

function post(body: unknown, auth: string | null = 'Bearer good-token'): Request {
  return new Request('http://localhost/api/food/cook-batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// ─── the boundary ────────────────────────────────────────────────────────────

test('ROUTE: no token is 401, stamped, and touches nothing', async () => {
  const { calls, deps } = harness();
  const res = await handleCookBatchPost(post(draft(), null), deps);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get(COOK_BATCH_FAILURE_HEADER), 'unauthenticated');
  assert.equal(calls.verify.length, 0);
  assert.equal(calls.commits.length, 0);
});

test('ROUTE: a token that fails verification is 401', async () => {
  const { deps, calls } = harness();
  deps.verifyIdToken = async () => {
    throw new Error('revoked');
  };
  const res = await handleCookBatchPost(post(draft()), deps);
  assert.equal(res.status, 401);
  assert.equal(calls.commits.length, 0);
});

test('ROUTE: verifies the ID token with checkRevoked', async () => {
  const { calls, deps } = harness();
  await handleCookBatchPost(post(draft()), deps);
  assert.deepEqual(calls.verify, [['good-token', true]]);
});

test('ROUTE: a signed-in NON-admin is refused', async () => {
  for (const admin of [undefined, false, 'true']) {
    const { calls, deps } = harness({ uid: 'u2', email: 'user@example.com', admin });
    const res = await handleCookBatchPost(post(draft()), deps);
    assert.equal(res.status, 403, `admin=${String(admin)}`);
    assert.equal(res.headers.get(COOK_BATCH_FAILURE_HEADER), 'forbidden');
    assert.equal(calls.commits.length, 0);
  }
});

test('ROUTE: a body that is not a cook batch is 400', async () => {
  const cases: [unknown, string][] = [
    ['not json{', 'body-unreadable'],
    [{ ...draft(), inputs: 'arroz' }, 'body-invalid'],
    [{ ...draft(), inputs: [{ category: 'sweets', label: 'x', kgText: '1', toxicAcknowledged: false }] }, 'body-invalid'],
    [{ ...draft(), inputs: [{ category: 'grain', label: 'x'.repeat(81), kgText: '1', toxicAcknowledged: false }] }, 'body-invalid'],
    [{ ...draft(), inputs: [{ category: 'grain', label: 'arroz', kgText: '1', toxicAcknowledged: 'yes' }] }, 'body-invalid'],
    [{ ...draft(), inputs: Array.from({ length: 21 }, () => draft().inputs[0]) }, 'body-invalid'],
    [{ ...draft(), cookedAt: '2026-09-13' }, 'body-invalid'],
  ];
  for (const [body, error] of cases) {
    const { calls, deps } = harness();
    const res = await handleCookBatchPost(post(body), deps);
    assert.equal(res.status, 400, error);
    assert.equal(res.headers.get(COOK_BATCH_FAILURE_HEADER), error);
    assert.equal(calls.commits.length, 0);
  }
});

// ─── the gate ────────────────────────────────────────────────────────────────

test('ROUTE SAFETY: a toxic input NOT acknowledged is refused and nothing is written', async () => {
  const { calls, deps } = harness();
  const res = await handleCookBatchPost(post(draft({ inputs: [ONION] })), deps);
  assert.equal(res.status, 422);
  assert.equal(res.headers.get(COOK_BATCH_FAILURE_HEADER), 'batch-invalid');
  const json = (await res.json()) as { errors: unknown[] };
  assert.deepEqual(json.errors, [{ kind: 'input-toxic-unacknowledged', index: 0, hazards: ['allium'] }]);
  assert.equal(calls.commits.length, 0);
});

test('ROUTE SAFETY: an acknowledged toxic input is written, with one negative ledger entry per input', async () => {
  const { calls, deps } = harness();
  const body = draft({
    inputs: [{ ...ONION, toxicAcknowledged: true }, { category: 'grain', label: ' arroz ', kgText: '5', toxicAcknowledged: false }],
    ladlesText: '120,5',
  });
  const res = await handleCookBatchPost(post(body), deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: 'batch-1' });
  assert.equal(calls.commits.length, 1);
  const plan = calls.commits[0]!;
  assert.deepEqual(plan.inputs, [
    { category: 'vegetable', label: 'cebolla', rawG: 1000 },
    { category: 'grain', label: 'arroz', rawG: 5000 },
  ]);
  assert.deepEqual(plan.entries, [
    { category: 'vegetable', label: 'cebolla', deltaG: -1000, occurredAtMs: COOKED_AT },
    { category: 'grain', label: 'arroz', deltaG: -5000, occurredAtMs: COOKED_AT },
  ]);
  assert.equal(plan.ladlesYielded, 120.5);
  assert.equal(plan.cookedAtMs, COOKED_AT);
});

test('ROUTE: every other validator error is enforced too — a 0 kg input is refused', async () => {
  const { calls, deps } = harness();
  const res = await handleCookBatchPost(
    post(draft({ inputs: [{ category: 'grain', label: 'arroz', kgText: '0', toxicAcknowledged: false }] })),
    deps
  );
  assert.equal(res.status, 422);
  assert.equal(calls.commits.length, 0);
});

// ─── attribution and failure ─────────────────────────────────────────────────

test('ROUTE: attribution comes from the verified token — email, else uid; never from the body', async () => {
  const withEmail = harness();
  await handleCookBatchPost(post({ ...draft(), recordedBy: 'mallory@example.com' }), withEmail.deps);
  assert.equal(withEmail.calls.commits[0]!.recordedBy, 'admin@example.com');

  for (const email of [undefined, null, '']) {
    const noEmail = harness({ uid: 'uid-without-email', email, admin: true });
    await handleCookBatchPost(post(draft()), noEmail.deps);
    assert.equal(noEmail.calls.commits[0]!.recordedBy, 'uid-without-email');
  }
});

test('ROUTE: a failed write is 500 and stamped', async () => {
  const { deps, failCommit } = harness();
  failCommit(new Error('unavailable'));
  const res = await handleCookBatchPost(post(draft()), deps);
  assert.equal(res.status, 500);
  assert.equal(res.headers.get(COOK_BATCH_FAILURE_HEADER), 'write-failed');
});

test('a valid body parses to exactly the draft the screen sent', () => {
  const sent = draft({ inputs: [{ ...ONION, toxicAcknowledged: true }], cookedBy: 'Doña Julia' });
  assert.deepEqual(parseCookBatchBody(JSON.parse(JSON.stringify(sent))), sent);
});
