/**
 * The email action link, parsed — PURE.
 *
 * Every email Identity Platform sends (verify an address, reset a password,
 * undo an email change, confirm a new email) links to its "action URL" with
 * `?mode=…&oobCode=…`. Until 2026-09-15 that URL was Firebase's own page on
 * `wawitas.firebaseapp.com`, in English, on a domain a visitor has never seen.
 * `scripts/auth-config.mjs` points it at `/account/action` instead, and this
 * module is what that page reads first.
 *
 * It is an allowlist. An unknown mode is refused rather than passed to the SDK,
 * and the one-time code must look like one before any request is made with it.
 */

export const ACTION_HANDLER_PATH = '/account/action';

export type AuthActionMode = 'resetPassword' | 'verifyEmail' | 'recoverEmail' | 'verifyAndChangeEmail';

const MODES: readonly AuthActionMode[] = ['resetPassword', 'verifyEmail', 'recoverEmail', 'verifyAndChangeEmail'];

/** Firebase's out-of-band codes are URL-safe base64. Generous on length, strict on alphabet. */
const OOB_CODE = /^[A-Za-z0-9_-]{16,512}$/;

export type ParsedAuthAction =
  | { ok: true; mode: AuthActionMode; oobCode: string }
  | { ok: false; reason: 'missing' | 'unsupported-mode' | 'malformed-code' };

export function parseAuthAction(search: string): ParsedAuthAction {
  const params = new URLSearchParams(search);
  const mode = params.get('mode');
  const oobCode = params.get('oobCode');

  if (!mode || !oobCode) return { ok: false, reason: 'missing' };
  if (!(MODES as readonly string[]).includes(mode)) return { ok: false, reason: 'unsupported-mode' };
  if (!OOB_CODE.test(oobCode)) return { ok: false, reason: 'malformed-code' };

  return { ok: true, mode: mode as AuthActionMode, oobCode };
}

/** The action URL for a site origin, e.g. `https://wawitas.org/account/action`. */
export function actionCallbackUri(siteUrl: string): string {
  const url = new URL(siteUrl);
  if (url.protocol !== 'https:') throw new Error(`action URL must be https, got ${siteUrl}`);
  return `${url.origin}${ACTION_HANDLER_PATH}`;
}
