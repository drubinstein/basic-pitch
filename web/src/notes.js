// Note names and lookups for the piano roll: which note is under the pointer, and which notes sound
// under the playhead. Notes here are { t0, t1, pitch } with t1 exclusive, in seconds and MIDI pitch.
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

export const noteName = (pitch) => NAMES[pitch % 12] + (Math.floor(pitch / 12) - 1);
export const noteHz = (pitch) => 440 * 2 ** ((pitch - 69) / 12);

// The note at `pitch` covering time t, or within `slack` seconds of one (so short notes can be
// hit). Between two candidates the one t is closer to wins.
export function noteAt(notes, t, pitch, slack = 0) {
  let best = null, bestD = Infinity;
  for (const n of notes) {
    if (n.pitch !== pitch || t < n.t0 - slack || t >= n.t1 + slack) continue;
    const d = t < n.t0 ? n.t0 - t : t >= n.t1 ? t - n.t1 : 0;
    if (d < bestD) { best = n; bestD = d; }
  }
  return best;
}

// Notes sounding at time t, lowest first.
export const soundingAt = (notes, t) => notes.filter((n) => n.t0 <= t && t < n.t1).sort((a, b) => a.pitch - b.pitch);
