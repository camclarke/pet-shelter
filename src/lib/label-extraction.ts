/**
 * Reading a vaccine or medicine LABEL: the PURE layer. Plan C3, 2026-10-14.
 *
 * No Firestore, no AI, no Spanish. `ai/label-extract.ts` obtains the reading;
 * this file decides what it is WORTH — which value is copied into the form and
 * which is left for a person, with the reason. Same split as
 * `card-extraction.ts`, and it reuses that module's thresholds and date parser
 * rather than a copy, so a label and a card are judged by one rule.
 *
 * ═══ WHAT A LABEL CAN FILL, AND WHAT IT NEVER CAN ═══════════════════════════
 * It prefills `product`, `manufacturer` and `productExpiresAt`, and OFFERS the
 * lot for one tap (see `LabelOffer` for the measurement that put it there). It
 * can NEVER fill the date given or the next dose — the
 * schema has no such fields (see `ai/label-schema.ts`). The manufacture date
 * is read only so it can be kept OUT of the expiry: it fills nothing.
 *
 * ═══ THE PRINTED WORD DECIDES WHICH NUMBER IS WHICH ═════════════════════════
 * A label prints a lot, a tab number, a registration, a volume, and two dates.
 * Measured 2026-10-14: the card reader took the coloured tab's number for the
 * lot on both Zoetis Vanguard stickers, 6 of 6. So a lot is copied only when
 * the word printed beside it says «Lote» or «Lot», and a date only when its
 * word says which date it is. A missing or wrong word withholds the value as
 * `unlabelled` — a person sees the snippet and types it if it is right.
 *
 * ═══ FAILURE DIRECTION ══════════════════════════════════════════════════════
 * Toward an empty field. A withheld value costs one typed entry with the
 * label in hand; a wrong lot or expiry saved unread is the error that matters,
 * because the expired-vial warning reads the expiry.
 */

import type { FieldEvidence, WithheldReason } from './types';
import {
  CARD_DATE_PREFILL_MIN,
  CARD_HIGHLIGHT_BELOW,
  CARD_SNIPPET_MAX_CHARS,
  CARD_TEXT_PREFILL_MIN,
  parseCardDate,
} from './card-extraction';
import { CLOCK_SKEW_TOLERANCE_MS } from './placements';
import { evidenceVerdict, sanitizeConfidence, type EvidenceThresholds } from './review-gate';

// ─────────────────────────────────────────────────────────────────────────────
// What the model returns
// ─────────────────────────────────────────────────────────────────────────────

export const LABEL_TEXT_FIELDS = ['product', 'manufacturer', 'protectsAgainst'] as const;
export const LABEL_WORDED_FIELDS = ['lot', 'manufacturedAt', 'expiresAt'] as const;
export const LABEL_FIELDS = [...LABEL_TEXT_FIELDS, ...LABEL_WORDED_FIELDS] as const;

export type LabelTextField = (typeof LABEL_TEXT_FIELDS)[number];
export type LabelWordedField = (typeof LABEL_WORDED_FIELDS)[number];
export type LabelField = (typeof LABEL_FIELDS)[number];

export interface RawLabelText {
  snippet: string | null;
  confidence: number;
}

export interface RawLabelWorded extends RawLabelText {
  /** The word printed beside the value: «N. Lote», «F. Venc», «F. Elab». */
  fieldWord: string | null;
}

export interface RawLabelExtraction {
  isVeterinaryLabel: boolean;
  product: RawLabelText;
  manufacturer: RawLabelText;
  protectsAgainst: RawLabelText;
  lot: RawLabelWorded;
  manufacturedAt: RawLabelWorded;
  expiresAt: RawLabelWorded;
}

// ─────────────────────────────────────────────────────────────────────────────
// The printed words
// ─────────────────────────────────────────────────────────────────────────────

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The words a label prints beside its lot. «N. Lote», «Nº Lote», «Lote»,
 * «Lot», «Lot No.», «Batch», «Partida». Matched as whole words, letter-aware:
 * JavaScript's `\b` is ASCII-only.
 */
const LOT_WORD = /(?<![\p{L}\p{N}])(lote|lot|batch|partida)(?![\p{L}])/u;

/** «F. Venc», «Vence», «Vto», «Exp», «Expira», «F. Cad», «Caduca», «Válido hasta». */
const EXPIRY_WORD = /(?<![\p{L}])(venc|vence|vencimiento|vto|exp|expira|expiry|cad|caduca|caducidad|valido hasta|use before|usar antes)(?![\p{L}])/u;

/** «F. Elab», «Elaborado», «Fab», «Fabricación», «Mfg», «Manuf», «Prod». */
const MADE_WORD = /(?<![\p{L}])(elab|elaborado|elaboracion|fab|fabricado|fabricacion|mfg|mfd|manuf|manufactured|prod|produccion)(?![\p{L}])/u;

