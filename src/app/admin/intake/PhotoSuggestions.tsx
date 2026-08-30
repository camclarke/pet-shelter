'use client';

import { useRef, type ChangeEvent } from 'react';

import { t } from '@/i18n';
import type { PetSex, PetSize } from '@/lib/types';
import type { SuggestOutcome } from '@/lib/intake-suggest-client';

/**
 * The photo accelerator at the top of intake step 1.
 *
 * ── What this is NOT ─────────────────────────────────────────────────────────
 * It is not an identification system and it must never read as one. Everything
 * it produces is a suggestion an admin standing next to the animal accepts or
 * ignores, and the copy says so. Plan §4.8: the review gate is not optional.
 *
 * ── Why some things are applied and others are only offered ──────────────────
 * The policy lives in `src/lib/intake-suggestion.ts` and is applied on the
 * SERVER. This component renders its outcome; it does not decide it. Species
 * and age arrive already filled in, because they are cheap to correct and a
 * human is looking at the animal. Breed, size and names are buttons, because
 * each one is a claim that reaches a public adoption listing.
 *
 * ── Withheld fields are explained, never hidden ──────────────────────────────
 * A suggestion that silently does not appear reads as a broken feature. Each
 * one says why it was withheld, which is also how someone learns that a photo
 * with a hand or a doorway in it produces a size estimate and a photo without
 * one does not.
 */

export interface PhotoSuggestionsProps {
  outcome: SuggestOutcome | null;
  busy: boolean;
  disabled: boolean;
  /** Needed to spell "mestizo"/"mestiza" — the model is never asked for it. */
  sex: PetSex | null;
  onPick: (file: File) => void;
  onApplyBreed: (breed: string) => void;
  onApplySize: (size: PetSize) => void;
  onApplyName: (name: string) => void;
}

const SIZE_LABEL: Record<PetSize, string> = {
  small: 'pequeño',
  medium: 'mediano',
  large: 'grande',
};

const WITHHELD_REASON: Record<string, string> = {
  species: 'No se pudo reconocer la especie con seguridad en esta foto.',
  age: 'No se pudo estimar la edad. Ayuda una foto de los dientes, de frente y con buena luz.',
  size: 'No se puede estimar el tamaño sin algo que dé escala: una mano, una puerta, un plato.',
};

// ⚠️ Every one of these must say what happened to the PHOTO, because the photo
// is uploaded before the model is called and therefore survives every failure
// below. Saying only "no pudimos analizar" reads as "nothing happened" and
// sends someone hunting for a photo that is already saved — reported from a
// real phone, 2026-08-30.
const FAILURE_TEXT: Record<string, string> = {
  'not-configured':
    'La foto se guardó y queda como portada. Las sugerencias automáticas todavía no están configuradas, así que cargá los datos a mano.',
  unauthorized:
    'Tu sesión venció. La foto se guardó igual. Volvé a entrar y probá de nuevo.',
  'photo-rejected':
    'No pudimos leer esa imagen. Probá sacando la foto de nuevo, o elegí una JPG o PNG de menos de 6 MB.',
  timeout:
    'La foto se guardó y queda como portada. El análisis tardó demasiado y lo cortamos — puede ser la señal. Podés tocar «Tomar foto» otra vez para reintentar, o cargar los datos a mano y seguir.',
  failed:
    'La foto se guardó y queda como portada. Solo falló el análisis automático: cargá los datos a mano y seguí, no se pierde nada.',
};

