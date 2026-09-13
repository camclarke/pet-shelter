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

import {
  APPLICATION_STATUS_TRANSITIONS,
  ApprovalBlockedError,
  IllegalApplicationTransition,
  SERVER_TIME,
  adminStatusPatch,
  applicantCanWithdraw,
  applicantLabel,
  applicantPhone,
  applicationIdFor,
  approvalCheck,
  buildApplicationCreate,
  buildApprovalWrites,
  canTransitionApplication,
  choiceLabel,
  emptyAnswerDraft,
  groupApplicationsByPet,
  isServerTime,
  parseApplicationId,
  phoneDigits,
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

const QUESTIONS: ApplicationQuestion[] = [
  { id: 'fullName', section: 'contact', label: 'Nombre', kind: 'shortText', required: true, purpose: 'applicantName' },
  { id: 'whatsapp', section: 'contact', label: 'WhatsApp', kind: 'phone', required: true, purpose: 'applicantPhone' },
  {
    id: 'housingType',
    section: 'housing',
    label: 'Vivienda',
    kind: 'choice',
    required: true,
    options: [
      { value: 'house', label: 'Casa' },
      { value: 'apartment', label: 'Departamento' },
    ],
  },
  { id: 'children', section: 'household', label: 'Niños', kind: 'count', required: true, max: 30 },
  { id: 'hoursAlone', section: 'experience', label: 'Horas', kind: 'count', required: false, max: 24 },
  { id: 'agrees', section: 'household', label: 'Acuerdo', kind: 'yesNo', required: true },
  { id: 'otherPets', section: 'otherPets', label: 'Otros', kind: 'longText', required: false },
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

test('a new application starts submitted with every decision field null', () => {
  const write = buildApplicationCreate({
    petId: 'pet1',
    applicantUid: 'uid1',
    applicantEmail: 'a@example.com',
    applicantEmailVerified: false,
    answers: { fullName: 'Ana' },
  });
  assert.equal(write.status, 'submitted');
  assert.equal(write.decidedAt, null);
  assert.equal(write.decidedBy, null);
  assert.equal(write.withdrawnAt, null);
  assert.ok(isServerTime(write.submittedAt));
  assert.ok(isServerTime(write.updatedAt));
});

// ─── approval ───────────────────────────────────────────────────────────────

const APP_ID = 'pet1__uidAna';

function input(over: Partial<ApprovalInput> = {}): ApprovalInput {
  return {
    application: {
      id: APP_ID,
      petId: 'pet1',
      applicantUid: 'uidAna',
      applicantEmail: 'ana@example.com',
      applicantEmailVerified: true,
      status: 'interview',
    },
    pet: { id: 'pet1', status: 'available' },
    otherApplications: [],
    hasRecordedLocation: false,
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
