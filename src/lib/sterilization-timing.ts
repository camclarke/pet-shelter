/**
 * When is it time to sterilize this dog? — the AAHA 2019 canine chart,
 * evaluated honestly over what intake actually knows.
 *
 * ── What this is and is not ───────────────────────────────────────────────
 * It PREPARES a veterinarian's decision. It never makes one. The 2022 ASV
 * Guidelines §7.2 say it in a must:
 *
 *   "The final decision regarding acceptance of any patient for surgery must
 *    be made by a veterinarian based on a physical examination, available
 *    medical history, and capacity of the surgical team."
 *
 * So the output is a statement about where an animal sits against a published
 * chart, shown to whoever books the vet's visit — the same line this project
 * draws around a computed dose, which may be displayed and never prescribed.
 *
 * ── The chart (AAHA 2019 Canine Life Stage Guidelines) ────────────────────
 * The handout asks two questions, sex and "How much do you think your dog
 * will weigh when fully grown?", and splits at 45 lb / 20 kg:
 *
 *                   less than 20 kg           more than 20 kg
 *   male            "Neuter at 6 months"      "Neuter after growth stops
 *                                               (9–15 months of age)"
 *   female          "Spay before first heat   "Spay between 5-15 months
 *                    cycle (5–6 months)"        of age"
 *
 * ⚠️ THE FEMALE-OVER-20 KG CELL IS NOT A WINDOW. Directly under it, under
 * "WHAT ARE THE COMPETING RISKS?", the chart splits it into two OPPOSING
 * options: spay before first heat (↓ breast cancer, prevents unwanted
 * litters) versus spay after growth stops, likely after first heat
 * (↑ breast cancer, ↓ certain other cancers and joint problems, may ↓
 * urinary incontinence). "5–15 months" is the union of two contradictory
 * recommendations. It is modelled as that union for the question "is it
 * time?", and `femaleOptions` is raised so the screen shows BOTH options and
 * leaves the choice to the vet — decided with the shelter owner 2026-09-21.
 *
 * ── Why every input is a RANGE ────────────────────────────────────────────
 * A veterinarian may never visit (the owner, 2026-09-20), so this has to work
 * on what intake produces — and intake produces ranges: an age read off teeth,
 * or written by hand in a register cell. So the rule evaluates every branch
 * the uncertainty still allows and answers only when they agree. A vague age
 * does not block an answer when every reading of it lands the same way: a dog
 * aged "24 to 48 months" is past every window in the chart, however vague.
 *
 * Measured against the shelter, 2026-09-21: of the 15 unsterilized animals
 * in the shelter, 8 have a usable age, and for 7 of those 8 BOTH sides of the
 * 20 kg line give the same answer. The band decides the action for exactly
 * one — n.º 222, a six-month-old male.
 *
 * ── The one word this module will never produce ───────────────────────────
 * There is no "not due yet". The only case where the band changes the answer
 * is a young large male, and the direction it changes it is WAIT — which runs
 * into ASV §7.1, the strongest category in that document: "It is unacceptable
 * for organizations to allow shelter animals to breed." So an animal before
 * the chart's window comes back as `early`, and the screen states the chart's
 * timing AND the shelter standard side by side, for the vet.
 */

import type { AdultWeightBand, PetSex, Species } from './types';

/** 45 lb, which the chart prints beside 20 kg. Documented, not used as the line. */
export const AAHA_THRESHOLD_LB = 45;

/**
 * The line the chart draws. It prints both "45 lbs" and "20 kg", and 45 lb is
 * 20.41 kg — so between 20.00 and 20.41 kg the two figures disagree, and the
 * chart's boxes ("Less than" / "More than") cover neither endpoint. This only
 * matters for comparing a MEASURED weight against a band (see
 * `bandConflict`), never for the band itself, which a person chooses. We use
 * 20 kg and flag a conflict only strictly above it.
 */
export const AAHA_THRESHOLD_KG = 20;

/** A window in months, both ends inclusive. */
type Window = readonly [from: number, to: number];

/**
 * The four cells, in months. `[6, 6]` is a point: the chart says "at 6
 * months", so a dog past six months is past the window rather than inside it.
 */
function windowFor(sex: PetSex, band: AdultWeightBand): Window {
  if (sex === 'male') return band === 'under-20kg' ? [6, 6] : [9, 15];
  // Female over 20 kg is the UNION of two competing options — see the header.
  return band === 'under-20kg' ? [5, 6] : [5, 15];
}

type Position = 'early' | 'open' | 'past';

/**
 * Where an age RANGE sits against one window. A range that straddles a window
 * edge sits in more than one position, and that is kept rather than collapsed
 * to a midpoint — the same thing `energyFactorFor` does in rations.ts, for the
 * same reason: a midpoint would present a guess as a standard.
 */
function positionsFor(ageMin: number, ageMax: number, [from, to]: Window): Set<Position> {
  const out = new Set<Position>();
  if (ageMin < from) out.add('early');
  if (ageMax >= from && ageMin <= to) out.add('open');
  if (ageMax > to) out.add('past');
  return out;
}

export interface TimingInput {
  species: Species | null | undefined;
  sex: PetSex | null | undefined;
  ageMonthsMin: number | null | undefined;
  ageMonthsMax: number | null | undefined;
  /** `null` is "nobody has said", and makes the rule consider BOTH bands. */
  band: AdultWeightBand | null | undefined;
}

export type RefusalReason = 'species-unknown' | 'not-a-dog' | 'sex-unknown' | 'age-unknown';

