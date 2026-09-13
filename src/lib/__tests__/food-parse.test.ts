import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  donationWrite,
  emptyDonationLine,
  isGrounded,
  reviewDonation,
  reviewParsedDonation,
  type DonationDraft,
  type RawParsedDonation,
  type RawParsedItem,
} from '../food-parse';
import { FOOD_CATEGORIES } from '../food-stock';
import { FOOD_CATEGORY_VALUES } from '../ai/food-parse-schema';
import { FOOD_PARSE_SYSTEM } from '../ai/food-parse-prompt';
import { FOOD_PARSE_MODEL_LADDER } from '../ai/model-ids';
import { hasPricingRow } from '../ai/pricing.mjs';
import { findVoseo, stripQuoted } from '../ai/spanish-register';

/**
 * Build-order step 13, plan §12.1 and §12.4: what a parsed donation line is
 * allowed to do. The model is never called here; its answers are fixtures.
 */

const NOW = new Date(2026, 8, 12, 16).getTime();
const RECEIVED = new Date(2026, 8, 12, 12).getTime();

/** The task's own example. */
const TEXT = '3 bolsas de arroz de 5 kg, 2 kg de hígado, un saco de croquetas de 15 kilos';

function item(over: Partial<RawParsedItem>): RawParsedItem {
  return {
    snippet: '',
    food: '',
    category: 'other',
    amount: null,
    packageSize: null,
    expiry: null,
    confidence: 'high',
    ...over,
  };
}

const GOOD_ANSWER: RawParsedDonation = {
  donor: null,
  items: [
    item({ snippet: '3 bolsas de arroz de 5 kg', food: 'arroz', category: 'grain', amount: '3 bolsas', packageSize: 'de 5 kg' }),
    item({ snippet: '2 kg de hígado', food: 'hígado', category: 'offal', amount: '2 kg' }),
    item({ snippet: 'un saco de croquetas de 15 kilos', food: 'croquetas', category: 'kibble', amount: 'un saco', packageSize: 'de 15 kilos' }),
  ],
};

function draftFrom(text: string, answer: RawParsedDonation): DonationDraft {
  const { donor, lines } = reviewParsedDonation(text, answer);
  return { donor, receivedAt: RECEIVED, rawText: text, lines, source: 'llm-parsed', modelKey: 'flash-lite', notes: null };
}

// ─── the happy path: the task's example ──────────────────────────────────────

test('the example donation becomes three stocked lines: 15 kg, 2 kg, 15 kg', () => {
  const draft = draftFrom(TEXT, GOOD_ANSWER);
  const review = reviewDonation(draft, ['dog', 'cat'], NOW);
  assert.deepEqual(review.errors, []);
  assert.deepEqual(review.lines.map((l) => l.grams), [15000, 2000, 15000]);
  assert.equal(review.stockedCount, 3);

  const { additions } = donationWrite(draft, review);
  assert.deepEqual(
    additions.map((a) => [a.category, a.label, a.deltaG]),
    [['grain', 'arroz', 15000], ['offal', 'hígado', 2000], ['kibble', 'croquetas', 15000]]
  );
});

test('kibble with no species is asked about, not assumed', () => {
  const review = reviewDonation(draftFrom(TEXT, GOOD_ANSWER), ['dog', 'cat'], NOW);
  assert.deepEqual(review.lines[2]!.warnings, [{ kind: 'species-unstated' }]);
});

// ─── grounding ───────────────────────────────────────────────────────────────

test('grounding ignores case, accents and punctuation, and matches whole words', () => {
  assert.equal(isGrounded('2 KG DE HIGADO', TEXT), true);
  assert.equal(isGrounded('3 bolsas de arroz de 5 kg', TEXT), true);
  assert.equal(isGrounded('5 kg de carne', TEXT), false);
  // "kg" alone must not match inside another token.
  assert.equal(isGrounded('g', TEXT), false);
});

test('GROUNDING: a line the text does not contain starts OUT of stock', () => {
  const answer: RawParsedDonation = {
    donor: null,
    items: [...GOOD_ANSWER.items, item({ snippet: '5 kg de carne', food: 'carne', category: 'meat', amount: '5 kg' })],
  };
  const draft = draftFrom(TEXT, answer);
  assert.equal(draft.lines[3]!.grounded, false);
  assert.equal(draft.lines[3]!.includeInStock, false);
  const review = reviewDonation(draft, ['dog', 'cat'], NOW);
  assert.ok(review.lines[3]!.warnings.some((w) => w.kind === 'not-in-text'));
  assert.equal(donationWrite(draft, review).additions.length, 3);
});

