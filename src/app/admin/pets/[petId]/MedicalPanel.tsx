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
  discardMedicalCandidate,
  listMedicalCandidates,
  listMedicalRecords,
  updateMedicalRecord,
  type MedicalCandidateView,
  type MedicalRecordView,
} from '@/lib/medical-admin';
import { CandidateGoneError, MedicalConfirmationError } from '@/lib/medical-candidates';
import { canConfirmAsIs, isConfirmed, type EvidenceThresholds } from '@/lib/review-gate';
import type { MedicalExtractionSource, MedicalRecordKind } from '@/lib/types';
import CardCapture, { type CardCaptureNotice } from './CardCapture';
import {
  EvidenceHint,
  REVIEW_EVERYTHING,
  SourceDocumentImage,
  UnconfirmedBadge,
} from './ReviewEvidence';

/**
 * The medical history of one animal, the form that adds to it, and the review
 * of what a model read off a card.
 *
 * Build-order step 7 built the history and the form; step 9 added the card
 * reader and the review.
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
 * ── The review, plan §4.8 ────────────────────────────────────────────────────
 * What a model read is a CANDIDATE, listed separately under "Por revisar" from
 * the admin-only `medicalCandidates`. It is not a medical record and counts for
 * nothing. Confirmar (one click, only when complete), Corregir y confirmar and
 * Descartar all go through `confirmMedicalRecord` / `discardMedicalCandidate`,
 * and `confirmMedicalRecord` validates completeness itself.
 *
 * The confirmed history still draws its flags through `recordSignals()` and
 * its summary through `summarizeMedicalHistory()`, which apply the review gate
 * as defence in depth. `medical-wiring.test.ts` pins that this file never calls
 * `isOverdue`, `protectionLapsed` or `nextDue` directly.
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

type Editing =
  | { kind: 'record'; record: MedicalRecordView }
  | { kind: 'candidate'; candidate: MedicalCandidateView }
  | null;

/** The evidence policy for a reading, by where it was read from. */
function thresholdsFor(source: MedicalExtractionSource | null, field: CardField): EvidenceThresholds {
  return source === 'vaccination-card' ? cardThresholdsFor(field) : REVIEW_EVERYTHING;
}

/** What to tell the person when a save, a confirmation or a discard fails. */
function failureMessage(caught: unknown, fallback: string): string {
  if (caught instanceof MedicalConfirmationError) {
    return caught.errors.map((e) => t.medicalError(e)).join(' ');
  }
  if (caught instanceof CandidateGoneError) return t.medicalReview.candidateGone;
  return fallback;
}

