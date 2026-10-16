import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  ID_DOCUMENT_FAILURES,
  ID_DOCUMENT_FAILURE_HEADER,
  ID_DOCUMENT_MAX_BYTES,
  ID_DOCUMENT_READ_DEADLINE_MS,
  handleIdDocumentUpload,
  idDocumentFailure,
  type IdDocumentDeps,
  type UploadApplicationSnapshot,
} from '../id-document-handler';
import type { VerifiedIdToken } from '../require-admin';
import type { SaveIdDocumentOutcome, StoredIdDocument } from '../id-document-store';
import type { IdDocumentSide } from '../types';
import { bytesInclude, chromeLikeJpeg, dht, dqt, exif, icc, jfif, jpeg, scan, sof } from './jpeg-fixtures';

const UID = 'uid01';
const APP = `pet01__${UID}`;
const RECEIPT = { receivedAt: { seconds: 1 }, bytes: 900, generation: '1' };

const OPEN_APPLICATION: UploadApplicationSnapshot = {
  applicantUid: UID,
  status: 'submitted',
  identityErasedAt: null,
  idDocument: { front: null },
};

/**
 * A body that records whether anything read it. `highWaterMark: 0`, so the
 * stream does not pull on its own the moment it is created — only a read does.
 */
function trackedBody(bytes: Uint8Array) {
  const seen = { read: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        seen.read = true;
        controller.enqueue(bytes);
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, seen };
}

function request(
  options: {
    token?: string | null;
    contentType?: string | null;
    contentLength?: string | null;
    body?: Uint8Array | ReadableStream<Uint8Array> | null;
  } = {},
): Request {
  const headers = new Headers();
  const token = options.token === undefined ? 'good' : options.token;
  if (token !== null) headers.set('authorization', `Bearer ${token}`);
  const contentType = options.contentType === undefined ? 'image/jpeg' : options.contentType;
  if (contentType !== null) headers.set('content-type', contentType);
  if (options.contentLength) headers.set('content-length', options.contentLength);
  const body = options.body === undefined ? chromeLikeJpeg() : options.body;
  return new Request('http://localhost/api/x', {
    method: 'POST',
    headers,
    body,
    // Node's fetch requires this for a streamed body.
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit);
}

interface Recorded {
  verified: string[];
  read: string[];
  saved: { id: string; side: IdDocumentSide; bytes: Uint8Array }[];
  receipts: string[];
  /** How many transaction attempts ran `check`. */
  attempts: number;
  markers: { id: string; side: IdDocumentSide; receipt: StoredIdDocument }[];
  deleted: { id: string; side: IdDocumentSide }[];
  logs: string[];
}

function deps(
  over: Partial<IdDocumentDeps> & {
    application?: UploadApplicationSnapshot | null;
    /**
     * The application as the marker TRANSACTION reads it — one entry per
     * attempt (a contended transaction retries). Default: unchanged since step 6.
     */
    atCommit?: (UploadApplicationSnapshot | null)[];
    token?: VerifiedIdToken | Error;
    readError?: Error;
    save?: SaveIdDocumentOutcome | Error;
    existing?: StoredIdDocument | null;
    markerError?: Error;
    deleteError?: Error;
  } = {},
): { deps: IdDocumentDeps; rec: Recorded } {
  const rec: Recorded = { verified: [], read: [], saved: [], receipts: [], attempts: 0, markers: [], deleted: [], logs: [] };
  const token = over.token ?? { uid: UID, email: 'ana@example.com' };
  const application = over.application === undefined ? OPEN_APPLICATION : over.application;
  const built: IdDocumentDeps = {
    verifyIdToken: async (t) => {
      rec.verified.push(t);
      if (t !== 'good' || token instanceof Error) throw token instanceof Error ? token : new Error('bad token');
      return token;
    },
    applicationsEnabled: true,
    sides: ['front'],
    readApplication: async (id) => {
      rec.read.push(id);
      if (over.readError) throw over.readError;
      return application;
    },
    saveIdDocument: async (id, side, bytes) => {
      rec.saved.push({ id, side, bytes });
      const save = over.save ?? { outcome: 'saved', generation: '1760000000000001', bytes: bytes.byteLength };
      if (save instanceof Error) throw save;
      return save;
    },
    readIdDocumentReceipt: async (id) => {
      rec.receipts.push(id);
      return over.existing === undefined ? { generation: '1750000000000000', bytes: 777 } : over.existing;
    },
    // A fake transaction: every attempt reads its snapshot and runs `check`;
    // only the LAST attempt's answer counts, and only it may write.
    commitIdMarker: async (id, side, receipt, check) => {
      if (over.markerError) throw over.markerError;
      const snapshots = over.atCommit ?? [application];
      let refusal = null;
      for (const snapshot of snapshots) {
        rec.attempts++;
        refusal = check(snapshot);
      }
      if (refusal) return refusal;
      rec.markers.push({ id, side, receipt });
      return null;
    },
    deleteIdDocumentSide: async (id, side) => {
      if (over.deleteError) throw over.deleteError;
      rec.deleted.push({ id, side });
    },
    log: (message) => rec.logs.push(message),
    ...over,
  };
  return { deps: built, rec };
}

async function call(req: Request, d: IdDocumentDeps, params = { applicationId: APP, side: 'front' }) {
  return handleIdDocumentUpload(req, params, d);
}

async function expectFailure(response: Response, status: number, reason: string) {
  assert.equal(response.status, status, `status for ${reason}`);
  assert.equal(response.headers.get(ID_DOCUMENT_FAILURE_HEADER), reason);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error: reason });
}

