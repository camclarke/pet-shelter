/**
 * One animal's internal record: where it is, where it has been, and — if it
 * gets sick — everyone it has been beside.
 *
 * ── Why this page exists at all ───────────────────────────────────────────
 * The outbreak ledger had a proven READER and no writer. `placements.ts` and
 * `placements-server.ts` were built and tested on 2026-08-16 and the trace was
 * verified against live Firestore with hand-computed answers — but nothing in
 * the product had ever written a placement, so an animal could be marked
 * `quarantine` while the system recorded nowhere it had been. This screen is
 * the writer.
 *
 * ── The move is the only thing that changes status here ───────────────────
 * `statusAfterPlacement` derives it, and only two reasons move an animal along
 * the pipeline: an `intake` placement takes an announced animal into
 * quarantine, and a `quarantine-cleared` one takes it into general population.
 * Both are explicit, attributed human actions rather than timers — plan
 * section 13.4. Everything else leaves the status alone, which is why an
 * animal can be moved to the isolation pen without losing its place on the
 * wall: isolation is an AREA KIND, not a status.
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import { useAuth } from '@/components/AuthProvider';
import {
  placementWarnings,
  summarizeArea,
  type PlacementWarning,
} from '@/lib/areas';
import {
  getAreaOccupancy,
  getPetById,
  getPetPlacementRecords,
  getUserLabels,
  getPetsByIds,
  listAreas,
  movePet,
  openPlacement,
  releasePet,
  traceOutbreak,
  type OutbreakTrace,
  type PlacementRecord,
} from '@/lib/areas-admin';
import { INCUBATION_MAX_DAYS, type Pathogen, type PlacementInterval } from '@/lib/placements';
import { t } from '@/i18n';
import type { Area, Pet, PlacementReason } from '@/lib/types';

const REASONS: PlacementReason[] = [
  'intake',
  'quarantine-cleared',
  'transfer',
  'medical',
  'outbreak',
];

const PATHOGENS: Pathogen[] = ['moquillo', 'parvovirus'];

/** `YYYY-MM-DD` in the browser's own timezone, for a date input's default. */
function todayInputValue(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

/**
 * A `YYYY-MM-DD` field value as a local-midday Date.
 *
 * Midday rather than midnight, and local rather than UTC. `new Date('2026-08-24')`
 * parses as UTC midnight, which in Bolivia (UTC-4) is the 23rd at 20:00 — so a
 * date the vet picked would silently shift the whole exposure window by a day,
 * in the direction that drops contacts off the end of it.
 */
function parseDateInput(value: string): Date {
  const parts = value.split('-').map(Number);
  const [year, month, day] = parts;
  if (parts.length !== 3 || !year || !month || !day) return new Date();
  return new Date(year, month - 1, day, 12, 0, 0);
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString('es-BO', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function PetAdminPanel({ petId }: { petId: string }) {
  const { user } = useAuth();

  const [pet, setPet] = useState<Pet | null | 'missing'>(null);
  const [areas, setAreas] = useState<Area[]>([]);
  const [records, setRecords] = useState<PlacementRecord[] | null>(null);
  const [movers, setMovers] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);

  // ── the move form ────────────────────────────────────────────────────────
  const [targetId, setTargetId] = useState('');
  const [reason, setReason] = useState<PlacementReason>('transfer');
  const [note, setNote] = useState('');
  const [targetOccupancy, setTargetOccupancy] = useState<PlacementInterval[] | null>(null);
  const [saving, setSaving] = useState(false);

  // ── the trace ────────────────────────────────────────────────────────────
  const [pathogen, setPathogen] = useState<Pathogen>('moquillo');
  const [diagnosedAt, setDiagnosedAt] = useState(todayInputValue());
  const [trace, setTrace] = useState<OutbreakTrace | null>(null);
  const [tracedNames, setTracedNames] = useState<Map<string, Pet>>(new Map());
  const [tracing, setTracing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [found, areaList, history] = await Promise.all([
        getPetById(petId),
        listAreas(),
        getPetPlacementRecords(petId),
      ]);

      setPet(found ?? 'missing');
      setAreas(areaList);
      setRecords(history);
      setMovers(await getUserLabels(history.map((r) => r.movedBy)));
    } catch (caught) {
      console.error('[admin/pet] could not load', caught);
      const code = (caught as { code?: string })?.code;
      setError(
        code === 'permission-denied'
          ? 'Firestore rechazó la lectura por permisos. Si te acaban de dar acceso, cierra sesión y vuelve a entrar.'
          : 'No pudimos cargar la ficha. Revisa tu conexión e intenta de nuevo.',
      );
      setRecords([]);
    }
  }, [petId]);

  useEffect(() => {
    void load();
  }, [load]);

  const current = records ? openPlacement(records) : null;
  const currentArea = areas.find((a) => a.id === current?.areaId) ?? null;
  const target = areas.find((a) => a.id === targetId) ?? null;

  // The target pen's occupancy is fetched when it is CHOSEN rather than for
  // every area up front: the warnings only matter for the one being
  // considered, and loading six pens to show one is six reads a phone pays for.
  useEffect(() => {
    if (!targetId) {
      setTargetOccupancy(null);
      return;
    }
    let cancelled = false;
    setTargetOccupancy(null);
    getAreaOccupancy(targetId)
      .then((open) => {
        if (!cancelled) setTargetOccupancy(open);
      })
      .catch((caught) => console.error('[admin/pet] could not read occupancy', caught));
    return () => {
      cancelled = true;
    };
  }, [targetId]);

  const warnings: PlacementWarning[] = useMemo(() => {
    if (!target || targetOccupancy === null) return [];
    return placementWarnings({
      target,
      summary: summarizeArea(target, targetOccupancy),
      reason,
      from: currentArea,
    });
  }, [target, targetOccupancy, reason, currentArea]);

  async function submitMove() {
    if (!pet || pet === 'missing' || !target || !user) return;
    setSaving(true);
    setError(null);
    try {
      await movePet({ pet, area: target, reason, note }, user);
      setTargetId('');
      setNote('');
      setReason('transfer');
      await load();
    } catch (caught) {
      console.error('[admin/pet] could not move', caught);
      setError('No pudimos registrar el movimiento. Revisa tu conexión e intenta de nuevo.');
    } finally {
      setSaving(false);
    }
  }

  async function submitRelease() {
    setSaving(true);
    setError(null);
    try {
      await releasePet(petId);
      await load();
    } catch (caught) {
      console.error('[admin/pet] could not release', caught);
      setError('No pudimos registrar la salida. Revisa tu conexión e intenta de nuevo.');
    } finally {
      setSaving(false);
    }
  }

  async function runTrace() {
    setTracing(true);
    setError(null);
    try {
      const result = await traceOutbreak(petId, pathogen, parseDateInput(diagnosedAt));
      setTrace(result);
      setTracedNames(await getPetsByIds([...new Set(result.contacts.map((c) => c.petId))]));
    } catch (caught) {
      console.error('[admin/pet] could not trace', caught);
      setError(
        'No pudimos completar el rastreo. NO lo interpretes como "no hubo contactos" — vuelve a intentarlo.',
      );
      setTrace(null);
    } finally {
      setTracing(false);
    }
  }

  if (pet === null && records === null && !error) {
    return <p className="admin__sub">Cargando…</p>;
  }

  if (pet === 'missing') {
    return (
      <div className="admin">
        <p className="auth__error">Esa ficha ya no existe.</p>
        <Link href="/admin" className="btn btn--muted">
          ← Panel
        </Link>
      </div>
    );
  }

  return (
    <div className="admin">
      <header className="admin__header">
        <div>
          <h1 className="t-title">{pet?.name || 'Sin nombre'}</h1>
          <p className="admin__sub">
            {pet && `${t.statusLabel(pet.status)} · ${t.formatMeta(pet)}`}
          </p>
        </div>
        <div className="admin__header-actions">
          <Link href="/admin" className="btn btn--muted">
            ← Panel
          </Link>
          {pet && (
            <Link href={`/adopt/${pet.slug}`} className="btn btn--muted">
              Ver ficha pública ↗
            </Link>
          )}
        </div>
      </header>

      {error && (
        <p className="auth__error" role="alert">
          {error}
        </p>
      )}

      {/* ── where it is ──────────────────────────────────────────────────── */}
      <section className="admin-list">
        <h2 className="t-label">Dónde está</h2>
        {current ? (
          <p className="place-now">
            <strong>{current.areaName}</strong> desde el {formatDate(current.startedAt)}
            {currentArea && ` · ${t.areaKindLabel(currentArea.kind)}`}
          </p>
        ) : (
          <p className="admin__sub">
            Sin área asignada. Si el animalito está en el refugio, regístralo abajo — sin esto no
            hay forma de saber a quién estuvo expuesto si se enferma.
          </p>
        )}
      </section>

      {/* ── the move ─────────────────────────────────────────────────────── */}
      <section className="admin-list">
        <h2 className="t-label">Registrar movimiento</h2>

        {areas.length === 0 ? (
          <p className="admin__sub">
            Todavía no hay áreas.{' '}
            <Link href="/admin/areas" className="auth__link">
              Crea las del refugio
            </Link>{' '}
            para poder ubicar a los animalitos.
          </p>
        ) : (
          <form
            className="admin-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitMove();
            }}
          >
            <div className="admin-form__row">
              <label className="auth__field">
                <span>A qué área</span>
                <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
                  <option value="">Elige…</option>
                  {areas.map((area) => (
                    <option key={area.id} value={area.id} disabled={area.id === current?.areaId}>
                      {area.name} · {t.areaKindLabel(area.kind)}
                      {area.active ? '' : ' (fuera de servicio)'}
                      {area.id === current?.areaId ? ' — ya está aquí' : ''}
                    </option>
                  ))}
                </select>
              </label>

              <label className="auth__field">
                <span>Por qué</span>
                <select
                  value={reason}
                  onChange={(event) => setReason(event.target.value as PlacementReason)}
                >
                  {REASONS.map((value) => (
                    <option key={value} value={value}>
                      {t.placementReasonLabel(value)}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="auth__field">
              <span>Nota (opcional)</span>
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Lo revisó la doctora, sin síntomas"
                maxLength={200}
              />
            </label>

            {pet && (
              <StatusHint petStatus={pet.status} reason={reason} />
            )}

            {warnings.length > 0 && (
              <ul className="place-warnings" role="status">
                {warnings.map((warning) => (
                  <li key={warning}>{t.placementWarning(warning)}</li>
                ))}
              </ul>
            )}

            <div className="admin__footer">
              <div className="admin__footer-left">
                {current && (
                  <button
                    type="button"
                    className="btn btn--muted"
                    onClick={() => void submitRelease()}
                    disabled={saving}
                    title="Adoptado, a hogar de tránsito, o entregado a otro refugio"
                  >
                    Registrar salida
                  </button>
                )}
              </div>
              <div className="admin__footer-right">
                <button type="submit" className="btn btn--action" disabled={saving || !target}>
                  {saving ? 'Guardando…' : 'Registrar movimiento'}
                </button>
              </div>
            </div>
          </form>
        )}
      </section>

      {/* ── the history ──────────────────────────────────────────────────── */}
      <section className="admin-list">
        <h2 className="t-label">Historial de áreas</h2>
        {records?.length === 0 && (
          <p className="admin__sub">Todavía no hay movimientos registrados.</p>
        )}
        {records && records.length > 0 && (
          <ol className="timeline">
            {records.map((record) => (
              <li key={record.id} className="timeline__item">
                <div className="timeline__head">
                  <strong>{record.areaName}</strong>
                  <span className="t-data">{t.placementReasonLabel(record.reason)}</span>
                </div>
                <p className="t-data timeline__dates">
                  {formatDate(record.startedAt)} →{' '}
                  {record.endedAt === null ? 'sigue aquí' : formatDate(record.endedAt)}
                </p>
                {record.note && <p className="timeline__note">{record.note}</p>}
                {movers.get(record.movedBy) && (
                  <p className="t-data timeline__by">Registrado por {movers.get(record.movedBy)}</p>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* ── the trace ────────────────────────────────────────────────────── */}
      <section className="admin-list">
        <h2 className="t-label">Si se enfermó: rastrear contactos</h2>
        <p className="admin__sub">
          Busca a todos los animalitos que compartieron área con este dentro del período de
          incubación de la enfermedad. El moquillo puede incubar hasta{' '}
          {INCUBATION_MAX_DAYS.moquillo} días, así que la ventana es más larga de lo que parece.
        </p>

        <form
          className="admin-form"
          onSubmit={(event) => {
            event.preventDefault();
            void runTrace();
          }}
        >
          <div className="admin-form__row">
            <label className="auth__field">
              <span>Enfermedad</span>
              <select
                value={pathogen}
                onChange={(event) => setPathogen(event.target.value as Pathogen)}
              >
                {PATHOGENS.map((value) => (
                  <option key={value} value={value}>
                    {t.pathogenLabel(value)} · hasta {INCUBATION_MAX_DAYS[value]} días
                  </option>
                ))}
              </select>
            </label>

            <label className="auth__field">
              <span>Fecha del diagnóstico</span>
              <input
                type="date"
                value={diagnosedAt}
                max={todayInputValue()}
                onChange={(event) => setDiagnosedAt(event.target.value)}
              />
            </label>
          </div>

          <div className="admin__footer">
            <div className="admin__footer-left" />
            <div className="admin__footer-right">
              <button type="submit" className="btn btn--action" disabled={tracing}>
                {tracing ? 'Rastreando…' : 'Rastrear contactos'}
              </button>
            </div>
          </div>
        </form>

        {trace && <TraceResult trace={trace} pets={tracedNames} />}
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Says out loud what the move will do to the animal's status, before it is
 * made. Only two reasons change it, and both are consequential enough that
 * finding out afterwards is the wrong time.
 */
function StatusHint({ petStatus, reason }: { petStatus: Pet['status']; reason: PlacementReason }) {
  if (reason === 'intake' && petStatus === 'inbound') {
    return <p className="auth__hint">Al guardar, el animalito pasa a &ldquo;En cuarentena&rdquo;.</p>;
  }
  if (reason === 'quarantine-cleared' && petStatus === 'quarantine') {
    return (
      <p className="auth__hint">
        Al guardar, el animalito pasa a &ldquo;En el refugio&rdquo; y queda registrado quién dio el
        alta.
      </p>
    );
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ `noPlacementData` is rendered as its OWN message and never folded into
 * "no contacts."
 *
 * An empty list means either "this animal was genuinely alone" or "nobody ever
 * recorded where it was", and those are opposite facts that look identical.
 * Showing a reassuring "sin contactos" for the second one is the exact silent
 * failure this whole subsystem is arranged to prevent — the same shape as the
 * microchip lookup returning nothing because an index was missing.
 */
function TraceResult({ trace, pets }: { trace: OutbreakTrace; pets: Map<string, Pet> }) {
  if (trace.noPlacementData) {
    return (
      <div className="auth__notice auth__notice--warn" role="alert">
        <p>
          <strong>Este animalito no tiene ningún movimiento registrado</strong>, así que el rastreo
          no puede decir nada. Esto <em>no</em> significa que no haya tenido contacto con otros.
        </p>
        <p className="admin__sub">
          Registra dónde estuvo y vuelve a intentarlo. Si estuvo en el refugio sin ficha de área,
          hay que reconstruirlo preguntando al personal.
        </p>
      </div>
    );
  }

  if (trace.contacts.length === 0) {
    return (
      <div className="auth__notice">
        <p>
          Sin contactos en la ventana revisada. Sí hay movimientos registrados para este animalito,
          así que este resultado es una respuesta y no un vacío de datos.
        </p>
      </div>
    );
  }

  return (
    <div className="trace">
      <p className="admin__sub">
        {trace.contacts.length} coincidencia{trace.contacts.length === 1 ? '' : 's'} en{' '}
        {trace.areaIds.length} área{trace.areaIds.length === 1 ? '' : 's'}. Empiecen por los de
        arriba: son los que estuvieron más tiempo al lado.
      </p>
      <ol className="admin-list__items">
        {trace.contacts.map((contact, index) => (
          <li key={`${contact.petId}-${index}`} className="admin-list__item">
            <Link href={`/admin/pets/${contact.petId}`}>
              <strong>{pets.get(contact.petId)?.name || 'Sin nombre'}</strong>
              <span className="t-data">
                {contact.areaName} · {t.contactDurationLabel(contact.overlapMs)} ·{' '}
                {formatDate(contact.overlapStart)}
                {contact.overlapEnd === null ? ' → sigue' : ` → ${formatDate(contact.overlapEnd)}`}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}
