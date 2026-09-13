/**
 * Donation parsing: what a parsed line is WORTH, and what it may do. Pure.
 *
 * No Firestore, no model, no Spanish copy. The model call lives in
 * `src/lib/ai/food-parse.ts`; this module decides what its answer is allowed
 * to influence. Same split as `intake-suggestion.ts` / `ai/intake-suggest.ts`.
 *
 * ═══ THE MODEL COPIES, THIS MODULE DECIDES ═════════════════════════════════
 * The parser is asked to split a sentence into foods and to COPY each food's
 * quantity words exactly as written — "3 bolsas", "de 5 kg". It converts
 * nothing. `parseQuantityPhrase` turns the copied words into grams, so the
 * number a pantry changes by is the same number every time the same words are
 * read. Plan §12.1.
 *
 * ═══ GROUNDING: A WORD THE TEXT DOES NOT CONTAIN CANNOT BECOME STOCK ═══════
 * Every copied fragment — the line's snippet, its quantity words, its expiry,
 * the donor — is checked against what the person actually typed (folded for
 * case, accents and punctuation). A fragment that is not there is dropped
 * before it can reach a number. A LINE whose snippet is not there is kept, so
 * the person can see what the model claimed, but it starts OUT of stock: a
 * hallucinated "5 kg de carne" must take a deliberate tap to count.
 *
 * ═══ NOTHING IS STORED UNTIL A PERSON CONFIRMS ═════════════════════════════
 * These drafts live in the browser. Saving the donation IS the confirmation,
 * and it re-runs `reviewDonation` on what the person left on screen.
 */

import type {
  FoodCategory,
  FoodHazard,
  ParseConfidence,
  Species,
} from './types';
import {
  LINE_MAX_GRAMS,
  LINE_UNUSUAL_ABOVE_GRAMS,
  foldText,
  parseKilogramsInput,
  parseQuantityPhrase,
  type MassUnit,
  type QuantityParse,
} from './food-quantity';
import {
  expiryWarning,
  findFoodHazards,
  hasToxicHazard,
  hazardsMissingFromLines,
  parseExpiryText,
  speciesRelevance,
  type HazardFinding,
  type SpeciesRelevance,
} from './food-safety';
import { isFoodCategory } from './food-stock';
import { CLOCK_SKEW_TOLERANCE_MS } from './placements';

/** The model's answer, as its schema types it. See `ai/food-parse-schema.ts`. */
export interface RawParsedItem {
  snippet: string;
  food: string;
  category: FoodCategory;
  amount: string | null;
  packageSize: string | null;
  expiry: string | null;
  confidence: ParseConfidence;
}

export interface RawParsedDonation {
  donor: string | null;
  items: RawParsedItem[];
}

export const DONATION_TEXT_MAX_CHARS = 2000;
export const DONATION_MAX_LINES = 40;
export const FOOD_NAME_MAX_CHARS = 80;

