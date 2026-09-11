import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FALLBACK_PRICING,
  GROUNDING_USD_PER_REQUEST,
  MODEL_PRICING,
  UNPRICED_BUT_AVAILABLE,
  countGroundedQueries,
  estimateCostUsd,
  hasPricingRow,
  pricingSourceFor,
} from '../ai/pricing.mjs';
import { FLASH_MODEL } from '../ai/model-ids';

const FLASH = 'gemini-3.6-flash';

test('a known model is costed from its own row', () => {
  const cost = estimateCostUsd({ model: FLASH, inputTokens: 1_000_000, outputTokens: 0 });
  assert.equal(cost, MODEL_PRICING[FLASH]!.inputPer1M);
});

test('input and output are costed at different rates', () => {
  const inOnly = estimateCostUsd({ model: FLASH, inputTokens: 1_000_000 });
  const outOnly = estimateCostUsd({ model: FLASH, outputTokens: 1_000_000 });
  assert.notEqual(inOnly, outOnly);
  assert.ok(outOnly > inOnly, 'output should cost more than input on Flash');
});

test('an UNKNOWN model never costs zero — it falls back to Flash tier', () => {
  // The whole point: a model reporting $0 is indistinguishable from a model
  // that was never called, which hides exactly the spend you want to see.
  const cost = estimateCostUsd({
    model: 'gemini-9.9-does-not-exist',
    inputTokens: 1_000_000,
  });
  assert.ok(cost > 0);
  assert.equal(cost, FALLBACK_PRICING.inputPer1M);
});

test('hasPricingRow distinguishes a real row from the fallback', () => {
  assert.equal(hasPricingRow(FLASH), true);
  assert.equal(hasPricingRow('gemini-9.9-does-not-exist'), false);
});

test('zero usage costs zero', () => {
  assert.equal(estimateCostUsd({ model: FLASH }), 0);
});

test('grounded queries are billed per query, on top of tokens', () => {
  const cost = estimateCostUsd({ model: FLASH, groundingRequests: 3 });
  assert.equal(cost, 3 * GROUNDING_USD_PER_REQUEST);
});

test('grounding carries no tokens, so token metering alone would report zero', () => {
  // This is the structural blindness the constant exists to defeat: a grounded
  // call with no tokens is free as far as tokens are concerned.
  const tokensOnly = estimateCostUsd({ model: FLASH, inputTokens: 0, outputTokens: 0 });
  const withGrounding = estimateCostUsd({ model: FLASH, groundingRequests: 1 });
  assert.equal(tokensOnly, 0);
  assert.ok(withGrounding > 0);
});

test('countGroundedQueries reads the provider metadata shape', () => {
  const meta = {
    google: { groundingMetadata: { webSearchQueries: ['a', 'b'] } },
  };
  assert.equal(countGroundedQueries(meta), 2);
});

test('countGroundedQueries is zero for the shapes we actually expect', () => {
  // Grounding is ruled out in this project, so every real call returns one of
  // these. None of them may throw.
  assert.equal(countGroundedQueries(undefined), 0);
  assert.equal(countGroundedQueries(null), 0);
  assert.equal(countGroundedQueries({}), 0);
  assert.equal(countGroundedQueries({ google: {} }), 0);
  assert.equal(countGroundedQueries({ google: { groundingMetadata: {} } }), 0);
  assert.equal(countGroundedQueries('nonsense'), 0);
});

test('every priced model has non-negative rates', () => {
  for (const [model, rate] of Object.entries(MODEL_PRICING)) {
    assert.ok(rate.inputPer1M >= 0, `${model} input rate`);
    assert.ok(rate.outputPer1M >= 0, `${model} output rate`);
  }
});

test('the fallback is a real Flash-tier rate, not zero', () => {
  assert.ok(FALLBACK_PRICING.inputPer1M > 0);
  assert.ok(FALLBACK_PRICING.outputPer1M > 0);
});

// ─── reasoning tokens ────────────────────────────────────────────────────────
// Measured on gemini-3.6-flash 2026-08-26: a ONE-token reply carried 168
// thinking tokens. These are billed as output, and omitting them under-reports
// by ~100x on this model.

test('reasoning tokens are billed, at the OUTPUT rate', () => {
  const withReasoning = estimateCostUsd({ model: FLASH, reasoningTokens: 1_000_000 });
  const asOutput = estimateCostUsd({ model: FLASH, outputTokens: 1_000_000 });
  assert.equal(withReasoning, asOutput);
});

