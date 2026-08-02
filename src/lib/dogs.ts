/**
 * Firestore access for dogs.
 *
 * Reads go straight from the browser to Firestore, authorized by
 * firestore.rules. There is no Cloud Function in this path on purpose: rules
 * evaluation is free, a function invocation is billed per read.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit as fsLimit,
  orderBy,
  query,
  where,
  type QueryConstraint,
} from 'firebase/firestore';

import { getFirebase } from './firebase';
import type { Dog, DogDetail, DogLocation, DogSex, DogSize, DogStatus, Sighting } from './types';

/** Statuses a visitor can actually act on. */
export const ADOPTABLE: DogStatus[] = ['adopcion', 'transito', 'refugio'];

export interface WallFilters {
  status?: DogStatus;
  size?: DogSize;
  sex?: DogSex;
  limit?: number;
}

/**
 * The adoption wall.
 *
 * Paginated by default. An unbounded query on a growing collection is how a
 * free-tier read budget quietly disappears, so `limit` is never optional in
 * practice — it just has a sane default.
 */
export async function getWall(filters: WallFilters = {}): Promise<Dog[]> {
  const { db } = getFirebase();
  const constraints: QueryConstraint[] = [];

  constraints.push(where('status', '==', filters.status ?? 'adopcion'));
  if (filters.size) constraints.push(where('size', '==', filters.size));
  if (filters.sex) constraints.push(where('sex', '==', filters.sex));
  constraints.push(orderBy('createdAt', 'desc'));
  constraints.push(fsLimit(filters.limit ?? 24));

  const snap = await getDocs(query(collection(db, 'dogs'), ...constraints));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Dog);
}

/** The public teaser. Readable by anyone — this is what search engines see. */
export async function getDog(dogId: string): Promise<Dog | null> {
  const { db } = getFirebase();
  const snap = await getDoc(doc(db, 'dogs', dogId));
  return snap.exists() ? ({ id: snap.id, ...snap.data() } as Dog) : null;
}

/**
 * The substance, behind a login.
 *
 * Returns null for a signed-out visitor rather than throwing — a permission
 * denial here is an expected state, not an error. Callers render the signup
 * prompt on null.
 */
export async function getDogDetail(dogId: string): Promise<DogDetail | null> {
  const { db } = getFirebase();
  try {
    const snap = await getDoc(doc(db, 'dogs', dogId, 'detail', 'main'));
    return snap.exists() ? (snap.data() as DogDetail) : null;
  } catch {
    return null;
  }
}

/**
 * Exact location. Admins and the current owner only.
 *
 * For a fostered dog this is a volunteer's home address; for an adopted dog,
 * the adopter's. Never render the raw GeoPoint from this document on a surface
 * a wider audience can reach — use `publicMeetingPoint` for that.
 */
export async function getDogLocation(dogId: string): Promise<DogLocation | null> {
  const { db } = getFirebase();
  try {
    const snap = await getDoc(doc(db, 'dogs', dogId, 'location', 'current'));
    return snap.exists() ? (snap.data() as DogLocation) : null;
  } catch {
    return null;
  }
}

/** Confirmed sightings of a lost dog, most recent first. Public. */
export async function getSightings(dogId: string, includePending = false): Promise<Sighting[]> {
  const { db } = getFirebase();
  const constraints: QueryConstraint[] = [];

  if (!includePending) constraints.push(where('status', '==', 'confirmed'));
  constraints.push(orderBy('reportedAt', 'desc'));
  constraints.push(fsLimit(100));

  const snap = await getDocs(
    query(collection(db, 'dogs', dogId, 'sightings'), ...constraints)
  );
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Sighting);
}

// ── presentation helpers ────────────────────────────────────────────────────

/** "3 meses", "1 año", "10 años" — the shelter's own phrasing. */
export function formatAge(ageMonths: number | null): string {
  if (ageMonths === null) return 'edad desconocida';
  if (ageMonths < 12) return `${ageMonths} ${ageMonths === 1 ? 'mes' : 'meses'}`;
  const years = Math.floor(ageMonths / 12);
  return `${years} ${years === 1 ? 'año' : 'años'}`;
}

const SIZES: Record<DogSize, string> = {
  pequeno: 'pequeño',
  mediano: 'mediano',
  grande: 'grande',
};

/** The uppercase data line under a dog's name: "3 MESES · MACHO · MEDIANO". */
export function formatMeta(dog: Dog): string {
  const size = dog.sex === 'hembra' ? SIZES[dog.size].replace(/o$/, 'a') : SIZES[dog.size];
  return [formatAge(dog.ageMonths), dog.sex, size].join(' · ');
}

/**
 * The conversion path. In Bolivia WhatsApp is the channel that actually gets
 * answered, so every adoption action ends here — pre-filled with the dog's
 * name so the shelter knows which dog before they read a word.
 */
export function whatsappLink(dogName: string): string {
  const text = encodeURIComponent(`Hola, me interesa adoptar a ${dogName}`);
  return `https://wa.me/59177903553?text=${text}`;
}
