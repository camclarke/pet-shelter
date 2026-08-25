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

  /** "3 meses", "1 año", "edad desconocida". */
  formatAge(ageMonths: number | null): string;

  /** The uppercase data line under a name: "3 MESES · MACHO · MEDIANO". */
  formatMeta(pet: { ageMonths: number | null; sex: PetSex; size: PetSize }): string;

  /** Short label for the status chip on a poster. */
  statusLabel(status: PetStatus): string;

  medicalKindLabel(kind: MedicalRecordKind): string;

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
}
