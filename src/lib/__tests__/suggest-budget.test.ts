import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HOSTING_EDGE_TIMEOUT_MS,
  SUGGEST_ATTEMPT_TIMEOUT_MS,
  SUGGEST_ATTEMPT_TIMEOUT_MS_FLASH,
  SUGGEST_MAX_ATTEMPTS,
  SUGGEST_MIN_RETRY_MS,
  SUGGEST_OVERLOAD_BACKOFF_MS,
  SUGGEST_TOTAL_BUDGET_MS,
  attemptTimeoutMsFor,
  isOverloadedFailure,
  isQuotaExhaustedFailure,
  isRetryableFailure,
  isTimeoutFailure,
  retryBackoffMsFor,
  shouldFallBackToWeakerModel,
  analysisPhaseFor,
  firstAttemptEndsAtMs,
} from '../ai/suggest-budget';
import { FLASH_LITE_MODEL, FLASH_MODEL } from '../ai/model-ids';

/**
 * The invariant this whole module exists for.
 *
 * Firebase Hosting terminates a proxied request at 60s. Everything the route
 * does has to finish inside that, or the answer is built and discarded — which
 * is exactly what happened on 2026-09-02 and cost a real intake.
 */
test('the total budget leaves real headroom under the Hosting ceiling', () => {
  assert.ok(
    SUGGEST_TOTAL_BUDGET_MS < HOSTING_EDGE_TIMEOUT_MS,
    'the budget must fit inside the edge timeout'
  );
  // The headroom pays for the upload, which the route's own timers never see:
  // Hosting's clock starts when the client begins sending.
  assert.ok(
    HOSTING_EDGE_TIMEOUT_MS - SUGGEST_TOTAL_BUDGET_MS >= 8_000,
    'at least 8s must be reserved for the upload and the response'
  );
});

test('every attempt of every tier fits inside the total budget', () => {
  for (const modelId of [FLASH_MODEL, FLASH_LITE_MODEL]) {
    for (let photos = 1; photos <= 8; photos++) {
      const perAttempt = attemptTimeoutMsFor(modelId, photos);
      assert.ok(
        perAttempt * SUGGEST_MAX_ATTEMPTS <= SUGGEST_TOTAL_BUDGET_MS,
        `${modelId} with ${photos} photo(s): ${perAttempt}ms x ${SUGGEST_MAX_ATTEMPTS} exceeds the ${SUGGEST_TOTAL_BUDGET_MS}ms budget`
      );
      assert.ok(
        perAttempt * SUGGEST_MAX_ATTEMPTS < HOSTING_EDGE_TIMEOUT_MS,
        `${modelId} with ${photos} photo(s) can be cut off by the edge`
      );
    }
  }
});

/**
 * The 2026-09-02 incident, replayed as arithmetic.
 *
 * A four-photo Flash call asked for 43s per attempt. Two of those is 86s
 * against a 60s ceiling, so any four-photo call that needed its retry was
 * undeliverable BY CONSTRUCTION — no failure, no error, just an answer that
 * never arrived. This is the test that fails if the clamp is removed.
 */
test('a four-photo Flash call is clamped so its retry can still be delivered', () => {
  const perAttempt = attemptTimeoutMsFor(FLASH_MODEL, 4);
  const unclamped = SUGGEST_ATTEMPT_TIMEOUT_MS_FLASH + 3 * 6_000;

  assert.equal(unclamped, 43_000, 'the pre-clamp budget this incident was caused by');
  assert.ok(
    perAttempt < unclamped,
    'four photos on Flash must be clamped below what the tier alone would ask for'
  );
  assert.ok(
    perAttempt * SUGGEST_MAX_ATTEMPTS <= SUGGEST_TOTAL_BUDGET_MS,
    'both attempts must fit'
  );
});

/**
 * Measured, not assumed. On 2026-09-02 attempt 1 hung and attempt 2 answered
 * in ~24.7s. Under the new budget attempt 1 is abandoned at the clamp instead
 * of at 43s, so the same run finishes inside the ceiling — which is the whole
 * claim this change makes.
 */
