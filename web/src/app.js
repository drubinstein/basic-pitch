// Page wiring: decode audio to 22050 Hz mono, hand it to the transcription worker, draw what comes
// back, play the file (and/or the notes, through a small synth) with a playhead over the roll, and
// keep finished results in this browser so reopening a file is instant.
import { FRAMES_PER_WINDOW, N_PITCHES, SAMPLE_RATE, frameToTime, nOutputFrames } from './pipeline.js';
import { PianoRoll } from './roll.js';
import * as cache from './cache.js';
import { Clock, formatTime, ANCHOR } from './playback.js';
import { startMic, toWav } from './mic.js';
import { noteName, noteHz, meanActivation } from './notes.js';
import { toMidi, velocity } from './midi.js';
import { bendsFromTiles, BINS_PER_SEMITONE } from './bends.js';
import { NotePlayer, mix, PRESETS, preset } from './synth.js';
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
  // The report's charts and data load only when the tab is first opened.
  if (name === 'report') import('./report.js').then((r) => r.renderReport());
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
  for (const u of document.querySelectorAll('.unit')) u.classList.toggle('on', u.dataset.mode === mode);
  if (current) decodeAgain();
}

// --- Control panel: knobs for each decoder's settings. The worker keeps the model's output, so a
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
    if (!worker) return open(current.name, current.blob, { useCache: isDefaultFor(mode), keepView: true });
    decodeId++;
    setStatus(`Decoding ${current.name}…`);
    worker.postMessage({ type: 'redecode', id: decodeId, mode, params: { ...settings[mode] } });
  }, 90);
}

function buildControls() {
  for (const unit of document.querySelectorAll('.unit[data-mode]')) {
    const m = unit.dataset.mode, controls = [];
    unit.classList.toggle('on', m === mode);
    for (const def of DEFS[m]) {
      const change = (v) => {
        settings[m][def.key] = v;
        remember(`settings-${m}`, JSON.stringify(settings[m]));
        if (m !== mode) setMode(m); // the decoder you adjust is the one you hear
        else decodeAgain();
      };
      const c = def.kind === 'switch' ? createSwitch(def, settings[m][def.key], change) : createKnob(def, settings[m][def.key], change, { small: def.row === 'more' });
      controls.push([def, c]);
      unit.querySelector(def.kind === 'switch' ? '.switches' : def.row === 'more' ? '.knobs.more' : '.knobs.main').append(c.root);
    }
    unit.querySelector('.engage').addEventListener('click', () => setMode(m));
    unit.querySelector('.reset').addEventListener('click', () => {
      Object.assign(settings[m], defaults(DEFS[m]));
      remember(`settings-${m}`, '{}');
      for (const [def, c] of controls) c.set(def.default);
      if (m === mode) decodeAgain();
      else setMode(m);
    });
  }
}
buildControls();
const showPanel = (on) => {
  $('control-panel').hidden = !on;
  $('controls').setAttribute('aria-pressed', String(on));
  remember('control-panel', on ? 'open' : 'closed');
};
$('controls').addEventListener('click', () => showPanel($('control-panel').hidden));
$('panel-close').addEventListener('click', () => showPanel(false));
showPanel(recall('control-panel') === 'open');

// --- Layers: the model's output before decoding (the heat map) and the notes. ---

