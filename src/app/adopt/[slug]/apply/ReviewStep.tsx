/**
 * Step 7 — review and send. PRESENTATIONAL ONLY: values in, events out.
 *
 * In order, top to bottom:
 *   1. a summary of every step, each with «Cambiar»;
 *   2. DATOS DEL PELUDITO ADOPTADO — the paper's section 4, filled from the
 *      PUBLIC pet document, read-only, never stored (D16);
 *   3. the contract, FILLED IN with the name and C.I. typed in step 4, and the
 *      note that it is signed on paper at handover (D11);
 *   4. the acceptance box — unticked by default, never pre-ticked — with the
 *      draft marker while the owner and the lawyer have not approved the words;
 *   5. "Enviar no es la adopción…", then the one action, "Enviar solicitud".
 *
 * The button is NEVER disabled for an unticked box: the error appears beside
 * the box instead, so the person learns why rather than meeting a dead button.
 * Consent is the last act, tied to the contract version shown.
 */

'use client';

import type { AdoptionContract } from '@/config/adoption-contract';
import type { ApplicationStep, PetFact, ReviewRow } from '@/lib/application-steps';
import { t } from '@/i18n';
import { ContractText } from './ContractText';

export interface ReviewGroup {
  step: ApplicationStep;
  title: string;
  rows: readonly ReviewRow[];
  /** A one-line summary in place of rows (the carnet: "Foto lista para enviar."). */
  summary?: string;
}

export type SendingPhase = 'idle' | 'application' | 'photo';

export interface ReviewStepProps {
  groups: readonly ReviewGroup[];
  petFactsTitle: string;
  petFacts: readonly PetFact[];
  contract: AdoptionContract;
  fill: { name: string | null; ci: string | null };
  /** `ADOPTION_ACCEPTANCE.label` with the animal's name already in it. */
  acceptanceLabel: string;
  acceptanceIsDraft: boolean;
  accepted: boolean;
  acceptanceError: boolean;
  sending: SendingPhase;
  notice: string | null;
  onEdit: (step: ApplicationStep) => void;
  onAccept: (accepted: boolean) => void;
  onSubmit: () => void;
}

export const ACCEPTANCE_DOM_ID = 'apply-acceptance';

export function ReviewStep({
  groups,
  petFactsTitle,
  petFacts,
  contract,
  fill,
  acceptanceLabel,
  acceptanceIsDraft,
  accepted,
  acceptanceError,
  sending,
  notice,
  onEdit,
  onAccept,
  onSubmit,
}: ReviewStepProps) {
  const copy = t.applicationSteps;
  const applications = t.applications;
  const busy = sending !== 'idle';

  return (
    <>
      <p className="auth__prose apply-step__lead">{copy.reviewLead}</p>

      {groups.map((group) => (
        <section key={group.step} className="apply-review__group">
          <div className="apply-review__head">
            <h3 className="t-label apply-review__title">{group.title}</h3>
            <button
              type="button"
              className="auth__link"
              onClick={() => onEdit(group.step)}
              disabled={busy}
              aria-label={copy.changeStep(group.title)}
            >
              {copy.change}
            </button>
          </div>
          {group.summary ? (
            <p className="apply-review__summary">{group.summary}</p>
          ) : (
            <dl className="apply-review__rows">
              {group.rows.map((row) => (
                <div key={row.id} className="apply-review__row">
                  <dt>{row.label}</dt>
                  <dd className={row.value === null ? 'apply-review__empty' : undefined}>
                    {row.value === null
                      ? applications.notAnswered
                      : typeof row.value === 'boolean'
                        ? t.yesNo(row.value)
                        : row.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      ))}

      <section className="apply-review__group apply-review__pet">
        <div className="apply-review__head">
          <h3 className="t-label apply-review__title">{petFactsTitle}</h3>
        </div>
        <dl className="apply-review__rows">
          {petFacts.map((fact) => (
            <div key={fact.label} className="apply-review__row">
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <p className="auth__prose apply-step__lead">{copy.contractFilledLead}</p>
      <ContractText contract={contract} mode="filled" name={fill.name} ci={fill.ci} />
      <aside className="apply-paper-note">{copy.paperNote}</aside>

      <div className={`apply-accept${acceptanceError ? ' apply-accept--invalid' : ''}`}>
        <label className="apply-accept__box" htmlFor={ACCEPTANCE_DOM_ID}>
          <input
            id={ACCEPTANCE_DOM_ID}
            type="checkbox"
            checked={accepted}
            disabled={busy}
            aria-describedby={acceptanceError ? `${ACCEPTANCE_DOM_ID}-error` : undefined}
            aria-invalid={acceptanceError ? true : undefined}
            onChange={(event) => onAccept(event.target.checked)}
          />
          <span>{acceptanceLabel}</span>
        </label>
        {acceptanceIsDraft && <small className="apply-accept__draft">{copy.acceptanceDraftTag}</small>}
        {acceptanceError && (
          <small id={`${ACCEPTANCE_DOM_ID}-error`} className="apply-field__error" role="alert">
            {copy.acceptanceRequired}
          </small>
        )}
      </div>

      {notice && (
        <p className="auth__error" role="alert">
          {notice}
        </p>
      )}

      <p className="auth__hint apply-review__before">{copy.beforeSend}</p>
      <button type="button" className="btn btn--action apply-step__primary" onClick={onSubmit} disabled={busy}>
        {applications.submit}
      </button>
      {busy && (
        <p className="auth__hint" role="status" aria-live="polite">
          {sending === 'application' ? copy.sendingApplication : copy.sendingPhoto}
        </p>
      )}
    </>
  );
}
