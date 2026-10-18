/**
 * A pet published with a name and a photo, and nothing else.
 *
 * Owner decision 2026-10-18: "to publish a dog, only a name and a picture are
 * required." Before it, every public renderer could assume species, sex and
 * size were set — the publish gate refused a draft without them. Now they can
 * be null on the PUBLIC document, and three things must hold for every one of
 * them, on every page a stranger can reach:
 *
 *   1. nothing renders "undefined", "null", "edad desconocida" or a doubled
 *      " ·  · " separator;
 *   2. nothing throws (`SPECIES_NOUN[null]` used to, which 500s a page);
 *   3. an unknown sex produces NO gendered word — never a masculine default.
 *
 * Then the two pure modules the bulk publish rests on: the document builder
 * shared with the wizard, and the selector that decides who is ready.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { es } from '@/i18n/es';
import { petFactRows } from '../application-steps';
import { draftDefaults, type DraftMedia, type PetDraft } from '../intake';
import { buildPublishDocuments } from '../publish-documents';
import { draftHasRealName, selectReadyDrafts, type SelectionEntry } from '../publish-selection';
import type { PetSex, PetSize, Species } from '../types';

// ─── helpers ──────────────────────────────────────────────────────────────────

const SEXES: (PetSex | null)[] = ['male', 'female', null];
const SIZES: (PetSize | null)[] = ['small', 'medium', 'large', null];
const SPECIES: (Species | null)[] = ['dog', 'cat', 'rabbit', 'other', null];
const AGES: (number | null)[] = [3, 26, null];

/**
 * Words that claim a sex. "tamaño mediano" agrees with "tamaño", not with the
 * animal, so it is removed before scanning.
 */
const GENDERED =
  /\b(perr[oa]|gat[oa]|conej[oa]|animalita|mestiz[oa]|macho|hembra|pequeñ[oa]|median[oa]|identificad[oa]|conocid[oa]|perdid[oa]|sol[oa]|llével[oa]|llév(?:a|e)l[oa]|buscarl[oa]|[ln][oa] encontraste|l[ao] encuentras|l[ao] está buscando)\b/iu;

function genderedWords(text: string): string | null {
  const scrubbed = text.replace(/tamaño (pequeño|mediano|grande)/giu, '');
  return GENDERED.exec(scrubbed)?.[0] ?? null;
}

function assertClean(text: string, label: string): void {
  assert.equal(/undefined|null|NaN/.test(text), false, `${label}: "${text}"`);
  assert.equal(/·\s*·/.test(text), false, `${label}: doubled separator in "${text}"`);
  assert.equal(/^\s*·|·\s*$/.test(text), false, `${label}: dangling separator in "${text}"`);
  assert.equal(/edad desconocida/.test(text), false, `${label}: "${text}"`);
}

function photo(overrides: Partial<DraftMedia> = {}): DraftMedia {
  return {
    id: 'm1',
    slot: 'front',
    path: 'pets/p1/m1.jpg',
    url: 'https://firebasestorage.googleapis.com/v0/b/wawitas-app/o/pets%2Fp1%2Fm1.jpg',
    alt: '',
    width: 1200,
    height: 1600,
    ...overrides,
  };
}

// ─── formatMeta (the wall card) ───────────────────────────────────────────────

test('formatMeta joins known parts only, for every combination of unknowns', () => {
  for (const sex of SEXES) {
    for (const size of SIZES) {
      for (const ageMonths of AGES) {
        const meta = es.formatMeta({ ageMonths, sex, size });
        assertClean(meta, JSON.stringify({ sex, size, ageMonths }));
        if (sex === null) {
          assert.equal(genderedWords(meta), null, `gendered word in "${meta}" with unknown sex`);
        }
      }
    }
  }
});

test('formatMeta reads naturally in the cases that reach the wall', () => {
  assert.equal(es.formatMeta({ ageMonths: 26, sex: 'female', size: 'medium' }), '2 años · hembra · mediana');
  // The real case of 2026-10-18: sex recorded, nothing else.
  assert.equal(es.formatMeta({ ageMonths: null, sex: 'female', size: null }), 'hembra');
  assert.equal(es.formatMeta({ ageMonths: null, sex: null, size: 'medium' }), 'tamaño mediano');
  assert.equal(es.formatMeta({ ageMonths: null, sex: null, size: 'large' }), 'tamaño grande');
  // Nothing known → '' so the card omits the element instead of an empty line.
  assert.equal(es.formatMeta({ ageMonths: null, sex: null, size: null }), '');
});

