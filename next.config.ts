import type { NextConfig } from 'next';

/**
 * The Spanish routes this site shipped with until the 2026-08-22 rename.
 *
 * Kept as permanent redirects rather than deleted: the paths were live on
 * wawitas.web.app and wawitas.org, and a 301 is what tells a crawler the
 * address moved instead of letting it record a 404 against the one page the
 * whole site exists to get people to. They cost nothing — Next matches them
 * before routing — and they can be dropped once server logs show no traffic.
 *
 * `/adopta/:slug` is listed separately and must come first: a bare
 * `/adopta` → `/adopt` rule does not carry the slug.
 */
const LEGACY_SPANISH_ROUTES = [
  { source: '/adopta/:slug', destination: '/adopt/:slug' },
  { source: '/adopta', destination: '/adopt' },
  { source: '/ayuda', destination: '/help' },
  { source: '/nosotros', destination: '/about' },
  { source: '/perdidos', destination: '/lost' },
  { source: '/cuenta', destination: '/account' },
];

/**
 * output: 'standalone' bundles only the files a request actually needs into
 * .next/standalone, which is what the Dockerfile copies into the Cloud Run
 * image. Without it the image would carry the whole node_modules tree —
 * slower cold starts, and cold starts are the one place Cloud Run's
 * scale-to-zero pricing can hurt you.
 */
const nextConfig: NextConfig = {
  output: 'standalone',

  async redirects() {
    return LEGACY_SPANISH_ROUTES.map((route) => ({ ...route, permanent: true }));
  },

  images: {
    // The audience browses on mid-range Android over mobile data, and
    // photographs are ~90% of this site's weight. AVIF first, WebP fallback.
    formats: ['image/avif', 'image/webp'],
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'firebasestorage.googleapis.com',
      },
    ],
  },
};

export default nextConfig;