test('GROUNDING: quantity words the snippet does not contain are dropped', () => {
  const answer: RawParsedDonation = {
    donor: null,
    items: [item({ snippet: '2 kg de hígado', food: 'hígado', category: 'offal', amount: '10 kg' })],
  };
  const draft = draftFrom(TEXT, answer);
  assert.equal(draft.lines[0]!.quantityText, '');
  const review = reviewDonation(draft, null, NOW);
  assert.deepEqual(review.lines[0]!.errors, ['quantity-required']);
});

test('GROUNDING: a quantity cannot be borrowed from a neighbouring line', () => {
  const text = '2 kg de hígado y arroz';
  const answer: RawParsedDonation = {
    donor: null,
    items: [item({ snippet: 'arroz', food: 'arroz', category: 'grain', amount: '2 kg' })],
  };
  assert.equal(draftFrom(text, answer).lines[0]!.quantityText, '');
});

test('GROUNDING: a donor the text does not name is dropped', () => {
  assert.equal(draftFrom('Doña Rosa trajo 2 kg de arroz', { donor: 'Doña Rosa', items: [] }).donor, 'Doña Rosa');
  assert.equal(draftFrom('2 kg de arroz', { donor: 'Doña Rosa', items: [] }).donor, null);
});

// ─── safety at intake ────────────────────────────────────────────────────────

const ONION_TEXT = 'una caja de verduras y 1 kg de cebolla';
const ONION_ANSWER: RawParsedDonation = {
  donor: null,
  items: [
    item({ snippet: 'una caja de verduras', food: 'verduras', category: 'vegetable', amount: 'una caja' }),
    item({ snippet: '1 kg de cebolla', food: 'cebolla', category: 'vegetable', amount: '1 kg' }),
  ],
};

test('SAFETY: a toxic line is recorded but kept OUT of stock by default', () => {
  const draft = draftFrom(ONION_TEXT, ONION_ANSWER);
  assert.equal(draft.lines[1]!.includeInStock, false);
  const review = reviewDonation(draft, ['dog', 'cat'], NOW);
  assert.deepEqual(review.lines[1]!.warnings, [{ kind: 'toxic-excluded', hazards: ['allium'] }]);
  // The donation is never refused for it.
  assert.ok(!review.lines[1]!.errors.length);
});

test('SAFETY: a person can put a toxic line back, and it stays flagged', () => {
  const draft = draftFrom(ONION_TEXT, ONION_ANSWER);
  // The box has no weight yet, so leave it out; put the onion back in.
  draft.lines[0]!.includeInStock = false;
  draft.lines[1]!.includeInStock = true;
  const review = reviewDonation(draft, ['dog', 'cat'], NOW);
  assert.deepEqual(review.errors, []);
  assert.deepEqual(review.lines[1]!.warnings, [{ kind: 'toxic-included', hazards: ['allium'] }]);
  const { lines, additions } = donationWrite(draft, review);
  assert.deepEqual(additions.map((a) => a.label), ['cebolla']);
  assert.deepEqual(lines[1]!.hazards, ['allium']);
});

test('SAFETY: a hazard only the sentence names is still reported', () => {
  const text = 'verduras surtidas (había chocolate en la caja) 3 kg';
  const draft = draftFrom(text, {
    donor: null,
    items: [item({ snippet: 'verduras surtidas', food: 'verduras', category: 'vegetable', amount: null })],
  });
  const review = reviewDonation(draft, ['dog', 'cat'], NOW);
  assert.deepEqual(review.missingHazards.map((f) => f.hazard), ['chocolate']);
});

test('a bone-in line warns and stays in stock', () => {
  const text = '4 kg de espinazo';
  const draft = draftFrom(text, {
    donor: null,
    items: [item({ snippet: '4 kg de espinazo', food: 'espinazo', category: 'bone', amount: '4 kg' })],
  });
  assert.equal(draft.lines[0]!.includeInStock, true);
  const review = reviewDonation(draft, ['dog', 'cat'], NOW);
  assert.deepEqual(review.lines[0]!.warnings, [{ kind: 'caution', hazards: ['bones'] }]);
});

// ─── quantities ──────────────────────────────────────────────────────────────

