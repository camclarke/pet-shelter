/**
 * Source-level guarantees for the tappable history rows on an animal's
 * internal page, and for where deleting went.
 *
 * ── What these protect ────────────────────────────────────────────────────
 * Both history lists used to carry "Editar" and "Borrar" as full-size buttons
 * on every row, and `remove()` deleted on the FIRST click with no confirmation
 * of any kind. Measured at 360px against the real stylesheet, those two
 * buttons were 120px of a 262px row — 46% — and they wrapped and stacked, so
 * nine records came to 2358px. The row is now the tap target and opens the
 * record; deleting moved inside the editor behind a confirm that names it.
 *
 * ⚠️ The single most important assertion in this file is that tapping a row
 * calls the EDIT handler and not the delete handler. The project log records
 * these two buttons shipping flush together at a zero gap, "on a phone, where
 * a mis-tap deletes a medical record", and for the 43 imported animals the row
 * is the only copy of a history read off a handwritten sheet.
 *
 * Source-level because there is no component-test harness here and
 * `/admin/pets/{id}` sits behind `AdminGate`, which needs a password. Same
 * technique as `medical-wiring.test.ts` and `register-link.test.ts`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const MEDICAL = 'src/app/admin/pets/[petId]/MedicalPanel.tsx';
const MEASURE = 'src/app/admin/pets/[petId]/MeasurementPanel.tsx';
const DELETE_BTN = 'src/app/admin/pets/[petId]/DeleteRecordButton.tsx';
const CSS = 'src/app/globals.css';

/** CRLF-normalised, because this working tree is CRLF and the needles are LF. */
const read = (file: string) =>
  readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');

function between(source: string, from: string, to: string, what: string): string {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `${what}: could not find "${from}"`);
  const end = source.indexOf(to, start);
  assert.ok(end > start, `${what}: could not find "${to}" after "${from}"`);
  return source.slice(start, end);
}

/** The confirmed-history list only — NOT the candidate review queue above it. */
const medicalRows = () =>
  between(read(MEDICAL), '── the confirmed history', '{!open && (', 'the medical history rows');

/** The candidate review queue, which must keep its own buttons. */
const candidateRows = () =>
  between(read(MEDICAL), '{candidates.map((c) => {', '── the confirmed history', 'the review queue');

const measurementRows = () =>
  between(read(MEASURE), '{records.map((r) => {', '{!open && (', 'the measurement rows');

// ─────────────────────────────────────────────────────────────────────────────
// Tapping a row OPENS the record. It never deletes it.
// ─────────────────────────────────────────────────────────────────────────────

