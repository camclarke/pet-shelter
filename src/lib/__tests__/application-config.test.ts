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

import { SHELTER } from '@/config/shelter';
import {
  ADOPTION_ACCEPTANCE,
  ADOPTION_CONTRACT,
  CONTRACT_CI_TOKEN,
  CONTRACT_NAME_TOKEN,
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
  type ApplicationAnswerError,
} from '../applications';
import { findVoseo } from '../ai/spanish-register';
import { es } from '@/i18n/es';
import type { ApplicationStatus } from '../types';

const config = SHELTER.adoptionApplications;
const RULES = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8');

const applicationIds = () => config.questions.filter((q) => q.store === 'application').map((q) => q.id);
const identityIds = () => config.questions.filter((q) => q.store === 'identity').map((q) => q.id);

/**
 * A contract for the tests only. Its text is the string a test below forbids
 * anywhere outside __tests__, so it can never be published as the shelter's.
 */
const FIXTURE_TEXT = {
  heading: null,
  opening: `TEXTO DE PRUEBA ${CONTRACT_NAME_TOKEN}, con C.I. ${CONTRACT_CI_TOKEN}:`,
  clauses: ['TEXTO DE PRUEBA, cláusula uno.', 'TEXTO DE PRUEBA, cláusula dos.'],
  closing: 'TEXTO DE PRUEBA, cierre.',
};
const FIXTURE: AdoptionContract = {
  version: '2000-01-01',
  ...FIXTURE_TEXT,
  emphasizedClauses: [],
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
  const name = config.questions.filter((q) => q.purpose === 'applicantName');
  const phone = config.questions.filter((q) => q.purpose === 'applicantPhone');
  assert.equal(name.length, 1);
  assert.equal(phone.length, 1);
  // Both identify the record and are what /privacy says the application keeps,
  // so both stay in `answers` — never in the erasable private/identity.
  assert.equal(name[0]!.store, 'application');
  assert.equal(phone[0]!.store, 'application');
  assert.deepEqual([name[0]!.id, phone[0]!.id], ['fullName', 'whatsapp'], 'the key ids /privacy relies on changed');
});

test("the questions use exactly the paper's three sections, in its order, each with a question", () => {
  // Literals: the paper prints these headings, numbered 1-3 (the numbers are
  // dropped online, owner decision D7). Section 4, DATOS DEL PELUDITO
  // ADOPTADO, is the shelter's to fill at handover and is never asked (D16).
  assert.deepEqual(config.sections.map((s) => s.id), ['personal', 'references', 'home']);
  assert.deepEqual(config.sections.map((s) => s.label), ['DATOS PERSONALES', 'REFERENCIAS', 'DOMICILIO']);
  const order = config.sections.map((s) => s.id);
  let previous = 0;
  for (const q of config.questions) {
    const at = order.indexOf(q.section);
    assert.ok(at >= 0, `${q.id} sits in a section the config does not list`);
    assert.ok(at >= previous, `${q.id} breaks the paper's section order`);
    previous = at;
  }
  for (const id of order) assert.ok(config.questions.some((q) => q.section === id), `no question under ${id}`);
});

test("the paper's fields, in the paper's order, each in the store the plan gives it", () => {
  // Literals, so moving a field between stores — which changes who can read it
  // and whether it can ever be erased — fails here by name.
  assert.deepEqual(
    config.questions.map((q) => `${q.store}:${q.id}`),
    [
      'application:fullName',
      'identity:ciNumber',
      'identity:age',
      'identity:civilStatus',
      'application:whatsapp',
      'identity:landline',
      'identity:personalRefName',
      'identity:personalRefPhone',
      'identity:personalRefRelation',
      'identity:familyRefName',
      'identity:familyRefPhone',
      'identity:familyRefRelation',
      'application:housingType',
      'application:housingTenure',
      'identity:landlordName',
      'identity:landlordPhone',
      'application:movingSoon',
      'application:walled',
    ],
  );
  assert.equal(applicationIds().length, 6);
  assert.equal(identityIds().length, 12);
});

test('only CASA (the landline) is optional; the landlord and "amurallado" are asked only when they apply', () => {
  // Owner decision D3. NÚMERO DE CASA Y DETALLES is the other optional field,
  // and it is not a question (it lives in private/home).
  assert.deepEqual(config.questions.filter((q) => !q.required).map((q) => q.id), ['landline']);
  const asked = Object.fromEntries(
    config.questions.filter((q) => q.askedWhen).map((q) => [q.id, q.askedWhen]),
  );
  assert.deepEqual(asked, {
    landlordName: { questionId: 'housingTenure', values: ['rented'] },
    landlordPhone: { questionId: 'housingTenure', values: ['rented'] },
    walled: { questionId: 'housingType', values: ['house', 'farm'] },
  });
});

