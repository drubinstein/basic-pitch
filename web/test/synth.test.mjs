// Playing the transcribed notes over the song: which notes to schedule next, how loud, and how the
// song and the notes are mixed for each listening choice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { byStart, startingIn, voiceGain, mix } from '../src/synth.js';

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

test('song, notes or both', () => {
  assert.deepEqual(mix('song'), { song: 1, notes: 0 });
  assert.deepEqual(mix('notes'), { song: 0, notes: 1 });
  const both = mix('both');
  assert.ok(both.song > 0 && both.notes > 0);
});
