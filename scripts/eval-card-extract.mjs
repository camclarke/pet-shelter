/**
 * Eval harness for vaccination-card extraction. Build-order step 9.
 *
 *   npm run cards:synthesize                  # draw the cards + answer key
 *   npm run eval:cards                        # DRY RUN — says what it would spend
 *   npm run eval:cards -- --run               # calls the model
 *   npm run eval:cards -- --run --models gemini-3.1-flash-lite --reps 3
 *   npm run eval:cards -- --run --cards illegible --models gemini-3.8-flash
 *
 * ── ⚠️ SYNTHETIC CARDS ARE EASIER THAN REAL ONES ────────────────────────────
 * Rendered text on a flat background, a script font instead of handwriting,
 * no glare, no fold, no perspective. Every score here is an UPPER BOUND on a
 * real card photographed in a shelter. What it measures well is the failure
 * this path exists to prevent: an illegible date is genuinely ABSENT from the
 * image, so a date returned for it was invented.
 *
 * ── It measures PRODUCTION, not a copy ──────────────────────────────────────
 * It calls the real `extractFromCard` — the same prompt, schema, per-attempt
 * budget and retry policy — and then the real `reviewCardExtraction`, so what
 * it scores is what a reviewer would be shown, after the policy withheld what
 * it withholds. Two things are overridden, both for the benchmark's sake: the
 * ladder is pinned to ONE model, so a fallback cannot make model A's run report
 * model B's answer; and spend is metered as `card_extract_eval`.
 *
 * ── The answer key is a FIXTURE, never a prompt constant ────────────────────
 * The harness REFUSES TO RUN if any expected value — a product name, a lot, a
 * printed date, the owner's details — appears in the prompt. An eval whose key
 * has leaked certifies the thing it was built to catch.
 *
 * ── What is scored, in order of consequence ─────────────────────────────────
 *   1. WRONG DATES — a prefilled date that is not the card's. Must be zero.
 *   2. INVENTED DATES — a date prefilled where the card has none legible.
 *   3. PRIVACY — any extracted text containing the owner's details.
 *   4. withheld vs correct dates, rows found, kind, lot — how useful it is.
 * A withheld field is NOT an error: it costs one typed entry. It is reported
 * separately so the thresholds can be judged against how much they withhold.
 *
 * ── Cost ────────────────────────────────────────────────────────────────────
 * One card, one model, one rep = ONE request. Free-tier quota is per model:
 * Flash tiers 20/day (shared with the shelter's real intakes), Flash-Lite
 * 500/day. The dry run prints the total before anything is spent.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const argv = process.argv.slice(2);
const wet = argv.includes('--run');
const asJson = argv.includes('--json');
function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const fixturePath = flag('--fixture') ?? join(REPO, '_e2e', 'cards', 'ground-truth.json');
if (!existsSync(fixturePath)) {
  console.error(`No answer key at ${fixturePath}`);
  console.error('Run `npm run cards:synthesize` first, or pass --fixture for a real card.');
  process.exit(2);
}
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const wantedVariants = flag('--cards')?.split(',').map((s) => s.trim()).filter(Boolean);
const cards = (fixture.cards ?? []).filter(
  (c) => !wantedVariants || wantedVariants.includes(c.variant),
);
if (cards.length === 0) {
  console.error('No cards selected.');
  process.exit(2);
}
for (const card of cards) {
  if (!existsSync(join(dirname(fixturePath), card.file))) {
    console.error(`Fixture names a card image that is not there: ${card.file}`);
    process.exit(2);
  }
}
const reps = Math.max(1, Number(flag('--reps') ?? 1));
const gapMs = Math.max(0, Number(flag('--gap-ms') ?? 4500));

// ── folding ─────────────────────────────────────────────────────────────────
function fold(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
function looseHit(a, b) {
  const x = fold(a);
  const y = fold(b);
  return x.length >= 3 && y.length >= 3 && (x.includes(y) || y.includes(x));
}
function isoDay(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString().slice(0, 10);
}
function lotKey(s) {
  return fold(s).replace(/[\s.-]/g, '').toUpperCase();
}

// ── the leakage guard ───────────────────────────────────────────────────────
function assertNoLeakage(promptText) {
  const prompt = fold(promptText);
  const values = [...(fixture.ownerData ?? [])];
  for (const card of cards) {
    for (const row of card.rows) {
      values.push(...(row.name ?? []), row.printedDate, row.batch, row.manufacturer, row.veterinarian, row.clinic);
    }
  }
  const leaked = [];
  for (const v of values) {
    if (v === null || v === undefined) continue;
    const f = fold(v);
    if (f.length < 4) continue;
    const escaped = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Letter-aware boundaries, never \b: \b is ASCII-only in JavaScript.
    if (new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(prompt)) leaked.push(v);
  }
  if (leaked.length > 0) {
    console.error('\nREFUSING TO RUN: the answer key has leaked into the prompt.');
    console.error('Found: ' + leaked.map((l) => JSON.stringify(l)).join(', '));
    process.exit(2);
  }
}

// ── scoring ─────────────────────────────────────────────────────────────────
function score(card, review) {
  const out = {
    checks: [],
    dates: { correct: 0, withheld: 0, wrong: 0, invented: 0 },
    rowsExpected: card.rows.length,
    rowsFound: 0,
    confidence: { correctDates: [], wrongDates: [] },
  };
  const add = (name, ok, detail) => out.checks.push({ name, ok, detail });

  if (review.kind !== 'reviewed') {
    add('the model read this as a card', false, 'returned not-a-card');
    return out;
  }
  const candidates = review.candidates.map((c) => ({ ...c, used: false }));

  for (const [i, row] of card.rows.entries()) {
    const label = `row ${i + 1} (${row.name?.[0] ?? '?'})`;
    let match = candidates.find((c) => !c.used && (row.name ?? []).some((n) => looseHit(n, c.draft.name)));
    if (!match && row.performedAt) {
      match = candidates.find((c) => !c.used && isoDay(c.draft.performedAt) === row.performedAt);
    }
    if (!match) {
      add(`${label} found`, false, 'no candidate for this row');
      continue;
    }
    match.used = true;
    out.rowsFound++;

    for (const field of ['performedAt', 'nextDueAt']) {
      const got = isoDay(match.draft[field]);
      const expected = row[field];
      const conf = match.evidence[field]?.confidence ?? 0;
      if (expected === null) {
        // ⚠️ The check this harness exists for.
        const ok = got === null;
        if (!ok) out.dates.invented++;
        add(`${label} ${field}: NO DATE INVENTED`, ok, `prefilled ${got} from «${match.evidence[field]?.snippet}» where the card has none`);
      } else if (got === null) {
        out.dates.withheld++;
      } else if (got === expected) {
        out.dates.correct++;
        out.confidence.correctDates.push(conf);
      } else {
        out.dates.wrong++;
        out.confidence.wrongDates.push(conf);
        add(`${label} ${field}: prefilled date is the card's`, false, `prefilled ${got}, card says ${expected} («${match.evidence[field]?.snippet}», conf ${conf})`);
      }
    }

    if (match.draft.kind !== null && match.draft.kind !== row.kind) {
      add(`${label} kind`, false, `got ${match.draft.kind}, card is ${row.kind}`);
    }
    if (row.batch && match.draft.batch && lotKey(match.draft.batch) !== lotKey(row.batch)) {
      add(`${label} lot`, false, `got ${match.draft.batch}, card says ${row.batch}`);
    }
  }

  // Every candidate the card does not have is invented content.
  const extra = candidates.filter((c) => !c.used);
  add('no invented rows', extra.length === 0, `extra: ${JSON.stringify(extra.map((c) => c.draft.name))}`);

  // PRIVACY: the owner's details must not be in any field or snippet.
  const owner = (fixture.ownerData ?? []).map(fold).filter((s) => s.length >= 4);
  const leaks = [];
  for (const c of review.candidates) {
    const texts = [c.draft.name, c.draft.batch, c.draft.manufacturer, c.draft.veterinarian, c.draft.clinic,
      ...Object.values(c.evidence).map((e) => e.snippet)];
    for (const t of texts) if (t && owner.some((o) => fold(t).includes(o))) leaks.push(t);
  }
  add('the owner’s details are copied nowhere', leaks.length === 0, `found in ${JSON.stringify(leaks)}`);

  add(`rows found ${out.rowsFound}/${out.rowsExpected}`, out.rowsFound === out.rowsExpected, 'a row the policy dropped or the model missed');
  return out;
}

// ── run ─────────────────────────────────────────────────────────────────────
async function main() {
  const ai = await import('../src/lib/ai/card-extract.ts');
  const { reviewCardExtraction } = await import('../src/lib/card-extraction.ts');

  const models = (flag('--models') ?? ai.CARD_MODEL_LADDER[0]).split(',').map((m) => m.trim()).filter(Boolean);

  assertNoLeakage(`${ai.CARD_EXTRACT_SYSTEM}\n${ai.CARD_USER_INSTRUCTION}`);

  const requests = models.length * cards.length * reps;
  console.log('── eval: vaccination-card extraction ─────────────────────────');
  console.log('⚠️  SYNTHETIC cards: scores are an UPPER BOUND on real ones.');
  console.log(`cards   : ${cards.map((c) => c.variant).join(', ')}`);
  console.log(`models  : ${models.join(', ')}`);
  console.log(`reps    : ${reps}`);
  console.log(`cost    : ${requests} request(s) — cards × models × reps, one each, against each model's own`);
  console.log(`          free-tier bucket (Flash: 20/day, shared with real intakes · Flash-Lite: 500/day)`);
  console.log('metered : process=card_extract_eval');
  console.log('answer key is a fixture and is NOT in the prompt — checked, not assumed');

  if (!wet) {
    console.log('\nDRY RUN. Nothing was called and nothing was spent. Add --run to spend the above.');
    return;
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error('\nGEMINI_API_KEY is not set. Load .env.local before running.');
    process.exit(2);
  }

  const report = [];
  let first = true;
  for (const model of models) {
    for (const card of cards) {
      for (let rep = 1; rep <= reps; rep++) {
        if (!first && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
        first = false;

        const bytes = new Uint8Array(readFileSync(join(dirname(fixturePath), card.file)));
        const label = `${model} · ${card.variant} · rep ${rep}`;
        console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 56 - label.length))}`);
        const started = Date.now();
        let extraction;
        try {
          extraction = await ai.extractFromCard(
            { bytes, mediaType: 'image/jpeg' },
            { models: [model], process: 'card_extract_eval' },
          );
        } catch (err) {
          const ms = Date.now() - started;
          console.log(`  FAILED after ${ms}ms: ${err?.name ?? ''} ${err?.message ?? err}`);
          report.push({ model, card: card.variant, rep, ms, failed: String(err?.message ?? err) });
          continue;
        }
        const ms = Date.now() - started;
        const review = reviewCardExtraction(extraction.raw, Date.now());
        const s = score(card, review);
        const passed = s.checks.filter((c) => c.ok).length;

        for (const c of s.checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `\n          ${c.detail}`}`);
        console.log(`  ${passed}/${s.checks.length} checks in ${ms}ms — answered by ${extraction.modelKey}`);
        console.log(`  dates: ${s.dates.correct} correct · ${s.dates.withheld} withheld · ${s.dates.wrong} WRONG · ${s.dates.invented} INVENTED`);
        // The raw reading, printed every run: the checks are tripwires and a
        // person reading the snippets is the other half.
        for (const row of extraction.raw.rows ?? []) {
          const f = (k) => `${k}=«${row[k]?.snippet ?? '∅'}»${row[k] ? `@${row[k].confidence}` : ''}`;
          console.log(`    raw: kind=${row.kind?.value ?? '∅'}@${row.kind?.confidence} ${f('name')} ${f('performedAt')} ${f('nextDueAt')} ${f('batch')} ${f('clinic')} ${f('veterinarian')}`);
        }
        if (review.kind === 'reviewed' && review.droppedRows > 0) console.log(`    policy dropped ${review.droppedRows} row(s)`);
        report.push({ model, card: card.variant, rep, ms, passed, total: s.checks.length, ...s, raw: extraction.raw });
      }
    }
  }

  console.log('\n── summary ───────────────────────────────────────────────────');
  for (const model of models) {
    const runs = report.filter((r) => r.model === model);
    const ok = runs.filter((r) => !r.failed);
    const sum = (k) => ok.reduce((n, r) => n + r.dates[k], 0);
    const conf = (k) => ok.flatMap((r) => r.confidence[k]);
    console.log(
      `${model}: ${ok.length}/${runs.length} runs · checks ${ok.reduce((n, r) => n + r.passed, 0)}/${ok.reduce((n, r) => n + r.total, 0)} · ` +
        `rows ${ok.reduce((n, r) => n + r.rowsFound, 0)}/${ok.reduce((n, r) => n + r.rowsExpected, 0)} · ` +
        `dates ${sum('correct')} correct / ${sum('withheld')} withheld / ${sum('wrong')} WRONG / ${sum('invented')} INVENTED`,
    );
    console.log(`  confidence on correct dates: ${JSON.stringify(conf('correctDates'))}`);
    console.log(`  confidence on WRONG dates  : ${JSON.stringify(conf('wrongDates'))}`);
    for (const r of runs.filter((x) => x.failed)) console.log(`  FAILED ${r.card} rep ${r.rep}: ${r.failed}`);
  }
  console.log('\nPer-call tokens and cost are in the [ai-usage] lines above.');
  if (asJson) console.log('\n' + JSON.stringify(report, null, 2));

  // Let the void-ed metering writes land before the process exits.
  await new Promise((r) => setTimeout(r, 1500));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
