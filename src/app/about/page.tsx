import type { Metadata } from 'next';
import { SHELTER } from '@/config/shelter';

export const metadata: Metadata = {
  title: 'Nosotros',
  description: `${SHELTER.name}: refugio transitorio en ${SHELTER.city}, ${SHELTER.country}.`,
};

export default function AboutPage() {
  return (
    <div className="container" style={{ paddingBlock: 'var(--space-5)' }}>
      <h1 className="t-title">Nosotros</h1>
      <p style={{ marginTop: 'var(--space-2)', maxWidth: '60ch', opacity: 0.8 }}>
        {SHELTER.mission}
      </p>
      <p style={{ marginTop: 'var(--space-3)', maxWidth: '60ch', opacity: 0.8 }}>
        Cada animalito que damos en adopción sale identificado con un microchip ISO 11784/11785 y
        con su historial médico al día.
      </p>
    </div>
  );
}