const layers = { heat: recall('layer-heat') !== 'off', notes: recall('layer-notes') !== 'off', bends: recall('layer-bends') !== 'off' };
roll.setLayers(layers);
for (const box of document.querySelectorAll('[data-layer]')) {
  box.checked = layers[box.dataset.layer];
  box.addEventListener('change', () => {
    roll.setLayers({ [box.dataset.layer]: box.checked });
    remember(`layer-${box.dataset.layer}`, box.checked ? 'on' : 'off');
  });
}
$('layers').addEventListener('click', () => {
  const show = $('layers-pop').hidden;
  $('layers-pop').hidden = !show;
  $('layers').setAttribute('aria-expanded', String(show));
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
function resetRoll(duration, totalFrames, keepView = false) {
  const kept = keepView && roll.pps !== null ? { t0: roll.t0, pps: roll.pps } : null;
  roll.reset(duration, totalFrames);
  if (kept) Object.assign(roll, kept);
  synthNotes({ replace: true });
  $('total').textContent = formatTime(duration);
  showTime(clock.time());
  if (audio.src) {
    roll.setPlayhead(clock.time());
    if (!audio.paused) roll.follow(true);
  }
}

function showCached(name, hit, keepView = false) {
  resetRoll(hit.duration, hit.totalFrames, keepView);
  const step = FRAMES_PER_WINDOW * N_PITCHES;
  for (let w = 0; w * FRAMES_PER_WINDOW < hit.totalFrames; w++) roll.addTile(w, hit.activation.subarray(w * step, (w + 1) * step), hit.bends?.subarray(w * step, (w + 1) * step));
  roll.addNotes(hit.notes);
  results = hit.notes;
  synthNotes({ replace: true });
  window.basicPitch = { name, mode, duration: hit.duration, notes: hit.notes, done: true, fromCache: true };
  finished = { name, mode, notes: hit.notes };
  setStatus(`${name}: ${hit.notes.length} notes`);
  setStats(`${modeLabel()} · saved in this browser from an earlier run.`);
  $('again').hidden = false;
  $('download').hidden = false;
}

const modeLabel = (custom = false) => `${mode === 'original' ? 'Original (melodia trick' : 'Live (streaming HMM'}${custom ? ', custom settings' : ''})`;

// Notes decoded again from the control panel (same model output, other settings or decoder).
function applyDecoded(m, { name, duration, totalFrames }) {
  if (m.id !== decodeId) return;
  const notes = m.notes;
  for (const n of notes) n[5] ??= velocity(meanActivation(roll.tiles, FRAMES_PER_WINDOW, n[0], n[1], n[2]));
  roll.setNotes(notes);
  results = notes;
  synthNotes({ replace: true });
  Object.assign(window.basicPitch, { mode: m.mode, notes, decodeMs: m.decodeMs, redecoded: true });
  finished = { name, mode: m.mode, notes };
  setStatus(`${name}: ${notes.length} notes`);
  setStats(`${modeLabel(!isDefaultFor(m.mode))} · decoded again in ${m.decodeMs < 1000 ? `${Math.round(m.decodeMs)} ms` : `${(m.decodeMs / 1000).toFixed(1)} s`}, without running the model`);
  if (isDefaultFor(m.mode)) cache.save({ key: cache.resultKey(current?.hash, m.mode), name, duration, totalFrames, notes, activation: roll.activation(), bends: roll.bends() });
}

// blob: the file (a File, or the example fetched as a Blob). keepView: the same file again (from the
// control panel), so keep the zoom and the focus where they are.
async function open(name, blob, { useCache = isDefaultFor(mode), keepView = false } = {}) {
  const id = ++opened, stale = () => id !== opened;
  cancelRecording();
  showTranscribe();
  setStatus(`Decoding ${name}…`);
  // Read and decode before touching what's open, so a file that won't decode leaves it as it was.
  const bytes = await blob.arrayBuffer();
  const hash = await cache.fileHash(bytes).catch(() => null), key = cache.resultKey(hash, mode);
  if (stale()) return;
  const hit = useCache ? await cache.load(key) : null;
  if (stale()) return;
  let samples = null;
  if (!hit) {
    try {
      samples = await decode(bytes);
    } catch (err) {
      if (!stale()) setStatus(`Couldn't decode ${name}: ${err.message}`);
      return;
    }
    if (stale()) return;
  }
  decodeId = 0;
  worker?.terminate();
  worker = null;
  roll.anchor = ANCHOR;
  if (current?.blob !== blob) loadAudio(blob);
  current = { name, blob, hash };
  finished = null;
  $('again').hidden = true;
  $('download').hidden = true;
  results = [];
  setStats('');
  if (hit) return showCached(name, hit, keepView);
  const duration = samples.length / SAMPLE_RATE, totalFrames = nOutputFrames(samples.length), runMode = mode;
  resetRoll(duration, totalFrames, keepView);
  if (!keepView) $('roll').focus();
  let runtime = '';
  const result = { name, mode: runMode, duration, notes: [], order: [] };
  results = result.notes;
  const runSettings = allSettings(), cacheable = isDefaultFor(runMode);
  window.basicPitch = result; // for scripted checks
  const w = (worker = new Worker('worker.js'));
  const fail = (message) => {
    if (worker !== w) return;
    setStatus(`Something went wrong: ${message.split('\n')[0]}`);
    result.error = message;
    console.error(message);
    w.terminate();
    worker = null; // so the control panel and Run again start over
    $('again').hidden = false;
  };
  w.onerror = (e) => { e.preventDefault(); fail(e.message || "The transcription worker didn't start."); };
  w.onmessage = ({ data: m }) => {
    if (worker !== w) return;
    if (m.type === 'ready') {
      runtime = `LiteRT.js wasm · ${m.numThreads} thread${m.numThreads === 1 ? '' : 's'}${m.threads ? '' : ' (page not cross-origin isolated)'}`;
      result.runtime = { threads: m.threads, numThreads: m.numThreads, loadMs: m.loadMs };
      setStatus(`Transcribing ${name}…`);
    } else if (m.type === 'progress') {
      if (m.activation) roll.addTile(m.window, m.activation, m.bends);
      result.order.push(m.window);
      // Streamed notes count until the control panel asks for another decoding.
      if (decodeId === 0) {
        roll.addNotes(m.notes);
        result.notes.push(...m.notes);
        if (m.notes.length) synthNotes();
      }
      const secs = Math.min(duration, (m.done * FRAMES_PER_WINDOW * 256) / SAMPLE_RATE);
      setStatus(`Transcribing ${name}… ${m.done}/${m.windows} windows${runMode === 'original' ? ' · notes come once the whole file is in' : ''}`);
      setStats(`${runtime} · ${(secs / (m.elapsedMs / 1000)).toFixed(1)}× real time`);
    } else if (m.type === 'decoded') {
      applyDecoded(m, { name, duration, totalFrames });
    } else if (m.type === 'done') {
      if (decodeId !== 0) {
        // The control panel changed something meanwhile; its decoding comes next.
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
      if (cacheable) cache.save({ key, name, duration, totalFrames, notes: result.notes, activation: roll.activation(), bends: roll.bends() });
    } else if (m.type === 'error') fail(m.message);
  };
  w.postMessage({ type: 'transcribe', audio: samples, mode: runMode, params: runSettings, view }, [samples.buffer]);
}

// --- Playback: the song through an <audio> element, the notes through a synth, mixed in one
// AudioContext (made on the first play, which needs a click). ---

let audioUrl = null, raf = 0, last = null, results = [], graph = null;
// The mix knob: -1 only the song, +1 only the notes; Song / Notes / Both in the player are presets.
let balance = (() => {
  const v = parseFloat(recall('balance'));
  return Number.isFinite(v) ? Math.min(1, Math.max(-1, v)) : 0;
})();
const MIX = { key: 'balance', label: 'Song : Notes', min: -1, max: 1, step: 0.05, default: 0, hint: 'How loud the song is against the notes played by the synth',
  format: (v) => { const g = mix(v); return `${Math.round(g.song * 100)} : ${Math.round(g.notes * 100)}`; } };
let mixKnob = null;

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
  const g = mix(balance);
  graph.song.gain.value = g.song;
  graph.notes.gain.value = g.notes;
}

// The notes the synth plays: velocities of live notes come from the activations seen so far. When the
// notes are replaced (not just added to), voices already scheduled are stopped.
function synthNotes({ replace = false } = {}) {
  if (!graph) return;
  if (replace) graph.player.reset();
  graph.player.setNotes(results.map(([s, e, pitch, , , vel]) => ({
    t0: frameToTime(s), t1: frameToTime(e), pitch,
    velocity: vel ?? velocity(meanActivation(roll.tiles, FRAMES_PER_WINDOW, s, e, pitch)),
    bends: bendsFromTiles(roll.bendTiles, FRAMES_PER_WINDOW, s, e, pitch),
  })));
}

function setBalance(v, fromKnob = false) {
  balance = v;
  remember('balance', String(v));
  applyMix();
  for (const input of document.querySelectorAll('input[name="listen"]')) input.checked = input.value === preset(v);
  if (!fromKnob) mixKnob?.set(v);
}
for (const input of document.querySelectorAll('input[name="listen"]')) {
  input.checked = input.value === preset(balance);
  input.addEventListener('click', () => setBalance(PRESETS[input.value])); // also when it already looks picked
}
mixKnob = createKnob(MIX, balance, (v) => setBalance(v, true));
document.querySelector('.unit.mix .knobs').append(mixKnob.root);

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
  raf = audio.paused ? 0 : requestAnimationFrame(frame);
}

function seek(t) {
  if (mic || !audio.getAttribute('src')) return;
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

// The synth is scheduled from a timer rather than animation frames, which stop in background tabs.
let synthTimer = 0;
audio.addEventListener('play', () => {
  clearInterval(synthTimer);
  synthTimer = setInterval(() => { if (!audio.paused) graph?.player.tick(clock.time()); }, 30);
  $('player').classList.add('playing');
  $('play').setAttribute('aria-label', 'Pause');
  last = null;
  graph?.player.reset();
  roll.follow(true);
  if (!raf) raf = requestAnimationFrame(frame);
});
const paused = () => {
  clearInterval(synthTimer);
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

// --- Microphone: transcribe while you play or sing. Audio streams to the worker, which runs each
// model window as soon as its audio is in; notes trail the sound by about one window (2 s). When
// recording stops, the recording becomes a file like any other. ---

const MIN_VIEW = 8; // seconds shown while a recording is still short
let mic = null, micLast = null;

let micStarting = false;
async function startRecording() {
  if (mic || micStarting) return;
  micStarting = true;
  const id = opened, before = $('status').textContent;
  const name = `recording-${new Date().toTimeString().slice(0, 8).replaceAll(':', '')}.wav`;
  const session = { name, runtime: '', chunks: [], samples: 0, liveSettings: JSON.stringify(settings.live) };
  const result = { name, mode: 'live', duration: 0, notes: [], order: [], recording: true };
  // Its own worker, so asking for the microphone doesn't disturb what's open until it's granted.
  const w = new Worker('worker.js');
  w.onmessage = ({ data: m }) => { if (worker === w) recordingMessage(m, session, result); };
  w.postMessage({ type: 'stream-start', params: allSettings() });
  setStatus('Asking for the microphone…');
  let capture;
  try {
    capture = await startMic((chunk) => {
      session.chunks.push(chunk.slice());
      session.samples += chunk.length;
      w.postMessage({ type: 'stream-audio', samples: chunk }, [chunk.buffer]);
    });
  } catch (err) {
    micStarting = false;
    w.terminate();
    if (id === opened) setStatus(`Couldn't use the microphone: ${err.message}`);
    if (!current && !finished) setTimeout(() => { if (id === opened && !mic) setStatus(before); }, 4000);
    return;
  }
  micStarting = false;
  if (id !== opened) { // something else was opened while the browser asked
    capture.stop();
    w.terminate();
    return;
  }
  // Granted: the recording replaces whatever was open.
  ++opened;
  decodeId = 0;
  worker?.terminate();
  worker = w;
  mic = capture;
  audio.pause();
  if (audio.getAttribute('src')) { audio.removeAttribute('src'); audio.load(); }
  $('player').hidden = true;
  current = null;
  finished = null;
  results = [];
  $('again').hidden = true;
  $('download').hidden = true;
  showTranscribe();
  window.basicPitch = result;
  roll.reset(MIN_VIEW, 0);
  roll.anchor = 0.85; // the live edge near the right, the past to its left
  Object.assign(mic, { session, start: mic.ctx.currentTime });
  $('mic').classList.add('recording');
  $('mic').querySelector('span').textContent = 'Stop';
  setStats('Notes trail the sound by about 2 s: the model listens in 2-second windows.');
  micLast = null;
  roll.follow(true);
  requestAnimationFrame(recordingFrame);
}

function recordingFrame(now) {
  if (!mic) return;
  const t = Math.max(0, mic.ctx.currentTime - mic.start);
  const motion = micLast ? { advance: Math.max(0, t - micLast.t), dt: (now - micLast.now) / 1000 } : { advance: 0, dt: 0 };
  micLast = { t, now };
  roll.grow(Math.max(MIN_VIEW, t), roll.totalFrames);
  roll.setPlayhead(t, motion);
  setStatus(`Listening… ${formatTime(t).slice(0, -2)}`);
  requestAnimationFrame(recordingFrame);
}

// Stop: the worker finishes the last window, and the recording becomes a WAV file.
function stopRecording() {
  if (!mic) return;
  const m = mic;
  mic = null;
  m.stop();
  worker?.postMessage({ type: 'stream-stop' });
  $('mic').classList.remove('recording');
  $('mic').querySelector('span').textContent = 'Mic';
  roll.anchor = ANCHOR;
  const samples = new Float32Array(m.session.samples);
  let o = 0;
  for (const c of m.session.chunks) { samples.set(c, o); o += c.length; }
  m.session.blob = new Blob([toWav(samples, SAMPLE_RATE)], { type: 'audio/wav' });
  m.session.chunks = [];
  setStatus(`Finishing ${m.session.name}…`);
}

function cancelRecording() {
  if (!mic) return;
  mic.stop();
  mic = null;
  roll.anchor = ANCHOR;
  $('mic').classList.remove('recording');
  $('mic').querySelector('span').textContent = 'Mic';
}

async function recordingMessage(m, session, result) {
  if (m.type === 'ready') {
    session.runtime = `LiteRT.js wasm · ${m.numThreads} thread${m.numThreads === 1 ? '' : 's'}`;
  } else if (m.type === 'progress') {
    roll.grow(Math.max(roll.duration, m.samples / SAMPLE_RATE), m.totalFrames);
    roll.addTile(m.window, m.activation, m.bends);
    if (decodeId === 0) {
      roll.addNotes(m.notes);
      result.notes.push(...m.notes);
    }
    result.order.push(m.window);
  } else if (m.type === 'done') {
    const duration = m.samples / SAMPLE_RATE, { name } = session;
    Object.assign(session, { duration, totalFrames: m.totalFrames });
    roll.anchor = ANCHOR;
    roll.grow(duration, m.totalFrames);
    if (decodeId === 0) {
      roll.addNotes(m.notes);
      result.notes.push(...m.notes);
    }
    for (const n of result.notes) n[5] ??= velocity(meanActivation(roll.tiles, FRAMES_PER_WINDOW, n[0], n[1], n[2]));
    results = result.notes;
    Object.assign(result, { done: true, duration, runs: m.runs, modelMs: m.modelMs });
    current = { name, blob: session.blob };
    loadAudio(session.blob);
    roll.setPlayhead(0);
    roll.fit();
    synthNotes();
    finished = { name, mode: 'live', notes: result.notes };
    $('again').hidden = false;
    $('download').hidden = false;
    $('total').textContent = formatTime(duration);
    setStatus(`${name}: ${result.notes.length} notes`);
    setStats(`Microphone · ${modeLabel(!isDefaultFor('live'))} · ${session.runtime} · model ${(m.modelMs / 1000).toFixed(2)} s for ${duration.toFixed(1)} s of audio`);
    current.hash = await cache.fileHash(await session.blob.arrayBuffer()).catch(() => null);
    // The worker has the whole recording's model output: re-decode for the original decoder, or for
    // live settings changed while recording.
    if (mode !== 'live' || JSON.stringify(settings.live) !== session.liveSettings) decodeAgain();
    else if (isDefaultFor('live')) cache.save({ key: cache.resultKey(current.hash, 'live'), name, duration, totalFrames: m.totalFrames, notes: result.notes, activation: roll.activation(), bends: roll.bends() });
  } else if (m.type === 'decoded') {
    applyDecoded(m, { name: session.name, duration: session.duration, totalFrames: session.totalFrames });
  } else if (m.type === 'error') {
    cancelRecording();
    setStatus(`Something went wrong: ${m.message.split('\n')[0]}`);
    result.error = m.message;
    console.error(m.message);
  }
}

$('mic').addEventListener('click', () => (mic ? stopRecording() : startRecording()));

// --- Note tooltip: the hovered note, or the selected one. ---

// "Bends from -33 to +67 cents", from the note's pitch bends (1/3 semitone each).
function bendLine(n) {
  const b = roll.noteBends(n);
  let lo = Infinity, hi = -Infinity;
  for (const v of b) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (!b.length || (!lo && !hi)) return '<div>No pitch bend</div>';
  const cents = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.round((Math.abs(v) * 100) / BINS_PER_SEMITONE)}`;
  return `<div>Bends ${lo === hi ? cents(lo) : `${cents(lo)} to ${cents(hi)}`} cents</div>`;
}

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
      + bendLine(n)
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
  const id = opened;
  setStatus('Loading the example…');
  try {
    const res = await fetch('examples/vocadito_10.wav');
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const blob = await res.blob();
    if (id === opened && !mic) open('vocadito_10.wav', blob);
  } catch (err) {
    if (id === opened) setStatus(`Couldn't load the example: ${err.message}`);
  }
});

$('again').addEventListener('click', () => current && open(current.name, current.blob, { useCache: false }));
$('fit').addEventListener('click', () => roll.fit());

// MIDI like basic-pitch's (pitch bends included, except on notes that overlap another), named like
// its <name>_basic_pitch.mid.
$('download').addEventListener('click', () => {
  if (!finished) return;
  const notes = finished.notes.map(([s, e, pitch, , , vel]) => ({ t0: frameToTime(s), t1: frameToTime(e), pitch, velocity: vel,
    bends: [...bendsFromTiles(roll.bendTiles, FRAMES_PER_WINDOW, s, e, pitch)] }));
  const base = finished.name.replace(/\.[^.]+$/, '');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([toMidi(notes)], { type: 'audio/midi' }));
  link.download = `${base}_basic_pitch${finished.mode === 'live' ? '_live' : ''}.mid`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});
$('forget').addEventListener('click', async () => {
  await cache.clear();
  $('forget').textContent = 'cleared';
  setTimeout(() => { $('forget').textContent = 'clear them'; }, 2500);
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
