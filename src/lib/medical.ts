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
import { isDateAfterToday } from './date-input';
import { CLOCK_SKEW_TOLERANCE_MS } from './placements';
import { awaitingReview, confirmedOnly, isConfirmed, type Confirmable } from './review-gate';

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
 * ⚠️ Compares CALENDAR DAYS, not instants — see `isDateAfterToday` in
 * `date-input.ts`. `parseDateInput` stamps a picked date at local noon, so an
 * instant comparison told a vet entering "today" it hadn't arrived yet for
 * every save made before local noon. Clock skew is layered on top of that:
 * Firestore's clock measured 2.7 s AHEAD of the dev machine on 2026-08-24, and
 * a browser clock drifts by minutes, so `CLOCK_SKEW_TOLERANCE_MS` is added
 * before the day comparison too.
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
  } else if (isDateAfterToday(draft.performedAt, now, CLOCK_SKEW_TOLERANCE_MS)) {
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

  const isRabies = isRabiesRecord(draft.kind, draft.name);

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
  /** Null only on an unconfirmed candidate whose date was not read. */
  performedAt: number | null;
  kind: MedicalRecordKind | null;
}

/**
 * Most recent first — a vet opening a history wants what happened last.
 *
 * A record with no date sorts LAST, which is where a descending Firestore
 * `orderBy` puts a null too, so the list does not reshuffle between the query
 * and this sort.
 */
