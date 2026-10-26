/**
 * The decisions `scripts/grant-role.mjs` and `/api/roles/change` make, kept
 * pure so each is tested without firebase-admin: what the command line asks
 * for, what the claims become, whether a revoke would leave the project with
 * no superuser, who may change whose roles (`decideRoleChange`, plan §12),
 * and what the audit entry says.
 *
 * ── Why claims are MERGED ──────────────────────────────────────────────────
 * `setCustomUserClaims()` REPLACES the whole claims object. Passing
 * `{ rescuer: true }` to a coordinator would silently delete their `admin`
 * claim. So the next claims are always the current ones with exactly one key
 * changed, and a revoke DELETES the key rather than writing `false`: an
 * explicit `false` reads like a grant in every log and dashboard.
 *
 * ── Why the last superuser cannot be revoked ───────────────────────────────
 * `su` is what reads the role audit, and — once donations exist — confirms
 * changes to bank details. Revoking the last one leaves nobody able to do
 * either, and the only way back is this script run by someone with the
 * project's credentials. So it refuses, and says to grant a second one first.
 *
 * ── Why granting su is locked to one email ─────────────────────────────────
 * A mistyped address or the wrong role on the command line must not be able
 * to create a second superuser. `suGrantAllowed()` admits only the email kept
 * in the gitignored `SU_EMAIL_FILE`, and refuses everyone when that file is
 * missing. This prevents mistakes; it is not a boundary against someone who
 * holds the project's credentials, who can call the Admin SDK directly.
 */

import { GRANTABLE_BY, ROLE_KEYS, isRoleKey, managerLevel, rolesFromClaims, type RoleKey, type Roles } from '@/config/roles';

/** Firebase: "The payload must not exceed 1000 bytes." (custom-claims docs) */
export const CLAIMS_MAX_BYTES = 1000;

export type GrantCommand =
  | { mode: 'list'; role: RoleKey | null }
  | { mode: 'grant' | 'revoke' | 'check'; email: string; role: RoleKey };

export type ParsedArgs = { ok: true; command: GrantCommand } | { ok: false; error: string };

export const USAGE =
  'Usage: npm run grant:role -- <email> <su|owner|admin|finance|rescuer|events> [--revoke|--check]  |  -- --list [role]';

/** Read `<email> <role> [--revoke|--check]` or `--list [role]`. Never guesses. */
export function parseGrantArgs(argv: readonly string[]): ParsedArgs {
  const flags = argv.filter((a) => a.startsWith('--'));
  const positional = argv.filter((a) => !a.startsWith('--'));

  for (const flag of flags) {
    if (!['--revoke', '--check', '--list'].includes(flag)) {
      return { ok: false, error: `Unknown flag ${flag}. Expected --revoke, --check or --list.` };
    }
  }
  if (new Set(flags).size !== flags.length) return { ok: false, error: 'A flag was given twice.' };

  const revoke = flags.includes('--revoke');
  const check = flags.includes('--check');
  const list = flags.includes('--list');

  if (list) {
    if (revoke || check) return { ok: false, error: '--list cannot be combined with --revoke or --check.' };
    if (positional.length > 1) return { ok: false, error: `--list takes at most a role. ${USAGE}` };
    const role = positional[0] ?? null;
    if (role !== null && !isRoleKey(role)) {
      return { ok: false, error: `Unknown role "${role}". Roles: ${ROLE_KEYS.join(', ')}.` };
    }
    return { ok: true, command: { mode: 'list', role } };
  }

  if (revoke && check) return { ok: false, error: '--revoke and --check are mutually exclusive.' };
  if (positional.length !== 2) return { ok: false, error: USAGE };

  const [email, role] = positional as [string, string];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: `"${email}" is not an email address. ${USAGE}` };
  }
  if (!isRoleKey(role)) {
    return { ok: false, error: `Unknown role "${role}". Roles: ${ROLE_KEYS.join(', ')}.` };
  }
  return { ok: true, command: { mode: revoke ? 'revoke' : check ? 'check' : 'grant', email, role } };
}

export type ClaimsObject = Record<string, unknown>;

/**
 * The claims after granting or revoking ONE role. Every other key — another
 * role, or a claim this project does not know — is kept exactly as it was.
 */
export function nextClaims(current: ClaimsObject | null | undefined, role: RoleKey, action: 'grant' | 'revoke'): ClaimsObject {
  const next: ClaimsObject = { ...(current ?? {}) };
  if (action === 'grant') next[role] = true;
  else delete next[role];
  return next;
}

