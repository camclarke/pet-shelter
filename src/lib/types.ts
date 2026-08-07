/**
 * Firestore data model.
 *
 * Security rules are DOCUMENT-level, not field-level. Every visibility tier is
 * therefore a separate document rather than a field on a shared one. This is
 * the single decision that satisfies the login gating, the location privacy
 * requirement, and now the microchip-confidentiality requirement — see
 * CLAUDE.md.
 */

import type { GeoPoint, Timestamp } from 'firebase/firestore';
import type { MicrochipStandard } from './microchip';

/**
 * What kind of animal. Kept open-ended: shelters take in whatever arrives,
 * and a rescue that starts with dogs will eventually be handed a rabbit.
 */
export type Species = 'perro' | 'gato' | 'conejo' | 'otro';

/** Where the pet is in its journey. Values mirror shelters' own vocabulary. */
export type PetStatus =
  | 'refugio' // at the shelter
  | 'transito' // in a foster home (hogar de tránsito)
  | 'adopcion' // available, actively seeking a family
  | 'adoptado' // placed
  | 'perdido'; // missing — activates the public sighting reporter

export type PetSex = 'macho' | 'hembra';
export type PetSize = 'pequeno' | 'mediano' | 'grande';

/** How precisely a location may be revealed. Never widen without owner consent. */
export type LocationPrecision = 'exact' | 'approx';

// ─────────────────────────────────────────────────────────────────────────────
// pets/{petId} — PUBLIC READ
//
// The teaser. Enough to find the pet in a search and enough to fall in love.
// Nothing here may identify where a pet physically is, and — deliberately —
// no microchip number. See `PetIdentity` for why.
// ─────────────────────────────────────────────────────────────────────────────
export interface Pet {
  id: string;
  slug: string;

  species: Species;

  /** The name the pet answers to now. */
  name: string;
  /**
   * Every previous name, oldest first. Rescued animals are frequently renamed —
   * by the finder, by the shelter, then by the adopter. Keeping the chain
   * intact is how an owner searching for a lost pet recognises it later, and
   * how a scan result reconciles against an old shelter record.
   */
  formerNames: string[];

  /** Breed, or the shelter's honest best guess. Most street rescues are mixes. */
  breed: string;
  /** Age in months. Usually an estimate — shelters rarely know a birthdate. */
  ageMonths: number | null;
  /** Set only when genuinely known, e.g. from a vaccination card. */
  birthdateApprox: Timestamp | null;

  sex: PetSex;
  size: PetSize;
  status: PetStatus;

  /**
   * Whether this pet is chipped, WITHOUT exposing the number. A finder needs
   * to know it is worth taking the animal somewhere with a scanner; nobody
   * needs the number itself to decide that.
   */
  hasMicrochip: boolean;

  /** Single optimized cover image. The rest live in the gated detail document. */
  coverPhoto: string | null;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ─────────────────────────────────────────────────────────────────────────────
// pets/{petId}/detail/main — AUTHENTICATED READ
// ─────────────────────────────────────────────────────────────────────────────
export interface PetDetail {
  story: string;
  temperament: string[];
  healthNotes: string;
  photos: string[];

  /** What the shelter commits to, e.g. free castration at 6–7 months. */
  commitments: string[];

  sterilized: boolean;
  goodWithChildren: boolean | null;
  goodWithOtherPets: boolean | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// pets/{petId}/identity/microchip — RESTRICTED READ (admin | current owner)
//
// The microchip number is identifying data, and it is the credential by which
// ownership is asserted. Published openly it lets anyone claim a pet is theirs,
// or cross-reference the same animal across registries. It is NOT on the
// public document, and it is NOT in the authenticated tier either — creating
// an account is not a reason to learn every chipped animal's number.
// ─────────────────────────────────────────────────────────────────────────────
export interface PetIdentity {
  /**
   * The code, ALWAYS a string. Leading zeros are significant: ISO 3166 numeric
   * country codes below 100 genuinely begin with one, and Bolivia's is 068.
   * Stored as a number, every such chip is silently corrupted.
   */
  code: string;
  standard: MicrochipStandard;

