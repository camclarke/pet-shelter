/**
 * Grant, revoke, or inspect the `admin` custom auth claim.
 *
 * ── Why this is a script and not a screen ──────────────────────────────────
 * `firestore.rules` and `storage.rules` both gate every write in this project
 * on `request.auth.token.admin == true`. That claim can only be set by the
 * Admin SDK, which by definition means server-side credentials — so the very
 * first admin cannot be created from inside the app without a bootstrap path
 * that could also be abused to create the second one. A script run by whoever
 * holds ADC is that bootstrap path, and it deliberately stays outside the
 * deployed surface: there is no HTTP route, no Cloud Function, and nothing an
 * authenticated user can call to promote themselves.
 *
 * The rules already refuse a self-grant — that branch is one of the 22
 * assertions proven on 2026-08-23 — but a rule that refuses `role: 'admin'` in
 * `users/{uid}` says nothing about the claim, because the claim never lived in
 * Firestore. This script is the only thing that writes it.
 *
 * ── Two traps, both of which have bitten this class of code before ─────────
 *
 * 1. `setCustomUserClaims()` REPLACES the entire claims object. It does not
 *    merge. Passing `{ admin: true }` to a user who already carries other
 *    claims silently deletes them — the same shape as this project's
 *    `fieldOverrides` lesson, where a partial write looked like an addition
 *    and was actually a replacement. So we read the existing claims and spread
 *    them, and we delete the key on revoke rather than writing `false`
 *    (an explicit `admin: false` is indistinguishable from a grant in every
 *    log and dashboard, and reads as "this account was made an admin" to
 *    anyone auditing later).
 *
 * 2. **A granted claim is not a claim the browser can see.** Custom claims are
 *    baked into the ID token at issue time, and Firebase refreshes that token
 *    roughly hourly. A user signed in when the grant runs keeps a token with
 *    no `admin` in it until it rotates — so the UI must force
 *    `getIdToken(true)`, and the person running this must be told to sign out
 *    and back in. This is the single most likely reason a fresh grant "does
 *    not work", and it is not a bug.
 *
 * ── Since roles (2026-10-22) ───────────────────────────────────────────────
 * `admin` is one of five roles, and this script is now an ALIAS for
 * `scripts/grant-role.mjs <email> admin`. It runs that script in a child
 * process, so it keeps working as `node scripts/grant-admin.mjs` (the role
 * script needs `--import tsx`, and this one adds it). Delegating rather than
 * keeping a second copy means the admin path also gets the role script's
 * guarantees: the `roleAudit` entry, `revokeRefreshTokens` on revoke, and the
 * same merge and read-back. Plan: the role-based access plan of 2026-10-22, §5.
 *
 * Usage:
 *   node scripts/grant-admin.mjs <email>            grant admin
 *   node scripts/grant-admin.mjs <email> --revoke   revoke admin
 *   node scripts/grant-admin.mjs <email> --check    inspect only, no write
 *   node scripts/grant-admin.mjs --list             every account holding admin
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Map this script's arguments onto grant-role's. Exported for the test. */
export function toGrantRoleArgs(argv) {
  const flags = argv.filter((a) => a.startsWith('--'));
  const positional = argv.filter((a) => !a.startsWith('--'));
  if (flags.includes('--list')) return ['--list', 'admin', ...positional];
  return [...positional, 'admin', ...flags];
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'grant-role.mjs');
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', script, ...toGrantRoleArgs(process.argv.slice(2))],
    { stdio: 'inherit' },
  );
  process.exit(result.status ?? 1);
}
