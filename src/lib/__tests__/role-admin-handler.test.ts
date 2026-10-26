/**
 * The role routes (plan §12, PR-3), driven through their pure handlers with a
 * fake Auth and a fake audit log. Every guardrail is exercised from the
 * request in, and the write sequence is checked by the ORDER of the fake's
 * operations — the same order `scripts/grant-role.mjs` follows.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  REFUSAL_RESPONSE,
  ROLE_FAILURE_HEADER,
  handleRoleChange,
  handleRoleStaff,
  parseChangeBody,
  roleFailure,
  type AuthAccount,
  type RoleAdminDeps,
} from '../role-admin-handler';
import { NO_ACCOUNT_HINT, ROLE_FAILURES, ROLE_JSON_MAX_BYTES, type StaffResponse } from '../role-admin-protocol';
import { ROLE_CHANGE_REFUSALS, type RoleAuditEntry } from '../role-grants';
import type { VerifiedIdToken } from '../require-admin';

const NOW = Date.UTC(2026, 9, 26, 16, 0, 0);
const NOW_S = NOW / 1000;

// ─── personas ────────────────────────────────────────────────────────────────

const TOKENS: Record<string, VerifiedIdToken> = {
  owner: { uid: 'uid-owner', email: 'owner@example.com', owner: true, auth_time: NOW_S - 60 },
  ownerAdmin: { uid: 'uid-owner', email: 'owner@example.com', owner: true, admin: true, auth_time: NOW_S - 60 },
  su: { uid: 'uid-su', email: 'su@example.com', su: true, auth_time: NOW_S - 60 },
  ownerOld: { uid: 'uid-owner', owner: true, auth_time: NOW_S - 301 },
  ownerEdge: { uid: 'uid-owner', owner: true, auth_time: NOW_S - 300 },
  ownerNoAuthTime: { uid: 'uid-owner', owner: true },
  suOld: { uid: 'uid-su', su: true, auth_time: NOW_S - 3600 },
  admin: { uid: 'uid-admin', admin: true, auth_time: NOW_S - 60 },
  finance: { uid: 'uid-fin', finance: true, auth_time: NOW_S - 60 },
  rescuer: { uid: 'uid-res', rescuer: true, auth_time: NOW_S - 60 },
  events: { uid: 'uid-ev', events: true, auth_time: NOW_S - 60 },
  user: { uid: 'uid-plain', auth_time: NOW_S - 60 },
  stringOwner: { uid: 'uid-x', owner: 'true', auth_time: NOW_S - 60 } as unknown as VerifiedIdToken,
};

/** The project as the fake Auth holds it. */
function accounts(): AuthAccount[] {
  return [
    { uid: 'uid-owner', email: 'owner@example.com', displayName: 'Dueña', claims: { owner: true } },
    { uid: 'uid-owner2', email: 'owner2@example.com', displayName: null, claims: { owner: true } },
    { uid: 'uid-su', email: 'su@example.com', displayName: 'Hidden', claims: { su: true } },
    { uid: 'uid-sufin', email: 'sufin@example.com', displayName: null, claims: { su: true, finance: true } },
    { uid: 'uid-admin', email: 'admin@example.com', displayName: 'Coord', claims: { admin: true, legacy: 'kept' } },
    { uid: 'uid-fin', email: 'fin@example.com', displayName: null, claims: { finance: true } },
    { uid: 'uid-res', email: 'res@example.com', displayName: null, claims: { rescuer: true, events: true } },
    { uid: 'uid-plain', email: 'plain@example.com', displayName: 'Plain', claims: null },
    { uid: 'uid-noemail', email: null, displayName: null, claims: { events: true } },
  ];
}

interface World {
  users: Map<string, AuthAccount>;
  audit: Map<string, RoleAuditEntry & { appliedClaims?: unknown }>;
  ops: string[];
  logs: string[];
}

function world(list: AuthAccount[] = accounts()): World {
  return { users: new Map(list.map((a) => [a.uid, structuredClone(a)])), audit: new Map(), ops: [], logs: [] };
}

