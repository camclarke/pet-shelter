/**
 * The role routes, as pure handlers. No `server-only`, no Firebase import:
 * each route injects token verification, Auth, the audit log and the clock,
 * so every branch is unit-tested with fakes (the `donations-handler.ts`
 * split). The decision lives in `decideRoleChange()` (`role-grants.ts`); the
 * wire contract in `role-admin-protocol.ts`.
 *
 * ═══ THIS IS OUTSIDE THE RULES, AND IT WRITES CLAIMS ════════════════════════
 * A custom claim is what every rule in `firestore.rules` and `storage.rules`
 * trusts. These handlers write claims through the Admin SDK, so they ARE the
 * boundary, and nothing behind them catches a lapse:
 *
 *   1. `guard()` — `requireRole(…, ROLE_MANAGERS)`, `checkRevoked`, FIRST: no
 *      token 401; neither the owner nor the superuser 403 forbidden.
 *   2. The change (G2): a sign-in under `RECENT_SIGN_IN_MAX_AGE_S` (5 min),
 *      else 403 requires-recent-login. A stolen, still-valid token an hour
 *      old cannot hand out roles.
 *   3. `decideRoleChange()` (G1, G3, G4, last owner), on the target's claims
 *      read from Auth at that moment — never on anything the screen sent.
 *   4. The SAME write sequence as `scripts/grant-role.mjs`: audit "attempted"
 *      → merge the claims → read them back → on a revoke,
 *      `revokeRefreshTokens` → audit "applied", read back. A failure after the
 *      first audit write leaves the entry "attempted", so a change can never
 *      happen unlogged.
 *
 * ═══ THE SUPERUSER IS INVISIBLE HERE ═════════════════════════════════════════
 * An account holding `su` is never listed, no response carries the `su` key,
 * and a change aimed at one answers `protected-account` — the same refusal an
 * owner gets for a peer owner. So neither the list nor a refusal tells an
 * owner which email is the superuser (PR #105's hidden label, plan §12.2 G4).
 *
 * ⚠️ Never logged: emails, claims, tokens, raw errors. Logs name the uid, the
 * role and an error's name and code.
 */

import {
  ROLE_KEYS,
  ROLE_MANAGERS,
  grantableBy,
  isRoleKey,
  rolesFromClaims,
  visibleRoleLabels,
  visibleRoles,
  type RoleKey,
  type Roles,
} from '@/config/roles';
import { signedInRecently } from './donations-handler';
import { READ_DEADLINE_MS, readCapped } from './read-capped';
import { requireRole, type VerifyIdToken } from './require-admin';
import {
  auditEntry,
  countOwners,
  decideRoleChange,
  nextClaims,
  type ClaimsObject,
  type RoleAuditEntry,
  type RoleChangeRefusal,
} from './role-grants';
import {
  NO_ACCOUNT_HINT,
  ROLE_EMAIL_MAX_LENGTH,
  ROLE_FAILURE_HEADER,
  ROLE_JSON_MAX_BYTES,
  type GrantableRole,
  type RoleChangeResponse,
  type RoleFailure,
  type RoleFailureBody,
  type StaffMember,
  type StaffResponse,
} from './role-admin-protocol';

export { ROLE_FAILURES, ROLE_FAILURE_HEADER, roleFailure } from './role-admin-protocol';
export type { RoleFailure } from './role-admin-protocol';

/** One Auth account, as these handlers read it. */
export interface AuthAccount {
  uid: string;
  email: string | null;
  displayName: string | null;
  /** `customClaims`, or null when the account has none. */
  claims: ClaimsObject | null;
}

