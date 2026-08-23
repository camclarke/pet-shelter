/**
 * The intake wizard — steps 1 to 3, manual entry.
 *
 * Build order step 5 in `docs/PLAN-intake-and-syndication.md`. This is the
 * change that removes the project's dependency on someone hand-writing a JSON
 * file: the shelter enters their own animals, and `scripts/seed-pet.mjs`
 * becomes the fallback rather than the only path.
 *
 * ── Three decisions worth not re-litigating ────────────────────────────────
 *
 * 1. **Steps 3 onward do not block publishing.** Plan section 3: a rescue
 *    arriving at 22:00 needs to be on the wall, not blocked on a temperament
 *    checklist. `publishBlockers()` covers identity and media only, and the
 *    test suite asserts that an empty story publishes. A gate that is stricter
 *    than the shelter's reality gets worked around, and the workaround is the
 *    WhatsApp group this system exists to replace.
 *
 * 2. **The draft id is minted before anything is typed** and becomes the
 *    petId. Photos therefore upload straight to `pets/{petId}/…` — their final
 *    path — so publishing moves no files and rewrites no URLs.
 *
 * 3. **Saving is explicit, not on every keystroke.** Firestore bills per
 *    write, and an autosave on a form this size is a write per character.
 *    Steps save when you move between them, and there is a Guardar button.
 *
 * ── What is deliberately NOT here ──────────────────────────────────────────
 * The re-admission / deduplication check (plan section 3.1) is build order
 * step 6, not 5. It needs an admin-scoped `findPetByMicrochip()` and it cannot
 * be meaningfully exercised against a collection holding zero pets. Wiring a
 * lookup that has never once resolved would be the "validated is not
 * verified" mistake this project keeps writing down.
 */

'use client';

/* eslint-disable @next/next/no-img-element -- Admin-only previews of images
   already sized and re-encoded by stripAndResize(). next/image would add a
   proxy round-trip per thumbnail on a screen nobody browses, and these are
   blob-backed previews whose dimensions vary per upload. */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

import { useAuth } from '@/components/AuthProvider';
import {
  draftDefaults,
  publishBlockers,
  slugify,
  validateStep,
  type IntakeError,
  type IntakeStep,
  type PetDraft,
} from '@/lib/intake';
import {
  deletePhotos,
  discardDraft,
  mintPetId,
  PhotoUnreadableError,
  publishDraft,
  saveDraft,
  loadDraft,
  uploadPetPhoto,
} from '@/lib/pets-admin';
import { validateMicrochip, type MicrochipError } from '@/lib/microchip';
import type { PetSex, PetSize, PetStatus, Species } from '@/lib/types';
import { t } from '@/i18n';

const STEPS: { key: IntakeStep; label: string }[] = [
  { key: 'identity', label: 'Identidad' },
  { key: 'media', label: 'Fotos' },
  { key: 'story', label: 'Historia' },
];

const SPECIES_OPTIONS: { value: Species; label: string }[] = [
  { value: 'dog', label: 'Perro' },
  { value: 'cat', label: 'Gato' },
  { value: 'rabbit', label: 'Conejo' },
  { value: 'other', label: 'Otro' },
];

const SIZE_OPTIONS: { value: PetSize; label: string }[] = [
  { value: 'small', label: 'Pequeño' },
  { value: 'medium', label: 'Mediano' },
  { value: 'large', label: 'Grande' },
];

const SEX_OPTIONS: { value: PetSex; label: string }[] = [
  { value: 'female', label: 'Hembra' },
  { value: 'male', label: 'Macho' },
];

/**
 * Only the states an animal can be in at intake.
 *
 * `adopted` and `lost` are absent on purpose — they are transitions that
 * happen later and to an animal that already exists, and offering them here
 * invites someone to create a record for a dog that was adopted last year.
 */
const STATUS_OPTIONS: PetStatus[] = ['shelter', 'quarantine', 'foster', 'inbound', 'available'];

