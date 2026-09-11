import test from 'node:test';
import assert from 'node:assert/strict';

import { INTAKE_SUGGEST_SYSTEM, SLOT_LABEL, USER_INSTRUCTION } from '../ai/intake-prompt';

/**
 * The prompt's non-negotiables, pinned.
 *
 * ⚠️ These tests are not about wording. They exist because the prompt is the
 * only place several safety decisions are expressed AT ALL — "breed fails
 * toward mestizo", "a resemblance is not a claim", "sex comes from the genital
 * photo or not at all" — and prose has no type system. A future edit that
 * tightens the tone and drops one of these sentences would be invisible in
 * review, pass every other test, and change what the model asserts about a
 * real animal on a public listing.
 *
 * The prompt lives in `intake-prompt.ts` rather than `intake-suggest.ts`
 * precisely so this file can read it: the latter imports `server-only`, which
 * throws outside a server context.
 *
 * ⚠️ A green run here does NOT mean the prompt still works. Copy edits have
 * non-local effects — a sibling stack dropped an eval from 11/11 to 9/11 by
 * deleting one framing sentence. Run `npm run eval:intake -- --run` after ANY
 * wording change. These tests catch deletions, not degradations.
 */

/**
 * Accent- and case-insensitive, like the eval harness — and whitespace-flat.
 *
 * ⚠️ Collapsing newlines matters. The prompt is hard-wrapped at ~78 columns, so
 * "Ante cualquier duda, es mestizo" is split across two lines in the source and
 * a naive substring test for it fails while the sentence is perfectly present.
 * These assertions are about the PROSE, not about where it happens to wrap.
 */
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}
const PROMPT = fold(INTAKE_SUGGEST_SYSTEM);

test('breed still fails toward mestizo', () => {
  // The single most consequential instruction in the block. Visual breed
  // identification disagrees badly with DNA even among shelter staff, and a
  // confident wrong breed on a public listing attracts the wrong family and
  // ends with the animal returned.
  assert.ok(PROMPT.includes('ante cualquier duda, es mestizo'), 'lost the fail-toward-mestizo rule');
  assert.ok(
    PROMPT.includes('solo si el animal muestra la'),
    'lost the "purebred ONLY if unambiguous" qualifier',
  );
});

test('a resemblance is still a resemblance, never a claim', () => {
  assert.ok(
    PROMPT.includes('no afirma que sea de esa raza'),
    'resemblesBreeds must not become an assertion of breed',
  );
  assert.ok(
    PROMPT.includes('sin afirmar una raza'),
    'visibleType must not become an assertion of breed',
  );
});

test('an empty breed list is still an honest answer', () => {
  // The escape hatch that keeps the "name a concrete breed" instruction from
  // turning into pressure to invent one. Added alongside that instruction on
  // 2026-09-10 for exactly this reason.
  // ⚠️ BOTH, not either. They answer different questions and an OR let one be
  // deleted silently — a break probe caught that. The first covers "this
  // animal resembles no recognisable breed"; the second covers "I can see a
  // family but cannot reach a concrete breed", which only exists because the
  // name-a-concrete-breed instruction would otherwise read as pressure to
  // invent one.
  assert.ok(
    PROMPT.includes('devuelve una lista vacia'),
    'the model must still be allowed to name no breed at all',
  );
  assert.ok(
    PROMPT.includes('deja resemblesbreeds vacio'),
    'naming a concrete breed must not become pressure to invent one',
  );
});

test('sex still comes from the genital photo or not at all', () => {
  // decideSex enforces this too, but the prompt is what stops the model
  // producing a confident value for the guard to have to throw away. One wrong
  // sex makes every Spanish sentence about the animal ungrammatical.
  assert.ok(PROMPT.includes('el sexo se determina solo de la foto de genitales'));
  assert.ok(
    PROMPT.includes('no lo deduzcas del tamano ni de la forma del'),
    'lost the instruction not to infer sex from build',
  );
  // ⚠️ And what to do INSTEAD, which is the half a break probe found
  // uncovered. Without it the model can be told "sex comes from the genital
  // photo" and still return a body-shape guess — `sexFromGenitalPhoto: true`
  // on an animal it never saw the genitals of would walk straight past
  // decideSex, which trusts that flag.
  assert.ok(
    PROMPT.includes('pon sex en null, sexfromgenitalphoto en false'),
    'lost the instruction to return null rather than a guess when there is no genital photo',
  );
});

test('age still comes from the teeth, and a facial mask is still not grey hair', () => {
  // The documented misreading: a Lite-tier model read a white facial mask as
  // muzzle greying and aged a young adult at 6-8+ years.
  assert.ok(PROMPT.includes('la edad se estima solo de la foto de dientes'));
  assert.ok(
    PROMPT.includes('no es canas'),
    'lost the facial-mask warning — the exact error this project has been bitten by',
  );
});

