import type { Metadata } from 'next';
import { AdminGate } from '@/components/AdminGate';
import { PetAdminPanel } from './PetAdminPanel';

export const metadata: Metadata = {
  title: 'Ficha interna',
  robots: { index: false, follow: false },
};

/**
 * Kept for consistency with every other page here — but MEASURED, and it is
 * inert on this route.
 *
 * The year-long Hosting cache defect that PR #7 fixed applies to STATIC pages:
 * they send `s-maxage=31536000`, and Firebase Hosting cannot know the Cloud
 * Run revision behind its rewrite changed. A dynamic segment is different. A
 * real `next start` on 2026-08-24 answered this route — and the pre-existing
 * `/adopt/[slug]`, which carries the same export — with
 * `private, no-cache, no-store, max-age=0, must-revalidate`. Nothing caches
 * it, so nothing can freeze it.
 *
 * The line stays because it costs nothing and becomes load-bearing the moment
 * this route gains `generateStaticParams` and starts prerendering. It is NOT
 * what is protecting the page today, and a comment claiming otherwise would be
 * the same mistake as a rule comment describing usage as though it were policy.
 */
export const revalidate = 300;

/**
 * Deliberately NOT `generateStaticParams`. Pre-rendering one shell per pet
 * would put the list of every animal's internal id into the build output, and
 * this page is reached by id rather than by the public slug precisely so the
 * two namespaces stay separate.
 */
export default async function AdminPetPage({ params }: { params: Promise<{ petId: string }> }) {
  const { petId } = await params;

  return (
    <div className="container" style={{ paddingBlock: 'var(--space-5)' }}>
      <AdminGate>
        <PetAdminPanel petId={petId} />
      </AdminGate>
    </div>
  );
}
