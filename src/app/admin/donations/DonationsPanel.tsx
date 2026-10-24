'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { collection, doc, getDoc, getDocs, limit, orderBy, query, where } from 'firebase/firestore';

import { useAuth } from '@/components/AuthProvider';
import {
  ACCOUNT_TYPES,
  CURRENCIES,
  DONATION_HISTORY_PATH,
  DONATION_LIMITS,
  DONATION_PENDING_PATH,
  DONATION_SETTINGS_PATH,
  accountNumbersMatch,
  canConfirm,
  diffSettings,
  parseHistoryEntry,
  parsePending,
  parseSettings,
  qrExpiryState,
  qrExpiresSoon,
  validateProposal,
  type AccountType,
  type Currency,
  type DonationHistoryEntry,
  type DonationMethod,
  type DonationMethodKind,
  type DonationPending,
  type DonationSettings,
  type QrAction,
} from '@/lib/donations';
import {
  DonationApiError,
  confirmDonation,
  fetchPendingQrObjectUrl,
  proposeDonation,
  qrFileProblem,
  rejectDonation,
  uploadPendingQr,
} from '@/lib/donations-client';
import { METHOD_FIELD_LABEL, METHOD_KIND_LABEL, PROPOSAL_ERROR_TEXT, donationFailureText } from '@/lib/donations-copy';
import { formatDayKey, formatDonationDateTime } from '@/lib/donations-format';
import type { ProposeRequest } from '@/lib/donations-protocol';
import { getFirebase } from '@/lib/firebase-client';
import { ReauthPrompt } from './ReauthPrompt';

/**
 * Tesorería's screen: the confirmed donation details, the two-person change
 * (propose, then someone ELSE confirms), and the history.
 *
 * ⚠️ This screen is not the security boundary. `firestore.rules` lets only
 * Tesorería and the superuser read the proposals and the history, and the
 * routes decide who may propose, confirm or reject (`donations-handler.ts`);
 * `canConfirm()` here only decides whether to OFFER the buttons.
 *
 * Reads go straight to Firestore under the rules; writes go through the
 * routes, with a fresh sign-in (`requires-recent-login` → «Confirma que eres
 * tú», then the same action runs again).
 */

const FIELDS = ['kind', 'bankName', 'accountHolder', 'accountNumber', 'accountType', 'currency', 'note'] as const;

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const CURRENCY_LABEL: Record<Currency, string> = { BOB: 'Bolivianos (BOB)', USD: 'Dólares (USD)' };

interface Loaded {
  current: DonationSettings | null;
  pending: DonationPending[];
  history: DonationHistoryEntry[];
}

type Status = { at: string; kind: 'error' | 'notice'; text: string };
type Action = () => Promise<string | null>;

function errorText(error: unknown): string {
  if (error instanceof DonationApiError) return donationFailureText(error.failure, error.detail);
  console.error('[donations]', error);
  return donationFailureText(null);
}

