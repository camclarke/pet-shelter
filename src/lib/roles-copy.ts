/**
 * Spanish wording for the team roles screen: what each refusal of the role
 * routes says to the person using it. Neutral Spanish, «tú». Pure, so it is
 * tested.
 *
 * Every failure the wire contract can name has a sentence here, and none of
 * them blames the person for a server fault. Nothing here names the internal
 * superuser role.
 */

import { HIDDEN_ROLES, ROLE_LABELS, type RoleKey } from '@/config/roles';
import { NO_ACCOUNT_HINT, type RoleFailure } from './role-admin-protocol';

export const ROLE_FAILURE_TEXT: Record<RoleFailure, string> = {
  unauthenticated: 'Tu sesión venció. Entra de nuevo.',
  forbidden: 'Tu cuenta no puede cambiar roles.',
  'requires-recent-login': 'Por seguridad, confirma que eres tú para seguir.',
  'not-json': 'El envío no se pudo leer. Intenta de nuevo.',
  'invalid-body': 'Revisa el correo y el rol: algo no se pudo leer.',
  'too-large': 'El envío es demasiado grande.',
  'too-slow': 'El envío tardó demasiado. Revisa tu conexión e intenta de nuevo.',
  'body-read-failed': 'Se cortó el envío. Intenta de nuevo.',
  'not-allowed-role': 'Tu cuenta no puede dar ni quitar ese rol.',
  'no-account': NO_ACCOUNT_HINT,
  self: 'Nadie cambia sus propios roles. Debe hacerlo otra persona.',
  'protected-account': 'Esa cuenta no la puede cambiar tu rol.',
  'no-change': 'No había nada que cambiar: esa persona ya estaba así.',
  'last-owner': 'No se puede quitar: debe quedar al menos una persona como Responsable del refugio.',
  'claims-too-large': 'Esa cuenta ya tiene demasiados datos de acceso y no admite más cambios.',
  'read-failed': 'No se pudo leer la cuenta. No se cambió nada. Intenta de nuevo.',
  'audit-failed': 'No se pudo anotar el cambio. No se cambió nada. Intenta de nuevo.',
  'write-failed': 'El cambio no se pudo guardar. Recarga la lista para ver cómo quedó la cuenta.',
  'not-applied': 'El cambio no quedó aplicado. Recarga la lista para ver cómo quedó la cuenta.',
  'tokens-not-revoked': 'El rol se quitó, pero la sesión de esa persona sigue abierta. Pídele que cierre sesión y vuelva a entrar.',
  'audit-incomplete': 'El cambio se aplicó, pero su registro quedó incompleto. Recarga la lista.',
};

/** What to say for a failure; null means the response was not one of ours (the edge, the network). */
export function roleFailureText(failure: RoleFailure | null): string {
  if (failure) return ROLE_FAILURE_TEXT[failure];
  return 'No se pudo completar. Revisa tu conexión e intenta de nuevo.';
}

/** Said when the list itself cannot be read. */
export const STAFF_LOAD_ERROR = 'No se pudo cargar la lista del equipo. Intenta de nuevo.';

/** The role's name as a screen may show it; the internal role is never named. */
export function roleName(role: string): string {
  return HIDDEN_ROLES.includes(role as RoleKey) ? '(rol interno)' : (ROLE_LABELS[role as RoleKey] ?? role);
}

export const roleAction = { grant: 'Dar', revoke: 'Quitar' } as const;
