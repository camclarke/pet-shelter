import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CROCKFORD_ALPHABET,
  PUBLIC_TAG_PET_FIELDS,
  QR_TOKEN_LENGTH,
  QR_TOKEN_PATTERN,
  activeTokenOf,
  formatQrToken,
  generateQrToken,
  mintUniqueToken,
  normalizeQrToken,
  qrTagDisplayUrl,
  qrTagUrl,
  resolveTag,
  tagTone,
  toPublicTagPet,
  tokenRecordFrom,
  type QrTokenRecord,
  type TagLookups,
} from '../qr-tokens';
import type { Pet, PetStatus } from '../types';

/**
 * Build-order step 12: QR identity tags. The values below are LITERALS on
 * purpose — a test that reads a threshold back from the module it tests cannot
 * fail when the module's constant is wrong.
 */

// ─── the alphabet ────────────────────────────────────────────────────────────

test('the alphabet is Crockford base32: 32 symbols, no I, L, O or U', () => {
  assert.equal(CROCKFORD_ALPHABET, '0123456789ABCDEFGHJKMNPQRSTVWXYZ');
  assert.equal(new Set(CROCKFORD_ALPHABET).size, 32);
  for (const excluded of ['I', 'L', 'O', 'U']) {
    assert.equal(CROCKFORD_ALPHABET.includes(excluded), false, excluded);
  }
});

test('the token is 10 characters and the pattern agrees with the alphabet', () => {
  assert.equal(QR_TOKEN_LENGTH, 10);
  assert.ok(QR_TOKEN_PATTERN.test('0123456789'));
  assert.ok(QR_TOKEN_PATTERN.test('ABCDEFGHJK'));
  assert.ok(QR_TOKEN_PATTERN.test('MNPQRSTVWX'));
  for (const bad of ['ABCDEFGHJI', 'ABCDEFGHJL', 'ABCDEFGHJO', 'ABCDEFGHJU', 'abcdefghjk', 'ABCDEFGHJ']) {
    assert.equal(QR_TOKEN_PATTERN.test(bad), false, bad);
  }
});

// ─── generation ──────────────────────────────────────────────────────────────

test('each random byte maps to one symbol by its low five bits', () => {
  const bytes = Uint8Array.from([0, 1, 9, 10, 31, 32, 33, 255, 224, 17]);
  // 32 → 0, 33 → 1, 255 → 31, 224 → 0, 17 → 'H'
  assert.equal(generateQrToken(() => bytes), '019AZ01Z0H');
});

test('a short byte source is refused rather than producing a short token', () => {
  assert.throws(() => generateQrToken(() => new Uint8Array(9)));
});

test('real tokens are well-formed, distinct, and use the whole alphabet', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const token = generateQrToken();
    assert.ok(QR_TOKEN_PATTERN.test(token), token);
    seen.add(token);
  }
  assert.equal(seen.size, 2000);
  // 20 000 symbols drawn from 32: missing any one is a (31/32)^20000 ≈ e^-635
  // event, so a gap means the mapping is biased, not unlucky.
  const used = new Set([...seen].join(''));
  assert.equal(used.size, 32);
});

// ─── normalisation ───────────────────────────────────────────────────────────

test('a canonical token passes through, and every generated token is canonical', () => {
  assert.equal(normalizeQrToken('ABCDEFGHJK'), 'ABCDEFGHJK');
  for (let i = 0; i < 200; i++) {
    const token = generateQrToken();
    assert.equal(normalizeQrToken(token), token);
  }
});

test('case, spaces and the printed hyphen are folded away', () => {
  assert.equal(normalizeQrToken('abcdefghjk'), 'ABCDEFGHJK');
  assert.equal(normalizeQrToken('abcde-fghjk'), 'ABCDEFGHJK');
  assert.equal(normalizeQrToken(' ABCDE FGHJK '), 'ABCDEFGHJK');
  // A non-breaking space, as pasted out of a WhatsApp message.
  assert.equal(normalizeQrToken('ABCDE FGHJK'), 'ABCDEFGHJK');
});

test('the confusables fold to what they were misread from', () => {
  assert.equal(normalizeQrToken('ABCDEFGHJI'), 'ABCDEFGHJ1');
  assert.equal(normalizeQrToken('ABCDEFGHJl'), 'ABCDEFGHJ1');
  assert.equal(normalizeQrToken('ABCDEFGHJo'), 'ABCDEFGHJ0');
  assert.equal(normalizeQrToken('oooooiiiii'), '0000011111');
});

