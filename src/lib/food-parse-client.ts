import type { User } from 'firebase/auth';

import type { DonationLineDraft } from './food-parse';

/**
 * Browser side of `/api/food/parse`.
 *
 * ── Failure direction: OPEN ──────────────────────────────────────────────────
 * Never throws. A failed parse resolves with `lines: null` and a reason, and
 * the donation screen offers blank lines to type. Nothing about recording a
 * donation depends on the model answering.
 */

export type FoodParseFailure =
  | 'not-configured'
  | 'unauthorized'
  /** Empty, too long or unreadable text. The person can fix it. */
  | 'text-rejected'
  /** Retryable: say so. */
  | 'timeout'
  | 'failed';

export interface FoodParseOutcome {
  donor: string | null;
  lines: DonationLineDraft[] | null;
  modelKey: string | null;
  failure: FoodParseFailure | null;
}

const NOTHING: FoodParseOutcome = { donor: null, lines: null, modelKey: null, failure: 'failed' };

/**
 * Stamped by the route on every failure IT generates, so an unstamped 5xx can
 * be recognised as Firebase Hosting's own 60 s timeout rather than read as
 * "not configured". The 2026-09-02 intake lesson, carried over whole: a status
 * code is only ours to interpret when we wrote it. Defined here, next to the
 * reader, and imported by the route, so a rename cannot split the halves.
 */
export const FOOD_PARSE_FAILURE_HEADER = 'X-Food-Parse-Failure';

export async function requestDonationParse(user: User, text: string): Promise<FoodParseOutcome> {
  try {
    const token = await user.getIdToken();
    if (text.trim() === '') return { ...NOTHING, failure: 'text-rejected' };

    const res = await fetch('/api/food/parse', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (res.ok) {
      const json = (await res.json()) as {
        donor: string | null;
        lines: DonationLineDraft[];
        modelKey: string;
      };
      return { donor: json.donor, lines: json.lines, modelKey: json.modelKey, failure: null };
    }

    const stamped = res.headers.get(FOOD_PARSE_FAILURE_HEADER);
    if (stamped === null && res.status >= 500) return { ...NOTHING, failure: 'timeout' };
    if (stamped === 'ai-not-configured') return { ...NOTHING, failure: 'not-configured' };
    if (res.status === 401 || res.status === 403) return { ...NOTHING, failure: 'unauthorized' };
    if (res.status === 400 || res.status === 413) return { ...NOTHING, failure: 'text-rejected' };
    if (res.status === 504) return { ...NOTHING, failure: 'timeout' };
    return NOTHING;
  } catch {
    return NOTHING;
  }
}
