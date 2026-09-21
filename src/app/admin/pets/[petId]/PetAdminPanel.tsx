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
import { formatDate, parseDateInput, todayInputValue } from '@/lib/date-input';
import MedicalPanel from './MedicalPanel';
import MeasurementPanel from './MeasurementPanel';
import { QrTagPanel } from './QrTagPanel';
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
import { loadDraft } from '@/lib/pets-admin';
import { INCUBATION_MAX_DAYS, type Pathogen, type PlacementInterval } from '@/lib/placements';
import { t } from '@/i18n';
import type { PetDraft } from '@/lib/intake';
import type { Area, Pet, PlacementReason } from '@/lib/types';

const REASONS: PlacementReason[] = [
  'intake',
  'quarantine-cleared',
  'transfer',
  'medical',
  'outbreak',
];

const PATHOGENS: Pathogen[] = ['moquillo', 'parvovirus'];

// Date helpers live in `@/lib/date-input`, shared with the medical form.
// They carry a timezone trap worth reading before touching either caller.

export function PetAdminPanel({ petId }: { petId: string }) {
  const { user } = useAuth();

  const [pet, setPet] = useState<Pet | null | 'missing'>(null);
  /**
   * Only read when `pets/{id}` turns out not to exist. A register-imported
   * animal is a draft with a medical history and no published document yet —
   * see `PendingDraftPanel`.
   */
  const [draft, setDraft] = useState<PetDraft | null>(null);
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

      // Read BEFORE committing to 'missing', not after: setting the state
      // first and then fetching would flash "esa ficha ya no existe" for an
      // animal whose record is one collection away, and that sentence is
      // exactly the thing a person acts on.
      if (!found) setDraft(await loadDraft(petId));

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
    // A draft at this id is not a missing record, it is an unfinished one.
    if (draft) return <PendingDraftPanel petId={petId} draft={draft} />;

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

      {/* ── medical history: build-order step 7 ───────────────────────────── */}
      <MedicalPanel
        petId={petId}
        birthdateApprox={pet?.birthdateApprox ? pet.birthdateApprox.toMillis() : null}
      />

      {/* ── weight and body condition: build-order step 10 ────────────────
          The estimate is passed only when the pet document says it IS one,
          so the panel can label it as unfit for a dose. */}
      <MeasurementPanel
        petId={petId}
        species={pet?.species ?? null}
        estimatedKgMin={pet?.weightIsEstimate ? (pet.weightKgMin ?? null) : null}
        estimatedKgMax={pet?.weightIsEstimate ? (pet.weightKgMax ?? null) : null}
        // `?? null`: a pet published before this field existed has it
        // undefined at runtime, whatever the `as Pet` cast claims.
        adultBand={pet?.expectedAdultWeightBand ?? null}
      />

      {/* ── the collar tag: build-order step 12 ─────────────────────────── */}
      <QrTagPanel petId={petId} petName={pet?.name || 'Sin nombre'} />

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
 * An animal that exists as a draft and not yet as a published pet.
 *
 * ── Why this screen exists ────────────────────────────────────────────────
 * The paper register is imported before anybody photographs anything: it
 * creates `petDrafts/{id}` and writes the vaccinations and treatments it read
 * off paper under `pets/{id}/medical` — the same id the wizard will publish
 * under, so nothing has to move later. Until the photo session happens there
 * is no `pets/{id}` document at all, and this page answered "esa ficha ya no
 * existe" for every resident whose history was sitting one collection away.
 * That is the worst kind of wrong answer: confident, and about data we have.
 *
 * ── What is deliberately absent ───────────────────────────────────────────
 * The areas board, the QR tag and the outbreak trace all need a PUBLISHED
 * pet. A placement snapshots the animal, a tag resolves to the public tier,
 * and the trace answers a question about a record the wall knows. Showing
 * them here would either fail or — worse — quietly write a placement against
 * an id no public document has claimed yet, which is an outbreak ledger
 * pointing at nothing.
 *
 * Medical and weight are a different case, and that is why they stay: both
 * are per-id subcollections whose rules gate on the admin claim rather than
 * on the parent existing, and the medical one is precisely what the import
 * brought. A vet visit does not wait for a photo session.
 */
function PendingDraftPanel({ petId, draft }: { petId: string; draft: PetDraft }) {
  // `petId` rather than `draft.id` for every path and link. They are the same
  // by construction, but one is the key the document was read under and the
  // other is a cast from a stored field — and these paths decide which
  // animal's medical history is on screen.
  const register = draft.register ?? null;
  const needsPhotos = (draft.media ?? []).length === 0;
  const imported = register?.medicalCount ?? 0;

  return (
    <div className="admin">
      <header className="admin__header">
        <div>
          {/* The register's own spelling is the fallback, not "Sin nombre":
              on an imported row it is the only name anybody wrote down. */}
          <h1 className="t-title">
            {draft.name?.trim() || register?.nameRaw?.trim() || 'Sin nombre'}
          </h1>
          <p className="admin__sub">
            {register && `Del registro n.º ${register.no} · `}
            {needsPhotos ? 'Falta fotografiar' : 'Falta publicar'}
          </p>
        </div>
        <div className="admin__header-actions">
          <Link href="/admin" className="btn btn--muted">
            ← Panel
          </Link>
        </div>
      </header>

      <div className="auth__notice">
        <p>
          {register
            ? 'Esta ficha salió del registro en papel y todavía no está publicada.'
            : 'Esta ficha está a medio llenar y todavía no está publicada.'}{' '}
          Aquí puedes ver y corregir lo médico y el peso. Las áreas, el código QR y el rastreo de
          contactos necesitan la ficha publicada.
        </p>
        {imported > 0 && (
          <p className="admin__sub">
            El registro trajo {imported} dato{imported === 1 ? '' : 's'} médico
            {imported === 1 ? '' : 's'}. Revísalos contra la tarjeta o el carnet antes de darlos
            por buenos: salieron de una hoja escrita a mano.
          </p>
        )}
      </div>

      <section className="admin-list">
        <h2 className="t-label">Para que aparezca en el muro</h2>
        <p className="admin__sub">
          Faltan las fotos y los datos que la ficha pública necesita. El asistente sigue desde
          donde está y publica con este mismo id, así que lo médico que ya está aquí se queda con
          el animalito.
        </p>
        <div className="admin__footer">
          <div className="admin__footer-left" />
          <div className="admin__footer-right">
            <Link href={`/admin/intake?draft=${petId}`} className="btn btn--action">
              Tomar fotos y completar
            </Link>
          </div>
        </div>
      </section>

      {/* ── the history the register brought: build-order step 7 ─────────── */}
      <MedicalPanel petId={petId} />

      {/* ── weight and body condition: build-order step 10 ─────────────────
          `species` can still be null on a half-filled draft, and the panel is
          built for that — it drops the per-species weight ceiling warning and
          keeps every other check. Hiding the panel instead would refuse to
          record a weight the vet just took because nobody has typed "perro"
          yet, and the reading is real either way.

          The draft's range only ever holds a photograph's estimate, which is
          exactly what `weightIsEstimate` gates on the published document. */}
      <MeasurementPanel
        petId={petId}
        species={draft.species ?? null}
        estimatedKgMin={draft.weightKgMin ?? null}
        estimatedKgMax={draft.weightKgMax ?? null}
        adultBand={draft.expectedAdultWeightBand ?? null}
      />
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
