import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  isLabelPhotoPathFor,
  labelPhotoPath,
  parseLabelExtractRequest,
} from '../label-extraction';
import {
  LABEL_FAILURE_HEADER,
  classifyLabelFailure,
  formPatchFromLabel,
  labelProvenanceFrom,
  type LabelExtractSuccess,
} from '../label-extract-client';
import { es } from '@/i18n/es';
import { findVoseo } from '../ai/spanish-register';

/**
 * "Escanear etiqueta", plan C4: the route's input check, the browser's helpers,
 * and source-level wiring checks on the route and the form.
 *
 * ⚠️ The wiring checks read source text. There is no component-test setup here
 * and the screens sit behind AdminGate, so this is the check available — crude,
 * and the reason each one names exactly what it pins.
 */

const ROOT = process.cwd();
const code = (path: string) =>
  readFileSync(join(ROOT, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const ROUTE = 'src/app/api/medical/labels/extract/route.ts';
const PANEL = 'src/app/admin/pets/[petId]/MedicalPanel.tsx';
const SCAN = 'src/app/admin/pets/[petId]/LabelScan.tsx';
const ADMIN = 'src/lib/medical-admin.ts';

const UUID = '0f8e2c1a-1b2c-4d5e-8f90-123456789abc';

// ─── the path: exactly one object, nothing else ──────────────────────────────

test('a label photo lives flat beside the card photos, under medical/', () => {
  assert.equal(labelPhotoPath('pet1', UUID), `medical/pet1/label-${UUID}.jpg`);
});

test('the route accepts only this pet’s label photo', () => {
  assert.deepEqual(parseLabelExtractRequest({ petId: 'pet1', path: `medical/pet1/label-${UUID}.jpg` }), {
    petId: 'pet1',
    path: `medical/pet1/label-${UUID}.jpg`,
  });
  for (const path of [
    `medical/pet1/card-${UUID}.jpg`, // a card can carry the owner's address
    `medical/pet2/label-${UUID}.jpg`, // another pet's file
    `pets/pet1/private/${UUID}.jpg`, // an intimate intake photo
    `medical/pet1/label-${UUID}.png`,
    `medical/pet1/label-../../x.jpg`,
    `medical/pet1/label-short.jpg`,
    `medical/pet1/sub/label-${UUID}.jpg`,
    null,
    42,
  ]) {
    assert.equal(isLabelPhotoPathFor(path, 'pet1'), false, String(path));
    assert.equal(parseLabelExtractRequest({ petId: 'pet1', path }), null, String(path));
  }
  assert.equal(parseLabelExtractRequest({ petId: '../x', path: `medical/../x/label-${UUID}.jpg` }), null);
  assert.equal(parseLabelExtractRequest(null), null);
  assert.equal(parseLabelExtractRequest('x'), null);
});

// ─── the browser's reading of a response ─────────────────────────────────────

test('an unstamped 5xx is the edge, a retryable timeout — never "not configured"', () => {
  assert.equal(classifyLabelFailure(503, null), 'timeout');
  assert.equal(classifyLabelFailure(504, null), 'timeout');
  assert.equal(classifyLabelFailure(401, null), 'unauthorized');
  assert.equal(classifyLabelFailure(400, null), 'failed');
});

test('stamped failures map to what the form can say', () => {
  assert.equal(LABEL_FAILURE_HEADER, 'X-Label-Failure');
  assert.equal(classifyLabelFailure(503, 'ai-not-configured'), 'not-configured');
  assert.equal(classifyLabelFailure(503, 'storage-not-configured'), 'not-configured');
  assert.equal(classifyLabelFailure(401, 'unauthenticated'), 'unauthorized');
  assert.equal(classifyLabelFailure(403, 'forbidden'), 'unauthorized');
  for (const e of ['bad-request', 'label-not-found', 'label-too-large', 'label-unsupported']) {
    assert.equal(classifyLabelFailure(400, e), 'photo-rejected', e);
  }
  assert.equal(classifyLabelFailure(404, 'pet-not-found'), 'pet-missing');
  assert.equal(classifyLabelFailure(504, 'extract-timeout'), 'timeout');
  assert.equal(classifyLabelFailure(502, 'extract-failed'), 'failed');
});

function success(over: Partial<LabelExtractSuccess> = {}): LabelExtractSuccess {
  return {
    notALabel: false,
    fill: { product: 'Producto 4', manufacturer: 'Laboratorio', productExpiresAt: 1_900_000_000_000 },
    offer: { batch: 'AB1234' },
    evidence: {
      product: { snippet: 'Producto 4', confidence: 1, withheld: null },
      manufacturer: { snippet: 'Laboratorio', confidence: 1, withheld: null },
      protectsAgainst: { snippet: null, confidence: 0, withheld: null },
      lot: { snippet: 'Lote AB1234', confidence: 1, withheld: null },
      manufacturedAt: { snippet: null, confidence: 0, withheld: null },
      expiresAt: { snippet: 'Venc 03 ENE 30', confidence: 1, withheld: null },
    },
    highlighted: ['productExpiresAt'],
    modelKey: 'flash-lite',
    path: `medical/pet1/label-${UUID}.jpg`,
    ...over,
  };
}

test('a reading changes only the fields it read — and never the lot', () => {
  assert.deepEqual(formPatchFromLabel(success()), {
    product: 'Producto 4',
    manufacturer: 'Laboratorio',
    productExpiresAt: 1_900_000_000_000,
  });
  // A field the label left empty keeps what the person typed.
  assert.deepEqual(
    formPatchFromLabel(success({ fill: { product: null, manufacturer: null, productExpiresAt: null } })),
    {}
  );
  for (const forbidden of ['batch', 'performedAt', 'nextDueAt', 'validUntil', 'name', 'kind']) {
    assert.equal(forbidden in formPatchFromLabel(success()), false, forbidden);
  }
});

test('a photo that is not a label changes nothing and attributes nothing', () => {
  const notLabel = success({ notALabel: true });
  assert.deepEqual(formPatchFromLabel(notLabel), {});
  assert.equal(labelProvenanceFrom({ result: notLabel, readAt: 5 }), null);
});

test('no scan means a record typed by hand', () => {
  assert.equal(labelProvenanceFrom(null), null);
  assert.equal(labelProvenanceFrom({ result: success({ evidence: null }), readAt: 5 }), null);
});

test('a scan records the label photo, the model and what it read', () => {
  const r = success();
  assert.deepEqual(labelProvenanceFrom({ result: r, readAt: 123 }), {
    sourceDocument: r.path,
    modelKey: 'flash-lite',
    evidence: r.evidence,
    extractedAt: 123,
  });
});

// ─── the route: writes nothing, checks everything first ──────────────────────

test('the route checks the admin claim before reading the body or the configuration', () => {
  const src = code(ROUTE);
  const auth = src.indexOf('requireAdmin(request, verifyAdminIdToken)');
  assert.ok(auth > 0);
  assert.ok(auth < src.indexOf('aiIsConfigured()'));
  // ANY use of the request before the check — `request.json()`, and also
  // `request.clone().json()` or `request.headers` — not just the obvious one.
  const firstUse = src.search(/\brequest\.[A-Za-z]/);
  assert.ok(firstUse > auth, `request is used at ${firstUse}, before the admin check at ${auth}`);
});

test('the route checks the path before reading any object', () => {
  const src = code(ROUTE);
  const parse = src.indexOf('parseLabelExtractRequest(body)');
  assert.ok(parse > 0);
  assert.ok(parse < src.indexOf('readCardPhoto(path)'));
  assert.ok(/if \(!parsed\) return fail\('bad-request', 400\);/.test(src));
});

test('the route accepts drafts, and writes NOTHING to Firestore or Storage', () => {
  const src = code(ROUTE);
  assert.ok(/petOrDraftExists\(petId\)/.test(src));
  assert.equal(/\bpetExists\(/.test(src), false);
  for (const write of ['.set(', '.add(', '.update(', '.delete(', 'writeCardCandidates', 'getAdminDb', 'save(']) {
    assert.equal(src.includes(write), false, write);
  }
});

test('the route decides what a reading is worth on the server, with the gate', () => {
  assert.ok(/reviewLabelExtraction\(extraction\.raw, Date\.now\(\)\)/.test(code(ROUTE)));
});

test('the card route still refuses drafts — it was not reworked', () => {
  const card = code('src/app/api/medical/cards/extract/route.ts');
  assert.ok(/petExists\(petId\)/.test(card));
  assert.equal(card.includes('petOrDraftExists'), false);
});

// ─── the browser: privacy order, and the form ────────────────────────────────

test('a label photo is stripped of EXIF before it is uploaded, and never given a URL', () => {
  const src = code(SCAN);
  const strip = src.indexOf('stripAndResize(file, LABEL_PHOTO_MAX_EDGE)');
  assert.ok(strip > 0);
  assert.ok(strip < src.indexOf('uploadLabelPhoto(petId, processed)'));
  assert.equal(code(ADMIN).includes('getDownloadURL'), false);
});

test('the scan is offered only on a NEW record, never on an edit or a card review', () => {
  assert.ok(/\{editing === null && \(\s*<LabelScan/.test(code(PANEL)));
});

test('a reading reaches the form only through formPatchFromLabel', () => {
  const src = code(PANEL);
  assert.ok(/patch\(formPatchFromLabel\(result\)\)/.test(src));
});

test('the lot reaches the form only from a tap on the offer', () => {
  const src = code(PANEL);
  const uses = src.match(/scan\.result\.offer\.batch/g) ?? [];
  assert.ok(uses.length >= 1);
  assert.ok(/onClick=\{\(\) => patch\(\{ batch: scan\.result\.offer\.batch \}\)\}/.test(src));
});

test('saving a new record attributes it to the scanned label, and every other open clears the scan', () => {
  const src = code(PANEL);
  assert.ok(/addMedicalRecord\(petId, draft, user, labelProvenanceFrom\(scan\)\)/.test(src));
  for (const fn of ['function startNew()', 'function startEdit(', 'function startReview(']) {
    // The function's own closing brace, at two-space indent — not the first `}`
    // inside it, which may close an object literal.
    const start = src.indexOf(fn);
    assert.ok(start > 0, fn);
    const body = src.slice(start, src.indexOf('\n  }', start));
    assert.ok(/setScan\(null\)/.test(body), fn);
  }
});

test('a record saved from a label is llm-extracted, from the label, and confirmed by the person', () => {
  const src = code(ADMIN);
  assert.ok(/source: fromLabel \? 'llm-extracted' : 'manual'/.test(src));
  assert.ok(/extractedFrom: fromLabel \? 'vaccine-label' : null/.test(src));
  assert.ok(/sourceDocument: fromLabel\?\.sourceDocument \?\? null/.test(src));
  assert.ok(/confirmedBy: by,/.test(src));
});

// ─── copy ────────────────────────────────────────────────────────────────────

test('the scan copy is neutral Spanish and never calls a lot checked', () => {
  const strings = [
    ...Object.values(es.labelScan).filter((v): v is string => typeof v === 'string'),
    es.labelScan.readFrom('x'),
    es.labelScan.lotOffer('x'),
    es.labelScanSummary({ notALabel: false, filled: 2, lotOffered: true }),
    es.labelScanSummary({ notALabel: true, filled: 0, lotOffered: false }),
    es.labelScanSummary({ notALabel: false, filled: 0, lotOffered: false }),
    ...(['not-configured', 'unauthorized', 'photo-rejected', 'pet-missing', 'timeout', 'failed'] as const).map(
      (f) => es.labelScanFailure(f)
    ),
  ];
  for (const s of strings) assert.deepEqual(findVoseo(s), [], s);
  assert.ok(/Compara cada número con la etiqueta/.test(es.labelScan.lotOfferHint));
  assert.ok(/La fecha de aplicación y la próxima dosis las pones tú/.test(es.labelScan.hint));
  assert.equal(es.extractionSourceLabel('vaccine-label'), 'Leído de la etiqueta del frasco');
});
