// MIDI files the way basic-pitch writes them (note_creation.note_events_to_midi via pretty_midi):
// 120 bpm, 220 ticks per beat, Electric Piano 1, velocity = round(127 * amplitude).
import test from 'node:test';
import assert from 'node:assert/strict';
import { toMidi, velocity } from '../src/midi.js';

// A small reader for what toMidi writes: header, then tracks of delta-timed events.
function readMidi(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (o, n) => String.fromCharCode(...bytes.subarray(o, o + n));
  assert.equal(str(0, 4), 'MThd');
  assert.equal(v.getUint32(4), 6);
  const head = { format: v.getUint16(8), tracks: v.getUint16(10), ppq: v.getUint16(12) }, tracks = [];
  let o = 14;
  for (let k = 0; k < head.tracks; k++) {
    assert.equal(str(o, 4), 'MTrk');
    const end = o + 8 + v.getUint32(o + 4), events = [];
    let p = o + 8, tick = 0, status = 0;
    const vlq = () => { let x = 0, b; do { b = bytes[p++]; x = (x << 7) | (b & 0x7f); } while (b & 0x80); return x; };
    while (p < end) {
      tick += vlq();
      if (bytes[p] & 0x80) status = bytes[p++];
      if (status === 0xff) {
        const type = bytes[p++], len = vlq();
        events.push({ tick, meta: type, data: [...bytes.subarray(p, p + len)] });
        p += len;
      } else if ((status & 0xf0) === 0xc0) events.push({ tick, program: bytes[p++] });
      else { events.push({ tick, kind: status & 0xf0, pitch: bytes[p], vel: bytes[p + 1] }); p += 2; }
    }
    assert.equal(p, end);
    tracks.push(events);
    o = end;
  }
  assert.equal(o, bytes.length);
  return { head, tracks };
}

test('velocity is 127 times the amplitude, kept to 1-127', () => {
  assert.deepEqual([0, 0.001, 0.5, 0.62, 1, 1.4].map(velocity), [1, 1, 64, 79, 127, 127]);
});

test('a file with a tempo track and a note track at 120 bpm, 220 ticks per beat', () => {
  const { head, tracks } = readMidi(toMidi([{ t0: 0.5, t1: 1, pitch: 60, velocity: 90 }]));
  assert.deepEqual(head, { format: 1, tracks: 2, ppq: 220 });
  assert.deepEqual(tracks[0].find((e) => e.meta === 0x51).data, [0x07, 0xa1, 0x20]); // 500000 us per beat
  assert.equal(tracks[1].find((e) => 'program' in e).program, 4); // Electric Piano 1
  for (const t of tracks) assert.equal(t[t.length - 1].meta, 0x2f); // end of track
});

test('notes land on the nearest tick, with their pitch and velocity', () => {
  const notes = [
    { t0: 1.0, t1: 1.5, pitch: 64, velocity: 70 },
    { t0: 0.1234, t1: 0.9, pitch: 60, velocity: 100 },
  ];
  const ev = readMidi(toMidi(notes)).tracks[1].filter((e) => e.kind);
  assert.deepEqual(ev, [
    { tick: 54, kind: 0x90, pitch: 60, vel: 100 },
    { tick: 396, kind: 0x90, pitch: 60, vel: 0 },
    { tick: 440, kind: 0x90, pitch: 64, vel: 70 },
    { tick: 660, kind: 0x90, pitch: 64, vel: 0 },
  ]);
});

test('a note ending where the next one at that pitch starts is released first', () => {
  const notes = [{ t0: 1, t1: 2, pitch: 60, velocity: 80 }, { t0: 0, t1: 1, pitch: 60, velocity: 80 }];
  const ev = readMidi(toMidi(notes)).tracks[1].filter((e) => e.kind && e.tick === 440);
  assert.deepEqual(ev.map((e) => e.vel), [0, 80]); // note-offs are note-ons with velocity 0, like pretty_midi's
});

test('notes shorter than a tick still last one tick', () => {
  const ev = readMidi(toMidi([{ t0: 1, t1: 1.0001, pitch: 60, velocity: 80 }])).tracks[1].filter((e) => e.kind);
  assert.deepEqual(ev.map((e) => e.tick), [440, 441]);
});

test('long files need multi-byte delta times', () => {
  const ev = readMidi(toMidi([{ t0: 3600, t1: 3601.5, pitch: 72, velocity: 50 }])).tracks[1].filter((e) => e.kind);
  assert.deepEqual(ev.map((e) => e.tick), [1584000, 1584660]);
});
