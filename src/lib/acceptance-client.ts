/**
 * The applicant's browser asking the server to record the audit trail of their
 * consent (`POST /api/adoption-applications/{id}/acceptance`). See
 * `acceptance-handler.ts` for what is recorded and why.
 *
 * Called right after the application is written, before the ID photo, and
 * again from «Mis solicitudes» for an open application, in case the first
 * call was lost: the route records ONCE, so a repeat changes nothing.
 *
 * Never throws. A failure is not shown to the applicant as a problem with
 * their application — the admin screen blocks approval until a record exists
 * (`acceptance-missing`), and the next visit to «Mis solicitudes» tries again.
 */

import type { User } from 'firebase/auth';
import { acceptanceFailure, acceptancePath, type AcceptanceFailure } from './acceptance-protocol';

export type RecordAcceptanceOutcome = { ok: true } | { ok: false; failure: AcceptanceFailure | 'unexpected' | 'network' };

export interface RecordAcceptanceDeps {
  fetch: typeof fetch;
  timeoutMs: number;
  /** Attempts in all, for the failures a second try can fix. */
  attempts: number;
}

const DEPS: RecordAcceptanceDeps = { fetch: (...args) => fetch(...args), timeoutMs: 20_000, attempts: 2 };

/** Failures worth one more try: the edge, the network, or a write that did not land. */
function retryable(failure: AcceptanceFailure | 'unexpected' | 'network'): boolean {
  return failure === 'network' || failure === 'unexpected' || failure === 'record-failed' || failure === 'application-read-failed';
}

export async function recordAcceptance(
  user: Pick<User, 'getIdToken'>,
  applicationId: string,
  deps: RecordAcceptanceDeps = DEPS,
): Promise<RecordAcceptanceOutcome> {
  let last: RecordAcceptanceOutcome = { ok: false, failure: 'network' };
  for (let attempt = 0; attempt < Math.max(1, deps.attempts); attempt += 1) {
    try {
      const token = await user.getIdToken();
      const response = await deps.fetch(acceptancePath(applicationId), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(deps.timeoutMs),
      });
      const failure = acceptanceFailure(response);
      if (failure === null) return { ok: true };
      last = { ok: false, failure };
    } catch {
      last = { ok: false, failure: 'network' };
    }
    if (!retryable(last.failure)) return last;
  }
  return last;
}
