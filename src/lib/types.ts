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
export type Species = 'dog' | 'cat' | 'rabbit' | 'other';

/**
 * Where the pet is in its journey.
 *
 * These are STORED VALUES as well as code identifiers — they are written into
 * Firestore — so they are English like every other identifier in this
 * codebase. The shelter's own Spanish vocabulary is not lost: it lives in
 * `src/i18n/`, which maps each value to the word the staff actually say
 * ("refugio", "hogar de tránsito"). One value, many languages.
 *
 * ⚠️ `foster` means "in a foster home (hogar de tránsito)" — a HOME, not a
 * journey. The en-route state is therefore `inbound`. The two are opposites
 * (a fostered animal has a home, an incoming one has nowhere yet), and the
 * Spanish words for them are near-identical, which is exactly why the stored
 * value must not be Spanish.
 *
 * Adding values here is safe by construction: getWall() filters
 * `status == 'available'`, an allowlist rather than a denylist, so a new value
 * is excluded from the public wall automatically and no query needs changing.
 */
export type PetStatus =
  | 'inbound' // announced by the manager, not yet physically here
  | 'quarantine' // arrived, in a quarantine area, not yet cleared by a vet
  | 'shelter' // at the shelter, in general population
  | 'foster' // in a foster home (hogar de tránsito)
  | 'available' // available, actively seeking a family
  | 'adopted' // placed
  | 'lost' // missing — activates the public sighting reporter
  | 'cancelled'; // announced but never arrived — the rescue fell through

export type PetSex = 'male' | 'female';
export type PetSize = 'small' | 'medium' | 'large';

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
  /**
   * Age in months — the single value the public page renders ("18 meses").
   * Usually an estimate; shelters rarely know a birthdate.
   *
   * ⚠️ When `ageIsEstimate` is true this is the MIDPOINT of
   * `ageMonthsMin`..`ageMonthsMax`, not a known age. Render it through the
   * i18n age helper rather than directly, so an estimate never appears as a
   * fact on a listing a stranger is deciding from.
   */
  ageMonths: number | null;

  /**
   * The bounds the estimate came from. Both null when the age is simply
   * known, or simply unknown.
   *
   * These exist because tooth-based ageing is genuinely tight for puppies
   * (deciduous eruption follows a schedule) and genuinely loose for adults
   * (wear varies with diet and chewing — a street dog is not a house dog).
   * Collapsing both cases to one integer throws away the difference between
   * "about 5 months" and "somewhere between 2 and 6 years".
   */
  ageMonthsMin: number | null;
  ageMonthsMax: number | null;

  /**
   * Whether `ageMonths` is an estimate rather than a known age. Defaults to
   * true for anything a shelter guessed, which is nearly everything.
   */
  ageIsEstimate: boolean;

  /** Set only when genuinely known, e.g. from a vaccination card. */
  birthdateApprox: Timestamp | null;

  sex: PetSex;
  size: PetSize;

  /**
   * What it LOOKS like. Both public, both nullable, and separate on purpose:
   * colour is what someone types when searching for a lost dog, coat is what
   * tells an adopter how much grooming they are taking on. Free text rather
   * than an enum — no closed vocabulary survives the mixes a street rescue
   * produces.
   */
  colorPattern: string | null;
  coatType: string | null;

  /**
   * An ESTIMATED weight range in kg. Both null until someone weighs the animal.
   *
   * The rescuer has no scale and the vet arrives hours or days later, so this
   * is what a pen assignment and a rough ration get chosen from in the
   * meantime. `weightIsEstimate` travels with it so a guess can never be read
   * back as a measurement, and it must NEVER reach an mg/kg dose. A real
   * weight belongs in a measurement recorded by whoever weighed it.
   */
  weightKgMin: number | null;
  weightKgMax: number | null;
  weightIsEstimate: boolean;

  status: PetStatus;

  /**
   * Whether this pet is chipped, WITHOUT exposing the number. A finder needs
   * to know it is worth taking the animal somewhere with a scanner; nobody
   * needs the number itself to decide that.
   */
  hasMicrochip: boolean;

  /** Single optimized cover image. The rest live in the gated detail document. */
  coverPhoto: string | null;

  /**
   * Which of this document’s fields a vision model influenced, by field
   * name — e.g. `["species", "ageMonths"]`. Empty for a pet typed in by
   * hand, which is the default and should stay the common case.
   *
   * ⚠️ A value here does NOT mean the field was written unreviewed. Nothing
   * a model produces is stored without an admin accepting it — plan §4.8,
   * the review gate is not optional. This records INFLUENCE, so that a
   * later reader can tell "the vet said 18 months" from "a model read a
   * wear photo", and so a bad model generation is scopeable after the fact.
   * Without it that distinction is unrecoverable once the form is saved.
   */
  suggestedFields: string[];

  /**
   * WHICH model suggested, as a stable KEY — never the raw model id. Same
   * reasoning as `MedicalRecord.extractedByModel`: ids churn every few
   * months and an id written into a database can never be renamed, so an
   * accuracy problem traced to one model generation would be unscopeable.
   * e.g. "flash". Null when nothing was suggested.
   */
  extractedByModel: string | null;
  extractedAt: Timestamp | null;

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
  /**
   * @deprecated Superseded by the `media` subcollection below, which carries
   * video as well and does not rewrite the whole document on every upload.
   * Nothing reads this field today; it stays only so an existing document that
   * carries it still type-checks during the migration.
   */
  photos: string[];

  /** What the shelter commits to, e.g. free castration at 6–7 months. */
  commitments: string[];

  sterilized: boolean;
  goodWithChildren: boolean | null;
  goodWithOtherPets: boolean | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// pets/{petId}/media/{mediaId} — PUBLIC or AUTHENTICATED READ, admin write
