import { handleDonationPendingQr, handleDonationQrUpload } from '@/lib/donations-handler';
import { donationDeps } from '@/lib/donations-server';

/**
 * The QR image of ONE proposal.
 *
 *   POST  the proposer uploads it: raw `image/jpeg` or `image/png`, ≤ 2 MB,
 *         once per proposal. Re-encoded to PNG server-side (metadata dropped)
 *         and stored at `donations/qr/{pendingId}.png`.
 *   GET   Tesorería or the superuser views it before confirming.
 *         `private, no-store`.
 *
 * `[pendingId]` is the bare id — never `….png`: Firebase Hosting's image
 * cache-header rule would match an API path ending in an image extension.
 *
 * Everything that decides lives in `src/lib/donations-handler.ts`; this file
 * only supplies the Admin SDK. ⚠️ Outside the rules: the handler verifies the
 * token (`requireRole`, `checkRevoked`) first.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ pendingId: string }> },
): Promise<Response> {
  const { pendingId } = await params;
  return handleDonationQrUpload(request, { pendingId }, donationDeps());
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ pendingId: string }> },
): Promise<Response> {
  const { pendingId } = await params;
  return handleDonationPendingQr(request, { pendingId }, donationDeps());
}
