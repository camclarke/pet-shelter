import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CLAIMS_MAX_BYTES,
  auditEntry,
  changesAnything,
  claimsBytes,
  nextClaims,
  parseGrantArgs,
  parseSuEmailFile,
  SU_EMAIL_FILE,
  suGrantAllowed,
  suLockWarnings,
  wouldRemoveLastSuper,
} from '../role-grants';
import { ROLE_KEYS } from '@/config/roles';

// ─── the command line ────────────────────────────────────────────────────────

test('grant, revoke and check need exactly an email and a known role', () => {
  assert.deepEqual(parseGrantArgs(['ana@example.com', 'rescuer']), {
    ok: true,
    command: { mode: 'grant', email: 'ana@example.com', role: 'rescuer' },
  });
  assert.deepEqual(parseGrantArgs(['ana@example.com', 'events', '--revoke']), {
    ok: true,
    command: { mode: 'revoke', email: 'ana@example.com', role: 'events' },
  });
  assert.deepEqual(parseGrantArgs(['--check', 'ana@example.com', 'su']), {
    ok: true,
    command: { mode: 'check', email: 'ana@example.com', role: 'su' },
  });
});

test('an unknown role is refused, including near-misses', () => {
  for (const role of ['superuser', 'SU', 'Admin', 'coordinator', 'rescatista', '']) {
    const parsed = parseGrantArgs(['ana@example.com', role]);
    assert.equal(parsed.ok, false, role);
  }
});

test('every role key is accepted', () => {
  for (const role of ROLE_KEYS) assert.equal(parseGrantArgs(['a@b.co', role]).ok, true, role);
});

test('malformed command lines are refused, never guessed', () => {
  for (const argv of [
    [],
    ['ana@example.com'],
    ['rescuer'],
    ['rescuer', 'ana@example.com'],
    ['not-an-email', 'rescuer'],
    ['ana@example.com', 'rescuer', 'extra'],
    ['ana@example.com', 'rescuer', '--revoke', '--check'],
    ['ana@example.com', 'rescuer', '--force'],
    ['ana@example.com', 'rescuer', '--revoke', '--revoke'],
    ['--list', '--revoke'],
    ['--list', 'wizard'],
    ['--list', 'admin', 'extra'],
  ]) {
    assert.equal(parseGrantArgs(argv).ok, false, JSON.stringify(argv));
  }
});

test('--list, with or without a role filter', () => {
  assert.deepEqual(parseGrantArgs(['--list']), { ok: true, command: { mode: 'list', role: null } });
  assert.deepEqual(parseGrantArgs(['--list', 'admin']), { ok: true, command: { mode: 'list', role: 'admin' } });
});

// ─── the claims ──────────────────────────────────────────────────────────────

test('a grant MERGES: every other claim survives, known or not', () => {
  const before = { admin: true, events: true, somethingElse: 'kept' };
  assert.deepEqual(nextClaims(before, 'rescuer', 'grant'), {
    admin: true,
    events: true,
    somethingElse: 'kept',
    rescuer: true,
  });
  assert.deepEqual(before, { admin: true, events: true, somethingElse: 'kept' }, 'the input is not mutated');
});

test('a revoke DELETES the key — never writes false — and keeps the rest', () => {
  const after = nextClaims({ admin: true, rescuer: true }, 'rescuer', 'revoke');
  assert.deepEqual(after, { admin: true });
  assert.equal(Object.prototype.hasOwnProperty.call(after, 'rescuer'), false);
});

test('no claims at all is an empty object to merge into', () => {
  assert.deepEqual(nextClaims(null, 'su', 'grant'), { su: true });
  assert.deepEqual(nextClaims(undefined, 'su', 'revoke'), {});
});

test('changesAnything: a grant of a held role and a revoke of an absent one are no-ops', () => {
  assert.equal(changesAnything({ admin: true }, 'admin', 'grant'), false);
  assert.equal(changesAnything({ admin: true }, 'rescuer', 'grant'), true);
  assert.equal(changesAnything({ admin: true }, 'rescuer', 'revoke'), false);
  assert.equal(changesAnything({ admin: true }, 'admin', 'revoke'), true);
  assert.equal(changesAnything(null, 'admin', 'revoke'), false);
  // A stray non-true value is not a role, but a revoke still cleans it up.
  assert.equal(changesAnything({ admin: 'true' }, 'admin', 'grant'), true);
  assert.equal(changesAnything({ admin: false }, 'admin', 'revoke'), true);
});

