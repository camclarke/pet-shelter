/**
 * Online adoption applications — the APPLICANT's reads and writes, in the
 * browser, under `firestore.rules`.
 *
 * Nothing here is authorised by this file. The rules decide: an applicant
 * creates only `{petId}__{their uid}`, reads only their own, and may only
 * withdraw. A caller that gets this wrong gets `permission-denied`.
 *
 * ⚠️ No answer is ever logged. On failure the error is re-thrown for the page
 * to map to Spanish; nothing here writes a payload to the console, because the
 * payload is a stranger's housing and household.
 *
 * ⚠️ No user-facing words. See `src/i18n`.
 */

'use client';

import {
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';

import { getFirebase } from './firebase-client';
import {
  applicationIdFor,
  buildApplicationCreate,
  withdrawalPatch,
} from './applications';
import { resolveServerTime } from './server-time';
import type { ApplicationAnswer, ApplicationStatus, Pet } from './types';

/** An application as its applicant sees it — status and dates, never the notes. */
export interface MyApplication {
  id: string;
  petId: string;
  status: ApplicationStatus;
  submittedAt: number | null;
  updatedAt: number | null;
}

function millis(value: unknown): number | null {
  return value instanceof Timestamp ? value.toMillis() : null;
}

function toMine(id: string, data: Record<string, unknown>): MyApplication {
  return {
    id,
    petId: String(data.petId ?? ''),
    status: data.status as ApplicationStatus,
    submittedAt: millis(data.submittedAt),
    updatedAt: millis(data.updatedAt),
  };
}

/**
 * The signed-in user's application for one pet, or null if they have none.
 *
 * A single `get` by the deterministic id. The rules allow it on an id that does
 * not exist yet precisely so this can answer "have I already applied?" without
 * a query.
 */
export async function getMyApplication(petId: string, user: User): Promise<MyApplication | null> {
  const { db } = getFirebase();
  const snap = await getDoc(doc(db, 'adoptionApplications', applicationIdFor(petId, user.uid)));
  return snap.exists() ? toMine(snap.id, snap.data()) : null;
}

/**
 * Submit an application.
 *
 * `setDoc` without merge on the deterministic id: if the document is absent
 * this is a create; if the applicant already applied it is an UPDATE, which the
 * rules refuse. The duplicate guard is the database's, not this function's.
 *
 * ── Why the token is refreshed first ──────────────────────────────────────
 * The rules copy `email` and `email_verified` from the ID TOKEN, and require
 * the document to match. `user.emailVerified` can be newer than the cached
 * token — "Ya lo verifiqué" on /account reloads the user without reissuing the
 * token — so writing it would be refused for a person who did everything
 * right. Forcing a refresh and writing the claims the token actually carries
 * makes the two agree.
 */
export async function submitApplication(
  petId: string,
  user: User,
  answers: Record<string, ApplicationAnswer>,
): Promise<string> {
  const { db } = getFirebase();
  const token = await user.getIdTokenResult(true);
  const email = typeof token.claims.email === 'string' ? token.claims.email : user.email;
  if (!email) throw new Error('submitApplication: the account has no email address');

  const id = applicationIdFor(petId, user.uid);
  const write = buildApplicationCreate({
    petId,
    applicantUid: user.uid,
    applicantEmail: email,
    applicantEmailVerified: token.claims.email_verified === true,
    answers,
  });

  await setDoc(doc(db, 'adoptionApplications', id), resolveServerTime(write));
  return id;
}

/**
 * Every application the signed-in user has made, newest first.
 *
 * ⚠️ The `where` is not a filter here, it is a precondition: the list rule is
 * evaluated against the query's constraints, so an unconstrained query is
 * refused whole rather than narrowed. Sorted in the browser rather than with
 * `orderBy`, which would need a composite index for a list that is almost
 * always one or two rows long.
 */
export async function listMyApplications(user: User): Promise<MyApplication[]> {
  const { db } = getFirebase();
  const snap = await getDocs(
    query(collection(db, 'adoptionApplications'), where('applicantUid', '==', user.uid)),
  );
  return snap.docs
    .map((d) => toMine(d.id, d.data()))
    .sort((a, b) => (b.submittedAt ?? 0) - (a.submittedAt ?? 0));
}

/** The public teaser for each pet, so the list can show a name and a link. */
export async function getPublicPets(petIds: readonly string[]): Promise<Map<string, Pet>> {
  const { db } = getFirebase();
  const found = new Map<string, Pet>();
  await Promise.all(
    [...new Set(petIds)].filter(Boolean).map(async (id) => {
      const snap = await getDoc(doc(db, 'pets', id));
      if (snap.exists()) found.set(id, { id: snap.id, ...snap.data() } as Pet);
    }),
  );
  return found;
}

/** Withdraw an open application. Exactly the three keys the rule permits. */
export async function withdrawMyApplication(application: MyApplication): Promise<void> {
  const { db } = getFirebase();
  await updateDoc(
    doc(db, 'adoptionApplications', application.id),
    resolveServerTime({ ...withdrawalPatch(application.status) }),
  );
}
