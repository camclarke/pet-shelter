import { test } from 'node:test';
import assert from 'node:assert/strict';

import { es } from '@/i18n/es';

/**
 * The first tests this project has had over `src/i18n`.
 *
 * Everything in that directory is visitor-facing copy, most of which is a
 * lookup table where a test would only assert a string back at itself. This
 * file covers the one piece that is genuinely a DECISION: how much breed copy
 * an adoption-wall card can carry, and where to cut it.
 *
 * The budget is measured — see BREED_LINE_MAX_CHARS in `es.ts` for the
 * numbers and the conditions they were taken under. These tests pin the
 * BEHAVIOUR around that budget, so a future re-measure changes one constant
 * and the rules below still hold.
 */

/** The real ground truth: the animal in `_e2e/`, as the wizard composes it. */
const GROUND_TRUTH = 'mestiza con rasgos de husky siberiano y alaskan malamute';

test('the breed a card cannot show is the one reason this line exists', () => {
  // 56 characters. It measured at two lines at 360px, so it must survive
  // whole — truncating it here would throw away the second resemblance,
  // which is half of why the line was added to the card at all.
  assert.equal(GROUND_TRUTH.length, 56);
  assert.equal(es.formatBreedLine(GROUND_TRUTH), GROUND_TRUTH);
});

test('a short breed passes through untouched', () => {
  assert.equal(es.formatBreedLine('mestiza'), 'mestiza');
  assert.equal(es.formatBreedLine('labrador retriever'), 'labrador retriever');
});

test('an absent breed yields null so the card omits the line', () => {
  // Not an empty string: the caller renders the element conditionally, and an
  // empty <div> would still pay its margin.
  assert.equal(es.formatBreedLine(''), null);
  assert.equal(es.formatBreedLine('   '), null);
  assert.equal(es.formatBreedLine('\n\t '), null);
});

test('surrounding and internal whitespace is normalised before measuring', () => {
  // A breed typed on a phone routinely carries a trailing space, and a double
  // space would make the rendered line wider than its character count claims.
  assert.equal(es.formatBreedLine('  mestizo  con   rasgos '), 'mestizo con rasgos');
});

test('an over-budget breed is cut on a word boundary, never mid-word', () => {
  const long =
    'mestizo con rasgos de pastor alemán, husky siberiano, alaskan malamute y border collie';
  const out = es.formatBreedLine(long);
  assert.ok(out !== null);
  assert.ok(out.endsWith('…'), `expected an ellipsis, got ${JSON.stringify(out)}`);

  // The kept text must be a whole-word prefix of the original. If the cut
  // landed inside a word, the last kept token would not appear in the source
  // followed by a space.
  const kept = out.slice(0, -1);
  assert.ok(
    long.startsWith(kept),
    `truncation must be a prefix of the input, got ${JSON.stringify(kept)}`,
  );
  const nextChar = long.charAt(kept.length);
  assert.ok(
    nextChar === '' || nextChar === ' ' || nextChar === ',',
    `cut landed mid-word: ${JSON.stringify(long.slice(kept.length - 3, kept.length + 3))}`,
  );
});

test('the truncated line still fits the measured two-line budget', () => {
  const long =
    'mestizo con rasgos de pastor alemán, husky siberiano, alaskan malamute y border collie';
  const out = es.formatBreedLine(long);
  assert.ok(out !== null);
  // Including the ellipsis. The ellipsis is one character and is rendered, so
  // a budget that excluded it would be a budget that is wrong by one glyph.
  assert.ok(
    out.length <= 66,
    `truncated to ${out.length} chars, over the measured 66: ${JSON.stringify(out)}`,
  );
});

test('a dangling connector is dropped rather than left before the ellipsis', () => {
  // Spanish joins the final item with " y". Cutting just after it leaves
  // "…husky siberiano y…", which reads as a rendering fault rather than as a
  // list that continues.
  //
  // ⚠️ This input is CONSTRUCTED so the word-boundary cut lands immediately
  // after that " y" — the next breed name is long enough not to fit. The
  // obvious-looking string does NOT exercise this path: the first version of
  // this test cut after "alaskan" and passed while the strip was deleted.
  // Asserting the exact output is what keeps that honest.
  const out = es.formatBreedLine(
    'mestizo con rasgos de pastor alemán, husky siberiano y bullmastiff napolitano',
  );
  assert.equal(out, 'mestizo con rasgos de pastor alemán, husky siberiano…');
  assert.ok(out !== null && !/\sy…$/u.test(out), `left a dangling "y": ${JSON.stringify(out)}`);
});

test('a dangling comma is dropped too', () => {
  // Same shape, one separator over: the cut lands after "alemán," and
  // "…pastor alemán,…" is the same rendering fault as the dangling "y".
  const out = es.formatBreedLine(
    'mestizo con rasgos de pastor alemán, bullmastiff napolitano y border collie',
  );
  assert.ok(out !== null);
  assert.ok(!/[,;]…$/u.test(out), `left a dangling separator: ${JSON.stringify(out)}`);
});

test('a single word longer than the whole budget still renders something', () => {
  // Not realistic Spanish breed copy, but reachable by typing — and returning
  // an empty line for it would be a blank card where a blank line is worse
  // than a clipped one.
  const out = es.formatBreedLine('a'.repeat(200));
  assert.ok(out !== null);
  assert.ok(out.length <= 66, `got ${out.length} chars`);
  assert.ok(out.endsWith('…'));
});

test('a breed exactly at the budget is not truncated', () => {
  // Off-by-one guard on the boundary itself: at the limit there is nothing to
  // cut, and appending an ellipsis would cost a character the line can afford.
  const exact = 'mestizo con rasgos de pastor aleman y husky siberiano y otro mas';
  assert.equal(exact.length, 64);
  const padded = `${exact}xx`;
  assert.equal(padded.length, 66);
  assert.equal(es.formatBreedLine(padded), padded);
});

