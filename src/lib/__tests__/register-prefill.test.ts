/**
 * What a photograph may overwrite, and what the paper register protects.
 *
 * Run with:  node --test --import tsx src/lib/__tests__/register-prefill.test.ts
 *
 * Two rules live here, and both fail SILENTLY when they break — which is the
 * whole reason they are tested rather than trusted.
 *
 * The first is `shouldPrefill`. Before it existed, an analysis was applied
 * straight onto the draft, so a second press of Analizar replaced whatever had
 * been corrected between the two presses, and nothing on screen said so. There
 * is no error state to notice: the field simply holds a different answer than
 * the person left there.
 *
 * The second is `sexConflict`. The register's sex and a genital photograph are
 * two independent readings of the same animal, and when they disagree one of
 * them is wrong. Resolving that automatically — in either direction — would
 * look exactly like working software, and would then inflect every Spanish
 * sentence the site writes about the animal off the losing answer.
 *
 * The last three tests read `IntakeWizard.tsx` as TEXT. That is crude, and it
 * is the only check available: the component needs a browser, an admin session
 * and a Firestore draft to render, so nothing else in this repo can assert that
 * the wizard actually CALLS any of this. PR #26 (2026-09-02) was precisely that
 * bug — `reviewSuggestion` computed `sex`, the UI threw it away, and every test
 * stayed green. Source-text checks catch the edit that forgets, not the one
 * that tries.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  applyPhotoPrefill,
  draftDefaults,
  sexConflict,
  shouldPrefill,
  type PetDraft,
  type RegisterRef,
} from '../intake';

const WIZARD = 'src/app/admin/intake/IntakeWizard.tsx';

const read = (file: string) =>
  readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');

/**
 * The wizard's source with comments removed.
 *
 * Every check below runs on this rather than on the raw file, for two reasons
 * this repo has been caught by before. A comment EXPLAINING a rule would
 * otherwise satisfy the check for the rule — the 2026-08-23 finding that a
 * needle grepped out of source can be a JSDoc block the minifier strips — and
 * the comments here name `draft.register` and `Descartar` precisely because
 * they explain why neither belongs where it used to. A brace inside a comment
 * would also unbalance `functionBody`.
 */
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const wizardCode = () => withoutComments(read(WIZARD));

/**
 * The same, with runs of whitespace collapsed.
 *
 * Prettier wraps JSX text between words, so a needle taken from the rendered
 * copy can be split across two lines in the source and a plain `includes` then
 * reports healthy code as missing. `intake-prompt.test.ts` documents the same
 * trap for the prompt's hard-wrapped strings.
 */
const flatWizard = () => wizardCode().replace(/\s+/g, ' ');

/**
 * One function's body, braces balanced.
 *
 * The checks below have to be scoped to `handleAnalyzePhotos`: the wizard
 * legitimately spreads a patch onto the draft in two other places — `update()`,
 * which is every keystroke, and `acceptSuggested()`, which is a person pressing
 * an offer. Those are the human path and must keep working. It is the
 * PHOTOGRAPH's path that has to go through the guard.
 */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`unterminated ${signature}`);
}

const ANALYZE = 'async function handleAnalyzePhotos(';

/** Register row 215 — "Dana", the one the import cannot tell from n.º 216. */
function registerRef(overrides: Partial<RegisterRef> = {}): RegisterRef {
  return {
    no: 215,
    nameRaw: 'DANA',
    intakeDay: '2026-02-11',
    ageText: 'DE 8 ANOS',
    sexPerRegister: 'female',
    sterilizedPerRegister: true,
    medicalCount: 3,
    batch: 'registro-2026-09-18',
    linkConfidence: 'confirmed',
    ...overrides,
  };
}

/** A draft as the importer leaves it: the register's answers already in place. */
function importedDraft(overrides: Partial<PetDraft> = {}): PetDraft {
  return {
    ...draftDefaults('pet-215'),
    name: 'Dana',
    sex: 'female',
    register: registerRef(),
    ...overrides,
  };
}

// ─── shouldPrefill ───────────────────────────────────────────────────────────

test('an empty field may be prefilled', () => {
  const draft = draftDefaults('d1');
  for (const field of ['species', 'name', 'sex', 'size', 'breed', 'colorPattern', 'coatType', 'ageMonths', 'weightKg']) {
    assert.equal(shouldPrefill(field, draft), true, field);
  }
});

test('a field a person filled in is protected', () => {
  const typed = draftDefaults('d1');
  typed.name = 'Lobita';
  typed.colorPattern = 'negra con pecho blanco';
  typed.species = 'dog';
  typed.sex = 'female';
  typed.ageYears = 3;

  assert.equal(shouldPrefill('name', typed), false);
  assert.equal(shouldPrefill('colorPattern', typed), false);
  assert.equal(shouldPrefill('species', typed), false);
  assert.equal(shouldPrefill('sex', typed), false);
  assert.equal(shouldPrefill('ageMonths', typed), false);
});

