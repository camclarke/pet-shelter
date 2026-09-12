/**
 * Is a "hang" a dead socket, or a slow call we abort too early?
 *
 *   npm run probe:suggest                        # DRY RUN — says what it would spend
 *   npm run probe:suggest -- --run
 *   npm run probe:suggest -- --run --photos 1 --n 8
 *   npm run probe:suggest -- --run --model gemini-3.1-flash-lite --n 20
 *
 * ── The question this exists to answer ──────────────────────────────────────
 * Roughly half of four-photo intake calls fail, and EVERY observed failure
 * sits on OUR abort to the millisecond — 25009ms, 25001ms, 25005ms, 25072ms.
 * So nobody has ever seen what the provider would have done at 40s or 90s, and
 * that single unknown decides the fix:
 *
 *   dead socket    -> the fast same-model retry is right. Keep it.
 *   slow but alive -> the budget is not the problem, the DELIVERY PATH is.
 *                     Firebase Hosting cuts a proxied request at 60s, so the
 *                     answer is architectural (call Cloud Run directly, or
 *                     return a job id and poll) and NOT a bigger number.
 *
 * `src/lib/ai/suggest-budget.ts` says in three places that raising the budget
 * is not the fix. This script is how you find out which fix it is instead,
 * without shipping a raised budget to production to do it.
 *
 * ── What it measures, and what it does NOT ──────────────────────────────────
 * It measures THE PROVIDER, through production's real prompt, real Zod schema,
 * real provider client and real photographs — with our own abort moved far out
 * of the way so the provider gets to reveal its own behaviour.
 *
 * It deliberately does NOT exercise:
 *   - Firebase Hosting's 60s edge timeout (in-process, no HTTP hop)
 *   - `withRetry` / `walkModelLadder` (one attempt per sample, `maxRetries: 0`)
 *   - the route handler's auth boundary
 *
 * That is the right scope: the budget machinery is already measured and known
 * correct. What is unmeasured is the thing on the other end of the socket.
 *
 * ⚠️ It is therefore NOT a substitute for `npm run eval:intake`, which scores
 * ANSWERS. This scores only latency and failure shape.
 *
 * ── Cost ────────────────────────────────────────────────────────────────────
 * One sample is one request against that model's own free-tier bucket:
 *     gemini-3.8 / 3.7 / 3.6-flash    20 per day,  5 per minute
 *     gemini-3.1-flash-lite          500 per day, 15 per minute
 * A hung sample still spends a request. So `--n 8` on a Flash tier is 8 of the
 * shelter's 20 for that day — run the distribution on Flash-Lite and spend
 * Flash only on the samples that have to be Flash. The dry run prints this.
 *
 * Samples are spaced to respect the per-MINUTE limit, because a 429 would
 * measure our own pacing rather than the provider's behaviour.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const E2E = join(REPO, '_e2e');

// ── argv ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const wet = argv.includes('--run');
function flag(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}
const num = (name, fallback) => Number(flag(name, String(fallback)));

const model = flag('--model', 'gemini-3.6-flash');
const photoCount = num('--photos', 4);
const samples = num('--n', 6);

/**
 * ⚠️ The whole point: far past production's 25s clamp, so the provider decides
 * when the call ends rather than us. 90s is chosen to be past Firebase
 * Hosting's 60s ceiling too — if healthy answers turn up between 60s and 90s,
 * that is decisive evidence that no budget tuning can help and the delivery
 * path has to change.
 */
const timeoutMs = num('--timeout', 90_000);

/**
 * Minimum gap between the START of one sample and the next, so a 429 never
 * gets mistaken for provider behaviour. Flash is 5/min -> 12s; Lite is 15/min
 * -> 4s. A little headroom on each.
 */
const isLite = model.includes('lite');
const spacingMs = num('--space', isLite ? 4_500 : 13_000);

// ── photos ──────────────────────────────────────────────────────────────────
/**
 * Slot order matters. A 1-photo sample must be the FRONT shot, because that is
 * what a rescuer on a street actually manages, and it is the arm that tests
 * whether the hang correlates with the four-photo payload at all.
 */
const SLOT_FILES = [
  ['front', 'front.jpeg'],
  ['side', 'side.jpg'],
  ['teeth', 'teeth.jpeg'],
  ['genitals', 'genitals.jpeg'],
];
const MEDIA_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

const photos = [];
for (const [slot, file] of SLOT_FILES.slice(0, photoCount)) {
  const p = join(E2E, file);
  if (!existsSync(p)) {
    console.error(`Missing photo: ${p}`);
    console.error('_e2e/ is gitignored — it holds real animal photographs. See _e2e/EXAMPLE-ground-truth.json.');
    process.exit(2);
  }
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  photos.push({ slot, bytes: new Uint8Array(readFileSync(p)), mediaType: MEDIA_TYPES[ext] ?? 'image/jpeg' });
}
if (photos.length === 0) {
  console.error('--photos must be at least 1');
  process.exit(2);
}
const payloadKb = Math.round(photos.reduce((n, p) => n + p.bytes.length, 0) / 1024);

