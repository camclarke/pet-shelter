/**
 * Medical records: the Firestore layer, client-side under `firestore.rules`.
 *
 * Reads and writes go straight from the admin's browser to Firestore, and the
 * rules are the boundary — `match /medical/{recordId} { allow read: if
 * signedIn(); allow write: if isAdmin(); }`, written 2026-08-02 and proven
 * enforcing 2026-08-23. `AdminGate` is UX, not authorization.
 *
 * ⚠️ No rules change and no index change was needed for this module. Both were
 * written long before anything called them: the `medical` rule on 2026-08-02,
 * and both composite indexes (`kind`+`performedAt desc` COLLECTION,
 * `kind`+`nextDueAt` COLLECTION_GROUP) confirmed READY by gcloud on
 * 2026-08-26. This is the fourth time in this project a decision turned out to
 * be already made and merely uncalled.
 */

import {
  Timestamp,
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  type FieldValue,
} from 'firebase/firestore';
import { ref, uploadBytes } from 'firebase/storage';
import type { User } from 'firebase/auth';

import { getFirebase } from './firebase-client';
import type { FieldEvidence, MedicalExtractionSource, MedicalRecord } from './types';
import { medicalEditFields, type MedicalEditFields, type MedicalRecordDraft } from './medical';
import { readEvidence, reviewerLabel } from './review-gate';
import { cardPhotoPath } from './card-extraction';

/**
 * The exact shape written to `pets/{petId}/medical/{recordId}`.
 *
 * ⚠️ Annotated for the same reason `PetDocumentWrite` exists: an untyped object
 * literal means a field added to `MedicalRecord` produces a green typecheck and
 * a document without it. That hole sat in the pet writer for three weeks. Do
 * not replace this with an inline literal.
 *
 * The two stamps are `FieldValue` sentinels going in and Timestamps coming out,
 * which is why this cannot simply be `MedicalRecord`.
 */
type MedicalRecordWrite = Omit<MedicalRecord, 'id' | 'confirmedAt' | 'extractedAt'> & {
  confirmedAt: FieldValue | null;
  extractedAt: FieldValue | null;
};

/** An edit: the editable fields plus the confirmation stamp, and nothing else. */
type MedicalEditWrite = Pick<
  MedicalRecordWrite,
  keyof MedicalEditFields | 'confirmedBy' | 'confirmedAt'
>;

/** What a caller gets back — epoch ms, so the pure layer needs no Timestamp. */
export interface MedicalRecordView {
  id: string;
  /** Null only on an unconfirmed candidate. */
  kind: MedicalRecord['kind'];
  name: string;
  /** Null only on an unconfirmed candidate whose date was not read. */
  performedAt: number | null;
  nextDueAt: number | null;
  validFrom: number | null;
  validUntil: number | null;
  veterinarian: string | null;
  clinic: string | null;
  batch: string | null;
  manufacturer: string | null;
  notes: string | null;
  source: MedicalRecord['source'];
  confirmedBy: string | null;
  confirmedAt: number | null;
  sourceDocument: string | null;
  extractedByModel: string | null;
  extractedFrom: MedicalExtractionSource | null;
  extractionEvidence: Record<string, FieldEvidence> | null;
  recordedBy: string;
}

function toMillis(value: unknown): number | null {
  if (value instanceof Timestamp) return value.toMillis();
  return null;
}

function toTimestamp(ms: number | null): Timestamp | null {
  return ms === null ? null : Timestamp.fromMillis(ms);
}

const EXTRACTION_SOURCES: readonly MedicalExtractionSource[] = ['vaccination-card', 'dictation'];

/**
 * Every medical record for one pet, most recent first.
 *
 * Ordered by `performedAt` descending, a single-field ordering Firestore
 * indexes automatically. A document MISSING `performedAt` would be dropped from
 * this query silently, which is why every writer sets the field — to a
 * Timestamp, or to null on a candidate whose date was not read. A null is a
 * value, so it stays in the results, sorted last.
 */
export async function listMedicalRecords(petId: string): Promise<MedicalRecordView[]> {
  const { db } = getFirebase();
  const snap = await getDocs(
    query(collection(db, 'pets', petId, 'medical'), orderBy('performedAt', 'desc'))
  );

  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      kind: data.kind ?? null,
      name: data.name ?? '',
      // Null on a candidate whose date was not read: the panel says so rather
      // than rendering the epoch.
      performedAt: toMillis(data.performedAt),
      nextDueAt: toMillis(data.nextDueAt),
      validFrom: toMillis(data.validFrom),
      validUntil: toMillis(data.validUntil),
      veterinarian: data.veterinarian ?? null,
      clinic: data.clinic ?? null,
      batch: data.batch ?? null,
      manufacturer: data.manufacturer ?? null,
      notes: data.notes ?? null,
      source: data.source ?? 'manual',
      // ⚠️ Read as-is and judged by isConfirmed(), never coerced here. A
      // document with no confirmer must reach the gate as "no confirmer".
      confirmedBy: typeof data.confirmedBy === 'string' ? data.confirmedBy : null,
      confirmedAt: toMillis(data.confirmedAt),
      sourceDocument: typeof data.sourceDocument === 'string' ? data.sourceDocument : null,
      extractedByModel: data.extractedByModel ?? null,
      extractedFrom: EXTRACTION_SOURCES.includes(data.extractedFrom) ? data.extractedFrom : null,
      extractionEvidence: readEvidence(data.extractionEvidence),
      recordedBy: data.recordedBy ?? '',
    };
  });
}

