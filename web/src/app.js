// Page wiring: decode audio to 22050 Hz mono, hand it to the transcription worker, draw what comes
// back, play the file (and/or the notes, through a small synth) with a playhead over the roll, and
// keep finished results in this browser so reopening a file is instant.
import { FRAMES_PER_WINDOW, N_PITCHES, SAMPLE_RATE, frameToTime, nOutputFrames } from './pipeline.js';
import { PianoRoll } from './roll.js';
import * as cache from './cache.js';
import { Clock, formatTime } from './playback.js';
import { noteName, noteHz, meanActivation } from './notes.js';
import { toMidi, velocity } from './midi.js';
import { renderReport } from './report.js';
import { NotePlayer, mix } from './synth.js';
import { LIVE, ORIGINAL, defaults, isDefault } from './params.js';
import { createKnob, createSwitch } from './knob.js';

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
  onFollow: (on) => $('follow').setAttribute('aria-pressed', String(on)),
});

window.pianoRoll = roll; // for scripted checks
const setStatus = (text) => { $('status').textContent = text; };
const setStats = (text) => {
  $('stats').replaceChildren();
  if (text) { const span = document.createElement('span'); span.textContent = text; $('stats').append(span); }
};
const remember = (key, value) => { try { localStorage.setItem(key, value); } catch { /* not remembered */ } };
const recall = (key) => { try { return localStorage.getItem(key); } catch { return null; } };

// --- Tabs: #transcribe (default), #guide, #report, #about. A link to anything inside a tab opens it. ---

