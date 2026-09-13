'use client';

import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@/components/AuthProvider';
import { t } from '@/i18n';
import { formatDate } from '@/lib/date-input';
import { listPresentAnimals, readFeedingLog, saveFeedingLog } from '@/lib/food-admin';
import { parseDecimalInput } from '@/lib/food-quantity';
import { feedingLogId, parseServing } from '@/lib/food-stock';
import { listMeasurements, type MeasurementView } from '@/lib/measurements-admin';
import {
  POT_SPECIES,
  bodyConditionSuggestion,
  merMidpointKcal,
  potShares,
  rationFor,
  type RationResult,
} from '@/lib/rations';
import type { FeedingServing, Pet } from '@/lib/types';
import { loadErrorText } from './FoodPanel';

interface AnimalRow {
  pet: Pet;
  /** Null when this animal's measurements could not be read. */
  history: MeasurementView[] | null;
}

interface ServingForm {
  ladlesText: string;
  reason: string;
}

function ladlesText(ladles: number): string {
  return String(ladles).replace('.', ',');
}

/**
 * Today's ration sheet. Plan §12.3.
 *
 * For each animal physically in the shelter: what the standard suggests, from
 * `rationFor` — weight ONLY via `latestWeight()`, with the reading's age, and
 * NEVER the intake photo's estimate — next to the ladles actually written down.
 * Body condition shows as a suggestion; nothing here changes a ration.
 *
 * ⚠️ One measurement read per animal. At forty animals that is forty reads a
 * load, which the free tier absorbs; a failed read for one animal says so on
 * that row instead of reading as "falta pesar".
 */
