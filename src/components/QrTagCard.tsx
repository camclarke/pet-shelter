import { formatQrToken } from '@/lib/qr-tokens';

/**
 * One printable tag: the QR symbol, the typeable address, the shelter's
 * number. Sized in millimetres by `.qr-tag` in globals.css, so what prints is
 * what was measured — see `QR_PRINT_SIZE_MM`.
 *
 * The typeable line is split in two on purpose. "wawitas.org/id/ABCDE-FGHJK"
 * on one line at a legible print size is wider than the tag; the code is the
 * half a finder must copy exactly, so it gets its own line and the larger type.
 *
 * The image comes from `/api/qr/{token}`: server-rendered SVG, no third-party
 * service. A plain `<img>` rather than `next/image` — an SVG needs no resizing
 * proxy, and the optimizer would refuse it anyway.
 */
export function QrTagCard({
  token,
  siteUrl,
  phoneLine,
  alt,
}: {
  token: string;
  siteUrl: string;
  phoneLine: string;
  alt: string;
}) {
  return (
    <figure className="qr-tag">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="qr-tag__code" src={`/api/qr/${token}`} alt={alt} width={100} height={100} />
      <figcaption className="qr-tag__caption">
        <span className="qr-tag__host">{new URL(siteUrl).host}/id/</span>
        <span className="qr-tag__token">{formatQrToken(token)}</span>
        <span className="qr-tag__phone">{phoneLine}</span>
      </figcaption>
    </figure>
  );
}
