'use client';

import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@/components/AuthProvider';
import { t } from '@/i18n';
import { formatDate, parseDateInput, toDateInput, todayInputValue } from '@/lib/date-input';
import {
  isOverdue,
  medicalDraftDefaults,
  medicalWarnings,
  protectionLapsed,
  rabiesProtectionStart,
  validateMedicalDraft,
  type MedicalRecordDraft,
} from '@/lib/medical';
import {
  addMedicalRecord,
  deleteMedicalRecord,
  listMedicalRecords,
  updateMedicalRecord,
  type MedicalRecordView,
} from '@/lib/medical-admin';
import type { MedicalRecordKind } from '@/lib/types';

/**
 * The medical history of one animal, and the form that adds to it.
 *
 * Build-order step 7. This is the first thing in the project that WRITES to
 * `pets/{petId}/medical`, a collection whose rules and indexes have existed
 * since 2026-08-02 and 2026-08-16 respectively without a single caller.
 *
 * ── Errors block, clinical warnings do not ───────────────────────────────────
 * Only structurally impossible things stop a save. Everything clinical — a
 * rabies dose recorded before the microchip, an animal under twelve weeks — is
 * shown and left saveable, because the shelter is usually recording something
 * that already happened elsewhere and cannot be changed. A form that refuses
 * the truth gets a paper notebook instead.
 *
 * ── A missing vet or batch is not an incomplete record ───────────────────────
 * ⚠️ Bolivia's free national rabies campaign produces real vaccinations with no
 * named vet and no lot number, and Cochabamba receives the country's largest
 * allocation. Those fields are optional and must never be marked as missing.
 */

const KINDS: MedicalRecordKind[] = [
  'vaccination',
  'deworming',
  'sterilization',
  'surgery',
  'treatment',
  'consultation',
  'serology',
];

export interface MedicalPanelProps {
  petId: string;
  /** Lets the rabies rules be checked. Null when unknown, which is usual. */
  birthdateApprox?: number | null;
  microchipImplantedAt?: number | null;
}

