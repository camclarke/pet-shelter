import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';

import { SHELTER } from '@/config/shelter';
import { t } from '@/i18n';
import { resolveQrTag } from '@/lib/pets-server';
import { formatQrToken } from '@/lib/qr-tokens';
import { ActiveTag } from './ActiveTag';
import { TagFallback } from './TagFallback';

/**
 * Where a scanned collar tag lands. Build-order step 12, plan §7.
 *
 * A stranger has an animal in front of them. This page turns that into the
 * animal's name and one WhatsApp message to the shelter, with no account. It
 * never shows the microchip number, an address, or anything from a tier behind
 * a login — `resolveQrTag` reads two public documents, and `toPublicTagPet`
 * allowlists what reaches `ActiveTag`.
 *
 * ── Why `force-dynamic`, and NOT `revalidate = 300` ───────────────────────
 * Every other page on this site carries `revalidate = 300` so Firebase Hosting
 * cannot freeze it for a year (PR #7). On a route with a dynamic segment that
 * export is inert — measured on `/adopt/[slug]` and `/admin/pets/[petId]` — so
 * copying it here would protect nothing. The reason for `force-dynamic` is
 * different and stronger: a REVOKED tag and a LOST animal must read correctly
 * on the very next scan. Even five minutes of an edge-cached "está al cuidado
 * del refugio" for a dog reported lost at 22:00 is the wrong answer. A scan is
 * rare, and two document reads per scan is the price of never being stale.
 * The response headers were measured from `next start`; see the PR.
 *
 * ── Why `noindex` ──────────────────────────────────────────────────────────
 * The dossier at `/adopt/{slug}` is the page meant to be found. This one is
 * reached by holding the tag, and a search result listing tag URLs would be a
 * directory of codes by another route.
 */
export const dynamic = 'force-dynamic';

/** One resolution per request, shared by the metadata and the page. */
const resolve = cache(resolveQrTag);

interface Props {
  params: Promise<{ token: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  const view = await resolve(token);
  return {
    title: view.kind === 'active' ? view.pet.name : t.tag.genericTitle,
    robots: { index: false, follow: false },
    // The token is in this page's URL. Browsers already default to sending
    // only the origin cross-site; this makes it explicit for the WhatsApp jump
    // and the font request.
    referrer: 'no-referrer',
  };
}

export default async function TagPage({ params }: Props) {
  const { token } = await params;
  const view = await resolve(token);

  // A real 404 — and it does not say whether a pet exists, because it cannot
  // know: `resolveTag` folds "no such token" and "token for a deleted pet"
  // into the same answer on purpose.
  if (view.kind === 'unknown') notFound();

  if (view.kind === 'inactive') {
    const code = formatQrToken(view.token);
    return (
      <TagFallback
        title={t.tag.inactiveTitle}
        body={t.tag.inactiveBody(SHELTER.shortName)}
        message={t.tag.inactiveMessage(code, SHELTER.shortName)}
        code={t.tag.codeLine(code)}
      />
    );
  }

  return <ActiveTag view={view} />;
}
