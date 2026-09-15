import test from 'node:test';
import assert from 'node:assert/strict';

import { es } from '@/i18n/es';
import { templateProblems } from '../auth-config';
import { CODE_TO_REASON } from '../auth-errors';
import { findVoseo } from '../ai/spanish-register';

/**
 * The account copy is neutral Spanish, and the sentences that carry a
 * security or honesty promise say what they must.
 *
 * ⚠️ `findVoseo` is a tripwire over known forms, not a parser: an empty result
 * means none of the forms it knows, not "this is tuteo". It is here because
 * #31 converted the site to tuteo and six voseo forms survived in a prompt
 * anyway (2026-09-12).
 */

const SHELTER_NAME = 'Wawitas Red de Apoyo';
const SITE = 'https://wawitas.org';

/** Every string the account copy can produce, with sample arguments. */
function accountStrings(): string[] {
  const out: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === 'string') out.push(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  const a = es.account;
  for (const value of Object.values(a)) if (typeof value !== 'function') visit(value);

  out.push(
    a.passwordHint(8),
    a.googleConnected('luna@gmail.com'),
    a.googleConnected(null),
    a.emailChangeSent('nuevo@example.com'),
    a.newPasswordFor('luna@example.com'),
    a.emailRecovered('luna@example.com'),
    a.emailRecovered(null),
    a.resetLinkSentTo('luna@example.com'),
    a.emailChanged('nuevo@example.com'),
    a.emailChanged(null),
    a.profileError('display-name-empty', 60),
    a.profileError('display-name-too-long', 60)
  );
  for (const failure of ['unauthenticated', 'admin-account', 'requires-recent-login', 'delete-failed', 'unexpected', 'network'] as const) {
    out.push(a.deleteError(failure));
  }
  for (const error of ['password-too-short', 'password-too-long', 'password-mismatch', 'password-same-as-email'] as const) {
    out.push(a.newPasswordError(error, 8));
  }
  for (const reason of new Set([...Object.values(CODE_TO_REASON), 'unknown' as const])) {
    out.push(es.authError(reason));
  }
  return out;
}

const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ');

test('no account string uses voseo', () => {
  const strings = accountStrings();
  assert.ok(strings.length > 100, `only ${strings.length} strings — is the walk broken?`);
  for (const text of strings) {
    assert.deepEqual(findVoseo(text), [], text);
  }
});

test('the tripwire itself fires on a voseo sentence (so the zero above means something)', () => {
  assert.notDeepEqual(findVoseo('Escribí tu correo y revisá la carpeta de spam.'), []);
});

test('the reset notice is a CONDITION, never a confirmation — enumeration protection', () => {
  const text = es.account.resetSent;
  assert.match(text, /^Si existe una cuenta/);
  assert.equal(/te enviamos/i.test(text), false);
});

test('deleting an account says, before confirming, that applications stay with the shelter', () => {
  assert.match(es.account.deleteIntro, /solicitudes de adopción/);
  assert.match(es.account.deleteIntro, /registros del refugio/);
});

test('the password copy states the same minimum the client enforces', () => {
  assert.match(es.authError('weak-password'), /\b8 caracteres/);
  assert.equal(es.account.passwordHint(8), 'Mínimo 8 caracteres.');
});

test('the Spanish emails are sendable, in tuteo, and link only to the site', () => {
  const emails = es.authEmails(SHELTER_NAME, SITE);
  assert.deepEqual(templateProblems(emails), []);

  for (const template of [emails.verifyEmail, emails.resetPassword, emails.changeEmail]) {
    assert.deepEqual(findVoseo(template.subject), [], template.subject);
    assert.deepEqual(findVoseo(textOf(template.body)), [], template.subject);
    // The button and the copyable fallback both carry the link.
    assert.equal(template.body.split('%LINK%').length - 1, 2, template.subject);
    const hrefs = [...template.body.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(hrefs)].sort(), ['%LINK%', SITE].sort(), template.subject);
    assert.equal(template.body.includes('http://'), false);
  }
  assert.match(emails.resetPassword.body, /%EMAIL%/);
  assert.match(emails.changeEmail.body, /%NEW_EMAIL%/);
});

test('the reset email names no expiry it cannot guarantee', () => {
  const body = textOf(es.authEmails(SHELTER_NAME, SITE).resetPassword.body);
  assert.equal(/\b(una hora|\d+\s*(minutos|horas))\b/i.test(body), false);
});

test('a shelter name is escaped in the HTML but not in the subject', () => {
  const emails = es.authEmails('Patitas <Sur> & Co', SITE);
  assert.ok(emails.verifyEmail.body.includes('Patitas &#60;Sur&#62; &#38; Co'));
  assert.equal(emails.verifyEmail.body.includes('<Sur>'), false);
  assert.equal(emails.verifyEmail.subject, 'Confirma tu correo en Patitas <Sur> & Co');
});
