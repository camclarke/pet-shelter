import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LABEL_EARLIEST_YEAR,
  LABEL_FIELDS,
  LABEL_FURTHEST_EXPIRY_YEARS,
  LABEL_LOT_MAX_CHARS,
  isExpiryWord,
  isLotWord,
  isMadeWord,
  labelThresholdsFor,
  reviewLabelExtraction,
  type RawLabelExtraction,
} from '../label-extraction';

/**
 * The label gate, plan C3. What a model's reading of a vaccine sticker is
 * worth, and above all what it can NEVER put in the form.
 *
 * Every threshold below is a literal, never the constant under test — a test
 * that compares a function against the constant it reads cannot fail.
 * Fixture values are invented and match no real label.
 */

const NOW = Date.UTC(2026, 9, 15, 12);
const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 12);

function label(over: Partial<RawLabelExtraction> = {}): RawLabelExtraction {
  return {
    isVeterinaryLabel: true,
    product: { snippet: 'Producto Ejemplo 4', confidence: 0.95 },
    manufacturer: { snippet: 'Laboratorio Ejemplo', confidence: 0.95 },
    protectsAgainst: { snippet: 'contra el moquillo', confidence: 0.95 },
    lot: { fieldWord: 'N. Lote', snippet: 'AB1234', confidence: 0.95 },
    manufacturedAt: { fieldWord: 'F. Elab', snippet: '03 ENE 26', confidence: 0.95 },
    expiresAt: { fieldWord: 'F. Venc', snippet: '03 ENE 28', confidence: 0.95 },
    ...over,
  };
}

function reviewed(raw: unknown) {
  const r = reviewLabelExtraction(raw, NOW);
  assert.equal(r.kind, 'reviewed');
  if (r.kind !== 'reviewed') throw new Error('unreachable');
  return r;
}

// ─── the shape: what a label can never fill ──────────────────────────────────

test('a label prefills only product, laboratory and vial expiry — never a dose date', () => {
  const r = reviewed(label());
  assert.deepEqual(Object.keys(r.fill).sort(), ['manufacturer', 'product', 'productExpiresAt']);
  assert.deepEqual(Object.keys(r.offer), ['batch']);
  for (const forbidden of ['performedAt', 'nextDueAt', 'validFrom', 'validUntil']) {
    assert.equal(forbidden in r.fill, false, forbidden);
    assert.equal(forbidden in r.offer, false, forbidden);
  }
});

test('the lot is OFFERED, never prefilled — even read at confidence 1.0', () => {
  // Measured 2026-10-15: wrong lot digits came back at confidence 1.0 in 3 of
  // 3 runs, so no confidence makes prefilling a lot safe.
  const r = reviewed(label({ lot: { fieldWord: 'N. Lote', snippet: 'AB1234', confidence: 1 } }));
  assert.equal('batch' in r.fill, false);
  assert.equal(r.offer.batch, 'AB1234');
});

test('the fields read are exactly the six the schema asks for', () => {
  assert.deepEqual(
    [...LABEL_FIELDS],
    ['product', 'manufacturer', 'protectsAgainst', 'lot', 'manufacturedAt', 'expiresAt']
  );
});

test('a clean label fills every field', () => {
  const r = reviewed(label());
  assert.deepEqual(r.fill, {
    product: 'Producto Ejemplo 4',
    manufacturer: 'Laboratorio Ejemplo',
    productExpiresAt: day(2028, 1, 3),
  });
  assert.deepEqual(r.offer, { batch: 'AB1234' });
  // The expiry is shown with its snippet even at 0.95: the date is our parse.
  assert.deepEqual(r.highlighted, ['productExpiresAt']);
});

test('something that is not a label fills nothing', () => {
  assert.deepEqual(reviewLabelExtraction(label({ isVeterinaryLabel: false }), NOW), { kind: 'not-a-label' });
  assert.deepEqual(reviewLabelExtraction(null, NOW), { kind: 'not-a-label' });
  assert.deepEqual(reviewLabelExtraction('garbage', NOW), { kind: 'not-a-label' });
});

