import type { Metadata } from 'next';
import { t } from '@/i18n';
import { ActionHandler } from './ActionHandler';

export const metadata: Metadata = {
  title: t.account.actionTitle,
  robots: { index: false },
  // The URL carries a one-time code. `no-referrer` keeps it out of the Referer
  // of anything this page links to or loads — the WhatsApp link, Google's
  // policy pages — before the handler strips it from the address bar.
  referrer: 'no-referrer',
};

/**
 * ⚠️ Required, like every static page here: without it Next sends
 * `s-maxage=31536000` and Firebase Hosting keeps the old HTML for a year after
 * a deploy (the 2026-08-23 `/account` incident). The shell holds no code — the
 * handler reads it in the browser — so a cached shell is safe to share.
 */
export const revalidate = 300;

/**
 * `/account/action` — where every account email links to.
 *
 * `scripts/auth-config.mjs` sets this as Identity Platform's action URL. Until
 * then emails still link to Firebase's own page on wawitas.firebaseapp.com,
 * and this page simply goes unvisited. Deploy it BEFORE running that script.
 */
export default function AccountActionPage() {
  return (
    <div className="container" style={{ paddingBlock: 'var(--space-5)' }}>
      <ActionHandler />
    </div>
  );
}
