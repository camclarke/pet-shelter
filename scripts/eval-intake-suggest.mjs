/**
 * Eval harness for photo-assisted intake.
 *
 *   npm run eval:intake                 # DRY RUN — says what it would spend
 *   npm run eval:intake -- --run        # actually calls the model
 *   npm run eval:intake -- --run --models gemini-3.8-flash,gemini-3.6-flash
 *
 * ── What this is for ────────────────────────────────────────────────────────
 * Two questions this project could not previously answer without a human
 * squinting at a screen: "is this model's age reading safe?" and "did that
 * prompt edit help or hurt?". INTAKE_SUGGEST_SYSTEM carries a warning that
 * copy edits have NON-LOCAL effects — a sibling stack dropped an eval from
 * 11/11 to 9/11 by deleting one framing sentence — and until now there was no
 * eval here to drop.
 *
 * ── It measures PRODUCTION, not a copy of production ────────────────────────
 * It calls `suggestFromPhoto` itself: the same prompt, the same Zod schema,
 * the same per-attempt budget, the same retry policy, then the same pure
 * `reviewSuggestion` policy layer the wizard renders from. Playbook §13 — a
 * guard measured against a copy of its prompt measures nothing.
 *
 * The only two things it overrides are the ones a benchmark must control:
 *   - the model ladder is pinned to ONE id, so a tier fallback cannot make a
 *     benchmark of model A quietly report model B's answer;
 *   - the metering process is `intake_suggest_eval`, so benchmarking never
 *     pollutes the shelter's own spend in `api_usage_daily`.
 *
 * ── The answer key is a FIXTURE, never a prompt constant ────────────────────
 * `_e2e/ground-truth.json` holds what the animal actually is. None of it
 * reaches the model. Hardcoding "husky", "female" or "adult" into the prompt
 * would make this pass for every dog on earth, so the harness REFUSES TO RUN
 * if it finds an expected value inside the prompt — see assertNoLeakage().
 *
 * ── Cost ────────────────────────────────────────────────────────────────────
 * One model = one request per run, because all four photos travel in a single
 * call. Free-tier quota is per model and counted in requests:
 *     gemini-3.8 / 3.7 / 3.6-flash   20 per day, 5 per minute
 *     gemini-3.1-flash-lite         500 per day, 15 per minute
 * So a two-model comparison costs 2 of the shelter's 20 Flash requests for
 * that day, on EACH model's own bucket. The dry run prints this before
 * anything is spent.
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
const json = argv.includes('--json');
function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

// ── fixture ─────────────────────────────────────────────────────────────────
const fixturePath = flag('--fixture') ?? join(E2E, 'ground-truth.json');
if (!existsSync(fixturePath)) {
  console.error(`No ground truth at ${fixturePath}`);
  console.error('Copy _e2e/EXAMPLE-ground-truth.json to _e2e/ground-truth.json and fill it in.');
  console.error('It describes a real animal, so it stays local with the photos — _e2e/ is gitignored.');
  process.exit(2);
}
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const want = fixture.expect ?? {};

const MEDIA_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const photos = [];
for (const [slot, file] of Object.entries(fixture.photos ?? {})) {
  if (slot.startsWith('//')) continue;
  const p = join(dirname(fixturePath), file);
  if (!existsSync(p)) {
    console.error(`Fixture names a photo that is not there: ${p}`);
    process.exit(2);
  }
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  photos.push({ slot, bytes: new Uint8Array(readFileSync(p)), mediaType: MEDIA_TYPES[ext] ?? 'image/jpeg' });
}
if (photos.length === 0) {
  console.error('Fixture lists no photos.');
  process.exit(2);
}

// ── loose matching ──────────────────────────────────────────────────────────
/** Fold case and strip accents, so "husky siberiano" matches "Husky Siberiano". */
function fold(s) {
  return String(s).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}
/** Either direction: "husky" in the key matches a returned "husky siberiano". */
function looseHit(needle, haystack) {
  const a = fold(needle);
  const b = fold(haystack);
  return a.length > 0 && b.length > 0 && (b.includes(a) || a.includes(b));
}

// ── the leakage guard ───────────────────────────────────────────────────────
/**
 * Refuse to run if any expected value appears in the prompt.
 *
 * ⚠️ This is the single most important check in the file. An eval whose answer
 * key has leaked into its prompt reports a healthy system for any input, which
 * is worse than having no eval: it actively certifies the thing it was built
 * to catch. Checked at RUN TIME against the real exported constant, so it also
 * catches someone later "helpfully" adding "suele ser husky" to the prompt.
 */
