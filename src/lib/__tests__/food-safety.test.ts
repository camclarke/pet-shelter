import test from 'node:test';
import assert from 'node:assert/strict';

import {
  expiryWarning,
  findFoodHazards,
  hasToxicHazard,
  hazardsMissingFromLines,
  parseExpiryText,
  speciesRelevance,
} from '../food-safety';

/**
 * Build-order step 13, plan §12.4. Every hazard has its own named test, so a
 * deliberate-break probe that deletes one rule fails exactly one test by name.
 */

function hazards(text: string): string[] {
  return findFoodHazards(text).map((f) => f.hazard);
}

// ─── one test per hazard ─────────────────────────────────────────────────────

test('HAZARD allium: onion and garlic are flagged, cooked or not', () => {
  assert.deepEqual(hazards('una caja de verduras con cebolla'), ['allium']);
  assert.deepEqual(hazards('ajo en polvo'), ['allium']);
  assert.deepEqual(hazards('cebollín picado'), ['allium']);
  assert.deepEqual(hazards('cebollin picado'), ['allium']); // typed on a phone, no accent
});

test('HAZARD chocolate', () => {
  assert.deepEqual(hazards('galletas de chocolate'), ['chocolate']);
});

test('HAZARD caffeine', () => {
  assert.deepEqual(hazards('restos de café'), ['caffeine']);
});

test('HAZARD grapes: grapes and raisins', () => {
  assert.deepEqual(hazards('un kilo de uvas'), ['grapes']);
  assert.deepEqual(hazards('pan con pasas'), ['grapes']);
});

test('HAZARD xylitol', () => {
  assert.deepEqual(hazards('mantequilla de maní con xilitol'), ['xylitol']);
});

test('HAZARD macadamia', () => {
  assert.deepEqual(hazards('nueces de macadamia'), ['macadamia']);
});

test('HAZARD alcohol, in the words a Cochabamba donor uses', () => {
  assert.deepEqual(hazards('una botella de singani'), ['alcohol']);
  assert.deepEqual(hazards('sobras con chicha'), ['alcohol']);
});

test('HAZARD raw-dough', () => {
  assert.deepEqual(hazards('masa cruda de pan'), ['raw-dough']);
});

test('HAZARD avocado is a caution, not toxic', () => {
  const [finding] = findFoodHazards('dos paltas');
  assert.equal(finding?.hazard, 'avocado');
  assert.equal(finding?.severity, 'caution');
});

test('HAZARD bones: bone-in cuts are a caution, deshuesar antes de servir', () => {
  const [finding] = findFoodHazards('3 kg de espinazo');
  assert.equal(finding?.hazard, 'bones');
  assert.equal(finding?.severity, 'caution');
  assert.deepEqual(hazards('pollo con hueso'), ['bones']);
});

test('HAZARD spoilage', () => {
  assert.deepEqual(hazards('arroz con moho'), ['spoilage']);
  assert.deepEqual(hazards('carne podrida'), ['spoilage']);
});

// ─── matching ────────────────────────────────────────────────────────────────

test('letter-aware boundaries: "ajo" does not fire inside another word', () => {
  assert.deepEqual(hazards('pan con ajonjolí'), []);
  assert.deepEqual(hazards('lo trajo del trabajo'), []);
  assert.deepEqual(hazards('croquetas cafeteras'), []);
});

test('the verb "pasa" is not raisins', () => {
  assert.deepEqual(hazards('si pasa algo avisamos'), []);
});

test('"sin cebolla" is not flagged, and neither is "sin ajo ni cebolla"', () => {
  assert.deepEqual(hazards('caldo sin cebolla'), []);
  assert.deepEqual(hazards('arroz sin ajo ni cebolla'), []);
});

test('"no sé si trae cebolla" IS flagged — only "sin" negates', () => {
  assert.deepEqual(hazards('no sé si trae cebolla'), ['allium']);
});

