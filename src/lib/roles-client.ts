/**
 * The browser's side of the role routes: Bearer token, JSON in, the
 * `X-Role-Failure` header out. The wire contract is `role-admin-protocol.ts`.
 *
 * Every call asks for a FRESH ID token (`getIdToken(true)`): the change route
 * refuses a sign-in older than five minutes, and the cached token can be the
 * one from before the person just re-authenticated.
 */

import type { User } from 'firebase/auth';

import {
  roleFailure,
  type RoleChangeRequest,
  type RoleChangeResponse,
  type RoleFailure,
  type StaffResponse,
} from './role-admin-protocol';

/** A refused or failed call. `failure` is null when the response was not one of ours. */
export class RoleApiError extends Error {
  readonly failure: RoleFailure | null;
  readonly status: number;

  constructor(failure: RoleFailure | null, status: number) {
    super(failure ?? `role request failed (${status})`);
    this.name = 'RoleApiError';
    this.failure = failure;
    this.status = status;
  }
}

async function call<T>(user: User, path: string, init: RequestInit): Promise<T> {
  const token = await user.getIdToken(true);
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new RoleApiError(null, 0);
  }
  if (!response.ok) throw new RoleApiError(roleFailure(response), response.status);
  return (await response.json()) as T;
}

export function fetchStaff(user: User): Promise<StaffResponse> {
  return call<StaffResponse>(user, '/api/roles/staff', { method: 'GET', cache: 'no-store' });
}

export function changeRole(user: User, request: RoleChangeRequest): Promise<RoleChangeResponse> {
  return call<RoleChangeResponse>(user, '/api/roles/change', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
}
