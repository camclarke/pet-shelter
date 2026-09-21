/**
 * The AAHA 2019 canine spay/neuter chart, evaluated over what intake knows.
 *
 * Every threshold in these tests is a LITERAL. A test that compares the
 * function against the constant it reads can never fail — the 2026-08-27
 * rabies 21-day assertion is this project's recorded instance of that — so
 * 5, 6, 9, 15 and 20 are pinned here in the numbers the chart prints.
 *
 * The chart (https://www.aaha.org/wp-content/uploads/globalassets/02-guidelines/canine-life-stage-2019/caninelifestage_spayneuter.pdf):
 *   male   < 20 kg  "Neuter at 6 months of age"
 *   male   > 20 kg  "Neuter after growth stops (9–15 months of age)"
 *   female < 20 kg  "Spay before first heat cycle (5–6 months of age)"
 *   female > 20 kg  "Spay between 5-15 months of age" — two COMPETING options
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  ageRangeToday,
  bandConflict,
  normalizeAgeRange,
  sterilizationTiming,
  type TimingInput,
  type TimingResult,
} from '../sterilization-timing';
import { heaviestWeight, latestWeight } from '../measurements';
import { draftDefaults } from '../intake';
import { es } from '@/i18n/es';

const read = (file: string) =>
  readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');

function dog(over: Partial<TimingInput>): TimingInput {
  return { species: 'dog', sex: 'male', ageMonthsMin: 12, ageMonthsMax: 12, band: null, ...over };
}

const at = (months: number) => ({ ageMonthsMin: months, ageMonthsMax: months });

/**
 * The options flag, or null for a refusal.
 *
 * A helper rather than an inline `r.kind !== 'refused' && r.femaleOptions`:
 * `assert.equal` carries an `asserts actual is T` signature, so after
 * `assert.equal(r.kind, 'act-now')` TypeScript narrows the kind and the inline
 * guard becomes a type error. `npm test` cannot see that — tsx does not
 * typecheck — and it only surfaced in `tsc --noEmit`.
 */
const optionsOf = (r: TimingResult): boolean | null => (r.kind === 'refused' ? null : r.femaleOptions);

// ─────────────────────────────────────────────────────────────────────────────
// The four cells, with the band known
// ─────────────────────────────────────────────────────────────────────────────

test('male under 20 kg: the chart says "at 6 months"', () => {
  assert.equal(sterilizationTiming(dog({ sex: 'male', band: 'under-20kg', ...at(6) })).kind, 'act-now');
  assert.equal(sterilizationTiming(dog({ sex: 'male', band: 'under-20kg', ...at(5.99) })).kind, 'early');
  assert.equal(sterilizationTiming(dog({ sex: 'male', band: 'under-20kg', ...at(30) })).kind, 'act-now');
});

test('male over 20 kg: "after growth stops (9–15 months)"', () => {
  assert.equal(sterilizationTiming(dog({ sex: 'male', band: 'over-20kg', ...at(8.99) })).kind, 'early');
  assert.equal(sterilizationTiming(dog({ sex: 'male', band: 'over-20kg', ...at(9) })).kind, 'act-now');
  assert.equal(sterilizationTiming(dog({ sex: 'male', band: 'over-20kg', ...at(15) })).kind, 'act-now');
  assert.equal(sterilizationTiming(dog({ sex: 'male', band: 'over-20kg', ...at(40) })).kind, 'act-now');
});

test('female under 20 kg: "before first heat cycle (5–6 months)"', () => {
  assert.equal(sterilizationTiming(dog({ sex: 'female', band: 'under-20kg', ...at(4.99) })).kind, 'early');
  assert.equal(sterilizationTiming(dog({ sex: 'female', band: 'under-20kg', ...at(5) })).kind, 'act-now');
  assert.equal(sterilizationTiming(dog({ sex: 'female', band: 'under-20kg', ...at(24) })).kind, 'act-now');
});

