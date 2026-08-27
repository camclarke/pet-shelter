import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCK_ON_CRITICAL_DISAGREEMENT,
  CRITICAL_FIELDS,
  displayOnlyDoseAid,
  foldName,
  reviewDictation,
  sameDose,
  type DictationExtraction,
  type MedicationClaim,
} from '../dictation';

function med(over: Partial<MedicationClaim> = {}): MedicationClaim {
  return {
    name: 'Ivermectina',
    dose: 0.5,
    doseUnit: 'ml',
    concentration: null,
    route: 'sc',
    frequency: 'una vez',
    durationDays: null,
    heardAs: 'medio mililitro de ivermectina',
    confidence: 0.9,
    ...over,
  };
}

function extraction(meds: MedicationClaim[], over: Partial<DictationExtraction> = {}): DictationExtraction {
  return {
    transcript: 'transcripción del extractor',
    findings: null,
    medications: meds,
    ...over,
  };
}

// ─── the error this whole subsystem exists for ───────────────────────────────

test('"medio mililitro" vs "cinco mililitros" is a CRITICAL disagreement', () => {
  const a = extraction([med({ dose: 0.5, heardAs: 'medio mililitro' })]);
  const b = extraction([med({ dose: 5, heardAs: 'cinco mililitros' })]);

  const r = reviewDictation('...', a, b);
  assert.equal(r.medications.length, 1);
  assert.equal(r.medications[0]!.status, 'disputed');
  assert.equal(r.hasCriticalDisagreement, true);

  const d = r.medications[0]!.disagreements.find((x) => x.field === 'dose');
  assert.ok(d, 'expected a dose disagreement');
  assert.equal(d!.critical, true);
  assert.equal(d!.a, 0.5);
  assert.equal(d!.b, 5);
});

test('a disputed dose is NULLED, never resolved by picking one extractor', () => {
  // Picking a winner would present a coin-flip as a reading. The vet fills it in.
  const a = extraction([med({ dose: 0.5 })]);
  const b = extraction([med({ dose: 5 })]);
  const r = reviewDictation('...', a, b);
  assert.equal(r.medications[0]!.medication.dose, null);
});

test('a disputed unit is nulled too — mg and ml are not interchangeable', () => {
  const a = extraction([med({ doseUnit: 'mg' })]);
  const b = extraction([med({ doseUnit: 'ml' })]);
  const r = reviewDictation('...', a, b);
  assert.equal(r.medications[0]!.medication.doseUnit, null);
  assert.equal(r.hasCriticalDisagreement, true);
});

test('both phrasings survive, so the reviewer can see what each model heard', () => {
  const a = extraction([med({ dose: 0.5, heardAs: 'medio mililitro' })]);
  const b = extraction([med({ dose: 5, heardAs: 'cinco mililitros' })]);
  const r = reviewDictation('...', a, b);
  assert.equal(r.medications[0]!.alternateHeardAs, 'cinco mililitros');
  assert.equal(r.medications[0]!.medication.heardAs, 'medio mililitro');
});

// ─── dose comparison ─────────────────────────────────────────────────────────

test('sameDose is exact on VALUE, not on formatting', () => {
  assert.equal(sameDose(0.5, 0.5), true);
  assert.equal(sameDose(0.5, 0.50), true); // same number
  assert.equal(sameDose(0.5, 5), false);
  assert.equal(sameDose(15, 50), false); // near-homophones in speech
});

test('sameDose treats null as agreement only when BOTH are null', () => {
  assert.equal(sameDose(null, null), true);
  assert.equal(sameDose(null, 5), false);
  assert.equal(sameDose(5, null), false);
});

test('sameDose refuses non-finite values rather than comparing them', () => {
  assert.equal(sameDose(Number.NaN, Number.NaN), false);
  assert.equal(sameDose(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY), false);
});

test('there is no tolerance band on doses', () => {
  // A 2% difference is still a difference. Nothing here is close enough to wave
  // through, which is why sameDose has no epsilon.
  assert.equal(sameDose(10, 10.2), false);
});

// ─── medication matching ─────────────────────────────────────────────────────

test('names match across accents, case and punctuation', () => {
  assert.equal(foldName('Ivermectina'), foldName('IVERMECTINA'));
  assert.equal(foldName('Amoxicilina'), foldName('amoxicilina'));
  assert.equal(foldName('Dipirona-sódica'), foldName('dipirona sodica'));
});

test('folding is for MATCHING only — the stored name keeps the vet words', () => {
  const a = extraction([med({ name: 'Dipirona sódica' })]);
  const b = extraction([med({ name: 'dipirona sodica' })]);
  const r = reviewDictation('...', a, b);
  assert.equal(r.medications.length, 1, 'should have matched as one medication');
  // The accented, as-spoken form survives into the record.
  assert.equal(r.medications[0]!.medication.name, 'Dipirona sódica');
});

test('a medication only ONE extractor heard is kept, not dropped', () => {
  const a = extraction([med({ name: 'Ivermectina' }), med({ name: 'Meloxicam' })]);
  const b = extraction([med({ name: 'Ivermectina' })]);
  const r = reviewDictation('...', a, b);

  assert.equal(r.medications.length, 2);
  const solo = r.medications.find((m) => m.medication.name === 'Meloxicam');
  assert.ok(solo);
  assert.equal(solo!.status, 'singleton');
  assert.deepEqual(solo!.heardBy, ['a']);
  assert.equal(r.needsReview, true);
});

