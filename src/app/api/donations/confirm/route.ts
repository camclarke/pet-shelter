import { handleDonationConfirm } from '@/lib/donations-handler';
import { donationDeps } from '@/lib/donations-server';

/**
 * POST /api/donations/confirm — `{pendingId}`. Tesorería or the superuser,
 * NEVER the person who proposed it, makes a proposal live: one transaction
 * writes `donationSettings/current` (version + 1), appends history and marks
 * the proposal confirmed.
 *
 * Everything that decides lives in `src/lib/donations-handler.ts`; this file
 * only supplies the Admin SDK. ⚠️ Outside the rules: the handler verifies the
 * token, the recent sign-in and the two-person rule itself.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleDonationConfirm(request, donationDeps());
}
