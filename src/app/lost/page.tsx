import type { Metadata } from 'next';
import { SHELTER } from '@/config/shelter';

export const metadata: Metadata = {
  title: 'Perdidos',
  description: `Reporta o consulta avistamientos de animalitos perdidos en ${SHELTER.city}.`,
};

/**
 * ⚠️ Required, even though this page fetches nothing.
 *
 * A fully-static App Router page makes Next send
 * `Cache-Control: s-maxage=31536000` — one YEAR. On Vercel that is safe,
 * because a deployment purges the edge. Firebase Hosting has no idea the
 * Cloud Run revision behind its rewrite changed, so it keeps serving the old
 * HTML for a year and a deploy does not invalidate it. That is not a theory:
 * on 2026-08-23 `/account` shipped, CD went green, the running image matched
 * HEAD exactly, and production still served the previous placeholder from
 * `X-Cache: HIT` while `/account?cb=1` returned the new page from the origin.
 *
 * `revalidate` replaces that with `s-maxage=300, stale-while-revalidate`, the
 * same header `/` and `/adopt` already carry — which is precisely why those
 * two self-healed after past deploys and these pages would not have.
 */
export const revalidate = 300;

export default function LostPage() {
  return (
    <div className="container" style={{ paddingBlock: 'var(--space-5)' }}>
      <h1 className="t-title">Perdidos</h1>
      <p style={{ marginTop: 'var(--space-2)', maxWidth: '60ch', opacity: 0.8 }}>
        El reporte público de avistamientos está en construcción. Mientras tanto, escríbenos por{' '}
        <a href={`https://wa.me/${SHELTER.whatsapp}`}>WhatsApp</a> si viste a un animalito perdido.
      </p>
      <p style={{ marginTop: 'var(--space-3)', maxWidth: '60ch', opacity: 0.8 }}>
        Si encontraste un animalito, llévalo a cualquier veterinaria y pide que lo escaneen: si
        tiene microchip, su número nos lleva directo a su familia.
      </p>
    </div>
  );
}
