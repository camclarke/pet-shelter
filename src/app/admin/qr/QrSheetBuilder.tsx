'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { collection, getCountFromServer, getDocs, limit, orderBy, query } from 'firebase/firestore';

import { useAuth } from '@/components/AuthProvider';
import { QrTagCard } from '@/components/QrTagCard';
import { SHELTER } from '@/config/shelter';
import { t } from '@/i18n';
import { getFirebase } from '@/lib/firebase-client';
import { QR_SHEET_PET_LIMIT, activeTokenOf, sheetTruncation, type SheetTruncation } from '@/lib/qr-tokens';
import { issueQrToken, listActiveTokens, type QrTokenView } from '@/lib/qr-tokens-admin';
import type { Pet } from '@/lib/types';

type SheetPet = Pick<Pet, 'id' | 'name' | 'status'>;

function failureMessage(caught: unknown, fallback: string): string {
  return (caught as { code?: string })?.code === 'permission-denied' ? t.tag.permissionDenied : fallback;
}

export function QrSheetBuilder() {
  const { user, isAdmin } = useAuth();
  // On the admin claim, not on being signed in — see the same line in
  // QrTagPanel. The rules are the boundary; this keeps the view honest.
  const canWrite = isAdmin && user !== null;
  const [pets, setPets] = useState<SheetPet[] | null>(null);
  const [tokens, setTokens] = useState<QrTokenView[] | null>(null);
  const [truncation, setTruncation] = useState<SheetTruncation | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { db } = getFirebase();
      // Same query and the same cap as the admin dashboard, which is the page
      // this sheet is reached from — the two lists must show the same animals.
      // The count runs beside it so a capped list SAYS it is capped; a failed
      // count degrades to "the cap was reached" rather than hiding the notice.
      const [petSnap, active, total] = await Promise.all([
        getDocs(query(collection(db, 'pets'), orderBy('createdAt', 'desc'), limit(QR_SHEET_PET_LIMIT))),
        listActiveTokens(),
        getCountFromServer(collection(db, 'pets'))
          .then((snap) => snap.data().count)
          .catch((caught) => {
            console.error('[admin/qr-sheet] could not count pets', caught);
            return null;
          }),
      ]);
      setTruncation(sheetTruncation(petSnap.size, total));
      setPets(
        petSnap.docs
          .map((d) => ({ id: d.id, ...d.data() }) as Pet)
          // A cancelled intake is an animal that never arrived; it gets no tag.
          .filter((pet) => pet.status !== 'cancelled')
          .map(({ id, name, status }) => ({ id, name, status })),
      );
      setTokens(active);
    } catch (caught) {
      console.error('[admin/qr-sheet] could not load', caught);
      setError(failureMessage(caught, t.tag.loadFailed));
      setPets([]);
      setTokens([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeByPet = useMemo(() => {
    const map = new Map<string, QrTokenView>();
    for (const pet of pets ?? []) {
      const token = activeTokenOf((tokens ?? []).filter((candidate) => candidate.petId === pet.id));
      if (token) map.set(pet.id, token);
    }
    return map;
  }, [pets, tokens]);

  async function issueMissing() {
    if (!user || !canWrite) return;
    setBusy(true);
    setError(null);
    try {
      // One at a time, so a failure names the animal it stopped at rather than
      // leaving an unknown subset issued.
      for (const petId of selected) {
        if (!activeByPet.has(petId)) await issueQrToken(petId, user);
      }
      await load();
    } catch (caught) {
      console.error('[admin/qr-sheet] could not issue', caught);
      setError(failureMessage(caught, t.tag.issueFailed));
      await load();
    } finally {
      setBusy(false);
    }
  }

  function toggle(petId: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(petId)) next.delete(petId);
      else next.add(petId);
      return next;
    });
  }

  return (
    <QrSheetView
      pets={pets}
      activeByPet={activeByPet}
      selected={selected}
      truncation={truncation}
      busy={busy}
      error={error}
      canWrite={canWrite}
      onToggle={toggle}
      onSelectAll={() => setSelected(new Set((pets ?? []).map((pet) => pet.id)))}
      onClear={() => setSelected(new Set())}
      onIssueMissing={() => void issueMissing()}
      onPrint={() => window.print()}
    />
  );
}

