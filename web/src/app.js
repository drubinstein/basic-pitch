// Page wiring: decode audio to 22050 Hz mono, hand it to the transcription worker, draw what comes
// back, play the file with a playhead over the roll, and keep finished results in this browser so
// reopening a file is instant.
import { FRAMES_PER_WINDOW, N_PITCHES, SAMPLE_RATE, frameToTime, nOutputFrames } from './pipeline.js';
import { PianoRoll } from './roll.js';
import * as cache from './cache.js';
import { Clock, formatTime } from './playback.js';
import { noteName, noteHz, meanActivation } from './notes.js';
import { toMidi, velocity } from './midi.js';

const $ = (id) => document.getElementById(id);
const audio = $('audio'), clock = new Clock(audio);
let worker = null, view = [0, Infinity], current = null, opened = 0, mode = savedMode();
let finished = null; // { name, mode, notes } once the open file's notes are all in

const roll = new PianoRoll($('roll'), frameToTime, {
  onView: (first, last) => {
    view = [first, last];
    worker?.postMessage({ type: 'view', first, last });
  },
  onNote: showTip,
  onSeek: seek,
  onSounding: (notes) => {
    const names = notes.map((n) => noteName(n.pitch));
    $('now').textContent = names.length > 8 ? `${names.slice(0, 8).join(' ')} +${names.length - 8}` : names.join(' ') || '–';
  },
  onFollow: (on) => { $('follow').hidden = on || audio.paused; },
});

window.pianoRoll = roll; // for scripted checks
const setStatus = (text) => { $('status').textContent = text; };
const setStats = (text) => { $('stats').textContent = text; };

// --- Modes: live (streaming HMM) or original (Basic Pitch's note creation, melodia trick). ---

function savedMode() {
  try { return localStorage.getItem('mode') === 'original' ? 'original' : 'live'; } catch { return 'live'; }
}
for (const input of document.querySelectorAll('input[name="mode"]')) {
  input.checked = input.value === mode;
  input.addEventListener('change', () => {
    mode = input.value;
    try { localStorage.setItem('mode', mode); } catch { /* not remembered */ }
    if (current) open(current.name, current.blob);
  });
}

// --- Transcription. ---

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

// A fresh roll for this file, keeping the playhead where the music is.
function resetRoll(duration, totalFrames) {
  roll.reset(duration, totalFrames);
  $('seek').max = duration;
  $('total').textContent = formatTime(duration);
  showTime(clock.time());
  if (audio.src) {
    roll.setPlayhead(clock.time());
    if (!audio.paused) roll.follow(true);
  }
}

function showCached(name, hit) {
  resetRoll(hit.duration, hit.totalFrames);
  const step = FRAMES_PER_WINDOW * N_PITCHES;
  for (let w = 0; w * FRAMES_PER_WINDOW < hit.totalFrames; w++) roll.addTile(w, hit.activation.subarray(w * step, (w + 1) * step));
  roll.addNotes(hit.notes);
  window.basicPitch = { name, mode, duration: hit.duration, notes: hit.notes, done: true, fromCache: true };
  finished = { name, mode, notes: hit.notes };
  setStatus(`${name}: ${hit.notes.length} notes`);
  setStats(`${modeLabel()} · saved in this browser from an earlier run.`);
  $('again').hidden = false;
  $('download').hidden = false;
}

const modeLabel = () => (mode === 'original' ? 'Original (melodia trick)' : 'Live (streaming HMM)');