export interface RoleAdminDeps {
  verifyIdToken: VerifyIdToken;
  nowMs(): number;
  /** EVERY account, paged to the end. A truncated list would miscount the owners. */
  listAllUsers(): Promise<AuthAccount[]>;
  /** The account with this email, or null when none exists. Throws on any other failure. */
  getUserByEmail(email: string): Promise<AuthAccount | null>;
  /** The account, freshly read — the read-back after a write. */
  getUser(uid: string): Promise<AuthAccount>;
  /** `setCustomUserClaims`: REPLACES the claims, so it is only ever given `nextClaims()`. */
  setClaims(uid: string, claims: ClaimsObject): Promise<void>;
  revokeRefreshTokens(uid: string): Promise<void>;
  /** Adds `roleAudit/{auto}` with a server timestamp; returns its id. */
  addAudit(entry: RoleAuditEntry): Promise<string>;
  /** Marks the entry `applied`, with the claims as read back. */
  markAuditApplied(id: string, claimsRead: ClaimsObject): Promise<void>;
  /** The entry's `outcome` as stored now, or null when it cannot be read. */
  readAuditOutcome(id: string): Promise<unknown>;
  /** One line, no payload. */
  log(message: string): void;
  /** Tests only. */
  bodyReadDeadlineMs?: number;
}

type Caller = { uid: string; email: string | null; roles: Roles };

// ─── responses ───────────────────────────────────────────────────────────────

function failure(error: RoleFailure, status: number, extra: Omit<RoleFailureBody, 'error'> = {}, close = false): Response {
  return new Response(JSON.stringify({ error, ...extra }), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      [ROLE_FAILURE_HEADER]: error,
      ...(close ? { connection: 'close' } : {}),
    },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** An error's name and code, and nothing it carries. */
function describeError(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' || typeof code === 'string' ? `${name} code=${code}` : name;
}

/**
 * What each refusal of `decideRoleChange()` answers on the wire. Both G4
 * reasons become ONE error, `protected-account`, so a refusal never says
 * whether the account belongs to the superuser.
 */
export const REFUSAL_RESPONSE: Readonly<Record<RoleChangeRefusal, { error: RoleFailure; status: number }>> = {
  forbidden: { error: 'forbidden', status: 403 },
  'not-allowed-role': { error: 'not-allowed-role', status: 403 },
  self: { error: 'self', status: 403 },
  'target-is-su': { error: 'protected-account', status: 403 },
  'target-is-owner': { error: 'protected-account', status: 403 },
  'no-change': { error: 'no-change', status: 409 },
  'last-owner': { error: 'last-owner', status: 409 },
  'claims-too-large': { error: 'claims-too-large', status: 422 },
};

// ─── the guard ───────────────────────────────────────────────────────────────

/**
 * Steps 1 and 2 of both handlers, and the only `requireRole(` in this file.
 * Nothing about the request is read before it.
 */
async function guard(
  request: Request,
  deps: RoleAdminDeps,
  { write }: { write: boolean },
): Promise<{ ok: true; caller: Caller } | { ok: false; response: Response }> {
  const check = await requireRole(request, deps.verifyIdToken, ROLE_MANAGERS);
  if (!check.ok) return { ok: false, response: failure(check.error, check.status) };
  if (write && !signedInRecently(check.authTimeS, deps.nowMs())) {
    return { ok: false, response: failure('requires-recent-login', 403) };
  }
  return { ok: true, caller: { uid: check.uid, email: check.email, roles: check.roles } };
}

/** A JSON body, read once through the cap. */
async function readJson(
  request: Request,
  deps: RoleAdminDeps,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const contentType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (contentType !== 'application/json') return { ok: false, response: failure('not-json', 415) };
  let read;
  try {
    read = await readCapped(request.body, ROLE_JSON_MAX_BYTES, { deadlineMs: deps.bodyReadDeadlineMs ?? READ_DEADLINE_MS });
  } catch (err) {
    deps.log(`[roles] body read failed (${describeError(err)})`);
    return { ok: false, response: failure('body-read-failed', 500, {}, true) };
  }
  if (!read.ok) {
    return { ok: false, response: read.reason === 'too-slow' ? failure('too-slow', 408, {}, true) : failure('too-large', 413, {}, true) };
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes)) };
  } catch {
    return { ok: false, response: failure('invalid-body', 400) };
  }
}

