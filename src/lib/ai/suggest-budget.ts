/**
 * How long a photo suggestion is allowed to take, and why the ceiling is not
 * ours to choose.
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
 * It is still the right bet, on the two things that are measured. The
 * dominant failure here is a HANG, at roughly half of all calls (2026-08-30,
 * four consecutive production calls: two hung to the millisecond of their
 * budget, two answered in under 7s) — and a hang always consumes the entire
 * attempt, so the only thing that rescues it is a second attempt. Healthy
 * four-photo calls have measured 16719ms and ~24700ms, both under the clamp.
 * Trading an unobserved band for the failure that happens half the time is
 * the better side of that coin.
 *
 * ⚠️ But the margin on 24700ms is thin, and it is the number to watch. If
 * healthy four-photo calls start landing above ~25s, do NOT raise this
 * constant — that band is only reachable by shortening the retry, and the
 * retry is what covers the common case. The answer at that point is to stop
 * going through Hosting: call Cloud Run directly, where the limit is 300s, or
 * return a job id and poll.
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
 * succeeded and the smallest failed. The failures sit on the abort to the
 * millisecond, which means the request never came back at all rather than
 * being slow: a hung connection, not a slow model. Successes are 4.7-6.8s.
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
