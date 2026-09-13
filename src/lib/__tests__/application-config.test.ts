/**
 * The application form's CONFIG, and the two places it is copied into
 * `firestore.rules`.
 *
 * The rules cannot import TypeScript, so three things are written twice: the
 * question ids (the only keys an answer may have), the answer bounds, and the
 * admin transition table. The rules copy is the one that is ENFORCED. These
 * tests read `firestore.rules` as text and fail by name when the copies drift —
 * and they fail loudly when the parser stops finding a block, rather than
 * skipping, because a drift guard that silently stops comparing reads as a
 * passing check forever (the seeder's enum guard, 2026-08-23).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SHELTER, type ApplicationSection } from '@/config/shelter';
import {
  ANSWER_MAX_CHARS,
  APPLICATION_STATUS_TRANSITIONS,
  MAX_APPLICATION_QUESTIONS,
  RULES_ANSWER_MAX_CHARS,
  RULES_ANSWER_MAX_COUNT,
  buildApplicationCreate,
} from '../applications';
import { findVoseo } from '../ai/spanish-register';
import { es } from '@/i18n/es';
import type { ApplicationStatus } from '../types';

const config = SHELTER.adoptionApplications;
const RULES = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8');

/** The body of a rules function, or a thrown error naming it. */
function rulesFunctionBody(name: string): string {
  const start = RULES.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `firestore.rules no longer defines ${name}() — the drift guard cannot compare`);
  const open = RULES.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < RULES.length; i += 1) {
    if (RULES[i] === '{') depth += 1;
    if (RULES[i] === '}') depth -= 1;
    if (depth === 0) return RULES.slice(open + 1, i);
  }
  throw new Error(`unterminated rules function ${name}()`);
}

