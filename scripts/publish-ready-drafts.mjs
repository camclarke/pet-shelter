/**
 * Publish every in-shelter animal that already has a name and a photo.
 *
 *   npm run publish:ready -- --expect 20                      dry run (default)
 *   npm run publish:ready -- --expect 20 --write --as admin@example.com
 *   npm run publish:ready -- --hide latest                    dry run of the rollback
 *   npm run publish:ready -- --hide _local/publish-backup-….json --write
 *
 * Needs ADC on the project's own account and GOOGLE_CLOUD_PROJECT=wawitas.
 *
 * ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
 * Owner decision, 2026-10-18: "to publish a dog, only a name and a picture are
 * required." The wizard's gate was relaxed to match (`publishBlockers` in
 * src/lib/intake.ts). The animals photographed before that day are sitting as
 * drafts that the OLD gate refused; this publishes them once, with
 * `status: 'available'`, so they reach the adoption wall.
 *
 * ═══ WHAT THIS DELIBERATELY DECIDES NOTHING ABOUT ════════════════════════════
 * Which animals are ready is `selectReadyDrafts` (src/lib/publish-selection.ts),
 * which defers to the SAME `publishBlockers` the wizard's Publicar button obeys.
 * What a published pet looks like is `buildPublishDocuments`
 * (src/lib/publish-documents.ts), the SAME function `publishDraft` uses. This
 * file only reads, backs up, and commits. If this script and the wizard ever
 * disagree about a document, this file has a bug.
 *
 * ═══ THE REFUSALS ════════════════════════════════════════════════════════════
 *  1. A project that is not `wawitas`. The Admin SDK BYPASSES firestore.rules,
 *     so a wrong project is caught here or not at all.
 *  2. `--write` without `--expect N`, or with a selection that is not exactly N.
 *     The number is read off the dry run by a person; a selector that quietly
 *     widened would otherwise publish whatever it found.
 *  3. `--write` without `--as <email>` of an account holding the admin claim.
 *     Published media and chip records are stamped with who published them,
 *     exactly as the wizard stamps `user.uid`.
 *  4. A backup that could not be written. Every selected draft is saved
 *     verbatim to `_local/publish-backup-<ISO>.json` (gitignored) BEFORE the
 *     first write; publishing deletes the draft, and the backup is the only
 *     copy of it afterwards.
 *  5. A pet document that already exists at the draft's id (`create`, never
 *     `set`), or a draft edited since it was read (the delete carries the
 *     draft's `lastUpdateTime` as a precondition). Either fails that animal's
 *     batch and the run stops.
 *
 * ═══ ONE BATCH PER ANIMAL ════════════════════════════════════════════════════
 * pets/{id}, detail/main, media/*, identity/microchip (only for a valid chip)
 * and the draft delete commit together, exactly like `publishDraft`. The pet
 * id IS the draft id, so `pets/{id}/medical` — already written by the register
 * import — and `registerEntries/{no}.petId` stay valid; the roster sends a row
 * whose id resolves to a published pet to the pet page (register-admin.ts).
 *
 * ═══ ROLLBACK ════════════════════════════════════════════════════════════════
 * `--hide <backup file | latest>` sets `status: 'shelter'` on every pet in the
 * backup, which takes it off the wall without deleting anything. Dry run by
 * default, `--write` to apply. Restoring the drafts themselves is a separate,
 * deliberate act from the backup file.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, GeoPoint, Timestamp, getFirestore } from 'firebase-admin/firestore';

import { disambiguateSlug, publishSlugBase } from '../src/lib/intake.ts';
import { buildPublishDocuments } from '../src/lib/publish-documents.ts';
import { selectReadyDrafts } from '../src/lib/publish-selection.ts';
import { es } from '../src/i18n/es.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP_DIR = join(REPO_ROOT, '_local');

/** Hardcoded on purpose — see scripts/import-register.mjs for the reasoning. */
const EXPECTED_PROJECT = 'wawitas';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Arguments
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { write: false, expect: null, as: null, hide: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') args.write = true;
    else if (arg === '--expect') args.expect = Number(argv[(i += 1)]);
    else if (arg === '--as') args.as = argv[(i += 1)] ?? null;
    else if (arg === '--hide') args.hide = argv[(i += 1)] ?? null;
    else fail(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (args.expect !== null && (!Number.isInteger(args.expect) || args.expect < 0)) {
    fail('--expect needs a whole number');
  }
  if (args.hide === '') fail('--hide needs a backup file, or "latest"');
  return args;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lossless serialisation for the backup
// ─────────────────────────────────────────────────────────────────────────────

/** Firestore values → JSON that can be turned back into the same values. */
function toBackupJson(value) {
  if (value instanceof Timestamp) {
    return { __type: 'timestamp', seconds: value.seconds, nanoseconds: value.nanoseconds };
  }
  if (value instanceof GeoPoint) {
    return { __type: 'geopoint', latitude: value.latitude, longitude: value.longitude };
  }
  if (value && typeof value === 'object' && typeof value.path === 'string' && typeof value.firestore === 'object') {
    return { __type: 'reference', path: value.path };
  }
  if (Array.isArray(value)) return value.map(toBackupJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toBackupJson(v)]));
  }
  return value;
}

