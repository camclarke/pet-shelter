import test from 'node:test';
import assert from 'node:assert/strict';

import { isDateAfterToday, parseDateInput, toDateInput } from '../date-input';

/**
 * Regression coverage for the "record dated today refused before noon" bug.
 *
 * `parseDateInput` stamps a picked `YYYY-MM-DD` at LOCAL NOON on purpose (see
 * its own header). `validateMedicalDraft`/`validateMeasurementDraft` used to
 * compare that stamp against an INSTANT (`draft.x > now + tolerance`), so a
 * record dated today was rejected as "in the future" from local midnight
 * until `now`'s clock caught up to noon — the exact window a shelter records
 * a morning vaccination or weighing in.
 *
 * Every date here is built with the LOCAL `Date` constructor
 * (`new Date(y, m, d, h, mi)`), never `Date.parse('...Z')`, so this test
 * passes or fails the same way in any timezone. CI runs UTC; this machine
 * (America/Caracas, UTC-4) does not, and UTC-4 is also Bolivia's offset — the
 * timezone the bug actually bit in.
 */

const TOLERANCE_MS = 5 * 60_000; // mirrors CLOCK_SKEW_TOLERANCE_MS; kept literal on purpose

function local(hour: number, minute: number): number {
  // Fixed date, September 15 2026 — an ordinary Tuesday, nothing special
  // about it. Only the hour/minute vary across cases.
  return new Date(2026, 8, 15, hour, minute).getTime();
}

function localDay(day: number, hour = 12, minute = 0): number {
  return new Date(2026, 8, day, hour, minute).getTime();
}

// ─── the bug itself: today must be accepted at any hour ──────────────────────

test('today, picked via parseDateInput, is accepted at 00:01', () => {
  const performedAt = parseDateInput('2026-09-15').getTime();
  assert.equal(isDateAfterToday(performedAt, local(0, 1), TOLERANCE_MS), false);
});

test('today, picked via parseDateInput, is accepted at 09:00', () => {
  const performedAt = parseDateInput('2026-09-15').getTime();
  assert.equal(isDateAfterToday(performedAt, local(9, 0), TOLERANCE_MS), false);
});

test('today, picked via parseDateInput, is accepted at 11:59 — the exact minute the old bug still failed at', () => {
  const performedAt = parseDateInput('2026-09-15').getTime();
  assert.equal(isDateAfterToday(performedAt, local(11, 59), TOLERANCE_MS), false);
});

test('today, picked via parseDateInput, is accepted at 23:59', () => {
  const performedAt = parseDateInput('2026-09-15').getTime();
  assert.equal(isDateAfterToday(performedAt, local(23, 59), TOLERANCE_MS), false);
});

// ─── tomorrow, and further out, are still genuinely rejected ─────────────────

test('tomorrow is still rejected at 09:00', () => {
  const performedAt = parseDateInput('2026-09-16').getTime();
  assert.equal(isDateAfterToday(performedAt, local(9, 0), TOLERANCE_MS), true);
});

test('tomorrow is still rejected at 23:00', () => {
  const performedAt = parseDateInput('2026-09-16').getTime();
  assert.equal(isDateAfterToday(performedAt, local(23, 0), TOLERANCE_MS), true);
});

test('a date 3 days ahead is still rejected', () => {
  const performedAt = parseDateInput('2026-09-18').getTime();
  assert.equal(isDateAfterToday(performedAt, local(9, 0), TOLERANCE_MS), true);
});

// ─── the clock-skew allowance still works ACROSS midnight ────────────────────

test('at 23:57, a date of tomorrow is accepted — a browser clock a few minutes behind must not refuse the real today', () => {
  // now + 5 min tolerance crosses into the 16th, so "tomorrow" (the 16th) and
  // "now, tolerantly" land on the same calendar day.
  const performedAt = parseDateInput('2026-09-16').getTime();
  assert.equal(isDateAfterToday(performedAt, local(23, 57), TOLERANCE_MS), false);
});

test('at 23:50, a date of tomorrow is still rejected — the tolerance does not reach midnight yet', () => {
  // now + 5 min is 23:55, still the 15th, so the 16th is genuinely later.
  const performedAt = parseDateInput('2026-09-16').getTime();
  assert.equal(isDateAfterToday(performedAt, local(23, 50), TOLERANCE_MS), true);
});

// ─── direct unit coverage on the helper ───────────────────────────────────────

test('isDateAfterToday compares calendar days, not instants', () => {
  // Same calendar day, different times of day: NOT after, even though the
  // instant comparison the old code used would have said otherwise.
  const noonToday = localDay(15, 12, 0);
  const earlyMorning = localDay(15, 0, 5);
  assert.equal(isDateAfterToday(noonToday, earlyMorning, TOLERANCE_MS), false);
});

test('isDateAfterToday says yes for a genuinely later calendar day, zero tolerance', () => {
  const tomorrowNoon = localDay(16, 12, 0);
  const todayNoon = localDay(15, 12, 0);
  assert.equal(isDateAfterToday(tomorrowNoon, todayNoon, 0), true);
});

test('isDateAfterToday says no for today or an earlier day, zero tolerance', () => {
  const todayNoon = localDay(15, 12, 0);
  const yesterdayNoon = localDay(14, 12, 0);
  assert.equal(isDateAfterToday(todayNoon, todayNoon, 0), false);
  assert.equal(isDateAfterToday(yesterdayNoon, todayNoon, 0), false);
});

test('toDateInput zero-pads, which is what makes the string comparison correct', () => {
  // January 5th must read "01-05", not "1-5" — "9-9" would otherwise sort
  // after "10-1" as a string despite being the earlier date.
  assert.equal(toDateInput(new Date(2026, 0, 5, 12, 0).getTime()), '2026-01-05');
});
