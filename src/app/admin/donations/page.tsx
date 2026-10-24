import type { Metadata } from 'next';
import { AdminGate } from '@/components/AdminGate';

export const metadata: Metadata = {
  title: 'Donaciones',
  robots: { index: false, follow: false },
};

/**
 * ⚠️ Required, even though this page fetches nothing itself — see `/admin/areas`.
 * A fully-static App Router page sends `s-maxage=31536000`, and Firebase
 * Hosting would serve this shell frozen for a year. Caching the shell is
 * harmless: the details, proposals and history load client-side after the
 * role is checked, and the rules let only Tesorería and the superuser read
 * the proposals and the history.
 *
 * PLACEHOLDER BODY: the donations screen replaces it. The section gate stays.
 */
export const revalidate = 300;

export default function DonationsPage() {
  return (
    <div className="container" style={{ paddingBlock: 'var(--space-5)' }}>
      <AdminGate section="donations">
        <p>Datos para donaciones: pantalla en preparación.</p>
      </AdminGate>
    </div>
  );
}
