/**
 * Presentation helpers shared by server and client code. No Firestore import
 * here on purpose — see pets-server.ts (Admin SDK) and the client SDK module.
 */

import type { Pet, PetSex, PetSize, Species } from './types';

/** "3 meses", "1 año", "10 años" — the phrasing shelters actually use. */
export function formatAge(ageMonths: number | null): string {
  if (ageMonths === null) return 'edad desconocida';
  if (ageMonths < 12) return `${ageMonths} ${ageMonths === 1 ? 'mes' : 'meses'}`;
  const years = Math.floor(ageMonths / 12);
  return `${years} ${years === 1 ? 'año' : 'años'}`;
}

/**
 * Spanish adjectives agree with grammatical gender, so size cannot be a single
 * static string. "pequeño" for a male, "pequeña" for a female — getting this
 * wrong reads as carelessness to every native speaker on the site, which is
 * the entire audience.
 */
const SIZE_STEMS: Record<PetSize, string> = {
  pequeno: 'pequeñ',
  mediano: 'median',
  grande: 'grande',
};

export function sizeLabel(size: PetSize, sex: PetSex): string {
  // "grande" is invariant — it already ends in -e and takes no gendered form.
  if (size === 'grande') return 'grande';
  return SIZE_STEMS[size] + (sex === 'hembra' ? 'a' : 'o');
}

/** The noun, agreeing with sex: perro/perra, gato/gata, conejo/coneja. */
const SPECIES_NOUN: Record<Species, { macho: string; hembra: string }> = {
  perro: { macho: 'perro', hembra: 'perra' },
  gato: { macho: 'gato', hembra: 'gata' },
  conejo: { macho: 'conejo', hembra: 'coneja' },
  otro: { macho: 'animalito', hembra: 'animalita' },
};

export function speciesNoun(species: Species, sex: PetSex): string {
  return SPECIES_NOUN[species][sex];
}

/** Definite article, for sentences like "conoce a la gata". */
export function article(sex: PetSex): 'el' | 'la' {
  return sex === 'hembra' ? 'la' : 'el';
}

/** Plural noun for headings: "perritos", "gatitos". */
const SPECIES_PLURAL: Record<Species, string> = {
  perro: 'perritos',
  gato: 'gatitos',
  conejo: 'conejitos',
  otro: 'animalitos',
};

export function speciesPlural(species: Species): string {
  return SPECIES_PLURAL[species];
}

/** The uppercase data line under a name: "3 MESES · MACHO · MEDIANO". */
export function formatMeta(pet: Pick<Pet, 'ageMonths' | 'sex' | 'size'>): string {
  return [formatAge(pet.ageMonths), pet.sex, sizeLabel(pet.size, pet.sex)].join(' · ');
}

/**
 * The conversion path. In Bolivia, WhatsApp is the channel that actually gets
 * answered, so every adoption action ends here — pre-filled with the pet's
 * name so the shelter knows which animal before they read a word.
 *
 * The number is configuration, not a constant: this template is meant to be
 * adopted by other shelters, and a hardcoded Bolivian number would follow
 * them into their fork.
 */
export function whatsappLink(petName: string, phone: string): string {
  const text = encodeURIComponent(`Hola, me interesa adoptar a ${petName}`);
  return `https://wa.me/${phone}?text=${text}`;
}
