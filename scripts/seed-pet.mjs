/**
 * Publish one pet: upload its photo, write its public document.
 *
 * ── Why a script and not the admin UI ──────────────────────────────────────
 * The admin publishing UI is step 4 of the build order and needs auth (step 2)
 * in front of it. This is step 3 — the point of which is to prove the core
 * loop end to end with a real animal in it:
 *
 *     pets-server.ts → AdoptionWall.tsx → rendered HTML
 *
 * Every layer under that is live and proven; the loop itself has never once
 * run with data in it. So this script exists to close that gap now, and to
 * keep working afterwards as the fallback path whenever the UI is down or a
 * pet needs correcting faster than a deploy.
 *
 * ── The constraints it enforces, and why each one is here ──────────────────
 * Every check below corresponds to something that has already gone wrong in
 * this project or is documented in CLAUDE.md as waiting to:
 *
 *   • `coverPhoto` MUST be served from firebasestorage.googleapis.com, because
 *     next.config.ts `images.remotePatterns` allows that host and no other.
 *     Any other host throws `E231 Invalid src prop` and 500s the whole page.
 *     This killed the 2026-08-08 mock-data attempt. The URL is therefore
 *     DERIVED from the upload here and never hand-typed.
 *
 *   • `status` must be one of the English stored values, and only 'available'
 *     reaches the wall — getWall() filters on it. A typo'd status is not an
 *     error anywhere, it is simply an animal nobody ever sees.
 *
 *   • `createdAt` must exist or the wall query returns nothing at all: it
 *     orders by createdAt, and Firestore drops documents missing the ordered
 *     field. This failure is silent and looks exactly like "no data".
 *
 *   • `formerNames` must be an array. The dossier reads `.length` unguarded.
 *
 * ── EXIF is stripped, deliberately ─────────────────────────────────────────
 * A photo taken in a foster home carries GPS coordinates in its EXIF, and
 * publishing those publishes a volunteer's home address — CLAUDE.md concern
 * #2, arrived at through the image pipeline rather than the location field.
 * sharp drops metadata unless explicitly asked to keep it; we never ask.
 *
 * Usage:
 *   node scripts/seed-pet.mjs <pet.json>
 *   node scripts/seed-pet.mjs <pet.json> --dry-run
 *   node scripts/seed-pet.mjs <pet.json> --delete
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, extname } from 'node:path';
import { randomUUID } from 'node:crypto';

import sharp from 'sharp';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ─────────────────────────────────────────────────────────────────────────────
// The stored vocabulary. These are the ENGLISH values written into Firestore
// (renamed 2026-08-23); the Spanish a visitor reads is derived from them in
// src/i18n and must never appear in a document.
//
// Kept in step with src/lib/types.ts by the check below, so a future rename
// there fails loudly here instead of silently writing an unreachable value.
// ─────────────────────────────────────────────────────────────────────────────
const PET_STATUS = [
  'inbound', 'quarantine', 'shelter', 'foster',
  'available', 'adopted', 'lost', 'cancelled',
];
const SPECIES = ['dog', 'cat', 'rabbit', 'other'];
const PET_SEX = ['male', 'female'];
const PET_SIZE = ['small', 'medium', 'large'];

/** The one status that reaches the public wall. getWall() filters on it. */
const WALL_STATUS = 'available';

const BUCKET = JSON.parse(readFileSync(join(REPO_ROOT, 'firebase.json'), 'utf8')).storage?.bucket;
if (!BUCKET) throw new Error('firebase.json needs storage.bucket');

