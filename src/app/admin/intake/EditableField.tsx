'use client';

import { useId, type ReactNode } from 'react';

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
  /**
   * Set when this field is what stands between the animal and its public
   * page, AND the person has shown they mean to publish. The wizard decides
   * the second half (`hasPublishIntent`), never this component — the register
   * path must stay calm, so a row is never marked just for being empty.
   */
  problem?: ReactNode;
  /** DOM id of the row, so the blocker list can scroll to it. */
  anchorId?: string;
  /** The real control. Rendered only while open, so nothing is duplicated. */
  children: ReactNode;
}

/**
 * The mark and the reason, shared by rows and by the three sections that are
 * not rows (microchip, the cover photo, the descriptions). The "!" is coral as
 * a FILL, where it passes on cream; the reason stays in reading ink.
 */
export function FieldProblem({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p className="field-problem" id={id}>
      <span className="field-problem__mark" aria-hidden="true">
        !
      </span>
      <span className="field-problem__text">{children}</span>
    </p>
  );
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
  problem,
  anchorId,
  children,
}: EditableFieldProps) {
  const empty = value === null || value === '';
  const problemId = useId();
  const hasProblem = problem !== undefined && problem !== null && problem !== false;

  return (
    <div
      className={hasProblem ? 'field-row field-row--problem' : 'field-row'}
      id={anchorId}
      data-editing={editing ? 'true' : undefined}
    >
      <button
        type="button"
        className="field-row__summary"
        onClick={onToggle}
        disabled={disabled}
        aria-expanded={editing}
        aria-invalid={hasProblem ? 'true' : undefined}
        aria-describedby={hasProblem ? problemId : undefined}
      >
        <span className="field-row__label t-label">
          {hasProblem && (
            <span className="field-problem__mark" aria-hidden="true">
              !
            </span>
          )}
          {label}
        </span>
        <span className={empty ? 'field-row__empty' : 'field-row__value'}>
          {empty ? 'Sin definir' : value}
        </span>
        {/* aria-hidden: the button already announces its expanded state, and
            "Cambiar" read after the value would be noise on a screen reader. */}
        <span className="field-row__action" aria-hidden="true">
          {editing ? 'Listo' : 'Cambiar'}
        </span>
      </button>

      {hasProblem && <FieldProblem id={problemId}>{problem}</FieldProblem>}

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
