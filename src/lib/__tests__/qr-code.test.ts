import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeQR } from 'qr/decode.js';

import { QR_ERROR_CORRECTION, QR_QUIET_ZONE_MODULES, qrTagSymbol } from '../qr-code';
import { generateQrToken } from '../qr-tokens';
import { SHELTER } from '@/config/shelter';

/**
 * The symbol is checked from the SVG STRING the route serves — its viewBox,
 * its path, and a decode of that path by an independent implementation — never
 * from the encoder's own view of what it drew. A test that asks lean-qr what
 * lean-qr did would agree with any bug in lean-qr.
 */

const REFERENCE_HOST = 'https://wawitas.org';

interface Grid {
  size: number;
  quiet: number;
  dark(x: number, y: number): boolean;
}

/** Parse the served SVG into a module grid, by nonzero winding over its path. */
function gridFromSvg(svg: string): Grid {
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1];
  const d = /<path d="([^"]+)"/.exec(svg)?.[1];
  assert.ok(viewBox && d, 'svg has no viewBox or no path');
  const [vx = NaN, vy, vw = NaN, vh] = viewBox.split(/\s+/).map(Number);
  assert.equal(vx, vy, 'quiet zone is not square');
  assert.equal(vw, vh, 'symbol is not square');

  const polygons = d
    .split('M')
    .filter(Boolean)
    .map((part) =>
      part
        .replace('Z', '')
        .split('L')
        .map((pair) => pair.trim().split(/\s+/).map(Number) as [number, number]),
    );

  const quiet = -vx;
  const size = vw - 2 * quiet;

  function dark(x: number, y: number): boolean {
    const px = x + 0.5;
    const py = y + 0.5;
    let winding = 0;
    for (const points of polygons) {
      for (let i = 0; i < points.length; i++) {
        const [x1, y1] = points[i]!;
        const [x2, y2] = points[(i + 1) % points.length]!;
        if (x1 !== x2 || x1 <= px) continue;
        if (py > Math.min(y1, y2) && py < Math.max(y1, y2)) winding += y2 > y1 ? 1 : -1;
      }
    }
    return winding !== 0;
  }

  return { size, quiet, dark };
}

/** Rasterise a grid, quiet zone included, into RGBA for the decoder. */
function rasterise(grid: Grid, pixelsPerModule: number) {
  const modules = grid.size + 2 * grid.quiet;
  const n = modules * pixelsPerModule;
  const data = new Uint8Array(n * n * 4);
  for (let my = 0; my < modules; my++) {
    for (let mx = 0; mx < modules; mx++) {
      const value = grid.dark(mx - grid.quiet, my - grid.quiet) ? 0 : 255;
      for (let sy = 0; sy < pixelsPerModule; sy++) {
        for (let sx = 0; sx < pixelsPerModule; sx++) {
          const i = ((my * pixelsPerModule + sy) * n + mx * pixelsPerModule + sx) * 4;
          data[i] = data[i + 1] = data[i + 2] = value;
          data[i + 3] = 255;
        }
      }
    }
  }
  return { width: n, height: n, data };
}

/**
 * ISO/IEC 18004 §7.9: the 15-bit format word, read from BOTH copies. The top
 * two data bits are the error-correction level: L=01, M=00, Q=11, H=10.
 */
function formatWord(grid: Grid): { copy1: number; copy2: number; ecc: string; bchValid: boolean } {
  const bit = (x: number, y: number) => (grid.dark(x, y) ? 1 : 0);
  const copy1Positions: Array<[number, number]> = [];
  for (let i = 0; i <= 5; i++) copy1Positions.push([8, i]);
  copy1Positions.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) copy1Positions.push([14 - i, 8]);
  let copy1 = 0;
  copy1Positions.forEach(([x, y], i) => (copy1 |= bit(x, y) << i));

  let copy2 = 0;
  for (let i = 0; i < 8; i++) copy2 |= bit(grid.size - 1 - i, 8) << i;
  for (let i = 8; i < 15; i++) copy2 |= bit(8, grid.size - 15 + i) << i;

  const unmasked = copy1 ^ 0x5412;
  const ecc = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' }[(unmasked >> 13) & 0b11]!;

  // BCH(15,5): the whole word must be a multiple of the generator 0x537.
  let remainder = unmasked;
  for (let i = 14; i >= 10; i--) if ((remainder >> i) & 1) remainder ^= 0x537 << (i - 10);
  return { copy1, copy2, ecc, bchValid: remainder === 0 };
}

