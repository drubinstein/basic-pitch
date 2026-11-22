// Transcription worker: runs the model window by window with LiteRT.js, choosing windows so that
// what's on screen is done first (the page posts the visible windows as {type: 'view'}). In live
// mode, streaming HMMs decode notes as soon as windows arrive; in original mode, Basic Pitch's own
// note creation (with the melodia trick) runs once the whole file is in. Every frame's activations
// are kept, so the control panel can re-decode with other settings, or the other decoder, without
// running the model again ({type: 'redecode'}). Built as a classic worker because
// LiteRT.js loads its Emscripten module with importScripts().
import { loadLiteRt, loadAndCompile } from '@litertjs/core';
import { runWindow } from './model.js';
import { AUDIO_N_SAMPLES, FRAMES_PER_WINDOW, HOP, N_PITCHES, OVERLAP_LEN, SAMPLE_RATE, nOutputFrames, toByte, windowAt, windowFrames } from './pipeline.js';
import { StreamingHmm } from './hmm.js';
import { LIVE, ORIGINAL, defaults, hmmOptions, originalOptions } from './params.js';
import { WindowedDecoder, nextWindow, nextMissing } from './segments.js';
import { originalNotes } from './original.js';
import { velocity } from './midi.js';
import { BINS, bendRows } from './bends.js';

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

let kept = null; // { note, onset, totalFrames } once the whole file is in
let pending = null; // the latest re-decode asked for

// Notes as [start, end, pitch, start final at, end final at, velocity]. Original notes have no
// "final at" frames (-1): they are only final once the whole file is in. Live velocities are left to
// the page, which has the activations at hand.
function decodeAll({ note, onset, totalFrames }, mode, params) {
  if (mode === 'original') return originalNotes(note, onset, originalOptions(params)).map(([s, e, pitch, amp]) => [s, e, pitch, -1, -1, velocity(amp)]);
  const { prm, beam, maxLag } = hmmOptions(params), hmm = new StreamingHmm(prm, { beam, maxLag });
  for (let t = 0; t < totalFrames; t++) hmm.push(note.subarray(t * N_PITCHES, (t + 1) * N_PITCHES), onset.subarray(t * N_PITCHES, (t + 1) * N_PITCHES));
  return hmm.finish();
}

// Re-decode with the latest settings asked for; requests that arrive meanwhile replace each other.
let decoding = false;
async function redecode() {
  if (decoding || !kept) return;
  decoding = true;
  while (pending) {
    await yieldToMessages();
    const job = pending;
    pending = null;
    const a = performance.now(), notes = decodeAll(kept, job.mode, job.params);
    if (!pending) self.postMessage({ type: 'decoded', id: job.id, mode: job.mode, notes, decodeMs: performance.now() - a });
  }
  decoding = false;
}

async function transcribe(audio, mode, params = {}) {
  try {
    const t0 = performance.now();
    const { model, threads, numThreads } = await load();
    self.postMessage({ type: 'ready', threads, numThreads, loadMs: performance.now() - t0 });

    const totalFrames = nOutputFrames(audio.length), nWin = Math.ceil(totalFrames / FRAMES_PER_WINDOW);
    const live = mode !== 'original';
    const settings = { ...defaults(live ? LIVE : ORIGINAL), ...params[mode] };
    const dec = live ? new WindowedDecoder(totalFrames, hmmOptions(settings)) : null;
    const whole = { note: new Float32Array(totalFrames * N_PITCHES), onset: new Float32Array(totalFrames * N_PITCHES), totalFrames };
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
      whole.note.set(note, start * N_PITCHES);
      whole.onset.set(onset, start * N_PITCHES);
      const notes = live ? dec.add(w, note, onset) : [];
      let activation = null, bends = null;
      if (!posted[w]) {
        posted[w] = 1;
        done++;
        activation = Uint8Array.from(note, toByte);
        bends = bendRows(windowFrames(out.contour, BINS), k); // each pitch's bend at each frame
      }
      self.postMessage(
        { type: 'progress', window: w, windows: nWin, done, start, frames: k, totalFrames, activation, bends, notes, runs, modelMs, elapsedMs: performance.now() - t1 },
        activation ? [activation.buffer, bends.buffer] : [],
      );
    }
    const a = performance.now();
    const notes = live ? [] : decodeAll(whole, 'original', settings);
    const decodeMs = performance.now() - a;
    self.postMessage({ type: 'done', totalFrames, windows: nWin, notes, runs, modelMs, decodeMs, elapsedMs: performance.now() - t1 });
    kept = whole;
    redecode();
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.stack || err) });
  }
}

// --- Streaming from the microphone: windows run as soon as their audio is in, in order, through
// one streaming HMM; {type: 'stream-stop'} finishes the last partial window. ---

