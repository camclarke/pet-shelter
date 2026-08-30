import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_NAME_SUGGESTIONS,
  MAX_RESEMBLES,
  MAX_PLAUSIBLE_AGE_MONTHS,
  SUGGESTION_POLICY,
  cleanNameSuggestions,
  decideAge,
  decideBreed,
  decideSize,
  meetsBar,
  normalizeResembles,
  reviewSuggestion,
  type RawPhotoSuggestion,
} from '../intake-suggestion';

/**
 * A deliberately BLAND baseline: everything null, every confidence low, no
 * scale reference. Each test turns on exactly the thing it is testing, so a
 * passing assertion cannot be riding on an unrelated default.
 */
function suggestion(over: Partial<RawPhotoSuggestion> = {}): RawPhotoSuggestion {
  return {
    species: null,
    speciesConfidence: 'low',
    visibleType: null,
    isLikelyPurebred: false,
    purebredGuess: null,
    resemblesBreeds: [],
    lifeStage: null,
    ageMonthsMin: null,
    ageMonthsMax: null,
    ageBasis: 'unknown',
    ageConfidence: 'low',
    size: null,
    sizeConfidence: 'low',
    hasSizeReference: false,
    coatDescription: null,
    distinguishingMarks: null,
    nameSuggestions: [],
    notes: null,
    ...over,
  };
}

// ─── the structural guarantee ────────────────────────────────────────────────

test('sex is not a field a suggestion can carry', () => {
  // The guarantee is structural, not a runtime check: there is nowhere in
  // RawPhotoSuggestion to put a sex, so no prompt change can reintroduce one.
  // If someone adds the key, this fails to compile rather than failing here.
  const s = suggestion();
  assert.equal('sex' in s, false);
  assert.equal(Object.keys(s).includes('sex'), false);
});

// ─── confidence bar ──────────────────────────────────────────────────────────

test('the confidence bar admits medium and high, rejects low', () => {
  assert.equal(meetsBar('low'), false);
  assert.equal(meetsBar('medium'), true);
  assert.equal(meetsBar('high'), true);
});

test('a high bar admits only high', () => {
  assert.equal(meetsBar('medium', 'high'), false);
  assert.equal(meetsBar('high', 'high'), true);
});

// ─── breed ───────────────────────────────────────────────────────────────────

test('breed defaults to mixed even when the model is confident about species', () => {
  const d = decideBreed(suggestion({ speciesConfidence: 'high', species: 'dog' }));
  assert.deepEqual(d, { kind: 'mixed', resembles: [] });
});

test('a purebred claim without high species confidence is still mixed', () => {
  const d = decideBreed(
    suggestion({
      isLikelyPurebred: true,
      purebredGuess: 'Pastor Alemán',
      speciesConfidence: 'medium',
    })
  );
  assert.deepEqual(d, { kind: 'mixed', resembles: [] });
});

test('a purebred claim WITH high confidence is offered as purebred', () => {
  const d = decideBreed(
    suggestion({
      isLikelyPurebred: true,
      purebredGuess: 'Pastor Alemán',
      speciesConfidence: 'high',
    })
  );
  assert.deepEqual(d, { kind: 'purebred', breed: 'Pastor Alemán' });
});

test('a blank purebred guess falls back to mixed rather than an empty breed', () => {
  const d = decideBreed(
    suggestion({ isLikelyPurebred: true, purebredGuess: '   ', speciesConfidence: 'high' })
  );
  assert.deepEqual(d, { kind: 'mixed', resembles: [] });
});

test('a breed decision is never a Spanish string — rendering needs sex', () => {
  // "mestizo" vs "mestiza" agrees with the animal's sex, and sex is never
  // suggested. So the decision layer must not emit the word at all.
  const d = decideBreed(suggestion());
  assert.equal(JSON.stringify(d).toLowerCase().includes('mestiz'), false);
});

// ─── age ─────────────────────────────────────────────────────────────────────

test('age is refused when the model gave no range', () => {
  assert.equal(decideAge(suggestion({ ageConfidence: 'high' })).refused, true);
});

