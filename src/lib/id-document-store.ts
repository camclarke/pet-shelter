/**
 * The Storage operations on an applicant's identity-card photo, through the
 * ADMIN SDK. No Firebase import: the bucket is typed by the few methods used,
 * so every branch is tested with a fake, and the route passes the real one.
 *
 * ⚠️ The Admin SDK bypasses `storage.rules`. The ONLY caller allowed to save
 * is the upload route, after `requireUser`, the ownership checks and the JPEG
 * inspection (`id-document-handler.ts`). Deleting is for the 4e retention sweep,
 * the admin erase route, and the upload route's own clean-up when the
 * application closed mid-upload — and goes through
 * `deleteEveryIdDocumentVersion` and nothing else (a guard test).
 *
 * ═══ NO DOWNLOAD TOKEN, EVER ════════════════════════════════════════════════
 * `file.save()` posts to the GCS JSON API (`storage.googleapis.com/upload/…`),
 * not to Firebase's upload endpoint — the one that auto-mints a
 * `firebaseStorageDownloadTokens` value (`storage.rules`, private-photo block)
 * — and nothing in `@google-cloud/storage` 7.21 mentions download tokens
 * (read 2026-10-16). That GCS itself adds none is INFERRED until the 4b
 * probe measures it. Nothing here, or anywhere that builds an `adoption-ids`
 * path, may call either SDK's `getDownloadURL`: a token outranks every rule
 * and cannot be revoked. A guard test walks the imports.
 */

import { idDocumentPath, idDocumentPrefix } from './id-document-paths';
import type { IdDocumentSide } from './types';

/** Never cached by a browser, a proxy or Firebase Hosting's edge. */
export const ID_DOCUMENT_CACHE_CONTROL = 'private, no-store';

interface ObjectMetadata {
  generation?: string | number;
  size?: string | number;
}

/** The methods of `@google-cloud/storage`'s `File` this module uses. */
export interface IdDocumentFile {
  save(
    data: Buffer,
    options: {
      resumable: false;
      contentType: 'image/jpeg';
      preconditionOpts: { ifGenerationMatch: 0 };
      metadata: { cacheControl: string };
    },
  ): Promise<unknown>;
  getMetadata(): Promise<readonly [ObjectMetadata, ...unknown[]]>;
  metadata?: ObjectMetadata;
}

/** The methods of `@google-cloud/storage`'s `Bucket` this module uses. */
export interface IdDocumentBucket {
  file(path: string): IdDocumentFile;
  deleteFiles(query: { prefix: string; versions: true }): Promise<unknown>;
}

/** What the marker on the application records. Never a URL. */
export interface StoredIdDocument {
  generation: string;
  bytes: number;
}

export type SaveIdDocumentOutcome =
  | ({ outcome: 'saved' } & StoredIdDocument)
  /** An object is already at that path (HTTP 412 on `ifGenerationMatch: 0`). */
  | { outcome: 'exists' };

function isPreconditionFailed(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 412;
}

function asCount(value: string | number | undefined): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * Store one side, CREATE-ONLY: `ifGenerationMatch: 0` makes GCS refuse with a
 * 412 if anything is already at the path, so two uploads racing each other
 * cannot overwrite one another — the second learns `exists` and the handler
 * recovers the first one's receipt instead.
 */
export async function saveIdDocument(
  bucket: IdDocumentBucket,
  applicationId: string,
  side: IdDocumentSide,
  bytes: Uint8Array,
): Promise<SaveIdDocumentOutcome> {
  const file = bucket.file(idDocumentPath(applicationId, side));
  try {
    await file.save(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
      resumable: false,
      contentType: 'image/jpeg',
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: { cacheControl: ID_DOCUMENT_CACHE_CONTROL },
    });
  } catch (error) {
    if (isPreconditionFailed(error)) return { outcome: 'exists' };
    throw error;
  }
  // A simple upload sets `file.metadata` to the object resource GCS returned.
  const generation = file.metadata?.generation;
  if (generation === undefined || generation === '') {
    throw new Error('saveIdDocument: the upload returned no generation');
  }
  return { outcome: 'saved', generation: String(generation), bytes: bytes.byteLength };
}

/**
 * The receipt of what is ALREADY stored for one side, or null if nothing is —
 * for the handler's recovery after an `exists`: the save went through on an
 * earlier attempt and only the marker write failed.
 */
export async function readIdDocumentReceipt(
  bucket: IdDocumentBucket,
  applicationId: string,
  side: IdDocumentSide,
): Promise<StoredIdDocument | null> {
  try {
    const [metadata] = await bucket.file(idDocumentPath(applicationId, side)).getMetadata();
    const bytes = asCount(metadata.size);
    if (metadata.generation === undefined || metadata.generation === '' || bytes === null) return null;
    return { generation: String(metadata.generation), bytes };
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 404) return null;
    throw error;
  }
}

/**
 * Delete EVERY version of an application's ID photos — live and noncurrent.
 *
 * ⚠️ THE ONLY WAY anything under `adoption-ids/` is deleted (a guard test).
 * This bucket keeps versions (`terraform/storage.tf`), and a delete that does
 * not name generations only makes the live object NONCURRENT: it stays,
 * readable by the Admin SDK, until the lifecycle rule fires — at least a day,
 * plus a lag GCS refuses to bound — and then sits 7 more days in soft delete
 * (critic 2026-10-16, #8). With `versions: true` the SDK lists every
 * generation and deletes each BY generation, so each goes straight to soft
 * delete: about 7 days, which is what /privacy will say.
 *
 * With `side`, only that side's object — every version of
 * `adoption-ids/{applicationId}/{side}.jpg`, and nothing else in the folder.
 * The upload route uses that form when the application closed or was erased
 * while the upload was in flight (review 4b #1): the photo it had just stored
 * must not outlive the refusal, and the OTHER side, already received, is not
 * its to touch. No other object name starts with `{side}.jpg`, so the prefix
 * names exactly that object's generations.
 */
export async function deleteEveryIdDocumentVersion(
  bucket: IdDocumentBucket,
  applicationId: string,
  side?: IdDocumentSide,
): Promise<void> {
  const prefix = side === undefined ? idDocumentPrefix(applicationId) : idDocumentPath(applicationId, side);
  await bucket.deleteFiles({ prefix, versions: true });
}
