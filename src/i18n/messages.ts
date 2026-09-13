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
import type { TagTone } from '@/lib/qr-tokens';

/**
 * Everything a QR tag says: the public page a finder lands on, and the admin
 * screens that issue, revoke and print tags. Build-order step 12, plan §7.
 *
 * ⚠️ The finder is a stranger with an animal in front of them. Every sentence
 * on the public side must lead to one action — writing to the shelter — and
 * must never promise to hand over a family's details: the shelter relays.
 */
export interface TagMessages {
  // ── the public page ───────────────────────────────────────────────────────
  /** The one question the page asks, verbatim from plan §7. */
  readonly foundQuestion: string;
  /** The WhatsApp button. */
  readonly writeToShelter: string;
  /** Tab title when the page does not name an animal. */
  readonly genericTitle: string;
  /** The loud first line for a lost animal. */
  lostBanner(name: string, sex: PetSex): string;
  /** One sentence under the name, by tone. Gender-agreeing. */
  situation(tone: TagTone, name: string, sex: PetSex, shelterName: string): string;
  /** Shown only when the pet document says it is chipped. */
  microchipHint(sex: PetSex): string;
  /**
   * The pre-filled WhatsApp body. Carries the PRINTED code, so the shelter can
   * look the tag up even if the name on the message is wrong or blank.
   */
  finderMessage(input: { name: string; sex: PetSex; formattedToken: string; tone: TagTone }): string;
  /** Secondary link to the dossier, for an animal in adoption only. */
  meetLink(name: string): string;
  /** "WhatsApp 77903553" — the number as a fallback for a phone that cannot follow a link. */
  phoneLine(display: string): string;
  /** "Placa ABCDE-FGHJK" */
  codeLine(formattedToken: string): string;
  /** Shown to a signed-in admin only. */
  readonly adminLink: string;

  readonly inactiveTitle: string;
  inactiveBody(shelterName: string): string;
  inactiveMessage(formattedToken: string, shelterName: string): string;
  readonly unknownTitle: string;
  unknownBody(shelterName: string): string;
  unknownMessage(shelterName: string): string;
  /** Generic, for a page that cannot name the animal or its sex. */
  readonly vetHint: string;

  // ── admin ─────────────────────────────────────────────────────────────────
  readonly panelTitle: string;
  readonly loading: string;
  readonly noneYet: string;
  activeSince(formattedToken: string, date: string): string;
  revokedOn(formattedToken: string, date: string): string;
  /** A second tag that still works. Should never happen; shown rather than hidden if it does. */
  alsoActive(formattedToken: string, date: string): string;
  readonly backToRecord: string;
  readonly backToPanel: string;
  readonly issue: string;
  readonly issuing: string;
  readonly reissue: string;
  readonly revoke: string;
  readonly print: string;
  readonly cancel: string;
  revokeConfirm(formattedToken: string): string;
  reissueConfirm(formattedToken: string): string;
  readonly confirmRevoke: string;
  readonly confirmReissue: string;
  /** Plan §7's honest limitation. Belongs wherever a tag is issued or printed. */
  readonly limitation: string;
  readonly issueFailed: string;
  readonly revokeFailed: string;
  readonly loadFailed: string;
  readonly permissionDenied: string;
  readonly printTip: string;
  readonly testTip: string;
  printSize(millimetres: number): string;
  qrAlt(name: string): string;
  readonly noActiveTag: string;
  printTitle(name: string): string;

  readonly sheetTitle: string;
  readonly sheetIntro: string;
  readonly sheetEmpty: string;
  readonly sheetLink: string;
  readonly noTag: string;
  readonly selectAll: string;
  readonly clearSelection: string;
  issueMissing(count: number): string;
  printSheet(count: number): string;
  readonly nothingToPrint: string;
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

  /** QR identity tags — the public page and the admin screens. */
  readonly tag: TagMessages;
}
