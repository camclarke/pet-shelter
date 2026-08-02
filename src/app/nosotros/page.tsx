import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Nosotros',
  description: 'Wawitas Red de Apoyo: refugio transitorio de perritos en Cochabamba, Bolivia.',
};

export default function NosotrosPage() {
  return (
    <div className="env" style={{ paddingBlock: 'var(--paso-5)' }}>
      <h1 className="t-titulo">Nosotros</h1>
      <p style={{ marginTop: 'var(--paso-2)', maxWidth: '60ch', opacity: 0.8 }}>
        Somos un refugio transitorio de hermosos perritos que han sido abandonados y/o
        maltratados. Nuestra misión es rescatarlos, rehabilitarlos física y emocionalmente y
        encontrarles una familia para toda la vida en adopción responsable.
      </p>
    </div>
  );
}
