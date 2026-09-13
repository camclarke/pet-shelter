'use client';

import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@/components/AuthProvider';
import { SHELTER } from '@/config/shelter';
import { t } from '@/i18n';
import { dayToInstant, formatDate, parseDateInput, toDateInput, todayInputValue } from '@/lib/date-input';
import { listRecentDonations, saveDonation, type DonationView } from '@/lib/food-admin';
import {
  emptyDonationLine,
  reviewDonation,
  type DonationDraft,
  type DonationLineDraft,
} from '@/lib/food-parse';
import { requestDonationParse } from '@/lib/food-parse-client';
import { FOOD_CATEGORIES } from '@/lib/food-stock';
import type { FoodCategory } from '@/lib/types';
import { loadErrorText } from './FoodPanel';

/**
 * Plan §12.1 and §12.4: a donation in plain words, proposed as lines, confirmed
 * by a person. Saving IS the confirmation — there is no half-saved donation.
 *
 * Every number shown next to a line ("= 15 kg") is `parseQuantityPhrase` over
 * the words on screen, recomputed as they are edited. The model never supplies
 * a number, and a toxic or ungrounded line arrives unticked.
 */
export function DonationSection() {
  const { user } = useAuth();

  const [rawText, setRawText] = useState('');
  const [donor, setDonor] = useState('');
  const [receivedDay, setReceivedDay] = useState(todayInputValue());
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DonationLineDraft[]>([]);
  const [source, setSource] = useState<'manual' | 'llm-parsed'>('manual');
  const [modelKey, setModelKey] = useState<string | null>(null);
  const [seq, setSeq] = useState(0);

  const [parsing, setParsing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<DonationView[] | null>(null);
  const [recentError, setRecentError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setRecent(await listRecentDonations(10));
      setRecentError(null);
    } catch (caught) {
      console.error('[food] donations', caught);
      setRecentError(loadErrorText(caught));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  function buildDraft(): DonationDraft {
    return {
      donor: donor.trim() || null,
      receivedAt: receivedDay ? dayToInstant(parseDateInput(receivedDay).getTime()) : null,
      rawText,
      lines,
      source,
      modelKey: source === 'llm-parsed' ? modelKey : null,
      notes: notes.trim() || null,
    };
  }

  const draft = buildDraft();
  const review = reviewDonation(draft, SHELTER.species);

  function patchLine(key: string, next: Partial<DonationLineDraft>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...next } : line)));
    setNotice(null);
  }

  async function parse() {
    if (!user || rawText.trim() === '') return;
    setParsing(true);
    setNotice(null);
    const outcome = await requestDonationParse(user, rawText);
    setParsing(false);
    if (outcome.lines === null) {
      setNotice(t.foodParseFailure(outcome.failure ?? 'failed'));
      return;
    }
    setLines(outcome.lines);
    if (outcome.donor && !donor.trim()) setDonor(outcome.donor);
    setSource('llm-parsed');
    setModelKey(outcome.modelKey);
  }

  function addLine() {
    setLines((current) => [...current, emptyDonationLine(`manual-${seq}`)]);
    setSeq((n) => n + 1);
  }

  async function save() {
    setAttempted(true);
    if (!user) return;
    const fresh = buildDraft();
    if (reviewDonation(fresh, SHELTER.species).errors.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      await saveDonation(fresh, user);
      setRawText('');
      setDonor('');
      setNotes('');
      setLines([]);
      setSource('manual');
      setModelKey(null);
      setAttempted(false);
      setNotice(t.food.savedDonation);
      await reload();
    } catch (caught) {
      console.error('[food] save donation', caught);
      setError(caught instanceof Error && /permission/i.test(caught.message) ? t.food.permissionDenied : t.food.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  const topErrors = attempted ? review.errors.filter((e) => e !== 'lines-invalid' || lines.length > 0) : [];

  return (
    <section className="admin-form">
      <label className="auth__field">
        <span className="t-label">{t.food.donationTextLabel}</span>
        <textarea
          rows={3}
          value={rawText}
          maxLength={2000}
          disabled={busy}
          onChange={(e) => setRawText(e.target.value)}
        />
        <span className="auth__hint">{t.food.donationTextHint}</span>
      </label>

      <div className="admin-list__actions">
        <button
          type="button"
          className="btn"
          disabled={busy || parsing || rawText.trim() === ''}
          onClick={() => void parse()}
        >
          {parsing ? t.food.parsing : t.food.parseButton}
        </button>
        <button type="button" className="btn btn--muted" disabled={busy} onClick={addLine}>
          {t.food.addLine}
        </button>
      </div>

      {notice && <p className="auth__hint food-notice">{notice}</p>}

      <div className="admin-form__row">
        <label className="auth__field">
          <span className="t-label">{t.food.receivedLabel}</span>
          <input
            type="date"
            max={todayInputValue()}
            value={receivedDay}
            disabled={busy}
            onChange={(e) => setReceivedDay(e.target.value)}
          />
        </label>
        <label className="auth__field">
          <span className="t-label">{t.food.donorLabel}</span>
          <input type="text" value={donor} maxLength={120} disabled={busy} onChange={(e) => setDonor(e.target.value)} />
        </label>
      </div>

      {review.missingHazards.length > 0 && (
        <ul className="place-warnings">
          <li className="is-toxic">
            {t.food.missingHazardsTitle}{' '}
            {review.missingHazards.map((h) => `${t.foodHazardLabel(h.hazard)}. ${t.foodHazardAdvice(h.hazard)}`).join(' ')}
          </li>
        </ul>
      )}

      {lines.length > 0 && (
        <>
          <p className="admin__sub">{t.food.reviewNote}</p>
          <ul className="food-lines">
            {lines.map((line, index) => {
              const assessment = review.lines[index]!;
              return (
                <li key={line.key} className="admin-list__item--record">
                  <div className="admin-form__row">
                    <label className="auth__field">
                      <span className="t-label">{t.food.lineFood}</span>
                      <input
                        type="text"
                        value={line.food}
                        maxLength={80}
                        disabled={busy}
                        onChange={(e) => patchLine(line.key, { food: e.target.value })}
                      />
                    </label>
                    <label className="auth__field">
                      <span className="t-label">{t.food.lineCategory}</span>
                      <select
                        value={line.category ?? ''}
                        disabled={busy}
                        onChange={(e) =>
                          patchLine(line.key, { category: (e.target.value || null) as FoodCategory | null })
                        }
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
                      <span className="t-label">{t.food.lineQuantity}</span>
                      <input
                        type="text"
                        value={line.quantityText}
                        disabled={busy}
                        onChange={(e) => patchLine(line.key, { quantityText: e.target.value })}
                      />
                    </label>
                    {/* Text with a decimal keypad, never type="number": a comma
                        a browser silently discards is a factor of ten. */}
                    <label className="auth__field">
                      <span className="t-label">{t.food.lineMassKg}</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        placeholder="9,5"
                        value={line.massKgText}
                        disabled={busy}
                        onChange={(e) => patchLine(line.key, { massKgText: e.target.value })}
                      />
                    </label>
                    <label className="auth__field">
                      <span className="t-label">{t.food.lineExpiry}</span>
                      <input
                        type="date"
                        value={line.expiresAt === null ? '' : toDateInput(line.expiresAt)}
                        disabled={busy}
                        onChange={(e) =>
                          patchLine(line.key, {
                            expiresAt: e.target.value ? parseDateInput(e.target.value).getTime() : null,
                          })
                        }
                      />
                    </label>
                  </div>

                  {assessment.grams !== null && <span className="t-data">= {t.formatGrams(assessment.grams)}</span>}
                  {line.snippet && (
                    <span className="t-data">
                      {t.food.fromText} «{line.snippet}»
                    </span>
                  )}

                  <label className="admin-form__check food-check">
                    <input
                      type="checkbox"
                      checked={line.includeInStock}
                      disabled={busy}
                      onChange={(e) => patchLine(line.key, { includeInStock: e.target.checked })}
                    />
                    {t.food.lineInStock}
                  </label>

                  {assessment.warnings.length > 0 && (
                    <ul className="place-warnings">
                      {assessment.warnings.map((w, i) => (
                        <li
                          key={`${w.kind}-${i}`}
                          className={w.kind === 'toxic-excluded' || w.kind === 'toxic-included' ? 'is-toxic' : undefined}
                        >
                          {t.donationLineWarning(w)}
                        </li>
                      ))}
                    </ul>
                  )}
                  {assessment.errors.map((e) => (
                    <p key={e} className="auth__error">
                      {t.donationLineError(e)}
                    </p>
                  ))}

                  <div className="admin-list__actions">
                    <button
                      type="button"
                      className="btn btn--muted"
                      disabled={busy}
                      onClick={() => setLines((current) => current.filter((l) => l.key !== line.key))}
                    >
                      {t.food.remove}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <label className="auth__field">
        <span className="t-label">{t.food.notesLabel}</span>
        <textarea rows={2} value={notes} maxLength={1000} disabled={busy} onChange={(e) => setNotes(e.target.value)} />
      </label>

      {topErrors.map((e) => (
        <p key={e} className="auth__error">
          {t.donationError(e)}
        </p>
      ))}
      {error && <p className="auth__error">{error}</p>}

      <div className="admin-list__actions">
        <button
          type="button"
          className="btn btn--action"
          disabled={busy || !user || lines.length === 0}
          onClick={() => void save()}
        >
          {t.food.saveDonation}
        </button>
      </div>

      <section className="admin-list">
        <h2 className="t-label">{t.food.recentDonations}</h2>
        {recentError && <p className="auth__error">{recentError}</p>}
        {recent === null && !recentError && <p className="admin__sub">{t.food.loading}</p>}
        {recent?.length === 0 && <p className="admin__sub">{t.food.noDonations}</p>}
        {recent && recent.length > 0 && (
          <ul className="admin-list__items">
            {recent.map((donation) => (
              <li key={donation.id} className="admin-list__item--record">
                <div>
                  <strong>
                    {formatDate(donation.receivedAt)}
                    {donation.donor ? ` · ${donation.donor}` : ''}
                  </strong>
                  {donation.lines.map((line, i) => (
                    <span key={i} className="t-data">
                      {line.food} · {line.grams !== null ? t.formatGrams(line.grams) : line.quantityText}
                      {line.inStock ? '' : ` · ${t.food.stockEmpty}`}
                      {line.hazards.length > 0 ? ` · ${line.hazards.map((h) => t.foodHazardLabel(h)).join(', ')}` : ''}
                    </span>
                  ))}
                  <span className="t-data">
                    {donation.source === 'llm-parsed' ? t.food.parsedByModel : t.food.typedByHand} · {donation.recordedBy}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
