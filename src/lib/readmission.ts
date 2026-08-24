/**
 * Re-admission — the chip is a deduplication key, not just a field.
 *
 * Plan section 3.1, build order step 6. Shelters take the same street animal in
 * more than once: a returned adoption, a recaptured stray, a transfer back from
 * a foster. A linear "create new pet" wizard answers that with a second
 * document, and then the medical history is split across two records with
 * neither one complete. That is the failure this system exists to prevent, so
 * step 1 of intake is a LOOKUP before it is an entry form.
 *
 * ── Pure on purpose ────────────────────────────────────────────────────────
 * No Firestore import, for the same reason `placements.ts` has none: every
 * decision here is derivable from its arguments, so it is exercisable without a
 * database, a network, or an admin credential. `pets-admin.ts` does the reads
 * and writes; this module decides what they should be.
 *
 * ⚠️ No user-facing words here either. Outcomes are returned as tagged unions
 * and the locale decides the wording.
 */

import type { PetSex, PetSize, PetStatus, Species } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// What a lookup returns
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The public tier of a pet a chip resolved to, which is all that is needed to
 * answer "is this the same animal?".
 *
 * Deliberately not the whole expediente. Confirming identity is a glance at a
 * photo, a name and a status — and the admin can follow the link to the full
 * record if that is not enough. Pulling five documents to render a
 * confirmation card would make the lookup slow enough to be skipped.
 */
export interface ChipMatch {
  id: string;
  slug: string;
  name: string;
  formerNames: string[];
  status: PetStatus;
  coverPhoto: string | null;
  species: Species;
  sex: PetSex;
  size: PetSize;
  breed: string;
  ageMonths: number | null;
}

/**
 * What the shelter should be shown after a chip is looked up.
 *
 * `ambiguous` exists because it is the one outcome a `limit(1)` query cannot
 * distinguish from `registered`, and silently picking the first of two animals
 * carrying the same credential is precisely the wrong answer — the chip number
 * is how ownership gets asserted, so two claimants is a fact a human has to
 * resolve, not one the query should hide. `findPetByMicrochipAdmin` therefore
 * reads two documents rather than one.
 */
export type ChipVerdict =
  /** Nothing carries this code. Continue as a new intake. */
  | { kind: 'unregistered' }
  /** Exactly one animal carries it. Offer to reopen its record. */
  | { kind: 'registered'; pet: ChipMatch }
  /** More than one does. Should be impossible; surface it rather than choose. */
  | { kind: 'ambiguous'; pets: ChipMatch[] };

export function readChipMatches(matches: readonly ChipMatch[]): ChipVerdict {
  if (matches.length === 0) return { kind: 'unregistered' };
  if (matches.length === 1) return { kind: 'registered', pet: matches[0]! };
  return { kind: 'ambiguous', pets: [...matches] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Names
// ─────────────────────────────────────────────────────────────────────────────

/** Trimmed, case-insensitive. "luna" and "Luna" are not a rename. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
}

/**
 * The `formerNames` chain after a re-admission that may have renamed the animal.
 *
 * The invariant is simple and worth stating, because it is what makes the
 * "wasn't this Luna?" question answerable years later: **`formerNames` holds
 * every name this animal has had that is not its current one**, oldest first.
 *
 * Two consequences that are easy to get wrong:
 *
 *   - Reverting to an older name REMOVES it from the chain rather than
 *     duplicating it. A pet called Luna, renamed Sol, then called Luna again on
 *     re-admission ends up `name: 'Luna'`, `formerNames: ['Sol']` — because
 *     Luna is no longer former. Appending blindly would leave Luna in both
 *     places and make the chain self-contradictory.
 *   - Nothing is ever dropped otherwise. A re-admission APPENDS history; it
 *     does not overwrite it.
 */
export function nextFormerNames(
  current: { name: string; formerNames: readonly string[] },
  newName: string,
): string[] {
  const next = newName.trim();
  if (next.length === 0 || sameName(current.name, next)) {
    return [...current.formerNames];
  }

  const chain = [...current.formerNames, current.name];

  const seen = new Set<string>();
  return chain.filter((candidate) => {
    if (sameName(candidate, next)) return false;
    const key = candidate.trim().toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The re-admission itself
// ─────────────────────────────────────────────────────────────────────────────

export interface ReadmissionInput {
  /** What the animal is called now. Blank means "unchanged". */
  name: string;
  /** Where it is going. Defaults to the shelter, never to the public wall. */
  status: PetStatus;
  /** Free text for the custody and scan records. May be empty. */
  note: string;
}

export interface ReadmissionPlan {
  /** The name to write. Unchanged unless the admin typed a different one. */
  name: string;
  formerNames: string[];
  status: PetStatus;
  /** True when the name actually changed, so the UI can say so. */
  renamed: boolean;
  /** True when the animal was not already at the shelter under this status. */
  statusChanged: boolean;
  note: string | null;
}

/**
 * What a re-admission changes on the public document — and, just as
 * importantly, what it does not.
 *
 * **Reopening writes history, it does not overwrite it.** The existing medical
 * records, the microchip identity and the photographs all stay exactly where
 * they are; this returns only the handful of public-tier fields that legitimately
 * move when an animal comes back. `reopenPet()` appends a `CustodyEvent` and a
 * `ScanEvent` alongside, which is where the *fact of the re-admission* lives.
 * If this function ever grows a field that deletes something, that is the bug.
 */
export function planReadmission(pet: ChipMatch, input: ReadmissionInput): ReadmissionPlan {
  const typed = input.name.trim();
  const renamed = typed.length > 0 && !sameName(pet.name, typed);
  const note = input.note.trim();

  return {
    name: renamed ? typed : pet.name,
    formerNames: nextFormerNames(pet, input.name),
    status: input.status,
    renamed,
    statusChanged: pet.status !== input.status,
    note: note.length > 0 ? note : null,
  };
}

/**
 * The custody kind a status implies.
 *
 * `CustodyKind` and `PetStatus` overlap without being the same vocabulary —
 * custody answers "who is legally responsible", status answers "where is it and
 * can it be adopted". `available` and `quarantine` are both the shelter holding
 * the animal; only the second says anything about custody at all.
 */
export function custodyKindForStatus(status: PetStatus): 'shelter' | 'foster' | 'adopter' {
  if (status === 'foster') return 'foster';
  if (status === 'adopted') return 'adopter';
  return 'shelter';
}

/**
 * Statuses a re-admission may set.
 *
 * `adopted` and `lost` are excluded deliberately: an animal being readmitted is
 * by definition back in the shelter's hands, so offering "adoptado" would be
 * offering a contradiction. `available` is offered but is not the default —
 * publishing to the front page of a live shelter's site stays a decision.
 */
export const READMISSION_STATUSES: PetStatus[] = [
  'shelter',
  'quarantine',
  'foster',
  'available',
];