test('claims size is UTF-8 bytes of the JSON, and every role together is far under the limit', () => {
  assert.equal(claimsBytes({ admin: true }), 14, 'the measured largest claims today (plan §0)');
  const all = Object.fromEntries(ROLE_KEYS.map((r) => [r, true]));
  assert.ok(claimsBytes(all) < 100, `all five roles: ${claimsBytes(all)} bytes`);
  assert.equal(CLAIMS_MAX_BYTES, 1000);
  assert.equal(claimsBytes({ n: 'ñ' }), 10, 'ñ is two bytes');
});

// ─── the last superuser ──────────────────────────────────────────────────────

test('revoking the only su is refused; with a second su it is allowed', () => {
  assert.equal(wouldRemoveLastSuper(['u1'], 'u1', 'su', 'revoke'), true);
  assert.equal(wouldRemoveLastSuper(['u1', 'u2'], 'u1', 'su', 'revoke'), false);
  assert.equal(wouldRemoveLastSuper([], 'u1', 'su', 'revoke'), true, 'no su at all is still no su');
});

test('the guard only concerns revoking su', () => {
  assert.equal(wouldRemoveLastSuper(['u1'], 'u1', 'su', 'grant'), false);
  for (const role of ROLE_KEYS.filter((r) => r !== 'su')) {
    assert.equal(wouldRemoveLastSuper(['u1'], 'u1', role, 'revoke'), false, role);
  }
  assert.equal(wouldRemoveLastSuper(['u1'], 'u2', 'su', 'revoke'), false, 'revoking su from a non-holder leaves u1');
});

// ─── the audit ───────────────────────────────────────────────────────────────

test('an audit entry starts as attempted and records who, whom, what and both claim sets', () => {
  const entry = auditEntry({
    action: 'grant',
    role: 'rescuer',
    targetUid: 'u1',
    targetEmail: 'a@b.co',
    actor: 'israel@example.com',
    claimsBefore: {},
    claimsAfter: { rescuer: true },
  });
  assert.equal(entry.outcome, 'attempted');
  assert.deepEqual(Object.keys(entry).sort(), [
    'action', 'actor', 'claimsAfter', 'claimsBefore', 'outcome', 'role', 'targetEmail', 'targetUid',
  ]);
});

// ─── the su lock ─────────────────────────────────────────────────────────────

test('suGrantAllowed admits only the allowed email, ignoring case and surrounding spaces', () => {
  assert.equal(suGrantAllowed('boss@example.com', 'boss@example.com'), true);
  assert.equal(suGrantAllowed('  Boss@Example.COM ', 'boss@example.com'), true);
  assert.equal(suGrantAllowed('boss@example.com', ' BOSS@example.com\t'), true);
  assert.equal(suGrantAllowed('other@example.com', 'boss@example.com'), false);
  assert.equal(suGrantAllowed('boss@example.co', 'boss@example.com'), false);
  assert.equal(suGrantAllowed('', 'boss@example.com'), false);
});

test('suGrantAllowed fails CLOSED when the allowed email is absent, empty or garbage', () => {
  for (const allowed of [null, '', '   ', 'boss', '@example.com', 'boss@', 'a@b@example.com', 'bo ss@example.com']) {
    assert.equal(suGrantAllowed('boss@example.com', allowed), false, JSON.stringify(allowed));
    if (allowed !== null) assert.equal(suGrantAllowed(allowed, allowed), false, `${JSON.stringify(allowed)} matching itself`);
  }
});

test('parseSuEmailFile reads the first real line: BOM, comments and blanks are skipped', () => {
  assert.equal(SU_EMAIL_FILE, '_local/su-email');
  assert.equal(parseSuEmailFile('boss@example.com\n'), 'boss@example.com');
  assert.equal(parseSuEmailFile('﻿boss@example.com\r\n'), 'boss@example.com');
  assert.equal(parseSuEmailFile('# the superuser\n\n   boss@example.com   \nother@example.com\n'), 'boss@example.com');
  assert.equal(parseSuEmailFile(null), null);
  assert.equal(parseSuEmailFile(''), null);
  assert.equal(parseSuEmailFile('\n  \n# only a comment\n'), null);
  assert.equal(parseSuEmailFile('a@b@example.com\n'), null);
  assert.equal(parseSuEmailFile('not an email\nboss@example.com\n'), null, 'an invalid first line is not skipped');
});

