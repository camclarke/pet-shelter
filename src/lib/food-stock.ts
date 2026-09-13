/**
 * The pantry, the pot and the day's servings: the PURE layer.
 *
 * No Firestore, no Spanish, no model. `food-admin.ts` does the writing.
 * Build-order step 13, plan §12.2 and §12.5.
 *
 * ═══ THE LEDGER ═════════════════════════════════════════════════════════════
 * Stock is not stored; it is summed. Every movement is an immutable entry at
 * `foodStock/{category}/stockEntries/{entryId}` — see `StockEntry` in
 * `types.ts` for why a ledger rather than a mutable total. The path puts the
 * category in the collection so that "how much rice" is an UNFILTERED `sum()`
 * over one subcollection. Measured 2026-09-12 against live Firestore: the same
 * sum filtered by a `category` field on one flat collection failed with
 * FAILED_PRECONDITION, "The query requires an index", while the unfiltered sum
 * answered. So this shape needs no index deploy at all.
 *
 * ═══ FAILURE DIRECTION ══════════════════════════════════════════════════════
 * BLOCKS only what is structurally impossible or unsafe:
 *   - a quantity that is not a number, is zero or negative, or is heavier than
 *     any delivery (a typo), or is ambiguous in es-BO notation;
 *   - a date in the future;
 *   - a TOXIC food going into the pot without an explicit acknowledgement —
 *     the one safety gate, and it is a checkbox rather than a wall because the
 *     detector is a word list with false positives. See `food-safety.ts`.
 * WARNS about everything the shelter may legitimately be doing:
 *   - cooking more of something than the ledger says exists (stock records are
 *     never complete — a donation nobody logged is still rice);
 *   - stock below zero, for the same reason;
 *   - a bone-in input, which is fine once deboned.
 *
 * ═══ YIELD: MEASURED, AND NOT ESTIMATED WITHOUT THE POT ═════════════════════
 * Plan §12.2: raw mass → cooked volume → ladles cannot be derived from first
 * principles. Rice triples, meat shrinks, water is unmeasured. So:
 *   - what cook batches MEASURED (cooked/raw ratio, grams per ladle) is shown
 *     as measured data with its n — `cookedToRawRatio`, `gramsPerLadle`;
 *   - a FORWARD estimate of ladles needs the pot and ladle measured
 *     (`SHELTER.kitchen`) AND enough batches to calibrate against. While the
 *     constants are null, `yieldEstimate` refuses before it looks at anything
 *     else, and the UI prints the refusal.
 */

import type { FoodCategory, FoodHazard } from './types';
import { CLOCK_SKEW_TOLERANCE_MS } from './placements';
import {
  LINE_MAX_GRAMS,
  parseDecimalInput,
  parseKilogramsInput,
  type QuantityParse,
} from './food-quantity';
import { findFoodHazards, hasToxicHazard } from './food-safety';

export const FOOD_CATEGORIES: readonly FoodCategory[] = [
  'meat',
  'offal',
  'bone',
  'grain',
  'vegetable',
  'kibble',
  'wet-food',
  'other',
];

