/**
 * Types for `pricing.mjs`. The implementation is deliberately `.mjs` so that
 * offline scripts and the app share one price table — see that file's header.
 */

/**
 * Where a cost figure came from. Three states, not two: "we have a row" and
 * "we know the price" are different claims once a row can be a documented
 * estimate.
 */
export type PricingSource = 'bill' | 'estimate' | 'fallback';

export interface ModelRate {
  inputPer1M: number;
  outputPer1M: number;
  /** Absent only on FALLBACK_PRICING, which is a fallback by definition. */
  source?: Exclude<PricingSource, 'fallback'>;
}

export declare const MODEL_PRICING: Record<string, ModelRate>;
export declare const FALLBACK_PRICING: ModelRate;
export declare const GROUNDING_USD_PER_REQUEST: number;

export declare function countGroundedQueries(providerMetadata: unknown): number;

export declare function estimateCostUsd(args: {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Billed at the OUTPUT rate. Omitting these under-reports badly. */
  reasoningTokens?: number;
  groundingRequests?: number;
}): number;

export declare function hasPricingRow(model: string): boolean;

/**
 * Where this model's cost figure came from. Prefer this over `hasPricingRow`
 * anywhere the answer is shown or logged — a boolean cannot distinguish an
 * invoice-derived rate from a documented guess.
 */
export declare function pricingSourceFor(model: string): PricingSource;

/** Callable with this key but lacking a bill-derived price row. */
export declare const UNPRICED_BUT_AVAILABLE: readonly string[];
