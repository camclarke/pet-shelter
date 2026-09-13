/**
 * Weight and body condition: the PURE layer.
 *
 * No Firestore, no Spanish. `measurements-admin.ts` does the writing.
 * Build-order step 10, plan §2.7.
 *
 * ═══ WHY THIS STEP COMES BEFORE DICTATION AND FOOD ══════════════════════════
 * Drug dosing is mg/kg and energy requirement is a function of kg^0.75.
 * `Pet.size` is a wall filter, not a clinical quantity, and neither figure can
 * be computed from a bucket. Steps 11 and 13 read what this module accepts —
 * through `latestWeight`, and nothing else.
 *
 * ═══ WHAT THE SHELTER TOLD US, 2026-09-12 ═══════════════════════════════════
 * Plan §11 #7, answered by the owner: Wawitas HAS a scale, animals are weighed
 * when sick or at a vet visit rather than on a schedule, and the veterinarian
 * scores body condition. Three consequences, each deliberate:
 *
 * - A weight here is a MEASUREMENT and is shown as one. The photo intake's
 *   estimated range (`Pet.weightKgMin`/`weightKgMax`) is a different quantity
 *   and never becomes one of these — not by copy, not by prefill.
 * - There is no "overdue" logic. Readings are irregular by nature, and a
 *   reminder for a weigh-in nobody schedules is a warning people learn to
 *   ignore. What IS shown is how old the latest reading is, because a weight
 *   from four months ago is not a growing puppy's weight today.
 * - Who weighed or scored (`measuredBy`, free text — the vet usually has no
 *   account) is recorded separately from who typed it in (`recordedBy`).
 *
 * ═══ THE DECIMAL SEPARATOR IS A DOSING HAZARD ═══════════════════════════════
 * Bolivia writes 12,5 where English writes 12.5, and uses the point as a
 * thousands separator. A weight feeds an mg/kg dose, so a misread separator is
 * a factor of ten or a thousand in a drug. The parser accepts either
 * separator, at most two decimals, and REFUSES three: "12.500" is a scale
 * display to one person and twelve thousand five hundred to another, and
 * guessing which is exactly the wrong move on this path.
 *
 * ═══ FAILURE DIRECTION: WARN, DO NOT BLOCK ══════════════════════════════════
 * Same split as `medical.ts`. Errors are structurally impossible things — no
 * value at all, a date in the future, a weight no dog, cat or rabbit has ever
 * had, a number that cannot be read unambiguously. A sharp change from the
 * previous weight only WARNS, because a puppy really does double and a sick
 * animal really does waste, and the person with the animal on the scale is the
 * one who knows which this is.
 */

import type { MuscleCondition, Species } from './types';
import { dayToInstant } from './date-input';
import { CLOCK_SKEW_TOLERANCE_MS } from './placements';

const DAY_MS = 86_400_000;

// ─────────────────────────────────────────────────────────────────────────────
// Scales and bounds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The WSAVA 9-point Body Condition Score: 1 emaciated, 4–5 ideal, 9 grossly
 * obese. Integers only — the published charts have no half points.
 *
 * ⚠️ WSAVA publishes this scale for dogs and cats. Rabbits are usually scored
 * on a different, 5-point scale, which this field does not model.
 */
export const BCS_SCORES = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

/** WSAVA Muscle Condition Score, in order of increasing loss. */
export const MUSCLE_CONDITIONS: readonly MuscleCondition[] = [
  'normal',
  'mild',
  'moderate',
  'marked',
];

/**
 * Above this, a weight is a typo rather than an animal.
 *
 * The heaviest dogs on record are English mastiffs a little over 150 kg, and
 * no cat or rabbit comes close. 200 kg leaves room for the real extreme and
 * still catches "1250" typed for "12,50".
 */
export const WEIGHT_MAX_KG = 200;

/** Decimals accepted. See the module header on why three are refused. */
export const WEIGHT_MAX_DECIMALS = 2;

/**
 * A new weight at least this many times the previous one — or at most its
 * reciprocal — warns.
 *
 * A ratio of two rather than a percentage, because the errors this exists to
 * catch are a slipped decimal (×10) and pounds typed as kilograms (×2.2), while
 * a real change of 30–40% happens in a growing puppy or a wasting dog. A
 * tighter threshold would fire on real animals and train people to dismiss it.
 */
export const WEIGHT_JUMP_RATIO = 2;

/**
 * Weights above these warn, per species. Generous on purpose: they catch a
 * missing comma ("125" for "12,5"), not a big dog.
 *
 * `other` has no ceiling, because the platform does not know what it is.
 */
export const WEIGHT_UNUSUAL_ABOVE_KG: Record<Species, number | null> = {
  dog: 90,
  cat: 12,
  rabbit: 12,
  other: null,
};