test('every askedWhen names an EARLIER question, and only values that question can store', () => {
  // Earlier, so the chain can never loop; real values, so a typo cannot hide a
  // question for good.
  config.questions.forEach((q, index) => {
    if (!q.askedWhen) return;
    const controlling = config.questions.findIndex((c) => c.id === q.askedWhen!.questionId);
    assert.ok(controlling >= 0 && controlling < index, `${q.id} depends on a later or missing question`);
    const c = config.questions[controlling]!;
    const possible: (string | boolean)[] =
      c.kind === 'yesNo' ? [true, false] : (c.options ?? []).map((o) => o.value);
    for (const value of q.askedWhen.values) assert.ok(possible.includes(value), `${q.id}: ${String(value)}`);
  });
});

test('the age question refuses under-18s and the C.I. question is the idNumber kind', () => {
  // Owner decision D4: the contract opens "Yo … mayor de edad".
  const age = config.questions.find((q) => q.id === 'age');
  assert.ok(age && age.kind === 'count' && age.store === 'identity');
  assert.equal(age.min, 18);
  assert.equal(age.max, 99);
  const ci = config.questions.find((q) => q.id === 'ciNumber');
  assert.ok(ci && ci.kind === 'idNumber' && ci.store === 'identity' && ci.required);
  // The only identity answers that are not strings in the rules: age. So no
  // other count, no yes/no, no choice and no long text may be stored there.
  for (const q of config.questions.filter((q) => q.store === 'identity' && q.id !== 'age')) {
    assert.ok(['shortText', 'phone', 'idNumber'].includes(q.kind), `${q.id} is a ${q.kind} in private/identity`);
  }
  assert.ok(config.questions.filter((q) => q.kind === 'idNumber').every((q) => q.store === 'identity'));
});

