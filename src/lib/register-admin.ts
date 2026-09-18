/**
 * The shelter's paper register — admin reads, and the two fields that link a
 * row to an animal's record. Client Components only.
 *
 * ── Why the client and not a Server Action ────────────────────────────────
 * Same reasoning as `pets-admin.ts` and `areas-admin.ts`: these reads and
 * writes go straight to Firestore from the browser and `firestore.rules` does
 * the authorization, which is free. The Admin SDK bypasses rules entirely, so
 * routing this through a server route would leave
 * `match /registerEntries/{no} { allow read, write: if isAdmin(); }`
 * protecting a path nothing uses.
 *
 * Every function below can therefore fail with `permission-denied`, and that
 * is the authorization working — see `AuthProvider`'s forced token refresh.
 *
 * ── A LINK IS TWO FIELDS, AND NOTHING IS EVER DELETED ─────────────────────
 * Linking a register row to an animal writes `registerEntries/{no}.petId` and
 * `.linkConfidence`, and nothing else. Unlinking clears the same two fields.
 * That is the whole reason a volunteer can be told to pick the row they think
 * is right: the worst outcome of a wrong guess is two fields to clear, not a
 * lost record and not a duplicate animal.
 *
 * The back-pointer is `Pet.registerNo`, which `publishDraft` copies off
 * `draft.register.no`. Both sides are written in ONE `writeBatch` here for the
 * same reason `publishDraft` is one batch: a half-linked state — an entry
 * claiming a draft that was never created, or a draft claiming a row that does
 * not point back — is not a state that can exist.
 *
 * ── Why the pure helpers are in this file ─────────────────────────────────
 * The project's split is `areas.ts` (pure, testable offline) against
 * `areas-admin.ts` (Firestore). The search matcher and the roster's comparator
 * below are pure and belong in a `src/lib/register.ts` on that pattern. They
 * are here because this feature's file boundary did not include a new pure
 * module; extracting them, with the tests they deserve, is the follow-up. They
 * are kept at the top, import nothing from Firestore, and take plain values,
 * so the extraction is a move rather than a rewrite.
 *
 * ⚠️ No user-facing words in this file. Failures are thrown and the component
 * says what happened, the same rule `pets-admin.ts` and `areas-admin.ts` keep.
 */

'use client';

import {
  collection,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  where,
  writeBatch,
  type DocumentData,
} from 'firebase/firestore';

import { getFirebase } from './firebase-client';
import { toDateInput } from './date-input';
import { draftDefaults, slugify, type PetDraft } from './intake';
import { loadDraft, mintPetId } from './pets-admin';
import type { RegisterEntry, RegisterLinkConfidence, RegisterStatus } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers — search, ordering, and the look-alike rule
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fold a string down to what a search should compare.
 *
 * The same NFD-then-strip-combining-marks pass `slugify()` and
 * `normalizeResembles()` already use, and for the same reason: a volunteer
 * types "nina" on a phone keyboard and the register says "Niña". Writing the
 * combining-mark range as an escape rather than as literal marks is
 * deliberate — a stray invisible character pasted into that class would be
 * undebuggable.
 */
export function foldForSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * A query, folded and split into the words that must ALL match.
 *
 * Every word has to hit something, so "negrita mama" finds n.º 172 and not
 * every row containing "negrita".
 */
export function searchNeedles(queryText: string): string[] {
  return foldForSearch(queryText).split(' ').filter(Boolean);
}

/**
 * Below this many characters a single edit is too large a share of the query
 * to mean anything: at three characters, one edit reaches most of the
 * register. Four is where "dana" and "duna" become each other and little else
 * does.
 */
export const FUZZY_MIN_QUERY = 4;

/**
 * Whether two strings are at most one insertion, deletion or substitution
 * apart.
 *
 * A bounded walk rather than a full Levenshtein matrix — the answer is a
 * boolean at a fixed threshold, so there is nothing to gain from computing the
 * distance and then comparing it. One pass, no allocation.
 */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;

  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  if (long.length - short.length > 1) return false;

  let i = 0;
  let j = 0;
  let edits = 0;

  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    // Equal lengths means the only possible edit is a substitution, so both
    // sides advance. Otherwise the extra character is in `long` and only it
    // advances — which is the same thing as a deletion from `short`.
    if (short.length === long.length) i += 1;
    j += 1;
  }

  // Whatever is left of the longer string is one more edit each.
  return edits + (long.length - j) <= 1;
}

