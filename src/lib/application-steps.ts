/**
 * The applicant's step-by-step form (portion 4c-2, plan §5) — the PURE layer.
 * No React, no Firebase, no Spanish: which steps exist and in what order, what
 * each one asks, when "Continuar" may move on, what the review shows, and what
 * one submission sends. `ApplicationStepper.tsx` holds the state and renders;
 * everything here is decided without a browser, so it is tested without one.
 *
 * ═══ THE OWNER'S ORDER ═════════════════════════════════════════════════════
 *   1 contract     the commitments, read before any personal data is asked
 *   2 carnet       the ID photo — EARLY on purpose: if the camera kills the
 *                  tab, almost nothing typed is lost
 *   3 address      private/home: DIRECCIÓN EXACTA and NÚMERO DE CASA Y DETALLES
 *   4 personal     the paper's DATOS PERSONALES
 *   5 references   the paper's REFERENCIAS
 *   6 dwelling     the paper's DOMICILIO (its section id is `home`; the step is
 *                  called `dwelling` so it cannot be confused with the address)
 *   7 review       a summary, the pet's facts, the contract filled in, the box
 *
 * ═══ NOTHING HIDDEN IS SENT ═══════════════════════════════════════════════
 * A question whose `askedWhen` is not met is neither shown, required, reviewed
 * nor sent — `isQuestionAsked` decides all four, the same function the
 * validator and the admin screen use. The landlord only for ARRENDADO,
 * "amurallado" only for CASA or FINCA.
 *
 * ═══ NO SAVE AND RESUME ══════════════════════════════════════════════════
 * State lives in memory only. Nothing here touches storage, and the stepper
 * keeps it that way: a shared family phone is exactly where a stranger's C.I.
 * and two references' phones must not be left behind.
 */

import type { ApplicationConfig, ApplicationQuestion, ApplicationSection } from '@/config/shelter';
import {
  choiceLabel,
  isQuestionAsked,
  splitAnswersByStore,
  validateAnswers,
  validateHome,
  type AnswerDraft,
  type ApplicationAnswerError,
  type HomeDraft,
  type HomeValidation,
  type PinCoordinates,
  type ValidHome,
} from './applications';
import type { ApplicationAnswer, PetSex, Species } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// The steps
// ─────────────────────────────────────────────────────────────────────────────

export const APPLICATION_STEPS = [
  'contract',
  'carnet',
  'address',
  'personal',
  'references',
  'dwelling',
  'review',
] as const;

export type ApplicationStep = (typeof APPLICATION_STEPS)[number];

/** The steps whose questions come from one of the paper's sections. */
export const STEP_SECTION: Readonly<Partial<Record<ApplicationStep, ApplicationSection>>> = {
  personal: 'personal',
  references: 'references',
  dwelling: 'home',
};

export const STEP_COUNT = APPLICATION_STEPS.length;

/** 1-based, as the screen says it: "Paso 3 de 7". */
export function stepNumber(step: ApplicationStep): number {
  return APPLICATION_STEPS.indexOf(step) + 1;
}

/** The step a `?paso=N` names, or null when N is not a step. */
export function stepFromNumber(n: number): ApplicationStep | null {
  return Number.isInteger(n) && n >= 1 && n <= STEP_COUNT ? APPLICATION_STEPS[n - 1]! : null;
}

export function nextStep(step: ApplicationStep): ApplicationStep | null {
  return stepFromNumber(stepNumber(step) + 1);
}

export function previousStep(step: ApplicationStep): ApplicationStep | null {
  return stepFromNumber(stepNumber(step) - 1);
}

/**
 * Where a history entry (the back gesture, the forward button) may land: the
 * step it names, but never past the furthest step "Continuar" has reached. A
 * forward entry cannot skip a step's check, and a malformed `?paso=` lands on
 * the first step rather than nowhere.
 */
export function stepForHistory(requested: number, furthestReached: number): ApplicationStep {
  const furthest = Math.min(Math.max(Math.trunc(furthestReached) || 1, 1), STEP_COUNT);
  if (!Number.isInteger(requested) || requested < 1) return APPLICATION_STEPS[0];
  return APPLICATION_STEPS[Math.min(requested, furthest) - 1]!;
}

/** The `?paso=` value in a search string, or null. Only plain digits count. */
export function stepParam(search: string): number | null {
  const raw = new URLSearchParams(search).get('paso');
  return raw !== null && /^\d{1,2}$/.test(raw) ? Number(raw) : null;
}

