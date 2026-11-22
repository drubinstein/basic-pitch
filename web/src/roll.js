// Piano roll on a canvas that pans and zooms like a map: drag or scroll sideways to pan, pinch,
// ctrl+scroll or scroll up/down to zoom around the pointer, double-click to zoom in, 0 to fit.
// Each processed model window is kept as its own small image tile of note activations, so drawing
// scales to long files and new windows appear as they arrive.
import { N_PITCHES, MIDI_OFFSET } from './pipeline.js';

const LO = MIDI_OFFSET, HI = MIDI_OFFSET + N_PITCHES - 1;
const MAX_PPS = 4000; // pixels per second at full zoom
const GUTTER = 36; // left gutter for octave labels
const AXIS = 22; // bottom axis height
const STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class PianoRoll {
  constructor(canvas, frameToTime) {
    Object.assign(this, { canvas, frameToTime, ctx: canvas.getContext('2d') });
    this.reset(0);
    new ResizeObserver(() => this.#resize()).observe(canvas);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.#readColors());
    this.#readColors();
    this.#bind();
  }

  reset(duration) {
    this.duration = duration;
    this.processed = 0;
    this.notes = [];
    this.tiles = [];
    this.t0 = 0;
    this.pps = null; // fit on next draw
    this.request();
  }

  addTile(startFrame, frames, activation) {
    const tile = document.createElement('canvas');
    tile.width = frames;
    tile.height = N_PITCHES;
    const g = tile.getContext('2d'), img = g.createImageData(frames, N_PITCHES);
    const [r, gg, b] = this.colors.heat;
    for (let f = 0; f < frames; f++) {
      for (let p = 0; p < N_PITCHES; p++) {
        const v = activation[f * N_PITCHES + p], o = ((N_PITCHES - 1 - p) * frames + f) * 4;
        img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b;
        img.data[o + 3] = Math.round(255 * 0.7 * Math.min(1, Math.max(0, (v - 0.08) / 0.92)) ** 1.2);
      }
    }
    g.putImageData(img, 0, 0);
    this.tiles.push({ t0: this.frameToTime(startFrame), t1: this.frameToTime(startFrame + frames), canvas: tile });
    this.processed = Math.max(this.processed, this.frameToTime(startFrame + frames));
    this.request();
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

    // Activation tiles, then notes, then the not-yet-processed region.
    ctx.imageSmoothingEnabled = false;
    for (const tile of this.tiles) {
      if (tile.t1 < this.t0 || tile.t0 > t1) continue;
      ctx.drawImage(tile.canvas, x(tile.t0), 0, (tile.t1 - tile.t0) * this.pps, plotH);
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
    if (this.processed < this.duration) {
      ctx.fillStyle = k.pending;
      ctx.fillRect(x(this.processed), 0, W, plotH);
    }
    ctx.restore();
  }
}
