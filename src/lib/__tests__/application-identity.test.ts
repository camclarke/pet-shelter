/**
 * `adoptionApplications/{id}/private/identity` — portion 4c-1, plan §3.
 *
 * Run with:  node --test --import tsx src/lib/__tests__/application-identity.test.ts
 *
 * The C.I. number, the age, the civil status, the landline, two references and
 * a renter's landlord: personal details, and third parties' names and phones.
 * They live in their own admin-only, erasable document precisely so they are
 * NOT in `answers`, which every queue load downloads and nothing may erase.
 *
 * What is pinned here:
 *   1. the module's limits and the rules' limits are the same numbers;
 *   2. the builder writes exactly the keys the rules require;
 *   3. PRIVATE_DOCUMENT_IDS is the rules' list of private documents;
 *   4. the read and write rules are the narrow ones the owner decided (D2,
 *      D15), with nothing OR-ed onto a create, and the D15 correction path:
 *      internal/notes records THAT a correction is needed, never the number;
 *   5. the wiring: one batch, acceptance before the network, never the queue,
 *      never logged (an allowlist: only error codes);
 *   6. FOUR SWITCH-ON GUARDS. Each asserts nothing while the form is off, and
 *      fails the moment `adoptionApplications.enabled` is true before its
 *      precondition exists — so 4f cannot ship without them.
 *
 * Every threshold is a LITERAL somewhere here or in applications.test.ts, so a
 * test cannot pass by comparing a constant with itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { SHELTER } from '@/config/shelter';
import { ADOPTION_ACCEPTANCE, ADOPTION_LEGAL_REVIEW } from '@/config/adoption-contract';
import {
  ANSWER_MAX_CHARS,
  CI_MAX_CHARS,
  CI_MIN_CHARS,
  IDENTITY_AGE_MAX,
  IDENTITY_AGE_MIN,
  IDENTITY_ANSWER_MAX_CHARS,
  IDENTITY_REQUIRED_KEYS,
  INTERNAL_NOTES_DOCUMENT,
  PRIVATE_DOCUMENT_IDS,
  buildIdentityCreate,
} from '../applications';
import { findVoseo } from '../ai/spanish-register';
import { es } from '@/i18n/es';
import { payloadLoggingProblems } from './no-payload-logging';

const ROOT = process.cwd();
const config = SHELTER.adoptionApplications;

// LF-normalised, so a CRLF checkout on Windows reads the same as CI.
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');
const RULES = read('firestore.rules');

/** Source with comments removed, so a comment naming a call cannot satisfy a check. */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The body of a rules function, or a thrown error naming it. */
function rulesFunctionBody(name: string): string {
  const start = RULES.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `firestore.rules no longer defines ${name}() — the drift guard cannot compare`);
  const open = RULES.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < RULES.length; i += 1) {
    if (RULES[i] === '{') depth += 1;
    if (RULES[i] === '}') depth -= 1;
    if (depth === 0) return RULES.slice(open + 1, i).replace(/\s+/g, ' ');
  }
  throw new Error(`unterminated rules function ${name}()`);
}

/** The `match /private/{docId}` block, whole. */
function privateBlock(): string {
  const head = 'match /private/{docId} {';
  const start = RULES.indexOf(head);
  assert.ok(start >= 0, 'firestore.rules no longer has the private/{docId} block');
  // The block's own brace — not the one in `{docId}`.
  const open = start + head.length - 1;
  let depth = 0;
  for (let i = open; i < RULES.length; i += 1) {
    if (RULES[i] === '{') depth += 1;
    if (RULES[i] === '}') depth -= 1;
    if (depth === 0) return RULES.slice(open + 1, i);
  }
  throw new Error('unterminated private block');
}

/** One `allow <verb>` rule inside the private block, whitespace collapsed. */
function privateRule(verb: string): string {
  const block = privateBlock();
  const match = new RegExp(`allow ${verb}: if [^;]*;`).exec(block);
  assert.ok(match, `the private block has no allow ${verb}`);
  return match[0].replace(/\s+/g, ' ');
}

