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
  updateDoc,
  type FieldValue,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';

import { getFirebase } from './firebase-client';
import type { MedicalRecord } from './types';
import type { MedicalRecordDraft } from './medical';

/**
 * The exact shape written to `pets/{petId}/medical/{recordId}`.
 *
 * ⚠️ Annotated for the same reason `PetDocumentWrite` exists: an untyped object
 * literal means a field added to `MedicalRecord` produces a green typecheck and
 * a document without it. That hole sat in the pet writer for three weeks. Do
 * not replace this with an inline literal.
 */
type MedicalRecordWrite = Omit<MedicalRecord, 'id'>;

/** What a caller gets back — epoch ms, so the pure layer needs no Timestamp. */
export interface MedicalRecordView {
  id: string;
  kind: MedicalRecord['kind'];
  name: string;
  performedAt: number;
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
  extractedByModel: string | null;
  recordedBy: string;
}

function toMillis(value: unknown): number | null {
  if (value instanceof Timestamp) return value.toMillis();
  return null;
}

function toDraftTimestamp(ms: number | null): Timestamp | null {
  return ms === null ? null : Timestamp.fromMillis(ms);
}

/**
 * Every medical record for one pet, most recent first.
 *
 * Ordered by `performedAt` descending, which the deployed
 * `medical(kind, performedAt desc)` index supports. A record missing
 * `performedAt` would be dropped from this query silently — which is why the
 * writer makes it non-nullable rather than optional.
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
      kind: data.kind,
      name: data.name ?? '',
      // A record without this is unorderable and unreadable; 0 makes the gap
      // visible rather than crashing the panel.
      performedAt: toMillis(data.performedAt) ?? 0,
      nextDueAt: toMillis(data.nextDueAt),
      validFrom: toMillis(data.validFrom),
      validUntil: toMillis(data.validUntil),
      veterinarian: data.veterinarian ?? null,
      clinic: data.clinic ?? null,
      batch: data.batch ?? null,
      manufacturer: data.manufacturer ?? null,
      notes: data.notes ?? null,
      source: data.source ?? 'manual',
      confirmedBy: data.confirmedBy ?? null,
      extractedByModel: data.extractedByModel ?? null,
      recordedBy: data.recordedBy ?? '',
    };
  });
}

function buildWrite(draft: MedicalRecordDraft, user: User): MedicalRecordWrite {
  if (draft.kind === null || draft.performedAt === null) {
    // Callers validate first; this is the type-level backstop.
    throw new Error('medical: draft is incomplete');
  }

  return {
    kind: draft.kind,
    name: draft.name.trim(),
    performedAt: Timestamp.fromMillis(draft.performedAt),
    nextDueAt: toDraftTimestamp(draft.nextDueAt),
    validFrom: toDraftTimestamp(draft.validFrom),
    validUntil: toDraftTimestamp(draft.validUntil),
    // ⚠️ Null here is NOT an incomplete record. Bolivia's free rabies campaign
    // produces real vaccinations with no named vet and no lot number.
    veterinarian: draft.veterinarian?.trim() || null,
    clinic: draft.clinic?.trim() || null,
    batch: draft.batch?.trim() || null,
    manufacturer: draft.manufacturer?.trim() || null,
    notes: draft.notes?.trim() || null,
    // Reserved socket for a future VeNom / SNOMED VetSCT mapping. Deliberately
    // empty: neither terminology survives a volunteer transcribing a card, and
    // free text is backfillable.
    codes: [],
    source: 'manual',
    // A human typed this, so it is confirmed at creation. An LLM-extracted
    // record arrives with confirmedBy null until someone accepts it.
    confirmedBy: user.email ?? user.uid,
    sourceDocument: null,
    extractedByModel: null,
    extractedAt: null,
    recordedBy: user.email ?? user.uid,
  };
}

export async function addMedicalRecord(
  petId: string,
  draft: MedicalRecordDraft,
  user: User
): Promise<string> {
  const { db } = getFirebase();
  const ref = await addDoc(collection(db, 'pets', petId, 'medical'), buildWrite(draft, user));
  return ref.id;
}

/**
 * Edit an existing record.
 *
 * ⚠️ Deliberately does NOT touch `recordedBy`. Who first entered a medical
 * record is history, and overwriting it on every edit would erase the only
 * trace of who originally wrote it down. `confirmedBy` moves to the editor,
 * because they are the one now vouching for it.
 */
export async function updateMedicalRecord(
  petId: string,
  recordId: string,
  draft: MedicalRecordDraft,
  user: User
): Promise<void> {
  const { db } = getFirebase();
  const write = buildWrite(draft, user);
  const { recordedBy: _ignored, ...rest } = write;

  await updateDoc(doc(db, 'pets', petId, 'medical', recordId), {
    ...rest,
  } as Record<string, FieldValue | unknown>);
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