// ─── pure helpers ────────────────────────────────────────────────────────────

/** The roles a screen may ever change: every key but `su`, in `ROLE_KEYS` order. */
const SCREEN_ROLES: readonly GrantableRole[] = ROLE_KEYS.filter((r): r is GrantableRole => r !== 'su');

/**
 * What `caller` may grant and revoke on `account`, by asking
 * `decideRoleChange()` about every role both ways. So the list can never offer
 * a button the change route would refuse for a guardrail.
 */
export function editableFor(caller: { uid: string; roles: Roles }, account: AuthAccount, ownersCount: number) {
  const grant: GrantableRole[] = [];
  const revoke: GrantableRole[] = [];
  for (const role of SCREEN_ROLES) {
    const ask = (action: 'grant' | 'revoke') =>
      decideRoleChange({ caller, target: { uid: account.uid, claims: account.claims }, role, action, ownersCount }).ok;
    if (ask('grant')) grant.push(role);
    if (ask('revoke')) revoke.push(role);
  }
  return { grant, revoke };
}

/** By email, accounts without one last; ties by uid, so the order is stable. */
function byEmailThenUid(a: StaffMember, b: StaffMember): number {
  if (a.email !== b.email) {
    if (a.email === null) return 1;
    if (b.email === null) return -1;
    return a.email.localeCompare(b.email);
  }
  return a.uid.localeCompare(b.uid);
}

/**
 * The staff list as `caller` sees it: accounts holding any role, minus every
 * account holding `su`, sorted by email (then uid). Pure.
 */
export function staffView(caller: { uid: string; roles: Roles }, accounts: readonly AuthAccount[]): StaffResponse {
  const ownersCount = countOwners(accounts);
  const staff: StaffMember[] = [];
  for (const account of accounts) {
    const roles = rolesFromClaims(account.claims);
    if (roles.su) continue; // G4 / PR #105: the superuser is never listed.
    if (!ROLE_KEYS.some((role) => roles[role])) continue;
    staff.push({
      uid: account.uid,
      email: account.email,
      displayName: account.displayName,
      roles: visibleRoles(roles),
      labels: visibleRoleLabels(roles),
      editable: editableFor(caller, account, ownersCount),
    });
  }
  staff.sort(byEmailThenUid);
  // In ROLE_KEYS order (most powerful first), like every other role list on the wire.
  const mine = grantableBy(caller.roles);
  const grantable = SCREEN_ROLES.filter((role) => mine.includes(role));
  return { staff, ownersCount, grantable };
}

/** `{email, role, action}`, each of the right type and shape; anything else is `invalid-body`. */
export function parseChangeBody(value: unknown): { email: string; role: RoleKey; action: 'grant' | 'revoke' } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { email, role, action } = value as Record<string, unknown>;
  if (typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > ROLE_EMAIL_MAX_LENGTH) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  if (!isRoleKey(role)) return null;
  if (action !== 'grant' && action !== 'revoke') return null;
  return { email: trimmed, role, action };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/roles/staff
// ─────────────────────────────────────────────────────────────────────────────

