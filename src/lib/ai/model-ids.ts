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

/**
 * Vision + extraction workhorse.
 *
 * ⚠️ ALSO dictation's extractor A (`dictate.ts`), which is the
 * highest-consequence path in the system and has no eval. Changing this
 * constant changes that path too. The intake cascade deliberately does NOT
 * reuse it as its primary for exactly that reason — see
 * SUGGEST_MODEL_LADDER below.
 */
export const FLASH_MODEL =
  process.env.GEMINI_FLASH_MODEL?.trim() || 'gemini-3.6-flash';

/**
 * The two newer Flash generations, used ONLY by the intake cascade.
 *
 * They exist as separate constants rather than as a bumped FLASH_MODEL
 * because FLASH_MODEL is load-bearing for veterinary dictation, and a model
 * swap there needs its own evidence.
 */
export const FLASH_NEXT_MODEL =
  process.env.GEMINI_FLASH_NEXT_MODEL?.trim() || 'gemini-3.8-flash';
export const FLASH_MID_MODEL =
  process.env.GEMINI_FLASH_MID_MODEL?.trim() || 'gemini-3.7-flash';

/** Cheap classifiers and probes. A second extractor, if consensus is ever added. */
export const FLASH_LITE_MODEL =
  process.env.GEMINI_FLASH_LITE_MODEL?.trim() || 'gemini-3.1-flash-lite';

/** Reasoning and arbitration. Not used by intake extraction today. */
export const PRO_MODEL =
  process.env.GEMINI_PRO_MODEL?.trim() || 'gemini-3.1-pro-preview';

/**
 * Dedicated speech-to-text, for the veterinary dictation transcript.
 *
 * A purpose-built ASR rather than a general multimodal model, for two
 * reasons that matter to plan §4.7: it returns WORD TIMESTAMPS, which let a
 * reviewer click a dose and hear the vet say that word instead of replaying
 * four minutes of audio; and it diarises, so the vet is separable from an
 * owner or assistant talking over them.
 *
 * ⚠️ This produces the RECORD of what was said. It is never the input to
 * the extractors — see the header of `src/lib/dictation.ts` for why feeding
 * one transcript to two extractors defeats the whole consensus design.
 */
export const TRANSCRIBE_MODEL =
  process.env.GEMINI_TRANSCRIBE_MODEL?.trim() || 'gemini-3.5-transcribe';

/**
 * Stable keys. These are PERSISTED — on `Pet.extractedByModel`, and on
 * `MedicalRecord.extractedByModel` when step 7 lands. Adding a key is cheap;
 * renaming one is a backfill.
 */
export type ModelKey =
  | 'flash'
  | 'flash-3.8'
  | 'flash-3.7'
  | 'flash-lite'
  | 'pro'
  | 'transcribe';

export interface ModelConfig {
  id: string;
  /** Shown to an admin in Spanish, never the raw ID. */
  label: string;
  /** Whether this model accepts image parts. */
  supportsVision: boolean;
}

export const MODELS: Record<ModelKey, ModelConfig> = {
  flash: { id: FLASH_MODEL, label: 'Estándar', supportsVision: true },
  // ⚠️ These two keys carry a VERSION where every other key carries a role,
  // and that is deliberate rather than a slip. The cascade exists because
  // free-tier quota is a separate bucket PER MODEL VERSION — 20 requests a
  // day each on 3.8, 3.7 and 3.6 — so the version genuinely is the thing
  // being identified. When 3.9 arrives it gets its own key and its own
  // bucket; the old keys stay meaningful for the records that carry them,
  // which is exactly what a persisted key is for.
  'flash-3.8': { id: FLASH_NEXT_MODEL, label: 'Estándar (3.8)', supportsVision: true },
  'flash-3.7': { id: FLASH_MID_MODEL, label: 'Estándar (3.7)', supportsVision: true },
  'flash-lite': { id: FLASH_LITE_MODEL, label: 'Rápido', supportsVision: true },
  pro: { id: PRO_MODEL, label: 'Detallado', supportsVision: true },
  transcribe: { id: TRANSCRIBE_MODEL, label: 'Transcripción', supportsVision: false },
};

