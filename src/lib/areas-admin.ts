/**
 * Areas and placements — admin reads and writes, Client Components only.
 *
 * Same reasoning as `pets-admin.ts`: this goes straight to Firestore from the
 * browser and `firestore.rules` does the authorization, which is free. Routing
 * it through a Server Action would use the Admin SDK, which bypasses rules
 * entirely and would leave the rules protecting a path nothing uses.
 *
 * The rules for both collections were already written and are already
 * deployed — `match /areas/{areaId} { allow read, write: if isAdmin(); }` and
 * the admin-only `collectionGroup('placements')` read. No rules change was
 * needed for this feature; the decision was made in advance and simply had no
 * caller until now. Same as the `identity` collection group before the
 * re-admission path used it.
 *
 * ── Which queries are backed by which index ───────────────────────────────
 * Both collection-group queries here match a COMPOSITE index that is declared
 * in `firestore.indexes.json` AND deployed (verified READY, 2026-08-24):
 *
 *   placements(areaId, endedAt)   → occupancy: who is in this pen right now
 *   placements(areaId, startedAt) → the outbreak trace's per-area fetch
 *
 * ⚠️ Occupancy is deliberately fetched ONE AREA AT A TIME rather than with a
 * single `where('endedAt','==',null)` sweep across every area. That sweep
 * would be a collection-group query on a SINGLE field, which is a
 * `fieldOverrides` entry rather than a composite index — the exact shape that
 * broke the microchip lookup on 2026-08-12, and adding one gets the whole
 * index file rejected if it turns out to be unnecessary. Six pens is six
 * cheap queries; do not "optimise" this into a new index.
 *
 * ⚠️ No user-facing words here. Failures are thrown and the components map
 * them through `src/i18n`.
 */

'use client';

import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
  type DocumentData,
  type QueryDocumentSnapshot,
  type Timestamp,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';

import { getFirebase } from './firebase-client';
import { statusAfterPlacement, sortAreas, type AreaDraft } from './areas';
import {
  CLOCK_SKEW_TOLERANCE_MS,
  exposureWindow,
  traceContacts,
  type ContactTrace,
  type ExposureWindow,
  type Pathogen,
  type PlacementInterval,
} from './placements';
import type { Area, Pet, Placement, PlacementReason } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Areas
// ─────────────────────────────────────────────────────────────────────────────

function areaFromDoc(snap: QueryDocumentSnapshot<DocumentData>): Area {
  const data = snap.data();
  return {
    id: snap.id,
    name: data.name,
    kind: data.kind,
    capacity: data.capacity ?? null,
    active: data.active ?? true,
    notes: data.notes ?? null,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  };
}

/** Every area, inactive ones included, in the order a picker should show them. */
export async function listAreas(): Promise<Area[]> {
  const { db } = getFirebase();
  const snap = await getDocs(collection(db, 'areas'));
  return sortAreas(snap.docs.map(areaFromDoc));
}

/**
 * Create or update an area.
 *
 * `id` null creates. Returns the id either way so the caller can keep
 * referring to what it just wrote.
 *
 * ⚠️ There is deliberately no `deleteArea`. An area with placement history is
 * referenced by `areaId` in every one of those records, and deleting it would
 * leave the outbreak trace filtering on an id that resolves to nothing — the
 * trace would still run, still return rows, and the UI would have no name to
 * show for the pen they were in. `active: false` removes it from every picker
 * while keeping history readable, which is what "we closed that pen" actually
 * means.
 */