export function isBodyConditionScore(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 9;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading a typed weight
// ─────────────────────────────────────────────────────────────────────────────

export type WeightParse =
  | { kind: 'empty' }
  | { kind: 'ok'; kg: number }
  | { kind: 'invalid' }
  | { kind: 'too-precise' };

/**
 * A weight as typed, in either decimal convention.
 *
 * Accepts "12", "12,5", "12.5", "0,85", and a trailing "kg". Refuses a sign, a
 * thousands separator, more than one separator, a bare leading or trailing
 * separator, and more than WEIGHT_MAX_DECIMALS decimals — see the module header
 * for why the last is a refusal rather than a rounding.
 *
 * ⚠️ Never replace this with `Number(text)` or `parseFloat`. `Number('12,5')`
 * is NaN and `parseFloat('12,5')` is 12 — the second silently drops the half
 * kilogram, which is the failure this function exists to make impossible.
 */
export function parseWeightInput(text: string): WeightParse {
  const trimmed = text.trim().replace(/\s*kg$/i, '').trim();
  if (trimmed === '') return { kind: 'empty' };

  const match = /^(\d+)(?:[.,](\d+))?$/.exec(trimmed);
  if (!match) return { kind: 'invalid' };

  const decimals = match[2] ?? '';
  if (decimals.length > WEIGHT_MAX_DECIMALS) return { kind: 'too-precise' };

  const kg = Number(decimals ? `${match[1]}.${decimals}` : match[1]);
  if (!Number.isFinite(kg)) return { kind: 'invalid' };
  return { kind: 'ok', kg };
}

// ─────────────────────────────────────────────────────────────────────────────
// The draft a form holds
// ─────────────────────────────────────────────────────────────────────────────

export interface MeasurementDraft {
  /** As typed. Read by `parseWeightInput`, never by `Number()`. */
  weightText: string;
  bcs: number | null;
  mcs: MuscleCondition | null;
  /** Epoch ms. Null while the form is incomplete. */
  measuredAt: number | null;
  /** Who weighed or scored — usually the vet, who usually has no account. */
  measuredBy: string | null;
  note: string | null;
}

/**
 * ⚠️ Takes no pet, deliberately. The intake photo's estimated range must never
 * pre-fill a weight here: a prefilled number is one tap from being saved as a
 * measurement nobody took, and from there it reaches an mg/kg dose.
 */
export function measurementDraftDefaults(): MeasurementDraft {
  return {
    weightText: '',
    bcs: null,
    mcs: null,
    measuredAt: null,
    measuredBy: null,
    note: null,
  };
}

/** The weight a valid draft will store, or null. Validate first. */
export function measuredWeightKg(draft: MeasurementDraft): number | null {
  const weight = parseWeightInput(draft.weightText);
  return weight.kind === 'ok' ? weight.kg : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors: structurally impossible only
// ─────────────────────────────────────────────────────────────────────────────

export type MeasurementError =
  | 'nothing-measured'
  | 'measured-required'
  | 'measured-in-future'
  | 'weight-invalid'
  | 'weight-too-precise'
  | 'weight-not-positive'
  | 'weight-too-heavy'
  | 'bcs-out-of-range';

/**
 * ⚠️ "In the future" means a LATER CALENDAR DAY, not a later instant, so an
 * animal weighed this morning can be recorded this morning. The day logic is
 * `dayToInstant` in `date-input.ts`, the same one the food forms use. Clock
 * skew is layered on top: Firestore's clock measured 2.7 s AHEAD of the dev
 * machine on 2026-08-24, and a browser clock drifts by minutes, so
 * `CLOCK_SKEW_TOLERANCE_MS` is added to `now` before the day is compared.
 */
export function validateMeasurementDraft(
  draft: MeasurementDraft,
  now: number = Date.now()
): MeasurementError[] {
  const errors: MeasurementError[] = [];
  const weight = parseWeightInput(draft.weightText);

  if (weight.kind === 'invalid') {
    errors.push('weight-invalid');
  } else if (weight.kind === 'too-precise') {
    errors.push('weight-too-precise');
  } else if (weight.kind === 'ok') {
    if (weight.kg <= 0) errors.push('weight-not-positive');
    else if (weight.kg > WEIGHT_MAX_KG) errors.push('weight-too-heavy');
  }

  if (draft.bcs !== null && !isBodyConditionScore(draft.bcs)) {
    errors.push('bcs-out-of-range');
  }

  // Only an EMPTY weight counts toward "nothing measured". An unreadable one
  // already has its own error, and stacking this on top would tell someone who
  // typed "12.500" that they typed nothing.
  if (weight.kind === 'empty' && draft.bcs === null && draft.mcs === null) {
    errors.push('nothing-measured');
  }

  const tolerantNow = now + CLOCK_SKEW_TOLERANCE_MS;
  if (draft.measuredAt === null) {
    errors.push('measured-required');
  } else if (dayToInstant(draft.measuredAt, tolerantNow) > tolerantNow) {
    errors.push('measured-in-future');
  }

  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// History
// ─────────────────────────────────────────────────────────────────────────────

export interface WeightReading {
  kg: number;
  measuredAt: number;
}

/**
 * The most recent MEASURED weight, with its date, or null.
 *
 * ⚠️ This is the only function dosing (step 11) and rations (step 13) should
 * read a weight from. It skips readings that scored body condition without
 * weighing, and it returns the date alongside the number on purpose: a weight
 * without its date is not dosable, because an animal that was weighed months
 * ago is not that weight now.
 *
 * Order-independent — it does not trust the caller's sort.
 */
export function latestWeight<T extends { weightKg: number | null; measuredAt: number }>(
  history: readonly T[]
): WeightReading | null {
  let best: WeightReading | null = null;
  for (const entry of history) {
    if (entry.weightKg === null || !(entry.weightKg > 0)) continue;
    if (best === null || entry.measuredAt > best.measuredAt) {
      best = { kg: entry.weightKg, measuredAt: entry.measuredAt };
    }
  }
  return best;
}

/** The most recent body-condition score, skipping weight-only readings. */
export function latestBodyCondition<T extends { bcs: number | null; measuredAt: number }>(
  history: readonly T[]
): { bcs: number; measuredAt: number } | null {
  let best: { bcs: number; measuredAt: number } | null = null;
  for (const entry of history) {
    if (entry.bcs === null) continue;
    if (best === null || entry.measuredAt > best.measuredAt) {
      best = { bcs: entry.bcs, measuredAt: entry.measuredAt };
    }
  }
  return best;
}

/**
 * The weight to compare a new reading against: the latest one taken at or
 * before `at`, excluding the record being edited.
 *
 * Excluding the edited record matters: correcting "125" to "12,5" would
 * otherwise compare the correction against the typo and warn about the fix.
 */
export function previousWeight<
  T extends { id: string; weightKg: number | null; measuredAt: number },
>(history: readonly T[], at: number | null, excludeId: string | null = null): WeightReading | null {
  return latestWeight(
    history.filter((entry) => entry.id !== excludeId && (at === null || entry.measuredAt <= at))
  );
}

/**
 * Whole days since a reading, clamped at zero.
 *
 * ⚠️ Clamped for the same measured reason as `daysSinceLastArrival` in
 * `areas.ts`: a reading dated moments ago can sit a few seconds in the
 * caller's future, and `Math.floor` of a tiny negative is -1. "Hace -1 días" is
 * not a sentence.
 */
export function daysSinceMeasured(measuredAt: number, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - measuredAt) / DAY_MS));
}

