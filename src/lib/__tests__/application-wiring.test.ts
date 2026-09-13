/**
 * SOURCE-LEVEL guards on the wiring, for the things a pure test cannot see.
 *
 * There is no component-test setup in this repo, and every screen here is
 * either behind `AdminGate` (a human password) or behind the public switch that
 * ships OFF. So reading the source is the only check available on the two
 * properties that matter most and that a refactor could silently break:
 *
 *   1. the WhatsApp button on the dossier stays PRIMARY and in front — plan §6's
 *      design rule, that the account requirement never moves before it;
 *   2. the approval screen commits what the tested builder returns, in one batch.
 *
 * Deliberately crude, and honest about it: these assert that code EXISTS in a
 * given order, not that it renders. The same shape as the wizard guard in
 * i18n-es.test.ts, which exists because PR #26 shipped a value computed and
 * never delivered with every test green.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function source(...segments: string[]): string {
  return readFileSync(join(process.cwd(), 'src', ...segments), 'utf8');
}

const DOSSIER = source('app', 'adopt', '[slug]', 'page.tsx');
const APPLY = source('app', 'adopt', '[slug]', 'apply', 'page.tsx');

test('the dossier WhatsApp CTA is intact and unchanged', () => {
  // The exact markup the conversion runs through. If this test has to change,
  // the change is to the primary objective and needs saying out loud.
  assert.ok(DOSSIER.includes('href={whatsappLink(SHELTER.whatsapp, t.adoptionInquiry(pet.name))}'));
  assert.ok(DOSSIER.includes('className="btn btn--action dossier__cta"'));
  assert.ok(DOSSIER.includes('Adóptame ↗'));
});

test('the application link comes AFTER the WhatsApp button, never before it', () => {
  const cta = DOSSIER.indexOf('dossier__cta');
  const apply = DOSSIER.indexOf('/apply`}');
  assert.ok(cta > 0, 'no WhatsApp CTA on the dossier');
  assert.ok(apply > 0, 'no application link on the dossier');
  assert.ok(apply > cta, 'the application link has moved in front of the WhatsApp button');
});

test('the application link is a quiet text link, not a second button', () => {
  const block = DOSSIER.slice(DOSSIER.indexOf('dossier__apply'), DOSSIER.indexOf('</p>', DOSSIER.indexOf('dossier__apply')));
  assert.ok(block.includes('className="auth__link"'), 'the link lost its text-link class');
  assert.ok(!/className="btn/.test(block), 'the application link is styled as a button');
});

test('the dossier only links to the form when it is switched on and the animal is on the wall', () => {
  assert.ok(DOSSIER.includes("SHELTER.adoptionApplications.enabled && pet.status === 'available'"));
});

test('the apply page renders WhatsApp before the form, 404s while switched off, and is noindex', () => {
  const whatsapp = APPLY.indexOf('whatsappLink(');
  const form = APPLY.indexOf('<ApplicationForm');
  assert.ok(whatsapp > 0 && form > 0 && whatsapp < form, 'WhatsApp is no longer ahead of the form');
  assert.ok(/if \(!config\.enabled\) notFound\(\);/.test(APPLY), 'the page no longer 404s while switched off');
  assert.ok(APPLY.includes('index: false'), 'the apply page can be indexed');
});

test('sign-in only returns a visitor through the allowlist', () => {
  const panel = source('app', 'account', 'AccountPanel.tsx');
  assert.ok(panel.includes("safeReturnPath(new URLSearchParams(window.location.search).get('next'))"));
  // Every navigation after sign-in goes to the checked value and nowhere else.
  const replaces = [...panel.matchAll(/router\.replace\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(replaces.length > 0);
  assert.ok(replaces.every((arg) => arg === 'returnTo'), `unexpected redirect target: ${replaces.join(', ')}`);

  const form = source('app', 'adopt', '[slug]', 'apply', 'ApplicationForm.tsx');
  assert.ok(form.includes('signInHrefReturningTo('), 'the form builds its own sign-in link');
});

test('approval commits the tested builder, in one batch', () => {
  const admin = source('lib', 'applications-admin.ts');
  const body = admin.slice(admin.indexOf('export async function approveApplication'));
  assert.ok(body.includes('buildApprovalWrites('), 'approval no longer uses the tested builder');
  assert.equal((body.match(/writeBatch\(/g) ?? []).length, 1, 'approval is not exactly one batch');
  assert.equal((body.match(/\.commit\(\)/g) ?? []).length, 1);
});

test('no new application code logs an answer or a draft', () => {
  // A private person's household. Errors are logged by Firestore code only.
  const files = [
    source('lib', 'applications-client.ts'),
    source('lib', 'applications-admin.ts'),
    source('app', 'adopt', '[slug]', 'apply', 'ApplicationForm.tsx'),
    source('app', 'account', 'MyApplications.tsx'),
    source('app', 'admin', 'applications', 'ApplicationsQueue.tsx'),
    source('app', 'admin', 'applications', '[applicationId]', 'ApplicationReview.tsx'),
  ];
  for (const file of files) {
    // Calls only. `includes('console.')` also matched the prose "the admin
    // console." in a header comment — a probe error, found on its first run.
    for (const line of file.split('\n').filter((l) => /console\.(error|warn|log|info|debug)\(/.test(l))) {
      // Only the ARGUMENTS after the message string are payload. The message
      // itself may say "could not save notes"; the first version of this test
      // failed on exactly that, which is a false positive, not a leak.
      const messageEnd = line.indexOf("',");
      assert.ok(messageEnd > 0, `a console call without a leading message string: ${line.trim()}`);
      const logged = line.slice(messageEnd + 2);
      assert.ok(!/answers|draft|notes|validation|payload|data\b/.test(logged), `logs a payload: ${line.trim()}`);
      // A raw error object is not logged either — only its Firestore code.
      assert.ok(!/^\s*caught\s*\)/.test(logged), `logs a raw error: ${line.trim()}`);
    }
  }
});