test('age and weight are still RANGES, never a single number', () => {
  assert.ok(PROMPT.includes('nunca un numero unico'), 'lost the range requirement');
  assert.ok(
    PROMPT.includes('un rango en\nagemonthsmin y agemonthsmax') ||
      PROMPT.includes('agemonthsmin y agemonthsmax'),
    'lost the age range field instruction',
  );
});

test('weight is still barred from dosing', () => {
  // A weight read off a photograph must never reach an mg/kg calculation.
  assert.ok(PROMPT.includes('nunca para calcular una dosis'));
});

test('size still requires a scale reference', () => {
  // A lone chihuahua and a lone mastiff frame identically.
  assert.ok(PROMPT.includes('solo estima el tamano si hay algo en la foto que de escala'));
});

test('the model still may not diagnose', () => {
  assert.ok(PROMPT.includes('no diagnostiques y no sugieras tratamiento'));
});

test('the closing fence is still there', () => {
  // ⚠️ The framing sentence whose REMOVAL is the documented 11/11 → 9/11
  // failure: without a boundary the model pads the gap with invented content.
  assert.ok(
    PROMPT.includes('cualquier cosa que no este\nlistada arriba queda fuera') ||
      PROMPT.includes('queda fuera'),
    'lost the "anything not listed above is out of scope" fence',
  );
  assert.ok(PROMPT.includes('no inventes historia'));
});

test('the prompt still asks for neutral Spanish, because the model writes the UI', () => {
  // Free text from here is rendered verbatim as colorPattern, coatType and
  // generalObservations. A prompt written in voseo gets answers in voseo, and
  // that reaches the screen one API call later — invisible in a source review.
  assert.ok(PROMPT.includes('espanol neutro'));
  assert.ok(PROMPT.includes('nada de voseo'));
});

// ─── the 2026-09-10 specificity change ───────────────────────────────────────

test('the model is told to name a breed rather than a family', () => {
  assert.ok(
    PROMPT.includes('nombra razas concretas, no familias'),
    'lost the name-a-breed-not-a-family instruction',
  );
  // And it must apply to the PROSE field too. Scoring only resemblesBreeds
  // declared this fixed while every measured run still wrote "rasgos tipo
  // nordico" into visibleType, which is the sentence an admin reads.
  // ⚠️ The needle must be the SENTENCE, not the word "visibletype" — that word
  // appears all over the prompt, so a test for it passes with the instruction
  // deleted. A break probe caught exactly that here.
  assert.ok(
    PROMPT.includes('esto vale igual para visibletype'),
    'the name-a-breed rule no longer applies to the prose field an admin reads',
  );
});

test('the prompt does not name a family the eval fixture rejects', () => {
  // ⚠️ A NEGATIVE example leaks as surely as a positive one. Telling the model
  // "no digas «tipo nordico»" narrows it toward exactly the family the test
  // animal belongs to, and the visibleType check would then certify a hint
  // rather than a reading. The counter-examples must come from a different
  // family; the eval harness refuses to run if this is violated.
  for (const family of ['nordico', 'spitz', 'lobo']) {
    assert.ok(
      !new RegExp(`\\b${family}\\b`, 'u').test(PROMPT),
      `the prompt names "${family}", which the fixture rejects — that is a leak`,
    );
  }
});

test('the worked examples do not name a breed the fixture expects', () => {
  // Same rule, positive direction. The example used to be
  // ["pastor aleman", "husky siberiano"] and the only animal this project has
  // photographs of is husky-type.
  for (const breed of ['husky', 'malamute']) {
    assert.ok(
      !PROMPT.includes(breed),
      `the prompt names "${breed}", which is in the eval fixture's answer key`,
    );
  }
});

// ─── slot labels ─────────────────────────────────────────────────────────────

test('every photo slot has a Spanish label the prompt can announce', () => {
  // An unlabelled slot means the model has to work out which photo is which,
  // which is exactly what the labels were added to stop — age must come from
  // the teeth photo and nowhere else.
  for (const slot of ['front', 'side', 'teeth', 'genitals', 'other'] as const) {
    assert.ok(SLOT_LABEL[slot], `slot ${slot} has no label`);
  }
  assert.equal(SLOT_LABEL.teeth, 'dientes');
  assert.equal(SLOT_LABEL.genitals, 'genitales');
});

test('the labels the prompt names are the labels the code sends', () => {
  // The prompt tells the model to expect «frente», «perfil», «dientes» and
  // «genitales». If SLOT_LABEL drifts from that list the model is handed a
  // label it was never told about, and the slot-specific rules stop binding.
  for (const slot of ['front', 'side', 'teeth', 'genitals'] as const) {
    assert.ok(
      PROMPT.includes(fold(SLOT_LABEL[slot])),
      `the prompt never mentions the label "${SLOT_LABEL[slot]}" that ${slot} is sent as`,
    );
  }
});

test('the user instruction stays neutral and asks for nothing extra', () => {
  assert.ok(USER_INSTRUCTION.length > 0);
  assert.ok(!/\b(vos|sacá|poné|tenés|elegí)\b/u.test(USER_INSTRUCTION), 'voseo in the instruction');
});
