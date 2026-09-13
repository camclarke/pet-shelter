import 'server-only';

import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import { getAdminDb, getAdminStorage } from './firebase-admin';
import type { MedicalRecord } from './types';
import {
  candidateRecordFields,
  type CandidateMeta,
  type CardCandidate,
} from './card-extraction';

/**
 * Medical records: the SERVER side, through the Admin SDK. Build-order step 9.
 *
 * Every other medical write in this project goes browser → Firestore with
 * `firestore.rules` as the boundary. This module is the exception, for one
 * reason: the card-extraction route has to read an admin-only Storage object
 * and write the model's candidates in the same request, and it holds a secret
 * the browser must never see.
 *
 * ⚠️ The Admin SDK BYPASSES the rules entirely. The caller —
 * `src/app/api/medical/cards/extract/route.ts` — verifies the ID token and the
 * admin claim itself, and only then calls in here. Nothing in this file may be
 * reachable any other way.
 */

/** Largest card photo the route will read. Matches the pet-photo cap in storage.rules. */
export const CARD_PHOTO_MAX_BYTES = 8 * 1024 * 1024;

const CARD_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * The document a candidate is written as.
 *
 * ⚠️ Derived from `MedicalRecord`, not written out by hand — the same reason
 * `PetDocumentWrite` exists. A field added to `MedicalRecord` and forgotten in
 * `candidateRecordFields` fails the typecheck here instead of producing a
 * document without it.
 */
type CandidateWrite = Omit<
  MedicalRecord,
  'id' | 'performedAt' | 'nextDueAt' | 'validFrom' | 'validUntil' | 'confirmedAt' | 'extractedAt'
> & {
  performedAt: Timestamp | null;
  nextDueAt: Timestamp | null;
  validFrom: null;
  validUntil: null;
  confirmedAt: null;
  extractedAt: FieldValue;
};

function toTimestamp(ms: number | null): Timestamp | null {
  return ms === null ? null : Timestamp.fromMillis(ms);
}

/**
 * The bucket card photos live in, from the same build-time value the browser
 * uploads with.
 *
 * ⚠️ No hard-coded fallback. A forking shelter must not silently read from
 * `wawitas-app` — the same rule `scripts/release-storage-rules.mjs` follows.
 */
export function cardBucketName(): string | null {
  const name = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET?.trim();
  return name ? name : null;
}

/** Does this pet exist? Candidates under a missing pet would be orphans no screen can reach. */
export async function petExists(petId: string): Promise<boolean> {
  const snap = await getAdminDb().collection('pets').doc(petId).get();
  return snap.exists;
}

/**
 * Has this card already produced records?
 *
 * Asked BEFORE the model is called, so a retry after a response the browser
 * never received — Firebase Hosting cuts at 60 s, and the write may already
 * have landed — does not spend a second free-tier request and duplicate every
 * candidate. A single-field equality on one pet's subcollection: indexed
 * automatically, and no entry belongs in `firestore.indexes.json`.
 */
export async function cardAlreadyExtracted(petId: string, path: string): Promise<boolean> {
  const snap = await getAdminDb()
    .collection('pets')
    .doc(petId)
    .collection('medical')
    .where('sourceDocument', '==', path)
    .limit(1)
    .get();
  return !snap.empty;
}

export type CardReadResult =
  | { kind: 'ok'; bytes: Uint8Array; mediaType: string }
  | { kind: 'missing' }
  | { kind: 'too-large'; size: number }
  | { kind: 'unsupported'; contentType: string }
  | { kind: 'not-configured' };

/**
 * Read a card photo, checking its size and type from METADATA before any byte
 * is downloaded. `path` must already have passed `isCardPhotoPathFor()`.
 */
export async function readCardPhoto(path: string): Promise<CardReadResult> {
  const bucketName = cardBucketName();
  if (!bucketName) return { kind: 'not-configured' };

  const file = getAdminStorage().bucket(bucketName).file(path);

  let metadata: { size?: string | number; contentType?: string };
  try {
    [metadata] = await file.getMetadata();
  } catch (err) {
    if ((err as { code?: unknown })?.code === 404) return { kind: 'missing' };
    throw err;
  }

  const size = Number(metadata.size ?? 0);
  if (!Number.isFinite(size) || size > CARD_PHOTO_MAX_BYTES) return { kind: 'too-large', size };

  const contentType = metadata.contentType ?? '';
  if (!CARD_PHOTO_TYPES.has(contentType)) return { kind: 'unsupported', contentType };

  const [buffer] = await file.download();
  return { kind: 'ok', bytes: new Uint8Array(buffer), mediaType: contentType };
}

/**
 * Write every candidate from one card, atomically, UNCONFIRMED.
 *
 * One batch, so a card is never half-written: either every row the policy
 * kept is there for review, or none is and the extraction can be retried.
 */
export async function writeCardCandidates(
  petId: string,
  candidates: readonly CardCandidate[],
  meta: CandidateMeta
): Promise<string[]> {
  const db = getAdminDb();
  const medical = db.collection('pets').doc(petId).collection('medical');
  const batch = db.batch();
  const ids: string[] = [];

  for (const candidate of candidates) {
    const fields = candidateRecordFields(candidate, meta);
    const write: CandidateWrite = {
      ...fields,
      performedAt: toTimestamp(fields.performedAt),
      nextDueAt: toTimestamp(fields.nextDueAt),
      extractedAt: FieldValue.serverTimestamp(),
    };
    const ref = medical.doc();
    batch.set(ref, write);
    ids.push(ref.id);
  }

  await batch.commit();
  return ids;
}
