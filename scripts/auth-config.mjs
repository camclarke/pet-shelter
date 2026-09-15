/**
 * Apply the account settings to Identity Platform, then prove they landed.
 *
 *   npm run auth:config                                   DRY RUN: show the current state
 *   npm run auth:config -- --emails --password-policy     DRY RUN: show what would change
 *   npm run auth:config -- --emails --password-policy --apply
 *   npm run auth:config -- --recaptcha audit --apply
 *   npm run auth:config -- --smtp --sender no-reply@wawitas.org --apply
 *   npm run auth:config -- --default-sender --apply       back to Firebase's own sender
 *
 * Flags, combinable:
 *   --emails             Spanish templates, default locale, and the action URL
 *                        pointed at SHELTER.siteUrl + /account/action.
 *   --password-policy    Minimum 8 characters, server-side.
 *   --recaptcha <state>  off | audit | enforce, for sign-up, sign-in and reset.
 *   --smtp               Send through Resend. Reads the Resend API key from
 *                        STDIN, so it is never in argv or shell history.
 *   --sender <address>   The From address for --smtp. Must be on the site domain.
 *   --default-sender     Stop using SMTP.
 *   --apply              Write. Without it nothing is sent.
 *   --skip-deploy-check  Apply --emails even if /account/action is not live.
 *   --project <id>       Defaults to GOOGLE_CLOUD_PROJECT.
 *
 * ── What it never prints ──────────────────────────────────────────────────
 * The config endpoint returns `signIn.hashConfig.signerKey` — the key the
 * project's password hashes are signed with — on every read. `redactConfig()`
 * drops it before anything is shown, along with any SMTP password.
 *
 * ── Why the deploy check ──────────────────────────────────────────────────
 * `--emails` bakes the action URL into every email sent from that moment. If
 * /account/action is not deployed yet, every verification and reset link 404s.
 * So the script fetches it first and refuses unless it answers 200.
 *
 * ── Identity ──────────────────────────────────────────────────────────────
 * Uses Application Default Credentials, and prints WHOSE before writing — this
 * machine holds two Google identities and ADC has pointed at the wrong one
 * before. Every call carries `x-goog-user-project`; without it a user
 * credential gets a 403 that looks like a permissions problem and is not.
 */

import { execSync } from 'node:child_process';
import process from 'node:process';

