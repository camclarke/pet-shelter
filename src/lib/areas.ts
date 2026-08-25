/**
 * Shelter areas: validation, occupancy arithmetic, and the warnings a move
 * should raise before it is made. Pure functions, no Firestore import.
 *
 * Same split as `placements.ts` / `placements-server.ts` and `intake.ts` /
 * `pets-admin.ts`, and for the same reason: everything here is decidable from
 * its arguments, so it is testable without a database, a network, or an admin
 * credential. The Firestore layer's job is to hand this module arrays.
 *
 * ⚠️ No user-facing words in this file. Failures come back as an `AreaError`
 * union and warnings as a `PlacementWarning` union; `src/i18n` decides the
 * wording. The same split `MicrochipError`, `IntakeError` and `AuthError`
 * already use.
 *
 * ── Why the warnings are warnings and never blocks ────────────────────────
 * Plan section 3 is explicit that a gate stricter than the shelter's reality
 * gets worked around, and the workaround is the WhatsApp group this system
 * exists to replace. A pen being over capacity is a fact the manager must see
 * before deciding — it is not grounds for the software to refuse an animal
 * that is already standing in the yard. So every function below informs; none
 * of them refuses.
 */

import type { Area, AreaKind, PetStatus, PlacementReason } from './types';
import { canTransition } from './arrival';
import { MS_PER_DAY, type PlacementInterval } from './placements';

// ─────────────────────────────────────────────────────────────────────────────
// Names
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The comparison form of an area name — trimmed, case-folded, inner whitespace
 * collapsed, accents removed.
 *
 * This exists to catch one specific, expensive mistake: typing "Cuarentena 2"
 * on Monday and "cuarentena  2" on Friday creates TWO areas that are one pen.
 * Nothing about that looks wrong in a list, and the consequence is silent —
 * occupancy splits across both, so a full pen reads as half full, and an
 * outbreak trace filtered by `areaId` misses every animal recorded under the
 * other spelling. That is the "query broken, looks like no data" failure this
 * project keeps meeting, in a form a human creates by typing.
 *
 * Deliberately NOT used as the document id. The area's name is data the
 * shelter types and may correct; the id must not move when they do.
 */
