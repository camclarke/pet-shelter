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
  MedicalRecordKind,
  PetSex,
  PetSize,
  PetStatus,
  Species,
} from '@/lib/types';
import type { MicrochipError } from '@/lib/microchip';

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

  /** Past participle agreeing with sex: "identificado" / "identificada". */
  pastParticiple(stem: 'identific' | 'conoc' | 'perdid', sex: PetSex): string;

  /** "3 meses", "1 año", "edad desconocida". */
  formatAge(ageMonths: number | null): string;

  /** The uppercase data line under a name: "3 MESES · MACHO · MEDIANO". */
  formatMeta(pet: { ageMonths: number | null; sex: PetSex; size: PetSize }): string;

  /** Short label for the status chip on a poster. */
  statusLabel(status: PetStatus): string;

  medicalKindLabel(kind: MedicalRecordKind): string;

  /** Validation message for a rejected microchip code. */
  microchipError(error: MicrochipError): string;

  /** Pre-filled WhatsApp body for an adoption enquiry. */
  adoptionInquiry(petName: string): string;

  /** Pre-filled WhatsApp body announcing an inbound animal. */
  arrivalAnnouncement(input: {
    emoji: string;
    descriptors: string[];
    origin: string | null;
    recordUrl: string;
  }): string;
}
