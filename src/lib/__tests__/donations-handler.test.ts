/**
 * The donation routes' handlers, against an in-memory Firestore and bucket.
 *
 * The fake transaction stages every write and applies them only when the
 * callback returns: a throw — including a create-only write that meets an
 * existing document — applies NOTHING, which is what makes "confirm writes
 * current and history atomically" a claim these tests can check.
 *
 * ⚠️ Fixture data only: 'Banco de Prueba', '0000000000'.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { VerifiedIdToken } from '../require-admin';
import {
  DONATION_FAILURE_HEADER,
  DONATION_QR_MAX_BYTES,
  PRIVATE_QR_CACHE_CONTROL,
  PUBLIC_QR_CACHE_CONTROL,
  handleDonationConfirm,
  handleDonationPendingQr,
  handleDonationPropose,
  handleDonationQrUpload,
  handleDonationReject,
  handlePublicDonationQr,
  magicMatches,
  signedInRecently,
  type DonationTx,
  type DonationsDeps,
} from '../donations-handler';
import { qrObjectPathFor } from '../donations';

const TZ = 'America/La_Paz';
const NOW = Date.UTC(2026, 9, 24, 16, 0, 0);
const NOW_S = NOW / 1000;
const SERVER_TIME = '<serverTimestamp>';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);

// ─── personas: one token each ────────────────────────────────────────────────

const TOKENS: Record<string, VerifiedIdToken> = {
  fin: { uid: 'uid-fin', email: 'fin@example.com', finance: true, auth_time: NOW_S - 60 },
  fin2: { uid: 'uid-fin2', email: 'fin2@example.com', finance: true, auth_time: NOW_S - 60 },
  su: { uid: 'uid-su', email: 'su@example.com', su: true, auth_time: NOW_S - 60 },
  suFin: { uid: 'uid-sufin', su: true, finance: true, auth_time: NOW_S - 60 },
  finAdmin: { uid: 'uid-finadmin', finance: true, admin: true, auth_time: NOW_S - 60 },
  owner: { uid: 'uid-owner', owner: true, auth_time: NOW_S - 60 },
  admin: { uid: 'uid-admin', admin: true, auth_time: NOW_S - 60 },
  rescuer: { uid: 'uid-rescuer', rescuer: true, auth_time: NOW_S - 60 },
  events: { uid: 'uid-events', events: true, auth_time: NOW_S - 60 },
  user: { uid: 'uid-user', auth_time: NOW_S - 60 },
  finOld: { uid: 'uid-fin', finance: true, auth_time: NOW_S - 301 },
  finEdge: { uid: 'uid-fin', finance: true, auth_time: NOW_S - 300 },
  finNoAuthTime: { uid: 'uid-fin', finance: true },
  suOld: { uid: 'uid-su', su: true, auth_time: NOW_S - 3600 },
};

// ─── the fake world ──────────────────────────────────────────────────────────

interface World {
  current: Record<string, unknown> | null;
  pending: Map<string, Record<string, unknown>>;
  history: Map<string, Record<string, unknown>>;
  objects: Map<string, Uint8Array>;
  logs: string[];
  transactions: number;
}

function world(): World {
  return { current: null, pending: new Map(), history: new Map(), objects: new Map(), logs: [], transactions: 0 };
}

function deps(w: World, over: Partial<DonationsDeps> = {}): DonationsDeps {
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
    newPendingId: () => `pnew${++n}`,
    serverTimestamp: () => SERVER_TIME,
    runTransaction: async (fn) => {
      w.transactions++;
      const staged: (() => void)[] = [];
      const tx: DonationTx = {
        getCurrent: async () => (w.current ? structuredClone(w.current) : null),
        getPending: async (id) => (w.pending.has(id) ? structuredClone(w.pending.get(id)!) : null),
        listOpenPending: async () =>
          [...w.pending].filter(([, d]) => d.status === 'pending').map(([id, d]) => ({ id, data: structuredClone(d) })),
        setCurrent: (data) => staged.push(() => (w.current = { ...data })),
        createPending: (id, data) => {
          if (w.pending.has(id)) throw new Error('ALREADY_EXISTS');
          staged.push(() => w.pending.set(id, { ...data }));
        },
        updatePending: (id, patch) => {
          if (!w.pending.has(id)) throw new Error('NOT_FOUND');
          staged.push(() => w.pending.set(id, { ...w.pending.get(id)!, ...patch }));
        },
        createHistory: (id, data) => {
          if (w.history.has(id)) throw new Error('ALREADY_EXISTS');
          staged.push(() => w.history.set(id, { ...data }));
        },
      };
      const result = await fn(tx);
      for (const apply of staged) apply();
      return result;
    },
    readCurrent: async () => (w.current ? structuredClone(w.current) : null),
    readPending: async (id) => (w.pending.has(id) ? structuredClone(w.pending.get(id)!) : null),
    saveQr: async (path, png) => {
      if (w.objects.has(path)) return 'exists';
      w.objects.set(path, png);
      return 'saved';
    },
    readQr: async (path) => w.objects.get(path) ?? null,
    deleteQr: async (path) => {
      w.objects.delete(path);
    },
    reencodePng: async (bytes) => {
      if (bytes.length < 4) throw new Error('Input buffer contains unsupported image format');
      return PNG;
    },
    log: (m) => w.logs.push(m),
    timeZone: TZ,
    ...over,
  };
}

const bankMethod = (over: Record<string, unknown> = {}) => ({
  kind: 'bank',
  bankName: 'Banco de Prueba',
  accountHolder: 'Titular de Prueba',
  accountNumber: '0000-000000',
  accountNumberConfirm: '0000000000',
  accountType: 'caja de ahorro',
  currency: 'BOB',
  note: '',
  ...over,
});
const proposeBody = (over: Record<string, unknown> = {}) => ({
  methods: [bankMethod()],
  active: true,
  qrExpiresAt: null,
  qrAction: 'keep',
  ...over,
});

function post(path: string, token: string | null, body: unknown, contentType = 'application/json'): Request {
  const headers = new Headers({ 'content-type': contentType });
  if (token) headers.set('authorization', `Bearer ${token}`);
  const payload = body instanceof Uint8Array ? new Blob([body as BlobPart]) : JSON.stringify(body);
  return new Request(`http://localhost${path}`, { method: 'POST', headers, body: payload });
}
function get(path: string, token: string | null): Request {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  return new Request(`http://localhost${path}`, { method: 'GET', headers });
}

async function failureOf(res: Response): Promise<{ status: number; error: string; header: string | null; body: Record<string, unknown> }> {
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(res.headers.get('cache-control'), 'no-store');
  return { status: res.status, error: body.error as string, header: res.headers.get(DONATION_FAILURE_HEADER), body };
}

/** A proposal stored by `proposer`, status pending. */
function seedPending(w: World, id: string, proposer: string, over: Record<string, unknown> = {}) {
  w.pending.set(id, {
    proposedBy: proposer,
    proposedByEmail: null,
    proposedAt: NOW - 1000,
    status: 'pending',
    proposal: {
      methods: [{ ...bankMethod(), accountNumber: '0000000000', accountNumberConfirm: undefined }].map(({ accountNumberConfirm, ...m }) => m),
      active: true,
      qrExpiresAt: null,
      qrAction: 'keep',
    },
    qrPath: null,
    reason: null,
    decidedBy: null,
    decidedByEmail: null,
    decidedAt: null,
    supersededBy: null,
    ...over,
  });
}

