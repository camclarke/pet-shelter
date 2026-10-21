import type { MetadataRoute } from 'next';
import { SHELTER } from '@/config/shelter';
import { getSitemapPets, type SitemapPetRow } from '@/lib/pets-server';
import { getSitemapEvents } from '@/lib/events-server';
import type { SitemapEventRow } from '@/lib/events-public';
import { buildSitemap } from '@/lib/sitemap';

// Per-request render (the CI build has no Firestore access, so a prerender
// would bake the static-only list); next.config.ts caches it 5 minutes at the
// CDN. A test pins both.
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  let pets: SitemapPetRow[] = [];
  try {
    pets = await getSitemapPets();
  } catch (err) {
    // At build time (CI) there are no Firestore credentials. Serve the static
    // routes; the full list is regenerated at runtime within the hour.
    console.error('[sitemap] pet query failed, serving static routes only:', (err as Error).message);
  }
  // Guarded on its own: a failing events query must not cost the pets, and
  // the other way round.
  let events: SitemapEventRow[] = [];
  try {
    events = await getSitemapEvents();
  } catch (err) {
    console.error('[sitemap] event query failed, serving without event pages:', (err as Error).message);
  }
  return buildSitemap(SHELTER.siteUrl, pets, events);
}
