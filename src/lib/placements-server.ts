/**
 * Server-only placement reads: the fetch half of the outbreak trace.
 *
 * The decision logic deliberately does NOT live here — it lives in
 * `placements.ts` as pure functions over epoch milliseconds, tested against
 * known data with no database involved. This file's only job is to turn
 * Firestore documents into those plain intervals.
 *
 * That split exists because of a specific failure mode. A collection-group
 * query against a missing index returns nothing, and "nothing" from an
 * outbreak trace reads as "no animals were exposed" — a reassuring answer
 * produced by a broken query. Keeping the arithmetic testable offline means a
 * silent empty result can be attributed: if the unit tests pass and this
 * returns nothing, suspect the index or the data, not the logic.
 *
 * Admin SDK, so firestore.rules is bypassed. Never import this from a Client
 * Component, and never call it from a public page — an area list plus a
 * placement ledger is a map of the shelter's facility.
 */

import 'server-only';
import { getAdminDb } from './firebase-admin';
import {
  CLOCK_SKEW_TOLERANCE_MS,
  exposureWindow,
  traceContacts,
  type ContactTrace,
  type ExposureWindow,
  type Pathogen,
  type PlacementInterval,
} from './placements';
import type { Timestamp } from 'firebase-admin/firestore';

/**
 * Firestore documents carry Timestamps; the pure layer wants numbers. One
 * conversion point, here, so a millisecond/second mix-up has exactly one place
 * to hide.
 */
function toMillis(value: Timestamp | null | undefined): number | null {
  return value ? value.toMillis() : null;
}

/**
 * Placements live at pets/{petId}/placements/{id}, so the animal's identity is
 * in the path rather than the document. Reading it from the path avoids
 * denormalising a `petId` field that could drift out of agreement with it.
 */
function intervalFromDoc(
  doc: FirebaseFirestore.QueryDocumentSnapshot,
): PlacementInterval | null {
  const petId = doc.ref.parent.parent?.id;
  if (!petId) return null;

  const data = doc.data();
  const startedAt = toMillis(data.startedAt as Timestamp);
  if (startedAt === null) return null;

  return {
    petId,
    areaId: data.areaId as string,
    areaName: data.areaName as string,
    startedAt,
    endedAt: toMillis(data.endedAt as Timestamp | null),
  };
}

/** One animal's full movement history, oldest first. */
export async function getPetPlacements(petId: string): Promise<PlacementInterval[]> {
  const db = getAdminDb();
  const snap = await db
    .collection('pets')
    .doc(petId)
    .collection('placements')
    .orderBy('startedAt', 'asc')
    .get();

  return snap.docs.map(intervalFromDoc).filter((p): p is PlacementInterval => p !== null);
}

/**
 * Every placement in one area that began on or before `windowEnd`.
 *
 * The `endedAt >= windowStart` half is applied in memory, not in the query.
 * Firestore's range-filter constraints make interval overlap awkward to
 * express, and at forty animals over six weeks this is a few hundred
 * documents. Fetch by area, filter in memory, and revisit only if a shelter
 * with 400 animals ever forks this.
 *
 * Requires the COLLECTION_GROUP index on placements(areaId, startedAt).
 */
export async function getAreaPlacements(
  areaId: string,
  windowEnd: Date,
): Promise<PlacementInterval[]> {
  const db = getAdminDb();
  const snap = await db
    .collectionGroup('placements')
    .where('areaId', '==', areaId)
    .where('startedAt', '<=', windowEnd)
    .get();

  return snap.docs.map(intervalFromDoc).filter((p): p is PlacementInterval => p !== null);
}

/** Who is in an area right now. Requires the placements(areaId, endedAt) index. */
export async function getAreaOccupancy(areaId: string): Promise<string[]> {
  const db = getAdminDb();
  const snap = await db
    .collectionGroup('placements')
    .where('areaId', '==', areaId)
    .where('endedAt', '==', null)
    .get();

  const petIds = snap.docs
    .map((d) => d.ref.parent.parent?.id)
    .filter((id): id is string => id !== undefined);

  return [...new Set(petIds)];
}

export interface OutbreakTrace {
  window: ExposureWindow;
  /** Areas the sick animal occupied during the window. */
  areaIds: string[];
  contacts: ContactTrace[];
  /**
   * True when the animal has NO placement record covering the window. The
   * caller must distinguish this from "no contacts found" — they look
   * identical in an empty contact list and mean opposite things.
   */
  noPlacementData: boolean;
}

/**
 * Given a sick animal, everyone it shared an area with inside the pathogen's
 * incubation window.
 *
 * `noPlacementData` is the load-bearing field. An empty `contacts` array is
 * ambiguous on its own — it means either "this animal was genuinely alone" or
 * "nobody recorded where it was." A UI that renders both as "no contacts" is
 * the silent-failure mode this whole module is arranged to prevent, so the
 * distinction is returned as data rather than left to be inferred.
 */
export async function traceOutbreak(
  petId: string,
  pathogen: Pathogen,
  diagnosedAt: Date,
  now: Date = new Date(),
): Promise<OutbreakTrace> {
  // Nudged forward by the skew tolerance — the same reason as the browser
  // twin in `areas-admin.ts`. A Cloud Run instance's clock is far closer to
  // Firestore's than a phone's, but "closer" is not "identical", and the
  // failure it prevents is a trace that silently reports no contacts.
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

  // One query per area rather than one per placement — an animal moved in and
  // out of the same pen twice must not be fetched twice.
  const perArea = await Promise.all(
    areaIds.map((areaId) => getAreaPlacements(areaId, new Date(window.end))),
  );

  const contacts = traceContacts(inWindow, perArea.flat(), window);

  return {
    window,
    areaIds,
    contacts,
    noPlacementData: subject.length === 0,
  };
}
