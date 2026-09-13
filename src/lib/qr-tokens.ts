/**
 * QR identity tags — the pure half. Build-order step 12, plan §2.5 and §7.
 *
 * No Firebase import and no `server-only`, so every decision below is testable
 * offline — the same split as `areas.ts` / `areas-admin.ts`. The Admin SDK
 * wiring lives in `pets-server.ts` (`resolveQrTag`), the client writers in
 * `qr-tokens-admin.ts`, and the symbol itself in `qr-code.ts`.
 *
 * ── What a tag is for ─────────────────────────────────────────────────────
 * A stranger has an animal in front of them and a phone in their hand. The
 * tag must turn that into the animal's name and a WhatsApp message to the
 * shelter, with no account. It must NOT give them the microchip number, an
 * address, or a way to walk the registry.
 *
 * ── Why a separate token, not the pet id or the slug ─────────────────────
 * A token can be revoked and reissued without touching the animal's record (a
 * lost collar, a tag printed with a smudge), and it is opaque: a slug is a
 * name, and a name printed on a collar next to a URL is an invitation to try
 * the neighbours.
 */

import type { Pet, PetStatus } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// The token
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Crockford base32: the ten digits and 22 letters, WITHOUT I, L, O and U.
 *
 * Chosen because a token is PRINTED and then READ BACK by a stranger, often
 * off a scratched tag in bad light:
 *   - I and L are dropped because they are read as 1, and O because it is
 *     read as 0. Dropping them means a misreading still lands on a valid
 *     character — and `normalizeQrToken` maps the confusables back, so the
 *     misreading lands on the RIGHT one.
 *   - U is dropped (Crockford's own reason) so four random letters cannot
 *     spell the obvious English words. On a collar a child might read aloud,
 *     that is a real reason, not a joke.
 *   - Uppercase letters and digits are exactly the QR ALPHANUMERIC set, which
 *     is what lets the encoder spend 5.5 bits per token character instead of
 *     8 — see `qr-code.ts` for the measured symbol version.
 *
 * 32 symbols is a power of two, so one random byte masked to 5 bits is
 * perfectly uniform: no modulo bias to reason about.
 */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Ten characters, 50 bits. Plan §7 asks for "~10": short enough to keep the
 * symbol at version 3 on this shelter's host, long enough that guessing is not
 * a strategy — at ten thousand live tags, one guess hits with probability
 * about 1 in 10^11.
 */
export const QR_TOKEN_LENGTH = 10;

/**
 * ⚠️ MIRRORED in `firestore.rules` (`tokenId.matches(...)` in the qrTokens
 * block), which is the enforcing copy. A test reads the rules file and fails
 * if the two drift — the same arrangement as the service-area bounds.
 */
export const QR_TOKEN_PATTERN = /^[0-9A-HJKMNP-TV-Z]{10}$/;

/**
 * The printed width of the tag's QR image, quiet zone included, in mm.
 *
 * Plan §7 asks for "≥ 20 mm printed", and this reads that as the SYMBOL — the
 * part a phone decodes — not the white margin around it, because a quiet zone
 * cropped by a tag's edge still prints the symbol at full size. The image is
 * the symbol plus four modules a side, so the symbol is `size / (size + 8)` of
 * it:
 *
 *     version 3 (29 modules, this shelter's host)   26 × 29/37 = 20.4 mm
 *     version 4 (33 modules, a longer fork host)    26 × 33/41 = 20.9 mm
 *
 * The fraction only grows with the version, so 26 holds for every payload
 * this template can produce. A test pins that arithmetic AND that the
 * stylesheet actually uses this number.
 */
export const QR_PRINT_SIZE_MM = 26;

/** A source of cryptographically strong random bytes. Injectable for tests. */
export type RandomBytes = (length: number) => Uint8Array;

const cryptoRandomBytes: RandomBytes = (length) => {
  const bytes = new Uint8Array(length);
  // Web Crypto: `window.crypto` in the browser, `globalThis.crypto` in Node
  // 20+. Deliberately never Math.random — a predictable token generator makes
  // every tag guessable by anyone who has seen one.
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
};

/** A fresh token. Uniqueness is NOT this function's job — see `mintUniqueToken`. */
export function generateQrToken(randomBytes: RandomBytes = cryptoRandomBytes): string {
  const bytes = randomBytes(QR_TOKEN_LENGTH);
  if (bytes.length < QR_TOKEN_LENGTH) {
    throw new Error(`need ${QR_TOKEN_LENGTH} random bytes, got ${bytes.length}`);
  }
  let token = '';
  for (let i = 0; i < QR_TOKEN_LENGTH; i++) {
    token += CROCKFORD_ALPHABET[bytes[i]! & 0b11111];
  }
  return token;
}

/**
 * Turn whatever arrived — a scanned URL segment, or a code a finder typed off
 * a scratched tag — into the canonical token, or `null` if it cannot be one.
 *
 *   - whitespace and hyphens are ignored (Crockford allows hyphens for
 *     readability, and the printed code uses one: ABCDE-FGHJK)
 *   - case is folded
 *   - the confusables fold to what they were misread from: I and L → 1, O → 0
 *   - U, any other letter outside the alphabet, and ANY non-ASCII character
 *     make it `null`
 *
 * ⚠️ Non-ASCII is rejected BEFORE case folding, not after. `toUpperCase` turns
 * "ı" (dotless i) into "I" and the ligature "ﬀ" into "FF", which would let a
 * string of the wrong length or alphabet fold into a well-formed token.
 *
 * `null` is also a READ-BUDGET decision: `resolveTag` does no Firestore read
 * at all for input that cannot be a token, so garbage in the URL costs the
 * shelter nothing.
 */
export function normalizeQrToken(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const compact = input.replace(/[\s-]+/g, '');
  if (compact.length !== QR_TOKEN_LENGTH) return null;
  if (/[^\x21-\x7e]/.test(compact)) return null;
  const folded = compact.toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0');
  return QR_TOKEN_PATTERN.test(folded) ? folded : null;
}

/** "ABCDEFGHJK" → "ABCDE-FGHJK": how the code is printed under the symbol. */
export function formatQrToken(token: string): string {
  return `${token.slice(0, 5)}-${token.slice(5)}`;
}

/**
 * The URL the symbol encodes: `{origin}/id/{TOKEN}`.
 *
 * The origin comes from `SHELTER.siteUrl`, passed in rather than imported, so a
 * forking shelter's tags point at their own site and this module stays free of
 * configuration. The token is canonical uppercase so the tail of the payload
 * is QR-alphanumeric.
 *
 * ⚠️ Everything printed on a collar is a PERMANENT URL. Once a tag exists, the
 * `/id/` path and this token format are a contract with a piece of metal on an
 * animal; changing either breaks every tag already out there.
 */
export function qrTagUrl(siteUrl: string, token: string): string {
  const canonical = normalizeQrToken(token);
  if (!canonical) throw new Error('qrTagUrl: not a well-formed token');
  return `${new URL(siteUrl).origin}/id/${canonical}`;
}

/** "wawitas.org/id/ABCDE-FGHJK": the human-typeable line under the symbol. */
export function qrTagDisplayUrl(siteUrl: string, token: string): string {
  return `${new URL(siteUrl).host}/id/${formatQrToken(token)}`;
}

/**
 * Mint a token that does not exist yet.
 *
 * `tryCreate` must be create-if-absent — a transaction that reads the document
 * and refuses if it is there — and resolve `false` on a collision. The rules
 * back this up: an existing token can only ever be REVOKED, so an overwrite
 * cannot slip through as an update. A collision at 50 bits is vanishingly
 * unlikely, which is exactly why the retry path is written and tested rather
 * than assumed: code that never runs is code nobody notices is wrong.
 */
export async function mintUniqueToken(
  tryCreate: (token: string) => Promise<boolean>,
  generate: () => string = generateQrToken,
  maxAttempts = 5,
): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const token = generate();
    if (await tryCreate(token)) return token;
  }
  throw new Error(`could not mint a unique QR token in ${maxAttempts} attempts`);
}

