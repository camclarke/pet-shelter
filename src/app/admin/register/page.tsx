import type { Metadata } from 'next';
import { AdminGate } from '@/components/AdminGate';
import { RegisterRoster } from './RegisterRoster';

export const metadata: Metadata = {
  title: 'En el refugio',
  robots: { index: false, follow: false },
};

/**
 * ⚠️ Required, even though this page fetches nothing itself — the same note
 * `/admin/areas` and `/admin/intake` carry. A fully-static App Router page
 * sends `Cache-Control: s-maxage=31536000`, Firebase Hosting cannot know the
 * Cloud Run revision behind its rewrite changed, and the shell stays frozen
 * for a YEAR. Four routes sat in exactly that state until PR #7, and "it has
 * no data" is precisely the reasoning that left them there.
 *
 * Caching the shell is harmless: every register row loads client-side after
 * the admin claim is checked, so nothing about the shelter's animals — and
 * nothing about the ones that died — is in the HTML this caches.
 */
export const revalidate = 300;

export default function RegisterPage() {
  return (
    <div className="container" style={{ paddingBlock: 'var(--space-5)' }}>
      <AdminGate>
        <RegisterRoster />
      </AdminGate>
    </div>
  );
}
