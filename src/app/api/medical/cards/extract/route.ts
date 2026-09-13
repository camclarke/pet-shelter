import { NextResponse } from 'next/server';

import { getAdminAuth } from '@/lib/firebase-admin';
import { aiIsConfigured } from '@/lib/ai/google';
import { extractFromCard } from '@/lib/ai/card-extract';
import type { AiProcess } from '@/lib/ai/metered';
import { SUGGEST_TOTAL_BUDGET_MS, isTimeoutFailure } from '@/lib/ai/suggest-budget';
import { parseCardExtractRequest, reviewCardExtraction } from '@/lib/card-extraction';
import {
  CARD_FAILURE_HEADER,
  type CardExtractSuccess,
  type CardRouteError,
} from '@/lib/card-extract-client';
import {
  cardAlreadyExtracted,
  cardBucketName,
  petExists,
  readCardPhoto,
  writeCardCandidates,
} from '@/lib/medical-server';

/**
 * POST /api/medical/cards/extract — read a vaccination card, write CANDIDATES
 * for a person to review. Build-order step 9, plan §4.3–§4.8.
 *
 * Body: `{ petId, path }`, where `path` is a card photo the admin's browser
 * already uploaded to `medical/{petId}/card-{uuid}.jpg`.
 *
 * ═══ THIS ROUTE IS OUTSIDE `firestore.rules` AND `storage.rules` ════════════
 * It holds `GEMINI_API_KEY`, spends free-tier quota, and reads and writes
 * through the Admin SDK, which bypasses both rulesets. So it verifies the ID
 * token and the `admin` claim ITSELF, with `checkRevoked`, and that check is the
 * entire boundary. `AdminGate` runs in the browser and protects nothing here.
 *
 * ── What it deliberately does NOT do ─────────────────────────────────────────
 * It never writes a medical record. Every reading goes to the admin-only
 * `pets/{petId}/medicalCandidates`, and becomes a record in `medical` only
 * when a person confirms it (`confirmMedicalRecord`). A candidate carries no
 * `confirmedBy` field at all, so there is nothing here to set by accident.
 *
 * ── Failure direction: OPEN, toward typing the record by hand ───────────────
 * Every failure writes nothing and says why. The card photo is already stored,
 * so a retry does not need the phone to upload again.
 */

export const runtime = 'nodejs';
// A POST with an auth header and a per-request body: never prerendered, never
// cached. Stated so nobody has to infer it.
export const dynamic = 'force-dynamic';

/**
 * Every failure this route generates carries `X-Card-Failure`, and its
 * ABSENCE on a 5xx tells the browser the edge answered instead of us. See
 * `card-extract-client.ts`.
 */
function fail(error: CardRouteError, status: number): NextResponse {
  return NextResponse.json({ error }, { status, headers: { [CARD_FAILURE_HEADER]: error } });
}

/**
 * Which budget line this spend belongs to.
 *
 * ⚠️ Exists for ONE purpose: a local end-to-end probe of this real route must
 * meter as eval, never as the shelter's own usage. It honours exactly one
 * value and cannot tag production as anything else. Unset — as it is on Cloud
 * Run, whose env list Terraform owns and does not declare — the spend is
 * `card_extract`.
 */
function meteringProcess(): AiProcess {
  return process.env.CARD_EXTRACT_PROCESS === 'card_extract_eval'
    ? 'card_extract_eval'
    : 'card_extract';
}

