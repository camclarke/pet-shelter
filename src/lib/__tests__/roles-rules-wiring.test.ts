/**
 * The role conditions in firestore.rules and storage.rules, read as text.
 *
 * What they DO is tested on the Rules :test API by `scripts/rules-test-roles.mjs`
 * and `scripts/rules-test-storage-roles.mjs`, against the matrix in
 * `src/config/roles.ts`. This file pins what those cannot see: that the role
 * conditions cost no document reads, that the coordinator's statements were
 * not touched, and that the event staff's create cannot drift from the
 * coordinator's.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROLE_KEYS } from '@/config/roles';

const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');
/** Rules without `//` comments, so prose cannot satisfy or trip a check. */
const rules = (file: string) => read(file).replace(/\/\/.*$/gm, '');

const FIRESTORE = rules('firestore.rules');
const STORAGE = rules('storage.rules');

function block(src: string, start: string, end: string): string {
  const from = src.indexOf(start);
  assert.ok(from >= 0, `not found: ${start}`);
  const to = src.indexOf(end, from + start.length);
  assert.ok(to > from, `end not found after ${start}: ${end}`);
  return src.slice(from, to);
}

/** A DOCUMENT read in rules: `get(/…)`, `exists(/…)`, `getAfter`, `existsAfter`, or a Storage→Firestore call. */
const DOCUMENT_READ = /\b(get|exists|getAfter|existsAfter)\(\s*\/|firestore\.(get|exists)\(/;

test('isAdmin() is coordination or higher, built on hasRole(), in BOTH rule files', () => {
  assert.match(FIRESTORE, /function hasRole\(role\) \{\s*return signedIn\(\) && request\.auth\.token\.get\(role, false\) == true;\s*\}/);
  assert.match(FIRESTORE, /function isAdmin\(\) \{\s*return signedIn\(\) && \(hasRole\('admin'\) \|\| isSuper\(\) \|\| isShelterOwner\(\)\);\s*\}/);
  assert.match(STORAGE, /function hasRole\(role\) \{\s*return request\.auth != null && request\.auth\.token\.get\(role, false\) == true;\s*\}/);
  assert.match(STORAGE, /function isAdmin\(\) \{\s*return request\.auth != null && \(hasRole\('admin'\) \|\| isSuper\(\) \|\| isShelterOwner\(\)\);\s*\}/);
  // Nothing reads a claim by name any more except through hasRole().
  for (const [name, src] of [['firestore.rules', FIRESTORE], ['storage.rules', STORAGE]] as const) {
    assert.doesNotMatch(src, /request\.auth\.token\.(admin|su|owner|finance|rescuer|events)\b/, `${name} reads a role claim directly`);
  }
});

test('the role helpers name exactly the role keys in src/config/roles.ts', () => {
  const named = new Set([...FIRESTORE.matchAll(/hasRole\('([a-z]+)'\)/g)].map((m) => m[1]));
  assert.deepEqual([...named].sort(), [...ROLE_KEYS].sort());
  const storageNamed = new Set([...STORAGE.matchAll(/hasRole\('([a-z]+)'\)/g)].map((m) => m[1]));
  for (const key of storageNamed) assert.ok((ROLE_KEYS as readonly string[]).includes(key!), `storage names ${key}`);
});

test('the role helpers and every new rule cost no document read', () => {
  const helpers = block(FIRESTORE, 'function hasRole(role)', 'function ownsPet(petId)');
  assert.doesNotMatch(helpers, DOCUMENT_READ);
  assert.doesNotMatch(block(FIRESTORE, 'match /petDrafts/{draftId} {', 'match /registerEntries/{no} {'), DOCUMENT_READ);
  assert.doesNotMatch(block(FIRESTORE, 'match /events/{eventId} {', 'match /{document=**} {'), DOCUMENT_READ);
  assert.doesNotMatch(block(STORAGE, 'function hasRole(role)', 'match /pets/{petId}/{fileName} {'), DOCUMENT_READ);
});

test('Tesorería: isFinance() is hasRole(finance), and is used ONLY inside the donationSettings block', () => {
  assert.match(FIRESTORE, /function isFinance\(\) \{\s*return hasRole\('finance'\);\s*\}/);
  const donations = block(FIRESTORE, 'match /donationSettings/current {', 'match /{document=**} {');
  const outside = FIRESTORE.replace(donations, '').replace(/function isFinance\(\) \{[^}]*\}/, '');
  assert.doesNotMatch(outside, /isFinance\(\)/, 'isFinance() used outside the donationSettings block');
  assert.equal((donations.match(/isFinance\(\)/g) ?? []).length, 2, 'pending and history, nothing else');
  // isAdmin() still does not include it (the exact definition is pinned above).
  assert.doesNotMatch(block(FIRESTORE, 'function isAdmin()', '}'), /finance|isFinance/);
  // Storage has no finance condition at all: donations/** falls to its catch-all deny.
  assert.doesNotMatch(STORAGE, /finance/);
});

test('donationSettings: current is public read; pending and history are Tesorería + owner + su; no client writes', () => {
  const donations = block(FIRESTORE, 'match /donationSettings/current {', 'match /{document=**} {');
  const allows = [...donations.matchAll(/allow ([a-z, ]+): if ([^;]+);/g)].map((m) => `${m[1]}: ${m[2]!.trim()}`);
  assert.deepEqual(allows, [
    'read: true',
    'write: false',
    'read: isFinance() || isShelterOwner() || isSuper()',
    'write: false',
    'read: isFinance() || isShelterOwner() || isSuper()',
    'write: false',
  ]);
  assert.match(donations, /match \/pending\/\{pendingId\} \{/);
  assert.match(donations, /match \/history\/\{entryId\} \{/);
  assert.doesNotMatch(donations, DOCUMENT_READ);
});

test('roleAudit: read by the owner and the superuser — never isAdmin() — written by no client', () => {
  const audit = block(FIRESTORE, 'match /roleAudit/{entryId} {', '}');
  assert.match(audit, /allow read: if isShelterOwner\(\) \|\| isSuper\(\);/);
  assert.doesNotMatch(audit, /isAdmin\(\)|hasRole\('admin'\)|isFinance\(\)/);
  assert.match(audit, /allow write: if false;/);
  assert.equal((audit.match(/allow /g) ?? []).length, 2);
});

test('petDrafts: coordination keeps one unconditional statement; a rescuer gets four narrow ones', () => {
  const drafts = block(FIRESTORE, 'match /petDrafts/{draftId} {', 'match /registerEntries/{no} {');
  assert.match(drafts, /allow read, write: if isAdmin\(\);/);
  const rescuer = [...drafts.matchAll(/allow ([a-z, ]+): if ([^;]+);/g)].filter((m) => m[2]!.includes('isRescuer()'));
  assert.deepEqual(rescuer.map((m) => m[1]).sort(), ['create', 'delete', 'get, list', 'update']);
  for (const m of rescuer) assert.ok(m[2]!.trimStart().startsWith('isRescuer()'), `${m[1]} must start with isRescuer()`);
});

test('events: the coordinator statements are unchanged; the staff create repeats every coordinator condition', () => {
  const events = block(FIRESTORE, 'match /events/{eventId} {', 'match /roleAudit/{entryId} {');
  assert.match(events, /allow get, list: if isAdmin\(\) \|\| resource\.data\.published == true;/);
  assert.match(events, /allow delete: if isAdmin\(\) && \(resource == null \|\| resource\.data\.published == false\);/);

  const statement = (verb: string, who: string) => {
    const m = new RegExp(`allow ${verb}: if ${who}\\(\\)([^;]*);`).exec(events);
    assert.ok(m, `no "allow ${verb}: if ${who}()" statement`);
    return m[1]!.split('&&').map((c) => c.trim()).filter(Boolean);
  };
  const adminCreate = statement('create', 'isAdmin');
  const staffCreate = statement('create', 'isEventStaff');
  for (const condition of adminCreate) {
    assert.ok(staffCreate.includes(condition), `the staff create lost a coordinator condition: ${condition}`);
  }
  assert.ok(staffCreate.includes('request.resource.data.endsAt >= request.time'));

  const adminUpdate = statement('update', 'isAdmin');
  const staffUpdate = statement('update', 'isEventStaff');
  for (const condition of adminUpdate) {
    assert.ok(staffUpdate.includes(condition), `the staff update lost a coordinator condition: ${condition}`);
  }
  assert.ok(staffUpdate.includes('resource.data.endsAt >= request.time'));
  assert.ok(staffUpdate.includes('request.resource.data.endsAt >= request.time'));

  const staffDelete = statement('delete', 'isEventStaff');
  assert.ok(staffDelete.includes('resource.data.published == false'));
  assert.ok(staffDelete.includes('resource.data.endsAt >= request.time'));
});

test('storage: a rescuer creates (never updates) and deletes, on exactly the two pet-photo paths', () => {
  for (const path of ['match /pets/{petId}/{fileName} {', 'match /pets/{petId}/private/{fileName} {']) {
    const b = block(STORAGE, path, '}');
    assert.match(b, /allow create: if rescuerUploadsOwn\(\);/, path);
    assert.match(b, /allow delete: if rescuerDeletesOwnRecent\(\);/, path);
    assert.match(b, /allow create, update: if isAdmin\(\) && isImage\(\) && request\.resource\.size < 8 \* 1024 \* 1024;/, path);
  }
  assert.equal((STORAGE.match(/rescuerUploadsOwn\(\);/g) ?? []).length, 2, 'used on exactly two paths');
  assert.equal((STORAGE.match(/rescuerDeletesOwnRecent\(\);/g) ?? []).length, 2, 'used on exactly two paths');
  const fns = block(STORAGE, 'function rescuerUploadsOwn()', 'match /pets/{petId}/{fileName} {');
  assert.match(fns, /request\.resource\.metadata\.uploadedBy == request\.auth\.uid/);
  assert.match(fns, /resource\.metadata\.uploadedBy == request\.auth\.uid/);
  assert.match(fns, /resource\.timeCreated > request\.time - duration\.value\(24, 'h'\)/);
});