/** Does the printed word say this is the lot? */
export function isLotWord(word: string | null): boolean {
  return word !== null && LOT_WORD.test(fold(word));
}

/** Does the printed word say this date is the expiry — and not the manufacture? */
export function isExpiryWord(word: string | null): boolean {
  if (word === null) return false;
  const w = fold(word);
  return EXPIRY_WORD.test(w) && !MADE_WORD.test(w);
}

/** Does the printed word say this date is the manufacture — and not the expiry? */
export function isMadeWord(word: string | null): boolean {
  if (word === null) return false;
  const w = fold(word);
  return MADE_WORD.test(w) && !EXPIRY_WORD.test(w);
}

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds — the card reader's, on purpose
// ─────────────────────────────────────────────────────────────────────────────

/** A lot is longer than this only when the model swept up a sentence. */
export const LABEL_LOT_MAX_CHARS = 24;

/** An expiry further out than this is a misread: vaccines carry 1–3 years. */
export const LABEL_FURTHEST_EXPIRY_YEARS = 10;

/** Any label date before this is a misread. */
export const LABEL_EARLIEST_YEAR = 2000;

const YEAR_MS = 365.25 * 86_400_000;

/**
 * The card reader's thresholds: 0.8 to prefill a date, 0.6 for text, a
 * highlight below 0.9. The same reasoning holds for a label — a wrong date is
 * plausible and consequential, a wrong name reads as nonsense to someone
 * holding the vial — and one rule for both readers is one rule to tune.
 */
