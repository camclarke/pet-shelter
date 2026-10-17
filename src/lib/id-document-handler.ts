/**
 * POST /api/adoption-applications/{applicationId}/id-document/{side} — an
 * applicant uploading the photo of their own identity card.
 *
 * No `server-only`, no Firebase import: the route injects token verification,
 * the application read, the Storage save and delete, and the marker
 * transaction, so every branch is unit-tested with fakes (the
 * `account-delete.ts` split). The header, the failure list and the size cap
 * live in `id-document-protocol.ts`, which the browser imports (4c-2) and this
 * file re-exports, so both halves agree on one header.
 *
 * ═══ WHY A ROUTE, NOT A CLIENT UPLOAD ═══════════════════════════════════════
 * An upload through the Firebase client SDK auto-mints a download token, and a
 * token bypasses `storage.rules` for good (`storage.rules`, private-photo
 * block). And the rules cannot see Storage, so the approval rule needs a
 * marker on the application that only a trusted writer sets. This route is
 * both: it stores through the Admin SDK (no token) and writes the marker.
 *
 * ═══ THIS IS OUTSIDE THE RULES ══════════════════════════════════════════════
 * The Admin SDK bypasses `firestore.rules` and `storage.rules`. Everything the
 * rules would have checked is checked here, in this order, and every refusal
 * is stamped with `X-Id-Document-Failure`:
 *
 *    1. a verified token (`requireUser`, `checkRevoked`)        401 unauthenticated
 *    2. the public switch, `SHELTER.adoptionApplications.enabled` 404 disabled
 *       While it is off no application can exist (the rules' own switch), and
 *       this route must not either — so everyone signed in gets a 404.
 *    3. the id is `{petId}__{uid}` naming the CALLER               403 not-yours
 *    4. the side is one this shelter asks for                      404 unknown-side
 *    5. `Content-Type: image/jpeg`                                 415 not-jpeg
 *       and a `Content-Length`, IF sent, within the cap           413 too-large
 *       The header is an early refusal only: it is optional, and whether
 *       Firebase Hosting forwards it is unmeasured (critic #7). Step 7 is the
 *       limit.
 *    6. the application, read through the Admin SDK — `uploadRefusal()`:
 *         the read itself throws                                   500 application-read-failed
 *         missing                                                   409 not-open
 *         `applicantUid` is not the caller                          403 not-yours
 *         erased — `isIdentityErased(identityErasedAt)`             409 erased
 *           (never folded into not-open: a rejection reopened after the
 *           erase is OPEN, and must still be refused — critic #9)
 *         status not submitted / reviewing / interview              409 not-open
 *         this side already received (`isReceivedMarker`)           409 already-received
 *       `reviewing` and `interview` accept an upload too: the browser writes
 *       the application first and uploads second, so an admin can open it in
 *       between, and the retry must still work.
 *    7. the body, streamed with a running cap (`readCapped`)      413 too-large
 *       and a deadline on the whole read                          408 too-slow
 *       a stream error (the client went away)                     500 body-read-failed
 *    8. `inspectJpeg`: a marker walk, no decode; APP1/APP13/COM removed
 *         too small to read a card from                            422 photo-too-small
 *         anything else refused                                     422 not-clean-jpeg
 *    9. save, create-only (`ifGenerationMatch: 0`)                 500 save-failed
 *       An object already there (412) means a previous attempt saved and its
 *       marker write failed: its receipt is read back and step 10 completes
 *       it, so a retry finishes instead of failing forever.
 *   10. the marker, IN A TRANSACTION (`commitIdMarker`) that re-reads the
 *       application and runs step 6's `uploadRefusal()` again on what is
 *       stored NOW. The body read and the save take seconds; in that window
 *       the applicant can withdraw, an admin can reject, or retention can
 *       erase (review 4b #1). If it refuses:
 *         the photo just stored for this side is DELETED, every version
 *         (`deleteIdDocumentSide`) — unless a received marker already names
 *         the very object at that path (a concurrent upload of this side won,
 *         and its photo is not ours to delete). An erase deletes regardless.
 *         The answer is step 6's: 409 erased / not-open / already-received
 *         (403 not-yours). A failed delete is logged, never hidden.
 *       Otherwise `idDocument.{side} = {receivedAt, bytes, generation}`, a
 *       dotted update, so it works on `{}` and on `{front: null}` alike.
 *         the transaction itself throws                             500 marker-failed (retryable)
 *   11. 201, EMPTY body. No URL, no generation, nothing to read the photo by.
 *
 * ═══ ONE UPLOAD AT A TIME — WITHOUT A LOCK ══════════════════════════════════
 * Nothing here takes a lock. Two uploads of one side are kept apart by two
 * things only: the create-only save (step 9: the second meets 412 and adopts
 * the first one's receipt instead of overwriting it) and the transaction
 * (step 10: whichever commits second re-reads, sees the side received, and
 * answers already-received without deleting the photo the marker names).
 *
 * ⚠️ The body is read exactly once, through `readCapped`, and only after
 * step 6 — `require-admin.test.ts` (USER_UPLOAD_ROUTES) fails otherwise.
 * ⚠️ Never logged: bytes, the address, the answers. Logs name the marker
 * removed or refused (`FFE1`), and on a failure the application id and the
 * error's name and code — never the error itself.
 */

