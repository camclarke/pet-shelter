/**
 * The pure rules of donation details: account numbers typed twice, proposal
 * validation, the two-person rule, QR expiry, the confirmation's result, the
 * diff the confirmer reads, and the public view.
 *
 * ⚠️ Fixture data only: 'Banco de Prueba', '0000000000'. Never a real account.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { NO_ROLES, rolesFromClaims, type RoleKey } from '@/config/roles';
import {
  accountNumbersMatch,
  canConfirm,
  confirmedHistoryId,
  diffSettings,
  isDonationId,
  isQrVisible,
  isValidAccountNumber,
  loadPublicDonationSettings,
  millisOf,
  normalizeAccountNumber,
  parseDayKey,
  parseHistoryEntry,
  parsePending,
  parseSettings,
  qrExpiresSoon,
  qrExpiryState,
  qrObjectPathFor,
  rejectedHistoryId,
  settingsAfterConfirm,
  toPublicSettings,
  validateProposal,
  validateReason,
  type DonationMethod,
  type DonationProposal,
  type DonationSettings,
} from '../donations';

const TZ = 'America/La_Paz';
/** 2026-10-24 12:00 in La Paz (UTC−4). */
const NOW = Date.UTC(2026, 9, 24, 16, 0, 0);
const only = (...keys: RoleKey[]) => rolesFromClaims(Object.fromEntries(keys.map((k) => [k, true])));

const bankInput = (over: Record<string, unknown> = {}) => ({
  kind: 'bank',
  bankName: 'Banco de Prueba',
  accountHolder: 'Titular de Prueba',
  accountNumber: '0000-0000 00',
  accountNumberConfirm: '0000000000',
  accountType: 'caja de ahorro',
  currency: 'BOB',
  note: '',
  ...over,
});
const proposalInput = (over: Record<string, unknown> = {}) => ({
  methods: [bankInput()],
  active: true,
  qrExpiresAt: null,
  qrAction: 'keep',
  ...over,
});

const method = (over: Partial<DonationMethod> = {}): DonationMethod => ({
  kind: 'bank',
  bankName: 'Banco de Prueba',
  accountHolder: 'Titular de Prueba',
  accountNumber: '0000000000',
  accountType: 'caja de ahorro',
  currency: 'BOB',
  note: '',
  ...over,
});
const settings = (over: Partial<DonationSettings> = {}): DonationSettings => ({
  methods: [method()],
  version: 3,
  updatedAt: NOW - 86_400_000,
  active: true,
  qrPath: 'donations/qr/pold.png',
  qrExpiresAt: '2028-08-25',
  ...over,
});
const proposal = (over: Partial<DonationProposal> = {}): DonationProposal => ({
  methods: [method()],
  active: true,
  qrExpiresAt: null,
  qrAction: 'keep',
  ...over,
});

// ─── account numbers ─────────────────────────────────────────────────────────

test('normalizeAccountNumber drops spaces, dashes and dots, upper-cases, and refuses anything else', () => {
  assert.equal(normalizeAccountNumber(' 0000-0000.00 '), '0000000000');
  assert.equal(normalizeAccountNumber('bo00 0000'), 'BO000000');
  assert.equal(normalizeAccountNumber('0000–000'), '0000000', 'an en dash is a dash');
  for (const bad of ['0000/0000', '0000#', '000ñ', '0000 x!', 12345, null, undefined]) {
    assert.equal(normalizeAccountNumber(bad), '', String(bad));
  }
});

test('isValidAccountNumber: 4 to 34 characters after normalising', () => {
  assert.equal(isValidAccountNumber('000'), false);
  assert.ok(isValidAccountNumber('0000'));
  assert.ok(isValidAccountNumber('0'.repeat(34)));
  assert.equal(isValidAccountNumber('0'.repeat(35)), false);
  assert.equal(isValidAccountNumber('- - .'), false);
});