// ─── the lot: only the number beside «Lote» ──────────────────────────────────

test('the words that name a lot', () => {
  for (const w of ['N. Lote', 'N° Lote', 'Nº Lote:', 'Lote', 'LOTE', 'Lot', 'Lot No.', 'Batch', 'Partida']) {
    assert.equal(isLotWord(w), true, w);
  }
  for (const w of ['Diluyente', 'Contenido', 'Reg. SENASAG', 'Lotería', null]) {
    assert.equal(isLotWord(w), false, String(w));
  }
});

test('a number without «Lote» beside it is withheld — the diluent-tab case', () => {
  // Measured 2026-10-14: the card reader copied the coloured tab's number for
  // the lot on both Vanguard stickers, 6 of 6.
  for (const fieldWord of [null, 'Diluyente', 'Contenido']) {
    const r = reviewed(label({ lot: { fieldWord, snippet: '99887766', confidence: 0.99 } }));
    assert.equal(r.offer.batch, null, String(fieldWord));
    assert.equal(r.evidence.lot.withheld, 'unlabelled');
  }
});

test('a lot read with low confidence is withheld, with its snippet kept', () => {
  const r = reviewed(label({ lot: { fieldWord: 'Lote', snippet: 'AB1234', confidence: 0.59 } }));
  assert.equal(r.offer.batch, null);
  assert.equal(r.evidence.lot.withheld, 'low-confidence');
  assert.equal(r.evidence.lot.snippet, 'Lote AB1234');
});

test('a lot at 0.6 is offered; a product between 0.6 and 0.9 is prefilled highlighted', () => {
  const r = reviewed(label({ lot: { fieldWord: 'Lote', snippet: 'AB1234', confidence: 0.6 }, product: { snippet: 'Producto', confidence: 0.6 } }));
  assert.equal(r.offer.batch, 'AB1234');
  assert.equal(r.fill.product, 'Producto');
  assert.ok(r.highlighted.includes('product'));
  const sure = reviewed(label({ product: { snippet: 'Producto', confidence: 0.9 } }));
  assert.equal(sure.highlighted.includes('product'), false);
});

test('a "lot" longer than any real lot is withheld', () => {
  assert.equal(LABEL_LOT_MAX_CHARS, 24);
  const long = 'A'.repeat(25);
  const r = reviewed(label({ lot: { fieldWord: 'Lote', snippet: long, confidence: 0.95 } }));
  assert.equal(r.offer.batch, null);
  assert.equal(r.evidence.lot.withheld, 'too-long');
  assert.equal(reviewed(label({ lot: { fieldWord: 'Lote', snippet: 'A'.repeat(24), confidence: 0.95 } })).offer.batch, 'A'.repeat(24));
});

// ─── the dates: the printed word says which is which ─────────────────────────

test('the words that name an expiry, and those that name a manufacture', () => {
  for (const w of ['F. Venc', 'Venc.', 'Vence', 'Vto', 'Exp', 'Exp.', 'F. Cad', 'Cad', 'Caducidad', 'Válido hasta']) {
    assert.equal(isExpiryWord(w), true, w);
    assert.equal(isMadeWord(w), false, w);
  }
  for (const w of ['F. Elab', 'Elab.', 'Fab', 'Fab.', 'Fabricación', 'Mfg']) {
    assert.equal(isMadeWord(w), true, w);
    assert.equal(isExpiryWord(w), false, w);
  }
  assert.equal(isExpiryWord(null), false);
  assert.equal(isMadeWord(null), false);
});

test('an expiry fills only beside an expiry word — never beside «Elab»', () => {
  const r = reviewed(label({ expiresAt: { fieldWord: 'F. Elab', snippet: '03 ENE 26', confidence: 0.99 } }));
  assert.equal(r.fill.productExpiresAt, null);
  assert.equal(r.evidence.expiresAt.withheld, 'unlabelled');
});

