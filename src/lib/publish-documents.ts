/**
 * The documents a draft becomes when it is published — pure, no Firebase import.
 *
 * Two callers, one shape:
 *
 *   - `publishDraft()` in `pets-admin.ts`, the wizard's Publicar button, which
 *     runs in the browser under `firestore.rules` with the Web SDK;
 *   - `scripts/publish-ready-drafts.mjs`, the one-off bulk publish of the
 *     animals that already have a name and a photo, which runs under the
 *     Admin SDK.
 *
 * Before 2026-10-18 the split lived inline in `publishDraft`, and a script
 * that copied it would have been a second answer to "what does a published
 * pet look like" — free to drift the first time someone added a field. Here
 * the shape is decided once, and each caller only supplies the two things that
 * genuinely differ between the SDKs: the server-timestamp sentinel and how to
 * commit.
 *
 * ⚠️ Deliberately free of `firebase/*` imports, and that is load-bearing for
 * the script: under `node --import tsx` a `.mjs` can end up holding TWO
 * instances of a module that imports the Firebase SDK (measured 2026-09-13
 * through `server-time.ts`), and a sentinel minted by one instance is an
 * opaque object to the other. The sentinel is passed IN, so whichever SDK
 * commits the batch is the one that minted it.
 *
 * ⚠️ No user-facing words here either. The default alt text comes in as a
 * function from the locale.
 */

import { validateMicrochip } from './microchip';
import { toAgeMonths, type PetDraft } from './intake';
import { coverPhotoFrom, mediaTierFor } from './types';
import type { MicrochipStandard } from './microchip';
import type { MediaKind, MediaTier, Pet, PetPhotoSlot, PetStatus, Species } from './types';

/**
 * The exact shape written to `pets/{petId}`, generic over the timestamp
 * sentinel so the Web SDK and the Admin SDK can both satisfy it.
 *
 * WARNING: this type is the ONLY thing tying `Pet` to the code that writes
 * it. Before it existed the write was an untyped object literal, so a field
 * added to `Pet` produced a green typecheck and a document without it.
 */
export type PetDocumentWrite<TS> = Omit<Pet, 'id' | 'createdAt' | 'updatedAt' | 'extractedAt'> & {
  createdAt: TS;
  updatedAt: TS;
  /** A sentinel on the way in, a Timestamp on the way out. */
  extractedAt: TS | null;
};

export interface DetailDocumentWrite {
  sterilized: boolean | null;
}

export interface MediaDocumentWrite<TS> {
  kind: MediaKind;
  tier: MediaTier;
  slot: PetPhotoSlot;
  path: string;
  derivatives: Record<string, string>;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  alt: string;
  order: number;
  uploadedAt: TS;
  uploadedBy: string;
}

export interface IdentityDocumentWrite<TS> {
  code: string;
  standard: MicrochipStandard;
  prefix: string;
  nationalId: string;
  implantedAt: null;
  implantedBy: null;
  implantSite: null;
  externalRegistry: null;
  externalRegistryId: null;
  updatedAt: TS;
  updatedBy: string;
}

export interface PublishDocumentsInput<TS> {
  draft: PetDraft;
  /** Already collision-free — see `resolveSlug()` / `publishSlugBase()`. Never empty. */
  slug: string;
  /** The wizard passes `draft.status`; the bulk script passes `'available'`. */
  status: PetStatus;
  /**
   * Used ONLY when the draft has no species. The bulk script passes the paper
   * register's row, which is the shelter's own official record; the wizard
   * passes nothing, so a person's blank stays blank.
   */
  speciesFallback?: Species | null;
  /** Who is publishing: the admin's uid, or the script's named operator. */
  uid: string;
  /** The server-timestamp sentinel of whichever SDK will commit the batch. */
  now: TS;
  /** Alt text for a photo nobody described, from the NAME only: `t.defaultPhotoAlt`. */
  defaultAlt: (name: string) => string;
}

export interface PublishDocuments<TS> {
  petId: string;
  pet: PetDocumentWrite<TS>;
  detail: DetailDocumentWrite;
  media: { id: string; data: MediaDocumentWrite<TS> }[];
  /** Null when the animal has no chip, or the stored code does not validate. */
  identity: IdentityDocumentWrite<TS> | null;
  /**
   * True when `hasMicrochip` is set and a code exists but does not validate,
   * so no identity document is written. The caller must say so out loud.
   */
  invalidChip: boolean;
}

/**
 * Split a draft into the tiers it publishes to:
 *
 *   pets/{id}                    public      name, photo, status. Indexable.
 *   pets/{id}/detail/main        signed in   the story and health notes
 *   pets/{id}/media/{mediaId}    public|auth every photo
 *   pets/{id}/identity/microchip restricted  the chip NUMBER
 *
 * `hasMicrochip` goes on the PUBLIC document as a boolean and the code only
 * into `identity` — a finder needs to know the animal is worth taking to a
 * scanner; nobody needs the number to decide that.
 *
 * The pet id IS the draft id, so `pets/{id}/medical` (which the register
 * import already wrote) and `registerEntries/{no}.petId` stay valid.
 */
