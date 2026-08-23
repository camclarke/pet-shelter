import type { Metadata } from 'next';
import { AdminGate } from '@/components/AdminGate';
import { AdminDashboard } from './AdminDashboard';

export const metadata: Metadata = {
  title: 'Panel del refugio',
  robots: { index: false, follow: false },
};

/**
 * ⚠️ Required, even though this page fetches nothing — see `/account` and
 * `/admin/intake`. Without it Next sends a one-YEAR `s-maxage` and Firebase
 * Hosting serves this shell frozen until someone notices.
 */
export const revalidate = 300;

export default function AdminPage() {
  return (
    <div className="container" style={{ paddingBlock: 'var(--space-5)' }}>
      <AdminGate>
        <AdminDashboard />
      </AdminGate>
    </div>
  );
}
