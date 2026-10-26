/**
 * Donation details: where donors send money, and the two-person rule for
 * changing them. Pure — no Firebase import, no `server-only` — so the routes,
 * the admin screen and the public page share one copy of every rule here, and
 * every rule is unit-tested.
 *
 * ═══ WHO ════════════════════════════════════════════════════════════════════
 * Tesorería (`finance`), the shelter owner (`owner`) and the superuser (`su`) may view, propose, confirm and
 * reject. NOBODY confirms or rejects their own proposal: Tesorería confirms the
 * superuser's, the superuser confirms Tesorería's (owner decision 2026-10-24).
 * Until a second eligible person exists, a proposal simply waits and the
 * current details stay up — the safe failure. `canConfirm()` is the one place
 * that rule lives.
 *
 * ═══ WHERE ══════════════════════════════════════════════════════════════════
 *   donationSettings/current                 confirmed details, PUBLIC, no uid
 *   donationSettings/current/pending/{id}    proposals (Tesorería + owner + su)
 *   donationSettings/current/history/{id}    append-only audit (Tesorería + owner + su)
 *   Storage donations/qr/{pendingId}.png     QR images, Admin SDK only
 *
 * Only the routes write any of it, through the Admin SDK (`firestore.rules`
 * refuses every client write). The QR objects fall under `storage.rules`'
 * catch-all deny and are served by `/api/donations/qr` (public, confirmed
 * only) and `/api/donations/pending/{id}/qr` (Tesorería + owner + su).
 *
 * ═══ ONE PROPOSAL AT A TIME ═════════════════════════════════════════════════
 * A new proposal SUPERSEDES any open one, in the same transaction that creates
 * it (status `superseded`, `supersededBy` = the new id). So the confirmer only
 * ever sees one open proposal, and a stale one cannot be confirmed later.
 *
 * ═══ A PROPOSAL IS IMMUTABLE ════════════════════════════════════════════════
 * The details are fixed when proposed. The QR, when the proposal asks to
 * replace it, is uploaded ONCE afterwards (create-only); to change it, propose
 * again. So what the confirmer reviewed is exactly what goes live.
 *
 * ⚠️ No real bank data belongs in this repository — not in code, tests or
 * fixtures. Fixtures use 'Banco de Prueba' and '0000000000'.
 */

import { DONATION_ROLES, hasAnyRole, type Roles } from '@/config/roles';
import { SHELTER } from '@/config/shelter';
import { dayStartInstant, zonedDayKey } from './zoned-time';

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

export const DONATION_METHOD_KINDS = ['bank', 'qr'] as const;
export type DonationMethodKind = (typeof DONATION_METHOD_KINDS)[number];

