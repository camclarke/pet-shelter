/**
 * The post-sign-in return path. An allowlist, so these tests are mostly about
 * what must be REFUSED: every one of these is a shape of open redirect that a
 * naive `startsWith('/')` check lets through.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { safeReturnPath, signInHrefReturningTo } from '../return-path';

test('an application form path is returned as-is', () => {
  assert.equal(safeReturnPath('/adopt/luna/apply'), '/adopt/luna/apply');
  assert.equal(safeReturnPath('/adopt/luna-2/apply'), '/adopt/luna-2/apply');
});

test('another host is refused, in every spelling', () => {
  for (const raw of [
    'https://evil.example/adopt/luna/apply',
    '//evil.example/adopt/luna/apply',
    '/\\evil.example/adopt/luna/apply',
    '\\\\evil.example',
    'javascript:alert(1)',
  ]) {
    assert.equal(safeReturnPath(raw), null, raw);
  }
});

test('anything that is not an application form is refused', () => {
  // Deliberately narrow. Returning someone to /admin after sign-in is not a
  // flow this feature needs, and every widening is a new redirect to reason about.
  for (const raw of ['/', '/admin', '/account', '/adopt/luna', '/adopt/luna/apply/', '/adopt//apply']) {
    assert.equal(safeReturnPath(raw), null, raw);
  }
});

test('a query, a fragment, an encoded byte or a traversal is refused', () => {
  for (const raw of [
    '/adopt/luna/apply?next=//evil.example',
    '/adopt/luna/apply#x',
    '/adopt/lu%2Fna/apply',
    '/adopt/../admin/apply',
    '/adopt/Luna/apply',
    '/adopt/luna_2/apply',
    '/adopt/-luna/apply',
  ]) {
    assert.equal(safeReturnPath(raw), null, raw);
  }
});

test('empty, missing and absurdly long values are refused', () => {
  assert.equal(safeReturnPath(null), null);
  assert.equal(safeReturnPath(undefined), null);
  assert.equal(safeReturnPath(''), null);
  assert.equal(safeReturnPath(`/adopt/${'a'.repeat(200)}/apply`), null);
});

test('the sign-in link carries a safe path, encoded, and drops an unsafe one', () => {
  assert.equal(
    signInHrefReturningTo('/adopt/luna/apply'),
    '/account?next=%2Fadopt%2Fluna%2Fapply',
  );
  assert.equal(signInHrefReturningTo('//evil.example'), '/account');
});

test('the encoded link decodes back to exactly the path that passed', () => {
  // /account reads `next` through URLSearchParams, which decodes. The value it
  // checks must be the value that was allowed, not a re-encoded variant.
  const href = signInHrefReturningTo('/adopt/luna-2/apply');
  const next = new URLSearchParams(href.split('?')[1]).get('next');
  assert.equal(safeReturnPath(next), '/adopt/luna-2/apply');
});
