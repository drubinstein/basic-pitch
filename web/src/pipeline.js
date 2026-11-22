// Windowing and frame timing, ported from basic_pitch/inference.py (get_audio_input, unwrap_output)
// and basic_pitch/note_creation.py (model_frames_to_time). Keep these in step with the Python code.

export const SAMPLE_RATE = 22050;
export const FFT_HOP = 256;
export const ANNOTATIONS_FPS = Math.floor(SAMPLE_RATE / FFT_HOP); // 86
export const ANNOT_N_FRAMES = ANNOTATIONS_FPS * 2; // 172 frames per model window
export const AUDIO_N_SAMPLES = SAMPLE_RATE * 2 - FFT_HOP; // 43844 samples per model window
export const N_OVERLAPPING_FRAMES = 30;
export const OVERLAP_LEN = N_OVERLAPPING_FRAMES * FFT_HOP; // 7680
export const HOP = AUDIO_N_SAMPLES - OVERLAP_LEN; // 36164
export const FRAMES_PER_WINDOW = ANNOT_N_FRAMES - N_OVERLAPPING_FRAMES; // 142 frames kept per window
export const N_PITCHES = 88;
export const MIDI_OFFSET = 21;

const PAD = OVERLAP_LEN / 2;

// range(0, len(padded audio), hop) in get_audio_input
export const nWindows = (nSamples) => Math.ceil((nSamples + PAD) / HOP);

// unwrap_output trims the concatenated frames to int(n_samples / hop * frames_per_window)
export const nOutputFrames = (nSamples) => Math.trunc((nSamples / HOP) * FRAMES_PER_WINDOW);

// Window w of the audio with PAD zeros prepended and zeros appended, as the model input.
export function windowAt(audio, w) {
  const out = new Float32Array(AUDIO_N_SAMPLES);
  const start = w * HOP - PAD;
  const from = Math.max(0, start), to = Math.min(audio.length, start + AUDIO_N_SAMPLES);
  if (to > from) out.set(audio.subarray(from, to), from - start);
  return out;
}

// Drop half the overlapping frames from each end of one window's (172 x nBins) output.
export function windowFrames(output, nBins) {
  const half = N_OVERLAPPING_FRAMES / 2;
  return output.subarray(half * nBins, (ANNOT_N_FRAMES - half) * nBins);
}

// note_creation.model_frames_to_time for one frame index.
const WINDOW_OFFSET = (FFT_HOP / SAMPLE_RATE) * (ANNOT_N_FRAMES - AUDIO_N_SAMPLES / FFT_HOP) + 0.0018;
export const frameToTime = (i) => (i * FFT_HOP) / SAMPLE_RATE - WINDOW_OFFSET * Math.floor(i / ANNOT_N_FRAMES);
