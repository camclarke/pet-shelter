/**
 * One adoption application, as the shelter reviews it: who is asking, what
 * they answered, the team's private notes, and what to do next.
 *
 * ── What each action writes ────────────────────────────────────────────────
 * - review / interview / reject / record a withdrawal → ONE update to the
 *   application, through `adminStatusPatch`, which the rules mirror.
 * - approve → ONE `writeBatch` from `buildApprovalWrites`: the application,
 *   `adoptions/{petId}`, custody, placements, the pet status. The preview is
 *   only what the admin reads; `approveApplication` re-reads everything at the
 *   moment of confirming, so a screen left open for an hour cannot commit a
 *   decision the data no longer supports.
 *
 * ── What no action does ───────────────────────────────────────────────────
 * Send anything. No email, no WhatsApp, no notification — plan §6 and the task
 * that built this are explicit, and the copy says so to the admin. Other open
 * applications for the same animal are listed as a WARNING and left exactly as
 * they are: turning someone down is a conversation.
 *
 * ⚠️ Answers render here and nowhere else in the admin console, and are never
 * logged. Errors carry the Firestore code only.
 *
 * ── The carnet and the address (portion 4b) ─────────────────────────────────
 * The ID photo is loaded ONLY when an admin taps "Ver carnet", through
 * `id-document-admin.ts` (`getBlob` under storage.rules — never a download
 * URL), and its object URL is revoked when it is hidden or the screen goes
 * away. The address is TEXT, read from `private/home` on its own, so a failed
 * or refused read shows a sentence and never takes the page down. Once
 * `identityErasedAt` is set, neither is read at all.
 *
 * ── The personal details and references (portion 4c-1) ────────────────────
 * The C.I., age, civil status, landline, both references and a renter's
 * landlord live in the admin-only `private/identity`, read on its own exactly
 * like the address: when this screen opens, never from the queue, never logged.
 * They render in their place among the answers, in the paper's order; until the
 * read settles, one sentence says why they are not there. Once
 * `identityErasedAt` is set, the document is not read at all.
 */

'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';

import { useAuth } from '@/components/AuthProvider';
import { LazyAddressMap } from '@/components/LazyAddressMap';
import { SHELTER, type ApplicationQuestion } from '@/config/shelter';
import {
  APPLICATION_STATUS_TRANSITIONS,
  applicantLabel,
  applicantPhone,
  choiceLabel,
  googleMapsUrl,
  isOpenApplication,
  isQuestionAsked,
  isReceivedMarker,
  type ApprovalCheck,
} from '@/lib/applications';
import {
  approveApplication,
  eraseApplicationIdentity,
  getApplication,
  getApplicationHome,
  getApplicationIdentity,
  getInternalNotes,
  listApplicationsForPet,
  moveApplication,
  previewApproval,
  saveInternalNotes,
  type ApplicationHomeView,
  type ApplicationIdentityView,
  type ApplicationRecord,
} from '@/lib/applications-admin';
import { getPetById, getUserLabels } from '@/lib/areas-admin';
import { formatDate } from '@/lib/date-input';
import { reasonFitsStatus } from '@/lib/identity-erase-handler';
import { ERASE_REASONS, type EraseReason } from '@/lib/identity-erase-protocol';
import { readIdDocumentObjectUrl } from '@/lib/id-document-admin';
import { t } from '@/i18n';
import type { ApplicationAnswer, ApplicationStatus, IdDocumentSide, Pet } from '@/lib/types';

function errorCode(caught: unknown): string | undefined {
  return (caught as { code?: string })?.code;
}