export async function handleRoleStaff(request: Request, deps: RoleAdminDeps): Promise<Response> {
  const gate = await guard(request, deps, { write: false });
  if (!gate.ok) return gate.response;
  const { caller } = gate;

  let accounts: AuthAccount[];
  try {
    accounts = await deps.listAllUsers();
  } catch (err) {
    deps.log(`[roles] staff list failed (${describeError(err)})`);
    return failure('read-failed', 500);
  }
  return json(200, staffView(caller, accounts));
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/roles/change
// ─────────────────────────────────────────────────────────────────────────────

export async function handleRoleChange(request: Request, deps: RoleAdminDeps): Promise<Response> {
  const gate = await guard(request, deps, { write: true });
  if (!gate.ok) return gate.response;
  const { caller } = gate;

  const body = await readJson(request, deps);
  if (!body.ok) return body.response;
  const parsed = parseChangeBody(body.value);
  if (!parsed) return failure('invalid-body', 400);
  const { email, role, action } = parsed;

  // G1 before any lookup: a role the caller may never change costs no Auth read.
  if (!grantableBy(caller.roles).includes(role)) return failure('not-allowed-role', 403);

  let target: AuthAccount | null;
  let ownersCount: number;
  try {
    target = await deps.getUserByEmail(email);
    if (!target) return failure('no-account', 404, { hint: NO_ACCOUNT_HINT });
    ownersCount = countOwners(await deps.listAllUsers());
  } catch (err) {
    deps.log(`[roles] read failed (${describeError(err)})`);
    return failure('read-failed', 500);
  }

  const before: ClaimsObject = target.claims ?? {};
  const decision = decideRoleChange({ caller, target: { uid: target.uid, claims: before }, role, action, ownersCount });
  if (!decision.ok) {
    const { error, status } = REFUSAL_RESPONSE[decision.reason];
    return failure(error, status);
  }
  const after = nextClaims(before, role, action);

  // ── 1. the audit, BEFORE the change ─────────────────────────────────────
  let auditId: string;
  try {
    auditId = await deps.addAudit({
      ...auditEntry({
        action,
        role,
        targetUid: target.uid,
        targetEmail: target.email,
        actor: caller.email ?? caller.uid,
        claimsBefore: before,
        claimsAfter: after,
      }),
      actorUid: caller.uid,
      via: 'screen',
    });
  } catch (err) {
    deps.log(`[roles] audit write failed for uid=${target.uid} role=${role} (${describeError(err)})`);
    return failure('audit-failed', 500);
  }

  // ── 2. the claims, merged ────────────────────────────────────────────────
  try {
    await deps.setClaims(target.uid, after);
  } catch (err) {
    deps.log(`[roles] claim write failed for uid=${target.uid} role=${role} audit=${auditId} (${describeError(err)})`);
    return failure('write-failed', 500);
  }

  // ── 3. read back rather than trusting the write ──────────────────────────
  let now: ClaimsObject;
  try {
    now = (await deps.getUser(target.uid)).claims ?? {};
  } catch (err) {
    deps.log(`[roles] read-back failed for uid=${target.uid} audit=${auditId} (${describeError(err)})`);
    return failure('write-failed', 500);
  }
  const holds = now[role] === true;
  const present = Object.prototype.hasOwnProperty.call(now, role);
  if ((action === 'grant' && !holds) || (action === 'revoke' && present)) {
    deps.log(`[roles] not applied for uid=${target.uid} role=${role} audit=${auditId}`);
    return failure('not-applied', 500);
  }

  // ── 4. a revoke ends the person's sessions ──────────────────────────────
  // API routes verify with checkRevoked, so they refuse at once. The rules
  // keep accepting the old ID token until it expires — at most an hour.
  if (action === 'revoke') {
    try {
      await deps.revokeRefreshTokens(target.uid);
    } catch (err) {
      deps.log(`[roles] token revoke failed for uid=${target.uid} audit=${auditId} (${describeError(err)})`);
      return failure('tokens-not-revoked', 500);
    }
  }

  // ── 5. the audit, marked applied and read back ──────────────────────────
  try {
    await deps.markAuditApplied(auditId, now);
    if ((await deps.readAuditOutcome(auditId)) !== 'applied') throw new Error('outcome did not read back as applied');
  } catch (err) {
    deps.log(`[roles] audit not marked applied: audit=${auditId} (${describeError(err)})`);
    return failure('audit-incomplete', 500);
  }

  const roles = rolesFromClaims(now);
  const response: RoleChangeResponse = {
    uid: target.uid,
    email: target.email,
    roles: visibleRoles(roles),
    labels: visibleRoleLabels(roles),
    auditId,
  };
  return json(200, response);
}
