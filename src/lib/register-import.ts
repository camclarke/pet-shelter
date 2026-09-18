/**
 * The shelter's paper register → Firestore, as a PLAN. Pure functions only.
 *
 * No Firestore import, no `server-only`, no Node built-ins: same split as
 * `areas.ts` / `areas-admin.ts` and `intake.ts` / `pets-admin.ts`, and for the
 * same reason. Everything here is decidable from its arguments, so the whole
 * import can be tested with `node --test` — without a database, a network, or
 * an admin credential. A separate script does the writing; this module only
 * says what should be written.
 *
 * ═══ WHY A PLAN AND NOT AN IMPORTER ═════════════════════════════════════════
 * 225 rows of a handwritten register are being transcribed into a live
 * shelter's database, and 43 of those animals will have photographs attached to
 * them later. An import that streams straight into Firestore can only be
 * reviewed by watching it run, and its mistakes are discovered as documents.
 * A plan is a value: it can be counted, diffed, printed, and refused. The
 * script's job is to refuse it when `blockers` is non-empty and otherwise write
 * exactly what it was handed.
 *
 * ═══ THE THREE THINGS THIS MODULE WILL NOT DO ═══════════════════════════════
 *  1. **It never invents a date.** A cell nobody can read stays unimported,
 *     with its raw text preserved as a Spanish note on the draft. There is no
 *     approximate-date field on `MedicalRecord`, and picking a day so that a
 *     year-only sterilization "fits" would turn a shrug into a fact that later
 *     drives a booster reminder.
 *  2. **It never guesses a species, a colour or an age for a resident.** Those
 *     fields are left EMPTY on the draft precisely so the photo session can
 *     fill them: the intake wizard's AI prefill offers a value into an empty
 *     field and must not overwrite one, so an empty field is the only kind the
 *     camera can still improve.
 *  3. **It never reads the adopter column.** See `readResponsible` below.
 *
 * ═══ SPANISH IN A PURE MODULE ═══════════════════════════════════════════════
 * ⚠️ This file contains Spanish strings, which `areas.ts` and `medical.ts`
 * deliberately do not. The difference is that those modules return error
 * *codes* that `src/i18n` words, whereas the strings here are CONTENT: stored
 * free text that a volunteer reads and edits inside the record itself, exactly
 * like `RegisterEntry.statusWhy`. Wording a stored note through the i18n layer
 * would mean the note changes when the site's language does, which is the
 * opposite of what a transcription of a paper document should do.
 */

import { draftDefaults, slugify, type PetDraft, type RegisterRef } from './intake';
import { validateMedicalDraft, type MedicalRecordDraft } from './medical';
import type {
  ImportRef,
  MedicalRecord,
  MedicalRecordKind,
  PetSex,
  RegisterEntry,
  RegisterStatus,
  Species,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Time
// ─────────────────────────────────────────────────────────────────────────────

/** Bolivia is UTC−4 all year. There is no daylight saving to reason about. */
export const BOLIVIA_UTC_OFFSET_HOURS = 4;

/**
 * A `YYYY-MM-DD` register day as the instant of LOCAL NOON IN BOLIVIA, computed
 * from UTC arithmetic alone.
 *
 * ⚠️ Deliberately NOT `parseDateInput`/`dayToInstant` from `date-input.ts`,
 * which the forms use. Those read the RUNTIME's timezone on purpose — they
 * convert what a person just picked in a browser. This function converts what a
 * pen wrote on paper in Cochabamba years ago, and that instant cannot depend on
 * where the import happens to run: CI runs in UTC, this machine does not, and
 * the same register row must produce the same stored millisecond on both. Noon
 * rather than midnight leaves ~12 hours of slack in either direction, so no
 * reader's timezone can pull the date onto the neighbouring day.
 *
 * Returns null for anything that is not a real calendar day — a year on its
 * own, or "31/04/26", which this register actually contains. `Date.UTC` rolls
 * an impossible day forward silently, so the result is read back and compared.
 */
export function boliviaNoonMs(day: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const dayOfMonth = Number(match[3]);

  const ms = Date.UTC(year, month - 1, dayOfMonth, 12 + BOLIVIA_UTC_OFFSET_HOURS, 0, 0);

  // 2026-04-31 becomes 2026-05-01 rather than throwing. Reading the parts back
  // is the only way to tell a real day from one the calendar rolled over.
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== dayOfMonth
  ) {
    return null;
  }
  return ms;
}

