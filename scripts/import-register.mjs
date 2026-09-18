/**
 * Write the shelter's paper intake register into Firestore. 225 rows, once.
 *
 *   node --import tsx --env-file-if-exists=.env.local scripts/import-register.mjs
 *   node --import tsx --env-file-if-exists=.env.local scripts/import-register.mjs \
 *        --write --confirmed-by israel.rocha.rocha@live.com
 *
 * ═══ WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ═══════════════════════════
 * `src/lib/register-import.ts` decides WHAT should be written and this script
 * decides NOTHING. It loads the three extraction files, hands them to
 * `buildImportPlan`, refuses to run if the plan carries a blocker, and then
 * writes exactly what it was handed. Every judgement about a date nobody can
 * read, a species nobody photographed, or a column that must never be imported
 * lives in the planner, where it is covered by 60 tests and can be reasoned
 * about without a database.
 *
 * The consequence worth stating: if this script and the planner ever disagree
 * about what a document should contain, the planner is right and this file has
 * a bug. `toDocument()` below is built so that it cannot quietly invent, drop
 * or rename a field — see its comment.
 *
 * ═══ WHY DRY RUN IS THE DEFAULT ══════════════════════════════════════════════
 * This writes 225 documents into the live database of a real shelter, 43 of
 * which become the slots that this year's photographs attach to. There is no
 * staging copy of that database — this project deliberately does not run the
 * emulator suite — so the review has to happen against the plan rather than
 * against the result. A bare invocation prints the plan and writes nothing;
 * `--report` puts it in a file the shelter can read in Spanish; `--only`
 * imports two or three rows first so the shape can be checked in the admin UI
 * before the other 222 follow.
 *
 * ═══ THE FOUR REFUSALS ═══════════════════════════════════════════════════════
 *  1. A project that is not `wawitas`. The Admin SDK BYPASSES `firestore.rules`
 *     entirely, so a wrong project id is not caught by any security rule — it
 *     is caught here or not at all, and this machine carries two Google
 *     identities.
 *  2. Any blocker in the plan. That includes the planner's personal-data
 *     tripwire, which blocks rather than redacts precisely so a leaking
 *     extraction is reported instead of silently cleaned up.
 *  3. No `--confirmed-by`. Every medical record written here is stamped with
 *     the admin who vouches for the transcription, and `isConfirmed()` is
 *     literally "is `confirmedBy` non-empty" — so this stamp is what makes
 *     these records COUNT in `summarizeMedicalHistory` and `nextDue`. It is
 *     not a signature line; it is the switch that turns a transcription into
 *     clinical history. The account is checked for the `admin` custom claim
 *     before anything is written.
 *  4. A document that already exists. Everything is written with `.create()`,
 *     never `.set()` — see below.
 *
 * ═══ WHY `.create()` AND NEVER `.set()` ══════════════════════════════════════
 * A re-run must be able to finish an interrupted import without undoing a
 * person's work. By the time anyone re-runs this, a volunteer may have linked
 * `registerEntries/{no}.petId` to an animal, corrected a date on a medical
 * record, or added a photograph to a draft. `.set()` would revert all three
 * and report success. `.create()` fails loudly on an existing document, so the
 * script reads first, writes only what is genuinely missing, and REPORTS what
 * it left alone. Correcting a transcription therefore means `--delete --batch`
 * and a fresh run, which is a decision somebody makes rather than a side
 * effect of typing the same command twice.
 *
 * ═══ ONE BATCH PER ANIMAL ════════════════════════════════════════════════════
 * `registerEntries/{no}` → `petDrafts/{draftId}` → `pets/{draftId}/medical/{id}`
 * commit together, so an animal is all-or-nothing. A half-imported animal — a
 * draft with no register row, or a medical history under a draft that does not
 * exist — is not a state anyone should have to recognise later. 225 small
 * commits are slower than 3 large ones and that is the trade being made
 * deliberately: the unit of failure is the unit a person thinks in.
 *
 * ⚠️ The medical records are written under `pets/{draftId}/medical/` while
 * `pets/{draftId}` does NOT exist. That is intentional and it is how the whole
 * photo session works: the draft id IS the petId on publish, so when someone
 * photographs this animal and publishes it, the history is already sitting at
 * the right path. Firestore is happy to hold a subcollection under a missing
 * parent document.
 *
 * ═══ ROLLBACK ════════════════════════════════════════════════════════════════
 *   ... --delete --batch registro-2026-09-18            what it would remove
 *   ... --delete --batch registro-2026-09-18 --write    remove it
 *
 * It deletes only documents stamped with that batch, and refuses an animal
 * whose draft has photographs, whose pet document exists, or that carries a
 * medical record with no `importRef` — because all three mean a human has been
 * here since. `--force` overrides, one animal at a time in the report.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';

import {
  BOLIVIA_UTC_OFFSET_HOURS,
  buildImportPlan,
  looksLikePersonalContact,
} from '../src/lib/register-import.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * ⚠️ Hardcoded, and not a variable a caller can set.
 *
 * `seed-pet.mjs` accepts whatever `GOOGLE_CLOUD_PROJECT` says because it is
 * part of the forkable template — another shelter runs it against their own
 * project. This script is not that. It transcribes ONE shelter's paper
 * register, from three files that exist only on this machine, and its single
 * worst failure is writing them into the employer's project because a terminal
 * still had the other identity's environment. An allowlist of one is the only
 * guard that catches it, because the Admin SDK answers to no security rule.
 *
 * A fork importing its own register edits this line, which is a deliberate act.
 */
const EXPECTED_PROJECT = 'wawitas';

/** Where the three extraction files live. Gitignored; never committed. */
const DEFAULT_DATA_DIR = join(REPO_ROOT, '_local', 'registro');

const DATA_FILES = {
  rows: 'registro-225-rows.json',
  normalized: 'registro-225-normalizado.json',
  medical: 'medico-43-actuales.json',
};

// ─────────────────────────────────────────────────────────────────────────────
// Output
//
// The console speaks ENGLISH and `--report` speaks SPANISH, which is the
// project's standing convention arriving in a new place: the console is read by
// whoever is running the import, and the report is read by the shelter.
// ─────────────────────────────────────────────────────────────────────────────

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

