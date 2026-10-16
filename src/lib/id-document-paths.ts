/**
 * Where an adoption applicant's identity-card photo lives in Storage — the ONE
 * place the path is built. Pure: no Firebase import.
 *
 *     adoption-ids/{applicationId}/{side}.jpg      e.g. adoption-ids/pet1__uid1/front.jpg
 *
 * The upload route, the admin viewer, the 4e retention sweep and the erase
 * route all import these, so the prefix that `storage.rules` guards, the
 * prefix the bucket's lifecycle rule cleans up (`terraform/storage.tf`) and the
 * prefix the code writes to cannot drift apart. A test couples all three.
 *
 * ═══ WHY THIS PREFIX, AND NOT ANOTHER ════════════════════════════════════════
 *   - NOT under `users/{uid}/`: deleting an account wipes that whole prefix,
 *     while the application this photo supports is kept (/privacy). A guard
 *     test pins that account deletion never names this prefix.
 *   - NOT under `pets/{id}/private/`: any signed-in account can read that.
 *   - `storage.rules` lets admins READ here and nobody WRITE: the only writer
 *     is the upload route, through the Admin SDK.
 *
 * Every id is checked with `parseApplicationId`, so a path can only ever name
 * a real application's shape — never `../`, never an empty segment, never a
 * prefix of somebody else's folder.
 */

import { parseApplicationId } from './applications';
import type { IdDocumentSide } from './types';

/** The top-level folder. Mirrored in storage.rules and terraform/storage.tf (tested). */
export const ID_DOCUMENT_ROOT = 'adoption-ids';

/** Every side the model knows. Which ones a shelter ASKS for is `SHELTER.adoptionApplications.idDocumentSides`. */
export const ID_DOCUMENT_SIDES: readonly IdDocumentSide[] = ['front', 'back'];

export function isIdDocumentSide(value: unknown): value is IdDocumentSide {
  return typeof value === 'string' && (ID_DOCUMENT_SIDES as readonly string[]).includes(value);
}

export class InvalidIdDocumentPathError extends Error {
  constructor(reason: string) {
    super(`invalid ID document path: ${reason}`);
    this.name = 'InvalidIdDocumentPathError';
  }
}

/**
 * `adoption-ids/{applicationId}/`, with the trailing slash — so a prefix
 * listing or delete for `pet1__uid1` can never also match `pet1__uid10`.
 */
export function idDocumentPrefix(applicationId: string): string {
  if (!parseApplicationId(applicationId)) {
    throw new InvalidIdDocumentPathError('not an application id');
  }
  return `${ID_DOCUMENT_ROOT}/${applicationId}/`;
}

/** `adoption-ids/{applicationId}/{side}.jpg`. */
export function idDocumentPath(applicationId: string, side: IdDocumentSide): string {
  if (!isIdDocumentSide(side)) throw new InvalidIdDocumentPathError('not a side');
  return `${idDocumentPrefix(applicationId)}${side}.jpg`;
}
