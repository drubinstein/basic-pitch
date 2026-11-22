// Pitch bends from the model's contour output (264 bins, 3 per semitone, from A0), ported from
// basic_pitch.note_creation.get_pitch_bends: for each frame of a note, the bin within 25 bins of the
// note's own that is strongest after a Gaussian weighting (std 5 bins), as an offset in 1/3 semitones.
// That only depends on the frame and the pitch, so the worker computes it for all 88 pitches as each
// window arrives (88 bytes a frame), and a note's bends are a slice of that. test/bends.test.mjs checks
// it against the Python code.
import { N_PITCHES } from './pipeline.js';

export const BINS = 264;
export const BINS_PER_SEMITONE = 3;
const TOL = 25, WIN = 2 * TOL + 1;
// scipy.signal.windows.gaussian(51, std=5)
const GAUSS = Float64Array.from({ length: WIN }, (_, n) => Math.exp(-((n - TOL) * (n - TOL)) / 50));

// contour: frames x 264. Returns frames x 88 bends (in bins) as an Int8Array.
export function bendRows(contour, frames) {
  const rows = new Int8Array(frames * N_PITCHES);
  for (let t = 0; t < frames; t++) {
    const c = t * BINS;
    for (let p = 0; p < N_PITCHES; p++) {
      const center = BINS_PER_SEMITONE * p, from = Math.max(center - TOL, 0), to = Math.min(BINS, center + TOL + 1), g0 = Math.max(0, TOL - center);
      let best = -Infinity, arg = 0;
      for (let b = from; b < to; b++) {
        const v = contour[c + b] * GAUSS[g0 + b - from];
        if (v > best) { best = v; arg = b - from; }
      }
      rows[t * N_PITCHES + p] = arg - (TOL - g0);
    }
  }
  return rows;
}

// The bends of a note at MIDI `pitch` over frames [s, e), from rows (or anything with a row getter).
export function noteBends(rows, s, e, pitch) {
  const out = new Int8Array(Math.max(0, e - s));
  for (let t = s; t < e; t++) out[t - s] = rows[t * N_PITCHES + pitch - 21];
  return out;
}

// One MIDI channel bends every note at once, so like basic-pitch (multiple_pitch_bends=False), notes
// that overlap another note in time lose their bends. Notes: { t0, t1, pitch, velocity, bends }.
export function dropOverlapping(notes) {
  const sorted = notes.map((n) => ({ ...n })).sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1 || a.pitch - b.pitch || a.velocity - b.velocity);
  for (let i = 0; i < sorted.length - 1; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].t0 >= sorted[i].t1) break;
      sorted[i].bends = null;
      sorted[j].bends = null;
    }
  }
  return sorted;
}
