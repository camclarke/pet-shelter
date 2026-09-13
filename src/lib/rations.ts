/**
 * Daily rations: the PURE layer. Plan §12.3.
 *
 * No Firestore, no Spanish, no model. Every number a person acts on at feeding
 * time comes from here, and from nowhere that can give two answers.
 *
 * ═══ THE STANDARD ═══════════════════════════════════════════════════════════
 *
 *     RER (kcal/day) = 70 × weightKg^0.75           resting energy requirement
 *     MER            = RER × factor                 maintenance, by life stage
 *
 * Sources for the formula and the factors:
 *   - National Research Council (2006). Nutrient Requirements of Dogs and Cats.
 *     The allometric RER equation.
 *   - WSAVA Global Nutrition Committee: Nutritional Assessment Guidelines
 *     (J Small Anim Pract, 2011) and the WSAVA Global Nutrition Toolkit.
 *   - 2021 AAHA Nutrition and Weight Management Guidelines for Dogs and Cats
 *     (J Am Anim Hosp Assoc, 2021).
 *   ⚠️ Author lists and page ranges are deliberately omitted: they were not
 *   checked against the documents themselves, and a precise-looking citation
 *   that is wrong is worse than a short one that is right.
 *
 * The factors used here are the widely published STARTING points from that
 * guidance: dog puppy under 4 months ×3.0, dog 4–12 months ×2.0, adult dog
 * ×1.6 (neutered) to ×1.8 (intact); kitten ×2.5, adult cat ×1.2 (neutered) to
 * ×1.4 (intact). ⚠️ They were confirmed on 2026-09-12 against secondary
 * summaries of the WSAVA toolkit and AAHA guidelines, not against the tables in
 * the primary documents, which could not be retrieved that night. Every
 * guideline is explicit that these are where to START and that body condition
 * over the following weeks is what corrects them.
 *
 * ═══ WHAT THIS DOES NOT DO ═════════════════════════════════════════════════
 *   - It does not turn kilocalories into LADLES. That needs the soup's energy
 *     density, which nobody knows — the pot is whatever was donated this week.
 *     See `potShares`, which answers the useful question without it.
 *   - It does not change a ration. Body condition produces a SUGGESTION. The
 *     person with the ladle decides; plan §12.3 says the system does not
 *     overrule the staff.
 *   - It does not read a weight from anywhere except `latestWeight()`, and it
 *     never reads the photo estimate (`Pet.weightKgMin/Max`). See `rationFor`.
 *   - It does not model rabbits. RER applies to dogs and cats; a rabbit is a
 *     hindgut-fermenting herbivore and the formula is the wrong tool.
 *
 * ═══ A CORRECTION TO THE PLAN'S ARITHMETIC, WORTH KEEPING ═══════════════════
 * Plan §12.3 (and the 2026-08-16 log entry) says a LINEAR ladle rule
 * underfeeds large dogs. That is backwards for a rule linear in WEIGHT: energy
 * grows as kg^0.75, slower than weight, so a ladle count proportional to kg
 * would OVERfeed a 30 kg dog relative to a 5 kg one (6× the ladles, 3,8× the
 * energy). What does underfeed large dogs is the rule the staff actually use —
 * "4 for a big one, 2 for a small one" — because it is FLATTER than kg^0.75:
 * 2× the ladles where the standard says 3,8×. The practical conclusion the plan
 * drew still holds for Wawitas; the reason is the heuristic's flatness, not its
 * linearity.
 */

import type { Species } from './types';
import {
  WEIGHT_MAX_KG,
  daysSinceMeasured,
  latestBodyCondition,
  latestWeight,
  type WeightReading,
} from './measurements';

export const RER_KCAL_COEFFICIENT = 70;
export const RER_EXPONENT = 0.75;

/**
 * Resting energy requirement in kcal/day, or null for a weight no animal has.
 *
 * ⚠️ Null rather than a number for 0, a negative, NaN or anything above
 * `WEIGHT_MAX_KG`. A formula happily returns 70 × 0^0.75 = 0 and 70 × 1250^0.75
 * ≈ 14 000, and both would be printed as a standard.
 */
export function restingEnergyKcal(kg: number): number | null {
  if (!Number.isFinite(kg) || kg <= 0 || kg > WEIGHT_MAX_KG) return null;
  return RER_KCAL_COEFFICIENT * Math.pow(kg, RER_EXPONENT);
}

