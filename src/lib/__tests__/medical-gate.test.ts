import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MEDICAL_PROVENANCE_FIELDS,
  byMostRecent,
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
