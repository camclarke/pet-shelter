/**
 * The admin's erase panel on an application's review (2026-10-17): offers only
 * the reasons the route accepts, warns on "died", and never erases without a
 * second, named confirmation.
 *
 * Run with:  node --test --import tsx src/lib/__tests__/erase-panel.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ErasePanel } from '@/app/admin/applications/[applicationId]/ApplicationReview';
import { es } from '@/i18n/es';
import type { ApplicationStatus } from '../types';

function panel(status: ApplicationStatus): string {
  return renderToStaticMarkup(
    createElement(ErasePanel, { status, applicant: 'Ana Pérez', petName: 'Luna', onErase: async () => null }),
  )
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

const options = (html: string) => [...html.matchAll(/<option value="([a-z-]+)"/g)].map((m) => m[1]);

test('an OPEN application offers no erase at all, only the reason why', () => {
  for (const status of ['submitted', 'reviewing', 'interview'] as const) {
    const html = panel(status);
    assert.ok(html.includes(es.applications.eraseOpenHint), status);
    assert.equal(options(html).length, 0, status);
    assert.ok(!html.includes(es.applications.eraseStart));
  }
});

test('an approved application offers "returned" and "died"; a closed one only "not-adopted"', () => {
  assert.deepEqual(options(panel('approved')), ['returned', 'died']);
  assert.deepEqual(options(panel('rejected')), ['not-adopted']);
  assert.deepEqual(options(panel('withdrawn')), ['not-adopted']);
});

test('the reasons say what the clause says — a NATURAL death — and nothing is erased on first render', () => {
  const html = panel('approved');
  assert.ok(html.includes('El animalito falleció por causas naturales'));
  assert.ok(html.includes(es.applications.eraseLead));
  assert.ok(html.includes(`>${es.applications.eraseStart}</button>`));
  // The confirmation (and its button) appears only after «Borrar carnet y dirección…».
  assert.ok(!html.includes(es.applications.eraseButton));
});

test('the confirmation names the person and the animal', () => {
  assert.equal(
    es.applications.eraseConfirm('Ana Pérez', 'Luna'),
    '¿Borrar para siempre el carnet, la dirección y los datos personales de Ana Pérez (solicitud por Luna)? No se puede deshacer.',
  );
  assert.ok(es.applications.eraseDiedWarning.includes('POFOMA'));
});
