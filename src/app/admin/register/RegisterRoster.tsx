/**
 * The roster — the screen a volunteer opens when the animal in front of them
 * is already written in the shelter's paper register.
 *
 * ── Why this screen exists ────────────────────────────────────────────────
 * 225 animals were transcribed from the register and 43 of them still live
 * here. Those 43 will be photographed, and every photograph has to land on the
 * record the import already created — with its intake date, its vaccination
 * history and its register number — rather than on a second record for the
 * same dog. "Find the animal, then photograph it" is the only order that
 * produces one record per animal; "photograph it, then try to remember which
 * row it was" produces two.
 *
 * So the whole design question is: how does a person standing in a yard with a
 * dog in their arms pick the right row out of 225, on a phone, without being
 * able to ask the dog its name? Everything below answers that.
 *
 * ── The rules this screen keeps ───────────────────────────────────────────
 *  1. The register number is ALWAYS visible, never on hover. It is the only
 *     thing separating n.º 215 "Dana" from n.º 216 "Duna" — same sex, admitted
 *     the same day, both black — and a phone has no hover.
 *  2. A row that is not `in-shelter` carries its outcome as a badge, and
 *     picking one asks a SECOND time, naming what the register says happened.
 *     A photograph must never land silently on a dead animal's record.
 *  3. "No sé cuál es" is a real answer with a real button. A person who cannot
 *     tell two littermates apart and is forced to choose produces a confident
 *     wrong link; a provisional one announces itself and can be settled later.
 *  4. "It is a new animal" sits at the BOTTOM. Put it at the top and the
 *     roster stops being used, which is the one failure that makes all of the
 *     above pointless.
 *
 * Everything is read CLIENT-SIDE through `firestore.rules`, which restrict
 * `registerEntries` to admins in both directions. The authorization is
 * enforced rather than re-implemented, and a missing claim surfaces as
 * `permission-denied` — which is the authorization working.
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import {
  compareForRoster,
  findLookalikes,
  listRegisterEntries,
  markProvisional,
  matchesTokens,
  openOrCreateDraftForEntry,
  searchNeedles,
  searchTokensFor,
  unlinkEntry,
} from '@/lib/register-admin';
import { listDrafts } from '@/lib/pets-admin';
import { formatDate } from '@/lib/date-input';
import { t } from '@/i18n';
import type { PetSex, RegisterEntry, RegisterStatus } from '@/lib/types';

type Tab = 'resident' | 'all';

/** What the roster knows about the record behind a linked row. */
type RowState = 'unlinked' | 'no-photos' | 'photos' | 'published';

/**
 * The register's own outcome words, as a badge.
 *
 * Nouns and a bare verb, never a participle: "adoptado" would be wrong for
 * half the register and the sex is unknown on some rows entirely. Spanish
 * forces a choice that the paper never made, so the wording sidesteps it.
 */
const STATUS_BADGE: Record<RegisterStatus, string | null> = {
  'in-shelter': null,
  adopted: 'Adopción',
  returned: 'Devolución',
  died: 'Murió',
  transferred: 'Traspaso',
  unknown: 'Sin dato',
};

/**
 * What the register says happened, as a sentence a volunteer is asked to
 * confirm against the animal in front of them.
 *
 * Gender-free for the same reason the badges are. The date is included when
 * there is one and its absence is stated when there is not — a sentence that
 * quietly drops the date reads as though the register were more certain than
 * it is.
 */
function statusSentence(entry: RegisterEntry): string {
  const when = entry.statusDate
    ? ` el ${formatDate(entry.statusDate.toMillis())}`
    : ', aunque no anota la fecha';

  switch (entry.status) {
    case 'adopted':
      return `El registro dice que este animalito salió en adopción${when}.`;
    case 'returned':
      return `El registro dice que este animalito volvió a su casa o a su calle${when}.`;
    case 'died':
      return `El registro dice que este animalito murió${when}.`;
    case 'transferred':
      return `El registro dice que este animalito pasó a otras manos${when}.`;
    default:
      return 'El registro no dice qué pasó con este animalito.';
  }
}

function displayName(entry: RegisterEntry): string {
  const name = entry.name.trim();
  if (name) return name;
  // Never blank, and never invented: the number is what the paper actually
  // offers when the name cell holds nothing usable.
  return `Sin nombre (n.º ${entry.no})`;
}

function sexText(sex: PetSex | null): string {
  return sex === null ? 'sexo no registrado' : t.sexLabel(sex);
}

