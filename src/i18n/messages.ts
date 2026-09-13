/**
 * The contract every locale must satisfy.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 * Identifiers, routes, and stored Firestore values are English everywhere in
 * this codebase. Visitor-facing words are not — the audience is Cochabamba and
 * the site is Spanish, with more languages intended. This module is the seam
 * between those two facts: the ONLY place user-facing language lives.
 *
 * Adding a language is therefore adding one sibling file that satisfies this
 * interface. It never means touching a query, a status value, or a component.
 *
 * ── Why these are functions, not lookup tables ────────────────────────────
 * Spanish adjectives and nouns agree with grammatical gender: "pequeño" for a
 * male, "pequeña" for a female, "el gato" vs "la gata". English does not
 * inflect at all. A flat `Record<PetSize, string>` can express one of those
 * and not the other, so the shape has to be a function and the locale decides
 * what it does with the arguments. An English implementation simply ignores
 * `sex`; Spanish cannot.
 */

import type {
  AreaKind,
  MedicalRecordKind,
  MuscleCondition,
  PetSex,
  PetSize,
  PetStatus,
  PlacementReason,
  Species,
} from '@/lib/types';
import type { AreaError, PlacementWarning } from '@/lib/areas';
import type { Pathogen } from '@/lib/placements';
import type { MicrochipError } from '@/lib/microchip';
import type { AuthError } from '@/lib/auth';
import type { IntakeError } from '@/lib/intake';
import type { MedicalError, MedicalWarning } from '@/lib/medical';
import type { MeasurementError, MeasurementWarning } from '@/lib/measurements';
import type { FoodCategory, FoodHazard } from '@/lib/types';
import type { DonationError, DonationLineError, DonationLineWarning } from '@/lib/food-parse';
import type {
  CookBatchError,
  CookBatchWarning,
  StockMovementError,
  YieldEstimate,
} from '@/lib/food-stock';
import type { BodyConditionSuggestion, EnergyStage } from '@/lib/rations';
import type { FoodParseFailure } from '@/lib/food-parse-client';
import type { MeasuredRatio } from '@/lib/food-stock';
import type { PotShareRow, RationResult } from '@/lib/rations';
import type { StockEntryKind } from '@/lib/types';

/**
 * Fixed labels for the food screens, `/admin/food`.
 *
 * A table of plain strings rather than functions, because none of these
 * inflects: they label controls and sections, and never agree with an animal's
 * sex. Kept here rather than inline in JSX so the food screens add nothing to
 * the page-level-copy exception the project log records.
 */
export interface FoodCopy {
  readonly navLabel: string;
  readonly title: string;
  readonly sub: string;
  readonly backToPanel: string;
  readonly tabDonation: string;
  readonly tabStock: string;
  readonly tabCook: string;
  readonly tabRations: string;
  readonly loading: string;
  readonly loadFailed: string;
  readonly permissionDenied: string;
  readonly saveFailed: string;
  readonly cancel: string;
  readonly remove: string;
  readonly chooseCategory: string;

  readonly donationTextLabel: string;
  readonly donationTextHint: string;
  readonly parseButton: string;
  readonly parsing: string;
  readonly addLine: string;
  readonly receivedLabel: string;
  readonly donorLabel: string;
  readonly notesLabel: string;
  readonly lineFood: string;
  readonly lineCategory: string;
  readonly lineQuantity: string;
  readonly lineMassKg: string;
  readonly lineExpiry: string;
  readonly lineInStock: string;
  readonly fromText: string;
  readonly missingHazardsTitle: string;
  readonly reviewNote: string;
  readonly saveDonation: string;
  readonly savedDonation: string;
  readonly recentDonations: string;
  readonly noDonations: string;
  readonly parsedByModel: string;
  readonly typedByHand: string;

  readonly stockTitle: string;
  readonly stockHint: string;
  readonly stockEmpty: string;
  readonly stockNegative: string;
  readonly movementOpen: string;
  readonly movementKind: string;
  readonly directionLabel: string;
  readonly directionAdd: string;
  readonly directionRemove: string;
  readonly movementLabel: string;
  readonly movementKg: string;
  readonly movementDate: string;
  readonly movementNote: string;
  readonly saveMovement: string;

