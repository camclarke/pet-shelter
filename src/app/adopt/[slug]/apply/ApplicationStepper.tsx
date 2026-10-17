/**
 * The applicant's step-by-step form (portion 4c-2, plan §5): seven steps at
 * 360 px, in the owner's order — contract, carnet, address, personal data,
 * references, home, review and send.
 *
 *   - `ApplicationStepper`     holds the state, the history entries, the
 *                              guard against leaving, the focus, and sending.
 *   - `ApplicationStepperView` PRESENTATIONAL: one step, given its state.
 *                              Renders to static HTML for the 360px check.
 * Everything that DECIDES lives in `src/lib/application-steps.ts`, tested.
 *
 * ═══ SENDING IS TWO THINGS, IN THIS ORDER ══════════════════════════════════
 *   1. ONE `writeBatch`: the application, `private/home`, `private/identity`
 *      (`submitApplication`). The rules pair them; none can exist alone.
 *   2. THEN the ID photo, still in memory, to the upload route
 *      (`uploadIdDocument`). Only after 1 committed: the route refuses an
 *      upload for an application that does not exist.
 * If 2 fails with something a retry can fix, the application stands and the
 * photo is still here: «Reintentar». Anything else drops the photo, and
 * «Mis solicitudes» offers the upload again later ("Falta tu carnet").
 *
 * ═══ IN MEMORY ONLY — SO LEAVING IS GUARDED ════════════════════════════════
 * No localStorage, no sessionStorage, no save and resume: a shared family
 * phone is where a stranger's C.I. and two references' phones must not be
 * left. So while anything is unsent, leaving is guarded three ways (review
 * 4c-2 #1), each with the same inline dialog — never `window.confirm`:
 *   - `beforeunload`, for a reload, a closed tab, an address typed — which
 *     iOS Safari ignores, hence the other two;
 *   - a capture-phase click listener on same-origin links: a Next <Link> in
 *     the header, the footer or anywhere else never unloads the page, so
 *     `beforeunload` never fires for it;
 *   - the entry the form was opened in is kept as a GUARD in the history: the
 *     back gesture from step 1 lands on it instead of on the previous page.
 *
 * ═══ THE HISTORY IS LINEAR ═════════════════════════════════════════════════
 * "Continuar" pushes `?paso=N`; «Atrás», «Cambiar» and "Guardar y volver a
 * revisar" TRAVEL through the entries that already exist (`history.go`), so
 * the entry shown always names the step on screen and the back gesture goes
 * one step back — never forward (`stepMove`). A history entry can never land
 * past the furthest step "Continuar" reached (`stepForHistory`).
 *
 * ⚠️ Nothing is logged but an error code (application-wiring.test.ts).
 */

'use client';

import { useEffect, useRef, useState, type Ref } from 'react';
import Link from 'next/link';
import type { User } from 'firebase/auth';

import {
  ACCEPTANCE_PET_TOKEN,
  ADOPTION_ACCEPTANCE,
  type AdoptionContract,
} from '@/config/adoption-contract';
import { SHELTER, type ApplicationQuestion } from '@/config/shelter';
import {
  STEP_COUNT,
  STEP_SECTION,
  addressReviewRows,
  buildSubmission,
  contractFill,
  firstInvalidStep,
  hasUnsentData,
  reviewRows,
  stepForHistory,
  stepMove,
  stepNumber,
  stepParam,
  validateStep,
  type ApplicationStep,
  type PetFact,
  type StepError,
  type StepIntent,
  type StepperState,
} from '@/lib/application-steps';
import {
  emptyAnswerDraft,
  type AnswerDraft,
  type AnswerDraftValue,
  type ApplicationAnswerError,
  type HomeValidation,
} from '@/lib/applications';
import type { ApplicationSubmission } from '@/lib/applications-client';
import {
  canUploadLater,
  idUploadProblem,
  keepsPhotoForRetry,
  uploadIdDocument,
  type IdUploadProblem,
} from '@/lib/id-document-client';
import { t } from '@/i18n';
import { ApplicationFields, questionDomId } from './ApplicationFields';
import { ApplicationSent } from './ApplicationSent';
import { ContractText } from './ContractText';
import { HOME_ADDRESS_DOM_ID, HOME_DETAILS_DOM_ID, HomeStep } from './HomeStep';
import { ID_PHOTO_SIDE, IdPhotoPickerView, useIdPhoto, type IdPhotoState } from './IdPhotoStep';
import { ACCEPTANCE_DOM_ID, ReviewStep, type ReviewGroup, type SendingPhase } from './ReviewStep';

