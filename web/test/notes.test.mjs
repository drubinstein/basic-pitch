// Note names, hit testing for hover and click, and which notes sound under the playhead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { noteName, noteHz, noteAt, soundingAt } from '../src/notes.js';

test('notes are named with octave numbers, C4 = MIDI 60', () => {
  assert.deepEqual([21, 60, 61, 69, 70, 108].map(noteName), ['A0', 'C4', 'C♯4', 'A4', 'A♯4', 'C8']);
});

test('A4 is 440 Hz', () => {
  assert.equal(noteHz(69), 440);
  assert.ok(Math.abs(noteHz(60) - 261.626) < 1e-3);
});

const notes = [
  { t0: 1.0, t1: 2.0, pitch: 60 },
  { t0: 2.0, t1: 2.5, pitch: 60 },
  { t0: 1.5, t1: 3.0, pitch: 64 },
  { t0: 0.2, t1: 0.25, pitch: 67 },
];

test('the note under the pointer is found by pitch and time', () => {
  assert.equal(noteAt(notes, 1.2, 60), notes[0]);
  assert.equal(noteAt(notes, 2.2, 60), notes[1]);
  assert.equal(noteAt(notes, 1.2, 64), null);
  assert.equal(noteAt(notes, 1.2, 62), null);
});

test('short notes can be hit a little outside their ends', () => {
  assert.equal(noteAt(notes, 0.27, 67), null);
  assert.equal(noteAt(notes, 0.27, 67, 0.03), notes[3]);
  assert.equal(noteAt(notes, 0.18, 67, 0.03), notes[3]);
});

test('between two touching notes the closer one wins', () => {
  assert.equal(noteAt(notes, 1.99, 60, 0.05), notes[0]);
  assert.equal(noteAt(notes, 2.01, 60, 0.05), notes[1]);
});

test('sounding notes start at or before the playhead and end after it, lowest first', () => {
  assert.deepEqual(soundingAt(notes, 1.7), [notes[0], notes[2]]);
  assert.deepEqual(soundingAt(notes, 2.0), [notes[1], notes[2]]);
  assert.deepEqual(soundingAt(notes, 3.0), []);
  assert.deepEqual(soundingAt(notes, 0.1), []);
});