//
// ⚠️ THE ONE DELIBERATE EXCEPTION to "a tier is a document, never a field."
//
// Media is many-per-pet and unbounded. An array inside a document means every
// upload rewrites the entire document, and a pet with 40 photos plus video
// derivatives approaches Firestore's 1 MiB ceiling. So `tier` is a field here,
// and the rule enforces it through the QUERY instead:
//
//     allow read: if resource.data.tier == 'public' || signedIn();
//
// The sharp edge that follows, which whoever writes the client must know:
// on a QUERY, Firestore evaluates rules against the query's CONSTRAINTS, not
// against the results. An unauthenticated client must issue
// `where('tier', '==', 'public')` or the entire query is rejected — Firestore
// does not silently return a filtered subset. The first time this happens it
// looks like a broken query, not a permission decision.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Which guided intake shot a photo is.
 *
 * The slot is not decoration: it is sent to the model as a label so it
 * knows which image answers which question, and the prompt then binds each
 * inference to one slot — age comes from TEETH and sex from GENITALS and
 * from nowhere else. A Lite-tier model reading a whole photo set
 * unlabelled called a white facial mask "muzzle greying" and aged a young
 * adult at 6-8 years; being told where the dentition is removes that
 * inference entirely.
 *
 * `other` covers extra photos beyond the guided set, which stay welcome.
 */
export type PetPhotoSlot = 'front' | 'side' | 'teeth' | 'genitals' | 'other';

/**
 * ⚠️ The genital shot is NEVER public. It exists to read sex and, secondarily,
 * whether the animal is already sterilised — neither of which belongs on an
 * adoption listing. Anything in this set is forced to the `auth` tier at
 * publish time regardless of its order.
 */
export const NEVER_PUBLIC_SLOTS: readonly PetPhotoSlot[] = ['teeth', 'genitals'];

/**
 * Which tier a photo publishes at.
 *
 * Pure and exported so it can be TESTED. It used to be an inline ternary in
 * the publish batch, and a deliberate-break probe on 2026-08-30 found that
 * emptying NEVER_PUBLIC_SLOTS broke nothing — meaning the rule that keeps a
 * genital photograph off a public adoption listing had no coverage at all.
 *
 * The slot decides, not the position. Slots are filled in whatever order the
 * animal tolerates being handled, so a teeth or genital shot can legitimately
 * be first — and being first must never make it public.
 */
