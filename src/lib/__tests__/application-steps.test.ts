/**
 * The applicant's step-by-step form — the PURE layer (portion 4c-2, plan §5).
 *
 * Run with:  node --test --import tsx src/lib/__tests__/application-steps.test.ts
 *
 * What is pinned here, against the REAL configured questions (the shelter's
 * paper form) unless a test says otherwise:
 *   1. the seven steps, in the owner's order, and what each shows;
 *   2. "Continuar" is refused exactly when a step's own answers are wrong —
 *      the photo, the address, each section, the box;
 *   3. the conditional questions: the landlord only for ARRENDADO, amurallado
 *      only for CASA or FINCA — never shown, required, reviewed or sent
 *      otherwise, even after being typed;
 *   4. under-18 refused, by the form;
 *   5. one submission: answers, identity and home split by store, and NO
 *      acceptance inside it — the caller passes that explicitly;
 *   6. history entries never land past the furthest step reached;
 *   7. the review rows, the contract's blanks, and the pet's public facts.
 *
 * Every threshold is a LITERAL, so no test compares a constant with itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SHELTER } from '@/config/shelter';
import { CONTRACT_CI_TOKEN, CONTRACT_NAME_TOKEN } from '@/config/adoption-contract';
import {
  APPLICATION_STEPS,
  IncompleteSubmissionError,
  STEP_COUNT,
  addressReviewRows,
  buildSubmission,
  contractFill,
  firstInvalidStep,
  hasUnsentData,
  nextStep,
  petFactRows,
  previousStep,
  reviewRows,
  splitContractOpening,
  stepForHistory,
  stepFromNumber,
  stepNumber,
  stepMove,
  stepParam,
  stepQuestions,
  validateStep,
  type ApplicationStep,
  type StepIntent,
  type StepperState,
} from '../application-steps';
import { emptyAnswerDraft, type AnswerDraft } from '../applications';

const config = SHELTER.adoptionApplications;
const QUESTIONS = config.questions;

/** Every required field answered, as a person on a house they own would. */
function completeAnswers(overrides: AnswerDraft = {}): AnswerDraft {
  return {
    ...emptyAnswerDraft(QUESTIONS),
    fullName: 'Ana Pérez Rojas',
    ciNumber: '1234567 LP',
    age: '34',
    civilStatus: 'soltera',
    whatsapp: '+591 7790 3553',
    landline: '',
    personalRefName: 'Carla Méndez',
    personalRefPhone: '70712345',
    personalRefRelation: 'amiga',
    familyRefName: 'Luis Pérez',
    familyRefPhone: '71234567',
    familyRefRelation: 'hermano',
    housingType: 'apartment',
    housingTenure: 'owned',
    movingSoon: false,
    ...overrides,
  };
}

function state(overrides: Partial<StepperState> = {}): StepperState {
  return {
    answers: completeAnswers(),
    home: { addressText: 'Av. Blanco Galindo km 4, zona Sarco', reference: '', pin: null },
    photoReady: true,
    accepted: true,
    ...overrides,
  };
}

// ─── 1. the steps ────────────────────────────────────────────────────────────

test("seven steps in the owner's order: contract, carnet, address, personal, references, home, review", () => {
  assert.deepEqual(
    [...APPLICATION_STEPS],
    ['contract', 'carnet', 'address', 'personal', 'references', 'dwelling', 'review'],
  );
  assert.equal(STEP_COUNT, 7);
  assert.equal(stepNumber('contract'), 1);
  assert.equal(stepNumber('carnet'), 2);
  assert.equal(stepNumber('review'), 7);
  assert.equal(nextStep('dwelling'), 'review');
  assert.equal(nextStep('review'), null);
  assert.equal(previousStep('carnet'), 'contract');
  assert.equal(previousStep('contract'), null);
});

test("steps 4–6 show exactly the paper's three sections, in its order", () => {
  const empty = emptyAnswerDraft(QUESTIONS);
  assert.deepEqual(
    stepQuestions(QUESTIONS, 'personal', empty).map((q) => q.id),
    ['fullName', 'ciNumber', 'age', 'civilStatus', 'whatsapp', 'landline'],
  );
  assert.deepEqual(
    stepQuestions(QUESTIONS, 'references', empty).map((q) => q.id),
    ['personalRefName', 'personalRefPhone', 'personalRefRelation', 'familyRefName', 'familyRefPhone', 'familyRefRelation'],
  );
  // With nothing chosen yet, neither conditional question is shown.
  assert.deepEqual(stepQuestions(QUESTIONS, 'home', empty).map((q) => q.id), ['housingType', 'housingTenure', 'movingSoon']);
});

