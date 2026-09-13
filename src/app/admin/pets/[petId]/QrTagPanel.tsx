/**
 * The tag section of an animal's internal page: issue one, see it, print it,
 * revoke it, reissue it. Build-order step 12, plan §7.
 *
 * ── Revoking is two taps, on purpose ──────────────────────────────────────
 * The rules make a revoke one-way: nothing, not even an admin, can make a tag
 * work again. So the first tap only asks, in the page rather than in a browser
 * `confirm()` dialog a phone renders as an easily-dismissed system sheet, and
 * says what happens to whoever scans the old tag next.
 *
 * This is a CONFIRMATION, not a block: the shelter can always revoke. A lost
 * collar is exactly when they must be able to, fast.
 *
 * ⚠️ Until the qrTokens rules are deployed, every read and write here is
 * refused with `permission-denied` and the panel says so. See
 * `qr-tokens-admin.ts`.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import { useAuth } from '@/components/AuthProvider';
import { formatDate } from '@/lib/date-input';
import { activeTokenOf, formatQrToken } from '@/lib/qr-tokens';
import {
  issueQrToken,
  listPetTokens,
  revokeQrToken,
  type QrTokenView,
} from '@/lib/qr-tokens-admin';
import { t } from '@/i18n';

type Confirming = 'revoke' | 'reissue' | null;

function failureMessage(caught: unknown, fallback: string): string {
  return (caught as { code?: string })?.code === 'permission-denied' ? t.tag.permissionDenied : fallback;
}

export function QrTagPanel({ petId, petName }: { petId: string; petName: string }) {
  const { user } = useAuth();
  const [tokens, setTokens] = useState<QrTokenView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);

  const load = useCallback(async () => {
    try {
      setTokens(await listPetTokens(petId));
    } catch (caught) {
      console.error('[admin/qr] could not load tokens', caught);
      setError(failureMessage(caught, t.tag.loadFailed));
      setTokens([]);
    }
  }, [petId]);

  useEffect(() => {
    void load();
  }, [load]);

  const active = tokens ? activeTokenOf(tokens) : null;

  async function run(action: () => Promise<unknown>, failure: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setConfirming(null);
      await load();
    } catch (caught) {
      console.error('[admin/qr] action failed', caught);
      setError(failureMessage(caught, failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <QrTagPanelView
      petId={petId}
      petName={petName}
      tokens={tokens}
      active={active}
      busy={busy}
      error={error}
      confirming={confirming}
      canWrite={user !== null}
      onConfirm={setConfirming}
      onIssue={() => user && void run(() => issueQrToken(petId, user), t.tag.issueFailed)}
      onReissue={() =>
        user && active && void run(() => issueQrToken(petId, user, [active.token]), t.tag.issueFailed)
      }
      onRevoke={() => active && void run(() => revokeQrToken(active.token), t.tag.revokeFailed)}
    />
  );
}

/** The markup, with no state and no Firestore — so it can be rendered on its own to check at 360px. */
export function QrTagPanelView({
  petId,
  petName,
  tokens,
  active,
  busy,
  error,
  confirming,
  canWrite,
  onConfirm,
  onIssue,
  onReissue,
  onRevoke,
}: {
  petId: string;
  petName: string;
  tokens: QrTokenView[] | null;
  active: QrTokenView | null;
  busy: boolean;
  error: string | null;
  confirming: Confirming;
  canWrite: boolean;
  onConfirm: (value: Confirming) => void;
  onIssue: () => void;
  onReissue: () => void;
  onRevoke: () => void;
}) {
  const others = (tokens ?? []).filter((token) => token.token !== active?.token);
  const activeCode = active ? formatQrToken(active.token) : '';

  return (
    <section className="admin-list qr-panel">
      <h2 className="t-label">{t.tag.panelTitle}</h2>

      {error && (
        <p className="auth__error" role="alert">
          {error}
        </p>
      )}

      {tokens === null && <p className="admin__sub">{t.tag.loading}</p>}
      {tokens !== null && !active && <p className="admin__sub">{t.tag.noneYet}</p>}

      {active && (
        <div className="qr-panel__current">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="qr-panel__preview"
            src={`/api/qr/${active.token}`}
            alt={t.tag.qrAlt(petName)}
            width={100}
            height={100}
          />
          <div className="qr-panel__details">
            <p className="qr-panel__code">{activeCode}</p>
            <p className="t-data">
              {t.tag.activeSince(activeCode, active.createdAt ? formatDate(active.createdAt) : '…')}
            </p>
          </div>
        </div>
      )}

      {confirming && active && (
        <div className="auth__notice auth__notice--warn qr-panel__confirm" role="alertdialog">
          <p>{confirming === 'revoke' ? t.tag.revokeConfirm(activeCode) : t.tag.reissueConfirm(activeCode)}</p>
          <div className="qr-panel__actions">
            <button type="button" className="btn btn--muted" onClick={() => onConfirm(null)} disabled={busy}>
              {t.tag.cancel}
            </button>
            <button
              type="button"
              className="btn btn--action"
              onClick={confirming === 'revoke' ? onRevoke : onReissue}
              disabled={busy}
            >
              {busy ? t.tag.issuing : confirming === 'revoke' ? t.tag.confirmRevoke : t.tag.confirmReissue}
            </button>
          </div>
        </div>
      )}

      {tokens !== null && !confirming && (
        <div className="qr-panel__actions">
          {!active && (
            <button type="button" className="btn btn--action" onClick={onIssue} disabled={busy || !canWrite}>
              {busy ? t.tag.issuing : t.tag.issue}
            </button>
          )}
          {active && (
            <>
              <Link href={`/admin/pets/${petId}/qr`} className="btn btn--action">
                {t.tag.print}
              </Link>
              <button type="button" className="btn btn--muted" onClick={() => onConfirm('reissue')} disabled={busy}>
                {t.tag.reissue}
              </button>
              <button type="button" className="btn btn--muted" onClick={() => onConfirm('revoke')} disabled={busy}>
                {t.tag.revoke}
              </button>
            </>
          )}
        </div>
      )}

      {others.length > 0 && (
        <ul className="qr-panel__history">
          {others.map((token) => {
            const code = formatQrToken(token.token);
            const created = token.createdAt ? formatDate(token.createdAt) : '…';
            return (
              <li key={token.token} className={token.revokedAt === null ? 'qr-panel__history-alert' : undefined}>
                {token.revokedAt === null
                  ? t.tag.alsoActive(code, created)
                  : t.tag.revokedOn(code, token.revokedAt ? formatDate(token.revokedAt) : '…')}
              </li>
            );
          })}
        </ul>
      )}

      <p className="qr-panel__limitation">{t.tag.limitation}</p>
    </section>
  );
}
