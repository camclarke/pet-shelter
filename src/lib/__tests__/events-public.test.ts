import test from 'node:test';
import assert from 'node:assert/strict';

import { es } from '@/i18n/es';
import {
  buildEventCard,
  buildEventJsonLd,
  buildEventShareText,
  descriptionExcerpt,
  descriptionParagraphs,
  eventDays,
  eventIsPast,
  eventsOpenGraph,
  mapsSearchUrl,
  placeLine,
  publicEventFromData,
  serializeJsonLd,
  sitemapEventRows,
  sortUpcoming,
  type EventCardContext,
  type PublicEvent,
} from '../events-public';
import { findVoseo } from '../ai/spanish-register';

/**
 * The public events layer, with literal values. Every instant is written as
 * a UTC literal and every expectation as the La Paz wall clock, so the −4 h
 * is checked rather than recomputed by the same code under test.
 */

const LA_PAZ = 'America/La_Paz';
/** 2026-10-15 12:00 in La Paz. */
const NOW = Date.UTC(2026, 9, 15, 16, 0);

const HALLOWEEN: PublicEvent = {
  id: 'adopcion-de-halloween-2026-10-31',
  title: 'Adopción de Halloween',
  description: 'Línea uno\nLínea dos',
  startsAt: Date.UTC(2026, 9, 31, 19, 0), // 15:00 La Paz
  endsAt: Date.UTC(2026, 9, 31, 23, 0), // 19:00 La Paz
  allDay: false,
  placeName: 'Plaza Colón',
  address: 'Av. Heroínas',
  status: 'scheduled',
  updatedAt: null,
};

const CTX: EventCardContext = {
  timeZone: LA_PAZ,
  locale: 'es-BO',
  city: 'Cochabamba',
  whatsapp: '59177903553',
  now: NOW,
  allDayLabel: es.events.site.allDay,
  inquiry: es.events.site.inquiry,
};

const SHELTER_LD = {
  name: 'Wawitas Red de Apoyo',
  siteUrl: 'https://wawitas.org/',
  city: 'Cochabamba',
  country: 'Bolivia',
  timeZone: LA_PAZ,
};

const ts = (ms: number) => ({ toMillis: () => ms });

// ── publicEventFromData: the boundary on the server ─────────────────────────

const RAW = {
  title: 'Adopción de Halloween',
  description: 'Hola',
  startsAt: ts(HALLOWEEN.startsAt),
  endsAt: ts(HALLOWEEN.endsAt),
  allDay: false,
  placeName: 'Plaza Colón',
  address: null,
  status: 'scheduled',
  published: true,
  createdAt: ts(1),
  updatedAt: ts(Date.UTC(2026, 9, 14)),
  createdBy: 'admin@example.org',
  updatedBy: 'admin@example.org',
};

test('a published document becomes a PublicEvent with instants as ms', () => {
  const event = publicEventFromData('x-2026-10-31', RAW);
  assert.deepEqual(event, {
    id: 'x-2026-10-31',
    title: 'Adopción de Halloween',
    description: 'Hola',
    startsAt: Date.UTC(2026, 9, 31, 19),
    endsAt: Date.UTC(2026, 9, 31, 23),
    allDay: false,
    placeName: 'Plaza Colón',
    address: null,
    status: 'scheduled',
    updatedAt: Date.UTC(2026, 9, 14),
  });
});

test('the admin attribution never leaves the server', () => {
  const event = publicEventFromData('x', RAW) as unknown as Record<string, unknown>;
  assert.ok(event, 'CONTROL: the event was accepted');
  for (const key of ['createdBy', 'updatedBy', 'createdAt', 'published']) {
    assert.equal(key in event, false, key);
  }
  assert.doesNotMatch(JSON.stringify(event), /admin@example\.org/);
});

test('a draft is null — and so is anything merely truthy', () => {
  assert.equal(publicEventFromData('x', { ...RAW, published: false }), null);
  assert.equal(publicEventFromData('x', { ...RAW, published: 'true' }), null);
  assert.equal(publicEventFromData('x', { ...RAW, published: 1 }), null);
  const { published: _drop, ...noFlag } = RAW;
  assert.equal(publicEventFromData('x', noFlag), null);
  assert.equal(publicEventFromData('x', undefined), null);
});

