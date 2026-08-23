/**
 * Admin writes — Client Components only, through the Firebase Web SDK.
 *
 * ── Why the client and not a Server Action ─────────────────────────────────
 * This is the first module in the project that finally cashes in the cost
 * principle in CLAUDE.md's `## Architecture`. Reads and writes here go
 * straight to Firestore from the browser, and `firestore.rules` does the
 * authorization — which is free. Routing the same writes through a Server
 * Action would use the Admin SDK, which BYPASSES rules entirely: every check
 * would have to be re-implemented in TypeScript, and the rules that were
 * proven enforcing on 2026-08-23 would be protecting a path nothing uses.
 *
 * The consequence to keep in mind while reading: **every function below can
 * fail with `permission-denied`, and that is the system working.** An admin
 * whose ID token predates their claim grant is the common case — see
 * `AuthProvider`'s forced token refresh and `scripts/grant-admin.mjs`.
 *
 * ── The draft id IS the pet id ─────────────────────────────────────────────
 * Minted before anything is saved, so photos uploaded during step 2 land at
 * their final `pets/{petId}/…` path. Storage rules gate that path on the admin
 * claim, not on the pet document existing, so nothing is moved or re-uploaded
 * at publish time and no URL changes underneath a shared link.
 *
 * ⚠️ No user-facing words here either. Failures surface as thrown errors and
 * the component maps them through `src/i18n`.
 */

'use client';