export default function MedicalPanel({
  petId,
  birthdateApprox = null,
  microchipImplantedAt = null,
}: MedicalPanelProps) {
  const { user } = useAuth();

  const [records, setRecords] = useState<MedicalRecordView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<MedicalRecordDraft>(() => ({
    ...medicalDraftDefaults(),
    performedAt: parseDateInput(todayInputValue()).getTime(),
  }));

  const reload = useCallback(async () => {
    try {
      setRecords(await listMedicalRecords(petId));
    } catch (caught) {
      console.error('[medical]', caught);
      setError('No pudimos cargar el historial médico.');
    }
  }, [petId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const errors = validateMedicalDraft(draft);
  const warnings = medicalWarnings(draft, { birthdateApprox, microchipImplantedAt });

  function patch(next: Partial<MedicalRecordDraft>) {
    setDraft((current) => ({ ...current, ...next }));
    setError(null);
  }

  function startNew() {
    setEditingId(null);
    setDraft({
      ...medicalDraftDefaults(),
      performedAt: parseDateInput(todayInputValue()).getTime(),
    });
    setOpen(true);
  }

  function startEdit(record: MedicalRecordView) {
    setEditingId(record.id);
    setDraft({
      kind: record.kind,
      name: record.name,
      performedAt: record.performedAt,
      nextDueAt: record.nextDueAt,
      validFrom: record.validFrom,
      validUntil: record.validUntil,
      veterinarian: record.veterinarian,
      clinic: record.clinic,
      batch: record.batch,
      manufacturer: record.manufacturer,
      notes: record.notes,
    });
    setOpen(true);
  }

  async function save() {
    if (!user || errors.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      if (editingId) {
        await updateMedicalRecord(petId, editingId, draft, user);
      } else {
        await addMedicalRecord(petId, draft, user);
      }
      setOpen(false);
      setEditingId(null);
      await reload();
    } catch (caught) {
      console.error('[medical]', caught);
      setError('No pudimos guardar el registro. Revisá tu conexión y probá de nuevo.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(record: MedicalRecordView) {
    setBusy(true);
    try {
      await deleteMedicalRecord(petId, record.id);
      await reload();
    } catch (caught) {
      console.error('[medical]', caught);
      setError('No pudimos borrar ese registro.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-list">
      <h2 className="t-label">Historial médico</h2>

      {error && <p className="auth__error">{error}</p>}

      {records === null && <p className="admin__sub">Cargando…</p>}

      {records !== null && records.length === 0 && (
        <p className="admin__sub">
          Todavía no hay registros médicos. Anotá las vacunas, desparasitaciones y
          consultas acá — <strong>una vacuna de campaña sin veterinario ni lote también
          cuenta</strong>, no hace falta dejarla afuera por eso.
        </p>
      )}

      {records !== null && records.length > 0 && (
        <ul className="admin-list__items">
          {records.map((r) => (
            <li key={r.id} className="admin-list__item">
              <div>
                <strong>
                  {t.medicalKindLabel(r.kind)} · {r.name}
                </strong>
                <span className="t-data">
                  {formatDate(r.performedAt)}
                  {r.veterinarian ? ` · ${r.veterinarian}` : ''}
                  {r.clinic ? ` · ${r.clinic}` : ''}
                </span>

                {r.nextDueAt !== null && (
                  <span className="t-data">
                    Próxima: {formatDate(r.nextDueAt)}
                    {isOverdue(r.nextDueAt) ? ' · VENCIDA' : ''}
                  </span>
                )}

                {/* Protection lapsing is a DIFFERENT question from a booster
                    being due, so it gets its own line rather than sharing one. */}
                {r.validUntil !== null && protectionLapsed(r.validUntil) && (
                  <span className="t-data">
                    La protección declarada venció el {formatDate(r.validUntil)}
                  </span>
                )}

                {r.batch && <span className="t-data">Lote {r.batch}</span>}
                {r.notes && <span className="t-data">{r.notes}</span>}

                {/* Forward-looking: voice dictation writes llm-extracted
                    records, and a reader must be able to tell them apart. */}
                {r.source === 'llm-extracted' && (
                  <span className="t-data">
                    Dictado y transcrito automáticamente
                    {r.extractedByModel ? ` (${r.extractedByModel})` : ''}
                    {r.confirmedBy ? ` · confirmado por ${r.confirmedBy}` : ' · SIN CONFIRMAR'}
                  </span>
                )}
              </div>

              <div className="admin-list__actions">
                <button
                  type="button"
                  className="btn btn--muted"
                  disabled={busy}
                  onClick={() => startEdit(r)}
                >
                  Editar
                </button>
                <button
                  type="button"
                  className="btn btn--muted"
                  disabled={busy}
                  onClick={() => void remove(r)}
                >
                  Borrar
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {!open && (
        <button type="button" className="btn" disabled={busy} onClick={startNew}>
          Agregar registro
        </button>
      )}

      {open && (
        <div className="admin-form">
          <div className="admin-form__row">
            <label className="auth__field">
              <span className="t-label">Tipo</span>
              <select
                value={draft.kind ?? ''}
                disabled={busy}
                onChange={(e) =>
                  patch({ kind: (e.target.value || null) as MedicalRecordKind | null })
                }
              >
                <option value="">Elegir…</option>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t.medicalKindLabel(k)}
                  </option>
                ))}
              </select>
            </label>

            <label className="auth__field">
              <span className="t-label">Qué se aplicó o se hizo</span>
              <input
                type="text"
                value={draft.name}
                placeholder="Rabia"
                disabled={busy}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </label>
          </div>

          <div className="admin-form__row">
            <label className="auth__field">
              <span className="t-label">Fecha</span>
              <input
                type="date"
                value={draft.performedAt === null ? '' : toDateInput(draft.performedAt)}
                disabled={busy}
                onChange={(e) =>
                  patch({
                    performedAt: e.target.value
                      ? parseDateInput(e.target.value).getTime()
                      : null,
                  })
                }
              />
            </label>

            <label className="auth__field">
              <span className="t-label">Próxima dosis (opcional)</span>
              <input
                type="date"
                value={draft.nextDueAt === null ? '' : toDateInput(draft.nextDueAt)}
                disabled={busy}
                onChange={(e) =>
                  patch({
                    nextDueAt: e.target.value ? parseDateInput(e.target.value).getTime() : null,
                  })
                }
              />
            </label>
          </div>

          <div className="admin-form__row">
            <label className="auth__field">
              <span className="t-label">Protege desde (opcional)</span>
              <input
                type="date"
                value={draft.validFrom === null ? '' : toDateInput(draft.validFrom)}
                disabled={busy}
                onChange={(e) =>
                  patch({
                    validFrom: e.target.value ? parseDateInput(e.target.value).getTime() : null,
                  })
                }
              />
            </label>

            <label className="auth__field">
              <span className="t-label">Protege hasta (opcional)</span>
              <input
                type="date"
                value={draft.validUntil === null ? '' : toDateInput(draft.validUntil)}
                disabled={busy}
                onChange={(e) =>
                  patch({
                    validUntil: e.target.value ? parseDateInput(e.target.value).getTime() : null,
                  })
                }
              />
            </label>
          </div>

          {/* Offered, never imposed. The 21 days is a deterministic legal rule
              (Reg. EU 2026/131), not a clinical judgement — so the system may
              compute it, but a person still chooses to accept it. */}
          {draft.performedAt !== null && draft.validFrom === null && (
            <button
              type="button"
              className="btn btn--muted"
              disabled={busy}
              onClick={() =>
                patch({ validFrom: rabiesProtectionStart(draft.performedAt!) })
              }
            >
              Usar 21 días después (antirrábica)
            </button>
          )}

          <div className="admin-form__row">
            <label className="auth__field">
              <span className="t-label">Veterinario (opcional)</span>
              <input
                type="text"
                value={draft.veterinarian ?? ''}
                disabled={busy}
                onChange={(e) => patch({ veterinarian: e.target.value || null })}
              />
            </label>

            <label className="auth__field">
              <span className="t-label">Clínica o campaña (opcional)</span>
              <input
                type="text"
                value={draft.clinic ?? ''}
                placeholder="Campaña municipal"
                disabled={busy}
                onChange={(e) => patch({ clinic: e.target.value || null })}
              />
            </label>
          </div>

          <div className="admin-form__row">
            <label className="auth__field">
              <span className="t-label">Lote (opcional)</span>
              <input
                type="text"
                value={draft.batch ?? ''}
                disabled={busy}
                onChange={(e) => patch({ batch: e.target.value || null })}
              />
            </label>

            <label className="auth__field">
              <span className="t-label">Laboratorio (opcional)</span>
              <input
                type="text"
                value={draft.manufacturer ?? ''}
                disabled={busy}
                onChange={(e) => patch({ manufacturer: e.target.value || null })}
              />
            </label>
          </div>

          <p className="admin__sub">
            El veterinario y el lote pueden quedar vacíos. Una vacuna de campaña es un
            registro válido y completo aunque no los tenga.
          </p>

          <label className="auth__field">
            <span className="t-label">Notas (opcional)</span>
            <textarea
              value={draft.notes ?? ''}
              rows={2}
              disabled={busy}
              onChange={(e) => patch({ notes: e.target.value || null })}
            />
          </label>

          {/* Warnings first, so nobody reads them as the reason the button is
              disabled — it is not. Only `errors` disables it. */}
          {warnings.map((w) => (
            <p key={w} className="auth__hint">
              {t.medicalWarning(w)}
            </p>
          ))}

          {errors.map((e) => (
            <p key={e} className="auth__error">
              {t.medicalError(e)}
            </p>
          ))}

          <div className="admin-list__actions">
            <button
              type="button"
              className="btn btn--action"
              disabled={busy || errors.length > 0}
              onClick={() => void save()}
            >
              {editingId ? 'Guardar cambios' : 'Guardar registro'}
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
        </div>
      )}
    </section>
  );
}
