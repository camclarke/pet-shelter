import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { requireAdmin, requireRole, type VerifiedIdToken } from '../require-admin';
import { COORDINATOR_PLUS, NO_ROLES, type RoleKey } from '@/config/roles';

// ─── the check itself ────────────────────────────────────────────────────────

function request(authorization?: string): Request {
  const headers = new Headers();
  if (authorization !== undefined) headers.set('authorization', authorization);
  return new Request('http://localhost/api/anything', { method: 'POST', headers });
}

function verifier(result: VerifiedIdToken | Error) {
  const calls: [string, boolean][] = [];
  const verify = async (token: string, checkRevoked: boolean): Promise<VerifiedIdToken> => {
    calls.push([token, checkRevoked]);
    if (result instanceof Error) throw result;
    return result;
  };
  return { verify, calls };
}

const UNAUTHENTICATED = { ok: false, error: 'unauthenticated', status: 401 };
const FORBIDDEN = { ok: false, error: 'forbidden', status: 403 };

test('no Authorization header is 401, and the verifier is never called', async () => {
  const { verify, calls } = verifier({ uid: 'u', admin: true });
  assert.deepEqual(await requireAdmin(request(), verify), UNAUTHENTICATED);
  assert.equal(calls.length, 0);
});

test('a header that is not a Bearer token is 401, without calling the verifier', async () => {
  for (const header of ['Basic dXNlcjpwYXNz', 'bearer abc', 'Bearer', 'Bearer    ', 'abc']) {
    const { verify, calls } = verifier({ uid: 'u', admin: true });
    const label = `header ${JSON.stringify(header)}`;
    assert.deepEqual(await requireAdmin(request(header), verify), UNAUTHENTICATED, label);
    assert.equal(calls.length, 0, `${label} must not reach the verifier`);
  }
});

test('a token that fails verification is 401', async () => {
  const { verify } = verifier(new Error('auth/id-token-revoked'));
  assert.deepEqual(await requireAdmin(request('Bearer looks-fine'), verify), UNAUTHENTICATED);
});

test('the token is verified with checkRevoked, always, and passed trimmed', async () => {
  const { verify, calls } = verifier({ uid: 'u', admin: true });
  await requireAdmin(request('Bearer   tok123'), verify);
  assert.deepEqual(calls, [['tok123', true]]);
});

test('an account without the admin claim set to exactly true is 403', async () => {
  for (const admin of [undefined, null, false, 'true', 1, {}]) {
    const { verify } = verifier({ uid: 'u', email: 'a@example.com', admin });
    assert.deepEqual(await requireAdmin(request('Bearer t'), verify), FORBIDDEN, `admin=${String(admin)}`);
  }
});

test('an admin passes, with the uid and a trimmed email for attribution', async () => {
  const { verify } = verifier({ uid: 'uid-1', email: '  ana@example.com ', admin: true });
  assert.deepEqual(await requireAdmin(request('Bearer t'), verify), {
    ok: true,
    uid: 'uid-1',
    email: 'ana@example.com',
  });
});

test('an admin with no usable email passes with email null, so callers fall back to the uid', async () => {
  for (const email of [undefined, null, '', '   ']) {
    const { verify } = verifier({ uid: 'uid-2', email, admin: true });
    assert.deepEqual(
      await requireAdmin(request('Bearer t'), verify),
      { ok: true, uid: 'uid-2', email: null },
      `email=${JSON.stringify(email)}`
    );
  }
});

// ─── roles ───────────────────────────────────────────────────────────────────

test('requireAdmin admits each coordination-or-higher role, alone, with the same result shape as before roles', async () => {
  for (const role of ['admin', 'owner', 'su'] as const) {
    const { verify } = verifier({ uid: 'uid-r', email: 'r@example.com', [role]: true });
    assert.deepEqual(
      await requireAdmin(request('Bearer t'), verify),
      { ok: true, uid: 'uid-r', email: 'r@example.com' },
      role,
    );
  }
});

