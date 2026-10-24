/**
 * The donation routes, as pure handlers. No `server-only`, no Firebase import:
 * each route injects token verification, the Firestore transaction, the
 * Storage bucket, the clock and the PNG re-encoder, so every branch is
 * unit-tested with fakes (the `id-document-handler.ts` split). The rules and
 * shapes live in `donations.ts`; the wire contract in `donations-protocol.ts`.
 *
 * ═══ THIS IS OUTSIDE THE RULES ══════════════════════════════════════════════
 * The Admin SDK bypasses `firestore.rules` and `storage.rules`, which refuse
 * every client write to `donationSettings/**` and every client access to
 * `donations/**`. So these handlers ARE the boundary for writes:
 *
 *   1. `guard()` — `requireRole(…, DONATION_ROLES)`, `checkRevoked`, FIRST:
 *      no token 401; not Tesorería or the superuser 403 forbidden.
 *   2. For every WRITE (propose, QR upload, confirm, reject): a sign-in under
 *      `RECENT_SIGN_IN_MAX_AGE_S` (5 min), else 403 requires-recent-login.
 *      A stolen, still-valid token an hour old cannot redirect donations.
 *   3. Confirm and reject: `canConfirm()` — caller ≠ proposer — checked INSIDE
 *      the transaction, on the proposal as stored at that moment, so it cannot
 *      be raced. 403 own-proposal.
 *   4. The QR upload: only the proposer, only on an open proposal that asked
 *      for a new QR and has none yet; body read once through `readCapped`
 *      (2 MB), magic bytes must match the declared type, then RE-ENCODED to
 *      PNG — which drops every metadata chunk — before anything is stored.
 *
 * ═══ WHY THE QR IS A SEPARATE UPLOAD ════════════════════════════════════════
 * Every upload in this project is a raw body streamed through `readCapped`;
 * a multipart parser would buffer the whole body before any cap applies. So
 * the details go as JSON to `propose`, and the image, when the proposal asks
 * to replace it, goes as raw bytes to `pending/{id}/qr`. The upload is
 * create-only and once per proposal: to change the image, propose again. That
 * keeps a proposal immutable once it has its QR, so what the confirmer
 * reviewed is exactly what goes live — no re-upload can slip in between.
 *
 * ⚠️ `sharp` DECODES the uploaded image, which `jpeg-inspect.ts` avoids for ID
 * photos (libvips advisory 2026-09-11). Accepted here (plan D19): only
 * Tesorería and the superuser can reach the decoder, after a recent sign-in,
 * and the route caps the input's pixels. A PNG can carry text chunks a marker
 * walk would have to parse too, and the re-encode is what strips them.
 *
 * ⚠️ Never logged: bank details, account numbers, image bytes, raw errors.
 * Logs name the pending id, the uid and an error's name and code.
 */

import { DONATION_ROLES } from '@/config/roles';
import { RECENT_SIGN_IN_MAX_AGE_S } from './profile';
import { requireRole, type VerifyIdToken } from './require-admin';
import { READ_DEADLINE_MS, readCapped } from './read-capped';
import {
  canConfirm,
  confirmedHistoryId,
  isDonationId,
  isQrVisible,
  parsePending,
  parseSettings,
  qrObjectPathFor,
  rejectedHistoryId,
  settingsAfterConfirm,
  validateProposal,
  validateReason,
  type DonationPending,
} from './donations';
import {
  DONATION_FAILURE_HEADER,
  DONATION_JSON_MAX_BYTES,
  DONATION_QR_MAX_BYTES,
  type DonationFailure,
  type DonationFailureBody,
} from './donations-protocol';

export {
  DONATION_FAILURES,
  DONATION_FAILURE_HEADER,
  DONATION_JSON_MAX_BYTES,
  DONATION_QR_MAX_BYTES,
  donationFailure,
} from './donations-protocol';
export type { DonationFailure } from './donations-protocol';

