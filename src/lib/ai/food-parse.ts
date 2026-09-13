import 'server-only';

import { generateObject } from 'ai';

import { google } from './google';
import { FOOD_PARSE_MODEL_LADDER, modelKeyFor } from './model-ids';
import { DonationParseSchema } from './food-parse-schema';
import { FOOD_PARSE_SYSTEM, foodParseUserMessage } from './food-parse-prompt';
import { recordAiUsage, type AiProcess } from './metered';
import { describeFailure, retryWithinDeadline, walkModelLadder } from './suggest-budget';
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
 * Reuses the intake route's measured envelope, and its CODE rather than a copy
 * of it: `walkModelLadder` holds ONE deadline of `SUGGEST_TOTAL_BUDGET_MS`
 * (50 s) across the whole walk, under Firebase Hosting's 60 s ceiling, and
 * `retryWithinDeadline` gives a timeout or an overload one retry on the same
 * model, exactly as intake and card extraction do.
 *
 * ⚠️ Until 2026-09-13 this file carried its own copy of that retry loop. A
 * second copy of a retry policy is how the 2026-08-30 "retry that could never
 * run" bug gets reintroduced, in the copy nobody remembered to fix.
 * `food-parse.test.ts` fails if the loop comes back.
 *
 * ── No tools, no grounding ─────────────────────────────────────────────────
 * Grounded search is ruled out project-wide. Nothing here needs the web.
 */

/** Log prefix, for the retry and the ladder alike. */
const LOG = '[food-parse]';

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
  /**
   * An EARLIER deadline than the walk would start for itself — see
   * `walkModelLadder`. The route passes request arrival + the total budget,
   * because Hosting's 60 s runs from there and the token check and the body
   * read come first. A later value is ignored.
   */
  deadline?: number;
}

export interface FoodParseResult {
  parsed: RawParsedDonation;
  /** Stable model KEY for provenance, never the raw id. */
  modelKey: string;
}

/** Throws on failure; the route decides what a failure means (blank lines to type). */
export async function parseDonationText(
  text: string,
  options: FoodParseOptions = {}
): Promise<FoodParseResult> {
  const ladder = options.models ?? FOOD_PARSE_MODEL_LADDER;
  const proc = options.process ?? 'food_parse';

  return walkModelLadder(ladder, (model, deadline) => parseWith(model, text, deadline, proc), {
    describe: describeFailure,
    label: LOG,
    deadline: options.deadline,
  });
}

async function parseWith(
  modelId: string,
  text: string,
  deadline: number,
  proc: AiProcess
): Promise<FoodParseResult> {
  const { object, usage, providerMetadata } = await retryWithinDeadline(
    deadline,
    FOOD_PARSE_ATTEMPT_TIMEOUT_MS,
    (budgetMs) =>
      generateObject({
        model: google(modelId),
        schema: DonationParseSchema,
        system: FOOD_PARSE_SYSTEM,
        prompt: foodParseUserMessage(text),
        // A FRESH signal per attempt, sized by retryWithinDeadline to what is
        // left of the one shared deadline. Hoisting it out of this callback
        // would restore the single budget that made a retry unreachable on
        // 2026-08-30.
        abortSignal: AbortSignal.timeout(budgetMs),
        // retryWithinDeadline owns retrying; nesting the SDK's own policy would
        // make the timing impossible to reason about.
        maxRetries: 0,
      }),
    { describe: describeFailure, label: LOG }
  );

  // void, never awaited: metering must not be able to break or slow the thing
  // it measures.
  void recordAiUsage({ process: proc, model: modelId, usage, providerMetadata });

  const parsed: RawParsedDonation = object;
  return { parsed, modelKey: String(modelKeyFor(modelId)) };
}
