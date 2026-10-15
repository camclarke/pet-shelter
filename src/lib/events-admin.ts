/**
 * Events — admin reads and writes, Client Components only.
 *
 * Same reasoning as `areas-admin.ts`: this goes straight to Firestore from the
 * browser and the `events/{eventId}` block of `firestore.rules` does the
 * authorization. There is no API route, so there is no `requireAdmin` here; if
 * one is ever added (an image upload, say), it must call `requireAdmin` before
 * reading the body — the guard test over `src/app/api/**` enforces that.
 *
 * ⚠️ Those rules are NOT DEPLOYED on the branch that adds this file. Until a
 * human runs the Firestore rules deploy, every call here fails with
 * `permission-denied` from the default-deny. Nothing is broken; the
 * collection's rules simply have not shipped.
 *
 * ── The writes the rules accept, and only those ───────────────────────────
 *  - create: every key, `published: false`, `createdAt == updatedAt ==
 *    request.time`, `createdBy == updatedBy == the caller's uid`;
 *  - update: the merged document is re-validated whole, `updatedAt` must be
 *    the server's clock and `updatedBy` the caller, and `createdAt` /
 *    `createdBy` must not move;
 *  - delete: only while unpublished.
 *
 * Index: the admin list is `orderBy('startsAt', 'desc')` with no filter, a
 * single-field ordering Firestore indexes automatically. It must NOT be
 * declared in `firestore.indexes.json` (that file is rejected whole when it
 * declares an unnecessary index).
 *
 * ⚠️ No user-facing words here. Failures are thrown and the screen maps them
 * through `src/i18n`.
 */

'use client';

import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  type FieldValue,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';

import { getFirebase } from './firebase-client';
import {
  canDeleteEvent,
  eventIdBase,
  eventIdCandidate,
  isValidEventId,
  type EventFields,
  type EventView,
} from './events';
import type { EventStatus, ShelterEvent } from './types';

/**
 * The admin list shows at most this many, newest start first. Deliberately not
 * paginated: a shelter holds a handful of events a year, so 100 is years of
 * them. Past that, the OLDEST starts silently drop off this screen (they stay
 * in Firestore and on their public pages) — add paging then, not before.
 */
const LIST_LIMIT = 100;

/** How many `-2`, `-3`… to try before giving up on a free id. */
const MAX_ID_ATTEMPTS = 20;

/**
 * The exact document a create writes, typed against `ShelterEvent` so a field
 * added to the interface fails the build here rather than producing a
 * document the rules' `hasAll` would refuse.
 */
type EventCreateWrite = Omit<ShelterEvent, 'id' | 'startsAt' | 'endsAt' | 'createdAt' | 'updatedAt'> & {
  startsAt: Timestamp;
  endsAt: Timestamp;
  createdAt: FieldValue;
  updatedAt: FieldValue;
};

/** The thrown error when no free id is left — the screen names it. */
export class EventIdExhaustedError extends Error {
  constructor() {
    super('events-admin: no free id for this title and date');
    this.name = 'EventIdExhaustedError';
  }
}

function millis(value: unknown): number | null {
  return value instanceof Timestamp ? value.toMillis() : null;
}

function toView(id: string, data: Record<string, unknown>): EventView {
  return {
    id,
    title: typeof data.title === 'string' ? data.title : '',
    description: typeof data.description === 'string' ? data.description : '',
    startsAt: millis(data.startsAt) ?? 0,
    endsAt: millis(data.endsAt) ?? 0,
    allDay: data.allDay === true,
    placeName: typeof data.placeName === 'string' ? data.placeName : '',
    address: typeof data.address === 'string' ? data.address : null,
    status: data.status === 'cancelled' ? 'cancelled' : 'scheduled',
    // Fail closed: anything that is not an explicit true is shown as a draft.
    published: data.published === true,
    createdAt: millis(data.createdAt),
    updatedAt: millis(data.updatedAt),
    createdBy: typeof data.createdBy === 'string' ? data.createdBy : '',
    updatedBy: typeof data.updatedBy === 'string' ? data.updatedBy : '',
  };
}

