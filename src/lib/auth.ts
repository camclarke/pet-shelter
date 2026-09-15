/**
 * Authentication and a person's own account — Client Components only.
 *
 * Sign-up, sign-in (email and password, or Google), the profile (name and
 * photo), the ways to sign in (password, Google), and deleting the account.
 * The failure mapping lives in `auth-errors.ts`; the decisions that need no
 * SDK (which photo URLs are safe, what a name may be, which methods can be
 * removed) live in `profile.ts`, where they are tested.
 *
 * ── Enumeration protection still shapes every message ──────────────────────
 * Identity Platform hides whether an address has an account: a wrong password
 * and a missing account are one error, and `sendPasswordResetEmail` resolves
 * for an address with no account. Its success message must therefore be
 * phrased as "if an account exists" — see `auth-errors.ts`.
 *
 * ── Google, and the popup rule ─────────────────────────────────────────────
 * Google sign-in uses a POPUP. Every function that opens one must reach the
 * SDK call before its first `await`, because Safari only allows a popup
 * opened inside the tap that asked for it; the callers in `src/app/account`
 * start these functions synchronously for the same reason. A redirect flow
 * would avoid popups, but with `authDomain` on firebaseapp.com it breaks in
 * browsers that partition third-party storage, which is most of them now.
 *
 * ── reCAPTCHA ──────────────────────────────────────────────────────────────
 * Sign-up, sign-in and password reset are protected by reCAPTCHA Enterprise,
 * switched on in Identity Platform by `scripts/auth-config.mjs`. The SDK
 * attaches the token itself; `prepareBotProtection()` only loads the config
 * early, which both saves a retry and gives reCAPTCHA more signal. It is
 * called on the sign-in screen and nowhere else, so no other page loads the
 * reCAPTCHA script.
 */

'use client';

import {
  EmailAuthProvider,
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  initializeRecaptchaConfig,
  linkWithCredential,
  linkWithPopup,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  unlink,
  updatePassword,
  updateProfile,
  verifyBeforeUpdateEmail,
  type User,
} from 'firebase/auth';
import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { deleteObject, getDownloadURL, ref, uploadBytes } from 'firebase/storage';

import { getFirebase } from './firebase-client';
import { AuthFailure, isPopupDismissal, toAuthFailure } from './auth-errors';
import { ACCOUNT_DELETE_PATH, accountDeleteFailure, type AccountDeleteFailure } from './account-delete';
import { stripAndResize } from './image-strip';
import {
  AVATAR_MAX_EDGE,
  GOOGLE_PROVIDER,
  avatarStoragePath,
  clampDisplayName,
  isGooglePhotoUrl,
  normalizeDisplayName,
  ownAvatarPathFromUrl,
  safeAvatarUrl,
} from './profile';

export { AuthFailure, type AuthError } from './auth-errors';

// ─── the profile document ────────────────────────────────────────────────────

type ProfilePatch = { displayName?: string | null; photoURL?: string | null };

/**
 * Create `users/{uid}` if it is not already there, and heal the three fields
 * a person's account can change underneath it.
 *
 * ⚠️ Create-if-absent, never a blind write. `firestore.rules` allows an update
 * to touch ONLY `displayName`, `photoURL` and `email` (and `email` only to the
 * address in the caller's own token), so re-writing the whole document on
 * every sign-in would be rejected the moment `createdAt` resolved to a new
 * `serverTimestamp()`. The read is what makes this idempotent.
 *
 * Every value goes through `clampDisplayName` / `safeAvatarUrl` first, so a
 * 70-character Google name or an unexpected photo host is cut or dropped
 * rather than failing the rule and leaving no profile at all.
 *
 * Deliberately not fatal: a signed-in user with no profile document is a
 * degraded state, not a broken one, and failing sign-in over it would be worse
 * than the problem. A permission error here is real information, and is
 * surfaced to the console rather than swallowed silently.
 */
