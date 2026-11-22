// Playing the transcribed notes over the song: which notes to schedule next, how loud, and how the
// song and the notes are mixed for each listening choice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { byStart, startingIn, voiceGain, mix, PRESETS, preset } from '../src/synth.js';

const notes = byStart([
  { t0: 2.0, t1: 2.5, pitch: 64, velocity: 80 },
  { t0: 0.5, t1: 3.0, pitch: 48, velocity: 100 },
  { t0: 1.0, t1: 1.2, pitch: 60, velocity: 60 },
  { t0: 1.0, t1: 1.4, pitch: 67, velocity: 60 },
]);

test('notes are kept in start order', () => {
  assert.deepEqual(notes.map((n) => n.t0), [0.5, 1.0, 1.0, 2.0]);
});

test('the notes starting in a stretch of time, found by binary search', () => {
  assert.deepEqual(startingIn(notes, 0.9, 1.5).map((n) => n.pitch), [60, 67]);
  assert.deepEqual(startingIn(notes, 1.0, 1.0001).map((n) => n.pitch), [60, 67]);
  assert.deepEqual(startingIn(notes, 1.0001, 2.0).map((n) => n.pitch), []);
  assert.deepEqual(startingIn(notes, 0, 10).length, 4);
  assert.deepEqual(startingIn([], 0, 10), []);
});

test('louder notes play louder, and silence stays silent', () => {
  assert.equal(voiceGain(0), 0);
  assert.ok(voiceGain(127) > voiceGain(64) && voiceGain(64) > voiceGain(10));
  assert.ok(voiceGain(127) <= 0.25, 'room for a few voices at once');
});

test('the mix crossfades from the song (-1) to the notes (+1) at equal power', () => {
  assert.deepEqual(mix(-1), { song: 1, notes: 0 });
  const close = (a, b) => Math.abs(a - b) < 1e-12;
  const right = mix(1), even = mix(0), quarter = mix(-0.5);
  assert.ok(close(right.song, 0) && close(right.notes, 1));
  assert.ok(close(even.song, Math.SQRT1_2) && close(even.notes, Math.SQRT1_2));
  assert.ok(quarter.song > quarter.notes && close(quarter.song ** 2 + quarter.notes ** 2, 1));
});

test('song, notes and both are presets of the mix', () => {
  assert.deepEqual(PRESETS, { song: -1, both: 0, notes: 1 });
  assert.deepEqual([-1, -0.4, 0, 0.6, 1].map(preset), ['song', 'both', 'both', 'both', 'notes']);
});
