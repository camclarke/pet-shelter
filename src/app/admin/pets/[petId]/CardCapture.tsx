'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import type { User } from 'firebase/auth';

import { t } from '@/i18n';
import { AnalysisProgress } from '@/app/admin/intake/AnalysisProgress';
import { CARD_PHOTO_MAX_EDGE } from '@/lib/card-extraction';
import { requestCardExtraction, type CardExtractOutcome } from '@/lib/card-extract-client';
import { uploadCardPhoto } from '@/lib/medical-admin';
import { PhotoUnreadableError, stripAndResize } from '@/lib/pets-admin';

/**
 * Photograph a vaccination or deworming card, and have it read into
 * UNCONFIRMED medical records. Build-order step 9, plan §4.3.
 *
 * ── The order is the privacy design ─────────────────────────────────────────
 *   1. `stripAndResize` re-encodes the photo in the browser, dropping EXIF —
 *      a card photographed in a foster home carries that home's GPS.
 *   2. `uploadCardPhoto` stores it at `medical/{petId}/card-{uuid}.jpg`, which
 *      the deployed rules serve to admins only, with no download URL.
 *   3. `requestCardExtraction` sends the route a PATH, not the photo, so the
 *      request through Firebase Hosting is tiny and the whole 60 s is left for
 *      the model instead of a phone's uplink.
 *
 * ── Retry without re-uploading ──────────────────────────────────────────────
 * The card is kept once stored, so "Leer otra vez" re-asks the route about
 * the same object. The route refuses a card that already produced records, so
 * a retry after a lost response cannot duplicate them.
 *
 * ── The same input pattern as intake ────────────────────────────────────────
 * Two VISUALLY hidden inputs, one with `capture="environment"`, opened by
 * buttons. Never `hidden`/display:none: Chrome 130+ does not deliver the change
 * event to a programmatic click on a hidden input, silently. See
 * GuidedPhotoCapture.tsx and `.visually-hidden` in globals.css.
 */

type Phase = 'idle' | 'uploading' | 'reading';

export interface CardCaptureNotice {
  text: string;
  tone: 'ok' | 'warn' | 'error';
}

export interface CardCaptureProps {
  petId: string;
  user: User | null;
  disabled: boolean;
  /**
   * Called after EVERY attempt, success or not. The panel reloads the medical
   * history then, because the history is the truth: a response lost at the
   * edge may have been written anyway.
   */
  onSettled: (notice: CardCaptureNotice) => void;
}

export default function CardCapture({ petId, user, disabled, onSettled }: CardCaptureProps) {
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const galleryRef = useRef<HTMLInputElement | null>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [storedPath, setStoredPath] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);

  const busy = phase !== 'idle';
  const locked = disabled || busy || !user;

  function report(outcome: CardExtractOutcome) {
    if (outcome.result) {
      setCanRetry(false);
      onSettled({
        text: t.cardExtractSummary(outcome.result),
        tone: outcome.result.written > 0 ? 'ok' : 'warn',
      });
      return;
    }
    const failure = outcome.failure ?? 'failed';
    // Only what a second attempt could fix is offered again.
    setCanRetry(failure === 'timeout' || failure === 'failed');
    onSettled({
      text: t.cardExtractFailure(failure),
      tone: failure === 'already-extracted' ? 'warn' : 'error',
    });
  }

  async function extract(path: string) {
    if (!user) return;
    setPhase('reading');
    const outcome = await requestCardExtraction(user, petId, path);
    setPhase('idle');
    report(outcome);
  }

  async function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Cleared so picking the same file again still fires `change`.
    event.target.value = '';
    if (!file || !user) return;

    setPhase('uploading');
    setCanRetry(false);

    let path: string;
    try {
      const processed = await stripAndResize(file, CARD_PHOTO_MAX_EDGE);
      path = await uploadCardPhoto(petId, processed);
    } catch (caught) {
      console.error('[card-capture] could not store the card', caught);
      setPhase('idle');
      onSettled({
        text:
          caught instanceof PhotoUnreadableError
            ? t.medicalReview.captureUnreadable
            : t.medicalReview.captureUploadFailed,
        tone: 'error',
      });
      return;
    }

    setStoredPath(path);
    await extract(path);
  }

  return (
    <div className="admin-suggest card-capture">
      <h3 className="t-label">{t.medicalReview.captureTitle}</h3>
      <p className="admin__sub">{t.medicalReview.captureHint}</p>

      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="visually-hidden"
        aria-hidden="true"
        tabIndex={-1}
        disabled={locked}
        onChange={(event) => void handleChange(event)}
      />
      <input
        ref={galleryRef}
        type="file"
        accept="image/*"
        className="visually-hidden"
        aria-hidden="true"
        tabIndex={-1}
        disabled={locked}
        onChange={(event) => void handleChange(event)}
      />

      <div className="admin-suggest__actions">
        <button
          type="button"
          className="btn"
          disabled={locked}
          onClick={() => cameraRef.current?.click()}
        >
          {t.medicalReview.captureTakePhoto}
        </button>
        <button
          type="button"
          className="btn btn--muted"
          disabled={locked}
          onClick={() => galleryRef.current?.click()}
        >
          {t.medicalReview.captureGallery}
        </button>
        {canRetry && storedPath && (
          <button
            type="button"
            className="btn btn--muted"
            disabled={locked}
            onClick={() => void extract(storedPath)}
          >
            {t.medicalReview.captureRetry}
          </button>
        )}
      </div>

      {phase === 'uploading' && (
        <p className="auth__hint" role="status">
          {t.medicalReview.captureUploading}
        </p>
      )}

      {/* The same honest clock intake uses: elapsed time against the budget the
          route really has, never invented progress. */}
      {phase === 'reading' && (
        <AnalysisProgress
          photoCount={1}
          title={t.medicalReview.captureReading}
          savedNote={t.medicalReview.captureSavedNote}
        />
      )}
    </div>
  );
}
