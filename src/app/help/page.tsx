import type { Metadata } from 'next';
import { SHELTER } from '@/config/shelter';

export const metadata: Metadata = {
  title: 'Ayuda',
  description: `Dona, ofrece un hogar de tránsito o sé voluntario en ${SHELTER.name}.`,
};

export default function HelpPage() {
  return (
    <div className="container" style={{ paddingBlock: 'var(--space-5)' }}>
      <h1 className="t-title">Quiero ayudar</h1>
      <p style={{ marginTop: 'var(--space-2)', maxWidth: '60ch', opacity: 0.8 }}>
        Donaciones, hogares de tránsito y voluntariado están en construcción. Mientras tanto,
        escríbenos por <a href={`https://wa.me/${SHELTER.whatsapp}`}>WhatsApp</a>.
      </p>
    </div>
  );
}
