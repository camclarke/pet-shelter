import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Source-level wiring checks for the review gate, plan §4.8.
 *
 * ⚠️ Crude on purpose, and the only check available: there is no component
 * test setup here, and `/admin/pets/{id}` sits behind `AdminGate`, which needs
 * a human password. PR #26 (2026-09-02) is why a wiring check is worth having
 * at all — the policy layer computed `sex` and the UI threw it away, with every
 * unit test green. The pure gate being right proves nothing if a screen
 * computes around it.
 *
 * `npm test` runs from the repository root, so paths are relative to it.
 */

const ROOT = process.cwd();

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

/** Source with line and block comments removed, so a comment cannot satisfy or fail a check. */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, entry);
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(rel);
  }
  return out;
}

const PANEL = 'src/app/admin/pets/[petId]/MedicalPanel.tsx';

test('the medical panel draws row flags through the gate, never around it', () => {
  const src = code(PANEL);
  assert.ok(/recordSignals\(/.test(src), 'rows must use recordSignals()');
  assert.equal(/\bisOverdue\(/.test(src), false, 'isOverdue() bypasses the gate');
  assert.equal(/\bprotectionLapsed\(/.test(src), false, 'protectionLapsed() bypasses the gate');
});

test('the medical panel computes its summary through summarizeMedicalHistory', () => {
  const src = code(PANEL);
  assert.ok(/summarizeMedicalHistory\(/.test(src));
  assert.equal(/\bnextDue\(/.test(src), false, 'call nextDue through the summary');
});

test('one-click confirm is offered only through canConfirmAsIs', () => {
  const src = code(PANEL);
  assert.ok(/canConfirmAsIs\(/.test(src));
  assert.ok(/confirmMedicalRecord\(/.test(src));
});

test('no public surface reads the medical collection without the gate', () => {
  // Public = every page and component that is not the admin console or an API
  // route, plus the server module the public pages read through.
  const publicFiles = [
    ...walk('src/app').filter(
      (f) => !f.includes(join('src', 'app', 'admin')) && !f.includes(join('src', 'app', 'api'))
    ),
    ...walk('src/components'),
    'src/lib/pets-server.ts',
  ];
  assert.ok(publicFiles.length > 5, 'the scan must actually see the public pages');

  const offenders = publicFiles.filter((file) => {
    const src = code(file);
    const readsMedical = /['"`]medical['"`]/.test(src);
    const gated = /summarizeMedicalHistory|confirmedOnly/.test(src);
    return readsMedical && !gated;
  });
  assert.deepEqual(
    offenders.map((f) => relative(ROOT, join(ROOT, f))),
    [],
    'a public module reads `medical` without summarizeMedicalHistory or confirmedOnly'
  );
});

test('the card route never confirms anything', () => {
  for (const file of ['src/app/api/medical/cards/extract/route.ts', 'src/lib/medical-server.ts']) {
    assert.equal(
      /confirmedBy\s*:/.test(code(file)),
      false,
      `${file} must not set confirmedBy — candidateRecordFields writes null`
    );
  }
});

test('a card photo is never given a download URL', () => {
  for (const file of [
    'src/lib/medical-admin.ts',
    'src/app/admin/pets/[petId]/CardCapture.tsx',
    'src/app/admin/pets/[petId]/ReviewEvidence.tsx',
  ]) {
    assert.equal(/getDownloadURL/.test(code(file)), false, `${file} must not mint a token`);
  }
});

test('the card is stripped of EXIF before it is uploaded', () => {
  const src = code('src/app/admin/pets/[petId]/CardCapture.tsx');
  const strip = src.indexOf('stripAndResize(');
  const upload = src.indexOf('uploadCardPhoto(');
  assert.ok(strip >= 0 && upload >= 0, 'both calls must be present');
  assert.ok(strip < upload, 'stripAndResize must run before uploadCardPhoto');
});

test('the route checks the admin claim before it checks configuration', () => {
  // A 503 "not configured" answered to an unauthenticated caller would tell
  // them whether the feature is switched on.
  const src = code('src/app/api/medical/cards/extract/route.ts');
  const auth = src.indexOf('verifyIdToken(token, true)');
  const configured = src.indexOf('aiIsConfigured()');
  assert.ok(auth >= 0, 'must verify with checkRevoked');
  assert.ok(configured > auth, 'authentication must come first');
});