test('a singleton from the SECOND extractor is kept too', () => {
  // Keying on A and keeping first-seen would silently discard this.
  const a = extraction([med({ name: 'Ivermectina' })]);
  const b = extraction([med({ name: 'Ivermectina' }), med({ name: 'Meloxicam' })]);
  const r = reviewDictation('...', a, b);

  assert.equal(r.medications.length, 2);
  const solo = r.medications.find((m) => m.medication.name === 'Meloxicam');
  assert.ok(solo);
  assert.equal(solo!.status, 'singleton');
  assert.deepEqual(solo!.heardBy, ['b']);
});

// ─── agreement ───────────────────────────────────────────────────────────────

test('full agreement is confirmed and needs no review', () => {
  const a = extraction([med()]);
  const b = extraction([med()]);
  const r = reviewDictation('la transcripción', a, b);

  assert.equal(r.medications[0]!.status, 'confirmed');
  assert.equal(r.needsReview, false);
  assert.equal(r.hasCriticalDisagreement, false);
  assert.equal(r.medications[0]!.medication.dose, 0.5);
});

test('a non-critical difference disputes without raising the critical flag', () => {
  const a = extraction([med({ frequency: 'cada 12 horas' })]);
  const b = extraction([med({ frequency: 'dos veces al día' })]);
  const r = reviewDictation('...', a, b);

  assert.equal(r.medications[0]!.status, 'disputed');
  assert.equal(r.needsReview, true);
  assert.equal(r.hasCriticalDisagreement, false);
  // The dose was never in dispute, so it survives.
  assert.equal(r.medications[0]!.medication.dose, 0.5);
});

test('the merged confidence is the WEAKER of the pair', () => {
  const a = extraction([med({ confidence: 0.9 })]);
  const b = extraction([med({ confidence: 0.4 })]);
  const r = reviewDictation('...', a, b);
  assert.equal(r.medications[0]!.medication.confidence, 0.4);
});

test('the transcript comes from the dedicated model, not from an extractor', () => {
  const a = extraction([med()], { transcript: 'lo que oyó A' });
  const b = extraction([med()], { transcript: 'lo que oyó B' });
  const r = reviewDictation('la transcripción real', a, b);
  assert.equal(r.transcript, 'la transcripción real');
});

test('dose, unit and concentration are the critical fields', () => {
  assert.deepEqual([...CRITICAL_FIELDS], ['dose', 'doseUnit', 'concentration']);
});

// ─── the dose aid is display-only ────────────────────────────────────────────

test('a mg/kg dose with a known weight yields a LABELLED calculation', () => {
  const aid = displayOnlyDoseAid({ dose: 2, doseUnit: 'mg/kg' }, 12);
  assert.deepEqual(aid, { mg: 24, label: 'calculated' });
});

test('a mg/kg dose with NO weight is uninterpretable, not partial', () => {
  assert.equal(displayOnlyDoseAid({ dose: 2, doseUnit: 'mg/kg' }, null), null);
});

test('a non-weight-based dose is never multiplied by a weight', () => {
  assert.equal(displayOnlyDoseAid({ dose: 5, doseUnit: 'ml' }, 12), null);
  assert.equal(displayOnlyDoseAid({ dose: 5, doseUnit: 'mg' }, 12), null);
});

test('a nonsense weight produces no aid rather than a nonsense number', () => {
  assert.equal(displayOnlyDoseAid({ dose: 2, doseUnit: 'mg/kg' }, 0), null);
  assert.equal(displayOnlyDoseAid({ dose: 2, doseUnit: 'mg/kg' }, -3), null);
  assert.equal(displayOnlyDoseAid({ dose: 2, doseUnit: 'mg/kg' }, Number.NaN), null);
});

// ─── policy, recorded so it is a decision rather than an accident ────────────

test('critical disagreements FLAG rather than block — the owner chose this', () => {
  // Plan §4.7 specified a hard block. The owner decided on 2026-08-26 that the
  // dictating vet reviews and edits their own record. If the UI ever loses the
  // heardAs phrase or the audio timestamp, this should go back to true.
  assert.equal(BLOCK_ON_CRITICAL_DISAGREEMENT, false);
});

test('a null dose produces no aid, whichever guard rejects it', () => {
  // The explicit null check in displayOnlyDoseAid is redundant with the
  // isFinite check, so no break-probe can fail it alone. The behaviour is the
  // thing worth asserting, and it is asserted here.
  assert.equal(displayOnlyDoseAid({ dose: null, doseUnit: 'mg/kg' }, 12), null);
  assert.equal(displayOnlyDoseAid({ dose: null, doseUnit: 'mg/kg' }, null), null);
});

// ─── the degraded path: only one extractor survived ──────────────────────────

test('a lone extractor yields singletons, never confirmations', () => {
  // dictateConsult() compares a surviving extractor against an EMPTY extraction
  // rather than against itself. Comparing a result to itself would mark every
  // medication `confirmed` — a lie, and exactly the false assurance this design
  // exists to prevent.
  const only = extraction([med({ name: 'Ivermectina' }), med({ name: 'Meloxicam' })]);
  const empty = extraction([]);

  const r = reviewDictation('la transcripción', only, empty);

  assert.equal(r.medications.length, 2);
  assert.ok(r.medications.every((m) => m.status === 'singleton'));
  assert.equal(r.needsReview, true);
  // Nothing was contradicted, so nothing is a critical disagreement — but
  // nothing is confirmed either.
  assert.equal(r.hasCriticalDisagreement, false);
  assert.ok(r.medications.every((m) => m.status !== 'confirmed'));
});

test('comparing an extraction against ITSELF would confirm everything', () => {
  // Documents why dictateConsult must NOT do this. If someone ever "simplifies"
  // the degraded path to reviewDictation(t, a, a), this is what they get.
  const a = extraction([med()]);
  const selfCompared = reviewDictation('t', a, a);
  assert.equal(selfCompared.medications[0]!.status, 'confirmed');
  assert.equal(selfCompared.needsReview, false);
});