function deps(w: World, over: Partial<RoleAdminDeps> = {}): RoleAdminDeps {
  let n = 0;
  return {
    verifyIdToken: async (token, checkRevoked) => {
      assert.equal(checkRevoked, true, 'every verification checks revocation');
      if (token === 'revoked') throw new Error('auth/id-token-revoked');
      const t = TOKENS[token];
      if (!t) throw new Error('auth/argument-error');
      return t;
    },
    nowMs: () => NOW,
    listAllUsers: async () => {
      w.ops.push('listAllUsers');
      return [...w.users.values()].map((a) => structuredClone(a));
    },
    getUserByEmail: async (email) => {
      w.ops.push('getUserByEmail');
      const found = [...w.users.values()].find((a) => a.email === email);
      return found ? structuredClone(found) : null;
    },
    getUser: async (uid) => {
      w.ops.push('getUser');
      return structuredClone(w.users.get(uid)!);
    },
    setClaims: async (uid, claims) => {
      w.ops.push('setClaims');
      w.users.get(uid)!.claims = structuredClone(claims);
    },
    revokeRefreshTokens: async () => {
      w.ops.push('revokeRefreshTokens');
    },
    addAudit: async (entry) => {
      w.ops.push(`addAudit:${entry.outcome}`);
      const id = `a${++n}`;
      w.audit.set(id, structuredClone(entry));
      return id;
    },
    markAuditApplied: async (id, claimsRead) => {
      w.ops.push('markAuditApplied');
      const e = w.audit.get(id)!;
      w.audit.set(id, { ...e, outcome: 'applied', appliedClaims: claimsRead });
    },
    readAuditOutcome: async (id) => {
      w.ops.push('readAuditOutcome');
      return w.audit.get(id)?.outcome ?? null;
    },
    log: (m) => w.logs.push(m),
    ...over,
  };
}

function req(method: 'GET' | 'POST', token: string | null, body?: unknown, contentType = 'application/json'): Request {
  const headers = new Headers();
  if (method === 'POST') headers.set('content-type', contentType);
  if (token) headers.set('authorization', `Bearer ${token}`);
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request('http://localhost/api/roles/x', init);
}

const change = (w: World, token: string | null, body: unknown, d?: RoleAdminDeps) => handleRoleChange(req('POST', token, body), d ?? deps(w));
const staff = (w: World, token: string | null, d?: RoleAdminDeps) => handleRoleStaff(req('GET', token), d ?? deps(w));

async function failureOf(res: Response) {
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get(ROLE_FAILURE_HEADER), body.error, 'the header names the same error as the body');
  return { status: res.status, error: body.error as string, body };
}

const WRITES = ['addAudit:attempted', 'setClaims', 'revokeRefreshTokens', 'markAuditApplied'];
const wrote = (w: World) => w.ops.filter((op) => WRITES.includes(op));

// ─── the guard ───────────────────────────────────────────────────────────────

const BOTH: [string, (w: World, token: string | null) => Promise<Response>][] = [
  ['staff', (w, t) => staff(w, t)],
  ['change', (w, t) => change(w, t, { email: 'plain@example.com', role: 'finance', action: 'grant' })],
];

test('no token, or a revoked or invalid one → 401, on both routes, before anything is read', async () => {
  for (const [name, call] of BOTH) {
    for (const token of [null, 'revoked', 'garbage']) {
      const w = world();
      const f = await failureOf(await call(w, token));
      assert.deepEqual([f.status, f.error], [401, 'unauthenticated'], `${name} ${token}`);
      assert.deepEqual(w.ops, [], `${name} ${token}`);
    }
  }
});

test('wrong role → 403 forbidden: coordination, Tesorería, rescuer, event staff, no role, the string "true"', async () => {
  for (const [name, call] of BOTH) {
    for (const token of ['admin', 'finance', 'rescuer', 'events', 'user', 'stringOwner']) {
      const w = world();
      const f = await failureOf(await call(w, token));
      assert.deepEqual([f.status, f.error], [403, 'forbidden'], `${name} as ${token}`);
      assert.deepEqual(w.ops, [], `${name} as ${token}`);
    }
  }
});

