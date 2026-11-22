// Piano roll on a canvas that pans and zooms like a map: drag or scroll sideways to pan, pinch,
// ctrl+scroll or scroll up/down to zoom around the pointer, double-click to zoom in, 0 to fit.
// Like map tiles, each model window's note activations are kept as bytes and drawn into a small
// canvas only when visible (an LRU keeps the recent ones); zoomed far out, groups of windows are
// drawn from coarser tiles instead. Windows arrive in any order; `onView` reports what's visible
// so those can be transcribed first.
import { FRAMES_PER_WINDOW, N_PITCHES, MIDI_OFFSET } from './pipeline.js';

const LO = MIDI_OFFSET, HI = MIDI_OFFSET + N_PITCHES - 1;
const MAX_PPS = 4000; // pixels per second at full zoom
const GUTTER = 36; // left gutter for octave labels
const AXIS = 22; // bottom axis height
const STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const LRU = 384; // window canvases kept
const GROUP = 8; // windows per coarse tile

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class PianoRoll {
  constructor(canvas, frameToTime, onView = () => {}) {
    Object.assign(this, { canvas, frameToTime, onView, ctx: canvas.getContext('2d') });
    this.reset(0, 0);
    new ResizeObserver(() => this.#resize()).observe(canvas);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.#readColors());
    this.#readColors();
    this.#bind();
  }

  reset(duration, totalFrames) {
    this.duration = duration;
    this.totalFrames = totalFrames;
    this.nWindows = Math.ceil(totalFrames / FRAMES_PER_WINDOW);
    this.tiles = new Array(this.nWindows).fill(null); // byte activations per window
    this.canvases = new Map(); // window -> canvas, in LRU order
    this.coarse = new Map(); // group -> canvas
    this.notes = [];
    this.t0 = 0;
    this.pps = null; // fit on next draw
    this.lastView = '';
    this.request();
  }

  // activation: frames x 88 bytes (0-255) for window w.
  addTile(w, activation) {
    this.tiles[w] = activation;
    this.coarse.delete(Math.floor(w / GROUP));
    this.request();
  }

  // Byte activations for the whole file (missing windows are zeros).
  activation() {
    const out = new Uint8Array(this.totalFrames * N_PITCHES);
    this.tiles.forEach((a, w) => a && out.set(a, w * FRAMES_PER_WINDOW * N_PITCHES));
    return out;
  }

  #frames(w) { return Math.min(FRAMES_PER_WINDOW, this.totalFrames - w * FRAMES_PER_WINDOW); }
  #span(w0, w1) { return [this.frameToTime(w0 * FRAMES_PER_WINDOW), this.frameToTime(Math.min(this.totalFrames, w1 * FRAMES_PER_WINDOW))]; }

  // Paint byte activations (cols x 88, each column the max over `step` frames) into a canvas.
  #paint(cols, value) {
    const tile = document.createElement('canvas');
    tile.width = Math.max(1, cols);
    tile.height = N_PITCHES;
    const g = tile.getContext('2d'), img = g.createImageData(tile.width, N_PITCHES), [r, gg, b] = this.colors.heat;
    for (let f = 0; f < cols; f++) {
      for (let p = 0; p < N_PITCHES; p++) {
        const v = value(f, p) / 255, o = ((N_PITCHES - 1 - p) * tile.width + f) * 4;
        img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b;
        img.data[o + 3] = Math.round(255 * 0.7 * Math.min(1, Math.max(0, (v - 0.08) / 0.92)) ** 1.2);
      }
    }
    g.putImageData(img, 0, 0);
    return tile;
  }

  #windowCanvas(w) {
    let c = this.canvases.get(w);
    if (c) { this.canvases.delete(w); this.canvases.set(w, c); return c; }
    const a = this.tiles[w];
    c = this.#paint(this.#frames(w), (f, p) => a[f * N_PITCHES + p]);
    this.canvases.set(w, c);
    if (this.canvases.size > LRU) this.canvases.delete(this.canvases.keys().next().value);
    return c;
  }

  #groupCanvas(gi) {
    let c = this.coarse.get(gi);
    if (c) return c;
    const w0 = gi * GROUP, w1 = Math.min(this.nWindows, w0 + GROUP), f0 = w0 * FRAMES_PER_WINDOW;
    const frames = Math.min(this.totalFrames, w1 * FRAMES_PER_WINDOW) - f0, cols = Math.ceil(frames / GROUP);
    c = this.#paint(cols, (col, p) => {
      let v = 0;
      for (let f = col * GROUP; f < Math.min(frames, (col + 1) * GROUP); f++) {
        const a = this.tiles[w0 + Math.floor(f / FRAMES_PER_WINDOW)];
        if (a) v = Math.max(v, a[(f % FRAMES_PER_WINDOW) * N_PITCHES + p]);
      }
      return v;
    });
    this.coarse.set(gi, c);
    return c;
  }

  addNotes(notes) {
    for (const [s, e, pitch] of notes) this.notes.push({ t0: this.frameToTime(s), t1: this.frameToTime(e), pitch });
    this.request();
  }

  fit() {
    const w = this.#plotWidth();
    this.pps = Math.min(MAX_PPS, w / Math.max(this.duration, 1));
    this.t0 = 0;
    this.request();
  }

  request() {
    if (!this.pending) {
      this.pending = true;
      requestAnimationFrame(() => { this.pending = false; this.#draw(); });
    }
  }

  #readColors() {
    const hex = (v) => { const n = parseInt(v.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
    this.colors = { bg: css('--roll-bg'), black: css('--roll-black-key'), grid: css('--roll-grid'), text: css('--text-muted'), note: css('--accent'), noteEdge: css('--accent-strong'), pending: css('--roll-pending'), heat: hex(css('--heat')) };
    this.canvases.clear(); // tiles are painted in the heat colour
    this.coarse.clear();
    this.request();
  }

  #plotWidth() { return this.canvas.clientWidth - GUTTER; }
  #minPps() { return Math.min(MAX_PPS, this.#plotWidth() / Math.max(this.duration, 1)); }

  #clamp() {
    this.pps = Math.min(MAX_PPS, Math.max(this.#minPps(), this.pps));
    const span = this.#plotWidth() / this.pps;
    this.t0 = Math.min(Math.max(0, this.duration - span), Math.max(0, this.t0));
  }

  #zoomAt(x, factor) {
    const t = this.t0 + (x - GUTTER) / this.pps;
    this.pps *= factor;
    this.#clamp();
    this.t0 = t - (x - GUTTER) / this.pps;
    this.#clamp();
    this.request();
  }

  #pan(dx) {
    this.t0 -= dx / this.pps;
    this.#clamp();
    this.request();
  }

  #bind() {
    const c = this.canvas, pointers = new Map();
    let pinch = null;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const x = e.offsetX;
      if (e.ctrlKey || e.metaKey) this.#zoomAt(x, Math.exp(-e.deltaY * 0.01));
      else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) this.#pan(-e.deltaX);
      else if (e.shiftKey) this.#pan(-e.deltaY);
      else this.#zoomAt(x, Math.exp(-e.deltaY * 0.002));
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, e.offsetX);
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.abs(a - b) || 1 }; }
    });
    c.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId);
      pointers.set(e.pointerId, e.offsetX);
      if (pointers.size === 1) this.#pan(e.offsetX - prev);
      else if (pinch) {
        const [a, b] = [...pointers.values()], d = Math.abs(a - b) || 1;
        this.#zoomAt((a + b) / 2, d / pinch.d);
        pinch.d = d;
      }
    });
    const up = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('dblclick', (e) => this.#zoomAt(e.offsetX, e.shiftKey ? 0.5 : 2));
    c.addEventListener('keydown', (e) => {
      const mid = GUTTER + this.#plotWidth() / 2, step = this.#plotWidth() * 0.2;
      const keys = { '+': () => this.#zoomAt(mid, 1.5), '=': () => this.#zoomAt(mid, 1.5), '-': () => this.#zoomAt(mid, 1 / 1.5), '0': () => this.fit(), ArrowLeft: () => this.#pan(step), ArrowRight: () => this.#pan(-step) };
      if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
    });
  }

  #resize() {
    const dpr = devicePixelRatio || 1, c = this.canvas;
    c.width = Math.round(c.clientWidth * dpr);
    c.height = Math.round(c.clientHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.pps !== null) this.#clamp();
    this.request();
  }

  #draw() {
    const { ctx, colors: k } = this, W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    if (!W || !H) return;
    if (this.pps === null) this.fit();
    const plotH = H - AXIS, row = plotH / N_PITCHES, x = (t) => GUTTER + (t - this.t0) * this.pps;
    const y = (pitch) => (HI - pitch) * row, t1 = this.t0 + this.#plotWidth() / this.pps;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = k.bg;
    ctx.fillRect(0, 0, W, H);

    // Black-key rows and octave lines at each C.
    for (let p = LO; p <= HI; p++) {
      if ([1, 3, 6, 8, 10].includes(p % 12)) { ctx.fillStyle = k.black; ctx.fillRect(GUTTER, y(p), W - GUTTER, row); }
    }
    ctx.fillStyle = k.text;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (let p = 24; p <= HI; p += 12) {
      ctx.fillStyle = k.grid;
      ctx.fillRect(GUTTER, y(p) + row - 0.5, W - GUTTER, 1);
      ctx.fillStyle = k.text;
      ctx.fillText(`C${p / 12 - 1}`, 6, Math.max(8, y(p) + row / 2));
    }

    // Time grid.
    const step = STEPS.find((s) => s * this.pps >= 90) ?? STEPS[STEPS.length - 1];
    ctx.textBaseline = 'alphabetic';
    for (let t = Math.ceil(this.t0 / step) * step; t <= t1; t += step) {
      const px = Math.round(x(t)) + 0.5;
      ctx.fillStyle = k.grid;
      ctx.fillRect(px, 0, 1, plotH);
      ctx.fillStyle = k.text;
      const label = step >= 60 ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}` : `${+t.toFixed(2)}s`;
      ctx.fillText(label, px + 3, H - 7);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, 0, W - GUTTER, plotH);
    ctx.clip();

    // Activation tiles (coarse ones when a frame would be under half a pixel), notes, then shading
    // over windows that aren't transcribed yet.
    ctx.imageSmoothingEnabled = false;
    const visible = [];
    for (let w = 0; w < this.nWindows; w++) {
      const [a, b] = this.#span(w, w + 1);
      if (b >= this.t0 && a <= t1) visible.push(w);
    }
    if (visible.length) {
      const fine = (this.pps * this.duration) / Math.max(1, this.totalFrames) >= 0.5;
      if (fine) {
        for (const w of visible) {
          if (!this.tiles[w]) continue;
          const [a, b] = this.#span(w, w + 1);
          ctx.drawImage(this.#windowCanvas(w), x(a), 0, (b - a) * this.pps, plotH);
        }
      } else {
        const g0 = Math.floor(visible[0] / GROUP), g1 = Math.floor(visible[visible.length - 1] / GROUP);
        for (let gi = g0; gi <= g1; gi++) {
          const [a, b] = this.#span(gi * GROUP, Math.min(this.nWindows, (gi + 1) * GROUP));
          ctx.drawImage(this.#groupCanvas(gi), x(a), 0, (b - a) * this.pps, plotH);
        }
      }
      const view = `${visible[0]},${visible[visible.length - 1]}`;
      if (view !== this.lastView) { this.lastView = view; this.onView(visible[0], visible[visible.length - 1]); }
    }
    ctx.fillStyle = k.note;
    ctx.strokeStyle = k.noteEdge;
    ctx.lineWidth = 1;
    for (const n of this.notes) {
      if (n.t1 < this.t0 || n.t0 > t1) continue;
      const nx = x(n.t0), nw = Math.max(2, (n.t1 - n.t0) * this.pps), ny = y(n.pitch) + 0.5, nh = Math.max(2, row - 1);
      ctx.fillRect(nx, ny, nw, nh);
      if (nh > 4 && nw > 4) ctx.strokeRect(nx + 0.5, ny + 0.5, nw - 1, nh - 1);
    }
    ctx.fillStyle = k.pending;
    for (const w of visible) {
      if (this.tiles[w]) continue;
      const [a, b] = this.#span(w, w + 1);
      ctx.fillRect(x(a), 0, (b - a) * this.pps + 1, plotH);
    }
    ctx.restore();
  }
}
