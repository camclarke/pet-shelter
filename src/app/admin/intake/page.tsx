import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AdminGate } from '@/components/AdminGate';
import { IntakeWizard } from './IntakeWizard';

export const metadata: Metadata = {
  title: 'Nuevo ingreso',
  robots: { index: false, follow: false },
};

/**
 * ⚠️ Required, even though this page fetches nothing. See the same note on
 * `/account`: a fully-static App Router page sends
 * `Cache-Control: s-maxage=31536000`, and Firebase Hosting has no idea the
 * Cloud Run revision behind its rewrite changed — so a deploy does not purge
 * it and the page stays frozen for a YEAR. Four routes sat in exactly that
 * state until PR #7. "It has no data" is precisely the reasoning that left
 * them there.
 *
 * Caching the shell is harmless: everything on this page loads client-side
 * after the admin claim is checked, so there is nothing private in the HTML.
 */
export const revalidate = 300;

/**
 * `useSearchParams` (the `?draft=` resume link) forces a Suspense boundary at
 * build time — without it Next refuses to prerender the page at all. The
 * fallback is deliberately the same "opening" wording the wizard uses for its
 * own load state, so a resume never flashes two different messages.
 */
export default function IntakePage() {
  return (
    <div className="container" style={{ paddingBlock: 'var(--space-5)' }}>
      <AdminGate>
        <Suspense
          fallback={
            <div className="admin-gate" aria-busy="true">
              <p className="admin-gate__note">Abriendo la ficha…</p>
            </div>
          }
        >
          <IntakeWizard />
        </Suspense>
      </AdminGate>
    </div>
  );
}