export function labelThresholdsFor(field: LabelField): EvidenceThresholds {
  const isDate = field === 'manufacturedAt' || field === 'expiresAt';
  return {
    prefillMin: isDate ? CARD_DATE_PREFILL_MIN : CARD_TEXT_PREFILL_MIN,
    highlightBelow: CARD_HIGHLIGHT_BELOW,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Review: raw reading → what the form receives
// ─────────────────────────────────────────────────────────────────────────────

/** What a label PREFILLS in the medical form. Null wherever a value was withheld. */
export interface LabelFill {
  product: string | null;
  manufacturer: string | null;
  /** 12:00 UTC on the printed day, like every card date. */
  productExpiresAt: number | null;
}

/**
 * What a label OFFERS but never prefills: the person sees it beside the empty
 * field, with the label's own text, and accepts it with one tap.
 *
 * ⚠️ The lot is here because of a measurement, not a hunch. `npm run
 * eval:labels`, 2026-10-15, Flash-Lite, 4 real stickers × 3 runs: the lot of
 * the Vanguard CV sticker came back «727023» against the printed «727923» in
 * 3 of 3 runs, and a blurred lot came back as three different numbers in
 * three runs — every one at confidence 1.0. Confidence cannot separate a
 * right lot from a wrong one, so no threshold can make prefilling it safe; an
 * offer the person has to accept puts their eyes on the digits.
 */
export interface LabelOffer {
  batch: string | null;
}

export type LabelReview =
  | { kind: 'not-a-label' }
  | {
      kind: 'reviewed';
      fill: LabelFill;
      offer: LabelOffer;
      /** What was read for every field, filled or not, with why a value was withheld. */
      evidence: Record<LabelField, FieldEvidence>;
      /**
       * Prefilled fields shown with their snippet beside them. The expiry is
       * ALWAYS here when filled: the date on screen is our parse, and the
       * label's own text is the evidence for it — the card reader's rule.
       */
      highlighted: Array<keyof LabelFill>;
    };

function textOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function capped(text: string | null): string | null {
  if (text === null || text.length <= CARD_SNIPPET_MAX_CHARS) return text;
  return `${text.slice(0, CARD_SNIPPET_MAX_CHARS)}…`;
}

function rawOf(raw: unknown, field: LabelField): { snippet: string | null; confidence: number; fieldWord: string | null } {
  const entry = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>)[field] : null;
  if (entry === null || typeof entry !== 'object') return { snippet: null, confidence: 0, fieldWord: null };
  const e = entry as Record<string, unknown>;
  return {
    snippet: textOf(e.snippet),
    confidence: sanitizeConfidence(e.confidence),
    fieldWord: textOf(e.fieldWord),
  };
}

/**
 * The evidence a person sees: the printed word and the value together, as on
 * the label — «F. Venc 07 OCT 25». The word is half of what was read, and the
 * half that says which date it is.
 */
function shown(word: string | null, snippet: string | null): string | null {
  if (snippet === null) return null;
  return capped(word === null ? snippet : `${word} ${snippet}`);
}

type Decision<T> = { value: T | null; evidence: FieldEvidence; verdict: 'prefill' | 'prefill-highlighted' | 'withhold' };

function withheld<T>(snippet: string | null, confidence: number, reason: WithheldReason | null): Decision<T> {
  return { value: null, evidence: { snippet, confidence, withheld: reason }, verdict: 'withhold' };
}

function decideText(raw: unknown, field: LabelTextField): Decision<string> {
  const { snippet, confidence } = rawOf(raw, field);
  // Absent is not withheld: there was nothing to copy.
  if (snippet === null) return withheld(null, confidence, null);
  if (snippet.length > CARD_SNIPPET_MAX_CHARS) return withheld(capped(snippet), confidence, 'too-long');
  const verdict = evidenceVerdict({ snippet, confidence }, labelThresholdsFor(field));
  if (verdict === 'withhold') return withheld(snippet, confidence, 'low-confidence');
  return { value: snippet, evidence: { snippet, confidence, withheld: null }, verdict };
}

function decideLot(raw: unknown): Decision<string> {
  const { snippet, confidence, fieldWord } = rawOf(raw, 'lot');
  const seen = shown(fieldWord, snippet);
  if (snippet === null) return withheld(null, confidence, null);
  // ⚠️ The word, before anything else: a confident reading of the wrong number
  // is exactly the measured failure.
  if (!isLotWord(fieldWord)) return withheld(seen, confidence, 'unlabelled');
  if (snippet.length > LABEL_LOT_MAX_CHARS) return withheld(seen, confidence, 'too-long');
  const verdict = evidenceVerdict({ snippet, confidence }, labelThresholdsFor('lot'));
  if (verdict === 'withhold') return withheld(seen, confidence, 'low-confidence');
  return { value: snippet, evidence: { snippet: seen, confidence, withheld: null }, verdict };
}

function decideDate(
  raw: unknown,
  field: 'manufacturedAt' | 'expiresAt',
  isPlausible: (ms: number) => boolean,
): Decision<number> {
  const { snippet, confidence, fieldWord } = rawOf(raw, field);
  const seen = shown(fieldWord, snippet);
  if (snippet === null) return withheld(null, confidence, null);
  const rightWord = field === 'expiresAt' ? isExpiryWord(fieldWord) : isMadeWord(fieldWord);
  if (!rightWord) return withheld(seen, confidence, 'unlabelled');
  const verdict = evidenceVerdict({ snippet, confidence }, labelThresholdsFor(field));
  if (verdict === 'withhold') return withheld(seen, confidence, 'low-confidence');
  const parsed = parseCardDate(snippet);
  if (parsed === null) return withheld(seen, confidence, 'unreadable-date');
  if (!isPlausible(parsed)) return withheld(seen, confidence, 'implausible-date');
  return { value: parsed, evidence: { snippet: seen, confidence, withheld: null }, verdict };
}

/**
 * What one label reading is worth.
 *
 * ⚠️ An EXPIRED vial is not implausible. Its expiry is in the past, and that is
 * exactly what the form's `product-expired-before-dose` warning exists to
 * catch — refusing past expiries would silence the warning on the one case it
 * is for. The bounds only refuse dates no vial carries.
 */
export function reviewLabelExtraction(raw: unknown, now: number): LabelReview {
  const r = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (r.isVeterinaryLabel !== true) return { kind: 'not-a-label' };

  const earliest = Date.UTC(LABEL_EARLIEST_YEAR, 0, 1);
  const product = decideText(raw, 'product');
  const manufacturer = decideText(raw, 'manufacturer');
  const protects = decideText(raw, 'protectsAgainst');
  const lot = decideLot(raw);
  const made = decideDate(raw, 'manufacturedAt', (ms) => ms >= earliest && ms <= now + CLOCK_SKEW_TOLERANCE_MS);
  let expires = decideDate(
    raw,
    'expiresAt',
    (ms) => ms >= earliest && ms <= now + LABEL_FURTHEST_EXPIRY_YEARS * YEAR_MS,
  );

  // A vial cannot expire on or before the day it was made. When both dates
  // were read and that is what they say, one of them was misread and nothing
  // here can tell which: the expiry is withheld, since it is the one that
  // drives the expired-vial warning.
  if (expires.value !== null && made.value !== null && expires.value <= made.value) {
    expires = withheld(expires.evidence.snippet, expires.evidence.confidence, 'implausible-date');
  }

  const fill: LabelFill = {
    product: product.value,
    manufacturer: manufacturer.value,
    productExpiresAt: expires.value,
  };
  const highlighted: Array<keyof LabelFill> = [];
  if (product.verdict === 'prefill-highlighted') highlighted.push('product');
  if (manufacturer.verdict === 'prefill-highlighted') highlighted.push('manufacturer');
  if (expires.value !== null) highlighted.push('productExpiresAt');

  return {
    kind: 'reviewed',
    fill,
    offer: { batch: lot.value },
    evidence: {
      product: product.evidence,
      manufacturer: manufacturer.evidence,
      protectsAgainst: protects.evidence,
      lot: lot.evidence,
      manufacturedAt: made.evidence,
      expiresAt: expires.evidence,
    },
    highlighted,
  };
}
