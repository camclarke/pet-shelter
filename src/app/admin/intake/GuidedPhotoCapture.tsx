'use client';

import { useRef, useState, type ChangeEvent } from 'react';

import type { PetPhotoSlot } from '@/lib/types';

/**
 * Guided intake capture: four named shots, then ONE analysis.
 *
 * ── Why the slots are named ──────────────────────────────────────────────────
 * The slot travels to the model as a label, which lets the prompt bind each
 * inference to one photograph — age from the teeth shot and sex from the
 * genital shot, and from nowhere else. Unlabelled, a Lite-tier model read the
 * white facial mask of a husky as muzzle greying and aged a young adult at
 * 6–8 years. Being told where the dentition is removes that inference.
 *
 * ── Why analysis is a BUTTON and not automatic ───────────────────────────────
 * ⚠️ Do not re-add "analyse on upload". Free-tier quota counts REQUESTS, and
 * the Flash tier gets 20 a day. Analysing each photo as it lands would spend
 * four of those per animal and quietly cut the shelter from 20 animals a day to
 * five. Every photo present goes in one call.
 *
 * ── Why nothing is required ──────────────────────────────────────────────────
 * A rescuer on a street with a frightened animal often manages exactly one
 * photograph, and the teeth and genital shots need handling that a scared dog
 * may not allow and a volunteer is not trained to force. So each slot says what
 * it unlocks rather than demanding to be filled, and one photo is enough to
 * carry on. Plan §3: a gate stricter than the reality of the shelter gets
 * worked around.
 */

export interface CapturedSlot {
  slot: PetPhotoSlot;
  url: string;
  busy: boolean;
}

export interface GuidedPhotoCaptureProps {
  captured: readonly CapturedSlot[];
  busy: boolean;
  disabled: boolean;
  analysing: boolean;
  onPick: (slot: PetPhotoSlot, file: File) => void;
  onAnalyze: () => void;
}

interface SlotSpec {
  slot: PetPhotoSlot;
  label: string;
  /** What this photograph buys. Shown instead of demanding it. */
  unlocks: string;
  hint: string;
}

/**
 * Front first: it is the cover photo and carries the breed evidence, so a
 * one-photo intake should be this one. Teeth and genitals last because they are
 * the shots a frightened animal is least likely to allow.
 */
const SLOTS: SlotSpec[] = [
  {
    slot: 'front',
    label: 'De frente',
    unlocks: 'Raza, color y pelaje. Es la foto que sale en el muro.',
    hint: 'La cara completa, con buena luz.',
  },
  {
    slot: 'side',
    label: 'De perfil',
    unlocks: 'Cuerpo y porte. Mejor si está parado.',
    hint: 'El cuerpo entero de costado. Si hay algo al lado que dé escala — una mano, una puerta — también sale el tamaño y el peso.',
  },
  {
    slot: 'teeth',
    label: 'Dientes',
    unlocks: 'La edad. Sin esta foto no la estimamos.',
    hint: 'Levanta el labio con cuidado. Si el animalito no se deja, sáltala: la edad la pone el veterinario.',
  },
  {
    slot: 'genitals',
    label: 'Genitales',
    unlocks: 'El sexo, y si ya está castrado.',
    hint: 'Esta foto nunca se publica: queda sólo para el refugio.',
  },
];