/** The public QR: cached at the edge for 5 minutes, like the wall. */
export const PUBLIC_QR_CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=60';
/** A proposed QR: never cached anywhere. */
export const PRIVATE_QR_CACHE_CONTROL = 'private, no-store';

/** One transaction's view of the donation documents. Every read comes before every write. */
export interface DonationTx {
  getCurrent(): Promise<unknown | null>;
  getPending(id: string): Promise<unknown | null>;
  /** Every proposal whose `status` is `pending`. */
  listOpenPending(): Promise<{ id: string; data: unknown }[]>;
  /** Replaces `donationSettings/current` entirely. */
  setCurrent(data: Record<string, unknown>): void;
  /** Create-only: the transaction fails if it exists. */
  createPending(id: string, data: Record<string, unknown>): void;
  updatePending(id: string, patch: Record<string, unknown>): void;
  /** Create-only: history is append-only. */
  createHistory(id: string, data: Record<string, unknown>): void;
}

export interface DonationsDeps {
  verifyIdToken: VerifyIdToken;
  nowMs(): number;
  /** A fresh, unguessable pending id matching `isDonationId`. */
  newPendingId(): string;
  /** `FieldValue.serverTimestamp()` in the routes; a sentinel in tests. */
  serverTimestamp(): unknown;
  /** Runs `fn` in ONE Firestore transaction; nothing is written if it throws. */
  runTransaction<T>(fn: (tx: DonationTx) => Promise<T>): Promise<T>;
  readCurrent(): Promise<unknown | null>;
  readPending(id: string): Promise<unknown | null>;
  /** Create-only save; `exists` when an object is already at the path. */
  saveQr(path: string, png: Uint8Array): Promise<'saved' | 'exists'>;
  /** The object's bytes, or null if there is none. */
  readQr(path: string): Promise<Uint8Array | null>;
  deleteQr(path: string): Promise<void>;
  /** Decode and re-encode as PNG (metadata dropped). Throws on anything that is not a decodable image. */
  reencodePng(bytes: Uint8Array): Promise<Uint8Array>;
  /** One line, no payload. */
  log(message: string): void;
  /** Tests only. */
  bodyReadDeadlineMs?: number;
  /** Tests only; the shelter's zone otherwise. */
  timeZone?: string;
}

type Caller = { uid: string; email: string | null; roles: import('@/config/roles').Roles };

function failure(error: DonationFailure, status: number, extra: Omit<DonationFailureBody, 'error'> = {}, close = false): Response {
  return new Response(JSON.stringify({ error, ...extra }), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      [DONATION_FAILURE_HEADER]: error,
      ...(close ? { connection: 'close' } : {}),
    },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** An error's name and code, and nothing it carries. */
function describeError(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' || typeof code === 'string' ? `${name} code=${code}` : name;
}

/** Was the sign-in this token descends from recent enough for a write? A missing auth_time is not. */
export function signedInRecently(authTimeS: number | null, nowMs: number): boolean {
  // A slightly FUTURE auth_time (clock skew) is a negative age and passes.
  const ageS = authTimeS === null ? Number.POSITIVE_INFINITY : nowMs / 1000 - authTimeS;
  return ageS <= RECENT_SIGN_IN_MAX_AGE_S;
}

/**
 * Step 1 and 2 of every authenticated handler, and the only `requireRole(`
 * in this file. Nothing about the request is read before it.
 */
async function guard(
  request: Request,
  deps: DonationsDeps,
  { write }: { write: boolean },
): Promise<{ ok: true; caller: Caller } | { ok: false; response: Response }> {
  const check = await requireRole(request, deps.verifyIdToken, DONATION_ROLES);
  if (!check.ok) return { ok: false, response: failure(check.error, check.status) };
  if (write && !signedInRecently(check.authTimeS, deps.nowMs())) {
    return { ok: false, response: failure('requires-recent-login', 403) };
  }
  return { ok: true, caller: { uid: check.uid, email: check.email, roles: check.roles } };
}

/** A JSON body, read once through the cap. */
async function readJson(
  request: Request,
  deps: DonationsDeps,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const contentType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (contentType !== 'application/json') return { ok: false, response: failure('not-json', 415) };
  let read;
  try {
    read = await readCapped(request.body, DONATION_JSON_MAX_BYTES, { deadlineMs: deps.bodyReadDeadlineMs ?? READ_DEADLINE_MS });
  } catch (err) {
    deps.log(`[donations] body read failed (${describeError(err)})`);
    return { ok: false, response: failure('body-read-failed', 500, {}, true) };
  }
  if (!read.ok) {
    return { ok: false, response: read.reason === 'too-slow' ? failure('too-slow', 408, {}, true) : failure('too-large', 413, {}, true) };
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes)) };
  } catch {
    return { ok: false, response: failure('invalid-body', 400) };
  }
}