// ─── nouns and size ───────────────────────────────────────────────────────────

test('speciesNoun never throws on an unknown species, and stays diminutive-neutral', () => {
  assert.equal(es.speciesNoun(null, 'male'), 'animalito');
  assert.equal(es.speciesNoun(null, 'female'), 'animalita');
  assert.equal(es.speciesPlural(null), 'animalitos');
  assert.equal(es.speciesNoun('dog', 'female'), 'perra');
});

test('sizeLabel with an unknown sex agrees with "tamaño", never with the animal', () => {
  assert.equal(es.sizeLabel('small', null), 'tamaño pequeño');
  assert.equal(es.sizeLabel('medium', null), 'tamaño mediano');
  assert.equal(es.sizeLabel('large', null), 'tamaño grande');
  // Known sex unchanged.
  assert.equal(es.sizeLabel('small', 'female'), 'pequeña');
  assert.equal(es.sizeLabel('large', 'male'), 'grande');
});

test('formatBreedLine treats a missing breed as no line', () => {
  assert.equal(es.formatBreedLine(undefined), null);
  assert.equal(es.formatBreedLine(null), null);
  assert.equal(es.formatBreedLine(''), null);
});

// ─── the dossier and the tag ──────────────────────────────────────────────────

test('petFacts (dossier and tag) is clean for every combination of unknowns', () => {
  for (const species of SPECIES) {
    for (const sex of SEXES) {
      for (const size of SIZES) {
        for (const breed of ['', 'mestiza', undefined]) {
          for (const ageMonths of AGES) {
            const pet = { species, sex, size, breed, ageMonths };
            const label = JSON.stringify(pet);
            const facts = es.petFacts(pet);
            assertClean(facts, label);
            const tag = es.petFacts(pet, { age: false });
            assertClean(tag, label);
            // A number followed by a unit: "pequeño" contains "año".
            assert.equal(/\d+ (años?|mes(es)?)/.test(tag), false, `the tag shows no age: "${tag}"`);
            if (sex === null) {
              // "mestiza" is the BREED the shelter typed, not a word we chose.
              assert.equal(genderedWords(facts.replace('mestiza', '')), null, `${label}: "${facts}"`);
            }
          }
        }
      }
    }
  }
});

test('petFacts in the real 2026-10-18 case and the edges', () => {
  // Species from the register, sex recorded, nothing else — the 20 dogs.
  assert.equal(es.petFacts({ species: 'dog', sex: 'female', breed: '', size: null, ageMonths: null }), 'perra');
  assert.equal(
    es.petFacts({ species: 'dog', sex: 'male', breed: 'mestizo', size: 'medium', ageMonths: 26 }),
    'perro · mestizo · 2 años · mediano',
  );
  // Unknown sex: the noun is dropped (perro would claim male), size is neutral.
  assert.equal(es.petFacts({ species: 'dog', sex: null, breed: '', size: 'small', ageMonths: 3 }), '3 meses · tamaño pequeño');
  // Unknown species, known sex: the sex word, not "animalita".
  assert.equal(es.petFacts({ species: null, sex: 'female', breed: '', size: null, ageMonths: null }), 'hembra');
  assert.equal(es.petFacts({ species: null, sex: null, breed: '', size: null, ageMonths: null }), '');
});

test('the dossier sentences are gender-free when the sex is unknown', () => {
  const former = es.formerNamesNote(null, ['Luna', 'Sol']);
  assert.equal(former, 'Antes se llamaba Luna, Sol');
  assert.equal(es.formerNamesNote('female', ['Luna']), 'Antes conocida como Luna');

  const chip = es.microchipFinderNote('Kiara', null);
  assert.equal(genderedWords(chip), null, chip);
  assert.ok(chip.includes('Kiara'));
  assert.ok(es.microchipFinderNote('Kiara', 'female').includes('identificada'));
});

test('the tag page sentences are gender-free when the sex is unknown', () => {
  const lines = [
    es.tag.lostBanner('Kiara', null),
    es.tag.microchipHint(null),
    es.tag.finderMessage({ name: 'Kiara', sex: null, formattedToken: 'ABCD-EFGH', tone: 'lost' }),
    ...(['lost', 'adopted', 'available', 'in-care'] as const).map((tone) =>
      es.tag.situation(tone, 'Kiara', null, 'Wawitas'),
    ),
  ];
  for (const line of lines) {
    assertClean(line, line);
    assert.equal(genderedWords(line), null, line);
  }
  // Control: the detector does catch the gendered forms with a known sex.
  assert.notEqual(genderedWords(es.tag.lostBanner('Kiara', 'female')), null);
  assert.notEqual(genderedWords(es.tag.situation('adopted', 'Kiara', 'male', 'Wawitas')), null);
});

