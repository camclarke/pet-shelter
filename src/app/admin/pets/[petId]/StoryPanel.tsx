'use client';

import { useState } from 'react';

import { updatePetStory } from '@/lib/pets-admin';
import { STORY_MAX_CHARS, checkStory } from '@/lib/pet-story';

/**
 * The animal's story, editable after publishing.
 *
 * Until 2026-10-22 the story could only be typed in the intake wizard, before
 * publishing, into a document nobody could read back. It now lives on the
 * PUBLIC pet document and is shown on the dossier, so this is the only way to
 * fix it once the animal is on the wall.
 *
 * Mounted once the pet has loaded, with the text it already has: the textarea
 * is initialised from `initialStory` and never re-synced, so a late reload of
 * the parent cannot overwrite what someone is typing.
 */
export function StoryPanel({
  petId,
  initialStory,
}: {
  petId: string;
  initialStory: string;
}) {
  const [text, setText] = useState(initialStory);
  const [saved, setSaved] = useState(initialStory);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<'idle' | 'saved' | 'error'>('idle');

  const check = checkStory(text);
  const tooLong = check.error === 'too-long';
  const unchanged = check.story === saved.trim();

  async function save() {
    if (tooLong || unchanged) return;
    setBusy(true);
    setState('idle');
    try {
      const written = await updatePetStory(petId, text);
      setSaved(written);
      setText(written);
      setState('saved');
    } catch (caught) {
      console.error('[story]', caught);
      setState('error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-list">
      <h2 className="t-label">Historia</h2>

      <div className="admin-form">
        <label className="auth__field">
          <span className="t-label">Historia del animalito</span>
          <textarea
            rows={6}
            value={text}
            disabled={busy}
            onChange={(e) => {
              setText(e.target.value);
              setState('idle');
            }}
          />
          <span className="auth__hint">
            Aparece en su ficha pública. Cuenta de dónde viene y cómo es. No pongas nombres ni
            direcciones de personas.
          </span>
        </label>

        {tooLong && (
          <p className="auth__error" role="alert">
            La historia es demasiado larga: el máximo es {STORY_MAX_CHARS} caracteres.
          </p>
        )}
        {state === 'error' && (
          <p className="auth__error" role="alert">
            No pudimos guardar la historia. Revisa tu conexión e inténtalo de nuevo.
          </p>
        )}
        {state === 'saved' && (
          <p className="auth__notice" role="status">
            Historia guardada.
          </p>
        )}

        <div className="admin-list__actions">
          <button
            type="button"
            className="btn btn--action"
            disabled={busy || tooLong || unchanged}
            onClick={() => void save()}
          >
            Guardar historia
          </button>
        </div>
      </div>
    </section>
  );
}
