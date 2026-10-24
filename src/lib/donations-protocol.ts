/**
 * The wire contract of the donation routes — what the admin screen sends and
 * reads back. No server import, so the browser bundles this file and not the
 * handler (the `id-document-protocol.ts` split).
 *
 *   POST /api/donations/propose            JSON ProposeRequest  → 201 ProposeResponse
 *   POST /api/donations/pending/{id}/qr    raw image/jpeg|png   → 201 {uploaded: true}
 *   GET  /api/donations/pending/{id}/qr    → 200 image/png (private, no-store)
 *   POST /api/donations/confirm            JSON ConfirmRequest  → 200 ConfirmResponse
 *   POST /api/donations/reject             JSON RejectRequest   → 200 RejectResponse
 *   GET  /api/donations/qr                 PUBLIC → 200 image/png | 404
 *
 * Every request but the public one carries `Authorization: Bearer <ID token>`.
 * Propose, the QR upload, confirm and reject also need a sign-in under five
 * minutes old (`requires-recent-login`): the screen re-authenticates and
 * retries, as Mi cuenta does before deleting an account.
 *
 * Every refusal is JSON `{error, field?, detail?}` with `Cache-Control:
 * no-store` and the `X-Donation-Failure` header naming the error — its ABSENCE
 * on a 5xx means the edge answered, not us.
 */

import type { AccountType, Currency, DonationMethodKind, ProposalError, QrAction } from './donations';

export const DONATION_FAILURE_HEADER = 'X-Donation-Failure';

/** The largest QR image accepted, before re-encoding. Plan D19. */
export const DONATION_QR_MAX_BYTES = 2 * 1024 * 1024;

/** The largest JSON body any donation route reads. A full proposal is ~3 KB. */
export const DONATION_JSON_MAX_BYTES = 32 * 1024;

/** The image types the QR upload accepts, as `Content-Type`. */
export const DONATION_QR_TYPES = ['image/jpeg', 'image/png'] as const;

export const DONATION_FAILURES = [
  'unauthenticated', //        401  no token, or invalid or revoked
  'forbidden', //              403  not Tesorería nor the superuser
  'requires-recent-login', //  403  sign in again, then retry
  'not-json', //               415  Content-Type is not application/json
  'invalid-body', //           400  not a JSON object, or a field of the wrong type
  'too-large', //              413  body over the cap
  'too-slow', //               408  body took more than 30 s
  'body-read-failed', //       500  the upload broke off
  'invalid-proposal', //       400  see `detail` (a ProposalError) and `field`
  'account-mismatch', //       400  the account number typed twice differs; see `field`
  'invalid-reason', //         400  rejection reason over 300 characters
  'not-found', //              404  no such proposal, or no QR on it
  'not-pending', //            409  already confirmed, rejected or superseded
  'own-proposal', //           403  nobody confirms or rejects their own proposal
  'not-proposer', //           403  only the proposer uploads its QR
  'qr-not-requested', //       409  this proposal keeps or removes the QR
  'qr-already-uploaded', //    409  one QR per proposal: propose again to change it
  'not-image', //              415  not a JPEG or PNG (type and bytes must agree)
  'invalid-image', //          422  could not be decoded
  'qr-missing', //             409  confirm: the new QR was never uploaded
  'qr-expired', //             409  confirm: the QR's expiry date has arrived
  'read-failed', //            500
  'write-failed', //           500  retryable
  'save-failed', //            500  the QR could not be stored; retryable
  'not-available', //          404  public QR: none confirmed, switched off or expired
] as const;
export type DonationFailure = (typeof DONATION_FAILURES)[number];

/** One method as the form sends it: the account number typed twice. */
export interface ProposeMethodInput {
  kind: DonationMethodKind;
  bankName: string;
  accountHolder: string;
  /** Required for `bank`; optional (may be '') for `qr`. */
  accountNumber: string;
  /** The second typing. Must equal `accountNumber` ignoring spaces, dashes and dots. Never stored. */
  accountNumberConfirm: string;
  accountType: AccountType;
  currency: Currency;
  note: string;
}

export interface ProposeRequest {
  methods: ProposeMethodInput[];
  active: boolean;
  /** "YYYY-MM-DD", after today in the shelter's zone, or null. */
  qrExpiresAt: string | null;
  /** `replace`: upload the image next, to `/api/donations/pending/{pendingId}/qr`. */
  qrAction: QrAction;
}

export interface ProposeResponse {
  pendingId: string;
  /** Open proposals this one replaced. */
  superseded: string[];
}

export interface ConfirmRequest {
  pendingId: string;
}

export interface ConfirmResponse {
  version: number;
}

export interface RejectRequest {
  pendingId: string;
  /** Optional, at most 300 characters. */
  reason?: string | null;
}

export interface RejectResponse {
  historyId: string;
}

export interface DonationFailureBody {
  error: DonationFailure;
  /** For `invalid-proposal` and `account-mismatch`: e.g. `methods[0].accountNumberConfirm`. */
  field?: string;
  /** For `invalid-proposal`: which rule. */
  detail?: ProposalError;
}

/** The refusal named by a response, or null if the response is not one of ours. */
export function donationFailure(response: Response): DonationFailure | null {
  const value = response.headers.get(DONATION_FAILURE_HEADER);
  return value && (DONATION_FAILURES as readonly string[]).includes(value) ? (value as DonationFailure) : null;
}
