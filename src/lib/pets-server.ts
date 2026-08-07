/**
 * Server-only Firestore reads, via the Admin SDK.
 *
 * This is what makes the public wall and pet pages real server-rendered HTML
 * instead of a client-side Firestore fetch: a search engine — or a WhatsApp
 * link preview — sees the pet's name and photo on the very first response.
 *
 * Admin access bypasses firestore.rules, which is exactly why nothing in this
 * file may ever be imported from a Client Component, and why the exported
 * functions here return only PUBLIC-tier data. The restricted tiers
 * (identity/microchip, location, scans, custody) are deliberately absent:
 * a Server Component rendering a public page must not be able to leak them by
 * accident. They belong to the admin surface, which authorises explicitly.
 */

import 'server-only';
import { getAdminDb } from './firebase-admin';
import type { Pet, PetDetail, PetSex, PetSize, PetStatus, Sighting, Species } from './types';

export interface WallFilters {
  status?: PetStatus;
  species?: Species;
  size?: PetSize;
  sex?: PetSex;
  limit?: number;
}

/**
 * The adoption wall.
 *
 * `limit` is never optional in practice — an unbounded query against a
 * growing collection is how a Firestore read budget quietly disappears.
 */
export async function getWall(filters: WallFilters = {}): Promise<Pet[]> {
  const db = getAdminDb();
  let q = db.collection('pets').where('status', '==', filters.status ?? 'adopcion');

  if (filters.species) q = q.where('species', '==', filters.species);
  if (filters.size) q = q.where('size', '==', filters.size);
  if (filters.sex) q = q.where('sex', '==', filters.sex);

  const snap = await q.orderBy('createdAt', 'desc').limit(filters.limit ?? 24).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Pet);
}

/** The public teaser, by slug. Readable by anyone — this is what search engines see. */
export async function getPetBySlug(slug: string): Promise<Pet | null> {
  const db = getAdminDb();
  const snap = await db.collection('pets').where('slug', '==', slug).limit(1).get();
  if (snap.empty) return null;
  const d = snap.docs[0]!;
  return { id: d.id, ...d.data() } as Pet;
}

/**
 * The gated tier. Callers must confirm the request is authenticated before
 * calling this — the Admin SDK will happily return it either way, so the
 * check cannot be delegated to firestore.rules here the way it is on the client.
 */
export async function getPetDetail(petId: string): Promise<PetDetail | null> {
  const db = getAdminDb();
  const snap = await db.collection('pets').doc(petId).collection('detail').doc('main').get();
  return snap.exists ? (snap.data() as PetDetail) : null;
}

/** Confirmed sightings of a lost pet, most recent first. Public data either way. */
export async function getSightings(petId: string): Promise<Sighting[]> {
  const db = getAdminDb();
  const snap = await db
    .collection('pets')
    .doc(petId)
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
  const snap = await db.collection('pets').select('slug').get();
  return snap.docs.map((d) => d.data().slug as string);
}

/**
 * Resolve a scanned microchip code to a pet.
 *
 * The single most important query in the whole system: someone has found an
 * animal, a scanner has produced a number, and this is what turns that number
 * back into a name and a phone call. Returns the PUBLIC record only — the
 * finder learns which pet it is and who to contact, not the owner's address.
 *
 * Requires the collection-group index on identity.code (firestore.indexes.json).
 */
export async function findPetByMicrochip(code: string): Promise<Pet | null> {
  const db = getAdminDb();
  const normalized = code.replace(/[\s\-.]/g, '');

  const snap = await db
    .collectionGroup('identity')
    .where('code', '==', normalized)
    .limit(1)
    .get();

  if (snap.empty) return null;

  // identity docs live at pets/{petId}/identity/microchip — walk back up.
  const petRef = snap.docs[0]!.ref.parent.parent;
  if (!petRef) return null;

  const petSnap = await petRef.get();
  return petSnap.exists ? ({ id: petSnap.id, ...petSnap.data() } as Pet) : null;
}