test('the run that was lost on 2026-09-02 would now be delivered', () => {
  const perAttempt = attemptTimeoutMsFor(FLASH_MODEL, 4);
  const observedSuccessfulRetryMs = 24_700;

  assert.ok(
    observedSuccessfulRetryMs <= perAttempt,
    `a healthy four-photo call (${observedSuccessfulRetryMs}ms observed) must not be cut off by the clamp`
  );
  assert.ok(
    perAttempt + observedSuccessfulRetryMs < HOSTING_EDGE_TIMEOUT_MS,
    'a hung first attempt plus a healthy retry must still land inside 60s'
  );
});

test('a smaller set is not clamped, so the tier budgets still apply', () => {
  assert.equal(attemptTimeoutMsFor(FLASH_LITE_MODEL, 1), SUGGEST_ATTEMPT_TIMEOUT_MS);
  assert.equal(attemptTimeoutMsFor(FLASH_MODEL, 1), SUGGEST_ATTEMPT_TIMEOUT_MS_FLASH);
});

test('the Lite tier is chosen by the model id, not by an argument', () => {
  assert.ok(FLASH_LITE_MODEL.includes('lite'), 'the Lite id must remain detectable');
  assert.ok(!FLASH_MODEL.includes('lite'), 'the Flash id must not look like Lite');
  assert.ok(
    attemptTimeoutMsFor(FLASH_LITE_MODEL, 2) < attemptTimeoutMsFor(FLASH_MODEL, 2),
    'Lite reasons less, so it must get the smaller budget'
  );
});

test('the budget grows with photo count until it hits the clamp', () => {
  assert.ok(
    attemptTimeoutMsFor(FLASH_LITE_MODEL, 3) > attemptTimeoutMsFor(FLASH_LITE_MODEL, 1),
    'more images take longer to encode and the budget must say so'
  );
  assert.equal(
    attemptTimeoutMsFor(FLASH_LITE_MODEL, 0),
    attemptTimeoutMsFor(FLASH_LITE_MODEL, 1),
    'a nonsense photo count must not produce a smaller budget than one photo'
  );
});

test('a retry is only worth starting if it has time to finish', () => {
  assert.ok(SUGGEST_MIN_RETRY_MS > 0);
  assert.ok(
    SUGGEST_MIN_RETRY_MS < SUGGEST_TOTAL_BUDGET_MS / SUGGEST_MAX_ATTEMPTS,
    'the floor must not be so high that a normal retry is skipped'
  );
});

/**
 * Mirrors the shape the AI SDK's APICallError actually arrives in: an Error
 * carrying a `statusCode`. Built by hand rather than imported so these tests
 * describe the CONTRACT we depend on, not the SDK's current class.
 */
function apiError(statusCode: number): Error & { statusCode: number; isRetryable: boolean } {
  const err = new Error(`HTTP ${statusCode}`) as Error & {
    statusCode: number;
    isRetryable: boolean;
  };
  err.statusCode = statusCode;
  // The SDK's own default, verbatim: 408 || 409 || 429 || >= 500.
  err.isRetryable =
    statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500;
  return err;
}

function abortError(): Error {
  const err = new Error('The operation was aborted due to timeout');
  err.name = 'TimeoutError';
  return err;
}

/**
 * ══ THE 2026-09-03 REGRESSION ═══════════════════════════════════════════════
 *
 * Gemini answered `503 UNAVAILABLE` — "This model is currently experiencing
 * high demand. Spikes in demand are usually temporary. Please try again
 * later." Twice in one day, and neither was retried, because the policy knew
 * only about hangs. The shelter was told the analysis had simply failed.
 */
test('a provider overload is retried — it is not a flat failure', () => {
  assert.equal(isOverloadedFailure(apiError(503)), true);
  assert.equal(isRetryableFailure(apiError(503)), true);
  for (const status of [500, 502, 503, 504]) {
    assert.equal(isRetryableFailure(apiError(status)), true, `HTTP ${status}`);
  }

  // And if it survives every retry, it degrades rather than failing: Flash-Lite
  // is a different pool with 25x the free allowance, so it is very often up
  // when Flash is not. Without this the shelter still gets nothing.
  assert.equal(
    shouldFallBackToWeakerModel(apiError(503)),
    true,
    'a sustained overload must fall back to the weaker model, not give up'
  );
});

