/**
 * The email link, handled: verify an address, choose a new password, undo an
 * email change, or confirm a new one.
 *
 * ── The one-time code ──────────────────────────────────────────────────────
 * It is read once, then removed from the address bar and the history entry
 * with `replaceState`, so it is not left for the next person holding a shared
 * phone, and not passed on by someone copying the URL to ask for help.
 *
 * ── React's development double effect ──────────────────────────────────────
 * StrictMode runs an effect twice in development. The second run would find
 * the code already stripped from the URL — or spend it a second time and be
 * told it is invalid. `started` keeps it to one run; refs survive the replay.
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

import { useAuth } from '@/components/AuthProvider';
import { parseAuthAction } from '@/lib/auth-action';
import { AuthFailure } from '@/lib/auth-errors';
import {
  applyEmailChange,
  applyEmailRecovery,
  applyEmailVerification,
  completePasswordReset,
  readPasswordResetLink,
  sendPasswordResetTo,
} from '@/lib/auth-links';
import { PASSWORD_MIN_LENGTH, checkNewPassword } from '@/lib/profile';
import { t } from '@/i18n';

type State =
  | { kind: 'checking' }
  | { kind: 'problem'; text: string }
  | { kind: 'verified' }
  | { kind: 'reset-form'; oobCode: string; email: string }
  | { kind: 'reset-done' }
  | { kind: 'recovered'; email: string | null }
  | { kind: 'email-changed'; email: string | null };

function problemText(caught: unknown): string {
  if (caught instanceof AuthFailure) {
    if (caught.reason === 'unknown') console.error('[account/action]', caught.cause);
    return t.authError(caught.reason);
  }
  console.error('[account/action]', caught);
  return t.authError('unknown');
}

export function ActionHandler() {
  const copy = t.account;
  const { refresh } = useAuth();
  const started = useRef(false);

  const [state, setState] = useState<State>({ kind: 'checking' });
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const parsed = parseAuthAction(window.location.search);
    window.history.replaceState(window.history.state, '', window.location.pathname);

    if (!parsed.ok) {
      setState({
        kind: 'problem',
        text: parsed.reason === 'unsupported-mode' ? copy.actionUnsupported : copy.actionMalformed,
      });
      return;
    }

    const { mode, oobCode } = parsed;
    (async () => {
      try {
        switch (mode) {
          case 'verifyEmail':
            await applyEmailVerification(oobCode);
            // A signed-in visitor in this browser sees the banner go away.
            await refresh().catch(() => {});
            setState({ kind: 'verified' });
            break;
          case 'resetPassword':
            setState({ kind: 'reset-form', oobCode, email: await readPasswordResetLink(oobCode) });
            break;
          case 'recoverEmail':
            setState({ kind: 'recovered', email: await applyEmailRecovery(oobCode) });
            break;
          case 'verifyAndChangeEmail':
            setState({ kind: 'email-changed', email: await applyEmailChange(oobCode) });
            break;
        }
      } catch (caught) {
        setState({ kind: 'problem', text: problemText(caught) });
      }
    })();
  }, [copy, refresh]);

  async function submitReset(event: React.FormEvent) {
    event.preventDefault();
    if (state.kind !== 'reset-form') return;

    const problem = checkNewPassword(password, repeat, state.email);
    if (problem) {
      setError(copy.newPasswordError(problem, PASSWORD_MIN_LENGTH));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await completePasswordReset(state.oobCode, password);
      setPassword('');
      setRepeat('');
      setState({ kind: 'reset-done' });
    } catch (caught) {
      const reason = caught instanceof AuthFailure ? caught.reason : null;
      if (reason === 'action-code-expired' || reason === 'action-code-invalid') {
        setState({ kind: 'problem', text: t.authError(reason) });
      } else {
        setError(problemText(caught));
      }
    } finally {
      setBusy(false);
    }
  }

  async function sendReset(email: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await sendPasswordResetTo(email);
      setNotice(copy.resetLinkSentTo(email));
    } catch (caught) {
      setError(problemText(caught));
    } finally {
      setBusy(false);
    }
  }

  const title = {
    checking: copy.actionTitle,
    problem: copy.linkProblemTitle,
    verified: copy.emailVerifiedTitle,
    'reset-form': copy.newPasswordTitle,
    'reset-done': copy.passwordResetTitle,
    recovered: copy.emailRecoveredTitle,
    'email-changed': copy.emailChangedTitle,
  }[state.kind];

  const messages = (
    <>
      {error && (
        <p className="auth__error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="auth__notice" role="status">
          {notice}
        </p>
      )}
    </>
  );

  return (
    <div className="auth" aria-busy={state.kind === 'checking'}>
      <h1 className="t-title">{title}</h1>

      {state.kind === 'checking' && <p className="auth__loading">{copy.actionChecking}</p>}

      {state.kind === 'problem' && (
        <>
          <p className="auth__error" role="alert">
            {state.text}
          </p>
          <div className="auth__actions">
            <Link href="/account" className="btn btn--brand">
              {copy.requestNewLink}
            </Link>
          </div>
        </>
      )}

      {state.kind === 'verified' && (
        <>
          <p className="auth__notice" role="status">
            {copy.emailVerified}
          </p>
          <div className="auth__actions">
            <Link href="/account" className="btn btn--brand">
              {copy.goToAccount}
            </Link>
          </div>
        </>
      )}

      {state.kind === 'reset-form' && (
        <form className="auth__form" onSubmit={submitReset} noValidate>
          <p className="auth__prose">{copy.newPasswordFor(state.email)}</p>
          {/* Lets a password manager file the new password under the right account. */}
          <input type="email" name="username" autoComplete="username" value={state.email} readOnly hidden />
          <label className="auth__field">
            <span className="t-label">{copy.newPassword}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              disabled={busy}
              autoFocus
            />
            <small className="auth__hint">{copy.passwordHint(PASSWORD_MIN_LENGTH)}</small>
          </label>
          <label className="auth__field">
            <span className="t-label">{copy.repeatPassword}</span>
            <input
              type="password"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              autoComplete="new-password"
              disabled={busy}
            />
          </label>
          {messages}
          <button type="submit" className="btn btn--action auth__submit" disabled={busy}>
            {busy ? copy.working : copy.saveNewPassword}
          </button>
        </form>
      )}

      {state.kind === 'reset-done' && (
        <>
          <p className="auth__notice" role="status">
            {copy.passwordResetDone}
          </p>
          <div className="auth__actions">
            <Link href="/account" className="btn btn--brand">
              {copy.goToSignIn}
            </Link>
          </div>
        </>
      )}

      {state.kind === 'recovered' && (
        <>
          <p className="auth__notice" role="status">
            {copy.emailRecovered(state.email)}
          </p>
          <p className="auth__prose">{copy.emailRecoveredAdvice}</p>
          {messages}
          <div className="auth__actions">
            {state.email && !notice && (
              <button type="button" className="btn btn--action" onClick={() => sendReset(state.email!)} disabled={busy}>
                {busy ? copy.working : copy.sendMeResetLink}
              </button>
            )}
            <Link href="/account" className="btn btn--brand">
              {copy.goToAccount}
            </Link>
          </div>
        </>
      )}

      {state.kind === 'email-changed' && (
        <>
          <p className="auth__notice" role="status">
            {copy.emailChanged(state.email)}
          </p>
          <div className="auth__actions">
            <Link href="/account" className="btn btn--brand">
              {copy.goToSignIn}
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
