import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appliedFields,
  defaultSenderPatch,
  emailTemplatesPatch,
  mergePatches,
  passwordPolicyPatch,
  recaptchaPatch,
  redactConfig,
  senderEmailProblem,
  smtpPatch,
  templateProblems,
  updateMaskFor,
  type AuthEmailCopy,
} from '../auth-config';

const COPY: AuthEmailCopy = {
  senderDisplayName: 'Wawitas',
  verifyEmail: { subject: 'Confirma tu correo', body: '<p><a href="%LINK%">Confirmar</a></p>' },
  resetPassword: { subject: 'Cambia tu contraseña', body: '<p>%EMAIL% <a href="%LINK%">Cambiar</a></p>' },
  changeEmail: { subject: 'Cambió tu correo', body: '<p>%NEW_EMAIL% <a href="%LINK%">Deshacer</a></p>' },
};

const SITE = 'https://wawitas.org';
const KEY = 're_TestKey_0123456789abcdef';

// ─── masks ───────────────────────────────────────────────────────────────────

test('an update mask names leaves, so no sibling field is cleared by accident', () => {
  assert.deepEqual(updateMaskFor({ a: { b: 1, c: { d: 'x' } }, e: [1, 2], f: {} }), ['a.b', 'a.c.d', 'e', 'f']);
});

test('the template patch sets Spanish copy and the action URL, and never the sender method', () => {
  const p = emailTemplatesPatch({ copy: COPY, siteUrl: SITE, locale: 'es-BO' });
  assert.deepEqual(p.updateMask, [
    'notification.defaultLocale',
    'notification.sendEmail.callbackUri',
    'notification.sendEmail.changeEmailTemplate.body',
    'notification.sendEmail.changeEmailTemplate.bodyFormat',
    'notification.sendEmail.changeEmailTemplate.senderDisplayName',
    'notification.sendEmail.changeEmailTemplate.subject',
    'notification.sendEmail.resetPasswordTemplate.body',
    'notification.sendEmail.resetPasswordTemplate.bodyFormat',
    'notification.sendEmail.resetPasswordTemplate.senderDisplayName',
    'notification.sendEmail.resetPasswordTemplate.subject',
    'notification.sendEmail.verifyEmailTemplate.body',
    'notification.sendEmail.verifyEmailTemplate.bodyFormat',
    'notification.sendEmail.verifyEmailTemplate.senderDisplayName',
    'notification.sendEmail.verifyEmailTemplate.subject',
  ]);
  const body = p.body as { notification: { defaultLocale: string; sendEmail: { callbackUri: string } } };
  assert.equal(body.notification.defaultLocale, 'es');
  assert.equal(body.notification.sendEmail.callbackUri, 'https://wawitas.org/account/action');
});

test('templates without the placeholders Identity Platform needs are refused', () => {
  assert.deepEqual(templateProblems(COPY), []);
  const broken: AuthEmailCopy = {
    ...COPY,
    verifyEmail: { subject: 'x', body: '<p>no link</p>' },
    changeEmail: { subject: 'x', body: '<p>%LINK%</p>' },
  };
  assert.deepEqual(templateProblems(broken), ['verifyEmail: body has no %LINK%', 'changeEmail: body has no %NEW_EMAIL%']);
  assert.throws(() => emailTemplatesPatch({ copy: broken, siteUrl: SITE, locale: 'es' }), /not sendable/);
});

test('a template that still points at firebaseapp.com is refused', () => {
  const stale = { ...COPY, resetPassword: { subject: 'x', body: '<a href="https://wawitas.firebaseapp.com/__/auth/action">%LINK%</a>' } };
  assert.deepEqual(templateProblems(stale), ['resetPassword: body names firebaseapp.com']);
});

// ─── SMTP ────────────────────────────────────────────────────────────────────

test('SMTP goes to Resend over implicit TLS, from the site domain', () => {
  const p = smtpPatch({ senderEmail: 'no-responder@wawitas.org', password: KEY, siteUrl: SITE });
  assert.deepEqual(p.body, {
    notification: {
      sendEmail: {
        method: 'CUSTOM_SMTP',
        smtp: {
          senderEmail: 'no-responder@wawitas.org',
          host: 'smtp.resend.com',
          port: 465,
          username: 'resend',
          password: KEY,
          securityMode: 'SSL',
        },
      },
    },
  });
  assert.ok(p.updateMask.includes('notification.sendEmail.smtp.password'));
});

test('a sender off the verified domain, or a key that is not a Resend key, is refused', () => {
  assert.match(String(senderEmailProblem('hola@gmail.com', SITE)), /must be on wawitas\.org/);
  assert.equal(senderEmailProblem('hola@mail.wawitas.org', SITE), null, 'a subdomain is fine');
  assert.equal(senderEmailProblem('hola@www.wawitas.org', 'https://www.wawitas.org'), null);
  assert.match(String(senderEmailProblem('not an email', SITE)), /not an email/);
  assert.throws(() => smtpPatch({ senderEmail: 'a@wawitas.org', password: 'hunter2', siteUrl: SITE }), /Resend API key/);
});

