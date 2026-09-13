/**
 * QR tags: the Firestore layer, client-side under `firestore.rules`.
 *
 * The boundary is the `qrTokens` block: public `get`, admin-only `list`,
 * admin-only create in exactly the shape written below, a revoke that may set
 * `revokedAt` once and nothing else, and no delete. `AdminGate` is UX, not
 * authorization.
 *
 * ⚠️ Those rules are NOT DEPLOYED as of the branch that adds this file. Until a
 * human runs the Firestore rules deploy, every call here fails with
 * `permission-denied` — the default-deny at the bottom of the rules is what
 * answers. Nothing is broken; the collection simply does not exist yet.
 *
 * No index is needed. `petId ==` and `revokedAt == null` are single-field
 * equality filters, which Firestore indexes automatically, and ordering is done
 * here in memory on a handful of documents rather than with an `orderBy` that
 * WOULD demand a composite index.
 */

import {
  Timestamp,
  collection,
  doc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  where,
  type FieldValue,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';

import { getFirebase } from './firebase-client';
import { mintUniqueToken, normalizeQrToken } from './qr-tokens';
import type { QrToken } from './types';

/**
 * The exact document a create writes. Typed against `QrToken` for the same
 * reason `PetDocumentWrite` exists: a field added to the interface must fail
 * the build here rather than produce a document without it. The rules'
 * `hasOnly` list is the other half of the same contract.
 */
type QrTokenCreateWrite = Omit<QrToken, 'token' | 'createdAt' | 'revokedAt'> & {
  revokedAt: null;
  createdAt: FieldValue;
};

/** The only update the rules permit. */
type QrTokenRevokeWrite = { [K in keyof Pick<QrToken, 'revokedAt'>]: FieldValue };

/** What a caller gets back — epoch ms, so the pure layer needs no Timestamp. */
export interface QrTokenView {
  token: string;
  petId: string;
  revokedAt: number | null;
  createdAt: number | null;
  createdBy: string;
}

function millis(value: unknown): number | null {
  return value instanceof Timestamp ? value.toMillis() : null;
}

function toView(id: string, data: Record<string, unknown>): QrTokenView {
  return {
    token: id,
    petId: typeof data.petId === 'string' ? data.petId : '',
    // A revoke written with serverTimestamp() reads back as null for an
    // instant in a pending local snapshot. Anything that is not an explicit
    // null is treated as revoked, never as active — the same fail-closed rule
    // as `tokenRecordFrom` on the server.
    revokedAt: data.revokedAt === null ? null : (millis(data.revokedAt) ?? 0),
    createdAt: millis(data.createdAt),
    createdBy: typeof data.createdBy === 'string' ? data.createdBy : '',
  };
}

const newestFirst = (a: QrTokenView, b: QrTokenView) => (b.createdAt ?? 0) - (a.createdAt ?? 0);

/** Every tag ever issued for one animal, newest first. */
export async function listPetTokens(petId: string): Promise<QrTokenView[]> {
  const { db } = getFirebase();
  const snap = await getDocs(query(collection(db, 'qrTokens'), where('petId', '==', petId)));
  return snap.docs.map((d) => toView(d.id, d.data())).sort(newestFirst);
}

/** Every tag that currently works, across all animals. For the print sheet. */
export async function listActiveTokens(): Promise<QrTokenView[]> {
  const { db } = getFirebase();
  const snap = await getDocs(query(collection(db, 'qrTokens'), where('revokedAt', '==', null)));
  return snap.docs.map((d) => toView(d.id, d.data())).sort(newestFirst);
}

/**
 * Issue a tag for one animal, optionally revoking the tags it replaces IN THE
 * SAME TRANSACTION — so there is no moment where the animal has two working
 * tags, and none where a failed reissue leaves it with none.
 *
 * Create-if-absent: the transaction reads the candidate id first and refuses
 * if it exists; `mintUniqueToken` then tries a fresh one. The rules make the
 * other outcome impossible anyway — an existing token only accepts a revoke —
 * but a collision should retry, not surface as a permission error.
 *
 * ⚠️ All reads come before all writes: a Firestore client transaction that
 * reads after writing throws.
 */
export async function issueQrToken(
  petId: string,
  user: User,
  replacing: readonly string[] = [],
): Promise<string> {
  const { db } = getFirebase();

  return mintUniqueToken((token) =>
    runTransaction(db, async (tx) => {
      const ref = doc(db, 'qrTokens', token);
      const oldRefs = replacing.map((old) => doc(db, 'qrTokens', old));

      const [candidate, ...olds] = await Promise.all([tx.get(ref), ...oldRefs.map((r) => tx.get(r))]);
      if (candidate!.exists()) return false;

      olds.forEach((snap, i) => {
        const data = snap.data();
        // Only a tag that is really this animal's and really still active.
        if (snap.exists() && data?.revokedAt === null && data?.petId === petId) {
          const revoke: QrTokenRevokeWrite = { revokedAt: serverTimestamp() };
          tx.update(oldRefs[i]!, revoke);
        }
      });

      const write: QrTokenCreateWrite = {
        petId,
        revokedAt: null,
        createdAt: serverTimestamp(),
        createdBy: user.uid,
      };
      tx.set(ref, write);
      return true;
    }),
  );
}

/**
 * Revoke one tag. Idempotent: revoking a tag that is already revoked does
 * nothing, which is also the only thing the rules would allow — a second
 * revoke would rewrite the date the tag stopped working, and is refused.
 */
export async function revokeQrToken(token: string): Promise<void> {
  const canonical = normalizeQrToken(token);
  if (!canonical) throw new Error('revokeQrToken: not a well-formed token');
  const { db } = getFirebase();
  await runTransaction(db, async (tx) => {
    const ref = doc(db, 'qrTokens', canonical);
    const snap = await tx.get(ref);
    if (!snap.exists() || snap.data().revokedAt !== null) return;
    const revoke: QrTokenRevokeWrite = { revokedAt: serverTimestamp() };
    tx.update(ref, revoke);
  });
}