export function ApplicationReview({ applicationId }: { applicationId: string }) {
  const copy = t.applications;
  const { user } = useAuth();
  const questions = SHELTER.adoptionApplications.questions;

  const [application, setApplication] = useState<ApplicationRecord | null | 'missing'>(null);
  const [pet, setPet] = useState<Pet | null>(null);
  const [others, setOthers] = useState<ApplicationRecord[]>([]);
  const [deciders, setDeciders] = useState<Map<string, string>>(new Map());
  const [notes, setNotes] = useState('');
  const [notesState, setNotesState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmWithdrawal, setConfirmWithdrawal] = useState(false);
  const [approval, setApproval] = useState<{ check: ApprovalCheck } | 'checking' | null>(null);
  const [home, setHome] = useState<HomeState>('loading');
  const [identity, setIdentity] = useState<IdentityAnswersState>('loading');

  const load = useCallback(async () => {
    setError(null);
    try {
      const found = await getApplication(applicationId);
      if (!found) {
        setApplication('missing');
        return;
      }
      const [foundPet, foundNotes, forPet, labels] = await Promise.all([
        getPetById(found.petId),
        getInternalNotes(found.id),
        listApplicationsForPet(found.petId),
        getUserLabels(found.decidedBy ? [found.decidedBy] : []),
      ]);
      setApplication(found);
      setPet(foundPet);
      setNotes(foundNotes?.text ?? '');
      setOthers(forPet.filter((other) => other.id !== found.id));
      setDeciders(labels);
    } catch (caught) {
      const code = errorCode(caught);
      console.error('[admin/application] could not load', code);
      setError(code === 'permission-denied' ? copy.permissionDenied : copy.adminLoadFailed);
    }
  }, [applicationId, copy.permissionDenied, copy.adminLoadFailed]);

  useEffect(() => {
    void load();
  }, [load]);

  // The address, on its own: a refused or failed read is one sentence in its
  // block, never the page's error. Not read at all once it has been erased.
  const loadedId = application && application !== 'missing' ? application.id : null;
  const erased = application && application !== 'missing' ? application.identityErased : false;
  useEffect(() => {
    if (!loadedId || erased) return;
    let live = true;
    setHome('loading');
    getApplicationHome(loadedId)
      .then((found) => {
        if (live) setHome(found ?? 'missing');
      })
      .catch((caught: unknown) => {
        console.error('[admin/application] could not load the address', errorCode(caught));
        if (live) setHome('failed');
      });
    return () => {
      live = false;
    };
  }, [loadedId, erased]);

  // The personal details and references, the same way: their own read, their
  // own sentence on failure, and no read at all once erased.
  useEffect(() => {
    if (!loadedId || erased) return;
    let live = true;
    setIdentity('loading');
    getApplicationIdentity(loadedId)
      .then((found) => {
        if (live) setIdentity(found ?? 'missing');
      })
      .catch((caught: unknown) => {
        console.error('[admin/application] could not load the personal details', errorCode(caught));
        if (live) setIdentity('failed');
      });
    return () => {
      live = false;
    };
  }, [loadedId, erased]);

  if (application === null && !error) {
    return <p className="admin__sub">{copy.loading}</p>;
  }

  if (application === 'missing' || application === null) {
    return (
      <div className="admin">
        <p className="auth__error">{error ?? copy.applicationMissing}</p>
        <Link href="/admin/applications" className="btn btn--muted">
          {copy.backToQueue}
        </Link>
      </div>
    );
  }

  const current = application;
  const label = applicantLabel(questions, current);
  const phone = applicantPhone(questions, current);
  const petName = pet?.name ?? copy.unknownPet;
  const moves = APPLICATION_STATUS_TRANSITIONS[current.status];
  const openOthers = others.filter((other) => isOpenApplication(other.status));

  async function move(to: Exclude<ApplicationStatus, 'approved'>) {
    if (!user) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await moveApplication(current, to, user);
      setConfirmWithdrawal(false);
      await load();
    } catch (caught) {
      const code = errorCode(caught);
      console.error('[admin/application] could not move', code);
      setError(code === 'permission-denied' ? copy.actionRefused : copy.actionFailed);
    } finally {
      setBusy(false);
    }
  }

  async function openApproval() {
    setApproval('checking');
    setError(null);
    try {
      const preview = await previewApproval(current);
      setApproval({ check: preview.check });
    } catch (caught) {
      console.error('[admin/application] could not preview approval', errorCode(caught));
      setApproval(null);
      setError(copy.actionFailed);
    }
  }

  async function approve() {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      await approveApplication(current, label, user);
      setApproval(null);
      setDone(copy.approvedDone(petName));
      await load();
    } catch (caught) {
      const code = errorCode(caught);
      console.error('[admin/application] could not approve', code);
      setError(code === 'permission-denied' ? copy.actionRefused : copy.actionFailed);
      // A blocker may have appeared since the preview: show the fresh one.
      void openApproval();
    } finally {
      setBusy(false);
    }
  }

  async function saveNotes() {
    if (!user) return;
    setNotesState('saving');
    try {
      await saveInternalNotes(current.id, notes, user);
      setNotesState('saved');
    } catch (caught) {
      console.error('[admin/application] could not save notes', errorCode(caught));
      setNotesState('failed');
    }
  }

  return (
    <div className="admin">
      <header className="admin__header">
        <div>
          <h1 className="t-title">{label}</h1>
          <p className="admin__sub">
            {petName}
            {pet && ` · ${t.statusLabel(pet.status)}`}
          </p>
        </div>
        <div className="admin__header-actions">
          <Link href="/admin/applications" className="btn btn--muted">
            {copy.backToQueue}
          </Link>
          {pet && (
            <Link href={`/admin/pets/${pet.id}`} className="btn btn--muted">
              {copy.internalRecord}
            </Link>
          )}
        </div>
      </header>

      {error && (
        <p className="auth__error" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className="auth__notice" role="status">
          {done}
        </p>
      )}

      {/* ── who ─────────────────────────────────────────────────────────── */}
      <section className="admin-list">
        <h2 className="t-label">{copy.applicantTitle}</h2>
        <dl className="answer-list">
          <div className="answer">
            <dt>{copy.statusTitle}</dt>
            <dd>
              <span className={`app-status app-status--${current.status}`}>
                {t.applicationStatusLabel(current.status)}
              </span>{' '}
              <span className="t-data">{copy.submittedOn(formatDate(current.submittedAt))}</span>
              {current.decidedAt !== null && (
                <span className="answer__note">
                  {copy.decidedByOn(
                    deciders.get(current.decidedBy ?? '') ?? current.decidedBy ?? '—',
                    formatDate(current.decidedAt),
                  )}
                </span>
              )}
              {current.withdrawnAt !== null && (
                <span className="answer__note">{copy.withdrawnOn(formatDate(current.withdrawnAt))}</span>
              )}
            </dd>
          </div>
          {phone && (
            <div className="answer">
              <dt>{copy.phoneLabel}</dt>
              <dd>
                <a href={`tel:${phone.replace(/[^\d+]/g, '')}`} className="auth__link answer__link">
                  {phone}
                </a>
              </dd>
            </div>
          )}
          <div className="answer">
            <dt>{copy.emailLabel}</dt>
            <dd>
              {current.applicantEmail}
              {!current.applicantEmailVerified && (
                <span className="answer__note">{copy.emailUnverifiedTag}</span>
              )}
            </dd>
          </div>
        </dl>
      </section>

      {/* ── the carnet and the address ──────────────────────────────────── */}
      <section className="admin-list">
        <h2 className="t-label">{copy.identityTitle}</h2>
        <IdentityView
          open={isOpenApplication(current.status)}
          erased={current.identityErased}
          erasedAt={current.identityErasedAt}
          sides={SHELTER.adoptionApplications.idDocumentSides}
          receipts={current.idDocument}
          home={home}
          viewer={(side) => <IdDocumentViewer applicationId={current.id} side={side} />}
        />
      </section>

      {/* ── what they said ──────────────────────────────────────────────── */}
      <section className="admin-list">
        <h2 className="t-label">{copy.answersTitle}</h2>
        <AnswersView
          questions={questions}
          answers={current.answers}
          identity={current.identityErased ? 'erased' : identity}
        />
      </section>

      {/* ── erase the carnet and the address (2026-10-17) ─────────────────── */}
      {!current.identityErased && user && (
        <section className="admin-list">
          <h2 className="t-label">{copy.eraseTitle}</h2>
          <ErasePanel
            status={current.status}
            applicant={label}
            petName={petName}
            onErase={async (reason) => {
              const failure = await eraseApplicationIdentity(user, current.id, reason);
              if (failure === null) await load();
              return failure;
            }}
          />
        </section>
      )}

      {/* ── the team's private notes ────────────────────────────────────── */}
      <section className="admin-list">
        <h2 className="t-label">{copy.notesTitle}</h2>
        <form
          className="admin-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveNotes();
          }}
        >
          <label className="auth__field">
            <small className="auth__hint">{copy.notesHint}</small>
            <textarea
              rows={4}
              maxLength={5000}
              value={notes}
              onChange={(event) => {
                setNotes(event.target.value);
                setNotesState('idle');
              }}
            />
          </label>
          <div className="admin-list__actions">
            <button type="submit" className="btn btn--muted" disabled={notesState === 'saving'}>
              {copy.saveNotes}
            </button>
            {notesState === 'saved' && <span className="auth__hint">{copy.notesSaved}</span>}
            {notesState === 'failed' && (
              <span className="auth__error" role="alert">
                {copy.notesFailed}
              </span>
            )}
          </div>
        </form>
      </section>

      {/* ── what to do ──────────────────────────────────────────────────── */}
      <section className="admin-list">
        <h2 className="t-label">{copy.actionsTitle}</h2>
        {moves.length === 0 && <p className="admin__sub">{copy.noActions}</p>}

        {moves.length > 0 && approval === null && !confirmWithdrawal && (
          <div className="admin-list__actions review-actions">
            {moves.map((to) =>
              to === 'approved' ? (
                <button
                  key={to}
                  type="button"
                  className="btn btn--action"
                  onClick={() => void openApproval()}
                  disabled={busy}
                >
                  {t.applicationActionLabel(current.status, to)}
                </button>
              ) : (
                <button
                  key={to}
                  type="button"
                  className="btn btn--muted"
                  onClick={() => (to === 'withdrawn' ? setConfirmWithdrawal(true) : void move(to))}
                  disabled={busy}
                >
                  {t.applicationActionLabel(current.status, to)}
                </button>
              ),
            )}
          </div>
        )}

        {confirmWithdrawal && (
          <div className="approval-panel">
            <p>{copy.confirmRecordWithdrawal}</p>
            <div className="admin-list__actions">
              <button type="button" className="btn btn--muted" onClick={() => void move('withdrawn')} disabled={busy}>
                {t.applicationActionLabel(current.status, 'withdrawn')}
              </button>
              <button type="button" className="btn btn--brand" onClick={() => setConfirmWithdrawal(false)} disabled={busy}>
                {copy.cancel}
              </button>
            </div>
          </div>
        )}

        {approval === 'checking' && <p className="admin__sub">{copy.checking}</p>}
        {approval !== null && approval !== 'checking' && (
          <ApprovalPanelView
            petName={petName}
            applicant={label}
            check={approval.check}
            otherOpen={openOthers.map((other) => ({
              id: other.id,
              label: applicantLabel(questions, other),
              status: other.status,
            }))}
            busy={busy}
            onConfirm={() => void approve()}
            onCancel={() => setApproval(null)}
          />
        )}

        {openOthers.length > 0 && approval === null && (
          <OtherOpenList
            items={openOthers.map((other) => ({
              id: other.id,
              label: applicantLabel(questions, other),
              status: other.status,
            }))}
          />
        )}
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The carnet viewer — the ONE place the photo is fetched, and only on tap
// ─────────────────────────────────────────────────────────────────────────────

