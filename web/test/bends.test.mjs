// Pitch bends from the model's contour output, ported from basic_pitch.note_creation.get_pitch_bends,
// and written to MIDI the way note_events_to_midi does. References: web/tools/make_bend_fixture.py.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { bendRows, noteBends, bendsFromTiles, dropOverlapping, BINS } from '../src/bends.js';
import { toMidi } from '../src/midi.js';
import { frameToTime, N_PITCHES } from '../src/pipeline.js';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);
const ref = JSON.parse(fs.readFileSync(fixture('vocadito_10_bends.json')));
const original = JSON.parse(fs.readFileSync(fixture('vocadito_10_original.json'))).cases.find((c) => c.repeat === 1 && c.melodia && c.infer).notes;
const buf = zlib.gunzipSync(fs.readFileSync(fixture('vocadito_10_contour.f32.gz')));
const contour = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const T = contour.length / BINS;
const rows = bendRows(contour, T);

test('each frame and pitch gets the bend get_pitch_bends would give it', () => {
  assert.equal(rows.length, T * N_PITCHES);
  for (const [s, e, pitch, bends] of ref.bends) assert.deepEqual([...noteBends(rows, s, e, pitch)], bends, `note ${s}-${e} pitch ${pitch}`);
});

test('the lowest and highest pitches use the edges of the contour', () => {
  // A contour with its peak at bin 0 bends A0 by 0 bins, and C8's window ends at the last bin.
  const frame = new Float32Array(BINS);
  frame[0] = 1;
  assert.equal(bendRows(frame, 1)[0], 0);
  frame.fill(0);
  frame[BINS - 1] = 1;
  assert.equal(bendRows(frame, 1)[N_PITCHES - 1], BINS - 1 - 3 * 87);
});

test('notes that overlap another note lose their bends, like one MIDI channel needs', () => {
  const notes = [{ t0: 0, t1: 1, pitch: 60, bends: [1] }, { t0: 0.5, t1: 2, pitch: 64, bends: [2] }, { t0: 3, t1: 4, pitch: 67, bends: [3] }];
  assert.deepEqual(dropOverlapping(notes).map((n) => n.bends), [null, null, [3]]);
});

test('MIDI pitch-wheel and note events match basic-pitch\'s file', () => {
  const notes = original.map(([s, e, pitch, amp]) => ({ t0: frameToTime(s), t1: frameToTime(e), pitch, velocity: Math.round(127 * amp), bends: [...noteBends(rows, s, e, pitch)] }));
  const bytes = toMidi(notes);
  // Read back the note track: delta times, running status not used.
  const v = new DataView(bytes.buffer);
  let o = 14;
  o += 8 + v.getUint32(o + 4); // tempo track
  const end = o + 8 + v.getUint32(o + 4), got = [];
  let p = o + 8, tick = 0;
  const vlq = () => { let x = 0, b; do { b = bytes[p++]; x = (x << 7) | (b & 0x7f); } while (b & 0x80); return x; };
  while (p < end) {
    tick += vlq();
    const status = bytes[p++];
    if (status === 0xff) { p++; const len = vlq(); p += len; continue; }
    const kind = status & 0xf0;
    if (kind === 0xc0) { p++; continue; }
    const a = bytes[p++], b = bytes[p++];
    if (kind === 0xe0) got.push(['bend', tick, ((b << 7) | a) - 8192]);
    else got.push([kind === 0x90 && b > 0 ? 'on' : 'off', tick, a]);
  }
  assert.equal(ref.ppq, 220);
  assert.deepEqual(got, ref.midi);
});

test('bends for a note across windows come from the per-window rows the page keeps', () => {
  const F = 142, tiles = [];
  for (let w = 0; w * F < T; w++) tiles.push(rows.slice(w * F * N_PITCHES, Math.min(T, (w + 1) * F) * N_PITCHES));
  for (const [s, e, pitch, bends] of ref.bends) assert.deepEqual([...bendsFromTiles(tiles, F, s, e, pitch)], bends);
  assert.deepEqual([...bendsFromTiles([tiles[0], null], F, 140, 145, 60)].slice(2), [0, 0, 0], 'missing windows bend by 0');
});