const config = SHELTER.adoptionApplications;

/** The step's title as the screen says it, after "Paso N de 7 ·". */
export function stepTitle(step: ApplicationStep, petName: string): string {
  const copy = t.applicationSteps;
  switch (step) {
    case 'contract':
      return copy.titleContract;
    case 'carnet':
      return copy.titleCarnet;
    case 'address':
      return copy.titleAddress(petName);
    case 'review':
      return copy.titleReview;
    default:
      return config.sections.find((s) => s.id === STEP_SECTION[step])?.label ?? '';
  }
}

/**
 * The acceptance words with the animal's name in them. `split`/`join`, never
 * `String.replace`: a replacement string gives `$&`, `$'` and `` $` `` their
 * special meaning, so a pet named "Toby $&" would put the token back in the
 * words the person ticks (review 4c-2 #5).
 */
export function acceptanceLabelFor(petName: string): string {
  return ADOPTION_ACCEPTANCE.label.split(ACCEPTANCE_PET_TOKEN).join(petName);
}

/** The review's carnet line — what is TRUE about the photo now (review 4c-2 #3). */
export function photoSummary(photo: IdPhotoState): string {
  const copy = t.applicationSteps;
  if (photo.kind === 'ready') return copy.photoReadySummary;
  if (photo.kind === 'preparing') return copy.preparingPhoto;
  return copy.photoMissingSummary;
}

export interface StepErrors {
  answers: Record<string, ApplicationAnswerError>;
  home: HomeValidation['errors'];
  step: StepError | null;
}

export const NO_ERRORS: StepErrors = { answers: {}, home: {}, step: null };

export interface ApplicationStepperViewProps {
  step: ApplicationStep;
  petName: string;
  questions: readonly ApplicationQuestion[];
  contract: AdoptionContract;
  answers: AnswerDraft;
  home: StepperState['home'];
  accepted: boolean;
  photo: IdPhotoState;
  errors: StepErrors;
  /** A step-level line above the buttons ("Revisa lo marcado…", a refused send). */
  notice: string | null;
  sending: SendingPhase;
  /** Reached through «Cambiar»: "Continuar" returns to the review. */
  fromReview: boolean;
  petFacts: readonly PetFact[];
  headingRef?: Ref<HTMLHeadingElement>;
  onAnswer: (id: string, value: AnswerDraftValue) => void;
  onHome: (field: 'addressText' | 'reference', value: string) => void;
  onAccept: (accepted: boolean) => void;
  onFile: (file: File) => void;
  onBack: () => void;
  onContinue: () => void;
  onEdit: (step: ApplicationStep) => void;
  onSubmit: () => void;
}

