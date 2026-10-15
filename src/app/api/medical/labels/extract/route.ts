import { NextResponse } from 'next/server';

import { verifyAdminIdToken } from '@/lib/firebase-admin';
import { requireAdmin } from '@/lib/require-admin';
import { aiIsConfigured } from '@/lib/ai/google';
import { extractFromLabel } from '@/lib/ai/label-extract';
import type { AiProcess } from '@/lib/ai/metered';
import { SUGGEST_TOTAL_BUDGET_MS, isTimeoutFailure } from '@/lib/ai/suggest-budget';
import { parseLabelExtractRequest, reviewLabelExtraction } from '@/lib/label-extraction';
import {
  LABEL_FAILURE_HEADER,
  type LabelExtractSuccess,
  type LabelRouteError,
} from '@/lib/label-extract-client';
import { cardBucketName, petOrDraftExists, readCardPhoto } from '@/lib/medical-server';

/**
 * POST /api/medical/labels/extract — read ONE vaccine or medicine label and
 * return what it says, for the medical form to show. Plan C4.
 *
 * Body: `{ petId, path }`, where `path` is a label photo the admin's browser
 * already uploaded to `medical/{petId}/label-{uuid}.jpg`. `petId` may be a
 * published pet OR an unpublished draft.
 *
 * ═══ THIS ROUTE WRITES NOTHING ══════════════════════════════════════════════
 * Unlike the card route, it creates no candidate and no record. A label is one
 * dose, scanned while the person is there typing it: the route returns values,
 * the form shows them beside the label's own text, and the person SAVING the
 * form is the confirmation, stamped with their name. A queue would add a step
 * and gain nothing.
 *
 * ═══ THIS ROUTE IS OUTSIDE `firestore.rules` AND `storage.rules` ════════════
 * It holds `GEMINI_API_KEY`, spends free-tier quota, and reads Storage through
 * the Admin SDK. So it verifies the ID token and the `admin` claim ITSELF, with
 * `checkRevoked`, before anything else — and that check is the boundary.
 *
 * ── Failure direction: OPEN, toward typing ──────────────────────────────────
 * Every failure says why and changes nothing: the form stays as the person
 * left it. The label photo is already stored, so a retry does not re-upload.
 */

export const runtime = 'nodejs';
// A POST with an auth header and a per-request body: never prerendered, never cached.
export const dynamic = 'force-dynamic';

function fail(error: LabelRouteError, status: number): NextResponse {
  return NextResponse.json({ error }, { status, headers: { [LABEL_FAILURE_HEADER]: error } });
}

/**
 * Which budget line this spend belongs to. Honours exactly one override, so a
 * local end-to-end probe meters as eval and production can be tagged nothing
 * else. Unset on Cloud Run, whose env list Terraform owns.
 */
function meteringProcess(): AiProcess {
  return process.env.LABEL_EXTRACT_PROCESS === 'label_extract_eval'
    ? 'label_extract_eval'
    : 'label_extract';
}

export async function POST(request: Request): Promise<Response> {
  // Hosting's 60 s started at the edge; the closest we get is now, before any await.
  const arrivedAt = Date.now();

  // ── 1. authenticate — BEFORE the configured-check, so an unauthenticated
  //       caller learns nothing about whether the feature is switched on ──────
  const auth = await requireAdmin(request, verifyAdminIdToken);
  if (!auth.ok) return fail(auth.error, auth.status);

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
  // Holds the path to exactly `medical/{petId}/label-{uuid}.jpg`. The Admin SDK
  // could read ANY object — this is what stops it reading anything else.
  const parsed = parseLabelExtractRequest(body);
  if (!parsed) return fail('bad-request', 400);
  const { petId, path } = parsed;

  const started = Date.now();
  let labelKb = 0;

  try {
    if (!(await petOrDraftExists(petId))) return fail('pet-not-found', 404);

    // The card photo reader, reused: same size cap and type check, both read
    // from METADATA before a byte is downloaded.
    const photo = await readCardPhoto(path);
    if (photo.kind === 'missing') return fail('label-not-found', 404);
    if (photo.kind === 'too-large') return fail('label-too-large', 413);
    if (photo.kind === 'unsupported') return fail('label-unsupported', 415);
    if (photo.kind === 'not-configured') return fail('storage-not-configured', 503);
    labelKb = Math.round(photo.bytes.byteLength / 1024);

    // ── 4. read the label ────────────────────────────────────────────────────
    let extraction;
    try {
      extraction = await extractFromLabel(
        { bytes: photo.bytes, mediaType: photo.mediaType },
        { process: meteringProcess(), deadline: arrivedAt + SUGGEST_TOTAL_BUDGET_MS }
      );
    } catch (err) {
      const elapsed = Date.now() - started;
      const name = err instanceof Error ? err.name : typeof err;
      console.warn(`[label-extract] failed after ${elapsed}ms label=${labelKb}KB error=${name}`);
      console.warn('[label-extract] failed', err);
      return isTimeoutFailure(err) ? fail('extract-timeout', 504) : fail('extract-failed', 502);
    }

    // ── 5. decide what the reading is worth — server-side, so there is one
    //       place that decides what a model may put in front of a person ──────
    const review = reviewLabelExtraction(extraction.raw, Date.now());
    const result: LabelExtractSuccess =
      review.kind === 'not-a-label'
        ? {
            notALabel: true,
            fill: { product: null, manufacturer: null, productExpiresAt: null },
            offer: { batch: null },
            evidence: null,
            highlighted: [],
            modelKey: extraction.modelKey,
            path,
          }
        : {
            notALabel: false,
            fill: review.fill,
            offer: review.offer,
            evidence: review.evidence,
            highlighted: review.highlighted,
            modelKey: extraction.modelKey,
            path,
          };

    console.info(
      `[label-extract] ok in ${Date.now() - started}ms label=${labelKb}KB model=${extraction.modelKey} ` +
        (result.notALabel
          ? 'not-a-label'
          : `filled=${Object.values(result.fill).filter((v) => v !== null).length} lotOffered=${result.offer.batch !== null}`)
    );
    return NextResponse.json(result);
  } catch (err) {
    // Firestore or Storage unreachable before the model was ever called.
    console.error('[label-extract] could not prepare the extraction', err);
    return fail('extract-failed', 502);
  }
}
