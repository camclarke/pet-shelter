import Link from 'next/link';
import { Marca } from './Marca';
import { TemaToggle } from './TemaToggle';

const NAV = [
  { href: '/adopta', label: 'Adopta' },
  { href: '/perdidos', label: 'Perdidos' },
  { href: '/ayuda', label: 'Ayuda' },
  { href: '/nosotros', label: 'Nosotros' },
];

const FRASES = ['De la calle, a tu corazón', 'Adopta, no compres'];

export function Header() {
  return (
    <header className="cabecera">
      <div className="env cabecera__fila">
        <Link href="/" className="cabecera__marca">
          <Marca size={40} color="var(--jade)" title="Wawitas Red de Apoyo" />
          <span className="cabecera__nombre">
            Wawitas
            <small>Red de Apoyo</small>
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
  const tira = Array.from({ length: 8 }).flatMap((_, i) => [
    <span key={`${i}-a`}>{FRASES[0]}</span>,
    <span key={`${i}-dot1`}>·</span>,
    <span key={`${i}-b`}>{FRASES[1]}</span>,
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
          <p className="pie__lema">De la calle, a tu corazón.</p>
        </div>
        <div className="pie__datos">
          <a href="https://wa.me/59177903553">WhatsApp 77903553</a>
          <a href="https://www.instagram.com/wawitas_2025/">@wawitas_2025</a>
          <a href="https://www.facebook.com/profile.php?id=61563998952145">Facebook</a>
          <span>Cochabamba, Bolivia</span>
        </div>
      </div>
    </footer>
  );
}
