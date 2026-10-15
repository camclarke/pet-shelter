import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EVENT_LIMITS,
  canDeleteEvent,
  utf16Length,
  duplicateEvent,
  emptyEventDraft,
  eventIdBase,
  eventIdCandidate,
  eventToDraft,
  groupEvents,
  isValidEventId,
  nextStatus,
  validateEvent,
  type EventDraft,
  type EventView,
} from '../events';
import { es } from '@/i18n/es';
import { findVoseo } from '../ai/spanish-register';

/**
 * Every limit is checked against a LITERAL, never against EVENT_LIMITS
 * itself — a test comparing the validator to the constant it reads cannot
 * fail. The same literals sit in firestore.rules (see events-wiring.test.ts).
 */

const LA_PAZ = 'America/La_Paz';
const NOW = Date.parse('2026-10-15T16:00:00Z'); // 12:00 La Paz, 15 Oct 2026

const valid = (over: Partial<EventDraft> = {}): EventDraft => ({
  title: 'Feria de adopción',
  description: 'Ven a conocer a los animalitos.',
  placeName: 'Plaza Colón',
  address: '',
  allDay: false,
  start: '2026-10-31T15:00',
  end: '2026-10-31T19:00',
  ...over,
});

const errorsOf = (draft: EventDraft) => validateEvent(draft, LA_PAZ, NOW).errors;
const warningsOf = (draft: EventDraft) => validateEvent(draft, LA_PAZ, NOW).warnings;

// ── validation, every edge ─────────────────────────────────────────────────

test('a complete draft is valid, and its fields are trimmed, converted and ready to write', () => {
  const result = validateEvent(valid({ title: '  Feria de adopción  ', address: '  ' }), LA_PAZ, NOW);
  assert.deepEqual(result.errors, []);
  assert.equal(result.fields?.title, 'Feria de adopción');
  assert.equal(result.fields?.address, null);
  assert.equal(result.fields?.startsAt.toISOString(), '2026-10-31T19:00:00.000Z');
  assert.equal(result.fields?.endsAt.toISOString(), '2026-10-31T23:00:00.000Z');
});

test('title: 3 and 120 characters pass, 2 and 121 do not', () => {
  assert.deepEqual(errorsOf(valid({ title: 'abc' })), []);
  assert.deepEqual(errorsOf(valid({ title: 'a'.repeat(120) })), []);
  assert.deepEqual(errorsOf(valid({ title: 'ab' })), ['title-too-short']);
  assert.deepEqual(errorsOf(valid({ title: 'a'.repeat(121) })), ['title-too-long']);
  assert.deepEqual(errorsOf(valid({ title: '   ab   ' })), ['title-too-short']);
});

test('lengths are counted in UTF-16 units, like the rules\' size(): 60 emoji fit 120, 61 do not', () => {
  // Measured on the Rules :test API — see scripts/rules-test-events.mjs.
  assert.equal(utf16Length('🐶'), 2);
  assert.equal([...'🐶'].length, 1); // CONTROL: a code-point count would say 1
  assert.deepEqual(errorsOf(valid({ title: '🐶'.repeat(60) })), []);
  assert.deepEqual(errorsOf(valid({ title: '🐶'.repeat(61) })), ['title-too-long']);
  // Spanish letters are one unit each.
  assert.deepEqual(errorsOf(valid({ title: 'ñ'.repeat(120) })), []);
});

test('blank text does not meet a minimum: three spaces is no title, two no place', () => {
  assert.deepEqual(errorsOf(valid({ title: '   ' })), ['title-too-short']);
  assert.deepEqual(errorsOf(valid({ placeName: '  ' })), ['place-too-short']);
});

test('a year outside 2000–2100 is its own error, on the start and on the end', () => {
  assert.deepEqual(errorsOf(valid({ start: '0026-10-31T15:00' })), ['year-out-of-range']);
  assert.deepEqual(errorsOf(valid({ end: '0026-10-31T19:00' })), ['year-out-of-range']);
  assert.deepEqual(errorsOf(valid({ allDay: true, start: '2101-01-01', end: '' })), ['year-out-of-range']);
  // CONTROL: a malformed date is still "missing", not a year problem.
  assert.deepEqual(errorsOf(valid({ start: '2026-02-30T10:00' })), ['start-missing']);
});

test('description: 4000 passes, 4001 does not, empty is fine', () => {
  assert.deepEqual(errorsOf(valid({ description: 'a'.repeat(4000) })), []);
  assert.deepEqual(errorsOf(valid({ description: 'a'.repeat(4001) })), ['description-too-long']);
  assert.deepEqual(errorsOf(valid({ description: '' })), []);
});

