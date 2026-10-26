/**
 * `decideRoleChange()` — the one place the role guardrails of plan §12.2 are
 * decided, for the screen and for the grant script alike.
 *
 * The exhaustive test does NOT compute its expectations with the function
 * under test, nor with `GRANTABLE_BY`: `oracle()` below restates plan §12.1
 * and §12.2 from scratch, as plain literals, so a change to either the table
 * or the function that the plan did not make fails here by name.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  GRANTABLE_BY,
  NO_ROLES,
  ROLE_KEYS,
  ROLE_MANAGERS,
  SECTION_ROLES,
  VISIBLE_ROLE_KEYS,
  grantableBy,
  managerLevel,
  rolesFromClaims,
  visibleRoles,
  type RoleKey,
} from '@/config/roles';
import {
  CLAIMS_MAX_BYTES,
  ROLE_CHANGE_REFUSALS,
  countOwners,
  decideRoleChange,
  type ClaimsObject,
} from '../role-grants';

// ─── the tables, pinned as literals ──────────────────────────────────────────

test('GRANTABLE_BY: the owner changes admin, rescuer, events, finance; su adds owner; su is in neither', () => {
  assert.deepEqual([...GRANTABLE_BY.owner].sort(), ['admin', 'events', 'finance', 'rescuer']);
  assert.deepEqual([...GRANTABLE_BY.su].sort(), ['admin', 'events', 'finance', 'owner', 'rescuer']);
  assert.deepEqual(Object.keys(GRANTABLE_BY).sort(), ['owner', 'su']);
  for (const list of Object.values(GRANTABLE_BY)) assert.equal(list.includes('su'), false);
});

test('ROLE_MANAGERS is owner + su, and the roles section is theirs', () => {
  assert.deepEqual([...ROLE_MANAGERS].sort(), ['owner', 'su']);
  assert.deepEqual([...SECTION_ROLES.roles].sort(), ['owner', 'su']);
});

test('managerLevel and grantableBy: su outranks owner; nobody else manages anyone', () => {
  const only = (...keys: RoleKey[]) => rolesFromClaims(Object.fromEntries(keys.map((k) => [k, true])));
  assert.equal(managerLevel(only('su', 'owner')), 'su');
  assert.equal(managerLevel(only('owner', 'admin')), 'owner');
  for (const role of ['admin', 'finance', 'rescuer', 'events'] as const) {
    assert.equal(managerLevel(only(role)), null, role);
    assert.deepEqual(grantableBy(only(role)), [], role);
  }
  assert.equal(managerLevel(NO_ROLES), null);
  assert.deepEqual([...grantableBy(only('owner', 'su'))].sort(), ['admin', 'events', 'finance', 'owner', 'rescuer']);
});

test('visibleRoles never carries the su key, whatever the claims', () => {
  assert.deepEqual([...VISIBLE_ROLE_KEYS], ['owner', 'admin', 'finance', 'rescuer', 'events']);
  const v = visibleRoles(rolesFromClaims({ su: true, owner: true }));
  assert.equal(Object.prototype.hasOwnProperty.call(v, 'su'), false);
  assert.equal(JSON.stringify(v).includes('"su"'), false);
  assert.equal(v.owner, true);
});

test('countOwners counts owner exactly true, nothing else', () => {
  assert.equal(countOwners([{ claims: { owner: true } }, { claims: { owner: 'true' } }, { claims: null }, { claims: { owner: true, su: true } }]), 2);
  assert.equal(countOwners([]), 0);
});

// ─── the independent oracle ──────────────────────────────────────────────────

const CALLERS: Record<string, ClaimsObject> = {
  owner: { owner: true },
  su: { su: true },
  'owner+admin': { owner: true, admin: true },
  admin: { admin: true },
  finance: { finance: true },
  none: {},
};

const TARGETS: Record<string, ClaimsObject | 'self'> = {
  self: 'self',
  plain: {},
  admin: { admin: true },
  owner: { owner: true },
  su: { su: true },
  'owner+su': { owner: true, su: true },
};

/** Plan §12.1 + §12.2, restated without the code under test. */
function oracle(
  caller: ClaimsObject,
  target: ClaimsObject,
  isSelf: boolean,
  role: RoleKey,
  action: 'grant' | 'revoke',
  ownersCount: number,
): string {
  const callerIsSu = caller.su === true;
  const callerIsOwner = caller.owner === true;
  if (!callerIsSu && !callerIsOwner) return 'forbidden';
  // §12.1: owner → admin, rescuer, events, finance; su → those + owner; su never in-app.
  const mayChange = callerIsSu ? ['admin', 'rescuer', 'events', 'finance', 'owner'] : ['admin', 'rescuer', 'events', 'finance'];
  if (!mayChange.includes(role)) return 'not-allowed-role';
  if (isSelf) return 'self'; // G3
  if (target.su === true) return 'target-is-su'; // G4
  if (target.owner === true && !callerIsSu) return 'target-is-owner'; // G4
  const holds = target[role] === true;
  const present = Object.prototype.hasOwnProperty.call(target, role);
  if (action === 'grant' ? holds : !present) return 'no-change';
  if (role === 'owner' && action === 'revoke' && target.owner === true && ownersCount <= 1) return 'last-owner'; // G3
  return 'ok';
}

