import type { NextConfig } from 'next';

/**
 * output: 'standalone' bundles only the files a request actually needs into
 * .next/standalone, which is what the Dockerfile copies into the Cloud Run
 * image. Without it the image would carry the whole node_modules tree —
 * slower cold starts, and cold starts are the one place Cloud Run's
 * scale-to-zero pricing can hurt you.
 */
const nextConfig: NextConfig = {
  output: 'standalone',

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