const quoted = (text: string) => [...text.matchAll(/'([^']*)'/g)].map((m) => m[1]!);

// ─── 1. the limits ──────────────────────────────────────────────────────────

test('validIdentity() carries the same C.I. and age bounds the module declares', () => {
  const body = rulesFunctionBody('validIdentity');
  for (const needle of [
    'd.answers.ciNumber is string',
    `d.answers.ciNumber.size() >= ${CI_MIN_CHARS}`,
    `d.answers.ciNumber.size() <= ${CI_MAX_CHARS}`,
    'd.answers.age is int',
    `d.answers.age >= ${IDENTITY_AGE_MIN}`,
    `d.answers.age <= ${IDENTITY_AGE_MAX}`,
  ]) {
    assert.ok(body.includes(needle), `validIdentity() no longer says ${needle}`);
  }
  // The keys the rules REQUIRE are the module's.
  const hasAll = /d\.answers\.keys\(\)\.hasAll\(\[([^\]]*)\]\)/.exec(body);
  assert.ok(hasAll, 'validIdentity() no longer requires any key');
  assert.deepEqual(quoted(hasAll[1]!), [...IDENTITY_REQUIRED_KEYS]);
});

test('validIdentityAnswer() is a string of at most IDENTITY_ANSWER_MAX_CHARS', () => {
  const body = rulesFunctionBody('validIdentityAnswer');
  assert.ok(body.includes('v is string'), 'an identity answer may no longer need to be a string');
  assert.ok(body.includes(`v.size() <= ${IDENTITY_ANSWER_MAX_CHARS}`), 'the identity length bound drifted');
});

test('no identity question can produce an answer the rules would refuse', () => {
  // The form's per-kind limits must fit inside the rules' worst case, or a
  // valid form would be refused at submit with nothing the person can fix.
  for (const q of config.questions.filter((q) => q.store === 'identity')) {
    if (q.id === 'age') {
      assert.equal(q.min, IDENTITY_AGE_MIN, 'the age question and the rules disagree on the minimum');
      assert.equal(q.max, IDENTITY_AGE_MAX, 'the age question and the rules disagree on the maximum');
      continue;
    }
    const max = ANSWER_MAX_CHARS[q.kind as 'shortText' | 'phone' | 'idNumber'];
    assert.ok(typeof max === 'number' && max <= IDENTITY_ANSWER_MAX_CHARS, `${q.id}: ${q.kind} allows ${max}`);
  }
  assert.equal(ANSWER_MAX_CHARS.idNumber, CI_MAX_CHARS);
});

// ─── 2. the builder writes what the rules require ───────────────────────────

test('the identity builder writes exactly the keys the rules require of private/identity', () => {
  const create = privateRule('create');
  const branch = create.slice(create.indexOf(': (request.resource.data.keys().hasOnly([\'applicantUid\', \'answers\''));
  const hasOnly = /hasOnly\(\[([^\]]*)\]\)/.exec(branch);
  const hasAll = /hasAll\(\[([^\]]*)\]\)/.exec(branch);
  assert.ok(hasOnly && hasAll, 'the identity branch of the private create no longer pins its keys');
  const written = Object.keys(
    buildIdentityCreate({ applicantUid: 'u', identity: { ciNumber: '1234567', age: 30 } }),
  ).sort();
  assert.deepEqual(quoted(hasOnly[1]!).sort(), written);
  assert.deepEqual(quoted(hasAll[1]!).sort(), written);
  assert.ok(branch.includes('validIdentity(request.resource.data)'), 'the identity branch no longer validates its answers');
});

// ─── 3. the list of private documents ───────────────────────────────────────

test('PRIVATE_DOCUMENT_IDS is exactly the private documents the rules let an applicant create', () => {
  const create = privateRule('create');
  const docIds = /docId in \[([^\]]*)\]/.exec(create);
  assert.ok(docIds, 'the private create no longer lists its documents');
  assert.deepEqual(quoted(docIds[1]!), [...PRIVATE_DOCUMENT_IDS]);
});

