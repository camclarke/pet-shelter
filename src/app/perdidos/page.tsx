import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Perdidos',
  description: 'Reporta o consulta avistamientos de perritos perdidos en Cochabamba.',
};

export default function PerdidosPage() {
  return (
    <div className="env" style={{ paddingBlock: 'var(--paso-5)' }}>
      <h1 className="t-titulo">Perdidos</h1>
      <p style={{ marginTop: 'var(--paso-2)', maxWidth: '60ch', opacity: 0.8 }}>
        El reporte público de avistamientos está en construcción. Mientras tanto, escríbenos por{' '}
        <a href="https://wa.me/59177903553">WhatsApp</a> si viste a un perrito perdido.
      </p>
    </div>
  );
}
