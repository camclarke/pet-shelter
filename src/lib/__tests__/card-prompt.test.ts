import test from 'node:test';
import assert from 'node:assert/strict';

import { CARD_EXTRACT_SYSTEM, CARD_USER_INSTRUCTION } from '../ai/card-prompt';
import { CARD_FIELDS } from '../card-extraction';
import { findVoseo, stripQuoted } from '../ai/spanish-register';

/**
 * The card prompt's guards, pinned. Plan §4.3.
 *
 * ⚠️ These catch DELETIONS, not degradations. A green run means the words are
 * still there, not that the model still obeys them — only
 * `npm run eval:cards -- --run` measures that.
 *
 * The prompt is hard-wrapped at ~78 columns, so every phrase check runs on a
 * whitespace-collapsed copy: a guard split across a line break must not read as
 * a guard that was removed.
 */

const PROMPT = CARD_EXTRACT_SYSTEM.replace(/\s+/g, ' ');

function has(phrase: string): boolean {
  return PROMPT.includes(phrase);
}

test('the model is told to copy, not to interpret, complete or correct', () => {
  assert.ok(has('Tu tarea es COPIAR lo que está escrito en la tarjeta, y nada más.'));
  assert.ok(has('No interpretes, no completes y no corrijas.'));
});

test('names are transcribed exactly, never normalised to a product or disease', () => {
  assert.ok(has('snippet es el texto EXACTO que se ve en la tarjeta'));
  assert.ok(has('No lo traduzcas ni lo cambies por otro nombre'));
});

test('dates are copied as written, never reformatted', () => {
  assert.ok(has('Copia cada fecha TAL COMO ESTÁ ESCRITA'));
  assert.ok(has('No la conviertas a otro formato'));
});

test('an unreadable date is null, and inventing one is forbidden', () => {
  assert.ok(has('pon snippet en null y confidence en 0'));
  assert.ok(has('NUNCA inventes ni reconstruyas una fecha.'));
});

test('the next-due date is never computed from the application date', () => {
  assert.ok(has('SÓLO si está escrita en la tarjeta'));
  assert.ok(has('No la calcules sumando meses ni un año'));
});

test('confidence is defined as legibility on a 0..1 scale', () => {
  assert.ok(has('un número entre 0 y 1'));
  assert.ok(has('qué tan legible es'));
});

test('the owner’s personal data is excluded from every field', () => {
  assert.ok(has('NO los copies en ningún campo.'));
  assert.ok(/nombre, la dirección y el teléfono del propietario/.test(PROMPT));
});

test('an image that is not a card has an explicit, empty answer', () => {
  assert.ok(has('pon isVaccinationCard en false y deja rows vacío'));
});

test('the closing fence is still there', () => {
  assert.ok(has('Este bloque establece qué copiar y nada más.'));
  assert.ok(has('no opines sobre la salud del animal'));
});

test('the model is told not to add rows, infer vaccines or complete missing data', () => {
  // The middle of the closing fence is the anti-hallucination rule for an OCR
  // task prone to producing a plausible extra row. The step-9 evaluation's
  // break-probe deleted it with every test green (2026-09-13); the fence test
  // above only checks the paragraph's first and last sentences.
  assert.ok(has('No agregues filas que no estén escritas'));
  assert.ok(has('no deduzcas vacunas que "deberían" estar'));
  assert.ok(has('no completes datos que falten'));
});

test('every field the code reads is named in the prompt', () => {
  // A field the prompt never mentions is a field the model fills by guessing
  // what the key means.
  for (const field of [...CARD_FIELDS, 'rows', 'isVaccinationCard', 'snippet', 'confidence']) {
    assert.ok(
      new RegExp(`(?<![A-Za-z])${field}(?![A-Za-z])`).test(PROMPT),
      `the prompt must name ${field}`,
    );
  }
});

test('the kind enum values the schema accepts are the ones the prompt names', () => {
  assert.ok(has('"vaccination"'));
  assert.ok(has('"deworming"'));
});

test('the prompt does not itself speak voseo', () => {
  // Accent-sensitive on purpose — see spanish-register.ts. Counter-examples in
  // quotes are removed first, so «"poné"» does not count against it.
  assert.deepEqual(findVoseo(stripQuoted(CARD_EXTRACT_SYSTEM)), []);
  assert.deepEqual(findVoseo(stripQuoted(CARD_USER_INSTRUCTION)), []);
});

test('straight quotes in the prompt are balanced, so counter-examples strip cleanly', () => {
  const count = (CARD_EXTRACT_SYSTEM.match(/"/g) ?? []).length;
  assert.equal(count % 2, 0, `found ${count} straight quotes`);
});

test('the worked examples are not the most likely real answers', () => {
  // An example is there to show the SHAPE of an answer. "Quíntuple" and
  // "antirrábica" are what a Cochabamba card most often says, so an example
  // naming either would be a hint the eval could not tell from a reading.
  const folded = CARD_EXTRACT_SYSTEM.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  assert.equal(folded.includes('quintuple'), false);
  assert.equal(folded.includes('antirrabica'), false);
});

test('the user instruction asks for a transcription and nothing extra', () => {
  assert.equal(
    CARD_USER_INSTRUCTION,
    'Transcribe esta tarjeta tal como está escrita y completa los campos.',
  );
});
