import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { es } from '@/i18n/es';
import { findVoseo } from '../ai/spanish-register';
import { QR_PRINT_SIZE_MM, type TagTone } from '../qr-tokens';

/**
 * Guards that read SOURCE, because what they protect is wiring that no pure
 * function can see: which documents a server read touches, what a public page
 * imports, whether an image route could ever answer "does this token exist".
 *
 * Crude on purpose, and the only check available: there is no component-test
 * setup here, `pets-server.ts` imports `server-only`, and PR #26 (2026-09-02)
 * is the precedent — a value computed correctly and thrown away by the UI,
 * with every test green.
 */

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), 'utf8');

/** One exported function's source, from its signature to the next export. */
function exportedFunction(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const next = source.indexOf('\nexport ', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

// ─── the public-tier guard ───────────────────────────────────────────────────

test('PUBLIC-TIER GUARD: resolveQrTag reads qrTokens and pets, and no other collection', () => {
  const body = exportedFunction(read('src', 'lib', 'pets-server.ts'), 'resolveQrTag');

  const collections = [...body.matchAll(/\.collection(?:Group)?\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(collections.sort(), ['pets', 'qrTokens']);

  // No subcollection hop (`.doc(x).collection(...)`), no collection group, and
  // none of the finders that return more than the teaser.
  assert.doesNotMatch(body, /collectionGroup|getPetDetail|getSightings|findPetByMicrochip/);
  assert.doesNotMatch(body, /\.doc\([^)]*\)\s*\.collection\(/);
  for (const tier of ['identity', 'location', 'scans', 'custody', 'detail', 'medical', 'care', 'adoptions', 'users']) {
    assert.equal(new RegExp(`['"\`]${tier}['"\`]`).test(body), false, `resolveQrTag mentions ${tier}`);
  }

  // And it hands the decision to the pure, allowlisting resolver.
  assert.match(body, /return resolveTag\(/);
});

test('the tag page resolves only through resolveQrTag and never reaches Firestore itself', () => {
  const page = read('src', 'app', 'id', '[token]', 'page.tsx');
  const fromServer = /import\s*\{([^}]*)\}\s*from\s*'@\/lib\/pets-server'/.exec(page);
  assert.ok(fromServer, 'page does not import from pets-server');
  assert.deepEqual(
    fromServer[1]!
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
    ['resolveQrTag'],
  );
  assert.doesNotMatch(page, /firebase-admin|getAdminDb|firebase\/firestore/);
  assert.match(page, /return <ActiveTag view=\{view\} \/>;/);
});

test('the active tag renders only the allowlisted view, and hands the client link an id and a label', () => {
  const active = read('src', 'app', 'id', '[token]', 'ActiveTag.tsx');
  // Its only input is the active TagView, whose `pet` is PublicTagPet — never Pet.
  assert.match(active, /type ActiveView = Extract<TagView, \{ kind: 'active' \}>;/);
  assert.match(active, /export function ActiveTag\(\{ view \}: \{ view: ActiveView \}\)/);
  assert.doesNotMatch(active, /from '@\/lib\/types'|pets-server|firebase-admin|firebase\/firestore/);
  // The client component gets an id and a label — never the pet object.
  const links = [...active.matchAll(/<TagAdminLink[^>]*\/>/g)].map((m) => m[0]);
  assert.deepEqual(links, ['<TagAdminLink petId={view.petId} label={t.tag.adminLink} />']);
});

test('the fallback and not-found pages cannot carry pet data', () => {
  const fallback = read('src', 'app', 'id', '[token]', 'TagFallback.tsx');
  const notFound = read('src', 'app', 'id', '[token]', 'not-found.tsx');
  for (const source of [fallback, notFound]) {
    assert.doesNotMatch(source, /pets-server|PublicTagPet|from '@\/lib\/types'/);
  }
});

// ─── the image route is not an oracle ────────────────────────────────────────

test('the QR image route reads nothing, so it cannot answer whether a token exists', () => {
  const route = read('src', 'app', 'api', 'qr', '[token]', 'route.ts');
  const imports = [...route.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['@/config/shelter', '@/lib/qr-code', '@/lib/qr-tokens']);
});

// ─── printed size ────────────────────────────────────────────────────────────

test('the printed symbol is at least 20 mm without its quiet zone, and the CSS prints that size', () => {
  for (const modules of [29, 33, 37]) {
    const symbolMm = (QR_PRINT_SIZE_MM * modules) / (modules + 8);
    assert.ok(symbolMm >= 20, `${modules} modules → ${symbolMm.toFixed(2)} mm`);
  }
  const css = read('src', 'app', 'globals.css');
  const rule = /\.qr-tag__code\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, '.qr-tag__code rule not found');
  assert.match(rule[1]!, new RegExp(`width:\\s*${QR_PRINT_SIZE_MM}mm`));
  assert.match(rule[1]!, new RegExp(`height:\\s*${QR_PRINT_SIZE_MM}mm`));
});

// ─── the copy ────────────────────────────────────────────────────────────────

const TONES: TagTone[] = ['lost', 'adopted', 'available', 'in-care'];
const CODE = 'ABCDE-FGHJK';

function everyTagString(): string[] {
  const out: string[] = [];
  for (const value of Object.values(es.tag)) if (typeof value === 'string') out.push(value);
  for (const sex of ['female', 'male'] as const) {
    out.push(es.tag.lostBanner('Luna', sex), es.tag.microchipHint(sex));
    for (const tone of TONES) {
      out.push(es.tag.situation(tone, 'Luna', sex, 'Wawitas'));
      out.push(es.tag.finderMessage({ name: 'Luna', sex, formattedToken: CODE, tone }));
    }
  }
  out.push(
    es.tag.meetLink('Luna'),
    es.tag.phoneLine('77903553'),
    es.tag.codeLine(CODE),
    es.tag.inactiveBody('Wawitas'),
    es.tag.inactiveMessage(CODE, 'Wawitas'),
    es.tag.unknownBody('Wawitas'),
    es.tag.unknownMessage('Wawitas'),
    es.tag.activeSince(CODE, '12 sept 2026'),
    es.tag.revokedOn(CODE, '12 sept 2026'),
    es.tag.alsoActive(CODE, '12 sept 2026'),
    es.tag.revokeConfirm(CODE),
    es.tag.reissueConfirm(CODE),
    es.tag.printSize(26),
    es.tag.qrAlt('Luna'),
    es.tag.printTitle('Luna'),
    es.tag.issueMissing(1),
    es.tag.issueMissing(3),
    es.tag.printSheet(1),
    es.tag.printSheet(3),
  );
  return out;
}

test('no tag copy speaks voseo', () => {
  // The shared list, plus the vos forms of the exact verbs this copy uses in
  // tú — the ones a careless edit would turn into voseo.
  const local = /(?<![\p{L}])(?:escribinos|revisá|marcá|emití|emitila|imprimí|confirmá|conocé|llevalo|llevala|escaneala|cambiala|poné)(?![\p{L}])/iu;
  const strings = everyTagString();
  assert.ok(strings.length > 60, `only ${strings.length} strings checked`);
  for (const text of strings) {
    assert.deepEqual(findVoseo(text), [], text);
    assert.equal(local.test(text), false, text);
  }
});

test('the lost line and the situation agree with the animal’s sex', () => {
  assert.equal(es.tag.lostBanner('Luna', 'female'), '¡Luna está perdida!');
  assert.equal(es.tag.lostBanner('Toby', 'male'), '¡Toby está perdido!');
  assert.match(es.tag.situation('adopted', 'Luna', 'female', 'Wawitas'), /la encontraste sola/);
  assert.match(es.tag.situation('adopted', 'Toby', 'male', 'Wawitas'), /lo encontraste solo/);
  assert.match(es.tag.situation('available', 'Luna', 'female', 'Wawitas'), /buscarla/);
  assert.match(es.tag.situation('in-care', 'Toby', 'male', 'Wawitas'), /buscarlo/);
  assert.match(es.tag.microchipHint('female'), /llévala/);
});

test('the finder message carries the printed code, and says "lost" only for a lost animal', () => {
  for (const tone of TONES) {
    const message = es.tag.finderMessage({ name: 'Luna', sex: 'female', formattedToken: CODE, tone });
    assert.match(message, /ABCDE-FGHJK/, tone);
    assert.equal(/perdida/.test(message), tone === 'lost', tone);
  }
  assert.match(es.tag.inactiveMessage(CODE, 'Wawitas'), /ABCDE-FGHJK/);
});

test('no public tag copy promises to hand over a family’s details', () => {
  for (const sex of ['female', 'male'] as const) {
    for (const tone of TONES) {
      const text = es.tag.situation(tone, 'Luna', sex, 'Wawitas');
      assert.doesNotMatch(text, /direcci|dueñ|número de su familia|te (?:pasamos|damos)/i, `${tone}/${sex}`);
    }
  }
});

test('the admin copy states the honest limitation: a collar comes off, neither is a tracker', () => {
  assert.match(es.tag.limitation, /collar se cae o se quita/);
  assert.match(es.tag.limitation, /microchip va bajo la piel/);
  assert.match(es.tag.limitation, /Ninguno de los dos es un rastreador/);
});
