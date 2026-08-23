import Link from 'next/link';
import { Brand } from './Brand';
import { ThemeToggle } from './ThemeToggle';
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
        <Link href="/" className="header__brand">
          <Brand size={40} color="var(--jade)" title={SHELTER.name} />
          <span className="header__name">
            {first}
            {rest.length > 0 && <small>{rest.join(' ')}</small>}
          </span>
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
          <Link href="/account" className="btn btn--muted header__account">
            Mi cuenta
          </Link>
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
          <Brand size={54} color="var(--jade)" />
          <p className="site-footer__tagline">{SHELTER.tagline}</p>
        </div>
        <div className="site-footer__data">
          <a href={`https://wa.me/${SHELTER.whatsapp}`}>WhatsApp {SHELTER.whatsappDisplay}</a>
          {SHELTER.instagram && <a href={SHELTER.instagram}>Instagram</a>}
          {SHELTER.facebook && <a href={SHELTER.facebook}>Facebook</a>}
          <span>
            {SHELTER.city}, {SHELTER.country}
          </span>
        </div>
      </div>
    </footer>
  );
}