test('a confident narrow range yields a midpoint and keeps the bounds', () => {
  const d = decideAge(
    suggestion({ ageMonthsMin: 4, ageMonthsMax: 7, ageConfidence: 'high', ageBasis: 'teeth' })
  );
  assert.equal(d.refused, false);
  assert.equal(d.ageMonthsMin, 4);
  assert.equal(d.ageMonthsMax, 7);
  assert.equal(d.ageMonths, 6); // round((4+7)/2) = round(5.5) = 6
  assert.equal(d.isEstimate, true);
});

test('an estimate is ALWAYS flagged as an estimate, never as a known age', () => {
  const d = decideAge(suggestion({ ageMonthsMin: 6, ageMonthsMax: 6, ageConfidence: 'high' }));
  assert.equal(d.refused, false);
  assert.equal(d.isEstimate, true);
});

test('backwards bounds are read as an interval, not refused', () => {
  const d = decideAge(
    suggestion({ ageMonthsMin: 9, ageMonthsMax: 3, ageConfidence: 'high' })
  );
  assert.equal(d.refused, false);
  assert.equal(d.ageMonthsMin, 3);
  assert.equal(d.ageMonthsMax, 9);
});

test('low confidence refuses even a narrow range', () => {
  const d = decideAge(suggestion({ ageMonthsMin: 4, ageMonthsMax: 6, ageConfidence: 'low' }));
  assert.equal(d.refused, true);
});

test('a range wider than two years is refused as false precision', () => {
  const d = decideAge(
    suggestion({ ageMonthsMin: 12, ageMonthsMax: 48, ageConfidence: 'high' })
  );
  assert.equal(d.refused, true);
  assert.equal(d.ageMonths, null);
});

test('a negative age is refused', () => {
  const d = decideAge(
    suggestion({ ageMonthsMin: -3, ageMonthsMax: 5, ageConfidence: 'high' })
  );
  assert.equal(d.refused, true);
});

test('an implausibly old animal is refused', () => {
  const d = decideAge(
    suggestion({
      ageMonthsMin: MAX_PLAUSIBLE_AGE_MONTHS + 1,
      ageMonthsMax: MAX_PLAUSIBLE_AGE_MONTHS + 2,
      ageConfidence: 'high',
    })
  );
  assert.equal(d.refused, true);
});

test('a non-finite bound is refused rather than producing NaN months', () => {
  const d = decideAge(
    suggestion({ ageMonthsMin: 4, ageMonthsMax: Number.POSITIVE_INFINITY, ageConfidence: 'high' })
  );
  assert.equal(d.refused, true);
  assert.equal(d.ageMonths, null);
});

// ─── size ────────────────────────────────────────────────────────────────────

test('size is refused with no scale reference, however confident the model is', () => {
  const d = decideSize(suggestion({ size: 'large', sizeConfidence: 'high' }));
  assert.equal(d, null);
});

test('size is offered when the photo had a scale reference', () => {
  const d = decideSize(
    suggestion({ size: 'medium', sizeConfidence: 'high', hasSizeReference: true })
  );
  assert.equal(d, 'medium');
});

test('a scale reference does not rescue low confidence', () => {
  const d = decideSize(
    suggestion({ size: 'small', sizeConfidence: 'low', hasSizeReference: true })
  );
  assert.equal(d, null);
});

// ─── names ───────────────────────────────────────────────────────────────────

test('name suggestions are trimmed and blanks dropped', () => {
  assert.deepEqual(cleanNameSuggestions(['  Luna ', '', '   ', 'Nube']), ['Luna', 'Nube']);
});

test('name suggestions de-duplicate case-insensitively', () => {
  assert.deepEqual(cleanNameSuggestions(['Luna', 'luna', 'LUNA']), ['Luna']);
});

test('name suggestions are capped', () => {
  const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  assert.equal(cleanNameSuggestions(many).length, MAX_NAME_SUGGESTIONS);
});

// ─── the whole decision ──────────────────────────────────────────────────────

test('reviewSuggestion names what it withheld instead of going quiet', () => {
  const r = reviewSuggestion(suggestion({ species: 'dog', speciesConfidence: 'low' }));
  assert.equal(r.species, null);
  assert.ok(r.withheld.includes('species'));
  assert.ok(r.withheld.includes('age'));
  assert.ok(r.withheld.includes('size'));
});

