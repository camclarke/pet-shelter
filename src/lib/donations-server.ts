import 'server-only';

import { randomBytes } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';

import { getAdminDb, getAdminStorage, verifyAdminIdToken } from './firebase-admin';
import {
  DONATION_HISTORY_PATH,
  DONATION_PENDING_PATH,
  DONATION_SETTINGS_PATH,
  loadPublicDonationSettings,
  type PublicDonationSettings,
} from './donations';
import type { DonationTx, DonationsDeps, PublicQrDeps } from './donations-handler';
import { reencodeQrPng } from './qr-reencode';

/**
 * Donation details: the SERVER side, through the Admin SDK. The donation
 * routes and the public /donate page use this; nothing else should.
 *
 * ⚠️ The Admin SDK BYPASSES `firestore.rules` and `storage.rules`. Every
 * decision is made in `donations-handler.ts` (tested); this file only binds
 * Firestore, Storage, the clock and the PNG re-encoder to it.
 */

/** Never cached by a browser, a proxy or Firebase Hosting's edge — the routes set their own headers. */
const OBJECT_CACHE_CONTROL = 'private, no-store';

function bucket() {
  // The same variable every other server path reads the bucket from.
  const name = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET?.trim();
  if (!name) throw new Error('NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not set');
  return getAdminStorage().bucket(name);
}

const currentRef = () => getAdminDb().doc(DONATION_SETTINGS_PATH);
const pendingCol = () => getAdminDb().collection(DONATION_PENDING_PATH);
const historyCol = () => getAdminDb().collection(DONATION_HISTORY_PATH);

async function readQr(path: string): Promise<Uint8Array | null> {
  try {
    const [buffer] = await bucket().file(path).download();
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 404) return null;
    throw error;
  }
}

/** Everything the authenticated donation routes need. */
export function donationDeps(): DonationsDeps {
  return {
    verifyIdToken: verifyAdminIdToken,
    nowMs: () => Date.now(),
    // A time prefix plus 12 random bytes in hex: unguessable, and matches `isDonationId`.
    newPendingId: () => `p${Date.now().toString(36)}-${randomBytes(12).toString('hex')}`,
    serverTimestamp: () => FieldValue.serverTimestamp(),
    runTransaction: (fn) =>
      getAdminDb().runTransaction(async (t) => {
        const tx: DonationTx = {
          getCurrent: async () => {
            const snap = await t.get(currentRef());
            return snap.exists ? (snap.data() ?? null) : null;
          },
          getPending: async (id) => {
            const snap = await t.get(pendingCol().doc(id));
            return snap.exists ? (snap.data() ?? null) : null;
          },
          listOpenPending: async () => {
            const snap = await t.get(pendingCol().where('status', '==', 'pending'));
            return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
          },
          setCurrent: (data) => {
            t.set(currentRef(), data);
          },
          createPending: (id, data) => {
            t.create(pendingCol().doc(id), data);
          },
          updatePending: (id, patch) => {
            t.update(pendingCol().doc(id), patch);
          },
          createHistory: (id, data) => {
            t.create(historyCol().doc(id), data);
          },
        };
        return fn(tx);
      }),
    readCurrent: async () => {
      const snap = await currentRef().get();
      return snap.exists ? (snap.data() ?? null) : null;
    },
    readPending: async (id) => {
      const snap = await pendingCol().doc(id).get();
      return snap.exists ? (snap.data() ?? null) : null;
    },
    saveQr: async (path, png) => {
      try {
        await bucket()
          .file(path)
          .save(Buffer.from(png.buffer, png.byteOffset, png.byteLength), {
            resumable: false,
            contentType: 'image/png',
            // Create-only: one QR per proposal, never overwritten.
            preconditionOpts: { ifGenerationMatch: 0 },
            metadata: { cacheControl: OBJECT_CACHE_CONTROL },
          });
        return 'saved';
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 412) return 'exists';
        throw error;
      }
    },
    readQr,
    deleteQr: async (path) => {
      await bucket().file(path).delete({ ignoreNotFound: true });
    },
    reencodePng: reencodeQrPng,
    // One line, never a raw error object or a payload.
    log: (message) => console.warn(message),
  };
}

/** What the public QR route needs: reads only. */
export function publicQrDeps(): PublicQrDeps {
  const deps = donationDeps();
  return { nowMs: deps.nowMs, readCurrent: deps.readCurrent, readQr, log: deps.log };
}

/**
 * The confirmed details as /donate may show them, or null — missing, switched
 * off, malformed, or the read failed. Never throws to the page.
 */
export async function getPublicDonationSettings(): Promise<PublicDonationSettings | null> {
  return loadPublicDonationSettings({
    readCurrent: async () => {
      const snap = await currentRef().get();
      return snap.exists ? (snap.data() ?? null) : null;
    },
    nowMs: () => Date.now(),
    log: (message) => console.warn(message),
  });
}
