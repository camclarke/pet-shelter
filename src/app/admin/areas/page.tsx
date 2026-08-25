import type { Metadata } from 'next';
import { AdminGate } from '@/components/AdminGate';
import { AreasPanel } from './AreasPanel';

export const metadata: Metadata = {
  title: 'Áreas del refugio',
  robots: { index: false, follow: false },
};

/**
 * ⚠️ Required, even though this page fetches nothing itself — see the same
 * note on `/admin/intake`. A fully-static App Router page sends
 * `Cache-Control: s-maxage=31536000`, Firebase Hosting cannot know the Cloud
 * Run revision behind its rewrite changed, and the shell stays frozen for a
 * YEAR. Four routes sat in exactly that state until PR #7, and "it has no
 * data" is precisely the reasoning that left them there.
 *
 * Caching the shell is harmless: the areas, the occupancy and every animal's
 * name load client-side after the admin claim is checked, so nothing about
 * the facility is in the HTML this caches.
 */
export const revalidate = 300;

export default function AreasPage() {
  return (
    <div className="container" style={{ paddingBlock: 'var(--space-5)' }}>
      <AdminGate>
        <AreasPanel />
      </AdminGate>
    </div>
  );
}
