/**
 * Guards for the shelter's own artwork — the mark (Brand.tsx), the logotype
 * (Wordmark.tsx), the favicon and the style guide's copies of both.
 *
 * Until 2026-09-19 nothing in this repo touched the brand at all: the mark's
 * paths could be replaced with anything and every test stayed green. These
 * pin the three things that would otherwise turn false silently.
 *
 * 1. THE INVERTED-TRACE DEFECT. The artwork arrived as a white logo cut out of
 *    a full-canvas black rectangle. Re-import the supplied file without
 *    removing that rectangle and the header renders a jade BOX — a bug that
 *    looks like a styling mistake and is a geometry one.
 * 2. DRIFT BETWEEN THE COPIES. design/estilo.html carries its own <symbol> of
 *    both drawings. Nothing links it to the components, so it quietly keeps
 *    showing the old logo unless changed in the same breath. It did exactly
 *    that with the previous reconstruction.
 * 3. THE SYSTEM-DARK COLOUR BUG. Four older rules in globals.css define a dark
 *    value under [data-theme='dark'] only, so a visitor whose OS is dark and
 *    who never touched the toggle gets the dark page with the light colours.
 *    --brand-mark must not join them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// LF-normalised, so a CRLF checkout on Windows reads the same as CI.
const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

/** Every `d` attribute in a file, in order. */
function paths(source: string): string[] {
  return [...source.matchAll(/\sd="([^"]+)"/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
}

/** The one path each artwork file carries. */
function soloPath(file: string): string {
  const found = paths(read(file));
  assert.equal(found.length, 1, `${file} should hold exactly one path, found ${found.length}`);
  const [only] = found;
  assert.ok(only);
  return only;
}

/** The body of a <symbol id="..."> in the style guide. */
function symbol(id: string): string {
  const html = read('design/estilo.html');
  const match = html.match(new RegExp(`<symbol id="${id}"[\\s\\S]*?</symbol>`));
  assert.ok(match, `design/estilo.html no longer defines <symbol id="${id}">`);
  return match[0];
}

// ── 1. the inverted trace must not come back ───────────────────────────────

/**
 * The canvas rectangle is a closed subpath of straight lines only, spanning
 * the whole drawing. Detect it structurally rather than by matching the exact
 * coordinates of the file we happened to be given: a re-trace at another size
 * produces different numbers and the same defect.
 */
function straightLineOnlySubpaths(d: string): string[] {
  return d
    .split(/(?=[Mm])/)
    .filter((sub) => sub.trim())
    .filter((sub) => !/[CcSsQqTtAa]/.test(sub));
}

for (const [label, file] of [
  ['the mark', 'src/components/Brand.tsx'],
  ['the logotype', 'src/components/Wordmark.tsx'],
  ['the favicon', 'src/app/icon.svg'],
] as const) {
  test(`${label} carries no straight-line-only subpath — the traced canvas rectangle is gone`, () => {
    const rects = straightLineOnlySubpaths(soloPath(file));
    assert.deepEqual(
      rects,
      [],
      `${file} has a subpath made only of straight lines. The supplied artwork was an ` +
        `INVERTED trace: the logo is a hole in a full-canvas rectangle, and leaving that ` +
        `rectangle in renders a filled box instead of the mark. See the note in Brand.tsx.`,
    );
  });
}

test('the artwork is filled, never stroked — a stroke would not scale with size', () => {
  for (const file of ['src/components/Brand.tsx', 'src/components/Wordmark.tsx', 'src/app/icon.svg']) {
    assert.doesNotMatch(
      read(file),
      /stroke(-width)?[=:]/,
      `${file} declares a stroke. The traced artwork is all fill; a stroke width is in ` +
        `viewBox units and so renders at a different visual weight at every size.`,
    );
  }
});

// ── 2. the copies must not drift ───────────────────────────────────────────

test("the style guide's mark is the same geometry as Brand.tsx", () => {
  assert.equal(paths(symbol('mk'))[0], soloPath('src/components/Brand.tsx'));
});

test("the style guide's logotype is the same geometry as Wordmark.tsx", () => {
  assert.equal(paths(symbol('wm'))[0], soloPath('src/components/Wordmark.tsx'));
});

test('the favicon is the same geometry as the mark in the header', () => {
  assert.equal(soloPath('src/app/icon.svg'), soloPath('src/components/Brand.tsx'));
});

test('the mark and the logotype are different drawings', () => {
  // Cheap, but it is the assertion that fails if a generator is pointed at the
  // wrong source file — which produces two identical components and no error.
  assert.notEqual(soloPath('src/components/Brand.tsx'), soloPath('src/components/Wordmark.tsx'));
});

