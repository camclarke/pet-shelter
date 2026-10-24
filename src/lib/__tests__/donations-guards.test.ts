/**
 * The donation handlers, read as source: who is checked first, in what order
 * the QR upload does its work, and that the public QR route cannot be steered.
 * Behaviour is tested in donations-handler.test.ts; these pin the ORDER, which
 * a behaviour test passes even after a refactor quietly moves a check.
 *
 * Also runs the real PNG re-encoder (sharp) on real bytes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

import { QR_INPUT_MAX_PIXELS, reencodeQrPng } from '../qr-reencode';

const ROOT = process.cwd();
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
/** Source without comments. */
const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const HANDLER = code('src/lib/donations-handler.ts');

/** The body of `export async function name(`, up to the next top-level `export`. */
function fn(name: string): string {
  const at = HANDLER.indexOf(`export async function ${name}(`);
  assert.ok(at >= 0, `${name} not found`);
  const next = HANDLER.indexOf('\nexport ', at + 10);
  return HANDLER.slice(at, next < 0 ? undefined : next);
}

const WRITE_HANDLERS = ['handleDonationPropose', 'handleDonationQrUpload', 'handleDonationConfirm', 'handleDonationReject'];
const READ_HANDLERS = ['handleDonationPendingQr'];

test('requireRole( appears once, inside guard(), with DONATION_ROLES', () => {
  assert.equal((HANDLER.match(/requireRole\(/g) ?? []).length, 1);
  const guard = HANDLER.slice(HANDLER.indexOf('async function guard('), HANDLER.indexOf('async function readJson('));
  assert.match(guard, /requireRole\(request, deps\.verifyIdToken, DONATION_ROLES\)/);
  assert.match(guard, /if \(write && !signedInRecently\(check\.authTimeS, deps\.nowMs\(\)\)\)/);
  assert.match(code('src/config/roles.ts'), /export const DONATION_ROLES: readonly RoleKey\[\] = \['finance', 'su'\];/);
});

test('every authenticated handler calls guard() FIRST, before touching the request; writes demand a recent sign-in', () => {
  for (const name of [...WRITE_HANDLERS, ...READ_HANDLERS]) {
    const body = fn(name);
    const first = body.indexOf('await ');
    assert.ok(first >= 0, name);
    const write = WRITE_HANDLERS.includes(name);
    assert.ok(
      body.slice(first).startsWith(`await guard(request, deps, { write: ${write} })`),
      `${name} must start with guard(…, { write: ${write} }), found: ${body.slice(first, first + 60)}`,
    );
    const touched = body.search(/\brequest\.[A-Za-z]/);
    assert.ok(touched < 0 || touched > first, `${name} touches the request before guard()`);
  }
});

test('confirm and reject decide the two-person rule INSIDE the transaction, on the proposal as stored', () => {
  for (const name of ['handleDonationConfirm', 'handleDonationReject']) {
    const body = fn(name);
    const tx = body.indexOf('deps.runTransaction(');
    const rule = body.indexOf('canConfirm(');
    assert.ok(tx >= 0 && rule > tx, `${name}: canConfirm must run inside runTransaction`);
    assert.match(body, /proposerUid: pending\.proposedBy/);
    assert.match(body, /callerUid: caller\.uid/);
    // Every write after the rule.
    for (const write of ['tx.setCurrent(', 'tx.createHistory(', 'tx.updatePending(']) {
      const w = body.indexOf(write);
      assert.ok(w < 0 || w > rule, `${name}: ${write} before canConfirm`);
    }
  }
});

test('the QR upload: owner checks, then ONE capped body read, then magic bytes, then re-encode, then a create-only save', () => {
  const body = fn('handleDonationQrUpload');
  for (const reader of ['.json(', '.formData(', '.text(', '.arrayBuffer(', '.blob(', '.clone(']) {
    assert.ok(!body.includes(reader), `buffers the whole body: ${reader}`);
  }
  assert.equal((body.match(/\brequest\.body\b/g) ?? []).length, 1);
  const at = (needle: string) => {
    const i = body.indexOf(needle);
    assert.ok(i >= 0, `missing ${needle}`);
    return i;
  };
  assert.ok(at("headers.get('content-length')") < at('request.body'));
  assert.ok(at('qrUploadRefusal(pending, caller.uid)') < at('request.body'));
  assert.ok(at('readCapped(request.body, DONATION_QR_MAX_BYTES') < at('magicMatches('));
  assert.ok(at('magicMatches(') < at('deps.reencodePng('));
  assert.ok(at('deps.reencodePng(') < at('deps.saveQr('));
  assert.ok(at('deps.saveQr(') < at('deps.runTransaction('));
  const refusal = HANDLER.slice(HANDLER.indexOf('function qrUploadRefusal('), HANDLER.indexOf('export async function handleDonationQrUpload('));
  assert.match(refusal, /pending\.proposedBy !== callerUid/);
});

test('the public QR handler takes no request, and serves only current.qrPath after isQrVisible', () => {
  const body = fn('handlePublicDonationQr');
  assert.match(body, /^export async function handlePublicDonationQr\(deps: PublicQrDeps\)/);
  assert.ok(!/\brequest\b/.test(body));
  assert.ok(body.indexOf('isQrVisible(') < body.indexOf('deps.readQr('));
  assert.match(body, /deps\.readQr\(settings\.qrPath!\)/);
  assert.ok(!body.includes('readPending'), 'never reads a proposal');
  const route = code('src/app/api/donations/qr/route.ts');
  assert.match(route, /export async function GET\(\): Promise<Response>/);
  assert.ok(!/\bPOST\b/.test(route));
});

test('every donation route is the Node runtime, never cached by Next, and only supplies the Admin SDK', () => {
  for (const route of [
    'src/app/api/donations/propose/route.ts',
    'src/app/api/donations/confirm/route.ts',
    'src/app/api/donations/reject/route.ts',
    'src/app/api/donations/qr/route.ts',
    'src/app/api/donations/pending/[pendingId]/qr/route.ts',
  ]) {
    const src = code(route);
    assert.match(src, /export const runtime = 'nodejs';/, route);
    assert.match(src, /export const dynamic = 'force-dynamic';/, route);
    assert.match(src, /from '@\/lib\/donations-server'/, route);
  }
  assert.match(read('src/lib/donations-server.ts'), /^import 'server-only';/);
});

// ─── the real re-encoder ─────────────────────────────────────────────────────

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (b: Uint8Array) => PNG_MAGIC.every((v, i) => b[i] === v);
const contains = (b: Uint8Array, text: string) => Buffer.from(b).includes(Buffer.from(text));

test('reencodeQrPng: a JPEG carrying EXIF comes out a PNG with none of it', async () => {
  const jpeg = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#ffffff' } })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'NIGHTPROBE-SECRET', Artist: 'NIGHTPROBE-ARTIST' } })
    .toBuffer();
  assert.ok(contains(jpeg, 'NIGHTPROBE-SECRET'), 'control: the input does carry the EXIF');
  const out = await reencodeQrPng(new Uint8Array(jpeg));
  assert.ok(isPng(out));
  assert.equal(contains(out, 'NIGHTPROBE-SECRET'), false);
  assert.equal(contains(out, 'NIGHTPROBE-ARTIST'), false);
  const meta = await sharp(Buffer.from(out)).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['png', 64, 32]);
});

test('reencodeQrPng: refuses bytes that are not an image, and an image over the pixel cap', async () => {
  await assert.rejects(reencodeQrPng(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0])));
  const side = Math.ceil(Math.sqrt(QR_INPUT_MAX_PIXELS)) + 1;
  const huge = await sharp({ create: { width: side, height: side, channels: 3, background: '#000000' } }).png().toBuffer();
  await assert.rejects(reencodeQrPng(new Uint8Array(huge)), /pixel/i);
});

test('reencodeQrPng: a big image is scaled down to a 1600 px long edge, never up', async () => {
  const big = await sharp({ create: { width: 3200, height: 1000, channels: 3, background: '#000000' } }).png().toBuffer();
  const meta = await sharp(Buffer.from(await reencodeQrPng(new Uint8Array(big)))).metadata();
  assert.deepEqual([meta.width, meta.height], [1600, 500]);
  const small = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#000000' } }).png().toBuffer();
  assert.equal((await sharp(Buffer.from(await reencodeQrPng(new Uint8Array(small)))).metadata()).width, 300);
});