function nothingDone(rec: Recorded) {
  assert.deepEqual(rec.read, [], 'the application was read');
  assert.deepEqual(rec.saved, [], 'something was saved');
  assert.deepEqual(rec.markers, [], 'a marker was written');
}

// ─── 1. who is asking ────────────────────────────────────────────────────────

test('no token, or a bad one, is 401 — and nothing is read, the body included', async () => {
  for (const token of [null, 'bad']) {
    const { deps: d, rec } = deps();
    const body = trackedBody(chromeLikeJpeg());
    await expectFailure(await call(request({ token, body: body.stream }), d), 401, 'unauthenticated');
    nothingDone(rec);
    assert.equal(body.seen.read, false, 'the body was read before authentication');
  }
});

// ─── 2. the switch ───────────────────────────────────────────────────────────

test('switched OFF: every signed-in caller, admins included, gets 404 and nothing is read', async () => {
  for (const token of [{ uid: UID }, { uid: 'someoneElse' }, { uid: 'admin1', admin: true }]) {
    const { deps: d, rec } = deps({ applicationsEnabled: false, token });
    const body = trackedBody(chromeLikeJpeg());
    await expectFailure(await call(request({ body: body.stream }), d), 404, 'disabled');
    nothingDone(rec);
    assert.equal(body.seen.read, false);
  }
});

// ─── 3. whose application ────────────────────────────────────────────────────

test('an id that does not name the caller is 403, before anything is read', async () => {
  for (const applicationId of [`pet01__someoneElse`, 'pet01', 'a__b__c', `pet01__${UID}/x`, '', `__${UID}`]) {
    const { deps: d, rec } = deps();
    await expectFailure(await call(request(), d, { applicationId, side: 'front' }), 403, 'not-yours');
    nothingDone(rec);
  }
});

test('an admin is NOT an exception: an admin uploading for someone else is 403', async () => {
  const { deps: d, rec } = deps({ token: { uid: 'admin1', admin: true } });
  await expectFailure(await call(request(), d), 403, 'not-yours');
  nothingDone(rec);
});

// ─── 4. which side ───────────────────────────────────────────────────────────

test('a side this shelter does not ask for is 404 — back while only front is asked, front.jpg, anything else', async () => {
  for (const side of ['back', 'front.jpg', 'FRONT', '', '../front']) {
    const { deps: d, rec } = deps();
    await expectFailure(await call(request(), d, { applicationId: APP, side }), 404, 'unknown-side');
    nothingDone(rec);
  }
  const both = deps({ sides: ['front', 'back'] });
  assert.equal((await call(request(), both.deps, { applicationId: APP, side: 'back' })).status, 201);
});

// ─── 5. headers ──────────────────────────────────────────────────────────────

test('anything but Content-Type image/jpeg is 415', async () => {
  for (const contentType of [null, 'image/png', 'application/octet-stream', 'multipart/form-data; boundary=x', 'text/plain']) {
    const { deps: d, rec } = deps();
    await expectFailure(await call(request({ contentType }), d), 415, 'not-jpeg');
    nothingDone(rec);
  }
  const ok = deps();
  assert.equal((await call(request({ contentType: 'IMAGE/JPEG; charset=binary' }), ok.deps)).status, 201);
});

