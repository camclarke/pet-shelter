/**
 * Gemini price table and cost estimation. Pure, no I/O, unit-tested.
 *
 * ── Why this is .mjs and not .ts ─────────────────────────────────────────────
 * Playbook §2.2: any constant whose mismatch is SILENT lives in `.mjs` so that
 * offline scripts and the app import the SAME value instead of hand-copying it.
 * A wrong price is exactly that kind of constant — nothing throws, nothing logs,
 * the dashboard is simply wrong. The sibling stack under-reported spend ~9×
 * ($19 estimated against $178 billed) with a table of plausible proxies.
 *
 * ── Provenance of these numbers ──────────────────────────────────────────────
 * BILL-DERIVED, but from the sibling stack's invoice, not from this project's.
 * They were back-computed as (SKU usage cost ÷ SKU usage count) and every rate
 * landed on a clean round number, which is good evidence they are real list
 * rates — and list rates transfer between projects. They are still a HYPOTHESIS
 * here until `wawitas` has an invoice of its own. Re-derive from
 * Cloud Billing → Reports → group by SKU the moment one exists, per §3.2.
 */

/** @type {Record<string, { inputPer1M: number, outputPer1M: number }>} */
export const MODEL_PRICING = {
  'gemini-3.6-flash': { inputPer1M: 1.5, outputPer1M: 7.5 },
  'gemini-3.5-flash': { inputPer1M: 1.5, outputPer1M: 9.0 },
  'gemini-3.1-flash-lite': { inputPer1M: 0.25, outputPer1M: 1.5 },
  'gemini-3.1-pro-preview': { inputPer1M: 2.0, outputPer1M: 12.0 },
  'gemini-embedding-2': { inputPer1M: 0.2, outputPer1M: 0.0 },

  // ⚠️ 404 "no longer available to new users" for THIS project’s key,
  // verified 2026-08-26. Rows kept rather than deleted: deleting one means
  // an accidental call is costed at the Flash fallback instead of its real
  // rate, which is a worse failure than a row nobody uses.
  'gemini-2.5-flash': { inputPer1M: 0.3, outputPer1M: 2.5 },
  'gemini-2.5-flash-lite': { inputPer1M: 0.1, outputPer1M: 0.4 },
};

/**
 * Models this key can call that have NO bill-derived row yet, so they are
 * costed at the Flash fallback and will read far too expensive.
 *
 * `gemini-3.5-flash-lite` is the main one, and it is a genuine candidate:
 * measured at 1252ms with 0 thinking tokens, essentially matching
 * gemini-3.1-flash-lite. It is not adopted only because its real price is
 * unknown here, and the playbook rule is to add the row BEFORE swapping.
 */
export const UNPRICED_BUT_AVAILABLE = ['gemini-3.5-flash-lite', 'gemini-3.7-flash'];

/**
 * Assume Flash, NEVER zero. An unknown model reporting $0 is indistinguishable
 * from a model that was never called, which hides exactly the spend you would
 * want to see. Over-reporting is the safe direction here.
 *
 * ⚠️ Add the row for a new model BEFORE swapping to it. An unlisted model is
 * costed at Flash rates, which on a cheap model is a large over-report on the
 * very dashboard you would use to confirm the migration.
 */
export const FALLBACK_PRICING = { inputPer1M: 1.5, outputPer1M: 9.0 };

/**
 * Grounded search is billed PER SEARCH QUERY, carries zero tokens, and is
 * therefore invisible to token-based metering.
 *
 * ⚠️ Grounding is RULED OUT in this project as a standing constraint, not a
 * deferral — nothing here needs the web, and it was 73% of one month's bill on
 * the sibling stack. This constant exists so that if grounding is ever switched
 * on by accident, it shows up on the dashboard instead of costing nothing
 * visible. Do not read its presence as permission.
 */
export const GROUNDING_USD_PER_REQUEST = 0.014;

/**
 * Count grounded search queries out of provider metadata. Metadata always wins
 * over a caller-supplied count, because the caller is guessing and the provider
 * is reporting.
 *
 * @param {unknown} providerMetadata
 * @returns {number}
 */
export function countGroundedQueries(providerMetadata) {
  if (providerMetadata == null || typeof providerMetadata !== 'object') return 0;
  const google = /** @type {Record<string, any>} */ (providerMetadata).google;
  if (google == null || typeof google !== 'object') return 0;
  const queries = google.groundingMetadata?.webSearchQueries;
  return Array.isArray(queries) ? queries.length : 0;
}

/**
 * ⚠️ `reasoningTokens` are billed at the OUTPUT rate and MUST be included.
 *
 * Gemini 3.x reasons by default and reports thinking separately from the
 * visible answer — the provider returns `thoughtsTokenCount` alongside
 * `candidatesTokenCount`, and they are additive, not overlapping. Measured
 * on gemini-3.6-flash 2026-08-26: a ONE-token reply carried 168 thinking
 * tokens. Costing only the visible output under-reports by ~100x on this
 * model — the same shape as the sibling stack’s 9x under-report, worse.
 *
 * `maxOutputTokens` does NOT bound thinking. A budget of 16 produced
 * finishReason MAX_TOKENS, 13 thinking tokens and no answer at all.
 *
 * @param {{ model: string, inputTokens?: number, outputTokens?: number, reasoningTokens?: number, groundingRequests?: number }} args
 * @returns {number} estimated USD
 */
export function estimateCostUsd({
  model,
  inputTokens = 0,
  outputTokens = 0,
  reasoningTokens = 0,
  groundingRequests = 0,
}) {
  const p = MODEL_PRICING[model] ?? FALLBACK_PRICING;
  return (
    (inputTokens / 1e6) * p.inputPer1M +
    ((outputTokens + reasoningTokens) / 1e6) * p.outputPer1M +
    groundingRequests * GROUNDING_USD_PER_REQUEST
  );
}

/** True when this model has a real row rather than falling back. */
export function hasPricingRow(model) {
  return Object.prototype.hasOwnProperty.call(MODEL_PRICING, model);
}
