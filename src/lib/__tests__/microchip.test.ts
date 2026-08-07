/**
 * Microchip validation tests.
 *
 * Run with:  node --test --import tsx src/lib/__tests__/microchip.test.ts
 *
 * These cover the cases that silently corrupt data if they regress, rather
 * than the ones that are obviously broken. In particular: a Bolivian country
 * prefix (068) must keep its leading zero, and the 38-bit national ID ceiling
 * is an exact boundary, not an approximation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateIsoMicrochip,
  validateNonIsoMicrochip,
  formatMicrochipCode,
  normalizeMicrochipCode,
  rabiesVaccinationIsValid,
  MAX_NATIONAL_ID,
} from '../microchip';

test('accepts a well-formed 15-digit ISO code', () => {
  const r = validateIsoMicrochip('985112001234567');
  assert.equal(r.valid, true);
  assert.equal(r.parsed?.prefix, '985');
  assert.equal(r.parsed?.prefixKind, 'manufacturer');
  assert.equal(r.parsed?.nationalId, '112001234567');
});

test('normalises the separators scanners and vet records actually emit', () => {
  for (const raw of ['985 1120 0123 4567', '985-112-001-234-567', '985.112001234567']) {
    assert.equal(validateIsoMicrochip(raw).valid, true, raw);
    assert.equal(validateIsoMicrochip(raw).parsed?.code, '985112001234567');
  }
  assert.equal(normalizeMicrochipCode('985 112-001.234567'), '985112001234567');
});

test('preserves leading zeros — a low ISO 3166 country code depends on it', () => {
  // 068 is Bolivia. Parsed as a number this becomes 68 and the chip is corrupt.
  const r = validateIsoMicrochip('068000000000001');
  assert.equal(r.valid, true);
  assert.equal(r.parsed?.code, '068000000000001');
  assert.equal(r.parsed?.prefix, '068');
  assert.equal(r.parsed?.prefixKind, 'country');
});

test('classifies the three ICAR prefix ranges', () => {
  assert.equal(validateIsoMicrochip('076112001234567').parsed?.prefixKind, 'country');
  assert.equal(validateIsoMicrochip('900112001234567').parsed?.prefixKind, 'manufacturer-shared');
  assert.equal(validateIsoMicrochip('998112001234567').parsed?.prefixKind, 'manufacturer');
});

test('rejects 999 test transponders', () => {
  // ICAR reserves 999 for scanner-calibration chips. One typed in during
  // training would collide with every other test chip in the world.
  const r = validateIsoMicrochip('999112001234567');
  assert.equal(r.valid, false);
  assert.equal(r.error, 'test-transponder');
});

test('enforces exactly 15 digits', () => {
  assert.equal(validateIsoMicrochip('98511200123456').error, 'wrong-length');
  assert.equal(validateIsoMicrochip('9851120012345678').error, 'wrong-length');
  assert.equal(validateIsoMicrochip('').error, 'empty');
  assert.equal(validateIsoMicrochip('98511200123456X').error, 'non-numeric');
});

test('enforces the 38-bit national ID ceiling at the exact boundary', () => {
  assert.equal(MAX_NATIONAL_ID, 274_877_906_943n);
  assert.equal(validateIsoMicrochip('985274877906943').valid, true);
  assert.equal(validateIsoMicrochip('985274877906944').error, 'national-id-overflow');
});

test('accepts legacy non-ISO 9 and 10 digit chips', () => {
  assert.equal(validateNonIsoMicrochip('123456789').valid, true);
  assert.equal(validateNonIsoMicrochip('1234567890').valid, true);
  assert.equal(validateNonIsoMicrochip('12345678').error, 'wrong-length');
});

test('formats a code in readable groups', () => {
  assert.equal(formatMicrochipCode('985112001234567'), '985 1120 0123 4567');
});

test('EU 576/2013: the chip must be implanted before the rabies vaccination', () => {
  const implanted = new Date('2026-01-10');
  assert.equal(rabiesVaccinationIsValid(implanted, new Date('2026-01-20')), true);
  assert.equal(rabiesVaccinationIsValid(implanted, new Date('2026-01-05')), false);
  // Same day is acceptable — the regulation requires the vaccination not precede marking.
  assert.equal(rabiesVaccinationIsValid(implanted, new Date('2026-01-10')), true);
});
