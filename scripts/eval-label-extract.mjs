/**
 * Eval harness for vaccine-LABEL reading. Plan C3, 2026-10-14.
 *
 *   npm run eval:labels                                    # DRY RUN — says what it would spend
 *   npm run eval:labels -- --run                           # calls the model
 *   npm run eval:labels -- --run --models gemini-3.1-flash-lite,gemini-3.8-flash --reps 3
 *
 * ── The test set ────────────────────────────────────────────────────────────
 * Photos and answer key live in `_e2e/labels/` (gitignored); the template is
 * `_e2e/labels/EXAMPLE-ground-truth.json`. The first set is four stickers
 * cropped from one real booklet. Four stickers from one booklet is a SMALL
 * set: the claim it supports is "measured on 4 real stickers", never "works on
 * any label".
 *
 * ── It measures PRODUCTION, not a copy ──────────────────────────────────────
 * It calls the real `extractFromLabel` — the same prompt, schema, budget and
 * retry — and then the real `reviewLabelExtraction`, so what it scores is what
 * the form would receive. The ladder is pinned to ONE model per run, so a
 * fallback cannot make model A report model B's answer, and spend is metered
 * as `label_extract_eval`.
 *
 * ── The answer key is a FIXTURE, never a prompt constant ────────────────────
 * The harness REFUSES TO RUN if any expected value — a product, a laboratory,
 * a lot, a number that must never be the lot — appears in the prompt.
 *
 * ── What is scored, in order of consequence ─────────────────────────────────
 *   MUST BE ZERO
 *     1. a wrong vial expiry in the form — including the manufacture date
 *        offered as the expiry, or an expiry where the key says none is legible;
 *     2. a lot taken from a coloured tab, a diluent or a registration;
 *     3. a lot PREFILLED in the form — it is only ever offered.
 *   REPORTED
 *     correct and withheld lots, products, laboratories and expiries. A
 *     withheld field is NOT an error: it costs one typed entry. A field whose
 *     key carries a `…Doubt` note is scored only against its `…Never` list.
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

const fixturePath = flag('--fixture') ?? join(REPO, '_e2e', 'labels', 'ground-truth.json');
if (!existsSync(fixturePath)) {
  console.error(`No answer key at ${fixturePath}`);
  console.error('Copy _e2e/labels/EXAMPLE-ground-truth.json beside the label photos and fill it in.');
  process.exit(2);
}
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const wanted = flag('--labels')?.split(',').map((s) => s.trim()).filter(Boolean);
const labels = (fixture.labels ?? []).filter((l) => !wanted || wanted.includes(l.id));
if (labels.length === 0) {
  console.error('No labels selected.');
  process.exit(2);
}
for (const l of labels) {
  if (!existsSync(join(dirname(fixturePath), l.file))) {
    console.error(`Fixture names a photo that is not there: ${l.file}`);
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
    .replace(/[®™]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function looseHit(a, b) {
  const x = fold(a);
  const y = fold(b);
  return x.length >= 3 && y.length >= 3 && (x.includes(y) || y.includes(x));
}
function lotKey(s) {
  return fold(s).replace(/[\s.\-/]/g, '').toUpperCase();
}
function isoDay(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString().slice(0, 10);
}

// ── the leakage guard ───────────────────────────────────────────────────────
function assertNoLeakage(promptText) {
  const prompt = fold(promptText);
  const values = [];
  for (const l of labels) {
    values.push(...(l.product ?? []), l.manufacturer, l.lot, ...(l.lotNever ?? []));
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
function score(key, review) {
  const out = {
    checks: [],
    mustBeZero: { wrongExpiry: 0, lotFromElsewhere: 0, lotPrefilled: 0 },
    tally: {
      lot: 'n/a', product: 'n/a', manufacturer: 'n/a', expiry: 'n/a',
    },
  };
  const add = (name, ok, detail) => out.checks.push({ name, ok, detail });

  if (review.kind !== 'reviewed') {
    add('the model read this as a label', false, 'returned not-a-label');
    return out;
  }
  const { fill, offer, evidence } = review;

  // The lot is OFFERED, never prefilled: a prefilled lot is a must-be-zero.
  if ('batch' in fill) {
    out.mustBeZero.lotPrefilled++;
    add('lot: offered, never prefilled', false, `prefilled ${fill.batch}`);
  }

  // 1. The vial expiry in the form.
  const gotExpiry = isoDay(fill.productExpiresAt);
  const never = key.expiresAtNever ?? [];
  if (gotExpiry !== null && never.includes(gotExpiry)) {
    out.mustBeZero.wrongExpiry++;
    add('expiry: the manufacture date is never the expiry', false, `filled ${gotExpiry} from «${evidence.expiresAt.snippet}»`);
  } else if (key.expiresAt === null && !key.expiresAtDoubt) {
    const ok = gotExpiry === null;
    if (!ok) out.mustBeZero.wrongExpiry++;
    add('expiry: none where none is legible', ok, `filled ${gotExpiry} from «${evidence.expiresAt.snippet}»`);
  } else if (key.expiresAt === null && key.expiresAtDoubt) {
    const ok = gotExpiry === null;
    if (!ok) out.mustBeZero.wrongExpiry++;
    add('expiry: an unlabelled date is not filled', ok, `filled ${gotExpiry} from «${evidence.expiresAt.snippet}»`);
    out.tally.expiry = ok ? 'withheld (correct)' : 'WRONG';
  } else if (gotExpiry === null) {
    out.tally.expiry = `withheld (${evidence.expiresAt.withheld ?? 'absent'})`;
  } else if (gotExpiry === key.expiresAt) {
    out.tally.expiry = 'correct';
  } else {
    out.mustBeZero.wrongExpiry++;
    out.tally.expiry = 'WRONG';
    add('expiry: filled date is the label’s', false, `filled ${gotExpiry}, label says ${key.expiresAt} («${evidence.expiresAt.snippet}»)`);
  }

  // 2 and 3. The lot.
  const gotLot = offer.batch;
  const neverLots = (key.lotNever ?? []).map(lotKey);
  if (gotLot !== null && neverLots.some((n) => lotKey(gotLot) === n || (n.length >= 4 && lotKey(gotLot).startsWith(n)))) {
    out.mustBeZero.lotFromElsewhere++;
    add('lot: never the tab, diluent or registration number', false, `filled ${gotLot} («${evidence.lot.snippet}»)`);
    out.tally.lot = 'FROM ELSEWHERE';
  } else if (key.lot === null) {
    out.tally.lot = gotLot === null ? `withheld (${evidence.lot.withheld ?? 'absent'})` : `filled «${gotLot}» offered on a doubtful key, not scored`;
  } else if (gotLot === null) {
    out.tally.lot = `withheld (${evidence.lot.withheld ?? 'absent'})`;
  } else if (lotKey(gotLot) === lotKey(key.lot)) {
    out.tally.lot = 'correct';
  } else {
    // Reported, not must-be-zero: an OFFERED lot is read by a person before it is used.
    out.tally.lot = `offered WRONG «${gotLot}» (label ${key.lot})`;
  }

  // Reported, not must-be-zero.
  out.tally.product = fill.product === null
    ? `withheld (${evidence.product.withheld ?? 'absent'})`
    : (key.product ?? []).some((p) => looseHit(p, fill.product)) ? 'correct' : `other «${fill.product}»`;
  out.tally.manufacturer = key.manufacturer === null
    ? (fill.manufacturer === null ? 'none (correct)' : `filled «${fill.manufacturer}» where none is printed`)
    : fill.manufacturer === null ? `withheld (${evidence.manufacturer.withheld ?? 'absent'})`
      : looseHit(key.manufacturer, fill.manufacturer) ? 'correct' : `other «${fill.manufacturer}»`;

  add('must-be-zero failures', Object.values(out.mustBeZero).every((n) => n === 0), JSON.stringify(out.mustBeZero));
  return out;
}

// ── run ─────────────────────────────────────────────────────────────────────
async function main() {
  const ai = await import('../src/lib/ai/label-extract.ts');
  const { reviewLabelExtraction } = await import('../src/lib/label-extraction.ts');

  const models = (flag('--models') ?? ai.LABEL_MODEL_LADDER[0]).split(',').map((m) => m.trim()).filter(Boolean);

  assertNoLeakage(`${ai.LABEL_EXTRACT_SYSTEM}\n${ai.LABEL_USER_INSTRUCTION}`);

  const requests = models.length * labels.length * reps;
  console.log('── eval: vaccine-label reading ───────────────────────────────');
  console.log(`labels  : ${labels.map((l) => l.id).join(', ')}`);
  console.log(`key     : read by ${fixture.readBy ?? 'unknown'}`);
  console.log(`models  : ${models.join(', ')}`);
  console.log(`reps    : ${reps}`);
  console.log(`cost    : ${requests} request(s) — labels × models × reps, one each, against each model's own`);
  console.log('          free-tier bucket (Flash: 20/day, shared with real intakes · Flash-Lite: 500/day)');
  console.log('metered : process=label_extract_eval');
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
    for (const key of labels) {
      for (let rep = 1; rep <= reps; rep++) {
        if (!first && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
        first = false;

        const bytes = new Uint8Array(readFileSync(join(dirname(fixturePath), key.file)));
        const label = `${model} · ${key.id} · rep ${rep}`;
        console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 56 - label.length))}`);
        const started = Date.now();
        let extraction;
        try {
          extraction = await ai.extractFromLabel(
            { bytes, mediaType: 'image/jpeg' },
            { models: [model], process: 'label_extract_eval' },
          );
        } catch (err) {
          const ms = Date.now() - started;
          console.log(`  FAILED after ${ms}ms: ${err?.name ?? ''} ${err?.message ?? err}`);
          report.push({ model, label: key.id, rep, ms, failed: String(err?.message ?? err) });
          continue;
        }
        const ms = Date.now() - started;
        const review = reviewLabelExtraction(extraction.raw, Date.now());
        const s = score(key, review);

        for (const c of s.checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `\n          ${c.detail}`}`);
        console.log(`  lot ${s.tally.lot} · product ${s.tally.product} · lab ${s.tally.manufacturer} · expiry ${s.tally.expiry} — ${ms}ms, ${extraction.modelKey}`);
        // The raw reading, every run: the checks are tripwires, a person reading
        // the snippets is the other half.
        const r = extraction.raw;
        const w = (f) => `${f}=«${r[f]?.fieldWord ?? '∅'}»«${r[f]?.snippet ?? '∅'}»@${r[f]?.confidence}`;
        const t = (f) => `${f}=«${r[f]?.snippet ?? '∅'}»@${r[f]?.confidence}`;
        console.log(`    raw: ${t('product')} ${t('manufacturer')} ${t('protectsAgainst')}`);
        console.log(`    raw: ${w('lot')} ${w('manufacturedAt')} ${w('expiresAt')}`);
        report.push({ model, label: key.id, rep, ms, ...s, raw: r });
      }
    }
  }

  console.log('\n── summary ───────────────────────────────────────────────────');
  for (const model of models) {
    const runs = report.filter((r) => r.model === model);
    const ok = runs.filter((r) => !r.failed);
    const zero = (k) => ok.reduce((n, r) => n + r.mustBeZero[k], 0);
    const count = (field, value) => ok.filter((r) => r.tally[field] === value).length;
    const startsWith = (field, value) => ok.filter((r) => String(r.tally[field]).startsWith(value)).length;
    console.log(`${model}: ${ok.length}/${runs.length} runs answered`);
    console.log(`  MUST BE ZERO — wrong expiry ${zero('wrongExpiry')} · lot from tab/diluent ${zero('lotFromElsewhere')} · lot prefilled ${zero('lotPrefilled')}`);
    console.log(`  lot      : offered ${count('lot', 'correct')} correct · ${startsWith('lot', 'offered WRONG')} WRONG · ${startsWith('lot', 'withheld')} withheld · ${startsWith('lot', 'filled')} on a doubtful key`);
    console.log(`  expiry   : ${count('expiry', 'correct')} correct · ${startsWith('expiry', 'withheld')} withheld`);
    console.log(`  product  : ${count('product', 'correct')} correct · ${startsWith('product', 'withheld')} withheld · ${startsWith('product', 'other')} other`);
    console.log(`  lab      : ${count('manufacturer', 'correct') + count('manufacturer', 'none (correct)')} correct · ${startsWith('manufacturer', 'withheld')} withheld`);
    const times = ok.map((r) => r.ms).sort((a, b) => a - b);
    if (times.length) console.log(`  latency  : median ${times[Math.floor(times.length / 2)]}ms · max ${times[times.length - 1]}ms`);
    for (const r of runs.filter((x) => x.failed)) console.log(`  FAILED ${r.label} rep ${r.rep}: ${r.failed}`);
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
