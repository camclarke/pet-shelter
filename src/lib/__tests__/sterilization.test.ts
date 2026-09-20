/**
 * "No" and "nobody wrote it down" are different answers.
 *
 * `sterilized` was a boolean, and the register importer set it from
 * `sterilizedPerRegister || sterilizedByEvent` — so a `false` meant the paper
 * had said nothing, which is not the claim "this animal is unaltered". 15 of
 * the 42 animals still in the shelter carry exactly that `false`.
 *
 * The 2022 ASV Guidelines §7.2 ask that "Sterilization status should be
 * documented for each animal", and carry one must: shelters doing
 * post-adoption sterilization "must have a system for keeping track of
 * unaltered animals". A two-state field can do neither honestly.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  countSterilization,
  needsAttention,
  sterilizationStatusOf,
} from '../sterilization';
import { buildImportPlan, type ImportPlanInput } from '../register-import';
import { draftDefaults } from '../intake';

const read = (file: string) =>
  readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');

// ─────────────────────────────────────────────────────────────────────────────
// The three states
// ─────────────────────────────────────────────────────────────────────────────

test('an unrecorded status is unknown, and never a claim that the animal is unaltered', () => {
  assert.equal(sterilizationStatusOf(true), 'sterilized');
  assert.equal(sterilizationStatusOf(false), 'not-sterilized');
  assert.equal(sterilizationStatusOf(null), 'unknown');
  // A document written before the field existed has no opinion either. If this
  // ever returned 'not-sterilized', every legacy record would start asserting
  // something nobody recorded.
  assert.equal(sterilizationStatusOf(undefined), 'unknown');
});

test('the unaltered list holds both "no" and "we do not know"', () => {
  // Different actions — book surgery vs go and check the card — but both are
  // animals the shelter cannot say are sterilized, which is what ASV §7.2's
  // tracking requirement is about.
  assert.equal(needsAttention(false), true);
  assert.equal(needsAttention(null), true);
  assert.equal(needsAttention(undefined), true);
  assert.equal(needsAttention(true), false);
});

test('the counts keep "no" and "unknown" apart while still totalling the list', () => {
  const c = countSterilization([true, true, false, null, undefined]);
  assert.deepEqual(c, { sterilized: 2, notSterilized: 1, unknown: 2, needsAttention: 3 });
});

// ─────────────────────────────────────────────────────────────────────────────
// A fresh draft knows nothing
// ─────────────────────────────────────────────────────────────────────────────

test('a new draft starts with no opinion about sterilization', () => {
  // `false` here would mean every animal begins life asserted to be unaltered,
  // and the intake form would have to be corrected rather than filled in.
  assert.equal(draftDefaults('draft-1').sterilized, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// The importer, tested through the real planner rather than by grep
// ─────────────────────────────────────────────────────────────────────────────

const BATCH = 'registro-test';
const TODAY = '2026-09-20';

function normalized(no: number, over: Record<string, unknown> = {}) {
  return {
    no,
    nameRaw: 'NUBE',
    displayName: 'Nube',
    hasRealName: true,
    aliasesInCell: [],
    litter: null,
    species: 'dog',
    speciesEvidence: 'INFERRED: tiene octavalente.',
    sex: 'female',
    intakeRaw: '12/03/24',
    intakeDate: '2024-03-12',
    dateNote: null,
    ageAtIntake: { raw: 'DE 2 ANOS', minMonths: 24, maxMonths: 24 },
    status: 'in-shelter',
    statusWhy: 'Fila sin color: sigue en el refugio.',
    statusDate: null,
    statusConflict: false,
    sterilizedPerRegister: false,
    lastRecordedDate: '2026-02-12',
    descriptors: { colour: [], coat: [], breedWords: [] },
    matchHints: {},
    flags: [],
    ...over,
  };
}

function event(over: Record<string, unknown> = {}) {
  return {
    type: 'deworming',
    column: 'deworming',
    date: '2025-06-10',
    precision: 'day',
    raw: '10/06/25',
    source: 'xlsx',
    status: 'confirmed',
    note: null,
    ...over,
  };
}

function planWith(over: Record<string, unknown>, events: unknown[] = [event()]) {
  const input: ImportPlanInput = {
    rows: [{ no: 1, xlsxRow: 4, colourStatus: 'SIN COLOR', cells: {} }],
    normalized: [normalized(1, over)],
    medical: { animals: [{ no: 1, name: 'Nube', events }], summary: {} },
    batch: BATCH,
    today: TODAY,
    draftIdFor: () => 'draft-1',
  };
  return buildImportPlan(input);
}

/** The one draft the plan produced. */
function draftOf(plan: ReturnType<typeof buildImportPlan>) {
  const drafts = (plan as unknown as { drafts: { data: { sterilized: unknown } }[] }).drafts;
  assert.equal(drafts.length, 1, 'expected exactly one draft in the plan');
  return drafts[0]!.data;
}

