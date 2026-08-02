/**
 * Server-only Firestore reads, via the Admin SDK.
 *
 * This is what makes the public wall and dog pages real server-rendered HTML
 * instead of a client-side Firestore fetch: a search engine — or a WhatsApp
 * link preview — sees the dog's name and photo on the very first response.
 * Admin access bypasses firestore.rules, which is exactly why nothing in this
 * file may ever be imported from a Client Component; it must only run inside
 * Server Components, Route Handlers, or generateMetadata.
 */

import 'server-only';
import { getAdminDb } from './firebase-admin';
import type { Dog, DogSex, DogSize, DogStatus, Sighting } from './types';

export interface WallFilters {
  status?: DogStatus;
  size?: DogSize;
  sex?: DogSex;
  limit?: number;
}

/**
 * The adoption wall.
 *
 * `limit` is never optional in practice — an unbounded query against a
 * growing collection is how a Firestore read budget quietly disappears.
 */
export async function getWall(filters: WallFilters = {}): Promise<Dog[]> {
  const db = getAdminDb();
  let q = db.collection('dogs').where('status', '==', filters.status ?? 'adopcion');

  if (filters.size) q = q.where('size', '==', filters.size);
  if (filters.sex) q = q.where('sex', '==', filters.sex);

  const snap = await q.orderBy('createdAt', 'desc').limit(filters.limit ?? 24).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Dog);
}

/** The public teaser, by slug. Readable by anyone — this is what search engines see. */
export async function getDogBySlug(slug: string): Promise<Dog | null> {
  const db = getAdminDb();
  const snap = await db.collection('dogs').where('slug', '==', slug).limit(1).get();
  if (snap.empty) return null;
  const d = snap.docs[0]!;
  return { id: d.id, ...d.data() } as Dog;
}

/** Confirmed sightings of a lost dog, most recent first. Public data either way. */
export async function getSightings(dogId: string): Promise<Sighting[]> {
  const db = getAdminDb();
  const snap = await db
    .collection('dogs')
    .doc(dogId)
    .collection('sightings')
    .where('status', '==', 'confirmed')
    .orderBy('reportedAt', 'desc')
    .limit(100)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Sighting);
}

/** All published slugs, for generateStaticParams / the sitemap. */
export async function getAllSlugs(): Promise<string[]> {
  const db = getAdminDb();
  const snap = await db.collection('dogs').select('slug').get();
  return snap.docs.map((d) => d.data().slug as string);
}
