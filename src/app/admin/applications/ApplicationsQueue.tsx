/**
 * The adoption application queue — plan §6: applications "queued against the
 * pet", because the decision is always between the people asking for the SAME
 * animal.
 *
 * Read client-side under `firestore.rules`, like the rest of the admin console.
 * Filtering and grouping happen in the browser (`groupApplicationsByPet`), so
 * the query needs no composite index — see `applications-admin.ts`.
 *
 * The rendering is split into `QueueView`, which takes plain data and has no
 * effects, so it can be rendered to static HTML and measured at 360px without
 * an admin session.
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import { SHELTER, type ApplicationQuestion } from '@/config/shelter';
import {
  APPLICATION_STATUSES,
  applicantLabel,
  groupApplicationsByPet,
  type ApplicationFilter,
  type ApplicationGroup,
} from '@/lib/applications';
import { listApplications, type ApplicationRecord } from '@/lib/applications-admin';
import { getPetsByIds } from '@/lib/areas-admin';
import { formatDate } from '@/lib/date-input';
import { t } from '@/i18n';
import type { Pet } from '@/lib/types';

export function ApplicationsQueue() {
  const copy = t.applications;
  const [records, setRecords] = useState<ApplicationRecord[] | null>(null);
  const [pets, setPets] = useState<Map<string, Pet>>(new Map());
  const [filter, setFilter] = useState<ApplicationFilter>('open');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await listApplications();
      setPets(await getPetsByIds([...new Set(list.map((r) => r.petId))]));
      setRecords(list);
    } catch (caught) {
      const code = (caught as { code?: string })?.code;
      console.error('[admin/applications] could not load', code);
      setError(code === 'permission-denied' ? copy.permissionDenied : copy.adminLoadFailed);
      setRecords([]);
    }
  }, [copy.permissionDenied, copy.adminLoadFailed]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(
    () => groupApplicationsByPet(records ?? [], filter),
    [records, filter],
  );

  const config = SHELTER.adoptionApplications;

  return (
    <QueueView
      loading={records === null}
      error={error}
      filter={filter}
      onFilter={setFilter}
      groups={groups}
      pets={pets}
      questions={config.questions}
      formNote={copy.formStateNote(config.enabled, config.questionsAreDraft)}
    />
  );
}

export interface QueueViewProps {
  loading: boolean;
  error: string | null;
  filter: ApplicationFilter;
  onFilter: (filter: ApplicationFilter) => void;
  groups: ApplicationGroup<ApplicationRecord>[];
  pets: Map<string, Pet>;
  questions: readonly ApplicationQuestion[];
  formNote: string | null;
}

export function QueueView({
  loading,
  error,
  filter,
  onFilter,
  groups,
  pets,
  questions,
  formNote,
}: QueueViewProps) {
  const copy = t.applications;

  return (
    <div className="admin">
      <header className="admin__header">
        <div>
          <h1 className="t-title">{copy.queueTitle}</h1>
          <p className="admin__sub">{copy.queueIntro}</p>
        </div>
        <div className="admin__header-actions">
          <Link href="/admin" className="btn btn--muted">
            {copy.backToPanel}
          </Link>
        </div>
      </header>

      {formNote && (
        <p className="auth__notice auth__notice--warn" role="status">
          {formNote}
        </p>
      )}

      {error && (
        <p className="auth__error" role="alert">
          {error}
        </p>
      )}

      <label className="auth__field queue-filter">
        <span className="t-label">{copy.filterLabel}</span>
        <select value={filter} onChange={(event) => onFilter(event.target.value as ApplicationFilter)}>
          <option value="open">{copy.filterOpen}</option>
          <option value="all">{copy.filterAll}</option>
          {APPLICATION_STATUSES.map((status) => (
            <option key={status} value={status}>
              {t.applicationStatusLabel(status)}
            </option>
          ))}
        </select>
      </label>

      {loading && <p className="admin__sub">{copy.loading}</p>}
      {!loading && groups.length === 0 && <p className="admin__sub">{copy.emptyQueue}</p>}

      {groups.map((group) => {
        const pet = pets.get(group.petId);
        return (
          <section key={group.petId} className="admin-list queue-group">
            <div className="queue-group__head">
              <h2 className="queue-group__name">{pet?.name ?? copy.unknownPet}</h2>
              {pet && <span className="t-data">{t.statusLabel(pet.status)}</span>}
              {pet && (
                <Link href={`/admin/pets/${pet.id}`} className="auth__link queue-group__record">
                  {copy.internalRecord}
                </Link>
              )}
            </div>
            <ul className="admin-list__items">
              {group.applications.map((application) => (
                <li key={application.id} className="admin-list__item">
                  <Link href={`/admin/applications/${application.id}`}>
                    <span className="admin-list__text">
                      <strong>{applicantLabel(questions, application)}</strong>
                      <span className="queue-row__meta">
                        <span className={`app-status app-status--${application.status}`}>
                          {t.applicationStatusLabel(application.status)}
                        </span>{' '}
                        <span className="t-data">
                          {copy.submittedOn(formatDate(application.submittedAt))}
                          {!application.applicantEmailVerified && ` · ${copy.emailUnverifiedTag}`}
                        </span>
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
