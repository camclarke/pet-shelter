/**
 * The identity-card photo, on the applicant's side (portion 4c-2, plan §5.3):
 * choose it, check it in the browser, preview it — and, after the application
 * exists, send it to the upload route.
 *
 *   - `useIdPhoto`        the state: one prepared photo, its preview URL, its
 *                         problem. The URL is revoked when the photo is
 *                         replaced and when the owner unmounts.
 *   - `IdPhotoPickerView` PRESENTATIONAL: the two pickers, the preview, the
 *                         errors. Renders to static HTML for the 360px check.
 *   - `IdPhotoUploader`   for an application that already exists ("Falta tu
 *                         carnet", in /account and on the apply page): pick,
 *                         check, then "Subir esta foto".
 *
 * ═══ THE PICKERS ARE LABELS AROUND VISUALLY-HIDDEN INPUTS ══════════════════
 * Never `hidden` / display:none: Chrome 130+ does not deliver the change event
 * to a programmatic click on a hidden input — the picker opens, a photo is
 * chosen, and nothing arrives, silently (`CardCapture.tsx`, `.visually-hidden`
 * in globals.css). A <label> around the input opens the native picker from the
 * person's own tap, and keeps the input focusable for a keyboard.
 *
 * ═══ NEVER STORAGE, NEVER A TOKEN ══════════════════════════════════════════
 * Nothing here imports Firebase Storage: the bytes go to the upload route
 * (`id-document-client.ts`), which stores them through the Admin SDK. A
 * client-SDK upload would mint a download token no rule can revoke.
 *
 * ⚠️ Nothing is logged and nothing is kept in the browser beyond the tab.
 */

'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { User } from 'firebase/auth';

import {
  idUploadProblem,
  keepsPhotoForRetry,
  prepareIdPhoto,
  uploadIdDocument,
  type IdPhotoProblem,
  type IdUploadProblem,
  type PreparedIdPhoto,
} from '@/lib/id-document-client';
import { t } from '@/i18n';

/** The one side this shelter asks for (`idDocumentSides`, tested equal). */
export const ID_PHOTO_SIDE = 'front' as const;

/** `useId()` as a safe fragment of an element id. */
function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '');
}

export type IdPhotoState =
  | { kind: 'empty' }
  | { kind: 'preparing' }
  | { kind: 'ready'; photo: PreparedIdPhoto; previewUrl: string }
  | { kind: 'problem'; problem: IdPhotoProblem };

export function useIdPhoto() {
  const [state, setState] = useState<IdPhotoState>({ kind: 'empty' });
  // A later choice wins over an earlier one still being prepared.
  const ticket = useRef(0);
  const url = useRef<string | null>(null);

  const revoke = useCallback(() => {
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
  }, []);

  useEffect(
    () => () => {
      ticket.current += 1;
      revoke();
    },
    [revoke],
  );

  const choose = useCallback(
    async (file: File) => {
      const mine = ++ticket.current;
      revoke();
      setState({ kind: 'preparing' });
      const outcome = await prepareIdPhoto(file);
      if (mine !== ticket.current) return;
      if (!outcome.ok) {
        setState({ kind: 'problem', problem: outcome.problem });
        return;
      }
      const previewUrl = URL.createObjectURL(new Blob([new Uint8Array(outcome.photo.bytes)], { type: 'image/jpeg' }));
      url.current = previewUrl;
      setState({ kind: 'ready', photo: outcome.photo, previewUrl });
    },
    [revoke],
  );

  const clear = useCallback(() => {
    ticket.current += 1;
    revoke();
    setState({ kind: 'empty' });
  }, [revoke]);

  return { state, choose, clear };
}

function PickButton({
  className,
  label,
  camera,
  disabled,
  describedBy,
  invalid,
  onFile,
}: {
  className: string;
  label: string;
  camera: boolean;
  disabled: boolean;
  /** The tips, the hint and any error — read with the input, not after it (review 4c-2 #8). */
  describedBy: string | undefined;
  invalid: boolean;
  onFile: (file: File) => void;
}) {
  return (
    <label className={`${className} id-capture__pick${disabled ? ' is-disabled' : ''}`}>
      {label}
      <input
        type="file"
        accept="image/*"
        capture={camera ? 'environment' : undefined}
        className="visually-hidden"
        disabled={disabled}
        aria-describedby={describedBy}
        aria-invalid={invalid ? true : undefined}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared so choosing the same file again still fires `change`.
          event.target.value = '';
          if (file) onFile(file);
        }}
      />
    </label>
  );
}

export interface IdPhotoPickerViewProps {
  state: IdPhotoState;
  disabled: boolean;
  /** Step 2 refused "Continuar" without a photo. */
  required: boolean;
  onFile: (file: File) => void;
  /** Show the lead, the tips and the gallery hint (the step does; the uploader is shorter). */
  withGuidance: boolean;
  /** An element outside the picker that describes it too — the uploader's refusal. */
  describedBy?: string;
}