export function DonationsPanel() {
  const { user, roles } = useAuth();
  const [data, setData] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [reauth, setReauth] = useState<{ at: string; retry: Action } | null>(null);

  const reload = useCallback(async () => {
    try {
      const { db } = getFirebase();
      const [currentSnap, pendingSnap, historySnap] = await Promise.all([
        getDoc(doc(db, DONATION_SETTINGS_PATH)),
        getDocs(query(collection(db, DONATION_PENDING_PATH), where('status', '==', 'pending'))),
        getDocs(query(collection(db, DONATION_HISTORY_PATH), orderBy('decidedAt', 'desc'), limit(20))),
      ]);
      const pending = pendingSnap.docs
        .map((d) => parsePending(d.id, d.data()))
        .filter((p): p is DonationPending => p !== null)
        .sort((a, b) => (b.proposedAt ?? 0) - (a.proposedAt ?? 0));
      const history = historySnap.docs.map((d) => parseHistoryEntry(d.id, d.data())).filter((h): h is DonationHistoryEntry => h !== null);
      setData({ current: currentSnap.exists() ? parseSettings(currentSnap.data()) : null, pending, history });
      setLoadError(false);
    } catch (error) {
      console.error('[donations] load', error);
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Runs one action; a stale sign-in asks to confirm identity and runs the SAME action again. */
  function run(at: string, action: Action) {
    setBusy(true);
    setStatus(null);
    action()
      .then(async (message) => {
        if (message) setStatus({ at, kind: 'notice', text: message });
        await reload();
      })
      .catch((error) => {
        if (error instanceof DonationApiError && error.failure === 'requires-recent-login') {
          setReauth({ at, retry: action });
          return;
        }
        setStatus({ at, kind: 'error', text: errorText(error) });
      })
      .finally(() => setBusy(false));
  }

  if (!user) return null;

  const statusAt = (at: string) =>
    status?.at === at ? (
      <p className={status.kind === 'error' ? 'auth__error' : 'auth__notice'} role={status.kind === 'error' ? 'alert' : 'status'}>
        {status.text}
      </p>
    ) : null;

  const reauthAt = (at: string) =>
    reauth?.at === at ? (
      <ReauthPrompt
        user={user}
        busy={busy}
        onCancel={() => setReauth(null)}
        onConfirmed={() => {
          const kept = reauth;
          setReauth(null);
          if (kept) run(kept.at, kept.retry);
        }}
      />
    ) : null;

  const current = data?.current ?? null;
  const now = Date.now();
  const expiry = current ? qrExpiryState(current, now) : 'none';

  return (
    <div className="admin">
      <header className="admin__header">
        <div>
          <h1 className="t-title">Donaciones</h1>
          <p className="admin__sub">
            Los datos que ven las personas que quieren donar. Todo cambio lo propone una persona y lo confirma otra.
          </p>
        </div>
        <div className="admin__header-actions">
          <Link href="/admin" className="btn btn--muted">
            Volver al panel
          </Link>
        </div>
      </header>

      {loadError && (
        <p className="auth__error" role="alert">
          No se pudieron cargar los datos de donaciones.{' '}
          <button type="button" className="auth__link" onClick={() => void reload()}>
            Reintentar
          </button>
        </p>
      )}
      {!data && !loadError && <p aria-busy="true">Cargando…</p>}

      {data && (
        <>
          {/* ── what is live now ─────────────────────────────────────────── */}
          <section className="donations__section" aria-labelledby="donations-current">
            <h2 id="donations-current" className="t-data">
              Datos actuales
            </h2>
            {current ? (
              <>
                <p className="t-data">
                  Versión {current.version}
                  {current.updatedAt !== null && <> · actualizada el {formatDonationDateTime(current.updatedAt)}</>}
                </p>
                <div className="donations__side">
                  <SideRows methods={current.methods} active={current.active} />
                </div>
                {current.qrPath && (
                  <>
                    {current.qrExpiresAt && <p className="t-data">El QR vence el {formatDayKey(current.qrExpiresAt)}.</p>}
                    {(expiry === 'soon' || qrExpiresSoon(current, now)) && (
                      <p className="auth__notice auth__notice--warn" role="status">
                        El QR vence pronto. Prepara uno nuevo con tiempo y propónlo.
                      </p>
                    )}
                    {expiry === 'expired' && (
                      <p className="auth__error" role="alert">
                        El QR ya venció y no se muestra al público. Propón uno nuevo.
                      </p>
                    )}
                  </>
                )}
              </>
            ) : (
              <p>Todavía no hay datos confirmados. La página pública no muestra nada hasta que se confirmen.</p>
            )}
          </section>

          {/* ── a proposal waiting for someone else ──────────────────────── */}
          <section className="donations__section" aria-labelledby="donations-pending">
            <h2 id="donations-pending" className="t-data">
              Propuesta pendiente
            </h2>
            {data.pending.length === 0 && <p>No hay ninguna propuesta pendiente.</p>}
            {data.pending.map((pending) => (
              <PendingReview
                key={pending.id}
                pending={pending}
                current={current}
                callerUid={user.uid}
                roles={roles}
                busy={busy}
                run={run}
                user={user}
                statusNode={statusAt(pending.id)}
                reauthNode={reauthAt(pending.id)}
              />
            ))}
          </section>

          {/* ── propose a change ─────────────────────────────────────────── */}
          <section className="donations__section" aria-labelledby="donations-propose">
            <h2 id="donations-propose" className="t-data">
              Proponer un cambio
            </h2>
            <ProposeForm
              key={`${current?.version ?? 0}`}
              user={user}
              current={current}
              busy={busy}
              run={run}
              statusNode={statusAt('propose')}
              reauthNode={reauthAt('propose')}
            />
          </section>

          {/* ── history ──────────────────────────────────────────────────── */}
          <section className="donations__section" aria-labelledby="donations-history">
            <h2 id="donations-history" className="t-data">
              Historial
            </h2>
            {data.history.length === 0 ? (
              <p>Todavía no hay cambios registrados.</p>
            ) : (
              <ul className="admin-list__items">
                {data.history.map((entry) => (
                  <li key={entry.id} className="admin-list__item--record">
                    <div>
                      <strong>{entry.kind === 'confirmed' ? `Confirmado (versión ${entry.version ?? '?'})` : 'Rechazado'}</strong>
                      <span className="t-data">
                        {entry.decidedAt !== null ? formatDonationDateTime(entry.decidedAt) : 'Fecha desconocida'}
                      </span>
                      <span className="t-data">
                        Propuso: {entry.proposedByEmail ?? 'desconocido'} · {entry.kind === 'confirmed' ? 'Confirmó' : 'Rechazó'}:{' '}
                        {entry.decidedByEmail ?? 'desconocido'}
                      </span>
                      {entry.reason && <span>Motivo: {entry.reason}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading a set of details
// ─────────────────────────────────────────────────────────────────────────────

function fieldText(method: DonationMethod, field: (typeof FIELDS)[number]): string {
  switch (field) {
    case 'kind':
      return METHOD_KIND_LABEL[method.kind];
    case 'accountType':
      return capitalize(method.accountType);
    case 'currency':
      return CURRENCY_LABEL[method.currency];
    default:
      return method[field] || '—';
  }
}

function Row({ label, value, changed }: { label: string; value: string; changed?: boolean }) {
  return (
    <dl className={`donations__row${changed ? ' donations__row--changed' : ''}`} style={{ margin: 0 }}>
      <dt>
        {label}
        {changed && <span className="donations__tag">Cambió</span>}
      </dt>
      <dd>{value}</dd>
    </dl>
  );
}

/** The methods of one side. `changed` holds the `diffSettings` paths; omit it to show plain details. */
function SideRows({
  methods,
  active,
  changed,
  extra,
  length,
}: {
  methods: DonationMethod[];
  active: boolean;
  changed?: Set<string>;
  extra?: React.ReactNode;
  /** How many method slots to show, so the two sides line up when one has fewer. */
  length?: number;
}) {
  const slots = Math.max(length ?? 0, methods.length);
  const rows: React.ReactNode[] = [];
  for (let i = 0; i < slots; i++) {
    const method = methods[i];
    const whole = changed?.has(`methods[${i}]`) ?? false;
    rows.push(
      <div key={i} className="donations__method">
        <p className="t-data">Forma de donar {i + 1}</p>
        {method ? (
          FIELDS.map((field) => (
            <Row
              key={field}
              label={METHOD_FIELD_LABEL[field]}
              value={fieldText(method, field)}
              changed={whole || (changed?.has(`methods[${i}].${field}`) ?? false)}
            />
          ))
        ) : (
          <Row label="Esta forma de donar" value="No existe" changed={whole} />
        )}
      </div>,
    );
  }
  return (
    <>
      {rows}
      <Row label="Página pública" value={active ? 'Se muestra' : 'Oculta'} changed={changed?.has('active')} />
      {extra}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reviewing a proposal
// ─────────────────────────────────────────────────────────────────────────────

function PendingReview({
  pending,
  current,
  callerUid,
  roles,
  busy,
  run,
  user,
  statusNode,
  reauthNode,
}: {
  pending: DonationPending;
  current: DonationSettings | null;
  callerUid: string;
  roles: ReturnType<typeof useAuth>['roles'];
  busy: boolean;
  run(at: string, action: Action): void;
  user: NonNullable<ReturnType<typeof useAuth>['user']>;
  statusNode: React.ReactNode;
  reauthNode: React.ReactNode;
}) {
  const [calledProposer, setCalledProposer] = useState(false);
  const [scannedQr, setScannedQr] = useState(false);
  const [reason, setReason] = useState('');

  const { proposal } = pending;
  const mayDecide = canConfirm({ callerUid, callerRoles: roles, proposerUid: pending.proposedBy });
  const diff = diffSettings(current, proposal);
  const changed = new Set(diff.map((d) => d.path));
  const qrRemains = proposal.qrAction === 'replace' || (proposal.qrAction === 'keep' && Boolean(current?.qrPath));
  const slots = Math.max(current?.methods.length ?? 0, proposal.methods.length);
  const qrInProposal = proposal.qrAction === 'replace';
  const ready = calledProposer && (!qrInProposal || scannedQr);

  const qrLabel =
    proposal.qrAction === 'replace' ? 'QR nuevo (se ve abajo)' : proposal.qrAction === 'keep' && current?.qrPath ? 'Se mantiene el actual' : 'Sin QR';

  return (
    <article className="admin-list__item--record" style={{ marginTop: 'var(--space-2)' }}>
      <p>
        Propuso <strong>{pending.proposedByEmail ?? 'una persona'}</strong>
        {pending.proposedAt !== null && <> el {formatDonationDateTime(pending.proposedAt)}</>}.
      </p>

      <div className="donations__compare">
        <div className="donations__side">
          <h3 className="t-data">Actual</h3>
          {current ? (
            <SideRows
              methods={current.methods}
              active={current.active}
              changed={changed}
              length={slots}
              extra={
                <>
                  <Row label="QR" value={current.qrPath ? 'Hay un QR publicado' : 'Sin QR'} changed={changed.has('qr')} />
                  <Row label="El QR vence el" value={current.qrPath && current.qrExpiresAt ? formatDayKey(current.qrExpiresAt) : '—'} changed={changed.has('qrExpiresAt')} />
                </>
              }
            />
          ) : (
            <p>Todavía no hay datos confirmados.</p>
          )}
        </div>
        <div className="donations__side">
          <h3 className="t-data">Propuesto</h3>
          <SideRows
            methods={proposal.methods}
            active={proposal.active}
            changed={changed}
            length={slots}
            extra={
              <>
                <Row label="QR" value={qrLabel} changed={changed.has('qr')} />
                <Row label="El QR vence el" value={qrRemains && proposal.qrExpiresAt ? formatDayKey(proposal.qrExpiresAt) : '—'} changed={changed.has('qrExpiresAt')} />
              </>
            }
          />
        </div>
      </div>

      {diff.length === 0 && <p className="t-data">Esta propuesta no cambia ningún dato.</p>}

      {qrInProposal &&
        (pending.qrPath ? (
          <ProposedQr user={user} pendingId={pending.id} />
        ) : (
          <p className="auth__error" role="alert">
            Falta subir el QR de esta propuesta. No se puede confirmar: quien la hizo debe proponer de nuevo.
          </p>
        ))}

      {!mayDecide ? (
        <p className="auth__notice" role="status">
          Esperando confirmación de otra persona.
        </p>
      ) : (
        <>
          <label className="donations__check">
            <input type="checkbox" checked={calledProposer} onChange={(e) => setCalledProposer(e.target.checked)} disabled={busy} />
            <span>Llamé a quien propuso el cambio y lo confirmó.</span>
          </label>
          {qrInProposal && (
            <label className="donations__check">
              <input type="checkbox" checked={scannedQr} onChange={(e) => setScannedQr(e.target.checked)} disabled={busy} />
              <span>Escaneé el QR con la app de mi banco y el titular coincide.</span>
            </label>
          )}
          <div className="account__form-actions">
            <button
              type="button"
              className="btn btn--brand"
              disabled={busy || !ready}
              onClick={() =>
                run(pending.id, async () => {
                  await confirmDonation(user, pending.id);
                  return 'Cambio confirmado. La página pública puede tardar hasta 5 minutos en mostrarlo.';
                })
              }
            >
              Confirmar
            </button>
          </div>
          <label className="auth__field">
            <span className="t-label">Motivo del rechazo (opcional)</span>
            <textarea value={reason} maxLength={DONATION_LIMITS.reasonMax} rows={2} onChange={(e) => setReason(e.target.value)} disabled={busy} />
          </label>
          <div className="account__form-actions">
            <button
              type="button"
              className="btn btn--muted"
              disabled={busy}
              onClick={() =>
                run(pending.id, async () => {
                  await rejectDonation(user, pending.id, reason);
                  return 'Propuesta rechazada.';
                })
              }
            >
              Rechazar
            </button>
          </div>
        </>
      )}
      {statusNode}
      {reauthNode}
    </article>
  );
}

/** The QR a proposal would publish, fetched with the caller's token. The object URL is revoked on unmount. */
function ProposedQr({ user, pendingId }: { user: NonNullable<ReturnType<typeof useAuth>['user']>; pendingId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let made: string | null = null;
    fetchPendingQrObjectUrl(user, pendingId)
      .then((objectUrl) => {
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        made = objectUrl;
        setUrl(objectUrl);
      })
      .catch((error) => {
        console.error('[donations] proposed QR', error);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [user, pendingId]);

  return (
    <div>
      <p className="t-data">QR propuesto</p>
      {failed && <p className="auth__error">No se pudo cargar el QR propuesto. Recarga la página.</p>}
      {!failed && !url && <p aria-busy="true">Cargando el QR…</p>}
      {url && (
        // eslint-disable-next-line @next/next/no-img-element -- an object URL made from the fetched bytes
        <img className="donations__qr-img" src={url} alt="QR propuesto para donaciones" />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Proposing
// ─────────────────────────────────────────────────────────────────────────────

interface MethodDraft {
  uid: number;
  kind: DonationMethodKind;
  bankName: string;
  accountHolder: string;
  accountNumber: string;
  accountNumberConfirm: string;
  accountType: AccountType;
  currency: Currency;
  note: string;
}

let draftCounter = 0;
const emptyMethod = (): MethodDraft => ({
  uid: ++draftCounter,
  kind: 'bank',
  bankName: '',
  accountHolder: '',
  accountNumber: '',
  accountNumberConfirm: '',
  accountType: 'caja de ahorro',
  currency: 'BOB',
  note: '',
});

function draftsFrom(current: DonationSettings | null): MethodDraft[] {
  if (!current || current.methods.length === 0) return [emptyMethod()];
  // The number is prefilled; the second typing starts empty on purpose.
  return current.methods.map((m) => ({ ...emptyMethod(), ...m, accountNumberConfirm: '' }));
}

function ProposeForm({
  user,
  current,
  busy,
  run,
  statusNode,
  reauthNode,
}: {
  user: NonNullable<ReturnType<typeof useAuth>['user']>;
  current: DonationSettings | null;
  busy: boolean;
  run(at: string, action: Action): void;
  statusNode: React.ReactNode;
  reauthNode: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [methods, setMethods] = useState<MethodDraft[]>(() => draftsFrom(current));
  const [active, setActive] = useState(current?.active ?? true);
  const [qrAction, setQrAction] = useState<QrAction>(current?.qrPath ? 'keep' : 'remove');
  const [qrExpiresAt, setQrExpiresAt] = useState(current?.qrExpiresAt && current.qrPath ? current.qrExpiresAt : '');
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // A proposal that already created its record but needs the QR upload retried
  // (a stale sign-in in between) must not create a second record.
  const staged = useRef<string | null>(null);
  const uploadFailed = useRef(false);

  function patch(uid: number, change: Partial<MethodDraft>) {
    setMethods((all) => all.map((m) => (m.uid === uid ? { ...m, ...change } : m)));
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setProblem(null);

    const request: ProposeRequest = {
      methods: methods.map(({ uid: _uid, ...m }) => m),
      active,
      qrExpiresAt: qrAction === 'remove' || qrExpiresAt === '' ? null : qrExpiresAt,
      qrAction,
    };
    const checked = validateProposal(request, Date.now());
    if (!checked.ok) return setProblem(PROPOSAL_ERROR_TEXT[checked.error]);
    if (qrAction === 'replace') {
      if (!file) return setProblem('Elige la imagen del QR nuevo.');
      const fileProblem = qrFileProblem(file);
      if (fileProblem) return setProblem(fileProblem);
    }

    const upload = qrAction === 'replace' ? file : null;
    run('propose', async () => {
      try {
        let pendingId = staged.current;
        if (!pendingId) {
          pendingId = (await proposeDonation(user, request)).pendingId;
          staged.current = pendingId;
        }
        if (upload) {
          uploadFailed.current = true;
          await uploadPendingQr(user, pendingId, upload);
          uploadFailed.current = false;
        }
        staged.current = null;
        setOpen(false);
        setFile(null);
        return 'Propuesta enviada. Falta que otra persona la confirme.';
      } catch (error) {
        const stale = error instanceof DonationApiError && error.failure === 'requires-recent-login';
        if (!stale) {
          if (uploadFailed.current) {
            setProblem('La propuesta se creó, pero sin el QR, y no se podrá confirmar. Propón de nuevo.');
          }
          staged.current = null;
          uploadFailed.current = false;
        }
        throw error;
      }
    });
  }

  if (!open) {
    return (
      <>
        <button type="button" className="btn btn--action" onClick={() => setOpen(true)} disabled={busy}>
          {current ? 'Proponer un cambio' : 'Proponer los primeros datos'}
        </button>
        {statusNode}
        {reauthNode}
      </>
    );
  }

  return (
    <form className="account__form" onSubmit={submit} noValidate>
      {methods.map((m, index) => {
        const mismatch = m.accountNumberConfirm !== '' && !accountNumbersMatch(m.accountNumber, m.accountNumberConfirm);
        const matches = m.accountNumberConfirm !== '' && !mismatch;
        return (
          <fieldset key={m.uid} className="donations__method-form" disabled={busy}>
            <legend className="t-data">Forma de donar {index + 1}</legend>

            <label className="auth__field">
              <span className="t-label">Tipo</span>
              <select value={m.kind} onChange={(e) => patch(m.uid, { kind: e.target.value as DonationMethodKind })}>
                <option value="bank">{METHOD_KIND_LABEL.bank}</option>
                <option value="qr">{METHOD_KIND_LABEL.qr}</option>
              </select>
            </label>
            <label className="auth__field">
              <span className="t-label">Banco</span>
              <input value={m.bankName} maxLength={DONATION_LIMITS.bankNameMax} onChange={(e) => patch(m.uid, { bankName: e.target.value })} />
            </label>
            <label className="auth__field">
              <span className="t-label">Titular de la cuenta</span>
              <input
                value={m.accountHolder}
                maxLength={DONATION_LIMITS.accountHolderMax}
                onChange={(e) => patch(m.uid, { accountHolder: e.target.value })}
              />
            </label>
            <label className="auth__field">
              <span className="t-label">Tipo de cuenta</span>
              <select value={m.accountType} onChange={(e) => patch(m.uid, { accountType: e.target.value as AccountType })}>
                {ACCOUNT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {capitalize(type)}
                  </option>
                ))}
              </select>
            </label>
            <label className="auth__field">
              <span className="t-label">Moneda</span>
              <select value={m.currency} onChange={(e) => patch(m.uid, { currency: e.target.value as Currency })}>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {CURRENCY_LABEL[c]}
                  </option>
                ))}
              </select>
            </label>
            <label className="auth__field">
              <span className="t-label">Número de cuenta{m.kind === 'qr' ? ' (opcional en un QR)' : ''}</span>
              <input value={m.accountNumber} inputMode="text" autoComplete="off" onChange={(e) => patch(m.uid, { accountNumber: e.target.value })} />
              <small className="auth__hint">Puedes escribirlo con espacios o guiones; se guarda sin ellos.</small>
            </label>
            <label className="auth__field">
              <span className="t-label">Escribe el número de cuenta otra vez</span>
              <input
                value={m.accountNumberConfirm}
                inputMode="text"
                autoComplete="off"
                onChange={(e) => patch(m.uid, { accountNumberConfirm: e.target.value })}
              />
              {mismatch && (
                <small className="auth__hint" role="alert">
                  Los dos números no coinciden.
                </small>
              )}
              {matches && <small className="auth__hint">Los dos números coinciden.</small>}
            </label>
            <label className="auth__field">
              <span className="t-label">Nota (opcional)</span>
              <textarea value={m.note} rows={2} maxLength={DONATION_LIMITS.noteMax} onChange={(e) => patch(m.uid, { note: e.target.value })} />
            </label>

            {methods.length > 1 && (
              <button type="button" className="auth__link" onClick={() => setMethods((all) => all.filter((x) => x.uid !== m.uid))}>
                Quitar esta forma de donar
              </button>
            )}
          </fieldset>
        );
      })}

      {methods.length < DONATION_LIMITS.methodsMax && (
        <button type="button" className="btn btn--muted" onClick={() => setMethods((all) => [...all, emptyMethod()])} disabled={busy}>
          Agregar otra forma de donar
        </button>
      )}

      <label className="donations__check">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} disabled={busy} />
        <span>Mostrar la página pública de donaciones</span>
      </label>

      <fieldset className="donations__method-form" disabled={busy}>
        <legend className="t-data">QR</legend>
        {current?.qrPath && (
          <label className="donations__check">
            <input type="radio" name="qr-action" checked={qrAction === 'keep'} onChange={() => setQrAction('keep')} />
            <span>Mantener el QR actual</span>
          </label>
        )}
        <label className="donations__check">
          <input type="radio" name="qr-action" checked={qrAction === 'replace'} onChange={() => setQrAction('replace')} />
          <span>Subir un QR nuevo</span>
        </label>
        <label className="donations__check">
          <input type="radio" name="qr-action" checked={qrAction === 'remove'} onChange={() => setQrAction('remove')} />
          <span>Sin QR</span>
        </label>

        {qrAction === 'replace' && (
          <label className="auth__field">
            <span className="t-label">Imagen del QR (JPG o PNG, hasta 2 MB)</span>
            <input type="file" accept="image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
        )}
        {qrAction !== 'remove' && (
          <label className="auth__field">
            <span className="t-label">El QR vence el (opcional)</span>
            <input type="date" value={qrExpiresAt} onChange={(e) => setQrExpiresAt(e.target.value)} />
          </label>
        )}
      </fieldset>

      {problem && (
        <p className="auth__error" role="alert">
          {problem}
        </p>
      )}
      {statusNode}
      {reauthNode}

      <div className="account__form-actions">
        <button type="submit" className="btn btn--brand" disabled={busy}>
          {busy ? 'Un momento…' : 'Enviar propuesta'}
        </button>
        <button type="button" className="auth__link" onClick={() => setOpen(false)} disabled={busy}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