// ─────────────────────────────────────────────────────────────────────────────
// Life stage
// ─────────────────────────────────────────────────────────────────────────────

export type EnergyStage = 'puppy-early' | 'puppy-late' | 'adult-dog' | 'kitten' | 'adult-cat';

/** min–max multipliers of RER. See the module header for the sources. */
export const ENERGY_FACTORS: Record<EnergyStage, { min: number; max: number }> = {
  'puppy-early': { min: 3.0, max: 3.0 },
  'puppy-late': { min: 2.0, max: 2.0 },
  // Neutered to intact. Sterilisation lives in the authenticated `detail`
  // document and is not read for a ration, so the range spans both honestly.
  'adult-dog': { min: 1.6, max: 1.8 },
  kitten: { min: 2.5, max: 2.5 },
  'adult-cat': { min: 1.2, max: 1.4 },
};

/** Under this many months a puppy is in its fastest growth. */
export const PUPPY_EARLY_BELOW_MONTHS = 4;

/**
 * Growth ends here for the purpose of a factor.
 *
 * ⚠️ A simplification: giant breeds grow until 18–24 months. A street mix's
 * adult size is rarely known at intake, so the common 12-month cut is used and
 * body condition is what catches the exception.
 */
export const GROWTH_BELOW_MONTHS = 12;

function stageAt(species: 'dog' | 'cat', months: number): EnergyStage {
  if (species === 'cat') return months < GROWTH_BELOW_MONTHS ? 'kitten' : 'adult-cat';
  if (months < PUPPY_EARLY_BELOW_MONTHS) return 'puppy-early';
  if (months < GROWTH_BELOW_MONTHS) return 'puppy-late';
  return 'adult-dog';
}

export interface AgeInput {
  ageMonths: number | null;
  /** The bounds of an estimated age, when the intake recorded one. */
  ageMonthsMin?: number | null;
  ageMonthsMax?: number | null;
}

export type FactorResult =
  | { kind: 'ok'; stages: EnergyStage[]; min: number; max: number; growing: boolean }
  | { kind: 'age-unknown' }
  | { kind: 'not-applicable' };

/**
 * The MER factor for an animal, as a RANGE.
 *
 * An estimated age that straddles a stage boundary — "between 3 and 6 months"
 * — spans both factors (×2,0 to ×3,0) rather than picking the midpoint's
 * stage. The midpoint of an estimate is a guess, and a factor chosen from it
 * would present the guess as a standard.
 */
export function energyFactorFor(species: Species, age: AgeInput): FactorResult {
  if (species !== 'dog' && species !== 'cat') return { kind: 'not-applicable' };

  const valid = (n: number | null | undefined): n is number =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0;

  let low: number;
  let high: number;
  if (valid(age.ageMonthsMin) && valid(age.ageMonthsMax) && age.ageMonthsMax >= age.ageMonthsMin) {
    low = age.ageMonthsMin;
    high = age.ageMonthsMax;
  } else if (valid(age.ageMonths)) {
    low = age.ageMonths;
    high = age.ageMonths;
  } else {
    return { kind: 'age-unknown' };
  }

  const stages = [...new Set([stageAt(species, low), stageAt(species, high)])];
  // A range that crosses early→late→adult passes through the middle stage too.
  if (species === 'dog' && stages.includes('puppy-early') && stages.includes('adult-dog')) {
    stages.splice(1, 0, 'puppy-late');
  }
  const min = Math.min(...stages.map((s) => ENERGY_FACTORS[s].min));
  const max = Math.max(...stages.map((s) => ENERGY_FACTORS[s].max));
  const growing = stages.some((s) => s !== 'adult-dog' && s !== 'adult-cat');
  return { kind: 'ok', stages, min, max, growing };
}

// ─────────────────────────────────────────────────────────────────────────────
// Body condition: a suggestion, never a change
// ─────────────────────────────────────────────────────────────────────────────

export type BodyConditionSuggestion =
  /** BCS 7 or more: reduce, and score again in about four weeks. */
  | { kind: 'reduce-and-rescore'; bcs: number; days: number }
  /**
   * BCS 3 or less: increase — but a thin animal in a shelter is a clinical
   * question before it is a feeding one. Parasites and disease first. Plan §12.3.
   */
  | { kind: 'increase-after-health-check'; bcs: number; days: number };

export const BCS_REDUCE_FROM = 7;
export const BCS_INCREASE_AT_OR_BELOW = 3;

