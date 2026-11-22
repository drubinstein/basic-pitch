// Page wiring: decode audio to 22050 Hz mono, hand it to the transcription worker, draw what comes back.
import { SAMPLE_RATE, frameToTime } from './pipeline.js';
import { PianoRoll } from './roll.js';

const $ = (id) => document.getElementById(id);
const roll = new PianoRoll($('roll'), frameToTime);
let worker = null;

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

async function transcribe(name, bytes) {
  worker?.terminate();
  setStatus(`Decoding ${name}…`);
  setStats('');
  let audio;
  try {
    audio = await decode(bytes);
  } catch (err) {
    setStatus(`Couldn't decode ${name}: ${err.message}`);
    return;
  }
  const duration = audio.length / SAMPLE_RATE;
  roll.reset(duration);
  $('roll').focus();
  let noteCount = 0, runtime = '';
  const result = { name, duration, notes: [] };
  window.basicPitch = result; // for scripted checks
  worker = new Worker('worker.js');
  worker.onmessage = ({ data: m }) => {
    if (m.type === 'ready') {
      runtime = `LiteRT.js wasm · ${m.numThreads} thread${m.numThreads === 1 ? '' : 's'}${m.threads ? '' : ' (page not cross-origin isolated)'}`;
      result.runtime = { threads: m.threads, numThreads: m.numThreads, loadMs: m.loadMs };
      setStatus(`Transcribing ${name}…`);
    } else if (m.type === 'progress' || m.type === 'done') {
      if (m.type === 'progress') roll.addTile(m.start, m.frames, m.activation);
      roll.addNotes(m.notes);
      result.notes.push(...m.notes);
      noteCount += m.notes.length;
      const done = m.type === 'done', secs = done ? duration : Math.min(duration, frameToTime(m.start + m.frames));
      const speed = secs / (m.elapsedMs / 1000);
      setStatus(done ? `${name}: ${noteCount} notes` : `Transcribing ${name}… window ${m.window}/${m.windows}`);
      setStats(`${runtime} · ${speed.toFixed(1)}× real time · model ${(m.modelMs / 1000).toFixed(2)} s for ${duration.toFixed(1)} s of audio`);
      if (done) Object.assign(result, { done: true, elapsedMs: m.elapsedMs, modelMs: m.modelMs });
    } else if (m.type === 'error') {
      setStatus(`Something went wrong: ${m.message.split('\n')[0]}`);
      result.error = m.message;
      console.error(m.message);
    }
  };
  worker.postMessage({ audio }, [audio.buffer]);
}

$('file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) transcribe(file.name, await file.arrayBuffer());
});

$('example').addEventListener('click', async () => {
  setStatus('Loading the example…');
  const res = await fetch('examples/vocadito_10.wav');
  transcribe('vocadito_10.wav', await res.arrayBuffer());
});

$('fit').addEventListener('click', () => roll.fit());

// Drop a file anywhere on the page.
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) transcribe(file.name, await file.arrayBuffer());
});
