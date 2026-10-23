/**
 * Grant, revoke, or inspect a staff ROLE — one boolean custom auth claim.
 *
 * Roles (the role-based access plan of 2026-10-22; table in
 * `src/config/roles.ts`):
 *
 *   su       Administración general   everything operational + grants roles
 *   owner    Responsable del refugio  everything operational + donation details
 *   admin    Coordinación             everything operational (the claim used
 *                                     since 2026-08-23 — unchanged)
 *   rescuer  Rescatista               their own unpublished intake drafts
 *   events   Equipo de eventos        events that have not ended
 *
 * ── Why a script and not a screen ──────────────────────────────────────────
 * Same reason as `grant-admin.mjs`, which now delegates here: a claim can only
 * be written by the Admin SDK, and an HTTP endpoint that writes one would be
 * the most powerful thing in the system, reachable from any browser. Running
 * this needs the project's credentials on this machine (plan D8).
 *
 * ── What it guarantees ─────────────────────────────────────────────────────
 *   - Claims are MERGED, one key at a time; a revoke deletes the key rather
 *     than writing `false`. See `src/lib/role-grants.ts`.
 *   - The result is READ BACK; a write that returned is not a verified one.
 *   - Every revoke calls `revokeRefreshTokens(uid)`. API routes check
 *     revocation, so they refuse at once; Firestore and Storage rules may
 *     still accept the old ID token until it expires, at most an hour.
 *   - Every change writes `roleAudit/{auto}` through the Admin SDK — BEFORE
 *     the change (`outcome: 'attempted'`) and again after the read-back
 *     (`outcome: 'applied'`), so a change can never happen unlogged.
 *   - It refuses to revoke the last `su`, refuses unknown roles, and refuses a
 *     claims object over Firebase's 1000-byte limit.
 *   - It grants `su` ONLY to the email in `_local/su-email` (gitignored; one
 *     line holding the address, `#` comments allowed). The check runs right
 *     after the arguments are read, before any network call, and fails
 *     closed: with no file, every `su` grant is refused. Revoking `su` is not
 *     affected. `--list` and `--check` warn about any account holding `su`
 *     that is not that email, or about a missing file. This prevents a
 *     mistyped grant; anyone with the project's credentials can still use
 *     the Admin SDK directly.
 *
 *     To create the file:  echo you@example.com > _local/su-email
 *
 * Usage (needs ADC and GOOGLE_CLOUD_PROJECT; `--import tsx` because the role
 * table is TypeScript):
 *   npm run grant:role -- <email> <role>            grant
 *   npm run grant:role -- <email> <role> --revoke   revoke
 *   npm run grant:role -- <email> <role> --check    inspect only, no write
 *   npm run grant:role -- --list [role]             every account holding a role
 */

import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { GoogleAuth } from 'google-auth-library';

import { ROLE_LABELS, heldRoles, rolesFromClaims } from '../src/config/roles.ts';
import {
  CLAIMS_MAX_BYTES,
  SU_EMAIL_FILE,
  auditEntry,
  changesAnything,
  claimsBytes,
  nextClaims,
  parseGrantArgs,
  parseSuEmailFile,
  suGrantAllowed,
  suLockWarnings,
  wouldRemoveLastSuper,
} from '../src/lib/role-grants.ts';

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

/** The allowed su email, read relative to the repo root (never the cwd). Null if absent or invalid. */
function readAllowedSuEmail() {
  const path = fileURLToPath(new URL(`../${SU_EMAIL_FILE}`, import.meta.url));
  let text = null;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    text = null;
  }
  return parseSuEmailFile(text);
}

/** Refuses an su grant to any email but the one in the lock file. No network call. */
function enforceSuLock(email) {
  if (!suGrantAllowed(email, readAllowedSuEmail())) {
    fail(
      `Refusing to grant su to ${email}: su may only be granted to the email in ${SU_EMAIL_FILE}.\n` +
        `    That file is gitignored and holds one line, the allowed address. If it is\n` +
        `    missing, create it at the repo root:  echo you@example.com > ${SU_EMAIL_FILE}`,
    );
  }
}

function printSuLockWarnings(accounts) {
  for (const line of suLockWarnings(accounts, readAllowedSuEmail())) console.log(`  ⚠️ ${line}`);
}

/** Every account, paged — an unpaginated loop that truncates is how an audit misses page two. */
async function allUsers(auth) {
  const users = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    users.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken);
  return users;
}

/** Who is running this: the ADC identity read at userinfo, never the quota label. */
async function actorIdentity() {
  try {
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/cloud-platform'],
    });
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    if (typeof body.email === 'string') return body.email;
  } catch {
    // Fall through: the audit still names the machine's user.
  }
  return `os:${userInfo().username}`;
}

const describe = (claims) => {
  const held = heldRoles(rolesFromClaims(claims));
  return held.length ? held.map((r) => `${r} (${ROLE_LABELS[r]})`).join(', ') : 'none';
};

