/**
 * POST /api/adoption-applications/{id}/acceptance — the consent's audit trail
 * (the contract's first additional clause): when, from which IP, which account.
 *
 * Run with:  node --test --import tsx src/lib/__tests__/acceptance-handler.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCEPTANCE_FAILURE_HEADER,
  FORWARDED_FOR_MAX_CHARS,
  USER_AGENT_MAX_CHARS,
  acceptanceFailure,
  clientIpFrom,
  handleAcceptance,
  looksLikeIp,
  type AcceptanceApplicationSnapshot,
  type AcceptanceDeps,
  type AcceptanceReceipt,
} from '../acceptance-handler';
import { acceptancePath } from '../acceptance-protocol';
import type { VerifiedIdToken } from '../require-admin';

const ID = 'pet1__uidAna';
const TERMS = { seconds: 1_760_000_000, nanoseconds: 0 };

const APPLICATION: AcceptanceApplicationSnapshot = {
  applicantUid: 'uidAna',
  status: 'submitted',
  identityErasedAt: null,
  contractVersion: '2026-10-17',
  contractSha256: 'abc123',
  termsAcceptedAt: TERMS,
};

function request(headers: Record<string, string> = {}, authorization: string | null = 'Bearer tok'): Request {
  const h = new Headers(headers);
  if (authorization !== null) h.set('authorization', authorization);
  return new Request(`http://localhost${acceptancePath(ID)}`, { method: 'POST', headers: h });
}

interface Options {
  token?: VerifiedIdToken | Error;
  enabled?: boolean;
  application?: AcceptanceApplicationSnapshot | null | Error;
  commit?: 'created' | 'exists' | Error;
}

function deps(options: Options = {}) {
  const calls: string[] = [];
  const receipts: AcceptanceReceipt[] = [];
  const logs: string[] = [];
  const token = options.token ?? { uid: 'uidAna', email: 'ana@example.com' };
  const d: AcceptanceDeps = {
    verifyIdToken: async (_t, checkRevoked) => {
      calls.push(`verify:${checkRevoked}`);
      if (token instanceof Error) throw token;
      return token;
    },
    applicationsEnabled: options.enabled ?? true,
    readApplication: async (id) => {
      calls.push(`read:${id}`);
      const a = options.application === undefined ? APPLICATION : options.application;
      if (a instanceof Error) throw a;
      return a;
    },
    commitAcceptance: async (id, receipt) => {
      calls.push(`commit:${id}`);
      receipts.push(receipt);
      const c = options.commit ?? 'created';
      if (c instanceof Error) throw c;
      return c;
    },
    log: (message) => logs.push(message),
  };
  return { d, calls, receipts, logs };
}

const reason = (res: Response) => res.headers.get(ACCEPTANCE_FAILURE_HEADER);

test('no token is 401, and nothing is read or written', async () => {
  const { d, calls } = deps();
  const res = await handleAcceptance(request({}, null), { applicationId: ID }, d);
  assert.equal(res.status, 401);
  assert.equal(reason(res), 'unauthenticated');
  assert.deepEqual(calls, []);
});

test('switched off, a signed-in caller gets 404 and nothing is read', async () => {
  const { d, calls } = deps({ enabled: false });
  const res = await handleAcceptance(request(), { applicationId: ID }, d);
  assert.equal(res.status, 404);
  assert.equal(reason(res), 'disabled');
  assert.deepEqual(calls, ['verify:true']);
});

test("someone else's application id is 403 before anything is read", async () => {
  const { d, calls } = deps({ token: { uid: 'uidBeto' } });
  const res = await handleAcceptance(request(), { applicationId: ID }, d);
  assert.equal(res.status, 403);
  assert.equal(reason(res), 'not-yours');
  assert.ok(!calls.some((c) => c.startsWith('read:')));
  for (const bad of ['nope', 'a__b__c', '']) {
    const r = await handleAcceptance(request(), { applicationId: bad }, deps().d);
    assert.equal(reason(r), 'not-yours', bad);
  }
});

test('missing, not owned, erased or closed applications are refused, and nothing is written', async () => {
  const cases: [AcceptanceApplicationSnapshot | null | Error, number, string][] = [
    [null, 404, 'not-found'],
    [{ ...APPLICATION, applicantUid: 'uidBeto' }, 403, 'not-yours'],
    [{ ...APPLICATION, identityErasedAt: TERMS }, 409, 'erased'],
    [{ ...APPLICATION, status: 'withdrawn' }, 409, 'not-open'],
    [{ ...APPLICATION, status: 'approved' }, 409, 'not-open'],
    [{ ...APPLICATION, contractSha256: undefined }, 409, 'not-open'],
    [new Error('unavailable'), 500, 'application-read-failed'],
  ];
  for (const [application, status, why] of cases) {
    const { d, calls } = deps({ application });
    const res = await handleAcceptance(request(), { applicationId: ID }, d);
    assert.equal(res.status, status, why);
    assert.equal(reason(res), why);
    assert.ok(!calls.some((c) => c.startsWith('commit:')), `${why} wrote a record`);
  }
});

test('recorded once: the time is the server’s, the account the token’s, the IP evidence kept raw', async () => {
  const { d, receipts } = deps();
  const res = await handleAcceptance(
    request({
      'x-forwarded-for': '1.2.3.4, 181.115.10.20, 35.191.0.1',
      'fastly-client-ip': '181.115.10.20',
      'user-agent': 'Mozilla/5.0 (Linux; Android 14)',
    }),
    { applicationId: ID },
    d,
  );
  assert.equal(res.status, 201);
  assert.equal(reason(res), null);
  assert.deepEqual(receipts, [
    {
      applicantUid: 'uidAna',
      applicantEmail: 'ana@example.com',
      contractVersion: '2026-10-17',
      contractSha256: 'abc123',
      termsAcceptedAt: TERMS,
      ip: '181.115.10.20',
      forwardedFor: '1.2.3.4, 181.115.10.20, 35.191.0.1',
      fastlyClientIp: '181.115.10.20',
      userAgent: 'Mozilla/5.0 (Linux; Android 14)',
    },
  ]);
});

test('a second call changes nothing and still answers success (200)', async () => {
  const { d } = deps({ commit: 'exists' });
  const res = await handleAcceptance(request(), { applicationId: ID }, d);
  assert.equal(res.status, 200);
  assert.equal(acceptanceFailure(res), null);
});

test('a failed write is 500 record-failed, and the log names no IP', async () => {
  const { d, logs } = deps({ commit: new Error('aborted') });
  const res = await handleAcceptance(request({ 'x-forwarded-for': '9.9.9.9' }), { applicationId: ID }, d);
  assert.equal(res.status, 500);
  assert.equal(reason(res), 'record-failed');
  assert.ok(logs.every((l) => !l.includes('9.9.9.9')));
});

test('what is kept from the headers is capped, and missing headers are null', async () => {
  const { d, receipts } = deps();
  await handleAcceptance(
    request({ 'x-forwarded-for': `${'1.1.1.1, '.repeat(100)}2.2.2.2`, 'user-agent': 'x'.repeat(1000) }),
    { applicationId: ID },
    d,
  );
  assert.equal(receipts[0]!.forwardedFor!.length, FORWARDED_FOR_MAX_CHARS);
  assert.equal(receipts[0]!.userAgent!.length, USER_AGENT_MAX_CHARS);
  assert.equal(receipts[0]!.fastlyClientIp, null);
  const bare = deps();
  await handleAcceptance(request(), { applicationId: ID }, bare.d);
  assert.deepEqual(
    [bare.receipts[0]!.ip, bare.receipts[0]!.forwardedFor, bare.receipts[0]!.fastlyClientIp, bare.receipts[0]!.userAgent],
    [null, null, null, null],
  );
});

test('the best reading of the IP: Fastly-Client-IP when it is one, else the first address in the chain', () => {
  assert.equal(clientIpFrom('1.2.3.4, 5.6.7.8', '9.9.9.9'), '9.9.9.9');
  assert.equal(clientIpFrom('garbage, 5.6.7.8', 'not-an-ip'), '5.6.7.8');
  assert.equal(clientIpFrom('2800:cd0:1::5, 5.6.7.8', null), '2800:cd0:1::5');
  assert.equal(clientIpFrom(null, null), null);
  assert.equal(clientIpFrom('unknown', ''), null);
  assert.equal(looksLikeIp('256.1.1.1'), false);
  assert.equal(looksLikeIp('10.0.0.1'), true);
  assert.equal(looksLikeIp('<script>'), false);
});

test("the browser reads the handler's own failures, and an edge error as unexpected", () => {
  const response = (status: number, header: string | null) =>
    new Response(null, { status, headers: header ? { [ACCEPTANCE_FAILURE_HEADER]: header } : {} });
  assert.equal(acceptanceFailure(response(201, null)), null);
  assert.equal(acceptanceFailure(response(409, 'erased')), 'erased');
  assert.equal(acceptanceFailure(response(503, null)), 'unexpected');
  assert.equal(acceptanceFailure(response(500, 'something-else')), 'unexpected');
  assert.equal(acceptancePath('a b'), '/api/adoption-applications/a%20b/acceptance');
});