test('a declared Content-Length over the cap is refused EARLY, without reading the body', async () => {
  const { deps: d, rec } = deps();
  const body = trackedBody(chromeLikeJpeg());
  const response = await call(request({ contentLength: String(ID_DOCUMENT_MAX_BYTES + 1), body: body.stream }), d);
  await expectFailure(response, 413, 'too-large');
  nothingDone(rec);
  assert.equal(body.seen.read, false);
  // Refused before the body is touched: NO Connection: close. Node drains the
  // unread body itself, and `close` there cost the client its 413 (measured).
  assert.equal(response.headers.get('connection'), null);
});

test('Content-Length boundary: exactly the cap goes on to the body read; the cap + 1 is refused early', async () => {
  // Exactly the cap: not refused by the header, so the body IS read (and then
  // fails inspection, being zeros) — a `>=` would answer 413 here.
  const atCap = deps();
  const exact = trackedBody(new Uint8Array(ID_DOCUMENT_MAX_BYTES));
  const response = await call(request({ contentLength: String(ID_DOCUMENT_MAX_BYTES), body: exact.stream }), atCap.deps);
  await expectFailure(response, 422, 'not-clean-jpeg');
  assert.equal(exact.seen.read, true, 'a Content-Length of exactly the cap must not be refused early');
  // One more: refused on the header alone.
  const over = deps();
  const plusOne = trackedBody(new Uint8Array(ID_DOCUMENT_MAX_BYTES + 1));
  await expectFailure(
    await call(request({ contentLength: String(ID_DOCUMENT_MAX_BYTES + 1), body: plusOne.stream }), over.deps),
    413,
    'too-large',
  );
  assert.equal(plusOne.seen.read, false);
});

test('a missing or odd Content-Length is NOT a refusal: the streaming cap is the limit', async () => {
  // The header is optional (HTTP/2, chunked), and Hosting may not forward it.
  const streamed = deps();
  const body = trackedBody(chromeLikeJpeg());
  assert.equal((await call(request({ body: body.stream }), streamed.deps)).status, 201);
  // CONTROL for every "the body was not read" assertion in this file: the
  // tracker does see a read when one happens.
  assert.equal(body.seen.read, true, 'the tracker cannot see a read — every "not read" check is blind');
  const odd = deps();
  assert.equal((await call(request({ contentLength: ' 12abc' }), odd.deps)).status, 201);
});

// ─── 6. the application ──────────────────────────────────────────────────────

test('no application document is 409 not-open, and the body is not read', async () => {
  const { deps: d, rec } = deps({ application: null });
  const body = trackedBody(chromeLikeJpeg());
  await expectFailure(await call(request({ body: body.stream }), d), 409, 'not-open');
  assert.deepEqual(rec.saved, []);
  assert.equal(body.seen.read, false);
});

test('a stored applicantUid that is not the caller is 403', async () => {
  const { deps: d, rec } = deps({ application: { ...OPEN_APPLICATION, applicantUid: 'someoneElse' } });
  await expectFailure(await call(request(), d), 403, 'not-yours');
  assert.deepEqual(rec.saved, []);
});

test('ERASED is its own answer, even on an application that is open again (critic #9)', async () => {
  for (const status of ['reviewing', 'submitted', 'rejected', 'withdrawn']) {
    const { deps: d, rec } = deps({
      application: { ...OPEN_APPLICATION, status, identityErasedAt: { seconds: 5 } },
    });
    const body = trackedBody(chromeLikeJpeg());
    await expectFailure(await call(request({ body: body.stream }), d), 409, 'erased');
    assert.deepEqual(rec.saved, [], status);
    assert.equal(body.seen.read, false, status);
  }
});

test('only submitted, reviewing and interview accept an upload', async () => {
  for (const status of ['submitted', 'reviewing', 'interview']) {
    const { deps: d } = deps({ application: { ...OPEN_APPLICATION, status } });
    assert.equal((await call(request(), d)).status, 201, status);
  }
  for (const status of ['approved', 'rejected', 'withdrawn', 'SUBMITTED', 7, null, undefined]) {
    const { deps: d, rec } = deps({ application: { ...OPEN_APPLICATION, status } });
    await expectFailure(await call(request(), d), 409, 'not-open');
    assert.deepEqual(rec.saved, [], String(status));
  }
});

