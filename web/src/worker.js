// Transcription worker: runs the model window by window with LiteRT.js, choosing windows so that
// what's on screen is done first (the page posts the visible windows as {type: 'view'}). In live
// mode, streaming HMMs decode notes as soon as windows arrive; in original mode, Basic Pitch's own
// note creation (with the melodia trick) runs once the whole file is in. Built as a classic worker because
// LiteRT.js loads its Emscripten module with importScripts().
import { loadLiteRt, loadAndCompile } from '@litertjs/core';
import { runWindow } from './model.js';
import { FRAMES_PER_WINDOW, N_PITCHES, nOutputFrames, toByte, windowAt, windowFrames } from './pipeline.js';
import { DEFAULT_PARAMS } from './hmm.js';
import { WindowedDecoder, nextWindow, nextMissing } from './segments.js';
import { originalNotes } from './original.js';
import { velocity } from './midi.js';

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

async function transcribe(audio, mode) {
  try {
    const t0 = performance.now();
    const { model, threads, numThreads } = await load();
    self.postMessage({ type: 'ready', threads, numThreads, loadMs: performance.now() - t0 });

    const totalFrames = nOutputFrames(audio.length), nWin = Math.ceil(totalFrames / FRAMES_PER_WINDOW);
    const live = mode !== 'original';
    const dec = live ? new WindowedDecoder(totalFrames, { prm: DEFAULT_PARAMS, beam: 2, maxLag: 100 }) : null;
    // Original mode keeps every frame's activations for the end; live mode keeps only a few windows.
    const whole = live ? null : { note: new Float32Array(totalFrames * N_PITCHES), onset: new Float32Array(totalFrames * N_PITCHES) };
    const posted = new Uint8Array(nWin);
    const t1 = performance.now();
    let modelMs = 0, runs = 0, done = 0;
    for (;;) {
      await yieldToMessages();
      const w = live ? nextWindow(dec, view[0], view[1]) : nextMissing(posted, view[0], view[1]);
      if (w < 0) break;
      const a = performance.now();
      const out = await runWindow(model, windowAt(audio, w));
      modelMs += performance.now() - a;
      runs++;
      const start = w * FRAMES_PER_WINDOW, k = Math.min(FRAMES_PER_WINDOW, totalFrames - start);
      const note = windowFrames(out.note, N_PITCHES).slice(0, k * N_PITCHES);
      const onset = windowFrames(out.onset, N_PITCHES).slice(0, k * N_PITCHES);
      let notes = [];
      if (live) notes = dec.add(w, note, onset);
      else { whole.note.set(note, start * N_PITCHES); whole.onset.set(onset, start * N_PITCHES); }
      let activation = null;
      if (!posted[w]) {
        posted[w] = 1;
        done++;
        activation = Uint8Array.from(note, toByte);
      }
      self.postMessage(
        { type: 'progress', window: w, windows: nWin, done, start, frames: k, totalFrames, activation, notes, runs, modelMs, elapsedMs: performance.now() - t1 },
        activation ? [activation.buffer] : [],
      );
    }
    // Original notes have no "final at" frames: they are only final once the whole file is in.
    const a = performance.now();
    const notes = live ? [] : originalNotes(whole.note, whole.onset).map(([s, e, pitch, amp]) => [s, e, pitch, -1, -1, velocity(amp)]);
    const decodeMs = performance.now() - a;
    self.postMessage({ type: 'done', totalFrames, windows: nWin, notes, runs, modelMs, decodeMs, elapsedMs: performance.now() - t1 });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.stack || err) });
  }
}

function onMessage({ data }) {
  if (data.type === 'view') view = [data.first, data.last];
  else if (data.type === 'transcribe') {
    if (data.view) view = data.view;
    transcribe(data.audio, data.mode);
  }
}

// Emscripten starts its thread workers from the URL of the script that loaded it, which is this
// file. Those workers are named "em-pthread"; hand them straight to the threaded LiteRT runtime.
if (self.name === 'em-pthread') importScripts(WASM_DIR + 'litert_wasm_threaded_internal.js');
else self.onmessage = onMessage;
