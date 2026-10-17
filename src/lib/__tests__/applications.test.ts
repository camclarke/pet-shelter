/**
 * Online adoption applications — build-order step 14, plan §6.
 *
 * Run with:  node --test --import tsx src/lib/__tests__/applications.test.ts
 *
 * The three things worth a test are the ones that decide what reaches another
 * document: the transition table, the duplicate guard (the document id), and
 * the approval batch. Thresholds and expected statuses are LITERALS, never read
 * back from the module — a test that compares a function against the constant
 * it uses cannot fail when the constant is wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  APPLICATION_STATUS_TRANSITIONS,
  ApprovalBlockedError,
  CI_MAX_CHARS,
  CI_MIN_CHARS,
  ContractNotAcceptedError,
  ContractUnavailableError,
  IDENTITY_AGE_MAX,
  IDENTITY_AGE_MIN,
  IDENTITY_ANSWER_MAX_CHARS,
  IDENTITY_REQUIRED_KEYS,
  IllegalApplicationTransition,
  InvalidIdentityError,
  PRIVATE_DOCUMENT_IDS,
  SERVER_TIME,
  adminStatusPatch,
  applicantCanWithdraw,
  applicantLabel,
  applicantPhone,
  applicationIdFor,
  approvalCheck,
  buildApplicationCreate,
  buildApprovalWrites,
  buildIdentityCreate,
  canTransitionApplication,
  choiceLabel,
  emptyAnswerDraft,
  groupApplicationsByPet,
  idDocumentComplete,
  isQuestionAsked,
  isServerTime,
  parseApplicationId,
  phoneDigits,
  requireAcceptance,
  splitAnswersByStore,
  tidyIdNumber,
  validateAnswers,
  withdrawalPatch,
  type ApprovalInput,
  type WriteOp,
} from '../applications';
import type { ApplicationQuestion } from '@/config/shelter';
import type { ApplicationStatus, PetStatus } from '../types';

// ─── the transition table ───────────────────────────────────────────────────

const ALL: ApplicationStatus[] = [
  'submitted',
  'reviewing',
  'interview',
  'approved',
  'rejected',
  'withdrawn',
];

test('every status has an entry, and every target is a real status', () => {
  const statuses = Object.keys(APPLICATION_STATUS_TRANSITIONS) as ApplicationStatus[];
  assert.equal(statuses.length, 6);
  for (const from of statuses) {
    for (const to of APPLICATION_STATUS_TRANSITIONS[from]) {
      assert.ok(ALL.includes(to), `${from} → ${to} targets an unknown status`);
    }
  }
});

test('an approval is terminal: nothing moves an approved application', () => {
  // Undoing an adoption is a re-admission of the ANIMAL, not a status flip on
  // the application. A reachable approved → reviewing would leave an
  // adoptions/{petId} document naming an owner the queue says is undecided.
  for (const to of ALL) {
    assert.equal(canTransitionApplication('approved', to), false, `approved → ${to}`);
  }
});

test('a withdrawal is terminal: the shelter does not undo it for the applicant', () => {
  for (const to of ALL) {
    assert.equal(canTransitionApplication('withdrawn', to), false, `withdrawn → ${to}`);
  }
});

test('nothing is approved without first being in review or interview', () => {
  assert.equal(canTransitionApplication('submitted', 'approved'), false);
  assert.equal(canTransitionApplication('rejected', 'approved'), false);
  assert.equal(canTransitionApplication('reviewing', 'approved'), true);
  assert.equal(canTransitionApplication('interview', 'approved'), true);
});

test('a rejection can be reconsidered, but only back into review', () => {
  // A mis-tap on "Rechazar" on a phone must not turn a family down for good.
  assert.deepEqual([...APPLICATION_STATUS_TRANSITIONS.rejected], ['reviewing']);
});

test('a same-status write is not a legal transition', () => {
  for (const status of ALL) {
    assert.equal(canTransitionApplication(status, status), false, status);
  }
});

test('nothing ever moves back to submitted', () => {
  for (const from of ALL) {
    assert.equal(canTransitionApplication(from, 'submitted'), false, `${from} → submitted`);
  }
});

test('the applicant may withdraw exactly the open statuses', () => {
  assert.deepEqual(
    ALL.filter(applicantCanWithdraw),
    ['submitted', 'reviewing', 'interview'],
  );
});

// ─── status patches ─────────────────────────────────────────────────────────

test('a withdrawal patch touches exactly status, withdrawnAt and updatedAt', () => {
  // The rule gates on the DIFF. One more key — even a harmless-looking
  // `decidedBy: null` — is one edit away from a refused write.
  const patch = withdrawalPatch('interview');
  assert.deepEqual(Object.keys(patch).sort(), ['status', 'updatedAt', 'withdrawnAt']);
  assert.equal(patch.status, 'withdrawn');
  assert.ok(isServerTime(patch.withdrawnAt));
  assert.ok(isServerTime(patch.updatedAt));
});

test('an applicant cannot withdraw a closed application', () => {
  for (const from of ['approved', 'rejected', 'withdrawn'] as const) {
    assert.throws(() => withdrawalPatch(from), IllegalApplicationTransition, from);
  }
});

test('a decision carries who and when; anything else carries neither', () => {
  const rejected = adminStatusPatch('reviewing', 'rejected', 'admin-1');
  assert.equal(rejected.decidedBy, 'admin-1');
  assert.ok(isServerTime(rejected.decidedAt));
  assert.equal(rejected.withdrawnAt, null);

  const interview = adminStatusPatch('submitted', 'interview', 'admin-1');
  assert.equal(interview.decidedBy, null);
  assert.equal(interview.decidedAt, null);
});

test('reopening a rejection clears the decision rather than keeping a stale one', () => {
  const reopened = adminStatusPatch('rejected', 'reviewing', 'admin-2');
  assert.equal(reopened.status, 'reviewing');
  assert.equal(reopened.decidedAt, null);
  assert.equal(reopened.decidedBy, null);
});

test('an admin recording a withdrawal sets withdrawnAt', () => {
  const patch = adminStatusPatch('reviewing', 'withdrawn', 'admin-1');
  assert.ok(isServerTime(patch.withdrawnAt));
  assert.equal(patch.decidedBy, null);
});

test('an illegal or unattributed admin change throws instead of producing a patch', () => {
  assert.throws(() => adminStatusPatch('submitted', 'approved', 'admin-1'), IllegalApplicationTransition);
  assert.throws(() => adminStatusPatch('approved', 'reviewing', 'admin-1'), IllegalApplicationTransition);
  assert.throws(() => adminStatusPatch('reviewing', 'rejected', ''));
});

// ─── the duplicate guard: the document id ───────────────────────────────────

test('the same person applying for the same animal always gets the same id', () => {
  // THIS is the duplicate guard. A second submission addresses the same
  // document, so Firestore evaluates it as an update the applicant may not make.
  assert.equal(applicationIdFor('pet123', 'uidABC'), 'pet123__uidABC');
  assert.equal(applicationIdFor('pet123', 'uidABC'), applicationIdFor('pet123', 'uidABC'));
});

test('a different person, or a different animal, gets a different id', () => {
  const base = applicationIdFor('pet123', 'uidABC');
  assert.notEqual(applicationIdFor('pet123', 'uidXYZ'), base);
  assert.notEqual(applicationIdFor('pet999', 'uidABC'), base);
});

test('an id segment containing the separator or a slash is refused', () => {
  // Otherwise "a__b" + "c" and "a" + "b__c" would collide on "a__b__c", and a
  // slash would address a different document path entirely.
  assert.throws(() => applicationIdFor('a__b', 'c'));
  assert.throws(() => applicationIdFor('a', 'b__c'));
  assert.throws(() => applicationIdFor('pets/x', 'c'));
  assert.throws(() => applicationIdFor('', 'c'));
  assert.throws(() => applicationIdFor('p', ''));
});

test('an id parses back into its pet and applicant, and a malformed one does not', () => {
  assert.deepEqual(parseApplicationId('pet123__uidABC'), { petId: 'pet123', applicantUid: 'uidABC' });
  assert.equal(parseApplicationId('pet123'), null);
  assert.equal(parseApplicationId('a__b__c'), null);
  assert.equal(parseApplicationId('__uid'), null);
});

// ─── answers ────────────────────────────────────────────────────────────────

// A fixture, not the shelter's questions: ids and kinds chosen to exercise every
// branch of the validator, on the paper's three sections.
const QUESTIONS: ApplicationQuestion[] = [
  { id: 'fullName', section: 'personal', store: 'application', label: 'Nombre', kind: 'shortText', required: true, purpose: 'applicantName' },
  { id: 'whatsapp', section: 'personal', store: 'application', label: 'WhatsApp', kind: 'phone', required: true, purpose: 'applicantPhone' },
  {
    id: 'housingType',
    section: 'home',
    store: 'application',
    label: 'Vivienda',
    kind: 'choice',
    required: true,
    options: [
      { value: 'house', label: 'Casa' },
      { value: 'apartment', label: 'Departamento' },
    ],
  },
  { id: 'children', section: 'home', store: 'application', label: 'Niños', kind: 'count', required: true, max: 30 },
  { id: 'hoursAlone', section: 'home', store: 'application', label: 'Horas', kind: 'count', required: false, max: 24 },
  { id: 'agrees', section: 'home', store: 'application', label: 'Acuerdo', kind: 'yesNo', required: true },
  { id: 'otherPets', section: 'references', store: 'application', label: 'Otros', kind: 'longText', required: false },
];

function filled(over: Record<string, string | boolean | null> = {}) {
  return {
    ...emptyAnswerDraft(QUESTIONS),
    fullName: 'Ana Pérez',
    whatsapp: '+591 7000 0000',
    housingType: 'house',
    children: '2',
    agrees: true,
    ...over,
  };
}

test('an empty draft has a slot per question, null only for yes/no', () => {
  const draft = emptyAnswerDraft(QUESTIONS);
  assert.equal(Object.keys(draft).length, 7);
  assert.equal(draft.agrees, null);
  assert.equal(draft.fullName, '');
});

test('a complete form validates into typed answers', () => {
  const { answers, valid, errors } = validateAnswers(QUESTIONS, filled());
  assert.equal(valid, true, JSON.stringify(errors));
  assert.deepEqual(answers, {
    fullName: 'Ana Pérez',
    whatsapp: '+591 7000 0000',
    housingType: 'house',
    children: 2,
    agrees: true,
  });
});

test('an unanswered optional question is ABSENT, never null', () => {
  // The rules treat an explicit null as a malformed answer.
  const { answers } = validateAnswers(QUESTIONS, filled({ otherPets: '   ', hoursAlone: '' }));
  assert.equal('otherPets' in answers, false);
  assert.equal('hoursAlone' in answers, false);
  assert.ok(Object.values(answers).every((v) => v !== null));
});

test('every required question left empty is named', () => {
  const { valid, errors } = validateAnswers(QUESTIONS, emptyAnswerDraft(QUESTIONS));
  assert.equal(valid, false);
  assert.deepEqual(Object.keys(errors).sort(), ['agrees', 'children', 'fullName', 'housingType', 'whatsapp']);
  assert.ok(Object.values(errors).every((e) => e === 'required'));
});

test('a yes/no answer of false is an answer, not a missing one', () => {
  const { answers, errors } = validateAnswers(QUESTIONS, filled({ agrees: false }));
  assert.equal(answers.agrees, false);
  assert.equal(errors.agrees, undefined);
});

test('a count is a whole number within its maximum, and nothing else', () => {
  assert.equal(validateAnswers(QUESTIONS, filled({ children: '0' })).answers.children, 0);
  for (const bad of ['2.5', '2,5', '-1', 'dos', '31', '100']) {
    assert.equal(validateAnswers(QUESTIONS, filled({ children: bad })).errors.children, 'count-invalid', bad);
  }
  // Its own maximum, not the default: 24 hours in a day.
  assert.equal(validateAnswers(QUESTIONS, filled({ hoursAlone: '24' })).answers.hoursAlone, 24);
  assert.equal(validateAnswers(QUESTIONS, filled({ hoursAlone: '25' })).errors.hoursAlone, 'count-invalid');
});

test('a choice stores the option value, and an unknown value is an error', () => {
  assert.equal(validateAnswers(QUESTIONS, filled({ housingType: 'apartment' })).answers.housingType, 'apartment');
  assert.equal(validateAnswers(QUESTIONS, filled({ housingType: 'Casa' })).errors.housingType, 'choice-invalid');
});

test('a phone number accepts how people type it and refuses a name', () => {
  assert.equal(phoneDigits('7790 3553'), '77903553');
  assert.equal(phoneDigits('+591 (7) 790-3553'), '59177903553');
  assert.equal(phoneDigits('Ana'), null);
  assert.equal(phoneDigits('123'), null);
  assert.equal(phoneDigits('1234567890123456'), null);
  assert.equal(validateAnswers(QUESTIONS, filled({ whatsapp: 'mi cel' })).errors.whatsapp, 'phone-invalid');
});

test('a short answer collapses whitespace; a long one keeps its paragraphs', () => {
  const { answers } = validateAnswers(
    QUESTIONS,
    filled({ fullName: '  Ana    Pérez ', otherPets: 'Un gato.\n\n\n\nY un perro   viejo.' }),
  );
  assert.equal(answers.fullName, 'Ana Pérez');
  assert.equal(answers.otherPets, 'Un gato.\n\nY un perro viejo.');
});

test('answers over the length limit are refused rather than cut', () => {
  // Cutting would store a sentence the applicant never wrote.
  const { errors } = validateAnswers(
    QUESTIONS,
    filled({ fullName: 'a'.repeat(121), otherPets: 'b'.repeat(1501) }),
  );
  assert.equal(errors.fullName, 'too-long');
  assert.equal(errors.otherPets, 'too-long');
  assert.equal(validateAnswers(QUESTIONS, filled({ otherPets: 'b'.repeat(1500) })).errors.otherPets, undefined);
});

test('a key that is not a configured question is dropped, never stored', () => {
  // The rules refuse unknown keys; a stale field from an older form must not
  // make the whole application fail, and must not be written either.
  const { answers, valid } = validateAnswers(QUESTIONS, { ...filled(), internalNotes: 'hola', status: 'approved' });
  assert.equal(valid, true);
  assert.equal('internalNotes' in answers, false);
  assert.equal('status' in answers, false);
});

test('the applicant is named by the name answer, or by email when there is none', () => {
  const app = { answers: { fullName: 'Ana Pérez', whatsapp: '7000 0000' }, applicantEmail: 'ana@example.com' };
  assert.equal(applicantLabel(QUESTIONS, app), 'Ana Pérez');
  assert.equal(applicantLabel(QUESTIONS, { ...app, answers: {} }), 'ana@example.com');
  assert.equal(applicantPhone(QUESTIONS, app), '7000 0000');
  assert.equal(applicantPhone(QUESTIONS, { answers: {} }), null);
});

test('a stored choice whose option was removed still renders its raw value', () => {
  assert.equal(choiceLabel(QUESTIONS[2], 'house'), 'Casa');
  assert.equal(choiceLabel(QUESTIONS[2], 'boat'), 'boat');
  assert.equal(choiceLabel(undefined, 'boat'), 'boat');
});

// ─── portion 4c-1: askedWhen, the C.I., a minimum, and the two stores ───────

/** A fixture shaped like the paper form, so the identity branch is exercised. */
const PAPER: ApplicationQuestion[] = [
  { id: 'fullName', section: 'personal', store: 'application', label: 'N', kind: 'shortText', required: true, purpose: 'applicantName' },
  { id: 'ciNumber', section: 'personal', store: 'identity', label: 'C', kind: 'idNumber', required: true },
  { id: 'age', section: 'personal', store: 'identity', label: 'E', kind: 'count', required: true, min: 18, max: 99 },
  { id: 'landline', section: 'personal', store: 'identity', label: 'F', kind: 'phone', required: false },
  { id: 'personalRefName', section: 'references', store: 'identity', label: 'R', kind: 'shortText', required: true },
  {
    id: 'housingType',
    section: 'home',
    store: 'application',
    label: 'T',
    kind: 'choice',
    required: true,
    options: [
      { value: 'house', label: 'CASA' },
      { value: 'apartment', label: 'DEPARTAMENTO' },
      { value: 'farm', label: 'FINCA' },
    ],
  },
  {
    id: 'housingTenure',
    section: 'home',
    store: 'application',
    label: 'P',
    kind: 'choice',
    required: true,
    options: [
      { value: 'owned', label: 'PROPIO' },
      { value: 'rented', label: 'ARRENDADO' },
    ],
  },
  {
    id: 'landlordName',
    section: 'home',
    store: 'identity',
    label: 'D',
    kind: 'shortText',
    required: true,
    askedWhen: { questionId: 'housingTenure', values: ['rented'] },
  },
  {
    id: 'walled',
    section: 'home',
    store: 'application',
    label: 'A',
    kind: 'yesNo',
    required: true,
    askedWhen: { questionId: 'housingType', values: ['house', 'farm'] },
  },
];