test('accountNumbersMatch ignores spaces, dashes and dots, and empty never matches empty', () => {
  assert.ok(accountNumbersMatch('0000-0000 00', '0000.0000.00'));
  assert.ok(accountNumbersMatch('ab12 34', 'AB1234'));
  assert.equal(accountNumbersMatch('0000000000', '0000000001'), false);
  assert.equal(accountNumbersMatch('', ''), false);
  assert.equal(accountNumbersMatch('  ', '  '), false);
  assert.equal(accountNumbersMatch('0000/0000', '0000/0000'), false, 'invalid on both sides is not a match');
  assert.equal(accountNumbersMatch('00000000', undefined), false);
});

// ─── validateProposal ────────────────────────────────────────────────────────

test('a valid proposal comes back normalised, without the second typing', () => {
  const r = validateProposal(proposalInput({ methods: [bankInput({ bankName: '  Banco   de\tPrueba ' })] }), NOW, TZ);
  assert.ok(r.ok);
  assert.deepEqual(r.proposal, {
    methods: [method({ bankName: 'Banco de Prueba' })],
    active: true,
    qrExpiresAt: null,
    qrAction: 'keep',
  });
  assert.equal('accountNumberConfirm' in r.proposal.methods[0]!, false);
});

test('the account number typed twice must match → account-mismatch, naming the field', () => {
  const r = validateProposal(proposalInput({ methods: [bankInput({ accountNumberConfirm: '0000000001' })] }), NOW, TZ);
  assert.deepEqual(r, { ok: false, error: 'account-mismatch', field: 'methods[0].accountNumberConfirm' });
  const missing = validateProposal(proposalInput({ methods: [bankInput({ accountNumberConfirm: undefined })] }), NOW, TZ);
  assert.equal(missing.ok ? null : missing.error, 'account-mismatch');
});

test('a bank method needs a valid number; a QR method may omit it, but a given one is checked twice', () => {
  const noNumber = validateProposal(proposalInput({ methods: [bankInput({ accountNumber: '', accountNumberConfirm: '' })] }), NOW, TZ);
  assert.deepEqual(noNumber, { ok: false, error: 'invalid-account-number', field: 'methods[0].accountNumber' });
  const qrNoNumber = validateProposal(
    proposalInput({ methods: [bankInput({ kind: 'qr', accountNumber: '', accountNumberConfirm: '' })] }),
    NOW,
    TZ,
  );
  assert.ok(qrNoNumber.ok);
  assert.equal(qrNoNumber.proposal.methods[0]!.accountNumber, '');
  const qrMismatch = validateProposal(
    proposalInput({ methods: [bankInput({ kind: 'qr', accountNumberConfirm: '1111111111' })] }),
    NOW,
    TZ,
  );
  assert.equal(qrMismatch.ok ? null : qrMismatch.error, 'account-mismatch');
});