test('G2: a change needs a sign-in under 5 minutes → else 403 requires-recent-login; the staff list does not', async () => {
  for (const token of ['ownerOld', 'ownerNoAuthTime', 'suOld']) {
    const w = world();
    const f = await failureOf(await change(w, token, { email: 'plain@example.com', role: 'finance', action: 'grant' }));
    assert.deepEqual([f.status, f.error], [403, 'requires-recent-login'], token);
    assert.deepEqual(w.ops, [], token);
    assert.equal((await staff(world(), token)).status, 200, `staff as ${token}`);
  }
  const w = world();
  assert.equal((await change(w, 'ownerEdge', { email: 'plain@example.com', role: 'finance', action: 'grant' })).status, 200, 'exactly 300 s passes');
});

// ─── GET /api/roles/staff ────────────────────────────────────────────────────

test('staff: every account holding a role EXCEPT su holders, sorted by email, and the su key appears nowhere', async () => {
  const res = await staff(world(), 'owner');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const text = await res.text();
  const body = JSON.parse(text) as StaffResponse;
  assert.deepEqual(
    body.staff.map((m) => m.uid),
    ['uid-admin', 'uid-fin', 'uid-owner', 'uid-owner2', 'uid-res', 'uid-noemail'],
  );
  assert.equal(text.includes('"su"'), false, 'no su key anywhere in the response');
  assert.equal(text.includes('su@example.com'), false);
  assert.equal(text.includes('sufin@example.com'), false);
  assert.equal(text.includes('Administración general'), false);
  assert.equal(body.ownersCount, 2);
  const admin = body.staff.find((m) => m.uid === 'uid-admin')!;
  assert.deepEqual(admin.labels, ['Coordinación']);
  assert.deepEqual(admin.roles, { owner: false, admin: true, finance: false, rescuer: false, events: false });
  assert.equal(admin.displayName, 'Coord');
});

test('staff: editable as the OWNER — G1 no owner role, G3 own row empty, G4 peer owner empty', async () => {
  const body = (await (await staff(world(), 'owner')).json()) as StaffResponse;
  const row = (uid: string) => body.staff.find((m) => m.uid === uid)!.editable;
  assert.deepEqual(body.grantable, ['admin', 'finance', 'rescuer', 'events']);
  assert.deepEqual(row('uid-admin'), { grant: ['finance', 'rescuer', 'events'], revoke: ['admin'] });
  assert.deepEqual(row('uid-res'), { grant: ['admin', 'finance'], revoke: ['rescuer', 'events'] });
  assert.deepEqual(row('uid-owner'), { grant: [], revoke: [] }, 'own row (G3)');
  assert.deepEqual(row('uid-owner2'), { grant: [], revoke: [] }, 'peer owner (G4)');
});

test('staff: editable as the SUPERUSER — owner can be granted and revoked, but never the last one', async () => {
  const body = (await (await staff(world(), 'su')).json()) as StaffResponse;
  const row = (uid: string) => body.staff.find((m) => m.uid === uid)!.editable;
  assert.deepEqual(body.grantable, ['owner', 'admin', 'finance', 'rescuer', 'events']);
  assert.deepEqual(row('uid-owner2'), { grant: ['admin', 'finance', 'rescuer', 'events'], revoke: ['owner'] });
  assert.deepEqual(row('uid-admin').grant, ['owner', 'finance', 'rescuer', 'events']);
  // With only one owner left, its owner role is not revocable.
  const w = world(accounts().filter((a) => a.uid !== 'uid-owner2'));
  const one = (await (await staff(w, 'su')).json()) as StaffResponse;
  assert.equal(one.ownersCount, 1);
  assert.deepEqual(one.staff.find((m) => m.uid === 'uid-owner')!.editable.revoke, []);
});

