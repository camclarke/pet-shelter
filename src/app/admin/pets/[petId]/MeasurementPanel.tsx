'use client';

import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@/components/AuthProvider';
import { t } from '@/i18n';
import { formatDate, parseDateInput, toDateInput, todayInputValue } from '@/lib/date-input';
import {
  BCS_SCORES,
  MUSCLE_CONDITIONS,
  daysSinceMeasured,
  latestBodyCondition,
  latestWeight,
  measurementDraftDefaults,
  measurementWarnings,
  validateMeasurementDraft,
  type MeasurementDraft,
} from '@/lib/measurements';
import {
  addMeasurement,
  deleteMeasurement,
  listMeasurements,
  updateMeasurement,
  type MeasurementView,
} from '@/lib/measurements-admin';
import type { MuscleCondition, Species } from '@/lib/types';
import { DeleteRecordButton } from './DeleteRecordButton';

/**
 * Weight and body condition for one animal. Build-order step 10, plan §2.7.
 *
 * The first writer `pets/{petId}/measurements` has ever had: its rule was
 * written on 2026-08-16 and nothing called it until now.
 *
 * ── A weight here is a measurement, and nothing else becomes one ────────────
 * The shelter has a scale (plan §11 #7, answered 2026-09-12), so a number saved
 * here is shown plainly and is what dosing and rations will read. The intake
 * photos' estimated range is shown ALONGSIDE when no weight exists, labelled
 * as unfit for a dose, and is never offered as a value. There is deliberately
 * no "use the estimate" button: a prefilled number is one tap from being saved
 * as a weighing that never happened.
 *
 * ── No reminders ────────────────────────────────────────────────────────────
 * Animals are weighed when sick or at a vet visit, not on a schedule, so there
 * is nothing to be overdue against. What IS shown is how old the latest weight
 * is, because that decides whether it can still be trusted.
 */

/**
 * One measurement in the words its row shows, for the tap target's accessible
 * name and for the delete confirm.
 *
 * The date is part of it because a weight on its own does not identify a
 * weighing — a dog weighed monthly has several that read the same.
 */
function measurementLabel(r: MeasurementView): string {
  const parts = [
    r.weightKg !== null ? t.formatKg(r.weightKg) : null,
    r.bcs !== null ? `Condición ${t.bodyConditionLabel(r.bcs)}` : null,
    r.mcs ? t.muscleConditionLabel(r.mcs) : null,
  ].filter(Boolean);
  return `${parts.join(' · ') || '—'} · ${formatDate(r.measuredAt)}`;
}

function freshDraft(): MeasurementDraft {
  return {
    ...measurementDraftDefaults(),
    measuredAt: parseDateInput(todayInputValue()).getTime(),
  };
}

export interface MeasurementPanelProps {
  petId: string;
  species: Species | null;
  /** The intake photos' estimated range. Shown for context, never used as a value. */
  estimatedKgMin: number | null;
  estimatedKgMax: number | null;
}

