/**
 * What the public dossier (`/adopt/{slug}`) shows beyond the name and photo.
 *
 * Pure, so each rule is testable without rendering a page. The words come from
 * `t`; the decisions about WHEN to show a line live here.
 */

import { t } from '@/i18n';
import type { Pet } from './types';

type AgeFields = Pick<Pet, 'ageMonths' | 'ageMonthsMin' | 'ageMonthsMax' | 'ageIsEstimate'>;

/**
 * "entre 1 y 3 años", only for an ESTIMATED age that really is a range.
 * Anything else returns null and the single age (`petFacts`) stands.
 *
 * `?? null` throughout: a pet published before these fields existed has them
 * undefined at runtime, whatever the type claims.
 */
export function dossierAgeRange(pet: Partial<AgeFields>): string | null {
  const min = pet.ageMonthsMin ?? null;
  const max = pet.ageMonthsMax ?? null;
  if (pet.ageIsEstimate !== true || min === null || max === null) return null;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || min >= max) return null;
  return t.formatAgeRange(min, max);
}

/**
 * The facts line under the name. A range REPLACES the single age rather than
 * joining it, so age is never printed twice.
 */
export function dossierFacts(pet: Parameters<typeof t.petFacts>[0] & Partial<AgeFields>): string {
  const range = dossierAgeRange(pet);
  const base = t.petFacts(pet, { age: range === null });
  return [base, range].filter((part): part is string => !!part).join(' · ');
}

/**
 * The story as paragraphs, split on blank lines. Plain text only: the page
 * renders each as a text node (React escapes it) with `white-space: pre-line`
 * so single line breaks survive. Empty array when there is no story.
 */
export function storyParagraphs(story: string | null | undefined): string[] {
  if (typeof story !== 'string') return [];
  return story
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}
