/**
 * Intake wizard logic — pure functions, no Firestore import.
 *
 * Deliberately separated from `pets-admin.ts` for the same reason
 * `placements.ts` is separate from `placements-server.ts`: everything here is
 * decidable from its arguments, so it is testable without a database, a
 * network, or an admin credential. The moment slug derivation or a publish
 * gate needs a live Firestore to exercise, it stops getting exercised.
 *
 * ⚠️ No user-facing words in this file. Validation failures are returned as an
 * `IntakeError` union and the locale decides the wording — the same split
 * `MicrochipError`/`microchipError()` and `AuthError`/`authError()` already
 * use. A Spanish string here would be a Spanish string outside `src/i18n`.
 */

import { normalizeMicrochipCode, type MicrochipStandard } from './microchip';
import type { PetPhotoSlot, PetSex, PetSize, PetStatus, Species } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// The draft
//
// One flat object, held in React state and mirrored to `petDrafts/{id}`. Flat
// rather than pre-split into the tiers it will eventually become, because the
// wizard edits fields and the split is a publish-time concern — see
// `draftToDocuments`. Splitting early would mean every keystroke reasoning
// about which document it lands in.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A photo already uploaded to Storage during the wizard.
 *
 * `path` and `url` are both kept. The path is what `PetMedia` stores (URLs are
 * derived at read time so they can expire); the URL is what the wizard's own
 * preview and the derived `coverPhoto` need, and re-deriving it on every
 * render would be a network call per thumbnail.
 */
export interface DraftMedia {
  id: string;
  /** Which guided shot this is — sent to the model as a label. */
  slot: PetPhotoSlot;
  path: string;
  url: string;
  /** Spanish alt text. Required before publish — see `IntakeError.alt-required`. */
  alt: string;
  width: number | null;
  height: number | null;
}

export interface PetDraft {
  /**
   * Minted client-side and reused verbatim as the petId on publish, which is
   * what lets step 2 upload straight to `pets/{petId}/…` before the pet
   * exists. Storage rules gate that path on the admin claim, not on the
   * document existing, so there is nothing to move or rewrite afterwards.
   */
  id: string;

  // ── step 1: identity ──────────────────────────────────────────────────────
  species: Species | null;
  name: string;
  breed: string;
  sex: PetSex | null;
  size: PetSize | null;

  /** Colours and markings. Free text — see Pet.colorPattern. */
  colorPattern: string;
  /** Texture, length, density of the coat. */
  coatType: string;

  /**
   * Estimated weight range in kg, from a photo that contained something
   * giving scale. Both null is the normal state: the rescuer has no
   * balance and the vet has not arrived yet.
   */
  weightKgMin: number | null;
  weightKgMax: number | null;

  ageYears: number | null;
  ageMonthsPart: number | null;
  /**
   * Explicit rather than inferred from a null age. "We don't know" and "we
   * haven't filled this in yet" are different facts, and a wizard that cannot
   * tell them apart either nags about a field that is genuinely unknowable or
   * publishes a blank one as though it were an answer.
   */
  ageUnknown: boolean;

  /**
   * Bounds behind an estimated age, when a photo suggestion produced one
   * and the admin accepted it. Both null for a hand-typed age.
   */
  ageMonthsMin: number | null;
  ageMonthsMax: number | null;

  /**
   * Which fields a vision model influenced, and which model.
   *
   * On the DRAFT rather than in component state for the same reason
   * `chipConflict` is: the draft is persisted, so provenance survives a
   * reload. Provenance that a refresh can erase is not provenance.
   */
  suggestedFields: string[];
  suggestedByModel: string | null;

  status: PetStatus;
  hasMicrochip: boolean;
  microchipCode: string;
  microchipStandard: MicrochipStandard;

  /**
   * Set when a chip lookup resolved to an existing pet and the admin answered
   * "es otro animal" — plan section 3.1's mis-read / mis-linked branch.
   *
   * Recorded on the draft rather than held in component state for two reasons.
   * The draft is persisted, so the flag survives a reload and cannot be cleared
   * by walking away and coming back; and `validateStep` is pure over the draft,
   * so the publish gate below can see it without the validator learning how to
   * query Firestore.
   *
   * ⚠️ It stores the CODE as well as the pet, and both matter. The conflict is
   * about one specific number: re-scanning and getting a different one — which
   * is what a transposed digit looks like once corrected — must clear the gate
   * rather than leave the intake permanently blocked.
   */
  chipConflict: { petId: string; code: string } | null;

