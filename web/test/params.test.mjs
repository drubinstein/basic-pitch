// The control panel's knobs: their defaults are the decoders' defaults, they map onto each decoder's
// options, and knob values move, snap and turn the way a knob should.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE, ORIGINAL, defaults, isDefault, hmmOptions, originalOptions } from '../src/params.js';
import { snap, dragTo, angle } from '../src/knob.js';
import { DEFAULT_PARAMS } from '../src/hmm.js';
import { ORIGINAL_DEFAULTS } from '../src/original.js';

test('live knobs default to the streaming decoder\'s settings', () => {
  const { prm, beam, maxLag } = hmmOptions(defaults(LIVE));
  assert.deepEqual(prm, DEFAULT_PARAMS);
  assert.equal(beam, 2);
  assert.equal(maxLag, 100);
});

test('original knobs default to predict()\'s settings', () => {
  assert.deepEqual(originalOptions(defaults(ORIGINAL)), { ...ORIGINAL_DEFAULTS, inferOnsets: true });
});

test('every knob\'s default is inside its range and on its step', () => {
  for (const k of [...LIVE, ...ORIGINAL].filter((k) => k.kind !== 'switch')) {
    assert.ok(k.min <= k.default && k.default <= k.max, k.key);
    assert.equal(snap(k.default, k), k.default, k.key);
  }
});

test('settings are default until a knob moves', () => {
  const p = defaults(LIVE);
  assert.ok(isDefault(LIVE, p));
  assert.ok(!isDefault(LIVE, { ...p, theta_f: 0.45 }));
  assert.ok(isDefault(LIVE, { ...p, unknown: 1 }));
});

test('knob values snap to their step and stay in range', () => {
  const k = { min: 0.05, max: 0.95, step: 0.01 };
  assert.equal(snap(0.4049, k), 0.4);
  assert.equal(snap(2, k), 0.95);
  assert.equal(snap(-1, k), 0.05);
  assert.equal(snap(7.6, { min: 1, max: 12, step: 1 }), 8);
});

test('dragging up 200 px sweeps the whole range; shift drags ten times finer', () => {
  const k = { min: 0, max: 10, step: 0.1 };
  assert.equal(dragTo(5, -100, k), 10);
  assert.equal(dragTo(5, 40, k), 3);
  assert.equal(dragTo(5, -100, k, true), 5.5);
});

test('the pointer turns from -135 to 135 degrees', () => {
  const k = { min: 0, max: 10 };
  assert.equal(angle(0, k), -135);
  assert.equal(angle(5, k), 0);
  assert.equal(angle(10, k), 135);
});
