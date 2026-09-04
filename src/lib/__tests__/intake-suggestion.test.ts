import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_NAME_SUGGESTIONS,
  MAX_RESEMBLES,
  MAX_WEIGHT_RANGE_FACTOR,
  MAX_PLAUSIBLE_AGE_MONTHS,
  SUGGESTION_POLICY,
  cleanNameSuggestions,
  decideAge,
  decideBreed,
  decideSex,
  decideSize,
  decideWeight,
  meetsBar,
  normalizeResembles,
  reviewSuggestion,
  type RawPhotoSuggestion,
} from '../intake-suggestion';
import {
  coverPhotoFrom,
  isPrivatePhotoPath,
  mediaTierFor,
  storagePathFor,
} from '../types';

/**
 * A deliberately BLAND baseline: everything null, every confidence low, no
 * scale reference. Each test turns on exactly the thing it is testing, so a
 * passing assertion cannot be riding on an unrelated default.
 */
function suggestion(over: Partial<RawPhotoSuggestion> = {}): RawPhotoSuggestion {
  return {
    species: null,
    speciesConfidence: 'low',
    sex: null,
    sexConfidence: 'low',
    sexFromGenitalPhoto: false,
    apparentlySterilized: 'unknown',
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
    colorPattern: null,
    coatType: null,
    distinguishingMarks: null,
    generalObservations: null,
    weightKgMin: null,
    weightKgMax: null,
    weightConfidence: 'low',
    nameSuggestions: [],
    notes: null,
    ...over,
  };
}

// ─── the structural guarantee ────────────────────────────────────────────────

test('sex is refused unless the model actually saw genitalia', () => {
  // Replaces the old "sex can never be suggested" guarantee, reversed by the
  // owner on 2026-08-30. The narrower rule is the one that still holds: a body
  // shot is not evidence of sex, however confident the model sounds.
  const guessed = decideSex(
    suggestion({ sex: 'female', sexConfidence: 'high', sexFromGenitalPhoto: false })
  );
  assert.equal(guessed.sex, null);
  assert.equal(guessed.refusedBecause, 'no-genital-photo');
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
      colorPattern: '  negro y blanco  ',
      coatType: '  doble capa  ',
      weightKgMin: 8,
      weightKgMax: 12,
      weightConfidence: 'high',
      sex: 'female',
      sexConfidence: 'high',
      sexFromGenitalPhoto: true,
    })
  );
  assert.equal(r.species, 'dog');
  assert.equal(r.size, 'medium');
  assert.equal(r.age.refused, false);
  assert.deepEqual(r.names, ['Luna', 'Nube']);
  assert.equal(r.visibleType, 'mestizo con rasgos de pastor');
  assert.equal(r.colorPattern, 'negro y blanco');
  assert.equal(r.coatType, 'doble capa');
  assert.equal(r.weight.refused, false);
  assert.equal(r.weight.isEstimate, true);
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

// ─────────────────────────────────────────────────────────────────────────────
// Weight — a guess from a photograph, and it must never look like more
// ─────────────────────────────────────────────────────────────────────────────

test('weight is refused outright without a scale reference', () => {
  // A lone animal in a frame fits a 4kg dog and a 40kg one. This is the most
  // important refusal in the file: the rescuer has no balance, so a number
  // here is the only weight the record has until a vet arrives.
  const w = decideWeight(
    suggestion({ weightKgMin: 8, weightKgMax: 12, weightConfidence: 'high', hasSizeReference: false })
  );
  assert.equal(w.refused, true);
  assert.equal(w.weightKgMin, null);
  assert.equal(w.weightKgMax, null);
});

test('weight is refused when the range is too wide to act on', () => {
  // Ratio, not difference: 2-6kg and 40-44kg are both 4kg wide and only the
  // first is a useful answer.
  const w = decideWeight(
    suggestion({ weightKgMin: 5, weightKgMax: 20, weightConfidence: 'high', hasSizeReference: true })
  );
  assert.equal(MAX_WEIGHT_RANGE_FACTOR, 3);
  assert.equal(w.refused, true);
});

test('a usable weight range survives and is always flagged an estimate', () => {
  const w = decideWeight(
    suggestion({ weightKgMin: 8, weightKgMax: 12, weightConfidence: 'high', hasSizeReference: true })
  );
  assert.equal(w.refused, false);
  assert.equal(w.weightKgMin, 8);
  assert.equal(w.weightKgMax, 12);
  // There is no honest path to false here. A photograph cannot measure.
  assert.equal(w.isEstimate, true);
});

test('weight is refused on an inverted range', () => {
  const w = decideWeight(
    suggestion({ weightKgMin: 20, weightKgMax: 8, weightConfidence: 'high', hasSizeReference: true })
  );
  assert.equal(w.refused, true);
});

