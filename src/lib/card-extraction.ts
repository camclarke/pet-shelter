/**
 * Vaccination-card extraction: the PURE decision layer. Build-order step 9,
 * plan §4.3.
 *
 * No Firestore, no AI, no Spanish. The model call lives in
 * `src/lib/ai/card-extract.ts`; this module decides what its answer is WORTH
 * before anything is written. Same split as `intake-suggestion.ts` /
 * `ai/intake-suggest.ts`.
 *
 * ═══ THE MODEL TRANSCRIBES. THIS CODE DECIDES. ══════════════════════════════
 * For every field the model returns only the literal text it read and how
 * sure it is of having read it. It never returns a date AS a date: a date
 * comes back as «12/03/25», exactly as written, and `parseCardDate` below turns
 * it into a day. Two reasons:
 *
 *   - A value the model reformatted cannot be checked against the card. The
 *     snippet can: a reviewer sees «12/03/25» beside "12 mar 2025" and knows in
 *     one glance whether the reading and the interpretation agree.
 *   - A deterministic parser has testable rules — day first, a real calendar
 *     day, a two-digit year in this century — where a model's reformatting is
 *     a different guess every call. The same division the food subsystem uses:
 *     the LLM parses text, arithmetic decides.
 *
 * ═══ FAILURE DIRECTION: TOWARD DROPPING ═════════════════════════════════════
 * Playbook §6.2. This is a persistence gate into a medical record. A field left
 * empty costs one manual entry by someone holding the card; a wrong
 * vaccination date is served, trusted and acted on for years, and for rabies
 * it carries legal consequences. So every doubt resolves to "leave it empty":
 * a low confidence, a date that does not parse, a date that could not have
 * happened, a snippet too long to be one value, a row with nothing usable in
 * it, and an image the model itself says is not a card.
 *
 * Nothing this module prefills COUNTS for anything either. Every candidate is
 * written unconfirmed and stays out of all computation until a person confirms
 * it — see `review-gate.ts`.
 */

import type { FieldEvidence, MedicalRecordKind, WithheldReason } from './types';
import { medicalDraftDefaults, type MedicalRecordDraft } from './medical';
import type { CandidateFields } from './medical-candidates';
import { CLOCK_SKEW_TOLERANCE_MS } from './placements';
import { evidenceVerdict, sanitizeConfidence, type EvidenceThresholds } from './review-gate';

// ─────────────────────────────────────────────────────────────────────────────
// What the model is asked for
// ─────────────────────────────────────────────────────────────────────────────

export const CARD_TEXT_FIELDS = ['name', 'batch', 'manufacturer', 'veterinarian', 'clinic'] as const;
export const CARD_DATE_FIELDS = ['performedAt', 'nextDueAt'] as const;

export type CardTextField = (typeof CARD_TEXT_FIELDS)[number];
export type CardDateField = (typeof CARD_DATE_FIELDS)[number];
export type CardField = 'kind' | CardTextField | CardDateField;

/**
 * Every field a card row carries, in the order a reviewer reads them.
 *
 * ⚠️ `validFrom`, `validUntil` and `notes` are deliberately NOT extracted. A
 * Bolivian card prints an application date and a revaccination date; it does
 * not print a protection window, and asking for one invites the model to
 * compute it — which is exactly the rule the prompt forbids. The 21-day rabies
 * protection start stays a deterministic, offered default in the form.
 */
export const CARD_FIELDS: readonly CardField[] = [
  'kind',
  'name',
  'performedAt',
  'nextDueAt',
  'batch',
  'manufacturer',
  'veterinarian',
  'clinic',
];

/** The only kinds a card distinguishes. Anything else is left for a person to pick. */
export type CardKindValue = Extract<MedicalRecordKind, 'vaccination' | 'deworming'>;

export interface RawCardField {
  /** The literal text read, or null when the field is absent or illegible. */
  snippet: string | null;
  /** 0..1, how legible THAT text was. */
  confidence: number;
}

export interface RawCardKind extends RawCardField {
  value: CardKindValue | null;
}

export interface RawCardRow {
  kind: RawCardKind;
  name: RawCardField;
  performedAt: RawCardField;
  nextDueAt: RawCardField;
  batch: RawCardField;
  manufacturer: RawCardField;
  veterinarian: RawCardField;
  clinic: RawCardField;
}

