import test from 'node:test';
import assert from 'node:assert/strict';

import { es } from '@/i18n/es';
import { findVoseo } from '../ai/spanish-register';
import { rationFor } from '../rations';

/**
 * Build-order step 13: the food copy. Most of it is lookup tables, where a test
 * would only echo a string back. What IS worth pinning: the register, the pot
 * refusal that says WHY, and that a missing weight never prints a number.
 */

const NOW = Date.parse('2026-09-12T16:00:00Z');

test('no food label speaks voseo', () => {
  const found = Object.entries(es.food).flatMap(([key, value]) =>
    findVoseo(value).map((form) => `${key}: ${form}`)
  );
  assert.deepEqual(found, []);
});

test('GUARD: with no pot measurements the yield text says WHY, and gives no number', () => {
  const text = es.yieldEstimateText({ kind: 'no-kitchen-constants' });
  assert.match(text, /no están medidas la olla ni el cucharón/);
  assert.equal(/\d/.test(text), false);
});

test('a missing weight names the photo estimate and prints NO kilocalories', () => {
  const result = rationFor({ species: 'dog', ageMonths: 24, estimatedKgMin: 18, estimatedKgMax: 26 }, [], NOW);
  const text = es.rationSummary(result);
  assert.match(text, /Falta pesar/);
  assert.match(text, /no se usa/);
  assert.equal(/kcal/.test(text), false);
});

test('a weighed adult shows the reading, its age and the kcal range', () => {
  const result = rationFor({ species: 'dog', ageMonths: 24 }, [{ weightKg: 20, bcs: null, measuredAt: NOW - 10 * 86_400_000 }], NOW);
  const text = es.rationSummary(result);
  assert.match(text, /^Peso 20 kg, hace 10 días\./);
  assert.match(text, /1\.059–1\.192 kcal al día/);
});

test('grams read as kilos above a kilo, with the Bolivian comma and a real minus', () => {
  assert.equal(es.formatGrams(15000), '15 kg');
  assert.equal(es.formatGrams(500), '500 g');
  assert.equal(es.formatGrams(-2300), '−2,3 kg');
});

test('a toxic line left out of stock says so loudly', () => {
  const text = es.donationLineWarning({ kind: 'toxic-excluded', hazards: ['allium'] });
  assert.match(text, /NO suma al stock/);
  assert.match(text, /aunque esté cocido/);
});

test('a measured ratio always carries its n', () => {
  assert.equal(
    es.measuredRatioText('cooked-to-raw', { n: 3, median: 2.5, min: 2, max: 3 }),
    'Peso cocido entre peso crudo: 2,5 (entre 2 y 3), medido en 3 ollas.'
  );
});
