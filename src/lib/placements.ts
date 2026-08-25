/**
 * Placement intervals and outbreak contact tracing.
 *
 * ── Why this is an interval ledger and not a `currentArea` field ───────────
 * The reason to track which pen an animal is in at all is "if a virus breaks
 * out, isolate the area." That question is ALWAYS asked retrospectively. An
 * animal diagnosed today was infectious before it looked sick, so what is
 * needed is not where it is now, but everywhere it has been — and, critically,
 * who else was there at the same time. A current-state field cannot answer
 * that at any price; an interval ledger answers it by construction.
 *
 * ── Nothing here touches Firestore, on purpose ────────────────────────────
 * `CLAUDE.md` carries a standing warning: the microchip lookup broke because a
 * collection-group index was declared but never deployed, and the symptom was
 * indistinguishable from "no data." An outbreak trace that silently returns
 * nothing is the worst possible version of that bug — a clean run that means
 * "no contacts" when it actually means "the query is broken."
 *
 * So the decision logic lives here as pure functions over epoch milliseconds,
 * where it can be tested against known data without a database, a credential,
 * or a deployed index. The Firestore fetch is a separate, thin layer whose
 * only job is to hand this module an array. When the trace returns nothing,
 * these tests are what tell you whether to suspect the data or the index.
 */

/**
 * One stay in one area. Epoch milliseconds rather than Firestore Timestamps so
 * this module stays free of any SDK import and runs under plain `node --test`.
 */
export interface PlacementInterval {
  petId: string;
  areaId: string;
  /** Snapshotted at write time — areas get renamed, history must not shift. */
  areaName: string;
  startedAt: number;
  /** null means the animal is still there. */
  endedAt: number | null;
}

/** A window of time to investigate. `end` is inclusive. */
export interface ExposureWindow {
  start: number;
  end: number;
}

/** One overlap between the sick animal and another, in one area. */
export interface ContactTrace {
  petId: string;
  areaId: string;
  areaName: string;
  /** The overlapping span itself, clipped to the exposure window. */
  overlapStart: number;
  /** null means the overlap is still open — both animals are still in there. */
  overlapEnd: number | null;
  /**
   * How long they were together, in milliseconds. For a still-open overlap
   * this is measured up to the window's end, not to infinity.
   */
  overlapMs: number;
}

export const MS_PER_DAY = 86_400_000;

/**
 * Maximum incubation period, in days, for the pathogens that actually close
 * shelters. These set the MINIMUM lookback for a trace — a shorter window
 * silently misses the animals that matter.
 *
 * The distemper figure is the one that surprises people: typical onset is
 * 10–14 days, but the tail reaches six weeks. A trace built around a
 * fortnight's memory would look thorough and miss the case that closes the
 * shelter.
 */
export const INCUBATION_MAX_DAYS = {
  /** Canine parvovirus: 3–4 days typical, up to 14. */
  parvovirus: 14,
  /** Canine distemper: 10–14 days typical, up to 42. */
  moquillo: 42,
} as const;

export type Pathogen = keyof typeof INCUBATION_MAX_DAYS;

/**
 * How far a caller's clock may run behind Firestore's before a trace starts
 * lying.
 *
 * ⚠️ This is not defensive padding. It fixes a measured, reproducible silent
 * failure. Placements are stamped with `serverTimestamp()`, so `startedAt` is
 * Google's clock; the exposure window's ceiling is the CALLER's `now`. On
 * 2026-08-24 the server was measured 2.7 s ahead of the dev machine, and the
 * consequence was not a rounding error — a placement written seconds earlier
 * sorted AFTER the window ended, so it was clipped out of the subject's own
 * stays, no areas were derived from it, and the trace returned zero contacts.
 *
 * That result is the worst one this module can produce. `noPlacementData` was
 * false (the animal *had* placements), so the UI would have reported "no
 * contacts found" as a confident answer about an animal that had just been put
 * in a pen with two others.
 *
 * Five minutes rather than five seconds because a browser clock — not a server
 * — is what will ask this question, and browser clocks drift by minutes. The
 * cost of the tolerance is including animals placed in the last few minutes,
 * which a trace should include anyway; it errs toward INCLUDING, the direction
 * this module documents everywhere else.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000;

/**
 * The window to investigate for an animal diagnosed at `diagnosedAt`.
 *
 * It reaches BACK by the pathogen's maximum incubation period (when could this
 * animal have been infected, and by whom) and FORWARD to `now` (who has it
 * been exposing since, given it was shedding before anyone noticed). Both
 * halves matter and a window that covers only one of them answers half the
 * question.
 */
export function exposureWindow(
  diagnosedAt: number,
  pathogen: Pathogen,
  now: number = Date.now(),
): ExposureWindow {
  return {
    start: diagnosedAt - INCUBATION_MAX_DAYS[pathogen] * MS_PER_DAY,
    end: Math.max(now, diagnosedAt),
  };
}

/** An open-ended placement runs to the end of time, for comparison purposes. */
function endOf(interval: Pick<PlacementInterval, 'endedAt'>): number {
  return interval.endedAt ?? Number.POSITIVE_INFINITY;
}

