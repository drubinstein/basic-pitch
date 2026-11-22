// Basic Pitch's own note creation, ported from basic_pitch/note_creation.py
// (output_to_notes_polyphonic with infer_onsets, as predict() calls it): notes start at peaks of
// the onsets (plus onsets inferred from jumps in the note activations) and run until the note
// activation stays under the frame threshold; then the melodia trick turns the strongest leftover
// activations into notes too, strongest first. It needs the whole file, so it runs at the end.
// test/original.test.mjs checks the notes match the Python code exactly.
import { N_PITCHES as P, MIDI_OFFSET } from './pipeline.js';

export const ORIGINAL_DEFAULTS = { onsetThresh: 0.5, frameThresh: 0.3, minNoteLen: 11, energyTol: 11, melodia: true };
const MAX_FREQ_IDX = P - 1;

// frames, onsets: (n x 88) note and onset activations. Returns [start, end, pitch, amplitude] in
// the order the Python code makes them.
export function originalNotes(frames, onsets, opts = {}) {
  const { onsetThresh, frameThresh, minNoteLen, energyTol, melodia } = { ...ORIGINAL_DEFAULTS, ...opts };
  const n = frames.length / P;

  // get_infered_onsets with n_diff = 2, computed where needed instead of stored. Like numpy, a
  // file with no rises at all makes every inferred onset NaN (0 / 0), so there are no peaks.
  const rise = (t, f) => {
    if (t < 2) return 0;
    const x = frames[t * P + f], d = Math.min(x - frames[(t - 1) * P + f], x - frames[(t - 2) * P + f]);
    return d > 0 ? d : 0;
  };
  let maxRise = 0, maxOnset = -Infinity;
  for (let t = 0; t < n; t++) for (let f = 0; f < P; f++) maxRise = Math.max(maxRise, rise(t, f));
  for (const v of onsets) maxOnset = Math.max(maxOnset, v);
  const onset = (t, f) => Math.max(onsets[t * P + f], (maxOnset * rise(t, f)) / maxRise);

  // Onset peaks (strict local maxima in time; argrelmax never picks the first or last frame), in
  // time then pitch order, taken backwards.
  const starts = [];
  for (let t = 1; t < n - 1; t++) {
    for (let f = 0; f < P; f++) {
      const v = onset(t, f);
      if (v > onset(t - 1, f) && v > onset(t + 1, f) && v >= onsetThresh) starts.push(t * P + f);
    }
  }

  const remaining = Float32Array.from(frames); // float32 values or 0, so comparisons match float64
  const clear = (t, f) => {
    remaining[t * P + f] = 0;
    if (f < MAX_FREQ_IDX) remaining[t * P + f + 1] = 0;
    if (f > 0) remaining[t * P + f - 1] = 0;
  };
  const amplitude = (a, b, f) => { let s = 0; for (let t = a; t < b; t++) s += frames[t * P + f]; return s / (b - a); };
  const notes = [];

  for (let j = starts.length - 1; j >= 0; j--) {
    const start = Math.floor(starts[j] / P), f = starts[j] % P;
    if (start >= n - 1) continue;
    let i = start + 1, k = 0;
    while (i < n - 1 && k < energyTol) {
      k = remaining[i * P + f] < frameThresh ? k + 1 : 0;
      i++;
    }
    i -= k;
    if (i - start <= minNoteLen) continue;
    for (let t = start; t < i; t++) clear(t, f);
    notes.push([start, i, f + MIDI_OFFSET, amplitude(start, i, f)]);
  }

  if (melodia) {
    // np.argmax over what's left, until nothing is above the frame threshold. Cells are only
    // ever zeroed, so visiting the cells above the threshold strongest first (ties in row-major
    // order, like argmax) and skipping zeroed ones gives the same sequence of maxima.
    let count = 0;
    for (const v of remaining) if (v > frameThresh) count++;
    const order = new Uint32Array(count);
    for (let c = 0, j = 0; c < remaining.length; c++) if (remaining[c] > frameThresh) order[j++] = c;
    order.sort((a, b) => remaining[b] - remaining[a] || a - b);
    for (const c of order) {
      if (!(remaining[c] > frameThresh)) continue;
      const mid = Math.floor(c / P), f = c % P;
      remaining[c] = 0;
      let i = mid + 1, k = 0;
      while (i < n - 1 && k < energyTol) {
        k = remaining[i * P + f] < frameThresh ? k + 1 : 0;
        clear(i, f);
        i++;
      }
      const end = i - 1 - k;
      i = mid - 1;
      k = 0;
      while (i > 0 && k < energyTol) {
        k = remaining[i * P + f] < frameThresh ? k + 1 : 0;
        clear(i, f);
        i--;
      }
      const start = i + 1 + k;
      if (end - start <= minNoteLen) continue;
      notes.push([start, end, f + MIDI_OFFSET, amplitude(start, end, f)]);
    }
  }
  return notes;
}
