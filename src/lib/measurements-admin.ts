/**
 * Weight and body condition: the Firestore layer, client-side under
 * `firestore.rules`.
 *
 * The boundary is `match /measurements/{measurementId} { allow read: if
 * signedIn(); allow write: if isAdmin(); }`, written 2026-08-16 with no caller
 * until this module. `AdminGate` is UX, not authorization.
 *
 * ⚠️ No rules change and no index change was needed. `measuredAt desc` on one
 * pet's subcollection is a SINGLE-FIELD ordering, which Firestore indexes
 * automatically — `firestore.indexes.json` records that it is deliberately
 * absent, because declaring it as a composite gets the whole file rejected.
 * The fifth time this project has found a decision already made and never
 * called.
 *
 * ⚠️ Writes ONLY to the subcollection. Nothing here touches `pets/{petId}`.
 * That document is public-read while this tier is authenticated, and the photo
 * intake's estimated range on it (`weightKgMin`/`weightKgMax`) is a different
 * quantity that must never be mistaken for, or replaced by, a measurement.
 * Plan §2.7 proposed copying the latest weight onto `Pet`; that was reversed on
 * 2026-09-12 for exactly this reason.
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
} from 'firebase/firestore';
import type { User } from 'firebase/auth';

import { getFirebase } from './firebase-client';
import {
  measuredWeightKg,
  validateMeasurementDraft,
  type MeasurementDraft,
} from './measurements';
import type { MuscleCondition, PetMeasurement } from './types';

/**
 * The exact shape written to `pets/{petId}/measurements/{measurementId}`.
 *
 * ⚠️ Annotated for the same reason `PetDocumentWrite` and `MedicalRecordWrite`
 * exist: an untyped object literal lets a field added to `PetMeasurement`
 * produce a green typecheck and a document without it.
 */
type MeasurementWrite = Omit<PetMeasurement, 'id'>;

/** What a caller gets back — epoch ms, so the pure layer needs no Timestamp. */
export interface MeasurementView {
  id: string;
  weightKg: number | null;
  bcs: number | null;
  mcs: MuscleCondition | null;
  measuredAt: number;
  measuredBy: string | null;
  note: string | null;
  recordedBy: string;
}

function toMillis(value: unknown): number | null {
  if (value instanceof Timestamp) return value.toMillis();
  return null;
}

/** Every measurement for one pet, most recent first. */
export async function listMeasurements(petId: string): Promise<MeasurementView[]> {
  const { db } = getFirebase();
  const snap = await getDocs(
    query(collection(db, 'pets', petId, 'measurements'), orderBy('measuredAt', 'desc'))
  );

  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      weightKg: typeof data.weightKg === 'number' ? data.weightKg : null,
      bcs: typeof data.bcs === 'number' ? data.bcs : null,
      mcs: data.mcs ?? null,
      // A document without this is excluded by the orderBy anyway; 0 keeps
      // the type honest rather than pretending a date exists.
      measuredAt: toMillis(data.measuredAt) ?? 0,
      measuredBy: data.measuredBy ?? null,
      note: data.note ?? null,
      recordedBy: data.recordedBy ?? '',
    };
  });
}

function buildWrite(draft: MeasurementDraft, user: User): MeasurementWrite {
  // ⚠️ A real backstop, not only a type narrowing. Callers validate first, but
  // this number feeds an mg/kg dose, and a caller that forgot to validate must
  // not be able to store "12.500" or a weight of zero.
  const errors = validateMeasurementDraft(draft);
  if (errors.length > 0 || draft.measuredAt === null) {
    throw new Error(`measurements: invalid draft (${errors.join(', ')})`);
  }

  return {
    weightKg: measuredWeightKg(draft),
    bcs: draft.bcs,
    mcs: draft.mcs,
    measuredAt: Timestamp.fromMillis(draft.measuredAt),
    measuredBy: draft.measuredBy?.trim() || null,
    note: draft.note?.trim() || null,
    recordedBy: user.email ?? user.uid,
  };
}

export async function addMeasurement(
  petId: string,
  draft: MeasurementDraft,
  user: User
): Promise<string> {
  const { db } = getFirebase();
  const ref = await addDoc(
    collection(db, 'pets', petId, 'measurements'),
    buildWrite(draft, user)
  );
  return ref.id;
}

/**
 * Correct an existing reading.
 *
 * ⚠️ Deliberately does NOT touch `recordedBy`, for the reason
 * `updateMedicalRecord` gives: who first wrote a number down is history, and
 * overwriting it on every edit erases the only trace of it.
 */
export async function updateMeasurement(
  petId: string,
  measurementId: string,
  draft: MeasurementDraft,
  user: User
): Promise<void> {
  const { db } = getFirebase();
  const { recordedBy: _ignored, ...rest } = buildWrite(draft, user);
  await updateDoc(doc(db, 'pets', petId, 'measurements', measurementId), rest);
}

/** For the mistyped entry. The rules restrict it to admins. */
export async function deleteMeasurement(petId: string, measurementId: string): Promise<void> {
  const { db } = getFirebase();
  await deleteDoc(doc(db, 'pets', petId, 'measurements', measurementId));
}