for (const [name, rows] of [
  ['medical', medicalRows],
  ['measurement', measurementRows],
] as const) {
  test(`tapping a ${name} history row opens the record`, () => {
    const block = rows();
    assert.match(
      block,
      /onClick=\{\(\) => startEdit\(r\)\}/,
      `a ${name} row no longer opens the record on tap`,
    );
    assert.match(
      block,
      /className="record-row__open"/,
      `the ${name} row is no longer the tap target`,
    );
  });

  test(`tapping a ${name} history row can never delete it`, () => {
    const block = rows();
    assert.equal(
      /remove\(/.test(block),
      false,
      `a ${name} row can reach the delete path again — this is the mis-tap that ` +
        'destroys an imported medical history, and there is no undo',
    );
  });

  test(`a ${name} history row carries no full-size buttons`, () => {
    const block = rows();
    assert.equal(
      /className="btn/.test(block),
      false,
      `a .btn is back on the ${name} rows — they were 46% of a 262px row at 360px, ` +
        'stacked, and nine records came to 2358px',
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The review queue is NOT a tappable row, and keeps its own decision
// ─────────────────────────────────────────────────────────────────────────────

test('the medical review queue keeps its own Confirmar and Descartar buttons', () => {
  const block = candidateRows();
  // Choosing between confirming a model's reading and discarding it is a
  // decision, not "open this". Flattening these rows to a single tap would
  // remove the review gate's whole point.
  assert.match(block, /t\.medicalReview\.confirm\b/, 'the review queue lost Confirmar');
  assert.match(block, /t\.medicalReview\.discard\b/, 'the review queue lost Descartar');
  assert.equal(
    /record-row__open/.test(block),
    false,
    'the review queue has been turned into tappable rows — Confirmar and Descartar are a ' +
      'two-way decision and must stay two controls',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Deleting: two steps, and it names what goes
// ─────────────────────────────────────────────────────────────────────────────

test('deleting a record takes two deliberate steps', () => {
  const src = read(DELETE_BTN);
  assert.match(src, /useState\(false\)/, 'the delete confirm lost its two-step state');
  // The first step may only arm the confirm — never call onDelete.
  const firstStep = between(src, 'if (!asking) {', 'return (\n    <div', 'the unconfirmed step');
  assert.match(firstStep, /setAsking\(true\)/, 'the first step no longer arms the confirm');
  assert.equal(
    /onDelete\(/.test(firstStep),
    false,
    'the first click deletes again — deleting must take a second, explicit confirmation',
  );
});

test('the delete confirm names the record it is about to destroy', () => {
  const src = read(DELETE_BTN);
  // An animal from the paper register can carry four octavalente rows, so
  // "¿Borrar este registro?" would not say WHICH one is going.
  assert.match(src, /¿Borrar «\{label\}»\?/, 'the delete confirm no longer names the record');
  assert.match(src, /No se puede deshacer/, 'the delete confirm no longer says it is final');
});

test('the delete confirm cannot carry over from one record to another', () => {
  // A `key` per record remounts the component, so a half-confirmed delete on
  // one record can never be completed against a different one. That is the
  // single unrecoverable failure mode here.
  for (const file of [MEDICAL, MEASURE]) {
    const src = read(file);
    const call = between(src, '<DeleteRecordButton', '/>', `${file}: the delete button`);
    assert.match(
      call,
      /key=\{/,
      `${file} renders DeleteRecordButton without a key — a half-confirmed delete could ` +
        'complete against a different record',
    );
    assert.match(call, /label=\{/, `${file} no longer tells the confirm what it is deleting`);
  }
});

test('deleting is offered only for a record that exists', () => {
  // Never while adding, and in MedicalPanel never for a candidate: a candidate
  // is discarded through the review gate, which records that a person rejected
  // a model's reading rather than erasing it silently.
  assert.match(
    read(MEDICAL),
    /editing\?\.kind === 'record' && \(\s*<DeleteRecordButton/,
    'MedicalPanel offers delete outside an open record — a candidate or a new record',
  );
  assert.match(
    read(MEASURE),
    /\{editingRecord && \(\s*<DeleteRecordButton/,
    'MeasurementPanel offers delete with no record resolved',
  );
});

test('a failed delete leaves the editor open so the message is visible', () => {
  for (const file of [MEDICAL, MEASURE]) {
    const body = between(read(file), 'async function remove(', '\n  }', `${file}: remove()`);
    const parts = body.split('} catch');
    assert.equal(parts.length, 2, `${file}: remove() has no catch, or more than one`);
    const head = parts[0] ?? '';
    const tail = parts[1] ?? '';
    assert.match(
      head,
      /setOpen\(false\)/,
      `${file}: remove() no longer closes the editor on success`,
    );
    // Closing in the catch or the finally would hide the failure behind a list
    // that still shows the record — which reads as "it deleted and came back".
    assert.equal(
      /setOpen\(false\)/.test(tail),
      false,
      `${file}: remove() closes the editor even when the delete FAILED, hiding the error`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The compaction is opt-in, because six other lists share the base class
// ─────────────────────────────────────────────────────────────────────────────

test('the compaction never touches the shared record-row styling', () => {
  const css = read(CSS);
  // `.admin-list__item--record` is used by the food screens, the applications
  // list and the medical review queue. Every rule for the tappable rows is
  // gated behind `.record-row`, so none of those can move.
  const shared = between(
    css,
    '.admin-list__item--record {',
    '.admin-list__actions {',
    'the shared record rules',
  );
  assert.equal(
    /record-row/.test(shared),
    false,
    'the tappable-row styling has leaked into .admin-list__item--record, which six other ' +
      'lists share',
  );
  assert.match(
    css,
    /\.admin-list__item--record\.record-row \{/,
    'the padding reset is no longer pinned to both classes — it now depends on source order',
  );
  assert.match(
    shared,
    /> div:first-child/,
    'the shared content rule has changed shape; the six other lists depend on it',
  );
});

test('the row tap target and the chevron keep their measured floors', () => {
  const css = read(CSS);
  const open = between(css, '.record-row__open {', '}', 'the row tap target');
  assert.match(open, /min-height: 44px;/, 'the row tap target lost its 44px floor');
  assert.match(open, /width: 100%;/, 'the tap target no longer fills the card');

  const go = between(css, '.record-row__go {', '}', 'the chevron');
  // 0.5 measured 2.61:1 on light paper, under WCAG 1.4.11's 3:1 for a
  // meaningful indicator. 0.75 measured 4.84:1.
  assert.match(
    go,
    /opacity: 0\.75;/,
    'the chevron opacity moved — at 0.5 it measured 2.61:1 on light paper, under the 3:1 ' +
      'floor for an indicator that tells someone the row opens',
  );
});
