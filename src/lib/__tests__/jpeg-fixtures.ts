/**
 * Hand-built JPEG byte sequences for the inspector and the upload handler.
 * NOT a test file (it is not in package.json's list): only the marker
 * STRUCTURE is real. The "entropy-coded data" is a few bytes chosen to contain
 * a stuffed zero (FF00) and a restart marker (FFD0), which is all the walker
 * reads of it — nothing here decodes, and nothing needs to.
 */

export const SOI = [0xff, 0xd8];
export const EOI = [0xff, 0xd9];

export function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

/** A segment: FF, code, a 2-byte length that counts itself, the payload. */
export function seg(code: number, payload: readonly number[]): number[] {
  const length = payload.length + 2;
  return [0xff, code, (length >> 8) & 0xff, length & 0xff, ...payload];
}

/** APP0 JFIF 1.01, 72 dpi, with an optional thumbnail. */
export function jfif(thumbWidth = 0, thumbHeight = 0, thumbBytes: readonly number[] = []): number[] {
  return seg(0xe0, [...ascii('JFIF\0'), 1, 1, 1, 0, 72, 0, 72, thumbWidth, thumbHeight, ...thumbBytes]);
}

/** APP2 ICC_PROFILE chunk `sequence` of `count`, with `dataBytes` of profile data. */
export function icc(dataBytes = 524, sequence = 1, count = 1): number[] {
  return seg(0xe2, [...ascii('ICC_PROFILE\0'), sequence, count, ...new Array<number>(dataBytes).fill(0x41)]);
}

/** APP1 Exif carrying a recognisable "GPS" payload, so tests can prove it is gone. */
export function exif(): number[] {
  return seg(0xe1, [...ascii('Exif\0\0'), ...ascii('MM'), ...ascii('GPSLatitude-17.3935GPSLongitude-66.1570')]);
}

export function xmp(): number[] {
  return seg(0xe1, [...ascii('http://ns.adobe.com/xap/1.0/\0'), ...ascii('<x:xmpmeta>GPS</x:xmpmeta>')]);
}

export function iptc(): number[] {
  return seg(0xed, [...ascii('Photoshop 3.0\0'), ...ascii('8BIM'), 0x04, 0x04, ...ascii('GPS')]);
}

export function comment(text = 'taken at home GPS'): number[] {
  return seg(0xfe, ascii(text));
}

export function adobe(): number[] {
  return seg(0xee, [...ascii('Adobe'), 0, 100, 0, 0, 0, 0, 1]);
}

export function dqt(): number[] {
  return seg(0xdb, [0x00, ...new Array<number>(64).fill(1)]);
}

export function dht(): number[] {
  return seg(0xc4, [0x00, 1, ...new Array<number>(15).fill(0), 0x00]);
}

export function dri(interval = 4): number[] {
  return seg(0xdd, [(interval >> 8) & 0xff, interval & 0xff]);
}

/** A frame header: SOF0 by default, 2048 × 1536, 8-bit, 3 components. */
export function sof(
  options: { code?: number; width?: number; height?: number; components?: number; precision?: number } = {},
): number[] {
  const { code = 0xc0, width = 2048, height = 1536, components = 3, precision = 8 } = options;
  const comps: number[] = [];
  for (let i = 1; i <= components; i++) comps.push(i, 0x11, 0x00);
  return seg(code, [precision, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, components, ...comps]);
}

/** A scan header for `components` components. */
export function sosHeader(components = 3): number[] {
  const comps: number[] = [];
  for (let i = 1; i <= components; i++) comps.push(i, 0x00);
  return seg(0xda, [components, ...comps, 0x00, 0x3f, 0x00]);
}

/** Entropy-coded bytes with a stuffed zero and a restart marker inside. */
export const ENTROPY = [0x12, 0x34, 0xff, 0x00, 0x56, 0xd5, 0xff, 0xd0, 0x78, 0x9a, 0xbc];

export function scan(components = 3): number[] {
  return [...sosHeader(components), ...ENTROPY];
}

export function jpeg(...parts: readonly (readonly number[])[]): Uint8Array {
  return Uint8Array.from([...SOI, ...parts.flat(), ...EOI]);
}

/** What desktop Chrome's canvas emits, in marker order (MEASURED 2026-08-23): FFE0 FFE2 FFDB FFDB FFC0 FFC4×4 FFDA. */
export function chromeLikeJpeg(options: { width?: number; height?: number } = {}): Uint8Array {
  return jpeg(jfif(), icc(), dqt(), dqt(), sof(options), dht(), dht(), dht(), dht(), scan());
}

export function bytesInclude(haystack: Uint8Array, needle: string): boolean {
  const n = ascii(needle);
  outer: for (let i = 0; i + n.length <= haystack.length; i++) {
    for (let j = 0; j < n.length; j++) if (haystack[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}
