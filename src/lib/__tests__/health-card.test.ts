import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  HEALTH_CARD_BLANK_ROWS,
  buildHealthCardTables,
  formatIsoDay,
  identityFromDraft,
  identityFromPet,
  type HealthCardDraftInput,
  type HealthCardRecordInput,
} from '../health-card';
import { formatDateNumeric } from '../date-input';

/**
 * The printable card. What is on paper leaves the building, so the rules here
 * are about what may NEVER print: an unconfirmed reading, a computed date, a
 * gap dressed up as a request.
 *
 * Dates are built with the LOCAL `Date` constructor, so the file behaves the
 * same in CI (UTC) and on a machine in Bolivia (UTC-4).
 */

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0).getTime();

function record(over: Partial<HealthCardRecordInput>): HealthCardRecordInput {
  return {
    id: 'r',
    kind: 'vaccination',
    name: 'Antirrábica',
    performedAt: day(2025, 8, 31),
    nextDueAt: null,
    veterinarian: null,
    clinic: null,
    batch: null,
    manufacturer: null,
    confirmedBy: 'vet@example.com',
    ...over,
  };
}

test('blank rows per table are four — the owner chose the number', () => {
  assert.equal(HEALTH_CARD_BLANK_ROWS, 4);
});

test('an unconfirmed record never prints, whatever it says', () => {
  const tables = buildHealthCardTables([
    record({ id: 'ok' }),
    record({ id: 'model-guess', confirmedBy: null }),
    record({ id: 'blank-confirmer', confirmedBy: '' }),
    record({ id: 'sterilization-guess', kind: 'sterilization', confirmedBy: null }),
  ]);
  assert.deepEqual(tables.vaccinations.map((r) => r.id), ['ok']);
  assert.equal(tables.sterilizedAt, null);
});

test('vaccinations and dewormings go to their own tables; other kinds print nowhere', () => {
  const tables = buildHealthCardTables([
    record({ id: 'v', kind: 'vaccination' }),
    record({ id: 'd', kind: 'deworming', name: 'Desparasitación' }),
    record({ id: 'c', kind: 'consultation' }),
    record({ id: 't', kind: 'treatment' }),
    record({ id: 's', kind: 'serology' }),
    record({ id: 'x', kind: 'surgery' }),
    record({ id: 'n', kind: null }),
  ]);
  assert.deepEqual(tables.vaccinations.map((r) => r.id), ['v']);
  assert.deepEqual(tables.dewormings.map((r) => r.id), ['d']);
});

test('rows are oldest first, the way a booklet fills up, and ties never reorder', () => {
  const tables = buildHealthCardTables([
    record({ id: 'late', performedAt: day(2026, 7, 21) }),
    // Ids sort the OTHER way from the names, so the name tie-break is what is tested.
    record({ id: 'y', name: 'Óctuple', performedAt: day(2025, 7, 5) }),
    record({ id: 'z', name: 'Octavalente', performedAt: day(2025, 7, 5) }),
    record({ id: 'early', performedAt: day(2024, 1, 2) }),
  ]);
  assert.deepEqual(tables.vaccinations.map((r) => r.id), ['early', 'z', 'y', 'late']);
});

test('a frozen register record prints its gaps as empty cells, never as requests', () => {
  const tables = buildHealthCardTables([record({ name: 'Octavalente' })]);
  assert.deepEqual(tables.vaccinations[0], {
    id: 'r',
    performedAt: day(2025, 8, 31),
    name: 'Octavalente',
    manufacturer: null,
    batch: null,
    nextDueAt: null,
    veterinarian: null,
    clinic: null,
  });
});

test('stored values print as stored — trimmed, and blank text is empty', () => {
  const tables = buildHealthCardTables([
    record({
      name: '  Defensor 3 ',
      manufacturer: ' Zoetis ',
      batch: '   ',
      veterinarian: '',
      clinic: ' Centro de Salud ',
      nextDueAt: day(2026, 8, 31),
    }),
  ]);
  const row = tables.vaccinations[0]!;
  assert.equal(row.name, 'Defensor 3');
  assert.equal(row.manufacturer, 'Zoetis');
  assert.equal(row.batch, null);
  assert.equal(row.veterinarian, null);
  assert.equal(row.clinic, 'Centro de Salud');
  // The stored next date, untouched — the card computes no date.
  assert.equal(row.nextDueAt, day(2026, 8, 31));
});

test('a record with no date is left off — a dateless row tells a reader nothing', () => {
  const tables = buildHealthCardTables([record({ id: 'nodate', performedAt: null }), record({ id: 'nan', performedAt: Number.NaN })]);
  assert.equal(tables.vaccinations.length, 0);
});

test('sterilization is the earliest CONFIRMED sterilization record', () => {
  const tables = buildHealthCardTables([
    record({ id: 's2', kind: 'sterilization', performedAt: day(2025, 9, 1) }),
    record({ id: 's1', kind: 'sterilization', performedAt: day(2025, 3, 10) }),
  ]);
  assert.equal(tables.sterilizedAt, day(2025, 3, 10));
  assert.equal(buildHealthCardTables([record({})]).sterilizedAt, null);
});