/**
 * The intake cascade, strongest first. ONE ordered array, walked in order.
 *
 * ── Why a cascade at all: QUOTA, not quality and not hangs ──────────────────
 * Free-tier limits on this project, read off its own quota rather than a docs
 * page:
 *
 *     gemini-3.8 / 3.7 / 3.6-flash     20 requests/day,   5/min   EACH
 *     gemini-3.1-flash-lite           500 requests/day,  15/min
 *
 * The buckets are PER MODEL. One photo set is one request, so two Flash tiers
 * added here take the shelter from 20 animals a day to 60 before it degrades
 * to Lite. That is the whole reason this exists.
 *
 * ⚠️ It is NOT an answer to hangs, and the arithmetic says so. A 429 fails
 * instantly, so three tiers fit the 50s budget comfortably. A HANG costs the
 * full 25s per-attempt clamp, so two of them already exhaust the budget and
 * SUGGEST_MIN_RETRY_MS correctly refuses to start a third. Do not try to make
 * three hangs survivable: past Firebase Hosting's 60s ceiling the answer
 * cannot be delivered at all, however good it is.
 *
 * ── Flash-Lite stays LAST, and stays ────────────────────────────────────────
 * 500 requests a day against Flash's 20 makes it the only tier still working
 * once all three Flash buckets are spent — plan §3: an animal arriving at
 * 22:00 must not wait on a quota or on someone else's traffic spike.
 *
 * ⚠️ Lite carries a documented AGE caveat and it has not gone away. Measured
 * 2026-08-30 on a husky-type dog: a Lite-tier model read the white facial
 * MASK as muzzle greying and called a young adult "6-8+ years", noting the
 * teeth were clean and then overriding itself with the coat. A Flash tier read
 * the dentition and returned 1.5-3 years. Lite is here because a weaker answer
 * beats no answer, NOT because that gap closed. `decideAge()` refusing a range
 * wider than two years is what keeps the worst of it off a public listing.
 *
 * ⚠️ Every entry must have a pricing row — enforced by a test. An unpriced
 * tier means a successful call metered at a rate nobody chose.
 *
 * ── Why 3.6 leads and not 3.8 ───────────────────────────────────────────────
 * The plan for this cascade was 3.8 → 3.7 → 3.6. It is not, and the reason is
 * `npm run eval:intake`, measured 2026-09-10 on the same four photographs and
 * the same prompt:
 *
 *   gemini-3.6-flash   11/11, 11/11   sex delivered 2 of 2, confidence HIGH
 *   gemini-3.8-flash   10/11,  8/11   sex delivered 0 of 2
 *   gemini-3.7-flash   no successful run — overloaded on all four attempts
 *
 * AGE is fine on 3.8 — 12-36 and 18-36 months, both read from the teeth slot,
 * both at least as tight as 3.6's 24-48. The documented stop condition for
 * this swap was "3.8 reads age worse", and it does not.
 *
 * What it reads worse is SEX. Once it returned female from the genital photo
 * but at `medium` confidence, which `decideSex` correctly refuses; once it
 * reported `sexFromGenitalPhoto: false` and read nothing at all. Either way
 * the shelter is not offered the sex — and sex is not one field among many
 * here. It inflects every Spanish sentence about the animal, and the breed
 * wording is gated behind it (`mixedBreed` takes a REQUIRED sex), so losing it
 * also loses the resemblance line the adoption-wall card was just built to
 * show.
 *
 * The asymmetry decides it. Leading with 3.6 costs nothing if 3.8 was merely
 * unlucky — 3.8 is still tier 2 and still contributes its own daily bucket, so
 * the 20 → 60 capacity gain is unchanged. Leading with 3.8 costs every intake
 * its sex suggestion, silently, if these two samples are representative.
 *
 * ⚠️ n=2 per model, one animal, during a provider-wide overload. This is a
 * reason to order the ladder conservatively, NOT a settled finding about
 * either model. Re-run the harness on a calm day and on a second animal; if
 * 3.8 delivers sex at high confidence, promoting it is one line here.
 */
export const SUGGEST_MODEL_LADDER: readonly string[] = [
  FLASH_MODEL,
  FLASH_NEXT_MODEL,
  FLASH_MID_MODEL,
  FLASH_LITE_MODEL,
];

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

/**
 * The vaccination-card ladder, as persisted KEYS, strongest first.
 * Build-order step 9.
 *
 * ── Why Flash first ─────────────────────────────────────────────────────────
 * Plan §11 #1: a handwritten, faded, stamped card photographed on a phone is
 * close to the hardest OCR case there is, so start on a reasoning tier and let
 * the review-correction rate decide — not a guess made now.
 *
 * ── Why 3.8 and 3.7, and NOT 3.6 ────────────────────────────────────────────
 * Free-tier quota is a separate bucket PER MODEL, 20 requests a day each on the
 * Flash tiers. `gemini-3.6-flash` is the intake cascade's PRIMARY — the tier
 * that reads an arriving animal's sex and age. A card read from that bucket is
 * an animal's intake pushed down the cascade, so cards stay off it entirely.
 * 3.8's documented weakness (it under-delivers sex from a genital photo) is
 * irrelevant to reading a card.
 *
 * ── Why it ends on Flash-Lite, always ───────────────────────────────────────
 * 500 requests a day, and a different pool, so it is up when the Flash tiers
 * are overloaded. A weaker reading of a card is still worth having here, because
 * every value is reviewed by a person before it counts, and a withheld field
 * costs one typed entry. `cardLadderKeys` enforces this whatever the override.
 */
export const CARD_MODEL_LADDER_DEFAULT_KEYS: readonly ModelKey[] = [
  'flash-3.8',
  'flash-3.7',
  'flash-lite',
];

/**
 * The card ladder's keys, from an optional comma-separated override
 * (`GEMINI_CARD_LADDER=flash-lite`).
 *
 * The override exists so the tier can change without a deploy once the
 * review-correction rate is known, and so a local end-to-end probe can run on
 * Flash-Lite without spending the shelter's Flash quota. Unknown keys and
 * non-vision models are ignored; an override that leaves nothing falls back
 * to the default; and Flash-Lite is moved to — or added at — the end, because
 * a ladder that can run out without trying the 500-a-day tier is the one
 * configuration this must not allow.
 */
export function cardLadderKeys(override: string | undefined): ModelKey[] {
  const requested = (override ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter((key): key is ModelKey => key in MODELS && MODELS[key as ModelKey].supportsVision);

  const keys = requested.length > 0 ? requested : [...CARD_MODEL_LADDER_DEFAULT_KEYS];
  const unique = [...new Set(keys)].filter((key) => key !== 'flash-lite');
  return [...unique, 'flash-lite'];
}

/** The card ladder as model IDs to call, resolved once at module load. */
export const CARD_MODEL_LADDER: readonly string[] = cardLadderKeys(
  process.env.GEMINI_CARD_LADDER
).map(modelIdFor);
