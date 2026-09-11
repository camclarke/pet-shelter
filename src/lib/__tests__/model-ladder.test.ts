import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FLASH_LITE_MODEL,
  FLASH_MID_MODEL,
  FLASH_MODEL,
  FLASH_NEXT_MODEL,
  MODELS,
  SUGGEST_MODEL_LADDER,
  modelKeyFor,
} from '../ai/model-ids';
import { hasPricingRow, pricingSourceFor } from '../ai/pricing.mjs';
import {
  SUGGEST_MAX_ATTEMPTS,
  SUGGEST_MIN_RETRY_MS,
  SUGGEST_TOTAL_BUDGET_MS,
  attemptTimeoutMsFor,
  isQuotaExhaustedFailure,
  isTimeoutFailure,
  shouldFallBackToWeakerModel,
  walkModelLadder,
} from '../ai/suggest-budget';

/** A provider failure with a status code, as the SDK reports one. */
function httpError(status: number): Error {
  return Object.assign(new Error(`http ${status}`), { statusCode: status });
}

/**
 * Drive walkModelLadder with a fake clock and a scripted set of outcomes.
 *
 * Returns what each tier was handed, which is what makes the ONE-deadline
 * property assertable at all.
 */
async function walk(
  ladder: readonly string[],
  outcomes: Record<string, { failWith?: Error; takesMs: number }>,
  startAt = 1_000_000,
) {
  let clock = startAt;
  const seen: { model: string; deadline: number; at: number }[] = [];
  const logs: string[] = [];

  const run = walkModelLadder(
    ladder,
    async (model, deadline) => {
      seen.push({ model, deadline, at: clock });
      const o = outcomes[model] ?? { takesMs: 0 };
      clock += o.takesMs;
      if (o.failWith) throw o.failWith;
      return `answer from ${model}`;
    },
    { now: () => clock, warn: (m) => logs.push(m), describe: () => 'failed' },
  );

  try {
    return { value: await run, error: null as unknown, seen, logs, startAt };
  } catch (error) {
    return { value: null, error, seen, logs, startAt };
  }
}

/**
 * The intake cascade: 3.8 → 3.7 → 3.6 → Flash-Lite.
 *
 * It exists for QUOTA — free-tier limits are a separate bucket per model, so
 * three Flash tiers take the shelter from 20 animals a day to 60. These tests
 * pin the properties that make that true and safe, not the model ids, which
 * churn by design.
 */

test('the ladder leads with the best-MEASURED model and ends on Flash-Lite', () => {
  // ⚠️ 3.6 first, not 3.8. `npm run eval:intake` on 2026-09-10: 3.6 delivered
  // the sex reading 2 of 2 at high confidence, 3.8 delivered it 0 of 2. Age was
  // fine on both. See SUGGEST_MODEL_LADDER for the full reasoning — this order
  // is a measurement, not an assumption about version numbers.
  assert.deepEqual(SUGGEST_MODEL_LADDER, [
    FLASH_MODEL,
    FLASH_NEXT_MODEL,
    FLASH_MID_MODEL,
    FLASH_LITE_MODEL,
  ]);
  // ⚠️ Flash-Lite LAST and present. 500 requests a day against Flash's 20
  // makes it the only tier still working once all three Flash buckets are
  // spent — plan §3, an animal arriving at 22:00 must not wait. Removing it
  // would make a spent quota a hard failure.
  assert.equal(
    SUGGEST_MODEL_LADDER[SUGGEST_MODEL_LADDER.length - 1],
    FLASH_LITE_MODEL,
    'Flash-Lite must be the final tier — it is the one with 500 requests a day',
  );
  // And it must be last rather than merely present: a Lite tier placed above a
  // Flash tier would hand a weaker age reading to animals that could have had
  // a better one.
  assert.equal(
    SUGGEST_MODEL_LADDER.filter((m) => m.includes('lite')).length,
    1,
    'exactly one Lite tier, and it is the last',
  );
});

