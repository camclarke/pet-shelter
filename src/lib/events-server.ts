/**
 * Server-only reads of `events/{eventId}`, via the Admin SDK — for /events,
 * /events/[slug], the homepage card and the sitemap.
 *
 * ⚠️ The Admin SDK BYPASSES `firestore.rules`. The rules' "drafts are
 * admin-only" protects direct client access and nothing here, so every query
 * below says `published == true` itself and the single-document getter checks
 * `published === true` in code. Those two lines are the boundary between a
 * draft and the public site; a test reads this file and fails without them.
 *
 * Every function returns `PublicEvent`, which has no `createdBy`/`updatedBy`:
 * a page cannot leak an admin's identity it was never handed.
 */

import 'server-only';
import { cache } from 'react';
import { getAdminDb } from './firebase-admin';
import { SHELTER } from '@/config/shelter';
import { publicEventFromData, sortUpcoming, sitemapEventRows, type PublicEvent, type SitemapEventRow } from './events-public';
import { startOfDayInZone } from './zoned-time';

/**
 * How many documents the upcoming query may read before sorting. Generous on
 * purpose: the query must order by `endsAt` (its range field), and the list is
 * ordered by `startsAt`, so the cut to the caller's `limit` happens AFTER the
 * sort, in memory — see `sortUpcoming`. A shelter runs a handful of events a
 * year, so 100 is far past anything real while still bounding the read.
 */
const UPCOMING_READ_CAP = 100;

/**
 * Published events that are not over yet — through the END of their last day
 * in the shelter's zone — soonest start first, at most `limit`.
 *
 * Needs the composite index `events (published ASC, endsAt ASC)`
 * (firestore.indexes.json). Without it this THROWS FAILED_PRECONDITION; the
 * page shows its error state, never "no events".
 */
export async function getUpcomingEvents(limit = 20, now: number = Date.now()): Promise<PublicEvent[]> {
  const db = getAdminDb();
  const cutoff = startOfDayInZone(now, SHELTER.timeZone);
  const snap = await db
    .collection('events')
    .where('published', '==', true)
    .where('endsAt', '>=', cutoff)
    .orderBy('endsAt')
    .limit(UPCOMING_READ_CAP)
    .get();
  const events = snap.docs.flatMap((d) => {
    const event = publicEventFromData(d.id, d.data());
    return event ? [event] : [];
  });
  // Sorted by START, then cut — never cut the endsAt order (a long event that
  // starts first would be dropped).
  return sortUpcoming(events, limit);
}

/**
 * One published event by id (= its slug), or null. A draft answers null
 * exactly like a missing document, so a guessed id learns nothing.
 *
 * Wrapped in React's `cache` so `generateMetadata` and the page share one
 * read per request.
 */
export const getPublishedEvent = cache(async (id: string): Promise<PublicEvent | null> => {
  // An id the rules could never have accepted costs no read.
  if (id.length === 0 || id.length > 120 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) return null;
  const snap = await getAdminDb().collection('events').doc(id).get();
  if (!snap.exists) return null;
  const data = snap.data();
  // THE BOUNDARY: the Admin SDK returned a draft just as happily.
  if (data?.published !== true) return null;
  return publicEventFromData(snap.id, data);
});

/**
 * Published events for the sitemap: upcoming AND past, because a past
 * event's page keeps working and keeps being linked. Bounded; the same
 * single equality the public index starts with, so no new index.
 */
export async function getSitemapEvents(): Promise<SitemapEventRow[]> {
  const snap = await getAdminDb()
    .collection('events')
    .where('published', '==', true)
    .select('title', 'placeName', 'startsAt', 'endsAt', 'published', 'updatedAt')
    .limit(500)
    .get();
  const events = snap.docs.flatMap((d) => {
    const event = publicEventFromData(d.id, d.data());
    return event ? [event] : [];
  });
  return sitemapEventRows(events);
}