export default function PhotoSuggestions({
  outcome,
  busy,
  disabled,
  sex,
  onPick,
  onApplyBreed,
  onApplySize,
  onApplyName,
}: PhotoSuggestionsProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Cleared so re-picking the same file fires change again — the same trap
    // the media step already handles.
    e.target.value = '';
    if (file) onPick(file);
  }

  const s = outcome?.suggestion ?? null;

  return (
    <div className="admin-suggest">
      <h2 className="t-label">Foto para autocompletar (opcional)</h2>
      <p className="admin__sub">
        Sacale una foto al animalito y completamos lo que se pueda ver. <strong>Vos revisás
        todo antes de publicar</strong> — nada se guarda solo. La misma foto queda como
        foto de portada, así no hay que sacar dos, y se guarda apenas la sacás:
        si el análisis falla, la foto ya está.
      </p>

      {/* TWO inputs rather than one whose `capture` is toggled before .click().
          Intake happens on a phone with the animal in front of you, so "take a
          photo" has to be a button, not an option buried in a file picker —
          that was the actual complaint. `capture` opens the camera directly;
          without it the same input offers the gallery. Toggling the attribute
          on a shared input right before clicking is flaky across mobile
          browsers, and two inputs cost nothing. */}
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        disabled={disabled || busy}
        onChange={handleChange}
      />
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        disabled={disabled || busy}
        onChange={handleChange}
      />

      <div className="admin-suggest__actions">
        <button
          type="button"
          className="btn"
          disabled={disabled || busy}
          onClick={() => cameraRef.current?.click()}
        >
          {busy ? 'Analizando…' : 'Tomar foto'}
        </button>
        <button
          type="button"
          className="btn btn--muted"
          disabled={disabled || busy}
          onClick={() => inputRef.current?.click()}
        >
          Elegir de la galería
        </button>
      </div>

      {busy && (
        <p className="auth__notice" role="status">
          Subiendo la foto y mirándola. Puede tardar hasta medio minuto con
          señal lenta. <strong>No cierres esta pantalla</strong> — la foto ya se
          guardó y queda como portada aunque el análisis falle.
        </p>
      )}

      {outcome?.failure && (
        <p className="auth__notice auth__notice--warn" role="status">
          {FAILURE_TEXT[outcome.failure] ?? FAILURE_TEXT.failed}
        </p>
      )}

      {s && (
        <div className="admin-suggest__result">
          <p className="admin__sub">
            Esto es lo que se ve en la foto. Corregí lo que haga falta.
          </p>

          {/* ── applied automatically ─────────────────────────────────────── */}
          {s.species && (
            <p className="admin-suggest__applied">
              Especie: <strong>{t.speciesNoun(s.species, sex ?? 'male')}</strong> — ya cargada
            </p>
          )}

          {!s.age.refused && s.age.ageMonthsMin !== null && s.age.ageMonthsMax !== null && (
            <p className="admin-suggest__applied">
              Edad estimada:{' '}
              <strong>{t.formatAgeRange(s.age.ageMonthsMin, s.age.ageMonthsMax)}</strong> — ya
              cargada como estimación
            </p>
          )}

          {/* ── offered, never applied ────────────────────────────────────── */}
          <div className="admin-suggest__offers">
            <span className="t-label">Raza</span>
            {s.breed.kind === 'purebred' ? (
              <button
                type="button"
                className="btn btn--muted"
                disabled={disabled || busy}
                onClick={() => onApplyBreed(s.breed.kind === 'purebred' ? s.breed.breed : '')}
              >
                {s.breed.breed}
              </button>
            ) : sex ? (
              <button
                type="button"
                className="btn btn--muted"
                disabled={disabled || busy}
                onClick={() => onApplyBreed(t.mixedBreed(sex))}
              >
                {t.mixedBreed(sex)}
              </button>
            ) : (
              <span className="admin__sub">
                Elegí primero el sexo: la palabra cambia entre &laquo;mestizo&raquo; y
                &laquo;mestiza&raquo;, y eso no se ve en una foto.
              </span>
            )}
          </div>

          {s.size && (
            <div className="admin-suggest__offers">
              <span className="t-label">Tamaño</span>
              <button
                type="button"
                className="btn btn--muted"
                disabled={disabled || busy}
                onClick={() => onApplySize(s.size!)}
              >
                {SIZE_LABEL[s.size]}
              </button>
            </div>
          )}

          {s.names.length > 0 && (
            <div className="admin-suggest__offers">
              <span className="t-label">Nombres sugeridos</span>
              {s.names.map((name) => (
                <button
                  key={name}
                  type="button"
                  className="btn btn--muted"
                  disabled={disabled || busy}
                  onClick={() => onApplyName(name)}
                >
                  {name}
                </button>
              ))}
            </div>
          )}

          {/* ── context, no field to land in ──────────────────────────────── */}
          {s.visibleType && (
            <p className="admin__sub">
              Lo que se ve: <em>{s.visibleType}</em>
            </p>
          )}
          {s.coatDescription && <p className="admin__sub">Pelaje: {s.coatDescription}</p>}
          {s.distinguishingMarks && (
            <p className="admin__sub">Señas: {s.distinguishingMarks}</p>
          )}

          {s.notes && (
            <p className="auth__hint">
              <strong>Para revisar:</strong> {s.notes}{' '}
              <em>Esto no es un diagnóstico — que lo vea el veterinario.</em>
            </p>
          )}

          {/* ── why something is missing ──────────────────────────────────── */}
          {s.withheld.length > 0 && (
            <ul className="admin-suggest__withheld">
              {s.withheld.map((field) => (
                <li key={field} className="admin__sub">
                  {WITHHELD_REASON[field] ?? `No se pudo estimar: ${field}.`}
                </li>
              ))}
            </ul>
          )}

          <p className="admin__sub">
            El sexo nunca se sugiere: no se ve en una foto y de él dependen todos los
            textos del sitio.
          </p>
        </div>
      )}
    </div>
  );
}
