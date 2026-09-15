/**
 * The browser's photo pipeline: decode, orient, resize, re-encode — and in
 * doing so strip every byte of metadata. Client Components only.
 *
 * Moved out of `pets-admin.ts` on 2026-09-15 so a profile photo goes through
 * the SAME pipeline as a pet photo without the account page importing the
 * whole admin write module. `pets-admin.ts` re-exports both names, so its
 * existing callers did not change.
 */

'use client';

/** Long edge, in pixels. The wall renders at 480×600; this leaves headroom. */
export const PHOTO_MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;

/**
 * Thrown when the browser cannot decode the chosen file at all.
 *
 * Worth its own error rather than a generic failure: `accept="image/*"` lets a
 * phone offer formats Chrome cannot decode — HEIC from an iPhone is the common
 * one — and "no pudimos guardar" would send someone looking at their internet
 * connection when the real answer is "that photo is in a format we can't read,
 * send it another way".
 */
export class PhotoUnreadableError extends Error {
  constructor(cause?: unknown) {
    super('photo-unreadable');
    this.name = 'PhotoUnreadableError';
    this.cause = cause;
  }
}

/**
 * Re-encode an image through a canvas, and in doing so strip its metadata.
 *
 * ⚠️ **This is a privacy control, not an optimisation.** A photo taken in a
 * foster home carries GPS coordinates in its EXIF, so publishing it publishes
 * a volunteer's home address — the project log concern #2, arriving through the
 * image pipeline rather than the location field. A profile photo taken at home
 * carries the same thing about the person. `scripts/seed-pet.mjs` does the
 * same job with sharp on the server; this is the browser's equivalent and
 * must not be removed to "keep the original quality".
 *
 * A canvas has no way to carry EXIF through, so the stripping is structural
 * rather than a flag we remember to set.
 *
 * ── The orientation trap ───────────────────────────────────────────────────
 * Dropping EXIF also drops the EXIF *orientation* flag, which is how phones
 * record "this was shot in portrait" without rotating the pixels. Re-encoding
 * naively therefore publishes sideways photographs — and the original looks
 * correct in every viewer, so the bug appears to be ours alone.
 * `createImageBitmap(blob, { imageOrientation: 'from-image' })` applies the
 * rotation to the pixels before we draw, which is exactly what we want:
 * the orientation is baked in, then the tag is discarded with everything else.
 *
 * @param maxEdge Long edge in pixels. Animals use the 1600 default; a
 *   vaccination card passes `CARD_PHOTO_MAX_EDGE`, because a lot number on a
 *   sticker is a couple of millimetres tall; a profile photo passes
 *   `AVATAR_MAX_EDGE`. The EXIF guarantee is identical at any size — it comes
 *   from the canvas re-encode, not from the scaling.
 */
export async function stripAndResize(file: File, maxEdge: number = PHOTO_MAX_EDGE): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (cause) {
    throw new PhotoUnreadableError(cause);
  }

  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas-unavailable');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
  );
  if (!blob) throw new Error('encode-failed');
  return blob;
}
