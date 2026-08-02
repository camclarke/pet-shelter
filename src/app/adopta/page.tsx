import type { Metadata } from 'next';
import { Muro } from '@/components/Muro';

export const metadata: Metadata = {
  title: 'Adopta',
  description:
    'Perritos rescatados en Cochabamba, listos para encontrar una familia para toda la vida.',
};

// Firestore reads cost money past the free tier; a 5-minute revalidation
// window means a burst of visitors shares one read instead of paying for one
// each, while a newly published dog still appears within minutes.
export const revalidate = 300;

export default function AdoptaPage() {
  return (
    <div style={{ paddingTop: 'var(--paso-4)' }}>
      <Muro limit={48} title="Todos los perritos disponibles" />
    </div>
  );
}
