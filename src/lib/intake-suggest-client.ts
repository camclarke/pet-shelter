import type { User } from 'firebase/auth';

import type { ReviewedSuggestion } from './intake-suggestion';
import type { PetPhotoSlot } from './types';

/**
 * Browser side of `/api/intake/suggest`.
 *
 * ── Failure direction: OPEN ──────────────────────────────────────────────────
 * Never throws. Every failure resolves to `null`, because a photo suggestion is
 * an accelerator and must never be able to stop an animal being admitted. The
 * caller shows the manual form either way. Plan §3's rule: a gate stricter than
 * the shelter's reality gets worked around.
 *
 * The REASON is returned alongside so the UI can say what happened rather than
 * going quiet — an unexplained absence trains people to distrust the feature.
 */

export type SuggestFailure =
  | 'not-configured'
  | 'unauthorized'
  | 'photo-rejected'
  /** The model did not answer in time. RETRYABLE — say so, and offer a retry. */
  | 'timeout'
  | 'failed';

export interface SuggestOutcome {
  suggestion: ReviewedSuggestion | null;
  modelKey: string | null;
  failure: SuggestFailure | null;
}

const NOTHING: SuggestOutcome = { suggestion: null, modelKey: null, failure: 'failed' };

/**
 * ⚠️ `processed` MUST be the output of stripAndResize(), never a raw File.
 *
 * This call sends the photograph to a third party. A phone photo carries
 * EXIF GPS, and a photo taken in a foster home therefore carries a
 * volunteer’s home address — which is concern #2 in CLAUDE.md arriving
 * through the image pipeline rather than through the location field. The
 * stripped copy is also smaller (1600px long edge), so this is cheaper and
 * faster too, but the reason is privacy.
 */
/** One processed photograph and the guided slot it was taken for. */
export interface SlottedBlob {
  slot: PetPhotoSlot;
  blob: Blob;
}

/**
 * ⚠️ Sends the WHOLE set in ONE request, and that is not a convenience.
 *
 * Free-tier quota counts requests, not tokens, and the Flash tier gets 20 a
 * day. One request per photo would take the shelter from 20 animals a day to
 * five. Any code that calls this once per photo has quietly broken that.
 */
export async function requestSuggestion(
  user: User,
  photos: readonly SlottedBlob[]
): Promise<SuggestOutcome> {
  try {
    // Not forced: a forced refresh costs a round-trip on every photo, and
    // AdminGate already forced one when the panel mounted. If the token has
    // gone stale the route answers 401 and the outcome below says so.
    const token = await user.getIdToken();

    if (photos.length === 0) return { ...NOTHING, failure: 'photo-rejected' };

    const body = new FormData();
    // One field per slot, which is how the route tells them apart. A filename
    // is required for the server to see each as a File rather than a bare
    // Blob. stripAndResize always emits JPEG.
    for (const { slot, blob } of photos) {
      body.append(`photo_${slot}`, blob, `${slot}.jpg`);
    }

    const res = await fetch('/api/intake/suggest', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body,
    });

    if (res.ok) {
      const json = (await res.json()) as {
        suggestion: ReviewedSuggestion;
        modelKey: string;
      };
      return { suggestion: json.suggestion, modelKey: json.modelKey, failure: null };
    }

    if (res.status === 503) return { ...NOTHING, failure: 'not-configured' };
    if (res.status === 401 || res.status === 403) {
      return { ...NOTHING, failure: 'unauthorized' };
    }
    if (res.status === 413 || res.status === 415 || res.status === 400) {
      return { ...NOTHING, failure: 'photo-rejected' };
    }
    // 504 is the route's own timeout. Distinguished from a generic failure
    // because it is worth retrying and a permanent-sounding message stops
    // someone trying again on better signal — observed in production
    // 2026-08-30, a 25.3s request that returned nothing the UI could explain.
    if (res.status === 504) return { ...NOTHING, failure: 'timeout' };
    return NOTHING;
  } catch {
    return NOTHING;
  }
}
