import type { Metadata } from 'next';
import { AdminGate } from '@/components/AdminGate';
import { RolesPanel } from './RolesPanel';

export const metadata: Metadata = {
  title: 'Roles del equipo',
  robots: { index: false, follow: false },
};

/**
 * ⚠️ Required, even though this page fetches nothing itself — see `/admin/areas`.
 * A fully-static App Router page sends `s-maxage=31536000`, and Firebase
 * Hosting would serve this shell frozen for a year. Caching the shell is
 * harmless: the staff list and the audit load client-side after the role is
 * checked.
 */
export const revalidate = 300;

export default function RolesPage() {
  return (
    <div className="container" style={{ paddingBlock: 'var(--space-5)' }}>
      <AdminGate section="roles">
        <RolesPanel />
      </AdminGate>
    </div>
  );
}
