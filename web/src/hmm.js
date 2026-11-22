// Per-pitch HMM with online Viterbi decoding, one model frame at a time.
//
// Each of the 88 pitches has its own chain: OFF, attack states A1..Am, sustain S and gap states
// G1..Gg. Attack and sustain states score w * (logit(note) - logit(theta_f)); entering A1 scores
// max(alpha * (logit(onset) - logit(theta_o)) + b_on, b_mel). Leaving the attack early costs gamma
// and re-entering A1 from S or a gap costs b_re. A pitch's decision for a frame is final once every
// state within `beam` of the best one traces back through the same state there (survivor merge),
// or after `maxLag` frames at the latest.
//
// Notes are [start frame, end frame (exclusive), MIDI pitch, frame when the start was final, frame
// when the end was final]. This is a port of the Python spike decoder; test/hmm.test.mjs checks that
// both give the same notes.
import { N_PITCHES, MIDI_OFFSET } from './pipeline.js';

const NEG = -1e18;
const logit = (p) => {
  p = Math.min(Math.max(p, 1e-4), 1 - 1e-4);
  return Math.log(p) - Math.log1p(-p);
};

export const DEFAULT_PARAMS = { theta_f: 0.4, theta_o: 0.5, w: 1.0, alpha: 4.0, b_on: -4.0, b_mel: -10.0, gamma: 10.0, b_re: 0.0, m: 4, g: 5 };

export class StreamingHmm {
  constructor(prm = DEFAULT_PARAMS, { beam = 2, maxLag = 100, capacity = 1 << 16 } = {}) {
    const P = N_PITCHES, m = prm.m, g = prm.g;
    Object.assign(this, { prm, beam, maxLag, P, cap: capacity });
    this.S = m + 1;
    this.G0 = m + 2;
    this.GL = m + 1 + g;
    this.n = m + 2 + g;
    this.delta = new Float64Array(P * this.n).fill(NEG);
    for (let p = 0; p < P; p++) this.delta[p * this.n] = 0;
    this.next = new Float64Array(P * this.n);
    this.bps = new Int8Array(capacity * P * this.n); // back-pointers for every frame
    this.dec = new Int8Array(capacity * P).fill(-1); // final state per frame and pitch
    this.when = new Int32Array(capacity * P).fill(-1); // frame at which that state became final
    this.committed = new Int32Array(P).fill(-1);
    this.cur = new Int32Array(this.n);
    this.lf = logit(prm.theta_f);
    this.lo = logit(prm.theta_o);
    this.t = 0;
    // Note extraction state, per pitch: last frame scanned, open note start, gap start.
    this.scanned = new Int32Array(P).fill(-1);
    this.open = new Int32Array(P).fill(-1);
    this.gap = new Int32Array(P).fill(-1);
    this.notes = [];
    this.drained = 0;
  }

  push(noteRow, onsetRow) {
    const { P, n, S, G0, GL, prm } = this, m = prm.m, t = this.t;
    if (t >= this.cap) throw new Error(`StreamingHmm capacity ${this.cap} frames exceeded`);
    const d0 = this.delta, nx = this.next, bp = this.bps, base = t * P * n;
    for (let p = 0; p < P; p++) {
      const o = p * n, b = base + o;
      const x = prm.w * (logit(noteRow[p]) - this.lf);
      const e = Math.max(prm.alpha * (logit(onsetRow[p]) - this.lo) + prm.b_on, prm.b_mel);
      let jA = 1;
      for (let j = 2; j <= m; j++) if (d0[o + j] > d0[o + jA]) jA = j;
      let jG = G0;
      for (let j = G0 + 1; j <= GL; j++) if (d0[o + j] > d0[o + jG]) jG = j;
      let v = d0[o], k = 0; // OFF
      if (d0[o + jA] - prm.gamma > v) { v = d0[o + jA] - prm.gamma; k = jA; }
      if (d0[o + GL] > v) { v = d0[o + GL]; k = GL; }
      nx[o] = v; bp[b] = k;
      v = d0[o] + e; k = 0; // A1
      if (d0[o + S] + e + prm.b_re > v) { v = d0[o + S] + e + prm.b_re; k = S; }
      if (d0[o + jG] + e + prm.b_re > v) { v = d0[o + jG] + e + prm.b_re; k = jG; }
      nx[o + 1] = v + x; bp[b + 1] = k;
      for (let j = 2; j <= m; j++) { nx[o + j] = d0[o + j - 1] + x; bp[b + j] = j - 1; }
      v = d0[o + m]; k = m; // S
      if (d0[o + S] > v) { v = d0[o + S]; k = S; }
      if (d0[o + jG] > v) { v = d0[o + jG]; k = jG; }
      nx[o + S] = v + x; bp[b + S] = k;
      nx[o + G0] = d0[o + S]; bp[b + G0] = S;
      for (let j = G0 + 1; j <= GL; j++) { nx[o + j] = d0[o + j - 1]; bp[b + j] = j - 1; }
    }
    this.delta = nx;
    this.next = d0;
    this.#commit(t);
    this.t++;
    for (let p = 0; p < P; p++) this.#scan(p, this.committed[p]);
  }

