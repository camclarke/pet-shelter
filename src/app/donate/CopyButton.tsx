'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Copies one value (an account number, a holder's name) and says so. If the
 * browser refuses the clipboard (an in-app browser, an old WebView), the value
 * is selected in a field so a long-press can copy it; the message says that
 * instead of pretending it worked.
 */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(value);
      ok = true;
    } catch {
      ok = false;
    }
    if (timer.current) clearTimeout(timer.current);
    if (ok) {
      setState('copied');
      timer.current = setTimeout(() => setState('idle'), 2500);
    } else {
      setState('manual');
      // The field is mounted by the state change; select it on the next frame.
      requestAnimationFrame(() => field.current?.select());
    }
  }

  return (
    <span className="donate__copy">
      <button type="button" className="btn btn--muted btn--compact" onClick={copy} aria-label={`Copiar ${label}`}>
        {state === 'copied' ? 'Copiado' : 'Copiar'}
      </button>
      <span role="status" className="donate__copy-note">
        {state === 'copied' && 'Copiado'}
        {state === 'manual' && 'No pudimos copiar solo. Mantén presionado el texto para copiarlo.'}
      </span>
      {state === 'manual' && (
        <input ref={field} className="donate__copy-field" readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} />
      )}
    </span>
  );
}
