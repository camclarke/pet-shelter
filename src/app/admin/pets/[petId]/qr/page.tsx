import type { Metadata } from 'next';
import { AdminGate } from '@/components/AdminGate';
import { t } from '@/i18n';
import { PetQrPrint } from './PetQrPrint';

export const metadata: Metadata = {
  title: t.tag.panelTitle,
  robots: { index: false, follow: false },
};

/**
 * Inert on this route, for the reason written out on `/admin/pets/[petId]`: a
 * dynamic segment is answered `private, no-cache, no-store`, so there is no
 * edge entry to freeze. Kept for the day the route prerenders.
 */
export const revalidate = 300;

/**
 * The print surface for ONE animal's tag.
 *
 * `qr-print` on the wrapper is what the print stylesheet keys on: it hides the
 * site header, ticker, footer and every `.no-print` control, and ONLY on a page
 * that carries it — printing the adoption dossier keeps its chrome.
 */
export default async function AdminPetQrPage({ params }: { params: Promise<{ petId: string }> }) {
  const { petId } = await params;
  return (
    <div className="container qr-print" style={{ paddingBlock: 'var(--space-5)' }}>
      <AdminGate>
        <PetQrPrint petId={petId} />
      </AdminGate>
    </div>
  );
}