  readonly cookOpen: string;
  readonly cookHint: string;
  readonly cookedAtLabel: string;
  readonly inputsTitle: string;
  readonly inputLabel: string;
  readonly inputKg: string;
  readonly addInput: string;
  readonly toxicAck: string;
  readonly potFillLabel: string;
  readonly notLooked: string;
  readonly cookedKgLabel: string;
  readonly ladlesLabel: string;
  readonly dogsServedLabel: string;
  readonly cookedByLabel: string;
  readonly saveCook: string;
  readonly recentBatches: string;
  readonly noBatches: string;
  readonly editOutcome: string;
  readonly saveOutcome: string;
  readonly calibrationTitle: string;
  readonly yieldTitle: string;

  readonly rationsTitle: string;
  readonly rationsHint: string;
  readonly noAnimals: string;
  readonly ladlesToday: string;
  readonly adjustedReason: string;
  readonly dogsPresentLabel: string;
  readonly dogsPresentInvalid: string;
  readonly shortfallLabel: string;
  readonly saveDay: string;
  readonly savedDay: string;
  readonly sharesTitle: string;
  readonly sharesHint: string;
  readonly sharesNeedTwo: string;
  readonly notFromPot: string;
  readonly servingInvalid: string;
  readonly measurementsFailed: string;
}

export interface Messages {
  /** BCP 47 tag, e.g. "es-BO". */
  readonly locale: string;

  /** "macho" / "hembra". */
  sexLabel(sex: PetSex): string;

  /** Gender-agreeing size adjective: "pequeña", "mediano", "grande". */
  sizeLabel(size: PetSize, sex: PetSex): string;

  /** The gendered noun: perro/perra, gato/gata, conejo/coneja. */
  speciesNoun(species: Species, sex: PetSex): string;

  /** Plural for headings: "perritos", "gatitos". */
  speciesPlural(species: Species): string;

  /** Definite article, for sentences like "conoce a la gata". */
  article(sex: PetSex): string;

  /**
   * Past participle agreeing with sex: "identificado" / "identificada".
   *
   * The argument is the participle stem MINUS its final vowel, not the verb
   * root: "identificad", not "identific". Two of the three values here were
   * originally the verb root, which produced the non-words "identifica" and
   * "conoca" on a pet dossier -- live, and unseen for months only because no
   * pet document existed for the page to render. Getting the stem wrong is
   * not a type error, so the union is the only thing constraining it: add a
   * value only after checking both forms are real Spanish words.
   */
  pastParticiple(stem: 'identificad' | 'conocid' | 'perdid', sex: PetSex): string;

  /**
   * "mestizo" / "mestiza" — the honest breed for most street rescues.
   *
   * Takes `sex` and NOT an optional sex, deliberately — and the reason
   * OUTLIVED the fact it was first written from. It used to say a vision
   * model is never asked for sex; since 2026-08-30 it is, from a genital
   * photograph. What has not changed is that this word must agree with the
   * sex an admin has CONFIRMED on the draft, never with a suggestion nobody
   * has accepted, because the breed string reaches a public listing. Making
   * it required turns that into a compile error rather than a "mestizo/a"
   * fudge going out to adopters.
   */
  mixedBreed(sex: PetSex): string;

  /**
   * "mestiza con rasgos de pastor alemán y husky siberiano".
   *
   * A resemblance, never a claim. Falls back to plain `mixedBreed(sex)` when
   * the list is empty, because "mestizo" on its own is still the honest
   * answer — it is just a less useful one to someone scrolling a wall of
   * dogs, which is what the traits fix.
   */
  mixedBreedWithTraits(sex: PetSex, traits: readonly string[]): string;

  /**
   * Why the Raza field is still empty, and — the part that matters — WHAT is
   * waiting behind the sex tap.
   *
   * ⚠️ It must NAME the resemblances, and that is a fix for a real reported
   * problem rather than a nicety. The wizard cannot spell "mestizo" against
   * "mestiza" until a human confirms the sex, so the breed offer is gated;
   * the note that explained the gate said only "pick sex first" and never
   * said what would appear. So on 2026-09-12 the owner read the one breed
   * mentioned in the model's PROSE field (`visibleType`) and reported the
   * model had missed the second breed — while `resemblesBreeds` held both,
   * normalised and in state, invisible. Measured that day: the eval scored
   * 12/12 with both breeds named, so nothing was wrong with the reading. The
   * only thing wrong was that nobody could see it.
   *
   * Takes the traits ALREADY normalised by `normalizeResembles` (trimmed,
   * de-duplicated, capped), so this only formats.
   */
  breedNeedsSexFirst(traits: readonly string[]): string;

