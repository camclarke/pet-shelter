import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_FIELDS,
  cardPhotoPath,
  cardThresholdsFor,
  candidateRecordFields,
  isCardPhotoPathFor,
  parseCardDate,
  parseCardExtractRequest,
  reviewCardExtraction,
  type CardCandidate,
} from '../card-extraction';

/**
 * Card extraction's decision layer, plan §4.3. Fails toward DROPPING.
 *
 * Every threshold and every date below is a LITERAL. A test that compares a
 * function against the constant it reads cannot fail when the constant moves.
 */

const NOW = Date.parse('2026-09-12T15:00:00Z');

/** The UTC calendar day a parsed date lands on, as YYYY-MM-DD. */
function day(ms: number | null): string | null {
  if (ms === null) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

const absent = { snippet: null, confidence: 0 };

function row(over: Record<string, unknown> = {}) {
  return {
    kind: { value: 'vaccination', snippet: 'VACUNAS', confidence: 0.95 },
    name: { snippet: 'Quíntuple', confidence: 0.95 },
    performedAt: { snippet: '14/02/2025', confidence: 0.95 },
    nextDueAt: { snippet: '14/02/2026', confidence: 0.95 },
    batch: { snippet: 'A-0042', confidence: 0.95 },
    manufacturer: absent,
    veterinarian: absent,
    clinic: absent,
    ...over,
  };
}

function reviewOne(r: Record<string, unknown>) {
  const out = reviewCardExtraction({ isVaccinationCard: true, rows: [r] }, NOW);
  assert.equal(out.kind, 'reviewed');
  return out.kind === 'reviewed' ? out : null!;
}

// ─── dates, as a Bolivian card writes them ───────────────────────────────────

test('a slashed date is read DAY first', () => {
  assert.equal(day(parseCardDate('03/04/2025')), '2025-04-03');
  assert.equal(day(parseCardDate('14/02/2025')), '2025-02-14');
});

test('a two-digit year is this century', () => {
  assert.equal(day(parseCardDate('12/03/25')), '2025-03-12');
});

test('dots, dashes and loose spacing are all separators', () => {
  assert.equal(day(parseCardDate('12.03.2025')), '2025-03-12');
  assert.equal(day(parseCardDate('12-3-25')), '2025-03-12');
  assert.equal(day(parseCardDate('12 / 03 / 2025')), '2025-03-12');
});

test('a Roman-numeral month is read', () => {
  assert.equal(day(parseCardDate('7-XI-2024')), '2024-11-07');
  assert.equal(day(parseCardDate('20/iv/25')), '2025-04-20');
});

test('Spanish month names and abbreviations are read, "setiembre" included', () => {
  assert.equal(day(parseCardDate('03 MAR 2025')), '2025-03-03');
  assert.equal(day(parseCardDate('12 de marzo de 2025')), '2025-03-12');
  assert.equal(day(parseCardDate('12 de marzo del 2025')), '2025-03-12');
  assert.equal(day(parseCardDate('5 setiembre 2024')), '2024-09-05');
  assert.equal(day(parseCardDate('5-sept-24')), '2024-09-05');
  assert.equal(day(parseCardDate('1 Dic. 2023')), '2023-12-01');
});

test('a trailing full stop does not stop a date being read', () => {
  assert.equal(day(parseCardDate('12/03/2025.')), '2025-03-12');
});

test('the parsed instant is midday UTC, so no admin timezone shifts the day', () => {
  const ms = parseCardDate('12/03/2025')!;
  assert.equal(new Date(ms).getUTCHours(), 12);
});

test('a day that does not exist is refused', () => {
  assert.equal(parseCardDate('31/02/2025'), null);
  assert.equal(parseCardDate('29/02/2025'), null);
  assert.equal(parseCardDate('00/03/2025'), null);
  assert.equal(parseCardDate('12/13/2025'), null);
});

test('a leap day in a leap year is read', () => {
  assert.equal(day(parseCardDate('29/02/2024')), '2024-02-29');
});

test('a YEAR-FIRST date is refused, because a card does not write one', () => {
  // A snippet in ISO form means the model reformatted instead of copying.
  assert.equal(parseCardDate('2025-03-12'), null);
  assert.equal(parseCardDate('2025/03/12'), null);
});

test('a date with a missing or guessed part is refused', () => {
  assert.equal(parseCardDate('12/03'), null);
  assert.equal(parseCardDate('1?/03/25'), null);
  assert.equal(parseCardDate('12/03/2?'), null);
  assert.equal(parseCardDate('marzo 2025'), null);
  assert.equal(parseCardDate('12/03/025'), null);
});

test('nothing that is not a date string is a date', () => {
  assert.equal(parseCardDate(null), null);
  assert.equal(parseCardDate(undefined), null);
  assert.equal(parseCardDate(''), null);
  assert.equal(parseCardDate(20250312 as unknown as string), null);
  assert.equal(parseCardDate('x'.repeat(41)), null);
});

// ─── the thresholds, pinned literally ────────────────────────────────────────

test('the date bar is 0.8, the text bar is 0.6, and highlighting starts below 0.9', () => {
  assert.deepEqual(cardThresholdsFor('performedAt'), { prefillMin: 0.8, highlightBelow: 0.9 });
  assert.deepEqual(cardThresholdsFor('nextDueAt'), { prefillMin: 0.8, highlightBelow: 0.9 });
  assert.deepEqual(cardThresholdsFor('name'), { prefillMin: 0.6, highlightBelow: 0.9 });
  assert.deepEqual(cardThresholdsFor('kind'), { prefillMin: 0.6, highlightBelow: 0.9 });
});

test('a date read at exactly 0.8 is prefilled', () => {
  const { candidates } = reviewOne(row({ performedAt: { snippet: '14/02/2025', confidence: 0.8 } }));
  assert.equal(day(candidates[0]!.draft.performedAt), '2025-02-14');
});

test('a date read at 0.79 is NOT prefilled, and says why', () => {
  const { candidates } = reviewOne(row({ performedAt: { snippet: '14/02/2025', confidence: 0.79 } }));
  assert.equal(candidates[0]!.draft.performedAt, null);
  assert.equal(candidates[0]!.evidence.performedAt.withheld, 'low-confidence');
  // The snippet stays, so the reviewer can type it while looking at it.
  assert.equal(candidates[0]!.evidence.performedAt.snippet, '14/02/2025');
});

test('a name read at 0.6 is prefilled and at 0.59 is not', () => {
  const at = reviewOne(row({ name: { snippet: 'Quíntuple', confidence: 0.6 } }));
  assert.equal(at.candidates[0]!.draft.name, 'Quíntuple');
  const below = reviewOne(row({ name: { snippet: 'Quíntuple', confidence: 0.59 } }));
  assert.equal(below.candidates[0]!.draft.name, '');
  assert.equal(below.candidates[0]!.evidence.name.withheld, 'low-confidence');
});

test('a text field at 0.7 is prefilled even though a date at 0.7 would not be', () => {
  const { candidates } = reviewOne(
    row({
      batch: { snippet: 'A-0042', confidence: 0.7 },
      nextDueAt: { snippet: '14/02/2026', confidence: 0.7 },
    }),
  );
  assert.equal(candidates[0]!.draft.batch, 'A-0042');
  assert.equal(candidates[0]!.draft.nextDueAt, null);
});

// ─── NEVER INVENT A DATE ─────────────────────────────────────────────────────

test('an illegible date the model marked null stays null, however confident', () => {
  const { candidates } = reviewOne(row({ performedAt: { snippet: null, confidence: 1 } }));
  assert.equal(candidates[0]!.draft.performedAt, null);
});

test('a confident snippet that does not parse is withheld as unreadable', () => {
  const { candidates } = reviewOne(row({ performedAt: { snippet: '1?/02/2025', confidence: 0.99 } }));
  assert.equal(candidates[0]!.draft.performedAt, null);
  assert.equal(candidates[0]!.evidence.performedAt.withheld, 'unreadable-date');
});

test('a date the model REFORMATTED into ISO is not accepted', () => {
  const { candidates } = reviewOne(row({ performedAt: { snippet: '2025-02-14', confidence: 1 } }));
  assert.equal(candidates[0]!.draft.performedAt, null);
});

test('a date smuggled through a field other than snippet is ignored', () => {
  // The schema has no `value` on a date. A model that adds one must not get a
  // reformatted date past the parser.
  const { candidates } = reviewOne(
    row({ performedAt: { value: '2025-02-14', snippet: null, confidence: 1 } }),
  );
  assert.equal(candidates[0]!.draft.performedAt, null);
});

test('an application date in the future is withheld as implausible', () => {
  const { candidates } = reviewOne(row({ performedAt: { snippet: '14/02/2027', confidence: 0.99 } }));
  assert.equal(candidates[0]!.draft.performedAt, null);
  assert.equal(candidates[0]!.evidence.performedAt.withheld, 'implausible-date');
});

test('an application date more than 30 years old is withheld as implausible', () => {
  const { candidates } = reviewOne(row({ performedAt: { snippet: '14/02/1994', confidence: 0.99 } }));
  assert.equal(candidates[0]!.draft.performedAt, null);
  assert.equal(candidates[0]!.evidence.performedAt.withheld, 'implausible-date');
});

test('a revaccination date BEFORE the dose is withheld, and the dose is kept', () => {
  const { candidates } = reviewOne(
    row({
      performedAt: { snippet: '14/02/2025', confidence: 0.95 },
      nextDueAt: { snippet: '14/02/2024', confidence: 0.95 },
    }),
  );
  assert.equal(day(candidates[0]!.draft.performedAt), '2025-02-14');
  assert.equal(candidates[0]!.draft.nextDueAt, null);
  assert.equal(candidates[0]!.evidence.nextDueAt.withheld, 'implausible-date');
});

test('a revaccination date in the future is fine', () => {
  const { candidates } = reviewOne(row({ nextDueAt: { snippet: '14/02/2027', confidence: 0.95 } }));
  assert.equal(day(candidates[0]!.draft.nextDueAt), '2027-02-14');
});

test('a revaccination more than 10 years out is withheld', () => {
  const { candidates } = reviewOne(row({ nextDueAt: { snippet: '14/02/2040', confidence: 0.95 } }));
  assert.equal(candidates[0]!.draft.nextDueAt, null);
});

// ─── verbatim, and nothing more ──────────────────────────────────────────────

test('a name is kept exactly as written — accents and capitals — only trimmed', () => {
  const { candidates } = reviewOne(row({ name: { snippet: '  QUÍNTUPLE canina ', confidence: 0.95 } }));
  assert.equal(candidates[0]!.draft.name, 'QUÍNTUPLE canina');
});

test('a snippet too long to be one value is withheld, not truncated', () => {
  const long = 'Propietario: Juan Pérez, calle Falsa 123, teléfono 70000000, zona Sud, Cochabamba';
  const { candidates } = reviewOne(row({ clinic: { snippet: long, confidence: 0.99 } }));
  assert.equal(candidates[0]!.draft.clinic, null);
  assert.equal(candidates[0]!.evidence.clinic.withheld, 'too-long');
  // And the STORED evidence is capped, so it cannot carry the whole thing.
  assert.ok((candidates[0]!.evidence.clinic.snippet ?? '').length <= 81);
});

test('a confidence outside 0..1 withholds the field rather than being rescaled', () => {
  const { candidates } = reviewOne(row({ batch: { snippet: 'A-0042', confidence: 95 } }));
  assert.equal(candidates[0]!.draft.batch, null);
});

// ─── kind ────────────────────────────────────────────────────────────────────

test('a confident kind is copied', () => {
  const { candidates } = reviewOne(
    row({ kind: { value: 'deworming', snippet: 'DESPARASITACIÓN', confidence: 0.9 } }),
  );
  assert.equal(candidates[0]!.draft.kind, 'deworming');
});

test('a kind with no classification is left for a person, not inferred from the heading', () => {
  const { candidates } = reviewOne(row({ kind: { value: null, snippet: 'VACUNAS', confidence: 0.95 } }));
  assert.equal(candidates[0]!.draft.kind, null);
  assert.equal(candidates[0]!.evidence.kind.withheld, 'low-confidence');
});

test('a kind a card cannot hold is refused', () => {
  const { candidates } = reviewOne(row({ kind: { value: 'surgery', snippet: 'CIRUGÍA', confidence: 0.95 } }));
  assert.equal(candidates[0]!.draft.kind, null);
});

test('a kind with no snippet is withheld, whatever it claims', () => {
  const { candidates } = reviewOne(row({ kind: { value: 'vaccination', snippet: null, confidence: 1 } }));
  assert.equal(candidates[0]!.draft.kind, null);
});

// ─── rows and cards ──────────────────────────────────────────────────────────

test('an image the model says is not a card yields nothing, even with rows', () => {
  const out = reviewCardExtraction({ isVaccinationCard: false, rows: [row()] }, NOW);
  assert.equal(out.kind, 'not-a-card');
});

test('anything but a literal true is not a card', () => {
  assert.equal(reviewCardExtraction({ isVaccinationCard: 'true', rows: [row()] }, NOW).kind, 'not-a-card');
  assert.equal(reviewCardExtraction({ rows: [row()] }, NOW).kind, 'not-a-card');
  assert.equal(reviewCardExtraction(null, NOW).kind, 'not-a-card');
});

test('a row with neither a name nor a date is dropped, and counted', () => {
  const out = reviewCardExtraction(
    {
      isVaccinationCard: true,
      rows: [
        row(),
        row({ name: absent, performedAt: absent, batch: { snippet: 'L-77', confidence: 1 } }),
      ],
    },
    NOW,
  );
  assert.equal(out.kind, 'reviewed');
  if (out.kind !== 'reviewed') return;
  assert.equal(out.candidates.length, 1);
  assert.equal(out.droppedRows, 1);
});

test('a row with a date but a withheld name is kept for a person to finish', () => {
  const { candidates } = reviewOne(row({ name: { snippet: 'Qu?nt', confidence: 0.2 } }));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.draft.name, '');
});

