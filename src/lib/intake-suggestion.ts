/**
 * Photo-assisted intake: the PURE decision layer.
 *
 * No Firestore import, no AI import, no Spanish. It takes what a vision model
 * claimed about a photograph and decides what the shelter is allowed to do with
 * each claim. `src/lib/ai/intake-suggest.ts` makes the call; this file decides
 * what the answer is worth. Same split as `areas.ts` / `areas-admin.ts`.
 *
 * ═══ FAILURE DIRECTION, PER FIELD ═══════════════════════════════════════════
 * Playbook §6.2: decide the direction per gate, explicitly, and write it in the
 * module header. These do NOT all point the same way, and that is the design.
 *
 * | Field       | Fails toward        | Why                                     |
 * |-------------|---------------------|-----------------------------------------|
 * | species     | suggesting          | Reliable from a photo, and trivially    |
 * |             |                     | corrected by someone holding the animal |
 * | name        | suggesting          | A suggestion, not a truth claim. There  |
 * |             |                     | is nothing to be wrong about            |
 * | breed       | MIXED ("mestizo")   | Visual breed ID disagrees badly with    |
 * |             |                     | DNA even among shelter staff. A         |
 * |             |                     | confident wrong breed on a public       |
 * |             |                     | listing attracts the wrong adopter and  |
 * |             |                     | ends in a returned animal — and some    |
 * |             |                     | labels carry housing and legal weight   |
 * | age         | a WIDER RANGE       | Tooth eruption is tight for puppies;    |
 * |             |                     | adult wear varies enormously with diet  |
 * |             |                     | and chewing. A street dog's teeth are   |
 * |             |                     | not a house dog's                       |
 * | size        | NOT answering       | Unreliable without a scale reference,   |
 * |             |                     | and it is the field a human standing    |
 * |             |                     | next to the animal is best at           |
 * | sex         | NOT ANSWERABLE      | Not in the schema at all — see below    |
 *
 * ═══ WHY `sex` IS ABSENT RATHER THAN NULLABLE ═══════════════════════════════
 * `sex` drives Spanish gender agreement across the entire site — the species
 * noun, the size adjective, every past participle. One wrong guess makes every
 * sentence about that animal ungrammatical, in the only language its readers
 * use. Asking a model to return null for a field it cannot see invites it to
 * guess anyway. Giving it nowhere to put the answer does not.
 *
 * **The safest way to stop a model asserting something is to remove the place
 * it would put the assertion.** That is a structural guarantee rather than a
 * prompt instruction, and prompt instructions are the thing that erodes.
 */

import type { PetSex, PetSize, Species } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// What the model is allowed to claim
// ─────────────────────────────────────────────────────────────────────────────

export type Confidence = 'high' | 'medium' | 'low';

export type LifeStage = 'puppy' | 'young' | 'adult' | 'senior';

/** What the age estimate was actually read off. Recorded so a reviewer can weigh it. */
export type AgeBasis = 'teeth' | 'body' | 'coat' | 'unknown';

/**
 * The raw claim, exactly as the model returns it. Deliberately permissive: this
 * is untrusted input and every field is validated downstream. Note the absence
 * of `sex`, and the absence of any bare `breed` string.
 */
export interface RawPhotoSuggestion {
  species: Species | null;
  speciesConfidence: Confidence;

  /** Free text, e.g. "mestizo de tamaño mediano con rasgos de pastor". */
  visibleType: string | null;
  /** The model's own claim that this animal is a recognisable purebred. */
  isLikelyPurebred: boolean;
  /** Only meaningful when `isLikelyPurebred`; still never auto-applied. */
  purebredGuess: string | null;
  /**
   * Breeds a MIXED animal resembles, most-alike first. May be empty, and an
   * empty list is a valid answer rather than a failure — the prompt says so
   * explicitly, because inventing a likeness is worse than admitting none.
   */
  resemblesBreeds: string[];

  lifeStage: LifeStage | null;
  ageMonthsMin: number | null;
  ageMonthsMax: number | null;
  ageBasis: AgeBasis;
  ageConfidence: Confidence;