test('a malformed document is dropped, not rendered half empty', () => {
  assert.equal(publicEventFromData('x', { ...RAW, title: 42 }), null);
  assert.equal(publicEventFromData('x', { ...RAW, startsAt: 'mañana' }), null);
  assert.equal(publicEventFromData('x', { ...RAW, endsAt: ts(HALLOWEEN.startsAt - 1) }), null);
  assert.equal(publicEventFromData('x', { ...RAW, placeName: undefined }), null);
});

test('an unknown status reads as scheduled; a blank address as none', () => {
  assert.equal(publicEventFromData('x', { ...RAW, status: 'postponed' })?.status, 'scheduled');
  assert.equal(publicEventFromData('x', { ...RAW, status: 'cancelled' })?.status, 'cancelled');
  assert.equal(publicEventFromData('x', { ...RAW, address: '   ' })?.address, null);
  assert.equal(publicEventFromData('x', { ...RAW, address: 'Av. Heroínas' })?.address, 'Av. Heroínas');
});

// ── the upcoming list's order ───────────────────────────────────────────────

test('sorted by START and cut after the sort: a long event that starts first is kept', () => {
  const day = (d: number, h = 19) => Date.UTC(2026, 9, d, h);
  // The query returns these in endsAt order. A week-long campaign starts
  // first but ends last; cutting the endsAt order to 2 would drop it.
  const shortA = { ...HALLOWEEN, id: 'a', startsAt: day(20), endsAt: day(20, 23) };
  const shortB = { ...HALLOWEEN, id: 'b', startsAt: day(21), endsAt: day(21, 23) };
  const campaign = { ...HALLOWEEN, id: 'campaign', startsAt: day(18), endsAt: day(25) };
  const inEndsAtOrder = [shortA, shortB, campaign];
  assert.deepEqual(
    sortUpcoming(inEndsAtOrder, 2).map((e) => e.id),
    ['campaign', 'a'],
  );
  assert.deepEqual(inEndsAtOrder.map((e) => e.id), ['a', 'b', 'campaign'], 'the input is not mutated');
});

test('equal starts break on end, then on id, so the order is stable', () => {
  const s = Date.UTC(2026, 9, 20, 19);
  const list = [
    { ...HALLOWEEN, id: 'z', startsAt: s, endsAt: s + 2 },
    { ...HALLOWEEN, id: 'y', startsAt: s, endsAt: s + 1 },
    { ...HALLOWEEN, id: 'x', startsAt: s, endsAt: s + 2 },
  ];
  assert.deepEqual(sortUpcoming(list, 10).map((e) => e.id), ['y', 'x', 'z']);
  assert.deepEqual(sortUpcoming(list, 0), []);
});

test('past means after the END of the last day, in La Paz', () => {
  // Ends 19:00 on Oct 31 La Paz. Still upcoming at 23:59:59 that night
  // (03:59:59Z on Nov 1); past at 00:00 Nov 1 La Paz (04:00Z).
  assert.equal(eventIsPast(HALLOWEEN, Date.UTC(2026, 10, 1, 3, 59, 59), LA_PAZ), false);
  assert.equal(eventIsPast(HALLOWEEN, Date.UTC(2026, 10, 1, 4, 0, 0), LA_PAZ), true);
});

// ── the card ────────────────────────────────────────────────────────────────

test('the card: 24-hour range in La Paz, place, map link, WhatsApp naming the event', () => {
  const card = buildEventCard(HALLOWEEN, CTX);
  assert.equal(card.href, '/events/adopcion-de-halloween-2026-10-31');
  assert.equal(card.when, 'sábado, 31 de octubre · 15:00–19:00');
  assert.equal(card.place, 'Plaza Colón · Av. Heroínas');
  assert.equal(
    card.mapsUrl,
    'https://www.google.com/maps/search/?api=1&query=Plaza%20Col%C3%B3n%2C%20Av.%20Hero%C3%ADnas%2C%20Cochabamba',
  );
  assert.equal(card.cancelled, false);
  assert.equal(card.past, false);
  assert.equal(
    card.whatsappUrl,
    'https://wa.me/59177903553?text=' +
      encodeURIComponent('Hola, quiero saber más sobre «Adopción de Halloween» del sábado, 31 de octubre.'),
  );
});

