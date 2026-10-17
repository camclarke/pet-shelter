/**
 * The applicant's side of an online adoption application.
 *
 * Four states, in the order a visitor meets them:
 *   1. auth still resolving           → a quiet placeholder (never a flash of the sign-in prompt)
 *   2. signed out                     → what this is, why an account is needed,
 *                                       a link to read the commitments first, and a
 *                                       sign-in link that RETURNS here
 *   3. signed in, already applied     → the status of that application, not a
 *                                       second form — and "Falta tu carnet" with
 *                                       the upload, while its ID photo is missing
 *   4. signed in, not yet applied     → the seven-step form (`ApplicationStepper`)
 *
 * ⚠️ The WhatsApp button is rendered by the page ABOVE this component, in every
 * state. The account requirement lives here, below it, and never in front of it
 * — plan §6's design rule.
 *
 * ⚠️ Answers are never logged and never stored in the browser. The stepper
 * keeps them in memory only: a shared phone in a family is exactly where a
 * stranger's household details must not be left behind in localStorage.
 */

'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';

import { useAuth } from '@/components/AuthProvider';
import type { AdoptionContract } from '@/config/adoption-contract';
import type { ApplicationQuestion } from '@/config/shelter';
import type { PetFact } from '@/lib/application-steps';
import { signInHrefReturningTo } from '@/lib/return-path';
import { t } from '@/i18n';
import { ApplicationStepper } from './ApplicationStepper';
import { IdPhotoUploader } from './IdPhotoStep';

import type { MyApplication } from '@/lib/applications-client';

type Phase =
  | { kind: 'checking' }
  | { kind: 'existing'; application: MyApplication }
  | { kind: 'form' }
  | { kind: 'check-failed' };

export interface ApplicationFormProps {
  petId: string;
  petName: string;
  slug: string;
  shelterName: string;
  questions: readonly ApplicationQuestion[];
  /** `ADOPTION_CONTRACT`, non-null: the page 404s while there is none. */
  contract: AdoptionContract;
  /** DATOS DEL PELUDITO ADOPTADO, from the public pet document (D16). */
  petFacts: readonly PetFact[];
}

export function ApplicationForm({
  petId,
  petName,
  slug,
  shelterName,
  questions,
  contract,
  petFacts,
}: ApplicationFormProps) {
  const copy = t.applications;
  const { user, loading } = useAuth();

  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [justUploaded, setJustUploaded] = useState(false);

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

  if (loading) {
    return <p className="auth__loading" aria-busy="true">{copy.loading}</p>;
  }

  if (!user) return <SignInGate slug={slug} />;

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
        <ExistingApplication
          application={phase.application}
          justUploaded={justUploaded}
          uploader={
            <IdPhotoUploader
              user={user}
              applicationId={phase.application.id}
              onUploaded={() => {
                setJustUploaded(true);
                setPhase({ kind: 'existing', application: { ...phase.application, idDocumentMissing: false } });
              }}
            />
          }
        />
      );

    case 'form':
      return (
        <div className="apply-form">
          <p className="auth__hint">{copy.privacy(shelterName)}</p>
          <ApplicationStepper
            user={user}
            petId={petId}
            petName={petName}
            slug={slug}
            shelterName={shelterName}
            questions={questions}
            contract={contract}
            petFacts={petFacts}
          />
        </div>
      );
  }
}

/**
 * Signed out: what this is (a request, completed in person, signed on paper),
 * why an account is needed, a sign-in link that RETURNS here, and the
 * commitments to read BEFORE creating an account (D13). Presentational.
 */
export function SignInGate({ slug }: { slug: string }) {
  const copy = t.applications;
  const steps = t.applicationSteps;
  return (
    <div className="apply-gate">
      <p className="auth__prose">{steps.gateIntro}</p>
      <p className="auth__prose">{copy.signInPrompt}</p>
      <Link href={signInHrefReturningTo(`/adopt/${slug}/apply`)} className="btn btn--action">
        {copy.signInButton}
      </Link>
      <Link href="/adopt/contract" className="auth__link">
        {steps.readContract}
      </Link>
    </div>
  );
}

/**
 * Already applied: the status, never a second form — and "Falta tu carnet"
 * with the upload while the ID photo is missing. This page only renders while
 * applications are switched on, so the upload is offered unconditionally here
 * (`/account` checks the switch, because it renders either way). Presentational:
 * the uploader is handed in.
 */
export function ExistingApplication({
  application,
  justUploaded,
  uploader,
}: {
  application: MyApplication;
  justUploaded: boolean;
  uploader: ReactNode;
}) {
  const copy = t.applications;
  const steps = t.applicationSteps;
  return (
    <div className="apply-gate">
      <p className="auth__notice" role="status">
        {copy.alreadyApplied}{' '}
        <strong className="app-status">{t.applicantStatusLabel(application.status)}</strong>
      </p>
      <p className="auth__prose">{t.applicantStatusExplanation(application.status)}</p>
      {application.idDocumentMissing ? (
        <div className="id-missing">
          <p className="auth__notice auth__notice--warn">{steps.carnetMissing}</p>
          {uploader}
        </div>
      ) : (
        justUploaded && (
          <p className="auth__notice" role="status">
            {steps.uploadDone}
          </p>
        )
      )}
      <Link href="/account" className="btn btn--brand">
        {copy.goToAccount}
      </Link>
    </div>
  );
}

export { ApplicationSent } from './ApplicationSent';