function paper(over: Record<string, string | boolean | null> = {}) {
  return {
    ...emptyAnswerDraft(PAPER),
    fullName: 'Ana Pérez',
    ciNumber: '1234567 LP',
    age: '30',
    personalRefName: 'Rosa Quispe',
    housingType: 'apartment',
    housingTenure: 'owned',
    ...over,
  };
}

test('a question whose askedWhen is not met is neither required nor stored', () => {
  // A landlord typed while ARRENDADO was chosen, then hidden by switching to
  // PROPIO, must not be written — it would be a stranger's name kept for no reason.
  const owned = validateAnswers(PAPER, paper({ landlordName: 'Don Pedro' }));
  assert.equal(owned.valid, true, JSON.stringify(owned.errors));
  assert.equal('landlordName' in owned.answers, false);
  // An apartment is never asked "amurallado", so leaving it empty is fine.
  assert.equal('walled' in owned.answers, false);
});

test('a question whose askedWhen IS met is required and stored', () => {
  const rented = validateAnswers(PAPER, paper({ housingTenure: 'rented' }));
  assert.equal(rented.errors.landlordName, 'required');
  assert.equal(
    validateAnswers(PAPER, paper({ housingTenure: 'rented', landlordName: '  Don   Pedro ' })).answers.landlordName,
    'Don Pedro',
  );
  // CASA and FINCA are asked "amurallado"; a false answer is an answer.
  assert.equal(validateAnswers(PAPER, paper({ housingType: 'house' })).errors.walled, 'required');
  assert.equal(validateAnswers(PAPER, paper({ housingType: 'farm', walled: false })).answers.walled, false);
});

