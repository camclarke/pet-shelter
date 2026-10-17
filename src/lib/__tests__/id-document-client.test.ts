/**
 * The applicant's side of the ID photo (portion 4c-2, plan §5.2–5.3): the
 * in-browser check before anything exists, and the upload with its retry path.
 *
 * Run with:  node --test --import tsx src/lib/__tests__/id-document-client.test.ts
 *
 * Node has no canvas, so `stripAndResize` is injected: each fake returns hand-
 * built JPEG bytes (jpeg-fixtures.ts) and records the long edge it was asked
 * for. `inspectJpeg` is the REAL one, with the REAL limits — the same walk the
 * route stores through — so a photo this accepts is one the route accepts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ID_PHOTO_FALLBACK_EDGE,
  canUploadLater,
  keepsPhotoForRetry,
  idDocumentUploadUrl,
  idUploadProblem,
  prepareIdPhoto,
  uploadIdDocument,
  type PrepareDeps,
  type PreparedIdPhoto,
} from '../id-document-client';
import { ID_DOCUMENT_FAILURES, ID_DOCUMENT_FAILURE_HEADER, ID_DOCUMENT_MAX_BYTES } from '../id-document-protocol';
import * as handler from '../id-document-handler';
import { ID_PHOTO_LIMITS, ID_PHOTO_MIN_LONG_EDGE } from '../jpeg-inspect';
import { PhotoUnreadableError } from '../image-strip';
import { bytesInclude, chromeLikeJpeg, dht, dqt, exif, jfif, jpeg, scan, sof, sosHeader } from './jpeg-fixtures';

const FILE = {} as File; // never read: the fake strip ignores it

function stripReturning(...outputs: (Uint8Array | Error)[]) {
  const edges: number[] = [];
  const strip: PrepareDeps['strip'] = async (_file, maxEdge) => {
    edges.push(maxEdge);
    const next = outputs.shift();
    if (!next) throw new Error('no more fake encodes');
    if (next instanceof Error) throw next;
    return new Blob([new Uint8Array(next)], { type: 'image/jpeg' });
  };
  return { strip, edges };
}

const deps = (strip: PrepareDeps['strip']): PrepareDeps => ({ strip, limits: ID_PHOTO_LIMITS, maxBytes: ID_DOCUMENT_MAX_BYTES });

/** A valid JPEG whose entropy data makes it `size` bytes, to cross the cap. */
function heavyJpeg(size: number, width = 2048, height = 1536): Uint8Array {
  const head = Uint8Array.from([0xff, 0xd8, ...jfif(), ...dqt(), ...sof({ width, height }), ...dht(), ...sosHeader()]);
  const out = new Uint8Array(size);
  out.set(head, 0);
  out.fill(0x12, head.length, size - 2);
  out[size - 2] = 0xff;
  out[size - 1] = 0xd9;
  return out;
}

// ─── the protocol split ──────────────────────────────────────────────────────

test('the handler re-exports the protocol, so the route and the browser agree on one header', () => {
  assert.equal(handler.ID_DOCUMENT_FAILURE_HEADER, ID_DOCUMENT_FAILURE_HEADER);
  assert.equal(handler.ID_DOCUMENT_MAX_BYTES, ID_DOCUMENT_MAX_BYTES);
  assert.equal(handler.ID_DOCUMENT_FAILURES, ID_DOCUMENT_FAILURES);
  assert.equal(ID_DOCUMENT_MAX_BYTES, 1_572_864, 'the cap moved (1.5 MiB, literal)');
  assert.equal(ID_DOCUMENT_FAILURE_HEADER, 'X-Id-Document-Failure');
});

// ─── prepareIdPhoto: checked in the browser before the application exists ───

test('a canvas-like photo passes, at the 2048 edge, and what is kept is what the route would store', async () => {
  const { strip, edges } = stripReturning(chromeLikeJpeg());
  const outcome = await prepareIdPhoto(FILE, deps(strip));
  assert.ok(outcome.ok);
  assert.deepEqual(edges, [2048]);
  assert.equal(outcome.photo.width, 2048);
  assert.equal(outcome.photo.height, 1536);
});