// blob: the file (a File, or the example fetched as a Blob).
async function open(name, blob, { useCache = true } = {}) {
  const id = ++opened, stale = () => id !== opened;
  worker?.terminate();
  worker = null;
  if (current?.blob !== blob) loadAudio(blob);
  current = { name, blob };
  finished = null;
  $('again').hidden = true;
  $('download').hidden = true;
  setStatus(`Decoding ${name}…`);
  setStats('');
  const bytes = await blob.arrayBuffer();
  const key = await cache.fileKey(bytes, mode).catch(() => null);
  if (stale()) return;
  if (useCache) {
    const hit = await cache.load(key);
    if (stale()) return;
    if (hit) return showCached(name, hit);
  }
  let samples;
  try {
    samples = await decode(bytes);
  } catch (err) {
    if (!stale()) setStatus(`Couldn't decode ${name}: ${err.message}`);
    return;
  }
  if (stale()) return;
  const duration = samples.length / SAMPLE_RATE, totalFrames = nOutputFrames(samples.length), runMode = mode;
  resetRoll(duration, totalFrames);
  $('roll').focus();
  let runtime = '';
  const result = { name, mode: runMode, duration, notes: [], order: [] };
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
      setStatus(`Transcribing ${name}… ${m.done}/${m.windows} windows${runMode === 'original' ? ' · notes come once the whole file is in' : ''}`);
      setStats(`${runtime} · ${(secs / (m.elapsedMs / 1000)).toFixed(1)}× real time`);
    } else if (m.type === 'done') {
      roll.addNotes(m.notes);
      result.notes.push(...m.notes);
      // Live notes get their velocity now that every window's activations are in.
      for (const n of result.notes) n[5] ??= velocity(meanActivation(roll.tiles, FRAMES_PER_WINDOW, n[0], n[1], n[2]));
      finished = { name, mode: runMode, notes: result.notes };
      $('download').hidden = false;
      Object.assign(result, { done: true, elapsedMs: m.elapsedMs, modelMs: m.modelMs, decodeMs: m.decodeMs, runs: m.runs, windows: m.windows });
      $('again').hidden = false;
      setStatus(`${name}: ${result.notes.length} notes`);
      const notesTime = runMode === 'original' ? ` · note creation ${(m.decodeMs / 1000).toFixed(2)} s` : '';
      setStats(`${modeLabel()} · ${runtime} · ${(duration / (m.elapsedMs / 1000)).toFixed(1)}× real time · model ${(m.modelMs / 1000).toFixed(2)} s for ${duration.toFixed(1)} s of audio${notesTime}`);
      cache.save({ key, name, duration, totalFrames, notes: result.notes, activation: roll.activation() });
    } else if (m.type === 'error') {
      setStatus(`Something went wrong: ${m.message.split('\n')[0]}`);
      result.error = m.message;
      console.error(m.message);
    }
  };
  worker.postMessage({ type: 'transcribe', audio: samples, mode: runMode, view }, [samples.buffer]);
}

// --- Playback. ---

let audioUrl = null, raf = 0, last = null, scrubbing = false;

function loadAudio(blob) {
  audio.pause();
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(blob);
  audio.src = audioUrl;
  clock.reset();
  $('transport').hidden = false;
  $('play').disabled = false;
  $('now').textContent = '–';
}

function showTime(t) {
  const text = formatTime(t);
  if ($('time').textContent !== text) $('time').textContent = text;
  if (!scrubbing) $('seek').value = t;
}

function frame(now) {
  const t = clock.time();
  const motion = last ? { advance: Math.max(0, t - last.t), dt: (now - last.now) / 1000 } : { advance: 0, dt: 0 };
  last = { t, now };
  roll.setPlayhead(t, motion);
  showTime(t);
  raf = audio.paused ? 0 : requestAnimationFrame(frame);
}

function seek(t) {
  audio.currentTime = t;
  clock.reset();
  last = null;
  roll.setPlayhead(t);
  roll.reveal();
  if (!audio.paused) roll.follow(true);
  showTime(t);
}

function toggle() {
  if (!audio.src) return;
  if (!audio.paused) return audio.pause();
  if (audio.ended || audio.currentTime >= roll.duration - 0.05) seek(0);
  audio.play().catch((err) => setStats(`Can't play this file here: ${err.message}`));
}

audio.addEventListener('play', () => {
  $('play').textContent = 'Pause';
  last = null;
  roll.follow(true);
  if (!raf) raf = requestAnimationFrame(frame);
});
const paused = () => {
  $('play').textContent = 'Play';
  roll.follow(false);
  $('follow').hidden = true;
  const t = clock.time();
  roll.setPlayhead(t);
  showTime(t);
};
audio.addEventListener('pause', paused);
audio.addEventListener('ended', paused);
audio.addEventListener('seeking', () => clock.reset());
audio.addEventListener('error', () => {
  $('play').disabled = true;
  $('now').textContent = "this browser can't play the file";
});

