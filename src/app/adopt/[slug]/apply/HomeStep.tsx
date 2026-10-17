/**
 * Step 3 — the address, which goes ONLY into `private/home` (admin-only, read
 * back by the applicant, erasable). PRESENTATIONAL ONLY: values in, changes out.
 *
 * The two labels are the paper's, verbatim, from config (`homeLabels`); the
 * hints are ours. The paper's CROQUIS UBICACIÓN is the map pin of portion 4d
 * and is NOT shown here — never a dead field, never a promise of a map. Until
 * then NÚMERO DE CASA Y DETALLES carries the directions, and the pin is sent
 * as null.
 *
 * `autoComplete="off"`: an address typed on a shared family phone must not be
 * offered back to the next person by the browser.
 */

'use client';

import type { ApplicationConfig } from '@/config/shelter';
import {
  HOME_ADDRESS_MAX_CHARS,
  HOME_REFERENCE_MAX_CHARS,
  type HomeValidation,
} from '@/lib/applications';
import { t } from '@/i18n';

export const HOME_ADDRESS_DOM_ID = 'apply-home-address';
export const HOME_DETAILS_DOM_ID = 'apply-home-details';

export interface HomeStepProps {
  labels: ApplicationConfig['homeLabels'];
  petName: string;
  addressText: string;
  reference: string;
  errors: HomeValidation['errors'];
  disabled: boolean;
  onChange: (field: 'addressText' | 'reference', value: string) => void;
}

export function HomeStep({ labels, petName, addressText, reference, errors, disabled, onChange }: HomeStepProps) {
  const copy = t.applications;
  const steps = t.applicationSteps;
  const fields = [
    {
      field: 'addressText' as const,
      id: HOME_ADDRESS_DOM_ID,
      label: labels.address,
      hint: steps.addressHint,
      required: true,
      value: addressText,
      max: HOME_ADDRESS_MAX_CHARS,
      rows: 3,
      error: errors.addressText,
    },
    {
      field: 'reference' as const,
      id: HOME_DETAILS_DOM_ID,
      label: labels.details,
      hint: steps.detailsHint,
      required: false,
      value: reference,
      max: HOME_REFERENCE_MAX_CHARS,
      rows: 3,
      error: errors.reference,
    },
  ];

  return (
    <>
      <p className="auth__prose apply-step__lead">{steps.addressLead(petName)}</p>
      {fields.map((f) => {
        const describedBy = [`${f.id}-hint`, f.error ? `${f.id}-error` : null].filter(Boolean).join(' ');
        return (
          <label
            key={f.field}
            className={`auth__field apply-field${f.error ? ' apply-field--invalid' : ''}`}
            htmlFor={f.id}
          >
            <span className="apply-field__label">
              {f.label}{' '}
              <small className="apply-field__mark">({f.required ? copy.requiredMark : copy.optionalMark})</small>
            </span>
            <small id={`${f.id}-hint`} className="auth__hint">
              {f.hint}
            </small>
            <textarea
              id={f.id}
              name={f.field}
              rows={f.rows}
              maxLength={f.max}
              autoComplete="off"
              disabled={disabled}
              value={f.value}
              aria-describedby={describedBy}
              aria-invalid={f.error ? true : undefined}
              onChange={(event) => onChange(f.field, event.target.value)}
            />
            {f.error && (
              <small id={`${f.id}-error`} className="apply-field__error" role="alert">
                {t.applicationHomeError(f.error)}
              </small>
            )}
          </label>
        );
      })}
    </>
  );
}
