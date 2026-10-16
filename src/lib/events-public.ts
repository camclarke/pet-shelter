/**
 * Events — the PUBLIC layer: what a visitor's page is built from.
 *
 * Pure. No Firebase, no `server-only`, no device clock unless one is passed
 * in, so every rule here is tested offline with literal values. The reads live
 * in `events-server.ts` (Admin SDK); the admin's write layer is
 * `events-admin.ts`, and nothing public imports it.
 *
 * ⚠️ No visitor-facing words here either: wording comes from
 * `t.events.site` in `src/i18n`. What lives here is shape — which fields leave
 * the server, the order of the list, the map link, the JSON-LD.
 */

import { whatsappLink } from './pets';
import type { EventStatus } from './types';
import { formatEventWhen, isUpcoming, toZonedIso, zonedDayKey } from './zoned-time';

/**
 * An event as a public page may hold it. Deliberately NOT `ShelterEvent`:
 * `createdBy` and `updatedBy` are an admin's uid or email, and a Server
 * Component cannot leak a field the type does not have. `published` is absent
 * too — every value of this type IS published, by construction
 * (`publicEventFromData` refuses anything else).
 */
export interface PublicEvent {
  id: string;
  title: string;
  description: string;
  /** Epoch ms. */
  startsAt: number;
  /** Epoch ms, `>= startsAt`. */
  endsAt: number;
  allDay: boolean;
  placeName: string;
  address: string | null;
  status: EventStatus;
  /** Epoch ms, or null when the document carries none. For the sitemap. */
  updatedAt: number | null;
}

/** A Firestore Timestamp, from either SDK, without importing one. */
interface TimestampLike {
  toMillis(): number;
}