/** The markup, with no state and no Firestore — so it can be rendered on its own to check at 360px and in print. */
export function QrSheetView({
  pets,
  activeByPet,
  selected,
  truncation = null,
  busy,
  error,
  canWrite,
  onToggle,
  onSelectAll,
  onClear,
  onIssueMissing,
  onPrint,
}: {
  pets: SheetPet[] | null;
  activeByPet: ReadonlyMap<string, QrTokenView>;
  selected: ReadonlySet<string>;
  truncation?: SheetTruncation | null;
  busy: boolean;
  error: string | null;
  canWrite: boolean;
  onToggle: (petId: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onIssueMissing: () => void;
  onPrint: () => void;
}) {
  const missing = (pets ?? []).filter((pet) => selected.has(pet.id) && !activeByPet.has(pet.id));
  const printable = (pets ?? []).filter((pet) => selected.has(pet.id) && activeByPet.has(pet.id));

  return (
    <div className="admin">
      <header className="admin__header no-print">
        <div>
          <h1 className="t-title">{t.tag.sheetTitle}</h1>
          <p className="admin__sub">{t.tag.sheetIntro}</p>
        </div>
        <div className="admin__header-actions">
          <Link href="/admin" className="btn btn--muted">
            {t.tag.backToPanel}
          </Link>
        </div>
      </header>

      {error && (
        <p className="auth__error no-print" role="alert">
          {error}
        </p>
      )}

      {pets === null && <p className="admin__sub no-print">{t.tag.loading}</p>}
      {pets?.length === 0 && !error && <p className="admin__sub no-print">{t.tag.sheetEmpty}</p>}
      {truncation && (
        <p className="auth__notice auth__notice--warn no-print" role="status">
          {t.tag.sheetTruncated(truncation.shown, truncation.total)}
        </p>
      )}

      {pets && pets.length > 0 && (
        <section className="no-print">
          <div className="qr-panel__actions">
            <button type="button" className="auth__link" onClick={onSelectAll}>
              {t.tag.selectAll}
            </button>
            <button type="button" className="auth__link" onClick={onClear}>
              {t.tag.clearSelection}
            </button>
          </div>

          <ul className="qr-pick">
            {pets.map((pet) => (
              <li key={pet.id} className="qr-pick__item">
                <label>
                  <input type="checkbox" checked={selected.has(pet.id)} onChange={() => onToggle(pet.id)} />
                  <span className="qr-pick__text">
                    <strong>{pet.name || '…'}</strong>
                    <span className="t-data">
                      {t.statusLabel(pet.status)}
                      {!activeByPet.has(pet.id) && (
                        <>
                          {' · '}
                          <span className="admin-list__flag">{t.tag.noTag}</span>
                        </>
                      )}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>

          <div className="admin__footer">
            <div className="admin__footer-left">
              {missing.length > 0 && (
                <button type="button" className="btn btn--muted" onClick={onIssueMissing} disabled={busy || !canWrite}>
                  {busy ? t.tag.issuing : t.tag.issueMissing(missing.length)}
                </button>
              )}
            </div>
            <div className="admin__footer-right">
              <button type="button" className="btn btn--action" onClick={onPrint} disabled={printable.length === 0}>
                {t.tag.printSheet(printable.length)}
              </button>
            </div>
          </div>
          {printable.length === 0 && <p className="auth__hint">{t.tag.nothingToPrint}</p>}
        </section>
      )}

      {printable.length > 0 && (
        <div className="qr-sheet">
          {printable.map((pet) => {
            const token = activeByPet.get(pet.id)!;
            return (
              <div key={pet.id} className="qr-sheet__cell">
                <span className="qr-sheet__label">{pet.name || '…'}</span>
                <QrTagCard
                  token={token.token}
                  siteUrl={SHELTER.siteUrl}
                  phoneLine={t.tag.phoneLine(SHELTER.whatsappDisplay)}
                  alt={t.tag.qrAlt(pet.name || '…')}
                />
              </div>
            );
          })}
        </div>
      )}

      <p className="qr-panel__limitation no-print">{t.tag.limitation}</p>
    </div>
  );
}