test('isQuestionAsked follows the controlling answer, on a draft and on stored answers alike', () => {
  const walled = PAPER.find((q) => q.id === 'walled')!;
  assert.equal(isQuestionAsked(PAPER, walled, { housingType: 'house' }), true);
  assert.equal(isQuestionAsked(PAPER, walled, { housingType: ' farm ' }), true, 'a draft value is trimmed');
  assert.equal(isQuestionAsked(PAPER, walled, { housingType: 'apartment' }), false);
  assert.equal(isQuestionAsked(PAPER, walled, {}), false);
  assert.equal(isQuestionAsked(PAPER, PAPER[0]!, {}), true, 'no askedWhen: always asked');
  // A condition on a missing question, or a loop, is refused rather than followed.
  const orphan = { ...walled, askedWhen: { questionId: 'nope', values: ['x'] } };
  assert.equal(isQuestionAsked([...PAPER, orphan], orphan, { nope: 'x' }), false);
  const a = { ...walled, id: 'a', askedWhen: { questionId: 'b', values: [true] } };
  const b = { ...walled, id: 'b', askedWhen: { questionId: 'a', values: [true] } };
  assert.equal(isQuestionAsked([a, b], a, { a: true, b: true }), false);
});

test('a C.I. is accepted as typed, tidied, and never upper-cased or split', () => {
  for (const [typed, stored] of [
    ['1234567', '1234567'],
    ['  1234567   LP ', '1234567 LP'],
    ['1234567-1B', '1234567-1B'],
    ['12.345.678', '12.345.678'],
    ['4567890 cb', '4567890 cb'],
    ['Ñ 1234', 'Ñ 1234'],
    ['1234', '1234'],
    ['12345678901234567890', '12345678901234567890'],
  ] as const) {
    assert.equal(tidyIdNumber(typed), stored, typed);
    assert.equal(validateAnswers(PAPER, paper({ ciNumber: typed })).answers.ciNumber, stored, typed);
  }
  // A decomposed Ñ is composed before the charset check.
  // Built with normalize() rather than typed, so the source holds no invisible
  // combining mark (N + U+0303 is what some keyboards send for Ñ).
  const decomposed = 'Ñ 1234'.normalize('NFD');
  assert.notEqual(decomposed, 'Ñ 1234', 'control: the input really is decomposed');
  assert.equal(tidyIdNumber(decomposed), 'Ñ 1234');
});