test('an all-day event says "Todo el día" where a timed one shows hours', () => {
  const card = buildEventCard(
    { ...HALLOWEEN, allDay: true, startsAt: Date.UTC(2026, 9, 31, 4), endsAt: Date.UTC(2026, 10, 1, 4) - 1 },
    CTX,
  );
  assert.equal(card.when, 'sábado, 31 de octubre · Todo el día');
});

test('a cancelled event stays a card, marked, with no WhatsApp button', () => {
  const card = buildEventCard({ ...HALLOWEEN, status: 'cancelled' }, CTX);
  assert.equal(card.cancelled, true);
  assert.equal(card.whatsappUrl, null);
  assert.equal(card.when, 'sábado, 31 de octubre · 15:00–19:00');
});

// ── link previews ───────────────────────────────────────────────────────────

test('a scheduled event previews with its own title, then when · place · excerpt', () => {
  const share = buildEventShareText(buildEventCard(HALLOWEEN, CTX), HALLOWEEN.description, es.events.site.cancelledBadge);
  assert.equal(share.title, 'Adopción de Halloween');
  assert.equal(share.description, 'sábado, 31 de octubre · 15:00–19:00 · Plaza Colón · Av. Heroínas · Línea uno Línea dos');
});

test('a CANCELLED event previews as cancelled, first, in title and description', () => {
  // WhatsApp and Facebook read <title> and og:*; they never see the JSON-LD
  // eventStatus, so without this a shared link keeps inviting people.
  const event: PublicEvent = { ...HALLOWEEN, status: 'cancelled' };
  const share = buildEventShareText(buildEventCard(event, CTX), event.description, es.events.site.cancelledBadge);
  assert.equal(share.title, 'Cancelado · Adopción de Halloween');
  assert.equal(
    share.description,
    'Cancelado · sábado, 31 de octubre · 15:00–19:00 · Plaza Colón · Av. Heroínas · Línea uno Línea dos',
  );
});

test('openGraph restates type and locale, which a page-level openGraph would otherwise drop', () => {
  assert.deepEqual(
    eventsOpenGraph({ locale: 'es-BO', title: 'Eventos', description: 'd', url: '/events' }),
    { type: 'website', locale: 'es_BO', title: 'Eventos', description: 'd', url: '/events' },
  );
});

test('a past event has no WhatsApp button', () => {
  const card = buildEventCard(HALLOWEEN, { ...CTX, now: Date.UTC(2026, 10, 2) });
  assert.equal(card.past, true);
  assert.equal(card.whatsappUrl, null);
});

// ── map link, place, excerpt, paragraphs ────────────────────────────────────

test('the map link is a keyless SEARCH URL with the city appended once', () => {
  assert.equal(
    mapsSearchUrl('Plaza Colón', null, 'Cochabamba'),
    'https://www.google.com/maps/search/?api=1&query=Plaza%20Col%C3%B3n%2C%20Cochabamba',
  );
  // Already names the city: not appended twice.
  assert.equal(
    mapsSearchUrl('Parque Lincoln', 'Cochabamba centro', 'Cochabamba'),
    'https://www.google.com/maps/search/?api=1&query=Parque%20Lincoln%2C%20Cochabamba%20centro',
  );
  // `&` in a venue cannot start a second query parameter.
  assert.match(mapsSearchUrl('Café & Patas', null, 'Cochabamba'), /query=Caf%C3%A9%20%26%20Patas%2C%20Cochabamba$/);
  assert.doesNotMatch(mapsSearchUrl('X', null, 'Y'), /key=|embed/);
});