function assertNoLeakage(systemPrompt) {
  const promptFolded = fold(systemPrompt);
  const leaked = [];
  const values = [];
  for (const b of want.resemblesBreeds ?? []) values.push(...(Array.isArray(b) ? b : [b]));
  if (want.sex) values.push(want.sex === 'female' ? 'hembra' : 'macho', want.sex);
  if (want.lifeStage) values.push(want.lifeStage);
  // `subject` is deliberately NOT checked: it is prose for the report header,
  // not an expected value, and leak-checking a whole sentence only invites
  // confusion about what the guard is for.

  for (const v of values) {
    const f = fold(v);
    // Two characters is not a leak, it is a coincidence. Breed and life-stage
    // names are all comfortably longer.
    if (f.length < 4) continue;
    // ⚠️ WORD BOUNDARIES, not a bare substring test. The first version used
    // `includes()` and reported the English enum value "adult" as leaked
    // because the Spanish prompt says "en adultos el desgaste depende de la
    // dieta" — an ordinary word, not the answer key. A guard that cries wolf
    // gets switched off, and this one is too important to switch off.
    const escaped = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'u').test(promptFolded)) leaked.push(v);
  }
  if (leaked.length > 0) {
    console.error('\nREFUSING TO RUN: the answer key has leaked into the prompt.');
    console.error('Found in INTAKE_SUGGEST_SYSTEM: ' + leaked.map((l) => JSON.stringify(l)).join(', '));
    console.error('An eval that tells the model the answer passes for every animal.');
    process.exit(2);
  }
}

// ── scoring ─────────────────────────────────────────────────────────────────
/**
 * Score one raw extraction against the fixture.
 *
 * Every check returns { name, ok, detail } rather than throwing, so one
 * failure does not hide the other six — the point of a run is the whole
 * picture, not the first problem.
 */
function score(raw, review) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const hasGenitals = photos.some((p) => p.slot === 'genitals');
  const hasTeeth = photos.some((p) => p.slot === 'teeth');

  if (want.species) {
    add('species', raw.species === want.species, `got ${raw.species}`);
  }

  // SEX — and the check is on PROVENANCE as much as on the value. A correct
  // sex inferred from body shape is a FAILURE: decideSex refuses unless the
  // model saw genitalia, and a model that guesses right today guesses wrong on
  // the next animal. Sex inflects every Spanish sentence on the site.
  if (want.sex && hasGenitals) {
    add('sex value', raw.sex === want.sex, `got ${raw.sex}`);
    add(
      'sex READ from the genital photo, not inferred',
      raw.sexFromGenitalPhoto === true,
      `sexFromGenitalPhoto=${raw.sexFromGenitalPhoto}`,
    );
    // And the policy layer must actually surface it, which is where the
    // 2026-09-02 defect lived: the value was computed and then thrown away.
    add(
      'sex survives the policy layer and is OFFERED',
      review.sex.sex === want.sex,
      `decideSex returned ${JSON.stringify(review.sex.sex)}` +
        (review.sex.refusedBecause ? ` (refused: ${review.sex.refusedBecause})` : ''),
    );
  }

  // AGE — overlap, not equality. A wider honest range is a correct answer;
  // demanding a point estimate would reward exactly the overconfidence that
  // made a Lite model call a young adult "6-8+ years" off a facial mask.
  if (want.ageMonthsMin != null && want.ageMonthsMax != null) {
    const lo = raw.ageMonthsMin;
    const hi = raw.ageMonthsMax;
    const overlaps = lo != null && hi != null && lo <= want.ageMonthsMax && hi >= want.ageMonthsMin;
    add(
      `age range overlaps ${want.ageMonthsMin}-${want.ageMonthsMax} months`,
      overlaps,
      lo == null || hi == null ? 'model returned no range' : `got ${lo}-${hi} months`,
    );
    if (hasTeeth) {
      // The whole reason the teeth slot exists. Reading age off the coat is
      // the documented failure this project has already been bitten by.
      add('age basis is the TEETH, not the coat', raw.ageBasis === 'teeth', `ageBasis=${raw.ageBasis}`);
    }
  }
  if (want.lifeStage) {
    add('life stage', raw.lifeStage === want.lifeStage, `got ${raw.lifeStage}`);
  }

  // BREED — must NAME breeds, and must still fail toward mestizo.
  const got = raw.resemblesBreeds ?? [];
  for (const entry of want.resemblesBreeds ?? []) {
    const spellings = Array.isArray(entry) ? entry : [entry];
    const hit = got.some((g) => spellings.some((s) => looseHit(s, g)));
    add(`names "${spellings[0]}"`, hit, `got ${JSON.stringify(got)}`);
  }
  // ⚠️ ALWAYS added, pass or fail. The first version only pushed a check when
  // a family name came back, so a clean run scored 10/10 and a dirty one
  // scored 10/11 — a denominator that moves with the result makes two runs
  // incomparable, which is the one thing a before/after harness must not do.
  if ((want.rejectBreedFamilies ?? []).length > 0) {
    const families = (want.rejectBreedFamilies ?? []).map(fold);
    const named = got.filter((g) => families.includes(fold(g)));
    add(
      'resemblesBreeds NAMES breeds, not a family',
      named.length === 0,
      `returned ${JSON.stringify(named)} — a family is not wrong, but a person ` +
        'scrolling an adoption wall cannot act on it',
    );
  }
  if (want.isLikelyPurebred !== undefined) {
    add(
      `isLikelyPurebred is ${want.isLikelyPurebred}`,
      raw.isLikelyPurebred === want.isLikelyPurebred,
      `got ${raw.isLikelyPurebred}` +
        (raw.isLikelyPurebred ? ` ("${raw.purebredGuess}") — a wrong breed on a public listing ends with the animal returned` : ''),
    );
  }
  return checks;
}

