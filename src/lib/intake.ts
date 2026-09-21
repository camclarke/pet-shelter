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
import type {
  AdultWeightBand,
  PetPhotoSlot,
  PetSex,
  PetSize,
  PetStatus,
  RegisterLinkConfidence,
  Species,
} from './types';

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
  /**
   * THREE-STATE, like the two fields under it. `null` is "nobody wrote it
   * down", which is not the same claim as `false`, "this animal is unaltered"
   * — see src/lib/sterilization.ts. The register importer used to write
   * `false` for both, so 15 of the 42 animals in the shelter carry a `false`
   * that the paper never said.
   */
  sterilized: boolean | null;
  /**
   * Beside `sterilized` on purpose, and NOT beside `size` on the identity
   * step. Among "Tamaño", "Peso aproximado" and "Raza" it would read as a
   * third description of the dog and get answered as one — grande → over,
   * pequeño → under — at which point it carries nothing `size` did not. Here
   * it reads as what it is: an input to the sterilization question.
   * Three-state; see `AdultWeightBand` in types.ts.
   */
  expectedAdultWeightBand: AdultWeightBand | null;
  goodWithChildren: boolean | null;
  goodWithOtherPets: boolean | null;

  /** Derived from `name`, editable, and checked for collisions before publish. */
  slug: string;

  /**
   * The row this animal occupies in the shelter's paper register, when the
   * draft was created from it — or null for an animal nobody has written down
   * yet, which is every ordinary intake.
   *
   * On the draft rather than fetched on demand for the same reason
   * `chipConflict` is: the wizard renders it beside the fields it explains
   * ("el registro dice hembra"), and provenance a reload can erase is not
   * provenance.
   */
  register: RegisterRef | null;
}

/**
 * What the register says about this animal, carried on the draft.
 *
 * Plain serialisable values only — no Timestamps — because `PetDraft` is
 * passed through pure functions that must not import Firestore, and
 * `loadDraft` strips the one Timestamp the document has.
 */
export interface RegisterRef {
  no: number;
  /** The name cell verbatim, so the wizard can show what the paper says. */
  nameRaw: string;
  /** `YYYY-MM-DD`, or null when the register recorded only a year. */
  intakeDay: string | null;
  /** The age as written: "DE 8 ANOS", "NACIDA 02/11/24". Never parsed into `ageYears`. */
  ageText: string | null;
  /**
   * The sex the register records, kept ALONGSIDE `draft.sex` rather than
   * replacing it. When a genital photograph disagrees, both are shown and a
   * person decides — a handwritten H/M is wrong often enough, and sex inflects
   * every Spanish sentence the site will write about this animal.
   */
  sexPerRegister: PetSex | null;
  sterilizedPerRegister: boolean;
  /** How many medical records the import wrote under this animal's id. */
  medicalCount: number;
  /** Which import created this draft. */
  batch: string;
  linkConfidence: RegisterLinkConfidence;
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
    // Unknown, not "no". A fresh draft has been told nothing about this animal.
    sterilized: null,
    // Unknown, not a guess — and never derived from `size` or the photo range.
    expectedAdultWeightBand: null,
    goodWithChildren: null,
    goodWithOtherPets: null,
    slug: '',
    // Null for an ordinary intake. The importer sets it, and the roster sets
    // it when a volunteer links a returning animal to its old register row.
    register: null,
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

// ─────────────────────────────────────────────────────────────────────────────
// What a photograph is allowed to overwrite
//
// Analysis used to be applied straight onto the draft: `patch.species =
// s.species` and four more like it, with nothing asking what the field already
// held. That was survivable while every draft started blank and was analysed
// once. It stops being survivable now, for two reasons that arrived together:
//
//   1. Analysis is an explicit button, so a second press is normal — and the
//      second reading would silently replace whatever the person had corrected
//      between the two.
//   2. A draft can now START with answers, from the paper register. An import
//      that a photograph overwrites is a transcription of the shelter's own
//      record being discarded by a guess about a photograph.
//
// The rule below is one sentence: a model may fill a field that is EMPTY, or
// re-fill one the model itself filled last. Everything a person or the register
// put there is protected, without anyone having to remember to protect it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which draft keys one suggestible field owns, and whether the draft holds an
 * answer for it yet.
 *
 * Keyed by the PROVENANCE name — the value that lands in
 * `draft.suggestedFields`, which is `SuggestedField` in `intake-suggestion.ts`
 * — because that is the name the guard has to compare against. Several of them
 * own more than one key: an age is five fields on the draft and one fact about
 * the animal, and prefilling half of it would leave bounds describing a
 * different estimate than the number beside them.
 *
 * ⚠️ `sterilized` is deliberately ABSENT, so it can never be prefilled — and
 * the reason changed on 2026-09-20. It used to say this was because the field
 * was a boolean defaulting to false, with no empty state to detect. PR #64 made
 * it `boolean | null` defaulting to null, so an empty state now exists and that
 * premise is false; this comment went stale in that PR and is corrected here.
 * The conclusion survives on different grounds: a photograph can show evidence
 * of "yes" (a spay scar) but its absence is not evidence of "no", so a model's
 * reading is only ever OFFERED and accepted by a person.
 *
 * `expectedAdultWeightBand` is absent for a stronger reason still: it is a
 * projection about an animal that does not weigh that yet, and the photo
 * estimate it would come from describes the animal today. `decideWeight`'s
 * guard is a ratio, so 8–10 kg on a four-month-old passes it cleanly and would
 * suggest "under 20 kg" for a dog heading to 35. Omission from this table IS
 * the enforcement — `shouldPrefill` returns false for any key not listed.
 */
const PREFILLABLE: Readonly<
  Record<string, { keys: readonly (keyof PetDraft)[]; isEmpty: (draft: PetDraft) => boolean }>
> = {
  species: { keys: ['species'], isEmpty: (d) => d.species === null },
  name: { keys: ['name'], isEmpty: (d) => d.name.trim().length === 0 },
  sex: { keys: ['sex'], isEmpty: (d) => d.sex === null },
  size: { keys: ['size'], isEmpty: (d) => d.size === null },
  breed: { keys: ['breed'], isEmpty: (d) => d.breed.trim().length === 0 },
  colorPattern: { keys: ['colorPattern'], isEmpty: (d) => d.colorPattern.trim().length === 0 },
  coatType: { keys: ['coatType'], isEmpty: (d) => d.coatType.trim().length === 0 },
  ageMonths: {
    keys: ['ageYears', 'ageMonthsPart', 'ageMonthsMin', 'ageMonthsMax', 'ageUnknown'],
    // `ageUnknown` is an ANSWER, not a blank. `PetDraft` says so explicitly:
    // "we don't know" and "we haven't filled this in yet" are different facts.
    // So a ticked "No sabemos la edad" is a decision a photograph may not
    // quietly reverse.
    isEmpty: (d) => !d.ageUnknown && d.ageYears === null && d.ageMonthsPart === null,
  },
  weightKg: {
    keys: ['weightKgMin', 'weightKgMax'],
    isEmpty: (d) => d.weightKgMin === null && d.weightKgMax === null,
  },
};

/**
 * Whether a model's reading may be written into this field.
 *
 * True when the field is empty, or when the only thing in it is what a model
 * put there — which is what makes re-analysing a photograph still work while a
 * typed or imported value survives it.
 *
 * ⚠️ An unknown field name returns FALSE. The failure direction matters: a name
 * this table does not recognise is a field whose empty state nobody has
 * defined, and guessing "probably empty" would mean the guard silently stops
 * guarding the day someone adds a prefillable field and forgets this list.
 */
export function shouldPrefill(field: string, draft: PetDraft): boolean {
  const spec = PREFILLABLE[field];
  if (!spec) return false;
  if (spec.isEmpty(draft)) return true;
  // Written by a model last time, so re-writing it loses nothing a person said.
  return draft.suggestedFields.includes(field);
}

/**
 * Apply a photo analysis to the draft, field by field, under `shouldPrefill`.
 *
 * `fields` names what each part of `patch` IS — the provenance names, not the
 * draft keys — and the table above decides which keys each of those names is
 * allowed to touch. So a patch carrying a key its field does not own writes
 * nothing: the guard cannot be walked around by widening the object literal at
 * the call site, which is exactly how this kind of rule normally erodes.
 *
 * Returns the SAME draft object when nothing survived the guard. The caller
 * compares by reference to decide whether to save, so a re-analysis that
 * confirms what is already there costs no Firestore write and shows no
 * "guardado" that would suggest something changed.
 */
export function applyPhotoPrefill(
  draft: PetDraft,
  patch: Partial<PetDraft>,
  fields: readonly string[],
  model: string | null,
): PetDraft {
  // `undefined` is not a value here — a key present but undefined would spread
  // over a real answer and erase it, which is the opposite of the point.
  const provided = new Set(
    Object.entries(patch)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key),
  );

