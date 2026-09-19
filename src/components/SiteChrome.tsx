import Link from 'next/link';
import { Brand } from './Brand';
import { Wordmark } from './Wordmark';
import { ThemeToggle } from './ThemeToggle';
import { AccountLink } from './AccountLink';
import { SHELTER } from '@/config/shelter';

/**
 * Routes are English; their labels are not. `href` is a code identifier and
 * `label` is content — the two travel together here only because a nav item is
 * the one place they are the same object.
 */
const NAV = [
  { href: '/adopt', label: 'Adopta' },
  { href: '/lost', label: 'Perdidos' },
  { href: '/help', label: 'Ayuda' },
  { href: '/about', label: 'Nosotros' },
];

export function Header() {
  const [first, ...rest] = SHELTER.name.split(' ');

  return (
    <header className="header">
      <div className="container header__row">
        {/* The drawn logotype stands alone. Hanging "Red de Apoyo" beneath it
            was the type-set treatment's way of carrying a word the artwork
            does not, and the shelter's own lockup does not carry it either.
            The link keeps the full registered name, so a screen reader and a
            crawler still get it — which is also why neither child needs a
            `title`: repeating it inside would only stutter.
            A fork with no lettering falls back to the two-line setting that
            layout was built for. */}
        <Link href="/" className="header__brand" aria-label={SHELTER.name}>
          <Brand size={40} />
          {SHELTER.hasWordmark ? (
            <Wordmark size={132} className="header__wordmark" />
          ) : (
            <span className="header__name">
              {first}
              {rest.length > 0 && <small>{rest.join(' ')}</small>}
            </span>
          )}
        </Link>

        <nav className="header__nav" aria-label="Principal">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="header__actions">
          <ThemeToggle />
          <AccountLink />
        </div>
      </div>
    </header>
  );
}

/** The scrolling marquee under the header. Decorative, hidden from a11y. */
export function Ticker() {
  const phrases = [SHELTER.tagline, 'Adopta, no compres'];

  const strip = Array.from({ length: 8 }).flatMap((_, i) => [
    <span key={`${i}-a`}>{phrases[0]}</span>,
    <span key={`${i}-dot1`}>·</span>,
    <span key={`${i}-b`}>{phrases[1]}</span>,
    <span key={`${i}-dot2`}>·</span>,
  ]);

  return (
    <div className="ticker" aria-hidden="true">
      <div className="ticker__track">{strip}</div>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="container site-footer__row">
        <div>
          {/* The footer had the mark but never the name. Composed from the two
              components rather than shipping the fused lockup as a third copy
              of the same contours — same picture, one colour to set, and the
              wordmark can drop out for a fork that has no lettering. */}
          {/* Whichever of the two carries the name is the one that gets a
              `title`; the other is decorative. The logotype's accessible name
              is the word it draws, not the registered name — alt text for an
              image of text is that text. */}
          <span className="site-footer__lockup">
            <Brand size={54} title={SHELTER.hasWordmark ? undefined : SHELTER.name} />
            {SHELTER.hasWordmark && <Wordmark size={116} title={SHELTER.shortName} />}
          </span>
          <p className="site-footer__tagline">{SHELTER.tagline}</p>
        </div>
        <div className="site-footer__data">
          <a href={`https://wa.me/${SHELTER.whatsapp}`}>WhatsApp {SHELTER.whatsappDisplay}</a>
          {SHELTER.instagram && <a href={SHELTER.instagram}>Instagram</a>}
          {SHELTER.facebook && <a href={SHELTER.facebook}>Facebook</a>}
          <Link href="/privacy">Privacidad</Link>
          <span>
            {SHELTER.city}, {SHELTER.country}
          </span>
        </div>
      </div>
    </footer>
  );
}