test('"2 bolsas" with no size needs a weight to be stocked; the scale answers it', () => {
  const draft: DonationDraft = {
    donor: null,
    receivedAt: RECEIVED,
    rawText: '',
    lines: [{ ...emptyDonationLine('a'), food: 'arroz', category: 'grain', quantityText: '2 bolsas' }],
    source: 'manual',
    modelKey: null,
    notes: null,
  };
  assert.deepEqual(reviewDonation(draft, null, NOW).lines[0]!.errors, ['mass-required']);

  draft.lines[0]!.massKgText = '9,5';
  const review = reviewDonation(draft, null, NOW);
  assert.deepEqual(review.errors, []);
  const { lines, additions } = donationWrite(draft, review);
  assert.equal(additions[0]!.deltaG, 9500);
  assert.equal(lines[0]!.quantityText, '9,5 kg');
});

test('an unweighed line left out of stock is recorded with no error and no ledger entry', () => {
  const draft: DonationDraft = {
    donor: null,
    receivedAt: RECEIVED,
    rawText: '',
    lines: [{ ...emptyDonationLine('a'), food: 'verduras', category: 'vegetable', quantityText: 'una caja', includeInStock: false }],
    source: 'manual',
    modelKey: null,
    notes: null,
  };
  const review = reviewDonation(draft, null, NOW);
  assert.deepEqual(review.errors, []);
  assert.deepEqual(review.lines[0]!.warnings, [{ kind: 'not-stocked' }]);
  const { lines, additions } = donationWrite(draft, review);
  assert.equal(additions.length, 0);
  assert.equal(lines[0]!.inStock, false);
});

test('0 kg and an absurd line are refused when stocked', () => {
  const line = (quantityText: string) => ({ ...emptyDonationLine('a'), food: 'arroz', category: 'grain' as const, quantityText });
  const errorsFor = (quantityText: string) =>
    reviewDonation({ donor: null, receivedAt: RECEIVED, rawText: '', lines: [line(quantityText)], source: 'manual', modelKey: null, notes: null }, null, NOW).lines[0]!.errors;
  assert.deepEqual(errorsFor('0 kg'), ['quantity-not-positive']);
  assert.deepEqual(errorsFor('3000 kg'), ['quantity-too-heavy']);
  assert.deepEqual(errorsFor('1.500 kg'), ['quantity-too-precise']);
  assert.deepEqual(errorsFor('3 bolsas de arroz y 2 kg'), ['quantity-ambiguous']);
});

// ─── expiry ──────────────────────────────────────────────────────────────────

test('an expiry is copied, parsed, and warned about when already past', () => {
  const text = '2 latas de atún, vence 01/09/2026';
  const draft = draftFrom(text, {
    donor: null,
    items: [item({ snippet: '2 latas de atún, vence 01/09/2026', food: 'atún', category: 'wet-food', amount: '2 latas', expiry: 'vence 01/09/2026' })],
  });
  assert.equal(draft.lines[0]!.expiresAt, new Date(2026, 8, 1, 12).getTime());
  const review = reviewDonation(draft, null, NOW);
  assert.ok(review.lines[0]!.warnings.some((w) => w.kind === 'expired'));
});

test('an expiry with no year is shown, not completed', () => {
  const text = 'hígado 2 kg vence 20/09';
  const draft = draftFrom(text, {
    donor: null,
    items: [item({ snippet: 'hígado 2 kg vence 20/09', food: 'hígado', category: 'offal', amount: '2 kg', expiry: 'vence 20/09' })],
  });
  assert.equal(draft.lines[0]!.expiresAt, null);
  const review = reviewDonation(draft, null, NOW);
  assert.ok(review.lines[0]!.warnings.some((w) => w.kind === 'expiry-no-year'));
});

// ─── the donation ────────────────────────────────────────────────────────────

test('a donation needs a date that is not tomorrow, and at least one line', () => {
  const base = draftFrom(TEXT, GOOD_ANSWER);
  assert.deepEqual(reviewDonation({ ...base, receivedAt: null }, null, NOW).errors, ['received-required']);
  assert.deepEqual(reviewDonation({ ...base, receivedAt: NOW + 86_400_000 }, null, NOW).errors, ['received-in-future']);
  assert.deepEqual(reviewDonation({ ...base, lines: [] }, null, NOW).errors, ['lines-required']);
});

test('the writer refuses an invalid donation instead of writing part of it', () => {
  const draft = draftFrom(TEXT, GOOD_ANSWER);
  const review = reviewDonation({ ...draft, receivedAt: null }, null, NOW);
  assert.throws(() => donationWrite(draft, review), /invalid donation/);
});

// ─── the schema, the prompt and the ladder ───────────────────────────────────