test('validateProposal refuses each malformed field by name', () => {
  const cases: [Record<string, unknown> | unknown, string, string][] = [
    [null, 'invalid-body', ''],
    [[], 'invalid-body', ''],
    [proposalInput({ methods: [] }), 'no-methods', 'methods'],
    [proposalInput({ methods: 'x' }), 'no-methods', 'methods'],
    [proposalInput({ methods: [1, 2, 3, 4, 5].map(() => bankInput()) }), 'too-many-methods', 'methods'],
    [proposalInput({ methods: [null] }), 'invalid-body', 'methods[0]'],
    [proposalInput({ methods: [bankInput({ kind: 'cash' })] }), 'invalid-kind', 'methods[0].kind'],
    [proposalInput({ methods: [bankInput({ bankName: '   ' })] }), 'field-required', 'methods[0].bankName'],
    [proposalInput({ methods: [bankInput({ bankName: 'x'.repeat(81) })] }), 'field-too-long', 'methods[0].bankName'],
    [proposalInput({ methods: [bankInput({ accountHolder: '' })] }), 'field-required', 'methods[0].accountHolder'],
    [proposalInput({ methods: [bankInput({ accountHolder: 'x'.repeat(121) })] }), 'field-too-long', 'methods[0].accountHolder'],
    [proposalInput({ methods: [bankInput({ accountHolder: 'Titular\u0000' })] }), 'invalid-text', 'methods[0].accountHolder'],
    [proposalInput({ methods: [bankInput({ bankName: 7 })] }), 'invalid-text', 'methods[0].bankName'],
    [proposalInput({ methods: [bankInput({ accountType: 'ahorro' })] }), 'invalid-account-type', 'methods[0].accountType'],
    [proposalInput({ methods: [bankInput({ currency: 'EUR' })] }), 'invalid-currency', 'methods[0].currency'],
    [proposalInput({ methods: [bankInput({ note: 'x'.repeat(301) })] }), 'field-too-long', 'methods[0].note'],
    [proposalInput({ methods: [bankInput({ accountNumber: '00/00', accountNumberConfirm: '00/00' })] }), 'invalid-account-number', 'methods[0].accountNumber'],
    [proposalInput({ active: 'true' }), 'invalid-active', 'active'],
    [proposalInput({ qrAction: 'upload' }), 'invalid-qr-action', 'qrAction'],
    [proposalInput({ qrExpiresAt: '2028-02-30' }), 'invalid-qr-expiry', 'qrExpiresAt'],
    [proposalInput({ qrExpiresAt: '25/08/2028' }), 'invalid-qr-expiry', 'qrExpiresAt'],
    [proposalInput({ qrExpiresAt: '2101-01-01' }), 'invalid-qr-expiry', 'qrExpiresAt'],
    [proposalInput({ qrExpiresAt: '2026-10-24' }), 'qr-expiry-past', 'qrExpiresAt'],
    [proposalInput({ qrExpiresAt: '2026-01-01' }), 'qr-expiry-past', 'qrExpiresAt'],
    [proposalInput({ qrAction: 'remove', qrExpiresAt: '2028-08-25' }), 'qr-expiry-without-qr', 'qrExpiresAt'],
    [proposalInput({ qrAction: 'remove', methods: [bankInput({ kind: 'qr' })] }), 'qr-method-without-qr', 'qrAction'],
  ];
  for (const [input, error, field] of cases) {
    const r = validateProposal(input, NOW, TZ);
    assert.deepEqual(r, { ok: false, error, field }, `${error} ${field}`);
  }
});

test('qrExpiresAt: tomorrow in La Paz is the earliest accepted day; empty string reads as none', () => {
  // 23:30 in La Paz on the 24th is already the 25th in UTC: "today" is the shelter's.
  const lateEvening = Date.UTC(2026, 9, 25, 3, 30);
  assert.equal(validateProposal(proposalInput({ qrExpiresAt: '2026-10-25' }), lateEvening, TZ).ok, true);
  assert.equal(validateProposal(proposalInput({ qrExpiresAt: '2026-10-24' }), lateEvening, TZ).ok, false);
  const r = validateProposal(proposalInput({ qrExpiresAt: '' }), NOW, TZ);
  assert.ok(r.ok);
  assert.equal(r.proposal.qrExpiresAt, null);
});

test('validateReason: trimmed, ≤ 300, null when empty, undefined when invalid', () => {
  assert.equal(validateReason('  no coincide el titular '), 'no coincide el titular');
  assert.equal(validateReason(''), null);
  assert.equal(validateReason(undefined), null);
  assert.equal(validateReason('x'.repeat(300))?.length, 300);
  assert.equal(validateReason('x'.repeat(301)), undefined);
  assert.equal(validateReason(42), undefined);
});

// ─── the two-person rule ─────────────────────────────────────────────────────

test('canConfirm: Tesorería confirms the superuser’s proposal, and the superuser confirms Tesorería’s', () => {
  assert.ok(canConfirm({ callerUid: 'fin', callerRoles: only('finance'), proposerUid: 'su' }));
  assert.ok(canConfirm({ callerUid: 'su', callerRoles: only('su'), proposerUid: 'fin' }));
});

