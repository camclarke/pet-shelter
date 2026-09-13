/**
 * Online adoption applications — the SHELTER's reads and writes, in the
 * browser, under `firestore.rules`.
 *
 * Same split as `areas-admin.ts`: straight to Firestore, with the rules as the
 * boundary and `AdminGate` as UX. Every decision is made in `applications.ts`,
 * which has no Firebase import and is tested; this file reads what those
 * decisions need and commits what they return.
 *
 * ── Which queries need which index ────────────────────────────────────────
 * None needs a composite index, on purpose, so this feature ships with no
 * `firestore.indexes.json` change:
 *
 *   adoptionApplications orderBy(submittedAt desc) limit N   single field, automatic
 *   adoptionApplications where(petId == x)                    single field, automatic
 *   pets/{id}/custody    where(endedAt == null)               single field, automatic
 *   pets/{id}/placements where(endedAt == null)               single field, automatic
 *
 * Status filtering and grouping by pet happen in the browser. Plan §8 proposed
 * a `(petId, status)` composite; at a shelter's volume — tens of applications,
 * not thousands — the index would buy nothing and cost a deploy that can fail
 * the whole file. Add it when the queue outgrows one page.
 *
 * ⚠️ No answer is ever logged. Errors are re-thrown; the page decides what to
 * say, and says it without the payload.
 */

'use client';

