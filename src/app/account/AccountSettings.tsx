/**
 * "Mi cuenta", signed in: the profile (name, photo), the ways to sign in
 * (password, Google, email), the person's adoption applications, and deleting
 * the account.
 *
 * Every decision about what is offered comes from `profile.ts`, where it is
 * tested: which photo URLs may render, which methods can be added or removed
 * (Google only while a password remains), what a new password must be. This
 * file wires those decisions to forms.
 *
 * ── One form open at a time ────────────────────────────────────────────────
 * The same reasoning as the intake wizard: on a phone, several open editors
 * push everything else off the screen. A message appears in the section whose
 * action produced it, so a failure at the bottom of the page is not reported
 * at the top where nobody is looking.
 *
 * ── "Confirma que eres tú" ─────────────────────────────────────────────────
 * Identity Platform refuses some changes without a sign-in from the last few
 * minutes (`requires-recent-login`). Instead of failing, the action is kept and
 * a confirmation appears in place: the password for a password account, a
 * Google window for a Google-only one. Confirming retries the kept action.
 *
 * ⚠️ `run()` calls its action synchronously. An action that opens a Google
 * window must reach the SDK before any await, or Safari blocks the window.
 */

'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { User } from 'firebase/auth';

import { useAuth } from '@/components/AuthProvider';
import { Avatar } from '@/components/Avatar';
import { GoogleMark } from '@/components/GoogleMark';
import {
  AccountDeleteError,
  AuthFailure,
  adoptGooglePhoto,
  changeEmail,
  changePassword,
  createPassword,
  deleteAccount,
  googleProfileOf,
  linkGoogle,
  reauthenticate,
  removeAvatar,
  resendVerification,
  saveDisplayName,
  signOut,
  unlinkGoogle,
  uploadAvatar,
} from '@/lib/auth';
import { PhotoUnreadableError } from '@/lib/image-strip';
import {
  DISPLAY_NAME_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  accountCapabilities,
  checkNewPassword,
  normalizeDisplayName,
  safeAvatarUrl,
  signInMethods,
  validateDisplayName,
} from '@/lib/profile';
import { SHELTER } from '@/config/shelter';
import { t } from '@/i18n';
import { MyApplications } from './MyApplications';

export type SettingsPanel = 'name' | 'password' | 'create-password' | 'email' | 'delete';
type Section = 'top' | 'profile' | 'methods' | 'delete';
type Status = { at: Section; kind: 'error' | 'notice'; text: string };
type Action = () => Promise<string | null>;

interface AccountSettingsProps {
  user: User;
  returnTo: string | null;
  /** After signing out or deleting the account, with a message for the signed-out screen. */
  onSignedOut(message: string | null): void;
  /** Which form starts open. Only for rendering a state to measure it; the page starts closed. */
  initialPanel?: SettingsPanel | null;
}

