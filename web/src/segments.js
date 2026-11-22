// Decode notes from model windows that arrive in any order, so whatever is on screen can be
// transcribed first, like map tiles.
//
// Each run of windows is decoded by its own streaming HMM (a "segment"). A segment that starts
// mid-file first reads one window before the region it owns (1.65 s of pre-roll; 1 s already gives
// the same notes as decoding from the start). A segment owns the notes that start in its region,
// which ends where the next segment's begins. When it reaches that point it keeps decoding the next
// segment's windows only until the notes it started are final, then stops.
//
// Window data is dropped once no segment needs it; if a segment later needs a dropped window,
// waiting() lists it and nextWindow() asks for it to be run through the model again.
import { StreamingHmm } from './hmm.js';
import { FRAMES_PER_WINDOW, N_PITCHES } from './pipeline.js';

class Segment {
  constructor(first, ownFrom, offset, opts) {
    this.hmm = new StreamingHmm(opts.prm, opts);
    Object.assign(this, { next: first, ownFrom, offset, until: Infinity, finished: false });
  }
}

export class WindowedDecoder {
  constructor(totalFrames, { prm, beam, maxLag, framesPerWindow = FRAMES_PER_WINDOW } = {}) {
    this.totalFrames = totalFrames;
    this.F = framesPerWindow;
    this.nWindows = Math.ceil(totalFrames / this.F);
    this.opts = { prm, beam, maxLag };
    this.data = new Array(this.nWindows).fill(null);
    this.segments = []; // sorted by ownFrom
  }

  start(w) { return w * this.F; }
  has(w) { return this.data[w] !== null; }
  get heldWindows() { return this.data.reduce((n, d) => n + (d ? 1 : 0), 0); }

  // The segment whose region contains window w, if any.
  owner(w) {
    const f = this.start(w);
    let o = null;
    for (const s of this.segments) { if (s.ownFrom <= f) o = s; else break; }
    return o;
  }

  // Window w is done once its owner has decoded it.
  isDone(w) {
    const o = this.owner(w);
    return o !== null && o.next > w;
  }

  // Windows that segments past their region are waiting for (dropped, or not run yet).
  waiting() {
    const out = [];
    for (const s of this.segments) {
      if (!s.finished && s.next < this.nWindows && !this.has(s.next) && this.start(s.next) >= s.until) out.push(s.next);
    }
    return out;
  }

  get complete() {
    for (let w = 0; w < this.nWindows; w++) if (!this.isDone(w)) return false;
    return this.segments.every((s) => s.finished);
  }

  // Add model outputs (frames x 88 note and onset posteriors) for window w; returns the notes that
  // became final, in file frames: [start, end, pitch, start final at, end final at].
  add(w, note, onset) {
    this.data[w] = { note, onset };
    const out = [];
    while (this.#pump(out) | this.#spawn());
    this.#release();
    return out;
  }

  #pump(out) {
    let progressed = false;
    for (const s of this.segments) {
      while (!s.finished && s.next < this.nWindows && this.has(s.next)) {
        const { note, onset } = this.data[s.next], k = note.length / N_PITCHES;
        for (let i = 0; i < k; i++) {
          s.hmm.push(note.subarray(i * N_PITCHES, (i + 1) * N_PITCHES), onset.subarray(i * N_PITCHES, (i + 1) * N_PITCHES));
        }
        s.next++;
        progressed = true;
        if (s.next === this.nWindows) {
          s.hmm.finish();
          s.finished = true;
        } else if (this.start(s.next) >= s.until && s.hmm.settled(s.until - s.offset)) {
          s.finished = true;
        }
        this.#emit(s, s.hmm.drain(), out);
      }
    }
    return progressed;
  }

  #emit(s, notes, out) {
    for (const [a, b, pitch, onWhen, offWhen] of notes) {
      const start = a + s.offset;
      if (start >= s.ownFrom && start < s.until) out.push([start, b + s.offset, pitch, onWhen + s.offset, offWhen + s.offset]);
    }
  }

  // Start a segment for any window that has data and its pre-roll but that no segment will reach.
  #spawn() {
    let spawned = false;
    for (let c = 0; c < this.nWindows; c++) {
      if (!this.has(c) || this.isDone(c) || (c > 0 && !this.has(c - 1))) continue;
      const ownFrom = this.start(c);
      if (this.segments.some((s) => s.ownFrom === ownFrom)) continue;
      const first = c === 0 ? 0 : c - 1, seg = new Segment(first, ownFrom, this.start(first), this.opts);
      const i = this.segments.findIndex((s) => s.ownFrom > ownFrom);
      const at = i < 0 ? this.segments.length : i;
      seg.until = i < 0 ? Infinity : this.segments[i].ownFrom;
      if (at > 0) this.segments[at - 1].until = ownFrom;
      this.segments.splice(at, 0, seg);
      spawned = true;
    }
    return spawned;
  }

  // Keep a window only while something may still read it: its owner hasn't decoded it, it is the
  // pre-roll for a window that isn't done, or it is one of the first two windows of a segment whose
  // predecessor hasn't finished (that one will run into them closing out its notes).
  #release() {
    const n = this.nWindows, keep = new Uint8Array(n);
    for (let w = 0; w < n; w++) if (!this.isDone(w) || (w + 1 < n && !this.isDone(w + 1))) keep[w] = 1;
    this.segments.forEach((s, i) => {
      const c = s.ownFrom / this.F;
      if (c > 0 && !(i > 0 && this.segments[i - 1].finished)) { keep[c] = 1; if (c + 1 < n) keep[c + 1] = 1; }
    });
    for (let w = 0; w < n; w++) if (!keep[w]) this.data[w] = null;
  }
}

// Which window to run through the model next, given the windows on screen [first, last]: what's
// visible, then anything a segment is waiting for, then everything else from the view onwards.
export function nextWindow(dec, first, last) {
  const n = dec.nWindows;
  if (n === 0) return -1;
  first = Math.min(Math.max(0, first), n - 1);
  last = Math.min(Math.max(first, last), n - 1);
  const want = (w) => {
    if (dec.isDone(w)) return -1;
    if (dec.has(w)) return w > 0 && !dec.has(w - 1) ? w - 1 : -1;
    const o = dec.owner(w);
    if ((o && o.next === w) || w === 0 || dec.has(w - 1)) return w;
    return w - 1;
  };
  for (let w = first; w <= last; w++) { const r = want(w); if (r >= 0) return r; }
  for (const w of dec.waiting()) return w;
  for (let i = 0; i < n; i++) { const r = want((first + i) % n); if (r >= 0) return r; }
  return -1;
}
