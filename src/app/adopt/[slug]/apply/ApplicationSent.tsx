/**
 * The confirmation, once the application AND the carnet photo have arrived.
 * Every line of it is true — see `confirmationSteps` in the es catalogue, plus
 * the two lines portion 4c-2 adds: the acceptance is recorded, and only
 * the shelter team sees the carnet photo. No line promises a retention period
 * (that copy arrives with /privacy in 4f).
 *
 * Focus moves to its heading when it appears (review 4c-2 #8), so a screen
 * reader announces that the application arrived instead of staying silent on
 * a button that no longer exists.
 *
 * Its own file (it used to live in ApplicationForm.tsx) so the stepper can
 * render it without ApplicationForm and ApplicationStepper importing each other.
 */

'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';

import { t } from '@/i18n';

export function ApplicationSent({
  petName,
  shelterName,
  slug,
  withCarnetLines = true,
}: {
  petName: string;
  shelterName: string;
  slug: string;
  /** The two 4c-2 lines: the acceptance is recorded; the carnet seen by the team only. */
  withCarnetLines?: boolean;
}) {
  const copy = t.applications;
  const steps = t.applicationSteps;
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const lines = [
    ...copy.confirmationSteps(petName, shelterName),
    ...(withCarnetLines ? [steps.confirmationAccepted, steps.confirmationCarnet] : []),
  ];
  return (
    <div className="apply-sent" role="status">
      <h2 className="t-title apply-sent__title" tabIndex={-1} ref={heading}>
        {copy.confirmationTitle}
      </h2>
      <ol className="apply-steps">
        {lines.map((step) => (
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
