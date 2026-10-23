import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADMIN_SECTIONS,
  COORDINATOR_PLUS,
  DATA_ACCESS,
  HIDDEN_ROLES,
  NO_ROLES,
  ROLE_KEYS,
  ROLE_LABELS,
  SECTION_HREF,
  SECTION_ROLES,
  canAccess,
  dataAllows,
  hasAnyRole,
  heldRoles,
  isAdminSection,
  isCoordinatorPlus,
  isRoleKey,
  isStaff,
  roleLabels,
  rolesFromClaims,
  visibleRoleLabels,
  type AdminSection,
  type RoleKey,
  type Roles,
} from '@/config/roles';
import { findVoseo } from '@/lib/ai/spanish-register';

const only = (...keys: RoleKey[]): Roles => rolesFromClaims(Object.fromEntries(keys.map((k) => [k, true])));

// ─── claims ──────────────────────────────────────────────────────────────────

test('the five role keys, in order, and the coordination set', () => {
  assert.deepEqual([...ROLE_KEYS], ['su', 'owner', 'admin', 'rescuer', 'events']);
  assert.deepEqual([...COORDINATOR_PLUS].sort(), ['admin', 'owner', 'su']);
});

test('rolesFromClaims reads each claim as exactly true, never truthiness', () => {
  assert.deepEqual(rolesFromClaims({ admin: true }), { ...NO_ROLES, admin: true });
  for (const value of ['true', 1, {}, [], null, undefined, false]) {
    assert.deepEqual(
      rolesFromClaims({ su: value, owner: value, admin: value, rescuer: value, events: value }),
      NO_ROLES,
      `value=${JSON.stringify(value)}`,
    );
  }
});

test('rolesFromClaims grants nothing for anything that is not an object', () => {
  for (const claims of [null, undefined, 'admin', 1, true]) {
    assert.deepEqual(rolesFromClaims(claims), NO_ROLES, String(claims));
  }
});

test('rolesFromClaims ignores claims it does not know, and always returns all five keys', () => {
  const roles = rolesFromClaims({ rescuer: true, superadmin: true, Admin: true, email: 'x@y.z' });
  assert.deepEqual(Object.keys(roles).sort(), [...ROLE_KEYS].sort());
  assert.deepEqual(heldRoles(roles), ['rescuer']);
});

test('the result is frozen, so a consumer cannot grant itself a role by mutation', () => {
  const roles = rolesFromClaims({ rescuer: true });
  assert.ok(Object.isFrozen(roles));
  assert.ok(Object.isFrozen(NO_ROLES));
});

test('isRoleKey accepts the five keys and nothing else', () => {
  for (const key of ROLE_KEYS) assert.ok(isRoleKey(key));
  for (const value of ['SU', 'superuser', 'coordinator', '', 1, null]) assert.equal(isRoleKey(value), false, String(value));
});

test('coordination or higher is exactly admin, owner or su; staff is any of the five', () => {
  for (const role of ROLE_KEYS) {
    assert.equal(isCoordinatorPlus(only(role)), ['admin', 'owner', 'su'].includes(role), role);
    assert.equal(isStaff(only(role)), true, role);
  }
  assert.equal(isCoordinatorPlus(NO_ROLES), false);
  assert.equal(isStaff(NO_ROLES), false);
  assert.equal(isCoordinatorPlus(only('rescuer', 'events')), false);
});

test('hasAnyRole: roles add up, and an empty list admits nobody', () => {
  assert.ok(hasAnyRole(only('rescuer', 'events'), ['events']));
  assert.ok(hasAnyRole(only('rescuer', 'events'), ['rescuer']));
  assert.equal(hasAnyRole(only('su', 'owner', 'admin', 'rescuer', 'events'), []), false);
});

// ─── labels ──────────────────────────────────────────────────────────────────

test('the Spanish names, as agreed in the plan', () => {
  assert.deepEqual(ROLE_LABELS, {
    su: 'Administración general',
    owner: 'Responsable del refugio',
    admin: 'Coordinación',
    rescuer: 'Rescatista',
    events: 'Equipo de eventos',
  });
  for (const label of Object.values(ROLE_LABELS)) assert.deepEqual(findVoseo(label), [], label);
});

test('roleLabels lists the held roles, most powerful first', () => {
  assert.deepEqual(roleLabels(only('events', 'rescuer')), ['Rescatista', 'Equipo de eventos']);
  assert.deepEqual(roleLabels(NO_ROLES), []);
});

test('visibleRoleLabels never names the superuser, for any of the 32 role combinations', () => {
  assert.deepEqual([...HIDDEN_ROLES], ['su']);
  let combos = 0;
  for (let mask = 0; mask < 1 << ROLE_KEYS.length; mask++) {
    const keys = ROLE_KEYS.filter((_, i) => (mask & (1 << i)) !== 0);
    const roles = only(...keys);
    const labels = visibleRoleLabels(roles);
    assert.ok(!labels.includes('Administración general'), `su shown for ${keys.join('+')}`);
    assert.ok(!labels.includes(ROLE_LABELS.su), `su shown for ${keys.join('+')}`);
    // Everything else held is still shown, in ROLE_KEYS order.
    assert.deepEqual(labels, roleLabels(roles).filter((l) => l !== ROLE_LABELS.su), keys.join('+'));
    combos++;
  }
  assert.equal(combos, 32);
  assert.deepEqual(visibleRoleLabels(only('su', 'admin')), ['Coordinación']);
  assert.deepEqual(visibleRoleLabels(only('su')), []);
  // The terminal output still names it: roleLabels is unchanged.
  assert.deepEqual(roleLabels(only('su')), ['Administración general']);
});

