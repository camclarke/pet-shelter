import type { Metadata } from 'next';
import { AdminGate } from '@/components/AdminGate';
import { t } from '@/i18n';
import { ApplicationsQueue } from './ApplicationsQueue';

export const metadata: Metadata = {
  title: t.applications.queueTitle,
  robots: { index: false, follow: false },
};

/**
 * ⚠️ Required, even though this page fetches nothing itself — the same note as
 * `/admin/areas`. A fully-static App Router page sends `s-maxage=31536000`,
 * Firebase Hosting cannot tell the Cloud Run revision behind it changed, and
 * the shell would stay frozen for a YEAR.
 *
 * Caching the shell is harmless: every application loads client-side, after
 * the admin claim is checked and under `firestore.rules`, so nobody's
 * application is ever in the HTML this caches.
 */
export const revalidate = 300;

export default function ApplicationsPage() {
  return (
    <div className="container" style={{ paddingBlock: 'var(--space-5)' }}>
      <AdminGate>
        <ApplicationsQueue />
      </AdminGate>
    </div>
  );
}