test('canConfirm: NOBODY confirms their own proposal, whatever roles they hold', () => {
  for (const roles of [only('finance'), only('su'), only('su', 'finance'), only('finance', 'admin')]) {
    assert.equal(canConfirm({ callerUid: 'same', callerRoles: roles, proposerUid: 'same' }), false);
  }
});

test('canConfirm: only Tesorería or su, and a missing proposer or caller never passes', () => {
  for (const role of ['owner', 'admin', 'rescuer', 'events'] as const) {
    assert.equal(canConfirm({ callerUid: 'x', callerRoles: only(role), proposerUid: 'y' }), false, role);
  }
  assert.equal(canConfirm({ callerUid: 'x', callerRoles: NO_ROLES, proposerUid: 'y' }), false);
  for (const proposerUid of [undefined, null, '', 42]) {
    assert.equal(canConfirm({ callerUid: 'x', callerRoles: only('su'), proposerUid }), false, String(proposerUid));
  }
  assert.equal(canConfirm({ callerUid: '', callerRoles: only('su'), proposerUid: 'y' }), false);
});

// ─── QR expiry ───────────────────────────────────────────────────────────────

test('the QR is hidden from 00:00 La Paz on its expiry day, and shown up to the second before', () => {
  const s = settings({ qrExpiresAt: '2028-08-25' });
  const start = Date.UTC(2028, 7, 25, 4, 0, 0); // 00:00 −04:00
  assert.ok(isQrVisible(s, start - 1000, TZ));
  assert.equal(isQrVisible(s, start, TZ), false);
  assert.equal(isQrVisible(s, start + 86_400_000, TZ), false);
  assert.equal(qrExpiryState(s, start, 60, TZ), 'expired');
});

test('isQrVisible: needs active, a QR path, and no expiry or one in the future', () => {
  assert.ok(isQrVisible(settings({ qrExpiresAt: null }), NOW, TZ));
  assert.equal(isQrVisible(settings({ active: false }), NOW, TZ), false);
  assert.equal(isQrVisible(settings({ qrPath: null }), NOW, TZ), false);
  assert.equal(isQrVisible(null, NOW, TZ), false);
  assert.equal(isQrVisible(settings({ qrExpiresAt: '0000-00-00' }), NOW, TZ), false, 'an unreadable date reads as expired');
});

test('qrExpiresSoon: within 60 days and not yet expired', () => {
  const start = Date.UTC(2028, 7, 25, 4, 0, 0);
  const s = settings({ qrExpiresAt: '2028-08-25' });
  assert.equal(qrExpiresSoon(s, start - 61 * 86_400_000, 60, TZ), false);
  assert.ok(qrExpiresSoon(s, start - 60 * 86_400_000, 60, TZ));
  assert.ok(qrExpiresSoon(s, start - 1, 60, TZ));
  assert.equal(qrExpiresSoon(s, start, 60, TZ), false, 'expired is not "soon"');
  assert.equal(qrExpiresSoon(settings({ qrExpiresAt: null }), NOW, 60, TZ), false);
  assert.equal(qrExpiryState(settings({ qrPath: null }), NOW, 60, TZ), 'none');
  assert.equal(qrExpiryState(s, NOW, 60, TZ), 'ok');
});

// ─── confirmation ────────────────────────────────────────────────────────────

