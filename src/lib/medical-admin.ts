/**
 * Medical records: the Firestore layer, client-side under `firestore.rules`.
 *
 * Reads and writes go straight from the admin's browser to Firestore, and the
 * rules are the boundary — `match /medical/{recordId} { allow read: if
 * signedIn(); allow write: if isAdmin(); }`, written 2026-08-02 and proven
 * enforcing 2026-08-23. `AdminGate` is UX, not authorization.
 *
 * ⚠️ No rules change and no index change was needed for the `medical` half of
 * this module. Both were written long before anything called them: the
 * `medical` rule on 2026-08-02, and both composite indexes (`kind`+
 * `performedAt desc` COLLECTION, `kind`+`nextDueAt` COLLECTION_GROUP) confirmed
 * READY by gcloud on 2026-08-26.
 *
 * ── Candidates, since step 9 ────────────────────────────────────────────────
 * A model's reading of a card is NOT a medical record. It lives in the
 * admin-only `pets/{petId}/medicalCandidates` and becomes a record only through
 * `confirmMedicalRecord()` below. See `src/lib/medical-candidates.ts` for why
 * that is a location and not a field. ⚠️ The `medicalCandidates` rule is NEW
 * and must be deployed before this code reaches production; until then an
 * admin's read of it is refused.
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
  runTransaction,
  serverTimestamp,
  updateDoc,
  type FieldValue,
} from 'firebase/firestore';
import { ref, uploadBytes } from 'firebase/storage';
import type { User } from 'firebase/auth';

import { getFirebase } from './firebase-client';
import type {
  FieldEvidence,
  MedicalExtractionSource,
  MedicalRecord,
  MedicalRecordKind,
} from './types';
import { medicalEditFields, type MedicalEditFields, type MedicalRecordDraft } from './medical';
import { readEvidence, reviewerLabel } from './review-gate';
import { cardPhotoPath } from './card-extraction';
import {
  CandidateGoneError,
  MedicalConfirmationError,
  inReviewOrder,
  planConfirmation,
} from './medical-candidates';

/**
 * The exact shape written to `pets/{petId}/medical/{recordId}`.
 *
 * ⚠️ Annotated for the same reason `PetDocumentWrite` exists: an untyped object
 * literal means a field added to `MedicalRecord` produces a green typecheck and
 * a document without it. That hole sat in the pet writer for three weeks. Do
 * not replace this with an inline literal.
 */
type MedicalRecordWrite = Omit<MedicalRecord, 'id' | 'confirmedAt' | 'extractedAt'> & {
  confirmedAt: FieldValue | null;
  extractedAt: Timestamp | null;
};

/** An edit: the editable fields plus the confirmation stamp, and nothing else. */
type MedicalEditWrite = Pick<
  MedicalRecordWrite,
  keyof MedicalEditFields | 'confirmedBy' | 'confirmedAt'
>;

/** What a caller gets back — epoch ms, so the pure layer needs no Timestamp. */
export interface MedicalRecordView {
  id: string;
  /** Null only on a malformed document; the reader is defensive. */
  kind: MedicalRecordKind | null;
  name: string;
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

/** A candidate as the review UI sees it — epoch ms, read defensively. */
export interface MedicalCandidateView {
  id: string;
  kind: MedicalRecordKind | null;
  name: string;
  performedAt: number | null;
  nextDueAt: number | null;
  validFrom: number | null;
  validUntil: number | null;
  veterinarian: string | null;
  clinic: string | null;
  batch: string | null;
  manufacturer: string | null;
  notes: string | null;
  sourceDocument: string | null;
  extractedByModel: string | null;
  extractedFrom: MedicalExtractionSource | null;
  extractionEvidence: Record<string, FieldEvidence> | null;
  extractedAt: number | null;
  sourceIndex: number;
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

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Every medical record for one pet, most recent first.
 *
 * Ordered by `performedAt` descending. A document MISSING `performedAt` would be
 * dropped from this query silently, which is why every writer sets it.
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
      confirmedBy: stringOrNull(data.confirmedBy),
      confirmedAt: toMillis(data.confirmedAt),
      sourceDocument: stringOrNull(data.sourceDocument),
      extractedByModel: data.extractedByModel ?? null,
      extractedFrom: EXTRACTION_SOURCES.includes(data.extractedFrom) ? data.extractedFrom : null,
      extractionEvidence: readEvidence(data.extractionEvidence),
      recordedBy: data.recordedBy ?? '',
    };
  });
}

