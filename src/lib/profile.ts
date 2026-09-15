/**
 * The account profile — PURE. No Firebase, no Spanish, no DOM.
 *
 * Everything here decides something about a person's own account: what name
 * the header shows, which profile photo may be rendered, which sign-in methods
 * they can add or remove, and whether a new password is acceptable. It is kept
 * free of the SDK so every branch is unit-tested, the same split as
 * `areas.ts` / `areas-admin.ts`; `src/lib/auth.ts` does the Firebase half.
 *
 * ═══ THE AVATAR ALLOWLIST IS MIRRORED IN firestore.rules ═════════════════════
 * `users/{uid}.photoURL` is client-writable, and an admin screen renders it
 * (`getUserLabels` already reads that document for attribution). An arbitrary
 * URL there would be a tracking pixel pointed at whichever admin opens the
 * timeline, so only two kinds of URL are ever stored or rendered:
 *
 *   - a Google account photo, on `lh3`–`lh6.googleusercontent.com`;
 *   - the user's OWN upload, under `users/{uid}/avatar/` in Storage.
 *
 * `firestore.rules` enforces the same two patterns on write, and
 * `account-wiring.test.ts` fails if the two copies drift apart.
 */

/** Longest display name kept, in UTF-16 units. Rules count characters, which is never more. */
export const DISPLAY_NAME_MAX_LENGTH = 60;

/** Longest photo URL kept. Mirrors `size() <= 2048` in firestore.rules. */
export const PHOTO_URL_MAX_LENGTH = 2048;

/**
 * Our own minimum. Firebase's default is 6, and `scripts/auth-config.mjs`
 * raises the project policy to match this — but the client checks it itself,
 * so the rule holds even before that script has run.
 */
export const PASSWORD_MIN_LENGTH = 8;

/** Identity Platform's own ceiling. Past this it refuses, so we refuse first. */
export const PASSWORD_MAX_LENGTH = 4096;

/** Long edge of an uploaded profile photo. Shown at 72px at most; 512 covers 3x screens. */
export const AVATAR_MAX_EDGE = 512;

/**
 * How old a sign-in may be before deleting the account needs a fresh one.
 * Firebase's own "recent login" window for sensitive operations is five minutes.
 */
export const RECENT_SIGN_IN_MAX_AGE_S = 5 * 60;

export type ProfileError = 'display-name-empty' | 'display-name-too-long';

export type NewPasswordError =
  | 'password-too-short'
  | 'password-too-long'
  | 'password-mismatch'
  | 'password-same-as-email';

// ─── names ───────────────────────────────────────────────────────────────────

