/**
 * The APPLICANT's side of the identity-card photo (portion 4c-2, plan §5.2–5.3):
 * prepare the photo in the browser, then send it to the upload route.
 *
 * ═══ NEVER FIREBASE STORAGE ════════════════════════════════════════════════
 * The applicant never touches Storage. An upload through the Firebase client
 * SDK auto-mints a download token, and a token outranks `storage.rules` for
 * good — for an identity card that is a permanent public copy. So the photo
 * goes to `POST /api/adoption-applications/{id}/id-document/{side}`, which
 * stores it through the Admin SDK (no token) and writes the receipt the
 * approval rule needs. This module imports nothing from `firebase/storage`
 * and nothing from `pets-admin.ts` (which imports `getDownloadURL`), and a
 * test walks the applicant side's whole import closure to keep it that way.
 *
 * ═══ CHECKED HERE BEFORE THE APPLICATION EXISTS ════════════════════════════
 * `prepareIdPhoto` runs the browser re-encode (`stripAndResize`, which drops
 * EXIF — GPS, for a photo taken at home, is the home) and then the SAME
 * marker walk the route stores through (`inspectJpeg` with `ID_PHOTO_LIMITS`).
 * A photo the server would refuse is refused at step 2 of the form, not after
 * the application has been written and nothing can be changed. What is sent
 * is exactly the bytes that passed.
 *
 * ⚠️ Never logs. The photo, the application and the answers stay out of the
 * console; callers log an error code at most.
 *
 * ⚠️ No user-facing words. See `src/i18n` (`t.applicationSteps`).
 */

'use client';

import type { User } from 'firebase/auth';

import { ID_PHOTO_LIMITS, ID_PHOTO_MAX_EDGE, inspectJpeg, type JpegLimits } from './jpeg-inspect';
import { PhotoUnreadableError, stripAndResize } from './image-strip';
import {
  ID_DOCUMENT_MAX_BYTES,
  idDocumentFailure,
  type IdDocumentFailure,
} from './id-document-protocol';
import type { IdDocumentSide } from './types';

/**
 * The long edge of the second, smaller encode, used only when the first is
 * over `ID_DOCUMENT_MAX_BYTES` (plan §5.3). Still well above the 1000 px floor
 * the route stores (`ID_PHOTO_MIN_LONG_EDGE`), so print stays legible.
 */
export const ID_PHOTO_FALLBACK_EDGE = 1600;

/** A photo that passed the in-browser check: exactly the bytes to upload. */
export interface PreparedIdPhoto {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/** Why a chosen file cannot be used. Each has its own sentence in `t.applicationSteps`. */
export type IdPhotoProblem =
  /** The browser cannot decode it at all (HEIC on a desktop browser is the common one). */
  | 'unreadable'
  /** Smaller than the route stores: the card's print would not be legible. */
  | 'too-small'
  /** Any other inspector refusal, or still over the size cap after the second encode. */
  | 'rejected'
  /** The canvas or the encoder failed — not the file's fault. */
  | 'failed';

export type PreparedOutcome = { ok: true; photo: PreparedIdPhoto } | { ok: false; problem: IdPhotoProblem };

export interface PrepareDeps {
  /** `stripAndResize`; injectable because Node has no canvas. */
  strip: (file: File, maxEdge: number) => Promise<Blob>;
  limits: JpegLimits;
  maxBytes: number;
}

const PREPARE_DEPS: PrepareDeps = { strip: stripAndResize, limits: ID_PHOTO_LIMITS, maxBytes: ID_DOCUMENT_MAX_BYTES };

async function encodeAndInspect(
  file: File,
  maxEdge: number,
  deps: PrepareDeps,
): Promise<PreparedOutcome> {
  let blob: Blob;
  try {
    blob = await deps.strip(file, maxEdge);
  } catch (caught) {
    return { ok: false, problem: caught instanceof PhotoUnreadableError ? 'unreadable' : 'failed' };
  }
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(await blob.arrayBuffer());
  } catch {
    return { ok: false, problem: 'failed' };
  }
  const inspected = inspectJpeg(raw, deps.limits);
  if (!inspected.ok) {
    return { ok: false, problem: inspected.refusal === 'dimensions-too-small' ? 'too-small' : 'rejected' };
  }
  return { ok: true, photo: { bytes: inspected.bytes, width: inspected.width, height: inspected.height } };
}

/**
 * Re-encode, check, and — only if the result is over the size cap — re-encode
 * once more at `ID_PHOTO_FALLBACK_EDGE`. Never throws.
 */