test('a register that says nothing about sterilization leaves it UNKNOWN', () => {
  // This is the defect. The first run wrote `false` here, so 15 animals ended
  // up recorded as unaltered on the strength of a blank cell.
  const draft = draftOf(planWith({ sterilizedPerRegister: false }));
  assert.equal(
    draft.sterilized,
    null,
    'the importer is asserting that an animal is unaltered because the paper was silent',
  );
  assert.notEqual(draft.sterilized, false);
});

test('a register that records a sterilization says so', () => {
  const draft = draftOf(planWith({ sterilizedPerRegister: true }));
  assert.equal(draft.sterilized, true);
});

test('a sterilization EVENT is enough on its own', () => {
  // The column can be blank while the medical sheet carries the surgery.
  const draft = draftOf(
    planWith({ sterilizedPerRegister: false }, [
      event({ type: 'sterilization', column: 'sterilization' }),
    ]),
  );
  assert.equal(draft.sterilized, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Wiring — the two screens, which have no component-test harness here
// ─────────────────────────────────────────────────────────────────────────────

test('the intake form asks the question three ways, not as a checkbox', () => {
  const src = read('src/app/admin/intake/IntakeWizard.tsx');
  // A checkbox cannot express "we do not know", and unticked meaning both "no"
  // and "unrecorded" is the whole defect.
  assert.equal(
    /type="checkbox"[\s\S]{0,200}draft\.sterilized/.test(src),
    false,
    'sterilization is back on a checkbox, so "no" and "nobody knows" are one state again',
  );
  assert.match(
    src,
    /value=\{toTristate\(draft\.sterilized\)\}/,
    'the intake form no longer offers the three states',
  );
  assert.match(
    src,
    /update\(\{ sterilized: fromTristate\(e\.target\.value\) \}\)/,
    'the intake form no longer saves the three states',
  );
});

test('the roster can list the animals nobody can call sterilized', () => {
  const src = read('src/app/admin/register/RegisterRoster.tsx');
  assert.match(
    src,
    /import \{ needsAttention \} from '@\/lib\/sterilization'/,
    'the roster no longer uses the shared rule for who is on the unaltered list',
  );
  // ⚠️ NOT a bare grep for `pendingSterilization`: that token appears in four
  // places, so deleting the state declaration still matched and the probe
  // caught nothing. Assert the three parts that actually have to be wired —
  // the predicate, the filter that applies it, and the control that turns it
  // on. Any one of them missing makes the chip decorative.
  assert.match(
    src,
    /const awaitingSterilization = useCallback\(/,
    'the roster lost the predicate that decides who is on the unaltered list',
  );
  assert.match(
    src,
    /if \(pendingSterilization && !awaitingSterilization\(entry\)\) return false;/,
    'the roster no longer FILTERS by the unaltered list — the chip would be decorative',
  );
  assert.match(
    src,
    /onClick=\{\(\) => setPendingSterilization\(\(on\) => !on\)\}/,
    'the roster chip no longer toggles the unaltered-animals filter',
  );
  // Built from the drafts the roster ALREADY reads — this must not become a
  // second Firestore read per row.
  assert.match(
    src,
    /setDraftSterilized\(new Map\(drafts\.map/,
    'the sterilization map is no longer derived from the existing drafts read',
  );
});
