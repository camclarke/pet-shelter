/**
 * Events — the pure layer: ids, validation, duplication, grouping.
 *
 * No Firebase and no `server-only`, so every rule here is testable offline.
 * `events-admin.ts` does the Firestore work under `firestore.rules`; this file
 * decides what may be written and what the id is.
 *
 * ⚠️ Every limit below is MIRRORED in the `events/{eventId}` block of
 * `firestore.rules`, which is the enforcing copy. Change both together; a
 * rules-test case sits on each edge (`scripts/rules-test-events.mjs`).
 *
 * Times: the editor's strings are the SHELTER's wall clock, converted with
 * `zoned-time.ts` — never with `new Date(value)`, which would read them in the
 * device's zone.
 */

import { slugify } from './intake';
import type { EventStatus, ShelterEvent } from './types';
import { CLOCK_SKEW_TOLERANCE_MS, MS_PER_DAY } from './placements';
import {
  allDayRange,
  instantToWallClock,
  isUpcoming,
  wallClockToInstant,
  wallClockYearOutOfRange,
  zonedDayKey,
} from './zoned-time';

export const EVENT_LIMITS = {
  titleMin: 3,
  titleMax: 120,
  descriptionMax: 4000,
  placeMin: 2,
  placeMax: 120,
  addressMax: 200,
  /** `endsAt <= startsAt + 31 days`. A longer "event" is a typo or not an event. */
  maxSpanDays: 31,
  /** The rules cap the document id at this length. */
  idMax: 120,
} as const;

/** The slug part is capped so `-YYYY-MM-DD` and a `-NN` suffix still fit `idMax`. */
const SLUG_MAX = EVENT_LIMITS.idMax - '-2026-10-31'.length - '-99'.length;

/** Warnings past this many days ahead: "2027" typed for "2026" is the usual cause. */
const FAR_FUTURE_DAYS = 400;
/** An all-day event longer than this is probably a wrong end date. */
const LONG_ALL_DAY_DAYS = 7;

/** Errors block saving. */
export type EventError =
  | 'title-too-short'
  | 'title-too-long'
  | 'description-too-long'
  | 'place-too-short'
  | 'place-too-long'
  | 'address-too-long'
  | 'start-missing'
  | 'end-missing'
  | 'end-before-start'
  | 'span-too-long'
  | 'year-out-of-range';

/** Warnings never block — the admin may know better. */
export type EventWarning = 'start-in-past' | 'start-far-future' | 'all-day-long';

/**
 * What the editor holds. `start`/`end` are input strings:
 * "YYYY-MM-DDTHH:mm" when timed, "YYYY-MM-DD" when `allDay`.
 */
export interface EventDraft {
  title: string;
  description: string;
  placeName: string;
  address: string;
  allDay: boolean;
  start: string;
  end: string;
}

/**
 * An event as the screens use it: instants as epoch ms, so this layer never
 * needs a Firestore `Timestamp`. `createdAt`/`updatedAt` are null for an
 * instant while a `serverTimestamp()` write is still pending locally.
 */
export type EventView = Omit<ShelterEvent, 'startsAt' | 'endsAt' | 'createdAt' | 'updatedAt'> & {
  startsAt: number;
  endsAt: number;
  createdAt: number | null;
  updatedAt: number | null;
};

/**
 * The fields an editor save writes. Everything else on the document —
 * `status`, `published`, the attribution — is set by its own action.
 */
export interface EventFields {
  title: string;
  description: string;
  placeName: string;
  address: string | null;
  allDay: boolean;
  startsAt: Date;
  endsAt: Date;
}

export interface EventValidation {
  errors: EventError[];
  warnings: EventWarning[];
  /** Present only when there are no errors. */
  fields: EventFields | null;
}

/**
 * Length in UTF-16 CODE UNITS — which is what the rules' `string.size()`
 * counts, measured on the Rules `:test` API: 60 emoji fit a 120 cap and 61 are
 * refused, because each emoji outside the BMP is two units. Spanish letters
 * (ñ, á, ü) are one unit each, so for the shelter's own text this is the
 * character count. Counting code points here would let the client accept a
 * title the rules then refuse.
 */
