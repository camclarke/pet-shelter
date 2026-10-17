/**
 * POST /api/adoption-applications/{applicationId}/acceptance — the applicant's
 * browser asking the server to RECORD the audit trail of their consent.
 *
 * ═══ WHY THIS EXISTS ═══════════════════════════════════════════════════════
 * The contract's first additional clause (owner, 2026-10-17) makes the
 * checkbox and «Enviar» a binding electronic consent, and names its evidence:
 * "la pista de auditoría digital registrada en el sistema, la cual almacena la
 * fecha y hora exacta (estampa de tiempo), la dirección IP de origen y los
 * datos de autenticación del usuario". A browser cannot be trusted to report
 * its own IP and the Firestore rules cannot see one, so a server writes it:
 * `adoptionApplications/{id}/private/acceptance`, through the Admin SDK, ONCE.
 * The rules' private create admits only `home` and `identity`, so no browser
 * can forge this document, and approval requires it (`acceptanceRecorded()`).
 *
 * ═══ THE CHECKS, IN ORDER — each refusal stamped `X-Acceptance-Failure` ═════
 *   1. a verified token (`requireUser`, `checkRevoked`)          401 unauthenticated
 *   2. the public switch, `SHELTER.adoptionApplications.enabled` 404 disabled
 *   3. the id is `{petId}__{uid}` naming the CALLER                403 not-yours
 *   4. the application, read through the Admin SDK:
 *        the read throws                                           500 application-read-failed
 *        missing                                                   404 not-found
 *        `applicantUid` is not the caller                          403 not-yours
 *        erased                                                    409 erased
 *        not submitted / reviewing / interview                     409 not-open
 *   5. ONLY NOW the request headers are read — the IP evidence and the user
 *      agent, nothing else; there is no body.
 *   6. create-only, in a transaction (`commitAcceptance`):
 *        already recorded                                          200 (nothing changed)
 *        recorded now                                              201
 *        the write throws                                          500 record-failed
 *
 * ═══ WHICH IP ═══════════════════════════════════════════════════════════════
 * Requests reach Cloud Run through Firebase Hosting (a Fastly CDN) and
 * Google's front end. Which header carries the visitor's real address on THAT
 * path has not been measured yet — it can only be measured on the deployed
 * route, with a real request (planned for the switch-on release, 4f). So the
 * record keeps the raw evidence, not one guess:
 *   - `forwardedFor`: `X-Forwarded-For` exactly as received (capped);
 *   - `fastlyClientIp`: `Fastly-Client-IP` as received, or null;
 *   - `ip`: the best reading of the two (`clientIpFrom`), for display.
 * ⚠️ The FIRST `X-Forwarded-For` entry is whatever the client sent, so it can
 * be forged; the entries proxies appended after it cannot. Keeping the whole
 * chain is what keeps the real one.
 *
 * ⚠️ Logs name the application id and the failure, never the IP or the token.
 */

import { requireUser, type VerifyIdToken } from './require-admin';
import { isIdentityErased, isOpenApplication, parseApplicationId } from './applications';
import { ACCEPTANCE_FAILURE_HEADER, type AcceptanceFailure } from './acceptance-protocol';
import type { ApplicationStatus } from './types';

export { ACCEPTANCE_FAILURE_HEADER, ACCEPTANCE_FAILURES, acceptanceFailure } from './acceptance-protocol';
export type { AcceptanceFailure } from './acceptance-protocol';

/** Caps on what is stored from the headers: evidence, not an open text field. */
export const FORWARDED_FOR_MAX_CHARS = 300;
export const CLIENT_IP_MAX_CHARS = 64;
export const USER_AGENT_MAX_CHARS = 400;

/** The application as the handler needs it — raw values, validated here. */
export interface AcceptanceApplicationSnapshot {
  applicantUid: unknown;
  status: unknown;
  identityErasedAt: unknown;
  contractVersion: unknown;
  contractSha256: unknown;
  /** The application's own `termsAcceptedAt`, copied into the record as it is. */
  termsAcceptedAt: unknown;
}

/** `private/acceptance` as the handler decides it; the route adds the server time. */
export interface AcceptanceReceipt {
  applicantUid: string;
  applicantEmail: string | null;
  contractVersion: string;
  contractSha256: string;
  termsAcceptedAt: unknown;
  ip: string | null;
  forwardedFor: string | null;
  fastlyClientIp: string | null;
  userAgent: string | null;
}