/**
 * Do two intervals overlap?
 *
 * ⚠️ CLOSED intervals — touching counts as overlapping. This is deliberate and
 * it is the opposite of the failure direction used for LLM extraction.
 *
 * A medical record fails toward DROPPING, because a wrong value gets trusted
 * for years. A contact trace fails toward INCLUDING, because the costs are
 * asymmetric in the other direction: a false positive costs somebody examining
 * a healthy dog, while a false negative leaves an infected one in general
 * population. Over-inclusion is the cheap error here.
 *
 * Touching intervals are also a genuine exposure route, not merely a rounding
 * concern: one animal leaving a pen as another arrives is exactly how an
 * environmentally persistent pathogen spreads. Parvovirus survives on surfaces
 * for months, so "they never actually met" is not the same as "no exposure."
 */
export function intervalsOverlap(
  a: Pick<PlacementInterval, 'startedAt' | 'endedAt'>,
  b: Pick<PlacementInterval, 'startedAt' | 'endedAt'>,
): boolean {
  return a.startedAt <= endOf(b) && b.startedAt <= endOf(a);
}

/**
 * The overlapping span itself, or null if there is none. `end: null` means the
 * overlap has not closed — both animals are still in the area.
 */
export function overlapBetween(
  a: Pick<PlacementInterval, 'startedAt' | 'endedAt'>,
  b: Pick<PlacementInterval, 'startedAt' | 'endedAt'>,
): { start: number; end: number | null } | null {
  const start = Math.max(a.startedAt, b.startedAt);
  const end = Math.min(endOf(a), endOf(b));
  if (start > end) return null;
  return { start, end: Number.isFinite(end) ? end : null };
}

/**
 * Every animal that shared an area with the subject inside the exposure
 * window, most-exposed first.
 *
 * `candidates` is every placement fetched for the relevant areas — including
 * the subject's own, which is filtered out here rather than at the query, so a
 * caller cannot accidentally omit the filter and trace an animal against
 * itself.
 *
 * Ordering is by contact duration descending because that is the order a
 * shelter works the list in: the animal that spent three weeks beside the sick
 * one gets examined before the one that passed through for an afternoon.
 */
export function traceContacts(
  subject: PlacementInterval[],
  candidates: PlacementInterval[],
  window: ExposureWindow,
): ContactTrace[] {
  const windowInterval = { startedAt: window.start, endedAt: window.end };
  const contacts: ContactTrace[] = [];

  for (const stay of subject) {
    // Clip the subject's stay to the window: time outside it is not exposure.
    const clipped = overlapBetween(stay, windowInterval);
    if (!clipped) continue;

    const clippedStay = { startedAt: clipped.start, endedAt: clipped.end };

    for (const other of candidates) {
      if (other.petId === stay.petId) continue;
      if (other.areaId !== stay.areaId) continue;

      const shared = overlapBetween(clippedStay, other);
      if (!shared) continue;

      // A still-open overlap is measured to the window's end rather than to
      // infinity, so the duration stays a real number the UI can sort on.
      const measuredEnd = shared.end ?? window.end;

      /**
       * Whether they are still together is a property of the two STAYS, not of
       * the clipped arithmetic above.
       *
       * The subject's stay was clipped to the window before comparing, which
       * turns an open stay into one ending at the window's edge — so `shared.end`
       * is finite even when neither animal has left. Reporting that as the end
       * of the contact made the most urgent row in the trace, the animal still
       * standing beside the sick one, read as though the exposure were over.
       */
      const stillTogether = stay.endedAt === null && other.endedAt === null;

      contacts.push({
        petId: other.petId,
        areaId: other.areaId,
        areaName: other.areaName,
        overlapStart: shared.start,
        overlapEnd: stillTogether ? null : shared.end,
        overlapMs: measuredEnd - shared.start,
      });
    }
  }

  return contacts.sort((a, b) => b.overlapMs - a.overlapMs);
}

/**
 * Distinct animals that contacted the subject. The trace returns one row per
 * overlapping stay, so an animal moved out of an area and back again appears
 * twice — correct for a timeline, wrong for "how many animals do we examine."
 */
export function contactedPetIds(contacts: ContactTrace[]): string[] {
  return [...new Set(contacts.map((c) => c.petId))];
}

/**
 * Who is in an area right now: the placements with no end.
 *
 * Same index shape as the trace query
 * (`where('areaId','==',X).where('endedAt','==',null)`), which is why it lives
 * beside it — if one of them breaks on a missing index, so has the other.
 */
export function currentOccupants(placements: PlacementInterval[], areaId: string): string[] {
  return [
    ...new Set(
      placements.filter((p) => p.areaId === areaId && p.endedAt === null).map((p) => p.petId),
    ),
  ];
}

/**
 * Days between an animal's first placement and its last departure — length of
 * stay, the single most-used shelter metric, and currently uncomputable
 * without this ledger. Still-present animals are measured up to `now`.
 */
export function lengthOfStayDays(
  placements: PlacementInterval[],
  now: number = Date.now(),
): number | null {
  if (placements.length === 0) return null;
  const first = Math.min(...placements.map((p) => p.startedAt));
  const last = placements.some((p) => p.endedAt === null)
    ? now
    : Math.max(...placements.map((p) => p.endedAt as number));
  return (last - first) / MS_PER_DAY;
}
