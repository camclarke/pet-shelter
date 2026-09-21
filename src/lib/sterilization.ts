/**
 * Whether an animal is sterilized — and the difference between "no" and
 * "nobody wrote it down".
 *
 * ── Why this is three-state ───────────────────────────────────────────────
 * `sterilized` was a boolean, and the register importer set it from
 * `sterilizedPerRegister || sterilizedByEvent`. So a `false` meant "the paper
 * did not say", which is NOT the same claim as "this animal is unaltered". On
 * a handwritten register the absence of a note is not evidence of anything,
 * and 15 of the 42 animals still in the shelter carry exactly that `false`.
 *
 * Collapsing the two is the same mistake `rabiesAgeIsValid()` avoids by
 * returning `boolean | null`: an unknown must never read as a violation. It is
 * also the distinction the register import already draws elsewhere — a row's
 * `speciesWhy` records whether a person confirmed the species or the importer
 * inferred it, precisely so the two never read the same.
 *
 * ── What the standard asks for ────────────────────────────────────────────
 * The 2022 ASV Guidelines for Standards of Care in Animal Shelters, §7.2
 * Spay-Neuter, carries one **must** about record-keeping:
 *
 *   "Shelters performing post-adoption sterilization must have a system for
 *    keeping track of unaltered animals and ensuring that surgery is completed
 *    in a timely manner"
 *
 * and, as a should:
 *
 *   "Sterilization status should be documented for each animal"
 *
 * A boolean cannot document "unknown", so the shelter could not produce that
 * list: asking for unaltered animals returned 15 whose status nobody had ever
 * recorded. `needsAttention()` is that list, and it deliberately includes both
 * — they need different actions (book surgery vs. go and check), but both are
 * animals the shelter cannot yet say are sterilized.
 *
 * ⚠️ NOTHING HERE IS ABOUT WHEN TO STERILIZE. That lives in
 * src/lib/sterilization-timing.ts, which applies the AAHA 2019 canine chart
 * (sex, expected ADULT weight, age) and reads `expectedAdultWeightBand` — a
 * field added for it on 2026-09-21. This module answers only "is it done?",
 * and the two stay separate because the second question is a standard's
 * recommendation while this one is a fact about the record.
 *
 * (An earlier version of this comment said the timing rule needed a field
 * that did not exist. It now does; the comment is corrected rather than left
 * describing a gap that has closed.)
 */

/** What the shelter can actually say about one animal. */
export type SterilizationStatus = 'sterilized' | 'not-sterilized' | 'unknown';

/**
 * `undefined` is treated as unknown, not as false.
 *
 * A document written before this field existed simply has no opinion, and a
 * missing field must not become a claim that the animal is unaltered.
 */
export function sterilizationStatusOf(
  value: boolean | null | undefined,
): SterilizationStatus {
  if (value === true) return 'sterilized';
  if (value === false) return 'not-sterilized';
  return 'unknown';
}

/**
 * Is this an animal the shelter cannot say is sterilized?
 *
 * TRUE for both "no" and "unknown", which is the whole point: ASV §7.2's list
 * of unaltered animals is a list of animals to ACT on, and "we never wrote it
 * down" needs acting on just as much as "not done yet" — arguably more, since
 * nobody has even looked.
 */
export function needsAttention(value: boolean | null | undefined): boolean {
  return sterilizationStatusOf(value) !== 'sterilized';
}

/** Counts for the roster's filter chip and any later report. */
export function countSterilization(
  values: readonly (boolean | null | undefined)[],
): { sterilized: number; notSterilized: number; unknown: number; needsAttention: number } {
  let sterilized = 0;
  let notSterilized = 0;
  let unknown = 0;
  for (const v of values) {
    const status = sterilizationStatusOf(v);
    if (status === 'sterilized') sterilized++;
    else if (status === 'not-sterilized') notSterilized++;
    else unknown++;
  }
  return { sterilized, notSterilized, unknown, needsAttention: notSterilized + unknown };
}