export async function saveArea(id: string | null, draft: AreaDraft): Promise<string> {
  const { db } = getFirebase();
  const ref = id ? doc(db, 'areas', id) : doc(collection(db, 'areas'));

  await setDoc(
    ref,
    {
      name: draft.name.trim(),
      kind: draft.kind,
      capacity: draft.capacity,
      active: draft.active,
      notes: draft.notes.trim() || null,
      // Merged, so an update does not reset the creation time. `createdAt`
      // only appears on the create path.
      ...(id ? {} : { createdAt: serverTimestamp() }),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  return ref.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Placements — reads
// ─────────────────────────────────────────────────────────────────────────────

function toMillis(value: Timestamp | null | undefined): number | null {
  return value ? value.toMillis() : null;
}

/**
 * Placements live at `pets/{petId}/placements/{id}`, so the animal's identity
 * is in the path rather than in the document. Reading it from the path is what
 * keeps a denormalised `petId` field from drifting out of agreement with it —
 * same conversion `placements-server.ts` does on the server.
 *
 * A document whose `startedAt` has not resolved yet (the local echo of a write
 * still in flight) has no place in an interval calculation, so it is dropped
 * rather than treated as epoch zero — which would read as an animal that has
 * been in the pen since 1970 and overlap with absolutely everything.
 */
function intervalFromDoc(snap: QueryDocumentSnapshot<DocumentData>): PlacementInterval | null {
  const petId = snap.ref.parent.parent?.id;
  if (!petId) return null;

  const data = snap.data();
  const startedAt = toMillis(data.startedAt as Timestamp | null);
  if (startedAt === null) return null;

  return {
    petId,
    areaId: data.areaId as string,
    areaName: data.areaName as string,
    startedAt,
    endedAt: toMillis(data.endedAt as Timestamp | null),
  };
}

/** Who is in one area right now. Uses placements(areaId, endedAt). */
export async function getAreaOccupancy(areaId: string): Promise<PlacementInterval[]> {
  const { db } = getFirebase();
  const snap = await getDocs(
    query(
      collectionGroup(db, 'placements'),
      where('areaId', '==', areaId),
      where('endedAt', '==', null),
    ),
  );
  return snap.docs.map(intervalFromDoc).filter((p): p is PlacementInterval => p !== null);
}

/** Occupancy for several areas at once, flattened. One query per area — see the header. */
export async function getOccupancyForAreas(areaIds: readonly string[]): Promise<PlacementInterval[]> {
  const perArea = await Promise.all(areaIds.map(getAreaOccupancy));
  return perArea.flat();
}

/** One animal's full movement history, oldest first. */
export async function getPetPlacements(petId: string): Promise<PlacementInterval[]> {
  const { db } = getFirebase();
  const snap = await getDocs(
    query(collection(doc(db, 'pets', petId), 'placements'), orderBy('startedAt', 'asc')),
  );
  return snap.docs.map(intervalFromDoc).filter((p): p is PlacementInterval => p !== null);
}

/** The same history with the fields the timeline renders — reason, who moved it, the note. */
export interface PlacementRecord extends PlacementInterval {
  id: string;
  reason: PlacementReason;
  movedBy: string;
  note: string | null;
}

export async function getPetPlacementRecords(petId: string): Promise<PlacementRecord[]> {
  const { db } = getFirebase();
  const snap = await getDocs(
    query(collection(doc(db, 'pets', petId), 'placements'), orderBy('startedAt', 'desc')),
  );

  return snap.docs
    .map((d) => {
      const interval = intervalFromDoc(d);
      if (!interval) return null;
      const data = d.data() as Partial<Placement>;
      return {
        ...interval,
        id: d.id,
        reason: (data.reason ?? 'transfer') as PlacementReason,
        movedBy: data.movedBy ?? '',
        note: data.note ?? null,
      };
    })
    .filter((r): r is PlacementRecord => r !== null);
}

/** The animal's open placement, or null when it is not in any area. */
export function openPlacement(records: readonly PlacementRecord[]): PlacementRecord | null {
  return records.find((r) => r.endedAt === null) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Placements — writes
// ─────────────────────────────────────────────────────────────────────────────

export interface MoveInput {
  pet: Pick<Pet, 'id' | 'status'>;
  area: Pick<Area, 'id' | 'name'>;
  reason: PlacementReason;
  note: string;
}

export interface MoveResult {
  placementId: string;
  /** The status the pet now holds — unchanged unless the move implied one. */
  status: Pet['status'];
}

/**
 * Move an animal into an area: close whatever is open, open the new one, and
 * apply any status change the move implies.
 *
 * ── Why closing and opening share one timestamp ───────────────────────────
 * Both are `serverTimestamp()` inside one batch, so the old interval ends at
 * the same instant the new one begins. That makes them TOUCH, and
 * `intervalsOverlap` treats touching as overlapping — deliberately. One animal
 * leaving a pen as another arrives is a real exposure route, because
 * parvovirus survives on surfaces for months. The alternative, ending the old
 * interval a millisecond early, would encode "they never actually met" as
 * though it meant "no exposure."
 *
 * ── Why it reads before it writes ─────────────────────────────────────────
 * An animal with two open placements is in two pens at once, and every
 * occupancy figure and every trace derived from that is wrong in a way nothing
 * surfaces. So every open placement is closed, not just the most recent one:
 * if a previous bug ever left two, this repairs it rather than adding a third.
 *
 * One `writeBatch`, so a half-applied move is not a state that exists.
 */
export async function movePet(input: MoveInput, user: User): Promise<MoveResult> {
  const { db } = getFirebase();
  const petRef = doc(db, 'pets', input.pet.id);

  const open = await getDocs(
    query(collection(petRef, 'placements'), where('endedAt', '==', null)),
  );

  const batch = writeBatch(db);
  open.docs.forEach((d) => batch.update(d.ref, { endedAt: serverTimestamp() }));

  const placementRef = doc(collection(petRef, 'placements'));
  batch.set(placementRef, {
    areaId: input.area.id,
    // Snapshotted on purpose: areas get renamed, and an outbreak investigation
    // must not silently shift underneath the person reading it.
    areaName: input.area.name,
    startedAt: serverTimestamp(),
    endedAt: null,
    reason: input.reason,
    movedBy: user.uid,
    note: input.note.trim() || null,
  });

  const status = statusAfterPlacement(input.pet.status, input.reason);
  if (status !== input.pet.status) {
    batch.set(petRef, { status, updatedAt: serverTimestamp() }, { merge: true });
  }

  await batch.commit();
  return { placementId: placementRef.id, status };
}

/**
 * Record that the animal has left the facility — adopted, fostered, or
 * transferred out. Closes every open placement and opens none.
 *
 * A foster home is NOT an area, which is why this exists as its own operation
 * rather than a move into a "foster" pen. Placements describe positions inside
 * the shelter's own building; an animal in a hogar de tránsito has custody and
 * possibly a location and no open placement. Keeping that boundary is what
 * stops a volunteer's home address from ever reaching an operational area list.
 */
export async function releasePet(petId: string): Promise<number> {
  const { db } = getFirebase();
  const petRef = doc(db, 'pets', petId);

  const open = await getDocs(
    query(collection(petRef, 'placements'), where('endedAt', '==', null)),
  );
  if (open.empty) return 0;

  const batch = writeBatch(db);
  open.docs.forEach((d) => batch.update(d.ref, { endedAt: serverTimestamp() }));
  await batch.commit();
  return open.size;
}

// ─────────────────────────────────────────────────────────────────────────────
// The outbreak trace
// ─────────────────────────────────────────────────────────────────────────────

export interface OutbreakTrace {
  window: ExposureWindow;
  areaIds: string[];
  contacts: ContactTrace[];
  /**
   * True when this animal has NO placement record at all.
   *
   * The load-bearing field. An empty `contacts` array means either "it was
   * genuinely alone" or "nobody recorded where it was", and those are opposite
   * facts that look identical. A UI that renders both as "no contacts" is the
   * silent failure this whole subsystem is arranged to prevent, so the
   * distinction is returned as data rather than left to be inferred.
   */
  noPlacementData: boolean;
}

/**
 * The browser-side twin of `traceOutbreak` in `placements-server.ts`.
 *
 * Both exist on purpose. The server one is available to a Server Component
 * through the Admin SDK; this one runs under `firestore.rules`, which restrict
 * the `placements` collection group to admins — so the authorization is
 * enforced rather than reimplemented. Neither contains any of the arithmetic:
 * both hand their documents to the same pure functions in `placements.ts`,
 * which is what makes a silent empty result attributable to the data or the
 * index rather than to the logic.
 */
export async function traceOutbreak(
  petId: string,
  pathogen: Pathogen,
  diagnosedAt: Date,
  now: Date = new Date(),
): Promise<OutbreakTrace> {
  const { db } = getFirebase();
  // `now` is nudged forward by the skew tolerance because every `startedAt`
  // being compared against it was stamped by Firestore's clock, not this one.
  // See CLOCK_SKEW_TOLERANCE_MS — without this a trace run minutes after an
  // arrival returns zero contacts and presents it as an answer.
  const window = exposureWindow(
    diagnosedAt.getTime(),
    pathogen,
    now.getTime() + CLOCK_SKEW_TOLERANCE_MS,
  );

  const subject = await getPetPlacements(petId);
  const inWindow = subject.filter(
    (p) => p.startedAt <= window.end && (p.endedAt ?? Infinity) >= window.start,
  );

  const areaIds = [...new Set(inWindow.map((p) => p.areaId))];

  // One query per AREA, not per placement — an animal moved out of a pen and
  // back again must not have that pen fetched twice.
  const perArea = await Promise.all(
    areaIds.map(async (areaId) => {
      const snap = await getDocs(
        query(
          collectionGroup(db, 'placements'),
          where('areaId', '==', areaId),
          where('startedAt', '<=', new Date(window.end)),
        ),
      );
      return snap.docs.map(intervalFromDoc).filter((p): p is PlacementInterval => p !== null);
    }),
  );

  return {
    window,
    areaIds,
    contacts: traceContacts(inWindow, perArea.flat(), window),
    noPlacementData: subject.length === 0,
  };
}

/** One animal's public document, for the admin screens that open it by id. */
export async function getPetById(petId: string): Promise<Pet | null> {
  const { db } = getFirebase();
  const snap = await getDoc(doc(db, 'pets', petId));
  return snap.exists() ? ({ id: snap.id, ...snap.data() } as Pet) : null;
}

/**
 * Human labels for the uids in `movedBy`.
 *
 * Attribution is the reason `movedBy` exists at all — "nobody remembers who
 * moved it" is how an outbreak investigation stalls — and a raw uid is not
 * attribution to anyone reading the timeline. `users/{uid}` is admin-readable
 * by rule, and a missing document is normal rather than an error: the profile
 * is written on first sign-in and an account that predates it has none.
 */
export async function getUserLabels(uids: readonly string[]): Promise<Map<string, string>> {
  const { db } = getFirebase();
  const labels = new Map<string, string>();

  await Promise.all(
    [...new Set(uids)].filter(Boolean).map(async (uid) => {
      try {
        const snap = await getDoc(doc(db, 'users', uid));
        if (!snap.exists()) return;
        const data = snap.data();
        const label = data.displayName || data.email;
        if (label) labels.set(uid, label as string);
      } catch (error) {
        // A label is a nicety; the timeline must render without it.
        console.error('[areas-admin] could not read a user label', error);
      }
    }),
  );

  return labels;
}

/** The public documents for a set of traced animals, so the list can show names. */
export async function getPetsByIds(ids: readonly string[]): Promise<Map<string, Pet>> {
  const { db } = getFirebase();
  const found = new Map<string, Pet>();

  await Promise.all(
    ids.map(async (id) => {
      const snap = await getDoc(doc(db, 'pets', id));
      if (snap.exists()) found.set(id, { id: snap.id, ...snap.data() } as Pet);
    }),
  );

  return found;
}