/** Epoch ms back to Timestamps, for the date fields an edit writes. */
function editWrite(fields: MedicalEditFields) {
  return {
    ...fields,
    performedAt: Timestamp.fromMillis(fields.performedAt),
    nextDueAt: toTimestamp(fields.nextDueAt),
    validFrom: toTimestamp(fields.validFrom),
    validUntil: toTimestamp(fields.validUntil),
  };
}

function buildCreate(draft: MedicalRecordDraft, user: User): MedicalRecordWrite {
  const by = reviewerLabel(user);
  return {
    ...editWrite(medicalEditFields(draft)),
    // Reserved socket for a future VeNom / SNOMED VetSCT mapping. Deliberately
    // empty: neither terminology survives a volunteer transcribing a card, and
    // free text is backfillable.
    codes: [],
    source: 'manual',
    // A human typed this, so it is confirmed at creation. A model-extracted
    // record arrives with confirmedBy null until someone confirms it — see
    // src/app/api/medical/cards/extract.
    confirmedBy: by,
    confirmedAt: serverTimestamp(),
    sourceDocument: null,
    extractedByModel: null,
    extractedAt: null,
    extractedFrom: null,
    extractionEvidence: null,
    recordedBy: by,
  };
}

export async function addMedicalRecord(
  petId: string,
  draft: MedicalRecordDraft,
  user: User
): Promise<string> {
  const { db } = getFirebase();
  const ref = await addDoc(collection(db, 'pets', petId, 'medical'), buildCreate(draft, user));
  return ref.id;
}

/**
 * Edit a record — and, by editing it, vouch for it.
 *
 * This is also the EDIT-BEFORE-CONFIRM path for a model-extracted candidate:
 * the person correcting what the model read is the one now vouching for it, so
 * the save stamps them as the confirmer.
 *
 * ⚠️ Writes ONLY the editable fields plus the confirmation stamp, so an edit
 * cannot relabel a record's provenance. Until 2026-09-12 this wrote the same
 * object as a create — `source: 'manual'`, `sourceDocument: null`,
 * `extractedByModel: null` — which would have turned a corrected card reading
 * into "typed by hand" and discarded the card it came from.
 *
 * ⚠️ Deliberately does NOT touch `recordedBy`. Who first entered a medical
 * record is history, and overwriting it on every edit would erase the only
 * trace of who originally wrote it down.
 */
export async function updateMedicalRecord(
  petId: string,
  recordId: string,
  draft: MedicalRecordDraft,
  user: User
): Promise<void> {
  const { db } = getFirebase();
  const write: MedicalEditWrite = {
    ...editWrite(medicalEditFields(draft)),
    confirmedBy: reviewerLabel(user),
    confirmedAt: serverTimestamp(),
  };

  await updateDoc(
    doc(db, 'pets', petId, 'medical', recordId),
    write as Record<string, FieldValue | unknown>
  );
}

/**
 * Confirm a record exactly as it stands — the one-click path, plan §4.8.
 *
 * Stamps who and when, and writes nothing else: the values are the ones the
 * person just read on screen. ⚠️ The CALLER checks `canConfirmAsIs()` against
 * `validateMedicalDraft()` first; a candidate with no date or no kind has to go
 * through the edit path instead, because a record without them is not a record.
 */
export async function confirmMedicalRecord(
  petId: string,
  recordId: string,
  user: User
): Promise<void> {
  const { db } = getFirebase();
  const stamp: Pick<MedicalRecordWrite, 'confirmedBy' | 'confirmedAt'> = {
    confirmedBy: reviewerLabel(user),
    confirmedAt: serverTimestamp(),
  };
  await updateDoc(
    doc(db, 'pets', petId, 'medical', recordId),
    stamp as Record<string, FieldValue | unknown>
  );
}

/**
 * Store a card photo that has ALREADY been through `stripAndResize()`, and
 * return its Storage path. Build-order step 9.
 *
 * ⚠️ Never a raw File. The EXIF/GPS guarantee lives in `stripAndResize()`, and
 * a card photographed in a foster home carries that home's coordinates.
 *
 * ⚠️ NEVER calls `getDownloadURL()`. A download token bypasses
 * `storage.rules` outright — measured 2026-09-03 on this very prefix,
 * `medical/**`: 200 with `?token=`, 403 without — and a card carries the
 * owner's name, address and phone. The bytes are read back through the
 * Storage SDK with the admin's own ID token (`readPhotoObjectUrl` with an
 * empty url), which the rules do govern.
 *
 * ⚠️ Known residual, the one `storage.rules` records for private pet photos:
 * Firebase's upload endpoint mints a token by itself. It sits in object
 * metadata, which the same admin-only rule gates, so it widens nothing.
 */
export async function uploadCardPhoto(petId: string, processed: Blob): Promise<string> {
  const { storage } = getFirebase();
  const path = cardPhotoPath(petId, crypto.randomUUID());
  await uploadBytes(ref(storage, path), processed, { contentType: 'image/jpeg' });
  return path;
}

/**
 * Remove a record.
 *
 * Medical history is normally append-only, and this exists for the mistyped
 * entry rather than for tidying. The rules already restrict it to admins.
 */
export async function deleteMedicalRecord(petId: string, recordId: string): Promise<void> {
  const { db } = getFirebase();
  await deleteDoc(doc(db, 'pets', petId, 'medical', recordId));
}
