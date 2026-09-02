'use client';

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
  /**
   * The sex ALREADY ON THE DRAFT — what an admin has confirmed, never what the
   * model read. Breed wording ("mestizo"/"mestiza") agrees with this value, so
   * it must not be the raw suggestion: the breed string would then be spelled
   * from a reading nobody has accepted yet.
   */
  sex: PetSex | null;
  onApplyBreed: (breed: string) => void;
  onApplySize: (size: PetSize) => void;
  /** A RANGE, never a single number — see decideWeight. */
  onApplyWeight: (minKg: number, maxKg: number) => void;
  onApplyName: (name: string) => void;
  /** Offered for one tap, NEVER pre-filled — see the sex block below. */
  onApplySex: (sex: PetSex) => void;
  /** Only ever offered on a positive reading — see the sterilisation block. */
  onApplySterilized: () => void;
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
  weight:
    'No se puede estimar el peso sin algo que dé escala en la foto. Sacá otra con una mano, una puerta o un plato al lado.',
};

/**
 * Sex is withheld for two very different reasons and they need different
 * copy: one is a missing photograph the admin can go and take, the other is a
 * photograph that was taken and could not be read. A single message would send
 * someone to re-shoot a photo they already have.
 */
const SEX_WITHHELD_REASON: Record<string, string> = {
  'no-genital-photo':
    'El sexo no se estima sin la foto de genitales: es la única forma de leerlo, y nunca se deduce del tamaño ni del porte. Elegilo a mano, o sacá esa foto.',
  'low-confidence':
    'Se vio la foto de genitales pero no alcanzó para estar seguros. Elegí el sexo a mano — de él dependen todos los textos del sitio.',
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

/**
 * The model's free text does not reliably end in punctuation, so it ran
 * straight into the static disclaimer: "...en la toma superior Esto no es un
 * diagnóstico". Seen on a real device 2026-08-30. Adding the stop here rather
 * than asking the prompt for it, because prompt-enforced formatting is the
 * kind of rule that erodes and this cannot fail.
 */
function endWithStop(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export default function PhotoSuggestions({
  outcome,
  busy,
  disabled,
  sex,
  onApplyBreed,
  onApplySize,
  onApplyWeight,
  onApplyName,
  onApplySex,
  onApplySterilized,
}: PhotoSuggestionsProps) {
  const s = outcome?.suggestion ?? null;

  // Hoisted rather than read as s.breed.resembles at each call site:
  // TypeScript drops narrowing on a property access inside a closure, and
  // these are read from onClick handlers. A plain const needs no narrowing.
  const resembles: string[] = s && s.breed.kind === 'mixed' ? s.breed.resembles : [];

  return (
    <div className="admin-suggest">
      <h2 className="t-label">Lo que se ve en las fotos</h2>
      <p className="admin__sub">
        Sacale una foto al animalito y completamos lo que se pueda ver. <strong>Vos revisás
        todo antes de publicar</strong> — nada se guarda solo. La misma foto queda como
        foto de portada, así no hay que sacar dos, y se guarda apenas la sacás:
        si el análisis falla, la foto ya está.
      </p>

      {/* Capture moved to GuidedPhotoCapture on 2026-08-30. This panel now
          only RENDERS an outcome — one component takes photographs, another
          shows what the model made of them. Keeping the old single-photo
          button here would give two ways to start an analysis, and one of
          them would spend a request per photo. */}
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

          {/* Sex comes FIRST among the offers, and that ordering is load-bearing:
              the breed wording below cannot be spelled until a sex exists, so
              the block that says "elegí primero el sexo" has to sit under the
              control that supplies one. It is a button, never a pre-filled
              value — decideSex already refuses unless the model actually read
              the genital photograph, and this is the second gate: a human taps
              it. Everything on the site agrees with this word grammatically. */}
          {s.sex.sex && (
            <div className="admin-suggest__offers">
              <span className="t-label">Sexo</span>
              <button
                type="button"
                className="btn btn--muted"
                disabled={disabled || busy}
                onClick={() => onApplySex(s.sex.sex!)}
              >
                {t.sexLabel(s.sex.sex)}
              </button>
              <span className="admin__sub">Leído en la foto de genitales. Confirmá vos.</span>
            </div>
          )}

          {/* Sterilisation is offered ONLY on a positive reading. "no" from a
              photograph is not evidence of anything — a spay scar hides under
              coat and a recent neuter can look unremarkable — and the draft
              already defaults to not sterilised, so offering "no" would dress
              the default up as a finding.

              ⚠️ The wording is a NOUN on purpose. This button can appear before
              a sex has been chosen, and "castrado"/"esterilizada" would have to
              agree with one. The site's answer to that is to spell both forms
              ("Ya está esterilizado o esterilizada" on the form below), never
              a "-o/a" fudge — but that is too long for a button, so this one
              sidesteps agreement entirely. Vocabulary follows the form field:
              esterilización, not castración. */}
          {s.apparentlySterilized === 'yes' && (
            <div className="admin-suggest__offers">
              <span className="t-label">Esterilización</span>
              <button
                type="button"
                className="btn btn--muted"
                disabled={disabled || busy}
                onClick={onApplySterilized}
              >
                Marcar esterilización
              </button>
              <span className="admin__sub">
                Se ve evidencia en la foto. Que lo confirme el veterinario.
              </span>
            </div>
          )}

          <div className="admin-suggest__offers">
            <span className="t-label">Raza</span>
            {s.breed.kind !== 'mixed' ? (
              <button
                type="button"
                className="btn btn--muted"
                disabled={disabled || busy}
                onClick={() => onApplyBreed(s.breed.kind === 'purebred' ? s.breed.breed : '')}
              >
                {s.breed.breed}
              </button>
            ) : sex ? (
              <>
                {/* The resemblance offer comes first, because "mestizo" alone is
                    true but tells an adopter nothing. Plain "mestizo" stays
                    available beside it — the shelter may know the likeness is
                    wrong, and taking the option away would force them to
                    retype it. */}
                <button
                  type="button"
                  className="btn btn--muted"
                  disabled={disabled || busy}
                  onClick={() =>
                    onApplyBreed(t.mixedBreedWithTraits(sex, resembles))
                  }
                >
                  {t.mixedBreedWithTraits(sex, resembles)}
                </button>
                {resembles.length > 0 && (
                  <button
                    type="button"
                    className="btn btn--muted"
                    disabled={disabled || busy}
                    onClick={() => onApplyBreed(t.mixedBreed(sex))}
                  >
                    {t.mixedBreed(sex)}
                  </button>
                )}
              </>
            ) : (
              <span className="admin__sub">
                Elegí primero el sexo: la palabra cambia entre &laquo;mestizo&raquo; y
                &laquo;mestiza&raquo;, y eso no se ve en una foto.
              </span>
            )}
          </div>

          {!s.weight.refused &&
            s.weight.weightKgMin !== null &&
            s.weight.weightKgMax !== null && (
              <div className="admin-suggest__offers">
                <span className="t-label">Peso aproximado</span>
                <button
                  type="button"
                  className="btn btn--muted"
                  disabled={disabled || busy}
                  onClick={() =>
                    onApplyWeight(s.weight.weightKgMin!, s.weight.weightKgMax!)
                  }
                >
                  {s.weight.weightKgMin}–{s.weight.weightKgMax} kg
                </button>
              </div>
            )}

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
          {s.colorPattern && (
            <p className="admin__sub">Color: {s.colorPattern}</p>
          )}
          {s.coatType && <p className="admin__sub">Pelaje: {s.coatType}</p>}
          {s.generalObservations && (
            <p className="admin__sub">Se observa: {s.generalObservations}</p>
          )}
          {s.distinguishingMarks && (
            <p className="admin__sub">Señas: {s.distinguishingMarks}</p>
          )}

          {s.notes && (
            <p className="auth__hint">
              <strong>Para revisar:</strong> {endWithStop(s.notes)}{' '}
              <em>Esto no es un diagnóstico — que lo vea el veterinario.</em>
            </p>
          )}

          {/* ── why something is missing ──────────────────────────────────── */}
          {s.withheld.length > 0 && (
            <ul className="admin-suggest__withheld">
              {s.withheld.map((field) => (
                <li key={field} className="admin__sub">
                  {field === 'sex'
                    ? SEX_WITHHELD_REASON[s.sex.refusedBecause ?? 'low-confidence']
                    : (WITHHELD_REASON[field] ?? `No se pudo estimar: ${field}.`)}
                </li>
              ))}
            </ul>
          )}

          {/* ⚠️ This paragraph used to read "el sexo nunca se sugiere". That was
              true until the genital slot existed, and it survived the change —
              the model layer began reading sex from that photograph while this
              line went on telling the admin it never would. Sex is still never
              GUESSED: decideSex refuses outright without the photograph, and
              demands high confidence with it. */}
          <p className="admin__sub">
            El sexo sólo se sugiere si se llega a ver en la foto de genitales — nunca se
            deduce del tamaño ni del porte. Siempre lo confirmás vos: de él dependen todos
            los textos del sitio.
          </p>
        </div>
      )}
    </div>
  );
}
