/**
 * Intake wizard logic tests.
 *
 * Run with:  node --test --import tsx src/lib/__tests__/intake.test.ts
 *
 * Two things here are worth more than the rest.
 *
 * `slugify` is the one that produces a PERMANENT public URL. Once a pet is
 * shared on WhatsApp and Facebook, `/adopt/<slug>` is an address other people
 * hold; getting it wrong is not a display bug, it is a dead link in someone
 * else's message thread. And the input is Spanish, so accents and ñ are the
 * normal case, not an edge case.
 *
 * `publishBlockers` is the gate between a half-typed record and the front page
 * of a live shelter's site. It has to be exactly as strict as the plan says —
 * steps 1 and 2 block, the story does not — because a gate that is too strict
 * gets worked around at 22:00 with a rescue in the car.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  canPublish,
  disambiguateSlug,
  draftDefaults,
  draftProgress,
  isValidSlug,
  publishBlockers,
  registerBlockers,
  canRegister,
  slugify,
  toAgeMonths,
  validateStep,
  MAX_AGE_MONTHS,
  type DraftMedia,
  type PetDraft,
} from '../intake';

function photo(overrides: Partial<DraftMedia> = {}): DraftMedia {
  return {
    id: 'm1',
    slot: 'front',
    path: 'pets/p1/cover.jpg',
    url: 'https://firebasestorage.googleapis.com/v0/b/wawitas-app/o/pets%2Fp1%2Fcover.jpg',
    alt: 'Perra mestiza color caramelo sentada en el patio',
    width: 1200,
    height: 1600,
    ...overrides,
  };
}

/** A draft that satisfies every blocking rule, so each test can break one. */
function completeDraft(overrides: Partial<PetDraft> = {}): PetDraft {
  return {
    ...draftDefaults('p1'),
    species: 'dog',
    name: 'Luna',
    breed: 'mestiza',
    sex: 'female',
    size: 'medium',
    ageYears: 1,
    ageMonthsPart: 2,
    slug: 'luna',
    media: [photo()],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// slugify
// ─────────────────────────────────────────────────────────────────────────────

test('slugify lowercases and hyphenates', () => {
  assert.equal(slugify('Luna'), 'luna');
  assert.equal(slugify('Don Pepe'), 'don-pepe');
});

test('slugify strips Spanish accents to their base letters', () => {
  assert.equal(slugify('Rubén'), 'ruben');
  assert.equal(slugify('Chiquitín'), 'chiquitin');
  assert.equal(slugify('Ángel'), 'angel');
  assert.equal(slugify('Güero'), 'guero');
});

test('slugify keeps ñ as n rather than dropping the letter', () => {
  // The failure this guards against is a name collapsing to something
  // unrecognisable or empty: "Ñoño" must not become "-o" or "".
  assert.equal(slugify('Ñoño'), 'nono');
  assert.equal(slugify('Muñeca'), 'muneca');
});

test('slugify collapses punctuation and runs of separators', () => {
  assert.equal(slugify('Bobby  --  Jr.'), 'bobby-jr');
  assert.equal(slugify('  Canela  '), 'canela');
  assert.equal(slugify('Max (el grande)'), 'max-el-grande');
});

test('slugify output always satisfies isValidSlug, or is empty', () => {
  for (const name of ['Luna', 'Ñoño', 'Don Pepe', 'Rubén 2', 'a-b-c', '  x  ']) {
    const slug = slugify(name);
    assert.ok(isValidSlug(slug), `${name} -> ${slug} failed the shape check`);
  }
});

test('slugify returns empty for a name with nothing slugifiable', () => {
  // Not a crash and not a fabricated slug: empty fails isValidSlug, which is
  // what surfaces `slug-invalid` to the admin instead of publishing at a URL
  // nobody could have predicted.
  assert.equal(slugify('¿?!'), '');
  assert.equal(isValidSlug(''), false);
});

test('isValidSlug rejects the shapes seed-pet.mjs also rejects', () => {
  assert.equal(isValidSlug('luna'), true);
  assert.equal(isValidSlug('don-pepe'), true);
  assert.equal(isValidSlug('Luna'), false);
  assert.equal(isValidSlug('luna-'), false);
  assert.equal(isValidSlug('-luna'), false);
  assert.equal(isValidSlug('luna--2'), false);
  assert.equal(isValidSlug('luna 2'), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// disambiguateSlug
// ─────────────────────────────────────────────────────────────────────────────

test('disambiguateSlug returns the base when it is free', () => {
  assert.equal(disambiguateSlug('luna', []), 'luna');
  assert.equal(disambiguateSlug('luna', ['pepe', 'canela']), 'luna');
});

test('disambiguateSlug starts at 2, because the first one has no suffix', () => {
  assert.equal(disambiguateSlug('luna', ['luna']), 'luna-2');
  assert.equal(disambiguateSlug('luna', ['luna', 'luna-2']), 'luna-3');
});

test('disambiguateSlug skips gaps rather than reusing a freed number', () => {
  // luna-2 was deleted. Reusing it would point a new animal at a URL already
  // shared for a different one.
  assert.equal(disambiguateSlug('luna', ['luna', 'luna-3']), 'luna-2');
});

test('a disambiguated slug is still a valid slug', () => {
  assert.ok(isValidSlug(disambiguateSlug('luna', ['luna'])));
});

// ─────────────────────────────────────────────────────────────────────────────
// toAgeMonths
// ─────────────────────────────────────────────────────────────────────────────

test('toAgeMonths combines years and months', () => {
  assert.equal(toAgeMonths(1, 2, false), 14);
  assert.equal(toAgeMonths(2, 0, false), 24);
  assert.equal(toAgeMonths(0, 3, false), 3);
});

test('toAgeMonths treats a missing half as zero, not as unknown', () => {
  // "3 meses" leaves the years box empty. That is 3, not null.
  assert.equal(toAgeMonths(null, 3, false), 3);
  assert.equal(toAgeMonths(2, null, false), 24);
});

test('toAgeMonths returns null when the age is explicitly unknown', () => {
  assert.equal(toAgeMonths(3, 4, true), null);
  assert.equal(toAgeMonths(null, null, true), null);
});

test('toAgeMonths returns null when nothing has been entered yet', () => {
  assert.equal(toAgeMonths(null, null, false), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// validateStep — identity
// ─────────────────────────────────────────────────────────────────────────────

test('a complete identity step reports no errors', () => {
  assert.deepEqual(validateStep('identity', completeDraft()), []);
});

test('a fresh draft reports every missing identity field', () => {
  const errors = validateStep('identity', draftDefaults('p1'));
  for (const expected of [
    'name-required',
    'species-required',
    'sex-required',
    'size-required',
    'breed-required',
    'age-required',
    'slug-invalid',
  ]) {
    assert.ok(errors.includes(expected as never), `expected ${expected}`);
  }
});

test('a whitespace-only name is not a name', () => {
  assert.ok(validateStep('identity', completeDraft({ name: '   ' })).includes('name-required'));
});

test('an explicitly unknown age satisfies the age requirement', () => {
  const draft = completeDraft({ ageYears: null, ageMonthsPart: null, ageUnknown: true });
  assert.deepEqual(validateStep('identity', draft), []);
});

test('an age beyond the ceiling is a typo, not a very old dog', () => {
  const draft = completeDraft({ ageYears: 99, ageMonthsPart: 0 });
  assert.ok(validateStep('identity', draft).includes('age-range'));
  // The boundary itself is allowed.
  const atLimit = completeDraft({ ageYears: MAX_AGE_MONTHS / 12, ageMonthsPart: 0 });
  assert.equal(validateStep('identity', atLimit).includes('age-range'), false);
});

test('a negative age is rejected', () => {
  assert.ok(validateStep('identity', completeDraft({ ageYears: -1 })).includes('age-range'));
});

test('hasMicrochip without a code is blocked, with a code is not', () => {
  const blank = completeDraft({ hasMicrochip: true, microchipCode: '  ' });
  assert.ok(validateStep('identity', blank).includes('microchip-required'));

  const filled = completeDraft({ hasMicrochip: true, microchipCode: '068123456789012' });
  assert.equal(validateStep('identity', filled).includes('microchip-required'), false);
});

test('an unchipped pet is never asked for a code', () => {
  const draft = completeDraft({ hasMicrochip: false, microchipCode: '' });
  assert.equal(validateStep('identity', draft).includes('microchip-required'), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// validateStep — media
// ─────────────────────────────────────────────────────────────────────────────

test('at least one photo is required', () => {
  assert.ok(validateStep('media', completeDraft({ media: [] })).includes('photo-required'));
});

test('every photo needs alt text, not just the first', () => {
  const draft = completeDraft({
    media: [photo({ id: 'a' }), photo({ id: 'b', alt: '' })],
  });
  assert.ok(validateStep('media', draft).includes('alt-required'));
});

test('whitespace does not count as alt text', () => {
  const draft = completeDraft({ media: [photo({ alt: '   ' })] });
  assert.ok(validateStep('media', draft).includes('alt-required'));
});

// ─────────────────────────────────────────────────────────────────────────────
// publishBlockers — the gate to the public wall
// ─────────────────────────────────────────────────────────────────────────────

test('a draft with identity and media can publish', () => {
  assert.deepEqual(publishBlockers(completeDraft()), []);
  assert.equal(canPublish(completeDraft()), true);
});

test('an empty story does NOT block publishing', () => {
  // Plan section 3: a rescue arriving at 22:00 needs to be on the wall, not
  // blocked on a temperament checklist. If this test ever fails because
  // someone tightened the gate, read that paragraph before "fixing" it.
  const draft = completeDraft({ story: '', temperament: [], healthNotes: '' });
  assert.equal(canPublish(draft), true);
});

test('a missing photo blocks publishing', () => {
  assert.equal(canPublish(completeDraft({ media: [] })), false);
});

test('an incomplete identity blocks publishing', () => {
  assert.equal(canPublish(completeDraft({ sex: null })), false);
});

test('publishBlockers reports identity and media problems together', () => {
  // Not one-at-a-time: an admin fixing three fields should see three, not
  // discover them serially across three save attempts.
  const errors = publishBlockers(completeDraft({ name: '', media: [] }));
  assert.ok(errors.includes('name-required'));
  assert.ok(errors.includes('photo-required'));
});

// ─────────────────────────────────────────────────────────────────────────────
// draftProgress
// ─────────────────────────────────────────────────────────────────────────────

test('draftProgress counts a published-but-storyless pet as 2 of 3', () => {
  assert.deepEqual(draftProgress(completeDraft()), { done: 2, total: 3 });
});

test('draftProgress reaches 3 of 3 only with a story', () => {
  const draft = completeDraft({ story: 'La encontraron en la Av. Blanco Galindo.' });
  assert.deepEqual(draftProgress(draft), { done: 3, total: 3 });
});

test('draftProgress starts at 0 for a fresh draft', () => {
  assert.deepEqual(draftProgress(draftDefaults('p1')), { done: 0, total: 3 });
});

// ─── registering needs a name and one photo, and nothing else ────────────────
//
// Two thresholds, deliberately far apart. `registerBlockers` is "this animal is
// in our care and has a record"; `publishBlockers` is "a stranger may read a
// page about it". Each test below would pass on the OLD single gate only by
// accident, so each pins one side of the difference.

test('a name and one photo register an animal, with every other field blank', () => {
  const draft: PetDraft = { ...draftDefaults('p1'), name: 'Luna', media: [photo()] };
  assert.deepEqual(registerBlockers(draft), []);
  assert.equal(canRegister(draft), true);
  // Control: the same draft is far from publishable. If these ever agree, one
  // gate has swallowed the other.
  assert.equal(canPublish(draft), false);
  for (const code of ['species-required', 'sex-required', 'size-required', 'breed-required', 'age-required']) {
    assert.ok(publishBlockers(draft).includes(code as never), `${code} must still block publishing`);
  }
});

test('registering asks for exactly two things, in the order the screen shows them', () => {
  assert.deepEqual(registerBlockers(draftDefaults('p1')), ['name-required', 'photo-required']);
});

test('a name alone, or a photo alone, does not register', () => {
  assert.deepEqual(registerBlockers({ ...draftDefaults('p1'), name: 'Luna' }), ['photo-required']);
  assert.deepEqual(registerBlockers({ ...draftDefaults('p1'), media: [photo()] }), ['name-required']);
});

test('a name of only spaces is not a name', () => {
  const draft: PetDraft = { ...draftDefaults('p1'), name: '   ', media: [photo()] };
  assert.deepEqual(registerBlockers(draft), ['name-required']);
});

test('a photo with no description still registers; the description is for the public page', () => {
  const draft: PetDraft = { ...draftDefaults('p1'), name: 'Luna', media: [photo({ alt: '' })] };
  assert.deepEqual(registerBlockers(draft), []);
  assert.ok(publishBlockers(draft).includes('alt-required'));
});

test('registering never depends on a model: a draft no analysis touched registers', () => {
  const draft: PetDraft = { ...draftDefaults('p1'), name: 'Luna', media: [photo()] };
  assert.deepEqual(draft.suggestedFields, []);
  assert.equal(canRegister(draft), true);
});

// ─── the screen keeps those two thresholds apart ─────────────────────────────
//
// Read as TEXT, comments stripped. There is no component-test setup and the
// page sits behind the admin login, so this is the only check that the pure
// rule above is the one the screen uses. Precedent: PR #26, where a pure layer
// computed a value and the screen dropped it with every test green.

function source(file: string): string {
  return readFileSync(join(process.cwd(), file), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const WIZARD_SRC = 'src/app/admin/intake/IntakeWizard.tsx';
const CAPTURE_SRC = 'src/app/admin/intake/GuidedPhotoCapture.tsx';

test('the screen decides "registered" from registerBlockers, and only when it is saved', () => {
  const src = source(WIZARD_SRC);
  assert.ok(/const missingToRegister = registerBlockers\(draft\)/.test(src));
  // The registered sentence sits in the branch reached only when nothing is
  // missing AND nothing is unsaved.
  const branch = src.slice(src.indexOf('missingToRegister.length > 0 ?'));
  const order = ['admin-errors', ') : dirty ? (', 't.intakeForm.registerAction', 't.intakeForm.registeredTitle'];
  let at = 0;
  for (const needle of order) {
    const found = branch.indexOf(needle, at);
    assert.ok(found >= 0, `${needle} is missing or out of order`);
    at = found + needle.length;
  }
});

test('a typed change marks the form unsaved, and every save clears it', () => {
  const src = source(WIZARD_SRC);
  const update = src.slice(src.indexOf('const update = useCallback'), src.indexOf('}, []);', src.indexOf('const update = useCallback')));
  assert.ok(/setDirty\(true\)/.test(update), 'update() must mark the form unsaved');
  const saves = src.match(/await saveDraft\(next\);/g) ?? [];
  const cleared = src.match(/await saveDraft\(next\);\s*setDirty\(false\);/g) ?? [];
  assert.ok(saves.length >= 4, 'expected the four save sites');
  assert.equal(cleared.length, saves.length, 'a save that does not clear the flag hides the registered notice');
});

test('the required photo has no analysis control, and the analysis is inside a closed section', () => {
  const wizard = source(WIZARD_SRC);
  const cover = wizard.indexOf('mode="cover"');
  const details = wizard.indexOf('t.intakeForm.aiSummary');
  const analysis = wizard.indexOf('mode="analysis"');
  assert.ok(cover >= 0 && details > cover && analysis > details, 'cover, then the AI section, then the analysis');
  // The analysis instance is the only caller of the model.
  // `void …()` is the CALL; the bare name also matches the function's own
  // definition, which is not a caller.
  assert.equal((wizard.match(/void handleAnalyzePhotos\(\)/g) ?? []).length, 1);
  assert.ok(wizard.indexOf('void handleAnalyzePhotos()') > details);
  // Closed unless there is already something inside it.
  assert.ok(/open=\{aiIsOpen\}/.test(wizard));
  assert.ok(/const aiIsOpen =\s*aiOpen \?\?/.test(wizard));

  const capture = source(CAPTURE_SRC);
  assert.ok(/mode === 'analysis' && \(\s*<div className="capture__submit">/.test(capture), 'Analizar must render in analysis mode only');
  assert.ok(/mode === 'cover' \? s\.slot === 'front' : s\.slot !== 'front'/.test(capture), 'the cover is one slot');
});

test('what a public page needs is a closed list, never the red error list', () => {
  const src = source(WIZARD_SRC);
  assert.equal(/stepErrors/.test(src), false, 'the per-step error list must not come back');
  const list = src.slice(src.indexOf('intake-more--publish'));
  assert.ok(list.indexOf('t.intakeForm.publishMissingSummary(blockers.length)') >= 0);
  // Exactly one red list remains, and it is the two-item register one.
  assert.equal((src.match(/className="admin-errors"/g) ?? []).length, 1);
  assert.ok(src.indexOf('className="admin-errors"') < src.indexOf('intake-more--publish'));
});

test('publishing is still gated on everything it was', () => {
  const src = source(WIZARD_SRC);
  assert.ok(/disabled=\{busy \|\| blockers\.length > 0 \|\| !user\}/.test(src));
  assert.ok(/const blockers = publishBlockers\(draft\)/.test(src));
});