/**
 * How a move reaches its step, in the browser's history (review 4c-2 #3).
 *
 * The history is kept LINEAR and in step with the screen: the entry the person
 * is on always says the step they see, and the entries behind it are the
 * steps before it, in order — so the back gesture always goes one step back,
 * never forward.
 *   - `push`: "Continuar" — a NEW entry for the next step (dropping any
 *     forward entries, as any browser does after going back);
 *   - `go`:   «Atrás», «Cambiar» and "Guardar y volver a revisar" travel
 *     through entries that ALREADY exist (`history.go(delta)`), and add none.
 */
export type StepMove =
  | { kind: 'push'; step: ApplicationStep }
  | { kind: 'go'; step: ApplicationStep; delta: number };

export type StepIntent =
  | { kind: 'continue' }
  | { kind: 'back' }
  /** «Cambiar» on the review, or "Enviar" sending the person back to a gap. */
  | { kind: 'edit'; target: ApplicationStep }
  /** "Guardar y volver a revisar", on a step reached through «Cambiar». */
  | { kind: 'return-to-review' };

/** The move an intent makes from `from`, or null when there is nowhere to go. */
export function stepMove(intent: StepIntent, from: ApplicationStep): StepMove | null {
  const here = stepNumber(from);
  const via = (step: ApplicationStep | null): StepMove | null =>
    step === null || step === from ? null : { kind: 'go', step, delta: stepNumber(step) - here };
  switch (intent.kind) {
    case 'continue': {
      const next = nextStep(from);
      return next ? { kind: 'push', step: next } : null;
    }
    case 'back':
      return via(previousStep(from));
    case 'edit':
      return via(intent.target);
    case 'return-to-review':
      return via('review');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// What a step asks
// ─────────────────────────────────────────────────────────────────────────────

/** The questions a section's step shows now: its own, and only those asked given the answers so far. */
export function stepQuestions(
  questions: readonly ApplicationQuestion[],
  section: ApplicationSection,
  answers: AnswerDraft,
): ApplicationQuestion[] {
  return questions.filter((q) => q.section === section && isQuestionAsked(questions, q, answers));
}

// ─────────────────────────────────────────────────────────────────────────────
// When "Continuar" may move on
// ─────────────────────────────────────────────────────────────────────────────

/** Everything the steps decide on. The photo is reduced to "is there one ready". */
export interface StepperState {
  answers: AnswerDraft;
  /** `pin` is the CROQUIS: optional, null until the person marks the map. */
  home: { addressText: string; reference: string; pin: PinCoordinates | null };
  photoReady: boolean;
  accepted: boolean;
}

/** A step's own refusal, beside the per-field errors. */
export type StepError =
  /** Step 2: no photo has passed the in-browser check. */
  | 'photo-required'
  /** Step 7: the acceptance box is not ticked. The button is never disabled. */
  | 'acceptance-required';

export interface StepValidation {
  valid: boolean;
  /** Per question id, for this step's questions only. */
  answerErrors: Record<string, ApplicationAnswerError>;
  /** Per address field, on step 3 only. */
  homeErrors: HomeValidation['errors'];
  stepError: StepError | null;
}

/** The pin travels as marked; `validateHome` rounds it and checks the service area. */
function homeDraftOf(state: StepperState): HomeDraft {
  return { addressText: state.home.addressText, reference: state.home.reference, pin: state.home.pin };
}

const VALID: StepValidation = { valid: true, answerErrors: {}, homeErrors: {}, stepError: null };

/**
 * May this step be left forward? Each step checks only what it asks: an error
 * on step 6 never stops step 4. The review step checks only the box; sending
 * re-checks every step (`firstInvalidStep`).
 */
export function validateStep(
  step: ApplicationStep,
  state: StepperState,
  questions: readonly ApplicationQuestion[],
  bounds?: Parameters<typeof validateHome>[1],
): StepValidation {
  switch (step) {
    case 'contract':
      return VALID;
    case 'carnet':
      return state.photoReady ? VALID : { ...VALID, valid: false, stepError: 'photo-required' };
    case 'address': {
      const home = validateHome(homeDraftOf(state), bounds);
      return home.valid ? VALID : { ...VALID, valid: false, homeErrors: home.errors };
    }
    case 'review':
      return state.accepted === true ? VALID : { ...VALID, valid: false, stepError: 'acceptance-required' };
    case 'personal':
    case 'references':
    case 'dwelling': {
      const section = STEP_SECTION[step]!;
      const shown = new Set(stepQuestions(questions, section, state.answers).map((q) => q.id));
      const { errors } = validateAnswers(questions, state.answers);
      const answerErrors: Record<string, ApplicationAnswerError> = {};
      for (const [id, error] of Object.entries(errors)) if (shown.has(id)) answerErrors[id] = error;
      return Object.keys(answerErrors).length === 0 ? VALID : { ...VALID, valid: false, answerErrors };
    }
  }
}

/**
 * The first step, in order, that would refuse "Continuar" now — what "Enviar"
 * checks before sending, because a person can reach the review through history
 * entries and change an earlier answer from there. The review step itself is
 * included, so an unticked box is reported last, after any real gap.
 */
export function firstInvalidStep(
  state: StepperState,
  questions: readonly ApplicationQuestion[],
  bounds?: Parameters<typeof validateHome>[1],
): { step: ApplicationStep; validation: StepValidation } | null {
  for (const step of APPLICATION_STEPS) {
    const validation = validateStep(step, state, questions, bounds);
    if (!validation.valid) return { step, validation };
  }
  return null;
}

/** Has anything been typed or chosen that leaving would lose? (The `beforeunload` warning.) */
export function hasUnsentData(state: StepperState): boolean {
  if (state.photoReady || state.accepted) return true;
  if (state.home.addressText.trim() !== '' || state.home.reference.trim() !== '') return true;
  return Object.values(state.answers).some((v) => (typeof v === 'string' ? v.trim() !== '' : v !== null));
}

// ─────────────────────────────────────────────────────────────────────────────
// What one submission sends
// ─────────────────────────────────────────────────────────────────────────────

export interface StepperSubmission {
  /** `store: 'application'` → the main document's `answers`. */
  answers: Record<string, ApplicationAnswer>;
  /** `store: 'identity'` → the admin-only, erasable `private/identity`. */
  identity: Record<string, ApplicationAnswer>;
  /** → `private/home`. */
  home: ValidHome;
}

export class IncompleteSubmissionError extends Error {
  readonly step: ApplicationStep;
  constructor(step: ApplicationStep) {
    super(`incomplete submission: step ${step}`);
    this.name = 'IncompleteSubmissionError';
    this.step = step;
  }
}

/**
 * The three documents' contents, validated and split by store. Throws
 * `IncompleteSubmissionError` naming the step to send the person back to.
 *
 * The C.I., the age, the references and the landlord go to `identity`, never
 * into `answers`, which every admin queue load downloads and nothing may
 * erase. The acceptance is NOT here: the caller passes it explicitly with the
 * contract version the screen showed, so nothing records an acceptance nobody
 * gave.
 */
export function buildSubmission(
  state: StepperState,
  questions: readonly ApplicationQuestion[],
  bounds?: Parameters<typeof validateHome>[1],
): StepperSubmission {
  for (const step of APPLICATION_STEPS) {
    if (step === 'review') continue; // the box travels separately, as `acceptance`
    if (!validateStep(step, state, questions, bounds).valid) throw new IncompleteSubmissionError(step);
  }
  const validation = validateAnswers(questions, state.answers);
  const home = validateHome(homeDraftOf(state), bounds);
  if (!validation.valid) throw new IncompleteSubmissionError('personal');
  if (!home.valid || !home.home) throw new IncompleteSubmissionError('address');
  const split = splitAnswersByStore(questions, validation.answers);
  return { answers: split.application, identity: split.identity, home: home.home };
}

// ─────────────────────────────────────────────────────────────────────────────
// The review
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One line of the summary. `value` is the shown text, a yes-or-no for the
 * screen to say in words, or null for "not answered". A choice shows its
 * printed label (CASA), never its stored value (house).
 */
export interface ReviewRow {
  id: string;
  label: string;
  value: string | boolean | null;
}

/** The asked questions of a section, as the review lists them, in the paper's order. */
export function reviewRows(
  questions: readonly ApplicationQuestion[],
  section: ApplicationSection,
  answers: AnswerDraft,
): ReviewRow[] {
  return stepQuestions(questions, section, answers).map((q) => {
    const raw = answers[q.id];
    if (q.kind === 'yesNo') return { id: q.id, label: q.label, value: typeof raw === 'boolean' ? raw : null };
    const text = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
    if (text === '') return { id: q.id, label: q.label, value: null };
    return { id: q.id, label: q.label, value: q.kind === 'choice' ? choiceLabel(q, text) : text };
  });
}

/** The address step, as the review lists it, under the paper's own labels. */
export function addressReviewRows(
  labels: ApplicationConfig['homeLabels'],
  home: StepperState['home'],
): ReviewRow[] {
  const tidy = (text: string) => text.trim().replace(/\s+/g, ' ');
  return [
    { id: 'addressText', label: labels.address, value: tidy(home.addressText) || null },
    { id: 'reference', label: labels.details, value: tidy(home.reference) || null },
    // Sí when marked; "not answered" when skipped. Coordinates mean nothing to
    // the person reading their own summary.
    { id: 'pin', label: labels.map, value: home.pin ? true : null },
  ];
}

/** The applicant's name and C.I. as typed so far — what fills the contract's two blanks on the review. */
export function contractFill(answers: AnswerDraft): { name: string | null; ci: string | null } {
  const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim().replace(/\s+/g, ' ') : null);
  return { name: text(answers.fullName), ci: text(answers.ciNumber) };
}

// ─────────────────────────────────────────────────────────────────────────────
// The contract's opening, split at its two blanks
// ─────────────────────────────────────────────────────────────────────────────

export type OpeningPart = { kind: 'text'; text: string } | { kind: 'name' } | { kind: 'ci' };

/**
 * The opening sentence in pieces, so the screen renders the blanks as React
 * nodes rather than by string substitution: nothing is HTML-injected, and a
 * name that itself contains `{ci}` stays literal text.
 */
export function splitContractOpening(opening: string, nameToken: string, ciToken: string): OpeningPart[] {
  const parts: OpeningPart[] = [];
  let rest = opening;
  while (rest.length > 0) {
    const n = rest.indexOf(nameToken);
    const c = rest.indexOf(ciToken);
    const candidates = [
      ...(n >= 0 ? [{ at: n, kind: 'name' as const, length: nameToken.length }] : []),
      ...(c >= 0 ? [{ at: c, kind: 'ci' as const, length: ciToken.length }] : []),
    ].sort((a, b) => a.at - b.at);
    const next = candidates[0];
    if (!next) {
      parts.push({ kind: 'text', text: rest });
      break;
    }
    if (next.at > 0) parts.push({ kind: 'text', text: rest.slice(0, next.at) });
    parts.push({ kind: next.kind });
    rest = rest.slice(next.at + next.length);
  }
  return parts;
}

// ─────────────────────────────────────────────────────────────────────────────
// DATOS DEL PELUDITO ADOPTADO — the public facts, read-only
// ─────────────────────────────────────────────────────────────────────────────

export interface PetFact {
  label: string;
  value: string;
}

/** The public pet fields the review shows. Nothing from `detail` or `medical` (D16). */
export interface PublicPetFacts {
  name: string;
  breed: string;
  colorPattern: string | null;
  species: Species;
  sex: PetSex;
  ageMonths: number | null;
  ageMonthsMin: number | null;
  ageMonthsMax: number | null;
  ageIsEstimate: boolean;
}

/**
 * The paper's section 4, filled from the PUBLIC pet document. A field the pet
 * does not have is left out rather than shown blank or invented: no colour
 * recorded, no COLOR row; a species the paper does not print (CANINO /
 * FELINO only), no ESPECIE row.
 *
 * `formatAge` and `formatAgeRange` are passed in (the i18n helpers), so this
 * module stays free of Spanish. An estimate shows its range, never a midpoint
 * read as a fact.
 */
export function petFactRows(
  pet: PublicPetFacts,
  labels: ApplicationConfig['petSection'],
  format: { age: (months: number | null) => string; ageRange: (min: number, max: number) => string },
): PetFact[] {
  const rows: PetFact[] = [{ label: labels.name, value: pet.name }];
  const { ageMonthsMin: min, ageMonthsMax: max } = pet;
  const ranged =
    pet.ageIsEstimate && typeof min === 'number' && typeof max === 'number' && Number.isFinite(min) && max >= min;
  if (ranged) rows.push({ label: labels.age, value: format.ageRange(min, max) });
  else if (pet.ageMonths !== null) rows.push({ label: labels.age, value: format.age(pet.ageMonths) });
  if (pet.breed.trim() !== '') rows.push({ label: labels.breed, value: pet.breed.trim() });
  if (pet.colorPattern && pet.colorPattern.trim() !== '') rows.push({ label: labels.color, value: pet.colorPattern.trim() });
  if (pet.species === 'dog' || pet.species === 'cat') {
    rows.push({ label: labels.species, value: labels.speciesValues[pet.species] });
  }
  rows.push({ label: labels.sex, value: labels.sexValues[pet.sex] });
  return rows;
}
