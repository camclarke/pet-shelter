import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cookBatchWarnings,
  cookedToRawRatio,
  dayToInstant,
  feedingLogId,
  gramsPerLadle,
  isFeedingLogId,
  parseServing,
  stockLines,
  stockMovementDeltaG,
  sumStock,
  validateCookBatch,
  validateStockMovement,
  yieldEstimate,
  type CalibrationBatch,
  type CookBatchDraft,
  type StockMovementDraft,
} from '../food-stock';
import { SHELTER } from '@/config/shelter';

/**
 * Build-order step 13, plan §12.2 and §12.5. Literals throughout, for the
 * reason the rations and measurement tests give.
 */

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-12T16:00:00Z');

// ─── the ledger ──────────────────────────────────────────────────────────────

test('stock is the SUM of signed entries, per category', () => {
  const totals = sumStock([
    { category: 'grain', deltaG: 15000 },
    { category: 'grain', deltaG: -4000 },
    { category: 'offal', deltaG: 2000 },
  ]);
  assert.equal(totals.grain, 11000);
  assert.equal(totals.offal, 2000);
  assert.equal(totals.kibble, 0);
});

test('a negative pantry is SHOWN as negative, never clamped to zero', () => {
  const lines = stockLines({ ...sumStock([]), grain: -2300, offal: 500 });
  assert.deepEqual(lines.find((l) => l.category === 'grain'), { kind: 'negative', category: 'grain', grams: -2300 });
  assert.deepEqual(lines.find((l) => l.category === 'offal'), { kind: 'in-stock', category: 'offal', grams: 500 });
  assert.deepEqual(lines.find((l) => l.category === 'meat'), { kind: 'empty', category: 'meat' });
  assert.equal(lines.length, 8);
});

// ─── manual movements ────────────────────────────────────────────────────────

function movement(over: Partial<StockMovementDraft> = {}): StockMovementDraft {
  return {
    kind: 'discard',
    category: 'grain',
    label: 'arroz con gorgojo',
    kgText: '2,5',
    direction: 'remove',
    occurredAt: NOW - DAY,
    note: null,
    ...over,
  };
}

test('a discard removes; a correction goes either way', () => {
  assert.equal(stockMovementDeltaG(movement()), -2500);
  // A discard cannot ADD, whatever the direction field says.
  assert.equal(stockMovementDeltaG(movement({ direction: 'add' })), -2500);
  assert.equal(stockMovementDeltaG(movement({ kind: 'correction', direction: 'add', note: 'conteo' })), 2500);
  assert.equal(stockMovementDeltaG(movement({ kind: 'correction', direction: 'remove', note: 'conteo' })), -2500);
});

test('a correction with no reason is refused', () => {
  assert.deepEqual(validateStockMovement(movement({ kind: 'correction', note: '  ' }), NOW), [
    'correction-reason-required',
  ]);
  assert.deepEqual(validateStockMovement(movement({ kind: 'correction', note: 'conteo del sábado' }), NOW), []);
});

test('movement quantities: ambiguous, zero, absurd, and the 2-tonne edge', () => {
  assert.deepEqual(validateStockMovement(movement({ kgText: '15.500' }), NOW), ['quantity-too-precise']);
  assert.deepEqual(validateStockMovement(movement({ kgText: '0' }), NOW), ['quantity-not-positive']);
  assert.deepEqual(validateStockMovement(movement({ kgText: '' }), NOW), ['quantity-required']);
  assert.deepEqual(validateStockMovement(movement({ kgText: '2000' }), NOW), []);
  assert.deepEqual(validateStockMovement(movement({ kgText: '2000,01' }), NOW), ['quantity-too-heavy']);
  assert.equal(stockMovementDeltaG(movement({ kgText: '2000,01' })), null);
});

test('a movement dated tomorrow is refused; one a minute ahead is clock skew', () => {
  assert.deepEqual(validateStockMovement(movement({ occurredAt: NOW + DAY }), NOW), ['occurred-in-future']);
  assert.deepEqual(validateStockMovement(movement({ occurredAt: NOW + 60_000 }), NOW), []);
});

// ─── cook batches ────────────────────────────────────────────────────────────

function batch(over: Partial<CookBatchDraft> = {}): CookBatchDraft {
  return {
    cookedAt: NOW - 3_600_000,
    inputs: [
      { category: 'grain', label: 'arroz', kgText: '5', toxicAcknowledged: false },
      { category: 'offal', label: 'hígado', kgText: '2,5', toxicAcknowledged: false },
    ],
    potFillLevel: 0.75,
    cookedKgText: '',
    ladlesText: '',
    dogsServedText: '',
    cookedBy: null,
    notes: null,
    ...over,
  };
}

