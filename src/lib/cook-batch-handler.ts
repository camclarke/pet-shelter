/**
 * POST /api/food/cook-batch — the whole handler, with its I/O injected.
 *
 * No `server-only`, no Firebase import: the route passes in token verification
 * and the Admin SDK write, so every branch below is unit-tested with fakes.
 * Same split as `areas.ts` / `areas-admin.ts`.
 *
 * ═══ WHY COOK BATCHES ARE CREATED ON THE SERVER ═════════════════════════════
 * The toxic-ingredient acknowledgement is the one safety gate in the food
 * module (a toxic food named as a pot input blocks until someone ticks that
 * they checked it). Until 2026-09-13 it ran only in the browser, and the
 * independent evaluation proved with the Rules test API that the
 * `cookBatches` create rule accepted an unacknowledged toxic input.
 *
 * It cannot be enforced soundly in `firestore.rules`:
 *   - toxicity is derived from the input's FREE-TEXT label by a word list
 *     that folds accents, needs letter-aware boundaries and honours "sin
 *     cebolla" (`food-safety.ts`). Rules have no Unicode folding and their
 *     regex boundaries are ASCII, so a rules copy would disagree with the
 *     screen — refusing batches the screen allowed, or the reverse;
 *   - inputs name a CATEGORY, not a stock entry, so there is no stored hazard
 *     flag a `get()` could read;
 *   - a rules check could therefore only trust a toxic flag the client copied
 *     in, which catches a UI bug but not a falsified flag.
 *
 * So the rule denies client create outright, and this handler runs the SAME
 * pure `validateCookBatch` the screen runs, on the server, before the Admin SDK
 * writes the batch and its `cook` ledger entries in one atomic batch. The gate
 * now holds whatever the client does.
 *
 * ⚠️ The route sits OUTSIDE `firestore.rules` and the Admin SDK bypasses them,
 * so this handler is the entire boundary: it verifies the ID token and the
 * admin claim with `checkRevoked`, answers 401 before anything else, validates
 * the body's shape as well as its content, and attributes the write from the
 * VERIFIED token — never from the body.
 */

import {
  MAX_INPUTS_PER_BATCH,
  cookInputGrams,
  cookOutcomeValues,
  isFoodCategory,
  validateCookBatch,
  type CookBatchDraft,
  type CookBatchError,
  type CookInputDraft,
} from './food-stock';
import type { CookBatchInput, FoodCategory } from './types';

/** Stamped on every failure this handler generates — see `SUGGEST_FAILURE_HEADER`. */
export const COOK_BATCH_FAILURE_HEADER = 'X-Cook-Batch-Failure';

/** What the Admin SDK writes. Epoch ms and plain values; the route converts. */
export interface CookBatchPlan {
  cookedAtMs: number;
  inputs: CookBatchInput[];
  potFillLevel: number | null;
  cookedWeightG: number | null;
  ladlesYielded: number | null;
  dogsServed: number | null;
  cookedBy: string | null;
  notes: string | null;
  recordedBy: string;
  /** One NEGATIVE ledger entry per input. The writer sets `sourceId` to the batch id. */
  entries: { category: FoodCategory; label: string; deltaG: number; occurredAtMs: number }[];
}

export interface VerifiedToken {
  uid: string;
  email?: string | null;
  admin?: unknown;
}

export interface CookBatchDeps {
  verifyIdToken: (token: string, checkRevoked: boolean) => Promise<VerifiedToken>;
  commit: (plan: CookBatchPlan) => Promise<string>;
  now?: () => number;
  log?: (message: string, err?: unknown) => void;
}

const LABEL_MAX = 80;
const NUMBER_TEXT_MAX = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, max: number): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= max);
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

/**
 * The request body as a `CookBatchDraft`, or null if it is not one.
 *
 * The validator assumes well-typed input; a raw body is not. So SHAPE is
 * checked here — including that a category is one the pantry knows, which the
 * validator (built for a `<select>`) never had to check, and which the rules
 * used to enforce through the ledger path. Unknown keys, such as a
 * `recordedBy` the caller made up, are ignored.
 */
