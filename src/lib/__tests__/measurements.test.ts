import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WEIGHT_MAX_KG,
  daysSinceMeasured,
  latestBodyCondition,
  latestWeight,
  measuredWeightKg,
  measurementDraftDefaults,
  measurementWarnings,
  parseWeightInput,
  previousWeight,
  validateMeasurementDraft,
  type MeasurementDraft,
} from '../measurements';
import { es } from '@/i18n/es';

/**
 * Build-order step 10. Every threshold below is written as a LITERAL rather
 * than read back from the module's constant: a test that compares a function
 * against the constant the function itself uses cannot fail when the constant
 * is wrong. That is the tautology the rabies-delay test had on 2026-08-27.
 */

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-12T16:00:00Z');

function draft(over: Partial<MeasurementDraft> = {}): MeasurementDraft {
  return {
    ...measurementDraftDefaults(),
    weightText: '12,5',
    measuredAt: NOW - DAY,
    ...over,
  };
}

function reading(id: string, weightKg: number | null, daysAgo: number, bcs: number | null = null) {
  return { id, weightKg, bcs, measuredAt: NOW - daysAgo * DAY };
}

// ─── reading a typed weight: the separator is a dosing hazard ────────────────

test('a decimal COMMA and a decimal point read as the same weight', () => {
  assert.deepEqual(parseWeightInput('12,5'), { kind: 'ok', kg: 12.5 });
  assert.deepEqual(parseWeightInput('12.5'), { kind: 'ok', kg: 12.5 });
  assert.deepEqual(parseWeightInput('0,85'), { kind: 'ok', kg: 0.85 });
});

test('three decimals are REFUSED, never guessed', () => {
  // "12.500" is 12.5 kg on a scale display and twelve thousand five hundred in
  // Bolivian notation. Either guess is a factor of a thousand in a dose.
  assert.deepEqual(parseWeightInput('12.500'), { kind: 'too-precise' });
  assert.deepEqual(parseWeightInput('12,500'), { kind: 'too-precise' });
  assert.deepEqual(parseWeightInput('12,25'), { kind: 'ok', kg: 12.25 });
});

test('a sign, a thousands separator or a second separator is unreadable', () => {
  for (const text of ['-3', '1.250,5', '12,5,3', 'doce', ',5', '12,', '12 5']) {
    assert.deepEqual(parseWeightInput(text), { kind: 'invalid' }, text);
  }
});

test('a trailing kg and surrounding spaces are accepted', () => {
  assert.deepEqual(parseWeightInput(' 12,5 kg '), { kind: 'ok', kg: 12.5 });
  assert.deepEqual(parseWeightInput('12,5KG'), { kind: 'ok', kg: 12.5 });
});

test('a blank weight is EMPTY, not zero', () => {
  assert.deepEqual(parseWeightInput(''), { kind: 'empty' });
  assert.deepEqual(parseWeightInput('   '), { kind: 'empty' });
  assert.deepEqual(parseWeightInput('kg'), { kind: 'empty' });
});

test('a weight the locale writes reads back as exactly the same number', () => {
  // The edit form prefills with formatKgInput; a value that did not survive
  // the round trip would silently change a weight nobody touched.
  for (const kg of [0.85, 2.5, 12.5, 12.25, 30, 199.99]) {
    assert.deepEqual(parseWeightInput(es.formatKgInput(kg)), { kind: 'ok', kg }, String(kg));
  }
});

test('the Spanish weight uses a decimal comma and no grouping', () => {
  assert.equal(es.formatKg(12.5), '12,5 kg');
  assert.equal(es.formatKg(0.85), '0,85 kg');
  assert.equal(es.formatKg(30), '30 kg');
  assert.equal(es.formatKgInput(1250), '1250');
  assert.equal(es.formatKgRange(18, 26), '18–26 kg');
});

test('every body-condition score has its band in Spanish', () => {
  for (let score = 1; score <= 9; score++) {
    assert.match(es.bodyConditionLabel(score), new RegExp(`^${score} · \\p{L}`, 'u'));
  }
});

// ─── what counts as a measurement ────────────────────────────────────────────

