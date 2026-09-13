/**
 * Medical CANDIDATES: what a model read, before a person has confirmed it.
 * The PURE layer — no Firestore, no AI, no Spanish. Build-order step 9, and
 * the layer step 11 (dictation) reuses.
 *
 * ═══ A NEW TIER IS A NEW DOCUMENT ═══════════════════════════════════════════
 * A model's reading lives at `pets/{petId}/medicalCandidates/{id}`, which
 * `firestore.rules` serves to admins only — never inside `pets/{petId}/medical`,
 * which any signed-in account can read. Decided after the step-9 evaluation,
 * 2026-09-13: writing unconfirmed records into `medical` put an unchecked model
 * guess at the same read tier as the history an adopter reads, with nothing in
 * the rule to tell the two apart.
 *
 * So "unconfirmed" is a LOCATION, not a field value. A computation over
 * `medical` cannot pick a candidate up because a candidate is not there, and no
 * future non-admin reader of `medical` has to remember a filter to stay out of
 * model guesses. The `isConfirmed()` gate inside `medical.ts` stays as defence
 * in depth.
 *
 * ═══ CONFIRMING IS THE ONLY WAY INTO `medical` ══════════════════════════════
 * `planConfirmation()` validates the values a person accepted and assembles
 * the record. `confirmMedicalRecord()` in `medical-admin.ts` refuses to write
 * unless it succeeds, then creates the record and deletes the candidate in one
 * transaction. Completeness is enforced by the function that writes, not by
 * whichever button called it — step 11 calls it from a different screen.
 */

import type { FieldEvidence, MedicalExtractionSource, MedicalRecordKind } from './types';
import {
  medicalEditFields,
  validateMedicalDraft,
  type MedicalError,
  type MedicalRecordDraft,
} from './medical';

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic ids
// ─────────────────────────────────────────────────────────────────────────────

/** A source file's stem: letters, digits and dashes, as a uuid-based name is. */
const SOURCE_STEM = /^[A-Za-z0-9-]{8,80}$/;

/** More candidates than any source yields. `CARD_MAX_ROWS` is 20. */
export const MAX_CANDIDATE_INDEX = 99;

/**
 * The document id of the `index`-th candidate read from `sourceDocument`:
 * `{file stem}-{index}`, e.g. `card-0f8e2c1a-…-0`.
 *
 * ⚠️ DETERMINISTIC, and that is the idempotency guarantee. The server writes
 * candidates create-if-absent, so a second extraction of the same source —
 * a retry after a response lost at the edge, or two requests racing past the
 * "already read?" check — collides on these ids and is refused atomically,
 * instead of writing every row twice. Closes the step-9 evaluation's TOCTOU
 * finding.
 */
