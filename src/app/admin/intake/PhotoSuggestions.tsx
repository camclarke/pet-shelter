'use client';

import type { SuggestOutcome } from '@/lib/intake-suggest-client';

/**
 * What the photographs SHOW. Not what the record holds.
 *
 * ── The split, and why it changed on 2026-09-02 ──────────────────────────────
 * This panel used to do both jobs: it printed the model's reading of every
 * field AND offered buttons to accept them, while the form below asked for the
 * same fields again as empty controls. The screen therefore said
 * `Sexo: Hembra` and then, a few centimetres lower, `Sexo: [Elegir…]` — two
 * questions about one animal, the second implying the first was not recorded.
 * Reported by the shelter.
 *
 * Now every per-field reading lands in that field's own row (see
 * EditableField.tsx) and this panel keeps only what has no field to land in:
 * the qualitative description, the things worth a second look, and the reason
 * a reading was withheld. One surface per fact.
 *
 * ── What this is NOT ─────────────────────────────────────────────────────────
 * It is not an identification system and it must never read as one. Everything
 * it produces is a suggestion an admin standing next to the animal accepts or
 * ignores, and the copy says so. Plan §4.8: the review gate is not optional.
 */

export interface PhotoSuggestionsProps {
  outcome: SuggestOutcome | null;
  busy: boolean;
  disabled: boolean;
  /**
   * Only ever offered on a positive reading — see the sterilisation block.
   *
   * This is the one offer left in this panel, because its field lives on step
   * 3 and has no row here to attach to. Everything else moved into its row.
   */
  onApplySterilized: () => void;
}

/**
 * Why a reading is missing.
 *
 * Exported because each field's own row renders its reason: an explanation is
 * only useful beside the empty thing it explains, and a list of them at the
 * bottom of a panel makes the reader correlate by hand.
 */
export const WITHHELD_REASON: Record<string, string> = {
  species: 'No se pudo reconocer la especie con seguridad en esta foto.',
  age: 'No se pudo estimar la edad. Ayuda una foto de los dientes, de frente y con buena luz.',
  size: 'No se puede estimar el tamaño sin algo que dé escala: una mano, una puerta, un plato.',
  weight:
    'No se puede estimar el peso sin algo que dé escala en la foto. Toma otra con una mano, una puerta o un plato al lado.',
};

/**
 * Sex is withheld for two very different reasons and they need different
 * copy: one is a missing photograph the admin can go and take, the other is a
 * photograph that was taken and could not be read. A single message would send
 * someone to re-shoot a photo they already have.
 */
export const SEX_WITHHELD_REASON: Record<string, string> = {
  'no-genital-photo':
    'El sexo no se estima sin la foto de genitales: es la única forma de leerlo, y nunca se deduce del tamaño ni del porte. Elígelo a mano, o toma esa foto.',
  'low-confidence':
    'Se vio la foto de genitales pero no alcanzó para estar seguros. Elige el sexo a mano — de él dependen todos los textos del sitio.',
};

// ⚠️ Every one of these must say what happened to the PHOTO, because the photo
// is uploaded before the model is called and therefore survives every failure
// below. Saying only "no pudimos analizar" reads as "nothing happened" and
// sends someone hunting for a photo that is already saved — reported from a
// real phone, 2026-08-30.
const FAILURE_TEXT: Record<string, string> = {
  'not-configured':
    'La foto se guardó y queda como portada. Las sugerencias automáticas todavía no están configuradas, así que carga los datos a mano.',
  unauthorized:
    'Tu sesión venció. La foto se guardó igual. Vuelve a entrar e inténtalo de nuevo.',
  'photo-rejected':
    'No pudimos leer esa imagen. Prueba tomando la foto de nuevo, o elige una JPG o PNG de menos de 6 MB.',
  timeout:
    'La foto se guardó y queda como portada. El análisis tardó demasiado y lo cortamos — puede ser la señal. Puedes tocar «Analizar» otra vez para reintentar, o cargar los datos a mano y seguir.',
  failed:
    'La foto se guardó y queda como portada. Solo falló el análisis automático: carga los datos a mano y sigue, no se pierde nada.',
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
  onApplySterilized,
}: PhotoSuggestionsProps) {
  const s = outcome?.suggestion ?? null;

  return (
    <div className="admin-suggest">
      <h2 className="t-label">Lo que se ve en las fotos</h2>
      <p className="admin__sub">
        Toma las fotos que puedas y completamos lo que se alcance a ver.{' '}
        <strong>Tú revisas todo antes de publicar</strong> — nada se guarda solo. La
        foto de frente queda como foto de portada, así no hay que tomar dos, y se
        guarda apenas la tomas: si el análisis falla, la foto ya está.
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
          {/* ── context, no field to land in ──────────────────────────────── */}
          {s.visibleType && (
            <p className="admin__sub">
              Lo que se ve: <em>{s.visibleType}</em>
            </p>
          )}
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

          {/* Sterilisation is offered ONLY on a positive reading. "no" from a
              photograph is not evidence of anything — a spay scar hides under
              coat and a recent neuter can look unremarkable — and the draft
              already defaults to not sterilised, so offering "no" would dress
              the default up as a finding.

              ⚠️ The wording is a NOUN on purpose. This button can appear before
              a sex has been chosen, and "castrado"/"esterilizada" would have to
              agree with one. The site's answer to that is to spell both forms,
              never a "-o/a" fudge — but that is too long for a button, so this
              one sidesteps agreement entirely. Vocabulary follows the form
              field: esterilización, not castración. */}
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
                Se ve evidencia en la foto. Que lo confirme el veterinario. El dato
                queda en el paso «Historia».
              </span>
            </div>
          )}

          {/* ⚠️ This paragraph used to read "el sexo nunca se sugiere". That was
              true until the genital slot existed, and it survived the change —
              the model layer began reading sex from that photograph while this
              line went on telling the admin it never would. Sex is still never
              GUESSED: decideSex refuses outright without the photograph, and
              demands high confidence with it. */}
          <p className="admin__sub">
            El sexo sólo se sugiere si se llega a ver en la foto de genitales — nunca se
            deduce del tamaño ni del porte. Siempre lo confirmas tú: de él dependen todos
            los textos del sitio.
          </p>
        </div>
      )}
    </div>
  );
}