export function bodyConditionSuggestion(
  history: readonly { bcs: number | null; measuredAt: number }[],
  now: number = Date.now()
): BodyConditionSuggestion | null {
  const latest = latestBodyCondition(history);
  if (latest === null) return null;
  const days = daysSinceMeasured(latest.measuredAt, now);
  if (latest.bcs >= BCS_REDUCE_FROM) return { kind: 'reduce-and-rescore', bcs: latest.bcs, days };
  if (latest.bcs <= BCS_INCREASE_AT_OR_BELOW) {
    return { kind: 'increase-after-health-check', bcs: latest.bcs, days };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// One animal's ration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A growing animal's weight older than this is flagged.
 *
 * ⚠️ Adults are deliberately NOT flagged, and the reason is the owner's answer
 * of 2026-09-12: animals are weighed when sick or at the vet, not on a
 * schedule, so an overdue flag on every adult is a warning people learn to
 * ignore. The AGE of every reading is shown on every row instead. A puppy is
 * different in kind: a month is a large fraction of its weight, and a RER from
 * last month's weight is simply a different number.
 */
export const GROWING_WEIGHT_STALE_DAYS = 30;

export interface RationPetInput extends AgeInput {
  species: Species;
  /** Pet.weightKgMin/Max — the PHOTO ESTIMATE. Shown for context, never computed with. */
  estimatedKgMin?: number | null;
  estimatedKgMax?: number | null;
}

export type RationResult =
  | { kind: 'not-applicable'; species: Species }
  /**
   * No measured weight. The photo estimate travels along ONLY so the UI can
   * say "the photos estimated 18–26 kg, which is not used" — see the decision
   * on `rationFor`.
   */
  | { kind: 'no-weight'; estimate: { minKg: number; maxKg: number } | null }
  /** A stored weight this module refuses to compute with. Should be unreachable. */
  | { kind: 'implausible-weight'; weight: WeightReading }
  | {
      kind: 'age-unknown';
      weight: WeightReading;
      weightDays: number;
      rerKcal: number;
      suggestion: BodyConditionSuggestion | null;
    }
  | {
      kind: 'ok';
      weight: WeightReading;
      weightDays: number;
      rerKcal: number;
      merMinKcal: number;
      merMaxKcal: number;
      stages: EnergyStage[];
      suggestion: BodyConditionSuggestion | null;
      staleForGrowth: boolean;
    };

/**
 * The standard's view of one animal's daily energy.
 *
 * ═══ DECISION: THE PHOTO ESTIMATE IS EXCLUDED, NOT LABELLED ═════════════════
 * Decided 2026-09-12. The intake photo's range is never used for a ration, not
 * even with an "estimate" badge. Four reasons:
 *
 *   1. The estimate is a RANGE. 18–26 kg spans ×1,32 in RER; collapsing it to a
 *      midpoint makes a guess look like a standard, and printing a kcal range
 *      invites the midpoint anyway.
 *   2. `potShares` compounds it: one dog's guessed energy moves every other
 *      dog's share of the pot, so a labelled estimate on one row silently
 *      contaminates rows that carry no label.
 *   3. Step 10 already set this line for the adjacent case: the photo range is
 *      "unfit for a dose" and is never offered as a value.
 *   4. The shelter HAS a scale (plan §11 #7, answered 2026-09-12). The remedy
 *      for a missing weight is a weighing, and "falta pesar" on the sheet is an
 *      instruction someone can act on; a labelled guess is not.
 *
 * Weight is read ONLY through `latestWeight()`, which returns the date too.
 */
export function rationFor(
  pet: RationPetInput,
  history: readonly { weightKg: number | null; bcs: number | null; measuredAt: number }[],
  now: number = Date.now()
): RationResult {
  const factor = energyFactorFor(pet.species, pet);
  if (factor.kind === 'not-applicable') return { kind: 'not-applicable', species: pet.species };

  const weight = latestWeight(history);
  if (weight === null) {
    const { estimatedKgMin: min, estimatedKgMax: max } = pet;
    return {
      kind: 'no-weight',
      estimate:
        typeof min === 'number' && typeof max === 'number' && min > 0 && max >= min
          ? { minKg: min, maxKg: max }
          : null,
    };
  }

  const rerKcal = restingEnergyKcal(weight.kg);
  if (rerKcal === null) return { kind: 'implausible-weight', weight };

  const weightDays = daysSinceMeasured(weight.measuredAt, now);
  const suggestion = bodyConditionSuggestion(history, now);

  if (factor.kind === 'age-unknown') {
    return { kind: 'age-unknown', weight, weightDays, rerKcal, suggestion };
  }

  return {
    kind: 'ok',
    weight,
    weightDays,
    rerKcal,
    merMinKcal: rerKcal * factor.min,
    merMaxKcal: rerKcal * factor.max,
    stages: factor.stages,
    suggestion,
    staleForGrowth: factor.growing && weightDays > GROWING_WEIGHT_STALE_DAYS,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Share of the pot: the comparison that needs no energy density
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How far a recorded share may drift from the standard's share before it is
 * flagged. 1,25 is well outside the ±6 % that the neutered/intact range adds
 * to an adult's midpoint, so the flag is about the ration, not the rounding.
 */
export const SHARE_DIVERGENCE_RATIO = 1.25;

/** Species that eat from the communal pot. Cats are not fed rice soup. */
export const POT_SPECIES: readonly Species[] = ['dog'];

export interface PotShareInput {
  petId: string;
  /** Midpoint of MER, from an `ok` ration. Null when there is no standard. */
  merKcal: number | null;
  /** Ladles recorded for the day. Null or 0 when nothing is written down. */
  ladles: number | null;
}

export interface PotShareRow {
  petId: string;
  /** 0–1: this animal's energy need over the whole group's. */
  standardShare: number;
  /** 0–1: this animal's ladles over the whole group's. */
  recordedShare: number;
  /** Gets clearly less (`under`) or more (`over`) of the pot than the standard suggests. */
  divergence: 'under' | 'over' | null;
}

export type PotShareExclusion = { petId: string; reason: 'no-standard' | 'no-ration' };

/**
 * Each dog's share of the pot, by the standard and by the recorded ladles.
 *
 * ═══ WHY SHARES AND NOT LADLES ══════════════════════════════════════════════
 * Converting kcal to ladles needs the soup's energy per ladle, which nobody
 * knows and which changes with every donation. But every dog eats from the
 * SAME pot, so the density is the same for all of them and cancels out of a
 * ratio. "The standard says this dog needs 6 % of the day's food; the ladles
 * written down give it 4 %" is true whatever is in the pot, and it is exactly
 * the divergence plan §12.3 wants visible.
 *
 * ⚠️ It says nothing about whether the POT is big enough — only how it is
 * divided. And it suggests no ladle counts: that would be a ladle estimate,
 * which this project does not show while the pot and ladle measurements are
 * unknown.
 *
 * Fewer than two comparable dogs gives no rows: one dog is always 100 % of
 * itself.
 */
export function potShares(inputs: readonly PotShareInput[]): {
  rows: PotShareRow[];
  excluded: PotShareExclusion[];
} {
  const excluded: PotShareExclusion[] = [];
  const comparable: { petId: string; merKcal: number; ladles: number }[] = [];

  for (const input of inputs) {
    if (input.merKcal === null || !(input.merKcal > 0)) {
      excluded.push({ petId: input.petId, reason: 'no-standard' });
    } else if (input.ladles === null || !(input.ladles > 0)) {
      excluded.push({ petId: input.petId, reason: 'no-ration' });
    } else {
      comparable.push({ petId: input.petId, merKcal: input.merKcal, ladles: input.ladles });
    }
  }

  if (comparable.length < 2) return { rows: [], excluded };

  const totalKcal = comparable.reduce((sum, c) => sum + c.merKcal, 0);
  const totalLadles = comparable.reduce((sum, c) => sum + c.ladles, 0);

  const rows = comparable.map((c) => {
    const standardShare = c.merKcal / totalKcal;
    const recordedShare = c.ladles / totalLadles;
    const divergence =
      recordedShare * SHARE_DIVERGENCE_RATIO < standardShare
        ? 'under'
        : recordedShare > standardShare * SHARE_DIVERGENCE_RATIO
          ? 'over'
          : null;
    return { petId: c.petId, standardShare, recordedShare, divergence } satisfies PotShareRow;
  });

  return { rows, excluded };
}

/** The midpoint used for shares. Exported so the sheet and the test agree. */
export function merMidpointKcal(result: RationResult): number | null {
  return result.kind === 'ok' ? (result.merMinKcal + result.merMaxKcal) / 2 : null;
}
