import type { Metadata } from 'next';
import { AdminGate } from '@/components/AdminGate';
import { EventsPanel } from './EventsPanel';

export const metadata: Metadata = {
  title: 'Eventos',
  robots: { index: false, follow: false },
};

/**
 * ⚠️ Required, even though this page fetches nothing itself — the same note as
 * `/admin/areas`. A fully-static App Router page sends
 * `Cache-Control: s-maxage=31536000`, Firebase Hosting cannot know the Cloud
 * Run revision behind its rewrite changed, and the shell would stay frozen for
 * a YEAR (the PR #7 defect).
 *
 * Caching the shell is harmless: every event, drafts included, loads
 * client-side after the admin claim is checked, so nothing is in this HTML.
 */
export const revalidate = 300;

export default function EventsAdminPage() {
  return (
    <div className="container" style={{ paddingBlock: 'var(--space-5)' }}>
      <AdminGate section="events">
        <EventsPanel />
      </AdminGate>
    </div>
  );
}
