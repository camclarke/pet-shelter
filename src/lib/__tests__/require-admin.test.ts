import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { requireAdmin, type VerifiedIdToken } from '../require-admin';

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
};

/**
 * Routes any signed-in account may call, each acting on the caller ALONE.
 * These go through `requireUser` instead of `requireAdmin`, and must never
 * read the request body — the uid they act on comes from the verified token.
 */
const USER_ROUTES: Record<string, string> = {
  'src/app/api/account/delete/route.ts': 'a person deleting their own account (account-delete.ts)',
};

/** Routes whose whole handler lives in a pure, injectable module. */
const DELEGATED_ROUTES: Record<string, string> = {
  'src/app/api/food/cook-batch/route.ts': 'src/lib/cook-batch-handler.ts',
  'src/app/api/account/delete/route.ts': 'src/lib/account-delete.ts',
};

/** Nothing on this list may run before `requireAdmin(`. */
const WORK_BEFORE_AUTH = [
  'request.json(',
  'request.formData(',
  'request.text(',
  'request.arrayBuffer(',
  'aiIsConfigured(',
];

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

test('every API route authenticates through requireAdmin before it reads the body or checks configuration', () => {
  const routes = routeFiles();
  assert.ok(routes.length >= 5, `found only ${routes.length} routes — is the walk broken?`);

  for (const route of routes) {
    if (route in UNAUTHENTICATED_ROUTES) continue;

    const handler = DELEGATED_ROUTES[route];
    if (handler) {
      assert.match(code(route), /handle\w+\(request\b/, `${route} must hand the request to ${handler}`);
    }

    const file = handler ?? route;
    const src = code(file);
    const guard = route in USER_ROUTES ? 'requireUser(' : 'requireAdmin(';
    const auth = src.indexOf(guard);
    assert.ok(
      auth >= 0,
      `${file} must call ${guard}) — a route handler sits outside firestore.rules, so that check is its entire boundary`
    );
    for (const work of WORK_BEFORE_AUTH) {
      const at = src.indexOf(work);
      assert.ok(at < 0 || at > auth, `${file} calls ${work} before ${guard})`);
    }
  }
});

test('every exemption names a route that exists, so a stale one cannot hide a new route', () => {
  const routes = routeFiles();
  for (const file of [
    ...Object.keys(UNAUTHENTICATED_ROUTES),
    ...Object.keys(DELEGATED_ROUTES),
    ...Object.keys(USER_ROUTES),
  ]) {
    assert.ok(routes.includes(file), `${file} is listed as an exemption but does not exist`);
  }
});

test('a route open to any signed-in account never reads the request body', () => {
  // Such a route acts on the caller's own uid. A body is the one place a
  // different uid could arrive from, so there must be no way to read one.
  for (const route of Object.keys(USER_ROUTES)) {
    for (const file of [route, DELEGATED_ROUTES[route]].filter((f): f is string => Boolean(f))) {
      for (const read of ['request.json(', 'request.formData(', 'request.text(', 'request.arrayBuffer(', 'request.body']) {
        assert.equal(code(file).includes(read), false, `${file} reads ${read}`);
      }
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
