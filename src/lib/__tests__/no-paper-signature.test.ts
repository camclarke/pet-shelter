// Owner decision 2026-10-21 (reverses D11/D12 and the 2026-10-17 decision):
// the online checkbox acceptance IS the signature. No applicant-facing copy
// may say the commitment is signed on paper. Copy only: the contract text,
// version and hash are pinned by their own tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { es } from '@/i18n/es';

const FORBIDDEN = [/firma en papel/i, /firman en papel/i, /firmas el compromiso/i, /en papel el día de la entrega/i];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (typeof value === 'function') {
    try {
      const r = (value as (...a: unknown[]) => unknown)('Wawitas', 'Luna', 1);
      strings(r, out);
    } catch {
      /* a function needing a richer argument is covered by the source scan */
    }
  } else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
  return out;
}

test('no applicant-facing string says the commitment is signed on paper', () => {
  const all = strings(es.applicationSteps);
  assert.ok(all.length > 20);
  for (const s of all) for (const re of FORBIDDEN) assert.ok(!re.test(s), `${re}: ${s}`);
});

test('no source in the apply flow, the contract page or the catalogue says it either', () => {
  const files = [...walk(path.resolve('src/app/adopt')), path.resolve('src/i18n/es.ts'), path.resolve('src/i18n/messages.ts')];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const re of FORBIDDEN) assert.ok(!re.test(text), `${re} in ${f}`);
  }
});

test('the acceptance note is the owner-approved sentence, exactly', () => {
  assert.equal(
    es.applicationSteps.acceptanceNote,
    'Al marcar la casilla y enviar tu solicitud, aceptas este compromiso.',
  );
  assert.equal(
    es.applicationSteps.confirmationAccepted,
    'Tu aceptación del compromiso quedó registrada con la fecha y la hora.',
  );
});
