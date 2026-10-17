/**
 * The WIRE CONTRACT of the consent-record route — what the browser and the
 * route must agree on, and nothing else. Pure, and no imports at all, so the
 * applicant's browser can read a response without bundling the handler.
 *
 *     POST /api/adoption-applications/{applicationId}/acceptance
 *
 * No body. The route records, once, the audit trail the contract's first
 * additional clause promises: when, from which IP, by which account.
 */

/** The route for one application. The id is encoded; the server re-checks it. */
export function acceptancePath(applicationId: string): string {
  return `/api/adoption-applications/${encodeURIComponent(applicationId)}/acceptance`;
}

/** Stamped on every failure the HANDLER writes. Its absence means the edge answered. */
export const ACCEPTANCE_FAILURE_HEADER = 'X-Acceptance-Failure';

export type AcceptanceFailure =
  | 'unauthenticated'
  | 'disabled'
  | 'not-yours'
  | 'not-found'
  | 'not-open'
  | 'erased'
  | 'application-read-failed'
  | 'record-failed';

export const ACCEPTANCE_FAILURES: readonly AcceptanceFailure[] = [
  'unauthenticated',
  'disabled',
  'not-yours',
  'not-found',
  'not-open',
  'erased',
  'application-read-failed',
  'record-failed',
];

/**
 * The browser's reading of a response: null on success (201 recorded now, 200
 * recorded before), one of our failures when the handler wrote the header,
 * `unexpected` when it did not — Firebase Hosting's own 503 or 504 carries no
 * header, and must not be read as ours.
 */
export function acceptanceFailure(response: {
  ok: boolean;
  headers: { get(name: string): string | null };
}): AcceptanceFailure | 'unexpected' | null {
  if (response.ok) return null;
  const header = response.headers.get(ACCEPTANCE_FAILURE_HEADER);
  return (ACCEPTANCE_FAILURES as readonly string[]).includes(header ?? '')
    ? (header as AcceptanceFailure)
    : 'unexpected';
}