test('U, the wrong length, and anything that is not ASCII are refused', () => {
  for (const bad of [
    'ABCDEFGHJU',
    'ABCDEFGHJ',
    'ABCDEFGHJKM',
    '',
    '----------',
    'ABCDE/FGHJ',
    '%41BCDEFGH',
    'ABCDEFGHJı', // dotless i: toUpperCase() would make it "I"
    'ABCDEFGHﬀ', // "ﬀ": toUpperCase() would make it "FF" and length 10
    'ÁBCDEFGHJK',
  ]) {
    assert.equal(normalizeQrToken(bad), null, JSON.stringify(bad));
  }
  assert.equal(normalizeQrToken(null), null);
  assert.equal(normalizeQrToken(undefined), null);
});

test('the printed form groups five and five, and reads back to the same token', () => {
  assert.equal(formatQrToken('ABCDEFGHJK'), 'ABCDE-FGHJK');
  const token = generateQrToken();
  assert.equal(normalizeQrToken(formatQrToken(token)), token);
});

// ─── the URL a symbol encodes ────────────────────────────────────────────────

test('the tag URL is the site origin, /id/, and the canonical token', () => {
  assert.equal(qrTagUrl('https://wawitas.org', 'ABCDEFGHJK'), 'https://wawitas.org/id/ABCDEFGHJK');
  assert.equal(qrTagUrl('https://wawitas.org/', 'abcde-fghjk'), 'https://wawitas.org/id/ABCDEFGHJK');
  assert.equal(
    qrTagUrl('https://refugio.example.org/some/path', 'ABCDEFGHJK'),
    'https://refugio.example.org/id/ABCDEFGHJK',
  );
  assert.throws(() => qrTagUrl('https://wawitas.org', 'nope'));
});

test('the human-typeable line drops the scheme and keeps the hyphen', () => {
  assert.equal(qrTagDisplayUrl('https://wawitas.org', 'ABCDEFGHJK'), 'wawitas.org/id/ABCDE-FGHJK');
});

// ─── minting ─────────────────────────────────────────────────────────────────

test('a collision is retried with a NEW token, not the same one', async () => {
  const offered: string[] = [];
  const tokens = ['AAAAAAAAAA', 'BBBBBBBBBB', 'CCCCCCCCCC'];
  const minted = await mintUniqueToken(
    async (token) => {
      offered.push(token);
      return token === 'CCCCCCCCCC';
    },
    () => tokens.shift()!,
  );
  assert.equal(minted, 'CCCCCCCCCC');
  assert.deepEqual(offered, ['AAAAAAAAAA', 'BBBBBBBBBB', 'CCCCCCCCCC']);
});

test('minting gives up after a bounded number of collisions instead of looping', async () => {
  let attempts = 0;
  await assert.rejects(
    mintUniqueToken(
      async () => {
        attempts++;
        return false;
      },
      () => 'AAAAAAAAAA',
      5,
    ),
  );
  assert.equal(attempts, 5);
});

// ─── what a finder may see ───────────────────────────────────────────────────

function pet(over: Partial<Pet> = {}): Pet {
  return {
    id: 'pet-1',
    slug: 'luna',
    species: 'dog',
    name: 'Luna',
    formerNames: ['Nube'],
    breed: 'mestiza',
    ageMonths: 18,
    ageMonthsMin: 12,
    ageMonthsMax: 24,
    ageIsEstimate: true,
    birthdateApprox: null,
    sex: 'female',
    size: 'medium',
    colorPattern: 'café con pecho blanco',
    coatType: 'corto',
    weightKgMin: 12,
    weightKgMax: 16,
    weightIsEstimate: true,
    status: 'shelter',
    hasMicrochip: true,
    coverPhoto: 'https://firebasestorage.googleapis.com/v0/b/x/o/pets%2Fpet-1%2Fcover.jpg',
    suggestedFields: ['species'],
    extractedByModel: 'flash',
    extractedAt: null,
    createdAt: null as never,
    updatedAt: null as never,
    ...over,
  };
}

