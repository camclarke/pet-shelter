import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MEDICAL_PROVENANCE_FIELDS,
  answeredByLaterDose,
  byMostRecent,
  doseSeriesKey,
  isRabiesRecord,
  medicalDraftDefaults,
  medicalEditFields,
  nextDue,
  recordSignals,
  summarizeMedicalHistory,
} from '../medical';

/**
 * Plan §4.8: an UNCONFIRMED record counts for nothing that computes.
 *
 * One test per place that computes, each built the same way: a pair of
 * records where the unconfirmed one WOULD win if the gate were missing, so a
 * deleted gate turns a specific test red rather than leaving the suite green.
 * Deliberately break-probed — see the step-9 report.
 */

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-12T12:00:00Z');

function record(over: Partial<ReturnType<typeof base>> = {}) {
  return { ...base(), ...over };
}

function base() {
  return {
    id: 'r',
    kind: 'vaccination' as 'vaccination' | 'deworming' | null,
    name: 'Quíntuple',
    performedAt: NOW - 400 * DAY as number | null,
    nextDueAt: null as number | null,
    validUntil: null as number | null,
    confirmedBy: 'vet@example.com' as string | null,
  };
}

// ─── next-due dates ──────────────────────────────────────────────────────────

test('nextDue skips an unconfirmed record even when it is the soonest', () => {
  const unconfirmed = record({ id: 'model', nextDueAt: NOW + 5 * DAY, confirmedBy: null });
  const confirmed = record({ id: 'vet', nextDueAt: NOW + 50 * DAY });
  assert.equal(nextDue([unconfirmed, confirmed])?.id, 'vet');
});

test('nextDue over only unconfirmed records is null, not their date', () => {
  assert.equal(
    nextDue([record({ nextDueAt: NOW + 5 * DAY, confirmedBy: null })]),
    null
  );
});

// ─── the row flags ───────────────────────────────────────────────────────────

test('an unconfirmed record past its due date is NOT flagged overdue', () => {
  const r = record({ nextDueAt: NOW - 30 * DAY, confirmedBy: null });
  assert.equal(recordSignals(r, NOW).overdue, false);
  // Control: the same dates, confirmed, ARE overdue — so the false above is
  // the gate and not the dates.
  assert.equal(recordSignals({ ...r, confirmedBy: 'vet' }, NOW).overdue, true);
});

test('an unconfirmed record whose protection ended is NOT flagged lapsed', () => {
  const r = record({ validUntil: NOW - 30 * DAY, confirmedBy: null });
  assert.equal(recordSignals(r, NOW).lapsed, false);
  assert.equal(recordSignals({ ...r, confirmedBy: 'vet' }, NOW).lapsed, true);
});

// ─── the aggregate every future badge must use ───────────────────────────────

test('the summary next-due skips an unconfirmed record', () => {
  const s = summarizeMedicalHistory(
    [
      record({ id: 'model', nextDueAt: NOW + 5 * DAY, confirmedBy: null }),
      record({ id: 'vet', nextDueAt: NOW + 50 * DAY }),
    ],
    NOW
  );
  assert.equal(s.nextDue?.id, 'vet');
});

test('the summary overdue list skips an unconfirmed record', () => {
  const s = summarizeMedicalHistory(
    [
      record({ id: 'model', nextDueAt: NOW - 5 * DAY, confirmedBy: null }),
      record({ id: 'vet', nextDueAt: NOW - 50 * DAY }),
    ],
    NOW
  );
  assert.deepEqual(s.overdue.map((r) => r.id), ['vet']);
});

test('the summary lapsed list skips an unconfirmed record', () => {
  const s = summarizeMedicalHistory(
    [
      record({ id: 'model', validUntil: NOW - 5 * DAY, confirmedBy: null }),
      record({ id: 'vet', validUntil: NOW - 50 * DAY }),
    ],
    NOW
  );
  assert.deepEqual(s.lapsed.map((r) => r.id), ['vet']);
});

