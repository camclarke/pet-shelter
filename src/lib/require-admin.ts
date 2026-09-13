/**
 * The admin check every API route runs FIRST.
 *
 * ═══ ROUTE HANDLERS SIT OUTSIDE `firestore.rules` ════════════════════════════
 * Every other admin action goes from the browser to Firestore, where the rules
 * are the boundary and `AdminGate` is only UX. A route handler is different:
 * it holds a secret, spends quota, or writes through the Admin SDK, which
 * bypasses the rules. So this check IS the boundary, and nothing else catches
 * a lapse in it.
 *
 * Until 2026-09-13 four routes each hand-rolled it — parse the Bearer token,
 * `verifyIdToken(token, true)`, 401, then 403. The copies were identical,
 * which is exactly the state in which one of them gets "simplified" on its
 * own. `require-admin.test.ts` fails if a route under `src/app/api` stops
 * calling this before it reads its body or checks configuration, or parses a
 * Bearer header itself.
 *
 * Pure: the verifier is injected, so every branch is tested without
 * firebase-admin. Routes pass `verifyAdminIdToken` from `firebase-admin.ts`.
 *
 * It returns a RESULT, not a Response, because each route stamps its own
 * failure header (`X-Suggest-Failure`, `X-Card-Failure`, …) — and that
 * header's ABSENCE on a 5xx is how the browser tells our failures from the
 * edge's.
 */

/** The fields of a verified ID token this check reads. */
export interface VerifiedIdToken {
  uid: string;
  email?: string | null;
  admin?: unknown;
}

export type VerifyIdToken = (token: string, checkRevoked: boolean) => Promise<VerifiedIdToken>;

export type AdminCheck =
  | { ok: true; uid: string; email: string | null }
  | { ok: false; error: 'unauthenticated'; status: 401 }
  | { ok: false; error: 'forbidden'; status: 403 };

const UNAUTHENTICATED: AdminCheck = { ok: false, error: 'unauthenticated', status: 401 };
const FORBIDDEN: AdminCheck = { ok: false, error: 'forbidden', status: 403 };

/** The token from `Authorization: Bearer <token>`, or '' when there is none. */
function bearerToken(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

/**
 * @returns `ok: true` with the caller's uid, and email when it has a usable
 *   one — callers attribute a write to `email ?? uid`. Otherwise the error and
 *   status the route should answer with.
 */
export async function requireAdmin(
  request: Request,
  verifyIdToken: VerifyIdToken
): Promise<AdminCheck> {
  const token = bearerToken(request);
  // Refused without calling the verifier, so an anonymous request costs nothing.
  if (!token) return UNAUTHENTICATED;

  let decoded: VerifiedIdToken;
  try {
    // checkRevoked, always. A revoked admin must lose access immediately: the
    // one-hour custom-claim lag that AdminGate papers over cuts both ways, and
    // on paths that spend quota and write medical and food data the strict
    // side is the safe one.
    decoded = await verifyIdToken(token, true);
  } catch {
    return UNAUTHENTICATED;
  }

  // `=== true`, never truthiness: "true" or 1 is not the claim that
  // `scripts/grant-admin.mjs` writes.
  if (decoded.admin !== true) return FORBIDDEN;

  return { ok: true, uid: decoded.uid, email: decoded.email?.trim() || null };
}
