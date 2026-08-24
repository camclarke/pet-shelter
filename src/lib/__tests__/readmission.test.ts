/**
 * Re-admission logic — plan section 3.1, build order step 6.
 *
 * Everything under test here is pure, which is the reason `readmission.ts` has
 * no Firestore import: the naming chain and the lookup verdict are decidable
 * from their arguments, so they are exercisable with `pets` holding zero
 * documents. What these tests do NOT cover is stated plainly at the bottom of
 * this file — the half that needs a real chipped animal.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  custodyKindForStatus,
  nextFormerNames,
  planReadmission,
  readChipMatches,
  READMISSION_STATUSES,
  type ChipMatch,
} from '../readmission';
import { chipConflictApplies, draftDefaults, validateStep } from '../intake';

function match(overrides: Partial<ChipMatch> = {}): ChipMatch {
  return {
    id: 'pet-1',
    slug: 'luna',
    name: 'Luna',
    formerNames: [],
    status: 'adopted',
    coverPhoto: null,
    species: 'dog',
    sex: 'female',
    size: 'medium',
    breed: 'mestiza',
    ageMonths: 24,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The lookup verdict
// ─────────────────────────────────────────────────────────────────────────────

test('no match reads as unregistered', () => {
  assert.deepEqual(readChipMatches([]), { kind: 'unregistered' });
});

test('one match reads as registered and carries the pet', () => {
  const verdict = readChipMatches([match()]);
  assert.equal(verdict.kind, 'registered');
  assert.equal(verdict.kind === 'registered' && verdict.pet.name, 'Luna');
});

test('two matches read as ambiguous rather than picking one', () => {
  // The whole reason findPetByMicrochipAdmin() reads limit(2) instead of
  // limit(1). One credential on two animals is a fact a human resolves; a
  // query that silently returns the first hides it.
  const verdict = readChipMatches([match(), match({ id: 'pet-2', name: 'Sol' })]);
  assert.equal(verdict.kind, 'ambiguous');
  assert.equal(verdict.kind === 'ambiguous' && verdict.pets.length, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// The naming chain
// ─────────────────────────────────────────────────────────────────────────────

test('an unchanged name leaves the chain alone', () => {
  assert.deepEqual(nextFormerNames({ name: 'Luna', formerNames: [] }, 'Luna'), []);
});

test('a blank name means "unchanged", not "erase the name"', () => {
  assert.deepEqual(nextFormerNames({ name: 'Luna', formerNames: ['Nube'] }, '   '), ['Nube']);
});

test('a rename appends the outgoing name, oldest first', () => {
  assert.deepEqual(nextFormerNames({ name: 'Luna', formerNames: ['Nube'] }, 'Sol'), [
    'Nube',
    'Luna',
  ]);
});

test('case and whitespace alone are not a rename', () => {
  assert.deepEqual(nextFormerNames({ name: 'Luna', formerNames: [] }, '  luna '), []);
});

test('reverting to an older name removes it from the chain instead of duplicating it', () => {
  // The invariant: formerNames holds every name that is NOT the current one.
  // Appending blindly would leave Luna in both places and make the record
  // contradict itself.
  assert.deepEqual(nextFormerNames({ name: 'Sol', formerNames: ['Luna'] }, 'Luna'), ['Sol']);
});

test('the chain never accumulates duplicates', () => {
  assert.deepEqual(
    nextFormerNames({ name: 'Sol', formerNames: ['Luna', 'luna', 'Nube'] }, 'Cielo'),
    ['Luna', 'Nube', 'Sol'],
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// The plan
// ─────────────────────────────────────────────────────────────────────────────

test('a re-admission with no rename keeps the existing name', () => {
  const plan = planReadmission(match(), { name: '', status: 'shelter', note: '' });
  assert.equal(plan.name, 'Luna');
  assert.equal(plan.renamed, false);
  assert.deepEqual(plan.formerNames, []);
  assert.equal(plan.statusChanged, true); // adopted -> shelter
  assert.equal(plan.note, null);
});

test('a re-admission with a rename records both names', () => {
  const plan = planReadmission(match(), { name: 'Sol', status: 'quarantine', note: '  ' });
  assert.equal(plan.name, 'Sol');
  assert.equal(plan.renamed, true);
  assert.deepEqual(plan.formerNames, ['Luna']);
  assert.equal(plan.status, 'quarantine');
  assert.equal(plan.note, null, 'a whitespace-only note is no note');
});

test('a note survives trimming', () => {
  const plan = planReadmission(match(), {
    name: '',
    status: 'shelter',
    note: '  la devolvieron por mudanza  ',
  });
  assert.equal(plan.note, 'la devolvieron por mudanza');
});

test('returning to the same status is not a status change', () => {
  const plan = planReadmission(match({ status: 'shelter' }), {
    name: '',
    status: 'shelter',
    note: '',
  });
  assert.equal(plan.statusChanged, false);
});

test('the plan never contains a field that removes history', () => {
  // A guard against the one way this function could go wrong later: it must
  // only ever describe the public-tier fields that legitimately move. Medical
  // records, the chip and the photos are appended to, never rewritten.
  const plan = planReadmission(match(), { name: 'Sol', status: 'shelter', note: 'x' });
  assert.deepEqual(Object.keys(plan).sort(), [
    'formerNames',
    'name',
    'note',
    'renamed',
    'status',
    'statusChanged',
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Custody
// ─────────────────────────────────────────────────────────────────────────────

test('custody kind follows the status, not the wording', () => {
  assert.equal(custodyKindForStatus('foster'), 'foster');
  assert.equal(custodyKindForStatus('adopted'), 'adopter');
  assert.equal(custodyKindForStatus('shelter'), 'shelter');
  // Both of these are still the shelter holding the animal.
  assert.equal(custodyKindForStatus('quarantine'), 'shelter');
  assert.equal(custodyKindForStatus('available'), 'shelter');
});

test('a re-admission cannot set a status that contradicts it', () => {
  // "adopted" and "lost" would each mean the animal is not in our hands, which
  // is the opposite of what a re-admission asserts.
  assert.ok(!READMISSION_STATUSES.includes('adopted'));
  assert.ok(!READMISSION_STATUSES.includes('lost'));
  assert.ok(!READMISSION_STATUSES.includes('cancelled'));
  assert.ok(READMISSION_STATUSES.includes('shelter'));
});

test('the default re-admission status is not the public wall', () => {
  // Publishing to the front page of a live shelter's site stays a decision.
  assert.equal(READMISSION_STATUSES[0], 'shelter');
});

// ─────────────────────────────────────────────────────────────────────────────
// The conflict gate — "es otro animal"
// ─────────────────────────────────────────────────────────────────────────────

function conflicted() {
  return {
    ...draftDefaults('draft-1'),
    name: 'Rocky',
    species: 'dog' as const,
    sex: 'male' as const,
    size: 'large' as const,
    breed: 'mestizo',
    ageYears: 3,
    slug: 'rocky',
    hasMicrochip: true,
    microchipCode: '068123456789012',
    chipConflict: { petId: 'pet-1', code: '068123456789012' },
  };
}

test('a flagged conflict blocks the identity step', () => {
  assert.ok(validateStep('identity', conflicted()).includes('microchip-conflict'));
});

test('re-scanning a corrected code clears the conflict', () => {
  // The most likely cause by far is a transposed digit. A gate that stayed
  // shut after the correction would just teach people to uncheck the box.
  const draft = { ...conflicted(), microchipCode: '068123456789013' };
  assert.ok(!chipConflictApplies(draft));
  assert.ok(!validateStep('identity', draft).includes('microchip-conflict'));
});

test('separators do not disguise the conflicting code', () => {
  // Normalisation has to happen on both sides, or retyping the same number
  // with spaces reads as a fresh code and reopens the hole.
  const draft = { ...conflicted(), microchipCode: '068 1234 5678 9012' };
  assert.ok(chipConflictApplies(draft));
});

test('unchecking "has microchip" clears the conflict', () => {
  // No chip means no identity document, so there is no credential left to
  // collide with. This is a legitimate way out, not a loophole.
  const draft = { ...conflicted(), hasMicrochip: false };
  assert.ok(!chipConflictApplies(draft));
  assert.ok(!validateStep('identity', draft).includes('microchip-conflict'));
});

test('a draft with no recorded conflict is unaffected', () => {
  const draft = { ...conflicted(), chipConflict: null };
  assert.ok(!chipConflictApplies(draft));
});

/**
 * ⚠️ WHAT THESE TESTS DO NOT PROVE.
 *
 * Every assertion above is over pure functions. The half that needs live data
 * is `findPetByMicrochipAdmin()` — the collection-group query against
 * `identity.code`, the `fieldOverrides` entry it depends on, and the
 * `allow read: if isAdmin()` rule that lets an admin client run it at all.
 * None of that is exercised here, and it cannot be until at least one chipped
 * pet exists.
 *
 * Recorded rather than glossed over because this project's most-repeated
 * failure is a query that returns nothing and reads as "no data". A green run
 * of this file means the DECISIONS are right, not that the lookup resolves.
 */