test('weight is refused on implausible values', () => {
  const tiny = decideWeight(
    suggestion({ weightKgMin: 0.05, weightKgMax: 0.1, weightConfidence: 'high', hasSizeReference: true })
  );
  assert.equal(tiny.refused, true);
  const huge = decideWeight(
    suggestion({ weightKgMin: 90, weightKgMax: 200, weightConfidence: 'high', hasSizeReference: true })
  );
  assert.equal(huge.refused, true);
});

test('weight is refused on low confidence', () => {
  const w = decideWeight(
    suggestion({ weightKgMin: 8, weightKgMax: 12, weightConfidence: 'low', hasSizeReference: true })
  );
  assert.equal(w.refused, true);
});

test('a refused weight is reported in withheld, never silently dropped', () => {
  const r = reviewSuggestion(suggestion({ hasSizeReference: false }));
  assert.ok(r.withheld.includes('weight'));
});

test('colour and coat are separate fields, not one string', () => {
  // They were one `coatDescription` until 2026-08-30. Colour is what someone
  // types searching for a lost dog; coat is what tells an adopter about
  // grooming. Merging them loses the search term.
  const r = reviewSuggestion(
    suggestion({ colorPattern: 'negro y blanco', coatType: 'corto y liso' })
  );
  assert.equal(r.colorPattern, 'negro y blanco');
  assert.equal(r.coatType, 'corto y liso');
});

// ─────────────────────────────────────────────────────────────────────────────
// Sex — added 2026-08-30 when guided capture made a genital photo available.
// Every rule here exists because sex inflects every Spanish sentence about the
// animal, so a wrong value is a page that reads as broken, not a wrong field.
// ─────────────────────────────────────────────────────────────────────────────

test('sex is read when the genital photo was supplied and confidence is high', () => {
  const d = decideSex(
    suggestion({ sex: 'male', sexConfidence: 'high', sexFromGenitalPhoto: true })
  );
  assert.equal(d.sex, 'male');
  assert.equal(d.refusedBecause, null);
});

test('sex needs a HIGH bar, not the usual medium', () => {
  // Deliberately stricter than every other field. Medium is good enough for a
  // breed guess nobody has to live with grammatically.
  const d = decideSex(
    suggestion({ sex: 'female', sexConfidence: 'medium', sexFromGenitalPhoto: true })
  );
  assert.equal(d.sex, null);
  assert.equal(d.refusedBecause, 'low-confidence');
});

test('a null sex with a genital photo still refuses rather than inventing one', () => {
  const d = decideSex(
    suggestion({ sex: null, sexConfidence: 'high', sexFromGenitalPhoto: true })
  );
  assert.equal(d.sex, null);
  // Asserting the REASON as well, not just the null. A break probe showed
  // that checking only `sex` let the guard be deleted with every test still
  // green — the null arrived either way, and only the explanation was lost.
  assert.equal(d.refusedBecause, 'low-confidence');
});

test('a refused sex is reported in withheld so the UI can ask for the photo', () => {
  const r = reviewSuggestion(suggestion({ sexFromGenitalPhoto: false }));
  assert.ok(r.withheld.includes('sex'));
});

test('sex is OFFERED, never prefilled', () => {
  // If this ever flips to prefill, a model-read sex reaches the public page
  // and inflects every sentence on it without anyone assenting.
  assert.equal(SUGGESTION_POLICY.sex, 'offer');
});

test('sterilisation evidence passes through without becoming a claim', () => {
  // It is what the model saw, not a clinical finding. The vet confirms.
  const r = reviewSuggestion(suggestion({ apparentlySterilized: 'yes' }));
  assert.equal(r.apparentlySterilized, 'yes');
});

// ─────────────────────────────────────────────────────────────────────────────
// Photo disclosure — which slots may ever be public
// ─────────────────────────────────────────────────────────────────────────────

test('a teeth or genital photo is NEVER public, even as the first photo', () => {
  // The rule that keeps an intimate photograph off a public adoption listing.
  // It had no coverage until a break probe emptied NEVER_PUBLIC_SLOTS and every
  // test stayed green. Position must not override the slot: slots are filled in
  // whatever order the animal tolerates being handled.
  assert.equal(mediaTierFor('genitals', 0), 'auth');
  assert.equal(mediaTierFor('genitals', 3), 'auth');
  assert.equal(mediaTierFor('teeth', 0), 'auth');
});

test('the first ordinary photo is the public cover', () => {
  assert.equal(mediaTierFor('front', 0), 'public');
  assert.equal(mediaTierFor('side', 0), 'public');
});

test('later ordinary photos are gated, matching public teaser / gated detail', () => {
  assert.equal(mediaTierFor('front', 1), 'auth');
  assert.equal(mediaTierFor('other', 2), 'auth');
});

// ─────────────────────────────────────────────────────────────────────────────
// Photo disclosure — where the bytes actually live
//
// mediaTierFor() decides what the APP renders. Until 2026-09-03 that was the
// only thing deciding anything: every slot was written to `pets/{petId}/x.jpg`,
// which storage.rules serves with `allow read: if true`, so a genital photo was
// measured returning 200 to an unauthenticated fetch. These tests cover the
// other half — the path the bytes are written to.
// ─────────────────────────────────────────────────────────────────────────────

