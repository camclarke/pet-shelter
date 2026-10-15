/**
 * Wall clocks in the SHELTER's time zone, independent of the device's.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * `<input type="datetime-local">` hands back "2026-10-31T15:00" with no zone.
 * `new Date("2026-10-31T15:00")` reads that in the DEVICE's zone, so an admin
 * whose phone is set to Madrid would publish an event at 15:00 Madrid — five
 * hours off for Cochabamba — and nothing anywhere would say so. Every function
 * here takes the zone as an argument and reads offsets from `Intl`, so the
 * device's zone cannot enter a result.
 *
 * ⚠️ The machine this was written on is `America/Caracas`, UTC−4 — the same
 * offset as La Paz. A device-zone bug would PASS here. The tests therefore
 * re-run themselves in child processes with `TZ` forced to zones that are not
 * UTC−4, and a source guard forbids the local-time Date methods below.
 *
 * Pure: no Firebase, no `server-only`, no device clock unless one is passed in.
 * Every instant is a `Date` or epoch milliseconds; nothing stores a wall-clock
 * string.
 */

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

interface ZonedParts {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number; // 0–23
  minute: number;
  second: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    // 'en-US' only for the shape of the numbers; the names are never read.
    // hourCycle h23, so midnight is 0 and never 24 (h24) or 12 (h12).
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The calendar and clock reading of an instant in `timeZone`. */
function zonedParts(ms: number, timeZone: string): ZonedParts {
  const out: Record<string, number> = {};
  for (const part of partsFormatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return {
    year: out.year!,
    month: out.month!,
    day: out.day!,
    // Defensive: some older ICU builds still say 24 for midnight under h23.
    hour: out.hour! % 24,
    minute: out.minute!,
    second: out.second!,
  };
}

/**
 * The zone's offset from UTC at an instant, in ms (La Paz: −4 h).
 *
 * Read as "what the zone's wall clock says, taken as if it were UTC, minus the
 * instant". That avoids parsing `GMT-04:00` strings and works for zones whose
 * offset is not a whole hour.
 */
export function zoneOffsetMs(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Compare whole seconds on both sides: formatToParts drops the milliseconds.
  return asUtc - Math.floor(ms / 1000) * 1000;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * The years a typed date may carry. A date picker given "26" for the year
 * reports "0026-…", which is a real date to `Date.UTC` and a slip to everyone
 * else; refusing it here makes every converter below return null for it.
 */
export const WALL_YEAR_MIN = 2000;
export const WALL_YEAR_MAX = 2100;

/**
 * True when `value` is shaped like a date ("YYYY-…") but its year is outside
 * WALL_YEAR_MIN–WALL_YEAR_MAX — so a caller can name THAT problem instead of
 * reporting a generic unreadable date.
 */
export function wallClockYearOutOfRange(value: string): boolean {
  const match = /^(\d{4})-/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  return year < WALL_YEAR_MIN || year > WALL_YEAR_MAX;
}

/**
 * Parse and range-check a wall-clock string. Rejects "2026-02-30", "25:00",
 * and — unless `anyYear` — a year outside WALL_YEAR_MIN–WALL_YEAR_MAX.
 * `anyYear` is only for days this module computes itself (the day after
 * 2100-12-31), never for typed input.
 */
function parseWall(value: string, withTime: boolean, anyYear = false): WallParts | null {
  const match = (withTime ? WALL_CLOCK : DAY).exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const hour = withTime ? Number(match[4]) : 0;
  const minute = withTime ? Number(match[5]) : 0;
  if (!anyYear && (year < WALL_YEAR_MIN || year > WALL_YEAR_MAX)) return null;
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) return null;
  // Date.UTC rolls "February 30" over into March; a round trip catches it.
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return { year, month, day, hour, minute };
}

/**
 * "2026-10-31T15:00" read as the wall clock of `timeZone` → the instant.
 * Returns null for anything that is not a real date and time.
 *
 * 1. Take the digits as if they were UTC (`guess`).
 * 2. Subtract the zone's offset at that guess.
 * 3. Re-read the offset at the result and redo it once if it moved — which only
 *    happens in a zone with daylight saving, around its switch. La Paz has none,
 *    so for this shelter the answer is always `guess + 4 h`; the second pass
 *    keeps the template honest for forks.
 * 4. If neither candidate reads back as the typed wall clock, the time does
 *    not exist there (the hour skipped when daylight saving starts — Chile
 *    skips 00:00–00:59 on its switch day). Resolve FORWARD, to the later
 *    candidate: "00:00 on 6 September" in Santiago becomes 01:00 that day,
 *    never 23:00 the day before, so a start-of-day can never land on the
 *    previous day.
 */
export function wallClockToInstant(value: string, timeZone: string): Date | null {
  const p = parseWall(value, true);
  return p ? new Date(wallPartsToInstant(p, timeZone)) : null;
}

function wallPartsToInstant(p: WallParts, timeZone: string): number {
  const guess = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const first = zoneOffsetMs(guess, timeZone);
  const candidate = guess - first;
  const second = zoneOffsetMs(candidate, timeZone);
  if (second === first) return candidate;
  const retry = guess - second;
  const readsBack = (ms: number) => {
    const q = zonedParts(ms, timeZone);
    return q.year === p.year && q.month === p.month && q.day === p.day && q.hour === p.hour && q.minute === p.minute;
  };
  if (readsBack(retry)) return retry;
  if (readsBack(candidate)) return candidate;
  return Math.max(candidate, retry); // a skipped local time: resolve forward
}

/** The instant → "2026-10-31T15:00" in `timeZone`, for filling a datetime-local back in. */
export function instantToWallClock(date: Date | number, timeZone: string): string {
  const p = zonedParts(+date, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** The calendar day of an instant in `timeZone`, as "2026-10-31". */
export function zonedDayKey(date: Date | number, timeZone: string): string {
  return instantToWallClock(date, timeZone).slice(0, 10);
}

/** "2026-10-31" → "2026-11-01". Pure calendar arithmetic, no zone involved. */
export function nextDayKey(dayKey: string): string | null {
  const p = parseWall(dayKey, false);
  if (!p) return null;
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return `${pad(next.getUTCFullYear(), 4)}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** The instant a calendar day ("2026-10-31") begins in `timeZone`, or null if malformed. */
export function dayStartInstant(dayKey: string, timeZone: string): Date | null {
  return parseWall(dayKey, false) ? wallClockToInstant(`${dayKey}T00:00`, timeZone) : null;
}

/** The instant the day containing `date` began in `timeZone`. */
export function startOfDayInZone(date: Date | number, timeZone: string): Date {
  // A day key produced by zonedDayKey always parses — with `anyYear`, since
  // the typed-input year range has no business here.
  return new Date(wallPartsToInstant(parseWall(zonedDayKey(date, timeZone), false, true)!, timeZone));
}

/**
 * Is an event still worth showing? It is upcoming THROUGH THE END of the day
 * it ends on, in the shelter's zone: a fair that ends at 19:00 stays listed
 * until midnight in Cochabamba, whatever zone the server or the phone is in.
 *
 * This is exactly the cut-off the public query will use —
 * `endsAt >= startOfDayInZone(now)` — so the page and this function cannot
 * disagree about which events are past.
 */
export function isUpcoming(endsAt: Date | number, now: Date | number, timeZone: string): boolean {
  return +endsAt >= +startOfDayInZone(now, timeZone);
}

/**
 * An all-day event's instants: the start of its first day, and the last
 * millisecond of its last day — one millisecond before the next day begins,
 * so `zonedDayKey(endsAt)` is the last day itself. Null if either day is
 * malformed or the last day comes before the first.
 */
export function allDayRange(
  firstDay: string,
  lastDay: string,
  timeZone: string,
): { startsAt: Date; endsAt: Date } | null {
  const startsAt = dayStartInstant(firstDay, timeZone);
  const after = nextDayKey(lastDay);
  // The day after is computed, not typed: 2100-12-31's is 2101-01-01, which
  // the typed-input year range would refuse.
  const afterParts = after ? parseWall(after, false, true) : null;
  const nextStart = afterParts ? new Date(wallPartsToInstant(afterParts, timeZone)) : null;
  if (!startsAt || !nextStart) return null;
  const endsAt = new Date(+nextStart - 1);
  if (+endsAt < +startsAt) return null;
  return { startsAt, endsAt };
}

// ─────────────────────────────────────────────────────────────────────────────
// Display
// ─────────────────────────────────────────────────────────────────────────────

export interface EventTimes {
  startsAt: Date | number;
  endsAt: Date | number;
  allDay: boolean;
}

/**
 * "sábado, 31 de octubre · 15:00–19:00" — the names and the date order come
 * from `Intl` in `locale`; only the separators are written here.
 *
 * ⚠️ The clock is forced to 24-hour (`hourCycle: 'h23'`). es-BO's DEFAULT is
 * 12-hour — measured: "07:30 p. m." — and the owner chose "15:00", which is
 * how a poster reads and cannot be misread as morning.
 *
 * The year appears only when the event's year is not `now`'s, so the list
 * stays short and an old event from last year cannot pass for this year's.
 */
export function formatEventWhen(
  event: EventTimes,
  timeZone: string,
  locale: string,
  now: Date | number = Date.now(),
): string {
  const start = +event.startsAt;
  const end = +event.endsAt;
  const withYear =
    zonedDayKey(start, timeZone).slice(0, 4) !== zonedDayKey(now, timeZone).slice(0, 4) ||
    zonedDayKey(end, timeZone).slice(0, 4) !== zonedDayKey(now, timeZone).slice(0, 4);

  const day = new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(withYear ? { year: 'numeric' as const } : {}),
  });
  const time = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  const sameDay = zonedDayKey(start, timeZone) === zonedDayKey(end, timeZone);

  if (event.allDay) {
    return sameDay ? day.format(start) : `${day.format(start)} – ${day.format(end)}`;
  }
  if (sameDay) {
    return start === end
      ? `${day.format(start)} · ${time.format(start)}`
      : `${day.format(start)} · ${time.format(start)}–${time.format(end)}`;
  }
  return `${day.format(start)}, ${time.format(start)} – ${day.format(end)}, ${time.format(end)}`;
}
