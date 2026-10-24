/**
 * Staff roles: who may do what in the shelter's panel.
 *
 * ── Where a role lives ─────────────────────────────────────────────────────
 * One custom auth claim per role, each a boolean, set only by
 * `scripts/grant-role.mjs` through the Admin SDK. A claim is already inside the
 * ID token, so `firestore.rules` and `storage.rules` check it for free; a
 * `roles/{uid}` document would cost a billed `get()` on every evaluation and
 * would itself need protecting. (Role-based access plan, 2026-10-22, §2.)
 *
 * The `admin` key is the claim this project has used since 2026-08-23. It is
 * KEPT, and now means "Coordinación": everything operational, exactly as
 * before. `su` and `owner` include everything `admin` has, so the rules'
 * `isAdmin()` reads as "coordination or higher" and its 49 call sites did not
 * have to change.
 *
 * ── Why the matrix is data ─────────────────────────────────────────────────
 * The panel (which sections to show) and the rules test (which requests must
 * be allowed) both read the tables below, so they cannot drift apart. The
 * rules themselves are a separate language and are checked against these
 * tables by `scripts/rules-test-roles.mjs` and
 * `scripts/rules-test-storage-roles.mjs`.
 *
 * Pure: no Firebase import, so it is safe in the root layout's bundle and in
 * Node scripts run through tsx.
 */

export const ROLE_KEYS = ['su', 'owner', 'admin', 'finance', 'rescuer', 'events'] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

/**
 * The roles that hold everything operational. `admin` is Coordinación; the
 * other two add to it (granting roles, for `su`) and never take from it.
 *
 * `finance` (Tesorería) is deliberately NOT here: whoever can change where
 * donors' money goes holds nothing else (owner decision 2026-10-23). It opens
 * the donations section and the dashboard, and no operational screen.
 */
export const COORDINATOR_PLUS: readonly RoleKey[] = ['admin', 'owner', 'su'];

/**
 * Who may view, propose, confirm and reject donation details: Tesorería and
 * the superuser (owner decision 2026-10-24). Confirming and rejecting also
 * need a caller who is NOT the proposer — `canConfirm()` in
 * `src/lib/donations.ts`; this list is only the role half of that.
 */
export const DONATION_ROLES: readonly RoleKey[] = ['finance', 'su'];

/**
 * Names shown in the panel. Nouns without grammatical gender ("el/la
 * rescatista"), so no sentence built around them has to agree with a sex the
 * system does not record.
 */
export const ROLE_LABELS: Readonly<Record<RoleKey, string>> = {
  su: 'Administración general',
  owner: 'Responsable del refugio',
  admin: 'Coordinación',
  finance: 'Tesorería',
  rescuer: 'Rescatista',
  events: 'Equipo de eventos',
};

/** Every role, true or false. Never partial, so a missing key cannot read as "unknown". */
export type Roles = Readonly<Record<RoleKey, boolean>>;

export const NO_ROLES: Roles = Object.freeze({
  su: false,
  owner: false,
  admin: false,
  finance: false,
  rescuer: false,
  events: false,
});

/**
 * The roles a set of claims grants.
 *
 * `=== true`, never truthiness: the string "true" or the number 1 is not what
 * the grant script writes, and the rules compare with `== true` too. Anything
 * that is not a plain object grants nothing.
 */
export function rolesFromClaims(claims: unknown): Roles {
  if (claims === null || typeof claims !== 'object') return NO_ROLES;
  const source = claims as Record<string, unknown>;
  const roles = { ...NO_ROLES } as Record<RoleKey, boolean>;
  for (const key of ROLE_KEYS) roles[key] = source[key] === true;
  return Object.freeze(roles);
}

export function isRoleKey(value: unknown): value is RoleKey {
  return typeof value === 'string' && (ROLE_KEYS as readonly string[]).includes(value);
}

/** Whether these roles include at least one of `allowed`. */
export function hasAnyRole(roles: Roles, allowed: readonly RoleKey[]): boolean {
  return allowed.some((role) => roles[role] === true);
}

/** Coordinación, Responsable del refugio or Administración general. */
export function isCoordinatorPlus(roles: Roles): boolean {
  return hasAnyRole(roles, COORDINATOR_PLUS);
}

/** Any staff role at all. Such an account cannot delete itself from a phone. */
export function isStaff(roles: Roles): boolean {
  return hasAnyRole(roles, ROLE_KEYS);
}

/** The roles held, in `ROLE_KEYS` order (most powerful first). */
export function heldRoles(roles: Roles): RoleKey[] {
  return ROLE_KEYS.filter((role) => roles[role] === true);
}

/**
 * The Spanish names of the roles held, most powerful first — EVERY role,
 * superuser included. For the grant script's terminal output; a screen uses
 * `visibleRoleLabels()`.
 */
export function roleLabels(roles: Roles): string[] {
  return heldRoles(roles).map((role) => ROLE_LABELS[role]);
}