test('staff: a failed Auth read answers 500 read-failed', async () => {
  const w = world();
  const f = await failureOf(await staff(w, 'owner', deps(w, { listAllUsers: async () => { throw new Error('boom'); } })));
  assert.deepEqual([f.status, f.error], [500, 'read-failed']);
});

// ─── POST /api/roles/change: refusals ────────────────────────────────────────

test('G1: the owner may not grant owner, and nobody may touch su — refused before any Auth read', async () => {
  for (const [token, role] of [['owner', 'owner'], ['owner', 'su'], ['su', 'su']] as const) {
    for (const action of ['grant', 'revoke'] as const) {
      const w = world();
      const f = await failureOf(await change(w, token, { email: 'plain@example.com', role, action }));
      assert.deepEqual([f.status, f.error], [403, 'not-allowed-role'], `${token} ${action} ${role}`);
      assert.deepEqual(w.ops, [], 'no lookup');
    }
  }
});

test('G3: nobody changes their own roles → 403 self', async () => {
  const w = world();
  w.users.get('uid-owner')!.claims = { owner: true, admin: true };
  const f = await failureOf(await change(w, 'ownerAdmin', { email: 'owner@example.com', role: 'admin', action: 'revoke' }));
  assert.deepEqual([f.status, f.error], [403, 'self']);
  assert.deepEqual(wrote(w), []);
});

test('G3: the last owner cannot be revoked → 409 last-owner; with two owners su may revoke one', async () => {
  const w1 = world(accounts().filter((a) => a.uid !== 'uid-owner2'));
  const f = await failureOf(await change(w1, 'su', { email: 'owner@example.com', role: 'owner', action: 'revoke' }));
  assert.deepEqual([f.status, f.error], [409, 'last-owner']);
  assert.deepEqual(wrote(w1), []);

  const w2 = world();
  assert.equal((await change(w2, 'su', { email: 'owner2@example.com', role: 'owner', action: 'revoke' })).status, 200);
  assert.equal(w2.users.get('uid-owner2')!.claims!.owner, undefined);
});

test('G4: an su account answers protected-account, the SAME as a peer owner’s, so a refusal cannot reveal the superuser', async () => {
  const bodies: string[] = [];
  for (const email of ['su@example.com', 'sufin@example.com', 'owner2@example.com']) {
    const w = world();
    const res = await change(w, 'owner', { email, role: 'finance', action: 'grant' });
    const f = await failureOf(res.clone());
    assert.deepEqual([f.status, f.error], [403, 'protected-account'], email);
    assert.deepEqual(wrote(w), [], email);
    bodies.push(await res.text());
  }
  assert.equal(new Set(bodies).size, 1, 'identical bodies');
  // Even the superuser cannot change an su account on the screen.
  const w = world();
  assert.equal((await failureOf(await change(w, 'su', { email: 'sufin@example.com', role: 'admin', action: 'grant' }))).error, 'protected-account');
  // Only the superuser changes an owner's account.
  const w2 = world();
  assert.equal((await change(w2, 'su', { email: 'owner2@example.com', role: 'finance', action: 'grant' })).status, 200);
});

test('every refusal of decideRoleChange maps to a documented wire error', () => {
  for (const reason of ROLE_CHANGE_REFUSALS) {
    const mapped = REFUSAL_RESPONSE[reason];
    assert.ok(mapped, reason);
    assert.ok((ROLE_FAILURES as readonly string[]).includes(mapped.error), `${reason} → ${mapped.error}`);
  }
  assert.equal(REFUSAL_RESPONSE['target-is-su'].error, REFUSAL_RESPONSE['target-is-owner'].error);
});

test('unknown email → 404 no-account with the Spanish hint; the email is matched trimmed and lower-case', async () => {
  const w = world();
  const f = await failureOf(await change(w, 'owner', { email: 'nobody@example.com', role: 'finance', action: 'grant' }));
  assert.deepEqual([f.status, f.error, f.body.hint], [404, 'no-account', NO_ACCOUNT_HINT]);
  assert.match(NO_ACCOUNT_HINT, /wawitas\.org\/account/);
  assert.deepEqual(wrote(w), []);
  const w2 = world();
  assert.equal((await change(w2, 'owner', { email: '  PLAIN@Example.com ', role: 'finance', action: 'grant' })).status, 200);
});

