// Standard MIDI files the way basic-pitch writes them (note_creation.note_events_to_midi, through
// pretty_midi): a tempo track at 120 bpm, 220 ticks per beat, and one Electric Piano 1 track with
// velocity = round(127 * the note's mean activation). Pitch bends aren't written.
const PPQ = 220, TEMPO_US = 500000, PROGRAM = 4; // Electric Piano 1
const TICKS_PER_SECOND = (PPQ * 1e6) / TEMPO_US;

// numpy rounds halves to even; kept within 1-127 (a note-on with velocity 0 would be a note-off).
export function velocity(amplitude) {
  const x = 127 * amplitude;
  let r = Math.round(x);
  if (r - x === 0.5 && r % 2) r -= 1;
  return Math.min(127, Math.max(1, r));
}

const vlq = (n) => {
  const out = [n & 0x7f];
  while ((n >>>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
};

function chunk(type, body) {
  const n = body.length;
  return [...type].map((c) => c.charCodeAt(0)).concat([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255], body);
}

// notes: [{ t0, t1, pitch, velocity }] in seconds. Returns the file's bytes.
export function toMidi(notes) {
  const events = [];
  for (const n of notes) {
    const on = Math.round(n.t0 * TICKS_PER_SECOND), off = Math.max(on + 1, Math.round(n.t1 * TICKS_PER_SECOND));
    events.push([on, 1, n.pitch, n.velocity], [off, 0, n.pitch, 0]);
  }
  // By time, releases before new notes so a note can restart where the last one at its pitch ended.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);

  const tempo = [0, 0xff, 0x51, 3, (TEMPO_US >> 16) & 255, (TEMPO_US >> 8) & 255, TEMPO_US & 255, 0, 0xff, 0x2f, 0];
  const track = [0, 0xc0, PROGRAM];
  let tick = 0;
  for (const [t, on, pitch, vel] of events) {
    track.push(...vlq(t - tick), on ? 0x90 : 0x80, pitch, vel);
    tick = t;
  }
  track.push(0, 0xff, 0x2f, 0);
  const header = chunk('MThd', [0, 1, 0, 2, (PPQ >> 8) & 255, PPQ & 255]);
  return Uint8Array.from([...header, ...chunk('MTrk', tempo), ...chunk('MTrk', track)]);
}
