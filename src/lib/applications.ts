/**
 * Online adoption applications — the PURE layer. Build-order step 14, plan §6.
 *
 * No Firestore, no Spanish. `applications-client.ts` (the applicant) and
 * `applications-admin.ts` (the shelter) do the reading and writing; everything
 * that DECIDES something lives here, so it can be tested without a database.
 *
 * ═══ SECONDARY, ON PURPOSE ═════════════════════════════════════════════════
 * The project log's primary objective is a stranger messaging the shelter about a
 * specific animal, and PLAN.md §2 is explicit that the conversion is WhatsApp:
 * no account, no form. This feature exists because it captures the screening
 * answers the shelter gathers by hand today and gives them a queue instead of a
 * chat backlog — not because a form converts better. So the design rule from
 * plan §6 is binding here: the account requirement never moves in front of the
 * WhatsApp button.
 *
 * ═══ THE DUPLICATE GUARD IS THE DOCUMENT ID ════════════════════════════════
 * One active application per applicant per pet. Two ways to enforce that were
 * considered, and only one of them is enforcement:
 *
 * - A GUARD — query for an open application before creating one. Security
 *   rules cannot run queries, so this would live only in the browser: two tabs
 *   submitting at once both pass it, and anyone with the SDK skips it.
 * - A DETERMINISTIC ID — `{petId}__{applicantUid}`. The rules require exactly
 *   that id on create, so a second submission addresses the SAME document,
 *   Firestore evaluates it as an UPDATE, and the only update an applicant may
 *   make is a withdrawal. The database refuses the duplicate, not the page.
 *
 * The id wins. Its one consequence is stronger than "one ACTIVE application":
 * it is one application per person per animal, ever. A withdrawn application
 * cannot be resubmitted online, and a rejected one can only be reopened by an
 * admin. That is judged acceptable because the same person can always message
 * the shelter on WhatsApp — the primary path — and it is recorded as a decision
 * for the owner rather than hidden.
 *
 * ═══ WARN OR BLOCK ═════════════════════════════════════════════════════════
 * Same split as `medical.ts` and `areas.ts`. Approval BLOCKS only on states that
 * are structurally unsafe: an animal that already belongs to a family (approving
 * would hand its microchip and location to a second one), an animal that
 * `arrival.ts` says cannot become adopted, and an application nobody has moved
 * into review. Everything the shelter can have a good reason for — other people
 * still waiting, an unverified email, an animal taken off the wall mid-interview
 * — only WARNS. Nothing here ever changes another application automatically:
 * turning someone down is a conversation, not a side effect.
 */

import type { ApplicationQuestion } from '@/config/shelter';
import { canTransition } from './arrival';
import type {
  Adoption,
  AdoptionApplication,
  ApplicationAnswer,
  ApplicationStatus,
  CustodyEvent,
  PetStatus,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Statuses and the transition table
// ─────────────────────────────────────────────────────────────────────────────

export const APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  'submitted',
  'reviewing',
  'interview',
  'approved',
  'rejected',
  'withdrawn',
];

/**
 * Which status changes an ADMIN may make.
 *
 * ⚠️ MIRRORED in `firestore.rules` as `applicationTransitions()`, which is the
 * enforcing copy. A test parses the rules and fails if the two drift.
 *
 * The shape mirrors `PET_STATUS_TRANSITIONS` in `arrival.ts`. The applicant's
 * only move — withdrawing an open application — is not in this table; it is a
 * separate, narrower rule (see `withdrawalPatch`).
 */
export const APPLICATION_STATUS_TRANSITIONS: Record<
  ApplicationStatus,
  readonly ApplicationStatus[]
