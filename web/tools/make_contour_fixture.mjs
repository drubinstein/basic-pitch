// Contour output of the web model for vocadito_10, for the pitch-bend tests (web/test/bends.test.mjs).
// Usage: node web/tools/make_contour_fixture.mjs <22050 Hz mono float32 samples> (from librosa.load)
import '../test/node_shim.mjs';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loadLiteRt, loadAndCompile } from '@litertjs/core';
import { runWindow } from '../src/model.js';
import { FRAMES_PER_WINDOW, nOutputFrames, nWindows, windowAt, windowFrames } from '../src/pipeline.js';

const BINS = 264;
const buf = fs.readFileSync(process.argv[2]);
const audio = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
await loadLiteRt(fileURLToPath(new URL('../node_modules/@litertjs/core/wasm/', import.meta.url)));
const model = await loadAndCompile(new Uint8Array(fs.readFileSync(new URL('../model/nmp_web.tflite', import.meta.url))), { accelerator: 'wasm' });
const T = nOutputFrames(audio.length), contour = new Float32Array(T * BINS);
for (let w = 0; w < nWindows(audio.length) && w * FRAMES_PER_WINDOW < T; w++) {
  const out = await runWindow(model, windowAt(audio, w));
  const k = Math.min(FRAMES_PER_WINDOW, T - w * FRAMES_PER_WINDOW);
  contour.set(windowFrames(out.contour, BINS).subarray(0, k * BINS), w * FRAMES_PER_WINDOW * BINS);
}
const dest = new URL('../test/fixtures/vocadito_10_contour.f32.gz', import.meta.url);
fs.writeFileSync(dest, zlib.gzipSync(Buffer.from(contour.buffer), { level: 9 }));
console.log(`${T} frames x ${BINS} bins -> ${fileURLToPath(dest)} (${fs.statSync(dest).size} bytes)`);