export default function MeasurementPanel({
  petId,
  species,
  estimatedKgMin,
  estimatedKgMax,
}: MeasurementPanelProps) {
  const { user } = useAuth();

  const [records, setRecords] = useState<MeasurementView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<MeasurementDraft>(freshDraft);

  /**
   * The record being edited, resolved from the id rather than stored twice.
   * Null while adding, and null if it has gone — a reload that drops it must
   * not leave a delete button pointing at an id nothing answers for.
   */
  const editingRecord =
    editingId === null ? null : (records?.find((r) => r.id === editingId) ?? null);

  const reload = useCallback(async () => {
    try {
      setRecords(await listMeasurements(petId));
    } catch (caught) {
      // Left as null rather than set to []: an empty list would render "no
      // measurements yet", which is a confident statement about an animal
      // whose history simply failed to load.
      console.error('[measurements]', caught);
      setError('No pudimos cargar el peso y la condición corporal.');
    }
  }, [petId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const errors = validateMeasurementDraft(draft);
  const warnings = measurementWarnings(draft, {
    species,
    history: records ?? [],
    editingId,
  });

  const weight = records ? latestWeight(records) : null;
  const condition = records ? latestBodyCondition(records) : null;

  function patch(next: Partial<MeasurementDraft>) {
    setDraft((current) => ({ ...current, ...next }));
    setError(null);
  }

  function startNew() {
    setEditingId(null);
    setDraft(freshDraft());
    setOpen(true);
  }

  function startEdit(record: MeasurementView) {
    setEditingId(record.id);
    setDraft({
      weightText: record.weightKg === null ? '' : t.formatKgInput(record.weightKg),
      bcs: record.bcs,
      mcs: record.mcs,
      measuredAt: record.measuredAt,
      measuredBy: record.measuredBy,
      note: record.note,
    });
    setOpen(true);
  }

  async function save() {
    if (!user || errors.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      if (editingId) {
        await updateMeasurement(petId, editingId, draft, user);
      } else {
        await addMeasurement(petId, draft, user);
      }
      setOpen(false);
      setEditingId(null);
      await reload();
    } catch (caught) {
      console.error('[measurements]', caught);
      setError('No pudimos guardar la medición. Revisa tu conexión e inténtalo de nuevo.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(record: MeasurementView) {
    setBusy(true);
    try {
      await deleteMeasurement(petId, record.id);
      // Close ONLY on success, for the reason written out in MedicalPanel: this
      // is reached from inside the record's editor now, and closing in a
      // `finally` would hide the failure behind a list that still shows it.
      setOpen(false);
      setEditingId(null);
      await reload();
    } catch (caught) {
      console.error('[measurements]', caught);
      setError('No pudimos borrar esa medición.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-list">
      <h2 className="t-label">Peso y condición corporal</h2>

      {error && <p className="auth__error">{error}</p>}

      {records === null && !error && <p className="admin__sub">Cargando…</p>}

      {weight && (
        <p className="place-now">
          Último peso: <strong>{t.formatKg(weight.kg)}</strong>,{' '}
          {t.daysAgoLabel(daysSinceMeasured(weight.measuredAt))} ({formatDate(weight.measuredAt)})
        </p>
      )}

      {condition && (
        <p className="admin__sub">
          Condición corporal: {t.bodyConditionLabel(condition.bcs)},{' '}
          {t.daysAgoLabel(daysSinceMeasured(condition.measuredAt))}
        </p>
      )}

      {records !== null &&
        !weight &&
        (estimatedKgMin !== null && estimatedKgMax !== null ? (
          <p className="admin__sub">
            Sin peso medido. Las fotos de ingreso estimaron{' '}
            {t.formatKgRange(estimatedKgMin, estimatedKgMax)}: sirve para elegir corral o una
            ración aproximada, <strong>no para calcular una dosis</strong>.
          </p>
        ) : records.length === 0 ? (
          <p className="admin__sub">
            Todavía no hay mediciones. Anota el peso cada vez que pase por la balanza, y la
            condición corporal cuando se evalúe en la consulta.
          </p>
        ) : (
          <p className="admin__sub">Todavía no hay un peso medido.</p>
        ))}

      {records !== null && records.length > 0 && (
        <ul className="admin-list__items">
          {records.map((r) => {
            const headline = [
              r.weightKg !== null ? t.formatKg(r.weightKg) : null,
              r.bcs !== null ? `Condición ${t.bodyConditionLabel(r.bcs)}` : null,
            ]
              .filter(Boolean)
              .join(' · ');

            return (
              <li key={r.id} className="admin-list__item admin-list__item--record record-row">
                {/* The row opens the measurement and never deletes it — see
                    MedicalPanel for the reasoning and DeleteRecordButton for
                    where deleting went. A <span> inside, because a <button>
                    may not contain flow content. */}
                <button
                  type="button"
                  className="record-row__open"
                  disabled={busy}
                  onClick={() => startEdit(r)}
                  aria-label={`Corregir: ${measurementLabel(r)}`}
                >
                <span className="record-row__text">
                  <strong>
                    {headline || (r.mcs ? t.muscleConditionLabel(r.mcs) : '—')}
                  </strong>
                  <span className="t-data">
                    {formatDate(r.measuredAt)}
                    {r.measuredBy ? ` · ${r.measuredBy}` : ''}
                  </span>
                  {headline && r.mcs && (
                    <span className="t-data">{t.muscleConditionLabel(r.mcs)}</span>
                  )}
                  {r.note && <span className="t-data">{r.note}</span>}
                  {r.recordedBy && <span className="t-data">Anotado por {r.recordedBy}</span>}
                </span>
                  <span className="record-row__go" aria-hidden="true">
                    ›
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!open && (
        <button type="button" className="btn" disabled={busy} onClick={startNew}>
          Agregar medición
        </button>
      )}

      {open && (
        <div className="admin-form">
          <div className="admin-form__row">
            <label className="auth__field">
              <span className="t-label">Fecha</span>
              <input
                type="date"
                max={todayInputValue()}
                value={draft.measuredAt === null ? '' : toDateInput(draft.measuredAt)}
                disabled={busy}
                onChange={(e) =>
                  patch({
                    measuredAt: e.target.value ? parseDateInput(e.target.value).getTime() : null,
                  })
                }
              />
            </label>

            {/* Text with a decimal keypad, NOT type="number": a number input
                in an es locale may hand back "" for "12,5", and a comma the
                browser silently discards is a factor of ten in a dose. */}
            <label className="auth__field">
              <span className="t-label">Peso en kg</span>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder="12,5"
                value={draft.weightText}
                disabled={busy}
                onChange={(e) => patch({ weightText: e.target.value })}
              />
            </label>
          </div>

          <div className="admin-form__row">
            <label className="auth__field">
              <span className="t-label">Condición corporal (1 a 9)</span>
              <select
                value={draft.bcs ?? ''}
                disabled={busy}
                onChange={(e) => patch({ bcs: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">Sin evaluar</option>
                {BCS_SCORES.map((score) => (
                  <option key={score} value={score}>
                    {t.bodyConditionLabel(score)}
                  </option>
                ))}
              </select>
            </label>

            <label className="auth__field">
              <span className="t-label">Masa muscular</span>
              <select
                value={draft.mcs ?? ''}
                disabled={busy}
                onChange={(e) =>
                  patch({ mcs: (e.target.value || null) as MuscleCondition | null })
                }
              >
                <option value="">Sin evaluar</option>
                {MUSCLE_CONDITIONS.map((condition) => (
                  <option key={condition} value={condition}>
                    {t.muscleConditionLabel(condition)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <p className="admin__sub">
            Basta con uno de los tres. La condición corporal es la escala de 9 puntos de WSAVA.
          </p>

          <label className="auth__field">
            <span className="t-label">Quién pesó o evaluó (opcional)</span>
            <input
              type="text"
              value={draft.measuredBy ?? ''}
              disabled={busy}
              onChange={(e) => patch({ measuredBy: e.target.value || null })}
            />
          </label>

          <label className="auth__field">
            <span className="t-label">Nota (opcional)</span>
            <textarea
              value={draft.note ?? ''}
              rows={2}
              disabled={busy}
              onChange={(e) => patch({ note: e.target.value || null })}
            />
          </label>

          {/* Warnings first, so nobody reads them as the reason the button is
              disabled — it is not. Only `errors` disables it. */}
          {warnings.map((w) => (
            <p key={w.kind} className="auth__hint">
              {t.measurementWarning(w)}
            </p>
          ))}

          {errors.map((e) => (
            <p key={e} className="auth__error">
              {t.measurementError(e)}
            </p>
          ))}

          <div className="admin-list__actions">
            <button
              type="button"
              className="btn btn--action"
              disabled={busy || errors.length > 0}
              onClick={() => void save()}
            >
              {editingId ? 'Guardar cambios' : 'Guardar medición'}
            </button>
            <button
              type="button"
              className="btn btn--muted"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setEditingId(null);
              }}
            >
              Cancelar
            </button>
          </div>

          {/* Only on a measurement that exists, never while adding one. `key`
              remounts the confirm per record so a half-confirmed delete cannot
              carry across to a different one. */}
          {editingRecord && (
            <DeleteRecordButton
              key={editingRecord.id}
              label={measurementLabel(editingRecord)}
              disabled={busy}
              onDelete={() => void remove(editingRecord)}
            />
          )}
        </div>
      )}
    </section>
  );
}
