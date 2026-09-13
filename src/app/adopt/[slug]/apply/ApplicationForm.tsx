/**
 * The applicant's side of an online adoption application.
 *
 * Four states, in the order a visitor meets them:
 *   1. auth still resolving           → a quiet placeholder (never a flash of the sign-in prompt)
 *   2. signed out                     → why an account is needed, and a link that RETURNS here
 *   3. signed in, already applied     → the status of that application, not a second form
 *   4. signed in, not yet applied     → the questions, then an honest confirmation
 *
 * ⚠️ The WhatsApp button is rendered by the page ABOVE this component, in every
 * state. The account requirement lives here, below it, and never in front of it
 * — plan §6's design rule.
 *
 * ⚠️ Answers are never logged and never stored in the browser. A failed submit
 * keeps them in memory so nothing has to be retyped, and that is all: a shared
 * phone in a family is exactly where a stranger's household details must not
 * be left behind in localStorage.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import { useAuth } from '@/components/AuthProvider';
import type { ApplicationQuestion } from '@/config/shelter';
import {
  emptyAnswerDraft,
  validateAnswers,
  type AnswerDraft,
  type AnswerDraftValue,
  type ApplicationAnswerError,
} from '@/lib/applications';
import { signInHrefReturningTo } from '@/lib/return-path';
import { t } from '@/i18n';
import { ApplicationFields, questionDomId } from './ApplicationFields';

import type { MyApplication } from '@/lib/applications-client';

type Phase =
  | { kind: 'checking' }
  | { kind: 'existing'; application: MyApplication }
  | { kind: 'form' }
  | { kind: 'sent' }
  | { kind: 'check-failed' };

export interface ApplicationFormProps {
  petId: string;
  petName: string;
  slug: string;
  shelterName: string;
  questions: readonly ApplicationQuestion[];
}

export function ApplicationForm({ petId, petName, slug, shelterName, questions }: ApplicationFormProps) {
  const copy = t.applications;
  const { user, loading } = useAuth();

  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [draft, setDraft] = useState<AnswerDraft>(() => emptyAnswerDraft(questions));
  const [errors, setErrors] = useState<Record<string, ApplicationAnswerError>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    if (!user) return;
    setPhase({ kind: 'checking' });
    try {
      const { getMyApplication } = await import('@/lib/applications-client');
      const existing = await getMyApplication(petId, user);
      setPhase(existing ? { kind: 'existing', application: existing } : { kind: 'form' });
    } catch (caught) {
      console.error('[apply] could not check for an existing application', (caught as { code?: string })?.code);
      setPhase({ kind: 'check-failed' });
    }
  }, [petId, user]);

  useEffect(() => {
    if (!loading && user) void check();
  }, [loading, user, check]);

  function change(id: string, value: AnswerDraftValue) {
    setDraft((previous) => ({ ...previous, [id]: value }));
    // Clear that one error as soon as it is being fixed; the rest stay until
    // the next submit, so the list does not jump while someone is typing.
    setErrors((previous) => {
      if (!(id in previous)) return previous;
      const next = { ...previous };
      delete next[id];
      return next;
    });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!user) return;
    setNotice(null);

    const validation = validateAnswers(questions, draft);
    if (!validation.valid) {
      setErrors(validation.errors);
      setNotice(copy.fixErrors);
      const first = questions.find((q) => q.id in validation.errors);
      if (first) document.getElementById(questionDomId(first.id))?.scrollIntoView({ block: 'center' });
      return;
    }

    setBusy(true);
    try {
      const { submitApplication } = await import('@/lib/applications-client');
      await submitApplication(petId, user, validation.answers);
      setPhase({ kind: 'sent' });
      window.scrollTo({ top: 0 });
    } catch (caught) {
      const code = (caught as { code?: string })?.code;
      // The code only. The payload is a private person's household.
      console.error('[apply] could not submit', code);
      setNotice(code === 'permission-denied' ? copy.submitRefused : copy.submitFailed);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <p className="auth__loading" aria-busy="true">{copy.loading}</p>;
  }

  if (!user) {
    return (
      <div className="apply-gate">
        <p className="auth__prose">{copy.signInPrompt}</p>
        <Link href={signInHrefReturningTo(`/adopt/${slug}/apply`)} className="btn btn--action">
          {copy.signInButton}
        </Link>
      </div>
    );
  }

  switch (phase.kind) {
    case 'checking':
      return <p className="auth__loading" aria-busy="true">{copy.loading}</p>;

    case 'check-failed':
      return (
        <div className="apply-gate">
          <p className="auth__error" role="alert">
            {copy.loadFailed}
          </p>
          <button type="button" className="btn btn--muted" onClick={() => void check()}>
            {copy.retry}
          </button>
        </div>
      );

    case 'existing':
      return (
        <div className="apply-gate">
          <p className="auth__notice" role="status">
            {copy.alreadyApplied}{' '}
            <strong className="app-status">{t.applicantStatusLabel(phase.application.status)}</strong>
          </p>
          <p className="auth__prose">{t.applicantStatusExplanation(phase.application.status)}</p>
          <Link href="/account" className="btn btn--brand">
            {copy.goToAccount}
          </Link>
        </div>
      );

    case 'sent':
      return <ApplicationSent petName={petName} shelterName={shelterName} slug={slug} />;

    case 'form':
      return (
        <form className="auth__form apply-form" onSubmit={submit} noValidate>
          <p className="auth__hint">{copy.privacy(shelterName)}</p>
          <ApplicationFields
            questions={questions}
            draft={draft}
            errors={errors}
            disabled={busy}
            onChange={change}
          />
          {notice && (
            <p className="auth__error" role="alert">
              {notice}
            </p>
          )}
          <button type="submit" className="btn btn--action auth__submit" disabled={busy}>
            {busy ? copy.submitting : copy.submit}
          </button>
        </form>
      );
  }
}

/** The confirmation. Every line of it is true — see `confirmationSteps` in the es catalogue. */
export function ApplicationSent({
  petName,
  shelterName,
  slug,
}: {
  petName: string;
  shelterName: string;
  slug: string;
}) {
  const copy = t.applications;
  return (
    <div className="apply-sent" role="status">
      <h2 className="t-title apply-sent__title">{copy.confirmationTitle}</h2>
      <ol className="apply-steps">
        {copy.confirmationSteps(petName, shelterName).map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <div className="auth__actions">
        <Link href="/account" className="btn btn--brand">
          {copy.goToAccount}
        </Link>
        <Link href={`/adopt/${slug}`} className="auth__link apply-back">
          {copy.backToPet(petName)}
        </Link>
      </div>
    </div>
  );
}