test('EXIF that survived anyway is spliced out of the bytes that will be sent', async () => {
  const withExif = jpeg(jfif(), exif(), dqt(), sof(), dht(), scan());
  assert.ok(bytesInclude(withExif, 'GPS'), 'control: the fixture carries GPS');
  const outcome = await prepareIdPhoto(FILE, deps(stripReturning(withExif).strip));
  assert.ok(outcome.ok);
  assert.ok(!bytesInclude(outcome.photo.bytes, 'GPS'), 'GPS would have been uploaded');
});

test('a photo too small to read a card from is refused at step 2, as too-small', async () => {
  const small = chromeLikeJpeg({ width: ID_PHOTO_MIN_LONG_EDGE - 1, height: 600 });
  const outcome = await prepareIdPhoto(FILE, deps(stripReturning(small).strip));
  assert.deepEqual(outcome, { ok: false, problem: 'too-small' });
});

test('anything else the route would refuse is refused here as rejected', async () => {
  const progressive = jpeg(jfif(), dqt(), sof({ code: 0xc2 }), dht(), scan());
  assert.deepEqual(await prepareIdPhoto(FILE, deps(stripReturning(progressive).strip)), { ok: false, problem: 'rejected' });
  const trailing = Uint8Array.from([...chromeLikeJpeg(), 0x00]);
  assert.deepEqual(await prepareIdPhoto(FILE, deps(stripReturning(trailing).strip)), { ok: false, problem: 'rejected' });
});

test('an undecodable file is "unreadable"; a broken canvas is "failed"', async () => {
  assert.deepEqual(await prepareIdPhoto(FILE, deps(stripReturning(new PhotoUnreadableError()).strip)), { ok: false, problem: 'unreadable' });
  assert.deepEqual(await prepareIdPhoto(FILE, deps(stripReturning(new Error('canvas-unavailable')).strip)), { ok: false, problem: 'failed' });
});

test('over the size cap, it re-encodes ONCE at 1600 — and keeps that one if it fits', async () => {
  assert.equal(ID_PHOTO_FALLBACK_EDGE, 1600);
  const big = heavyJpeg(ID_DOCUMENT_MAX_BYTES + 10);
  const { strip, edges } = stripReturning(big, chromeLikeJpeg({ width: 1600, height: 1200 }));
  const outcome = await prepareIdPhoto(FILE, deps(strip));
  assert.ok(outcome.ok);
  assert.deepEqual(edges, [2048, 1600]);
  assert.equal(outcome.photo.width, 1600);
});

test('exactly at the cap is kept; still over after the second encode is refused', async () => {
  const atCap = await prepareIdPhoto(FILE, deps(stripReturning(heavyJpeg(ID_DOCUMENT_MAX_BYTES)).strip));
  assert.ok(atCap.ok, 'a photo of exactly the cap was refused');
  const big = heavyJpeg(ID_DOCUMENT_MAX_BYTES + 1);
  const twice = stripReturning(big, heavyJpeg(ID_DOCUMENT_MAX_BYTES + 1, 1600, 1200));
  assert.deepEqual(await prepareIdPhoto(FILE, deps(twice.strip)), { ok: false, problem: 'rejected' });
  assert.deepEqual(twice.edges, [2048, 1600], 'more than one retry');
});

// ─── uploadIdDocument: the route, the token, the retry ──────────────────────

const PHOTO: PreparedIdPhoto = { bytes: chromeLikeJpeg(), width: 2048, height: 1536 };
const USER = { getIdToken: async () => 'token-abc' };

function fakeFetch(answer: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const failureResponse = (status: number, failure: string | null) =>
  new Response('{}', { status, headers: failure ? { [ID_DOCUMENT_FAILURE_HEADER]: failure } : {} });

test('the upload is a POST of raw JPEG to the route, with the Bearer token, and nothing else', async () => {
  const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 201 }));
  const outcome = await uploadIdDocument(USER, 'pet1__uid1', 'front', PHOTO, { fetch: fetchImpl, timeoutMs: 1000 });
  assert.deepEqual(outcome, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, '/api/adoption-applications/pet1__uid1/id-document/front');
  assert.equal(calls[0]!.init.method, 'POST');
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer token-abc');
  assert.equal(headers['Content-Type'], 'image/jpeg');
  const body = calls[0]!.init.body as Blob;
  assert.equal(body.type, 'image/jpeg');
  assert.deepEqual(new Uint8Array(await body.arrayBuffer()), PHOTO.bytes, 'the bytes sent are the bytes that passed');
});

