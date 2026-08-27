/**
 * Types for `pricing.mjs`. The implementation is deliberately `.mjs` so that
 * offline scripts and the app share one price table — see that file's header.
 */

export interface ModelRate {
  inputPer1M: number;
  outputPer1M: number;
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

/** Callable with this key but lacking a bill-derived price row. */
export declare const UNPRICED_BUT_AVAILABLE: readonly string[];
