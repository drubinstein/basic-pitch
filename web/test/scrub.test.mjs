// Seeking from the time axis: where a point on it lands, and what the keys do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { axisTime, keyTime } from '../src/scrub.js';

const view = { t0: 10, pps: 20, left: 40, right: 840, duration: 100 }; // 10 s to 50 s on screen

test('a point on the axis is the time under it', () => {
  assert.equal(axisTime(40, view), 10);
  assert.equal(axisTime(240, view), 20);
  assert.equal(axisTime(840, view), 50);
});

test('dragging past either end of the axis stops at the edge of the view', () => {
  assert.equal(axisTime(0, view), 10);
  assert.equal(axisTime(5000, view), 50);
});

test('the time stays within the file', () => {
  assert.equal(axisTime(840, { ...view, t0: 70 }), 100);
  assert.equal(axisTime(40, { ...view, t0: -3 }), 0);
});

test('arrow keys step 5 s, or 1 s with shift', () => {
  assert.equal(keyTime('ArrowRight', 10, 100), 15);
  assert.equal(keyTime('ArrowUp', 10, 100), 15);
  assert.equal(keyTime('ArrowLeft', 10, 100), 5);
  assert.equal(keyTime('ArrowDown', 10, 100), 5);
  assert.equal(keyTime('ArrowRight', 10, 100, { shift: true }), 11);
  assert.equal(keyTime('ArrowLeft', 10, 100, { shift: true }), 9);
});

test('page keys step 30 s; Home and End go to the start and the end', () => {
  assert.equal(keyTime('PageUp', 10, 100), 40);
  assert.equal(keyTime('PageDown', 40, 100), 10);
  assert.equal(keyTime('Home', 40, 100), 0);
  assert.equal(keyTime('End', 40, 100), 100);
});

test('keys stop at the ends of the file', () => {
  assert.equal(keyTime('ArrowLeft', 2, 100), 0);
  assert.equal(keyTime('PageUp', 90, 100), 100);
});

test('other keys do nothing', () => {
  assert.equal(keyTime('a', 10, 100), null);
  assert.equal(keyTime(' ', 10, 100), null);
});
