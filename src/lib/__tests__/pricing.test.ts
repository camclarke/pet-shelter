import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FALLBACK_PRICING,
  GROUNDING_USD_PER_REQUEST,
  MODEL_PRICING,
  countGroundedQueries,
  estimateCostUsd,
  hasPricingRow,
} from '../ai/pricing.mjs';

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
