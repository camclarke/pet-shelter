import 'server-only';

import { generateObject } from 'ai';

import { google } from './google';
import { LABEL_MODEL_LADDER, modelKeyFor } from './model-ids';
// The prompt and the schema live in their own modules so the unit suite can
// read them — `server-only` throws outside a server context.
import { LABEL_EXTRACT_SYSTEM, LABEL_USER_INSTRUCTION } from './label-prompt';
import { LabelExtractionSchema, type LabelExtractionShape } from './label-schema';
import { recordAiUsage, type AiProcess } from './metered';
import type { RawLabelExtraction } from '../label-extraction';
import {
  attemptTimeoutMsFor,
  describeFailure,
  retryWithinDeadline,
  walkModelLadder,
} from './suggest-budget';

export { LABEL_EXTRACT_SYSTEM, LABEL_USER_INSTRUCTION } from './label-prompt';
export { LabelExtractionSchema } from './label-schema';
export { LABEL_MODEL_LADDER } from './model-ids';

/**
 * Vaccine-label reading: the model call. Plan C3, 2026-10-14.
 *
 * What the answer is WORTH lives in `src/lib/label-extraction.ts`, pure and
 * tested. This file only obtains it, with the machinery the card reader and
 * photo intake already proved: the ladder walked under ONE deadline, the same
 * retry policy, the same per-attempt clamp, the same metering. Nothing here
 * touches the card reader; it shares that machinery, not its prompt.
 *
 * ── Grounded search is OFF, and that is structural ──────────────────────────
 * No tools are passed. Grounding is billed per query and invisible to token
 * metering, and reading a sticker needs no web. Do not add `tools` here.
 *
 * ── Inline image, never the Files API ───────────────────────────────────────
 * A label photo is well under a megabyte. AI SDK v6 image parts take
 * `mediaType`, not `mimeType` — the latter type-checks and throws at runtime.
 */

/**
 * Ties the schema to the pure layer's input type. If the two drift, this stops
 * compiling rather than handing the form a reading the gate reads as empty.
 */
function asRaw(object: LabelExtractionShape): RawLabelExtraction {
  return object;
}

const LOG = '[label-extract]';

export interface LabelImage {
  bytes: Uint8Array;
  mediaType: string;
}

/**
 * Knobs production leaves at their defaults. The eval pins `models` so a tier
 * fallback cannot make a benchmark of model A report model B's answer, and
 * meters under `label_extract_eval`. The route passes `deadline`.
 */
export interface LabelExtractOptions {
  models?: readonly string[];
  process?: AiProcess;
  /** Can only SHORTEN the budget — see walkModelLadder. */
  deadline?: number;
}

export interface LabelExtractResult {
  raw: RawLabelExtraction;
  /** The stable KEY, for `extractedByModel`. Never the raw id. */
  modelKey: string;
  modelId: string;
}

/** Read one label. Throws on failure; the caller decides what that means. */
export async function extractFromLabel(
  image: LabelImage,
  options: LabelExtractOptions = {}
): Promise<LabelExtractResult> {
  const ladder = options.models ?? LABEL_MODEL_LADDER;
  const proc = options.process ?? 'label_extract';

  return walkModelLadder(
    ladder,
    (model, deadline) => extractWith(model, image, deadline, proc),
    { describe: describeFailure, label: LOG, deadline: options.deadline }
  );
}

async function extractWith(
  modelId: string,
  image: LabelImage,
  deadline: number,
  proc: AiProcess
): Promise<LabelExtractResult> {
  const perAttemptMs = attemptTimeoutMsFor(modelId, 1);

  const { object, usage, providerMetadata } = await retryWithinDeadline(
    deadline,
    perAttemptMs,
    (budgetMs) =>
      generateObject({
        model: google(modelId),
        schema: LabelExtractionSchema,
        system: LABEL_EXTRACT_SYSTEM,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: LABEL_USER_INSTRUCTION },
              { type: 'image', image: image.bytes, mediaType: image.mediaType },
            ],
          },
        ],
        // A FRESH signal per attempt; a shared one made the retry unreachable
        // on 2026-08-30.
        abortSignal: AbortSignal.timeout(budgetMs),
        // retryWithinDeadline owns retrying.
        maxRetries: 0,
      }),
    { label: LOG }
  );

  // void, never awaited: metering must not be able to break the thing it measures.
  void recordAiUsage({ process: proc, model: modelId, usage, providerMetadata });

  return { raw: asRaw(object), modelKey: String(modelKeyFor(modelId)), modelId };
}