export const ACCOUNT_TYPES = ['caja de ahorro', 'cuenta corriente'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const CURRENCIES = ['BOB', 'USD'] as const;
export type Currency = (typeof CURRENCIES)[number];

/**
 * What the proposal does with the QR image.
 *  - `keep`     the confirmed QR (if any) stays.
 *  - `replace`  a new QR is uploaded to this proposal (one upload, create-only)
 *               and goes live on confirmation. Confirm refuses until it exists.
 *  - `remove`   no QR after confirmation.
 */
export const QR_ACTIONS = ['keep', 'replace', 'remove'] as const;
export type QrAction = (typeof QR_ACTIONS)[number];

/**
 * One way to give. `bank`: a transfer to an account, whose number is required.
 * `qr`: the bank account a QR pays into; its number is optional (many bank QR
 * cards do not print it), and a `qr` method needs a QR image to go live.
 *
 * `accountNumber` is stored NORMALISED (`normalizeAccountNumber`): digits and
 * capital letters only, which is what a banking app accepts when pasted.
 */
export interface DonationMethod {
  kind: DonationMethodKind;
  bankName: string;
  accountHolder: string;
  accountNumber: string;
  accountType: AccountType;
  currency: Currency;
  note: string;
}

/** What Tesorería, the shelter owner or the superuser proposes. Never contains a uid. */
export interface DonationProposal {
  methods: DonationMethod[];
  active: boolean;
  /** The day the QR stops working, "YYYY-MM-DD" in the shelter's zone, or null. */
  qrExpiresAt: string | null;
  qrAction: QrAction;
}

/** `donationSettings/current`: the confirmed details. Public; no uid. */
export interface DonationSettings {
  methods: DonationMethod[];
  /** 1 after the first confirmation, +1 on every confirmation. */
  version: number;
  /** Epoch ms of the last confirmation, or null if unreadable. */
  updatedAt: number | null;
  /** The switch: false hides the whole /donate page. */
  active: boolean;
  /** Storage path of the confirmed QR, or null. Internal: never shown. */
  qrPath: string | null;
  qrExpiresAt: string | null;
}

export const PENDING_STATUSES = ['pending', 'confirmed', 'rejected', 'superseded'] as const;
export type PendingStatus = (typeof PENDING_STATUSES)[number];

/** `donationSettings/current/pending/{id}`. */
export interface DonationPending {
  id: string;
  proposedBy: string;
  proposedByEmail: string | null;
  proposedAt: number | null;
  status: PendingStatus;
  proposal: DonationProposal;
  /** Set once, by the QR upload, when `proposal.qrAction` is `replace`. */
  qrPath: string | null;
  /** The rejection's reason, or null. */
  reason: string | null;
  /** Who confirmed, rejected or superseded it. */
  decidedBy: string | null;
  decidedByEmail: string | null;
  decidedAt: number | null;
  /** The proposal that replaced this one, when `status` is `superseded`. */
  supersededBy: string | null;
}

export type HistoryKind = 'confirmed' | 'rejected';

/**
 * `donationSettings/current/history/{id}` — append-only. Ids:
 *   `v000001`, `v000002`, …   one per confirmation (`confirmedHistoryId`)
 *   `rejected-{pendingId}`    one per rejection (`rejectedHistoryId`)
 * Both are created with a create-only write, so an entry can never be
 * overwritten; order them by `decidedAt`.
 */
export interface DonationHistoryEntry {
  id: string;
  kind: HistoryKind;
  pendingId: string;
  /** The version this confirmation produced; null for a rejection. */
  version: number | null;
  /** The details as they went live (confirmed), or as proposed (rejected). */
  proposal: DonationProposal;
  /** The QR the entry refers to: live after a confirmation, proposed on a rejection. */
  qrPath: string | null;
  proposedBy: string;
  proposedByEmail: string | null;
  proposedAt: number | null;
  decidedBy: string;
  decidedByEmail: string | null;
  decidedAt: number | null;
  reason: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Paths and ids
// ─────────────────────────────────────────────────────────────────────────────

export const DONATION_SETTINGS_COLLECTION = 'donationSettings';
export const DONATION_SETTINGS_DOC = 'current';
export const DONATION_SETTINGS_PATH = `${DONATION_SETTINGS_COLLECTION}/${DONATION_SETTINGS_DOC}`;
export const DONATION_PENDING_PATH = `${DONATION_SETTINGS_PATH}/pending`;
export const DONATION_HISTORY_PATH = `${DONATION_SETTINGS_PATH}/history`;

/** A pending id as the routes mint it, or any id a client may send back. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isDonationId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/** Storage path of a proposal's QR. One per proposal; uploaded once. */
export function qrObjectPathFor(pendingId: string): string {
  return `donations/qr/${pendingId}.png`;
}

export function confirmedHistoryId(version: number): string {
  return `v${String(version).padStart(6, '0')}`;
}

export function rejectedHistoryId(pendingId: string): string {
  return `rejected-${pendingId}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Account numbers
// ─────────────────────────────────────────────────────────────────────────────

/** The longest account number accepted (an IBAN's maximum). */
export const ACCOUNT_NUMBER_MAX = 34;
/** The shortest: anything shorter is a typo, not an account. */
export const ACCOUNT_NUMBER_MIN = 4;

/**
 * Spaces, dashes and dots removed, letters upper-cased. The result is what is
 * stored and compared. Returns '' when anything ELSE is in the input (a slash,
 * a letter with an accent, an emoji): an account number with a character a
 * bank would not accept is refused, never silently cleaned.
 */
export function normalizeAccountNumber(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // \s: any whitespace; \p{Pd}: every dash (hyphen-minus, en and em dash, …).
  const stripped = raw.replace(/[\s.\p{Pd}]/gu, '').toUpperCase();
  return /^[A-Z0-9]*$/.test(stripped) ? stripped : '';
}

export function isValidAccountNumber(raw: unknown): boolean {
  const n = normalizeAccountNumber(raw);
  return n.length >= ACCOUNT_NUMBER_MIN && n.length <= ACCOUNT_NUMBER_MAX;
}

/**
 * The account number typed twice: both valid, and the same after
 * normalising. Empty never matches empty — "both blank" is not a confirmation.
 */
export function accountNumbersMatch(a: unknown, b: unknown): boolean {
  if (!isValidAccountNumber(a) || !isValidAccountNumber(b)) return false;
  return normalizeAccountNumber(a) === normalizeAccountNumber(b);
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

export const DONATION_LIMITS = {
  methodsMax: 4,
  bankNameMax: 80,
  accountHolderMax: 120,
  noteMax: 300,
  reasonMax: 300,
} as const;

/** The last year a QR expiry may name. Past it, the date is a typo. */
const QR_EXPIRY_YEAR_MAX = 2100;

export type ProposalError =
  | 'invalid-body'
  | 'no-methods'
  | 'too-many-methods'
  | 'invalid-kind'
  | 'field-required'
  | 'field-too-long'
  | 'invalid-text'
  | 'invalid-account-type'
  | 'invalid-currency'
  | 'invalid-account-number'
  | 'account-mismatch'
  | 'invalid-active'
  | 'invalid-qr-action'
  | 'invalid-qr-expiry'
  | 'qr-expiry-past'
  | 'qr-expiry-without-qr'
  | 'qr-method-without-qr';

export type ProposalValidation =
  | { ok: true; proposal: DonationProposal }
  | { ok: false; error: ProposalError; field: string };

/** Control characters, and the line and paragraph separators. Property classes, never literal escapes. */
const CONTROL_CHARS = /[\p{Cc}\p{Zl}\p{Zp}]/u;

type TextResult = { ok: true; value: string } | { ok: false; error: 'field-required' | 'field-too-long' | 'invalid-text' };

/** Trimmed, inner whitespace collapsed; no control characters. */
function cleanText(raw: unknown, max: number, required: boolean): TextResult {
  if (raw === undefined || raw === null) raw = '';
  if (typeof raw !== 'string') return { ok: false, error: 'invalid-text' };
  // Tabs and newlines collapse like spaces; any other control character is refused.
  const value = raw.replace(/[ \t\r\n]+/g, ' ').trim();
  if (CONTROL_CHARS.test(value)) return { ok: false, error: 'invalid-text' };
  if (required && value.length === 0) return { ok: false, error: 'field-required' };
  if (value.length > max) return { ok: false, error: 'field-too-long' };
  return { ok: true, value };
}

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

/** "YYYY-MM-DD" that names a real calendar day, or null. */
export function parseDayKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return value;
}

/** The shelter's calendar day for an instant. */
export function todayKey(nowMs: number, timeZone: string = SHELTER.timeZone): string {
  return zonedDayKey(nowMs, timeZone);
}

/**
 * Check what a browser sent to `/api/donations/propose`.
 *
 * Input shape: `{ methods: [{ kind, bankName, accountHolder, accountNumber,
 * accountNumberConfirm, accountType, currency, note }], active, qrExpiresAt,
 * qrAction }`. `accountNumberConfirm` is the second typing; it is checked and
 * then dropped — it is never stored.
 *
 * `qrExpiresAt` must be a day AFTER today in the shelter's zone, or null.
 */
export function validateProposal(
  input: unknown,
  nowMs: number,
  timeZone: string = SHELTER.timeZone,
): ProposalValidation {
  const fail = (error: ProposalError, field: string): ProposalValidation => ({ ok: false, error, field });
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return fail('invalid-body', '');
  const body = input as Record<string, unknown>;

  if (!Array.isArray(body.methods) || body.methods.length === 0) return fail('no-methods', 'methods');
  if (body.methods.length > DONATION_LIMITS.methodsMax) return fail('too-many-methods', 'methods');

  const methods: DonationMethod[] = [];
  for (let i = 0; i < body.methods.length; i++) {
    const at = `methods[${i}]`;
    const raw = body.methods[i];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid-body', at);
    const m = raw as Record<string, unknown>;

    if (!isOneOf(DONATION_METHOD_KINDS, m.kind)) return fail('invalid-kind', `${at}.kind`);
    const bankName = cleanText(m.bankName, DONATION_LIMITS.bankNameMax, true);
    if (!bankName.ok) return fail(bankName.error, `${at}.bankName`);
    const accountHolder = cleanText(m.accountHolder, DONATION_LIMITS.accountHolderMax, true);
    if (!accountHolder.ok) return fail(accountHolder.error, `${at}.accountHolder`);
    if (!isOneOf(ACCOUNT_TYPES, m.accountType)) return fail('invalid-account-type', `${at}.accountType`);
    if (!isOneOf(CURRENCIES, m.currency)) return fail('invalid-currency', `${at}.currency`);
    const note = cleanText(m.note, DONATION_LIMITS.noteMax, false);
    if (!note.ok) return fail(note.error, `${at}.note`);

    // A bank method needs its number; a QR method may omit it. Whenever one
    // is given, it must be valid AND typed twice the same.
    const typed = typeof m.accountNumber === 'string' ? m.accountNumber.trim() : m.accountNumber;
    const omitted = typed === undefined || typed === null || typed === '';
    let accountNumber = '';
    if (m.kind === 'bank' || !omitted) {
      if (!isValidAccountNumber(typed)) return fail('invalid-account-number', `${at}.accountNumber`);
      if (!accountNumbersMatch(typed, m.accountNumberConfirm)) return fail('account-mismatch', `${at}.accountNumberConfirm`);
      accountNumber = normalizeAccountNumber(typed);
    }

    methods.push({
      kind: m.kind,
      bankName: bankName.value,
      accountHolder: accountHolder.value,
      accountNumber,
      accountType: m.accountType,
      currency: m.currency,
      note: note.value,
    });
  }

  if (typeof body.active !== 'boolean') return fail('invalid-active', 'active');
  if (!isOneOf(QR_ACTIONS, body.qrAction)) return fail('invalid-qr-action', 'qrAction');

  let qrExpiresAt: string | null = null;
  if (body.qrExpiresAt !== null && body.qrExpiresAt !== undefined && body.qrExpiresAt !== '') {
    const day = parseDayKey(body.qrExpiresAt);
    if (!day || Number(day.slice(0, 4)) > QR_EXPIRY_YEAR_MAX) return fail('invalid-qr-expiry', 'qrExpiresAt');
    if (day <= todayKey(nowMs, timeZone)) return fail('qr-expiry-past', 'qrExpiresAt');
    qrExpiresAt = day;
  }
  if (body.qrAction === 'remove') {
    if (qrExpiresAt !== null) return fail('qr-expiry-without-qr', 'qrExpiresAt');
    if (methods.some((m) => m.kind === 'qr')) return fail('qr-method-without-qr', 'qrAction');
  }

  return { ok: true, proposal: { methods, active: body.active, qrExpiresAt, qrAction: body.qrAction } };
}

/** A rejection's reason: trimmed, at most 300 characters; null when empty. `undefined` when invalid. */
export function validateReason(raw: unknown): string | null | undefined {
  const r = cleanText(raw, DONATION_LIMITS.reasonMax, false);
  if (!r.ok) return undefined;
  return r.value === '' ? null : r.value;
}

// ─────────────────────────────────────────────────────────────────────────────
// The two-person rule
// ─────────────────────────────────────────────────────────────────────────────

/**
 * May this caller confirm or reject this proposal? Only Tesorería or the
 * superuser, and NEVER the person who proposed it. A missing proposer reads
 * as "cannot confirm" — never as "nobody to clash with".
 */
export function canConfirm(args: { callerUid: string; callerRoles: Roles; proposerUid: unknown }): boolean {
  const { callerUid, callerRoles, proposerUid } = args;
  if (!hasAnyRole(callerRoles, DONATION_ROLES)) return false;
  if (typeof proposerUid !== 'string' || proposerUid === '') return false;
  if (typeof callerUid !== 'string' || callerUid === '') return false;
  return callerUid !== proposerUid;
}

// ─────────────────────────────────────────────────────────────────────────────
// QR expiry
// ─────────────────────────────────────────────────────────────────────────────

export type QrExpiryState = 'none' | 'ok' | 'soon' | 'expired';

/** 60 days, the admin screen's warning window (plan D16). */
export const QR_EXPIRY_WARNING_DAYS = 60;

/**
 * Where a confirmed QR stands. It EXPIRES AT THE START of `qrExpiresAt` in the
 * shelter's zone: a card that says «vence 25/08/2028» is hidden from 00:00 on
 * the 25th. A day early is the safe side — an expired QR shown to a donor is a
 * failed payment and a donor who does not try again.
 *
 * `none`: no QR, or no expiry date. An unreadable date reads as `expired`.
 */
export function qrExpiryState(
  settings: Pick<DonationSettings, 'qrPath' | 'qrExpiresAt'>,
  nowMs: number,
  days: number = QR_EXPIRY_WARNING_DAYS,
  timeZone: string = SHELTER.timeZone,
): QrExpiryState {
  if (!settings.qrPath || settings.qrExpiresAt === null) return 'none';
  const day = parseDayKey(settings.qrExpiresAt);
  const start = day ? dayStartInstant(day, timeZone) : null;
  if (!start) return 'expired';
  const left = start.getTime() - nowMs;
  if (left <= 0) return 'expired';
  return left <= days * 86_400_000 ? 'soon' : 'ok';
}

/** Is the confirmed QR shown to the public right now? */
export function isQrVisible(
  settings: Pick<DonationSettings, 'active' | 'qrPath' | 'qrExpiresAt'> | null,
  nowMs: number,
  timeZone: string = SHELTER.timeZone,
): boolean {
  if (!settings || settings.active !== true || !settings.qrPath) return false;
  return qrExpiryState(settings, nowMs, QR_EXPIRY_WARNING_DAYS, timeZone) !== 'expired';
}

/** Does the QR expire within `days` (default 60) — for the admin screen's warning? Already expired is not "soon". */
export function qrExpiresSoon(
  settings: Pick<DonationSettings, 'qrPath' | 'qrExpiresAt'>,
  nowMs: number,
  days: number = QR_EXPIRY_WARNING_DAYS,
  timeZone: string = SHELTER.timeZone,
): boolean {
  return qrExpiryState(settings, nowMs, days, timeZone) === 'soon';
}

// ─────────────────────────────────────────────────────────────────────────────
// Confirmation
// ─────────────────────────────────────────────────────────────────────────────

export type ConfirmRefusal = 'qr-missing' | 'qr-expired';

/**
 * The details that go live when `pending` is confirmed over `current`. The
 * caller adds `updatedAt` (server time). Refuses:
 *   - `qr-missing`: the proposal asks for a new QR that was never uploaded, or
 *     a `qr` method would go live with no QR at all;
 *   - `qr-expired`: the expiry date has arrived since it was proposed.
 * A proposal that ends with no QR drops its expiry date.
 */
export function settingsAfterConfirm(
  current: Pick<DonationSettings, 'version' | 'qrPath'> | null,
  pending: Pick<DonationPending, 'proposal' | 'qrPath'>,
  nowMs: number,
  timeZone: string = SHELTER.timeZone,
): { ok: true; settings: Omit<DonationSettings, 'updatedAt'> } | { ok: false; reason: ConfirmRefusal } {
  const { proposal } = pending;
  let qrPath: string | null;
  if (proposal.qrAction === 'replace') {
    if (!pending.qrPath) return { ok: false, reason: 'qr-missing' };
    qrPath = pending.qrPath;
  } else if (proposal.qrAction === 'keep') {
    qrPath = current?.qrPath ?? null;
  } else {
    qrPath = null;
  }
  if (qrPath === null && proposal.methods.some((m) => m.kind === 'qr')) return { ok: false, reason: 'qr-missing' };
  const qrExpiresAt = qrPath === null ? null : proposal.qrExpiresAt;
  if (qrExpiryState({ qrPath, qrExpiresAt }, nowMs, QR_EXPIRY_WARNING_DAYS, timeZone) === 'expired') {
    return { ok: false, reason: 'qr-expired' };
  }
  const version = (current && Number.isSafeInteger(current.version) && current.version > 0 ? current.version : 0) + 1;
  return {
    ok: true,
    settings: {
      methods: proposal.methods.map((m) => ({ ...m })),
      version,
      active: proposal.active,
      qrPath,
      qrExpiresAt,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Diff, for the confirmer's side-by-side view
// ─────────────────────────────────────────────────────────────────────────────

export interface DiffEntry {
  /** `active`, `qrExpiresAt`, `qr`, `methods[1]` (added/removed) or `methods[0].accountNumber`. */
  path: string;
  before: unknown;
  after: unknown;
}

const METHOD_FIELDS = ['kind', 'bankName', 'accountHolder', 'accountNumber', 'accountType', 'currency', 'note'] as const;

/**
 * Every field the proposal changes, against the confirmed details (`null`
 * when nothing is confirmed yet: everything is new). Methods compare by
 * position. The QR image is reported as `qr`: `{before: 'actual'|null,
 * after: 'nuevo'|'actual'|null}` — the screen shows the images themselves.
 */
export function diffSettings(
  current: Pick<DonationSettings, 'methods' | 'active' | 'qrPath' | 'qrExpiresAt'> | null,
  proposal: DonationProposal,
): DiffEntry[] {
  const out: DiffEntry[] = [];
  const before = current?.methods ?? [];
  const after = proposal.methods;
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    const b = before[i];
    const a = after[i];
    if (!b || !a) {
      out.push({ path: `methods[${i}]`, before: b ?? null, after: a ?? null });
      continue;
    }
    for (const field of METHOD_FIELDS) {
      if (b[field] !== a[field]) out.push({ path: `methods[${i}].${field}`, before: b[field], after: a[field] });
    }
  }
  if ((current?.active ?? null) !== proposal.active) {
    out.push({ path: 'active', before: current?.active ?? null, after: proposal.active });
  }
  const hadQr = Boolean(current?.qrPath);
  const qrAfter = proposal.qrAction === 'replace' ? 'nuevo' : proposal.qrAction === 'keep' && hadQr ? 'actual' : null;
  if (proposal.qrAction === 'replace' || (proposal.qrAction === 'remove' && hadQr)) {
    out.push({ path: 'qr', before: hadQr ? 'actual' : null, after: qrAfter });
  }
  const expiryAfter = qrAfter === null ? null : proposal.qrExpiresAt;
  if ((current?.qrExpiresAt ?? null) !== expiryAfter) {
    out.push({ path: 'qrExpiresAt', before: current?.qrExpiresAt ?? null, after: expiryAfter });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading stored documents (server and admin screen)
// ─────────────────────────────────────────────────────────────────────────────

/** Epoch ms from a Firestore Timestamp (`toMillis`), a Date or a number; null otherwise. */
export function millisOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (value && typeof value === 'object' && typeof (value as { toMillis?: unknown }).toMillis === 'function') {
    const ms = (value as { toMillis: () => unknown }).toMillis();
    return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
  }
  return null;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function parseMethod(raw: unknown): DonationMethod | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (!isOneOf(DONATION_METHOD_KINDS, m.kind) || !isOneOf(ACCOUNT_TYPES, m.accountType) || !isOneOf(CURRENCIES, m.currency)) {
    return null;
  }
  const bankName = str(m.bankName);
  const accountHolder = str(m.accountHolder);
  const accountNumber = str(m.accountNumber);
  if (!bankName || !accountHolder || accountNumber === null) return null;
  return { kind: m.kind, bankName, accountHolder, accountNumber, accountType: m.accountType, currency: m.currency, note: str(m.note) ?? '' };
}

function parseMethods(raw: unknown): DonationMethod[] | null {
  if (!Array.isArray(raw)) return null;
  const methods = raw.map(parseMethod);
  return methods.every((m): m is DonationMethod => m !== null) ? methods : null;
}

/** A stored proposal, or null if malformed. */
export function parseProposal(raw: unknown): DonationProposal | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const methods = parseMethods(p.methods);
  if (!methods || typeof p.active !== 'boolean' || !isOneOf(QR_ACTIONS, p.qrAction)) return null;
  const qrExpiresAt = p.qrExpiresAt === null || p.qrExpiresAt === undefined ? null : parseDayKey(p.qrExpiresAt);
  if (p.qrExpiresAt !== null && p.qrExpiresAt !== undefined && qrExpiresAt === null) return null;
  return { methods, active: p.active, qrExpiresAt, qrAction: p.qrAction };
}

/** `donationSettings/current` as stored, or null when missing or malformed. */
export function parseSettings(raw: unknown): DonationSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const methods = parseMethods(s.methods);
  if (!methods || typeof s.active !== 'boolean') return null;
  if (typeof s.version !== 'number' || !Number.isSafeInteger(s.version) || s.version < 1) return null;
  const qrExpiresAt = s.qrExpiresAt === null || s.qrExpiresAt === undefined ? null : parseDayKey(s.qrExpiresAt);
  return {
    methods,
    version: s.version,
    updatedAt: millisOf(s.updatedAt),
    active: s.active,
    qrPath: str(s.qrPath) || null,
    // A stored expiry that does not parse is kept as an impossible day, so
    // the QR reads as expired rather than as "never expires".
    qrExpiresAt: s.qrExpiresAt === null || s.qrExpiresAt === undefined ? null : (qrExpiresAt ?? '0000-00-00'),
  };
}

/** A stored proposal document, or null when missing or malformed. */
export function parsePending(id: string, raw: unknown): DonationPending | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const proposal = parseProposal(p.proposal);
  const proposedBy = str(p.proposedBy);
  if (!proposal || !proposedBy || !isOneOf(PENDING_STATUSES, p.status)) return null;
  return {
    id,
    proposedBy,
    proposedByEmail: str(p.proposedByEmail),
    proposedAt: millisOf(p.proposedAt),
    status: p.status,
    proposal,
    qrPath: str(p.qrPath) || null,
    reason: str(p.reason),
    decidedBy: str(p.decidedBy),
    decidedByEmail: str(p.decidedByEmail),
    decidedAt: millisOf(p.decidedAt),
    supersededBy: str(p.supersededBy),
  };
}

/** A stored history entry, or null when malformed. */
export function parseHistoryEntry(id: string, raw: unknown): DonationHistoryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const h = raw as Record<string, unknown>;
  const proposal = parseProposal(h.proposal);
  const pendingId = str(h.pendingId);
  const proposedBy = str(h.proposedBy);
  const decidedBy = str(h.decidedBy);
  if (!proposal || !pendingId || !proposedBy || !decidedBy || (h.kind !== 'confirmed' && h.kind !== 'rejected')) return null;
  return {
    id,
    kind: h.kind,
    pendingId,
    version: typeof h.version === 'number' ? h.version : null,
    proposal,
    qrPath: str(h.qrPath) || null,
    proposedBy,
    proposedByEmail: str(h.proposedByEmail),
    proposedAt: millisOf(h.proposedAt),
    decidedBy,
    decidedByEmail: str(h.decidedByEmail),
    decidedAt: millisOf(h.decidedAt),
    reason: str(h.reason),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// What the public sees
// ─────────────────────────────────────────────────────────────────────────────

/** Everything /donate may show. No storage path, no uid. */
export interface PublicDonationSettings {
  methods: DonationMethod[];
  version: number;
  updatedAt: number | null;
  /** Whether `/api/donations/qr` serves an image right now. */
  qrVisible: boolean;
  /** Shown only with the QR, or null. */
  qrExpiresAt: string | null;
}

/**
 * Read and reduce to the public view, NEVER throwing: a failed read hides the
 * page (null) rather than breaking it. `donations-server.ts` binds the reader
 * to the Admin SDK; this half is pure so it is tested.
 */
export async function loadPublicDonationSettings(deps: {
  readCurrent(): Promise<unknown | null>;
  nowMs(): number;
  log(message: string): void;
  timeZone?: string;
}): Promise<PublicDonationSettings | null> {
  try {
    return toPublicSettings(parseSettings(await deps.readCurrent()), deps.nowMs(), deps.timeZone);
  } catch (err) {
    deps.log(`[donations] public settings read failed (${err instanceof Error ? err.name : typeof err})`);
    return null;
  }
}

/** The public view, or null when the page must be hidden (missing, switched off, nothing to show). */
export function toPublicSettings(
  settings: DonationSettings | null,
  nowMs: number,
  timeZone: string = SHELTER.timeZone,
): PublicDonationSettings | null {
  if (!settings || settings.active !== true || settings.methods.length === 0) return null;
  const qrVisible = isQrVisible(settings, nowMs, timeZone);
  return {
    methods: settings.methods.map((m) => ({ ...m })),
    version: settings.version,
    updatedAt: settings.updatedAt,
    qrVisible,
    qrExpiresAt: qrVisible ? settings.qrExpiresAt : null,
  };
}
