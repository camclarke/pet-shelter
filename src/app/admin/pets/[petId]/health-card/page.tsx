import type { Metadata } from 'next';
import { AdminGate } from '@/components/AdminGate';
import { t } from '@/i18n';
import { HealthCardPrint } from './HealthCardPrint';

export const metadata: Metadata = {
  title: t.healthCard.title,
  robots: { index: false, follow: false },
};

/**
 * Inert on this route, for the reason written out on `/admin/pets/[petId]`: a
 * dynamic segment is answered `private, no-cache, no-store`, so there is no
 * edge entry to freeze. Kept for the day the route prerenders.
 */
export const revalidate = 300;

/**
 * The print surface for ONE animal's vaccination card.
 *
 * `health-card-print` on the wrapper is what the print stylesheet keys on: it
 * hides the site chrome and every `.no-print` control, and only on a page that
 * carries it. The paper size is a NAMED page on the card itself, so printing a
 * QR sheet or anything else keeps the printer's own setting.
 */
export default async function AdminPetHealthCardPage({ params }: { params: Promise<{ petId: string }> }) {
  const { petId } = await params;
  return (
    <div className="container health-card-print" style={{ paddingBlock: 'var(--space-5)' }}>
      <AdminGate section="pets">
        <HealthCardPrint petId={petId} />
      </AdminGate>
    </div>
  );
}
