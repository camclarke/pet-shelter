import { getAdminDb, getAdminStorage, verifyAdminIdToken } from '@/lib/firebase-admin';
import { deleteEveryIdDocumentVersion } from '@/lib/id-document-store';
import { handleIdentityErase } from '@/lib/identity-erase-handler';
import { commitIdentityErasure } from '@/lib/identity-erase-server';

/**
 * POST /api/adoption-applications/{applicationId}/erase-identity — an admin
 * erasing an applicant's carnet photo, address and personal details, with a
 * reason. Everything that decides lives in `src/lib/identity-erase-handler.ts`
 * and is tested there; this file only supplies the Admin SDK. The Firestore
 * transaction is `identity-erase-server.ts`; the photo delete is the store's.
 *
 * ⚠️ Outside the rules, and the Admin SDK bypasses them: the handler checks the
 * admin claim itself (`requireAdmin`, `checkRevoked`).
 *
 * Not behind the public switch: the shelter must be able to erase whatever was
 * collected even after the form is switched off again.
 */

export const runtime = 'nodejs';
// A POST with an auth header. Never prerendered or cached.
export const dynamic = 'force-dynamic';

function bucket() {
  const name = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET?.trim();
  if (!name) throw new Error('NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not set');
  return getAdminStorage().bucket(name);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ applicationId: string }> },
): Promise<Response> {
  const { applicationId } = await params;
  return handleIdentityErase(request, { applicationId }, {
    verifyIdToken: verifyAdminIdToken,
    readApplication: async (id) => {
      const snap = await getAdminDb().collection('adoptionApplications').doc(id).get();
      if (!snap.exists) return null;
      const d = snap.data() ?? {};
      return { petId: d.petId, applicantUid: d.applicantUid, status: d.status, identityErasedAt: d.identityErasedAt };
    },
    readAdoption: async (petId) => {
      const snap = await getAdminDb().collection('adoptions').doc(petId).get();
      if (!snap.exists) return null;
      const d = snap.data() ?? {};
      return { ownerUid: d.ownerUid, applicationId: d.applicationId };
    },
    commitErasure: (id, plan) => commitIdentityErasure(getAdminDb(), id, plan),
    deleteIdPhotos: (id) => deleteEveryIdDocumentVersion(bucket(), id),
    log: (message) => console.warn(message),
  });
}