test('rabies validity reads only a CONFIRMED rabies dose, even if an unconfirmed one is newer', () => {
  // The case that matters: a model reads a rabies date off a card as last
  // month when it was really three years ago. Unconfirmed, it must not become
  // the dose any travel or "vacunado" computation starts from.
  const s = summarizeMedicalHistory(
    [
      record({ id: 'model', name: 'Antirrábica', performedAt: NOW - 30 * DAY, confirmedBy: null }),
      record({ id: 'vet', name: 'Rabia', performedAt: NOW - 300 * DAY }),
    ],
    NOW
  );
  assert.equal(s.latestRabies?.id, 'vet');
});

test('with only unconfirmed rabies doses there is no rabies record at all', () => {
  const s = summarizeMedicalHistory(
    [record({ name: 'Rabia', performedAt: NOW - 30 * DAY, confirmedBy: null })],
    NOW
  );
  assert.equal(s.latestRabies, null);
});

test('the summary counts what is awaiting review, and computes nothing from it', () => {
  const s = summarizeMedicalHistory(
    [
      record({ id: 'a', confirmedBy: null, nextDueAt: NOW - DAY }),
      record({ id: 'b', confirmedBy: '' }),
      record({ id: 'c' }),
    ],
    NOW
  );
  assert.equal(s.awaitingReview, 2);
  assert.deepEqual(s.overdue, []);
});

// ─── "next" never means a date already gone ──────────────────────────────────
//
// Dates here are literals around NOW. The skew tolerance is pinned as a number
// (5 minutes) rather than imported, so a test cannot agree with the code by
// reading the same constant.

const MINUTE = 60_000;

test('a past-due booster is never the summary next-due; it is in overdue', () => {
  const s = summarizeMedicalHistory([record({ id: 'late', nextDueAt: NOW - 30 * DAY })], NOW);
  assert.equal(s.nextDue, null);
  assert.deepEqual(s.overdue.map((r) => r.id), ['late']);
});

test('with one booster past due and one ahead, next-due is the one ahead', () => {
  const s = summarizeMedicalHistory(
    [
      record({ id: 'late', nextDueAt: NOW - 30 * DAY }),
      record({ id: 'ahead', nextDueAt: NOW + 60 * DAY }),
      record({ id: 'further', nextDueAt: NOW + 90 * DAY }),
    ],
    NOW
  );
  assert.equal(s.nextDue?.id, 'ahead');
  assert.deepEqual(s.overdue.map((r) => r.id), ['late']);
});

test('a booster due inside the clock-skew window is still next, and in exactly one list', () => {
  // Two minutes ago: past by the wall clock, not overdue by the 5-minute
  // tolerance. A second comparison against `now` would lose it from both.
  const s = summarizeMedicalHistory([record({ id: 'edge', nextDueAt: NOW - 2 * MINUTE })], NOW);
  assert.equal(s.nextDue?.id, 'edge');
  assert.deepEqual(s.overdue, []);
  // Control: six minutes ago is past the tolerance, and moves across.
  const later = summarizeMedicalHistory([record({ id: 'edge', nextDueAt: NOW - 6 * MINUTE })], NOW);
  assert.equal(later.nextDue, null);
  assert.deepEqual(later.overdue.map((r) => r.id), ['edge']);
});

test('every dated confirmed record is either overdue or not earlier than next-due', () => {
  const dated = [
    record({ id: 'a', nextDueAt: NOW - 400 * DAY }),
    record({ id: 'b', nextDueAt: NOW - 1 * DAY }),
    record({ id: 'c', nextDueAt: NOW + 1 * DAY }),
    record({ id: 'd', nextDueAt: NOW + 400 * DAY }),
  ];
  const s = summarizeMedicalHistory([...dated, record({ id: 'undated' })], NOW);
  const overdueIds = new Set(s.overdue.map((r) => r.id));
  assert.equal(s.nextDue?.id, 'c');
  for (const r of dated) {
    assert.ok(
      overdueIds.has(r.id) || r.nextDueAt! >= s.nextDue!.nextDueAt!,
      `${r.id} is neither overdue nor upcoming`
    );
  }
  assert.equal(overdueIds.has('undated'), false);
});

test('overdue is ordered longest overdue first, whatever order the records arrive in', () => {
  const s = summarizeMedicalHistory(
    [
      record({ id: 'recent', nextDueAt: NOW - 3 * DAY }),
      record({ id: 'oldest', nextDueAt: NOW - 300 * DAY }),
      record({ id: 'middle', nextDueAt: NOW - 30 * DAY }),
    ],
    NOW
  );
  assert.deepEqual(s.overdue.map((r) => r.id), ['oldest', 'middle', 'recent']);
});