test('the cascade is what multiplies the daily Flash allowance', () => {
  // The stated reason the ladder exists. Quota is per model, so the number of
  // DISTINCT Flash-class tiers is the multiplier — two entries pointing at the
  // same id would look like a cascade and buy nothing.
  const flashTiers = SUGGEST_MODEL_LADDER.filter((m) => !m.includes('lite'));
  assert.equal(new Set(flashTiers).size, flashTiers.length, 'Flash tiers must be distinct models');
  assert.ok(flashTiers.length >= 3, `expected 3 Flash buckets, got ${flashTiers.length}`);
});

test('every tier is priced — no tier may be metered at a rate nobody chose', () => {
  // The primary runs on every intake; an unpriced one means every successful
  // suggestion is costed at the Flash fallback. This is the guard that fires
  // if someone points a tier at a model with no row.
  for (const model of SUGGEST_MODEL_LADDER) {
    assert.ok(hasPricingRow(model), `ladder tier ${model} has no pricing row`);
    assert.notEqual(pricingSourceFor(model), 'fallback', `${model} resolves to the fallback rate`);
  }
});

test('every tier resolves to a stable KEY, so provenance says which one answered', () => {
  // `suggestedByModel` is persisted onto Pet.extractedByModel and is how an
  // accuracy problem gets scoped to one model generation after the fact. A
  // tier with no key falls through to the raw id, which is precisely what
  // types.ts says must never be written.
  for (const model of SUGGEST_MODEL_LADDER) {
    const key = modelKeyFor(model);
    assert.ok(
      Object.prototype.hasOwnProperty.call(MODELS, key),
      `${model} has no stable key — provenance would record the raw id`,
    );
  }
  // And the keys must be distinct, or three Flash tiers become indistinguishable
  // in the one field that is supposed to tell them apart.
  const keys = SUGGEST_MODEL_LADDER.map((m) => modelKeyFor(m));
  assert.equal(new Set(keys).size, keys.length, `tier keys collide: ${JSON.stringify(keys)}`);
});

test('the newer tiers are separate constants from the one dictation depends on', () => {
  // ⚠️ FLASH_MODEL is dictation's extractor A — the highest-consequence path
  // in the system, with no eval. The cascade's newer tiers are their OWN
  // constants so that promoting one of them later cannot silently change what
  // reads a veterinary dose. Today FLASH_MODEL also happens to lead the
  // ladder; the point is that the two are not the same knob.
  assert.notEqual(FLASH_NEXT_MODEL, FLASH_MODEL);
  assert.notEqual(FLASH_MID_MODEL, FLASH_MODEL);
});

// ─── what the budget can actually reach ──────────────────────────────────────

test('a 429 fails fast, so the whole ladder fits one budget', () => {
  // The cascade is a QUOTA strategy, and this is the arithmetic that makes it
  // one. A spent quota returns immediately, so walking every tier costs
  // roughly one attempt's worth of time plus change.
  const quotaFailureMs = 400;
  let spent = 0;
  let reached = 0;
  for (let tier = 0; tier < SUGGEST_MODEL_LADDER.length; tier++) {
    if (tier > 0 && SUGGEST_TOTAL_BUDGET_MS - spent < SUGGEST_MIN_RETRY_MS) break;
    reached = tier + 1;
    spent += quotaFailureMs;
  }
  assert.equal(
    reached,
    SUGGEST_MODEL_LADDER.length,
    `only reached tier ${reached} of ${SUGGEST_MODEL_LADDER.length} on fast failures`,
  );
});