export function IdPhotoPickerView({
  state,
  disabled,
  required,
  onFile,
  withGuidance,
  describedBy: outer,
}: IdPhotoPickerViewProps) {
  const copy = t.applicationSteps;
  const base = `id-capture-${safeId(useId())}`;
  const ready = state.kind === 'ready';
  const busy = disabled || state.kind === 'preparing';
  const error =
    state.kind === 'problem' ? copy.photoProblem(state.problem) : required && !ready ? copy.photoRequired : null;
  const describedBy =
    [withGuidance ? `${base}-tips` : null, withGuidance ? `${base}-hint` : null, error ? `${base}-error` : null, outer ?? null]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <div className="id-capture">
      {withGuidance && (
        <>
          <p className="auth__prose apply-step__lead">{copy.carnetLead}</p>
          <p id={`${base}-tips`} className="auth__hint id-capture__tips">
            {copy.carnetTips}
          </p>
        </>
      )}

      {ready && (
        <figure className="id-capture__preview">
          {/* An object URL of the checked bytes, never a remote address. */}
          <img src={state.previewUrl} alt={copy.previewAlt} />
          <figcaption className="id-capture__question">{copy.previewQuestion}</figcaption>
        </figure>
      )}

      <div className="id-capture__actions">
        <PickButton
          className="btn"
          label={ready ? copy.retake : copy.takePhoto}
          camera
          disabled={busy}
          describedBy={describedBy}
          invalid={error !== null}
          onFile={onFile}
        />
        <PickButton
          className="btn btn--muted"
          label={copy.chooseGallery}
          camera={false}
          disabled={busy}
          describedBy={describedBy}
          invalid={error !== null}
          onFile={onFile}
        />
      </div>

      {state.kind === 'preparing' && (
        <p className="auth__hint" role="status">
          {copy.preparingPhoto}
        </p>
      )}
      {error && (
        <p id={`${base}-error`} className="apply-field__error" role="alert">
          {error}
        </p>
      )}
      {withGuidance && (
        <p id={`${base}-hint`} className="auth__hint id-capture__hint">
          {copy.carnetGalleryHint}
        </p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// After the application exists: "Falta tu carnet"
// ─────────────────────────────────────────────────────────────────────────────

export type UploaderPhase = 'idle' | 'uploading' | 'done';

export interface IdPhotoUploaderViewProps {
  state: IdPhotoState;
  phase: UploaderPhase;
  problem: IdUploadProblem | null;
  onFile: (file: File) => void;
  onUpload: () => void;
  onCancel?: () => void;
}

export function IdPhotoUploaderView({ state, phase, problem, onFile, onUpload, onCancel }: IdPhotoUploaderViewProps) {
  const copy = t.applicationSteps;
  // Before any early return: a hook is called on every render or on none.
  const problemId = `id-upload-${safeId(useId())}-problem`;
  if (phase === 'done') {
    return (
      <p className="auth__notice id-upload" role="status">
        {copy.uploadDone}
      </p>
    );
  }
  const uploading = phase === 'uploading';
  return (
    <div className="id-upload">
      <IdPhotoPickerView
        state={state}
        disabled={uploading}
        required={false}
        onFile={onFile}
        withGuidance={false}
        describedBy={problem ? problemId : undefined}
      />
      {state.kind === 'ready' && (
        <button type="button" className="btn btn--brand id-upload__send" onClick={onUpload} disabled={uploading}>
          {copy.uploadThisPhoto}
        </button>
      )}
      {uploading && (
        <p className="auth__hint" role="status">
          {copy.uploadingPhoto}
        </p>
      )}
      {problem && (
        <p id={problemId} className="auth__error" role="alert">
          {copy.uploadProblem(problem)}
        </p>
      )}
      {onCancel && (
        <button type="button" className="auth__link" onClick={onCancel} disabled={uploading}>
          {copy.cancel}
        </button>
      )}
    </div>
  );
}

export interface IdPhotoUploaderProps {
  user: Pick<User, 'getIdToken'>;
  applicationId: string;
  /** Called once the route has the photo. The caller reloads what it shows. */
  onUploaded: () => void;
  onCancel?: () => void;
}

export function IdPhotoUploader({ user, applicationId, onUploaded, onCancel }: IdPhotoUploaderProps) {
  const { state, choose, clear } = useIdPhoto();
  const [phase, setPhase] = useState<UploaderPhase>('idle');
  const [problem, setProblem] = useState<IdUploadProblem | null>(null);

  async function upload() {
    if (state.kind !== 'ready') return;
    setPhase('uploading');
    setProblem(null);
    const outcome = await uploadIdDocument(user, applicationId, ID_PHOTO_SIDE, state.photo);
    if (outcome.ok) {
      setPhase('done');
      clear();
      onUploaded();
      return;
    }
    setPhase('idle');
    const refused = idUploadProblem(outcome.failure);
    // Only a `retry` problem can take these bytes again: otherwise drop them and
    // revoke the preview (review 4c-2 #8).
    if (!keepsPhotoForRetry(refused)) clear();
    setProblem(refused);
  }

  return (
    <IdPhotoUploaderView
      state={state}
      phase={phase}
      problem={problem}
      onFile={(file) => {
        setProblem(null);
        void choose(file);
      }}
      onUpload={() => void upload()}
      onCancel={onCancel}
    />
  );
}