/** NFC, inner whitespace collapsed to one space, trimmed. */
export function normalizeDisplayName(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  return raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** Why a name a person TYPED cannot be saved, or null when it can. */
export function validateDisplayName(raw: string | null | undefined): ProfileError | null {
  const name = normalizeDisplayName(raw);
  if (name.length === 0) return 'display-name-empty';
  if (name.length > DISPLAY_NAME_MAX_LENGTH) return 'display-name-too-long';
  return null;
}

/**
 * A name that came from a PROVIDER (Google), made storable rather than
 * refused: nobody can fix a 70-character Google name at sign-in, and failing
 * the profile write over it would be worse than cutting it.
 *
 * Cuts on code points, so an accented letter or an emoji is never split into
 * half a surrogate pair.
 */
export function clampDisplayName(raw: string | null | undefined): string | null {
  const name = normalizeDisplayName(raw);
  if (name.length === 0) return null;
  if (name.length <= DISPLAY_NAME_MAX_LENGTH) return name;

  let out = '';
  for (const char of name) {
    if (out.length + char.length > DISPLAY_NAME_MAX_LENGTH) break;
    out += char;
  }
  return out.trim() || null;
}

/**
 * What the header button says: the first word of the display name, else the
 * local part of the email, else null (the caller shows its generic label).
 *
 * The first word only, because the button is capped at 42vw on a phone and
 * "María" reads better than "María José Fernández Qui…".
 */
export function accountLabel(profile: {
  displayName?: string | null;
  email?: string | null;
}): string | null {
  const name = normalizeDisplayName(profile.displayName);
  if (name) return name.split(' ')[0] ?? name;

  const local = (profile.email ?? '').split('@')[0]?.trim();
  return local ? local : null;
}

/** Up to two initials, for a profile with no photo. Letters only, uppercased. */
export function initialsFor(label: string | null | undefined): string {
  const words = normalizeDisplayName(label).split(' ').filter(Boolean);
  const letters = words
    .map((word) => word.match(/\p{L}|\p{N}/u)?.[0] ?? '')
    .filter(Boolean)
    .slice(0, 2);
  return letters.join('').toLocaleUpperCase('es');
}

// ─── photos ──────────────────────────────────────────────────────────────────

/** A Google account photo. Mirrored in firestore.rules. */
const GOOGLE_PHOTO = /^https:\/\/lh[3-6]\.googleusercontent\.com\/.+$/;

/** A Firebase Storage uid: letters and digits only, so it is safe inside a pattern. */
const UID_SHAPE = /^[A-Za-z0-9]{1,128}$/;

/**
 * The storage object a download URL points at, still percent-encoded. Only
 * `?` may follow it — a download URL's `alt` and `token` — which is exactly
 * what firestore.rules accepts.
 */
const STORAGE_URL = /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[^/]+\/o\/([^?#]+)(?:\?.*)?$/;

/** The only object name an avatar upload may have. Mirrored in storage.rules. */
export const AVATAR_FILE_NAME = /^[A-Za-z0-9-]{1,64}\.jpg$/;

export function isGooglePhotoUrl(url: string | null | undefined): boolean {
  return typeof url === 'string' && url.length <= PHOTO_URL_MAX_LENGTH && GOOGLE_PHOTO.test(url);
}

/** The Storage path for a new avatar object. `id` must satisfy AVATAR_FILE_NAME once `.jpg` is added. */
export function avatarStoragePath(uid: string, id: string): string {
  return `users/${uid}/avatar/${id}.jpg`;
}

/**
 * The Storage path of THIS user's own uploaded avatar, parsed out of its
 * download URL — or null when the URL is anything else, including another
 * user's upload. Used to delete the previous photo after a new one is saved,
 * so it must never return a path outside `users/{uid}/avatar/`.
 */
export function ownAvatarPathFromUrl(url: string | null | undefined, uid: string): string | null {
  if (typeof url !== 'string' || url.length > PHOTO_URL_MAX_LENGTH) return null;
  if (!UID_SHAPE.test(uid)) return null;

  const match = STORAGE_URL.exec(url);
  if (!match?.[1]) return null;

  // Compared ENCODED, never decoded: a real download URL always encodes the
  // slashes, firestore.rules matches the encoded form, and not decoding means
  // "%2F..%2F" can never be read back into a path outside the folder.
  const prefix = `users%2F${uid}%2Favatar%2F`;
  if (!match[1].startsWith(prefix)) return null;
  const name = match[1].slice(prefix.length);
  return AVATAR_FILE_NAME.test(name) ? `users/${uid}/avatar/${name}` : null;
}

/**
 * The photo URL to store or render, or null. See the allowlist note at the
 * top of this file — this is the function every writer and every renderer
 * goes through.
 */
export function safeAvatarUrl(url: string | null | undefined, uid: string): string | null {
  if (isGooglePhotoUrl(url)) return url as string;
  return ownAvatarPathFromUrl(url, uid) ? (url as string) : null;
}

// ─── sign-in methods ─────────────────────────────────────────────────────────

export const PASSWORD_PROVIDER = 'password';
export const GOOGLE_PROVIDER = 'google.com';

export interface SignInMethods {
  password: boolean;
  google: boolean;
}

export function signInMethods(providerIds: readonly string[]): SignInMethods {
  return {
    password: providerIds.includes(PASSWORD_PROVIDER),
    google: providerIds.includes(GOOGLE_PROVIDER),
  };
}

/**
 * Which account actions make sense for these methods.
 *
 * ⚠️ Google can be unlinked ONLY while a password remains. Unlinking the last
 * method would leave an account nobody can sign in to, with the person's
 * adoption applications attached to it.
 */
export interface AccountCapabilities {
  changePassword: boolean;
  /** A Google-only account adding a password, so it works without Google. */
  setPassword: boolean;
  /** Only with a password: a Google account's address belongs to Google. */
  changeEmail: boolean;
  linkGoogle: boolean;
  unlinkGoogle: boolean;
}

export function accountCapabilities(methods: SignInMethods, hasEmail: boolean): AccountCapabilities {
  return {
    changePassword: methods.password,
    setPassword: !methods.password && hasEmail,
    changeEmail: methods.password,
    linkGoogle: !methods.google,
    unlinkGoogle: methods.google && methods.password,
  };
}

// ─── passwords ───────────────────────────────────────────────────────────────

/**
 * Why a NEW password is refused, or null. Length and a typed confirmation,
 * nothing cleverer: composition rules push people toward "Wawitas2026!", and
 * the protection that matters here is reCAPTCHA plus rate limiting, which
 * Identity Platform does server-side.
 */
export function checkNewPassword(
  password: string,
  confirmation: string,
  email: string | null | undefined
): NewPasswordError | null {
  if (password.length < PASSWORD_MIN_LENGTH) return 'password-too-short';
  if (password.length > PASSWORD_MAX_LENGTH) return 'password-too-long';
  if (email && password.trim().toLowerCase() === email.trim().toLowerCase()) {
    return 'password-same-as-email';
  }
  if (password !== confirmation) return 'password-mismatch';
  return null;
}

// ─── browsers ────────────────────────────────────────────────────────────────

/**
 * Is this an app's built-in browser rather than Chrome or Safari?
 *
 * Google refuses OAuth inside embedded web views ("disallowed_useragent"), and
 * this site's visitors arrive overwhelmingly from Facebook and Instagram
 * links, which open in exactly those views. Offering "Continuar con Google"
 * there sends a person into Google's own error page. So the button is replaced
 * with a sentence telling them to open the page in their browser — and the
 * email form, which works everywhere, stays right below it.
 *
 * A heuristic, and it errs toward NOT flagging: a false positive hides a
 * working button (the UI still offers "intentar de todos modos"), a false
 * negative shows Google's error page, which is what happened before this.
 */
export function isEmbeddedBrowser(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  const ua = userAgent;

  // Named in-app browsers.
  if (/FBAN|FBAV|FB_IAB|FBIOS|Instagram|Line\/|MicroMessenger|musical_ly|TikTok|Snapchat|LinkedInApp|Twitter for/i.test(ua)) {
    return true;
  }
  // Android WebView marks itself with "; wv)".
  if (/Android/i.test(ua) && /;\s*wv\)/i.test(ua)) return true;
  // iOS WKWebView in an app: WebKit on an iPhone/iPad with no "Safari/" token.
  // Chrome (CriOS), Firefox (FxiOS) and Edge (EdgiOS) on iOS all carry it.
  if (/iPhone|iPad|iPod/i.test(ua) && /AppleWebKit/i.test(ua) && !/Safari\//i.test(ua)) return true;

  return false;
}