test('a garbage row does not throw', () => {
  const out = reviewCardExtraction({ isVaccinationCard: true, rows: [null, 7, 'x', {}] }, NOW);
  assert.equal(out.kind, 'reviewed');
  if (out.kind === 'reviewed') assert.equal(out.droppedRows, 4);
});

test('no more than 20 rows are considered', () => {
  const rows = Array.from({ length: 25 }, () => row());
  const out = reviewCardExtraction({ isVaccinationCard: true, rows }, NOW);
  if (out.kind !== 'reviewed') throw new Error('expected reviewed');
  assert.equal(out.candidates.length, 20);
  assert.equal(out.droppedRows, 5);
});

test('every field carries evidence, used or not', () => {
  const { candidates } = reviewOne(row());
  assert.deepEqual(Object.keys(candidates[0]!.evidence).sort(), [...CARD_FIELDS].sort());
});

// ─── the stored candidate is UNCONFIRMED ─────────────────────────────────────

test('a candidate is written unconfirmed, marked extracted, and keeps its card', () => {
  const { candidates } = reviewOne(row());
  const fields = candidateRecordFields(candidates[0] as CardCandidate, {
    modelKey: 'flash-lite',
    sourceDocument: 'medical/p1/card-0123abcd.jpg',
    recordedBy: 'admin@example.com',
  });
  assert.equal(fields.source, 'llm-extracted');
  assert.equal(fields.confirmedBy, null);
  assert.equal(fields.confirmedAt, null);
  assert.equal(fields.extractedFrom, 'vaccination-card');
  assert.equal(fields.extractedByModel, 'flash-lite');
  assert.equal(fields.sourceDocument, 'medical/p1/card-0123abcd.jpg');
  assert.equal(fields.recordedBy, 'admin@example.com');
  assert.deepEqual(fields.codes, []);
  // Never extracted from a card, so never set by one.
  assert.equal(fields.validFrom, null);
  assert.equal(fields.validUntil, null);
  assert.equal(fields.notes, null);
  assert.equal(fields.extractionEvidence.performedAt.snippet, '14/02/2025');
});

