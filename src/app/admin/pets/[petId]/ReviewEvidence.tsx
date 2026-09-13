'use client';

import { useMemo } from 'react';

import { t } from '@/i18n';
import { PetPhoto } from '@/app/admin/intake/PetPhoto';
import { evidenceVerdict, type EvidenceThresholds } from '@/lib/review-gate';
import type { FieldEvidence } from '@/lib/types';

/**
 * The review-gate UI a model-extracted medical record needs. Build-order
 * step 9, plan §4.8.
 *
 * Shared, deliberately: step 11 (veterinary dictation) writes the same kind of
 * unconfirmed record into the same collection, and a dictated dose must be
 * shown to its reviewer the same way a card date is — the literal reading
 * beside the value — or the two will drift into two different ideas of what
 * "unconfirmed" looks like. Only the thresholds differ, and they are passed in.
 */

/** The badge on a record nobody has confirmed yet. */
export function UnconfirmedBadge() {
  return <span className="review-badge">{t.medicalReview.unconfirmedBadge}</span>;
}

/**
 * Thresholds for a record whose source has no policy of its own: EVERYTHING
 * is flagged. A reviewer shown too much evidence spends a few seconds; one
 * shown too little accepts a reading nobody compared with anything.
 */
export const REVIEW_EVERYTHING: EvidenceThresholds = { prefillMin: 1, highlightBelow: 1 };

export interface EvidenceHintProps {
  /** The field's name, when the line is not already under its own label. */
  label?: string;
  evidence: FieldEvidence | undefined;
  thresholds: EvidenceThresholds;
  /**
   * Show the reading even when it is confident. For a DATE: the value on
   * screen is our parse, and the snippet is the only evidence for it.
   */
  always?: boolean;
}

/**
 * What a model read for one field, beside the field.
 *
 * Flagged — highlighted — when the value was left empty, or when it was
 * copied at a confidence below the highlight bar. Otherwise nothing, unless
 * `always`: a confident product name needs no second line.
 */
export function EvidenceHint({ label, evidence, thresholds, always = false }: EvidenceHintProps) {
  if (!evidence) return null;
  const flagged =
    evidence.withheld !== null || evidenceVerdict(evidence, thresholds) !== 'prefill';
  if (!flagged && !always) return null;
  // An absent field that nobody needs to act on is noise, not evidence.
  if (!flagged && evidence.snippet === null) return null;
  if (flagged && evidence.snippet === null && evidence.withheld === null) return null;

  return (
    <span className={`evidence${flagged ? ' evidence--flag' : ''}`}>
      {label ? <strong>{label}: </strong> : null}
      {t.evidenceLine(evidence)}
    </span>
  );
}

/**
 * The source document — a card photo — read through the Storage SDK with the
 * admin's own token. Never a download URL: see `uploadCardPhoto`.
 *
 * ⚠️ The media object is memoised on the path. `PetPhoto` re-reads whenever
 * the object it is given changes identity, so an inline `{ path, url: '' }`
 * would fetch, set state, re-render, and fetch again forever.
 */
export function SourceDocumentImage({ path, alt }: { path: string; alt: string }) {
  const media = useMemo(() => ({ path, url: '' }), [path]);
  return (
    <div className="review-card">
      <PetPhoto media={media} alt={alt} />
    </div>
  );
}
