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
      {label}
    </Link>
  );
}
