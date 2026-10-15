import type { MetadataRoute } from 'next';
import { SHELTER } from '@/config/shelter';
import { getSitemapPets, type SitemapPetRow } from '@/lib/pets-server';
import { buildSitemap } from '@/lib/sitemap';

// Mandatory: without an explicit revalidate, Firebase Hosting caches a
// prerendered route for a year.
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  let pets: SitemapPetRow[] = [];
  try {
    pets = await getSitemapPets();
  } catch (err) {
    // At build time (CI) there are no Firestore credentials. Serve the static
    // routes; the full list is regenerated at runtime within the hour.
    console.error('[sitemap] pet query failed, serving static routes only:', (err as Error).message);
  }
  return buildSitemap(SHELTER.siteUrl, pets);
}
