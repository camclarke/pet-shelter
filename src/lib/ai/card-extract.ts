import 'server-only';

import { generateObject } from 'ai';
import { z } from 'zod';

import { google } from './google';
import { CARD_MODEL_LADDER, modelKeyFor } from './model-ids';
// The prompt lives in its own module so the unit-test suite can read it —
// `server-only` throws outside a server context. Same reason as intake-prompt.ts.
import { CARD_EXTRACT_SYSTEM, CARD_USER_INSTRUCTION } from './card-prompt';
import { recordAiUsage, type AiProcess } from './metered';
import type { RawCardExtraction } from '../card-extraction';
import {
  attemptTimeoutMsFor,
  describeFailure,
  retryWithinDeadline,
  walkModelLadder,
} from './suggest-budget';

export { CARD_EXTRACT_SYSTEM, CARD_USER_INSTRUCTION } from './card-prompt';
export { CARD_MODEL_LADDER } from './model-ids';

/**
 * Vaccination-card extraction: the model call. Build-order step 9, plan §4.3.
 *
 * What the answer is WORTH lives in `src/lib/card-extraction.ts`, pure and
 * tested. This file only obtains it — the same split as `intake-suggest.ts`,
 * and it reuses that path's proven machinery rather than a copy: the model
 * ladder walked under ONE deadline (`walkModelLadder`), the same retry policy
 * (`retryWithinDeadline`), the same per-attempt clamp, the same metering.
 *
 * ── One extractor, not two ──────────────────────────────────────────────────
 * Plan §4.6 makes two-extractor consensus phase 2 for cards, for a reason
 * specific to this flow: every record is reviewed by a person with the card in
 * their hand before it counts, so the scarce resource is their attention, not
 * a second model's verdict. Measure how often review catches something first.
 * Dictation (plan §4.7) is different and runs two.
 *
 * ── Grounded search is OFF, and that is structural ──────────────────────────
 * No tools are passed. Grounding is billed per search query, carries zero
 * tokens so token metering is blind to it, and reading a card needs no web.
 * Playbook §5.3 records grounding creeping back through an unrelated commit and
 * running unnoticed for five weeks — do not add `tools` here.
 *
 * ── Inline image, never the Files API ───────────────────────────────────────
 * Plan §4.5. A card photo re-encoded at a 2048 px long edge is well under a
 * megabyte, far below the ~20 MB inline ceiling. AI SDK v6 image parts take
 * `mediaType`, not `mimeType` — the latter type-checks and throws at runtime.
 */

const Field = z.object({
  snippet: z.string().nullable(),
  // Deliberately NOT `.min(0).max(1)`. A schema that rejects one confidence of
  // 1.2 throws away the whole card; the pure layer turns an out-of-range value
  // into 0, which withholds that ONE field. Same reasoning as intake's loose
  // name list.
  confidence: z.number(),
});

/**
 * Exported so the eval harness measures the real request shape. Read-only for
 * callers: production's single use is the `generateObject` below.
 *
 * No `.max()` on rows either, for the reason on `confidence`: the pure layer
 * caps rows and counts what it drops.
 */
export const CardExtractionSchema = z.object({
  isVaccinationCard: z.boolean(),
  rows: z.array(
    z.object({
      kind: z.object({
        value: z.enum(['vaccination', 'deworming']).nullable(),
        snippet: z.string().nullable(),
        confidence: z.number(),
      }),
      name: Field,
      performedAt: Field,
      nextDueAt: Field,
      batch: Field,
      manufacturer: Field,
      veterinarian: Field,
      clinic: Field,
    })
  ),
});

/**
 * Ties the schema to the pure layer's input type. If the two drift — a field
 * renamed on one side — this stops compiling rather than handing the reviewer
 * an extraction the policy layer silently reads as empty.
 */
function asRaw(object: z.infer<typeof CardExtractionSchema>): RawCardExtraction {
  return object;
}

const LOG = '[card-extract]';

export interface CardImage {
  bytes: Uint8Array;
  mediaType: string;
}

/**
 * Knobs production leaves at their defaults. The eval harness pins `models` so
 * a tier fallback cannot make a benchmark of model A report model B's answer,
 * and meters under `card_extract_eval`. The route passes `deadline`.
 */
export interface CardExtractOptions {
  models?: readonly string[];
  process?: AiProcess;
  /**
   * When the whole request must be finished by. Can only SHORTEN the budget —
   * see walkModelLadder. The route passes request arrival + the total budget,
   * because Firebase Hosting's 60 s runs from the first byte, not from here.
   */
  deadline?: number;
}

export interface CardExtractResult {
  raw: RawCardExtraction;
  /** The stable KEY, for `extractedByModel`. Never the raw id. Plan §4.4. */
  modelKey: string;
  modelId: string;
}

/**
 * Read one card. Throws on failure — the caller decides what a failure means,
 * and for the route it means "nothing was written; say why".
 */
export async function extractFromCard(
  image: CardImage,
  options: CardExtractOptions = {}
): Promise<CardExtractResult> {
  const ladder = options.models ?? CARD_MODEL_LADDER;
  const proc = options.process ?? 'card_extract';

  return walkModelLadder(
    ladder,
    (model, deadline) => extractWith(model, image, deadline, proc),
    { describe: describeFailure, label: LOG, deadline: options.deadline }
  );
}

async function extractWith(
  modelId: string,
  image: CardImage,
  deadline: number,
  proc: AiProcess
): Promise<CardExtractResult> {
  // One image, so the per-attempt clamp for a single photo on this tier.
  const perAttemptMs = attemptTimeoutMsFor(modelId, 1);

  const { object, usage, providerMetadata } = await retryWithinDeadline(
    deadline,
    perAttemptMs,
    (budgetMs) =>
      generateObject({
        model: google(modelId),
        schema: CardExtractionSchema,
        system: CARD_EXTRACT_SYSTEM,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: CARD_USER_INSTRUCTION },
              { type: 'image', image: image.bytes, mediaType: image.mediaType },
            ],
          },
        ],
        // A FRESH signal per attempt. Hoisting it out of this callback would
        // restore the single shared budget that made a retry unreachable on
        // 2026-08-30.
        abortSignal: AbortSignal.timeout(budgetMs),
        // retryWithinDeadline owns retrying; nesting the SDK's own policy would
        // make the timing impossible to reason about.
        maxRetries: 0,
      }),
    { label: LOG }
  );

  // void, never awaited: metering must not be able to break, or slow, the
  // thing it measures.
  void recordAiUsage({ process: proc, model: modelId, usage, providerMetadata });

  return { raw: asRaw(object), modelKey: String(modelKeyFor(modelId)), modelId };
}