test('weight-only, score-only and muscle-only readings are each valid', () => {
  // The vet scores body condition; the animal is not always on the scale.
  assert.deepEqual(validateMeasurementDraft(draft({ weightText: '12,5' }), NOW), []);
  assert.deepEqual(validateMeasurementDraft(draft({ weightText: '', bcs: 4 }), NOW), []);
  assert.deepEqual(validateMeasurementDraft(draft({ weightText: '', mcs: 'mild' }), NOW), []);
});

test('a reading with nothing measured is rejected, even with a note', () => {
  const errors = validateMeasurementDraft(draft({ weightText: '', note: 'se portó bien' }), NOW);
  assert.ok(errors.includes('nothing-measured'));
});

test('an unreadable weight does not ALSO claim nothing was measured', () => {
  assert.deepEqual(validateMeasurementDraft(draft({ weightText: '12.500' }), NOW), [
    'weight-too-precise',
  ]);
  assert.deepEqual(validateMeasurementDraft(draft({ weightText: 'doce' }), NOW), [
    'weight-invalid',
  ]);
});

test('a zero weight is rejected', () => {
  assert.deepEqual(validateMeasurementDraft(draft({ weightText: '0' }), NOW), [
    'weight-not-positive',
  ]);
  assert.deepEqual(validateMeasurementDraft(draft({ weightText: '0,00' }), NOW), [
    'weight-not-positive',
  ]);
});

test('200 kg is accepted and anything above it is a typo', () => {
  assert.deepEqual(validateMeasurementDraft(draft({ weightText: '200' }), NOW), []);
  assert.deepEqual(validateMeasurementDraft(draft({ weightText: '200,01' }), NOW), [
    'weight-too-heavy',
  ]);
  assert.equal(WEIGHT_MAX_KG, 200);
});

test('a body-condition score outside 1-9, or between points, is rejected', () => {
  for (const bcs of [0, 10, 4.5]) {
    assert.ok(
      validateMeasurementDraft(draft({ bcs }), NOW).includes('bcs-out-of-range'),
      String(bcs)
    );
  }
  for (const bcs of [1, 9]) {
    assert.deepEqual(validateMeasurementDraft(draft({ bcs }), NOW), [], String(bcs));
  }
});

test('the date is required, and a future date is rejected', () => {
  assert.ok(
    validateMeasurementDraft(draft({ measuredAt: null }), NOW).includes('measured-required')
  );
  assert.ok(
    validateMeasurementDraft(draft({ measuredAt: NOW + 2 * DAY }), NOW).includes(
      'measured-in-future'
    )
  );
});

test('a reading dated minutes ahead is NOT rejected — clocks drift', () => {
  // Firestore measured 2.7 s ahead of this machine; browser clocks drift by
  // minutes. Four minutes is inside the five-minute tolerance.
  assert.deepEqual(validateMeasurementDraft(draft({ measuredAt: NOW + 4 * 60_000 }), NOW), []);
});

test('the defaults never carry a weight', () => {
  // The intake photo's estimated range must never pre-fill a measurement.
  const defaults = measurementDraftDefaults();
  assert.equal(defaults.weightText, '');
  assert.equal(measuredWeightKg(defaults), null);
});

// ─── warnings never block ────────────────────────────────────────────────────

test('double the previous weight warns, and does not error', () => {
  const next = draft({ weightText: '20' });
  assert.deepEqual(measurementWarnings(next, { history: [reading('a', 10, 30)] }), [
    { kind: 'weight-jump', direction: 'up', previousKg: 10 },
  ]);
  assert.deepEqual(validateMeasurementDraft(next, NOW), []);
});

test('half the previous weight warns', () => {
  assert.deepEqual(
    measurementWarnings(draft({ weightText: '5' }), { history: [reading('a', 10, 30)] }),
    [{ kind: 'weight-jump', direction: 'down', previousKg: 10 }]
  );
});

test('a real change short of double or half does not warn', () => {
  // A growing puppy or a wasting dog changes by tens of percent, not x2.
  const history = [reading('a', 10, 30)];
  assert.deepEqual(measurementWarnings(draft({ weightText: '19,99' }), { history }), []);
  assert.deepEqual(measurementWarnings(draft({ weightText: '5,01' }), { history }), []);
});

