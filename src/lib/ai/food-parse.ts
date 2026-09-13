import 'server-only';

import { generateObject } from 'ai';

import { google } from './google';
import { FOOD_PARSE_MODEL_LADDER, modelKeyFor } from './model-ids';
import { DonationParseSchema } from './food-parse-schema';
import { FOOD_PARSE_SYSTEM, foodParseUserMessage } from './food-parse-prompt';
import { recordAiUsage, type AiProcess } from './metered';
import {
  SUGGEST_MAX_ATTEMPTS,
  SUGGEST_MIN_RETRY_MS,
  isOverloadedFailure,
  isRetryableFailure,
  isTimeoutFailure,
  retryBackoffMsFor,
  walkModelLadder,
} from './suggest-budget';
import type { RawParsedDonation } from '../food-parse';

export { FOOD_PARSE_MODEL_LADDER } from './model-ids';

/**
 * Donation parsing: the model call. Build-order step 13, plan §12.1.
 *
 * What the answer is ALLOWED to do lives in `src/lib/food-parse.ts`, pure and
 * tested — grounding, the toxic default, the quantity arithmetic. This file
 * only obtains the answer.
 *
 * ── Budget ──────────────────────────────────────────────────────────────────
 * Reuses the intake route's measured envelope: `walkModelLadder` holds ONE
 * deadline of `SUGGEST_TOTAL_BUDGET_MS` (50 s) across the whole walk, under
 * Firebase Hosting's 60 s ceiling. A short text on Flash-Lite answers in a few
 * seconds, so each attempt gets `FOOD_PARSE_ATTEMPT_TIMEOUT_MS` and a timeout
 * or an overload gets one retry on the same model, exactly as intake does.
 *
 * ── No tools, no grounding ─────────────────────────────────────────────────
 * Grounded search is ruled out project-wide. Nothing here needs the web.
 */

/**
 * Per attempt. Not measured on this path yet — the eval harness prints the
 * latency of every run so it can be. Generous against the few seconds a text
 * call takes on Lite, and two attempts plus a backoff still fit the 50 s total.
 */
export const FOOD_PARSE_ATTEMPT_TIMEOUT_MS = 15_000;

export interface FoodParseOptions {
  /** Pin the ladder. The eval harness passes one id so it measures what it names. */
  models?: readonly string[];
  /** Budget line. Defaults to the shelter's own; the eval passes `food_parse_eval`. */
  process?: AiProcess;
}

export interface FoodParseResult {
  parsed: RawParsedDonation;
  /** Stable model KEY for provenance, never the raw id. */
  modelKey: string;
}

function describeFailure(err: unknown): string {
  if (isTimeoutFailure(err)) return 'timed out';
  if (isOverloadedFailure(err)) return 'reported overload';
  return 'failed';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Throws on failure; the route decides what a failure means (blank lines to type). */
export async function parseDonationText(
  text: string,
  options: FoodParseOptions = {}
): Promise<FoodParseResult> {
  const ladder = options.models ?? FOOD_PARSE_MODEL_LADDER;
  const proc = options.process ?? 'food_parse';

  // ⚠️ `walkModelLadder` is shared with production photo intake and is used
  // here UNCHANGED. Its fallback log line says "[intake-suggest]"; with today's
  // one-tier ladder that line is unreachable, because a fallback needs a second
  // tier. Give the ladder a second tier and its fallback will log under that
  // name — change the log there on purpose rather than in passing.
  return walkModelLadder(ladder, (model, deadline) => parseWith(model, text, deadline, proc), {
    describe: describeFailure,
  });
}

async function parseWith(
  modelId: string,
  text: string,
  deadline: number,
  proc: AiProcess
): Promise<FoodParseResult> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= SUGGEST_MAX_ATTEMPTS; attempt++) {
    const started = Date.now();
    try {
      const { object, usage, providerMetadata } = await generateObject({
        model: google(modelId),
        schema: DonationParseSchema,
        system: FOOD_PARSE_SYSTEM,
        prompt: foodParseUserMessage(text),
        // A FRESH signal per attempt, trimmed to what is left of the one
        // shared deadline — the lesson of 2026-08-30, where one signal across
        // attempts made the retry unreachable.
        abortSignal: AbortSignal.timeout(Math.min(FOOD_PARSE_ATTEMPT_TIMEOUT_MS, deadline - started)),
        // This loop owns retrying; nesting the SDK's own would make timing
        // impossible to reason about.
        maxRetries: 0,
      });

      // void, never awaited: metering must not be able to break or slow the
      // thing it measures.
      void recordAiUsage({ process: proc, model: modelId, usage, providerMetadata });

      const parsed: RawParsedDonation = object;
      return { parsed, modelKey: String(modelKeyFor(modelId)) };
    } catch (err) {
      lastErr = err;
      if (!isRetryableFailure(err) || attempt === SUGGEST_MAX_ATTEMPTS) throw err;

      const backoffMs = retryBackoffMsFor(err);
      const left = deadline - Date.now() - backoffMs;
      const elapsed = Date.now() - started;
      if (left < SUGGEST_MIN_RETRY_MS) {
        console.warn(
          `[food-parse] attempt ${attempt}/${SUGGEST_MAX_ATTEMPTS} ${describeFailure(err)} after ${elapsed}ms; only ${left}ms left, not retrying`
        );
        throw err;
      }
      console.warn(
        `[food-parse] attempt ${attempt}/${SUGGEST_MAX_ATTEMPTS} ${describeFailure(err)} after ${elapsed}ms; retrying in ${backoffMs}ms with ${left}ms left`
      );
      if (backoffMs > 0) await sleep(backoffMs);
    }
  }
  throw lastErr;
}
