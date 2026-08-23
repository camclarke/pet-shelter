/**
 * The account panel — sign in, create an account, recover a password, sign out.
 *
 * All visitor-facing wording here is inline, matching every other page in
 * `src/app`. The one thing that is NOT inline is the failure message: those
 * arrive as an `AuthError` from `src/lib/auth.ts` and are rendered through
 * `t.authError()`, because a lib module must never carry Spanish.
 */

'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';
import {
  AuthFailure,
  requestPasswordReset,
  resendVerification,
  signIn,
  signOut,
  signUp,
} from '@/lib/auth';
import { SHELTER } from '@/config/shelter';
import { t } from '@/i18n';

type Mode = 'signin' | 'signup' | 'reset';

const HEADING: Record<Mode, string> = {
  signin: 'Iniciar sesión',
  signup: 'Crear una cuenta',
  reset: 'Recuperar contraseña',
};

const SUBMIT: Record<Mode, string> = {
  signin: 'Entrar',
  signup: 'Crear cuenta',
  reset: 'Enviar enlace',
};

const INTRO: Record<Mode, string> = {
  signin: 'Entra para ver la historia completa de cada animalito.',
  signup:
    'Con una cuenta puedes ver la historia completa de cada animalito, sus fotos, su historial médico y su plan de alimentación.',
  reset: 'Escribe tu correo y te enviamos un enlace para crear una contraseña nueva.',
};

export function AccountPanel() {
  const { user, loading, isAdmin, refresh } = useAuth();

  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function switchTo(next: Mode) {
    setMode(next);
    setError(null);
    setNotice(null);
    setPassword('');
  }

  /** Every failure path funnels here, so no branch can forget to translate. */
  function report(caught: unknown) {
    if (caught instanceof AuthFailure) {
      setError(t.authError(caught.reason));
      if (caught.reason === 'unknown') console.error('[account]', caught.cause);
      return;
    }
    console.error('[account]', caught);
    setError(t.authError('unknown'));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);

    try {
      if (mode === 'signin') {
        await signIn(email.trim(), password);
      } else if (mode === 'signup') {
        await signUp(email.trim(), password);
      } else {
        await requestPasswordReset(email.trim());
        // Phrased as a condition, not a confirmation — see the enumeration
        // note in src/lib/auth.ts. We are not told whether the account exists,
        // so we must not imply that we are.
        setNotice(
          'Si existe una cuenta con ese correo, te llegará un enlace para cambiar la contraseña. Revisa también la carpeta de spam.',
        );
      }
    } catch (caught) {
      report(caught);
    } finally {
      setBusy(false);
    }
  }

  async function handleSignOut() {
    setBusy(true);
    try {
      await signOut();
      setEmail('');
      setPassword('');
      setNotice(null);
      setError(null);
      setMode('signin');
    } catch (caught) {
      report(caught);
    } finally {
      setBusy(false);
    }
  }

  async function handleResend() {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      await resendVerification(user);
      setNotice('Te reenviamos el correo de verificación.');
    } catch (caught) {
      report(caught);
    } finally {
      setBusy(false);
    }
  }

  // The provider loads Firebase after hydration, so this state is real and
  // brief. Rendering the signed-out form during it would flash a login screen
  // at someone who is already signed in, on every navigation.
  if (loading) {
    return (
      <div className="auth" aria-busy="true">
        <p className="auth__loading">Cargando…</p>
      </div>
    );
  }

  if (user) {
    return (
      <div className="auth">
        <h1 className="t-title">Mi cuenta</h1>
        <p className="auth__identity">
          Sesión iniciada como <strong>{user.email}</strong>
        </p>

        {!user.emailVerified && (
          <div className="auth__notice auth__notice--warn" role="status">
            <p>Todavía no verificas tu correo. Te enviamos un enlace cuando creaste la cuenta.</p>
            <button type="button" className="auth__link" onClick={handleResend} disabled={busy}>
              Reenviar el correo
            </button>
            {' · '}
            <button type="button" className="auth__link" onClick={refresh} disabled={busy}>
              Ya lo verifiqué
            </button>
          </div>
        )}

        {notice && (
          <p className="auth__notice" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="auth__error" role="alert">
            {error}
          </p>
        )}

        <p className="auth__prose">
          Estamos preparando tu sección: las historias completas, el historial médico y los planes
          de alimentación de cada animalito llegarán aquí.
        </p>

        <div className="auth__actions">
          {/* Only shown to admins, and only as a shortcut — /admin gates itself,
              and firestore.rules gates everything behind it. Hiding the link is
              tidiness, not access control. `isAdmin` comes from the cached ID
              token here, so a just-promoted admin may not see it until the
              token rotates; navigating to /admin directly still works, because
              AdminGate forces a refresh on mount. */}
          {isAdmin && (
            <Link href="/admin" className="btn btn--action">
              Panel del refugio
            </Link>
          )}
          <Link href="/adopt" className="btn btn--brand">
            Ver el muro
          </Link>
          <button type="button" className="btn btn--muted" onClick={handleSignOut} disabled={busy}>
            Cerrar sesión
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth">
      <h1 className="t-title">{HEADING[mode]}</h1>
      <p className="auth__prose">{INTRO[mode]}</p>

      <form className="auth__form" onSubmit={handleSubmit} noValidate>
        <label className="auth__field">
          <span className="t-label">Correo</span>
          <input
            type="email"
            name="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
            disabled={busy}
          />
        </label>

        {mode !== 'reset' && (
          <label className="auth__field">
            <span className="t-label">Contraseña</span>
            <input
              type="password"
              name="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              minLength={6}
              required
              disabled={busy}
            />
            {mode === 'signup' && <small className="auth__hint">Mínimo 6 caracteres.</small>}
          </label>
        )}

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

        <button type="submit" className="btn btn--action auth__submit" disabled={busy}>
          {busy ? 'Un momento…' : SUBMIT[mode]}
        </button>
      </form>

      <div className="auth__switch">
        {mode === 'signin' ? (
          <>
            <button type="button" className="auth__link" onClick={() => switchTo('signup')}>
              Crear una cuenta
            </button>
            {' · '}
            <button type="button" className="auth__link" onClick={() => switchTo('reset')}>
              Olvidé mi contraseña
            </button>
          </>
        ) : (
          <button type="button" className="auth__link" onClick={() => switchTo('signin')}>
            ← Volver a iniciar sesión
          </button>
        )}
      </div>

      <p className="auth__help">
        ¿Problemas para entrar? Escríbenos por{' '}
        <a href={`https://wa.me/${SHELTER.whatsapp}`}>WhatsApp {SHELTER.whatsappDisplay}</a>.
      </p>
    </div>
  );
}