test('a good photo produces a full review with nothing withheld', () => {
  const r = reviewSuggestion(
    suggestion({
      species: 'dog',
      speciesConfidence: 'high',
      ageMonthsMin: 5,
      ageMonthsMax: 8,
      ageConfidence: 'high',
      ageBasis: 'teeth',
      size: 'medium',
      sizeConfidence: 'high',
      hasSizeReference: true,
      nameSuggestions: ['Luna', 'Nube'],
      visibleType: '  mestizo con rasgos de pastor  ',
    })
  );
  assert.equal(r.species, 'dog');
  assert.equal(r.size, 'medium');
  assert.equal(r.age.refused, false);
  assert.deepEqual(r.names, ['Luna', 'Nube']);
  assert.equal(r.visibleType, 'mestizo con rasgos de pastor');
  assert.deepEqual(r.withheld, []);
});

test('breed is offered, never prefilled', () => {
  // If this ever flips to 'prefill', a model-guessed breed reaches a public
  // adoption listing without anyone choosing it.
  assert.equal(SUGGESTION_POLICY.breed, 'offer');
});

test('size is offered, never prefilled', () => {
  assert.equal(SUGGESTION_POLICY.size, 'offer');
});

// ─────────────────────────────────────────────────────────────────────────────
// Breed resemblances — "mestizo con rasgos de …"
//
// "mestizo" alone is honest but tells an adopter nothing, which is why the
// resemblance exists. It must stay a RESEMBLANCE: the label says "con rasgos
// de", never a bare breed, because a confident wrong breed on a public listing
// attracts the wrong family and the animal comes back.
// ─────────────────────────────────────────────────────────────────────────────

test('resemblances are trimmed and blanks dropped', () => {
  assert.deepEqual(normalizeResembles(['  pastor alemán  ', '', '   ']), [
    'pastor alemán',
  ]);
});

test('resemblances fold duplicates that differ only by case or accent', () => {
  // A model returning both "husky" and "Husky" would otherwise render as
  // "con rasgos de husky y Husky", which reads as a bug to the shelter.
  assert.deepEqual(normalizeResembles(['husky', 'HUSKY', 'Húsky']), ['husky']);
});

test('resemblances collapse internal whitespace', () => {
  assert.deepEqual(normalizeResembles(['pastor    alemán']), ['pastor alemán']);
});

test('resemblances are capped, keeping the most-alike first', () => {
  // The model is told to order them most- to least-alike, so the cap must take
  // from the FRONT. Taking the tail would keep the weakest likenesses.
  const many = ['uno', 'dos', 'tres', 'cuatro'];
  assert.equal(MAX_RESEMBLES, 2);
  assert.deepEqual(normalizeResembles(many), ['uno', 'dos']);
});

test('an empty resemblance list is a valid answer, not a failure', () => {
  assert.deepEqual(normalizeResembles([]), []);
});

test('decideBreed carries resemblances on the mixed branch', () => {
  const d = decideBreed(
    suggestion({ resemblesBreeds: ['pastor alemán', 'husky siberiano'] })
  );
  assert.deepEqual(d, {
    kind: 'mixed',
    resembles: ['pastor alemán', 'husky siberiano'],
  });
});

test('a purebred decision carries no resemblances', () => {
  // Belt and braces: a purebred branch that also carried "con rasgos de" would
  // render two competing claims about the same animal.
  const d = decideBreed(
    suggestion({
      isLikelyPurebred: true,
      purebredGuess: 'beagle',
      speciesConfidence: 'high',
      resemblesBreeds: ['pastor alemán'],
    })
  );
  assert.deepEqual(d, { kind: 'purebred', breed: 'beagle' });
});

test('resemblances never turn a mixed animal into a purebred claim', () => {
  // The whole safety property in one assertion: whatever the model puts in
  // resemblesBreeds, the decision stays 'mixed' unless the purebred bar is met.
  const d = decideBreed(
    suggestion({ resemblesBreeds: ['pastor alemán'], speciesConfidence: 'high' })
  );
  assert.equal(d.kind, 'mixed');
});