export function utf16Length(value: string): number {
  return value.length;
}

export function emptyEventDraft(): EventDraft {
  return { title: '', description: '', placeName: '', address: '', allDay: false, start: '', end: '' };
}

/** Turn the draft's time strings into instants in `timeZone`. Null where unparseable. */
export function resolveEventTimes(
  draft: Pick<EventDraft, 'allDay' | 'start' | 'end'>,
  timeZone: string,
): { startsAt: Date | null; endsAt: Date | null } {
  if (draft.allDay) {
    const first = draft.start.trim();
    const last = draft.end.trim() || first; // one-day event: the end day may be left blank
    // Start of the first day, last millisecond of the last day. Taken from
    // each day on its own, so a last day BEFORE the first still yields an end
    // that validation can report as "before the start".
    return {
      startsAt: allDayRange(first, first, timeZone)?.startsAt ?? null,
      endsAt: allDayRange(last, last, timeZone)?.endsAt ?? null,
    };
  }
  const startsAt = wallClockToInstant(draft.start.trim(), timeZone);
  const end = draft.end.trim();
  // A blank end on a timed event means "it has no announced end": store the
  // start as the end, so it stays listed through the end of its day.
  const endsAt = end === '' ? startsAt : wallClockToInstant(end, timeZone);
  return { startsAt, endsAt };
}

/**
 * Check a draft. Errors mirror the rules exactly; warnings are the editor's
 * judgement and never block.
 *
 * Text is trimmed before it is measured and before it is stored, so what is
 * checked is what is written.
 */
export function validateEvent(draft: EventDraft, timeZone: string, now: number): EventValidation {
  const errors: EventError[] = [];
  const warnings: EventWarning[] = [];

  const title = draft.title.trim();
  const description = draft.description.trim();
  const placeName = draft.placeName.trim();
  const address = draft.address.trim();

  // The minimums are on trimmed text — the rules check `trim().size()` too, so
  // "   " is refused on both sides. The maximums are on the trimmed text
  // because that is what is stored.
  if (utf16Length(title) < EVENT_LIMITS.titleMin) errors.push('title-too-short');
  if (utf16Length(title) > EVENT_LIMITS.titleMax) errors.push('title-too-long');
  if (utf16Length(description) > EVENT_LIMITS.descriptionMax) errors.push('description-too-long');
  if (utf16Length(placeName) < EVENT_LIMITS.placeMin) errors.push('place-too-short');
  if (utf16Length(placeName) > EVENT_LIMITS.placeMax) errors.push('place-too-long');
  if (utf16Length(address) > EVENT_LIMITS.addressMax) errors.push('address-too-long');

  const { startsAt, endsAt } = resolveEventTimes(draft, timeZone);
  // A year outside 2000–2100 gets its own message: a two-digit year typed
  // into a date picker ("26" → 0026) is a slip the admin must see named, not
  // a generic "pick a date".
  if (!startsAt) errors.push(wallClockYearOutOfRange(draft.start.trim()) ? 'year-out-of-range' : 'start-missing');
  if (startsAt && !endsAt) errors.push(wallClockYearOutOfRange(draft.end.trim()) ? 'year-out-of-range' : 'end-missing');
  if (startsAt && endsAt) {
    if (+endsAt < +startsAt) errors.push('end-before-start');
    else if (+endsAt - +startsAt > EVENT_LIMITS.maxSpanDays * MS_PER_DAY) errors.push('span-too-long');
  }

  if (startsAt) {
    // Skew tolerance: an event starting "now" must not warn because this
    // phone's clock runs a few minutes ahead.
    if (+startsAt < now - CLOCK_SKEW_TOLERANCE_MS) warnings.push('start-in-past');
    if (+startsAt - now > FAR_FUTURE_DAYS * MS_PER_DAY) warnings.push('start-far-future');
  }
  if (draft.allDay && startsAt && endsAt && +endsAt - +startsAt > LONG_ALL_DAY_DAYS * MS_PER_DAY) {
    warnings.push('all-day-long');
  }

  const fields: EventFields | null =
    errors.length === 0 && startsAt && endsAt
      ? { title, description, placeName, address: address || null, allDay: draft.allDay, startsAt, endsAt }
      : null;

  return { errors, warnings, fields };
}