test('"received" means a MAP: {}, {front: null}, {front: false}, a missing marker all accept the first upload (critic #3)', async () => {
  for (const idDocument of [{}, { front: null }, { front: false }, { front: 0 }, { front: 'yes' }, { front: [] }, null, undefined, 'x', { back: RECEIPT }]) {
    const { deps: d, rec } = deps({ application: { ...OPEN_APPLICATION, idDocument } });
    const response = await call(request(), d);
    assert.equal(response.status, 201, JSON.stringify(idDocument) ?? String(idDocument));
    assert.equal(rec.markers.length, 1);
  }
});

test('a side whose receipt is a map is 409 already-received, and nothing is stored', async () => {
  const { deps: d, rec } = deps({ application: { ...OPEN_APPLICATION, idDocument: { front: RECEIPT } } });
  const body = trackedBody(chromeLikeJpeg());
  await expectFailure(await call(request({ body: body.stream }), d), 409, 'already-received');
  assert.deepEqual(rec.saved, []);
  assert.equal(body.seen.read, false);
});

// ─── 7. the body ─────────────────────────────────────────────────────────────

test('a body over the cap with NO Content-Length is still refused by the streaming read', async () => {
  const { deps: d, rec } = deps();
  const big = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 4; i++) controller.enqueue(new Uint8Array(512 * 1024));
      controller.close();
    },
  });
  const response = await call(request({ body: big }), d);
  await expectFailure(response, 413, 'too-large');
  assert.deepEqual(rec.saved, []);
  // Out of the body read: the drain happened, and the hop is closed after it.
  assert.equal(response.headers.get('connection'), 'close');
});

test('a body that does not finish within the deadline is 408 too-slow, closes the connection, and stores nothing', async () => {
  assert.equal(ID_DOCUMENT_READ_DEADLINE_MS, 30_000, 'below Firebase Hosting’s 60 s ceiling');
  let cancelled = false;
  const trickle = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chromeLikeJpeg().subarray(0, 10)); // a start, then nothing
    },
    cancel() {
      cancelled = true;
    },
  });
  const { deps: d, rec } = deps({ bodyReadDeadlineMs: 30 });
  const started = Date.now();
  const response = await call(request({ body: trickle }), d);
  await expectFailure(response, 408, 'too-slow');
  assert.ok(Date.now() - started < 2000, 'the deadline did not cut the read');
  assert.equal(response.headers.get('connection'), 'close');
  assert.equal(cancelled, true, 'the slow upload must be stopped');
  assert.deepEqual(rec.saved, []);
  assert.deepEqual(rec.markers, []);
});

// ─── a failure while READING is ours, stamped, and leaks nothing (review 4b #5d) ──

test('the application read throwing is 500 application-read-failed: stamped, the body unread, the log name and code only', async () => {
  const error = Object.assign(new Error('UNAVAILABLE SECRET-ADDRESS'), { code: 14, details: 'SECRET-ADDRESS' });
  const { deps: d, rec } = deps({ readError: error });
  const body = trackedBody(chromeLikeJpeg());
  await expectFailure(await call(request({ body: body.stream }), d), 500, 'application-read-failed');
  assert.equal(body.seen.read, false);
  assert.deepEqual(rec.saved, []);
  assert.deepEqual(rec.logs, [`[id-document] ${APP}: application read failed (Error code=14)`]);
  assert.ok(rec.logs.every((line) => !line.includes('SECRET')));
});

test('the body stream erroring (the client went away) is 500 body-read-failed: stamped, nothing stored, the log name only', async () => {
  const broken = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chromeLikeJpeg().subarray(0, 64));
      controller.error(Object.assign(new TypeError('terminated SECRET-BYTES'), { cause: 'SECRET-BYTES' }));
    },
  });
  const { deps: d, rec } = deps();
  const response = await call(request({ body: broken }), d);
  await expectFailure(response, 500, 'body-read-failed');
  assert.deepEqual(rec.saved, []);
  assert.deepEqual(rec.markers, []);
  assert.deepEqual(rec.logs, [`[id-document] ${APP}: body read failed (TypeError)`]);
  assert.ok(rec.logs.every((line) => !line.includes('SECRET')));
});

test('exactly the cap is read (it then fails inspection, not the cap)', async () => {
  const { deps: d } = deps();
  const response = await call(request({ body: new Uint8Array(ID_DOCUMENT_MAX_BYTES) }), d);
  await expectFailure(response, 422, 'not-clean-jpeg');
});

test('the cap is about 1.5 MB: a 2048 px JPEG fits, and a phone uplink can carry it inside 60 s', () => {
  assert.equal(ID_DOCUMENT_MAX_BYTES, 1_572_864);
});

