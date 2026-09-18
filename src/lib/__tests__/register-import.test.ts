/**
 * The paper-register import planner.
 *
 * Run with:  node --test --import tsx src/lib/__tests__/register-import.test.ts
 *
 * ⚠️ Every fixture here is INVENTED. No real animal, rescuer or register row
 * from the shelter appears in this file — `_local/registro/` is gitignored for
 * a reason, and a test fixture is the easiest way for that data to walk into a
 * public repository. The numbers below are hand-chosen to exercise a rule, not
 * copied from the real 225.
 *
 * The cases worth reading first are the ones about DATES. This import writes
 * medical records for 43 animals that are alive and at the shelter, and a
 * fabricated day does not look fabricated once it is in the database: it looks
 * like a vaccination, and it drives a booster reminder. So there are tests that
 * a year-only sterilization produces no record, that an unreadable day produces
 * no record, that a future day produces no record — and, in every one of those
 * cases, that the raw cell text survives on the draft where a person can still
 * resolve it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  boliviaNoonMs,
  buildImportPlan,
  looksLikePersonalContact,
  EVENT_MAPPING,
  type ImportPlanInput,
} from '../register-import';
import { validateMedicalDraft, medicalDraftDefaults } from '../medical';

const TODAY = '2026-09-18';
const BATCH = 'registro-2026-09-18';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

type Cell = string | { excelDate: string; note: string };

function row(no: number, cells: Record<string, Cell> = {}) {
  return { no, xlsxRow: no + 3, colourStatus: 'SIN COLOR', cells };
}

function normalized(no: number, over: Record<string, unknown> = {}) {
  return {
    no,
    nameRaw: 'NUBE',
    displayName: 'Nube',
    hasRealName: true,
    aliasesInCell: [],
    litter: null,
    species: 'dog',
    speciesEvidence: 'INFERRED: tiene octavalente.',
    sex: 'female',
    intakeRaw: '12/03/24',
    intakeDate: '2024-03-12',
    dateNote: null,
    ageAtIntake: { raw: 'DE 2 ANOS', minMonths: 24, maxMonths: 24 },
    status: 'in-shelter',
    statusWhy: 'Fila sin color: sigue en el refugio.',
    statusDate: null,
    statusConflict: false,
    sterilizedPerRegister: false,
    lastRecordedDate: '2026-02-12',
    descriptors: { colour: [], coat: [], breedWords: [] },
    matchHints: {},
    flags: [],
    ...over,
  };
}

function event(over: Record<string, unknown> = {}) {
  return {
    type: 'deworming',
    column: 'deworming',
    date: '2025-06-10',
    precision: 'day',
    raw: '10/06/25',
    source: 'xlsx',
    status: 'confirmed',
    note: null,
    ...over,
  };
}

function animal(no: number, events: unknown[], over: Record<string, unknown> = {}) {
  return { no, name: 'Nube', events, ...over };
}

function plan(over: Partial<ImportPlanInput> = {}) {
  return buildImportPlan({
    rows: [row(1)],
    normalized: [normalized(1)],
    medical: { animals: [animal(1, [event()])], summary: {} },
    batch: BATCH,
    today: TODAY,
    draftIdFor: (no) => `draft-${no}`,
    ...over,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule 5 — the instant a register day stands for
// ─────────────────────────────────────────────────────────────────────────────

test('a register day becomes local noon in Bolivia, pinned to the exact millisecond', () => {
  // ⚠️ The literal is the point. Asserting `boliviaNoonMs(d) === Date.UTC(...)`
  // would compare the function against its own arithmetic and pass however
  // wrong both were — the 2026-08-27 tautology. 2025-06-10T16:00:00Z is
  // 12:00 on 10 June 2025 in Cochabamba, and this number must not change when
  // the import runs on a machine that is not in Bolivia.
  assert.equal(boliviaNoonMs('2025-06-10'), 1_749_571_200_000);
  assert.equal(new Date(1_749_571_200_000).toISOString(), '2025-06-10T16:00:00.000Z');
});

test('the stored instant does not depend on the runtime timezone', () => {
  // Same claim, stated as a property: the function reads no local clock and no
  // local offset, so UTC arithmetic reproduces it exactly. CI runs in UTC and
  // the dev machine does not; the same row must produce the same millisecond.
  const y = 2024;
  const m = 11;
  const d = 30;
  assert.equal(boliviaNoonMs('2024-11-30'), Date.UTC(y, m - 1, d, 16, 0, 0));
});

test('a day the calendar does not have is not a day', () => {
  // "31/04/26" is a real cell in this register. `Date.UTC` rolls it forward to
  // 1 May without complaining, which would store a vaccination on a date the
  // vet never wrote.
  assert.equal(boliviaNoonMs('2026-04-31'), null);
  assert.equal(boliviaNoonMs('2025-02-30'), null);
  assert.equal(boliviaNoonMs('2023'), null);
  assert.equal(boliviaNoonMs('EN 2023'), null);
  assert.equal(boliviaNoonMs(''), null);
});

test('a medical record is stamped at Bolivian noon', () => {
  const result = plan();
  assert.equal(result.medical.length, 1);
  assert.equal(result.medical[0]!.data.performedAtMs, Date.UTC(2025, 5, 10, 16, 0, 0));
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 1 — entries
// ─────────────────────────────────────────────────────────────────────────────

test('every register row becomes an entry, whatever its status', () => {
  const statuses = ['in-shelter', 'adopted', 'returned', 'died', 'transferred'];
  const result = plan({
    rows: statuses.map((_, i) => row(i + 1)),
    normalized: statuses.map((status, i) => normalized(i + 1, { status })),
    medical: { animals: [] },
  });

  assert.equal(result.entries.length, 5);
  assert.equal(result.stats.entries, 5);
  assert.deepEqual(result.stats.byStatus, {
    'in-shelter': 1,
    adopted: 1,
    returned: 1,
    died: 1,
    transferred: 1,
  });
  // The document id is the register number as a string: one row, one document,
  // and a re-run overwrites rather than duplicates.
  assert.deepEqual(
    result.entries.map((e) => e.id),
    ['1', '2', '3', '4', '5']
  );
});

test('an unknown species becomes null and is never guessed', () => {
  const result = plan({ normalized: [normalized(1, { species: 'unknown' })] });
  assert.equal(result.entries[0]!.data.species, null);
  // And the draft's species stays empty too, so the camera can still answer it.
  assert.equal(result.drafts[0]!.data.species, null);
});

test('statusConfirmed is false on every entry, with no way to set it', () => {
  const result = plan({
    rows: [row(1), row(2)],
    normalized: [
      normalized(1, { status: 'in-shelter' }),
      // Even a row that claims to be confirmed upstream: this import cannot
      // confirm anything, because nobody has done a roll call.
      normalized(2, { status: 'adopted', statusConfirmed: true }),
    ],
    medical: { animals: [] },
  });
  assert.equal(result.entries.length, 2);
  for (const entry of result.entries) assert.equal(entry.data.statusConfirmed, false);
});

test('petId and linkConfidence are null even on a row that gets a draft', () => {
  const result = plan();
  assert.equal(result.drafts.length, 1, 'this row does get a draft');
  assert.equal(result.entries[0]!.data.petId, null);
  assert.equal(result.entries[0]!.data.linkConfidence, null);
});

test('the entry carries the import batch, which is the rollback key', () => {
  const result = plan();
  assert.equal(result.entries[0]!.data.importBatch, BATCH);
  assert.equal(result.batch, BATCH);
});

test('responsible comes from the rows file, with a long digit run stripped', () => {
  const result = plan({
    rows: [row(1, { responsible: 'GRUPO RESCATE SUR 70123456' })],
  });
  // The name is the useful half and it survives; the number does not reach a
  // document, and what is left does not trip the tripwire either.
  assert.equal(result.entries[0]!.data.responsible, 'GRUPO RESCATE SUR');
  assert.deepEqual(result.blockers, []);
});

test('a responsible cell that is only a phone number becomes null, not an empty string', () => {
  const result = plan({ rows: [row(1, { responsible: '+591 70123456' })] });
  assert.equal(result.entries[0]!.data.responsible, null);
  assert.deepEqual(result.blockers, []);
});

test('colour and coat words the register wrote become one note, breed words stay a list', () => {
  const result = plan({
    normalized: [
      normalized(1, {
        descriptors: { colour: ['negro'], coat: ['pomposo'], breedWords: ['husky'] },
      }),
    ],
  });
  assert.equal(result.entries[0]!.data.colourNote, 'negro, pomposo');
  assert.deepEqual(result.entries[0]!.data.breedWords, ['husky']);
  // ⚠️ And none of it reaches the DRAFT: the photo session fills those fields.
  assert.equal(result.drafts[0]!.data.colorPattern, '');
  assert.equal(result.drafts[0]!.data.coatType, '');
  assert.equal(result.drafts[0]!.data.breed, '');
});

test('a row with no descriptors gets a null colour note rather than an empty string', () => {
  assert.equal(plan().entries[0]!.data.colourNote, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// The Excel swap is the extractor's job, not this module's
// ─────────────────────────────────────────────────────────────────────────────

test('the entry takes the normalized ISO intake date, never the raw cell', () => {
  // The normalized file has already applied the month/day swap where Excel
  // misparsed a cell. Re-deriving it here would be a second implementation of
  // a rule that was verified once against the real spreadsheet, and the two
  // would drift. `intakeRaw` is carried verbatim so the swap stays auditable.
  const result = plan({
    normalized: [normalized(1, { intakeRaw: '03/12/24', intakeDate: '2024-12-03' })],
  });
  assert.equal(result.entries[0]!.data.intakeDateMs, Date.UTC(2024, 11, 3, 16, 0, 0));
  assert.equal(result.entries[0]!.data.intakeRaw, '03/12/24');
  assert.equal(result.drafts[0]!.data.register?.intakeDay, '2024-12-03');
});

test('a medical record takes the event date, never the raw Excel cell', () => {
  // `excelDate:2024-10-11` is a cell Excel misread; the extractor resolved it
  // to 2024-11-10. The record must be stamped with the resolved day and must
  // still show the operator what the cell said.
  const result = plan({
    medical: {
      animals: [
        animal(1, [
          event({
            type: 'rabies',
            column: 'rabies',
            date: '2024-11-10',
            raw: 'excelDate:2024-10-11',
          }),
        ]),
      ],
    },
  });
  const record = result.medical[0]!;
  assert.equal(record.data.performedAtMs, Date.UTC(2024, 10, 10, 16, 0, 0));
  assert.equal(record.data.importRef.raw, 'excelDate:2024-10-11');
  assert.equal(record.id, 'reg1-rabies-20241110');
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 3 — drafts
// ─────────────────────────────────────────────────────────────────────────────

test('only an in-shelter row gets a draft', () => {
  const statuses = ['in-shelter', 'adopted', 'returned', 'died', 'transferred'];
  const result = plan({
    rows: statuses.map((_, i) => row(i + 1)),
    normalized: statuses.map((status, i) => normalized(i + 1, { status })),
    medical: { animals: statuses.map((_, i) => animal(i + 1, [event()])) },
  });

  assert.equal(result.drafts.length, 1);
  assert.equal(result.drafts[0]!.no, 1);
  assert.equal(result.stats.drafts, 1);
});

test('the draft carries name, sex, slug, sterilized, status and the register ref', () => {
  const result = plan({
    normalized: [normalized(1, { displayName: 'Ñoño Prueba', sex: 'male', sterilizedPerRegister: true })],
    medical: { animals: [] },
  });
  const draft = result.drafts[0]!.data;

  assert.equal(draft.id, 'draft-1');
  assert.equal(draft.name, 'Ñoño Prueba');
  assert.equal(draft.sex, 'male');
  assert.equal(draft.slug, 'nono-prueba', 'accents are folded by slugify, not by this module');
  assert.equal(draft.sterilized, true);
  assert.equal(draft.status, 'shelter');
  assert.equal(draft.register?.no, 1);
  assert.equal(draft.register?.batch, BATCH);
});

test('the draft leaves every field the photo session fills EMPTY', () => {
  // ⚠️ The most important assertion in this file. The intake wizard offers an
  // AI suggestion into an empty field and will not overwrite a filled one, so
  // writing the register's inference here would not add information — it would
  // permanently stop the camera from adding any.
  const result = plan({
    normalized: [
      normalized(1, {
        species: 'dog',
        descriptors: { colour: ['negro'], coat: ['pomposo'], breedWords: ['husky'] },
        ageAtIntake: { raw: 'DE 2 ANOS', minMonths: 24, maxMonths: 24 },
      }),
    ],
  });
  const draft = result.drafts[0]!.data;

  assert.equal(draft.species, null);
  assert.equal(draft.breed, '');
  assert.equal(draft.size, null);
  assert.equal(draft.colorPattern, '');
  assert.equal(draft.coatType, '');
  assert.equal(draft.ageYears, null);
  assert.equal(draft.ageMonthsPart, null);
  assert.equal(draft.ageMonthsMin, null);
  assert.equal(draft.ageMonthsMax, null);
  assert.equal(draft.weightKgMin, null);
  assert.equal(draft.weightKgMax, null);
  // And no model provenance, because no model was involved.
  assert.deepEqual(draft.suggestedFields, []);
  assert.equal(draft.suggestedByModel, null);
});

test('the register ref is provisional, and says how many records were written', () => {
  const result = plan({
    medical: { animals: [animal(1, [event(), event({ date: '2025-07-01', raw: '01/07/25' })])] },
  });
  const ref = result.drafts[0]!.data.register!;
  assert.equal(ref.medicalCount, 2);
  // Nobody has stood in front of this animal yet.
  assert.equal(ref.linkConfidence, 'provisional');
  assert.equal(ref.sexPerRegister, 'female');
});

test('the register sex is kept alongside the draft sex, never merged into one field', () => {
  // `draft.sex` is seeded from the register, and `register.sexPerRegister`
  // keeps saying what the paper said — so when a genital photograph disagrees
  // the wizard can show both and let a person decide.
  const result = plan({ normalized: [normalized(1, { sex: 'female' })] });
  const draft = result.drafts[0]!.data;
  assert.equal(draft.sex, 'female');
  assert.equal(draft.register?.sexPerRegister, 'female');
});

test('a draft id that comes back empty is a blocker, not a document at path ""', () => {
  const result = plan({ draftIdFor: () => '' });
  assert.equal(result.drafts.length, 0);
  assert.ok(result.blockers.some((b) => b.no === 1 && /draftIdFor/.test(b.why)));
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 4 — which events become records
// ─────────────────────────────────────────────────────────────────────────────

test('each register column maps to the right kind and the shelter\'s own word', () => {
  const result = plan({
    medical: {
      animals: [
        animal(1, [
          event({ type: 'octavalent', column: 'octavalentDose1', date: '2025-01-02', raw: '02/01/25' }),
          event({ type: 'rabies', column: 'rabies', date: '2025-01-03', raw: '03/01/25' }),
          event({ type: 'deworming', column: 'deworming', date: '2025-01-04', raw: '04/01/25' }),
          event({ type: 'sterilization', column: 'sterilization', date: '2025-01-05', raw: '05/01/25' }),
        ]),
      ],
    },
  });

  assert.deepEqual(
    result.medical.map((m) => [m.data.kind, m.data.name]),
    [
      ['vaccination', 'Octavalente'],
      ['vaccination', 'Antirrábica'],
      ['deworming', 'Desparasitación'],
      ['sterilization', 'Esterilización'],
    ]
  );
});

test('an "other" event is never imported: it encodes an exit, not a treatment', () => {
  const result = plan({
    medical: {
      animals: [
        animal(1, [event({ type: 'other', column: 'observations', raw: 'MURIO 03/05/25' })]),
      ],
    },
  });

  assert.equal(result.medical.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]!.what, 'otra anotación');
  assert.match(result.skipped[0]!.why, /salida o un fallecimiento/);
  // And the raw text still reaches the person who will read the record.
  assert.match(result.drafts[0]!.data.healthNotes, /MURIO 03\/05\/25/);
});

test('an unconfirmed event is skipped and says so', () => {
  const result = plan({
    medical: { animals: [animal(1, [event({ status: 'needs-human', raw: '10/06/25' })])] },
  });
  assert.equal(result.medical.length, 0);
  assert.equal(
    result.drafts[0]!.data.healthNotes,
    'Registro n.º 1, desparasitación «10/06/25»: sin confirmar con el refugio.'
  );
});

test('an event dated after today is skipped, with its raw text preserved', () => {
  const result = plan({
    medical: {
      animals: [
        animal(1, [
          event({ type: 'deworming', date: '2026-12-02', raw: '02/12/26', status: 'needs-human' }),
        ]),
      ],
    },
  });

  assert.equal(result.medical.length, 0);
  // Both reasons, in the order a person would say them. A note that mentioned
  // only one sends whoever chases it looking for the wrong thing.
  assert.equal(
    result.drafts[0]!.data.healthNotes,
    'Registro n.º 1, desparasitación «02/12/26»: fecha futura, sin confirmar con el refugio.'
  );
  assert.deepEqual(result.skipped, [
    { no: 1, what: 'desparasitación', why: 'fecha futura, sin confirmar con el refugio', raw: '02/12/26' },
  ]);
});

test('today is the cut-off, and moving it changes what is imported', () => {
  const future = { medical: { animals: [animal(1, [event({ date: '2026-10-20', raw: '20/10/26' })])] } };

  const before = plan({ ...future, today: '2026-09-18' });
  assert.equal(before.medical.length, 0, 'dated after today: skipped');
  assert.match(before.skipped[0]!.why, /fecha futura/);

  const after = plan({ ...future, today: '2026-11-01' });
  assert.equal(after.medical.length, 1, 'the same event, once the day has passed');
  assert.equal(after.skipped.length, 0);
});

test('an event dated exactly today is imported, not refused as future', () => {
  const result = plan({
    medical: { animals: [animal(1, [event({ date: TODAY, raw: '18/09/26' })])] },
  });
  assert.equal(result.medical.length, 1);
  assert.deepEqual(result.blockers, []);
});

test('an impossible day is skipped and named as impossible', () => {
  const result = plan({
    medical: {
      animals: [animal(1, [event({ date: '2026-04-31', precision: 'day', raw: '31/04/26' })])],
    },
  });
  assert.equal(result.medical.length, 0);
  assert.match(result.drafts[0]!.data.healthNotes, /fecha imposible en el calendario/);
  assert.match(result.drafts[0]!.data.healthNotes, /«31\/04\/26»/);
});

test('medical records are planned only for animals that get a draft', () => {
  const result = plan({
    rows: [row(1), row(2)],
    normalized: [normalized(1, { status: 'in-shelter' }), normalized(2, { status: 'adopted' })],
    medical: { animals: [animal(1, [event()]), animal(2, [event()])] },
  });

  assert.equal(result.medical.length, 1);
  assert.equal(result.medical[0]!.no, 1);
  assert.equal(result.medical[0]!.petId, 'draft-1');
});

test('an imported record carries its provenance and claims no model read it', () => {
  const result = plan();
  const record = result.medical[0]!.data;

  assert.deepEqual(record.importRef, {
    batch: BATCH,
    registerNo: 1,
    column: 'deworming',
    raw: '10/06/25',
    sheet: 'xlsx',
  });
  assert.equal(
    record.notes,
    'Transcrito del registro en papel, n.º 1, columna «deworming»: «10/06/25».'
  );
  assert.equal(record.source, 'manual');
  assert.deepEqual(record.codes, []);
  assert.equal(record.extractedByModel, null);
  assert.equal(record.extractedAtMs, null);
  assert.equal(record.extractedFrom, null);
  assert.equal(record.extractionEvidence, null);
  assert.equal(record.sourceDocument, null);
  // The register has columns for none of these, and a blank lot number is the
  // common case in Bolivia rather than an incomplete record.
  assert.equal(record.nextDueAtMs, null);
  assert.equal(record.validFromMs, null);
  assert.equal(record.validUntilMs, null);
  assert.equal(record.veterinarian, null);
  assert.equal(record.clinic, null);
  assert.equal(record.batch, null);
  assert.equal(record.manufacturer, null);
});

test('the sheet a value was read from travels with the record', () => {
  const result = plan({
    medical: { animals: [animal(1, [event({ source: 'pdf' })])] },
  });
  assert.equal(result.medical[0]!.data.importRef.sheet, 'pdf');
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 6 — the medical form's own validator
// ─────────────────────────────────────────────────────────────────────────────

test('every mapped event produces a record the medical form would accept', () => {
  // ⚠️ The blocker branch in `buildImportPlan` is UNREACHABLE with today's
  // mapping — every mapped kind is set, every name is non-empty, and the date
  // filter already refuses the future. Rather than pretend a test covers it,
  // this asserts the COUPLING it protects: if someone adds a column here with
  // an empty name, or forgets a kind, the validator that guards the form would
  // reject it — and the import would then block instead of writing a record
  // the UI considers impossible and nobody can correct through the UI.
  const past = Date.UTC(2025, 5, 10, 16, 0, 0);
  const now = Date.UTC(2026, 8, 18, 16, 0, 0);

  for (const [column, mapping] of Object.entries(EVENT_MAPPING)) {
    const errors = validateMedicalDraft(
      { ...medicalDraftDefaults(), kind: mapping.kind, name: mapping.name, performedAt: past },
      now
    );
    assert.deepEqual(errors, [], `${column} must map to a record the form accepts`);
  }
});

test('the validator has teeth: an unnamed record is refused', () => {
  // The control for the test above. If `validateMedicalDraft` accepted
  // anything, the assertion that every mapping passes would mean nothing.
  const errors = validateMedicalDraft(
    {
      ...medicalDraftDefaults(),
      kind: 'vaccination',
      name: '',
      performedAt: Date.UTC(2025, 5, 10, 16, 0, 0),
    },
    Date.UTC(2026, 8, 18, 16, 0, 0)
  );
  assert.ok(errors.includes('name-required'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 7 — a sterilization with no exact date
// ─────────────────────────────────────────────────────────────────────────────

test('a year-only sterilization sets the flag, writes a note, and creates NO record', () => {
  const result = plan({
    normalized: [normalized(1, { sterilizedPerRegister: false })],
    medical: {
      animals: [
        animal(1, [
          event({
            type: 'sterilization',
            column: 'sterilization',
            date: '2023',
            precision: 'year',
            raw: 'EN 2023',
          }),
        ]),
      ],
    },
  });

  assert.equal(result.medical.length, 0, 'there is no approximate-date field to put this in');
  assert.equal(result.drafts[0]!.data.sterilized, true, 'the register does assert the fact');
  assert.equal(
    result.drafts[0]!.data.healthNotes,
    'Registro n.º 1, esterilización «EN 2023»: en 2023, según el registro, sin fecha exacta.'
  );
  assert.deepEqual(result.skipped, [
    { no: 1, what: 'esterilización', why: 'sin fecha exacta', raw: 'EN 2023' },
  ]);
});

test('a sterilization with no date at all still sets the flag and keeps its words', () => {
  const result = plan({
    normalized: [normalized(1, { sterilizedPerRegister: false })],
    medical: {
      animals: [
        animal(1, [
          event({
            type: 'sterilization',
            column: 'sterilization',
            date: null,
            precision: 'none',
            raw: 'ENTRO ESTERELIZADA',
          }),
        ]),
      ],
    },
  });

  assert.equal(result.medical.length, 0);
  assert.equal(result.drafts[0]!.data.sterilized, true);
  assert.equal(
    result.drafts[0]!.data.healthNotes,
    'Registro n.º 1, esterilización «ENTRO ESTERELIZADA»: según el registro, sin fecha exacta.'
  );
});

test('a dated sterilization does become a record', () => {
  const result = plan({
    medical: {
      animals: [
        animal(1, [
          event({ type: 'sterilization', column: 'sterilization', date: '2020-11-30', raw: '30/11/20' }),
        ]),
      ],
    },
  });
  assert.equal(result.medical.length, 1);
  assert.equal(result.medical[0]!.data.kind, 'sterilization');
  assert.equal(result.drafts[0]!.data.sterilized, true);
  assert.equal(result.drafts[0]!.data.healthNotes, '', 'nothing was skipped, so nothing is noted');
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 8 — nothing the register wrote is ever lost
// ─────────────────────────────────────────────────────────────────────────────

test('every skipped event keeps its raw text on the draft, one line each', () => {
  const result = plan({
    medical: {
      animals: [
        animal(1, [
          event({ date: '2026-12-02', raw: '02/12/26', status: 'needs-human' }),
          event({ type: 'rabies', column: 'rabies', date: '2026-10-20', raw: '20/10/26' }),
          event({ type: 'other', column: 'observations', raw: 'SE LO LLEVARON' }),
        ]),
      ],
    },
  });

  const lines = result.drafts[0]!.data.healthNotes.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(result.skipped.length, 3);
  // Every raw cell survives somewhere a person will read it.
  for (const raw of ['02/12/26', '20/10/26', 'SE LO LLEVARON']) {
    assert.ok(
      lines.some((line) => line.includes(raw)),
      `raw ${raw} must survive on the draft`
    );
  }
  // And every line names the register row, so the paper can be found again.
  for (const line of lines) assert.match(line, /^Registro n\.º 1, /);
});

test('an animal with nothing skipped gets no health notes at all', () => {
  assert.equal(plan().drafts[0]!.data.healthNotes, '');
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 9 — deterministic ids
// ─────────────────────────────────────────────────────────────────────────────

test('record ids are reg{no}-{column}-{YYYYMMDD}', () => {
  const result = plan({
    medical: {
      animals: [
        animal(1, [event({ type: 'octavalent', column: 'octavalentDose2', date: '2024-10-26', raw: '26/10/24' })]),
      ],
    },
  });
  assert.equal(result.medical[0]!.id, 'reg1-octavalentDose2-20241026');
});

test('two records on the same day in the same column get -2, -3', () => {
  const twice = [
    event({ date: '2025-06-10', raw: '10/06/25' }),
    event({ date: '2025-06-10', raw: '10/06/25 (repetida)' }),
    event({ date: '2025-06-10', raw: '10/06/25 (tercera)' }),
  ];
  const result = plan({ medical: { animals: [animal(1, twice)] } });

  assert.deepEqual(
    result.medical.map((m) => m.id),
    ['reg1-deworming-20250610', 'reg1-deworming-20250610-2', 'reg1-deworming-20250610-3']
  );
});

test('the suffix is scoped to one animal: two animals cannot collide', () => {
  const result = plan({
    rows: [row(1), row(2)],
    normalized: [normalized(1), normalized(2)],
    medical: { animals: [animal(1, [event()]), animal(2, [event()])] },
  });
  assert.deepEqual(
    result.medical.map((m) => m.id),
    ['reg1-deworming-20250610', 'reg2-deworming-20250610']
  );
});

test('running the planner twice produces an identical plan', () => {
  // What makes the import re-runnable, and what lets a rollback find exactly
  // what one batch wrote. A random id would make the second run a duplicate
  // import rather than a correction of the first.
  const input: Partial<ImportPlanInput> = {
    rows: [row(1), row(2)],
    normalized: [normalized(1), normalized(2, { status: 'adopted' })],
    medical: {
      animals: [
        animal(1, [
          event(),
          event({ date: '2025-06-10', raw: '10/06/25 (repetida)' }),
          event({ type: 'sterilization', column: 'sterilization', date: '2023', precision: 'year', raw: 'EN 2023' }),
        ]),
      ],
    },
  };

  assert.deepEqual(plan(input), plan(input));
  assert.equal(JSON.stringify(plan(input)), JSON.stringify(plan(input)));
});

test('the plan is JSON-serialisable: no Date, no Timestamp, no undefined', () => {
  const result = plan();
  const roundTripped = JSON.parse(JSON.stringify(result));
  assert.deepEqual(roundTripped, result);
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 2 — the PII tripwire
// ─────────────────────────────────────────────────────────────────────────────

test('the tripwire recognises a Bolivian mobile, however it is spaced', () => {
  assert.ok(looksLikePersonalContact('77903553'));
  assert.ok(looksLikePersonalContact('7790 3553'));
  assert.ok(looksLikePersonalContact('7-790-3553'));
  assert.ok(looksLikePersonalContact('+591 77903553'));
  assert.ok(looksLikePersonalContact('591-6-123-4567'));
  assert.ok(looksLikePersonalContact('llamar al 60123456 por favor'));
});

test('the tripwire recognises a decimal coordinate', () => {
  assert.ok(looksLikePersonalContact('-17.123456'));
  assert.ok(looksLikePersonalContact('-66.123456'));
  assert.ok(looksLikePersonalContact('casa en -17.3935, -66.1570000'));
});

test('the tripwire does not fire on the things a register actually says', () => {
  // A tripwire that cries wolf is a tripwire somebody switches off, so the
  // false-positive cases are as load-bearing as the true ones. All of these
  // appear in the real register.
  for (const safe of [
    'EN 2023',
    'AÑO 2018',
    '30/11/20',
    '10/10/24 21/10/24 18/10/25 12/02/26',
    'GRUPO RESCATE SUR',
    'excelDate:2024-10-11',
    'Registro n.º 217, esterilización «ENTRO ESTERELIZADA»: según el registro, sin fecha exacta.',
    'DE 8 ANOS',
    'BB3-AURORA',
  ]) {
    assert.equal(looksLikePersonalContact(safe), false, `must not fire on ${safe}`);
  }
});

test('a phone number reaching the plan is a BLOCKER, never a silent drop', () => {
  // ⚠️ Blocking is the whole point. A silent scrub produces a clean-looking
  // import and tells nobody the extraction is leaking a column, so the leak
  // survives into the next batch.
  const result = plan({
    normalized: [normalized(1, { statusWhy: 'Se fue con la vecina, cel 7790 3553.' })],
  });

  assert.equal(result.blockers.length, 1);
  assert.equal(result.blockers[0]!.no, 1);
  assert.match(result.blockers[0]!.why, /personal contact data/);
  // The value is still IN the plan — it was not quietly removed. The plan
  // simply must not run.
  assert.match(result.entries[0]!.data.statusWhy, /7790 3553/);
});

test('a coordinate reaching the plan is a blocker too', () => {
  const result = plan({
    normalized: [normalized(1, { flags: ['Recogida en -17.393600, -66.157000'] })],
  });
  assert.ok(result.blockers.some((b) => b.no === 1 && /personal contact data/.test(b.why)));
});

test('the tripwire reaches drafts, medical records and skipped items too', () => {
  // Not just entries: a leak through the notes on a draft is the same leak.
  const viaDraft = plan({
    medical: {
      animals: [
        animal(1, [event({ status: 'needs-human', raw: 'preguntar al 70123456' })]),
      ],
    },
  });
  assert.ok(viaDraft.blockers.length >= 1);
  assert.ok(viaDraft.blockers.some((b) => /draft 1/.test(b.why)));
  assert.ok(viaDraft.blockers.some((b) => /skipped 1/.test(b.why)));

  const viaRecord = plan({
    medical: { animals: [animal(1, [event({ raw: 'dosis dada, cel 70123456' })])] },
  });
  assert.ok(viaRecord.blockers.some((b) => /medical reg1-/.test(b.why)));
});

test('the adopter column is never read, however much is in it', () => {
  const result = plan({
    rows: [
      row(1, {
        responsible: 'GRUPO RESCATE SUR',
        adopterColumn: '[datos de adoptante] cel 77903553, casa en -17.393600, -66.157000',
      }),
    ],
  });

  // Nothing from that cell reaches the plan, so the tripwire has nothing to
  // find: a clean run here means the column was not read, not that it was
  // cleaned up afterwards.
  assert.deepEqual(result.blockers, []);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('77903553'), false);
  assert.equal(serialized.includes('-17.393600'), false);
  assert.equal(serialized.includes('adoptante'), false);
  assert.equal(result.entries[0]!.data.responsible, 'GRUPO RESCATE SUR');
});

test('the source never names the adopter column outside a comment', () => {
  // ⚠️ Crude, and worth having anyway. The behavioural test above proves the
  // column is not read TODAY; this one fails the moment someone iterates the
  // cells object or spreads it by name. Comments are stripped first so that
  // the warnings about this column cannot satisfy or fail the check.
  const source = readFileSync(join(process.cwd(), 'src/lib/register-import.ts'), 'utf8');
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  assert.equal(
    /adopterColumn/.test(code),
    false,
    'register-import.ts must not reference adopterColumn in code'
  );
  // Positive control: the needle IS present in the file, in a comment, so a
  // clean result above means "absent from code" and not "absent from the file".
  assert.ok(/adopterColumn/.test(source));
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 11 — blockers stop the import; skipped is normal
// ─────────────────────────────────────────────────────────────────────────────

test('a healthy plan has no blockers, and skipping is not a blocker', () => {
  const result = plan({
    medical: { animals: [animal(1, [event(), event({ type: 'other', raw: 'MURIO' })])] },
  });
  assert.deepEqual(result.blockers, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.medical.length, 1);
});

test('a malformed today blocks and plans nothing', () => {
  const result = plan({ today: '18/09/2026' });
  assert.equal(result.entries.length, 0);
  assert.ok(result.blockers.some((b) => /today must be YYYY-MM-DD/.test(b.why)));
});

test('an empty batch blocks: there would be no rollback key', () => {
  assert.ok(plan({ batch: '' }).blockers.some((b) => /rollback key/.test(b.why)));
});

test('a register number appearing twice blocks rather than overwriting', () => {
  // `no` is the document id, so two rows claiming one number would silently
  // leave whichever came second.
  const result = plan({
    rows: [row(1), row(1)],
    normalized: [normalized(1, { displayName: 'Nube' }), normalized(1, { displayName: 'Trueno' })],
    medical: { animals: [] },
  });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]!.data.name, 'Nube');
  assert.ok(result.blockers.some((b) => b.no === 1 && /twice/.test(b.why)));
});

test('an unrecognised status blocks rather than being coerced', () => {
  const result = plan({ normalized: [normalized(1, { status: 'quizás' })] });
  assert.equal(result.entries.length, 0);
  assert.ok(result.blockers.some((b) => b.no === 1 && /unrecognised status/.test(b.why)));
});

test('an unreadable event blocks rather than disappearing', () => {
  const result = plan({
    medical: { animals: [animal(1, [{ type: 'brujería', raw: '??' }])] },
  });
  assert.ok(result.blockers.some((b) => b.no === 1 && /could not be read/.test(b.why)));
});

test('a malformed input file blocks and plans nothing', () => {
  assert.ok(plan({ normalized: {} }).blockers.some((b) => /normalized must be an array/.test(b.why)));
  assert.ok(plan({ rows: 'nope' }).blockers.some((b) => /rows must be an array/.test(b.why)));
  assert.ok(plan({ medical: 42 }).blockers.some((b) => /medical must be/.test(b.why)));
});

test('the medical file may be handed over as a bare array of animals', () => {
  const result = plan({ medical: [animal(1, [event()])] });
  assert.equal(result.medical.length, 1);
  assert.deepEqual(result.blockers, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────────────────────────────────

test('the stats describe the plan that was actually built', () => {
  const result = plan({
    rows: [row(1), row(2), row(3)],
    normalized: [
      normalized(1, { status: 'in-shelter' }),
      normalized(2, { status: 'adopted' }),
      normalized(3, { status: 'died' }),
    ],
    medical: {
      animals: [animal(1, [event(), event({ type: 'other', raw: 'NOTA' })])],
    },
  });

  assert.deepEqual(result.stats, {
    entries: 3,
    byStatus: { 'in-shelter': 1, adopted: 1, died: 1 },
    drafts: 1,
    medical: 1,
    skipped: 1,
  });
  assert.equal(result.stats.entries, result.entries.length);
  assert.equal(result.stats.drafts, result.drafts.length);
  assert.equal(result.stats.medical, result.medical.length);
  assert.equal(result.stats.skipped, result.skipped.length);
});

// ─────────────────────────────────────────────────────────────────────────────
// A description is not a name
//
// 47 of the 225 register rows hold a description where a name should be, and 4
// of those animals live at the shelter today. `name` and `slug` reach
// `pets/{id}`, which is public-read, so copying one through would publish
// "BB3 (pomposo, con negro)" as an animal's name the first time somebody
// photographs it. Caught in review before any import ran.
// ─────────────────────────────────────────────────────────────────────────────

test('a row that holds a description instead of a name produces no name and no slug', () => {
  const result = plan({
    rows: [row(217)],
    normalized: [
      normalized(217, {
        hasRealName: false,
        nameRaw: 'BB3 COLOR BLANCO C/NEGRO POMPOSO',
        displayName: 'BB3 (pomposo, con negro)',
      }),
    ],
    medical: { animals: [] },
  });

  const draft = result.drafts[0]!.data;
  assert.equal(draft.name, '', 'a description was promoted into the public name field');
  assert.equal(draft.slug, '', 'a description became the animal’s public URL');

  // What the paper says is not lost — it travels where a person can read it.
  assert.equal(draft.register!.nameRaw, 'BB3 COLOR BLANCO C/NEGRO POMPOSO');
  assert.equal(result.entries[0]!.data.hasRealName, false);
});

test('a row that holds a real name still gets it, and a slug', () => {
  const result = plan({
    rows: [row(30)],
    normalized: [normalized(30, { hasRealName: true, displayName: 'Canela' })],
    medical: { animals: [] },
  });

  const draft = result.drafts[0]!.data;
  assert.equal(draft.name, 'Canela');
  assert.equal(draft.slug, 'canela');
});
