/**
 * Firestore data model.
 *
 * Security rules are DOCUMENT-level, not field-level. Every visibility tier is
 * therefore a separate document rather than a field on a shared one. This is the
 * single decision that satisfies both the login gating and the location privacy
 * requirements — see CLAUDE.md.
 */

import type { GeoPoint, Timestamp } from 'firebase/firestore';

/** Where the dog is in its journey. Values mirror the shelter's own vocabulary. */
export type DogStatus =
  | 'refugio' // at the shelter
  | 'transito' // in a foster home (hogar de tránsito)
  | 'adopcion' // available, actively seeking a family
  | 'adoptado' // placed
  | 'perdido'; // missing — activates the public sighting reporter

export type DogSex = 'macho' | 'hembra';
export type DogSize = 'pequeno' | 'mediano' | 'grande';

/** How precisely a location may be revealed. Never widen without owner consent. */
export type LocationPrecision = 'exact' | 'approx';

// ─────────────────────────────────────────────────────────────────────────────
// dogs/{dogId} — PUBLIC READ
// The teaser. Enough to find the dog in a search and enough to fall in love.
// Nothing here may identify where a dog physically is.
// ─────────────────────────────────────────────────────────────────────────────
export interface Dog {
  id: string;
  slug: string;

  /** The name the dog answers to now. */
  name: string;
  /**
   * Every previous name, oldest first. Rescued dogs are frequently renamed —
   * by the finder, by the shelter, then by the adopter. Keeping the chain
   * intact is how an owner searching for a lost dog recognises it later.
   */
  formerNames: string[];

  breed: string;
  /** Age in months. Usually an estimate — shelters rarely know a birthdate. */
  ageMonths: number | null;
  /** Set only when genuinely known, e.g. from a vaccination card. */
  birthdateApprox: Timestamp | null;

  sex: DogSex;
  size: DogSize;
  status: DogStatus;

  /** Single optimized cover image. The rest live in the gated detail document. */
  coverPhoto: string | null;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ─────────────────────────────────────────────────────────────────────────────
// dogs/{dogId}/detail/main — AUTHENTICATED READ
// ─────────────────────────────────────────────────────────────────────────────
export interface DogDetail {
  story: string;
  temperament: string[];
  healthNotes: string;
  photos: string[];

  /** What the shelter commits to, e.g. free castration at 6–7 months. */
  commitments: string[];
  microchip: string | null;

  /** Stage 2: extracted from a vaccination card scan by an LLM. */
  vaccinations: Vaccination[];
}

export interface Vaccination {
  name: string;
  date: Timestamp;
  veterinarian: string | null;
  batch: string | null;
  /**
   * Provenance. LLM-extracted entries stay flagged until a human confirms them —
   * a misread vaccination date is a health decision made on bad data.
   */
  source: 'manual' | 'llm-extracted';
  confirmedBy: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// dogs/{dogId}/location/current — RESTRICTED READ (admin, or the current owner)
//
// For a dog in `transito` this is a foster volunteer's home. For an `adoptado`
// dog it is the adopter's home. Exact coordinates never appear in any document
// a wider audience can read.
// ─────────────────────────────────────────────────────────────────────────────
export interface DogLocation {
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
// dogs/{dogId}/sightings/{sightingId} — PUBLIC READ, PUBLIC CREATE
//
// Deliberately writable without an account: someone who spots a lost dog in the
// street must be able to report it in seconds. A street sighting is a public
// event in a public place, so no privacy tier applies here.
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
// adoptions/{adoptionId} — RESTRICTED READ (admin, or the owner)
// Establishes who may read a dog's exact location.
// ─────────────────────────────────────────────────────────────────────────────
export interface Adoption {
  id: string;
  dogId: string;
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
