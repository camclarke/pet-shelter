import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DISPLAY_NAME_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  accountCapabilities,
  accountLabel,
  avatarStoragePath,
  checkNewPassword,
  clampDisplayName,
  initialsFor,
  isEmbeddedBrowser,
  isGooglePhotoUrl,
  normalizeDisplayName,
  ownAvatarPathFromUrl,
  safeAvatarUrl,
  signInMethods,
  validateDisplayName,
} from '../profile';

// ─── names ───────────────────────────────────────────────────────────────────

test('a display name is NFC, single-spaced and trimmed', () => {
  // "José" typed with a combining acute accent is five UTF-16 units; NFC is four.
  assert.equal(normalizeDisplayName('  José   Luis\t\n'), 'José Luis');
  assert.equal(normalizeDisplayName('José').length, 4);
  assert.equal(normalizeDisplayName(null), '');
  assert.equal(normalizeDisplayName(undefined), '');
});

test('a typed name must be present and at most 60 characters', () => {
  // Literals, not DISPLAY_NAME_MAX_LENGTH: a test that reads the constant it
  // checks cannot fail when the constant drifts from firestore.rules.
  assert.equal(DISPLAY_NAME_MAX_LENGTH, 60);
  assert.equal(validateDisplayName(''), 'display-name-empty');
  assert.equal(validateDisplayName('   '), 'display-name-empty');
  assert.equal(validateDisplayName('a'.repeat(60)), null);
  assert.equal(validateDisplayName('a'.repeat(61)), 'display-name-too-long');
  assert.equal(validateDisplayName('María'), null);
});

test('a provider name is cut to fit, never refused, and never splits a character', () => {
  assert.equal(clampDisplayName('a'.repeat(70)), 'a'.repeat(60));
  // 59 letters and an emoji (2 UTF-16 units) would be 61 units: the emoji goes whole.
  assert.equal(clampDisplayName(`${'a'.repeat(59)}😀`), 'a'.repeat(59));
  assert.equal(clampDisplayName(`${'a'.repeat(58)}😀`), `${'a'.repeat(58)}😀`);
  assert.equal(clampDisplayName('   '), null);
  assert.equal(clampDisplayName(null), null);
});

test('the header label is the first name, else the email local part, else null', () => {
  assert.equal(accountLabel({ displayName: 'María José Fernández', email: 'm@example.com' }), 'María');
  assert.equal(accountLabel({ displayName: '   ', email: 'luna.perez@example.com' }), 'luna.perez');
  assert.equal(accountLabel({ displayName: null, email: null }), null);
  assert.equal(accountLabel({}), null);
});

test('initials are up to two letters, uppercased, accents kept', () => {
  assert.equal(initialsFor('maría josé fernández'), 'MJ');
  assert.equal(initialsFor('ñandú'), 'Ñ');
  assert.equal(initialsFor('  '), '');
  assert.equal(initialsFor(null), '');
});

// ─── photos ──────────────────────────────────────────────────────────────────

const UID = 'Uid123abc';
const own = (name: string, uid = UID) =>
  `https://firebasestorage.googleapis.com/v0/b/wawitas-app/o/${encodeURIComponent(`users/${uid}/avatar/${name}`)}?alt=media&token=t0k`;

test('a Google photo is recognised only on lh3–lh6.googleusercontent.com over https', () => {
  assert.equal(isGooglePhotoUrl('https://lh3.googleusercontent.com/a/ACg8ocK=s96-c'), true);
  assert.equal(isGooglePhotoUrl('https://lh6.googleusercontent.com/a/x'), true);
  assert.equal(isGooglePhotoUrl('https://lh7.googleusercontent.com/a/x'), false);
  assert.equal(isGooglePhotoUrl('http://lh3.googleusercontent.com/a/x'), false);
  // A look-alike host: the pattern needs "/" straight after ".com".
  assert.equal(isGooglePhotoUrl('https://lh3.googleusercontent.com.evil.example/a'), false);
  assert.equal(isGooglePhotoUrl(`https://lh3.googleusercontent.com/${'a'.repeat(2048)}`), false);
  assert.equal(isGooglePhotoUrl(null), false);
});

test('an avatar path is built under the owner, with a name storage.rules accepts', () => {
  assert.equal(avatarStoragePath(UID, 'abc-123'), `users/${UID}/avatar/abc-123.jpg`);
});

