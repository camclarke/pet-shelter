/**
 * The printable vaccination card: what goes on it, decided in one pure place.
 *
 * ── Why a card at all ───────────────────────────────────────────────────────
 * The shelter's records live in the app. An adopter, a vet and a municipal
 * campaign all still work on paper, so the card prints what the app holds:
 * one sheet, Carta size, that travels with the animal.
 *
 * ── What prints, and what never does ───────────────────────────────────────
 * - ONLY confirmed records. A model's reading nobody has vouched for is not a
 *   medical fact (`review-gate.ts`), and paper leaves the building: there is
 *   no "pendiente" stamp a reader could be trusted to notice.
 * - Vaccinations and dewormings, each in its own table, OLDEST first, the way
 *   a booklet fills up. Consultations, treatments, surgery and serology are
 *   not what a vaccination card is for.
 * - Sterilization as one dated line, from a confirmed sterilization RECORD.
 *   Never from the `sterilized` flag: on a register-imported draft `false`
 *   means "the paper did not say", not "unaltered" (`sterilization.ts`), and a
 *   printed sheet cannot carry that difference.
 * - Stored values only. A missing lot, laboratory or next date is an empty
 *   cell: the imported register is frozen history, and the card must not turn
 *   its gaps into requests to complete them. Nothing here computes a date.
 *
 * ⚠️ No Spanish here. Words belong in `src/i18n`; this module returns the
 * pieces and the view phrases them.
 */
import { isConfirmed } from './review-gate';
import type { MedicalRecordKind, PetSex, Species } from './types';

/**
 * Empty rows printed under each table, with a sticker box, so a vet can keep
 * pasting labels and signing between prints. Owner's decision, 2026-10-14.
 */
export const HEALTH_CARD_BLANK_ROWS = 4;

/** The fields of a medical record the card reads. A `MedicalRecordView` satisfies it. */
export interface HealthCardRecordInput {
  id: string;
  kind: MedicalRecordKind | null;
  name: string;
  performedAt: number | null;
  nextDueAt: number | null;
  veterinarian: string | null;
  clinic: string | null;
  batch: string | null;
  manufacturer: string | null;
  /** The label's product name. Absent on every record written before 2026-10-14. */
  product?: string | null;
  /** Epoch ms the VIAL expires — never the dog's protection. Absent likewise. */
  productExpiresAt?: number | null;
  confirmedBy: string | null;
}

/** One printed row. Every text field is trimmed, and empty means null. */
export interface HealthCardRow {
  id: string;
  performedAt: number;
  name: string | null;
  manufacturer: string | null;
  batch: string | null;
  product: string | null;
  /** Printed as "frasco vence …", never as a date about the dog. */
  productExpiresAt: number | null;
  nextDueAt: number | null;
  veterinarian: string | null;
  clinic: string | null;
}

export interface HealthCardTables {
  vaccinations: HealthCardRow[];
  dewormings: HealthCardRow[];
  /** The earliest confirmed sterilization, or null when none is recorded. */
  sterilizedAt: number | null;
}