test('place: 2 and 120 pass, 1 and 121 do not', () => {
  assert.deepEqual(errorsOf(valid({ placeName: 'ab' })), []);
  assert.deepEqual(errorsOf(valid({ placeName: 'a'.repeat(120) })), []);
  assert.deepEqual(errorsOf(valid({ placeName: 'a' })), ['place-too-short']);
  assert.deepEqual(errorsOf(valid({ placeName: 'a'.repeat(121) })), ['place-too-long']);
});

test('address: optional, 200 passes, 201 does not', () => {
  assert.deepEqual(errorsOf(valid({ address: 'a'.repeat(200) })), []);
  assert.deepEqual(errorsOf(valid({ address: 'a'.repeat(201) })), ['address-too-long']);
});

test('a missing or unparseable start is an error, not a guess', () => {
  assert.deepEqual(errorsOf(valid({ start: '' })), ['start-missing']);
  assert.deepEqual(errorsOf(valid({ start: '2026-02-30T10:00' })), ['start-missing']);
});

test('an unparseable end is an error; a blank one means "no announced end"', () => {
  assert.deepEqual(errorsOf(valid({ end: '2026-10-31T25:00' })), ['end-missing']);
  const blank = validateEvent(valid({ end: '' }), LA_PAZ, NOW);
  assert.deepEqual(blank.errors, []);
  assert.equal(blank.fields?.endsAt.getTime(), blank.fields?.startsAt.getTime());
});

test('end before start is refused; end == start is allowed', () => {
  assert.deepEqual(errorsOf(valid({ end: '2026-10-31T14:59' })), ['end-before-start']);
  assert.deepEqual(errorsOf(valid({ end: '2026-10-31T15:00' })), []);
});

test('the span: exactly 31 days passes, a minute more does not', () => {
  assert.deepEqual(errorsOf(valid({ end: '2026-12-01T15:00' })), []);
  assert.deepEqual(errorsOf(valid({ end: '2026-12-01T15:01' })), ['span-too-long']);
});

test('all day: the end day may be blank (one day); a last day before the first is refused', () => {
  const one = validateEvent(valid({ allDay: true, start: '2026-10-31', end: '' }), LA_PAZ, NOW);
  assert.deepEqual(one.errors, []);
  assert.equal(one.fields?.startsAt.toISOString(), '2026-10-31T04:00:00.000Z');
  assert.equal(one.fields?.endsAt.toISOString(), '2026-11-01T03:59:59.999Z');
  assert.deepEqual(errorsOf(valid({ allDay: true, start: '2026-11-01', end: '2026-10-31' })), ['end-before-start']);
});

test('all day: 31 calendar days pass, 32 do not', () => {
  // 1 Nov → 1 Dec inclusive is 31 days minus a millisecond of span.
  assert.deepEqual(errorsOf(valid({ allDay: true, start: '2026-11-01', end: '2026-12-01' })), []);
  assert.deepEqual(errorsOf(valid({ allDay: true, start: '2026-11-01', end: '2026-12-02' })), ['span-too-long']);
});

// ── warnings never block ───────────────────────────────────────────────────

test('a start in the past warns but still produces fields to save', () => {
  const result = validateEvent(valid({ start: '2026-10-01T15:00', end: '2026-10-01T19:00' }), LA_PAZ, NOW);
  assert.deepEqual(result.warnings, ['start-in-past']);
  assert.deepEqual(result.errors, []);
  assert.ok(result.fields);
});

test('a start a couple of minutes ago does not warn (clock skew)', () => {
  assert.deepEqual(warningsOf(valid({ start: '2026-10-15T11:58', end: '' })), []);
});

test('a start more than 400 days ahead warns — "2027" for "2026" is the usual cause', () => {
  assert.deepEqual(warningsOf(valid({ start: '2027-12-31T15:00', end: '2027-12-31T19:00' })), ['start-far-future']);
  assert.deepEqual(warningsOf(valid({ start: '2027-10-31T15:00', end: '2027-10-31T19:00' })), []);
});

test('an all-day event longer than a week warns', () => {
  assert.deepEqual(warningsOf(valid({ allDay: true, start: '2026-11-01', end: '2026-11-09' })), ['all-day-long']);
  assert.deepEqual(warningsOf(valid({ allDay: true, start: '2026-11-01', end: '2026-11-07' })), []);
});

// ── the id ─────────────────────────────────────────────────────────────────

