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

/**
 * Where a row's numbers came from. Three states, not two, because "we have a
 * row" and "we know the price" are different claims and conflating them is how
 * a guessed rate starts reading as a measurement.
 *
 *   'bill'     back-computed from a real invoice. Trustworthy.
 *   'estimate' a DOCUMENTED guess, deliberately pinned to the highest Flash
 *              rate we have evidence for so it can only ever OVER-report.
 *   'fallback' no row at all — estimateCostUsd used FALLBACK_PRICING.
 *
 * @typedef {'bill' | 'estimate' | 'fallback'} PricingSource
 */

/** @type {Record<string, { inputPer1M: number, outputPer1M: number, source: 'bill' | 'estimate' }>} */
export const MODEL_PRICING = {
  'gemini-3.6-flash': { inputPer1M: 1.5, outputPer1M: 7.5, source: 'bill' },
  'gemini-3.5-flash': { inputPer1M: 1.5, outputPer1M: 9.0, source: 'bill' },
  'gemini-3.1-flash-lite': { inputPer1M: 0.25, outputPer1M: 1.5, source: 'bill' },
  'gemini-3.1-pro-preview': { inputPer1M: 2.0, outputPer1M: 12.0, source: 'bill' },
  'gemini-embedding-2': { inputPer1M: 0.2, outputPer1M: 0.0, source: 'bill' },

  // ── ESTIMATES, not bill-derived. Read the reasoning before trusting them ──
  //
  // Added 2026-09-10 so the three-tier Flash cascade does not run its PRIMARY
  // model unpriced. An unpriced primary means every successful call is costed
  // at a rate nobody chose, on the very dashboard you would use to notice a
  // surprise — which is the $665-month / 9x-under-report failure in
  // docs/gemini-api-playbook.md.
  //
  // The numbers are NOT a guess at what these models cost. They are the
  // HIGHEST Flash-tier rate this table has bill-derived evidence for
  // (gemini-3.5-flash, $1.5 / $9.0), chosen precisely because it cannot
  // under-report relative to anything we actually know. If the real rate is
  // lower — and 3.6-flash's $7.5 output suggests it may be — the dashboard
  // reads too expensive, which is the safe direction and a knowable one.
  //
  // ⚠️ Replace both rows the moment an invoice exists, and flip `source` to
  // 'bill' at the same time. Cloud Billing → Reports → group by SKU, per §3.2.
  // ⚠️ Note the bill will NOT be on `wawitas`: the AI Studio key belongs to
  // `gen-lang-client-0564433675` with billing disabled, so there is no invoice
  // at all while the free tier holds. These stay estimates until that changes.
  'gemini-3.8-flash': { inputPer1M: 1.5, outputPer1M: 9.0, source: 'estimate' },
  'gemini-3.7-flash': { inputPer1M: 1.5, outputPer1M: 9.0, source: 'estimate' },

  // ⚠️ 404 "no longer available to new users" for THIS project’s key,
  // verified 2026-08-26. Rows kept rather than deleted: deleting one means
  // an accidental call is costed at the Flash fallback instead of its real
  // rate, which is a worse failure than a row nobody uses.
  'gemini-2.5-flash': { inputPer1M: 0.3, outputPer1M: 2.5, source: 'bill' },
  'gemini-2.5-flash-lite': { inputPer1M: 0.1, outputPer1M: 0.4, source: 'bill' },
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
export const UNPRICED_BUT_AVAILABLE = [
  'gemini-3.5-flash-lite',
  // Audio is charged per token like anything else, but no bill-derived
  // rate exists for this model here. It will read at the Flash fallback,
  // i.e. TOO EXPENSIVE, until a real invoice says otherwise. Over-reporting
  // is the safe direction; do not "fix" it with a guess.
  'gemini-3.5-transcribe',
];

// ⚠️ `gemini-3.7-flash` was on the list above until 2026-09-10 and is not any
// more. It now carries an ESTIMATE row, which costs it at exactly the rate the
// fallback would have — the number did not change, only whether the table is
// honest about having made a choice. `gemini-3.8-flash` never reached this
// list: it went straight to an estimate row, because it is the cascade's
// primary and a primary must never be unpriced.

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

/** True when this model has a row of any kind rather than falling back. */
export function hasPricingRow(model) {
  return Object.prototype.hasOwnProperty.call(MODEL_PRICING, model);
}

/**
 * Where this model's cost figure came from — 'bill', 'estimate' or 'fallback'.
 *
 * ⚠️ Strictly more informative than `hasPricingRow`, and the reason it exists:
 * once a row can be a documented guess, a boolean saying "it has a row" reads
 * as "we know the price". A dashboard that cannot tell an invoice-derived
 * number from a guess is the dashboard that let a 9x under-report stand for
 * months on the sibling stack.
 *
 * @param {string} model
 * @returns {'bill' | 'estimate' | 'fallback'}
 */
export function pricingSourceFor(model) {
  return MODEL_PRICING[model]?.source ?? 'fallback';
}