export async function POST(request: Request): Promise<Response> {
  // Firebase Hosting's 60 s started when this request reached the edge. The
  // closest we can get is now, before any await — so the model's deadline is
  // counted from here, not from after the pet lookup and the Storage read.
  const arrivedAt = Date.now();

  // ── 1. authenticate — BEFORE the configured-check, so an unauthenticated
  //       caller learns nothing about whether the feature is switched on ──────
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return fail('unauthenticated', 401);

  let isAdmin = false;
  let reviewer = '';
  try {
    // checkRevoked: a revoked admin loses access immediately. The one-hour
    // claim lag cuts both ways, and on a path that spends and writes medical
    // data the strict side is the safe one.
    const decoded = await getAdminAuth().verifyIdToken(token, true);
    isAdmin = decoded.admin === true;
    reviewer = decoded.email?.trim() || decoded.uid;
  } catch {
    return fail('unauthenticated', 401);
  }
  if (!isAdmin) return fail('forbidden', 403);

  // ── 2. is the feature available ───────────────────────────────────────────
  if (!aiIsConfigured()) return fail('ai-not-configured', 503);
  if (!cardBucketName()) return fail('storage-not-configured', 503);

  // ── 3. the request ────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail('bad-request', 400);
  }
  // Holds the path to exactly `medical/{petId}/card-{uuid}.jpg`. The Admin SDK
  // could read ANY object — this is what stops it reading anything else.
  const parsed = parseCardExtractRequest(body);
  if (!parsed) return fail('bad-request', 400);
  const { petId, path } = parsed;

  const started = Date.now();
  let cardKb = 0;

  try {
    if (!(await petExists(petId))) return fail('pet-not-found', 404);

    // The fast path, before the model: an ordinary retry of a request whose
    // response was lost does not spend a second request. Not the guarantee —
    // see writeCardCandidates' create-if-absent ids below.
    if (await cardAlreadyExtracted(petId, path)) return fail('already-extracted', 409);

    const card = await readCardPhoto(path);
    if (card.kind === 'missing') return fail('card-not-found', 404);
    if (card.kind === 'too-large') return fail('card-too-large', 413);
    if (card.kind === 'unsupported') return fail('card-unsupported', 415);
    if (card.kind === 'not-configured') return fail('storage-not-configured', 503);
    cardKb = Math.round(card.bytes.byteLength / 1024);

    // ── 4. read the card ─────────────────────────────────────────────────────
    let extraction;
    try {
      extraction = await extractFromCard(
        { bytes: card.bytes, mediaType: card.mediaType },
        { process: meteringProcess(), deadline: arrivedAt + SUGGEST_TOTAL_BUDGET_MS }
      );
    } catch (err) {
      const elapsed = Date.now() - started;
      const name = err instanceof Error ? err.name : typeof err;
      console.warn(`[card-extract] failed after ${elapsed}ms card=${cardKb}KB error=${name}`);
      console.warn('[card-extract] failed', err);
      // A timeout is a different fact from a failure: the card is stored and
      // nothing is wrong with it, and trying again may well work.
      return isTimeoutFailure(err) ? fail('extract-timeout', 504) : fail('extract-failed', 502);
    }

    // ── 5. decide what the reading is worth — server-side, so there is one
    //       place that decides what a model may put in front of a reviewer ──
    const review = reviewCardExtraction(extraction.raw);

    if (review.kind === 'not-a-card' || review.candidates.length === 0) {
      console.info(
        `[card-extract] ok in ${Date.now() - started}ms card=${cardKb}KB model=${extraction.modelKey} ` +
          `written=0 ${review.kind === 'not-a-card' ? 'not-a-card' : `dropped=${review.droppedRows}`}`
      );
      const nothing: CardExtractSuccess = {
        written: 0,
        droppedRows: review.kind === 'reviewed' ? review.droppedRows : 0,
        notACard: review.kind === 'not-a-card',
        modelKey: extraction.modelKey,
        candidateIds: [],
      };
      return NextResponse.json(nothing);
    }

    // ── 6. write them as candidates, create-if-absent ───────────────────────
    let written;
    try {
      written = await writeCardCandidates(petId, review.candidates, {
        modelKey: extraction.modelKey,
        sourceDocument: path,
        recordedBy: reviewer,
      });
    } catch (err) {
      // The model answered and was billed; the answer is lost. Say so loudly
      // in the log — this is the one failure that costs a request for nothing.
      console.error(`[card-extract] extracted but could NOT save card=${cardKb}KB`, err);
      return fail('save-failed', 500);
    }

    if (written.kind === 'already-extracted') {
      // A concurrent request for the same card won the race. Its candidates
      // are there; ours were refused atomically because the ids collide.
      console.warn(`[card-extract] card=${cardKb}KB lost a race to a concurrent extraction; nothing written`);
      return fail('already-extracted', 409);
    }

    console.info(
      `[card-extract] ok in ${Date.now() - started}ms card=${cardKb}KB model=${extraction.modelKey} ` +
        `written=${written.ids.length} dropped=${review.droppedRows}`
    );

    const success: CardExtractSuccess = {
      written: written.ids.length,
      droppedRows: review.droppedRows,
      notACard: false,
      modelKey: extraction.modelKey,
      candidateIds: written.ids,
    };
    return NextResponse.json(success);
  } catch (err) {
    // Firestore or Storage unreachable before the model was ever called.
    console.error('[card-extract] could not prepare the extraction', err);
    return fail('extract-failed', 502);
  }
}