// ─── 2. when "Continuar" may move on ────────────────────────────────────────

test('the contract step never blocks; the carnet step blocks without a ready photo', () => {
  assert.equal(validateStep('contract', state({ photoReady: false, accepted: false }), QUESTIONS).valid, true);
  const refused = validateStep('carnet', state({ photoReady: false }), QUESTIONS);
  assert.equal(refused.valid, false);
  assert.equal(refused.stepError, 'photo-required');
  assert.equal(validateStep('carnet', state(), QUESTIONS).valid, true);
});

test('the address step blocks on the address, not on the optional details or the optional pin', () => {
  const missing = validateStep('address', state({ home: { addressText: '  ', reference: '', pin: null } }), QUESTIONS);
  assert.equal(missing.valid, false);
  assert.deepEqual(missing.homeErrors, { addressText: 'address-required' });
  // 4 characters refused, 5 accepted — HOME_ADDRESS_MIN_CHARS, as literals.
  assert.equal(validateStep('address', state({ home: { addressText: 'Sucr', reference: '', pin: null } }), QUESTIONS).homeErrors.addressText, 'address-too-short');
  assert.equal(validateStep('address', state({ home: { addressText: 'Sucre', reference: '', pin: null } }), QUESTIONS).valid, true);
  assert.equal(
    validateStep('address', state({ home: { addressText: 'Calle Sucre 123', reference: 'x'.repeat(301), pin: null } }), QUESTIONS).homeErrors.reference,
    'reference-too-long',
  );
  assert.equal(validateStep('address', state({ home: { addressText: 'Calle Sucre 123', reference: '', pin: null } }), QUESTIONS).valid, true);
  assert.equal(buildSubmission(state(), QUESTIONS).home.geo, null, 'a skipped map sends no pin');
  assert.equal(buildSubmission(state(), QUESTIONS).home.precision, null);
});

test('a marked pin is sent rounded to 4 decimals, as an exact point', () => {
  const marked = state({ home: { addressText: 'Calle Sucre 123', reference: '', pin: { latitude: -17.39351234, longitude: -66.15704987 } } });
  assert.equal(validateStep('address', marked, QUESTIONS).valid, true);
  const sent = buildSubmission(marked, QUESTIONS).home;
  assert.deepEqual(sent.geo, { latitude: -17.3935, longitude: -66.157 });
  assert.equal(sent.precision, 'exact');
});

test('a pin outside the service area stops step 3, on the pin, with the typed address untouched', () => {
  // Santa Cruz de la Sierra: far outside Cochabamba's box.
  const outside = state({ home: { addressText: 'Calle Sucre 123', reference: '', pin: { latitude: -17.7833, longitude: -63.1821 } } });
  const refused = validateStep('address', outside, QUESTIONS);
  assert.equal(refused.valid, false);
  assert.deepEqual(refused.homeErrors, { pin: 'pin-outside-area' });
  assert.throws(() => buildSubmission(outside, QUESTIONS));
});

test("a section step checks ONLY its own questions: a gap on step 6 never stops step 4", () => {
  const gap = state({ answers: completeAnswers({ housingType: '' }) });
  assert.equal(validateStep('personal', gap, QUESTIONS).valid, true);
  assert.equal(validateStep('references', gap, QUESTIONS).valid, true);
  const home = validateStep('dwelling', gap, QUESTIONS);
  assert.equal(home.valid, false);
  assert.deepEqual(home.answerErrors, { housingType: 'required' });
});

test('every personal field is required except CASA, the landline (D3)', () => {
  const blank = emptyAnswerDraft(QUESTIONS);
  const personal = validateStep('personal', state({ answers: blank }), QUESTIONS);
  assert.deepEqual(Object.keys(personal.answerErrors).sort(), ['age', 'ciNumber', 'civilStatus', 'fullName', 'whatsapp']);
  const references = validateStep('references', state({ answers: blank }), QUESTIONS);
  assert.equal(Object.keys(references.answerErrors).length, 6, 'both references, three fields each');
});

