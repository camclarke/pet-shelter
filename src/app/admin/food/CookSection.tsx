'use client';

import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@/components/AuthProvider';
import { SHELTER } from '@/config/shelter';
import { t } from '@/i18n';
import { formatDate, parseDateInput, todayInputValue } from '@/lib/date-input';
import { listCookBatches, readStock, requestCookBatch, updateCookOutcome, type CookBatchView } from '@/lib/food-admin';
import { hasToxicHazard } from '@/lib/food-safety';
import {
  FOOD_CATEGORIES,
  cookBatchWarnings,
  cookInputHazards,
  cookedToRawRatio,
  dayToInstant,
  gramsPerLadle,
  validateCookBatch,
  validateCookOutcome,
  yieldEstimate,
  type CalibrationBatch,
  type CookBatchDraft,
  type CookInputDraft,
  type CookOutcomeDraft,
} from '@/lib/food-stock';
import type { FoodCategory } from '@/lib/types';
import { loadErrorText } from './FoodPanel';

const FILL_LEVELS = [0.25, 0.5, 0.75, 1] as const;

function emptyInput(): CookInputDraft {
  return { category: null, label: '', kgText: '', toxicAcknowledged: false };
}

function emptyOutcome(): CookOutcomeDraft {
  return { potFillLevel: null, cookedKgText: '', ladlesText: '', dogsServedText: '', cookedBy: null, notes: null };
}

function decimalText(value: number | null): string {
  return value === null ? '' : String(value).replace('.', ',');
}

/**
 * A cook batch: measured raw inputs out of the pantry, and the observed
 * outcome recorded later. Plan §12.2 — yield is MEASURED, never computed.
 *
 * ⚠️ The ladle estimate is `yieldEstimate(SHELTER.kitchen, …)`, which refuses
 * while the pot and ladle measurements are null — and they are. The refusal is
 * printed as a sentence saying why, never as a blank.
 */