test('a field the model filled in last may be re-filled, so re-analysing still works', () => {
  const draft = draftDefaults('d1');
  draft.colorPattern = 'negro y gris';
  draft.suggestedFields = ['colorPattern'];

  assert.equal(shouldPrefill('colorPattern', draft), true);
  // And only that one: provenance is per field, not per draft.
  draft.coatType = 'largo y denso';
  assert.equal(shouldPrefill('coatType', draft), false);
});

test('"no sabemos la edad" is an answer, not a blank', () => {
  const draft = draftDefaults('d1');
  draft.ageUnknown = true;
  // Both age numbers are null, so a naive emptiness check would call this empty
  // and let a photograph quietly un-tick a decision somebody made.
  assert.equal(draft.ageYears, null);
  assert.equal(draft.ageMonthsPart, null);
  assert.equal(shouldPrefill('ageMonths', draft), false);
});

test('whitespace is not an answer', () => {
  const draft = draftDefaults('d1');
  draft.breed = '   ';
  assert.equal(shouldPrefill('breed', draft), true);
});

test('a field this guard does not know is never prefilled', () => {
  const draft = draftDefaults('d1');
  assert.equal(shouldPrefill('status', draft), false);
  assert.equal(shouldPrefill('slug', draft), false);
  assert.equal(shouldPrefill('', draft), false);
  // `sterilized` is left out on purpose: false means both "no" and "nobody has
  // said", so there is no empty state to detect. It stays an offer.
  assert.equal(shouldPrefill('sterilized', draft), false);
});

// ─── applyPhotoPrefill ───────────────────────────────────────────────────────

test('a photograph does not overwrite the name or the sex the register gave', () => {
  const draft = importedDraft();
  const next = applyPhotoPrefill(
    draft,
    { name: 'Nieve', sex: 'male' },
    ['name', 'sex'],
    'flash',
  );

  assert.equal(next, draft, 'nothing applied, so the same object comes back');
  assert.equal(next.name, 'Dana');
  assert.equal(next.sex, 'female');
  assert.deepEqual(next.suggestedFields, []);
  assert.equal(next.suggestedByModel, null);
});

test('an empty colour is filled, and the model is recorded as the source', () => {
  const draft = importedDraft();
  const next = applyPhotoPrefill(
    draft,
    { colorPattern: 'negra con pecho blanco' },
    ['colorPattern'],
    'flash',
  );

  assert.notEqual(next, draft);
  assert.equal(next.colorPattern, 'negra con pecho blanco');
  assert.deepEqual(next.suggestedFields, ['colorPattern']);
  assert.equal(next.suggestedByModel, 'flash');
  // And the register's own answers are untouched by the same call.
  assert.equal(next.name, 'Dana');
  assert.equal(next.sex, 'female');
});

test('a colour the model set before is re-filled by a second analysis', () => {
  const first = applyPhotoPrefill(
    draftDefaults('d1'),
    { colorPattern: 'negro y gris' },
    ['colorPattern'],
    'flash',
  );
  const second = applyPhotoPrefill(
    first,
    { colorPattern: 'negro, gris y blanco' },
    ['colorPattern'],
    'flash-lite',
  );

  assert.equal(second.colorPattern, 'negro, gris y blanco');
  assert.deepEqual(second.suggestedFields, ['colorPattern'], 'provenance is not duplicated');
  assert.equal(second.suggestedByModel, 'flash-lite');
});

test('one refused field does not block the others in the same patch', () => {
  const draft = importedDraft();
  const next = applyPhotoPrefill(
    draft,
    { name: 'Nieve', colorPattern: 'negra con pecho blanco', coatType: 'largo y denso' },
    ['name', 'colorPattern', 'coatType'],
    'flash',
  );

  assert.equal(next.name, 'Dana');
  assert.equal(next.colorPattern, 'negra con pecho blanco');
  assert.equal(next.coatType, 'largo y denso');
  assert.deepEqual(next.suggestedFields, ['colorPattern', 'coatType']);
});

test('an age arrives whole — the bounds travel with the number', () => {
  const next = applyPhotoPrefill(
    draftDefaults('d1'),
    { ageYears: 2, ageMonthsPart: 0, ageMonthsMin: 12, ageMonthsMax: 36, ageUnknown: false },
    ['ageMonths'],
    'flash',
  );

  assert.equal(next.ageYears, 2);
  assert.equal(next.ageMonthsMin, 12);
  assert.equal(next.ageMonthsMax, 36);
  assert.deepEqual(next.suggestedFields, ['ageMonths']);
});

test('a key its field does not own is dropped, so the guard cannot be walked around', () => {
  const draft = draftDefaults('d1');
  const next = applyPhotoPrefill(
    draft,
    // `status` belongs to no suggestible field. Publishing to the public wall
    // is a decision, and a model must not reach it by riding along in a patch.
    { colorPattern: 'atigrado', status: 'available', slug: 'colado' },
    ['colorPattern'],
    'flash',
  );

  assert.equal(next.colorPattern, 'atigrado');
  assert.equal(next.status, 'shelter');
  assert.equal(next.slug, '');
});