// ─── 8. the inspection ───────────────────────────────────────────────────────

test('a body that is not a clean JPEG is 422, nothing is stored, and the log names only the marker', async () => {
  const mpf = Uint8Array.from([0xff, 0xd8, 0xff, 0xe2, 0x00, 0x08, 0x4d, 0x50, 0x46, 0x00, 0x47, 0x50, 0xff, 0xd9]);
  for (const body of [new Uint8Array(0), Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), mpf]) {
    const { deps: d, rec } = deps();
    await expectFailure(await call(request({ body }), d), 422, 'not-clean-jpeg');
    assert.deepEqual(rec.saved, []);
    assert.deepEqual(rec.markers, []);
    for (const line of rec.logs) assert.match(line, /^\[id-document\] refused: [a-z0-9-]+( at FF[0-9A-F]{2})?$/);
  }
});

test('a photo too small to read a card from is its own answer: 422 photo-too-small', async () => {
  const { deps: d, rec } = deps();
  await expectFailure(await call(request({ body: chromeLikeJpeg({ width: 640, height: 480 }) }), d), 422, 'photo-too-small');
  assert.deepEqual(rec.saved, []);
});

test('EXIF is REMOVED before saving: the stored bytes carry no GPS, and the log names FFE1, not its contents', async () => {
  const input = jpeg(jfif(), exif(), icc(), dqt(), sof(), dht(), scan());
  const { deps: d, rec } = deps();
  assert.equal((await call(request({ body: input }), d)).status, 201);
  assert.equal(rec.saved.length, 1);
  const stored = rec.saved[0]!.bytes;
  assert.equal(bytesInclude(stored, 'GPS'), false);
  assert.equal(bytesInclude(stored, 'Exif'), false);
  assert.deepEqual(rec.logs, ['[id-document] removed FFE1']);
  assert.ok(rec.logs.every((line) => !line.includes('GPS')));
});

// ─── 9–11. save, marker, answer ──────────────────────────────────────────────

test('success: one save of the inspected bytes, one marker with its generation and size, 201 with an EMPTY body', async () => {
  const input = chromeLikeJpeg();
  const { deps: d, rec } = deps();
  const response = await call(request({ body: input }), d);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get(ID_DOCUMENT_FAILURE_HEADER), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), '', 'no URL, no generation, nothing to read the photo by');
  assert.deepEqual(rec.read, [APP]);
  assert.equal(rec.saved.length, 1);
  assert.deepEqual({ id: rec.saved[0]!.id, side: rec.saved[0]!.side }, { id: APP, side: 'front' });
  assert.deepEqual([...rec.saved[0]!.bytes], [...input]);
  assert.deepEqual(rec.markers, [
    { id: APP, side: 'front', receipt: { generation: '1760000000000001', bytes: input.length } },
  ]);
  assert.deepEqual(rec.verified, ['good']);
});

test('an object already stored (412) with the marker still null: the earlier save is COMPLETED, not repeated', async () => {
  const { deps: d, rec } = deps({ save: { outcome: 'exists' } });
  assert.equal((await call(request(), d)).status, 201);
  assert.deepEqual(rec.receipts, [APP]);
  assert.deepEqual(rec.markers, [{ id: APP, side: 'front', receipt: { generation: '1750000000000000', bytes: 777 } }]);
});

test('exists, but its metadata cannot be read: 500 save-failed, retryable, no marker', async () => {
  const { deps: d, rec } = deps({ save: { outcome: 'exists' }, existing: null });
  await expectFailure(await call(request(), d), 500, 'save-failed');
  assert.deepEqual(rec.markers, []);
});

test('a failed save is 500 save-failed, and the log carries the error NAME and code only — never its payload', async () => {
  // A gaxios-style error carries the request it failed on: here, the photo.
  const error = Object.assign(new Error('upload failed SECRET-BYTES'), {
    code: 503,
    config: { data: 'SECRET-BYTES' },
  });
  const { deps: d, rec } = deps({ save: error });
  await expectFailure(await call(request(), d), 500, 'save-failed');
  assert.deepEqual(rec.markers, []);
  assert.deepEqual(rec.logs, [`[id-document] ${APP}: save failed (Error code=503)`]);
  assert.ok(rec.logs.every((line) => !line.includes('SECRET')));
});

