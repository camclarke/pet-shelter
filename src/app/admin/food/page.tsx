import type { Metadata } from 'next';
import { AdminGate } from '@/components/AdminGate';
import { t } from '@/i18n';
import { FoodPanel } from './FoodPanel';

export const metadata: Metadata = {
  title: t.food.title,
  robots: { index: false, follow: false },
};

/**
 * ⚠️ Required, even though this page fetches nothing itself — see `/admin/areas`.
 * A fully-static App Router page sends `s-maxage=31536000`, and Firebase
 * Hosting would serve this shell frozen for a year. Caching the shell is
 * harmless: every donation, stock figure and weight loads client-side after
 * the admin claim is checked.
 */
export const revalidate = 300;

export default function FoodPage() {
  return (
    <div className="container" style={{ paddingBlock: 'var(--space-5)' }}>
      <AdminGate>
        <FoodPanel />
      </AdminGate>
    </div>
  );
}
