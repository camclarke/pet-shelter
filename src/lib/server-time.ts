/**
 * The boundary where a pure description of a write becomes a Firestore write.
 *
 * `applications.ts` describes writes with a `SERVER_TIME` marker so it can be
 * tested without importing Firebase. This swaps each marker for the real
 * `serverTimestamp()` sentinel — which it MUST, because the rules compare every
 * one of those fields against `request.time`, and a client clock would be
 * refused (and would be wrong: Firestore's clock measured 2.7 s ahead of this
 * machine on 2026-08-24).
 *
 * Top-level fields only, deliberately. No write in this feature nests a
 * timestamp, and a recursive walk would also descend into `answers` — a
 * private person's text, which nothing here has any reason to inspect.
 */

'use client';

import { doc, serverTimestamp, type DocumentData, type Firestore, type WriteBatch } from 'firebase/firestore';

import { isServerTime, type WriteOp } from './applications';

export function resolveServerTime(data: Readonly<Record<string, unknown>>): DocumentData {
  const out: DocumentData = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = isServerTime(value) ? serverTimestamp() : value;
  }
  return out;
}

/** Queue every described write onto a batch, in order. */
export function applyWriteOps(db: Firestore, batch: WriteBatch, writes: readonly WriteOp[]): void {
  for (const write of writes) {
    const [first, ...rest] = write.path;
    if (!first || rest.length % 2 !== 1) {
      throw new Error(`applyWriteOps: ${write.path.join('/')} is not a document path`);
    }
    const ref = doc(db, first, ...rest);
    const data = resolveServerTime(write.data);
    if (write.op === 'update') batch.update(ref, data);
    else batch.set(ref, data, { merge: write.merge });
  }
}