test('a C.I. that cannot be one is refused, not cut', () => {
  // Literals: 4 to 20 characters, at least 4 digits, letters (Ñ), digits,
  // spaces, dots and dashes only.
  for (const bad of ['123', 'abcd', 'LP 123', '123456789012345678901', '1234567/LP', '1234567#', 'Ana Pérez', '12é45']) {
    assert.equal(tidyIdNumber(bad), null, bad);
    assert.equal(validateAnswers(PAPER, paper({ ciNumber: bad })).errors.ciNumber, 'id-number-invalid', bad);
  }
  assert.equal(validateAnswers(PAPER, paper({ ciNumber: '   ' })).errors.ciNumber, 'required');
});

test('an age under the minimum is under-age; 18 and 99 are accepted; 100 is not a count', () => {
  // Literals: the contract says "mayor de edad" (owner decision D4).
  assert.equal(validateAnswers(PAPER, paper({ age: '17' })).errors.age, 'under-age');
  assert.equal(validateAnswers(PAPER, paper({ age: '0' })).errors.age, 'under-age');
  assert.equal(validateAnswers(PAPER, paper({ age: '18' })).answers.age, 18);
  assert.equal(validateAnswers(PAPER, paper({ age: '99' })).answers.age, 99);
  assert.equal(validateAnswers(PAPER, paper({ age: '100' })).errors.age, 'count-invalid');
  assert.equal(validateAnswers(PAPER, paper({ age: '18.5' })).errors.age, 'count-invalid');
});