import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { deleteObject, getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import type { User } from 'firebase/auth';

import { getFirebase } from './firebase-client';
import { validateMicrochip } from './microchip';
import { disambiguateSlug, toAgeMonths, type DraftMedia, type PetDraft } from './intake';

// ─────────────────────────────────────────────────────────────────────────────
// Drafts
// ─────────────────────────────────────────────────────────────────────────────

/** A Firestore-generated id, obtained without writing anything. */
export function mintPetId(): string {
  const { db } = getFirebase();
  return doc(collection(db, 'pets')).id;
}

export async function saveDraft(draft: PetDraft): Promise<void> {
  const { db } = getFirebase();
  await setDoc(doc(db, 'petDrafts', draft.id), {
    ...draft,
    updatedAt: serverTimestamp(),
  });
}

export async function loadDraft(id: string): Promise<PetDraft | null> {
  const { db } = getFirebase();
  const snap = await getDoc(doc(db, 'petDrafts', id));
  if (!snap.exists()) return null;

  const data = snap.data();
  // `updatedAt` is a Firestore Timestamp and has no place in the wizard's
  // state — stripping it here keeps PetDraft a plain serialisable object that
  // the pure functions in `intake.ts` can reason about without importing
  // Firestore. Same reason `placements.ts` works in epoch milliseconds.
  delete data.updatedAt;
  return data as PetDraft;
}

export async function listDrafts(max = 50): Promise<PetDraft[]> {
  const { db } = getFirebase();
  const snap = await getDocs(
    query(collection(db, 'petDrafts'), orderBy('updatedAt', 'desc'), limit(max)),
  );
  return snap.docs.map((d) => {
    const data = d.data();
    delete data.updatedAt;
    return data as PetDraft;
  });
}

export async function discardDraft(id: string): Promise<void> {
  const { db } = getFirebase();
  await deleteDoc(doc(db, 'petDrafts', id));
}

// ─────────────────────────────────────────────────────────────────────────────
// Slugs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every published slug that starts with `base`, so the wizard can pick the
 * next free one.
 *
 * A prefix range rather than reading the whole collection: U+F8FF sorts above
 * every ordinary character, so `>= base` and `<= base + \uf8ff` bound the scan
 * to the handful of "luna", "luna-2", "luna-3" documents. Ordering on a
 * single field is indexed automatically, so this needs no entry in
 * `firestore.indexes.json` — and adding one would get the WHOLE file rejected
 * as unnecessary, which is the 2026-08-12 failure.
 */
export async function takenSlugs(base: string): Promise<string[]> {
  const { db } = getFirebase();
  const snap = await getDocs(
    query(
      collection(db, 'pets'),
      where('slug', '>=', base),
      where('slug', '<=', `${base}\uf8ff`),
    ),
  );
  return snap.docs.map((d) => d.data().slug as string);
}

/** The slug this draft should publish under, avoiding collisions. */
export async function resolveSlug(base: string): Promise<string> {
  return disambiguateSlug(base, await takenSlugs(base));
}

// ─────────────────────────────────────────────────────────────────────────────
// Photos
// ─────────────────────────────────────────────────────────────────────────────

/** Long edge, in pixels. The wall renders at 480×600; this leaves headroom. */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;

/**
 * Re-encode an image through a canvas, and in doing so strip its metadata.
 *
 * ⚠️ **This is a privacy control, not an optimisation.** A photo taken in a
 * foster home carries GPS coordinates in its EXIF, so publishing it publishes
 * a volunteer's home address — CLAUDE.md concern #2, arriving through the
 * image pipeline rather than the location field. `scripts/seed-pet.mjs` does
 * the same job with sharp on the server; this is the browser's equivalent and
 * must not be removed to "keep the original quality".
 *
 * A canvas has no way to carry EXIF through, so the stripping is structural
 * rather than a flag we remember to set.
 *
 * ── The orientation trap ───────────────────────────────────────────────────
 * Dropping EXIF also drops the EXIF *orientation* flag, which is how phones
 * record "this was shot in portrait" without rotating the pixels. Re-encoding
 * naively therefore publishes sideways photographs — and the original looks
 * correct in every viewer, so the bug appears to be ours alone.
 * `createImageBitmap(blob, { imageOrientation: 'from-image' })` applies the
 * rotation to the pixels before we draw, which is exactly what we want:
 * the orientation is baked in, then the tag is discarded with everything else.
 */
/**
 * Thrown when the browser cannot decode the chosen file at all.
 *
 * Worth its own error rather than a generic failure: `accept="image/*"` lets a
 * phone offer formats Chrome cannot decode — HEIC from an iPhone is the common
 * one — and "no pudimos guardar" would send someone looking at their internet
 * connection when the real answer is "that photo is in a format we can't read,
 * send it another way".
 */
export class PhotoUnreadableError extends Error {
  constructor(cause?: unknown) {
    super('photo-unreadable');
    this.name = 'PhotoUnreadableError';
    this.cause = cause;
  }
}

export async function stripAndResize(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (cause) {
    throw new PhotoUnreadableError(cause);
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas-unavailable');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
  );
  if (!blob) throw new Error('encode-failed');
  return blob;
}

/**
 * Upload one photo for a pet and return the draft record for it.
 *
 * The returned `path` is what `PetMedia` stores; the `url` is kept alongside
 * because the wizard previews it immediately and `coverPhoto` is derived from
 * it. `getDownloadURL` returns a `firebasestorage.googleapis.com` URL, which
 * is the single host `next.config.ts` allows — any other host throws
 * `E231 Invalid src prop` and 500s the whole page. That constraint is why the
 * cover URL is DERIVED here and never typed by hand, the same rule
 * `scripts/seed-pet.mjs` enforces.
 */
export async function uploadPetPhoto(petId: string, file: File): Promise<DraftMedia> {
  const { storage } = getFirebase();

  const processed = await stripAndResize(file);
  const dimensions = await readDimensions(processed);

  const id = crypto.randomUUID();
  const path = `pets/${petId}/${id}.jpg`;

  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, processed, { contentType: 'image/jpeg' });
  const url = await getDownloadURL(storageRef);

  return { id, path, url, alt: '', ...dimensions };
}

/**
 * Best-effort removal of photos a draft no longer references.
 *
 * Deliberately non-throwing. These are called while removing a photo or
 * discarding a draft, and a failed delete must not block either — the draft
 * document is the record that matters, and an unreferenced 200 KB JPEG costs
 * nothing against a 5 GB free tier. But leaving them forever needs a sweep
 * that does not exist, so the cheap moment to delete them is the moment we
 * still know exactly which paths they are.
 *
 * Safe because a draft owns its whole `pets/{draftId}/` prefix: the id is
 * minted per draft, so no other record can reference these objects.
 */
export async function deletePhotos(paths: readonly string[]): Promise<void> {
  const { storage } = getFirebase();
  await Promise.all(
    paths.map(async (path) => {
      try {
        await deleteObject(ref(storage, path));
      } catch (error) {
        console.error('[pets-admin] could not delete %s', path, error);
      }
    }),
  );
}

async function readDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  const dimensions = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return dimensions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Publish
// ─────────────────────────────────────────────────────────────────────────────

export interface PublishResult {
  petId: string;
  slug: string;
}