export function parseCookBatchBody(body: unknown): CookBatchDraft | null {
  if (!isRecord(body)) return null;
  const { cookedAt, inputs, potFillLevel, cookedKgText, ladlesText, dogsServedText, cookedBy, notes } = body;

  if (!(cookedAt === null || (typeof cookedAt === 'number' && Number.isFinite(cookedAt)))) return null;
  if (!Array.isArray(inputs) || inputs.length > MAX_INPUTS_PER_BATCH) return null;
  if (!(potFillLevel === null || (typeof potFillLevel === 'number' && Number.isFinite(potFillLevel)))) return null;
  if (!boundedString(cookedKgText, NUMBER_TEXT_MAX)) return null;
  if (!boundedString(ladlesText, NUMBER_TEXT_MAX)) return null;
  if (!boundedString(dogsServedText, NUMBER_TEXT_MAX)) return null;
  if (!optionalString(cookedBy, 80) || !optionalString(notes, 1000)) return null;

  const parsed: CookInputDraft[] = [];
  for (const input of inputs) {
    if (!isRecord(input)) return null;
    const { category, label, kgText, toxicAcknowledged } = input;
    if (!(category === null || isFoodCategory(category))) return null;
    if (!boundedString(label, LABEL_MAX) || !boundedString(kgText, NUMBER_TEXT_MAX)) return null;
    if (typeof toxicAcknowledged !== 'boolean') return null;
    parsed.push({ category, label, kgText, toxicAcknowledged });
  }

  return { cookedAt, inputs: parsed, potFillLevel, cookedKgText, ladlesText, dogsServedText, cookedBy, notes };
}

/**
 * Validate with the SAME rules the screen uses, then describe the write.
 * Errors — the toxic acknowledgement among them — mean nothing is written.
 */
export function planCookBatch(
  draft: CookBatchDraft,
  recordedBy: string,
  now: number
): { errors: CookBatchError[] } | { plan: CookBatchPlan } {
  const errors = validateCookBatch(draft, now);
  if (errors.length > 0 || draft.cookedAt === null) return { errors };

  const cookedAtMs = draft.cookedAt;
  const inputs: CookBatchInput[] = draft.inputs.map((input) => ({
    category: input.category!,
    label: input.label.trim().slice(0, LABEL_MAX),
    rawG: cookInputGrams(input)!,
  }));

  return {
    plan: {
      cookedAtMs,
      inputs,
      ...cookOutcomeValues(draft),
      recordedBy,
      entries: inputs.map((input) => ({
        category: input.category,
        label: input.label,
        deltaG: -input.rawG,
        occurredAtMs: cookedAtMs,
      })),
    },
  };
}

function respond(status: number, body: Record<string, unknown>, failure?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (failure) headers[COOK_BATCH_FAILURE_HEADER] = failure;
  return new Response(JSON.stringify(body), { status, headers });
}

function fail(error: string, status: number, extra: Record<string, unknown> = {}): Response {
  return respond(status, { error, ...extra }, error);
}

export async function handleCookBatchPost(request: Request, deps: CookBatchDeps): Promise<Response> {
  // ── 1. authenticate, before anything else ─────────────────────────────────
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return fail('unauthenticated', 401);

  let decoded: VerifiedToken;
  try {
    // checkRevoked: a revoked admin loses this write immediately, not in an hour.
    decoded = await deps.verifyIdToken(token, true);
  } catch {
    return fail('unauthenticated', 401);
  }
  if (decoded.admin !== true) return fail('forbidden', 403);

  // ── 2. the body ───────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail('body-unreadable', 400);
  }
  const draft = parseCookBatchBody(body);
  if (draft === null) return fail('body-invalid', 400);

  // ── 3. the same validator the screen runs, toxic gate included ────────────
  // Attribution comes from the verified token: email when it has one, else uid.
  const author = decoded.email || decoded.uid;
  const planned = planCookBatch(draft, author, (deps.now ?? Date.now)());
  if ('errors' in planned) return fail('batch-invalid', 422, { errors: planned.errors });

  // ── 4. one atomic Admin SDK batch ─────────────────────────────────────────
  try {
    const id = await deps.commit(planned.plan);
    return respond(200, { id });
  } catch (err) {
    deps.log?.('[cook-batch] write failed', err);
    return fail('write-failed', 500);
  }
}
