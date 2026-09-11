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
