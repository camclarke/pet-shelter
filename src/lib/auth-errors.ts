/**
 * Firebase auth failures, narrowed to a union the locale can word — PURE.
 *
 * Split out of `auth.ts` on 2026-09-15 so the email-link page and the tests
 * can use the mapping without importing Firestore and Storage.
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
 * enumeration protection is ON. It deliberately collapses
 * `auth/user-not-found` and `auth/wrong-password` into a single
 * `auth/invalid-credential`, so the server cannot be used to discover which
 * addresses have accounts. That is a feature, and it constrains the UI: we
 * must never say "no existe esa cuenta" or "contraseña incorrecta", because
 * we genuinely do not know which one it was. `invalid-credentials` says
 * neither, on purpose.
 */

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
  /** The provider (email/password or Google) is switched off for the project. */
  | 'provider-disabled'
  /** reCAPTCHA Enterprise refused the request, or its token was missing or stale. */
  | 'captcha-failed'
  | 'popup-blocked'
  /** Google sign-in for an address that already has a password account. */
  | 'account-exists-with-different-credential'
  /** Linking a Google account that already belongs to ANOTHER account here. */
  | 'credential-already-in-use'
  | 'provider-already-linked'
  /** A sensitive change needs a sign-in from the last few minutes. */
  | 'requires-recent-login'
  /** Re-authenticated as a different account than the one signed in. */
  | 'user-mismatch'
  /** The page's host is not in Identity Platform's authorized domains. */
  | 'unauthorized-domain'
  /** An in-app browser or blocked storage: popups and sessions cannot work. */
  | 'browser-unsupported'
  /** The session was revoked, e.g. by a password change on another device. */
  | 'session-expired'
  | 'action-code-invalid'
  | 'action-code-expired'
  | 'unknown';

/**
 * Thrown by every auth operation, so a caller never has to know a Firebase
 * code exists. `cause` keeps the original for the console — diagnosing an
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

const RECAPTCHA_CODES = [
  'auth/captcha-check-failed',
  'auth/invalid-recaptcha-token',
  'auth/missing-recaptcha-token',
  'auth/invalid-recaptcha-action',
  'auth/invalid-recaptcha-version',
  'auth/missing-recaptcha-version',
  'auth/recaptcha-not-enabled',
  'auth/invalid-req-type',
];

export const CODE_TO_REASON: Readonly<Record<string, AuthError>> = {
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
  ...Object.fromEntries(RECAPTCHA_CODES.map((code) => [code, 'captcha-failed' as const])),
  'auth/popup-blocked': 'popup-blocked',
  'auth/account-exists-with-different-credential': 'account-exists-with-different-credential',
  'auth/credential-already-in-use': 'credential-already-in-use',
  'auth/provider-already-linked': 'provider-already-linked',
  'auth/requires-recent-login': 'requires-recent-login',
  'auth/user-mismatch': 'user-mismatch',
  'auth/unauthorized-domain': 'unauthorized-domain',
  'auth/operation-not-supported-in-this-environment': 'browser-unsupported',
  'auth/web-storage-unsupported': 'browser-unsupported',
  'auth/user-token-expired': 'session-expired',
  'auth/invalid-action-code': 'action-code-invalid',
  'auth/expired-action-code': 'action-code-expired',
};

/** The `code` of a FirebaseError-shaped value, or ''. */
export function authCodeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : '';
}

export function toAuthFailure(error: unknown): AuthFailure {
  if (error instanceof AuthFailure) return error;
  return new AuthFailure(CODE_TO_REASON[authCodeOf(error)] ?? 'unknown', error);
}

/**
 * The person closed the Google window, or tapped the button twice. Not a
 * failure to report: an error message for a deliberate "never mind" reads as
 * something having gone wrong.
 */
export function isPopupDismissal(error: unknown): boolean {
  const code = authCodeOf(error);
  return code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request';
}
