'use client';

import { useEffect, useState } from 'react';
import { readPhotoObjectUrl } from '@/lib/pets-admin';
import type { DraftMedia } from '@/lib/intake';

/**
 * An intake photo, rendered whichever tier it is stored at.
 *
 * A public photo carries a `url` and renders straight from it. A never-public
 * one (teeth, genitals) deliberately has NO url, because minting one would mint
 * a Firebase download token — and a token bypasses `storage.rules` outright,
 * measured 2026-09-03: 200 with `?token=`, 403 without, on the same admin-only
 * object. So those bytes are pulled through the Storage SDK, which sends the
 * signed-in admin's ID token and is therefore subject to the rules.
 *
 * ⚠️ The object URL is revoked on unmount and whenever the photo changes.
 * Intake runs on a phone, and four full-size JPEGs held by leaked object URLs
 * is the kind of thing that survives as "the browser got slow after a while".
 *
 * Deliberately NOT next/image: these are blob: URLs for the private tier, which
 * the optimiser cannot fetch, and the two would disagree about which photos
 * work. One code path for both tiers is worth more here than the optimiser.
 */
export function PetPhoto({
  media,
  alt,
}: {
  media: Pick<DraftMedia, 'path' | 'url'>;
  alt: string;
}) {
  const [src, setSrc] = useState(media.url);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let created = '';

    setFailed(false);

    if (media.url) {
      setSrc(media.url);
      return () => {
        cancelled = true;
      };
    }

    setSrc('');
    readPhotoObjectUrl(media)
      .then((url) => {
        // The effect can be torn down mid-flight — a slot rephotographed
        // quickly, or the wizard reset. Revoking here rather than leaking is
        // the whole reason this is not a bare `setSrc` in a `.then`.
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        created = url;
        setSrc(url);
      })
      .catch((error) => {
        console.error('[PetPhoto] could not read %s', media.path, error);
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [media, media.url, media.path]);

  if (failed) {
    return (
      <span className="admin-photo__failed" role="img" aria-label={alt}>
        No se pudo cargar
      </span>
    );
  }

  // eslint-disable-next-line @next/next/no-img-element
  return src ? <img src={src} alt={alt} /> : <span className="admin-photo__loading" aria-hidden="true" />;
}