test('an unlabelled date fills nothing — order and lateness decide nothing', () => {
  // The Recombitek sticker: two dates whose words are cut off.
  const r = reviewed(
    label({
      manufacturedAt: { fieldWord: null, snippet: '03/ENE/26', confidence: 0.9 },
      expiresAt: { fieldWord: null, snippet: '03/ENE/28', confidence: 0.9 },
    })
  );
  assert.equal(r.fill.productExpiresAt, null);
  assert.equal(r.evidence.expiresAt.withheld, 'unlabelled');
  assert.equal(r.evidence.manufacturedAt.withheld, 'unlabelled');
});

test('an expiry is prefilled only at confidence 0.8', () => {
  const below = reviewed(label({ expiresAt: { fieldWord: 'Exp', snippet: '03 ENE 28', confidence: 0.79 } }));
  assert.equal(below.fill.productExpiresAt, null);
  assert.equal(below.evidence.expiresAt.withheld, 'low-confidence');
  const at = reviewed(label({ expiresAt: { fieldWord: 'Exp', snippet: '03 ENE 28', confidence: 0.8 } }));
  assert.equal(at.fill.productExpiresAt, day(2028, 1, 3));
  assert.deepEqual(at.highlighted, ['productExpiresAt']);
});

test('the thresholds are the card reader’s', () => {
  assert.deepEqual(labelThresholdsFor('expiresAt'), { prefillMin: 0.8, highlightBelow: 0.9 });
  assert.deepEqual(labelThresholdsFor('lot'), { prefillMin: 0.6, highlightBelow: 0.9 });
  assert.deepEqual(labelThresholdsFor('product'), { prefillMin: 0.6, highlightBelow: 0.9 });
});

test('sticker date formats parse to the printed day', () => {
  for (const [snippet, expected] of [
    ['07 OCT 25', day(2025, 10, 7)],
    ['11 MAY 27', day(2027, 5, 11)],
    ['19/ABR/26', day(2026, 4, 19)],
    ['14/10/2025', day(2025, 10, 14)],
  ] as const) {
    const r = reviewed(label({ manufacturedAt: { fieldWord: 'Elab', snippet: '01 ENE 24', confidence: 0.95 }, expiresAt: { fieldWord: 'Venc', snippet, confidence: 0.95 } }));
    assert.equal(r.fill.productExpiresAt, expected, snippet);
  }
});

test('an unparseable expiry is withheld as unreadable', () => {
  const r = reviewed(label({ expiresAt: { fieldWord: 'Venc', snippet: '2028-01-03', confidence: 0.99 } }));
  assert.equal(r.fill.productExpiresAt, null);
  assert.equal(r.evidence.expiresAt.withheld, 'unreadable-date');
});

test('an EXPIRED vial still fills — that is what the form’s warning is for', () => {
  const r = reviewed(
    label({
      manufacturedAt: { fieldWord: 'Elab', snippet: '03 ENE 23', confidence: 0.95 },
      expiresAt: { fieldWord: 'Venc', snippet: '03 ENE 25', confidence: 0.95 },
    })
  );
  assert.equal(r.fill.productExpiresAt, day(2025, 1, 3));
});

test('an expiry beyond ten years, or before 2000, is implausible', () => {
  assert.equal(LABEL_FURTHEST_EXPIRY_YEARS, 10);
  assert.equal(LABEL_EARLIEST_YEAR, 2000);
  const far = reviewed(label({ expiresAt: { fieldWord: 'Venc', snippet: '03 ENE 2037', confidence: 0.95 } }));
  assert.equal(far.fill.productExpiresAt, null);
  assert.equal(far.evidence.expiresAt.withheld, 'implausible-date');
  const near = reviewed(label({ expiresAt: { fieldWord: 'Venc', snippet: '03 ENE 2036', confidence: 0.95 } }));
  assert.equal(near.fill.productExpiresAt, day(2036, 1, 3));
  const old = reviewed(
    label({
      manufacturedAt: { fieldWord: 'Elab', snippet: null, confidence: 0 },
      expiresAt: { fieldWord: 'Venc', snippet: '03/01/1999', confidence: 0.95 },
    })
  );
  assert.equal(old.fill.productExpiresAt, null);
});