async function ensureProfile(user: User): Promise<void> {
  const { db } = getFirebase();
  const profileRef = doc(db, 'users', user.uid);
  const displayName = clampDisplayName(user.displayName);
  const photoURL = safeAvatarUrl(user.photoURL, user.uid);

  try {
    const existing = await getDoc(profileRef);
    if (!existing.exists()) {
      // The key set here must match `firestore.rules`' `hasOnly([...])` list
      // exactly. An extra field is not ignored — it rejects the whole write.
      await setDoc(profileRef, {
        uid: user.uid,
        email: user.email ?? '',
        displayName,
        photoURL,
        createdAt: serverTimestamp(),
      });
      return;
    }

    const data = existing.data();
    const heal: ProfilePatch & { email?: string } = {};
    // After an email change the document still carries the old address, and
    // admin screens label people by it.
    if (user.email && data.email !== user.email) heal.email = user.email;
    if (data.displayName == null && displayName) heal.displayName = displayName;
    if (data.photoURL == null && photoURL) heal.photoURL = photoURL;
    if (Object.keys(heal).length > 0) await updateDoc(profileRef, heal);
  } catch (error) {
    console.error('[auth] could not write users/%s profile', user.uid, error);
  }
}

/**
 * The Auth profile first — the header reads it — then the document, which
 * admin screens read. The document write is NOT swallowed: this runs because a
 * person asked for a change, and they must hear if it did not happen.
 */
async function writeProfile(user: User, patch: ProfilePatch): Promise<void> {
  await updateProfile(user, patch);
  await ensureProfile(user);
  await updateDoc(doc(getFirebase().db, 'users', user.uid), patch);
}

function googleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  // Shared family phones are common here: always ask which Google account,
  // rather than silently signing in whichever one the browser used last.
  provider.setCustomParameters({ prompt: 'select_account' });
  return provider;
}

/** The linked Google account's own details, or null when Google is not linked. */
export function googleProfileOf(user: User): { email: string | null; photoURL: string | null } | null {
  const google = user.providerData.find((p) => p.providerId === GOOGLE_PROVIDER);
  return google ? { email: google.email, photoURL: safeAvatarUrl(google.photoURL, user.uid) } : null;
}

// ─── signing in and out ──────────────────────────────────────────────────────

let botProtectionRequested = false;

/** Load the reCAPTCHA config early. Safe to call repeatedly; never throws. */
export function prepareBotProtection(): void {
  if (botProtectionRequested) return;
  botProtectionRequested = true;
  initializeRecaptchaConfig(getFirebase().auth).catch((error) => {
    // Not fatal, and EXPECTED while reCAPTCHA is off for the project: the SDK
    // throws "recaptchaKey undefined" when there is no key to load. Sign-in is
    // unaffected — with no config loaded, `handleRecaptchaFlow` in
    // @firebase/auth sends the request without a token, and only if the server
    // answers `missing-recaptcha-token` does it load the config and retry.
    // Read in the SDK source, 2026-09-15. Not retried here: that is the SDK's job.
    console.info('[auth] reCAPTCHA is not configured for this project, or its config did not load', error);
  });
}

export async function signUp(email: string, password: string, displayName: string): Promise<User> {
  const { auth } = getFirebase();
  try {
    const { user } = await createUserWithEmailAndPassword(auth, email, password);
    const name = clampDisplayName(displayName);
    if (name) await updateProfile(user, { displayName: name });
    await ensureProfile(user);
    // Non-blocking on purpose: nothing is gated on a verified address yet, and
    // a mail-delivery failure must not read to the visitor as a failed signup.
    sendEmailVerification(user).catch((error) => console.error('[auth] verification email failed', error));
    return user;
  } catch (error) {
    throw toAuthFailure(error);
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
    throw toAuthFailure(error);
  }
}

/**
 * Sign in or sign up with Google. Resolves null when the person closes the
 * window. ⚠️ Call it synchronously from the tap — see the popup rule above.
 *
 * A Google account's name and photo arrive on the Auth profile by themselves,
 * and `ensureProfile` copies them into `users/{uid}` on the first sign-in.
 */
export async function signInWithGoogle(): Promise<User | null> {
  const { auth } = getFirebase();
  try {
    const { user } = await signInWithPopup(auth, googleProvider());
    await ensureProfile(user);
    return user;
  } catch (error) {
    if (isPopupDismissal(error)) return null;
    throw toAuthFailure(error);
  }
}