export default function GuidedPhotoCapture({
  captured,
  busy,
  disabled,
  analysing,
  onPick,
  onAnalyze,
}: GuidedPhotoCaptureProps) {
  // Two inputs per slot rather than one whose `capture` is toggled before
  // .click(): toggling the attribute on a shared input is flaky across mobile
  // browsers, and inputs cost nothing.
  //
  // ⚠️ VISUALLY hidden, never `hidden` / display:none. Chrome 130+ does not
  // deliver trusted change events to a programmatic .click() on a hidden input,
  // so the picker opens and the file never arrives — no error, no log, nothing.
  // Carried from trustcert.ai, where it cost a debugging session.
  // See docs/gemini-file-uploads-knowledge-export.md §8.
  const cameraRefs = useRef<Partial<Record<PetPhotoSlot, HTMLInputElement | null>>>({});
  const galleryRefs = useRef<Partial<Record<PetPhotoSlot, HTMLInputElement | null>>>({});

  // On a phone the slots are walked one at a time. A browser will not open the
  // camera without a user gesture, so this cannot auto-advance INTO the next
  // shot — it advances the highlighted step and the person taps once more,
  // which also lets them see the photo landed.
  const [step, setStep] = useState(0);

  const filled = new Map(captured.map((c) => [c.slot, c]));
  const count = captured.length;

  function handleChange(slot: PetPhotoSlot, e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Cleared so re-picking the same file fires change again.
    e.target.value = '';
    if (!file) return;
    onPick(slot, file);
    const index = SLOTS.findIndex((s) => s.slot === slot);
    if (index >= 0 && index + 1 < SLOTS.length) setStep(index + 1);
  }

  return (
    <div className="admin-suggest">
      <h2 className="t-label">Fotos del animalito</h2>
      <p className="admin__sub">
        Toma las que puedas — <strong>con una alcanza</strong>. Cada foto agrega
        un dato distinto, y todas se analizan juntas al final.{' '}
        <strong>Tú revisas todo antes de publicar.</strong>
      </p>

      <ol className="capture">
        {SLOTS.map((spec, index) => {
          const done = filled.get(spec.slot);
          const isNext = index === step && !done;
          return (
            <li
              key={spec.slot}
              className={`capture__slot${done ? ' capture__slot--done' : ''}${
                isNext ? ' capture__slot--next' : ''
              }`}
            >
              <input
                ref={(el) => {
                  cameraRefs.current[spec.slot] = el;
                }}
                type="file"
                accept="image/*"
                capture="environment"
                className="visually-hidden"
                aria-hidden="true"
                tabIndex={-1}
                disabled={disabled || busy}
                onChange={(e) => handleChange(spec.slot, e)}
              />
              <input
                ref={(el) => {
                  galleryRefs.current[spec.slot] = el;
                }}
                type="file"
                accept="image/*"
                className="visually-hidden"
                aria-hidden="true"
                tabIndex={-1}
                disabled={disabled || busy}
                onChange={(e) => handleChange(spec.slot, e)}
              />

              <div className="capture__preview">
                {done ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={done.url} alt={`Foto ${spec.label.toLowerCase()}`} />
                ) : (
                  <span className="capture__placeholder" aria-hidden="true">
                    {index + 1}
                  </span>
                )}
              </div>

              <div className="capture__body">
                <strong>{spec.label}</strong>
                <span className="t-data">{spec.unlocks}</span>
                <small className="auth__hint">{spec.hint}</small>

                <div className="capture__actions">
                  <button
                    type="button"
                    className={done ? 'btn btn--muted' : 'btn'}
                    disabled={disabled || busy}
                    onClick={() => cameraRefs.current[spec.slot]?.click()}
                  >
                    {done ? 'Repetir' : 'Tomar foto'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--muted"
                    disabled={disabled || busy}
                    onClick={() => galleryRefs.current[spec.slot]?.click()}
                  >
                    Galería
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="capture__submit">
        <button
          type="button"
          className="btn btn--action"
          disabled={disabled || busy || analysing || count === 0}
          onClick={onAnalyze}
        >
          {analysing
            ? 'Analizando…'
            : `Analizar ${count === 1 ? 'la foto' : `las ${count} fotos`}`}
        </button>
        {count === 0 && (
          <small className="auth__hint">
            Toma al menos una foto para poder analizar. También puedes cargar
            todos los datos a mano.
          </small>
        )}
      </div>

      {analysing && (
        <p className="auth__notice" role="status">
          Mirando las fotos. Con varias puede tardar cerca de un minuto.{' '}
          <strong>No cierres esta pantalla</strong> — las fotos ya se guardaron y
          quedan aunque el análisis falle.
        </p>
      )}
    </div>
  );
}