export function AccountSettings({ user, returnTo, onSignedOut, initialPanel = null }: AccountSettingsProps) {
  const { isAdmin, refresh } = useAuth();
  const copy = t.account;

  const [panel, setPanel] = useState<SettingsPanel | null>(initialPanel);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [reauth, setReauth] = useState<{ at: Section; retry: Action } | null>(null);
  const [reauthPassword, setReauthPassword] = useState('');

  const [nameDraft, setNameDraft] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [repeatPassword, setRepeatPassword] = useState('');
  const [newEmail, setNewEmail] = useState('');

  const methods = signInMethods(user.providerData.map((p) => p.providerId));
  const can = accountCapabilities(methods, Boolean(user.email));
  const google = googleProfileOf(user);
  const displayName = normalizeDisplayName(user.displayName);
  const photo = safeAvatarUrl(user.photoURL, user.uid);

  function clearFields() {
    setCurrentPassword('');
    setNewPassword('');
    setRepeatPassword('');
    setNewEmail('');
  }

  function open(next: SettingsPanel | null) {
    setPanel(next);
    setStatus(null);
    setReauth(null);
    setReauthPassword('');
    clearFields();
    if (next === 'name') setNameDraft(displayName);
  }

  function closeForms() {
    setPanel(null);
    clearFields();
  }

  function say(at: Section, kind: Status['kind'], text: string) {
    setStatus({ at, kind, text });
  }

  function failureText(caught: unknown): string {
    if (caught instanceof AuthFailure) {
      if (caught.reason === 'unknown') console.error('[account]', caught.cause);
      return t.authError(caught.reason);
    }
    if (caught instanceof AccountDeleteError) {
      if (caught.reason === 'unexpected') console.error('[account] delete', caught.cause);
      return copy.deleteError(caught.reason);
    }
    if (caught instanceof PhotoUnreadableError) return copy.photoUnreadable;
    console.error('[account]', caught);
    return t.authError('unknown');
  }

  function run(at: Section, action: Action) {
    setBusy(true);
    setStatus(null);

    let pending: Promise<string | null>;
    try {
      pending = action(); // synchronously — see the popup note at the top
    } catch (caught) {
      pending = Promise.reject(caught);
    }

    pending
      .then(async (message) => {
        if (message) say(at, 'notice', message);
        await refresh();
      })
      .catch((caught) => {
        if (caught instanceof AuthFailure && caught.reason === 'requires-recent-login') {
          setReauth({ at, retry: action });
          return;
        }
        say(at, 'error', failureText(caught));
      })
      .finally(() => setBusy(false));
  }

  function confirmIdentity(event?: React.FormEvent) {
    event?.preventDefault();
    const kept = reauth;
    if (!kept) return;
    const password = methods.password ? reauthPassword : null;
    run(kept.at, async () => {
      if (!(await reauthenticate(user, password))) return null;
      setReauth(null);
      setReauthPassword('');
      return kept.retry();
    });
  }

  // ── actions ───────────────────────────────────────────────────────────────

  function submitName(event: React.FormEvent) {
    event.preventDefault();
    const problem = validateDisplayName(nameDraft);
    if (problem) return say('profile', 'error', copy.profileError(problem, DISPLAY_NAME_MAX_LENGTH));
    run('profile', async () => {
      await saveDisplayName(user, nameDraft);
      closeForms();
      return copy.nameSaved;
    });
  }

  function pickPhoto(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Cleared so choosing the same file again still fires a change.
    event.target.value = '';
    if (!file) return;
    run('profile', async () => {
      await uploadAvatar(user, file);
      return copy.photoSaved;
    });
  }

  function submitPassword(event: React.FormEvent) {
    event.preventDefault();
    if (!currentPassword) return say('methods', 'error', t.authError('missing-password'));
    const problem = checkNewPassword(newPassword, repeatPassword, user.email);
    if (problem) return say('methods', 'error', copy.newPasswordError(problem, PASSWORD_MIN_LENGTH));
    run('methods', async () => {
      await changePassword(user, currentPassword, newPassword);
      closeForms();
      return copy.passwordChanged;
    });
  }

  function submitCreatePassword(event: React.FormEvent) {
    event.preventDefault();
    const problem = checkNewPassword(newPassword, repeatPassword, user.email);
    if (problem) return say('methods', 'error', copy.newPasswordError(problem, PASSWORD_MIN_LENGTH));
    const chosen = newPassword;
    run('methods', async () => {
      await createPassword(user, chosen);
      closeForms();
      return copy.passwordCreated;
    });
  }

  function submitEmail(event: React.FormEvent) {
    event.preventDefault();
    const next = newEmail.trim();
    if (!next) return say('methods', 'error', t.authError('invalid-email'));
    if (next.toLowerCase() === (user.email ?? '').toLowerCase()) return say('methods', 'error', copy.sameEmail);
    if (!currentPassword) return say('methods', 'error', t.authError('missing-password'));
    run('methods', async () => {
      await changeEmail(user, currentPassword, next);
      closeForms();
      return copy.emailChangeSent(next);
    });
  }

  const [deletePassword, setDeletePassword] = useState('');

  function submitDelete(event: React.FormEvent) {
    event.preventDefault();
    if (methods.password && !deletePassword) return say('delete', 'error', t.authError('missing-password'));
    run('delete', async () => {
      const result = await deleteAccount(user, methods.password ? deletePassword : null);
      if (result === 'deleted') onSignedOut(copy.deleted);
      return null;
    });
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  const statusAt = (at: Section) =>
    status?.at === at ? (
      <p className={status.kind === 'error' ? 'auth__error' : 'auth__notice'} role={status.kind === 'error' ? 'alert' : 'status'}>
        {status.text}
      </p>
    ) : null;

  const reauthAt = (at: Section) => {
    if (reauth?.at !== at) return null;
    return methods.password ? (
      <form className="account__form" onSubmit={confirmIdentity} noValidate>
        <p className="auth__notice auth__notice--warn">{copy.confirmIdentityPassword}</p>
        <PasswordField
          label={copy.currentPassword}
          value={reauthPassword}
          onChange={setReauthPassword}
          autoComplete="current-password"
          disabled={busy}
        />
        <FormActions busy={busy} submit={copy.confirm} onCancel={() => setReauth(null)} cancel={copy.cancel} />
      </form>
    ) : (
      <div className="account__form">
        <p className="auth__notice auth__notice--warn">{copy.confirmIdentityGoogle}</p>
        <div className="account__form-actions">
          <button type="button" className="auth__google" onClick={() => confirmIdentity()} disabled={busy}>
            <GoogleMark />
            <span>{copy.confirmWithGoogle}</span>
          </button>
          <button type="button" className="auth__link" onClick={() => setReauth(null)} disabled={busy}>
            {copy.cancel}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="auth account">
      <div className="account__head">
        <Avatar uid={user.uid} url={user.photoURL} label={displayName || user.email} size={64} />
        <div className="account__head-text">
          <h1 className="t-title">{copy.title}</h1>
          {displayName && <p className="account__name">{displayName}</p>}
          <p className="account__email">{user.email}</p>
        </div>
      </div>

      {returnTo && (
        <p className="account-return">
          <Link href={returnTo} className="btn btn--brand">
            {t.applications.continueApplication}
          </Link>
        </p>
      )}

      {!user.emailVerified && user.email && (
        <div className="auth__notice auth__notice--warn" role="status">
          <p>{copy.unverified}</p>
          <button
            type="button"
            className="auth__link"
            disabled={busy}
            onClick={() =>
              run('top', async () => {
                await resendVerification(user);
                return copy.verificationResent;
              })
            }
          >
            {copy.resendVerification}
          </button>
          {' · '}
          <button
            type="button"
            className="auth__link"
            disabled={busy}
            onClick={() =>
              run('top', async () => {
                await refresh();
                return user.emailVerified ? null : copy.stillUnverified;
              })
            }
          >
            {copy.alreadyVerified}
          </button>
        </div>
      )}
      {statusAt('top')}

      <p className="auth__prose">{copy.comingSoon}</p>

      {/* ── profile ─────────────────────────────────────────────────────── */}
      <section className="account__section" aria-labelledby="account-profile">
        <h2 id="account-profile" className="account__heading">
          {copy.profileTitle}
        </h2>

        {panel === 'name' ? (
          <form className="account__form" onSubmit={submitName} noValidate>
            <label className="auth__field">
              <span className="t-label">{copy.nameLabel}</span>
              <input
                type="text"
                name="name"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                autoComplete="name"
                autoCapitalize="words"
                disabled={busy}
                autoFocus
              />
            </label>
            <FormActions busy={busy} submit={copy.save} onCancel={() => open(null)} cancel={copy.cancel} />
          </form>
        ) : (
          <div className="account__row">
            <div className="account__row-main">
              <span className="t-label">{copy.nameRowLabel}</span>
              <span className="account__value">{displayName || copy.noName}</span>
            </div>
            <div className="account__row-actions">
              <button type="button" className="auth__link" onClick={() => open('name')} disabled={busy}>
                {displayName ? copy.change : copy.add}
              </button>
            </div>
          </div>
        )}

        <div className="account__row">
          <div className="account__row-main">
            <span className="t-label">{copy.photoRowLabel}</span>
            <small className="auth__hint">{copy.photoPrivacy}</small>
          </div>
          <div className="account__row-actions">
            {/* A label around a visually-hidden input, never a `hidden` input
                opened with .click(): Chrome 130+ drops the change event of the
                second pattern (the 2026-09-02 intake bug, PR #25). */}
            <label className={`auth__link account__file${busy ? ' is-disabled' : ''}`}>
              <input type="file" accept="image/*" className="account__file-input" onChange={pickPhoto} disabled={busy} />
              {photo ? copy.changePhoto : copy.uploadPhoto}
            </label>
            {google?.photoURL && google.photoURL !== photo && (
              <button
                type="button"
                className="auth__link"
                disabled={busy}
                onClick={() =>
                  run('profile', async () => {
                    await adoptGooglePhoto(user);
                    return copy.photoSaved;
                  })
                }
              >
                {copy.useGooglePhoto}
              </button>
            )}
            {photo && (
              <button
                type="button"
                className="auth__link"
                disabled={busy}
                onClick={() =>
                  run('profile', async () => {
                    await removeAvatar(user);
                    return copy.photoRemoved;
                  })
                }
              >
                {copy.removePhoto}
              </button>
            )}
          </div>
        </div>

        {reauthAt('profile')}
        {statusAt('profile')}
      </section>

      {/* ── ways to sign in ─────────────────────────────────────────────── */}
      <section className="account__section" aria-labelledby="account-methods">
        <h2 id="account-methods" className="account__heading">
          {copy.methodsTitle}
        </h2>

        <div className="account__row">
          <div className="account__row-main">
            <span className="t-label account__label-icon">
              <GoogleMark size={14} />
              {copy.googleRowLabel}
            </span>
            <span className="account__value">
              {methods.google ? copy.googleConnected(google?.email ?? null) : copy.googleNotConnected}
            </span>
            {methods.google && !methods.password && <small className="auth__hint">{copy.disconnectNeedsPassword}</small>}
          </div>
          <div className="account__row-actions">
            {can.linkGoogle && (
              <button
                type="button"
                className="auth__link"
                disabled={busy}
                onClick={() =>
                  run('methods', async () => ((await linkGoogle(user)) ? copy.googleConnectedNotice : null))
                }
              >
                {copy.connectGoogle}
              </button>
            )}
            {can.unlinkGoogle && (
              <button
                type="button"
                className="auth__link"
                disabled={busy}
                onClick={() =>
                  run('methods', async () => {
                    await unlinkGoogle(user);
                    return copy.googleDisconnectedNotice;
                  })
                }
              >
                {copy.disconnectGoogle}
              </button>
            )}
          </div>
        </div>

        {panel === 'password' ? (
          <form className="account__form" onSubmit={submitPassword} noValidate>
            {/* Lets a password manager file the new password under this account. */}
            <input type="email" name="username" autoComplete="username" value={user.email ?? ''} readOnly hidden />
            <PasswordField label={copy.currentPassword} value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" disabled={busy} />
            <PasswordField
              label={copy.newPassword}
              value={newPassword}
              onChange={setNewPassword}
              autoComplete="new-password"
              hint={copy.passwordHint(PASSWORD_MIN_LENGTH)}
              disabled={busy}
            />
            <PasswordField label={copy.repeatPassword} value={repeatPassword} onChange={setRepeatPassword} autoComplete="new-password" disabled={busy} />
            <FormActions busy={busy} submit={copy.save} onCancel={() => open(null)} cancel={copy.cancel} />
          </form>
        ) : panel === 'create-password' ? (
          <form className="account__form" onSubmit={submitCreatePassword} noValidate>
            <input type="email" name="username" autoComplete="username" value={user.email ?? ''} readOnly hidden />
            <PasswordField
              label={copy.newPassword}
              value={newPassword}
              onChange={setNewPassword}
              autoComplete="new-password"
              hint={copy.passwordHint(PASSWORD_MIN_LENGTH)}
              disabled={busy}
            />
            <PasswordField label={copy.repeatPassword} value={repeatPassword} onChange={setRepeatPassword} autoComplete="new-password" disabled={busy} />
            <FormActions busy={busy} submit={copy.save} onCancel={() => open(null)} cancel={copy.cancel} />
          </form>
        ) : (
          <div className="account__row">
            <div className="account__row-main">
              <span className="t-label">{copy.passwordRowLabel}</span>
              <span className="account__value">{methods.password ? copy.passwordIsSet : copy.passwordNotSet}</span>
            </div>
            <div className="account__row-actions">
              {can.changePassword && (
                <button type="button" className="auth__link" onClick={() => open('password')} disabled={busy}>
                  {copy.changePassword}
                </button>
              )}
              {can.setPassword && (
                <button type="button" className="auth__link" onClick={() => open('create-password')} disabled={busy}>
                  {copy.createPassword}
                </button>
              )}
            </div>
          </div>
        )}

        {panel === 'email' ? (
          <form className="account__form" onSubmit={submitEmail} noValidate>
            <label className="auth__field">
              <span className="t-label">{copy.newEmail}</span>
              <input
                type="email"
                name="new-email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                autoComplete="email"
                disabled={busy}
              />
            </label>
            <PasswordField label={copy.currentPassword} value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" disabled={busy} />
            <FormActions busy={busy} submit={copy.save} onCancel={() => open(null)} cancel={copy.cancel} />
          </form>
        ) : (
          <div className="account__row">
            <div className="account__row-main">
              <span className="t-label">{copy.emailRowLabel}</span>
              <span className="account__value account__value--wrap">{user.email}</span>
              {!can.changeEmail && methods.google && <small className="auth__hint">{copy.emailFromGoogle}</small>}
            </div>
            <div className="account__row-actions">
              {can.changeEmail && (
                <button type="button" className="auth__link" onClick={() => open('email')} disabled={busy}>
                  {copy.changeEmail}
                </button>
              )}
            </div>
          </div>
        )}

        {reauthAt('methods')}
        {statusAt('methods')}
      </section>

      {/* Renders nothing for someone who has never applied online. */}
      <MyApplications user={user} />

      <div className="auth__actions">
        {/* Only shown to admins, and only as a shortcut — /admin gates itself,
            and firestore.rules gates everything behind it. Hiding the link is
            tidiness, not access control. `isAdmin` comes from the cached ID
            token here, so a just-promoted admin may not see it until the
            token rotates; navigating to /admin directly still works, because
            AdminGate forces a refresh on mount. */}
        {isAdmin && (
          <Link href="/admin" className="btn btn--action">
            {copy.adminPanel}
          </Link>
        )}
        <Link href="/adopt" className="btn btn--brand">
          {copy.seeWall}
        </Link>
        <button
          type="button"
          className="btn btn--muted"
          disabled={busy}
          onClick={() =>
            run('top', async () => {
              await signOut();
              onSignedOut(null);
              return null;
            })
          }
        >
          {copy.signOut}
        </button>
      </div>

      {/* ── deleting the account ────────────────────────────────────────── */}
      <section className="account__section account__danger" aria-labelledby="account-delete">
        <h2 id="account-delete" className="account__heading">
          {copy.deleteTitle}
        </h2>

        {isAdmin ? (
          <p className="auth__prose">{copy.adminCannotDelete}</p>
        ) : panel === 'delete' ? (
          <form className="account__form" onSubmit={submitDelete} noValidate>
            <p className="auth__prose">{copy.deleteIntro}</p>
            {methods.password ? (
              <>
                <p className="auth__notice auth__notice--warn">{copy.deleteConfirmPassword}</p>
                <PasswordField label={copy.currentPassword} value={deletePassword} onChange={setDeletePassword} autoComplete="current-password" disabled={busy} />
              </>
            ) : (
              <p className="auth__notice auth__notice--warn">{copy.deleteConfirmGoogle}</p>
            )}
            <div className="account__form-actions">
              {methods.password ? (
                <button type="submit" className="btn btn--muted account__delete" disabled={busy}>
                  {busy ? copy.working : copy.deleteSubmit}
                </button>
              ) : (
                <button type="submit" className="auth__google" disabled={busy}>
                  <GoogleMark />
                  <span>{copy.confirmWithGoogle}</span>
                </button>
              )}
              <button type="button" className="auth__link" onClick={() => open(null)} disabled={busy}>
                {copy.cancel}
              </button>
            </div>
          </form>
        ) : (
          <>
            <p className="auth__prose">{copy.deleteIntro}</p>
            <button type="button" className="auth__link account__delete-start" onClick={() => open('delete')} disabled={busy}>
              {copy.deleteStart}
            </button>
          </>
        )}

        {statusAt('delete')}
      </section>

      <p className="auth__help">
        {copy.helpPrefix} <a href={`https://wa.me/${SHELTER.whatsapp}`}>WhatsApp {SHELTER.whatsappDisplay}</a>.
      </p>
    </div>
  );
}

function PasswordField(props: {
  label: string;
  value: string;
  onChange(value: string): void;
  autoComplete: 'current-password' | 'new-password';
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className="auth__field">
      <span className="t-label">{props.label}</span>
      <input
        type="password"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        autoComplete={props.autoComplete}
        disabled={props.disabled}
      />
      {props.hint && <small className="auth__hint">{props.hint}</small>}
    </label>
  );
}

function FormActions(props: { busy: boolean; submit: string; cancel: string; onCancel(): void }) {
  return (
    <div className="account__form-actions">
      <button type="submit" className="btn btn--brand" disabled={props.busy}>
        {props.busy ? t.account.working : props.submit}
      </button>
      <button type="button" className="auth__link" onClick={props.onCancel} disabled={props.busy}>
        {props.cancel}
      </button>
    </div>
  );
}
