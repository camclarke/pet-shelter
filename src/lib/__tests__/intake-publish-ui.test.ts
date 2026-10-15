/**
 * Why "Publicar" cannot publish yet — and where to fix it.
 *
 * Until 2026-10-15 a blocked Publicar looked exactly like a working one, the
 * reasons sat in a closed list, and no field said it was the one missing.
 * Three things changed, and each is pinned here:
 *
 *   1. `INTAKE_ERROR_FIELD` sends every blocker to the part of the form that
 *      fixes it, and every part it names is one the wizard renders.
 *   2. The marks wait for publish intent — a tap on Publicar, or «Disponible»
 *      — so the register path (a name and one photo, PR #74) stays calm.
 *   3. The button is `aria-disabled`, not `disabled`, while blocked, and says
 *      how much is missing; a footer line says whether the page reaches the
 *      wall.
 *
 * The wiring tests read the wizard as TEXT, comments stripped: there is no
 * component-test setup and the page sits behind the admin login.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  blockersForField,
  draftDefaults,
  firstBlockingField,
  hasPublishIntent,
  INTAKE_ERROR_FIELD,
  INTAKE_FIELD_STEP,
  INTAKE_FIELDS_IN_MORE,
  publishBlockers,
  publishButtonFace,
  registerBlockers,
  type DraftMedia,
  type IntakeError,
  type PetDraft,
} from '../intake';
import type { PetStatus } from '../types';
import { es } from '@/i18n/es';

function source(file: string): string {
  return readFileSync(join(process.cwd(), file), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const WIZARD = source('src/app/admin/intake/IntakeWizard.tsx');
const FIELD = source('src/app/admin/intake/EditableField.tsx');
const INTAKE = source('src/lib/intake.ts');

const ALL_STATUSES: PetStatus[] = [
  'inbound',
  'quarantine',
  'shelter',
  'foster',
  'available',
  'adopted',
  'lost',
  'cancelled',
];

function photo(overrides: Partial<DraftMedia> = {}): DraftMedia {
  return {
    id: 'm1',
    slot: 'front',
    path: 'pets/p1/cover.jpg',
    url: 'https://firebasestorage.googleapis.com/v0/b/wawitas-app/o/pets%2Fp1%2Fcover.jpg',
    alt: '',
    width: 1200,
    height: 1600,
    ...overrides,
  };
}

/** The `IntakeError` union, read from source so a new code cannot hide. */
function intakeErrorCodes(): string[] {
  const start = INTAKE.indexOf('export type IntakeError =');
  const end = INTAKE.indexOf(';', start);
  assert.ok(start >= 0 && end > start, 'IntakeError union not found');
  const codes = [...INTAKE.slice(start, end).matchAll(/\|\s*'([a-z-]+)'/g)].map((m) => m[1]!);
  // The parser is the instrument: prove it read something real before a
  // matching count is allowed to mean "covered".
  assert.ok(codes.includes('name-required') && codes.includes('alt-required'), 'parser read the union');
  assert.ok(codes.length >= 12, `expected at least 12 codes, read ${codes.length}`);
  return codes;
}

/** Every key the wizard wires as a row or a section. */
function renderedKeys(): Map<string, number> {
  const keys = new Map<string, number>();
  for (const m of WIZARD.matchAll(/(?:fieldProps|sectionProps)\('(\w+)'\)/g)) {
    if (!keys.has(m[1]!)) keys.set(m[1]!, m.index!);
  }
  assert.ok(keys.has('name') && keys.has('status'), 'parser found the wizard rows');
  return keys;
}

// ─── the map ──────────────────────────────────────────────────────────────────

test('every IntakeError has a field, and the map holds nothing else', () => {
  assert.deepEqual(Object.keys(INTAKE_ERROR_FIELD).sort(), intakeErrorCodes().sort());
});

test('every field the map names is rendered by the wizard', () => {
  const keys = renderedKeys();
  for (const [code, field] of Object.entries(INTAKE_ERROR_FIELD)) {
    assert.ok(keys.has(field), `${code} points at "${field}", which the wizard never renders`);
  }
});

test('every field has a step, and the field is rendered on that step', () => {
  const keys = renderedKeys();
  const identity = WIZARD.indexOf("{step === 'identity' && (");
  const media = WIZARD.indexOf("{step === 'media' && (");
  const story = WIZARD.indexOf("{step === 'story' && (");
  assert.ok(identity >= 0 && media > identity && story > media, 'step sections found in order');
  assert.deepEqual(
    Object.keys(INTAKE_FIELD_STEP).sort(),
    [...new Set(Object.values(INTAKE_ERROR_FIELD))].sort(),
    'the step table and the error map name the same fields',
  );
  for (const [field, step] of Object.entries(INTAKE_FIELD_STEP)) {
    const at = keys.get(field)!;
    const [from, to] = step === 'identity' ? [identity, media] : [media, story];
    assert.ok(at > from && at < to, `"${field}" must render inside the ${step} step`);
  }
});

