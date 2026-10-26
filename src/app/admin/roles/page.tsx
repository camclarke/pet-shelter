import type { Metadata } from 'next';
import { AdminGate } from '@/components/AdminGate';

export const metadata: Metadata = {
  title: 'Roles del equipo',
  robots: { index: false, follow: false },
};

/**
 * ⚠️ Required, even though this page fetches nothing itself — see `/admin/areas`.
 * A fully-static App Router page sends `s-maxage=31536000`, and Firebase
 * Hosting would serve this shell frozen for a year.
 *
 * PLACEHOLDER: the backend half of PR-3 (plan §12) ships the routes; the
 * screen (`RolesPanel`) replaces this body.
 */
export const revalidate = 300;

export default function RolesPage() {
  return (
    <div className="container" style={{ paddingBlock: 'var(--space-5)' }}>
      <AdminGate section="roles">
        <p>La pantalla de roles del equipo estará disponible muy pronto.</p>
      </AdminGate>
    </div>
  );
}
