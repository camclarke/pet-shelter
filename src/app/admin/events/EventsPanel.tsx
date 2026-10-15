/**
 * `/admin/events` — the list of events and the editor behind it.
 *
 * Everything is read and written CLIENT-SIDE through `firestore.rules`, whose
 * `events` block lets only an admin see drafts or write at all. A missing
 * claim therefore surfaces as `permission-denied`, which is the authorization
 * working, not a bug.
 *
 * ── Time ──────────────────────────────────────────────────────────────────
 * Every time on this screen — typed in, shown back, previewed — is the
 * SHELTER's wall clock (`SHELTER.timeZone`), whatever zone the phone is set
 * to. The conversion is `zoned-time.ts`; this file never calls
 * `new Date(inputValue)`, which would read the input in the device's zone.
 *
 * ── Publishing is its own tap ─────────────────────────────────────────────
 * Saving always keeps the event's published state as it was; a new event is
 * always a draft (the rules insist). Publishing happens from the list, because
 * a mistaken publish lingers in the CDN for minutes even after it is hidden —
 * and behind a second tap that names the event, as do cancelling a published
 * event and deleting a draft. While the editor is open the row actions are
 * disabled, so nothing in the list can drop unsaved edits.
 *
 * ── One `.btn--action` on screen ──────────────────────────────────────────
 * "+ Nuevo evento" while the list is showing; "Guardar" while the editor is
 * open. Never both.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import { useAuth } from '@/components/AuthProvider';
import { SHELTER } from '@/config/shelter';
import { t } from '@/i18n';
import {
  canDeleteEvent,
  duplicateEvent,
  emptyEventDraft,
  eventToDraft,
  groupEvents,
  nextStatus,
  validateEvent,
  type EventDraft,
  type EventView,
} from '@/lib/events';
import {
  EventIdExhaustedError,
  createEvent,
  deleteEvent,
  listEvents,
  setEventPublished,
  setEventStatus,
  updateEvent,
} from '@/lib/events-admin';
import { formatEventWhen, isUpcoming } from '@/lib/zoned-time';

const TZ = SHELTER.timeZone;
const copy = t.events;

type EditorMode =
  | { kind: 'new' }
  | { kind: 'duplicate' }
  | { kind: 'edit'; id: string; published: boolean };

/** The three row actions that wait for a second, named tap. */
type ConfirmKind = 'publish' | 'cancel' | 'delete';

function errorCode(caught: unknown): string | undefined {
  return (caught as { code?: string })?.code;
}

/**
 * An update met a document that is no longer what the screen showed: another
 * admin published, deleted or changed it, so the rules refused the write
 * (`permission-denied`) or there was nothing to update (`not-found`). That is
 * not a lost claim, and telling the admin to sign out would send them the
 * wrong way — reloading shows them what actually happened. A claim that
 * really is gone still surfaces, because the reload then fails on its own.
 */
function isStale(caught: unknown): boolean {
  const code = errorCode(caught);
  return code === 'permission-denied' || code === 'not-found';
}

function whenLabel(event: Pick<EventView, 'startsAt' | 'endsAt' | 'allDay'>): string {
  return formatEventWhen(event, TZ, SHELTER.locale);
}

