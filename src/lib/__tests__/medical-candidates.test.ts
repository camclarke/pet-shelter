import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CandidateGoneError,
  MedicalConfirmationError,
  candidateIdFor,
  inReviewOrder,
  isAlreadyExistsError,
  planConfirmation,
  type CandidateProvenance,
} from '../medical-candidates';
import { medicalDraftDefaults, type MedicalRecordDraft } from '../medical';
import { isConfirmed } from '../review-gate';

/**
 * Candidates and confirmation, after the step-9 evaluation (2026-09-13).
 * Every literal below is a literal, never the constant under test.
 */

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-13T15:00:00Z');
const CARD = 'medical/p1/card-0f8e2c1a-1b2c-4d5e-8f90-123456789abc.jpg';

const PROVENANCE: CandidateProvenance = {
  sourceDocument: CARD,
  extractedByModel: 'flash-lite',
  extractedFrom: 'vaccination-card',
  extractionEvidence: { name: { snippet: 'Quíntuple', confidence: 0.95, withheld: null } },
  extractedAt: NOW - 60_000,
  recordedBy: 'extractor@example.com',
};

function draft(over: Partial<MedicalRecordDraft> = {}): MedicalRecordDraft {
  return {
    ...medicalDraftDefaults(),
    kind: 'vaccination',
    name: 'Quíntuple',
    performedAt: NOW - 30 * DAY,
    ...over,
  };
}

// ─── deterministic ids ───────────────────────────────────────────────────────

test('a candidate id is the source file stem and its index', () => {
  assert.equal(candidateIdFor(CARD, 0), 'card-0f8e2c1a-1b2c-4d5e-8f90-123456789abc-0');
  assert.equal(candidateIdFor(CARD, 7), 'card-0f8e2c1a-1b2c-4d5e-8f90-123456789abc-7');
});

test('the same source and index always give the same id', () => {
  // The idempotency guarantee: a second extraction collides instead of duplicating.
  assert.equal(candidateIdFor(CARD, 3), candidateIdFor(CARD, 3));
});

test('different rows of one source get different ids', () => {
  assert.notEqual(candidateIdFor(CARD, 0), candidateIdFor(CARD, 1));
});

test('a source with no usable stem, or an index out of range, makes no id', () => {
  assert.throws(() => candidateIdFor('medical/p1/card.jpg', 0)); // stem too short
  assert.throws(() => candidateIdFor('medical/p1/a.b.c.jpg', 0)); // dots in the stem
  assert.throws(() => candidateIdFor('', 0));
  assert.throws(() => candidateIdFor(CARD, -1));
  assert.throws(() => candidateIdFor(CARD, 1.5));
  assert.throws(() => candidateIdFor(CARD, 100));
  assert.doesNotThrow(() => candidateIdFor(CARD, 99));
});

// ─── confirmation enforces completeness itself ───────────────────────────────

test('a complete draft confirms into a record carrying the candidate provenance', () => {
  const plan = planConfirmation(PROVENANCE, draft(), 'reviewer@example.com', NOW);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.record.source, 'llm-extracted');
  assert.equal(plan.record.confirmedBy, 'reviewer@example.com');
  assert.equal(plan.record.sourceDocument, CARD);
  assert.equal(plan.record.extractedByModel, 'flash-lite');
  assert.equal(plan.record.extractedFrom, 'vaccination-card');
  assert.equal(plan.record.extractedAt, NOW - 60_000);
  assert.deepEqual(plan.record.extractionEvidence, PROVENANCE.extractionEvidence);
  // Who ran the extraction stays; who confirmed is recorded separately.
  assert.equal(plan.record.recordedBy, 'extractor@example.com');
  assert.deepEqual(plan.record.codes, []);
});

test('the values are what the reviewer accepted, not what the model read', () => {
  const plan = planConfirmation(
    PROVENANCE,
    draft({ name: ' Séxtuple ', batch: 'L-9' }),
    'reviewer@example.com',
    NOW
  );
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.record.name, 'Séxtuple');
  assert.equal(plan.record.batch, 'L-9');
});

test('a draft with no date is refused, and nothing is assembled', () => {
  const plan = planConfirmation(PROVENANCE, draft({ performedAt: null }), 'reviewer@example.com', NOW);
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.ok(plan.errors.includes('performed-required'));
  assert.equal('record' in plan, false);
});

test('a draft with no kind is refused', () => {
  const plan = planConfirmation(PROVENANCE, draft({ kind: null }), 'reviewer@example.com', NOW);
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.ok(plan.errors.includes('kind-required'));
});

test('a draft with no name is refused', () => {
  const plan = planConfirmation(PROVENANCE, draft({ name: '  ' }), 'reviewer@example.com', NOW);
  assert.equal(plan.ok, false);
});

test('a dose dated days in the future is refused', () => {
  const plan = planConfirmation(
    PROVENANCE,
    draft({ performedAt: NOW + 3 * DAY }),
    'reviewer@example.com',
    NOW
  );
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.ok(plan.errors.includes('performed-in-future'));
});

test('a confirmation needs a named reviewer', () => {
  assert.throws(() => planConfirmation(PROVENANCE, draft(), '', NOW));
  assert.throws(() => planConfirmation(PROVENANCE, draft(), '   ', NOW));
});

test('the reviewer is trimmed, and a confirmed record passes the review gate', () => {
  const plan = planConfirmation(PROVENANCE, draft(), '  reviewer@example.com ', NOW);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.record.confirmedBy, 'reviewer@example.com');
  assert.equal(isConfirmed(plan.record), true);
});

test('MedicalConfirmationError carries the reasons', () => {
  const err = new MedicalConfirmationError(['performed-required', 'kind-required']);
  assert.deepEqual([...err.errors], ['performed-required', 'kind-required']);
  assert.equal(err.name, 'MedicalConfirmationError');
  assert.equal(new CandidateGoneError().name, 'CandidateGoneError');
});

// ─── create-if-absent collisions ─────────────────────────────────────────────

test('an already-exists error is recognised from either SDK', () => {
  assert.equal(isAlreadyExistsError({ code: 6 }), true); // Admin SDK, gRPC status
  assert.equal(isAlreadyExistsError({ code: 'already-exists' }), true); // Web SDK
  assert.equal(isAlreadyExistsError(new Error('6 ALREADY_EXISTS: Document already exists')), true);
});

test('other failures are not mistaken for a collision', () => {
  assert.equal(isAlreadyExistsError({ code: 7 }), false);
  assert.equal(isAlreadyExistsError({ code: 'permission-denied' }), false);
  assert.equal(isAlreadyExistsError(new Error('deadline exceeded')), false);
  assert.equal(isAlreadyExistsError(null), false);
});

// ─── review order ────────────────────────────────────────────────────────────

test('the newest card comes first, and a card’s rows keep their order', () => {
  const sorted = inReviewOrder([
    { id: 'old-1', extractedAt: 100, sourceDocument: 'a', sourceIndex: 1 },
    { id: 'new-1', extractedAt: 200, sourceDocument: 'b', sourceIndex: 1 },
    { id: 'old-0', extractedAt: 100, sourceDocument: 'a', sourceIndex: 0 },
    { id: 'new-0', extractedAt: 200, sourceDocument: 'b', sourceIndex: 0 },
  ]);
  assert.deepEqual(
    sorted.map((c) => c.id),
    ['new-0', 'new-1', 'old-0', 'old-1']
  );
});