test('no-change → 409: granting a held role, revoking an absent one; nothing is written', async () => {
  for (const [email, role, action] of [['fin@example.com', 'finance', 'grant'], ['plain@example.com', 'admin', 'revoke']] as const) {
    const w = world();
    const f = await failureOf(await change(w, 'owner', { email, role, action }));
    assert.deepEqual([f.status, f.error], [409, 'no-change'], `${action} ${role}`);
    assert.deepEqual(wrote(w), []);
  }
});

test('claims over 1000 bytes → 422 claims-too-large, nothing written', async () => {
  const w = world();
  w.users.get('uid-plain')!.claims = { blob: 'x'.repeat(990) };
  const f = await failureOf(await change(w, 'owner', { email: 'plain@example.com', role: 'finance', action: 'grant' }));
  assert.deepEqual([f.status, f.error], [422, 'claims-too-large']);
  assert.deepEqual(wrote(w), []);
});

test('bad bodies: not JSON → 415, broken JSON or wrong shapes → 400, over the cap → 413', async () => {
  const w = world();
  assert.equal((await failureOf(await handleRoleChange(req('POST', 'owner', '{}', 'text/plain'), deps(w)))).error, 'not-json');
  assert.equal((await failureOf(await handleRoleChange(req('POST', 'owner', '{nope'), deps(w)))).error, 'invalid-body');
  for (const body of [
    null, [], 'x', {}, { email: 'a@b.co', role: 'finance' }, { email: 'a@b.co', role: 'boss', action: 'grant' },
    { email: 'a@b.co', role: 'finance', action: 'promote' }, { email: 'not-an-email', role: 'finance', action: 'grant' },
    { email: 42, role: 'finance', action: 'grant' }, { email: `${'a'.repeat(320)}@b.co`, role: 'finance', action: 'grant' },
  ]) {
    const f = await failureOf(await change(w, 'owner', body));
    assert.deepEqual([f.status, f.error], [400, 'invalid-body'], JSON.stringify(body));
  }
  const big = { email: 'a@b.co', role: 'finance', action: 'grant', pad: 'x'.repeat(ROLE_JSON_MAX_BYTES) };
  assert.equal((await failureOf(await change(w, 'owner', big))).error, 'too-large');
  assert.deepEqual(wrote(w), []);
});

test('parseChangeBody accepts exactly {email, role, action}', () => {
  assert.deepEqual(parseChangeBody({ email: ' A@B.co ', role: 'events', action: 'revoke' }), { email: 'a@b.co', role: 'events', action: 'revoke' });
  assert.equal(parseChangeBody({ email: 'a@b.co', role: 'events', action: 'REVOKE' }), null);
});

// ─── POST /api/roles/change: the write sequence ─────────────────────────────

