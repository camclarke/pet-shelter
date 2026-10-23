/**
 * The decisions `scripts/grant-role.mjs` makes, kept pure so each is tested
 * without firebase-admin: what the command line asks for, what the claims
 * become, whether a revoke would leave the project with no superuser, and
 * what the audit entry says.
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
 */

import { ROLE_KEYS, isRoleKey, type RoleKey } from '@/config/roles';

/** Firebase: "The payload must not exceed 1000 bytes." (custom-claims docs) */
export const CLAIMS_MAX_BYTES = 1000;

export type GrantCommand =
  | { mode: 'list'; role: RoleKey | null }
  | { mode: 'grant' | 'revoke' | 'check'; email: string; role: RoleKey };

export type ParsedArgs = { ok: true; command: GrantCommand } | { ok: false; error: string };

export const USAGE =
  'Usage: npm run grant:role -- <email> <su|owner|admin|rescuer|events> [--revoke|--check]  |  -- --list [role]';

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

export interface RoleAuditEntry {
  action: 'grant' | 'revoke';
  role: RoleKey;
  targetUid: string;
  targetEmail: string | null;
  /** Who ran the script: the ADC identity, or the OS user when it cannot be read. */
  actor: string;
  claimsBefore: ClaimsObject;
  claimsAfter: ClaimsObject;
  /** `attempted` is written BEFORE the change, `applied` after it is read back. */
  outcome: 'attempted' | 'applied';
}

export function auditEntry(input: Omit<RoleAuditEntry, 'outcome'>): RoleAuditEntry {
  return { ...input, outcome: 'attempted' };
}
