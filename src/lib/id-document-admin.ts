/**
 * The admin's view of an applicant's identity-card photo — in the browser,
 * under `storage.rules`, which let an admin READ `adoption-ids/**` and nobody
 * write it.
 *
 * ═══ ONLY `ref` AND `getBlob` ═══════════════════════════════════════════════
 * This module's only Storage imports are `ref` and `getBlob`, and it must not
 * import `pets-admin.ts` (critic 2026-10-16, #11): that file imports
 * `getDownloadURL`, and `readPhotoBlob` there has a plain `fetch(url)` branch.
 * `getDownloadURL` MINTS a download token when none exists, and a token
 * outranks every rule and can never be revoked — for an identity card that is
 * a permanent public copy. `getBlob` sends the admin's ID token instead, so the
 * bytes reach a signed-in admin and nobody else. A test walks this file's
 * imports and fails on either.
 *
 * The photo is loaded ONLY when an admin taps "Ver carnet", never in the
 * queue, and the caller revokes the object URL when it is hidden or unmounted.
 *
 * ⚠️ CORS: the bucket allows `https://wawitas.org` and localhost only
 * (`terraform/storage.tf`), so this works there and NOT on `wawitas.web.app` —
 * the same limit the private intake photos already have.
 */

'use client';

import { getBlob, ref } from 'firebase/storage';

import { getFirebase } from './firebase-client';
import { idDocumentPath } from './id-document-paths';
import type { IdDocumentSide } from './types';

/**
 * The photo as an object URL for an `<img src>`. The CALLER must revoke it
 * (`URL.revokeObjectURL`) — see `IdDocumentViewer` in ApplicationReview.tsx.
 */
export async function readIdDocumentObjectUrl(applicationId: string, side: IdDocumentSide): Promise<string> {
  const { storage } = getFirebase();
  const blob = await getBlob(ref(storage, idDocumentPath(applicationId, side)));
  return URL.createObjectURL(blob);
}