export type TimingResult =
  /** No canine guideline can be applied, and the reason names what is missing. */
  | { kind: 'refused'; reason: RefusalReason }
  /** Every reading the uncertainty allows is inside or past the window. */
  | { kind: 'act-now'; femaleOptions: boolean }
  /** Every reading is BEFORE the window. Never rendered as "not due yet". */
  | { kind: 'early'; femaleOptions: boolean }
  /** The readings disagree; `on` is the one fact that would settle it. */
  | { kind: 'depends'; on: 'band' | 'age'; femaleOptions: boolean };

/**
 * Evaluate the chart for one animal.
 *
 * Refusals are distinct on purpose. One shared "cannot evaluate" would send
 * someone to fix the wrong thing: a missing species is filled at the photo
 * session, a missing age by the teeth photo or the register, and "not a dog"
 * is not missing anything — AAHA 2019 is a CANINE guideline, and a cat or a
 * rabbit is outside it rather than unknown to it.
 */
export function sterilizationTiming(input: TimingInput): TimingResult {
  if (input.species == null) return { kind: 'refused', reason: 'species-unknown' };
  if (input.species !== 'dog') return { kind: 'refused', reason: 'not-a-dog' };
  if (input.sex == null) return { kind: 'refused', reason: 'sex-unknown' };

  const age = normalizeAgeRange(input.ageMonthsMin, input.ageMonthsMax);
  if (age === null) return { kind: 'refused', reason: 'age-unknown' };

  const bands: AdultWeightBand[] = input.band
    ? [input.band]
    : ['under-20kg', 'over-20kg'];

  const perBand = bands.map((band) => ({
    band,
    positions: positionsFor(age.min, age.max, windowFor(input.sex!, band)),
  }));

  const all = new Set<Position>();
  for (const { positions } of perBand) for (const p of positions) all.add(p);

  // The competing-risk note belongs on screen while the choice is still live:
  // a female that COULD be over 20 kg and has not yet passed that cell. For an
  // adult female both options are in the past, and the note is noise.
  const overCell = perBand.find((b) => b.band === 'over-20kg');
  const femaleOptions =
    input.sex === 'female' &&
    overCell !== undefined &&
    !(overCell.positions.size === 1 && overCell.positions.has('past'));

  if (!all.has('early')) return { kind: 'act-now', femaleOptions };
  if (all.size === 1) return { kind: 'early', femaleOptions };

  // The readings disagree. If the band is unknown and every band ON ITS OWN is
  // decisive — wholly early, or wholly not — then learning the band settles it.
  // Otherwise only a better age will.
  const decisive = (s: Set<Position>) => !s.has('early') || s.size === 1;
  const on: 'band' | 'age' =
    !input.band && perBand.every((b) => decisive(b.positions)) ? 'band' : 'age';
  return { kind: 'depends', on, femaleOptions };
}

/**
 * A usable age range, or null.
 *
 * One end alone is accepted as a point. A negative age, or a range whose ends
 * are the wrong way round, is not a reading of an animal — it is refused
 * rather than repaired, because repairing it would invent the age.
 */
export function normalizeAgeRange(
  min: number | null | undefined,
  max: number | null | undefined,
): { min: number; max: number } | null {
  const lo = min ?? max;
  const hi = max ?? min;
  if (lo == null || hi == null) return null;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  if (lo < 0 || hi < lo) return null;
  return { min: lo, max: hi };
}

/** The average Gregorian month, in milliseconds. */
const MONTH_MS = 30.436875 * 24 * 60 * 60 * 1000;

/**
 * Age today, from age at intake plus the time since.
 *
 * ⚠️ Computed at READ time and never written back. The register importer
 * declined to store a derived age on the draft, because age at intake is not
 * age today and a stored age would block the photo session from reading the
 * teeth. Deriving it for a recommendation is a different act from storing it
 * as somebody's answer. And it is still only as good as a handwritten cell —
 * n.º 215 reads "25 MESES", possibly "2,5 MESES".
 */
export function ageRangeToday(
  ageAtIntakeMin: number | null | undefined,
  ageAtIntakeMax: number | null | undefined,
  intakeMs: number | null | undefined,
  nowMs: number,
): { min: number; max: number } | null {
  const atIntake = normalizeAgeRange(ageAtIntakeMin, ageAtIntakeMax);
  if (atIntake === null || intakeMs == null || !Number.isFinite(intakeMs)) return null;
  // An intake date in the future is a data error, not a negative elapsed time.
  const elapsed = Math.max(0, (nowMs - intakeMs) / MONTH_MS);
  return { min: atIntake.min + elapsed, max: atIntake.max + elapsed };
}

/**
 * Does a measured weight contradict the band somebody chose?
 *
 * A CONFLICT, never an override. The premise "dogs do not shrink" is true of
 * the frame and false of the scale: obesity, late pregnancy and ascites all
 * put a small-framed dog over 20 kg. So a heavy reading is shown to a person
 * beside the band, and the band is never rewritten.
 *
 * Only one direction is checked. A reading under 20 kg proves nothing about
 * the adult weight of an animal that is still growing, so "over-20kg" can
 * never be contradicted by a scale — only "under-20kg" can.
 *
 * `heaviestKg` must come from `heaviestWeight()`, not `latestWeight()`: the
 * premise is about the maximum ever recorded, and a dog weighed 22 kg in March
 * and 19 kg in September still reached 22.
 */
export function bandConflict(
  band: AdultWeightBand | null | undefined,
  heaviestKg: number | null | undefined,
): boolean {
  return band === 'under-20kg' && heaviestKg != null && heaviestKg > AAHA_THRESHOLD_KG;
}
