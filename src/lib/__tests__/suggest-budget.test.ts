import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HOSTING_EDGE_TIMEOUT_MS,
  SUGGEST_ATTEMPT_TIMEOUT_MS,
  SUGGEST_ATTEMPT_TIMEOUT_MS_FLASH,
  SUGGEST_MAX_ATTEMPTS,
  SUGGEST_MIN_RETRY_MS,
  SUGGEST_TOTAL_BUDGET_MS,
  attemptTimeoutMsFor,
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
