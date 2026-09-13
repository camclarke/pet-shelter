import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getPetBySlug } from '@/lib/pets-server';
import { whatsappLink } from '@/lib/pets';
import { SHELTER } from '@/config/shelter';
import { t } from '@/i18n';
import { ApplicationForm } from './ApplicationForm';

/**
 * Kept for consistency with every other page — and INERT here, as it is on
 * `/adopt/[slug]` and `/admin/pets/[petId]`. A dynamic segment is answered
 * `private, no-cache, no-store` (measured on 2026-08-24), so the year-long
 * Firebase Hosting cache defect cannot reach it. The line becomes load-bearing
 * only if this route ever gains `generateStaticParams`.
 */
export const revalidate = 300;

interface Props {
  params: Promise<{ slug: string }>;
}

/**
 * ⚠️ `noindex` on every branch, including the 404. An application form
 * competing in search results with the dossier it belongs to would pull
 * strangers past the WhatsApp button — the exact inversion plan §6 forbids.
 */
const ROBOTS = { index: false, follow: false } as const;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  if (!SHELTER.adoptionApplications.enabled) return { robots: ROBOTS };
  const { slug } = await params;
  const pet = await getPetBySlug(slug);
  return {
    title: pet ? t.applications.pageTitle(pet.name) : undefined,
    robots: ROBOTS,
  };
}

/**
 * The optional online adoption application for one animal.
 *
 * ── Order on the page is the design ───────────────────────────────────────
 * The WhatsApp button renders FIRST and unconditionally — signed in or out,
 * accepting applications or not. The account requirement lives inside
 * `ApplicationForm`, below it. So nobody reaches this page and finds the
 * conversation with the shelter behind a sign-in.
 *
 * ── When it exists at all ─────────────────────────────────────────────────
 * - `adoptionApplications.enabled` false → 404. The switch ships off, because
 *   the screening questions are a draft the shelter did not write.
 * - the pet is not `available` → the page explains and offers WhatsApp. The
 *   rules refuse the create regardless; this just says so before anyone types.
 *
 * Only the PUBLIC `pets/{id}` document is read here, through the Admin SDK,
 * exactly as the dossier does. Nothing about any application is server-rendered.
 */
export default async function ApplyPage({ params }: Props) {
  const config = SHELTER.adoptionApplications;
  if (!config.enabled) notFound();

  const { slug } = await params;
  const pet = await getPetBySlug(slug);
  if (!pet) notFound();

  const copy = t.applications;
  const accepting = pet.status === 'available';

  return (
    <div className="container" style={{ paddingBlock: 'var(--space-5)' }}>
      <div className="auth apply">
        <p>
          <a href={`/adopt/${pet.slug}`} className="auth__link apply-back">
            {copy.backToPet(pet.name)}
          </a>
        </p>
        <h1 className="t-title">{copy.pageTitle(pet.name)}</h1>
        <p className="auth__prose">{copy.intro(pet.name)}</p>

        <p className="apply-whatsapp">
          <a
            href={whatsappLink(SHELTER.whatsapp, t.adoptionInquiry(pet.name))}
            className="btn btn--brand"
          >
            {copy.whatsappInstead} ↗
          </a>
        </p>

        {accepting ? (
          <ApplicationForm
            petId={pet.id}
            petName={pet.name}
            slug={pet.slug}
            shelterName={SHELTER.name}
            questions={config.questions}
          />
        ) : (
          <p className="auth__notice" role="status">
            {copy.notAccepting(pet.name)}
          </p>
        )}
      </div>
    </div>
  );
}
