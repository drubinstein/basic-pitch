// Page wiring: decode audio to 22050 Hz mono, hand it to the transcription worker, draw what comes
// back, and keep finished results in this browser so reopening a file is instant.
import { FRAMES_PER_WINDOW, N_PITCHES, SAMPLE_RATE, frameToTime, nOutputFrames } from './pipeline.js';
import { PianoRoll } from './roll.js';
import * as cache from './cache.js';

const $ = (id) => document.getElementById(id);
let worker = null, view = [0, Infinity], current = null;
const roll = new PianoRoll($('roll'), frameToTime, (first, last) => {
  view = [first, last];
  worker?.postMessage({ type: 'view', first, last });
});

const setStatus = (text) => { $('status').textContent = text; };
const setStats = (text) => { $('stats').textContent = text; };

// Decoding into a 22050 Hz context resamples with the browser's resampler. basic-pitch in Python
// uses librosa (soxr), so model outputs can differ slightly from the Python package's.
async function decode(bytes) {
  const buffer = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(bytes);
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / buffer.numberOfChannels;
  }
  return mono;
}

function showCached(name, hit) {
  roll.reset(hit.duration, hit.totalFrames);
  const step = FRAMES_PER_WINDOW * N_PITCHES;
  for (let w = 0; w * FRAMES_PER_WINDOW < hit.totalFrames; w++) roll.addTile(w, hit.activation.subarray(w * step, (w + 1) * step));
  roll.addNotes(hit.notes);
  window.basicPitch = { name, duration: hit.duration, notes: hit.notes, done: true, fromCache: true };
  setStatus(`${name}: ${hit.notes.length} notes`);
  setStats('Saved in this browser from an earlier run.');
  $('again').hidden = false;
}

async function open(name, bytes, { useCache = true } = {}) {
  worker?.terminate();
  worker = null;
  current = { name, bytes };
  $('again').hidden = true;
  setStatus(`Decoding ${name}…`);
  setStats('');
  const key = await cache.fileKey(bytes).catch(() => null);
  if (useCache) {
    const hit = await cache.load(key);
    if (hit) return showCached(name, hit);
  }
  let audio;
  try {
    audio = await decode(bytes.slice(0)); // decodeAudioData detaches its input; keep ours for "Run again"
  } catch (err) {
    setStatus(`Couldn't decode ${name}: ${err.message}`);
    return;
  }
  const duration = audio.length / SAMPLE_RATE, totalFrames = nOutputFrames(audio.length);
  roll.reset(duration, totalFrames);
  $('roll').focus();
  let runtime = '';
  const result = { name, duration, notes: [], order: [] };
  window.basicPitch = result; // for scripted checks
  worker = new Worker('worker.js');
  worker.onmessage = ({ data: m }) => {
    if (m.type === 'ready') {
      runtime = `LiteRT.js wasm · ${m.numThreads} thread${m.numThreads === 1 ? '' : 's'}${m.threads ? '' : ' (page not cross-origin isolated)'}`;
      result.runtime = { threads: m.threads, numThreads: m.numThreads, loadMs: m.loadMs };
      setStatus(`Transcribing ${name}…`);
    } else if (m.type === 'progress') {
      if (m.activation) roll.addTile(m.window, m.activation);
      roll.addNotes(m.notes);
      result.notes.push(...m.notes);
      result.order.push(m.window);
      const secs = Math.min(duration, (m.done * FRAMES_PER_WINDOW * 256) / SAMPLE_RATE);
      setStatus(`Transcribing ${name}… ${m.done}/${m.windows} windows`);
      setStats(`${runtime} · ${(secs / (m.elapsedMs / 1000)).toFixed(1)}× real time`);
    } else if (m.type === 'done') {
      Object.assign(result, { done: true, elapsedMs: m.elapsedMs, modelMs: m.modelMs, runs: m.runs, windows: m.windows });
      $('again').hidden = false;
      setStatus(`${name}: ${result.notes.length} notes`);
      setStats(`${runtime} · ${(duration / (m.elapsedMs / 1000)).toFixed(1)}× real time · model ${(m.modelMs / 1000).toFixed(2)} s for ${duration.toFixed(1)} s of audio`);
      cache.save({ key, name, duration, totalFrames, notes: result.notes, activation: roll.activation() });
    } else if (m.type === 'error') {
      setStatus(`Something went wrong: ${m.message.split('\n')[0]}`);
      result.error = m.message;
      console.error(m.message);
    }
  };
  worker.postMessage({ type: 'transcribe', audio, view }, [audio.buffer]);
}

$('file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) open(file.name, await file.arrayBuffer());
});

$('example').addEventListener('click', async () => {
  setStatus('Loading the example…');
  const res = await fetch('examples/vocadito_10.wav');
  open('vocadito_10.wav', await res.arrayBuffer());
});

$('again').addEventListener('click', () => current && open(current.name, current.bytes, { useCache: false }));
$('fit').addEventListener('click', () => roll.fit());
$('forget').addEventListener('click', async () => {
  await cache.clear();
  setStats('Cleared the results saved in this browser.');
});

// Drop a file anywhere on the page.
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) open(file.name, await file.arrayBuffer());
});