test('splitAnswersByStore puts each answer in its own document and drops unknown keys', () => {
  const { answers } = validateAnswers(PAPER, paper({ housingTenure: 'rented', landlordName: 'Don Pedro', landline: '4 4251234' }));
  const split = splitAnswersByStore(PAPER, { ...answers, stray: 'x' });
  assert.deepEqual(split.application, { fullName: 'Ana Pérez', housingType: 'apartment', housingTenure: 'rented' });
  assert.deepEqual(split.identity, {
    ciNumber: '1234567 LP',
    age: 30,
    landline: '4 4251234',
    personalRefName: 'Rosa Quispe',
    landlordName: 'Don Pedro',
  });
});

test('the identity document has exactly applicantUid, answers and createdAt', () => {
  const write = buildIdentityCreate({
    applicantUid: 'uidAna',
    identity: { ciNumber: '1234567 LP', age: 30, personalRefName: 'Rosa Quispe' },
    questions: PAPER,
  });
  assert.deepEqual(Object.keys(write).sort(), ['answers', 'applicantUid', 'createdAt']);
  assert.equal(write.applicantUid, 'uidAna');
  assert.ok(isServerTime(write.createdAt), 'createdAt must be the server clock');
  assert.deepEqual(write.answers, { ciNumber: '1234567 LP', age: 30, personalRefName: 'Rosa Quispe' });
});

test('the identity builder re-validates instead of trusting its argument', () => {
  // Each one is something the rules would refuse, or something the form would
  // never have produced from what a person typed.
  const base = { ciNumber: '1234567', age: 30 };
  const forged: Record<string, unknown>[] = [
    {},
    { age: 30 },
    { ciNumber: '1234567' },
    { ...base, age: 17 },
    { ...base, age: 100 },
    { ...base, age: 18.5 },
    { ...base, age: '30' },
    { ...base, ciNumber: '123' },
    { ...base, ciNumber: ' 1234567' },
    { ...base, ciNumber: 1234567 },
    { ...base, personalRefName: 'a'.repeat(121) },
    { ...base, personalRefName: 5 },
    { ...base, personalRefName: true },
    { ...base, personalRefName: '' },
    { ...base, personalRefName: 'Rosa  Quispe' },
    { ...base, landline: 'mi casa' },
    { ...base, fullName: 'Ana' },
    { ...base, stray: 'x' },
  ];
  for (const identity of forged) {
    assert.throws(
      () => buildIdentityCreate({ applicantUid: 'uidAna', identity: identity as never, questions: PAPER }),
      InvalidIdentityError,
      JSON.stringify(identity),
    );
  }
  assert.throws(() => buildIdentityCreate({ applicantUid: '', identity: base, questions: PAPER }));
  assert.doesNotThrow(() => buildIdentityCreate({ applicantUid: 'uidAna', identity: { ciNumber: '1234', age: 18 }, questions: PAPER }));
});

test('the identity limits are the ones the rules enforce', () => {
  // Literals, on purpose: firestore.rules says 120, 4..20, 18..99.
  assert.equal(IDENTITY_ANSWER_MAX_CHARS, 120);
  assert.equal(CI_MIN_CHARS, 4);
  assert.equal(CI_MAX_CHARS, 20);
  assert.equal(IDENTITY_AGE_MIN, 18);
  assert.equal(IDENTITY_AGE_MAX, 99);
  assert.deepEqual([...IDENTITY_REQUIRED_KEYS], ['ciNumber', 'age']);
  assert.deepEqual([...PRIVATE_DOCUMENT_IDS], ['home', 'identity']);
});

// A contract acceptance for the tests only. The text is the fixture string
// application-config.test.ts forbids anywhere outside __tests__.
const TEST_CONTRACT = {
  version: '2000-01-01',
  sha256: createHash('sha256').update('TEXTO DE PRUEBA').digest('hex'),
};

type CreateInput = Parameters<typeof buildApplicationCreate>[0];

function createInput(over: Partial<CreateInput> = {}): CreateInput {
  return {
    petId: 'pet1',
    applicantUid: 'uid1',
    applicantEmail: 'a@example.com',
    applicantEmailVerified: false,
    answers: { fullName: 'Ana' },
    contract: TEST_CONTRACT,
    // The box ticked, under the version on screen.
    acceptance: { accepted: true, contractVersion: TEST_CONTRACT.version },
    ...over,
  };
}

test('a new application starts submitted with every decision field null', () => {
  const write = buildApplicationCreate(createInput());
  assert.equal(write.status, 'submitted');
  assert.equal(write.decidedAt, null);
  assert.equal(write.decidedBy, null);
  assert.equal(write.withdrawnAt, null);
  assert.ok(isServerTime(write.submittedAt));
  assert.ok(isServerTime(write.updatedAt));
});

