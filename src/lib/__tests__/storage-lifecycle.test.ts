/**
 * SOURCE guard on `terraform/storage.tf`'s lifecycle rules — the one place in
 * this repo where a one-character edit deletes applicants' identity photos.
 *
 * Why a source test and not just `terraform plan`: a plan shows what CHANGES,
 * and a reviewer reads it. Every unsafe variant below produces a plan that
 * looks reasonable — "a rule for adoption-ids/" — and the provider then sends
 * GCS something else. Measured on provider 6.50 (critic 2026-10-16, #1):
 *
 *   - `days_since_noncurrent_time = 0` is NOT SENT (no `send_*_if_zero`), so
 *     the rule reaches GCS as `{matchesPrefix: ["adoption-ids/"]}` alone, and
 *     GCS ANDs conditions: that matches EVERY live ID photo.
 *   - no `with_state` means "ANY": live objects match too.
 *   - an `age = N` condition deletes live photos N days after upload.
 *   - no or empty `matches_prefix` makes the rule bucket-wide, deleting the
 *     noncurrent pet photos and card scans — finding F1's decision, not this.
 *
 * And the list is ORDERED: the existing rule must stay first and unchanged,
 * or the plan reads as though rule 0 was rewritten.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ID_DOCUMENT_ROOT } from '../id-document-paths';

const ROOT = process.cwd();

/** HCL with `#` and `//` comments removed. No string in this file contains either. */
function hcl(): string {
  return readFileSync(join(ROOT, 'terraform', 'storage.tf'), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/(^|\s)(#|\/\/).*$/gm, '$1');
}

/** The text between the `{` at `open` and its matching `}`. */
function blockAt(source: string, open: number): string {
  assert.equal(source[open], '{', 'blockAt must start on a brace');
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced braces in terraform/storage.tf');
}

/** Every `name {` block directly inside `source`, in order. */
function blocks(source: string, name: string): string[] {
  const out: string[] = [];
  const pattern = new RegExp(`\\b${name}\\s*\\{`, 'g');
  for (const match of source.matchAll(pattern)) {
    out.push(blockAt(source, match.index! + match[0].length - 1));
  }
  return out;
}

/** `key = value` lines of a block, raw values, nested blocks excluded. */
function attributes(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of block.split('\n')) {
    const m = /^\s*([a-z_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}

function bucketBlock(): string {
  const source = hcl();
  const at = source.search(/resource\s+"google_storage_bucket"\s+"app"\s*\{/);
  assert.ok(at >= 0, 'google_storage_bucket.app not found');
  return blockAt(source, source.indexOf('{', at));
}

function rules(): { condition: Map<string, string>; action: Map<string, string> }[] {
  return blocks(bucketBlock(), 'lifecycle_rule').map((rule) => {
    const conditions = blocks(rule, 'condition');
    const actions = blocks(rule, 'action');
    assert.equal(conditions.length, 1, 'a lifecycle_rule has exactly one condition block');
    assert.equal(actions.length, 1, 'a lifecycle_rule has exactly one action block');
    return { condition: attributes(conditions[0]!), action: attributes(actions[0]!) };
  });
}

const PREFIX = `"${ID_DOCUMENT_ROOT}/"`;

function idRule() {
  const found = rules().filter((r) => r.condition.get('matches_prefix')?.includes(ID_DOCUMENT_ROOT));
  assert.equal(found.length, 1, `exactly one lifecycle_rule names ${ID_DOCUMENT_ROOT}/`);
  return found[0]!;
}

test('no lifecycle rule hides in a `dynamic "lifecycle_rule"` block — this file\'s block finder cannot see one (review 4b)', () => {
  // `blocks()` matches `lifecycle_rule {`; a `dynamic "lifecycle_rule" {` has a
  // quote before the brace and reads as ZERO rules, so every test below would
  // pass on a bucket whose real rules came from a for_each nobody checked.
  const source = hcl();
  assert.ok(!/\bdynamic\s+"lifecycle_rule"/.test(source), 'a dynamic "lifecycle_rule" block exists in terraform/storage.tf');
  // And every mention of the word inside the bucket is one of the static blocks counted.
  const mentions = bucketBlock().match(/\blifecycle_rule\b/g) ?? [];
  assert.equal(mentions.length, rules().length, 'lifecycle_rule appears in a form the block finder does not count');
});

test('the dynamic-block guard sees what it guards (control)', () => {
  const fake = 'dynamic "lifecycle_rule" {\n  for_each = [1]\n  content {\n    action { type = "Delete" }\n  }\n}';
  assert.ok(/\bdynamic\s+"lifecycle_rule"/.test(fake));
  assert.equal(blocks(fake, 'lifecycle_rule').length, 0, 'the static finder is blind to it — the reason the guard exists');
});

test('the bucket has exactly two lifecycle rules: the existing one FIRST, the adoption-ids one second', () => {
  const list = rules();
  assert.equal(list.length, 2, `expected 2 lifecycle_rule blocks, found ${list.length}`);
  assert.equal(list[1]!.condition.get('matches_prefix'), `[${PREFIX}]`, 'the adoption-ids rule must be appended LAST');
});

test('the existing rule is unchanged: age 90 AND 3 newer versions, delete, nothing else', () => {
  const first = rules()[0]!;
  assert.deepEqual(
    Object.fromEntries(first.condition),
    { age: '90', num_newer_versions: '3' },
    'rule 0 changed — that is not 4b’s decision',
  );
  assert.deepEqual(Object.fromEntries(first.action), { type: '"Delete"' });
});

test('the adoption-ids rule names exactly its prefix — never missing, never empty, never wider', () => {
  const { condition } = idRule();
  const prefix = condition.get('matches_prefix');
  assert.ok(prefix !== undefined, 'matches_prefix is missing: the rule would be BUCKET-WIDE');
  assert.equal(prefix, `[${PREFIX}]`, 'matches_prefix must be exactly ["adoption-ids/"], with the trailing slash');
});

test('the adoption-ids rule matches NONCURRENT versions only: with_state = "ARCHIVED"', () => {
  const { condition } = idRule();
  assert.equal(
    condition.get('with_state'),
    '"ARCHIVED"',
    'with_state must be "ARCHIVED" — omitted, the provider sends "ANY" and live ID photos match',
  );
});

test('days_since_noncurrent_time is a whole number of at least 1 — a 0 is dropped and the rule matches live photos', () => {
  const { condition } = idRule();
  const raw = condition.get('days_since_noncurrent_time');
  assert.ok(raw !== undefined, 'days_since_noncurrent_time is missing');
  assert.match(raw, /^\d+$/, 'days_since_noncurrent_time must be a literal whole number');
  assert.ok(Number(raw) >= 1, `days_since_noncurrent_time = ${raw}: provider 6.x does not send 0`);
});

test('the adoption-ids rule carries no other condition — no age, no num_newer_versions, no send_*_if_zero', () => {
  const { condition, action } = idRule();
  assert.deepEqual(
    [...condition.keys()].sort(),
    ['days_since_noncurrent_time', 'matches_prefix', 'with_state'],
  );
  for (const key of condition.keys()) assert.ok(!key.startsWith('send_'), `${key} must not be set`);
  assert.deepEqual(Object.fromEntries(action), { type: '"Delete"' });
});

test('versioning stays on: without it there is no noncurrent version to clean, and the rule is meaningless', () => {
  const versioning = blocks(bucketBlock(), 'versioning');
  assert.equal(versioning.length, 1);
  assert.equal(attributes(versioning[0]!).get('enabled'), 'true');
});
