import Link from 'next/link';
import { AdoptionWall } from '@/components/AdoptionWall';
import { UpcomingEvents } from '@/components/UpcomingEvents';
import { SHELTER } from '@/config/shelter';

/**
 * REQUIRED — do not remove.
 *
 * This page renders <AdoptionWall>, which reads Firestore. The Docker/CI build
 * has no Firestore access (deliberately), so a prerendered page bakes the
 * wall's ERROR state ("No pudimos cargar los animalitos") into static HTML —
 * measured in the CI deploy log, 2026-10-21. A `revalidate` does not help: the
 * first HTML served is still the baked one.
 *
 * So the page renders per request, and `next.config.ts` gives it a 5-minute
 * CDN cache (`s-maxage=300`), which bounds the Firestore reads to about one
 * refresh per edge per five minutes whatever the traffic. A test pins both.
 */
export const dynamic = 'force-dynamic';

/**
 * How adoption works, in four steps. Visitor-facing copy, kept beside the
 * markup that renders it — see the note in `src/i18n/messages.ts` on where
 * page-level copy goes when a second locale arrives.
 */
const ADOPTION_STEPS = [
  {
    number: '01',
    title: 'Encuéntralo',
    description:
      'Mira el muro. Cada animalito tiene su historia, su edad y su carácter. Alguno te va a mirar distinto.',
  },
  {
    number: '02',
    title: 'Escríbenos',
    description:
      'Un mensaje de WhatsApp con su nombre. Te contamos todo lo que sabemos de él, sin adornos.',
  },
  {
    number: '03',
    title: 'Conócelo',
    description:
      'Se coordina un encuentro en un punto seguro. Sin compromiso: queremos que estén seguros los dos.',
  },
  {
    number: '04',
    title: 'Llévalo a casa',
    description:
      'Se va identificado con microchip, con su historial médico y su plan de alimentación. No desaparecemos después.',
  },
];

export default function HomePage() {
  const [taglineHead, taglineTail] = SHELTER.tagline.split(',');

  return (
    <>
      <section className="hero">
        <div className="container">
          <p className="hero__intro">
            Refugio transitorio · {SHELTER.city}, {SHELTER.country}
          </p>
          <h1 className="hero__tagline">
            {taglineHead},
            <br />
            <b>{taglineTail?.trim()}</b>
          </h1>
          <p className="hero__text">{SHELTER.mission}</p>
          <div className="hero__actions">
            <Link href="/adopt" className="btn btn--action">
              Conoce a los animalitos ↓
            </Link>
            <Link href="/help" className="btn btn--muted">
              Quiero ayudar
            </Link>
          </div>
        </div>
      </section>

      <AdoptionWall limit={8} title="Están esperando una familia." />

      <div className="container">
        <Link href="/adopt" className="btn btn--brand view-all">
          Ver todos los animalitos
        </Link>
      </div>

      {/* Renders nothing unless a published event is upcoming, and nothing if
          the events query fails — the wall above never depends on it. */}
      <UpcomingEvents limit={3} />

      <section className="steps">
        <div className="container">
          <h2 className="t-title steps__title">
            Adoptar no solo cambia una vida: transforma dos.
          </h2>
          <ol className="steps__list">
            {ADOPTION_STEPS.map((step) => (
              <li key={step.number} className="step">
                <span className="step__number">{step.number}</span>
                <h3 className="step__title">{step.title}</h3>
                <p className="step__description">{step.description}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="quote-section">
        <div className="container">
          <blockquote className="t-quote quote">
            Detrás de cada mirada hay una historia de abandono, de sufrimiento y supervivencia —
            pero también una enorme capacidad de volver a confiar.
          </blockquote>
        </div>
      </section>
    </>
  );
}
