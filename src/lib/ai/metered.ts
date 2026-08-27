import 'server-only';

import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '../firebase-admin';
import { countGroundedQueries, estimateCostUsd, hasPricingRow } from './pricing.mjs';

/**
 * The one function every AI call site in this project funnels through.
 *
 * ── Failure direction: OPEN, always ──────────────────────────────────────────
 * This function NEVER throws and never rejects. Call it as `void
 * recordAiUsage(...)`. An observation that can break the thing it observes is
 * worse than no observation — playbook §4.1. If the rollup write fails, the
 * animal still gets admitted.
 *
 * ── Why a rollup and not a row per call ──────────────────────────────────────
 * Per-call detail goes to the LOG (synchronously, so it survives a serverless
 * cold shutdown that drops the database write); the AGGREGATE goes to
 * Firestore. The rollup is bounded at roughly processes × models × 365
 * documents per year. A row per call is unbounded and this project runs on a
 * free tier.
 *
 * ── Tag by PROCESS, never by user ────────────────────────────────────────────
 * Per-user attribution would make the rollup unbounded. There is no per-user
 * cost question in a shelter with one admin.
 *
 * ⚠️ `api_usage_daily` is SERVER ONLY and has no rule in `firestore.rules`.
 * That absence IS the protection: the ruleset default-denies undeclared
 * collections, which was proven by probe on 2026-08-23. Do not add a rule for
 * it — adding one can only widen access.
 */

/**
 * Processes, in the owner's vocabulary. Labels are Spanish because they surface
 * in an admin cost view; the KEYS are English and are persisted, so renaming
 * one is a backfill of `api_usage_daily`.
 *
 * ⚠️ Meter the things you are sure are too small to matter. "Too small to
 * matter" should be a claim the dashboard can check, not an assumption baked
 * into a blind spot — the sibling stack left per-turn classifiers unmetered for
 * months on exactly that reasoning, and an audit later found 14 unmetered call
 * sites.
 */
export const PROCESS_LABELS = {
  intake_suggest: 'Sugerencias de ingreso',
} as const;

export type AiProcess = keyof typeof PROCESS_LABELS;

/** The shape the AI SDK reports. Embeddings report `{ tokens }` instead. */
export interface AiUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  tokens?: number;
}

export interface RecordAiUsageArgs {
  process: AiProcess;
  /** The model ID actually called — the truth of the bill, not the stable key. */
  model: string;
  usage: AiUsage | undefined;
  providerMetadata?: unknown;
  /** Only consulted when providerMetadata is absent; metadata always wins. */
  groundingRequests?: number;
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function recordAiUsage({
  process: proc,
  model,
  usage,
  providerMetadata,
  groundingRequests,
}: RecordAiUsageArgs): Promise<void> {
  try {
    const inputTokens = usage?.inputTokens ?? usage?.tokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    // Thinking tokens are billed as OUTPUT and `maxOutputTokens` does not
    // bound them. Tracked SEPARATELY from outputTokens because the provider
    // reports them separately and they are additive — but they are costed
    // together, see estimateCostUsd. Keeping the split visible is what lets
    // anyone judge whether a thinkingConfig budget is worth applying.
    const reasoningTokens = usage?.reasoningTokens ?? 0;

    const grounding =
      providerMetadata != null
        ? countGroundedQueries(providerMetadata)
        : (groundingRequests ?? 0);

    const estCostUsd = estimateCostUsd({
      model,
      inputTokens,
      outputTokens,
      // Billed as output. On Gemini 3.x these routinely DWARF the visible
      // answer, so leaving them out is not a rounding error.
      reasoningTokens,
      groundingRequests: grounding,
    });

    const line = {
      process: proc,
      model,
      inputTokens,
      outputTokens,
      reasoningTokens,
      groundingRequests: grounding,
      estCostUsd,
      // Surfaces the over-report described in pricing.mjs: an unlisted model is
      // costed at Flash rates, so the dashboard is wrong in a specific,
      // knowable direction rather than mysteriously.
      pricedFromTable: hasPricingRow(model),
    };

    // Emitted synchronously and BEFORE the await, so the detail survives even if
    // the instance is torn down before the write lands.
    console.info(`[ai-usage] ${JSON.stringify(line)}`);

    if (grounding > 0) {
      // Grounding is ruled out as a standing constraint in this project. If this
      // ever fires, something enabled it by accident and it is 100× the cost of
      // an ungrounded call.
      console.warn(
        `[ai-usage] UNEXPECTED grounded queries (${grounding}) on process=${proc}. Grounding is ruled out in this project.`
      );
    }

    const db = getAdminDb();
    await db
      .collection('api_usage_daily')
      .doc(`${utcDate()}__${proc}__${model}`)
      .set(
        {
          date: utcDate(),
          process: proc,
          model,
          calls: FieldValue.increment(1),
          inputTokens: FieldValue.increment(inputTokens),
          outputTokens: FieldValue.increment(outputTokens),
          reasoningTokens: FieldValue.increment(reasoningTokens),
          groundingRequests: FieldValue.increment(grounding),
          estCostUsd: FieldValue.increment(estCostUsd),
        },
        { merge: true }
      );
  } catch (err) {
    console.warn('[ai-usage] record failed', err);
  }
}
