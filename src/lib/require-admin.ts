/**
 * The identity check every API route runs FIRST.
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
 * `requireUser` (added 2026-09-15, for `/api/account/delete`) is the same
 * check without the admin claim: any signed-in account acting on ITSELF. The
 * Bearer parsing and the `checkRevoked` verification are shared, so there is
 * still one copy of each.
 *
 * Pure: the verifier is injected, so every branch is tested without
 * firebase-admin. Routes pass `verifyIdToken` from `firebase-admin.ts`.
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
  /** Seconds since the epoch of the sign-in this token descends from. */
  auth_time?: number;
}

export type VerifyIdToken = (token: string, checkRevoked: boolean) => Promise<VerifiedIdToken>;

export type AdminCheck =
  | { ok: true; uid: string; email: string | null }
  | { ok: false; error: 'unauthenticated'; status: 401 }
  | { ok: false; error: 'forbidden'; status: 403 };

export type UserCheck =
  | {
      ok: true;
      uid: string;
      email: string | null;
      /** Whether the token carries the admin claim, exactly `true`. */
      admin: boolean;
      /** When the person last actually signed in, or null if the token does not say. */
      authTimeS: number | null;
    }
  | { ok: false; error: 'unauthenticated'; status: 401 };

const UNAUTHENTICATED = { ok: false, error: 'unauthenticated', status: 401 } as const;
const FORBIDDEN: AdminCheck = { ok: false, error: 'forbidden', status: 403 };

/** The token from `Authorization: Bearer <token>`, or '' when there is none. */
function bearerToken(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

/** The verified token, or null for no token or a token that fails verification. */
async function verifiedToken(request: Request, verifyIdToken: VerifyIdToken): Promise<VerifiedIdToken | null> {
  const token = bearerToken(request);
  // Refused without calling the verifier, so an anonymous request costs nothing.
  if (!token) return null;

  try {
    // checkRevoked, always. A revoked admin must lose access immediately: the
    // one-hour custom-claim lag that AdminGate papers over cuts both ways, and
    // on paths that spend quota, write medical and food data, or delete an
    // account, the strict side is the safe one.
    return await verifyIdToken(token, true);
  } catch {
    return null;
  }
}

/**
 * @returns `ok: true` with the caller's uid, and email when it has a usable
 *   one — callers attribute a write to `email ?? uid`. Otherwise the error and
 *   status the route should answer with.
 */
export async function requireAdmin(request: Request, verifyIdToken: VerifyIdToken): Promise<AdminCheck> {
  const decoded = await verifiedToken(request, verifyIdToken);
  if (!decoded) return UNAUTHENTICATED;

  // `=== true`, never truthiness: "true" or 1 is not the claim that
  // `scripts/grant-admin.mjs` writes.
  if (decoded.admin !== true) return FORBIDDEN;

  return { ok: true, uid: decoded.uid, email: decoded.email?.trim() || null };
}

/**
 * Any signed-in account. The route decides what that account may do — this
 * only establishes WHO is asking, and a route using it must act on
 * `uid` alone, never on an id taken from the request body.
 */
export async function requireUser(request: Request, verifyIdToken: VerifyIdToken): Promise<UserCheck> {
  const decoded = await verifiedToken(request, verifyIdToken);
  if (!decoded) return UNAUTHENTICATED;

  const authTime = decoded.auth_time;
  return {
    ok: true,
    uid: decoded.uid,
    email: decoded.email?.trim() || null,
    admin: decoded.admin === true,
    authTimeS: typeof authTime === 'number' && Number.isFinite(authTime) ? authTime : null,
  };
}
