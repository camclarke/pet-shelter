/**
 * The account page. Signed out: sign in (email and password, or Google),
 * create an account, recover a password. Signed in: `AccountSettings`.
 *
 * Every word comes from `t.account`; failures arrive as an `AuthError` from
 * `src/lib/auth.ts` and are worded by `t.authError()`.
 *
 * ── Returning to an adoption application ──────────────────────────────────
 * `/adopt/{slug}/apply` sends a signed-out visitor here with `?next=…`. After a
 * SUCCESSFUL sign-in or sign-up they are sent back; after a failure nothing
 * changes, so the enumeration protections hold exactly as before — the
 * redirect only ever follows an outcome the visitor already knows. `next` goes
 * through `safeReturnPath`, an allowlist, so this cannot become an open
 * redirect to a look-alike page.
 *
 * ── The Google button ──────────────────────────────────────────────────────
 * `signInWithGoogle()` is called synchronously from the click, before any
 * await, because Safari blocks a popup opened later. Inside Facebook's or
 * Instagram's built-in browser — where most of this site's visitors arrive —
 * Google refuses to sign anyone in, so the button is replaced with a sentence
 * saying so, and the email form below keeps working.
 */

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { GoogleMark } from '@/components/GoogleMark';
import { AuthFailure, prepareBotProtection, requestPasswordReset, signIn, signInWithGoogle, signUp } from '@/lib/auth';
import {
  DISPLAY_NAME_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  isEmbeddedBrowser,
  validateDisplayName,
} from '@/lib/profile';
import { safeReturnPath } from '@/lib/return-path';
import { SHELTER } from '@/config/shelter';
import { t } from '@/i18n';
import { AccountSettings } from './AccountSettings';

type Mode = 'signin' | 'signup' | 'reset';

/** Where a message belongs: next to the Google button, or next to the form's submit. */
type Status = { at: 'google' | 'form'; kind: 'error' | 'notice'; text: string };

