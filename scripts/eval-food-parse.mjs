/**
 * Eval harness for donation parsing.
 *
 *   npm run eval:food-parse                          # DRY RUN — says what it would spend
 *   npm run eval:food-parse -- --run                 # calls the model, one request per case
 *   npm run eval:food-parse -- --run --cases task-example,onion-in-box
 *
 * ── It measures PRODUCTION ───────────────────────────────────────────────────
 * It calls `parseDonationText` itself — the same prompt, schema, budget and
 * retry — and then the same pure `reviewParsedDonation` and `reviewDonation`
 * the route and the screen use. So what is scored is what a person would see:
 * the grams come from `parseQuantityPhrase` over the words the model COPIED,
 * and the default in/out of stock comes from the grounding and toxic policy.
 * The model never produces a number that is scored.
 *
 * ── What it scores, per expected food ───────────────────────────────────────
 *   found      a line whose food names it
 *   category   one of the defensible categories
 *   grams      the deterministic grams over the copied words (null = no mass)
 *   stock      the DEFAULT the policy chose — out for toxic or ungrounded
 * plus, per case: the number of lines, every line grounded in the text, and no
 * second person in a food name. Always the same checks, pass or fail, so two
 * runs are comparable.
 *
 * ── Cost ─────────────────────────────────────────────────────────────────────
 * One case is one request on Flash-Lite (500/day on the free tier). Metered as
 * `food_parse_eval`, never as the shelter's own `food_parse`. The fixture is
 * synthetic text, so nothing personal is sent.
 *
 * ── The leak guard ───────────────────────────────────────────────────────────
 * Refuses to run if the prompt contains any four consecutive words of a case's
 * text: a worked example that matches a case is an answer key.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const argv = process.argv.slice(2);
const wet = argv.includes('--run');
function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const fixture = JSON.parse(readFileSync(flag('--fixture') ?? join(HERE, 'fixtures', 'food-parse-cases.json'), 'utf8'));
const only = flag('--cases')?.split(',').map((s) => s.trim()).filter(Boolean);
const cases = fixture.cases.filter((c) => !only || only.includes(c.id));
if (cases.length === 0) {
  console.error('No cases selected.');
  process.exit(2);
}

function fold(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function assertNoLeakage(prompt) {
  const promptFolded = ` ${fold(prompt)} `;
  const leaked = [];
  for (const c of fixture.cases) {
    const words = fold(c.text).split(' ');
    for (let i = 0; i + 4 <= words.length; i++) {
      const gram = words.slice(i, i + 4).join(' ');
      if (promptFolded.includes(` ${gram} `)) leaked.push(`${c.id}: "${gram}"`);
    }
  }
  if (leaked.length > 0) {
    console.error('\nREFUSING TO RUN: the prompt contains text from an eval case.');
    for (const l of leaked) console.error(`  ${l}`);
    process.exit(2);
  }
}

async function main() {
  const ai = await import('../src/lib/ai/food-parse.ts');
  const { FOOD_PARSE_SYSTEM } = await import('../src/lib/ai/food-parse-prompt.ts');
  const policy = await import('../src/lib/food-parse.ts');
  const { findSecondPerson } = await import('../src/lib/ai/spanish-register.ts');
  const { feedingLogId } = await import('../src/lib/food-stock.ts');

  assertNoLeakage(FOOD_PARSE_SYSTEM);

  const model = flag('--models') ?? ai.FOOD_PARSE_MODEL_LADDER[0];
  console.log('── eval: donation parsing ─────────────────────────────────────');
  console.log(`cases   : ${cases.map((c) => c.id).join(', ')}`);
  console.log(`model   : ${model} (pinned — no fallback, so the answer is this model's)`);
  console.log(`cost    : ${cases.length} request(s) on that model's free-tier bucket`);
  console.log('metered : process=food_parse_eval');
  console.log('leak    : no four-word run of any case text appears in the prompt — checked');

  if (!wet) {
    console.log('\nDRY RUN. Nothing was called and nothing was spent. Add --run.');
    return;
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error('\nGEMINI_API_KEY is not set. Load .env.local before running.');
    process.exit(2);
  }

  const summary = [];
  for (const c of cases) {
    console.log(`\n── ${c.id} ${'─'.repeat(Math.max(0, 58 - c.id.length))}`);
    console.log(`  text: ${c.text}`);
    const started = Date.now();
    let parsed;
    try {
      ({ parsed } = await ai.parseDonationText(c.text, { models: [model], process: 'food_parse_eval' }));
    } catch (err) {
      const ms = Date.now() - started;
      console.log(`  FAILED after ${ms}ms: ${err?.name} ${err?.message ?? err}`);
      summary.push({ id: c.id, ms, failed: true, passed: 0, total: 0 });
      continue;
    }
    const ms = Date.now() - started;

    const { donor, lines } = policy.reviewParsedDonation(c.text, parsed);
    const draft = {
      donor,
      receivedAt: Date.now(),
      rawText: c.text,
      lines,
      source: 'llm-parsed',
      modelKey: 'eval',
      notes: null,
    };
    const review = policy.reviewDonation(draft, ['dog', 'cat'], Date.now());

    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok, detail });

    add(`${c.expect.length} lines`, lines.length === c.expect.length, `got ${lines.length}`);
    add('every line grounded in the text', lines.every((l) => l.grounded), JSON.stringify(lines.filter((l) => !l.grounded).map((l) => l.snippet)));
    add(
      'no second person in any food name',
      lines.every((l) => findSecondPerson(l.food).length === 0),
      JSON.stringify(lines.map((l) => l.food))
    );

    for (const want of c.expect) {
      const index = lines.findIndex((l) => fold(l.food).includes(fold(want.food)) || fold(want.food).includes(fold(l.food)));
      const line = lines[index];
      const assessment = review.lines[index];
      add(`found "${want.food}"`, index >= 0, `foods ${JSON.stringify(lines.map((l) => l.food))}`);
      add(`  category ${want.category.join('|')}`, !!line && want.category.includes(line.category), `got ${line?.category}`);
      add(
        `  grams ${want.grams}`,
        !!assessment && assessment.grams === want.grams,
        `got ${assessment?.grams} from "${line?.quantityText}"${line?.massKgText ? ` / ${line.massKgText}` : ''}`
      );
      add(`  default ${want.inStock ? 'IN' : 'OUT of'} stock`, !!line && line.includeInStock === want.inStock, `got ${line?.includeInStock}`);
      if (want.expiry) {
        add(
          `  expiry ${want.expiry}`,
          !!line && line.expiresAt !== null && feedingLogId(line.expiresAt) === want.expiry,
          `got ${line?.expiresAt === null ? null : feedingLogId(line?.expiresAt ?? 0)} from "${line?.expiryText}"`
        );
      }
    }

    const passed = checks.filter((k) => k.ok).length;
    for (const k of checks) console.log(`  ${k.ok ? 'PASS' : 'FAIL'}  ${k.name}${k.ok ? '' : `\n          ${k.detail}`}`);
    console.log(`  ${passed}/${checks.length} in ${ms}ms · donor ${JSON.stringify(donor)}`);
    for (const l of lines) {
      console.log(`    · ${l.food} [${l.category}] "${l.quantityText}" conf=${l.confidence} snippet="${l.snippet}"`);
    }
    if (review.missingHazards.length > 0) {
      console.log(`    hazards only in the sentence: ${review.missingHazards.map((h) => h.hazard).join(', ')}`);
    }
    summary.push({ id: c.id, ms, passed, total: checks.length });
  }

  console.log('\n── summary ───────────────────────────────────────────────────');
  let p = 0;
  let t = 0;
  for (const s of summary) {
    p += s.passed;
    t += s.total;
    console.log(`${s.id.padEnd(22)} ${s.failed ? 'FAILED  ' : `${s.passed}/${s.total}`.padEnd(8)} ${String(s.ms).padStart(6)}ms`);
  }
  console.log(`total                  ${p}/${t}`);
  console.log('\nPer-call token counts and cost are in the [ai-usage] lines above.');

  // Let the void-ed metering writes land before the process exits.
  await new Promise((r) => setTimeout(r, 1500));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
