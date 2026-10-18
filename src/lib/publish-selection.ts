/**
 * Which register animals are ready to publish — pure, no Firebase import.
 *
 * Used by `scripts/publish-ready-drafts.mjs`, the one-off bulk publish that
 * followed the owner's 2026-10-18 decision ("to publish a dog, only a name and
 * a picture are required"). Kept out of the script so it is testable: a
 * selector that quietly widens is how a description such as "BB3 (pomposo, con
 * negro)" ends up as an animal's public name.
 *
 * An animal is READY when all of these hold:
 *
 *   1. its register row says it is in the shelter today (`in-shelter`);
 *   2. the row points at a draft that still exists — a pet already published
 *      has no draft, and is not selected twice;
 *   3. the draft carries a REAL name (see `draftHasRealName`);
 *   4. the publish gate itself has nothing to say — `publishBlockers`, the same
 *      function the wizard's Publicar button obeys, so a photo that can be
 *      shown and the two microchip checks are decided in ONE place.
 */

import { publishBlockers, slugify, type IntakeError, type PetDraft } from './intake';
import type { RegisterStatus, Species } from './types';

/** The register-row fields the selector reads. */
export interface SelectionEntry {
  no: number;
  status: RegisterStatus;
  petId: string | null;
  /** The importer's own verdict on the name cell: a name, or a description. */
  hasRealName: boolean;
  name: string;
  nameRaw: string;
  species: Species | null;
}

export type SkipReason =
  | 'not-in-shelter'
  | 'no-draft'
  | 'no-real-name'
  | Exclude<IntakeError, 'name-required'>;

export interface ReadyDraft {
  no: number;
  draft: PetDraft;
  /** Where the published species comes from: the draft, the register, or nowhere. */
  speciesSource: 'draft' | 'register' | 'none';
  species: Species | null;
}

export interface SelectionResult {
  ready: ReadyDraft[];
  skipped: { no: number; reason: SkipReason }[];
}

/**
 * Whether a draft's name is a NAME, by the importer's own rule.
 *
 * The register import decided, per row, whether the name cell holds a name or
 * a description (`hasRealName`), and wrote a description-row's draft with an
 * EMPTY name precisely so it could never be published as one. So:
 *
 *   - a row with a real name: the draft's name counts if it is not blank;
 *   - a description row: the draft's name counts only if a PERSON replaced
 *     the blank with something that is not the description itself — a volunteer
 *     copying "BB3" into the name field has not named the animal.
 *
 * No new heuristic is invented here; this is `hasRealName` applied to the
 * draft, compared through `slugify` so case, accents and punctuation do not
 * make the description look different from itself.
 */
export function draftHasRealName(draft: Pick<PetDraft, 'name'>, entry: Pick<SelectionEntry, 'hasRealName' | 'name' | 'nameRaw'>): boolean {
  const name = draft.name.trim();
  if (name === '') return false;
  if (entry.hasRealName) return true;
  const typed = slugify(name);
  if (typed === '') return false;
  return typed !== slugify(entry.nameRaw) && typed !== slugify(entry.name);
}

/**
 * Pick the ready animals out of the register.
 *
 * `drafts` is keyed by draft id. Order of the result follows the register
 * number, so the dry run reads like the paper.
 */
export function selectReadyDrafts(
  entries: readonly SelectionEntry[],
  drafts: ReadonlyMap<string, PetDraft>,
): SelectionResult {
  const ready: ReadyDraft[] = [];
  const skipped: { no: number; reason: SkipReason }[] = [];

  for (const entry of [...entries].sort((a, b) => a.no - b.no)) {
    if (entry.status !== 'in-shelter') {
      skipped.push({ no: entry.no, reason: 'not-in-shelter' });
      continue;
    }
    const draft = entry.petId ? drafts.get(entry.petId) : undefined;
    if (!draft) {
      skipped.push({ no: entry.no, reason: 'no-draft' });
      continue;
    }
    if (!draftHasRealName(draft, entry)) {
      skipped.push({ no: entry.no, reason: 'no-real-name' });
      continue;
    }
    const blockers = publishBlockers(draft).filter((code) => code !== 'name-required');
    if (blockers.length > 0) {
      skipped.push({ no: entry.no, reason: blockers[0] as SkipReason });
      continue;
    }
    const species = draft.species ?? entry.species ?? null;
    ready.push({
      no: entry.no,
      draft,
      species,
      speciesSource: draft.species ? 'draft' : entry.species ? 'register' : 'none',
    });
  }

  return { ready, skipped };
}