/** One line as the review screen holds it. */
export interface DonationLineDraft {
  /** Client-side identity for React. Never stored. */
  key: string;
  food: string;
  category: FoodCategory | null;
  /** The quantity words, editable: "3 bolsas de 5 kg". */
  quantityText: string;
  /**
   * Kilograms read off the scale. When non-empty it REPLACES `quantityText`
   * for the mass — the answer to "2 bolsas" with no size, and the shelter has
   * a scale (plan §11 #7).
   */
  massKgText: string;
  expiresAt: number | null;
  /** The expiry words as written, shown beside the date field. */
  expiryText: string | null;
  snippet: string | null;
  /** Whether `snippet` was found in the typed text. Always true for a hand-typed line. */
  grounded: boolean;
  /** The parser's confidence; null for a line typed by hand. */
  confidence: ParseConfidence | null;
  /** Whether this line adds to the pantry when the donation is saved. */
  includeInStock: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Grounding
// ─────────────────────────────────────────────────────────────────────────────

/** Folded, punctuation as spaces, whitespace collapsed. */
function squash(text: string): string {
  return foldText(text)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Whether `fragment` appears in `within`, ignoring case, accents, spacing and punctuation. */
export function isGrounded(fragment: string | null | undefined, within: string): boolean {
  if (!fragment) return false;
  const needle = squash(fragment);
  return needle.length > 0 && ` ${squash(within)} `.includes(` ${needle} `);
}

// ─────────────────────────────────────────────────────────────────────────────
// From the model's answer to review lines
// ─────────────────────────────────────────────────────────────────────────────

export function reviewParsedDonation(
  rawText: string,
  raw: RawParsedDonation
): { donor: string | null; lines: DonationLineDraft[] } {
  const lines = raw.items.slice(0, DONATION_MAX_LINES).map((item, index): DonationLineDraft => {
    const grounded = isGrounded(item.snippet, rawText);
    // Quantity words are checked against the line's own snippet when that is
    // real, so "2 kg" cannot be borrowed from a neighbouring line.
    const context = grounded ? item.snippet : rawText;
    const keep = (fragment: string | null) =>
      fragment !== null && isGrounded(fragment, context) ? fragment.trim() : null;

    const amount = keep(item.amount);
    const size = keep(item.packageSize);
    const expiryText = keep(item.expiry);
    const expiry = parseExpiryText(expiryText);
    const food = item.food.trim().slice(0, FOOD_NAME_MAX_CHARS);
    const hazards = findFoodHazards(`${food} ${grounded ? item.snippet : ''}`).map((f) => f.hazard);

    return {
      key: `line-${index}`,
      food,
      category: isFoodCategory(item.category) ? item.category : null,
      quantityText: [amount, size].filter((part): part is string => part !== null).join(' '),
      massKgText: '',
      expiresAt: expiry.kind === 'ok' ? expiry.at : null,
      expiryText,
      snippet: item.snippet.trim() || null,
      grounded,
      confidence: item.confidence,
      // Out of the pot by default when the model's line is not in the text,
      // or when the food is toxic. Both can be overridden by a person; neither
      // can be overridden by the model.
      includeInStock: grounded && !hasToxicHazard(hazards),
    };
  });

  const donor = raw.donor !== null && isGrounded(raw.donor, rawText) ? raw.donor.trim() : null;
  return { donor, lines };
}

/** A blank line for a person to type. */
export function emptyDonationLine(key: string): DonationLineDraft {
  return {
    key,
    food: '',
    category: null,
    quantityText: '',
    massKgText: '',
    expiresAt: null,
    expiryText: null,
    snippet: null,
    grounded: true,
    confidence: null,
    includeInStock: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Assessing a line
// ─────────────────────────────────────────────────────────────────────────────

export type DonationLineError =
  | 'food-required'
  | 'category-required'
  /** Containers or a volume with no weight: "2 bolsas". Weigh, or leave it out of stock. */
  | 'mass-required'
  | 'quantity-required'
  | 'quantity-unreadable'
  | 'quantity-ambiguous'
  | 'quantity-too-precise'
  | 'quantity-not-positive'
  | 'quantity-too-heavy';

export type DonationLineWarning =
  /** Toxic, and left out of stock — the default. */
  | { kind: 'toxic-excluded'; hazards: FoodHazard[] }
  /** Toxic, and a person put it back in. Shown just as loudly. */
  | { kind: 'toxic-included'; hazards: FoodHazard[] }
  | { kind: 'caution'; hazards: FoodHazard[] }
  | { kind: 'traditional-unit'; unit: MassUnit }
  | { kind: 'unusually-heavy'; grams: number }
  | { kind: 'expired' }
  | { kind: 'expires-soon' }
  | { kind: 'expiry-no-year'; text: string }
  | { kind: 'species-unstated' }
  /** The model's snippet is not in the typed text. */
  | { kind: 'not-in-text' }
  | { kind: 'low-confidence' }
  /** Recorded, but adds nothing to the pantry. */
  | { kind: 'not-stocked' };

export interface LineAssessment {
  quantity: QuantityParse;
  /** The grams this line would stock, or null. */
  grams: number | null;
  hazards: HazardFinding[];
  toxic: boolean;
  species: SpeciesRelevance;
  errors: DonationLineError[];
  warnings: DonationLineWarning[];
}

function quantityErrors(quantity: QuantityParse): DonationLineError[] {
  switch (quantity.kind) {
    case 'ok':
      if (quantity.grams <= 0) return ['quantity-not-positive'];
      if (quantity.grams > LINE_MAX_GRAMS) return ['quantity-too-heavy'];
      return [];
    case 'empty':
      return ['quantity-required'];
    case 'needs-mass':
      return ['mass-required'];
    case 'ambiguous':
      return ['quantity-ambiguous'];
    case 'too-precise':
      return ['quantity-too-precise'];
    case 'no-quantity':
      return ['quantity-unreadable'];
  }
}

export function assessLine(
  line: DonationLineDraft,
  receivedAt: number | null,
  shelterSpecies: readonly Species[] | null = null
): LineAssessment {
  const quantity =
    line.massKgText.trim() !== ''
      ? parseKilogramsInput(line.massKgText)
      : parseQuantityPhrase(line.quantityText);
  const qErrors = quantityErrors(quantity);
  const grams = quantity.kind === 'ok' && qErrors.length === 0 ? quantity.grams : null;

  const hazards = findFoodHazards(`${line.food} ${line.snippet ?? ''}`, shelterSpecies);
  const hazardIds = hazards.map((h) => h.hazard);
  const toxic = hasToxicHazard(hazardIds);
  const species = speciesRelevance(line.category ?? 'other', `${line.food} ${line.snippet ?? ''}`);

  const errors: DonationLineError[] = [];
  if (line.food.trim() === '') errors.push('food-required');
  if (line.includeInStock) {
    if (line.category === null) errors.push('category-required');
    errors.push(...qErrors);
  }

  const warnings: DonationLineWarning[] = [];
  if (toxic) {
    const toxicIds = hazards.filter((h) => h.severity === 'toxic').map((h) => h.hazard);
    warnings.push({ kind: line.includeInStock ? 'toxic-included' : 'toxic-excluded', hazards: toxicIds });
  }
  const caution = hazards.filter((h) => h.severity === 'caution').map((h) => h.hazard);
  if (caution.length > 0) warnings.push({ kind: 'caution', hazards: caution });
  if (quantity.kind === 'ok' && quantity.traditionalUnit !== null) {
    warnings.push({ kind: 'traditional-unit', unit: quantity.traditionalUnit });
  }
  if (grams !== null && grams > LINE_UNUSUAL_ABOVE_GRAMS) warnings.push({ kind: 'unusually-heavy', grams });
  if (receivedAt !== null) {
    const expiry = expiryWarning(line.expiresAt, receivedAt);
    if (expiry) warnings.push({ kind: expiry });
  }
  if (line.expiresAt === null && line.expiryText !== null) {
    const parsed = parseExpiryText(line.expiryText);
    if (parsed.kind === 'no-year') warnings.push({ kind: 'expiry-no-year', text: line.expiryText });
  }
  if (!species.stated && species.needsAnswer) warnings.push({ kind: 'species-unstated' });
  if (!line.grounded) warnings.push({ kind: 'not-in-text' });
  if (line.confidence === 'low') warnings.push({ kind: 'low-confidence' });
  if (!line.includeInStock && !toxic) warnings.push({ kind: 'not-stocked' });

  return { quantity, grams, hazards, toxic, species, errors, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// The donation as a whole
// ─────────────────────────────────────────────────────────────────────────────

export interface DonationDraft {
  donor: string | null;
  /** Epoch ms, local midday from the date field. */
  receivedAt: number | null;
  rawText: string;
  lines: DonationLineDraft[];
  source: 'manual' | 'llm-parsed';
  /** Model KEY, never an id. Null for a manual donation. */
  modelKey: string | null;
  notes: string | null;
}

export type DonationError =
  | 'received-required'
  | 'received-in-future'
  | 'lines-required'
  | 'too-many-lines'
  | 'text-too-long'
  /** At least one line has its own errors, shown on the line. */
  | 'lines-invalid';

export interface DonationReview {
  errors: DonationError[];
  lines: LineAssessment[];
  /** Hazards the typed text names that no line carries. */
  missingHazards: HazardFinding[];
  /** Lines that will add to the pantry. */
  stockedCount: number;
}

export function reviewDonation(
  draft: DonationDraft,
  shelterSpecies: readonly Species[] | null = null,
  now: number = Date.now()
): DonationReview {
  const lines = draft.lines.map((line) => assessLine(line, draft.receivedAt, shelterSpecies));
  const errors: DonationError[] = [];

  if (draft.receivedAt === null) errors.push('received-required');
  else if (draft.receivedAt > now + CLOCK_SKEW_TOLERANCE_MS) errors.push('received-in-future');
  if (draft.lines.length === 0) errors.push('lines-required');
  if (draft.lines.length > DONATION_MAX_LINES) errors.push('too-many-lines');
  if (draft.rawText.length > DONATION_TEXT_MAX_CHARS) errors.push('text-too-long');
  if (lines.some((line) => line.errors.length > 0)) errors.push('lines-invalid');

  const missingHazards = hazardsMissingFromLines(
    draft.rawText,
    draft.lines.map((line) => `${line.food} ${line.snippet ?? ''}`),
    shelterSpecies
  );

  const stockedCount = draft.lines.filter((line, i) => line.includeInStock && lines[i]!.grams !== null).length;
  return { errors, lines, missingHazards, stockedCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// What gets written
// ─────────────────────────────────────────────────────────────────────────────

/** A donation line ready for the writer, with the expiry still in epoch ms. */
export interface DonationLineOut {
  food: string;
  category: FoodCategory;
  quantityText: string;
  grams: number | null;
  inStock: boolean;
  expiresAt: number | null;
  hazards: FoodHazard[];
  species: Species[];
  snippet: string | null;
  confidence: ParseConfidence | null;
}

/** One positive ledger entry per stocked line. */
export interface LedgerAddition {
  lineIndex: number;
  category: FoodCategory;
  label: string;
  deltaG: number;
  expiresAt: number | null;
}

/**
 * The lines and the ledger additions for a donation that has NO errors.
 *
 * ⚠️ Throws on an invalid review rather than writing a partial pantry.
 * `food-admin.ts` calls this after validating; the throw is the backstop for a
 * caller that forgot, for the same reason `measurements-admin.ts` re-validates.
 */
export function donationWrite(
  draft: DonationDraft,
  review: DonationReview
): { lines: DonationLineOut[]; additions: LedgerAddition[] } {
  if (review.errors.length > 0) {
    throw new Error(`food-parse: invalid donation (${review.errors.join(', ')})`);
  }
  const lines: DonationLineOut[] = [];
  const additions: LedgerAddition[] = [];

  draft.lines.forEach((line, index) => {
    const assessment = review.lines[index]!;
    const inStock = line.includeInStock && assessment.grams !== null && line.category !== null;
    const quantityText =
      line.massKgText.trim() !== '' ? `${line.massKgText.trim()} kg` : line.quantityText.trim();

    lines.push({
      food: line.food.trim().slice(0, FOOD_NAME_MAX_CHARS),
      category: line.category ?? 'other',
      quantityText,
      grams: assessment.grams,
      inStock,
      expiresAt: line.expiresAt,
      hazards: assessment.hazards.map((h) => h.hazard),
      species: assessment.species.species,
      snippet: line.snippet,
      confidence: line.confidence,
    });

    if (inStock) {
      additions.push({
        lineIndex: index,
        category: line.category!,
        label: line.food.trim().slice(0, FOOD_NAME_MAX_CHARS),
        deltaG: assessment.grams!,
        expiresAt: line.expiresAt,
      });
    }
  });

  return { lines, additions };
}
