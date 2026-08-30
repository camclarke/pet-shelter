/**
 * The admin panel's landing screen: what is half-finished, and what is live.
 *
 * Both lists are read CLIENT-SIDE, through `firestore.rules`, rather than
 * server-rendered through the Admin SDK. That is the cost principle in
 * CLAUDE.md's `## Architecture` finally paying off — rules evaluation is free,
 * a Cloud Run render is not, and this page has no SEO value to trade for it.
 * It is also what makes the admin claim load-bearing instead of decorative:
 * if the claim is missing, the drafts query fails, and that failure is the
 * authorization working.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import { draftProgress, type PetDraft } from '@/lib/intake';
import { listDrafts } from '@/lib/pets-admin';
import { getOccupancyForAreas, listAreas } from '@/lib/areas-admin';
import { shouldHaveOpenPlacement } from '@/lib/arrival';
import { t } from '@/i18n';
import type { Pet } from '@/lib/types';

export function AdminDashboard() {
  const [drafts, setDrafts] = useState<PetDraft[] | null>(null);
  const [pets, setPets] = useState<Pet[] | null>(null);
  /**
   * Every pet with an OPEN placement, derived from one query per area
   * rather than one per pet. Fifty animals would be fifty reads the other
   * way round; six pens is six, and the answer is the same set.
   */
  const [placed, setPlaced] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [{ collection, getDocs, limit, orderBy, query }, { getFirebase }] = await Promise.all([
        import('firebase/firestore'),
        import('@/lib/firebase-client'),
      ]);
      const { db } = getFirebase();

      const [draftList, petSnap] = await Promise.all([
        listDrafts(),
        getDocs(query(collection(db, 'pets'), orderBy('createdAt', 'desc'), limit(50))),
      ]);

      setDrafts(draftList);
      setPets(petSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as Pet));

      const areas = await listAreas();
      const open = await getOccupancyForAreas(areas.map((a) => a.id));
      setPlaced(new Set(open.map((placement) => placement.petId)));
    } catch (caught) {
      console.error('[admin] could not load', caught);
      const code = (caught as { code?: string })?.code;
      setError(
        code === 'permission-denied'
          ? 'Firestore rechazó la lectura por permisos. Si te acaban de dar acceso, cierra sesión y vuelve a entrar.'
          : 'No pudimos cargar el panel. Revisa tu conexión e intenta de nuevo.',
      );
      setDrafts([]);
      setPets([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="admin">
      <header className="admin__header">
        <div>
          <h1 className="t-title">Panel del refugio</h1>
          <p className="admin__sub">Registra un animalito nuevo o continúa una ficha a medias.</p>
        </div>
        <div className="admin__header-actions">
          <Link href="/admin/areas" className="btn btn--muted">
            Áreas
          </Link>
          <Link href="/admin/intake" className="btn btn--action">
            + Nuevo ingreso
          </Link>
        </div>
      </header>

      {error && (
        <p className="auth__error" role="alert">
          {error}
        </p>
      )}

      <section className="admin-list">
        <h2 className="t-label">Fichas sin publicar</h2>
        {drafts === null && <p className="admin__sub">Cargando…</p>}
        {drafts?.length === 0 && <p className="admin__sub">No hay fichas a medias.</p>}
        {drafts && drafts.length > 0 && (
          <ul className="admin-list__items">
            {drafts.map((draft) => {
              const progress = draftProgress(draft);
              return (
                <li key={draft.id} className="admin-list__item">
                  <Link href={`/admin/intake?draft=${draft.id}`}>
                    {/* Unfinished drafts are usually unnamed — a shelter photographs
                        the animal first and names it later — so a list of "Sin
                        nombre" rows is unusable without the photo. Reported from a
                        phone showing three identical rows, 2026-08-30.
                        Plain <img>: these are already resized to a 1600px long edge
                        by stripAndResize, and next/image would add a proxy hop for
                        an admin-only thumbnail nobody crawls. */}
                    {draft.media[0] ? (
                      <img
                        className="admin-list__thumb"
                        src={draft.media[0].url}
                        alt={draft.media[0].alt || ''}
                        loading="lazy"
                      />
                    ) : (
                      <span className="admin-list__thumb admin-list__thumb--empty" aria-hidden="true">
                        🐾
                      </span>
                    )}
                    <span className="admin-list__text">
                    <strong>{draft.name.trim() || 'Sin nombre'}</strong>
                    <span className="t-data">
                      {progress.done} de {progress.total} pasos
                      {draft.media.length > 0 && ` · ${draft.media.length} foto${
                        draft.media.length === 1 ? '' : 's'
                      }`}
                    </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="admin-list">
        <h2 className="t-label">Publicados</h2>
        {pets === null && <p className="admin__sub">Cargando…</p>}
        {pets?.length === 0 && (
          <p className="admin__sub">Todavía no hay ningún animalito publicado.</p>
        )}
        {pets && pets.length > 0 && (
          <ul className="admin-list__items">
            {pets.map((pet) => (
              <li key={pet.id} className="admin-list__item">
                {/* The INTERNAL record, not the public dossier. Everything a
                    volunteer does to an animal after publishing it — moving it
                    between pens, tracing contacts — lives at this id, and the
                    public slug is a different namespace on purpose. */}
                <Link href={`/admin/pets/${pet.id}`}>
                  <strong>{pet.name}</strong>
                  <span className="t-data">
                    {t.statusLabel(pet.status)} · {t.formatMeta(pet)}
                    {shouldHaveOpenPlacement(pet.status) && !placed.has(pet.id) && (
                      <> · <span className="admin-list__flag">sin área</span></>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