test('the fields marked as inside "Más datos" are the ones inside it, and only those', () => {
  const keys = renderedKeys();
  const more = WIZARD.indexOf('t.intakeForm.moreSummary');
  const media = WIZARD.indexOf("{step === 'media' && (");
  assert.ok(more >= 0 && media > more);
  for (const field of Object.keys(INTAKE_FIELD_STEP)) {
    const at = keys.get(field)!;
    const inside = at > more && at < media;
    assert.equal(
      INTAKE_FIELDS_IN_MORE.has(field as never),
      inside,
      `"${field}" ${inside ? 'is' : 'is not'} inside the collapsed section`,
    );
  }
});

test('blockers find their fields, in gate order', () => {
  const blockers: IntakeError[] = ['species-required', 'age-range', 'alt-required'];
  assert.equal(firstBlockingField(blockers), 'species');
  assert.equal(firstBlockingField(['alt-required']), 'photoAlt');
  assert.equal(firstBlockingField([]), null);
  assert.deepEqual(blockersForField(blockers, 'age'), ['age-range']);
  assert.deepEqual(blockersForField(['microchip-required', 'microchip-conflict'], 'microchip'), [
    'microchip-required',
    'microchip-conflict',
  ]);
  assert.deepEqual(blockersForField(blockers, 'name'), []);
});

// ─── publish intent ───────────────────────────────────────────────────────────

test('publish intent is a tap on Publicar, or «Disponible» — nothing else', () => {
  for (const status of ALL_STATUSES) {
    assert.equal(hasPublishIntent(false, status), status === 'available', status);
    assert.equal(hasPublishIntent(true, status), true, status);
  }
});

test('a fresh intake has no publish intent, so registering stays calm', () => {
  // The register path of PR #74: a name and one photo, nothing else.
  const draft: PetDraft = { ...draftDefaults('p1'), name: 'Luna', media: [photo()] };
  assert.deepEqual(registerBlockers(draft), []);
  assert.equal(draft.status, 'shelter');
  assert.equal(hasPublishIntent(false, draft.status), false);
  // Control: the same draft is far from publishable, so without the intent
  // gate the screen WOULD be marking fields here.
  assert.ok(publishBlockers(draft).length >= 5);
});