export interface AcceptanceDeps {
  verifyIdToken: VerifyIdToken;
  /** `SHELTER.adoptionApplications.enabled` — the route passes exactly that. */
  applicationsEnabled: boolean;
  readApplication: (applicationId: string) => Promise<AcceptanceApplicationSnapshot | null>;
  /**
   * In ONE transaction: if `private/acceptance` exists, write nothing and
   * return 'exists'; otherwise create it from `receipt` plus
   * `recordedAt: serverTimestamp()` and return 'created'.
   */
  commitAcceptance: (applicationId: string, receipt: AcceptanceReceipt) => Promise<'created' | 'exists'>;
  log: (message: string) => void;
}

function failure(reason: AcceptanceFailure, status: number): Response {
  return new Response(JSON.stringify({ error: reason }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', [ACCEPTANCE_FAILURE_HEADER]: reason },
  });
}

function ok(status: 200 | 201): Response {
  return new Response(JSON.stringify({ recorded: true }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:.]{2,45}$/i;

/** True for something shaped like an IPv4 or IPv6 address. Shape only. */
export function looksLikeIp(value: string): boolean {
  return (IPV4.test(value) && value.split('.').every((n) => Number(n) <= 255)) || (value.includes(':') && IPV6.test(value));
}

function capped(value: string | null, max: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

/**
 * The best reading of the client's address: `Fastly-Client-IP` when it is an
 * address, else the first `X-Forwarded-For` entry that is one, else null. Not
 * proof on its own — see "WHICH IP" above; the raw headers are kept with it.
 */
export function clientIpFrom(forwardedFor: string | null, fastlyClientIp: string | null): string | null {
  if (fastlyClientIp && looksLikeIp(fastlyClientIp)) return fastlyClientIp;
  for (const entry of (forwardedFor ?? '').split(',')) {
    const candidate = entry.trim();
    if (candidate && looksLikeIp(candidate)) return candidate;
  }
  return null;
}

export async function handleAcceptance(
  request: Request,
  params: { applicationId: string },
  deps: AcceptanceDeps,
): Promise<Response> {
  const caller = await requireUser(request, deps.verifyIdToken);
  if (!caller.ok) return failure('unauthenticated', 401);

  if (!deps.applicationsEnabled) return failure('disabled', 404);

  const parsed = parseApplicationId(params.applicationId);
  if (!parsed || parsed.applicantUid !== caller.uid) return failure('not-yours', 403);

  let application: AcceptanceApplicationSnapshot | null;
  try {
    application = await deps.readApplication(params.applicationId);
  } catch {
    deps.log(`[acceptance] could not read ${params.applicationId}`);
    return failure('application-read-failed', 500);
  }
  if (!application) return failure('not-found', 404);
  if (application.applicantUid !== caller.uid) return failure('not-yours', 403);
  if (isIdentityErased(application.identityErasedAt)) return failure('erased', 409);
  if (typeof application.status !== 'string' || !isOpenApplication(application.status as ApplicationStatus)) {
    return failure('not-open', 409);
  }
  if (typeof application.contractVersion !== 'string' || typeof application.contractSha256 !== 'string') {
    // Every application is created with both (the rules require them).
    return failure('not-open', 409);
  }

  // The evidence. Headers only — there is no body — and only after the owner checks.
  const forwardedFor = capped(request.headers.get('x-forwarded-for'), FORWARDED_FOR_MAX_CHARS);
  const fastlyClientIp = capped(request.headers.get('fastly-client-ip'), CLIENT_IP_MAX_CHARS);
  const userAgent = capped(request.headers.get('user-agent'), USER_AGENT_MAX_CHARS);

  const receipt: AcceptanceReceipt = {
    applicantUid: caller.uid,
    applicantEmail: caller.email,
    contractVersion: application.contractVersion,
    contractSha256: application.contractSha256,
    termsAcceptedAt: application.termsAcceptedAt ?? null,
    ip: clientIpFrom(forwardedFor, fastlyClientIp),
    forwardedFor,
    fastlyClientIp,
    userAgent,
  };

  try {
    const outcome = await deps.commitAcceptance(params.applicationId, receipt);
    return ok(outcome === 'created' ? 201 : 200);
  } catch {
    deps.log(`[acceptance] could not record ${params.applicationId}`);
    return failure('record-failed', 500);
  }
}
