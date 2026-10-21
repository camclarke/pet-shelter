import type { Metadata } from 'next';
import { AdoptionWall } from '@/components/AdoptionWall';
import { SHELTER } from '@/config/shelter';

export const metadata: Metadata = {
  title: 'Adopta',
  description: `Animalitos rescatados en ${SHELTER.city}, listos para encontrar una familia para toda la vida.`,
};

// Per-request render: the CI build has no Firestore access, so a prerender
// bakes the wall's error state into the HTML. The 5-minute CDN cache that
// bounds Firestore reads is set in next.config.ts (s-maxage=300); a test pins
// both halves.
export const dynamic = 'force-dynamic';

export default function AdoptPage() {
  return (
    <div style={{ paddingTop: 'var(--space-4)' }}>
      <AdoptionWall limit={48} title="Todos los animalitos disponibles" />
    </div>
  );
}