/**
 * Every candidate awaiting review for one pet: newest card first, a card's
 * rows in order.
 *
 * No `orderBy`: a handful of documents sorted in memory, so no index exists to
 * deploy or to forget.
 */
export async function listMedicalCandidates(petId: string): Promise<MedicalCandidateView[]> {
  const { db } = getFirebase();
  const snap = await getDocs(collection(db, 'pets', petId, 'medicalCandidates'));

  const views = snap.docs.map((d): MedicalCandidateView => {
    const data = d.data();
    return {
      id: d.id,
      kind: data.kind ?? null,
      name: data.name ?? '',
      performedAt: toMillis(data.performedAt),
      nextDueAt: toMillis(data.nextDueAt),
      validFrom: toMillis(data.validFrom),
      validUntil: toMillis(data.validUntil),
      veterinarian: data.veterinarian ?? null,
      clinic: data.clinic ?? null,
      batch: data.batch ?? null,
      manufacturer: data.manufacturer ?? null,
      notes: data.notes ?? null,
      sourceDocument: stringOrNull(data.sourceDocument),
      extractedByModel: stringOrNull(data.extractedByModel),
      extractedFrom: EXTRACTION_SOURCES.includes(data.extractedFrom) ? data.extractedFrom : null,
      extractionEvidence: readEvidence(data.extractionEvidence),
      extractedAt: toMillis(data.extractedAt),
      sourceIndex: typeof data.sourceIndex === 'number' ? data.sourceIndex : 0,
      recordedBy: data.recordedBy ?? '',
    };
  });
  return inReviewOrder(views);
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
    // A human typed this, so it is confirmed at creation.
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
 * Edit a confirmed record — and, by editing it, vouch for it.
 *
 * ⚠️ Writes ONLY the editable fields plus the confirmation stamp, so an edit
 * cannot relabel a record's provenance: a confirmed card reading stays
 * `llm-extracted` with its card and its model key.
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
 * Confirm a candidate: create the medical record from the values a person
 * accepted, and delete the candidate — in one transaction. The ONLY way a
 * model's reading becomes a medical record.
 *
 * ⚠️ COMPLETENESS IS ENFORCED HERE, not by the button that calls this.
 * `planConfirmation()` runs `validateMedicalDraft()` over `draft`, and this
 * function throws `MedicalConfirmationError` with the reasons rather than
 * write a record without a date or a kind. Until 2026-09-13 the one-click
 * confirm stamped `confirmedBy` and trusted `MedicalPanel` to have rendered the
 * button only for a complete record; step 11 confirms from a different screen.
 *
 * One-click confirm passes `draftFromRecord(candidate)`; correct-and-confirm
 * passes the edited form. Either way the VALUES come from `draft` and the
 * PROVENANCE — card, model key, evidence, who extracted it — from `candidate`.
 *
 * ── Why a transaction, and why the candidate's id ───────────────────────────
 * The candidate is read inside the transaction, so one already confirmed or
 * discarded by another admin is not resurrected as a record
 * (`CandidateGoneError`). The record takes the candidate's deterministic id,
 * so two confirmations racing on one candidate converge on one document.
 */
export async function confirmMedicalRecord(
  petId: string,
  candidate: MedicalCandidateView,
  draft: MedicalRecordDraft,
  user: User
): Promise<string> {
  const plan = planConfirmation(candidate, draft, reviewerLabel(user));
  if (!plan.ok) throw new MedicalConfirmationError(plan.errors);
  const { record } = plan;

  const { db } = getFirebase();
  const candidateRef = doc(db, 'pets', petId, 'medicalCandidates', candidate.id);
  const recordRef = doc(db, 'pets', petId, 'medical', candidate.id);

  const write: MedicalRecordWrite = {
    ...record,
    performedAt: Timestamp.fromMillis(record.performedAt),
    nextDueAt: toTimestamp(record.nextDueAt),
    validFrom: toTimestamp(record.validFrom),
    validUntil: toTimestamp(record.validUntil),
    confirmedAt: serverTimestamp(),
    extractedAt: toTimestamp(record.extractedAt),
  };

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(candidateRef);
    if (!snap.exists()) throw new CandidateGoneError();
    tx.set(recordRef, write);
    tx.delete(candidateRef);
  });
  return recordRef.id;
}

/**
 * Discard a candidate. The card photo stays: several candidates share one card,
 * and a discarded reading may be re-read.
 */
export async function discardMedicalCandidate(petId: string, candidateId: string): Promise<void> {
  const { db } = getFirebase();
  await deleteDoc(doc(db, 'pets', petId, 'medicalCandidates', candidateId));
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