export function ApplicationStepperView(props: ApplicationStepperViewProps) {
  const { step, petName, questions, contract, answers, home, accepted, photo, errors, notice, sending } = props;
  const copy = t.applicationSteps;
  const busy = sending !== 'idle';
  const section = STEP_SECTION[step];

  const reviewGroups: ReviewGroup[] = [
    { step: 'carnet', title: stepTitle('carnet', petName), rows: [], summary: photoSummary(photo) },
    { step: 'address', title: stepTitle('address', petName), rows: addressReviewRows(config.homeLabels, home) },
    ...(['personal', 'references', 'dwelling'] as const).map((s) => ({
      step: s,
      title: stepTitle(s, petName),
      rows: reviewRows(questions, STEP_SECTION[s]!, answers),
    })),
  ];

  const continueLabel = props.fromReview
    ? copy.backToReview
    : step === 'carnet' && photo.kind === 'ready'
      ? copy.continueWithPhoto
      : copy.continue;

  return (
    <div className="apply-stepper">
      <h2 className="t-title apply-step__title" tabIndex={-1} ref={props.headingRef}>
        {copy.stepOf(stepNumber(step), STEP_COUNT, stepTitle(step, petName))}
      </h2>

      {step === 'contract' && (
        <>
          <p className="auth__prose apply-step__lead">{copy.contractLead}</p>
          <ContractText contract={contract} mode="blank" />
          <aside className="apply-paper-note">{copy.paperNote}</aside>
        </>
      )}

      {step === 'carnet' && (
        <IdPhotoPickerView
          state={photo}
          disabled={busy}
          required={errors.step === 'photo-required'}
          onFile={props.onFile}
          withGuidance
        />
      )}

      {step === 'address' && (
        <HomeStep
          labels={config.homeLabels}
          petName={petName}
          addressText={home.addressText}
          reference={home.reference}
          errors={errors.home}
          disabled={busy}
          onChange={props.onHome}
        />
      )}

      {section && (
        <>
          {step === 'personal' && <p className="auth__prose apply-step__lead apply-step__intro">{config.formIntro}</p>}
          <ApplicationFields
            questions={questions}
            draft={answers}
            errors={errors.answers}
            disabled={busy}
            onChange={props.onAnswer}
            onlySection={section}
            legendHidden
          />
        </>
      )}

      {step === 'review' && (
        <ReviewStep
          groups={reviewGroups}
          petFactsTitle={config.petSection.title}
          petFacts={props.petFacts}
          contract={contract}
          fill={contractFill(answers)}
          acceptanceLabel={acceptanceLabelFor(petName)}
          acceptanceIsDraft={ADOPTION_ACCEPTANCE.isDraft}
          accepted={accepted}
          acceptanceError={errors.step === 'acceptance-required'}
          sending={sending}
          notice={notice}
          onEdit={props.onEdit}
          onAccept={props.onAccept}
          onSubmit={props.onSubmit}
        />
      )}

      {step !== 'review' && notice && (
        <p className="auth__error" role="alert">
          {notice}
        </p>
      )}

      <div className="apply-step__nav">
        {step !== 'review' && (
          <button
            type="button"
            className="btn btn--action apply-step__primary"
            onClick={props.onContinue}
            disabled={busy || photo.kind === 'preparing'}
          >
            {continueLabel}
          </button>
        )}
        {step !== 'contract' && (
          <button type="button" className="btn btn--muted apply-step__back" onClick={props.onBack} disabled={busy}>
            {copy.back}
          </button>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Leaving with something unsent
// ─────────────────────────────────────────────────────────────────────────────

export const LEAVE_DIALOG_TITLE_ID = 'apply-leave-title';

export interface LeaveDialogProps {
  onStay: () => void;
  onLeave: () => void;
}

/**
 * "¿Salir sin enviar tu solicitud?" — inline, fixed to the bottom of the
 * screen so it is seen whether the link was in the header or the footer.
 * Never `window.confirm`: that is a browser box the person cannot read in
 * this site's words, and some in-app browsers suppress it. Focus moves to the
 * SAFE choice, and Escape keeps the person here.
 */
export function LeaveDialog({ onStay, onLeave }: LeaveDialogProps) {
  const copy = t.applicationSteps;
  const stay = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    stay.current?.focus();
  }, []);
  return (
    <div className="apply-leave">
      <div className="apply-leave__backdrop" onClick={onStay} aria-hidden="true" />
      <div
        className="apply-leave__panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={LEAVE_DIALOG_TITLE_ID}
        aria-describedby={`${LEAVE_DIALOG_TITLE_ID}-body`}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onStay();
        }}
      >
        <h2 id={LEAVE_DIALOG_TITLE_ID} className="t-label apply-leave__title">
          {copy.leaveTitle}
        </h2>
        <p id={`${LEAVE_DIALOG_TITLE_ID}-body`} className="auth__prose apply-leave__body">
          {copy.leaveBody}
        </p>
        <div className="apply-leave__actions">
          <button type="button" className="btn btn--brand apply-leave__stay" onClick={onStay} ref={stay}>
            {copy.leaveStay}
          </button>
          <button type="button" className="btn btn--muted apply-leave__go" onClick={onLeave}>
            {copy.leaveGo}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The same-origin page a click on this element would open in THIS tab, or
 * null when the click is not that: a modified or non-primary click, a new
 * tab, a download, another origin (the WhatsApp button — `beforeunload`
 * covers it where the browser allows), or a jump within this same page.
 */
export function inAppDestination(
  event: Pick<MouseEvent, 'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'defaultPrevented'> & {
    target: EventTarget | null;
  },
  here: string,
): string | null {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const element = event.target as Element | null;
  const anchor = element && typeof element.closest === 'function' ? element.closest('a[href]') : null;
  if (!anchor) return null;
  const target = anchor.getAttribute('target');
  if ((target && target !== '_self') || anchor.hasAttribute('download')) return null;
  let url: URL;
  let current: URL;
  try {
    url = new URL(anchor.getAttribute('href') ?? '', here);
    current = new URL(here);
  } catch {
    return null;
  }
  if (url.origin !== current.origin) return null;
  if (url.pathname === current.pathname && url.search === current.search) return null;
  return url.href;
}

// ─────────────────────────────────────────────────────────────────────────────
// The container
// ─────────────────────────────────────────────────────────────────────────────

type Phase =
  | { kind: 'form' }
  | { kind: 'upload-failed'; applicationId: string; problem: IdUploadProblem }
  | { kind: 'sent' };

/**
 * What the stepper reaches outside itself. Injectable so a test can mount the
 * REAL container; the defaults are the only production values, and a test
 * pins that they are these.
 */
export interface StepperServices {
  submit: (petId: string, user: User, submission: ApplicationSubmission) => Promise<string>;
  upload: typeof uploadIdDocument;
  /** Leave for a page the person confirmed leaving for. A full load: nothing to keep. */
  navigate: (href: string) => void;
}

export const DEFAULT_SERVICES: StepperServices = {
  submit: async (petId, user, submission) => {
    // Dynamic: Firestore stays out of the page until someone sends.
    const { submitApplication } = await import('@/lib/applications-client');
    return submitApplication(petId, user, submission);
  },
  upload: uploadIdDocument,
  navigate: (href) => window.location.assign(href),
};

export interface ApplicationStepperProps {
  user: User;
  petId: string;
  petName: string;
  slug: string;
  shelterName: string;
  questions: readonly ApplicationQuestion[];
  contract: AdoptionContract;
  petFacts: readonly PetFact[];
  /** Tests only. Production passes nothing and gets `DEFAULT_SERVICES`. */
  services?: StepperServices;
}

/** The DOM id of the first field a step's errors point at, for focus. */
function firstErrorDomId(step: ApplicationStep, errors: StepErrors, questions: readonly ApplicationQuestion[]): string | null {
  if (step === 'address') {
    if (errors.home.addressText) return HOME_ADDRESS_DOM_ID;
    if (errors.home.reference) return HOME_DETAILS_DOM_ID;
    return null;
  }
  if (step === 'review') return errors.step === 'acceptance-required' ? ACCEPTANCE_DOM_ID : null;
  const first = questions.find((q) => q.id in errors.answers);
  return first ? questionDomId(first.id) : null;
}

/**
 * Focus a field by the id its errors point at. A yes-or-no or a choice is a
 * `radiogroup` <div>, which cannot take focus itself: its first radio does.
 * Returns whether anything was focused.
 */
function focusField(id: string | null): boolean {
  if (!id) return false;
  const element = document.getElementById(id);
  const target = element?.matches('input, textarea, select')
    ? element
    : element?.querySelector<HTMLElement>('input, textarea, select');
  if (!target) return false;
  target.focus();
  return true;
}

/** Our mark on the entries this form owns, inside the history state Next keeps there. */
const HISTORY_KEY = 'wawitasApply';
type EntryKind = 'guard' | 'step';

function entryState(kind: EntryKind): Record<string, unknown> {
  const current = window.history.state;
  return { ...(current && typeof current === 'object' ? current : {}), [HISTORY_KEY]: kind };
}

function urlWith(paso: number | null): string {
  const url = new URL(window.location.href);
  if (paso === null) url.searchParams.delete('paso');
  else url.searchParams.set('paso', String(paso));
  return `${url.pathname}${url.search}${url.hash}`;
}

/** What a history travel carries to the step it lands on. */
interface PendingTravel {
  step: ApplicationStep;
  fromReview: boolean;
  errors: StepErrors | null;
  notice: string | null;
}

type LeaveRequest = { kind: 'link'; href: string } | { kind: 'back' };

export function ApplicationStepper({
  user,
  petId,
  petName,
  slug,
  shelterName,
  questions,
  contract,
  petFacts,
  services = DEFAULT_SERVICES,
}: ApplicationStepperProps) {
  const copy = t.applicationSteps;
  const applications = t.applications;

  const [step, setStep] = useState<ApplicationStep>('contract');
  const [furthest, setFurthest] = useState(1);
  const [answers, setAnswers] = useState<AnswerDraft>(() => emptyAnswerDraft(questions));
  const [home, setHome] = useState<StepperState['home']>({ addressText: '', reference: '' });
  const [accepted, setAccepted] = useState(false);
  const [errors, setErrors] = useState<StepErrors>(NO_ERRORS);
  const [notice, setNotice] = useState<string | null>(null);
  const [fromReview, setFromReview] = useState(false);
  const [sending, setSending] = useState<SendingPhase>('idle');
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [leave, setLeave] = useState<LeaveRequest | null>(null);
  const { state: photo, choose, clear: clearPhoto } = useIdPhoto();

  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const focusTarget = useRef<string | null>(null);
  const moved = useRef(false);
  const furthestRef = useRef(1);
  furthestRef.current = furthest;
  const pending = useRef<PendingTravel | null>(null);
  // Set once the person chose to leave: no guard may stop them after that.
  const leaving = useRef(false);
  const questionsRef = useRef(questions);
  questionsRef.current = questions;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const stepperState: StepperState = { answers, home, photoReady: photo.kind === 'ready', accepted };
  const unsent = phase.kind === 'form' && hasUnsentData(stepperState);
  const unsentRef = useRef(unsent);
  unsentRef.current = unsent;

  // ── history: the guard entry, then ?paso=N ───────────────────────────────
  useEffect(() => {
    const here = window.history.state as Record<string, unknown> | null;
    if (here?.[HISTORY_KEY] !== 'step') {
      // The entry the form was opened in becomes the GUARD; step 1 is a new
      // entry on top of it, so the back gesture from step 1 lands here first.
      window.history.replaceState(entryState('guard'), '', urlWith(null));
      window.history.pushState(entryState('step'), '', urlWith(1));
    } else {
      // A reload (or React re-running this effect): nothing survives, so the
      // entry says step 1 — the step on screen.
      window.history.replaceState(entryState('step'), '', urlWith(1));
    }

    let alive = true;
    function onPopState() {
      if (leaving.current) return;
      const requested = stepParam(window.location.search);
      if (requested === null) {
        // Back onto the guard: the person is leaving the form backwards.
        if (!unsentRef.current) {
          leaving.current = true;
          window.history.back();
          // A tab opened straight on this page has nothing before the guard:
          // `back()` goes nowhere, and the guards must work again. Never by
          // pushing an entry back, which would trap the back gesture here.
          window.setTimeout(() => {
            if (alive) leaving.current = false;
          }, 1000);
          return;
        }
        // Something would be lost: stay on step 1 and ask.
        window.history.pushState(entryState('step'), '', urlWith(1));
        pending.current = null;
        setStep('contract');
        setFromReview(false);
        setLeave({ kind: 'back' });
        return;
      }
      const shown = stepForHistory(requested, furthestRef.current);
      const travel = pending.current;
      pending.current = null;
      const arrived = travel !== null && travel.step === shown;
      setStep(shown);
      setFromReview(arrived ? travel.fromReview : false);
      setErrors(arrived && travel.errors ? travel.errors : NO_ERRORS);
      setNotice(arrived ? travel.notice : null);
      focusTarget.current = arrived && travel.errors ? firstErrorDomId(shown, travel.errors, questionsRef.current) : null;
      moved.current = true;
      // A forward entry past the furthest step was clamped: the entry must
      // say the step on screen again.
      if (stepNumber(shown) !== requested) window.history.replaceState(entryState('step'), '', urlWith(stepNumber(shown)));
    }
    window.addEventListener('popstate', onPopState);
    return () => {
      alive = false;
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

  // ── leaving with something typed: reload, close, an address typed ───────
  useEffect(() => {
    if (!unsent) return;
    function warn(event: BeforeUnloadEvent) {
      if (leaving.current) return;
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsent]);

  // ── …and an in-app link, which never unloads the page ───────────────────
  useEffect(() => {
    if (!unsent) return;
    function onClick(event: MouseEvent) {
      if (leaving.current) return;
      const target = event.target as Element | null;
      if (target && typeof target.closest === 'function' && target.closest('.apply-leave')) return;
      const href = inAppDestination(event, window.location.href);
      if (href === null) return;
      // Capture phase, so this runs before React's and Next's handlers: a
      // <Link> sees `defaultPrevented` and does not navigate.
      event.preventDefault();
      setLeave({ kind: 'link', href });
    }
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [unsent]);

  function stay() {
    setLeave(null);
    moved.current = true;
  }

  function leaveNow() {
    const request = leave;
    setLeave(null);
    leaving.current = true;
    if (request?.kind === 'link') {
      services.navigate(request.href);
      return;
    }
    // From step 1, past the guard, to the page before the form. With nothing
    // before it, this goes nowhere: the guards come back after a moment.
    window.history.go(-2);
    window.setTimeout(() => {
      if (mountedRef.current) leaving.current = false;
    }, 1000);
  }

  // ── focus: the step's heading, or the first field with an error ──────────
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    const target = focusTarget.current;
    focusTarget.current = null;
    if (!focusField(target)) headingRef.current?.focus();
  });

  /** "Continuar": a NEW history entry for the next step. */
  function forward(target: ApplicationStep) {
    const n = stepNumber(target);
    setStep(target);
    setFurthest((f) => Math.max(f, n));
    setFromReview(false);
    setErrors(NO_ERRORS);
    setNotice(null);
    focusTarget.current = null;
    moved.current = true;
    // Still on the guard (a tab with nothing before it, where leaving went
    // nowhere): put step 1's entry back first, so the history stays linear.
    if (stepParam(window.location.search) === null) window.history.pushState(entryState('step'), '', urlWith(1));
    window.history.pushState(entryState('step'), '', urlWith(n));
  }

  /** Everything else: travel through the entries that already exist. The popstate shows the step. */
  function move(intent: StepIntent, carry: Omit<PendingTravel, 'step'> = { fromReview: false, errors: null, notice: null }) {
    const next = stepMove(intent, step);
    if (!next) return;
    if (next.kind === 'push') {
      forward(next.step);
      return;
    }
    pending.current = { step: next.step, ...carry };
    window.history.go(next.delta);
  }

  function clearError(kind: 'answers' | 'home', id: string) {
    setErrors((previous) => {
      const bag = previous[kind] as Record<string, unknown>;
      if (!(id in bag)) return previous;
      const next = { ...bag };
      delete next[id];
      return { ...previous, [kind]: next };
    });
  }

  function onContinue() {
    const validation = validateStep(step, stepperState, questions);
    if (!validation.valid) {
      const found: StepErrors = {
        answers: validation.answerErrors,
        home: validation.homeErrors,
        step: validation.stepError,
      };
      setErrors(found);
      setNotice(step === 'carnet' ? null : copy.fixStep);
      focusField(firstErrorDomId(step, found, questions));
      return;
    }
    move(fromReview ? { kind: 'return-to-review' } : { kind: 'continue' });
  }

  async function onSubmit() {
    if (sending !== 'idle') return;
    setNotice(null);
    // Every step again, in order: a history entry can reach the review after
    // an earlier answer changed. The box is checked last.
    const gap = firstInvalidStep(stepperState, questions);
    if (gap) {
      const found: StepErrors = {
        answers: gap.validation.answerErrors,
        home: gap.validation.homeErrors,
        step: gap.validation.stepError,
      };
      if (gap.step === 'review') {
        setErrors(found);
        focusField(ACCEPTANCE_DOM_ID);
        return;
      }
      move(
        { kind: 'edit', target: gap.step },
        { fromReview: true, errors: found, notice: gap.step === 'carnet' ? null : copy.fixStep },
      );
      return;
    }
    if (photo.kind !== 'ready') return; // unreachable: the carnet step checked it

    setSending('application');
    let applicationId: string;
    try {
      const submission = buildSubmission(stepperState, questions);
      // The acceptance, explicitly, for the contract version THIS screen showed.
      applicationId = await services.submit(petId, user, {
        answers: submission.answers,
        identity: submission.identity,
        home: submission.home,
        acceptance: { accepted, contractVersion: contract.version },
      });
    } catch (caught) {
      const code = (caught as { code?: string })?.code;
      // The code only. The payload is a private person's C.I., home and references.
      console.error('[apply] could not submit', code);
      setNotice(code === 'permission-denied' ? applications.submitRefused : applications.submitFailed);
      setSending('idle');
      return;
    }

    // Only now does the application exist, so only now can the photo go.
    await sendPhoto(applicationId, photo.photo);
  }

  async function sendPhoto(applicationId: string, prepared: Extract<IdPhotoState, { kind: 'ready' }>['photo']) {
    setSending('photo');
    const outcome = await services.upload(user, applicationId, ID_PHOTO_SIDE, prepared);
    setSending('idle');
    window.scrollTo({ top: 0 });
    if (outcome.ok) {
      // Received: the bytes and the preview URL have no reason to stay in this tab.
      clearPhoto();
      setPhase({ kind: 'sent' });
      return;
    }
    const problem = idUploadProblem(outcome.failure);
    // Only a `retry` problem can take these bytes again. A closed or paused
    // application, a lost session, or bytes the route refused: drop the photo
    // and revoke its preview (review 4c-2 #8).
    if (!keepsPhotoForRetry(problem)) clearPhoto();
    setPhase({ kind: 'upload-failed', applicationId, problem });
  }

  async function retryUpload(applicationId: string) {
    if (photo.kind !== 'ready' || sending !== 'idle') return;
    await sendPhoto(applicationId, photo.photo);
  }

  if (phase.kind === 'sent') {
    return <ApplicationSent petName={petName} shelterName={shelterName} slug={slug} withCarnetLines />;
  }

  if (phase.kind === 'upload-failed') {
    return (
      <UploadFailedView
        problem={phase.problem}
        photo={photo}
        busy={sending !== 'idle'}
        onFile={(file) => void choose(file)}
        onRetry={() => void retryUpload(phase.applicationId)}
      />
    );
  }

  return (
    <>
      <ApplicationStepperView
        step={step}
        petName={petName}
        questions={questions}
        contract={contract}
        answers={answers}
        home={home}
        accepted={accepted}
        photo={photo}
        errors={errors}
        notice={notice}
        sending={sending}
        fromReview={fromReview}
        petFacts={petFacts}
        headingRef={headingRef}
        onAnswer={(id, value) => {
          setAnswers((previous) => ({ ...previous, [id]: value }));
          clearError('answers', id);
        }}
        onHome={(field, value) => {
          setHome((previous) => ({ ...previous, [field]: value }));
          clearError('home', field);
        }}
        onAccept={(value) => {
          setAccepted(value);
          if (value) setErrors((previous) => (previous.step === 'acceptance-required' ? { ...previous, step: null } : previous));
        }}
        onFile={(file) => {
          setErrors((previous) => (previous.step === 'photo-required' ? { ...previous, step: null } : previous));
          void choose(file);
        }}
        onBack={() => move({ kind: 'back' })}
        onContinue={onContinue}
        onEdit={(target) => move({ kind: 'edit', target }, { fromReview: true, errors: null, notice: null })}
        onSubmit={() => void onSubmit()}
      />
      {leave && <LeaveDialog onStay={stay} onLeave={leaveNow} />}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The application arrived; the photo did not
// ─────────────────────────────────────────────────────────────────────────────

export interface UploadFailedViewProps {
  problem: IdUploadProblem;
  photo: IdPhotoState;
  busy: boolean;
  onFile: (file: File) => void;
  onRetry: () => void;
}

/**
 * What a retry can fix is offered again with the photo still in memory; a
 * photo the route refused asks for another; a closed or paused application
 * offers nothing that cannot work — and then «Mis solicitudes» is not named
 * either, because the upload would be refused there too (review 4c-2 #6).
 * Focus moves to the heading, so the outcome is announced (#8).
 */
export function UploadFailedView({ problem, photo, busy, onFile, onRetry }: UploadFailedViewProps) {
  const copy = t.applicationSteps;
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [problem]);
  const photoProblem = problem === 'photo-too-small' || problem === 'photo-rejected';
  const canRetry = (problem === 'retry' || photoProblem) && photo.kind === 'ready';
  return (
    <div className="apply-gate apply-upload-failed">
      <h2 className="t-title apply-sent__title" tabIndex={-1} ref={heading}>
        {copy.uploadFailed}
      </h2>
      <p className="auth__error" role="alert">
        {copy.uploadProblem(problem)}
      </p>
      {photoProblem && (
        <IdPhotoPickerView state={photo} disabled={busy} required={false} onFile={onFile} withGuidance={false} />
      )}
      {canRetry && (
        <button type="button" className="btn btn--action apply-step__primary" onClick={onRetry} disabled={busy}>
          {copy.retryUpload}
        </button>
      )}
      {busy && (
        <p className="auth__hint" role="status">
          {copy.sendingPhoto}
        </p>
      )}
      {canUploadLater(problem) && <p className="auth__prose">{copy.uploadLater}</p>}
      <Link href="/account" className="auth__link">
        {t.applications.goToAccount}
      </Link>
    </div>
  );
}