test('a failed marker write is 500 marker-failed — and a retry then completes through the 412 path', async () => {
  const first = deps({ markerError: Object.assign(new Error('deadline SECRET'), { code: 'deadline-exceeded' }) });
  await expectFailure(await call(request(), first.deps), 500, 'marker-failed');
  assert.ok(first.rec.logs.every((line) => !line.includes('SECRET')));
  // The photo is stored, the marker is still null: the retry's save meets 412.
  const retry = deps({ save: { outcome: 'exists' } });
  assert.equal((await call(request(), retry.deps)).status, 201);
  assert.equal(retry.rec.markers.length, 1);
});

// ─── the application changed WHILE the photo was uploading (review 4b #1) ────

const SAVED_GENERATION = '1760000000000001';

test('withdrawn during the upload: 409 not-open, the photo just stored is DELETED, and no marker is written', async () => {
  for (const status of ['withdrawn', 'rejected', 'approved']) {
    const { deps: d, rec } = deps({ atCommit: [{ ...OPEN_APPLICATION, status }] });
    await expectFailure(await call(request(), d), 409, 'not-open');
    assert.equal(rec.saved.length, 1, `${status}: the photo was stored before the commit`);
    assert.deepEqual(rec.markers, [], `${status}: a marker was written on a closed application`);
    assert.deepEqual(rec.deleted, [{ id: APP, side: 'front' }], `${status}: the stored photo outlived the refusal`);
  }
});

test('erased during the upload: 409 erased, the photo DELETED, no marker — even if a marker already names it', async () => {
  const erased = { ...OPEN_APPLICATION, identityErasedAt: { seconds: 9 } };
  const plain = deps({ atCommit: [erased] });
  await expectFailure(await call(request(), plain.deps), 409, 'erased');
  assert.deepEqual(plain.rec.markers, []);
  assert.deepEqual(plain.rec.deleted, [{ id: APP, side: 'front' }]);
  // An erase mid-flight with the marker not yet cleared: erased wins, the photo goes.
  const named = deps({
    atCommit: [{ ...erased, idDocument: { front: { ...RECEIPT, generation: SAVED_GENERATION } } }],
  });
  await expectFailure(await call(request(), named.deps), 409, 'erased');
  assert.deepEqual(named.rec.deleted, [{ id: APP, side: 'front' }]);
});

test('the application deleted, or its owner changed, during the upload: refused, and the photo deleted', async () => {
  const gone = deps({ atCommit: [null] });
  await expectFailure(await call(request(), gone.deps), 409, 'not-open');
  assert.deepEqual(gone.rec.deleted, [{ id: APP, side: 'front' }]);
  const other = deps({ atCommit: [{ ...OPEN_APPLICATION, applicantUid: 'someoneElse' }] });
  await expectFailure(await call(request(), other.deps), 403, 'not-yours');
  assert.deepEqual(other.rec.deleted, [{ id: APP, side: 'front' }]);
  assert.deepEqual(other.rec.markers, []);
});

test('a concurrent upload of the same side won: 409 already-received, and ITS photo — the one the marker names — is KEPT', async () => {
  // This request met 412 (the winner's object), adopted that receipt, and the
  // winner's marker landed first. Deleting here would delete a received photo.
  const winner = { generation: '1750000000000000', bytes: 777 };
  const { deps: d, rec } = deps({
    save: { outcome: 'exists' },
    existing: winner,
    atCommit: [{ ...OPEN_APPLICATION, idDocument: { front: { ...RECEIPT, ...winner } } }],
  });
  await expectFailure(await call(request(), d), 409, 'already-received');
  assert.deepEqual(rec.deleted, [], 'the received photo was deleted');
  assert.deepEqual(rec.markers, []);
});

test('received already, but the marker names a DIFFERENT object than the one this request stored: that one is deleted', async () => {
  const { deps: d, rec } = deps({
    atCommit: [{ ...OPEN_APPLICATION, idDocument: { front: { ...RECEIPT, generation: '1' } } }],
  });
  await expectFailure(await call(request(), d), 409, 'already-received');
  assert.deepEqual(rec.deleted, [{ id: APP, side: 'front' }]);
});

test('closed after a concurrent upload COMPLETED: the received photo the marker names is kept, not ours to delete', async () => {
  const winner = { generation: '1750000000000000', bytes: 777 };
  const { deps: d, rec } = deps({
    save: { outcome: 'exists' },
    existing: winner,
    atCommit: [{ ...OPEN_APPLICATION, status: 'withdrawn', idDocument: { front: { ...RECEIPT, ...winner } } }],
  });
  await expectFailure(await call(request(), d), 409, 'not-open');
  assert.deepEqual(rec.deleted, []);
});