  // ── step 2: media ─────────────────────────────────────────────────────────
  media: DraftMedia[];

  // ── step 3: story ─────────────────────────────────────────────────────────
  story: string;
  temperament: string[];
  healthNotes: string;
  commitments: string[];
  sterilized: boolean;
  goodWithChildren: boolean | null;
  goodWithOtherPets: boolean | null;

  /** Derived from `name`, editable, and checked for collisions before publish. */
  slug: string;
}

export type IntakeStep = 'identity' | 'media' | 'story';

/**
 * Why a draft cannot advance or publish.
 *
 * Microchip problems are NOT in this union — they come back from
 * `validateMicrochip()` as a `MicrochipError` and are rendered through
 * `t.microchipError()`. Two validators, two vocabularies, one place each.
 */
export type IntakeError =
  | 'name-required'
  | 'species-required'
  | 'sex-required'
  | 'size-required'
  | 'breed-required'
  | 'age-required'
  | 'age-range'
  | 'slug-invalid'
  // NOTE: there is deliberately no 'slug-taken'. A collision is not an error
  // the admin has to resolve — `resolveSlug()` appends a suffix and the
  // success screen shows the final URL, so the shelter is told what happened
  // rather than being blocked on it. Two animals called Luna is normal.
  | 'microchip-required'
  // The chip entered already belongs to a DIFFERENT animal, per the admin's own
  // answer. Blocking is the point: publishing anyway would write one credential
  // onto two records, and `findPetByMicrochip()` would then resolve the chip to
  // whichever the query happened to return first. A duplicate is recoverable;
  // an ambiguous identity registry is what the whole lookup exists to prevent.
  | 'microchip-conflict'
  | 'photo-required'
  | 'alt-required';

/** Age beyond this is a typo, not a very old dog. 40 years in months. */
export const MAX_AGE_MONTHS = 480;

