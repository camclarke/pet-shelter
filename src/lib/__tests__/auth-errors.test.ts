import test from 'node:test';
import assert from 'node:assert/strict';

import { AuthFailure, CODE_TO_REASON, authCodeOf, isPopupDismissal, toAuthFailure } from '../auth-errors';
import { es } from '@/i18n/es';

const fb = (code: string) => Object.assign(new Error(code), { code });

test('wrong password and unknown account are ONE reason — enumeration protection', () => {
  for (const code of ['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-login-credentials']) {
    assert.equal(toAuthFailure(fb(code)).reason, 'invalid-credentials', code);
  }
});

test('every reCAPTCHA refusal reads as one captcha failure', () => {
  for (const code of [
    'auth/captcha-check-failed',
    'auth/invalid-recaptcha-token',
    'auth/missing-recaptcha-token',
    'auth/invalid-recaptcha-action',
    'auth/invalid-recaptcha-version',
    'auth/missing-recaptcha-version',
    'auth/recaptcha-not-enabled',
  ]) {
    assert.equal(toAuthFailure(fb(code)).reason, 'captcha-failed', code);
  }
});

test('the Google and sensitive-change codes map to their own reasons', () => {
  assert.equal(toAuthFailure(fb('auth/popup-blocked')).reason, 'popup-blocked');
  assert.equal(toAuthFailure(fb('auth/requires-recent-login')).reason, 'requires-recent-login');
  assert.equal(toAuthFailure(fb('auth/credential-already-in-use')).reason, 'credential-already-in-use');
  assert.equal(
    toAuthFailure(fb('auth/account-exists-with-different-credential')).reason,
    'account-exists-with-different-credential'
  );
  assert.equal(toAuthFailure(fb('auth/expired-action-code')).reason, 'action-code-expired');
  assert.equal(toAuthFailure(fb('auth/user-token-expired')).reason, 'session-expired');
});

test('an unknown code, or no code at all, is unknown — and keeps its cause', () => {
  const original = fb('auth/something-new');
  const failure = toAuthFailure(original);
  assert.equal(failure.reason, 'unknown');
  assert.equal(failure.cause, original);
  assert.equal(toAuthFailure('boom').reason, 'unknown');
  assert.equal(authCodeOf(null), '');
});

test('an AuthFailure passes through untouched', () => {
  const failure = new AuthFailure('missing-password');
  assert.equal(toAuthFailure(failure), failure);
});

test('closing the Google window is a dismissal, not a failure; a blocked popup is a failure', () => {
  assert.equal(isPopupDismissal(fb('auth/popup-closed-by-user')), true);
  assert.equal(isPopupDismissal(fb('auth/cancelled-popup-request')), true);
  assert.equal(isPopupDismissal(fb('auth/popup-blocked')), false);
  assert.equal(isPopupDismissal(new Error('x')), false);
});

test('every mapped reason has its own words, distinct from the unknown message', () => {
  const unknown = es.authError('unknown');
  for (const reason of new Set(Object.values(CODE_TO_REASON))) {
    const text = es.authError(reason);
    assert.ok(text.trim().length > 0, reason);
    assert.notEqual(text, unknown, `${reason} falls back to the unknown message`);
  }
});

test('the invalid-credentials message names neither the password nor the account', () => {
  const text = es.authError('invalid-credentials').toLowerCase();
  assert.equal(text.includes('contraseña incorrecta'), false);
  assert.equal(text.includes('no existe'), false);
});
