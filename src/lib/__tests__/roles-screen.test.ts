/**
 * The team roles screen: source-text wiring guards (the screen sits behind
 * AdminGate, so no test can drive it) plus the Spanish copy's completeness.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROLE_FAILURES } from '@/lib/role-admin-protocol';
import { ROLE_FAILURE_TEXT, roleFailureText, roleName } from '@/lib/roles-copy';

function read(file: string): string {
  return readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');
}
function code(file: string): string {
  return read(file)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const PANEL = 'src/app/admin/roles/RolesPanel.tsx';

test('the panel offers buttons only from `editable` and `grantable`, never a role list of its own', () => {
  const src = code(PANEL);
  assert.match(src, /member\.editable/);
  const noClasses = src.replace(/className="[^"]*"/g, '');
  assert.match(src, /data\?\.grantable/);
  for (const key of ['owner', 'admin', 'finance', 'rescuer', 'events']) {
    assert.doesNotMatch(noClasses, new RegExp(`['"]${key}['"]`), `the panel hardcodes the role "${key}"`);
  }
});

test('nothing the roles screen shows names the superuser', () => {
  for (const file of [PANEL, 'src/lib/roles-copy.ts', 'src/lib/roles-client.ts']) {
    const src = code(file);
    assert.doesNotMatch(src, /Administración general/, file);
    assert.doesNotMatch(src, /superusuario/i, file);
    assert.doesNotMatch(src, /['"]su['"]/, `${file} names the su key`);
  }
  assert.doesNotMatch(read(PANEL).replace(/\/\*[\s\S]*?\*\//g, ''), /ROLE_LABELS\.su/);
});

test('the audit never prints the superuser role', () => {
  assert.equal(roleName('su'), '(rol interno)');
  assert.equal(roleName('finance'), 'Tesorería');
  assert.match(code(PANEL), /roleName\(row\.role\)/);
});

test('the client reads the refusal through roleFailure and the panel re-authenticates', () => {
  assert.match(code('src/lib/roles-client.ts'), /roleFailure\(response\)/);
  const panel = code(PANEL);
  assert.match(panel, /requires-recent-login/);
  assert.match(panel, /<ReauthPrompt/);
  assert.match(panel, /getIdToken|changeRole/);
});

test('the dashboard link is gated by canAccess("roles")', () => {
  const src = code('src/app/admin/AdminDashboard.tsx');
  assert.match(src, /canAccess\('roles', roles\) && \(\s*<Link href="\/admin\/roles"/);
});

test('the page keeps its gate, its section and revalidate', () => {
  const src = code('src/app/admin/roles/page.tsx');
  assert.match(src, /<AdminGate section="roles">/);
  assert.match(src, /<RolesPanel \/>/);
  assert.match(src, /export const revalidate = 300/);
});

test('every refusal the protocol can name has a Spanish sentence', () => {
  for (const failure of ROLE_FAILURES) {
    const text = ROLE_FAILURE_TEXT[failure];
    assert.ok(typeof text === 'string' && text.length > 10, failure);
    assert.equal(roleFailureText(failure), text);
  }
  assert.deepEqual(Object.keys(ROLE_FAILURE_TEXT).sort(), [...ROLE_FAILURES].sort());
  assert.match(roleFailureText(null), /conexión/);
});

test('the copy is neutral tuteo: no voseo forms', () => {
  const all = Object.values(ROLE_FAILURE_TEXT).join(' ') + read(PANEL);
  assert.doesNotMatch(all, /\b(vos|tenés|podés|elegí|poné|confirmá)\b/u);
});