test('the id is an accent-free kebab slug plus the La Paz date', () => {
  const at = Date.parse('2026-10-31T19:00:00Z');
  assert.equal(eventIdBase('Adopción de Halloween', at, LA_PAZ), 'adopcion-de-halloween-2026-10-31');
  assert.equal(eventIdBase('¡Feria Ñoña 2026!', at, LA_PAZ), 'feria-nona-2026-2026-10-31');
});

test('a 21:30 event on 31 October gets "-10-31", not the UTC day "-11-01"', () => {
  const at = Date.parse('2026-11-01T01:30:00Z'); // 21:30 La Paz, 31 Oct
  assert.equal(eventIdBase('Cine', at, LA_PAZ), 'cine-2026-10-31');
});

test('a title with nothing slug-able falls back to "evento"', () => {
  assert.equal(eventIdBase('🎃🎃🎃', Date.parse('2026-10-31T19:00:00Z'), LA_PAZ), 'evento-2026-10-31');
});

test('a very long title is cut at a hyphen and the id still fits the rules with a suffix', () => {
  const title = 'palabra '.repeat(30);
  const base = eventIdBase(title, Date.parse('2026-10-31T19:00:00Z'), LA_PAZ);
  assert.ok(isValidEventId(base), base);
  assert.ok(isValidEventId(eventIdCandidate(base, 20)), 'with -20');
  assert.ok(base.length + '-99'.length <= 120);
  assert.match(base, /^(palabra-)+palabra-2026-10-31$/);
});

test('collisions: attempt 1 is the base, then -2, -3', () => {
  assert.equal(eventIdCandidate('feria-2026-10-31', 1), 'feria-2026-10-31');
  assert.equal(eventIdCandidate('feria-2026-10-31', 2), 'feria-2026-10-31-2');
  assert.equal(eventIdCandidate('feria-2026-10-31', 3), 'feria-2026-10-31-3');
});

test('the id shape matches the rules: lowercase kebab, at most 120', () => {
  assert.equal(isValidEventId('feria-2026-10-31'), true);
  assert.equal(isValidEventId('Hola Mundo'), false);
  assert.equal(isValidEventId('feria--2026'), false);
  assert.equal(isValidEventId('a'.repeat(120)), true);
  assert.equal(isValidEventId('a'.repeat(121)), false);
});

// ── editing, duplicating, grouping ─────────────────────────────────────────

const view = (over: Partial<EventView> = {}): EventView => ({
  id: 'feria-2026-10-31',
  title: 'Feria de adopción',
  description: 'Texto',
  startsAt: Date.parse('2026-10-31T19:00:00Z'),
  endsAt: Date.parse('2026-10-31T23:00:00Z'),
  allDay: false,
  placeName: 'Plaza Colón',
  address: 'Av. Heroínas',
  status: 'scheduled',
  published: true,
  createdAt: NOW,
  updatedAt: NOW,
  createdBy: 'u1',
  updatedBy: 'u1',
  ...over,
});

test('an event goes back into the editor in La Paz time', () => {
  assert.deepEqual(eventToDraft(view(), LA_PAZ), {
    title: 'Feria de adopción',
    description: 'Texto',
    placeName: 'Plaza Colón',
    address: 'Av. Heroínas',
    allDay: false,
    start: '2026-10-31T15:00',
    end: '2026-10-31T19:00',
  });
});

test('an all-day event goes back as days; a timed one with no end shows a blank end', () => {
  const allDay = eventToDraft(
    view({ allDay: true, startsAt: Date.parse('2026-10-31T04:00:00Z'), endsAt: Date.parse('2026-11-02T03:59:59.999Z') }),
    LA_PAZ,
  );
  assert.equal(allDay.start, '2026-10-31');
  assert.equal(allDay.end, '2026-11-01');
  const noEnd = eventToDraft(view({ endsAt: Date.parse('2026-10-31T19:00:00Z') }), LA_PAZ);
  assert.equal(noEnd.end, '');
});

test('"Duplicar" copies the text and the place, and CLEARS the dates', () => {
  const copy = duplicateEvent(view({ address: null }));
  assert.deepEqual(copy, {
    title: 'Feria de adopción',
    description: 'Texto',
    placeName: 'Plaza Colón',
    address: '',
    allDay: false,
    start: '',
    end: '',
  });
  // Without dates it cannot be saved until someone picks new ones.
  assert.deepEqual(validateEvent(copy, LA_PAZ, NOW).errors, ['start-missing']);
});

test('the empty draft has no example content in it', () => {
  const empty = emptyEventDraft();
  assert.deepEqual(Object.values(empty).filter((v) => typeof v === 'string' && v !== ''), []);
});

