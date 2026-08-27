/**
 * Medical records: the PURE layer.
 *
 * No Firestore, no AI, no Spanish. `medical-admin.ts` does the writing.
 * Build-order step 7, plan §2.1.
 *
 * ═══ WHY THIS SCHEMA LOOKS THE WAY IT DOES ══════════════════════════════════
 * There is NO international standard for a companion animal's electronic
 * medical record — nothing in veterinary medicine corresponds to FHIR or LOINC.
 * See `docs/veterinary-records-standards.md`. This is modelled on the EU pet
 * passport's section structure (the only published field schema for this data)
 * plus WSAVA 2024's certificate fields.
 *
 * ═══ A NULL VET OR BATCH IS NOT AN INCOMPLETE RECORD ════════════════════════
 * ⚠️ Bolivia's free national rabies campaign produces exactly this shape: a
 * real, valid vaccination with no named veterinarian and no lot number.
 * Cochabamba receives the largest departmental allocation in the country, so
 * here that is the COMMON case, not an edge case. Any validation that treats a
 * missing vet as an error will reject most of the real records this shelter
 * holds, and the staff will stop entering them.
 *
 * ═══ FAILURE DIRECTION: WARN, DO NOT BLOCK ══════════════════════════════════
 * Only structurally impossible things are errors — a missing name, a date in
 * the future, a due date before the dose. Everything clinical is a WARNING that
 * leaves the save button enabled. A record the shelter cannot save is a record
 * that lives on paper, and plan §3's rule is that a gate stricter than the
 * shelter's reality gets worked around. Contrast the microchip conflict gate,
 * which genuinely blocks, because there the write corrupts an identity.
 */

import type { MedicalRecordKind } from './types';
import { CLOCK_SKEW_TOLERANCE_MS } from './placements';

// ─────────────────────────────────────────────────────────────────────────────
// Regulatory constants
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/**
 * Days after a primary rabies dose before protection legally BEGINS.
 *
 * ⚠️ This is the date with legal force at a border, and it is NOT the injection
 * date. Regulation (EU) 2026/131, which superseded 576/2013 on 22 April 2026.
 */
export const RABIES_PROTECTION_DELAY_DAYS = 21;

/**
 * Minimum age at rabies vaccination.
 *
 * ⚠️ Added by Reg. (EU) 2026/131 and NOT present in the superseded 576/2013.
 * `docs/veterinary-records-standards.md` recorded this as a rule the code did
 * not yet validate; this closes that gap.
 */
export const RABIES_MIN_AGE_WEEKS = 12;

// ─────────────────────────────────────────────────────────────────────────────
// The draft a form holds
// ─────────────────────────────────────────────────────────────────────────────

export interface MedicalRecordDraft {
  kind: MedicalRecordKind | null;
  /** e.g. "Rabia", "Quíntuple", "Ivermectina". Free text, in the vet's words. */
  name: string;
  /** Epoch ms. Null while the form is incomplete. */
  performedAt: number | null;
  nextDueAt: number | null;
  validFrom: number | null;
  validUntil: number | null;
  /** Null is legitimate — see the module header. */
  veterinarian: string | null;
  clinic: string | null;
  batch: string | null;
  manufacturer: string | null;
  notes: string | null;
}

