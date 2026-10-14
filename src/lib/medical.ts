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
import { dayToInstant, isPastDay, localDayNumber } from './date-input';
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
  /** The product name on the vial's label. Not `name` — see `MedicalRecord.product`. */
  product: string | null;
  /** Epoch ms the VIAL expires. Never `validUntil` — see `MedicalRecord.productExpiresAt`. */
  productExpiresAt: number | null;
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
    product: null,
    productExpiresAt: null,
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
 * ⚠️ "In the future" means a LATER CALENDAR DAY, not a later instant, so a vet
 * entering a vaccination given this morning can save it — however the date got
 * into the form, card readings included. The day logic is `dayToInstant` in
 * `date-input.ts`, the same one the food forms use. Clock skew is layered on
 * top: Firestore's clock measured 2.7 s AHEAD of the dev machine on 2026-08-24,
 * and a browser clock drifts by minutes, so `CLOCK_SKEW_TOLERANCE_MS` is added
 * to `now` before the day is compared.
 */
export function validateMedicalDraft(
  draft: MedicalRecordDraft,
  now: number = Date.now()
): MedicalError[] {
  const errors: MedicalError[] = [];

  if (draft.kind === null) errors.push('kind-required');
  if (!draft.name.trim()) errors.push('name-required');

  const tolerantNow = now + CLOCK_SKEW_TOLERANCE_MS;
  if (draft.performedAt === null) {
    errors.push('performed-required');
  } else if (dayToInstant(draft.performedAt, tolerantNow) > tolerantNow) {
    errors.push('performed-in-future');
  }

  // By calendar day: a dose typed for today (local midday) and a next date read
  // off a card for the same day (12:00 UTC, 08:00 in Bolivia) are one day, and
  // comparing the instants refused a save that was perfectly true.
  if (
    draft.performedAt !== null &&
    draft.nextDueAt !== null &&
    localDayNumber(draft.nextDueAt) < localDayNumber(draft.performedAt)
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
  | 'vaccination-no-next-due'
  /** The vial had already expired on the day the dose was given. */
  | 'product-expired-before-dose';

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

  if (productExpiredBeforeDose(draft.productExpiresAt, draft.performedAt)) {
    warnings.push('product-expired-before-dose');
  }

  return warnings;
}

/**
 * Had the vial expired before the day the dose was given?
 *
 * ⚠️ By CALENDAR DAY. A label's "vence 14 oct" means the product is good on
 * the 14th, all day; it is expired from the 15th. Comparing instants would
 * warn about a dose given on the expiry date itself, because a date typed for
 * today is stamped at local midday and a date read from a label at 08:00 in
 * Bolivia — the defect fixed for due dates in PR #76.
 *
 * Any kind, not only vaccinations: a deworming tablet expires too. Unknown
 * either side → no opinion, like every warning here.
 */
export function productExpiredBeforeDose(
  productExpiresAt: number | null,
  performedAt: number | null
): boolean {
  if (productExpiresAt === null || performedAt === null) return false;
  return localDayNumber(productExpiresAt) < localDayNumber(performedAt);
}

/**
 * The warnings a person sees for the record they have open.
 *
 * ⚠️ NONE for a record imported from the paper register. The register is
 * frozen history, and the owner's ruling (2026-10-05) is that nothing may ask
 * anyone to complete it. Opening one of its 94 vaccinations used to say "No
 * pusiste cuándo toca la próxima", which reads as a request to go and find a
 * date that paper never held.
 */
export function formWarnings(
  draft: MedicalRecordDraft,
  ctx: WarningContext,
  record: { imported: boolean } | null
): MedicalWarning[] {
  if (record?.imported) return [];
  return medicalWarnings(draft, ctx);
}

/**
 * Should the form offer to set "protects from" to the dose date + 21 days?
 *
 * Only for a RABIES vaccination someone is entering now. Until 2026-10-14 the
 * button showed on every record whose start date was empty — a deworming, a
 * sterilization, an Octavalente — so one tap stored a rabies rule on a record
 * it has nothing to do with. Never on an imported record, for the reason in
 * `formWarnings`. Still a default a person chooses, never imposed: the 21 days
 * is the EU rule for a FIRST dose, and the form cannot know which this is.
 */
export function offersRabiesProtectionStart(
  draft: MedicalRecordDraft,
  record: { imported: boolean } | null
): boolean {
  if (record?.imported) return false;
  return (
    draft.performedAt !== null &&
    draft.validFrom === null &&
    isRabiesRecord(draft.kind, draft.name)
  );
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
 * ⚠️ By CALENDAR DAY. "Próxima: 14 oct" means the 14th is in time, all day.
 * Until 2026-10-14 this compared instants, and dates are stamped at an hour —
 * local midday when typed, 08:00 Bolivian time when read off a card — so a
 * dose due today read "VENCIDA" from 08:05 or 12:05 the same day. A warning
 * that fires on the due date itself is a warning people learn to ignore.
 *
 * Clock skew is still absorbed: the day is read from `now` minus the
 * tolerance, so a clock a few minutes fast does not end the day early.
 */
export function isOverdue(nextDueAt: number | null, now: number = Date.now()): boolean {
  if (nextDueAt === null) return false;
  return isPastDay(nextDueAt, now - CLOCK_SKEW_TOLERANCE_MS);
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
  // "Protege hasta el 14" covers the 14th; it has lapsed from the 15th.
  return isPastDay(validUntil, now - CLOCK_SKEW_TOLERANCE_MS);
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
 * ⚠️ Knows nothing about today: it returns the soonest date even when that date
 * is past. `summarizeMedicalHistory` hands it only records that are not
 * overdue, and that is the entry point a screen should use.
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

/**
 * Which repeating thing a record is a dose OF, or null when it is not one.
 *
 * Only vaccinations and dewormings repeat under one name. A second
 * "Consulta" is not the follow-up of the first — it may be about something
 * else entirely — so every other kind has no series and its dates stand alone.
 *
 * Rabies collapses to one key through `isRabiesRecord`, because a campaign card
 * says "Antirrábica" where a vet types "Rabia". Every other name is matched as
 * written, folded for accents, case and spacing.
 *
 * ⚠️ Two different words for one product ("Óctuple", "Octavalente") do NOT
 * match, on purpose. No product registry exists to say they are the same, and
 * the two ways of being wrong are not equal: an unmatched pair leaves an old
 * due date showing, which a person can see and act on; a wrong match would hide
 * a due date that was never met.
 */
export function doseSeriesKey(kind: MedicalRecordKind | null, name: string): string | null {
  if (kind !== 'vaccination' && kind !== 'deworming') return null;
  if (isRabiesRecord(kind, name)) return 'vaccination:rabies';
  const folded = name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return folded ? `${kind}:${folded}` : null;
}

/**
 * The records whose dates a LATER dose of the same thing has answered.
 *
 * A due date says "come back on this day". Once the animal did come back, and
 * that dose is on record, the older record's due date and its declared
 * protection are history: they are still shown, and they conclude nothing.
 * Without this, every finished series would leave its first dose reading
 * "VENCIDA" for the rest of the animal's life.
 *
 * Derived from the records, never marked by a person: a link someone has to
 * remember to set is a link that goes unset.
 *
 * "Later" is a strictly later dose DAY. A dose given BEFORE the due date still
 * answers it. Two records on the same day answer neither — compared by local
 * calendar day, because a dose typed for today (local midday) and one read off
 * a card for today (08:00 in Bolivia) are not ordered just by their hours.
 *
 * ⚠️ Applies the review gate itself, on both sides: an unconfirmed reading
 * neither answers a record nor is answered.
 */
export function answeredByLaterDose<T extends Confirmable & SortableRecord & { name: string }>(
  records: readonly T[]
): Set<T> {
  const latest = new Map<string, number>();
  const dosed: Array<{ record: T; key: string; at: number }> = [];
  for (const record of confirmedOnly(records)) {
    const key = doseSeriesKey(record.kind, record.name);
    if (key === null || record.performedAt === null) continue;
    const day = localDayNumber(record.performedAt);
    dosed.push({ record, key, at: day });
    latest.set(key, Math.max(latest.get(key) ?? -Infinity, day));
  }
  return new Set(dosed.filter((d) => d.at < latest.get(d.key)!).map((d) => d.record));
}

export interface RecordSignals {
  /** A booster that is past due. */
  overdue: boolean;
  /** Declared protection that has run out. */
  lapsed: boolean;
  /** A later dose of the same thing is on record, so neither flag applies. */
  answered: boolean;
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
  now: number = Date.now(),
  /**
   * Whether `summarizeMedicalHistory().answered` holds this record. One record
   * cannot know about the others, so the caller passes it in — and a row that
   * omits it would say "VENCIDA" where the summary above it says nothing.
   */
  answered: boolean = false
): RecordSignals {
  if (!isConfirmed(record)) return { overdue: false, lapsed: false, answered: false };
  if (answered) return { overdue: false, lapsed: false, answered: true };
  return {
    overdue: isOverdue(record.nextDueAt, now),
    lapsed: protectionLapsed(record.validUntil, now),
    answered: false,
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
  /**
   * The soonest booster that is NOT already in `overdue`, or null.
   *
   * ⚠️ Until 2026-10-05 this was the soonest due date of any kind, past ones
   * included, so the panel announced "Lo próximo: … el {a date already gone}"
   * above a row that said "VENCIDA". Nothing showed it because no record had a
   * due date. A past date is never "next"; it is in `overdue`.
   */
  nextDue: T | null;
  /** Past-due boosters, longest overdue first. */
  overdue: T[];
  /** Declared protection that has ended, earliest end first. */
  lapsed: T[];
  /**
   * Records a later dose of the same thing has answered — see
   * `answeredByLaterDose`. Never in `nextDue`, `overdue` or `lapsed`. A row
   * passes its membership here to `recordSignals`.
   */
  answered: T[];
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
 * a public "vacunado" line. Its one caller today is the admin `MedicalPanel`;
 * no public module reads `medical` at all. It exists so that every later
 * caller inherits the gate instead of having to remember it.
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

  // ⚠️ "Upcoming" is defined as NOT IN `overdue`, by membership, rather than by
  // a second date comparison. `isOverdue` subtracts the clock-skew tolerance; a
  // fresh `>= now` here would drop a record sitting inside that window from
  // both lists, and the summary would then disagree with the row's own flag.
  // A date a later dose has answered concludes nothing: not next, not overdue,
  // not lapsed. `latestRabies` above is unaffected — the latest dose is by
  // definition the one nothing answered.
  const answered = answeredByLaterDose(counted);
  const standing = counted.filter((r) => !answered.has(r));

  const overdue = standing
    .filter((r) => isOverdue(r.nextDueAt, now))
    .sort((a, b) => a.nextDueAt! - b.nextDueAt!);
  const pastDue = new Set<T>(overdue);

  return {
    awaitingReview: awaitingReview(records).length,
    nextDue: nextDue(standing.filter((r) => !pastDue.has(r))),
    overdue,
    lapsed: standing
      .filter((r) => protectionLapsed(r.validUntil, now))
      .sort((a, b) => a.validUntil! - b.validUntil!),
    answered: counted.filter((r) => answered.has(r)),
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
  /**
   * Required here although optional on `MedicalRecord`: every writer goes
   * through this shape, so one that forgets the field fails to compile.
   */
  product: string | null;
  productExpiresAt: number | null;
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
    product: draft.product?.trim() || null,
    productExpiresAt: draft.productExpiresAt,
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
  /**
   * Optional: a card reading (`MedicalCandidateView`) has no such fields — the
   * card reader is not reworked to produce them — and a record written before
   * 2026-10-14 lacks them. Absent becomes null in the draft.
   */
  product?: string | null;
  productExpiresAt?: number | null;
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
    product: record.product ?? null,
    productExpiresAt: record.productExpiresAt ?? null,
    notes: record.notes,
  };
}