function quotedStrings(text: string): string[] {
  return [...text.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
}

// ─── the switch ─────────────────────────────────────────────────────────────

test('the public form cannot be switched on while the questions are still the draft', () => {
  // Plan §11 #3: the shelter's real questions are missing. Publishing invented
  // ones as though Wawitas asked them is the failure this guards against.
  assert.ok(
    !(config.enabled && config.questionsAreDraft),
    'adoptionApplications.enabled is true while questionsAreDraft is true — replace the draft questions first',
  );
});

test('it ships switched OFF', () => {
  // Remove this test in the same commit that flips the switch, deliberately.
  assert.equal(config.enabled, false);
});

test('the rules enforce the same switch the config declares', () => {
  // The config flag only hides the page. The rules copy is what refuses an
  // application written straight through the SDK — found by the step-14
  // evaluation with the switch "off" and the create still allowed.
  const match = /return\s+(true|false)\s*;/.exec(rulesFunctionBody('applicationsEnabled'));
  assert.ok(match, 'applicationsEnabled() no longer returns a literal — the drift guard cannot compare');
  assert.equal(
    match[1] === 'true',
    config.enabled,
    'firestore.rules applicationsEnabled() and shelter.ts adoptionApplications.enabled disagree — change both, deploy the rules',
  );
});

test('the applicant create rule is gated on the switch', () => {
  const create = [...RULES.matchAll(/allow create:[^;]*/g)]
    .map((m) => m[0])
    .find((rule) => rule.includes('ownApplicationId()'));
  assert.ok(create, 'no adoptionApplications create rule found');
  assert.ok(
    /^allow create: if applicationsEnabled\(\)\s*&&/.test(create),
    'the application create rule no longer starts with applicationsEnabled()',
  );
});

// ─── the questions ──────────────────────────────────────────────────────────

test('question ids are unique, English identifiers, and within the cap', () => {
  const ids = config.questions.map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate question id');
  assert.ok(ids.length > 0 && ids.length <= MAX_APPLICATION_QUESTIONS, `${ids.length} questions`);
  for (const id of ids) assert.match(id, /^[a-z][A-Za-z0-9]*$/, id);
});

test('every choice has at least two options with unique English values', () => {
  for (const q of config.questions.filter((q) => q.kind === 'choice')) {
    const values = (q.options ?? []).map((o) => o.value);
    assert.ok(values.length >= 2, `${q.id} has fewer than two options`);
    assert.equal(new Set(values).size, values.length, `${q.id} repeats an option value`);
    for (const v of values) assert.match(v, /^[a-z][A-Za-z0-9]*$/, `${q.id}: ${v}`);
  }
  for (const q of config.questions.filter((q) => q.kind !== 'choice')) {
    assert.equal(q.options, undefined, `${q.id} has options but is not a choice`);
  }
});

test('every count maximum fits inside the bound the rules enforce', () => {
  for (const q of config.questions.filter((q) => q.kind === 'count')) {
    assert.ok((q.max ?? 30) <= RULES_ANSWER_MAX_COUNT, `${q.id} max ${q.max}`);
  }
});

test('the form asks exactly one name and one number to reach the applicant on', () => {
  assert.equal(config.questions.filter((q) => q.purpose === 'applicantName').length, 1);
  assert.equal(config.questions.filter((q) => q.purpose === 'applicantPhone').length, 1);
});

test('the draft covers every heading plan §6 names', () => {
  const sections = new Set(config.questions.map((q) => q.section));
  for (const heading of ['housing', 'household', 'otherPets', 'experience', 'why'] as ApplicationSection[]) {
    assert.ok(sections.has(heading), `no question under ${heading}`);
  }
});

test('the form never asks for a street address or an identity document', () => {
  // A private person's application must not become a list of where strangers
  // live. Asked in words, because the ids alone could be renamed around this.
  for (const q of config.questions) {
    const text = `${q.id} ${q.label} ${q.hint ?? ''}`.toLowerCase();
    assert.ok(!/\b(address|carnet|passport|pasaporte)\b/.test(text), q.id);
    assert.ok(!/tu dirección\??$/.test(q.label.toLowerCase()), q.id);
  }
});

// ─── drift against firestore.rules ──────────────────────────────────────────

test('the rules accept exactly the configured question ids as answer keys', () => {
  const ruleKeys = quotedStrings(rulesFunctionBody('applicationAnswerKeys'));
  assert.deepEqual(
    [...ruleKeys].sort(),
    config.questions.map((q) => q.id).sort(),
    'firestore.rules applicationAnswerKeys() and shelter.ts questions differ — change both, deploy the rules',
  );
});

test('every answer key the rules accept is also bounds-checked by the rules', () => {
  // A key added to hasOnly() but not to validAnswers() would accept a value of
  // any size and any type under that key.
  const body = rulesFunctionBody('validAnswers');
  const checked = [...body.matchAll(/validAnswer\(answers\.get\('([^']+)', true\)\)/g)].map((m) => m[1]!);
  assert.deepEqual([...checked].sort(), config.questions.map((q) => q.id).sort());
});

test('the rules bound every answer by the same numbers the module declares', () => {
  const body = rulesFunctionBody('validAnswer');
  assert.ok(body.includes(`v.size() <= ${RULES_ANSWER_MAX_CHARS}`), 'string bound drifted');
  assert.ok(body.includes(`v <= ${RULES_ANSWER_MAX_COUNT}`), 'count bound drifted');
  assert.ok(body.includes('v >= 0'), 'a negative count is no longer refused');
});

test('no per-kind length limit is looser than the rules bound', () => {
  for (const [kind, max] of Object.entries(ANSWER_MAX_CHARS)) {
    assert.ok(max <= RULES_ANSWER_MAX_CHARS, `${kind} allows ${max}, rules allow ${RULES_ANSWER_MAX_CHARS}`);
  }
});

test('the rules transition table is the module transition table', () => {
  const body = rulesFunctionBody('applicationTransitions');
  const parsed: Record<string, string[]> = {};
  for (const m of body.matchAll(/'([a-z]+)':\s*\[([^\]]*)\]/g)) {
    parsed[m[1]!] = quotedStrings(m[2]!);
  }
  assert.equal(Object.keys(parsed).length, 6, 'did not find all six statuses in applicationTransitions()');
  for (const [from, targets] of Object.entries(APPLICATION_STATUS_TRANSITIONS)) {
    assert.deepEqual(
      [...(parsed[from] ?? ['<missing>'])].sort(),
      [...targets].sort(),
      `transitions from ${from as ApplicationStatus} differ between firestore.rules and applications.ts`,
    );
  }
});

test('the rules require exactly the fields the writer creates an application with', () => {
  // hasOnly + hasAll on this list: a field the writer adds and the rules do not
  // list gets every submission refused; a field the rules require and the
  // writer omits does too.
  const ruleKeys = quotedStrings(rulesFunctionBody('applicationKeys'));
  const written = Object.keys(
    buildApplicationCreate({
      petId: 'p',
      applicantUid: 'u',
      applicantEmail: 'e@example.com',
      applicantEmailVerified: true,
      answers: {},
    }),
  );
  assert.deepEqual([...ruleKeys].sort(), [...written].sort());
});

test('the internal notes rule is admin-only and refuses delete', () => {
  const start = RULES.indexOf('match /internal/{docId}');
  assert.ok(start >= 0, 'the internal notes rule is gone');
  const block = RULES.slice(start, RULES.indexOf('}', RULES.indexOf('allow delete', start)));
  assert.ok(block.includes('allow read: if isAdmin();'));
  assert.ok(block.includes('allow delete: if false;'));
  assert.ok(!/allow (read|write)[^;]*signedIn\(\)/.test(block), 'internal notes reachable by a non-admin');
});

// ─── the copy ───────────────────────────────────────────────────────────────

function allApplicationCopy(): string[] {
  const c = es.applications;
  const out: string[] = [];
  for (const value of Object.values(c)) {
    if (typeof value === 'string') out.push(value);
  }
  out.push(
    c.pageTitle('Luna'),
    c.intro('Luna'),
    c.privacy('Wawitas'),
    c.notAccepting('Luna'),
    ...c.confirmationSteps('Luna', 'Wawitas'),
    c.backToPet('Luna'),
    c.submittedOn('3 sep 2026'),
    c.retiredQuestion('zone'),
    c.approveExplain('Luna', 'Ana'),
    c.approvedDone('Luna'),
    c.formStateNote(false, true) ?? '',
    c.formStateNote(false, false) ?? '',
  );
  const statuses: ApplicationStatus[] = ['submitted', 'reviewing', 'interview', 'approved', 'rejected', 'withdrawn'];
  for (const s of statuses) {
    out.push(es.applicationStatusLabel(s), es.applicantStatusLabel(s), es.applicantStatusExplanation(s));
    for (const to of statuses) out.push(es.applicationActionLabel(s, to));
  }
  out.push(
    es.approvalBlocker('pet-already-adopted'),
    es.approvalBlocker('pet-not-ready'),
    es.approvalBlocker('application-not-approvable'),
    es.approvalWarning('other-open-applications', { otherOpenCount: 1 }),
    es.approvalWarning('other-open-applications', { otherOpenCount: 3 }),
    es.approvalWarning('email-unverified', { otherOpenCount: 0 }),
    es.approvalWarning('pet-not-on-wall', { otherOpenCount: 0 }),
    es.approvalWarning('location-will-be-visible', { otherOpenCount: 0 }),
    ...config.questions.flatMap((q) => [q.label, q.hint ?? '', ...(q.options ?? []).map((o) => o.label)]),
  );
  return out.filter((s) => s !== '');
}

test('no application copy and no draft question speaks voseo', () => {
  for (const text of allApplicationCopy()) {
    assert.deepEqual(findVoseo(text), [], text);
  }
});

test('the confirmation promises no automatic message and no reservation', () => {
  // Nothing in this feature sends an email or a message, and an application
  // does not hold the animal. The copy must say so rather than imply otherwise.
  const steps = es.applications.confirmationSteps('Luna', 'Wawitas').join(' ').toLowerCase();
  assert.ok(steps.includes('no reserva'), 'no longer says the animal is not reserved');
  assert.ok(steps.includes('ni por correo'), 'no longer says nobody answers by email');
  assert.ok(!/te (enviaremos|enviamos|llegará) (un )?correo/.test(steps), 'promises an email');
});

test('a rejected applicant is not shown the word "Rechazada"', () => {
  assert.notEqual(es.applicantStatusLabel('rejected'), es.applicationStatusLabel('rejected'));
  assert.ok(!/rechaz/i.test(es.applicantStatusLabel('rejected')));
});