test('settingsAfterConfirm: version + 1; keep keeps the current QR, replace takes the uploaded one, remove clears it', () => {
  const current = settings();
  const keep = settingsAfterConfirm(current, { proposal: proposal({ qrExpiresAt: '2028-08-25' }), qrPath: null }, NOW, TZ);
  assert.ok(keep.ok);
  assert.equal(keep.settings.version, 4);
  assert.equal(keep.settings.qrPath, 'donations/qr/pold.png');
  assert.equal(keep.settings.qrExpiresAt, '2028-08-25');

  const replace = settingsAfterConfirm(current, { proposal: proposal({ qrAction: 'replace' }), qrPath: 'donations/qr/pnew.png' }, NOW, TZ);
  assert.ok(replace.ok);
  assert.equal(replace.settings.qrPath, 'donations/qr/pnew.png');

  const remove = settingsAfterConfirm(current, { proposal: proposal({ qrAction: 'remove' }), qrPath: null }, NOW, TZ);
  assert.ok(remove.ok);
  assert.equal(remove.settings.qrPath, null);
  assert.equal(remove.settings.qrExpiresAt, null);

  const first = settingsAfterConfirm(null, { proposal: proposal({ qrExpiresAt: '2028-08-25' }), qrPath: null }, NOW, TZ);
  assert.ok(first.ok);
  assert.equal(first.settings.version, 1);
  assert.equal(first.settings.qrExpiresAt, null, 'no QR, so no expiry date');
});

test('settingsAfterConfirm refuses qr-missing and qr-expired', () => {
  assert.deepEqual(
    settingsAfterConfirm(settings(), { proposal: proposal({ qrAction: 'replace' }), qrPath: null }, NOW, TZ),
    { ok: false, reason: 'qr-missing' },
  );
  assert.deepEqual(
    settingsAfterConfirm(null, { proposal: proposal({ methods: [method({ kind: 'qr' })] }), qrPath: null }, NOW, TZ),
    { ok: false, reason: 'qr-missing' },
  );
  const proposedThenExpired = Date.UTC(2028, 7, 25, 5, 0, 0);
  assert.deepEqual(
    settingsAfterConfirm(settings(), { proposal: proposal({ qrExpiresAt: '2028-08-25' }), qrPath: null }, proposedThenExpired, TZ),
    { ok: false, reason: 'qr-expired' },
  );
});

// ─── diff ────────────────────────────────────────────────────────────────────

test('diffSettings names every changed field, with before and after', () => {
  const p = proposal({
    methods: [method({ accountNumber: '1111111111', currency: 'USD' }), method({ kind: 'qr', accountNumber: '' })],
    active: false,
    qrAction: 'replace',
    qrExpiresAt: '2029-01-01',
  });
  assert.deepEqual(diffSettings(settings(), p), [
    { path: 'methods[0].accountNumber', before: '0000000000', after: '1111111111' },
    { path: 'methods[0].currency', before: 'BOB', after: 'USD' },
    { path: 'methods[1]', before: null, after: method({ kind: 'qr', accountNumber: '' }) },
    { path: 'active', before: true, after: false },
    { path: 'qr', before: 'actual', after: 'nuevo' },
    { path: 'qrExpiresAt', before: '2028-08-25', after: '2029-01-01' },
  ]);
});

test('diffSettings: an identical proposal is no change; nothing confirmed yet makes everything new', () => {
  assert.deepEqual(diffSettings(settings(), proposal({ qrExpiresAt: '2028-08-25' })), []);
  const fromNothing = diffSettings(null, proposal());
  assert.deepEqual(fromNothing.map((d) => d.path), ['methods[0]', 'active']);
  assert.deepEqual(diffSettings(settings(), proposal({ qrAction: 'remove' })).map((d) => d.path), ['qr', 'qrExpiresAt']);
  assert.deepEqual(diffSettings(settings({ methods: [method(), method()] }), proposal()).map((d) => d.path), ['methods[1]', 'qrExpiresAt']);
});

// ─── stored documents and the public view ────────────────────────────────────

test('parseSettings reads a stored document and rejects a malformed one', () => {
  const stored = {
    methods: [method()],
    version: 2,
    updatedAt: { toMillis: () => 123 },
    active: true,
    qrPath: 'donations/qr/p1.png',
    qrExpiresAt: '2028-08-25',
  };
  assert.deepEqual(parseSettings(stored), { ...stored, updatedAt: 123 });
  for (const bad of [null, {}, { ...stored, version: 0 }, { ...stored, active: 'yes' }, { ...stored, methods: [{ kind: 'x' }] }]) {
    assert.equal(parseSettings(bad), null);
  }
  assert.equal(parseSettings({ ...stored, qrExpiresAt: 'garbage' })!.qrExpiresAt, '0000-00-00', 'kept as expired, never as "never"');
});

