/**
 * Check an uploaded identity-card photo is a plain JPEG, and remove the
 * metadata segments a camera or editor may have left in it — WITHOUT decoding
 * the image. Pure: bytes in, bytes out.
 *
 * ═══ WHY THE SERVER CHECKS AT ALL ═══════════════════════════════════════════
 * The browser re-encodes the photo through a canvas (`stripAndResize`), which
 * drops EXIF — including GPS, which for a photo taken at home is the home.
 * But the upload route is an HTTP endpoint: anything can POST to it. So the
 * route trusts nothing about the bytes, and this walk is what it stores.
 *
 * ═══ WHY NO DECODE ══════════════════════════════════════════════════════════
 * Re-encoding with `sharp` would mean DECODING untrusted images on the server,
 * an attack surface this project has already been hit through (libvips,
 * `sharp <0.35.4`, 2026-09-11). Walking the marker segments reads lengths and
 * a few fixed header fields, nothing more; the entropy-coded image data is
 * copied byte for byte and never interpreted. The only decoder that ever runs
 * is the admin's browser, and the frame bound below caps it at 2048 × 2048
 * (about 4.2 MP), so a "decompression bomb" cannot be stored here.
 *
 * ═══ REMOVE, OR REFUSE ══════════════════════════════════════════════════════
 * REMOVED by byte splice — so the dropped bytes are never stored — because a
 * phone's own encoder may well emit them and refusing would refuse real
 * uploads (critic 2026-10-16, #6; Safari on iOS and Chrome on Android are
 * UNMEASURED):
 *   - APP1  (FFE1) Exif and XMP — where GPS, the device and the time live;
 *   - APP13 (FFED) IPTC / Photoshop;
 *   - COM   (FFFE) free-text comments.
 * KEPT, because a decoder needs them or they carry nothing personal:
 *   - APP0 `JFIF\0` with a 0 × 0 thumbnail and nothing after it;
 *   - APP2 `ICC_PROFILE\0`, up to 64 KB in total — the colour profile. Desktop
 *     Chrome's canvas output carries one: MEASURED 2026-08-23 as
 *     `FFE0 FFE2 FFDB FFDB FFC0 FFC4×4 FFDA`, so refusing every APP2 would
 *     refuse every browser-stripped photo;
 *   - APP14 `Adobe` (the fixed 12-byte colour-transform flag);
 *   - DQT, DHT, DRI, one SOF0/SOF1 frame, EXACTLY ONE SOS scan covering every
 *     frame component, with its data and RSTn, then EOI.
 *
 * ONE SCAN, AND NEVER PROGRESSIVE. A browser canvas always encodes baseline
 * with a single interleaved scan — Chromium's canvas output MEASURED as
 * `FFE0 FFE2 FFDB FFDB FFC0 FFC4×4 FFDA`. A progressive (SOF2) file is a
 * sequence of scans the admin's browser decodes one after another, and the
 * walker had no bound on how many: the 4b review built a 1.4 MB file with
 * 127 254 scans, which every decode of the stored photo would have walked.
 * Only an encoder that skipped the canvas emits either, so both are refused.
 * REFUSED, everything else, and in particular:
 *   - JFXX (FFE0 `JFXX\0`) and a JFIF thumbnail: an EMBEDDED IMAGE, the
 *     classic "the crop did not crop the thumbnail" leak;
 *   - APP2 that is not ICC — `MPF\0` is how iPhones attach a SECOND image;
 *   - every other APPn, DNL (FFDC — a frame height defined after the fact),
 *     SOF3 and SOF5–SOF15, a second frame, a frame that is not 8-bit with 1 or
 *     3 components, a zero or oversized dimension, a photo too small to read
 *     a card from, and ANY byte after EOI (where a second file hides).
 *
 * Fill bytes (extra 0xFF before a marker) are legal JPEG, carry nothing, and
 * are dropped.
 *
 * The route logs only the marker that was removed or refused — `FFE1` — never
 * bytes, so the allowlist can be widened deliberately when a real phone's
 * output is measured.
 */

/** The long edge the browser resizes an ID photo to — `CARD_PHOTO_MAX_EDGE` (tested equal). */
export const ID_PHOTO_MAX_EDGE = 2048;
/**
 * The smallest photo the route stores. Approval checks only that a receipt
 * EXISTS, so without a floor a 1 × 1 upload would satisfy it (critic #6). A
 * card read for a home visit needs its print legible: a long edge of 1000 px
 * and a short edge of 500 px is about half a megapixel — far below what any
 * phone camera, or WhatsApp's 1600 px re-compression, produces.
 */
export const ID_PHOTO_MIN_LONG_EDGE = 1000;
export const ID_PHOTO_MIN_SHORT_EDGE = 500;
/** Every ICC_PROFILE chunk's data, summed. sRGB and Display P3 are well under 4 KB. */
export const ICC_PROFILE_MAX_BYTES = 64 * 1024;

export interface JpegLimits {
  maxEdge: number;
  minLongEdge: number;
  minShortEdge: number;
  maxIccBytes: number;
}

