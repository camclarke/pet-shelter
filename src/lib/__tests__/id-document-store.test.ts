import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ID_DOCUMENT_ROOT,
  InvalidIdDocumentPathError,
  idDocumentPath,
  idDocumentPrefix,
  isIdDocumentSide,
} from '../id-document-paths';
import {
  ID_DOCUMENT_CACHE_CONTROL,
  deleteEveryIdDocumentVersion,
  readIdDocumentReceipt,
  saveIdDocument,
  type IdDocumentBucket,
} from '../id-document-store';

const APP = 'pet01__uid01';

// ─── paths ───────────────────────────────────────────────────────────────────

test('the path is adoption-ids/{id}/{side}.jpg, and the prefix ends in a slash', () => {
  assert.equal(ID_DOCUMENT_ROOT, 'adoption-ids');
  assert.equal(idDocumentPrefix(APP), 'adoption-ids/pet01__uid01/');
  assert.equal(idDocumentPath(APP, 'front'), 'adoption-ids/pet01__uid01/front.jpg');
  assert.equal(idDocumentPath(APP, 'back'), 'adoption-ids/pet01__uid01/back.jpg');
  // The slash is what keeps a delete for uid1 off uid10's folder.
  assert.ok(!'adoption-ids/pet01__uid010/front.jpg'.startsWith(idDocumentPrefix(APP)));
});

test('a path can only name a real application shape — never ../, an empty segment, or no separator', () => {
  for (const bad of ['', 'nouid', 'a__b__c', '__uid', 'pet__', 'pet__../x', 'pet/x__uid', '../__uid', 'a__b/c']) {
    assert.throws(() => idDocumentPrefix(bad), InvalidIdDocumentPathError, JSON.stringify(bad));
    assert.throws(() => idDocumentPath(bad, 'front'), InvalidIdDocumentPathError, JSON.stringify(bad));
  }
});

test('only front and back are sides — never front.jpg, never a path', () => {
  assert.equal(isIdDocumentSide('front'), true);
  assert.equal(isIdDocumentSide('back'), true);
  for (const bad of ['front.jpg', 'Front', '', '../front', 'side', null, 1]) {
    assert.equal(isIdDocumentSide(bad), false, String(bad));
  }
  assert.throws(() => idDocumentPath(APP, 'front.jpg' as never), InvalidIdDocumentPathError);
});

// ─── a fake bucket ───────────────────────────────────────────────────────────

function fakeBucket(behaviour: {
  save?: () => Promise<void>;
  metadataAfterSave?: { generation?: string | number; size?: string | number };
  getMetadata?: () => Promise<[{ generation?: string | number; size?: string | number }]>;
} = {}) {
  const calls: { op: string; path?: string; args?: unknown }[] = [];
  const bucket: IdDocumentBucket = {
    file(path) {
      const file = {
        metadata: undefined as { generation?: string | number; size?: string | number } | undefined,
        async save(data: Buffer, options: unknown) {
          calls.push({ op: 'save', path, args: { length: data.length, options } });
          await (behaviour.save ?? (async () => undefined))();
          file.metadata = behaviour.metadataAfterSave ?? { generation: '1760000000000001', size: String(data.length) };
        },
        async getMetadata() {
          calls.push({ op: 'getMetadata', path });
          return (behaviour.getMetadata ?? (async () => [{ generation: '1760000000000001', size: '900' }] as [{ generation: string; size: string }]))();
        },
      };
      return file;
    },
    async deleteFiles(query) {
      calls.push({ op: 'deleteFiles', args: query });
    },
  };
  return { bucket, calls };
}

// ─── save ────────────────────────────────────────────────────────────────────

