import test from 'node:test';
import assert from 'node:assert/strict';

import { DRAIN_CEILING_BYTES, READ_DEADLINE_MS, readCapped } from '../read-capped';

/** A stream of `chunks`, recording how many were pulled and whether it was cancelled. */
function source(chunks: readonly number[]) {
  const seen = { pulled: 0, cancelled: false };
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      seen.pulled++;
      controller.enqueue(new Uint8Array(chunks[i++]!).fill(7));
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { stream, seen };
}

test('a body within the cap comes back whole, in order', async () => {
  const { stream } = source([3, 4, 5]);
  const result = await readCapped(stream, 12);
  assert.ok(result.ok);
  assert.equal(result.bytes.length, 12);
});

test('exactly the cap is accepted; one byte more is refused', async () => {
  assert.ok((await readCapped(source([10]).stream, 10)).ok);
  assert.deepEqual(await readCapped(source([10, 1]).stream, 10), { ok: false, reason: 'too-large' });
});

test('over the cap but under the drain ceiling, the rest is READ AND DROPPED to the end — not cancelled', async () => {
  // Cancelling destroys Node's IncomingMessage and the client may never see
  // the 413 (review 4b #2); drained, the request completes and the answer lands.
  const { stream, seen } = source([600, 600, 600, 600, 600, 600]);
  const result = await readCapped(stream, 1000);
  assert.deepEqual(result, { ok: false, reason: 'too-large' });
  assert.equal(seen.cancelled, false, 'a body under the ceiling must be drained, not cancelled');
  assert.equal(seen.pulled, 6, 'every chunk is read (and thrown away)');
});

test('past the drain ceiling, the stream IS cancelled and nothing further is pulled', async () => {
  const { stream, seen } = source([600, 600, 600, 600, 600, 600, 600, 600]);
  const result = await readCapped(stream, 1000, { drainCeilingBytes: 2000 });
  assert.deepEqual(result, { ok: false, reason: 'too-large' });
  assert.equal(seen.cancelled, true, 'past the ceiling the upload must be stopped');
  assert.ok(seen.pulled <= 5, `pulled ${seen.pulled} chunks after the ceiling was passed`);
});

test('the drain ceiling defaults to 16 MB, and can never refuse a body within the cap', async () => {
  assert.equal(DRAIN_CEILING_BYTES, 16 * 1024 * 1024);
  // The ceiling is consulted only past the cap: below it, it just means "no drain".
  assert.ok((await readCapped(source([500, 500]).stream, 1000, { drainCeilingBytes: 10 })).ok);
  const { stream, seen } = source([600, 600, 600]);
  assert.deepEqual(await readCapped(stream, 1000, { drainCeilingBytes: 10 }), { ok: false, reason: 'too-large' });
  assert.equal(seen.cancelled, true, 'a ceiling below the cap cancels at the cap');
});

test('the WHOLE read has a deadline: a body that stalls is cancelled and reads as too-slow', async () => {
  assert.equal(READ_DEADLINE_MS, 30_000, 'below Firebase Hosting’s 60 s ceiling');
  let cancelled = false;
  const stalled = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(10));
    },
    cancel() {
      cancelled = true;
    },
  });
  const started = Date.now();
  assert.deepEqual(await readCapped(stalled, 1000, { deadlineMs: 40 }), { ok: false, reason: 'too-slow' });
  const took = Date.now() - started;
  assert.ok(took >= 30 && took < 2000, `the deadline fired after ${took} ms`);
  assert.equal(cancelled, true);
});

test('a trickle that keeps sending is still cut at the deadline — it bounds the whole read, not each chunk', async () => {
  let cancelled = false;
  const trickle = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  assert.deepEqual(await readCapped(trickle, 1_000_000, { deadlineMs: 60 }), { ok: false, reason: 'too-slow' });
  assert.equal(cancelled, true);
});

test('a deadline that fires while DRAINING an over-cap body answers too-large — the more useful reason', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(2000)); // over the cap at once, then nothing
    },
  });
  assert.deepEqual(await readCapped(stream, 1000, { deadlineMs: 30 }), { ok: false, reason: 'too-large' });
});

test('a stream error is THROWN to the caller (it answers 500), never read as a short body', async () => {
  const broken = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new TypeError('terminated'));
    },
  });
  await assert.rejects(readCapped(broken, 1000), TypeError);
});

test('a read that finishes in time leaves no timer behind (the deadline is cleared)', async () => {
  // If the timer leaked, node:test would wait READ_DEADLINE_MS before exiting;
  // this read uses the default deadline on purpose.
  assert.ok((await readCapped(source([1, 2, 3]).stream, 10)).ok);
});

test('a request without a body reads as zero bytes', async () => {
  const result = await readCapped(null, 10);
  assert.ok(result.ok);
  assert.equal(result.bytes.length, 0);
});

test('it reads a real Request body, and leaves it used', async () => {
  const request = new Request('http://localhost/x', { method: 'POST', body: new Uint8Array(42) });
  const result = await readCapped(request.body, 100);
  assert.ok(result.ok);
  assert.equal(result.bytes.length, 42);
  assert.equal(request.bodyUsed, true);
});
