import Link from 'next/link';
import { Marca } from './Marca';
import { TemaToggle } from './TemaToggle';
import { SHELTER } from '@/config/shelter';

const NAV = [
  { href: '/adopta', label: 'Adopta' },
  { href: '/perdidos', label: 'Perdidos' },
  { href: '/ayuda', label: 'Ayuda' },
  { href: '/nosotros', label: 'Nosotros' },
];

export function Header() {
  const [first, ...rest] = SHELTER.name.split(' ');

  return (
    <header className="cabecera">
      <div className="env cabecera__fila">
        <Link href="/" className="cabecera__marca">
          <Marca size={40} color="var(--jade)" title={SHELTER.name} />
          <span className="cabecera__nombre">
            {first}
            {rest.length > 0 && <small>{rest.join(' ')}</small>}
          </span>
        </Link>

        <nav className="cabecera__nav" aria-label="Principal">
          {NAV.map((i) => (
            <Link key={i.href} href={i.href}>
              {i.label}
            </Link>
          ))}
        </nav>

        <div className="cabecera__acciones">
          <TemaToggle />
          <Link href="/cuenta" className="btn btn--tenue cabecera__cuenta">
            Mi cuenta
          </Link>
        </div>
      </div>
    </header>
  );
}

export function Cinta() {
  const frases = [SHELTER.tagline, 'Adopta, no compres'];

  const tira = Array.from({ length: 8 }).flatMap((_, i) => [
    <span key={`${i}-a`}>{frases[0]}</span>,
    <span key={`${i}-dot1`}>·</span>,
    <span key={`${i}-b`}>{frases[1]}</span>,
    <span key={`${i}-dot2`}>·</span>,
  ]);

  return (
    <div className="cinta" aria-hidden="true">
      <div className="cinta__pista">{tira}</div>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="pie">
      <div className="env pie__fila">
        <div>
          <Marca size={54} color="var(--jade)" />
          <p className="pie__lema">{SHELTER.tagline}</p>
        </div>
        <div className="pie__datos">
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