test('a new application records the contract shown, the server clock, and no ID yet', () => {
  const write = buildApplicationCreate(createInput());
  assert.equal(write.contractVersion, '2000-01-01');
  assert.equal(write.contractSha256, TEST_CONTRACT.sha256);
  assert.ok(isServerTime(write.termsAcceptedAt), 'termsAcceptedAt must be the server clock');
  assert.equal(write.identityErasedAt, null);
  // The shelter asks for the front only (owner decision, 2026-10-16).
  assert.deepEqual(write.idDocument, { front: null });
});

test('the ID marker lists every configured side, each null', () => {
  const both = buildApplicationCreate(createInput({ idDocumentSides: ['front', 'back'] }));
  assert.deepEqual(both.idDocument, { front: null, back: null });
  assert.throws(() => buildApplicationCreate(createInput({ idDocumentSides: [] })));
});

test('THE CONTRACT TIE: with no contract, nothing can be accepted and no application is described', () => {
  // ADOPTION_CONTRACT is null until the shelter supplies its real text. The
  // rules refuse the create too (empty acceptedContracts()); this is the
  // browser half, which refuses before anything is sent.
  assert.throws(() => buildApplicationCreate(createInput({ contract: null })), ContractUnavailableError);
});

test('NO ACCEPTANCE, NO APPLICATION: an unticked box, a missing acceptance or another version all throw', () => {
  // Review 4c-1 #6. termsAcceptedAt and the contract pair are a record that
  // the person ticked the box for THIS text; nothing may write them otherwise.
  const refused: unknown[] = [
    { accepted: false, contractVersion: TEST_CONTRACT.version },
    { accepted: 'true', contractVersion: TEST_CONTRACT.version },
    { accepted: 1, contractVersion: TEST_CONTRACT.version },
    { contractVersion: TEST_CONTRACT.version },
    { accepted: true, contractVersion: '1999-12-31' },
    { accepted: true },
    undefined,
    null,
  ];
  for (const acceptance of refused) {
    assert.throws(
      () => buildApplicationCreate(createInput({ acceptance: acceptance as never })),
      ContractNotAcceptedError,
      JSON.stringify(acceptance) ?? String(acceptance),
    );
  }
  // The pure check the browser runs before any network call is the same one.
  assert.throws(() => requireAcceptance({ accepted: false, contractVersion: '2000-01-01' }, TEST_CONTRACT), ContractNotAcceptedError);
  assert.doesNotThrow(() => requireAcceptance({ accepted: true, contractVersion: '2000-01-01' }, TEST_CONTRACT));
  // And a ticked box under the version being recorded is accepted.
  assert.equal(buildApplicationCreate(createInput()).contractVersion, TEST_CONTRACT.version);
});

test('a missing contract is reported before a missing acceptance', () => {
  // The order matters for the message the browser gets: no contract at all
  // is the shelter's problem, not the applicant's.
  assert.throws(() => buildApplicationCreate(createInput({ contract: null, acceptance: undefined as never })), ContractUnavailableError);
});

test('a malformed contract version or hash is refused rather than written', () => {
  for (const contract of [
    { version: '16/10/2026', sha256: TEST_CONTRACT.sha256 },
    { version: '', sha256: TEST_CONTRACT.sha256 },
    { version: '2000-01-01', sha256: '' },
    { version: '2000-01-01', sha256: TEST_CONTRACT.sha256.toUpperCase() },
    { version: '2000-01-01', sha256: TEST_CONTRACT.sha256.slice(1) },
  ]) {
    assert.throws(() => buildApplicationCreate(createInput({ contract })), ContractUnavailableError, JSON.stringify(contract));
  }
});

// ─── approval ───────────────────────────────────────────────────────────────

const APP_ID = 'pet1__uidAna';

/** What the upload route writes once the front of the carnet is stored. */
const RECEIVED = { receivedAt: 1, bytes: 120_000, generation: '1760000000000000' };

function input(over: Partial<ApprovalInput> = {}): ApprovalInput {
  return {
    application: {
      id: APP_ID,
      petId: 'pet1',
      applicantUid: 'uidAna',
      applicantEmail: 'ana@example.com',
      applicantEmailVerified: true,
      status: 'interview',
      idDocument: { front: RECEIVED },
    },
    pet: { id: 'pet1', status: 'available' },
    otherApplications: [],
    hasRecordedLocation: false,
    hasAcceptanceRecord: true,
    adminUid: 'admin-1',
    holder: 'Ana Pérez',
    newCustodyId: 'cust-new',
    openCustodyIds: ['cust-shelter'],
    openPlacementIds: ['place-1'],
    ...over,
  };
}

function writeAt(writes: WriteOp[], path: string): WriteOp | undefined {
  return writes.find((w) => w.path.join('/') === path);
}

test('a clean approval has no blockers and no warnings', () => {
  const check = approvalCheck(input());
  assert.deepEqual(check.blockers, []);
  assert.deepEqual(check.warnings, []);
});

test('an animal that already belongs to a family BLOCKS approval', () => {
  // Checked explicitly because arrival.ts calls adopted → adopted a legal no-op.
  const check = approvalCheck(input({ pet: { id: 'pet1', status: 'adopted' } }));
  assert.deepEqual(check.blockers, ['pet-already-adopted']);
});

test('an animal arrival.ts will not let become adopted BLOCKS approval', () => {
  for (const status of ['inbound', 'quarantine', 'cancelled'] as PetStatus[]) {
    assert.deepEqual(approvalCheck(input({ pet: { id: 'pet1', status } })).blockers, ['pet-not-ready'], status);
  }
});