/**
 * Every flag, with the reasoning that is load-bearing rather than the reasoning
 * that is merely true.
 *
 * Written out in full because the dangerous flags here are dangerous in ways
 * their names do not convey: `--write` is irreversible without `--delete`,
 * `--force` overrides a refusal that exists to protect a volunteer's work, and
 * `--today` moves the line between "a date in the register" and "a date in the
 * future". A help text that only lists the flags would document the safe ones.
 */
const HELP = `
  Write the shelter's paper intake register into Firestore. Dry run by default.

  node --import tsx --env-file-if-exists=.env.local scripts/import-register.mjs [flags]

  IMPORT
    (no flags)            build the plan, check it, print it. Writes NOTHING.
    --write               perform it. Needs --confirmed-by.
    --confirmed-by <email>
                          the admin who vouches for the transcription. Stamped on
                          every medical record as confirmedBy/recordedBy, and
                          isConfirmed() is "confirmedBy is non-empty" — so this is
                          what makes a transcribed vaccination count towards the
                          next-due arithmetic. The account is checked for the
                          admin claim before anything is written.
    --only <n>[,<n>]      import only these register numbers. Run a canary of two
                          or three and look at them in /admin before the rest.
    --batch <id>          the rollback key. Defaults to registro-<today>.
    --report <path>       write the plan as Spanish prose the shelter can read.
                          Put it under _local/ — it names every animal they hold.
    --today <YYYY-MM-DD>  the cut-off a "future" date is judged against.
                          Defaults to today in Bolivia, NOT this machine's date.
    --data <dir>          where the three extraction files live.
                          Defaults to _local/registro/.

  ROLLBACK
    --delete --batch <id>             what it would remove. Writes nothing.
    --delete --batch <id> --write     remove it.
    --force                           also remove animals a person has touched
                                      since — photographs on the draft, a
                                      published pet, or a medical record with no
                                      importRef. Read the refusal list first.

  Refuses unless GOOGLE_CLOUD_PROJECT=wawitas: the Admin SDK bypasses
  firestore.rules, so a wrong project is caught here or nowhere.
`;

function help() {
  console.log(HELP);
  process.exit(0);
}

function usage(message) {
  console.error(`\n  ✗ ${message}\n`);
  console.error('  node --import tsx scripts/import-register.mjs [--write] [--only 1,2]');
  console.error('       [--batch <id>] [--confirmed-by <email>] [--report <path>]');
  console.error('  node --import tsx scripts/import-register.mjs --delete --batch <id> [--write] [--force]');
  console.error('  node --import tsx scripts/import-register.mjs --help\n');
  process.exit(2);
}

/**
 * Refuse to print or file anything that looks like somebody's phone number or
 * front door.
 *
 * The planner already ran its tripwire over the plan, and this is the second
 * layer it asks for in `looksLikePersonalContact`'s own comment: everything
 * this script COMPOSES on top of the plan — report lines, summaries, progress
 * output — goes through here. It blocks rather than redacting, for the same
 * reason the planner does: a scrubbed line looks fine and tells nobody that
 * the extraction is leaking a column it was told to leave alone.
 */