function intakeText(entry: RegisterEntry): string {
  if (entry.intakeDate) return `ingresó el ${formatDate(entry.intakeDate.toMillis())}`;
  // The cell often holds only a year, so show what it says rather than
  // nothing — "2024" is a much better answer than silence.
  const raw = entry.intakeRaw.trim();
  return raw ? `ingresó: ${raw}` : 'sin fecha de ingreso';
}

export function RegisterRoster() {
  const router = useRouter();

  const [entries, setEntries] = useState<RegisterEntry[] | null>(null);
  /** petId → how many photos its draft already holds. Absent means no draft. */
  const [draftPhotos, setDraftPhotos] = useState<Map<string, number>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>('resident');
  const [queryText, setQueryText] = useState('');
  const [sexFilter, setSexFilter] = useState<PetSex | null>(null);

  /** The row whose confirm card is open, and how far through it we are. */
  const [candidate, setCandidate] = useState<RegisterEntry | null>(null);
  const [askingStatus, setAskingStatus] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * How far down the search bar has to stick, in pixels.
   *
   * ⚠️ MEASURED, not hardcoded. The site header is itself
   * `position: sticky; top: 0; z-index: 50`, so a search bar stuck at `top: 0`
   * slides underneath it and disappears — which is the one thing this screen
   * cannot afford, because the search IS the screen. The header is 173px tall
   * at 390px and shorter above the 760px break (the nav stops having its own
   * row), so a constant would be wrong on one of them.
   *
   * A `ResizeObserver` rather than a one-off read: the header also changes
   * height when the phone is rotated and when a long account label wraps.
   * Falling back to 0 if the header is not found keeps this a layout nicety
   * rather than something the screen depends on.
   */
  const [stickyTop, setStickyTop] = useState(0);

  useEffect(() => {
    const header = document.querySelector('.header');
    if (!header) return;

    const measure = () => setStickyTop(Math.round(header.getBoundingClientRect().height));
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      // The WHOLE register, once. The type-ahead has to answer on every
      // keystroke, and a Firestore query per character would be both slow and
      // a billed read per character. 225 documents is one small page.
      const rows = await listRegisterEntries();
      setEntries(rows);

      // Drafts are read so a row can say whether the animal still needs
      // photographs, which is the actual question during a photo session —
      // "is it linked" is not the same as "is it done". A linked row with no
      // draft is an animal whose record was already published.
      const drafts = await listDrafts(200);
      setDraftPhotos(new Map(drafts.map((draft) => [draft.id, draft.media.length])));
    } catch (caught) {
      console.error('[register] could not load', caught);
      const code = (caught as { code?: string })?.code;
      setLoadError(
        code === 'permission-denied'
          ? 'Firestore rechazó la lectura por permisos. Si te acaban de dar acceso, cierra sesión y vuelve a entrar.'
          : 'No pudimos cargar el registro. Revisa tu conexión e intenta de nuevo.',
      );
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The folded search tokens for every row, built once. Re-folding 225 rows on
   * every keystroke is wasted work on the one screen that has to feel instant.
   */
  const indexed = useMemo(
    () => (entries ?? []).map((entry) => ({ entry, tokens: searchTokensFor(entry) })),
    [entries],
  );

  /**
   * Rows that are provisionally linked, plus every row they could be confused
   * with. Both halves of an unresolved pair are badged: the one that was
   * linked knows it is uncertain, and the one that was not is the other
   * possibility — leaving it unmarked would let someone link it too, as a
   * second animal.
   */
  const unsettled = useMemo(() => {
    const rows = entries ?? [];
    const marked = new Set<number>();
    for (const entry of rows) {
      if (entry.linkConfidence !== 'provisional') continue;
      marked.add(entry.no);
      for (const other of findLookalikes(entry, rows)) marked.add(other.no);
    }
    return marked;
  }, [entries]);

  const needles = useMemo(() => searchNeedles(queryText), [queryText]);

  const visible = useMemo(() => {
    return indexed
      .filter(({ entry, tokens }) => {
        if (tab === 'resident' && entry.status !== 'in-shelter') return false;
        if (sexFilter !== null && entry.sex !== sexFilter) return false;
        return matchesTokens(tokens, needles);
      })
      .map(({ entry }) => entry)
      .sort(compareForRoster);
  }, [indexed, tab, sexFilter, needles]);

  const residentCount = useMemo(
    () => (entries ?? []).filter((entry) => entry.status === 'in-shelter').length,
    [entries],
  );

  const lookalikes = useMemo(
    () => (candidate ? findLookalikes(candidate, entries ?? []) : []),
    [candidate, entries],
  );

  function rowState(entry: RegisterEntry): RowState {
    if (!entry.petId) return 'unlinked';
    const photos = draftPhotos.get(entry.petId);
    if (photos === undefined) return 'published';
    return photos > 0 ? 'photos' : 'no-photos';
  }

  function rowStateText(entry: RegisterEntry): string {
    const state = rowState(entry);
    if (state === 'published') return 'ya tiene ficha';
    if (state === 'photos') {
      const photos = draftPhotos.get(entry.petId!) ?? 0;
      return `${photos} foto${photos === 1 ? '' : 's'}`;
    }
    return 'sin foto';
  }

  function openCandidate(entry: RegisterEntry) {
    setCandidate(entry);
    setAskingStatus(false);
    setActionError(null);
    setNotice(null);
  }

  function closeCandidate() {
    setCandidate(null);
    setAskingStatus(false);
    setActionError(null);
  }

  /** Open (or create) the record this row belongs to and go there. */
  async function go(entry: RegisterEntry, confidence: 'confirmed' | 'provisional') {
    setBusy(true);
    setActionError(null);
    try {
      const result = await openOrCreateDraftForEntry(entry, confidence);

      if (result.kind === 'published') {
        // The animal's record already exists as a published pet, so there is
        // no draft to open. Sending the volunteer to the wizard would start a
        // blank one — see `OpenEntryResult` — which is the duplicate this
        // screen exists to prevent.
        router.push(`/admin/pets/${result.petId}`);
        return;
      }

      // `openOrCreateDraftForEntry` writes the confidence only when it CREATES
      // the link, so an already-linked row needs the downgrade written here.
      //
      // ⚠️ The reverse is deliberately NOT done: "Sí, es esta" on a row that is
      // already `provisional` does not promote it to `confirmed`. Reopening a
      // record to add another photograph is the ordinary reason to come back
      // here, and treating that as a fresh judgement would silently erase the
      // one marker saying somebody still has to tell two littermates apart.
      // Settling a provisional link should be an act, not a side effect.
      if (!result.created && confidence === 'provisional') {
        await markProvisional(entry);
      }

      router.push(`/admin/intake?draft=${result.petId}`);
    } catch (caught) {
      console.error('[register] could not open the entry', caught);
      const code = (caught as { code?: string })?.code;
      setActionError(
        code === 'permission-denied'
          ? 'Firestore rechazó la escritura por permisos. Si te acaban de dar acceso, cierra sesión y vuelve a entrar.'
          : 'No pudimos abrir la ficha de este animalito. Revisa tu conexión e intenta de nuevo.',
      );
      setBusy(false);
    }
  }

  /** "Sí, es esta" — with one more question when the register says it left. */
  function confirm(entry: RegisterEntry) {
    if (entry.status !== 'in-shelter' && !askingStatus) {
      setAskingStatus(true);
      return;
    }
    void go(entry, 'confirmed');
  }

  async function unlink(entry: RegisterEntry) {
    setBusy(true);
    setActionError(null);
    try {
      await unlinkEntry(entry);
      closeCandidate();
      setNotice(
        `Soltamos la n.º ${entry.no}. No se borró nada: la ficha y sus fotos siguen ahí, ahora como un ingreso sin número de registro.`,
      );
      await load();
    } catch (caught) {
      console.error('[register] could not unlink', caught);
      setActionError('No pudimos soltar este número. Revisa tu conexión e intenta de nuevo.');
    } finally {
      setBusy(false);
    }
  }

  // ── the confirm card ──────────────────────────────────────────────────────
  // Rendered INSTEAD of the list, the same way the re-admission screen replaces
  // the intake wizard: one decision on the screen at a time, on a phone held in
  // one hand.
  if (candidate) {
    const linked = candidate.petId !== null;

    return (
      <div className="admin">
        <header className="admin__header">
          <div>
            <h1 className="t-title">¿Es este animalito?</h1>
            <p className="admin__sub">
              Compara lo que dice el registro con el animalito que tienes adelante. Si no
              coincide, vuelve y busca otra vez.
            </p>
          </div>
          <button type="button" className="btn btn--muted" disabled={busy} onClick={closeCandidate}>
            ← Volver
          </button>
        </header>

        {actionError && (
          <p className="auth__error" role="alert">
            {actionError}
          </p>
        )}

        <div className="admin-match">
          <div className="admin-match__body">
            <span className="register-no register-no--card">n.º {candidate.no}</span>
            <strong className="admin-match__name">{displayName(candidate)}</strong>

            {candidate.aliases.length > 0 && (
              <p className="admin-match__meta">
                También aparece como: {candidate.aliases.join(', ')}
              </p>
            )}
            {!candidate.hasRealName && (
              <p className="admin-match__meta">
                El registro no le puso nombre — anotó una descripción: «{candidate.nameRaw}». Vas a
                tener que ponerle uno tú.
              </p>
            )}

            <p className="admin-match__meta">
              {sexText(candidate.sex)} · {intakeText(candidate)}
            </p>
            <p className="admin-match__meta">
              Edad al ingresar: {candidate.ageAtIntakeRaw?.trim() || 'edad no registrada'}
            </p>
            <p className="admin-match__meta">
              Color: {candidate.colourNote?.trim() || 'sin color anotado'}
            </p>
            {candidate.breedWords.length > 0 && (
              <p className="admin-match__meta">
                El registro anota: {candidate.breedWords.join(', ')}
              </p>
            )}

            {/* Usually the single most useful line on this card: that person
                handled the animal and knows which dog is which. */}
            <p className="admin-match__meta">
              Quién lo rescató: {candidate.responsible?.trim() || 'no dice quién lo rescató'}
              {candidate.responsible?.trim() && ' — esa persona suele saber cuál es cuál.'}
            </p>

            {candidate.statusWhy.trim() && (
              <p className="admin-match__meta">{candidate.statusWhy.trim()}</p>
            )}

            {linked && (
              <p className="admin-match__meta">
                Ya está enlazado con una ficha ({rowStateText(candidate)}).
                {candidate.linkConfidence === 'provisional' &&
                  ' Quedó marcado como «por confirmar»: alguien dijo que no podía distinguirlo de otro animalito.'}
              </p>
            )}
          </div>
        </div>

        {/* The second question, and the reason it is a separate step: a
            photograph must never land silently on the record of an animal the
            register says is gone. */}
        {askingStatus && (
          <div className="register-warning" role="alert">
            <p>{statusSentence(candidate)}</p>
            <p>¿De verdad es el animalito que tienes adelante?</p>
            <div className="admin-match__actions">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void go(candidate, 'confirmed')}
              >
                Sí, de verdad es esta
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setAskingStatus(false)}
              >
                No, me equivoqué
              </button>
            </div>
          </div>
        )}

        {!askingStatus && (
          <>
            {/* Two answers, one weight. Neither is autofocused and there is no
                form here, so Enter submits nothing — the same reasoning the
                chip-match card in IntakeWizard documents: a decision that reads
                as a default gets clicked past, and clicking past this one
                creates a second record for an animal that already has one. */}
            <div className="admin-match__actions">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => confirm(candidate)}
              >
                Sí, es esta
              </button>
              <button type="button" className="btn" disabled={busy} onClick={closeCandidate}>
                No, es otra
              </button>
            </div>

            {lookalikes.length > 0 && (
              <div className="register-unsure">
                <p className="admin__sub">
                  {lookalikes.length === 1 ? 'El registro anota otro animalito igual: ' : 'El registro anota otros animalitos iguales: '}
                  {lookalikes.map((other) => `n.º ${other.no} ${displayName(other)}`).join(', ')} —
                  del mismo sexo y del mismo día. Si no puedes distinguirlos, dilo: la ficha se
                  enlaza igual y queda marcada para que después alguien lo confirme.
                </p>
                <button
                  type="button"
                  className="btn btn--muted"
                  disabled={busy}
                  onClick={() => void go(candidate, 'provisional')}
                >
                  {lookalikes.length === 1 ? 'No sé cuál de los dos es' : 'No sé cuál es'}
                </button>
              </div>
            )}

            {linked && (
              <div className="register-unsure">
                <p className="admin__sub">
                  Si este número quedó enlazado con el animalito equivocado, suéltalo. No se borra
                  nada: la ficha y sus fotos siguen ahí, sin número de registro.
                </p>
                <button
                  type="button"
                  className="btn btn--muted"
                  disabled={busy}
                  onClick={() => void unlink(candidate)}
                >
                  Soltar este número
                </button>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  // ── the roster ────────────────────────────────────────────────────────────
  return (
    <div className="admin">
      <header className="admin__header">
        <div>
          <h1 className="t-title">En el refugio</h1>
          <p className="admin__sub">
            Busca al animalito que tienes adelante y ábrelo para tomarle fotos. Así las fotos
            entran en la ficha que ya existe, y no se crea una repetida.
          </p>
        </div>
        <Link href="/admin" className="btn btn--muted">
          ← Panel
        </Link>
      </header>

      {loadError && (
        <p className="auth__error" role="alert">
          {loadError}
        </p>
      )}

      {notice && (
        <p className="auth__notice" role="status">
          {notice}
        </p>
      )}

      <div className="register-tabs" role="tablist" aria-label="Qué parte del registro mirar">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'resident'}
          className={`register-tab${tab === 'resident' ? ' is-current' : ''}`}
          onClick={() => setTab('resident')}
        >
          En el refugio
          {entries !== null && <span className="register-tab__count">{residentCount}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'all'}
          className={`register-tab${tab === 'all' ? ' is-current' : ''}`}
          onClick={() => setTab('all')}
        >
          Buscar en todo el registro
        </button>
      </div>

      <div className="register-body">
        {/* Sticky under the site header — see `stickyTop` above for why that
            offset is measured. The list is 43 rows on the first tab and 225 on
            the second, and a search box that scrolls away means scrolling back
            up to fix a typo. */}
        <div className="register-sticky" style={{ top: stickyTop }}>
          <label className="t-label" htmlFor="register-q">
            Buscar
          </label>
          <input
            id="register-q"
            type="search"
            inputMode="search"
            autoComplete="off"
            value={queryText}
            placeholder="Nombre o número, p. ej. Dana o 215"
            onChange={(event) => setQueryText(event.target.value)}
          />
          {/* Guidance for an EMPTY box, and only then. Once someone is typing
              it has done its job, and on a phone it would otherwise cost ~60px
              of pinned screen for the rest of the session. */}
          {queryText.trim() === '' && (
            <p className="auth__hint">
              Si no sabes cómo se escribe, escríbelo como suena: «dana» también encuentra a «Duna».
            </p>
          )}

          {/* Exactly two. There is deliberately NO age filter: 17 of the 43
              animals still living here have no age written anywhere in the
              register, so an age filter would hide precisely the rows nobody
              can identify by age in the first place. */}
          <div className="register-chips">
            {(['female', 'male'] as const).map((sex) => (
              <button
                key={sex}
                type="button"
                aria-pressed={sexFilter === sex}
                className={`register-chip${sexFilter === sex ? ' is-on' : ''}`}
                onClick={() => setSexFilter((current) => (current === sex ? null : sex))}
              >
                {sex === 'female' ? 'Hembra' : 'Macho'}
              </button>
            ))}
          </div>
        </div>

        {entries === null && <p className="admin__sub">Cargando el registro…</p>}

        {entries !== null && entries.length === 0 && !loadError && (
          <p className="admin__sub">
            Todavía no hay nada del registro en el sistema. Cuando se importe, los animalitos van a
            aparecer aquí.
          </p>
        )}

        {entries !== null && entries.length > 0 && visible.length === 0 && (
          <p className="admin__sub">
            Nada coincide con lo que buscaste.
            {tab === 'resident' &&
              ' Prueba en «Buscar en todo el registro»: quizá ya estuvo aquí antes.'}
          </p>
        )}

        {visible.length > 0 && (
          <ul className="register-list">
            {visible.map((entry) => {
              const badge = STATUS_BADGE[entry.status];
              return (
                <li key={entry.no}>
                  <button type="button" className="register-row" onClick={() => openCandidate(entry)}>
                    {/* ALWAYS visible, never on hover: on two rows the register
                        names almost identically it is the only thing that tells
                        them apart, and a phone has no hover. */}
                    <span className="register-no">n.º {entry.no}</span>

                    <span className="register-row__text">
                      <strong className="register-row__name">{displayName(entry)}</strong>
                      <span className="t-data register-row__meta">
                        {sexText(entry.sex)} · {intakeText(entry)}
                        {entry.colourNote?.trim() && ` · ${entry.colourNote.trim()}`}
                      </span>
                    </span>

                    <span className="register-row__tags">
                      {badge && <span className="register-badge">{badge}</span>}
                      {unsettled.has(entry.no) && (
                        <span className="register-badge register-badge--unsure">Por confirmar</span>
                      )}
                      <span className="t-data">{rowStateText(entry)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* ⚠️ AT THE BOTTOM, and that placement is the point. First on the screen
          it becomes the path of least resistance, the roster stops being used,
          and every photographed animal gets a second record — which is the
          exact outcome this screen was built to prevent. */}
      <div className="register-new">
        <p className="admin__sub">
          ¿Lo buscaste y no está? Entonces es un animalito nuevo, que todavía nadie anotó en el
          registro.
        </p>
        <Link href="/admin/intake" className="btn btn--muted">
          No está en la lista — es un animalito nuevo
        </Link>
      </div>
    </div>
  );
}