const propose = (w: World, token: string | null, body: unknown = proposeBody()) =>
  handleDonationPropose(post('/api/donations/propose', token, body), deps(w));
const confirm = (w: World, token: string | null, pendingId: string) =>
  handleDonationConfirm(post('/api/donations/confirm', token, { pendingId }), deps(w));
const reject = (w: World, token: string | null, pendingId: string, reason?: unknown) =>
  handleDonationReject(post('/api/donations/reject', token, { pendingId, reason }), deps(w));
const uploadQr = (w: World, token: string | null, pendingId: string, bytes: Uint8Array, type = 'image/png', d?: DonationsDeps) =>
  handleDonationQrUpload(post(`/api/donations/pending/${pendingId}/qr`, token, bytes, type), { pendingId }, d ?? deps(w));

// ─── the guard, on every authenticated handler ───────────────────────────────

const HANDLERS: [string, (w: World, token: string | null) => Promise<Response>, boolean][] = [
  ['propose', (w, t) => propose(w, t), true],
  ['confirm', (w, t) => confirm(w, t, 'p1'), true],
  ['reject', (w, t) => reject(w, t, 'p1'), true],
  ['qr upload', (w, t) => uploadQr(w, t, 'p1', PNG), true],
  ['pending qr', (w, t) => handleDonationPendingQr(get('/api/donations/pending/p1/qr', t), { pendingId: 'p1' }, deps(w)), false],
];

