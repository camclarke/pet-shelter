/**
 * The public dossier's extra lines: age range, colour and coat, sterilization,
 * and the story. Each rule is a pure function, so it is tested without a page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { t } from '@/i18n';
import { dossierAgeRange, dossierFacts, storyParagraphs } from '../dossier';

const base = {
  species: 'dog' as const,
  sex: 'female' as const,
  breed: 'mestiza',
  size: 'medium' as const,
  ageMonths: 24,
  ageMonthsMin: 12,
  ageMonthsMax: 36,
  ageIsEstimate: true,
};

// ─── sterilization: three-state ──────────────────────────────────────────────

test('sterilized: null shows NOTHING, never "sin esterilizar"', () => {
  assert.equal(t.sterilizedStatus(null, 'female'), null);
  assert.equal(t.sterilizedStatus(undefined, 'male'), null);
  assert.equal(t.sterilizedStatus(null, null), null);
});

test('sterilized: true agrees with the sex, and is gender-free when it is unknown', () => {
  assert.equal(t.sterilizedStatus(true, 'female'), 'Esterilizada');
  assert.equal(t.sterilizedStatus(true, 'male'), 'Esterilizado');
  assert.equal(t.sterilizedStatus(true, null), 'Esterilización realizada');
});

test('sterilized: false is the gender-free "Sin esterilizar"', () => {
  for (const sex of ['male', 'female', null] as const) {
    assert.equal(t.sterilizedStatus(false, sex), 'Sin esterilizar');
  }
});

// ─── colour and coat ─────────────────────────────────────────────────────────

test('colour and coat are joined, either may be missing, both missing is null', () => {
  assert.equal(t.colorCoatLine('café', 'corto'), 'Color: café · Pelaje: corto');
  assert.equal(t.colorCoatLine('café', null), 'Color: café');
  assert.equal(t.colorCoatLine(null, '  largo '), 'Pelaje: largo');
  assert.equal(t.colorCoatLine('  ', ''), null);
  assert.equal(t.colorCoatLine(undefined, undefined), null);
});

// ─── age ─────────────────────────────────────────────────────────────────────

test('an estimated range replaces the single age instead of joining it', () => {
  assert.equal(dossierAgeRange(base), 'entre 1 y 3 años');
  const facts = dossierFacts(base);
  assert.match(facts, /entre 1 y 3 años/);
  assert.equal(facts.includes('2 años'), false, 'the midpoint must not be printed too');
});

test('without a usable range the single age stands, printed once', () => {
  for (const over of [
    { ageIsEstimate: false },
    { ageMonthsMin: null },
    { ageMonthsMax: null },
    { ageMonthsMin: 24, ageMonthsMax: 24 },
    { ageMonthsMin: 30, ageMonthsMax: 12 },
  ]) {
    const pet = { ...base, ...over };
    assert.equal(dossierAgeRange(pet), null, JSON.stringify(over));
    const facts = dossierFacts(pet);
    assert.equal(facts.match(/2 años/g)?.length, 1, `${JSON.stringify(over)}: ${facts}`);
  }
});

test('a pet published before the range fields existed does not throw', () => {
  const old = { ...base } as Record<string, unknown>;
  delete old.ageMonthsMin;
  delete old.ageMonthsMax;
  delete old.ageIsEstimate;
  assert.doesNotThrow(() => dossierFacts(old as unknown as typeof base));
});

// ─── the story ───────────────────────────────────────────────────────────────

test('storyParagraphs splits on blank lines and keeps single breaks inside one', () => {
  assert.deepEqual(storyParagraphs('Uno.\nsigue.\n\n\n  Dos.  \r\n\r\nTres.'), [
    'Uno.\nsigue.',
    'Dos.',
    'Tres.',
  ]);
});

test('no story, blank story or a non-string gives no paragraphs', () => {
  assert.deepEqual(storyParagraphs(undefined), []);
  assert.deepEqual(storyParagraphs(null), []);
  assert.deepEqual(storyParagraphs('  \n\n '), []);
});

test('the story is rendered as plain text nodes, never as HTML', () => {
  const page = readFileSync('src/app/adopt/[slug]/page.tsx', 'utf8');
  assert.equal(page.includes('dangerouslySetInnerHTML'), false);
  assert.match(page, /\{paragraph\}/);
});

test('the dossier no longer promises tiers it does not render', () => {
  const page = readFileSync('src/app/adopt/[slug]/page.tsx', 'utf8');
  assert.equal(page.includes('Pronto encontrarás'), false);
  assert.equal(page.includes('historial médico'), false);
});
