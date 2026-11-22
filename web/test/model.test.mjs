// LiteRT.js loads the web model and returns note/onset/contour windows of the expected shape.
import './node_shim.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadLiteRt, loadAndCompile } from '@litertjs/core';
import { runWindow } from '../src/model.js';
import { AUDIO_N_SAMPLES } from '../src/pipeline.js';

const wasmDir = fileURLToPath(new URL('../node_modules/@litertjs/core/wasm/', import.meta.url));
const modelBytes = new Uint8Array(fs.readFileSync(new URL('../model/nmp_web.tflite', import.meta.url)));

test('web model runs a window on the wasm backend', async () => {
  await loadLiteRt(wasmDir);
  const model = await loadAndCompile(modelBytes, { accelerator: 'wasm' });
  const x = Float32Array.from({ length: AUDIO_N_SAMPLES }, (_, i) => 0.1 * Math.sin((2 * Math.PI * 440 * i) / 22050));
  const out = await runWindow(model, x);
  assert.equal(out.note.length, 172 * 88);
  assert.equal(out.onset.length, 172 * 88);
  assert.equal(out.contour.length, 172 * 264);
  // A 440 Hz sine is A4 (MIDI 69, index 48): it should be the strongest pitch mid-window.
  const row = out.note.subarray(86 * 88, 87 * 88);
  assert.equal(row.indexOf(Math.max(...row)), 69 - 21);
});
