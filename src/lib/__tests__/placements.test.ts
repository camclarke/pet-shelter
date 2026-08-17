/**
 * Placement interval and outbreak contact-tracing tests.
 *
 * Run with:  node --test --import tsx src/lib/__tests__/placements.test.ts
 *
 * These exist because of a specific, documented failure mode. `CLAUDE.md`
 * records that the microchip lookup broke when a collection-group index was
 * declared but never deployed, and that the symptom was indistinguishable from
 * "no data." The same index shape backs the outbreak trace, where a silent
 * empty result is far worse: it reads as "nothing to worry about."
 *
 * So the trace is tested against KNOWN data with hand-computed answers. A
 * green deploy proves the index exists; only these prove the logic is right.
 *
 * Boundary cases are the point. In particular the touching-intervals case —
 * one animal leaving a pen as another arrives — must count as contact, and
 * getting that wrong would never be noticed in ordinary use.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  intervalsOverlap,
  overlapBetween,
  exposureWindow,
  traceContacts,
  contactedPetIds,
  currentOccupants,
  lengthOfStayDays,
  INCUBATION_MAX_DAYS,
  MS_PER_DAY,
  type PlacementInterval,
} from '../placements';

/** A fixed clock. Real dates make the arithmetic checkable by hand. */
const T0 = Date.UTC(2026, 0, 1); // 2026-01-01T00:00:00Z
const day = (n: number) => T0 + n * MS_PER_DAY;

function stay(
  petId: string,
  areaId: string,
  startDay: number,
  endDay: number | null,
): PlacementInterval {
  return {
    petId,
    areaId,
    areaName: areaId === 'q2' ? 'Cuarentena 2' : 'Patio A',
    startedAt: day(startDay),
    endedAt: endDay === null ? null : day(endDay),
  };
}

// ── interval arithmetic ─────────────────────────────────────────────────────

test('overlapping intervals are detected', () => {
  assert.equal(intervalsOverlap(stay('a', 'q2', 0, 10), stay('b', 'q2', 5, 15)), true);
});

test('disjoint intervals are not', () => {
  assert.equal(intervalsOverlap(stay('a', 'q2', 0, 5), stay('b', 'q2', 6, 10)), false);
});

test('TOUCHING intervals count as contact', () => {
  // One animal leaves the pen exactly as another arrives. This must be an
  // overlap: parvovirus survives on surfaces for months, so "they never met"
  // is not "no exposure". A strict-inequality implementation returns false
  // here and nobody would ever notice.
  assert.equal(intervalsOverlap(stay('a', 'q2', 0, 5), stay('b', 'q2', 5, 10)), true);
});

test('an open-ended stay overlaps anything that starts after it', () => {
  assert.equal(intervalsOverlap(stay('a', 'q2', 0, null), stay('b', 'q2', 99, 120)), true);
});

test('a zero-length stay still registers contact', () => {
  // A same-instant start and end is usually a data-entry artefact. It resolves
  // toward inclusion, per the failure direction this module documents.
  assert.equal(intervalsOverlap(stay('a', 'q2', 5, 5), stay('b', 'q2', 0, 10)), true);
});

test('overlapBetween returns the shared span', () => {
  const o = overlapBetween(stay('a', 'q2', 0, 10), stay('b', 'q2', 4, 20));
  assert.deepEqual(o, { start: day(4), end: day(10) });
});

test('overlapBetween reports an unclosed overlap as null, not Infinity', () => {
  const o = overlapBetween(stay('a', 'q2', 0, null), stay('b', 'q2', 3, null));
  assert.deepEqual(o, { start: day(3), end: null });
});

test('overlapBetween returns null when there is no overlap', () => {
  assert.equal(overlapBetween(stay('a', 'q2', 0, 2), stay('b', 'q2', 3, 4)), null);
});

// ── exposure windows ────────────────────────────────────────────────────────

test('distemper reaches back six weeks, not two', () => {
  // The figure that matters: a fortnight's lookback looks thorough and misses
  // the case that closes the shelter.
  assert.equal(INCUBATION_MAX_DAYS.moquillo, 42);
  const w = exposureWindow(day(100), 'moquillo', day(100));
  assert.equal(w.start, day(58));
  assert.equal(w.end, day(100));
});

test('parvovirus reaches back two weeks', () => {
  const w = exposureWindow(day(100), 'parvovirus', day(100));
  assert.equal(w.start, day(86));
});

test('the window extends forward to now, not only back to diagnosis', () => {
  // The animal was shedding before anyone noticed, so "who has it exposed
  // since" is half the question.
  const w = exposureWindow(day(100), 'parvovirus', day(107));
  assert.equal(w.end, day(107));
});

// ── the trace itself ────────────────────────────────────────────────────────

test('traces contacts in the same area and ignores other areas', () => {
  const subject = [stay('sick', 'q2', 10, 20)];
  const candidates = [
    stay('sick', 'q2', 10, 20), // the subject's own row, must be excluded
    stay('luna', 'q2', 15, 25), // overlaps, same area  → contact
    stay('toby', 'q2', 0, 5), //  same area, no overlap → not a contact
    stay('rocky', 'patioA', 12, 18), // overlaps in TIME but a different area
  ];

  const contacts = traceContacts(subject, candidates, exposureWindow(day(20), 'parvovirus', day(20)));

  assert.deepEqual(
    contacts.map((c) => c.petId),
    ['luna'],
  );
  assert.equal(contacts[0]!.overlapStart, day(15));
  assert.equal(contacts[0]!.overlapEnd, day(20));
  assert.equal(contacts[0]!.overlapMs, 5 * MS_PER_DAY);
});

