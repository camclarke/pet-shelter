import type { Metadata } from 'next';
import { AccountPanel } from './AccountPanel';

export const metadata: Metadata = {
  title: 'Mi cuenta',
  robots: { index: false },
};

/**
 * ⚠️ Required, even though this page fetches nothing.
 *
 * A fully-static App Router page makes Next send
 * `Cache-Control: s-maxage=31536000` — one YEAR. On Vercel that is safe,
 * because a deployment purges the edge. Firebase Hosting has no idea the
 * Cloud Run revision behind its rewrite changed, so it keeps serving the old
 * HTML for a year and a deploy does not invalidate it. That is not a theory:
 * on 2026-08-23 `/account` shipped, CD went green, the running image matched
 * HEAD exactly, and production still served the previous placeholder from
 * `X-Cache: HIT` while `/account?cb=1` returned the new page from the origin.
 *
 * `revalidate` replaces that with `s-maxage=300, stale-while-revalidate`, the
 * same header `/` and `/adopt` already carry — which is precisely why those
 * two self-healed after past deploys and these pages would not have.
 */
export const revalidate = 300;

/**
 * Server shell. The metadata stays here — a Client Component cannot export it —
 * and everything that needs Firebase lives in `AccountPanel`.
 *
 * `robots: { index: false }` is deliberate: a sign-in form competing in search
 * results with "adoptar perro Cochabamba" would work against the one thing
 * this site is for.
 */
export default function AccountPage() {
  return (
    <div className="container" style={{ paddingBlock: 'var(--space-5)' }}>
      <AccountPanel />
    </div>
  );
}