type ViewerState = 'idle' | 'loading' | 'shown' | 'failed' | 'refused';

const SITE_HOST = new URL(SHELTER.siteUrl).host;

/**
 * "Ver carnet" → `getBlob` under storage.rules → an object URL in an `<img>`.
 * The URL is revoked on "Ocultar", on a second load, on unmount, and at once
 * if the screen went away while the photo was still arriving — so the bytes
 * do not outlive the moment an admin is looking at them.
 */
function IdDocumentViewer({ applicationId, side }: { applicationId: string; side: IdDocumentSide }) {
  const copy = t.applications;
  const [state, setState] = useState<ViewerState>('idle');
  const [url, setUrl] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, []);

  function hide() {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setUrl(null);
    setState('idle');
  }

  async function show() {
    setState('loading');
    try {
      const objectUrl = await readIdDocumentObjectUrl(applicationId, side);
      if (!mounted.current) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = objectUrl;
      setUrl(objectUrl);
      setState('shown');
    } catch (caught) {
      const code = errorCode(caught);
      console.error('[admin/application] could not open the carnet', code);
      if (mounted.current) setState(code === 'storage/unauthorized' ? 'refused' : 'failed');
    }
  }

  return (
    <IdDocumentViewerView
      state={state}
      url={url}
      siteHost={SITE_HOST}
      onShow={() => void show()}
      onHide={hide}
      label={copy.idDocumentSideLabel(side)}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentational pieces — plain data in, no effects, renderable to static HTML
// ─────────────────────────────────────────────────────────────────────────────

export function IdDocumentViewerView({
  state,
  url,
  siteHost,
  onShow,
  onHide,
  label,
}: {
  state: ViewerState;
  url: string | null;
  siteHost: string;
  onShow: () => void;
  onHide: () => void;
  label: string;
}) {
  const copy = t.applications;
  return (
    <div className="identity-viewer">
      {state === 'shown' && url ? (
        <>
          <button type="button" className="btn btn--muted" onClick={onHide}>
            {copy.idDocumentHide}
          </button>
          {/* An object URL, revoked by the caller. Never a download URL. */}
          <img className="id-photo" src={url} alt={`${copy.idDocumentAlt} · ${label}`} />
        </>
      ) : (
        <button type="button" className="btn btn--muted" onClick={onShow} disabled={state === 'loading'}>
          {state === 'loading' ? copy.idDocumentLoading : copy.idDocumentShow}
        </button>
      )}
      {state === 'failed' && (
        <span className="auth__error" role="alert">
          {copy.idDocumentFailed(siteHost)}
        </span>
      )}
      {state === 'refused' && (
        <span className="auth__error" role="alert">
          {copy.idDocumentRefused}
        </span>
      )}
    </div>
  );
}

/**
 * The applicant's pin, read-only. The map loads only on tap, like the
 * applicant's: opening a review does not contact the tile server.
 */
function HomeMap({ latitude, longitude }: { latitude: number; longitude: number }) {
  const copy = t.applications;
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div className="answer__note apply-map apply-map--admin">
      <div className="apply-map__links">
        <button type="button" className="btn btn--ghost" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
          {open ? copy.homeMapHide : copy.homeMapShow}
        </button>
        <a className="btn btn--ghost" href={googleMapsUrl(latitude, longitude)} target="_blank" rel="noopener noreferrer">
          {copy.homeMapGoogle}
        </a>
      </div>
      {open &&
        (failed ? (
          <p role="status">{copy.homeMapFailed}</p>
        ) : (
          <LazyAddressMap
            pin={{ latitude, longitude }}
            label={copy.homeMapLabel}
            loadingText={t.applicationSteps.mapLoading}
            onFailed={() => setFailed(true)}
          />
        ))}
    </div>
  );
}

