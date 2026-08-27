/**
 * Every Gemini model ID in the project, in one place.
 *
 * ⚠️ AI Studio, never Vertex. See `docs/gemini-api-playbook.md` — that decision
 * was made deliberately on 2026-08-16 and reverses an earlier recommendation.
 *
 * ── Model KEY vs model ID ────────────────────────────────────────────────────
 * A model ID (`gemini-3.6-flash`) churns every few months. A model KEY
 * (`flash`) is what gets written into Firestore and into a Zod enum, and can
 * never be renamed once a document carries it. So: persist the KEY, resolve the
 * ID at call time through `MODELS`. Playbook §2.1.
 *
 * ⚠️ The IDs below are taken from the playbook, which was extracted from the
 * sibling stack on 2026-08-16. They have NOT been verified against a live API
 * from this project, because no GEMINI_API_KEY exists here yet. Every one is
 * overridable by environment variable precisely so a churned ID is a config
 * change and not a deploy. Verify them with `npm run ai:probe` once a key
 * exists — playbook §2.3 records a model that kept serving 8 days past its
 * published shutdown, so "it works" is not "it is supported".
 */

/** Vision + extraction workhorse. */
export const FLASH_MODEL =
  process.env.GEMINI_FLASH_MODEL?.trim() || 'gemini-3.6-flash';

/** Cheap classifiers and probes. A second extractor, if consensus is ever added. */
export const FLASH_LITE_MODEL =
  process.env.GEMINI_FLASH_LITE_MODEL?.trim() || 'gemini-3.1-flash-lite';

/** Reasoning and arbitration. Not used by intake extraction today. */
export const PRO_MODEL =
  process.env.GEMINI_PRO_MODEL?.trim() || 'gemini-3.1-pro-preview';

/**
 * Stable keys. These are PERSISTED — on `Pet.extractedByModel`, and on
 * `MedicalRecord.extractedByModel` when step 7 lands. Adding a key is cheap;
 * renaming one is a backfill.
 */
export type ModelKey = 'flash' | 'flash-lite' | 'pro';

export interface ModelConfig {
  id: string;
  /** Shown to an admin in Spanish, never the raw ID. */
  label: string;
  /** Whether this model accepts image parts. */
  supportsVision: boolean;
}

export const MODELS: Record<ModelKey, ModelConfig> = {
  flash: { id: FLASH_MODEL, label: 'Estándar', supportsVision: true },
  'flash-lite': { id: FLASH_LITE_MODEL, label: 'Rápido', supportsVision: true },
  pro: { id: PRO_MODEL, label: 'Detallado', supportsVision: true },
};

/** Resolve a persisted key to the ID to call today. */
export function modelIdFor(key: ModelKey): string {
  return MODELS[key].id;
}

/**
 * Reverse lookup, for metering: a call site holds an ID, the rollup wants the
 * key. Falls back to the raw ID rather than throwing — metering must never be
 * able to break the pipeline it measures.
 */
export function modelKeyFor(id: string): ModelKey | string {
  const hit = (Object.keys(MODELS) as ModelKey[]).find((k) => MODELS[k].id === id);
  return hit ?? id;
}
