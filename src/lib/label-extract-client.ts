import type { User } from 'firebase/auth';

import type { FieldEvidence } from './types';
import type { LabelField, LabelFill, LabelOffer } from './label-extraction';
import type { MedicalRecordDraft } from './medical';
import type { LabelProvenance } from './medical-admin';

/**
 * The browser side of `POST /api/medical/labels/extract`. Plan C4.
 *
 * ⚠️ Every failure the route writes carries `X-Label-Failure`, and its ABSENCE
 * on a 5xx means the edge answered instead of us — nearly always Firebase
 * Hosting's 60 s ceiling, which answers 503, the same status a route uses for
 * "no API key". A status is only ours to interpret when we wrote it. Defined
 * here, next to the reader, and imported by the route, so a rename cannot
 * split them. Same contract as `card-extract-client.ts`.
 */
export const LABEL_FAILURE_HEADER = 'X-Label-Failure';

/** Every failure the route can stamp. A wire contract: rename deliberately. */
export type LabelRouteError =
  | 'unauthenticated'
  | 'forbidden'
  | 'ai-not-configured'
  | 'storage-not-configured'
  | 'bad-request'
  | 'pet-not-found'
  | 'label-not-found'
  | 'label-too-large'
  | 'label-unsupported'
  | 'extract-timeout'
  | 'extract-failed';

/** What the route returns on success. Nothing has been written anywhere. */
export interface LabelExtractSuccess {
  /** The model said the photo is not a vaccine or medicine label. */
  notALabel: boolean;
  /** Prefilled into the form. Null wherever a value was withheld. */
  fill: LabelFill;
  /** Offered beside an empty field, accepted with one tap. */
  offer: LabelOffer;
  /** What was read for every field, for the person and for the saved record. */
  evidence: Record<LabelField, FieldEvidence> | null;
  /** Prefilled fields to show with their snippet. */
  highlighted: Array<keyof LabelFill>;
  /** The stable model KEY, for `extractedByModel`. */
  modelKey: string;
  /** The label photo's Storage path, for `sourceDocument`. */
  path: string;
}

/** What the form needs to say. Coarser than the route's codes on purpose. */
export type LabelExtractFailure =
  | 'not-configured'
  | 'unauthorized'
  | 'photo-rejected'
  | 'pet-missing'
  /** The model did not answer in time, or the edge gave up. RETRYABLE. */
  | 'timeout'
  | 'failed';

export interface LabelExtractOutcome {
  result: LabelExtractSuccess | null;
  failure: LabelExtractFailure | null;
}

/**
 * Which failure a non-OK response is. Pure, and exported so it is tested.
 *
 * ⚠️ An UNSTAMPED 5xx is the edge, never us, and is reported as a retryable
 * timeout — not as "not configured".
 */
export function classifyLabelFailure(status: number, stamped: string | null): LabelExtractFailure {
  if (stamped === null) {
    if (status >= 500) return 'timeout';
    if (status === 401 || status === 403) return 'unauthorized';
    return 'failed';
  }
  switch (stamped as LabelRouteError) {
    case 'ai-not-configured':
    case 'storage-not-configured':
      return 'not-configured';
    case 'unauthenticated':
    case 'forbidden':
      return 'unauthorized';
    case 'bad-request':
    case 'label-not-found':
    case 'label-too-large':
    case 'label-unsupported':
      return 'photo-rejected';
    case 'pet-not-found':
      return 'pet-missing';
    case 'extract-timeout':
      return 'timeout';
    default:
      return 'failed';
  }
}

const FAILED: LabelExtractOutcome = { result: null, failure: 'failed' };

/**
 * Ask the server to read a label photo that is ALREADY in Storage.
 *
 * Sends a path, not the photo: the photo went straight from the phone to
 * Storage, so this request is tiny and Hosting's whole window is left for the
 * model rather than spent on a phone's uplink.
 */
export async function requestLabelExtraction(
  user: User,
  petId: string,
  path: string
): Promise<LabelExtractOutcome> {
  try {
    const token = await user.getIdToken();
    const res = await fetch('/api/medical/labels/extract', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ petId, path }),
    });
    if (res.ok) return { result: (await res.json()) as LabelExtractSuccess, failure: null };
    return {
      result: null,
      failure: classifyLabelFailure(res.status, res.headers.get(LABEL_FAILURE_HEADER)),
    };
  } catch {
    return FAILED;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// What a reading does to the form, and what a save records — pure, tested
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The form fields a reading changes: ONLY the prefilled values it actually
 * read. A field the label left empty keeps what the person typed, and the lot
 * is never here — it is offered, never filled. Nothing for a non-label.
 */
export function formPatchFromLabel(
  result: LabelExtractSuccess
): Partial<Pick<MedicalRecordDraft, 'product' | 'manufacturer' | 'productExpiresAt'>> {
  if (result.notALabel) return {};
  const patch: Partial<Pick<MedicalRecordDraft, 'product' | 'manufacturer' | 'productExpiresAt'>> = {};
  if (result.fill.product !== null) patch.product = result.fill.product;
  if (result.fill.manufacturer !== null) patch.manufacturer = result.fill.manufacturer;
  if (result.fill.productExpiresAt !== null) patch.productExpiresAt = result.fill.productExpiresAt;
  return patch;
}

/**
 * What a save records about the scan: the label photo, the model, and what it
 * read. Null when there is nothing to attribute — no scan, or a photo the model
 * said is not a label — so the record is saved as typed by hand.
 */
export function labelProvenanceFrom(
  scan: { result: LabelExtractSuccess; readAt: number } | null
): LabelProvenance | null {
  if (scan === null || scan.result.notALabel || scan.result.evidence === null) return null;
  return {
    sourceDocument: scan.result.path,
    modelKey: scan.result.modelKey,
    evidence: scan.result.evidence,
    extractedAt: scan.readAt,
  };
}