test('save is CREATE-ONLY, simple, image/jpeg and never cached', async () => {
  const { bucket, calls } = fakeBucket();
  const outcome = await saveIdDocument(bucket, APP, 'front', new Uint8Array(1234));
  assert.deepEqual(outcome, { outcome: 'saved', generation: '1760000000000001', bytes: 1234 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.path, 'adoption-ids/pet01__uid01/front.jpg');
  assert.deepEqual(calls[0]!.args, {
    length: 1234,
    options: {
      resumable: false,
      contentType: 'image/jpeg',
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: { cacheControl: 'private, no-store' },
    },
  });
  assert.equal(ID_DOCUMENT_CACHE_CONTROL, 'private, no-store');
});

test('the generation is kept as a string, even when GCS returns a number', async () => {
  const { bucket } = fakeBucket({ metadataAfterSave: { generation: 1760000000000002 } });
  const outcome = await saveIdDocument(bucket, APP, 'front', new Uint8Array(10));
  assert.deepEqual(outcome, { outcome: 'saved', generation: '1760000000000002', bytes: 10 });
});

test('an object already at the path (412) is "exists", never an overwrite and never a throw', async () => {
  const { bucket } = fakeBucket({
    save: async () => {
      throw Object.assign(new Error('precondition'), { code: 412 });
    },
  });
  assert.deepEqual(await saveIdDocument(bucket, APP, 'front', new Uint8Array(10)), { outcome: 'exists' });
});

test('any other save failure is rethrown, and a save with no generation is an error', async () => {
  const failing = fakeBucket({
    save: async () => {
      throw Object.assign(new Error('boom'), { code: 503 });
    },
  });
  await assert.rejects(saveIdDocument(failing.bucket, APP, 'front', new Uint8Array(10)), /boom/);
  const blank = fakeBucket({ metadataAfterSave: {} });
  await assert.rejects(saveIdDocument(blank.bucket, APP, 'front', new Uint8Array(10)), /no generation/);
});

test('an invalid id never reaches the bucket', async () => {
  const { bucket, calls } = fakeBucket();
  await assert.rejects(saveIdDocument(bucket, '../x', 'front', new Uint8Array(1)), InvalidIdDocumentPathError);
  await assert.rejects(deleteEveryIdDocumentVersion(bucket, 'x'), InvalidIdDocumentPathError);
  assert.equal(calls.length, 0);
});

// ─── the receipt of what is already stored ──────────────────────────────────

test('the stored receipt is read from the object metadata; a missing object is null', async () => {
  assert.deepEqual(await readIdDocumentReceipt(fakeBucket().bucket, APP, 'front'), {
    generation: '1760000000000001',
    bytes: 900,
  });
  const gone = fakeBucket({
    getMetadata: async () => {
      throw Object.assign(new Error('not found'), { code: 404 });
    },
  });
  assert.equal(await readIdDocumentReceipt(gone.bucket, APP, 'front'), null);
  const odd = fakeBucket({ getMetadata: async () => [{ generation: '1', size: 'lots' }] });
  assert.equal(await readIdDocumentReceipt(odd.bucket, APP, 'front'), null);
});

// ─── deletion ────────────────────────────────────────────────────────────────

test('deleting ALWAYS names every version, under the slash-terminated prefix', async () => {
  const { bucket, calls } = fakeBucket();
  await deleteEveryIdDocumentVersion(bucket, APP);
  assert.deepEqual(calls, [{ op: 'deleteFiles', args: { prefix: 'adoption-ids/pet01__uid01/', versions: true } }]);
});

test('deleting ONE side names every version of that object only — never the other side, never the folder', async () => {
  const { bucket, calls } = fakeBucket();
  await deleteEveryIdDocumentVersion(bucket, APP, 'front');
  await deleteEveryIdDocumentVersion(bucket, APP, 'back');
  assert.deepEqual(calls, [
    { op: 'deleteFiles', args: { prefix: 'adoption-ids/pet01__uid01/front.jpg', versions: true } },
    { op: 'deleteFiles', args: { prefix: 'adoption-ids/pet01__uid01/back.jpg', versions: true } },
  ]);
  const none = fakeBucket();
  await assert.rejects(deleteEveryIdDocumentVersion(none.bucket, APP, 'front.jpg' as never), InvalidIdDocumentPathError);
  await assert.rejects(deleteEveryIdDocumentVersion(none.bucket, '../x', 'front'), InvalidIdDocumentPathError);
  assert.equal(none.calls.length, 0, 'an invalid side or id never reaches the bucket');
});
