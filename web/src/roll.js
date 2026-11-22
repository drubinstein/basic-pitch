// Piano roll on a canvas that pans and zooms like a map: drag or scroll sideways to pan, pinch,
// ctrl+scroll or scroll up/down to zoom around the pointer, double-click to zoom in, 0 to fit.
// Like map tiles, each model window's note activations are kept as bytes and drawn into a small
// canvas only when visible (an LRU keeps the recent ones); zoomed far out, groups of windows are
// drawn from coarser tiles instead. Windows arrive in any order; `onView` reports what's visible
// so those can be transcribed first.
//
// During playback a playhead crosses the roll, the notes under it and their keys on the keyboard
// light up, and the view follows the playhead until the user pans away. Hovering a note or
// clicking it reports it through `onNote` (for a tooltip); clicking empty space asks to seek there.
import { FRAMES_PER_WINDOW, N_PITCHES, MIDI_OFFSET } from './pipeline.js';
import { noteAt, soundingAt } from './notes.js';
import { bendsFromTiles, BINS_PER_SEMITONE } from './bends.js';
import { followT0, ANCHOR } from './playback.js';

const LO = MIDI_OFFSET, HI = MIDI_OFFSET + N_PITCHES - 1;
const MAX_PPS = 4000; // pixels per second at full zoom
const GUTTER = 40; // left gutter: the keyboard
const BLACK_KEY = 24; // width of a black key in the keyboard
const AXIS = 22; // bottom axis height
const STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const LRU = 384; // window canvases kept
const GROUP = 8; // windows per coarse tile
const CLICK = 4; // pixels a pointer can move and still click rather than drag
const HIT = 4; // pixels of slack when hitting short notes

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const isBlack = (p) => [1, 3, 6, 8, 10].includes(p % 12);

export class PianoRoll {
  constructor(canvas, frameToTime, { onView = () => {}, onNote = () => {}, onSeek = () => {}, onSounding = () => {}, onFollow = () => {} } = {}) {
    Object.assign(this, { canvas, frameToTime, onView, onNote, onSeek, onSounding, onFollow, ctx: canvas.getContext('2d') });
    this.layers = { heat: true, notes: true, bends: true }; // the model's output before decoding, the notes, their pitch bends
    this.anchor = ANCHOR; // where the followed playhead settles, as a fraction of the view
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
    this.bendTiles = new Array(this.nWindows).fill(null); // each pitch's bend per frame, per window
    this.canvases = new Map(); // window -> canvas, in LRU order
    this.coarse = new Map(); // group -> canvas
    this.notes = [];
    this.t0 = 0;
    this.pps = null; // fit on next draw
    this.lastView = '';
    this.playhead = null; // seconds, once there's audio
    if (this.following) this.onFollow(false);
    this.following = false;
    this.hover = null;
    this.selected = null;
    this.sounding = [];
    this.shown = ''; // forces the next draw to report "no note" if a tooltip was up
    this.request();
  }

  // A recording grows: more audio and frames, keeping what's there and the zoom.
  grow(duration, totalFrames) {
    this.duration = duration;
    this.totalFrames = totalFrames;
    this.nWindows = Math.ceil(totalFrames / FRAMES_PER_WINDOW);
    while (this.tiles.length < this.nWindows) this.tiles.push(null);
    while (this.bendTiles.length < this.nWindows) this.bendTiles.push(null);
    this.request();
  }

  // activation: frames x 88 bytes (0-255) for window w; bends: frames x 88 pitch bends (1/3 semitones).
  addTile(w, activation, bends = null) {
    this.tiles[w] = activation;
    if (bends) this.bendTiles[w] = bends;
    this.coarse.delete(Math.floor(w / GROUP));
    this.request();
  }

  // Pitch bends for the whole file (missing windows are zeros), and for one note.
  bends() {
    const out = new Int8Array(this.totalFrames * N_PITCHES);
    this.bendTiles.forEach((b, w) => b && out.set(b, w * FRAMES_PER_WINDOW * N_PITCHES));
    return out;
  }

  noteBends(n) {
    return bendsFromTiles(this.bendTiles, FRAMES_PER_WINDOW, n.s, n.e, n.pitch);
  }

  // Byte activations for the whole file (missing windows are zeros).
  activation() {
    const out = new Uint8Array(this.totalFrames * N_PITCHES);
    this.tiles.forEach((a, w) => a && out.set(a, w * FRAMES_PER_WINDOW * N_PITCHES));
    return out;
  }