  /** "3 meses", "1 año", "edad desconocida". */
  formatAge(ageMonths: number | null): string;

  /**
   * "entre 4 y 7 meses", "entre 8 meses y 1 año".
   *
   * For an ESTIMATED age, where presenting the midpoint alone would state
   * a guess as a fact.
   */
  formatAgeRange(minMonths: number, maxMonths: number): string;

  /** The uppercase data line under a name: "3 MESES · MACHO · MEDIANO". */
  formatMeta(pet: { ageMonths: number | null; sex: PetSex; size: PetSize }): string;

  /**
   * The breed, trimmed to what fits on an adoption-wall card.
   *
   * ⚠️ Deliberately NOT folded into `formatMeta`. Three of its five call
   * sites already render `breed` themselves — `{pet.breed} · {t.formatMeta(pet)}`
   * in the admin dashboard, the re-admission card and the chip-match card — so
   * adding it there would print the breed twice on each of them.
   *
   * Returns `null` when there is nothing worth a line, so the caller omits the
   * element rather than rendering an empty one.
   *
   * On truncation: cuts on a WORD boundary and appends an ellipsis, never
   * mid-word. "MESTIZA CON RASGOS DE HUSKY SIBE…" reads as a rendering bug;
   * "MESTIZA CON RASGOS DE HUSKY…" reads as a list that continues. The budget
   * is measured, not guessed — see the implementation.
   */
  formatBreedLine(breed: string): string | null;

  /** Short label for the status chip on a poster. */
  statusLabel(status: PetStatus): string;

  medicalKindLabel(kind: MedicalRecordKind): string;

  /** Why a medical record cannot be saved. Structural problems only. */
  medicalError(error: MedicalError): string;

  /**
   * A clinical note worth showing that must NOT block saving.
   *
   * Phrased as information rather than as a refusal: the shelter is often
   * recording a campaign dose it did not administer and cannot change.
   */
  medicalWarning(warning: MedicalWarning): string;

  /** Why a weight or body-condition reading cannot be saved. Structural only. */
  measurementError(error: MeasurementError): string;

  /**
   * A reason to look twice at a weight that must NOT block saving. The person
   * with the animal on the scale is the one who knows whether it is real.
   */
  measurementWarning(warning: MeasurementWarning): string;

  /** A WSAVA body-condition score with its band: "5 · Ideal". */
  bodyConditionLabel(score: number): string;

  muscleConditionLabel(condition: MuscleCondition): string;

  /** A weight for READING, with its unit: "12,5 kg". */
  formatKg(kg: number): string;

  /** An estimated range for reading: "18–26 kg". */
  formatKgRange(minKg: number, maxKg: number): string;

  /**
   * A weight as an INPUT's value: "12,5", no unit and no grouping, so that
   * `parseWeightInput` reads back exactly the number it was given.
   */
  formatKgInput(kg: number): string;

  /** Validation message for a rejected microchip code. */
  microchipError(error: MicrochipError): string;

  /**
   * Why an intake draft cannot advance a step or be published.
   *
   * Read by the admin console, which is staff-facing rather than
   * visitor-facing — but it is still Spanish, and it still belongs here. The
   * rule is not "translate what the public sees", it is "no user-facing words
   * outside src/i18n", and the shelter's volunteers are users.
   */
  intakeError(error: IntakeError): string;

  /**
   * Why a sign-in, sign-up, or password reset was refused.
   *
   * ⚠️ `invalid-credentials` must not name which half was wrong. Identity
   * Platform's email enumeration protection deliberately hides whether the
   * address has an account at all, so "contraseña incorrecta" would be a
   * guess presented as a fact — and "no existe esa cuenta" would leak the
   * very thing the protection exists to hide.
   */
  authError(error: AuthError): string;

  /** Pre-filled WhatsApp body for an adoption enquiry. */
  adoptionInquiry(petName: string): string;

