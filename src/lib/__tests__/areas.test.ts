/**
 * Area validation, occupancy arithmetic, and move warnings.
 *
 * Run with:  node --test --import tsx src/lib/__tests__/areas.test.ts
 *
 * The occupancy figures here are hand-computed, for the same reason
 * `placements.test.ts` gives: a wrong occupancy number does not look wrong. A
 * pen that reads "3 de 6" when it holds six animals is a number the manager
 * will act on, and nothing in the UI can tell them it is wrong.
 *
 * The duplicate-name case is the one worth reading first. Two areas whose
 * names differ only by case or spacing are one pen in reality and two rows in
 * Firestore — occupancy splits across both, and an outbreak trace filtered by
 * `areaId` silently misses everyone recorded under the other spelling.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  areaToDraft,
  emptyAreaDraft,
  normalizeAreaName,
  placementWarnings,
  sortAreas,
  statusAfterPlacement,
  summarizeArea,
  validateArea,
  type AreaDraft,
} from '../areas';
import { canTransition, PET_STATUS_TRANSITIONS } from '../arrival';
import { MS_PER_DAY, type PlacementInterval } from '../placements';
import type { Area, PetStatus } from '../types';

const DAY = MS_PER_DAY;
const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);

function draft(over: Partial<AreaDraft> = {}): AreaDraft {
  return { ...emptyAreaDraft(), name: 'Cuarentena 1', kind: 'quarantine', ...over };
}

function stay(over: Partial<PlacementInterval> & { petId: string }): PlacementInterval {
  return {
    areaId: 'q1',
    areaName: 'Cuarentena 1',
    startedAt: NOW - 10 * DAY,
    endedAt: null,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Names
// ─────────────────────────────────────────────────────────────────────────────

test('normalizeAreaName folds case, accents and inner whitespace', () => {
  assert.equal(normalizeAreaName('  Cuarentena   2 '), 'cuarentena 2');
  assert.equal(normalizeAreaName('CUARENTENA 2'), 'cuarentena 2');
  assert.equal(normalizeAreaName('Área de maternidad'), 'area de maternidad');
});

test('normalizeAreaName keeps genuinely different names apart', () => {
  assert.notEqual(normalizeAreaName('Cuarentena 2'), normalizeAreaName('Cuarentena 10'));
  assert.notEqual(normalizeAreaName('Patio A'), normalizeAreaName('Patio B'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

test('a complete area validates', () => {
  assert.deepEqual(validateArea(draft({ capacity: 6 }), []), []);
});

test('capacity may be null — "we have not counted" is a real answer', () => {
  assert.deepEqual(validateArea(draft({ capacity: null }), []), []);
});

test('capacity must be a positive integer when given', () => {
  assert.deepEqual(validateArea(draft({ capacity: 0 }), []), ['capacity-invalid']);
  assert.deepEqual(validateArea(draft({ capacity: -3 }), []), ['capacity-invalid']);
  assert.deepEqual(validateArea(draft({ capacity: 2.5 }), []), ['capacity-invalid']);
});

test('name and kind are required', () => {
  assert.deepEqual(validateArea(draft({ name: '   ' }), []), ['name-required']);
  assert.deepEqual(validateArea(draft({ kind: null }), []), ['kind-required']);
});

test('a name longer than the cap is rejected, and the duplicate check is skipped', () => {
  const long = 'x'.repeat(61);
  assert.deepEqual(validateArea(draft({ name: long }), [long]), ['name-too-long']);
});

test('a duplicate name is caught across case, accents and spacing', () => {
  assert.deepEqual(validateArea(draft({ name: 'cuarentena  1' }), ['Cuarentena 1']), [
    'name-duplicate',
  ]);
  assert.deepEqual(validateArea(draft({ name: 'Area A' }), ['Área A']), ['name-duplicate']);
});

test('renaming an area to something else is not a duplicate of the rest', () => {
  assert.deepEqual(validateArea(draft({ name: 'Cuarentena 3' }), ['Cuarentena 1']), []);
});

test('areaToDraft renders a null note as an empty field, not the string "null"', () => {
  const area = {
    id: 'q1',
    name: 'Cuarentena 1',
    kind: 'quarantine',
    capacity: null,
    active: true,
    notes: null,
  } as unknown as Area;
  assert.equal(areaToDraft(area).notes, '');
});

// ─────────────────────────────────────────────────────────────────────────────
// Occupancy — every number below is hand-computed
// ─────────────────────────────────────────────────────────────────────────────

const AREA = { id: 'q1', capacity: 3 };

test('occupancy counts only OPEN placements in THIS area', () => {
  const placements: PlacementInterval[] = [
    stay({ petId: 'a' }),
    stay({ petId: 'b' }),
    // left yesterday — not an occupant
    stay({ petId: 'c', endedAt: NOW - DAY }),
    // in another pen entirely
    stay({ petId: 'd', areaId: 'g1' }),
  ];

  const summary = summarizeArea(AREA, placements, NOW);
  assert.equal(summary.count, 2);
  assert.equal(summary.free, 1);
  assert.equal(summary.state, 'ok');
});

test('the same animal placed twice in one area counts once', () => {
  // Should not happen, but a double-write must not report a phantom animal.
  const placements = [stay({ petId: 'a' }), stay({ petId: 'a', startedAt: NOW - 2 * DAY })];
  assert.equal(summarizeArea(AREA, placements, NOW).count, 1);
});

test('full and over are distinguished, and free never goes negative', () => {
  const three = ['a', 'b', 'c'].map((petId) => stay({ petId }));
  const full = summarizeArea(AREA, three, NOW);
  assert.equal(full.state, 'full');
  assert.equal(full.free, 0);

  const over = summarizeArea(AREA, [...three, stay({ petId: 'd' })], NOW);
  assert.equal(over.state, 'over');
  assert.equal(over.count, 4);
  assert.equal(over.free, 0, 'free is clamped — "-1 free" is not a fact anyone can act on');
});

test('an uncounted capacity reports unknown rather than guessing', () => {
  const summary = summarizeArea({ id: 'q1', capacity: null }, [stay({ petId: 'a' })], NOW);
  assert.equal(summary.state, 'unknown');
  assert.equal(summary.free, null);
  assert.equal(summary.count, 1, 'occupancy is still known even when capacity is not');
});

test('the cohorting clock reports the MOST RECENT arrival, not the oldest', () => {
  const placements = [
    stay({ petId: 'a', startedAt: NOW - 20 * DAY }),
    stay({ petId: 'b', startedAt: NOW - 3 * DAY }),
    stay({ petId: 'c', startedAt: NOW - 11 * DAY }),
  ];

  const summary = summarizeArea(AREA, placements, NOW);
  assert.equal(summary.lastArrivalAt, NOW - 3 * DAY);
  assert.equal(
    summary.daysSinceLastArrival,
    3,
    'the observation clock restarted 3 days ago, not 20 — this is the number that decides ' +
      'whether the pen can be cleared',
  );
});

test('an animal that already left does not hold the cohorting clock open', () => {
  const placements = [
    stay({ petId: 'a', startedAt: NOW - 20 * DAY }),
    stay({ petId: 'b', startedAt: NOW - 2 * DAY, endedAt: NOW - DAY }),
  ];
  assert.equal(summarizeArea(AREA, placements, NOW).lastArrivalAt, NOW - 20 * DAY);
});

test('an arrival stamped in the caller\'s future reads as "hoy", never "-1 días"', () => {
  // Found by a live probe, not by reasoning: `startedAt` is written with
  // `serverTimestamp()` and `now` comes from the browser, and Firestore's
  // clock was measured 2.7 s AHEAD of this machine on 2026-08-24. Without the
  // clamp, `Math.floor(-0.00003)` is -1.
  const summary = summarizeArea(AREA, [stay({ petId: 'a', startedAt: NOW + 3_000 })], NOW);
  assert.equal(summary.daysSinceLastArrival, 0);
  assert.equal(summary.count, 1, 'the animal is still in the pen either way');
});

test('an empty area has no clock', () => {
  const summary = summarizeArea(AREA, [], NOW);
  assert.equal(summary.count, 0);
  assert.equal(summary.lastArrivalAt, null);
  assert.equal(summary.daysSinceLastArrival, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Move warnings
// ─────────────────────────────────────────────────────────────────────────────

const QUARANTINE = { id: 'q1', kind: 'quarantine', active: true, capacity: 3 } as const;
const GENERAL = { id: 'g1', kind: 'general', active: true, capacity: 20 } as const;
const ISOLATION = { id: 'i1', kind: 'isolation', active: true, capacity: 2 } as const;

const EMPTY_SUMMARY = summarizeArea({ id: 'q1', capacity: 3 }, [], NOW);

test('a sick animal moved into a shared pen raises the ASV warning', () => {
  const warnings = placementWarnings({
    target: GENERAL,
    summary: summarizeArea({ id: 'g1', capacity: 20 }, [], NOW),
    reason: 'outbreak',
  });
  assert.deepEqual(warnings, ['infectious-into-shared']);
});

test('a sick animal moved into a QUARANTINE pen raises it too', () => {
  // The case that matters most, and the reason `quarantine` and `isolation`
  // are separate kinds at all: a quarantine pen is full of HEALTHY animals
  // under observation. Putting a sick one in exposes every one of them.
  //
  // This case was missing until a deliberate-break probe showed that accepting
  // quarantine as a valid destination for an infectious move failed no test.
  const warnings = placementWarnings({
    target: QUARANTINE,
    summary: EMPTY_SUMMARY,
    reason: 'medical',
  });
  assert.deepEqual(warnings, ['infectious-into-shared']);
});

test('the same animal moved into isolation raises nothing', () => {
  const warnings = placementWarnings({
    target: ISOLATION,
    summary: summarizeArea({ id: 'i1', capacity: 2 }, [], NOW),
    reason: 'outbreak',
  });
  assert.deepEqual(warnings, []);
});

test('the medical pen is an acceptable destination for a medical move', () => {
  const warnings = placementWarnings({
    target: { id: 'm1', kind: 'medical', active: true, capacity: null },
    summary: summarizeArea({ id: 'm1', capacity: null }, [], NOW),
    reason: 'medical',
  });
  assert.deepEqual(warnings, []);
});

test('a full pen warns, and an over-full one warns the same way', () => {
  const three = ['a', 'b', 'c'].map((petId) => stay({ petId }));
  const full = placementWarnings({
    target: QUARANTINE,
    summary: summarizeArea({ id: 'q1', capacity: 3 }, three, NOW),
    reason: 'intake',
  });
  assert.ok(full.includes('over-capacity'));
  assert.ok(full.includes('restarts-quarantine-clock'));
});

test('an EMPTY quarantine pen does not warn about restarting anyone’s clock', () => {
  const warnings = placementWarnings({ target: QUARANTINE, summary: EMPTY_SUMMARY, reason: 'intake' });
  assert.deepEqual(warnings, [], 'there is nobody inside for the clock to restart');
});

test('leaving quarantine for general population without a recorded clearance warns', () => {
  const warnings = placementWarnings({
    target: GENERAL,
    summary: summarizeArea({ id: 'g1', capacity: 20 }, [], NOW),
    reason: 'transfer',
    from: { kind: 'quarantine' },
  });
  assert.deepEqual(warnings, ['undocumented-clearance']);
});

test('the same move recorded AS a clearance does not warn', () => {
  const warnings = placementWarnings({
    target: GENERAL,
    summary: summarizeArea({ id: 'g1', capacity: 20 }, [], NOW),
    reason: 'quarantine-cleared',
    from: { kind: 'quarantine' },
  });
  assert.deepEqual(warnings, []);
});

test('an inactive area warns last — it is a note, not the headline', () => {
  const warnings = placementWarnings({
    target: { ...GENERAL, active: false },
    summary: summarizeArea({ id: 'g1', capacity: 20 }, [], NOW),
    reason: 'outbreak',
  });
  assert.deepEqual(warnings, ['infectious-into-shared', 'area-inactive']);
});

// ─────────────────────────────────────────────────────────────────────────────
// Status ↔ placement
// ─────────────────────────────────────────────────────────────────────────────

test('arrival moves an announced animal into quarantine', () => {
  assert.equal(statusAfterPlacement('inbound', 'intake'), 'quarantine');
});

test('a recorded clearance moves it into general population', () => {
  assert.equal(statusAfterPlacement('quarantine', 'quarantine-cleared'), 'shelter');
});

test('every other reason leaves the status alone', () => {
  assert.equal(statusAfterPlacement('available', 'medical'), 'available');
  assert.equal(statusAfterPlacement('available', 'outbreak'), 'available');
  assert.equal(statusAfterPlacement('shelter', 'transfer'), 'shelter');
  assert.equal(statusAfterPlacement('quarantine', 'transfer'), 'quarantine');
});

test('isolation is not a status — a move to the isolation pen does not change one', () => {
  // The animal keeps its place on the wall while it is being treated. This is
  // the reason isolation is an AreaKind and not a PetStatus.
  assert.equal(statusAfterPlacement('available', 'outbreak'), 'available');
});

test('an illegal implied transition is refused rather than forced', () => {
  // `adopted` cannot become `quarantine` via an intake placement: the
  // re-admission path is what reopens an adopted animal, and it goes through
  // its own gate. A stale screen must not be able to drive this.
  assert.equal(statusAfterPlacement('adopted', 'intake'), 'adopted');
  assert.equal(statusAfterPlacement('shelter', 'quarantine-cleared'), 'shelter');
});

test('statusAfterPlacement never returns an illegal transition, for any pair', () => {
  const statuses: PetStatus[] = [
    'inbound',
    'quarantine',
    'shelter',
    'foster',
    'available',
    'adopted',
    'lost',
    'cancelled',
  ];
  const reasons = [
    'intake',
    'quarantine-cleared',
    'transfer',
    'medical',
    'outbreak',
    'exit',
  ] as const;

  for (const from of statuses) {
    for (const reason of reasons) {
      const to = statusAfterPlacement(from, reason);
      assert.ok(
        from === to || canTransition(from, to),
        `${from} --${reason}--> ${to} is not a legal transition`,
      );
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Ordering
// ─────────────────────────────────────────────────────────────────────────────

test('the transitions statusAfterPlacement can imply are legal in the table', () => {
  // `statusAfterPlacement` ends in a `canTransition` guard that today can
  // never fire: both transitions it implies are legal, so deleting the guard
  // breaks nothing — a deliberate-break probe proved exactly that.
  //
  // The guard is kept as defence against a FUTURE edit to the table, and this
  // is the test that gives it teeth. If someone narrows `PET_STATUS_TRANSITIONS`
  // so that an announced animal can no longer enter quarantine, this fails and
  // names the coupling, instead of the pipeline silently refusing to advance.
  assert.ok(
    PET_STATUS_TRANSITIONS.inbound.includes('quarantine'),
    'an intake placement moves inbound -> quarantine',
  );
  assert.ok(
    PET_STATUS_TRANSITIONS.quarantine.includes('shelter'),
    'a recorded clearance moves quarantine -> shelter',
  );
});

test('the picker offers usable pens first, then by kind, then numerically', () => {
  const areas = [
    { name: 'Cuarentena 10', kind: 'quarantine', active: true },
    { name: 'Patio A', kind: 'general', active: true },
    { name: 'Cuarentena 2', kind: 'quarantine', active: true },
    { name: 'Cuarentena 1', kind: 'quarantine', active: false },
    { name: 'Aislamiento', kind: 'isolation', active: true },
  ] as const;

  assert.deepEqual(
    sortAreas(areas).map((a) => a.name),
    ['Cuarentena 2', 'Cuarentena 10', 'Patio A', 'Aislamiento', 'Cuarentena 1'],
  );
});
