// Transcription worker: runs the model window by window with LiteRT.js and feeds each window's
// frames to the streaming HMM, posting notes as soon as they are final. Built as a classic worker
// because LiteRT.js loads its Emscripten module with importScripts().
import { loadLiteRt, loadAndCompile } from '@litertjs/core';
import { runWindow } from './model.js';
import { FRAMES_PER_WINDOW, N_PITCHES, nOutputFrames, nWindows, windowAt, windowFrames } from './pipeline.js';
import { StreamingHmm } from './hmm.js';

const WASM_DIR = new URL('wasm/', self.location.href).href;
let loaded;

function load() {
  loaded ??= (async () => {
    // Threads need SharedArrayBuffer, so only when the page is cross-origin isolated
    // (coi-serviceworker.js provides that on GitHub Pages). Half the cores, like the Python default.
    const threads = self.crossOriginIsolated === true;
    const numThreads = threads ? Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) / 2)) : 1;
    // Loaded with importScripts() from this worker, Emscripten would look for the .wasm next to
    // this script; point it at the wasm directory instead.
    self.Module = { locateFile: (file) => WASM_DIR + file };
    await loadLiteRt(WASM_DIR, { threads });
    const model = await loadAndCompile(new URL('model/nmp_web.tflite', self.location.href).href, {
      accelerator: 'wasm',
      cpuOptions: { numThreads },
    });
    return { model, threads, numThreads };
  })();
  return loaded;
}

async function transcribe({ data: { audio } }) {
  try {
    const t0 = performance.now();
    const { model, threads, numThreads } = await load();
    self.postMessage({ type: 'ready', threads, numThreads, loadMs: performance.now() - t0 });

    const totalFrames = nOutputFrames(audio.length), windows = nWindows(audio.length);
    const hmm = new StreamingHmm(undefined, { capacity: Math.max(totalFrames, 1) });
    const t1 = performance.now();
    let frames = 0, modelMs = 0;
    for (let w = 0; w < windows && frames < totalFrames; w++) {
      const a = performance.now();
      const out = await runWindow(model, windowAt(audio, w));
      modelMs += performance.now() - a;
      const note = windowFrames(out.note, N_PITCHES), onset = windowFrames(out.onset, N_PITCHES);
      const k = Math.min(FRAMES_PER_WINDOW, totalFrames - frames);
      for (let i = 0; i < k; i++) {
        hmm.push(note.subarray(i * N_PITCHES, (i + 1) * N_PITCHES), onset.subarray(i * N_PITCHES, (i + 1) * N_PITCHES));
      }
      const activation = note.slice(0, k * N_PITCHES);
      self.postMessage(
        { type: 'progress', window: w + 1, windows, start: frames, frames: k, totalFrames, activation, notes: hmm.drain(), modelMs, elapsedMs: performance.now() - t1 },
        [activation.buffer],
      );
      frames += k;
    }
    hmm.finish();
    self.postMessage({ type: 'done', notes: hmm.drain(), totalFrames, modelMs, elapsedMs: performance.now() - t1 });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.stack || err) });
  }
}

// Emscripten starts its thread workers from the URL of the script that loaded it, which is this
// file. Those workers are named "em-pthread"; hand them straight to the threaded LiteRT runtime.
if (self.name === 'em-pthread') importScripts(WASM_DIR + 'litert_wasm_threaded_internal.js');
else self.onmessage = transcribe;