export interface RawCardExtraction {
  isVaccinationCard: boolean;
  rows: RawCardRow[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds — chosen, justified, and pinned by literal tests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A DATE is prefilled only at confidence ≥ 0.8.
 *
 * The date is the field where a wrong value is both PLAUSIBLE and
 * CONSEQUENTIAL: "12/03/2025" misread as "12/03/2024" looks like a date, and it
 * decides when the next dose is given and whether a rabies vaccination is
 * legally in force. A prefilled value is accepted unread far more often than an
 * empty field is mistyped — automation bias — so the bar is high. What
 * withholding costs is one date typed while the snippet the model read is
 * already on the screen beside the empty field.
 */
export const CARD_DATE_PREFILL_MIN = 0.8;

/**
 * Everything else — product, lot, vet, clinic, and the kind — at ≥ 0.6.
 *
 * Lower because a misread NAME reads as nonsense to someone holding the card,
 * and none of these fields feeds a computation on its own. Not lower still,
 * because an empty form trains people to skip the feature, and a model below
 * 0.6 on its own reading is telling us it is guessing.
 */
export const CARD_TEXT_PREFILL_MIN = 0.6;

/**
 * Below 0.9 a PREFILLED value is highlighted with its snippet beside it.
 *
 * Self-reported confidence is uncalibrated and tends to cluster high, so
 * "anything the model itself will not rate 0.9" is the band worth a second
 * look. A date's snippet is shown whatever its confidence, because the value on
 * screen is OUR parse and the snippet is the evidence for it.
 */
export const CARD_HIGHLIGHT_BELOW = 0.9;

export function cardThresholdsFor(field: CardField): EvidenceThresholds {
  const isDate = (CARD_DATE_FIELDS as readonly string[]).includes(field);
  return {
    prefillMin: isDate ? CARD_DATE_PREFILL_MIN : CARD_TEXT_PREFILL_MIN,
    highlightBelow: CARD_HIGHLIGHT_BELOW,
  };
}

/**
 * A snippet longer than this is not one value. Withheld rather than
 * truncated, because a truncated product name is a changed product name; the
 * STORED evidence is capped too, so a model that dumps half the card into one
 * field cannot put the owner's address into Firestore through it.
 */
export const CARD_SNIPPET_MAX_CHARS = 80;

/** More rows than any real card holds. The rest are dropped and counted. */
export const CARD_MAX_ROWS = 20;

/** A performed date older than this is a misread, not an old animal. */
export const CARD_OLDEST_PLAUSIBLE_YEARS = 30;

/** A revaccination scheduled further out than this is a misread too. */
export const CARD_FURTHEST_DUE_YEARS = 10;

const YEAR_MS = 365.25 * 86_400_000;

// ─────────────────────────────────────────────────────────────────────────────
// Dates, as a Bolivian card writes them
// ─────────────────────────────────────────────────────────────────────────────

const MONTH_NAMES: Record<string, number> = {
  enero: 1, ene: 1,
  febrero: 2, feb: 2,
  marzo: 3, mar: 3,
  abril: 4, abr: 4,
  mayo: 5, may: 5,
  junio: 6, jun: 6,
  julio: 7, jul: 7,
  agosto: 8, ago: 8,
  // Bolivia and Peru also write "setiembre".
  septiembre: 9, setiembre: 9, sept: 9, sep: 9, set: 9,
  octubre: 10, oct: 10,
  noviembre: 11, nov: 11,
  diciembre: 12, dic: 12,
};

/** Latin American vet cards routinely write the month in Roman numerals. */
const ROMAN_MONTHS: Record<string, number> = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6,
  vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12,
};

/** Day, separator, month (digits, Roman or name), separator, year. */
const SEPARATED = /^(\d{1,2}) ?[/.-] ?([a-z]+|\d{1,2})\.? ?[/.-] ?(\d{4}|\d{2})$/;
/** "12 mar 2025", "12 de marzo de 2025", "12 de marzo del 2025". */
const WORDED = /^(\d{1,2}) (?:de )?([a-z]+)\.?,? (?:del? )?(\d{4}|\d{2})$/;

function monthFrom(token: string): number | null {
  if (/^\d+$/.test(token)) {
    const n = Number(token);
    return n >= 1 && n <= 12 ? n : null;
  }
  return MONTH_NAMES[token] ?? ROMAN_MONTHS[token] ?? null;
}

function yearFrom(token: string): number | null {
  // Two digits are this century. A card for a living animal with "98" on it is
  // far likelier a misread than a record from 1998, and the plausibility check
  // downstream refuses anything that old either way.
  if (token.length === 2) return 2000 + Number(token);
  const year = Number(token);
  return year >= 1990 && year <= 2099 ? year : null;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * A date as a Bolivian card writes it, to epoch ms — or null.
 *
 * ⚠️ DAY FIRST, always. "03/04/25" is the 3rd of April. That is how Bolivia
 * writes a date, and a month-first reading would be a guess about the one
 * card in a thousand that came from abroad. The snippet stays beside the value,
 * so a reviewer holding such a card sees the disagreement.
 *
 * ⚠️ YEAR-FIRST IS REFUSED. "2025-03-12" is not how a card is written, so a
 * snippet in ISO form means the model REFORMATTED the date instead of copying
 * it — the one thing the prompt forbids. Refusing it turns that violation into
 * an empty field rather than a trusted value.
 *
 * Returns 12:00 UTC on the day, which is 08:00 in Cochabamba (UTC-4): the same
 * calendar day in every timezone from UTC-12 to UTC+11, so rendering it in the
 * admin's browser cannot shift it by one.
 */
export function parseCardDate(text: string | null | undefined): number | null {
  if (typeof text !== 'string') return null;
  const s = text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '');
  if (s === '' || s.length > 40) return null;

  const match = SEPARATED.exec(s) ?? WORDED.exec(s);
  if (!match) return null;

  const day = Number(match[1]);
  const month = monthFrom(match[2]!);
  const year = yearFrom(match[3]!);
  if (month === null || year === null) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;

  return Date.UTC(year, month - 1, day, 12, 0, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Review: raw model output → candidates
// ─────────────────────────────────────────────────────────────────────────────

export interface CardCandidate {
  /** Values a person will see in the form. Null wherever a value was withheld. */
  draft: MedicalRecordDraft;
  /** What the model read, for every field, whether or not it was used. */
  evidence: Record<CardField, FieldEvidence>;
}

export type CardReview =
  | { kind: 'not-a-card' }
  | { kind: 'reviewed'; candidates: CardCandidate[]; droppedRows: number };

function textOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function capped(snippet: string | null): string | null {
  if (snippet === null || snippet.length <= CARD_SNIPPET_MAX_CHARS) return snippet;
  return `${snippet.slice(0, CARD_SNIPPET_MAX_CHARS)}…`;
}

function fieldOf(row: unknown, field: CardField): { snippet: string | null; confidence: number; value?: unknown } {
  const raw = row !== null && typeof row === 'object' ? (row as Record<string, unknown>)[field] : null;
  if (raw === null || typeof raw !== 'object') return { snippet: null, confidence: 0 };
  const entry = raw as Record<string, unknown>;
  return {
    snippet: textOf(entry.snippet),
    confidence: sanitizeConfidence(entry.confidence),
    value: entry.value,
  };
}

/**
 * Decide one text-like field: copy it, or withhold it and say why.
 * Returns the value to prefill (or null) and the evidence to store.
 */
function decideText(
  row: unknown,
  field: CardField,
): { value: string | null; evidence: FieldEvidence } {
  const { snippet, confidence } = fieldOf(row, field);
  if (snippet === null) {
    // Absent is not withheld: there was nothing to copy.
    return { value: null, evidence: { snippet: null, confidence, withheld: null } };
  }
  if (snippet.length > CARD_SNIPPET_MAX_CHARS) {
    return { value: null, evidence: { snippet: capped(snippet), confidence, withheld: 'too-long' } };
  }
  if (evidenceVerdict({ snippet, confidence }, cardThresholdsFor(field)) === 'withhold') {
    return { value: null, evidence: { snippet, confidence, withheld: 'low-confidence' } };
  }
  return { value: snippet, evidence: { snippet, confidence, withheld: null } };
}

function decideDate(
  row: unknown,
  field: CardDateField,
  isPlausible: (ms: number) => boolean,
): { value: number | null; evidence: FieldEvidence } {
  const text = decideText(row, field);
  if (text.value === null) return { value: null, evidence: text.evidence };

  const withhold = (reason: WithheldReason) => ({
    value: null,
    evidence: { ...text.evidence, withheld: reason },
  });

  const parsed = parseCardDate(text.value);
  if (parsed === null) return withhold('unreadable-date');
  if (!isPlausible(parsed)) return withhold('implausible-date');
  return { value: parsed, evidence: text.evidence };
}

function reviewRow(row: unknown, now: number): CardCandidate | null {
  const draft = medicalDraftDefaults();

  // ── kind: an enum, so the snippet is the heading the model relied on ──────
  const kindRaw = fieldOf(row, 'kind');
  const kindValue =
    kindRaw.value === 'vaccination' || kindRaw.value === 'deworming' ? kindRaw.value : null;
  const kindText = decideText(row, 'kind');
  let kindEvidence = kindText.evidence;
  if (kindValue === null && kindText.value !== null) {
    // A heading with no classification — or one outside the two a card holds —
    // is left for a person to pick. Nothing is inferred from the words.
    kindEvidence = { ...kindText.evidence, withheld: 'low-confidence' };
  }
  draft.kind = kindText.value !== null ? kindValue : null;

  // ── text fields, verbatim ─────────────────────────────────────────────────
  const name = decideText(row, 'name');
  const batch = decideText(row, 'batch');
  const manufacturer = decideText(row, 'manufacturer');
  const veterinarian = decideText(row, 'veterinarian');
  const clinic = decideText(row, 'clinic');
  draft.name = name.value ?? '';
  draft.batch = batch.value;
  draft.manufacturer = manufacturer.value;
  draft.veterinarian = veterinarian.value;
  draft.clinic = clinic.value;

  // ── dates, parsed by us and checked for plausibility ─────────────────────
  const performed = decideDate(
    row,
    'performedAt',
    (ms) =>
      ms <= now + CLOCK_SKEW_TOLERANCE_MS &&
      ms >= now - CARD_OLDEST_PLAUSIBLE_YEARS * YEAR_MS,
  );
  draft.performedAt = performed.value;

  const due = decideDate(
    row,
    'nextDueAt',
    (ms) =>
      ms <= now + CARD_FURTHEST_DUE_YEARS * YEAR_MS &&
      ms >= now - CARD_OLDEST_PLAUSIBLE_YEARS * YEAR_MS &&
      // A revaccination before the dose it follows is a misread of one of the
      // two. The due date is the one withheld: the application date is the
      // fact the record exists to hold.
      (performed.value === null || ms >= performed.value),
  );
  draft.nextDueAt = due.value;

  // A row counts only if it names what was given or when. A lot number alone,
  // or a vet's stamp alone, is not a record anyone could confirm.
  if (draft.name === '' && draft.performedAt === null) return null;

  return {
    draft,
    evidence: {
      kind: kindEvidence,
      name: name.evidence,
      performedAt: performed.evidence,
      nextDueAt: due.evidence,
      batch: batch.evidence,
      manufacturer: manufacturer.evidence,
      veterinarian: veterinarian.evidence,
      clinic: clinic.evidence,
    },
  };
}

/**
 * What a model's reading of a card is worth, row by row.
 *
 * ⚠️ `isVaccinationCard` must be literally `true`. A model that says the image
 * is not a card has told us something, and rows it returned anyway are exactly
 * the invented content this path exists to keep out.
 */
export function reviewCardExtraction(raw: unknown, now: number = Date.now()): CardReview {
  const extraction = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (extraction.isVaccinationCard !== true) return { kind: 'not-a-card' };

  const rows = Array.isArray(extraction.rows) ? extraction.rows : [];
  const considered = rows.slice(0, CARD_MAX_ROWS);

  const candidates: CardCandidate[] = [];
  for (const row of considered) {
    const candidate = reviewRow(row, now);
    if (candidate) candidates.push(candidate);
  }

  return {
    kind: 'reviewed',
    candidates,
    droppedRows: rows.length - candidates.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The stored candidate
// ─────────────────────────────────────────────────────────────────────────────

export interface CandidateMeta {
  /** The stable model KEY, never the raw id. Plan §4.4. */
  modelKey: string;
  /** The card photo's Storage path. */
  sourceDocument: string;
  /** The admin who asked for the extraction. */
  recordedBy: string;
}

/**
 * The document the `index`-th card candidate is written as, at
 * `pets/{petId}/medicalCandidates/{candidateIdFor(sourceDocument, index)}`.
 *
 * ⚠️ There is no `confirmedBy`, `confirmedAt` or `source` here AT ALL, and
 * that is the point: a candidate is unconfirmed by WHERE it is, in an
 * admin-only collection, not by a value someone could set. The only way into
 * `medical` is `planConfirmation()` — see `medical-candidates.ts`.
 */
export function cardCandidateFields(
  candidate: CardCandidate,
  index: number,
  meta: CandidateMeta,
): CandidateFields {
  const { draft } = candidate;
  return {
    kind: draft.kind,
    name: draft.name,
    performedAt: draft.performedAt,
    nextDueAt: draft.nextDueAt,
    // Never extracted from a card — see CARD_FIELDS.
    validFrom: null,
    validUntil: null,
    veterinarian: draft.veterinarian,
    clinic: draft.clinic,
    batch: draft.batch,
    manufacturer: draft.manufacturer,
    notes: null,
    sourceDocument: meta.sourceDocument,
    extractedByModel: meta.modelKey,
    extractedFrom: 'vaccination-card',
    extractionEvidence: candidate.evidence,
    sourceIndex: index,
    recordedBy: meta.recordedBy,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Where the card photo lives, and what the route will accept
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Long edge for a card photo, larger than the 1600 px used for animals. A lot
 * number on a vaccine sticker is a couple of millimetres tall, and a card
 * photographed with some margin needs the pixels to stay legible.
 */
export const CARD_PHOTO_MAX_EDGE = 2048;

const PET_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PHOTO_ID = /^[A-Za-z0-9-]{8,64}$/;

export function isValidPetId(petId: unknown): petId is string {
  return typeof petId === 'string' && PET_ID.test(petId);
}

/**
 * Where a card photo is stored: `medical/{petId}/card-{photoId}.jpg`.
 *
 * ⚠️ FLAT, and that is load-bearing. The deployed `storage.rules` match is
 * `match /medical/{petId}/{fileName}` — ONE segment after the pet — and serves
 * it to admins only. A card very often carries the owner's name, address and
 * phone, so admin-only is the right tier, stricter than `pets/{id}/private/`.
 * A nested `medical/{petId}/cards/x.jpg` would match no rule at all and be
 * refused even to an admin (verified with the Rules test API).
 */
export function cardPhotoPath(petId: string, photoId: string): string {
  if (!isValidPetId(petId) || !PHOTO_ID.test(photoId)) {
    throw new Error('card-extraction: invalid pet or photo id');
  }
  return `medical/${petId}/card-${photoId}.jpg`;
}

/**
 * Is `path` a card photo belonging to `petId`, and nothing else?
 *
 * The route reads the object with the Admin SDK, which can read ANY object in
 * the bucket. Holding the path to exactly this shape is what stops the route
 * becoming a way to send an arbitrary object — an intimate intake photo, another
 * pet's card — to a third-party model.
 */
export function isCardPhotoPathFor(path: unknown, petId: string): boolean {
  if (typeof path !== 'string' || !isValidPetId(petId)) return false;
  const prefix = `medical/${petId}/card-`;
  if (!path.startsWith(prefix) || !path.endsWith('.jpg')) return false;
  return PHOTO_ID.test(path.slice(prefix.length, -'.jpg'.length));
}

/** The route's request body, or null when it is not exactly that. */
export function parseCardExtractRequest(body: unknown): { petId: string; path: string } | null {
  if (body === null || typeof body !== 'object') return null;
  const { petId, path } = body as Record<string, unknown>;
  if (!isValidPetId(petId)) return null;
  if (!isCardPhotoPathFor(path, petId)) return null;
  return { petId, path: path as string };
}