  // notes: [start, end, pitch, frame when the start was final, frame when the end was final]; the
  // "final" frames are -1 for notes that are only final once the whole file is in.
  addNotes(notes) {
    const time = this.frameToTime;
    for (const [s, e, pitch, onWhen] of notes) this.notes.push({ s, e, t0: time(s), t1: time(e), pitch, lag: onWhen >= 0 ? time(onWhen + 1) - time(s) : null });
    this.request();
  }

  // Replace all the notes (after re-decoding with other settings).
  setNotes(notes) {
    this.notes = [];
    this.hover = null;
    this.selected = null;
    this.addNotes(notes);
  }

  // Move the playhead to t seconds. While playing, pass how far it moved since the last frame
  // (`advance`) and the wall time since then (`dt`) so the view can follow.
  setPlayhead(t, motion = null) {
    this.playhead = t;
    if (motion && this.following && this.pps !== null && this.#plotWidth() > 0) {
      this.t0 = followT0({ t0: this.t0, span: this.#plotWidth() / this.pps, t, duration: this.duration, anchor: this.anchor, ...motion });
    }
    this.request();
  }

  // Bring the playhead on screen if it isn't.
  reveal() {
    if (this.playhead === null || this.pps === null || this.#plotWidth() <= 0) return;
    this.t0 = followT0({ t0: this.t0, span: this.#plotWidth() / this.pps, t: this.playhead, duration: this.duration, anchor: this.anchor, advance: 0, dt: 0 });
    this.request();
  }

  // Follow the playhead (while playing), or stop.
  follow(on) {
    this.following = on;
    if (on) this.reveal();
    this.onFollow(on);
  }

  select(note) {
    this.selected = note;
    this.request();
  }

  // Show or hide the model's raw output (the heat map) and the notes, like map layers.
  setLayers(layers) {
    Object.assign(this.layers, layers);
    if (!this.layers.notes) { this.hover = null; this.selected = null; }
    this.request();
  }

  // Zoom around the middle of the view (or the playhead while following it).
  zoomBy(factor) {
    if (this.pps !== null) this.#zoomAt(GUTTER + this.#plotWidth() / 2, factor);
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

  #readColors() {
    const hex = (v) => { const n = parseInt(v.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
    this.colors = {
      bg: css('--roll-bg'), black: css('--roll-black-key'), grid: css('--roll-grid'), text: css('--text-muted'), strong: css('--text'),
      note: css('--accent'), noteEdge: css('--accent-strong'), pending: css('--roll-pending'), heat: hex(css('--heat')),
      keyWhite: css('--key-white'), keyBlack: css('--key-black'), active: css('--note-active'), playhead: css('--playhead'),
    };
    this.canvases.clear(); // tiles are painted in the heat colour
    this.coarse.clear();
    this.request();
  }

  #plotWidth() { return this.canvas.clientWidth - GUTTER; }
  #plotHeight() { return this.canvas.clientHeight - AXIS; }
  #minPps() { return Math.min(MAX_PPS, this.#plotWidth() / Math.max(this.duration, 1)); }
  #timeAt(x) { return this.t0 + (x - GUTTER) / this.pps; }
  #xAt(t) { return GUTTER + (t - this.t0) * this.pps; }

  #clamp() {
    this.pps = Math.min(MAX_PPS, Math.max(this.#minPps(), this.pps));
    const span = this.#plotWidth() / this.pps;
    this.t0 = Math.min(Math.max(0, this.duration - span), Math.max(0, this.t0));
  }

  #zoomAt(x, factor) {
    // While following, zoom around the playhead so it stays put.
    if (this.following && this.playhead !== null) {
      const px = this.#xAt(this.playhead);
      if (px >= GUTTER && px <= this.canvas.clientWidth) x = px;
    }
    const t = this.#timeAt(x);
    this.pps *= factor;
    this.#clamp();
    this.t0 = t - (x - GUTTER) / this.pps;
    this.#clamp();
    this.request();
  }

  // A pan by the user stops the view following the playhead.
  #pan(dx) {
    if (this.following) { this.following = false; this.onFollow(false); }
    this.t0 -= dx / this.pps;
    this.#clamp();
    this.request();
  }

  // The note under a point on the canvas, if any.
  #noteAt(x, y) {
    if (this.pps === null || !this.layers.notes || x < GUTTER || y < 0 || y >= this.#plotHeight()) return null;
    const pitch = HI - Math.floor(y / (this.#plotHeight() / N_PITCHES));
    return noteAt(this.notes, this.#timeAt(x), pitch, HIT / this.pps);
  }

  #setHover(note, x = null) {
    if (note === this.hover && x === this.hoverX) return;
    this.hover = note;
    this.hoverX = x;
    this.canvas.style.cursor = note ? 'pointer' : '';
    this.request();
  }

  #click(x, y) {
    const note = this.#noteAt(x, y);
    if (note) return this.select(note === this.selected ? null : note);
    this.select(null);
    if (x >= GUTTER && this.duration > 0) this.onSeek(Math.min(this.duration, Math.max(0, this.#timeAt(x))));
  }

  #bind() {
    const c = this.canvas, pointers = new Map();
    let pinch = null, press = null;
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
      press = pointers.size === 1 ? { x: e.offsetX, y: e.offsetY, dragging: false } : null;
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.abs(a - b) || 1 }; }
    });
    c.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return this.#setHover(this.#noteAt(e.offsetX, e.offsetY), e.offsetX);
      const prev = pointers.get(e.pointerId);
      if (pointers.size === 1) {
        // Small movements still count as a click; past that, drag the view.
        if (press && !press.dragging && Math.hypot(e.offsetX - press.x, e.offsetY - press.y) < CLICK) return;
        if (press) press.dragging = true;
        pointers.set(e.pointerId, e.offsetX);
        this.#setHover(null);
        this.#pan(e.offsetX - prev);
      } else if (pinch) {
        pointers.set(e.pointerId, e.offsetX);
        const [a, b] = [...pointers.values()], d = Math.abs(a - b) || 1;
        this.#zoomAt((a + b) / 2, d / pinch.d);
        pinch.d = d;
      }
    });
    const up = (e) => {
      if (e.type === 'pointerup' && press && !press.dragging && pointers.size === 1) this.#click(e.offsetX, e.offsetY);
      pointers.delete(e.pointerId);
      press = null;
      if (pointers.size < 2) pinch = null;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', () => pointers.size === 0 && this.#setHover(null));
    c.addEventListener('dblclick', (e) => this.#zoomAt(e.offsetX, e.shiftKey ? 0.5 : 2));
    c.addEventListener('keydown', (e) => {
      const mid = GUTTER + this.#plotWidth() / 2, step = this.#plotWidth() * 0.2;
      const keys = {
        '+': () => this.#zoomAt(mid, 1.5), '=': () => this.#zoomAt(mid, 1.5), '-': () => this.#zoomAt(mid, 1 / 1.5), '0': () => this.fit(),
        ArrowLeft: () => this.#pan(step), ArrowRight: () => this.#pan(-step), Escape: () => this.select(null),
      };
      if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
    });
  }

  #resize() {
    const dpr = devicePixelRatio || 1, c = this.canvas;
    c.width = Math.round(c.clientWidth * dpr);
    c.height = Math.round(c.clientHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.pps !== null && c.clientWidth > GUTTER) this.#clamp(); // not while hidden in another tab
    this.request();
  }

  #draw() {
    const { ctx, colors: k } = this, W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    if (!W || !H) return;
    if (this.pps === null) this.fit();
    this.#clamp();
    const plotH = H - AXIS, row = plotH / N_PITCHES, x = (t) => this.#xAt(t);
    const y = (pitch) => (HI - pitch) * row, t1 = this.t0 + this.#plotWidth() / this.pps;
    const ph = this.playhead;
    const sounding = ph === null ? [] : soundingAt(this.notes, ph);
    if (sounding.length !== this.sounding.length || sounding.some((n, i) => n !== this.sounding[i])) {
      this.sounding = sounding;
      this.onSounding(sounding);
    }
    const lit = new Set(sounding), litKeys = new Set(sounding.map((n) => n.pitch));

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = k.bg;
    ctx.fillRect(0, 0, W, H);

    // Black-key rows and octave lines at each C.
    for (let p = LO; p <= HI; p++) {
      if (isBlack(p)) { ctx.fillStyle = k.black; ctx.fillRect(GUTTER, y(p), W - GUTTER, row); }
    }
    for (let p = 24; p <= HI; p += 12) { ctx.fillStyle = k.grid; ctx.fillRect(GUTTER, y(p) + row - 0.5, W - GUTTER, 1); }

    // Keyboard: white keys, shorter black keys, the keys of sounding notes lit, and C labels.
    ctx.fillStyle = k.keyWhite;
    ctx.fillRect(0, 0, GUTTER, plotH);
    for (let p = LO; p <= HI; p++) {
      const on = litKeys.has(p);
      if (isBlack(p)) { ctx.fillStyle = on ? k.active : k.keyBlack; ctx.fillRect(0, y(p), BLACK_KEY, row); }
      else if (on) { ctx.fillStyle = k.active; ctx.fillRect(0, y(p), GUTTER, row); }
      if (p % 12 === 0 || p % 12 === 5) { ctx.fillStyle = k.grid; ctx.fillRect(0, y(p) + row - 0.5, GUTTER, 1); }
    }
    ctx.fillStyle = k.grid;
    ctx.fillRect(GUTTER - 1, 0, 1, plotH);
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (let p = 24; p <= HI; p += 12) {
      ctx.fillStyle = litKeys.has(p) ? k.bg : k.text;
      ctx.fillText(`C${p / 12 - 1}`, GUTTER - 4, Math.max(6, y(p) + row / 2));
    }
    ctx.textAlign = 'left';

    // Time grid.
    ctx.font = '11px system-ui, sans-serif';
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
    if (visible.length && this.layers.heat) {
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
    }
    if (visible.length) {
      const view = `${visible[0]},${visible[visible.length - 1]}`;
      if (view !== this.lastView) { this.lastView = view; this.onView(visible[0], visible[visible.length - 1]); }
    }
    const rect = (n) => {
      const nx = x(n.t0), nw = Math.max(2, (n.t1 - n.t0) * this.pps), ny = y(n.pitch) + 0.5, nh = Math.max(2, row - 1);
      return [nx, ny, nw, nh];
    };
    ctx.lineWidth = 1;
    const shownNotes = this.layers.notes ? this.notes : [];
    for (const n of shownNotes) {
      if (n.t1 < this.t0 || n.t0 > t1 || lit.has(n)) continue;
      const [nx, ny, nw, nh] = rect(n);
      ctx.fillStyle = k.note;
      ctx.fillRect(nx, ny, nw, nh);
      if (nh > 4 && nw > 4) { ctx.strokeStyle = k.noteEdge; ctx.strokeRect(nx + 0.5, ny + 0.5, nw - 1, nh - 1); }
    }
    // Sounding notes on top, lit and a touch taller.
    ctx.fillStyle = k.active;
    ctx.shadowColor = k.active;
    ctx.shadowBlur = 8;
    for (const n of this.layers.notes ? sounding : []) {
      const [nx, ny, nw, nh] = rect(n);
      ctx.fillRect(nx, ny - 1, nw, nh + 2);
    }
    ctx.shadowBlur = 0;
    // Pitch bends: each note's bend per frame as a line through it (1/3 semitone per bin), with a halo
    // in the background colour so it reads over the note and the grid alike.
    if (this.layers.notes && this.layers.bends && row >= 3) {
      ctx.lineJoin = 'round';
      for (const n of this.notes) {
        if (n.t1 < this.t0 || n.t0 > t1) continue;
        const [nx, ny, nw, nh] = rect(n);
        if (nw < 6) continue;
        const b = this.noteBends(n);
        if (!b.some((v) => v !== 0)) continue;
        const dx = nw / b.length, mid = ny + nh / 2;
        ctx.beginPath();
        b.forEach((v, i) => { const px = nx + (i + 0.5) * dx, py = mid - (v / BINS_PER_SEMITONE) * row; if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
        ctx.strokeStyle = k.bg;
        ctx.lineWidth = 3.5;
        ctx.stroke();
        ctx.strokeStyle = k.strong;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
    // The hovered and selected notes get an outline.
    ctx.strokeStyle = k.strong;
    ctx.lineWidth = 2;
    for (const n of new Set([this.selected, this.hover])) {
      if (!n) continue;
      const [nx, ny, nw, nh] = rect(n);
      ctx.strokeRect(nx - 1, ny - 2, nw + 2, nh + 4);
    }
    ctx.fillStyle = k.pending;
    for (const w of visible) {
      if (this.tiles[w]) continue;
      const [a, b] = this.#span(w, w + 1);
      ctx.fillRect(x(a), 0, (b - a) * this.pps + 1, plotH);
    }
    ctx.restore();

    // Playhead, with a handle on the time axis.
    if (ph !== null) {
      const px = Math.round(x(ph));
      if (px >= GUTTER - 1 && px <= W + 1) {
        ctx.fillStyle = k.playhead;
        ctx.fillRect(px - 1, 0, 2, plotH);
        ctx.beginPath();
        ctx.moveTo(px - 6, plotH);
        ctx.lineTo(px + 6, plotH);
        ctx.lineTo(px, plotH + 8);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Tell the page which note to describe: the hovered one, else the selected one, and where.
    const shown = this.hover ?? this.selected;
    let report = null;
    if (shown) {
      const [nx, ny, nw, nh] = rect(shown);
      if (nx + nw >= GUTTER && nx <= W) report = { note: shown, x: Math.max(GUTTER, nx), y: ny, w: nw, h: nh, pointerX: shown === this.hover ? this.hoverX : null };
    }
    const key = report && `${report.note.t0},${report.note.pitch},${report.x},${report.y},${report.pointerX}`;
    if (key !== this.shown) { this.shown = key; this.onNote(report); }
  }
}