export function medicalDraftDefaults(): MedicalRecordDraft {
  return {
    kind: null,
    name: '',
    performedAt: null,
    nextDueAt: null,
    validFrom: null,
    validUntil: null,
    veterinarian: null,
    clinic: null,
    batch: null,
    manufacturer: null,
    notes: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors: structurally impossible only
// ─────────────────────────────────────────────────────────────────────────────

export type MedicalError =
  | 'kind-required'
  | 'name-required'
  | 'performed-required'
  | 'performed-in-future'
  | 'due-before-performed'
  | 'valid-until-before-valid-from';

/**
 * ⚠️ Clock skew is real here. Firestore's clock measured 2.7 s AHEAD of the dev
 * machine on 2026-08-24, and a browser clock drifts by minutes. Without the
 * tolerance, a vet entering "today" would sometimes be told the date is in the
 * future.
 */
export function validateMedicalDraft(
  draft: MedicalRecordDraft,
  now: number = Date.now()
): MedicalError[] {
  const errors: MedicalError[] = [];

  if (draft.kind === null) errors.push('kind-required');
  if (!draft.name.trim()) errors.push('name-required');

  if (draft.performedAt === null) {
    errors.push('performed-required');
  } else if (draft.performedAt > now + CLOCK_SKEW_TOLERANCE_MS) {
    errors.push('performed-in-future');
  }

  if (
    draft.performedAt !== null &&
    draft.nextDueAt !== null &&
    draft.nextDueAt < draft.performedAt
  ) {
    errors.push('due-before-performed');
  }

  if (
    draft.validFrom !== null &&
    draft.validUntil !== null &&
    draft.validUntil < draft.validFrom
  ) {
    errors.push('valid-until-before-valid-from');
  }

  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// Warnings: clinically notable, never blocking
// ─────────────────────────────────────────────────────────────────────────────

export type MedicalWarning =
  /** Rabies dose recorded before the chip was implanted — voids it under EU rules. */
  | 'rabies-before-microchip'
  /** Animal was younger than 12 weeks at a rabies dose. */
  | 'rabies-under-age'
  /** A rabies record with no protection-start date, which is the date with legal force. */
  | 'rabies-no-valid-from'
  /** Vaccination with no next-due date — easy to forget, not an error. */
  | 'vaccination-no-next-due';

export interface WarningContext {
  /** Epoch ms the chip was implanted, if this animal is chipped and it is known. */
  microchipImplantedAt?: number | null;
  /** Epoch ms. Null when the shelter does not know — which is usual. */
  birthdateApprox?: number | null;
}

/**
 * Clinical checks that inform without blocking.
 *
 * Every one of these fails toward SILENCE when the input is unknown. A shelter
 * that does not know a birthdate must not be nagged about a rule nobody can
 * evaluate — that is how a warning system trains people to ignore it.
 */
export function medicalWarnings(
  draft: MedicalRecordDraft,
  ctx: WarningContext = {}
): MedicalWarning[] {
  const warnings: MedicalWarning[] = [];
  if (draft.performedAt === null) return warnings;

  const isRabies = draft.kind === 'vaccination' && /rabi/i.test(draft.name);

  if (isRabies) {
    // EU: the chip must be implanted BEFORE the rabies dose, or the
    // vaccination is void. Unknown implant date -> no opinion.
    const implanted = ctx.microchipImplantedAt;
    if (implanted != null && implanted > draft.performedAt) {
      warnings.push('rabies-before-microchip');
    }

    const ageOk = rabiesAgeIsValid(ctx.birthdateApprox ?? null, draft.performedAt);
    if (ageOk === false) warnings.push('rabies-under-age');

    if (draft.validFrom === null) warnings.push('rabies-no-valid-from');
  }

  if (draft.kind === 'vaccination' && draft.nextDueAt === null) {
    warnings.push('vaccination-no-next-due');
  }

  return warnings;
}

/**
 * Was the animal old enough for a rabies dose?
 *
 * ⚠️ THREE-STATE, not a boolean. `null` means "cannot be evaluated" — no
 * birthdate — and is different from `false`, "was too young". Collapsing the
 * two would make an unknown birthdate look like a violation, and most street
 * rescues have no birthdate at all. Same shape as the microchip lookup's
 * three-way verdict, and for the same reason.
 */
export function rabiesAgeIsValid(
  birthdateApprox: number | null,
  vaccinatedAt: number
): boolean | null {
  if (birthdateApprox === null) return null;
  const ageMs = vaccinatedAt - birthdateApprox;
  if (ageMs < 0) return null; // nonsensical; not our question to answer
  return ageMs >= RABIES_MIN_AGE_WEEKS * 7 * DAY_MS;
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived dates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * When rabies protection legally begins: 21 days after the dose.
 *
 * Offered as a DEFAULT the vet can overwrite, never silently imposed. It is a
 * deterministic legal rule rather than a clinical judgement — the same division
 * the food subsystem uses, where a model parses and arithmetic decides.
 */
export function rabiesProtectionStart(performedAt: number): number {
  return performedAt + RABIES_PROTECTION_DELAY_DAYS * DAY_MS;
}

/**
 * Is a booster overdue as of `now`?
 *
 * Tolerant of clock skew in the same direction as everything else here: a
 * record due in the next few minutes is not yet overdue.
 */
export function isOverdue(nextDueAt: number | null, now: number = Date.now()): boolean {
  if (nextDueAt === null) return false;
  return nextDueAt < now - CLOCK_SKEW_TOLERANCE_MS;
}

/**
 * Has declared protection lapsed?
 *
 * ⚠️ Distinct from `isOverdue`. `nextDueAt` is when to come back; `validUntil`
 * is WSAVA's duration of immunity. Core vaccine immunity commonly OUTLASTS the
 * booster interval, and conflating the two is how an animal gets revaccinated
 * needlessly, or travels on cover that quietly expired.
 */
export function protectionLapsed(
  validUntil: number | null,
  now: number = Date.now()
): boolean {
  if (validUntil === null) return false;
  return validUntil < now - CLOCK_SKEW_TOLERANCE_MS;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ordering
// ─────────────────────────────────────────────────────────────────────────────

export interface SortableRecord {
  performedAt: number;
  kind: MedicalRecordKind;
}

/** Most recent first — a vet opening a history wants what happened last. */
export function byMostRecent<T extends SortableRecord>(records: readonly T[]): T[] {
  return [...records].sort((a, b) => b.performedAt - a.performedAt);
}

/**
 * The soonest thing that needs doing, or null.
 *
 * Ignores records with no due date rather than treating them as due now — a
 * consultation has no booster and must not appear in a reminder list.
 */
export function nextDue<T extends { nextDueAt: number | null }>(
  records: readonly T[]
): T | null {
  const due = records.filter((r) => r.nextDueAt !== null);
  if (due.length === 0) return null;
  return due.reduce((soonest, r) => (r.nextDueAt! < soonest.nextDueAt! ? r : soonest));
}