test('a HANG exhausts the budget, and the ladder stops rather than pretending', () => {
  // ⚠️ The counterpart. A hang costs the full per-attempt clamp, so two of them
  // spend the budget and nothing below is reachable. This is the test that
  // documents why the answer to hangs is NOT more tiers: past Firebase
  // Hosting's 60s ceiling the answer cannot be delivered at all.
  const perAttempt = attemptTimeoutMsFor(SUGGEST_MODEL_LADDER[0]!, 4);
  const afterTwoHangs = SUGGEST_TOTAL_BUDGET_MS - perAttempt * SUGGEST_MAX_ATTEMPTS;
  assert.ok(
    afterTwoHangs < SUGGEST_MIN_RETRY_MS,
    `two hangs left ${afterTwoHangs}ms, enough to start another tier — the ladder would run past the edge timeout`,
  );
});

test('a hang does NOT advance the tier — it is retried on the same model', () => {
  // Decided 2026-09-10. A hang is a hung socket, and the remedy already
  // applied is a fresh connection to the SAME model. Advancing the tier would
  // spend the single remaining attempt on a different model and give up the
  // retry that is the thing actually known to work.
  const hang = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
  assert.equal(isTimeoutFailure(hang), true);
  assert.equal(
    shouldFallBackToWeakerModel(hang),
    false,
    'a hang must not move down the ladder',
  );
});

test('a spent quota DOES advance the tier — that is what the ladder is for', () => {
  const quota = Object.assign(new Error('quota'), { statusCode: 429 });
  assert.equal(isQuotaExhaustedFailure(quota), true);
  assert.equal(shouldFallBackToWeakerModel(quota), true);
});

test('an overload advances the tier too', () => {
  // Observed in production 2026-09-03 and repeatedly on 2026-09-10, when all
  // three Flash tiers were overloaded at once. Note what that event implies:
  // overload correlates ACROSS Flash tiers, so the ladder's answer to a
  // provider-wide spike is the Lite tier at the bottom, not the Flash tiers in
  // the middle.
  const overloaded = Object.assign(new Error('high demand'), { statusCode: 503 });
  assert.equal(shouldFallBackToWeakerModel(overloaded), true);
});

test('a request rejected on its merits never walks the ladder', () => {
  // A malformed image fails identically on all four tiers. Walking them would
  // spend four daily requests to produce the same 400.
  const badRequest = Object.assign(new Error('bad image'), { statusCode: 400 });
  assert.equal(shouldFallBackToWeakerModel(badRequest), false);
});

// ─── walking the ladder ──────────────────────────────────────────────────────
// These drive walkModelLadder directly with a fake clock. That function was
// extracted out of `intake-suggest.ts` precisely so this section can exist: a
// break probe showed that deleting the ONE shared deadline left every test
// green, because the loop sat inside a server-only module full of network
// calls.

const L = ['m1', 'm2', 'm3', 'm4'];

test('EVERY tier is handed the SAME deadline — the 2026-09-02 defect', () => {
  // ⚠️ The single most important assertion about the cascade. A deadline
  // created per tier lets N tiers run to N x the budget: at two tiers that was
  // 100s against Firebase Hosting's 60s ceiling and cost a real intake; at
  // four tiers it is 200s. One value, created once, handed down unchanged.
  return walk(L, {
    m1: { failWith: httpError(429), takesMs: 300 },
    m2: { failWith: httpError(429), takesMs: 300 },
    m3: { failWith: httpError(503), takesMs: 300 },
    m4: { takesMs: 300 },
  }).then((r) => {
    assert.equal(r.value, 'answer from m4');
    assert.equal(r.seen.length, 4, 'all four tiers should have been tried');
    const deadlines = new Set(r.seen.map((s) => s.deadline));
    assert.equal(
      deadlines.size,
      1,
      `each tier got its own deadline: ${JSON.stringify([...deadlines])}`,
    );
    assert.equal(
      r.seen[0]!.deadline,
      r.startAt + SUGGEST_TOTAL_BUDGET_MS,
      'the shared deadline must be one budget from the START, not from each tier',
    );
    // And the last tier must still be inside the original budget.
    assert.ok(r.seen[3]!.at < r.startAt + SUGGEST_TOTAL_BUDGET_MS);
  });
});