test('lapsed is ordered earliest end first', () => {
  const s = summarizeMedicalHistory(
    [
      record({ id: 'recent', validUntil: NOW - 3 * DAY }),
      record({ id: 'oldest', validUntil: NOW - 300 * DAY }),
    ],
    NOW
  );
  assert.deepEqual(s.lapsed.map((r) => r.id), ['oldest', 'recent']);
});

test('lapsed reads validUntil and overdue reads nextDueAt; neither stands in for the other', () => {
  const s = summarizeMedicalHistory(
    [
      // Come-back date gone, declared protection still running.
      record({ id: 'due-only', nextDueAt: NOW - 30 * DAY, validUntil: NOW + 700 * DAY }),
      // Declared protection ended, come-back date still ahead.
      record({ id: 'lapsed-only', nextDueAt: NOW + 30 * DAY, validUntil: NOW - 30 * DAY }),
    ],
    NOW
  );
  assert.deepEqual(s.overdue.map((r) => r.id), ['due-only']);
  assert.deepEqual(s.lapsed.map((r) => r.id), ['lapsed-only']);
  assert.equal(s.nextDue?.id, 'lapsed-only');
});

test('the summary does not reorder the list it was given', () => {
  const given = [
    record({ id: 'recent', nextDueAt: NOW - 3 * DAY, validUntil: NOW - 3 * DAY }),
    record({ id: 'oldest', nextDueAt: NOW - 300 * DAY, validUntil: NOW - 300 * DAY }),
  ];
  summarizeMedicalHistory(given, NOW);
  assert.deepEqual(given.map((r) => r.id), ['recent', 'oldest']);
});

// ─── a later dose answers an earlier one's dates ─────────────────────────────

test('a due date met by a later dose of the same vaccine is not overdue', () => {
  const first = record({ id: 'dose1', performedAt: NOW - 400 * DAY, nextDueAt: NOW - 380 * DAY });
  const second = record({ id: 'dose2', performedAt: NOW - 379 * DAY });
  const s = summarizeMedicalHistory([first, second], NOW);
  assert.deepEqual(s.overdue, []);
  assert.equal(s.nextDue, null);
  assert.deepEqual(s.answered.map((r) => r.id), ['dose1']);
  // Control: without the second dose the same record IS overdue.
  assert.deepEqual(summarizeMedicalHistory([first], NOW).overdue.map((r) => r.id), ['dose1']);
});

test('the latest dose keeps its own due date, overdue or ahead', () => {
  const s = summarizeMedicalHistory(
    [
      record({ id: 'dose1', performedAt: NOW - 800 * DAY, nextDueAt: NOW - 435 * DAY }),
      record({ id: 'dose2', performedAt: NOW - 430 * DAY, nextDueAt: NOW - 65 * DAY }),
    ],
    NOW
  );
  assert.deepEqual(s.overdue.map((r) => r.id), ['dose2']);
});

test('a later dose answers lapsed protection too', () => {
  const s = summarizeMedicalHistory(
    [
      record({ id: 'dose1', performedAt: NOW - 800 * DAY, validUntil: NOW - 435 * DAY }),
      record({ id: 'dose2', performedAt: NOW - 430 * DAY, validUntil: NOW + 300 * DAY }),
    ],
    NOW
  );
  assert.deepEqual(s.lapsed, []);
});

test('a dose given before the due date still answers it', () => {
  const s = summarizeMedicalHistory(
    [
      record({ id: 'dose1', performedAt: NOW - 400 * DAY, nextDueAt: NOW - 30 * DAY }),
      record({ id: 'early', performedAt: NOW - 60 * DAY }),
    ],
    NOW
  );
  assert.deepEqual(s.overdue, []);
});