test('the tag projection is an ALLOWLIST: exactly these fields, nothing added', () => {
  assert.deepEqual([...PUBLIC_TAG_PET_FIELDS].sort(), [
    'breed',
    'colorPattern',
    'coverPhoto',
    'hasMicrochip',
    'name',
    'sex',
    'size',
    'slug',
    'species',
    'status',
  ]);

  // A pet document carrying things a tag page must never render — including
  // fields a careless write could put on the public document one day.
  const polluted = {
    ...pet(),
    microchipCode: '068000000000042',
    identity: { code: '068000000000042' },
    location: { address: 'Calle Falsa 123' },
    ownerPhone: '59170000000',
  } as unknown as Pet;

  const view = toPublicTagPet(polluted);
  assert.deepEqual(Object.keys(view).sort(), [...PUBLIC_TAG_PET_FIELDS].sort());
  assert.equal('id' in view, false);
  const serialised = JSON.stringify(view);
  // Not 'pet-1': the pet id is legitimately INSIDE the public cover photo's
  // storage path (`pets%2Fpet-1%2Fcover.jpg`), exactly as on the dossier. The
  // first run of this test flagged it, which is how that was noticed.
  for (const leak of ['068000000000042', 'Calle Falsa', '59170000000', 'Nube', 'flash']) {
    assert.equal(serialised.includes(leak), false, leak);
  }
});

test('every status has a decided tone, and a cancelled intake has none', () => {
  const expected: Record<PetStatus, string | null> = {
    inbound: 'in-care',
    quarantine: 'in-care',
    shelter: 'in-care',
    foster: 'in-care',
    available: 'available',
    adopted: 'adopted',
    lost: 'lost',
    cancelled: null,
  };
  for (const [status, tone] of Object.entries(expected)) {
    assert.equal(tagTone(status as PetStatus), tone, status);
  }
});

test('a token document fails CLOSED: only an explicit null revokedAt is active', () => {
  assert.equal(tokenRecordFrom(undefined), null);
  assert.deepEqual(tokenRecordFrom({ petId: 'p', revokedAt: null }), { petId: 'p', revoked: false });
  assert.deepEqual(tokenRecordFrom({ petId: 'p', revokedAt: { seconds: 1 } }), { petId: 'p', revoked: true });
  assert.deepEqual(tokenRecordFrom({ petId: 'p' }), { petId: 'p', revoked: true });
  assert.deepEqual(tokenRecordFrom({ petId: 42, revokedAt: null }), { petId: '', revoked: false });
});

// ─── the scan decision ───────────────────────────────────────────────────────

function lookups(tokens: Record<string, QrTokenRecord>, pets: Record<string, Pet>) {
  const calls = { token: [] as string[], pet: [] as string[] };
  const deps: TagLookups = {
    async getToken(token) {
      calls.token.push(token);
      return tokens[token] ?? null;
    },
    async getPet(petId) {
      calls.pet.push(petId);
      return pets[petId] ?? null;
    },
  };
  return { deps, calls };
}

test('input that cannot be a token is unknown and costs NO read', async () => {
  const { deps, calls } = lookups({}, {});
  for (const input of ['', 'hola', '../../etc', 'ABCDEFGHJU', 'x'.repeat(500)]) {
    assert.deepEqual(await resolveTag(input, deps), { kind: 'unknown' });
  }
  assert.deepEqual(calls, { token: [], pet: [] });
});

test('an unknown token is unknown, reads only the token, and carries nothing', async () => {
  const { deps, calls } = lookups({}, { 'pet-1': pet() });
  const view = await resolveTag('ABCDEFGHJK', deps);
  assert.deepEqual(view, { kind: 'unknown' });
  assert.deepEqual(calls, { token: ['ABCDEFGHJK'], pet: [] });
});

test('a revoked token is inactive and NEVER reads the pet', async () => {
  const { deps, calls } = lookups({ ABCDEFGHJK: { petId: 'pet-1', revoked: true } }, { 'pet-1': pet() });
  const view = await resolveTag('abcde-fghjk', deps);
  assert.deepEqual(view, { kind: 'inactive', token: 'ABCDEFGHJK', reason: 'revoked' });
  assert.deepEqual(calls.pet, []);
});

