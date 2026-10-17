/**
 * The WIRE CONTRACT of the admin's erase action — what the admin screen and
 * the route agree on. Pure, and no imports at all.
 *
 *     POST /api/adoption-applications/{applicationId}/erase-identity
 *     body: { "reason": "returned" | "died" | "not-adopted" }
 */

export function identityErasePath(applicationId: string): string {
  return `/api/adoption-applications/${encodeURIComponent(applicationId)}/erase-identity`;
}

/**
 * Why the data is erased. Owner decision, 2026-10-17: NOTHING is erased
 * automatically; an admin erases, and says why.
 *   - `returned`:    the animal came back to the shelter (the retention clause:
 *                    "formalizada su devolución al albergue");
 *   - `died`:        the animal died of NATURAL causes (the clause's own words:
 *                    "fallecimiento por causas naturales"). A death by abuse is
 *                    exactly when the data serves its third purpose — a
 *                    complaint to POFOMA or the Ministerio Público — so it is
 *                    never erased under this reason;
 *   - `not-adopted`: the application was rejected or withdrawn, so no custody
 *                    ever began.
 */
export const ERASE_REASONS = ['returned', 'died', 'not-adopted'] as const;
export type EraseReason = (typeof ERASE_REASONS)[number];

export function isEraseReason(value: unknown): value is EraseReason {
  return typeof value === 'string' && (ERASE_REASONS as readonly string[]).includes(value);
}

/** Stamped on every failure the HANDLER writes. Its absence means the edge answered. */
export const IDENTITY_ERASE_FAILURE_HEADER = 'X-Identity-Erase-Failure';

export type IdentityEraseFailure =
  | 'unauthenticated'
  | 'forbidden'
  | 'bad-reason'
  | 'not-found'
  | 'reason-mismatch'
  | 'still-in-custody'
  | 'application-read-failed'
  | 'erase-failed';

export const IDENTITY_ERASE_FAILURES: readonly IdentityEraseFailure[] = [
  'unauthenticated',
  'forbidden',
  'bad-reason',
  'not-found',
  'reason-mismatch',
  'still-in-custody',
  'application-read-failed',
  'erase-failed',
];

export function identityEraseFailure(response: {
  ok: boolean;
  headers: { get(name: string): string | null };
}): IdentityEraseFailure | 'unexpected' | null {
  if (response.ok) return null;
  const header = response.headers.get(IDENTITY_ERASE_FAILURE_HEADER);
  return (IDENTITY_ERASE_FAILURES as readonly string[]).includes(header ?? '')
    ? (header as IdentityEraseFailure)
    : 'unexpected';
}
