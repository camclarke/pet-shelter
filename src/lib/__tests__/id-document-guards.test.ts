/**
 * Guards for the adoption ID photo (portion 4b): the "received" predicate and
 * the badge (pure), and SOURCE-level checks on the wiring a refactor could
 * silently break — the same honest-about-it shape as application-wiring.test.ts.
 * These assert that code EXISTS (or does not) in a given form; they can be
 * evaded by indirection, and they exist because nothing else would notice.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { idDocumentBadge, idDocumentComplete, isIdentityErased, isReceivedMarker } from '../applications';
import { ID_DOCUMENT_ROOT } from '../id-document-paths';
import { findVoseo } from '../ai/spanish-register';
import { es } from '@/i18n/es';

const ROOT = process.cwd();

// ─── the one "received" check ────────────────────────────────────────────────

test('isReceivedMarker: a plain object is a receipt, and NOTHING else is', () => {
  class Timestampish {
    seconds = 1;
  }
  assert.equal(isReceivedMarker({ receivedAt: 1, bytes: 900, generation: '1' }), true);
  assert.equal(isReceivedMarker({}), true, '`{}` is a map to the rules too');
  assert.equal(isReceivedMarker(Object.create(null)), true);
  for (const value of [null, undefined, false, true, 0, 1, '', 'yes', [], [1], new Date(), new Timestampish(), () => 1]) {
    assert.equal(isReceivedMarker(value), false, String(value));
  }
});

test('idDocumentComplete uses it: `false` is NOT a received photo (critic #3)', () => {
  const receipt = { receivedAt: 1, bytes: 900, generation: '1' };
  assert.equal(idDocumentComplete({ front: receipt }, ['front']), true);
  for (const front of [false, 0, 'x', [], null, undefined, true]) {
    assert.equal(idDocumentComplete({ front }, ['front']), false, String(front));
  }
  assert.equal(idDocumentComplete('front' as never, ['front']), false);
});

test("the rules' idDocumentReceived() is still `is map` — the predicate the code mirrors", () => {
  const rules = readFileSync(join(ROOT, 'firestore.rules'), 'utf8');
  assert.match(rules, /function idDocumentReceived\(\) \{\s*return resource\.data\.idDocument\.get\('front', null\) is map;\s*\}/);
});

// ─── the queue badge: three states ───────────────────────────────────────────

test('idDocumentBadge: erased first, then "Sin carnet" only while open, otherwise nothing', () => {
  const receipt = { receivedAt: 1, bytes: 900, generation: '1' };
  const base = { status: 'submitted' as const, idDocument: { front: null }, identityErased: false };
  assert.equal(idDocumentBadge(base, ['front']), 'missing');
  assert.equal(idDocumentBadge({ ...base, status: 'interview' }, ['front']), 'missing');
  assert.equal(idDocumentBadge({ ...base, idDocument: { front: false } as never }, ['front']), 'missing');
  assert.equal(idDocumentBadge({ ...base, idDocument: { front: receipt } }, ['front']), null);
  for (const status of ['approved', 'rejected', 'withdrawn'] as const) {
    assert.equal(idDocumentBadge({ ...base, status }, ['front']), null, `${status}: nothing to chase`);
  }
  // A rejection reopened after the erase is open AND erased: "Sin carnet"
  // would invite an upload the route refuses with 409 erased.
  assert.equal(idDocumentBadge({ ...base, status: 'reviewing', identityErased: true }, ['front']), 'erased');
  assert.equal(idDocumentBadge({ ...base, status: 'rejected', identityErased: true }, ['front']), 'erased');
});

// ─── the one "erased" check (review 4b #7) ───────────────────────────────────

test('isIdentityErased: anything but null or missing is erased — a Timestamp, and every other shape too', () => {
  class Timestampish {
    seconds = 1;
    toMillis() {
      return 1000;
    }
  }
  for (const value of [new Timestampish(), { seconds: 5 }, 1, 0, '2026-10-16', '', true, false, [], {}]) {
    assert.equal(isIdentityErased(value), true, JSON.stringify(value) ?? String(value));
  }
  assert.equal(isIdentityErased(null), false);
  assert.equal(isIdentityErased(undefined), false);
});

test('the upload route, the admin record and the review screen all decide "erased" through isIdentityErased', () => {
  const handler = code('src/lib/id-document-handler.ts');
  assert.match(handler, /isIdentityErased\(application\.identityErasedAt\)/, 'the handler must use the shared predicate');
  assert.ok(!/identityErasedAt\s*!==?\s*(null|undefined)/.test(handler), 'the handler has its own copy of the check');

  const admin = code('src/lib/applications-admin.ts');
  assert.match(admin, /identityErased:\s*isIdentityErased\(data\.identityErasedAt\)/, 'the admin record must use the shared predicate');

  const pure = code('src/lib/applications.ts');
  const own = pure.match(/identityErasedAt\s*!==?\s*(null|undefined)/g) ?? [];
  assert.equal(own.length, 2, 'applications.ts compares identityErasedAt in exactly one place: isIdentityErased');

  // The screens decide on the boolean, never on the display timestamp.
  for (const file of [
    'src/app/admin/applications/[applicationId]/ApplicationReview.tsx',
    'src/app/admin/applications/ApplicationsQueue.tsx',
  ]) {
    assert.ok(!/identityErasedAt\s*!==?\s*null/.test(code(file)), `${file} decides "erased" on identityErasedAt`);
  }
  assert.match(code('src/app/admin/applications/[applicationId]/ApplicationReview.tsx'), /application\.identityErased\b/);
});

test('the badge and review copy is neutral Spanish, and the badge words are the agreed ones', () => {
  const c = es.applications;
  assert.equal(c.badgeIdMissing, 'Sin carnet');
  assert.equal(c.badgeIdErased, 'Datos borrados');
  const texts = [
    c.badgeIdMissing,
    c.badgeIdErased,
    c.identityTitle,
    c.idDocumentSideLabel('front'),
    c.idDocumentSideLabel('back'),
    c.idDocumentShow,
    c.idDocumentHide,
    c.idDocumentLoading,
    c.idDocumentReceivedOn('3 sep 2026'),
    c.idDocumentMissing(true),
    c.idDocumentMissing(false),
    c.idDocumentHandling,
    c.idDocumentFailed('wawitas.org'),
    c.idDocumentRefused,
    c.idDocumentAlt,
    c.identityErased('3 sep 2026'),
    c.homeTitle,
    c.homeMissing,
    c.homeReference('frente a la cancha'),
    c.homePin('-17.3935', '-66.1570'),
    c.homeNoPin,
    c.homeCorrectedOn('3 sep 2026'),
    c.homeLoadFailed,
  ];
  for (const text of texts) {
    assert.ok(text.trim() !== '', 'empty copy');
    assert.deepEqual(findVoseo(text), [], text);
  }
});

// ─── source helpers ──────────────────────────────────────────────────────────

function walk(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') out.push(...walk(path, keep));
    } else if (keep(entry.name)) {
      out.push(relative(ROOT, path).split(sep).join('/'));
    }
  }
  return out.sort();
}

const SOURCES = walk(join(ROOT, 'src'), (name) => /\.tsx?$/.test(name));

/** Source with comments removed, so a comment naming a call cannot satisfy or trip a check. */
function code(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The local files `file` imports — static, re-exported, type-only and dynamic — resolved. */
function localImports(file: string): string[] {
  const src = code(file);
  const specifiers = [
    ...src.matchAll(/(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]/g),
    ...src.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
  ].map((m) => m[1]!);
  const out: string[] = [];
  for (const spec of specifiers) {
    let base: string;
    if (spec.startsWith('@/')) base = join('src', spec.slice(2));
    else if (spec.startsWith('.')) base = join(dirname(file), spec);
    else continue; // a package
    const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].map((p) => p.split(sep).join('/'));
    const found = candidates.find((p) => SOURCES.includes(p));
    assert.ok(found, `${file} imports ${spec}, which resolves to no source file — the walk is broken`);
    out.push(found);
  }
  return out;
}

