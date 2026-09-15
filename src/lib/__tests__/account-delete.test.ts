import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCOUNT_FAILURE_HEADER,
  accountDeleteFailure,
  handleAccountDelete,
  type AccountDeleteDeps,
} from '../account-delete';
import type { VerifiedIdToken } from '../require-admin';

const NOW_MS = Date.UTC(2026, 8, 15, 12, 0, 0);
const NOW_S = NOW_MS / 1000;

function request(authorization: string | null = 'Bearer tok', body?: unknown): Request {
  const headers = new Headers();
  if (authorization !== null) headers.set('authorization', authorization);
  return new Request('http://localhost/api/account/delete', {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function deps(token: VerifiedIdToken | Error, fail: Partial<Record<'avatars' | 'profile' | 'auth', Error>> = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const d: AccountDeleteDeps = {
    verifyIdToken: async (t, checkRevoked) => {
      calls.push(`verify:${t}:${checkRevoked}`);
      if (token instanceof Error) throw token;
      return token;
    },
    deleteAvatars: async (uid) => {
      calls.push(`avatars:${uid}`);
      if (fail.avatars) throw fail.avatars;
    },
    deleteProfile: async (uid) => {
      calls.push(`profile:${uid}`);
      if (fail.profile) throw fail.profile;
    },
    deleteAuthUser: async (uid) => {
      calls.push(`auth:${uid}`);
      if (fail.auth) throw fail.auth;
    },
    nowMs: () => NOW_MS,
    log: (message) => logs.push(message),
  };
  return { d, calls, logs };
}

const deletes = (calls: string[]) => calls.filter((c) => !c.startsWith('verify:'));

test('no token is 401 and deletes nothing', async () => {
  const { d, calls } = deps({ uid: 'u1', auth_time: NOW_S });
  const res = await handleAccountDelete(request(null), d);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get(ACCOUNT_FAILURE_HEADER), 'unauthenticated');
  assert.deepEqual(calls, []);
});

test('a token that fails verification is 401 and deletes nothing', async () => {
  const { d, calls } = deps(new Error('revoked'));
  const res = await handleAccountDelete(request(), d);
  assert.equal(res.status, 401);
  assert.deepEqual(deletes(calls), []);
});

test('the token is verified with checkRevoked', async () => {
  const { d, calls } = deps({ uid: 'u1', auth_time: NOW_S });
  await handleAccountDelete(request('Bearer abc'), d);
  assert.equal(calls[0], 'verify:abc:true');
});

test('an admin account is refused, so the shelter cannot lose its last admin from a phone', async () => {
  const { d, calls } = deps({ uid: 'admin1', admin: true, auth_time: NOW_S });
  const res = await handleAccountDelete(request(), d);
  assert.equal(res.status, 403);
  assert.equal(res.headers.get(ACCOUNT_FAILURE_HEADER), 'admin-account');
  assert.deepEqual(deletes(calls), []);
});

test('a sign-in older than five minutes is refused; exactly five minutes passes', async () => {
  const stale = deps({ uid: 'u1', auth_time: NOW_S - 301 });
  const res = await handleAccountDelete(request(), stale.d);
  assert.equal(res.status, 403);
  assert.equal(res.headers.get(ACCOUNT_FAILURE_HEADER), 'requires-recent-login');
  assert.deepEqual(deletes(stale.calls), []);

  const edge = deps({ uid: 'u1', auth_time: NOW_S - 300 });
  assert.equal((await handleAccountDelete(request(), edge.d)).status, 200);
});

test('a token with no auth_time is treated as stale', async () => {
  const { d, calls } = deps({ uid: 'u1' });
  const res = await handleAccountDelete(request(), d);
  assert.equal(res.headers.get(ACCOUNT_FAILURE_HEADER), 'requires-recent-login');
  assert.deepEqual(deletes(calls), []);
});

test('a slightly future auth_time (clock skew) passes', async () => {
  const { d } = deps({ uid: 'u1', auth_time: NOW_S + 3 });
  assert.equal((await handleAccountDelete(request(), d)).status, 200);
});

test('photos, then the profile, then the Auth user — and only the TOKEN’s uid', async () => {
  const { d, calls } = deps({ uid: 'me', auth_time: NOW_S });
  const res = await handleAccountDelete(request('Bearer t', { uid: 'someone-else' }), d);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deleted: true });
  assert.deepEqual(deletes(calls), ['avatars:me', 'profile:me', 'auth:me']);
});

test('a failed profile delete stops before the Auth user, so the account can still sign in', async () => {
  const { d, calls, logs } = deps({ uid: 'me', auth_time: NOW_S }, { profile: new Error('boom') });
  const res = await handleAccountDelete(request(), d);
  assert.equal(res.status, 500);
  assert.equal(res.headers.get(ACCOUNT_FAILURE_HEADER), 'delete-failed');
  assert.deepEqual(deletes(calls), ['avatars:me', 'profile:me']);
  assert.equal(logs.length, 1);
});

test('a failed photo delete stops before anything else', async () => {
  const { d, calls } = deps({ uid: 'me', auth_time: NOW_S }, { avatars: new Error('boom') });
  assert.equal((await handleAccountDelete(request(), d)).status, 500);
  assert.deepEqual(deletes(calls), ['avatars:me']);
});

test('the browser reads our failures by header, and anything unstamped as unexpected', () => {
  const h = (value?: string) => new Headers(value ? { [ACCOUNT_FAILURE_HEADER]: value } : {});
  assert.equal(accountDeleteFailure({ ok: true, headers: h() }), null);
  assert.equal(accountDeleteFailure({ ok: false, headers: h('requires-recent-login') }), 'requires-recent-login');
  assert.equal(accountDeleteFailure({ ok: false, headers: h() }), 'unexpected', "Hosting's own 503");
  assert.equal(accountDeleteFailure({ ok: false, headers: h('made-up') }), 'unexpected');
});