test('decideRoleChange: every caller × target × role × action × owners count agrees with the oracle', () => {
  let cases = 0;
  const seen = new Set<string>();
  for (const [callerName, callerClaims] of Object.entries(CALLERS)) {
    for (const [targetName, targetSpec] of Object.entries(TARGETS)) {
      const isSelf = targetSpec === 'self';
      const targetClaims = isSelf ? callerClaims : targetSpec;
      const targetUid = isSelf ? 'uid-caller' : `uid-${targetName}`;
      for (const role of ROLE_KEYS) {
        for (const action of ['grant', 'revoke'] as const) {
          for (const ownersCount of [1, 2]) {
            const expected = oracle(callerClaims, targetClaims, isSelf, role, action, ownersCount);
            const got = decideRoleChange({
              caller: { uid: 'uid-caller', roles: rolesFromClaims(callerClaims) },
              target: { uid: targetUid, claims: targetClaims },
              role,
              action,
              ownersCount,
            });
            const actual = got.ok ? 'ok' : got.reason;
            assert.equal(actual, expected, `${callerName} ${action}s ${role} on ${targetName} (owners=${ownersCount})`);
            seen.add(actual);
            cases++;
          }
        }
      }
    }
  }
  assert.equal(cases, 6 * 6 * 6 * 2 * 2);
  // The grid reaches every outcome but the size limit, which has its own test.
  for (const outcome of ['ok', ...ROLE_CHANGE_REFUSALS.filter((r) => r !== 'claims-too-large')]) {
    assert.ok(seen.has(outcome), `the grid never produced ${outcome}`);
  }
});

// ─── each guardrail, by name ─────────────────────────────────────────────────

const ask = (callerClaims: ClaimsObject, targetClaims: ClaimsObject, role: RoleKey, action: 'grant' | 'revoke', extra: Partial<{ ownersCount: number; via: 'screen' | 'script'; self: boolean }> = {}) => {
  const d = decideRoleChange({
    caller: { uid: 'me', roles: rolesFromClaims(callerClaims) },
    target: { uid: extra.self ? 'me' : 'them', claims: targetClaims },
    role,
    action,
    ownersCount: extra.ownersCount ?? 2,
    ...(extra.via ? { via: extra.via } : {}),
  });
  return d.ok ? 'ok' : d.reason;
};

test('G1: the owner may NOT grant owner (a peer), nor su; su may grant owner; nobody grants su in-app', () => {
  assert.equal(ask({ owner: true }, {}, 'owner', 'grant'), 'not-allowed-role');
  assert.equal(ask({ owner: true }, {}, 'su', 'grant'), 'not-allowed-role');
  assert.equal(ask({ su: true }, {}, 'owner', 'grant'), 'ok');
  assert.equal(ask({ su: true }, {}, 'su', 'grant'), 'not-allowed-role');
  assert.equal(ask({ su: true }, {}, 'su', 'grant', { via: 'script' }), 'not-allowed-role', 'even the script: su has its own path');
  assert.equal(ask({ owner: true }, {}, 'finance', 'grant'), 'ok');
});

test('G3: nobody changes their own roles — not even the superuser', () => {
  assert.equal(ask({ owner: true, admin: true }, { owner: true, admin: true }, 'admin', 'revoke', { self: true }), 'self');
  assert.equal(ask({ su: true }, { su: true }, 'finance', 'grant', { self: true }), 'self');
});

