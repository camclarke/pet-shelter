'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import type { User } from 'firebase/auth';

import { t } from '@/i18n';
import { AnalysisProgress } from '@/app/admin/intake/AnalysisProgress';
import { LABEL_PHOTO_MAX_EDGE } from '@/lib/label-extraction';
import { requestLabelExtraction, type LabelExtractSuccess } from '@/lib/label-extract-client';
import { uploadLabelPhoto } from '@/lib/medical-admin';
import { PhotoUnreadableError, stripAndResize } from '@/lib/pets-admin';

/**
 * "Escanear etiqueta": photograph the vial's sticker while the dose is being
 * given, and fill the medical form from it. Plan C4.
 *
 * ── It FILLS THE FORM; it writes nothing ─────────────────────────────────────
 * A card produces many rows read later, so the card reader queues candidates.
 * A label is one dose with the person standing there typing it, so the scan
 * hands its values to the form and the person saving the form is the
 * confirmation. Closing the form keeps nothing but the photo.
 *
 * ── The order is the privacy design (the card capture's) ────────────────────
 *   1. `stripAndResize` re-encodes in the browser, dropping EXIF (GPS).
 *   2. `uploadLabelPhoto` stores it at `medical/{petId}/label-{uuid}.jpg`,
 *      admin-only by the deployed rules, with no download URL.
 *   3. `requestLabelExtraction` sends the route a PATH, not the photo.
 *
 * ── The same input pattern as the card capture ──────────────────────────────
 * Two VISUALLY hidden inputs, one with `capture="environment"`, opened by
 * buttons. Never `hidden`/display:none: Chrome 130+ silently drops the change
 * event of a programmatic click on a hidden input.
 */

type Phase = 'idle' | 'uploading' | 'reading';

export interface LabelScanNotice {
  text: string;
  tone: 'ok' | 'warn' | 'error';
}

export interface LabelScanProps {
  petId: string;
  user: User | null;
  disabled: boolean;
  /** A reading arrived. The panel decides what reaches the form. */
  onRead: (result: LabelExtractSuccess, readAt: number) => void;
}

export default function LabelScan({ petId, user, disabled, onRead }: LabelScanProps) {
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const galleryRef = useRef<HTMLInputElement | null>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [storedPath, setStoredPath] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  // Shown right under the buttons, not at the top of the panel: on a phone the
  // panel's notice is scrolled out of sight by the time the form is open.
  const [notice, setNotice] = useState<LabelScanNotice | null>(null);

  const busy = phase !== 'idle';
  const locked = disabled || busy || !user;

  async function read(path: string) {
    if (!user) return;
    setPhase('reading');
    const outcome = await requestLabelExtraction(user, petId, path);
    setPhase('idle');

    if (outcome.result) {
      setCanRetry(false);
      const result = outcome.result;
      onRead(result, Date.now());
      const filled = Object.values(result.fill).filter((v) => v !== null).length;
      setNotice({
        text: t.labelScanSummary({
          notALabel: result.notALabel,
          filled,
          lotOffered: result.offer.batch !== null,
        }),
        tone: result.notALabel || (filled === 0 && result.offer.batch === null) ? 'warn' : 'ok',
      });
      return;
    }
    const failure = outcome.failure ?? 'failed';
    // Only what a second attempt could fix is offered again.
    setCanRetry(failure === 'timeout' || failure === 'failed');
    setNotice({ text: t.labelScanFailure(failure), tone: 'error' });
  }

  async function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Cleared so picking the same file again still fires `change`.
    event.target.value = '';
    if (!file || !user) return;

    setPhase('uploading');
    setCanRetry(false);
    setNotice(null);

    let path: string;
    try {
      const processed = await stripAndResize(file, LABEL_PHOTO_MAX_EDGE);
      path = await uploadLabelPhoto(petId, processed);
    } catch (caught) {
      console.error('[label-scan] could not store the label', caught);
      setPhase('idle');
      setNotice({
        text: caught instanceof PhotoUnreadableError ? t.labelScan.unreadable : t.labelScan.uploadFailed,
        tone: 'error',
      });
      return;
    }

    setStoredPath(path);
    await read(path);
  }

  return (
    <div className="admin-suggest label-scan">
      <h3 className="t-label">{t.labelScan.title}</h3>
      <p className="admin__sub">{t.labelScan.hint}</p>

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
        <button type="button" className="btn" disabled={locked} onClick={() => cameraRef.current?.click()}>
          {t.labelScan.takePhoto}
        </button>
        <button
          type="button"
          className="btn btn--muted"
          disabled={locked}
          onClick={() => galleryRef.current?.click()}
        >
          {t.labelScan.gallery}
        </button>
        {canRetry && storedPath && (
          <button
            type="button"
            className="btn btn--muted"
            disabled={locked}
            onClick={() => void read(storedPath)}
          >
            {t.labelScan.retry}
          </button>
        )}
      </div>

      {notice && phase === 'idle' && (
        <p className={notice.tone === 'error' ? 'auth__error' : 'auth__notice'} role="status">
          {notice.text}
        </p>
      )}

      {phase === 'uploading' && (
        <p className="auth__hint" role="status">
          {t.labelScan.uploading}
        </p>
      )}

      {/* The intake clock: elapsed time against the route's real budget, never
          invented progress. */}
      {phase === 'reading' && (
        <AnalysisProgress photoCount={1} title={t.labelScan.reading} savedNote={t.labelScan.savedNote} />
      )}
    </div>
  );
}