test('the schema offers exactly the categories the pantry knows', () => {
  assert.deepEqual([...FOOD_CATEGORY_VALUES].sort(), [...FOOD_CATEGORIES].sort());
});

test('PROMPT: the model copies and never calculates', () => {
  assert.match(FOOD_PARSE_SYSTEM, /COPIA, NO CALCULES/);
  assert.match(FOOD_PARSE_SYSTEM, /No conviertas unidades, no sumes, no\s+multipliques/);
});

test('PROMPT: the model includes unsafe foods rather than dropping them', () => {
  assert.match(FOOD_PARSE_SYSTEM, /INCLUYE TODO LO QUE SEA COMIDA, aunque no sea apto/);
});

test('PROMPT: third person, neutral Spanish, no voseo in its own instructions', () => {
  assert.match(FOOD_PARSE_SYSTEM, /tercera persona y no le hables\s+a nadie/);
  assert.deepEqual(findVoseo(stripQuoted(FOOD_PARSE_SYSTEM)), []);
});

test('LEAK: the prompt shares no four-word run with any eval case', () => {
  // The same check `eval:food-parse` refuses to run on, moved into CI so a leak
  // is caught before anyone spends a request. It fired on the first draft.
  const fixture = JSON.parse(
    readFileSync(join(process.cwd(), 'scripts', 'fixtures', 'food-parse-cases.json'), 'utf8')
  ) as { cases: { id: string; text: string }[] };
  const fold = (s: string) =>
    s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const prompt = ` ${fold(FOOD_PARSE_SYSTEM)} `;
  const leaked: string[] = [];
  for (const c of fixture.cases) {
    const words = fold(c.text).split(' ');
    for (let i = 0; i + 4 <= words.length; i++) {
      const gram = words.slice(i, i + 4).join(' ');
      if (prompt.includes(` ${gram} `)) leaked.push(`${c.id}: ${gram}`);
    }
  }
  assert.ok(fixture.cases.length >= 5);
  assert.deepEqual(leaked, []);
});

test('LADDER: donation parsing never touches a Flash-tier quota, and every tier is priced', () => {
  assert.ok(FOOD_PARSE_MODEL_LADDER.length >= 1);
  for (const model of FOOD_PARSE_MODEL_LADDER) {
    assert.match(model, /lite/, `${model} is not a Lite tier`);
    assert.equal(hasPricingRow(model), true, `${model} has no pricing row`);
  }
});

// ─── wiring: one retry policy, one clock ─────────────────────────────────────
//
// `src/lib/ai/food-parse.ts` imports `server-only` and cannot be loaded here, so
// these read its source. Crude, and evadable by indirection; they exist so the
// hand-rolled retry loop removed on 2026-09-13 cannot quietly come back.

/** Source with comments removed, so a comment naming a call cannot satisfy a check. */
function code(file: string): string {
  return readFileSync(join(process.cwd(), file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('WIRING: donation parsing retries through retryWithinDeadline, with no retry loop of its own', () => {
  const src = code('src/lib/ai/food-parse.ts');
  assert.match(src, /retryWithinDeadline\(/, 'must retry through retryWithinDeadline');
  assert.match(src, /walkModelLadder\(/, 'must walk the ladder under one deadline');
  assert.match(src, /abortSignal:\s*AbortSignal\.timeout\(budgetMs\)/, 'each attempt gets the budget retryWithinDeadline sizes');
  assert.match(src, /maxRetries:\s*0/, "the SDK's own retries must stay off");
  for (const piece of ['for (let attempt', 'SUGGEST_MAX_ATTEMPTS', 'retryBackoffMsFor', 'isRetryableFailure', 'SUGGEST_MIN_RETRY_MS']) {
    assert.equal(src.includes(piece), false, `${piece} belongs to retryWithinDeadline, not to food-parse.ts`);
  }
});

test('WIRING: the parse route counts the deadline from the moment the request arrived', () => {
  const src = code('src/app/api/food/parse/route.ts');
  const arrived = src.indexOf('const arrivedAt = Date.now()');
  const firstAwait = src.indexOf('await ');
  assert.ok(arrived >= 0, 'the route must note when the request arrived');
  assert.ok(arrived < firstAwait, 'arrivedAt must be taken before the first await');
  assert.match(
    src,
    /parseDonationText\(text,\s*\{\s*deadline:\s*arrivedAt\s*\+\s*SUGGEST_TOTAL_BUDGET_MS/,
    'the route must pass that deadline to parseDonationText'
  );
});