/**
 * Write the draft out across the tiers it belongs to, atomically.
 *
 * This is the single place the flat wizard object becomes the tiered document
 * structure `firestore.rules` protects — and the split is the whole point:
 *
 *   pets/{id}                    public   name, photo, status. Indexable.
 *   pets/{id}/detail/main        signed in  the story and health notes
 *   pets/{id}/media/{mediaId}    public|auth  every photo
 *   pets/{id}/identity/microchip restricted   the chip NUMBER
 *
 * `hasMicrochip` goes on the PUBLIC document as a boolean and the code goes
 * only into `identity` — a finder needs to know the animal is worth taking to
 * a scanner; nobody needs the number to decide that, and the number is the
 * credential by which ownership gets asserted.
 *
 * One `writeBatch`, so a half-published animal is not a state that exists. The
 * draft delete is in the same batch: if the publish fails the draft is still
 * there, and if it succeeds there is no orphan to clean up.
 */
export async function publishDraft(draft: PetDraft, user: User): Promise<PublishResult> {
  const { db } = getFirebase();

  const slug = await resolveSlug(draft.slug);
  const batch = writeBatch(db);
  const petRef = doc(db, 'pets', draft.id);

  // ── public tier ──────────────────────────────────────────────────────────
  batch.set(petRef, {
    slug,
    species: draft.species,
    name: draft.name.trim(),
    // Empty on a first intake. It fills in when an animal is renamed later —
    // and the dossier reads `.length` unguarded, so it must be an array now.
    formerNames: [],
    breed: draft.breed.trim(),
    ageMonths: toAgeMonths(draft.ageYears, draft.ageMonthsPart, draft.ageUnknown),
    birthdateApprox: null,
    sex: draft.sex,
    size: draft.size,
    status: draft.status,
    hasMicrochip: draft.hasMicrochip,
    // Derived from the first uploaded photo, never typed. See uploadPetPhoto.
    coverPhoto: draft.media[0]?.url ?? null,
    // Required by getWall(), which orders by it. A document missing the
    // ordered field is dropped from the query silently — it looks exactly
    // like "no data", which is this project's most-repeated failure shape.
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // ── authenticated tier ───────────────────────────────────────────────────
  batch.set(doc(petRef, 'detail', 'main'), {
    story: draft.story.trim(),
    temperament: draft.temperament,
    healthNotes: draft.healthNotes.trim(),
    photos: [],
    commitments: draft.commitments,
    sterilized: draft.sterilized,
    goodWithChildren: draft.goodWithChildren,
    goodWithOtherPets: draft.goodWithOtherPets,
  });

  // ── media ────────────────────────────────────────────────────────────────
  draft.media.forEach((media, index) => {
    batch.set(doc(petRef, 'media', media.id), {
      kind: 'photo',
      // The cover is public because it appears on the wall; the rest are
      // gated, matching the "public teaser, gated detail" decision. An
      // unauthenticated client MUST query with where('tier','==','public') or
      // the whole query is rejected rather than filtered — see types.ts.
      tier: index === 0 ? 'public' : 'auth',
      path: media.path,
      derivatives: {},
      width: media.width,
      height: media.height,
      durationSeconds: null,
      alt: media.alt.trim(),
      order: index,
      uploadedAt: serverTimestamp(),
      uploadedBy: user.uid,
    });
  });

  // ── restricted tier: the chip number ─────────────────────────────────────
  if (draft.hasMicrochip && draft.microchipCode.trim()) {
    const validation = validateMicrochip(draft.microchipCode, draft.microchipStandard);
    // The form blocks an invalid code, so reaching here with one means the
    // draft was edited elsewhere. Publishing the animal without its chip
    // record is better than refusing the whole intake — but it must not be
    // silent, because `hasMicrochip` would then claim a record that is absent.
    if (validation.valid && validation.parsed) {
      batch.set(doc(petRef, 'identity', 'microchip'), {
        code: validation.parsed.code,
        standard: draft.microchipStandard,
        prefix: validation.parsed.prefix,
        nationalId: validation.parsed.nationalId,
        implantedAt: null,
        implantedBy: null,
        implantSite: null,
        externalRegistry: null,
        externalRegistryId: null,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid,
      });
    } else {
      console.error('[pets-admin] publishing without an identity document: invalid chip code');
    }
  }

  batch.delete(doc(db, 'petDrafts', draft.id));

  await batch.commit();
  return { petId: draft.id, slug };
}