// ── who the card is about ───────────────────────────────────────────────────

function draft(over: Partial<HealthCardDraftInput>): HealthCardDraftInput {
  return {
    name: 'Bravo',
    species: 'dog',
    sex: 'male',
    breed: 'mestizo',
    colorPattern: 'café',
    hasMicrochip: false,
    microchipCode: '',
    register: null,
    ...over,
  };
}

test('a register draft with no name prints the register’s own spelling', () => {
  const identity = identityFromDraft(
    draft({ name: '  ', register: { nameRaw: 'Lobita', ageText: null, intakeDay: null } }),
  );
  assert.equal(identity.name, 'Lobita');
});

test('the microchip prints only when the draft says the animal is chipped', () => {
  assert.equal(identityFromDraft(draft({ hasMicrochip: false, microchipCode: '068000000000042' })).microchip, null);
  assert.equal(
    identityFromDraft(draft({ hasMicrochip: true, microchipCode: ' 068000000000042 ' })).microchip,
    '068000000000042',
  );
  assert.equal(identityFromDraft(draft({ hasMicrochip: true, microchipCode: '' })).microchip, null);
});

test('age prints as the register wrote it, with the day it was written — never as a live age', () => {
  assert.deepEqual(
    identityFromDraft(draft({ register: { nameRaw: 'x', ageText: '3 años', intakeDay: '2025-07-05' } })).age,
    { kind: 'at-intake', text: '3 años', day: '2025-07-05' },
  );
  assert.equal(identityFromDraft(draft({ register: { nameRaw: 'x', ageText: ' ', intakeDay: '2025-07-05' } })).age, null);
  assert.equal(identityFromDraft(draft({})).age, null);
});

test('a published pet prints a birth date only when one is known', () => {
  const pet = { name: 'Nube', species: 'cat' as const, sex: 'female' as const, breed: '', colorPattern: null };
  assert.deepEqual(identityFromPet({ ...pet, birthdateMs: day(2024, 2, 1) }, null).age, {
    kind: 'born',
    at: day(2024, 2, 1),
  });
  const identity = identityFromPet({ ...pet, birthdateMs: null }, '  ');
  assert.equal(identity.age, null);
  assert.equal(identity.breed, null);
  assert.equal(identity.microchip, null);
});

test('dates print day first, as a Bolivian card is written', () => {
  assert.equal(formatIsoDay('2025-07-05'), '05/07/2025');
  assert.equal(formatIsoDay('2025'), '2025');
  assert.equal(formatDateNumeric(day(2025, 7, 5)), '05/07/2025');
  assert.equal(formatDateNumeric(day(2026, 12, 31)), '31/12/2026');
});

// ── wiring: source-text checks, crude on purpose (see medical-wiring.test.ts) ──

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const code = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

test('the card view decides nothing itself — the tables come from buildHealthCardTables', () => {
  const view = code('src/app/admin/pets/[petId]/health-card/HealthCardPrint.tsx');
  // Both load paths — a published pet and a draft — and no table built by hand.
  assert.equal(view.match(/tables: buildHealthCardTables\(/g)?.length, 2);
  assert.doesNotMatch(view, /tables:\s*\{/);
  assert.doesNotMatch(view, /isConfirmed\(/, 'the gate lives in health-card.ts');
  assert.doesNotMatch(view, /ageMonths/, 'a live age is never printed');
  assert.doesNotMatch(view, /\.sterilized\b/, 'the flag can mean "the paper did not say"');
});

test('the print button exists only once everything loaded — never an empty card for a failed read', () => {
  const view = code('src/app/admin/pets/[petId]/health-card/HealthCardPrint.tsx');
  // The guard must sit directly on the button: an earlier `state.kind ===
  // 'ready'` (the heading) must not satisfy this.
  assert.match(view, /\{state\.kind === 'ready' && \(\s*<button[^>]*onClick=\{\(\) => window\.print\(\)\}/);
  assert.equal(view.match(/window\.print\(\)/g)?.length, 1, 'one print button, and only that one');
});

test('the page carries the print class, and the medical history links to it', () => {
  assert.match(code('src/app/admin/pets/[petId]/health-card/page.tsx'), /health-card-print/);
  assert.match(code('src/app/admin/pets/[petId]/MedicalPanel.tsx'), /\/admin\/pets\/\$\{petId\}\/health-card/);
});

test('the card prints on Carta through a NAMED page, so no other page’s paper changes', () => {
  const css = read('src/app/globals.css');
  assert.match(css, /@page health-card\s*\{[^}]*size:\s*letter/);
  assert.match(css, /\.health-card\s*\{[^}]*page:\s*health-card/);
  assert.doesNotMatch(css, /@page\s*\{/, 'an unnamed @page would change every printed page');
});
