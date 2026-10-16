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
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { SHELTER, type ApplicationSection } from '@/config/shelter';
import {
  ADOPTION_CONTRACT,
  contractCanonicalText,
  type AdoptionContract,
} from '@/config/adoption-contract';
import {
  ANSWER_MAX_CHARS,
  APPLICATION_STATUS_TRANSITIONS,
  ContractUnavailableError,
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

/**
 * A contract for the tests only. Its text is the string a test below forbids
 * anywhere outside __tests__, so it can never be published as the shelter's.
 */
const FIXTURE_TEXT = {
  title: 'TEXTO DE PRUEBA',
  clauses: ['TEXTO DE PRUEBA, cláusula uno.', 'TEXTO DE PRUEBA, cláusula dos.'],
};
const FIXTURE: AdoptionContract = {
  version: '2000-01-01',
  ...FIXTURE_TEXT,
  sha256: createHash('sha256').update(contractCanonicalText(FIXTURE_TEXT)).digest('hex'),
};

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

test('no screening QUESTION asks for a street address or an identity document', () => {
  // Re-worded in portion 4a, not removed. The application now collects a home
  // address and an ID photo — but only through their own restricted steps:
  // the address into `private/home`, the photo through its upload route into
  // Storage. An answer lives in the main application document, so a question
  // asking for either would put it where the queue lists it and where the
  // retention policy cannot erase it separately. Asked in words, because the
  // ids alone could be renamed around this.
  for (const q of config.questions) {
    const text = `${q.id} ${q.label} ${q.hint ?? ''}`.toLowerCase();
    assert.ok(
      !/\b(address|direcci[oó]n|domicilio|carnet|c[eé]dula|passport|pasaporte|documento de identidad)\b/.test(text),
      q.id,
    );
    assert.ok(!/tu dirección\??$/.test(q.label.toLowerCase()), q.id);
  }
});

test('the zone question is gone, because the home address replaces it', () => {
  // A recorded decision reversed in portion 4a: shelter.ts said the form asks
  // for a ZONE, never an address. Keeping `zone` would duplicate the address
  // into the main document.
  assert.ok(!config.questions.some((q) => q.id === 'zone'));
});

test('the shelter asks for exactly the front of the identity card', () => {
  // Owner decision, 2026-10-16: front only.
  assert.deepEqual([...config.idDocumentSides], ['front']);
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
      contract: { version: FIXTURE.version, sha256: FIXTURE.sha256 },
    }),
  );
  assert.deepEqual([...ruleKeys].sort(), [...written].sort());
  // The 11 of step 14 plus the 5 of portion 4a. A literal, so a key dropped
  // from BOTH lists at once still fails.
  assert.equal(ruleKeys.length, 16);
});

test('no browser may change the five portion-4a fields after create', () => {
  // The two update rules each list exactly which fields may change. None of
  // the new ones may be on either list: `idDocument` and `identityErasedAt`
  // are written only through the Admin SDK, and the contract fields are a
  // record of what was accepted.
  const frozen = ['contractVersion', 'contractSha256', 'termsAcceptedAt', 'idDocument', 'identityErasedAt'];
  for (const fn of ['applicantWithdraws', 'adminMovesApplication']) {
    const match = /affectedKeys\(\)\s*\.hasOnly\(\[([^\]]*)\]\)/.exec(rulesFunctionBody(fn));
    assert.ok(match, `${fn}() no longer gates on an affectedKeys() list — the guard cannot compare`);
    const allowed = quotedStrings(match[1]!);
    assert.ok(allowed.length > 0, `${fn}() lists no fields`);
    for (const key of frozen) assert.ok(!allowed.includes(key), `${fn}() lets a browser change ${key}`);
  }
});

test('the approval rule requires the received ID marker for exactly the configured sides', () => {
  const body = rulesFunctionBody('idDocumentReceived');
  const checked = [...body.matchAll(/idDocument\.get\('([a-z]+)', null\) is map/g)].map((m) => m[1]!);
  assert.ok(checked.length > 0, 'idDocumentReceived() no longer checks a side — the drift guard cannot compare');
  assert.deepEqual(
    [...checked].sort(),
    [...config.idDocumentSides].sort(),
    'firestore.rules idDocumentReceived() and shelter.ts idDocumentSides differ — change both, deploy the rules',
  );
  const admin = rulesFunctionBody('adminMovesApplication');
  assert.ok(
    /status != 'approved'\s*\|\|\s*\(approvalIsOneBatch\(\) && idDocumentReceived\(\)\)/.test(admin),
    'approval no longer requires both the one-batch pairing and the received ID',
  );
});

test('pinWithinServiceArea uses the latlng METHOD form and SHELTER.bounds', () => {
  // A stored GeoPoint is a rules `latlng`: `.latitude()` works, `.latitude` is a
  // type error. withinServiceArea() (sightings) still uses property access,
  // which is a known bug fixed in a separate PR — deliberately NOT pinned here.
  const { minLat, maxLat, minLng, maxLng } = SHELTER.bounds;
  const body = rulesFunctionBody('pinWithinServiceArea').replace(/\s+/g, ' ');
  for (const needle of [
    `geo.latitude() >= ${minLat}`,
    `geo.latitude() <= ${maxLat}`,
    `geo.longitude() >= ${minLng}`,
    `geo.longitude() <= ${maxLng}`,
  ]) {
    assert.ok(body.includes(needle), `pinWithinServiceArea() no longer says ${needle}`);
  }
  assert.ok(!/geo\.(latitude|longitude)\b(?!\()/.test(body), 'pinWithinServiceArea() uses property access on a latlng');
});

// ─── the contract — portion 4a, plan §5 ─────────────────────────────────────

/** Everything wrong with a contract, in words. Empty when it may be published. */
function contractProblems(contract: AdoptionContract): string[] {
  const problems: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(contract.version)) problems.push(`version ${contract.version} is not YYYY-MM-DD`);
  if (contract.title.trim() === '') problems.push('the title is empty');
  if (contract.clauses.length === 0 || contract.clauses.some((c) => c.trim() === '')) {
    problems.push('a clause is empty, or there are none');
  }
  const expected = createHash('sha256').update(contractCanonicalText(contract), 'utf8').digest('hex');
  if (contract.sha256 !== expected) problems.push(`sha256 should be ${expected}`);
  return problems;
}

