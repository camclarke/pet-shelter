/**
 * Firebase Admin SDK — server-only. Never import this from a Client Component.
 *
 * On Cloud Run this authenticates via the runtime service account's Application
 * Default Credentials — no key file, nothing to leak. Locally it talks to the
 * emulator suite when FIRESTORE_EMULATOR_HOST is set.
 *
 * Admin access bypasses firestore.rules entirely, which is exactly why this
 * file only ever runs on the server: it is what lets the home page and the
 * wall be real server-rendered HTML (so a search engine sees a dog's name and
 * photo on first fetch) without asking every visitor to sign in first.
 */

import { getApps, initializeApp, cert, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getAuth, type Auth } from 'firebase-admin/auth';

let app: App;

function init(): App {
  if (getApps().length) return getApps()[0]!;

  // On Cloud Run, GOOGLE_APPLICATION_CREDENTIALS is unset and ADC resolves
  // automatically from the attached service account. A service account key is
  // only ever needed for local development, and even then the emulators are
  // the better default — see .env.example.
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  app = serviceAccountJson
    ? initializeApp({ credential: cert(JSON.parse(serviceAccountJson)) })
    : initializeApp();

  return app;
}

let dbInstance: Firestore | null = null;

/** Emulator routing is picked up automatically from FIRESTORE_EMULATOR_HOST. */
export function getAdminDb(): Firestore {
  if (!dbInstance) {
    init();
    dbInstance = getFirestore();
  }
  return dbInstance;
}

/**
 * Admin Auth, for verifying ID tokens in route handlers.
 *
 * WARNING: a Next.js route handler runs OUTSIDE firestore.rules. Every other
 * admin write in this project goes straight from the browser to Firestore and
 * is gated by the rules; a route handler is not, so it must verify the caller
 * itself. That is what this exists for. See src/app/api/intake/suggest/route.ts.
 */
export function getAdminAuth(): Auth {
  init();
  return getAuth();
}