test('no APPLICATION-store question asks for an address, an identity document or a third person', () => {
  // Re-worded in portion 4a and scoped in 4c-1, not removed. The address goes
  // only into `private/home`, the photo through its upload route into Storage,
  // and the C.I., the references and the landlord only into `private/identity`.
  // An `answers` value lives in the main document, which the queue downloads
  // whole and nothing may ever erase. Asked in words, because the ids alone
  // could be renamed around this.
  const forbidden =
    /\b(address|direcci[oó]n|domicilio|carnet|c[eé]dula|passport|pasaporte|documento de identidad|referencia|due[nñ]o|fijo)\b/;
  const ci = /\bc\.\s?i\./;
  const words = (q: (typeof config.questions)[number]) =>
    `${q.id} ${q.label} ${q.hint ?? ''} ${q.intro ?? ''}`.toLowerCase();
  for (const q of config.questions.filter((q) => q.store === 'application')) {
    assert.ok(!forbidden.test(words(q)), q.id);
    assert.ok(!ci.test(words(q)), q.id);
    assert.ok(!/tu dirección\??$/.test(q.label.toLowerCase()), q.id);
  }
  // Control: the same words DO name the identity questions, so the check above
  // is not vacuous.
  for (const id of ['ciNumber', 'landline', 'personalRefName', 'familyRefName', 'landlordName']) {
    const q = config.questions.find((x) => x.id === id)!;
    assert.ok(forbidden.test(words(q)) || ci.test(words(q)), `${id} no longer trips the guard: the control is broken`);
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

test("the rules accept exactly the configured APPLICATION-store ids as answer keys", () => {
  const ruleKeys = quotedStrings(rulesFunctionBody('applicationAnswerKeys'));
  assert.deepEqual(
    [...ruleKeys].sort(),
    applicationIds().sort(),
    "firestore.rules applicationAnswerKeys() and shelter.ts store:'application' questions differ — change both, deploy the rules",
  );
});

test('every answer key the rules accept is also bounds-checked by the rules', () => {
  // A key added to hasOnly() but not to validAnswers() would accept a value of
  // any size and any type under that key.
  const body = rulesFunctionBody('validAnswers');
  const checked = [...body.matchAll(/validAnswer\(answers\.get\('([^']+)', true\)\)/g)].map((m) => m[1]!);
  assert.deepEqual([...checked].sort(), applicationIds().sort());
});

test("the rules accept exactly the configured IDENTITY-store ids in private/identity", () => {
  const ruleKeys = quotedStrings(rulesFunctionBody('identityAnswerKeys'));
  assert.deepEqual(
    [...ruleKeys].sort(),
    identityIds().sort(),
    "firestore.rules identityAnswerKeys() and shelter.ts store:'identity' questions differ — change both, deploy the rules",
  );
  // And the two lists never share a key: a field is in `answers` or in
  // private/identity, never both.
  const application = new Set(quotedStrings(rulesFunctionBody('applicationAnswerKeys')));
  assert.deepEqual(ruleKeys.filter((key) => application.has(key)), []);
});

test('every identity key the rules accept is also bounds-checked by validIdentity()', () => {
  // ciNumber and age have their own checks; every other key must pass through
  // validIdentityAnswer(), or it would accept any type and any size.
  const body = rulesFunctionBody('validIdentity').replace(/\s+/g, ' ');
  const checked = [...body.matchAll(/validIdentityAnswer\(d\.answers\.get\('([^']+)', ''\)\)/g)].map((m) => m[1]!);
  assert.deepEqual(
    [...checked, 'ciNumber', 'age'].sort(),
    identityIds().sort(),
    'a private/identity key is accepted but never bounds-checked',
  );
  assert.ok(body.includes("d.answers.keys().hasOnly(identityAnswerKeys())"));
  assert.ok(body.includes("d.answers.keys().hasAll(['ciNumber', 'age'])"));
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
      acceptance: { accepted: true, contractVersion: FIXTURE.version },
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

for (const fn of ['pinWithinServiceArea', 'withinServiceArea']) {
  test(`${fn} uses the latlng METHOD form and SHELTER.bounds`, () => {
    // A stored GeoPoint is a rules `latlng`: `.latitude()` works, `.latitude`
    // is a type error that denies every write carrying one.
    const { minLat, maxLat, minLng, maxLng } = SHELTER.bounds;
    const body = rulesFunctionBody(fn).replace(/\s+/g, ' ');
    for (const needle of [
      `geo.latitude() >= ${minLat}`,
      `geo.latitude() <= ${maxLat}`,
      `geo.longitude() >= ${minLng}`,
      `geo.longitude() <= ${maxLng}`,
    ]) {
      assert.ok(body.includes(needle), `${fn}() no longer says ${needle}`);
    }
    assert.ok(!/geo\.(latitude|longitude)\b(?!\()/.test(body), `${fn}() uses property access on a latlng`);
  });
}

// ─── the contract — portion 4a, plan §5; the real text since 4c-1 ───────────

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

/** Everything wrong with a contract, in words. Empty when it may be published. */
function contractProblems(contract: AdoptionContract): string[] {
  const problems: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(contract.version)) problems.push(`version ${contract.version} is not YYYY-MM-DD`);
  if (contract.heading !== null && contract.heading.trim() === '') problems.push('the heading is empty (use null)');
  if (occurrences(contract.opening, CONTRACT_NAME_TOKEN) !== 1) problems.push('the opening must hold the name token once');
  if (occurrences(contract.opening, CONTRACT_CI_TOKEN) !== 1) problems.push('the opening must hold the C.I. token once');
  if (contract.clauses.length === 0 || contract.clauses.some((c) => c.trim() === '')) {
    problems.push('a clause is empty, or there are none');
  }
  if (contract.closing.trim() === '') problems.push('the closing is empty');
  if (contract.emphasizedClauses.some((i) => !Number.isInteger(i) || i < 0 || i >= contract.clauses.length)) {
    problems.push('an emphasized clause index is out of range');
  }
  const expected = createHash('sha256').update(contractCanonicalText(contract), 'utf8').digest('hex');
  if (contract.sha256 !== expected) problems.push(`sha256 should be ${expected}`);
  return problems;
}

/** Every string of the contract, in order. */
function contractStrings(contract: AdoptionContract): string[] {
  return [...(contract.heading ? [contract.heading] : []), contract.opening, ...contract.clauses, contract.closing];
}

/** Every string the shelter's paper prints that the config carries — contract excluded. */
function paperFormStrings(): string[] {
  return [
    config.formIntro,
    config.homeLabels.address,
    config.homeLabels.details,
    ...config.sections.map((s) => s.label),
    ...config.questions.flatMap((q) => [q.label, q.intro ?? '', ...(q.options ?? []).map((o) => o.label)]),
    // Section 4, DATOS DEL PELUDITO ADOPTADO, shown read-only on the review (4c-2).
    config.petSection.title,
    config.petSection.name,
    config.petSection.age,
    config.petSection.breed,
    config.petSection.color,
    config.petSection.species,
    config.petSection.sex,
    ...Object.values(config.petSection.speciesValues),
    ...Object.values(config.petSection.sexValues),
  ].filter((s) => s !== '');
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

test('the canonical contract text is the heading if any, the opening template, each clause and the closing, blank-line joined', () => {
  assert.equal(
    contractCanonicalText({ heading: null, opening: 'O', clauses: ['a', 'b'], closing: 'C' }),
    'O\n\na\n\nb\n\nC',
  );
  assert.equal(
    contractCanonicalText({ heading: 'H', opening: 'O', clauses: ['a'], closing: 'C' }),
    'H\n\nO\n\na\n\nC',
  );
});

test('the contract checker catches a wrong hash, a bad version, a lost token and an empty clause', () => {
  // Proven on a fixture as well as on the real contract, so the checker itself
  // is known to fire.
  assert.deepEqual(contractProblems(FIXTURE), []);
  assert.equal(contractProblems({ ...FIXTURE, clauses: [...FIXTURE.clauses, 'una más'] }).length, 1, 'an edited clause kept its old hash');
  assert.equal(contractProblems({ ...FIXTURE, version: '16-10-2026' }).length, 1);
  assert.equal(contractProblems({ ...FIXTURE, clauses: ['  '] }).length, 2);
  assert.ok(contractProblems({ ...FIXTURE, opening: FIXTURE.opening.replace(CONTRACT_CI_TOKEN, '') }).length >= 1);
  assert.ok(contractProblems({ ...FIXTURE, emphasizedClauses: [5] }).length >= 1);
});

test('the configured contract exists and is internally consistent', () => {
  // The shelter supplied its real text; the owner confirmed it on 2026-10-16,
  // Bolivia time (portion 4c-1).
  assert.ok(ADOPTION_CONTRACT, 'ADOPTION_CONTRACT is null again');
  assert.deepEqual(contractProblems(ADOPTION_CONTRACT), []);
});

test('the contract is the paper: the COMPROMISOS heading, nine commitments, the 48-hour one in bold', () => {
  // Literals (owner decisions D8 and D10). The heading is printed on page 2
  // (the transcription was corrected on 2026-10-17), so it is the paper's
  // word, hashed. The emphasis is
  // presentation: it is NOT hashed, so only this pin catches a change to it.
  assert.ok(ADOPTION_CONTRACT);
  assert.equal(ADOPTION_CONTRACT.heading, 'COMPROMISOS');
  assert.equal(ADOPTION_CONTRACT.clauses.length, 9);
  assert.deepEqual([...ADOPTION_CONTRACT.emphasizedClauses], [2]);
  assert.ok(ADOPTION_CONTRACT.clauses[2]!.includes('48 horas'), 'the bold clause is no longer the 48-hour one');
  for (const clause of ADOPTION_CONTRACT.clauses) assert.ok(clause.startsWith('Me comprometo'), clause);
});

test('the printed heading is inside the hashed text, as its first block', () => {
  // Printed text, so it is part of what the hash proves was shown: dropping or
  // changing the heading must change the hash.
  assert.ok(ADOPTION_CONTRACT);
  const canonical = contractCanonicalText(ADOPTION_CONTRACT);
  assert.ok(canonical.startsWith('COMPROMISOS\n\nYo {nombre} mayor de edad'), 'the heading is not the first hashed block');
  const without = contractCanonicalText({ ...ADOPTION_CONTRACT, heading: null });
  assert.notEqual(
    createHash('sha256').update(without, 'utf8').digest('hex'),
    ADOPTION_CONTRACT.sha256,
    'the hash does not depend on the heading',
  );
});

test('the opening holds each blank exactly once, and no clause or the closing holds either', () => {
  assert.ok(ADOPTION_CONTRACT);
  assert.equal(occurrences(ADOPTION_CONTRACT.opening, CONTRACT_NAME_TOKEN), 1);
  assert.equal(occurrences(ADOPTION_CONTRACT.opening, CONTRACT_CI_TOKEN), 1);
  assert.ok(
    ADOPTION_CONTRACT.opening.indexOf(CONTRACT_NAME_TOKEN) < ADOPTION_CONTRACT.opening.indexOf(CONTRACT_CI_TOKEN),
    'the name comes before the C.I., as on paper',
  );
  for (const text of [...ADOPTION_CONTRACT.clauses, ADOPTION_CONTRACT.closing]) {
    assert.equal(occurrences(text, CONTRACT_NAME_TOKEN), 0, text);
    assert.equal(occurrences(text, CONTRACT_CI_TOKEN), 0, text);
  }
});

test('every contract and paper-form string is NFC, one line, single-spaced and trimmed', () => {
  // A decomposed accent renders the same and hashes differently — the
  // shelter's text would silently stop matching the rules.
  assert.ok(ADOPTION_CONTRACT);
  const hints = config.questions.flatMap((q) => (q.hint ? [q.hint] : []));
  for (const text of [...contractStrings(ADOPTION_CONTRACT), ...paperFormStrings(), ...hints, ADOPTION_ACCEPTANCE.label]) {
    assert.equal(text, text.normalize('NFC'), `not NFC: ${text}`);
    assert.ok(!text.includes('\n') && !text.includes('\r'), `a line break: ${text}`);
    assert.ok(!/ {2}/.test(text), `a double space: ${text}`);
    assert.equal(text, text.trim(), `leading or trailing whitespace: ${text}`);
  }
});

test('no online text carries the paper signature line', () => {
  // Owner decision D11: signed in ink at handover, never online. Upper-case,
  // as the paper prints "FIRMA ADOPTANTE … FIRMA RESCATISTA"; the acceptance
  // legitimately says the contract "se firma en papel".
  assert.ok(ADOPTION_CONTRACT);
  for (const text of [...contractStrings(ADOPTION_CONTRACT), ...paperFormStrings(), ADOPTION_ACCEPTANCE.label]) {
    assert.ok(!/FIRMA|ADOPTANTE|RESCATISTA/.test(text), text);
    assert.ok(!text.includes('…'), `a dotted blank survived: ${text}`);
  }
});

test("the shelter's original spelling is kept, exactly", () => {
  // Owner decision (plan 4c, "the original spelling is kept exactly"): the
  // lawyer-approved paper is reproduced as
  // printed. These are NOT typos to fix — a "correction" changes the approved
  // text and the hash. Literal tripwires on the forms most likely to be fixed.
  assert.ok(ADOPTION_CONTRACT);
  const contract = contractStrings(ADOPTION_CONTRACT).join(' ');
  for (const word of ['no lo sacare a la calle', 'ENCARGADO DE ADOPCION TIENEN', 'CORRESPONDIENTES SANSIONES']) {
    assert.ok(contract.includes(word), `the contract no longer says «${word}»`);
  }
  assert.ok(config.formIntro.includes('los requisitos aqui contenidos'), 'the form intro no longer says «aqui»');
  assert.ok(
    config.questions.some((q) => q.label === '¿QUE TIPO DE INMUEBLE POSEE?'),
    'the housing question no longer reads «¿QUE TIPO…» as printed',
  );
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
  assert.ok(create.includes('/private/identity)'), 'the create no longer requires private/identity in the same batch');
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
      acceptance: { accepted: true, contractVersion: ADOPTION_CONTRACT?.version ?? '' },
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
    ...ANSWER_ERRORS.map((error) => es.applicationAnswerError(error)),
    // Ours: every hint, and the acceptance draft.
    ...config.questions.map((q) => q.hint ?? ''),
    ADOPTION_ACCEPTANCE.label,
    // The paper's (usted forms — "posee", "coloque", "Planea" — never voseo).
    ...paperFormStrings(),
  );
  return out.filter((s) => s !== '');
}

const ANSWER_ERRORS: ApplicationAnswerError[] = [
  'required',
  'too-long',
  'phone-invalid',
  'id-number-invalid',
  'count-invalid',
  'under-age',
  'choice-invalid',
];

test('the under-age and C.I. errors say what to do, and under-age offers WhatsApp', () => {
  assert.match(es.applicationAnswerError('under-age'), /mayor de edad/);
  assert.match(es.applicationAnswerError('under-age'), /WhatsApp/);
  assert.match(es.applicationAnswerError('id-number-invalid'), /carnet/);
  for (const error of ANSWER_ERRORS) assert.ok(es.applicationAnswerError(error).trim() !== '', error);
});

test('no application copy and no question speaks voseo', () => {
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