test('no token → 401 unauthenticated, on every authenticated handler, before anything is read or written', async () => {
  for (const [name, call] of HANDLERS) {
    const w = world();
    const f = await failureOf(await call(w, null));
    assert.deepEqual([f.status, f.error, f.header], [401, 'unauthenticated', 'unauthenticated'], name);
    assert.equal(w.transactions, 0, name);
  }
});

test('a revoked or invalid token → 401, on every handler', async () => {
  for (const [name, call] of HANDLERS) {
    for (const token of ['revoked', 'garbage']) {
      const f = await failureOf(await call(world(), token));
      assert.deepEqual([f.status, f.error], [401, 'unauthenticated'], `${name} ${token}`);
    }
  }
});

test('every role but Tesorería and su → 403 forbidden — the owner and coordination included', async () => {
  for (const [name, call] of HANDLERS) {
    for (const token of ['owner', 'admin', 'rescuer', 'events', 'user']) {
      const w = world();
      const f = await failureOf(await call(w, token));
      assert.deepEqual([f.status, f.error], [403, 'forbidden'], `${name} as ${token}`);
      assert.equal(w.transactions, 0);
    }
  }
});

test('writes need a sign-in under 5 minutes → else 403 requires-recent-login; reading a pending QR does not', async () => {
  for (const [name, call, write] of HANDLERS) {
    for (const token of ['finOld', 'finNoAuthTime', 'suOld']) {
      const w = world();
      seedPending(w, 'p1', 'someone-else', { qrPath: qrObjectPathFor('p1') });
      w.objects.set(qrObjectPathFor('p1'), PNG);
      const res = await call(w, token);
      if (write) {
        const f = await failureOf(res);
        assert.deepEqual([f.status, f.error], [403, 'requires-recent-login'], `${name} as ${token}`);
        assert.equal(w.transactions, 0);
      } else {
        assert.equal(res.status, 200, `${name} as ${token}`);
      }
    }
  }
  // Exactly 300 s is still recent.
  assert.equal((await propose(world(), 'finEdge')).status, 201);
});

test('signedInRecently: ≤ 300 s passes, a missing auth_time never does, clock skew into the future passes', () => {
  assert.ok(signedInRecently(NOW_S - 300, NOW));
  assert.equal(signedInRecently(NOW_S - 301, NOW), false);
  assert.equal(signedInRecently(null, NOW), false);
  assert.ok(signedInRecently(NOW_S + 30, NOW));
});

// ─── propose ─────────────────────────────────────────────────────────────────

test('propose: Tesorería and su may; the proposal is stored pending, normalised, with the proposer and no second typing', async () => {
  for (const token of ['fin', 'su', 'suFin', 'finAdmin']) {
    const w = world();
    const res = await propose(w, token);
    assert.equal(res.status, 201, token);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { pendingId: 'pnew1', superseded: [] });
    const stored = w.pending.get('pnew1')!;
    assert.equal(stored.status, 'pending');
    assert.equal(stored.proposedBy, TOKENS[token]!.uid);
    assert.equal(stored.proposedAt, SERVER_TIME);
    const m = (stored.proposal as { methods: Record<string, unknown>[] }).methods[0]!;
    assert.equal(m.accountNumber, '0000000000');
    assert.equal('accountNumberConfirm' in m, false);
    assert.equal(w.current, null, 'a proposal changes nothing public');
  }
});

