import 'server-only';

import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import { getAdminDb, getAdminStorage } from './firebase-admin';
import type { MedicalCandidate } from './types';
import { cardCandidateFields, type CandidateMeta, type CardCandidate } from './card-extraction';
import { candidateIdFor, isAlreadyExistsError } from './medical-candidates';

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
 *
 * ⚠️ It writes CANDIDATES, never records. A model's reading goes to the
 * admin-only `pets/{petId}/medicalCandidates`; the only way into
 * `pets/{petId}/medical` is a person confirming it (`confirmMedicalRecord`).
 * `medical-wiring.test.ts` pins that this file touches `medical` only to ask
 * whether a card was already read.
 */

/** Largest card photo the route will read. Matches the pet-photo cap in storage.rules. */
export const CARD_PHOTO_MAX_BYTES = 8 * 1024 * 1024;

const CARD_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * The document a candidate is written as.
 *
 * ⚠️ Derived from `MedicalCandidate`, not written out by hand — the same reason
 * `PetDocumentWrite` exists. A field added to `MedicalCandidate` and forgotten
 * in `cardCandidateFields` fails the typecheck here instead of producing a
 * document without it.
 */
type CandidateWrite = Omit<
  MedicalCandidate,
  'id' | 'performedAt' | 'nextDueAt' | 'validFrom' | 'validUntil' | 'extractedAt'
> & {
  performedAt: Timestamp | null;
  nextDueAt: Timestamp | null;
  validFrom: Timestamp | null;
  validUntil: Timestamp | null;
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
 * Has this card already produced candidates or confirmed records?
 *
 * The FAST path, asked before the model is called, so an ordinary retry does
 * not spend a free-tier request. It is not the guarantee: two requests can
 * both pass it. The guarantee is `writeCardCandidates`' create-if-absent
 * deterministic ids, which refuse the loser atomically.
 *
 * Both are single-field equalities on one pet's subcollection: indexed
 * automatically, and no entry belongs in `firestore.indexes.json`.
 */
export async function cardAlreadyExtracted(petId: string, path: string): Promise<boolean> {
  const pet = getAdminDb().collection('pets').doc(petId);
  const [records, candidates] = await Promise.all([
    pet.collection('medical').where('sourceDocument', '==', path).limit(1).get(),
    pet.collection('medicalCandidates').where('sourceDocument', '==', path).limit(1).get(),
  ]);
  return !records.empty || !candidates.empty;
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

export type CandidateWriteResult =
  | { kind: 'written'; ids: string[] }
  /** A candidate with one of these ids already exists: this card was read already. */
  | { kind: 'already-extracted' };

/**
 * Write every candidate from one card, atomically, into `medicalCandidates`.
 *
 * ⚠️ `create`, never `set`. Each id is `candidateIdFor(card path, index)`, so a
 * second extraction of the same card — however it got past
 * `cardAlreadyExtracted` — collides on the first id and the WHOLE batch is
 * refused. One card is never half-written and never written twice.
 */
export async function writeCardCandidates(
  petId: string,
  candidates: readonly CardCandidate[],
  meta: CandidateMeta
): Promise<CandidateWriteResult> {
  const db = getAdminDb();
  const collectionRef = db.collection('pets').doc(petId).collection('medicalCandidates');
  const batch = db.batch();
  const ids: string[] = [];

  candidates.forEach((candidate, index) => {
    const fields = cardCandidateFields(candidate, index, meta);
    const write: CandidateWrite = {
      ...fields,
      performedAt: toTimestamp(fields.performedAt),
      nextDueAt: toTimestamp(fields.nextDueAt),
      validFrom: toTimestamp(fields.validFrom),
      validUntil: toTimestamp(fields.validUntil),
      extractedAt: FieldValue.serverTimestamp(),
    };
    const id = candidateIdFor(meta.sourceDocument, index);
    batch.create(collectionRef.doc(id), write);
    ids.push(id);
  });

  try {
    await batch.commit();
  } catch (err) {
    if (isAlreadyExistsError(err)) return { kind: 'already-extracted' };
    throw err;
  }
  return { kind: 'written', ids };
}