export default function MedicalPanel({
  petId,
  birthdateApprox = null,
  microchipImplantedAt = null,
}: MedicalPanelProps) {
  const { user } = useAuth();

  const [records, setRecords] = useState<MedicalRecordView[] | null>(null);
  const [candidates, setCandidates] = useState<MedicalCandidateView[] | null>(null);
  const [candidatesFailed, setCandidatesFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<CardCaptureNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [cardShownFor, setCardShownFor] = useState<string | null>(null);
  const [draft, setDraft] = useState<MedicalRecordDraft>(() => ({
    ...medicalDraftDefaults(),
    performedAt: parseDateInput(todayInputValue()).getTime(),
  }));

  const reload = useCallback(async () => {
    // Loaded apart, so one failing cannot blank the other. The candidate rule
    // is new; if it is not deployed yet, the confirmed history must still show.
    const [recordsResult, candidatesResult] = await Promise.allSettled([
      listMedicalRecords(petId),
      listMedicalCandidates(petId),
    ]);
    if (recordsResult.status === 'fulfilled') {
      setRecords(recordsResult.value);
    } else {
      console.error('[medical]', recordsResult.reason);
      setError('No pudimos cargar el historial médico.');
    }
    if (candidatesResult.status === 'fulfilled') {
      setCandidates(candidatesResult.value);
      setCandidatesFailed(false);
    } else {
      console.error('[medical] candidates', candidatesResult.reason);
      setCandidates([]);
      setCandidatesFailed(true);
    }
  }, [petId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const errors = validateMedicalDraft(draft);
  const warnings = medicalWarnings(draft, { birthdateApprox, microchipImplantedAt });
  const summary = records ? summarizeMedicalHistory(records) : null;
  // Candidates, plus — defence in depth — any record in `medical` with no confirmer.
  const waiting = (candidates?.length ?? 0) + (summary?.awaitingReview ?? 0);

  // The candidate under review, when the form is correcting a model's reading.
  const reviewing = editing?.kind === 'candidate' ? editing.candidate : null;

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
    setEditing({ kind: 'record', record });
    setDraft(draftFromRecord(record));
    setCardShownFor(null);
    setOpen(true);
  }

  function startReview(candidate: MedicalCandidateView) {
    setEditing({ kind: 'candidate', candidate });
    setDraft(draftFromRecord(candidate));
    setCardShownFor(null);
    setOpen(true);
  }

  async function save() {
    if (!user || errors.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      if (editing?.kind === 'candidate') {
        await confirmMedicalRecord(petId, editing.candidate, draft, user);
      } else if (editing?.kind === 'record') {
        await updateMedicalRecord(petId, editing.record.id, draft, user);
      } else {
        await addMedicalRecord(petId, draft, user);
      }
      setOpen(false);
      setEditing(null);
      await reload();
    } catch (caught) {
      console.error('[medical]', caught);
      setError(
        failureMessage(caught, 'No pudimos guardar el registro. Revisa tu conexión e inténtalo de nuevo.')
      );
      if (caught instanceof CandidateGoneError) {
        setOpen(false);
        setEditing(null);
        await reload();
      }
    } finally {
      setBusy(false);
    }
  }

  async function confirm(candidate: MedicalCandidateView) {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      await confirmMedicalRecord(petId, candidate, draftFromRecord(candidate), user);
    } catch (caught) {
      console.error('[medical]', caught);
      setError(failureMessage(caught, t.medicalReview.confirmFailed));
    } finally {
      await reload();
      setBusy(false);
    }
  }

  async function discard(candidate: MedicalCandidateView) {
    setBusy(true);
    setError(null);
    try {
      await discardMedicalCandidate(petId, candidate.id);
    } catch (caught) {
      console.error('[medical]', caught);
      setError(t.medicalReview.discardFailed);
    } finally {
      await reload();
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
        thresholds={thresholdsFor(reviewing.extractedFrom, field)}
        always={always}
      />
    );
  }

  return (
    <section className="admin-list">
      <h2 className="t-label">Historial médico</h2>

      {error && <p className="auth__error">{error}</p>}

      {notice && (
        <p className={notice.tone === 'error' ? 'auth__error' : 'auth__notice'} role="status">
          {notice.text}
        </p>
      )}

      {waiting > 0 && (
        <p className="auth__notice auth__notice--warn">
          <strong>{t.awaitingReviewCount(waiting)}.</strong> {t.medicalReview.notCounted}
        </p>
      )}

      {/* From confirmed records only — summarizeMedicalHistory applies the gate. */}
      {summary?.nextDue && summary.nextDue.nextDueAt !== null && (
        <p className="admin__sub">
          {t.nextDueSummary(summary.nextDue.name, formatDate(summary.nextDue.nextDueAt))}
        </p>
      )}

      {candidatesFailed && <p className="auth__error">{t.medicalReview.candidatesUnavailable}</p>}

      {/* ── what a model read, awaiting a person ─────────────────────────── */}
      {candidates !== null && candidates.length > 0 && (
        <>
          <h3 className="t-label">{t.medicalReview.candidatesTitle}</h3>
          <ul className="admin-list__items">
            {candidates.map((c) => {
              const evidence = c.extractionEvidence;
              const confirmableNow = canConfirmAsIs(validateMedicalDraft(draftFromRecord(c)));
              const hint = (field: CardField, always = false) =>
                evidence ? (
                  <EvidenceHint
                    label={t.cardFieldLabel(field)}
                    evidence={evidence[field]}
                    thresholds={thresholdsFor(c.extractedFrom, field)}
                    always={always}
                  />
                ) : null;

              return (
                <li
                  key={c.id}
                  className="admin-list__item admin-list__item--record admin-list__item--unconfirmed"
                >
                  <div>
                    <UnconfirmedBadge />

                    <strong>
                      {c.kind ? t.medicalKindLabel(c.kind) : t.medicalReview.unknownKind} ·{' '}
                      {c.name || t.medicalReview.unknownName}
                    </strong>
                    {hint('kind')}
                    {hint('name')}

                    <span className="t-data">
                      {c.performedAt !== null ? formatDate(c.performedAt) : t.medicalReview.unknownDate}
                      {c.veterinarian ? ` · ${c.veterinarian}` : ''}
                      {c.clinic ? ` · ${c.clinic}` : ''}
                    </span>
                    {hint('performedAt', true)}

                    {/* No "VENCIDA" here: a candidate draws no conclusions. */}
                    {c.nextDueAt !== null && (
                      <span className="t-data">Próxima: {formatDate(c.nextDueAt)}</span>
                    )}
                    {hint('nextDueAt', true)}

                    {c.batch && <span className="t-data">Lote {c.batch}</span>}
                    {CARD_TEXT_HINT_FIELDS.map((field) => (
                      <span key={field} className="evidence-slot">
                        {hint(field)}
                      </span>
                    ))}

                    <span className="t-data">
                      {t.extractionSourceLabel(c.extractedFrom)}
                      {c.extractedByModel ? ` (${c.extractedByModel})` : ''}
                    </span>

                    {!confirmableNow && <p className="auth__hint">{t.medicalReview.confirmNeedsEdit}</p>}

                    {cardShownFor === c.id && c.sourceDocument && (
                      <SourceDocumentImage path={c.sourceDocument} alt={t.medicalReview.cardAlt} />
                    )}
                  </div>

                  <div className="admin-list__actions">
                    {/* Offered only when complete — and confirmMedicalRecord
                        refuses an incomplete record whoever calls it. */}
                    {confirmableNow && (
                      <button
                        type="button"
                        className="btn"
                        disabled={busy || !user}
                        onClick={() => void confirm(c)}
                      >
                        {t.medicalReview.confirm}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn--muted"
                      disabled={busy}
                      onClick={() => startReview(c)}
                    >
                      {t.medicalReview.correctAndConfirm}
                    </button>
                    {c.sourceDocument && (
                      <button
                        type="button"
                        className="btn btn--muted"
                        disabled={busy}
                        onClick={() => setCardShownFor(cardShownFor === c.id ? null : c.id)}
                      >
                        {cardShownFor === c.id ? t.medicalReview.hideCard : t.medicalReview.showCard}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn--muted"
                      disabled={busy}
                      onClick={() => void discard(c)}
                    >
                      {t.medicalReview.discard}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {records === null && <p className="admin__sub">Cargando…</p>}

      {records !== null && records.length === 0 && (candidates?.length ?? 0) === 0 && (
        <p className="admin__sub">
          Todavía no hay registros médicos. Anota las vacunas, desparasitaciones y
          consultas aquí — <strong>una vacuna de campaña sin veterinario ni lote también
          cuenta</strong>, no hace falta dejarla afuera por eso.
        </p>
      )}

      {/* ── the confirmed history ────────────────────────────────────────── */}
      {records !== null && records.length > 0 && (
        <ul className="admin-list__items">
          {records.map((r) => {
            const signals = recordSignals(r);
            return (
              <li
                key={r.id}
                className={`admin-list__item admin-list__item--record${
                  isConfirmed(r) ? '' : ' admin-list__item--unconfirmed'
                }`}
              >
                <div>
                  {!isConfirmed(r) && <UnconfirmedBadge />}

                  <strong>
                    {r.kind ? t.medicalKindLabel(r.kind) : t.medicalReview.unknownKind} ·{' '}
                    {r.name || t.medicalReview.unknownName}
                  </strong>
                  <span className="t-data">
                    {r.performedAt !== null ? formatDate(r.performedAt) : t.medicalReview.unknownDate}
                    {r.veterinarian ? ` · ${r.veterinarian}` : ''}
                    {r.clinic ? ` · ${r.clinic}` : ''}
                  </span>

                  {/* ⚠️ Both flags come from recordSignals(), which applies the
                      review gate: a record with no confirmer never reads "VENCIDA". */}
                  {r.nextDueAt !== null && (
                    <span className="t-data">
                      Próxima: {formatDate(r.nextDueAt)}
                      {signals.overdue ? ' · VENCIDA' : ''}
                    </span>
                  )}

                  {/* Protection lapsing is a DIFFERENT question from a booster
                      being due, so it gets its own line rather than sharing one. */}
                  {r.validUntil !== null && signals.lapsed && (
                    <span className="t-data">
                      La protección declarada venció el {formatDate(r.validUntil)}
                    </span>
                  )}

                  {r.batch && <span className="t-data">Lote {r.batch}</span>}
                  {r.notes && <span className="t-data">{r.notes}</span>}

                  {r.source === 'llm-extracted' && (
                    <span className="t-data">
                      {t.extractionSourceLabel(r.extractedFrom)}
                      {r.extractedByModel ? ` (${r.extractedByModel})` : ''}
                      {r.confirmedBy ? ` · ${t.confirmedByLabel(r.confirmedBy)}` : ''}
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
                <SourceDocumentImage path={reviewing.sourceDocument} alt={t.medicalReview.cardAlt} />
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
