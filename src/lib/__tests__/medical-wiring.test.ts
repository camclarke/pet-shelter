import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Source-level wiring checks for the review, plan §4.8.
 *
 * ⚠️ Crude on purpose, and the only check available: there is no component
 * test setup here, and `/admin/pets/{id}` sits behind `AdminGate`, which needs
 * a human password. PR #26 (2026-09-02) is why a wiring check is worth having
 * at all — the policy layer computed `sex` and the UI threw it away, with every
 * unit test green. These are tests of source text, not of behaviour: a check
 * that does not follow imports can be evaded by indirection (step-9 evaluation).
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

/** The body of one exported function, from its declaration to the next top-level export. */
function exportedFunction(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const next = src.indexOf('\nexport ', start + 1);
  return src.slice(start, next < 0 ? undefined : next);
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
const ADMIN = 'src/lib/medical-admin.ts';
const SERVER = 'src/lib/medical-server.ts';
const ROUTE = 'src/app/api/medical/cards/extract/route.ts';

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

test('confirmMedicalRecord refuses to write unless the confirmation plan succeeds', () => {
  // The invariant lives with the write, not with whichever button calls it.
  const body = exportedFunction(code(ADMIN), 'confirmMedicalRecord');
  const plan = body.indexOf('planConfirmation(');
  const refuse = body.indexOf('throw new MedicalConfirmationError(');
  const write = body.indexOf('runTransaction(');
  assert.ok(plan >= 0, 'must call planConfirmation()');
  assert.ok(refuse > plan, 'must throw MedicalConfirmationError when the plan fails');
  assert.ok(write > refuse, 'the write must come after the refusal');
});

test('confirming reads the candidate inside the transaction and deletes it there', () => {
  const body = exportedFunction(code(ADMIN), 'confirmMedicalRecord');
  assert.ok(/tx\.get\(candidateRef\)/.test(body), 'a gone candidate must not become a record');
  assert.ok(/tx\.set\(recordRef/.test(body));
  assert.ok(/tx\.delete\(candidateRef\)/.test(body));
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
    return (readsMedical && !gated) || /medicalCandidates/.test(src);
  });
  assert.deepEqual(
    offenders.map((f) => relative(ROOT, join(ROOT, f))),
    [],
    'a public module reads `medical` without the gate, or reads candidates at all'
  );
});

test('the card route and its server writer never confirm anything', () => {
  for (const file of [ROUTE, SERVER]) {
    assert.equal(
      /confirmedBy\s*:/.test(code(file)),
      false,
      `${file} must not set confirmedBy — a candidate has no such field`
    );
  }
});

test('the server writer puts readings in medicalCandidates and only READS medical', () => {
  const src = code(SERVER);
  const medicalRefs = src.match(/collection\('medical'\)/g) ?? [];
  assert.equal(medicalRefs.length, 1, 'medical may be touched only by the already-read check');
  assert.ok(/collection\('medical'\)\s*\.where\('sourceDocument'/.test(src));
  assert.ok(
    /doc\(petId\)\.collection\('medicalCandidates'\)/.test(src),
    'candidates must be written to medicalCandidates'
  );
});

test('candidates are written create-if-absent, never overwritten', () => {
  const body = exportedFunction(code(SERVER), 'writeCardCandidates');
  assert.ok(/batch\.create\(/.test(body), 'create is what makes the deterministic id an idempotency key');
  assert.equal(/batch\.set\(/.test(body), false);
  assert.ok(/candidateIdFor\(/.test(body));
});

test('a card photo is never given a download URL', () => {
  for (const file of [
    ADMIN,
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
  const src = code(ROUTE);
  const auth = src.indexOf('verifyIdToken(token, true)');
  const configured = src.indexOf('aiIsConfigured()');
  assert.ok(auth >= 0, 'must verify with checkRevoked');
  assert.ok(configured > auth, 'authentication must come first');
});
