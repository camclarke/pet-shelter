import test from 'node:test';
import assert from 'node:assert/strict';

import { actionCallbackUri, parseAuthAction } from '../auth-action';

const CODE = 'AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-abcdefghijklmnopq';

test('each supported mode parses with its one-time code', () => {
  for (const mode of ['resetPassword', 'verifyEmail', 'recoverEmail', 'verifyAndChangeEmail']) {
    assert.deepEqual(parseAuthAction(`?mode=${mode}&oobCode=${CODE}&apiKey=k&lang=es`), {
      ok: true,
      mode,
      oobCode: CODE,
    });
  }
});

test('a link missing its mode or code is refused before any request', () => {
  assert.deepEqual(parseAuthAction(''), { ok: false, reason: 'missing' });
  assert.deepEqual(parseAuthAction(`?oobCode=${CODE}`), { ok: false, reason: 'missing' });
  assert.deepEqual(parseAuthAction('?mode=verifyEmail'), { ok: false, reason: 'missing' });
});

test('a mode this site does not handle is refused, not passed to the SDK', () => {
  // Email-link sign-in and MFA revert are real Firebase modes this site never sends.
  assert.deepEqual(parseAuthAction(`?mode=signIn&oobCode=${CODE}`), { ok: false, reason: 'unsupported-mode' });
  assert.deepEqual(parseAuthAction(`?mode=revertSecondFactorAddition&oobCode=${CODE}`), {
    ok: false,
    reason: 'unsupported-mode',
  });
});

test('a code that does not look like one is refused', () => {
  assert.deepEqual(parseAuthAction('?mode=verifyEmail&oobCode=short'), { ok: false, reason: 'malformed-code' });
  assert.deepEqual(parseAuthAction(`?mode=verifyEmail&oobCode=${encodeURIComponent('<script>x</script>aaaaaaaa')}`), {
    ok: false,
    reason: 'malformed-code',
  });
  assert.deepEqual(parseAuthAction(`?mode=verifyEmail&oobCode=${'a'.repeat(513)}`), { ok: false, reason: 'malformed-code' });
});

test('the action URL is the site origin plus /account/action, over https only', () => {
  assert.equal(actionCallbackUri('https://wawitas.org'), 'https://wawitas.org/account/action');
  assert.equal(actionCallbackUri('https://wawitas.org/adopt?x=1'), 'https://wawitas.org/account/action');
  assert.throws(() => actionCallbackUri('http://wawitas.org'), /https/);
});
