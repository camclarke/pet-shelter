/**
 * Roles in the panel: every admin page names its section, and the screens a
 * rescuer or event staffer reaches only offer what the rules will allow.
 *
 * Source-text checks, like the rest of the wiring tests here: every admin
 * screen sits behind AdminGate, which needs a human password, so no browser
 * can drive them from a test. They catch a page that forgets its section or a
 * screen that stops asking the role — not a layout.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { ADMIN_SECTIONS, SECTION_HREF, isAdminSection } from '@/config/roles';

const ROOT = process.cwd();

function read(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
}

/** Source without comments, so a comment cannot satisfy a check. */
function code(file: string): string {
  return read(file)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function pages(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...pages(path));
    else if (entry.name === 'page.tsx') out.push(relative(ROOT, path).split(sep).join('/'));
  }
  return out.sort();
}

/** `src/app/admin/pets/[petId]/qr/page.tsx` → `/admin/pets/[petId]/qr` */
function routeOf(page: string): string {
  return page.replace(/^src\/app/, '').replace(/\/page\.tsx$/, '') || '/';
}

test('every page under /admin is gated, once, with a section that matches its route', () => {
  const found = pages(join(ROOT, 'src', 'app', 'admin'));
  assert.ok(found.length >= 12, `found only ${found.length} admin pages — is the walk broken?`);

  for (const page of found) {
    const src = code(page);
    const gates = [...src.matchAll(/<AdminGate\b([^>]*)>/g)];
    assert.equal(gates.length, 1, `${page} must render exactly one <AdminGate>`);
    const section = /\bsection="([a-z]+)"/.exec(gates[0]![1]!)?.[1];
    assert.ok(section, `${page} must pass section="…" to AdminGate`);
    assert.ok(isAdminSection(section), `${page}: "${section}" is not a section in src/config/roles.ts`);

    const route = routeOf(page);
    const href = SECTION_HREF[section as (typeof ADMIN_SECTIONS)[number]];
    const matches = section === 'dashboard' ? route === '/admin' : route === href || route.startsWith(`${href}/`);
    assert.ok(matches, `${page} declares section "${section}" (${href}) but lives at ${route}`);
  }
});

test('every section except none is used by some page', () => {
  const used = new Set(
    pages(join(ROOT, 'src', 'app', 'admin')).map((p) => /\bsection="([a-z]+)"/.exec(code(p))?.[1]),
  );
  for (const section of ADMIN_SECTIONS) assert.ok(used.has(section), `no page declares section "${section}"`);
});

test('AdminGate requires the section and decides with canAccess, from the roles', () => {
  const gate = code('src/components/AdminGate.tsx');
  assert.match(gate, /export function AdminGate\(\{ section, children \}: \{ section: AdminSection;/);
  // The last guard before the children: no role that opens the section, no entry.
  const children = gate.lastIndexOf('return <>{children}</>;');
  const lastGuard = gate.lastIndexOf('if (', children);
  assert.ok(children > 0 && lastGuard > 0, 'the gate renders its children at the end');
  assert.ok(
    gate.slice(lastGuard).startsWith('if (!canAccess(section, roles)) {'),
    `the final guard must be canAccess(section, roles), found: ${gate.slice(lastGuard, lastGuard + 50)}`,
  );
  assert.doesNotMatch(gate, /\bisAdmin\b|roles\.admin/, 'the gate must ask about the section, not about admin');
  assert.ok(gate.indexOf('refreshClaims()') >= 0, 'the forced refresh stays');
});

test('nothing renders an AdminGate without a section anywhere in src', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? (e.name === '__tests__' ? [] : walk(join(dir, e.name))) : /\.tsx$/.test(e.name) ? [join(dir, e.name)] : [],
    );
  for (const file of walk(join(ROOT, 'src'))) {
    const src = code(relative(ROOT, file));
    assert.doesNotMatch(src, /<AdminGate>/, `${relative(ROOT, file)} renders <AdminGate> with no section`);
  }
});

test('AuthProvider exposes the roles, and isAdmin is derived from them as coordination or higher', () => {
  const provider = code('src/components/AuthProvider.tsx');
  assert.match(provider, /const isAdmin = isCoordinatorPlus\(roles\);/);
  assert.equal((provider.match(/setRoles\(rolesFromClaims\(result\.claims\)\)/g) ?? []).length, 2, 'cached AND forced');
  assert.doesNotMatch(provider, /claims\.admin/);
});