import { requireUser, type VerifyIdToken } from './require-admin';
import { isIdentityErased, isOpenApplication, isReceivedMarker, parseApplicationId } from './applications';
import { isIdDocumentSide } from './id-document-paths';
import { inspectJpeg } from './jpeg-inspect';
import { READ_DEADLINE_MS, readCapped, type CappedRead } from './read-capped';
import type { SaveIdDocumentOutcome, StoredIdDocument } from './id-document-store';
import { ID_DOCUMENT_FAILURE_HEADER, ID_DOCUMENT_MAX_BYTES, type IdDocumentFailure } from './id-document-protocol';
import type { ApplicationStatus, IdDocumentSide } from './types';

// The wire contract lives in `id-document-protocol.ts` (portion 4c-2), so the
// browser reads a response without bundling this handler. Re-exported here, so
// the route and the tests import exactly what they did before the split.
export { ID_DOCUMENT_FAILURES, ID_DOCUMENT_FAILURE_HEADER, ID_DOCUMENT_MAX_BYTES, idDocumentFailure } from './id-document-protocol';
export type { IdDocumentFailure } from './id-document-protocol';

/** The whole body read. Below Firebase Hosting's 60 s ceiling, with room for the save and the marker. */
export const ID_DOCUMENT_READ_DEADLINE_MS = READ_DEADLINE_MS;

/** The application as the handler needs it — raw values, validated here. */
export interface UploadApplicationSnapshot {
  applicantUid: unknown;
  status: unknown;
  identityErasedAt: unknown;
  idDocument: unknown;
}

/** Why an application does not accept this upload — step 6, and again inside step 10. */
export interface UploadRefusal {
  reason: 'not-open' | 'not-yours' | 'erased' | 'already-received';
  status: 403 | 409;
}

/** Decides, inside the transaction, against the application as stored at that moment. */
export type UploadCheck = (current: UploadApplicationSnapshot | null) => UploadRefusal | null;

export interface IdDocumentDeps {
  verifyIdToken: VerifyIdToken;
  /** `SHELTER.adoptionApplications.enabled` — the route passes exactly that. */
  applicationsEnabled: boolean;
  /** `SHELTER.adoptionApplications.idDocumentSides`. */
  sides: readonly IdDocumentSide[];
  readApplication: (applicationId: string) => Promise<UploadApplicationSnapshot | null>;
  saveIdDocument: (
    applicationId: string,
    side: IdDocumentSide,
    bytes: Uint8Array,
  ) => Promise<SaveIdDocumentOutcome>;
  readIdDocumentReceipt: (applicationId: string, side: IdDocumentSide) => Promise<StoredIdDocument | null>;
  /**
   * In ONE Firestore transaction: read the application, call `check` on what
   * it reads, and — only if `check` returns null — write
   * `idDocument.{side} = {receivedAt: serverTimestamp, bytes, generation}` as
   * a dotted update. Returns `check`'s answer from the attempt that committed
   * (a transaction may retry; `check` runs on every attempt).
   */
  commitIdMarker: (
    applicationId: string,
    side: IdDocumentSide,
    receipt: StoredIdDocument,
    check: UploadCheck,
  ) => Promise<UploadRefusal | null>;
  /** `deleteEveryIdDocumentVersion(bucket, applicationId, side)` — every version of that one side. */
  deleteIdDocumentSide: (applicationId: string, side: IdDocumentSide) => Promise<void>;
  /** Tests only; the route leaves it unset, so `ID_DOCUMENT_READ_DEADLINE_MS` applies. */
  bodyReadDeadlineMs?: number;
  /**
   * One line, no payload. Never handed a raw error: a GCS or gaxios error can
   * carry the request it failed on, and that request's body is the ID photo.
   */
  log: (message: string) => void;
}

