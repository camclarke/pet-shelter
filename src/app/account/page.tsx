import type { Metadata } from 'next';
import { AccountPanel } from './AccountPanel';

export const metadata: Metadata = {
  title: 'Mi cuenta',
  robots: { index: false },
};

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