export const ID_PHOTO_LIMITS: JpegLimits = {
  maxEdge: ID_PHOTO_MAX_EDGE,
  minLongEdge: ID_PHOTO_MIN_LONG_EDGE,
  minShortEdge: ID_PHOTO_MIN_SHORT_EDGE,
  maxIccBytes: ICC_PROFILE_MAX_BYTES,
};

export type JpegRefusal =
  /** Does not start with SOI (FFD8). */
  | 'not-jpeg'
  /** Ran off the end: no EOI, or a segment longer than the file. */
  | 'truncated'
  /** A length below 2, a fixed-size segment of the wrong size, or bytes where a marker must be. */
  | 'bad-segment'
  /** A marker not on the allowlist — reserved, JPG, DAC, TEM, a second SOI, APP3–APP12, APP15. */
  | 'unknown-marker'
  | 'duplicate-app0'
  | 'app0-not-jfif'
  /** The JFIF extension segment. It exists to carry a thumbnail. */
  | 'jfxx'
  /** A JFIF header announcing (or followed by) a thumbnail. */
  | 'jfif-thumbnail'
  /** APP2 that is not an ICC profile — MPF, which attaches a second image, included. */
  | 'app2-not-icc'
  | 'icc-too-large'
  | 'app14-not-adobe'
  /** FFDC: the frame height is defined after the fact. */
  | 'dnl'
  /** SOF3 and SOF5–SOF15: lossless, hierarchical, arithmetic. No canvas emits them. */
  | 'unsupported-frame'
  /** SOF2: no canvas emits it, and its scans are unbounded (see the header). */
  | 'progressive'
  | 'second-frame'
  /** A second SOS: a baseline photo from a canvas has exactly one. */
  | 'multiple-scans'
  /** Not 8-bit, not 1 or 3 components, or a header of the wrong size. */
  | 'bad-frame'
  | 'zero-dimension'
  | 'dimensions-too-large'
  | 'dimensions-too-small'
  | 'scan-before-frame'
  | 'no-frame'
  | 'no-scan'
  /** RSTn outside entropy-coded data. */
  | 'unexpected-restart'
  /** Anything after EOI. */
  | 'trailing-bytes';

export type JpegInspection =
  | {
      ok: true;
      /** What may be stored: the input with APP1, APP13, COM and fill bytes spliced out. */
      bytes: Uint8Array;
      width: number;
      height: number;
      /** The markers removed, in order, as `FFxx` — for the log, never their contents. */
      removed: string[];
    }
  | {
      ok: false;
      refusal: JpegRefusal;
      /** The marker refused, as `FFxx`, or null when there was none to name. */
      marker: string | null;
    };

/** Markers whose segments are spliced out rather than refused. */
const REMOVED_MARKERS = new Set([0xe1, 0xed, 0xfe]);

function hex(code: number): string {
  return `FF${code.toString(16).toUpperCase().padStart(2, '0')}`;
}

function startsWithAscii(bytes: Uint8Array, signature: string): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature.charCodeAt(i)) return false;
  }
  return true;
}