test('suLockWarnings: a missing file, and every su holder who is not the allowed email', () => {
  const accounts = [
    { email: 'boss@example.com', claims: { su: true } },
    { email: 'intruder@example.com', claims: { su: true, admin: true } },
    { email: 'staff@example.com', claims: { admin: true } },
    { email: 'stringy@example.com', claims: { su: 'true' } },
    { email: null, claims: { su: true } },
  ];
  assert.deepEqual(suLockWarnings(accounts, 'BOSS@example.com'), [
    'intruder@example.com holds su but is not the email in _local/su-email.',
    '(no email) holds su but is not the email in _local/su-email.',
  ]);
  assert.deepEqual(suLockWarnings([accounts[0]!], 'boss@example.com'), []);
  const missing = suLockWarnings(accounts, null);
  assert.equal(missing.length, 1);
  assert.match(missing[0]!, /_local\/su-email is missing or invalid/);
  for (const line of suLockWarnings(accounts, 'boss@example.com')) assert.ok(!line.includes('boss@'), 'never names the allowed email');
});

// ─── the scripts' wiring ─────────────────────────────────────────────────────

test('grant-admin.mjs maps its old arguments onto grant-role with the admin role', async () => {
  const url = pathToFileURL(join(process.cwd(), 'scripts', 'grant-admin.mjs')).href;
  const mod = await import(url);
  assert.deepEqual(mod.toGrantRoleArgs(['a@b.co']), ['a@b.co', 'admin']);
  assert.deepEqual(mod.toGrantRoleArgs(['a@b.co', '--revoke']), ['a@b.co', 'admin', '--revoke']);
  assert.deepEqual(mod.toGrantRoleArgs(['--check', 'a@b.co']), ['a@b.co', 'admin', '--check']);
  assert.deepEqual(mod.toGrantRoleArgs(['--list']), ['--list', 'admin']);
});

test('grant-role.mjs revokes refresh tokens, audits before and after, and checks the last su', () => {
  const src = readFileSync(join(process.cwd(), 'scripts', 'grant-role.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const at = (needle: string) => {
    const i = src.indexOf(needle);
    assert.ok(i >= 0, `grant-role.mjs never mentions ${needle}`);
    return i;
  };
  assert.ok(at("collection('roleAudit').add(") < at('setCustomUserClaims('), 'the audit is written before the change');
  assert.ok(at('setCustomUserClaims(') < at('revokeRefreshTokens('), 'tokens are revoked after the claim changes');
  assert.ok(at("outcome: 'applied'") > at('revokeRefreshTokens('), 'applied only after the revoke');
  assert.ok(at('wouldRemoveLastSuper(') < at('setCustomUserClaims('), 'the last-su check runs before any write');
  assert.ok(at('changesAnything(') < at("collection('roleAudit').add("), 'a no-op writes no audit');
  assert.ok(at('CLAIMS_MAX_BYTES') < at('setCustomUserClaims('));
  assert.equal(/setCustomUserClaims\([^)]*\{/.test(src), false, 'claims are never written as a literal: always nextClaims()');
});

test('grant-role.mjs runs the su lock before any network call, and reads the file from the repo root', () => {
  const src = readFileSync(join(process.cwd(), 'scripts', 'grant-role.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const at = (needle: string) => {
    const i = src.indexOf(needle);
    assert.ok(i >= 0, `grant-role.mjs never mentions ${needle}`);
    return i;
  };
  const lock = at("if (command.mode === 'grant' && command.role === 'su') enforceSuLock(command.email);");
  assert.ok(lock > at('parseGrantArgs('), 'the lock reads the parsed command');
  assert.ok(lock < at('initializeApp('), 'the lock runs before the Admin SDK starts');
  assert.ok(lock < at('getUserByEmail('), 'the lock runs before the account is looked up');
  assert.ok(lock < at('getAuth()'), 'the lock runs before auth is touched');
  assert.ok(at('suGrantAllowed(') < lock, 'enforceSuLock decides with suGrantAllowed');
  assert.match(src, /new URL\(`\.\.\/\$\{SU_EMAIL_FILE\}`, import\.meta\.url\)/, 'the file is resolved from the script, never the cwd');
  assert.doesNotMatch(src, /process\.cwd\(\)/);
  assert.equal((src.match(/printSuLockWarnings\(/g) ?? []).length, 3, 'defined once, called by --list and --check');
});
