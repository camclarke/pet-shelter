import { handleDonationPropose } from '@/lib/donations-handler';
import { donationDeps } from '@/lib/donations-server';

/**
 * POST /api/donations/propose — Tesorería or the superuser proposes new
 * donation details. JSON body: `ProposeRequest` in `donations-protocol.ts`.
 *
 * Everything that decides lives in `src/lib/donations-handler.ts` and is
 * tested there; this file only supplies the Admin SDK. ⚠️ Outside the rules:
 * the handler verifies the token (`requireRole`, `checkRevoked`) and a recent
 * sign-in itself, first.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleDonationPropose(request, donationDeps());
}