test('with no previous weight there is nothing to compare, so silence', () => {
  assert.deepEqual(measurementWarnings(draft({ weightText: '40' }), { history: [] }), []);
  // A score-only reading is not a previous weight.
  assert.deepEqual(
    measurementWarnings(draft({ weightText: '40' }), { history: [reading('a', null, 5, 5)] }),
    []
  );
});

test('a correction is not compared against the typo it corrects', () => {
  // Fixing "125" to "12,5" must not warn that the fix is a tenth of the typo.
  const history = [reading('earlier', 12, 60), reading('typo', 125, 1)];
  const correction = draft({ weightText: '12,5', measuredAt: NOW - DAY });
  assert.deepEqual(measurementWarnings(correction, { history, editingId: 'typo' }), []);
});

test('a weight taken AFTER this reading is not its previous weight', () => {
  // Back-dating an old vet-visit weight compares it with what came before it.
  const history = [reading('before', 10, 90), reading('after', 30, 1)];
  const backdated = draft({ weightText: '11', measuredAt: NOW - 60 * DAY });
  assert.deepEqual(measurementWarnings(backdated, { history }), []);
});

test('the previous weight is the most recent earlier one, whatever the order', () => {
  const history = [reading('recent', 20, 2), reading('old', 5, 200)];
  const expected = { kg: 20, measuredAt: NOW - 2 * DAY };
  assert.deepEqual(previousWeight(history, NOW, null), expected);
  assert.deepEqual(previousWeight([...history].reverse(), NOW, null), expected);
});

test('a weight far past the species warns — usually a missing comma', () => {
  assert.deepEqual(measurementWarnings(draft({ weightText: '125' }), { species: 'dog' }), [
    { kind: 'weight-unusual-for-species', species: 'dog', aboveKg: 90 },
  ]);
  assert.deepEqual(measurementWarnings(draft({ weightText: '13' }), { species: 'cat' }), [
    { kind: 'weight-unusual-for-species', species: 'cat', aboveKg: 12 },
  ]);
  // The same 13 kg is an ordinary dog.
  assert.deepEqual(measurementWarnings(draft({ weightText: '13' }), { species: 'dog' }), []);
});

test('no species, or an unknown one, never warns on size', () => {
  assert.deepEqual(measurementWarnings(draft({ weightText: '150' }), { species: 'other' }), []);
  assert.deepEqual(measurementWarnings(draft({ weightText: '150' }), {}), []);
});

test('an unreadable weight produces no warnings, only its error', () => {
  const ctx = { species: 'dog' as const, history: [reading('a', 1, 3)] };
  assert.deepEqual(measurementWarnings(draft({ weightText: '12.500' }), ctx), []);
});

// ─── history ─────────────────────────────────────────────────────────────────

test('the latest weight skips a score-only reading', () => {
  const history = [reading('scored', null, 1, 4), reading('weighed', 18, 10)];
  assert.deepEqual(latestWeight(history), { kg: 18, measuredAt: NOW - 10 * DAY });
});

test('the latest weight is the newest one regardless of order', () => {
  const history = [reading('old', 10, 100), reading('new', 12, 3), reading('mid', 11, 50)];
  assert.equal(latestWeight(history)?.kg, 12);
});

test('no weighed reading means no weight — never zero', () => {
  assert.equal(latestWeight([]), null);
  assert.equal(latestWeight([reading('scored', null, 1, 5)]), null);
});

test('the latest body condition skips a weight-only reading', () => {
  const history = [reading('weighed', 18, 1), reading('scored', 17, 20, 6)];
  assert.deepEqual(latestBodyCondition(history), { bcs: 6, measuredAt: NOW - 20 * DAY });
});

test('a reading written seconds ago is 0 days old, never -1', () => {
  // Firestore's clock measured 2.7 s ahead of this machine on 2026-08-24.
  assert.equal(daysSinceMeasured(NOW + 2_700, NOW), 0);
  assert.equal(daysSinceMeasured(NOW - 3 * DAY - 1, NOW), 3);
});