export function isFoodCategory(value: unknown): value is FoodCategory {
  return typeof value === 'string' && (FOOD_CATEGORIES as readonly string[]).includes(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stock
// ─────────────────────────────────────────────────────────────────────────────

export interface CategoryStock {
  category: FoodCategory;
  grams: number;
}

/**
 * Sum ledger entries by category. The admin layer uses Firestore's `sum()`
 * instead; this is the same arithmetic over entries in hand, so the two can be
 * held to one definition by a test.
 */
export function sumStock(
  entries: readonly { category: FoodCategory; deltaG: number }[]
): Record<FoodCategory, number> {
  const totals = Object.fromEntries(FOOD_CATEGORIES.map((c) => [c, 0])) as Record<FoodCategory, number>;
  for (const entry of entries) {
    if (isFoodCategory(entry.category) && Number.isFinite(entry.deltaG)) {
      totals[entry.category] += entry.deltaG;
    }
  }
  return totals;
}

export type StockLine =
  | { kind: 'in-stock'; category: FoodCategory; grams: number }
  | { kind: 'empty'; category: FoodCategory }
  /**
   * More recorded out than in. Shown, never hidden and never clamped to zero:
   * a negative pantry is information — a donation that was not logged, or an
   * input typed in grams instead of kilos.
   */
  | { kind: 'negative'; category: FoodCategory; grams: number };

/**
 * ⚠️ `totals` must come from a query that SUCCEEDED. A category whose sum could
 * not be read must never be passed as 0 — "0 kg of rice" and "we could not
 * read the rice" are different sentences, and this project's most repeated
 * failure is the second one rendered as the first.
 */
export function stockLines(totals: Record<FoodCategory, number>): StockLine[] {
  return FOOD_CATEGORIES.map((category) => {
    const grams = totals[category];
    if (grams > 0) return { kind: 'in-stock', category, grams };
    if (grams < 0) return { kind: 'negative', category, grams };
    return { kind: 'empty', category };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Manual movements: a discard, a correction
// ─────────────────────────────────────────────────────────────────────────────

export type ManualMovementKind = 'discard' | 'correction';

export interface StockMovementDraft {
  kind: ManualMovementKind;
  category: FoodCategory | null;
  /** What it was: "arroz con gorgojo", "conteo del sábado". */
  label: string;
  /** Kilograms, as typed. */
  kgText: string;
  /** A correction can go either way; a discard only removes. */
  direction: 'add' | 'remove';
  occurredAt: number | null;
  note: string | null;
}

export type StockMovementError =
  | 'category-required'
  | 'label-required'
  | 'quantity-required'
  | 'quantity-invalid'
  | 'quantity-too-precise'
  | 'quantity-not-positive'
  | 'quantity-too-heavy'
  | 'occurred-required'
  | 'occurred-in-future'
  /**
   * A correction's only content is its reason. A number that changes the
   * pantry with no reason attached is the silent rewrite the ledger exists to
   * prevent, so this blocks — it costs a few words.
   */
  | 'correction-reason-required';

export const LABEL_MAX_CHARS = 80;

function massErrors(parse: QuantityParse): StockMovementError[] {
  switch (parse.kind) {
    case 'empty':
      return ['quantity-required'];
    case 'too-precise':
      return ['quantity-too-precise'];
    case 'ok':
      if (parse.grams <= 0) return ['quantity-not-positive'];
      if (parse.grams > LINE_MAX_GRAMS) return ['quantity-too-heavy'];
      return [];
    default:
      return ['quantity-invalid'];
  }
}

export function validateStockMovement(
  draft: StockMovementDraft,
  now: number = Date.now()
): StockMovementError[] {
  const errors: StockMovementError[] = [];
  if (draft.category === null) errors.push('category-required');
  if (draft.label.trim() === '') errors.push('label-required');
  errors.push(...massErrors(parseKilogramsInput(draft.kgText)));
  if (draft.occurredAt === null) errors.push('occurred-required');
  else if (draft.occurredAt > now + CLOCK_SKEW_TOLERANCE_MS) errors.push('occurred-in-future');
  if (draft.kind === 'correction' && !draft.note?.trim()) errors.push('correction-reason-required');
  return errors;
}

/** The signed grams a valid movement writes. Null for an invalid one. */
export function stockMovementDeltaG(draft: StockMovementDraft): number | null {
  const parse = parseKilogramsInput(draft.kgText);
  if (parse.kind !== 'ok' || parse.grams <= 0 || parse.grams > LINE_MAX_GRAMS) return null;
  const removes = draft.kind === 'discard' || draft.direction === 'remove';
  return removes ? -parse.grams : parse.grams;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cook batches
// ─────────────────────────────────────────────────────────────────────────────

export interface CookInputDraft {
  category: FoodCategory | null;
  label: string;
  /** MEASURED raw kilograms, as typed. */
  kgText: string;
  /**
   * Ticked by the person cooking when the label names a toxic food. See the
   * header: the one safety gate, and deliberately one they control.
   */
  toxicAcknowledged: boolean;
}

/**
 * The observed half of a batch, recorded after the fact: the pot is weighed
 * after cooking and the ladles counted after serving.
 */
export interface CookOutcomeDraft {
  /** 0–1, from a select. Null when nobody looked. */
  potFillLevel: number | null;
  /** Measured net cooked weight, kilograms. Often filled in later. */
  cookedKgText: string;
  /** Counted after serving. Often filled in later. */
  ladlesText: string;
  dogsServedText: string;
  cookedBy: string | null;
  notes: string | null;
}

export interface CookBatchDraft extends CookOutcomeDraft {
  cookedAt: number | null;
  inputs: CookInputDraft[];
}

export type CookBatchError =
  | { kind: 'cooked-required' }
  | { kind: 'cooked-in-future' }
  | { kind: 'inputs-required' }
  | { kind: 'input-category-required'; index: number }
  | { kind: 'input-label-required'; index: number }
  | { kind: 'input-quantity'; index: number; error: StockMovementError }
  /** A toxic food named as a pot input, not acknowledged. */
  | { kind: 'input-toxic-unacknowledged'; index: number; hazards: FoodHazard[] }
  | { kind: 'pot-fill-invalid' }
  | { kind: 'cooked-weight-invalid' }
  | { kind: 'ladles-invalid' }
  | { kind: 'dogs-served-invalid' };

export type CookBatchWarning =
  /** More than the ledger holds. Stock records are never complete; cook anyway. */
  | { kind: 'input-exceeds-stock'; index: number; category: FoodCategory; stockGrams: number }
  /** Bones, avocado: fine with care. */
  | { kind: 'input-caution'; index: number; hazards: FoodHazard[] };

export const MAX_INPUTS_PER_BATCH = 20;
/** More ladles than any pot this shelter could own holds. A typo guard, not a limit. */
export const MAX_LADLES_PER_BATCH = 2_000;
export const MAX_DOGS_PER_BATCH = 1_000;

function optionalPositive(
  text: string,
  { integer, max }: { integer: boolean; max: number }
): 'empty' | 'ok' | 'invalid' {
  const parse = parseDecimalInput(text);
  if (parse.kind === 'empty') return 'empty';
  if (parse.kind !== 'ok') return 'invalid';
  if (parse.value <= 0 || parse.value > max) return 'invalid';
  if (integer && !Number.isInteger(parse.value)) return 'invalid';
  return 'ok';
}

export function cookInputGrams(input: CookInputDraft): number | null {
  const parse = parseKilogramsInput(input.kgText);
  return parse.kind === 'ok' && parse.grams > 0 && parse.grams <= LINE_MAX_GRAMS ? parse.grams : null;
}

export function cookInputHazards(input: CookInputDraft): FoodHazard[] {
  return findFoodHazards(input.label).map((f) => f.hazard);
}

export function validateCookBatch(
  draft: CookBatchDraft,
  now: number = Date.now()
): CookBatchError[] {
  const errors: CookBatchError[] = [];
  if (draft.cookedAt === null) errors.push({ kind: 'cooked-required' });
  else if (draft.cookedAt > now + CLOCK_SKEW_TOLERANCE_MS) errors.push({ kind: 'cooked-in-future' });

  if (draft.inputs.length === 0) errors.push({ kind: 'inputs-required' });

  draft.inputs.slice(0, MAX_INPUTS_PER_BATCH + 1).forEach((input, index) => {
    if (input.category === null) errors.push({ kind: 'input-category-required', index });
    if (input.label.trim() === '') errors.push({ kind: 'input-label-required', index });
    for (const error of massErrors(parseKilogramsInput(input.kgText))) {
      errors.push({ kind: 'input-quantity', index, error });
    }
    const hazards = cookInputHazards(input);
    if (hasToxicHazard(hazards) && !input.toxicAcknowledged) {
      errors.push({ kind: 'input-toxic-unacknowledged', index, hazards });
    }
  });
  if (draft.inputs.length > MAX_INPUTS_PER_BATCH) errors.push({ kind: 'inputs-required' });

  errors.push(...validateCookOutcome(draft));
  return errors;
}

/** Validates only the observed half — what an edit after serving may change. */
export function validateCookOutcome(draft: CookOutcomeDraft): CookBatchError[] {
  const errors: CookBatchError[] = [];
  if (draft.potFillLevel !== null && !(draft.potFillLevel > 0 && draft.potFillLevel <= 1)) {
    errors.push({ kind: 'pot-fill-invalid' });
  }
  const cooked = parseKilogramsInput(draft.cookedKgText);
  if (cooked.kind !== 'empty' && !(cooked.kind === 'ok' && cooked.grams > 0 && cooked.grams <= LINE_MAX_GRAMS)) {
    errors.push({ kind: 'cooked-weight-invalid' });
  }
  if (optionalPositive(draft.ladlesText, { integer: false, max: MAX_LADLES_PER_BATCH }) === 'invalid') {
    errors.push({ kind: 'ladles-invalid' });
  }
  if (optionalPositive(draft.dogsServedText, { integer: true, max: MAX_DOGS_PER_BATCH }) === 'invalid') {
    errors.push({ kind: 'dogs-served-invalid' });
  }
  return errors;
}

/** The typed values a VALID outcome stores. Call `validateCookOutcome` first. */
export function cookOutcomeValues(draft: CookOutcomeDraft): {
  potFillLevel: number | null;
  cookedWeightG: number | null;
  ladlesYielded: number | null;
  dogsServed: number | null;
  cookedBy: string | null;
  notes: string | null;
} {
  const cooked = parseKilogramsInput(draft.cookedKgText);
  const ladles = parseDecimalInput(draft.ladlesText);
  const dogs = parseDecimalInput(draft.dogsServedText);
  return {
    potFillLevel: draft.potFillLevel,
    cookedWeightG: cooked.kind === 'ok' && cooked.grams > 0 ? cooked.grams : null,
    ladlesYielded: ladles.kind === 'ok' && ladles.value > 0 ? ladles.value : null,
    dogsServed: dogs.kind === 'ok' && Number.isInteger(dogs.value) && dogs.value > 0 ? dogs.value : null,
    cookedBy: draft.cookedBy?.trim() || null,
    notes: draft.notes?.trim() || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dates from a date field
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The instant to store for a day picked in a date field.
 *
 * ⚠️ `parseDateInput` returns LOCAL MIDDAY, which is right for protecting the
 * calendar day across timezones and wrong for "today" before noon: 12:00 is
 * then hours in the future, so every "not in the future" check — ours at five
 * minutes, the rules' at ten — would refuse a donation recorded at 9 a.m.
 * So today becomes `now`, and any other day keeps its midday. A day that is
 * genuinely in the future keeps its midday too, and is refused as it should
 * be.
 */
export function dayToInstant(dayMiddayMs: number, now: number = Date.now()): number {
  const day = new Date(dayMiddayMs);
  const today = new Date(now);
  const sameDay =
    day.getFullYear() === today.getFullYear() &&
    day.getMonth() === today.getMonth() &&
    day.getDate() === today.getDate();
  return sameDay ? now : dayMiddayMs;
}

/**
 * @param stock  grams per category from a SUCCESSFUL read, or null when stock
 *               could not be read — in which case no stock warning is raised,
 *               because a warning about a number nobody has is noise.
 */
export function cookBatchWarnings(
  draft: CookBatchDraft,
  stock: Record<FoodCategory, number> | null
): CookBatchWarning[] {
  const warnings: CookBatchWarning[] = [];
  const planned = new Map<FoodCategory, number>();

  draft.inputs.forEach((input, index) => {
    const hazards = cookInputHazards(input);
    const caution = hazards.filter((h) => !hasToxicHazard([h]));
    if (caution.length > 0) warnings.push({ kind: 'input-caution', index, hazards: caution });

    const grams = cookInputGrams(input);
    if (stock === null || input.category === null || grams === null) return;
    // Cumulative per category: two rice inputs draw on one pile.
    const soFar = (planned.get(input.category) ?? 0) + grams;
    planned.set(input.category, soFar);
    if (soFar > stock[input.category]) {
      warnings.push({
        kind: 'input-exceeds-stock',
        index,
        category: input.category,
        stockGrams: stock[input.category],
      });
    }
  });
  return warnings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Calibration: what batches MEASURED
// ─────────────────────────────────────────────────────────────────────────────

export interface CalibrationBatch {
  inputs: readonly { rawG: number }[];
  potFillLevel: number | null;
  cookedWeightG: number | null;
  ladlesYielded: number | null;
}

/** A measured ratio across batches. `n` is always shown next to it. */
export interface MeasuredRatio {
  n: number;
  median: number;
  min: number;
  max: number;
}

export function rawTotalG(batch: { inputs: readonly { rawG: number }[] }): number {
  return batch.inputs.reduce((sum, input) => sum + (input.rawG > 0 ? input.rawG : 0), 0);
}

function summarise(values: number[]): MeasuredRatio | null {
  const clean = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  const median = clean.length % 2 === 1 ? clean[mid]! : (clean[mid - 1]! + clean[mid]!) / 2;
  return { n: clean.length, median, min: clean[0]!, max: clean[clean.length - 1]! };
}

/**
 * Cooked net weight over raw input weight, across batches that measured both.
 * A soup routinely comes out HEAVIER than its raw inputs — rice absorbs water
 * and water is added — so no upper bound is imposed; the min–max range shows
 * the spread instead.
 */
export function cookedToRawRatio(batches: readonly CalibrationBatch[]): MeasuredRatio | null {
  return summarise(
    batches.flatMap((b) => {
      const raw = rawTotalG(b);
      return b.cookedWeightG !== null && b.cookedWeightG > 0 && raw > 0 ? [b.cookedWeightG / raw] : [];
    })
  );
}

/** Cooked grams per ladle served, across batches that weighed the pot and counted ladles. */
export function gramsPerLadle(batches: readonly CalibrationBatch[]): MeasuredRatio | null {
  return summarise(
    batches.flatMap((b) =>
      b.cookedWeightG !== null && b.cookedWeightG > 0 && b.ladlesYielded !== null && b.ladlesYielded > 0
        ? [b.cookedWeightG / b.ladlesYielded]
        : []
    )
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Yield estimate: gated
// ─────────────────────────────────────────────────────────────────────────────

export interface KitchenConstants {
  potCapacityLitres: number | null;
  ladleVolumeMl: number | null;
}

/** Batches with a fill level and a ladle count needed before any estimate. */
export const MIN_BATCHES_TO_ESTIMATE = 5;

export type YieldEstimate =
  /** THE refusal the UI shows today. Checked before anything else. */
  | { kind: 'no-kitchen-constants' }
  | { kind: 'no-fill-level' }
  /** Plan §12.2's "aún calibrando". */
  | { kind: 'calibrating'; n: number; needed: number }
  | { kind: 'ok'; ladles: number; n: number };

function isMeasured(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

/**
 * How many ladles a pot filled to `fillLevel` should yield.
 *
 * Geometry gives a ceiling — capacity × fill ÷ ladle volume — and the
 * shelter's own batches correct it: the median of observed ladles over that
 * ceiling, because nobody fills a ladle level and the bottom of the pot is
 * never served. Rounded DOWN, so the estimate errs toward cooking a little
 * more rather than serving a little less.
 *
 * ⚠️ The constant check comes FIRST and returns before the batches are read.
 * With `SHELTER.kitchen` null this function has nothing to say, and a caller
 * that wants a number has no path to one. Break-probed: removing it fails a
 * test by name.
 */
export function yieldEstimate(
  kitchen: KitchenConstants,
  batches: readonly CalibrationBatch[],
  fillLevel: number | null
): YieldEstimate {
  if (!isMeasured(kitchen.potCapacityLitres) || !isMeasured(kitchen.ladleVolumeMl)) {
    return { kind: 'no-kitchen-constants' };
  }
  const ceilingAt = (fill: number) => (fill * kitchen.potCapacityLitres! * 1000) / kitchen.ladleVolumeMl!;

  const corrections = batches.flatMap((b) =>
    b.potFillLevel !== null && b.potFillLevel > 0 && b.potFillLevel <= 1 && isMeasured(b.ladlesYielded)
      ? [b.ladlesYielded / ceilingAt(b.potFillLevel)]
      : []
  );
  if (corrections.length < MIN_BATCHES_TO_ESTIMATE) {
    return { kind: 'calibrating', n: corrections.length, needed: MIN_BATCHES_TO_ESTIMATE };
  }
  if (fillLevel === null || !(fillLevel > 0 && fillLevel <= 1)) return { kind: 'no-fill-level' };

  const correction = summarise(corrections)!.median;
  return { kind: 'ok', ladles: Math.floor(ceilingAt(fillLevel) * correction), n: corrections.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// The day's servings
// ─────────────────────────────────────────────────────────────────────────────

/** `feedingLog/{YYYY-MM-DD}`, in LOCAL time — a Bolivian day, not a UTC one. */
export function feedingLogId(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function isFeedingLogId(id: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(id);
  if (!match) return false;
  const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  return feedingLogId(d.getTime()) === id;
}

/** More ladles than any dog eats in a day. A typo guard. */
export const MAX_LADLES_PER_DOG = 20;

export type ServingParse =
  | { kind: 'empty' }
  | { kind: 'ok'; ladles: number }
  | { kind: 'invalid' }
  | { kind: 'too-many' };

/**
 * Ladles for one dog: whole or half. Zero is valid — a dog fasting before
 * surgery is served nothing, and that is worth recording as a zero rather than
 * as a blank.
 */
export function parseServing(text: string): ServingParse {
  const parse = parseDecimalInput(text);
  if (parse.kind === 'empty') return { kind: 'empty' };
  if (parse.kind !== 'ok') return { kind: 'invalid' };
  if (!Number.isInteger(parse.value * 2)) return { kind: 'invalid' };
  if (parse.value > MAX_LADLES_PER_DOG) return { kind: 'too-many' };
  return { kind: 'ok', ladles: parse.value };
}
