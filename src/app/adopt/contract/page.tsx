import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { SHELTER } from '@/config/shelter';
import { ADOPTION_CONTRACT } from '@/config/adoption-contract';
import { t } from '@/i18n';
import { ContractText } from '../[slug]/apply/ContractText';

/**
 * ⚠️ LOAD-BEARING. This page reads no data, so Next.js would prerender it
 * with `s-maxage=31536000` — and Firebase Hosting cannot know when the Cloud
 * Run revision behind its rewrite changes, so the edge would keep a contract
 * revision (or this page's 404) for a YEAR (the project log, 2026-08-23).
 * `revalidate = 300` makes it `s-maxage=300, stale-while-revalidate`.
 */
export const revalidate = 300;

/**
 * `noindex`, like the apply page: the commitments are for someone already
 * considering an adoption, and must not compete in search results with the
 * dossier and its WhatsApp button. Not in the sitemap either.
 */
export const metadata: Metadata = {
  title: t.applicationSteps.contractPageTitle,
  robots: { index: false, follow: false },
};

/**
 * `/adopt/contract` — the shelter's commitments, readable BEFORE creating an
 * account (owner decision D13): the honest order for something this binding.
 *
 * ⚠️ 404 while online applications are switched off, or while there is no
 * contract: nothing that looks legal is published before portion 4f, and
 * nothing empty ever is.
 *
 * The text is `ADOPTION_CONTRACT`, verbatim, with its two blanks left blank,
 * and the note that it is signed on paper at handover (D11) — never signature
 * lines. A static route: it takes precedence over `/adopt/[slug]`, so a pet
 * whose slug were "contract" would be unreachable (none is; slugs are names).
 */
export default function ContractPage() {
  if (!SHELTER.adoptionApplications.enabled || ADOPTION_CONTRACT === null) notFound();
  const copy = t.applicationSteps;

  return (
    <div className="container contract-page" style={{ paddingBlock: 'var(--space-5)' }}>
      <div className="auth apply">
        <p className="no-print">
          <Link href="/adopt" className="auth__link apply-back">
            {copy.contractPageBack}
          </Link>
        </p>
        <h1 className="t-title">{copy.contractPageTitle}</h1>
        <p className="auth__prose">{copy.contractPageIntro(SHELTER.name)}</p>
        <ContractText contract={ADOPTION_CONTRACT} mode="blank" headingLevel="h2" />
        <aside className="apply-paper-note">{copy.paperNote}</aside>
      </div>
    </div>
  );
}