/** `{pendingId}` from a decoded body. */
function pendingIdOf(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const id = (body as Record<string, unknown>).pendingId;
  return isDonationId(id) ? id : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/donations/propose
// ─────────────────────────────────────────────────────────────────────────────

export async function handleDonationPropose(request: Request, deps: DonationsDeps): Promise<Response> {
  const gate = await guard(request, deps, { write: true });
  if (!gate.ok) return gate.response;
  const { caller } = gate;

  const body = await readJson(request, deps);
  if (!body.ok) return body.response;

  const checked = validateProposal(body.value, deps.nowMs(), deps.timeZone);
  if (!checked.ok) {
    return checked.error === 'account-mismatch'
      ? failure('account-mismatch', 400, { field: checked.field })
      : failure('invalid-proposal', 400, { field: checked.field, detail: checked.error });
  }

  const pendingId = deps.newPendingId();
  let superseded: string[];
  try {
    superseded = await deps.runTransaction(async (tx) => {
      const open = await tx.listOpenPending();
      const ids = open.map((p) => p.id).filter((id) => id !== pendingId);
      for (const id of ids) {
        tx.updatePending(id, {
          status: 'superseded',
          supersededBy: pendingId,
          decidedBy: caller.uid,
          decidedByEmail: caller.email,
          decidedAt: deps.serverTimestamp(),
        });
      }
      tx.createPending(pendingId, {
        proposedBy: caller.uid,
        proposedByEmail: caller.email,
        proposedAt: deps.serverTimestamp(),
        status: 'pending',
        proposal: checked.proposal,
        qrPath: null,
        reason: null,
        decidedBy: null,
        decidedByEmail: null,
        decidedAt: null,
        supersededBy: null,
      });
      return ids;
    });
  } catch (err) {
    deps.log(`[donations] propose ${pendingId} by ${caller.uid} failed (${describeError(err)})`);
    return failure('write-failed', 500);
  }
  deps.log(`[donations] proposed ${pendingId} by ${caller.uid}${superseded.length ? `; superseded ${superseded.join(',')}` : ''}`);
  return json(201, { pendingId, superseded });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/donations/pending/{id}/qr — the proposal's new QR, raw bytes
// ─────────────────────────────────────────────────────────────────────────────

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);
}

/** Do the bytes really start like the declared type? */
export function magicMatches(contentType: string, bytes: Uint8Array): boolean {
  if (contentType === 'image/jpeg') return startsWith(bytes, JPEG_MAGIC);
  if (contentType === 'image/png') return startsWith(bytes, PNG_MAGIC);
  return false;
}

/** Why this proposal does not accept a QR from this caller now, or null. */
function qrUploadRefusal(pending: DonationPending | null, callerUid: string): { error: DonationFailure; status: number } | null {
  if (!pending) return { error: 'not-found', status: 404 };
  if (pending.status !== 'pending') return { error: 'not-pending', status: 409 };
  if (pending.proposedBy !== callerUid) return { error: 'not-proposer', status: 403 };
  if (pending.proposal.qrAction !== 'replace') return { error: 'qr-not-requested', status: 409 };
  if (pending.qrPath !== null) return { error: 'qr-already-uploaded', status: 409 };
  return null;
}

