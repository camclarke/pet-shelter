import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_MODEL_LADDER_DEFAULT_KEYS,
  FLASH_LITE_MODEL,
  FLASH_MODEL,
  MODELS,
  cardLadderKeys,
  modelIdFor,
} from '../ai/model-ids';
import { hasPricingRow } from '../ai/pricing.mjs';
import { retryWithinDeadline, walkModelLadder } from '../ai/suggest-budget';
import { classifyCardFailure } from '../card-extract-client';

/**
 * The card path's reuse of the proven intake machinery, and the ladder it walks.
 * Every number here is a literal.
 */

function timeout(): Error {
  return Object.assign(new Error('timed out'), { name: 'TimeoutError' });
}
function http(status: number): Error {
  return Object.assign(new Error(`http ${status}`), { statusCode: status });
}

// ─── the card ladder ─────────────────────────────────────────────────────────

test('the default card ladder is 3.8, then 3.7, then Flash-Lite', () => {
  assert.deepEqual(cardLadderKeys(undefined), ['flash-3.8', 'flash-3.7', 'flash-lite']);
  assert.deepEqual([...CARD_MODEL_LADDER_DEFAULT_KEYS], ['flash-3.8', 'flash-3.7', 'flash-lite']);
});

test('cards stay off the intake cascade primary', () => {
  // gemini-3.6-flash reads arriving animals' sex and age. A card read from
  // its 20-a-day bucket pushes an intake down the cascade.
  assert.equal(cardLadderKeys(undefined).includes('flash'), false);
  assert.equal(cardLadderKeys(undefined).map(modelIdFor).includes(FLASH_MODEL), false);
});

test('the card ladder always ends on Flash-Lite, whatever the override', () => {
  assert.deepEqual(cardLadderKeys('flash-lite'), ['flash-lite']);
  assert.deepEqual(cardLadderKeys('flash-lite,flash-3.8'), ['flash-3.8', 'flash-lite']);
  assert.deepEqual(cardLadderKeys('pro'), ['pro', 'flash-lite']);
  const last = cardLadderKeys('flash-3.7').map(modelIdFor).at(-1);
  assert.equal(last, FLASH_LITE_MODEL);
});

test('an override of unknown or non-vision keys falls back to the default', () => {
  assert.deepEqual(cardLadderKeys('gemini-3.8-flash'), ['flash-3.8', 'flash-3.7', 'flash-lite']);
  assert.deepEqual(cardLadderKeys('transcribe'), ['flash-3.8', 'flash-3.7', 'flash-lite']);
  assert.deepEqual(cardLadderKeys(' , ,'), ['flash-3.8', 'flash-3.7', 'flash-lite']);
});

test('a repeated key is tried once', () => {
  assert.deepEqual(cardLadderKeys('flash-3.8, flash-3.8'), ['flash-3.8', 'flash-lite']);
});

test('every model the card ladder can call is priced', () => {
  for (const key of Object.keys(MODELS) as (keyof typeof MODELS)[]) {
    if (!MODELS[key].supportsVision) continue;
    for (const id of cardLadderKeys(key).map(modelIdFor)) {
      assert.ok(hasPricingRow(id), `${id} (card ladder via ${key}) has no pricing row`);
    }
  }
});

// ─── ONE deadline, which the route may only shorten ──────────────────────────

test('a caller-supplied EARLIER deadline is the one every tier receives', async () => {
  let clock = 1_000_000;
  const seen: number[] = [];
  await walkModelLadder(
    ['a', 'b'],
    async (_model, deadline) => {
      seen.push(deadline);
      clock += 1_000;
      if (seen.length === 1) throw http(503);
      return 'ok';
    },
    { now: () => clock, warn: () => {}, deadline: 1_000_000 + 30_000 }
  );
  assert.deepEqual(seen, [1_030_000, 1_030_000]);
});

test('a LATER deadline is clamped to the 50 s budget, never extended', async () => {
  const clock = 1_000_000;
  let seen = 0;
  await walkModelLadder(['a'], async (_m, deadline) => ((seen = deadline), 'ok'), {
    now: () => clock,
    warn: () => {},
    deadline: clock + 90_000,
  });
  assert.equal(seen, clock + 50_000);
});

test('the ladder logs under the caller’s label', async () => {
  const logs: string[] = [];
  await walkModelLadder(
    ['a', 'b'],
    async (model) => {
      if (model === 'a') throw http(429);
      return 'ok';
    },
    { now: () => 0, warn: (m) => logs.push(m), label: '[card-extract]' }
  );
  assert.ok(logs.some((l) => l.startsWith('[card-extract] ')), logs.join('\n'));
});

// ─── the retry policy, now testable ──────────────────────────────────────────

