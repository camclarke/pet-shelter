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
 * Usage:
 *   node scripts/grant-admin.mjs <email>            grant
 *   node scripts/grant-admin.mjs <email> --revoke   revoke
 *   node scripts/grant-admin.mjs <email> --check    inspect only, no write
 *   node scripts/grant-admin.mjs --list             every admin on the project
 */

import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const positional = argv.filter((a) => !a.startsWith('--'));

  const known = new Set(['--revoke', '--check', '--list']);
  for (const flag of flags) {
    if (!known.has(flag)) fail(`Unknown flag ${flag}. Expected --revoke, --check or --list.`);
  }

  return {
    email: positional[0] ?? null,
    revoke: flags.has('--revoke'),
    check: flags.has('--check'),
    list: flags.has('--list'),
  };
}

/**
 * Every admin on the project.
 *
 * `listUsers` pages at 1000. This shelter will never have 1000 accounts, but
 * an unpaginated loop that silently truncates is exactly how an audit reports
 * "no other admins" while one sits on page two — so it pages properly.
 */
async function listAdmins(auth) {
  const admins = [];
  let pageToken;

  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const user of page.users) {
      if (user.customClaims?.admin === true) admins.push(user);
    }
    pageToken = page.pageToken;
  } while (pageToken);

  return admins;
}

async function main() {
  const { email, revoke, check, list } = parseArgs(process.argv.slice(2));

  if (!list && !email) {
    fail('Usage: node scripts/grant-admin.mjs <email> [--revoke|--check]  |  --list');
  }
  if (revoke && check) fail('--revoke and --check are mutually exclusive.');

  if (!PROJECT_ID) {
    fail(
      'GOOGLE_CLOUD_PROJECT is not set. This script writes an auth claim that grants ' +
        'write access to every collection — it will not guess which project.',
    );
  }

  if (!getApps().length) initializeApp({ projectId: PROJECT_ID });
  const auth = getAuth();

  console.log(`\n  project : ${PROJECT_ID}`);

  if (list) {
    const admins = await listAdmins(auth);
    console.log(`  admins  : ${admins.length}\n`);
    for (const user of admins) {
      console.log(`    • ${user.email ?? '(no email)'}  uid=${user.uid}`);
    }
    if (admins.length === 0) {
      console.log('    (none — no account can write to Firestore or Storage)');
    }
    console.log();
    return;
  }

  let user;
  try {
    user = await auth.getUserByEmail(email);
  } catch (error) {
    if (error?.code === 'auth/user-not-found') {
      fail(
        `No account exists for ${email}.\n` +
          '    A claim attaches to an account, so the person must sign up first — at\n' +
          '    https://wawitas.org/account — and then this script can promote them.',
      );
    }
    throw error;
  }

  const claims = user.customClaims ?? {};
  const wasAdmin = claims.admin === true;

  console.log(`  account : ${user.email}  uid=${user.uid}`);
  console.log(`  claims  : ${JSON.stringify(claims)}`);
  console.log(`  admin   : ${wasAdmin ? 'yes' : 'no'}`);

  if (check) {
    console.log();
    return;
  }

  if (revoke && !wasAdmin) {
    console.log('\n  nothing to do — this account is not an admin.\n');
    return;
  }
  if (!revoke && wasAdmin) {
    console.log('\n  nothing to do — this account is already an admin.\n');
    return;
  }

  // Spread the existing claims rather than replacing them; see trap 1 above.
  // Revoking DELETES the key instead of setting it false, so the stored object
  // never carries a misleading `admin` entry.
  const next = { ...claims };
  if (revoke) delete next.admin;
  else next.admin = true;

  await auth.setCustomUserClaims(user.uid, next);

  // Read back rather than trusting the write. This project's standing lesson
  // is that a call which returned without throwing is not a verified outcome.
  const after = await auth.getUser(user.uid);
  const isAdmin = after.customClaims?.admin === true;

  if (isAdmin === revoke) {
    fail(
      `The write returned successfully but the claim did not change — ` +
        `still ${JSON.stringify(after.customClaims ?? {})}.`,
    );
  }

  console.log(`\n  ✓ ${revoke ? 'revoked' : 'granted'} — claims are now ` +
    `${JSON.stringify(after.customClaims ?? {})}`);

  console.log(
    '\n  ⚠ The browser will not see this until the ID token rotates.\n' +
      '    Custom claims are baked into the token at issue time and Firebase\n' +
      '    refreshes it about once an hour. Tell them to sign out and back in;\n' +
      '    the admin UI also forces a refresh on load. A fresh grant that\n' +
      '    "does not work" is almost always this, not a failed write.\n',
  );
}

main().catch((error) => {
  console.error('\n  ✗ failed\n');
  console.error(error);
  process.exit(1);
});