test('under-18 is refused by the form, 18 is accepted (the contract says «mayor de edad», D4)', () => {
  const at = (age: string) => validateStep('personal', state({ answers: completeAnswers({ age }) }), QUESTIONS);
  assert.equal(at('17').answerErrors.age, 'under-age');
  assert.equal(at('0').answerErrors.age, 'under-age');
  assert.equal(at('18').valid, true);
  assert.equal(at('99').valid, true);
  assert.equal(at('18.5').answerErrors.age, 'count-invalid');
});

test('a C.I. that is not one is refused before the step can be left', () => {
  const at = (ciNumber: string) => validateStep('personal', state({ answers: completeAnswers({ ciNumber }) }), QUESTIONS);
  assert.equal(at('abc').answerErrors.ciNumber, 'id-number-invalid');
  assert.equal(at('123').answerErrors.ciNumber, 'id-number-invalid');
  assert.equal(at('1234567-1B').valid, true);
});

test('the review step blocks only on the box, and "Enviar" re-checks every earlier step first', () => {
  const unticked = validateStep('review', state({ accepted: false }), QUESTIONS);
  assert.equal(unticked.valid, false);
  assert.equal(unticked.stepError, 'acceptance-required');
  assert.equal(validateStep('review', state(), QUESTIONS).valid, true);

  assert.equal(firstInvalidStep(state(), QUESTIONS), null);
  assert.equal(firstInvalidStep(state({ accepted: false }), QUESTIONS)?.step, 'review', 'the box is reported last');
  // An earlier gap wins over the box, in step order.
  const both = state({ accepted: false, photoReady: false, answers: completeAnswers({ fullName: '' }) });
  assert.equal(firstInvalidStep(both, QUESTIONS)?.step, 'carnet');
  assert.equal(firstInvalidStep(state({ answers: completeAnswers({ familyRefPhone: 'no' }) }), QUESTIONS)?.step, 'references');
});

// ─── 3. the conditional questions ───────────────────────────────────────────

test('the landlord is asked, required and sent ONLY for ARRENDADO', () => {
  const rented = completeAnswers({ housingTenure: 'rented' });
  assert.deepEqual(
    stepQuestions(QUESTIONS, 'home', rented).map((q) => q.id),
    ['housingType', 'housingTenure', 'landlordName', 'landlordPhone', 'movingSoon'],
  );
  const refused = validateStep('dwelling', state({ answers: rented }), QUESTIONS);
  assert.deepEqual(Object.keys(refused.answerErrors).sort(), ['landlordName', 'landlordPhone']);

  const named = completeAnswers({ housingTenure: 'rented', landlordName: 'Don Julio', landlordPhone: '4 4251234' });
  const sent = buildSubmission(state({ answers: named }), QUESTIONS);
  assert.equal(sent.identity.landlordName, 'Don Julio', 'a third party goes to private/identity');
  assert.ok(!('landlordName' in sent.answers), 'a third party never goes into answers');
});

test('a landlord typed and then hidden by switching to PROPIO is neither required, reviewed nor sent', () => {
  const switched = completeAnswers({ housingTenure: 'owned', landlordName: 'Don Julio', landlordPhone: '4 4251234' });
  assert.equal(validateStep('dwelling', state({ answers: switched }), QUESTIONS).valid, true);
  assert.ok(!reviewRows(QUESTIONS, 'home', switched).some((r) => r.id.startsWith('landlord')), 'reviewed while hidden');
  const sent = buildSubmission(state({ answers: switched }), QUESTIONS);
  assert.ok(!('landlordName' in sent.identity) && !('landlordPhone' in sent.identity), 'sent while hidden');
});

test('«amurallado» is asked only for CASA or FINCA, and required then', () => {
  for (const housingType of ['house', 'farm']) {
    const answers = completeAnswers({ housingType });
    assert.ok(stepQuestions(QUESTIONS, 'home', answers).some((q) => q.id === 'walled'), housingType);
    assert.equal(validateStep('dwelling', state({ answers }), QUESTIONS).answerErrors.walled, 'required', housingType);
    assert.equal(buildSubmission(state({ answers: { ...answers, walled: true } }), QUESTIONS).answers.walled, true);
  }
  const apartment = completeAnswers({ housingType: 'apartment', walled: true });
  assert.ok(!stepQuestions(QUESTIONS, 'home', apartment).some((q) => q.id === 'walled'));
  assert.equal(validateStep('dwelling', state({ answers: apartment }), QUESTIONS).valid, true);
  assert.ok(!('walled' in buildSubmission(state({ answers: apartment }), QUESTIONS).answers), 'sent for a DEPARTAMENTO');
});

