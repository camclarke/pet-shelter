/**
 * The QR symbol for a tag, as SVG. Generated on our own server: no external
 * QR service, no runtime network call.
 *
 * Plan §7 is why that matters: sending pet identifiers to a third-party image
 * API leaks them for zero benefit, and puts someone else's uptime in the path
 * of a page a volunteer is trying to print.
 *
 * No `server-only` import: this is pure, so the unit suite can decode what it
 * emits. It is only CALLED from the `/api/qr/[token]` route handler; a client
 * component has no reason to import it.
 *
 * ── The encoder: lean-qr ──────────────────────────────────────────────────
 * Zero dependencies, MIT, published 2026-09-07. Chosen over `qr` (paulmillr,
 * also zero-dependency and the stronger-looking pick) on a MEASUREMENT, not a
 * preference. The payload is `https://wawitas.org/id/XXXXXXXXXX`, 33 bytes:
 *
 *     encoder            segmentation                 version at ECC Q
 *     qr 0.7.0           one byte-mode segment        4  (33×33 modules)
 *     lean-qr 2.7.4      automatic: bytes + alnum     3  (29×29 modules)
 *
 * Version 3 at Q holds 272 data bits. As one byte segment the payload needs
 * 4 + 8 + 33×8 = 276 — four bits over. Split so the uppercase token rides in
 * alphanumeric mode it needs 196 + 68 = 264, and fits. At a 20 mm print that
 * is 0.54 mm per module instead of 0.49 mm — about 10% larger, on the one
 * dimension that decides whether a phone reads a scratched collar tag.
 *
 * `qr` is still in the project, as a DEV dependency: the tests decode this
 * module's SVG with it, so the round trip is checked by an independent
 * implementation rather than by the encoder agreeing with itself.
 *
 * ⚠️ A forking shelter with a longer host gets a larger symbol, and that is
 * fine — the version test pins THIS host. `https://refugio-ejemplo.org.bo`
 * measured version 4.
 */

import { correction, generate } from 'lean-qr';
import { toSvgSource } from 'lean-qr/extras/svg';

import { qrTagUrl } from './qr-tokens';

/**
 * Level Q restores up to ~25% of damaged codewords. Plan §7. A collar tag is
 * scratched, bent, and chewed; L and M give that away to save a version, and H
 * costs one here (version 3 at H holds only 208 data bits).
 */
export const QR_ERROR_CORRECTION = 'Q' as const;

/**
 * Four modules of white around the symbol: the minimum ISO/IEC 18004 asks for,
 * and it is inside the SVG so a print cannot crop it — a symbol printed flush
 * against a coloured tag edge is the commonest reason a valid code will not
 * scan.
 */
export const QR_QUIET_ZONE_MODULES = 4;

export interface QrTagSymbol {
  /** The URL encoded. */
  payload: string;
  /** Standalone SVG document, explicit white background, no scripts. */
  svg: string;
  /** Modules per side of the symbol itself, without the quiet zone. */
  size: number;
  /** QR version, 1–40. */
  version: number;
}

export function qrTagSymbol(token: string, siteUrl: string): QrTagSymbol {
  const payload = qrTagUrl(siteUrl, token);
  const code = generate(payload, {
    minCorrectionLevel: correction.Q,
    // Pinned from both sides. lean-qr otherwise raises the level for free when
    // a stronger one fits the same version, which would make the level depend
    // on the host's length — and the test assert a moving target.
    maxCorrectionLevel: correction.Q,
  });

  // Explicit black on white. An SVG with a transparent background shows black
  // modules on the admin page's dark theme — a code that looks fine to print
  // and cannot be scanned off the screen to test it.
  const svg = toSvgSource(code, { pad: QR_QUIET_ZONE_MODULES, on: '#000', off: '#fff' });

  return { payload, svg, size: code.size, version: (code.size - 17) / 4 };
}