test('a field not named in `fields` is not applied, even when the patch carries it', () => {
  const next = applyPhotoPrefill(
    draftDefaults('d1'),
    { colorPattern: 'atigrado', coatType: 'corto' },
    ['colorPattern'],
    'flash',
  );

  assert.equal(next.colorPattern, 'atigrado');
  assert.equal(next.coatType, '');
  assert.deepEqual(next.suggestedFields, ['colorPattern']);
});

test('a model with no name does not erase the provenance already recorded', () => {
  const first = applyPhotoPrefill(
    draftDefaults('d1'),
    { colorPattern: 'negro' },
    ['colorPattern'],
    'flash',
  );
  const second = applyPhotoPrefill(first, { coatType: 'corto' }, ['coatType'], null);

  assert.equal(second.suggestedByModel, 'flash');
});

// ─── sexConflict ─────────────────────────────────────────────────────────────

test('agreeing sources are not a conflict', () => {
  assert.equal(sexConflict(importedDraft(), 'female'), null);
});

test('a draft with no register has nothing to disagree with', () => {
  assert.equal(sexConflict(draftDefaults('d1'), 'male'), null);
});

test('a photograph that read no sex is not a second opinion', () => {
  assert.equal(sexConflict(importedDraft(), null), null);
});

test('a register that left the sex blank is not a second opinion either', () => {
  const draft = importedDraft({ register: registerRef({ sexPerRegister: null }) });
  assert.equal(sexConflict(draft, 'male'), null);
});

test('two sources that disagree are reported, each named', () => {
  assert.deepEqual(sexConflict(importedDraft(), 'male'), { register: 'female', photo: 'male' });
});

test('resolving it in the draft does not make the sources agree', () => {
  // The person switched to the photograph's reading. The paper still says
  // something else, and the note explaining that should not vanish.
  const resolved = importedDraft({ sex: 'male' });
  assert.deepEqual(sexConflict(resolved, 'male'), { register: 'female', photo: 'male' });
});

// ─── the wizard actually uses all of it ──────────────────────────────────────

test('the wizard applies photo readings through the guard, not by assignment', () => {
  const body = functionBody(wizardCode(), ANALYZE);
  assert.ok(body.includes('applyPhotoPrefill('), 'the analysis no longer calls applyPhotoPrefill');
  // The inline form this replaced. Its return would be a silent regression:
  // every field would apply again, and every test above would still pass.
  assert.equal(
    /patch\.species\s*=\s*s\.species/.test(body),
    false,
    'the old unguarded assignment is back',
  );
  // The same rule, stated so it holds under whatever name the local takes. What
  // a photograph read may only ever travel to the draft as an ARGUMENT to the
  // guard; spreading it is the bug itself.
  assert.equal(
    /\.\.\.\s*patch\b/.test(body),
    false,
    'the photo patch is being spread onto the draft again, past the guard',
  );
});

test('the wizard shows the sex disagreement rather than resolving it', () => {
  const flat = flatWizard();
  assert.ok(flat.includes('sexConflict('), 'the wizard never asks whether the sources disagree');
  assert.ok(flat.includes('La foto sugiere'), 'the conflict copy is gone');
  assert.ok(flat.includes('el registro dice'), 'the conflict copy no longer names the register');
});

test('a register draft cannot be discarded from the wizard', () => {
  const flat = flatWizard();
  const at = flat.lastIndexOf('Descartar');
  assert.ok(at > 0, 'the Descartar button moved or was renamed');
  assert.match(
    flat.slice(Math.max(0, at - 400), at),
    /!draft\.register/,
    'Descartar is no longer gated on the draft having no register row — discarding one orphans the medical records the import wrote',
  );
});

test('the register panel is rendered where the fields it explains are', () => {
  const flat = flatWizard();
  assert.ok(flat.includes('Del registro n.'), 'the register panel is gone');
  assert.ok(flat.includes('describeRegister(register)'), 'the panel no longer says what the paper says');
});

test('the register is never sent to the model', () => {
  const body = functionBody(wizardCode(), ANALYZE);
  const call = body.indexOf('requestSuggestion(');
  assert.ok(call >= 0, 'the model call moved out of handleAnalyzePhotos');

  // Only the photographs travel. A register in this request would make the
  // model's reading an echo of the register rather than a check on it, and
  // `sexConflict` would then be comparing the register against itself.
  const args = body.slice(call, body.indexOf(')', call));
  assert.equal(/register/i.test(args), false, `the register reached the model call: ${args}`);
  // And nothing in the analysis reads the register at all, by any route.
  assert.equal(/draft\.register/.test(body), false, 'the analysis is reading the register');
});
