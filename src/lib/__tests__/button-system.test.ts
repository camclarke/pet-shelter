/**
 * Guards for the button system in src/app/globals.css — «Tinta plana»,
 * approved 2026-10-15.
 *
 * What these protect, and why each one would otherwise turn false silently:
 *
 * 1. THE STATES. Until 2026-10-15 `.btn` had no :disabled, no :active and no
 *    focus ring of its own, so a disabled coral "Publicar" looked exactly like
 *    a working one. Each state is a rule nobody notices missing until a
 *    person taps a dead button.
 * 2. THE 19px FLOOR. Cream on jade (`.btn--brand`) is 3.45:1 by day. That is
 *    legal only as WCAG "large text" — bold at ≥ 18.66px (14pt). One
 *    well-meant `font-size: 13px` in a dense context makes it fail, and no
 *    visual review would call that a contrast bug. So: any rule that can
 *    reach a button and sets a smaller size must say "exempt" in its comment,
 *    and must not be able to reach `.btn--brand`.
 * 3. THE NIGHT TOKEN. `--line-strong` must exist in all three token blocks:
 *    `:root`, `:root[data-theme='dark']`, AND the system-dark media block.
 *    Older rules here set only the attribute form and broke for visitors whose
 *    OS is dark and who never touched the toggle.
 *
 * Source-level, because there is no CSS engine in the test run. The parser
 * below is deliberately small: it knows comments, at-rule blocks and plain
 * rules, which is everything globals.css uses. A control test proves the
 * floor check bites on a fabricated violation, so a green run here is not the
 * checker failing to look.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// LF-normalised, so a CRLF checkout on Windows reads the same as CI.
const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

// Overridable only so a break probe can point the suite at a mutated COPY
// rather than editing the real stylesheet and restoring it.
const CSS_PATH = process.env.BUTTON_SYSTEM_CSS ?? 'src/app/globals.css';
const LARGE_TEXT_BOLD_PX = 18.66;

interface Rule {
  selector: string;
  body: string;
  /** Every comment between the previous rule and the end of this one. */
  comment: string;
  /** The enclosing at-rule preludes, outermost first. */
  at: string[];
}

/** Flat list of style rules, each with its comments and enclosing at-rules. */
function parseCss(css: string): Rule[] {
  const rules: Rule[] = [];
  const at: string[] = [];
  let i = 0;
  let prelude = '';
  let comment = '';
  while (i < css.length) {
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      const stop = end === -1 ? css.length : end + 2;
      comment += css.slice(i, stop) + '\n';
      i = stop;
      continue;
    }
    const ch = css[i];
    if (ch === '{') {
      const head = prelude.trim();
      prelude = '';
      if (head.startsWith('@')) {
        at.push(head);
        i += 1;
        continue;
      }
      // A plain rule: read its body to the matching brace, keeping comments.
      let depth = 1;
      let j = i + 1;
      let body = '';
      while (j < css.length && depth > 0) {
        if (css.startsWith('/*', j)) {
          const end = css.indexOf('*/', j + 2);
          const stop = end === -1 ? css.length : end + 2;
          comment += css.slice(j, stop) + '\n';
          j = stop;
          continue;
        }
        const c = css[j];
        if (c === '{') depth += 1;
        if (c === '}') depth -= 1;
        if (depth > 0) body += c;
        j += 1;
      }
      rules.push({ selector: head.replace(/\s+/g, ' '), body, comment, at: [...at] });
      comment = '';
      i = j;
      continue;
    }
    if (ch === '}') {
      at.pop();
      prelude = '';
      comment = '';
      i += 1;
      continue;
    }
    if (ch === ';' && prelude.trim().startsWith('@')) {
      // A statement at-rule such as @import: not a block.
      prelude = '';
      i += 1;
      continue;
    }
    prelude += ch;
    i += 1;
  }
  return rules;
}

/** The px value of a font-size (or font shorthand) in a rule body, or null. */
function fontSizePx(body: string): number | null {
  const m =
    /(?:^|[;\s])font-size\s*:\s*([\d.]+)(px|rem)\b/.exec(body) ??
    /(?:^|[;\s])font\s*:[^;]*?\b([\d.]+)(px|rem)\b/.exec(body);
  if (!m || m[1] === undefined) return null;
  const n = Number(m[1]);
  return m[2] === 'rem' ? n * 16 : n;
}

