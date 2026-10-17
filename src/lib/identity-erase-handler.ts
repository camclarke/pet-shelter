/**
 * POST /api/adoption-applications/{applicationId}/erase-identity — an ADMIN
 * erasing an applicant's carnet photo, home address and personal details,
 * with a reason. The retention policy of the contract's second additional
 * clause, carried out by a person (owner decision, 2026-10-17: nothing is
 * erased automatically).
 *
 * ═══ WHAT IS ERASED, AND WHAT IS KEPT ═══════════════════════════════════════
 * Erased, for good:
 *   - the carnet photo: EVERY stored version of every side, because the bucket
 *     keeps old versions (`deleteEveryIdDocumentVersion`);
 *   - `private/home` (the address and the map pin) and `private/identity` (the
 *     C.I. number, age, civil status, landline, references, landlord) — the
 *     documents `PRIVATE_DOCUMENT_IDS` names;
 *   - the text of `internal/notes`, blanked as a backstop (D15).
 * Kept: the application itself (what the person said, its status, its dates)
 * and `private/acceptance` — the evidence the agreement was made.
 * Recorded: `identityErasedAt` on the application, and `internal/erasure`
 * `{reason, erasedAt, erasedBy, adoptionEnded}`.
 *
 * ═══ THE CHECKS, IN ORDER — each refusal stamped `X-Identity-Erase-Failure` ═
 *   1. an admin token (`requireAdmin`, `checkRevoked`)          401 / 403
 *   2. the body's `reason`                                       400 bad-reason
 *   3. the application, read through the Admin SDK:
 *        malformed id, or missing                                 404 not-found
 *        the read throws                                          500 application-read-failed
 *   4. the reason fits the outcome:
 *        `returned` / `died` need an APPROVED application;
 *        `not-adopted` needs a rejected or withdrawn one          409 reason-mismatch
 *        (an open application cannot be erased: decide it first)
 *   5. `returned` while `adoptions/{petId}` still names this
 *      applicant: the return is not registered yet              409 still-in-custody
 *   6. ERASE, in this order:
 *        a. one transaction: mark `identityErasedAt`, delete the private
 *           documents, blank the notes, write `internal/erasure`, and — for
 *           `died` — delete `adoptions/{petId}` if it names this applicant
 *           (the custody ended; the family may then delete their account);
 *        b. delete every version of the carnet photo.
 *      Marking FIRST is deliberate: an ID upload in flight re-checks
 *      `identityErasedAt` inside its own transaction, so once (a) commits no
 *      upload can leave a photo behind; (b) then removes what is there.
 *      An already-erased application skips (a) and runs (b) again, so a
 *      failed (b) is finished by simply pressing the button again.
 *        either step throws                                       500 erase-failed
 *   7. 200 `{erased: true}`.
 *
 * ⚠️ Logs name the application id and the step, never personal data.
 */

import { requireAdmin, type VerifyIdToken } from './require-admin';
import { isIdentityErased, parseApplicationId } from './applications';
import {
  IDENTITY_ERASE_FAILURE_HEADER,
  isEraseReason,
  type EraseReason,
  type IdentityEraseFailure,
} from './identity-erase-protocol';

export {
  ERASE_REASONS,
  IDENTITY_ERASE_FAILURE_HEADER,
  IDENTITY_ERASE_FAILURES,
  identityEraseFailure,
  identityErasePath,
  isEraseReason,
} from './identity-erase-protocol';
export type { EraseReason, IdentityEraseFailure } from './identity-erase-protocol';

/** The largest body read: `{"reason":"not-adopted"}` is 24 bytes. */
export const IDENTITY_ERASE_MAX_BODY_CHARS = 200;

export interface EraseApplicationSnapshot {
  petId: unknown;
  applicantUid: unknown;
  status: unknown;
  identityErasedAt: unknown;
}

/** `adoptions/{petId}` as the check needs it, or null when there is none. */
export interface EraseAdoptionSnapshot {
  ownerUid: unknown;
  applicationId: unknown;
}

/** What step 6a writes, decided here. */
export interface ErasurePlan {
  reason: EraseReason;
  erasedBy: string;
  /** For `died`: the pet whose `adoptions` document ends with this erase. */
  endAdoptionOfPetId: string | null;
}

