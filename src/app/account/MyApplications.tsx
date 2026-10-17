/**
 * "Mis solicitudes" on /account: the signed-in visitor's own adoption
 * applications, with their status and the option to withdraw an open one.
 *
 * Renders NOTHING until it has loaded, and nothing at all for someone with no
 * applications — which, while the public form is switched off, is everyone.
 * An empty "Mis solicitudes" heading would advertise a feature that is not on.
 *
 * Reads through `firestore.rules`: the query is constrained to the user's own
 * uid because the rule requires it, and the status comes with no internal
 * notes, because those live in a document this user cannot read.
 *
 * Split into a container and `MyApplicationsView` (plain data, no effects) so
 * the list can be rendered to static HTML and measured at 360px without
 * signing anyone in.
 *
 * ── "Falta tu carnet" (portion 4c-2) ────────────────────────────────────────
 * An open application whose ID photo never arrived — the send wrote the
 * application and the upload failed, and the tab is gone — says so here and
 * offers the upload again, through the same route, under the same checks. It
 * is offered ONLY while online applications are switched on: with the switch
 * off the route answers 404 to everyone (the kill switch, critic #10), so the
 * line points to WhatsApp instead of a button that cannot work.
 */

'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import type { User } from 'firebase/auth';

import { SHELTER } from '@/config/shelter';
import {
  getPublicPets,
  listMyApplications,
  withdrawMyApplication,
  type MyApplication,
} from '@/lib/applications-client';
import { applicantCanWithdraw } from '@/lib/applications';
import { formatDate } from '@/lib/date-input';
import { t } from '@/i18n';
import type { Pet } from '@/lib/types';
import { IdPhotoUploader } from '@/app/adopt/[slug]/apply/IdPhotoStep';

/**
 * The route has the photo: that application no longer lacks it. Applied AT
 * ONCE, before the reload answers, so "Falta la foto…" and «Subir foto» never
 * flash back for a photo that has arrived (review 4c-2 #7).
 */
export function withCarnetReceived(items: MyApplication[] | null, id: string): MyApplication[] | null {
  return items?.map((item) => (item.id === id ? { ...item, idDocumentMissing: false } : item)) ?? null;
}

/**
 * What a failed load leaves on screen: what was already shown, never an
 * emptied list — a reload after an upload that hits a dead connection must
 * not make the person's applications vanish (review 4c-2 #7).
 */
export function itemsAfterFailedLoad(previous: MyApplication[] | null): MyApplication[] {
  return previous ?? [];
}

/** What the list reaches outside itself. Tests only; production gets the defaults. */
export interface MyApplicationsServices {
  list: typeof listMyApplications;
  pets: typeof getPublicPets;
  withdraw: typeof withdrawMyApplication;
}

export const DEFAULT_MY_APPLICATIONS_SERVICES: MyApplicationsServices = {
  list: listMyApplications,
  pets: getPublicPets,
  withdraw: withdrawMyApplication,
};

export function MyApplications({
  user,
  services = DEFAULT_MY_APPLICATIONS_SERVICES,
}: {
  user: User;
  services?: MyApplicationsServices;
}) {
  const copy = t.applications;
  const [items, setItems] = useState<MyApplication[] | null>(null);
  const [pets, setPets] = useState<Map<string, Pet>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadingFor, setUploadingFor] = useState<string | null>(null);
  const [uploadedFor, setUploadedFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const mine = await services.list(user);
      setPets(await services.pets(mine.map((m) => m.petId)));
      setItems(mine);
    } catch (caught) {
      console.error('[account] could not load applications', (caught as { code?: string })?.code);
      setError(copy.loadFailed);
      setItems(itemsAfterFailedLoad);
    }
  }, [user, services, copy.loadFailed]);

  useEffect(() => {
    void load();
  }, [load]);

  async function withdraw(application: MyApplication) {
    setBusy(true);
    setError(null);
    try {
      await services.withdraw(application);
      setConfirming(null);
      await load();
    } catch (caught) {
      console.error('[account] could not withdraw', (caught as { code?: string })?.code);
      setError(copy.withdrawFailed);
    } finally {
      setBusy(false);
    }
  }

  if (items === null) return null;
  if (items.length === 0 && !error) return null;

  return (
    <MyApplicationsView
      items={items}
      pets={pets}
      error={error}
      confirming={confirming}
      busy={busy}
      uploadEnabled={SHELTER.adoptionApplications.enabled}
      uploadingFor={uploadingFor}
      uploadedFor={uploadedFor}
      uploader={
        uploadingFor ? (
          <IdPhotoUploader
            user={user}
            applicationId={uploadingFor}
            onUploaded={() => {
              const id = uploadingFor;
              // Received, shown at once; the reload only confirms it.
              setItems((previous) => withCarnetReceived(previous, id));
              setUploadedFor(id);
              setUploadingFor(null);
              void load();
            }}
            onCancel={() => setUploadingFor(null)}
          />
        ) : null
      }
      onAskUpload={(id) => {
        setUploadedFor(null);
        setUploadingFor(id);
      }}
      onAskWithdraw={setConfirming}
      onWithdraw={(application) => void withdraw(application)}
      onKeep={() => setConfirming(null)}
    />
  );
}