/**
 * Roles never named on any screen. `su` is the account that grants roles and
 * reads the role audit; showing it would tell anyone looking over a shoulder,
 * or at a screenshot, which account is worth taking over. The role still
 * works exactly as before — this only changes what is DISPLAYED.
 */
export const HIDDEN_ROLES: readonly RoleKey[] = ['su'];

/** The names a screen may show: the held roles minus `HIDDEN_ROLES`, most powerful first. */
export function visibleRoleLabels(roles: Roles): string[] {
  return heldRoles(roles)
    .filter((role) => !HIDDEN_ROLES.includes(role))
    .map((role) => ROLE_LABELS[role]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sections of the panel
// ─────────────────────────────────────────────────────────────────────────────

export const ADMIN_SECTIONS = [
  'dashboard',
  'intake',
  'pets',
  'register',
  'areas',
  'qr',
  'applications',
  'food',
  'events',
  'donations',
] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number];

/**
 * Which roles open which section. Plan §4.
 *
 * The rescuer's dashboard shows their own drafts and nothing else; the event
 * staff's shows the events link. Everything about a PUBLISHED animal (`pets`,
 * which includes its health card and tag print pages) stays with
 * coordination: a rescuer adds, a coordinator decides.
 *
 * Donations are Tesorería's and the superuser's ONLY — not coordination's,
 * not the owner's (plan §5, revised 2026-10-24).
 */
export const SECTION_ROLES: Readonly<Record<AdminSection, readonly RoleKey[]>> = {
  dashboard: [...COORDINATOR_PLUS, 'finance', 'rescuer', 'events'],
  intake: [...COORDINATOR_PLUS, 'rescuer'],
  pets: COORDINATOR_PLUS,
  register: COORDINATOR_PLUS,
  areas: COORDINATOR_PLUS,
  qr: COORDINATOR_PLUS,
  applications: COORDINATOR_PLUS,
  food: COORDINATOR_PLUS,
  events: [...COORDINATOR_PLUS, 'events'],
  donations: DONATION_ROLES,
};

/** The route each section's screen lives at. */
export const SECTION_HREF: Readonly<Record<AdminSection, string>> = {
  dashboard: '/admin',
  intake: '/admin/intake',
  pets: '/admin/pets',
  register: '/admin/register',
  areas: '/admin/areas',
  qr: '/admin/qr',
  applications: '/admin/applications',
  food: '/admin/food',
  events: '/admin/events',
  donations: '/admin/donations',
};

export function isAdminSection(value: unknown): value is AdminSection {
  return typeof value === 'string' && (ADMIN_SECTIONS as readonly string[]).includes(value);
}

/**
 * Whether these roles open this section. This is the panel's answer, which is
 * UX: the rules are the boundary, and they are tested against the data tables
 * below, not against this function.
 */
export function canAccess(section: AdminSection, roles: Roles): boolean {
  return hasAnyRole(roles, SECTION_ROLES[section]);
}

// ─────────────────────────────────────────────────────────────────────────────
// What the rules allow — the matrix as data
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How far a grant reaches.
 *
 *  - `any`          every document the verb can reach.
 *  - `own`          documents whose `createdBy` (Storage: `uploadedBy`) is the caller.
 *  - `own-off-register` own, and the write neither creates, changes nor
 *                 removes a link to a row of the paper register: a create
 *                 carries no link, an update leaves the link as it was, a
 *                 delete is of a draft with no link.
 *  - `not-ended`    events whose `endsAt` is now or later.
 *  - `own-recent`   own, and created less than 24 hours ago.
 */
export type GrantScope = 'any' | 'own' | 'own-off-register' | 'not-ended' | 'own-recent';

export interface Grant {
  readonly roles: readonly RoleKey[];
  readonly scope: GrantScope;
}

export type DataVerb = 'read' | 'create' | 'update' | 'delete';

/**
 * The resources whose access the roles change, and what each verb allows.
 * Every collection not named here is unchanged: coordination-or-higher, as
 * before, through `isAdmin()`.
 *
 *  - `petDrafts`  the intake wizard's drafts.
 *  - `publish`    `pets`, `detail`, `media` and `identity`: what publishing writes.
 *  - `medical`    medical records.
 *  - `events`     adoption fairs. Delete is further limited to UNPUBLISHED
 *                 events for everyone; that is not a role question.
 *  - `roleAudit`  the grant script's log, written only by the Admin SDK.
 *  - `petPhotos`  Storage `pets/{petId}/…` and `pets/{petId}/private/…`.
 *  - `donationCurrent`  `donationSettings/current`, the confirmed details.
 *                 PUBLIC read (anyone, signed in or not — see
 *                 `PUBLIC_READ`), and no client write: only the confirm route
 *                 writes it, through the Admin SDK.
 *  - `donationPending`  `donationSettings/current/pending/{id}`: proposals.
 *  - `donationHistory`  `donationSettings/current/history/{id}`: append-only.
 *                 Both read by Tesorería and the superuser only, and written
 *                 only by the routes. NOT coordination, NOT the owner.
 */
export const DATA_ACCESS = {
  petDrafts: {
    read: [
      { roles: COORDINATOR_PLUS, scope: 'any' },
      { roles: ['rescuer'], scope: 'own' },
    ],
    create: [
      { roles: COORDINATOR_PLUS, scope: 'any' },
      { roles: ['rescuer'], scope: 'own-off-register' },
    ],
    update: [
      { roles: COORDINATOR_PLUS, scope: 'any' },
      { roles: ['rescuer'], scope: 'own-off-register' },
    ],
    delete: [
      { roles: COORDINATOR_PLUS, scope: 'any' },
      { roles: ['rescuer'], scope: 'own-off-register' },
    ],
  },
  publish: {
    read: [],
    create: [{ roles: COORDINATOR_PLUS, scope: 'any' }],
    update: [{ roles: COORDINATOR_PLUS, scope: 'any' }],
    delete: [{ roles: COORDINATOR_PLUS, scope: 'any' }],
  },
  medical: {
    read: [],
    create: [{ roles: COORDINATOR_PLUS, scope: 'any' }],
    update: [{ roles: COORDINATOR_PLUS, scope: 'any' }],
    delete: [{ roles: COORDINATOR_PLUS, scope: 'any' }],
  },
  events: {
    read: [
      { roles: COORDINATOR_PLUS, scope: 'any' },
      { roles: ['events'], scope: 'any' },
    ],
    create: [
      { roles: COORDINATOR_PLUS, scope: 'any' },
      { roles: ['events'], scope: 'not-ended' },
    ],
    update: [
      { roles: COORDINATOR_PLUS, scope: 'any' },
      { roles: ['events'], scope: 'not-ended' },
    ],
    delete: [
      { roles: COORDINATOR_PLUS, scope: 'any' },
      { roles: ['events'], scope: 'not-ended' },
    ],
  },
  roleAudit: {
    read: [{ roles: ['su'], scope: 'any' }],
    create: [],
    update: [],
    delete: [],
  },
  petPhotos: {
    read: [],
    create: [
      { roles: COORDINATOR_PLUS, scope: 'any' },
      { roles: ['rescuer'], scope: 'own' },
    ],
    update: [{ roles: COORDINATOR_PLUS, scope: 'any' }],
    delete: [
      { roles: COORDINATOR_PLUS, scope: 'any' },
      { roles: ['rescuer'], scope: 'own-recent' },
    ],
  },
  donationCurrent: {
    read: [],
    create: [],
    update: [],
    delete: [],
  },
  donationPending: {
    read: [{ roles: DONATION_ROLES, scope: 'any' }],
    create: [],
    update: [],
    delete: [],
  },
  donationHistory: {
    read: [{ roles: DONATION_ROLES, scope: 'any' }],
    create: [],
    update: [],
    delete: [],
  },
} as const satisfies Record<string, Record<DataVerb, readonly Grant[]>>;

export type DataResource = keyof typeof DATA_ACCESS;

/**
 * Resources ANYONE may read, signed in or not. Not a role question, so it
 * is not a grant: `dataAllows()` stays "what these roles allow", and a reader
 * of the matrix asks `publicCanRead()` too. Writes are never public.
 */
export const PUBLIC_READ: readonly DataResource[] = ['donationCurrent'];

export function publicCanRead(resource: DataResource): boolean {
  return PUBLIC_READ.includes(resource);
}

/**
 * What a request is about, for the scopes above. Every fact defaults to the
 * case that does NOT satisfy a narrow scope, so a forgotten fact denies.
 */
export interface AccessFacts {
  /**
   * `createdBy` / `uploadedBy` is the caller. For an update, on BOTH the
   * stored and the new document: handing a draft to someone else is not own.
   */
  own?: boolean;
  /** The write creates, changes or removes a paper-register link (see `own-off-register`). */
  touchesRegister?: boolean;
  /** The event's `endsAt` is before now (for an update: either side of it). */
  ended?: boolean;
  /** The object was created less than 24 hours ago. */
  recent?: boolean;
}

function scopeHolds(scope: GrantScope, facts: AccessFacts): boolean {
  switch (scope) {
    case 'any':
      return true;
    case 'own':
      return facts.own === true;
    case 'own-off-register':
      return facts.own === true && facts.touchesRegister !== true;
    case 'not-ended':
      return facts.ended === false;
    case 'own-recent':
      return facts.own === true && facts.recent === true;
  }
}

/**
 * Whether the matrix allows `roles` to perform `verb` on `resource`, given
 * the facts of the request. Roles add up: one grant that holds is enough.
 */
export function dataAllows(
  resource: DataResource,
  verb: DataVerb,
  roles: Roles,
  facts: AccessFacts = {},
): boolean {
  const grants: readonly Grant[] = DATA_ACCESS[resource][verb];
  return grants.some((grant) => hasAnyRole(roles, grant.roles) && scopeHolds(grant.scope, facts));
}
