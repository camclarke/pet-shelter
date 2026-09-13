'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

import { QrTagCard } from '@/components/QrTagCard';
import { SHELTER } from '@/config/shelter';
import { t } from '@/i18n';
import { getPetById } from '@/lib/areas-admin';
import { QR_PRINT_SIZE_MM, activeTokenOf } from '@/lib/qr-tokens';
import { listPetTokens, type QrTokenView } from '@/lib/qr-tokens-admin';
import type { Pet } from '@/lib/types';

/** One animal's active tag, ready to print. Issuing and revoking live on the internal page. */
export function PetQrPrint({ petId }: { petId: string }) {
  const [pet, setPet] = useState<Pet | null>(null);
  const [tokens, setTokens] = useState<QrTokenView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getPetById(petId), listPetTokens(petId)])
      .then(([found, list]) => {
        if (cancelled) return;
        setPet(found);
        setTokens(list);
      })
      .catch((caught) => {
        console.error('[admin/qr] could not load', caught);
        if (cancelled) return;
        setError(
          (caught as { code?: string })?.code === 'permission-denied' ? t.tag.permissionDenied : t.tag.loadFailed,
        );
        setTokens([]);
      });
    return () => {
      cancelled = true;
    };
  }, [petId]);

  const active = tokens ? activeTokenOf(tokens) : null;
  return <PetQrPrintView petId={petId} pet={pet} tokens={tokens} active={active} error={error} />;
}

export function PetQrPrintView({
  petId,
  pet,
  tokens,
  active,
  error,
}: {
  petId: string;
  pet: Pick<Pet, 'name'> | null;
  tokens: QrTokenView[] | null;
  active: QrTokenView | null;
  error: string | null;
}) {
  const name = pet?.name || '…';
  return (
    <div className="admin">
      <header className="admin__header no-print">
        <div>
          <h1 className="t-title">{pet ? t.tag.printTitle(name) : t.tag.panelTitle}</h1>
          <p className="admin__sub">{t.tag.printTip}</p>
        </div>
        <div className="admin__header-actions">
          <Link href={`/admin/pets/${petId}`} className="btn btn--muted">
            {t.tag.backToRecord}
          </Link>
          {active && (
            <button type="button" className="btn btn--action" onClick={() => window.print()}>
              {t.tag.print}
            </button>
          )}
        </div>
      </header>

      {error && (
        <p className="auth__error no-print" role="alert">
          {error}
        </p>
      )}
      {tokens === null && <p className="admin__sub no-print">{t.tag.loading}</p>}
      {tokens !== null && !active && !error && <p className="auth__notice no-print">{t.tag.noActiveTag}</p>}

      {active && (
        <div className="qr-sheet qr-sheet--single">
          <div className="qr-sheet__cell">
            <span className="qr-sheet__label">{name}</span>
            <QrTagCard
              token={active.token}
              siteUrl={SHELTER.siteUrl}
              phoneLine={t.tag.phoneLine(SHELTER.whatsappDisplay)}
              alt={t.tag.qrAlt(name)}
            />
          </div>
        </div>
      )}

      <p className="admin__sub no-print">
        {t.tag.printSize(QR_PRINT_SIZE_MM)} {t.tag.testTip}
      </p>
      <p className="qr-panel__limitation no-print">{t.tag.limitation}</p>
    </div>
  );
}
