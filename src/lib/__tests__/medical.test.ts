import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RABIES_MIN_AGE_WEEKS,
  RABIES_PROTECTION_DELAY_DAYS,
  byMostRecent,
  isOverdue,
  medicalDraftDefaults,
  medicalWarnings,
  nextDue,
  protectionLapsed,
  rabiesAgeIsValid,
  rabiesProtectionStart,
  validateMedicalDraft,
  type MedicalRecordDraft,
} from '../medical';
import { CLOCK_SKEW_TOLERANCE_MS } from '../placements';

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-26T12:00:00Z');

function draft(over: Partial<MedicalRecordDraft> = {}): MedicalRecordDraft {
  return {
    ...medicalDraftDefaults(),
    kind: 'vaccination',
    name: 'Rabia',
    performedAt: NOW - 30 * DAY,
    ...over,
  };
}

// ─── the Bolivia campaign case ───────────────────────────────────────────────

test('a vaccination with NO vet and NO batch is valid', () => {
  // Bolivia's free national rabies campaign produces exactly this. Rejecting it
  // would reject most of the real records this shelter holds.
  const errors = validateMedicalDraft(
    draft({ veterinarian: null, batch: null, clinic: null, manufacturer: null }),
    NOW
  );
  assert.deepEqual(errors, []);
});

// ─── structural errors ───────────────────────────────────────────────────────

test('kind, name and date are required', () => {
  const errors = validateMedicalDraft(
    draft({ kind: null, name: '   ', performedAt: null }),
    NOW
  );
  assert.ok(errors.includes('kind-required'));
  assert.ok(errors.includes('name-required'));
  assert.ok(errors.includes('performed-required'));
});

test('a dose dated in the future is rejected', () => {
  const errors = validateMedicalDraft(draft({ performedAt: NOW + 3 * DAY }), NOW);
  assert.ok(errors.includes('performed-in-future'));
});

test('a dose dated seconds ahead is NOT rejected — clocks drift', () => {
  // Firestore measured 2.7s ahead of this machine; a browser clock drifts by
  // minutes. Without tolerance a vet entering "today" is told it is the future.
  const errors = validateMedicalDraft(
    draft({ performedAt: NOW + CLOCK_SKEW_TOLERANCE_MS - 1000 }),
    NOW
  );
  assert.equal(errors.includes('performed-in-future'), false);
});

test('a due date before the dose is rejected', () => {
  const errors = validateMedicalDraft(
    draft({ performedAt: NOW - 10 * DAY, nextDueAt: NOW - 20 * DAY }),
    NOW
  );
  assert.ok(errors.includes('due-before-performed'));
});

test('protection ending before it begins is rejected', () => {
  const errors = validateMedicalDraft(
    draft({ validFrom: NOW, validUntil: NOW - DAY }),
    NOW
  );
  assert.ok(errors.includes('valid-until-before-valid-from'));
});

// ─── warnings never block ────────────────────────────────────────────────────

test('a rabies dose given BEFORE the chip warns, and does not error', () => {
  const d = draft({ performedAt: NOW - 30 * DAY });
  const warnings = medicalWarnings(d, { microchipImplantedAt: NOW - 10 * DAY });
  assert.ok(warnings.includes('rabies-before-microchip'));
  // Crucially: still saveable.
  assert.deepEqual(validateMedicalDraft(d, NOW), []);
});

test('a chip implanted before the dose produces no warning', () => {
  const warnings = medicalWarnings(draft({ performedAt: NOW - 10 * DAY }), {
    microchipImplantedAt: NOW - 30 * DAY,
  });
  assert.equal(warnings.includes('rabies-before-microchip'), false);
});

test('an UNKNOWN implant date produces no opinion either way', () => {
  const warnings = medicalWarnings(draft(), { microchipImplantedAt: null });
  assert.equal(warnings.includes('rabies-before-microchip'), false);
});

// ─── the EU 2026/131 minimum-age rule ────────────────────────────────────────

test('rabies age validity is THREE-state, not a boolean', () => {
  // null means "cannot be evaluated", which is different from "too young".
  // Most street rescues have no birthdate at all.
  assert.equal(rabiesAgeIsValid(null, NOW), null);
});

test('an animal younger than 12 weeks at vaccination is flagged', () => {
  const birth = NOW - 8 * 7 * DAY; // 8 weeks old
  assert.equal(rabiesAgeIsValid(birth, NOW), false);
  const warnings = medicalWarnings(draft({ performedAt: NOW }), {
    birthdateApprox: birth,
  });
  assert.ok(warnings.includes('rabies-under-age'));
});