/**
 * `close` adds `Connection: close`, ONLY for a refusal that comes out of the
 * body read. Measured 2026-10-16 (`.claude/review-4b/overflow-fix-experiment.ts`):
 * after a full drain it is harmless (413 reached the client 10/10), and when
 * the read had to be cut short — past the drain ceiling, or the deadline — it
 * turns what would sometimes be a HANG into an immediate connection error. On
 * a refusal BEFORE the body is touched it is harmful: Node drains the unread
 * body itself after the response, and with `close` the client saw ECONNRESET
 * instead of its 413 at 4 MB (10/10). It is a hop-by-hop header: it governs
 * the hop into the container, and Firebase Hosting does not pass it on.
 */
function failure(reason: IdDocumentFailure, status: number, options: { close?: boolean } = {}): Response {
  return new Response(JSON.stringify({ error: reason }), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      [ID_DOCUMENT_FAILURE_HEADER]: reason,
      ...(options.close ? { connection: 'close' } : {}),
    },
  });
}

/** An error's name and code, and nothing it carries. */
function describeError(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' || typeof code === 'string' ? `${name} code=${code}` : name;
}

/** One side's stored value, or undefined. Optional chaining throughout: never a throw on a malformed document. */
function sideMarker(application: UploadApplicationSnapshot | null, side: IdDocumentSide): unknown {
  if (!application || !isReceivedMarker(application.idDocument)) return undefined;
  return (application.idDocument as Record<string, unknown>)[side];
}

/**
 * Does `application` (as stored now) accept an upload of `side` by `caller`?
 * null if it does. Step 6 and the step-10 transaction both call THIS, so the
 * check made before the body is read and the check made at commit cannot
 * drift apart.
 */
export function uploadRefusal(
  application: UploadApplicationSnapshot | null,
  caller: { uid: string },
  side: IdDocumentSide,
): UploadRefusal | null {
  if (!application) return { reason: 'not-open', status: 409 };
  if (application.applicantUid !== caller.uid) return { reason: 'not-yours', status: 403 };
  if (isIdentityErased(application.identityErasedAt)) return { reason: 'erased', status: 409 };
  if (typeof application.status !== 'string' || !isOpenApplication(application.status as ApplicationStatus)) {
    return { reason: 'not-open', status: 409 };
  }
  if (isReceivedMarker(sideMarker(application, side))) return { reason: 'already-received', status: 409 };
  return null;
}

/**
 * After a refused commit: is the object at this side's path an orphan we must
 * delete? Yes on an erase, always. Otherwise yes unless a received marker
 * already records exactly that object (same generation) — then it is a photo
 * somebody's completed upload delivered, and deciding its fate is retention's
 * job (4e), not this request's.
 */
function mustDeleteAfterRefusal(
  refusal: UploadRefusal,
  current: UploadApplicationSnapshot | null,
  side: IdDocumentSide,
  receipt: StoredIdDocument,
): boolean {
  if (refusal.reason === 'erased') return true;
  const marker = sideMarker(current, side);
  return !(isReceivedMarker(marker) && (marker as Record<string, unknown>).generation === receipt.generation);
}

