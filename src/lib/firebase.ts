/**
 * Firebase client initialisation.
 *
 * Every value here is public by design — the Firebase web config is shipped to
 * the browser and is not a secret. What protects the data is firestore.rules
 * and storage.rules, not the obscurity of these keys.
 */

import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, type Auth } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, type Firestore } from 'firebase/firestore';
import { getStorage, connectStorageEmulator, type FirebaseStorage } from 'firebase/storage';

const config = {
  apiKey: import.meta.env.PUBLIC_FIREBASE_API_KEY,
  authDomain: import.meta.env.PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.PUBLIC_FIREBASE_APP_ID,
};

const useEmulators = import.meta.env.PUBLIC_USE_EMULATORS === 'true';

let app: FirebaseApp;
let authInstance: Auth;
let dbInstance: Firestore;
let storageInstance: FirebaseStorage;

function init() {
  if (getApps().length) return;

  app = initializeApp(config);
  authInstance = getAuth(app);
  dbInstance = getFirestore(app);
  storageInstance = getStorage(app);

  if (useEmulators) {
    connectAuthEmulator(authInstance, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(dbInstance, '127.0.0.1', 8080);
    connectStorageEmulator(storageInstance, '127.0.0.1', 9199);
  }
}

/**
 * Lazily initialise on first use.
 *
 * The build is static and most visitors land on the wall, so deferring this
 * until something actually touches Firebase keeps the initial payload down.
 */
export function getFirebase() {
  init();
  return { app, auth: authInstance, db: dbInstance, storage: storageInstance };
}
