/**
 * How long a photo suggestion is allowed to take, when it is worth trying
 * again, and why the ceiling is not ours to choose.
 *
 * Pure arithmetic, deliberately in its own module with NO `server-only`
 * import, so it can be unit-tested. Same split as `areas.ts`/`areas-admin.ts`
 * and `intake-suggestion.ts`/`ai/intake-suggest.ts`: the decision is testable,
 * the call that uses it is not.
 */

/**
 * ⚠️ NOT OURS. Firebase Hosting terminates a proxied request at 60 seconds,
 * whatever the Cloud Run timeout behind it says (Cloud Run's is 300s here).
 *
 * From Firebase's own documentation: "Even though Cloud Functions and Cloud
 * Run have longer request timeouts, Firebase Hosting is subject to a 60-second
 * request timeout." `wawitas.org` and `wawitas.web.app` both reach this app
 * through a Hosting rewrite, so every request an admin makes is under this cap
 * and nothing in the application can see it or extend it.
 *
 * ── Measured the hard way, 2026-09-02 ───────────────────────────────────────
 * A four-photo intake from the deployed wizard:
 *
 *     18:02:10  POST /api/intake/suggest            750KB, 4 slots
 *     18:02:54  attempt 1/2 timed out after 43009ms; retrying
 *     18:03:18  ok in 67702ms slots=front+side+teeth+genitals
 *     18:03:18  [ai-usage] gemini-3.6-flash  $0.0316
 *
 * Cloud Run logged that request `200`, latency 68.217s, response 1248 bytes.
 * The model answered, the retry did its job, the answer was complete and
 * billed — and the browser never saw one byte of it, because Hosting had cut
 * the connection eight seconds earlier.
 *
 * The budget in this file used to be calibrated against the MODEL and never
 * against the path the answer has to travel back along. Two Flash attempts at
 * four photos came to ~86s against a ceiling of 60: any four-photo call that
 * needed its retry was undeliverable BY CONSTRUCTION, and with a hang rate
 * near 50% on this path that was roughly a coin flip on every intake.
 */
export const HOSTING_EDGE_TIMEOUT_MS = 60_000;

/**
 * Everything the route does, end to end, has to fit inside this.
 *
 * The 10s of headroom under HOSTING_EDGE_TIMEOUT_MS is not padding. Hosting's
 * 60s is wall-clock AT THE EDGE: it starts when the client begins uploading
 * and ends when the last byte of the response leaves. This module's timers
 * start after the form has been parsed, so they are structurally blind to the
 * upload — and a 750KB photo set climbing a phone's uplink is several seconds
 * of that window before any of this code runs.
 *
 * ── The trade-off this makes, stated rather than buried ─────────────────────
 * Two attempts have to fit, so each gets 25s where a four-photo Flash call
 * would otherwise have asked for 43s. A HEALTHY call slower than 25s is now
 * cut off where it would previously have been delivered, and that is a real
 * regression for that band.
 *
 * ── ⚠️ THAT BAND IS NO LONGER UNOBSERVED. Measured 2026-09-12 ───────────────
 * This block used to argue the trade was worth it because the cut-off band
 * was hypothetical while the hang was real. Both halves of that have now been
 * measured, and the conclusion has moved.
 *
 * `npm run probe:suggest`, twelve four-photo samples on gemini-3.6-flash with
 * the abort at 90s instead of 25s: 11 answered, 1 returned a 503, and **zero
 * were dead sockets**. Healthy answers reached 34473ms and 40786ms — so
 * roughly **18% of good four-photo answers are above the 25s clamp** and are
 * being discarded after being built and billed.
 *
 * So the "hang" this budget was shaped around is not a hang. It is this
 * distribution's tail, and a second attempt does not rescue it: it abandons a
 * request that was going to answer and pays the latency again from cold.
 *
 * ⚠️ The prediction two paragraphs down came true, so follow it rather than
 * re-deriving it: healthy four-photo calls DO now land above ~25s, and the
 * answer is NOT to raise this constant. The arithmetic is unforgiving —
 * a 40.8s answer plus any retry cannot fit under 60s, and the edge window
 * starts before this module's timers do, while a 750KB photo set climbs a
 * phone's uplink. One attempt long enough for the tail is the most this
 * architecture can hold, and that means no retry at all for the 503 case.
 *
 * The fix is the delivery path: call Cloud Run directly, where the limit is
 * 300s, or return a job id and poll. Until then this constant is the least
 * bad compromise rather than a good one, and that is the honest description.
 *
 * ⚠️ Raising this to buy the model more room does not work. Past 60s the
 * answer cannot be delivered at all, so a longer budget only buys a more
 * expensive way to fail. If a tier genuinely needs longer, the fix is to stop
 * routing this call through Hosting — call Cloud Run directly, or return a job
 * id and poll — not to raise this number.
 */