export function mediaTierFor(slot: PetPhotoSlot, index: number): MediaTier {
  if (NEVER_PUBLIC_SLOTS.includes(slot)) return 'auth';
  return index === 0 ? 'public' : 'auth';
}

/**
 * Where a photo is STORED, decided by the same slot that decides its tier.
 *
 * `mediaTierFor()` governed what the app RENDERED and nothing else: every slot
 * was written to `pets/{petId}/{id}.jpg`, which `storage.rules` serves with
 * `allow read: if true`. So a genital photograph carrying the promise "esta
 * foto nunca se publica" was fetchable by URL by anyone — measured on
 * 2026-09-03 against a real object: 200 with a download token AND 200 without.
 *
 * The never-public slots now live under a `private/` prefix the rules gate on
 * auth. The one-segment wildcard in `match /pets/{petId}/{fileName}` cannot
 * match a two-segment tail, so the public rule does not reach them and the
 * private rule is the only thing that grants access.
 *
 * ⚠️ The path is derived from the SLOT, never from the index. A slot's tier is
 * a fixed property knowable at upload time; its index is a UI ordering decided
 * at publish. Deriving the path from the index would mean moving objects when
 * someone reorders photos, and a move that half-fails leaves an intimate photo
 * sitting at a public path.
 */
export function storagePathFor(
  petId: string,
  mediaId: string,
  slot: PetPhotoSlot,
): string {
  return NEVER_PUBLIC_SLOTS.includes(slot)
    ? `pets/${petId}/private/${mediaId}.jpg`
    : `pets/${petId}/${mediaId}.jpg`;
}

/**
 * The photo that may appear on the public wall, or null if there is not one.
 *
 * ⚠️ NOT `media[0]`, which is what this used to be. Media is stored in CAPTURE
 * order, and the guided flow explicitly tolerates an intimate shot being taken
 * first — mediaTierFor's own comment says so. So an animal photographed
 * genitals-first published that photograph as `coverPhoto` on `pets/{petId}`,
 * which is the PUBLIC document and is exactly what the adoption wall renders.
 * The media subcollection got the slot right and the cover field did not.
 *
 * Also skips an empty url: a never-public photo now carries none by design, so
 * `media[0]?.url ?? null` would yield the empty string rather than null —
 * `??` does not catch `''`.
 */
export function coverPhotoFrom(
  media: readonly { slot: PetPhotoSlot; url: string }[],
): string | null {
  const publishable = media.find(
    (m) => !NEVER_PUBLIC_SLOTS.includes(m.slot) && m.url !== '',
  );
  return publishable?.url ?? null;
}

/** True when a path is one the rules refuse to serve unauthenticated. */
export function isPrivatePhotoPath(path: string): boolean {
  const segments = path.split('/');
  return segments.length === 4 && segments[0] === 'pets' && segments[2] === 'private';
}

export type MediaKind = 'photo' | 'video';
export type MediaTier = 'public' | 'auth';

export interface PetMedia {
  id: string;
  kind: MediaKind;
  tier: MediaTier;
  /** Which guided shot this is. `other` for anything outside the set. */
  slot: PetPhotoSlot;

  /** Storage path, NOT a URL. URLs are derived at read time so they can expire. */
  path: string;
  /** Generated derivatives: thumb, card, full. Video also gets a poster frame. */
  derivatives: Record<string, string>;

  width: number | null;
  height: number | null;
  /** Video only. */
  durationSeconds: number | null;

  /**
   * Spanish alt text. Required for photos — accessibility first, and it is
   * also what a caption generator would read rather than re-deriving from the
   * image.
   */
  alt: string | null;
  /** Ordering on the pet's dossier. The cover is order 0 with tier 'public'. */
  order: number;

