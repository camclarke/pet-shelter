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
import { t } from '@/i18n';
import type { Pet } from '@/lib/types';

export function AdminDashboard() {
  const [drafts, setDrafts] = useState<PetDraft[] | null>(null);
  const [pets, setPets] = useState<Pet[] | null>(null);
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
        <Link href="/admin/intake" className="btn btn--action">
          + Nuevo ingreso
        </Link>
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
                    <strong>{draft.name.trim() || 'Sin nombre'}</strong>
                    <span className="t-data">
                      {progress.done} de {progress.total} pasos
                      {draft.media.length > 0 && ` · ${draft.media.length} foto${
                        draft.media.length === 1 ? '' : 's'
                      }`}
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
                <Link href={`/adopt/${pet.slug}`}>
                  <strong>{pet.name}</strong>
                  <span className="t-data">
                    {t.statusLabel(pet.status)} · {t.formatMeta(pet)}
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
