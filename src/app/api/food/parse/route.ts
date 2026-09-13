import { NextResponse } from 'next/server';

import { getAdminAuth } from '@/lib/firebase-admin';
import { aiIsConfigured } from '@/lib/ai/google';
import { parseDonationText } from '@/lib/ai/food-parse';
import { SUGGEST_TOTAL_BUDGET_MS, isTimeoutFailure } from '@/lib/ai/suggest-budget';
import { DONATION_TEXT_MAX_CHARS, reviewParsedDonation } from '@/lib/food-parse';
import { FOOD_PARSE_FAILURE_HEADER } from '@/lib/food-parse-client';

/**
 * POST /api/food/parse — a donation described in words, proposed as lines.
 *
 * ═══ THIS ROUTE IS OUTSIDE `firestore.rules` ════════════════════════════════
 * Like `/api/intake/suggest`, it holds `GEMINI_API_KEY` and spends from a
 * shared free-tier quota, and nothing in the rules protects it. So it verifies
 * the ID token and the `admin` claim ITSELF, with `checkRevoked`, and that
 * check is the whole boundary. `AdminGate` runs in the browser.
 *
 * ═══ IT CHANGES NOTHING ═════════════════════════════════════════════════════
 * No Firestore write happens here. The route returns PROPOSED lines, already
 * passed through the pure review policy (grounding, the toxic default); a
 * person edits and confirms them, and the browser writes the donation and its
 * ledger entries under the rules. A parse that is wrong costs a correction on
 * screen, never a wrong pantry.
 *
 * Failure direction: OPEN — every failure means "type the lines by hand".
 */

export const runtime = 'nodejs';
// A POST with an auth header and a per-request body: never prerendered, never
// cached. `revalidate` would be inert here, so it is not set.
export const dynamic = 'force-dynamic';

function fail(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status, headers: { [FOOD_PARSE_FAILURE_HEADER]: error } });
}

export async function POST(request: Request): Promise<Response> {
  // Firebase Hosting's 60 s started when this request reached the edge. The
  // closest we can get is now, before any await — so the model's deadline is
  // counted from here, not from after the token check and the body read.
  const arrivedAt = Date.now();

  // ── 1. authenticate — BEFORE anything else, so an anonymous caller learns
  //       nothing, not even whether the feature is configured ──────────────
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return fail('unauthenticated', 401);

  let isAdmin = false;
  try {
    const decoded = await getAdminAuth().verifyIdToken(token, true);
    isAdmin = decoded.admin === true;
  } catch {
    return fail('unauthenticated', 401);
  }
  if (!isAdmin) return fail('forbidden', 403);

  // ── 2. configured ──────────────────────────────────────────────────────────
  if (!aiIsConfigured()) return fail('ai-not-configured', 503);

  // ── 3. the text ────────────────────────────────────────────────────────────
  let text: string;
  try {
    const body = (await request.json()) as { text?: unknown };
    if (typeof body.text !== 'string') return fail('text-required', 400);
    text = body.text.trim();
  } catch {
    return fail('body-unreadable', 400);
  }
  if (text === '') return fail('text-required', 400);
  if (text.length > DONATION_TEXT_MAX_CHARS) return fail('text-too-long', 413);

  // ── 4. parse, then apply the policy SERVER-side ───────────────────────────
  const started = Date.now();
  try {
    const { parsed, modelKey } = await parseDonationText(text, {
      deadline: arrivedAt + SUGGEST_TOTAL_BUDGET_MS,
    });
    const review = reviewParsedDonation(text, parsed);
    console.info(
      `[food-parse] ok in ${Date.now() - started}ms chars=${text.length} items=${parsed.items.length} grounded=${review.lines.filter((l) => l.grounded).length}`
    );
    return NextResponse.json({ donor: review.donor, lines: review.lines, modelKey });
  } catch (err) {
    const name = err instanceof Error ? err.name : typeof err;
    console.warn(`[food-parse] failed after ${Date.now() - started}ms chars=${text.length} error=${name}`);
    console.warn('[food-parse] failed', err);
    if (isTimeoutFailure(err)) return fail('parse-timeout', 504);
    return fail('parse-failed', 502);
  }
}
