import type { Metadata } from 'next';
import { SHELTER } from '@/config/shelter';

export const metadata: Metadata = {
  title: 'Perdidos',
  description: `Reporta o consulta avistamientos de animalitos perdidos en ${SHELTER.city}.`,
};

export default function PerdidosPage() {
  return (
    <div className="env" style={{ paddingBlock: 'var(--paso-5)' }}>
      <h1 className="t-titulo">Perdidos</h1>
      <p style={{ marginTop: 'var(--paso-2)', maxWidth: '60ch', opacity: 0.8 }}>
        El reporte público de avistamientos está en construcción. Mientras tanto, escríbenos por{' '}
        <a href={`https://wa.me/${SHELTER.whatsapp}`}>WhatsApp</a> si viste a un animalito perdido.
      </p>
      <p style={{ marginTop: 'var(--paso-3)', maxWidth: '60ch', opacity: 0.8 }}>
        Si encontraste un animalito, llévalo a cualquier veterinaria y pide que lo escaneen: si
        tiene microchip, su número nos lleva directo a su familia.
      </p>
    </div>
  );
}