test('several hazards in one text are all reported, once each', () => {
  assert.deepEqual(hazards('cebolla, ajo, uvas y hueso'), ['allium', 'grapes', 'bones']);
});

test('a hazard for no species this shelter takes is dropped', () => {
  // Xylitol is modelled as a dog hazard only.
  assert.deepEqual(findFoodHazards('chicle con xilitol y cebolla', ['cat']).map((f) => f.hazard), ['allium']);
  assert.deepEqual(findFoodHazards('chicle con xilitol', ['dog']).map((f) => f.hazard), ['xylitol']);
});

test('toxic keeps a line out of the pot by default; caution does not', () => {
  assert.equal(hasToxicHazard(['allium']), true);
  assert.equal(hasToxicHazard(['bones']), false);
  assert.equal(hasToxicHazard(['avocado']), false);
  assert.equal(hasToxicHazard([]), false);
});

test('a hazard the text names but no line carries is still reported', () => {
  // The parser made one "verduras" line; the sentence said onion.
  const missing = hazardsMissingFromLines('una caja de verduras (tenían cebolla)', ['verduras']);
  assert.deepEqual(missing.map((f) => f.hazard), ['allium']);
  assert.deepEqual(hazardsMissingFromLines('cebolla', ['cebolla']), []);
});

// ─── species relevance ───────────────────────────────────────────────────────

test('a stated species wins over the category default', () => {
  assert.deepEqual(speciesRelevance('kibble', 'croquetas para gato'), { stated: true, species: ['cat'] });
  assert.deepEqual(speciesRelevance('kibble', 'croquetas de cachorro'), { stated: true, species: ['dog'] });
});

test('kibble with no species is a QUESTION, not a default', () => {
  assert.deepEqual(speciesRelevance('kibble', 'un saco de croquetas'), {
    stated: false,
    species: [],
    needsAnswer: true,
  });
});

test('pot food defaults to dogs; meat to dogs and cats', () => {
  assert.deepEqual(speciesRelevance('grain', 'arroz'), { stated: false, species: ['dog'], needsAnswer: false });
  assert.deepEqual(speciesRelevance('meat', 'carne de res'), {
    stated: false,
    species: ['dog', 'cat'],
    needsAnswer: false,
  });
});

// ─── expiry ──────────────────────────────────────────────────────────────────

test('an expiry date is read day first, in any of the common separators', () => {
  const expected = new Date(2026, 9, 20, 12).getTime();
  assert.deepEqual(parseExpiryText('vence el 20/10/2026'), { kind: 'ok', at: expected });
  assert.deepEqual(parseExpiryText('20-10-26'), { kind: 'ok', at: expected });
  assert.deepEqual(parseExpiryText('20.10.2026'), { kind: 'ok', at: expected });
});

test('an impossible date is refused rather than rolled into the next month', () => {
  assert.deepEqual(parseExpiryText('31/02/2026'), { kind: 'invalid' });
  assert.deepEqual(parseExpiryText('10/13/2026'), { kind: 'invalid' });
});

test('a date with no year is NOT completed', () => {
  assert.deepEqual(parseExpiryText('vence 01/09'), { kind: 'no-year', day: 1, month: 9 });
  assert.deepEqual(parseExpiryText(''), { kind: 'none' });
  assert.deepEqual(parseExpiryText('octubre'), { kind: 'invalid' });
});

test('expired on arrival, expiring within three days, and fine', () => {
  const received = new Date(2026, 8, 12, 15).getTime();
  assert.equal(expiryWarning(new Date(2026, 8, 11, 12).getTime(), received), 'expired');
  assert.equal(expiryWarning(new Date(2026, 8, 12, 12).getTime(), received), 'expires-soon');
  assert.equal(expiryWarning(new Date(2026, 8, 15, 12).getTime(), received), 'expires-soon');
  assert.equal(expiryWarning(new Date(2026, 8, 16, 12).getTime(), received), null);
  assert.equal(expiryWarning(null, received), null);
});