/** The {version: sha256} pairs acceptedContracts() returns. */
function rulesContracts(): Record<string, string> {
  const body = rulesFunctionBody('acceptedContracts');
  const literal = /return\s+\{([^{}]*)\}\s*;/.exec(body);
  assert.ok(literal, 'acceptedContracts() no longer returns a map literal — the drift guard cannot compare');
  const pairs: Record<string, string> = {};
  for (const m of literal[1]!.matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)) pairs[m[1]!] = m[2]!;
  // Every non-space character in the literal must belong to a parsed pair, or
  // a pair written in another style would be silently skipped.
  const leftover = literal[1]!.replace(/'[^']+'\s*:\s*'[^']+'\s*,?/g, '').trim();
  assert.equal(leftover, '', `acceptedContracts() holds something this guard cannot read: ${leftover}`);
  return pairs;
}

test('the canonical contract text is the title and each clause, separated by a blank line', () => {
  assert.equal(
    contractCanonicalText({ title: 'T', clauses: ['a', 'b'] }),
    'T\n\na\n\nb',
  );
});

test('the contract checker catches a wrong hash, a bad version and an empty clause', () => {
  // The checker is what guards the real contract once it exists, so it is
  // proven on a fixture now, while ADOPTION_CONTRACT is still null.
  assert.deepEqual(contractProblems(FIXTURE), []);
  assert.equal(contractProblems({ ...FIXTURE, clauses: [...FIXTURE.clauses, 'una más'] }).length, 1, 'an edited clause kept its old hash');
  assert.equal(contractProblems({ ...FIXTURE, version: '16-10-2026' }).length, 1);
  assert.equal(contractProblems({ ...FIXTURE, clauses: ['  '] }).length, 2);
});

test('the configured contract, if any, is internally consistent', () => {
  if (ADOPTION_CONTRACT === null) return; // null until the shelter supplies it
  assert.deepEqual(contractProblems(ADOPTION_CONTRACT), []);
});

test('the rules accept exactly the configured contract, and nothing while there is none', () => {
  const pairs = rulesContracts();
  if (ADOPTION_CONTRACT === null) {
    assert.deepEqual(pairs, {}, 'acceptedContracts() lists a contract while ADOPTION_CONTRACT is null');
  } else {
    assert.deepEqual(
      pairs,
      { [ADOPTION_CONTRACT.version]: ADOPTION_CONTRACT.sha256 },
      'firestore.rules acceptedContracts() and adoption-contract.ts differ — change both, deploy the rules',
    );
  }
});

test('the contract parser reads a populated acceptedContracts()', () => {
  // So the guard above is not only ever run against `{}`.
  const populated = `{'${FIXTURE.version}': '${FIXTURE.sha256}'}`;
  const pairs: Record<string, string> = {};
  for (const m of populated.matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)) pairs[m[1]!] = m[2]!;
  assert.deepEqual(pairs, { [FIXTURE.version]: FIXTURE.sha256 });
});

test('the application create rule checks the contract and the home document', () => {
  const create = [...RULES.replace(/\r\n/g, '\n').matchAll(/allow create:[^;]*/g)]
    .map((m) => m[0])
    .find((rule) => rule.includes('petAcceptsApplications('));
  assert.ok(create, 'no adoptionApplications create rule found');
  assert.ok(create.includes('acceptedContracts().get(request.resource.data.contractVersion, null)'));
  assert.ok(create.includes('request.resource.data.termsAcceptedAt == request.time'));
  assert.ok(create.includes('request.resource.data.identityErasedAt == null'));
  assert.ok(create.includes('/private/home)'), 'the create no longer requires private/home in the same batch');
});

test('the form cannot be switched on while there is no contract', () => {
  assert.ok(
    !(config.enabled && ADOPTION_CONTRACT === null),
    'adoptionApplications.enabled is true while ADOPTION_CONTRACT is null — the shelter has not supplied its contract',
  );
});

test('with the configured contract, nothing can be accepted while it is null', () => {
  // The browser half of the third lock, through the same call the client makes.
  const make = () =>
    buildApplicationCreate({
      petId: 'p',
      applicantUid: 'u',
      applicantEmail: 'e@example.com',
      applicantEmailVerified: true,
      answers: {},
      contract: ADOPTION_CONTRACT,
    });
  if (ADOPTION_CONTRACT === null) assert.throws(make, ContractUnavailableError);
  else assert.doesNotThrow(make);
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
    return /\.(ts|tsx|js|mjs|json)$/.test(entry.name) ? [path] : [];
  });
}

test('the fixture contract text never leaves __tests__', () => {
  // So no test text can be published as though the shelter wrote it.
  const offenders = sourceFiles(join(process.cwd(), 'src')).filter((file) =>
    readFileSync(file, 'utf8').includes('TEXTO DE PRUEBA'),
  );
  assert.deepEqual(offenders, []);
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
    es.approvalBlocker('id-document-missing'),
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