function u16(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

function refuse(refusal: JpegRefusal, code: number | null = null): JpegInspection {
  return { ok: false, refusal, marker: code === null ? null : hex(code) };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Walk `input`'s markers. Never throws on any input; every outcome is a
 * result. `limits` exists for the tests; the route uses `ID_PHOTO_LIMITS`.
 */
export function inspectJpeg(input: Uint8Array, limits: JpegLimits = ID_PHOTO_LIMITS): JpegInspection {
  const b = input;
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return refuse('not-jpeg');

  const kept: Uint8Array[] = [b.subarray(0, 2)];
  const removed: string[] = [];
  let frame: { width: number; height: number; components: number } | null = null;
  let scans = 0;
  let sawApp0 = false;
  let iccBytes = 0;
  let pos = 2;

  for (;;) {
    if (pos >= b.length) return refuse('truncated');
    // Outside entropy-coded data, the next byte MUST start a marker.
    if (b[pos] !== 0xff) return refuse('bad-segment');
    while (pos < b.length && b[pos] === 0xff) pos++; // fill bytes
    if (pos >= b.length) return refuse('truncated');
    const start = pos - 1; // the last 0xFF: fill bytes before it are dropped
    const code = b[pos]!;
    pos++;

    if (code === 0xd9) {
      // EOI — the end, and it must be the last two bytes.
      if (!frame) return refuse('no-frame', code);
      if (scans === 0) return refuse('no-scan', code);
      if (pos !== b.length) return refuse('trailing-bytes', code);
      kept.push(b.subarray(start, pos));
      return { ok: true, bytes: concat(kept), width: frame.width, height: frame.height, removed };
    }
    if (code === 0x00) return refuse('bad-segment', code);
    if (code >= 0xd0 && code <= 0xd7) return refuse('unexpected-restart', code);
    // A second SOI, TEM, and the reserved 0x02–0xBF range carry no length we trust.
    if (code === 0xd8 || code <= 0xbf) return refuse('unknown-marker', code);

    // Every remaining marker is a segment with a 2-byte length (which counts itself).
    if (pos + 2 > b.length) return refuse('truncated', code);
    const length = u16(b, pos);
    if (length < 2) return refuse('bad-segment', code);
    const end = pos + length;
    if (end > b.length) return refuse('truncated', code);
    const payload = b.subarray(pos + 2, end);
    const segment = b.subarray(start, end);
    pos = end;

    if (REMOVED_MARKERS.has(code)) {
      removed.push(hex(code));
      continue;
    }

    switch (code) {
      case 0xe0: {
        // APP0
        if (sawApp0) return refuse('duplicate-app0', code);
        sawApp0 = true;
        if (startsWithAscii(payload, 'JFXX\0')) return refuse('jfxx', code);
        if (!startsWithAscii(payload, 'JFIF\0')) return refuse('app0-not-jfif', code);
        // "JFIF\0" + version(2) + units(1) + Xdensity(2) + Ydensity(2) + Xthumb(1) + Ythumb(1)
        if (payload.length < 14) return refuse('bad-segment', code);
        if (payload[12] !== 0 || payload[13] !== 0 || payload.length !== 14) {
          return refuse('jfif-thumbnail', code);
        }
        kept.push(segment);
        break;
      }
      case 0xe2: {
        // APP2: an ICC profile chunk, "ICC_PROFILE\0" + sequence(1) + count(1) + data
        if (!startsWithAscii(payload, 'ICC_PROFILE\0')) return refuse('app2-not-icc', code);
        if (payload.length < 14) return refuse('bad-segment', code);
        iccBytes += payload.length - 14;
        if (iccBytes > limits.maxIccBytes) return refuse('icc-too-large', code);
        kept.push(segment);
        break;
      }
      case 0xee: {
        // APP14: "Adobe" + version(2) + flags0(2) + flags1(2) + transform(1)
        if (!startsWithAscii(payload, 'Adobe')) return refuse('app14-not-adobe', code);
        if (payload.length !== 12) return refuse('bad-segment', code);
        kept.push(segment);
        break;
      }
      case 0xdb: // DQT
      case 0xc4: // DHT
        kept.push(segment);
        break;
      case 0xdd: // DRI: exactly a 2-byte interval
        if (length !== 4) return refuse('bad-segment', code);
        kept.push(segment);
        break;
      case 0xdc: // DNL
        return refuse('dnl', code);
      case 0xc2: // SOF2 progressive: unbounded scans, and no canvas emits it
        return refuse('progressive', code);
      case 0xc0: // SOF0 baseline
      case 0xc1: {
        // SOF1 extended sequential
        if (frame) return refuse('second-frame', code);
        // precision(1) + height(2) + width(2) + components(1) + 3 per component
        if (payload.length < 6) return refuse('bad-frame', code);
        const precision = payload[0];
        const height = u16(payload, 1);
        const width = u16(payload, 3);
        const components = payload[5]!;
        if (precision !== 8) return refuse('bad-frame', code);
        if (components !== 1 && components !== 3) return refuse('bad-frame', code);
        if (payload.length !== 6 + 3 * components) return refuse('bad-frame', code);
        if (width === 0 || height === 0) return refuse('zero-dimension', code);
        const long = Math.max(width, height);
        const short = Math.min(width, height);
        if (long > limits.maxEdge) return refuse('dimensions-too-large', code);
        if (long < limits.minLongEdge || short < limits.minShortEdge) {
          return refuse('dimensions-too-small', code);
        }
        frame = { width, height, components };
        kept.push(segment);
        break;
      }
      case 0xda: {
        // SOS: components(1) + 2 per component + Ss, Se, AhAl
        if (!frame) return refuse('scan-before-frame', code);
        // Exactly one scan, so it must carry every component of the frame.
        if (scans > 0) return refuse('multiple-scans', code);
        const ns = payload[0] ?? 0;
        if (ns !== frame.components || payload.length !== 4 + 2 * ns) return refuse('bad-segment', code);
        // The entropy-coded data runs to the next marker that is neither a
        // stuffed zero (FF00) nor a restart (FFD0–FFD7). It is copied as is.
        let p = pos;
        for (;;) {
          if (p >= b.length) return refuse('truncated', code);
          if (b[p] !== 0xff) {
            p++;
            continue;
          }
          let q = p + 1;
          while (q < b.length && b[q] === 0xff) q++;
          if (q >= b.length) return refuse('truncated', code);
          const next = b[q]!;
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
            p = q + 1;
            continue;
          }
          break; // a real marker starts at p
        }
        kept.push(segment, b.subarray(pos, p));
        pos = p;
        scans++;
        break;
      }
      case 0xc3:
      case 0xc5:
      case 0xc6:
      case 0xc7:
      case 0xc9:
      case 0xca:
      case 0xcb:
      case 0xcd:
      case 0xce:
      case 0xcf:
        return refuse('unsupported-frame', code);
      default:
        // APP3–APP12, APP15, JPG (C8), DAC (CC), DHP, EXP, JPGn, …
        return refuse('unknown-marker', code);
    }
  }
}