  /** Derived at write time from the code, for search and display. */
  prefix: string;
  nationalId: string;

  implantedAt: Timestamp | null;
  /** Vet or organisation that implanted it. */
  implantedBy: string | null;
  /** Conventionally between the shoulder blades; recorded because chips migrate. */
  implantSite: string | null;

  /**
   * Whether this pet's chip is registered with an external national or
   * commercial registry, and which. A chip that is implanted but unregistered
   * reunites nobody — the number resolves to no contact details anywhere.
   */
  externalRegistry: string | null;
  externalRegistryId: string | null;

  updatedAt: Timestamp;
  updatedBy: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// pets/{petId}/location/current — RESTRICTED READ (admin | current owner)
//
// For a pet in `transito` this is a foster volunteer's home. For an `adoptado`
// pet it is the adopter's home. Exact coordinates never appear in any document
// a wider audience can read.
// ─────────────────────────────────────────────────────────────────────────────
export interface PetLocation {
  geo: GeoPoint;
  precision: LocationPrecision;
  /** Free-text address. Never leaves this document. */
  address: string | null;
  /** Public-facing meeting point — a plaza, the shelter, a vet. Safe to show. */
  publicMeetingPoint: GeoPoint | null;
  updatedAt: Timestamp;
  updatedBy: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// pets/{petId}/scans/{scanId} — RESTRICTED READ (admin | current owner)
//
// The last-known-location ledger.
//
// Read this carefully, because the feature is easy to oversell: a microchip is
// a passive transponder with no battery and no GPS, readable over a few
// centimetres. It cannot be followed. What this collection records is where a
// SCANNER was when it read the chip — a vet visit, an intake, a shelter
// transfer, a stranger who found the animal and took it somewhere with a
// reader.
//
// So this answers "where was this pet last seen, and by whom" — a recovery
// tool. It does not answer "where is this pet now", and nothing implanted
// under an animal's skin can.
//
// It is restricted rather than public because a trail of scan locations for an
// adopted pet is, in practice, a trail of its owner's movements and home.
// ─────────────────────────────────────────────────────────────────────────────
export type ScanContext =
  | 'intake' // arrived at a shelter
  | 'veterinary' // routine vet visit
  | 'transfer' // moved between shelters or fosters
  | 'adoption' // handed to an adopter
  | 'found' // scanned after being found astray
  | 'routine'; // periodic welfare check

export interface ScanEvent {
  id: string;

  /** Location OF THE READER at scan time — not of the pet thereafter. */
  geo: GeoPoint | null;
  /** Coarse by default, for the same reason PetLocation is. */
  precision: LocationPrecision;

  /** Who performed the scan: a shelter, a clinic, a municipal pound. */
  scannedByOrg: string;
  /** Signed-in user who recorded it, when there was one. */
  scannedByUid: string | null;

  context: ScanContext;
  note: string | null;

  /**
   * Which chip was actually read. Kept per-scan rather than assumed, because a
   * pet can be scanned and found to carry a DIFFERENT chip than the record
   * expects — a second chip implanted elsewhere, or a mis-linked record. That
   * discrepancy is a real and useful signal, and it is lost if this is
   * inferred instead of recorded.
   */
  codeRead: string;

  scannedAt: Timestamp;
}

// ─────────────────────────────────────────────────────────────────────────────
// pets/{petId}/custody/{custodyId} — RESTRICTED READ (admin | current owner)
//
// The chain of responsibility: who held this animal, and when. Separate from
// scans because custody is a legal/administrative fact that persists, while a
// scan is a momentary observation.
// ─────────────────────────────────────────────────────────────────────────────
export type CustodyKind = 'shelter' | 'foster' | 'adopter' | 'veterinary' | 'transferred-out';

export interface CustodyEvent {
  id: string;
  kind: CustodyKind;
  /** Organisation or person now responsible. */
  holder: string;
  /** Set when the holder is a user of this system. */
  holderUid: string | null;
  startedAt: Timestamp;
  endedAt: Timestamp | null;
  note: string | null;
  recordedBy: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// pets/{petId}/medical/{recordId} — AUTHENTICATED READ, admin write
//
// Gated rather than public: an animal's health history is not something a
// casual browser needs, and publishing "FIV positive" or "reactive to men"
// openly harms the animal's chances more than it helps.
// ─────────────────────────────────────────────────────────────────────────────
export type MedicalRecordKind =
  | 'vacuna'
  | 'desparasitacion'
  | 'cirugia'
  | 'consulta'
  | 'tratamiento'
  | 'esterilizacion';

export interface MedicalRecord {
  id: string;
  kind: MedicalRecordKind;
  /** e.g. "Rabia", "Quintuple", "Ivermectina". */
  name: string;
  performedAt: Timestamp;
  /** When the next dose or check is due, where applicable. */
  nextDueAt: Timestamp | null;
  veterinarian: string | null;
  clinic: string | null;
  batch: string | null;
  notes: string | null;

