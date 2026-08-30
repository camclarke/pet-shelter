/**
 * The header's account button.
 *
 * A Client Component only so the label can reflect whether someone is signed
 * in. It renders the signed-out label during `loading`, which is correct here
 * and would not be elsewhere: the destination is the same either way, so the
 * worst case is a label that sharpens a moment after hydration rather than a
 * link that sends someone to the wrong place.
 */

'use client';

import Link from 'next/link';
import { useAuth } from './AuthProvider';

export function AccountLink() {
  const { user, loading } = useAuth();

  // The local part of the address is the most human thing we have — there is
  // no displayName on an email/password account until a profile UI exists.
  const label = !loading && user ? (user.email?.split('@')[0] ?? 'Mi cuenta') : 'Mi cuenta';

  return (
    <Link href="/account" className="btn btn--muted header__account" title={user?.email ?? undefined}>
      {/* The label lives in its own span because .btn is display:inline-flex,
          and text-overflow:ellipsis does NOT apply to a flex container's own
          text — it needs a block box. Without the span an email local part is
          hard-clipped mid-word with no "…", which is what a real phone showed
          on 2026-08-30 ("ISRAEL.ROCHA.ROCH"). */}
      <span className="header__account-label">{label}</span>
    </Link>
  );
}
