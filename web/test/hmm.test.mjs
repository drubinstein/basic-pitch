// The JS streaming HMM must give exactly the notes the Python decoder gives on the same posteriors.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { StreamingHmm } from '../src/hmm.js';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);
const ref = JSON.parse(fs.readFileSync(fixture('vocadito_10_hmm.json')));
const load = (name) => {
  const buf = zlib.gunzipSync(fs.readFileSync(fixture(name)));
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
};
const note = load('vocadito_10_note.f32.gz'), onset = load('vocadito_10_onset.f32.gz');
const key = (n) => n.join(',');

function decode(onNotes) {
  const hmm = new StreamingHmm(ref.prm, { beam: ref.beam, maxLag: ref.max_lag });
  for (let t = 0; t < ref.T; t++) {
    hmm.push(note.subarray(t * 88, t * 88 + 88), onset.subarray(t * 88, t * 88 + 88));
    if (t % 142 === 141) onNotes(hmm.drain());
  }
  return hmm;
}

test('notes match the Python streaming HMM on vocadito_10', () => {
  assert.equal(note.length, ref.T * 88);
  const hmm = decode(() => {});
  const got = hmm.finish().map(key).sort(), want = ref.notes.map(key).sort();
  assert.deepEqual(got, want);
});

test('notes drained while streaming plus finish() are the same notes, each once', () => {
  const streamed = [];
  const hmm = decode((notes) => streamed.push(...notes));
  assert.ok(streamed.length > 0, 'some notes are final before the end');
  const all = hmm.finish().map(key).sort();
  const rest = hmm.drain();
  assert.deepEqual([...streamed, ...rest].map(key).sort(), all);
  assert.equal(new Set(all).size, all.length);
});

test('decodes inputs of any length (no per-frame history kept)', () => {
  const hmm = new StreamingHmm(ref.prm, { beam: ref.beam, maxLag: ref.max_lag });
  const frames = (1 << 16) + 1000; // more than the old default capacity
  for (let i = 0; i < frames; i++) {
    const t = i % ref.T;
    hmm.push(note.subarray(t * 88, t * 88 + 88), onset.subarray(t * 88, t * 88 + 88));
  }
  const notes = hmm.finish();
  assert.ok(notes.length > (ref.notes.length * frames) / ref.T / 2);
  assert.ok(notes.every(([s, e]) => s >= 0 && e > s && e <= frames));
});