test('the URL is the route, never a Storage path, and never ends in .jpg', () => {
  const url = idDocumentUploadUrl('pet1__uid1', 'front');
  assert.ok(!url.includes('adoption-ids'));
  assert.ok(!/\.jpe?g$/i.test(url));
});

test('already-received counts as success: a retry after a lost response finds the photo there', async () => {
  const { fetchImpl } = fakeFetch(() => failureResponse(409, 'already-received'));
  assert.deepEqual(await uploadIdDocument(USER, 'p__u', 'front', PHOTO, { fetch: fetchImpl, timeoutMs: 1000 }), { ok: true });
});

test('a stamped failure is ours; an unstamped one is the edge (unexpected); no answer is network', async () => {
  const at = async (response: () => Response | Promise<Response>) =>
    uploadIdDocument(USER, 'p__u', 'front', PHOTO, { fetch: fakeFetch(response).fetchImpl, timeoutMs: 1000 });
  assert.deepEqual(await at(() => failureResponse(409, 'not-open')), { ok: false, failure: 'not-open' });
  assert.deepEqual(await at(() => failureResponse(504, null)), { ok: false, failure: 'unexpected' });
  assert.deepEqual(await at(() => failureResponse(503, 'made-up')), { ok: false, failure: 'unexpected' });
  assert.deepEqual(await at(() => Promise.reject(new TypeError('Failed to fetch'))), { ok: false, failure: 'network' });
  // A failed token read never throws out of the upload either.
  const broken = { getIdToken: async () => Promise.reject(new Error('auth/network-request-failed')) };
  assert.deepEqual(
    await uploadIdDocument(broken, 'p__u', 'front', PHOTO, { fetch: fakeFetch(() => new Response(null, { status: 201 })).fetchImpl, timeoutMs: 1000 }),
    { ok: false, failure: 'network' },
  );
});

test('a retry with the same photo succeeds once the route answers', async () => {
  const answers = [failureResponse(500, 'marker-failed'), new Response(null, { status: 201 })];
  const { fetchImpl, calls } = fakeFetch(() => answers.shift()!);
  const first = await uploadIdDocument(USER, 'p__u', 'front', PHOTO, { fetch: fetchImpl, timeoutMs: 1000 });
  assert.equal(first.ok, false);
  assert.equal(idUploadProblem((first as { failure: 'marker-failed' }).failure), 'retry');
  assert.deepEqual(await uploadIdDocument(USER, 'p__u', 'front', PHOTO, { fetch: fetchImpl, timeoutMs: 1000 }), { ok: true });
  assert.equal(calls.length, 2);
});

test('only a retry keeps the photo; a later upload is named except for a closed or paused application', () => {
  const problems = ['retry', 'closed', 'sign-in', 'paused', 'photo-too-small', 'photo-rejected'] as const;
  assert.deepEqual(problems.filter(keepsPhotoForRetry), ['retry']);
  assert.deepEqual(problems.filter(canUploadLater), ['retry', 'sign-in', 'photo-too-small', 'photo-rejected']);
});

test('every failure maps to the copy table of plan §5.4', () => {
  const expected: Record<string, string> = {
    'too-large': 'retry',
    'too-slow': 'retry',
    'body-read-failed': 'retry',
    'save-failed': 'retry',
    'marker-failed': 'retry',
    'application-read-failed': 'retry',
    'unknown-side': 'retry',
    unexpected: 'retry',
    network: 'retry',
    'not-open': 'closed',
    erased: 'closed',
    'not-yours': 'sign-in',
    unauthenticated: 'sign-in',
    disabled: 'paused',
    'photo-too-small': 'photo-too-small',
    'not-clean-jpeg': 'photo-rejected',
    'not-jpeg': 'photo-rejected',
    'already-received': 'retry',
  };
  for (const failure of [...ID_DOCUMENT_FAILURES, 'unexpected', 'network'] as const) {
    assert.equal(idUploadProblem(failure), expected[failure], failure);
  }
});
