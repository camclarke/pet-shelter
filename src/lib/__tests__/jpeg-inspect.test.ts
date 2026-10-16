import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ICC_PROFILE_MAX_BYTES,
  ID_PHOTO_MAX_EDGE,
  ID_PHOTO_MIN_LONG_EDGE,
  ID_PHOTO_MIN_SHORT_EDGE,
  inspectJpeg,
  type JpegRefusal,
} from '../jpeg-inspect';
import { CARD_PHOTO_MAX_EDGE } from '../card-extraction';
import {
  EOI,
  SOI,
  adobe,
  ascii,
  bytesInclude,
  chromeLikeJpeg,
  comment,
  dht,
  dqt,
  dri,
  exif,
  icc,
  iptc,
  jfif,
  jpeg,
  scan,
  seg,
  sof,
  sosHeader,
  xmp,
} from './jpeg-fixtures';

function refusal(bytes: Uint8Array): { refusal: JpegRefusal; marker: string | null } {
  const result = inspectJpeg(bytes);
  assert.equal(result.ok, false, 'expected a refusal');
  if (result.ok) throw new Error('unreachable');
  return { refusal: result.refusal, marker: result.marker };
}

// ─── what is accepted, unchanged ─────────────────────────────────────────────

test("desktop Chrome's canvas shape (FFE0 FFE2 FFDB FFDB FFC0 FFC4×4 FFDA) is accepted byte for byte", () => {
  const input = chromeLikeJpeg();
  const result = inspectJpeg(input);
  assert.ok(result.ok);
  assert.deepEqual(result.removed, []);
  assert.deepEqual([...result.bytes], [...input], 'nothing removed means nothing changed');
  assert.equal(result.width, 2048);
  assert.equal(result.height, 1536);
});

test('SOF1 with its one scan is accepted, byte for byte', () => {
  const input = jpeg(jfif(), dqt(), sof({ code: 0xc1 }), dht(), scan());
  const result = inspectJpeg(input);
  assert.ok(result.ok);
  assert.deepEqual([...result.bytes], [...input]);
});

// ─── exactly one scan, never progressive (review 4b #3) ─────────────────────

test('progressive SOF2 is refused outright — even with a single scan — and names FFC2', () => {
  assert.deepEqual(refusal(jpeg(jfif(), dqt(), sof({ code: 0xc2 }), dht(), scan())), {
    refusal: 'progressive',
    marker: 'FFC2',
  });
  // The shape a progressive encoder really emits: several scans, tables between.
  const progressive = jpeg(jfif(), dqt(), sof({ code: 0xc2 }), dht(), scan(), dht(), scan(1), dri(), scan(1));
  assert.equal(refusal(progressive).refusal, 'progressive');
});

test('a baseline frame has EXACTLY one scan: a second SOS is refused at the second FFDA', () => {
  for (const code of [0xc0, 0xc1]) {
    assert.deepEqual(refusal(jpeg(jfif(), dqt(), sof({ code }), dht(), scan(), scan())), {
      refusal: 'multiple-scans',
      marker: 'FFDA',
    });
    // Tables between the scans change nothing.
    assert.equal(refusal(jpeg(jfif(), dqt(), sof({ code }), dht(), scan(), dht(), scan())).refusal, 'multiple-scans');
  }
});

test('many scans are refused at the second one, however many follow (the 127 254-scan file, in small)', () => {
  const scans = Array.from({ length: 2000 }, () => scan());
  assert.deepEqual(refusal(jpeg(jfif(), dqt(), sof(), dht(), ...scans)), { refusal: 'multiple-scans', marker: 'FFDA' });
});

test("the one scan must carry every component of the frame — a non-interleaved scan is only part of an image", () => {
  assert.equal(refusal(jpeg(jfif(), dqt(), sof({ components: 3 }), dht(), scan(1))).refusal, 'bad-segment');
  assert.equal(refusal(jpeg(jfif(), dqt(), sof({ components: 1 }), dht(), scan(3))).refusal, 'bad-segment');
  assert.ok(inspectJpeg(jpeg(jfif(), dqt(), sof({ components: 1 }), dht(), scan(1))).ok, 'greyscale, one component, one scan');
});

test('APP14 Adobe, DRI, a greyscale frame, and no APP0 at all are accepted', () => {
  assert.ok(inspectJpeg(jpeg(adobe(), dqt(), dri(), sof({ components: 1 }), dht(), scan(1))).ok);
});

test('the frame edges: exactly the max and exactly the minimums pass', () => {
  assert.ok(inspectJpeg(chromeLikeJpeg({ width: ID_PHOTO_MAX_EDGE, height: ID_PHOTO_MAX_EDGE })).ok);
  assert.ok(inspectJpeg(chromeLikeJpeg({ width: ID_PHOTO_MIN_LONG_EDGE, height: ID_PHOTO_MIN_SHORT_EDGE })).ok);
  assert.ok(inspectJpeg(chromeLikeJpeg({ width: ID_PHOTO_MIN_SHORT_EDGE, height: ID_PHOTO_MIN_LONG_EDGE })).ok, 'portrait');
});