test('contacts are ordered by exposure duration, longest first', () => {
  const subject = [stay('sick', 'q2', 0, 30)];
  const candidates = [
    stay('brief', 'q2', 10, 11), //  1 day
    stay('long', 'q2', 0, 30), //   30 days
    stay('medium', 'q2', 20, 30), // 10 days
  ];

  const contacts = traceContacts(subject, candidates, exposureWindow(day(30), 'moquillo', day(30)));

  assert.deepEqual(
    contacts.map((c) => c.petId),
    ['long', 'medium', 'brief'],
  );
});

test('the subject is never traced against itself', () => {
  const subject = [stay('sick', 'q2', 0, 10)];
  const contacts = traceContacts(subject, subject, exposureWindow(day(10), 'parvovirus', day(10)));
  assert.deepEqual(contacts, []);
});

test('contact outside the exposure window is excluded', () => {
  // Sharing a pen four months ago is not exposure for a 14-day pathogen.
  const subject = [stay('sick', 'q2', 0, 5), stay('sick', 'q2', 100, 110)];
  const candidates = [
    stay('ancient', 'q2', 0, 5), //   only overlaps the old stay
    stay('recent', 'q2', 100, 110), // overlaps the current one
  ];

  const contacts = traceContacts(
    subject,
    candidates,
    exposureWindow(day(110), 'parvovirus', day(110)),
  );

  assert.deepEqual(
    contacts.map((c) => c.petId),
    ['recent'],
  );
});

test('a contact straddling the window edge is clipped, not dropped', () => {
  // An animal that arrived long before the window and is still there IS a
  // contact — dropping it because its stay started too early would be the
  // silent-miss failure this module exists to prevent.
  const subject = [stay('sick', 'q2', 100, 110)];
  const candidates = [stay('resident', 'q2', 0, null)];

  const contacts = traceContacts(
    subject,
    candidates,
    exposureWindow(day(110), 'parvovirus', day(110)),
  );

  assert.equal(contacts.length, 1);
  assert.equal(contacts[0]!.petId, 'resident');
  // Clipped to the subject's own stay, which is itself clipped to the window.
  assert.equal(contacts[0]!.overlapStart, day(100));
  assert.equal(contacts[0]!.overlapEnd, day(110));
});

test('a six-week-old contact is found for distemper and missed for parvovirus', () => {
  // The single most important assertion here: the SAME data gives different
  // answers per pathogen, and the distemper answer is the one that matters.
  const subject = [stay('sick', 'q2', 0, 5), stay('sick', 'patioA', 5, 45)];
  const candidates = [stay('exposed', 'q2', 0, 5)];
  const diagnosed = day(45);

  const distemper = traceContacts(subject, candidates, exposureWindow(diagnosed, 'moquillo', diagnosed));
  const parvo = traceContacts(subject, candidates, exposureWindow(diagnosed, 'parvovirus', diagnosed));

  assert.deepEqual(distemper.map((c) => c.petId), ['exposed']);
  assert.deepEqual(parvo.map((c) => c.petId), []);
});

test('an animal contacted across two separate stays is reported once by contactedPetIds', () => {
  const subject = [stay('sick', 'q2', 0, 5), stay('sick', 'q2', 10, 15)];
  const candidates = [stay('luna', 'q2', 0, 20)];

  const contacts = traceContacts(subject, candidates, exposureWindow(day(15), 'moquillo', day(15)));

  assert.equal(contacts.length, 2, 'the timeline keeps both stays');
  assert.deepEqual(contactedPetIds(contacts), ['luna'], 'the examination list does not');
});

test('an empty ledger traces to nothing without throwing', () => {
  assert.deepEqual(traceContacts([], [], exposureWindow(day(1), 'parvovirus', day(1))), []);
});

// ── occupancy and length of stay ────────────────────────────────────────────

test('current occupants are the placements with no end', () => {
  const placements = [
    stay('luna', 'q2', 0, null),
    stay('toby', 'q2', 1, null),
    stay('rocky', 'q2', 0, 5), // left
    stay('mocca', 'patioA', 0, null), // different area
  ];
  assert.deepEqual(currentOccupants(placements, 'q2').sort(), ['luna', 'toby']);
});

test('length of stay spans first arrival to final departure', () => {
  const placements = [stay('luna', 'q2', 0, 10), stay('luna', 'patioA', 10, 30)];
  assert.equal(lengthOfStayDays(placements, day(99)), 30);
});

test('length of stay for a still-present animal is measured to now', () => {
  const placements = [stay('luna', 'q2', 0, 10), stay('luna', 'patioA', 10, null)];
  assert.equal(lengthOfStayDays(placements, day(42)), 42);
});

test('length of stay is null when there is no placement at all', () => {
  assert.equal(lengthOfStayDays([]), null);
});