test('the orphan of an earlier attempt (412, no marker) on an application closed since: refused, and that orphan deleted', async () => {
  const { deps: d, rec } = deps({ save: { outcome: 'exists' }, atCommit: [{ ...OPEN_APPLICATION, status: 'withdrawn' }] });
  await expectFailure(await call(request(), d), 409, 'not-open');
  assert.deepEqual(rec.deleted, [{ id: APP, side: 'front' }]);
});

test('a transaction that RETRIES decides on its last read: open then withdrawn is refused; withdrawn then open is received', async () => {
  const closing = deps({ atCommit: [OPEN_APPLICATION, { ...OPEN_APPLICATION, status: 'withdrawn' }] });
  await expectFailure(await call(request(), closing.deps), 409, 'not-open');
  assert.equal(closing.rec.attempts, 2);
  assert.deepEqual(closing.rec.deleted, [{ id: APP, side: 'front' }]);
  assert.deepEqual(closing.rec.markers, []);
  // The check runs on every attempt and only the committed one counts.
  const reopening = deps({ atCommit: [{ ...OPEN_APPLICATION, status: 'withdrawn' }, OPEN_APPLICATION] });
  assert.equal((await call(request(), reopening.deps)).status, 201);
  assert.deepEqual(reopening.rec.deleted, []);
  assert.equal(reopening.rec.markers.length, 1);
  // The DELETE decision reads the committed attempt too: by the retry, the
  // other upload's marker had landed, naming the very object at the path.
  const winner = { generation: '1750000000000000', bytes: 777 };
  const raced = deps({
    save: { outcome: 'exists' },
    existing: winner,
    atCommit: [
      { ...OPEN_APPLICATION, status: 'withdrawn' },
      { ...OPEN_APPLICATION, status: 'withdrawn', idDocument: { front: { ...RECEIPT, ...winner } } },
    ],
  });
  await expectFailure(await call(request(), raced.deps), 409, 'not-open');
  assert.deepEqual(raced.rec.deleted, [], 'decided on a stale attempt: the received photo was deleted');
});

test('the clean-up delete failing is LOGGED (name and code), and the answer is still the refusal', async () => {
  const { deps: d, rec } = deps({
    atCommit: [{ ...OPEN_APPLICATION, status: 'withdrawn' }],
    deleteError: Object.assign(new Error('SECRET-PATH'), { code: 503 }),
  });
  await expectFailure(await call(request(), d), 409, 'not-open');
  assert.deepEqual(rec.markers, []);
  assert.deepEqual(rec.logs, [`[id-document] ${APP}: not-open during the upload; deleting front FAILED (Error code=503)`]);
  assert.ok(rec.logs.every((line) => !line.includes('SECRET')));
});

test('an application unchanged since step 6 commits on the first attempt, and nothing is deleted (control)', async () => {
  const { deps: d, rec } = deps();
  assert.equal((await call(request(), d)).status, 201);
  assert.equal(rec.attempts, 1);
  assert.deepEqual(rec.deleted, []);
  assert.equal(rec.markers.length, 1);
});

// ─── over a real HTTP connection (review 4b #2) ─────────────────────────────

/**
 * A real Node server that builds the Request the way Next 16 does — the body
 * IS the IncomingMessage (`duplex: 'half'`) — and copies the Response back the
 * way Next's sendResponse does. Cancelling the body at the cap destroyed the
 * IncomingMessage and left its socket open, and the client then never saw
 * the 413 in about half the runs (`.claude/review-4b/cancel-experiment.ts`).
 */