export function draftDefaults(id: string): PetDraft {
  return {
    id,
    species: null,
    name: '',
    breed: '',
    sex: null,
    size: null,
    colorPattern: '',
    coatType: '',
    weightKgMin: null,
    weightKgMax: null,
    ageYears: null,
    ageMonthsPart: null,
    ageUnknown: false,
    ageMonthsMin: null,
    ageMonthsMax: null,
    // Empty by default: a hand-typed pet has no model provenance, and
    // that should stay the common case.
    suggestedFields: [],
    suggestedByModel: null,
    // An animal being entered is at the shelter unless someone says otherwise.
    // NOT 'available': publishing to the wall is a decision, and defaulting to
    // it would make the safe path the one that requires extra clicks.
    status: 'shelter',
    hasMicrochip: false,
    microchipCode: '',
    microchipStandard: 'iso-fdx-b',
    chipConflict: null,
    media: [],
    story: '',
    temperament: [],
    healthNotes: '',
    commitments: [],
    sterilized: false,
    goodWithChildren: null,
    goodWithOtherPets: null,
    slug: '',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Age
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Combine the two age inputs into the single `ageMonths` the model stores.
 *
 * The UI asks for years and months separately because that is how the shelter
 * says it — "dos años y medio", "tres meses" — while `Pet.ageMonths` is one
 * number so that sorting and the "menor de un año" filter stay arithmetic.
 * Returns null when the age is unknown, which is a legitimate stored value.
 */
export function toAgeMonths(
  years: number | null,
  months: number | null,
  unknown: boolean,
): number | null {
  if (unknown) return null;
  if (years === null && months === null) return null;
  return (years ?? 0) * 12 + (months ?? 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Slug
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive a URL slug from a pet's name.
 *
 * Spanish names carry accents and ñ, and both must survive into something
 * URL-safe without becoming unrecognisable: "Ñoño" has to reach `nono`, not
 * `n-o` or an empty string. NFD decomposition splits a letter from its
 * diacritic so the marks can be dropped while the base letter stays — which
 * handles á/é/í/ó/ú/ü and ñ in one pass rather than a hand-written table that
 * will be missing a character the day someone is called Chloë.
 *
 * The result must satisfy the same kebab-case shape `scripts/seed-pet.mjs`
 * enforces, so a pet published through the wizard and one published through
 * the script are indistinguishable afterwards.
 */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    // Strip the combining marks NFD just exposed. Written as an escape range,
    // never as literal combining characters: those are invisible in an editor
    // and a stray one pasted into this line would be undebuggable.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const SLUG_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_SHAPE.test(slug);
}

/**
 * Append a numeric suffix until the slug is free.
 *
 * Shelters take in more than one Luna. A collision is the normal case over a
 * few years, not an edge case — and the alternative to disambiguating is a
 * second pet silently overwriting the first one's public URL, which breaks
 * every link already shared about the first animal.
 */
export function disambiguateSlug(base: string, taken: readonly string[]): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;

  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  // Unreachable in practice; a timestamp beats throwing and losing the intake.
  return `${base}-${Date.now()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether a recorded chip conflict still describes what is currently typed.
 *
 * The stored conflict is about one specific number, so this compares against
 * the NORMALISED code rather than the raw field — otherwise re-typing the same
 * digits with different spacing would read as a fresh, unconflicted code and
 * quietly reopen the hole the gate exists to close. Normalisation comes from
 * `microchip.ts` rather than a second regex here, so there is one answer to
 * "are these the same chip" in the codebase and not two that can drift.
 *
 * Unchecking "tiene microchip" clears the gate, and correctly so: an animal
 * recorded as unchipped writes no `identity` document, so there is no
 * credential left to collide with.
 */
export function chipConflictApplies(draft: PetDraft): boolean {
  if (!draft.hasMicrochip || draft.chipConflict === null) return false;
  return normalizeMicrochipCode(draft.microchipCode) === draft.chipConflict.code;
}

/**
 * What is missing from one step.
 *
 * Note what is NOT checked here: the microchip code's own validity. That is
 * `validateMicrochip()`'s job, it already has 10 tests, and duplicating its
 * rules here would create a second answer to the same question. This function
 * only asserts that a code was entered at all when `hasMicrochip` is set.
 */
export function validateStep(step: IntakeStep, draft: PetDraft): IntakeError[] {
  const errors: IntakeError[] = [];

  if (step === 'identity') {
    if (draft.name.trim().length === 0) errors.push('name-required');
    if (draft.species === null) errors.push('species-required');
    if (draft.sex === null) errors.push('sex-required');
    if (draft.size === null) errors.push('size-required');
    // "mestizo" is an honest and extremely common answer, so this asks for a
    // best guess rather than a pedigree — but a blank breed on a poster reads
    // as an unfinished record.
    if (draft.breed.trim().length === 0) errors.push('breed-required');

    if (!draft.ageUnknown && draft.ageYears === null && draft.ageMonthsPart === null) {
      errors.push('age-required');
    } else {
      const months = toAgeMonths(draft.ageYears, draft.ageMonthsPart, draft.ageUnknown);
      if (months !== null && (months < 0 || months > MAX_AGE_MONTHS)) errors.push('age-range');
    }

    if (!isValidSlug(draft.slug)) errors.push('slug-invalid');
    if (draft.hasMicrochip && draft.microchipCode.trim().length === 0) {
      errors.push('microchip-required');
    }
    if (chipConflictApplies(draft)) errors.push('microchip-conflict');
  }

  if (step === 'media') {
    // A poster with no photograph converts nobody, and the whole primary
    // objective is a stranger going from scrolling to messaging about a
    // specific animal. One photo is the floor.
    if (draft.media.length === 0) errors.push('photo-required');
    // Accessibility first — and the alt text is also what a future caption
    // generator reads instead of re-deriving meaning from the pixels.
    if (draft.media.some((m) => m.alt.trim().length === 0)) errors.push('alt-required');
  }

  // `story` is deliberately unvalidated. Plan §3: a rescue arriving at 22:00
  // needs to be on the wall, not blocked on a temperament checklist.

  return errors;
}

/**
 * Everything standing between this draft and the public wall.
 *
 * Steps 1 and 2 only, on purpose — publishing with no story is a supported
 * path, and the admin dashboard shows what is incomplete rather than refusing.
 */
export function publishBlockers(draft: PetDraft): IntakeError[] {
  return [...validateStep('identity', draft), ...validateStep('media', draft)];
}

export function canPublish(draft: PetDraft): boolean {
  return publishBlockers(draft).length === 0;
}

/**
 * How complete a draft is, for the dashboard's progress hint.
 *
 * Counts the two blocking steps plus the optional story, so a fully-published
 * animal with no story reads as 2/3 rather than as finished — the shelter
 * should be able to see at a glance which records are thin.
 */
export function draftProgress(draft: PetDraft): { done: number; total: number } {
  const done = [
    validateStep('identity', draft).length === 0,
    validateStep('media', draft).length === 0,
    draft.story.trim().length > 0,
  ].filter(Boolean).length;
  return { done, total: 3 };
}
