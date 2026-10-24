/**
 * Re-encode an uploaded donation QR as a clean PNG.
 *
 * Decoding and encoding again keeps only pixels: EXIF (GPS, the device),
 * XMP, ICC and every PNG text chunk are dropped, because sharp writes no
 * metadata unless asked (`withMetadata`/`keepMetadata`, never called here).
 * EXIF orientation is applied first, so a photographed card still reads
 * upright once its orientation tag is gone.
 *
 * No `server-only` import so the test suite can run it on real bytes; only
 * the donation QR route imports it. See `donations-handler.ts` for why
 * decoding is accepted on this path when `jpeg-inspect.ts` avoids it for ID
 * photos.
 */

import sharp from 'sharp';

/** Refuse anything bigger before decoding: ~16 MP is a 4000 × 4000 photo. */
export const QR_INPUT_MAX_PIXELS = 16_000_000;
/** The stored image's long edge. A bank QR scans fine at a fraction of this. */
export const QR_OUTPUT_MAX_EDGE = 1600;

export async function reencodeQrPng(bytes: Uint8Array): Promise<Uint8Array> {
  const out = await sharp(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
    limitInputPixels: QR_INPUT_MAX_PIXELS,
    failOn: 'error',
    animated: false,
  })
    .rotate()
    .resize({ width: QR_OUTPUT_MAX_EDGE, height: QR_OUTPUT_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}