async function withServer<T>(run: (port: number, agent: http.Agent) => Promise<T>): Promise<T> {
  const server = http.createServer(async (req, res) => {
    const webRequest = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: req as unknown as BodyInit,
      duplex: 'half',
    } as RequestInit);
    const response = await handleIdDocumentUpload(webRequest, { applicationId: APP, side: 'front' }, deps().deps);
    res.statusCode = response.status;
    response.headers.forEach((value, name) => res.appendHeader(name, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent({ keepAlive: true });
  try {
    return await run((server.address() as { port: number }).port, agent);
  } finally {
    agent.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** POST `total` bytes, CHUNKED (no Content-Length): the shape the header check cannot refuse early. */
function postChunked(port: number, agent: http.Agent, total: number): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: string) => {
      if (!settled) {
        settled = true;
        resolve(outcome);
      }
    };
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        agent,
        method: 'POST',
        path: '/upload',
        headers: { authorization: 'Bearer good', 'content-type': 'image/jpeg' },
      },
      (res) => {
        res.resume();
        res.on('end', () => settle(`${res.statusCode} ${res.headers[ID_DOCUMENT_FAILURE_HEADER.toLowerCase()]}`));
      },
    );
    req.on('error', (err) => settle(`error ${(err as NodeJS.ErrnoException).code ?? err.name}`));
    req.setTimeout(5000, () => {
      settle('HUNG');
      req.destroy();
    });
    const chunk = Buffer.alloc(16 * 1024, 0x41);
    let sent = 0;
    const pump = () => {
      while (sent < total) {
        sent += chunk.length;
        if (!req.write(chunk)) {
          req.once('drain', pump);
          return;
        }
      }
      req.end();
    };
    pump();
  });
}

test('over HTTP, a chunked body past the cap gets its 413 — 10 of 10 runs, at 2 MB and at 4 MB', async () => {
  await withServer(async (port, agent) => {
    for (const total of [2 * 1024 * 1024, 4 * 1024 * 1024]) {
      const outcomes: string[] = [];
      for (let i = 0; i < 10; i++) outcomes.push(await postChunked(port, agent, total));
      assert.deepEqual(outcomes, new Array(10).fill('413 too-large'), `${total} bytes: ${outcomes.join(', ')}`);
    }
  });
});

test('over HTTP, a body within the cap still goes through (control: the harness is not refusing everything)', async () => {
  await withServer(async (port, agent) => {
    assert.equal(await postChunked(port, agent, 64 * 1024), '422 not-clean-jpeg', 'the bytes are read, then refused by inspection');
  });
});

// ─── the header the browser reads ────────────────────────────────────────────

test('idDocumentFailure: null on success, ours when we wrote the header, unexpected when the edge answered', () => {
  const response = (ok: boolean, header?: string) => ({
    ok,
    headers: { get: (name: string) => (name === ID_DOCUMENT_FAILURE_HEADER ? header ?? null : null) },
  });
  assert.equal(idDocumentFailure(response(true)), null);
  for (const reason of ID_DOCUMENT_FAILURES) assert.equal(idDocumentFailure(response(false, reason)), reason);
  assert.equal(idDocumentFailure(response(false)), 'unexpected', "Hosting's own 503 carries no header");
  assert.equal(idDocumentFailure(response(false, 'made-up')), 'unexpected');
});

test('every failure the handler can stamp is in the closed list', async () => {
  const seen = new Set<string>();
  const runs: [Request, IdDocumentDeps, { applicationId: string; side: string }?][] = [
    [request({ token: null }), deps().deps],
    [request(), deps({ applicationsEnabled: false }).deps],
    [request(), deps().deps, { applicationId: 'x__y', side: 'front' }],
    [request(), deps().deps, { applicationId: APP, side: 'back' }],
    [request({ contentType: 'image/png' }), deps().deps],
    [request({ contentLength: String(ID_DOCUMENT_MAX_BYTES * 2) }), deps().deps],
    [request(), deps({ application: null }).deps],
    [request(), deps({ application: { ...OPEN_APPLICATION, identityErasedAt: 1 } }).deps],
    [request(), deps({ application: { ...OPEN_APPLICATION, idDocument: { front: RECEIPT } } }).deps],
    [request({ body: chromeLikeJpeg({ width: 100, height: 100 }) }), deps().deps],
    [request({ body: new Uint8Array(3) }), deps().deps],
    [request(), deps({ save: new Error('x') }).deps],
    [request(), deps({ markerError: new Error('x') }).deps],
    [request(), deps({ readError: new Error('x') }).deps],
    [
      request({
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.error(new Error('x'));
          },
        }),
      }),
      deps().deps,
    ],
    [request({ body: new ReadableStream<Uint8Array>({ start() {} }) }), deps({ bodyReadDeadlineMs: 5 }).deps],
  ];
  for (const [req, d, params] of runs) {
    const response = await call(req, d, params);
    const header = response.headers.get(ID_DOCUMENT_FAILURE_HEADER);
    assert.ok(header && (ID_DOCUMENT_FAILURES as readonly string[]).includes(header), `unlisted: ${header}`);
    seen.add(header);
  }
  assert.equal(seen.size, ID_DOCUMENT_FAILURES.length, 'every listed failure is reachable');
});
