import { FieldValue, type DocumentData } from 'firebase-admin/firestore';

import { SHELTER } from '@/config/shelter';
import { getAdminDb, getAdminStorage, verifyAdminIdToken } from '@/lib/firebase-admin';
import { handleIdDocumentUpload, type UploadApplicationSnapshot } from '@/lib/id-document-handler';
import { deleteEveryIdDocumentVersion, readIdDocumentReceipt, saveIdDocument } from '@/lib/id-document-store';
import type { IdDocumentReceipt } from '@/lib/types';

/**
 * POST /api/adoption-applications/{applicationId}/id-document/{side} — an
 * applicant uploading the photo of their OWN identity card, as raw
 * `image/jpeg` bytes.
 *
 * Everything that decides lives in `src/lib/id-document-handler.ts` and is
 * tested there; this file only supplies the Admin SDK. Read that file for the
 * order of the checks and why each refusal is what it is.
 *
 * ⚠️ Outside the rules, and the Admin SDK bypasses them: the handler verifies
 * the token itself (`requireUser`, `checkRevoked`), and acts only on an
 * application whose id names the VERIFIED caller.
 *
 * ⚠️ SWITCHED OFF while `SHELTER.adoptionApplications.enabled` is false: every
 * signed-in caller gets a 404, and without a token a 401. That flag is passed
 * through as it is — a test fails if this file hard-codes it.
 *
 * `[side]` is `front` or `back`, never `front.jpg`: Firebase Hosting's
 * `**\/*.@(jpg|…)` cache-header rule would match an API path ending in `.jpg`.
 */

export const runtime = 'nodejs';
// A POST with an auth header and a body. Never prerendered or cached.
export const dynamic = 'force-dynamic';

function bucket() {
  // The same variable every other server path reads the bucket from
  // (`medical-server.ts`, `api/account/delete`). Without it nothing is saved.
  const name = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET?.trim();
  if (!name) throw new Error('NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not set');
  return getAdminStorage().bucket(name);
}

/** The marker as written. Typed so `IdDocumentReceipt` and the writer cannot drift. */
type AdminIdDocumentReceiptWrite = Omit<IdDocumentReceipt, 'receivedAt'> & { receivedAt: FieldValue };

/** Only the fields the handler decides on — never the answers, never the address. */
function snapshotOf(data: DocumentData | undefined): UploadApplicationSnapshot {
  const d = data ?? {};
  return {
    applicantUid: d.applicantUid,
    status: d.status,
    identityErasedAt: d.identityErasedAt,
    idDocument: d.idDocument,
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ applicationId: string; side: string }> },
): Promise<Response> {
  const { applicationId, side } = await params;
  return handleIdDocumentUpload(request, { applicationId, side }, {
    verifyIdToken: verifyAdminIdToken,
    applicationsEnabled: SHELTER.adoptionApplications.enabled,
    sides: SHELTER.adoptionApplications.idDocumentSides,
    readApplication: async (id) => {
      const snap = await getAdminDb().collection('adoptionApplications').doc(id).get();
      return snap.exists ? snapshotOf(snap.data()) : null;
    },
    saveIdDocument: (id, documentSide, bytes) => saveIdDocument(bucket(), id, documentSide, bytes),
    readIdDocumentReceipt: (id, documentSide) => readIdDocumentReceipt(bucket(), id, documentSide),
    // The re-check and the write in ONE transaction: a withdrawal, a rejection
    // or an erase committed while the body was uploading is SEEN here, and the
    // marker is not written (review 4b #1). The handler decides; this only
    // reads, asks, and writes when told to.
    commitIdMarker: (id, documentSide, receipt, check) => {
      const db = getAdminDb();
      const ref = db.collection('adoptionApplications').doc(id);
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const refusal = check(snap.exists ? snapshotOf(snap.data()) : null);
        if (refusal) return refusal;
        const marker: AdminIdDocumentReceiptWrite = {
          receivedAt: FieldValue.serverTimestamp(),
          bytes: receipt.bytes,
          generation: receipt.generation,
        };
        // A dotted path: replaces only this side, on `{}` and `{front: null}` alike.
        tx.update(ref, { [`idDocument.${documentSide}`]: marker });
        return null;
      });
    },
    deleteIdDocumentSide: (id, documentSide) => deleteEveryIdDocumentVersion(bucket(), id, documentSide),
    // One line, never a raw error object: see `IdDocumentDeps.log`.
    log: (message) => console.warn(message),
  });
}
