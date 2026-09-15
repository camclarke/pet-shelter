/**
 * The header's account button.
 *
 * A Client Component only so the label can reflect whether someone is signed
 * in. It renders the signed-out label during `loading`, which is correct here
 * and would not be elsewhere: the destination is the same either way, so the
 * worst case is a label that sharpens a moment after hydration rather than a
 * link that sends someone to the wrong place.
 *
 * Signed in, it shows the person's first name (else the local part of their
 * email) and their photo when they have one. The photo is 22px and the button
 * is capped at 42vw on a phone, so the name still ellipsises rather than
 * pushing the theme toggle off the row.
 *
 * ⚠️ "Mi cuenta" stays a literal here instead of `t.account.title`. This
 * component is in the root layout, so importing `@/i18n` would put the whole
 * Spanish catalogue into the homepage's client bundle — the page read on
 * mobile data in Cochabamba — for two words.
 */

'use client';

import Link from 'next/link';
import { useAuth } from './AuthProvider';
import { Avatar } from './Avatar';
import { accountLabel, safeAvatarUrl } from '@/lib/profile';

export function AccountLink() {
  const { user, loading } = useAuth();
  const signedIn = !loading && user ? user : null;

  const label = (signedIn && accountLabel(signedIn)) || 'Mi cuenta';
  const photo = signedIn ? safeAvatarUrl(signedIn.photoURL, signedIn.uid) : null;

  return (
    <Link href="/account" className="btn btn--muted header__account" title={signedIn?.email ?? undefined}>
      {signedIn && photo && (
        <Avatar uid={signedIn.uid} url={photo} label={label} size={22} className="header__avatar" />
      )}
      {/* The label lives in its own span because .btn is display:inline-flex,
          and text-overflow:ellipsis does NOT apply to a flex container's own
          text — it needs a block box. Without the span an email local part is
          hard-clipped mid-word with no "…", which is what a real phone showed
          on 2026-08-30 ("ISRAEL.ROCHA.ROCH"). */}
      <span className="header__account-label">{label}</span>
    </Link>
  );
}