export async function prepareIdPhoto(file: File, deps: PrepareDeps = PREPARE_DEPS): Promise<PreparedOutcome> {
  const first = await encodeAndInspect(file, ID_PHOTO_MAX_EDGE, deps);
  if (!first.ok || first.photo.bytes.length <= deps.maxBytes) return first;
  const second = await encodeAndInspect(file, ID_PHOTO_FALLBACK_EDGE, deps);
  if (!second.ok) return second;
  return second.photo.bytes.length <= deps.maxBytes ? second : { ok: false, problem: 'rejected' };
}

// ─────────────────────────────────────────────────────────────────────────────
// The upload
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The route's URL for one side. NOT a Storage path — the applicant never
 * learns one — and it ends in `[side]`, never `.jpg` (Hosting's cache-header
 * rule for `*.jpg` would match it).
 */
export function idDocumentUploadUrl(applicationId: string, side: IdDocumentSide): string {
  return `/api/adoption-applications/${encodeURIComponent(applicationId)}/id-document/${side}`;
}

/** What the screen needs to decide. `network`: the request never got an answer. */
export type IdUploadOutcome =
  | { ok: true }
  | { ok: false; failure: IdDocumentFailure | 'unexpected' | 'network' };

/** Coarser than the route's codes on purpose: one sentence and one next step each. */
export type IdUploadProblem =
  /** Worth trying again with the same photo: the network, the edge, or a server step. */
  | 'retry'
  /** The application is closed or its identity erased: no upload can succeed. */
  | 'closed'
  /** The session is gone or names someone else: sign in again. */
  | 'sign-in'
  /** Online applications are switched off (the kill switch, critic #10). */
  | 'paused'
  /** The route refused the photo itself as too small to read. */
  | 'photo-too-small'
  /** The route refused the photo's bytes. */
  | 'photo-rejected';

/**
 * Which problem a failure is (plan §5.4). `already-received` never reaches
 * here: `uploadIdDocument` reports it as success.
 */
export function idUploadProblem(failure: IdDocumentFailure | 'unexpected' | 'network'): IdUploadProblem {
  switch (failure) {
    case 'not-open':
    case 'erased':
      return 'closed';
    case 'not-yours':
    case 'unauthenticated':
      return 'sign-in';
    case 'disabled':
      return 'paused';
    case 'photo-too-small':
      return 'photo-too-small';
    case 'not-jpeg':
    case 'not-clean-jpeg':
      return 'photo-rejected';
    default:
      // too-large, too-slow, body-read-failed, save-failed, marker-failed,
      // application-read-failed, unknown-side, already-received (unreachable),
      // unexpected (Hosting's own 5xx), network.
      return 'retry';
  }
}

/**
 * Can THIS photo be sent again as it is? Only after a `retry` problem — the
 * network, the edge, a server step. After anything else the screen drops the
 * photo and revokes its preview (review 4c-2 #8): a closed or paused
 * application cannot take it, a lost session loses the tab's state anyway,
 * and bytes the route refused would only be refused again.
 */
export function keepsPhotoForRetry(problem: IdUploadProblem): boolean {
  return problem === 'retry';
}

/**
 * May the person still upload it LATER, from «Mis solicitudes»? Not when the
 * application is closed or applications are paused — saying so there would be
 * a promise the route then refuses (review 4c-2 #6).
 */
export function canUploadLater(problem: IdUploadProblem): boolean {
  return problem !== 'closed' && problem !== 'paused';
}

export interface UploadDeps {
  fetch: typeof fetch;
  /** The whole request. Hosting cuts at 60 s; past this a phone has simply lost signal. */
  timeoutMs: number;
}

const UPLOAD_DEPS: UploadDeps = { fetch: (...args) => fetch(...args), timeoutMs: 90_000 };

/**
 * POST the prepared bytes, raw `image/jpeg`, with the user's ID token. Never
 * throws, and nothing in the answer can be used to read the photo (the route
 * returns an empty 201).
 *
 * `already-received` counts as success: a retry after a response lost at the
 * edge finds the photo already there, which is what the person wanted.
 */
export async function uploadIdDocument(
  user: Pick<User, 'getIdToken'>,
  applicationId: string,
  side: IdDocumentSide,
  photo: PreparedIdPhoto,
  deps: UploadDeps = UPLOAD_DEPS,
): Promise<IdUploadOutcome> {
  try {
    const token = await user.getIdToken();
    // A copy, so the body is an ArrayBuffer-backed view whatever `bytes` is.
    const body = new Blob([new Uint8Array(photo.bytes)], { type: 'image/jpeg' });
    const response = await deps.fetch(idDocumentUploadUrl(applicationId, side), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' },
      body,
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    const failure = idDocumentFailure(response);
    if (failure === null || failure === 'already-received') return { ok: true };
    return { ok: false, failure };
  } catch {
    return { ok: false, failure: 'network' };
  }
}