function millis(value: unknown): number | null {
  if (value && typeof value === 'object' && typeof (value as TimestampLike).toMillis === 'function') {
    const ms = (value as TimestampLike).toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * Raw document data → a `PublicEvent`, or null.
 *
 * Null unless `published === true` — strictly true, not truthy — and unless
 * the fields a page needs are the right types. The Admin SDK bypasses
 * `firestore.rules`, so on the server THIS is the boundary between a draft
 * and the public. A malformed document is dropped rather than rendered half
 * empty.
 *
 * Only the public fields are copied, one by one; nothing is spread from the
 * document, so a field added to `events/{id}` later does not reach a page
 * until someone adds it here on purpose.
 */
export function publicEventFromData(id: string, data: Record<string, unknown> | undefined): PublicEvent | null {
  if (!data || data.published !== true) return null;
  const startsAt = millis(data.startsAt);
  const endsAt = millis(data.endsAt);
  if (
    typeof data.title !== 'string' ||
    typeof data.placeName !== 'string' ||
    startsAt === null ||
    endsAt === null ||
    endsAt < startsAt
  ) {
    return null;
  }
  return {
    id,
    title: data.title,
    description: typeof data.description === 'string' ? data.description : '',
    startsAt,
    endsAt,
    allDay: data.allDay === true,
    placeName: data.placeName,
    address: typeof data.address === 'string' && data.address.trim() !== '' ? data.address : null,
    status: data.status === 'cancelled' ? 'cancelled' : 'scheduled',
    updatedAt: millis(data.updatedAt),
  };
}

/**
 * The upcoming list's order: soonest START first, then soonest end, then id
 * so two identical times cannot swap between renders. Cut to `limit` AFTER
 * sorting.
 *
 * Why after: the query must order by `endsAt` (its range field). Cutting
 * that to `limit` first would drop a long event — a week-long campaign that
 * started before everything else but ends after them — even though it belongs
 * at the top of a list ordered by start.
 */
export function sortUpcoming(events: readonly PublicEvent[], limit: number): PublicEvent[] {
  return [...events]
    .sort((a, b) => a.startsAt - b.startsAt || a.endsAt - b.endsAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, Math.max(0, limit));
}

/** Upcoming through the end of its last day, in the shelter's zone — the query's own cut-off. */
export function eventIsPast(event: Pick<PublicEvent, 'endsAt'>, now: number, timeZone: string): boolean {
  return !isUpcoming(event.endsAt, now, timeZone);
}

/**
 * A Google Maps SEARCH link for the venue: no embed, no JavaScript API, no
 * key, nothing billed (Google's documented Maps URLs). The city is appended so
 * "Plaza Colón" finds Cochabamba's and not the one in Madrid; it is skipped
 * when the place or address already names it.
 */
export function mapsSearchUrl(placeName: string, address: string | null, city: string): string {
  const parts = [placeName.trim(), address?.trim() ?? ''].filter(Boolean);
  const named = parts.join(' ').toLocaleLowerCase('es');
  if (city.trim() && !named.includes(city.trim().toLocaleLowerCase('es'))) parts.push(city.trim());
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(parts.join(', '))}`;
}

/** The place, as one line: "Plaza Colón · Av. Heroínas esq. Ayacucho". */
export function placeLine(event: Pick<PublicEvent, 'placeName' | 'address'>): string {
  return event.address ? `${event.placeName} · ${event.address}` : event.placeName;
}

/**
 * The first `max` characters of the description, cut at a word and given an
 * ellipsis, for a card. Line breaks fold into spaces here — a card is a
 * preview; the detail page shows the text as written.
 */
export function descriptionExcerpt(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  const head = (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:·–-]+$/u, '');
  return `${head}…`;
}

/**
 * The description as paragraphs and lines, for rendering as TEXT. Blank lines
 * separate paragraphs; single line breaks stay line breaks. Never HTML: the
 * page maps these to `<p>` and `<br>` itself, so a `<b>` typed by an admin
 * shows as the characters `<b>`.
 */
export function descriptionParagraphs(text: string): string[][] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((block) => block.split('\n').map((line) => line.trim()).filter(Boolean))
    .filter((lines) => lines.length > 0);
}

/**
 * The calendar days an event covers, as display strings, for "Se realizó el …"
 * and for the WhatsApp message. `last` is null when it is one day.
 */
export function eventDays(
  event: Pick<PublicEvent, 'startsAt' | 'endsAt'>,
  timeZone: string,
  locale: string,
  now: number,
): { first: string; last: string | null } {
  const sameDay = zonedDayKey(event.startsAt, timeZone) === zonedDayKey(event.endsAt, timeZone);
  const day = (ms: number) => formatEventWhen({ startsAt: ms, endsAt: ms, allDay: true }, timeZone, locale, now);
  return { first: day(event.startsAt), last: sameDay ? null : day(event.endsAt) };
}

// ─────────────────────────────────────────────────────────────────────────────
// The card (and the detail page's header)
// ─────────────────────────────────────────────────────────────────────────────

export interface EventCardContext {
  timeZone: string;
  locale: string;
  city: string;
  /** The shelter's WhatsApp number, digits only. */
  whatsapp: string;
  now: number;
  /** "Todo el día" — appended to an all-day event's date, where a timed one shows its hours. */
  allDayLabel: string;
  /** The prefilled WhatsApp message, naming the event and its day. From i18n. */
  inquiry(title: string, day: string): string;
}

export interface EventCardView {
  id: string;
  href: string;
  title: string;
  /** "sábado, 31 de octubre · 15:00–19:00", or "… · Todo el día". */
  when: string;
  place: string;
  mapsUrl: string;
  excerpt: string;
  cancelled: boolean;
  past: boolean;
  /** Null when cancelled or past: nobody should be invited to ask about either. */
  whatsappUrl: string | null;
}

/** Everything a card renders, decided here so the page only lays it out. */
export function buildEventCard(event: PublicEvent, ctx: EventCardContext): EventCardView {
  const cancelled = event.status === 'cancelled';
  const past = eventIsPast(event, ctx.now, ctx.timeZone);
  const date = formatEventWhen(event, ctx.timeZone, ctx.locale, ctx.now);
  const { first } = eventDays(event, ctx.timeZone, ctx.locale, ctx.now);
  return {
    id: event.id,
    href: `/events/${encodeURIComponent(event.id)}`,
    title: event.title,
    when: event.allDay ? `${date} · ${ctx.allDayLabel}` : date,
    place: placeLine(event),
    mapsUrl: mapsSearchUrl(event.placeName, event.address, ctx.city),
    excerpt: descriptionExcerpt(event.description),
    cancelled,
    past,
    whatsappUrl:
      cancelled || past
        ? null
        : whatsappLink(ctx.whatsapp, ctx.inquiry(event.title, first)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Link previews: <title>, meta description, Open Graph
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The title and description a shared link previews with — what WhatsApp and
 * Facebook show, the shelter's two channels. They read `<title>`, `og:title`
 * and `og:description` and ignore the JSON-LD `eventStatus`, so a cancelled
 * event must say so HERE, first, or its preview keeps inviting people to a
 * fair that is not happening.
 *
 * `cancelledLabel` is "Cancelado", from i18n.
 */
export function buildEventShareText(
  card: Pick<EventCardView, 'title' | 'when' | 'place' | 'cancelled'>,
  description: string,
  cancelledLabel: string,
): { title: string; description: string } {
  const prefix = card.cancelled ? cancelledLabel : '';
  return {
    title: prefix ? `${prefix} · ${card.title}` : card.title,
    description: [prefix, card.when, card.place, descriptionExcerpt(description, 160)].filter(Boolean).join(' · '),
  };
}

/**
 * A route's `openGraph`, with the site-wide fields restated. Next.js merges
 * metadata SHALLOWLY: a page's `openGraph` replaces the root layout's instead
 * of extending it, so a page that sets only title and description loses
 * `og:type` and `og:locale` (measured with Next's own `accumulateMetadata`).
 * `locale` is BCP 47 ("es-BO"); Open Graph wants "es_BO".
 */
export function eventsOpenGraph(fields: { locale: string; title: string; description: string; url: string }): {
  type: 'website';
  locale: string;
  title: string;
  description: string;
  url: string;
} {
  return {
    type: 'website',
    locale: fields.locale.replace('-', '_'),
    title: fields.title,
    description: fields.description,
    url: fields.url,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// schema.org Event JSON-LD
// ─────────────────────────────────────────────────────────────────────────────

export interface JsonLdShelter {
  name: string;
  siteUrl: string;
  city: string;
  country: string;
  timeZone: string;
}

/**
 * The event as schema.org `Event`, for search engines.
 *
 * Times: an all-day event is DATES ("2026-10-31"), its last day being the end
 * day itself; a timed one is ISO with the shelter's offset
 * ("2026-10-31T15:00:00-04:00") — what the poster says, not a UTC `Z` a reader
 * has to convert.
 */
export function buildEventJsonLd(event: PublicEvent, shelter: JsonLdShelter): Record<string, unknown> {
  const base = shelter.siteUrl.replace(/\/+$/, '');
  const when = (ms: number) => (event.allDay ? zonedDayKey(ms, shelter.timeZone) : toZonedIso(ms, shelter.timeZone));
  const address: Record<string, unknown> = {
    '@type': 'PostalAddress',
    ...(event.address ? { streetAddress: event.address } : {}),
    addressLocality: shelter.city,
    addressCountry: shelter.country,
  };
  return {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: event.title,
    ...(event.description.trim() ? { description: event.description.trim() } : {}),
    startDate: when(event.startsAt),
    endDate: when(event.endsAt),
    eventStatus:
      event.status === 'cancelled' ? 'https://schema.org/EventCancelled' : 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: { '@type': 'Place', name: event.placeName, address },
    organizer: { '@type': 'Organization', name: shelter.name, url: base },
    url: `${base}/events/${encodeURIComponent(event.id)}`,
  };
}

/**
 * JSON for an inline `<script type="application/ld+json">`. Every `<` becomes
 * `<` — still the same JSON to a parser, but a title typed as
 * `</script><script>…` can no longer close the tag and run. U+2028/U+2029 are
 * escaped too, for older JavaScript parsers that treat them as line breaks.
 * This is the ONLY string a page may put in `dangerouslySetInnerHTML`.
 */
export function serializeJsonLd(value: unknown): string {
  // The two separators are built from code points rather than typed: an
  // editor round trip turns their escape into the literal character, which
  // ends a regex literal mid-line.
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .split(String.fromCharCode(0x2028))
    .join('\\u2028')
    .split(String.fromCharCode(0x2029))
    .join('\\u2029');
}

// ─────────────────────────────────────────────────────────────────────────────
// Sitemap
// ─────────────────────────────────────────────────────────────────────────────

export interface SitemapEventRow {
  id: string;
  updatedAt?: Date;
}

/** The rows the sitemap lists, from public events: id plus a lastModified when known. */
export function sitemapEventRows(events: readonly PublicEvent[]): SitemapEventRow[] {
  return events.map((e) => ({ id: e.id, ...(e.updatedAt !== null ? { updatedAt: new Date(e.updatedAt) } : {}) }));
}