/**
 * The admin's erase action. Offers only the reasons the route accepts for this
 * status (`reasonFitsStatus`), and asks once more, naming the person and the
 * animal, before anything is sent. Nothing here erases on its own: the owner's
 * decision (2026-10-17) is that only a person does.
 */
export function ErasePanel({
  status,
  applicant,
  petName,
  onErase,
}: {
  status: ApplicationStatus;
  applicant: string;
  petName: string;
  onErase: (reason: EraseReason) => Promise<string | null>;
}) {
  const copy = t.applications;
  const reasons = ERASE_REASONS.filter((reason) => reasonFitsStatus(reason, status));
  const [reason, setReason] = useState<EraseReason | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  if (reasons.length === 0) return <p className="admin__sub">{copy.eraseOpenHint}</p>;
  const chosen = reason && reasons.includes(reason) ? reason : reasons[0]!;

  async function erase() {
    setBusy(true);
    setMessage(null);
    const failure = await onErase(chosen);
    setBusy(false);
    setConfirming(false);
    setMessage(failure === null ? { ok: true, text: copy.eraseDone } : { ok: false, text: copy.eraseFailed(failure) });
  }

  return (
    <div className="admin-form erase-panel">
      <p className="auth__hint">{copy.eraseLead}</p>
      <label className="auth__field">
        <span className="apply-field__label">{copy.eraseReasonLabel}</span>
        <select value={chosen} disabled={busy || confirming} onChange={(e) => setReason(e.target.value as EraseReason)}>
          {reasons.map((r) => (
            <option key={r} value={r}>
              {copy.eraseReason(r)}
            </option>
          ))}
        </select>
      </label>
      {chosen === 'died' && <p className="auth__hint erase-panel__warning">{copy.eraseDiedWarning}</p>}
      {confirming ? (
        // The same confirm card as DeleteRecordButton: a coral border legible in
        // both themes, full-strength text, and no autofocus or form, so Enter
        // erases nothing.
        <div className="register-warning" role="alert">
          <p>{copy.eraseConfirm(applicant, petName)}</p>
          <div className="admin-list__actions">
            <button type="button" className="btn btn--muted" disabled={busy} onClick={() => void erase()}>
              {copy.eraseButton}
            </button>
            <button type="button" className="btn btn--muted" disabled={busy} onClick={() => setConfirming(false)}>
              {copy.eraseCancel}
            </button>
          </div>
        </div>
      ) : (
        <div className="admin-list__actions">
          <button type="button" className="btn btn--muted" onClick={() => setConfirming(true)}>
            {copy.eraseStart}
          </button>
        </div>
      )}
      {message && (
        <p className={message.ok ? 'auth__hint' : 'auth__error'} role={message.ok ? 'status' : 'alert'}>
          {message.text}
        </p>
      )}
    </div>
  );
}