import { es } from '../src/i18n/es.ts';
import { SHELTER } from '../src/config/shelter.ts';
import {
  appliedFields,
  defaultSenderPatch,
  emailTemplatesPatch,
  mergePatches,
  passwordPolicyPatch,
  recaptchaPatch,
  redactConfig,
  smtpPatch,
} from '../src/lib/auth-config.ts';
import { actionCallbackUri } from '../src/lib/auth-action.ts';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const known = new Set([
    '--emails',
    '--password-policy',
    '--recaptcha',
    '--smtp',
    '--sender',
    '--default-sender',
    '--apply',
    '--skip-deploy-check',
    '--project',
  ]);
  const withValue = new Set(['--recaptcha', '--sender', '--project']);
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!known.has(flag)) fail(`Unknown argument ${flag}. See the header of scripts/auth-config.mjs.`);
    if (withValue.has(flag)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) fail(`${flag} needs a value.`);
      out[flag] = value;
    } else {
      out[flag] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const PROJECT = args['--project'] ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
if (!PROJECT) fail('Set GOOGLE_CLOUD_PROJECT or pass --project <id>.');

const API = `https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config`;

function adcToken() {
  try {
    return execSync('gcloud auth application-default print-access-token', { encoding: 'utf8' }).trim();
  } catch {
    fail('No Application Default Credentials. Run: gcloud auth application-default login');
  }
}

const token = adcToken();
const headers = {
  Authorization: `Bearer ${token}`,
  'x-goog-user-project': PROJECT,
  'Content-Type': 'application/json',
};

async function call(method, url, body) {
  const response = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  if (!response.ok) {
    const message = json?.error?.message ?? text.slice(0, 500);
    const err = new Error(`${method} ${url.split('?')[0]} → ${response.status}: ${message}`);
    err.status = response.status;
    throw err;
  }
  return json;
}

async function readStdin() {
  if (process.stdin.isTTY) {
    console.log('\n  Paste the Resend API key, then press Enter and Ctrl-D (Ctrl-Z then Enter on Windows).');
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function valueAt(node, path) {
  return path.split('.').reduce((n, key) => (n && typeof n === 'object' ? n[key] : undefined), node);
}

function show(value) {
  if (value === undefined) return '(unset)';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 90 ? `${text.slice(0, 87)}…` : text;
}

// ── who, and what is there now ──────────────────────────────────────────────

const who = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
  headers: { Authorization: `Bearer ${token}` },
})
  .then((r) => (r.ok ? r.json() : {}))
  .catch(() => ({}));
console.log(`\n  project   ${PROJECT}`);
console.log(`  identity  ${who.email ?? '(could not read — check ADC before --apply)'}`);

const before = redactConfig(await call('GET', API));
console.log('\n  current');
for (const path of [
  'notification.sendEmail.method',
  'notification.sendEmail.smtp.senderEmail',
  'notification.sendEmail.smtp.host',
  'notification.sendEmail.callbackUri',
  'notification.defaultLocale',
  'notification.sendEmail.verifyEmailTemplate.subject',
  'notification.sendEmail.resetPasswordTemplate.subject',
  'notification.sendEmail.changeEmailTemplate.subject',
  'recaptchaConfig.emailPasswordEnforcementState',
  'passwordPolicyConfig.passwordPolicyEnforcementState',
  'passwordPolicyConfig.passwordPolicyVersions',
  'signIn.email.enabled',
]) {
  console.log(`    ${path.padEnd(56)} ${show(valueAt(before, path))}`);
}

// ── what to change ──────────────────────────────────────────────────────────

if (args['--smtp'] && args['--default-sender']) fail('--smtp and --default-sender contradict each other.');
if (args['--sender'] && !args['--smtp']) fail('--sender only means something with --smtp.');

const patches = [];
if (args['--emails']) {
  patches.push(
    emailTemplatesPatch({
      copy: es.authEmails(SHELTER.name, SHELTER.siteUrl),
      siteUrl: SHELTER.siteUrl,
      locale: SHELTER.locale,
    })
  );
}
if (args['--password-policy']) patches.push(passwordPolicyPatch());
if (args['--recaptcha']) {
  const state = String(args['--recaptcha']).toUpperCase();
  if (!['OFF', 'AUDIT', 'ENFORCE'].includes(state)) fail('--recaptcha must be off, audit or enforce.');
  patches.push(recaptchaPatch(state));
}
if (args['--default-sender']) patches.push(defaultSenderPatch());
if (args['--smtp']) {
  if (!args['--sender']) fail('--smtp needs --sender <address on the site domain>.');
  const password = await readStdin();
  if (!password) fail('No API key on stdin.');
  try {
    patches.push(smtpPatch({ senderEmail: args['--sender'], password, siteUrl: SHELTER.siteUrl }));
  } catch (error) {
    fail(error.message);
  }
}

if (patches.length === 0) {
  console.log('\n  Nothing requested. Add --emails, --password-policy, --recaptcha, --smtp or --default-sender.\n');
  process.exit(0);
}

const patch = mergePatches(...patches);
const planned = redactConfig(patch.body);
console.log('\n  would set');
for (const path of patch.updateMask) {
  console.log(`    ${path.padEnd(56)} ${show(valueAt(before, path))}  →  ${show(valueAt(planned, path))}`);
}

if (!args['--apply']) {
  console.log('\n  DRY RUN — nothing was sent. Add --apply to write.\n');
  process.exit(0);
}

if (args['--emails'] && !args['--skip-deploy-check']) {
  const handler = actionCallbackUri(SHELTER.siteUrl);
  const status = await fetch(handler, { redirect: 'manual' })
    .then((r) => r.status)
    .catch(() => 0);
  if (status !== 200) {
    fail(
      `${handler} answered ${status || 'nothing'}. Every email link will point there — deploy it first ` +
        '(or pass --skip-deploy-check if you know why).'
    );
  }
  console.log(`\n  ${handler} answers 200 — safe to point emails at it.`);
}

// ── write, then read back ───────────────────────────────────────────────────

try {
  await call('PATCH', `${API}?updateMask=${encodeURIComponent(patch.updateMask.join(','))}`, patch.body);
} catch (error) {
  console.error(`\n  ✗ ${error.message}`);
  if (args['--recaptcha'] && error.status === 403) {
    console.error(
      '\n  reCAPTCHA needs Identity Platform\'s service agent. Once per project:\n' +
        `    gcloud beta services identity create --service=identitytoolkit.googleapis.com --project=${PROJECT}\n` +
        '  then grant it roles/identitytoolkit.serviceAgent (see docs/account-and-email-setup.md).'
    );
  }
  process.exit(1);
}

const after = await call('GET', API);
const results = appliedFields(patch, after);
console.log('\n  read back');
for (const field of results) {
  const detail = field.ok || !('sent' in field) ? '' : `   sent ${show(field.sent)}  got ${show(field.got)}`;
  console.log(`    ${field.ok ? 'PASS' : 'FAIL'}  ${field.path}${detail}`);
}
for (const name of ['verifyEmailTemplate', 'resetPasswordTemplate', 'changeEmailTemplate']) {
  const customized = valueAt(after, `notification.sendEmail.${name}.customized`);
  if (args['--emails']) console.log(`    info  ${name}.customized = ${String(customized)}`);
}

const failed = results.filter((f) => !f.ok).length;
console.log(`\n  ${results.length - failed}/${results.length} fields read back as sent\n`);
process.exit(failed === 0 ? 0 : 1);