// ─────────────────────────────────────────────────────────────────────────────
// What a scan shows
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ONLY fields of a pet a tag page may render. An allowlist, not a
 * denylist: a field added to `Pet` tomorrow does not reach a finder's screen
 * until someone adds it here on purpose.
 *
 * Every one of these is already on the public `pets/{petId}` document.
 * Deliberately absent even so: `formerNames`, ages and weights (nothing a
 * finder needs to hand an animal back), and the model provenance fields. The
 * restricted tiers — `identity`, `location`, `scans`, `custody` — are not on
 * `Pet` at all, and `resolveQrTag` never reads them; a test holds it to that.
 */
export const PUBLIC_TAG_PET_FIELDS = [
  'name',
  'species',
  'sex',
  'breed',
  'size',
  'colorPattern',
  'status',
  'hasMicrochip',
  'coverPhoto',
  'slug',
] as const;

export type PublicTagPet = Pick<Pet, (typeof PUBLIC_TAG_PET_FIELDS)[number]>;

export function toPublicTagPet(pet: Pet): PublicTagPet {
  return {
    name: pet.name,
    species: pet.species,
    sex: pet.sex,
    breed: pet.breed,
    size: pet.size,
    colorPattern: pet.colorPattern ?? null,
    status: pet.status,
    hasMicrochip: pet.hasMicrochip === true,
    coverPhoto: pet.coverPhoto ?? null,
    slug: pet.slug,
  };
}