test('a never-public slot is stored under a prefix the rules gate', () => {
  assert.equal(storagePathFor('pet1', 'm1', 'genitals'), 'pets/pet1/private/m1.jpg');
  assert.equal(storagePathFor('pet1', 'm1', 'teeth'), 'pets/pet1/private/m1.jpg');
});

test('an ordinary slot keeps the public path the wall and next.config expect', () => {
  assert.equal(storagePathFor('pet1', 'm1', 'front'), 'pets/pet1/m1.jpg');
  assert.equal(storagePathFor('pet1', 'm1', 'side'), 'pets/pet1/m1.jpg');
  assert.equal(storagePathFor('pet1', 'm1', 'other'), 'pets/pet1/m1.jpg');
});

test('the storage path agrees with the tier for EVERY slot', () => {
  // The coupling is the guarantee. A slot added to NEVER_PUBLIC_SLOTS must get
  // a private path automatically — if these two ever disagree, the app renders
  // a photo as gated while the bucket serves it to anyone.
  const slots = ['front', 'side', 'teeth', 'genitals', 'other'] as const;
  for (const slot of slots) {
    const gated = mediaTierFor(slot, 0) === 'auth';
    const priv = isPrivatePhotoPath(storagePathFor('pet1', 'm1', slot));
    if (slot === 'teeth' || slot === 'genitals') {
      assert.equal(gated, true, `${slot} must be gated`);
      assert.equal(priv, true, `${slot} must be stored privately`);
    } else {
      assert.equal(priv, false, `${slot} is a gallery photo`);
    }
  }
});

test('the public cover is never an intimate photo, even when taken first', () => {
  // Media is stored in CAPTURE order and the guided flow tolerates a genital
  // shot being first. coverPhoto lives on the public pets/{petId} document and
  // is what the adoption wall renders, so "first" is the wrong selector.
  const cover = coverPhotoFrom([
    { slot: 'genitals', url: '' },
    { slot: 'teeth', url: '' },
    { slot: 'front', url: 'https://example.test/front.jpg' },
  ]);
  assert.equal(cover, 'https://example.test/front.jpg');
});

test('the SLOT bars an intimate photo from the cover, not merely its empty url', () => {
  // A break probe found these two checks only coincidentally redundant: today
  // an intimate photo always carries url: '', so dropping the slot check left
  // every test green. The empty url is a consequence of not minting a token —
  // if these photos ever gain a signed URL for rendering, the slot check is the
  // only thing still standing between one and the public wall. So assert it
  // directly, with a url present.
  const cover = coverPhotoFrom([
    { slot: 'genitals', url: 'https://example.test/genitals.jpg' },
    { slot: 'front', url: 'https://example.test/front.jpg' },
  ]);
  assert.equal(cover, 'https://example.test/front.jpg');

  // And with no ordinary photo to fall back to, there is no cover at all.
  assert.equal(
    coverPhotoFrom([{ slot: 'teeth', url: 'https://example.test/teeth.jpg' }]),
    null,
  );
});

test('a pet photographed ONLY intimately has no cover at all, not an empty one', () => {
  // `media[0]?.url ?? null` would give '' here, because ?? does not catch the
  // empty string — and an empty src renders as a broken image on the wall.
  assert.equal(coverPhotoFrom([{ slot: 'genitals', url: '' }]), null);
  assert.equal(coverPhotoFrom([]), null);
});

test('an ordinary photo with no url is skipped rather than published empty', () => {
  // The second half of the guard, and a break probe showed it had no coverage.
  // `publishable?.url ?? null` yields '' when the found photo's url is '',
  // because ?? does not catch the empty string — and an empty coverPhoto
  // renders as a broken image on the wall rather than as no image.
  assert.equal(coverPhotoFrom([{ slot: 'front', url: '' }]), null);

  // It should fall through to a later photo that does have one.
  assert.equal(
    coverPhotoFrom([
      { slot: 'front', url: '' },
      { slot: 'side', url: 'https://example.test/side.jpg' },
    ]),
    'https://example.test/side.jpg',
  );
});

test('the cover is the first ordinary photo, preserving capture order', () => {
  assert.equal(
    coverPhotoFrom([
      { slot: 'front', url: 'https://example.test/a.jpg' },
      { slot: 'side', url: 'https://example.test/b.jpg' },
    ]),
    'https://example.test/a.jpg',
  );
});

test('isPrivatePhotoPath only matches the private prefix', () => {
  assert.equal(isPrivatePhotoPath('pets/abc/private/m.jpg'), true);
  assert.equal(isPrivatePhotoPath('pets/abc/m.jpg'), false);
  // A file literally NAMED private is not a private path — the segment matters.
  assert.equal(isPrivatePhotoPath('pets/abc/private.jpg'), false);
  assert.equal(isPrivatePhotoPath('medical/abc/card.jpg'), false);
  assert.equal(isPrivatePhotoPath('sightings/abc/private/m.jpg'), false);
});
