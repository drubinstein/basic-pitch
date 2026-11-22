// Standard MIDI files the way basic-pitch writes them (note_creation.note_events_to_midi, through
// pretty_midi): a tempo track at 120 bpm, 220 ticks per beat, and one Electric Piano 1 track with
// velocity = round(127 * the note's mean activation) and each note's pitch bends spread evenly over it
// (dropped for notes that overlap another, since one channel bends every note).
import { BINS_PER_SEMITONE, dropOverlapping } from './bends.js';

const PPQ = 220, TEMPO_US = 500000, PROGRAM = 4; // Electric Piano 1
const SECONDS_PER_TICK = TEMPO_US / 1e6 / PPQ;
const BEND_SCALE = 4096; // pitch-wheel units per semitone (+-2 semitones in all)

// pretty_midi's time_to_tick: the nearest tick, the later one on a tie.
function toTick(t) {
  let k = Math.max(0, Math.ceil(t / SECONDS_PER_TICK));
  while (k > 0 && SECONDS_PER_TICK * (k - 1) >= t) k--;
  while (SECONDS_PER_TICK * k < t) k++;
  return k > 0 && Math.abs(t - SECONDS_PER_TICK * (k - 1)) < Math.abs(t - SECONDS_PER_TICK * k) ? k - 1 : k;
}

const roundHalfEven = (x) => { const r = Math.round(x); return r - x === 0.5 && r % 2 ? r - 1 : r; };

// numpy rounds halves to even; kept within 1-127 (a note-on with velocity 0 would be a note-off).
export const velocity = (amplitude) => Math.min(127, Math.max(1, roundHalfEven(127 * amplitude)));

const vlq = (n) => {
  const out = [n & 0x7f];
  while ((n >>>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
};

function chunk(type, body) {
  const n = body.length;
  return [...type].map((c) => c.charCodeAt(0)).concat([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255], body);
}

// notes: [{ t0, t1, pitch, velocity, bends? }] in seconds; bends in 1/3 semitones, one per frame.
// Returns the file's bytes.
export function toMidi(notes) {
  // [tick, order, status, data1, data2]. Like pretty_midi, a note-off is a note-on with velocity 0, and at
  // the same tick pitch bends come first (by value), then notes by pitch and velocity, so a note ends
  // before the next one at its pitch starts.
  const events = [];
  for (const n of dropOverlapping(notes)) {
    const on = toTick(n.t0), off = Math.max(on + 1, toTick(n.t1));
    events.push([on, 10 * 65536 + n.pitch * 256 + n.velocity, 0x90, n.pitch, n.velocity], [off, 10 * 65536 + n.pitch * 256, 0x90, n.pitch, 0]);
    const bends = n.bends ?? [], step = bends.length > 1 ? (n.t1 - n.t0) / (bends.length - 1) : 0;
    bends.forEach((b, i) => {
      // numpy.linspace(t0, t1, len(bends)), then the bend in pitch-wheel units.
      const t = i === bends.length - 1 ? n.t1 : i * step + n.t0;
      const v = Math.min(8191, Math.max(-8192, roundHalfEven((b * BEND_SCALE) / BINS_PER_SEMITONE)));
      events.push([toTick(t), 7 * 65536 + v, 0xe0, (v + 8192) & 0x7f, (v + 8192) >> 7]);
    });
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const tempo = [0, 0xff, 0x51, 3, (TEMPO_US >> 16) & 255, (TEMPO_US >> 8) & 255, TEMPO_US & 255, 0, 0xff, 0x2f, 0];
  const track = [0, 0xc0, PROGRAM];
  let tick = 0;
  for (const [t, , status, a, b] of events) {
    track.push(...vlq(t - tick), status, a, b);
    tick = t;
  }
  track.push(0, 0xff, 0x2f, 0);
  const header = chunk('MThd', [0, 1, 0, 2, (PPQ >> 8) & 255, PPQ & 255]);
  return Uint8Array.from([...header, ...chunk('MTrk', tempo), ...chunk('MTrk', track)]);
}
