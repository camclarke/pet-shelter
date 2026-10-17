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
 * `arrival.ts` says cannot become adopted, an application nobody has moved
 * into review, and — since portion 4a, by owner decision — an application whose
 * ID photo has not arrived. Everything the shelter can have a good reason for — other people
 * still waiting, an unverified email, an animal taken off the wall mid-interview
 * — only WARNS. Nothing here ever changes another application automatically:
 * turning someone down is a conversation, not a side effect.
 */

import { SHELTER, type ApplicationAnswerStore, type ApplicationQuestion } from '@/config/shelter';
import type { AdoptionContract } from '@/config/adoption-contract';
import { canTransition } from './arrival';
import type {
  Adoption,
  AdoptionApplication,
  ApplicationAnswer,
  ApplicationHome,
  ApplicationIdentity,
  ApplicationStatus,
  CustodyEvent,
  IdDocumentSide,
  PetStatus,
} from './types';

/** The sides this shelter asks for. Overridable per call so the tests can vary it. */
const CONFIGURED_ID_SIDES: readonly IdDocumentSide[] = SHELTER.adoptionApplications.idDocumentSides;

/** The questions this shelter asks. Overridable per call so the tests can vary them. */
const CONFIGURED_QUESTIONS: readonly ApplicationQuestion[] = SHELTER.adoptionApplications.questions;

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

/**
 * A Bolivian C.I. as the form accepts it — SHAPE, never semantics (plan §3.3).
 * 4 to 20 characters after tidying; only letters (Ñ included), digits, spaces,
 * `.` and `-`; at least 4 digits. Stored as typed (tidied), never upper-cased
 * and never split into number, complement and extension.
 *
 * ⚠️ `CI_MIN_CHARS` and `CI_MAX_CHARS` are MIRRORED in `validIdentity()` in
 * `firestore.rules`, which checks only the length — a test fails if they
 * drift. The charset and the digit count are the form's stricter check.
 */
export const CI_MIN_CHARS = 4;
export const CI_MAX_CHARS = 20;
export const CI_MIN_DIGITS = 4;

