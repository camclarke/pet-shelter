/**
 * Source-level guarantees for the register link.
 *
 * A link between a register row and an animal is two fields — `petId` on the
 * row, `registerNo` on the pet — written in one batch. That is what makes a
 * wrong link a two-tap correction rather than a data migration. These tests
 * read the source, because the code they check is the Firestore layer: there
 * is no test harness here that can run a `writeBatch`, and the alternative —
 * mocking Firestore — would assert my own assumptions back at me.
 *
 * The same technique as `account-wiring.test.ts` and `medical-wiring.test.ts`,
 * and for the same reason: a guard nothing exercises is a guard that quietly
 * stops being wired up. PR #26 is the precedent — `reviewSuggestion` computed
 * a sex the UI then threw away, with every test green.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const read = (file: string) =>
  readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');

const adminCode = () => read('src/lib/register-admin.ts');
const wizardCode = () => read('src/app/admin/intake/IntakeWizard.tsx');

/** The body of a named exported function, up to the next top-level `}`. */
function functionBody(source: string, name: string): string {
  const at = source.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} is gone`);
  const end = source.indexOf('\n}', at);
  assert.ok(end > at, `could not find the end of ${name}`);
  return source.slice(at, end);
}

// ─────────────────────────────────────────────────────────────────────────────
// Unlinking clears BOTH sides, including a published animal
// ─────────────────────────────────────────────────────────────────────────────

test('unlinking a row that points at a published pet clears the pet’s register number', () => {
  const body = functionBody(adminCode(), 'unlinkEntry');

  // A published animal has no draft left — publishDraft deletes it in the same
  // batch that creates the pet — but it still carries `registerNo` on its
  // public document. Clearing only the row would leave the row free to be
  // linked to a second animal while a published pet still claimed the number.
  assert.match(body, /collection|doc\(db, 'pets'/, 'unlinkEntry never looks at pets/');
  assert.match(
    body,
    /registerNo: null/,
    'unlinkEntry leaves pets/{petId}.registerNo pointing at a row that has let go of it',
  );
});

test('unlinking deletes nothing', () => {
  const body = functionBody(adminCode(), 'unlinkEntry');
  assert.equal(
    /deleteDoc|batch\.delete/.test(body),
    false,
    'unlinking destroys a record — it must only clear two fields',
  );
});

test('both sides of a link are written in one batch', () => {
  const body = functionBody(adminCode(), 'unlinkEntry');
  assert.match(body, /writeBatch\(db\)/, 'the two sides are no longer written atomically');
  assert.match(body, /batch\.commit\(\)/, 'the batch is never committed');
});

// ─────────────────────────────────────────────────────────────────────────────
// A register draft cannot be thrown away by the re-admission path
// ─────────────────────────────────────────────────────────────────────────────

test('reopening refuses a register draft BEFORE any photo is deleted', () => {
  const body = functionBody(wizardCode(), 'handleReopen');

  // The exact shape, not merely a mention of `draft.register`: a guard that
  // still reads `if (false && draft?.register)` — or that has picked up any
  // other condition — passes a "does it appear before deletePhotos" check
  // while doing nothing at all. Text is all this test can see, so it pins the
  // text.
  const guard = body.search(/if \(draft\?\.register\) \{/);
  const destroy = body.indexOf('deletePhotos(');
  assert.ok(
    guard >= 0,
    'handleReopen no longer refuses a register draft outright — check the condition has not been widened',
  );
  assert.ok(destroy >= 0, 'handleReopen no longer deletes photos — has this flow changed?');
  assert.ok(
    guard < destroy,
    'the register check runs after the photos are already gone: discardDraft then refuses, ' +
      'and the animal is left with no photographs and a draft nobody can remove',
  );
  assert.match(
    body.slice(guard, destroy),
    /return;/,
    'the guard does not return, so execution falls through to the deletion it exists to prevent',
  );
});

test('the wizard has a message for a draft it may not discard', () => {
  const body = functionBody(wizardCode(), 'report');
  assert.match(
    body,
    /register-linked-draft/,
    'RegisterLinkedDraftError falls through to "revisa tu conexión", which sends someone to the wrong problem',
  );
});