test('placeLine joins the address only when there is one', () => {
  assert.equal(placeLine({ placeName: 'Plaza Colón', address: null }), 'Plaza Colón');
  assert.equal(placeLine({ placeName: 'Plaza Colón', address: 'Av. Heroínas' }), 'Plaza Colón · Av. Heroínas');
});

test('the excerpt folds lines, cuts at a word and ends in an ellipsis', () => {
  assert.equal(descriptionExcerpt('Uno\n\ndos   tres'), 'Uno dos tres');
  assert.equal(descriptionExcerpt('palabra '.repeat(10), 20), 'palabra palabra…');
  assert.equal(descriptionExcerpt('', 20), '');
  const long = descriptionExcerpt('a '.repeat(300));
  assert.ok(long.length <= 241, String(long.length));
  assert.ok(long.endsWith('…'));
});

test('paragraphs keep line breaks and blank-line paragraphs, and never parse HTML', () => {
  assert.deepEqual(descriptionParagraphs('Uno\r\nDos\n\n\nTres\n  \n<b>Cuatro</b>'), [
    ['Uno', 'Dos'],
    ['Tres'],
    ['<b>Cuatro</b>'],
  ]);
  assert.deepEqual(descriptionParagraphs('   '), []);
});

test('eventDays: one day, or the first and last days', () => {
  assert.deepEqual(eventDays(HALLOWEEN, LA_PAZ, 'es-BO', NOW), { first: 'sábado, 31 de octubre', last: null });
  assert.deepEqual(eventDays({ startsAt: HALLOWEEN.startsAt, endsAt: Date.UTC(2026, 10, 1, 23) }, LA_PAZ, 'es-BO', NOW), {
    first: 'sábado, 31 de octubre',
    last: 'domingo, 1 de noviembre',
  });
  // A 21:30 start in La Paz is 01:30Z the next day: still Oct 31.
  assert.equal(eventDays({ startsAt: Date.UTC(2026, 10, 1, 1, 30), endsAt: Date.UTC(2026, 10, 1, 2, 30) }, LA_PAZ, 'es-BO', NOW).first, 'sábado, 31 de octubre');
});

// ── JSON-LD ─────────────────────────────────────────────────────────────────

test('JSON-LD: an Event with La Paz offsets, never a UTC Z', () => {
  const ld = buildEventJsonLd(HALLOWEEN, SHELTER_LD);
  assert.deepEqual(ld, {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: 'Adopción de Halloween',
    description: 'Línea uno\nLínea dos',
    startDate: '2026-10-31T15:00:00-04:00',
    endDate: '2026-10-31T19:00:00-04:00',
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: {
      '@type': 'Place',
      name: 'Plaza Colón',
      address: {
        '@type': 'PostalAddress',
        streetAddress: 'Av. Heroínas',
        addressLocality: 'Cochabamba',
        addressCountry: 'Bolivia',
      },
    },
    organizer: { '@type': 'Organization', name: 'Wawitas Red de Apoyo', url: 'https://wawitas.org' },
    url: 'https://wawitas.org/events/adopcion-de-halloween-2026-10-31',
  });
});

test('JSON-LD: cancelled is EventCancelled; all-day is dates; no address, no street', () => {
  const cancelled = buildEventJsonLd({ ...HALLOWEEN, status: 'cancelled' }, SHELTER_LD);
  assert.equal(cancelled.eventStatus, 'https://schema.org/EventCancelled');

  const allDay = buildEventJsonLd(
    { ...HALLOWEEN, allDay: true, address: null, startsAt: Date.UTC(2026, 9, 31, 4), endsAt: Date.UTC(2026, 10, 2, 4) - 1 },
    SHELTER_LD,
  );
  assert.equal(allDay.startDate, '2026-10-31');
  assert.equal(allDay.endDate, '2026-11-01');
  const location = allDay.location as { address: Record<string, unknown> };
  assert.equal('streetAddress' in location.address, false);

  const blank = buildEventJsonLd({ ...HALLOWEEN, description: '  ' }, SHELTER_LD);
  assert.equal('description' in blank, false);
});