test('propose: the account number typed twice must match → 400 account-mismatch, nothing written', async () => {
  const w = world();
  const f = await failureOf(await propose(w, 'fin', proposeBody({ methods: [bankMethod({ accountNumberConfirm: '0000000001' })] })));
  assert.deepEqual([f.status, f.error, f.body.field], [400, 'account-mismatch', 'methods[0].accountNumberConfirm']);
  assert.equal(w.pending.size, 0);
  assert.equal(w.transactions, 0);
});

test('propose: any other invalid field → 400 invalid-proposal with the rule and the field', async () => {
  const f = await failureOf(await propose(world(), 'fin', proposeBody({ qrAction: 'upload' })));
  assert.deepEqual([f.status, f.error, f.body.detail, f.body.field], [400, 'invalid-proposal', 'invalid-qr-action', 'qrAction']);
});

test('propose: not JSON → 415; broken JSON → 400; over 32 KB → 413', async () => {
  assert.equal((await failureOf(await propose(world(), 'fin', 'x' as unknown))).status, 400);
  const notJson = await handleDonationPropose(post('/api/donations/propose', 'fin', proposeBody(), 'text/plain'), deps(world()));
  assert.equal((await failureOf(notJson)).error, 'not-json');
  const broken = await handleDonationPropose(
    new Request('http://localhost/x', { method: 'POST', headers: { authorization: 'Bearer fin', 'content-type': 'application/json' }, body: '{"methods":' }),
    deps(world()),
  );
  assert.equal((await failureOf(broken)).error, 'invalid-body');
  const big = await propose(world(), 'fin', proposeBody({ methods: [bankMethod({ note: 'x'.repeat(40_000) })] }));
  assert.equal((await failureOf(big)).error, 'too-large');
});

test('propose: a new proposal SUPERSEDES the open one, in the same transaction', async () => {
  const w = world();
  seedPending(w, 'pold', 'uid-su');
  seedPending(w, 'pdone', 'uid-su', { status: 'rejected' });
  const res = await propose(w, 'fin');
  assert.deepEqual(await res.json(), { pendingId: 'pnew1', superseded: ['pold'] });
  assert.equal(w.transactions, 1);
  assert.equal(w.pending.get('pold')!.status, 'superseded');
  assert.equal(w.pending.get('pold')!.supersededBy, 'pnew1');
  assert.equal(w.pending.get('pold')!.decidedBy, 'uid-fin');
  assert.equal(w.pending.get('pdone')!.status, 'rejected', 'a closed proposal is left alone');
  assert.equal([...w.pending.values()].filter((p) => p.status === 'pending').length, 1);
});

test('propose: a failed transaction answers 500 write-failed and writes nothing', async () => {
  const w = world();
  const res = await handleDonationPropose(
    post('/api/donations/propose', 'fin', proposeBody()),
    deps(w, { runTransaction: async () => { throw Object.assign(new Error('0000000000 secret'), { code: 10 }); } }),
  );
  const f = await failureOf(res);
  assert.deepEqual([f.status, f.error], [500, 'write-failed']);
  assert.equal(w.logs.join('\n').includes('0000000000'), false, 'error text never logged');
});

// ─── confirm ─────────────────────────────────────────────────────────────────

test('confirm: NOBODY confirms their own proposal — su on su’s, Tesorería on Tesorería’s → 403 own-proposal', async () => {
  for (const [proposer, confirmer] of [['uid-su', 'su'], ['uid-fin', 'fin'], ['uid-sufin', 'suFin']] as const) {
    const w = world();
    seedPending(w, 'p1', proposer);
    const f = await failureOf(await confirm(w, confirmer, 'p1'));
    assert.deepEqual([f.status, f.error], [403, 'own-proposal'], `${confirmer} on ${proposer}`);
    assert.equal(w.current, null);
    assert.equal(w.history.size, 0);
    assert.equal(w.pending.get('p1')!.status, 'pending');
  }
});

test('confirm: cross confirmation works BOTH ways — Tesorería confirms su’s, su confirms Tesorería’s', async () => {
  for (const [proposer, confirmer] of [['uid-su', 'fin'], ['uid-fin', 'su'], ['uid-fin', 'fin2']] as const) {
    const w = world();
    seedPending(w, 'p1', proposer);
    const res = await confirm(w, confirmer, 'p1');
    assert.equal(res.status, 200, `${confirmer} on ${proposer}`);
    assert.deepEqual(await res.json(), { version: 1 });
  }
});

