// Basic Pitch's own note creation (onset peaks, then the melodia trick), ported from
// basic_pitch/note_creation.py: the notes must match the Python code exactly, in the same order.
// Reference: web/tools/make_original_fixture.py.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { originalNotes } from '../src/original.js';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);
const ref = JSON.parse(fs.readFileSync(fixture('vocadito_10_original.json')));
const load = (name) => {
  const buf = zlib.gunzipSync(fs.readFileSync(fixture(name)));
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
};
const note = load('vocadito_10_note.f32.gz'), onset = load('vocadito_10_onset.f32.gz');
const tile = (x, n) => { const out = new Float32Array(x.length * n); for (let r = 0; r < n; r++) out.set(x, r * x.length); return out; };

for (const c of ref.cases) {
  test(`same notes as Python, ${c.repeat}x the example, melodia trick ${c.melodia ? 'on' : 'off'}`, () => {
    const got = originalNotes(tile(note, c.repeat), tile(onset, c.repeat), {
      onsetThresh: ref.onset_thresh, frameThresh: ref.frame_thresh, minNoteLen: ref.min_note_len, energyTol: ref.energy_tol, melodia: c.melodia,
    });
    assert.deepEqual(got.map((n) => n.slice(0, 3)), c.notes.map((n) => n.slice(0, 3)));
    got.forEach((n, i) => assert.ok(Math.abs(n[3] - c.notes[i][3]) < 1e-5, `amplitude of note ${i}`));
  });
}

test('the defaults are predict()\'s: melodia trick on', () => {
  const want = ref.cases.find((c) => c.repeat === 1 && c.melodia).notes.map((n) => n.slice(0, 3));
  assert.deepEqual(originalNotes(note, onset).map((n) => n.slice(0, 3)), want);
});

test('silence gives no notes', () => {
  assert.deepEqual(originalNotes(new Float32Array(50 * 88), new Float32Array(50 * 88)), []);
});