/** The inverse: what a draft looked like, with `updatedAt` stripped like `loadDraft` does. */
function draftFromSnapshot(snap) {
  const data = snap.data();
  delete data.updatedAt;
  return { ...data, id: snap.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));

const project = process.env.GOOGLE_CLOUD_PROJECT;
if (project !== EXPECTED_PROJECT) {
  fail(`GOOGLE_CLOUD_PROJECT is ${JSON.stringify(project ?? null)}; this script runs against "${EXPECTED_PROJECT}" only.`);
}
if (!getApps().length) initializeApp({ projectId: project });
const db = getFirestore();

console.log(`\n  project   ${project}`);
console.log(`  mode      ${args.write ? 'WRITE' : 'dry run — nothing is written'}`);

if (args.hide !== null) {
  await hide(args);
} else {
  await publish(args);
}

// ─────────────────────────────────────────────────────────────────────────────
// Publish
// ─────────────────────────────────────────────────────────────────────────────

async function resolveOperator(email) {
  const user = await getAuth().getUserByEmail(email);
  if (user.customClaims?.admin !== true) fail(`${email} does not hold the admin claim.`);
  return user;
}

/** Every published slug starting with `base` — the same prefix query as `takenSlugs`. */
async function takenSlugs(base) {
  if (base === '') fail('refusing a slug query with an empty prefix: it would match every slug');
  const snap = await db
    .collection('pets')
    .where('slug', '>=', base)
    .where('slug', '<=', `${base}`)
    .get();
  return snap.docs.map((d) => d.get('slug'));
}

