/**
 * SOURCE-LEVEL guards on the wiring, for the things a pure test cannot see.
 *
 * There is no component-test setup in this repo, and every screen here is
 * either behind `AdminGate` (a human password) or behind the public switch that
 * ships OFF. So reading the source is the only check available on the two
 * properties that matter most and that a refactor could silently break:
 *
 *   1. the dossier's adopt button leads to the application (account first) with
 *      WhatsApp as a secondary link — the owner's 2026-10-21 decision, plan §6;
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

import { payloadLoggingProblems, stripComments } from './no-payload-logging';

function source(...segments: string[]): string {
  return readFileSync(join(process.cwd(), 'src', ...segments), 'utf8');
}

const DOSSIER = source('app', 'adopt', '[slug]', 'page.tsx');
const APPLY = source('app', 'adopt', '[slug]', 'apply', 'page.tsx');

test('the dossier adopt button leads to the application, with WhatsApp as a small link after it', () => {
  // Owner decision 2026-10-21 (reversing "WhatsApp primary"): choosing to adopt
  // leads to an account and then the form. If this test has to change again,
  // the change is to the primary objective and needs saying out loud.
  const primary = DOSSIER.indexOf('<Link href={`/adopt/${pet.slug}/apply`} className="btn btn--action dossier__cta">');
  const label = DOSSIER.indexOf('t.applications.adoptButton(pet.name)');
  const secondary = DOSSIER.indexOf('<a href={whatsapp}>{t.applications.whatsappQuestions}</a>');
  assert.ok(primary > 0, 'the primary button no longer links to the apply page');
  assert.ok(label > primary, 'the primary button lost its label');
  assert.ok(secondary > label, 'the WhatsApp link is missing or has moved in front of the primary button');
  assert.ok(DOSSIER.includes('const whatsapp = whatsappLink(SHELTER.whatsapp, t.adoptionInquiry(pet.name));'));
});

test('the dossier WhatsApp link is a quiet text link, not a second button', () => {
  const at = DOSSIER.indexOf('dossier__apply');
  const block = DOSSIER.slice(at, DOSSIER.indexOf('</p>', at));
  assert.ok(block.includes('whatsappQuestions'));
  assert.ok(!/className="btn/.test(block), 'the secondary link is styled as a button');
});

test('the dossier only leads to the form when it is switched on and the animal is on the wall', () => {
  assert.ok(DOSSIER.includes("const canApply = SHELTER.adoptionApplications.enabled && pet.status === 'available';"));
});

test('everywhere no form applies, WhatsApp is still the PRIMARY button', () => {
  const fallback = DOSSIER.slice(DOSSIER.indexOf(') : ('), DOSSIER.indexOf('Adóptame ↗'));
  assert.ok(fallback.includes('href={whatsapp}') && fallback.includes('className="btn btn--action dossier__cta"'));
  assert.ok(!fallback.includes('/apply'), 'the fallback branch leads to the form');
});

test('the dossier sign-in button returns to the application when one applies', () => {
  assert.ok(DOSSIER.includes("href={canApply ? signInHrefReturningTo(`/adopt/${pet.slug}/apply`) : '/account'}"));
});

test('the apply page puts the gate or form first, WhatsApp as a secondary link after, 404s while switched off, and is noindex', () => {
  const whatsapp = APPLY.indexOf('whatsappLink(');
  const form = APPLY.indexOf('<ApplicationForm');
  assert.ok(whatsapp > 0 && form > 0 && form < whatsapp, 'WhatsApp is ahead of the form again');
  assert.ok(APPLY.includes('{copy.whatsappQuestions}'));
  assert.ok(!/className="btn/.test(APPLY.slice(whatsapp - 60, whatsapp + 200)), 'the WhatsApp link became a button');
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

test('re-admission revokes ownership in the SAME batch, through the tested decision', () => {
  // The step-14 evaluation's second MAJOR: reopenPet left adoptions/{petId} in
  // place, so a returned animal's former family kept reading its microchip and
  // location through ownsPet().
  const admin = source('lib', 'pets-admin.ts');
  const body = admin.slice(admin.indexOf('export async function reopenPet'));
  const batchAt = body.indexOf('writeBatch(');
  const deleteAt = body.indexOf("batch.delete(doc(db, 'adoptions', pet.id))");
  const commitAt = body.indexOf('batch.commit()');
  assert.ok(deleteAt > 0, 'reopenPet no longer deletes adoptions/{petId}: the former family keeps ownsPet()');
  assert.ok(batchAt > 0 && batchAt < deleteAt && deleteAt < commitAt, 'the ownership delete is not inside the re-admission batch');
  assert.ok(
    body.slice(0, deleteAt).includes('if (readmissionRevokesOwnership(plan.status))'),
    'the delete is no longer driven by the tested decision',
  );
});

test('no application code logs anything but an error code (an ALLOWLIST)', () => {
  // A private person's household, C.I. and address, and two strangers' phones.
  // Review 4c-1 #3: this used to be a DENYLIST of words after the message
  // string ("answers", "draft"…), so logging `identity`, `submission` or `home`
  // passed. Now only an error code or name may follow the message — see
  // no-payload-logging.ts — and `code` may only ever hold one.
  const files = [
    ['lib', 'applications.ts'],
    ['lib', 'applications-client.ts'],
    ['lib', 'applications-admin.ts'],
    ['app', 'adopt', '[slug]', 'apply', 'ApplicationForm.tsx'],
    ['app', 'adopt', '[slug]', 'apply', 'ApplicationFields.tsx'],
    // The 4c-2 stepper: a C.I., two references' phones, an address and the
    // carnet photo flow through these.
    ['app', 'adopt', '[slug]', 'apply', 'ApplicationStepper.tsx'],
    ['app', 'adopt', '[slug]', 'apply', 'ApplicationSent.tsx'],
    ['app', 'adopt', '[slug]', 'apply', 'ContractText.tsx'],
    ['app', 'adopt', '[slug]', 'apply', 'HomeStep.tsx'],
    ['app', 'adopt', '[slug]', 'apply', 'IdPhotoStep.tsx'],
    ['app', 'adopt', '[slug]', 'apply', 'ReviewStep.tsx'],
    ['app', 'adopt', 'contract', 'page.tsx'],
    ['lib', 'application-steps.ts'],
    ['lib', 'id-document-client.ts'],
    ['lib', 'id-document-protocol.ts'],
    ['app', 'account', 'MyApplications.tsx'],
    ['app', 'admin', 'applications', 'ApplicationsQueue.tsx'],
    ['app', 'admin', 'applications', '[applicationId]', 'ApplicationReview.tsx'],
  ];
  let calls = 0;
  for (const segments of files) {
    const text = source(...segments);
    calls += (stripComments(text).match(/console\.\w+\s*\(/g) ?? []).length;
    assert.deepEqual(payloadLoggingProblems(segments.join('/'), text), []);
  }
  // Control: the walk really sees the calls these files make.
  assert.ok(calls >= 10, `only ${calls} console calls found — the scan is not reading the files`);
});

test('the logging allowlist refuses a payload and accepts an error code (control)', () => {
  // So the test above cannot pass by checking nothing.
  for (const bad of [
    "console.error('[x] failed', identity);",
    "console.error('[x] failed', submission.identity);",
    "console.error('[x] failed', home);",
    "console.warn('[x] failed', code, identity);",
    "console.error('[x] failed', caught);",
    'console.error(identity);',
    "const code = identity.ciNumber;\nconsole.error('[x] failed', code);",
    "const code: string = identity.ciNumber;\nconsole.error('[x] failed', code);",
    "let code = errorCode(caught);\ncode = home.addressText;\nconsole.error('[x] failed', code);",
  ]) {
    assert.ok(payloadLoggingProblems('fixture', bad).length > 0, `not refused: ${bad}`);
  }
  for (const ok of [
    "console.error('[x] failed', code);",
    "console.error('[x] failed', errorCode(caught));",
    "console.error('[x] failed', (caught as { code?: string })?.code);",
    "console.error('[x] failed');",
    "const code = errorCode(caught);\nconsole.error('[x] failed', code);",
    "// console.error('[x] failed', identity); — a comment, not a call",
  ]) {
    assert.deepEqual(payloadLoggingProblems('fixture', ok), [], ok);
  }
});
