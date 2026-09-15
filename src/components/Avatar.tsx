/**
 * A person's profile photo, or their initials when there is none.
 *
 * Every URL goes through `safeAvatarUrl` first — a Google account photo or the
 * person's own upload, nothing else — so an arbitrary address stored in a
 * profile can never make an admin's browser fetch it. See `profile.ts`.
 *
 * A plain `<img>`, not `next/image`: the image optimizer would proxy Google's
 * photo host through Cloud Run for a 22px circle, and `next.config.ts` allows
 * only Firebase Storage there on purpose. `referrerPolicy="no-referrer"` because
 * Google's photo host refuses some requests that carry a Referer.
 *
 * The initials are decorative (`aria-hidden`): every place this renders puts
 * the person's name or email beside it as text.
 */

'use client';

import { useState } from 'react';
import { initialsFor, safeAvatarUrl } from '@/lib/profile';

interface AvatarProps {
  uid: string;
  url: string | null | undefined;
  /** The name or email the initials come from. */
  label: string | null | undefined;
  size: number;
  className?: string;
}

export function Avatar({ uid, url, label, size, className }: AvatarProps) {
  const safe = safeAvatarUrl(url, uid);
  // Keyed by URL, so a new photo after a failed one is tried again.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const classes = ['avatar', className].filter(Boolean).join(' ');
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.4)) };

  if (safe && failedUrl !== safe) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        className={classes}
        src={safe}
        alt=""
        width={size}
        height={size}
        referrerPolicy="no-referrer"
        decoding="async"
        onError={() => setFailedUrl(safe)}
        style={style}
      />
    );
  }

  return (
    <span className={`${classes} avatar--initials`} aria-hidden="true" style={style}>
      {initialsFor(label) || '·'}
    </span>
  );
}