function text(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function toRow(record: HealthCardRecordInput & { performedAt: number }): HealthCardRow {
  return {
    id: record.id,
    performedAt: record.performedAt,
    name: text(record.name),
    manufacturer: text(record.manufacturer),
    batch: text(record.batch),
    product: text(record.product),
    productExpiresAt:
      typeof record.productExpiresAt === 'number' && Number.isFinite(record.productExpiresAt)
        ? record.productExpiresAt
        : null,
    nextDueAt: record.nextDueAt,
    veterinarian: text(record.veterinarian),
    clinic: text(record.clinic),
  };
}

/** Oldest first; ties by name, then id, so a reprint never reorders a page. */
function byDate(a: HealthCardRow, b: HealthCardRow): number {
  if (a.performedAt !== b.performedAt) return a.performedAt - b.performedAt;
  const byName = (a.name ?? '').localeCompare(b.name ?? '', 'es');
  return byName !== 0 ? byName : a.id.localeCompare(b.id);
}

/**
 * Split an animal's records into what the card prints.
 *
 * A record with no `performedAt` is left out: a row with no date says nothing
 * a reader can use. `listMedicalRecords` orders by that field, so Firestore has
 * already dropped any such document; this is the same rule, stated here.
 */
export function buildHealthCardTables(records: readonly HealthCardRecordInput[]): HealthCardTables {
  const vaccinations: HealthCardRow[] = [];
  const dewormings: HealthCardRow[] = [];
  let sterilizedAt: number | null = null;

  for (const record of records) {
    if (!isConfirmed(record)) continue;
    const performedAt = record.performedAt;
    if (performedAt === null || !Number.isFinite(performedAt)) continue;

    if (record.kind === 'vaccination') vaccinations.push(toRow({ ...record, performedAt }));
    else if (record.kind === 'deworming') dewormings.push(toRow({ ...record, performedAt }));
    else if (record.kind === 'sterilization') {
      sterilizedAt = sterilizedAt === null ? performedAt : Math.min(sterilizedAt, performedAt);
    }
  }

  return {
    vaccinations: vaccinations.sort(byDate),
    dewormings: dewormings.sort(byDate),
    sterilizedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Who the card is about
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How old the animal is, in the only forms the app can state truthfully.
 *
 * Deliberately NOT `ageMonths`. On a published pet that is the age when it was
 * PUBLISHED, and often an estimate's midpoint; printed months later it would
 * be a wrong fact on paper. What survives being printed is either a birth date
 * someone knew, or the age the register wrote down together with the day it
 * was written.
 */
export type HealthCardAge =
  | { kind: 'born'; at: number }
  | { kind: 'at-intake'; text: string; day: string | null };

export interface HealthCardIdentity {
  name: string;
  species: Species | null;
  sex: PetSex | null;
  breed: string | null;
  color: string | null;
  /** Printed only because the owner decided it (2026-10-14): it is how an owner proves the animal is theirs. */
  microchip: string | null;
  age: HealthCardAge | null;
}

/** The published-pet fields the card reads. */
export interface HealthCardPetInput {
  name: string;
  species: Species;
  sex: PetSex;
  breed: string;
  colorPattern: string | null;
  birthdateMs: number | null;
}

/** The draft fields the card reads. */
export interface HealthCardDraftInput {
  name: string;
  species: Species | null;
  sex: PetSex | null;
  breed: string;
  colorPattern: string;
  hasMicrochip: boolean;
  microchipCode: string;
  register: { nameRaw: string; ageText: string | null; intakeDay: string | null } | null;
}

export function identityFromPet(pet: HealthCardPetInput, microchipCode: string | null): HealthCardIdentity {
  return {
    name: text(pet.name) ?? '',
    species: pet.species,
    sex: pet.sex,
    breed: text(pet.breed),
    color: text(pet.colorPattern),
    microchip: text(microchipCode),
    age: pet.birthdateMs !== null && Number.isFinite(pet.birthdateMs) ? { kind: 'born', at: pet.birthdateMs } : null,
  };
}

/**
 * A draft — every animal still in the shelter today, since none is published.
 *
 * The name falls back to the register's own spelling, as the draft's screen
 * does: on an imported row it is the only name anybody wrote down.
 */
export function identityFromDraft(draft: HealthCardDraftInput): HealthCardIdentity {
  const ageText = text(draft.register?.ageText);
  return {
    name: text(draft.name) ?? text(draft.register?.nameRaw) ?? '',
    species: draft.species,
    sex: draft.sex,
    breed: text(draft.breed),
    color: text(draft.colorPattern),
    microchip: draft.hasMicrochip ? text(draft.microchipCode) : null,
    age: ageText ? { kind: 'at-intake', text: ageText, day: draft.register?.intakeDay ?? null } : null,
  };
}

/** `YYYY-MM-DD` as a day-first date, without passing through a timezone. */
export function formatIsoDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : day;
}