async function retry(
  outcomes: Array<{ fail?: Error; takesMs: number }>,
  { deadlineIn = 50_000, perAttemptMs = 25_000 } = {}
) {
  let clock = 1_000_000;
  const deadline = clock + deadlineIn;
  const budgets: number[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  let i = 0;
  try {
    const value = await retryWithinDeadline(
      deadline,
      perAttemptMs,
      async (budgetMs) => {
        budgets.push(budgetMs);
        const o = outcomes[i++] ?? { takesMs: 0 };
        clock += o.takesMs;
        if (o.fail) throw o.fail;
        return 'ok';
      },
      {
        now: () => clock,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
        warn: (m) => logs.push(m),
        label: '[card-extract]',
      }
    );
    return { value, error: null as unknown, budgets, sleeps, logs };
  } catch (error) {
    return { value: null, error, budgets, sleeps, logs };
  }
}

test('a hang is retried once, immediately, with a fresh attempt budget', async () => {
  const r = await retry([{ fail: timeout(), takesMs: 25_000 }, { takesMs: 3_000 }]);
  assert.equal(r.value, 'ok');
  assert.deepEqual(r.budgets, [25_000, 25_000]);
  assert.deepEqual(r.sleeps, []);
});

test('an overload waits 1500 ms before its retry', async () => {
  const r = await retry([{ fail: http(503), takesMs: 2_000 }, { takesMs: 3_000 }]);
  assert.equal(r.value, 'ok');
  assert.deepEqual(r.sleeps, [1_500]);
});

test('a rejected request is not retried', async () => {
  const r = await retry([{ fail: http(400), takesMs: 500 }, { takesMs: 1 }]);
  assert.ok(r.error);
  assert.equal(r.budgets.length, 1);
});

test('a spent quota is not retried on the same model', async () => {
  const r = await retry([{ fail: http(429), takesMs: 100 }, { takesMs: 1 }]);
  assert.ok(r.error);
  assert.equal(r.budgets.length, 1);
});

test('no retry is started with less than 8 s left, and the log says so', async () => {
  const r = await retry([{ fail: timeout(), takesMs: 43_000 }, { takesMs: 1 }]);
  assert.ok(r.error);
  assert.equal(r.budgets.length, 1);
  assert.ok(r.logs.some((l) => l.includes('not retrying')), r.logs.join('\n'));
});

test('an attempt is never given more than what is left of the deadline', async () => {
  const r = await retry([{ takesMs: 1 }], { deadlineIn: 9_000, perAttemptMs: 25_000 });
  assert.deepEqual(r.budgets, [9_000]);
});

test('a deadline already past gives an attempt 0 ms, never a negative budget', async () => {
  // A negative number makes AbortSignal.timeout throw a TypeError, which would
  // be reported as a generic failure instead of the timeout it is.
  const r = await retry([{ takesMs: 1 }], { deadlineIn: -5_000 });
  assert.deepEqual(r.budgets, [0]);
});

test('the retry logs under the caller’s label', async () => {
  const r = await retry([{ fail: timeout(), takesMs: 10_000 }, { takesMs: 1 }]);
  assert.ok(r.logs.every((l) => l.startsWith('[card-extract] ')), r.logs.join('\n'));
});

// ─── whose failure is it ─────────────────────────────────────────────────────

test('an UNSTAMPED 5xx is the edge giving up, reported as a retryable timeout', () => {
  assert.equal(classifyCardFailure(503, null), 'timeout');
  assert.equal(classifyCardFailure(504, null), 'timeout');
});

test('our own 503 for a missing key is NOT mistaken for a timeout', () => {
  assert.equal(classifyCardFailure(503, 'ai-not-configured'), 'not-configured');
  assert.equal(classifyCardFailure(503, 'storage-not-configured'), 'not-configured');
});

test('each stamped failure maps to what the panel needs to say', () => {
  assert.equal(classifyCardFailure(401, 'unauthenticated'), 'unauthorized');
  assert.equal(classifyCardFailure(403, 'forbidden'), 'unauthorized');
  assert.equal(classifyCardFailure(409, 'already-extracted'), 'already-extracted');
  assert.equal(classifyCardFailure(404, 'card-not-found'), 'photo-rejected');
  assert.equal(classifyCardFailure(413, 'card-too-large'), 'photo-rejected');
  assert.equal(classifyCardFailure(415, 'card-unsupported'), 'photo-rejected');
  assert.equal(classifyCardFailure(400, 'bad-request'), 'photo-rejected');
  assert.equal(classifyCardFailure(404, 'pet-not-found'), 'pet-missing');
  assert.equal(classifyCardFailure(504, 'extract-timeout'), 'timeout');
  assert.equal(classifyCardFailure(502, 'extract-failed'), 'failed');
  assert.equal(classifyCardFailure(500, 'save-failed'), 'failed');
  assert.equal(classifyCardFailure(500, 'something-new'), 'failed');
});
