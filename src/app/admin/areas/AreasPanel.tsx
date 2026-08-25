/**
 * The occupancy board, and the form that defines the pens behind it.
 *
 * ── Why the board and the editor are one screen ───────────────────────────
 * Plan section 13.3: the manager announcing an incoming animal needs to know
 * one thing immediately — is there room in quarantine? An occupancy figure
 * that lives on a different page than the areas is a figure nobody checks at
 * the moment it could change the decision.
 *
 * ── The cohorting clock ───────────────────────────────────────────────────
 * Each quarantine pen shows when its most recent animal arrived, because
 * putting a new animal into an occupied quarantine pen restarts the
 * observation period for everyone already inside. That is the one derived
 * number that makes cohorting visible, and it is only actionable before the
 * decision, not after.
 *
 * Everything here is read CLIENT-SIDE through `firestore.rules`, which
 * restrict `areas` and the `placements` collection group to admins. So the
 * authorization is enforced rather than re-implemented, and a missing claim
 * surfaces as `permission-denied` — which is the authorization working.
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import {
  areaToDraft,
  emptyAreaDraft,
  summarizeArea,
  validateArea,
  type AreaDraft,
  type AreaError,
  type AreaSummary,
} from '@/lib/areas';
import { getOccupancyForAreas, getPetsByIds, listAreas, saveArea } from '@/lib/areas-admin';
import type { PlacementInterval } from '@/lib/placements';
import { t } from '@/i18n';
import type { Area, AreaKind, Pet } from '@/lib/types';

const KINDS: AreaKind[] = ['quarantine', 'general', 'medical', 'isolation', 'maternity'];

export function AreasPanel() {
  const [areas, setAreas] = useState<Area[] | null>(null);
  const [occupancy, setOccupancy] = useState<PlacementInterval[]>([]);
  const [pets, setPets] = useState<Map<string, Pet>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);

  const [editing, setEditing] = useState<string | null | 'new'>(null);
  const [draft, setDraft] = useState<AreaDraft>(emptyAreaDraft());
  const [errors, setErrors] = useState<AreaError[]>([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const list = await listAreas();
      setAreas(list);

      // Occupancy is fetched one area at a time on purpose — see the header of
      // `areas-admin.ts`. A single sweep would need a collection-group index
      // on one field, which is the shape that broke the microchip lookup.
      const open = await getOccupancyForAreas(list.map((a) => a.id));
      setOccupancy(open);

      setPets(await getPetsByIds([...new Set(open.map((p) => p.petId))]));
    } catch (caught) {
      console.error('[areas] could not load', caught);
      const code = (caught as { code?: string })?.code;
      setLoadError(
        code === 'permission-denied'
          ? 'Firestore rechazó la lectura por permisos. Si te acaban de dar acceso, cierra sesión y vuelve a entrar.'
          : 'No pudimos cargar las áreas. Revisa tu conexión e intenta de nuevo.',
      );
      setAreas([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const summaries = useMemo(() => {
    const map = new Map<string, AreaSummary>();
    for (const area of areas ?? []) map.set(area.id, summarizeArea(area, occupancy));
    return map;
  }, [areas, occupancy]);

  function startNew() {
    setEditing('new');
    setDraft(emptyAreaDraft());
    setErrors([]);
  }

  function startEdit(area: Area) {
    setEditing(area.id);
    setDraft(areaToDraft(area));
    setErrors([]);
  }

  function cancel() {
    setEditing(null);
    setErrors([]);
  }

  async function submit() {
    // Every OTHER area's name — the one being edited is excluded, or renaming
    // an area to itself would report a duplicate of itself.
    const otherNames = (areas ?? [])
      .filter((a) => a.id !== editing)
      .map((a) => a.name);

    const found = validateArea(draft, otherNames);
    setErrors(found);
    if (found.length > 0) return;

    setSaving(true);
    try {
      await saveArea(editing === 'new' ? null : editing, draft);
      setEditing(null);
      await load();
    } catch (caught) {
      console.error('[areas] could not save', caught);
      setLoadError('No pudimos guardar el área. Revisa tu conexión e intenta de nuevo.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin">
      <header className="admin__header">
        <div>
          <h1 className="t-title">Áreas del refugio</h1>
          <p className="admin__sub">
            Dónde está cada animalito, y cuánto espacio queda. De aquí sale el rastreo de contactos
            si hay un brote.
          </p>
        </div>
        <div className="admin__header-actions">
          <Link href="/admin" className="btn btn--muted">
            ← Panel
          </Link>
          <button type="button" className="btn btn--action" onClick={startNew}>
            + Nueva área
          </button>
        </div>
      </header>

      {loadError && (
        <p className="auth__error" role="alert">
          {loadError}
        </p>
      )}

      {editing !== null && (
        <AreaForm
          draft={draft}
          errors={errors}
          saving={saving}
          isNew={editing === 'new'}
          onChange={setDraft}
          onCancel={cancel}
          onSubmit={submit}
        />
      )}

      {areas === null && <p className="admin__sub">Cargando…</p>}

      {areas?.length === 0 && editing === null && (
        <div className="auth__notice">
          <p>
            Todavía no hay áreas registradas. Crea las que el refugio ya tiene —{' '}
            <strong>con los nombres que ustedes usan</strong>, aunque sean solo números.
          </p>
          <p className="admin__sub">
            No inventes nombres bonitos: si el corral del fondo se llama &ldquo;3&rdquo;, el área se
            llama &ldquo;3&rdquo;. Estos nombres se guardan en el historial de cada animalito, y
            tienen que ser los que la gente dice en voz alta cuando hay una emergencia.
          </p>
        </div>
      )}

      {areas && areas.length > 0 && (
        <ul className="area-board">
          {areas.map((area) => (
            <AreaCard
              key={area.id}
              area={area}
              summary={summaries.get(area.id)}
              occupancy={occupancy}
              pets={pets}
              onEdit={() => startEdit(area)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function AreaCard({
  area,
  summary,
  occupancy,
  pets,
  onEdit,
}: {
  area: Area;
  summary: AreaSummary | undefined;
  occupancy: PlacementInterval[];
  pets: Map<string, Pet>;
  onEdit: () => void;
}) {
  const occupants = occupancy.filter((p) => p.areaId === area.id && p.endedAt === null);

  return (
    <li className={`area-card area-card--${area.kind}${area.active ? '' : ' is-inactive'}`}>
      <div className="area-card__head">
        <div>
          <h2 className="area-card__name">{area.name}</h2>
          <p className="area-card__kind">
            {t.areaKindLabel(area.kind)}
            {!area.active && ' · fuera de servicio'}
          </p>
        </div>
        <span className={`area-card__count is-${summary?.state ?? 'unknown'}`}>
          {t.occupancyLabel(summary?.count ?? 0, area.capacity)}
        </span>
      </div>

      {area.kind === 'quarantine' && summary && summary.lastArrivalAt !== null && (
        <p className="area-card__clock">
          Último ingreso {t.daysAgoLabel(summary.daysSinceLastArrival ?? 0)}. La observación de
          todo el grupo cuenta desde ahí.
        </p>
      )}

      {occupants.length > 0 && (
        <ul className="area-card__pets">
          {occupants.map((p) => {
            const pet = pets.get(p.petId);
            return (
              <li key={p.petId}>
                <Link href={`/admin/pets/${p.petId}`}>{pet?.name || 'Sin nombre'}</Link>
              </li>
            );
          })}
        </ul>
      )}

      {occupants.length === 0 && <p className="admin__sub">Vacía.</p>}

      {area.notes && <p className="area-card__notes">{area.notes}</p>}

      <button type="button" className="auth__link" onClick={onEdit}>
        Editar
      </button>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function AreaForm({
  draft,
  errors,
  saving,
  isNew,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: AreaDraft;
  errors: AreaError[];
  saving: boolean;
  isNew: boolean;
  onChange: (draft: AreaDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <form
      className="admin-form area-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <h2 className="t-label">{isNew ? 'Nueva área' : 'Editar área'}</h2>

      <div className="admin-form__row">
        <label className="auth__field">
          <span>Nombre</span>
          <input
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            placeholder="Cuarentena 2"
            maxLength={80}
            autoFocus
          />
        </label>

        <label className="auth__field">
          <span>Tipo</span>
          <select
            value={draft.kind ?? ''}
            onChange={(event) =>
              onChange({ ...draft, kind: (event.target.value || null) as AreaKind | null })
            }
          >
            <option value="">Elige…</option>
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t.areaKindLabel(kind)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {draft.kind && <p className="auth__hint">{t.areaKindHint(draft.kind)}</p>}

      <div className="admin-form__row">
        <label className="auth__field">
          <span>Capacidad</span>
          <input
            type="number"
            min={1}
            step={1}
            value={draft.capacity ?? ''}
            onChange={(event) =>
              onChange({
                ...draft,
                // An empty field is "we have not counted", which is a real
                // answer and must not become 0 or NaN.
                capacity: event.target.value === '' ? null : Number(event.target.value),
              })
            }
            placeholder="sin contar"
          />
        </label>

        <label className="auth__field">
          <span>Notas</span>
          <input
            value={draft.notes}
            onChange={(event) => onChange({ ...draft, notes: event.target.value })}
            placeholder="Al fondo, junto al portón"
          />
        </label>
      </div>

      <p className="auth__hint">
        La capacidad puede quedar vacía. Sirve para avisar cuando un área se llena — el
        hacinamiento es en sí mismo un riesgo de contagio.
      </p>

      <label className="admin-form__check">
        <input
          type="checkbox"
          checked={draft.active}
          onChange={(event) => onChange({ ...draft, active: event.target.checked })}
        />
        <span>En servicio</span>
      </label>

      {!isNew && (
        <p className="auth__hint">
          Las áreas no se borran: se marcan fuera de servicio. El historial de cada animalito
          apunta a esta área, y borrarla dejaría ese historial sin nombre justo cuando más se
          necesita leerlo.
        </p>
      )}

      {errors.length > 0 && (
        <ul className="admin-errors" role="alert">
          {errors.map((error) => (
            <li key={error}>{t.areaError(error)}</li>
          ))}
        </ul>
      )}

      <div className="admin__footer">
        <div className="admin__footer-left">
          <button type="button" className="btn btn--muted" onClick={onCancel} disabled={saving}>
            Cancelar
          </button>
        </div>
        <div className="admin__footer-right">
          <button type="submit" className="btn btn--action" disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
    </form>
  );
}