test('G3: the last owner cannot be revoked; with a second owner it can', () => {
  assert.equal(ask({ su: true }, { owner: true }, 'owner', 'revoke', { ownersCount: 1 }), 'last-owner');
  assert.equal(ask({ su: true }, { owner: true }, 'owner', 'revoke', { ownersCount: 0 }), 'last-owner', 'an inconsistent count still refuses');
  assert.equal(ask({ su: true }, { owner: true }, 'owner', 'revoke', { ownersCount: 2 }), 'ok');
  assert.equal(ask({ su: true }, { owner: 'true' }, 'owner', 'revoke', { ownersCount: 1 }), 'ok', 'a stray non-true key is not an owner');
});

test('G4: an su account is untouchable on the screen; an owner account is the superuser’s alone', () => {
  assert.equal(ask({ owner: true }, { su: true }, 'finance', 'grant'), 'target-is-su');
  assert.equal(ask({ su: true }, { su: true }, 'finance', 'grant'), 'target-is-su');
  assert.equal(ask({ owner: true }, { owner: true }, 'admin', 'grant'), 'target-is-owner');
  assert.equal(ask({ owner: true, admin: true }, { owner: true, admin: true }, 'admin', 'revoke'), 'target-is-owner');
  assert.equal(ask({ su: true }, { owner: true }, 'admin', 'grant'), 'ok');
  // A protected account answers the SAME way whatever it holds: no-change cannot leak its roles.
  assert.equal(ask({ owner: true }, { su: true, finance: true }, 'finance', 'grant'), 'target-is-su');
});

test('the script (via: script) may change an account holding su — the superuser’s own tool — and nothing else is relaxed', () => {
  assert.equal(ask({ su: true }, { su: true }, 'finance', 'grant', { via: 'script' }), 'ok');
  assert.equal(ask({ su: true }, { su: true, owner: true }, 'owner', 'revoke', { via: 'script', ownersCount: 1 }), 'last-owner');
  assert.equal(ask({ su: true }, { finance: true }, 'finance', 'grant', { via: 'script' }), 'no-change');
});

test('claims-too-large: a change that would pass 1000 bytes is refused', () => {
  const big = { note: 'x'.repeat(CLAIMS_MAX_BYTES - 20) };
  assert.equal(ask({ su: true }, big, 'finance', 'grant'), 'claims-too-large');
  assert.equal(ask({ su: true }, { note: 'x'.repeat(10) }, 'finance', 'grant'), 'ok');
});

test('a forbidden caller is refused before anything about the target is looked at', () => {
  for (const claims of [{ admin: true }, { finance: true }, { rescuer: true, events: true }, {}, { su: 'true' }]) {
    assert.equal(ask(claims, { su: true }, 'su', 'grant', { self: true }), 'forbidden', JSON.stringify(claims));
  }
});

// ─── the script decides with it ──────────────────────────────────────────────

test('grant-role.mjs: every role but su goes through decideRoleChange as su via script; su keeps its own locked path', () => {
  const src = readFileSync(join(process.cwd(), 'scripts', 'grant-role.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const at = (needle: string) => {
    const i = src.indexOf(needle);
    assert.ok(i >= 0, `grant-role.mjs never mentions ${needle}`);
    return i;
  };
  const suBranch = at("if (role === 'su') {");
  const decide = at('decideRoleChange({');
  assert.ok(suBranch < at('wouldRemoveLastSuper(') && at('wouldRemoveLastSuper(') < decide, 'the last-su check lives in the su branch');
  assert.match(src, /caller: \{ uid: SCRIPT_CALLER_UID, roles: rolesFromClaims\(\{ su: true \}\) \}/);
  assert.match(src, /via: 'script',\s*\}\);/);
  assert.ok(decide < at("collection('roleAudit').add("), 'decided before the audit write');
  assert.ok(decide < at('setCustomUserClaims('), 'decided before the claim write');
  assert.match(src, /const SCRIPT_CALLER_UID = 'script: grant-role\.mjs';/);
  // The su email lock is untouched (role-grants.test.ts pins its position).
  assert.ok(src.includes("if (command.mode === 'grant' && command.role === 'su') enforceSuLock(command.email);"));
});
