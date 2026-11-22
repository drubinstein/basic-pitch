// The pedalboard's knobs and switches for each decoder: ranges, defaults (the decoders' own
// defaults) and how knob settings map onto each decoder's options.
const MS_PER_FRAME = (1000 * 256) / 22050;
const ms = (frames) => `${Math.round(frames * MS_PER_FRAME)} ms`;
const fixed = (d) => (v) => v.toFixed(d);

// The streaming HMM (src/hmm.js): frame and onset thresholds and weights, the state counts, and
// how long a decision may wait.
export const LIVE = [
  { key: 'theta_f', label: 'Note threshold', min: 0.05, max: 0.95, step: 0.01, default: 0.4, format: fixed(2), hint: 'Note activation that counts as “on”' },
  { key: 'theta_o', label: 'Onset threshold', min: 0.05, max: 0.95, step: 0.01, default: 0.5, format: fixed(2), hint: 'Onset activation that counts as a new note' },
  { key: 'alpha', label: 'Onset weight', min: 0, max: 12, step: 0.1, default: 4, format: fixed(1), hint: 'How much onsets matter when starting a note' },
  { key: 'm', label: 'Attack', min: 1, max: 12, step: 1, default: 4, format: ms, hint: 'Frames a note must last before it can end' },
  { key: 'g', label: 'Gap', min: 1, max: 20, step: 1, default: 5, format: ms, hint: 'Longest dip inside a held note' },
  { key: 'maxLag', label: 'Max lag', min: 10, max: 140, step: 1, default: 100, format: ms, hint: 'Longest the decoder may wait before committing' },
  { key: 'w', label: 'Note weight', min: 0.2, max: 3, step: 0.05, default: 1, format: fixed(2), row: 'more', hint: 'How much the note activation matters' },
  { key: 'b_on', label: 'Onset bonus', min: -20, max: 10, step: 0.5, default: -4, format: fixed(1), row: 'more', hint: 'Score for starting a note at an onset' },
  { key: 'b_mel', label: 'No-onset start', min: -40, max: 0, step: 0.5, default: -10, format: fixed(1), row: 'more', hint: 'Score for starting a note without an onset' },
  { key: 'gamma', label: 'Early exit', min: 0, max: 50, step: 0.5, default: 10, format: fixed(1), row: 'more', hint: 'Cost of ending a note during its attack' },
  { key: 'b_re', label: 'Re-strike', min: -20, max: 20, step: 0.5, default: 0, format: fixed(1), row: 'more', hint: 'Score for a new note at a pitch that is still on' },
  { key: 'beam', label: 'Beam', min: 0.5, max: 10, step: 0.25, default: 2, format: fixed(2), row: 'more', hint: 'Paths within this score of the best one must agree before a frame is final' },
];

// Basic Pitch's own note creation (src/original.js), with predict()'s defaults.
export const ORIGINAL = [
  { key: 'onsetThresh', label: 'Onset threshold', min: 0.05, max: 0.95, step: 0.01, default: 0.5, format: fixed(2), hint: 'Onset peaks below this are ignored' },
  { key: 'frameThresh', label: 'Frame threshold', min: 0.05, max: 0.95, step: 0.01, default: 0.3, format: fixed(2), hint: 'Note activation that keeps a note going' },
  { key: 'minNoteLen', label: 'Min length', min: 0, max: 40, step: 1, default: 11, format: ms, hint: 'Shorter notes are dropped' },
  { key: 'energyTol', label: 'Tolerance', min: 1, max: 40, step: 1, default: 11, format: ms, hint: 'How long a note may stay under the threshold before it ends' },
  { key: 'melodia', label: 'Melodia trick', kind: 'switch', default: true, hint: 'Also make notes from strong activations without an onset' },
  { key: 'inferOnsets', label: 'Infer onsets', kind: 'switch', default: true, hint: 'Add onsets where the note activation jumps' },
];

export const defaults = (defs) => Object.fromEntries(defs.map((d) => [d.key, d.default]));
export const isDefault = (defs, p) => defs.every((d) => p[d.key] === d.default);

export function hmmOptions(p) {
  const { theta_f, theta_o, w, alpha, b_on, b_mel, gamma, b_re, m, g, beam, maxLag } = p;
  return { prm: { theta_f, theta_o, w, alpha, b_on, b_mel, gamma, b_re, m, g }, beam, maxLag };
}

export function originalOptions(p) {
  const { onsetThresh, frameThresh, minNoteLen, energyTol, melodia, inferOnsets } = p;
  return { onsetThresh, frameThresh, minNoteLen, energyTol, melodia, inferOnsets };
}