test('the parent create requires EVERY private document in the same batch', () => {
  const create = [...RULES.matchAll(/allow create:[^;]*/g)]
    .map((m) => m[0])
    .find((rule) => rule.includes('petAcceptsApplications('));
  assert.ok(create, 'no adoptionApplications create rule found');
  for (const id of PRIVATE_DOCUMENT_IDS) {
    assert.ok(
      create.includes(`existsAfter(/databases/$(database)/documents/adoptionApplications/$(applicationId)/private/${id})`),
      `the application can be created without private/${id}`,
    );
  }
});

// ─── 4. who reads and writes it ─────────────────────────────────────────────

test('only an admin reads private/identity: the applicant reads back their home, never their identity (D2)', () => {
  const get = privateRule('get');
  assert.match(
    get,
    /^allow get: if isAdmin\(\) \|\| \(docId == 'home' && ownApplicationId\(\) && resource\.data\.applicantUid == request\.auth\.uid\);$/,
  );
  assert.equal(privateRule('list'), 'allow list: if isAdmin();');
});

test('nobody updates private/identity — admins correct the address only — and nobody deletes either (D15)', () => {
  const update = privateRule('update');
  assert.ok(update.startsWith("allow update: if isAdmin() && docId == 'home' &&"), update);
  assert.ok(!update.includes('identity'), 'an update branch reaches private/identity');
  assert.equal(privateRule('delete'), 'allow delete: if false;');
  assert.equal((privateBlock().match(/allow /g) ?? []).length, 5, 'a new allow appeared in the private block');
});

/**
 * How many `||` sit OUTSIDE every bracket of a rule expression. `a && b && c`
 * has none; appending `|| isAdmin()` adds one, and that one ORs the whole rule
 * open — past the switch, the own id and every payload check (review 4c-1 #2).
 * Comments must be stripped first; quoted strings are skipped.
 */
function topLevelOrs(expression: string): number {
  let depth = 0;
  let count = 0;
  for (let i = 0; i < expression.length; i += 1) {
    const ch = expression[i];
    if (ch === "'") {
      const close = expression.indexOf("'", i + 1);
      if (close < 0) break;
      i = close;
    } else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === '|' && expression[i + 1] === '|' && depth === 0) {
      count += 1;
      i += 1;
    }
  }
  return count;
}

/** The `allow create` of the application itself, comments removed. */
function applicationCreateRule(): string {
  const stripped = RULES.replace(/\/\/.*$/gm, '');
  const create = [...stripped.matchAll(/allow create: if [^;]*;/g)]
    .map((m) => m[0])
    .find((rule) => rule.includes('petAcceptsApplications('));
  assert.ok(create, 'no adoptionApplications create rule found');
  return create.replace(/\s+/g, ' ');
}

test('topLevelOrs sees an appended `|| isAdmin()` and nothing nested (control)', () => {
  assert.equal(topLevelOrs('a() && (b || c) && d'), 0);
  assert.equal(topLevelOrs("a() && x in ['p||q'] && d"), 0);
  assert.equal(topLevelOrs('a() && (b && c) || isAdmin()'), 1);
});

test('the private create is gated on the switch, the own id, and the parent being created in the same batch', () => {
  const create = privateRule('create');
  assert.ok(create.startsWith("allow create: if applicationsEnabled() && docId in ['home', 'identity'] && ownApplicationId()"), create);
  assert.ok(create.includes('!exists(/databases/$(database)/documents/adoptionApplications/$(applicationId))'));
  assert.ok(create.includes('existsAfter(/databases/$(database)/documents/adoptionApplications/$(applicationId))'));
  assert.ok(create.includes('request.resource.data.applicantUid == request.auth.uid'));
  assert.ok(create.includes('request.resource.data.createdAt == request.time'));
  // Nothing may be OR-ed onto the whole rule: an appended `|| isAdmin()` would
  // let an admin write any private document, switch off or not.
  const expression = create.replace(/^allow create: if /, '').replace(/;$/, '');
  assert.equal(topLevelOrs(expression), 0, `the private create has a top-level ||: ${create}`);
  assert.ok(create.endsWith('&& validIdentity(request.resource.data)));'), 'the private create no longer ends on the identity check');
});