test('an expiry on or before the manufacture date is withheld — one of the two was misread', () => {
  const same = reviewed(
    label({
      manufacturedAt: { fieldWord: 'Elab', snippet: '03 ENE 26', confidence: 0.95 },
      expiresAt: { fieldWord: 'Venc', snippet: '03 ENE 26', confidence: 0.95 },
    })
  );
  assert.equal(same.fill.productExpiresAt, null);
  assert.equal(same.evidence.expiresAt.withheld, 'implausible-date');
});

test('a manufacture date in the future is withheld, and then cannot veto the expiry', () => {
  const r = reviewed(
    label({
      manufacturedAt: { fieldWord: 'Elab', snippet: '03 ENE 29', confidence: 0.95 },
      expiresAt: { fieldWord: 'Venc', snippet: '03 ENE 28', confidence: 0.95 },
    })
  );
  assert.equal(r.evidence.manufacturedAt.withheld, 'implausible-date');
  assert.equal(r.fill.productExpiresAt, day(2028, 1, 3));
});

test('the evidence shows the printed word with the value, as on the label', () => {
  const r = reviewed(label());
  assert.equal(r.evidence.expiresAt.snippet, 'F. Venc 03 ENE 28');
  assert.equal(r.evidence.manufacturedAt.snippet, 'F. Elab 03 ENE 26');
  assert.equal(r.evidence.lot.snippet, 'N. Lote AB1234');
});

// ─── text fields ─────────────────────────────────────────────────────────────

test('a product read below 0.6 is withheld; a missing one is simply absent', () => {
  const low = reviewed(label({ product: { snippet: 'Producto', confidence: 0.59 } }));
  assert.equal(low.fill.product, null);
  assert.equal(low.evidence.product.withheld, 'low-confidence');
  const absent = reviewed(label({ product: { snippet: null, confidence: 0 } }));
  assert.equal(absent.fill.product, null);
  assert.equal(absent.evidence.product.withheld, null);
});

test('text is trimmed, and blank text is absent', () => {
  const r = reviewed(label({ manufacturer: { snippet: '   ', confidence: 0.9 }, product: { snippet: '  Producto 4 ', confidence: 0.95 } }));
  assert.equal(r.fill.manufacturer, null);
  assert.equal(r.fill.product, 'Producto 4');
});

test('an out-of-range or missing confidence counts as zero', () => {
  for (const confidence of [1.2, -0.1, Number.NaN, 'high' as unknown as number]) {
    const r = reviewed(label({ product: { snippet: 'Producto', confidence } }));
    assert.equal(r.fill.product, null, String(confidence));
  }
});

test('a sentence swept into one field is withheld and its stored evidence capped', () => {
  const long = 'x'.repeat(200);
  const r = reviewed(label({ product: { snippet: long, confidence: 0.95 } }));
  assert.equal(r.fill.product, null);
  assert.equal(r.evidence.product.withheld, 'too-long');
  assert.ok(r.evidence.product.snippet!.length <= 81);
});

test('what the label protects against is evidence for the person, never a field', () => {
  // With every other text field ABSENT, so nothing can mask a fallback onto it.
  const r = reviewed(
    label({
      product: { snippet: null, confidence: 0 },
      manufacturer: { snippet: null, confidence: 0 },
    })
  );
  assert.equal(r.evidence.protectsAgainst.snippet, 'contra el moquillo');
  assert.deepEqual([r.fill.product, r.fill.manufacturer], [null, null]);
  assert.equal(Object.values(r.fill).includes('contra el moquillo'), false);
});

test('a malformed reading fills nothing and throws nothing', () => {
  const r = reviewed({ isVeterinaryLabel: true, lot: 'oops', expiresAt: { snippet: 7 } });
  assert.deepEqual(r.fill, { product: null, manufacturer: null, productExpiresAt: null });
  assert.deepEqual(r.offer, { batch: null });
  assert.deepEqual(r.highlighted, []);
});