> = {
  /**
   * Nobody has looked yet. Deliberately NOT straight to `approved`: approval
   * writes an adoption record and hands the animal's restricted tiers to a new
   * owner, so it must follow an explicit "someone is reviewing this" step —
   * the same reasoning that makes quarantine end with a clearance, never a
   * timer.
   */
  submitted: ['reviewing', 'interview', 'rejected', 'withdrawn'],
  reviewing: ['interview', 'approved', 'rejected', 'withdrawn'],
  interview: ['reviewing', 'approved', 'rejected', 'withdrawn'],

  /**
   * Terminal. Undoing an adoption is not a status flip on an application: the
   * animal coming back is a RE-ADMISSION (step 6), which reopens the pet record
   * and closes the custody interval. The application stays as history.
   */
  approved: [],

  /**
   * Reconsiderable, because this is a button on a phone and a mis-tap must not
   * turn a family down for good. Reopening goes back to review, never straight
   * to approval.
   */
  rejected: ['reviewing'],

  /** Terminal. The applicant decided; the shelter does not undo that for them. */
  withdrawn: [],
};

/**
 * Is this status change legal for an admin?
 *
 * ⚠️ Unlike `canTransition` in `arrival.ts`, a same-status write is NOT
 * treated as a legal no-op. A pet status can be re-saved alongside other
 * edits; an application status change is itself the decision, and a write
 * that decides nothing has no reason to exist. The rules refuse it too.
 */
export function canTransitionApplication(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return APPLICATION_STATUS_TRANSITIONS[from].includes(to);
}

/** Still waiting on the shelter — what the queue shows by default. */
export const OPEN_APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  'submitted',
  'reviewing',
  'interview',
];

export function isOpenApplication(status: ApplicationStatus): boolean {
  return OPEN_APPLICATION_STATUSES.includes(status);
}

/** The applicant may pull out of anything still open, and of nothing else. */
export function applicantCanWithdraw(status: ApplicationStatus): boolean {
  return isOpenApplication(status);
}

/** The statuses that carry `decidedAt` / `decidedBy`. */
export const DECIDED_APPLICATION_STATUSES: readonly ApplicationStatus[] = ['approved', 'rejected'];

// ─────────────────────────────────────────────────────────────────────────────
// Document ids — the duplicate guard
// ─────────────────────────────────────────────────────────────────────────────

export const APPLICATION_ID_SEPARATOR = '__';

/**
 * Whether a string can be one half of an application id.
 *
 * Firestore-generated pet ids and Firebase-generated uids are alphanumeric, so
 * both always pass. A uid minted by hand through the Admin SDK can contain
 * anything; one containing the separator could not be told apart from the pet
 * id, so it cannot apply online at all — the rules refuse the same ids.
 */
export function isApplicationIdSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    !value.includes(APPLICATION_ID_SEPARATOR) &&
    !value.includes('/')
  );
}

/** The one id an applicant's application for this pet can have. */
export function applicationIdFor(petId: string, applicantUid: string): string {
  if (!isApplicationIdSegment(petId) || !isApplicationIdSegment(applicantUid)) {
    throw new Error('applicationIdFor: an id segment is empty, too long, or contains a separator');
  }
  return `${petId}${APPLICATION_ID_SEPARATOR}${applicantUid}`;
}

export function parseApplicationId(id: string): { petId: string; applicantUid: string } | null {
  const parts = id.split(APPLICATION_ID_SEPARATOR);
  if (parts.length !== 2) return null;
  const [petId, applicantUid] = parts as [string, string];
  if (!isApplicationIdSegment(petId) || !isApplicationIdSegment(applicantUid)) return null;
  return { petId, applicantUid };
}

// ─────────────────────────────────────────────────────────────────────────────
// Answers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The bounds `firestore.rules` enforces on EVERY answer, whatever its question:
 * a string no longer than this, or a whole number from 0 to `RULES_ANSWER_MAX_COUNT`.
 *
 * ⚠️ MIRRORED in `validAnswer()` in the rules. The rules cannot see which kind a
 * question is — that lives in shelter config — so they bound the worst case and
 * the per-kind limits below are the stricter, form-level ones. A test pins that
 * no per-kind limit exceeds these, and that the rules still carry these numbers.
 */
