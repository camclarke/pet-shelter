'use client';

import { useState } from 'react';

/**
 * The only client-side interactivity the site chrome needs. Kept as a small,
 * isolated island rather than lifting the whole header into a Client
 * Component — everything around it stays server-rendered.
 *
 * `data-theme` and its `light`/`dark` values are read by `globals.css` and
 * written by the inline script in `layout.tsx`. All three must agree, so if
 * one of these strings changes the other two have to change with it.
 */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  function toggle() {
    const root = document.documentElement;
    const currentlyDark =
      root.dataset.theme === 'dark' ||
      (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    const next = currentlyDark ? 'light' : 'dark';
    root.dataset.theme = next;
    localStorage.setItem('theme', next);
    setDark(next === 'dark');
  }

  return (
    <button className="icon" type="button" aria-pressed={dark} onClick={toggle}>
      <span className="sr-only">Cambiar entre modo día y noche</span>
      <span aria-hidden="true">◐</span>
    </button>
  );
}