export async function handleIdDocumentUpload(
  request: Request,
  params: { applicationId: string; side: string },
  deps: IdDocumentDeps,
): Promise<Response> {
  // 1. Who is asking. Nothing about the request is read before this.
  const caller = await requireUser(request, deps.verifyIdToken);
  if (!caller.ok) return failure('unauthenticated', 401);

  // 2. Switched off: answer as though the route did not exist.
  if (!deps.applicationsEnabled) return failure('disabled', 404);

  // 3. The id must name the caller. The uid comes from the VERIFIED token,
  //    never from anything the request says about itself.
  const { applicationId } = params;
  const parsed = parseApplicationId(applicationId);
  if (!parsed || parsed.applicantUid !== caller.uid) return failure('not-yours', 403);

  // 4. A side this shelter asks for.
  const side = params.side;
  if (!isIdDocumentSide(side) || !deps.sides.includes(side)) return failure('unknown-side', 404);

  // 5. Headers only: an early refusal, never the limit.
  const contentType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (contentType !== 'image/jpeg') return failure('not-jpeg', 415);
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared.trim()) > ID_DOCUMENT_MAX_BYTES) {
    return failure('too-large', 413);
  }

  // 6. The application, as stored.
  let application: UploadApplicationSnapshot | null;
  try {
    application = await deps.readApplication(applicationId);
  } catch (err) {
    deps.log(`[id-document] ${applicationId}: application read failed (${describeError(err)})`);
    return failure('application-read-failed', 500);
  }
  const refused = uploadRefusal(application, caller, side);
  if (refused) return failure(refused.reason, refused.status);

  // 7. The body: read ONCE, streamed; past the cap drained and dropped, never kept.
  let body: CappedRead;
  try {
    body = await readCapped(request.body, ID_DOCUMENT_MAX_BYTES, {
      deadlineMs: deps.bodyReadDeadlineMs ?? ID_DOCUMENT_READ_DEADLINE_MS,
    });
  } catch (err) {
    deps.log(`[id-document] ${applicationId}: body read failed (${describeError(err)})`);
    return failure('body-read-failed', 500, { close: true });
  }
  if (!body.ok) {
    return body.reason === 'too-slow'
      ? failure('too-slow', 408, { close: true })
      : failure('too-large', 413, { close: true });
  }

  // 8. Inspect without decoding; store only what comes out.
  const inspected = inspectJpeg(body.bytes);
  if (!inspected.ok) {
    deps.log(`[id-document] refused: ${inspected.refusal}${inspected.marker ? ` at ${inspected.marker}` : ''}`);
    return failure(inspected.refusal === 'dimensions-too-small' ? 'photo-too-small' : 'not-clean-jpeg', 422);
  }
  if (inspected.removed.length > 0) deps.log(`[id-document] removed ${inspected.removed.join(',')}`);

  // 9. Save, create-only — half of "one upload at a time" (see the header).
  let receipt: StoredIdDocument;
  try {
    const saved = await deps.saveIdDocument(applicationId, side, inspected.bytes);
    if (saved.outcome === 'saved') {
      receipt = { generation: saved.generation, bytes: saved.bytes };
    } else {
      // Already stored by an earlier attempt whose marker write failed (the
      // marker was null at step 6). Complete THAT one; these bytes are dropped.
      const existing = await deps.readIdDocumentReceipt(applicationId, side);
      if (!existing) {
        deps.log(`[id-document] ${applicationId}: object exists but its metadata could not be read`);
        return failure('save-failed', 500);
      }
      receipt = existing;
    }
  } catch (err) {
    deps.log(`[id-document] ${applicationId}: save failed (${describeError(err)})`);
    return failure('save-failed', 500);
  }

  // 10. The marker, in a transaction that checks the application AGAIN — the
  //     other half of "one upload at a time". `seen` is what the committing
  //     attempt read (a holder, not a `let`: TS cannot see a callback assign).
  const seen: { current: UploadApplicationSnapshot | null } = { current: null };
  let late: UploadRefusal | null;
  try {
    late = await deps.commitIdMarker(applicationId, side, receipt, (current) => {
      seen.current = current;
      return uploadRefusal(current, caller, side);
    });
  } catch (err) {
    deps.log(`[id-document] ${applicationId}: marker write failed (${describeError(err)})`);
    return failure('marker-failed', 500);
  }
  if (late) {
    if (mustDeleteAfterRefusal(late, seen.current, side, receipt)) {
      try {
        await deps.deleteIdDocumentSide(applicationId, side);
        deps.log(`[id-document] ${applicationId}: ${late.reason} during the upload; ${side} deleted`);
      } catch (err) {
        deps.log(
          `[id-document] ${applicationId}: ${late.reason} during the upload; deleting ${side} FAILED (${describeError(err)})`,
        );
      }
    } else {
      deps.log(`[id-document] ${applicationId}: ${late.reason} during the upload; ${side} is the received one, kept`);
    }
    return failure(late.reason, late.status);
  }

  // 11. Received. Nothing in the answer can be used to read the photo.
  return new Response(null, { status: 201, headers: { 'cache-control': 'no-store' } });
}
