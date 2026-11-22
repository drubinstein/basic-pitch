// Cached results are keyed by the file's bytes and the result version, and survive a round trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileKey, pack, unpack, RESULT_VERSION } from '../src/cache.js';
import { toByte } from '../src/pipeline.js';

test('file keys depend on the bytes and the result version', async () => {
  const a = await fileKey(new Uint8Array([1, 2, 3]).buffer), b = await fileKey(new Uint8Array([1, 2, 4]).buffer);
  assert.equal(a, await fileKey(new Uint8Array([1, 2, 3]).buffer));
  assert.notEqual(a, b);
  assert.ok(a.startsWith(`v${RESULT_VERSION}:`));
});

test('pack and unpack keep notes and activations', () => {
  const notes = [[0, 10, 60, 2, 12], [5, 40, 72, 9, 45]];
  const activation = Uint8Array.from({ length: 3 * 88 }, (_, i) => i % 256);
  const rec = unpack(structuredClone(pack({ key: 'k', name: 'x.wav', duration: 1.5, totalFrames: 3, notes, activation })));
  assert.deepEqual(rec.notes, notes);
  assert.deepEqual(rec.activation, activation);
  assert.equal(rec.totalFrames, 3);
  assert.equal(rec.name, 'x.wav');
});

test('activations are stored as bytes', () => {
  assert.deepEqual([...[0, 0.5, 1, 1.2, -0.1].map(toByte)], [0, 128, 255, 255, 0]);
});
