/**
 * POST /api/adoption-applications/{id}/erase-identity — an admin erasing an
 * applicant's carnet photo, address and personal details, with a reason.
 * Owner decision, 2026-10-17: nothing is erased automatically.
 *
 * Run with:  node --test --import tsx src/lib/__tests__/identity-erase-handler.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ERASE_REASONS,
  IDENTITY_ERASE_FAILURE_HEADER,
  handleIdentityErase,
  identityEraseFailure,
  identityErasePath,
  reasonFitsStatus,
  type EraseAdoptionSnapshot,
  type EraseApplicationSnapshot,
  type ErasurePlan,
  type IdentityEraseDeps,
} from '../identity-erase-handler';
import type { VerifiedIdToken } from '../require-admin';

const ID = 'pet1__uidAna';
const ADMIN: VerifiedIdToken = { uid: 'admin1', email: 'admin@wawitas.org', admin: true };

function app(status: string, over: Partial<EraseApplicationSnapshot> = {}): EraseApplicationSnapshot {
  return { petId: 'pet1', applicantUid: 'uidAna', status, identityErasedAt: null, ...over };
}

function request(body: unknown, authorization: string | null = 'Bearer tok'): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (authorization !== null) headers.set('authorization', authorization);
  return new Request(`http://localhost${identityErasePath(ID)}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

interface Options {
  token?: VerifiedIdToken;
  application?: EraseApplicationSnapshot | null | Error;
  adoption?: EraseAdoptionSnapshot | null;
  commitFails?: boolean;
  sweepFails?: boolean;
}

function deps(options: Options = {}) {
  const calls: string[] = [];
  const plans: ErasurePlan[] = [];
  const d: IdentityEraseDeps = {
    verifyIdToken: async () => options.token ?? ADMIN,
    readApplication: async () => {
      calls.push('read');
      const a = options.application === undefined ? app('approved') : options.application;
      if (a instanceof Error) throw a;
      return a;
    },
    readAdoption: async () => {
      calls.push('adoption');
      return options.adoption ?? null;
    },
    commitErasure: async (_id, plan) => {
      calls.push('commit');
      plans.push(plan);
      if (options.commitFails) throw new Error('aborted');
    },
    deleteIdPhotos: async () => {
      calls.push('sweep');
      if (options.sweepFails) throw new Error('unavailable');
    },
    log: () => {},
  };
  return { d, calls, plans };
}

const why = (res: Response) => res.headers.get(IDENTITY_ERASE_FAILURE_HEADER);
const writes = (calls: string[]) => calls.filter((c) => c === 'commit' || c === 'sweep');

test('only an admin may erase: no token 401, a signed-in non-admin 403, nothing read', async () => {
  const anon = deps();
  const r1 = await handleIdentityErase(request({ reason: 'returned' }, null), { applicationId: ID }, anon.d);
  assert.equal(r1.status, 401);
  assert.deepEqual(anon.calls, []);
  const user = deps({ token: { uid: 'uidAna' } });
  const r2 = await handleIdentityErase(request({ reason: 'returned' }), { applicationId: ID }, user.d);
  assert.equal(r2.status, 403);
  assert.deepEqual(user.calls, []);
});

test('the reason must be one of the three, from a small JSON body', async () => {
  for (const body of [{ reason: 'cleanup' }, {}, 'not json', JSON.stringify({ reason: 'returned', pad: 'x'.repeat(300) })]) {
    const { d, calls } = deps();
    const res = await handleIdentityErase(request(body), { applicationId: ID }, d);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 40));
    assert.equal(why(res), 'bad-reason');
    assert.deepEqual(writes(calls), []);
  }
  assert.deepEqual([...ERASE_REASONS], ['returned', 'died', 'not-adopted']);
});

test('a reason must fit the outcome; an OPEN application is never erased', () => {
  assert.equal(reasonFitsStatus('returned', 'approved'), true);
  assert.equal(reasonFitsStatus('died', 'approved'), true);
  assert.equal(reasonFitsStatus('not-adopted', 'rejected'), true);
  assert.equal(reasonFitsStatus('not-adopted', 'withdrawn'), true);
  for (const open of ['submitted', 'reviewing', 'interview']) {
    for (const reason of ERASE_REASONS) assert.equal(reasonFitsStatus(reason, open), false, `${reason} on ${open}`);
  }
  assert.equal(reasonFitsStatus('not-adopted', 'approved'), false, 'an adopter is never "not adopted"');
  assert.equal(reasonFitsStatus('returned', 'rejected'), false);
});

test('a mismatched reason is 409 and erases nothing', async () => {
  const { d, calls } = deps({ application: app('interview') });
  const res = await handleIdentityErase(request({ reason: 'not-adopted' }), { applicationId: ID }, d);
  assert.equal(res.status, 409);
  assert.equal(why(res), 'reason-mismatch');
  assert.deepEqual(writes(calls), []);
});

test('"returned" is refused while the adoption still names this family — register the return first', async () => {
  const { d, calls } = deps({ adoption: { ownerUid: 'uidAna', applicationId: ID } });
  const res = await handleIdentityErase(request({ reason: 'returned' }), { applicationId: ID }, d);
  assert.equal(res.status, 409);
  assert.equal(why(res), 'still-in-custody');
  assert.deepEqual(writes(calls), []);
});

test('"returned" after the re-admission: marked first, the photo swept after', async () => {
  const { d, calls, plans } = deps({ adoption: null });
  const res = await handleIdentityErase(request({ reason: 'returned' }), { applicationId: ID }, d);
  assert.equal(res.status, 200);
  assert.deepEqual(writes(calls), ['commit', 'sweep'], 'mark before sweep, so an upload in flight cannot leave a photo');
  assert.deepEqual(plans, [{ reason: 'returned', erasedBy: 'admin@wawitas.org', endAdoptionOfPetId: null }]);
});

test('"died" (natural causes) ends the adoption that names this family, so they can later delete their account', async () => {
  const { d, plans } = deps({ adoption: { ownerUid: 'uidAna', applicationId: ID } });
  const res = await handleIdentityErase(request({ reason: 'died' }), { applicationId: ID }, d);
  assert.equal(res.status, 200);
  assert.equal(plans[0]!.endAdoptionOfPetId, 'pet1');
  // Another family's adoption of the same animal is never touched.
  const other = deps({ adoption: { ownerUid: 'uidBeto', applicationId: 'pet1__uidBeto' } });
  await handleIdentityErase(request({ reason: 'died' }), { applicationId: ID }, other.d);
  assert.equal(other.plans[0]!.endAdoptionOfPetId, null);
});

test('"not-adopted" never reads the adoption', async () => {
  const { d, calls } = deps({ application: app('rejected') });
  const res = await handleIdentityErase(request({ reason: 'not-adopted' }), { applicationId: ID }, d);
  assert.equal(res.status, 200);
  assert.ok(!calls.includes('adoption'));
});

test('already erased: only the photo sweep runs again, so a failed sweep is finished by pressing again', async () => {
  const { d, calls } = deps({ application: app('approved', { identityErasedAt: { seconds: 1 } }) });
  const res = await handleIdentityErase(request({ reason: 'returned' }), { applicationId: ID }, d);
  assert.equal(res.status, 200);
  assert.deepEqual(writes(calls), ['sweep']);
});

test('a failed mark sweeps nothing; a failed sweep after the mark is 500 and retryable', async () => {
  const commit = deps({ commitFails: true });
  const r1 = await handleIdentityErase(request({ reason: 'returned' }), { applicationId: ID }, commit.d);
  assert.equal(r1.status, 500);
  assert.equal(why(r1), 'erase-failed');
  assert.deepEqual(writes(commit.calls), ['commit']);
  const sweep = deps({ sweepFails: true });
  const r2 = await handleIdentityErase(request({ reason: 'returned' }), { applicationId: ID }, sweep.d);
  assert.equal(r2.status, 500);
  assert.equal(why(r2), 'erase-failed');
});

test('a malformed id or a missing application is 404; a failed read 500', async () => {
  const r1 = await handleIdentityErase(request({ reason: 'returned' }), { applicationId: 'nope' }, deps().d);
  assert.equal(why(r1), 'not-found');
  const r2 = await handleIdentityErase(request({ reason: 'returned' }), { applicationId: ID }, deps({ application: null }).d);
  assert.equal(why(r2), 'not-found');
  const r3 = await handleIdentityErase(
    request({ reason: 'returned' }),
    { applicationId: ID },
    deps({ application: new Error('x') }).d,
  );
  assert.equal(why(r3), 'application-read-failed');
});

test("the admin screen reads the handler's failures, and an edge error as unexpected", () => {
  const response = (status: number, header: string | null) =>
    new Response(null, { status, headers: header ? { [IDENTITY_ERASE_FAILURE_HEADER]: header } : {} });
  assert.equal(identityEraseFailure(response(200, null)), null);
  assert.equal(identityEraseFailure(response(409, 'still-in-custody')), 'still-in-custody');
  assert.equal(identityEraseFailure(response(504, null)), 'unexpected');
});
