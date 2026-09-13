import type { Metadata } from 'next';
import { AdminGate } from '@/components/AdminGate';
import { t } from '@/i18n';
import { QrSheetBuilder } from './QrSheetBuilder';

export const metadata: Metadata = {
  title: t.tag.sheetTitle,
  robots: { index: false, follow: false },
};

/**
 * ⚠️ Required: this is a STATIC route. Without it Next sends a one-year
 * `s-maxage` and Firebase Hosting serves this shell frozen until someone
 * notices — the PR #7 defect. Measured on this route from `next start`.
 */
export const revalidate = 300;

/**
 * The batch print sheet: several animals' tags on one page.
 *
 * ── Why the entry point is the admin dashboard, not an animal's page ──────
 * A batch intake is by definition several animals at once — a litter, a
 * rescue from one house — and the dashboard is the screen that already lists
 * every published animal. Starting from one animal's page would mean opening
 * each in turn to reach a sheet about all of them. So the sheet is one tap
 * from that list ("Placas QR" in the dashboard header), and it can issue the
 * missing tags itself, so a volunteer at intake never has to leave it.
 */
export default function AdminQrSheetPage() {
  return (
    <div className="container qr-print" style={{ paddingBlock: 'var(--space-5)' }}>
      <AdminGate>
        <QrSheetBuilder />
      </AdminGate>
    </div>
  );
}
