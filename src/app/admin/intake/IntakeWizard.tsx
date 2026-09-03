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
 * 4. **A chip is looked up before it is stored.** Plan section 3.1, build order
 *    step 6. Entering a valid code runs `findPetByMicrochipAdmin()` and the
 *    wizard branches: an unknown chip continues as a new intake, a known one
 *    offers to reopen the existing record instead of creating a second one.
 *    The lookup is automatic rather than a button, because a dedup check that
 *    has to be remembered is a dedup check that does not happen — and the cost
 *    is one Firestore read per completed code, not one per keystroke.
 *
 * ── What is deliberately NOT here ──────────────────────────────────────────
 * Nothing resolves a chip for an animal that has none, and most street rescues
 * arrive unchipped. This protects the minority case only. A name-and-photo
 * similarity prompt would cover the rest; it is not in the plan and pretending
 * this deduplicates every intake would oversell it.
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
  findPetByMicrochipAdmin,
  mintPetId,
  PhotoUnreadableError,
  publishDraft,
  reopenPet,
  saveDraft,
  loadDraft,
  stripAndResize,
  uploadPetPhoto,
  uploadProcessedPhoto,
} from '@/lib/pets-admin';
import { shouldHaveOpenPlacement } from '@/lib/arrival';
import {
  READMISSION_STATUSES,
  type ChipMatch,
  type ChipVerdict,
  type ReadmissionInput,
} from '@/lib/readmission';
import { formatMicrochipCode, validateMicrochip, type MicrochipError } from '@/lib/microchip';
import type { PetPhotoSlot, PetSex, PetSize, PetStatus, Species } from '@/lib/types';
import { requestSuggestion, type SuggestOutcome } from '@/lib/intake-suggest-client';
import PhotoSuggestions, {
  SEX_WITHHELD_REASON,
  WITHHELD_REASON,
} from './PhotoSuggestions';
import EditableField from './EditableField';
import GuidedPhotoCapture from './GuidedPhotoCapture';
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

/**
 * The label a select would show for a stored value, so a collapsed row and its
 * open editor never disagree about the same value's name.
 */
function optionLabel<T extends string>(
  options: readonly { value: T; label: string }[],
  value: T | null,
): string | null {
  if (value === null) return null;
  return options.find((o) => o.value === value)?.label ?? null;
}

/**
 * Age as a person would say it.
 *
 * "Sin definir" and "no lo sabemos" are different facts and must not collapse
 * into one another: the first is work still to do, the second is a decision
 * already taken about a street rescue with no history. Zero years and zero
 * months is a real answer for a neonate, so it cannot fall through to null.
 */