test('a realistic tag on the reference host is QR version 3 at level Q', () => {
  const symbol = qrTagSymbol('XXXXXXXXXX', REFERENCE_HOST);
  assert.equal(symbol.payload, 'https://wawitas.org/id/XXXXXXXXXX');
  assert.equal(symbol.version, 3);
  assert.equal(symbol.size, 29);
  assert.equal(QR_ERROR_CORRECTION, 'Q');
});

test('NO token shape pushes the reference tag past version 3', () => {
  // Digits, letters, and mixes change how an encoder may segment the payload.
  const tokens = ['0000000000', 'ZZZZZZZZZZ', '9Z9Z9Z9Z9Z', 'ABCDEFGHJK', '0123456789'];
  for (let i = 0; i < 200; i++) tokens.push(generateQrToken());
  for (const token of tokens) {
    assert.equal(qrTagSymbol(token, REFERENCE_HOST).version, 3, token);
  }
});

test('the symbol encodes THIS shelter’s host, from config, within a printable version', () => {
  const symbol = qrTagSymbol('ABCDEFGHJK', SHELTER.siteUrl);
  assert.equal(new URL(symbol.payload).host, new URL(SHELTER.siteUrl).host);
  // A forking shelter's longer host may cost a version. Past 4 a 20 mm tag
  // drops under half a millimetre per module — re-measure before printing.
  assert.ok(symbol.version <= 4, `version ${symbol.version} for ${SHELTER.siteUrl}`);
});

test('the served SVG decodes, by an independent decoder, to exactly the tag URL', () => {
  for (const token of ['ABCDEFGHJK', generateQrToken(), generateQrToken()]) {
    const symbol = qrTagSymbol(token, REFERENCE_HOST);
    const grid = gridFromSvg(symbol.svg);
    assert.equal(grid.size, symbol.size);
    assert.equal(decodeQR(rasterise(grid, 6)), symbol.payload);
  }
});

test('the error-correction level READ FROM THE SVG is Q, in both format copies', () => {
  const grid = gridFromSvg(qrTagSymbol('ABCDEFGHJK', REFERENCE_HOST).svg);
  const format = formatWord(grid);
  assert.equal(format.copy1, format.copy2, 'the two format copies disagree');
  assert.equal(format.bchValid, true, 'format word fails its BCH check — the reader is wrong');
  assert.equal(format.ecc, 'Q');
});

test('the quiet zone is four empty modules on every side, inside the SVG', () => {
  const { svg, size } = qrTagSymbol('ABCDEFGHJK', REFERENCE_HOST);
  assert.equal(QR_QUIET_ZONE_MODULES, 4);
  assert.match(svg, new RegExp(`viewBox="-4 -4 ${size + 8} ${size + 8}"`));
  // A white background covering the whole viewBox, quiet zone included.
  assert.match(svg, new RegExp(`<rect x="-4" y="-4" width="${size + 8}" height="${size + 8}" fill="#fff">`));

  const coordinates = /<path d="([^"]+)"/.exec(svg)![1]!.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  assert.ok(Math.min(...coordinates) >= 0, 'a dark module reaches into the quiet zone');
  assert.ok(Math.max(...coordinates) <= size, 'a dark module reaches into the quiet zone');
});

test('the SVG is inert: no script, no event handler, no external reference', () => {
  const { svg } = qrTagSymbol('ABCDEFGHJK', REFERENCE_HOST);
  assert.doesNotMatch(svg, /<script/i);
  assert.doesNotMatch(svg, /\son\w+=/i);
  assert.doesNotMatch(svg, /href=/i);
  assert.match(svg, /shape-rendering="crispedges"/);
});

test('a malformed token never becomes a symbol', () => {
  assert.throws(() => qrTagSymbol('not-a-token', REFERENCE_HOST));
  assert.throws(() => qrTagSymbol('ABCDEFGHJU', REFERENCE_HOST));
});