// ─── 5. one submission ──────────────────────────────────────────────────────

test('the submission splits by store: identity and third parties never reach answers', () => {
  const sent = buildSubmission(state(), QUESTIONS);
  assert.deepEqual(Object.keys(sent.answers).sort(), ['fullName', 'housingTenure', 'housingType', 'movingSoon', 'whatsapp']);
  assert.deepEqual(
    Object.keys(sent.identity).sort(),
    ['age', 'ciNumber', 'civilStatus', 'familyRefName', 'familyRefPhone', 'familyRefRelation', 'personalRefName', 'personalRefPhone', 'personalRefRelation'],
  );
  assert.equal(sent.identity.age, 34, 'a count is stored as a number');
  assert.equal(sent.identity.ciNumber, '1234567 LP', 'a C.I. is stored as typed, never upper-cased or split');
  assert.ok(!('landline' in sent.identity), 'an unanswered optional question is absent, never null');
  assert.equal(sent.home.addressText, 'Av. Blanco Galindo km 4, zona Sarco');
});

test('the submission carries NO acceptance: the caller passes it explicitly', () => {
  const sent = buildSubmission(state(), QUESTIONS) as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(sent).sort(), ['answers', 'home', 'identity']);
  // And the box being unticked does not stop the build — the caller refuses that.
  assert.doesNotThrow(() => buildSubmission(state({ accepted: false }), QUESTIONS));
});

test('an incomplete submission throws, naming the step to send the person back to', () => {
  const cases: [Partial<StepperState>, string][] = [
    [{ photoReady: false }, 'carnet'],
    [{ home: { addressText: '', reference: '', pin: null } }, 'address'],
    [{ answers: completeAnswers({ age: '16' }) }, 'personal'],
    [{ answers: completeAnswers({ personalRefName: '' }) }, 'references'],
    [{ answers: completeAnswers({ movingSoon: null }) }, 'dwelling'],
  ];
  for (const [overrides, step] of cases) {
    assert.throws(
      () => buildSubmission(state(overrides), QUESTIONS),
      (err: unknown) => err instanceof IncompleteSubmissionError && err.step === step,
      step,
    );
  }
});

// ─── 6. history ─────────────────────────────────────────────────────────────

test('a history entry never lands past the furthest step reached, and a bad one lands on step 1', () => {
  assert.equal(stepForHistory(3, 5), 'address');
  assert.equal(stepForHistory(7, 3), 'address', 'the forward button skipped a check');
  assert.equal(stepForHistory(7, 7), 'review');
  assert.equal(stepForHistory(0, 5), 'contract');
  assert.equal(stepForHistory(-2, 5), 'contract');
  assert.equal(stepForHistory(2.5, 5), 'contract');
  assert.equal(stepForHistory(50, 99), 'review', 'furthest is clamped to the last step');
  assert.equal(stepFromNumber(8), null);
  assert.equal(stepFromNumber(1), 'contract');
});

test('stepMove: only "Continuar" pushes; «Atrás», «Cambiar» and the return to the review travel', () => {
  assert.deepEqual(stepMove({ kind: 'continue' }, 'carnet'), { kind: 'push', step: 'address' });
  assert.equal(stepMove({ kind: 'continue' }, 'review'), null);
  assert.deepEqual(stepMove({ kind: 'back' }, 'address'), { kind: 'go', step: 'carnet', delta: -1 });
  assert.equal(stepMove({ kind: 'back' }, 'contract'), null);
  assert.deepEqual(stepMove({ kind: 'edit', target: 'personal' }, 'review'), { kind: 'go', step: 'personal', delta: -3 });
  assert.deepEqual(stepMove({ kind: 'return-to-review' }, 'personal'), { kind: 'go', step: 'review', delta: 3 });
  assert.equal(stepMove({ kind: 'edit', target: 'review' }, 'review'), null, 'a travel of zero');
});

