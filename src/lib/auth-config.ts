/**
 * Identity Platform project settings, as PATCH bodies — PURE.
 *
 * `scripts/auth-config.mjs` is the only caller. It sends what these functions
 * build to `identitytoolkit.googleapis.com/admin/v2/projects/{id}/config`, then
 * reads the config back and checks every field it sent with `appliedFields()`.
 * Kept pure so the bodies, the update masks and the redaction are tested
 * without a network.
 *
 * ── Why a script and not Terraform ─────────────────────────────────────────
 * Two of these settings carry values that must never reach Terraform state,
 * which stores attributes in plaintext: the SMTP password (a Resend API key),
 * and — on every read of this endpoint — `signIn.hashConfig.signerKey`, the
 * key the project's password hashes are signed with. The rest travel with them
 * so there is one place that sets auth email and bot protection.
 *
 * ── What each setting does ─────────────────────────────────────────────────
 *   emailTemplatesPatch   Spanish subjects and bodies, and the action URL
 *                         pointed at /account/action on our own domain.
 *   smtpPatch             Send those emails through Resend, from wawitas.org.
 *   recaptchaPatch        reCAPTCHA Enterprise on sign-up, sign-in and
 *                         password reset. AUDIT first, ENFORCE once measured.
 *   passwordPolicyPatch   Minimum length, matching the client's own check.
 */

import { actionCallbackUri } from './auth-action';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './profile';

export interface EmailTemplateCopy {
  readonly subject: string;
  /** HTML. Must contain `%LINK%`; Identity Platform substitutes the action link. */
  readonly body: string;
}

/** Visitor-facing, so it lives in `src/i18n`; the shape lives here. */
export interface AuthEmailCopy {
  readonly senderDisplayName: string;
  /** Sent on sign-up and on "reenviar el correo". */
  readonly verifyEmail: EmailTemplateCopy;
  readonly resetPassword: EmailTemplateCopy;
  /** Sent to the OLD address after an email change, with a link to undo it. */
  readonly changeEmail: EmailTemplateCopy;
}

export type RecaptchaState = 'OFF' | 'AUDIT' | 'ENFORCE';

/**
 * Scores at or below this are blocked once the state is ENFORCE. Google's
 * documented starting point; move it only after reading the AUDIT metrics.
 */
export const RECAPTCHA_BLOCK_AT_OR_BELOW = 0.3;

/**
 * Resend's SMTP relay. Port 465 is implicit TLS, which Identity Platform calls
 * `SSL`; 587 would be `START_TLS`. The username is literally "resend" and the
 * password is an API key.
 */
export const RESEND_SMTP = {
  host: 'smtp.resend.com',
  port: 465,
  username: 'resend',
  securityMode: 'SSL',
} as const;

export interface ConfigPatch {
  body: Record<string, unknown>;
  updateMask: string[];
}

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Leaf paths of a body, the way the Admin SDK builds its own update masks:
 * objects are walked, arrays and scalars are leaves. A mask naming a whole
 * object would also CLEAR every sibling field this body does not mention.
 */
export function updateMaskFor(body: Json, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value) && Object.keys(value).length > 0) out.push(...updateMaskFor(value, path));
    else out.push(path);
  }
  return out;
}

function patch(body: Json): ConfigPatch {
  return { body, updateMask: updateMaskFor(body).sort() };
}

function mergeInto(target: Json, source: Json): Json {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    target[key] = isPlainObject(existing) && isPlainObject(value) ? mergeInto({ ...existing }, value) : value;
  }
  return target;
}

export function mergePatches(...patches: ConfigPatch[]): ConfigPatch {
  const body = patches.reduce<Json>((acc, p) => mergeInto(acc, p.body), {});
  return patch(body);
}

// ─── email ───────────────────────────────────────────────────────────────────

/** What is wrong with a set of templates, or [] when they can be sent. */
export function templateProblems(copy: AuthEmailCopy): string[] {
  const problems: string[] = [];
  const templates: [string, EmailTemplateCopy][] = [
    ['verifyEmail', copy.verifyEmail],
    ['resetPassword', copy.resetPassword],
    ['changeEmail', copy.changeEmail],
  ];
  for (const [name, template] of templates) {
    if (!template.subject.trim()) problems.push(`${name}: empty subject`);
    if (template.subject.length > 200) problems.push(`${name}: subject longer than 200 characters`);
    if (!template.body.includes('%LINK%')) problems.push(`${name}: body has no %LINK%`);
    if (/\bhttps?:\/\/[^\s"'<>]*firebaseapp\.com/i.test(template.body)) {
      problems.push(`${name}: body names firebaseapp.com`);
    }
  }
  if (!copy.changeEmail.body.includes('%NEW_EMAIL%')) problems.push('changeEmail: body has no %NEW_EMAIL%');
  if (!copy.senderDisplayName.trim()) problems.push('empty senderDisplayName');
  return problems;
}

function template(copy: EmailTemplateCopy, senderDisplayName: string): Json {
  return {
    subject: copy.subject,
    body: copy.body,
    bodyFormat: 'HTML',
    senderDisplayName,
  };
}

/**
 * Spanish templates, the default locale, and the action URL on our domain.
 *
 * ⚠️ Deploy `/account/action` BEFORE applying this. The action URL is baked
 * into every link sent from the moment this lands; links already in inboxes
 * keep their old URL and keep working.
 */
export function emailTemplatesPatch(input: { copy: AuthEmailCopy; siteUrl: string; locale: string }): ConfigPatch {
  const problems = templateProblems(input.copy);
  if (problems.length) throw new Error(`email templates are not sendable: ${problems.join('; ')}`);

  const language = input.locale.split('-')[0];
  if (!language) throw new Error(`no language in locale ${input.locale}`);

  const sender = input.copy.senderDisplayName;
  return patch({
    notification: {
      defaultLocale: language,
      sendEmail: {
        callbackUri: actionCallbackUri(input.siteUrl),
        verifyEmailTemplate: template(input.copy.verifyEmail, sender),
        resetPasswordTemplate: template(input.copy.resetPassword, sender),
        changeEmailTemplate: template(input.copy.changeEmail, sender),
      },
    },
  });
}

/** Why a sender address cannot be used for this site, or null. */
export function senderEmailProblem(senderEmail: string, siteUrl: string): string | null {
  const match = /^[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})$/.exec(senderEmail.trim());
  if (!match?.[1]) return `"${senderEmail}" is not an email address`;
  const host = new URL(siteUrl).hostname.replace(/^www\./, '');
  const domain = match[1].toLowerCase();
  if (domain !== host && !domain.endsWith(`.${host}`)) {
    return `the sender must be on ${host} (the domain verified at Resend), got ${domain}`;
  }
  return null;
}