let live = null;
const grown = (arr, need) => {
  if (arr.length >= need) return arr;
  const out = new Float32Array(Math.max(need, arr.length * 2));
  out.set(arr);
  return out;
};

async function streamStart(params = {}) {
  // Set up right away so audio arriving while the model loads is kept.
  const { prm, beam, maxLag } = hmmOptions({ ...defaults(LIVE), ...params.live });
  live = { model: null, audio: new Float32Array(SAMPLE_RATE * 60), len: 0, next: 0, frames: 0, note: new Float32Array(0), onset: new Float32Array(0),
    hmm: new StreamingHmm(prm, { beam, maxLag }), busy: false, stopping: false, finished: false, modelMs: 0, t1: performance.now() };
  try {
    const t0 = performance.now();
    const { model, threads, numThreads } = await load();
    self.postMessage({ type: 'ready', threads, numThreads, loadMs: performance.now() - t0 });
    live.model = model;
    pump();
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.stack || err) });
  }
}

function streamAudio(samples) {
  if (!live || live.stopping) return;
  live.audio = grown(live.audio, live.len + samples.length);
  live.audio.set(samples, live.len);
  live.len += samples.length;
  pump();
}

async function pump() {
  const s = live;
  if (!s || !s.model || s.busy || s.finished) return;
  s.busy = true;
  try {
    for (;;) {
      await yieldToMessages();
      const w = s.next, total = s.stopping ? nOutputFrames(s.len) : Infinity;
      // A window is ready once all its audio is in (its frames then always fit in the final count).
      if (s.stopping ? w * FRAMES_PER_WINDOW >= total : s.len < w * HOP - OVERLAP_LEN / 2 + AUDIO_N_SAMPLES) break;
      const a = performance.now();
      const out = await runWindow(s.model, windowAt(s.audio.subarray(0, s.len), w));
      s.modelMs += performance.now() - a;
      const k = Math.min(FRAMES_PER_WINDOW, total - w * FRAMES_PER_WINDOW), start = w * FRAMES_PER_WINDOW;
      const note = windowFrames(out.note, N_PITCHES).slice(0, k * N_PITCHES), onset = windowFrames(out.onset, N_PITCHES).slice(0, k * N_PITCHES);
      s.note = grown(s.note, (start + k) * N_PITCHES);
      s.onset = grown(s.onset, (start + k) * N_PITCHES);
      s.note.set(note, start * N_PITCHES);
      s.onset.set(onset, start * N_PITCHES);
      for (let t = 0; t < k; t++) s.hmm.push(note.subarray(t * N_PITCHES, (t + 1) * N_PITCHES), onset.subarray(t * N_PITCHES, (t + 1) * N_PITCHES));
      s.frames = start + k;
      s.next++;
      const activation = Uint8Array.from(note, toByte), bends = bendRows(windowFrames(out.contour, BINS), k);
      self.postMessage({ type: 'progress', window: w, windows: s.next, done: s.next, start, frames: k, totalFrames: s.frames, samples: s.len, activation, bends, notes: s.hmm.drain(),
        runs: s.next, modelMs: s.modelMs, elapsedMs: performance.now() - s.t1 }, [activation.buffer, bends.buffer]);
    }
    if (s.stopping && !s.finished) {
      s.finished = true;
      s.hmm.finish();
      kept = { note: s.note.subarray(0, s.frames * N_PITCHES), onset: s.onset.subarray(0, s.frames * N_PITCHES), totalFrames: s.frames };
      self.postMessage({ type: 'done', totalFrames: s.frames, windows: s.next, notes: s.hmm.drain(), runs: s.next, modelMs: s.modelMs, decodeMs: 0, elapsedMs: performance.now() - s.t1, samples: s.len });
      redecode();
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.stack || err) });
  } finally {
    s.busy = false;
  }
  if (!s.finished && (s.stopping || s.len >= s.next * HOP - OVERLAP_LEN / 2 + AUDIO_N_SAMPLES)) pump();
}

function onMessage({ data }) {
  if (data.type === 'view') view = [data.first, data.last];
  else if (data.type === 'transcribe') {
    if (data.view) view = data.view;
    transcribe(data.audio, data.mode, data.params);
  } else if (data.type === 'stream-start') streamStart(data.params);
  else if (data.type === 'stream-audio') streamAudio(data.samples);
  else if (data.type === 'stream-stop') {
    if (live) { live.stopping = true; pump(); }
  } else if (data.type === 'redecode') {
    pending = data;
    redecode();
  }
}

// Emscripten starts its thread workers from the URL of the script that loaded it, which is this
// file. Those workers are named "em-pthread"; hand them straight to the threaded LiteRT runtime.
if (self.name === 'em-pthread') importScripts(WASM_DIR + 'litert_wasm_threaded_internal.js');
else self.onmessage = onMessage;