// ─────────────────────────────────────────────────────────────────────────────
// The plan
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A `registerEntries/{no}` document, minus the two fields only a server can
 * stamp, with every Timestamp replaced by epoch milliseconds.
 *
 * Derived from `RegisterEntry` with `Omit` rather than retyped, so that adding
 * a field to the stored shape is a COMPILE ERROR here instead of a field the
 * import silently stops writing. The 2026-08-26 lesson: `batch.set(petRef, {…})`
 * took an untyped object literal, so a new required field on `Pet` produced a
 * green typecheck and a document without it.
 */
export type RegisterEntryPlan = Omit<
  RegisterEntry,
  'importedAt' | 'updatedAt' | 'intakeDate' | 'statusDate' | 'lastRecordedDate'
> & {
  intakeDateMs: number | null;
  statusDateMs: number | null;
  lastRecordedDateMs: number | null;
};

/**
 * A `petDrafts/{id}` document.
 *
 * An alias rather than a bare `PetDraft` so the script has a name to write
 * against, and so this stays the seam if a draft ever gains a Timestamp-shaped
 * field. `PetDraft` is plain serialisable values today — that is a documented
 * property of it, not an accident.
 */
export type PetDraftPlan = PetDraft;

/**
 * A `pets/{petId}/medical/{id}` document.
 *
 * Omits exactly the four fields the SCRIPT owns: the document id, and the
 * three that say who confirmed and recorded it. Everything else is stated here
 * — including the nulls — because a field the planner leaves out is a field the
 * script gets to guess, and guessing is how `extractedByModel` ends up claiming
 * a model read a paper register that a person read.
 */
export type MedicalImportPlan = Omit<
  MedicalRecord,
  | 'id'
  | 'confirmedBy'
  | 'confirmedAt'
  | 'recordedBy'
  | 'performedAt'
  | 'nextDueAt'
  | 'validFrom'
  | 'validUntil'
  | 'extractedAt'
  | 'importRef'
> & {
  performedAtMs: number;
  nextDueAtMs: null;
  validFromMs: null;
  validUntilMs: null;
  extractedAtMs: null;
  /** Required here, unlike on the stored record: every imported record has one. */
  importRef: ImportRef;
};

export interface PlannedEntry {
  id: string;
  no: number;
  data: RegisterEntryPlan;
}

export interface PlannedDraft {
  id: string;
  no: number;
  data: PetDraftPlan;
}

export interface PlannedMedical {
  petId: string;
  id: string;
  no: number;
  data: MedicalImportPlan;
}

/** One thing the register said that the import deliberately did not write. */
export interface SkippedItem {
  no: number;
  /** What it was, in Spanish, e.g. "desparasitación". */
  what: string;
  /** Why it was not imported, in Spanish. */
  why: string;
  /** The cell verbatim. Nothing the register wrote is ever lost. */
  raw: string;
}

export interface ImportPlan {
  batch: string;
  entries: PlannedEntry[];
  drafts: PlannedDraft[];
  medical: PlannedMedical[];
  skipped: SkippedItem[];
  /** Non-empty means the import must NOT run. */
  blockers: { no: number | null; why: string }[];
  stats: {
    entries: number;
    byStatus: Record<string, number>;
    drafts: number;
    medical: number;
    skipped: number;
  };
}