export interface IdentityEraseDeps {
  verifyIdToken: VerifyIdToken;
  readApplication: (applicationId: string) => Promise<EraseApplicationSnapshot | null>;
  readAdoption: (petId: string) => Promise<EraseAdoptionSnapshot | null>;
  /** Step 6a, one transaction. */
  commitErasure: (applicationId: string, plan: ErasurePlan) => Promise<void>;
  /** Step 6b: every version of every side. */
  deleteIdPhotos: (applicationId: string) => Promise<void>;
  log: (message: string) => void;
}

function failure(reason: IdentityEraseFailure, status: number): Response {
  return new Response(JSON.stringify({ error: reason }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', [IDENTITY_ERASE_FAILURE_HEADER]: reason },
  });
}

function done(): Response {
  return new Response(JSON.stringify({ erased: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** Does this adoption document belong to this application? */
function adoptionNames(adoption: EraseAdoptionSnapshot | null, applicationId: string, applicantUid: string): boolean {
  return adoption !== null && (adoption.applicationId === applicationId || adoption.ownerUid === applicantUid);
}

/**
 * Step 4: may this reason erase an application in this status? Pure, so the
 * admin screen offers only the reasons the route will accept.
 */
export function reasonFitsStatus(reason: EraseReason, status: unknown): boolean {
  if (reason === 'not-adopted') return status === 'rejected' || status === 'withdrawn';
  return status === 'approved';
}

export async function handleIdentityErase(
  request: Request,
  params: { applicationId: string },
  deps: IdentityEraseDeps,
): Promise<Response> {
  const caller = await requireAdmin(request, deps.verifyIdToken);
  if (!caller.ok) return failure(caller.error, caller.status);

  // A tiny JSON body, read only after the admin check.
  let reason: unknown;
  try {
    const text = await request.text();
    if (text.length > IDENTITY_ERASE_MAX_BODY_CHARS) return failure('bad-reason', 400);
    reason = (JSON.parse(text) as { reason?: unknown })?.reason;
  } catch {
    return failure('bad-reason', 400);
  }
  if (!isEraseReason(reason)) return failure('bad-reason', 400);

  const { applicationId } = params;
  if (!parseApplicationId(applicationId)) return failure('not-found', 404);

  let application: EraseApplicationSnapshot | null;
  try {
    application = await deps.readApplication(applicationId);
  } catch {
    deps.log(`[erase-identity] could not read ${applicationId}`);
    return failure('application-read-failed', 500);
  }
  if (!application || typeof application.petId !== 'string' || typeof application.applicantUid !== 'string') {
    return failure('not-found', 404);
  }
  const { petId, applicantUid } = application;

  if (isIdentityErased(application.identityErasedAt)) {
    // Already marked: only the photo sweep can be unfinished. Run it again.
    try {
      await deps.deleteIdPhotos(applicationId);
    } catch {
      deps.log(`[erase-identity] photo sweep failed again for ${applicationId}`);
      return failure('erase-failed', 500);
    }
    return done();
  }

  if (!reasonFitsStatus(reason, application.status)) return failure('reason-mismatch', 409);

  let adoption: EraseAdoptionSnapshot | null = null;
  if (reason !== 'not-adopted') {
    try {
      adoption = await deps.readAdoption(petId);
    } catch {
      deps.log(`[erase-identity] could not read the adoption of ${applicationId}`);
      return failure('application-read-failed', 500);
    }
  }
  const stillNamed = adoptionNames(adoption, applicationId, applicantUid);
  if (reason === 'returned' && stillNamed) return failure('still-in-custody', 409);

  try {
    await deps.commitErasure(applicationId, {
      reason,
      erasedBy: caller.email ?? caller.uid,
      endAdoptionOfPetId: reason === 'died' && stillNamed ? petId : null,
    });
  } catch {
    deps.log(`[erase-identity] could not mark ${applicationId} erased`);
    return failure('erase-failed', 500);
  }

  try {
    await deps.deleteIdPhotos(applicationId);
  } catch {
    // Marked erased, photo not yet gone: pressing the button again finishes it.
    deps.log(`[erase-identity] photo sweep failed for ${applicationId}; marked erased, retry finishes it`);
    return failure('erase-failed', 500);
  }
  return done();
}