/** `private/home` as the screen holds it. */
export type HomeState = ApplicationHomeView | 'loading' | 'missing' | 'failed';

function HomeText({ home }: { home: HomeState }) {
  const copy = t.applications;
  if (home === 'loading') return <span className="answer__empty">{copy.loading}</span>;
  if (home === 'missing') return <span className="answer__empty">{copy.homeMissing}</span>;
  if (home === 'failed') return <span className="answer__empty">{copy.homeLoadFailed}</span>;
  return (
    <>
      {home.addressText}
      {home.reference !== '' && <span className="answer__note">{copy.homeReference(home.reference)}</span>}
      <span className="answer__note">
        {home.geo
          ? copy.homePin(home.geo.latitude.toFixed(4), home.geo.longitude.toFixed(4))
          : copy.homeNoPin}
      </span>
      {home.geo && <HomeMap latitude={home.geo.latitude} longitude={home.geo.longitude} />}
      {home.correctedAt !== null && (
        <span className="answer__note">{copy.homeCorrectedOn(formatDate(home.correctedAt))}</span>
      )}
    </>
  );
}

/**
 * The carnet and the address, as TEXT plus a "Ver carnet" button per side.
 * `viewer` renders the button; the static render passes a stand-in.
 */
export function IdentityView({
  open,
  erased,
  erasedAt,
  sides,
  receipts,
  home,
  viewer,
}: {
  open: boolean;
  /** `ApplicationRecord.identityErased` — `isIdentityErased`, the route's own check. */
  erased: boolean;
  /** For the date only: null when the erase was not stored as a Timestamp. */
  erasedAt: number | null;
  sides: readonly IdDocumentSide[];
  receipts: ApplicationRecord['idDocument'];
  home: HomeState;
  viewer: (side: IdDocumentSide) => ReactNode;
}) {
  const copy = t.applications;

  if (erased) {
    return (
      <p className="identity-erased">
        {erasedAt !== null ? copy.identityErased(formatDate(erasedAt)) : copy.identityErasedUndated}
      </p>
    );
  }

  return (
    <>
      <dl className="answer-list">
        {sides.map((side) => {
          const receipt = receipts[side];
          return (
            <div key={side} className="answer">
              <dt>{copy.idDocumentSideLabel(side)}</dt>
              <dd>
                {receipt && isReceivedMarker(receipt) ? (
                  <>
                    {receipt.receivedAt !== null && (
                      <span className="answer__note">{copy.idDocumentReceivedOn(formatDate(receipt.receivedAt))}</span>
                    )}
                    {viewer(side)}
                  </>
                ) : (
                  <span className="answer__empty">{copy.idDocumentMissing(open)}</span>
                )}
              </dd>
            </div>
          );
        })}
        <div className="answer">
          <dt>{copy.homeTitle}</dt>
          <dd>
            <HomeText home={home} />
          </dd>
        </div>
      </dl>
      <p className="auth__hint identity-handling">{copy.idDocumentHandling}</p>
    </>
  );
}