test('the default photo description is built from the name only', () => {
  assert.equal(es.defaultPhotoAlt('  Kiara '), 'Foto de Kiara');
});

// ─── the adoption application's pet section ───────────────────────────────────

test('petFactRows leaves out a missing sex, species or breed instead of crashing', () => {
  const labels = {
    name: 'NOMBRE',
    age: 'EDAD',
    breed: 'RAZA',
    color: 'COLOR',
    species: 'ESPECIE',
    sex: 'SEXO',
    speciesValues: { dog: 'CANINO', cat: 'FELINO' },
    sexValues: { male: 'MACHO', female: 'HEMBRA' },
  } as unknown as Parameters<typeof petFactRows>[1];
  const format = { age: (m: number | null) => es.formatAge(m), ageRange: es.formatAgeRange.bind(es) };
  const rows = petFactRows(
    {
      name: 'Kiara',
      breed: undefined as unknown as string,
      colorPattern: null,
      species: null,
      sex: null,
      ageMonths: null,
      ageMonthsMin: null,
      ageMonthsMax: null,
      ageIsEstimate: false,
    },
    labels,
    format,
  );
  assert.deepEqual(rows, [{ label: 'NOMBRE', value: 'Kiara' }]);
  for (const row of rows) assertClean(String(row.value), row.label);
});

// ─── the document builder shared by the wizard and the bulk script ────────────

function readyDraft(overrides: Partial<PetDraft> = {}): PetDraft {
  return { ...draftDefaults('Dr4ft1D'), name: 'Kiara', sex: 'female', media: [photo()], ...overrides };
}

const SENTINEL = { sentinel: 'now' } as const;

test('buildPublishDocuments takes the status it is given, and nulls stay null', () => {
  const docs = buildPublishDocuments({
    draft: readyDraft(),
    slug: 'kiara',
    status: 'available',
    uid: 'admin-uid',
    now: SENTINEL,
    defaultAlt: es.defaultPhotoAlt,
  });
  assert.equal(docs.petId, 'Dr4ft1D');
  assert.equal(docs.pet.status, 'available');
  assert.equal(docs.pet.slug, 'kiara');
  assert.equal(docs.pet.species, null);
  assert.equal(docs.pet.size, null);
  assert.equal(docs.pet.sex, 'female');
  assert.equal(docs.pet.breed, '');
  assert.equal(docs.pet.createdAt, SENTINEL);
  assert.equal(docs.pet.coverPhoto, photo().url);
  assert.equal(docs.identity, null);
  // The wizard path passes the draft's own status through untouched.
  const wizard = buildPublishDocuments({
    draft: readyDraft({ status: 'shelter' }),
    slug: 'kiara',
    status: 'shelter',
    uid: 'u',
    now: SENTINEL,
    defaultAlt: es.defaultPhotoAlt,
  });
  assert.equal(wizard.pet.status, 'shelter');
});

test('a blank photo description publishes as the default alt; a typed one is kept', () => {
  const docs = buildPublishDocuments({
    draft: readyDraft({ media: [photo({ id: 'a', alt: '  ' }), photo({ id: 'b', alt: 'Perra negra en el patio' })] }),
    slug: 'kiara',
    status: 'available',
    uid: 'u',
    now: SENTINEL,
    defaultAlt: es.defaultPhotoAlt,
  });
  assert.equal(docs.media[0]!.data.alt, 'Foto de Kiara');
  assert.equal(docs.media[1]!.data.alt, 'Perra negra en el patio');
  assert.equal(docs.media[0]!.data.tier, 'public');
  assert.equal(docs.media[1]!.data.tier, 'auth');
});

test('the species fallback is used only when the draft has none', () => {
  const base = { slug: 'kiara', status: 'available' as const, uid: 'u', now: SENTINEL, defaultAlt: es.defaultPhotoAlt };
  assert.equal(buildPublishDocuments({ ...base, draft: readyDraft(), speciesFallback: 'dog' }).pet.species, 'dog');
  assert.equal(
    buildPublishDocuments({ ...base, draft: readyDraft({ species: 'cat' }), speciesFallback: 'dog' }).pet.species,
    'cat',
  );
});