export async function signOut(): Promise<void> {
  const { auth } = getFirebase();
  try {
    await firebaseSignOut(auth);
  } catch (error) {
    throw toAuthFailure(error);
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
    throw toAuthFailure(error);
  }
}

export async function resendVerification(user: User): Promise<void> {
  try {
    await sendEmailVerification(user);
  } catch (error) {
    throw toAuthFailure(error);
  }
}

/**
 * Confirm it is really this person, before a sensitive change. `password`
 * null means "with Google" and opens a popup — call synchronously from a tap.
 * Resolves false when the Google window is closed.
 */
export async function reauthenticate(user: User, password: string | null): Promise<boolean> {
  try {
    if (password === null) {
      await reauthenticateWithPopup(user, googleProvider());
    } else {
      if (!password) throw new AuthFailure('missing-password');
      if (!user.email) throw new AuthFailure('invalid-credentials');
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
    }
    return true;
  } catch (error) {
    if (isPopupDismissal(error)) return false;
    throw toAuthFailure(error);
  }
}

// ─── the profile ─────────────────────────────────────────────────────────────

/** The caller has already validated with `validateDisplayName`. */
export async function saveDisplayName(user: User, raw: string): Promise<void> {
  try {
    await writeProfile(user, { displayName: normalizeDisplayName(raw) });
  } catch (error) {
    throw toAuthFailure(error);
  }
}

/**
 * Upload a new profile photo and make it the profile's.
 *
 * Goes through `stripAndResize`, like every other photo in this project: a
 * photo taken at home carries GPS in its EXIF. A `PhotoUnreadableError` from
 * that step is thrown as it is, so the screen can say what actually happened.
 *
 * ⚠️ The photo URL is a Firebase download URL, which carries a token that
 * bypasses `storage.rules` for anyone holding it (measured 2026-09-03). That is
 * accepted HERE, and only here: the person chose to have a profile photo, the
 * URL is stored where only they and admins can read it, and a Google account
 * photo — the other allowed kind — is exactly as fetchable by URL.
 */
export async function uploadAvatar(user: User, file: File): Promise<void> {
  const processed = await stripAndResize(file, AVATAR_MAX_EDGE);
  const { storage } = getFirebase();
  const previous = ownAvatarPathFromUrl(user.photoURL, user.uid);
  const objectRef = ref(storage, avatarStoragePath(user.uid, crypto.randomUUID()));

  try {
    await uploadBytes(objectRef, processed, { contentType: 'image/jpeg' });
    const url = await getDownloadURL(objectRef);
    await writeProfile(user, { photoURL: url });
  } catch (error) {
    deleteObject(objectRef).catch(() => {});
    throw toAuthFailure(error);
  }

  if (previous) deleteOwnAvatar(previous);
}

/** Best effort: an orphaned old photo is untidy, not harmful — and it is swept on account deletion. */
function deleteOwnAvatar(path: string): void {
  deleteObject(ref(getFirebase().storage, path)).catch((error) =>
    console.warn('[auth] could not delete a previous profile photo', error),
  );
}

export async function removeAvatar(user: User): Promise<void> {
  const previous = ownAvatarPathFromUrl(user.photoURL, user.uid);
  try {
    await writeProfile(user, { photoURL: null });
  } catch (error) {
    throw toAuthFailure(error);
  }
  if (previous) deleteOwnAvatar(previous);
}

/** Use the linked Google account's photo instead of an upload. */
export async function adoptGooglePhoto(user: User): Promise<void> {
  const googlePhoto = googleProfileOf(user)?.photoURL;
  if (!googlePhoto) return;
  const previous = ownAvatarPathFromUrl(user.photoURL, user.uid);
  try {
    await writeProfile(user, { photoURL: googlePhoto });
  } catch (error) {
    throw toAuthFailure(error);
  }
  if (previous) deleteOwnAvatar(previous);
}

// ─── ways to sign in ─────────────────────────────────────────────────────────