/** Whether a grant or revoke would change anything. A role is held only as exactly `true`. */
export function changesAnything(current: ClaimsObject | null | undefined, role: RoleKey, action: 'grant' | 'revoke'): boolean {
  const holds = current?.[role] === true;
  if (action === 'grant') return !holds;
  // A revoke also cleans up a key that is present but not exactly true
  // ("true", false), which would otherwise sit in the token looking like a grant.
  return current != null && Object.prototype.hasOwnProperty.call(current, role);
}

/** The claims JSON's size in UTF-8 bytes, the measure Firebase limits. */
export function claimsBytes(claims: ClaimsObject): number {
  return new TextEncoder().encode(JSON.stringify(claims)).length;
}

/**
 * True when revoking `su` from `targetUid` would leave no superuser.
 * `superUids` is every account that holds `su` exactly `true` right now.
 */
export function wouldRemoveLastSuper(
  superUids: readonly string[],
  targetUid: string,
  role: RoleKey,
  action: 'grant' | 'revoke',
): boolean {
  if (role !== 'su' || action !== 'revoke') return false;
  const remaining = new Set(superUids);
  remaining.delete(targetUid);
  return remaining.size === 0;
}

/** How many accounts hold `owner` exactly `true`. The input `decideRoleChange` needs for G3. */
export function countOwners(accounts: readonly { claims: ClaimsObject | null | undefined }[]): number {
  return accounts.filter((account) => account.claims?.owner === true).length;
}

// ─── who may change whose roles (plan §12, PR-3) ─────────────────────────────

/**
 * Why a role change is refused. One per guardrail of plan §12.2, plus the two
 * the script always had:
 *
 *  - `forbidden`         the caller holds neither `owner` nor `su`.
 *  - `not-allowed-role`  G1: the role is not in `GRANTABLE_BY` for the
 *                        caller's highest manager role. `su` is ALWAYS refused
 *                        here: it is granted only by the script's own path.
 *  - `self`              G3: nobody changes their own roles.
 *  - `target-is-su`      G4: an account holding `su` is untouchable in the app.
 *  - `target-is-owner`   G4: only the superuser changes an account holding `owner`.
 *  - `no-change`         the grant is already held, or the revoke is of a key
 *                        that is not there (`changesAnything()`).
 *  - `last-owner`        G3: revoking `owner` from the last account holding it.
 *  - `claims-too-large`  the claims would pass Firebase's 1000-byte limit.
 */
export const ROLE_CHANGE_REFUSALS = [
  'forbidden',
  'not-allowed-role',
  'self',
  'target-is-su',
  'target-is-owner',
  'no-change',
  'last-owner',
  'claims-too-large',
] as const;
export type RoleChangeRefusal = (typeof ROLE_CHANGE_REFUSALS)[number];

export type RoleChangeDecision = { ok: true } | { ok: false; reason: RoleChangeRefusal };

export interface RoleChangeInput {
  /** Who asks: their uid and every role their VERIFIED token carries. */
  caller: { uid: string; roles: Roles };
  /**
   * Whose roles change: their uid and their CURRENT claims, read from Auth
   * just now. Claims rather than roles, because `no-change` and
   * `claims-too-large` are questions about the claims object itself.
   */
  target: { uid: string; claims: ClaimsObject | null | undefined };
  role: RoleKey;
  action: 'grant' | 'revoke';
  /** Accounts holding `owner` exactly true right now, the target included (`countOwners()`). */
  ownersCount: number;
  /**
   * `screen` (the default) applies every guardrail. `script` is
   * `scripts/grant-role.mjs`, run with the project's credentials: it is the
   * superuser's own tool, so it may change an account that holds `su` — the
   * superuser giving themselves Tesorería, say (plan LOG 2026-10-24). It is
   * still refused a grant of `su` here; the script grants `su` only through
   * its email-locked path, which never calls this.
   */
  via?: 'screen' | 'script';
}

/**
 * Whether `caller` may `action` `role` on `target`. The ONE place the
 * guardrails of plan §12.2 are decided: `/api/roles/change`, the staff list's
 * per-account `editable` and `scripts/grant-role.mjs` all call it, so their
 * rules cannot drift. Pure.
 *
 * The checks run in this order, and the first that fails is the reason:
 * forbidden → not-allowed-role → self → target-is-su → target-is-owner →
 * no-change → last-owner → claims-too-large. The protections come before
 * `no-change` on purpose: asking about a protected account must not tell the
 * caller which roles it holds.
 */