  uploadedAt: Timestamp;
  uploadedBy: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// pets/{petId}/measurements/{measurementId} — AUTHENTICATED READ, admin write
//
// The model had NO weight until this was added, and two subsystems require
// one: drug dosing is mg/kg, and energy requirement is a function of kg^0.75.
// `Pet.size` is pequeno|mediano|grande — a wall filter, not a clinical
// quantity, and neither figure can be computed from a bucket.
//
// A subcollection rather than two fields on `Pet` because "reduce the fat
// ones, increase the thin ones" is a FEEDBACK LOOP, and a loop needs a trend.
// One BCS reading says a dog is thin; a sequence says whether the extra ladle
// is working.
// ─────────────────────────────────────────────────────────────────────────────

/** WSAVA Muscle Condition Score — a separate axis from fat, not a synonym. */
export type MuscleCondition = 'normal' | 'mild' | 'moderate' | 'marked';

export interface PetMeasurement {
  id: string;
  weightKg: number | null;

  /**
   * WSAVA 9-point Body Condition Score: 1 emaciated, 4–5 ideal for dogs,
   * 9 grossly obese. A real, calibrated, repeatable scale published in Spanish
   * — which is why this is not a free-text `gordo | flaco` flag.
   */
  bcs: number | null;
  mcs: MuscleCondition | null;

  measuredAt: Timestamp;
  measuredBy: string;
  note: string | null;
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
  | 'vaccination'
  | 'deworming'
  | 'surgery'
  | 'consultation'
  | 'treatment'
  | 'sterilization'
  /**
   * Antibody titre testing. Its own kind rather than a `consultation` with a
   * note: it is §VI of the EU pet passport and is WSAVA-endorsed, and it
   * answers a different question from a vaccination (is this animal protected
   * NOW).
   */
  | 'serology';

export interface MedicalRecord {
  id: string;
  kind: MedicalRecordKind;
  /** e.g. "Rabia", "Quintuple", "Ivermectina". */
  name: string;
  performedAt: Timestamp;
  /** When the next dose or check is due, where applicable. */
  nextDueAt: Timestamp | null;

  /**
   * When protection BEGINS. For rabies this is 21 days after the primary
   * protocol completes, NOT the injection date — and it is the date with legal
   * force at a border. Distinct from `performedAt` on purpose.
   */
  validFrom: Timestamp | null;

  /**
   * When protection LAPSES — WSAVA's "duration of immunity". Distinct from
   * `nextDueAt`, which is when to come back. Core vaccine immunity commonly
   * OUTLASTS the booster interval, and conflating the two is how an animal
   * gets revaccinated needlessly, or travels on cover that has quietly expired.
   */
  validUntil: Timestamp | null;

  /**
   * ⚠️ `veterinarian` and `batch` are nullable and a null must NOT be treated
   * as an incomplete record. Bolivia's free national rabies campaign produces
   * exactly this shape: a real, valid vaccination with no named vet and no lot
   * number. Cochabamba receives the largest departmental allocation in the
   * country, so here this is the common case, not an edge case.
   */
  veterinarian: string | null;
  clinic: string | null;
  batch: string | null;
  /** Vaccine manufacturer as PRINTED on the card. Null for campaign doses. */
  manufacturer: string | null;
  notes: string | null;

  /**
   * Reserved socket for a future VeNom / SNOMED VetSCT mapping. Empty for now,
   * deliberately: neither terminology survives contact with a volunteer
   * transcribing a handwritten card, and free text is backfillable later.
   */
  codes: string[];

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

  /**
   * WHICH model produced this, as a stable KEY — never the raw model id.
   * Model ids churn every few months and an id written into a database can
   * never be renamed, so an accuracy problem traced to one model generation
   * would be unscopeable: you could not find the records it wrote.
   * e.g. "gemini-3-flash".
   */
  extractedByModel: string | null;
  extractedAt: Timestamp | null;

