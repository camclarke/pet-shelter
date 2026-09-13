import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { dayToInstant, parseDateInput, toDateInput } from '../date-input';

/**
 * `dayToInstant` is the ONE definition of "today" for a picked date.
 *
 * `parseDateInput` stamps a picked `YYYY-MM-DD` at LOCAL NOON on purpose (see
 * its own header), which put "today" hours in the future before noon. That bug
 * was fixed twice, two ways, until 2026-09-13; the food forms' `dayToInstant`
 * is the survivor, because Firestore rules can compare instants but never a
 * caller's local day.
 *
 * Every date here is built with the LOCAL `Date` constructor
 * (`new Date(y, m, d, h, mi)`), never `Date.parse('...Z')`, so this test
 * passes or fails the same way in any timezone. CI runs UTC; this machine runs
 * UTC-4, which is also Bolivia's offset.
 */

const TOLERANCE_MS = 5 * 60_000; // mirrors CLOCK_SKEW_TOLERANCE_MS; kept literal on purpose

function local(day: number, hour: number, minute: number): number {
  // September 2026, an ordinary week. Only the day, hour and minute vary.
  return new Date(2026, 8, day, hour, minute).getTime();
}

/** The validator form documented on `dayToInstant`, exactly as the validators write it. */
function isLaterDay(value: number, now: number, toleranceMs: number): boolean {
  return dayToInstant(value, now + toleranceMs) > now + toleranceMs;
}

// ─── storing: today becomes now, any other day keeps its midday ─────────────

test('a day picked as today becomes now, at 00:01, 09:00, 11:59 and 23:59', () => {
  const today = parseDateInput('2026-09-15').getTime();
  for (const [hour, minute] of [[0, 1], [9, 0], [11, 59], [23, 59]] as const) {
    const now = local(15, hour, minute);
    assert.equal(dayToInstant(today, now), now, `at ${hour}:${minute}`);
  }
});

test('a past day and a future day keep their midday', () => {
  const now = local(15, 9, 0);
  const yesterday = parseDateInput('2026-09-14').getTime();
  const tomorrow = parseDateInput('2026-09-16').getTime();
  assert.equal(dayToInstant(yesterday, now), yesterday);
  assert.equal(dayToInstant(tomorrow, now), tomorrow);
});

test('the stored instant for today is never ahead of now, so a rule like notInFuture() accepts it', () => {
  const today = parseDateInput('2026-09-15').getTime();
  for (let hour = 0; hour < 24; hour++) {
    const now = local(15, hour, 0);
    assert.ok(dayToInstant(today, now) <= now, `at ${hour}:00`);
  }
});

// ─── validating: a later calendar day is refused, today never is ────────────

test('as a validator, today is accepted at any hour', () => {
  const today = parseDateInput('2026-09-15').getTime();
  for (const [hour, minute] of [[0, 1], [9, 0], [11, 59], [23, 59]] as const) {
    assert.equal(isLaterDay(today, local(15, hour, minute), TOLERANCE_MS), false, `at ${hour}:${minute}`);
  }
});

test('as a validator, tomorrow is refused at 09:00 and 23:00, and three days ahead at 09:00', () => {
  const tomorrow = parseDateInput('2026-09-16').getTime();
  assert.equal(isLaterDay(tomorrow, local(15, 9, 0), TOLERANCE_MS), true);
  assert.equal(isLaterDay(tomorrow, local(15, 23, 0), TOLERANCE_MS), true);
  assert.equal(isLaterDay(parseDateInput('2026-09-18').getTime(), local(15, 9, 0), TOLERANCE_MS), true);
});

test('the clock-skew allowance works across midnight: 23:57 accepts tomorrow, 23:50 does not', () => {
  const tomorrow = parseDateInput('2026-09-16').getTime();
  assert.equal(isLaterDay(tomorrow, local(15, 23, 57), TOLERANCE_MS), false);
  assert.equal(isLaterDay(tomorrow, local(15, 23, 50), TOLERANCE_MS), true);
});

test('the validator form gives exactly the answer of the calendar-day comparison it replaced, for every input tried', () => {
  // The implementation removed on 2026-09-13, copied here as the oracle. If
  // the two ever disagree, the medical and weight validators changed behaviour.
  const replaced = (value: number, now: number, toleranceMs: number) =>
    toDateInput(value) > toDateInput(now + toleranceMs);

  let compared = 0;
  for (const valueDay of [13, 14, 15, 16, 17]) {
    for (const valueHour of [0, 8, 12, 23]) {
      for (const valueMinute of [0, 59]) {
        const value = local(valueDay, valueHour, valueMinute);
        for (const nowHour of [0, 6, 11, 12, 18, 23]) {
          for (const nowMinute of [0, 50, 55, 57, 59]) {
            const now = local(15, nowHour, nowMinute);
            for (const tolerance of [0, TOLERANCE_MS, 10 * 60_000]) {
              assert.equal(
                isLaterDay(value, now, tolerance),
                replaced(value, now, tolerance),
                `value=${new Date(value).toString()} now=${new Date(now).toString()} tol=${tolerance}`
              );
              compared++;
            }
          }
        }
      }
    }
  }
  assert.equal(compared, 5 * 4 * 2 * 6 * 5 * 3);
});

// ─── the field helpers ───────────────────────────────────────────────────────

test('toDateInput zero-pads, which is what makes a day comparison by string correct', () => {
  // January 5th must read "01-05", not "1-5" — "9-9" would otherwise sort
  // after "10-1" as a string despite being the earlier date.
  assert.equal(toDateInput(new Date(2026, 0, 5, 12, 0).getTime()), '2026-01-05');
});

// ─── one helper, not two ─────────────────────────────────────────────────────

test('there is exactly one definition of "today" for a picked date in src/', () => {
  const root = process.cwd();
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walk(path);
      return /\.tsx?$/.test(entry.name) ? [relative(root, path).split(sep).join('/')] : [];
    });

  const files = walk(join(root, 'src'));
  const defining = files.filter((file) =>
    /function\s+dayToInstant\b/.test(readFileSync(join(root, file), 'utf8'))
  );
  assert.deepEqual(defining, ['src/lib/date-input.ts']);

  const secondWay = files.filter((file) =>
    /\bisDateAfterToday\b/.test(readFileSync(join(root, file), 'utf8'))
  );
  assert.deepEqual(secondWay, [], 'the second fix is gone; use dayToInstant');
});