function safe(label, text) {
  if (looksLikePersonalContact(text)) {
    fail(
      `${label} contains something that looks like personal contact data and was NOT printed or written.\n` +
        '    This is a bug in the extraction or in this script, not a formatting problem.\n' +
        '    Nothing was written to Firestore.',
    );
  }
  return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// Time
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Today in Bolivia, as `YYYY-MM-DD`.
 *
 * Deliberately not the machine's local date. The planner judges "is this date
 * in the future?" against this string, and CI runs in UTC while this machine
 * does not — a register row dated today must not be importable in one place
 * and refused in the other.
 */
function boliviaToday() {
  const local = new Date(Date.now() - BOLIVIA_UTC_OFFSET_HOURS * 3_600_000);
  return local.toISOString().slice(0, 10);
}

/**
 * An epoch millisecond back as the Bolivian calendar day that produced it,
 * `DD/MM/YYYY` — the way the register itself writes a date.
 *
 * This is the read-back check that matters most. `boliviaNoonMs` turns
 * "18/10/25" into an instant using UTC arithmetic; this turns the instant
 * Firestore actually stored back into a day. If the two ever disagree, every
 * imported date is off by one and nothing else in the verification would show
 * it — a Timestamp that reads back unchanged proves the round trip, not the
 * arithmetic.
 */
function bolivianDay(ms) {
  const local = new Date(ms - BOLIVIA_UTC_OFFSET_HOURS * 3_600_000);
  const day = String(local.getUTCDate()).padStart(2, '0');
  const month = String(local.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${local.getUTCFullYear()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ids
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The draft id for a register row — deterministic, and deliberately NOT keyed
 * on the batch.
 *
 * The draft id becomes the petId on publish, so it is also the Storage prefix
 * the photo session uploads into. Two properties follow from being
 * deterministic. A run interrupted halfway can be resumed, because the second
 * run computes the same ids and finds the documents it already wrote. And a
 * SECOND import of the same register — a corrected transcription under a new
 * batch name — collides with the first rather than quietly producing 43 more
 * drafts for the same 43 animals. Colliding is the safe outcome: `.create()`
 * refuses and the run reports it, instead of the roster showing every resident
 * twice on the day somebody is standing in front of one with a camera.
 *
 * The register number is in the id in the clear, which adds nothing an
 * onlooker cannot already have: `Pet.registerNo` is on the PUBLIC tier by
 * design (it is an ordinal, and it is the only thing that separates n.º 215
 * "Dana" from n.º 216 "Duna"), and `match /pets/{petId}` allows `list`, so the
 * collection is enumerable regardless. The suffix exists so an id cannot be
 * typed by accident, not to hide anything.
 *
 * ⚠️ THE SUFFIX IS LETTERS ONLY, AND THAT IS NOT COSMETIC. The first version
 * of this function used eight hex characters, and the planner's personal-data
 * tripwire BLOCKED the whole import on register n.º 193: its id came out
 * `reg193-78154965`, and eight digits beginning with a 7 is a Bolivian mobile
 * number as far as any pattern can tell. The tripwire was right to refuse —
 * a rule that has to know which eight-digit runs are "ours" is a rule that
 * stops working the day somebody adds a field. So the ids are drawn from an
 * alphabet that cannot produce a run of digits at all, and the guard stays
 * blunt. `l` is left out so an id read off a screen cannot be typed as a 1.
 */
const ID_ALPHABET = 'abcdefghijkmnopqrstuvwxyz';

function draftIdFor(registerNo) {
  const digest = createHash('sha256').update(`wawitas-register-draft:${registerNo}`).digest();
  let suffix = '';
  for (let i = 0; i < 8; i += 1) suffix += ID_ALPHABET[digest[i] % ID_ALPHABET.length];
  return `reg${String(registerNo).padStart(3, '0')}-${suffix}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan → document
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Turn one planned object into the document Firestore stores.
 *
 * ⚠️ THE POINT OF THIS FUNCTION IS THAT IT CANNOT SILENTLY DROP A FIELD. It
 * copies every key it is given rather than listing the ones it knows about, so
 * a field added to `RegisterEntry` or `MedicalRecord` flows through on its own;
 * and it FAILS on any `…Ms` key it has not been told how to convert, so a new
 * date field cannot arrive as a bare number that looks like a Timestamp to
 * nobody and sorts like a string to Firestore.
 *
 * This is the 2026-08-26 lesson written as code rather than as a comment:
 * `batch.set(petRef, {…})` took an untyped object literal, so adding a required
 * field to `Pet` produced a green typecheck and a document without it. A `.mjs`
 * script has no typecheck at all, so the guard has to be a runtime one.
 */
function toDocument(source, msFields, extra) {
  const out = {};

  for (const [key, value] of Object.entries(source)) {
    if (/Ms$/.test(key)) {
      const stored = msFields[key];
      if (!stored) {
        fail(
          `The plan carries a date field this script does not know how to store: ${key}.\n` +
            `    Add it to the msFields map in import-register.mjs. Nothing was written.`,
        );
      }
      out[stored] = value === null || value === undefined ? null : Timestamp.fromMillis(value);
      continue;
    }
    out[key] = value;
  }

  for (const [key, value] of Object.entries(extra)) {
    // An `extra` that lands on a key the plan already set would mean the
    // script is overriding a decision the planner made — which is exactly the
    // thing this file is not allowed to do.
    if (key in out) {
      fail(`${key} is set by both the plan and this script. Refusing to guess which wins.`);
    }
    out[key] = value;
  }

  return out;
}

/**
 * The field names an interface declares, read out of the TypeScript source.
 *
 * `seed-pet.mjs` does the same thing for the stored enums and for the same
 * reason: a `.mjs` script writing a typed document has no typecheck between it
 * and the interface, so the only place the two can be held together is at
 * runtime. Returns null when the parser cannot find the interface, which the
 * caller treats as a FAILURE rather than as "nothing to check" — a guard that
 * quietly turns itself off reads as a passing check forever.
 */
function declaredFields(source, name) {
  const start = source.indexOf(`export interface ${name} {`);
  if (start < 0) return null;
  const end = source.indexOf('\n}', start);
  if (end < 0) return null;

  // Exactly two spaces of indent is a top-level member; JSDoc lines start with
  // `  *` or more indent, and nested object types are written on one line in
  // both of these files.
  const fields = [...source.slice(start, end).matchAll(/^ {2}(\w+)(\??):/gm)].map(([, field, optional]) => ({
    field,
    optional: optional === '?',
  }));
  return fields.length === 0 ? null : fields;
}

/**
 * Assert that a document this script assembled carries exactly the fields its
 * interface declares — no missing required field, no field nobody declared.
 *
 * ⚠️ This is the 2026-08-26 defect turned into a check. `batch.set(petRef, {…})`
 * took an untyped object literal, so adding a REQUIRED field to `Pet` produced
 * a green typecheck and a document without it: the interface described a
 * document the writer did not produce. Here the writer is a `.mjs` file, so
 * there is no typecheck to be green in the first place.
 */
function assertDocumentShape(label, document, interfaceName, sourcePath, allowExtra = []) {
  const source = readFileSync(join(REPO_ROOT, sourcePath), 'utf8');
  const declared = declaredFields(source, interfaceName);

  if (!declared || declared.length < 10) {
    fail(
      `Could not read "export interface ${interfaceName}" out of ${sourcePath}.\n` +
        '    This script\'s document-shape check is therefore not checking anything.\n' +
        '    Fix declaredFields() in import-register.mjs before importing.',
    );
  }

  const present = new Set(Object.keys(document));
  const allowed = new Set([...declared.map((d) => d.field), ...allowExtra]);

  const missing = declared.filter((d) => !d.optional && !present.has(d.field)).map((d) => d.field);
  const unexpected = [...present].filter((key) => !allowed.has(key));

  if (missing.length > 0 || unexpected.length > 0) {
    fail(
      `The ${label} document does not match ${interfaceName} in ${sourcePath}.\n` +
        (missing.length > 0 ? `    missing   : ${missing.join(', ')}\n` : '') +
        (unexpected.length > 0 ? `    unexpected: ${unexpected.join(', ')}\n` : '') +
        '    Nothing was written. The plan and the interface have drifted apart.',
    );
  }
}

const ENTRY_DATE_FIELDS = {
  intakeDateMs: 'intakeDate',
  statusDateMs: 'statusDate',
  lastRecordedDateMs: 'lastRecordedDate',
};

const MEDICAL_DATE_FIELDS = {
  performedAtMs: 'performedAt',
  nextDueAtMs: 'nextDueAt',
  validFromMs: 'validFrom',
  validUntilMs: 'validUntil',
  extractedAtMs: 'extractedAt',
};

// The three builders below are the ONLY places a document is assembled, so the
// shape check and the write can never be checking different objects.

function entryDocument(entry) {
  return toDocument(entry.data, ENTRY_DATE_FIELDS, {
    importedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

function draftDocument(draft) {
  // A draft carries no Timestamps of its own — `PetDraft` is plain
  // serialisable values on purpose — and `updatedAt` is added exactly as
  // `saveDraft()` adds it, because `loadDraft()` strips that one field and
  // `listDrafts()` sorts on it. A draft without it still sorts, but last.
  return toDocument(draft.data, {}, { updatedAt: FieldValue.serverTimestamp() });
}

function medicalDocument(record, confirmedBy) {
  return toDocument(record.data, MEDICAL_DATE_FIELDS, {
    id: record.id,
    // See the header: this stamp is not ceremonial. `isConfirmed()` is
    // "confirmedBy is non-empty", so it is what makes a transcribed
    // vaccination count towards the next-due arithmetic.
    confirmedBy,
    confirmedAt: FieldValue.serverTimestamp(),
    recordedBy: confirmedBy,
  });
}

/**
 * Build one of each document and hold it against its interface.
 *
 * Runs on every invocation, dry run included, because the dry run is the
 * review step — a shape problem found only at `--write` is found with a
 * finger already on the trigger.
 */
function assertShapes(animals, confirmedBy) {
  const entry = animals.find((a) => a.entry);
  const draft = animals.find((a) => a.draft);
  const record = animals.find((a) => a.medical.length > 0);

  if (entry) assertDocumentShape('register entry', entryDocument(entry.entry), 'RegisterEntry', 'src/lib/types.ts');
  if (draft) assertDocumentShape('draft', draftDocument(draft.draft), 'PetDraft', 'src/lib/intake.ts', ['updatedAt']);
  if (record) {
    assertDocumentShape(
      'medical record',
      // The placeholder never reaches Firestore: this object is built to be
      // measured and thrown away, and the real write passes the verified admin.
      medicalDocument(record.medical[0], confirmedBy ?? 'shape-check@example.invalid'),
      'MedicalRecord',
      'src/lib/types.ts',
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Arguments
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const known = new Set([
    '--write',
    '--delete',
    '--force',
    '--only',
    '--batch',
    '--confirmed-by',
    '--report',
    '--today',
    '--data',
    '--help',
  ]);

  const out = {
    write: false,
    remove: false,
    force: false,
    only: null,
    batch: null,
    confirmedBy: null,
    report: null,
    today: null,
    data: DEFAULT_DATA_DIR,
  };

  // Answered before anything else is parsed, and before `main` checks the
  // project: somebody reaching for `--help` is asking what this does, which is
  // exactly the moment they should not be told to go and set an environment
  // variable first.
  if (argv.includes('--help') || argv.includes('-h')) help();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) usage(`Unexpected argument ${JSON.stringify(arg)}.`);
    if (!known.has(arg)) usage(`Unknown flag ${arg}.`);

    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) usage(`${arg} needs a value.`);
      i += 1;
      return next;
    };

    if (arg === '--write') out.write = true;
    else if (arg === '--delete') out.remove = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--batch') out.batch = value();
    else if (arg === '--confirmed-by') out.confirmedBy = value();
    else if (arg === '--report') out.report = value();
    else if (arg === '--today') out.today = value();
    else if (arg === '--data') out.data = resolve(process.cwd(), value());
    else if (arg === '--only') {
      const numbers = value()
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '');
      const parsed = numbers.map((part) => {
        if (!/^\d+$/.test(part)) usage(`--only takes register numbers, got ${JSON.stringify(part)}.`);
        return Number(part);
      });
      if (parsed.length === 0) usage('--only needs at least one register number.');
      out.only = new Set(parsed);
    }
  }

  if (out.remove && !out.batch) usage('--delete needs --batch <id>: it is the rollback key.');
  if (out.remove && out.only) usage('--delete and --only cannot be combined.');
  if (out.force && !out.remove) usage('--force only applies to --delete.');

  // Checked here rather than at the write itself, so a missing flag costs a
  // second instead of a full plan build. The claim behind the email is still
  // verified later, against the project, just before anything is written.
  if (out.write && !out.remove && !out.confirmedBy) {
    usage(
      '--write needs --confirmed-by <email>.\n' +
        '    Every medical record is stamped with it, and isConfirmed() is "confirmedBy is\n' +
        '    non-empty" — so this is what makes a transcribed vaccination count towards the\n' +
        '    next-due arithmetic. It names the admin who vouches for the transcription.',
    );
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The Spanish report
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The six `RegisterStatus` values in Spanish, for the report only.
 *
 * ⚠️ Deliberately NOT in `src/i18n`, which is the project's rule for
 * visitor-facing language. Nothing a visitor reads renders a register status —
 * `registerEntries` is admin-only for READ as well as write — and these six
 * words exist for one operational document that a volunteer reads once beside
 * the paper it came from. Putting them in the site's catalogue would ship them
 * in a bundle that has no screen for them. Same reasoning as the Spanish in
 * `register-import.ts`: this is content, not UI chrome.
 */
const STATUS_ES = {
  'in-shelter': 'siguen en el refugio',
  adopted: 'adoptados',
  returned: 'devueltos',
  died: 'fallecidos',
  transferred: 'entregados a otra persona',
  unknown: 'sin dato',
};

/**
 * One animal's medical history grouped by treatment, the way a vaccination
 * card is laid out, with the dates in order.
 *
 * A flat list of ten dates is technically the same information and useless for
 * the thing a person actually asks it — "has this dog had its second
 * octavalent?" — which is a question about one row, not about ten records.
 */
function formatMedicalGroups(records) {
  const groups = new Map();
  for (const record of records) {
    if (!groups.has(record.data.name)) groups.set(record.data.name, []);
    groups.get(record.data.name).push(record.data.performedAtMs);
  }

  const width = Math.max(...[...groups.keys()].map((name) => name.length));
  return [...groups.entries()].map(
    ([name, days]) =>
      `${name.padEnd(width)}  ${days.sort((a, b) => a - b).map(bolivianDay).join(' · ')}`,
  );
}

/**
 * The plan as something the shelter can read and argue with.
 *
 * Spanish, neutral, third person: it describes a document, it does not address
 * anyone. Every line goes through `safe()` before it reaches the file.
 */
function buildReport(plan, options) {
  const lines = [];
  const push = (line = '') => lines.push(line);

  push('INFORME DE IMPORTACIÓN DEL REGISTRO EN PAPEL');
  push('='.repeat(60));
  push(`Lote          : ${plan.batch}`);
  push(`Fecha de corte: ${options.today} (hora de Bolivia)`);
  push(`Proyecto      : ${options.project}`);
  push(`Estado        : ${options.write ? 'ESCRITO' : 'SIMULACIÓN (no se escribió nada)'}`);
  if (options.only) {
    push(`Solo filas    : ${[...options.only].sort((a, b) => a - b).join(', ')}`);
  }
  push();

  push('RESUMEN');
  push(`  Filas del registro                 ${plan.stats.entries}`);
  for (const [status, count] of Object.entries(plan.stats.byStatus).sort()) {
    push(`    ${(STATUS_ES[status] ?? status).padEnd(31)}${count}`);
  }
  push(`  Fichas creadas (siguen en refugio) ${plan.stats.drafts}`);
  push(`  Registros médicos transcritos      ${plan.stats.medical}`);
  push(`  Datos que no se importaron         ${plan.stats.skipped}`);
  push();
  push('  El estado de cada fila viene del color con que se pintó en la planilla,');
  push('  no de un conteo. Por eso ninguna fila queda marcada como confirmada: solo');
  push('  una persona que vea al animal puede confirmarlo.');
  push();

  push('QUÉ NO HACE ESTA IMPORTACIÓN');
  push('  • No inventa fechas. Una celda que nadie puede leer se queda sin');
  push('    importar y su texto original queda anotado en la ficha del animal.');
  push('  • No adivina especie, color, tamaño ni edad. Esos campos quedan');
  push('    VACÍOS a propósito: la sesión de fotos los completa, y el asistente');
  push('    del formulario solo ofrece un valor cuando el campo está vacío.');
  push('  • No publica a nadie en el muro. Las 43 fichas quedan en «refugio».');
  push('  • No importa la columna de adoptantes.');
  push();

  const medicalByNo = new Map();
  for (const record of plan.medical) {
    if (!medicalByNo.has(record.no)) medicalByNo.set(record.no, []);
    medicalByNo.get(record.no).push(record);
  }

  push(`ANIMALES QUE SIGUEN EN EL REFUGIO (${plan.drafts.length})`);
  push('-'.repeat(60));
  for (const draft of plan.drafts) {
    const entry = plan.entries.find((e) => e.no === draft.no);
    const name = draft.data.name || '(sin nombre en el registro)';
    const sex = draft.data.sex === 'female' ? 'hembra' : draft.data.sex === 'male' ? 'macho' : 'sexo sin anotar';
    // When the register gives no exact day, the cell is quoted verbatim rather
    // than summarised — "2020 DE 8 ANOS" is what the paper says, and the only
    // person who can turn that into a date is someone holding the paper.
    const intake = entry?.data.intakeDateMs
      ? `ingreso ${bolivianDay(entry.data.intakeDateMs)}`
      : `ingreso «${entry?.data.intakeRaw || 'sin dato'}» (sin fecha exacta)`;

    push(`  n.º ${String(draft.no).padStart(3)} · ${name} · ${sex} · ${intake}`);
    push(`      ficha       : ${draft.id}`);

    const records = medicalByNo.get(draft.no) ?? [];
    if (records.length === 0) {
      push('      médico      : sin registros con fecha exacta');
    } else {
      push(`      médico      : ${records.length} registro(s)`);
      for (const line of formatMedicalGroups(records)) push(`        ${line}`);
    }
    if (draft.data.sterilized) push('      esterilizado: sí, según el registro');
    if (entry?.data.responsible) push(`      responsable : ${entry.data.responsible}`);
    if (draft.data.healthNotes) {
      for (const note of draft.data.healthNotes.split('\n')) push(`      nota        : ${note}`);
    }
    push();
  }

  push(`DATOS QUE NO SE IMPORTARON (${plan.skipped.length})`);
  push('-'.repeat(60));
  push('El papel sigue diciendo que esto ocurrió. Queda anotado en la ficha del');
  push('animal, con el texto de la celda tal cual, para que el refugio lo resuelva.');
  push();
  for (const item of plan.skipped) {
    push(`  n.º ${String(item.no).padStart(3)} · ${item.what} «${item.raw}» — ${item.why}`);
  }
  push();

  push('QUÉ SIGUE');
  push('  1. Revisar este informe con el refugio.');
  push('  2. Fotografiar a los animales que siguen en el refugio desde');
  push('     /admin/intake, abriendo la ficha que ya existe para cada uno.');
  push('  3. Confirmar en cada ficha que el animal de la foto es el de esa fila');
  push('     del registro. Hasta entonces el vínculo queda como «provisional».');
  push();

  return lines.map((line, index) => safe(`report line ${index + 1}`, line)).join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

/** `getAll` in chunks, because it is one round trip either way but has limits. */
async function readAll(db, refs, size = 250) {
  const out = [];
  for (let i = 0; i < refs.length; i += size) {
    const chunk = refs.slice(i, i + size);
    if (chunk.length === 0) continue;
    out.push(...(await db.getAll(...chunk)));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Group the plan by register number, so that one animal is one unit of work —
 * one read, one batch, one line in the report, one thing that can fail.
 */
function groupByAnimal(plan, only) {
  const animals = new Map();

  const take = (no) => {
    if (!animals.has(no)) animals.set(no, { no, entry: null, draft: null, medical: [] });
    return animals.get(no);
  };

  for (const entry of plan.entries) {
    if (only && !only.has(entry.no)) continue;
    take(entry.no).entry = entry;
  }
  for (const draft of plan.drafts) {
    if (only && !only.has(draft.no)) continue;
    take(draft.no).draft = draft;
  }
  for (const record of plan.medical) {
    if (only && !only.has(record.no)) continue;
    take(record.no).medical.push(record);
  }

  return [...animals.values()].sort((a, b) => a.no - b.no);
}

async function runImport(db, plan, animals, options) {
  // ── read everything first, so `.create()` is a guard and not the plan ──────
  const entryRefs = animals.filter((a) => a.entry).map((a) => db.collection('registerEntries').doc(a.entry.id));
  const draftRefs = animals.filter((a) => a.draft).map((a) => db.collection('petDrafts').doc(a.draft.id));
  const medicalRefs = animals.flatMap((a) =>
    a.medical.map((record) => db.collection('pets').doc(record.petId).collection('medical').doc(record.id)),
  );

  const existing = new Set();
  for (const snap of await readAll(db, [...entryRefs, ...draftRefs, ...medicalRefs])) {
    if (snap.exists) existing.add(snap.ref.path);
  }

  const outcome = { written: 0, skipped: 0, failed: 0, records: 0, untouched: [] };

  let index = 0;
  for (const animal of animals) {
    index += 1;

    const batch = db.batch();
    let writes = 0;
    const left = [];

    if (animal.entry) {
      const ref = db.collection('registerEntries').doc(animal.entry.id);
      if (existing.has(ref.path)) left.push('register row');
      else {
        batch.create(ref, entryDocument(animal.entry));
        writes += 1;
      }
    }

    if (animal.draft) {
      const ref = db.collection('petDrafts').doc(animal.draft.id);
      if (existing.has(ref.path)) left.push('draft');
      else {
        batch.create(ref, draftDocument(animal.draft));
        writes += 1;
      }
    }

    let records = 0;
    for (const record of animal.medical) {
      const ref = db.collection('pets').doc(record.petId).collection('medical').doc(record.id);
      if (existing.has(ref.path)) {
        left.push(`medical ${record.id}`);
        continue;
      }
      batch.create(ref, medicalDocument(record, options.confirmedBy));
      writes += 1;
      records += 1;
    }

    if (left.length > 0) outcome.untouched.push({ no: animal.no, left });

    if (writes === 0) {
      outcome.skipped += 1;
      continue;
    }

    try {
      await batch.commit();
      outcome.written += 1;
      outcome.records += records;
    } catch (error) {
      outcome.failed += 1;
      console.error(`  ✗ n.º ${animal.no} failed: ${error?.code ?? error?.message ?? error}`);
    }

    if (index % 25 === 0 || index === animals.length) {
      console.log(`  … ${index}/${animals.length} animals`);
    }
  }

  return outcome;
}

/**
 * Read back what was written and check it against the plan.
 *
 * Counts alone would pass while every date was a day out, so the last check is
 * the one that matters: one stored `performedAt` is turned back into a
 * Bolivian calendar day and printed beside the cell the register actually
 * wrote, for a person to compare.
 */
async function verify(db, plan, animals, options) {
  console.log('\n── read back ──');

  const problems = [];

  const entrySnap = await db.collection('registerEntries').where('importBatch', '==', plan.batch).get();
  const byStatus = {};
  for (const doc of entrySnap.docs) {
    const status = doc.get('status');
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }
  console.log(`  registerEntries with importBatch=${plan.batch}: ${entrySnap.size}`);
  for (const [status, count] of Object.entries(byStatus).sort()) {
    console.log(`    ${status.padEnd(14)} ${count}`);
  }

  const expectedEntries = animals.filter((a) => a.entry).length;
  if (entrySnap.size < expectedEntries) {
    problems.push(`expected at least ${expectedEntries} register entries, read back ${entrySnap.size}`);
  }
  if (!options.only) {
    for (const [status, count] of Object.entries(plan.stats.byStatus)) {
      if ((byStatus[status] ?? 0) !== count) {
        problems.push(`status ${status}: plan says ${count}, read back ${byStatus[status] ?? 0}`);
      }
    }
  }

  const draftSnap = await db.collection('petDrafts').where('register.batch', '==', plan.batch).get();
  console.log(`  petDrafts with register.batch=${plan.batch}: ${draftSnap.size}`);
  const expectedDrafts = animals.filter((a) => a.draft).length;
  if (draftSnap.size < expectedDrafts) {
    problems.push(`expected at least ${expectedDrafts} drafts, read back ${draftSnap.size}`);
  }

  // Medical per animal, read from the subcollection rather than through a
  // collection-group query. ⚠️ A `collectionGroup('medical')` filtered on
  // `importRef.batch` would need that field given COLLECTION_GROUP scope in
  // `firestore.indexes.json` — the same field-override the microchip lookup
  // needs — and it does not have one. The query would fail loudly rather than
  // silently, but a verification step that cannot run is not a verification.
  let totalRecords = 0;
  let sample = null;
  for (const animal of animals) {
    if (animal.medical.length === 0) continue;
    const petId = animal.medical[0].petId;
    const snap = await db.collection('pets').doc(petId).collection('medical').get();
    const mine = snap.docs.filter((doc) => doc.get('importRef')?.batch === plan.batch);
    totalRecords += mine.length;
    if (mine.length !== animal.medical.length) {
      problems.push(`n.º ${animal.no}: plan has ${animal.medical.length} medical records, read back ${mine.length}`);
    }
    if (!sample && mine.length > 0) sample = { no: animal.no, doc: mine[0] };
  }
  console.log(`  medical records with importRef.batch=${plan.batch}: ${totalRecords}`);

  if (sample) {
    const data = sample.doc.data();
    const performedAt = data.performedAt;
    const raw = data.importRef?.raw ?? '(no raw)';
    const day = performedAt?.toMillis ? bolivianDay(performedAt.toMillis()) : '(not a Timestamp)';

    console.log('\n  one record, round-tripped:');
    console.log(safe('sample record', `    n.º ${sample.no}  ${sample.doc.id}  ${data.name}`));
    console.log(safe('sample dates', `    register cell «${raw}»  →  stored  ${day}  (Bolivian day)`));

    if (!performedAt?.toMillis) problems.push('performedAt did not read back as a Timestamp');
    if (typeof data.confirmedBy !== 'string' || data.confirmedBy.trim() === '') {
      problems.push('confirmedBy is empty on a written record — isConfirmed() would refuse it');
    }
    if (typeof data.recordedBy !== 'string' || data.recordedBy.trim() === '') {
      problems.push('recordedBy is empty on a written record');
    }
    if (!data.confirmedAt) problems.push('confirmedAt is missing on a written record');
  } else if (animals.some((a) => a.medical.length > 0)) {
    problems.push('no medical record could be read back to sample');
  }

  return problems;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rollback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove exactly what one batch wrote — and refuse an animal a person has
 * touched since.
 *
 * Three signs that somebody has been here: the draft has photographs, the pet
 * document exists (it was published), or a medical record under it carries no
 * `importRef` (a human typed it). Any of those and the whole animal is left
 * alone, because deleting its register row while its photographs stay would
 * leave a pet nobody can trace back to the paper it came from.
 */
async function runDelete(db, options) {
  const batchId = options.batch;

  const entrySnap = await db.collection('registerEntries').where('importBatch', '==', batchId).get();
  const draftSnap = await db.collection('petDrafts').where('register.batch', '==', batchId).get();

  console.log(`\n  batch    : ${batchId}`);
  console.log(`  entries  : ${entrySnap.size}`);
  console.log(`  drafts   : ${draftSnap.size}`);

  const refusals = [];
  const targets = [];

  for (const draft of draftSnap.docs) {
    const petId = draft.id;
    const no = draft.get('register')?.no ?? null;
    const reasons = [];

    const media = draft.get('media');
    if (Array.isArray(media) && media.length > 0) reasons.push(`${media.length} photo(s) on the draft`);

    const pet = await db.collection('pets').doc(petId).get();
    if (pet.exists) reasons.push('the pet is already published');

    const medical = await db.collection('pets').doc(petId).collection('medical').get();
    const handTyped = medical.docs.filter((doc) => !doc.get('importRef'));
    if (handTyped.length > 0) reasons.push(`${handTyped.length} medical record(s) with no importRef`);

    const mine = medical.docs.filter((doc) => doc.get('importRef')?.batch === batchId);

    if (reasons.length > 0 && !options.force) {
      refusals.push({ no, petId, reasons });
      continue;
    }
    targets.push({ no, petId, draftRef: draft.ref, medicalRefs: mine.map((doc) => doc.ref), forced: reasons });
  }

  const refusedNumbers = new Set(refusals.map((r) => r.no));
  const entryTargets = entrySnap.docs.filter((doc) => !refusedNumbers.has(doc.get('no')));

  console.log(`\n  would delete:`);
  console.log(`    ${entryTargets.length} register entries`);
  console.log(`    ${targets.length} drafts`);
  console.log(`    ${targets.reduce((n, t) => n + t.medicalRefs.length, 0)} medical records`);

  if (refusals.length > 0) {
    console.log(`\n  REFUSED — a person has been here since (${refusals.length}):`);
    for (const refusal of refusals) {
      console.log(`    n.º ${refusal.no} (${refusal.petId}): ${refusal.reasons.join('; ')}`);
    }
    console.log('    Their register rows are kept too, so nothing is left orphaned.');
    console.log('    --force overrides this. Read the list above before you do.');
  }
  for (const target of targets.filter((t) => t.forced.length > 0)) {
    console.log(`  ⚠ FORCED n.º ${target.no}: ${target.forced.join('; ')}`);
  }

  if (!options.write) {
    console.log('\n  ✔ dry run — nothing deleted. Add --write to perform it.\n');
    return 0;
  }

  let deleted = 0;
  for (const target of targets) {
    const batch = db.batch();
    for (const ref of target.medicalRefs) batch.delete(ref);
    batch.delete(target.draftRef);
    await batch.commit();
    deleted += 1;
  }

  for (let i = 0; i < entryTargets.length; i += 400) {
    const batch = db.batch();
    for (const doc of entryTargets.slice(i, i + 400)) batch.delete(doc.ref);
    await batch.commit();
  }

  console.log(`\n  deleted ${entryTargets.length} entries and ${deleted} animals' drafts + records`);

  // ── read back zero ────────────────────────────────────────────────────────
  const leftovers = [];
  const entriesAfter = await db.collection('registerEntries').where('importBatch', '==', batchId).get();
  const expectedEntriesLeft = refusals.length;
  if (entriesAfter.size !== expectedEntriesLeft) {
    leftovers.push(`registerEntries: ${entriesAfter.size} left, expected ${expectedEntriesLeft}`);
  }
  const draftsAfter = await db.collection('petDrafts').where('register.batch', '==', batchId).get();
  if (draftsAfter.size !== refusals.length) {
    leftovers.push(`petDrafts: ${draftsAfter.size} left, expected ${refusals.length}`);
  }
  for (const target of targets) {
    const snap = await db.collection('pets').doc(target.petId).collection('medical').get();
    const mine = snap.docs.filter((doc) => doc.get('importRef')?.batch === batchId);
    if (mine.length > 0) leftovers.push(`pets/${target.petId}/medical: ${mine.length} left`);
  }

  if (leftovers.length > 0) {
    console.error(`\n  ✗ READBACK FOUND LEFTOVERS: ${leftovers.join(', ')}\n`);
    return 1;
  }
  console.log('  readback: nothing from this batch is left, except the refused animals above\n');
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
  if (project !== EXPECTED_PROJECT) {
    fail(
      `GOOGLE_CLOUD_PROJECT is ${JSON.stringify(project ?? null)}, not ${JSON.stringify(EXPECTED_PROJECT)}.\n` +
        '    The Admin SDK bypasses firestore.rules, so nothing downstream would catch a\n' +
        '    wrong project — and this machine carries two Google identities. Refusing.',
    );
  }

  const today = options.today ?? boliviaToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) usage(`--today must be YYYY-MM-DD, got ${JSON.stringify(today)}.`);

  if (!getApps().length) initializeApp({ projectId: project });
  const db = getFirestore();

  console.log(`\n  project    : ${project}`);
  console.log(`  mode       : ${options.remove ? 'DELETE' : 'IMPORT'} ${options.write ? '(WRITING)' : '(dry run)'}`);

  if (options.remove) {
    process.exit(await runDelete(db, options));
  }

  // ── load the extraction ───────────────────────────────────────────────────
  const files = {};
  for (const [key, name] of Object.entries(DATA_FILES)) {
    const path = join(options.data, name);
    if (!existsSync(path)) {
      fail(
        `Missing ${path}.\n` +
          '    The three extraction files are gitignored and live only on the machine that\n' +
          '    produced them. Point --data at the directory that holds them.',
      );
    }
    files[key] = JSON.parse(readFileSync(path, 'utf8'));
  }

  const batchId = options.batch ?? `registro-${today}`;
  console.log(`  batch      : ${batchId}`);
  console.log(`  today      : ${today} (Bolivia)`);
  console.log(`  data       : ${options.data}\n`);

  const plan = buildImportPlan({
    rows: files.rows,
    normalized: files.normalized,
    medical: files.medical,
    batch: batchId,
    today,
    draftIdFor,
  });

  console.log(`  register rows  ${plan.stats.entries}`);
  for (const [status, count] of Object.entries(plan.stats.byStatus).sort()) {
    console.log(`    ${status.padEnd(13)}${count}`);
  }
  console.log(`  drafts         ${plan.stats.drafts}`);
  console.log(`  medical        ${plan.stats.medical}`);
  console.log(`  not imported   ${plan.stats.skipped}`);

  // ── refusal 2: any blocker at all ─────────────────────────────────────────
  if (plan.blockers.length > 0) {
    console.error(`\n  ✗ the plan carries ${plan.blockers.length} blocker(s). Nothing was written.\n`);
    for (const blocker of plan.blockers.slice(0, 40)) {
      console.error(`    n.º ${blocker.no ?? '—'}: ${blocker.why}`);
    }
    if (plan.blockers.length > 40) console.error(`    … and ${plan.blockers.length - 40} more`);
    console.error(
      '\n    A blocker is a bug in the extraction, not a row to skip. In particular the\n' +
        '    personal-data tripwire BLOCKS rather than redacting, so that a leaking\n' +
        '    column is reported instead of quietly cleaned up.\n',
    );
    process.exit(1);
  }

  // `draftIdFor` hashes, and a hash can collide. 225 ids out of 25^8 will not,
  // but "will not" is a probability and this is cheap: two rows sharing an id
  // would mean one animal's draft silently becoming the other's, and the
  // `.create()` that catches it would report a confusing ALREADY_EXISTS rather
  // than the thing that is actually wrong.
  const idsSeen = new Map();
  for (const draft of plan.drafts) {
    const clash = idsSeen.get(draft.id);
    if (clash !== undefined) {
      fail(`register rows ${clash} and ${draft.no} produced the same draft id ${draft.id}. Nothing was written.`);
    }
    idsSeen.set(draft.id, draft.no);
  }

  const animals = groupByAnimal(plan, options.only);
  if (options.only) {
    const missing = [...options.only].filter((no) => !animals.some((a) => a.no === no));
    if (missing.length > 0) usage(`--only names register numbers the plan has nothing for: ${missing.join(', ')}`);
    console.log(`\n  --only: ${animals.length} animal(s) — ${animals.map((a) => a.no).join(', ')}`);
  }

  assertShapes(animals, options.confirmedBy);
  console.log('\n  document shapes match RegisterEntry, PetDraft and MedicalRecord.');

  // ── the report ────────────────────────────────────────────────────────────
  if (options.report) {
    const path = resolve(process.cwd(), options.report);
    writeFileSync(path, buildReport(plan, { ...options, today, project, batch: batchId }), 'utf8');
    console.log(`\n  report     : ${path}`);
    if (!path.includes(`${'_local'}`)) {
      console.log('    ⚠ that path is outside _local/, which is the gitignored one. This file');
      console.log('      names every animal the shelter holds; do not commit it.');
    }
  }

  if (!options.write) {
    console.log('\n  ✔ dry run — nothing written.');
    console.log(`    would create ${animals.filter((a) => a.entry).length} register entries,`);
    console.log(`    ${animals.filter((a) => a.draft).length} drafts and`);
    console.log(`    ${animals.reduce((n, a) => n + a.medical.length, 0)} medical records.`);
    console.log('\n    Add --write --confirmed-by <email> to perform it.');
    console.log('    Try --only 1,2 first: a canary is cheaper than a rollback.\n');
    return;
  }

  // ── refusal 3: somebody has to vouch for the transcription ────────────────
  //
  // Verifying the claim also proves the credentials in this shell reach the
  // right project BEFORE 225 documents depend on it — the cheapest available
  // version of checking the instrument before trusting the reading.
  const auth = getAuth();
  let user;
  try {
    user = await auth.getUserByEmail(options.confirmedBy);
  } catch (error) {
    if (error?.code === 'auth/user-not-found') {
      fail(`No account exists for ${options.confirmedBy} on project ${project}.`);
    }
    throw error;
  }
  if (user.customClaims?.admin !== true) {
    fail(
      `${options.confirmedBy} does not hold the admin claim — claims are ` +
        `${JSON.stringify(user.customClaims ?? {})}.\n` +
        '    Only an admin can correct these records afterwards, so only an admin may vouch\n' +
        '    for them. Run: npm run grant:admin -- <email>',
    );
  }
  console.log(`\n  confirmed by: ${user.email}  uid=${user.uid}  (admin claim verified)`);

  // ── write ─────────────────────────────────────────────────────────────────
  console.log('\n── writing ──');
  const outcome = await runImport(db, plan, animals, { confirmedBy: user.email ?? options.confirmedBy });

  console.log(`\n  animals written  ${outcome.written}`);
  console.log(`  already present  ${outcome.skipped}`);
  console.log(`  medical records  ${outcome.records}`);
  if (outcome.failed > 0) console.log(`  FAILED           ${outcome.failed}`);

  if (outcome.untouched.length > 0) {
    console.log(`\n  left alone because they already existed (${outcome.untouched.length} animals):`);
    for (const item of outcome.untouched.slice(0, 20)) {
      console.log(`    n.º ${item.no}: ${item.left.join(', ')}`);
    }
    if (outcome.untouched.length > 20) console.log(`    … and ${outcome.untouched.length - 20} more`);
    console.log('    Nothing was overwritten. To re-import a corrected transcription,');
    console.log(`    delete the batch first: --delete --batch ${batchId} --write`);
  }

  const problems = await verify(db, plan, animals, options);

  if (outcome.failed > 0 || problems.length > 0) {
    console.error('\n  ✗ verification failed:');
    for (const problem of problems) console.error(`    • ${problem}`);
    console.error(`\n    Roll back with: --delete --batch ${batchId} --write\n`);
    process.exit(1);
  }

  console.log('\n  ✔ written and verified.');
  console.log('    The 43 drafts are waiting at /admin/intake. Each one keeps its register');
  console.log('    row, so a photograph attaches to the animal that is already on paper.');
  console.log(`    Rollback key: --delete --batch ${batchId}\n`);
}

main().catch((error) => {
  console.error('\n  ✗ failed\n');
  console.error(error);
  process.exit(1);
});
