import { NextResponse } from 'next/server';

import { getAdminAuth } from '@/lib/firebase-admin';
import { aiIsConfigured } from '@/lib/ai/google';
import { suggestFromPhoto } from '@/lib/ai/intake-suggest';
import { reviewSuggestion } from '@/lib/intake-suggestion';

/**
 * POST /api/intake/suggest — one photo in, reviewed suggestions out.
 *
 * ═══ THIS ROUTE IS OUTSIDE `firestore.rules` ════════════════════════════════
 * Every other admin action in this project goes straight from the browser to
 * Firestore, where `firestore.rules` is the boundary and `AdminGate` is only
 * UX. This route is different: it holds a real secret (`GEMINI_API_KEY`) and it
 * spends money. Nothing about the rules protects it. So it verifies the
 * caller's ID token and the `admin` custom claim ITSELF, server-side, and that
 * check is the entire boundary.
 *
 * Do not "simplify" the verification away on the grounds that `AdminGate`
 * already gates the page. `AdminGate` runs in the browser.
 *
 * ── Failure direction: OPEN, toward letting the intake proceed ───────────────
 * Every failure here returns a status the wizard treats as "no suggestions",
 * never as "you cannot admit this animal". A rescue at 22:00 must not be
 * blocked because a model timed out or a key expired. Plan §3: a gate stricter
 * than the shelter's reality gets worked around, and the workaround is the
 * WhatsApp group this system exists to replace.
 */

export const runtime = 'nodejs';
// Never prerendered, never cached: it is a POST with an auth header and a
// per-request body. Stated explicitly so nobody has to infer it.
export const dynamic = 'force-dynamic';

/** The wizard resizes to a 1600px long edge, which lands far under this. */
const MAX_BYTES = 6 * 1024 * 1024;

/** What Gemini accepts and a phone camera actually produces. */
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export async function POST(request: Request): Promise<Response> {
  // ── 1. authenticate ────────────────────────────────────────────────────────
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  let isAdmin = false;
  try {
    // checkRevoked: a revoked admin must lose access immediately here. The
    // one-hour custom-claim lag that AdminGate papers over cuts BOTH ways, and
    // on the spending path the safe side is the strict one.
    const decoded = await getAdminAuth().verifyIdToken(token, true);
    isAdmin = decoded.admin === true;
  } catch {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  if (!isAdmin) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // ── 2. is the feature even available ──────────────────────────────────────
  if (!aiIsConfigured()) {
    // 503, not 500: nothing is broken, the key is simply absent. The wizard
    // shows the manual form and says suggestions are unavailable.
    return NextResponse.json({ error: 'ai-not-configured' }, { status: 503 });
  }

  // ── 3. read the photo ─────────────────────────────────────────────────────
  let bytes: Uint8Array;
  let mediaType: string;
  try {
    const form = await request.formData();
    const file = form.get('photo');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'photo-required' }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: 'photo-too-large' }, { status: 413 });
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      // A phone will happily offer HEIC. Naming the real cause matters: the
      // wizard already learned this lesson once, when an unreadable image
      // reported "revisa tu conexión".
      return NextResponse.json({ error: 'photo-unsupported' }, { status: 415 });
    }
    bytes = new Uint8Array(await file.arrayBuffer());
    mediaType = file.type;
  } catch {
    return NextResponse.json({ error: 'photo-unreadable' }, { status: 400 });
  }

  // ── 4. ask the model ──────────────────────────────────────────────────────
  try {
    const { suggestion, modelKey } = await suggestFromPhoto(bytes, mediaType);

    // The policy is applied HERE, server-side, so there is exactly one place
    // that decides what a model is allowed to influence. A policy enforced only
    // in the browser is advice, not a rule.
    return NextResponse.json({ suggestion: reviewSuggestion(suggestion), modelKey });
  } catch (err) {
    console.warn('[intake-suggest] failed', err);
    // 502 rather than 500: the failure is upstream, and the wizard's handling
    // is the same either way — carry on without suggestions.
    return NextResponse.json({ error: 'suggest-failed' }, { status: 502 });
  }
}