test('a valid batch has no errors, with outcomes left for later', () => {
  assert.deepEqual(validateCookBatch(batch(), NOW), []);
});

test('SAFETY: a toxic food named as a pot input blocks until acknowledged', () => {
  const withOnion = batch({
    inputs: [{ category: 'vegetable', label: 'cebolla', kgText: '1', toxicAcknowledged: false }],
  });
  assert.deepEqual(validateCookBatch(withOnion, NOW), [
    { kind: 'input-toxic-unacknowledged', index: 0, hazards: ['allium'] },
  ]);
  const acknowledged = batch({
    inputs: [{ category: 'vegetable', label: 'cebolla', kgText: '1', toxicAcknowledged: true }],
  });
  assert.deepEqual(validateCookBatch(acknowledged, NOW), []);
});

test('a bone-in input only warns', () => {
  const draft = batch({
    inputs: [{ category: 'bone', label: 'espinazo', kgText: '3', toxicAcknowledged: false }],
  });
  assert.deepEqual(validateCookBatch(draft, NOW), []);
  assert.deepEqual(cookBatchWarnings(draft, null), [{ kind: 'input-caution', index: 0, hazards: ['bones'] }]);
});

test('a batch needs inputs, each with a category, a name and a real mass', () => {
  assert.deepEqual(validateCookBatch(batch({ inputs: [] }), NOW), [{ kind: 'inputs-required' }]);
  assert.deepEqual(
    validateCookBatch(batch({ inputs: [{ category: null, label: '', kgText: '0', toxicAcknowledged: false }] }), NOW),
    [
      { kind: 'input-category-required', index: 0 },
      { kind: 'input-label-required', index: 0 },
      { kind: 'input-quantity', index: 0, error: 'quantity-not-positive' },
    ]
  );
});

test('observed outcomes: ladles may be half, dogs may not; zero is not an outcome', () => {
  assert.deepEqual(validateCookBatch(batch({ ladlesText: '120,5', dogsServedText: '38', cookedKgText: '31,5' }), NOW), []);
  assert.deepEqual(validateCookBatch(batch({ ladlesText: '0' }), NOW), [{ kind: 'ladles-invalid' }]);
  assert.deepEqual(validateCookBatch(batch({ dogsServedText: '3,5' }), NOW), [{ kind: 'dogs-served-invalid' }]);
  assert.deepEqual(validateCookBatch(batch({ cookedKgText: '31.500' }), NOW), [{ kind: 'cooked-weight-invalid' }]);
  assert.deepEqual(validateCookBatch(batch({ potFillLevel: 1.5 }), NOW), [{ kind: 'pot-fill-invalid' }]);
  assert.deepEqual(validateCookBatch(batch({ cookedAt: NOW + DAY }), NOW), [{ kind: 'cooked-in-future' }]);
});

test('cooking more than the ledger holds WARNS, cumulatively per category', () => {
  const draft = batch({
    inputs: [
      { category: 'grain', label: 'arroz', kgText: '4', toxicAcknowledged: false },
      { category: 'grain', label: 'fideo', kgText: '3', toxicAcknowledged: false },
    ],
  });
  const stock = { ...sumStock([]), grain: 5000 };
  assert.deepEqual(cookBatchWarnings(draft, stock), [
    { kind: 'input-exceeds-stock', index: 1, category: 'grain', stockGrams: 5000 },
  ]);
  // No stock read, no stock warning: a warning about a number nobody has is noise.
  assert.deepEqual(cookBatchWarnings(draft, null), []);
  assert.deepEqual(validateCookBatch(draft, NOW), []);
});

// ─── calibration ─────────────────────────────────────────────────────────────

function measured(rawG: number, cookedWeightG: number | null, ladlesYielded: number | null, potFillLevel: number | null = null): CalibrationBatch {
  return { inputs: [{ rawG }], cookedWeightG, ladlesYielded, potFillLevel };
}

test('the cooked/raw ratio is the MEDIAN of batches that measured both, with n', () => {
  const ratio = cookedToRawRatio([
    measured(10000, 20000, null),
    measured(10000, 30000, null),
    measured(10000, 25000, null),
    measured(10000, null, 90), // not weighed after cooking — skipped, not zeroed
  ]);
  assert.deepEqual(ratio, { n: 3, median: 2.5, min: 2, max: 3 });
});

test('grams per ladle, even n', () => {
  assert.deepEqual(gramsPerLadle([measured(1, 30000, 100), measured(1, 30000, 120)]), {
    n: 2, median: 275, min: 250, max: 300,
  });
  assert.equal(gramsPerLadle([]), null);
});

// ─── the yield estimate is gated ─────────────────────────────────────────────