$('play').addEventListener('click', toggle);
$('follow').addEventListener('click', () => roll.follow(true));
const scrub = $('seek');
scrub.addEventListener('pointerdown', () => { scrubbing = true; });
scrub.addEventListener('input', () => seek(+scrub.value));
scrub.addEventListener('change', () => { scrubbing = false; });
addEventListener('pointerup', () => { scrubbing = false; });

// Space plays and pauses, except where it means something already (buttons, text, radios).
addEventListener('keydown', (e) => {
  if (e.key !== ' ' || e.repeat || e.target.closest?.('button, textarea, select, label') || (e.target.tagName === 'INPUT' && e.target.type !== 'range')) return;
  e.preventDefault();
  toggle();
});

// --- Note tooltip: the hovered note, or the selected one. ---

function showTip(r) {
  const tip = $('tip');
  if (!r) { tip.hidden = true; tip.note = null; return; }
  const n = r.note;
  if (tip.note !== n) {
    tip.note = n;
    const lag = n.lag === null
      ? 'Original: made once the whole file was in'
      : `Live: start final ${Math.round(n.lag * 1000)} ms after it began`;
    tip.innerHTML = `<div class="tip-name">${noteName(n.pitch)} <span>MIDI ${n.pitch} · ${noteHz(n.pitch).toFixed(1)} Hz</span></div>`
      + `<div>${formatTime(n.t0, 2)} → ${formatTime(n.t1, 2)} · ${(n.t1 - n.t0).toFixed(2)} s</div>`
      + `<div class="tip-lag">${lag}</div>`;
  }
  tip.hidden = false;
  const stage = $('stage'), w = tip.offsetWidth, h = tip.offsetHeight;
  const left = Math.min(Math.max(4, r.pointerX === null ? r.x : r.pointerX + 12), stage.clientWidth - w - 4);
  const top = r.y - h - 10 >= 4 ? r.y - h - 10 : r.y + r.h + 10;
  tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

// --- Opening files: the file picker, the example, or a file dropped anywhere on the page. ---

$('file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) open(file.name, file);
  e.target.value = '';
});

$('example').addEventListener('click', async () => {
  setStatus('Loading the example…');
  const res = await fetch('examples/vocadito_10.wav');
  open('vocadito_10.wav', await res.blob());
});

$('again').addEventListener('click', () => current && open(current.name, current.blob, { useCache: false }));
$('fit').addEventListener('click', () => roll.fit());

// MIDI like basic-pitch's (no pitch bends), named like its <name>_basic_pitch.mid.
$('download').addEventListener('click', () => {
  if (!finished) return;
  const notes = finished.notes.map(([s, e, pitch, , , vel]) => ({ t0: frameToTime(s), t1: frameToTime(e), pitch, velocity: vel }));
  const base = finished.name.replace(/\.[^.]+$/, '');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([toMidi(notes)], { type: 'audio/midi' }));
  link.download = `${base}_basic_pitch${finished.mode === 'live' ? '_live' : ''}.mid`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});
$('forget').addEventListener('click', async () => {
  await cache.clear();
  setStats('Cleared the results saved in this browser.');
});

let dragDepth = 0;
const carriesFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
const dropZone = (on) => { $('drop').hidden = !on; };
addEventListener('dragenter', (e) => { if (carriesFiles(e)) { dragDepth++; dropZone(true); } });
addEventListener('dragleave', (e) => { if (carriesFiles(e) && --dragDepth <= 0) { dragDepth = 0; dropZone(false); } });
addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropZone(false);
  const files = [...(e.dataTransfer?.files ?? [])];
  const file = files.find((f) => /^(audio|video)\//.test(f.type)) ?? files[0];
  if (file) open(file.name, file);
});