  size: PetSize | null;
  sizeConfidence: Confidence;
  /** Whether anything in frame gave a sense of scale. */
  hasSizeReference: boolean;

  /** Colours and markings, e.g. "negro, gris y blanco con mascara facial". */
  colorPattern: string | null;
  /** Texture, length, density, e.g. "doble capa, largo y denso". */
  coatType: string | null;
  distinguishingMarks: string | null;
  /** Posture and bearing. Never health — that is notes, and only notes. */
  generalObservations: string | null;

  /** Estimated weight RANGE in kg. Null unless the photo gave a scale. */
  weightKgMin: number | null;
  weightKgMax: number | null;
  weightConfidence: Confidence;

  nameSuggestions: string[];

  /** Anything the model wants to flag to a human, e.g. a visible injury. */
  notes: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Policy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How a suggestion may reach the form.
 *
 * `prefill` — the field is filled in, visibly marked as a suggestion, and the
 *   admin can accept or overwrite it.
 * `offer`   — shown as an option to click, never written automatically.
 * `display` — shown as context only; it has no form field to land in.
 *
 * NOTHING here writes to Firestore. Publishing is still the admin's explicit
 * act, and the review gate is not optional — plan §4.8.
 */
export type SuggestionUse = 'prefill' | 'offer' | 'display';

export const SUGGESTION_POLICY = {
  species: 'prefill',
  /** Offered, never prefilled — see the breed reasoning in the header. */
  breed: 'offer',
  age: 'prefill',
  /** Prefilled only when the photo actually contained a scale reference. */
  size: 'offer',
  names: 'offer',
  /**
   * Prefilled, unlike breed. Colour and coat are things anyone standing next
   * to the animal can check in a second, and a wrong one is embarrassing
   * rather than harmful — where a wrong breed attracts the wrong family.
   */
  colorPattern: 'prefill',
  coatType: 'prefill',
  /** Offered. It is a guess from a photograph, and it feeds rations. */
  weight: 'offer',
  observations: 'display',
  marks: 'display',
} as const satisfies Record<string, SuggestionUse>;

/**
 * A suggestion below this bar is not shown at all. A low-confidence guess
 * presented alongside a high-confidence one trains people to accept both.
 */
export const MIN_CONFIDENCE_TO_SHOW: Confidence = 'medium';

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export function meetsBar(c: Confidence, bar: Confidence = MIN_CONFIDENCE_TO_SHOW): boolean {
  return CONFIDENCE_RANK[c] >= CONFIDENCE_RANK[bar];
}

// ─────────────────────────────────────────────────────────────────────────────
// Breed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A breed decision, not a Spanish string. Rendering `mixed` needs the animal's
 * sex ("mestizo" / "mestiza") and Spanish lives only in `src/i18n`.
 */
export type BreedDecision =
  | {
      kind: 'mixed';
      /**
       * Breeds this animal RESEMBLES, most-alike first, possibly empty.
       * A resemblance, never a claim — the UI renders it as "mestizo con
       * rasgos de …", which is what a person recognises at a glance without
       * asserting a pedigree nobody can see in a photograph.
       */
      resembles: string[];
    }
  | { kind: 'purebred'; breed: string };

/** At most this many resemblances survive. More reads as a guess, not a likeness. */
export const MAX_RESEMBLES = 2;

/**
 * Normalise the model's breed resemblances: trim, drop blanks, fold duplicates
 * that differ only by case or accent, and cap the count.
 *
 * Deliberately does NOT validate against a breed list. There is no canonical
 * Spanish breed vocabulary for the mixes a Cochabamba street rescue produces,
 * and a whitelist would silently drop the honest answers it does not know.
 */
export function normalizeResembles(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const trimmed = item.trim().replace(/\s+/g, ' ');
    if (!trimmed) continue;
    const key = trimmed
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length === MAX_RESEMBLES) break;
  }
  return out;
}

/**
 * ⚠️ Returns `mixed` unless the model both claims purebred AND is confident.
 * The shelter can always type a breed; the point is that the DEFAULT is the
 * honest one for a street rescue rather than a confident guess.
 */
