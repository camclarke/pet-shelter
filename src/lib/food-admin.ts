/**
 * Food: the Firestore layer, client-side under `firestore.rules`.
 *
 * Every write here is ADMIN-only by rule, and `AdminGate` is UX, not
 * authorization. Build-order step 13.
 *
 * ⚠️ The rules for these collections are written and tested against the Rules
 * test API (`npm run probe:food-rules`) but NOT deployed. Until a human runs
 * `firebase deploy --only firestore:rules`, every call below meets
 * default-deny and fails with `permission-denied`.
 *
 * ── Shapes are typed against `types.ts` ──────────────────────────────────────
 * Each write is annotated (`DonationWrite`, `StockEntryWrite`, …) for the reason
 * `PetDocumentWrite` exists: an untyped object literal lets a field added to
 * the interface produce a green typecheck and a document without it. The rules
 * refuse any key they do not list, so a drift between the two is a refused
 * write rather than a silent one.
 *
 * ── No index is needed ──────────────────────────────────────────────────────
 * Stock per category is an UNFILTERED `sum()` over
 * `foodStock/{category}/stockEntries`; every list is a single-field ordering
 * on one collection; the present animals are one `in` filter on `status`. All
 * are covered by Firestore's automatic indexes — the flat, filtered alternative
 * was measured demanding a composite on 2026-09-12.
 */

import {
  Timestamp,
  collection,
  doc,
  getAggregateFromServer,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  sum,
  updateDoc,
  where,
  writeBatch,
  type FieldValue,
  type Firestore,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';

import { SHELTER } from '@/config/shelter';
import { getFirebase } from './firebase-client';
import { STATUSES_INSIDE_FACILITY } from './arrival';
import { DONATION_TEXT_MAX_CHARS, donationWrite, reviewDonation, type DonationDraft } from './food-parse';
import {
  FOOD_CATEGORIES,
  cookInputGrams,
  cookOutcomeValues,
  isFeedingLogId,
  stockMovementDeltaG,
  validateCookBatch,
  validateCookOutcome,
  validateStockMovement,
  type CookBatchDraft,
  type CookOutcomeDraft,
  type StockMovementDraft,
} from './food-stock';
import type {
  CookBatch,
  CookBatchInput,
  FeedingLog,
  FeedingServing,
  FoodCategory,
  FoodDonation,
  FoodDonationLine,
  Pet,
  StockEntry,
  StockEntryKind,
} from './types';

type DonationWrite = Omit<FoodDonation, 'id' | 'createdAt' | 'updatedAt'> & {
  createdAt: FieldValue;
  updatedAt: FieldValue;
};
type StockEntryWrite = Omit<StockEntry, 'id' | 'recordedAt'> & { recordedAt: FieldValue };
type CookBatchWrite = Omit<CookBatch, 'id' | 'createdAt' | 'updatedAt'> & {
  createdAt: FieldValue;
  updatedAt: FieldValue;
};
type FeedingLogWrite = Omit<FeedingLog, 'updatedAt'> & { updatedAt: FieldValue };

/** Mirrors `isCaller()` in the rules: email when the account has one, else uid. */
export function authorOf(user: User): string {
  return user.email ?? user.uid;
}

function toMillis(value: unknown): number | null {
  return value instanceof Timestamp ? value.toMillis() : null;
}

function fromMillis(ms: number | null): Timestamp | null {
  return ms === null ? null : Timestamp.fromMillis(ms);
}

function stockEntries(db: Firestore, category: FoodCategory) {
  return collection(db, 'foodStock', category, 'stockEntries');
}

// ─────────────────────────────────────────────────────────────────────────────
// Donations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Save a reviewed donation and its stock additions in ONE batch, so a donation
 * with half its lines stocked is not a state that can exist.
 *
 * ⚠️ `draft.receivedAt` must already be an instant from `dayToInstant`, not a
 * raw midday — see that function for the morning-of-today trap.
 */
export async function saveDonation(draft: DonationDraft, user: User): Promise<string> {
  // Re-reviewed here, not trusted from the screen: `donationWrite` throws on an
  // invalid review, which is the backstop for a caller that forgot to check.
  const review = reviewDonation(draft, SHELTER.species);
  const { lines, additions } = donationWrite(draft, review);
  const receivedAt = draft.receivedAt!;

  const { db } = getFirebase();
  const batch = writeBatch(db);
  const donationRef = doc(collection(db, 'foodDonations'));
  const author = authorOf(user);

  const donation: DonationWrite = {
    donor: draft.donor?.trim() || null,
    receivedAt: Timestamp.fromMillis(receivedAt),
    rawText: draft.rawText.slice(0, DONATION_TEXT_MAX_CHARS),
    lines: lines.map(
      (line): FoodDonationLine => ({ ...line, expiresAt: fromMillis(line.expiresAt) })
    ),
    source: draft.source,
    extractedByModel: draft.source === 'llm-parsed' ? draft.modelKey : null,
    notes: draft.notes?.trim() || null,
    recordedBy: author,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  batch.set(donationRef, donation);

  for (const addition of additions) {
    const entry: StockEntryWrite = {
      kind: 'donation',
      category: addition.category,
      label: addition.label,
      deltaG: addition.deltaG,
      occurredAt: Timestamp.fromMillis(receivedAt),
      recordedAt: serverTimestamp(),
      expiresAt: fromMillis(addition.expiresAt),
      sourceId: donationRef.id,
      note: null,
      recordedBy: author,
    };
    batch.set(doc(stockEntries(db, addition.category)), entry);
  }

  await batch.commit();
  return donationRef.id;
}

export interface DonationView {
  id: string;
  donor: string | null;
  receivedAt: number;
  rawText: string;
  lines: (Omit<FoodDonationLine, 'expiresAt'> & { expiresAt: number | null })[];
  source: 'manual' | 'llm-parsed';
  notes: string | null;
  recordedBy: string;
}

export async function listRecentDonations(max = 20): Promise<DonationView[]> {
  const { db } = getFirebase();
  const snap = await getDocs(query(collection(db, 'foodDonations'), orderBy('receivedAt', 'desc'), limit(max)));
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      donor: data.donor ?? null,
      receivedAt: toMillis(data.receivedAt) ?? 0,
      rawText: data.rawText ?? '',
      lines: (Array.isArray(data.lines) ? data.lines : []).map((line: Record<string, unknown>) => ({
        ...(line as unknown as FoodDonationLine),
        expiresAt: toMillis(line.expiresAt),
      })),
      source: data.source === 'manual' ? 'manual' : 'llm-parsed',
      notes: data.notes ?? null,
      recordedBy: data.recordedBy ?? '',
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Stock
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Grams per category, as eight server-side sums.
 *
 * ⚠️ Rejects if ANY category fails. It never returns a partial map with the
 * failed category as 0: "0 kg de arroz" and "no pudimos leer el arroz" are
 * different sentences, and the second rendered as the first is this project's
 * most repeated failure. An empty category genuinely sums to 0 — measured.
 */
export async function readStock(): Promise<Record<FoodCategory, number>> {
  const { db } = getFirebase();
  const totals = await Promise.all(
    FOOD_CATEGORIES.map(async (category) => {
      const snap = await getAggregateFromServer(stockEntries(db, category), { total: sum('deltaG') });
      const total = snap.data().total;
      return [category, typeof total === 'number' ? total : 0] as const;
    })
  );
  return Object.fromEntries(totals) as Record<FoodCategory, number>;
}

export interface StockEntryView {
  id: string;
  kind: StockEntryKind;
  category: FoodCategory;
  label: string;
  deltaG: number;
  occurredAt: number;
  expiresAt: number | null;
  note: string | null;
  recordedBy: string;
}

export async function listMovements(category: FoodCategory, max = 15): Promise<StockEntryView[]> {
  const { db } = getFirebase();
  const snap = await getDocs(query(stockEntries(db, category), orderBy('occurredAt', 'desc'), limit(max)));
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      kind: data.kind,
      category,
      label: data.label ?? '',
      deltaG: typeof data.deltaG === 'number' ? data.deltaG : 0,
      occurredAt: toMillis(data.occurredAt) ?? 0,
      expiresAt: toMillis(data.expiresAt),
      note: data.note ?? null,
      recordedBy: data.recordedBy ?? '',
    };
  });
}