// ─── where the card lives ────────────────────────────────────────────────────

test('a card photo path is flat under medical/{petId}', () => {
  assert.equal(
    cardPhotoPath('abc123', '0f8e2c1a-1b2c-4d5e-8f90-123456789abc'),
    'medical/abc123/card-0f8e2c1a-1b2c-4d5e-8f90-123456789abc.jpg',
  );
});

test('a path with a slash in either id cannot be built', () => {
  assert.throws(() => cardPhotoPath('abc/def', '0f8e2c1a'));
  assert.throws(() => cardPhotoPath('abc', '../x'));
});

test('the route accepts this pet’s card and nothing else', () => {
  const pet = 'abc123';
  assert.equal(isCardPhotoPathFor('medical/abc123/card-0f8e2c1a.jpg', pet), true);
  // another pet's card
  assert.equal(isCardPhotoPathFor('medical/zzz999/card-0f8e2c1a.jpg', pet), false);
  // nested — the deployed rule would refuse it anyway
  assert.equal(isCardPhotoPathFor('medical/abc123/cards/card-0f8e2c1a.jpg', pet), false);
  // an intimate intake photo
  assert.equal(isCardPhotoPathFor('pets/abc123/private/0f8e2c1a.jpg', pet), false);
  // traversal and look-alikes
  assert.equal(isCardPhotoPathFor('medical/abc123/card-../../x.jpg', pet), false);
  assert.equal(isCardPhotoPathFor('medical/abc123/card-0f8e2c1a.png', pet), false);
  assert.equal(isCardPhotoPathFor('medical/abc123/lab-0f8e2c1a.jpg', pet), false);
  assert.equal(isCardPhotoPathFor(42, pet), false);
});

test('a request body must be exactly a pet id and that pet’s card path', () => {
  assert.deepEqual(
    parseCardExtractRequest({ petId: 'abc123', path: 'medical/abc123/card-0f8e2c1a.jpg' }),
    { petId: 'abc123', path: 'medical/abc123/card-0f8e2c1a.jpg' },
  );
  assert.equal(parseCardExtractRequest({ petId: 'abc123', path: 'medical/other/card-0f8e2c1a.jpg' }), null);
  assert.equal(parseCardExtractRequest({ petId: '../abc', path: 'medical/../abc/card-0f8e2c1a.jpg' }), null);
  assert.equal(parseCardExtractRequest(null), null);
  assert.equal(parseCardExtractRequest('medical/abc123/card-0f8e2c1a.jpg'), null);
});
