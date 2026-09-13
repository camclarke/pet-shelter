import type { Metadata } from 'next';
import { AdminGate } from '@/components/AdminGate';
import { ApplicationReview } from './ApplicationReview';

export const metadata: Metadata = {
  title: 'Solicitud de adopción',
  robots: { index: false, follow: false },
};

/**
 * Kept for consistency — and INERT on a dynamic segment, measured on
 * `/admin/pets/[petId]` (2026-08-24: `private, no-cache, no-store`). It is not
 * what protects this page from the year-long Hosting cache, and it becomes
 * load-bearing only if the route ever prerenders.
 *
 * Deliberately NOT `generateStaticParams`: an application id contains the
 * applicant's uid, and a list of them has no business in the build output.
 */
export const revalidate = 300;

export default async function ApplicationPage({
  params,
}: {
  params: Promise<{ applicationId: string }>;
}) {
  const { applicationId } = await params;

  return (
    <div className="container" style={{ paddingBlock: 'var(--space-5)' }}>
      <AdminGate>
        <ApplicationReview applicationId={decodeURIComponent(applicationId)} />
      </AdminGate>
    </div>
  );
}
