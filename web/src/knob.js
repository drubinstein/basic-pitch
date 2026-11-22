// A rotary knob (and a toggle switch) for the pedalboard. Drag up or down (shift for fine),
// scroll, or use the arrow keys; double-click puts it back to its default. Knobs are sliders to
// assistive tech.

export function snap(v, { min, max, step }) {
  const digits = Math.max(0, -Math.floor(Math.log10(step)) + (step % 1 && (step * 10) % 1 ? 1 : 0));
  return +(min + Math.round((Math.min(max, Math.max(min, v)) - min) / step) * step).toFixed(digits);
}

// Dragging 200 px sweeps the whole range (2000 px with shift).
export const dragTo = (value, dy, k, fine = false) => snap(value - (dy / 200) * (k.max - k.min) * (fine ? 0.1 : 1), k);

export const angle = (v, { min, max }) => -135 + (270 * (v - min)) / (max - min);

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
};
const polar = (deg, r) => [22 + r * Math.sin((deg * Math.PI) / 180), 22 - r * Math.cos((deg * Math.PI) / 180)];
const arc = (a0, a1, r) => {
  const [x0, y0] = polar(a0, r), [x1, y1] = polar(a1, r);
  return `M${x0.toFixed(2)},${y0.toFixed(2)}A${r},${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
};

// def: { key, label, min, max, step, default, format, hint }. onChange(value) on every change.
export function createKnob(def, value, onChange, { small = false } = {}) {
  const root = document.createElement('div');
  root.className = `knob${small ? ' small' : ''}`;
  root.title = def.hint ?? '';
  const dial = document.createElement('div');
  Object.assign(dial, { tabIndex: 0 });
  dial.className = 'dial';
  dial.setAttribute('role', 'slider');
  dial.setAttribute('aria-label', def.label);
  dial.setAttribute('aria-valuemin', def.min);
  dial.setAttribute('aria-valuemax', def.max);
  const svg = svgEl('svg', { viewBox: '0 0 44 44', 'aria-hidden': 'true' }, dial);
  svgEl('path', { d: arc(-135, 135, 19), class: 'track' }, svg);
  const fill = svgEl('path', { class: 'fill' }, svg);
  svgEl('circle', { cx: 22, cy: 22, r: 14, class: 'cap' }, svg);
  const pointer = svgEl('line', { x1: 22, y1: 22, x2: 22, y2: 11, class: 'pointer' }, svg);
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = def.label;
  const out = document.createElement('div');
  out.className = 'value';
  root.append(dial, label, out);

  const set = (v, notify = true) => {
    v = snap(v, def);
    const changed = v !== value;
    value = v;
    const a = angle(v, def);
    fill.setAttribute('d', a > -135 ? arc(-135, a, 19) : '');
    pointer.setAttribute('transform', `rotate(${a} 22 22)`);
    out.textContent = def.format(v);
    dial.setAttribute('aria-valuenow', v);
    dial.setAttribute('aria-valuetext', def.format(v));
    root.classList.toggle('moved', v !== def.default);
    if (changed && notify) onChange(v);
  };
  set(value, false);

  let drag = null;
  dial.addEventListener('pointerdown', (e) => { dial.setPointerCapture(e.pointerId); drag = { y: e.clientY, v: value }; dial.focus(); });
  dial.addEventListener('pointermove', (e) => { if (drag) set(dragTo(drag.v, e.clientY - drag.y, def, e.shiftKey)); });
  const end = () => { drag = null; };
  dial.addEventListener('pointerup', end);
  dial.addEventListener('pointercancel', end);
  dial.addEventListener('dblclick', () => set(def.default));
  dial.addEventListener('wheel', (e) => { e.preventDefault(); set(value + (e.deltaY < 0 ? 1 : -1) * def.step * (e.shiftKey ? 1 : Math.max(1, Math.round((def.max - def.min) / def.step / 50)))); }, { passive: false });
  dial.addEventListener('keydown', (e) => {
    const big = Math.max(1, Math.round((def.max - def.min) / def.step / 10));
    const moves = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: big, PageDown: -big };
    if (e.key in moves) set(value + moves[e.key] * def.step);
    else if (e.key === 'Home') set(def.min);
    else if (e.key === 'End') set(def.max);
    else return;
    e.preventDefault();
  });
  return { root, set: (v) => set(v, false), get value() { return value; } };
}

// A two-way toggle switch. onChange(boolean).
export function createSwitch(def, on, onChange) {
  const root = document.createElement('label');
  root.className = 'switch';
  root.title = def.hint ?? '';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.role = 'switch';
  input.checked = on;
  input.addEventListener('change', () => { root.classList.toggle('moved', input.checked !== def.default); onChange(input.checked); });
  const toggle = document.createElement('span');
  toggle.className = 'toggle';
  root.append(input, toggle, def.label);
  root.classList.toggle('moved', on !== def.default);
  return { root, set: (v) => { input.checked = v; root.classList.toggle('moved', v !== def.default); } };
}