import {
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type DocumentData,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';

import { getFirebase } from './firebase-client';
import {
  adminStatusPatch,
  approvalCheck,
  buildApprovalWrites,
  type ApprovalCheck,
} from './applications';
import { applyWriteOps, resolveServerTime } from './server-time';
import type { AdoptionApplication, ApplicationAnswer, ApplicationStatus, Pet } from './types';

/** An application with its timestamps as epoch ms, for the pure layer and the UI. */
export interface ApplicationRecord
  extends Omit<AdoptionApplication, 'submittedAt' | 'updatedAt' | 'withdrawnAt' | 'decidedAt'> {
  submittedAt: number;
  updatedAt: number | null;
  withdrawnAt: number | null;
  decidedAt: number | null;
}

function millis(value: unknown): number | null {
  return value instanceof Timestamp ? value.toMillis() : null;
}

function toRecord(id: string, data: DocumentData): ApplicationRecord {
  return {
    id,
    petId: String(data.petId ?? ''),
    applicantUid: String(data.applicantUid ?? ''),
    applicantEmail: String(data.applicantEmail ?? ''),
    applicantEmailVerified: data.applicantEmailVerified === true,
    answers: (data.answers ?? {}) as Record<string, ApplicationAnswer>,
    status: data.status as ApplicationStatus,
    // A document whose submittedAt has not resolved is a local echo; the queue
    // only ever reads server data, so 0 here would only sort it first.
    submittedAt: millis(data.submittedAt) ?? 0,
    updatedAt: millis(data.updatedAt),
    withdrawnAt: millis(data.withdrawnAt),
    decidedAt: millis(data.decidedAt),
    decidedBy: typeof data.decidedBy === 'string' ? data.decidedBy : null,
  };
}

/** The most recent applications across every pet. */
export async function listApplications(max = 200): Promise<ApplicationRecord[]> {
  const { db } = getFirebase();
  const snap = await getDocs(
    query(collection(db, 'adoptionApplications'), orderBy('submittedAt', 'desc'), limit(max)),
  );
  return snap.docs.map((d) => toRecord(d.id, d.data()));
}

export async function getApplication(id: string): Promise<ApplicationRecord | null> {
  const { db } = getFirebase();
  const snap = await getDoc(doc(db, 'adoptionApplications', id));
  return snap.exists() ? toRecord(snap.id, snap.data()) : null;
}

/** Every application for one animal, any status. */
export async function listApplicationsForPet(petId: string): Promise<ApplicationRecord[]> {
  const { db } = getFirebase();
  const snap = await getDocs(
    query(collection(db, 'adoptionApplications'), where('petId', '==', petId)),
  );
  return snap.docs.map((d) => toRecord(d.id, d.data()));
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal notes — a separate, admin-only document
// ─────────────────────────────────────────────────────────────────────────────

export interface InternalNotesView {
  text: string;
  updatedAt: number | null;
  updatedBy: string | null;
}

export async function getInternalNotes(applicationId: string): Promise<InternalNotesView | null> {
  const { db } = getFirebase();
  const snap = await getDoc(doc(db, 'adoptionApplications', applicationId, 'internal', 'notes'));
  if (!snap.exists()) return null;
  const data = snap.data();
  return {
    text: typeof data.text === 'string' ? data.text : '',
    updatedAt: millis(data.updatedAt),
    updatedBy: typeof data.updatedBy === 'string' ? data.updatedBy : null,
  };
}

/** Replace the notes. The rules allow exactly these three keys. */
export async function saveInternalNotes(applicationId: string, text: string, user: User): Promise<void> {
  const { db } = getFirebase();
  await setDoc(doc(db, 'adoptionApplications', applicationId, 'internal', 'notes'), {
    text: text.slice(0, 5000),
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Status changes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Any status change EXCEPT approval, which is never a status change alone —
 * see `approveApplication`. Throws on an illegal transition before anything is
 * sent, via `adminStatusPatch`.
 */
export async function moveApplication(
  application: Pick<ApplicationRecord, 'id' | 'status'>,
  to: Exclude<ApplicationStatus, 'approved'>,
  user: User,
): Promise<void> {
  const { db } = getFirebase();
  await updateDoc(
    doc(db, 'adoptionApplications', application.id),
    resolveServerTime({ ...adminStatusPatch(application.status, to, user.uid) }),
  );
}

export interface ApprovalPreview {
  check: ApprovalCheck;
  pet: Pet | null;
  /** Every other application for the same pet, any status. */
  others: ApplicationRecord[];
}

/** Whether the pet has a `location/current` — which approving hands to the new owner. */
async function hasRecordedLocation(petId: string): Promise<boolean> {
  const { db } = getFirebase();
  return (await getDoc(doc(db, 'pets', petId, 'location', 'current'))).exists();
}

async function readPet(petId: string): Promise<Pet | null> {
  const { db } = getFirebase();
  const snap = await getDoc(doc(db, 'pets', petId));
  return snap.exists() ? ({ id: snap.id, ...snap.data() } as Pet) : null;
}

/** What the approval screen shows before anyone confirms. */
export async function previewApproval(application: ApplicationRecord): Promise<ApprovalPreview> {
  const [pet, forPet, located] = await Promise.all([
    readPet(application.petId),
    listApplicationsForPet(application.petId),
    hasRecordedLocation(application.petId),
  ]);
  const others = forPet.filter((other) => other.id !== application.id);
  return {
    pet,
    others,
    check: approvalCheck({
      application,
      pet: pet ? { id: pet.id, status: pet.status } : null,
      otherApplications: others,
      hasRecordedLocation: located,
    }),
  };
}

/**
 * Approve: ONE `writeBatch`, assembled by `buildApprovalWrites`.
 *
 * Everything the builder needs is RE-READ here, at the moment of confirming,
 * rather than trusted from the preview the admin looked at — a preview can be
 * minutes old, and in those minutes another admin can have approved someone
 * else. The builder then throws on any blocker, so a stale screen cannot commit.
 *
 * The rules are the last line: they refuse the application update unless the
 * same batch writes `adoptions/{petId}` for this applicant and the pet status,
 * and unless the pet was not already adopted before the batch.
 *
 * ── The residual race, stated precisely ───────────────────────────────────
 * The custody and placement ids to close come from QUERIES read just before
 * the batch, and a client-SDK transaction cannot read a query — only documents
 * by reference — so a transaction would not close this window without
 * restructuring how open intervals are found. What the window can do, if
 * another admin action touches the same pet between the reads and the commit:
 *   - a custody or placement opened in the window is NOT closed, and stays open
 *     until the next move or release on that pet;
 *   - one closed in the window has its `endedAt` re-stamped with this commit's
 *     time, seconds later than the real close.
 * What it cannot do is approve two families for one animal: the rules check the
 * pet's status BEFORE the batch, so the second approval is refused.
 */
export async function approveApplication(
  application: ApplicationRecord,
  holder: string,
  user: User,
): Promise<void> {
  const { db } = getFirebase();
  const petRef = doc(db, 'pets', application.petId);

  const [current, pet, forPet, located, openCustody, openPlacements] = await Promise.all([
    getApplication(application.id),
    readPet(application.petId),
    listApplicationsForPet(application.petId),
    hasRecordedLocation(application.petId),
    getDocs(query(collection(petRef, 'custody'), where('endedAt', '==', null))),
    getDocs(query(collection(petRef, 'placements'), where('endedAt', '==', null))),
  ]);
  if (!current) throw new Error('approveApplication: the application no longer exists');

  const writes = buildApprovalWrites({
    application: current,
    pet: pet ? { id: pet.id, status: pet.status } : null,
    otherApplications: forPet.filter((other) => other.id !== current.id),
    hasRecordedLocation: located,
    adminUid: user.uid,
    holder,
    newCustodyId: doc(collection(petRef, 'custody')).id,
    openCustodyIds: openCustody.docs.map((d) => d.id),
    openPlacementIds: openPlacements.docs.map((d) => d.id),
  });

  const batch = writeBatch(db);
  applyWriteOps(db, batch, writes);
  await batch.commit();
}
