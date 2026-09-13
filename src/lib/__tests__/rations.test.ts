import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bodyConditionSuggestion,
  energyFactorFor,
  merMidpointKcal,
  potShares,
  rationFor,
  restingEnergyKcal,
} from '../rations';

/**
 * Build-order step 13, plan §12.3. Every threshold and factor is written as a
 * LITERAL: a test that compares a function against the constant the function
 * itself uses cannot fail when the constant is wrong.
 */

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-12T16:00:00Z');

function close(actual: number | null, expected: number, tolerance = 0.1) {
  assert.ok(actual !== null, `expected ~${expected}, got null`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ~${expected}, got ${actual}`);
}

function weighing(kg: number | null, daysAgo: number, bcs: number | null = null) {
  return { weightKg: kg, bcs, measuredAt: NOW - daysAgo * DAY };
}

// ─── RER ─────────────────────────────────────────────────────────────────────

test('RER is 70 × kg^0.75', () => {
  close(restingEnergyKcal(1), 70);
  close(restingEnergyKcal(10), 393.6);
  close(restingEnergyKcal(20), 662.0);
});

test('energy grows SUB-linearly: 40 kg needs ~2.83× a 10 kg dog, not 4×', () => {
  close(restingEnergyKcal(40)! / restingEnergyKcal(10)!, 2.83, 0.01);
});

test('0 kg, a negative, NaN and an impossible weight give NO number', () => {
  assert.equal(restingEnergyKcal(0), null);
  assert.equal(restingEnergyKcal(-3), null);
  assert.equal(restingEnergyKcal(Number.NaN), null);
  assert.equal(restingEnergyKcal(1250), null);
  assert.ok(restingEnergyKcal(200) !== null);
  assert.equal(restingEnergyKcal(200.5), null);
});

// ─── life stage ──────────────────────────────────────────────────────────────

test('puppies: ×3 under 4 months, ×2 from 4 to 12 months', () => {
  assert.deepEqual(energyFactorFor('dog', { ageMonths: 2 }), {
    kind: 'ok', stages: ['puppy-early'], min: 3, max: 3, growing: true,
  });
  assert.deepEqual(energyFactorFor('dog', { ageMonths: 4 }), {
    kind: 'ok', stages: ['puppy-late'], min: 2, max: 2, growing: true,
  });
  assert.deepEqual(energyFactorFor('dog', { ageMonths: 11 }), {
    kind: 'ok', stages: ['puppy-late'], min: 2, max: 2, growing: true,
  });
});

test('adult dogs ×1.6–1.8; kittens ×2.5; adult cats ×1.2–1.4', () => {
  assert.deepEqual(energyFactorFor('dog', { ageMonths: 12 }), {
    kind: 'ok', stages: ['adult-dog'], min: 1.6, max: 1.8, growing: false,
  });
  assert.deepEqual(energyFactorFor('cat', { ageMonths: 6 }), {
    kind: 'ok', stages: ['kitten'], min: 2.5, max: 2.5, growing: true,
  });
  assert.deepEqual(energyFactorFor('cat', { ageMonths: 36 }), {
    kind: 'ok', stages: ['adult-cat'], min: 1.2, max: 1.4, growing: false,
  });
});

test('an estimated age straddling a boundary spans BOTH factors, not the midpoint', () => {
  // Midpoint 4.5 months would pick ×2 alone and hide that it may be ×3.
  assert.deepEqual(energyFactorFor('dog', { ageMonths: 4, ageMonthsMin: 3, ageMonthsMax: 6 }), {
    kind: 'ok', stages: ['puppy-early', 'puppy-late'], min: 2, max: 3, growing: true,
  });
  assert.deepEqual(energyFactorFor('dog', { ageMonths: 16, ageMonthsMin: 2, ageMonthsMax: 30 }), {
    kind: 'ok', stages: ['puppy-early', 'puppy-late', 'adult-dog'], min: 1.6, max: 3, growing: true,
  });
});

test('rabbits are not modelled, and an unknown age picks no factor', () => {
  assert.deepEqual(energyFactorFor('rabbit', { ageMonths: 12 }), { kind: 'not-applicable' });
  assert.deepEqual(energyFactorFor('dog', { ageMonths: null }), { kind: 'age-unknown' });
  assert.deepEqual(energyFactorFor('dog', { ageMonths: -2 }), { kind: 'age-unknown' });
});

// ─── the weight: latestWeight only, never the photo ──────────────────────────

const ADULT_DOG = { species: 'dog' as const, ageMonths: 24 };

test('no measurement means NO number — "falta pesar"', () => {
  assert.deepEqual(rationFor(ADULT_DOG, [], NOW), { kind: 'no-weight', estimate: null });
});

test('the PHOTO ESTIMATE is carried for display and NEVER computed with', () => {
  const result = rationFor(
    { ...ADULT_DOG, estimatedKgMin: 18, estimatedKgMax: 26 },
    // A body-condition reading with no weight must not unlock a number either.
    [weighing(null, 3, 5)],
    NOW
  );
  assert.deepEqual(result, { kind: 'no-weight', estimate: { minKg: 18, maxKg: 26 } });
  assert.equal('rerKcal' in result, false);
});

test('a 0 kg reading is skipped, not computed', () => {
  assert.deepEqual(rationFor(ADULT_DOG, [weighing(0, 1)], NOW), { kind: 'no-weight', estimate: null });
});

test('an absurd stored weight is refused rather than printed as a standard', () => {
  const result = rationFor(ADULT_DOG, [weighing(1250, 1)], NOW);
  assert.equal(result.kind, 'implausible-weight');
});

test('an adult dog at 20 kg: RER 662, MER 1059–1192 kcal', () => {
  const result = rationFor(ADULT_DOG, [weighing(20, 10)], NOW);
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') return;
  close(result.rerKcal, 662.0);
  close(result.merMinKcal, 1059.2, 0.2);
  close(result.merMaxKcal, 1191.6, 0.2);
  assert.equal(result.weightDays, 10);
  assert.deepEqual(result.weight, { kg: 20, measuredAt: NOW - 10 * DAY });
});

test('the LATEST weighing is used, whatever order the history arrives in', () => {
  const result = rationFor(ADULT_DOG, [weighing(20, 2), weighing(35, 90), weighing(18, 40)], NOW);
  assert.equal(result.kind === 'ok' && result.weight.kg, 20);
});

test('a puppy weighed over 30 days ago is flagged stale; an adult is not', () => {
  const puppy = rationFor({ species: 'dog', ageMonths: 3 }, [weighing(4, 31)], NOW);
  assert.equal(puppy.kind === 'ok' && puppy.staleForGrowth, true);
  const puppyFresh = rationFor({ species: 'dog', ageMonths: 3 }, [weighing(4, 30)], NOW);
  assert.equal(puppyFresh.kind === 'ok' && puppyFresh.staleForGrowth, false);
  const adult = rationFor(ADULT_DOG, [weighing(20, 400)], NOW);
  assert.equal(adult.kind === 'ok' && adult.staleForGrowth, false);
});

test('a puppy at 4 kg and 3 months gets ×3', () => {
  const result = rationFor({ species: 'dog', ageMonths: 3 }, [weighing(4, 1)], NOW);
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') return;
  close(result.rerKcal, 198.0);
  close(result.merMinKcal, 594.0, 0.2);
  close(result.merMaxKcal, 594.0, 0.2);
});

test('a weight with no age gives RER and no MER', () => {
  const result = rationFor({ species: 'dog', ageMonths: null }, [weighing(10, 1)], NOW);
  assert.equal(result.kind, 'age-unknown');
  assert.equal('merMinKcal' in result, false);
});

// ─── body condition: suggestion, never change ────────────────────────────────

test('BCS 7 suggests reducing and re-scoring; BCS 3 suggests a health check first', () => {
  assert.deepEqual(bodyConditionSuggestion([weighing(null, 5, 7)], NOW), {
    kind: 'reduce-and-rescore', bcs: 7, days: 5,
  });
  assert.deepEqual(bodyConditionSuggestion([weighing(null, 5, 3)], NOW), {
    kind: 'increase-after-health-check', bcs: 3, days: 5,
  });
  assert.equal(bodyConditionSuggestion([weighing(null, 5, 6)], NOW), null);
  assert.equal(bodyConditionSuggestion([weighing(null, 5, 4)], NOW), null);
});

test('body condition does NOT change the computed energy', () => {
  const lean = rationFor(ADULT_DOG, [weighing(20, 1)], NOW);
  const heavy = rationFor(ADULT_DOG, [weighing(20, 1), weighing(null, 0, 9)], NOW);
  assert.equal(lean.kind, 'ok');
  assert.equal(heavy.kind, 'ok');
  if (lean.kind !== 'ok' || heavy.kind !== 'ok') return;
  assert.equal(heavy.merMinKcal, lean.merMinKcal);
  assert.equal(heavy.merMaxKcal, lean.merMaxKcal);
  assert.equal(heavy.suggestion?.kind, 'reduce-and-rescore');
});

// ─── shares of the pot ───────────────────────────────────────────────────────

test('the staff heuristic gives a big dog LESS of the pot than the standard', () => {
  // 5 kg and 30 kg adults; ladles 2 and 3. Energy ratio 6^0.75 ≈ 3.83, so the
  // standard shares are ~0.207 / ~0.793; the ladles give 0.4 / 0.6.
  const small = merMidpointKcal(rationFor(ADULT_DOG, [weighing(5, 1)], NOW));
  const big = merMidpointKcal(rationFor(ADULT_DOG, [weighing(30, 1)], NOW));
  const { rows, excluded } = potShares([
    { petId: 'small', merKcal: small, ladles: 2 },
    { petId: 'big', merKcal: big, ladles: 3 },
  ]);
  assert.deepEqual(excluded, []);
  const bySmall = rows.find((r) => r.petId === 'small')!;
  const byBig = rows.find((r) => r.petId === 'big')!;
  close(bySmall.standardShare, 0.207, 0.001);
  close(byBig.standardShare, 0.793, 0.001);
  close(bySmall.recordedShare, 0.4, 0.0001);
  assert.equal(byBig.divergence, 'under');
  assert.equal(bySmall.divergence, 'over');
});

test('matching shares flag nothing', () => {
  const { rows } = potShares([
    { petId: 'a', merKcal: 1000, ladles: 2 },
    { petId: 'b', merKcal: 1000, ladles: 2 },
  ]);
  assert.deepEqual(rows.map((r) => r.divergence), [null, null]);
});

test('no standard and no ration are EXCLUDED and named, not guessed', () => {
  const { rows, excluded } = potShares([
    { petId: 'weighed', merKcal: 900, ladles: 3 },
    { petId: 'unweighed', merKcal: null, ladles: 2 },
    { petId: 'unfed', merKcal: 800, ladles: 0 },
  ]);
  assert.deepEqual(excluded, [
    { petId: 'unweighed', reason: 'no-standard' },
    { petId: 'unfed', reason: 'no-ration' },
  ]);
  // One comparable dog is 100 % of itself, which says nothing.
  assert.deepEqual(rows, []);
});