// ─────────────────────────────────────────────────────────────────────────────
// Warnings: worth a second look, never blocking
// ─────────────────────────────────────────────────────────────────────────────

export type MeasurementWarning =
  /** At least double, or at most half, the previous measured weight. */
  | { kind: 'weight-jump'; direction: 'up' | 'down'; previousKg: number }
  /** Heavier than this species plausibly is — usually a missing comma. */
  | { kind: 'weight-unusual-for-species'; species: Species; aboveKg: number };

export interface MeasurementWarningContext {
  species?: Species | null;
  history?: readonly { id: string; weightKg: number | null; measuredAt: number }[];
  /** The record being edited, so a correction is not compared to its typo. */
  editingId?: string | null;
}

/**
 * Checks that inform without blocking. Every one fails toward SILENCE when its
 * input is missing — no previous weight, no species, no readable number — for
 * the reason `medical.ts` gives: a warning about something nobody can evaluate
 * is how a warning system trains people to ignore it.
 */
export function measurementWarnings(
  draft: MeasurementDraft,
  ctx: MeasurementWarningContext = {}
): MeasurementWarning[] {
  const warnings: MeasurementWarning[] = [];
  const weight = parseWeightInput(draft.weightText);
  if (weight.kind !== 'ok' || weight.kg <= 0) return warnings;
  const kg = weight.kg;

  const species = ctx.species ?? null;
  const ceiling = species === null ? null : WEIGHT_UNUSUAL_ABOVE_KG[species];
  if (species !== null && ceiling !== null && kg > ceiling) {
    warnings.push({ kind: 'weight-unusual-for-species', species, aboveKg: ceiling });
  }

  const previous = previousWeight(ctx.history ?? [], draft.measuredAt, ctx.editingId ?? null);
  if (previous !== null) {
    const ratio = kg / previous.kg;
    if (ratio >= WEIGHT_JUMP_RATIO) {
      warnings.push({ kind: 'weight-jump', direction: 'up', previousKg: previous.kg });
    } else if (ratio <= 1 / WEIGHT_JUMP_RATIO) {
      warnings.push({ kind: 'weight-jump', direction: 'down', previousKg: previous.kg });
    }
  }

  return warnings;
}