test('confirm: ONE transaction writes current (version + 1, no uid), appends history, and marks the proposal confirmed', async () => {
  const w = world();
  w.current = {
    methods: [], version: 4, updatedAt: 1, active: true, qrPath: 'donations/qr/pold.png', qrExpiresAt: '2028-08-25',
  };
  seedPending(w, 'p1', 'uid-su', { proposedByEmail: 'su@example.com' });
  const res = await confirm(w, 'fin', 'p1');
  assert.deepEqual(await res.json(), { version: 5 });
  assert.equal(w.transactions, 1);

  assert.equal(w.current!.version, 5);
  assert.equal(w.current!.updatedAt, SERVER_TIME);
  assert.equal(w.current!.qrPath, 'donations/qr/pold.png', 'keep keeps the confirmed QR');
  assert.equal(w.current!.qrExpiresAt, null, 'the proposal set no expiry');
  assert.deepEqual(Object.keys(w.current!).sort(), ['active', 'methods', 'qrExpiresAt', 'qrPath', 'updatedAt', 'version']);
  assert.equal(JSON.stringify(w.current).includes('uid-'), false, 'the public document carries no uid');

  const h = w.history.get('v000005')!;
  assert.equal(h.kind, 'confirmed');
  assert.equal(h.pendingId, 'p1');
  assert.equal(h.proposedBy, 'uid-su');
  assert.equal(h.decidedBy, 'uid-fin');
  assert.equal(h.decidedAt, SERVER_TIME);
  assert.equal(w.pending.get('p1')!.status, 'confirmed');
  assert.equal(w.pending.get('p1')!.decidedBy, 'uid-fin');
});

test('confirm: if the history write fails, NOTHING is written — current, history and pending all unchanged', async () => {
  const w = world();
  w.current = { methods: [], version: 4, updatedAt: 1, active: true, qrPath: null, qrExpiresAt: null };
  const before = structuredClone(w.current);
  w.history.set('v000005', { kind: 'confirmed', note: 'already here' });
  seedPending(w, 'p1', 'uid-su');
  const f = await failureOf(await confirm(w, 'fin', 'p1'));
  assert.deepEqual([f.status, f.error], [500, 'write-failed']);
  assert.deepEqual(w.current, before);
  assert.equal(w.pending.get('p1')!.status, 'pending');
  assert.deepEqual(w.history.get('v000005'), { kind: 'confirmed', note: 'already here' }, 'history is never overwritten');
});

test('confirm: unknown → 404; already decided → 409; bad id → 400', async () => {
  const w = world();
  assert.deepEqual((await failureOf(await confirm(w, 'fin', 'nope'))).error, 'not-found');
  for (const status of ['confirmed', 'rejected', 'superseded']) {
    seedPending(w, 'p1', 'uid-su', { status });
    assert.equal((await failureOf(await confirm(w, 'fin', 'p1'))).error, 'not-pending', status);
  }
  const bad = await handleDonationConfirm(post('/api/donations/confirm', 'fin', { pendingId: '../x' }), deps(w));
  assert.deepEqual([(await failureOf(bad)).error], ['invalid-body']);
});

test('confirm: a proposal that asked for a new QR is refused until the QR exists → 409 qr-missing', async () => {
  const w = world();
  seedPending(w, 'p1', 'uid-su');
  (w.pending.get('p1')!.proposal as Record<string, unknown>).qrAction = 'replace';
  assert.equal((await failureOf(await confirm(w, 'fin', 'p1'))).error, 'qr-missing');
  w.pending.get('p1')!.qrPath = qrObjectPathFor('p1');
  const res = await confirm(w, 'fin', 'p1');
  assert.equal(res.status, 200);
  assert.equal(w.current!.qrPath, 'donations/qr/p1.png');
});

// ─── reject ──────────────────────────────────────────────────────────────────