/**
 * Everything about one row a search may match: its name, its aliases, the name
 * cell verbatim, and its register number.
 *
 * The number is in here because it is the only thing that separates two rows
 * the register names almost identically, and because a volunteer holding the
 * paper sheet reads the number long before they read the name.
 *
 * Built once per entry and reused across keystrokes — see the roster's
 * `useMemo`. Folding 225 rows on every character typed would be wasted work on
 * the one screen that has to feel instant.
 */
export function searchTokensFor(entry: RegisterEntry): string[] {
  const tokens = new Set<string>();
  tokens.add(String(entry.no));

  for (const source of [entry.name, entry.nameRaw, ...entry.aliases]) {
    const folded = foldForSearch(source ?? '');
    if (!folded) continue;
    tokens.add(folded);
    for (const word of folded.split(' ')) if (word) tokens.add(word);
  }

  return [...tokens];
}

function tokenMatches(token: string, needle: string): boolean {
  if (token.startsWith(needle)) return true;
  return needle.length >= FUZZY_MIN_QUERY && withinOneEdit(token, needle);
}

/** True when every word of the query matches something in the row. */
export function matchesTokens(
  tokens: readonly string[],
  needles: readonly string[],
): boolean {
  if (needles.length === 0) return true;
  return needles.every((needle) => tokens.some((token) => tokenMatches(token, needle)));
}

function intakeMillis(entry: RegisterEntry): number | null {
  return entry.intakeDate ? entry.intakeDate.toMillis() : null;
}

/**
 * Most recent intake first, then the highest register number first.
 *
 * A volunteer is least sure about the animal that arrived last week and most
 * sure about the one that has been here two years, so the uncertain rows are
 * the ones worth putting at the top. Register numbers increase with time, so
 * the same rule breaks a tie between two animals admitted the same day.
 *
 * A row with no intake date sorts LAST rather than first. The register
 * sometimes records only a year, and an unknown date is not evidence of a
 * recent arrival — guessing either way would put a row where its position
 * implies something the paper never said.
 */
export function compareForRoster(a: RegisterEntry, b: RegisterEntry): number {
  const left = intakeMillis(a);
  const right = intakeMillis(b);
  if (left !== right) {
    if (left === null) return 1;
    if (right === null) return -1;
    return right - left;
  }
  return b.no - a.no;
}

/**
 * The key two rows share when nothing in a photograph can tell them apart:
 * same outcome, same sex, admitted the same day.
 *
 * Seven pairs among the 43 animals still living here are like this — n.º 215
 * "Dana" and n.º 216 "Duna", n.º 132 "Benji" and n.º 133 "Balu" — and in four
 * of them the register records no colour for either animal. A volunteer
 * holding one of them genuinely cannot decide, and a screen that makes them
 * choose anyway produces a confident wrong link.
 *
 * ⚠️ The STATUS is part of the key, and it was added because a probe over the
 * real register caught the rule being too broad. Benji's litter is four male
 * puppies admitted on the same day; two of them have since left. Offering a
 * volunteer who is holding a living dog the two that were adopted is not a
 * genuine ambiguity — the register already tells those apart — and every extra
 * row in that list makes the honest ones harder to read. Two rows are
 * confusable only when the paper says the same thing happened to both.
 *
 * Null when the row lacks the sex or the date: two unknowns are not a
 * resemblance.
 */
export function lookalikeKey(entry: RegisterEntry): string | null {
  const intake = intakeMillis(entry);
  if (entry.sex === null || intake === null) return null;
  return `${entry.status}|${entry.sex}|${toDateInput(intake)}`;
}