test('female over 20 kg keeps its competing options while the choice is live', () => {
  // The chart splits this cell into two OPPOSING recommendations and refuses to
  // choose. Collapsing it to one neutral date would make the screen less
  // accurate than the document it cites — so the note must travel with it.
  const young = sterilizationTiming(dog({ sex: 'female', band: 'over-20kg', ...at(10) }));
  assert.equal(optionsOf(young), true, 'the competing options were dropped');
  assert.equal(young.kind, 'act-now');

  const puppy = sterilizationTiming(dog({ sex: 'female', band: 'over-20kg', ...at(3) }));
  assert.equal(optionsOf(puppy), true, 'a puppy lost the options note');
  assert.equal(puppy.kind, 'early');

  // Past 15 months both options are behind her, and the note would be noise.
  const adult = sterilizationTiming(dog({ sex: 'female', band: 'over-20kg', ...at(30) }));
  assert.equal(optionsOf(adult), false, 'an adult female still shows the choice');
});

test('a male never carries the female options note', () => {
  const r = sterilizationTiming(dog({ sex: 'male', band: 'over-20kg', ...at(10) }));
  assert.equal(optionsOf(r), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// The band unknown — every branch the uncertainty still allows
// ─────────────────────────────────────────────────────────────────────────────

test('an unknown band only matters when the two sides disagree', () => {
  // A six-month-old male: under 20 kg says now, over 20 kg says later. Only
  // the band would settle it, so that is what the result asks for.
  const r = sterilizationTiming(dog({ sex: 'male', band: null, ...at(6) }));
  assert.deepEqual(r, { kind: 'depends', on: 'band', femaleOptions: false });

  // An adult: past every window on both sides, so the band changes nothing.
  assert.equal(sterilizationTiming(dog({ sex: 'male', band: null, ...at(40) })).kind, 'act-now');
});

test('a vague age that lands the same way on every reading still answers', () => {
  // 24 to 48 months is vague, but its MINIMUM is past every window in the
  // chart — so the vagueness decides nothing. Width alone must not refuse.
  const r = sterilizationTiming(dog({ sex: 'female', band: null, ageMonthsMin: 24, ageMonthsMax: 48 }));
  assert.equal(r.kind, 'act-now');
});

test('an age that straddles the windows asks for a better AGE, not a band', () => {
  // Knowing the band would not help: on both sides the range still spans
  // "before" and "after". Asking for the band would send someone the wrong way.
  const r = sterilizationTiming(dog({ sex: 'female', band: null, ageMonthsMin: 4, ageMonthsMax: 26 }));
  assert.equal(r.kind, 'depends');
  assert.ok(r.kind === 'depends' && r.on === 'age');
});

// ─────────────────────────────────────────────────────────────────────────────
// The shelter's own animals, measured 2026-09-21 (band unknown for all of them)
// ─────────────────────────────────────────────────────────────────────────────

test('the eight unsterilized residents with a usable age come out as measured', () => {
  // Read-only query of registerEntries, 2026-09-21. Seven of the eight give the
  // same answer on both sides of 20 kg; the band decides only n.º 222.
  const cases: [string, TimingInput, TimingResult][] = [
    ['211 Foxy F 13', dog({ sex: 'female', ...at(13) }), { kind: 'act-now', femaleOptions: true }],
    ['214 Blacky M 13', dog({ sex: 'male', ...at(13) }), { kind: 'act-now', femaleOptions: false }],
    ['218 Américo M 121', dog({ sex: 'male', ...at(121) }), { kind: 'act-now', femaleOptions: false }],
    ['219 Agustina F 19', dog({ sex: 'female', ...at(19) }), { kind: 'act-now', femaleOptions: false }],
    ['222 Panchito M 6', dog({ sex: 'male', ...at(6) }), { kind: 'depends', on: 'band', femaleOptions: false }],
    [
      '223 Pal Quito M 37–49',
      dog({ sex: 'male', ageMonthsMin: 37, ageMonthsMax: 49 }),
      { kind: 'act-now', femaleOptions: false },
    ],
    ['224 Cloe F 9', dog({ sex: 'female', ...at(9) }), { kind: 'act-now', femaleOptions: true }],
    [
      '215 Dana F 4–26 ("25 MESES", possibly "2,5")',
      dog({ sex: 'female', ageMonthsMin: 4, ageMonthsMax: 26 }),
      { kind: 'depends', on: 'age', femaleOptions: true },
    ],
  ];
  for (const [label, input, expected] of cases) {
    assert.deepEqual(sterilizationTiming(input), expected, label);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Refusals — each by its own name
// ─────────────────────────────────────────────────────────────────────────────

test('every refusal names what is missing, and no two share a reason', () => {
  const reasons = [
    sterilizationTiming(dog({ species: null })),
    sterilizationTiming(dog({ species: 'cat' })),
    sterilizationTiming(dog({ sex: null })),
    sterilizationTiming(dog({ ageMonthsMin: null, ageMonthsMax: null })),
  ].map((r) => (r.kind === 'refused' ? r.reason : `NOT REFUSED: ${r.kind}`));

  assert.deepEqual(reasons, ['species-unknown', 'not-a-dog', 'sex-unknown', 'age-unknown']);
  // One shared "cannot evaluate" would send someone to fix the wrong thing.
  assert.equal(new Set(reasons).size, 4);
});

test('a cat or a rabbit is outside the guideline, not unknown to it', () => {
  // AAHA 2019 is CANINE. "Not a dog" and "species unknown" are different
  // claims, and the second would imply the photo session could fix the first.
  for (const species of ['cat', 'rabbit'] as const) {
    const r = sterilizationTiming(dog({ species }));
    assert.deepEqual(r, { kind: 'refused', reason: 'not-a-dog' }, species);
  }
});

test('a nonsense age is refused rather than repaired', () => {
  assert.equal(normalizeAgeRange(-1, 5), null);
  assert.equal(normalizeAgeRange(10, 4), null, 'a reversed range must not be silently swapped');
  assert.deepEqual(normalizeAgeRange(8, null), { min: 8, max: 8 }, 'one end alone is a point');
  assert.deepEqual(normalizeAgeRange(null, 8), { min: 8, max: 8 });
  assert.equal(normalizeAgeRange(null, null), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// "Not due yet" is never said
// ─────────────────────────────────────────────────────────────────────────────

test('no result, in any wording, tells the shelter to wait', () => {
  // The one case the band changes is a young large male, and the direction it
  // changes it is WAIT — against ASV §7.1, "It is unacceptable for
  // organizations to allow shelter animals to breed". The early result names
  // BOTH standards instead.
  const every: TimingResult[] = [
    { kind: 'act-now', femaleOptions: false },
    { kind: 'early', femaleOptions: false },
    { kind: 'depends', on: 'band', femaleOptions: false },
    { kind: 'depends', on: 'age', femaleOptions: false },
    { kind: 'refused', reason: 'species-unknown' },
    { kind: 'refused', reason: 'not-a-dog' },
    { kind: 'refused', reason: 'sex-unknown' },
    { kind: 'refused', reason: 'age-unknown' },
  ];
  for (const r of every) {
    const text = es.sterilizationTiming(r);
    assert.ok(text.length > 0, `empty sentence for ${JSON.stringify(r)}`);
    assert.equal(
      /todav[ií]a no (corresponde|es el momento|toca)|a[uú]n no (corresponde|toca)|no corresponde todav[ií]a|espera(r)? a/i.test(text),
      false,
      `"${text}" reads as permission to wait`,
    );
  }
  // And the early result must carry the shelter standard beside the chart.
  assert.match(es.sterilizationTiming({ kind: 'early', femaleOptions: false }), /ASV §7\.1/);
});

test('every sentence leaves the decision to the veterinarian where it acts', () => {
  // ASV §7.2: "The final decision regarding acceptance of any patient for
  // surgery must be made by a veterinarian". A result that points at surgery
  // must say whose call it is.
  for (const r of [
    { kind: 'act-now', femaleOptions: false },
    { kind: 'early', femaleOptions: false },
  ] as TimingResult[]) {
    assert.match(es.sterilizationTiming(r), /veterinario/, JSON.stringify(r));
  }
  assert.match(es.sterilizationFemaleOptions, /veterinario/);
});

test('the female options note states BOTH options and prefers neither', () => {
  const note = es.sterilizationFemaleOptions;
  assert.match(note, /antes del primer celo/);
  assert.match(note, /despu[eé]s de que termine de crecer/);
  assert.match(note, /no elige/);
});

test('the timing sentences are gender-free', () => {
  // The animal may be of either sex. A clitic built for one is wrong for the
  // other — the class of error that shipped "Está identifica" to a dossier.
  const all = [
    ...(['act-now', 'early'] as const).map((kind) => es.sterilizationTiming({ kind, femaleOptions: false })),
    es.sterilizationTiming({ kind: 'depends', on: 'band', femaleOptions: false }),
    es.sterilizationTiming({ kind: 'depends', on: 'age', femaleOptions: false }),
  ];
  for (const text of all) {
    assert.equal(
      /esterilizarl[oa]\b|ubicarl[oa]\b|operarl[oa]\b|castrarl[oa]\b/.test(text),
      false,
      `"${text}" inflects for one sex`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The scale is a conflict, never an override
// ─────────────────────────────────────────────────────────────────────────────

test('heaviestWeight is not latestWeight, and the difference is the whole point', () => {
  // A dog weighed 22 kg in March and 19 kg in September — sick, wasting — still
  // reached 22. latestWeight answers 19, which is right for a dose and wrong
  // for "has this animal ever been over 20 kg".
  const march = Date.UTC(2026, 2, 14);
  const september = Date.UTC(2026, 8, 14);
  const history = [
    { weightKg: 22, measuredAt: march },
    { weightKg: 19, measuredAt: september },
  ];
  assert.equal(heaviestWeight(history)?.kg, 22);
  assert.equal(latestWeight(history)?.kg, 19);
});

test('heaviestWeight skips readings that took no weight', () => {
  const r = heaviestWeight([
    { weightKg: null, measuredAt: 1 },
    { weightKg: 0, measuredAt: 2 },
    { weightKg: 14.66, measuredAt: 3 },
  ]);
  assert.equal(r?.kg, 14.66);
});

test('a scale can only contradict "under 20 kg", and only strictly above it', () => {
  assert.equal(bandConflict('under-20kg', 22), true);
  assert.equal(bandConflict('under-20kg', 20), false, 'exactly 20 kg is not a contradiction');
  assert.equal(bandConflict('under-20kg', 19), false);
  // A reading under 20 kg proves nothing about a growing animal's adult weight,
  // so "over 20 kg" can never be contradicted by a scale.
  assert.equal(bandConflict('over-20kg', 12), false);
  assert.equal(bandConflict('over-20kg', 30), false);
  assert.equal(bandConflict(null, 30), false, 'no band, nothing to contradict');
  assert.equal(bandConflict('under-20kg', null), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Age today, from the register
// ─────────────────────────────────────────────────────────────────────────────

test('age today is age at intake plus the time since', () => {
  const intake = Date.UTC(2026, 0, 1);
  const now = Date.UTC(2026, 6, 1); // ~6 months later
  const r = ageRangeToday(5, 5, intake, now);
  assert.ok(r);
  assert.ok(r.min > 10.9 && r.min < 11.1, `expected ~11 months, got ${r.min}`);
  assert.equal(r.min, r.max);
});

test('an intake date in the future does not make an animal younger', () => {
  const r = ageRangeToday(5, 5, Date.UTC(2030, 0, 1), Date.UTC(2026, 0, 1));
  assert.deepEqual(r, { min: 5, max: 5 });
});

test('no intake date, or no age at intake, means no age today', () => {
  assert.equal(ageRangeToday(5, 5, null, Date.now()), null);
  assert.equal(ageRangeToday(null, null, Date.UTC(2026, 0, 1), Date.now()), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Wiring
// ─────────────────────────────────────────────────────────────────────────────

test('a new draft starts with no adult band', () => {
  assert.equal(draftDefaults('draft-1').expectedAdultWeightBand, null);
});

test('the model can never fill the adult band', () => {
  // `shouldPrefill` returns false for any key absent from PREFILLABLE, so
  // omission IS the enforcement. `decideWeight`'s guard is a ratio, and it
  // would pass 8–10 kg on a puppy heading to 35 kg.
  const src = read('src/lib/intake.ts');
  const start = src.indexOf('const PREFILLABLE');
  const end = src.indexOf('\n};', start);
  assert.ok(start >= 0 && end > start, 'PREFILLABLE is gone');
  assert.equal(
    src.slice(start, end).includes('expectedAdultWeightBand'),
    false,
    'the adult band has become prefillable — a photo estimate would decide a surgical window',
  );
});

test('the intake form asks the band three ways, in the chart’s own words', () => {
  const src = read('src/app/admin/intake/IntakeWizard.tsx');
  assert.match(src, /value=\{toBandValue\(draft\.expectedAdultWeightBand\)\}/);
  assert.match(src, /update\(\{ expectedAdultWeightBand: fromBandValue\(e\.target\.value\) \}\)/);
  assert.match(src, /¿Cuánto crees que pesará de adulto\?/);
});

test('the weight conflict is judged on the HEAVIEST reading, not the latest', () => {
  // Swapping heaviestWeight for latestWeight here typechecks cleanly — same
  // argument, same return type — and silently breaks the check on exactly the
  // sick and wasting animals the panel tracks. Only this test would notice.
  const src = read('src/app/admin/pets/[petId]/MeasurementPanel.tsx');
  assert.match(
    src,
    /const heaviest = records \? heaviestWeight\(records\) : null;/,
    'the conflict check no longer reads the heaviest reading',
  );
  assert.match(
    src,
    /const conflict = bandConflict\(adultBand, heaviest\?\.kg \?\? null\);/,
    'the conflict is no longer computed from the heaviest reading',
  );
});

test('a weight conflict is a note, never an error and never a rewrite', () => {
  const src = read('src/app/admin/pets/[petId]/MeasurementPanel.tsx');
  const block = src.slice(src.indexOf('{conflict && heaviest && ('));
  assert.ok(block.length > 0, 'the conflict note is gone');
  const note = block.slice(0, block.indexOf('</p>'));
  assert.match(note, /className="auth__notice"/, 'the conflict is no longer shown as a note');
  assert.equal(/auth__error/.test(note), false, 'the conflict now reads as an error');
  // Nothing in the panel may write the band back from a scale.
  assert.equal(
    /expectedAdultWeightBand\s*:/.test(src),
    false,
    'the measurements panel is writing the adult band — a scale must never overwrite a person’s judgement',
  );
});

test('both branches of the animal page hand the band to the panel', () => {
  const src = read('src/app/admin/pets/[petId]/PetAdminPanel.tsx');
  assert.match(src, /adultBand=\{pet\?\.expectedAdultWeightBand \?\? null\}/, 'published branch');
  assert.match(src, /adultBand=\{draft\.expectedAdultWeightBand \?\? null\}/, 'draft branch');
});

test('the roster shows the verdict only in the unaltered-animals view', () => {
  const src = read('src/app/admin/register/RegisterRoster.tsx');
  assert.match(
    src,
    /\{pendingSterilization && \(\s*<span className="register-row__timing">/,
    'the timing line escaped the filtered view and now lengthens every row of the photo-session roster',
  );
});
