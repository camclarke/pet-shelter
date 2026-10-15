import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LABEL_EXTRACT_SYSTEM, LABEL_USER_INSTRUCTION } from '../ai/label-prompt';
import { LabelExtractionSchema } from '../ai/label-schema';
import { LABEL_FIELDS } from '../label-extraction';
import { CARD_EXTRACT_SYSTEM } from '../ai/card-prompt';
import { findVoseo, stripQuoted } from '../ai/spanish-register';
import { LABEL_MODEL_LADDER, LABEL_MODEL_LADDER_DEFAULT_KEYS } from '../ai/model-ids';

/**
 * The label prompt's guards and the schema's shape, pinned. Plan C3.
 *
 * ⚠️ These catch DELETIONS, not degradations. Only
 * `npm run eval:labels -- --run` measures whether the model obeys them.
 *
 * The prompt is hard-wrapped, so phrase checks run on a whitespace-collapsed
 * copy: a guard split across a line break must not read as one removed.
 */

const PROMPT = LABEL_EXTRACT_SYSTEM.replace(/\s+/g, ' ');
const has = (phrase: string) => PROMPT.includes(phrase);

test('the schema has NO date-given and NO next-dose field — by construction', () => {
  const keys = Object.keys(LabelExtractionSchema.shape).sort();
  assert.deepEqual(keys, ['expiresAt', 'isVeterinaryLabel', 'lot', 'manufacturedAt', 'manufacturer', 'product', 'protectsAgainst']);
  for (const forbidden of ['performedAt', 'nextDueAt', 'validFrom', 'validUntil', 'date', 'nextDose']) {
    assert.equal(forbidden in LabelExtractionSchema.shape, false, forbidden);
  }
});

test('the schema and the pure gate agree on the fields', () => {
  const schemaFields = Object.keys(LabelExtractionSchema.shape).filter((k) => k !== 'isVeterinaryLabel').sort();
  assert.deepEqual(schemaFields, [...LABEL_FIELDS].sort());
});

test('the lot and both dates carry the printed word beside them', () => {
  for (const field of ['lot', 'manufacturedAt', 'expiresAt'] as const) {
    assert.ok('fieldWord' in LabelExtractionSchema.shape[field].shape, field);
  }
});

test('the model is told to copy, not to interpret, complete or correct', () => {
  assert.ok(has('Tu tarea es COPIAR lo que está impreso en la etiqueta, y nada más.'));
  assert.ok(has('No interpretes, no completes y no corrijas.'));
});

test('the lot is only the value beside «Lote», and the tab and diluent numbers are named as NOT the lot', () => {
  assert.ok(has('El lote es SÓLO el valor impreso junto a la palabra «Lote», «N. Lote», «Lot» o «Batch».'));
  assert.ok(has('el número de la pestaña de color, el del diluyente'));
  assert.ok(has('Si no ves la palabra del lote junto al número'));
  assert.ok(has('un lote incompleto no es el lote'));
});

test('a date fills its field only beside its own word, never by order', () => {
  assert.ok(has('SÓLO si ves impresa la palabra que dice cuál es'));
  assert.ok(has('no decidas por el orden ni por cuál de las dos es más tardía'));
});

test('dates are copied as printed and never invented', () => {
  assert.ok(has('Copia cada fecha TAL COMO ESTÁ IMPRESA'));
  assert.ok(has('NUNCA inventes ni reconstruyas una fecha.'));
});

test('the prompt says a label carries neither the date given nor the next dose', () => {
  assert.ok(has('La etiqueta no dice cuándo se aplicó la dosis ni cuándo toca la próxima.'));
});

test('only the main label is read when several are in the photo', () => {
  assert.ok(has('lee sólo la que ocupa la mayor parte de la foto'));
  assert.ok(has('No mezcles datos de dos etiquetas.'));
});

test('confidence is defined as legibility on a 0..1 scale', () => {
  assert.ok(has('un número entre 0 y 1'));
  assert.ok(has('qué tan legible es'));
});

test('the instructions are neutral Spanish: no voseo outside quoted counter-examples', () => {
  assert.deepEqual(findVoseo(stripQuoted(LABEL_EXTRACT_SYSTEM)), []);
  assert.deepEqual(findVoseo(LABEL_USER_INSTRUCTION), []);
});

test('the label prompt is not the card prompt, and the card prompt is untouched by it', () => {
  assert.notEqual(LABEL_EXTRACT_SYSTEM, CARD_EXTRACT_SYSTEM);
  assert.equal(CARD_EXTRACT_SYSTEM.includes('etiqueta adhesiva que el veterinario despega'), false);
});

test('the label ladder is Flash-Lite only, and touches no Flash bucket', () => {
  // Decided by `npm run eval:labels` on 2026-10-15 — see model-ids.ts.
  assert.deepEqual([...LABEL_MODEL_LADDER_DEFAULT_KEYS], ['flash-lite']);
  assert.deepEqual([...LABEL_MODEL_LADDER], ['gemini-3.1-flash-lite']);
});

test('no tools are passed to the model — grounding stays off', () => {
  const src = readFileSync(join(process.cwd(), 'src/lib/ai/label-extract.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.equal(/\btools\s*:/.test(src), false);
  assert.ok(/import 'server-only';/.test(src));
});