test('requireAdmin refuses a rescuer, event staff and Tesorería, alone or together', async () => {
  for (const claims of [{ rescuer: true }, { events: true }, { rescuer: true, events: true }, { finance: true }]) {
    const { verify } = verifier({ uid: 'u', ...claims });
    assert.deepEqual(await requireAdmin(request('Bearer t'), verify), FORBIDDEN, JSON.stringify(claims));
  }
});

test('requireRole: a claim must be exactly true — strings, numbers and objects grant nothing', async () => {
  for (const value of ['true', 1, {}, null, false]) {
    const { verify } = verifier({ uid: 'u', su: value, owner: value, admin: value, finance: value, rescuer: value, events: value });
    assert.deepEqual(
      await requireRole(request('Bearer t'), verify, ['su', 'owner', 'admin', 'finance', 'rescuer', 'events']),
      FORBIDDEN,
      `value=${JSON.stringify(value)}`,
    );
  }
});

test('requireRole: refuses without calling the verifier when there is no token', async () => {
  const { verify, calls } = verifier({ uid: 'u', rescuer: true });
  assert.deepEqual(await requireRole(request(), verify, ['rescuer']), UNAUTHENTICATED);
  assert.equal(calls.length, 0);
});

test('requireRole: a revoked or invalid token is 401, and verification always checks revocation', async () => {
  const failing = verifier(new Error('auth/id-token-revoked'));
  assert.deepEqual(await requireRole(request('Bearer t'), failing.verify, ['rescuer']), UNAUTHENTICATED);
  const ok = verifier({ uid: 'u', rescuer: true });
  await requireRole(request('Bearer  tok '), ok.verify, ['rescuer']);
  assert.deepEqual(ok.calls, [['tok', true]]);
});

test('requireRole: admits a caller holding any one allowed role, and returns every role it holds', async () => {
  const { verify } = verifier({ uid: 'uid-b', email: ' b@example.com ', rescuer: true, events: true });
  assert.deepEqual(await requireRole(request('Bearer t'), verify, ['admin', 'rescuer']), {
    ok: true,
    uid: 'uid-b',
    email: 'b@example.com',
    roles: { ...NO_ROLES, rescuer: true, events: true },
    authTimeS: null,
  });
});

