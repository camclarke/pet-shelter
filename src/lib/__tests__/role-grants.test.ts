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