test('a different vaccine does not answer it', () => {
  const s = summarizeMedicalHistory(
    [
      record({ id: 'octa', name: 'Octavalente', performedAt: NOW - 400 * DAY, nextDueAt: NOW - 30 * DAY }),
      // Deliberately NOT rabies: that has its own key, so it would stay apart
      // even if the name were ignored, and this test would prove nothing.
      record({ id: 'quint', name: 'Quíntuple', performedAt: NOW - 10 * DAY }),
      record({ id: 'rabies', name: 'Antirrábica', performedAt: NOW - 5 * DAY }),
    ],
    NOW
  );
  assert.deepEqual(s.overdue.map((r) => r.id), ['octa']);
  assert.deepEqual(s.answered, []);
});

test('the same name under another kind does not answer it', () => {
  const s = summarizeMedicalHistory(
    [
      record({ id: 'vax', name: 'Refuerzo', performedAt: NOW - 400 * DAY, nextDueAt: NOW - 30 * DAY }),
      record({ id: 'worm', kind: 'deworming', name: 'Refuerzo', performedAt: NOW - 10 * DAY }),
    ],
    NOW
  );
  assert.deepEqual(s.overdue.map((r) => r.id), ['vax']);
});

test('an UNCONFIRMED later dose answers nothing', () => {
  const s = summarizeMedicalHistory(
    [
      record({ id: 'dose1', performedAt: NOW - 400 * DAY, nextDueAt: NOW - 30 * DAY }),
      record({ id: 'model', performedAt: NOW - 10 * DAY, confirmedBy: null }),
    ],
    NOW
  );
  assert.deepEqual(s.overdue.map((r) => r.id), ['dose1']);
  assert.deepEqual(s.answered, []);
});

test('two doses on the same day answer neither', () => {
  const s = summarizeMedicalHistory(
    [
      record({ id: 'a', performedAt: NOW - 400 * DAY, nextDueAt: NOW - 30 * DAY }),
      record({ id: 'b', performedAt: NOW - 400 * DAY, nextDueAt: NOW - 20 * DAY }),
    ],
    NOW
  );
  assert.deepEqual(s.overdue.map((r) => r.id), ['a', 'b']);
});

test('"Rabia" and "Antirrábica" are one series; spelling, case and spacing do not split one', () => {
  assert.equal(doseSeriesKey('vaccination', 'Rabia'), doseSeriesKey('vaccination', 'ANTIRRÁBICA'));
  assert.equal(
    doseSeriesKey('vaccination', '  óctuple   canina '),
    doseSeriesKey('vaccination', 'Octuple Canina')
  );
  assert.notEqual(doseSeriesKey('vaccination', 'Octavalente'), doseSeriesKey('vaccination', 'Óctuple'));
});

test('only vaccinations and dewormings form a series', () => {
  assert.equal(doseSeriesKey('deworming', 'Ivermectina'), 'deworming:ivermectina');
  for (const kind of ['consultation', 'surgery', 'treatment', 'sterilization', 'serology'] as const) {
    assert.equal(doseSeriesKey(kind, 'Control'), null, kind);
  }
  assert.equal(doseSeriesKey(null, 'Rabia'), null);
  assert.equal(doseSeriesKey('vaccination', '   '), null);
});

test('a second consultation does not answer the first one\'s follow-up date', () => {
  const visit = (id: string, over: object) =>
    ({ ...record({ id, name: 'Control' }), kind: 'consultation' as const, ...over });
  const s = summarizeMedicalHistory(
    [
      visit('first', { performedAt: NOW - 400 * DAY, nextDueAt: NOW - 30 * DAY }),
      visit('second', { performedAt: NOW - 10 * DAY }),
    ],
    NOW
  );
  assert.deepEqual(s.overdue.map((r) => r.id), ['first']);
});

test('a row told its record was answered shows neither flag, and says so', () => {
  const r = record({ nextDueAt: NOW - 30 * DAY, validUntil: NOW - 30 * DAY });
  assert.deepEqual(recordSignals(r, NOW, true), { overdue: false, lapsed: false, answered: true });
  // Control: the same record, not answered.
  assert.deepEqual(recordSignals(r, NOW), { overdue: true, lapsed: true, answered: false });
  // The gate still comes first: an unconfirmed record is never "answered".
  assert.equal(recordSignals({ ...r, confirmedBy: null }, NOW, true).answered, false);
});