function formatAnswer(question: ApplicationQuestion | undefined, value: ApplicationAnswer): string {
  if (typeof value === 'boolean') return t.yesNo(value);
  if (typeof value === 'number') return String(value);
  if (question?.kind === 'choice') return choiceLabel(question, value);
  return value;
}

/** `private/identity` as the screen holds it. `'erased'`: not read at all. */
export type IdentityAnswersState = ApplicationIdentityView | 'loading' | 'missing' | 'failed' | 'erased';

export function AnswersView({
  questions,
  answers,
  identity,
}: {
  questions: readonly ApplicationQuestion[];
  /** `answers` on the application: the `store: 'application'` questions. */
  answers: Record<string, ApplicationAnswer>;
  /** `private/identity`: the `store: 'identity'` questions, loaded on its own. */
  identity: IdentityAnswersState;
}) {
  const copy = t.applications;
  const identityAnswers = typeof identity === 'object' ? identity.answers : null;
  // Both stores together, so `askedWhen` hides exactly what the form never
  // asked — the landlord of an owned home, "amurallado" for a flat.
  const stored: Record<string, ApplicationAnswer> = { ...answers, ...(identityAnswers ?? {}) };
  const known = new Set(questions.map((q) => q.id));
  // Answers under a key the form no longer asks: shown last, labelled as such,
  // never hidden — an old application must still show what was said.
  const retired = Object.keys(stored).filter((key) => !known.has(key)).sort();

  const identityNote =
    identity === 'loading'
      ? copy.identityAnswersLoading
      : identity === 'missing'
        ? copy.identityAnswersMissing
        : identity === 'failed'
          ? copy.identityAnswersLoadFailed
          : identity === 'erased'
            ? copy.identityAnswersErased
            : null;

  return (
    <>
      {identityNote && (
        <p className="answer__empty" role="status">
          {identityNote}
        </p>
      )}
      {SHELTER.adoptionApplications.sections.map((section) => {
        // Identity questions render only once their document is in hand; until
        // then the sentence above says why they are not there.
        const inSection = questions.filter(
          (q) =>
            q.section === section.id &&
            (q.store === 'application' || identityAnswers !== null) &&
            isQuestionAsked(questions, q, stored),
        );
        if (inSection.length === 0) return null;
        return (
          <div key={section.id} className="answer-section">
            <h3 className="answer-section__title">{section.label}</h3>
            <dl className="answer-list">
              {inSection.map((question) => {
                const value = stored[question.id];
                return (
                  <div key={question.id} className="answer">
                    <dt>{question.label}</dt>
                    <dd className={value === undefined ? 'answer__empty' : undefined}>
                      {value === undefined ? copy.notAnswered : formatAnswer(question, value)}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        );
      })}
      {retired.length > 0 && (
        <dl className="answer-list">
          {retired.map((key) => (
            <div key={key} className="answer">
              <dt>{copy.retiredQuestion(key)}</dt>
              <dd>{formatAnswer(undefined, stored[key]!)}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}

interface OtherApplicationItem {
  id: string;
  label: string;
  status: ApplicationStatus;
}

export function OtherOpenList({ items }: { items: OtherApplicationItem[] }) {
  const copy = t.applications;
  return (
    <div className="review-others">
      <h3 className="answer-section__title">{copy.otherOpenTitle}</h3>
      <ul className="admin-list__items">
        {items.map((item) => (
          <li key={item.id} className="admin-list__item">
            <Link href={`/admin/applications/${item.id}`}>
              <span className="admin-list__text">
                <strong>{item.label}</strong>
                <span className={`app-status app-status--${item.status}`}>
                  {t.applicationStatusLabel(item.status)}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface ApprovalPanelViewProps {
  petName: string;
  applicant: string;
  check: ApprovalCheck;
  otherOpen: OtherApplicationItem[];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * ⚠️ Blockers disable the confirm button; warnings never do. That split is the
 * whole contract of `approvalCheck` — see `applications.ts` for which is which
 * and why.
 */
export function ApprovalPanelView({
  petName,
  applicant,
  check,
  otherOpen,
  busy,
  onConfirm,
  onCancel,
}: ApprovalPanelViewProps) {
  const copy = t.applications;
  const blocked = check.blockers.length > 0;

  return (
    <div className="approval-panel" role="region" aria-label={copy.approveTitle}>
      <h3 className="approval-panel__title">{copy.approveTitle}</h3>

      {blocked && (
        <div className="auth__error" role="alert">
          <strong>{copy.blockersTitle}</strong>
          <ul className="approval-panel__list">
            {check.blockers.map((blocker) => (
              <li key={blocker}>{t.approvalBlocker(blocker)}</li>
            ))}
          </ul>
        </div>
      )}

      {!blocked && <p className="approval-panel__explain">{copy.approveExplain(petName, applicant)}</p>}

      {check.warnings.length > 0 && (
        <>
          <p className="t-label">{copy.warningsTitle}</p>
          <ul className="place-warnings" role="status">
            {check.warnings.map((warning) => (
              <li key={warning}>
                {t.approvalWarning(warning, { otherOpenCount: check.otherOpenIds.length })}
              </li>
            ))}
          </ul>
        </>
      )}

      {otherOpen.length > 0 && <OtherOpenList items={otherOpen} />}

      <div className="admin__footer">
        <div className="admin__footer-left">
          <button type="button" className="btn btn--muted" onClick={onCancel} disabled={busy}>
            {copy.cancel}
          </button>
        </div>
        <div className="admin__footer-right">
          <button
            type="button"
            className="btn btn--action"
            onClick={onConfirm}
            disabled={busy || blocked}
          >
            {copy.approveConfirm}
          </button>
        </div>
      </div>
    </div>
  );
}