  /**
   * Provenance. Stage 2 parses vaccination cards with an LLM; entries it
   * produces stay flagged until a human confirms them. A misread vaccination
   * date is a health decision made on bad data, and rabies timing in
   * particular has legal consequences under EU 576/2013.
   */
  source: 'manual' | 'llm-extracted';
  confirmedBy: string | null;
  /** Scan of the physical card this was extracted from, if any. */
  sourceDocument: string | null;

  recordedBy: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// pets/{petId}/care/feeding — AUTHENTICATED READ, admin write
//
// Travels with the animal. An adopter who knows the exact portion and food the
// pet was already on avoids the digestive upset that a sudden diet change
// causes, which is a common and avoidable reason for a return.
// ─────────────────────────────────────────────────────────────────────────────
export type FeedingUnit = 'gramos' | 'tazas' | 'latas' | 'ml';

export interface FeedingPlan {
  /** Amount per serving. */
  portion: number;
  unit: FeedingUnit;
  /** Servings per day. */
  timesPerDay: number;
  /** Brand or description, e.g. "Dog Chow cachorro". */
  food: string;
  foodKind: 'seco' | 'humedo' | 'mixto' | 'casero';

  /** Allergies, intolerances, medically-ordered diets. */
  restrictions: string[];
  notes: string | null;

  updatedAt: Timestamp;
  updatedBy: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// pets/{petId}/sightings/{sightingId} — PUBLIC READ, PUBLIC CREATE
//
// Deliberately writable without an account: someone who spots a lost pet in
// the street must be able to report it in seconds. A street sighting is a
// public event in a public place, so no privacy tier applies here — unlike
// the scan ledger above, which is about places the pet belongs.
// ─────────────────────────────────────────────────────────────────────────────
export interface Sighting {
  id: string;
  geo: GeoPoint;
  note: string;
  photoUrl: string | null;
  /** Optional — a phone number the shelter can call back. */
  contact: string | null;
  reportedAt: Timestamp;
  /** Always forced to 'pending' on create; only an admin may promote it. */
  status: 'pending' | 'confirmed' | 'rejected';
  reviewedBy: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// users/{uid} — SELF READ
//
// Note the absence of a `role` field. Admin status is a custom auth claim
// (request.auth.token.admin). A claim is already inside the token and costs
// nothing to check; a Firestore field would cost a document read on every
// single rule evaluation.
// ─────────────────────────────────────────────────────────────────────────────
export interface AppUser {
  uid: string;
  email: string;
  displayName: string | null;
  photoURL: string | null;
  createdAt: Timestamp;
}

// ─────────────────────────────────────────────────────────────────────────────
// adoptions/{petId} — RESTRICTED READ (admin | the owner)
// Keyed by petId so ownership resolves in a single get() inside rules.
// ─────────────────────────────────────────────────────────────────────────────
export interface Adoption {
  id: string;
  petId: string;
  ownerUid: string;
  adoptedAt: Timestamp;
  approvedBy: string;
}

/** Geographic bounds for the Cochabamba region, enforced in security rules. */
export const COCHABAMBA_BOUNDS = {
  minLat: -17.75,
  maxLat: -17.15,
  minLng: -66.45,
  maxLng: -65.85,
} as const;
