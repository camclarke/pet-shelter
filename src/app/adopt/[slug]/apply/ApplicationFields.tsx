/**
 * The questions, rendered. PRESENTATIONAL ONLY: no Firebase, no auth, no
 * effects — values in, changes out.
 *
 * Kept apart from `ApplicationForm` so the markup can be rendered to static HTML
 * and measured at 360px against the real stylesheet without signing anyone in,
 * which is the only way it can be checked on a night with no browser sign-in.
 *
 * ── Mobile decisions ──────────────────────────────────────────────────────
 * - Choices are RADIO CARDS, not a <select>. Five options behind a native
 *   picker on a phone are five taps and a scroll; radios are visible at once,
 *   and each card is a 44px target rather than a 20px circle.
 * - A count is a text input with `inputMode="numeric"`, not `type="number"`:
 *   the number type grows spinner arrows and, in es-BO locales, can read "2,5"
 *   as empty. The validator refuses decimals either way.
 * - Every input stays at 16px (from `.auth__field`), or iOS Safari zooms on focus.
 */

'use client';

import type { ApplicationQuestion, ApplicationSection } from '@/config/shelter';
import type { AnswerDraft, AnswerDraftValue, ApplicationAnswerError } from '@/lib/applications';
import { ANSWER_MAX_CHARS } from '@/lib/applications';
import { t } from '@/i18n';

const SECTION_ORDER: ApplicationSection[] = [
  'contact',
  'housing',
  'household',
  'otherPets',
  'experience',
  'why',
];

export function questionDomId(id: string): string {
  return `apply-q-${id}`;
}

export interface ApplicationFieldsProps {
  questions: readonly ApplicationQuestion[];
  draft: AnswerDraft;
  errors: Record<string, ApplicationAnswerError>;
  disabled: boolean;
  onChange: (id: string, value: AnswerDraftValue) => void;
}

export function ApplicationFields({ questions, draft, errors, disabled, onChange }: ApplicationFieldsProps) {
  const copy = t.applications;

  return (
    <>
      {SECTION_ORDER.map((section) => {
        const inSection = questions.filter((q) => q.section === section);
        if (inSection.length === 0) return null;
        return (
          <fieldset key={section} className="admin-form__fieldset apply-section">
            <legend className="t-label">{t.applicationSectionLabel(section)}</legend>
            {inSection.map((question) => {
              const id = questionDomId(question.id);
              const error = errors[question.id];
              const describedBy = [question.hint ? `${id}-hint` : null, error ? `${id}-error` : null]
                .filter(Boolean)
                .join(' ') || undefined;
              const value = draft[question.id] ?? null;

              const label = (
                <span className="apply-field__label">
                  {question.label}{' '}
                  <small className="apply-field__mark">
                    ({question.required ? copy.requiredMark : copy.optionalMark})
                  </small>
                </span>
              );

              const hint = question.hint ? (
                <small id={`${id}-hint`} className="auth__hint">
                  {question.hint}
                </small>
              ) : null;

              const errorLine = error ? (
                <small id={`${id}-error`} className="apply-field__error" role="alert">
                  {t.applicationAnswerError(error)}
                </small>
              ) : null;

              if (question.kind === 'choice' || question.kind === 'yesNo') {
                const options =
                  question.kind === 'yesNo'
                    ? [
                        { value: 'true', label: t.yesNo(true) },
                        { value: 'false', label: t.yesNo(false) },
                      ]
                    : (question.options ?? []);
                const current = question.kind === 'yesNo' ? (value === null ? '' : String(value)) : String(value ?? '');
                return (
                  <div
                    key={question.id}
                    className={`apply-field${error ? ' apply-field--invalid' : ''}`}
                    role="radiogroup"
                    id={id}
                    aria-labelledby={`${id}-label`}
                    aria-describedby={describedBy}
                    aria-invalid={error ? true : undefined}
                  >
                    <span id={`${id}-label`}>{label}</span>
                    {hint}
                    <div className="apply-options">
                      {options.map((option) => (
                        <label key={option.value} className="apply-option">
                          <input
                            type="radio"
                            name={id}
                            value={option.value}
                            checked={current === option.value}
                            disabled={disabled}
                            onChange={() =>
                              onChange(
                                question.id,
                                question.kind === 'yesNo' ? option.value === 'true' : option.value,
                              )
                            }
                          />
                          <span>{option.label}</span>
                        </label>
                      ))}
                    </div>
                    {errorLine}
                  </div>
                );
              }

              const common = {
                id,
                name: question.id,
                disabled,
                'aria-describedby': describedBy,
                'aria-invalid': error ? true : undefined,
                value: typeof value === 'string' ? value : '',
              } as const;

              return (
                <label
                  key={question.id}
                  className={`auth__field apply-field${error ? ' apply-field--invalid' : ''}`}
                  htmlFor={id}
                >
                  {label}
                  {hint}
                  {question.kind === 'longText' ? (
                    <textarea
                      {...common}
                      rows={4}
                      maxLength={ANSWER_MAX_CHARS.longText}
                      onChange={(event) => onChange(question.id, event.target.value)}
                    />
                  ) : (
                    <input
                      {...common}
                      type={question.kind === 'phone' ? 'tel' : 'text'}
                      inputMode={question.kind === 'count' ? 'numeric' : question.kind === 'phone' ? 'tel' : undefined}
                      autoComplete={
                        question.purpose === 'applicantName'
                          ? 'name'
                          : question.purpose === 'applicantPhone'
                            ? 'tel'
                            : 'off'
                      }
                      maxLength={
                        question.kind === 'count'
                          ? 2
                          : question.kind === 'phone'
                            ? ANSWER_MAX_CHARS.phone
                            : ANSWER_MAX_CHARS.shortText
                      }
                      onChange={(event) => onChange(question.id, event.target.value)}
                    />
                  )}
                  {errorLine}
                </label>
              );
            })}
          </fieldset>
        );
      })}
    </>
  );
}
