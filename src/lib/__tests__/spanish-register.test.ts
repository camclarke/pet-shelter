import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PROSE_FIELDS,
  findSecondPerson,
  findVoseo,
  proseRegisterFindings,
  stripQuoted,
} from '../ai/spanish-register';

/**
 * The register tripwires, pinned.
 *
 * ⚠️ These prove the DETECTOR, not the prompt. A green run here says the check
 * would catch the known forms; only `npm run eval:intake -- --run` says the
 * model has stopped producing them.
 */

/** Verbatim from production, 2026-09-12 — the draft that became "Lobita". */
const LOBITA_OBSERVATION =
  'Permaneces echada de lado en el suelo de baldosas con actitud tranquila y relajada. Tu pelaje es muy abundante.';

test('the verbatim production defect is caught', () => {
  // The exact sentence a real intake produced. If this ever passes clean, the
  // check is blind to the thing it was written for.
  assert.deepEqual(findSecondPerson(LOBITA_OBSERVATION), ['Permaneces', 'Tu']);
});

test('its third-person rewrite is clean', () => {
  assert.deepEqual(
    findSecondPerson(
      'Está echada de lado en el suelo de baldosas con actitud tranquila y relajada. Su pelaje es muy abundante.'
    ),
    []
  );
});

test('an accent decides between addressing someone and describing legs', () => {
  assert.deepEqual(findSecondPerson('Estás tranquila.'), ['Estás']);
  // "estas" without the accent is a demonstrative, and descriptions of an
  // animal use it constantly. Folding accents here would fail every run.
  assert.deepEqual(findSecondPerson('Estas patas son largas.'), []);
});

test('a pronoun ending in an accented letter is still caught', () => {
  // The `\b` trap: JavaScript treats "ú" as a non-word character, so `\btú\b`
  // finds no boundary between "ú" and a space and silently matches nothing.
  assert.deepEqual(findSecondPerson('Se parece a ti, como tú.'), ['ti', 'tú']);
});

test('a letter after a pronoun is not mistaken for a boundary', () => {
  // The same trap in the other direction: ASCII `\b` sees a boundary before
  // "ñ", so `\bte\b` would match inside "teñido" — a coat description.
  assert.deepEqual(findSecondPerson('pelaje teñido de gris'), []);
});

test('words that merely contain a pronoun are not caught', () => {
  assert.deepEqual(
    findSecondPerson(
      'Está tumbada, de pelo tupido y color tenue; un ojo tuerto, patas largas y buena estatura. Tiene tipo mediano y presenta calma.'
    ),
    []
  );
});

test('capitals do not hide second person', () => {
  assert.deepEqual(findSecondPerson('TU PELAJE ES DENSO'), ['TU']);
});

test('absent text yields nothing and never throws', () => {
  // Every prose field in the schema is nullable, and a model that returns
  // null must not crash the scorer.
  assert.deepEqual(findSecondPerson(null), []);
  assert.deepEqual(findSecondPerson(undefined), []);
  assert.deepEqual(findSecondPerson(''), []);
});

test('voseo is caught, and its tuteo equivalent is not', () => {
  assert.deepEqual(findVoseo('Estimá un rango, sugerí nombres y usalos.'), ['Estimá', 'sugerí', 'usalos']);
  assert.deepEqual(findVoseo('Estima un rango, sugiere nombres y úsalos.'), []);
});

test('quoted counter-examples are removed, even across a line break', () => {
  // The prompt is hard-wrapped at ~78 columns, so ONE quoted example can span
  // a line — it does today: "mestizo\nmediano de pelo corto…". A strip that
  // stopped at a newline would fail to close that quote, pair its closing mark
  // with the NEXT example's opening mark, and strip the real instruction in
  // between — leaving example text behind and deleting what a check reads.
  //
  // ⚠️ The newline must be INSIDE one quoted span. The first version of this
  // test put it BETWEEN two quoted words ("sacá",\n"poné"), where a
  // newline-blind strip still pairs every quote correctly — so the test could
  // not fail. Caught while writing the deliberate break for it.
  const s = 'Ejemplo: "sacá\nla foto". Estima un rango. Nada de ("poné").';
  assert.equal(findVoseo(s).length, 2, 'precondition: the unstripped string does contain voseo');
  assert.deepEqual(findVoseo(stripQuoted(s)), []);
  assert.ok(stripQuoted(s).includes('Estima un rango'), 'stripped the instruction as well as the example');
  assert.deepEqual(findSecondPerson(stripQuoted('no escribas «permaneces» ni «tu pelaje»')), []);
});

test('the register check names the field that addressed someone', () => {
  // Shaped exactly like that production call: only the observation was
  // wrong, and the marks and the note were correctly impersonal.
  assert.deepEqual(
    proseRegisterFindings({
      generalObservations: LOBITA_OBSERVATION,
      distinguishingMarks: 'ojos de color azul claro o grisáceo',
      notes: 'Presenta suciedad y nudos en el pelaje de la zona perineal.',
    }),
    ['generalObservations: Permaneces', 'generalObservations: Tu']
  );
});

test('the register check reads every prose field, not only observations', () => {
  // ⚠️ By NAME, not by looping over PROSE_FIELDS — a loop shrinks with the
  // list, so narrowing it to the one field where the defect was seen would
  // leave this test green. A fix that moves the defect into `notes` must fail.
  assert.deepEqual([...PROSE_FIELDS].sort(), [
    'coatType',
    'colorPattern',
    'distinguishingMarks',
    'generalObservations',
    'notes',
    'visibleType',
  ]);
  for (const field of PROSE_FIELDS) {
    assert.deepEqual(proseRegisterFindings({ [field]: 'Tus orejas son grandes.' }), [`${field}: Tus`]);
  }
});

test('the eval harness actually scores prose register', () => {
  // ⚠️ A source-level guard. The harness is not in `npm test`, so a detector
  // that is perfect and never called is the #26 bug class — a value computed
  // and never delivered, with every test green.
  const src = readFileSync(join(process.cwd(), 'scripts', 'eval-intake-suggest.mjs'), 'utf8');
  assert.ok(
    src.includes("from '../src/lib/ai/spanish-register.ts'"),
    'the eval harness no longer imports the register detector'
  );
  assert.ok(src.includes('proseRegisterFindings(raw)'), 'the eval harness no longer runs the register check');
  assert.ok(
    src.includes('prose describes the animal in third person'),
    'the eval harness no longer reports the register check by name'
  );
});