/** Every event, drafts included. Admin-only by rule. */
export async function listEvents(): Promise<EventView[]> {
  const { db } = getFirebase();
  const snap = await getDocs(
    query(collection(db, 'events'), orderBy('startsAt', 'desc'), limit(LIST_LIMIT)),
  );
  return snap.docs.map((d) => toView(d.id, d.data()));
}

/**
 * Create a draft. Returns the id it was saved under.
 *
 * ── Why a transaction, not `setDoc` ───────────────────────────────────────
 * The id is derived (`<slug>-YYYY-MM-DD`), so two events with the same title
 * on the same day collide. A plain `setDoc` on an existing id is evaluated by
 * the rules as an UPDATE of the other event, which they refuse — the write
 * carries a fresh `createdAt`, and an update may not move it — so the second
 * admin would get a permission error instead of a saved event. So the
 * transaction reads each candidate first and takes the first free one: the
 * base, then `-2`, `-3`… Reading a missing doc is allowed for an admin
 * because `isAdmin()` alone satisfies the read rule (an empty snapshot comes
 * back, not an error).
 *
 * ⚠️ All reads before all writes: a Firestore client transaction that reads
 * after writing throws.
 */
export async function createEvent(fields: EventFields, timeZone: string, user: User): Promise<string> {
  const { db } = getFirebase();
  const base = eventIdBase(fields.title, fields.startsAt, timeZone);

  return runTransaction(db, async (tx) => {
    for (let attempt = 1; attempt <= MAX_ID_ATTEMPTS; attempt++) {
      const id = eventIdCandidate(base, attempt);
      if (!isValidEventId(id)) break;
      const ref = doc(db, 'events', id);
      const existing = await tx.get(ref);
      if (existing.exists()) continue;

      const write: EventCreateWrite = {
        title: fields.title,
        description: fields.description,
        startsAt: Timestamp.fromDate(fields.startsAt),
        endsAt: Timestamp.fromDate(fields.endsAt),
        allDay: fields.allDay,
        placeName: fields.placeName,
        address: fields.address,
        status: 'scheduled',
        published: false,
        createdAt: serverTimestamp(),
        createdBy: user.uid,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid,
      };
      tx.set(ref, write);
      return id;
    }
    throw new EventIdExhaustedError();
  });
}

/**
 * Save the editor's fields onto an existing event. The id does NOT change,
 * even when the title or the date does — it is the public URL, and links
 * already shared must keep working.
 */
export async function updateEvent(id: string, fields: EventFields, user: User): Promise<void> {
  const { db } = getFirebase();
  await updateDoc(doc(db, 'events', id), {
    title: fields.title,
    description: fields.description,
    startsAt: Timestamp.fromDate(fields.startsAt),
    endsAt: Timestamp.fromDate(fields.endsAt),
    allDay: fields.allDay,
    placeName: fields.placeName,
    address: fields.address,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
  });
}

/**
 * Publish or hide. Its own action, never part of a save: a mistaken publish
 * lingers in the CDN for minutes even after it is hidden again.
 */
export async function setEventPublished(id: string, published: boolean, user: User): Promise<void> {
  const { db } = getFirebase();
  await updateDoc(doc(db, 'events', id), {
    published,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
  });
}

/** Cancel or reactivate. A cancelled event keeps its page, so shared links stay honest. */
export async function setEventStatus(id: string, status: EventStatus, user: User): Promise<void> {
  const { db } = getFirebase();
  await updateDoc(doc(db, 'events', id), {
    status,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
  });
}

/**
 * Delete a draft. Refused here for a published event as well as by the rules,
 * so the screen gets a clear error instead of a permission failure.
 */
export async function deleteEvent(event: Pick<EventView, 'id' | 'published'>): Promise<void> {
  if (!canDeleteEvent(event)) throw new Error('events-admin: hide the event before deleting it');
  const { db } = getFirebase();
  await deleteDoc(doc(db, 'events', event.id));
}