test('a grant: audit attempted → claims MERGED → read back → audit applied → read back; no token revoke', async () => {
  const w = world();
  const res = await change(w, 'owner', { email: 'admin@example.com', role: 'finance', action: 'grant' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(
    w.ops.filter((op) => op !== 'listAllUsers' && op !== 'getUserByEmail'),
    ['addAudit:attempted', 'setClaims', 'getUser', 'markAuditApplied', 'readAuditOutcome'],
  );
  assert.ok(w.ops.indexOf('getUserByEmail') < w.ops.indexOf('addAudit:attempted'));
  assert.deepEqual(w.users.get('uid-admin')!.claims, { admin: true, legacy: 'kept', finance: true }, 'merged: every other claim kept');

  const [entry] = [...w.audit.values()];
  assert.equal(entry!.outcome, 'applied');
  assert.equal(entry!.via, 'screen');
  assert.equal(entry!.actor, 'owner@example.com');
  assert.equal(entry!.actorUid, 'uid-owner');
  assert.equal(entry!.targetUid, 'uid-admin');
  assert.equal(entry!.targetEmail, 'admin@example.com');
  assert.deepEqual([entry!.action, entry!.role], ['grant', 'finance']);
  assert.deepEqual(entry!.claimsBefore, { admin: true, legacy: 'kept' });
  assert.deepEqual(entry!.claimsAfter, { admin: true, legacy: 'kept', finance: true });

  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(body, {
    uid: 'uid-admin',
    email: 'admin@example.com',
    roles: { owner: false, admin: true, finance: true, rescuer: false, events: false },
    labels: ['Coordinación', 'Tesorería'],
    auditId: 'a1',
  });
});

test('a revoke DELETES the key and ends the sessions: revokeRefreshTokens after the read-back, before applied', async () => {
  const w = world();
  const res = await change(w, 'owner', { email: 'res@example.com', role: 'rescuer', action: 'revoke' });
  assert.equal(res.status, 200);
  assert.deepEqual(
    w.ops.filter((op) => op !== 'listAllUsers' && op !== 'getUserByEmail'),
    ['addAudit:attempted', 'setClaims', 'getUser', 'revokeRefreshTokens', 'markAuditApplied', 'readAuditOutcome'],
  );
  assert.deepEqual(w.users.get('uid-res')!.claims, { events: true });
  assert.equal(Object.prototype.hasOwnProperty.call(w.users.get('uid-res')!.claims, 'rescuer'), false, 'deleted, never false');
});

test('revokeRefreshTokens is called ONLY on a revoke', async () => {
  for (const [role, action, calls] of [['finance', 'grant', 0], ['events', 'revoke', 1], ['admin', 'grant', 0]] as const) {
    const w = world();
    assert.equal((await change(w, 'su', { email: 'res@example.com', role, action })).status, 200);
    assert.equal(w.ops.filter((op) => op === 'revokeRefreshTokens').length, calls, `${action} ${role}`);
  }
});

test('the audit write fails → 500 audit-failed and the claims are NEVER touched', async () => {
  const w = world();
  const f = await failureOf(await change(w, 'owner', { email: 'plain@example.com', role: 'finance', action: 'grant' }, deps(w, {
    addAudit: async () => { throw new Error('unavailable'); },
  })));
  assert.deepEqual([f.status, f.error], [500, 'audit-failed']);
  assert.equal(w.ops.includes('setClaims'), false);
  assert.equal(w.users.get('uid-plain')!.claims, null);
});

test('failures AFTER the audit write leave the entry "attempted", like the script', async () => {
  const cases: [string, Partial<RoleAdminDeps>, string, string][] = [
    ['claim write throws', { setClaims: async () => { throw new Error('x'); } }, 'write-failed', 'grant'],
    ['read-back throws', { getUser: async () => { throw new Error('x'); } }, 'write-failed', 'grant'],
    ['claim did not change', { setClaims: async () => {} }, 'not-applied', 'grant'],
    ['token revoke throws', { revokeRefreshTokens: async () => { throw new Error('x'); } }, 'tokens-not-revoked', 'revoke'],
  ];
  for (const [name, over, error, action] of cases) {
    const w = world();
    const role = action === 'grant' ? 'finance' : 'rescuer';
    const f = await failureOf(await change(w, 'owner', { email: 'res@example.com', role, action }, deps(w, over)));
    assert.deepEqual([f.status, f.error], [500, error], name);
    const [entry] = [...w.audit.values()];
    assert.equal(entry!.outcome, 'attempted', name);
    assert.equal(w.ops.includes('markAuditApplied'), false, name);
  }
});

test('the change is applied but the audit cannot be marked applied → 500 audit-incomplete', async () => {
  for (const over of [
    { markAuditApplied: async () => { throw new Error('x'); } },
    { readAuditOutcome: async () => 'attempted' },
  ] as Partial<RoleAdminDeps>[]) {
    const w = world();
    const f = await failureOf(await change(w, 'owner', { email: 'plain@example.com', role: 'finance', action: 'grant' }, deps(w, over)));
    assert.deepEqual([f.status, f.error], [500, 'audit-incomplete']);
    assert.equal(w.users.get('uid-plain')!.claims!.finance, true, 'the change itself did happen');
  }
});

test('logs carry no email and no claim', async () => {
  const w = world();
  await change(w, 'owner', { email: 'plain@example.com', role: 'finance', action: 'grant' }, deps(w, {
    setClaims: async () => { throw new Error('secret-claims plain@example.com'); },
  }));
  assert.ok(w.logs.length > 0);
  for (const line of w.logs) {
    assert.equal(line.includes('@'), false, line);
    assert.equal(line.includes('secret'), false, line);
  }
});

test('roleFailure reads only our own header values', () => {
  const ours = new Response('{}', { headers: { [ROLE_FAILURE_HEADER]: 'self' } });
  const theirs = new Response('{}', { headers: { [ROLE_FAILURE_HEADER]: 'made-up' } });
  assert.equal(roleFailure(ours), 'self');
  assert.equal(roleFailure(theirs), null);
  assert.equal(roleFailure(new Response('{}')), null);
});

// ─── the source, read: the guard is first and the order cannot drift ────────

const code = (file: string) =>
  readFileSync(join(process.cwd(), file), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
const HANDLER = code('src/lib/role-admin-handler.ts');

function fn(name: string): string {
  const at = HANDLER.indexOf(`export async function ${name}(`);
  assert.ok(at >= 0, `${name} not found`);
  const next = HANDLER.indexOf('\nexport ', at + 10);
  return HANDLER.slice(at, next < 0 ? undefined : next);
}

test('requireRole( appears once, inside guard(), with ROLE_MANAGERS and the recent sign-in check', () => {
  assert.equal((HANDLER.match(/requireRole\(/g) ?? []).length, 1);
  const guard = HANDLER.slice(HANDLER.indexOf('async function guard('), HANDLER.indexOf('async function readJson('));
  assert.match(guard, /requireRole\(request, deps\.verifyIdToken, ROLE_MANAGERS\)/);
  assert.match(guard, /if \(write && !signedInRecently\(check\.authTimeS, deps\.nowMs\(\)\)\)/);
});

test('both handlers call guard() FIRST; the change is a write, the list is not', () => {
  for (const [name, write] of [['handleRoleStaff', false], ['handleRoleChange', true]] as const) {
    const body = fn(name);
    const first = body.indexOf('await ');
    assert.ok(body.slice(first).startsWith(`await guard(request, deps, { write: ${write} })`), name);
    const touched = body.search(/\brequest\.[A-Za-z]/);
    assert.ok(touched < 0 || touched > first, `${name} touches the request before guard()`);
  }
});

test('handleRoleChange: decide → audit attempted → set claims → read back → revoke tokens → audit applied', () => {
  const body = fn('handleRoleChange');
  const at = (needle: string) => {
    const i = body.indexOf(needle);
    assert.ok(i >= 0, `handleRoleChange never mentions ${needle}`);
    return i;
  };
  const order = [
    'decideRoleChange(',
    'deps.addAudit(',
    'deps.setClaims(',
    'deps.getUser(',
    'deps.revokeRefreshTokens(',
    'deps.markAuditApplied(',
    'deps.readAuditOutcome(',
  ].map(at);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'the write sequence is out of order');
  assert.match(body, /if \(action === 'revoke'\) \{\s*try \{\s*await deps\.revokeRefreshTokens\(target\.uid\);/);
  assert.match(body, /deps\.setClaims\(target\.uid, after\)/, 'claims are only ever nextClaims()');
  assert.match(body, /const after = nextClaims\(before, role, action\);/);
});

test('staffView skips every account holding su before anything else is computed', () => {
  const view = HANDLER.slice(HANDLER.indexOf('export function staffView('), HANDLER.indexOf('export function parseChangeBody('));
  assert.match(view, /if \(roles\.su\) continue;/);
  assert.ok(view.indexOf('if (roles.su) continue;') < view.indexOf('staff.push('));
});