export function normalizeAreaName(name: string): string {
  return name
    .trim()
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

/** The editable shape behind the area form. */
export interface AreaDraft {
  name: string;
  kind: AreaKind | null;
  /** null means "we have not counted", not "unlimited". */
  capacity: number | null;
  active: boolean;
  notes: string;
}

export type AreaError =
  | 'name-required'
  | 'name-too-long'
  | 'name-duplicate'
  | 'kind-required'
  | 'capacity-invalid';

/** Long enough for "Cuarentena 2 (fondo, junto al portón)", short enough to render. */
export const AREA_NAME_MAX = 60;

export function emptyAreaDraft(): AreaDraft {
  return { name: '', kind: null, capacity: null, active: true, notes: '' };
}

export function areaToDraft(area: Area): AreaDraft {
  return {
    name: area.name,
    kind: area.kind,
    capacity: area.capacity,
    active: area.active,
    notes: area.notes ?? '',
  };
}

/**
 * `otherNames` is every OTHER area's name — the one being edited must be
 * excluded by the caller, or renaming an area to itself reports a duplicate.
 */
export function validateArea(draft: AreaDraft, otherNames: readonly string[]): AreaError[] {
  const errors: AreaError[] = [];

  const name = draft.name.trim();
  if (name.length === 0) errors.push('name-required');
  else if (name.length > AREA_NAME_MAX) errors.push('name-too-long');
  else {
    const normalized = normalizeAreaName(name);
    if (otherNames.some((other) => normalizeAreaName(other) === normalized)) {
      errors.push('name-duplicate');
    }
  }

  if (draft.kind === null) errors.push('kind-required');

  // null is a legitimate answer — the ASV guidance is about crowding, and a
  // shelter that has not counted a pen's capacity should say so rather than
  // invent a number. What is not legitimate is a non-positive or fractional
  // one, which would make every occupancy figure derived from it nonsense.
  if (draft.capacity !== null) {
    if (!Number.isInteger(draft.capacity) || draft.capacity < 1) errors.push('capacity-invalid');
  }

  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// Occupancy
// ─────────────────────────────────────────────────────────────────────────────

export type CapacityState = 'unknown' | 'ok' | 'full' | 'over';

export interface AreaSummary {
  areaId: string;
  /** Distinct animals with an OPEN placement here. */
  count: number;
  capacity: number | null;
  /** null when capacity is unknown. Negative is impossible — see `over`. */
  free: number | null;
  state: CapacityState;
  /**
   * When the most recent animal arrived in this area, epoch ms, or null if it
   * is empty.
   *
   * Plan section 13.3: adding a new animal to an occupied quarantine pen
   * restarts the observation clock for everyone already in it. This is the one
   * derived number that makes that visible at the moment the decision is being
   * made, which is the only moment it can change the decision.
   */
  lastArrivalAt: number | null;
  /** Whole days since `lastArrivalAt`, or null when the area is empty. */
  daysSinceLastArrival: number | null;
}

/**
 * `placements` may be every placement in the area, open and closed — the open
 * ones are selected here rather than trusted from the caller, so a query that
 * forgets `where('endedAt','==',null)` cannot inflate an occupancy figure.
 */
export function summarizeArea(
  area: Pick<Area, 'id' | 'capacity'>,
  placements: readonly PlacementInterval[],
  now: number = Date.now(),
): AreaSummary {
  const open = placements.filter((p) => p.areaId === area.id && p.endedAt === null);
  const petIds = new Set(open.map((p) => p.petId));
  const count = petIds.size;

  const lastArrivalAt = open.length > 0 ? Math.max(...open.map((p) => p.startedAt)) : null;

  const capacity = area.capacity;
  let state: CapacityState = 'unknown';
  let free: number | null = null;
  if (capacity !== null) {
    free = Math.max(0, capacity - count);
    state = count > capacity ? 'over' : count === capacity ? 'full' : 'ok';
  }

  return {
    areaId: area.id,
    count,
    capacity,
    free,
    state,
    lastArrivalAt,
    daysSinceLastArrival:
      lastArrivalAt === null
        ? null
        : // Clamped at zero. `startedAt` comes from `serverTimestamp()` and
          // `now` from the browser, so an arrival written moments ago is
          // routinely a few seconds in the CALLER's future — measured at 2.7 s
          // on 2026-08-24 — and `Math.floor(-0.00003)` is -1. "Último ingreso
          // hace -1 días" is not a sentence, and an arrival cannot be in the
          // future in any sense the shelter cares about.
          Math.max(0, Math.floor((now - lastArrivalAt) / MS_PER_DAY)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Move warnings
// ─────────────────────────────────────────────────────────────────────────────

export type PlacementWarning =
  /** The pen already holds as many animals as it is rated for, or more. */
  | 'over-capacity'
  /**
   * A move made FOR a medical or outbreak reason, into an area that is neither
   * isolation nor medical.
   *
   * This is the whole reason `quarantine` and `isolation` are distinct kinds
   * rather than one "not general population" bucket. The ASV Guidelines for
   * Standards of Care in Animal Shelters separate them because quarantine
   * holds healthy animals under observation while isolation holds sick ones —
   * so putting a sick animal into a quarantine pen exposes every healthy
   * animal in it. A model that conflated the two could not raise this.
   */
  | 'infectious-into-shared'
  /**
   * The target is an occupied quarantine pen, so this arrival restarts the
   * observation clock for everyone already inside. Cohorting, plan 13.3.
   */
  | 'restarts-quarantine-clock'
  /** The area is marked inactive — usually mid-cleaning or out of service. */
  | 'area-inactive'
  /**
   * The animal is being moved out of quarantine into general population by an
   * ordinary transfer rather than a recorded veterinary clearance. Not wrong —
   * but `quarantine-cleared` is what makes the clearance attributable, and
   * "nobody remembers who cleared it" is how an outbreak investigation stalls.
   */
  | 'undocumented-clearance';

export interface PlacementCheck {
  target: Pick<Area, 'id' | 'kind' | 'active' | 'capacity'>;
  /** The area's current state, from `summarizeArea`. */
  summary: AreaSummary;
  reason: PlacementReason;
  /** The area the animal is leaving, if it is already somewhere. */
  from?: Pick<Area, 'kind'> | null;
}

/**
 * Everything worth telling the manager before this move is recorded.
 *
 * Order matters: the list is rendered top to bottom and the first item is the
 * one most likely to change the decision.
 */
export function placementWarnings(check: PlacementCheck): PlacementWarning[] {
  const warnings: PlacementWarning[] = [];
  const { target, summary, reason, from } = check;

  const infectious = reason === 'outbreak' || reason === 'medical';
  if (infectious && target.kind !== 'isolation' && target.kind !== 'medical') {
    warnings.push('infectious-into-shared');
  }

  if (summary.state === 'full' || summary.state === 'over') warnings.push('over-capacity');

  if (target.kind === 'quarantine' && summary.count > 0) {
    warnings.push('restarts-quarantine-clock');
  }

  if (from?.kind === 'quarantine' && target.kind === 'general' && reason !== 'quarantine-cleared') {
    warnings.push('undocumented-clearance');
  }

  if (!target.active) warnings.push('area-inactive');

  return warnings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status ↔ placement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The status an animal should hold after a move, given why it was moved.
 *
 * Only two reasons move an animal along the pipeline, and both are explicit
 * human actions rather than timers — which is the point. Everything else
 * leaves the status alone, and `isolation` in particular is deliberately NOT a
 * status: see the note on `PET_STATUS_TRANSITIONS`. An animal can be
 * `available` and temporarily in the medical pen without losing its place on
 * the wall.
 *
 * Returns the current status unchanged when the implied move is not a legal
 * transition, so a stale screen cannot drive an animal into a state the state
 * machine forbids.
 */
export function statusAfterPlacement(current: PetStatus, reason: PlacementReason): PetStatus {
  const implied: PetStatus | null =
    reason === 'intake' && current === 'inbound'
      ? 'quarantine'
      : reason === 'quarantine-cleared' && current === 'quarantine'
        ? 'shelter'
        : null;

  if (implied === null) return current;
  return canTransition(current, implied) ? implied : current;
}

/**
 * Areas in the order a picker should offer them: usable ones first, then by
 * how routine the kind is, then by name in the shelter's own collation.
 *
 * `numeric: true` matters more than it looks — these are named "Cuarentena 2",
 * "Cuarentena 10", and a plain string sort puts 10 before 2.
 */
const KIND_ORDER: Record<AreaKind, number> = {
  quarantine: 0,
  general: 1,
  medical: 2,
  isolation: 3,
  maternity: 4,
};

export function sortAreas<T extends Pick<Area, 'name' | 'kind' | 'active'>>(areas: readonly T[]): T[] {
  return [...areas].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    return a.name.localeCompare(b.name, 'es', { numeric: true, sensitivity: 'base' });
  });
}
