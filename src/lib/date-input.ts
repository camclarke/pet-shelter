/**
 * `<input type="date">` values, converted without losing a day.
 *
 * Extracted from PetAdminPanel so the medical form and the outbreak trace share
 * ONE implementation. Duplicating a timezone helper is how a subtle date bug
 * gets reintroduced in the copy that nobody remembered to fix.
 */

/**
 * A `YYYY-MM-DD` field value as a local-MIDDAY Date.
 *
 * ⚠️ Midday rather than midnight, and local rather than UTC.
 * `new Date('2026-08-24')` parses as UTC midnight, which in Bolivia (UTC-4) is
 * the 23rd at 20:00 — so a date someone picked would silently shift by a day.
 * Midday leaves ~12 hours of slack in both directions, which no timezone this
 * project serves can cross.
 */
export function parseDateInput(value: string): Date {
  const parts = value.split('-').map(Number);
  const [year, month, day] = parts;
  if (parts.length !== 3 || !year || !month || !day) return new Date();
  return new Date(year, month - 1, day, 12, 0, 0);
}

/** Epoch ms back to a `YYYY-MM-DD` field value, in LOCAL time for the same reason. */
export function toDateInput(ms: number): string {
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** Today, as a field value. */
export function todayInputValue(): string {
  return toDateInput(Date.now());
}

/**
 * Is `dateMs` after today, comparing LOCAL CALENDAR DAYS rather than exact
 * instants?
 *
 * ⚠️ A validator that compares instants (`dateMs > now`) rejects a record
 * dated TODAY from local midnight until `now`'s clock time catches up to
 * `dateMs`'s. `parseDateInput` stamps a picked date at local NOON, so a form
 * defaulting to `todayInputValue()` produced a `performedAt`/`measuredAt` in
 * the caller's future for every save made before local noon — a shelter
 * recording a morning vaccination or weighing was told the date "hasn't
 * arrived yet" and had to backdate to yesterday to save at all. Comparing the
 * CALENDAR DAY instead accepts today at any hour and rejects only a
 * genuinely later day.
 *
 * `toleranceMs` is added to `now` before the comparison so the existing
 * clock-skew allowance still works across midnight: a browser clock a few
 * minutes behind the real day must not have "today" (its real today, our
 * tomorrow) refused. `toDateInput` zero-pads, so the `YYYY-MM-DD` strings
 * compare correctly as strings — no `Date` arithmetic needed here.
 */
export function isDateAfterToday(dateMs: number, now: number, toleranceMs: number): boolean {
  return toDateInput(dateMs) > toDateInput(now + toleranceMs);
}

/** Epoch ms as Bolivian-readable text. */
export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString('es-BO', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
