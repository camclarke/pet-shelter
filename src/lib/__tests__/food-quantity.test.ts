import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDecimalInput,
  parseKilogramsInput,
  parseQuantityPhrase,
} from '../food-quantity';

/**
 * Build-order step 13. Every expected gram count is a LITERAL, never derived
 * from the module's own constants — a test that multiplies by GRAMS_PER_UNIT
 * cannot fail when GRAMS_PER_UNIT is wrong.
 */

function grams(text: string): number | null {
  const parse = parseQuantityPhrase(text);
  return parse.kind === 'ok' ? parse.grams : null;
}

// ─── the decimal separator ───────────────────────────────────────────────────

test('a decimal COMMA and a decimal point read as the same mass', () => {
  assert.equal(grams('2,5 kg'), 2500);
  assert.equal(grams('2.5 kg'), 2500);
  assert.equal(grams('0,75 kg'), 750);
});

test('three decimals are REFUSED, never guessed as a thousands separator', () => {
  // "1.500 kg" is one and a half kilos to one person and 1 500 to another.
  assert.deepEqual(parseQuantityPhrase('1.500 kg'), { kind: 'too-precise' });
  assert.deepEqual(parseQuantityPhrase('1,500 kg'), { kind: 'too-precise' });
});

test('a trailing comma ends a clause and is not a decimal', () => {
  assert.equal(grams('2 kg,'), 2000);
  assert.equal(grams('12,5 kg.'), 12500);
});

// ─── the task's own example, line by line ────────────────────────────────────

test('"3 bolsas de arroz de 5 kg" is 15 kg, with the food word in between', () => {
  const parse = parseQuantityPhrase('3 bolsas de arroz de 5 kg');
  assert.deepEqual(parse, { kind: 'ok', grams: 15000, count: 3, packageUnit: 'bolsa', traditionalUnit: null });
  assert.equal(grams('3 bolsas de 5 kg'), 15000);
});

test('"2 kg de hígado" is 2 kg', () => {
  assert.equal(grams('2 kg de hígado'), 2000);
});

test('"un saco de croquetas de 15 kilos" is 15 kg', () => {
  assert.equal(grams('un saco de croquetas de 15 kilos'), 15000);
});

// ─── spoken forms ────────────────────────────────────────────────────────────

test('spoken halves and quarters', () => {
  assert.equal(grams('medio kilo'), 500);
  assert.equal(grams('kilo y medio'), 1500);
  assert.equal(grams('dos kilos y medio'), 2500);
  assert.equal(grams('un cuarto de kilo'), 250);
  assert.equal(grams('tres cuartos de kilo'), 750);
  assert.equal(grams('1/2 kg'), 500);
  assert.equal(grams('dos bolsas de medio kilo'), 1000);
});

test('grams in every common spelling, and a number glued to its unit', () => {
  assert.equal(grams('500 g'), 500);
  assert.equal(grams('500 gr'), 500);
  assert.equal(grams('500 gramos'), 500);
  assert.equal(grams('5kg'), 5000);
});

test('a count times a size', () => {
  assert.equal(grams('2 x 5 kg'), 10000);
  assert.equal(grams('2x5kg'), 10000);
});

test('Bolivian market units convert at the market convention, and SAY so', () => {
  // Quintal 46 kg = 4 arrobas of 11,5 kg = 100 libras of 460 g.
  assert.deepEqual(parseQuantityPhrase('un quintal de arroz'), {
    kind: 'ok',
    grams: 46000,
    count: null,
    packageUnit: null,
    traditionalUnit: 'quintal',
  });
  assert.equal(grams('2 arrobas'), 23000);
  assert.equal(grams('3 libras'), 1380);
});

// ─── what is NOT a mass ──────────────────────────────────────────────────────

test('containers with no size need a mass, and keep their count', () => {
  assert.deepEqual(parseQuantityPhrase('2 bolsas de arroz'), {
    kind: 'needs-mass',
    count: 2,
    packageUnit: 'bolsa',
  });
  assert.deepEqual(parseQuantityPhrase('6 presas de pollo'), {
    kind: 'needs-mass',
    count: 6,
    packageUnit: 'presa',
  });
  assert.deepEqual(parseQuantityPhrase('media bolsa'), {
    kind: 'needs-mass',
    count: 0.5,
    packageUnit: 'bolsa',
  });
});

test('a volume is a quantity, but the pantry is kept in mass', () => {
  assert.deepEqual(parseQuantityPhrase('5 litros de leche'), {
    kind: 'needs-mass',
    count: 5,
    packageUnit: 'litro',
  });
});

test('no number at all is not a quantity, and an article is not a stray number', () => {
  assert.deepEqual(parseQuantityPhrase('arroz'), { kind: 'no-quantity' });
  assert.deepEqual(parseQuantityPhrase('un poco de arroz'), { kind: 'no-quantity' });
  assert.deepEqual(parseQuantityPhrase('   '), { kind: 'empty' });
});

// ─── one quantity per line ───────────────────────────────────────────────────

test('two quantities on one line are ambiguous, never multiplied', () => {
  // Reading this as 3 × 2 kg = 6 kg would be a confident wrong number.
  assert.deepEqual(parseQuantityPhrase('3 bolsas de arroz y 2 kg de hígado'), { kind: 'ambiguous' });
  assert.deepEqual(parseQuantityPhrase('3 bolsas de arroz, 2 kg de hígado'), { kind: 'ambiguous' });
  assert.deepEqual(parseQuantityPhrase('1 kg 500 g'), { kind: 'ambiguous' });
});

test('a stray digit makes a phrase ambiguous', () => {
  assert.deepEqual(parseQuantityPhrase('croquetas 3 en 1 de 15 kg'), { kind: 'ambiguous' });
});

// ─── the edges ───────────────────────────────────────────────────────────────

test('zero kilograms parses as zero — the validator, not the parser, refuses it', () => {
  assert.equal(grams('0 kg'), 0);
});

test('a mass typed off the scale, in kilograms', () => {
  assert.deepEqual(parseKilogramsInput('15,5'), {
    kind: 'ok',
    grams: 15500,
    count: null,
    packageUnit: null,
    traditionalUnit: null,
  });
  assert.equal((parseKilogramsInput('15.5 kg') as { grams: number }).grams, 15500);
  assert.deepEqual(parseKilogramsInput('15.500'), { kind: 'too-precise' });
  assert.deepEqual(parseKilogramsInput(''), { kind: 'empty' });
  assert.deepEqual(parseKilogramsInput('quince'), { kind: 'ok', grams: 15000, count: null, packageUnit: null, traditionalUnit: null });
  assert.deepEqual(parseKilogramsInput('mucho'), { kind: 'no-quantity' });
});

test('a plain decimal field refuses signs and words', () => {
  assert.deepEqual(parseDecimalInput('2,5'), { kind: 'ok', value: 2.5 });
  assert.deepEqual(parseDecimalInput('-3'), { kind: 'invalid' });
  assert.deepEqual(parseDecimalInput('dos'), { kind: 'invalid' });
  assert.deepEqual(parseDecimalInput('1,255'), { kind: 'too-precise' });
  assert.deepEqual(parseDecimalInput(''), { kind: 'empty' });
});
