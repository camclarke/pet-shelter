'use client';

import { useState } from 'react';
import type { User } from 'firebase/auth';

import { GoogleMark } from '@/components/GoogleMark';
import { AuthFailure, reauthenticate } from '@/lib/auth';
import { signInMethods } from '@/lib/profile';
import { t } from '@/i18n';

/**
 * The «Confirma que eres tú» step, for the donation routes that refuse a
 * sign-in older than five minutes. It is the same mechanism and the same words
 * as Mi cuenta (`AccountSettings`): a password field for a password account, a
 * Google window for a Google-only one, then the kept action runs again.
 *
 * ⚠️ The Google branch calls `reauthenticate()` straight from the tap, before
 * any await, or Safari blocks the window.
 */
export function ReauthPrompt({
  user,
  busy,
  onConfirmed,
  onCancel,
}: {
  user: User;
  busy: boolean;
  /** Called once the identity is confirmed; the caller retries its kept action. */
  onConfirmed(): void;
  onCancel(): void;
}) {
  const copy = t.account;
  const methods = signInMethods(user.providerData.map((p) => p.providerId));
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  function confirm(event?: React.FormEvent) {
    event?.preventDefault();
    setError(null);
    setWorking(true);
    reauthenticate(user, methods.password ? password : null)
      .then((ok) => {
        if (ok) {
          setPassword('');
          onConfirmed();
        }
      })
      .catch((caught) => {
        console.error('[donations] re-authentication failed', caught);
        setError(t.authError(caught instanceof AuthFailure ? caught.reason : 'unknown'));
      })
      .finally(() => setWorking(false));
  }

  const disabled = busy || working;

  return methods.password ? (
    <form className="account__form" onSubmit={confirm} noValidate>
      <p className="auth__notice auth__notice--warn">{copy.confirmIdentityPassword}</p>
      <label className="auth__field">
        <span className="t-label">{copy.currentPassword}</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          disabled={disabled}
        />
      </label>
      {error && (
        <p className="auth__error" role="alert">
          {error}
        </p>
      )}
      <div className="account__form-actions">
        <button type="submit" className="btn btn--brand" disabled={disabled}>
          {disabled ? copy.working : copy.confirm}
        </button>
        <button type="button" className="auth__link" onClick={onCancel} disabled={disabled}>
          {copy.cancel}
        </button>
      </div>
    </form>
  ) : (
    <div className="account__form">
      <p className="auth__notice auth__notice--warn">{copy.confirmIdentityGoogle}</p>
      {error && (
        <p className="auth__error" role="alert">
          {error}
        </p>
      )}
      <div className="account__form-actions">
        <button type="button" className="auth__google" onClick={() => confirm()} disabled={disabled}>
          <GoogleMark />
          <span>{copy.confirmWithGoogle}</span>
        </button>
        <button type="button" className="auth__link" onClick={onCancel} disabled={disabled}>
          {copy.cancel}
        </button>
      </div>
    </div>
  );
}
