/**
 * The review gate for records a MODEL produced. PURE: no Firestore, no AI,
 * no Spanish, so every rule in it is unit-tested and break-probed.
 *
 * Plan §4.8, "the review gate is not optional". Everything Gemini produces is
 * VISIBLE in the admin UI and EXCLUDED from everything that computes — due
 * dates, rabies validity, any "vacunado" signal, anything public — until a
 * human confirms it, one record at a time.
 *
 * ⚠️ Since the step-9 evaluation (2026-09-13) the exclusion is first of all a
 * LOCATION: a model's reading is a candidate in the admin-only
 * `pets/{petId}/medicalCandidates`, and only a confirmation creates a record in
 * `medical` — see `medical-candidates.ts`. The predicate below is DEFENCE IN
 * DEPTH over `medical`: it still decides what counts for any record that
 * reaches a computing function without a named confirmer.
 *
 * Built for vaccination cards (step 9) and designed to be reused as-is by
 * veterinary dictation (step 11). Nothing here knows what a card is.
 *
 * ═══ FAILURE DIRECTION: TOWARD EXCLUDED ═════════════════════════════════════
 * Playbook §6.2. This is a persistence gate into a medical record, so it fails
 * toward DROPPING. The predicate asks exactly one question — has a named human
 * vouched for this record? — and anything that is not plainly "yes" is "no":
 * a null, an empty string, whitespace, a missing field on a malformed document.
 *
 * `source` is deliberately NOT consulted. A manual record counts because the
 * create path stamps `confirmedBy` with its author, not because it says
 * "manual". Keying on `source` would make a writer bug that forgot to null
 * `confirmedBy` on an extracted record — or a document missing `source`, which
 * the reader defaults to 'manual' — silently count. One predicate, on the one
 * field that means "a person checked this".
 *
 * ═══ WHY THE GATE LIVES INSIDE THE COMPUTING FUNCTIONS ══════════════════════
 * A gate that every caller must remember is a gate that gets forgotten. So
 * `nextDue`, `recordSignals` and `summarizeMedicalHistory` in `medical.ts` call
 * `isConfirmed` themselves; a caller holding a mixed list cannot get an
 * unconfirmed record into a result by forgetting to filter first.
 */

import type { FieldEvidence, WithheldReason } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// The predicate
// ─────────────────────────────────────────────────────────────────────────────

/** Anything that can be confirmed. Deliberately just the one field. */
export interface Confirmable {
  confirmedBy: string | null;
}

/** Has a named human vouched for this record? Fails toward NO. */
export function isConfirmed(record: Confirmable): boolean {
  const by = (record as { confirmedBy?: unknown }).confirmedBy;
  return typeof by === 'string' && by.trim().length > 0;
}

/** The records that count for computation, in their original order. */
export function confirmedOnly<T extends Confirmable>(records: readonly T[]): T[] {
  return records.filter(isConfirmed);
}

/** The records a human still has to look at, in their original order. */
export function awaitingReview<T extends Confirmable>(records: readonly T[]): T[] {
  return records.filter((record) => !isConfirmed(record));
}

/**
 * Who a confirmation is attributed to. The same convention `recordedBy` has
 * always used — email when there is one, uid otherwise — so the two read alike
 * in the history.
 */
export function reviewerLabel(user: { email?: string | null; uid: string }): string {
  return user.email?.trim() || user.uid;
}

/**
 * Can this record be confirmed as it stands, in one click?
 *
 * `errors` are STRUCTURAL problems — a record with no date is not a record —
 * and they block. `extraBlockers` exist for a caller whose policy adds its own:
 * step 11's `BLOCK_ON_CRITICAL_DISAGREEMENT` is the reason the second list is
 * here. Warnings are deliberately NOT a parameter. They never block; the
 * shelter is often recording something that already happened.
 */
export function canConfirmAsIs(
  errors: readonly unknown[],
  extraBlockers: readonly unknown[] = [],
): boolean {
  return errors.length === 0 && extraBlockers.length === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Evidence: what to prefill, what to highlight
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A model's confidence, or 0 when it is not a usable number.
 *
 * ⚠️ Out of range is 0, not clamped. A model answering 95 has not said "95%";
 * it has ignored the 0..1 contract, and guessing what it meant is exactly the
 * kind of repair this path must not make. 0 withholds the field, which costs
 * one manual entry.
 */
export function sanitizeConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  if (value < 0 || value > 1) return 0;
  return value;
}

export interface EvidenceThresholds {
  /** At or above this a value is copied into its field. Below it, the field is left empty. */
  prefillMin: number;
  /** Below this a copied value is shown with its snippet beside it. */
  highlightBelow: number;
}

export type EvidenceVerdict = 'prefill' | 'prefill-highlighted' | 'withhold';

/**
 * Should a model's reading of one field be copied into the form?
 *
 * Confidence decides PREFILL, never COUNTING: a prefilled value still counts
 * for nothing until the record is confirmed. What a threshold buys is how much
 * a reviewer has to type against how much they are tempted to accept unread.
 */
export function evidenceVerdict(
  evidence: Pick<FieldEvidence, 'snippet' | 'confidence'>,
  thresholds: EvidenceThresholds,
): EvidenceVerdict {
  const snippet = typeof evidence.snippet === 'string' ? evidence.snippet.trim() : '';
  if (snippet === '') return 'withhold';
  const confidence = sanitizeConfidence(evidence.confidence);
  if (confidence < thresholds.prefillMin) return 'withhold';
  return confidence < thresholds.highlightBelow ? 'prefill-highlighted' : 'prefill';
}

const WITHHELD_REASONS: readonly WithheldReason[] = [
  'low-confidence',
  'unreadable-date',
  'implausible-date',
  'too-long',
  'disputed',
];

/**
 * Read an evidence map back from a stored document, defensively.
 *
 * The document is data a model shaped, round-tripped through Firestore, so
 * nothing about its shape is trusted: a non-string snippet becomes null, an
 * unusable confidence becomes 0, an unknown reason becomes null. Returns null
 * for a record that carries no evidence at all — a manual one.
 */
export function readEvidence(value: unknown): Record<string, FieldEvidence> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;

  const out: Record<string, FieldEvidence> = {};
  for (const [field, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    out[field] = {
      snippet: typeof entry.snippet === 'string' ? entry.snippet : null,
      confidence: sanitizeConfidence(entry.confidence),
      withheld: WITHHELD_REASONS.includes(entry.withheld as WithheldReason)
        ? (entry.withheld as WithheldReason)
        : null,
    };
  }
  return out;
}