test('serializeJsonLd: a </script> in a title cannot close the tag', () => {
  const hostile = { ...HALLOWEEN, title: '</script><script>alert(1)</script>' };
  const out = serializeJsonLd(buildEventJsonLd(hostile, SHELTER_LD));
  assert.equal(out.includes('<'), false);
  assert.match(out, /\\u003c\/script>\\u003cscript>alert\(1\)\\u003c\/script>/);
  // Still the same JSON to a parser.
  assert.equal((JSON.parse(out) as { name: string }).name, hostile.title);
});

test('serializeJsonLd escapes the two JavaScript line separators', () => {
  const ls = String.fromCharCode(0x2028);
  const ps = String.fromCharCode(0x2029);
  const out = serializeJsonLd({ a: `x${ls}y${ps}z` });
  assert.equal(out.includes(ls) || out.includes(ps), false);
  assert.equal(out, '{"a":"x\\u2028y\\u2029z"}');
  assert.equal((JSON.parse(out) as { a: string }).a, `x${ls}y${ps}z`);
});

// ── sitemap rows ────────────────────────────────────────────────────────────

test('sitemap rows carry the id and a lastModified only when known', () => {
  assert.deepEqual(
    sitemapEventRows([HALLOWEEN, { ...HALLOWEEN, id: 'b', updatedAt: Date.UTC(2026, 9, 14) }]),
    [{ id: 'adopcion-de-halloween-2026-10-31' }, { id: 'b', updatedAt: new Date(Date.UTC(2026, 9, 14)) }],
  );
});

// ── the visitor copy ────────────────────────────────────────────────────────

const site = es.events.site;

function visitorCopy(): string[] {
  const out: string[] = [];
  for (const value of Object.values(site)) if (typeof value === 'string') out.push(value);
  out.push(
    site.intro('Wawitas', 'Cochabamba'),
    site.inquiry('Feria', 'sábado, 31 de octubre'),
    site.pastNotice('sábado, 31 de octubre', null),
    site.pastNotice('sábado, 31 de octubre', 'domingo, 1 de noviembre'),
    site.homeHeading(1),
    site.homeHeading(3),
  );
  return out;
}

test('the visitor copy never signals a gap', () => {
  const all = visitorCopy();
  assert.ok(all.length >= 20, `CONTROL: the copy was collected (${all.length})`);
  // Letter-aware boundaries, not \b: JavaScript's \b is ASCII-only and has no
  // boundary after a final accented vowel.
  const gap = /(?<!\p{L})(aún no|todavía|próximamente|pronto|por ahora|no hay eventos)(?!\p{L})/iu;
  assert.match('Muy pronto.', gap, 'CONTROL: the pattern bites');
  assert.match('No hay eventos', gap, 'CONTROL: the pattern bites on the phrase');
  for (const text of all) assert.doesNotMatch(text, gap, text);
});

test('the visitor copy speaks neutral tuteo, no voseo', () => {
  const found = visitorCopy().flatMap((text) => findVoseo(text).map((form) => `${form} in «${text}»`));
  assert.deepEqual(found, []);
});

test('the approved empty-state words are kept exactly', () => {
  assert.equal(site.emptyTitle, 'Las ferias y jornadas se anuncian primero en nuestras redes.');
  assert.equal(
    site.emptyBody,
    'Síguenos en Instagram y Facebook, o escríbenos por WhatsApp para saber de la próxima feria de adopción.',
  );
  assert.equal(site.loadFailed, 'No pudimos cargar los eventos en este momento. Intenta de nuevo en un rato.');
});

test('the past and cancelled notices read as finished facts', () => {
  assert.equal(site.pastNotice('sábado, 31 de octubre', null), 'Este evento se realizó el sábado, 31 de octubre.');
  assert.equal(
    site.pastNotice('sábado, 31 de octubre', 'domingo, 1 de noviembre'),
    'Este evento se realizó del sábado, 31 de octubre al domingo, 1 de noviembre.',
  );
  assert.equal(site.cancelledNotice, 'Este evento se canceló.');
});
