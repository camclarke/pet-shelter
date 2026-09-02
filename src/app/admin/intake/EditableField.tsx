'use client';

import { type ReactNode } from 'react';

/**
 * One field of the intake form, shown as its VALUE and edited by clicking it.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Until 2026-09-02 the identity step showed every field twice: once in "Lo que
 * se ve en las fotos", where the model's reading was displayed, and again a few
 * centimetres below as an empty form control asking for the same thing. So the
 * screen said `Sexo: Hembra` and then `Sexo: [Elegir…]`, which reads as two
 * different questions about one animal — and the second one looks like the
 * first was not recorded. Reported by the shelter.
 *
 * The fix is not to hide the form. It is to stop having two surfaces: the
 * value IS the control. What the model read, what a person typed, and what is
 * still missing all render the same way, in one place per field, and a click
 * opens the editor for that one field.
 *
 * ── Why a summary BUTTON rather than a permanently open input ───────────────
 * Intake happens on a phone, one-handed, often with an animal in the other
 * arm. Eleven always-open controls is a long scroll of empty boxes; eleven
 * one-line rows is a legible summary of what is known so far, which is also
 * the thing an admin needs before publishing. The editor is one tap away and
 * never more than one field is open, so the answer to "what did I just change"
 * is always on screen.
 */
export interface FieldOffer {
  /** The button face — exactly what accepting will store. */
  label: ReactNode;
  onAccept: () => void;
}

export interface EditableFieldProps {
  label: string;
  /**
   * The current value, already formatted for reading. `null` means the field
   * is genuinely empty — rendered as "Sin definir" rather than as a blank,
   * because a blank row is indistinguishable from a rendering bug.
   */
  value: ReactNode | null;
  /**
   * Where the value came from, or why it is missing. Provenance belongs next
   * to the value it explains: an admin deciding whether to trust "Hembra"
   * needs "leída en la foto de genitales" in the same glance, not in a
   * separate panel they have to correlate by hand.
   */
  note?: ReactNode;
  /** Guidance that only matters while editing. Hidden when collapsed. */
  hint?: ReactNode;
  /**
   * Unaccepted readings from the photographs. Shown as buttons, never applied
   * silently — accepting is the human's second gate, and for `sex` it is the
   * only one that involves a person at all.
   */
  offers?: readonly FieldOffer[];
  editing: boolean;
  onToggle: () => void;
  disabled?: boolean;
  /** The real control. Rendered only while open, so nothing is duplicated. */
  children: ReactNode;
}

export default function EditableField({
  label,
  value,
  note,
  hint,
  offers,
  editing,
  onToggle,
  disabled = false,
  children,
}: EditableFieldProps) {
  const empty = value === null || value === '';

  return (
    <div className="field-row" data-editing={editing ? 'true' : undefined}>
      <button
        type="button"
        className="field-row__summary"
        onClick={onToggle}
        disabled={disabled}
        aria-expanded={editing}
      >
        <span className="field-row__label t-label">{label}</span>
        <span className={empty ? 'field-row__empty' : 'field-row__value'}>
          {empty ? 'Sin definir' : value}
        </span>
        {/* aria-hidden: the button already announces its expanded state, and
            "Cambiar" read after the value would be noise on a screen reader. */}
        <span className="field-row__action" aria-hidden="true">
          {editing ? 'Listo' : 'Cambiar'}
        </span>
      </button>

      {note && <p className="field-row__note">{note}</p>}

      {!editing && offers && offers.length > 0 && (
        <div className="field-row__offers">
          {offers.map((offer, i) => (
            <button
              key={i}
              type="button"
              className="btn btn--muted"
              disabled={disabled}
              onClick={offer.onAccept}
            >
              {offer.label}
            </button>
          ))}
        </div>
      )}

      {editing && (
        <div className="field-row__editor">
          {children}
          {hint && <small className="auth__hint">{hint}</small>}
        </div>
      )}
    </div>
  );
}