// ─── sections ────────────────────────────────────────────────────────────────

test('every section has roles and a route under /admin', () => {
  assert.deepEqual(Object.keys(SECTION_ROLES).sort(), [...ADMIN_SECTIONS].sort());
  assert.deepEqual(Object.keys(SECTION_HREF).sort(), [...ADMIN_SECTIONS].sort());
  for (const section of ADMIN_SECTIONS) {
    assert.ok(SECTION_ROLES[section].length > 0, section);
    assert.match(SECTION_HREF[section], /^\/admin(\/[a-z]+)?$/, section);
  }
  assert.ok(isAdminSection('events'));
  assert.equal(isAdminSection('donations'), false);
});

/** Plan §4, row by row: which sections each single role opens. */
const EXPECTED_SECTIONS: Record<RoleKey | 'none', AdminSection[]> = {
  su: [...ADMIN_SECTIONS],
  owner: [...ADMIN_SECTIONS],
  admin: [...ADMIN_SECTIONS],
  rescuer: ['dashboard', 'intake'],
  events: ['dashboard', 'events'],
  none: [],
};

test('canAccess matches the plan matrix for each role alone and for no role', () => {
  for (const [who, sections] of Object.entries(EXPECTED_SECTIONS)) {
    const roles = who === 'none' ? NO_ROLES : only(who as RoleKey);
    for (const section of ADMIN_SECTIONS) {
      assert.equal(canAccess(section, roles), sections.includes(section), `${who} → ${section}`);
    }
  }
});

test('a rescuer who is also event staff opens the union of both', () => {
  const both = only('rescuer', 'events');
  const opened = ADMIN_SECTIONS.filter((s) => canAccess(s, both)).sort();
  assert.deepEqual(opened, ['dashboard', 'events', 'intake']);
});

// ─── the data matrix ─────────────────────────────────────────────────────────

test('coordination or higher may do every verb the matrix lists for any resource', () => {
  for (const role of COORDINATOR_PLUS) {
    for (const [resource, verbs] of Object.entries(DATA_ACCESS)) {
      for (const [verb, grants] of Object.entries(verbs)) {
        if (resource === 'roleAudit') continue;
        if ((grants as readonly unknown[]).length === 0) continue;
        assert.ok(
          dataAllows(resource as keyof typeof DATA_ACCESS, verb as 'read', only(role)),
          `${role} ${verb} ${resource}`,
        );
      }
    }
  }
});

test('roleAudit: only the superuser reads it, and nobody writes it through the rules', () => {
  for (const role of ROLE_KEYS) {
    assert.equal(dataAllows('roleAudit', 'read', only(role)), role === 'su', role);
    for (const verb of ['create', 'update', 'delete'] as const) {
      assert.equal(dataAllows('roleAudit', verb, only(role)), false, `${role} ${verb}`);
    }
  }
});

test('a rescuer: own drafts only, never one that touches the register, never anything published', () => {
  const r = only('rescuer');
  assert.ok(dataAllows('petDrafts', 'read', r, { own: true }));
  assert.equal(dataAllows('petDrafts', 'read', r, { own: false }), false);
  assert.equal(dataAllows('petDrafts', 'read', r), false, 'a forgotten fact denies');
  for (const verb of ['create', 'update', 'delete'] as const) {
    assert.ok(dataAllows('petDrafts', verb, r, { own: true }), verb);
    assert.equal(dataAllows('petDrafts', verb, r, { own: true, touchesRegister: true }), false, `${verb} register`);
    assert.equal(dataAllows('petDrafts', verb, r, { own: false }), false, `${verb} other`);
  }
  for (const resource of ['publish', 'medical'] as const) {
    for (const verb of ['create', 'update', 'delete'] as const) {
      assert.equal(dataAllows(resource, verb, r, { own: true }), false, `${resource} ${verb}`);
    }
  }
  assert.ok(dataAllows('petPhotos', 'create', r, { own: true }));
  assert.equal(dataAllows('petPhotos', 'create', r, { own: false }), false);
  assert.equal(dataAllows('petPhotos', 'update', r, { own: true }), false, 'no overwrite');
  assert.ok(dataAllows('petPhotos', 'delete', r, { own: true, recent: true }));
  assert.equal(dataAllows('petPhotos', 'delete', r, { own: true, recent: false }), false);
  assert.equal(dataAllows('petPhotos', 'delete', r, { own: false, recent: true }), false);
});

test('event staff: events that have not ended, and nothing else', () => {
  const e = only('events');
  assert.ok(dataAllows('events', 'read', e));
  for (const verb of ['create', 'update', 'delete'] as const) {
    assert.ok(dataAllows('events', verb, e, { ended: false }), verb);
    assert.equal(dataAllows('events', verb, e, { ended: true }), false, `${verb} past`);
    assert.equal(dataAllows('events', verb, e), false, `${verb}: a forgotten fact denies`);
  }
  for (const resource of ['petDrafts', 'publish', 'medical', 'petPhotos'] as const) {
    assert.equal(dataAllows(resource, 'create', e, { own: true }), false, resource);
  }
});

test('no role at all is allowed nothing in the matrix', () => {
  for (const [resource, verbs] of Object.entries(DATA_ACCESS)) {
    for (const verb of Object.keys(verbs)) {
      assert.equal(
        dataAllows(resource as keyof typeof DATA_ACCESS, verb as 'read', NO_ROLES, {
          own: true,
          recent: true,
          ended: false,
        }),
        false,
        `${verb} ${resource}`,
      );
    }
  }
});
