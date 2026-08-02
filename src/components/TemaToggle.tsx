'use client';

import { useState } from 'react';

/**
 * The only client-side interactivity the site chrome needs. Kept as a small,
 * isolated island rather than lifting the whole header into a Client
 * Component — everything around it stays server-rendered.
 */
export function TemaToggle() {
  const [oscuro, setOscuro] = useState(false);

  function alternar() {
    const raiz = document.documentElement;
    const actualmenteOscuro =
      raiz.dataset.tema === 'noche' ||
      (!raiz.dataset.tema && matchMedia('(prefers-color-scheme: dark)').matches);
    const siguiente = actualmenteOscuro ? 'dia' : 'noche';
    raiz.dataset.tema = siguiente;
    localStorage.setItem('tema', siguiente);
    setOscuro(siguiente === 'noche');
  }

  return (
    <button className="icono" type="button" aria-pressed={oscuro} onClick={alternar}>
      <span className="sr">Cambiar entre modo día y noche</span>
      <span aria-hidden="true">◐</span>
    </button>
  );
}
