import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import { getAdminDb, verifyAdminIdToken } from '@/lib/firebase-admin';
import { handleCookBatchPost, type CookBatchPlan } from '@/lib/cook-batch-handler';
import type { CookBatch, StockEntry } from '@/lib/types';

/**
 * POST /api/food/cook-batch — the ONLY way a cook batch is created.
 *
 * `firestore.rules` denies client create of `cookBatches` and of `cook` ledger
 * entries, so the toxic-ingredient gate cannot be skipped by a client. Read
 * `src/lib/cook-batch-handler.ts` for why the gate lives here rather than in
 * the rules. Everything that decides is there and tested; this file only
 * supplies the Admin SDK.
 *
 * ⚠️ Outside the rules, and the Admin SDK bypasses them: the handler verifies
 * the token, the admin claim (`checkRevoked`) and the body itself.
 */

export const runtime = 'nodejs';
// A POST with an auth header and a per-request body. Never prerendered or
// cached; `revalidate` would be inert here, so it is not set.
export const dynamic = 'force-dynamic';

/**
 * Typed against `CookBatch` and `StockEntry`, so a field added to either
 * interface fails the typecheck here instead of producing a document without
 * it. Timestamps are the Admin SDK's own.
 */
type AdminCookBatchWrite = Omit<CookBatch, 'id' | 'cookedAt' | 'createdAt' | 'updatedAt'> & {
  cookedAt: Timestamp;
  createdAt: FieldValue;
  updatedAt: FieldValue;
};

type AdminStockEntryWrite = Omit<StockEntry, 'id' | 'occurredAt' | 'recordedAt' | 'expiresAt'> & {
  occurredAt: Timestamp;
  recordedAt: FieldValue;
  expiresAt: null;
};

async function commit(plan: CookBatchPlan): Promise<string> {
  const db = getAdminDb();
  const batchRef = db.collection('cookBatches').doc();
  const writes = db.batch();

  const record: AdminCookBatchWrite = {
    cookedAt: Timestamp.fromMillis(plan.cookedAtMs),
    inputs: plan.inputs,
    potFillLevel: plan.potFillLevel,
    cookedWeightG: plan.cookedWeightG,
    ladlesYielded: plan.ladlesYielded,
    dogsServed: plan.dogsServed,
    cookedBy: plan.cookedBy,
    notes: plan.notes,
    recordedBy: plan.recordedBy,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  writes.set(batchRef, record);

  for (const entry of plan.entries) {
    const ledger: AdminStockEntryWrite = {
      kind: 'cook',
      category: entry.category,
      label: entry.label,
      deltaG: entry.deltaG,
      occurredAt: Timestamp.fromMillis(entry.occurredAtMs),
      recordedAt: FieldValue.serverTimestamp(),
      expiresAt: null,
      sourceId: batchRef.id,
      note: null,
      recordedBy: plan.recordedBy,
    };
    writes.set(db.collection('foodStock').doc(entry.category).collection('stockEntries').doc(), ledger);
  }

  await writes.commit();
  return batchRef.id;
}

export async function POST(request: Request): Promise<Response> {
  return handleCookBatchPost(request, {
    verifyIdToken: verifyAdminIdToken,
    commit,
    log: (message, err) => console.warn(message, err),
  });
}