test('the max edge is the one the browser resizes an ID photo to', () => {
  assert.equal(ID_PHOTO_MAX_EDGE, CARD_PHOTO_MAX_EDGE);
  assert.equal(ID_PHOTO_MAX_EDGE, 2048);
});

// ─── what is REMOVED ─────────────────────────────────────────────────────────

test('APP1 Exif is spliced out: the GPS bytes are not in what would be stored', () => {
  const input = jpeg(jfif(), exif(), icc(), dqt(), sof(), dht(), scan());
  assert.ok(bytesInclude(input, 'GPS'), 'control: the fixture really carries GPS');
  const result = inspectJpeg(input);
  assert.ok(result.ok);
  assert.deepEqual(result.removed, ['FFE1']);
  assert.equal(bytesInclude(result.bytes, 'GPS'), false);
  assert.equal(bytesInclude(result.bytes, 'Exif'), false);
  assert.equal(result.bytes.length, input.length - exif().length);
  // The rest is untouched, in order.
  assert.deepEqual([...result.bytes], [...jpeg(jfif(), icc(), dqt(), sof(), dht(), scan())]);
});

test('XMP (APP1), IPTC (APP13) and comments (COM) are spliced out too, wherever they sit', () => {
  const input = jpeg(xmp(), jfif(), iptc(), dqt(), comment(), sof(), dht(), scan(), comment('after scan'));
  const result = inspectJpeg(input);
  assert.ok(result.ok);
  assert.deepEqual(result.removed, ['FFE1', 'FFED', 'FFFE', 'FFFE']);
  assert.equal(bytesInclude(result.bytes, 'GPS'), false);
  assert.equal(bytesInclude(result.bytes, 'xmpmeta'), false);
  assert.equal(bytesInclude(result.bytes, 'after scan'), false);
  assert.deepEqual([...result.bytes], [...jpeg(jfif(), dqt(), sof(), dht(), scan())]);
});

test('fill bytes before a marker are legal, carry nothing, and are dropped', () => {
  const clean = [...jfif(), ...dqt(), ...sof(), ...dht(), ...scan()];
  const padded = Uint8Array.from([...SOI, 0xff, 0xff, ...clean, 0xff, ...EOI]);
  const result = inspectJpeg(padded);
  assert.ok(result.ok);
  assert.deepEqual([...result.bytes], [...jpeg(jfif(), dqt(), sof(), dht(), scan())]);
});

test('the result never aliases the input: changing the input afterwards changes nothing stored', () => {
  const input = chromeLikeJpeg();
  const result = inspectJpeg(input);
  assert.ok(result.ok);
  const before = [...result.bytes];
  input.fill(0);
  assert.deepEqual([...result.bytes], before);
});

// ─── what is REFUSED ─────────────────────────────────────────────────────────

test('not a JPEG at all: PNG, empty, a lone SOI', () => {
  assert.equal(refusal(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).refusal, 'not-jpeg');
  assert.equal(refusal(new Uint8Array(0)).refusal, 'not-jpeg');
  assert.equal(refusal(Uint8Array.from(SOI)).refusal, 'not-jpeg');
});

test('ANY byte after EOI is refused — that is where a second file hides', () => {
  const input = chromeLikeJpeg();
  for (const tail of [[0x00], [0xff, 0xd8, 0xff], ascii('PK\u0003\u0004')]) {
    assert.equal(refusal(Uint8Array.from([...input, ...tail])).refusal, 'trailing-bytes', JSON.stringify(tail));
  }
});

test('JFXX and a JFIF thumbnail are refused: both are an embedded image', () => {
  const jfxx = seg(0xe0, [...ascii('JFXX\0'), 0x10, 0xff, 0xd8, 0xff, 0xd9]);
  assert.deepEqual(refusal(jpeg(jfxx, dqt(), sof(), dht(), scan())), { refusal: 'jfxx', marker: 'FFE0' });
  // A JFIF APP0 followed by a SECOND APP0 carrying JFXX.
  assert.equal(refusal(jpeg(jfif(), jfxx, dqt(), sof(), dht(), scan())).refusal, 'duplicate-app0');
  assert.equal(refusal(jpeg(jfif(1, 1, [1, 2, 3]), dqt(), sof(), dht(), scan())).refusal, 'jfif-thumbnail');
  // 0 × 0 announced, but bytes after the header anyway.
  assert.equal(refusal(jpeg(jfif(0, 0, [1, 2, 3]), dqt(), sof(), dht(), scan())).refusal, 'jfif-thumbnail');
  assert.equal(refusal(jpeg(seg(0xe0, ascii('AVI1\0\0\0')), dqt(), sof(), dht(), scan())).refusal, 'app0-not-jfif');
});