export function RationsSection() {
  const { user } = useAuth();
  const today = feedingLogId(Date.now());

  const [rows, setRows] = useState<AnimalRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [servings, setServings] = useState<Record<string, ServingForm>>({});
  const [dogsPresentText, setDogsPresentText] = useState('');
  const [shortfall, setShortfall] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const pets = await listPresentAnimals();
      const histories = await Promise.allSettled(pets.map((pet) => listMeasurements(pet.id)));
      setRows(
        pets.map((pet, i) => {
          const settled = histories[i]!;
          return { pet, history: settled.status === 'fulfilled' ? settled.value : null };
        })
      );
      setLoadError(null);
    } catch (caught) {
      console.error('[food] animals', caught);
      setLoadError(loadErrorText(caught));
    }
    try {
      const log = await readFeedingLog(today);
      if (log) {
        setServings(
          Object.fromEntries(
            log.servings.map((s) => [s.petId, { ladlesText: ladlesText(s.ladles), reason: s.adjustedReason ?? '' }])
          )
        );
        setDogsPresentText(log.dogsPresent === null ? '' : String(log.dogsPresent));
        setShortfall(log.shortfallNote ?? '');
      }
      setLogError(null);
    } catch (caught) {
      console.error('[food] feeding log', caught);
      setLogError(loadErrorText(caught));
    }
  }, [today]);

  useEffect(() => {
    void load();
  }, [load]);

  const now = Date.now();
  const computed = (rows ?? []).map((row) => {
    const result: RationResult | null =
      row.history === null
        ? null
        : rationFor(
            {
              species: row.pet.species,
              ageMonths: row.pet.ageMonths,
              ageMonthsMin: row.pet.ageMonthsMin,
              ageMonthsMax: row.pet.ageMonthsMax,
              estimatedKgMin: row.pet.weightKgMin,
              estimatedKgMax: row.pet.weightKgMax,
            },
            row.history,
            now
          );
    const form = servings[row.pet.id] ?? { ladlesText: '', reason: '' };
    return { row, result, form, serving: parseServing(form.ladlesText) };
  });

  const dogs = computed.filter((c) => POT_SPECIES.includes(c.row.pet.species));
  const shares = potShares(
    dogs.map((c) => ({
      petId: c.row.pet.id,
      merKcal: c.result ? merMidpointKcal(c.result) : null,
      ladles: c.serving.kind === 'ok' ? c.serving.ladles : null,
    }))
  );
  const shareByPet = new Map(shares.rows.map((r) => [r.petId, r]));

  const invalidServing = dogs.some((c) => c.serving.kind === 'invalid' || c.serving.kind === 'too-many');
  const dogsPresent = parseDecimalInput(dogsPresentText);
  const dogsPresentInvalid =
    dogsPresent.kind !== 'empty' && !(dogsPresent.kind === 'ok' && Number.isInteger(dogsPresent.value));

  function patchServing(petId: string, next: Partial<ServingForm>) {
    setServings((current) => ({ ...current, [petId]: { ...(current[petId] ?? { ladlesText: '', reason: '' }), ...next } }));
    setNotice(null);
  }

  async function save() {
    if (!user || invalidServing || dogsPresentInvalid) return;
    const list: FeedingServing[] = dogs.flatMap((c) =>
      c.serving.kind === 'ok'
        ? [{ petId: c.row.pet.id, petName: c.row.pet.name, ladles: c.serving.ladles, adjustedReason: c.form.reason.trim() || null }]
        : []
    );
    setBusy(true);
    try {
      await saveFeedingLog(
        {
          date: today,
          batchIds: [],
          servings: list,
          dogsPresent: dogsPresent.kind === 'ok' ? dogsPresent.value : null,
          shortfallNote: shortfall.trim() || null,
        },
        user
      );
      setNotice(t.food.savedDay);
    } catch (caught) {
      console.error('[food] save day', caught);
      setNotice(t.food.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-form">
      <h2 className="t-label">
        {t.food.rationsTitle} · {formatDate(now)}
      </h2>
      <p className="admin__sub">{t.food.rationsHint}</p>

      {loadError && <p className="auth__error">{loadError}</p>}
      {logError && <p className="auth__error">{logError}</p>}
      {rows === null && !loadError && <p className="admin__sub">{t.food.loading}</p>}
      {rows?.length === 0 && <p className="admin__sub">{t.food.noAnimals}</p>}

      {computed.length > 0 && (
        <ul className="food-lines">
          {computed.map(({ row, result, form, serving }) => {
            const fromPot = POT_SPECIES.includes(row.pet.species);
            const suggestion = row.history ? bodyConditionSuggestion(row.history, now) : null;
            const share = shareByPet.get(row.pet.id);
            return (
              <li key={row.pet.id} className="admin-list__item--record">
                <div>
                  <strong>{row.pet.name}</strong>
                  <span className="t-data">{t.speciesNoun(row.pet.species, row.pet.sex)}</span>
                  <span>{result === null ? t.food.measurementsFailed : t.rationSummary(result)}</span>
                  {suggestion && <span className="auth__hint">{t.bodyConditionSuggestionText(suggestion)}</span>}
                  {!fromPot && <span className="auth__hint">{t.food.notFromPot}</span>}
                  {share && <span className="auth__hint">{t.potShareText(share)}</span>}
                </div>
                {fromPot && (
                  <div className="admin-form__row">
                    <label className="auth__field">
                      <span className="t-label">{t.food.ladlesToday}</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        value={form.ladlesText}
                        disabled={busy}
                        onChange={(e) => patchServing(row.pet.id, { ladlesText: e.target.value })}
                      />
                    </label>
                    <label className="auth__field">
                      <span className="t-label">{t.food.adjustedReason}</span>
                      <input
                        type="text"
                        value={form.reason}
                        maxLength={120}
                        disabled={busy}
                        onChange={(e) => patchServing(row.pet.id, { reason: e.target.value })}
                      />
                    </label>
                  </div>
                )}
                {(serving.kind === 'invalid' || serving.kind === 'too-many') && (
                  <p className="auth__error">{t.food.servingInvalid}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {dogs.length > 0 && (
        <section className="admin-list">
          <h2 className="t-label">{t.food.sharesTitle}</h2>
          <p className="admin__sub">{shares.rows.length === 0 ? t.food.sharesNeedTwo : t.food.sharesHint}</p>
        </section>
      )}

      {rows && rows.length > 0 && (
        <>
          <div className="admin-form__row">
            <label className="auth__field">
              <span className="t-label">{t.food.dogsPresentLabel}</span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={dogsPresentText}
                disabled={busy}
                onChange={(e) => setDogsPresentText(e.target.value)}
              />
            </label>
          </div>
          {dogsPresentInvalid && <p className="auth__error">{t.food.dogsPresentInvalid}</p>}
          <label className="auth__field">
            <span className="t-label">{t.food.shortfallLabel}</span>
            <textarea rows={2} value={shortfall} maxLength={500} disabled={busy} onChange={(e) => setShortfall(e.target.value)} />
          </label>
          {notice && <p className="auth__hint food-notice">{notice}</p>}
          <div className="admin-list__actions">
            <button
              type="button"
              className="btn btn--action"
              disabled={busy || !user || invalidServing || dogsPresentInvalid}
              onClick={() => void save()}
            >
              {t.food.saveDay}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
