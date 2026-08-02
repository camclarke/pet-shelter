/**
 * Presentation helpers shared by server and client code. No Firestore import
 * here on purpose — see dogs-server.ts (Admin SDK) and dogs-client.ts
 * (Web SDK, for the gated detail view once auth lands).
 */

import type { Dog, DogSex, DogSize } from './types';

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
export function formatMeta(dog: Pick<Dog, 'ageMonths' | 'sex' | 'size'>): string {
  const size = dog.sex === 'hembra' ? SIZES[dog.size].replace(/o$/, 'a') : SIZES[dog.size];
  return [formatAge(dog.ageMonths), dog.sex, size].join(' · ');
}

/** DogSex retained in the signature for callers that only have sex/size, not a full Dog. */
export function sizeLabel(size: DogSize, sex: DogSex): string {
  return sex === 'hembra' ? SIZES[size].replace(/o$/, 'a') : SIZES[size];
}

/**
 * The conversion path. In Bolivia, WhatsApp is the channel that actually gets
 * answered, so every adoption action ends here — pre-filled with the dog's
 * name so the shelter knows which dog before they read a word.
 */
export function whatsappLink(dogName: string): string {
  const text = encodeURIComponent(`Hola, me interesa adoptar a ${dogName}`);
  return `https://wa.me/59177903553?text=${text}`;
}