/**
 * The browser's history, simulated with the REAL moves — what review 4c-2's
 * history-sim.ts showed going FORWARD on the back gesture when «Atrás» pushed.
 * `push` adds an entry after the current one (dropping forward entries);
 * `go` moves through the existing ones; the gesture is `go(-1)`; the screen
 * shows `stepForHistory(entry, furthest)`.
 */
function simulate() {
  const entries: number[] = [0]; // 0: the guard entry the form opened in
  let index = 0;
  let furthest = 1;
  let step: ApplicationStep = 'contract';
  const pushEntry = (n: number) => {
    entries.splice(index + 1);
    entries.push(n);
    index = entries.length - 1;
  };
  pushEntry(1);
  const land = () => {
    step = stepForHistory(entries[index]!, furthest);
  };
  return {
    get step() {
      return step;
    },
    get entries() {
      return [...entries];
    },
    intend(intent: StepIntent) {
      const move = stepMove(intent, step);
      if (!move) return;
      if (move.kind === 'push') {
        furthest = Math.max(furthest, stepNumber(move.step));
        pushEntry(stepNumber(move.step));
        step = move.step;
      } else {
        index += move.delta;
        land();
      }
    },
    gesture() {
      index -= 1;
      if (entries[index] === 0) return 'guard';
      land();
      return step;
    },
  };
}

test('with the real moves, the back gesture always goes ONE step back — never forward', () => {
  const h = simulate();
  h.intend({ kind: 'continue' }); // 2
  h.intend({ kind: 'continue' }); // 3
  h.intend({ kind: 'back' }); // 2, through the history
  assert.equal(h.step, 'carnet');
  assert.deepEqual(h.entries, [0, 1, 2, 3], '«Atrás» added an entry');
  assert.equal(h.gesture(), 'contract', 'the gesture after «Atrás» went forward');
  assert.equal(h.gesture(), 'guard', 'the gesture from step 1 must land on the guard');
});

test('«Cambiar» then "Guardar y volver a revisar" retrace existing entries, and the gesture still steps back', () => {
  const h = simulate();
  for (let i = 0; i < 6; i += 1) h.intend({ kind: 'continue' });
  assert.equal(h.step, 'review');
  const before = h.entries;
  h.intend({ kind: 'edit', target: 'personal' });
  assert.equal(h.step, 'personal');
  h.intend({ kind: 'return-to-review' });
  assert.equal(h.step, 'review');
  assert.deepEqual(h.entries, before, 'a travel added or dropped an entry');
  assert.equal(h.gesture(), 'dwelling');
  assert.equal(h.gesture(), 'references');
});

test('?paso= is read as plain digits only', () => {
  assert.equal(stepParam('?paso=4'), 4);
  assert.equal(stepParam('?x=1&paso=7'), 7);
  assert.equal(stepParam(''), null);
  assert.equal(stepParam('?paso=4a'), null);
  assert.equal(stepParam('?paso=-1'), null);
  assert.equal(stepParam('?paso=999'), null);
});

test('leaving warns once anything is typed, chosen or ticked — and not on a blank form', () => {
  const blank: StepperState = {
    answers: emptyAnswerDraft(QUESTIONS),
    home: { addressText: '', reference: '', pin: null },
    photoReady: false,
    accepted: false,
  };
  assert.equal(hasUnsentData(blank), false);
  assert.equal(hasUnsentData({ ...blank, photoReady: true }), true);
  assert.equal(hasUnsentData({ ...blank, home: { addressText: 'x', reference: '', pin: null } }), true);
  assert.equal(hasUnsentData({ ...blank, answers: { ...blank.answers, movingSoon: false } }), true);
  assert.equal(hasUnsentData({ ...blank, answers: { ...blank.answers, fullName: '   ' } }), false);
});

// ─── 7. the review ──────────────────────────────────────────────────────────

test('the review shows a choice by its PRINTED label, a yes-or-no as a boolean, and a gap as null', () => {
  const rows = reviewRows(QUESTIONS, 'home', completeAnswers({ housingType: 'house', walled: true, movingSoon: null }));
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.value]));
  assert.equal(byId.housingType, 'CASA');
  assert.equal(byId.housingTenure, 'PROPIO');
  assert.equal(byId.walled, true);
  assert.equal(byId.movingSoon, null);
  // The paper's labels, verbatim.
  assert.equal(rows[0]!.label, '¿QUE TIPO DE INMUEBLE POSEE?');
  const personal = reviewRows(QUESTIONS, 'personal', completeAnswers({ landline: '' }));
  assert.equal(personal.find((r) => r.id === 'landline')?.value, null);
});