export function CookSection() {
  const { user } = useAuth();
  const [batches, setBatches] = useState<CookBatchView[] | null>(null);
  const [stock, setStock] = useState<Awaited<ReturnType<typeof readStock>> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [open, setOpen] = useState(false);
  const [cookedDay, setCookedDay] = useState(todayInputValue());
  const [inputs, setInputs] = useState<CookInputDraft[]>([emptyInput()]);
  const [outcome, setOutcome] = useState<CookOutcomeDraft>(emptyOutcome);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editOutcome, setEditOutcome] = useState<CookOutcomeDraft>(emptyOutcome);

  const reload = useCallback(async () => {
    try {
      setBatches(await listCookBatches(60));
      setLoadError(null);
    } catch (caught) {
      console.error('[food] batches', caught);
      setLoadError(loadErrorText(caught));
    }
    try {
      setStock(await readStock());
    } catch (caught) {
      // Stock warnings are skipped rather than computed against zeros.
      console.error('[food] stock for warnings', caught);
      setStock(null);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const draft: CookBatchDraft = {
    ...outcome,
    cookedAt: cookedDay ? dayToInstant(parseDateInput(cookedDay).getTime()) : null,
    inputs,
  };
  const errors = validateCookBatch(draft);
  const warnings = cookBatchWarnings(draft, stock);

  const calibration: CalibrationBatch[] = (batches ?? []).map((b) => ({
    inputs: b.inputs.map((i) => ({ rawG: i.rawG })),
    potFillLevel: b.potFillLevel,
    cookedWeightG: b.cookedWeightG,
    ladlesYielded: b.ladlesYielded,
  }));

  function patchInput(index: number, next: Partial<CookInputDraft>) {
    setInputs((current) => current.map((input, i) => (i === index ? { ...input, ...next } : input)));
    setError(null);
  }

  async function save() {
    if (!user) return;
    const fresh: CookBatchDraft = { ...draft, cookedAt: cookedDay ? dayToInstant(parseDateInput(cookedDay).getTime()) : null };
    if (validateCookBatch(fresh).length > 0) return;
    setBusy(true);
    try {
      // Created on the server, which re-runs validateCookBatch — the toxic gate
      // included — because the rules deny a client create. See food-admin.ts.
      const result = await requestCookBatch(user, fresh);
      if (result.failure !== null) {
        setError(result.failure === 'unauthorized' ? t.food.permissionDenied : t.food.saveFailed);
        return;
      }
      setInputs([emptyInput()]);
      setOutcome(emptyOutcome());
      setOpen(false);
      await reload();
    } catch (caught) {
      console.error('[food] save batch', caught);
      setError(t.food.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  async function saveOutcome(batchId: string) {
    if (validateCookOutcome(editOutcome).length > 0) return;
    setBusy(true);
    try {
      await updateCookOutcome(batchId, editOutcome);
      setEditingId(null);
      await reload();
    } catch (caught) {
      console.error('[food] outcome', caught);
      setError(t.food.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  const outcomeErrors = editingId ? validateCookOutcome(editOutcome) : [];

  function outcomeFields(value: CookOutcomeDraft, onChange: (next: Partial<CookOutcomeDraft>) => void) {
    return (
      <>
        <div className="admin-form__row">
          <label className="auth__field">
            <span className="t-label">{t.food.potFillLabel}</span>
            <select
              value={value.potFillLevel ?? ''}
              disabled={busy}
              onChange={(e) => onChange({ potFillLevel: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">{t.food.notLooked}</option>
              {FILL_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {t.potFillLabel(level)}
                </option>
              ))}
            </select>
          </label>
          <label className="auth__field">
            <span className="t-label">{t.food.cookedKgLabel}</span>
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={value.cookedKgText}
              disabled={busy}
              onChange={(e) => onChange({ cookedKgText: e.target.value })}
            />
          </label>
        </div>
        <div className="admin-form__row">
          <label className="auth__field">
            <span className="t-label">{t.food.ladlesLabel}</span>
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={value.ladlesText}
              disabled={busy}
              onChange={(e) => onChange({ ladlesText: e.target.value })}
            />
          </label>
          <label className="auth__field">
            <span className="t-label">{t.food.dogsServedLabel}</span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={value.dogsServedText}
              disabled={busy}
              onChange={(e) => onChange({ dogsServedText: e.target.value })}
            />
          </label>
          <label className="auth__field">
            <span className="t-label">{t.food.cookedByLabel}</span>
            <input
              type="text"
              value={value.cookedBy ?? ''}
              maxLength={80}
              disabled={busy}
              onChange={(e) => onChange({ cookedBy: e.target.value || null })}
            />
          </label>
        </div>
      </>
    );
  }

  return (
    <section className="admin-form">
      {!open && (
        <div className="admin-list__actions">
          <button type="button" className="btn" disabled={busy} onClick={() => setOpen(true)}>
            {t.food.cookOpen}
          </button>
        </div>
      )}

      {open && (
        <div className="admin-form">
          <p className="admin__sub">{t.food.cookHint}</p>
          <label className="auth__field">
            <span className="t-label">{t.food.cookedAtLabel}</span>
            <input type="date" max={todayInputValue()} value={cookedDay} disabled={busy} onChange={(e) => setCookedDay(e.target.value)} />
          </label>

          <h3 className="t-label">{t.food.inputsTitle}</h3>
          <ul className="food-lines">
            {inputs.map((input, index) => {
              const toxic = hasToxicHazard(cookInputHazards(input));
              return (
                <li key={index} className="admin-list__item--record">
                  <div className="admin-form__row">
                    <label className="auth__field">
                      <span className="t-label">{t.food.inputLabel}</span>
                      <input
                        type="text"
                        value={input.label}
                        maxLength={80}
                        disabled={busy}
                        onChange={(e) => patchInput(index, { label: e.target.value })}
                      />
                    </label>
                    <label className="auth__field">
                      <span className="t-label">{t.food.lineCategory}</span>
                      <select
                        value={input.category ?? ''}
                        disabled={busy}
                        onChange={(e) => patchInput(index, { category: (e.target.value || null) as FoodCategory | null })}
                      >
                        <option value="">{t.food.chooseCategory}</option>
                        {FOOD_CATEGORIES.map((category) => (
                          <option key={category} value={category}>
                            {t.foodCategoryLabel(category)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="auth__field">
                      <span className="t-label">{t.food.inputKg}</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        placeholder="5"
                        value={input.kgText}
                        disabled={busy}
                        onChange={(e) => patchInput(index, { kgText: e.target.value })}
                      />
                    </label>
                  </div>
                  {toxic && (
                    <label className="admin-form__check food-check">
                      <input
                        type="checkbox"
                        checked={input.toxicAcknowledged}
                        disabled={busy}
                        onChange={(e) => patchInput(index, { toxicAcknowledged: e.target.checked })}
                      />
                      {t.food.toxicAck}
                    </label>
                  )}
                  {inputs.length > 1 && (
                    <div className="admin-list__actions">
                      <button
                        type="button"
                        className="btn btn--muted"
                        disabled={busy}
                        onClick={() => setInputs((current) => current.filter((_, i) => i !== index))}
                      >
                        {t.food.remove}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="admin-list__actions">
            <button type="button" className="btn btn--muted" disabled={busy} onClick={() => setInputs((c) => [...c, emptyInput()])}>
              {t.food.addInput}
            </button>
          </div>

          {outcomeFields(outcome, (next) => setOutcome((current) => ({ ...current, ...next })))}

          <p className="admin__sub">
            <strong>{t.food.yieldTitle}:</strong> {t.yieldEstimateText(yieldEstimate(SHELTER.kitchen, calibration, outcome.potFillLevel))}
          </p>

          {warnings.length > 0 && (
            <ul className="place-warnings">
              {warnings.map((w, i) => (
                <li key={`${w.kind}-${i}`}>{t.cookBatchWarning(w)}</li>
              ))}
            </ul>
          )}
          {errors.map((e, i) => (
            <p key={`${e.kind}-${i}`} className={e.kind === 'input-toxic-unacknowledged' ? 'auth__error is-toxic' : 'auth__error'}>
              {t.cookBatchError(e)}
            </p>
          ))}
          {error && <p className="auth__error">{error}</p>}

          <div className="admin-list__actions">
            <button
              type="button"
              className="btn btn--action"
              disabled={busy || !user || errors.length > 0}
              onClick={() => void save()}
            >
              {t.food.saveCook}
            </button>
            <button type="button" className="btn btn--muted" disabled={busy} onClick={() => setOpen(false)}>
              {t.food.cancel}
            </button>
          </div>
        </div>
      )}

      <section className="admin-list">
        <h2 className="t-label">{t.food.calibrationTitle}</h2>
        <p className="admin__sub">{t.measuredRatioText('cooked-to-raw', cookedToRawRatio(calibration))}</p>
        <p className="admin__sub">{t.measuredRatioText('grams-per-ladle', gramsPerLadle(calibration))}</p>
        {!open && (
          <p className="admin__sub">
            <strong>{t.food.yieldTitle}:</strong> {t.yieldEstimateText(yieldEstimate(SHELTER.kitchen, calibration, null))}
          </p>
        )}
      </section>

      <section className="admin-list">
        <h2 className="t-label">{t.food.recentBatches}</h2>
        {loadError && <p className="auth__error">{loadError}</p>}
        {batches === null && !loadError && <p className="admin__sub">{t.food.loading}</p>}
        {batches?.length === 0 && <p className="admin__sub">{t.food.noBatches}</p>}
        {batches && batches.length > 0 && (
          <ul className="admin-list__items">
            {batches.map((batch) => (
              <li key={batch.id} className="admin-list__item--record">
                <div>
                  <strong>{formatDate(batch.cookedAt)}</strong>
                  <span className="t-data">
                    {batch.inputs.map((input) => `${input.label} ${t.formatGrams(input.rawG)}`).join(' · ')}
                  </span>
                  <span className="t-data">
                    {[
                      batch.potFillLevel !== null ? t.potFillLabel(batch.potFillLevel) : null,
                      batch.cookedWeightG !== null ? t.formatGrams(batch.cookedWeightG) : null,
                      batch.ladlesYielded !== null ? `${decimalText(batch.ladlesYielded)} ${t.food.ladlesLabel.split(' (')[0]!.toLowerCase()}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
                {editingId === batch.id ? (
                  <div className="admin-form">
                    {outcomeFields(editOutcome, (next) => setEditOutcome((current) => ({ ...current, ...next })))}
                    {outcomeErrors.map((e, i) => (
                      <p key={`${e.kind}-${i}`} className="auth__error">
                        {t.cookBatchError(e)}
                      </p>
                    ))}
                    <div className="admin-list__actions">
                      <button
                        type="button"
                        className="btn btn--action"
                        disabled={busy || outcomeErrors.length > 0}
                        onClick={() => void saveOutcome(batch.id)}
                      >
                        {t.food.saveOutcome}
                      </button>
                      <button type="button" className="btn btn--muted" disabled={busy} onClick={() => setEditingId(null)}>
                        {t.food.cancel}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="admin-list__actions">
                    <button
                      type="button"
                      className="btn btn--muted"
                      disabled={busy}
                      onClick={() => {
                        setEditingId(batch.id);
                        setEditOutcome({
                          potFillLevel: batch.potFillLevel,
                          cookedKgText: batch.cookedWeightG === null ? '' : decimalText(batch.cookedWeightG / 1000),
                          ladlesText: decimalText(batch.ladlesYielded),
                          dogsServedText: batch.dogsServed === null ? '' : String(batch.dogsServed),
                          cookedBy: batch.cookedBy,
                          notes: batch.notes,
                        });
                      }}
                    >
                      {t.food.editOutcome}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
