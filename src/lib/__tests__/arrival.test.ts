/**
 * Arrival pipeline tests.
 *
 * Run with:  node --test --import tsx src/lib/__tests__/arrival.test.ts
 *
 * The transitions worth asserting are the ones a reasonable person would get
 * wrong: that a returned adoptee reopens its existing record rather than
 * becoming a new animal, that `transito` is a foster HOME and not an en-route
 * state, and that isolation is an area rather than a status.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PET_STATUS_TRANSITIONS,
  canTransition,
  shouldHaveOpenPlacement,
  arrivalAnnouncementText,
  arrivalAnnouncementLink,
} from '../arrival';
import type { PetStatus } from '../types';

// ── the state machine ───────────────────────────────────────────────────────

test('an announced animal can arrive or fall through, and nothing else', () => {
  assert.deepEqual([...PET_STATUS_TRANSITIONS['en-camino']], ['cuarentena', 'cancelado']);
});

test('an announced animal cannot skip quarantine onto the wall', () => {
  // The whole point of the pipeline: nothing reaches `adopcion` without
  // physically arriving and being cleared.
  assert.equal(canTransition('en-camino', 'adopcion'), false);
  assert.equal(canTransition('en-camino', 'refugio'), false);
});

test('quarantine is left by clearance, not by expiry', () => {
  assert.equal(canTransition('cuarentena', 'refugio'), true);
  // Straight onto the wall from quarantine would bypass the vet.
  assert.equal(canTransition('cuarentena', 'adopcion'), false);
});

test('a returned adoptee goes back to the shelter rather than becoming a new animal', () => {
  // Re-admission reopens the existing record — the chip is a deduplication
  // key. If this transition were illegal the wizard would create a duplicate
  // and split the medical history across two records.
  assert.equal(canTransition('adoptado', 'refugio'), true);
  assert.equal(canTransition('adoptado', 'cuarentena'), true);
});

test('a cancelled rescue can come back on', () => {
  assert.equal(canTransition('cancelado', 'en-camino'), true);
});

test('a same-status write is not an illegal transition', () => {
  assert.equal(canTransition('refugio', 'refugio'), true);
});

test('every status has an entry, and every target is a real status', () => {
  // Guards the case where a new PetStatus is added to types.ts and silently
  // omitted here — the machine would then throw on a real animal.
  const statuses = Object.keys(PET_STATUS_TRANSITIONS) as PetStatus[];
  assert.equal(statuses.length, 8);
  for (const from of statuses) {
    for (const to of PET_STATUS_TRANSITIONS[from]) {
      assert.ok(statuses.includes(to), `${from} → ${to} targets an unknown status`);
    }
  }
});

test('isolation is not a status', () => {
  // aislamiento is an AreaKind. A sick animal moves pen without losing its
  // place on the wall, so the two axes stay independent.
  const all = Object.keys(PET_STATUS_TRANSITIONS);
  assert.equal(all.includes('aislamiento'), false);
});

// ── placements vs. foster homes ─────────────────────────────────────────────

test('a fostered animal has no open placement', () => {
  // The boundary that keeps a volunteer's home address out of the area list.
  assert.equal(shouldHaveOpenPlacement('transito'), false);
  assert.equal(shouldHaveOpenPlacement('adoptado'), false);
  assert.equal(shouldHaveOpenPlacement('en-camino'), false);
});

test('an animal physically in the shelter does have one', () => {
  assert.equal(shouldHaveOpenPlacement('cuarentena'), true);
  assert.equal(shouldHaveOpenPlacement('refugio'), true);
  assert.equal(shouldHaveOpenPlacement('adopcion'), true);
});

// ── the WhatsApp announcement ───────────────────────────────────────────────

test('the announcement carries name, breed, origin and the record link', () => {
  const text = arrivalAnnouncementText({
    pet: { name: 'Luna', species: 'perro', breed: 'mestiza' },
    origin: 'Av. Blanco Galindo',
    recordUrl: 'https://wawitas.org/id/abc123',
  });

  assert.match(text, /🐕/);
  assert.match(text, /Luna, mestiza/);
  assert.match(text, /Viene de: Av\. Blanco Galindo/);
  assert.match(text, /https:\/\/wawitas\.org\/id\/abc123/);
});

test('unknown fields are omitted, never rendered as empty or "?"', () => {
  // A dog nobody has met yet has no name. The message must still read like a
  // sentence, or staff learn to ignore it.
  const text = arrivalAnnouncementText({
    pet: { name: '', species: 'perro', breed: '' },
    origin: null,
    recordUrl: 'https://wawitas.org/id/x',
  });

  assert.match(text, /sin datos aún/);
  assert.doesNotMatch(text, /Viene de/);
  assert.doesNotMatch(text, /,\s*$/m);
});

test('a name without a breed does not leave a trailing comma', () => {
  const text = arrivalAnnouncementText({
    pet: { name: 'Rocky', species: 'gato', breed: '' },
    recordUrl: 'https://wawitas.org/id/y',
  });
  assert.match(text, /ingreso en camino: Rocky\n/);
  assert.match(text, /🐈/);
});

test('the link is a wa.me deep link with the text percent-encoded', () => {
  const link = arrivalAnnouncementLink(
    {
      pet: { name: 'Luna', species: 'perro', breed: 'mestiza' },
      recordUrl: 'https://wawitas.org/id/abc',
    },
    '59177903553',
  );

  assert.ok(link.startsWith('https://wa.me/59177903553?text='));
  // The URL in the payload must survive encoding — an unencoded ':' or '/'
  // truncates the message in some clients.
  assert.match(link, /https%3A%2F%2Fwawitas\.org%2Fid%2Fabc/);
  assert.doesNotMatch(link.slice(link.indexOf('?text=')), /\s/);
});
