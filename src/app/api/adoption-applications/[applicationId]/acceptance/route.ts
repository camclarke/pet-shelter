import { FieldValue, type DocumentData } from 'firebase-admin/firestore';

import { SHELTER } from '@/config/shelter';
import { ACCEPTANCE_DOCUMENT_ID } from '@/lib/applications';
import { getAdminDb, verifyAdminIdToken } from '@/lib/firebase-admin';
import { handleAcceptance, type AcceptanceApplicationSnapshot } from '@/lib/acceptance-handler';

/**
 * POST /api/adoption-applications/{applicationId}/acceptance — records the
 * audit trail of an applicant's electronic consent, once.
 *
 * Everything that decides lives in `src/lib/acceptance-handler.ts` and is
 * tested there; this file only supplies the Admin SDK.
 *
 * ⚠️ Outside the rules, and the Admin SDK bypasses them: the handler verifies
 * the token itself (`requireUser`, `checkRevoked`), and acts only on an
 * application whose id names the VERIFIED caller.
 *
 * ⚠️ SWITCHED OFF while `SHELTER.adoptionApplications.enabled` is false: every
 * signed-in caller gets a 404, and without a token a 401.
 */

export const runtime = 'nodejs';
// A POST with an auth header. Never prerendered or cached.
export const dynamic = 'force-dynamic';

/** Only the fields the handler decides on — never the answers, never the address. */
function snapshotOf(data: DocumentData | undefined): AcceptanceApplicationSnapshot {
  const d = data ?? {};
  return {
    applicantUid: d.applicantUid,
    status: d.status,
    identityErasedAt: d.identityErasedAt,
    contractVersion: d.contractVersion,
    contractSha256: d.contractSha256,
    termsAcceptedAt: d.termsAcceptedAt,
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ applicationId: string }> },
): Promise<Response> {
  const { applicationId } = await params;
  return handleAcceptance(request, { applicationId }, {
    verifyIdToken: verifyAdminIdToken,
    applicationsEnabled: SHELTER.adoptionApplications.enabled,
    readApplication: async (id) => {
      const snap = await getAdminDb().collection('adoptionApplications').doc(id).get();
      return snap.exists ? snapshotOf(snap.data()) : null;
    },
    commitAcceptance: (id, receipt) => {
      const db = getAdminDb();
      const ref = db.collection('adoptionApplications').doc(id).collection('private').doc(ACCEPTANCE_DOCUMENT_ID);
      return db.runTransaction(async (tx) => {
        if ((await tx.get(ref)).exists) return 'exists' as const;
        tx.create(ref, { ...receipt, recordedAt: FieldValue.serverTimestamp() });
        return 'created' as const;
      });
    },
    log: (message) => console.warn(message),
  });
}