export const RULES_ANSWER_MAX_CHARS = 1500;
export const RULES_ANSWER_MAX_COUNT = 99;

export const ANSWER_MAX_CHARS = {
  shortText: 120,
  phone: 30,
  longText: 1500,
} as const;

/** Used when a `count` question does not say its own maximum. */
export const DEFAULT_COUNT_MAX = 30;

/** At most this many questions — `hasOnly` in the rules lists every key. */
export const MAX_APPLICATION_QUESTIONS = 20;

/**
 * Form state. Text-like and `count` inputs hold what was TYPED (a count is
 * parsed on validation, not on keystroke); `yesNo` holds a boolean or null.
 */
export type AnswerDraftValue = string | boolean | null;
export type AnswerDraft = Record<string, AnswerDraftValue>;

export type ApplicationAnswerError =
  | 'required'
  | 'too-long'
  | 'phone-invalid'
  | 'count-invalid'
  | 'choice-invalid';

export function emptyAnswerDraft(questions: readonly ApplicationQuestion[]): AnswerDraft {
  const draft: AnswerDraft = {};
  for (const question of questions) {
    draft[question.id] = question.kind === 'yesNo' ? null : '';
  }
  return draft;
}

/**
 * The digits of a phone number, or null when it cannot be one.
 *
 * Accepts spaces, dashes, dots, parentheses and one leading `+`, because that
 * is how numbers get typed on a phone — "7790 3553", "+591 77903553". Seven to
 * fifteen digits covers a Bolivian landline through any E.164 number, and
 * refuses a name typed into the wrong box.
 */
export function phoneDigits(text: string): string | null {
  const trimmed = text.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

export interface AnswerValidation {
  /** What would be stored: only question ids, only answered questions, never null. */
  answers: Record<string, ApplicationAnswer>;
  /** Per question id. Empty when the form can be sent. */
  errors: Record<string, ApplicationAnswerError>;
  valid: boolean;
}

/**
 * Validate and normalise a form into the answers the rules will accept.
 *
 * Keys not belonging to a configured question are DROPPED rather than stored:
 * the rules refuse them anyway, and a stale key from an older version of the
 * question list must not make the whole submission fail.
 *
 * An unanswered optional question is ABSENT from the result, never null — the
 * rules treat an explicit null as a malformed answer.
 */
export function validateAnswers(
  questions: readonly ApplicationQuestion[],
  draft: AnswerDraft,
): AnswerValidation {
  const answers: Record<string, ApplicationAnswer> = {};
  const errors: Record<string, ApplicationAnswerError> = {};

  for (const question of questions) {
    const raw = draft[question.id];

    if (question.kind === 'yesNo') {
      if (typeof raw === 'boolean') answers[question.id] = raw;
      else if (question.required) errors[question.id] = 'required';
      continue;
    }

    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text === '') {
      if (question.required) errors[question.id] = 'required';
      continue;
    }

    switch (question.kind) {
      case 'shortText':
      case 'longText': {
        // Collapse runs of spaces but KEEP line breaks in long answers: a story
        // about a previous dog written in paragraphs should read as one.
        const normalised =
          question.kind === 'shortText'
            ? text.replace(/\s+/g, ' ')
            : text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
        if (normalised.length > ANSWER_MAX_CHARS[question.kind]) errors[question.id] = 'too-long';
        else answers[question.id] = normalised;
        break;
      }
      case 'phone': {
        if (text.length > ANSWER_MAX_CHARS.phone || phoneDigits(text) === null) {
          errors[question.id] = 'phone-invalid';
        } else {
          // Stored as typed (tidied), not as bare digits: "+591 7790 3553" is
          // what the shelter will read back and dial.
          answers[question.id] = text.replace(/\s+/g, ' ');
        }
        break;
      }
      case 'count': {
        const max = Math.min(question.max ?? DEFAULT_COUNT_MAX, RULES_ANSWER_MAX_COUNT);
        if (!/^\d{1,2}$/.test(text)) {
          errors[question.id] = 'count-invalid';
          break;
        }
        const value = Number(text);
        if (value > max) errors[question.id] = 'count-invalid';
        else answers[question.id] = value;
        break;
      }
      case 'choice': {
        const option = question.options?.find((o) => o.value === text);
        if (!option) errors[question.id] = 'choice-invalid';
        else answers[question.id] = option.value;
        break;
      }
    }
  }

  return { answers, errors, valid: Object.keys(errors).length === 0 };
}