/** The other rows this one could be confused with. */
export function findLookalikes(
  entry: RegisterEntry,
  all: readonly RegisterEntry[],
): RegisterEntry[] {
  const key = lookalikeKey(entry);
  if (key === null) return [];
  return all.filter((other) => other.no !== entry.no && lookalikeKey(other) === key);
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Takes anything that can hand back the document's fields, so the same mapper
 * serves a `getDoc` and a `getDocs` without either side casting.
 */
function entryFromDoc(snap: { data(): DocumentData }): RegisterEntry {
  const data = snap.data();
  return {
    // The document id is the number as a string, but the FIELD is what to
    // trust: ids sort lexicographically, so "10" would come before "9".
    no: data.no,
    name: data.name ?? '',
    nameRaw: data.nameRaw ?? '',
    hasRealName: data.hasRealName ?? false,
    aliases: data.aliases ?? [],
    species: data.species ?? null,
    speciesWhy: data.speciesWhy ?? null,
    sex: data.sex ?? null,
    intakeDate: data.intakeDate ?? null,
    intakeRaw: data.intakeRaw ?? '',
    ageAtIntakeRaw: data.ageAtIntakeRaw ?? null,
    ageAtIntakeMinMonths: data.ageAtIntakeMinMonths ?? null,
    ageAtIntakeMaxMonths: data.ageAtIntakeMaxMonths ?? null,
    status: data.status ?? 'unknown',
    statusWhy: data.statusWhy ?? '',
    statusDate: data.statusDate ?? null,
    statusConfirmed: data.statusConfirmed ?? false,
    sterilizedPerRegister: data.sterilizedPerRegister ?? false,
    lastRecordedDate: data.lastRecordedDate ?? null,
    colourNote: data.colourNote ?? null,
    breedWords: data.breedWords ?? [],
    responsible: data.responsible ?? null,
    litter: data.litter ?? null,
    petId: data.petId ?? null,
    linkConfidence: data.linkConfidence ?? null,
    flags: data.flags ?? [],
    importBatch: data.importBatch ?? '',
    importedAt: data.importedAt,
    updatedAt: data.updatedAt,
  };
}

/**
 * The register, ordered by number.
 *
 * ⚠️ `orderBy('no')` and nothing else. A `where('status', ...)` alongside an
 * `orderBy` on a different field needs a COMPOSITE index, which is the shape
 * that broke the microchip lookup on 2026-08-12 — and an unnecessary index
 * entry gets the whole `firestore.indexes.json` rejected, not just the
 * offending line. So the filter is applied WITHOUT an order (equality on one
 * field is indexed automatically) and the result is sorted in memory.
 *
 * The roster deliberately calls this with no filter and keeps all 225 rows:
 * the type-ahead has to answer on every keystroke, and a Firestore round-trip
 * per character would be both slow and a billed read per character. 225
 * documents is one small page, read once when the screen opens.
 */
export async function listRegisterEntries(
  opts: { status?: RegisterStatus } = {},
): Promise<RegisterEntry[]> {
  const { db } = getFirebase();
  const entries = collection(db, 'registerEntries');

  const snap = await getDocs(
    opts.status
      ? query(entries, where('status', '==', opts.status))
      : query(entries, orderBy('no')),
  );

  const rows = snap.docs.map(entryFromDoc);
  return opts.status ? rows.sort((a, b) => a.no - b.no) : rows;
}

export async function getRegisterEntry(no: number): Promise<RegisterEntry | null> {
  const { db } = getFirebase();
  const snap = await getDoc(doc(db, 'registerEntries', String(no)));
  if (!snap.exists()) return null;
  return entryFromDoc(snap);
}

/**
 * How many rows carry one status, without reading them.
 *
 * The dashboard needs the resident count and nothing else from the register,
 * and an aggregation is billed as a handful of index reads rather than as 43
 * documents. Equality on a single field, so no index entry is needed.
 */
export async function countRegisterEntries(status: RegisterStatus): Promise<number> {
  const { db } = getFirebase();
  const snap = await getCountFromServer(
    query(collection(db, 'registerEntries'), where('status', '==', status)),
  );
  return snap.data().count;
}

// ─────────────────────────────────────────────────────────────────────────────
// Linking a row to a record
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What opening a register row led to.
 *
 * `published` is not a failure: an animal whose record was already published
 * has a pet page rather than a draft, and sending the volunteer there is the
 * correct answer. It exists as its own case because the alternative is worse
 * than it looks — `/admin/intake?draft={id}` with an id that no longer names a
 * draft does NOT error, it silently starts a FRESH draft (IntakeWizard says so
 * and drops the stale query). That is precisely the second record this whole
 * screen exists to prevent, so the caller must be able to tell the two apart.
 */
export type OpenEntryResult =
  | { kind: 'draft'; petId: string; created: boolean }
  | { kind: 'published'; petId: string };

/**
 * Build the draft a register row starts from.
 *
 * What is copied, and what deliberately is NOT:
 *
 *  - `name` and `slug` only when the register holds a real NAME. 47 of the 225
 *    rows hold a description instead — "BB2 de Johana, café con blanco" — and
 *    copying one into `Pet.name` would put a fiction on a public adoption page.
 *    ⚠️ The slug follows: a resumed draft sets `slugTouched`, so the wizard
 *    stops deriving the slug from the name. A nameless row therefore publishes
 *    only once someone fills the slug field in by hand, which the wizard shows
 *    as `slug-invalid` on step 1 with the field beside it. Four of the 43
 *    residents are in this state.
 *  - `sex` is NOT copied, and that is the contract `RegisterRef.sexPerRegister`
 *    states: a handwritten H/M is wrong often enough, sex inflects every
 *    Spanish sentence the site writes about this animal, and a genital
 *    photograph is the better reading. Both values are carried so a person can
 *    see them disagree.
 *  - `ageYears` is NOT derived from the register's age. The register records
 *    age AT INTAKE, which for an animal admitted two years ago is not its age
 *    today. `RegisterRef.ageText` carries the cell verbatim instead.
 *  - `colorPattern` IS copied. Colour is an observation the shelter itself
 *    wrote down, and it is what someone types when searching for a lost dog.
 *  - `breed` is NOT copied from `breedWords`. "husky" on a paper sheet is a
 *    resemblance, and writing it into the public `breed` field turns it into a
 *    claim — the breed doctrine here fails toward mestizo. The words stay on
 *    the register row and the confirm card shows them, so the person carries
 *    them across themselves.
 */
function draftFromEntry(
  entry: RegisterEntry,
  id: string,
  confidence: RegisterLinkConfidence,
  medicalCount: number,
): PetDraft {
  const base = draftDefaults(id);
  const name = entry.hasRealName ? entry.name.trim() : '';

  return {
    ...base,
    species: entry.species,
    name,
    slug: name ? slugify(name) : '',
    colorPattern: entry.colourNote ?? '',
    sterilized: entry.sterilizedPerRegister,
    register: {
      no: entry.no,
      nameRaw: entry.nameRaw,
      intakeDay: entry.intakeDate ? toDateInput(entry.intakeDate.toMillis()) : null,
      ageText: entry.ageAtIntakeRaw,
      sexPerRegister: entry.sex,
      sterilizedPerRegister: entry.sterilizedPerRegister,
      medicalCount,
      batch: entry.importBatch,
      linkConfidence: confidence,
    },
  };
}

/** How many medical records the import already wrote under this id. */
async function countImportedMedical(petId: string): Promise<number> {
  const { db } = getFirebase();
  const snap = await getCountFromServer(collection(doc(db, 'pets', petId), 'medical'));
  return snap.data().count;
}

/**
 * Open the record this register row belongs to, creating it if there is not
 * one yet.
 *
 * ⚠️ NO `user` argument, and that is not an oversight. `RegisterEntry` has no
 * author field — its shape is the importer's contract — and Firestore takes
 * the caller's identity from the SDK, so a `User` passed in here would be
 * decoration. Who may write is decided by `firestore.rules` reading the admin
 * claim out of the caller's own token.
 *
 * Three paths, and the first two write nothing:
 *
 *  1. The row already names a live draft → open it. This is the ordinary case
 *     for the 43 residents once the import has run.
 *  2. The row names an animal that has already been PUBLISHED → send the
 *     caller to the pet page. Re-creating a draft at that id would fight the
 *     published record.
 *  3. The row names nothing, or names an id where neither exists any more →
 *     build the draft and link it, both writes in ONE batch.
 *
 * Path 3 reuses the DANGLING id rather than minting a fresh one, so the
 * register keeps pointing at the same place and any medical records the import
 * wrote under `pets/{id}/medical` stay attached to the draft that will become
 * that pet.
 */
export async function openOrCreateDraftForEntry(
  entry: RegisterEntry,
  confidence: RegisterLinkConfidence = 'confirmed',
): Promise<OpenEntryResult> {
  const { db } = getFirebase();

  if (entry.petId) {
    const existing = await loadDraft(entry.petId);
    if (existing) return { kind: 'draft', petId: entry.petId, created: false };

    const published = await getDoc(doc(db, 'pets', entry.petId));
    if (published.exists()) return { kind: 'published', petId: entry.petId };
  }

  // A dangling id is reused; a row that was never linked mints one. A fresh
  // id cannot have medical records under it, so only the reuse path counts.
  const petId = entry.petId ?? mintPetId();
  const medicalCount = entry.petId ? await countImportedMedical(petId) : 0;

  const batch = writeBatch(db);
  batch.set(doc(db, 'petDrafts', petId), {
    // The same shape `saveDraft()` writes. Duplicated rather than called
    // because the two writes have to be one batch: a draft that exists while
    // the register still says "sin foto" is the half-linked state.
    ...draftFromEntry(entry, petId, confidence, medicalCount),
    updatedAt: serverTimestamp(),
  });
  batch.update(doc(db, 'registerEntries', String(entry.no)), {
    petId,
    linkConfidence: confidence,
    updatedAt: serverTimestamp(),
  });
  await batch.commit();

  return { kind: 'draft', petId, created: true };
}

/**
 * Downgrade an existing link to `provisional` — "it is one of these two and I
 * cannot tell which".
 *
 * A provisional link that announces itself is worth more than a confident
 * wrong one: the photographs still reach a record, the animal still gets a
 * page, and whoever can tell the pair apart later is told there is something
 * to settle. Nothing is blocked by it.
 *
 * Takes the entry rather than the number so the draft's own copy of the
 * confidence moves with it. A draft saying `confirmed` while the register says
 * `provisional` is exactly the drift that makes a later reader trust the wrong
 * one.
 */
export async function markProvisional(entry: RegisterEntry): Promise<void> {
  const { db } = getFirebase();
  const provisional: RegisterLinkConfidence = 'provisional';

  // ⚠️ `batch.update()` on a document that does not exist FAILS THE WHOLE
  // BATCH, and a draft legitimately stops existing: publishing it deletes it.
  // So the draft half is added only once it is known to be there. `set` with
  // `merge` would avoid the read and is wrong — it would mint a stub draft
  // document holding nothing but a confidence, which the dashboard would then
  // list as an unfinished animal.
  const draftExists = entry.petId !== null && (await loadDraft(entry.petId)) !== null;

  const batch = writeBatch(db);
  batch.update(doc(db, 'registerEntries', String(entry.no)), {
    linkConfidence: provisional,
    updatedAt: serverTimestamp(),
  });

  if (entry.petId && draftExists) {
    // A nested field path, so the rest of the draft is untouched — the wizard
    // may be open on it in another tab.
    batch.update(doc(db, 'petDrafts', entry.petId), {
      'register.linkConfidence': provisional,
      updatedAt: serverTimestamp(),
    });
  }

  await batch.commit();
}

/**
 * Undo a link.
 *
 * ⚠️ Deletes NOTHING. The draft and every photograph already taken survive —
 * they become an ordinary intake with no register row, which is a real and
 * correct state for an animal nobody has found on the paper sheet yet. The
 * alternative, deleting the draft, would throw away photographs to correct a
 * two-field mistake.
 *
 * Both sides are cleared in one batch for the same reason they are set in one:
 * a draft still claiming row 215 after 215 has let go of it would show up in
 * the wizard as provenance for an animal it is no longer about.
 */
export async function unlinkEntry(entry: RegisterEntry): Promise<void> {
  const { db } = getFirebase();

  // Same reason as in `markProvisional`: an update against a draft that was
  // published — and therefore deleted — would fail the batch, and the register
  // row would stay linked to a record the volunteer just said is the wrong
  // animal.
  const draftExists = entry.petId !== null && (await loadDraft(entry.petId)) !== null;

  // ⚠️ A published animal has no draft left — `publishDraft` deletes it in the
  // same batch that creates the pet — but it DOES carry the other half of the
  // link, `pets/{petId}.registerNo`, on its public document. Clearing only the
  // register row would leave the row free to be linked to a second animal
  // while a published pet still claimed the number: the same row pointing at
  // two animals, which is precisely the state the number exists to prevent.
  const publishedPet =
    entry.petId !== null && !draftExists ? await getDoc(doc(db, 'pets', entry.petId)) : null;

  const batch = writeBatch(db);
  batch.update(doc(db, 'registerEntries', String(entry.no)), {
    petId: null,
    linkConfidence: null,
    updatedAt: serverTimestamp(),
  });

  if (entry.petId && draftExists) {
    batch.update(doc(db, 'petDrafts', entry.petId), {
      register: null,
      updatedAt: serverTimestamp(),
    });
  }

  if (entry.petId && publishedPet?.exists()) {
    batch.update(doc(db, 'pets', entry.petId), {
      registerNo: null,
      updatedAt: serverTimestamp(),
    });
  }

  await batch.commit();
}