export function decideBreed(s: RawPhotoSuggestion): BreedDecision {
  const guess = s.purebredGuess?.trim();
  if (s.isLikelyPurebred && guess && meetsBar(s.speciesConfidence, 'high')) {
    return { kind: 'purebred', breed: guess };
  }
  // "mestizo" alone is true but useless to someone scrolling a wall of dogs.
  // What it resembles is the thing a person actually recognises, and it stays
  // a resemblance rather than a claim — see t.mixedBreed().
  return { kind: 'mixed', resembles: normalizeResembles(s.resemblesBreeds ?? []) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Age
// ─────────────────────────────────────────────────────────────────────────────

/** Nothing older than this is distinguishable from anything else older than this. */
export const MAX_PLAUSIBLE_AGE_MONTHS = 300; // 25 years

export interface AgeDecision {
  /** Midpoint, for the single `ageMonths` field the public page renders. */
  ageMonths: number | null;
  ageMonthsMin: number | null;
  ageMonthsMax: number | null;
  /** Always true when it came from a photo. There is no other honest value. */
  isEstimate: boolean;
  /** True when the range was too wide or too weak to be worth offering. */
  refused: boolean;
}

/**
 * Turn a claimed range into something storable, or refuse.
 *
 * Refuses — rather than narrowing — when the model is unsure. A wide range
 * shown honestly is useful ("entre 4 y 7 meses"); a midpoint extracted from a
 * wide range and displayed as "5 meses" is a guess wearing a fact's clothes.
 */
export function decideAge(s: RawPhotoSuggestion): AgeDecision {
  const refuse: AgeDecision = {
    ageMonths: null,
    ageMonthsMin: null,
    ageMonthsMax: null,
    isEstimate: true,
    refused: true,
  };

  let min = s.ageMonthsMin;
  let max = s.ageMonthsMax;
  if (min == null || max == null) return refuse;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return refuse;

  min = Math.round(min);
  max = Math.round(max);

  // A model that returns the bounds backwards is still telling us the interval.
  if (min > max) [min, max] = [max, min];

  if (min < 0) return refuse;
  if (max > MAX_PLAUSIBLE_AGE_MONTHS) return refuse;
  if (!meetsBar(s.ageConfidence)) return refuse;

  // Beyond roughly two years, tooth wear stops separating ages usefully. A
  // range wider than this carries no information a human could not supply by
  // looking, so offering it only lends false precision.
  const span = max - min;
  const tooWide = span > 24;
  if (tooWide) return refuse;

  return {
    ageMonths: Math.round((min + max) / 2),
    ageMonthsMin: min,
    ageMonthsMax: max,
    isEstimate: true,
    refused: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Size
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Size is only offered when the photo contained something to judge scale
 * against. Without a reference, a lone chihuahua and a lone mastiff frame
 * identically, and the model's confidence is not evidence about scale.
 */
export function decideSize(s: RawPhotoSuggestion): PetSize | null {
  if (!s.hasSizeReference) return null;
  if (!meetsBar(s.sizeConfidence)) return null;
  return s.size;
}

// ─────────────────────────────────────────────────────────────────────────────
// Weight
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A range wider than this is not worth showing: it spans so much of the dog
 * population that it cannot inform a pen or a ration, and a number on screen
 * always reads as more certain than it is.
 */
export const MAX_WEIGHT_RANGE_FACTOR = 3;

/** Nothing this project handles weighs less. Below it, the model has erred. */
export const MIN_PLAUSIBLE_WEIGHT_KG = 0.3;
/** A 100 kg dog is not impossible, but from a photograph it is a misread. */
export const MAX_PLAUSIBLE_WEIGHT_KG = 100;

export interface WeightDecision {
  weightKgMin: number | null;
  weightKgMax: number | null;
  /** Always true when it came from a photo. There is no other honest value. */
  isEstimate: boolean;
  /** True when there was no scale in frame, or the range was too wide. */
  refused: boolean;
}

const REFUSED_WEIGHT: WeightDecision = {
  weightKgMin: null,
  weightKgMax: null,
  isEstimate: true,
  refused: true,
};

/**
 * ⚠️ Refuses far more readily than it answers, and that is the design.
 *
 * The rescuer has no scale, so this is the only weight the record has until a
 * vet arrives — which makes it tempting to always produce one. Resist that. A
 * lone animal in a frame has no scale at all: the same photograph fits a 4 kg
 * dog and a 40 kg one, and the model cannot tell. So without a scale reference
 * this refuses outright rather than guessing.
 *
 * Whatever it returns is barred from dosing. isEstimate is always true and
 * travels with the value, so no caller can lose that fact.
 */
export function decideWeight(s: RawPhotoSuggestion): WeightDecision {
  if (!s.hasSizeReference) return REFUSED_WEIGHT;
  if (!meetsBar(s.weightConfidence)) return REFUSED_WEIGHT;

  const min = s.weightKgMin;
  const max = s.weightKgMax;
  if (min == null || max == null) return REFUSED_WEIGHT;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return REFUSED_WEIGHT;
  if (min <= 0 || max <= 0) return REFUSED_WEIGHT;
  if (min > max) return REFUSED_WEIGHT;
  if (min < MIN_PLAUSIBLE_WEIGHT_KG || max > MAX_PLAUSIBLE_WEIGHT_KG) {
    return REFUSED_WEIGHT;
  }
  // Ratio rather than difference: 2-6kg and 40-44kg are both 4kg wide, and
  // only the first is a useful answer.
  if (max / min > MAX_WEIGHT_RANGE_FACTOR) return REFUSED_WEIGHT;

  return { weightKgMin: min, weightKgMax: max, isEstimate: true, refused: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Names
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_NAME_SUGGESTIONS = 5;

/** Trim, drop blanks, de-duplicate case-insensitively, cap the count. */
export function cleanNameSuggestions(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase('es');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length === MAX_NAME_SUGGESTIONS) break;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The whole decision
// ─────────────────────────────────────────────────────────────────────────────

export interface ReviewedSuggestion {
  species: Species | null;
  breed: BreedDecision;
  age: AgeDecision;
  size: PetSize | null;
  names: string[];
  weight: WeightDecision;
  visibleType: string | null;
  colorPattern: string | null;
  coatType: string | null;
  distinguishingMarks: string | null;
  generalObservations: string | null;
  notes: string | null;
  /** Field keys that were dropped, so the UI can say WHY rather than go quiet. */
  withheld: string[];
}

/**
 * The single entry point. Everything the admin sees comes through here, so
 * there is one place to audit what a model is permitted to influence.
 */
export function reviewSuggestion(s: RawPhotoSuggestion): ReviewedSuggestion {
  const withheld: string[] = [];

  const species = meetsBar(s.speciesConfidence) ? s.species : null;
  if (species == null) withheld.push('species');

  const age = decideAge(s);
  if (age.refused) withheld.push('age');

  const size = decideSize(s);
  if (size == null) withheld.push('size');

  const weight = decideWeight(s);
  if (weight.refused) withheld.push('weight');

  return {
    species,
    breed: decideBreed(s),
    age,
    size,
    names: cleanNameSuggestions(s.nameSuggestions),
    weight,
    visibleType: s.visibleType?.trim() || null,
    colorPattern: s.colorPattern?.trim() || null,
    coatType: s.coatType?.trim() || null,
    distinguishingMarks: s.distinguishingMarks?.trim() || null,
    generalObservations: s.generalObservations?.trim() || null,
    notes: s.notes?.trim() || null,
    withheld,
  };
}

/**
 * Which `Pet` fields a model influenced, for provenance. Recorded so that a
 * later reader can tell "the vet said 18 months" from "a model read a wear
 * photo" — a distinction `Pet` could not previously express.
 */
export type SuggestedField =
  | 'species'
  | 'breed'
  | 'ageMonths'
  | 'size'
  | 'name'
  | 'colorPattern'
  | 'coatType'
  | 'weightKg';

export const SUGGESTIBLE_FIELDS: readonly SuggestedField[] = [
  'species',
  'breed',
  'ageMonths',
  'size',
  'name',
  'colorPattern',
  'coatType',
  'weightKg',
] as const;

/** Unused type-level guard: every PetSex is still handled by i18n, not here. */
export type _SexIsNeverSuggested = PetSex;
