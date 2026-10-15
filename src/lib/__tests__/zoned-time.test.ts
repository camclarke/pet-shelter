import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { SHELTER } from '@/config/shelter';
import {
  allDayRange,
  dayStartInstant,
  formatEventWhen,
  instantToWallClock,
  isUpcoming,
  nextDayKey,
  startOfDayInZone,
  wallClockToInstant,
  wallClockYearOutOfRange,
  zonedDayKey,
  zoneOffsetMs,
} from '../zoned-time';

/**
 * ⚠️ The machine these were written on is America/Caracas — UTC−4, the SAME
 * offset as La Paz. A conversion that quietly used the device's zone would
 * pass every assertion here. So the whole file re-runs itself in child
 * processes with `TZ` forced to zones that are not UTC−4, and each child
 * first proves (a control) that its device zone really is that zone.
 */

const LA_PAZ = 'America/La_Paz';
const SELF = 'src/lib/__tests__/zoned-time.test.ts';
const CHILD = process.env.ZONED_TIME_CHILD;

/** Device offset in January, as `getTimezoneOffset()` reports it (minutes, sign inverted). */
const DEVICE_ZONES: Record<string, number> = {
  'Asia/Tokyo': -540,
  'America/Los_Angeles': 480,
  UTC: 0,
  'Europe/Madrid': -60,
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// ── the device zone cannot matter ──────────────────────────────────────────

if (CHILD) {
  test(`CONTROL: this child's device zone really is ${CHILD}, not UTC−4`, () => {
    // getTimezoneOffset is the DEVICE zone — exactly what zoned-time must ignore.
    const offset = new Date(Date.UTC(2026, 0, 15, 12)).getTimezoneOffset();
    assert.equal(offset, DEVICE_ZONES[CHILD]);
    assert.notEqual(offset, 240);
  });
} else {
  for (const zone of Object.keys(DEVICE_ZONES)) {
    test(`every assertion in this file also holds on a device set to ${zone}`, () => {
      // NODE_TEST_CONTEXT is dropped: with it set, a nested `node --test`
      // speaks the runner's internal protocol to its parent and prints no
      // TAP — and the "# pass" check below would read an empty stdout.
      const env: NodeJS.ProcessEnv = { ...process.env, TZ: zone, ZONED_TIME_CHILD: zone };
      delete env.NODE_TEST_CONTEXT;
      const run = spawnSync(
        process.execPath,
        ['--test', '--test-reporter=tap', '--import', 'tsx', SELF],
        { env, encoding: 'utf8' },
      );
      assert.equal(run.status, 0, `child under TZ=${zone} failed:\n${run.stdout}\n${run.stderr}`);
      // The child must have run its tests, not exited 0 on nothing.
      assert.match(run.stdout, /# pass [1-9]/);
      assert.match(run.stdout, /# fail 0/);
      // …and its control passed, so the zone really was forced. (Git Bash
      // strips TZ from the environment on Windows; spawnSync does not.)
      assert.match(run.stdout, /^ok \d+ - CONTROL: this child's device zone really is/m);
    });
  }
}

// ── entering a time ────────────────────────────────────────────────────────

test('15:00 in La Paz is 19:00 UTC', () => {
  assert.equal(iso(wallClockToInstant('2026-10-31T15:00', LA_PAZ)), '2026-10-31T19:00:00.000Z');
});

test('21:30 on 31 October in La Paz crosses UTC midnight into 1 November', () => {
  assert.equal(iso(wallClockToInstant('2026-10-31T21:30', LA_PAZ)), '2026-11-01T01:30:00.000Z');
});

test('Christmas Eve 19:00 La Paz is 23:00 UTC — whatever zone the phone is in', () => {
  // Under TZ=Asia/Tokyo, `new Date('2026-12-24T19:00')` would give 10:00 UTC.
  assert.equal(iso(wallClockToInstant('2026-12-24T19:00', LA_PAZ)), '2026-12-24T23:00:00.000Z');
});

test('malformed or impossible input is null, never a guess', () => {
  for (const bad of [
    '',
    '2026-13-01T25:00',
    '2026-02-30T10:00',
    '2026-10-31T24:00',
    '2026-10-31T15:60',
    '2026-10-31 15:00',
    '2026-10-31T15:00:00',
    '2026-10-31',
  ]) {
    assert.equal(wallClockToInstant(bad, LA_PAZ), null, bad);
  }
});

test('the instant goes back into the input exactly as it was typed', () => {
  for (const value of ['2026-10-31T15:00', '2026-10-31T21:30', '2026-01-01T00:00', '2026-12-31T23:59']) {
    assert.equal(instantToWallClock(wallClockToInstant(value, LA_PAZ)!, LA_PAZ), value);
  }
});

// ── days ───────────────────────────────────────────────────────────────────

test('03:59 UTC on 1 November is still 31 October in La Paz', () => {
  assert.equal(zonedDayKey(Date.parse('2026-11-01T03:59:00Z'), LA_PAZ), '2026-10-31');
  assert.equal(iso(startOfDayInZone(Date.parse('2026-11-01T03:59:00Z'), LA_PAZ)), '2026-10-31T04:00:00.000Z');
});

test('an event ending 23:59 La Paz is upcoming at 23:59, and past at 00:00 the next day', () => {
  const endsAt = wallClockToInstant('2026-10-31T23:59', LA_PAZ)!;
  assert.equal(iso(endsAt), '2026-11-01T03:59:00.000Z');
  const at2359 = Date.parse('2026-11-01T03:59:00Z'); // 23:59 La Paz, 31 Oct
  const atMidnight = Date.parse('2026-11-01T04:00:00Z'); // 00:00 La Paz, 1 Nov
  assert.equal(isUpcoming(endsAt, at2359, LA_PAZ), true);
  assert.equal(isUpcoming(endsAt, atMidnight, LA_PAZ), false);
});

test('the cut-off is inclusive: an end at exactly 00:00 La Paz belongs to that new day', () => {
  // Same rule as comparing day keys: zonedDayKey(endsAt) >= zonedDayKey(now).
  const endsAt = Date.parse('2026-11-01T04:00:00Z'); // 00:00 La Paz, 1 Nov
  const now = Date.parse('2026-11-01T16:00:00Z'); // 12:00 La Paz, 1 Nov
  assert.equal(zonedDayKey(endsAt, LA_PAZ), zonedDayKey(now, LA_PAZ));
  assert.equal(isUpcoming(endsAt, now, LA_PAZ), true);
  assert.equal(isUpcoming(endsAt - 1, now, LA_PAZ), false);
});

test('an event that ended at 10:00 stays upcoming for the rest of that day', () => {
  const endsAt = wallClockToInstant('2026-10-31T10:00', LA_PAZ)!;
  assert.equal(isUpcoming(endsAt, Date.parse('2026-10-31T23:00:00Z'), LA_PAZ), true); // 19:00 La Paz
});

test('an all-day event runs from the start of its first day to the last millisecond of its last', () => {
  const one = allDayRange('2026-10-31', '2026-10-31', LA_PAZ)!;
  assert.equal(iso(one.startsAt), '2026-10-31T04:00:00.000Z');
  assert.equal(iso(one.endsAt), '2026-11-01T03:59:59.999Z');
  assert.equal(zonedDayKey(one.endsAt, LA_PAZ), '2026-10-31');

  const two = allDayRange('2026-10-31', '2026-11-01', LA_PAZ)!;
  assert.equal(iso(two.endsAt), '2026-11-02T03:59:59.999Z');
});

test('an all-day range whose last day is before its first is refused', () => {
  assert.equal(allDayRange('2026-11-01', '2026-10-31', LA_PAZ), null);
  assert.equal(allDayRange('2026-02-30', '2026-03-01', LA_PAZ), null);
});

test('calendar arithmetic rolls months and years', () => {
  assert.equal(nextDayKey('2026-10-31'), '2026-11-01');
  assert.equal(nextDayKey('2026-12-31'), '2027-01-01');
  assert.equal(nextDayKey('2028-02-28'), '2028-02-29');
  assert.equal(nextDayKey('nope'), null);
  assert.equal(dayStartInstant('2026-10-31T00:00', LA_PAZ), null);
});

// ── a zone WITH daylight saving, so the generic path stays honest for forks ──

test('New York: noon converts with the offset in force on that date, across both DST switches', () => {
  const NY = 'America/New_York';
  assert.equal(iso(wallClockToInstant('2026-01-15T12:00', NY)), '2026-01-15T17:00:00.000Z'); // EST
  assert.equal(iso(wallClockToInstant('2026-03-08T12:00', NY)), '2026-03-08T16:00:00.000Z'); // EDT, switch day
  assert.equal(iso(wallClockToInstant('2026-11-01T12:00', NY)), '2026-11-01T17:00:00.000Z'); // EST, switch day
  assert.equal(instantToWallClock(Date.parse('2026-03-08T16:00:00Z'), NY), '2026-03-08T12:00');
  assert.equal(zoneOffsetMs(Date.parse('2026-07-01T12:00:00Z'), NY), -4 * 3_600_000);
});

test('Santiago, the day DST starts (6 Sep 2026, 00:00–00:59 skipped): a skipped time resolves FORWARD', () => {
  const SCL = 'America/Santiago';
  // CONTROL: the switch really is at local midnight that day in this ICU.
  assert.equal(zoneOffsetMs(Date.parse('2026-09-06T03:59:00Z'), SCL), -4 * 3_600_000);
  assert.equal(zoneOffsetMs(Date.parse('2026-09-06T04:00:00Z'), SCL), -3 * 3_600_000);
  // 00:00 does not exist; it becomes 01:00 the SAME day, never 23:00 the day before.
  assert.equal(iso(wallClockToInstant('2026-09-06T00:00', SCL)), '2026-09-06T04:00:00.000Z');
  assert.equal(instantToWallClock(wallClockToInstant('2026-09-06T00:00', SCL)!, SCL), '2026-09-06T01:00');
  assert.equal(iso(wallClockToInstant('2026-09-06T00:30', SCL)), '2026-09-06T04:30:00.000Z');
  // Real times either side are untouched.
  assert.equal(iso(wallClockToInstant('2026-09-05T23:59', SCL)), '2026-09-06T03:59:00.000Z');
  assert.equal(iso(wallClockToInstant('2026-09-06T01:00', SCL)), '2026-09-06T04:00:00.000Z');
  // So an all-day event on the switch day starts ON that day, and the day
  // before ends at its own last millisecond.
  const day = allDayRange('2026-09-06', '2026-09-06', SCL)!;
  assert.equal(zonedDayKey(day.startsAt, SCL), '2026-09-06');
  const before = allDayRange('2026-09-05', '2026-09-05', SCL)!;
  assert.equal(iso(before.endsAt), '2026-09-06T03:59:59.999Z');
  assert.equal(zonedDayKey(before.endsAt, SCL), '2026-09-05');
  assert.equal(iso(startOfDayInZone(Date.parse('2026-09-06T15:00:00Z'), SCL)), '2026-09-06T04:00:00.000Z');
});

test('a year outside 2000–2100 is refused, so a two-digit year cannot slip through', () => {
  for (const bad of ['0026-10-31T15:00', '1999-12-31T23:59', '2101-01-01T00:00']) {
    assert.equal(wallClockToInstant(bad, LA_PAZ), null, bad);
    assert.equal(wallClockYearOutOfRange(bad), true, bad);
  }
  assert.equal(dayStartInstant('0026-10-31', LA_PAZ), null);
  assert.equal(allDayRange('0026-10-31', '0026-10-31', LA_PAZ), null);
  // The edges themselves are fine, including the computed day after 2100-12-31.
  assert.equal(iso(wallClockToInstant('2000-01-01T00:00', LA_PAZ)), '2000-01-01T04:00:00.000Z');
  assert.equal(iso(allDayRange('2100-12-31', '2100-12-31', LA_PAZ)!.endsAt), '2101-01-01T03:59:59.999Z');
  assert.equal(wallClockYearOutOfRange('2026-10-31T15:00'), false);
  assert.equal(wallClockYearOutOfRange(''), false); // blank is "missing", not "bad year"
});

// ── the shelter's own zone ─────────────────────────────────────────────────

test("SHELTER.timeZone is a real IANA zone, and it is UTC−4 with no daylight saving", () => {
  assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: SHELTER.timeZone }));
  assert.equal(SHELTER.timeZone, 'America/La_Paz');
  assert.equal(zoneOffsetMs(Date.parse('2026-01-15T12:00:00Z'), SHELTER.timeZone), -4 * 3_600_000);
  assert.equal(zoneOffsetMs(Date.parse('2026-07-15T12:00:00Z'), SHELTER.timeZone), -4 * 3_600_000);
});

test('an invalid zone name throws, which is what the check above relies on', () => {
  assert.throws(() => new Intl.DateTimeFormat('en', { timeZone: 'America/Cochabamba' }), RangeError);
});

// ── display: 24-hour, never "p. m." ─────────────────────────────────────────

const NOW_2026 = Date.parse('2026-10-15T16:00:00Z');

test('a same-day event reads "sábado, 31 de octubre · 15:00–19:00"', () => {
  const text = formatEventWhen(
    {
      startsAt: wallClockToInstant('2026-10-31T15:00', LA_PAZ)!,
      endsAt: wallClockToInstant('2026-10-31T19:00', LA_PAZ)!,
      allDay: false,
    },
    LA_PAZ,
    'es-BO',
    NOW_2026,
  );
  assert.equal(text, 'sábado, 31 de octubre · 15:00–19:00');
});

test('19:30 is "19:30" — es-BO\'s own default would say "07:30 p. m."', () => {
  const at = wallClockToInstant('2026-10-31T19:30', LA_PAZ)!;
  const text = formatEventWhen({ startsAt: at, endsAt: at, allDay: false }, LA_PAZ, 'es-BO', NOW_2026);
  assert.match(text, /19:30/);
  assert.doesNotMatch(text, /p\.\s*m\.|a\.\s*m\.|07:30/);
  // CONTROL: the default really is 12-hour, so the forcing is load-bearing.
  const fallback = new Intl.DateTimeFormat('es-BO', { timeZone: LA_PAZ, hour: 'numeric', minute: '2-digit' }).format(at);
  assert.match(fallback, /p\.\s*m\./);
});

test('a 21:30 event is shown on ITS day in La Paz, not the UTC day after', () => {
  const at = wallClockToInstant('2026-10-31T21:30', LA_PAZ)!;
  const text = formatEventWhen({ startsAt: at, endsAt: at, allDay: false }, LA_PAZ, 'es-BO', NOW_2026);
  assert.equal(text, 'sábado, 31 de octubre · 21:30');
});

test('an all-day event shows no time; a two-day one shows both days', () => {
  const one = allDayRange('2026-10-31', '2026-10-31', LA_PAZ)!;
  assert.equal(formatEventWhen({ ...one, allDay: true }, LA_PAZ, 'es-BO', NOW_2026), 'sábado, 31 de octubre');
  const two = allDayRange('2026-10-31', '2026-11-01', LA_PAZ)!;
  assert.equal(
    formatEventWhen({ ...two, allDay: true }, LA_PAZ, 'es-BO', NOW_2026),
    'sábado, 31 de octubre – domingo, 1 de noviembre',
  );
});

test('a timed event spanning two days shows both days with their times', () => {
  const text = formatEventWhen(
    {
      startsAt: wallClockToInstant('2026-10-31T18:00', LA_PAZ)!,
      endsAt: wallClockToInstant('2026-11-01T02:00', LA_PAZ)!,
      allDay: false,
    },
    LA_PAZ,
    'es-BO',
    NOW_2026,
  );
  assert.equal(text, 'sábado, 31 de octubre, 18:00 – domingo, 1 de noviembre, 02:00');
});

test('the year appears only when it is not the current one', () => {
  const at = wallClockToInstant('2027-10-30T15:00', LA_PAZ)!;
  const text = formatEventWhen({ startsAt: at, endsAt: at, allDay: false }, LA_PAZ, 'es-BO', NOW_2026);
  assert.match(text, /2027/);
});

// ── source guard ───────────────────────────────────────────────────────────

test('zoned-time.ts never touches the device zone', () => {
  const source = readFileSync('src/lib/zoned-time.ts', 'utf8')
    // Comments may name the forbidden calls to explain why they are forbidden.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  for (const forbidden of [
    /\.get(Hours|Minutes|Seconds|Date|Day|Month|FullYear)\(/,
    /\.set(Hours|Minutes|Seconds|Date|Month|FullYear)\(/,
    /getTimezoneOffset/,
    /toLocale(Date|Time)?String/,
    /new Date\(\s*['"`]/, // string parsing reads the device zone
    /new Date\([^()]*,/, // new Date(y, m, d…) is a LOCAL constructor
    /Date\.parse\(/,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
  // CONTROL: the guard is reading the real module.
  assert.match(source, /export function wallClockToInstant/);
});