test('an empty slug is refused rather than written', () => {
  assert.throws(() =>
    buildPublishDocuments({
      draft: readyDraft(),
      slug: '  ',
      status: 'available',
      uid: 'u',
      now: SENTINEL,
      defaultAlt: es.defaultPhotoAlt,
    }),
  );
});

test('an identity document is built only for a chip code that validates', () => {
  const base = { slug: 'kiara', status: 'available' as const, uid: 'u', now: SENTINEL, defaultAlt: es.defaultPhotoAlt };
  const valid = buildPublishDocuments({
    ...base,
    draft: readyDraft({ hasMicrochip: true, microchipCode: '068 0000 0000 0042' }),
  });
  assert.equal(valid.identity?.code, '068000000000042');
  assert.equal(valid.invalidChip, false);
  assert.equal(valid.pet.hasMicrochip, true);
  const invalid = buildPublishDocuments({ ...base, draft: readyDraft({ hasMicrochip: true, microchipCode: '12' }) });
  assert.equal(invalid.identity, null);
  assert.equal(invalid.invalidChip, true);
});

// ─── who the bulk publish selects ─────────────────────────────────────────────

function entry(overrides: Partial<SelectionEntry> = {}): SelectionEntry {
  return {
    no: 1,
    status: 'in-shelter',
    petId: 'd1',
    hasRealName: true,
    name: 'Kiara',
    nameRaw: 'KIARA',
    species: 'dog',
    ...overrides,
  };
}

test('the selector takes an in-shelter animal with a real name and a showable photo', () => {
  const drafts = new Map([['d1', readyDraft({ id: 'd1' })]]);
  const { ready, skipped } = selectReadyDrafts([entry()], drafts);
  assert.deepEqual(skipped, []);
  assert.equal(ready.length, 1);
  assert.equal(ready[0]!.species, 'dog');
  assert.equal(ready[0]!.speciesSource, 'register');
});

test('the selector excludes the nameless, the photo-less, the private-only and the not-in-shelter', () => {
  const drafts = new Map<string, PetDraft>([
    ['nameless', readyDraft({ id: 'nameless', name: '  ' })],
    ['photoless', readyDraft({ id: 'photoless', media: [] })],
    ['private', readyDraft({ id: 'private', media: [photo({ slot: 'teeth', url: '' }), photo({ id: 'g', slot: 'genitals', url: '' })] })],
    ['adopted', readyDraft({ id: 'adopted' })],
    ['described', readyDraft({ id: 'described', name: 'BB3 Pomposo' })],
    ['chipless', readyDraft({ id: 'chipless', hasMicrochip: true, microchipCode: '' })],
  ]);
  const entries = [
    entry({ no: 1, petId: 'nameless' }),
    entry({ no: 2, petId: 'photoless' }),
    entry({ no: 3, petId: 'private' }),
    entry({ no: 4, petId: 'adopted', status: 'adopted' }),
    entry({ no: 5, petId: 'gone' }),
    entry({ no: 6, petId: 'described', hasRealName: false, name: 'BB3 POMPOSO', nameRaw: 'BB3 POMPOSO' }),
    entry({ no: 7, petId: null }),
    entry({ no: 8, petId: 'chipless' }),
  ];
  const { ready, skipped } = selectReadyDrafts(entries, drafts);
  assert.deepEqual(ready, []);
  assert.deepEqual(skipped, [
    { no: 1, reason: 'no-real-name' },
    { no: 2, reason: 'photo-required' },
    { no: 3, reason: 'photo-required' },
    { no: 4, reason: 'not-in-shelter' },
    { no: 5, reason: 'no-draft' },
    { no: 6, reason: 'no-real-name' },
    { no: 7, reason: 'no-draft' },
    { no: 8, reason: 'microchip-required' },
  ]);
});

test('a description row counts once a person typed a different name', () => {
  const described = { hasRealName: false, name: 'BB3 POMPOSO', nameRaw: 'BB3 (pomposo, con negro)' };
  assert.equal(draftHasRealName({ name: 'Copito' }, described), true);
  assert.equal(draftHasRealName({ name: 'bb3 pomposo' }, described), false);
  assert.equal(draftHasRealName({ name: 'BB3 (Pomposo, con negro)' }, described), false);
  assert.equal(draftHasRealName({ name: '' }, { hasRealName: true, name: 'Kiara', nameRaw: 'KIARA' }), false);
  assert.equal(draftHasRealName({ name: 'Kiara' }, { hasRealName: true, name: 'Kiara', nameRaw: 'KIARA' }), true);
});
