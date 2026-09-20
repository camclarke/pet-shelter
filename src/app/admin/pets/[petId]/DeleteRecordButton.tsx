'use client';

import { useState } from 'react';

/**
 * Delete one history record — from INSIDE its open editor, behind a confirm
 * that names what is about to go.
 *
 * ── Why this exists, and why it is not a row action ───────────────────────
 * Until now both history lists carried "Editar" and "Borrar" as full-size
 * buttons on every row, and `remove()` deleted on the first click with no
 * confirmation of any kind. On a phone at 360px those two buttons WRAP and
 * stack, so they were 120px of a 262px row — 46% of it — and the project log
 * already records them shipping flush against each other at a zero gap, "on a
 * phone, where a mis-tap deletes a medical record".
 *
 * Deleting is now two deliberate steps away from a list: open the record, then
 * confirm. That ordering matters more here than in most places, because for
 * the 43 imported animals these rows are the ONLY copy of a history that was
 * read off a handwritten sheet. There is no undo and no backup to restore one
 * record from.
 *
 * ── The confirm names the record, and that is the point ───────────────────
 * "¿Borrar este registro?" guards against deleting by accident. Naming the
 * record — "Vacuna · Octavalente · 14 feb 2024" — also guards against deleting
 * the WRONG one, which is the likelier mistake when an animal has nine of them
 * and several share a kind.
 *
 * `window.confirm` was the cheaper option and is used elsewhere in this repo
 * for discarding a draft. It is not used here: it cannot carry the record's
 * identity legibly, and a browser that has been told to block further dialogs
 * returns false, which would make the button silently do nothing.
 *
 * ── Resetting ─────────────────────────────────────────────────────────────
 * There is deliberately no effect watching the record id. The caller passes a
 * `key` so this remounts per record, which means a half-confirmed delete can
 * never carry over to a different record — the one failure mode here that
 * would be unrecoverable.
 */
export function DeleteRecordButton({
  label,
  disabled,
  onDelete,
}: {
  /** What is about to be deleted, in the words the row shows. */
  label: string;
  disabled: boolean;
  onDelete: () => void;
}) {
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <button
        type="button"
        className="btn btn--muted record-delete__start"
        disabled={disabled}
        onClick={() => setAsking(true)}
      >
        Borrar este registro
      </button>
    );
  }

  /* `.register-warning` rather than a block of its own: the roster already uses
     it to ask a second time before something consequential ("¿De verdad es el
     animalito que tienes adelante?"), which is the same question in a different
     place. Its coral border is also legible in BOTH themes — measured. A sun
     edge, the other candidate, comes out at 1.44:1 on light paper, so the
     marker for "read this" would have been invisible in daylight. */
  return (
    <div className="register-warning" role="alert">
      {/* Full-strength text, deliberately NOT `.admin__sub`: that carries
          opacity 0.75, which lands this sentence at 4.55:1 in light mode —
          barely over AA, for the one sentence that has to be read before data
          is destroyed. A plain <p> inherits the body ink at 9.49:1. */}
      <p>
        ¿Borrar «{label}»? No se puede deshacer, y en las fichas que salieron del registro en
        papel esta es la única copia.
      </p>
      <div className="admin-list__actions">
        <button
          type="button"
          className="btn btn--muted"
          disabled={disabled}
          onClick={() => onDelete()}
        >
          Sí, borrar
        </button>
        {/* Not autofocused, and no form here, so Enter submits nothing — the
            same reasoning the register's confirm card documents. */}
        <button
          type="button"
          className="btn btn--muted"
          disabled={disabled}
          onClick={() => setAsking(false)}
        >
          No, dejarlo
        </button>
      </div>
    </div>
  );
}