/** The class names a selector names. */
function classesIn(selector: string): string[] {
  return [...selector.matchAll(/\.([a-zA-Z_][\w-]*)/g)].flatMap((m) => (m[1] ? [m[1]] : []));
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

/** Every string literal in the JSX source whose class tokens include a .btn. */
function buttonClassStrings(sources: string[]): string[][] {
  const out: string[][] = [];
  for (const src of sources) {
    for (const m of src.matchAll(/(['"`])((?:(?!\1)[^\n\\]|\\.)*)\1/g)) {
      const tokens = (m[2] ?? '').split(/\s+/).filter(Boolean);
      if (tokens.some((t) => t === 'btn' || t.startsWith('btn--'))) out.push(tokens);
    }
  }
  return out;
}

interface Context {
  /** Classes that sit on the same element as a .btn somewhere. */
  onButtons: Set<string>;
  /** Classes that sit on the same element as a .btn--brand somewhere. */
  onBrand: Set<string>;
  sources: string[];
}

function buildContext(): Context {
  const sources = walk('src').map(read);
  const strings = buttonClassStrings(sources);
  const onButtons = new Set<string>();
  const onBrand = new Set<string>();
  for (const tokens of strings) {
    for (const t of tokens) onButtons.add(t);
    if (tokens.includes('btn--brand')) for (const t of tokens) onBrand.add(t);
  }
  return { onButtons, onBrand, sources };
}

/**
 * Can this selector reach a .btn--brand? Conservative and honest about being
 * a heuristic: it names brand outright; or names a class that shares an
 * element with brand; or names a CONTAINER class whose JSX is followed, within
 * 1500 characters, by a btn--brand.
 */
function canReachBrand(selector: string, ctx: Context): boolean {
  if (/\.btn--brand\b/.test(selector)) return true;
  for (const cls of classesIn(selector)) {
    if (cls === 'btn' || cls.startsWith('btn--')) continue;
    if (ctx.onBrand.has(cls)) return true;
    if (ctx.onButtons.has(cls)) continue; // on the button itself, never with brand
    for (const src of ctx.sources) {
      let at = src.indexOf(cls);
      while (at !== -1) {
        if (src.slice(at, at + 1500).includes('btn--brand')) return true;
        at = src.indexOf(cls, at + cls.length);
      }
    }
  }
  return false;
}

interface Violation {
  selector: string;
  px: number;
  why: string;
}

/** Every rule that can reach a button and shrinks its type below 18.66px. */
function floorViolations(rules: Rule[], ctx: Context): Violation[] {
  const out: Violation[] = [];
  for (const rule of rules) {
    const reachesButton =
      /\.btn(?![\w])|\.btn--/.test(rule.selector) ||
      classesIn(rule.selector).some((c) => ctx.onButtons.has(c) && c !== 'btn' && !c.startsWith('btn--'));
    if (!reachesButton) continue;
    const px = fontSizePx(rule.body);
    if (px === null || px >= LARGE_TEXT_BOLD_PX) continue;
    if (!/exempt/i.test(rule.comment)) {
      out.push({ selector: rule.selector, px, why: 'no "exempt" comment' });
    } else if (canReachBrand(rule.selector, ctx)) {
      out.push({ selector: rule.selector, px, why: 'marked exempt but can reach .btn--brand' });
    }
  }
  return out;
}

const RULES = parseCss(read(CSS_PATH));
const CTX = buildContext();

const find = (pred: (r: Rule) => boolean) => RULES.filter(pred);
const topLevel = (r: Rule) => r.at.length === 0;

test('the parser sees the stylesheet (control)', () => {
  assert.ok(RULES.length > 300, `expected hundreds of rules, parsed ${RULES.length}`);
  assert.equal(find((r) => r.selector === '.btn' && topLevel(r)).length, 1, 'exactly one base .btn rule');
  assert.ok(CTX.onButtons.has('header__account'), 'JSX scan finds classes that sit on buttons');
  assert.ok(CTX.onBrand.has('view-all'), 'JSX scan finds classes that sit on brand buttons');
});

test('the base .btn is 19px Fraunces in sentence case', () => {
  const [base] = find((r) => r.selector === '.btn' && topLevel(r));
  assert.ok(base);
  const px = fontSizePx(base.body);
  assert.ok(px !== null && px >= LARGE_TEXT_BOLD_PX, `.btn font-size must be ≥ 18.66px, is ${px}`);
  assert.match(base.body, /font-family\s*:\s*var\(--display\)/);
  assert.match(base.body, /font-weight\s*:\s*700/);
  assert.doesNotMatch(base.body, /text-transform\s*:\s*uppercase/);
});

test('.btn has :disabled, :active and :focus-visible rules', () => {
  const has = (re: RegExp, decl: RegExp, label: string) => {
    const hits = find((r) => topLevel(r) && re.test(r.selector) && decl.test(r.body));
    assert.ok(hits.length > 0, `missing ${label}`);
  };
  has(/^\.btn:disabled$/, /cursor\s*:\s*not-allowed/, '.btn:disabled');
  has(/^\.btn:active(?![\w-])/, /transform/, '.btn:active (pressed moves down)');
  has(/^\.btn:focus-visible(?![\w-])/, /outline\s*:\s*3px solid var\(--jade-deep\)/, '.btn:focus-visible ring');
});

test('blocked-but-tappable is a GLOBAL .btn[aria-disabled] rule, not an intake-only one', () => {
  const global = find((r) => topLevel(r) && r.selector === ".btn[aria-disabled='true']");
  assert.equal(global.length, 1, "expected one global .btn[aria-disabled='true'] rule");
  assert.match(global[0]?.body ?? '', /cursor\s*:\s*pointer/, 'a blocked button still takes the tap');
  const scoped = find((r) => /\S\s+\.btn\[aria-disabled/.test(r.selector));
  assert.deepEqual(
    scoped.map((r) => r.selector),
    [],
    'a scoped aria-disabled rule is back; the global one replaces it',
  );
});

test('.btn--compact exists, is at least 44px tall, and keeps the type', () => {
  const [compact] = find((r) => topLevel(r) && r.selector === '.btn--compact');
  assert.ok(compact, '.btn--compact is missing');
  const m = /min-height\s*:\s*([\d.]+)px/.exec(compact.body);
  assert.ok(m && Number(m[1]) >= 44, `.btn--compact min-height must be ≥ 44px`);
  const px = fontSizePx(compact.body);
  assert.ok(px === null || px >= LARGE_TEXT_BOLD_PX, '.btn--compact must not shrink the type');
});

test('no rule shrinks a button below 18.66px unless exempt and unable to reach .btn--brand', () => {
  assert.deepEqual(floorViolations(RULES, CTX), []);
});

test('the floor check bites on fabricated violations (control)', () => {
  const fake = parseCss(
    [
      '.capture__actions .btn { font-size: 12px; }',
      '/* exempt: but it names brand */ .btn--brand { font-size: 14px; }',
      '/* exempt: header is always muted */ .header__account { font-size: 16px; }',
      '/* exempt: a class that sits on a brand button */ .view-all { font: 700 13px/1 serif; }',
    ].join('\n'),
  );
  const found = floorViolations(fake, CTX).map((v) => `${v.selector} (${v.why})`);
  assert.deepEqual(found, [
    '.capture__actions .btn (no "exempt" comment)',
    '.btn--brand (marked exempt but can reach .btn--brand)',
    '.view-all (marked exempt but can reach .btn--brand)',
  ]);
});

test('the text link has a 44px hit area and a disabled state', () => {
  const [link] = find((r) => topLevel(r) && r.selector === '.auth__link');
  assert.ok(link);
  const m = /min-height\s*:\s*([\d.]+)px/.exec(link.body);
  assert.ok(m && Number(m[1]) >= 44, '.auth__link min-height must be ≥ 44px');
  assert.ok(find((r) => topLevel(r) && r.selector === '.auth__link:disabled').length === 1);
});

test('--line-strong is defined in all three token blocks', () => {
  const defines = (r: Rule) => /--line-strong\s*:/.test(r.body);
  assert.ok(find((r) => topLevel(r) && r.selector === ':root' && defines(r)).length === 1, ':root');
  assert.ok(
    find((r) => topLevel(r) && r.selector === ":root[data-theme='dark']" && defines(r)).length === 1,
    ":root[data-theme='dark']",
  );
  assert.ok(
    find(
      (r) =>
        r.selector === ":root:not([data-theme='light'])" &&
        r.at.some((a) => /prefers-color-scheme\s*:\s*dark/.test(a)) &&
        defines(r),
    ).length === 1,
    "@media (prefers-color-scheme: dark) :root:not([data-theme='light'])",
  );
});
