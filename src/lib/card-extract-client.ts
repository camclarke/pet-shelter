import type { User } from 'firebase/auth';

/**
 * Browser side of `/api/medical/cards/extract`. Build-order step 9.
 *
 * ── Failure direction: OPEN, toward the manual form ──────────────────────────
 * Never throws. Reading a card is an accelerator: the shelter can always type
 * the record from the card by hand, and a failure here must say why and get
 * out of the way. Plan §3.
 *
 * ⚠️ After ANY outcome — success, failure, timeout — the panel reloads the
 * medical history rather than trusting this result. The history is the truth:
 * a response lost at the edge may have been written anyway.
 */

/**
 * The header the route stamps on every failure IT generates.
 *
 * ⚠️ Its ABSENCE is the signal. `wawitas.org` reaches the route through a
 * Firebase Hosting rewrite, and Hosting cuts a request at 60 s with a 5xx of
 * its own — on 2026-09-02 a 503, the same status a route uses for "no API
 * key". A status is only ours to interpret when we wrote it. Defined here, next
 * to the reader, and imported by the route, so a rename cannot split them.
 */
export const CARD_FAILURE_HEADER = 'X-Card-Failure';

/** Every failure the route can stamp. A wire contract: rename deliberately. */
export type CardRouteError =
  | 'unauthenticated'
  | 'forbidden'
  | 'ai-not-configured'
  | 'storage-not-configured'
  | 'bad-request'
  | 'pet-not-found'
  | 'already-extracted'
  | 'card-not-found'
  | 'card-too-large'
  | 'card-unsupported'
  | 'extract-timeout'
  | 'extract-failed'
  | 'save-failed';

export interface CardExtractSuccess {
  /** Candidates written, all unconfirmed. */
  written: number;
  /** Rows the policy refused because nothing in them was usable. */
  droppedRows: number;
  /** The model said the image is not a vaccination or deworming card. */
  notACard: boolean;
  modelKey: string;
  recordIds: string[];
}

/** What the panel needs to say. Coarser than the route's codes on purpose. */
export type CardExtractFailure =
  | 'not-configured'
  | 'unauthorized'
  | 'already-extracted'
  | 'photo-rejected'
  | 'pet-missing'
  /** The model did not answer in time, or the edge gave up. RETRYABLE. */
  | 'timeout'
  | 'failed';

export interface CardExtractOutcome {
  result: CardExtractSuccess | null;
  failure: CardExtractFailure | null;
}

/**
 * Which failure a non-OK response is. Pure, and exported so it is tested.
 *
 * ⚠️ An UNSTAMPED 5xx is the edge, never us — nearly always Hosting's 60 s
 * ceiling — and it is reported as a retryable timeout, not as "not configured".
 */
export function classifyCardFailure(status: number, stamped: string | null): CardExtractFailure {
  if (stamped === null) {
    if (status >= 500) return 'timeout';
    if (status === 401 || status === 403) return 'unauthorized';
    return 'failed';
  }
  switch (stamped as CardRouteError) {
    case 'ai-not-configured':
    case 'storage-not-configured':
      return 'not-configured';
    case 'unauthenticated':
    case 'forbidden':
      return 'unauthorized';
    case 'already-extracted':
      return 'already-extracted';
    case 'bad-request':
    case 'card-not-found':
    case 'card-too-large':
    case 'card-unsupported':
      return 'photo-rejected';
    case 'pet-not-found':
      return 'pet-missing';
    case 'extract-timeout':
      return 'timeout';
    default:
      return 'failed';
  }
}

const FAILED: CardExtractOutcome = { result: null, failure: 'failed' };

/**
 * Ask the server to read a card that is ALREADY in Storage.
 *
 * ⚠️ Sends a path, not the photo. The photo went straight from the phone to
 * Storage (see `uploadCardPhoto`), so this request is a few hundred bytes and
 * the whole Hosting window is left for the model rather than spent on a
 * phone's uplink.
 */
export async function requestCardExtraction(
  user: User,
  petId: string,
  path: string
): Promise<CardExtractOutcome> {
  try {
    const token = await user.getIdToken();
    const res = await fetch('/api/medical/cards/extract', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ petId, path }),
    });

    if (res.ok) {
      return { result: (await res.json()) as CardExtractSuccess, failure: null };
    }
    return {
      result: null,
      failure: classifyCardFailure(res.status, res.headers.get(CARD_FAILURE_HEADER)),
    };
  } catch {
    return FAILED;
  }
}
