/**
 * The QR symbol for one tag, as SVG. `GET /api/qr/{token}`.
 *
 * ── Why this route does NOT verify an ID token ───────────────────────────
 * Every other route handler in this project sits outside `firestore.rules`
 * and therefore authenticates the caller itself. This one deliberately does
 * not, and the reasons are what make that safe rather than a lapse:
 *
 *   - It READS NOTHING. No Firestore, no Admin SDK, no secret. It turns a
 *     well-formed token into the picture of `https://{site}/id/{token}`, which
 *     is arithmetic anyone can do with any QR library.
 *   - It is NOT AN ORACLE. It answers identically for a token that exists, one
 *     that was revoked, and one that was never minted, so it cannot be used to
 *     test guesses. (A test reads this file and fails if it ever imports a
 *     Firestore reader.)
 *   - It SPENDS NOTHING beyond a few milliseconds of Cloud Run.
 *
 * It must be an `<img src>` the print page can load, and an image request
 * cannot carry a Bearer header — so authenticating here would have meant
 * fetching blobs by hand for no protection at all.
 *
 * ── Why server-side at all ─────────────────────────────────────────────────
 * Plan §7: no external QR service, no runtime network call, and the encoder
 * stays out of every client bundle.
 */

import { SHELTER } from '@/config/shelter';
import { qrTagSymbol } from '@/lib/qr-code';
import { normalizeQrToken } from '@/lib/qr-tokens';

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token: raw } = await params;
  const token = normalizeQrToken(raw);

  if (!token) {
    return new Response('Not found', {
      status: 404,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const { svg } = qrTagSymbol(token, SHELTER.siteUrl);

  return new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      // Five minutes, matching every page on this site — and deliberately NOT
      // a year with `immutable`, although the picture for a token never
      // changes. The URL inside it does if a shelter edits `siteUrl`, and
      // Firebase Hosting does not purge its edge on a Cloud Run deploy: a
      // year-long entry would keep printing tags for the old host. That is the
      // PR #7 cache defect, and it has already happened here once.
      'Cache-Control': 'public, max-age=300, s-maxage=300',
      // An SVG is a document that can carry script. This one never does (a
      // test checks), and these make that true even if it somehow did. No
      // `style-src`: the SVG colours with presentation attributes (`fill=`),
      // never `style=` or `<style>`, and a test holds it to that.
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex',
    },
  });
}
