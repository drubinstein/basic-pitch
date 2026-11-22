// Transcription worker: runs the model window by window with LiteRT.js, choosing windows so that
// what's on screen is done first (the page posts the visible windows as {type: 'view'}), and
// decodes notes with streaming HMMs as soon as windows arrive. Built as a classic worker because
// LiteRT.js loads its Emscripten module with importScripts().
import { loadLiteRt, loadAndCompile } from '@litertjs/core';
import { runWindow } from './model.js';
import { FRAMES_PER_WINDOW, N_PITCHES, nOutputFrames, toByte, windowAt, windowFrames } from './pipeline.js';
import { DEFAULT_PARAMS } from './hmm.js';
import { WindowedDecoder, nextWindow } from './segments.js';

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

let view = [0, Infinity];

// LiteRT.js resolves model runs as microtasks, so without this the loop would never let queued
// messages (view changes) in until the whole file was done.
const channel = new MessageChannel();
const yieldToMessages = () => new Promise((resolve) => {
  channel.port1.onmessage = () => resolve();
  channel.port2.postMessage(null);
});

async function transcribe(audio) {
  try {
    const t0 = performance.now();
    const { model, threads, numThreads } = await load();
    self.postMessage({ type: 'ready', threads, numThreads, loadMs: performance.now() - t0 });

    const totalFrames = nOutputFrames(audio.length);
    const dec = new WindowedDecoder(totalFrames, { prm: DEFAULT_PARAMS, beam: 2, maxLag: 100 });
    const posted = new Uint8Array(dec.nWindows);
    const t1 = performance.now();
    let modelMs = 0, runs = 0, done = 0;
    for (;;) {
      await yieldToMessages();
      const w = nextWindow(dec, view[0], view[1]);
      if (w < 0) break;
      const a = performance.now();
      const out = await runWindow(model, windowAt(audio, w));
      modelMs += performance.now() - a;
      runs++;
      const start = w * FRAMES_PER_WINDOW, k = Math.min(FRAMES_PER_WINDOW, totalFrames - start);
      const note = windowFrames(out.note, N_PITCHES).slice(0, k * N_PITCHES);
      const onset = windowFrames(out.onset, N_PITCHES).slice(0, k * N_PITCHES);
      const notes = dec.add(w, note, onset);
      let activation = null;
      if (!posted[w]) {
        posted[w] = 1;
        done++;
        activation = Uint8Array.from(note, toByte);
      }
      self.postMessage(
        { type: 'progress', window: w, windows: dec.nWindows, done, start, frames: k, totalFrames, activation, notes, runs, modelMs, elapsedMs: performance.now() - t1 },
        activation ? [activation.buffer] : [],
      );
    }
    self.postMessage({ type: 'done', totalFrames, windows: dec.nWindows, runs, modelMs, elapsedMs: performance.now() - t1 });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.stack || err) });
  }
}

function onMessage({ data }) {
  if (data.type === 'view') view = [data.first, data.last];
  else if (data.type === 'transcribe') {
    if (data.view) view = data.view;
    transcribe(data.audio);
  }
}

// Emscripten starts its thread workers from the URL of the script that loaded it, which is this
// file. Those workers are named "em-pthread"; hand them straight to the threaded LiteRT runtime.
if (self.name === 'em-pthread') importScripts(WASM_DIR + 'litert_wasm_threaded_internal.js');
else self.onmessage = onMessage;
