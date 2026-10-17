/**
 * The WIRE CONTRACT of the ID-photo upload route — what the browser and the
 * route must agree on, and nothing else. Pure, and no imports at all.
 *
 *     POST /api/adoption-applications/{applicationId}/id-document/{side}
 *
 * Split out of `id-document-handler.ts` in portion 4c-2 (plan §5.2) so the
 * applicant's browser can read a response without bundling the handler and
 * what it imports — `requireUser`, `readCapped`, the store's types. The
 * handler re-exports every name here, so its tests and the route did not
 * change. A test pins that the applicant side's import closure reaches this
 * file and NOT the handler.
 */

/**
 * The largest body accepted: about 1.5 MB. A 2048 px JPEG at the browser's
 * 0.85 quality is about 1 MB at most (INFERRED), and every extra megabyte is
 * ~30 s on a 256 kbps phone uplink against Firebase Hosting's 60 s ceiling.
 * The browser checks the same number before it sends anything (4c-2).
 */
export const ID_DOCUMENT_MAX_BYTES = 1_536 * 1024;

/** Stamped on every failure the HANDLER writes. Its absence means the edge answered. */
export const ID_DOCUMENT_FAILURE_HEADER = 'X-Id-Document-Failure';

export type IdDocumentFailure =
  | 'unauthenticated'
  | 'disabled'
  | 'not-yours'
  | 'unknown-side'
  | 'not-jpeg'
  | 'too-large'
  | 'too-slow'
  | 'not-open'
  | 'erased'
  | 'already-received'
  | 'application-read-failed'
  | 'body-read-failed'
  | 'photo-too-small'
  | 'not-clean-jpeg'
  | 'save-failed'
  | 'marker-failed';

export const ID_DOCUMENT_FAILURES: readonly IdDocumentFailure[] = [
  'unauthenticated',
  'disabled',
  'not-yours',
  'unknown-side',
  'not-jpeg',
  'too-large',
  'too-slow',
  'not-open',
  'erased',
  'already-received',
  'application-read-failed',
  'body-read-failed',
  'photo-too-small',
  'not-clean-jpeg',
  'save-failed',
  'marker-failed',
];

/**
 * The browser's reading of a response: null on success, one of our failures
 * when the handler wrote the header, `unexpected` when it did not — Firebase
 * Hosting's own 503 or 504 carries no header, and must not be read as ours.
 */
export function idDocumentFailure(response: {
  ok: boolean;
  headers: { get(name: string): string | null };
}): IdDocumentFailure | 'unexpected' | null {
  if (response.ok) return null;
  const header = response.headers.get(ID_DOCUMENT_FAILURE_HEADER);
  return (ID_DOCUMENT_FAILURES as readonly string[]).includes(header ?? '')
    ? (header as IdDocumentFailure)
    : 'unexpected';
}
