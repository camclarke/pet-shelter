/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE FILE YOU EDIT TO MAKE THIS YOUR SHELTER.
 *
 * Everything organisation-specific lives here so that adopting this template
 * is a config change rather than a search-and-replace through the codebase.
 * The values below are the reference deployment (Wawitas Red de Apoyo,
 * Cochabamba, Bolivia); replace them with your own.
 *
 * Design tokens — colours, fonts, the logo mark — live in src/app/globals.css
 * and src/components/Brand.tsx. Those are the other two files worth changing.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Species } from '@/lib/types';

export interface ShelterConfig {
  name: string;
  shortName: string;
  tagline: string;
  mission: string;

  /** Full international format, digits only, no + or spaces. Used to build wa.me links. */
  whatsapp: string;
  /** As a human should read it. */
  whatsappDisplay: string;

  instagram: string | null;
  facebook: string | null;
  email: string | null;

  city: string;
  country: string;
  /** BCP 47, used for <html lang> and Intl formatting. */
  locale: string;
  /** Production origin, for canonical URLs and Open Graph. */
  siteUrl: string;

  /**
   * Which species this shelter actually takes in. Drives the filters shown on
   * the wall — a dog-only rescue should not display an empty "conejos" tab.
   */
  species: Species[];

  /**
   * Geographic bounds used to sanity-check sighting reports and scan
   * locations. Keep these tight around your service area: they are what stops
   * the public sighting endpoint from accepting coordinates on another
   * continent. Mirrored in firestore.rules, which is the enforcing copy —
   * update both together.
   */
  bounds: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  };
}

export const SHELTER: ShelterConfig = {
  name: 'Wawitas Red de Apoyo',
  shortName: 'Wawitas',
  tagline: 'De la calle, a tu corazón.',
  mission:
    'Rescatamos animalitos abandonados y maltratados, los rehabilitamos física y emocionalmente, y les buscamos una familia para toda la vida en adopción responsable.',

  whatsapp: '59177903553',
  whatsappDisplay: '77903553',

  instagram: 'https://www.instagram.com/wawitas_2025/',
  facebook: 'https://www.facebook.com/profile.php?id=61563998952145',
  email: null,

  city: 'Cochabamba',
  country: 'Bolivia',
  locale: 'es-BO',
  siteUrl: 'https://wawitas.org',

  species: ['dog', 'cat'],

  bounds: {
    minLat: -17.75,
    maxLat: -17.15,
    minLng: -66.45,
    maxLng: -65.85,
  },
};