/**
 * Link Google to this account. ⚠️ Popup — call synchronously from a tap.
 * Resolves false when the window is closed. Fills in a missing name or photo
 * from Google, and never replaces one the person already chose.
 */
export async function linkGoogle(user: User): Promise<boolean> {
  try {
    const { user: linked } = await linkWithPopup(user, googleProvider());
    const google = linked.providerData.find((p) => p.providerId === GOOGLE_PROVIDER);
    const patch: ProfilePatch = {};
    if (!normalizeDisplayName(linked.displayName)) {
      const name = clampDisplayName(google?.displayName);
      if (name) patch.displayName = name;
    }
    if (!safeAvatarUrl(linked.photoURL, linked.uid)) {
      const photo = safeAvatarUrl(google?.photoURL, linked.uid);
      if (photo) patch.photoURL = photo;
    }
    if (Object.keys(patch).length > 0) await writeProfile(linked, patch);
    return true;
  } catch (error) {
    if (isPopupDismissal(error)) return false;
    throw toAuthFailure(error);
  }
}

/**
 * Unlink Google. The screen offers this only while a password remains
 * (`accountCapabilities`); a Google photo stops being used with it.
 */
export async function unlinkGoogle(user: User): Promise<void> {
  try {
    await unlink(user, GOOGLE_PROVIDER);
    if (isGooglePhotoUrl(user.photoURL)) await writeProfile(user, { photoURL: null });
  } catch (error) {
    throw toAuthFailure(error);
  }
}

/** Reauthenticates with the current password, then sets the new one. */
export async function changePassword(user: User, currentPassword: string, newPassword: string): Promise<void> {
  await reauthenticate(user, currentPassword);
  try {
    await updatePassword(user, newPassword);
  } catch (error) {
    throw toAuthFailure(error);
  }
}

/**
 * A Google-only account adds a password, so it can sign in without Google.
 * Can fail with `requires-recent-login`; the screen then asks for Google again
 * and retries.
 */
export async function createPassword(user: User, newPassword: string): Promise<void> {
  try {
    if (!user.email) throw new AuthFailure('invalid-email');
    await linkWithCredential(user, EmailAuthProvider.credential(user.email, newPassword));
  } catch (error) {
    throw toAuthFailure(error);
  }
}

/**
 * Sends a confirmation link to the NEW address. Nothing changes until it is
 * opened (the link lands on `/account/action`), and then the old address gets
 * a message with a link to undo it. `updateEmail` is not an option: with
 * enumeration protection on, Identity Platform only allows the verified flow.
 */
export async function changeEmail(user: User, currentPassword: string, newEmail: string): Promise<void> {
  await reauthenticate(user, currentPassword);
  try {
    await verifyBeforeUpdateEmail(user, newEmail);
  } catch (error) {
    throw toAuthFailure(error);
  }
}

// ─── deleting the account ────────────────────────────────────────────────────

export class AccountDeleteError extends Error {
  readonly reason: AccountDeleteFailure | 'unexpected' | 'network';

  constructor(reason: AccountDeleteError['reason'], cause?: unknown) {
    super(reason);
    this.name = 'AccountDeleteError';
    this.reason = reason;
    this.cause = cause;
  }
}

/**
 * Confirm identity, then ask the server to delete everything. `password` null
 * means "confirm with Google" (a popup — call synchronously from a tap).
 * Resolves `dismissed` when the Google window is closed.
 *
 * The server refuses anything older than a five-minute sign-in, which the
 * reauthentication right before the request satisfies. `getIdToken(true)`
 * makes sure the request carries the token that reauthentication produced.
 */
export async function deleteAccount(user: User, password: string | null): Promise<'deleted' | 'dismissed'> {
  if (!(await reauthenticate(user, password))) return 'dismissed';

  let response: Response;
  try {
    const token = await user.getIdToken(true);
    response = await fetch(ACCOUNT_DELETE_PATH, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    throw new AccountDeleteError('network', error);
  }

  const failure = accountDeleteFailure(response);
  if (failure) throw new AccountDeleteError(failure);

  // The Auth user no longer exists; clear the session this browser still holds.
  await firebaseSignOut(getFirebase().auth).catch(() => {});
  return 'deleted';
}