test('formatMeta still does NOT carry the breed', () => {
  // Three of formatMeta's five call sites already render `pet.breed`
  // themselves — the admin dashboard, the re-admission card and the chip-match
  // card all print `{breed} · {formatMeta(pet)}`. Folding breed in here would
  // print it twice on each of them, which is why the card got its own
  // function instead.
  const meta = es.formatMeta({ ageMonths: 36, sex: 'female', size: 'medium' });
  assert.equal(meta, '3 años · hembra · mediana');
  assert.ok(!meta.includes('mestiz'));
});

// ─── the sex gate on the breed field ─────────────────────────────────────────

/**
 * ⚠️ These pin a fix for a MEASURED reporting failure, not a style preference.
 *
 * The breed offer is gated behind sex, because Spanish cannot spell
 * "mestizo"/"mestiza" without it. The note explaining that gate used to say
 * only "pick sex first", so the resemblances the model had already read sat in
 * state with nothing on screen — and on 2026-09-12 that was reported as the
 * model having missed a breed. It had not: the eval scored 12/12 that day with
 * both breeds named. The reading was right and invisible.
 *
 * So the load-bearing property is that the note NAMES every resemblance it was
 * given. A note that explains the gate without naming them is the bug.
 */

test('the sex-gate note names every resemblance it was given', () => {
  const note = es.breedNeedsSexFirst(['husky siberiano', 'alaskan malamute']);
  // BOTH. Naming only the first is the exact failure this replaced: the
  // model's prose field mentioned one breed and the owner concluded the
  // second had not been read.
  assert.ok(note.includes('husky siberiano'), 'dropped the first resemblance');
  assert.ok(note.includes('alaskan malamute'), 'dropped the second resemblance');
});

test('the sex-gate note still explains WHY the field is gated', () => {
  // The note has two jobs and the original one is still required: an admin who
  // is only told what is waiting, and not that the sex is what unlocks it, has
  // no idea what to do next.
  const note = es.breedNeedsSexFirst(['husky siberiano']);
  assert.ok(note.includes('sexo'), 'lost the instruction to choose the sex first');
  assert.ok(
    note.includes('mestizo') && note.includes('mestiza'),
    'lost the reason — that the word itself changes with the sex',
  );
});

test('the note frames a resemblance as a resemblance, never as the breed', () => {
  // The whole breed design fails toward mestizo, and this note appears BEFORE
  // a human has accepted anything. Wording it as a claim would undo that in
  // the one place the admin is most likely to read it.
  const note = es.breedNeedsSexFirst(['husky siberiano']);
  assert.ok(note.includes('Se parece a'), 'the note asserts a breed instead of a resemblance');
  assert.ok(!/\bes husky\b/u.test(note), 'the note states the breed as fact');
});

test('two resemblances are joined with "y", not a trailing comma', () => {
  // Same rule as mixedBreedWithTraits. "husky siberiano, alaskan malamute"
  // reads as a truncated list in Spanish.
  const note = es.breedNeedsSexFirst(['husky siberiano', 'alaskan malamute']);
  assert.ok(note.includes('husky siberiano y alaskan malamute'));
});

test('three resemblances keep commas and a final "y"', () => {
  // normalizeResembles caps at MAX_RESEMBLES = 2 today, so this is unreachable
  // from the wizard. It is pinned because the cap is a constant someone may
  // raise, and the join is the thing that would silently read wrong if so.
  const note = es.breedNeedsSexFirst(['pastor alemán', 'labrador', 'bóxer']);
  assert.ok(note.includes('pastor alemán, labrador y bóxer'));
});

test('no resemblances degrades to the explanation alone', () => {
  // The model is allowed to return an empty list — that is a documented honest
  // answer. The note must not then promise something it cannot show, or claim
  // the animal resembles nothing.
  const note = es.breedNeedsSexFirst([]);
  assert.ok(!note.includes('Se parece a'), 'promised resemblances it does not have');
  assert.ok(note.includes('sexo'), 'lost the explanation in the empty case');
});

/**
 * ⚠️ A SOURCE-LEVEL guard, and the reason is this project's own history.
 *
 * PR #26 (2026-09-02) fixed exactly this bug class: `reviewSuggestion`
 * computed `sex`, and the wizard threw it away — the value was retrieved and
 * never delivered, and every test stayed green because the pure layer was
 * correct. The defect being fixed here is the same shape one field over: the
 * resemblances were read, normalised and held in state, and the UI showed
 * nothing.
 *
 * So a perfect `breedNeedsSexFirst` proves nothing on its own. There is no
 * component-test setup in this repo and `/admin/intake` sits behind
 * `AdminGate`, which needs a human password — so reading the source is the
 * only check available, and no check at all is how #26 happened twice.
 *
 * It is deliberately crude: it asserts the call EXISTS and that the string it
 * replaced is gone. It cannot prove the note renders. Say that rather than
 * implying more.
 */
test('the wizard actually calls the note, rather than composing its own', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const src = readFileSync(
    join(process.cwd(), 'src', 'app', 'admin', 'intake', 'IntakeWizard.tsx'),
    'utf8',
  );

  assert.ok(
    src.includes('t.breedNeedsSexFirst(resembles)'),
    'the breed field no longer asks i18n for its note — the resemblances are invisible again',
  );
  // The inline string this replaced. Leaving it behind would mean two sources
  // of truth, and the stale one is the one without the breed names in it.
  assert.ok(
    !src.includes('Elige primero el sexo: la palabra cambia'),
    'the old inline note is still in the component; it does not name the resemblances',
  );
});