async function main() {
  const parsed = parseGrantArgs(process.argv.slice(2));
  if (!parsed.ok) fail(parsed.error);
  const command = parsed.command;

  // The su lock runs before anything touches the network or the project.
  if (command.mode === 'grant' && command.role === 'su') enforceSuLock(command.email);

  if (!PROJECT_ID) {
    fail('GOOGLE_CLOUD_PROJECT is not set. This script writes auth claims that grant access — it will not guess which project.');
  }

  if (!getApps().length) initializeApp({ projectId: PROJECT_ID });
  const auth = getAuth();

  console.log(`\n  project : ${PROJECT_ID}`);

  if (command.mode === 'list') {
    const users = await allUsers(auth);
    const staff = users.filter((u) => {
      const held = heldRoles(rolesFromClaims(u.customClaims));
      return command.role ? held.includes(command.role) : held.length > 0;
    });
    console.log(`  accounts: ${users.length}, ${command.role ? `holding ${command.role}` : 'with any role'}: ${staff.length}\n`);
    for (const user of staff) {
      console.log(`    • ${user.email ?? '(no email)'}  uid=${user.uid}  roles: ${describe(user.customClaims)}`);
    }
    if (staff.length === 0) console.log('    (none)');
    console.log();
    printSuLockWarnings(users.map((u) => ({ email: u.email, claims: u.customClaims })));
    return;
  }

  const { email, role } = command;
  let user;
  try {
    user = await auth.getUserByEmail(email);
  } catch (error) {
    if (error?.code === 'auth/user-not-found') {
      fail(
        `No account exists for ${email}.\n` +
          '    A claim attaches to an account, so the person must sign up first — at\n' +
          '    https://wawitas.org/account — and then this script can grant the role.',
      );
    }
    throw error;
  }

  const before = user.customClaims ?? {};
  console.log(`  account : ${user.email}  uid=${user.uid}`);
  console.log(`  claims  : ${JSON.stringify(before)}`);
  console.log(`  roles   : ${describe(before)}`);

  if (command.mode === 'check') {
    console.log(`  ${role.padEnd(8)}: ${before[role] === true ? 'yes' : 'no'}\n`);
    printSuLockWarnings([{ email: user.email, claims: before }]);
    return;
  }

  const action = command.mode;
  if (!changesAnything(before, role, action)) {
    console.log(`\n  nothing to do — this account ${action === 'grant' ? 'already holds' : 'does not hold'} ${role}.\n`);
    return;
  }

  if (action === 'revoke' && role === 'su') {
    const supers = (await allUsers(auth)).filter((u) => u.customClaims?.su === true).map((u) => u.uid);
    if (wouldRemoveLastSuper(supers, user.uid, role, action)) {
      fail('Refusing to revoke the LAST su. Grant su to a second account first, then revoke this one.');
    }
  }

  const after = nextClaims(before, role, action);
  const bytes = claimsBytes(after);
  if (bytes > CLAIMS_MAX_BYTES) fail(`The claims would be ${bytes} bytes; Firebase allows ${CLAIMS_MAX_BYTES}.`);

  // ── the audit, BEFORE the change ─────────────────────────────────────────
  const db = getFirestore();
  const actor = await actorIdentity();
  const entry = auditEntry({
    action,
    role,
    targetUid: user.uid,
    targetEmail: user.email ?? null,
    actor,
    claimsBefore: before,
    claimsAfter: after,
  });
  const auditRef = await db.collection('roleAudit').add({ ...entry, at: FieldValue.serverTimestamp() });
  console.log(`  audit   : roleAudit/${auditRef.id} (attempted, by ${actor})`);

  await auth.setCustomUserClaims(user.uid, after);

  // Read back rather than trusting the write.
  const reread = await auth.getUser(user.uid);
  const now = reread.customClaims ?? {};
  const holds = now[role] === true;
  const present = Object.prototype.hasOwnProperty.call(now, role);
  if ((action === 'grant' && !holds) || (action === 'revoke' && present)) {
    fail(`The write returned but the claim did not change — still ${JSON.stringify(now)}. roleAudit/${auditRef.id} stays "attempted".`);
  }

  if (action === 'revoke') {
    // API routes verify with checkRevoked, so they refuse at once. Rules keep
    // accepting the old ID token until it expires — at most an hour.
    await auth.revokeRefreshTokens(user.uid);
    const revoked = await auth.getUser(user.uid);
    console.log(`  tokens  : refresh tokens revoked, valid after ${revoked.tokensValidAfterTime}`);
  }

  await auditRef.update({ outcome: 'applied', appliedAt: FieldValue.serverTimestamp(), claimsRead: now });
  const audited = await auditRef.get();
  if (audited.get('outcome') !== 'applied') fail(`roleAudit/${auditRef.id} did not read back as applied.`);

  console.log(`\n  ✓ ${action === 'grant' ? 'granted' : 'revoked'} ${role} — claims are now ${JSON.stringify(now)}`);
  console.log(`  ✓ roleAudit/${auditRef.id} applied`);
  console.log(
    '\n  ⚠ The browser will not see this until the ID token rotates (about an hour).\n' +
      '    Tell them to sign out and back in; the panel also forces a refresh on load.\n',
  );
}

main().catch((error) => {
  console.error('\n  ✗ failed\n');
  console.error(error);
  process.exit(1);
});