export function EventsPanel() {
  const { user } = useAuth();

  const [events, setEvents] = useState<EventView[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [mode, setMode] = useState<EditorMode | null>(null);
  const [draft, setDraft] = useState<EventDraft>(emptyEventDraft());
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ id: string; kind: ConfirmKind } | null>(null);

  const load = useCallback(async () => {
    try {
      setEvents(await listEvents());
    } catch (caught) {
      console.error('[events] could not load', caught);
      setMessage(errorCode(caught) === 'permission-denied' ? copy.permissionDenied : copy.loadFailed);
      setEvents([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Read per render: the list and the warnings are cheap, and a screen left
  // open past midnight must move yesterday's event into "Pasados".
  const now = Date.now();
  const groups = groupEvents(events ?? [], now, TZ);
  const validation = validateEvent(draft, TZ, now);

  function open(next: EditorMode, nextDraft: EventDraft) {
    setMode(next);
    setDraft(nextDraft);
    setShowErrors(false);
    setMessage(null);
    setConfirming(null);
  }

  async function save() {
    setShowErrors(true);
    if (!validation.fields || !mode || !user) return;
    setSaving(true);
    setMessage(null);
    try {
      if (mode.kind === 'edit') await updateEvent(mode.id, validation.fields, user);
      else await createEvent(validation.fields, TZ, user);
      setMode(null);
      await load();
    } catch (caught) {
      console.error('[events] could not save', caught);
      if (mode.kind === 'edit' && isStale(caught)) {
        // The editor stays open so the admin's text is not lost; the list
        // underneath shows what the event is now.
        setMessage(copy.eventChanged);
        await load();
        return;
      }
      setMessage(
        caught instanceof EventIdExhaustedError
          ? copy.idExhausted
          : errorCode(caught) === 'permission-denied'
            ? copy.permissionDenied
            : copy.saveFailed,
      );
    } finally {
      setSaving(false);
    }
  }

  async function act(event: EventView, run: () => Promise<void>) {
    setConfirming(null);
    setBusyId(event.id);
    setMessage(null);
    try {
      await run();
      await load();
    } catch (caught) {
      console.error('[events] action failed', caught);
      if (isStale(caught)) {
        setMessage(copy.eventChanged);
        await load(); // a failing reload replaces the message with its own
      } else {
        setMessage(copy.actionFailed);
      }
    } finally {
      setBusyId(null);
    }
  }

  function remove(event: EventView) {
    if (!canDeleteEvent(event)) {
      setMessage(copy.deleteOnlyDrafts);
      return;
    }
    void act(event, () => deleteEvent(event));
  }

  // Publishing and cancelling a live event are public, so each waits for a
  // second tap that names the event — as does deleting, which cannot be
  // undone. Hiding and reactivating are the safe directions and run at once.
  // Not window.confirm: a browser told to block dialogs returns false and the
  // button would silently do nothing (see DeleteRecordButton.tsx).
  function confirmed(event: EventView, kind: ConfirmKind) {
    if (!user) return;
    if (kind === 'publish') void act(event, () => setEventPublished(event.id, true, user));
    else if (kind === 'cancel') void act(event, () => setEventStatus(event.id, 'cancelled', user));
    else remove(event);
  }

  const ask = (event: EventView, kind: ConfirmKind) => {
    setMessage(null);
    setConfirming({ id: event.id, kind });
  };

  const rowProps = (event: EventView) => ({
    event,
    now,
    busy: busyId === event.id,
    // While the editor is open every row action is off: opening another event
    // or publishing from the list would silently drop the unsaved edits.
    disabled: busyId !== null || saving || mode !== null,
    confirming: confirming?.id === event.id ? confirming.kind : null,
    onEdit: () => open({ kind: 'edit', id: event.id, published: event.published }, eventToDraft(event, TZ)),
    onDuplicate: () => open({ kind: 'duplicate' }, duplicateEvent(event)),
    onTogglePublished: () =>
      event.published
        ? user && void act(event, () => setEventPublished(event.id, false, user))
        : ask(event, 'publish'),
    onToggleStatus: () =>
      event.status === 'scheduled' && event.published
        ? ask(event, 'cancel')
        : user && void act(event, () => setEventStatus(event.id, nextStatus(event.status), user)),
    onDelete: () => ask(event, 'delete'),
    onConfirm: (kind: ConfirmKind) => confirmed(event, kind),
    onConfirmNo: () => setConfirming(null),
  });

  return (
    <div className="admin">
      <header className="admin__header">
        <div>
          <h1 className="t-title">{copy.screenTitle}</h1>
          <p className="admin__sub">{copy.screenIntro}</p>
        </div>
        <div className="admin__header-actions">
          <Link href="/admin" className="btn btn--muted">
            {copy.backToPanel}
          </Link>
          {mode === null && (
            <button
              type="button"
              className="btn btn--action"
              onClick={() => open({ kind: 'new' }, emptyEventDraft())}
            >
              {copy.newEvent}
            </button>
          )}
        </div>
      </header>

      {message && (
        <p className="auth__error" role="alert">
          {message}
        </p>
      )}

      {mode !== null && (
        <EventEditor
          mode={mode}
          draft={draft}
          validation={validation}
          showErrors={showErrors}
          saving={saving}
          onChange={setDraft}
          onClose={() => setMode(null)}
          onSave={save}
        />
      )}

      {events === null && <p className="admin__sub">{copy.loading}</p>}

      {events?.length === 0 && mode === null && !message && (
        <div className="auth__notice">
          <p>{copy.emptyList}</p>
        </div>
      )}

      {(
        [
          [copy.groupDrafts, groups.drafts],
          [copy.groupUpcoming, groups.upcoming],
          [copy.groupPast, groups.past],
        ] as const
      ).map(([heading, list]) =>
        list.length === 0 ? null : (
          <section key={heading} className="admin-list">
            <h2 className="t-label">{heading}</h2>
            <ul className="admin-list__items">
              {list.map((event) => (
                <EventRow key={event.id} {...rowProps(event)} />
              ))}
            </ul>
          </section>
        ),
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function EventRow({
  event,
  now,
  busy,
  disabled,
  onEdit,
  onDuplicate,
  onTogglePublished,
  onToggleStatus,
  onDelete,
  confirming,
  onConfirm,
  onConfirmNo,
}: {
  event: EventView;
  now: number;
  busy: boolean;
  disabled: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onTogglePublished: () => void;
  onToggleStatus: () => void;
  onDelete: () => void;
  confirming: ConfirmKind | null;
  onConfirm: (kind: ConfirmKind) => void;
  onConfirmNo: () => void;
}) {
  const past = !isUpcoming(event.endsAt, now, TZ);
  const state = !event.published ? 'draft' : past ? 'past' : 'published';
  const stateLabel = { draft: copy.stateDraft, past: copy.statePast, published: copy.statePublished }[state];

  if (confirming) {
    const question = {
      publish: copy.publishConfirm,
      cancel: copy.cancelConfirm,
      delete: copy.deleteConfirm,
    }[confirming](event.title);
    const yes = { publish: copy.confirmPublish, cancel: copy.confirmCancel, delete: copy.confirmDelete }[confirming];
    return (
      <li className="admin-list__item--record">
        {/* Same block and reasoning as DeleteRecordButton: it names the event,
            because on a phone the row above or below is one slip away. Not
            autofocused and outside any form, so Enter confirms nothing. */}
        <div className="register-warning event-confirm" role="alert">
          <p>{question}</p>
          <div className="admin-list__actions">
            <button
              type="button"
              className="btn btn--muted"
              disabled={disabled}
              onClick={() => onConfirm(confirming)}
            >
              {yes}
            </button>
            <button type="button" className="auth__link" disabled={disabled} onClick={onConfirmNo}>
              {copy.confirmNo}
            </button>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className="admin-list__item--record">
      <div>
        <p className="event-row__chips">
          <span className={`event-state event-state--${state}`}>{stateLabel}</span>
          {event.status === 'cancelled' && (
            <span className="event-state event-state--cancelled">{copy.stateCancelled}</span>
          )}
        </p>
        <strong>{event.title}</strong>
        <span className="t-data">{whenLabel(event)}</span>
        <span className="admin__sub">
          {event.placeName}
          {event.address ? ` · ${event.address}` : ''}
        </span>
      </div>
      <div className="admin-list__actions" aria-busy={busy}>
        <button
          type="button"
          className="btn btn--muted btn--compact"
          onClick={onTogglePublished}
          disabled={disabled}
        >
          {event.published ? copy.unpublish : copy.publish}
        </button>
        <button type="button" className="auth__link" onClick={onEdit} disabled={disabled}>
          {copy.edit}
        </button>
        <button type="button" className="auth__link" onClick={onDuplicate} disabled={disabled}>
          {copy.duplicate}
        </button>
        <button type="button" className="auth__link" onClick={onToggleStatus} disabled={disabled}>
          {event.status === 'cancelled' ? copy.reactivate : copy.cancelEvent}
        </button>
        {canDeleteEvent(event) && (
          <button type="button" className="auth__link" onClick={onDelete} disabled={disabled}>
            {copy.delete}
          </button>
        )}
      </div>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function EventEditor({
  mode,
  draft,
  validation,
  showErrors,
  saving,
  onChange,
  onClose,
  onSave,
}: {
  mode: EditorMode;
  draft: EventDraft;
  validation: ReturnType<typeof validateEvent>;
  showErrors: boolean;
  saving: boolean;
  onChange: (draft: EventDraft) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const heading =
    mode.kind === 'edit' ? copy.editorEdit : mode.kind === 'duplicate' ? copy.editorDuplicate : copy.editorNew;
  const zone = copy.timeZoneNote(SHELTER.country);
  const inputType = draft.allDay ? 'date' : 'datetime-local';

  function setAllDay(allDay: boolean) {
    // Timed → all day keeps the dates. All day → timed clears them: a
    // datetime-local needs an hour, and inventing one would be a confident
    // wrong value.
    onChange({
      ...draft,
      allDay,
      start: allDay ? draft.start.slice(0, 10) : '',
      end: allDay ? draft.end.slice(0, 10) : '',
    });
  }

  // A datetime-local can report seconds if a value with seconds was ever set;
  // the converter takes "YYYY-MM-DDTHH:mm" exactly.
  const timeValue = (value: string) => (draft.allDay ? value : value.slice(0, 16));

  const preview = validation.fields
    ? copy.preview(
        formatEventWhen(validation.fields, TZ, SHELTER.locale),
        draft.allDay ? null : SHELTER.country,
      )
    : null;

  return (
    <form
      className="admin-form event-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <h2 className="t-label">{heading}</h2>
      {mode.kind === 'duplicate' && <p className="auth__hint">{copy.duplicateNote}</p>}

      <label className="auth__field">
        <span>{copy.fieldTitle}</span>
        <input
          value={draft.title}
          onChange={(e) => onChange({ ...draft, title: e.target.value })}
          placeholder={copy.titlePlaceholder}
          autoFocus
        />
      </label>

      <div className="admin-form__row">
        <label className="auth__field">
          <span>{copy.fieldPlace}</span>
          <input
            value={draft.placeName}
            onChange={(e) => onChange({ ...draft, placeName: e.target.value })}
            placeholder={copy.placePlaceholder}
          />
        </label>
        <label className="auth__field">
          <span>{copy.fieldAddress}</span>
          <input
            value={draft.address}
            onChange={(e) => onChange({ ...draft, address: e.target.value })}
            placeholder={copy.addressPlaceholder}
          />
        </label>
      </div>
      <p className="auth__hint">{copy.placeHint}</p>

      <label className="admin-form__check">
        <input type="checkbox" checked={draft.allDay} onChange={(e) => setAllDay(e.target.checked)} />
        <span>{copy.fieldAllDay}</span>
      </label>

      <div className="admin-form__row">
        <label className="auth__field">
          <span>
            {draft.allDay ? copy.fieldStartDay : copy.fieldStart}
            {!draft.allDay && ` · ${zone}`}
          </span>
          <input
            type={inputType}
            value={draft.start}
            onChange={(e) => onChange({ ...draft, start: timeValue(e.target.value) })}
          />
        </label>
        <label className="auth__field">
          <span>
            {draft.allDay ? copy.fieldEndDay : copy.fieldEnd}
            {!draft.allDay && ` · ${zone}`}
          </span>
          <input
            type={inputType}
            value={draft.end}
            onChange={(e) => onChange({ ...draft, end: timeValue(e.target.value) })}
          />
        </label>
      </div>
      <p className="auth__hint">{copy.endOptional}</p>
      {preview && <p className="auth__notice">{preview}</p>}

      <label className="auth__field">
        <span>{copy.fieldDescription}</span>
        <textarea
          value={draft.description}
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
          placeholder={copy.descriptionPlaceholder}
          rows={5}
        />
      </label>

      {validation.warnings.length > 0 && (
        <div className="auth__notice auth__notice--warn">
          {validation.warnings.map((warning) => (
            <p key={warning}>{copy.warning(warning)}</p>
          ))}
        </div>
      )}

      {showErrors && validation.errors.length > 0 && (
        <ul className="admin-errors" role="alert">
          {validation.errors.map((error) => (
            <li key={error}>{copy.error(error)}</li>
          ))}
        </ul>
      )}

      <p className="auth__hint">
        {mode.kind === 'edit' && mode.published ? copy.liveNote : copy.draftNote}
      </p>

      <div className="admin__footer">
        <div className="admin__footer-left">
          <button type="button" className="auth__link" onClick={onClose} disabled={saving}>
            {copy.cancelEdit}
          </button>
        </div>
        <div className="admin__footer-right">
          <button type="submit" className="btn btn--action" disabled={saving}>
            {saving ? copy.saving : mode.kind === 'edit' ? copy.saveChanges : copy.saveDraft}
          </button>
        </div>
      </div>
    </form>
  );
}