export function decideRoleChange(input: RoleChangeInput): RoleChangeDecision {
  const { caller, target, role, action, ownersCount } = input;
  const via = input.via ?? 'screen';

  const level = managerLevel(caller.roles);
  if (level === null) return { ok: false, reason: 'forbidden' };

  // G1. `su` is never in GRANTABLE_BY, and is refused here by name as well,
  // so widening that table can never open it.
  if (role === 'su' || !GRANTABLE_BY[level].includes(role)) return { ok: false, reason: 'not-allowed-role' };

  // G3: nobody changes their own roles.
  if (caller.uid === target.uid) return { ok: false, reason: 'self' };

  // G4: untouchable accounts.
  const targetRoles = rolesFromClaims(target.claims);
  if (via === 'screen' && targetRoles.su) return { ok: false, reason: 'target-is-su' };
  if (targetRoles.owner && level !== 'su') return { ok: false, reason: 'target-is-owner' };

  if (!changesAnything(target.claims, role, action)) return { ok: false, reason: 'no-change' };

  // G3: never the last owner. Only a revoke of an owner that IS one can
  // reduce the count; a stray non-true `owner` key is cleaned up freely.
  if (role === 'owner' && action === 'revoke' && targetRoles.owner && ownersCount <= 1) {
    return { ok: false, reason: 'last-owner' };
  }

  if (claimsBytes(nextClaims(target.claims, role, action)) > CLAIMS_MAX_BYTES) {
    return { ok: false, reason: 'claims-too-large' };
  }
  return { ok: true };
}

// ─── the superuser lock ──────────────────────────────────────────────────────

/**
 * Where the one email allowed to hold `su` is kept, relative to the repo root.
 * `_local/` is gitignored: this repository is public and is a template other
 * shelters fork, so the address must not live in a tracked file, and a fork
 * must not inherit this shelter's superuser.
 */
export const SU_EMAIL_FILE = '_local/su-email';

function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Exactly one `@`, something on both sides, and no whitespace anywhere. */
function plausibleEmail(value: string): boolean {
  if (/\s/.test(value)) return false;
  const parts = value.split('@');
  return parts.length === 2 && parts[0]!.length > 0 && parts[1]!.length > 0;
}

/**
 * The allowed email in the lock file's text: the first line that is neither
 * blank nor a `#` comment, trimmed. A leading BOM is ignored. Null when there
 * is no file, no such line, or the line is not a plausible email — and null
 * means every `su` grant is refused.
 */
export function parseSuEmailFile(text: string | null): string | null {
  if (text === null) return null;
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    return plausibleEmail(line) ? line : null;
  }
  return null;
}

/**
 * Whether `su` may be granted to `targetEmail`. Fails CLOSED: with no allowed
 * email, an empty one or a malformed one, nobody may receive `su`. The
 * comparison ignores case and surrounding spaces, as email addresses do in
 * practice.
 */
export function suGrantAllowed(targetEmail: string, allowedEmail: string | null): boolean {
  if (allowedEmail === null) return false;
  const allowed = normaliseEmail(allowedEmail);
  if (!plausibleEmail(allowed)) return false;
  return normaliseEmail(targetEmail) === allowed;
}

/**
 * The warnings `--list` and `--check` print about the lock: one when the lock
 * file is missing or invalid, otherwise one per account that holds `su`
 * (exactly `true`) without being the allowed email. Never names the allowed
 * email itself.
 */
export function suLockWarnings(
  accounts: readonly { email: string | null | undefined; claims: ClaimsObject | null | undefined }[],
  allowedEmail: string | null,
): string[] {
  if (allowedEmail === null) {
    return [`the su lock file ${SU_EMAIL_FILE} is missing or invalid — every su grant is refused until it exists.`];
  }
  return accounts
    .filter((account) => account.claims?.su === true && !suGrantAllowed(account.email ?? '', allowedEmail))
    .map((account) => `${account.email ?? '(no email)'} holds su but is not the email in ${SU_EMAIL_FILE}.`);
}

export interface RoleAuditEntry {
  action: 'grant' | 'revoke';
  role: RoleKey;
  targetUid: string;
  targetEmail: string | null;
  /**
   * Who made the change. The script: the ADC identity, or the OS user when it
   * cannot be read. The screen: the caller's email, or their uid without one.
   */
  actor: string;
  /** The screen only: the caller's uid, from the verified token. */
  actorUid?: string;
  /** Where the change came from. Absent on entries written before 2026-10-26 (all by the script). */
  via?: 'script' | 'screen';
  claimsBefore: ClaimsObject;
  claimsAfter: ClaimsObject;
  /** `attempted` is written BEFORE the change, `applied` after it is read back. */
  outcome: 'attempted' | 'applied';
}

export function auditEntry(input: Omit<RoleAuditEntry, 'outcome'>): RoleAuditEntry {
  return { ...input, outcome: 'attempted' };
}
