import type { Metadata } from 'next';
import './globals.css';
import { Header, Cinta, Footer } from '@/components/SiteChrome';
import { SHELTER } from '@/config/shelter';

export const metadata: Metadata = {
  metadataBase: new URL(SHELTER.siteUrl),
  title: {
    default: SHELTER.name,
    template: `%s · ${SHELTER.name}`,
  },
  description: SHELTER.mission,
  openGraph: {
    type: 'website',
    locale: SHELTER.locale.replace('-', '_'),
  },
  twitter: {
    card: 'summary_large_image',
  },
};

// Resolve the theme before first paint so a night visitor never sees a flash
// of cream. Inlined deliberately — a stylesheet round trip would defeat it.
const TEMA_SCRIPT = `(() => {
  const guardado = localStorage.getItem('tema');
  if (guardado) document.documentElement.dataset.tema = guardado;
})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang={SHELTER.locale.split('-')[0]}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght,SOFT,WONK@0,9..144,300..900,0..100,0..1;1,9..144,300..900,0..100,0..1&family=Instrument+Sans:ital,wght@0,400..700;1,400..700&display=swap"
        />
        <script dangerouslySetInnerHTML={{ __html: TEMA_SCRIPT }} />
      </head>
      <body>
        <a href="#principal" className="saltar">
          Saltar al contenido
        </a>
        <Header />
        <Cinta />
        <main id="principal">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
