// Model windows can be processed in any order (whatever is on screen first). The notes must come
// out the same as decoding front to back, each note once, without holding every window in memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { StreamingHmm } from '../src/hmm.js';
import { WindowedDecoder, nextWindow, nextMissing } from '../src/segments.js';
import { FRAMES_PER_WINDOW as F } from '../src/pipeline.js';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);
const ref = JSON.parse(fs.readFileSync(fixture('vocadito_10_hmm.json')));
const load = (name) => {
  const buf = zlib.gunzipSync(fs.readFileSync(fixture(name)));
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
};
const opts = { prm: ref.prm, beam: ref.beam, maxLag: ref.max_lag };

// The fixture repeated a few times, so there are enough windows to jump around in.
const REPEAT = 4, T = ref.T * REPEAT;
const tile = (x) => { const out = new Float32Array(x.length * REPEAT); for (let r = 0; r < REPEAT; r++) out.set(x, r * x.length); return out; };
const note = tile(load('vocadito_10_note.f32.gz')), onset = tile(load('vocadito_10_onset.f32.gz'));
const windowData = (w) => {
  const a = w * F * 88, b = Math.min(T, (w + 1) * F) * 88;
  return [note.slice(a, b), onset.slice(a, b)];
};

const sequential = (() => {
  const hmm = new StreamingHmm(opts.prm, opts);
  for (let t = 0; t < T; t++) hmm.push(note.subarray(t * 88, t * 88 + 88), onset.subarray(t * 88, t * 88 + 88));
  return hmm.finish();
})();
const key3 = (n) => n.slice(0, 3).join(',');
const sorted = (notes, key) => notes.map(key).sort();

function runOrder(order) {
  const dec = new WindowedDecoder(T, opts), notes = [];
  for (const w of order) notes.push(...dec.add(w, ...windowData(w)));
  // A segment closing out long notes may need a window that was already dropped; rerun those.
  for (let i = 0; i < 4 && !dec.complete; i++) for (const w of dec.waiting()) notes.push(...dec.add(w, ...windowData(w)));
  assert.ok(dec.complete, 'complete once every window is in');
  return notes;
}

const shuffled = (n, seed) => {
  const a = [...Array(n).keys()];
  let s = seed;
  for (let i = n - 1; i > 0; i--) { s = (s * 1103515245 + 12345) % 2 ** 31; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

test('windows in order give exactly the front-to-back notes', () => {
  const n = Math.ceil(T / F);
  const notes = runOrder([...Array(n).keys()]);
  assert.deepEqual(sorted(notes, (x) => x.join(',')), sorted(sequential, (x) => x.join(',')));
});

test('any window order gives the same notes, each once', () => {
  const n = Math.ceil(T / F);
  const orders = [
    [...Array(n).keys()].reverse(),
    [...Array(n).keys()].map((i) => (i + Math.floor(n / 2)) % n),
    ...[1, 2, 3, 4, 5, 6].map((seed) => shuffled(n, seed)),
  ];
  const want = sorted(sequential, key3);
  for (const order of orders) {
    const got = sorted(runOrder(order), key3);
    assert.deepEqual(got, want, `order ${order.join(' ')}`);
  }
});

test('the scheduler does the visible windows first, then the rest, with few windows held', () => {
  const n = Math.ceil(T / F), dec = new WindowedDecoder(T, opts), notes = [], computed = [];
  let view = [12, 14], held = 0;
  for (let step = 0; step < 4 * n; step++) {
    if (step === 6) view = [3, 4]; // the user pans back
    const w = nextWindow(dec, ...view);
    if (w < 0) break;
    computed.push(w);
    notes.push(...dec.add(w, ...windowData(w)));
    held = Math.max(held, dec.heldWindows);
  }
  assert.ok(dec.complete);
  // Pre-roll window, then the visible ones.
  assert.deepEqual(computed.slice(0, 4).sort((a, b) => a - b), [11, 12, 13, 14]);
  for (const w of [12, 13, 14]) assert.ok(computed.indexOf(w) < 6);
  for (const w of [3, 4]) assert.ok(computed.indexOf(w) < 6 + 3, `window ${w} soon after panning`);
  assert.deepEqual(sorted(notes, key3), sorted(sequential, key3));
  assert.ok(computed.length <= n + 4, `${computed.length} model runs for ${n} windows`);
  assert.ok(held <= 8, `held ${held} windows`);
});

test('without a streaming decoder, windows on screen come first, then the rest from there on', () => {
  const done = new Array(10).fill(false), order = [];
  for (let w; (w = nextMissing(done, 6, 7)) >= 0; ) { order.push(w); done[w] = true; }
  assert.deepEqual(order, [6, 7, 8, 9, 0, 1, 2, 3, 4, 5]);
  assert.equal(nextMissing([], 0, 0), -1);
});
