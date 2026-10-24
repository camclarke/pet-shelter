/**
 * Spanish wording for the donation admin screen: what each refusal of the
 * donation routes (and of the form's own pre-check) says to the person using
 * it. Neutral Spanish, «tú». Pure, so it is tested.
 *
 * Every failure the wire contract can name has a sentence here, and none of
 * them blames the person for a server fault.
 */

import type { DonationFailure } from './donations-protocol';
import type { ProposalError } from './donations';

export const PROPOSAL_ERROR_TEXT: Record<ProposalError, string> = {
  'invalid-body': 'Revisa el formulario: hay algo que no se pudo leer.',
  'no-methods': 'Agrega al menos una forma de donar.',
  'too-many-methods': 'Son demasiadas formas de donar. Quita alguna.',
  'invalid-kind': 'Elige el tipo de cada forma de donar.',
  'field-required': 'Falta un dato obligatorio (banco o titular).',
  'field-too-long': 'Un dato es demasiado largo. Acórtalo.',
  'invalid-text': 'Un dato tiene caracteres que no se pueden usar.',
  'invalid-account-type': 'Elige el tipo de cuenta.',
  'invalid-currency': 'Elige la moneda.',
  'invalid-account-number': 'El número de cuenta no es válido: usa de 4 a 34 letras o números.',
  'account-mismatch': 'Los dos números de cuenta no coinciden. Escríbelos de nuevo.',
  'invalid-active': 'Elige si la página pública se muestra o no.',
  'invalid-qr-action': 'Elige qué hacer con el QR.',
  'invalid-qr-expiry': 'La fecha de vencimiento del QR no es válida.',
  'qr-expiry-past': 'La fecha de vencimiento del QR debe ser posterior a hoy.',
  'qr-expiry-without-qr': 'Sin QR no hay fecha de vencimiento. Quítala.',
  'qr-method-without-qr': 'Una forma de donar con QR necesita un QR. Cambia la opción del QR.',
};

export const FAILURE_TEXT: Record<DonationFailure, string> = {
  unauthenticated: 'Tu sesión venció. Entra de nuevo.',
  forbidden: 'Tu cuenta no puede hacer esto.',
  'requires-recent-login': 'Por seguridad, confirma que eres tú para seguir.',
  'not-json': 'El envío no se pudo leer. Intenta de nuevo.',
  'invalid-body': 'El envío no se pudo leer. Intenta de nuevo.',
  'too-large': 'El envío es demasiado grande.',
  'too-slow': 'El envío tardó demasiado. Revisa tu conexión e intenta de nuevo.',
  'body-read-failed': 'Se cortó el envío. Intenta de nuevo.',
  'invalid-proposal': 'Revisa el formulario.',
  'account-mismatch': 'Los dos números de cuenta no coinciden. Escríbelos de nuevo.',
  'invalid-reason': 'El motivo es demasiado largo (máximo 300 caracteres).',
  'not-found': 'No encontramos esa propuesta. Puede que ya se haya reemplazado.',
  'not-pending': 'Esa propuesta ya no está pendiente. Recarga la página.',
  'own-proposal': 'Nadie confirma ni rechaza su propia propuesta. Debe hacerlo otra persona.',
  'not-proposer': 'Solo quien hizo la propuesta puede subir su QR.',
  'qr-not-requested': 'Esta propuesta no pide un QR nuevo.',
  'qr-already-uploaded': 'Esta propuesta ya tiene su QR. Para cambiarlo, haz una propuesta nueva.',
  'not-image': 'El QR debe ser una imagen JPG o PNG.',
  'invalid-image': 'No se pudo leer la imagen del QR. Prueba con otra foto.',
  'qr-missing': 'Falta el QR nuevo de esta propuesta. Quien la hizo debe proponer de nuevo.',
  'qr-expired': 'La fecha de vencimiento del QR ya llegó. Quien la hizo debe proponer de nuevo.',
  'read-failed': 'No se pudo leer el dato. Intenta de nuevo.',
  'write-failed': 'No se pudo guardar. Intenta de nuevo.',
  'save-failed': 'No se pudo guardar el QR. Intenta de nuevo.',
  'not-available': 'Todavía no hay un QR publicado.',
};

/** What to say for a failure; `field`/`detail` refine an invalid proposal. */
export function donationFailureText(failure: DonationFailure | null, detail?: ProposalError | null): string {
  if (failure === 'invalid-proposal' && detail && PROPOSAL_ERROR_TEXT[detail]) return PROPOSAL_ERROR_TEXT[detail];
  if (failure) return FAILURE_TEXT[failure];
  return 'No se pudo completar. Revisa tu conexión e intenta de nuevo.';
}

/** The labels of the fields the diff names, in the confirmer's side-by-side view. */
export const METHOD_FIELD_LABEL = {
  kind: 'Tipo',
  bankName: 'Banco',
  accountHolder: 'Titular',
  accountNumber: 'Número de cuenta',
  accountType: 'Tipo de cuenta',
  currency: 'Moneda',
  note: 'Nota',
} as const;

export const METHOD_KIND_LABEL = { bank: 'Transferencia bancaria', qr: 'Pago con QR' } as const;
