// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://wawitas.org',

  // Static output, deliberately. Firebase Hosting serves the build from its CDN
  // for free; SSR would mean Cloud Run, which means compute, which means a bill.
  // Dog data hydrates client-side from Firestore.
  output: 'static',

  build: {
    inlineStylesheets: 'auto',
  },

  image: {
    // The audience browses on mid-range Android over mobile data. Photographs
    // are ~90% of this site's weight, so the format matters more than usual.
    formats: ['avif', 'webp'],
  },

  vite: {
    build: {
      // The Firebase SDK is large and only needed on interactive pages. Keeping
      // it in its own chunk means the wall does not pay for the admin console.
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules/firebase') || id.includes('node_modules/@firebase')) {
              return 'firebase';
            }
          },
        },
      },
    },
  },
});