test('requireRole: exposes auth_time as authTimeS, and null when it is missing or not a finite number', async () => {
  const at = (auth_time: unknown) => verifier({ uid: 'u', finance: true, auth_time } as VerifiedIdToken).verify;
  const authTimeOf = async (value: unknown) => {
    const r = await requireRole(request('Bearer t'), at(value), ['finance']);
    assert.ok(r.ok);
    return r.authTimeS;
  };
  assert.equal(await authTimeOf(1_790_000_000), 1_790_000_000);
  for (const bad of [undefined, null, '1790000000', Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(await authTimeOf(bad), null, String(bad));
  }
  // requireAdmin's shape is unchanged: no authTimeS, no roles.
  const { verify } = verifier({ uid: 'u', admin: true, auth_time: 1 });
  assert.deepEqual(await requireAdmin(request('Bearer t'), verify), { ok: true, uid: 'u', email: null });
});

test('requireRole: every role, alone, against every single-role list — exactly the diagonal passes', async () => {
  const keys: RoleKey[] = ['su', 'owner', 'admin', 'finance', 'rescuer', 'events'];
  for (const held of keys) {
    for (const wanted of keys) {
      const { verify } = verifier({ uid: 'u', [held]: true });
      const result = await requireRole(request('Bearer t'), verify, [wanted]);
      assert.equal(result.ok, held === wanted, `${held} asking for [${wanted}]`);
    }
  }
});

test('requireRole: an empty allow-list admits nobody', async () => {
  const { verify } = verifier({ uid: 'u', su: true, owner: true, admin: true, rescuer: true, events: true });
  assert.deepEqual(await requireRole(request('Bearer t'), verify, []), FORBIDDEN);
});

test('the coordination set is exactly admin, owner and su', () => {
  assert.deepEqual([...COORDINATOR_PLUS].sort(), ['admin', 'owner', 'su']);
});

// ─── every API route goes through it ─────────────────────────────────────────
//
// Source-text checks, and they can be evaded by indirection. They exist because
// a route handler sits outside firestore.rules: a new route that forgets to
// authenticate is caught by nothing else.

const ROOT = process.cwd();

/** Deliberately unauthenticated, each with its reason. */
const UNAUTHENTICATED_ROUTES: Record<string, string> = {
  'src/app/api/qr/[token]/route.ts':
    'reads nothing and answers identically for any well-formed token (qr-guards.test.ts)',
  // The /donate page shows it to anyone. Its GET takes no request at all, so
  // nothing a caller sends can choose the object: only the CONFIRMED QR in
  // donationSettings/current is served, while active and not expired
  // (donations-handler.ts, handlePublicDonationQr; donations-guards.test.ts).
  'src/app/api/donations/qr/route.ts': 'the public, confirmed donation QR; reads no input (donations-handler.ts)',
};

/**
 * Routes any signed-in account may call, each acting on the caller ALONE.
 * These go through `requireUser` instead of `requireAdmin`, and must never
 * read the request body — the uid they act on comes from the verified token.
 */
const USER_ROUTES: Record<string, string> = {
  'src/app/api/account/delete/route.ts': 'a person deleting their own account (account-delete.ts)',
};

/**
 * A signed-in account uploading BYTES for an application it owns. The body is
 * read only after `requireUser`, only as a byte stream through one capped
 * reader, and the owner is decided by the verified uid against the path's
 * application id — never by the body. Kept apart from USER_ROUTES on purpose:
 * that class's rule ("never touches the request") stays exactly as strict, and
 * this one gets its own, narrower, list of what it may do (critic 2026-10-16, #2).
 */
const USER_UPLOAD_ROUTES: Record<string, string> = {
  'src/app/api/adoption-applications/[applicationId]/id-document/[side]/route.ts':
    'an applicant uploading their own ID photo (id-document-handler.ts)',
};

/**
 * A signed-in applicant asking the server to RECORD evidence about their own
 * application — the consent's audit trail. It reads request HEADERS (the IP
 * evidence and the user agent) and nothing else: never the body. Its own
 * class, so USER_ROUTES' "never touches the request" stays exactly as strict.
 */
const USER_RECEIPT_ROUTES: Record<string, string> = {
  'src/app/api/adoption-applications/[applicationId]/acceptance/route.ts':
    "an applicant's consent audit trail: time, IP, account (acceptance-handler.ts)",
};

/** The only request members a receipt route may use, each a header read by name. */
const RECEIPT_HEADERS = ["request.headers.get('x-forwarded-for')", "request.headers.get('fastly-client-ip')", "request.headers.get('user-agent')"];

/** Routes whose whole handler lives in a pure, injectable module. */
const DELEGATED_ROUTES: Record<string, string> = {
  'src/app/api/adoption-applications/[applicationId]/acceptance/route.ts': 'src/lib/acceptance-handler.ts',
  'src/app/api/adoption-applications/[applicationId]/erase-identity/route.ts': 'src/lib/identity-erase-handler.ts',
  'src/app/api/food/cook-batch/route.ts': 'src/lib/cook-batch-handler.ts',
  'src/app/api/account/delete/route.ts': 'src/lib/account-delete.ts',
  'src/app/api/adoption-applications/[applicationId]/id-document/[side]/route.ts':
    'src/lib/id-document-handler.ts',
  'src/app/api/donations/propose/route.ts': 'src/lib/donations-handler.ts',
  'src/app/api/donations/confirm/route.ts': 'src/lib/donations-handler.ts',
  'src/app/api/donations/reject/route.ts': 'src/lib/donations-handler.ts',
  'src/app/api/donations/pending/[pendingId]/qr/route.ts': 'src/lib/donations-handler.ts',
};

/**
 * Any member access on the request — `request.json()`, `request.clone().json()`,
 * `request.headers`, `request.body` — counts as touching it. Listing the body
 * readers by name missed `request.clone().json()`, found 2026-10-15 by a
 * deliberate break. Passing `request` as an argument is not a member access,
 * so `requireAdmin(request, …)` itself does not trip it.
 */
const REQUEST_USE = /\brequest\.[A-Za-z]/;

/** Not a request read, but still work an unauthenticated caller must not trigger. */
const WORK_BEFORE_AUTH = ['aiIsConfigured('];

/**
 * The upload class's own work: the switch, the id check, the Admin SDK read,
 * the body read, the inspection, the save and the marker. Each must come after
 * `requireUser(` in the handler, so none can move above it unnoticed.
 */
const UPLOAD_WORK_BEFORE_AUTH = [
  '.applicationsEnabled',
  'parseApplicationId(',
  'readApplication(',
  'readCapped(',
  'inspectJpeg(',
  'saveIdDocument(',
  'readIdDocumentReceipt(',
  'commitIdMarker(',
  'deleteIdDocumentSide(',
];

/**
 * Ways to read a body that buffer ALL of it before any cap applies, plus
 * `clone()` — the evasion a deliberate break found on 2026-10-15.
 */
const WHOLE_BODY_READERS = ['.json(', '.formData(', '.text(', '.arrayBuffer(', '.blob(', '.clone('];

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

function routeFiles(): string[] {
  return walk(join(ROOT, 'src', 'app', 'api'), (name) => name === 'route.ts');
}

/** Source with comments removed, so a comment naming a call cannot satisfy or trip a check. */
function code(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Routes guarded by `requireRole` with a list wider than coordination, each
 * with the roles it admits and why. A route here must name exactly these
 * roles, so widening one is a reviewed change to this table.
 */
const ROLE_ROUTES: Record<string, { roles: string; why: string }> = {
  'src/app/api/intake/suggest/route.ts': {
    roles: "[...COORDINATOR_PLUS, 'rescuer']",
    why: 'rescuers photograph intakes and may ask for suggestions (plan D7)',
  },
  // Donations: Tesorería and the superuser, NOT coordination (2026-10-24).
  // One `requireRole(` in donations-handler.ts, inside `guard()`, which every
  // handler there calls first (donations-guards.test.ts pins that).
  'src/app/api/donations/propose/route.ts': { roles: 'DONATION_ROLES', why: 'Tesorería or su propose details' },
  'src/app/api/donations/confirm/route.ts': { roles: 'DONATION_ROLES', why: 'Tesorería or su, never the proposer' },
  'src/app/api/donations/reject/route.ts': { roles: 'DONATION_ROLES', why: 'Tesorería or su, never the proposer' },
  'src/app/api/donations/pending/[pendingId]/qr/route.ts': {
    roles: 'DONATION_ROLES',
    why: 'the proposer uploads, Tesorería or su view, a proposal’s QR',
  },
};

/** The guard a staff route calls first: requireAdmin, or requireRole with a named list. */
function staffGuardAt(route: string, src: string): number {
  const role = src.indexOf('requireRole(');
  if (route in ROLE_ROUTES) {
    assert.ok(role >= 0, `${route} is listed in ROLE_ROUTES and must call requireRole(`);
    const call = src.slice(role, src.indexOf(')', src.indexOf(']', role)) + 1);
    assert.ok(call.includes(ROLE_ROUTES[route]!.roles), `${route} must admit exactly ${ROLE_ROUTES[route]!.roles}, found: ${call}`);
    return role;
  }
  assert.ok(role < 0, `${route} calls requireRole( but is not listed in ROLE_ROUTES`);
  return src.indexOf('requireAdmin(');
}

test('every API route authenticates through requireAdmin before it touches the request or checks configuration', () => {
  const routes = routeFiles();
  assert.ok(routes.length >= 5, `found only ${routes.length} routes — is the walk broken?`);

  for (const route of routes) {
    if (route in UNAUTHENTICATED_ROUTES) continue;

    const handler = DELEGATED_ROUTES[route];
    if (handler) {
      const routeSrc = code(route);
      assert.match(routeSrc, /handle\w+\(request\b/, `${route} must hand the request to ${handler}`);
      // The handler owns the request, guard included, so the route file has no
      // guard of its own: any use of the request there runs before it.
      const at = routeSrc.search(REQUEST_USE);
      assert.ok(at < 0, `${route} touches the request before handing it to ${handler}`);
    }

    const file = handler ?? route;
    const src = code(file);
    const userRoute = route in USER_ROUTES || route in USER_UPLOAD_ROUTES || route in USER_RECEIPT_ROUTES;
    const guard = userRoute ? 'requireUser(' : route in ROLE_ROUTES ? 'requireRole(' : 'requireAdmin(';
    const auth = userRoute ? src.indexOf(guard) : staffGuardAt(route, src);
    assert.ok(
      auth >= 0,
      `${file} must call ${guard}) — a route handler sits outside firestore.rules, so that check is its entire boundary`
    );
    const touched = src.search(REQUEST_USE);
    assert.ok(
      touched < 0 || touched > auth,
      `${file} touches the request (${src.slice(touched, touched + 24).trim()}…) before ${guard})`
    );
    const work = route in USER_UPLOAD_ROUTES ? [...WORK_BEFORE_AUTH, ...UPLOAD_WORK_BEFORE_AUTH] : WORK_BEFORE_AUTH;
    for (const call of work) {
      const at = src.indexOf(call);
      assert.ok(at < 0 || at > auth, `${file} calls ${call} before ${guard})`);
    }
  }
});

test('every exemption names a route that exists, so a stale one cannot hide a new route', () => {
  const routes = routeFiles();
  for (const file of [
    ...Object.keys(UNAUTHENTICATED_ROUTES),
    ...Object.keys(DELEGATED_ROUTES),
    ...Object.keys(USER_ROUTES),
    ...Object.keys(USER_UPLOAD_ROUTES),
    ...Object.keys(USER_RECEIPT_ROUTES),
    ...Object.keys(ROLE_ROUTES),
  ]) {
    assert.ok(routes.includes(file), `${file} is listed as an exemption but does not exist`);
  }
});

test('an upload route is delegated, and never also an ordinary user route', () => {
  for (const route of Object.keys(USER_UPLOAD_ROUTES)) {
    assert.ok(DELEGATED_ROUTES[route], `${route} must hand its request to a pure handler`);
    assert.ok(!(route in USER_ROUTES), `${route} is in both classes; USER_ROUTES forbids any request use`);
  }
});

test('an upload route reads its body ONCE, through the capped reader, after the owner checks', () => {
  for (const route of Object.keys(USER_UPLOAD_ROUTES)) {
    const handler = DELEGATED_ROUTES[route]!;
    for (const file of [route, handler]) {
      const src = code(file);
      for (const reader of WHOLE_BODY_READERS) {
        assert.ok(!src.includes(reader), `${file} calls ${reader} — it buffers the whole body before any cap`);
      }
      // `const { body } = request` or `const r = request` would hide a body
      // read from every check here.
      assert.ok(!/\}\s*=\s*request\b/.test(src), `${file} destructures the request`);
      assert.ok(!/=\s*request\s*[;,)]/.test(src), `${file} aliases the request`);
    }

    const src = code(handler);
    const bodyUses = src.match(/\brequest\.body\b/g) ?? [];
    assert.equal(bodyUses.length, 1, `${handler} must touch request.body exactly once, found ${bodyUses.length}`);
    // The cap is a named constant; options (the deadline) may follow it.
    assert.match(src, /readCapped\(request\.body,\s*[A-Z_]+\s*[,)]/, `${handler} must pass request.body straight to readCapped(…, CAP)`);

    const at = (needle: string) => {
      const i = src.indexOf(needle);
      assert.ok(i >= 0, `${handler} never mentions ${needle}`);
      return i;
    };
    const body = at('request.body');
    assert.ok(at('requireUser(') < body, 'the body is read before requireUser');
    assert.ok(at('parseApplicationId(') < body, 'the body is read before the id is checked against the caller');
    assert.match(src, /\.applicantUid\s*!==\s*caller\.uid/, 'the owner must be the VERIFIED caller');
    assert.ok(at("headers.get('content-length')") < body, 'Content-Length must be checked before the body is read');
    assert.ok(at('readApplication(') < body, 'the application must be read (open, owned, not erased) before the body');
    assert.ok(body < at('inspectJpeg('), 'the bytes are inspected after they are read, and before they are saved');
    assert.ok(at('inspectJpeg(') < at('saveIdDocument('), 'nothing is saved before the inspection');
  }
});

test('a receipt route reads three named headers and nothing else, after the owner checks', () => {
  for (const route of Object.keys(USER_RECEIPT_ROUTES)) {
    const handler = DELEGATED_ROUTES[route];
    assert.ok(handler, `${route} must hand its request to a pure handler`);
    assert.ok(!(route in USER_ROUTES) && !(route in USER_UPLOAD_ROUTES), `${route} is in two classes`);
    for (const file of [route, handler]) {
      const src = code(file);
      for (const reader of WHOLE_BODY_READERS) assert.ok(!src.includes(reader), `${file} calls ${reader}`);
      assert.ok(!/\brequest\.body\b/.test(src), `${file} reads the body`);
      assert.ok(!/\}\s*=\s*request\b/.test(src), `${file} destructures the request`);
      assert.ok(!/=\s*request\s*[;,)]/.test(src), `${file} aliases the request`);
    }
    const src = code(handler);
    // Every member access on the request is one of the allowed header reads.
    let rest = src;
    for (const allowed of RECEIPT_HEADERS) rest = rest.split(allowed).join('');
    const at = rest.search(REQUEST_USE);
    assert.ok(at < 0, `${handler} touches the request beyond the allowed headers: ${rest.slice(at, at + 40).trim()}…`);
    const auth = src.indexOf('requireUser(');
    const owner = src.search(/\.applicantUid\s*!==\s*caller\.uid/);
    const read = src.indexOf('readApplication(');
    assert.ok(auth >= 0 && owner > auth && read > auth, `${handler} must check the caller, then read the application`);
    for (const allowed of RECEIPT_HEADERS) {
      const i = src.indexOf(allowed);
      assert.ok(i < 0 || (i > owner && i > read), `${handler} reads ${allowed} before the owner checks`);
    }
    const enabled = src.indexOf('.applicationsEnabled');
    assert.ok(enabled > auth, `${handler} checks the switch before requireUser`);
  }
});

test('a route open to any signed-in account never touches the request itself', () => {
  // Such a route acts on the caller's own uid. A body is the one place a
  // different uid could arrive from, so there must be no way to read one —
  // not directly, not through `request.clone()`. requireUser() reads the
  // Authorization header inside require-admin.ts; nothing here needs more.
  for (const route of Object.keys(USER_ROUTES)) {
    for (const file of [route, DELEGATED_ROUTES[route]].filter((f): f is string => Boolean(f))) {
      const src = code(file);
      const at = src.search(REQUEST_USE);
      assert.ok(at < 0, `${file} touches the request: ${src.slice(at, at + 24).trim()}…`);
    }
  }
});

test('nothing else parses a Bearer header — one copy of the check', () => {
  const files = walk(join(ROOT, 'src'), (name) => /\.tsx?$/.test(name));
  assert.ok(files.includes('src/lib/require-admin.ts'), 'the walk must reach require-admin.ts');
  for (const file of files) {
    if (file === 'src/lib/require-admin.ts') continue;
    assert.equal(
      code(file).includes("startsWith('Bearer ')"),
      false,
      `${file} parses a Bearer header itself; use requireAdmin()`
    );
  }
});
