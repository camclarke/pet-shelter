import type { Metadata } from 'next';
import './globals.css';
import { Header, Ticker, Footer } from '@/components/SiteChrome';
import { AuthProvider } from '@/components/AuthProvider';
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
// The `theme` key and its light/dark values are shared with ThemeToggle.tsx
// and globals.css; all three must agree.
const THEME_SCRIPT = `(() => {
  const stored = localStorage.getItem('theme');
  if (stored) document.documentElement.dataset.theme = stored;
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
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <a href="#main" className="skip-link">
          Saltar al contenido
        </a>
        {/* Wraps everything, but costs the first paint nothing: AuthProvider
            imports the Firebase SDK dynamically, after hydration. `children`
            stays server-rendered — a Client Component parent does not force
            its slotted children to become client. */}
        <AuthProvider>
          <Header />
          <Ticker />
          <main id="main">{children}</main>
          <Footer />
        </AuthProvider>
      </body>
    </html>
  );
}