/**
 * How loud the page is, by status.
 *
 *   lost       the animal is being looked for — say so first and loudest
 *   adopted    it has a family; the shelter still takes the call and relays it
 *   available  in adoption with the shelter, so a finder has an escapee
 *   in-care    inbound, quarantine, at the shelter, or in a foster home
 *   null       `cancelled`: an intake that never happened. The record makes no
 *              claim that the shelter holds this animal, so it is shown as an
 *              inactive tag rather than naming an animal that may not be theirs
 *
 * Exhaustive by construction: a new `PetStatus` fails the build here until
 * someone decides what a finder should read for it.
 */
export type TagTone = 'lost' | 'adopted' | 'available' | 'in-care';

export function tagTone(status: PetStatus): TagTone | null {
  switch (status) {
    case 'lost':
      return 'lost';
    case 'adopted':
      return 'adopted';
    case 'available':
      return 'available';
    case 'inbound':
    case 'quarantine':
    case 'shelter':
    case 'foster':
      return 'in-care';
    case 'cancelled':
      return null;
    default: {
      const unhandled: never = status;
      throw new Error(`tagTone: unhandled status ${String(unhandled)}`);
    }
  }
}

/** A token document, reduced to the two things the decision needs. */
export interface QrTokenRecord {
  petId: string;
  revoked: boolean;
}

/**
 * Read a raw `qrTokens/{token}` document into a record.
 *
 * Fails CLOSED: only an explicit `revokedAt: null` counts as active. A document
 * with the field missing cannot be written through the rules, but one written
 * by hand through the Admin SDK could be — and an ambiguous tag should read as
 * inactive (which still offers the shelter's number) rather than resolve.
 */
export function tokenRecordFrom(data: Record<string, unknown> | undefined): QrTokenRecord | null {
  if (!data) return null;
  const petId = typeof data.petId === 'string' ? data.petId : '';
  return { petId, revoked: data.revokedAt !== null };
}

export type TagView =
  /** Not a token, or no such token, or a token whose pet no longer exists. */
  | { kind: 'unknown' }
  /** A real tag that no longer resolves. Carries no pet data at all. */
  | { kind: 'inactive'; token: string; reason: 'revoked' | 'record-closed' }
  | { kind: 'active'; token: string; petId: string; pet: PublicTagPet; tone: TagTone };

export interface TagLookups {
  getToken(token: string): Promise<QrTokenRecord | null>;
  getPet(petId: string): Promise<Pet | null>;
}

/**
 * The whole scan decision, with the reads injected.
 *
 * Three properties matter, and each has a test:
 *   1. Input that cannot be a token performs NO read.
 *   2. A revoked token never reads the pet — the page must not be able to
 *      name the animal even by accident.
 *   3. A token whose pet is gone is `unknown`, not `inactive`: "this tag
 *      existed" is true, but "and there was an animal behind it" is the one
 *      thing the page must not confirm.
 */
export async function resolveTag(input: string, lookups: TagLookups): Promise<TagView> {
  const token = normalizeQrToken(input);
  if (!token) return { kind: 'unknown' };

  const record = await lookups.getToken(token);
  if (!record) return { kind: 'unknown' };
  if (record.revoked) return { kind: 'inactive', token, reason: 'revoked' };

  // A pet id that could not name a document is treated as no pet, rather than
  // handed to the SDK to throw on.
  if (!record.petId || record.petId.includes('/')) return { kind: 'unknown' };

  const pet = await lookups.getPet(record.petId);
  if (!pet) return { kind: 'unknown' };

  const tone = tagTone(pet.status);
  if (tone === null) return { kind: 'inactive', token, reason: 'record-closed' };

  return { kind: 'active', token, petId: record.petId, pet: toPublicTagPet(pet), tone };
}

/**
 * How many animals the batch print sheet lists: the same cap as the admin
 * dashboard it is reached from, so the two lists show the same animals.
 */
export const QR_SHEET_PET_LIMIT = 50;

export interface SheetTruncation {
  shown: number;
  /** null when the count itself could not be read. */
  total: number | null;
}

/**
 * Whether the sheet's list was cut off, so it can SAY so. A capped list with
 * no notice hides the oldest animals with no clue why they are missing.
 *
 * With a count, it is truncated exactly when there are more pets than the cap.
 * Without one (the count request failed), a page that came back full is
 * treated as truncated — a possibly-unneeded notice beats a silent gap.
 */
export function sheetTruncation(
  fetched: number,
  total: number | null,
  limit: number = QR_SHEET_PET_LIMIT,
): SheetTruncation | null {
  if (total !== null) return total > limit ? { shown: limit, total } : null;
  return fetched >= limit ? { shown: limit, total: null } : null;
}

/**
 * Which of an animal's tokens is the live one. A pet should have at most one —
 * reissuing revokes the old one in the same transaction — but the rules cannot
 * enforce that, so the admin screen shows the newest active token and lists the
 * rest rather than assuming.
 */
export function activeTokenOf<T extends { revokedAt: number | null; createdAt: number | null }>(
  tokens: readonly T[],
): T | null {
  const active = tokens.filter((t) => t.revokedAt === null);
  active.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return active[0] ?? null;
}
