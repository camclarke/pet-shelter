'use client';

import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@/components/AuthProvider';
import { t } from '@/i18n';
import { formatDate, parseDateInput, toDateInput, todayInputValue } from '@/lib/date-input';
import { cardThresholdsFor, type CardField } from '@/lib/card-extraction';
import {
  draftFromRecord,
  medicalDraftDefaults,
  medicalWarnings,
  rabiesProtectionStart,
  recordSignals,
  summarizeMedicalHistory,
  validateMedicalDraft,
  type MedicalRecordDraft,
} from '@/lib/medical';
import {
  addMedicalRecord,
  confirmMedicalRecord,
  deleteMedicalRecord,
  listMedicalRecords,
  updateMedicalRecord,
  type MedicalRecordView,
} from '@/lib/medical-admin';
import { canConfirmAsIs, isConfirmed, type EvidenceThresholds } from '@/lib/review-gate';
import type { MedicalRecordKind } from '@/lib/types';
import CardCapture, { type CardCaptureNotice } from './CardCapture';
import {
  EvidenceHint,
  REVIEW_EVERYTHING,
  SourceDocumentImage,
  UnconfirmedBadge,
} from './ReviewEvidence';

/**
 * The medical history of one animal, the form that adds to it, and the review
 * gate for records a model read off a card.
 *
 * Build-order step 7 built the history and the form; step 9 added the card
 * reader and the gate.
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
 *
 * ── The review gate, plan §4.8 ───────────────────────────────────────────────
 * A record a model read is VISIBLE here and COUNTS FOR NOTHING until a person
 * confirms it:
 *   - its row shows no "VENCIDA" or lapsed flag — those come from
 *     `recordSignals()`, which applies the gate;
 *   - the summary line and the waiting count come from
 *     `summarizeMedicalHistory()`, which applies it too;
 *   - it offers Confirm (one click, only when the record is structurally
 *     complete), Correct-and-confirm (the form, with the model's reading beside
 *     every field), and Discard.
 * `medical-wiring.test.ts` pins that this file computes through those
 * functions and never calls `isOverdue` or `protectionLapsed` directly.
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

const CARD_TEXT_HINT_FIELDS: CardField[] = ['batch', 'manufacturer', 'veterinarian', 'clinic'];

export interface MedicalPanelProps {
  petId: string;
  /** Lets the rabies rules be checked. Null when unknown, which is usual. */
  birthdateApprox?: number | null;
  microchipImplantedAt?: number | null;
}

/** The evidence policy for a record, by where it was read from. */
function thresholdsFor(record: MedicalRecordView, field: CardField): EvidenceThresholds {
  return record.extractedFrom === 'vaccination-card' ? cardThresholdsFor(field) : REVIEW_EVERYTHING;
}