export function byMostRecent<T extends SortableRecord>(records: readonly T[]): T[] {
  return [...records].sort((a, b) => {
    if (a.performedAt === null && b.performedAt === null) return 0;
    if (a.performedAt === null) return 1;
    if (b.performedAt === null) return -1;
    return b.performedAt - a.performedAt;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// What counts, and what is computed from it — plan §4.8
//
// ⚠️ Every function in this section applies the review gate ITSELF. An
// unconfirmed record — a model's reading of a card nobody has checked yet —
// counts for nothing here, however it reaches these functions. A gate every
// caller must remember is a gate that gets forgotten. See `review-gate.ts`.
//
// `medicalWarnings` above is deliberately not in this section: it reads ONE
// draft, the one a person has open in the form, and no other record. Showing
// its warnings while someone reviews a candidate is information for their
// decision, not a conclusion drawn from unchecked data.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is this a rabies vaccination? Matched on the name as the vet or the card
 * wrote it — "Rabia", "Antirrábica", "RABISIN" — because no vaccine product
 * registry exists to look it up in (standards doc §5).
 *
 * ⚠️ Accents are folded first. Until 2026-09-12 this was `/rabi/i` on the raw
 * name, which does not match "Antirrábica": the "á" breaks it. That is the
 * word a Bolivian campaign card prints, and card extraction transcribes it
 * verbatim, so the rabies warnings would have gone silent on the common case.
 */
export function isRabiesRecord(kind: MedicalRecordKind | null, name: string): boolean {
  if (kind !== 'vaccination') return false;
  const folded = name.normalize('NFD').replace(/\p{Diacritic}/gu, '');
  return /rabi/i.test(folded);
}

/**
 * The soonest thing that needs doing, or null.
 *
 * Ignores records with no due date rather than treating them as due now — a
 * consultation has no booster and must not appear in a reminder list.
 *
 * ⚠️ Ignores UNCONFIRMED records, here rather than at the call site. A model
 * that misread "2026" as "2025" would otherwise put a booster nobody has
 * checked against the card at the top of a reminder list.
 */
export function nextDue<T extends Confirmable & { nextDueAt: number | null }>(
  records: readonly T[]
): T | null {
  const due = confirmedOnly(records).filter((r) => r.nextDueAt !== null);
  if (due.length === 0) return null;
  return due.reduce((soonest, r) => (r.nextDueAt! < soonest.nextDueAt! ? r : soonest));
}

export interface RecordSignals {
  /** A booster that is past due. */
  overdue: boolean;
  /** Declared protection that has run out. */
  lapsed: boolean;
}

/**
 * The flags ONE record's row may show — "VENCIDA", "la protección venció".
 *
 * ⚠️ Both are false for an unconfirmed record, whatever its dates say. A row
 * reading "VENCIDA" is a clinical conclusion, and a conclusion drawn from a
 * date nobody has checked is the thing the gate exists to stop. The row still
 * SHOWS the dates; it just does not draw conclusions from them.
 */
export function recordSignals(
  record: Confirmable & { nextDueAt: number | null; validUntil: number | null },
  now: number = Date.now()
): RecordSignals {
  if (!isConfirmed(record)) return { overdue: false, lapsed: false };
  return {
    overdue: isOverdue(record.nextDueAt, now),
    lapsed: protectionLapsed(record.validUntil, now),
  };
}

export interface SummarizableRecord extends Confirmable, SortableRecord {
  name: string;
  nextDueAt: number | null;
  validUntil: number | null;
}

export interface MedicalSummary<T> {
  /** How many records a person still has to confirm. Shown, never computed from. */
  awaitingReview: number;
  nextDue: T | null;
  overdue: T[];
  lapsed: T[];
  /**
   * The most recent CONFIRMED rabies dose. The one input any future rabies
   * validity, travel or "vacunado" signal must be computed from — never from
   * the raw list.
   */
  latestRabies: T | null;
}

/**
 * Everything computed across one animal's history, from confirmed records only.
 *
 * This is the sanctioned entry point for any aggregate — a reminder, a badge,
 * a public "vacunado" line. Nothing computes one today (checked 2026-09-12:
 * no public module reads `medical` at all), which is exactly why it exists
 * now: the first caller inherits the gate instead of having to remember it.
 */
export function summarizeMedicalHistory<T extends SummarizableRecord>(
  records: readonly T[],
  now: number = Date.now()
): MedicalSummary<T> {
  const counted = confirmedOnly(records);

  let latestRabies: T | null = null;
  for (const record of counted) {
    if (record.performedAt === null || !isRabiesRecord(record.kind, record.name)) continue;
    if (latestRabies === null || record.performedAt > latestRabies.performedAt!) {
      latestRabies = record;
    }
  }

  return {
    awaitingReview: awaitingReview(records).length,
    nextDue: nextDue(counted),
    overdue: counted.filter((r) => isOverdue(r.nextDueAt, now)),
    lapsed: counted.filter((r) => protectionLapsed(r.validUntil, now)),
    latestRabies,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Editing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fields that record WHERE a record came from and WHO vouched for it. An edit
 * must never write any of them except through an explicit confirmation stamp.
 */
export const MEDICAL_PROVENANCE_FIELDS = [
  'source',
  'confirmedBy',
  'confirmedAt',
  'sourceDocument',
  'extractedByModel',
  'extractedAt',
  'extractedFrom',
  'extractionEvidence',
  'recordedBy',
  'codes',
] as const;

export interface MedicalEditFields {
  kind: MedicalRecordKind;
  name: string;
  performedAt: number;
  nextDueAt: number | null;
  validFrom: number | null;
  validUntil: number | null;
  veterinarian: string | null;
  clinic: string | null;
  batch: string | null;
  manufacturer: string | null;
  notes: string | null;
}

/**
 * The fields a person may EDIT, from a validated draft — and nothing else.
 *
 * ⚠️ Provenance is absent BY CONSTRUCTION. Until 2026-09-12 the update path
 * wrote the same object as a create, including `source: 'manual'`,
 * `sourceDocument: null` and `extractedByModel: null`. So correcting a
 * model-extracted record before confirming it would have silently relabelled
 * it as typed by hand and discarded the card it was read from. Nothing noticed
 * because no extracted record had ever existed to be edited.
 */
export function medicalEditFields(draft: MedicalRecordDraft): MedicalEditFields {
  if (draft.kind === null || draft.performedAt === null) {
    // Callers validate first; this is the type-level backstop.
    throw new Error('medical: draft is incomplete');
  }
  return {
    kind: draft.kind,
    name: draft.name.trim(),
    performedAt: draft.performedAt,
    nextDueAt: draft.nextDueAt,
    validFrom: draft.validFrom,
    validUntil: draft.validUntil,
    // ⚠️ Null here is NOT an incomplete record. Bolivia's free rabies campaign
    // produces real vaccinations with no named vet and no lot number.
    veterinarian: draft.veterinarian?.trim() || null,
    clinic: draft.clinic?.trim() || null,
    batch: draft.batch?.trim() || null,
    manufacturer: draft.manufacturer?.trim() || null,
    notes: draft.notes?.trim() || null,
  };
}

/** The stored fields a form draft is rebuilt from. */
export interface DraftableRecord {
  kind: MedicalRecordKind | null;
  name: string;
  performedAt: number | null;
  nextDueAt: number | null;
  validFrom: number | null;
  validUntil: number | null;
  veterinarian: string | null;
  clinic: string | null;
  batch: string | null;
  manufacturer: string | null;
  notes: string | null;
}

/**
 * A stored record back into a form draft — to edit it, and to decide whether
 * it can be confirmed as it stands: `canConfirmAsIs(validateMedicalDraft(
 * draftFromRecord(record)))`. A candidate whose date or kind was withheld
 * fails that, and goes through the edit path instead.
 */
export function draftFromRecord(record: DraftableRecord): MedicalRecordDraft {
  return {
    kind: record.kind,
    name: record.name,
    performedAt: record.performedAt,
    nextDueAt: record.nextDueAt,
    validFrom: record.validFrom,
    validUntil: record.validUntil,
    veterinarian: record.veterinarian,
    clinic: record.clinic,
    batch: record.batch,
    manufacturer: record.manufacturer,
    notes: record.notes,
  };
}
