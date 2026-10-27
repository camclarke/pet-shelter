'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { collection, getDocs, limit, orderBy, query } from 'firebase/firestore';

import { useAuth } from '@/components/AuthProvider';
import { ROLE_LABELS } from '@/config/roles';
import { formatDonationDateTime } from '@/lib/donations-format';
import { getFirebase } from '@/lib/firebase-client';
import { NO_ACCOUNT_HINT, type GrantableRole, type StaffMember, type StaffResponse } from '@/lib/role-admin-protocol';
import { RoleApiError, changeRole, fetchStaff } from '@/lib/roles-client';
import { STAFF_LOAD_ERROR, roleAction, roleFailureText, roleName } from '@/lib/roles-copy';
import { ReauthPrompt } from '../donations/ReauthPrompt';

/**
 * «Roles del equipo»: who holds which role, and the buttons to change it.
 *
 * ⚠️ Not the security boundary. The routes decide (`role-admin-handler.ts`,
 * guardrails G1–G4); this screen only OFFERS what each row's `editable` lists
 * say, and never keeps a role list of its own. The role audit is read straight
 * from Firestore under the rules (owner and superuser only).
 */

interface AuditRow {
  id: string;
  at: number | null;
  actor: string;
  targetEmail: string;
  role: string;
  action: string;
  outcome: string;
}

type Status = { kind: 'error' | 'notice'; text: string };
type Action = () => Promise<string | null>;

function errorText(error: unknown): string {
  if (error instanceof RoleApiError) return roleFailureText(error.failure);
  console.error('[roles]', error);
  return roleFailureText(null);
}

function toAuditRow(id: string, data: Record<string, unknown>): AuditRow {
  const at = data.at as { toMillis?: () => number } | null | undefined;
  const text = (value: unknown, fallback: string) => (typeof value === 'string' && value ? value : fallback);
  return {
    id,
    at: at && typeof at.toMillis === 'function' ? at.toMillis() : null,
    actor: text(data.actor, 'desconocido'),
    targetEmail: text(data.targetEmail, 'desconocido'),
    role: text(data.role, ''),
    action: text(data.action, ''),
    outcome: text(data.outcome, ''),
  };
}

function joinNames(labels: string[]): string {
  return labels.length > 0 ? labels.join(', ') : 'ningún rol';
}

