import Link from 'next/link';
import { SHELTER } from '@/config/shelter';
import { t } from '@/i18n';
import { getUpcomingEvents } from '@/lib/events-server';
import { buildEventCard, type PublicEvent } from '@/lib/events-public';

const copy = t.events.site;

/**
 * The homepage's events card. A Server Component that renders NOTHING unless
 * at least one published, upcoming event exists — never a placeholder, never
 * an empty box (owner, 2026-10-15).
 *
 * ⚠️ It must never break the homepage. If the events query throws (a missing
 * index, a cold build with no credentials), the card is simply absent and the
 * page renders exactly as it did before events existed. The adoption wall is
 * the page's whole point; events are a guest on it.
 */
export async function UpcomingEvents({ limit = 3 }: { limit?: number }) {
  const now = Date.now();
  let events: PublicEvent[] = [];
  try {
    events = await getUpcomingEvents(limit, now);
  } catch (err) {
    console.error('[home] events card skipped: the events query failed', err);
    return null;
  }
  if (events.length === 0) return null;

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
    <section className="home-events" aria-labelledby="home-events-title">
      <div className="container">
        <h2 id="home-events-title" className="t-title home-events__title">
          {copy.homeHeading(cards.length)}
        </h2>
        <ul className="home-events__list">
          {cards.map((card) => (
            <li key={card.id} className={`home-events__item${card.cancelled ? ' event-card--cancelled' : ''}`}>
              <p className="event-card__when">
                <span>{card.when}</span>
                {card.cancelled && <span className="event-card__badge">{copy.cancelledBadge}</span>}
              </p>
              <p className="event-card__title">
                <Link href={card.href}>{card.title}</Link>
              </p>
              <p className="event-card__place">{card.place}</p>
            </li>
          ))}
        </ul>
        <Link href="/events" className="btn btn--muted home-events__all">
          {copy.homeSeeAll}
        </Link>
      </div>
    </section>
  );
}