export interface ImportPlanInput {
  /** Parsed `registro-225-rows.json`. */
  rows: unknown;
  /** Parsed `registro-225-normalizado.json`. */
  normalized: unknown;
  /** Parsed `medico-43-actuales.json`. */
  medical: unknown;
  /** The rollback key, e.g. "registro-2026-09-18". */
  batch: string;
  /** `YYYY-MM-DD`. The cut-off a "future" date is judged against. */
  today: string;
  /**
   * Minted ids, injected so the planner stays pure and so two runs can be
   * compared. The draft id becomes the petId on publish, which is what lets
   * the photo session upload straight to `pets/{petId}/…`.
   */
  draftIdFor: (registerNo: number) => string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The PII tripwire
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A Bolivian mobile number, tolerating the separators a transcription leaves
 * behind: `77903553`, `+591 7790 3553`, `591-6-123-4567`.
 *
 * Mobiles here are eight digits beginning 6 or 7, optionally behind the country
 * code. Landlines are four digits and are not matched, deliberately: a
 * four-digit run is indistinguishable from a year, and a tripwire that fires on
 * "2018" is a tripwire somebody switches off.
 */
const BOLIVIAN_MOBILE = /(?:\+?\s*591[\s-]*)?[67](?:[\s-]*\d){7}/;

/**
 * A decimal coordinate: a negative number with four or more decimal places.
 *
 * Four decimals of a degree is about eleven metres, which is the precision that
 * identifies a house rather than a neighbourhood — concern #2 in the project
 * log, arriving through a spreadsheet instead of through the location field.
 * Broad on purpose: nothing legitimate in this register looks like this, which
 * was MEASURED across all 225 rows before the pattern was chosen.
 */
const DECIMAL_COORDINATE = /-\d{1,3}\.\d{4,}/;

/**
 * Does this string look like somebody's phone number or somebody's front door?
 *
 * Exported so the writing script can re-check whatever it adds on top of the
 * plan. A tripwire that only guards one layer guards nothing.
 */
export function looksLikePersonalContact(value: string): boolean {
  return BOLIVIAN_MOBILE.test(value) || DECIMAL_COORDINATE.test(value);
}

/**
 * Walk every string the plan would write and BLOCK on a match.
 *
 * ⚠️ Blocks rather than redacts, and that is the whole point. A silent scrub
 * produces a clean-looking import and tells nobody that the extraction is
 * leaking a column it was supposed to leave alone — so the leak survives into
 * the next batch, and the one after. A blocker stops the run and names the
 * field, which is a bug report.
 *
 * Runs over the OUTPUT rather than the input, because the output is what
 * reaches Firestore. A reader that promises never to touch `adopterColumn` is
 * a promise; this is the check.
 */
function scanForPersonalData(
  value: unknown,
  path: string,
  no: number | null,
  blockers: { no: number | null; why: string }[]
): void {
  if (typeof value === 'string') {
    if (looksLikePersonalContact(value)) {
      blockers.push({
        no,
        why: `${path} looks like personal contact data and was not imported: ${JSON.stringify(value.slice(0, 80))}`,
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => scanForPersonalData(item, `${path}[${i}]`, no, blockers));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      scanForPersonalData(item, `${path}.${key}`, no, blockers);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the extractor's JSON
//
// The three input files are produced outside this repository and typed as
// `unknown` on the way in. These readers coerce; a required field that is
// missing or the wrong type becomes a blocker rather than an `undefined` that
// travels into a document.
// ─────────────────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

/** `"dog" | "cat" | …` as a `Species`, or null. */
function readSpecies(value: unknown): Species | null {
  // ⚠️ "unknown" is a real value in the normalized file and becomes NULL here,
  // never a guess. 33 of the 225 rows carry it — mostly rows with no vaccine
  // column to infer a species from — and a dog written down as a dog because
  // the importer had to choose something is a fiction that reaches a public
  // page the moment that animal is published.
  return value === 'dog' || value === 'cat' || value === 'rabbit' || value === 'other'
    ? value
    : null;
}

function readSex(value: unknown): PetSex | null {
  return value === 'male' || value === 'female' ? value : null;
}

const REGISTER_STATUSES: readonly RegisterStatus[] = [
  'in-shelter',
  'adopted',
  'returned',
  'died',
  'transferred',
  'unknown',
];

function readStatus(value: unknown): RegisterStatus | null {
  return REGISTER_STATUSES.includes(value as RegisterStatus) ? (value as RegisterStatus) : null;
}

/**
 * The rescuer or group responsible, from the ROWS file.
 *
 * ⚠️ THIS FUNCTION IS THE ONLY PLACE THE ROWS FILE'S `cells` IS READ, AND IT
 * NAMES THE ONE KEY IT WANTS. `cells.adopterColumn` holds a third party's
 * personal data — the adopter's details, already redacted upstream — and it
 * must never enter a document, a note, or a log line. Reading the cells object
 * by iteration, or spreading it, would import that column the first time
 * somebody adds a field. So: one named key, no loop, no spread.
 *
 * Any remaining run of six or more digits is stripped, because a rescuer's
 * name is sometimes written down with their phone number beside it, and the
 * name is the useful half. `looksLikePersonalContact` then re-checks what is
 * left, over the whole plan, so this stripping is the first line and not the
 * only one.
 */
function readResponsible(cells: Record<string, unknown>): string | null {
  const raw = readString(cells['responsible']);
  if (raw === null) return null;

  const stripped = raw
    .replace(/\+?\s*591[\s-]*/g, ' ')
    .replace(/\d(?:[\s-]*\d){5,}/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return stripped === '' ? null : stripped;
}

// ─────────────────────────────────────────────────────────────────────────────
// Medical events
// ─────────────────────────────────────────────────────────────────────────────

/** What the medical file calls an event type. */
type RegisterEventType = 'octavalent' | 'deworming' | 'rabies' | 'sterilization' | 'other';

interface RegisterEvent {
  type: RegisterEventType;
  column: string;
  /** `YYYY-MM-DD`, or `YYYY`, or null. */
  date: string | null;
  precision: 'day' | 'month' | 'year' | 'none';
  raw: string;
  source: ImportRef['sheet'];
  status: string;
  note: string | null;
}

/**
 * What each register column becomes, and what the record is called.
 *
 * The names are the words the shelter uses, not translations of the column
 * headers: a volunteer looking at the medical panel should see "Octavalente"
 * because that is what is written on the vial and on the paper.
 *
 * `other` is absent on purpose and is never imported — see `EXIT_EVENT_REASON`.
 *
 * Exported so a test can push every mapping through `validateMedicalDraft`.
 * The blocker branch that validator feeds is unreachable with today's mapping,
 * and asserting the COUPLING is honest where claiming coverage would not be:
 * add a column here with an empty name and the form's own validator refuses it.
 */
export const EVENT_MAPPING: Record<
  Exclude<RegisterEventType, 'other'>,
  { kind: MedicalRecordKind; name: string }
> = {
  octavalent: { kind: 'vaccination', name: 'Octavalente' },
  rabies: { kind: 'vaccination', name: 'Antirrábica' },
  deworming: { kind: 'deworming', name: 'Desparasitación' },
  sterilization: { kind: 'sterilization', name: 'Esterilización' },
};

/** The Spanish word for each event type, for the notes a volunteer reads. */
const EVENT_LABEL_ES: Record<RegisterEventType, string> = {
  octavalent: 'octavalente',
  rabies: 'antirrábica',
  deworming: 'desparasitación',
  sterilization: 'esterilización',
  other: 'otra anotación',
};

/**
 * ⚠️ An `other` event is never a treatment. In this register the column is
 * where a death or an exit was noted, so importing it as a medical record
 * would put "murió" into a vaccination history — and, worse, would make a
 * record exist for an event whose date is the date the animal LEFT.
 */
const EXIT_EVENT_REASON =
  'no es un tratamiento: el registro anota una salida o un fallecimiento';

function readEvent(value: unknown): RegisterEvent | null {
  const record = asRecord(value);
  if (!record) return null;

  const type = record['type'];
  if (
    type !== 'octavalent' &&
    type !== 'deworming' &&
    type !== 'rabies' &&
    type !== 'sterilization' &&
    type !== 'other'
  ) {
    return null;
  }

  const precision = record['precision'];
  const source = record['source'];

  return {
    type,
    column: readString(record['column']) ?? type,
    date: typeof record['date'] === 'string' ? record['date'] : null,
    precision:
      precision === 'day' || precision === 'month' || precision === 'year' ? precision : 'none',
    raw: readString(record['raw']) ?? '',
    source: source === 'pdf' || source === 'both' ? source : 'xlsx',
    status: readString(record['status']) ?? 'needs-human',
    note: readString(record['note']),
  };
}

/**
 * Every reason this event cannot become a record, in the order a person would
 * say them. Empty means it can.
 *
 * Composite on purpose: the deworming on row 2 is BOTH dated in the future and
 * unconfirmed, and a note that mentions only one of those sends whoever chases
 * it looking for the wrong thing. The register's most common failure is a date
 * that is wrong in two ways at once.
 */
function skipReasons(event: RegisterEvent, performedAtMs: number | null, todayMs: number): string[] {
  const reasons: string[] = [];

  if (event.type === 'other') {
    reasons.push(EXIT_EVENT_REASON);
    return reasons;
  }

  if (event.precision !== 'day') {
    reasons.push('sin fecha exacta');
  } else if (performedAtMs === null) {
    reasons.push('fecha imposible en el calendario');
  } else if (performedAtMs > todayMs) {
    reasons.push('fecha futura');
  }

  if (event.status !== 'confirmed') {
    reasons.push('sin confirmar con el refugio');
  }

  return reasons;
}

/**
 * One Spanish line for a note that was not imported, naming the row, the
 * column, the cell verbatim and the reason.
 *
 * ⚠️ The raw text is the load-bearing part. A skipped event is not a discarded
 * event: the paper still says it happened, and the only way the shelter can
 * ever resolve "02/12/26" is by being shown "02/12/26" beside the animal it
 * was written against. A note that said only "se omitió una desparasitación"
 * would destroy the very thing a human needs to fix it.
 */
function skipNote(no: number, event: RegisterEvent, reasons: string[]): string {
  return `Registro n.º ${no}, ${EVENT_LABEL_ES[event.type]} «${event.raw}»: ${reasons.join(', ')}.`;
}

/**
 * The line for a sterilization the register dates only by year, or not at all.
 *
 * `sterilized` is still set on the draft, because "this animal is sterilized"
 * is a fact the register does assert — it is only the DAY that is missing, and
 * `MedicalRecord.performedAt` is not nullable. Inventing a day so the record
 * can exist would put a fabricated date into a medical history and, through
 * `nextDueAt` arithmetic later, into a reminder.
 */
function approximateSterilizationNote(no: number, event: RegisterEvent): string {
  const year = event.precision === 'year' && event.date ? event.date.slice(0, 4) : null;
  const reason = year
    ? `en ${year}, según el registro, sin fecha exacta`
    : 'según el registro, sin fecha exacta';
  return skipNote(no, event, [reason]);
}

/**
 * `reg{no}-{column}-{YYYYMMDD}`, with `-2`, `-3` on a collision within the same
 * animal.
 *
 * Deterministic rather than random so that running the planner twice produces
 * the same ids — which is what makes the import re-runnable and what lets
 * `--delete` find exactly what one batch wrote. The collision suffix is scoped
 * to one animal because that is the only scope where a clash is possible: the
 * register genuinely records two dewormings on the same day for the same dog
 * (a repeat dose written twice), and two different animals cannot share an id
 * because `no` is in it.
 */
function medicalRecordId(no: number, column: string, day: string, taken: Set<string>): string {
  const base = `reg${no}-${column}-${day.replace(/-/g, '')}`;
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  const id = `${base}-${suffix}`;
  taken.add(id);
  return id;
}

// ─────────────────────────────────────────────────────────────────────────────
// The planner
// ─────────────────────────────────────────────────────────────────────────────

export function buildImportPlan(input: ImportPlanInput): ImportPlan {
  const { batch, today, draftIdFor } = input;

  const entries: PlannedEntry[] = [];
  const drafts: PlannedDraft[] = [];
  const medical: PlannedMedical[] = [];
  const skipped: SkippedItem[] = [];
  const blockers: { no: number | null; why: string }[] = [];

  const empty = (): ImportPlan => ({
    batch,
    entries,
    drafts,
    medical,
    skipped,
    blockers,
    stats: { entries: 0, byStatus: {}, drafts: 0, medical: 0, skipped: 0 },
  });

  // ── Preconditions ─────────────────────────────────────────────────────────

  if (readString(batch) === null) {
    blockers.push({ no: null, why: 'batch is required: it is the rollback key' });
  }

  const todayMs = boliviaNoonMs(today);
  if (todayMs === null) {
    blockers.push({ no: null, why: `today must be YYYY-MM-DD, got ${JSON.stringify(today)}` });
    return empty();
  }

  if (!Array.isArray(input.normalized)) {
    blockers.push({ no: null, why: 'normalized must be an array of register rows' });
    return empty();
  }
  if (!Array.isArray(input.rows)) {
    blockers.push({ no: null, why: 'rows must be an array of register rows' });
    return empty();
  }

  // The medical file is an object with an `animals` array, unlike the other
  // two. Accepting a bare array as well costs one line and means a caller that
  // hands over `medical.animals` gets the plan it expected rather than an
  // import silently missing every medical record.
  const medicalRecord = asRecord(input.medical);
  const medicalAnimals = Array.isArray(input.medical)
    ? input.medical
    : medicalRecord && Array.isArray(medicalRecord['animals'])
      ? (medicalRecord['animals'] as unknown[])
      : null;
  if (medicalAnimals === null) {
    blockers.push({ no: null, why: 'medical must be { animals: [...] } or an array' });
    return empty();
  }

  // ── Index the two side files by register number ───────────────────────────

  const cellsByNo = new Map<number, Record<string, unknown>>();
  for (const row of input.rows) {
    const record = asRecord(row);
    const no = record ? readNumber(record['no']) : null;
    if (no === null || !record) continue;
    const cells = asRecord(record['cells']);
    if (cells) cellsByNo.set(no, cells);
  }

  const eventsByNo = new Map<number, RegisterEvent[]>();
  for (const animal of medicalAnimals) {
    const record = asRecord(animal);
    const no = record ? readNumber(record['no']) : null;
    if (no === null || !record) continue;
    const rawEvents = Array.isArray(record['events']) ? record['events'] : [];
    const parsed: RegisterEvent[] = [];
    for (const raw of rawEvents) {
      const event = readEvent(raw);
      if (event === null) {
        blockers.push({ no, why: 'an event in the medical file could not be read' });
        continue;
      }
      parsed.push(event);
    }
    eventsByNo.set(no, parsed);
  }

  // ── Row by row ────────────────────────────────────────────────────────────

  const seenNumbers = new Set<number>();
  const byStatus: Record<string, number> = {};

  for (const rawRow of input.normalized) {
    const row = asRecord(rawRow);
    if (!row) {
      blockers.push({ no: null, why: 'a normalized row was not an object' });
      continue;
    }

    const no = readNumber(row['no']);
    if (no === null) {
      blockers.push({ no: null, why: 'a normalized row has no register number' });
      continue;
    }
    if (seenNumbers.has(no)) {
      // Two rows claiming one number would silently overwrite each other:
      // `no` is the document id.
      blockers.push({ no, why: 'register number appears twice in the normalized file' });
      continue;
    }
    seenNumbers.add(no);

    const status = readStatus(row['status']);
    if (status === null) {
      blockers.push({ no, why: `unrecognised status ${JSON.stringify(row['status'])}` });
      continue;
    }

    const descriptors = asRecord(row['descriptors']) ?? {};
    const ageAtIntake = asRecord(row['ageAtIntake']) ?? {};
    const litterRecord = asRecord(row['litter']);
    const cells = cellsByNo.get(no) ?? {};

    // Colour and coat words the REGISTER wrote, joined into one note. The
    // medical file also carries a `colourNote`, and it is deliberately not used
    // here: that field holds a long English adjudication of a struck-through
    // word, which is an audit trail rather than a description of an animal.
    const colourWords = [
      ...readStringArray(descriptors['colour']),
      ...readStringArray(descriptors['coat']),
    ];

    const entry: RegisterEntryPlan = {
      no,
      name: readString(row['displayName']) ?? '',
      nameRaw: readString(row['nameRaw']) ?? '',
      hasRealName: readBoolean(row['hasRealName']),
      aliases: readStringArray(row['aliasesInCell']),

      species: readSpecies(row['species']),
      speciesWhy: readString(row['speciesEvidence']),
      sex: readSex(row['sex']),

      intakeDateMs: boliviaNoonMs(readString(row['intakeDate']) ?? ''),
      intakeRaw: readString(row['intakeRaw']) ?? '',
      ageAtIntakeRaw: readString(ageAtIntake['raw']),
      ageAtIntakeMinMonths: readNumber(ageAtIntake['minMonths']),
      ageAtIntakeMaxMonths: readNumber(ageAtIntake['maxMonths']),

      status,
      statusWhy: readString(row['statusWhy']) ?? '',
      statusDateMs: boliviaNoonMs(readString(row['statusDate']) ?? ''),
      // ⚠️ Always false, for every row, with no way to pass true. Every status
      // in this import comes from a FILL COLOUR in a spreadsheet, which records
      // what somebody meant to write down, not a headcount. A roster that shows
      // these as facts is how a photograph gets attached to an animal that left
      // months ago — which is the one failure this whole import exists to avoid.
      statusConfirmed: false,

      sterilizedPerRegister: readBoolean(row['sterilizedPerRegister']),
      lastRecordedDateMs: boliviaNoonMs(readString(row['lastRecordedDate']) ?? ''),

      colourNote: colourWords.length > 0 ? colourWords.join(', ') : null,
      breedWords: readStringArray(descriptors['breedWords']),

      responsible: readResponsible(cells),

      litter: litterRecord
        ? {
            tag: readString(litterRecord['tag']),
            index: readNumber(litterRecord['index']),
            mother: readString(litterRecord['mother']),
          }
        : null,

      // Filled in below for the rows that get a draft. It has to be: the
      // roster reads `entry.petId` to decide whether to OPEN this animal's
      // record or MINT A NEW ONE, so a row left null here would send the
      // volunteer into a second draft while the imported medical history sat
      // under the first — the exact duplicate this whole design exists to
      // prevent. Measured on the canary import, which is what a canary is for.
      //
      // `linkConfidence` is where the doubt belongs, and it stays
      // `provisional` until a person standing in front of the animal says the
      // row and the dog are the same.
      petId: null,
      linkConfidence: null,

      flags: readStringArray(row['flags']),
      importBatch: batch,
    };

    entries.push({ id: String(no), no, data: entry });
    byStatus[status] = (byStatus[status] ?? 0) + 1;

    // ── Drafts: residents only ──────────────────────────────────────────────
    //
    // Only `in-shelter` gets a draft, because a draft is a slot waiting for a
    // photograph and only these 43 animals will be photographed. Creating one
    // for an adopted or dead animal would put 182 empty drafts into the admin
    // list, and the list is how the shelter finds the animal in front of them.
    if (status !== 'in-shelter') continue;

    const draftId = readString(draftIdFor(no));
    if (draftId === null) {
      blockers.push({ no, why: 'draftIdFor returned an empty id' });
      continue;
    }

    const events = eventsByNo.get(no) ?? [];
    const healthNotes: string[] = [];
    const takenIds = new Set<string>();
    const plannedForThisAnimal: PlannedMedical[] = [];
    let sterilizedByEvent = false;

    for (const event of events) {
      if (event.type === 'sterilization') sterilizedByEvent = true;

      const day = event.precision === 'day' && event.date ? event.date : null;
      const performedAtMs = day === null ? null : boliviaNoonMs(day);
      const reasons = skipReasons(event, performedAtMs, todayMs);

      if (reasons.length > 0) {
        // A sterilization the register dates only by year gets its own wording:
        // the fact survives on the draft even though the record cannot.
        const note =
          event.type === 'sterilization' && event.precision !== 'day' && event.status === 'confirmed'
            ? approximateSterilizationNote(no, event)
            : skipNote(no, event, reasons);

        healthNotes.push(note);
        skipped.push({
          no,
          what: EVENT_LABEL_ES[event.type],
          why: reasons.join(', '),
          raw: event.raw,
        });
        continue;
      }

      // `reasons` being empty already rules out `other` and a null day.
      if (event.type === 'other' || day === null || performedAtMs === null) continue;

      const mapping = EVENT_MAPPING[event.type];
      const id = medicalRecordId(no, event.column, day, takenIds);

      const record: MedicalImportPlan = {
        kind: mapping.kind,
        name: mapping.name,
        performedAtMs,

        // All null: the register has columns for none of these. A blank lot
        // number is the COMMON case in Bolivia, not an incomplete record —
        // the free national rabies campaign produces exactly this shape.
        nextDueAtMs: null,
        validFromMs: null,
        validUntilMs: null,
        veterinarian: null,
        clinic: null,
        batch: null,
        manufacturer: null,

        notes: `Transcrito del registro en papel, n.º ${no}, columna «${event.column}»: «${event.raw}».`,
        codes: [],

        // A person read paper and typed it. `source: 'manual'` is literally
        // true, and `isConfirmed()` ignores `source` anyway — what tells a
        // later reader where this came from is `importRef`, not this field.
        source: 'manual',
        sourceDocument: null,

        // Stated rather than left out: no model was involved, and a script
        // filling these in by default is how a transcription starts claiming
        // to be an extraction.
        extractedByModel: null,
        extractedAtMs: null,
        extractedFrom: null,
        extractionEvidence: null,

        importRef: {
          batch,
          registerNo: no,
          column: event.column,
          raw: event.raw,
          sheet: event.source,
        },
      };

      // ── The same validator the medical form uses ────────────────────────
      //
      // Not a reimplementation of it. If the form would refuse this record,
      // the import must not create it behind the form's back — a document the
      // UI considers impossible is one nobody can correct through the UI.
      //
      // `todayMs` is passed as `now` so the answer does not depend on when the
      // import runs: the same plan built twice a week apart is identical.
      const draftForValidation: MedicalRecordDraft = {
        kind: record.kind,
        name: record.name,
        performedAt: record.performedAtMs,
        nextDueAt: null,
        validFrom: null,
        validUntil: null,
        veterinarian: null,
        clinic: null,
        batch: null,
        manufacturer: null,
        notes: record.notes,
      };
      const errors = validateMedicalDraft(draftForValidation, todayMs);
      if (errors.length > 0) {
        blockers.push({
          no,
          why: `planned medical record ${id} is invalid: ${errors.join(', ')} (raw ${JSON.stringify(event.raw)})`,
        });
        continue;
      }

      plannedForThisAnimal.push({ petId: draftId, id, no, data: record });
    }

    const normalizedName = readString(row['displayName']) ?? '';

    const register: RegisterRef = {
      no,
      nameRaw: entry.nameRaw,
      // `YYYY-MM-DD` or null — the wizard shows what the paper says, and for
      // most of these rows the paper says only a year.
      intakeDay: readString(row['intakeDate']),
      ageText: entry.ageAtIntakeRaw,
      sexPerRegister: entry.sex,
      sterilizedPerRegister: entry.sterilizedPerRegister || sterilizedByEvent,
      medicalCount: plannedForThisAnimal.length,
      batch,
      // ⚠️ Provisional, not confirmed, even though the importer created this
      // draft from this row and cannot be wrong about that. `linkConfidence`
      // answers "is the animal in the photograph the animal on this line?",
      // and the only thing that can answer it is a person looking at the
      // animal. Everything this import produces is provisional until then,
      // which is the same reason `statusConfirmed` is false.
      linkConfidence: 'provisional',
    };

    const draft: PetDraftPlan = {
      ...draftDefaults(draftId),
      // ⚠️ Only when the register holds a NAME. 47 of the 225 rows hold a
      // description instead — "BB2 de Johana, café con blanco", "BB3 (pomposo,
      // con negro)" — and 4 of those are animals living at the shelter today.
      // `name` and `slug` reach `pets/{id}`, which is public-read, so copying
      // a description here would publish "BB3 (pomposo, con negro)" as an
      // animal's name the moment someone photographs it. Empty instead: the
      // publish gate already refuses a nameless draft (`name-required`), so
      // the person holding the animal is asked for a name rather than a
      // description being promoted into one behind their back.
      //
      // `register.nameRaw` keeps what the paper says either way, and
      // `draftFromEntry` in register-admin.ts applies the same rule.
      name: entry.hasRealName ? normalizedName : '',
      sex: entry.sex,
      // An imported animal is at the shelter. NOT `available`: publishing to
      // the public wall is a decision a person makes with a photograph in
      // hand, and 43 animals appearing on the wall with no photo is exactly
      // the fabricated-content failure this project refuses.
      status: 'shelter',
      // Same gate as `name`: a slug derived from a description would become
      // the animal's public URL.
      slug: entry.hasRealName ? slugify(normalizedName) : '',
      sterilized: entry.sterilizedPerRegister || sterilizedByEvent,
      healthNotes: healthNotes.join('\n'),
      register,

      // ⚠️ `species`, `breed`, `size`, `colorPattern`, `coatType` and every age
      // field are left at their defaults — empty — and that is the single most
      // important decision in this file. The photo session fills them, and the
      // intake wizard's AI prefill offers a value into an EMPTY field and will
      // not overwrite one a human or an import already put there. Writing the
      // register's guess ("dog", inferred from the presence of a canine
      // vaccine) would therefore not add information: it would permanently
      // block the camera from adding any. Species in particular inflects every
      // Spanish sentence the site writes about the animal.
    };

    // Both halves of the link, written by the same plan. `entry` is the object
    // already pushed onto `entries`, so setting it here is what reaches
    // Firestore — the roster then opens THIS draft instead of minting another.
    entry.petId = draftId;
    entry.linkConfidence = 'provisional';

    drafts.push({ id: draftId, no, data: draft });
    medical.push(...plannedForThisAnimal);
  }

  // ── The tripwire runs last, over everything the plan would write ──────────

  for (const planned of entries) scanForPersonalData(planned.data, `entry ${planned.no}`, planned.no, blockers);
  for (const planned of drafts) scanForPersonalData(planned.data, `draft ${planned.no}`, planned.no, blockers);
  for (const planned of medical) scanForPersonalData(planned.data, `medical ${planned.id}`, planned.no, blockers);
  for (const item of skipped) scanForPersonalData(item, `skipped ${item.no}`, item.no, blockers);

  return {
    batch,
    entries,
    drafts,
    medical,
    skipped,
    blockers,
    stats: {
      entries: entries.length,
      byStatus,
      drafts: drafts.length,
      medical: medical.length,
      skipped: skipped.length,
    },
  };
}