test("the user's own upload resolves to its path; anything else does not", () => {
  assert.equal(ownAvatarPathFromUrl(own('abc-123.jpg'), UID), `users/${UID}/avatar/abc-123.jpg`);
  assert.equal(ownAvatarPathFromUrl(own('abc-123.jpg', 'SomeoneElse1'), UID), null, 'another user');
  assert.equal(ownAvatarPathFromUrl(own('../../pets/x/cover.jpg'), UID), null, 'traversal');
  assert.equal(ownAvatarPathFromUrl(own('abc.png'), UID), null, 'not a .jpg');
  assert.equal(
    ownAvatarPathFromUrl('https://firebasestorage.googleapis.com/v0/b/b/o/users%2FUid123abc%2Favatar%2F%E0%A4%A', UID),
    null,
    'malformed percent-encoding'
  );
  assert.equal(ownAvatarPathFromUrl(own('abc.jpg', 'a.b'), 'a.b'), null, 'a uid that is not a Firebase uid');
  assert.equal(ownAvatarPathFromUrl('https://example.com/o/users%2FUid123abc%2Favatar%2Fa.jpg', UID), null);
});

test('safeAvatarUrl passes exactly Google photos and the user’s own uploads', () => {
  const google = 'https://lh3.googleusercontent.com/a/x=s96-c';
  assert.equal(safeAvatarUrl(google, UID), google);
  assert.equal(safeAvatarUrl(own('a-1.jpg'), UID), own('a-1.jpg'));
  assert.equal(safeAvatarUrl(own('a-1.jpg', 'Other99'), UID), null);
  assert.equal(safeAvatarUrl('https://tracker.example/pixel.gif', UID), null);
  assert.equal(safeAvatarUrl('', UID), null);
});

// ─── sign-in methods ─────────────────────────────────────────────────────────

test('provider ids map to the two methods this site offers', () => {
  assert.deepEqual(signInMethods(['password']), { password: true, google: false });
  assert.deepEqual(signInMethods(['google.com', 'password']), { password: true, google: true });
  assert.deepEqual(signInMethods([]), { password: false, google: false });
});

test('Google can be unlinked only while a password remains', () => {
  assert.equal(accountCapabilities({ password: false, google: true }, true).unlinkGoogle, false);
  assert.equal(accountCapabilities({ password: true, google: true }, true).unlinkGoogle, true);
});

test('a Google-only account can add a password but not change one or its email', () => {
  assert.deepEqual(accountCapabilities({ password: false, google: true }, true), {
    changePassword: false,
    setPassword: true,
    changeEmail: false,
    linkGoogle: false,
    unlinkGoogle: false,
  });
  assert.equal(accountCapabilities({ password: false, google: true }, false).setPassword, false, 'no email');
});

test('a password account can change both and link Google', () => {
  assert.deepEqual(accountCapabilities({ password: true, google: false }, true), {
    changePassword: true,
    setPassword: false,
    changeEmail: true,
    linkGoogle: true,
    unlinkGoogle: false,
  });
});

// ─── passwords ───────────────────────────────────────────────────────────────

test('a new password needs 8 characters and a matching confirmation', () => {
  assert.equal(PASSWORD_MIN_LENGTH, 8);
  assert.equal(checkNewPassword('1234567', '1234567', null), 'password-too-short');
  assert.equal(checkNewPassword('12345678', '12345678', null), null);
  assert.equal(checkNewPassword('12345678', '12345679', null), 'password-mismatch');
  assert.equal(checkNewPassword('x'.repeat(4097), 'x'.repeat(4097), null), 'password-too-long');
});

test('a new password may not be the account email', () => {
  assert.equal(checkNewPassword('Luna@Example.com', 'Luna@Example.com', 'luna@example.com'), 'password-same-as-email');
});

// ─── browsers ────────────────────────────────────────────────────────────────

const UA = {
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 13; SM-A135M) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
  androidWebView:
    'Mozilla/5.0 (Linux; Android 13; SM-A135M Build/TP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.0.0 Mobile Safari/537.36',
  instagramAndroid:
    'Mozilla/5.0 (Linux; Android 13; SM-A135M Build/TP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.0.0 Mobile Safari/537.36 Instagram 345.0.0.0 Android',
  facebookIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0]',
  iosAppWebView:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  iosSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iosChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1',
  desktopChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
};

test('in-app browsers are flagged, where Google refuses to sign anyone in', () => {
  for (const name of ['androidWebView', 'instagramAndroid', 'facebookIos', 'iosAppWebView'] as const) {
    assert.equal(isEmbeddedBrowser(UA[name]), true, name);
  }
});

test('real browsers are not flagged', () => {
  for (const name of ['chromeAndroid', 'iosSafari', 'iosChrome', 'desktopChrome'] as const) {
    assert.equal(isEmbeddedBrowser(UA[name]), false, name);
  }
  assert.equal(isEmbeddedBrowser(''), false);
  assert.equal(isEmbeddedBrowser(null), false);
});