test('switching back to Firebase’s sender touches only the method', () => {
  assert.deepEqual(defaultSenderPatch().updateMask, ['notification.sendEmail.method']);
});

// ─── reCAPTCHA and password policy ───────────────────────────────────────────

test('reCAPTCHA sets the email/password state with a BLOCK rule at 0.3', () => {
  const p = recaptchaPatch('AUDIT');
  assert.deepEqual(p.body, {
    recaptchaConfig: {
      emailPasswordEnforcementState: 'AUDIT',
      managedRules: [{ endScore: 0.3, action: 'BLOCK' }],
      useAccountDefender: false,
    },
  });
  assert.deepEqual(p.updateMask, [
    'recaptchaConfig.emailPasswordEnforcementState',
    'recaptchaConfig.managedRules',
    'recaptchaConfig.useAccountDefender',
  ]);
});

test('the password policy enforces the minimum without forcing existing accounts to change', () => {
  const p = passwordPolicyPatch(8);
  const config = (p.body as { passwordPolicyConfig: Record<string, unknown> }).passwordPolicyConfig;
  assert.equal(config.passwordPolicyEnforcementState, 'ENFORCE');
  assert.equal(config.forceUpgradeOnSignin, false);
  assert.deepEqual(config.passwordPolicyVersions, [
    {
      customStrengthOptions: {
        minPasswordLength: 8,
        maxPasswordLength: 4096,
        containsLowercaseCharacter: false,
        containsUppercaseCharacter: false,
        containsNumericCharacter: false,
        containsNonAlphanumericCharacter: false,
      },
    },
  ]);
  for (const bad of [5, 31, 8.5]) assert.throws(() => passwordPolicyPatch(bad), /6 to 30/);
});

test('patches merge deeply, so templates and SMTP can travel in one request', () => {
  const merged = mergePatches(
    emailTemplatesPatch({ copy: COPY, siteUrl: SITE, locale: 'es' }),
    smtpPatch({ senderEmail: 'no-responder@wawitas.org', password: KEY, siteUrl: SITE }),
    recaptchaPatch('ENFORCE')
  );
  assert.ok(merged.updateMask.includes('notification.sendEmail.callbackUri'));
  assert.ok(merged.updateMask.includes('notification.sendEmail.smtp.host'));
  assert.ok(merged.updateMask.includes('recaptchaConfig.emailPasswordEnforcementState'));
  assert.deepEqual([...merged.updateMask].sort(), merged.updateMask, 'sorted');
  assert.equal(new Set(merged.updateMask).size, merged.updateMask.length, 'no duplicates');
});

// ─── reading back ────────────────────────────────────────────────────────────

test('a printed config never carries the hash signer key or the SMTP password', () => {
  const live = {
    signIn: { email: { enabled: true }, hashConfig: { algorithm: 'SCRYPT', signerKey: 'SIGNER', saltSeparator: 'SALT' } },
    notification: { sendEmail: { method: 'CUSTOM_SMTP', smtp: { host: 'smtp.resend.com', password: KEY } } },
    list: [{ apiKey: 'k1' }],
  };
  const printed = JSON.stringify(redactConfig(live));
  for (const secret of ['SIGNER', 'SALT', KEY, 'k1', 'hashConfig']) {
    assert.equal(printed.includes(secret), false, `${secret} leaked`);
  }
  assert.ok(printed.includes('smtp.resend.com'), 'ordinary fields survive');
  assert.ok(printed.includes('"enabled":true'));
});

test('redaction matches credential KEYS exactly, not every key containing "password"', () => {
  // Regression: `/password/i` redacted all three of these on the first dry run.
  const live = {
    notification: { sendEmail: { resetPasswordTemplate: { subject: 'Reset your password' } } },
    passwordPolicyConfig: { passwordPolicyEnforcementState: 'ENFORCE' },
    recaptchaConfig: { emailPasswordEnforcementState: 'AUDIT' },
  };
  assert.deepEqual(redactConfig(live), live);
});

test('readback compares every sent leaf, and reports a normalised value as NOT applied', () => {
  const sent = recaptchaPatch('AUDIT');
  const same = appliedFields(sent, sent.body);
  assert.ok(same.every((f) => f.ok));

  const drifted = appliedFields(sent, {
    recaptchaConfig: { emailPasswordEnforcementState: 'OFF', managedRules: [{ endScore: 0.3, action: 'BLOCK' }] },
  });
  assert.deepEqual(
    drifted.filter((f) => !f.ok).map((f) => f.path),
    ['recaptchaConfig.emailPasswordEnforcementState', 'recaptchaConfig.useAccountDefender']
  );
});

test('readback never compares or returns the SMTP password', () => {
  const sent = smtpPatch({ senderEmail: 'no-responder@wawitas.org', password: KEY, siteUrl: SITE });
  const fields = appliedFields(sent, { notification: { sendEmail: { smtp: {} } } });
  const password = fields.find((f) => f.path === 'notification.sendEmail.smtp.password');
  assert.deepEqual(password, { path: 'notification.sendEmail.smtp.password', ok: true });
  assert.equal(JSON.stringify(fields).includes(KEY), false);
});