test('a transform and a viewBox travel together in every copy', () => {
  // The path data is in the trace's own units; the transform is what maps it
  // into the viewBox. Either one without the other renders nothing visible.
  for (const source of [
    read('src/components/Brand.tsx'),
    read('src/components/Wordmark.tsx'),
    read('src/app/icon.svg'),
    symbol('mk'),
    symbol('wm'),
  ]) {
    assert.match(source, /\sviewBox="0 0 \d+ \d+"/);
    // The leading \s is load-bearing: without it `data-transform="translate("`
    // satisfies the match, and a renamed attribute is exactly how the mapping
    // gets dropped. The break probe found this by not being caught.
    assert.match(source, /\stransform="translate\(-?[\d.]+,-?[\d.]+\) scale\(0\.1,-0\.1\)"/);
  }
});

// ── 3. the colour token, in both dark blocks ───────────────────────────────

test('--brand-mark is defined once on :root and in BOTH dark blocks', () => {
  const css = read('src/app/globals.css');
  const definitions = [...css.matchAll(/--brand-mark:\s*([^;]+);/g)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1].trim()],
  );
  assert.equal(
    definitions.length,
    3,
    'Expected --brand-mark on :root, on :root[data-theme="dark"] and inside the ' +
      '@media (prefers-color-scheme: dark) block. A dark value in only one of the last ' +
      'two leaves a system-dark visitor who never touched the toggle on the light colour.',
  );
  assert.equal(definitions[0], 'var(--jade)');
  assert.deepEqual(definitions.slice(1), ['var(--jade-light)', 'var(--jade-light)']);
});

test('the dark override sits inside the prefers-color-scheme block, not after it', () => {
  const css = read('src/app/globals.css');
  const media = css.match(/@media \(prefers-color-scheme: dark\) \{[\s\S]*?\n\}/);
  assert.ok(media, 'globals.css no longer has a prefers-color-scheme dark block');
  assert.match(media[0], /--brand-mark: var\(--jade-light\);/);
});

test('the mark defaults to the token rather than to jade directly', () => {
  assert.match(
    read('src/components/Brand.tsx'),
    /color = 'var\(--brand-mark\)'/,
    'Brand must default to --brand-mark, or it stays jade at night and loses half its contrast.',
  );
});

// ── 4. the wiring nothing else would catch ─────────────────────────────────

test('the header renders the logotype only when the shelter has one', () => {
  // A fork that leaves hasWordmark true with this artwork in place gets
  // "Wawitas" in its header whatever its config says its name is.
  const chrome = read('src/components/SiteChrome.tsx');
  assert.match(chrome, /SHELTER\.hasWordmark \? \(\s*<Wordmark/);
  assert.match(chrome, /\) : \(\s*<span className="header__name">/);
  assert.match(read('src/config/shelter.ts'), /hasWordmark: boolean;/);
});

test('the header link still carries the full organisation name', () => {
  // The logotype is a drawing: a screen reader and a crawler see nothing in
  // it. The accessible name has to come from the link.
  assert.match(read('src/components/SiteChrome.tsx'), /className="header__brand" aria-label=\{SHELTER\.name\}/);
});

test('the footer lockup takes its colour from the same token as the header', () => {
  const css = read('src/app/globals.css');
  const block = css.match(/\.site-footer__lockup \{[\s\S]*?\n\}/);
  assert.ok(block, 'globals.css no longer styles .site-footer__lockup');
  assert.match(block[0], /color: var\(--brand-mark\);/);
});

test('the header logotype is coloured by the token too', () => {
  const css = read('src/app/globals.css');
  const block = css.match(/\.header__wordmark \{[\s\S]*?\n\}/);
  assert.ok(block, 'globals.css no longer styles .header__wordmark');
  assert.match(block[0], /color: var\(--brand-mark\);/);
});

test('"Red de Apoyo" is never hung under the drawn logotype', () => {
  // The shelter asked for the logotype alone. The subtitle survives only on
  // the type-set fallback, where it is the second line of SHELTER.name and
  // not part of any artwork.
  const chrome = read('src/components/SiteChrome.tsx');
  const [, wordmarkBranch = ''] = chrome.match(/SHELTER\.hasWordmark \? \(([\s\S]*?)\) : \(/) ?? [];
  assert.ok(wordmarkBranch, 'the header no longer branches on hasWordmark');
  assert.doesNotMatch(wordmarkBranch, /<small>/);
  assert.doesNotMatch(wordmarkBranch, /rest/);
});