export const SUGGEST_TOTAL_BUDGET_MS = 50_000;

/** Attempts in total, not retries after the first. */
export const SUGGEST_MAX_ATTEMPTS = 2;

/**
 * A photo suggestion should never hold up an intake.
 *
 * ⚠️ PER ATTEMPT, not for the whole operation — and that distinction is the
 * whole point of this constant.
 *
 * Measured in production 2026-08-30, four real calls from a phone:
 *
 *   ok      4683ms  photo=323KB
 *   FAILED 25009ms  photo=393KB
 *   ok      6795ms  photo=435KB
 *   FAILED 25001ms  photo=229KB
 *
 * Read those numbers carefully. Photo size is NOT the variable — the largest
 * succeeded and the smallest failed. Successes are 4.7-6.8s.
 *
 * ── ⚠️ CORRECTION, measured 2026-09-12 ──────────────────────────────────────
 * This block used to conclude: "The failures sit on the abort to the
 * millisecond, which means the request never came back at all rather than
 * being slow: a hung connection, not a slow model."
 *
 * That is FALSE, and it was never observable from inside this clamp. The
 * failures sit on the abort to the millisecond because THE ABORT IS WHAT ENDS
 * THEM — it says nothing about whether an answer was on its way. The
 * inference was unfalsifiable by construction, which is the whole reason
 * `npm run probe:suggest` exists: it re-runs the real prompt, schema and
 * photographs with our abort moved out to 90s, so the provider gets to
 * finish.
 *
 * Twelve four-photo samples on gemini-3.6-flash at a 90s abort:
 *
 *     11 answered      11293 12062 12747 13149 15949 17678
 *                      17754 18485 18857 34473 40786  ms
 *      1 failed        503 "high demand" — arriving at 68933ms
 *      0 dead sockets
 *
 * ZERO aborts in twelve. Every request eventually came back. So a "hang" is
 * the TAIL OF A HEAVY LATENCY DISTRIBUTION, not a dead connection — and
 * 2/11 healthy answers (~18%) landed above this 25s clamp, meaning production
 * built, billed and discarded a correct answer twice in twelve calls.
 *
 * Two consequences, neither of which is "raise the number":
 *
 *   1. A same-model retry is a weaker remedy than it looks. It abandons a
 *      request that was going to answer and then pays the full latency again
 *      from cold. It is not useless — the 503 branch genuinely benefits — but
 *      it is not the rescue the original reasoning claimed.
 *   2. A 503 can arrive ANYWHERE in the distribution: 2868ms and 6408ms on
 *      gemini-3.8-flash the same day, against 68933ms here. Past this clamp
 *      we cannot tell an overload from a slow success, so the provider's own
 *      diagnosis is destroyed — see shouldFallBackToWeakerModel.
 *
 * The real fix is the one SUGGEST_TOTAL_BUDGET_MS already names: take this
 * call off Firebase Hosting. Nothing inside a 50s budget can deliver a 40.8s
 * answer AND keep a retry.
 *
 * The earlier design passed ONE `AbortSignal.timeout(25_000)` to
 * generateObject alongside `maxRetries: 1`. That retry was unreachable: the
 * signal spans every attempt, so a hang on the first consumed the entire
 * budget and the second never started. A retry that cannot run is worse than
 * no retry, because it reads like resilience that is not there.
 */
export const SUGGEST_ATTEMPT_TIMEOUT_MS = 12_000;