test('the marks are gated on publish intent in the wizard', () => {
  assert.ok(/const publishIntent = hasPublishIntent\(publishTapped, draft\.status\)/.test(WIZARD));
  const problemFor = WIZARD.slice(WIZARD.indexOf('function problemFor('));
  assert.ok(/^function problemFor\([^)]*\)[^{]*\{\s*if \(!publishIntent\) return undefined;/.test(problemFor));
  // The list opens on intent, and only takes its own state once touched.
  assert.ok(/const publishListIsOpen = publishListOpen \?\? publishIntent/.test(WIZARD));
  assert.ok(/open=\{publishListIsOpen\}/.test(WIZARD));
});

// ─── the button ───────────────────────────────────────────────────────────────

test('Publicar is aria-disabled while blocked, never disabled by the blockers', () => {
  const at = WIZARD.indexOf('onClick={handlePublishTap}');
  assert.ok(at >= 0, 'the footer button calls handlePublishTap');
  const button = WIZARD.slice(WIZARD.lastIndexOf('<button', at), WIZARD.indexOf('</button>', at));
  assert.ok(/disabled=\{busy \|\| !user\}/.test(button), 'real disabled is for busy and signed-out only');
  assert.ok(/aria-disabled=\{blockers\.length > 0 \? 'true' : undefined\}/.test(button));
  assert.ok(/aria-describedby=\{/.test(button));
  assert.ok(button.includes('PUBLISH_BLOCKERS_ID') && button.includes('PUBLISH_STATUS_ID'));
  assert.ok(/t\.intakeForm\.publishAction\(publishFace\)/.test(button));
  // Nowhere may the blockers set `disabled` — that is the silent dead button.
  // (`aria-disabled` is the intended one, hence the lookbehind.)
  assert.equal(/(?<!aria-)disabled=\{[^}]*blockers\.length/.test(WIZARD), false);
  // Control: the same pattern without the lookbehind does see aria-disabled,
  // so a false above is the code, not a blind regex.
  assert.ok(/disabled=\{[^}]*blockers\.length/.test(WIZARD));
  // The ids the button names exist on the list and the status line.
  assert.ok(/id=\{PUBLISH_BLOCKERS_ID\}/.test(WIZARD));
  assert.ok(/id=\{PUBLISH_STATUS_ID\}/.test(WIZARD));
});

test('a blocked tap sets intent, opens the list and goes to the first field', () => {
  const tap = WIZARD.slice(WIZARD.indexOf('function handlePublishTap()'));
  const body = tap.slice(0, tap.indexOf('void handlePublish();'));
  for (const needle of [
    'if (blockers.length > 0)',
    'setPublishTapped(true)',
    'setPublishListOpen(true)',
    'INTAKE_ERROR_FIELD',
    'firstBlockingField(blockers)',
    'revealField(first)',
    'return;',
  ]) {
    assert.ok(body.includes(needle), `handlePublishTap is missing ${needle}`);
  }
  // Each list item is a way to its field.
  assert.ok(/onClick=\{\(\) => revealField\(INTAKE_ERROR_FIELD\[code\]\)\}/.test(WIZARD));
});

test('revealing a field respects the one-open-editor rule', () => {
  const reveal = WIZARD.slice(WIZARD.indexOf('function revealField('));
  const body = reveal.slice(0, reveal.indexOf('\n  }\n'));
  assert.ok(/setOpenField\(isSection \? null : key\)/.test(body), 'one editor, set rather than toggled');
  assert.ok(body.includes('INTAKE_FIELD_STEP[key]') && body.includes('goToStep(target)'));
  assert.ok(body.includes('INTAKE_FIELDS_IN_MORE.has(key)') && body.includes('setMoreOpen(true)'));
  assert.ok(body.includes('setScrollTarget(key)'));
});

test('the button face counts what is missing and says where it publishes', () => {
  assert.deepEqual(publishButtonFace(3, 'available'), { kind: 'blocked', missing: 3 });
  assert.deepEqual(publishButtonFace(1, 'shelter'), { kind: 'blocked', missing: 1 });
  assert.deepEqual(publishButtonFace(0, 'available'), { kind: 'wall' });
  for (const status of ALL_STATUSES.filter((s) => s !== 'available')) {
    assert.deepEqual(publishButtonFace(0, status), { kind: 'off-wall' }, status);
  }

  const say = es.intakeForm.publishAction;
  assert.equal(say({ kind: 'blocked', missing: 1 }), 'Publicar · falta 1');
  assert.equal(say({ kind: 'blocked', missing: 2 }), 'Publicar · faltan 2');
  assert.equal(say({ kind: 'blocked', missing: 9 }), 'Publicar · faltan 9');
  assert.equal(say({ kind: 'wall' }), 'Publicar en el muro');
  assert.equal(say({ kind: 'off-wall' }), 'Publicar sin mostrar en el muro');
});

// ─── the status line ──────────────────────────────────────────────────────────

test('the footer always says whether publishing reaches the wall', () => {
  assert.equal(es.intakeForm.publishOnWall, 'Al publicar, aparece en el muro de adopción.');
  assert.equal(
    es.intakeForm.publishOffWall('En el refugio').join(''),
    'Estado «En el refugio»: al publicar, su página existe pero no aparece en el muro. Para el muro, elige «Disponible».',
  );
  assert.equal(es.intakeForm.publishOffWall('En el refugio')[1], 'no aparece en el muro');
  assert.equal(es.intakeForm.switchToAvailable, 'Cambiar a Disponible');

  // Inside the footer, and outside every `blockers.length > 0 &&` branch, so
  // it shows whether or not anything is missing.
  const footer = WIZARD.slice(WIZARD.indexOf('<footer className="admin__footer admin__footer--intake">'));
  assert.ok(footer.length > 0);
  const line = footer.slice(0, footer.indexOf('admin__footer-left'));
  assert.ok(line.includes('className="intake-publish-status"'));
  assert.equal(line.includes('blockers.length'), false, 'the status line must not depend on blockers');
  assert.ok(line.includes('t.intakeForm.publishOnWall'));
  assert.ok(line.includes('t.intakeForm.publishOffWall') || /offWallParts\[1\]/.test(line));
  assert.ok(/onClick=\{\(\) => update\(\{ status: 'available' \}\)\}/.test(line));
  assert.ok(/t\.intakeForm\.publishOffWall\(t\.statusLabel\(draft\.status\)\)/.test(WIZARD));
});

// ─── the row ──────────────────────────────────────────────────────────────────

test('a row with a problem is marked, invalid and described by its reason', () => {
  assert.ok(/'field-row field-row--problem'/.test(FIELD));
  assert.ok(/aria-invalid=\{hasProblem \? 'true' : undefined\}/.test(FIELD));
  assert.ok(/aria-describedby=\{hasProblem \? problemId : undefined\}/.test(FIELD));
  assert.ok(/<FieldProblem id=\{problemId\}>\{problem\}<\/FieldProblem>/.test(FIELD));
  assert.ok(/className="field-problem__mark" aria-hidden="true"/.test(FIELD));
  // The wizard hands rows their problem through fieldProps, never ad hoc.
  const props = WIZARD.slice(WIZARD.indexOf('function fieldProps('));
  assert.ok(/problem: isIntakeFieldKey\(key\) \? problemFor\(key\) : undefined/.test(props.slice(0, 600)));
});