test('a missing pet BLOCKS approval', () => {
  assert.deepEqual(approvalCheck(input({ pet: null })).blockers, ['pet-missing']);
});

test('an application whose ID photo has not arrived BLOCKS approval', () => {
  // Owner decision, 2026-10-16. The rules refuse it too (idDocumentReceived()).
  for (const idDocument of [{ front: null }, {}, { back: RECEIVED }]) {
    const check = approvalCheck(input({ application: { ...input().application, idDocument } }));
    assert.deepEqual(check.blockers, ['id-document-missing'], JSON.stringify(idDocument));
  }
});

test('an application from before the ID marker existed reads as not received', () => {
  // No `idDocument` at all — the rules deny it the same way, because reading
  // a missing field errors.
  const legacy = { ...input().application } as Partial<ApprovalInput['application']>;
  delete legacy.idDocument;
  const check = approvalCheck(input({ application: legacy as ApprovalInput['application'] }));
  assert.ok(check.blockers.includes('id-document-missing'));
});

test('every configured side must have arrived, not just one', () => {
  assert.equal(idDocumentComplete({ front: RECEIVED }, ['front']), true);
  assert.equal(idDocumentComplete({ front: RECEIVED }, ['front', 'back']), false);
  assert.equal(idDocumentComplete({ front: RECEIVED, back: RECEIVED }, ['front', 'back']), true);
  assert.equal(idDocumentComplete({ front: RECEIVED }, []), false, 'no sides configured cannot mean "complete"');
  assert.equal(idDocumentComplete(null, ['front']), false);
  assert.deepEqual(
    approvalCheck(input(), ['front', 'back']).blockers,
    ['id-document-missing'],
    'the check reads the configured sides',
  );
});

test('a missing ID photo makes the approval batch throw, not commit', () => {
  assert.throws(
    () => buildApprovalWrites(input({ application: { ...input().application, idDocument: { front: null } } })),
    (error: unknown) => error instanceof ApprovalBlockedError && error.blockers.includes('id-document-missing'),
  );
});

test('without the recorded consent (private/acceptance) approval is blocked, and the batch throws', () => {
  assert.deepEqual(approvalCheck(input({ hasAcceptanceRecord: false })).blockers, ['acceptance-missing']);
  assert.deepEqual(approvalCheck(input()).blockers, [], 'the fixture itself approves');
  assert.throws(
    () => buildApprovalWrites(input({ hasAcceptanceRecord: false })),
    (error: unknown) => error instanceof ApprovalBlockedError && error.blockers.includes('acceptance-missing'),
  );
});

test('an application nobody moved into review BLOCKS approval', () => {
  for (const status of ['submitted', 'rejected', 'withdrawn', 'approved'] as ApplicationStatus[]) {
    const check = approvalCheck(input({ application: { ...input().application, status } }));
    assert.ok(check.blockers.includes('application-not-approvable'), status);
  }
});

test('other people still waiting on the same animal only WARN', () => {
  const check = approvalCheck(
    input({
      otherApplications: [
        { id: APP_ID, status: 'interview' }, // itself — never counted
        { id: 'pet1__uidBeto', status: 'submitted' },
        { id: 'pet1__uidCarla', status: 'reviewing' },
        { id: 'pet1__uidDani', status: 'rejected' }, // closed — not waiting
      ],
    }),
  );
  assert.deepEqual(check.blockers, []);
  assert.deepEqual(check.warnings, ['other-open-applications']);
  assert.deepEqual(check.otherOpenIds, ['pet1__uidBeto', 'pet1__uidCarla']);
});

test('an unverified email and an animal off the wall only WARN', () => {
  const check = approvalCheck(
    input({
      application: { ...input().application, applicantEmailVerified: false },
      pet: { id: 'pet1', status: 'foster' },
    }),
  );
  assert.deepEqual(check.blockers, []);
  assert.deepEqual(check.warnings.sort(), ['email-unverified', 'pet-not-on-wall']);
});

test('a recorded location only WARNS, because approving hands it to the new owner', () => {
  // It may be a foster volunteer's address (the project log concern #2) — or the
  // adopter's own area, recorded on purpose. Only a human can tell.
  const check = approvalCheck(input({ hasRecordedLocation: true }));
  assert.deepEqual(check.blockers, []);
  assert.deepEqual(check.warnings, ['location-will-be-visible']);
  assert.deepEqual(approvalCheck(input()).warnings, []);
});

test('the approval batch writes the application, the adoption, custody, placements and status', () => {
  const writes = buildApprovalWrites(input());
  assert.deepEqual(
    writes.map((w) => `${w.op} ${w.path.join('/')}`),
    [
      'update adoptionApplications/pet1__uidAna',
      'set adoptions/pet1',
      'update pets/pet1/custody/cust-shelter',
      'set pets/pet1/custody/cust-new',
      'update pets/pet1/placements/place-1',
      'set pets/pet1',
    ],
  );
});

test('the application is approved, attributed and timestamped', () => {
  const update = writeAt(buildApprovalWrites(input()), 'adoptionApplications/pet1__uidAna');
  assert.ok(update && update.op === 'update');
  assert.deepEqual(Object.keys(update.data).sort(), ['decidedAt', 'decidedBy', 'status', 'updatedAt', 'withdrawnAt']);
  assert.equal(update.data.status, 'approved');
  assert.equal(update.data.decidedBy, 'admin-1');
  assert.equal(update.data.decidedAt, SERVER_TIME);
  assert.equal(update.data.withdrawnAt, null);
});