test('the application create cannot be widened by a top-level || either', () => {
  const create = applicationCreateRule();
  const expression = create.replace(/^allow create: if /, '').replace(/;$/, '');
  assert.ok(expression.startsWith('applicationsEnabled() && ownApplicationId()'), create);
  assert.equal(topLevelOrs(expression), 0, `the application create has a top-level ||: ${create}`);
  assert.ok(create.endsWith('/private/identity);'), 'the application create no longer ends on the identity requirement');
});

test('the internal notes document is the one the code names, and its free text is the field to blank', () => {
  // D15 (review 4c-1 #1): a correction is RECORDED in internal/notes, never the
  // number itself — and the 4e sweep blanks the text as a backstop.
  const start = RULES.indexOf(`match /${INTERNAL_NOTES_DOCUMENT.subcollection}/{docId} {`);
  assert.ok(start >= 0, `firestore.rules has no match /${INTERNAL_NOTES_DOCUMENT.subcollection}/{docId}`);
  const block = RULES.slice(start, RULES.indexOf('allow delete', start)).replace(/\s+/g, ' ');
  assert.ok(block.includes(`docId == '${INTERNAL_NOTES_DOCUMENT.id}'`), 'the rules no longer write only internal/notes');
  assert.ok(block.includes(`request.resource.data.${INTERNAL_NOTES_DOCUMENT.blankField} is string`), 'the notes text field drifted');
  // The admin layer reads and writes it through the same constant, never a literal.
  const admin = code('src/lib/applications-admin.ts');
  assert.ok(!/'internal',\s*'notes'/.test(admin), 'applications-admin.ts spells the notes path by hand');
  assert.equal((admin.match(/\.\.\.NOTES_PATH/g) ?? []).length, 2, 'the notes are read and written through INTERNAL_NOTES_DOCUMENT');
});

