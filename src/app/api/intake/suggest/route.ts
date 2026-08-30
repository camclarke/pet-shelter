import { NextResponse } from 'next/server';

import { getAdminAuth } from '@/lib/firebase-admin';
import { aiIsConfigured } from '@/lib/ai/google';
import { suggestFromPhoto, type SlottedPhoto } from '@/lib/ai/intake-suggest';

/**
 * The slots the route will read, in the order they are sent to the model.
 * Front first because it is the cover photo and the breed evidence; teeth and
 * genitals last because they are the ones a frightened animal is least likely
 * to allow.
 */
const ACCEPTED_SLOTS = ['front', 'side', 'teeth', 'genitals'] as const;
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

  // ── 3. read the photo SET ─────────────────────────────────────────────────
  //
  // One form field per slot: photo_front, photo_side, photo_teeth,
  // photo_genitals. All present slots travel in ONE request, because free-tier
  // quota is counted in requests and the Flash tier gets 20 a day — one call
  // per photo would cut the shelter from 20 animals a day to five.
  //
  // Any subset is valid. A rescuer on a street with a frightened animal often
  // manages exactly one photograph, and that must still work.
  let photos: SlottedPhoto[] = [];
  try {
    const form = await request.formData();

    for (const slot of ACCEPTED_SLOTS) {
      const file = form.get(`photo_${slot}`);
      if (file == null) continue;
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
      photos.push({
        slot,
        bytes: new Uint8Array(await file.arrayBuffer()),
        mediaType: file.type,
      });
    }

    // Back-compat: the single-photo field the wizard used before guided
    // capture. Kept so an older client mid-deploy still works rather than
    // getting a 400 it cannot explain.
    if (photos.length === 0) {
      const legacy = form.get('photo');
      if (legacy instanceof File) {
        if (legacy.size > MAX_BYTES) {
          return NextResponse.json({ error: 'photo-too-large' }, { status: 413 });
        }
        if (!ALLOWED_TYPES.has(legacy.type)) {
          return NextResponse.json({ error: 'photo-unsupported' }, { status: 415 });
        }
        photos.push({
          slot: 'front',
          bytes: new Uint8Array(await legacy.arrayBuffer()),
          mediaType: legacy.type,
        });
      }
    }

    if (photos.length === 0) {
      return NextResponse.json({ error: 'photo-required' }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: 'photo-unreadable' }, { status: 400 });
  }

  // ── 4. ask the model ──────────────────────────────────────────────────────
  // Timed on BOTH branches. A 25.3s timeout in production on 2026-08-30 was
  // undiagnosable because the only record was the abort itself: no elapsed
  // time, no photo size, and no sign of whether a retry had eaten the budget.
  // The same call takes ~3s from a laptop with a 1.2 MB photo, so the gap is
  // environmental and the numbers are the only way to find it.
  const started = Date.now();
  const photoKb = Math.round(
    photos.reduce((n, p) => n + p.bytes.byteLength, 0) / 1024
  );
  const slots = photos.map((p) => p.slot).join('+');

  try {
    const { suggestion, modelKey } = await suggestFromPhoto(photos);
    console.info(
      `[intake-suggest] ok in ${Date.now() - started}ms photo=${photoKb}KB slots=${slots}`
    );

    // The policy is applied HERE, server-side, so there is exactly one place
    // that decides what a model is allowed to influence. A policy enforced only
    // in the browser is advice, not a rule.
    return NextResponse.json({ suggestion: reviewSuggestion(suggestion), modelKey });
  } catch (err) {
    const elapsed = Date.now() - started;
    const name = err instanceof Error ? err.name : typeof err;
    // Structured first, so a grep finds it without wading through a minified
    // stack. The stack still follows, because the cause is usually in it.
    console.warn(
      `[intake-suggest] failed after ${elapsed}ms photo=${photoKb}KB slots=${slots} error=${name}`
    );
    console.warn('[intake-suggest] failed', err);
    // 502 rather than 500: the failure is upstream, and the wizard's handling
    // is the same either way — carry on without suggestions.
    // A timeout is a different fact from a failure: the photo is already
    // saved, nothing is wrong with it, and trying again on better signal may
    // well work. Collapsing it into 502 made the UI say "no pudimos analizar",
    // which reads as permanent. Measured in production 2026-08-30.
    const timedOut =
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError');
    if (timedOut) {
      return NextResponse.json({ error: 'suggest-timeout' }, { status: 504 });
    }
    return NextResponse.json({ error: 'suggest-failed' }, { status: 502 });
  }
}
