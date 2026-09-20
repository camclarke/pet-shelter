/**
 * Source-level guarantees for the route to an UNPUBLISHED animal's medical
 * history.
 *
 * The register import wrote 178 medical records onto 43 drafts and published
 * nothing. For a day those records existed with no screen that could reach
 * them: `/admin/pets/{id}` rendered them correctly the whole time, and every
 * link in the product pointed somewhere else — the dashboard's draft rows at
 * the intake wizard, the roster only ever at a PUBLISHED pet, of which there
 * are none. These tests hold the two links that close that gap, and — the part
 * that matters more — the camera path those links now run through.
 *
 * ⚠️ Read this before "simplifying" anything here. The dashboard's draft row
 * points at the RECORD rather than at the wizard, so the photo session is
 * reached in two taps: row → PendingDraftPanel → "Tomar fotos y completar".
 * That makes the button inside PendingDraftPanel load-bearing in a way it was
 * not before. Deleting it no longer costs a convenience; it strands the photo
 * session, which is the whole point of the screen.
 *
 * Source-level because there is no component-test harness in this repo and
 * every screen involved sits behind `AdminGate`, which needs a password. Same
 * technique as `register-link.test.ts`, `medical-wiring.test.ts` and
 * `account-wiring.test.ts`, and for the same reason: PR #26 is the precedent —
 * `reviewSuggestion` computed a sex that the UI then threw away, with every
 * test in the suite green.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const DASHBOARD = 'src/app/admin/AdminDashboard.tsx';
const PANEL = 'src/app/admin/pets/[petId]/PetAdminPanel.tsx';
const ROSTER = 'src/app/admin/register/RegisterRoster.tsx';
const CSS = 'src/app/globals.css';

/** CRLF-normalised, because this working tree is CRLF and every needle is LF. */
const read = (file: string) =>
  readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');

/** The slice between two markers, asserting both are still there. */
function between(source: string, from: string, to: string, what: string): string {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `${what}: could not find "${from}"`);
  const end = source.indexOf(to, start);
  assert.ok(end > start, `${what}: could not find "${to}" after "${from}"`);
  return source.slice(start, end);
}

/** The body of a named function, up to the next top-level `}`. */
function functionBody(source: string, name: string): string {
  const at = source.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} is gone`);
  const end = source.indexOf('\n}', at);
  assert.ok(end > at, `could not find the end of ${name}`);
  return source.slice(at, end);
}

/** Only the "Fichas sin publicar" section, so a match cannot come from "Publicados". */
const draftSection = () =>
  between(read(DASHBOARD), 'Fichas sin publicar', 'Publicados', 'the dashboard draft section');

/** Only the fragment the confirm card renders for an already-linked row. */
const linkedBlock = () =>
  between(read(ROSTER), '{linked && (', '</>', 'the confirm card’s linked block');

// ─────────────────────────────────────────────────────────────────────────────
// The dashboard reaches the record
// ─────────────────────────────────────────────────────────────────────────────

test('an unpublished draft row leads to the record that holds its medical history', () => {
  assert.match(
    draftSection(),
    /href=\{`\/admin\/pets\/\$\{draft\.id\}`\}/,
    'the dashboard draft rows no longer reach /admin/pets/{id} — 36 of the 43 imported ' +
      'drafts carry a medical history, and this row is the only route to it from the panel',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// …and the record is still the way to the camera. The most valuable test here.
// ─────────────────────────────────────────────────────────────────────────────

test('the record screen is still the way to the camera', () => {
  const body = functionBody(read(PANEL), 'PendingDraftPanel');
  assert.match(
    body,
    /href=\{`\/admin\/intake\?draft=\$\{petId\}`\}/,
    'PendingDraftPanel no longer offers "Tomar fotos y completar". Since the dashboard ' +
      'draft rows point HERE rather than at the wizard, deleting this button strands the ' +
      'photo session — which is the one flow the shelter is actually about to run',
  );
});

test('the camera is the record screen’s primary action, not a secondary link', () => {
  const body = functionBody(read(PANEL), 'PendingDraftPanel');
  const camera = between(
    body,
    '/admin/intake?draft=',
    '</Link>',
    'the camera link on the draft panel',
  );
  assert.match(
    camera,
    /btn btn--action/,
    'the camera link has been demoted from btn--action. It is the one thing a volunteer ' +
      'holding an animal came to this screen to do',
  );
});

test('the draft branch still renders the history both links exist to show', () => {
  const body = functionBody(read(PANEL), 'PendingDraftPanel');
  assert.match(
    body,
    /<MedicalPanel\b/,
    'PendingDraftPanel no longer renders MedicalPanel — both new links now lead to a ' +
      'screen that does not show the imported records',
  );
  assert.match(
    body,
    /<MeasurementPanel\b/,
    'PendingDraftPanel no longer renders MeasurementPanel — a weight taken at a vet visit ' +
      'has nowhere to go until the animal is published',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// The register roster reaches the record
// ─────────────────────────────────────────────────────────────────────────────

test('the register card offers the record — and only when the row already has one', () => {
  // The slice IS the gating proof: `linkedBlock()` spans `{linked && (` to the
  // fragment's `</>`, so a link found inside it is a link an unlinked row
  // cannot render. That matters — `candidate.petId` is null for 182 of the
  // 225 rows, and an ungated link would offer `/admin/pets/null`.
  const block = linkedBlock();
  assert.match(
    block,
    /href=\{`\/admin\/pets\/\$\{candidate\.petId\}`\}/,
    'the confirm card no longer reaches the record — the only route left to an imported ' +
      'medical history is publishing the animal, which needs a photograph first',
  );
  assert.match(block, /Ver historial médico/, 'the confirm card’s record link lost its label');
});

test('opening a record from the register writes nothing', () => {
  const link = between(
    read(ROSTER),
    'register-match__record',
    '</Link>',
    'the confirm card’s record link',
  );
  // `go()` writes `petId` and a link confidence; `openOrCreateDraftForEntry`
  // MINTS a draft. Looking at a history must never decide that this row is
  // this animal — that decision belongs to "Sí, es esta".
  assert.equal(
    /onClick|go\(|openOrCreateDraftForEntry|markProvisional/.test(link),
    false,
    'reading a record has become an act that writes. A volunteer checking whether this is ' +
      'even the right animal would silently link the row by looking',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// The tap target, across the two files that have to agree
// ─────────────────────────────────────────────────────────────────────────────

test('the register card’s record link is a 44px tap target in the stylesheet', () => {
  assert.match(
    read(ROSTER),
    /className="auth__link register-match__record"/,
    'the record link lost `register-match__record`, the class that gives it a 44px target',
  );
  const rule = between(
    read(CSS),
    '.dossier__apply a,',
    'min-height: 44px;',
    'the shared 44px tap-target rule',
  );
  assert.match(
    rule,
    /\.register-match__record,/,
    'globals.css no longer gives .register-match__record a 44px height. An inline text ' +
      'link is ~20px, on a screen used one-handed with an animal in the other arm',
  );
});