/** Send every auth email through Resend. The password is a Resend API key. */
export function smtpPatch(input: { senderEmail: string; password: string; siteUrl: string }): ConfigPatch {
  const problem = senderEmailProblem(input.senderEmail, input.siteUrl);
  if (problem) throw new Error(problem);
  if (!/^re_[A-Za-z0-9_]{8,}$/.test(input.password.trim())) {
    throw new Error('the SMTP password does not look like a Resend API key (re_…)');
  }

  return patch({
    notification: {
      sendEmail: {
        method: 'CUSTOM_SMTP',
        smtp: {
          senderEmail: input.senderEmail.trim(),
          host: RESEND_SMTP.host,
          port: RESEND_SMTP.port,
          username: RESEND_SMTP.username,
          password: input.password.trim(),
          securityMode: RESEND_SMTP.securityMode,
        },
      },
    },
  });
}

/** Back to Firebase's own sender, e.g. if Resend is ever down for long. */
export function defaultSenderPatch(): ConfigPatch {
  return patch({ notification: { sendEmail: { method: 'DEFAULT' } } });
}

// ─── bot protection and passwords ────────────────────────────────────────────

export function recaptchaPatch(state: RecaptchaState): ConfigPatch {
  return patch({
    recaptchaConfig: {
      emailPasswordEnforcementState: state,
      managedRules: [{ endScore: RECAPTCHA_BLOCK_AT_OR_BELOW, action: 'BLOCK' }],
      useAccountDefender: false,
    },
  });
}

/**
 * The minimum length, enforced server-side. `forceUpgradeOnSignin: false`: an
 * existing account whose password predates the policy still signs in, and is
 * held to the new length only when it next changes its password.
 */
export function passwordPolicyPatch(minLength: number = PASSWORD_MIN_LENGTH): ConfigPatch {
  if (!Number.isInteger(minLength) || minLength < 6 || minLength > 30) {
    throw new Error(`minimum password length must be an integer from 6 to 30, got ${minLength}`);
  }
  return patch({
    passwordPolicyConfig: {
      passwordPolicyEnforcementState: 'ENFORCE',
      forceUpgradeOnSignin: false,
      passwordPolicyVersions: [
        {
          customStrengthOptions: {
            minPasswordLength: minLength,
            maxPasswordLength: PASSWORD_MAX_LENGTH,
            containsLowercaseCharacter: false,
            containsUppercaseCharacter: false,
            containsNumericCharacter: false,
            containsNonAlphanumericCharacter: false,
          },
        },
      ],
    },
  });
}

// ─── reading back ────────────────────────────────────────────────────────────

/**
 * Keys whose VALUE is a credential. Exact names, never a substring match: the
 * first version was `/password/i`, which also matched `resetPasswordTemplate`,
 * `passwordPolicyConfig` and `emailPasswordEnforcementState` — and redacted
 * the very fields a dry run exists to show. Caught by the first dry run
 * against the live project, 2026-09-15.
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'password',
  'signerKey',
  'saltSeparator',
  'secret',
  'clientSecret',
  'apiKey',
]);

/**
 * A copy safe to print. `signIn.hashConfig` is dropped whole — it holds the
 * signer key for every password hash in the project — and any key that looks
 * like a credential is replaced.
 */
export function redactConfig(config: unknown): unknown {
  const walk = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${i}]`));
    if (!isPlainObject(value)) return value;
    const out: Json = {};
    for (const [key, v] of Object.entries(value)) {
      const here = path ? `${path}.${key}` : key;
      if (here === 'signIn.hashConfig') continue;
      out[key] = SENSITIVE_KEYS.has(key) ? '[redacted]' : walk(v, here);
    }
    return out;
  };
  return walk(config, '');
}

function valueAt(config: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (isPlainObject(node) ? node[key] : undefined), config);
}

export interface AppliedField {
  path: string;
  ok: boolean;
  /** Absent for a sensitive path, which is never compared or printed. */
  sent?: unknown;
  got?: unknown;
}

/**
 * Did each field of a patch land? Compares by JSON, so a server that
 * normalises a value is reported rather than silently accepted. A sensitive
 * leaf is reported as ok when the server returns anything or nothing — it is
 * write-only by design, and comparing it would mean printing it.
 */
export function appliedFields(sent: ConfigPatch, readback: unknown): AppliedField[] {
  return sent.updateMask.map((path) => {
    const leaf = path.split('.').pop() ?? path;
    if (SENSITIVE_KEYS.has(leaf)) return { path, ok: true };
    const want = valueAt(sent.body, path);
    const got = valueAt(readback, path);
    return { path, ok: JSON.stringify(want) === JSON.stringify(got), sent: want, got };
  });
}
