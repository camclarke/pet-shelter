import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SHELTER } from '@/config/shelter';
import { t } from '@/i18n';
import { getPublishedEvent } from '@/lib/events-server';
import {
  buildEventCard,
  buildEventJsonLd,
  buildEventShareText,
  descriptionParagraphs,
  eventDays,
  eventsOpenGraph,
  serializeJsonLd,
  type PublicEvent,
} from '@/lib/events-public';

const copy = t.events.site;

/**
 * Kept for uniformity and for the day this route prerenders. Today it is
 * dynamic (no `generateStaticParams`), and on a dynamic route `revalidate` is
 * inert — measured on /adopt/[slug], which answers
 * `private, no-cache, no-store`. A test still requires the line on every
 * events route, so it cannot go missing the day it starts to matter.
 */
export const revalidate = 300;

interface Props {
  params: Promise<{ slug: string }>;
}

function cardFor(event: PublicEvent, now: number) {
  return buildEventCard(event, {
    timeZone: SHELTER.timeZone,
    locale: SHELTER.locale,
    city: SHELTER.city,
    whatsapp: SHELTER.whatsapp,
    now,
    allDayLabel: copy.allDay,
    inquiry: copy.inquiry,
  });
}

/**
 * Its own title and description, so a link shared on WhatsApp or Facebook
 * previews the event rather than the site. Goes through the SAME getter as
 * the page, so a draft's title never reaches a <title> either.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const event = await getPublishedEvent(slug);
  if (!event) return {};
  const card = cardFor(event, Date.now());
  // A cancelled event's preview leads with "Cancelado": link previews ignore
  // the JSON-LD eventStatus, so this is the only place they can learn it.
  const share = buildEventShareText(card, event.description, copy.cancelledBadge);
  return {
    title: share.title,
    description: share.description,
    alternates: { canonical: card.href },
    openGraph: eventsOpenGraph({ locale: SHELTER.locale, ...share, url: card.href }),
  };
}

/**
 * One event. The single `.btn--action` on the screen is its WhatsApp button,
 * and it is absent when the event is over or cancelled — nobody should be
 * invited to ask about either.
 */
export default async function EventPage({ params }: Props) {
  const { slug } = await params;
  const event = await getPublishedEvent(slug);
  // A draft and a missing id are the same 404: getPublishedEvent answers null
  // for both, because the Admin SDK would have returned the draft.
  if (!event) notFound();

  const now = Date.now();
  const card = cardFor(event, now);
  const days = eventDays(event, SHELTER.timeZone, SHELTER.locale, now);
  const paragraphs = descriptionParagraphs(event.description);
  const jsonLd = serializeJsonLd(buildEventJsonLd(event, SHELTER));

  return (
    <article className="event-page">
      <div className="container event-page__body">
        <p className="event-page__back">
          <Link href="/events">{copy.backToEvents}</Link>
        </p>

        <h1 className="t-title event-page__title">{event.title}</h1>

        {card.cancelled && (
          <p className="event-page__notice event-page__notice--cancelled" role="status">
            {copy.cancelledNotice}
          </p>
        )}
        {!card.cancelled && card.past && (
          <p className="event-page__notice" role="status">
            {copy.pastNotice(days.first, days.last)}
          </p>
        )}

        <dl className="event-page__facts">
          <div>
            <dt className="t-label">{copy.whenLabel}</dt>
            <dd>{card.when}</dd>
          </div>
          <div>
            <dt className="t-label">{copy.placeLabel}</dt>
            <dd>
              {card.place}{' '}
              <a href={card.mapsUrl} target="_blank" rel="noopener noreferrer" className="event-card__map">
                {copy.mapLink}
              </a>
            </dd>
          </div>
        </dl>

        {/* Plain text: each paragraph and line is a text node React escapes.
            Never dangerouslySetInnerHTML for what an admin typed. */}
        {paragraphs.length > 0 && (
          <div className="event-page__description">
            {paragraphs.map((lines, i) => (
              <p key={i}>
                {lines.map((line, j) => (
                  <span key={j}>
                    {j > 0 && <br />}
                    {line}
                  </span>
                ))}
              </p>
            ))}
          </div>
        )}

        {card.whatsappUrl && (
          <a
            href={card.whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn--action event-page__cta"
          >
            {copy.askOnWhatsapp}
          </a>
        )}
      </div>

      {/* schema.org Event. The ONLY dangerouslySetInnerHTML on the page, and
          its content comes from serializeJsonLd, which escapes every "<" so a
          title typed as "</script>" cannot close this tag. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
    </article>
  );
}