const TABS = ['transcribe', 'guide', 'report', 'about'];
function route() {
  const id = decodeURIComponent(location.hash.slice(1));
  const target = id && !TABS.includes(id) ? document.getElementById(id) : null;
  const name = target?.closest('.panel')?.id.replace('panel-', '') ?? (TABS.includes(id) ? id : 'transcribe');
  for (const t of TABS) $(`panel-${t}`).hidden = t !== name;
  for (const a of document.querySelectorAll('.tabs a')) {
    if (a.dataset.tab === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  if (name === 'report') renderReport();
  if (target) target.scrollIntoView();
  else $(`panel-${name}`).scrollTop = 0;
}
addEventListener('hashchange', route);
route();
const showTranscribe = () => { if ($('panel-transcribe').hidden) location.hash = 'transcribe'; };

// --- Modes: live (streaming HMM) or original (Basic Pitch's note creation, melodia trick). ---

function savedMode() {
  try { return localStorage.getItem('mode') === 'original' ? 'original' : 'live'; } catch { return 'live'; }
}
for (const input of document.querySelectorAll('input[name="mode"]')) {
  input.checked = input.value === mode;
  input.addEventListener('change', () => setMode(input.value));
}

function setMode(m) {
  if (m === mode) return;
  mode = m;
  remember('mode', mode);
  for (const input of document.querySelectorAll('input[name="mode"]')) input.checked = input.value === mode;
  for (const p of document.querySelectorAll('.pedal')) p.classList.toggle('on', p.dataset.mode === mode);
  if (current) decodeAgain();
}

// --- Pedalboard: knobs for each decoder's settings. The worker keeps the model's output, so a
// change only re-runs the decoding; without it (a result from the cache) the file is transcribed again. ---

const DEFS = { live: LIVE, original: ORIGINAL };
const settings = Object.fromEntries(Object.keys(DEFS).map((m) => {
  let saved = {};
  try { saved = JSON.parse(recall(`settings-${m}`) || '{}'); } catch { /* defaults */ }
  return [m, { ...defaults(DEFS[m]), ...saved }];
}));
const allSettings = () => ({ live: { ...settings.live }, original: { ...settings.original } });
const isDefaultFor = (m) => isDefault(DEFS[m], settings[m]);
let decodeId = 0, decodeTimer = 0;

function decodeAgain() {
  clearTimeout(decodeTimer);
  decodeTimer = setTimeout(() => {
    if (!current) return;
    if (!worker) return open(current.name, current.blob, { useCache: isDefaultFor(mode) });
    decodeId++;
    setStatus(`Decoding ${current.name}…`);
    worker.postMessage({ type: 'redecode', id: decodeId, mode, params: { ...settings[mode] } });
  }, 90);
}

function buildPedals() {
  for (const pedal of document.querySelectorAll('.pedal')) {
    const m = pedal.dataset.mode, controls = [];
    pedal.classList.toggle('on', m === mode);
    for (const def of DEFS[m]) {
      const change = (v) => {
        settings[m][def.key] = v;
        remember(`settings-${m}`, JSON.stringify(settings[m]));
        if (m !== mode) setMode(m); // the pedal you touch is the one you hear
        else decodeAgain();
      };
      const c = def.kind === 'switch' ? createSwitch(def, settings[m][def.key], change) : createKnob(def, settings[m][def.key], change, { small: def.row === 'more' });
      controls.push([def, c]);
      pedal.querySelector(def.kind === 'switch' ? '.switches' : def.row === 'more' ? '.knobs.more' : '.knobs.main').append(c.root);
    }
    pedal.querySelector('.footswitch').addEventListener('click', () => setMode(m));
    pedal.querySelector('.reset').addEventListener('click', () => {
      Object.assign(settings[m], defaults(DEFS[m]));
      remember(`settings-${m}`, '{}');
      for (const [def, c] of controls) c.set(def.default);
      if (m === mode) decodeAgain();
      else setMode(m);
    });
  }
}
buildPedals();
const showBoard = (on) => {
  $('board').hidden = !on;
  $('pedals').setAttribute('aria-pressed', String(on));
  remember('board', on ? 'open' : 'closed');
};
$('pedals').addEventListener('click', () => showBoard($('board').hidden));
$('board-close').addEventListener('click', () => showBoard(false));
showBoard(recall('board') === 'open');

// --- Layers: the model's output before decoding (the heat map) and the notes. ---

const layers = { heat: recall('layer-heat') !== 'off', notes: recall('layer-notes') !== 'off' };
roll.setLayers(layers);
for (const box of document.querySelectorAll('[data-layer]')) {
  box.checked = layers[box.dataset.layer];
  box.addEventListener('change', () => {
    roll.setLayers({ [box.dataset.layer]: box.checked });
    remember(`layer-${box.dataset.layer}`, box.checked ? 'on' : 'off');
  });
}
$('layers').addEventListener('click', () => {
  const open = $('layers-pop').hidden;
  $('layers-pop').hidden = !open;
  $('layers').setAttribute('aria-expanded', String(open));
});
addEventListener('pointerdown', (e) => {
  if (!$('layers-pop').hidden && !e.target.closest('.layers')) { $('layers-pop').hidden = true; $('layers').setAttribute('aria-expanded', 'false'); }
});

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
  synthNotes();
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
  results = hit.notes;
  synthNotes();
  window.basicPitch = { name, mode, duration: hit.duration, notes: hit.notes, done: true, fromCache: true };
  finished = { name, mode, notes: hit.notes };
  setStatus(`${name}: ${hit.notes.length} notes`);
  setStats(`${modeLabel()} · saved in this browser from an earlier run.`);
  $('again').hidden = false;
  $('download').hidden = false;
}

const modeLabel = (custom = false) => `${mode === 'original' ? 'Original (melodia trick' : 'Live (streaming HMM'}${custom ? ', pedalboard settings' : ''})`;

// blob: the file (a File, or the example fetched as a Blob).
async function open(name, blob, { useCache = isDefaultFor(mode) } = {}) {
  const id = ++opened, stale = () => id !== opened;
  showTranscribe();
  decodeId = 0;
  worker?.terminate();
  worker = null;
  if (current?.blob !== blob) loadAudio(blob);
  current = { name, blob };
  finished = null;
  $('again').hidden = true;
  $('download').hidden = true;
  results = [];
  setStatus(`Decoding ${name}…`);
  setStats('');
  const bytes = await blob.arrayBuffer();
  const hash = await cache.fileHash(bytes).catch(() => null), key = cache.resultKey(hash, mode);
  if (stale()) return;
  current.hash = hash;
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
  results = result.notes;
  const runSettings = allSettings(), cacheable = isDefaultFor(runMode);
  window.basicPitch = result; // for scripted checks
  worker = new Worker('worker.js');
  worker.onmessage = ({ data: m }) => {
    if (m.type === 'ready') {
      runtime = `LiteRT.js wasm · ${m.numThreads} thread${m.numThreads === 1 ? '' : 's'}${m.threads ? '' : ' (page not cross-origin isolated)'}`;
      result.runtime = { threads: m.threads, numThreads: m.numThreads, loadMs: m.loadMs };
      setStatus(`Transcribing ${name}…`);
    } else if (m.type === 'progress') {
      if (m.activation) roll.addTile(m.window, m.activation);
      result.order.push(m.window);
      // Streamed notes count until the pedalboard asks for another decoding.
      if (decodeId === 0) {
        roll.addNotes(m.notes);
        result.notes.push(...m.notes);
        if (m.notes.length) synthNotes();
      }
      const secs = Math.min(duration, (m.done * FRAMES_PER_WINDOW * 256) / SAMPLE_RATE);
      setStatus(`Transcribing ${name}… ${m.done}/${m.windows} windows${runMode === 'original' ? ' · notes come once the whole file is in' : ''}`);
      setStats(`${runtime} · ${(secs / (m.elapsedMs / 1000)).toFixed(1)}× real time`);
    } else if (m.type === 'decoded') {
      if (m.id !== decodeId) return;
      const notes = m.notes;
      for (const n of notes) n[5] ??= velocity(meanActivation(roll.tiles, FRAMES_PER_WINDOW, n[0], n[1], n[2]));
      roll.setNotes(notes);
      results = notes;
      synthNotes();
      Object.assign(window.basicPitch, { mode: m.mode, notes, decodeMs: m.decodeMs, redecoded: true });
      finished = { name, mode: m.mode, notes };
      setStatus(`${name}: ${notes.length} notes`);
      setStats(`${modeLabel(!isDefaultFor(m.mode))} · decoded again in ${m.decodeMs < 1000 ? `${Math.round(m.decodeMs)} ms` : `${(m.decodeMs / 1000).toFixed(1)} s`}, without running the model`);
      if (isDefaultFor(m.mode)) cache.save({ key: cache.resultKey(current?.hash, m.mode), name, duration, totalFrames, notes, activation: roll.activation() });
    } else if (m.type === 'done') {
      if (decodeId !== 0) {
        // The pedalboard changed something meanwhile; its decoding comes next.
        Object.assign(result, { done: true, elapsedMs: m.elapsedMs, modelMs: m.modelMs, runs: m.runs, windows: m.windows });
        $('again').hidden = false;
        $('download').hidden = false;
        return;
      }
      roll.addNotes(m.notes);
      result.notes.push(...m.notes);
      // Live notes get their velocity now that every window's activations are in.
      for (const n of result.notes) n[5] ??= velocity(meanActivation(roll.tiles, FRAMES_PER_WINDOW, n[0], n[1], n[2]));
      synthNotes();
      finished = { name, mode: runMode, notes: result.notes };
      $('download').hidden = false;
      Object.assign(result, { done: true, elapsedMs: m.elapsedMs, modelMs: m.modelMs, decodeMs: m.decodeMs, runs: m.runs, windows: m.windows });
      $('again').hidden = false;
      setStatus(`${name}: ${result.notes.length} notes`);
      const notesTime = runMode === 'original' ? ` · note creation ${(m.decodeMs / 1000).toFixed(2)} s` : '';
      setStats(`${modeLabel(!cacheable)} · ${runtime} · ${(duration / (m.elapsedMs / 1000)).toFixed(1)}× real time · model ${(m.modelMs / 1000).toFixed(2)} s for ${duration.toFixed(1)} s of audio${notesTime}`);
      if (cacheable) cache.save({ key, name, duration, totalFrames, notes: result.notes, activation: roll.activation() });
    } else if (m.type === 'error') {
      setStatus(`Something went wrong: ${m.message.split('\n')[0]}`);
      result.error = m.message;
      console.error(m.message);
    }
  };
  worker.postMessage({ type: 'transcribe', audio: samples, mode: runMode, params: runSettings, view }, [samples.buffer]);
}

// --- Playback: the song through an <audio> element, the notes through a synth, mixed in one
// AudioContext (made on the first play, which needs a click). ---

let audioUrl = null, raf = 0, last = null, results = [], graph = null;
let listen = ['song', 'notes', 'both'].includes(recall('listen')) ? recall('listen') : 'both';

function loadAudio(blob) {
  audio.pause();
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(blob);
  audio.src = audioUrl;
  clock.reset();
  $('player').hidden = false;
  $('play').disabled = false;
}

function audioGraph() {
  if (!graph) {
    const ctx = new AudioContext(), song = ctx.createGain(), notes = ctx.createGain();
    ctx.createMediaElementSource(audio).connect(song).connect(ctx.destination);
    notes.connect(ctx.destination);
    graph = { ctx, song, notes, player: new NotePlayer(ctx, notes) };
    window.notePlayer = graph.player; // for scripted checks
    applyMix();
    synthNotes();
  }
  graph.ctx.resume();
  return graph;
}

function applyMix() {
  if (!graph) return;
  const g = mix(listen);
  graph.song.gain.value = g.song;
  graph.notes.gain.value = g.notes;
}

// The notes the synth plays: velocities of live notes come from the activations seen so far.
function synthNotes() {
  if (!graph) return;
  graph.player.setNotes(results.map(([s, e, pitch, , , vel]) => ({
    t0: frameToTime(s), t1: frameToTime(e), pitch,
    velocity: vel ?? velocity(meanActivation(roll.tiles, FRAMES_PER_WINDOW, s, e, pitch)),
  })));
}

for (const input of document.querySelectorAll('input[name="listen"]')) {
  input.checked = input.value === listen;
  input.addEventListener('change', () => { listen = input.value; remember('listen', listen); applyMix(); });
}

function showTime(t) {
  const text = formatTime(t);
  if ($('time').textContent !== text) $('time').textContent = text;
}

function frame(now) {
  const t = clock.time();
  const motion = last ? { advance: Math.max(0, t - last.t), dt: (now - last.now) / 1000 } : { advance: 0, dt: 0 };
  last = { t, now };
  roll.setPlayhead(t, motion);
  showTime(t);
  if (!audio.paused) graph?.player.tick(t);
  raf = audio.paused ? 0 : requestAnimationFrame(frame);
}

function seek(t) {
  audio.currentTime = t;
  clock.reset();
  last = null;
  graph?.player.reset();
  roll.setPlayhead(t);
  roll.reveal();
  showTime(t);
}

function toggle() {
  if (!audio.src) return;
  if (!audio.paused) return audio.pause();
  audioGraph();
  if (audio.ended || audio.currentTime >= roll.duration - 0.05) seek(0);
  audio.play().catch((err) => setStats(`Can't play this file here: ${err.message}`));
}

audio.addEventListener('play', () => {
  $('player').classList.add('playing');
  $('play').setAttribute('aria-label', 'Pause');
  last = null;
  graph?.player.reset();
  roll.follow(true);
  if (!raf) raf = requestAnimationFrame(frame);
});
const paused = () => {
  $('player').classList.remove('playing');
  $('play').setAttribute('aria-label', 'Play');
  graph?.player.reset();
  const t = clock.time();
  roll.setPlayhead(t);
  showTime(t);
};
audio.addEventListener('pause', paused);
audio.addEventListener('ended', paused);
audio.addEventListener('seeking', () => { clock.reset(); graph?.player.reset(); });
audio.addEventListener('error', () => {
  if (!audio.getAttribute('src')) return;
  $('play').disabled = true;
  setStats("This browser can't play the file.");
});

$('play').addEventListener('click', toggle);
$('follow').addEventListener('click', () => roll.follow(true));
$('zoom-in').addEventListener('click', () => roll.zoomBy(1.5));
$('zoom-out').addEventListener('click', () => roll.zoomBy(1 / 1.5));

// Space plays and pauses, except where it means something already (buttons, text, radios).
addEventListener('keydown', (e) => {
  if (e.key !== ' ' || e.repeat || $('panel-transcribe').hidden || e.target.closest?.('button, textarea, select, label') || e.target.tagName === 'INPUT') return;
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
