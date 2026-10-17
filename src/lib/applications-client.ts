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
  GeoPoint,
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';

import { ADOPTION_CONTRACT } from '@/config/adoption-contract';
import { getFirebase } from './firebase-client';
import {
  applicationIdFor,
  buildApplicationCreate,
  buildHomeCreate,
  buildIdentityCreate,
  idDocumentBadge,
  isIdentityErased,
  requireAcceptance,
  requireContract,
  withdrawalPatch,
  type AcceptanceGiven,
  type IdDocumentMarker,
  type ValidHome,
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
  /**
   * Open, not erased, and a configured side of the ID photo has not arrived —
   * "Falta tu carnet" (portion 4c-2). Decided by `idDocumentBadge`, the same
   * predicate the admin queue's "Sin carnet" uses, so the two cannot disagree.
   */
  idDocumentMissing: boolean;
  /** `isIdentityErased(identityErasedAt)` — the one "erased" check. */
  identityErased: boolean;
}

function millis(value: unknown): number | null {
  return value instanceof Timestamp ? value.toMillis() : null;
}

function toMine(id: string, data: Record<string, unknown>): MyApplication {
  const status = data.status as ApplicationStatus;
  const identityErased = isIdentityErased(data.identityErasedAt);
  return {
    id,
    petId: String(data.petId ?? ''),
    status,
    submittedAt: millis(data.submittedAt),
    updatedAt: millis(data.updatedAt),
    idDocumentMissing:
      idDocumentBadge({ status, idDocument: data.idDocument as IdDocumentMarker | undefined, identityErased }) ===
      'missing',
    identityErased,
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

/** What one submission writes, already validated and split by store. */
export interface ApplicationSubmission {
  /** The `store: 'application'` answers — into the main document, kept for good. */
  answers: Record<string, ApplicationAnswer>;
  /**
   * The `store: 'identity'` answers — into the admin-only, erasable
   * `private/identity`. Required since the 4c-2 stepper; a JavaScript caller
   * that omits it anyway is still refused before the network.
   */
  identity: Record<string, ApplicationAnswer>;
  /** The address step → `private/home`. Required, like `identity`. */
  home: ValidHome;
  /**
   * The acceptance box, ticked under the contract version the screen showed
   * (the review step). Required, and checked again before the network.
   */
  acceptance: AcceptanceGiven;
}

/**
 * Submit an application: ONE `writeBatch` holding the application, its
 * `private/home` address document and its `private/identity` personal-details
 * document.
 *
 * One batch because the rules pair them: the application's create requires
 * both private documents to exist AFTER the batch, and each private create
 * requires the application NOT to exist before it and to exist after it. None
 * can be written alone, and neither an address nor a C.I. can ever be attached
 * to an application that was already sent.
 *
 * `set` without merge on the deterministic id: if the document is absent
 * this is a create; if the applicant already applied it is an UPDATE, which the
 * rules refuse — and the private documents' `!exists(parent)` fails with it, so
 * the whole batch is refused. The duplicate guard is the database's, not this
 * function's.
 *
 * ── Why it can throw before sending anything ──────────────────────────────
 * - `ContractUnavailableError` if `ADOPTION_CONTRACT` were null or malformed.
 * - When `home` or `identity` is missing or invalid. Both are required by the
 *   type since the step-by-step form (portion 4c-2) passes them; the runtime
 *   checks stay, so a caller that skipped the type is refused here rather than
 *   at the rules.
 * - `ContractNotAcceptedError` unless `acceptance` says the box was ticked for
 *   the contract version being recorded. Nothing records an acceptance the
 *   person did not give.
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
  submission: ApplicationSubmission,
): Promise<string> {
  const { db } = getFirebase();
  const { answers, identity, home, acceptance } = submission;
  // All checked before the network: none can be fixed by retrying.
  const contract = requireContract(ADOPTION_CONTRACT);
  if (!home) throw new Error('submitApplication: a home address is required');
  if (!identity) throw new Error('submitApplication: the personal details are required');
  requireAcceptance(acceptance, contract);
  const homeWrite = buildHomeCreate({ applicantUid: user.uid, home });
  const identityWrite = buildIdentityCreate({ applicantUid: user.uid, identity });

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
    contract,
    // Checked above; the builder checks it again, so it can never be skipped.
    acceptance,
  });

  const batch = writeBatch(db);
  batch.set(doc(db, 'adoptionApplications', id), resolveServerTime(write));
  batch.set(doc(db, 'adoptionApplications', id, 'private', 'home'), {
    ...resolveServerTime(homeWrite),
    // A rules `latlng` comes from a real GeoPoint. A plain {latitude, longitude}
    // object is stored as a map, which `geo is latlng` refuses.
    geo: homeWrite.geo ? new GeoPoint(homeWrite.geo.latitude, homeWrite.geo.longitude) : null,
  });
  batch.set(doc(db, 'adoptionApplications', id, 'private', 'identity'), resolveServerTime(identityWrite));
  await batch.commit();
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