test('the dashboard links only to sections the roles open, and a rescuer reads only their own drafts', () => {
  const dash = code('src/app/admin/AdminDashboard.tsx');
  for (const section of ['areas', 'qr', 'applications', 'food', 'events', 'register'] as const) {
    const href = `href="${SECTION_HREF[section]}"`;
    const at = dash.indexOf(href);
    assert.ok(at >= 0, `the dashboard lost its ${section} link`);
    const guard = dash.lastIndexOf(`canAccess('${section}', roles)`, at);
    assert.ok(guard >= 0 && at - guard < 700, `the ${section} link must sit behind canAccess('${section}', roles)`);
  }
  assert.match(dash, /listOwnDrafts\(uid\)/);
  assert.match(dash, /if \(!coordinator\) \{/);
  // The record screen is coordination's; a rescuer's draft opens the wizard.
  assert.match(
    dash,
    /\{coordinator \? \(\s*<Link href=\{`\/admin\/pets\/\$\{draft\.id\}`\}>[\s\S]*?\) : \(\s*<Link href=\{`\/admin\/intake\?draft=\$\{draft\.id\}`\}>/,
  );
  assert.match(dash, /draft\.readyForReview === true/);
});

test('listOwnDrafts asks for exactly the drafts the rules let a rescuer list', () => {
  const lib = code('src/lib/pets-admin.ts');
  const fn = lib.slice(lib.indexOf('export async function listOwnDrafts('));
  assert.match(fn.slice(0, 400), /where\('createdBy', '==', uid\)/);
});

test('createdBy is stamped by newDraft only, and every upload carries uploadedBy', () => {
  const lib = code('src/lib/pets-admin.ts');
  assert.match(lib, /export function newDraft\(uid: string\): PetDraft \{\s*return \{ \.\.\.draftDefaults\(mintPetId\(\)\), createdBy: uid \};/);
  const save = lib.slice(lib.indexOf('export async function saveDraft('), lib.indexOf('export async function loadDraft('));
  assert.doesNotMatch(save, /createdBy/, 'saveDraft must never invent an owner for a draft that has none');
  assert.match(lib, /customMetadata: \{ uploadedBy: uploader \}/);
});

test('the wizard: a rescuer gets no publish, no chip lookup, and «Lista para revisar»', () => {
  const wizard = code('src/app/admin/intake/IntakeWizard.tsx');
  assert.match(wizard, /const coordinator = isCoordinatorPlus\(roles\);/);
  assert.match(wizard, /if \(!chipLookupCode \|\| !coordinator\) \{/);
  const publish = wizard.indexOf('onClick={handlePublishTap}');
  const guard = wizard.lastIndexOf('{coordinator && (', publish);
  const readyFooter = wizard.lastIndexOf('{!coordinator && (', publish);
  assert.ok(guard > readyFooter && guard > 0, 'the Publish button must sit behind {coordinator && (');
  assert.match(wizard, /markReadyForReview\(!draft\.readyForReview\)/);
  assert.match(wizard, /'Lista para revisar'/);
  // A new draft is stamped with its author.
  assert.match(wizard, /uid \? newDraft\(uid\) : draftDefaults\(mintPetId\(\)\)/);
  assert.doesNotMatch(wizard, /setDraft\(draftDefaults\(mintPetId\(\)\)\)/);
});

test('re-admission is reachable only through a chip match, which a rescuer never gets', () => {
  const wizard = code('src/app/admin/intake/IntakeWizard.tsx');
  // setReadmit(...) with a pet happens in one place: the chip-match card.
  const sets = [...wizard.matchAll(/setReadmit\((?!null)/g)];
  assert.equal(sets.length, 1);
  const at = sets[0]!.index!;
  assert.ok(wizard.lastIndexOf('{chipMatch && (', at) > 0, 'reopening is offered only inside the chip-match card');
});

test('event staff cannot be offered edits of an ended event', () => {
  const panel = code('src/app/admin/events/EventsPanel.tsx');
  assert.match(panel, /const editsPast = isCoordinatorPlus\(roles\);/);
  assert.match(panel, /locked: !editsPast && event\.endsAt < now,/);
  assert.match(panel, /\{locked \? \(/);
});

test('the account screen shows the role, and refuses deletion to any staff role', () => {
  const settings = code('src/app/account/AccountSettings.tsx');
  assert.match(settings, /const staff = isStaff\(roles\);/);
  assert.match(settings, /\{staff \? \(\s*<p className="auth__prose">\{copy\.adminCannotDelete\}<\/p>/);
  assert.match(settings, /t\.account\.roleLine\(roleLabels\(roles\)\)/);
});
