// Microphone input: resampling to the model's 22050 Hz in a stream of chunks, and saving the
// recording as a WAV file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Resampler, toWav } from '../src/mic.js';

const sine = (n, rate, hz) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate));

test('resampling gives the same output however the input is chunked', () => {
  const x = sine(48000, 48000, 440);
  const whole = new Resampler(48000, 22050).push(x);
  const r = new Resampler(48000, 22050), parts = [];
  for (let i = 0; i < x.length; i += 1000 + (i % 7)) parts.push(...r.push(x.subarray(i, Math.min(x.length, i + 1000 + (i % 7)))));
  assert.equal(parts.length, whole.length);
  for (let i = 0; i < whole.length; i++) assert.ok(Math.abs(parts[i] - whole[i]) < 1e-6, `sample ${i}`);
});

test('a tone keeps its pitch and loudness', () => {
  const y = new Resampler(48000, 22050).push(sine(48000, 48000, 440));
  assert.ok(Math.abs(y.length - 22050) <= 1);
  // Correlate with a 440 Hz sine at 22050 Hz, past the filter's start-up.
  let dot = 0, norm = 0;
  for (let i = 2000; i < 20000; i++) { const s = Math.sin((2 * Math.PI * 440 * i) / 22050); dot += y[i] * s; norm += s * s; }
  const cos = Array.from({ length: 18000 }, (_, j) => Math.cos((2 * Math.PI * 440 * (j + 2000)) / 22050));
  const dot2 = cos.reduce((a, c, j) => a + c * y[j + 2000], 0);
  const amp = Math.hypot(dot, dot2) / norm;
  assert.ok(amp > 0.9 && amp < 1.05, `amplitude ${amp}`);
});

test('high frequencies are filtered out before they can fold down', () => {
  const y = new Resampler(48000, 22050).push(sine(48000, 48000, 16000));
  const rms = Math.sqrt(y.subarray(2000).reduce((a, v) => a + v * v, 0) / (y.length - 2000));
  assert.ok(rms < 0.1, `rms ${rms}`);
});

test('a 16-bit mono WAV file', () => {
  const bytes = toWav(Float32Array.from([0, 0.5, -1, 2]), 22050);
  const v = new DataView(bytes.buffer);
  const str = (o) => String.fromCharCode(...bytes.subarray(o, o + 4));
  assert.equal(str(0), 'RIFF');
  assert.equal(str(8), 'WAVE');
  assert.equal(v.getUint32(4, true), bytes.length - 8);
  assert.equal(v.getUint16(22, true), 1); // channels
  assert.equal(v.getUint32(24, true), 22050);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(v.getUint32(40, true), 8);
  assert.deepEqual([0, 1, 2, 3].map((i) => v.getInt16(44 + 2 * i, true)), [0, 16384, -32768, 32767]);
});