/**
 * The option label for a stored choice, or the stored value itself when the
 * option no longer exists — questions change over time and an old application
 * must still render something truthful.
 */
export function choiceLabel(question: ApplicationQuestion | undefined, value: string): string {
  return question?.options?.find((o) => o.value === value)?.label ?? value;
}

/** Who applied, in words: the name answer when there is one, else the email. */
export function applicantLabel(
  questions: readonly ApplicationQuestion[],
  application: Pick<AdoptionApplication, 'answers' | 'applicantEmail'>,
): string {
  const nameQuestion = questions.find((q) => q.purpose === 'applicantName');
  const name = nameQuestion ? application.answers[nameQuestion.id] : undefined;
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : application.applicantEmail;
}

/** The number to call back on, if the form asked for one. */
export function applicantPhone(
  questions: readonly ApplicationQuestion[],
  application: Pick<AdoptionApplication, 'answers'>,
): string | null {
  const phoneQuestion = questions.find((q) => q.purpose === 'applicantPhone');
  const phone = phoneQuestion ? application.answers[phoneQuestion.id] : undefined;
  return typeof phone === 'string' && phone.trim() !== '' ? phone.trim() : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes, described without Firestore
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stands in for `serverTimestamp()` in a pure description of a write. The
 * Firestore layers swap it for the real sentinel — which they must, because the
 * rules compare every timestamp here against `request.time`.
 */
export const SERVER_TIME = Object.freeze({ serverTime: true as const });
export type ServerTime = typeof SERVER_TIME;

export function isServerTime(value: unknown): value is ServerTime {
  return value === SERVER_TIME;
}

/** The exact shape a new application is created with. Mirrors the rules' create branch. */
export type ApplicationCreateWrite = Omit<
  AdoptionApplication,
  'id' | 'submittedAt' | 'updatedAt' | 'withdrawnAt' | 'decidedAt' | 'decidedBy' | 'status'
> & {
  status: 'submitted';
  submittedAt: ServerTime;
  updatedAt: ServerTime;
  withdrawnAt: null;
  decidedAt: null;
  decidedBy: null;
};

export function buildApplicationCreate(input: {
  petId: string;
  applicantUid: string;
  applicantEmail: string;
  applicantEmailVerified: boolean;
  answers: Record<string, ApplicationAnswer>;
}): ApplicationCreateWrite {
  return {
    petId: input.petId,
    applicantUid: input.applicantUid,
    applicantEmail: input.applicantEmail,
    applicantEmailVerified: input.applicantEmailVerified,
    answers: input.answers,
    status: 'submitted',
    submittedAt: SERVER_TIME,
    updatedAt: SERVER_TIME,
    withdrawnAt: null,
    decidedAt: null,
    decidedBy: null,
  };
}

export class IllegalApplicationTransition extends Error {
  constructor(from: ApplicationStatus, to: ApplicationStatus) {
    super(`illegal application transition ${from} → ${to}`);
    this.name = 'IllegalApplicationTransition';
  }
}

/**
 * The applicant's withdrawal. EXACTLY three keys, because the rule gates on the
 * diff: anything else in the patch — even a `decidedBy: null` that changes
 * nothing today — is one edit away from a write the rules refuse.
 */
export interface WithdrawalPatch {
  status: 'withdrawn';
  withdrawnAt: ServerTime;
  updatedAt: ServerTime;
}

export function withdrawalPatch(from: ApplicationStatus): WithdrawalPatch {
  if (!applicantCanWithdraw(from)) throw new IllegalApplicationTransition(from, 'withdrawn');
  return { status: 'withdrawn', withdrawnAt: SERVER_TIME, updatedAt: SERVER_TIME };
}

export interface AdminStatusPatch {
  status: ApplicationStatus;
  updatedAt: ServerTime;
  /** Set iff the new status is a decision; cleared when a decision is reopened. */
  decidedAt: ServerTime | null;
  decidedBy: string | null;
  /** Set iff the new status is `withdrawn` (the applicant told the shelter). */
  withdrawnAt: ServerTime | null;
}

/**
 * An admin's status change, with the bookkeeping the rules require: a decision
 * carries who and when, a reopened decision loses both, and only a withdrawal
 * carries `withdrawnAt`.
 */
export function adminStatusPatch(
  from: ApplicationStatus,
  to: ApplicationStatus,
  adminUid: string,
): AdminStatusPatch {
  if (!canTransitionApplication(from, to)) throw new IllegalApplicationTransition(from, to);
  if (!adminUid) throw new Error('adminStatusPatch: a decision must be attributed');
  const decided = DECIDED_APPLICATION_STATUSES.includes(to);
  return {
    status: to,
    updatedAt: SERVER_TIME,
    decidedAt: decided ? SERVER_TIME : null,
    decidedBy: decided ? adminUid : null,
    withdrawnAt: to === 'withdrawn' ? SERVER_TIME : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Approval
// ─────────────────────────────────────────────────────────────────────────────

export type ApprovalBlocker =
  /** Not in review or interview — see the transition table. */
  | 'application-not-approvable'
  /** The animal's record is gone. */
  | 'pet-missing'
  /** Already belongs to a family. Approving would hand its tiers to a second one. */
  | 'pet-already-adopted'
  /** `arrival.ts` says this status cannot become `adopted` (not yet arrived or cleared). */
  | 'pet-not-ready';

export type ApprovalWarning =
  /** Other people are still waiting on this same animal. */
  | 'other-open-applications'
  /** The applicant never confirmed the email address. */
  | 'email-unverified'
  /** The animal is no longer on the wall — legal, but worth a second look. */
  | 'pet-not-on-wall'
  /**
   * `location/current` exists, and approving lets the new owner read it through
   * `ownsPet()`. For an animal that was fostered it may be a volunteer's home
   * address (the project log concern #2). A warning, because the shelter may have
   * recorded the adopter's own area on purpose.
   */
  | 'location-will-be-visible';

export interface ApprovalContext {
  application: Pick<
    AdoptionApplication,
    'id' | 'petId' | 'applicantUid' | 'applicantEmailVerified' | 'status'
  >;
  /** The pet as it is NOW, or null when the document no longer exists. */
  pet: { id: string; status: PetStatus } | null;
  /** Every OTHER application for the same pet, in any status. */
  otherApplications: readonly Pick<AdoptionApplication, 'id' | 'status'>[];
  /** Whether `pets/{petId}/location/current` exists. Required, so no caller can skip asking. */
  hasRecordedLocation: boolean;
}

export interface ApprovalCheck {
  blockers: ApprovalBlocker[];
  warnings: ApprovalWarning[];
  /** Ids of the other applications still open, so the screen can list them. */
  otherOpenIds: string[];
}

export function approvalCheck(context: ApprovalContext): ApprovalCheck {
  const blockers: ApprovalBlocker[] = [];
  const warnings: ApprovalWarning[] = [];

  if (!canTransitionApplication(context.application.status, 'approved')) {
    blockers.push('application-not-approvable');
  }

  const pet = context.pet;
  if (!pet) {
    blockers.push('pet-missing');
  } else if (pet.status === 'adopted') {
    // Checked BEFORE canTransition, which calls adopted → adopted a legal
    // no-op. For a pet that is right; here it would be the worst outcome in the
    // feature — overwriting `adoptions/{petId}` and silently moving who may
    // read the microchip and location from one family to another.
    blockers.push('pet-already-adopted');
  } else if (!canTransition(pet.status, 'adopted')) {
    blockers.push('pet-not-ready');
  } else if (pet.status !== 'available') {
    warnings.push('pet-not-on-wall');
  }

  const otherOpenIds = context.otherApplications
    .filter((other) => other.id !== context.application.id && isOpenApplication(other.status))
    .map((other) => other.id);
  if (otherOpenIds.length > 0) warnings.push('other-open-applications');

  if (!context.application.applicantEmailVerified) warnings.push('email-unverified');

  if (context.hasRecordedLocation) warnings.push('location-will-be-visible');

  return { blockers, warnings, otherOpenIds };
}

/** A write, described as data, in the order it goes into the batch. */
export type WriteOp =
  | { op: 'set'; path: readonly string[]; data: Record<string, unknown>; merge: boolean }
  | { op: 'update'; path: readonly string[]; data: Record<string, unknown> };

/** `adoptions/{petId}`, as written. Typed so `Adoption` and the writer cannot drift. */
export type AdoptionWrite = Omit<Adoption, 'id' | 'adoptedAt'> & { adoptedAt: ServerTime };

/** A new custody record, as written. */
export type CustodyWrite = Omit<CustodyEvent, 'id' | 'startedAt'> & { startedAt: ServerTime };

export interface ApprovalInput extends ApprovalContext {
  application: ApprovalContext['application'] & Pick<AdoptionApplication, 'applicantEmail'>;
  adminUid: string;
  /** Who the custody record names — `applicantLabel()` of the application. */
  holder: string;
  /** A fresh id for the custody document, minted by the caller. */
  newCustodyId: string;
  /** Custody records still open on this pet: each is closed. */
  openCustodyIds: readonly string[];
  /** Placements still open on this pet: each is closed — see below. */
  openPlacementIds: readonly string[];
}

export class ApprovalBlockedError extends Error {
  readonly blockers: ApprovalBlocker[];
  constructor(blockers: ApprovalBlocker[]) {
    super(`approval blocked: ${blockers.join(', ')}`);
    this.name = 'ApprovalBlockedError';
    this.blockers = blockers;
  }
}

/**
 * Every write an approval makes, for ONE `writeBatch`.
 *
 * 1. the application → `approved`, attributed
 * 2. `adoptions/{petId}` → the applicant owns the animal. This is what
 *    `ownsPet()` resolves, and so what unlocks the microchip, location, scan
 *    and custody tiers to the new family — plan §6 step 5.
 * 3. every open custody record → closed, at the same instant
 * 4. a new `adopter` custody record → opened
 * 5. every open placement → closed. An adopted animal is not inside the
 *    facility (`STATUSES_INSIDE_FACILITY` in `arrival.ts`), and an interval
 *    left open would keep counting it in a pen and in every outbreak trace
 * 6. `pets/{petId}.status` → `adopted`, merged
 *
 * One batch because a half-approved adoption — an owner with no custody
 * record, or an `adopted` animal nobody owns — is not a state worth being able
 * to reach. The rules enforce the pairing too: approving the application is
 * refused unless the same batch writes the adoption and the pet status.
 *
 * ⚠️ `adoptions/{petId}` is a full `set`, not a merge. For an animal adopted,
 * returned and adopted again, the previous family's document is REPLACED —
 * which is the point: they must stop passing `ownsPet()`. Their adoption stays
 * on record in the custody chain and in their own application.
 *
 * ⚠️ Nothing from `answers` is copied anywhere. The custody holder is a name
 * or an email, never the housing and household details the application holds.
 *
 * Throws `ApprovalBlockedError` rather than returning a partial list: a caller
 * that forgot to check `approvalCheck` must not be able to commit anyway.
 */
export function buildApprovalWrites(input: ApprovalInput): WriteOp[] {
  const check = approvalCheck(input);
  if (check.blockers.length > 0) throw new ApprovalBlockedError(check.blockers);

  const { application, pet } = input;
  // Both structural, and both impossible through the UI — they would mean the
  // caller paired an application with the wrong animal or forged an id.
  if (!pet || pet.id !== application.petId) {
    throw new Error('buildApprovalWrites: the application is not for this pet');
  }
  if (application.id !== applicationIdFor(application.petId, application.applicantUid)) {
    throw new Error('buildApprovalWrites: the application id does not match its pet and applicant');
  }
  if (!input.adminUid) throw new Error('buildApprovalWrites: an approval must be attributed');
  if (!input.newCustodyId) throw new Error('buildApprovalWrites: a custody id is required');

  const petPath = ['pets', pet.id] as const;

  const adoption: AdoptionWrite = {
    petId: pet.id,
    ownerUid: application.applicantUid,
    adoptedAt: SERVER_TIME,
    approvedBy: input.adminUid,
    applicationId: application.id,
  };

  const custody: CustodyWrite = {
    kind: 'adopter',
    holder: input.holder.trim() || application.applicantEmail,
    holderUid: application.applicantUid,
    startedAt: SERVER_TIME,
    endedAt: null,
    note: null,
    recordedBy: input.adminUid,
  };

  const writes: WriteOp[] = [
    {
      op: 'update',
      path: ['adoptionApplications', application.id],
      data: { ...adminStatusPatch(application.status, 'approved', input.adminUid) },
    },
    { op: 'set', path: ['adoptions', pet.id], data: { ...adoption }, merge: false },
  ];

  for (const id of new Set(input.openCustodyIds)) {
    if (id === input.newCustodyId) continue;
    writes.push({ op: 'update', path: [...petPath, 'custody', id], data: { endedAt: SERVER_TIME } });
  }
  writes.push({
    op: 'set',
    path: [...petPath, 'custody', input.newCustodyId],
    data: { ...custody },
    merge: false,
  });

  for (const id of new Set(input.openPlacementIds)) {
    writes.push({
      op: 'update',
      path: [...petPath, 'placements', id],
      data: { endedAt: SERVER_TIME },
    });
  }

  writes.push({
    op: 'set',
    path: [...petPath],
    data: { status: 'adopted', updatedAt: SERVER_TIME },
    merge: true,
  });

  return writes;
}

// ─────────────────────────────────────────────────────────────────────────────
// The admin queue
// ─────────────────────────────────────────────────────────────────────────────

export type ApplicationFilter = 'open' | 'all' | ApplicationStatus;

export function matchesApplicationFilter(
  status: ApplicationStatus,
  filter: ApplicationFilter,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'open') return isOpenApplication(status);
  return status === filter;
}

export interface ApplicationGroup<T> {
  petId: string;
  applications: T[];
}

/**
 * The queue, grouped by animal: plan §6 has the admin see applications
 * "queued against the pet", because the decision is always between the people
 * asking for the SAME animal.
 *
 * Oldest first, both within a group and across groups. A queue is fair when
 * whoever has waited longest is at the top — and the animal whose first
 * applicant has waited longest is the one the shelter is most behind on.
 */
export function groupApplicationsByPet<
  T extends { petId: string; status: ApplicationStatus; submittedAt: number },
>(applications: readonly T[], filter: ApplicationFilter): ApplicationGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const application of applications) {
    if (!matchesApplicationFilter(application.status, filter)) continue;
    const list = groups.get(application.petId) ?? [];
    list.push(application);
    groups.set(application.petId, list);
  }

  return [...groups.entries()]
    .map(([petId, list]) => ({
      petId,
      applications: [...list].sort((a, b) => a.submittedAt - b.submittedAt),
    }))
    .sort((a, b) => a.applications[0]!.submittedAt - b.applications[0]!.submittedAt);
}
