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
 * The instant a picked day stands for: `now` when the day is today, otherwise
 * the day as given — `parseDateInput`'s local midday.
 *
 * ⚠️ `parseDateInput` returns LOCAL MIDDAY, which protects the calendar day
 * across timezones and is wrong for "today" before noon: 12:00 is then hours in
 * the caller's future. A shelter recording a morning vaccination, weighing or
 * donation was told the date "hasn't arrived yet".
 *
 * Until 2026-09-13 that bug was fixed twice, two different ways: this function
 * in the food forms, and a calendar-day comparison in the medical and weight
 * validators. This is the one kept, because it is the only one that works where
 * FIRESTORE RULES check the stored instant — `notInFuture()` on the food
 * collections compares instants, and rules cannot know the caller's local day.
 * Two uses, one definition of "today":
 *
 *  - Before STORING a day the rules time-check (food): store
 *    `dayToInstant(picked)`, so the rule sees an instant that is not ahead.
 *  - Inside a VALIDATOR for a collection the rules do not time-check (medical
 *    records, measurements): refuse when
 *    `dayToInstant(value, now + tolerance) > now + tolerance`. That accepts
 *    today at any hour and refuses only a later day, however the date reached
 *    the form — typed, defaulted, or read off a vaccination card as UTC
 *    midday, which is 08:00 in Bolivia.
 *
 * Passing `now + tolerance` as `now` keeps the clock-skew allowance working
 * across midnight: at 23:57 with five minutes of tolerance, "tomorrow" is the
 * tolerant today, so a browser clock a few minutes behind the real day does not
 * refuse the real today. A past day keeps its midday, and so does a genuinely
 * future day, which the comparison then refuses.
 */
export function dayToInstant(dayMs: number, now: number = Date.now()): number {
  return toDateInput(dayMs) === toDateInput(now) ? now : dayMs;
}

/** Epoch ms as Bolivian-readable text. */
export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString('es-BO', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