/**
 * The Flash tier needs its own, larger budget. Measured on the same real
 * photograph 2026-08-30:
 *
 *   gemini-3.6-flash       10060 ms
 *   gemini-3.1-flash-lite   3991 ms
 *
 * Flash reasons before answering, which is exactly what buys the correct
 * age — so the latency is the feature, not overhead to squeeze out.
 */
export const SUGGEST_ATTEMPT_TIMEOUT_MS_FLASH = 25_000;

/**
 * Extra budget per photo beyond the first.
 *
 * Measured 2026-08-30 on Flash-Lite: one image 4978ms, two images 7240ms, so
 * roughly +2.2s per image.
 *
 * On Flash, two four-photo samples now exist — 16719ms (2026-09-02 12:16) and
 * ~24700ms (2026-09-02 18:03, the successful retry above) — against 10060ms
 * at one photo. That is ~2.2s to ~4.9s per extra image, i.e. much closer to
 * the LITE figure than to the 6000 originally guessed here. The old guess
 * assumed the "Flash is ~2.5x slower" multiplier applied to the per-image
 * increment; it does not. The multiplier is on the BASE, where reasoning is
 * paid once per call, while each extra image is mostly vision encoding, which
 * is near enough tier-independent.
 *
 * These are left generous on purpose — what they guard against is a hung
 * socket, which is not the same thing as the latency they are sized from. The
 * clamp in attemptTimeoutMsFor() is what keeps that generosity affordable.
 */
export const SUGGEST_PER_EXTRA_PHOTO_MS_FLASH = 6_000;
export const SUGGEST_PER_EXTRA_PHOTO_MS_LITE = 2_500;

/**
 * Do not START an attempt with less than this left on the clock.
 *
 * A retry that is certain to be cut off is worse than no retry: it doubles the
 * wait before the admin sees the message they needed immediately, and it
 * spends a request against a free-tier quota of 20 a day. Roughly twice the
 * fastest observed healthy call (3991ms), so it is long enough to be worth
 * starting and short enough not to skip a retry that had a real chance.
 */
export const SUGGEST_MIN_RETRY_MS = 8_000;

/**
 * Per-attempt budget for the tier being called AND the number of photos.
 *
 * A single shared budget across attempts was the 2026-08-30 bug; a budget that
 * ignores photo count is the same mistake one axis over; and a budget that
 * ignores the delivery path was the 2026-09-02 bug, which is the clamp below.
 *
 * ⚠️ The clamp is load-bearing. Without it a four-photo Flash call asks for
 * 43s per attempt, and two of those cannot be delivered through a 60s edge.
 * See SUGGEST_TOTAL_BUDGET_MS for why raising the ceiling is not the fix.
 */
export function attemptTimeoutMsFor(modelId: string, photoCount = 1): number {
  const lite = modelId.includes('lite');
  const base = lite ? SUGGEST_ATTEMPT_TIMEOUT_MS : SUGGEST_ATTEMPT_TIMEOUT_MS_FLASH;
  const perExtra = lite
    ? SUGGEST_PER_EXTRA_PHOTO_MS_LITE
    : SUGGEST_PER_EXTRA_PHOTO_MS_FLASH;

  const wanted = base + perExtra * Math.max(0, photoCount - 1);
  const affordable = Math.floor(SUGGEST_TOTAL_BUDGET_MS / SUGGEST_MAX_ATTEMPTS);

  return Math.min(wanted, affordable);
}

