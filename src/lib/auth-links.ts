/**
 * What `/account/action` does with a link from an email — Client Components only.
 *
 * Separate from `auth.ts`, so this page does not carry the profile, photo,
 * linking and account-deletion code. It does NOT keep Firestore and Storage
 * off the page: `firebase-client.ts` initialises all three services, and on
 * 2026-09-15 the built `/account/action` measured 13 chunks / 1363 KB against
 * `/account`'s 14 / 1394 KB. Making that client lazy per service is what
 * would change it, and that touches every admin module.
 *
 * Each function checks the link is for the operation the page expects before
 * using it, so a verification code cannot be spent by the recovery branch or
 * the reverse.
 */

'use client';

import {
  ActionCodeOperation,
  applyActionCode,
  checkActionCode,
  confirmPasswordReset,
  sendPasswordResetEmail,
  signOut,
  verifyPasswordResetCode,
} from 'firebase/auth';

import { getFirebase } from './firebase-client';
import { AuthFailure, toAuthFailure } from './auth-errors';

async function checked(oobCode: string, operation: string) {
  const info = await checkActionCode(getFirebase().auth, oobCode);
  if (info.operation !== operation) throw new AuthFailure('action-code-invalid');
  return info;
}

export async function applyEmailVerification(oobCode: string): Promise<void> {
  try {
    await checked(oobCode, ActionCodeOperation.VERIFY_EMAIL);
    await applyActionCode(getFirebase().auth, oobCode);
  } catch (error) {
    throw toAuthFailure(error);
  }
}

/**
 * The address the reset is for. Showing it tells nobody anything new: the
 * link was delivered to that address.
 */
export async function readPasswordResetLink(oobCode: string): Promise<string> {
  try {
    return await verifyPasswordResetCode(getFirebase().auth, oobCode);
  } catch (error) {
    throw toAuthFailure(error);
  }
}

export async function completePasswordReset(oobCode: string, newPassword: string): Promise<void> {
  try {
    await confirmPasswordReset(getFirebase().auth, oobCode, newPassword);
  } catch (error) {
    throw toAuthFailure(error);
  }
}

/** Undo an email change. Resolves to the address the account is back on. */
export async function applyEmailRecovery(oobCode: string): Promise<string | null> {
  try {
    const info = await checked(oobCode, ActionCodeOperation.RECOVER_EMAIL);
    await applyActionCode(getFirebase().auth, oobCode);
    return info.data.email ?? null;
  } catch (error) {
    throw toAuthFailure(error);
  }
}

/**
 * Confirm a new address. Resolves to it. The change revokes the account's
 * sessions server-side, so this browser's session is cleared too rather than
 * left to fail on its next token refresh.
 */
export async function applyEmailChange(oobCode: string): Promise<string | null> {
  try {
    const info = await checked(oobCode, ActionCodeOperation.VERIFY_AND_CHANGE_EMAIL);
    await applyActionCode(getFirebase().auth, oobCode);
    await signOut(getFirebase().auth).catch(() => {});
    return info.data.email ?? null;
  } catch (error) {
    throw toAuthFailure(error);
  }
}

/** After recovering an email: the address is known to be the account's own. */
export async function sendPasswordResetTo(email: string): Promise<void> {
  try {
    await sendPasswordResetEmail(getFirebase().auth, email);
  } catch (error) {
    throw toAuthFailure(error);
  }
}
