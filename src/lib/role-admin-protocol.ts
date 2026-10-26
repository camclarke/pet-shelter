/**
 * The wire contract of the role routes — what `/admin/roles` sends and reads
 * back. No server import, so the browser bundles this file and not the
 * handler (the `donations-protocol.ts` split).
 *
 *   GET  /api/roles/staff    → 200 StaffResponse
 *   POST /api/roles/change   JSON RoleChangeRequest → 200 RoleChangeResponse
 *
 * Both need `Authorization: Bearer <ID token>` from an account holding `owner`
 * or `su` (`ROLE_MANAGERS`). The change also needs a sign-in under five
 * minutes old (`requires-recent-login`): the screen re-authenticates and
 * retries, as the donation screen does.
 *
 * Every refusal is JSON `{error, hint?}` with `Cache-Control: no-store` and
 * the `X-Role-Failure` header naming the error — its ABSENCE on a 5xx means
 * the edge answered, not us.
 *
 * ── What the screen never sees ─────────────────────────────────────────────
 * `su`. No account holding it is listed, no `roles` object carries the key
 * (`VisibleRoles` has none), and a change aimed at a superuser's account is
 * refused as `protected-account` — the same answer an owner gets for a peer
 * owner — so the refusal cannot be used to find out which email is the
 * superuser.
 *
 * ── Reading the role audit ─────────────────────────────────────────────────
 * Not a route: `roleAudit/{id}` is readable by `owner` and `su` through the
 * rules, so the screen queries it with the client SDK (newest `at` first).
 * Entries written by this route carry `via: 'screen'` and `actorUid`.
 */

import type { RoleKey, VisibleRoleKey, VisibleRoles } from '@/config/roles';

export const ROLE_FAILURE_HEADER = 'X-Role-Failure';

/** The largest JSON body `/api/roles/change` reads. A real one is under 150 bytes. */
export const ROLE_JSON_MAX_BYTES = 2 * 1024;

/** Longer than any real address (RFC 5321 caps a path at 256). */
export const ROLE_EMAIL_MAX_LENGTH = 320;

export const ROLE_FAILURES = [
  'unauthenticated', //        401  no token, or invalid or revoked
  'forbidden', //              403  not the owner nor the superuser
  'requires-recent-login', //  403  change only: sign in again, then retry
  'not-json', //               415  Content-Type is not application/json
  'invalid-body', //           400  not {email, role, action} of the right types
  'too-large', //              413  body over ROLE_JSON_MAX_BYTES
  'too-slow', //               408  body took more than 30 s
  'body-read-failed', //       500  the upload broke off
  'not-allowed-role', //       403  G1: the caller may not grant or revoke this role (su: never here)
  'no-account', //             404  no account with that email; `hint` says what to do
  'self', //                   403  G3: nobody changes their own roles
  'protected-account', //      403  G4: a superuser's account, or (for an owner) another owner's
  'no-change', //              409  already holds it (grant) or does not hold it (revoke)
  'last-owner', //             409  G3: that would leave nobody holding `owner`
  'claims-too-large', //       422  the account's claims would pass Firebase's 1000-byte limit
  'read-failed', //            500  Auth could not be read; nothing changed, retryable
  'audit-failed', //           500  the audit entry could not be written; nothing changed, retryable
  'write-failed', //           500  the claim write failed; the audit entry stays "attempted". Reload the list
  'not-applied', //            500  the write returned but the claim did not change; audit stays "attempted"
  'tokens-not-revoked', //     500  revoked, but the person's sessions were NOT ended: ask them to sign out
  'audit-incomplete', //       500  the change IS applied; only its audit entry stayed "attempted"
] as const;
export type RoleFailure = (typeof ROLE_FAILURES)[number];

/** Spanish, for `no-account`: a claim attaches to an account, so the person must create one first. */
export const NO_ACCOUNT_HINT =
  'No hay ninguna cuenta con ese correo. Pídele a esa persona que primero cree su cuenta en wawitas.org/account y vuelve a intentarlo.';

/** The roles this screen can ever change. `su` is not among them. */
export type GrantableRole = Exclude<RoleKey, 'su'>;

/** What the caller may do to ONE listed account, after every guardrail (G1–G4). */
export interface StaffEditable {
  /** Roles the caller may grant here: grantable by the caller, not yet held. */
  grant: GrantableRole[];
  /** Roles the caller may revoke here: grantable by the caller, held, and not the last owner. */
  revoke: GrantableRole[];
}

export interface StaffMember {
  uid: string;
  email: string | null;
  displayName: string | null;
  /** Every visible role, true or false. Never carries `su`. */
  roles: VisibleRoles;
  /** Spanish names of the held roles, most powerful first (`visibleRoleLabels`). */
  labels: string[];
  /** Empty lists on the caller's own row (G3) and on a peer owner's for an owner caller (G4). */
  editable: StaffEditable;
}

export interface StaffResponse {
  /** Every account holding any role, EXCEPT accounts holding `su`, sorted by email. */
  staff: StaffMember[];
  /** Accounts holding `owner` exactly true (the last one cannot be revoked). */
  ownersCount: number;
  /** The roles the caller may grant to someone by email (`GRANTABLE_BY` for their highest role). */
  grantable: GrantableRole[];
}

export interface RoleChangeRequest {
  email: string;
  role: GrantableRole;
  action: 'grant' | 'revoke';
}

export interface RoleChangeResponse {
  uid: string;
  email: string | null;
  /** The account's roles as READ BACK after the change. Never carries `su`. */
  roles: VisibleRoles;
  labels: string[];
  /** `roleAudit/{auditId}`, marked "applied". */
  auditId: string;
}

export interface RoleFailureBody {
  error: RoleFailure;
  /** Spanish, for `no-account`. */
  hint?: string;
}

/** The refusal named by a response, or null if the response is not one of ours. */
export function roleFailure(response: Response): RoleFailure | null {
  const value = response.headers.get(ROLE_FAILURE_HEADER);
  return value && (ROLE_FAILURES as readonly string[]).includes(value) ? (value as RoleFailure) : null;
}

export type { VisibleRoleKey, VisibleRoles };