test('an animal at exactly 12 weeks is old enough', () => {
  const birth = NOW - RABIES_MIN_AGE_WEEKS * 7 * DAY;
  assert.equal(rabiesAgeIsValid(birth, NOW), true);
});

test('an unknown birthdate never produces an under-age warning', () => {
  const warnings = medicalWarnings(draft({ performedAt: NOW }), {
    birthdateApprox: null,
  });
  assert.equal(warnings.includes('rabies-under-age'), false);
});

test('a birthdate after the vaccination is unanswerable, not a violation', () => {
  assert.equal(rabiesAgeIsValid(NOW + DAY, NOW), null);
});

// ─── derived dates ───────────────────────────────────────────────────────────

test('rabies protection begins 21 days after the dose, not on the day', () => {
  // ⚠️ The 21 is written LITERALLY here, deliberately. Asserting against
  // RABIES_PROTECTION_DELAY_DAYS would be a tautology: changing the constant
  // would change both sides and the test could never fail. A break-probe
  // caught exactly that. 21 days is a legal figure from Reg. (EU) 2026/131,
  // so pinning it is the point.
  assert.equal(rabiesProtectionStart(NOW), NOW + 21 * DAY);
  assert.equal(RABIES_PROTECTION_DELAY_DAYS, 21);
});

test('a rabies record with no protection-start date is flagged', () => {
  const warnings = medicalWarnings(draft({ validFrom: null }));
  assert.ok(warnings.includes('rabies-no-valid-from'));
});

test('a non-rabies vaccination is not held to the rabies rules', () => {
  const warnings = medicalWarnings(
    draft({ name: 'Quíntuple', validFrom: null, nextDueAt: NOW + 365 * DAY }),
    { birthdateApprox: NOW - 4 * 7 * DAY }
  );
  assert.equal(warnings.includes('rabies-no-valid-from'), false);
  assert.equal(warnings.includes('rabies-under-age'), false);
});

// ─── due vs lapsed are different questions ───────────────────────────────────

test('a booster past its date is overdue', () => {
  assert.equal(isOverdue(NOW - DAY, NOW), true);
});

test('a booster due in the future is not overdue', () => {
  assert.equal(isOverdue(NOW + DAY, NOW), false);
});

test('a record with no due date is never overdue', () => {
  // A consultation has no booster and must not appear in a reminder list.
  assert.equal(isOverdue(null, NOW), false);
});

test('overdue tolerates clock skew', () => {
  assert.equal(isOverdue(NOW - 1000, NOW), false);
});

test('protection lapsing is a DIFFERENT question from a booster being due', () => {
  // Immunity commonly outlasts the booster interval. Conflating them is how an
  // animal gets revaccinated needlessly, or travels on cover that expired.
  const dueYesterday = NOW - DAY;
  const stillProtected = NOW + 200 * DAY;
  assert.equal(isOverdue(dueYesterday, NOW), true);
  assert.equal(protectionLapsed(stillProtected, NOW), false);
});

test('a record with no validUntil is not treated as lapsed', () => {
  assert.equal(protectionLapsed(null, NOW), false);
});

// ─── ordering ────────────────────────────────────────────────────────────────

test('history reads most recent first', () => {
  const sorted = byMostRecent([
    { performedAt: NOW - 100 * DAY, kind: 'vaccination' as const },
    { performedAt: NOW - 10 * DAY, kind: 'consultation' as const },
    { performedAt: NOW - 50 * DAY, kind: 'deworming' as const },
  ]);
  assert.deepEqual(
    sorted.map((r) => r.kind),
    ['consultation', 'deworming', 'vaccination']
  );
});

test('byMostRecent does not mutate its input', () => {
  const input = [
    { performedAt: 1, kind: 'vaccination' as const },
    { performedAt: 2, kind: 'consultation' as const },
  ];
  byMostRecent(input);
  assert.equal(input[0]!.performedAt, 1);
});

test('nextDue picks the soonest and ignores records with no due date', () => {
  const soonest = nextDue([
    { nextDueAt: null },
    { nextDueAt: NOW + 300 * DAY },
    { nextDueAt: NOW + 30 * DAY },
  ]);
  assert.equal(soonest?.nextDueAt, NOW + 30 * DAY);
});

test('nextDue returns null when nothing is scheduled', () => {
  assert.equal(nextDue([{ nextDueAt: null }, { nextDueAt: null }]), null);
});