test('a fast failure walks the whole ladder — the quota case', () => {
  return walk(L, {
    m1: { failWith: httpError(429), takesMs: 200 },
    m2: { failWith: httpError(429), takesMs: 200 },
    m3: { failWith: httpError(429), takesMs: 200 },
    m4: { takesMs: 200 },
  }).then((r) => {
    assert.equal(r.value, 'answer from m4');
    assert.deepEqual(r.seen.map((s) => s.model), L);
  });
});

test('a SLOW failure stops the walk instead of running past the edge timeout', () => {
  // Two hangs at the per-attempt clamp spend the budget. The third tier must
  // not be started: the answer could not be delivered through Hosting anyway,
  // and starting it would spend a daily request to produce nothing.
  const hangMs = Math.floor(SUGGEST_TOTAL_BUDGET_MS / 2);
  return walk(L, {
    m1: { failWith: httpError(503), takesMs: hangMs },
    m2: { failWith: httpError(503), takesMs: hangMs },
    m3: { takesMs: 100 },
    m4: { takesMs: 100 },
  }).then((r) => {
    assert.equal(r.seen.length, 2, `should have stopped after 2 tiers, tried ${r.seen.length}`);
    assert.ok(r.error, 'the walk must fail rather than return nothing');
    assert.ok(
      r.logs.some((l) => l.includes('not trying')),
      `expected a log saying it stopped: ${JSON.stringify(r.logs)}`,
    );
  });
});

test('a failure the ladder cannot fix stops immediately, sparing three quotas', () => {
  return walk(L, {
    m1: { failWith: httpError(400), takesMs: 100 },
    m2: { takesMs: 100 },
  }).then((r) => {
    assert.equal(r.seen.length, 1, 'a 400 must not walk the ladder');
    assert.equal((r.error as Error).message, 'http 400');
  });
});

test('a hang is NOT a reason to advance the tier', () => {
  // The counterpart to the predicate test above, at the walk level: a hang is
  // handled by the same-model retry inside extractWith, so the ladder must
  // hand it straight back rather than spending the next tier's quota on it.
  const hang = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
  return walk(L, { m1: { failWith: hang, takesMs: 100 }, m2: { takesMs: 100 } }).then((r) => {
    assert.equal(r.seen.length, 1, 'a hang must not move down the ladder');
    assert.equal(r.error, hang);
  });
});

test('the LAST error is thrown, not the first', () => {
  // The admin's message should describe the tier that actually gave up. A
  // first-error throw would report a quota problem on a model that was tried
  // 40 seconds and three tiers earlier.
  const last = httpError(503);
  return walk(L, {
    m1: { failWith: httpError(429), takesMs: 100 },
    m2: { failWith: httpError(429), takesMs: 100 },
    m3: { failWith: httpError(429), takesMs: 100 },
    m4: { failWith: last, takesMs: 100 },
  }).then((r) => {
    assert.equal(r.error, last);
  });
});

test('the first tier answers without touching any other quota', () => {
  // The normal case, and worth pinning: a working primary must not spend a
  // request on tiers below it.
  return walk(L, { m1: { takesMs: 9_000 } }).then((r) => {
    assert.equal(r.value, 'answer from m1');
    assert.equal(r.seen.length, 1);
    assert.deepEqual(r.logs, [], 'a clean first-tier answer should log nothing');
  });
});

test('a single-model ladder cannot fall back — what pins a benchmark', () => {
  // The eval harness passes exactly one id so a benchmark of model A can never
  // report model B's answer.
  return walk(['only'], { only: { failWith: httpError(429), takesMs: 100 } }).then((r) => {
    assert.equal(r.seen.length, 1);
    assert.equal((r.error as Error).message, 'http 429');
  });
});

test('an empty ladder is a programming error, not a silent no-op', () => {
  return walkModelLadder([], async () => 'x').then(
    () => assert.fail('an empty ladder must throw'),
    (err: Error) => assert.match(err.message, /must not be empty/),
  );
});
