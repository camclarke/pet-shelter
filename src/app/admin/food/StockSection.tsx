'use client';

import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@/components/AuthProvider';
import { t } from '@/i18n';
import { dayToInstant, parseDateInput, todayInputValue } from '@/lib/date-input';
import { readStock, recordStockMovement } from '@/lib/food-admin';
import {
  FOOD_CATEGORIES,
  stockLines,
  validateStockMovement,
  type ManualMovementKind,
  type StockMovementDraft,
} from '@/lib/food-stock';
import type { FoodCategory } from '@/lib/types';
import { loadErrorText } from './FoodPanel';

interface MovementForm {
  kind: ManualMovementKind;
  category: FoodCategory | null;
  label: string;
  kgText: string;
  direction: 'add' | 'remove';
  day: string;
  note: string;
}

function freshForm(): MovementForm {
  return { kind: 'discard', category: null, label: '', kgText: '', direction: 'remove', day: todayInputValue(), note: '' };
}

function toDraft(form: MovementForm): StockMovementDraft {
  return {
    kind: form.kind,
    category: form.category,
    label: form.label,
    kgText: form.kgText,
    direction: form.kind === 'discard' ? 'remove' : form.direction,
    occurredAt: form.day ? dayToInstant(parseDateInput(form.day).getTime()) : null,
    note: form.note.trim() || null,
  };
}

/**
 * The pantry: the SUM of the ledger per category, and the two manual movements.
 *
 * ⚠️ A category whose sum failed is never shown as zero — `readStock` rejects
 * as a whole, and this renders the error instead of a pantry. A negative
 * category is shown as negative, not clamped: it is information.
 */
export function StockSection() {
  const { user } = useAuth();
  const [totals, setTotals] = useState<Record<FoodCategory, number> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<MovementForm>(freshForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setTotals(await readStock());
      setLoadError(null);
    } catch (caught) {
      console.error('[food] stock', caught);
      setTotals(null);
      setLoadError(loadErrorText(caught));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const draft = toDraft(form);
  const errors = validateStockMovement(draft);

  function patch(next: Partial<MovementForm>) {
    setForm((current) => ({ ...current, ...next }));
    setError(null);
  }

  async function save() {
    if (!user) return;
    const fresh = toDraft(form);
    if (validateStockMovement(fresh).length > 0) return;
    setBusy(true);
    try {
      await recordStockMovement(fresh, user);
      setForm(freshForm());
      setOpen(false);
      await reload();
    } catch (caught) {
      console.error('[food] movement', caught);
      setError(t.food.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-form">
      <h2 className="t-label">{t.food.stockTitle}</h2>
      <p className="admin__sub">{t.food.stockHint}</p>

      {loadError && <p className="auth__error">{loadError}</p>}
      {totals === null && !loadError && <p className="admin__sub">{t.food.loading}</p>}
      {totals && (
        <ul className="food-stock">
          {stockLines(totals).map((line) => (
            <li key={line.category} className={line.kind === 'negative' ? 'is-negative' : undefined}>
              <span>{t.foodCategoryLabel(line.category)}</span>
              <strong>{line.kind === 'empty' ? t.food.stockEmpty : t.formatGrams(line.grams)}</strong>
              {line.kind === 'negative' && <span className="auth__hint food-stock__note">{t.food.stockNegative}</span>}
            </li>
          ))}
        </ul>
      )}

      {!open && (
        <div className="admin-list__actions">
          <button type="button" className="btn" disabled={busy} onClick={() => setOpen(true)}>
            {t.food.movementOpen}
          </button>
        </div>
      )}

      {open && (
        <div className="admin-form">
          <div className="admin-form__row">
            <label className="auth__field">
              <span className="t-label">{t.food.movementKind}</span>
              <select
                value={form.kind}
                disabled={busy}
                onChange={(e) => patch({ kind: e.target.value as ManualMovementKind })}
              >
                <option value="discard">{t.stockEntryKindLabel('discard')}</option>
                <option value="correction">{t.stockEntryKindLabel('correction')}</option>
              </select>
            </label>
            {form.kind === 'correction' && (
              <label className="auth__field">
                <span className="t-label">{t.food.directionLabel}</span>
                <select
                  value={form.direction}
                  disabled={busy}
                  onChange={(e) => patch({ direction: e.target.value as 'add' | 'remove' })}
                >
                  <option value="remove">{t.food.directionRemove}</option>
                  <option value="add">{t.food.directionAdd}</option>
                </select>
              </label>
            )}
            <label className="auth__field">
              <span className="t-label">{t.food.lineCategory}</span>
              <select
                value={form.category ?? ''}
                disabled={busy}
                onChange={(e) => patch({ category: (e.target.value || null) as FoodCategory | null })}
              >
                <option value="">{t.food.chooseCategory}</option>
                {FOOD_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {t.foodCategoryLabel(category)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="admin-form__row">
            <label className="auth__field">
              <span className="t-label">{t.food.movementLabel}</span>
              <input type="text" value={form.label} maxLength={80} disabled={busy} onChange={(e) => patch({ label: e.target.value })} />
            </label>
            <label className="auth__field">
              <span className="t-label">{t.food.movementKg}</span>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder="2,5"
                value={form.kgText}
                disabled={busy}
                onChange={(e) => patch({ kgText: e.target.value })}
              />
            </label>
            <label className="auth__field">
              <span className="t-label">{t.food.movementDate}</span>
              <input type="date" max={todayInputValue()} value={form.day} disabled={busy} onChange={(e) => patch({ day: e.target.value })} />
            </label>
          </div>

          <label className="auth__field">
            <span className="t-label">{t.food.movementNote}</span>
            <textarea rows={2} value={form.note} maxLength={500} disabled={busy} onChange={(e) => patch({ note: e.target.value })} />
          </label>

          {errors.map((e) => (
            <p key={e} className="auth__error">
              {t.stockMovementError(e)}
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
              {t.food.saveMovement}
            </button>
            <button type="button" className="btn btn--muted" disabled={busy} onClick={() => setOpen(false)}>
              {t.food.cancel}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