test('the list groups drafts, upcoming and past by the La Paz cut-off', () => {
  const groups = groupEvents(
    [
      view({ id: 'draft', published: false }),
      view({ id: 'later', startsAt: Date.parse('2026-11-20T19:00:00Z'), endsAt: Date.parse('2026-11-20T23:00:00Z') }),
      view({ id: 'soon' }),
      view({ id: 'today-ended', startsAt: Date.parse('2026-10-15T12:00:00Z'), endsAt: Date.parse('2026-10-15T14:00:00Z') }),
      view({ id: 'yesterday', startsAt: Date.parse('2026-10-14T19:00:00Z'), endsAt: Date.parse('2026-10-14T23:00:00Z') }),
      view({ id: 'last-week', startsAt: Date.parse('2026-10-08T19:00:00Z'), endsAt: Date.parse('2026-10-08T23:00:00Z') }),
    ],
    NOW,
    LA_PAZ,
  );
  assert.deepEqual(groups.drafts.map((e) => e.id), ['draft']);
  // Ended at 10:00 La Paz today: still listed until midnight.
  assert.deepEqual(groups.upcoming.map((e) => e.id), ['today-ended', 'soon', 'later']);
  assert.deepEqual(groups.past.map((e) => e.id), ['yesterday', 'last-week']);
});

test('only an unpublished event can be deleted', () => {
  assert.equal(canDeleteEvent({ published: false }), true);
  assert.equal(canDeleteEvent({ published: true }), false);
});

test('cancel and reactivate are each other\'s inverse', () => {
  assert.equal(nextStatus('scheduled'), 'cancelled');
  assert.equal(nextStatus('cancelled'), 'scheduled');
});

// ── the copy ───────────────────────────────────────────────────────────────

const strings = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : typeof value === 'function'
      ? []
      : value && typeof value === 'object'
        ? Object.values(value).flatMap(strings)
        : [];

const eventCopy = (): string[] => [
  ...strings(es.events),
  es.events.deleteConfirm('Feria'),
  es.events.publishConfirm('Feria'),
  es.events.cancelConfirm('Feria'),
  es.events.timeZoneNote('Bolivia'),
  es.events.preview('sábado, 31 de octubre · 15:00–19:00', 'Bolivia'),
  es.events.preview('sábado, 31 de octubre', null),
  ...(
    [
      'title-too-short', 'title-too-long', 'description-too-long', 'place-too-short', 'place-too-long',
      'address-too-long', 'start-missing', 'end-missing', 'end-before-start', 'span-too-long',
      'year-out-of-range',
    ] as const
  ).map((e) => es.events.error(e)),
  ...(['start-in-past', 'start-far-future', 'all-day-long'] as const).map((w) => es.events.warning(w)),
];

test('the events copy never signals a gap', () => {
  const all = eventCopy();
  assert.ok(all.length > 40, 'CONTROL: the copy was actually collected');
  for (const text of all) {
    assert.doesNotMatch(text, /\b(aún no|todavía|próximamente|pronto|por ahora)\b/iu, text);
  }
});

test('the events copy speaks neutral tuteo, no voseo', () => {
  const found = eventCopy().flatMap((text) => findVoseo(text).map((form) => `${form} in «${text}»`));
  assert.deepEqual(found, []);
});

test('each error names the cap the validator enforces', () => {
  assert.match(es.events.error('title-too-long'), /120/);
  assert.match(es.events.error('description-too-long'), /4000/);
  assert.match(es.events.error('place-too-long'), /120/);
  assert.match(es.events.error('address-too-long'), /200/);
  assert.match(es.events.error('span-too-long'), /31/);
  assert.match(es.events.error('title-too-short'), /3/);
});

test('every confirm names the event', () => {
  assert.match(es.events.deleteConfirm('Feria de Halloween'), /«Feria de Halloween»/);
  assert.match(es.events.publishConfirm('Feria de Halloween'), /^¿Publicar «Feria de Halloween»\?/);
  assert.match(es.events.cancelConfirm('Feria de Halloween'), /«Feria de Halloween»/);
});

test('the year error names the range the converter enforces', () => {
  assert.match(es.events.error('year-out-of-range'), /2000/);
  assert.match(es.events.error('year-out-of-range'), /2100/);
});

test('EVENT_LIMITS are the agreed literals', () => {
  assert.deepEqual(
    { ...EVENT_LIMITS },
    { titleMin: 3, titleMax: 120, descriptionMax: 4000, placeMin: 2, placeMax: 120, addressMax: 200, maxSpanDays: 31, idMax: 120 },
  );
});