/**
 * ⚠️ The single most important assertion in this file.
 *
 * The AI SDK's own `isRetryable` flag defaults to `408 || 409 || 429 || >= 500`
 * — it says a 429 is retryable. Trusting that flag would retry an exhausted
 * daily quota against the SAME model, burning the budget the Flash-Lite
 * fallback needs, to reach a limit that does not refill for hours.
 */
test('a spent quota is NOT retried, even though the SDK flags it retryable', () => {
  const quota = apiError(429);

  assert.equal(quota.isRetryable, true, "the SDK's flag says retry");
  assert.equal(isRetryableFailure(quota), false, 'ours must not');
  assert.equal(isQuotaExhaustedFailure(quota), true);
  assert.equal(
    shouldFallBackToWeakerModel(quota),
    true,
    'it has a better remedy than a retry'
  );
});

test('a hang is retried, and immediately — there is nothing to wait for', () => {
  assert.equal(isTimeoutFailure(abortError()), true);
  assert.equal(isRetryableFailure(abortError()), true);
  assert.equal(retryBackoffMsFor(abortError()), 0);
});

test('an overload waits before retrying, because the pool is saturated now', () => {
  assert.ok(
    retryBackoffMsFor(apiError(503)) > 0,
    'retrying into the same instant is what is least likely to work'
  );
});

test('a request the provider rejected on its merits is never retried', () => {
  for (const status of [400, 401, 403, 413, 415]) {
    assert.equal(isRetryableFailure(apiError(status)), false, `HTTP ${status}`);
    assert.equal(shouldFallBackToWeakerModel(apiError(status)), false, `HTTP ${status}`);
  }
});

test('a failure with no status is not mistaken for an overload', () => {
  assert.equal(isOverloadedFailure(new Error('boom')), false);
  assert.equal(isOverloadedFailure(null), false);
  assert.equal(isOverloadedFailure(undefined), false);
  assert.equal(isOverloadedFailure('503'), false);
});

/**
 * The arithmetic that keeps a retried overload deliverable.
 *
 * Measured 2026-09-03: a four-photo Flash 503 came back in 14323ms. The
 * backoff plus a second full attempt has to still leave room for the
 * Flash-Lite fallback inside ONE shared budget — and the whole thing inside
 * Firebase Hosting's 60s ceiling.
 */
test('an overload, its retry and the weaker-model fallback all fit one budget', () => {
  const observed503Ms = 14_323;
  const flashAttempt = attemptTimeoutMsFor(FLASH_MODEL, 4);
  const liteAttempt = attemptTimeoutMsFor(FLASH_LITE_MODEL, 4);

  const usedByFlash =
    observed503Ms + SUGGEST_OVERLOAD_BACKOFF_MS + observed503Ms;
  const left = SUGGEST_TOTAL_BUDGET_MS - usedByFlash;

  assert.ok(
    left >= SUGGEST_MIN_RETRY_MS,
    `two 503s and a backoff must leave enough to fall back, had ${left}ms`
  );
  assert.ok(liteAttempt <= left, 'the fallback attempt must fit in what remains');
  assert.ok(
    usedByFlash + liteAttempt < HOSTING_EDGE_TIMEOUT_MS,
    'the whole operation must still be deliverable through Hosting'
  );
  assert.ok(flashAttempt > 0 && liteAttempt > 0);
});

test('the backoff cannot swallow a whole attempt', () => {
  assert.ok(
    SUGGEST_OVERLOAD_BACKOFF_MS < SUGGEST_MIN_RETRY_MS,
    'a pause longer than the retry floor would strand every retry'
  );
});

// ─── what the waiting UI is entitled to say ──────────────────────────────────
// AnalysisProgress shows a bar while the model looks at the photographs. The
// bar is a CLOCK, not a progress bar: /api/intake/suggest does not stream and
// reports no stages, so anything easing toward "done" would be an invented
// number. These pin exactly how much the browser is allowed to claim.

test('the waiting UI starts by claiming nothing but "first attempt"', () => {
  assert.equal(analysisPhaseFor(0, 4), 'first');
  assert.equal(analysisPhaseFor(1_000, 4), 'first');
});

