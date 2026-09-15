import test from 'node:test';
import assert from 'node:assert/strict';

import { requireAdmin, requireUser, type VerifiedIdToken } from '../require-admin';

function request(authorization?: string): Request {
  const headers = new Headers();
  if (authorization !== undefined) headers.set('authorization', authorization);
  return new Request('http://localhost/api/account/delete', { method: 'POST', headers });
}

function verifier(result: VerifiedIdToken | Error) {
  const calls: [string, boolean][] = [];
  const verify = async (token: string, checkRevoked: boolean): Promise<VerifiedIdToken> => {
    calls.push([token, checkRevoked]);
    if (result instanceof Error) throw result;
    return result;
  };
  return { verify, calls };
}

const UNAUTHENTICATED = { ok: false, error: 'unauthenticated', status: 401 };

test('requireUser: no token is 401 without calling the verifier', async () => {
  const { verify, calls } = verifier({ uid: 'u' });
  assert.deepEqual(await requireUser(request(), verify), UNAUTHENTICATED);
  assert.deepEqual(await requireUser(request('Basic abc'), verify), UNAUTHENTICATED);
  assert.equal(calls.length, 0);
});

test('requireUser: a token that fails verification is 401', async () => {
  const { verify } = verifier(new Error('revoked'));
  assert.deepEqual(await requireUser(request('Bearer t'), verify), UNAUTHENTICATED);
});

test('requireUser: verifies with checkRevoked and passes any signed-in account', async () => {
  const { verify, calls } = verifier({ uid: 'u1', email: '  a@b.co ', auth_time: 1_700_000_000 });
  assert.deepEqual(await requireUser(request('Bearer tok'), verify), {
    ok: true,
    uid: 'u1',
    email: 'a@b.co',
    admin: false,
    authTimeS: 1_700_000_000,
  });
  assert.deepEqual(calls, [['tok', true]]);
});

test('requireUser: admin is exactly `true`, never truthiness', async () => {
  for (const [claim, expected] of [
    [true, true],
    ['true', false],
    [1, false],
    [undefined, false],
  ] as const) {
    const { verify } = verifier({ uid: 'u', admin: claim });
    const result = await requireUser(request('Bearer t'), verify);
    assert.equal(result.ok && result.admin, expected, `admin=${String(claim)}`);
  }
});

test('requireUser: a missing or non-finite auth_time is null', async () => {
  for (const auth_time of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    const { verify } = verifier({ uid: 'u', auth_time });
    const result = await requireUser(request('Bearer t'), verify);
    assert.equal(result.ok && result.authTimeS, null);
  }
});

test('requireAdmin still refuses an ordinary account after the shared refactor', async () => {
  const { verify } = verifier({ uid: 'u', auth_time: 1 });
  assert.deepEqual(await requireAdmin(request('Bearer t'), verify), { ok: false, error: 'forbidden', status: 403 });
});
