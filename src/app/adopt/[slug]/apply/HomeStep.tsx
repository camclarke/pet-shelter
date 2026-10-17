/**
 * Step 3 — the address, which goes ONLY into `private/home` (admin-only, read
 * back by the applicant, erasable). Values in, changes out: the only state
 * held here is whether the map is open and whether it failed.
 *
 * The three labels are the paper's, verbatim, from config (`homeLabels`); the
 * hints are ours. The paper's CROQUIS UBICACIÓN is an OPTIONAL pin (owner
 * decision, 2026-10-17): the typed address is required, the map is not, so the
 * form still works when the map cannot load.
 *
 * The map is not loaded until the person taps «Marcar mi casa en el mapa»: a
 * person who skips it never contacts OpenStreetMap's tile server.
 *
 * `autoComplete="off"`: an address typed on a shared family phone must not be
 * offered back to the next person by the browser.
 */

'use client';

import { useState } from 'react';
import type { ApplicationConfig } from '@/config/shelter';
import {
  HOME_ADDRESS_MAX_CHARS,
  HOME_REFERENCE_MAX_CHARS,
  type HomeValidation,
  type PinCoordinates,
} from '@/lib/applications';
import { LazyAddressMap, type LazyAddressMapProps } from '@/components/LazyAddressMap';
import { t } from '@/i18n';

export const HOME_ADDRESS_DOM_ID = 'apply-home-address';
export const HOME_DETAILS_DOM_ID = 'apply-home-details';
export const HOME_MAP_DOM_ID = 'apply-home-map';

export interface HomeStepProps {
  labels: ApplicationConfig['homeLabels'];
  petName: string;
  addressText: string;
  reference: string;
  pin: PinCoordinates | null;
  errors: HomeValidation['errors'];
  disabled: boolean;
  onChange: (field: 'addressText' | 'reference', value: string) => void;
  /** A new mark, or null for «Quitar la marca». */
  onPin: (pin: PinCoordinates | null) => void;
  /** Replaces the map's dynamic import; tests pass a fake. */
  loadMap?: LazyAddressMapProps['load'];
}

export function HomeStep({
  labels,
  petName,
  addressText,
  reference,
  pin,
  errors,
  disabled,
  onChange,
  onPin,
  loadMap,
}: HomeStepProps) {
  // Open on return to this step with a mark, so the person sees what they marked.
  const [mapOpen, setMapOpen] = useState(pin !== null);
  const [mapFailed, setMapFailed] = useState(false);
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

      <div
        id={HOME_MAP_DOM_ID}
        className={`auth__field apply-field apply-map${errors.pin ? ' apply-field--invalid' : ''}`}
        role="group"
        aria-labelledby={`${HOME_MAP_DOM_ID}-label`}
        aria-describedby={`${HOME_MAP_DOM_ID}-hint`}
        tabIndex={-1}
      >
        <span id={`${HOME_MAP_DOM_ID}-label`} className="apply-field__label">
          {labels.map} <small className="apply-field__mark">({copy.optionalMark})</small>
        </span>
        <small id={`${HOME_MAP_DOM_ID}-hint`} className="auth__hint">
          {steps.mapHint}
        </small>

        {mapFailed ? (
          <p className="auth__hint apply-map__status" role="status">
            {steps.mapFailed}
          </p>
        ) : mapOpen ? (
          <>
            <p className="auth__hint apply-map__status" aria-live="polite">
              {pin ? steps.mapMarked : steps.mapTap}
            </p>
            <LazyAddressMap
              pin={pin}
              onPin={disabled ? undefined : (next) => onPin(next)}
              onFailed={() => setMapFailed(true)}
              label={steps.mapLabel}
              loadingText={steps.mapLoading}
              load={loadMap}
            />
          </>
        ) : (
          <button type="button" className="btn btn--ghost apply-map__open" disabled={disabled} onClick={() => setMapOpen(true)}>
            {steps.mapOpen}
          </button>
        )}

        {pin && (
          <button type="button" className="btn btn--ghost apply-map__clear" disabled={disabled} onClick={() => onPin(null)}>
            {steps.mapClear}
          </button>
        )}

        {errors.pin && (
          <small id={`${HOME_MAP_DOM_ID}-error`} className="apply-field__error" role="alert">
            {t.applicationHomeError(errors.pin)}
          </small>
        )}
      </div>
    </>
  );
}
