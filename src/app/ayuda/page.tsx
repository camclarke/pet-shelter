import type { Metadata } from 'next';
import { SHELTER } from '@/config/shelter';

export const metadata: Metadata = {
  title: 'Ayuda',
  description: `Dona, ofrece un hogar de tránsito o sé voluntario en ${SHELTER.name}.`,
};

export default function AyudaPage() {
  return (
    <div className="env" style={{ paddingBlock: 'var(--paso-5)' }}>
      <h1 className="t-titulo">Quiero ayudar</h1>
      <p style={{ marginTop: 'var(--paso-2)', maxWidth: '60ch', opacity: 0.8 }}>
        Donaciones, hogares de tránsito y voluntariado están en construcción. Mientras tanto,
        escríbenos por <a href={`https://wa.me/${SHELTER.whatsapp}`}>WhatsApp</a>.
      </p>
    </div>
  );
}