test('answeredByLaterDose applies the gate itself, on a mixed list', () => {
  const answered = answeredByLaterDose([
    record({ id: 'dose1', performedAt: NOW - 400 * DAY }),
    record({ id: 'model-old', performedAt: NOW - 500 * DAY, confirmedBy: null }),
    record({ id: 'dose2', performedAt: NOW - 10 * DAY }),
  ]);
  assert.deepEqual([...answered].map((r) => r.id), ['dose1']);
});

test('a candidate with no kind and no date does not break the summary', () => {
  const s = summarizeMedicalHistory(
    [record({ kind: null, name: '', performedAt: null, confirmedBy: null })],
    NOW
  );
  assert.equal(s.awaitingReview, 1);
  assert.equal(s.latestRabies, null);
});

test('the latest confirmed rabies dose wins over an older one', () => {
  const s = summarizeMedicalHistory(
    [
      record({ id: 'old', name: 'Rabia', performedAt: NOW - 700 * DAY }),
      record({ id: 'new', name: 'Rabia', performedAt: NOW - 20 * DAY }),
    ],
    NOW
  );
  assert.equal(s.latestRabies?.id, 'new');
});

// ─── recognising rabies in the card's own words ──────────────────────────────

test('"Antirrábica" is recognised as rabies — the accent must not break the match', () => {
  assert.equal(isRabiesRecord('vaccination', 'Antirrábica'), true);
  assert.equal(isRabiesRecord('vaccination', 'ANTIRRÁBICA'), true);
});

test('the other spellings a card or a vet uses are recognised too', () => {
  assert.equal(isRabiesRecord('vaccination', 'Rabia'), true);
  assert.equal(isRabiesRecord('vaccination', 'RABISIN'), true);
  assert.equal(isRabiesRecord('vaccination', 'antirrabica'), true);
});

test('a non-rabies vaccine, or a rabies word on a non-vaccination, is not rabies', () => {
  assert.equal(isRabiesRecord('vaccination', 'Quíntuple'), false);
  assert.equal(isRabiesRecord('deworming', 'Rabia'), false);
  assert.equal(isRabiesRecord(null, 'Rabia'), false);
});

// ─── ordering ────────────────────────────────────────────────────────────────

test('a candidate with no date sorts last, not first', () => {
  const sorted = byMostRecent([
    { performedAt: null, kind: null },
    { performedAt: NOW - 10 * DAY, kind: 'vaccination' as const },
    { performedAt: NOW - 1 * DAY, kind: 'deworming' as const },
  ]);
  assert.deepEqual(
    sorted.map((r) => r.performedAt),
    [NOW - 1 * DAY, NOW - 10 * DAY, null]
  );
});

// ─── editing never touches provenance ────────────────────────────────────────

test('an edit carries no provenance field, so it cannot relabel a record', () => {
  const fields = medicalEditFields({
    ...medicalDraftDefaults(),
    kind: 'vaccination',
    name: ' Quíntuple ',
    performedAt: NOW - DAY,
  });
  for (const key of MEDICAL_PROVENANCE_FIELDS) {
    assert.equal(key in fields, false, `edit fields must not contain ${key}`);
  }
});

test('the provenance list names the fields that would have been wiped', () => {
  // Pinned literally: removing one of these from the list would silently let
  // an edit write it again.
  for (const key of ['source', 'sourceDocument', 'extractedByModel', 'extractionEvidence', 'confirmedBy']) {
    assert.ok(
      (MEDICAL_PROVENANCE_FIELDS as readonly string[]).includes(key),
      `${key} must be protected`
    );
  }
});

test('edit fields are trimmed, and an empty optional becomes null', () => {
  const fields = medicalEditFields({
    ...medicalDraftDefaults(),
    kind: 'vaccination',
    name: '  Rabia ',
    performedAt: NOW - DAY,
    batch: '   ',
    veterinarian: ' Dra. Pérez ',
  });
  assert.equal(fields.name, 'Rabia');
  assert.equal(fields.batch, null);
  assert.equal(fields.veterinarian, 'Dra. Pérez');
});

test('an incomplete draft cannot produce edit fields', () => {
  assert.throws(() => medicalEditFields({ ...medicalDraftDefaults(), kind: 'vaccination' }));
  assert.throws(() =>
    medicalEditFields({ ...medicalDraftDefaults(), performedAt: NOW - DAY })
  );
});
