import test from 'node:test';
import assert from 'node:assert/strict';
import type { User } from 'firebase/auth';

import { FOOD_PARSE_FAILURE_HEADER, requestDonationParse } from '../food-parse-client';

const USER = { getIdToken: async () => 'token' } as unknown as User;

async function withResponse<T>(make: () => Response, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => make()) as typeof globalThis.fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

function routeFailure(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), { status, headers: { [FOOD_PARSE_FAILURE_HEADER]: error } });
}

test('an UNSTAMPED 503 is the edge timing out, not a missing key', async () => {
  const outcome = await withResponse(
    () => new Response('<html>timeout</html>', { status: 503 }),
    () => requestDonationParse(USER, '2 kg de arroz')
  );
  assert.equal(outcome.failure, 'timeout');
});

test('a STAMPED 503 is the key genuinely missing', async () => {
  const outcome = await withResponse(
    () => routeFailure('ai-not-configured', 503),
    () => requestDonationParse(USER, '2 kg de arroz')
  );
  assert.equal(outcome.failure, 'not-configured');
});

test('auth, text and timeout failures are named', async () => {
  const cases: [Response, string][] = [
    [routeFailure('unauthenticated', 401), 'unauthorized'],
    [routeFailure('forbidden', 403), 'unauthorized'],
    [routeFailure('text-too-long', 413), 'text-rejected'],
    [routeFailure('parse-timeout', 504), 'timeout'],
    [routeFailure('parse-failed', 502), 'failed'],
  ];
  for (const [response, expected] of cases) {
    const outcome = await withResponse(() => response, () => requestDonationParse(USER, 'x'));
    assert.equal(outcome.failure, expected);
  }
});

test('success returns the proposed lines; a blank text never leaves the browser', async () => {
  const ok = await withResponse(
    () => new Response(JSON.stringify({ donor: null, lines: [], modelKey: 'flash-lite' }), { status: 200 }),
    () => requestDonationParse(USER, '2 kg de arroz')
  );
  assert.deepEqual(ok, { donor: null, lines: [], modelKey: 'flash-lite', failure: null });

  let called = false;
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    called = true;
    return new Response('{}');
  }) as typeof globalThis.fetch;
  try {
    const blank = await requestDonationParse(USER, '   ');
    assert.equal(blank.failure, 'text-rejected');
    assert.equal(called, false);
  } finally {
    globalThis.fetch = real;
  }
});