const FIVE_BATCHES = [0.5, 0.5, 0.5, 0.5, 0.5].map((fill) => measured(10000, 30000, 91, fill));

test('GUARD: with NO pot or ladle measurements there is no estimate, whatever the data', () => {
  assert.deepEqual(yieldEstimate({ potCapacityLitres: null, ladleVolumeMl: null }, FIVE_BATCHES, 0.8), {
    kind: 'no-kitchen-constants',
  });
  assert.deepEqual(yieldEstimate({ potCapacityLitres: 60, ladleVolumeMl: null }, FIVE_BATCHES, 0.8), {
    kind: 'no-kitchen-constants',
  });
  assert.deepEqual(yieldEstimate({ potCapacityLitres: 0, ladleVolumeMl: 300 }, FIVE_BATCHES, 0.8), {
    kind: 'no-kitchen-constants',
  });
});

test('GUARD: the shipped shelter config has no pot measurements, so no estimate ships', () => {
  assert.equal(SHELTER.kitchen.potCapacityLitres, null);
  assert.equal(SHELTER.kitchen.ladleVolumeMl, null);
  assert.equal(yieldEstimate(SHELTER.kitchen, FIVE_BATCHES, 0.8).kind, 'no-kitchen-constants');
});

test('with measurements but fewer than five batches, it is still calibrating', () => {
  assert.deepEqual(yieldEstimate({ potCapacityLitres: 60, ladleVolumeMl: 300 }, FIVE_BATCHES.slice(0, 4), 0.8), {
    kind: 'calibrating', n: 4, needed: 5,
  });
});

test('calibrated: geometry corrected by what this pot actually served, rounded down', () => {
  // 60 L / 300 ml = 200 ladles full. Half full served 91 of a possible 100, so
  // the correction is 0.91; at 80 % that is 160 × 0.91 = 145.6 → 145.
  assert.deepEqual(yieldEstimate({ potCapacityLitres: 60, ladleVolumeMl: 300 }, FIVE_BATCHES, 0.8), {
    kind: 'ok', ladles: 145, n: 5,
  });
  assert.deepEqual(yieldEstimate({ potCapacityLitres: 60, ladleVolumeMl: 300 }, FIVE_BATCHES, null), {
    kind: 'no-fill-level',
  });
});

// ─── dates from a date field ─────────────────────────────────────────────────

test('TODAY picked before noon becomes NOW, so it is not refused as the future', () => {
  // The trap: a date field gives local midday. At 09:00 that is three hours
  // ahead, past the five-minute skew the validators allow.
  const nineAm = new Date(2026, 8, 12, 9, 0).getTime();
  const todayMidday = new Date(2026, 8, 12, 12, 0).getTime();
  assert.equal(dayToInstant(todayMidday, nineAm), nineAm);
  assert.deepEqual(validateStockMovement(movement({ occurredAt: dayToInstant(todayMidday, nineAm) }), nineAm), []);
  // Without the helper, the same form is refused.
  assert.deepEqual(validateStockMovement(movement({ occurredAt: todayMidday }), nineAm), ['occurred-in-future']);
});

test('another day keeps its midday; a future day is still refused', () => {
  const nineAm = new Date(2026, 8, 12, 9, 0).getTime();
  const yesterday = new Date(2026, 8, 11, 12, 0).getTime();
  const tomorrow = new Date(2026, 8, 13, 12, 0).getTime();
  assert.equal(dayToInstant(yesterday, nineAm), yesterday);
  assert.equal(dayToInstant(tomorrow, nineAm), tomorrow);
  assert.deepEqual(validateStockMovement(movement({ occurredAt: dayToInstant(tomorrow, nineAm) }), nineAm), ['occurred-in-future']);
});

// ─── the day ─────────────────────────────────────────────────────────────────

test('the feeding log id is the LOCAL calendar day', () => {
  assert.equal(feedingLogId(new Date(2026, 8, 12, 23, 30).getTime()), '2026-09-12');
  assert.equal(isFeedingLogId('2026-09-12'), true);
  assert.equal(isFeedingLogId('2026-02-30'), false);
  assert.equal(isFeedingLogId('12-09-2026'), false);
});

test('servings are whole or half ladles; zero is a real serving', () => {
  assert.deepEqual(parseServing('2,5'), { kind: 'ok', ladles: 2.5 });
  assert.deepEqual(parseServing('0'), { kind: 'ok', ladles: 0 });
  assert.deepEqual(parseServing('2,3'), { kind: 'invalid' });
  assert.deepEqual(parseServing('21'), { kind: 'too-many' });
  assert.deepEqual(parseServing('-1'), { kind: 'invalid' });
  assert.deepEqual(parseServing(''), { kind: 'empty' });
});