test('the notes hint says to record that a correction is needed, never a C.I. or a phone', () => {
  const hint = es.applications.notesHint;
  assert.match(hint, /anota solo que hay que corregirlo/);
  assert.match(hint, /Nunca escribas aquí un número de carnet ni el teléfono de nadie/);
  assert.deepEqual(findVoseo(hint), [], hint);
  // And the rules comment says the same, so nobody reads D15 as "write the
  // corrected number in the notes".
  assert.ok(!/a correction goes\s*\/\/\s*in internal\/notes/.test(RULES), 'the old D15 comment is back');
  assert.match(RULES.replace(/\s*\/\/\s*/g, ' '), /never the C\.I\. number or anyone's phone/);
});

// ─── 5. the wiring ──────────────────────────────────────────────────────────

test('the submit writes private/identity in the SAME batch as the application and private/home', () => {
  const client = code('src/lib/applications-client.ts');
  const body = client.slice(client.indexOf('export async function submitApplication'), client.indexOf('export async function listMyApplications'));
  assert.equal((body.match(/writeBatch\(/g) ?? []).length, 1, 'the submit is not exactly one batch');
  assert.equal((body.match(/\.commit\(\)/g) ?? []).length, 1);
  const batchAt = body.indexOf('writeBatch(');
  const identityAt = body.indexOf("'private', 'identity'");
  const commitAt = body.indexOf('batch.commit()');
  assert.ok(batchAt > 0 && batchAt < identityAt && identityAt < commitAt, 'private/identity is not written inside the batch');
  assert.ok(body.includes('buildIdentityCreate('), 'the identity document is not built by the tested builder');
  assert.ok(/if \(!identity\) throw/.test(body), 'a submission without identity is no longer refused before the network');
  // Review 4c-1 #6: the acceptance is checked BEFORE the first network call
  // (the token refresh), and handed to the builder, which checks it again.
  const acceptAt = body.indexOf('requireAcceptance(acceptance, contract)');
  const networkAt = body.indexOf('getIdTokenResult(');
  assert.ok(acceptAt > 0 && acceptAt < networkAt, 'the acceptance is not checked before the network');
  assert.match(body, /buildApplicationCreate\(\{[^}]*\bacceptance,/, 'the builder is not given the acceptance');
});

test('nothing that touches private/identity logs anything but an error code', () => {
  // The allowlist (no-payload-logging.ts): a message string, then at most an
  // error code. A C.I., a reference's phone or a landlord's name in a log is a
  // copy nothing erases.
  for (const file of [
    'src/lib/applications.ts',
    'src/lib/applications-client.ts',
    'src/lib/applications-admin.ts',
    'src/app/admin/applications/[applicationId]/ApplicationReview.tsx',
    'src/app/adopt/[slug]/apply/ApplicationForm.tsx',
    'src/app/adopt/[slug]/apply/ApplicationFields.tsx',
    'src/app/adopt/[slug]/apply/ApplicationStepper.tsx',
    'src/lib/application-steps.ts',
  ]) {
    assert.deepEqual(payloadLoggingProblems(file, read(file)), []);
  }
  // Control: the identity read's own failure log is seen, and passes.
  assert.ok(
    read('src/app/admin/applications/[applicationId]/ApplicationReview.tsx').includes(
      "console.error('[admin/application] could not load the personal details', errorCode(caught));",
    ),
  );
});

test('the queue never loads private/identity; the review reads it on its own', () => {
  const admin = code('src/lib/applications-admin.ts');
  assert.equal((admin.match(/'private', 'identity'/g) ?? []).length, 1, 'private/identity is read in more than one place');
  const listing = admin.slice(
    admin.indexOf('export async function listApplications'),
    admin.indexOf('export async function getApplication('),
  );
  assert.ok(!listing.includes('identity'), 'the queue listing reads private/identity');
  assert.ok(!/getApplicationIdentity|'identity'/.test(code('src/app/admin/applications/ApplicationsQueue.tsx')));

  const review = code('src/app/admin/applications/[applicationId]/ApplicationReview.tsx');
  assert.equal((review.match(/getApplicationIdentity\(/g) ?? []).length, 1, 'one read site');
  // Not read at all once erased: the effect bails out on the same flag the
  // address uses, decided by isIdentityErased upstream.
  assert.match(review, /if \(!loadedId \|\| erased\) return;\s*let live = true;\s*setIdentity\('loading'\);/);
});

test('the identity answers are never written into answers', () => {
  // Since 4c-2 the stepper builds its submission through the pure, tested
  // buildSubmission(), which splits by store — and hands each half to the
  // client under its own name.
  const steps = code('src/lib/application-steps.ts');
  const builder = steps.slice(steps.indexOf('export function buildSubmission'));
  assert.ok(builder.includes('splitAnswersByStore('), 'buildSubmission no longer splits the answers by store');
  assert.match(builder, /answers: split\.application, identity: split\.identity/);
  const stepper = code('src/app/adopt/[slug]/apply/ApplicationStepper.tsx');
  assert.ok(stepper.includes('buildSubmission(stepperState, questions)'), 'the stepper no longer uses buildSubmission');
  assert.match(stepper, /answers: submission\.answers,\s*identity: submission\.identity,\s*home: submission\.home,/);
  // The old single-page submit is gone: nothing else on the apply page writes.
  assert.ok(!code('src/app/adopt/[slug]/apply/ApplicationForm.tsx').includes('submitApplication'));
});

// ─── 6. THE SWITCH-ON GUARDS ────────────────────────────────────────────────
// Each passes while `enabled` is false and FAILS the moment it is true without
// its precondition. Do not delete one to switch the form on: meet it.

test('switch-on guard 1: the acceptance wording is approved by the owner and the lawyer', () => {
  // Critic #13 and lawyer question 3: "acepto" means "I apply under this
  // contract", and the exact words are not final until both approve them.
  assert.ok(
    !config.enabled || ADOPTION_ACCEPTANCE.isDraft === false,
    'adoptionApplications.enabled is true while ADOPTION_ACCEPTANCE.isDraft is still true — get the wording approved first',
  );
});

/**
 * Phrases only a /privacy section about THIS form would carry. Review 4c-1 #4:
 * the old guard asked for "dirección" (already on the page for the account
 * address) and /referencias/i (matched "preferencias"), so it passed on a page
 * that described none of the new data. Each phrase here names a field the
 * paper form asks for; "referencias" must be a whole word.
 */
const PRIVACY_PHRASES_FOR_THE_FORM = [
  'carnet',
  'C.I.',
  'estado civil',
  'teléfono fijo',
  'dirección exacta',
  'dueño',
  'referencias',
] as const;

/** The phrases /privacy is missing. Letter-aware whole words, case-insensitive. */
function missingPrivacyPhrases(page: string): string[] {
  return PRIVACY_PHRASES_FOR_THE_FORM.filter((phrase) => {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(page);
  });
}

test('the /privacy phrase check is not vacuous (control)', () => {
  // On synthetic text only — NEVER on the live page, or this control would
  // fail the day 4f rewrites /privacy, with the form still off. "preferencias"
  // and "direcciones" are not "referencias" or "dirección exacta".
  assert.deepEqual(
    missingPrivacyPhrases('Tus preferencias y tus direcciones.').sort(),
    [...PRIVACY_PHRASES_FOR_THE_FORM].sort(),
  );
  assert.deepEqual(
    missingPrivacyPhrases(
      'Pedimos tu carnet (C.I.), tu estado civil, tu teléfono fijo, la dirección exacta, dos referencias y, si alquilas, al dueño de casa.',
    ),
    [],
  );
});

test('switch-on guard 2: /privacy describes the data this form collects, field by field', () => {
  // The 4f /privacy rewrite (plan §7). The page must describe what the form
  // collects — including third parties — before anyone can submit it.
  if (!config.enabled) return;
  const missing = missingPrivacyPhrases(read('src/app/privacy/page.tsx'));
  assert.deepEqual(missing, [], `/privacy does not mention ${missing.map((p) => `«${p}»`).join(', ')} — rewrite it before switching on (4f)`);
});

const SWEEP_ROUTE = 'src/app/api/internal/identity-sweep/route.ts';

test('switch-on guard 3: the retention sweep exists and takes PRIVATE_DOCUMENT_IDS and INTERNAL_NOTES_DOCUMENT', () => {
  // Portion 4e. Without it the policy's "erased 30 days after a rejection or
  // withdrawal" is a promise nothing keeps. It must import the shared list so
  // it cannot forget private/identity, and the notes document so it blanks
  // their text (review 4c-1 #1).
  if (!config.enabled) return;
  assert.ok(existsSync(join(ROOT, SWEEP_ROUTE)), `${SWEEP_ROUTE} does not exist — build the 4e sweep before switching on`);
  // The route, or a local module it imports (the plan's pure identity-sweep.ts).
  const route = code(SWEEP_ROUTE);
  const locals = [...route.matchAll(/from\s*['"]((?:@\/|\.)[^'"]+)['"]/g)].map((m) => {
    const spec = m[1]!;
    const base = spec.startsWith('@/') ? join('src', spec.slice(2)) : join(dirname(SWEEP_ROUTE), spec);
    return [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((p) => existsSync(join(ROOT, p)));
  });
  const sources = [route, ...locals.filter((p): p is string => p !== undefined).map(code)];
  const imported = new Set(
    sources.flatMap((src) =>
      [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*applications['"]/g)].flatMap((m) =>
        m[1]!.split(',').map((name) => name.trim().split(/\s+as\s+/)[0]!),
      ),
    ),
  );
  for (const name of ['PRIVATE_DOCUMENT_IDS', 'INTERNAL_NOTES_DOCUMENT']) {
    assert.ok(
      imported.has(name),
      `${SWEEP_ROUTE} does not import ${name} from applications, directly or through a module it imports`,
    );
  }
});

test('switch-on guard 4: the lawyer approved what the form collects (Q1, Q4–Q7)', () => {
  // Third parties' names and phones, the C.I. and the carnet photo, refusing
  // minors, ESTADO CIVIL, and storage in the United States (plan §8).
  assert.ok(
    !config.enabled || ADOPTION_LEGAL_REVIEW.dataCollectionApproved === true,
    'adoptionApplications.enabled is true while ADOPTION_LEGAL_REVIEW.dataCollectionApproved is false — get the lawyer’s answers first',
  );
});