test('the adoption names the APPLICANT as owner and links back to the application', () => {
  // ownerUid is what ownsPet() compares; applicationId is what the rules check
  // the approval against. Either one wrong hands the tiers to the wrong person
  // or gets the whole batch refused.
  const adoption = writeAt(buildApprovalWrites(input()), 'adoptions/pet1');
  assert.ok(adoption && adoption.op === 'set');
  assert.equal(adoption.merge, false);
  assert.deepEqual(adoption.data, {
    petId: 'pet1',
    ownerUid: 'uidAna',
    adoptedAt: SERVER_TIME,
    approvedBy: 'admin-1',
    applicationId: APP_ID,
  });
});

test('the pet becomes adopted by a MERGE, never a replace', () => {
  // A plain set would delete breed, coverPhoto and createdAt — the animal would
  // look like it vanished.
  const pet = writeAt(buildApprovalWrites(input()), 'pets/pet1');
  assert.ok(pet && pet.op === 'set');
  assert.equal(pet.merge, true);
  assert.deepEqual(pet.data, { status: 'adopted', updatedAt: SERVER_TIME });
});

test('every open custody record is closed and one adopter record is opened', () => {
  const writes = buildApprovalWrites(input({ openCustodyIds: ['c1', 'c2', 'c1'] }));
  const closed = writes.filter((w) => w.path[2] === 'custody' && w.op === 'update');
  assert.deepEqual(closed.map((w) => w.path[3]), ['c1', 'c2']);
  assert.ok(closed.every((w) => w.data.endedAt === SERVER_TIME));

  const opened = writeAt(writes, 'pets/pet1/custody/cust-new');
  assert.ok(opened && opened.op === 'set');
  assert.equal(opened.data.kind, 'adopter');
  assert.equal(opened.data.holderUid, 'uidAna');
  assert.equal(opened.data.holder, 'Ana Pérez');
  assert.equal(opened.data.endedAt, null);
  assert.equal(opened.data.recordedBy, 'admin-1');
});

test('an adopted animal leaves every pen it was still counted in', () => {
  const writes = buildApprovalWrites(input({ openPlacementIds: ['p1', 'p2'] }));
  const closed = writes.filter((w) => w.path[2] === 'placements');
  assert.deepEqual(closed.map((w) => w.path[3]), ['p1', 'p2']);
  assert.ok(closed.every((w) => w.op === 'update' && w.data.endedAt === SERVER_TIME));
});

test('approval never changes another application', () => {
  // Turning someone down is a conversation, not a side effect.
  const writes = buildApprovalWrites(
    input({ otherApplications: [{ id: 'pet1__uidBeto', status: 'submitted' }] }),
  );
  const applicationWrites = writes.filter((w) => w.path[0] === 'adoptionApplications');
  assert.equal(applicationWrites.length, 1);
  assert.equal(applicationWrites[0]!.path[1], APP_ID);
});

test('nothing the applicant answered is copied into any other document', () => {
  // A private person's housing and household stay in the application.
  const withAnswers = {
    ...input(),
    application: { ...input().application, answers: { zone: 'Zona Sarco', children: 3 } },
  } as ApprovalInput;
  const serialised = JSON.stringify(buildApprovalWrites(withAnswers));
  assert.equal(serialised.includes('Zona Sarco'), false);
  assert.equal(serialised.includes('answers'), false);
});

test('a blocked approval throws rather than returning writes', () => {
  assert.throws(
    () => buildApprovalWrites(input({ pet: { id: 'pet1', status: 'adopted' } })),
    (error: unknown) =>
      error instanceof ApprovalBlockedError && error.blockers.includes('pet-already-adopted'),
  );
});

test('an application paired with the wrong animal or a forged id throws', () => {
  assert.throws(() => buildApprovalWrites(input({ pet: { id: 'pet2', status: 'available' } })));
  assert.throws(() =>
    buildApprovalWrites(input({ application: { ...input().application, id: 'pet1__uidSomeoneElse' } })),
  );
  assert.throws(() => buildApprovalWrites(input({ adminUid: '' })));
});

test('an empty holder falls back to the email rather than an empty name', () => {
  const opened = writeAt(buildApprovalWrites(input({ holder: '  ' })), 'pets/pet1/custody/cust-new');
  assert.equal(opened?.data.holder, 'ana@example.com');
});

// ─── the queue ──────────────────────────────────────────────────────────────

const Q = [
  { id: 'a', petId: 'luna', status: 'submitted' as const, submittedAt: 300 },
  { id: 'b', petId: 'rocky', status: 'reviewing' as const, submittedAt: 100 },
  { id: 'c', petId: 'luna', status: 'interview' as const, submittedAt: 200 },
  { id: 'd', petId: 'luna', status: 'rejected' as const, submittedAt: 50 },
  { id: 'e', petId: 'nube', status: 'approved' as const, submittedAt: 10 },
];

test('the open queue groups by animal, oldest first in and across groups', () => {
  const groups = groupApplicationsByPet(Q, 'open');
  assert.deepEqual(
    groups.map((g) => [g.petId, g.applications.map((a) => a.id)]),
    [
      ['rocky', ['b']],
      ['luna', ['c', 'a']],
    ],
  );
});

test('a status filter shows only that status; "all" shows everything', () => {
  assert.deepEqual(
    groupApplicationsByPet(Q, 'rejected').map((g) => g.applications.map((a) => a.id)),
    [['d']],
  );
  assert.equal(
    groupApplicationsByPet(Q, 'all').reduce((n, g) => n + g.applications.length, 0),
    5,
  );
});
