import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Ayuda',
  description: 'Dona, ofrece un hogar de tránsito o sé voluntario en Wawitas Red de Apoyo.',
};

export default function AyudaPage() {
  return (
    <div className="env" style={{ paddingBlock: 'var(--paso-5)' }}>
      <h1 className="t-titulo">Quiero ayudar</h1>
      <p style={{ marginTop: 'var(--paso-2)', maxWidth: '60ch', opacity: 0.8 }}>
        Donaciones, hogares de tránsito y voluntariado están en construcción. Mientras tanto,
        escríbenos por <a href="https://wa.me/59177903553">WhatsApp</a>.
      </p>
    </div>
  );
}