// ─────────────────────────────────────────────────────────────────────────────
// Guard against drift between this script's copy of the enums and the real
// ones. A rename in types.ts that is not mirrored here would otherwise write a
// value the site cannot render — and stored enum values are DATA, so the cost
// of catching it late is a backfill.
// ─────────────────────────────────────────────────────────────────────────────
function assertEnumsMatchTypes() {
  const types = readFileSync(join(REPO_ROOT, 'src/lib/types.ts'), 'utf8');
  const declared = (name) => {
    const m = types.match(new RegExp(`export type ${name} =([\\s\\S]*?);`));
    if (!m) return null;
    return [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]).sort();
  };
  const pairs = [
    ['PetStatus', PET_STATUS], ['Species', SPECIES],
    ['PetSex', PET_SEX], ['PetSize', PET_SIZE],
  ];
  for (const [name, mine] of pairs) {
    const theirs = declared(name);
    // A guard that quietly turns itself off is worse than no guard: it reads
    // as a passing check forever. If the declaration cannot be found, the
    // parser is out of date with types.ts and that is itself the failure.
    if (!theirs || theirs.length === 0) {
      fail(
        `Could not read "export type ${name}" out of src/lib/types.ts.\n` +
        `  This script's drift check is therefore not checking anything.\n` +
        `  Fix the parser in assertEnumsMatchTypes() before seeding.`,
      );
    }
    const a = [...mine].sort().join(',');
    const b = theirs.join(',');
    if (a !== b) {
      fail(
        `${name} has drifted from src/lib/types.ts.\n` +
        `  this script: ${a}\n  types.ts:    ${b}\n` +
        `  These are STORED values. Update this script before seeding.`,
      );
    }
  }
}

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation. Everything a visitor-facing page reads unguarded is required
// here, so a half-filled document cannot 500 the page it renders on.
// ─────────────────────────────────────────────────────────────────────────────
function validate(pet, photoPath) {
  const errors = [];
  const oneOf = (field, allowed) => {
    if (!allowed.includes(pet[field])) {
      errors.push(`${field}: expected one of ${allowed.join(' | ')} — got ${JSON.stringify(pet[field])}`);
    }
  };

  if (typeof pet.slug !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(pet.slug)) {
    errors.push(`slug: must be lowercase kebab-case — got ${JSON.stringify(pet.slug)}`);
  }
  if (typeof pet.name !== 'string' || !pet.name.trim()) errors.push('name: required, non-empty');
  if (typeof pet.breed !== 'string' || !pet.breed.trim()) {
    errors.push("breed: required — the shelter's honest best guess is fine (\"mestizo\")");
  }
  if (!Array.isArray(pet.formerNames)) {
    errors.push('formerNames: must be an array ([] if none) — the dossier reads .length unguarded');
  }
  if (pet.ageMonths !== null && !Number.isInteger(pet.ageMonths)) {
    errors.push('ageMonths: an integer number of months, or null if genuinely unknown');
  }
  if (typeof pet.hasMicrochip !== 'boolean') {
    errors.push('hasMicrochip: boolean. The NUMBER never goes in this document — it is the credential by which ownership is asserted, and lives in the restricted identity tier');
  }

  oneOf('species', SPECIES);
  oneOf('sex', PET_SEX);
  oneOf('size', PET_SIZE);
  oneOf('status', PET_STATUS);

  if (pet.coverPhoto !== undefined) {
    errors.push('coverPhoto: remove it. This script derives the URL from the uploaded photo — a hand-typed URL on the wrong host 500s the page');
  }
  if (!photoPath) {
    errors.push('photo: required. Give a local image path; the wall renders <Image> and a pet with no photo is not a pet anyone adopts');
  } else if (!existsSync(photoPath)) {
    errors.push(`photo: file not found — ${photoPath}`);
  }

  if (errors.length) {
    fail(`${errors.length} problem(s) with the pet file:\n\n` + errors.map((e) => `  • ${e}`).join('\n'));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const [file] = args.filter((a) => !a.startsWith('--'));

  if (!file) {
    fail('Usage: node scripts/seed-pet.mjs <pet.json> [--dry-run] [--delete]');
  }

  const petFile = resolve(REPO_ROOT, file);
  if (!existsSync(petFile)) fail(`No such file: ${petFile}`);

  const raw = JSON.parse(readFileSync(petFile, 'utf8'));
  const { photo, ...rest } = raw;
  // Keys starting with `_` are documentation in the template file, not data.
  // Stripping them here is what lets the example stay self-describing without
  // seeding a pet whose document carries a paragraph of instructions.
  const pet = Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith('_')));
  const photoPath = photo ? resolve(dirname(petFile), photo) : null;

  assertEnumsMatchTypes();

  const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
  if (!project) {
    fail('GOOGLE_CLOUD_PROJECT is not set. Pin it explicitly — this machine carries two Google identities and the Admin SDK bypasses firestore.rules, so a wrong project id is not caught by your security rules.');
  }

  if (!getApps().length) initializeApp({ projectId: project, storageBucket: BUCKET });
  const db = getFirestore();
  const bucket = getStorage().bucket();

  console.log(`project : ${project}`);
  console.log(`bucket  : ${BUCKET}`);
  console.log(`pet     : ${pet.slug ?? '(no slug)'}\n`);

  // Idempotent by slug: re-running corrects a pet rather than duplicating it.
  const existing = await db.collection('pets').where('slug', '==', pet.slug).limit(1).get();
  const ref = existing.empty ? db.collection('pets').doc() : existing.docs[0].ref;
  const isUpdate = !existing.empty;

  // ── delete ───────────────────────────────────────────────────────────────
  if (flags.has('--delete')) {
    if (!isUpdate) fail(`No pet with slug "${pet.slug}" exists — nothing to delete.`);
    await bucket.deleteFiles({ prefix: `pets/${ref.id}/`, force: true });
    await ref.delete();
    console.log(`✔ deleted pets/${ref.id} and its photos`);
    return;
  }

  validate(pet, photoPath);

  if (pet.status !== WALL_STATUS) {
    console.log(`⚠ status is "${pet.status}", not "${WALL_STATUS}" — this pet will NOT appear on the public wall.\n`);
  }

  // ── photo ────────────────────────────────────────────────────────────────
  // Resized for an audience on mid-range Android over mobile data, and
  // re-encoded — which is also what drops the EXIF, GPS included.
  const source = await sharp(photoPath).rotate(); // honour EXIF orientation before stripping it
  const meta = await source.metadata();
  // withoutEnlargement means a small original keeps its own dimensions, so the
  // real output size is read back rather than assumed — a log line that states
  // 1200×1500 regardless would be reporting the request, not the result.
  const { data: body, info } = await source
    .resize({ width: 1200, height: 1500, fit: 'cover', withoutEnlargement: true })
    .jpeg({ quality: 82, progressive: true })
    .toBuffer({ resolveWithObject: true });

  const objectPath = `pets/${ref.id}/cover.jpg`;
  const sizeKb = (n) => `${Math.round(n / 1024)} KB`;

  console.log(`photo   : ${extname(photoPath)} ${meta.width}×${meta.height} → ${info.width}×${info.height} jpeg`);
  console.log(`          ${sizeKb(statSync(photoPath).size)} → ${sizeKb(body.length)} (EXIF stripped)`);
  if (info.width < 1200) {
    console.log(`          ⚠ smaller than 1200px wide — it will look soft on the wall`);
  }

  if (flags.has('--dry-run')) {
    console.log(`\n✔ dry run — validated, nothing written.`);
    console.log(`  would ${isUpdate ? 'UPDATE' : 'CREATE'} pets/${ref.id}`);
    console.log(`  would upload gs://${BUCKET}/${objectPath}`);
    return;
  }

  await bucket.file(objectPath).save(body, {
    contentType: 'image/jpeg',
    // A download token is written so the URL keeps working even if
    // storage.rules is later tightened on pets/**. Public read is the rule
    // today; the token means a rules change does not silently blank the wall.
    metadata: { metadata: { firebaseStorageDownloadTokens: randomUUID() } },
    resumable: false,
  });

  // Derived, never typed. This is the host next.config.ts allows.
  const coverPhoto =
    `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/` +
    `${encodeURIComponent(objectPath)}?alt=media`;

  // ── document ─────────────────────────────────────────────────────────────
  const doc = {
    ...pet,
    coverPhoto,
    ageMonths: pet.ageMonths ?? null,
    birthdateApprox: pet.birthdateApprox ?? null,
    updatedAt: FieldValue.serverTimestamp(),
  };
  // createdAt is what the wall ORDERS BY. Set once, never overwritten, or a
  // correction would silently reshuffle the wall.
  if (!isUpdate) doc.createdAt = FieldValue.serverTimestamp();

  await ref.set(doc, { merge: true });

  const written = await ref.get();
  const data = written.data();
  if (!data.createdAt) {
    fail('createdAt is missing after write — the wall orders by it and would silently drop this pet.');
  }

  console.log(`\n✔ ${isUpdate ? 'updated' : 'created'} pets/${ref.id}`);
  console.log(`  photo : ${coverPhoto}`);
  console.log(`  wall  : ${pet.status === WALL_STATUS ? 'yes' : 'NO — status is ' + pet.status}`);
  console.log(`  page  : /adopt/${pet.slug}`);
}

main().catch((err) => fail(err.stack ?? err.message));