export default function MedicalPanel({
  petId,
  birthdateApprox = null,
  microchipImplantedAt = null,
}: MedicalPanelProps) {
  const { user } = useAuth();

  const [records, setRecords] = useState<MedicalRecordView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<CardCaptureNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<MedicalRecordView | null>(null);
  const [cardShownFor, setCardShownFor] = useState<string | null>(null);
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
  const summary = records ? summarizeMedicalHistory(records) : null;

  // The record under review, when the form is correcting a model's reading.
  const reviewing = editing && !isConfirmed(editing) ? editing : null;

  function patch(next: Partial<MedicalRecordDraft>) {
    setDraft((current) => ({ ...current, ...next }));
    setError(null);
  }

  function startNew() {
    setEditing(null);
    setDraft({
      ...medicalDraftDefaults(),
      performedAt: parseDateInput(todayInputValue()).getTime(),
    });
    setOpen(true);
  }

  function startEdit(record: MedicalRecordView) {
    setEditing(record);
    setDraft(draftFromRecord(record));
    setCardShownFor(null);
    setOpen(true);
  }

  async function save() {
    if (!user || errors.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        // Also the edit-before-confirm path: the person saving vouches for it.
        await updateMedicalRecord(petId, editing.id, draft, user);
      } else {
        await addMedicalRecord(petId, draft, user);
      }
      setOpen(false);
      setEditing(null);
      await reload();
    } catch (caught) {
      console.error('[medical]', caught);
      setError('No pudimos guardar el registro. Revisa tu conexión e inténtalo de nuevo.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm(record: MedicalRecordView) {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      await confirmMedicalRecord(petId, record.id, user);
      await reload();
    } catch (caught) {
      console.error('[medical]', caught);
      setError('No pudimos confirmar ese registro. Revisa tu conexión e inténtalo de nuevo.');
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

  /** The model's reading of one field, under that field's input in the form. */
  function formHint(field: CardField, always = false) {
    if (!reviewing?.extractionEvidence) return null;
    return (
      <EvidenceHint
        evidence={reviewing.extractionEvidence[field]}
        thresholds={thresholdsFor(reviewing, field)}
        always={always}
      />
    );
  }

  return (
    <section className="admin-list">
      <h2 className="t-label">Historial médico</h2>

      {error && <p className="auth__error">{error}</p>}

      {notice && (
        <p
          className={notice.tone === 'error' ? 'auth__error' : 'auth__notice'}
          role="status"
        >
          {notice.text}
        </p>
      )}

      {summary && summary.awaitingReview > 0 && (
        <p className="auth__notice auth__notice--warn">
          <strong>{t.awaitingReviewCount(summary.awaitingReview)}.</strong>{' '}
          {t.medicalReview.notCounted}
        </p>
      )}

      {/* From confirmed records only — summarizeMedicalHistory applies the gate. */}
      {summary?.nextDue && summary.nextDue.nextDueAt !== null && (
        <p className="admin__sub">
          {t.nextDueSummary(summary.nextDue.name, formatDate(summary.nextDue.nextDueAt))}
        </p>
      )}

      {records === null && <p className="admin__sub">Cargando…</p>}

      {records !== null && records.length === 0 && (
        <p className="admin__sub">
          Todavía no hay registros médicos. Anota las vacunas, desparasitaciones y
          consultas aquí — <strong>una vacuna de campaña sin veterinario ni lote también
          cuenta</strong>, no hace falta dejarla afuera por eso.
        </p>
      )}

      {records !== null && records.length > 0 && (
        <ul className="admin-list__items">
          {records.map((r) => {
            const confirmed = isConfirmed(r);
            const signals = recordSignals(r);
            const evidence = confirmed ? null : r.extractionEvidence;
            const confirmableNow = canConfirmAsIs(validateMedicalDraft(draftFromRecord(r)));
            const hint = (field: CardField, always = false) =>
              evidence ? (
                <EvidenceHint
                  label={t.cardFieldLabel(field)}
                  evidence={evidence[field]}
                  thresholds={thresholdsFor(r, field)}
                  always={always}
                />
              ) : null;

            return (
              <li
                key={r.id}
                className={`admin-list__item admin-list__item--record${
                  confirmed ? '' : ' admin-list__item--unconfirmed'
                }`}
              >
                <div>
                  {!confirmed && <UnconfirmedBadge />}

                  <strong>
                    {r.kind ? t.medicalKindLabel(r.kind) : t.medicalReview.unknownKind} ·{' '}
                    {r.name || t.medicalReview.unknownName}
                  </strong>
                  {hint('kind')}
                  {hint('name')}

                  <span className="t-data">
                    {r.performedAt !== null ? formatDate(r.performedAt) : t.medicalReview.unknownDate}
                    {r.veterinarian ? ` · ${r.veterinarian}` : ''}
                    {r.clinic ? ` · ${r.clinic}` : ''}
                  </span>
                  {hint('performedAt', true)}

                  {/* ⚠️ Both flags come from recordSignals(), which applies the
                      review gate: an unconfirmed record never reads "VENCIDA". */}
                  {r.nextDueAt !== null && (
                    <span className="t-data">
                      Próxima: {formatDate(r.nextDueAt)}
                      {signals.overdue ? ' · VENCIDA' : ''}
                    </span>
                  )}
                  {hint('nextDueAt', true)}

                  {/* Protection lapsing is a DIFFERENT question from a booster
                      being due, so it gets its own line rather than sharing one. */}
                  {r.validUntil !== null && signals.lapsed && (
                    <span className="t-data">
                      La protección declarada venció el {formatDate(r.validUntil)}
                    </span>
                  )}

                  {r.batch && <span className="t-data">Lote {r.batch}</span>}
                  {CARD_TEXT_HINT_FIELDS.map((field) => (
                    <span key={field} className="evidence-slot">
                      {hint(field)}
                    </span>
                  ))}
                  {r.notes && <span className="t-data">{r.notes}</span>}

                  {r.source === 'llm-extracted' && (
                    <span className="t-data">
                      {t.extractionSourceLabel(r.extractedFrom)}
                      {r.extractedByModel ? ` (${r.extractedByModel})` : ''}
                      {r.confirmedBy ? ` · ${t.confirmedByLabel(r.confirmedBy)}` : ''}
                    </span>
                  )}

                  {!confirmed && !confirmableNow && (
                    <p className="auth__hint">{t.medicalReview.confirmNeedsEdit}</p>
                  )}

                  {cardShownFor === r.id && r.sourceDocument && (
                    <SourceDocumentImage path={r.sourceDocument} alt={t.medicalReview.cardAlt} />
                  )}
                </div>

                <div className="admin-list__actions">
                  {confirmed ? (
                    <>
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
                    </>
                  ) : (
                    <>
                      {/* One click, and only when the record is structurally
                          complete. A candidate missing its date or kind goes
                          through the form: a record without them is not one. */}
                      {confirmableNow && (
                        <button
                          type="button"
                          className="btn"
                          disabled={busy || !user}
                          onClick={() => void confirm(r)}
                        >
                          {t.medicalReview.confirm}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn--muted"
                        disabled={busy}
                        onClick={() => startEdit(r)}
                      >
                        {t.medicalReview.correctAndConfirm}
                      </button>
                      {r.sourceDocument && (
                        <button
                          type="button"
                          className="btn btn--muted"
                          disabled={busy}
                          onClick={() => setCardShownFor(cardShownFor === r.id ? null : r.id)}
                        >
                          {cardShownFor === r.id
                            ? t.medicalReview.hideCard
                            : t.medicalReview.showCard}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn--muted"
                        disabled={busy}
                        onClick={() => void remove(r)}
                      >
                        {t.medicalReview.discard}
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {!open && (
        <>
          <button type="button" className="btn" disabled={busy} onClick={startNew}>
            Agregar registro
          </button>

          <CardCapture
            petId={petId}
            user={user}
            disabled={busy}
            onSettled={(next) => {
              setNotice(next);
              void reload();
            }}
          />
        </>
      )}

      {open && (
        <div className="admin-form">
          {reviewing && (
            <>
              <p className="auth__notice auth__notice--warn">{t.medicalReview.reviewingNotice}</p>
              {reviewing.sourceDocument && (
                <SourceDocumentImage
                  path={reviewing.sourceDocument}
                  alt={t.medicalReview.cardAlt}
                />
              )}
            </>
          )}

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
              {formHint('kind')}
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
              {formHint('name')}
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
              {formHint('performedAt', true)}
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
              {formHint('nextDueAt', true)}
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
              {formHint('veterinarian')}
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
              {formHint('clinic')}
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
              {formHint('batch')}
            </label>

            <label className="auth__field">
              <span className="t-label">Laboratorio (opcional)</span>
              <input
                type="text"
                value={draft.manufacturer ?? ''}
                disabled={busy}
                onChange={(e) => patch({ manufacturer: e.target.value || null })}
              />
              {formHint('manufacturer')}
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
              {reviewing
                ? t.medicalReview.saveAndConfirm
                : editing
                  ? 'Guardar cambios'
                  : 'Guardar registro'}
            </button>
            <button
              type="button"
              className="btn btn--muted"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setEditing(null);
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