test('APP2 must be an ICC profile, and not an oversized one — MPF attaches a second image', () => {
  const mpf = seg(0xe2, [...ascii('MPF\0'), ...ascii('MM'), 0, 42]);
  assert.deepEqual(refusal(jpeg(jfif(), mpf, dqt(), sof(), dht(), scan())), { refusal: 'app2-not-icc', marker: 'FFE2' });

  const half = ICC_PROFILE_MAX_BYTES / 2;
  assert.ok(inspectJpeg(jpeg(jfif(), icc(half, 1, 2), icc(half, 2, 2), dqt(), sof(), dht(), scan())).ok, 'exactly the cap');
  assert.equal(
    refusal(jpeg(jfif(), icc(half, 1, 2), icc(half + 1, 2, 2), dqt(), sof(), dht(), scan())).refusal,
    'icc-too-large',
    'one byte over, across two chunks',
  );
});

test('every other APPn, and APP14 that is not Adobe, is refused', () => {
  for (let code = 0xe3; code <= 0xef; code++) {
    if (code === 0xed || code === 0xee) continue; // APP13 removed, APP14 below
    assert.deepEqual(
      refusal(jpeg(jfif(), seg(code, ascii('anything')), dqt(), sof(), dht(), scan())),
      { refusal: 'unknown-marker', marker: `FF${code.toString(16).toUpperCase()}` },
    );
  }
  assert.equal(refusal(jpeg(seg(0xee, ascii('Ducky\0\0\0\0\0\0\0')), dqt(), sof(), dht(), scan())).refusal, 'app14-not-adobe');
});

test('APP14 Adobe of any length but its fixed 12 bytes is refused — the extra room would carry a payload', () => {
  const body = [...ascii('Adobe'), 0, 100, 0, 0, 0, 0, 1];
  assert.equal(body.length, 12, 'the fixture is the fixed size (control)');
  assert.ok(inspectJpeg(jpeg(seg(0xee, body), dqt(), sof(), dht(), scan())).ok, 'exactly 12 bytes is accepted');
  for (const wrong of [body.slice(0, 11), [...body, 0], [...body, ...ascii('GPS-17.39,-66.15')]]) {
    assert.deepEqual(refusal(jpeg(seg(0xee, wrong), dqt(), sof(), dht(), scan())), {
      refusal: 'bad-segment',
      marker: 'FFEE',
    }, `${wrong.length} bytes`);
  }
});

test('DNL is refused: a frame whose height is defined after the fact', () => {
  assert.deepEqual(refusal(jpeg(jfif(), dqt(), sof(), dht(), scan(), seg(0xdc, [0x06, 0x00]))), {
    refusal: 'dnl',
    marker: 'FFDC',
  });
});

test('SOF3 and SOF5–SOF15 are refused, and so are JPG (C8) and DAC (CC)', () => {
  for (const code of [0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]) {
    assert.equal(refusal(jpeg(jfif(), dqt(), sof({ code }), dht(), scan())).refusal, 'unsupported-frame', code.toString(16));
  }
  for (const code of [0xc8, 0xcc]) {
    assert.equal(refusal(jpeg(jfif(), seg(code, [0]), dqt(), sof(), dht(), scan())).refusal, 'unknown-marker');
  }
});

test('exactly one frame: zero frames and a second frame are refused', () => {
  assert.equal(refusal(jpeg(jfif(), dqt(), sof(), dht(), scan(), sof(), scan())).refusal, 'second-frame');
  assert.equal(refusal(jpeg(jfif(), dqt(), sof(), sof({ code: 0xc1 }), dht(), scan())).refusal, 'second-frame');
  assert.equal(refusal(jpeg(jfif(), dqt(), dht())).refusal, 'no-frame');
  assert.equal(refusal(jpeg(jfif(), dqt(), sof(), dht())).refusal, 'no-scan');
  assert.equal(refusal(jpeg(jfif(), dqt(), dht(), scan())).refusal, 'scan-before-frame');
});

test('the frame must be 8-bit with 1 or 3 components and a header of the right size', () => {
  assert.equal(refusal(jpeg(jfif(), dqt(), sof({ precision: 12 }), dht(), scan())).refusal, 'bad-frame');
  for (const components of [0, 2, 4]) {
    assert.equal(refusal(jpeg(jfif(), dqt(), sof({ components }), dht(), scan())).refusal, 'bad-frame', `${components}`);
  }
  const short = seg(0xc0, [8, 0x06, 0x00, 0x08, 0x00, 3, 1, 0x11, 0]);
  assert.equal(refusal(jpeg(jfif(), dqt(), short, dht(), scan())).refusal, 'bad-frame');
});

