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
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { User } from 'firebase/auth';

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

export function MyApplications({ user }: { user: User }) {
  const copy = t.applications;
  const [items, setItems] = useState<MyApplication[] | null>(null);
  const [pets, setPets] = useState<Map<string, Pet>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const mine = await listMyApplications(user);
      setPets(await getPublicPets(mine.map((m) => m.petId)));
      setItems(mine);
    } catch (caught) {
      console.error('[account] could not load applications', (caught as { code?: string })?.code);
      setError(copy.loadFailed);
      setItems([]);
    }
  }, [user, copy.loadFailed]);

  useEffect(() => {
    void load();
  }, [load]);

  async function withdraw(application: MyApplication) {
    setBusy(true);
    setError(null);
    try {
      await withdrawMyApplication(application);
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
  onAskWithdraw,
  onWithdraw,
  onKeep,
}: MyApplicationsViewProps) {
  const copy = t.applications;

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
                  {pet ? <Link href={`/adopt/${pet.slug}`}>{pet.name}</Link> : copy.unknownPet}
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
              </div>

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