test('parsePending and parseHistoryEntry read what the routes write', () => {
  const pending = parsePending('p1', {
    proposedBy: 'u1', proposedByEmail: 'a@example.com', proposedAt: 5, status: 'pending',
    proposal: proposal(), qrPath: null, reason: null, decidedBy: null, decidedByEmail: null, decidedAt: null, supersededBy: null,
  });
  assert.equal(pending?.status, 'pending');
  assert.equal(pending?.proposedAt, 5);
  assert.equal(parsePending('p1', { proposedBy: 'u1', status: 'maybe', proposal: proposal() }), null);
  assert.equal(parsePending('p1', { status: 'pending', proposal: proposal() }), null);
  const entry = parseHistoryEntry('v000001', {
    kind: 'confirmed', pendingId: 'p1', version: 1, proposal: proposal(), qrPath: null,
    proposedBy: 'u1', proposedAt: 1, decidedBy: 'u2', decidedAt: new Date(9), reason: null,
  });
  assert.equal(entry?.decidedAt, 9);
  assert.equal(parseHistoryEntry('x', { kind: 'confirmed', pendingId: 'p1', proposal: proposal(), proposedBy: 'u1' }), null);
});

test('toPublicSettings: hidden when inactive or empty; the QR and its date only while visible; never the storage path', () => {
  const view = toPublicSettings(settings(), NOW, TZ)!;
  assert.deepEqual(Object.keys(view).sort(), ['methods', 'qrExpiresAt', 'qrVisible', 'updatedAt', 'version']);
  assert.equal(view.qrVisible, true);
  assert.equal(toPublicSettings(settings({ active: false }), NOW, TZ), null);
  assert.equal(toPublicSettings(settings({ methods: [] }), NOW, TZ), null);
  assert.equal(toPublicSettings(null, NOW, TZ), null);
  const expired = toPublicSettings(settings({ qrExpiresAt: '2026-10-01' }), NOW, TZ)!;
  assert.equal(expired.qrVisible, false);
  assert.equal(expired.qrExpiresAt, null);
  assert.equal(JSON.stringify(view).includes('donations/qr'), false);
});

test('loadPublicDonationSettings never throws: a failed read hides the page', async () => {
  const logs: string[] = [];
  const failed = await loadPublicDonationSettings({
    readCurrent: async () => { throw new Error('boom'); },
    nowMs: () => NOW,
    log: (m) => logs.push(m),
    timeZone: TZ,
  });
  assert.equal(failed, null);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.includes('boom'), false, 'the error text is not logged');
  const ok = await loadPublicDonationSettings({ readCurrent: async () => settings(), nowMs: () => NOW, log: () => {}, timeZone: TZ });
  assert.equal(ok?.version, 3);
  assert.equal(await loadPublicDonationSettings({ readCurrent: async () => null, nowMs: () => NOW, log: () => {} }), null);
});

// ─── ids and paths ───────────────────────────────────────────────────────────

test('ids and paths', () => {
  assert.equal(qrObjectPathFor('pabc-01'), 'donations/qr/pabc-01.png');
  assert.equal(confirmedHistoryId(1), 'v000001');
  assert.equal(confirmedHistoryId(123456), 'v123456');
  assert.equal(rejectedHistoryId('p1'), 'rejected-p1');
  assert.ok(isDonationId('pmo3x-0a1b2c'));
  for (const bad of ['', '../x', 'a/b', 'x'.repeat(65), 'a.png', 1, null]) assert.equal(isDonationId(bad), false, String(bad));
  assert.equal(parseDayKey('2028-08-25'), '2028-08-25');
  assert.equal(parseDayKey('2028-8-25'), null);
  assert.equal(millisOf('5'), null);
});