  recordedBy: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// pets/{petId}/care/feeding — AUTHENTICATED READ, admin write
//
// Travels with the animal. An adopter who knows the exact portion and food the
// pet was already on avoids the digestive upset that a sudden diet change
// causes, which is a common and avoidable reason for a return.
// ─────────────────────────────────────────────────────────────────────────────
export type FeedingUnit = 'grams' | 'cups' | 'cans' | 'ml';

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

// ─────────────────────────────────────────────────────────────────────────────
// areas/{areaId} — ADMIN read and write
//
// Physical places inside the shelter's own facility.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ `cuarentena` and `aislamiento` are DIFFERENT and must never be merged.
 * The ASV Guidelines for Standards of Care in Animal Shelters draw the line:
 * quarantine holds HEALTHY newly-admitted or exposed animals under
 * observation; isolation holds animals showing or suspected of infectious
 * disease. Putting a sick animal into a quarantine pen exposes every healthy
 * animal already in it — and if the model conflates the two, the UI cannot
 * warn anyone that it is about to happen.
 */
export type AreaKind =
  | 'quarantine' // healthy, newly admitted or exposed — under observation
  | 'isolation' // sick or suspected — infectious
  | 'general' // general population
  | 'medical' // recovering from surgery or under treatment
  | 'maternity'; // pregnant or nursing

export interface Area {
  id: string;
  /** As the shelter says it: "Cuarentena 2", "Patio A", or just "3". */
  name: string;
  kind: AreaKind;

  /**
   * Nullable, but worth filling in: the ASV guidelines are explicit that
   * crowding is ITSELF a disease risk — higher contact rate, worse air
   * quality, more stress. An occupancy figure the manager sees before saying
   * yes to another dog is the cheapest possible intervention.
   */
  capacity: number | null;
  active: boolean;
  notes: string | null;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ─────────────────────────────────────────────────────────────────────────────
// pets/{petId}/placements/{placementId} — AUTHENTICATED READ, admin write
//
// An INTERVAL LEDGER, and that is the whole design.
//
// A `currentArea` field on Pet would not satisfy the requirement. The reason
// for tracking area at all is "if a virus breaks out, isolate the area" — and
// that question is always asked RETROSPECTIVELY. An animal diagnosed today was
// infectious before it looked sick. What is needed is not where it is, but
// everywhere it HAS been, and who was there at the same time.
//
// Deliberately NOT denormalised onto `Pet`: that document is public-read, and
// where an animal is housed is operational data with no reason to be
// world-readable. The collection-group query is admin-side and costs nothing
// at forty animals.
//
// A foster home is NOT an area. Placements describe positions inside the
// shelter's own facility; an animal in `hogar de tránsito` has custody and
// possibly a location, and no open placement. Keeping that boundary clean is
// what stops a volunteer's home address from ever reaching an area list.
// ─────────────────────────────────────────────────────────────────────────────
export type PlacementReason =
  | 'intake' // first placement on arrival
  | 'quarantine-cleared' // cleared by a vet, moving to general population
  | 'transfer' // ordinary move
  | 'medical' // moved for treatment or recovery
  | 'outbreak' // moved because of an outbreak
  | 'exit'; // left the facility — adopted, fostered, transferred out

export interface Placement {
  id: string;
  areaId: string;
  /**
   * The area's name AT THE TIME, snapshotted. Areas get renamed, and history
   * must not silently shift underneath an outbreak investigation.
   */
  areaName: string;

  startedAt: Timestamp;
  /** null means "still here". This is what makes current occupancy queryable. */
  endedAt: Timestamp | null;

  reason: PlacementReason;
  /**
   * A real user. "Nobody remembers who moved it" is how an outbreak
   * investigation stalls.
   */
  movedBy: string;
  note: string | null;
}

/** Geographic bounds for the Cochabamba region, enforced in security rules. */
export const COCHABAMBA_BOUNDS = {
  minLat: -17.75,
  maxLat: -17.15,
  minLng: -66.45,
  maxLng: -65.85,
} as const;