// ── run ─────────────────────────────────────────────────────────────────────
async function main() {
  const ai = await import('../src/lib/ai/intake-suggest.ts');
  const models = (flag('--models') ?? ai.SUGGEST_MODEL).split(',').map((m) => m.trim()).filter(Boolean);

  assertNoLeakage(ai.INTAKE_SUGGEST_SYSTEM);

  console.log('── eval: photo-assisted intake ───────────────────────────────');
  console.log(`subject : ${fixture.subject ?? '(unnamed)'}`);
  console.log(`photos  : ${photos.map((p) => p.slot).join(' + ')} (${photos.length} slots, ONE request each run)`);
  console.log(`models  : ${models.join(', ')}`);
  console.log(`cost    : ${models.length} request(s) total — 1 per model, against that model's own`);
  console.log(`          free-tier bucket (Flash: 20/day, 5/min · Flash-Lite: 500/day, 15/min)`);
  console.log(`metered : process=intake_suggest_eval, kept out of the shelter's own usage`);
  console.log('answer key is a fixture and is NOT in the prompt — checked, not assumed');

  if (!wet) {
    console.log('\nDRY RUN. Nothing was called and nothing was spent.');
    console.log('Add --run to actually spend the requests above.');
    return;
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error('\nGEMINI_API_KEY is not set. Load .env.local before running.');
    process.exit(2);
  }

  const { reviewSuggestion } = await import('../src/lib/intake-suggestion.ts');
  const report = [];

  for (const model of models) {
    console.log(`\n── ${model} ${'─'.repeat(Math.max(0, 56 - model.length))}`);
    const started = Date.now();
    let raw;
    try {
      // Pinned to ONE model: no fallback, so this measures what it names.
      const out = await ai.suggestFromPhoto(photos, {
        models: [model],
        process: 'intake_suggest_eval',
      });
      raw = out.suggestion;
    } catch (err) {
      const ms = Date.now() - started;
      console.log(`  FAILED after ${ms}ms: ${err?.message ?? err}`);
      report.push({ model, ms, failed: String(err?.message ?? err), passed: 0, total: 0 });
      continue;
    }
    const ms = Date.now() - started;

    // The same pure policy layer the wizard renders from, so a field the model
    // returned but the UI would withhold does not score as a win.
    const review = reviewSuggestion(raw);

    const checks = score(raw, review);
    const passed = checks.filter((c) => c.ok).length;
    for (const c of checks) {
      console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `\n          ${c.detail}`}`);
    }
    console.log(`  ${passed}/${checks.length} in ${ms}ms`);
    console.log(`  age        : ${raw.ageMonthsMin}-${raw.ageMonthsMax} months (basis ${raw.ageBasis}, conf ${raw.ageConfidence})`);
    console.log(`  sex        : ${raw.sex} (fromGenitalPhoto=${raw.sexFromGenitalPhoto}, conf ${raw.sexConfidence})`);
    console.log(`  resembles  : ${JSON.stringify(raw.resemblesBreeds)}`);
    console.log(`  visibleType: ${raw.visibleType}`);
    console.log(`  colour     : ${raw.colorPattern}`);
    console.log(`  coat       : ${raw.coatType}`);
    console.log(`  weight     : ${raw.weightKgMin}-${raw.weightKgMax} kg (conf ${raw.weightConfidence})`);
    report.push({ model, ms, passed, total: checks.length, checks, raw });
  }

  console.log('\n── summary ───────────────────────────────────────────────────');
  for (const r of report) {
    console.log(
      `${r.model.padEnd(24)} ${r.failed ? 'FAILED  ' + r.failed : `${r.passed}/${r.total}`.padEnd(8)} ${String(r.ms).padStart(6)}ms`,
    );
  }
  console.log('\nPer-call token counts and cost are in the [ai-usage] lines above.');
  if (json) console.log('\n' + JSON.stringify(report, null, 2));

  // Give the void-ed metering writes a moment to land before the process exits.
  await new Promise((r) => setTimeout(r, 1500));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
