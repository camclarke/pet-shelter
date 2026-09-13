import test from 'node:test';
import assert from 'node:assert/strict';

import {
  awaitingReview,
  canConfirmAsIs,
  confirmedOnly,
  evidenceVerdict,
  isConfirmed,
  readEvidence,
  reviewerLabel,
  sanitizeConfidence,
} from '../review-gate';

/**
 * The review gate, plan §4.8. Every threshold below is a LITERAL, never the
 * constant under test: a test that reads the constant it checks cannot fail
 * when the constant changes (the 2026-08-27 rabies-delay tautology).
 */

// ─── the predicate fails toward EXCLUDED ─────────────────────────────────────

test('a record with a named confirmer counts', () => {
  assert.equal(isConfirmed({ confirmedBy: 'vet@example.com' }), true);
});

test('a model-extracted record written with confirmedBy null does NOT count', () => {
  assert.equal(isConfirmed({ confirmedBy: null }), false);
});

test('an empty or whitespace confirmer does not count', () => {
  // A form that saved '' or a stray space must not read as "somebody checked".
  assert.equal(isConfirmed({ confirmedBy: '' }), false);
  assert.equal(isConfirmed({ confirmedBy: '   ' }), false);
});

test('a malformed document missing confirmedBy does not count', () => {
  // Firestore data is not typed at runtime. A document without the field must
  // fail toward excluded, not toward "undefined is not null, so it counts".
  assert.equal(isConfirmed({} as { confirmedBy: string | null }), false);
  assert.equal(isConfirmed({ confirmedBy: 42 } as unknown as { confirmedBy: string | null }), false);
});

test('the gate ignores source: a "manual" record with no confirmer is excluded', () => {
  // The reader defaults a missing `source` to 'manual'. If the gate keyed on
  // source, such a document would count without anyone having vouched for it.
  const record = { source: 'manual' as const, confirmedBy: null };
  assert.equal(isConfirmed(record), false);
});

test('an extracted record counts once a person confirms it', () => {
  const record = { source: 'llm-extracted' as const, confirmedBy: 'admin@example.com' };
  assert.equal(isConfirmed(record), true);
});

test('confirmedOnly and awaitingReview partition a list without reordering it', () => {
  const records = [
    { id: 'a', confirmedBy: 'x' },
    { id: 'b', confirmedBy: null },
    { id: 'c', confirmedBy: 'y' },
    { id: 'd', confirmedBy: '' },
  ];
  assert.deepEqual(confirmedOnly(records).map((r) => r.id), ['a', 'c']);
  assert.deepEqual(awaitingReview(records).map((r) => r.id), ['b', 'd']);
});

test('a confirmation is attributed to the email, or the uid when there is none', () => {
  assert.equal(reviewerLabel({ email: 'a@b.c', uid: 'u1' }), 'a@b.c');
  assert.equal(reviewerLabel({ email: null, uid: 'u1' }), 'u1');
  assert.equal(reviewerLabel({ email: '  ', uid: 'u1' }), 'u1');
});

test('only structural errors and explicit blockers stop a one-click confirm', () => {
  assert.equal(canConfirmAsIs([]), true);
  assert.equal(canConfirmAsIs(['performed-required']), false);
  // Step 11's critical-disagreement policy arrives through the second list.
  assert.equal(canConfirmAsIs([], ['critical-dose-disagreement']), false);
});

// ─── confidence is sanitised toward zero ─────────────────────────────────────

test('a usable confidence passes through unchanged', () => {
  assert.equal(sanitizeConfidence(0), 0);
  assert.equal(sanitizeConfidence(0.73), 0.73);
  assert.equal(sanitizeConfidence(1), 1);
});

test('an out-of-range confidence is zero, never clamped or rescaled', () => {
  // 95 is not "95%": it is a model ignoring the 0..1 contract. Guessing what it
  // meant would be exactly the repair this path must not make.
  assert.equal(sanitizeConfidence(95), 0);
  assert.equal(sanitizeConfidence(1.01), 0);
  assert.equal(sanitizeConfidence(-0.1), 0);
});

test('a missing or non-numeric confidence is zero', () => {
  assert.equal(sanitizeConfidence(undefined), 0);
  assert.equal(sanitizeConfidence(null), 0);
  assert.equal(sanitizeConfidence('0.9'), 0);
  assert.equal(sanitizeConfidence(Number.NaN), 0);
  assert.equal(sanitizeConfidence(Number.POSITIVE_INFINITY), 0);
});

// ─── prefill / highlight / withhold ──────────────────────────────────────────

const T = { prefillMin: 0.6, highlightBelow: 0.9 };

test('a confident reading is prefilled without a highlight', () => {
  assert.equal(evidenceVerdict({ snippet: 'Quíntuple', confidence: 0.95 }, T), 'prefill');
  assert.equal(evidenceVerdict({ snippet: 'Quíntuple', confidence: 0.9 }, T), 'prefill');
});

test('a middling reading is prefilled AND highlighted', () => {
  assert.equal(
    evidenceVerdict({ snippet: 'Quíntuple', confidence: 0.89 }, T),
    'prefill-highlighted',
  );
  assert.equal(
    evidenceVerdict({ snippet: 'Quíntuple', confidence: 0.6 }, T),
    'prefill-highlighted',
  );
});

test('a reading below the prefill bar is withheld', () => {
  assert.equal(evidenceVerdict({ snippet: 'Quíntuple', confidence: 0.59 }, T), 'withhold');
});

test('an empty snippet is withheld however confident the model says it is', () => {
  // Confidence in nothing is not evidence of anything.
  assert.equal(evidenceVerdict({ snippet: null, confidence: 1 }, T), 'withhold');
  assert.equal(evidenceVerdict({ snippet: '  ', confidence: 1 }, T), 'withhold');
});

test('a garbage confidence withholds rather than prefills', () => {
  assert.equal(
    evidenceVerdict({ snippet: 'Rabia', confidence: 97 as number }, T),
    'withhold',
  );
});

// ─── evidence read back from Firestore ───────────────────────────────────────

test('a record with no evidence map reads as null', () => {
  assert.equal(readEvidence(undefined), null);
  assert.equal(readEvidence(null), null);
  assert.equal(readEvidence('nope'), null);
  assert.equal(readEvidence([]), null);
});

test('stored evidence is sanitised field by field', () => {
  const read = readEvidence({
    name: { snippet: 'Rabia', confidence: 0.8, withheld: null },
    performedAt: { snippet: 12, confidence: 'high', withheld: 'invented-reason' },
    batch: 'not an object',
  });
  assert.deepEqual(read, {
    name: { snippet: 'Rabia', confidence: 0.8, withheld: null },
    performedAt: { snippet: null, confidence: 0, withheld: null },
  });
});

test('a known withheld reason survives the round trip', () => {
  const read = readEvidence({
    performedAt: { snippet: '1?/03/25', confidence: 0.4, withheld: 'unreadable-date' },
  });
  assert.equal(read?.performedAt?.withheld, 'unreadable-date');
});