  const applied: string[] = [];
  const allowed = new Set<string>();

  for (const field of fields) {
    const spec = PREFILLABLE[field];
    if (!spec) continue;
    if (!shouldPrefill(field, draft)) continue;
    const keys = spec.keys.filter((key) => provided.has(key));
    if (keys.length === 0) continue;
    for (const key of keys) allowed.add(key);
    applied.push(field);
  }

  if (applied.length === 0) return draft;

  const accepted = Object.fromEntries(
    Object.entries(patch).filter(([key, value]) => value !== undefined && allowed.has(key)),
  ) as Partial<PetDraft>;

  return {
    ...draft,
    ...accepted,
    suggestedFields: [...new Set([...draft.suggestedFields, ...applied])],
    // Keep the previous key rather than erasing provenance when the caller has
    // no model name to give.
    suggestedByModel: model ?? draft.suggestedByModel,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The register against the photograph
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two independent readings of this animal's sex, when they disagree.
 *
 * Null whenever there is nothing to compare: no register row, a register that
 * left the sex blank, or a photograph the model refused to read a sex from.
 * Non-null is therefore a real contradiction between two sources that were
 * produced without knowing about each other — a handwritten H/M in a paper
 * column, and a genital photograph — and it is worth a person's attention
 * precisely because neither is reliably right. Handwriting is misread; so is a
 * puppy.
 *
 * ⚠️ `suggestedSex` must be the DECIDED sex from `decideSex()`, never the
 * model's raw claim. A sex inferred from build rather than seen is not a second
 * reading, and pitting one against the register would manufacture a
 * disagreement out of a guess.
 *
 * ⚠️ Deliberately does NOT look at `draft.sex`, and therefore keeps reporting
 * the disagreement after someone resolves it. That is the intent: the two
 * sources still disagree, and the record should keep saying so. What the UI
 * stops offering is the switch, once the draft already holds what the
 * photograph read.
 */
export function sexConflict(
  draft: PetDraft,
  suggestedSex: PetSex | null,
): { register: PetSex; photo: PetSex } | null {
  const register = draft.register?.sexPerRegister ?? null;
  if (register === null || suggestedSex === null) return null;
  if (register === suggestedSex) return null;
  return { register, photo: suggestedSex };
}