function closure(file: string): string[] {
  const seen = new Set<string>();
  const queue = [file];
  while (queue.length > 0) {
    const next = queue.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...localImports(next));
  }
  return [...seen].sort();
}

/** Every file that BUILDS an adoption-ids path, or stores or reads one server-side. */
function idDocumentModules(): string[] {
  return SOURCES.filter((file) => {
    const src = code(file);
    return (
      src.includes(ID_DOCUMENT_ROOT) ||
      /\bidDocument(Path|Prefix)\(/.test(src) ||
      /from\s*['"][^'"]*id-document-store['"]/.test(src)
    );
  });
}

// ─── no download token, ever ─────────────────────────────────────────────────

test('the walk finds the ID-photo modules (control: a vacuous guard would pass on nothing)', () => {
  const modules = idDocumentModules();
  for (const expected of [
    'src/lib/id-document-paths.ts',
    'src/lib/id-document-store.ts',
    'src/lib/id-document-admin.ts',
    'src/app/api/adoption-applications/[applicationId]/id-document/[side]/route.ts',
  ]) {
    assert.ok(modules.includes(expected), `${expected} is not seen as an ID-photo module`);
  }
  // The closure walk itself reaches through imports (control).
  assert.ok(closure('src/lib/id-document-admin.ts').includes('src/lib/firebase-client.ts'));
});

test('no file that builds or stores an ID-photo path can reach getDownloadURL or pets-admin, even transitively (critic #11)', () => {
  for (const module of idDocumentModules()) {
    for (const file of closure(module)) {
      assert.ok(
        !/\bgetDownloadURL\b/.test(code(file)),
        `${module} reaches ${file}, which uses getDownloadURL — a token no rule can revoke`,
      );
      assert.ok(
        !file.endsWith('/pets-admin.ts'),
        `${module} reaches pets-admin.ts, which imports getDownloadURL and fetches by URL`,
      );
    }
  }
});

test('the viewer imports exactly getBlob and ref from Firebase Storage, and nothing else Storage', () => {
  const src = code('src/lib/id-document-admin.ts');
  const storageImports = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]firebase\/storage['"]/g)];
  assert.equal(storageImports.length, 1, 'one import from firebase/storage');
  const names = storageImports[0]![1]!.split(',').map((n) => n.trim()).filter(Boolean).sort();
  assert.deepEqual(names, ['getBlob', 'ref']);
  assert.ok(!/firebase-admin/.test(src), 'the browser viewer must not touch the Admin SDK');
});

test('only the three ID-photo modules build a path — a new one must be added here on purpose', () => {
  const builders = SOURCES.filter((file) => /\bidDocument(Path|Prefix)\(/.test(code(file)));
  assert.deepEqual(builders, [
    'src/lib/id-document-admin.ts',
    'src/lib/id-document-paths.ts',
    'src/lib/id-document-store.ts',
  ]);
  const literal = SOURCES.filter((file) => code(file).includes(`'${ID_DOCUMENT_ROOT}`) || code(file).includes(`\`${ID_DOCUMENT_ROOT}`));
  assert.deepEqual(literal, ['src/lib/id-document-paths.ts'], 'the prefix is spelled once');
});

// ─── the APPLICANT never touches Storage (portion 4c-2) ──────────────────────
// Plan §6 4c-2, critic #11: the applicant's photo goes to the upload route,
// never through the Firebase Storage client — a client upload auto-mints a
// download token no rule can revoke — and nothing on the applicant side may
// reach `getDownloadURL` or `pets-admin.ts`, even transitively.

/**
 * Every module the applicant's BROWSER runs — the roots of the walk. The apply
 * page itself is a Server Component (it reads the public pet through the Admin
 * SDK), so it is not a root; everything it hands to the browser is.
 */
const APPLICANT_ROOTS = [
  'src/app/adopt/[slug]/apply/ApplicationForm.tsx',
  'src/app/adopt/[slug]/apply/ApplicationStepper.tsx',
  'src/app/adopt/[slug]/apply/ApplicationFields.tsx',
  'src/app/adopt/[slug]/apply/ApplicationSent.tsx',
  'src/app/adopt/[slug]/apply/ContractText.tsx',
  'src/app/adopt/[slug]/apply/HomeStep.tsx',
  'src/app/adopt/[slug]/apply/IdPhotoStep.tsx',
  'src/app/adopt/[slug]/apply/ReviewStep.tsx',
  'src/app/adopt/contract/page.tsx',
  'src/app/account/MyApplications.tsx',
  'src/lib/applications-client.ts',
  'src/lib/id-document-client.ts',
];

/**
 * The local files `file` imports AT RUNTIME: like `localImports`, minus the
 * statements TypeScript erases — `import type`, `export type`, and an
 * `import { type A, type B }` whose every name is a type. Without this the
 * walk would follow `@/i18n`'s type-only imports into half of `src/lib` and
 * report modules no browser ever loads.
 */
function runtimeImports(file: string): string[] {
  const src = code(file);
  const specifiers: string[] = [];
  for (const m of src.matchAll(/(?:^|[\s;])(import|export)\s+(type\s+)?([^'";]*?)from\s*['"]([^'"]+)['"]/g)) {
    if (m[2]) continue; // import type … / export type …
    const clause = m[3]!.trim();
    const braces = /^\{([^}]*)\}$/.exec(clause);
    if (braces) {
      const names = braces[1]!.split(',').map((n) => n.trim()).filter(Boolean);
      if (names.length > 0 && names.every((n) => n.startsWith('type '))) continue;
    }
    specifiers.push(m[4]!);
  }
  for (const m of src.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(m[1]!);
  for (const m of src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) specifiers.push(m[1]!);
  const out: string[] = [];
  for (const spec of specifiers) {
    let base: string;
    if (spec.startsWith('@/')) base = join('src', spec.slice(2));
    else if (spec.startsWith('.')) base = join(dirname(file), spec);
    else continue;
    const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].map((p) => p.split(sep).join('/'));
    const found = candidates.find((p) => SOURCES.includes(p));
    assert.ok(found, `${file} imports ${spec}, which resolves to no source file — the walk is broken`);
    out.push(found);
  }
  return out;
}

function runtimeClosure(file: string): string[] {
  const seen = new Set<string>();
  const queue = [file];
  while (queue.length > 0) {
    const next = queue.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...runtimeImports(next));
  }
  return [...seen].sort();
}

/** Where the Storage client is initialised — and only initialised. */
const STORAGE_INIT = 'src/lib/firebase-client.ts';

test('the applicant walk is not vacuous (controls)', () => {
  const stepper = runtimeClosure('src/app/adopt/[slug]/apply/ApplicationStepper.tsx');
  for (const expected of [
    'src/lib/application-steps.ts',
    'src/lib/applications.ts',
    'src/lib/id-document-client.ts',
    'src/lib/id-document-protocol.ts',
    'src/lib/jpeg-inspect.ts',
    'src/lib/image-strip.ts',
    'src/app/adopt/[slug]/apply/ContractText.tsx',
  ]) {
    assert.ok(stepper.includes(expected), `the stepper's closure does not reach ${expected}`);
  }
  // The dynamic import of the client is followed, and so the one Storage
  // initialiser is in reach — which is what makes its exemption below mean
  // something.
  const form = runtimeClosure('src/app/adopt/[slug]/apply/ApplicationForm.tsx');
  assert.ok(form.includes('src/lib/applications-client.ts'), 'the dynamic import is not followed');
  assert.ok(form.includes(STORAGE_INIT));
  // A type-only import is skipped, and a value import is not.
  assert.ok(localImports('src/i18n/es.ts').includes('src/lib/card-extract-client.ts'), 'control: es.ts type-imports it');
  assert.ok(!runtimeImports('src/i18n/es.ts').includes('src/lib/card-extract-client.ts'), 'a type-only import was followed');
  assert.ok(runtimeImports('src/i18n/es.ts').includes('src/lib/placements.ts'), 'a value import was skipped');
});

test('no applicant module can reach Firebase Storage, getDownloadURL or pets-admin, even transitively (critic #11)', () => {
  const offenders: string[] = [];
  for (const root of APPLICANT_ROOTS) {
    for (const file of runtimeClosure(root)) {
      const src = code(file);
      if (file.endsWith('/pets-admin.ts')) offenders.push(`${root} reaches pets-admin.ts`);
      if (/\b(getDownloadURL|uploadBytes|uploadBytesResumable|uploadString|getBlob|deleteObject)\b/.test(src)) {
        offenders.push(`${root} reaches ${file}, which calls Storage`);
      }
      if (file !== STORAGE_INIT && /['"]firebase\/storage['"]|['"]firebase-admin\/storage['"]/.test(src)) {
        offenders.push(`${root} reaches ${file}, which imports Firebase Storage`);
      }
      if (file !== STORAGE_INIT && (/\{[^}]*\bstorage\b[^}]*\}\s*=\s*getFirebase\(\)/.test(src) || /getFirebase\(\)\.storage/.test(src))) {
        offenders.push(`${root} reaches ${file}, which takes the Storage instance`);
      }
      // The handler and its server half stay on the server (the protocol split).
      for (const server of ['id-document-handler.ts', 'id-document-store.ts', 'require-admin.ts', 'read-capped.ts', 'firebase-admin.ts', 'pets-server.ts']) {
        if (file === `src/lib/${server}`) offenders.push(`${root} reaches src/lib/${server}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('the Storage initialiser only initialises: getStorage and the emulator hook, nothing that reads or writes', () => {
  const src = code(STORAGE_INIT);
  const imports = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]firebase\/storage['"]/g)];
  assert.equal(imports.length, 1);
  const names = imports[0]![1]!.split(',').map((n) => n.trim()).filter(Boolean).sort();
  assert.deepEqual(names, ['connectStorageEmulator', 'getStorage', 'type FirebaseStorage']);
});

test('the upload goes to the route with the user token, as raw JPEG — never a Storage path', () => {
  const client = code('src/lib/id-document-client.ts');
  assert.match(client, /`\/api\/adoption-applications\/\$\{encodeURIComponent\(applicationId\)\}\/id-document\/\$\{side\}`/);
  assert.match(client, /Authorization: `Bearer \$\{token\}`/);
  assert.match(client, /'Content-Type': 'image\/jpeg'/);
  assert.ok(!client.includes(ID_DOCUMENT_ROOT), 'the applicant client names the Storage prefix');
  assert.ok(!/\bidDocument(Path|Prefix)\(/.test(client), 'the applicant client builds a Storage path');
  // The browser reads the route's answer through the protocol module, never the handler.
  assert.match(client, /from '\.\/id-document-protocol'/);
  assert.ok(!/id-document-handler/.test(client));
});

// ─── deletion always names every version ─────────────────────────────────────

test('only id-document-store.ts deletes ID photos, and always with versions: true (critic #8)', () => {
  for (const file of idDocumentModules()) {
    const src = code(file);
    if (file === 'src/lib/id-document-store.ts') continue;
    assert.ok(!/deleteFiles\(|\.delete\(/.test(src), `${file} deletes something itself; use deleteEveryIdDocumentVersion()`);
  }
  const store = code('src/lib/id-document-store.ts');
  // The CALL passes an object literal; the interface's `deleteFiles(query: …)` does not.
  const calls = [...store.matchAll(/deleteFiles\((\{[^}]*\})\)/g)];
  assert.equal(calls.length, 1, 'one delete call');
  assert.match(calls[0]![1]!, /versions:\s*true/);
  // The prefix is the application's folder, or one side's object — both built
  // by id-document-paths, never by hand.
  assert.match(calls[0]![1]!, /\{\s*prefix,\s*versions:\s*true\s*\}/);
  assert.match(
    store,
    /const prefix = side === undefined \? idDocumentPrefix\(applicationId\) : idDocumentPath\(applicationId, side\);/,
  );
  assert.ok(!/\.delete\(/.test(store), 'a single-object delete only makes the live version noncurrent');
});

// ─── the ID photo never reaches a model ──────────────────────────────────────

test('nothing under src/lib/ai names an ID-photo path or module — the photo is never sent to Gemini', () => {
  const ai = SOURCES.filter((file) => file.startsWith('src/lib/ai/'));
  assert.ok(ai.length >= 5, 'the walk reaches src/lib/ai');
  for (const file of ai) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    assert.ok(!/adoption-ids|id-document|idDocument(Path|Prefix)|readIdDocument/.test(src), `${file} names the ID photo`);
  }
});

// ─── account deletion leaves the photo alone ─────────────────────────────────

test("account deletion wipes users/{uid}/ and nothing else — never the ID photo's prefix", () => {
  const route = code('src/app/api/account/delete/route.ts');
  const deletes = [...route.matchAll(/deleteFiles\(([^)]*)\)/g)].map((m) => m[1]!.trim());
  assert.deepEqual(deletes, ['{ prefix: `users/${uid}/` }']);
  for (const file of ['src/app/api/account/delete/route.ts', 'src/lib/account-delete.ts']) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    assert.ok(!/adoption-ids|id-document|idDocument|adoptionApplications/.test(src), `${file} reaches the application`);
  }
});

// ─── the route ───────────────────────────────────────────────────────────────

const ROUTE = 'src/app/api/adoption-applications/[applicationId]/id-document/[side]/route.ts';

test('the route passes the REAL switch and sides through, never a literal', () => {
  const src = code(ROUTE);
  assert.match(src, /applicationsEnabled:\s*SHELTER\.adoptionApplications\.enabled,/);
  assert.match(src, /sides:\s*SHELTER\.adoptionApplications\.idDocumentSides,/);
  assert.ok(!/applicationsEnabled:\s*(true|false)\b/.test(src));
  assert.ok(!/force-static|revalidate/.test(src), 'a POST with a body is never cached');
});

test("the route's path ends in [side], never in .jpg — Hosting's cache rule for *.jpg would match it", () => {
  assert.ok(existsSync(join(ROOT, ROUTE)));
  const routes = walk(join(ROOT, 'src', 'app', 'api', 'adoption-applications'), (n) => n === 'route.ts');
  for (const route of routes) assert.ok(!/\.jpe?g/i.test(route), route);
});

test('the marker is written as a MAP through a dotted path, with exactly the receipt fields', () => {
  const src = code(ROUTE);
  assert.match(src, /tx\.update\(ref, \{\s*\[`idDocument\.\$\{documentSide\}`\]:\s*marker\s*\}\)/);
  assert.match(src, /receivedAt:\s*FieldValue\.serverTimestamp\(\),\s*bytes:\s*receipt\.bytes,\s*generation:\s*receipt\.generation,/);
});

test('the marker is written ONLY inside a transaction that re-reads the application and asks the handler first (review 4b #1)', () => {
  const src = code(ROUTE);
  const commit = src.slice(src.indexOf('commitIdMarker:'), src.indexOf('deleteIdDocumentSide:'));
  assert.ok(commit.length > 0, 'commitIdMarker is not wired');
  assert.match(commit, /db\.runTransaction\(/);
  const read = commit.indexOf('tx.get(ref)');
  const ask = commit.indexOf('check(');
  const refuse = commit.indexOf('if (refusal) return refusal;');
  const write = commit.indexOf('tx.update(');
  assert.ok(read >= 0 && read < ask && ask < refuse && refuse < write, 'read, then check, then refuse, then write — in that order');
  // No marker write anywhere else: one update, and it is the transaction's.
  assert.equal((src.match(/\.update\(/g) ?? []).length, 1, 'a marker write outside the transaction');
  assert.match(src, /deleteIdDocumentSide:\s*\(id, documentSide\) => deleteEveryIdDocumentVersion\(bucket\(\), id, documentSide\)/);
});

// ─── storage.rules ───────────────────────────────────────────────────────────

test('storage.rules: adoption-ids is admin-READ and nobody-WRITE, exactly, before the catch-all', () => {
  const rules = readFileSync(join(ROOT, 'storage.rules'), 'utf8').replace(/\r\n/g, '\n').replace(/\/\/.*$/gm, '');
  const open = `match /${ID_DOCUMENT_ROOT}/{applicationId}/{fileName} {`;
  const at = rules.indexOf(open);
  assert.ok(at >= 0, 'the adoption-ids block is missing');
  const body = rules.slice(at + open.length, rules.indexOf('}', at + open.length));
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(lines, ['allow read: if isAdmin();', 'allow write: if false;']);
  assert.ok(at < rules.indexOf('match /{allPaths=**}'), 'the block must come before the catch-all deny');
  assert.equal(rules.split(ID_DOCUMENT_ROOT).length - 1, 1, 'no other rule names the prefix');
});

// ─── the review screen ───────────────────────────────────────────────────────

test('the carnet is fetched ONLY on tap, and its object URL is revoked', () => {
  const src = code('src/app/admin/applications/[applicationId]/ApplicationReview.tsx');
  const calls = src.match(/readIdDocumentObjectUrl\(/g) ?? [];
  assert.equal(calls.length, 1, 'one fetch site');
  const show = src.indexOf('async function show()');
  assert.ok(show >= 0, 'the fetch lives in the tap handler');
  const fetchAt = src.indexOf('readIdDocumentObjectUrl(');
  assert.ok(fetchAt > show && fetchAt < src.indexOf('return (', show), 'the fetch is inside show(), not an effect');
  assert.ok((src.match(/URL\.revokeObjectURL\(/g) ?? []).length >= 3, 'revoked on hide, on reload and on unmount');
  assert.ok(!/<img[^>]*src=\{[^}]*https?:/.test(src), 'only an object URL goes into <img>');
});

test('the queue never loads a photo or an address — only the marker on the application', () => {
  const src = code('src/app/admin/applications/ApplicationsQueue.tsx');
  assert.ok(!/id-document-admin|readIdDocument|getApplicationHome|getBlob/.test(src));
  assert.match(src, /idDocumentBadge\(application\)/);
  const admin = code('src/lib/applications-admin.ts');
  // `private/home` is read in exactly one place, on its own.
  assert.equal((admin.match(/'private', 'home'/g) ?? []).length, 1);
  const listing = admin.slice(admin.indexOf('export async function listApplications'), admin.indexOf('export async function getApplication('));
  assert.ok(!listing.includes('private'), 'the queue listing must not read private/home');
});
