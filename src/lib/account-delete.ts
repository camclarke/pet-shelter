/**
 * POST /api/account/delete — a person deleting their OWN account.
 *
 * No `server-only`, no Firebase import: the route injects token verification
 * and the three Admin SDK deletes, so every branch is unit-tested with fakes
 * (the `cook-batch-handler.ts` split). The browser imports the constants and
 * `accountDeleteFailure()` from here too, so both halves agree on one header.
 *
 * ═══ WHY THIS IS A ROUTE AND NOT A CLIENT CALL ═══════════════════════════════
 * `firestore.rules` lets only an admin delete `users/{uid}` — a deny proven by
 * the 2026-08-23 probe — and Firebase does not cascade an Auth deletion to
 * Firestore or Storage. The project log already records the result of that
 * gap twice: orphaned profile documents that survived a cleanup "verified at
 * zero". So the profile, the uploaded photos and the Auth user are deleted
 * together here, in that order: a failure part-way leaves an account that can
 * still sign in and heal its profile, never a profile nobody can reach.
 *
 * ═══ WHAT IS KEPT, DELIBERATELY ═════════════════════════════════════════════
 * Adoption applications and adoption records are the SHELTER's records of what
 * happened to an animal. Deleting an account does not erase them, and the
 * screen says so before anyone confirms. Erasing them is a request to the
 * shelter, which can act on it — a decision recorded as the owner's to revisit.
 *
 * ═══ THE CHECKS, IN ORDER ═══════════════════════════════════════════════════
 *   1. a verified token (`checkRevoked`)          → 401 unauthenticated
 *   2. not an admin account                       → 403 admin-account
 *      An admin deleting themselves from a phone could leave the shelter with
 *      no one able to enter an animal. Revoke the claim first, by script.
 *   3. a sign-in from the last five minutes       → 403 requires-recent-login
 *      A borrowed, still-signed-in phone must not be enough to erase someone.
 */

import { requireUser, type VerifyIdToken } from './require-admin';
import { RECENT_SIGN_IN_MAX_AGE_S } from './profile';

export const ACCOUNT_DELETE_PATH = '/api/account/delete';

/** Stamped on every failure THIS handler writes. Its absence means the edge answered. */
export const ACCOUNT_FAILURE_HEADER = 'X-Account-Failure';

export type AccountDeleteFailure = 'unauthenticated' | 'admin-account' | 'requires-recent-login' | 'delete-failed';

const FAILURES: readonly AccountDeleteFailure[] = [
  'unauthenticated',
  'admin-account',
  'requires-recent-login',
  'delete-failed',
];

export interface AccountDeleteDeps {
  verifyIdToken: VerifyIdToken;
  /** Every object under `users/{uid}/`. */
  deleteAvatars(uid: string): Promise<void>;
  deleteProfile(uid: string): Promise<void>;
  deleteAuthUser(uid: string): Promise<void>;
  nowMs(): number;
  log(message: string, err?: unknown): void;
}

function failure(reason: AccountDeleteFailure, status: number): Response {
  return new Response(JSON.stringify({ error: reason }), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      [ACCOUNT_FAILURE_HEADER]: reason,
    },
  });
}

export async function handleAccountDelete(request: Request, deps: AccountDeleteDeps): Promise<Response> {
  const caller = await requireUser(request, deps.verifyIdToken);
  if (!caller.ok) return failure('unauthenticated', 401);

  if (caller.admin) return failure('admin-account', 403);

  // A token with no auth_time, or one older than the window, is refused. A
  // slightly FUTURE auth_time (clock skew) is a negative age and passes.
  const ageS = caller.authTimeS === null ? Number.POSITIVE_INFINITY : deps.nowMs() / 1000 - caller.authTimeS;
  if (!(ageS <= RECENT_SIGN_IN_MAX_AGE_S)) return failure('requires-recent-login', 403);

  // The uid comes from the VERIFIED token. Nothing in the request body is read.
  const { uid } = caller;
  try {
    await deps.deleteAvatars(uid);
    await deps.deleteProfile(uid);
    await deps.deleteAuthUser(uid);
  } catch (err) {
    deps.log(`[account-delete] failed for uid ${uid}`, err);
    return failure('delete-failed', 500);
  }

  return new Response(JSON.stringify({ deleted: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * The browser's reading of a response: null on success, one of our failures
 * when we wrote the header, `unexpected` when we did not — Firebase Hosting's
 * own 503 or 504 carries no header, and must not be read as one of ours.
 */
export function accountDeleteFailure(response: {
  ok: boolean;
  headers: { get(name: string): string | null };
}): AccountDeleteFailure | 'unexpected' | null {
  if (response.ok) return null;
  const header = response.headers.get(ACCOUNT_FAILURE_HEADER);
  return (FAILURES as readonly string[]).includes(header ?? '') ? (header as AccountDeleteFailure) : 'unexpected';
}
