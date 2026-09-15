import { getAdminAuth, getAdminDb, getAdminStorage, verifyAdminIdToken } from '@/lib/firebase-admin';
import { handleAccountDelete } from '@/lib/account-delete';

/**
 * POST /api/account/delete — a signed-in person deleting their OWN account.
 *
 * Everything that decides lives in `src/lib/account-delete.ts` and is tested
 * there; this file only supplies the Admin SDK. Read that file for the order
 * of the deletes, what is deliberately kept, and why admins and stale
 * sign-ins are refused.
 *
 * ⚠️ Outside the rules, and the Admin SDK bypasses them: the handler verifies
 * the token itself (`requireUser`, `checkRevoked`), and every delete uses the
 * uid from that VERIFIED token. The request body is never read.
 *
 * `verifyAdminIdToken` only verifies the token — despite its name, checking a
 * claim is the caller's job, and this handler checks for the ABSENCE of one.
 */

export const runtime = 'nodejs';
// A POST with an auth header. Never prerendered or cached.
export const dynamic = 'force-dynamic';

function bucket() {
  // The same variable every other server path reads the bucket from
  // (`medical-server.ts`). A build without it cannot find the photos, so the
  // delete fails before anything is removed rather than leaving them behind.
  const name = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET?.trim();
  if (!name) throw new Error('NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not set');
  return getAdminStorage().bucket(name);
}

export async function POST(request: Request): Promise<Response> {
  return handleAccountDelete(request, {
    verifyIdToken: verifyAdminIdToken,
    deleteAvatars: async (uid) => {
      await bucket().deleteFiles({ prefix: `users/${uid}/` });
    },
    deleteProfile: async (uid) => {
      await getAdminDb().collection('users').doc(uid).delete();
    },
    deleteAuthUser: async (uid) => {
      await getAdminAuth().deleteUser(uid);
    },
    nowMs: () => Date.now(),
    log: (message, err) => console.warn(message, err),
  });
}