test('an active token resolves to the projection, with the tone of its status', async () => {
  const tones: Array<[PetStatus, string]> = [
    ['lost', 'lost'],
    ['adopted', 'adopted'],
    ['available', 'available'],
    ['quarantine', 'in-care'],
    ['foster', 'in-care'],
  ];
  for (const [status, tone] of tones) {
    const { deps } = lookups(
      { ABCDEFGHJK: { petId: 'pet-1', revoked: false } },
      { 'pet-1': pet({ status }) },
    );
    const view = await resolveTag('ABCDEFGHJK', deps);
    assert.equal(view.kind, 'active', status);
    if (view.kind !== 'active') continue;
    assert.equal(view.tone, tone, status);
    assert.equal(view.petId, 'pet-1');
    assert.deepEqual(view.pet, toPublicTagPet(pet({ status })));
  }
});

test('a cancelled intake reads as an inactive tag and names no animal', async () => {
  const { deps } = lookups(
    { ABCDEFGHJK: { petId: 'pet-1', revoked: false } },
    { 'pet-1': pet({ status: 'cancelled' }) },
  );
  const view = await resolveTag('ABCDEFGHJK', deps);
  assert.deepEqual(view, { kind: 'inactive', token: 'ABCDEFGHJK', reason: 'record-closed' });
});

test('a token whose pet is gone is UNKNOWN — the page must not confirm there was one', async () => {
  const { deps } = lookups({ ABCDEFGHJK: { petId: 'deleted-pet', revoked: false } }, {});
  assert.deepEqual(await resolveTag('ABCDEFGHJK', deps), { kind: 'unknown' });
});

test('a pet id that cannot name a document is never handed to the reader', async () => {
  for (const petId of ['', 'pets/pet-1', '../x']) {
    const { deps, calls } = lookups({ ABCDEFGHJK: { petId, revoked: false } }, {});
    assert.deepEqual(await resolveTag('ABCDEFGHJK', deps), { kind: 'unknown' }, petId);
    assert.deepEqual(calls.pet, [], petId);
  }
});

test('the admin screen shows the newest ACTIVE token, never a revoked one', () => {
  const tokens = [
    { token: 'A', revokedAt: 5, createdAt: 30 },
    { token: 'B', revokedAt: null, createdAt: 10 },
    { token: 'C', revokedAt: null, createdAt: 20 },
  ];
  assert.equal(activeTokenOf(tokens)?.token, 'C');
  assert.equal(activeTokenOf([{ token: 'A', revokedAt: 5, createdAt: 30 }]), null);
});

// ─── the enforcing copies in firestore.rules ─────────────────────────────────

const RULES = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8');

/** The body of `match /qrTokens/{tokenId} { … }`, braces counted, comments skipped. */
function qrTokensBlock(): string {
  const start = RULES.indexOf('match /qrTokens/{tokenId} {');
  assert.ok(start >= 0, 'qrTokens block not found in firestore.rules');
  let depth = 0;
  let i = RULES.indexOf('{', start + 'match /qrTokens/'.length + '{tokenId}'.length);
  const bodyStart = i;
  for (; i < RULES.length; i++) {
    if (RULES.startsWith('//', i)) {
      i = RULES.indexOf('\n', i);
      continue;
    }
    if (RULES[i] === '{') depth++;
    if (RULES[i] === '}' && --depth === 0) break;
  }
  return RULES.slice(bodyStart, i + 1);
}

/** The block with its comments removed, so a rule is matched and not prose about it. */
function qrTokensRules(): string {
  return qrTokensBlock()
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

test('ENUMERATION GUARD: the qrTokens rules allow a public get and never a public list', () => {
  const rules = qrTokensRules();
  assert.match(rules, /allow get: if true;/);
  assert.match(rules, /allow list: if isAdmin\(\);/);
  // `read` is get + list. Any `allow read` here, or a write that could reach
  // list-shaped access, reopens the directory this collection exists to refuse.
  assert.doesNotMatch(rules, /allow\s+read/);
  assert.doesNotMatch(rules, /allow\s+(?:[\w, ]*\s)?list\s*:\s*if\s+(?:true|signedIn\(\))/);
  assert.doesNotMatch(rules, /allow\s+write/);
  assert.match(rules, /allow delete: if false;/);
});

test('the token pattern in firestore.rules is the one this module enforces', () => {
  const match = /tokenId\.matches\('([^']+)'\)/.exec(qrTokensRules());
  assert.ok(match, 'tokenId.matches(...) not found in the qrTokens block');
  assert.equal(match[1], QR_TOKEN_PATTERN.source);
});
