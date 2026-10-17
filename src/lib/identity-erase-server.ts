/**
 * Step 6a of `identity-erase-handler.ts`, through the Admin SDK: ONE Firestore
 * transaction that marks the application erased, deletes the private
 * documents, blanks the notes, records why, and — for a natural death — ends
 * the adoption that names this application.
 *
 * Kept apart from the route on purpose: the route also deletes the carnet
 * photo, and `id-document-guards.test.ts` lets a module that touches ID photos
 * delete nothing itself, so every photo delete goes through
 * `deleteEveryIdDocumentVersion` (all versions). The deletes here are Firestore
 * documents, never Storage objects.
 */

import 'server-only';

import { FieldValue, type Firestore } from 'firebase-admin/firestore';

import { INTERNAL_NOTES_DOCUMENT, PRIVATE_DOCUMENT_IDS } from './applications';
import type { ErasurePlan } from './identity-erase-handler';

/** `adoptionApplications/{id}/internal/erasure`: why, when and by whom. Admin-read only. */
export const ERASURE_DOCUMENT_ID = 'erasure';

export async function commitIdentityErasure(db: Firestore, applicationId: string, plan: ErasurePlan): Promise<void> {
  const ref = db.collection('adoptionApplications').doc(applicationId);
  const internal = ref.collection(INTERNAL_NOTES_DOCUMENT.subcollection);
  const notesRef = internal.doc(INTERNAL_NOTES_DOCUMENT.id);
  const adoptionRef = plan.endAdoptionOfPetId ? db.collection('adoptions').doc(plan.endAdoptionOfPetId) : null;

  await db.runTransaction(async (tx) => {
    // Reads first, as a transaction requires.
    const [current, notes, adoption] = await Promise.all([
      tx.get(ref),
      tx.get(notesRef),
      adoptionRef ? tx.get(adoptionRef) : Promise.resolve(null),
    ]);
    if (!current.exists) throw new Error('the application vanished');

    tx.update(ref, { identityErasedAt: FieldValue.serverTimestamp() });
    for (const docId of PRIVATE_DOCUMENT_IDS) tx.delete(ref.collection('private').doc(docId));
    if (notes.exists) tx.update(notesRef, { [INTERNAL_NOTES_DOCUMENT.blankField]: '' });

    // Re-checked inside the transaction: only an adoption that still names
    // THIS application ends here.
    const endAdoption = Boolean(adoption?.exists && adoption.get('applicationId') === applicationId);
    if (adoptionRef && endAdoption) tx.delete(adoptionRef);

    tx.set(internal.doc(ERASURE_DOCUMENT_ID), {
      reason: plan.reason,
      erasedBy: plan.erasedBy,
      erasedAt: FieldValue.serverTimestamp(),
      adoptionEnded: endAdoption,
    });
  });
}