/** Spanish for the three-way "we don't know yet" answers. */
const TRISTATE: { value: string; label: string }[] = [
  { value: 'unknown', label: 'No sabemos' },
  { value: 'yes', label: 'Sí' },
  { value: 'no', label: 'No' },
];

function toTristate(value: boolean | null): string {
  if (value === null) return 'unknown';
  return value ? 'yes' : 'no';
}

function fromTristate(value: string): boolean | null {
  if (value === 'yes') return true;
  if (value === 'no') return false;
  return null;
}

/** "tranquila, juguetona" -> ['tranquila', 'juguetona'] */
function toList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function IntakeWizard() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const resumeId = params.get('draft');

  const [draft, setDraft] = useState<PetDraft | null>(null);
  const [step, setStep] = useState<IntakeStep>('identity');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<{
    slug: string;
    /** What the admin typed, so a disambiguated slug can be pointed out. */
    requestedSlug: string;
    name: string;
  } | null>(null);
  /** True once the admin edits the slug by hand, so we stop deriving it. */
  const [slugTouched, setSlugTouched] = useState(false);

  // ── load or create ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (resumeId) {
        const existing = await loadDraft(resumeId);
        if (cancelled) return;
        if (existing) {
          setDraft(existing);
          setSlugTouched(true); // a saved draft's slug is already decided
          return;
        }
        // The draft is gone — discarded, or already published from another
        // tab. Say so and start a fresh one, and drop the stale `?draft=`
        // from the URL: leaving it there means every reload mints yet another
        // id against a record that no longer exists.
        setNotice('Esa ficha ya no existe. Empezamos una nueva.');
        router.replace('/admin/intake');
      }
      if (!cancelled) setDraft(draftDefaults(mintPetId()));
    })().catch((caught) => {
      console.error('[intake] could not open draft', caught);
      if (!cancelled) setError('No pudimos abrir la ficha. Revisa tu conexión e intenta de nuevo.');
    });
    return () => {
      cancelled = true;
    };
  }, [resumeId, router]);

  const update = useCallback((patch: Partial<PetDraft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setNotice(null);
  }, []);

  if (!draft) {
    return (
      <div className="admin-gate" aria-busy="true">
        <p className="admin-gate__note">{error ?? 'Abriendo la ficha…'}</p>
      </div>
    );
  }

  const stepErrors = validateStep(step, draft);
  const blockers = publishBlockers(draft);

  /** Live microchip feedback, from the validator that already has 10 tests. */
  let chipError: MicrochipError | null = null;
  if (draft.hasMicrochip && draft.microchipCode.trim().length > 0) {
    const result = validateMicrochip(draft.microchipCode, draft.microchipStandard);
    if (!result.valid && result.error) chipError = result.error;
  }

  async function persist(next: PetDraft = draft!) {
    setBusy(true);
    setError(null);
    try {
      await saveDraft(next);
      setNotice('Ficha guardada.');
    } catch (caught) {
      report(caught);
    } finally {
      setBusy(false);
    }
  }

  function report(caught: unknown) {
    console.error('[intake]', caught);

    // A format the browser cannot decode is not a save failure, and saying
    // "revisa tu conexión" would send someone to the wrong problem entirely.
    if (caught instanceof PhotoUnreadableError) {
      setError(
        'No pudimos leer esa imagen. Si viene de un iPhone puede estar en formato HEIC: ábrela y guárdala como JPG, o envíala por WhatsApp y súbela desde ahí.',
      );
      return;
    }

    const code = (caught as { code?: string })?.code;
    if (code === 'permission-denied') {
      // The single most likely failure, and it is almost never a bug: the ID
      // token predates the claim grant. Say the fix, not the error code.
      setError(
        'Firestore rechazó la escritura por permisos. Si te acaban de dar acceso, cierra sesión y vuelve a entrar.',
      );
      return;
    }
    setError('No pudimos guardar. Revisa tu conexión e intenta de nuevo.');
  }

  async function goToStep(next: IntakeStep) {
    await persist();
    setStep(next);
  }

  async function handleFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    // Clear it so re-picking the same file fires change again.
    event.target.value = '';

    setBusy(true);
    setError(null);
    try {
      const uploaded = [];
      for (const file of files) {
        uploaded.push(await uploadPetPhoto(draft!.id, file));
      }
      const next = { ...draft!, media: [...draft!.media, ...uploaded] };
      setDraft(next);
      await saveDraft(next);
      setNotice(
        uploaded.length === 1 ? 'Foto subida.' : `${uploaded.length} fotos subidas.`,
      );
    } catch (caught) {
      report(caught);
    } finally {
      setBusy(false);
    }
  }

  function setAlt(id: string, alt: string) {
    update({ media: draft!.media.map((m) => (m.id === id ? { ...m, alt } : m)) });
  }

  function removePhoto(id: string) {
    const removed = draft!.media.find((m) => m.id === id);
    update({ media: draft!.media.filter((m) => m.id !== id) });
    // Delete the Storage object too. Nothing else can reference it — the
    // draft owns its whole `pets/{draftId}/` prefix — and there is no sweep
    // job, so this is the only moment we still know the path. Best-effort and
    // deliberately not awaited: a failed delete must not block the edit.
    if (removed) void deletePhotos([removed.path]);
  }

  function makeCover(id: string) {
    const chosen = draft!.media.find((m) => m.id === id);
    if (!chosen) return;
    update({ media: [chosen, ...draft!.media.filter((m) => m.id !== id)] });
  }

  async function handlePublish() {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      const result = await publishDraft(draft!, user);
      setPublished({
        slug: result.slug,
        requestedSlug: draft!.slug,
        name: draft!.name.trim(),
      });
    } catch (caught) {
      report(caught);
    } finally {
      setBusy(false);
    }
  }

  async function handleDiscard() {
    if (!window.confirm('¿Descartar esta ficha? No se puede deshacer.')) return;
    setBusy(true);
    try {
      // Photos first: once the draft document is gone there is nothing left
      // that knows these paths, and no sweep job exists to find them.
      await deletePhotos(draft!.media.map((m) => m.path));
      await discardDraft(draft!.id);
      router.push('/admin');
    } catch (caught) {
      report(caught);
      setBusy(false);
    }
  }

  /**
   * Reset for the next animal.
   *
   * ⚠️ This must NOT be a `<Link href="/admin/intake">`. It was, and it was a
   * dead button: the success screen already lives at that route, so Next
   * matched the same segment, kept this component mounted, and `published`
   * stayed set — the shelter could never register a second animal without
   * manually navigating away. Verified in a browser, not reasoned about.
   */
  function startAnother() {
    setPublished(null);
    setStep('identity');
    setNotice(null);
    setError(null);
    setSlugTouched(false);
    setDraft(draftDefaults(mintPetId()));
    // Only when a stale `?draft=` is still in the URL; otherwise the effect
    // does not re-run and would leave the resumed id in the address bar.
    if (resumeId) router.replace('/admin/intake');
  }

  // ── published ─────────────────────────────────────────────────────────────
  if (published) {
    return (
      <div className="admin-done">
        <h1 className="t-title">Publicado</h1>
        <p className="admin-done__note">
          <strong>{published.name}</strong> ya tiene ficha, en esta dirección:
          <br />
          <code className="admin-done__url">wawitas.org/adopt/{published.slug}</code>
        </p>

        {/* The slug can differ from what was typed: a second Luna publishes as
            luna-2. Saying so is the whole reason `slug-taken` is not an error —
            the admin is told what happened instead of being blocked on it. */}
        {published.slug !== published.requestedSlug && (
          <p className="auth__notice" role="status">
            Ya había un animalito en <code>{published.requestedSlug}</code>, así que esta ficha
            quedó en <code>{published.slug}</code>.
          </p>
        )}

        <p className="admin-gate__note">
          Si lo publicaste como <em>Disponible</em>, aparecerá en el muro en unos minutos: la
          página de inicio se regenera cada 5 minutos.
        </p>
        <div className="admin-done__actions">
          <Link href={`/adopt/${published.slug}`} className="btn btn--action">
            Ver la ficha
          </Link>
          <button type="button" className="btn btn--brand" onClick={startAnother}>
            Registrar otro
          </button>
          <Link href="/admin" className="btn btn--muted">
            Volver al panel
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="admin">
      <header className="admin__header">
        <div>
          <h1 className="t-title">Nuevo ingreso</h1>
          <p className="admin__sub">
            Con la identidad y una foto ya se puede publicar. La historia puede esperar.
          </p>
        </div>
        <Link href="/admin" className="btn btn--muted">
          ← Panel
        </Link>
      </header>

      <nav className="admin-steps" aria-label="Pasos">
        {STEPS.map((entry, index) => {
          const done = validateStep(entry.key, draft).length === 0;
          return (
            <button
              key={entry.key}
              type="button"
              className={`admin-steps__item${step === entry.key ? ' is-current' : ''}${
                done ? ' is-done' : ''
              }`}
              onClick={() => void goToStep(entry.key)}
              disabled={busy}
            >
              <span className="admin-steps__n">{index + 1}</span>
              {entry.label}
            </button>
          );
        })}
      </nav>

      {error && (
        <p className="auth__error" role="alert">
          {error}
        </p>
      )}
      {notice && !error && (
        <p className="auth__notice" role="status">
          {notice}
        </p>
      )}

      {/* ── step 1: identity ───────────────────────────────────────────────── */}
      {step === 'identity' && (
        <section className="admin-form">
          <label className="auth__field">
            <span className="t-label">Nombre</span>
            <input
              type="text"
              value={draft.name}
              disabled={busy}
              onChange={(e) => {
                const name = e.target.value;
                // The slug follows the name until someone edits it by hand.
                // After that it is theirs — silently overwriting a chosen URL
                // would change a link they may already have shared.
                update(slugTouched ? { name } : { name, slug: slugify(name) });
              }}
            />
          </label>

          <div className="admin-form__row">
            <label className="auth__field">
              <span className="t-label">Especie</span>
              <select
                value={draft.species ?? ''}
                disabled={busy}
                onChange={(e) => update({ species: (e.target.value || null) as Species | null })}
              >
                <option value="">Elegir…</option>
                {SPECIES_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="auth__field">
              <span className="t-label">Sexo</span>
              <select
                value={draft.sex ?? ''}
                disabled={busy}
                onChange={(e) => update({ sex: (e.target.value || null) as PetSex | null })}
              >
                <option value="">Elegir…</option>
                {SEX_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <small className="auth__hint">
                Define cómo se escribe todo lo demás: «la gata pequeña» o «el gato pequeño».
              </small>
            </label>

            <label className="auth__field">
              <span className="t-label">Tamaño</span>
              <select
                value={draft.size ?? ''}
                disabled={busy}
                onChange={(e) => update({ size: (e.target.value || null) as PetSize | null })}
              >
                <option value="">Elegir…</option>
                {SIZE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="auth__field">
            <span className="t-label">Raza</span>
            <input
              type="text"
              value={draft.breed}
              placeholder="mestiza"
              disabled={busy}
              onChange={(e) => update({ breed: e.target.value })}
            />
          </label>

          <fieldset className="admin-form__fieldset">
            <legend className="t-label">Edad aproximada</legend>
            <div className="admin-form__row">
              <label className="auth__field">
                <span className="t-label">Años</span>
                <input
                  type="number"
                  min={0}
                  max={40}
                  value={draft.ageYears ?? ''}
                  disabled={busy || draft.ageUnknown}
                  onChange={(e) =>
                    update({ ageYears: e.target.value === '' ? null : Number(e.target.value) })
                  }
                />
              </label>
              <label className="auth__field">
                <span className="t-label">Meses</span>
                <input
                  type="number"
                  min={0}
                  max={11}
                  value={draft.ageMonthsPart ?? ''}
                  disabled={busy || draft.ageUnknown}
                  onChange={(e) =>
                    update({ ageMonthsPart: e.target.value === '' ? null : Number(e.target.value) })
                  }
                />
              </label>
            </div>
            <label className="admin-form__check">
              <input
                type="checkbox"
                checked={draft.ageUnknown}
                disabled={busy}
                onChange={(e) =>
                  update({
                    ageUnknown: e.target.checked,
                    ...(e.target.checked ? { ageYears: null, ageMonthsPart: null } : {}),
                  })
                }
              />
              No sabemos la edad
            </label>
          </fieldset>

          <label className="auth__field">
            <span className="t-label">Estado</span>
            <select
              value={draft.status}
              disabled={busy}
              onChange={(e) => update({ status: e.target.value as PetStatus })}
            >
              {STATUS_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {t.statusLabel(value)}
                </option>
              ))}
            </select>
            <small className="auth__hint">
              Solo <strong>Disponible</strong> aparece en el muro público.
            </small>
          </label>

          <label className="auth__field">
            <span className="t-label">Dirección web</span>
            <input
              type="text"
              value={draft.slug}
              disabled={busy}
              onChange={(e) => {
                setSlugTouched(true);
                update({ slug: e.target.value });
              }}
            />
            <small className="auth__hint">wawitas.org/adopt/{draft.slug || '…'}</small>
          </label>

          <fieldset className="admin-form__fieldset">
            <legend className="t-label">Microchip</legend>
            <label className="admin-form__check">
              <input
                type="checkbox"
                checked={draft.hasMicrochip}
                disabled={busy}
                onChange={(e) => update({ hasMicrochip: e.target.checked })}
              />
              Tiene microchip
            </label>

            {draft.hasMicrochip && (
              <>
                <div className="admin-form__row">
                  <label className="auth__field">
                    <span className="t-label">Número</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={draft.microchipCode}
                      placeholder="068123456789012"
                      disabled={busy}
                      onChange={(e) => update({ microchipCode: e.target.value })}
                    />
                  </label>
                  <label className="auth__field">
                    <span className="t-label">Estándar</span>
                    <select
                      value={draft.microchipStandard}
                      disabled={busy}
                      onChange={(e) =>
                        update({
                          microchipStandard: e.target
                            .value as PetDraft['microchipStandard'],
                        })
                      }
                    >
                      <option value="iso-fdx-b">ISO FDX-B (15 dígitos)</option>
                      <option value="iso-hdx">ISO HDX (15 dígitos)</option>
                      <option value="non-iso-125">No-ISO 125 kHz</option>
                      <option value="non-iso-128">No-ISO 128 kHz</option>
                    </select>
                  </label>
                </div>
                {chipError && (
                  <p className="auth__error" role="alert">
                    {t.microchipError(chipError)}
                  </p>
                )}
                <small className="auth__hint">
                  El número no se publica nunca. Se guarda aparte, y solo lo ven el refugio y
                  quien adopte al animalito.
                </small>
              </>
            )}
          </fieldset>
        </section>
      )}

      {/* ── step 2: media ──────────────────────────────────────────────────── */}
      {step === 'media' && (
        <section className="admin-form">
          <p className="admin__sub">
            La primera foto es la portada: es la que se ve en el muro. Arrastra o elige varias.
          </p>

          <label className="auth__field">
            <span className="t-label">Agregar fotos</span>
            <input
              type="file"
              accept="image/*"
              multiple
              disabled={busy}
              onChange={(e) => void handleFiles(e)}
            />
            <small className="auth__hint">
              Al subirlas les quitamos los datos ocultos de la cámara, incluida la ubicación GPS.
              Una foto tomada en una casa de tránsito no debe publicar esa dirección.
            </small>
          </label>

          {draft.media.length > 0 && (
            <ul className="admin-photos">
              {draft.media.map((media, index) => (
                <li key={media.id} className="admin-photo">
                  <img src={media.url} alt={media.alt || 'Foto sin descripción'} />
                  <div className="admin-photo__body">
                    {index === 0 ? (
                      <span className="admin-photo__badge">Portada</span>
                    ) : (
                      <button
                        type="button"
                        className="auth__link"
                        onClick={() => makeCover(media.id)}
                        disabled={busy}
                      >
                        Hacer portada
                      </button>
                    )}
                    <label className="auth__field">
                      <span className="t-label">Descripción</span>
                      <input
                        type="text"
                        value={media.alt}
                        placeholder="Perra mestiza café echada en el patio"
                        disabled={busy}
                        onChange={(e) => setAlt(media.id, e.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className="auth__link"
                      onClick={() => removePhoto(media.id)}
                      disabled={busy}
                    >
                      Quitar
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* ── step 3: story ──────────────────────────────────────────────────── */}
      {step === 'story' && (
        <section className="admin-form">
          <p className="admin__sub">
            Todo esto es opcional: se puede publicar sin llenarlo y completarlo después. Solo lo
            ve quien tiene cuenta.
          </p>

          <label className="auth__field">
            <span className="t-label">Historia</span>
            <textarea
              rows={5}
              value={draft.story}
              disabled={busy}
              onChange={(e) => update({ story: e.target.value })}
            />
          </label>

          <label className="auth__field">
            <span className="t-label">Carácter</span>
            <input
              type="text"
              value={draft.temperament.join(', ')}
              placeholder="tranquila, juguetona, buena con niños"
              disabled={busy}
              onChange={(e) => update({ temperament: toList(e.target.value) })}
            />
            <small className="auth__hint">Separa con comas.</small>
          </label>

          <label className="auth__field">
            <span className="t-label">Notas de salud</span>
            <textarea
              rows={3}
              value={draft.healthNotes}
              disabled={busy}
              onChange={(e) => update({ healthNotes: e.target.value })}
            />
          </label>

          <label className="auth__field">
            <span className="t-label">Compromisos del refugio</span>
            <input
              type="text"
              value={draft.commitments.join(', ')}
              placeholder="castración gratuita a los 6 meses"
              disabled={busy}
              onChange={(e) => update({ commitments: toList(e.target.value) })}
            />
          </label>

          <label className="admin-form__check">
            <input
              type="checkbox"
              checked={draft.sterilized}
              disabled={busy}
              onChange={(e) => update({ sterilized: e.target.checked })}
            />
            Ya está esterilizado o esterilizada
          </label>

          <div className="admin-form__row">
            <label className="auth__field">
              <span className="t-label">¿Se lleva bien con niños?</span>
              <select
                value={toTristate(draft.goodWithChildren)}
                disabled={busy}
                onChange={(e) => update({ goodWithChildren: fromTristate(e.target.value) })}
              >
                {TRISTATE.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="auth__field">
              <span className="t-label">¿Con otros animales?</span>
              <select
                value={toTristate(draft.goodWithOtherPets)}
                disabled={busy}
                onChange={(e) => update({ goodWithOtherPets: fromTristate(e.target.value) })}
              >
                {TRISTATE.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>
      )}

      {stepErrors.length > 0 && (
        <ul className="admin-errors" role="status">
          {stepErrors.map((code: IntakeError) => (
            <li key={code}>{t.intakeError(code)}</li>
          ))}
        </ul>
      )}

      <footer className="admin__footer">
        <div className="admin__footer-left">
          <button
            type="button"
            className="btn btn--muted"
            onClick={() => void persist()}
            disabled={busy}
          >
            {busy ? 'Un momento…' : 'Guardar'}
          </button>
          <button type="button" className="auth__link" onClick={() => void handleDiscard()} disabled={busy}>
            Descartar
          </button>
        </div>

        <div className="admin__footer-right">
          {blockers.length > 0 && (
            <span className="admin__blocked">
              Falta{blockers.length === 1 ? '' : 'n'} {blockers.length} dato
              {blockers.length === 1 ? '' : 's'} para publicar
            </span>
          )}
          <button
            type="button"
            className="btn btn--action"
            onClick={() => void handlePublish()}
            disabled={busy || blockers.length > 0 || !user}
          >
            Publicar
          </button>
        </div>
      </footer>
    </div>
  );
}