  // Survivor-merge commit for each pitch.
  #commit(t) {
    const { P, n } = this, d = this.delta, cur = this.cur, bp = this.bps;
    for (let p = 0; p < P; p++) {
      if (this.committed[p] >= t) continue;
      const o = p * n;
      let mx = -Infinity;
      for (let s = 0; s < n; s++) if (d[o + s] > mx) mx = d[o + s];
      for (let s = 0; s < n; s++) cur[s] = s;
      let tau = t;
      for (;;) {
        let lo = n, hi = -1;
        for (let s = 0; s < n; s++) {
          if (d[o + s] >= mx - this.beam) {
            if (cur[s] < lo) lo = cur[s];
            if (cur[s] > hi) hi = cur[s];
          }
        }
        const hit = lo === hi;
        if (hit || tau <= t - this.maxLag) {
          let sStar = lo;
          if (!hit) {
            let a = 0;
            for (let s = 1; s < n; s++) if (d[o + s] > d[o + a]) a = s;
            sStar = cur[a];
          }
          let s = sStar;
          for (let tt = tau; tt > this.committed[p]; tt--) {
            this.dec[tt * P + p] = s;
            this.when[tt * P + p] = t;
            s = bp[(tt * P + p) * n + s];
          }
          this.committed[p] = tau;
          for (let s2 = 0; s2 < n; s2++) if (cur[s2] !== sStar) d[o + s2] = NEG;
          break;
        }
        if (!(this.committed[p] < tau - 1) || tau === 0) break;
        for (let s = 0; s < n; s++) cur[s] = bp[(tau * P + p) * n + cur[s]];
        tau--;
      }
    }
  }

  // Turn pitch p's final states up to frame `upTo` into notes.
  #scan(p, upTo) {
    const { P, m, S, G0, GL } = { P: this.P, m: this.prm.m, S: this.S, G0: this.G0, GL: this.GL };
    const T = this.t;
    const close = (t) => {
      const start = this.open[p], gap = this.gap[p];
      this.notes.push([start, gap >= 0 ? gap : t, p + MIDI_OFFSET, this.when[start * P + p], this.when[Math.min(t, T - 1) * P + p]]);
    };
    for (let t = this.scanned[p] + 1; t <= upTo; t++) {
      const s = this.dec[t * P + p];
      if (s === 1) {
        if (this.open[p] >= 0) close(t);
        this.open[p] = t;
        this.gap[p] = -1;
      } else if ((s >= 1 && s <= m) || s === S) {
        this.gap[p] = -1;
      } else if (s >= G0 && s <= GL) {
        if (this.gap[p] < 0) this.gap[p] = t;
      } else if (s === 0 && this.open[p] >= 0) {
        close(t);
        this.open[p] = -1;
        this.gap[p] = -1;
      }
    }
    this.scanned[p] = Math.max(this.scanned[p], upTo);
  }

  // Notes that became final since the last call.
  drain() {
    const out = this.notes.slice(this.drained);
    this.drained = this.notes.length;
    return out;
  }

  // End of input: trace back whatever is not final yet and close open notes. Returns every note.
  finish() {
    const { P, n } = this, T = this.t, d = this.delta;
    for (let p = 0; p < P; p++) {
      let s = 0;
      for (let j = 1; j < n; j++) if (d[p * n + j] > d[p * n + s]) s = j;
      for (let tt = T - 1; tt >= 0; tt--) {
        if (this.committed[p] < tt) {
          this.dec[tt * P + p] = s;
          this.when[tt * P + p] = T - 1;
        }
        s = this.bps[(tt * P + p) * n + s];
      }
      this.committed[p] = T - 1;
      this.#scan(p, T - 1);
      if (this.open[p] >= 0) {
        const start = this.open[p], gap = this.gap[p];
        this.notes.push([start, gap >= 0 ? gap : T, p + MIDI_OFFSET, this.when[start * P + p], this.when[(T - 1) * P + p]]);
        this.open[p] = -1;
      }
    }
    return this.notes.slice();
  }
}