export const ANSWER_MAX_CHARS = {
  shortText: 120,
  phone: 30,
  idNumber: CI_MAX_CHARS,
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
  /** Not a C.I. as `tidyIdNumber` reads one. */
  | 'id-number-invalid'
  | 'count-invalid'
  /**
   * A count below its question's `min`. Only the age question has one: the
   * contract says "mayor de edad", so an applicant under 18 is refused here
   * and by the rules (owner decision D4).
   */
  | 'under-age'
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

/**
 * A C.I. number, tidied, or null when it cannot be one. NFC, trimmed, runs of
 * spaces collapsed — and nothing else: no upper-casing, no splitting.
 */
export function tidyIdNumber(text: string): string | null {
  const tidy = text.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (tidy.length < CI_MIN_CHARS || tidy.length > CI_MAX_CHARS) return null;
  if (!/^[0-9A-Za-zÑñ .-]+$/.test(tidy)) return null;
  if ((tidy.match(/[0-9]/g) ?? []).length < CI_MIN_DIGITS) return null;
  return tidy;
}

/**
 * Is this question asked, given the answers so far? A question with no
 * `askedWhen` always is. One with an `askedWhen` is asked only when its
 * controlling question is itself asked AND answered with one of `values`.
 *
 * Works on a form draft (strings, booleans, null) and on stored answers alike,
 * so the admin screen hides exactly what the form never asked.
 */
export function isQuestionAsked(
  questions: readonly ApplicationQuestion[],
  question: ApplicationQuestion,
  answers: Readonly<Record<string, unknown>>,
  seen: ReadonlySet<string> = new Set(),
): boolean {
  const condition = question.askedWhen;
  if (!condition) return true;
  // A cycle is a configuration error; a test requires every askedWhen to name
  // an EARLIER question. Refuse rather than recurse forever.
  if (seen.has(question.id)) return false;
  const controlling = questions.find((q) => q.id === condition.questionId);
  if (!controlling) return false;
  if (!isQuestionAsked(questions, controlling, answers, new Set([...seen, question.id]))) return false;
  const raw = answers[condition.questionId];
  const value = typeof raw === 'string' ? raw.trim() : raw;
  return condition.values.some((v) => v === value);
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
 * A question whose `askedWhen` is not met is DROPPED and never required: a
 * landlord typed and then hidden by switching to PROPIO is not stored.
 *
 * An unanswered optional question is ABSENT from the result, never null — the
 * rules treat an explicit null as a malformed answer.
 *
 * The result holds BOTH stores; `splitAnswersByStore` separates them before
 * anything is written.
 */
export function validateAnswers(
  questions: readonly ApplicationQuestion[],
  draft: AnswerDraft,
): AnswerValidation {
  const answers: Record<string, ApplicationAnswer> = {};
  const errors: Record<string, ApplicationAnswerError> = {};

  for (const question of questions) {
    if (!isQuestionAsked(questions, question, draft)) continue;
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
      case 'idNumber': {
        const tidy = tidyIdNumber(text);
        if (tidy === null) errors[question.id] = 'id-number-invalid';
        else answers[question.id] = tidy;
        break;
      }
      case 'count': {
        const max = Math.min(question.max ?? DEFAULT_COUNT_MAX, RULES_ANSWER_MAX_COUNT);
        const min = Math.max(question.min ?? 0, 0);
        if (!/^\d{1,2}$/.test(text)) {
          errors[question.id] = 'count-invalid';
          break;
        }
        const value = Number(text);
        if (value > max) errors[question.id] = 'count-invalid';
        else if (value < min) errors[question.id] = 'under-age';
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
  | 'id'
  | 'submittedAt'
  | 'updatedAt'
  | 'withdrawnAt'
  | 'decidedAt'
  | 'decidedBy'
  | 'status'
  | 'termsAcceptedAt'
  | 'idDocument'
  | 'identityErasedAt'
> & {
  status: 'submitted';
  submittedAt: ServerTime;
  updatedAt: ServerTime;
  withdrawnAt: null;
  decidedAt: null;
  decidedBy: null;
  termsAcceptedAt: ServerTime;
  /** Every configured side present and null: nothing has been received yet. */
  idDocument: Partial<Record<IdDocumentSide, null>>;
  identityErasedAt: null;
};

/** What an application records about the contract: which text, by version and hash. */
export type ContractAcceptance = Pick<AdoptionContract, 'version' | 'sha256'>;

/**
 * There is no contract to apply under. `ADOPTION_CONTRACT` is null until the
 * shelter supplies its real text, and while it is, nothing can be accepted —
 * so no application can even be described, let alone sent.
 */
export class ContractUnavailableError extends Error {
  constructor(reason = 'no adoption contract is configured') {
    super(`contract unavailable: ${reason}`);
    this.name = 'ContractUnavailableError';
  }
}

const CONTRACT_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The contract an application may be created under, or a thrown
 * `ContractUnavailableError`. A null contract — today's state — and a
 * malformed one are both refused, because either would write a version or a
 * hash the rules cannot match.
 */
export function requireContract(contract: ContractAcceptance | null): ContractAcceptance {
  if (contract === null) throw new ContractUnavailableError();
  if (!CONTRACT_VERSION_PATTERN.test(contract.version)) {
    throw new ContractUnavailableError('the contract version is not a YYYY-MM-DD date');
  }
  if (!SHA256_HEX_PATTERN.test(contract.sha256)) {
    throw new ContractUnavailableError('the contract hash is not a lower-case hex sha256');
  }
  return contract;
}

/**
 * What the person did on screen: ticked the acceptance box, under the contract
 * version that was DISPLAYED to them. The caller passes it explicitly — an
 * application never records acceptance on its own.
 */
export interface AcceptanceGiven {
  /** True only when the box was ticked. Anything else refuses the write. */
  accepted: boolean;
  /** The `version` of the contract text the screen showed. */
  contractVersion: string;
}

/**
 * The person did not accept, or accepted a different contract version than
 * the one being recorded (a tab left open across a contract revision). Thrown
 * before anything is sent.
 */
export class ContractNotAcceptedError extends Error {
  constructor(reason: string) {
    super(`contract not accepted: ${reason}`);
    this.name = 'ContractNotAcceptedError';
  }
}

/**
 * Throws `ContractNotAcceptedError` unless the box was ticked (`accepted` is
 * exactly `true`) for exactly this contract's version. Pure, so the browser
 * can refuse before any network call; `buildApplicationCreate` calls it too.
 */
export function requireAcceptance(
  acceptance: AcceptanceGiven | null | undefined,
  contract: ContractAcceptance,
): asserts acceptance is AcceptanceGiven {
  if (acceptance?.accepted !== true) {
    throw new ContractNotAcceptedError('the acceptance box was not ticked');
  }
  if (acceptance.contractVersion !== contract.version) {
    throw new ContractNotAcceptedError(
      `the screen showed version ${acceptance.contractVersion}, not ${contract.version}`,
    );
  }
}

/**
 * A new application, as written.
 *
 * `contract` is REQUIRED and has no default on purpose: the caller must pass
 * `ADOPTION_CONTRACT` explicitly, and while that is null this throws
 * `ContractUnavailableError` — the browser half of the third lock. The rules
 * half is `acceptedContracts()`.
 *
 * `acceptance` is REQUIRED too (review 4c-1 #6): `termsAcceptedAt` and the
 * contract pair are written only when the caller says the box was ticked
 * (`accepted: true`) for the SAME version it is recording. Otherwise this
 * throws `ContractNotAcceptedError`, so no code path can record an acceptance
 * nobody gave.
 */
export function buildApplicationCreate(input: {
  petId: string;
  applicantUid: string;
  applicantEmail: string;
  applicantEmailVerified: boolean;
  answers: Record<string, ApplicationAnswer>;
  contract: ContractAcceptance | null;
  acceptance: AcceptanceGiven;
  /** Defaults to `SHELTER.adoptionApplications.idDocumentSides`. */
  idDocumentSides?: readonly IdDocumentSide[];
}): ApplicationCreateWrite {
  const contract = requireContract(input.contract);
  requireAcceptance(input.acceptance, contract);
  const sides = input.idDocumentSides ?? CONFIGURED_ID_SIDES;
  if (sides.length === 0) throw new Error('buildApplicationCreate: no identity document side is configured');
  const idDocument: Partial<Record<IdDocumentSide, null>> = {};
  for (const side of sides) idDocument[side] = null;

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
    contractVersion: contract.version,
    contractSha256: contract.sha256,
    termsAcceptedAt: SERVER_TIME,
    idDocument,
    identityErasedAt: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The home address — `adoptionApplications/{id}/private/home`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The bounds `firestore.rules` enforces on `private/home`. MIRRORED in
 * `validHome()` there, which is the enforcing copy; a test fails if the two
 * drift. Lengths are UTF-16 code units on both sides (JavaScript `.length`
 * and the rules' `size()`), and the minimum is on the TRIMMED address.
 */
export const HOME_ADDRESS_MIN_CHARS = 5;
export const HOME_ADDRESS_MAX_CHARS = 300;
export const HOME_REFERENCE_MAX_CHARS = 300;

/** Decimal places a pin keeps: about 11 m of latitude at Cochabamba. */
export const PIN_DECIMALS = 4;

/** A point as plain numbers. The Firestore layer turns it into a `GeoPoint`. */
export interface PinCoordinates {
  latitude: number;
  longitude: number;
}

/**
 * A pin rounded to 4 decimal places — about 11 m in latitude here (INFERRED
 * from the geometry: one degree of latitude is about 111 km).
 *
 * Why 4: a fingertip on a phone map is no more accurate than that, the pin's
 * only purpose is finding the house for the home visit, and the typed address
 * and landmark do the rest. Storing finer gains nothing; rounding to 3 (about
 * 110 m) would defeat the purpose.
 *
 * Rounds half away from zero, and never returns `-0`. The caller checks the
 * service area AFTER rounding, because the rounded value is what is stored and
 * what the rules check: a point a few metres outside an edge can round onto it.
 */
export function roundPin4(pin: PinCoordinates): PinCoordinates {
  return { latitude: roundTo4(pin.latitude), longitude: roundTo4(pin.longitude) };
}

function roundTo4(value: number): number {
  const scale = 10 ** PIN_DECIMALS;
  const rounded = (Math.sign(value) * Math.round(Math.abs(value) * scale)) / scale;
  return rounded === 0 ? 0 : rounded;
}

/**
 * A Google Maps link to a pin, for the admin review. Only the rounded point
 * travels, and only when an admin taps the link.
 */
export function googleMapsUrl(latitude: number, longitude: number): string {
  const pin = roundPin4({ latitude, longitude });
  return `https://www.google.com/maps/search/?api=1&query=${pin.latitude},${pin.longitude}`;
}

export type ApplicationHomeError =
  | 'address-required'
  | 'address-too-short'
  | 'address-too-long'
  | 'reference-too-long'
  /** Not a finite point on Earth — a broken map, never something a person typed. */
  | 'pin-invalid'
  /** Outside `SHELTER.bounds`: the team visits every home, so online is for the service area only. */
  | 'pin-outside-area';

export interface HomeDraft {
  addressText: string;
  reference: string;
  /** The confirmed map point, or null when the person sends the address alone. */
  pin: PinCoordinates | null;
}

/** A home that `validHome()` in the rules will accept. Only `validateHome` makes one. */
export interface ValidHome {
  addressText: string;
  reference: string;
  geo: PinCoordinates | null;
  precision: 'exact' | null;
}

export interface HomeValidation {
  /** Null unless every field is valid. */
  home: ValidHome | null;
  /** Per field. Empty when the home can be sent. */
  errors: Partial<Record<'addressText' | 'reference' | 'pin', ApplicationHomeError>>;
  valid: boolean;
}

/** One line, single spaces: an address is read back to a person on a phone. */
function tidyLine(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * Validate and normalise the address step into exactly what `validHome()`
 * accepts. Refuses rather than cuts — a cut address is one the person never
 * wrote.
 */
export function validateHome(
  draft: HomeDraft,
  bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number } = SHELTER.bounds,
): HomeValidation {
  const errors: HomeValidation['errors'] = {};

  const addressText = tidyLine(draft.addressText);
  if (addressText === '') errors.addressText = 'address-required';
  else if (addressText.length < HOME_ADDRESS_MIN_CHARS) errors.addressText = 'address-too-short';
  else if (addressText.length > HOME_ADDRESS_MAX_CHARS) errors.addressText = 'address-too-long';

  const reference = tidyLine(draft.reference);
  if (reference.length > HOME_REFERENCE_MAX_CHARS) errors.reference = 'reference-too-long';

  let geo: PinCoordinates | null = null;
  if (draft.pin !== null) {
    const { latitude, longitude } = draft.pin;
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    ) {
      errors.pin = 'pin-invalid';
    } else {
      const rounded = roundPin4({ latitude, longitude });
      const inside =
        rounded.latitude >= bounds.minLat &&
        rounded.latitude <= bounds.maxLat &&
        rounded.longitude >= bounds.minLng &&
        rounded.longitude <= bounds.maxLng;
      if (inside) geo = rounded;
      else errors.pin = 'pin-outside-area';
    }
  }

  const valid = Object.keys(errors).length === 0;
  return {
    home: valid ? { addressText, reference, geo, precision: geo ? 'exact' : null } : null,
    errors,
    valid,
  };
}

/** `private/home`, as written. Typed so `ApplicationHome` and the writer cannot drift. */
export type HomeCreateWrite = Omit<
  ApplicationHome,
  'geo' | 'createdAt' | 'correctedAt' | 'correctedBy'
> & {
  geo: PinCoordinates | null;
  createdAt: ServerTime;
};

export class InvalidHomeError extends Error {
  readonly errors: HomeValidation['errors'];
  constructor(errors: HomeValidation['errors']) {
    super(`invalid home: ${Object.values(errors).join(', ')}`);
    this.name = 'InvalidHomeError';
    this.errors = errors;
  }
}

/**
 * The address document, for the SAME batch as the application.
 *
 * Re-validates rather than trusting its argument, and throws instead of
 * returning a partial document: a caller that skipped `validateHome` must not
 * be able to send something the rules would refuse — or, worse, something
 * they accept that is not what the person typed.
 */
export function buildHomeCreate(input: {
  applicantUid: string;
  home: ValidHome;
  bounds?: Parameters<typeof validateHome>[1];
}): HomeCreateWrite {
  if (!input.applicantUid) throw new Error('buildHomeCreate: the applicant is required');
  const check = validateHome(
    { addressText: input.home.addressText, reference: input.home.reference, pin: input.home.geo },
    input.bounds,
  );
  if (!check.valid || !check.home) throw new InvalidHomeError(check.errors);
  if ((input.home.geo === null) !== (input.home.precision === null)) {
    throw new InvalidHomeError({ pin: 'pin-invalid' });
  }
  return {
    applicantUid: input.applicantUid,
    addressText: check.home.addressText,
    reference: check.home.reference,
    geo: check.home.geo,
    precision: check.home.precision,
    createdAt: SERVER_TIME,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Personal details and third parties — `adoptionApplications/{id}/private/identity`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every document under `adoptionApplications/{id}/private/`. MIRRORED in the
 * rules' `private` create (`docId in [...]`); a test fails if they drift.
 *
 * ⚠️ The admin's erase route (portion 4e; nothing is erased automatically) MUST import
 * this list rather than naming documents themselves, so neither can forget
 * `identity`. A guard (application-identity.test.ts, guard 3) checks it does.
 */
export const PRIVATE_DOCUMENT_IDS = ['home', 'identity'] as const;
export type PrivateDocumentId = (typeof PRIVATE_DOCUMENT_IDS)[number];

/**
 * `adoptionApplications/{id}/private/acceptance` — the audit trail of the
 * electronic consent (the contract's first additional clause): when, from
 * which IP, by which account. Written ONLY by the acceptance route through the
 * Admin SDK; the rules' private create admits `PRIVATE_DOCUMENT_IDS` alone, so
 * no browser can write one. Admin-only to read.
 *
 * Deliberately NOT in `PRIVATE_DOCUMENT_IDS`: the erase action removes the
 * carnet photo and the address (the retention clause names those), and keeps
 * this record — it is the evidence that the agreement was made.
 * MIRRORED in the rules' `acceptanceRecorded()`; a test fails if they drift.
 */
export const ACCEPTANCE_DOCUMENT_ID = 'acceptance';

/**
 * `adoptionApplications/{id}/internal/notes` — the shelter's notes on an
 * applicant. Unlike the private documents it is KEPT with the application, so
 * the rule for writing it is that notes record that a correction was needed,
 *never a C.I. number or anyone's phone (D15). The admin's erase route
 * (portion 4e) must BLANK its `text` when it erases the personal details, as a backstop
 * for a note that broke that rule. MIRRORED in the rules' `match /internal/
 * {docId}` (`docId == 'notes'`); a test fails if they drift, and a guard
 * checks the erase route imports this.
 */
export const INTERNAL_NOTES_DOCUMENT = {
  subcollection: 'internal',
  id: 'notes',
  /** The field the erase sets to '' — the only one that holds free text. */
  blankField: 'text',
} as const;

/**
 * The bounds `firestore.rules` enforces on `private/identity`. MIRRORED in
 * `validIdentityAnswer()` and `validIdentity()` there, which are the enforcing
 * copy; a test fails if the two drift.
 *   - every answer is a string of at most `IDENTITY_ANSWER_MAX_CHARS`,
 *   - except `age`, a whole number from `IDENTITY_AGE_MIN` to `IDENTITY_AGE_MAX`,
 *   - and `ciNumber`, `CI_MIN_CHARS` to `CI_MAX_CHARS` characters.
 * `ciNumber` and `age` are the two the rules REQUIRE, because the contract
 * names them: "mayor de edad, con C.I. …".
 */
export const IDENTITY_ANSWER_MAX_CHARS = 120;
export const IDENTITY_AGE_MIN = 18;
export const IDENTITY_AGE_MAX = 99;
export const IDENTITY_REQUIRED_KEYS = ['ciNumber', 'age'] as const;

/**
 * Separate validated answers by where they are written: `application` into the
 * main document's `answers`, `identity` into `private/identity`. A key that
 * belongs to no configured question is dropped, as in `validateAnswers`.
 */
export function splitAnswersByStore(
  questions: readonly ApplicationQuestion[],
  answers: Readonly<Record<string, ApplicationAnswer>>,
): Record<ApplicationAnswerStore, Record<string, ApplicationAnswer>> {
  const split: Record<ApplicationAnswerStore, Record<string, ApplicationAnswer>> = {
    application: {},
    identity: {},
  };
  const storeOf = new Map(questions.map((q) => [q.id, q.store]));
  for (const [key, value] of Object.entries(answers)) {
    const store = storeOf.get(key);
    if (store) split[store][key] = value;
  }
  return split;
}

/** `private/identity`, as written. Typed so `ApplicationIdentity` and the writer cannot drift. */
export type IdentityCreateWrite = Omit<ApplicationIdentity, 'createdAt'> & { createdAt: ServerTime };

export class InvalidIdentityError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid identity: ${problems.join(', ')}`);
    this.name = 'InvalidIdentityError';
    this.problems = problems;
  }
}

/**
 * Everything wrong with an identity answer set, as the rules AND the form
 * would see it — empty when it can be written. Each value is re-checked
 * against its own question's kind, so a caller that skipped `validateAnswers`
 * cannot send a value the person never typed in that shape.
 */
export function identityProblems(
  identity: Readonly<Record<string, ApplicationAnswer>>,
  questions: readonly ApplicationQuestion[] = CONFIGURED_QUESTIONS,
): string[] {
  const problems: string[] = [];
  const byId = new Map(questions.filter((q) => q.store === 'identity').map((q) => [q.id, q]));

  for (const key of IDENTITY_REQUIRED_KEYS) {
    if (!(key in identity)) problems.push(`${key}: missing`);
  }

  for (const [key, value] of Object.entries(identity)) {
    const question = byId.get(key);
    if (!question) {
      problems.push(`${key}: not an identity question`);
      continue;
    }
    if (key === 'age') {
      const ok =
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= IDENTITY_AGE_MIN &&
        value <= IDENTITY_AGE_MAX;
      if (!ok) problems.push(`age: not a whole number from ${IDENTITY_AGE_MIN} to ${IDENTITY_AGE_MAX}`);
      continue;
    }
    if (typeof value !== 'string' || value.length > IDENTITY_ANSWER_MAX_CHARS || value.trim() === '') {
      problems.push(`${key}: not a non-empty string of at most ${IDENTITY_ANSWER_MAX_CHARS} characters`);
      continue;
    }
    if (question.kind === 'idNumber' && tidyIdNumber(value) !== value) problems.push(`${key}: not a C.I.`);
    if (question.kind === 'phone' && (value.length > ANSWER_MAX_CHARS.phone || phoneDigits(value) === null)) {
      problems.push(`${key}: not a phone number`);
    }
    if (question.kind === 'shortText' && value !== value.trim().replace(/\s+/g, ' ')) {
      problems.push(`${key}: not tidied`);
    }
  }
  return problems;
}

/**
 * The personal-details document, for the SAME batch as the application.
 *
 * Re-validates rather than trusting its argument, and throws instead of
 * returning a partial document — the `buildHomeCreate` pattern. Writes exactly
 * `applicantUid`, `answers` and `createdAt`: the three keys the rules require.
 */
export function buildIdentityCreate(input: {
  applicantUid: string;
  identity: Readonly<Record<string, ApplicationAnswer>>;
  questions?: readonly ApplicationQuestion[];
}): IdentityCreateWrite {
  if (!input.applicantUid) throw new Error('buildIdentityCreate: the applicant is required');
  const problems = identityProblems(input.identity, input.questions);
  if (problems.length > 0) throw new InvalidIdentityError(problems);
  return {
    applicantUid: input.applicantUid,
    // Safe after identityProblems: every value is a string, except age, a number.
    answers: { ...(input.identity as Record<string, string | number>) },
    createdAt: SERVER_TIME,
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
  | 'pet-not-ready'
  /**
   * A configured side of the ID photo has not arrived. Owner decision,
   * 2026-10-16: the front is required before approval. The rules enforce it
   * too (`idDocumentReceived()`), so this is the screen saying so first.
   */
  | 'id-document-missing'
  /**
   * No `private/acceptance`: the audit trail of the electronic consent (time,
   * IP, account) was never recorded. The rules enforce it too
   * (`acceptanceRecorded()`), so this is the screen saying so first.
   */
  | 'acceptance-missing';

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

/**
 * What approval needs to know about the ID photo: whether each side has a
 * receipt. The receipt's CONTENTS do not matter here — the admin layer
 * converts timestamps, the rules see the raw map — only whether it IS one,
 * by `isReceivedMarker`.
 */
export type IdDocumentMarker = Partial<Record<IdDocumentSide, unknown>>;

/**
 * Is this one side's value a RECEIPT — the map the upload route writes?
 *
 * ⚠️ THE ONE "RECEIVED" CHECK. It mirrors `idDocumentReceived()` in
 * `firestore.rules`, which is `idDocument.get('front', null) is map`, and the
 * upload route, `idDocumentComplete()` and the admin layer all call it, so the
 * route, the screen and the rule cannot disagree about what counts.
 *
 * A plain object — what Firestore hands back for a map, from either SDK — and
 * nothing else. A missing key, `null`, `false`, `0`, a string, an array, a
 * `Timestamp` or any other class instance is NOT received. Never compare with
 * `=== null`: on a document whose marker is `{}` (valid at create, critic #3)
 * that reads a side as present, and the applicant's first upload is refused as
 * "already received" — stuck for good.
 */
export function isReceivedMarker(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Has every configured side of the ID photo arrived?
 *
 * A missing marker (an application from before portion 4a, or a malformed
 * document) counts as NOT received — the same answer the rules give, where
 * reading a missing `idDocument` errors and so denies. So does any side whose
 * value is not a receipt map (`isReceivedMarker`): `false` is not a photo.
 */
export function idDocumentComplete(
  idDocument: IdDocumentMarker | null | undefined,
  sides: readonly IdDocumentSide[] = CONFIGURED_ID_SIDES,
): boolean {
  if (!isReceivedMarker(idDocument) || sides.length === 0) return false;
  const marker = idDocument as IdDocumentMarker;
  return sides.every((side) => isReceivedMarker(marker[side]));
}

/**
 * The queue's badge for the ID photo — three states, critic 2026-10-16 #7:
 *   - `'erased'`  — `identityErasedAt` is set: the photo and address were
 *                    erased under the retention policy ("Datos borrados");
 *   - `'missing'` — still open, and a configured side has not arrived
 *                    ("Sin carnet"): the approval rule will refuse it;
 *   - `null`      — received, or closed without one (nothing to chase).
 * Erased is checked FIRST: a rejection reopened after the erase is open AND
 * erased, and "Sin carnet" would invite a re-upload the route refuses.
 */
export type IdDocumentBadge = 'erased' | 'missing' | null;

/**
 * Has this application's identity (the ID photo and the home address) been
 * erased? ⚠️ THE ONE "ERASED" CHECK: `identityErasedAt` is anything but
 * `null` or missing. Not "is a Timestamp" — a value of any other shape is
 * still somebody having erased it, and the upload route, the queue badge and
 * the review screen must all read it the same way (review 4b #7: the route
 * said erased for any non-null value while the admin layer, which converted
 * through `instanceof Timestamp`, read a non-Timestamp as NOT erased).
 * `id-document-handler.ts` and `applications-admin.ts` both call this.
 */
export function isIdentityErased(identityErasedAt: unknown): boolean {
  return identityErasedAt !== null && identityErasedAt !== undefined;
}

export function idDocumentBadge(
  application: {
    status: ApplicationStatus;
    idDocument: IdDocumentMarker | null | undefined;
    /** Already decided through `isIdentityErased` — the admin record carries it. */
    identityErased: boolean;
  },
  sides: readonly IdDocumentSide[] = CONFIGURED_ID_SIDES,
): IdDocumentBadge {
  if (application.identityErased) return 'erased';
  if (isOpenApplication(application.status) && !idDocumentComplete(application.idDocument, sides)) {
    return 'missing';
  }
  return null;
}

export interface ApprovalContext {
  application: Pick<
    AdoptionApplication,
    'id' | 'petId' | 'applicantUid' | 'applicantEmailVerified' | 'status'
  > & {
    /** Required, so no caller can approve without having read the marker. */
    idDocument: IdDocumentMarker;
  };
  /** The pet as it is NOW, or null when the document no longer exists. */
  pet: { id: string; status: PetStatus } | null;
  /** Every OTHER application for the same pet, in any status. */
  otherApplications: readonly Pick<AdoptionApplication, 'id' | 'status'>[];
  /** Whether `pets/{petId}/location/current` exists. Required, so no caller can skip asking. */
  hasRecordedLocation: boolean;
  /** Whether `private/acceptance` exists. Required, so no caller can skip asking. */
  hasAcceptanceRecord: boolean;
}

export interface ApprovalCheck {
  blockers: ApprovalBlocker[];
  warnings: ApprovalWarning[];
  /** Ids of the other applications still open, so the screen can list them. */
  otherOpenIds: string[];
}

/**
 * `idDocumentSides` defaults to `SHELTER.adoptionApplications.idDocumentSides`;
 * the parameter exists so the tests can vary it.
 */
export function approvalCheck(
  context: ApprovalContext,
  idDocumentSides: readonly IdDocumentSide[] = CONFIGURED_ID_SIDES,
): ApprovalCheck {
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

  if (!idDocumentComplete(context.application.idDocument, idDocumentSides)) {
    blockers.push('id-document-missing');
  }

  if (!context.hasAcceptanceRecord) blockers.push('acceptance-missing');

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
