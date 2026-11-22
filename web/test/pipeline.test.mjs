// Windowing and frame timing must match basic_pitch/inference.py and note_creation.py exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AUDIO_N_SAMPLES, HOP, FRAMES_PER_WINDOW, nWindows, nOutputFrames, windowAt, windowFrames, frameToTime } from '../src/pipeline.js';

// vocadito_10.wav at 22050 Hz has 200607 samples (tests/test_inference.py::test_get_audio_input).
const L = 200607;

test('window count and output length match get_audio_input / unwrap_output', () => {
  assert.equal(HOP, 36164);
  assert.equal(FRAMES_PER_WINDOW, 142);
  assert.equal(nWindows(L), 6);
  assert.equal(nOutputFrames(L), 787); // int(L / hop * 142) in Python
});

test('windows are the audio with overlap/2 zeros prepended, zero-padded at the end', () => {
  const audio = Float32Array.from({ length: L }, (_, i) => (i % 97) / 97);
  const first = windowAt(audio, 0);
  assert.equal(first.length, AUDIO_N_SAMPLES);
  for (let i = 0; i < 3840; i++) assert.equal(first[i], 0);
  for (let i = 3840; i < AUDIO_N_SAMPLES; i++) assert.equal(first[i], audio[i - 3840]);
  const w = 2, second = windowAt(audio, w);
  for (let i = 0; i < AUDIO_N_SAMPLES; i++) assert.equal(second[i], audio[w * HOP + i - 3840]);
  const last = windowAt(audio, nWindows(L) - 1), start = (nWindows(L) - 1) * HOP - 3840;
  for (let i = 0; i < AUDIO_N_SAMPLES; i++) assert.equal(last[i], start + i < L ? audio[start + i] : 0);
});

test('windowFrames drops 15 frames from each end of a 172-frame window', () => {
  const out = Float32Array.from({ length: 172 * 88 }, (_, i) => i);
  const kept = windowFrames(out, 88);
  assert.equal(kept.length, 142 * 88);
  assert.equal(kept[0], 15 * 88);
  assert.equal(kept[kept.length - 1], 157 * 88 - 1);
});

test('frameToTime matches note_creation.model_frames_to_time', () => {
  // Values from Python: model_frames_to_time(800)[[0, 1, 171, 172, 173, 500, 799]]
  const ref = { 0: 0.0, 1: 0.011609977, 171: 1.985306122, 172: 1.986590023, 173: 1.9982, 500: 5.784336508, 799: 9.235067574 };
  for (const [i, t] of Object.entries(ref)) assert.ok(Math.abs(frameToTime(Number(i)) - t) < 1e-9, `frame ${i}`);
});

test('timeToFrame inverts frameToTime', async () => {
  const { timeToFrame } = await import('../src/pipeline.js');
  assert.equal(timeToFrame(0), 0);
  assert.equal(timeToFrame(-5), 0);
  for (const i of [1, 171, 172, 173, 500, 799, 12345, 310000]) {
    assert.equal(timeToFrame(frameToTime(i)), i);
    assert.equal(timeToFrame((frameToTime(i) + frameToTime(i + 1)) / 2), i);
  }
});
