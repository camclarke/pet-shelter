import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AVATAR_FILE_NAME, avatarStoragePath, safeAvatarUrl } from '../profile';

/**
 * Source-level guards on the account feature: couplings between files that
 * no type can express, and the two rules that break silently — the avatar
 * allowlist and the popup-before-await rule.
 *
 * Source-text checks can be evaded by indirection. They exist to catch the
 * edit that forgets, not the one that tries.
 */

const ROOT = process.cwd();
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

/** Source with comments removed, so a comment saying "await" cannot trip or satisfy a check. */
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function usersBlock(): string {
  const rules = read('firestore.rules');
  const start = rules.indexOf('match /users/{uid} {');
  assert.ok(start >= 0, 'firestore.rules has no users/{uid} block');
  const end = rules.indexOf('allow delete: if isAdmin();', start);
  assert.ok(end > start, 'could not find the end of the users/{uid} block');
  return rules.slice(start, end);
}

/** The two `photoURL.matches('…')` patterns, turned back into JS RegExps for a uid. */
function rulesPhotoPatterns(uid: string): RegExp[] {
  const block = usersBlock();
  const google = /data\.photoURL\.matches\('([^']+)'\)/.exec(block)?.[1];
  const storage = /data\.photoURL\.matches\('([^']+)' \+ uid \+ '([^']+)'\)/.exec(block);
  assert.ok(google, 'the Google photo pattern moved');
  assert.ok(storage?.[1] && storage[2], 'the storage photo pattern moved');
  // Rules `matches` is a whole-string match; the patterns are anchored anyway.
  return [new RegExp(google), new RegExp(storage[1] + uid + storage[2])];
}

const UID = 'ProbeUid42';
const storageUrl = (encodedPath: string) =>
  `https://firebasestorage.googleapis.com/v0/b/wawitas-app/o/${encodedPath}?alt=media&token=abc`;

const CANDIDATES = [
  'https://lh3.googleusercontent.com/a/ACg8ocK=s96-c',
  'https://lh6.googleusercontent.com/a-/x',
  'https://lh7.googleusercontent.com/a/x',
  'http://lh3.googleusercontent.com/a/x',
  'https://lh3.googleusercontent.com.evil.example/a',
  storageUrl(`users%2F${UID}%2Favatar%2F1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed.jpg`),
  `https://firebasestorage.googleapis.com/v0/b/wawitas-app/o/users%2F${UID}%2Favatar%2Fabc.jpg`,
  storageUrl('users%2FSomeoneElse%2Favatar%2Fabc.jpg'),
  storageUrl(`users%2F${UID}%2Favatar%2Fabc.png`),
  storageUrl(`users%2F${UID}%2Favatar%2F..%2F..%2Fpets%2Fx%2Fcover.jpg`),
  storageUrl(`users%2F${UID}%2Favatar%2Fsub%2Fabc.jpg`),
  storageUrl('pets%2Fx%2Fcover.jpg'),
  `https://firebasestorage.googleapis.com/v0/b/wawitas-app/o/users/${UID}/avatar/abc.jpg`,
  'https://tracker.example/pixel.gif',
];

test('firestore.rules and safeAvatarUrl accept EXACTLY the same photo URLs', () => {
  const patterns = rulesPhotoPatterns(UID);
  let accepted = 0;
  for (const url of CANDIDATES) {
    const rules = url.length <= 2048 && patterns.some((p) => p.test(url));
    const client = safeAvatarUrl(url, UID) !== null;
    assert.equal(client, rules, `disagree on ${url}: rules ${rules}, safeAvatarUrl ${client}`);
    if (rules) accepted++;
  }
  // A probe that accepts nothing (or everything) proves nothing.
  assert.ok(accepted >= 3 && accepted < CANDIDATES.length, `accepted ${accepted} of ${CANDIDATES.length}`);
});

test('the rules cap names at 60 and photo URLs at 2048, like profile.ts', () => {
  const block = usersBlock();
  assert.match(block, /data\.displayName\.size\(\) <= 60\b/);
  assert.match(block, /data\.photoURL\.size\(\) <= 2048\b/);
});

test('the profile the client creates has exactly the keys the create rule allows', () => {
  const allowed = /allow create:[\s\S]*?hasOnly\(\s*\[([^\]]+)\]\)/.exec(usersBlock())?.[1];
  assert.ok(allowed, 'create hasOnly list not found');
  const ruleKeys = [...allowed.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();

  const auth = read('src/lib/auth.ts');
  const start = auth.indexOf('await setDoc(profileRef, {');
  assert.ok(start >= 0, 'ensureProfile no longer creates with setDoc(profileRef, {');
  const literal = auth.slice(start, auth.indexOf('});', start));
  const clientKeys = [...literal.matchAll(/^\s+(\w+)[:,]/gm)].map((m) => m[1]).sort();

  assert.deepEqual(clientKeys, ruleKeys);
});