export interface MyApplicationsViewProps {
  items: MyApplication[];
  pets: Map<string, Pet>;
  error: string | null;
  /** The application whose withdrawal is being confirmed, if any. */
  confirming: string | null;
  busy: boolean;
  /** `SHELTER.adoptionApplications.enabled`: the route accepts uploads only while it is on. */
  uploadEnabled: boolean;
  /** The application whose carnet upload is open, if any (one at a time). */
  uploadingFor: string | null;
  /** The application whose carnet just arrived, for one confirmation line. */
  uploadedFor: string | null;
  /** The uploader for `uploadingFor`, rendered under that application. */
  uploader: ReactNode;
  onAskUpload: (id: string) => void;
  onAskWithdraw: (id: string) => void;
  onWithdraw: (application: MyApplication) => void;
  onKeep: () => void;
}

export function MyApplicationsView({
  items,
  pets,
  error,
  confirming,
  busy,
  uploadEnabled,
  uploadingFor,
  uploadedFor,
  uploader,
  onAskUpload,
  onAskWithdraw,
  onWithdraw,
  onKeep,
}: MyApplicationsViewProps) {
  const copy = t.applications;
  const steps = t.applicationSteps;

  return (
    <section className="my-applications">
      <h2 className="t-label">{copy.mine}</h2>
      {error && (
        <p className="auth__error" role="alert">
          {error}
        </p>
      )}
      <ul className="admin-list__items">
        {items.map((application) => {
          const pet = pets.get(application.petId);
          return (
            <li key={application.id} className="admin-list__item--record">
              <div>
                <strong>
                  {pet ? (
                    <Link href={`/adopt/${pet.slug}`} className="my-applications__pet">
                      {pet.name}
                    </Link>
                  ) : (
                    copy.unknownPet
                  )}
                </strong>
                <span>
                  <span className="app-status">{t.applicantStatusLabel(application.status)}</span>
                  {application.submittedAt !== null && (
                    <span className="t-data"> · {copy.submittedOn(formatDate(application.submittedAt))}</span>
                  )}
                </span>
                <span className="my-applications__why">
                  {t.applicantStatusExplanation(application.status)}
                </span>
                {application.idDocumentMissing && (
                  <span className="my-applications__carnet">
                    {uploadEnabled ? steps.carnetMissing : steps.carnetMissingPaused}
                  </span>
                )}
                {uploadedFor === application.id && !application.idDocumentMissing && (
                  <span className="my-applications__carnet" role="status">
                    {steps.uploadDone}
                  </span>
                )}
              </div>

              {application.idDocumentMissing && uploadEnabled && (
                <div className="my-applications__upload">
                  {uploadingFor === application.id ? (
                    uploader
                  ) : (
                    <button
                      type="button"
                      className="btn btn--brand"
                      onClick={() => onAskUpload(application.id)}
                      disabled={busy || uploadingFor !== null}
                    >
                      {steps.uploadPhoto}
                    </button>
                  )}
                </div>
              )}

              {applicantCanWithdraw(application.status) && (
                <div className="admin-list__actions">
                  {confirming === application.id ? (
                    <>
                      <p className="auth__hint my-applications__confirm">{copy.withdrawQuestion}</p>
                      <button
                        type="button"
                        className="btn btn--muted"
                        onClick={() => onWithdraw(application)}
                        disabled={busy}
                      >
                        {copy.withdrawConfirm}
                      </button>
                      <button type="button" className="btn btn--brand" onClick={onKeep} disabled={busy}>
                        {copy.keep}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--muted"
                      onClick={() => onAskWithdraw(application.id)}
                      disabled={busy}
                    >
                      {copy.withdraw}
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