test('"retrying" is only claimed once an attempt CANNOT still be running', () => {
  // The inference that makes this honest: attemptTimeoutMsFor clamps an
  // attempt, so one millisecond past that window the first attempt is over and
  // a second is genuinely under way. One millisecond BEFORE it, saying so
  // would be a guess about someone else's progress.
  const window = firstAttemptEndsAtMs(4);
  assert.equal(analysisPhaseFor(window - 1, 4), 'first');
  assert.equal(analysisPhaseFor(window, 4), 'retrying');
});

test('the attempt window is the LONGER, Flash-tier one', () => {
  // The browser cannot know which model the server picked — the ids come from
  // server-only env vars. Assuming Flash gives the longer window, so the UI
  // errs toward "still on the first attempt" rather than announcing a retry
  // that has not started. Claiming too little is the honest direction.
  assert.equal(firstAttemptEndsAtMs(4), attemptTimeoutMsFor(FLASH_MODEL, 4));
  assert.ok(
    firstAttemptEndsAtMs(4) >= attemptTimeoutMsFor(FLASH_LITE_MODEL, 4),
    'the UI must not use the shorter Lite window, or it would announce a retry too early',
  );
});

test('on the Flash tier the window IS the clamp, at every photo count', () => {
  // ⚠️ Measured, and it corrects what this test first claimed. The window does
  // NOT currently grow with photo count: SUGGEST_ATTEMPT_TIMEOUT_MS_FLASH is
  // 25000 and the affordable share of the budget is also 25000, so the clamp
  // binds at ONE photo and every count lands on the same number.
  //
  //     photos 1..8   flash window 25000   (lite 12000 → 25000)
  //
  // A `>=` assertion here was vacuously true and a break that pinned the count
  // to 1 went undetected. This asserts the real property instead — which is
  // also the one that matters, because a window equal to the affordable share
  // is exactly what guarantees SUGGEST_MAX_ATTEMPTS attempts fit the budget.
  const affordable = Math.floor(SUGGEST_TOTAL_BUDGET_MS / SUGGEST_MAX_ATTEMPTS);
  for (const photos of [1, 2, 3, 4, 8]) {
    assert.equal(
      firstAttemptEndsAtMs(photos),
      affordable,
      `${photos} photo(s) should be clamped to the affordable share`,
    );
  }
});

test('the photoCount argument is not decoration — it binds when the budget grows', () => {
  // The parameter is inert TODAY only because the clamp swallows it. It is
  // kept rather than hardcoded because the moment this call stops going
  // through Firebase Hosting the budget can rise, the clamp stops binding, and
  // the window becomes photo-count dependent again. Hardcoding 25000 now would
  // make the waiting UI quietly wrong then.
  //
  // Demonstrated on the Lite tier, where the clamp does not bind at low counts.
  assert.ok(
    attemptTimeoutMsFor(FLASH_LITE_MODEL, 4) > attemptTimeoutMsFor(FLASH_LITE_MODEL, 1),
    'the underlying function must still scale with photo count',
  );
});

test('"nearly-up" lands exactly at the budget the server gives up at', () => {
  // Not a moment earlier: telling someone the wait is over while the server is
  // still working is the same class of lie as a fake progress bar.
  assert.equal(analysisPhaseFor(SUGGEST_TOTAL_BUDGET_MS - 1, 4), 'retrying');
  assert.equal(analysisPhaseFor(SUGGEST_TOTAL_BUDGET_MS, 4), 'nearly-up');
  assert.equal(analysisPhaseFor(SUGGEST_TOTAL_BUDGET_MS * 3, 4), 'nearly-up');
});

test('every phase is reachable during a real four-photo wait', () => {
  // A phase that can never be shown is dead copy pretending to be a state.
  const seen = new Set<string>();
  for (let ms = 0; ms <= SUGGEST_TOTAL_BUDGET_MS + 1000; ms += 250) {
    seen.add(analysisPhaseFor(ms, 4));
  }
  assert.deepEqual([...seen].sort(), ['first', 'nearly-up', 'retrying']);
});

test('the clock never runs past the ceiling it draws against', () => {
  // The bar is elapsed/budget, capped at 100% in the component. This pins the
  // relationship the cap depends on: the budget is the whole of what the
  // server will spend, so the bar cannot be asked to represent more.
  assert.ok(firstAttemptEndsAtMs(8) <= SUGGEST_TOTAL_BUDGET_MS);
});