// ── classification ──────────────────────────────────────────────────────────
/**
 * Exactly the distinctions the decision turns on. Note `abort` is OUR clock
 * running out even at `timeoutMs` — the dead-socket verdict — while `ok` past
 * production's clamp is the slow-but-alive verdict.
 */
function classify(err) {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'abort';
  const status =
    err && typeof err === 'object'
      ? typeof err.statusCode === 'number'
        ? err.statusCode
        : typeof err.status === 'number'
          ? err.status
          : undefined
      : undefined;
  if (status === 429) return 'quota';
  if (status !== undefined && status >= 500) return 'overload';
  return `other(${status ?? (err && err.name) ?? 'unknown'})`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // `--conditions=react-server` is what lets these `server-only` modules load
  // outside Next; without it the import throws. See the npm script.
  const [{ google }, prompt, suggest] = await Promise.all([
    import('../src/lib/ai/google.ts'),
    import('../src/lib/ai/intake-prompt.ts'),
    import('../src/lib/ai/intake-suggest.ts'),
  ]);
  const { generateObject } = await import('ai');
  const budget = await import('../src/lib/ai/suggest-budget.ts');

  const productionClamp = budget.attemptTimeoutMsFor(model, photos.length);

  console.log('── probe: is a hang a dead socket, or a slow call? ────────────');
  console.log(`model     : ${model}`);
  console.log(`photos    : ${photos.map((p) => p.slot).join(' + ')} (${photos.length}, ${payloadKb}KB)`);
  console.log(`samples   : ${samples}, spaced >=${spacingMs}ms apart (per-minute limit, not pacing under test)`);
  console.log(`our abort : ${timeoutMs}ms  — production clamps this call at ${productionClamp}ms`);
  console.log(`            so any answer above ${productionClamp}ms is one production would have DISCARDED`);
  console.log(`edge      : ${budget.HOSTING_EDGE_TIMEOUT_MS}ms — an answer above this cannot be delivered through Hosting at all`);
  console.log(`cost      : ${samples} request(s) against ${model}'s own bucket (${isLite ? '500' : '20'}/day). A hung sample still spends one.`);
  console.log('metered   : NOT metered — this scores latency, not answers, so it stays out of api_usage_daily');

  if (!wet) {
    console.log('\nDRY RUN. Nothing was called and nothing was spent.');
    console.log('Add --run to actually spend the requests above.');
    return;
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error('\nGEMINI_API_KEY is not set. Load .env.local before running.');
    process.exit(2);
  }

  const content = [
    { type: 'text', text: prompt.USER_INSTRUCTION },
    ...photos.flatMap((p) => [
      { type: 'text', text: `Foto: ${prompt.SLOT_LABEL[p.slot]}` },
      { type: 'image', image: p.bytes, mediaType: p.mediaType },
    ]),
  ];

  const results = [];
  for (let i = 1; i <= samples; i++) {
    const started = Date.now();
    let outcome;
    let detail = '';
    try {
      const out = await generateObject({
        model: google(model),
        // The REAL schema, imported rather than reconstructed. A
        // structured-output call's latency depends on the schema it was given,
        // so a copy would measure a different request than production makes.
        schema: suggest.SuggestionSchema,
        system: prompt.INTAKE_SUGGEST_SYSTEM,
        messages: [{ role: 'user', content }],
        abortSignal: AbortSignal.timeout(timeoutMs),
        // withRetry owns retrying in production; here one sample is one
        // attempt, or the distribution would be of retries rather than calls.
        maxRetries: 0,
      });
      outcome = 'ok';
      const u = out.usage ?? {};
      detail = `in=${u.inputTokens ?? '?'} out=${u.outputTokens ?? '?'} breeds=${JSON.stringify(out.object?.resemblesBreeds ?? null)}`;
    } catch (err) {
      outcome = classify(err);
      detail = String(err?.message ?? err).split('\n')[0].slice(0, 90);
    }
    const ms = Date.now() - started;
    results.push({ i, ms, outcome });

    const beyond = outcome === 'ok' && ms > productionClamp ? '  <<< PRODUCTION WOULD HAVE ABORTED THIS' : '';
    console.log(`\n  #${String(i).padStart(2)}  ${String(ms).padStart(6)}ms  ${outcome.padEnd(9)}${beyond}`);
    console.log(`        ${detail}`);

    if (i < samples) {
      const wait = Math.max(0, spacingMs - ms);
      if (wait > 0) await sleep(wait);
    }
  }

  // ── what this cost ─────────────────────────────────────────────────────────
  /**
   * ⚠️ Printed because this script is a DELIBERATELY UNMETERED call site, and
   * this project's playbook is emphatic that those are how a $665 surprise
   * bill happens (§4.2 — an audit found 14 of them in a sibling stack).
   *
   * The deviation is deliberate and narrow: `recordAiUsage` writes to
   * Firestore, and a latency probe that pauses to write Firestore is measuring
   * partly itself. It also needs ADC, which this script otherwise does not.
   * So spend is reported HERE, locally, instead of landing in
   * `api_usage_daily` — which keeps the shelter's own rollup clean, at the
   * cost of the audit trail. That trade is only acceptable because this is a
   * dev-only script that is never deployed and is opt-in behind `--run`.
   */
  console.log('\n── spend ─────────────────────────────────────────────────────');
  console.log(`  ${results.length} request(s) against ${model}'s bucket (${isLite ? '500' : '20'}/day).`);
  console.log(`  Failures included — a hung or refused request still spends one.`);
  console.log(`  NOT written to api_usage_daily. Nothing above appears in the shelter's rollup.`);

  // ── the distribution, which is the deliverable ─────────────────────────────
  console.log('\n── distribution ──────────────────────────────────────────────');
  const by = {};
  for (const r of results) by[r.outcome] = (by[r.outcome] ?? 0) + 1;
  for (const [k, v] of Object.entries(by)) {
    console.log(`  ${k.padEnd(12)} ${v}/${results.length}`);
  }

  const oks = results.filter((r) => r.outcome === 'ok').map((r) => r.ms).sort((a, b) => a - b);
  if (oks.length > 0) {
    const p = (q) => oks[Math.min(oks.length - 1, Math.floor(q * oks.length))];
    console.log(`\n  healthy latency (n=${oks.length}): min ${oks[0]}ms  median ${p(0.5)}ms  max ${oks[oks.length - 1]}ms`);
    const overClamp = oks.filter((ms) => ms > productionClamp);
    const overEdge = oks.filter((ms) => ms > budget.HOSTING_EDGE_TIMEOUT_MS);
    console.log(`  above production's ${productionClamp}ms clamp : ${overClamp.length}/${oks.length}`);
    console.log(`  above Hosting's ${budget.HOSTING_EDGE_TIMEOUT_MS}ms edge  : ${overEdge.length}/${oks.length}`);
  }

  const aborts = results.filter((r) => r.outcome === 'abort');
  const slowAnswers = oks.filter((ms) => ms > productionClamp);

  /**
   * ⚠️ The third category, and the one the first version of this script was
   * blind to: a FAILURE that arrives above production's clamp.
   *
   * The original verdict classified only successes by latency, so a run whose
   * single failure was a 503 arriving at 68933ms printed "the provider was
   * healthy, this says nothing about the hang" — when it was in fact the
   * whole finding. Production would have aborted that request at 25s and
   * recorded a TimeoutError, so the provider's own diagnosis never arrives.
   *
   * That matters because the two are handled OPPOSITELY:
   * `shouldFallBackToWeakerModel` advances the tier on an overload and
   * deliberately does NOT on a timeout. A slow overload therefore reaches us
   * disguised as the one failure that cannot move down the ladder.
   */
  const maskedDiagnoses = results.filter(
    (r) => r.outcome !== 'ok' && r.outcome !== 'abort' && r.ms > productionClamp,
  );

  console.log('\n── verdict ───────────────────────────────────────────────────');
  if (maskedDiagnoses.length > 0) {
    console.log(`  MASKED DIAGNOSIS. ${maskedDiagnoses.length} failure(s) arrived ABOVE production's`);
    console.log(`  ${productionClamp}ms clamp: ${maskedDiagnoses.map((r) => `${r.outcome} at ${r.ms}ms`).join(', ')}.`);
    console.log(`  Production aborts at ${productionClamp}ms, so it would have recorded these as a`);
    console.log(`  TIMEOUT and never learned what the provider actually said.`);
    console.log(`  -> This is not a budget problem. A timeout does not advance the model`);
    console.log(`     ladder and an overload does, so a slow overload reaches the retry`);
    console.log(`     policy wearing the one label that cannot fall to another tier.`);
    console.log(`     Fix the CLASSIFICATION, not the number.`);
  }
  if (aborts.length > 0 && slowAnswers.length === 0) {
    console.log(`\n  DEAD SOCKET: ${aborts.length} sample(s) never answered even in ${timeoutMs}ms,`);
    console.log(`  and no healthy answer needed more than production's ${productionClamp}ms.`);
    console.log(`  -> A fast same-model retry is a reasonable remedy for those. Do NOT raise`);
    console.log(`     the budget: a request that is silent at 90s is silent at any budget.`);
  }
  if (slowAnswers.length > 0) {
    console.log(`\n  SLOW BUT ALIVE: ${slowAnswers.length} ANSWER(S) landed above production's ${productionClamp}ms`);
    console.log(`  clamp, i.e. production would have discarded a good answer.`);
    console.log(`  -> The fix is the DELIVERY PATH, not the number: Firebase Hosting cuts at`);
    console.log(`     ${budget.HOSTING_EDGE_TIMEOUT_MS}ms, so call Cloud Run directly or return a job id and poll.`);
  }
  if (maskedDiagnoses.length === 0 && aborts.length === 0 && slowAnswers.length === 0) {
    console.log(`  Nothing needed more than production already allows, and nothing failed.`);
    console.log(`  The provider was healthy on this run, so it says nothing about the hang —`);
    console.log(`  re-run when intake is actually failing.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