test('a zero, oversized or too-small dimension is refused — a 1 × 1 photo must not satisfy approval', () => {
  assert.equal(refusal(chromeLikeJpeg({ width: 0, height: 1536 })).refusal, 'zero-dimension');
  assert.equal(refusal(chromeLikeJpeg({ width: 2048, height: 0 })).refusal, 'zero-dimension');
  assert.equal(refusal(chromeLikeJpeg({ width: ID_PHOTO_MAX_EDGE + 1, height: 1536 })).refusal, 'dimensions-too-large');
  assert.equal(refusal(chromeLikeJpeg({ width: 1536, height: ID_PHOTO_MAX_EDGE + 1 })).refusal, 'dimensions-too-large');
  assert.equal(refusal(chromeLikeJpeg({ width: 1, height: 1 })).refusal, 'dimensions-too-small');
  assert.equal(
    refusal(chromeLikeJpeg({ width: ID_PHOTO_MIN_LONG_EDGE - 1, height: ID_PHOTO_MIN_SHORT_EDGE })).refusal,
    'dimensions-too-small',
  );
  assert.equal(
    refusal(chromeLikeJpeg({ width: 2048, height: ID_PHOTO_MIN_SHORT_EDGE - 1 })).refusal,
    'dimensions-too-small',
    'a long thin strip',
  );
  assert.equal(ID_PHOTO_MAX_EDGE * ID_PHOTO_MAX_EDGE <= 4_200_000, true, 'the bound the admin browser decodes');
});

test('broken structure is refused, never thrown: truncation, bad lengths, stray bytes and markers', () => {
  const valid = chromeLikeJpeg();
  assert.equal(refusal(valid.subarray(0, valid.length - 2)).refusal, 'truncated', 'no EOI');
  assert.equal(refusal(Uint8Array.from([...SOI, 0xff, 0xdb, 0x00])).refusal, 'truncated', 'half a length');
  assert.equal(refusal(Uint8Array.from([...SOI, 0xff, 0xdb, 0x00, 0x40, 1, 2])).refusal, 'truncated', 'past the end');
  assert.equal(refusal(Uint8Array.from([...SOI, 0xff, 0xdb, 0x00, 0x01, ...EOI])).refusal, 'bad-segment', 'length 1');
  assert.equal(refusal(Uint8Array.from([...SOI, 0x00, ...EOI])).refusal, 'bad-segment', 'a byte where a marker must be');
  assert.equal(refusal(jpeg(jfif(), seg(0xdd, [0, 4, 0]), dqt(), sof(), dht(), scan())).refusal, 'bad-segment', 'DRI of 3 bytes');
  assert.equal(refusal(jpeg(jfif(), dqt(), sof(), dht(), seg(0xda, [5, 1, 0, 0, 0x3f, 0]))).refusal, 'bad-segment', 'SOS for 5 components');
  assert.equal(refusal(Uint8Array.from([...SOI, ...jfif(), 0xff, 0xd0, ...EOI])).refusal, 'unexpected-restart');
  assert.equal(refusal(Uint8Array.from([...SOI, ...jfif(), 0xff, 0x00, ...EOI])).refusal, 'bad-segment');
  assert.equal(refusal(Uint8Array.from([...SOI, ...SOI, ...EOI])).refusal, 'unknown-marker', 'a second SOI');
  for (const code of [0x01, 0x02, 0x4f, 0xbf, 0xde, 0xdf, 0xf0, 0xfd]) {
    assert.equal(refusal(jpeg(jfif(), seg(code, [0]), dqt(), sof(), dht(), scan())).refusal, 'unknown-marker', code.toString(16));
  }
  // A scan that never ends.
  assert.equal(refusal(Uint8Array.from([...SOI, ...jfif(), ...sof(), ...sosHeader(), 0x12, 0x34])).refusal, 'truncated');
});

test('it never throws: every truncation of a valid file, and pseudo-random bytes, give a result', () => {
  const valid = jpeg(jfif(), exif(), icc(), dqt(), sof(), dht(), scan(), comment());
  for (let n = 0; n <= valid.length; n++) {
    const result = inspectJpeg(valid.subarray(0, n));
    assert.equal(typeof result.ok, 'boolean');
    if (n < valid.length) assert.equal(result.ok, false, `a ${n}-byte prefix was accepted`);
  }
  let seed = 20261016;
  const next = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >>> 16) & 0xff;
  for (let i = 0; i < 400; i++) {
    const noise = Uint8Array.from({ length: 4 + (i % 97) }, next);
    noise[0] = 0xff;
    noise[1] = 0xd8;
    assert.equal(typeof inspectJpeg(noise).ok, 'boolean');
  }
});