async function publish(opts) {
  if (opts.write && opts.expect === null) fail('--write needs --expect N, the count you read off the dry run.');
  if (opts.write && !opts.as) fail('--write needs --as <email> of an admin account.');

  const operator = opts.as ? await resolveOperator(opts.as) : null;
  if (operator) console.log(`  operator  ${operator.email} (${operator.uid})`);

  // ── read ────────────────────────────────────────────────────────────────
  const entriesSnap = await db.collection('registerEntries').get();
  const entries = entriesSnap.docs.map((d) => {
    const x = d.data();
    return {
      no: x.no,
      status: x.status ?? 'unknown',
      petId: x.petId ?? null,
      hasRealName: x.hasRealName ?? false,
      name: x.name ?? '',
      nameRaw: x.nameRaw ?? '',
      species: x.species ?? null,
    };
  });

  const draftsSnap = await db.collection('petDrafts').get();
  const snapshots = new Map(draftsSnap.docs.map((d) => [d.id, d]));
  const drafts = new Map(draftsSnap.docs.map((d) => [d.id, draftFromSnapshot(d)]));

  const { ready, skipped } = selectReadyDrafts(entries, drafts);

  // ── plan ────────────────────────────────────────────────────────────────
  // Slugs are resolved against the live collection AND against each other, so
  // two animals both called Luna in this run become luna and luna-2.
  const claimed = [];
  const plan = [];
  for (const item of ready) {
    const base = publishSlugBase(item.draft);
    const slug = disambiguateSlug(base, [...(await takenSlugs(base)), ...claimed]);
    claimed.push(slug);
    const existing = await db.collection('pets').doc(item.draft.id).get();
    plan.push({ ...item, slug, petExists: existing.exists });
  }

  const inShelter = entries.filter((e) => e.status === 'in-shelter').length;
  const reasons = {};
  for (const s of skipped.filter((s) => s.reason !== 'not-in-shelter')) {
    (reasons[s.reason] ??= []).push(s.no);
  }

  console.log(`\n  register rows ${entries.length}, in shelter ${inShelter}, drafts ${drafts.size}`);
  console.log(`  selected ${plan.length}\n`);
  console.log('   no  name                 sex     species (source)    photos  slug');
  for (const p of plan) {
    const photos = p.draft.media.length;
    const species = `${p.species ?? '—'} (${p.speciesSource})`;
    console.log(
      `  ${String(p.no).padStart(3)}  ${p.draft.name.trim().padEnd(20)} ${String(p.draft.sex ?? '—').padEnd(7)} ${species.padEnd(19)} ${String(photos).padStart(6)}  ${p.slug}${p.petExists ? '   ⚠ pets/{id} EXISTS' : ''}`,
    );
  }
  console.log('\n  in shelter, not selected:');
  for (const [reason, nos] of Object.entries(reasons)) {
    console.log(`    ${reason.padEnd(20)} ${nos.length}  [${nos.join(', ')}]`);
  }
  console.log(`\n  selected register numbers: ${plan.map((p) => p.no).join(', ')}`);

  if (opts.expect !== null && plan.length !== opts.expect) {
    fail(`--expect ${opts.expect}, but ${plan.length} are selected. Nothing written.`);
  }
  if (plan.some((p) => p.petExists)) fail('a pet document already exists at a selected id. Nothing written.');

  if (!opts.write) {
    console.log('\n  dry run: nothing written. Add --write --as <admin email> to publish.\n');
    return;
  }

  // ── backup, before the first write ─────────────────────────────────────
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(BACKUP_DIR, `publish-backup-${stamp}.json`);
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const backup = {
      kind: 'publish-ready-drafts backup',
      version: 1,
      project,
      takenAt: new Date().toISOString(),
      operator: operator.email,
      drafts: plan.map((p) => {
        const snap = snapshots.get(p.draft.id);
        return {
          id: snap.id,
          registerNo: p.no,
          slug: p.slug,
          updateTime: toBackupJson(snap.updateTime),
          data: toBackupJson(snap.data()),
        };
      }),
    };
    writeFileSync(backupPath, `${JSON.stringify(backup, null, 2)}\n`, { flag: 'wx' });
    // Read it back: a backup that cannot be parsed is not a backup.
    const check = JSON.parse(readFileSync(backupPath, 'utf8'));
    if (check.drafts.length !== plan.length) throw new Error('backup read-back count mismatch');
  } catch (error) {
    fail(`could not write the backup (${error.message}). Nothing written.`);
  }
  console.log(`\n  backup    ${backupPath}`);

  // ── write, one batch per animal ────────────────────────────────────────
  let done = 0;
  for (const p of plan) {
    const docs = buildPublishDocuments({
      draft: p.draft,
      slug: p.slug,
      status: 'available',
      speciesFallback: p.species,
      uid: operator.uid,
      now: FieldValue.serverTimestamp(),
      defaultAlt: es.defaultPhotoAlt,
    });
    if (docs.invalidChip) console.warn(`  ⚠ ${p.no} ${p.draft.name}: chip code does not validate; no identity document`);

    const petRef = db.collection('pets').doc(docs.petId);
    const batch = db.batch();
    batch.create(petRef, docs.pet);
    batch.set(petRef.collection('detail').doc('main'), docs.detail);
    for (const media of docs.media) batch.set(petRef.collection('media').doc(media.id), media.data);
    if (docs.identity) batch.set(petRef.collection('identity').doc('microchip'), docs.identity);
    batch.delete(db.collection('petDrafts').doc(p.draft.id), {
      lastUpdateTime: snapshots.get(p.draft.id).updateTime,
    });
    try {
      await batch.commit();
    } catch (error) {
      fail(`${p.no} ${p.draft.name}: ${error.message}. ${done} published before this; backup at ${backupPath}.`);
    }
    done += 1;
    console.log(`  ✓ ${String(p.no).padStart(3)} ${p.draft.name.trim()} → /adopt/${p.slug}`);
  }
  console.log(`\n  published ${done}. Roll back with: --hide ${backupPath}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rollback: take the pets in a backup off the wall
// ─────────────────────────────────────────────────────────────────────────────

function latestBackup() {
  let files = [];
  try {
    files = readdirSync(BACKUP_DIR).filter((f) => /^publish-backup-.*\.json$/.test(f)).sort();
  } catch {
    // no _local directory yet
  }
  if (files.length === 0) fail(`no publish-backup-*.json in ${BACKUP_DIR}`);
  return join(BACKUP_DIR, files[files.length - 1]);
}

async function hide(opts) {
  const path = opts.hide === 'latest' ? latestBackup() : resolve(opts.hide);
  let backup;
  try {
    backup = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`could not read ${path}: ${error.message}`);
  }
  if (backup?.kind !== 'publish-ready-drafts backup' || !Array.isArray(backup.drafts)) {
    fail(`${path} is not a publish-ready-drafts backup`);
  }
  if (backup.project !== project) fail(`backup is for project ${backup.project}, not ${project}`);

  console.log(`  backup    ${path}`);
  console.log(`  pets      ${backup.drafts.length}\n`);

  const targets = [];
  for (const item of backup.drafts) {
    const snap = await db.collection('pets').doc(item.id).get();
    const state = snap.exists ? snap.get('status') : 'missing';
    targets.push({ ...item, exists: snap.exists, status: state });
    console.log(`  ${String(item.registerNo).padStart(3)}  ${String(item.data?.name ?? '').padEnd(20)} ${item.id}  status now: ${state}`);
  }

  if (!opts.write) {
    console.log("\n  dry run: nothing written. Add --write to set status 'shelter' on these pets.\n");
    return;
  }

  let hidden = 0;
  for (const target of targets) {
    if (!target.exists) {
      console.warn(`  ⚠ ${target.id} does not exist; skipped`);
      continue;
    }
    await db.collection('pets').doc(target.id).update({
      status: 'shelter',
      updatedAt: FieldValue.serverTimestamp(),
    });
    hidden += 1;
  }
  console.log(`\n  hidden ${hidden} (status 'shelter'). Nothing was deleted.\n`);
}
