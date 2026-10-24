import { handlePublicDonationQr } from '@/lib/donations-handler';
import { publicQrDeps } from '@/lib/donations-server';

/**
 * GET /api/donations/qr — PUBLIC: the CONFIRMED donation QR, as PNG, for the
 * /donate page. Deliberately unauthenticated (require-admin.test.ts lists it
 * by name). It takes no input at all: only `donationSettings/current.qrPath`
 * can be served, never a proposal's, and only while the details are active
 * and the QR has not expired; otherwise 404. Edge-cached 5 minutes.
 *
 * Everything that decides lives in `src/lib/donations-handler.ts`.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return handlePublicDonationQr(publicQrDeps());
}
