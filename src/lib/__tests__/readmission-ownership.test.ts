/**
 * Re-admission ends ownership — the step-14 evaluation's second MAJOR.
 *
 * `reopenPet()` used to leave `adoptions/{petId}` in place, so a returned
 * animal's former family kept passing `ownsPet()` and reading its microchip,
 * location, scans and custody. The decision now lives in the pure
 * `readmissionRevokesOwnership()`, which `reopenPet` calls inside its batch (a
 * source guard in application-wiring.test.ts holds that wiring).
 *
 * Not a field on `ReadmissionPlan`, on purpose: the step-6 test "the plan never
 * contains a field that removes history" pins the plan's keys, and it fired the
 * first time this was tried that way — which is that guard doing its job.
 * Kept in its own file so the step-6 tests stay untouched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { READMISSION_STATUSES, readmissionRevokesOwnership } from '../readmission';

test('every status a re-admission can set revokes the former family\'s ownership', () => {
  // Fostered again included: a family that returned the animal must not be
  // able to read the new foster volunteer's address through ownsPet().
  assert.ok(READMISSION_STATUSES.length > 0);
  for (const status of READMISSION_STATUSES) {
    assert.equal(readmissionRevokesOwnership(status), true, status);
  }
});

test('only an animal being recorded as adopted keeps an owner', () => {
  // Not reachable through a re-admission today. Pinned so that "revoke" does
  // not silently become "always delete whatever ownership exists".
  assert.equal(readmissionRevokesOwnership('adopted'), false);
});