test('the address review uses the paper labels and tidies what was typed', () => {
  const rows = addressReviewRows(config.homeLabels, { addressText: '  Calle   Sucre 123 ', reference: '', pin: null });
  assert.deepEqual(rows, [
    { id: 'addressText', label: 'DIRECCIÓN EXACTA DONDE ESTARÁ EL PELUDITO', value: 'Calle Sucre 123' },
    { id: 'reference', label: 'NÚMERO DE CASA Y DETALLES', value: null },
    { id: 'pin', label: 'CROQUIS UBICACIÓN', value: null },
  ]);
  const marked = addressReviewRows(config.homeLabels, {
    addressText: 'Calle Sucre 123',
    reference: '',
    pin: { latitude: -17.3935, longitude: -66.157 },
  });
  assert.equal(marked.find((r) => r.id === 'pin')?.value, true, 'the summary says it is marked, not the coordinates');
});

test('the contract blanks are filled from the name and the C.I. typed in step 4', () => {
  assert.deepEqual(contractFill(completeAnswers({ fullName: '  Ana   Pérez ', ciNumber: '1234567' })), {
    name: 'Ana Pérez',
    ci: '1234567',
  });
  assert.deepEqual(contractFill(emptyAnswerDraft(QUESTIONS)), { name: null, ci: null });
});

test('the opening splits at its two blanks, and a name containing a token stays literal', () => {
  assert.deepEqual(splitContractOpening(`Yo ${CONTRACT_NAME_TOKEN} mayor, con C.I. ${CONTRACT_CI_TOKEN} me comprometo`, CONTRACT_NAME_TOKEN, CONTRACT_CI_TOKEN), [
    { kind: 'text', text: 'Yo ' },
    { kind: 'name' },
    { kind: 'text', text: ' mayor, con C.I. ' },
    { kind: 'ci' },
    { kind: 'text', text: ' me comprometo' },
  ]);
  assert.deepEqual(splitContractOpening('{ci}{nombre}', CONTRACT_NAME_TOKEN, CONTRACT_CI_TOKEN), [{ kind: 'ci' }, { kind: 'name' }]);
  assert.deepEqual(splitContractOpening('sin blancos', CONTRACT_NAME_TOKEN, CONTRACT_CI_TOKEN), [{ kind: 'text', text: 'sin blancos' }]);
});

test("the pet's facts are the paper's section 4, from public fields only, and nothing is invented", () => {
  const format = { age: (m: number | null) => `edad ${m}`, ageRange: (a: number, b: number) => `entre ${a} y ${b}` };
  const pet = {
    name: 'Luna',
    breed: 'mestiza',
    colorPattern: 'negro con blanco',
    species: 'dog' as const,
    sex: 'female' as const,
    ageMonths: 18,
    ageMonthsMin: 12,
    ageMonthsMax: 24,
    ageIsEstimate: true,
  };
  assert.deepEqual(petFactRows(pet, config.petSection, format), [
    { label: 'NOMBRE', value: 'Luna' },
    { label: 'EDAD', value: 'entre 12 y 24' },
    { label: 'RAZA', value: 'mestiza' },
    { label: 'COLOR', value: 'negro con blanco' },
    { label: 'ESPECIE', value: 'CANINO' },
    { label: 'GENERO', value: 'HEMBRA' },
  ]);
  // A known age shows the age; no colour, no COLOR row; a species the paper
  // does not print, no ESPECIE row; an unknown age, no EDAD row.
  const rows = petFactRows(
    { ...pet, ageIsEstimate: false, colorPattern: null, species: 'rabbit', sex: 'male', ageMonths: null },
    config.petSection,
    format,
  );
  assert.deepEqual(rows.map((r) => r.label), ['NOMBRE', 'RAZA', 'GENERO']);
  assert.equal(rows[2]!.value, 'MACHO');
  assert.equal(petFactRows({ ...pet, species: 'cat', ageIsEstimate: false }, config.petSection, format)[1]!.value, 'edad 18');
});