  /** Pre-filled WhatsApp body announcing an inbound animal. */
  arrivalAnnouncement(input: {
    emoji: string;
    descriptors: string[];
    origin: string | null;
    recordUrl: string;
  }): string;

  // ── areas and placements ──────────────────────────────────────────────────

  /** "Cuarentena", "Aislamiento" — the shelter's own words for a kind of pen. */
  areaKindLabel(kind: AreaKind): string;

  /** One line explaining what a kind of area is FOR, shown beside the picker. */
  areaKindHint(kind: AreaKind): string;

  /** Why an area cannot be saved. */
  areaError(error: AreaError): string;

  /** Why an animal was moved: "Ingreso", "Alta veterinaria", "Traslado". */
  placementReasonLabel(reason: PlacementReason): string;

  /**
   * What the manager should know before recording a move.
   *
   * ⚠️ Every one of these is a WARNING and none of them blocks. Plan section 3
   * is explicit that a gate stricter than the shelter's reality gets worked
   * around — so the wording must inform a decision, never scold someone for a
   * decision they have already had to make with an animal in their arms.
   */
  placementWarning(warning: PlacementWarning): string;

  /** "moquillo", "parvovirus" — the disease being traced. */
  pathogenLabel(pathogen: Pathogen): string;

  /** "3 de 6" when the capacity is known, "3 animalitos" when it is not. */
  occupancyLabel(count: number, capacity: number | null): string;

  /** "hoy", "ayer", "hace 12 días". */
  daysAgoLabel(days: number): string;

  /** How long two animals shared a pen: "12 días juntos", "menos de un día". */
  contactDurationLabel(ms: number): string;

  // ── food: donations, stock, the pot, rations — step 13 ────────────────────

  foodCategoryLabel(category: FoodCategory): string;

  /** "Cebolla, ajo o puerro". */
  foodHazardLabel(hazard: FoodHazard): string;

  /**
   * One sentence on WHY, for the person holding the bag.
   *
   * ⚠️ Informs, never instructs what to feed. Plan §12.4: the system flags for
   * the shelter's own judgement and gives no nutritional advice.
   */
  foodHazardAdvice(hazard: FoodHazard): string;

  /** A mass for reading: "15 kg", "500 g", "−2,3 kg". */
  formatGrams(grams: number): string;

  donationError(error: DonationError): string;
  donationLineError(error: DonationLineError): string;
  donationLineWarning(warning: DonationLineWarning): string;

  stockMovementError(error: StockMovementError): string;

  cookBatchError(error: CookBatchError): string;
  cookBatchWarning(warning: CookBatchWarning): string;

  /**
   * Why there is, or is not, a ladle estimate.
   *
   * ⚠️ `no-kitchen-constants` is what every screen shows today, and it must say
   * WHY rather than show nothing: an unexplained absence reads as a bug.
   */
  yieldEstimateText(estimate: YieldEstimate): string;

  /** "perro adulto", "cachorro de menos de 4 meses". */
  energyStageLabel(stage: EnergyStage): string;

  /** A suggestion, worded as one. Never an instruction and never automatic. */
  bodyConditionSuggestionText(suggestion: BodyConditionSuggestion): string;

  foodParseFailure(failure: FoodParseFailure): string;

  readonly food: FoodCopy;

  stockEntryKindLabel(kind: StockEntryKind): string;

  /** "1.059 kcal". Rounded: a kilocalorie decimal is false precision here. */
  formatKcal(kcal: number): string;

  /** "75 %", for how full the pot was. */
  potFillLabel(level: number): string;

  /**
   * One animal's line on the ration sheet.
   *
   * ⚠️ `no-weight` must NEVER print a number of kilocalories, even when the
   * intake photos estimated a weight. It names the estimate and says it is not
   * used — see the decision on `rationFor`.
   */
  rationSummary(result: RationResult): string;

  /** "Según el estándar le toca 21 % de la olla; con lo anotado recibe 40 %." */
  potShareText(row: PotShareRow): string;

  /** A measured ratio from cook batches, always with its n. */
  measuredRatioText(measure: 'cooked-to-raw' | 'grams-per-ladle', ratio: MeasuredRatio | null): string;
}
