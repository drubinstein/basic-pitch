// Playback helpers: the time readout, a playhead clock that moves smoothly between the media
// element's time updates, and how the piano roll follows the playhead.

// Where the playhead sits in the view while following, as a fraction of its width, so most of
// what's on screen is what's coming up.
export const ANCHOR = 0.25;
const CATCH_UP = 4; // per second: how fast the view closes the gap to the anchor

// m:ss.s, or with more `digits` after the point.
export function formatTime(s, digits = 1) {
  const unit = 10 ** digits, n = s > 0 ? Math.floor(s * unit + 1e-6) : 0;
  const m = Math.floor(n / (60 * unit)), r = n - m * 60 * unit;
  return `${m}:${String(Math.floor(r / unit)).padStart(2, '0')}.${String(r % unit).padStart(digits, '0')}`;
}

// media: an HTMLMediaElement (or anything with currentTime, paused and playbackRate).
export class Clock {
  constructor(media, now = () => performance.now()) {
    Object.assign(this, { media, now });
    this.reset();
  }

  // Forget the last reading, e.g. after a seek, so the next one is taken as is.
  reset() {
    this.sync = null;
    this.last = -Infinity;
  }

  time() {
    const m = this.media, cur = m.currentTime, now = this.now();
    if (m.paused) {
      this.sync = null;
      return (this.last = cur);
    }
    if (!this.sync || cur !== this.sync.media) this.sync = { media: cur, wall: now };
    let t = this.sync.media + ((now - this.sync.wall) / 1000) * m.playbackRate;
    // A media time slightly behind our estimate is jitter, not a seek: don't step back.
    if (t < this.last && this.last - t < 0.25) t = this.last;
    return (this.last = t);
  }
}

// The view's new start time while following the playhead at t (seconds), given how far the
// playhead moved since the last frame (`advance`) and the wall time since then (`dt`). Off
// screen, the view jumps to the playhead; left of the anchor, the view stays put; past it, the
// view moves with the playhead and closes the gap smoothly.
export function followT0({ t0, span, t, advance, dt, duration }) {
  const max = Math.max(0, duration - span), clamp = (v) => Math.min(max, Math.max(0, v));
  const target = t - ANCHOR * span;
  if (t < t0 || t > t0 + span) return clamp(target);
  if (target <= t0) return clamp(t0);
  const gap = target - advance - t0; // before this frame's advance
  return clamp(Math.min(target, t0 + Math.max(0, advance + gap * Math.min(1, CATCH_UP * dt))));
}