/**
 * The document id for a new event: `${slug}-${YYYY-MM-DD}`, the date being the
 * start's calendar day IN THE SHELTER'S ZONE. A 21:30 event on 31 October in
 * La Paz is 01:30 UTC on 1 November, and its id must still say `-10-31`.
 *
 * Accent-free kebab case from the same `slugify` pets use. A title that
 * slugifies to nothing (emoji only) falls back to "evento". The slug is cut at
 * a hyphen so the id stays inside the rules' length cap with room for `-NN`.
 */
export function eventIdBase(title: string, startsAt: Date | number, timeZone: string): string {
  let slug = slugify(title);
  if (slug.length > SLUG_MAX) {
    slug = slug.slice(0, SLUG_MAX);
    const cut = slug.lastIndexOf('-');
    if (cut > 0) slug = slug.slice(0, cut);
    slug = slug.replace(/-+$/, '');
  }
  return `${slug || 'evento'}-${zonedDayKey(startsAt, timeZone)}`;
}

/** Attempt n of the id: the base, then `-2`, `-3`… — the pet-slug idea. */
export function eventIdCandidate(base: string, attempt: number): string {
  return attempt <= 1 ? base : `${base}-${attempt}`;
}

/** The same shape the rules require of an id. */
export function isValidEventId(id: string): boolean {
  return id.length <= EVENT_LIMITS.idMax && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id);
}

/** An existing event back into the editor, its instants shown in `timeZone`. */
export function eventToDraft(event: EventView, timeZone: string): EventDraft {
  const toInput = (ms: number) =>
    event.allDay ? zonedDayKey(ms, timeZone) : instantToWallClock(ms, timeZone);
  return {
    title: event.title,
    description: event.description,
    placeName: event.placeName,
    address: event.address ?? '',
    allDay: event.allDay,
    start: toInput(event.startsAt),
    // A timed event saved without an end stores end == start; show it blank
    // again rather than inventing an end the admin never typed.
    end: !event.allDay && event.endsAt === event.startsAt ? '' : toInput(event.endsAt),
  };
}

/**
 * "Duplicar": a NEW draft with the text and the place, and the dates CLEARED.
 *
 * Not shifted by a year: Halloween's weekday moves, and a shifted date would
 * be a confident wrong value the admin might not notice. The duplicate gets
 * its own id when it is saved, from its own date, so last year's link keeps
 * working. It is unpublished like every new event.
 */
export function duplicateEvent(event: Pick<EventView, 'title' | 'description' | 'placeName' | 'address' | 'allDay'>): EventDraft {
  return {
    title: event.title,
    description: event.description,
    placeName: event.placeName,
    address: event.address ?? '',
    allDay: event.allDay,
    start: '',
    end: '',
  };
}

export interface EventGroups {
  /** Unpublished, soonest first. */
  drafts: EventView[];
  /** Published and still upcoming, soonest first. */
  upcoming: EventView[];
  /** Published and over, most recent first. */
  past: EventView[];
}

/** The admin list's three groups. "Past" uses the same cut-off the public page will. */
export function groupEvents(events: readonly EventView[], now: number, timeZone: string): EventGroups {
  const soonest = (a: EventView, b: EventView) => a.startsAt - b.startsAt;
  const drafts = events.filter((e) => !e.published).sort(soonest);
  const published = events.filter((e) => e.published);
  return {
    drafts,
    upcoming: published.filter((e) => isUpcoming(e.endsAt, now, timeZone)).sort(soonest),
    past: published.filter((e) => !isUpcoming(e.endsAt, now, timeZone)).sort((a, b) => b.startsAt - a.startsAt),
  };
}

/** Only a draft can be deleted; a published event must be hidden first (the rules agree). */
export function canDeleteEvent(event: Pick<EventView, 'published'>): boolean {
  return !event.published;
}

export function nextStatus(status: EventStatus): EventStatus {
  return status === 'cancelled' ? 'scheduled' : 'cancelled';
}
