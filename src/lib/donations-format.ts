/**
 * Dates for the donation screens, always in the shelter's zone (La Paz), so a
 * server in UTC and a phone in Bolivia print the same day. Pure.
 */

import { SHELTER } from '@/config/shelter';
import { parseDayKey } from './donations';

/** "25 de agosto de 2028" for an instant. */
export function formatDonationDate(ms: number, timeZone: string = SHELTER.timeZone): string {
  return new Date(ms).toLocaleDateString(SHELTER.locale, {
    timeZone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** "25 de agosto de 2028, 14:05" for an instant. */
export function formatDonationDateTime(ms: number, timeZone: string = SHELTER.timeZone): string {
  return new Date(ms).toLocaleString(SHELTER.locale, {
    timeZone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** "YYYY-MM-DD" (a calendar day, no zone) as "25 de agosto de 2028"; the raw text if it is not a real day. */
export function formatDayKey(dayKey: string): string {
  const valid = parseDayKey(dayKey);
  if (!valid) return dayKey;
  const [y, m, d] = valid.split('-').map(Number) as [number, number, number];
  // Noon UTC, formatted in UTC: the day never shifts.
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(SHELTER.locale, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
