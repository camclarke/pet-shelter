/**
 * Read a request body as bytes, refusing it the moment it passes a cap, and
 * refusing a body that takes too long. Pure: takes a stream, not a request.
 *
 * ═══ WHY NOT `request.arrayBuffer()` ════════════════════════════════════════
 * `arrayBuffer()`, `blob()`, `text()`, `json()` and `formData()` all buffer the
 * WHOLE body before returning, so a cap checked afterwards caps nothing: a
 * 500 MB POST is held in memory first. A `Content-Length` header cannot stand
 * in either — it is optional (HTTP/2, chunked uploads) and whether Firebase
 * Hosting forwards it to Cloud Run is unmeasured (critic 2026-10-16, #7). So
 * the cap is enforced HERE, chunk by chunk, and `require-admin.test.ts` fails
 * if an upload route reads its body any other way.
 *
 * ═══ OVER THE CAP: DRAIN AND DISCARD, THEN CLOSE ════════════════════════════
 * The first version CANCELLED the stream at the cap. Measured 2026-10-16 with
 * a real Node server building the body the way Next 16 does (undici's stream
 * over the `IncomingMessage`): cancel DESTROYS the IncomingMessage but leaves
 * its socket open and detached, and the client never saw the 413 in 5 of 10
 * runs — it hung until its own timeout (`.claude/review-4b/cancel-experiment.ts`).
 * So past the cap nothing more is KEPT, but the rest is still READ and thrown
 * away, up to `drainCeilingBytes`; the route then answers with
 * `Connection: close`. Drained, the client got its 413 in 10 of 10 runs at
 * every size up to the ceiling; past it the stream is cancelled after all,
 * and the client sees a connection error at once rather than a hang
 * (`.claude/review-4b/overflow-fix-experiment.ts`). Memory stays bounded:
 * discarded chunks are never held.
 *
 * ═══ A DEADLINE ON THE WHOLE READ ═══════════════════════════════════════════
 * A client trickling one byte a second would hold a request (and its Cloud
 * Run concurrency slot) open indefinitely. `deadlineMs` bounds the entire
 * read, drain included, below Firebase Hosting's 60 s ceiling: 30 s carries a
 * full-size photo at ~420 kbps. Past it the stream is cancelled and the read
 * answers `too-slow` — or `too-large`, if it was already over the cap.
 *
 * An error the STREAM raises (the client disconnected mid-upload) is thrown
 * to the caller, which answers 500 and logs the error's name only.
 */

/** The whole read, drain included. Below Firebase Hosting's 60 s request ceiling. */
export const READ_DEADLINE_MS = 30_000;

/**
 * How much of an over-cap body is read and discarded before giving up on a
 * clean answer. A phone's raw camera file — the likeliest oversize upload, a
 * resize that did not happen — is under 16 MB.
 */
export const DRAIN_CEILING_BYTES = 16 * 1024 * 1024;

export type CappedRead =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'too-large' | 'too-slow' };

export interface ReadCappedOptions {
  /** Default `READ_DEADLINE_MS`. */
  deadlineMs?: number;
  /** Default `DRAIN_CEILING_BYTES`. Below `maxBytes` it means: cancel at the cap, no drain. */
  drainCeilingBytes?: number;
}

const EXPIRED = Symbol('expired');

/**
 * @param stream `request.body` — null for a request without one, which reads
 *   as zero bytes (the caller decides whether empty is acceptable).
 * @param maxBytes inclusive: exactly `maxBytes` is accepted, one more is not.
 */
export async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  options: ReadCappedOptions = {},
): Promise<CappedRead> {
  if (stream === null) return { ok: true, bytes: new Uint8Array(0) };

  const deadlineMs = options.deadlineMs ?? READ_DEADLINE_MS;
  // Only ever consulted once past `maxBytes`, so a ceiling below the cap just
  // means "do not drain" — it can never refuse a body within the cap.
  const ceiling = options.drainCeilingBytes ?? DRAIN_CEILING_BYTES;

  const reader = stream.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    timer = setTimeout(() => resolve(EXPIRED), deadlineMs);
  });

  const chunks: Uint8Array[] = [];
  let total = 0;
  let over = false;
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), expired]);
      if (next === EXPIRED) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: over ? 'too-large' : 'too-slow' };
      }
      if (next.done) break;
      total += next.value.byteLength;
      if (!over && total > maxBytes) {
        // Nothing read so far is kept; the rest is read only to be dropped.
        over = true;
        chunks.length = 0;
      }
      if (over) {
        if (total > ceiling) {
          await reader.cancel().catch(() => undefined);
          return { ok: false, reason: 'too-large' };
        }
        continue;
      }
      chunks.push(next.value);
    }
  } finally {
    clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      // Already released by a cancel: nothing to do.
    }
  }

  if (over) return { ok: false, reason: 'too-large' };
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { ok: true, bytes };
}