test('the update rule allows only the fields the client heals or edits', () => {
  const update = /allow update:[\s\S]*?hasOnly\(\[([^\]]+)\]\)/.exec(usersBlock())?.[1];
  assert.ok(update, 'update hasOnly list not found');
  assert.deepEqual([...update.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort(), ['displayName', 'email', 'photoURL']);
});

test('storage.rules and profile.ts agree on the avatar object name', () => {
  const storage = read('storage.rules');
  const block = storage.slice(storage.indexOf('match /users/{uid}/avatar/{fileName} {'));
  const pattern = /fileName\.matches\('([^']+)'\)/.exec(block)?.[1];
  assert.ok(pattern, 'the avatar file name pattern moved');
  const rules = new RegExp(pattern);

  for (const name of ['1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed.jpg', 'a.jpg', 'a.png', 'a b.jpg', '.jpg', `${'a'.repeat(65)}.jpg`]) {
    assert.equal(AVATAR_FILE_NAME.test(name), rules.test(name), name);
  }
  // And the path the client writes is the path the rule matches.
  assert.match(avatarStoragePath(UID, 'abc-1'), /^users\/[^/]+\/avatar\/[^/]+$/);
  assert.match(block, /request\.resource\.contentType == 'image\/jpeg'/);
});

// ─── the popup rule ──────────────────────────────────────────────────────────

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`unterminated ${signature}`);
}

test('every popup opens before the first await in its function (Safari blocks it otherwise)', () => {
  const auth = withoutComments(read('src/lib/auth.ts'));
  const firstAwait = (signature: string) => {
    const body = functionBody(auth, signature);
    return /await\s+([\w.]+)\(/.exec(body)?.[1];
  };
  assert.equal(firstAwait('export async function signInWithGoogle('), 'signInWithPopup');
  assert.equal(firstAwait('export async function linkGoogle('), 'linkWithPopup');
  assert.equal(firstAwait('export async function reauthenticate('), 'reauthenticateWithPopup');
  assert.equal(firstAwait('export async function deleteAccount('), 'reauthenticate');
});

test('the Google button handler starts sign-in without awaiting anything first', () => {
  const panel = withoutComments(read('src/app/account/AccountPanel.tsx'));
  const body = functionBody(panel, 'function handleGoogle(');
  assert.equal(body.includes('await'), false);
  assert.ok(body.includes('signInWithGoogle()'));
});

test('AccountSettings calls each action synchronously inside run()', () => {
  const settings = withoutComments(read('src/app/account/AccountSettings.tsx'));
  const body = functionBody(settings, 'function run(');
  const call = body.indexOf('pending = action();');
  assert.ok(call >= 0, 'run() no longer calls the action directly');
  assert.equal(body.slice(0, call).includes('await'), false, 'an await before the action would break popups');
});

// ─── smaller couplings ───────────────────────────────────────────────────────

test('the header account link does not pull the Spanish catalogue into the homepage bundle', () => {
  const link = read('src/components/AccountLink.tsx');
  assert.equal(/from '@\/i18n/.test(link), false);
  assert.equal(/from '@\/lib\/auth'/.test(link), false, 'auth.ts would bring the Firebase SDK');
});

test('the email link page strips the one-time code and runs once', () => {
  const handler = read('src/app/account/action/ActionHandler.tsx');
  assert.ok(handler.includes('window.history.replaceState('), 'the code must be removed from the address bar');
  assert.ok(handler.includes('if (started.current) return;'), 'StrictMode would spend the code twice');
  assert.equal(/from '@\/lib\/auth'/.test(handler), false, 'auth.ts would bring the profile, photo and deletion code to this page');
  const page = read('src/app/account/action/page.tsx');
  assert.match(page, /referrer: 'no-referrer'/);
  assert.match(page, /export const revalidate = 300;/);
});

test('the reCAPTCHA badge is hidden only while the sign-in form carries Google’s attribution', () => {
  const css = read('src/app/globals.css');
  const panel = read('src/app/account/AccountPanel.tsx');
  if (/\.grecaptcha-badge\s*\{[^}]*visibility:\s*hidden/.test(css)) {
    assert.ok(panel.includes('https://policies.google.com/privacy'), 'badge hidden without the privacy link');
    assert.ok(panel.includes('https://policies.google.com/terms'), 'badge hidden without the terms link');
  }
});