test('reasoning is ADDITIVE to visible output, not overlapping', () => {
  // The provider reports thoughtsTokenCount and candidatesTokenCount
  // separately, and totalTokenCount is their sum plus the prompt.
  const both = estimateCostUsd({ model: FLASH, outputTokens: 500, reasoningTokens: 500 });
  const merged = estimateCostUsd({ model: FLASH, outputTokens: 1000 });
  assert.equal(both, merged);
});

test('the real measured call is not costed as though thinking were free', () => {
  // promptTokenCount 6, candidatesTokenCount 1, thoughtsTokenCount 168.
  const honest = estimateCostUsd({
    model: FLASH,
    inputTokens: 6,
    outputTokens: 1,
    reasoningTokens: 168,
  });
  const ignoringThinking = estimateCostUsd({ model: FLASH, inputTokens: 6, outputTokens: 1 });
  assert.ok(honest > ignoringThinking);
  // Not a rounding error: dropping thinking would under-report by >50x here.
  assert.ok(honest / ignoringThinking > 50, `ratio was ${honest / ignoringThinking}`);
});

test('omitting reasoningTokens still costs the visible output correctly', () => {
  // Back-compat: callers that never pass it must not silently change price.
  assert.equal(
    estimateCostUsd({ model: FLASH, inputTokens: 10, outputTokens: 20 }),
    estimateCostUsd({ model: FLASH, inputTokens: 10, outputTokens: 20, reasoningTokens: 0 })
  );
});

// ─── pricing provenance ──────────────────────────────────────────────────────
// Added 2026-09-10 with the three-tier Flash cascade. A row can now be a
// documented ESTIMATE rather than bill-derived, so "has a row" and "we know the
// price" stopped being the same claim.

test('pricingSourceFor distinguishes bill, estimate and fallback', () => {
  assert.equal(pricingSourceFor('gemini-3.6-flash'), 'bill');
  assert.equal(pricingSourceFor('gemini-3.8-flash'), 'estimate');
  assert.equal(pricingSourceFor('gemini-9.9-does-not-exist'), 'fallback');
});

test('an ESTIMATE can never under-report against the fallback it replaced', () => {
  // The safety property the estimated rows are chosen for. An estimate that
  // costs LESS than the Flash fallback would make a migration look cheaper
  // than it is on the very dashboard used to confirm it — the shape of the
  // sibling stack's 9x under-report.
  for (const [model, rate] of Object.entries(MODEL_PRICING)) {
    if (rate.source !== 'estimate') continue;
    assert.ok(
      rate.inputPer1M >= FALLBACK_PRICING.inputPer1M,
      `${model} input rate ${rate.inputPer1M} is BELOW the fallback ${FALLBACK_PRICING.inputPer1M}`,
    );
    assert.ok(
      rate.outputPer1M >= FALLBACK_PRICING.outputPer1M,
      `${model} output rate ${rate.outputPer1M} is BELOW the fallback ${FALLBACK_PRICING.outputPer1M}`,
    );
  }
});

test('every row declares where its numbers came from', () => {
  // A row with no `source` would silently read as 'fallback' through
  // pricingSourceFor, i.e. as though it had no row at all.
  for (const [model, rate] of Object.entries(MODEL_PRICING)) {
    assert.ok(
      rate.source === 'bill' || rate.source === 'estimate',
      `${model} has no pricing source`,
    );
  }
});

test('a model cannot be both priced and listed as unpriced', () => {
  // The two lists contradicting each other is how gemini-3.7-flash would have
  // ended up costed from a row while the table still advertised it as having
  // none.
  for (const model of UNPRICED_BUT_AVAILABLE) {
    assert.equal(
      hasPricingRow(model),
      false,
      `${model} is in UNPRICED_BUT_AVAILABLE but has a row in MODEL_PRICING`,
    );
  }
});

test('the PRIMARY intake model is never unpriced', () => {
  // ⚠️ The guard that matters. If the primary falls back, EVERY successful
  // suggestion is metered at a rate nobody chose — and the primary is the one
  // model that runs on every intake. Swapping GEMINI_FLASH_MODEL to something
  // with no row must fail here rather than on an invoice months later.
  assert.ok(
    hasPricingRow(FLASH_MODEL),
    `the configured primary ${FLASH_MODEL} has no pricing row — add one before swapping to it`,
  );
});
