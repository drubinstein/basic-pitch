// Helpers behind the report's charts: axis ticks, the best score per delay band, per-track gaps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { niceTicks, bestByBand, trackGaps } from '../src/chart-math.js';

test('axis ticks land on round numbers covering the range', () => {
  assert.deepEqual(niceTicks(0, 1, 5), [0, 0.2, 0.4, 0.6, 0.8, 1]);
  assert.deepEqual(niceTicks(0, 1180, 5), [0, 200, 400, 600, 800, 1000, 1200]);
  assert.deepEqual(niceTicks(-0.07, 0.12, 4), [-0.1, -0.05, 0, 0.05, 0.1, 0.15]);
  assert.deepEqual(niceTicks(0.4, 0.62, 4), [0.4, 0.45, 0.5, 0.55, 0.6, 0.65]);
});

test('the best trial in each delay band, by the chosen column', () => {
  const trials = [[10, 0.5], [30, 0.55], [50, 0.6], [400, 0.58], [900, 0.61]];
  assert.deepEqual(bestByBand(trials, [0, 46, 93, 460, Infinity], 1), [
    { from: 0, to: 46, best: 0.55, n: 2 },
    { from: 46, to: 93, best: 0.6, n: 1 },
    { from: 93, to: 460, best: 0.58, n: 1 },
    { from: 460, to: Infinity, best: 0.61, n: 1 },
  ]);
  assert.deepEqual(bestByBand([], [0, 10], 1), [{ from: 0, to: 10, best: null, n: 0 }]);
});

test('per-track gaps against the bar, best first, with how many are ahead', () => {
  const rows = [['a', 0.5, 0.6], ['b', 0.7, 0.65], ['c', 0.4, 0.4]];
  const { gaps, ahead } = trackGaps(rows, 1, 2); // decoder in column 2, bar in column 1
  assert.deepEqual(gaps.map((g) => [g.name, +g.gap.toFixed(2)]), [['a', 0.1], ['c', 0], ['b', -0.05]]);
  assert.equal(ahead, 1);
});