test('reject: own proposal → 403 for su and for Tesorería; the other one may, and history records it append-only', async () => {
  for (const [proposer, token] of [['uid-su', 'su'], ['uid-fin', 'fin']] as const) {
    const w = world();
    seedPending(w, 'p1', proposer);
    assert.equal((await failureOf(await reject(w, token, 'p1'))).error, 'own-proposal', token);
    assert.equal(w.history.size, 0);
  }
  for (const [proposer, token] of [['uid-su', 'fin'], ['uid-fin', 'su']] as const) {
    const w = world();
    seedPending(w, 'p1', proposer);
    const res = await reject(w, token, 'p1', '  el titular no coincide ');
    assert.deepEqual(await res.json(), { historyId: 'rejected-p1' });
    assert.equal(w.pending.get('p1')!.status, 'rejected');
    assert.equal(w.pending.get('p1')!.reason, 'el titular no coincide');
    assert.equal(w.history.get('rejected-p1')!.kind, 'rejected');
    assert.equal(w.history.get('rejected-p1')!.decidedBy, TOKENS[token]!.uid);
    assert.equal(w.current, null, 'a rejection changes nothing public');
  }
});

test('reject: a reason over 300 characters → 400 invalid-reason', async () => {
  const w = world();
  seedPending(w, 'p1', 'uid-su');
  assert.equal((await failureOf(await reject(w, 'fin', 'p1', 'x'.repeat(301)))).error, 'invalid-reason');
  assert.equal(w.transactions, 0);
});

// ─── the QR upload ───────────────────────────────────────────────────────────

function seedReplace(w: World, proposer = 'uid-fin') {
  seedPending(w, 'p1', proposer);
  (w.pending.get('p1')!.proposal as Record<string, unknown>).qrAction = 'replace';
}

test('QR upload: the proposer’s JPEG or PNG is re-encoded to PNG, stored at donations/qr/{id}.png, and recorded', async () => {
  for (const [bytes, type] of [[PNG, 'image/png'], [JPEG, 'image/jpeg']] as const) {
    const w = world();
    seedReplace(w);
    const res = await uploadQr(w, 'fin', 'p1', bytes, type);
    assert.equal(res.status, 201, type);
    assert.deepEqual(w.objects.get('donations/qr/p1.png'), PNG, 'the re-encoded bytes are what is stored');
    assert.equal(w.pending.get('p1')!.qrPath, 'donations/qr/p1.png');
  }
});

test('QR upload: only the proposer, only on an open proposal that asked for a new QR, only once', async () => {
  let w = world();
  seedReplace(w, 'uid-su');
  assert.equal((await failureOf(await uploadQr(w, 'fin', 'p1', PNG))).error, 'not-proposer');
  w = world();
  seedPending(w, 'p1', 'uid-fin');
  assert.equal((await failureOf(await uploadQr(w, 'fin', 'p1', PNG))).error, 'qr-not-requested');
  w = world();
  seedReplace(w);
  w.pending.get('p1')!.status = 'confirmed';
  assert.equal((await failureOf(await uploadQr(w, 'fin', 'p1', PNG))).error, 'not-pending');
  w = world();
  seedReplace(w);
  assert.equal((await uploadQr(w, 'fin', 'p1', PNG)).status, 201);
  assert.equal((await failureOf(await uploadQr(w, 'fin', 'p1', PNG))).error, 'qr-already-uploaded');
  assert.equal((await failureOf(await uploadQr(world(), 'fin', 'missing', PNG))).error, 'not-found');
});