/**
 * When the FIRST attempt must be over by, counted from the moment the request
 * was sent. For the waiting UI, and for nothing else.
 *
 * ⚠️ Assumes the Flash tier deliberately. The ladder's primary is always
 * Flash-class, and the browser cannot know which model the server picked — the
 * ids come from server-only env vars. Assuming Flash gives the LONGER window,
 * so the UI errs toward saying "still on the first attempt" rather than
 * announcing a retry that has not started. Claiming too little is the honest
 * direction when the claim is about someone else's progress.
 *
 * This is the only thing about the server's progress that a client can state
 * as fact, and it is a fact only because `attemptTimeoutMsFor` CLAMPS an
 * attempt: an attempt cannot run longer than this, so past it there is
 * genuinely a second one under way — whether that is a same-model retry or the
 * next tier down.
 *
 * ⚠️ `photoCount` is currently INERT on the Flash tier, and that is worth
 * knowing rather than discovering. Measured: the window is 25000ms at 1, 2, 3,
 * 4 and 8 photos, because SUGGEST_ATTEMPT_TIMEOUT_MS_FLASH already equals the
 * affordable share of the budget, so the clamp binds at one photo. The
 * argument is kept rather than hardcoded because it becomes live again the
 * moment the budget rises — which it can only do by taking this call off
 * Firebase Hosting. A hardcoded 25000 would make the waiting UI quietly wrong
 * on that day.
 */
export function firstAttemptEndsAtMs(photoCount: number): number {
  // Any non-lite id selects the Flash branch; the value is what matters.
  return attemptTimeoutMsFor('gemini-flash', photoCount);
}

/**
 * How much the waiting UI is entitled to say about the server's progress.
 *
 * ⚠️ THREE phases and no more, because three is all the facts support. The
 * suggest call does not stream and reports no stages, so the browser knows
 * exactly two things: its own elapsed time, and two constants — the clamp on a
 * single attempt and the budget the whole operation is cut off at.
 *
 * `retrying` is an INFERENCE, and a sound one: `attemptTimeoutMsFor` clamps an
 * attempt, so past that window the first attempt is definitively over and a
 * second is under way. What it deliberately does NOT claim is WHICH second
 * attempt — a same-model retry and a fall to the next tier are
 * indistinguishable from here, and both are honestly "probando otra vez".
 *
 * Anything finer would be invented. See AnalysisProgress.tsx.
 */
export type AnalysisPhase = 'first' | 'retrying' | 'nearly-up';

export function analysisPhaseFor(elapsedMs: number, photoCount: number): AnalysisPhase {
  if (elapsedMs >= SUGGEST_TOTAL_BUDGET_MS) return 'nearly-up';
  return elapsedMs >= firstAttemptEndsAtMs(photoCount) ? 'retrying' : 'first';
}

/**
 * How long to wait before trying an OVERLOADED provider again.
 *
 * A hang wants a fresh connection immediately — there is nothing to wait for.
 * An overload is the opposite: the pool is saturated right now, and retrying
 * into the same instant is the one thing least likely to work. Google's own
 * words on the 503 are "Spikes in demand are usually temporary."
 *
 * 1.5s is chosen against the measured budget rather than picked round. A
 * four-photo Flash 503 came back in 14.3s (2026-09-03), leaving ~36s; the
 * backoff plus a full 25s attempt still lands at ~40s, inside the 50s total
 * and well inside Firebase Hosting's 60s ceiling.
 */
export const SUGGEST_OVERLOAD_BACKOFF_MS = 1_500;

/** APICallError carries `statusCode`; some transports use `status`. Accept both. */
function statusCodeOf(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const e = err as { statusCode?: unknown; status?: unknown };
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.status === 'number') return e.status;
  return undefined;
}

