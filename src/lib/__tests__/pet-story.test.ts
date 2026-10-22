/**
 * The animal's story: validated, written with a merge, published on the PUBLIC
 * document, and the five detail fields the owner removed stay removed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { STORY_MAX_CHARS, checkStory } from '../pet-story';
import { draftDefaults } from '../intake';
import { buildPublishDocuments } from '../publish-documents';

const ROOT = join(process.cwd());
function source(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');
}

function build(story: string, extra: Record<string, unknown> = {}) {
  const draft = { ...draftDefaults('p1'), name: 'Luna', story, ...extra };
  return buildPublishDocuments({
    draft,
    slug: 'luna',
    status: 'available',
    uid: 'u1',
    now: 'NOW',
    defaultAlt: (n) => `Foto de ${n}`,
  });
}

// ─── the pure validator ──────────────────────────────────────────────────────

test('checkStory trims, and a blank story is valid (it clears the field)', () => {
  assert.deepEqual(checkStory('  Llegó sola.  \n'), { story: 'Llegó sola.', error: null });
  assert.deepEqual(checkStory('   '), { story: '', error: null });
});

test('checkStory accepts exactly the maximum and refuses one more', () => {
  assert.equal(checkStory('a'.repeat(STORY_MAX_CHARS)).error, null);
  assert.equal(checkStory('a'.repeat(STORY_MAX_CHARS + 1)).error, 'too-long');
});

test('the length is measured after trimming', () => {
  assert.equal(checkStory(`  ${'a'.repeat(STORY_MAX_CHARS)}  `).error, null);
});

// ─── the editor's write ──────────────────────────────────────────────────────

test('updatePetStory is a MERGE write that stamps updatedAt and never a plain set', () => {
  const src = source('src/lib/pets-admin.ts');
  const start = src.indexOf('export async function updatePetStory');
  assert.ok(start > 0, 'updatePetStory exists');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.match(body, /doc\(db, 'pets', petId\)/);
  assert.match(body, /\{ story, updatedAt: serverTimestamp\(\) \}/);
  assert.match(body, /\{ merge: true \}/, 'a plain set would drop createdAt, which the wall orders by');
  assert.match(body, /checkStory\(raw\)/, 'the length bound is enforced before the write');
});

// ─── publishing ──────────────────────────────────────────────────────────────

test('the story is written to the PUBLIC pet document, trimmed, and not to detail', () => {
  const docs = build('  Llegó sola al portón.  ');
  assert.equal(docs.pet.story, 'Llegó sola al portón.');
  assert.equal('story' in docs.detail, false);
});

test('the detail document holds only sterilized', () => {
  const docs = build('x', { sterilized: true });
  assert.deepEqual(docs.detail, { sterilized: true });
  assert.deepEqual(build('x').detail, { sterilized: null });
});

test('an old draft that still carries the removed keys publishes none of them', () => {
  const old = {
    temperament: ['tranquila'],
    healthNotes: 'Registro n.º 3, desparasitación «02/12/26»: fecha futura.',
    commitments: ['castración gratuita'],
    goodWithChildren: true,
    goodWithOtherPets: false,
    photos: ['https://example.com/a.jpg'],
  };
  const docs = build('Historia', old);
  const written = JSON.stringify({ pet: docs.pet, detail: docs.detail });
  for (const key of Object.keys(old)) {
    assert.equal(written.includes(`"${key}"`), false, `${key} must not be written`);
  }
  assert.equal(written.includes('castración gratuita'), false);
  assert.equal(written.includes('desparasitación'), false);
});

// ─── the removed fields stay removed ─────────────────────────────────────────

const REMOVED = ['temperament', 'healthNotes', 'goodWithChildren', 'goodWithOtherPets'];

test('the removed detail fields do not reappear in the type, the builder or the wizard', () => {
  const types = source('src/lib/types.ts');
  const start = types.indexOf('export interface PetDetail');
  const detailType = types.slice(start, types.indexOf('\n}\n', start));
  const files: [string, string][] = [
    ['PetDetail', detailType],
    ['publish-documents.ts', source('src/lib/publish-documents.ts')],
    ['IntakeWizard.tsx', source('src/app/admin/intake/IntakeWizard.tsx')],
    ['intake.ts', source('src/lib/intake.ts')],
  ];
  for (const [name, text] of files) {
    // Comments may mention the history; code may not use the names.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const field of REMOVED) {
      assert.equal(new RegExp(`\\b${field}\\b`).test(code), false, `${name} mentions ${field}`);
    }
  }
  // `commitments` and `photos` are checked in PetDetail only: the adoption
  // contract has its own, unrelated `commitments`.
  const detailCode = detailType.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/\bcommitments\b/.test(detailCode), false);
  assert.equal(/\bphotos\b/.test(detailCode), false);
  assert.equal(/\bstory\b/.test(detailCode), false, 'the story lives on Pet, not PetDetail');
});

test('the importer no longer writes health notes', () => {
  assert.equal(/\bhealthNotes\b/.test(source('src/lib/register-import.ts')), false);
  assert.equal(/\bhealthNotes\b/.test(source('scripts/import-register.mjs')), false);
});