/** A discard or a correction. `draft.occurredAt` must come from `dayToInstant`. */
export async function recordStockMovement(draft: StockMovementDraft, user: User): Promise<void> {
  const errors = validateStockMovement(draft);
  const deltaG = stockMovementDeltaG(draft);
  if (errors.length > 0 || deltaG === null || draft.category === null || draft.occurredAt === null) {
    throw new Error(`food-admin: invalid movement (${errors.join(', ')})`);
  }
  const { db } = getFirebase();
  const entry: StockEntryWrite = {
    kind: draft.kind,
    category: draft.category,
    label: draft.label.trim().slice(0, 80),
    deltaG,
    occurredAt: Timestamp.fromMillis(draft.occurredAt),
    recordedAt: serverTimestamp(),
    expiresAt: null,
    sourceId: null,
    note: draft.note?.trim() || null,
    recordedBy: authorOf(user),
  };
  await setDoc(doc(stockEntries(db, draft.category)), entry);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cook batches
// ─────────────────────────────────────────────────────────────────────────────

/** The batch and one negative ledger entry per input, in ONE batch. */
export async function saveCookBatch(draft: CookBatchDraft, user: User): Promise<string> {
  const errors = validateCookBatch(draft);
  if (errors.length > 0 || draft.cookedAt === null) {
    throw new Error(`food-admin: invalid cook batch (${errors.map((e) => e.kind).join(', ')})`);
  }
  const inputs: CookBatchInput[] = draft.inputs.map((input) => ({
    category: input.category!,
    label: input.label.trim().slice(0, 80),
    rawG: cookInputGrams(input)!,
  }));

  const { db } = getFirebase();
  const batch = writeBatch(db);
  const batchRef = doc(collection(db, 'cookBatches'));
  const author = authorOf(user);

  const record: CookBatchWrite = {
    cookedAt: Timestamp.fromMillis(draft.cookedAt),
    inputs,
    ...cookOutcomeValues(draft),
    recordedBy: author,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  batch.set(batchRef, record);

  for (const input of inputs) {
    const entry: StockEntryWrite = {
      kind: 'cook',
      category: input.category,
      label: input.label,
      deltaG: -input.rawG,
      occurredAt: Timestamp.fromMillis(draft.cookedAt),
      recordedAt: serverTimestamp(),
      expiresAt: null,
      sourceId: batchRef.id,
      note: null,
      recordedBy: author,
    };
    batch.set(doc(stockEntries(db, input.category)), entry);
  }

  await batch.commit();
  return batchRef.id;
}

/**
 * Record what the pot turned out to be. The inputs are untouched — the rules
 * refuse any change to them — because they have already moved the stock.
 */
export async function updateCookOutcome(batchId: string, draft: CookOutcomeDraft): Promise<void> {
  const errors = validateCookOutcome(draft);
  if (errors.length > 0) throw new Error(`food-admin: invalid outcome (${errors.map((e) => e.kind).join(', ')})`);
  const { db } = getFirebase();
  await updateDoc(doc(db, 'cookBatches', batchId), {
    ...cookOutcomeValues(draft),
    updatedAt: serverTimestamp(),
  });
}

export interface CookBatchView {
  id: string;
  cookedAt: number;
  inputs: CookBatchInput[];
  potFillLevel: number | null;
  cookedWeightG: number | null;
  ladlesYielded: number | null;
  dogsServed: number | null;
  cookedBy: string | null;
  notes: string | null;
  recordedBy: string;
}

export async function listCookBatches(max = 60): Promise<CookBatchView[]> {
  const { db } = getFirebase();
  const snap = await getDocs(query(collection(db, 'cookBatches'), orderBy('cookedAt', 'desc'), limit(max)));
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      cookedAt: toMillis(data.cookedAt) ?? 0,
      inputs: Array.isArray(data.inputs) ? (data.inputs as CookBatchInput[]) : [],
      potFillLevel: num(data.potFillLevel),
      cookedWeightG: num(data.cookedWeightG),
      ladlesYielded: num(data.ladlesYielded),
      dogsServed: num(data.dogsServed),
      cookedBy: data.cookedBy ?? null,
      notes: data.notes ?? null,
      recordedBy: data.recordedBy ?? '',
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The day
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Animals physically in the facility — the same statuses that should have an
 * open placement. A fostered animal eats in its foster home, not from this pot.
 */
export async function listPresentAnimals(): Promise<Pet[]> {
  const { db } = getFirebase();
  const snap = await getDocs(
    query(collection(db, 'pets'), where('status', 'in', [...STATUSES_INSIDE_FACILITY]))
  );
  return snap.docs
    .map((d) => ({ ...(d.data() as Omit<Pet, 'id'>), id: d.id }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

export interface FeedingLogView {
  date: string;
  batchIds: string[];
  servings: FeedingServing[];
  dogsPresent: number | null;
  shortfallNote: string | null;
  updatedBy: string;
}

export async function readFeedingLog(date: string): Promise<FeedingLogView | null> {
  const { db } = getFirebase();
  const snap = await getDoc(doc(db, 'feedingLog', date));
  if (!snap.exists()) return null;
  const data = snap.data();
  return {
    date,
    batchIds: Array.isArray(data.batchIds) ? data.batchIds : [],
    servings: Array.isArray(data.servings) ? data.servings : [],
    dogsPresent: typeof data.dogsPresent === 'number' ? data.dogsPresent : null,
    shortfallNote: data.shortfallNote ?? null,
    updatedBy: data.updatedBy ?? '',
  };
}

export async function saveFeedingLog(
  log: Omit<FeedingLogView, 'updatedBy'>,
  user: User
): Promise<void> {
  if (!isFeedingLogId(log.date)) throw new Error(`food-admin: invalid feeding log date ${log.date}`);
  const { db } = getFirebase();
  const record: FeedingLogWrite = {
    date: log.date,
    batchIds: log.batchIds.slice(0, 10),
    servings: log.servings.slice(0, 200).map((s) => ({
      petId: s.petId,
      petName: s.petName,
      ladles: s.ladles,
      adjustedReason: s.adjustedReason?.trim() || null,
    })),
    dogsPresent: log.dogsPresent,
    shortfallNote: log.shortfallNote?.trim() || null,
    updatedBy: authorOf(user),
    updatedAt: serverTimestamp(),
  };
  await setDoc(doc(db, 'feedingLog', log.date), record);
}