test('QR upload: oversize → 413 (declared or read), wrong type → 415, bytes that lie about their type → 415, undecodable → 422', async () => {
  let w = world();
  seedReplace(w);
  const big = new Uint8Array(DONATION_QR_MAX_BYTES + 1);
  big.set(PNG);
  const f = await failureOf(await uploadQr(w, 'fin', 'p1', big));
  assert.deepEqual([f.status, f.error], [413, 'too-large']);
  assert.equal(w.objects.size, 0);

  for (const type of ['image/gif', 'image/webp', 'application/octet-stream', 'image/svg+xml']) {
    w = world();
    seedReplace(w);
    assert.equal((await failureOf(await uploadQr(w, 'fin', 'p1', PNG, type))).status, 415, type);
  }
  w = world();
  seedReplace(w);
  assert.equal((await failureOf(await uploadQr(w, 'fin', 'p1', JPEG, 'image/png'))).error, 'not-image');
  w = world();
  seedReplace(w);
  assert.equal((await failureOf(await uploadQr(w, 'fin', 'p1', new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg'))).error, 'invalid-image');
  w = world();
  seedReplace(w);
  const notPng = deps(w, { reencodePng: async () => JPEG });
  assert.equal((await failureOf(await uploadQr(w, 'fin', 'p1', PNG, 'image/png', notPng))).error, 'invalid-image');
  assert.equal(w.objects.size, 0);
});

test('QR upload: decided while uploading → the transaction refuses and the orphan object is deleted', async () => {
  const w = world();
  seedReplace(w);
  const d = deps(w, {
    saveQr: async (path, png) => {
      w.objects.set(path, png);
      w.pending.get('p1')!.status = 'superseded'; // someone proposed again meanwhile
      return 'saved';
    },
  });
  const f = await failureOf(await uploadQr(w, 'fin', 'p1', PNG, 'image/png', d));
  assert.deepEqual([f.status, f.error], [409, 'not-pending']);
  assert.equal(w.objects.size, 0);
  assert.equal(w.pending.get('p1')!.qrPath, null);
});

// ─── reading QRs ─────────────────────────────────────────────────────────────

test('pending QR: Tesorería and su see it, private and never cached; nobody else does', async () => {
  const w = world();
  seedPending(w, 'p1', 'uid-fin', { qrPath: 'donations/qr/p1.png' });
  w.objects.set('donations/qr/p1.png', PNG);
  for (const token of ['fin', 'su']) {
    const res = await handleDonationPendingQr(get('/x', token), { pendingId: 'p1' }, deps(w));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('cache-control'), PRIVATE_QR_CACHE_CONTROL);
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG);
  }
  assert.equal((await handleDonationPendingQr(get('/x', 'fin'), { pendingId: 'nope' }, deps(w))).status, 404);
});

test('public QR: served while active and before expiry, edge-cached 5 minutes', async () => {
  const w = world();
  w.current = { methods: [], version: 1, updatedAt: 1, active: true, qrPath: 'donations/qr/p1.png', qrExpiresAt: '2028-08-25' };
  w.objects.set('donations/qr/p1.png', PNG);
  const res = await handlePublicDonationQr(deps(w));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), PUBLIC_QR_CACHE_CONTROL);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('public QR: 404 not-available — nothing confirmed, switched off, no QR, expired, or the object is gone', async () => {
  const base = { methods: [], version: 1, updatedAt: 1, active: true, qrPath: 'donations/qr/p1.png', qrExpiresAt: '2028-08-25' };
  const cases: [string, Record<string, unknown> | null, boolean][] = [
    ['nothing confirmed', null, true],
    ['inactive', { ...base, active: false }, true],
    ['no qr', { ...base, qrPath: null }, true],
    ['expired', { ...base, qrExpiresAt: '2026-10-24' }, true],
    ['expired long ago', { ...base, qrExpiresAt: '2026-01-01' }, true],
    ['object missing', base, false],
  ];
  for (const [name, current, withObject] of cases) {
    const w = world();
    w.current = current;
    if (withObject) w.objects.set('donations/qr/p1.png', PNG);
    const f = await failureOf(await handlePublicDonationQr(deps(w)));
    assert.deepEqual([f.status, f.error], [404, 'not-available'], name);
  }
});

test('public QR: never serves a PROPOSAL’s QR, whatever is pending', async () => {
  const w = world();
  seedPending(w, 'p1', 'uid-fin', { qrPath: 'donations/qr/p1.png' });
  w.objects.set('donations/qr/p1.png', PNG);
  assert.equal((await handlePublicDonationQr(deps(w))).status, 404);
});

test('magicMatches: the declared type must match the first bytes', () => {
  assert.ok(magicMatches('image/png', PNG));
  assert.ok(magicMatches('image/jpeg', JPEG));
  assert.equal(magicMatches('image/png', JPEG), false);
  assert.equal(magicMatches('image/jpeg', PNG), false);
  assert.equal(magicMatches('image/gif', PNG), false);
  assert.equal(magicMatches('image/png', new Uint8Array([0x89, 0x50])), false);
});