export function RolesPanel() {
  const { user } = useAuth();
  const [data, setData] = useState<StaffResponse | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [reauth, setReauth] = useState<{ retry: Action } | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<GrantableRole | ''>('');

  const reload = useCallback(async () => {
    if (!user) return;
    try {
      setData(await fetchStaff(user));
      setLoadError(false);
    } catch (error) {
      console.error('[roles] load', error);
      setLoadError(true);
    }
    try {
      const { db } = await getFirebase();
      const snap = await getDocs(query(collection(db, 'roleAudit'), orderBy('at', 'desc'), limit(20)));
      setAudit(snap.docs.map((d) => toAuditRow(d.id, d.data())));
    } catch (error) {
      console.error('[roles] audit', error);
    }
  }, [user]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Runs one change; a stale sign-in asks to confirm identity and runs the SAME change again. */
  function run(action: Action) {
    setBusy(true);
    setStatus(null);
    action()
      .then(async (message) => {
        if (message) setStatus({ kind: 'notice', text: message });
        await reload();
      })
      .catch((error) => {
        if (error instanceof RoleApiError && error.failure === 'requires-recent-login') {
          setReauth({ retry: action });
          return;
        }
        setStatus({ kind: 'error', text: errorText(error) });
        // A server-side failure may have changed something: show how the account really is.
        if (error instanceof RoleApiError && error.status >= 500) void reload();
      })
      .finally(() => setBusy(false));
  }

  function change(target: string, targetRole: GrantableRole, action: 'grant' | 'revoke'): Action {
    return async () => {
      if (!user) return null;
      const result = await changeRole(user, { email: target, role: targetRole, action });
      return `Listo: ${result.email ?? target} ahora tiene ${joinNames(result.labels)}.`;
    };
  }

  if (!user) return null;

  const grantable = data?.grantable ?? [];
  const chosenRole = role || grantable[0] || '';

  return (
    <div className="admin">
      <header className="admin__header">
        <div>
          <h1 className="t-title">Roles del equipo</h1>
          <p className="admin__sub">
            Quién puede hacer qué en el panel.
            {grantable.length > 0 && ` Puedes dar o quitar estos roles: ${grantable.map((key) => ROLE_LABELS[key]).join(', ')}.`}
          </p>
          <p className="t-data">
            El cambio llega a la otra persona en menos de 1 hora, o al instante si cierra sesión y vuelve a entrar.
          </p>
        </div>
        <div className="admin__header-actions">
          <Link href="/admin" className="btn btn--muted">
            Volver al panel
          </Link>
        </div>
      </header>

      {status && (
        <p className={status.kind === 'error' ? 'auth__error' : 'auth__notice'} role={status.kind === 'error' ? 'alert' : 'status'}>
          {status.text}
        </p>
      )}

      {reauth && (
        <ReauthPrompt
          user={user}
          busy={busy}
          onCancel={() => setReauth(null)}
          onConfirmed={() => {
            const kept = reauth;
            setReauth(null);
            if (kept) run(kept.retry);
          }}
        />
      )}

      {loadError && (
        <p className="auth__error" role="alert">
          {STAFF_LOAD_ERROR}
        </p>
      )}

      {data && (
        <>
          <section className="admin-list" aria-labelledby="roles-staff">
            <h2 id="roles-staff" className="t-data">
              Equipo
            </h2>
            {data.staff.length === 0 && <p>Todavía no hay nadie con un rol.</p>}
            <ul className="admin-list__items">
              {data.staff.map((member) => (
                <StaffRow key={member.uid} member={member} own={member.uid === user.uid} busy={busy} onChange={(r, a) => run(change(member.email ?? '', r, a))} />
              ))}
            </ul>
          </section>

          <section className="admin-list" aria-labelledby="roles-add">
            <h2 id="roles-add" className="t-data">
              Agregar rol por correo
            </h2>
            {grantable.length === 0 ? (
              <p>Tu cuenta no puede dar roles.</p>
            ) : (
              <form
                className="account__form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!email.trim() || !chosenRole) return;
                  const target = email.trim();
                  run(async () => {
                    const message = await change(target, chosenRole, 'grant')();
                    setEmail('');
                    return message;
                  });
                }}
              >
                <label className="auth__field">
                  <span className="t-label">Correo de la persona</span>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" required disabled={busy} />
                </label>
                <label className="auth__field">
                  <span className="t-label">Rol</span>
                  <select value={chosenRole} onChange={(e) => setRole(e.target.value as GrantableRole)} disabled={busy}>
                    {grantable.map((key) => (
                      <option key={key} value={key}>
                        {ROLE_LABELS[key]}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="t-data">{NO_ACCOUNT_HINT}</p>
                <div className="account__form-actions">
                  <button type="submit" className="btn btn--brand" disabled={busy || !email.trim()} style={{ minHeight: 44 }}>
                    {busy ? 'Guardando…' : 'Dar rol'}
                  </button>
                </div>
              </form>
            )}
          </section>
        </>
      )}

      <section className="admin-list" aria-labelledby="roles-audit">
        <h2 id="roles-audit" className="t-data">
          Últimos cambios
        </h2>
        {audit.length === 0 && <p>Todavía no hay cambios registrados.</p>}
        <ul className="admin-list__items">
          {audit.map((row) => (
            <li key={row.id} className="admin-list__item--record">
              <div>
                <strong>
                  {row.action === 'revoke' ? roleAction.revoke : roleAction.grant} {roleName(row.role)}
                </strong>
                <span>
                  {row.actor} → {row.targetEmail}
                </span>
                <span className="t-data">
                  {row.at !== null ? formatDonationDateTime(row.at) : 'sin fecha'} · {row.outcome === 'applied' ? 'aplicado' : 'sin confirmar'}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function StaffRow({
  member,
  own,
  busy,
  onChange,
}: {
  member: StaffMember;
  own: boolean;
  busy: boolean;
  onChange(role: GrantableRole, action: 'grant' | 'revoke'): void;
}) {
  const { grant, revoke } = member.editable;
  const none = grant.length === 0 && revoke.length === 0;

  function ask(targetRole: GrantableRole) {
    const who = member.displayName ? `${member.displayName} (${member.email})` : (member.email ?? 'esta persona');
    if (window.confirm(`¿Quitar el rol ${ROLE_LABELS[targetRole]} a ${who}?`)) onChange(targetRole, 'revoke');
  }

  return (
    <li className="admin-list__item--record">
      <div>
        <strong>{member.email ?? 'sin correo'}</strong>
        {member.displayName && <span>{member.displayName}</span>}
        <span className="t-data">{joinNames(member.labels)}</span>
      </div>
      {none ? (
        <p className="t-data">{own ? 'Tu cuenta' : 'Tu rol no puede cambiar esta cuenta.'}</p>
      ) : (
        <div className="admin-list__actions">
          {revoke.map((key) => (
            <button key={`r-${key}`} type="button" className="btn btn--muted" style={{ minHeight: 44 }} disabled={busy} onClick={() => ask(key)}>
              {roleAction.revoke} {ROLE_LABELS[key]}
            </button>
          ))}
          {grant.map((key) => (
            <button key={`g-${key}`} type="button" className="btn btn--muted" style={{ minHeight: 44 }} disabled={busy} onClick={() => onChange(key, 'grant')}>
              {roleAction.grant} {ROLE_LABELS[key]}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}
