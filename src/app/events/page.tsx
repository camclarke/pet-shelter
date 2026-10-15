import type { Metadata } from 'next';
import Link from 'next/link';
import { SHELTER } from '@/config/shelter';
import { t } from '@/i18n';
import { getUpcomingEvents } from '@/lib/events-server';
import { buildEventCard, eventsOpenGraph, type EventCardView, type PublicEvent } from '@/lib/events-public';

const copy = t.events.site;

/**
 * `eventsOpenGraph` restates `og:type` and `og:locale`: a page's `openGraph`
 * REPLACES the layout's rather than merging with it. The relative URLs are
 * made absolute by the layout's `metadataBase`.
 */
export const metadata: Metadata = {
  title: copy.pageTitle,
  description: copy.intro(SHELTER.shortName, SHELTER.city),
  alternates: { canonical: '/events' },
  openGraph: eventsOpenGraph({
    locale: SHELTER.locale,
    title: copy.pageTitle,
    description: copy.intro(SHELTER.shortName, SHELTER.city),
    url: '/events',
  }),
};

/**
 * MANDATORY. Without it Next prerenders this page at build time — where the
 * build has no Firestore credentials, so what would be frozen is the ERROR
 * state — and Firebase Hosting then caches that HTML for a year
 * (`s-maxage=31536000`), past any deploy. 300 s bounds the reads to one query
 * per regeneration, whatever the traffic. A test fails if this line goes.
 */
export const revalidate = 300;

/**
 * Upcoming adoption fairs and events. Past events are OFF the list (owner,
 * 2026-10-15); their own pages keep working. A cancelled event stays listed
 * while it is upcoming, marked as cancelled, so a shared link and the list
 * tell the same story.
 *
 * Every card's WhatsApp button is `.btn--brand` — never `.btn--action`, which
 * appears once per screen and belongs to the detail page.
 */
export default async function EventsPage() {
  const now = Date.now();
  let events: PublicEvent[] = [];
  let failed = false;
  try {
    events = await getUpcomingEvents(20, now);
  } catch (err) {
    console.error('[events] failed to load upcoming events', err);
    failed = true;
  }

  const cards = events.map((event) =>
    buildEventCard(event, {
      timeZone: SHELTER.timeZone,
      locale: SHELTER.locale,
      city: SHELTER.city,
      whatsapp: SHELTER.whatsapp,
      now,
      allDayLabel: copy.allDay,
      inquiry: copy.inquiry,
    }),
  );

  return (
    <section className="events">
      <div className="container">
        <h1 className="t-title events__title">{copy.pageTitle}</h1>
        <p className="events__intro">{copy.intro(SHELTER.shortName, SHELTER.city)}</p>

        {failed && <p className="events__failed">{copy.loadFailed}</p>}

        {!failed && cards.length === 0 && <EventsEmpty />}

        {!failed && cards.length > 0 && (
          <ol className="events__list">
            {cards.map((card) => (
              <li key={card.id}>
                <EventCard card={card} />
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function EventCard({ card }: { card: EventCardView }) {
  return (
    <article className={`event-card${card.cancelled ? ' event-card--cancelled' : ''}`}>
      <p className="event-card__when">
        <span>{card.when}</span>
        {card.cancelled && <span className="event-card__badge">{copy.cancelledBadge}</span>}
      </p>
      <h2 className="event-card__title">
        <Link href={card.href}>{card.title}</Link>
      </h2>
      <p className="event-card__place">
        {card.place}{' '}
        <a href={card.mapsUrl} target="_blank" rel="noopener noreferrer" className="event-card__map">
          {copy.mapLink}
        </a>
      </p>
      {card.excerpt && <p className="event-card__excerpt">{card.excerpt}</p>}
      {card.whatsappUrl && (
        <a
          href={card.whatsappUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn--brand btn--compact event-card__cta"
        >
          {copy.askOnWhatsapp}
        </a>
      )}
    </article>
  );
}

/** The empty state: true claims only, and a way to hear about the next fair. */
function EventsEmpty() {
  return (
    <div className="events__empty">
      <p className="events__empty-title">{copy.emptyTitle}</p>
      <p className="events__empty-body">{copy.emptyBody}</p>
      <div className="events__empty-links">
        {SHELTER.instagram && (
          <a href={SHELTER.instagram} target="_blank" rel="noopener noreferrer" className="btn btn--muted">
            {copy.instagram}
          </a>
        )}
        {SHELTER.facebook && (
          <a href={SHELTER.facebook} target="_blank" rel="noopener noreferrer" className="btn btn--muted">
            {copy.facebook}
          </a>
        )}
        {SHELTER.whatsapp && (
          <a
            href={`https://wa.me/${SHELTER.whatsapp}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn--brand"
          >
            {copy.whatsapp}
          </a>
        )}
      </div>
    </div>
  );
}
