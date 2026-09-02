import test from 'node:test';
import assert from 'node:assert/strict';
import type { User } from 'firebase/auth';

import {
  SUGGEST_FAILURE_HEADER,
  requestSuggestion,
  type SlottedBlob,
} from '../intake-suggest-client';

const USER = { getIdToken: async () => 'token' } as unknown as User;

const PHOTOS: SlottedBlob[] = [
  { slot: 'front', blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }) },
];

/** Stub `fetch` for one call and always put it back. */
async function withResponse<T>(
  make: () => Response | Promise<never>,
  run: () => Promise<T>
): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => make()) as typeof globalThis.fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

function routeFailure(error: string, status: number): Response {
  // Exactly what the route's fail() produces.
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { [SUGGEST_FAILURE_HEADER]: error },
  });
}

/**
 * ══ THE 2026-09-02 REGRESSION ══════════════════════════════════════════════
 *
 * Firebase Hosting cuts a proxied request at 60s and answers 503 — the same
 * status the route uses for "no API key". The wizard told an admin the feature
 * was "todavía no configurada" while the key was present and had just spent
 * $0.03 on an answer discarded at the edge. A wrong diagnosis is worse than
 * none: it sends someone hunting for a secret that is not missing.
 */
test('an UNSTAMPED 503 is the edge timing out, not a missing API key', async () => {
  const outcome = await withResponse(
    () => new Response('<html>timeout</html>', { status: 503 }),
    () => requestSuggestion(USER, PHOTOS)
  );
  assert.equal(outcome.failure, 'timeout');
  assert.notEqual(
    outcome.failure,
    'not-configured',
    'the edge cutting us off must never be reported as a missing key'
  );
});

test('a STAMPED 503 really is a missing API key', async () => {
  const outcome = await withResponse(
    () => routeFailure('ai-not-configured', 503),
    () => requestSuggestion(USER, PHOTOS)
  );
  assert.equal(outcome.failure, 'not-configured');
});

test('any unstamped 5xx is treated as retryable, not as a diagnosis', async () => {
  for (const status of [500, 502, 503, 504, 520]) {
    const outcome = await withResponse(
      () => new Response('', { status }),
      () => requestSuggestion(USER, PHOTOS)
    );
    assert.equal(outcome.failure, 'timeout', `status ${status}`);
  }
});

test('a stamped 502 from the route stays a plain failure', async () => {
  const outcome = await withResponse(
    () => routeFailure('suggest-failed', 502),
    () => requestSuggestion(USER, PHOTOS)
  );
  assert.equal(outcome.failure, 'failed');
});

test("the route's own 504 is still a timeout", async () => {
  const outcome = await withResponse(
    () => routeFailure('suggest-timeout', 504),
    () => requestSuggestion(USER, PHOTOS)
  );
  assert.equal(outcome.failure, 'timeout');
});

test('4xx answers keep their meaning, stamped or not', async () => {
  const cases: Array<[string, number, string]> = [
    ['unauthenticated', 401, 'unauthorized'],
    ['forbidden', 403, 'unauthorized'],
    ['photo-too-large', 413, 'photo-rejected'],
    ['photo-unsupported', 415, 'photo-rejected'],
    ['photo-unreadable', 400, 'photo-rejected'],
  ];
  for (const [error, status, expected] of cases) {
    const outcome = await withResponse(
      () => routeFailure(error, status),
      () => requestSuggestion(USER, PHOTOS)
    );
    assert.equal(outcome.failure, expected, `${status} ${error}`);
  }
});

test('a successful answer carries the suggestion and the model key', async () => {
  const outcome = await withResponse(
    () =>
      new Response(JSON.stringify({ suggestion: { species: 'dog' }, modelKey: 'flash' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    () => requestSuggestion(USER, PHOTOS)
  );
  assert.equal(outcome.failure, null);
  assert.equal(outcome.modelKey, 'flash');
  assert.deepEqual(outcome.suggestion, { species: 'dog' } as never);
});

test('a thrown fetch never escapes — an intake must not be blocked', async () => {
  const outcome = await withResponse(
    () => Promise.reject(new Error('offline')) as Promise<never>,
    () => requestSuggestion(USER, PHOTOS)
  );
  assert.equal(outcome.failure, 'failed');
  assert.equal(outcome.suggestion, null);
});

test('no photos never reaches the network, so no quota is spent', async () => {
  let called = false;
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    called = true;
    return new Response('', { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    const outcome = await requestSuggestion(USER, []);
    assert.equal(outcome.failure, 'photo-rejected');
    assert.equal(called, false, 'an empty set must not spend one of 20 daily requests');
  } finally {
    globalThis.fetch = real;
  }
});

/**
 * Pinned as a literal on purpose. The header is a wire contract between a
 * deployed bundle and a deployed route, so a rename is a rollout concern, not
 * a refactor — this test makes one visible in the diff instead of green.
 */
test('the failure header name is part of the wire contract', () => {
  assert.equal(SUGGEST_FAILURE_HEADER, 'X-Suggest-Failure');
});
