// Seeking from the time axis under the piano roll: the time under a point on it, and what the keys
// do when it has focus (it's a slider for keyboards and screen readers).
export const KEY_STEP = 5, FINE_STEP = 1, PAGE_STEP = 30; // seconds

const clamp = (t, duration) => Math.min(duration, Math.max(0, t));

// x on the canvas -> seconds, for a view starting at t0 with pps pixels per second between the
// canvas x positions `left` and `right`. Past either end of the axis, the edge of the view.
export function axisTime(x, { t0, pps, left, right, duration }) {
  const px = Math.min(right, Math.max(left, x));
  return clamp(t0 + (px - left) / pps, duration);
}

// The time a key moves to from t, or null for keys the seek bar doesn't use.
export function keyTime(key, t, duration, { shift = false } = {}) {
  const step = shift ? FINE_STEP : KEY_STEP;
  const moves = {
    ArrowRight: t + step, ArrowUp: t + step, ArrowLeft: t - step, ArrowDown: t - step,
    PageUp: t + PAGE_STEP, PageDown: t - PAGE_STEP, Home: 0, End: duration,
  };
  return key in moves ? clamp(moves[key], duration) : null;
}