export function buildPublishDocuments<TS>(input: PublishDocumentsInput<TS>): PublishDocuments<TS> {
  const { draft, slug, status, uid, now, defaultAlt } = input;
  if (slug.trim() === '') {
    // An empty slug is a prefix that matches every slug in `takenSlugs`, and a
    // public URL of `/adopt/`. Refuse rather than write either.
    throw new Error('buildPublishDocuments: slug must not be empty');
  }

  const name = draft.name.trim();
  const ageMonths = toAgeMonths(draft.ageYears, draft.ageMonthsPart, draft.ageUnknown);

  const pet: PetDocumentWrite<TS> = {
    slug,
    // Null is a legitimate published value since 2026-10-18: every public
    // renderer omits an unknown species rather than guessing one.
    species: draft.species ?? input.speciesFallback ?? null,
    name,
    // Empty on a first intake. It fills in when an animal is renamed later —
    // and the dossier reads `.length` unguarded, so it must be an array now.
    formerNames: [],
    breed: draft.breed.trim(),
    ageMonths,
    ageMonthsMin: draft.ageMonthsMin,
    ageMonthsMax: draft.ageMonthsMax,
    // A shelter almost never knows a birthdate, so any age it holds is an
    // estimate. Presenting "18 meses" as though it were measured is exactly
    // what this flag exists to prevent.
    ageIsEstimate: ageMonths !== null,
    birthdateApprox: null,
    sex: draft.sex ?? null,
    size: draft.size ?? null,
    expectedAdultWeightBand: draft.expectedAdultWeightBand ?? null,
    colorPattern: draft.colorPattern.trim() || null,
    coatType: draft.coatType.trim() || null,
    weightKgMin: draft.weightKgMin,
    weightKgMax: draft.weightKgMax,
    // True whenever there is a range, because these fields only ever hold the
    // photograph's estimate — see `Pet.weightKgMin`.
    weightIsEstimate: draft.weightKgMin !== null || draft.weightKgMax !== null,
    status,
    hasMicrochip: draft.hasMicrochip,
    // Derived from the first PUBLISHABLE photo, never typed, and never from
    // media[0] — a genital shot can legitimately be first. See coverPhotoFrom.
    coverPhoto: coverPhotoFrom(draft.media),
    // Public by owner decision 2026-10-22; lives here, not in `detail`.
    story: draft.story.trim(),
    // The paper register's row number, so the link survives publish.
    registerNo: draft.register?.no ?? null,
    // Provenance: which fields a vision model influenced, if any.
    suggestedFields: draft.suggestedFields ?? [],
    extractedByModel: draft.suggestedByModel ?? null,
    extractedAt: draft.suggestedByModel ? now : null,
    // Required by getWall(), which orders by it. A document missing the
    // ordered field is dropped from the query silently.
    createdAt: now,
    updatedAt: now,
  };

  const detail: DetailDocumentWrite = {
    sterilized: draft.sterilized ?? null,
  };

  const media = draft.media.map((m, index) => ({
    id: m.id,
    data: {
      kind: 'photo' as const,
      // ⚠️ The slot decides, not only the position: a teeth or genital photo
      // is never public even when it is first. See mediaTierFor.
      tier: mediaTierFor(m.slot, index),
      slot: m.slot,
      path: m.path,
      derivatives: {},
      width: m.width,
      height: m.height,
      durationSeconds: null,
      // A blank description publishes as "Foto de Luna": the name, nothing
      // invented. A screen reader still learns whose photo it is.
      alt: m.alt.trim() || defaultAlt(name),
      order: index,
      uploadedAt: now,
      uploadedBy: uid,
    },
  }));

  let identity: IdentityDocumentWrite<TS> | null = null;
  let invalidChip = false;
  if (draft.hasMicrochip && draft.microchipCode.trim()) {
    const validation = validateMicrochip(draft.microchipCode, draft.microchipStandard);
    if (validation.valid && validation.parsed) {
      identity = {
        code: validation.parsed.code,
        standard: draft.microchipStandard,
        prefix: validation.parsed.prefix,
        nationalId: validation.parsed.nationalId,
        implantedAt: null,
        implantedBy: null,
        implantSite: null,
        externalRegistry: null,
        externalRegistryId: null,
        updatedAt: now,
        updatedBy: uid,
      };
    } else {
      invalidChip = true;
    }
  }

  return { petId: draft.id, pet, detail, media, identity, invalidChip };
}
