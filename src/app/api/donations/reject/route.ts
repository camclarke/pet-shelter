import { handleDonationReject } from '@/lib/donations-handler';
import { donationDeps } from '@/lib/donations-server';

/**
 * POST /api/donations/reject — `{pendingId, reason?}`. Tesorería or the
 * superuser, never the proposer, turns a proposal down; history records it.
 *
 * Everything that decides lives in `src/lib/donations-handler.ts`; this file
 * only supplies the Admin SDK. ⚠️ Outside the rules: the handler verifies the
 * token, the recent sign-in and the two-person rule itself.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleDonationReject(request, donationDeps());
}