export async function handleDonationQrUpload(
  request: Request,
  params: { pendingId: string },
  deps: DonationsDeps,
): Promise<Response> {
  const gate = await guard(request, deps, { write: true });
  if (!gate.ok) return gate.response;
  const { caller } = gate;

  const { pendingId } = params;
  if (!isDonationId(pendingId)) return failure('not-found', 404);

  // Headers only: an early refusal. The capped read below is the limit.
  const contentType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (contentType !== 'image/jpeg' && contentType !== 'image/png') return failure('not-image', 415);
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared.trim()) > DONATION_QR_MAX_BYTES) {
    return failure('too-large', 413);
  }

  let pending: DonationPending | null;
  try {
    pending = parsePending(pendingId, await deps.readPending(pendingId));
  } catch (err) {
    deps.log(`[donations] qr ${pendingId}: read failed (${describeError(err)})`);
    return failure('read-failed', 500);
  }
  const refused = qrUploadRefusal(pending, caller.uid);
  if (refused) return failure(refused.error, refused.status);

  let read;
  try {
    read = await readCapped(request.body, DONATION_QR_MAX_BYTES, { deadlineMs: deps.bodyReadDeadlineMs ?? READ_DEADLINE_MS });
  } catch (err) {
    deps.log(`[donations] qr ${pendingId}: body read failed (${describeError(err)})`);
    return failure('body-read-failed', 500, {}, true);
  }
  if (!read.ok) return read.reason === 'too-slow' ? failure('too-slow', 408, {}, true) : failure('too-large', 413, {}, true);

  if (!magicMatches(contentType, read.bytes)) return failure('not-image', 415);

  let png: Uint8Array;
  try {
    png = await deps.reencodePng(read.bytes);
  } catch (err) {
    deps.log(`[donations] qr ${pendingId}: re-encode refused (${describeError(err)})`);
    return failure('invalid-image', 422);
  }
  if (!startsWith(png, PNG_MAGIC)) {
    deps.log(`[donations] qr ${pendingId}: the re-encoder returned something that is not a PNG`);
    return failure('invalid-image', 422);
  }

  const path = qrObjectPathFor(pendingId);
  try {
    const saved = await deps.saveQr(path, png);
    // An object there already, while the proposal has no qrPath: an earlier
    // attempt whose marker failed. One QR per proposal — propose again.
    if (saved === 'exists') return failure('qr-already-uploaded', 409);
  } catch (err) {
    deps.log(`[donations] qr ${pendingId}: save failed (${describeError(err)})`);
    return failure('save-failed', 500);
  }

  let late: { error: DonationFailure; status: number } | null;
  try {
    late = await deps.runTransaction(async (tx) => {
      const now = parsePending(pendingId, await tx.getPending(pendingId));
      const refusal = qrUploadRefusal(now, caller.uid);
      if (refusal) return refusal;
      tx.updatePending(pendingId, { qrPath: path });
      return null;
    });
  } catch (err) {
    deps.log(`[donations] qr ${pendingId}: marker write failed (${describeError(err)})`);
    late = { error: 'write-failed', status: 500 };
  }
  if (late) {
    // Confirmed, rejected or superseded while the body was uploading: the
    // object we just created is referenced by nothing. Remove it.
    try {
      await deps.deleteQr(path);
    } catch (err) {
      deps.log(`[donations] qr ${pendingId}: ${late.error}; deleting the orphan FAILED (${describeError(err)})`);
    }
    return failure(late.error, late.status);
  }
  deps.log(`[donations] qr uploaded for ${pendingId} by ${caller.uid}`);
  return json(201, { uploaded: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/donations/pending/{id}/qr — what the confirmer looks at
// ─────────────────────────────────────────────────────────────────────────────

function png(bytes: Uint8Array, cacheControl: string): Response {
  return new Response(new Blob([bytes as BlobPart], { type: 'image/png' }), {
    status: 200,
    headers: {
      'content-type': 'image/png',
      'cache-control': cacheControl,
      'x-content-type-options': 'nosniff',
      'content-length': String(bytes.byteLength),
    },
  });
}

export async function handleDonationPendingQr(
  request: Request,
  params: { pendingId: string },
  deps: DonationsDeps,
): Promise<Response> {
  const gate = await guard(request, deps, { write: false });
  if (!gate.ok) return gate.response;

  const { pendingId } = params;
  if (!isDonationId(pendingId)) return failure('not-found', 404);
  try {
    const pending = parsePending(pendingId, await deps.readPending(pendingId));
    if (!pending || !pending.qrPath) return failure('not-found', 404);
    const bytes = await deps.readQr(pending.qrPath);
    if (!bytes) return failure('not-found', 404);
    return png(bytes, PRIVATE_QR_CACHE_CONTROL);
  } catch (err) {
    deps.log(`[donations] pending qr ${pendingId}: read failed (${describeError(err)})`);
    return failure('read-failed', 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/donations/confirm
// ─────────────────────────────────────────────────────────────────────────────

type Decision<T> = { ok: true; value: T } | { ok: false; error: DonationFailure; status: number };

export async function handleDonationConfirm(request: Request, deps: DonationsDeps): Promise<Response> {
  const gate = await guard(request, deps, { write: true });
  if (!gate.ok) return gate.response;
  const { caller } = gate;

  const body = await readJson(request, deps);
  if (!body.ok) return body.response;
  const pendingId = pendingIdOf(body.value);
  if (!pendingId) return failure('invalid-body', 400, { field: 'pendingId' });

  let outcome: Decision<number>;
  try {
    outcome = await deps.runTransaction(async (tx): Promise<Decision<number>> => {
      const currentRaw = await tx.getCurrent();
      const pending = parsePending(pendingId, await tx.getPending(pendingId));
      if (!pending) return { ok: false, error: 'not-found', status: 404 };
      if (pending.status !== 'pending') return { ok: false, error: 'not-pending', status: 409 };
      // The two-person rule, on the proposal as stored NOW.
      if (!canConfirm({ callerUid: caller.uid, callerRoles: caller.roles, proposerUid: pending.proposedBy })) {
        return { ok: false, error: 'own-proposal', status: 403 };
      }
      // A current document that exists but does not parse is still replaced,
      // at the version it records (or 1).
      const current = parseSettings(currentRaw);
      const rawVersion = (currentRaw as { version?: unknown } | null)?.version;
      const version = current?.version ?? (typeof rawVersion === 'number' && Number.isSafeInteger(rawVersion) ? rawVersion : 0);
      const next = settingsAfterConfirm(
        { version, qrPath: current?.qrPath ?? null },
        pending,
        deps.nowMs(),
        deps.timeZone,
      );
      if (!next.ok) return { ok: false, error: next.reason, status: 409 };

      const at = deps.serverTimestamp();
      // The public document: details only, NO uid.
      tx.setCurrent({ ...next.settings, updatedAt: at });
      tx.createHistory(confirmedHistoryId(next.settings.version), {
        kind: 'confirmed',
        pendingId,
        version: next.settings.version,
        proposal: { ...pending.proposal, qrExpiresAt: next.settings.qrExpiresAt },
        qrPath: next.settings.qrPath,
        active: next.settings.active,
        proposedBy: pending.proposedBy,
        proposedByEmail: pending.proposedByEmail,
        proposedAt: pending.proposedAt,
        decidedBy: caller.uid,
        decidedByEmail: caller.email,
        decidedAt: at,
        reason: null,
      });
      tx.updatePending(pendingId, {
        status: 'confirmed',
        decidedBy: caller.uid,
        decidedByEmail: caller.email,
        decidedAt: at,
      });
      return { ok: true, value: next.settings.version };
    });
  } catch (err) {
    deps.log(`[donations] confirm ${pendingId} by ${caller.uid} failed (${describeError(err)})`);
    return failure('write-failed', 500);
  }
  if (!outcome.ok) return failure(outcome.error, outcome.status);
  deps.log(`[donations] confirmed ${pendingId} by ${caller.uid} as version ${outcome.value}`);
  return json(200, { version: outcome.value });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/donations/reject
// ─────────────────────────────────────────────────────────────────────────────

export async function handleDonationReject(request: Request, deps: DonationsDeps): Promise<Response> {
  const gate = await guard(request, deps, { write: true });
  if (!gate.ok) return gate.response;
  const { caller } = gate;

  const body = await readJson(request, deps);
  if (!body.ok) return body.response;
  const pendingId = pendingIdOf(body.value);
  if (!pendingId) return failure('invalid-body', 400, { field: 'pendingId' });
  const reason = validateReason((body.value as Record<string, unknown>).reason);
  if (reason === undefined) return failure('invalid-reason', 400, { field: 'reason' });

  let outcome: Decision<string>;
  try {
    outcome = await deps.runTransaction(async (tx): Promise<Decision<string>> => {
      const pending = parsePending(pendingId, await tx.getPending(pendingId));
      if (!pending) return { ok: false, error: 'not-found', status: 404 };
      if (pending.status !== 'pending') return { ok: false, error: 'not-pending', status: 409 };
      if (!canConfirm({ callerUid: caller.uid, callerRoles: caller.roles, proposerUid: pending.proposedBy })) {
        return { ok: false, error: 'own-proposal', status: 403 };
      }
      const at = deps.serverTimestamp();
      const historyId = rejectedHistoryId(pendingId);
      tx.createHistory(historyId, {
        kind: 'rejected',
        pendingId,
        version: null,
        proposal: pending.proposal,
        qrPath: pending.qrPath,
        active: pending.proposal.active,
        proposedBy: pending.proposedBy,
        proposedByEmail: pending.proposedByEmail,
        proposedAt: pending.proposedAt,
        decidedBy: caller.uid,
        decidedByEmail: caller.email,
        decidedAt: at,
        reason,
      });
      tx.updatePending(pendingId, {
        status: 'rejected',
        reason,
        decidedBy: caller.uid,
        decidedByEmail: caller.email,
        decidedAt: at,
      });
      return { ok: true, value: historyId };
    });
  } catch (err) {
    deps.log(`[donations] reject ${pendingId} by ${caller.uid} failed (${describeError(err)})`);
    return failure('write-failed', 500);
  }
  if (!outcome.ok) return failure(outcome.error, outcome.status);
  deps.log(`[donations] rejected ${pendingId} by ${caller.uid}`);
  return json(200, { historyId: outcome.value });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/donations/qr — PUBLIC, the confirmed QR only
// ─────────────────────────────────────────────────────────────────────────────

/** The deps the public route needs: no token, no writes. */
export type PublicQrDeps = Pick<DonationsDeps, 'nowMs' | 'readCurrent' | 'readQr' | 'log' | 'timeZone'>;

/**
 * Deliberately unauthenticated (the /donate page shows it to anyone), and it
 * takes NO request: nothing a caller sends can choose which object is read.
 * Only `donationSettings/current.qrPath` is ever served — never a proposal's —
 * and only while the details are active and the QR has not expired.
 * A 404 is not cached, so a confirmation shows within the 5-minute edge cache.
 */
export async function handlePublicDonationQr(deps: PublicQrDeps): Promise<Response> {
  try {
    const settings = parseSettings(await deps.readCurrent());
    if (!settings || !isQrVisible(settings, deps.nowMs(), deps.timeZone)) return failure('not-available', 404);
    const bytes = await deps.readQr(settings.qrPath!);
    if (!bytes) return failure('not-available', 404);
    return png(bytes, PUBLIC_QR_CACHE_CONTROL);
  } catch (err) {
    deps.log(`[donations] public qr: read failed (${describeError(err)})`);
    return failure('read-failed', 500);
  }
}
