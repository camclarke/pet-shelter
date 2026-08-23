/**
 * Email/password authentication — Client Components only.
 *
 * ── Why a typed error union instead of Firebase's codes ────────────────────
 * `FirebaseError.code` is an English string like `auth/invalid-credential`.
 * Rendering it would put English in front of a Spanish-speaking visitor, and
 * mapping it to Spanish inside a component would put translated text outside
 * `src/i18n`. So this module narrows Firebase's codes to an `AuthError` union
 * and the locale decides the words — the same split `MicrochipError` and
 * `microchipError()` already use.
 *
 * ── The enumeration-protection trap ────────────────────────────────────────
 * This project runs Identity Platform (not legacy Firebase Auth), where email
 * enumeration protection is ON by default. It deliberately collapses
 * `auth/user-not-found` and `auth/wrong-password` into a single
 * `auth/invalid-credential`, so the server cannot be used to discover which
 * addresses have accounts. That is a feature, and it constrains the UI: we
 * must never say "no existe esa cuenta" or "contraseña incorrecta", because
 * we genuinely do not know which one it was. `invalid-credentials` says
 * neither, on purpose.
 *
 * For the same reason `sendPasswordResetEmail` resolves successfully for an
 * address with no account. Its success message must therefore be phrased as
 * "if an account exists", not "we sent it" — see the `es` catalogue.
 */

'use client';

import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { getFirebase } from './firebase-client';

export type AuthError =
  | 'invalid-email'
  | 'missing-password'
  /** Wrong password OR no such account. We are not told which — see above. */
  | 'invalid-credentials'
  | 'email-in-use'
  | 'weak-password'
  | 'user-disabled'
  | 'too-many-requests'
  | 'network'
  /** The Email/Password provider is switched off in the Firebase console. */
  | 'provider-disabled'
  | 'unknown';

/**
 * Thrown by every operation below, so a caller never has to know a Firebase
 * code exists. `cause` keeps the original for the console — diagnosing a
 * `unknown` without it means guessing.
 */
export class AuthFailure extends Error {
  readonly reason: AuthError;

  constructor(reason: AuthError, cause?: unknown) {
    super(reason);
    this.name = 'AuthFailure';
    this.reason = reason;
    this.cause = cause;
  }
}

const CODE_TO_REASON: Record<string, AuthError> = {
  'auth/invalid-email': 'invalid-email',
  'auth/missing-email': 'invalid-email',
  'auth/missing-password': 'missing-password',
  'auth/invalid-credential': 'invalid-credentials',
  'auth/wrong-password': 'invalid-credentials',
  'auth/user-not-found': 'invalid-credentials',
  'auth/invalid-login-credentials': 'invalid-credentials',
  'auth/email-already-in-use': 'email-in-use',
  'auth/weak-password': 'weak-password',
  'auth/password-does-not-meet-requirements': 'weak-password',
  'auth/user-disabled': 'user-disabled',
  'auth/too-many-requests': 'too-many-requests',
  'auth/network-request-failed': 'network',
  'auth/operation-not-allowed': 'provider-disabled',
};

function toFailure(error: unknown): AuthFailure {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  return new AuthFailure(CODE_TO_REASON[code] ?? 'unknown', error);
}

/**
 * Create `users/{uid}` if it is not already there.
 *
 * ⚠️ Create-if-absent, never a blind write. `firestore.rules` allows an update
 * to touch ONLY `displayName` and `photoURL`, so re-writing the whole document
 * on every sign-in would be rejected the moment `createdAt` resolved to a new
 * `serverTimestamp()`. The read is what makes this idempotent.
 *
 * Deliberately not fatal: a signed-in user with no profile document is a
 * degraded state, not a broken one, and failing sign-in over it would be worse
 * than the problem. The write is also the first client-side Firestore write in
 * this project — so a permission error here is real information, and is
 * surfaced to the console rather than swallowed silently.
 */
async function ensureProfile(user: User): Promise<void> {
  const { db } = getFirebase();
  const ref = doc(db, 'users', user.uid);

  try {
    const existing = await getDoc(ref);
    if (existing.exists()) return;

    // The key set here must match `firestore.rules`' `hasOnly([...])` list
    // exactly. An extra field is not ignored — it rejects the whole write.
    await setDoc(ref, {
      uid: user.uid,
      email: user.email ?? '',
      displayName: user.displayName,
      photoURL: user.photoURL,
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    console.error('[auth] could not write users/%s profile', user.uid, error);
  }
}

export async function signUp(email: string, password: string): Promise<User> {
  const { auth } = getFirebase();
  try {
    const { user } = await createUserWithEmailAndPassword(auth, email, password);
    await ensureProfile(user);
    // Non-blocking on purpose: nothing is gated on a verified address yet, and
    // a mail-delivery failure must not read to the visitor as a failed signup.
    sendEmailVerification(user).catch((error) =>
      console.error('[auth] verification email failed', error),
    );
    return user;
  } catch (error) {
    throw toFailure(error);
  }
}

export async function signIn(email: string, password: string): Promise<User> {
  const { auth } = getFirebase();
  try {
    const { user } = await signInWithEmailAndPassword(auth, email, password);
    // Heals an account that predates this document, or whose creation write
    // failed. One read per explicit sign-in, not per page load.
    await ensureProfile(user);
    return user;
  } catch (error) {
    throw toFailure(error);
  }
}

export async function signOut(): Promise<void> {
  const { auth } = getFirebase();
  try {
    await firebaseSignOut(auth);
  } catch (error) {
    throw toFailure(error);
  }
}

/**
 * Resolves for an unknown address too — see the enumeration note at the top.
 * Never phrase the result as confirmation that an account exists.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const { auth } = getFirebase();
  try {
    await sendPasswordResetEmail(auth, email);
  } catch (error) {
    throw toFailure(error);
  }
}

export async function resendVerification(user: User): Promise<void> {
  try {
    await sendEmailVerification(user);
  } catch (error) {
    throw toFailure(error);
  }
}