export function candidateIdFor(sourceDocument: string, index: number): string {
  const fileName = sourceDocument.split('/').pop() ?? '';
  const stem = fileName.replace(/\.[A-Za-z0-9]+$/, '');
  if (!SOURCE_STEM.test(stem)) {
    throw new Error('medical-candidates: the source document has no usable file stem');
  }
  if (!Number.isInteger(index) || index < 0 || index > MAX_CANDIDATE_INDEX) {
    throw new Error('medical-candidates: candidate index out of range');
  }
  return `${stem}-${index}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// What a candidate stores
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every stored field of a candidate, dates in epoch ms. The server writer
 * converts the dates and adds `extractedAt`; its write type is derived from
 * `MedicalCandidate`, so the two cannot drift.
 *
 * ⚠️ No `confirmedBy`, no `confirmedAt`, no `source`. A candidate is
 * unconfirmed by where it is, not by a value someone could set.
 */
export interface CandidateFields {
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
  sourceDocument: string;
  extractedByModel: string;
  extractedFrom: MedicalExtractionSource;
  extractionEvidence: Record<string, FieldEvidence>;
  /** Position among what the source yielded; with the file stem, the document id. */
  sourceIndex: number;
  /** The admin who asked for the extraction. */
  recordedBy: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Confirmation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a confirmation copies from the CANDIDATE. Never from the form: the form
 * cannot carry a model key, and a confirmed record must still say what it was
 * read from and by which model.
 *
 * Nullable because a candidate is read back from Firestore defensively.
 */
export interface CandidateProvenance {
  sourceDocument: string | null;
  extractedByModel: string | null;
  extractedFrom: MedicalExtractionSource | null;
  extractionEvidence: Record<string, FieldEvidence> | null;
  extractedAt: number | null;
  recordedBy: string;
}

/** Every stored field of the record a confirmation creates, dates in epoch ms. */
export interface ConfirmedRecordFields {
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
  codes: string[];
  source: 'llm-extracted';
  confirmedBy: string;
  sourceDocument: string | null;
  extractedByModel: string | null;
  extractedFrom: MedicalExtractionSource | null;
  extractionEvidence: Record<string, FieldEvidence> | null;
  extractedAt: number | null;
  recordedBy: string;
}

export type ConfirmationPlan =
  | { ok: true; record: ConfirmedRecordFields }
  | { ok: false; errors: MedicalError[] };

/**
 * Can this candidate be confirmed with these values, and if so, what record?
 *
 * VALUES come from `draft` — what the person accepted, edited or not.
 * PROVENANCE comes from `candidate`. A draft that fails
 * `validateMedicalDraft()` — no date, no kind, a date in the future — is
 * refused with the reasons, and nothing is assembled.
 *
 * ⚠️ A blank reviewer THROWS rather than returning an error: it is a
 * programming mistake, not something a person can fix in the form, and a
 * record confirmed by nobody would read as unconfirmed to `isConfirmed()`.
 */
export function planConfirmation(
  candidate: CandidateProvenance,
  draft: MedicalRecordDraft,
  reviewer: string,
  now: number = Date.now()
): ConfirmationPlan {
  const confirmer = reviewer.trim();
  if (confirmer === '') {
    throw new Error('medical-candidates: a confirmation needs a named reviewer');
  }

  const errors = validateMedicalDraft(draft, now);
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    record: {
      ...medicalEditFields(draft),
      codes: [],
      source: 'llm-extracted',
      confirmedBy: confirmer,
      sourceDocument: candidate.sourceDocument,
      extractedByModel: candidate.extractedByModel,
      extractedFrom: candidate.extractedFrom,
      extractionEvidence: candidate.extractionEvidence,
      extractedAt: candidate.extractedAt,
      recordedBy: candidate.recordedBy,
    },
  };
}

/** Thrown by `confirmMedicalRecord()` when the values are not a complete record. */
export class MedicalConfirmationError extends Error {
  readonly errors: readonly MedicalError[];

  constructor(errors: readonly MedicalError[]) {
    super(`medical-candidates: not confirmable (${errors.join(', ')})`);
    this.name = 'MedicalConfirmationError';
    this.errors = errors;
  }
}

/** Thrown when the candidate was already confirmed or discarded by someone else. */
export class CandidateGoneError extends Error {
  constructor() {
    super('medical-candidates: the candidate no longer exists');
    this.name = 'CandidateGoneError';
  }
}

/**
 * Is this the error a create-if-absent write returns when the document exists?
 *
 * The Admin SDK reports gRPC status 6 (ALREADY_EXISTS) as a numeric `code`;
 * the Web SDK as the string `'already-exists'`. Matched on the code first and
 * the provider's message only as a fallback.
 */
export function isAlreadyExistsError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code === 6 || e.code === 'already-exists') return true;
  return typeof e.message === 'string' && e.message.includes('ALREADY_EXISTS');
}

/** Newest source first, and a source's rows in the order they were read. */
export function inReviewOrder<
  T extends { extractedAt: number | null; sourceDocument: string | null; sourceIndex: number },
>(candidates: readonly T[]): T[] {
  return [...candidates].sort((a, b) => {
    const at = a.extractedAt ?? 0;
    const bt = b.extractedAt ?? 0;
    if (at !== bt) return bt - at;
    const as = a.sourceDocument ?? '';
    const bs = b.sourceDocument ?? '';
    if (as !== bs) return as < bs ? -1 : 1;
    return a.sourceIndex - b.sourceIndex;
  });
}
