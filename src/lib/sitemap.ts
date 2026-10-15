/**
 * Pure sitemap builder. No `server-only` import, so it can be tested.
 *
 * Only PUBLIC, indexable pages belong here. Deliberately absent: /account,
 * /admin/**, /api/**, /id/[token] (QR identity pages must never be
 * enumerated) and /adopt/[slug]/apply.
 */
import type { MetadataRoute } from 'next';

/** Static public routes, in the order they appear in the sitemap. */
export const STATIC_SITEMAP_ROUTES = ['/', '/adopt', '/lost', '/help', '/about', '/privacy'] as const;

export interface SitemapPet {
  slug: string;
  updatedAt?: Date;
}

export function buildSitemap(siteUrl: string, pets: SitemapPet[]): MetadataRoute.Sitemap {
  const base = siteUrl.replace(/\/+$/, '');
  // Static routes carry no lastModified on purpose: stamping `new Date()` on
  // every crawl would tell search engines everything changed every time.
  const staticEntries = STATIC_SITEMAP_ROUTES.map((path) => ({
    url: path === '/' ? base : `${base}${path}`,
  }));
  const petEntries = pets.map((p) => ({
    url: `${base}/adopt/${encodeURIComponent(p.slug)}`,
    ...(p.updatedAt ? { lastModified: p.updatedAt } : {}),
  }));
  return [...staticEntries, ...petEntries];
}
