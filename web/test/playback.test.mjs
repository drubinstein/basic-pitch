// Playback: the time readout, a smooth playhead clock, and the roll following the playhead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTime, Clock, followT0, ANCHOR } from '../src/playback.js';

test('times read as minutes, seconds and tenths', () => {
  assert.deepEqual([0, 1.26, 65.31, 600, 3725.04, -1, NaN].map((s) => formatTime(s)), ['0:00.0', '0:01.2', '1:05.3', '10:00.0', '62:05.0', '0:00.0', '0:00.0']);
  assert.equal(formatTime(65.317, 2), '1:05.31');
});

const media = (o) => ({ currentTime: 0, paused: false, playbackRate: 1, ...o });

test('the clock reads the media time when paused', () => {
  const m = media({ currentTime: 3, paused: true });
  const c = new Clock(m, () => 0);
  assert.equal(c.time(), 3);
});

test('between media time updates the clock moves on with the wall clock', () => {
  let now = 1000;
  const m = media({ currentTime: 3 }), c = new Clock(m, () => now);
  assert.equal(c.time(), 3);
  now += 100;
  assert.ok(Math.abs(c.time() - 3.1) < 1e-9);
  m.playbackRate = 2;
  now += 100;
  assert.ok(Math.abs(c.time() - 3.4) < 1e-9);
});

test('the clock resyncs when the media time updates, without stepping back a little', () => {
  let now = 1000;
  const m = media({ currentTime: 3 }), c = new Clock(m, () => now);
  c.time();
  now += 100;
  assert.ok(Math.abs(c.time() - 3.1) < 1e-9);
  m.currentTime = 3.09; // the media clock lags our estimate a touch
  now += 5;
  assert.ok(c.time() >= 3.1);
  m.currentTime = 3.2;
  now += 5;
  assert.equal(c.time(), 3.2);
});

test('a seek back is honoured', () => {
  let now = 1000;
  const m = media({ currentTime: 30 }), c = new Clock(m, () => now);
  c.time();
  m.currentTime = 2;
  now += 16;
  assert.equal(c.time(), 2);
});

const view = { t0: 0, span: 10, duration: 100 };

test('a playhead off screen brings the view to it', () => {
  assert.equal(followT0({ ...view, t: 40, advance: 0, dt: 0.016 }), 40 - ANCHOR * 10);
  assert.equal(followT0({ ...view, t0: 50, t: 40, advance: 0, dt: 0.016 }), 40 - ANCHOR * 10);
});

test('the view stays put until the playhead reaches the anchor', () => {
  assert.equal(followT0({ ...view, t: 1, advance: 0.016, dt: 0.016 }), 0);
});

test('past the anchor the view catches up smoothly, then locks on', () => {
  let t0 = 0, t = 6;
  const first = followT0({ ...view, t0, t, advance: 0.016, dt: 0.016 });
  assert.ok(first > 0 && first < t - ANCHOR * 10, 'moves part of the way');
  for (let i = 0; i < 600; i++) { t += 0.016; t0 = followT0({ ...view, t0, t, advance: 0.016, dt: 0.016 }); }
  assert.ok(Math.abs(t - t0 - ANCHOR * 10) < 1e-3, 'playhead held at the anchor');
});

test('the view never runs past the ends of the file', () => {
  assert.equal(followT0({ ...view, t: 99, advance: 0, dt: 0.016 }), 90);
  assert.equal(followT0({ ...view, t0: 5, t: 0.5, advance: 0, dt: 0.016 }), 0);
  assert.equal(followT0({ t0: 0, span: 200, duration: 100, t: 60, advance: 0, dt: 0.016 }), 0);
});

test('while recording, the live edge can sit near the right instead', () => {
  assert.equal(followT0({ ...view, t: 40, advance: 0, dt: 0.016, anchor: 0.85 }), 40 - 0.85 * 10);
  assert.equal(followT0({ ...view, t: 5, advance: 0.016, dt: 0.016, anchor: 0.85 }), 0);
});