/** A timeout or an abort — both mean "no answer came back". */
export function isTimeoutFailure(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/**
 * The provider answered, and the answer was "I am overloaded, try again".
 *
 * Observed in production 2026-09-03, twice, on gemini-3.6-flash:
 *
 *     statusCode: 503
 *     "This model is currently experiencing high demand. Spikes in demand
 *      are usually temporary. Please try again later."
 *     status: "UNAVAILABLE"
 *
 * Neither call was retried, because the retry policy only knew about hangs,
 * and the admin got "Solo falló el análisis automático" — indistinguishable
 * from a real failure for something the provider had just described as
 * temporary.
 *
 * ⚠️ 408 is deliberately not special-cased. Our own per-attempt AbortSignal is
 * shorter than any server-side request timeout, so that condition reaches us
 * as a TimeoutError long before a 408 could.
 */
export function isOverloadedFailure(err: unknown): boolean {
  const status = statusCodeOf(err);
  return status !== undefined && status >= 500;
}

/** Out of quota, as opposed to broken. Matched on status, not provider prose. */
export function isQuotaExhaustedFailure(err: unknown): boolean {
  return statusCodeOf(err) === 429;
}

/**
 * Worth another attempt on the SAME model.
 *
 * ⚠️ Deliberately narrower than the AI SDK's own `isRetryable` flag, and the
 * difference is load-bearing. That flag defaults to
 * `408 || 409 || 429 || >= 500` — it includes **429**. Retrying a 429 here
 * would be actively harmful: 429 means the day's Flash quota is spent, it will
 * not refill in twenty-five seconds, and there is a strictly better remedy
 * already built — fall back to Flash-Lite, which has 500 requests a day
 * against Flash's 20. Retrying first would burn the budget that fallback needs.
 *
 * So: retry what a second attempt can fix (a hang, a saturated pool), and hand
 * everything else to the caller, which knows about tiers.
 */
export function isRetryableFailure(err: unknown): boolean {
  return isTimeoutFailure(err) || isOverloadedFailure(err);
}

/** How long to pause before the next attempt at this particular failure. */
export function retryBackoffMsFor(err: unknown): number {
  return isOverloadedFailure(err) ? SUGGEST_OVERLOAD_BACKOFF_MS : 0;
}

/**
 * Worth trying the NEXT model down the ladder.
 *
 * Both branches are "degrade rather than fail", which plan §3 requires: an
 * animal arriving at 22:00 must not wait on a quota or on someone else's
 * traffic spike. A quota is spent for the day; an overload has survived every
 * retry we were willing to spend. Each tier is a different pool — free-tier
 * quota is counted per model — so a tier below is very often up when the one
 * above is not.
 *
 * ⚠️ A HANG DELIBERATELY DOES NOT ADVANCE THE TIER, and the reason is
 * arithmetic rather than taste. Decided 2026-09-10 with the three-tier
 * cascade:
 *
 *   - A hang already has a better remedy, and it is already applied: a fresh
 *     connection to the SAME model. Production data (2026-08-30) shows a hang
 *     is a hung socket rather than a slow model — the failures sit on the
 *     abort to the millisecond while healthy calls answer in 4-7s — and there
 *     is no evidence any of it is model-specific.
 *   - The budget cannot afford both. A hang consumes the whole 25s
 *     per-attempt clamp, so two of them exhaust SUGGEST_TOTAL_BUDGET_MS and
 *     SUGGEST_MIN_RETRY_MS then refuses to start anything else. Advancing the
 *     tier on a hang would therefore not BUY an extra attempt; it would only
 *     spend the one remaining attempt on a different model, giving up the
 *     fresh-connection retry that is the thing actually known to work.
 *
 * So: a hang is retried where isRetryableFailure says so, and the ladder is
 * for failures that a second attempt on the same model cannot fix.
 *
 * ── ⚠️ BOTH BULLETS ABOVE ARE NOW KNOWN FALSE. Measured 2026-09-12 ──────────
 * Left standing rather than rewritten, because the DECISION they justify is
 * still in force and reversing it is the owner's call, not a comment edit.
 * `npm run probe:suggest`, twelve four-photo samples on gemini-3.6-flash with
 * the abort at 90s:
 *
 *   1. A hang is NOT a hung socket. Zero of twelve were dead — every request
 *      came back. Two answered at 34473ms and 40786ms, i.e. correctly, past
 *      the clamp; one returned a 503 at 68933ms. The "hung socket" reading
 *      was an artefact of measuring from inside a 25s abort, where a slow
 *      success and a dead connection are indistinguishable.
 *
 *   2. The budget CAN afford the next tier, because the arithmetic assumed
 *      the tier below also needs ~25s. It does not. Flash-Lite on the very
 *      same four photographs measured 8/8 successes in 4910-7197ms, with no
 *      tail at all. After a 25s Flash timeout there are ~25s left, and Lite
 *      needs about six of them.
 *
 * So a timeout falling through to Lite would turn today's total failure into
 * a ~6s degraded answer, which is what plan §3 asks for — degrade rather than
 * fail. The cost is Lite's documented age weakness (it read a facial mask as
 * muzzle greying), against which `decideAge` already refuses low-confidence
 * ranges and an admin reviews every field.
 *
 * ⚠️ NOT changed here, deliberately. It reverses an explicit 2026-09-10
 * decision, it is a behaviour change to the busiest AI path, and it has had no
 * browser verification. Read the 2026-09-12 log entry before acting on it.
 *
 * ⚠️ And it is NOT a licence to raise a budget constant. The tail reaches
 * 40.8s and Firebase Hosting cuts at 60s counting from the client's first
 * upload byte — see SUGGEST_TOTAL_BUDGET_MS.
 */
export function shouldFallBackToWeakerModel(err: unknown): boolean {
  return isQuotaExhaustedFailure(err) || isOverloadedFailure(err);
}

/**
 * Walk a model ladder under ONE shared deadline.
 *
 * ⚠️ This lives here, not in `intake-suggest.ts`, for one reason: the single
 * shared deadline is the property that broke on 2026-09-02 and it was
 * UNTESTABLE while it sat inside a `server-only` module that makes network
 * calls. A deliberate-break probe reported it uncovered — deleting the shared
 * deadline left every test green — which is the whole argument for the
 * `areas.ts`/`areas-admin.ts` split applied one module further in. The
 * decision is testable; the call that uses it is not.
 *
 * What the shared deadline prevents: each tier creating its own full budget,
 * so N tiers could run to N x SUGGEST_TOTAL_BUDGET_MS. At two tiers that was
 * 100s against Firebase Hosting's 60s ceiling — an answer built, billed and
 * discarded. At four tiers it would be 200s.
 *
 * @param ladder  models to try, strongest first
 * @param call    given a model and THE deadline, produce an answer or throw
 * @param deps    injected clock and logger, so a test can drive both
 */
export async function walkModelLadder<T>(
  ladder: readonly string[],
  call: (model: string, deadline: number) => Promise<T>,
  deps: { now?: () => number; warn?: (message: string) => void; describe?: (err: unknown) => string } = {}
): Promise<T> {
  const now = deps.now ?? Date.now;
  const warn = deps.warn ?? console.warn;
  const describe = deps.describe ?? (() => 'failed');

  if (ladder.length === 0) throw new Error('walkModelLadder: ladder must not be empty');

  // ONE deadline, created once, handed to every tier unchanged.
  const deadline = now() + SUGGEST_TOTAL_BUDGET_MS;

  let lastErr: unknown;
  for (let tier = 0; tier < ladder.length; tier++) {
    const model = ladder[tier]!;

    if (tier > 0) {
      // Degrade rather than fail, but only while there is time to say
      // something useful. Starting a tier into 200ms of remaining budget just
      // replaces one failure with a slower one, and spends a request from that
      // tier's daily allowance to do it.
      //
      // This is also what keeps the ladder honest about HANGS: a hang costs
      // the full per-attempt clamp, so after two of them nothing below is
      // reachable and the walk stops here rather than pretending otherwise.
      const left = deadline - now();
      if (left < SUGGEST_MIN_RETRY_MS) {
        warn(
          `[intake-suggest] only ${left}ms left of ${SUGGEST_TOTAL_BUDGET_MS}ms; not trying ${model} (tier ${tier + 1}/${ladder.length})`
        );
        break;
      }
      warn(
        `[intake-suggest] ${ladder[tier - 1]} ${describe(lastErr)}; falling back to ${model} (tier ${tier + 1}/${ladder.length}) with ${left}ms left`
      );
    }

    try {
      return await call(model, deadline);
    } catch (err) {
      lastErr = err;
      // Only quota and overload move DOWN the ladder. A 400 for a malformed
      // image or a 401 for a bad key fails identically on every tier, and a
      // HANG is deliberately not on the list — see shouldFallBackToWeakerModel.
      if (!shouldFallBackToWeakerModel(err)) throw err;
    }
  }
  // Every tier refused, or the budget ran out part-way down. The LAST error is
  // thrown, so the caller's message describes the tier that actually gave up
  // rather than the first one that did.
  throw lastErr;
}
