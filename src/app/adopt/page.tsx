import type { Metadata } from 'next';
import { AdoptionWall } from '@/components/AdoptionWall';
import { SHELTER } from '@/config/shelter';

export const metadata: Metadata = {
  title: 'Adopta',
  description: `Animalitos rescatados en ${SHELTER.city}, listos para encontrar una familia para toda la vida.`,
};

// Firestore reads cost money past the free tier; a 5-minute revalidation
// window means a burst of visitors shares one read instead of paying for one
// each, while a newly published pet still appears within minutes.
export const revalidate = 300;

export default function AdoptPage() {
  return (
    <div style={{ paddingTop: 'var(--space-4)' }}>
      <AdoptionWall limit={48} title="Todos los animalitos disponibles" />
    </div>
  );
}