function describeAge(
  years: number | null,
  months: number | null,
  unknown: boolean,
): string | null {
  if (unknown) return 'No sabemos la edad';
  if (years === null && months === null) return null;
  const parts: string[] = [];
  if (years) parts.push(`${years} ${years === 1 ? 'año' : 'años'}`);
  if (months) parts.push(`${months} ${months === 1 ? 'mes' : 'meses'}`);
  return parts.length > 0 ? parts.join(' y ') : 'Menos de un mes';
}

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
    /**
     * The internal id, which is also the draft id. Needed because the next
     * thing the shelter should do — say which pen the animal is in — happens
     * at `/admin/pets/{petId}`, a different namespace from the public slug.
     */
    petId: string;
    slug: string;
    /** What the admin typed, so a disambiguated slug can be pointed out. */
    requestedSlug: string;
    name: string;
    /** Drives whether an area even applies: a fostered animal has no pen. */
    status: PetStatus;
  } | null>(null);
  /** True once the admin edits the slug by hand, so we stop deriving it. */
  const [slugTouched, setSlugTouched] = useState(false);

  /**
   * Which field is open for editing, or null.
   *
   * One at a time, deliberately. Intake runs on a phone: several open editors
   * push the rest of the animal off-screen, and the summary of what is known
   * so far is the thing an admin needs before publishing.
   */
  const [openField, setOpenField] = useState<string | null>(null);

  /**
   * The photo accelerator. `suggesting` is separate from `busy` on purpose:
   * `busy` disables the whole form, and a model call that takes 20 seconds
   * must not lock an admin out of typing the name they already know.
   */
  const [suggestOutcome, setSuggestOutcome] = useState<SuggestOutcome | null>(null);
  /** Processed blobs by slot, so analysis need not re-download them. */
  const [photoBlobs, setPhotoBlobs] = useState<Map<PetPhotoSlot, Blob>>(new Map());
  const [suggesting, setSuggesting] = useState(false);

  /**
   * The chip lookup — plan section 3.1.
   *
   * `failed` is a state of its own rather than being folded into
   * `unregistered`, and the distinction is the important part: "we looked and
   * nothing has this chip" and "we could not look" must never render the same,
   * because the first is permission to create a new record and the second is
   * not.
   */
  const [lookup, setLookup] = useState<
    | { state: 'idle' }
    | { state: 'searching'; code: string }
    | { state: 'done'; code: string; verdict: ChipVerdict }
    | { state: 'failed'; code: string }
  >({ state: 'idle' });

  /** Set when the admin chose to reopen an existing record instead. */
  const [readmit, setReadmit] = useState<ChipMatch | null>(null);
  const [readmitInput, setReadmitInput] = useState<ReadmissionInput>({
    name: '',
    // Never `available`. An animal coming back goes to the shelter; putting it
    // on the public wall stays a separate, deliberate act.
    status: 'shelter',
    note: '',
  });
  const [readmitted, setReadmitted] = useState<{
    petId: string;
    slug: string;
    name: string;
    renamed: boolean;
    previousName: string;
    status: PetStatus;
  } | null>(null);

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

  /**
   * The normalised code worth looking up, or null.
   *
   * Derived above the early return below so the hook order never changes, and
   * keyed on the NORMALISED code so that retyping "068 123…" as "068123…" is
   * not a new query — `validateMicrochip` strips separators, so both collapse
   * to the same string and the effect does not re-run.
   */
  const chipLookupCode = (() => {
    if (!draft?.hasMicrochip) return null;
    const result = validateMicrochip(draft.microchipCode, draft.microchipStandard);
    return result.valid && result.parsed ? result.parsed.code : null;
  })();

  useEffect(() => {
    if (!chipLookupCode) {
      setLookup({ state: 'idle' });
      return;
    }

    let cancelled = false;
    setLookup({ state: 'searching', code: chipLookupCode });

    findPetByMicrochipAdmin(chipLookupCode)
      .then((verdict) => {
        if (!cancelled) setLookup({ state: 'done', code: chipLookupCode, verdict });
      })
      .catch((caught) => {
        // Deliberately does NOT block the intake. A rescue arriving at 22:00
        // must not be stopped by a transient read failure — plan section 3 is
        // explicit that a gate stricter than the shelter's reality gets worked
        // around, and the workaround is the WhatsApp group this replaces. The
        // warning is loud instead.
        console.error('[intake] chip lookup failed', caught);
        if (!cancelled) setLookup({ state: 'failed', code: chipLookupCode });
      });

    return () => {
      cancelled = true;
    };
  }, [chipLookupCode]);

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

  // Narrowed once, here, rather than inside the JSX. TypeScript does not carry
  // a discriminant narrowing into a callback closure, so reading
  // `lookup.verdict.pet` inside an onClick would need a cast — and a cast is
  // exactly the thing that keeps compiling after the union changes shape.
  const chipMatch =
    lookup.state === 'done' && lookup.verdict.kind === 'registered' ? lookup.verdict.pet : null;
  const chipAmbiguous =
    lookup.state === 'done' && lookup.verdict.kind === 'ambiguous' ? lookup.verdict.pets : null;
  const chipUnregistered = lookup.state === 'done' && lookup.verdict.kind === 'unregistered';

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

  /**
   * Take one photo, keep it, and ask what can be seen in it.
   *
   * ⚠️ The UPLOAD happens first and the model call second, and the order is
   * load-bearing. The photograph is the durable thing — an animal in front
   * of someone right now — and a model timeout must never lose it. If the
   * suggestion fails the photo is already saved and already the cover.
   */
  /**
   * Capture only. Uploads and saves, and deliberately does NOT call the model.
   *
   * ⚠️ This used to analyse on every pick. With four guided slots that would
   * spend four requests per animal, and the Flash tier gets 20 a day free —
   * taking the shelter from 20 animals a day to five. Analysis is one explicit
   * call over the whole set; see handleAnalyzePhotos.
   */
  async function handlePickPhoto(slot: PetPhotoSlot, file: File) {
    if (!user || !draft) return;
    setBusy(true);
    setError(null);
    try {
      // Strip EXIF ONCE, then use the same bytes for both the upload and
      // the model call. Sending the original to Gemini while storing the
      // stripped copy would ship a foster volunteer’s home GPS to a third
      // party — the exact harm stripAndResize exists to prevent, arriving by
      // a route the Storage rules cannot see.
      const processed = await stripAndResize(file);

      const uploaded = await uploadProcessedPhoto(draft.id, processed, slot);
      // Re-taking a slot replaces it rather than piling up near-identical
      // photos — the person is fixing a blurry shot, not adding a second one.
      const kept = draft.media.filter((m) => m.slot !== slot);
      const next: PetDraft = { ...draft, media: [...kept, uploaded] };
      setDraft(next);
      await saveDraft(next);

      // Held in memory so analysis does not have to re-download what was just
      // uploaded. Lost on reload, which handleAnalyzePhotos recovers from.
      setPhotoBlobs((prev) => new Map(prev).set(slot, processed));
    } catch (err) {
      report(err);
    } finally {
      setBusy(false);
    }
  }

  /**
   * The ONE model call. Sends every captured slot together — see the quota
   * reasoning on handlePickPhoto.
   */
  async function handleAnalyzePhotos() {
    if (!user || !draft || draft.media.length === 0) return;
    setSuggesting(true);
    setError(null);
    setSuggestOutcome(null);
    try {
      // A reload drops the in-memory blobs while the draft keeps its media,
      // so fall back to re-fetching what was uploaded rather than refusing.
      const photos = await Promise.all(
        draft.media.map(async (m) => ({
          slot: m.slot,
          blob: photoBlobs.get(m.slot) ?? (await (await fetch(m.url)).blob()),
        })),
      );

      const outcome = await requestSuggestion(user, photos);
      setSuggestOutcome(outcome);

      const s = outcome.suggestion;
      if (!s) return;
      let next: PetDraft = draft;

      // Only the two fields the policy marks `prefill` are applied here.
      // Breed, size and names are buttons — see PhotoSuggestions.
      const patch: Partial<PetDraft> = {};
      const applied: string[] = [];

      if (s.species) {
        patch.species = s.species;
        applied.push('species');
      }

      // Colour and coat are prefilled rather than offered: anyone standing
      // next to the animal can check them in a second, and a wrong one is
      // embarrassing rather than harmful. Contrast breed, which reaches a
      // public listing as a claim.
      if (s.colorPattern) {
        patch.colorPattern = s.colorPattern;
        applied.push('colorPattern');
      }

      if (s.coatType) {
        patch.coatType = s.coatType;
        applied.push('coatType');
      }

      if (!s.age.refused && s.age.ageMonths !== null) {
        patch.ageYears = Math.floor(s.age.ageMonths / 12);
        patch.ageMonthsPart = s.age.ageMonths % 12;
        // The bounds travel with it. Without them the public page would
        // render the midpoint as though it were a known age.
        patch.ageMonthsMin = s.age.ageMonthsMin;
        patch.ageMonthsMax = s.age.ageMonthsMax;
        patch.ageUnknown = false;
        applied.push('ageMonths');
      }

      if (applied.length > 0) {
        next = {
          ...next,
          ...patch,
          suggestedFields: [...new Set([...next.suggestedFields, ...applied])],
          suggestedByModel: outcome.modelKey,
        };
        setDraft(next);
        await saveDraft(next);
      }
    } catch (caught) {
      report(caught);
    } finally {
      setSuggesting(false);
    }
  }

  /**
   * Accept one offered suggestion, recording that a model influenced it.
   *
   * Provenance is written at the moment of ACCEPTANCE rather than when the
   * suggestion arrived, because a suggestion nobody took did not influence
   * anything and should not be recorded as if it had.
   */
  function acceptSuggested(patch: Partial<PetDraft>, field: string) {
    if (!draft) return;
    update({
      ...patch,
      suggestedFields: [...new Set([...draft.suggestedFields, field])],
      suggestedByModel: suggestOutcome?.modelKey ?? draft.suggestedByModel,
    });
  }

  /** What the photographs read, if a call has come back. */
  const suggestion = suggestOutcome?.suggestion ?? null;

  // Hoisted rather than read as suggestion.breed.resembles at each call site:
  // TypeScript drops narrowing on a property access inside a closure, and these
  // are read from onClick handlers. A plain const needs no narrowing.
  const resembles: string[] =
    suggestion && suggestion.breed.kind === 'mixed' ? suggestion.breed.resembles : [];

  /** Wiring shared by every row, so a new field cannot forget half of it. */
  function fieldProps(key: string) {
    return {
      editing: openField === key,
      onToggle: () => setOpenField((cur) => (cur === key ? null : key)),
      disabled: busy,
    };
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
        petId: result.petId,
        slug: result.slug,
        requestedSlug: draft!.slug,
        name: draft!.name.trim(),
        status: draft!.status,
      });
    } catch (caught) {
      report(caught);
    } finally {
      setBusy(false);
    }
  }

  /**
   * "Reabrir expediente" — the animal in front of us is the one on file.
   *
   * The half-started draft is thrown away rather than published: the whole
   * point of resolving the chip was that this animal already has a record, so
   * keeping a second one around — even unpublished — would leave exactly the
   * duplicate the lookup exists to prevent sitting in the dashboard.
   */
  async function handleReopen() {
    if (!user || !readmit) return;
    setBusy(true);
    setError(null);
    try {
      const reopened = await reopenPet(readmit, readmitInput, draft!.microchipCode, user);

      // Best-effort, and after the write rather than before: if the
      // re-admission fails we want the draft still there to fall back on.
      await deletePhotos(draft!.media.map((m) => m.path));
      await discardDraft(draft!.id).catch((caught) => {
        console.error('[intake] could not discard the draft after reopening', caught);
      });

      setReadmitted({
        petId: reopened.petId,
        status: reopened.plan.status,
        slug: readmit.slug,
        name: readmitInput.name.trim() || readmit.name,
        renamed:
          readmitInput.name.trim().length > 0 &&
          readmitInput.name.trim().toLocaleLowerCase() !== readmit.name.toLocaleLowerCase(),
        previousName: readmit.name,
      });
    } catch (caught) {
      report(caught);
    } finally {
      setBusy(false);
    }
  }

  /**
   * "Es otro animal" — the chip resolved, but not to the animal in the room.
   *
   * Plan section 3.1 calls this a real signal rather than an error, and the
   * response is to flag it, never to silently create a duplicate. Recording it
   * on the draft blocks publishing this code onto a second record while leaving
   * the admin free to re-scan: the most likely cause by far is a transposed
   * digit, and a corrected code clears the gate on its own.
   */
  function markDifferentAnimal(petId: string, code: string) {
    update({ chipConflict: { petId, code } });
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
    setReadmitted(null);
    setReadmit(null);
    setReadmitInput({ name: '', status: 'shelter', note: '' });
    // The effect re-runs and clears this anyway once the new draft's empty
    // chip field fails validation, but leaving a resolved match on screen for
    // even one frame would show the previous animal above a blank form.
    setLookup({ state: 'idle' });
    setStep('identity');
    setNotice(null);
    setError(null);
    setSlugTouched(false);
    setDraft(draftDefaults(mintPetId()));
    // Only when a stale `?draft=` is still in the URL; otherwise the effect
    // does not re-run and would leave the resumed id in the address bar.
    if (resumeId) router.replace('/admin/intake');
  }

  // ── re-admitted ───────────────────────────────────────────────────────────
  if (readmitted) {
    return (
      <div className="admin-done">
        <h1 className="t-title">Reingreso registrado</h1>
        <p className="admin-done__note">
          <strong>{readmitted.name}</strong> ya estaba en el sistema, así que no creamos una
          ficha nueva: se agregó el reingreso a la que ya tenía.
          <br />
          <code className="admin-done__url">wawitas.org/adopt/{readmitted.slug}</code>
        </p>

        {readmitted.renamed && (
          <p className="auth__notice" role="status">
            Antes se llamaba <strong>{readmitted.previousName}</strong>. Guardamos ese nombre en
            su historial, para que quien lo busque así lo encuentre.
          </p>
        )}

        <p className="admin-gate__note">
          Su historial médico, su microchip y sus fotos siguen intactos. Lo que se agregó es un
          registro de custodia y un registro de escaneo.
        </p>

        <div className="admin-done__actions">
          {shouldHaveOpenPlacement(readmitted.status) && (
            <Link href={`/admin/pets/${readmitted.petId}`} className="btn btn--action">
              Asignar área
            </Link>
          )}
          <Link href={`/adopt/${readmitted.slug}`} className="btn btn--brand">
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

  // ── re-admission form ─────────────────────────────────────────────────────
  if (readmit) {
    return (
      <div className="admin">
        <header className="admin__header">
          <div>
            <h1 className="t-title">Reingreso</h1>
            <p className="admin__sub">
              Este animalito ya tiene ficha. Estamos agregando su regreso, no creando una nueva.
            </p>
          </div>
          <button
            type="button"
            className="btn btn--muted"
            disabled={busy}
            onClick={() => setReadmit(null)}
          >
            ← Volver
          </button>
        </header>

        {error && (
          <p className="auth__error" role="alert">
            {error}
          </p>
        )}

        <div className="admin-match">
          {readmit.coverPhoto && (
            <img className="admin-match__photo" src={readmit.coverPhoto} alt={readmit.name} />
          )}
          <div className="admin-match__body">
            <strong className="admin-match__name">{readmit.name}</strong>
            <p className="admin-match__meta">
              {readmit.breed} · {t.formatMeta(readmit)}
            </p>
            <p className="admin-match__meta">Estado actual: {t.statusLabel(readmit.status)}</p>
            {readmit.formerNames.length > 0 && (
              <p className="admin-match__meta">
                También se llamó: {readmit.formerNames.join(', ')}
              </p>
            )}
          </div>
        </div>

        <section className="admin-form">
          <label className="auth__field">
            <span className="t-label">¿Cambió de nombre?</span>
            <input
              type="text"
              value={readmitInput.name}
              placeholder={readmit.name}
              disabled={busy}
              onChange={(e) => setReadmitInput((c) => ({ ...c, name: e.target.value }))}
            />
            <small className="auth__hint">
              Déjalo en blanco si se sigue llamando {readmit.name}. Si escribes otro, el anterior
              queda guardado en su historial — nunca se borra.
            </small>
          </label>

          <label className="auth__field">
            <span className="t-label">¿A dónde entra?</span>
            <select
              value={readmitInput.status}
              disabled={busy}
              onChange={(e) =>
                setReadmitInput((c) => ({ ...c, status: e.target.value as PetStatus }))
              }
            >
              {READMISSION_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t.statusLabel(status)}
                </option>
              ))}
            </select>
          </label>

          <label className="auth__field">
            <span className="t-label">Nota (opcional)</span>
            <textarea
              rows={3}
              value={readmitInput.note}
              placeholder="Por qué volvió, quién lo trajo…"
              disabled={busy}
              onChange={(e) => setReadmitInput((c) => ({ ...c, note: e.target.value }))}
            />
          </label>

          <div className="admin-done__actions">
            <button
              type="button"
              className="btn btn--brand"
              disabled={busy}
              onClick={() => void handleReopen()}
            >
              {busy ? 'Guardando…' : 'Registrar reingreso'}
            </button>
          </div>
        </section>
      </div>
    );
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

        {/* Where the animal physically IS is deliberately NOT asked here.
            The wizard's job ends when the record exists; the pen it goes into
            is a placement, and a placement is an interval that gets closed and
            reopened every time it moves. Folding the first one into publish
            would make the wizard the only screen that can start a ledger it
            cannot continue. So this hands over instead — and the panel flags
            any animal inside the facility with no open placement, so skipping
            it here stays visible rather than silently leaving a gap in the
            outbreak trace. */}
        {shouldHaveOpenPlacement(published.status) && (
          <p className="auth__notice" role="status">
            Falta decir en qué área quedó. Sin eso, si se enferma no hay forma de saber a quién
            estuvo expuesto.
          </p>
        )}

        <div className="admin-done__actions">
          {shouldHaveOpenPlacement(published.status) && (
            <Link href={`/admin/pets/${published.petId}`} className="btn btn--action">
              Asignar área
            </Link>
          )}
          <Link href={`/adopt/${published.slug}`} className="btn btn--brand">
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
          <GuidedPhotoCapture
            captured={draft.media.map((m) => ({
              slot: m.slot,
              url: m.url,
              busy: false,
            }))}
            busy={busy}
            disabled={busy || suggesting}
            analysing={suggesting}
            onPick={(slot, file) => void handlePickPhoto(slot, file)}
            onAnalyze={() => void handleAnalyzePhotos()}
          />

          {/* Narrative only. Every per-field reading now lands in the row for
              that field below, so this panel says what the photographs SHOW
              and the rows say what the record HOLDS. */}
          <PhotoSuggestions
            outcome={suggestOutcome}
            busy={suggesting}
            disabled={busy}
            onApplySterilized={() => acceptSuggested({ sterilized: true }, 'sterilized')}
          />

          {/* ── one row per field, and exactly one ────────────────────────
              Each row shows what the field HOLDS and opens its editor when
              clicked. Until 2026-09-02 these values were printed once in the
              suggestions panel above and then asked for again here as empty
              controls, so the screen posed the same question twice — `Sexo:
              Hembra` followed by `Sexo: [Elegir…]` — and the second one
              implied the first had not been recorded. Reported by the
              shelter. See EditableField.tsx for the reasoning.

              ⚠️ Do not re-add a plain control alongside a row. The duplication
              was not a layout accident; it was two components each believing
              they owned the field. */}
          <div className="field-list">
            <EditableField
              label="Nombre"
              value={draft.name || null}
              note={
                !draft.name && suggestion && suggestion.names.length > 0
                  ? 'Nombres que van con lo que se ve. También puedes escribir el que ya usa el refugio.'
                  : undefined
              }
              offers={
                draft.name
                  ? undefined
                  : suggestion?.names.map((name) => ({
                      label: name,
                      onAccept: () =>
                        acceptSuggested(
                          slugTouched ? { name } : { name, slug: slugify(name) },
                          'name',
                        ),
                    }))
              }
              {...fieldProps('name')}
            >
              <input
                type="text"
                value={draft.name}
                disabled={busy}
                autoFocus
                onChange={(e) => {
                  const name = e.target.value;
                  // The slug follows the name until someone edits it by hand.
                  // After that it is theirs — silently overwriting a chosen URL
                  // would change a link they may already have shared.
                  update(slugTouched ? { name } : { name, slug: slugify(name) });
                }}
              />
            </EditableField>

            <EditableField
              label="Especie"
              value={optionLabel(SPECIES_OPTIONS, draft.species)}
              note={
                draft.suggestedFields.includes('species')
                  ? 'Leída en las fotos.'
                  : undefined
              }
              {...fieldProps('species')}
            >
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
            </EditableField>

            {/* Sex sits above Raza because the breed wording cannot be spelled
                until a sex exists — "mestizo" against "mestiza" — so the field
                that supplies one has to come first. */}
            <EditableField
              label="Sexo"
              value={optionLabel(SEX_OPTIONS, draft.sex)}
              note={
                draft.sex
                  ? 'De él dependen todos los textos del sitio.'
                  : suggestion
                    ? (SEX_WITHHELD_REASON[suggestion.sex.refusedBecause ?? ''] ??
                      (suggestion.sex.sex
                        ? 'Leído en la foto de genitales. Confírmalo tú.'
                        : undefined))
                    : undefined
              }
              offers={
                !draft.sex && suggestion?.sex.sex
                  ? [
                      {
                        label: t.sexLabel(suggestion.sex.sex),
                        onAccept: () => acceptSuggested({ sex: suggestion.sex.sex }, 'sex'),
                      },
                    ]
                  : undefined
              }
              {...fieldProps('sex')}
            >
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
            </EditableField>

            <EditableField
              label="Tamaño"
              value={optionLabel(SIZE_OPTIONS, draft.size)}
              note={
                !draft.size && suggestion && !suggestion.size
                  ? (WITHHELD_REASON.size ?? undefined)
                  : undefined
              }
              offers={
                !draft.size && suggestion?.size
                  ? [
                      {
                        label: optionLabel(SIZE_OPTIONS, suggestion.size) ?? '',
                        onAccept: () => acceptSuggested({ size: suggestion.size }, 'size'),
                      },
                    ]
                  : undefined
              }
              {...fieldProps('size')}
            >
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
            </EditableField>

            <EditableField
              label="Raza"
              value={draft.breed || null}
              note={
                draft.breed
                  ? undefined
                  : suggestion && suggestion.breed.kind === 'mixed' && !draft.sex
                    ? 'Elige primero el sexo: la palabra cambia entre «mestizo» y «mestiza», y eso no se ve en una foto.'
                    : undefined
              }
              offers={
                draft.breed || !suggestion
                  ? undefined
                  : suggestion.breed.kind !== 'mixed'
                    ? [
                        {
                          label: suggestion.breed.breed,
                          onAccept: () =>
                            acceptSuggested(
                              {
                                breed:
                                  suggestion.breed.kind === 'purebred'
                                    ? suggestion.breed.breed
                                    : '',
                              },
                              'breed',
                            ),
                        },
                      ]
                    : draft.sex
                      ? [
                          // The resemblance offer comes first: "mestizo" alone
                          // is true and tells an adopter nothing. Plain
                          // "mestizo" stays beside it, because the shelter may
                          // know the likeness is wrong and taking the option
                          // away would force them to retype it.
                          {
                            label: t.mixedBreedWithTraits(draft.sex, resembles),
                            onAccept: () =>
                              acceptSuggested(
                                { breed: t.mixedBreedWithTraits(draft.sex!, resembles) },
                                'breed',
                              ),
                          },
                          ...(resembles.length > 0
                            ? [
                                {
                                  label: t.mixedBreed(draft.sex),
                                  onAccept: () =>
                                    acceptSuggested({ breed: t.mixedBreed(draft.sex!) }, 'breed'),
                                },
                              ]
                            : []),
                        ]
                      : undefined
              }
              {...fieldProps('breed')}
            >
              <input
                type="text"
                value={draft.breed}
                placeholder={draft.sex ? t.mixedBreed(draft.sex) : 'mestizo / mestiza'}
                disabled={busy}
                autoFocus
                onChange={(e) => update({ breed: e.target.value })}
              />
            </EditableField>

            <EditableField
              label="Color y manchas"
              value={draft.colorPattern || null}
              note={
                draft.suggestedFields.includes('colorPattern')
                  ? 'Leído en las fotos. Es lo que escribe alguien que busca a su perro perdido.'
                  : undefined
              }
              hint="Es lo que escribe alguien que busca a su perro perdido."
              {...fieldProps('colorPattern')}
            >
              <input
                type="text"
                value={draft.colorPattern}
                disabled={busy}
                autoFocus
                onChange={(e) => update({ colorPattern: e.target.value })}
              />
            </EditableField>

            <EditableField
              label="Pelaje"
              value={draft.coatType || null}
              note={
                draft.suggestedFields.includes('coatType') ? 'Leído en las fotos.' : undefined
              }
              hint="Largo, textura y densidad. Le dice a quien adopta cuánto cepillado le espera."
              {...fieldProps('coatType')}
            >
              <input
                type="text"
                value={draft.coatType}
                disabled={busy}
                autoFocus
                onChange={(e) => update({ coatType: e.target.value })}
              />
            </EditableField>

            <EditableField
              label="Peso aproximado"
              value={
                draft.weightKgMin !== null && draft.weightKgMax !== null
                  ? `${draft.weightKgMin}–${draft.weightKgMax} kg`
                  : null
              }
              note={
                draft.weightKgMin === null && suggestion?.weight.refused
                  ? (WITHHELD_REASON.weight ?? undefined)
                  : undefined
              }
              hint={
                <>
                  Un rango, no un número exacto — se guarda siempre como estimación.
                  Sirve para elegir el área y calcular raciones aproximadas, y
                  <strong> nunca para calcular una dosis</strong>: eso lo hace el
                  veterinario con una balanza.
                </>
              }
              offers={
                draft.weightKgMin === null &&
                suggestion &&
                !suggestion.weight.refused &&
                suggestion.weight.weightKgMin !== null &&
                suggestion.weight.weightKgMax !== null
                  ? [
                      {
                        label: `${suggestion.weight.weightKgMin}–${suggestion.weight.weightKgMax} kg`,
                        onAccept: () =>
                          acceptSuggested(
                            {
                              weightKgMin: suggestion.weight.weightKgMin,
                              weightKgMax: suggestion.weight.weightKgMax,
                            },
                            'weightKg',
                          ),
                      },
                    ]
                  : undefined
              }
              {...fieldProps('weight')}
            >
              <div className="admin-form__row">
                <label className="auth__field">
                  <span className="t-label">Desde (kg)</span>
                  <input
                    type="number"
                    min={0}
                    step="0.1"
                    inputMode="decimal"
                    value={draft.weightKgMin ?? ''}
                    disabled={busy}
                    onChange={(e) =>
                      update({ weightKgMin: e.target.value === '' ? null : Number(e.target.value) })
                    }
                  />
                </label>
                <label className="auth__field">
                  <span className="t-label">Hasta (kg)</span>
                  <input
                    type="number"
                    min={0}
                    step="0.1"
                    inputMode="decimal"
                    value={draft.weightKgMax ?? ''}
                    disabled={busy}
                    onChange={(e) =>
                      update({ weightKgMax: e.target.value === '' ? null : Number(e.target.value) })
                    }
                  />
                </label>
              </div>
            </EditableField>

            <EditableField
              label="Edad aproximada"
              value={describeAge(draft.ageYears, draft.ageMonthsPart, draft.ageUnknown)}
              note={
                draft.suggestedFields.includes('ageMonths')
                  ? 'Estimada con la foto de dientes.'
                  : suggestion?.age.refused
                    ? (WITHHELD_REASON.age ?? undefined)
                    : undefined
              }
              {...fieldProps('age')}
            >
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
                      update({
                        ageMonthsPart: e.target.value === '' ? null : Number(e.target.value),
                      })
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
            </EditableField>

            <EditableField
              label="Estado"
              value={t.statusLabel(draft.status)}
              note={
                draft.status === 'available'
                  ? 'Aparece en el muro público.'
                  : 'Solo «Disponible» aparece en el muro público.'
              }
              {...fieldProps('status')}
            >
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
            </EditableField>

            <EditableField
              label="Dirección web"
              value={draft.slug || null}
              note={`wawitas.org/adopt/${draft.slug || '…'}`}
              {...fieldProps('slug')}
            >
              <input
                type="text"
                value={draft.slug}
                disabled={busy}
                autoFocus
                onChange={(e) => {
                  setSlugTouched(true);
                  update({ slug: e.target.value });
                }}
              />
            </EditableField>
          </div>

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

                {/* ── the deduplication branch, plan section 3.1 ──────────── */}
                {lookup.state === 'searching' && (
                  <p className="auth__notice" role="status">
                    Buscando si ese chip ya está registrado…
                  </p>
                )}

                {lookup.state === 'failed' && (
                  <p className="auth__error" role="alert">
                    No pudimos revisar si ese chip ya está registrado. Puedes continuar, pero si
                    el animalito ya estuvo aquí antes se va a crear una ficha repetida — mejor
                    intenta de nuevo en un momento.
                  </p>
                )}

                {chipUnregistered && (
                  <p className="auth__notice" role="status">
                    Ese chip no está registrado aquí. Seguimos con un ingreso nuevo.
                  </p>
                )}

                {chipAmbiguous && (
                  <p className="auth__error" role="alert">
                    Ese número aparece en más de una ficha:{' '}
                    {chipAmbiguous.map((p) => p.name).join(', ')}. Eso no debería pasar, y hay
                    que arreglarlo antes de seguir — avisa a quien administra el sistema.
                  </p>
                )}

                {chipMatch && (
                  <div className="admin-match" role="status">
                    {chipMatch.coverPhoto && (
                      <img
                        className="admin-match__photo"
                        src={chipMatch.coverPhoto}
                        alt={chipMatch.name}
                      />
                    )}
                    <div className="admin-match__body">
                      <strong className="admin-match__name">
                        Ese chip ya es de {chipMatch.name}
                      </strong>
                      <p className="admin-match__meta">
                        {chipMatch.breed} · {t.formatMeta(chipMatch)} ·{' '}
                        {t.statusLabel(chipMatch.status)}
                      </p>
                      <p className="admin-match__meta">
                        {formatMicrochipCode(chipLookupCode ?? '')}
                      </p>

                      {/* Both answers are legitimate, so neither is the
                          default. Guessing here is how a duplicate gets
                          created by someone clicking through. */}
                      <div className="admin-match__actions">
                        <button
                          type="button"
                          className="btn btn--brand"
                          disabled={busy}
                          onClick={() => {
                            update({ chipConflict: null });
                            setReadmit(chipMatch);
                          }}
                        >
                          Es el mismo — reabrir su ficha
                        </button>
                        <button
                          type="button"
                          className="btn btn--muted"
                          disabled={busy || draft.chipConflict?.petId === chipMatch.id}
                          onClick={() => markDifferentAnimal(chipMatch.id, chipLookupCode ?? '')}
                        >
                          Es otro animal
                        </button>
                        <Link
                          href={`/adopt/${chipMatch.slug}`}
                          target="_blank"
                          className="btn btn--muted"
                        >
                          Ver su ficha ↗
                        </Link>
                      </div>
                    </div>
                  </div>
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
