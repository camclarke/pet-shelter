/**
 * The browser's side of the donation routes: Bearer token, JSON in, the
 * `X-Donation-Failure` header out. The wire contract is `donations-protocol.ts`.
 *
 * Every call asks for a FRESH ID token (`getIdToken(true)`): the routes refuse
 * a sign-in older than five minutes, and the token cached in the page can be
 * the one from before the person just re-authenticated.
 */

import type { User } from 'firebase/auth';

import type { ProposalError } from './donations';
import {
  DONATION_QR_MAX_BYTES,
  DONATION_QR_TYPES,
  donationFailure,
  type ConfirmResponse,
  type DonationFailure,
  type DonationFailureBody,
  type ProposeRequest,
  type ProposeResponse,
  type RejectResponse,
} from './donations-protocol';

/** A refused or failed call. `failure` is null when the response was not one of ours (the edge, the network). */
export class DonationApiError extends Error {
  readonly failure: DonationFailure | null;
  readonly status: number;
  readonly field: string | null;
  readonly detail: ProposalError | null;

  constructor(failure: DonationFailure | null, status: number, field: string | null = null, detail: ProposalError | null = null) {
    super(failure ?? `donation request failed (${status})`);
    this.name = 'DonationApiError';
    this.failure = failure;
    this.status = status;
    this.field = field;
    this.detail = detail;
  }
}

async function failureOf(response: Response): Promise<DonationApiError> {
  const failure = donationFailure(response);
  let body: Partial<DonationFailureBody> = {};
  try {
    body = (await response.json()) as Partial<DonationFailureBody>;
  } catch {
    // Not JSON: the failure header alone still names the error.
  }
  return new DonationApiError(failure, response.status, body.field ?? null, body.detail ?? null);
}

async function authorized(user: User, init: RequestInit): Promise<RequestInit> {
  const token = await user.getIdToken(true);
  return { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` } };
}

async function sendJson<T>(user: User, path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(
      path,
      await authorized(user, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    );
  } catch (error) {
    if (error instanceof DonationApiError) throw error;
    throw new DonationApiError(null, 0);
  }
  if (!response.ok) throw await failureOf(response);
  return (await response.json()) as T;
}

export function proposeDonation(user: User, request: ProposeRequest): Promise<ProposeResponse> {
  return sendJson<ProposeResponse>(user, '/api/donations/propose', request);
}

export function confirmDonation(user: User, pendingId: string): Promise<ConfirmResponse> {
  return sendJson<ConfirmResponse>(user, '/api/donations/confirm', { pendingId });
}

export function rejectDonation(user: User, pendingId: string, reason: string): Promise<RejectResponse> {
  return sendJson<RejectResponse>(user, '/api/donations/reject', { pendingId, reason: reason.trim() === '' ? null : reason.trim() });
}

/** A QR image the form may send: JPEG or PNG, at most 2 MB. Null when fine, otherwise a Spanish sentence. */
export function qrFileProblem(file: { type: string; size: number }): string | null {
  if (!(DONATION_QR_TYPES as readonly string[]).includes(file.type)) return 'El QR debe ser una imagen JPG o PNG.';
  if (file.size > DONATION_QR_MAX_BYTES) return 'La imagen del QR pesa más de 2 MB. Usa una más liviana.';
  if (file.size === 0) return 'La imagen del QR está vacía.';
  return null;
}

/** Uploads the proposal's QR as raw bytes. Once per proposal. */
export async function uploadPendingQr(user: User, pendingId: string, file: File): Promise<void> {
  let response: Response;
  try {
    response = await fetch(
      `/api/donations/pending/${encodeURIComponent(pendingId)}/qr`,
      await authorized(user, { method: 'POST', headers: { 'Content-Type': file.type }, body: file }),
    );
  } catch {
    throw new DonationApiError(null, 0);
  }
  if (!response.ok) throw await failureOf(response);
}

/**
 * The proposed QR as an object URL. The caller revokes it (`URL.revokeObjectURL`)
 * when it is replaced or the screen unmounts.
 */
export async function fetchPendingQrObjectUrl(user: User, pendingId: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`/api/donations/pending/${encodeURIComponent(pendingId)}/qr`, await authorized(user, { method: 'GET' }));
  } catch {
    throw new DonationApiError(null, 0);
  }
  if (!response.ok) throw await failureOf(response);
  return URL.createObjectURL(await response.blob());
}
