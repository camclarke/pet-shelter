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
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import { useAuth } from '@/components/AuthProvider';
import { SHELTER, type ApplicationQuestion, type ApplicationSection } from '@/config/shelter';
import {
  APPLICATION_STATUS_TRANSITIONS,
  applicantLabel,
  applicantPhone,
  choiceLabel,
  isOpenApplication,
  type ApprovalCheck,
} from '@/lib/applications';
import {
  approveApplication,
  getApplication,
  getInternalNotes,
  listApplicationsForPet,
  moveApplication,
  previewApproval,
  saveInternalNotes,
  type ApplicationRecord,
} from '@/lib/applications-admin';
import { getPetById, getUserLabels } from '@/lib/areas-admin';
import { formatDate } from '@/lib/date-input';
import { t } from '@/i18n';
import type { ApplicationAnswer, ApplicationStatus, Pet } from '@/lib/types';

const SECTION_ORDER: ApplicationSection[] = [
  'contact',
  'housing',
  'household',
  'otherPets',
  'experience',
  'why',
];

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
                <a href={`tel:${phone.replace(/[^\d+]/g, '')}`} className="auth__link">
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

      {/* ── what they said ──────────────────────────────────────────────── */}
      <section className="admin-list">
        <h2 className="t-label">{copy.answersTitle}</h2>
        <AnswersView questions={questions} answers={current.answers} />
      </section>

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
// Presentational pieces — plain data in, no effects, renderable to static HTML
// ─────────────────────────────────────────────────────────────────────────────

function formatAnswer(question: ApplicationQuestion | undefined, value: ApplicationAnswer): string {
  if (typeof value === 'boolean') return t.yesNo(value);
  if (typeof value === 'number') return String(value);
  if (question?.kind === 'choice') return choiceLabel(question, value);
  return value;
}

export function AnswersView({
  questions,
  answers,
}: {
  questions: readonly ApplicationQuestion[];
  answers: Record<string, ApplicationAnswer>;
}) {
  const copy = t.applications;
  const known = new Set(questions.map((q) => q.id));
  // Answers under a key the form no longer asks: shown last, labelled as such,
  // never hidden — an old application must still show what was said.
  const retired = Object.keys(answers).filter((key) => !known.has(key)).sort();

  return (
    <>
      {SECTION_ORDER.map((section) => {
        const inSection = questions.filter((q) => q.section === section);
        if (inSection.length === 0) return null;
        return (
          <div key={section} className="answer-section">
            <h3 className="answer-section__title">{t.applicationSectionLabel(section)}</h3>
            <dl className="answer-list">
              {inSection.map((question) => {
                const value = answers[question.id];
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
              <dd>{formatAnswer(undefined, answers[key]!)}</dd>
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