export function AccountPanel() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const copy = t.account;

  const [mode, setMode] = useState<Mode>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Where to go after signing in, when a form sent the visitor here. Read from
   * `window.location` in an effect rather than `useSearchParams`, which would
   * force this statically-rendered page into a client-side bailout.
   */
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const [embedded, setEmbedded] = useState(false);
  const [googleAnyway, setGoogleAnyway] = useState(false);

  useEffect(() => {
    setReturnTo(safeReturnPath(new URLSearchParams(window.location.search).get('next')));
    setEmbedded(isEmbeddedBrowser(navigator.userAgent));
  }, []);

  // Only on the signed-out screen: no other page loads the reCAPTCHA script.
  useEffect(() => {
    if (!loading && !user) prepareBotProtection();
  }, [loading, user]);

  function switchTo(next: Mode) {
    setMode(next);
    setStatus(null);
    setPassword('');
  }

  /** Every failure path funnels here, so no branch can forget to translate. */
  function report(at: Status['at'], caught: unknown) {
    if (caught instanceof AuthFailure) {
      setStatus({ at, kind: 'error', text: t.authError(caught.reason) });
      if (caught.reason === 'unknown') console.error('[account]', caught.cause);
      return;
    }
    console.error('[account]', caught);
    setStatus({ at, kind: 'error', text: t.authError('unknown') });
  }

  function handleGoogle() {
    setStatus(null);
    setBusy(true);
    // No await before this call — see the popup note at the top.
    signInWithGoogle()
      .then((signedIn) => {
        if (signedIn && returnTo) router.replace(returnTo);
      })
      .catch((caught) => report('google', caught))
      .finally(() => setBusy(false));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setStatus(null);

    if (mode === 'signup') {
      const nameProblem = validateDisplayName(name);
      if (nameProblem) {
        setStatus({ at: 'form', kind: 'error', text: copy.profileError(nameProblem, DISPLAY_NAME_MAX_LENGTH) });
        return;
      }
      if (password.length < PASSWORD_MIN_LENGTH) {
        setStatus({
          at: 'form',
          kind: 'error',
          text: copy.newPasswordError('password-too-short', PASSWORD_MIN_LENGTH),
        });
        return;
      }
    }

    setBusy(true);
    try {
      if (mode === 'signin') {
        await signIn(email.trim(), password);
        if (returnTo) router.replace(returnTo);
      } else if (mode === 'signup') {
        await signUp(email.trim(), password, name);
        if (returnTo) router.replace(returnTo);
      } else {
        await requestPasswordReset(email.trim());
        setStatus({ at: 'form', kind: 'notice', text: copy.resetSent });
      }
    } catch (caught) {
      report('form', caught);
    } finally {
      setBusy(false);
    }
  }

  function handleSignedOut(message: string | null) {
    setName('');
    setEmail('');
    setPassword('');
    setMode('signin');
    setStatus(message ? { at: 'form', kind: 'notice', text: message } : null);
  }

  // The provider loads Firebase after hydration, so this state is real and
  // brief. Rendering the signed-out form during it would flash a login screen
  // at someone who is already signed in, on every navigation.
  if (loading) {
    return (
      <div className="auth" aria-busy="true">
        <p className="auth__loading">{copy.loading}</p>
      </div>
    );
  }

  if (user) {
    return <AccountSettings user={user} returnTo={returnTo} onSignedOut={handleSignedOut} />;
  }

  const heading = { signin: copy.signInTitle, signup: copy.signUpTitle, reset: copy.resetTitle }[mode];
  const intro = { signin: copy.signInIntro, signup: copy.signUpIntro, reset: copy.resetIntro }[mode];
  const submit = { signin: copy.signInSubmit, signup: copy.signUpSubmit, reset: copy.resetSubmit }[mode];

  const statusAt = (at: Status['at']) =>
    status?.at === at ? (
      <p className={status.kind === 'error' ? 'auth__error' : 'auth__notice'} role={status.kind === 'error' ? 'alert' : 'status'}>
        {status.text}
      </p>
    ) : null;

  const notice = copy.recaptchaNotice;

  return (
    <div className="auth">
      <h1 className="t-title">{heading}</h1>
      <p className="auth__prose">{intro}</p>
      {returnTo && mode !== 'reset' && (
        <p className="auth__notice" role="status">
          {t.applications.returnNotice}
        </p>
      )}

      {mode !== 'reset' && (
        <div className="auth__providers">
          {embedded && !googleAnyway ? (
            <div className="auth__notice auth__notice--warn" role="note">
              <p>{copy.embeddedBrowser}</p>
              <button type="button" className="auth__link" onClick={() => setGoogleAnyway(true)}>
                {copy.embeddedBrowserTryAnyway}
              </button>
            </div>
          ) : (
            <button type="button" className="auth__google" onClick={handleGoogle} disabled={busy}>
              <GoogleMark />
              <span>{copy.continueWithGoogle}</span>
            </button>
          )}
          {statusAt('google')}
          <p className="auth__divider">
            <span>{copy.orWithEmail}</span>
          </p>
        </div>
      )}

      <form className="auth__form" onSubmit={handleSubmit} noValidate>
        {mode === 'signup' && (
          <label className="auth__field">
            <span className="t-label">{copy.nameLabel}</span>
            <input
              type="text"
              name="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              autoCapitalize="words"
              required
              disabled={busy}
            />
            <small className="auth__hint">{copy.nameHint}</small>
          </label>
        )}

        <label className="auth__field">
          <span className="t-label">{copy.emailLabel}</span>
          <input
            type="email"
            name="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete={mode === 'signup' ? 'email' : 'username'}
            required
            disabled={busy}
          />
        </label>

        {mode !== 'reset' && (
          <label className="auth__field">
            <span className="t-label">{copy.passwordLabel}</span>
            <input
              type="password"
              name="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              // Only on sign-up: an account created before the 8-character
              // minimum may still have a 6-character password, and signing in
              // with it must keep working.
              minLength={mode === 'signup' ? PASSWORD_MIN_LENGTH : undefined}
              required
              disabled={busy}
            />
            {mode === 'signup' && <small className="auth__hint">{copy.passwordHint(PASSWORD_MIN_LENGTH)}</small>}
          </label>
        )}

        {statusAt('form')}

        <button type="submit" className="btn btn--action auth__submit" disabled={busy}>
          {busy ? copy.working : submit}
        </button>
      </form>

      <div className="auth__switch">
        {mode === 'signin' ? (
          <>
            <button type="button" className="auth__link" onClick={() => switchTo('signup')}>
              {copy.createAccountLink}
            </button>
            {' · '}
            <button type="button" className="auth__link" onClick={() => switchTo('reset')}>
              {copy.forgotPasswordLink}
            </button>
          </>
        ) : (
          <button type="button" className="auth__link" onClick={() => switchTo('signin')}>
            {copy.backToSignIn}
          </button>
        )}
      </div>

      {/* Google's terms allow hiding the floating reCAPTCHA badge — which on a
          phone covers the bottom-right of the form — only if this attribution
          is shown instead, on the page where reCAPTCHA runs. */}
      <p className="auth__recaptcha">
        {notice.before}
        <a href="https://policies.google.com/privacy?hl=es" target="_blank" rel="noopener noreferrer">
          {notice.privacy}
        </a>
        {notice.between}
        <a href="https://policies.google.com/terms?hl=es" target="_blank" rel="noopener noreferrer">
          {notice.terms}
        </a>
        {notice.after}
      </p>

      <p className="auth__help">
        {copy.helpPrefix} <a href={`https://wa.me/${SHELTER.whatsapp}`}>WhatsApp {SHELTER.whatsappDisplay}</a>.
      </p>
    </div>
  );
}
