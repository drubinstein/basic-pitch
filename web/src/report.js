// The report tab's interactive charts, drawn as SVG from report-data.json (exported from the tuning
// runs): share of tracks each decoder beats, per-track gaps against the tuned original, and every
// HMM setting tried on vocadito. Each chart has toggles, hover/focus tooltips and a table view.
import data from './report-data.json';
import { niceTicks, bestByBand, trackGaps } from './chart-math.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
};
const html = (tag, attrs = {}, parent, text) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
};
const pct = (x) => `${Math.round(x * 100)}%`;
const f3 = (x) => x.toFixed(3).replace(/^0/, '');
const DS = Object.fromEntries(data.datasets.map((d) => [d.key, d]));
// Decoders in color order (series 1-4); color follows the decoder, never its rank.
const ORDER = ['hmm_current', 'hmm_latcap_perds', 'rnn_D4', 'offline_default'];
const NAME = Object.fromEntries(data.decoders.map((d) => [d.key, d.name]));
const SERIES = Object.fromEntries(ORDER.map((k, i) => [k, `var(--series-${i + 1})`]));

// A row of toggle buttons; calls onChange(value) and keeps one pressed.
function toggles(parent, label, options, value, onChange) {
  const group = html('div', { class: 'seg', role: 'group', 'aria-label': label }, parent);
  for (const [v, text] of options) {
    const b = html('button', { type: 'button', 'aria-pressed': String(v === value) }, group, text);
    b.addEventListener('click', () => {
      for (const o of group.children) o.setAttribute('aria-pressed', String(o === b));
      onChange(v);
    });
  }
}

function legend(parent, items, kind = 'rect') {
  const ul = html('ul', { class: 'legend' }, parent);
  for (const [color, text] of items) {
    const li = html('li', {}, ul);
    html('span', { class: `key ${kind}`, style: `background:${color}` }, li);
    li.append(text);
  }
}

// A chart frame: an SVG that redraws on resize, plus one tooltip.
function frame(parent, height, label, draw) {
  const box = html('div', { class: 'chart' }, parent);
  const tip = html('div', { class: 'chart-tip', role: 'status', hidden: '' }, box);
  let svg = null;
  const render = () => {
    const w = box.clientWidth;
    if (!w) return;
    svg?.remove();
    svg = el('svg', { width: w, height, viewBox: `0 0 ${w} ${height}`, role: 'img', 'aria-label': typeof label === 'function' ? label() : label });
    box.insertBefore(svg, tip);
    tip.hidden = true;
    draw(svg, w, height, show);
  };
  // lines: [[strong text], [text], ...]; the first line is the value.
  const show = (x, y, lines) => {
    if (!lines) { tip.hidden = true; return; }
    tip.replaceChildren();
    lines.forEach((line, i) => html('div', i === 0 ? { class: 'v' } : {}, tip, line));
    tip.hidden = false;
    const left = Math.min(Math.max(0, x + 12), box.clientWidth - tip.offsetWidth);
    const top = y - tip.offsetHeight - 10 < 0 ? y + 14 : y - tip.offsetHeight - 10;
    tip.style.transform = `translate(${left}px, ${top}px)`;
  };
  new ResizeObserver(render).observe(box);
  box.addEventListener('pointerleave', () => show());
  return { render, box };
}

// Horizontal gridlines and y labels; returns the y scale.
function yAxis(svg, ticks, x0, x1, top, bottom, format) {
  const lo = ticks[0], hi = ticks[ticks.length - 1], y = (v) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
  for (const t of ticks) {
    el('line', { x1: x0, x2: x1, y1: y(t), y2: y(t), class: t === 0 ? 'axis' : 'grid' }, svg);
    el('text', { x: x0 - 6, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' }, svg).textContent = format(t);
  }
  return y;
}

// A marked horizontal line with a label at the right end (a target or a baseline).
// The label gets a backing so it stays readable over dense marks.
function refLine(svg, y, x0, x1, text) {
  el('line', { x1: x0, x2: x1, y1: y, y2: y, class: 'ref' }, svg);
  const label = el('text', { x: x1, y: y - 5, 'text-anchor': 'end', class: 'ref-label' }, svg);
  label.textContent = text;
  const b = label.getBBox();
  svg.insertBefore(el('rect', { x: b.x - 4, y: b.y - 1, width: b.width + 8, height: b.height + 2, rx: 4, class: 'label-bg' }), label);
}

function table(parent, summary, head, rows) {
  const details = html('details', { class: 'table-view' }, parent);
  html('summary', {}, details, summary);
  const wrap = html('div', { class: 'scroll' }, details), t = html('table', {}, wrap);
  const tr = html('tr', {}, html('thead', {}, t));
  for (const h of head) html('th', { scope: 'col' }, tr, h);
  const tb = html('tbody', {}, t);
  for (const r of rows) { const row = html('tr', {}, tb); for (const c of r) html('td', {}, row, c); }
}

// 1. Share of test tracks each decoder beats the tuned original on, per dataset.
function beatsChart(root) {
  let metric = 'Fno';
  const controls = html('div', { class: 'chart-controls' }, root);
  toggles(controls, 'Score', [['Fno', 'Fno (onsets)'], ['F', 'F (with offsets)']], metric, (m) => { metric = m; chart.render(); });
  legend(root, ORDER.map((k) => [SERIES[k], NAME[k]]));
  const chart = frame(root, 300, () => `Bar chart: share of test tracks each decoder beats the tuned original on, by ${metric}, per dataset. The table below has the numbers.`, (svg, W, H, show) => {
    const L = 40, R = 8, T = 16, B = H - 42, y = yAxis(svg, [0, 0.25, 0.5, 0.75, 1], L, W - R, T, B, pct);
    const groups = data.datasets, gw = (W - L - R) / groups.length;
    const bw = Math.min(24, (gw * 0.7) / ORDER.length - 2);
    groups.forEach((ds, gi) => {
      const cx = L + gw * (gi + 0.5), x0 = cx - (ORDER.length * (bw + 2) - 2) / 2;
      el('text', { x: cx, y: B + 18, 'text-anchor': 'middle', class: 'tick' }, svg).textContent = ds.name;
      el('text', { x: cx, y: B + 33, 'text-anchor': 'middle', class: 'tick' }, svg).textContent = `${ds.n} tracks`;
      ORDER.forEach((k, i) => {
        const s = data.summary[ds.key][k], v = s[`beat${metric}`], x = x0 + i * (bw + 2), top = y(v);
        const h = Math.max(0, B - top), r = Math.min(4, h / 2, bw / 2);
        const bar = el('path', { d: `M${x},${B}V${top + r}q0,${-r} ${r},${-r}h${bw - 2 * r}q${r},0 ${r},${r}V${B}Z`, fill: SERIES[k], class: 'mark', tabindex: 0 }, svg);
        // The first bar of each group: its label can run left into the gap instead of over the next bar.
        if (k === 'hmm_current') el('text', { x: x + bw, y: top - 5, 'text-anchor': 'end', class: 'value' }, svg).textContent = pct(v);
        const lines = () => [pct(v), `${NAME[k]} · ${ds.name}`, `${metric} ${f3(s[metric])} vs ${f3(data.summary[ds.key].bar[metric])} for the tuned original`,
          s.delayMs === null ? 'needs the whole file' : `onset delay ${s.delayMs} ms (median)`];
        const hit = el('rect', { x: x - 1, y: T, width: bw + 2, height: B - T, class: 'hit' }, svg);
        for (const t of [hit, bar]) {
          t.addEventListener('pointermove', (e) => { bar.classList.add('on'); show(e.offsetX, e.offsetY, lines()); });
          t.addEventListener('pointerleave', () => { bar.classList.remove('on'); show(); });
        }
        bar.addEventListener('focus', () => show(x + bw, top, lines()));
        bar.addEventListener('blur', () => show());
      });
    });
    refLine(svg, y(0.95), L, W - R, 'target: 95% of tracks');
  });
}

// 2. Each test track: decoder score minus the tuned original's, sorted.
function tracksChart(root) {
  const DEC = [['hmm_current', 'live'], ['hmm_latcap_perds', 'tuned'], ['offline_default', 'default']];
  let ds = 'vocadito', dec = 'hmm_current', metric = 'Fno';
  const controls = html('div', { class: 'chart-controls' }, root);
  toggles(controls, 'Dataset', data.datasets.map((d) => [d.key, d.name]), ds, (v) => { ds = v; update(); });
  toggles(controls, 'Decoder', DEC.map(([k]) => [k, NAME[k]]), dec, (v) => { dec = v; update(); });
  toggles(controls, 'Score', [['Fno', 'Fno'], ['F', 'F']], metric, (v) => { metric = v; update(); });
  const caption = html('p', { class: 'chart-caption' }, root);
  legend(root, [['var(--div-pos)', 'better than the tuned original'], ['var(--div-neg)', 'worse']]);
  const cols = () => {
    const c = data.trackColumns, short = DEC.find(([k]) => k === dec)[1];
    return [c.indexOf(`bar ${metric}`), c.indexOf(`${short} ${metric}`)];
  };
  const chart = frame(root, 260, () => `Columns: each ${DS[ds].name} test track's ${metric} for ${NAME[dec]} minus the tuned original's, sorted. The table below lists every track.`, (svg, W, H, show) => {
    const [bc, dc] = cols(), { gaps } = trackGaps(data.tracks[ds], bc, dc);
    const m = Math.max(0.02, ...gaps.map((g) => Math.abs(g.gap)));
    const L = 44, R = 8, T = 12, B = H - 22, ticks = niceTicks(-m, m, 4);
    const y = yAxis(svg, ticks, L, W - R, T, B, (t) => (t > 0 ? '+' : '') + t.toFixed(2));
    const step = (W - L - R) / gaps.length, gap = step >= 4 ? 1 : 0, bw = Math.max(1, step - gap);
    el('text', { x: L, y: H - 4, class: 'tick' }, svg).textContent = 'tracks, most ahead first';
    let active = null;
    gaps.forEach((g, i) => {
      const x = L + i * step, y0 = y(0), y1 = y(g.gap);
      el('rect', { x, y: Math.min(y0, y1), width: bw, height: Math.max(1, Math.abs(y1 - y0)), fill: g.gap > 0 ? 'var(--div-pos)' : g.gap < 0 ? 'var(--div-neg)' : 'var(--chart-axis)', class: 'mark' }, svg);
    });
    const hit = el('rect', { x: L, y: T, width: W - L - R, height: B - T, class: 'hit' }, svg);
    const cursor = el('rect', { y: T, height: B - T, class: 'cursor', width: Math.max(2, bw), x: L, visibility: 'hidden' }, svg);
    hit.addEventListener('pointermove', (e) => {
      const i = Math.min(gaps.length - 1, Math.max(0, Math.floor((e.offsetX - L) / step)));
      if (i !== active) { active = i; cursor.setAttribute('x', L + i * step); cursor.setAttribute('visibility', 'visible'); }
      const g = gaps[i];
      show(e.offsetX, e.offsetY, [`${g.gap >= 0 ? '+' : ''}${g.gap.toFixed(3)}`, g.name, `${NAME[dec]} ${f3(g.value)} · tuned original ${f3(g.bar)}`]);
    });
    hit.addEventListener('pointerleave', () => { active = null; cursor.setAttribute('visibility', 'hidden'); show(); });
  });
  const tableBox = html('div', {}, root);
  function update() {
    const [bc, dc] = cols(), { gaps, ahead } = trackGaps(data.tracks[ds], bc, dc);
    caption.textContent = `${NAME[dec]} scores higher ${metric} than the tuned original on ${ahead} of ${gaps.length} ${DS[ds].name} tracks (${pct(ahead / gaps.length)}).`;
    chart.render();
    tableBox.replaceChildren();
    table(tableBox, `Table: every ${DS[ds].name} track`, ['Track', NAME[dec], 'Tuned original', 'Difference'],
      gaps.map((g) => [g.name, f3(g.value), f3(g.bar), `${g.gap >= 0 ? '+' : ''}${g.gap.toFixed(3)}`]));
  }
  update();
}

// 3. Every HMM setting tried on vocadito: score against onset delay.
function sweepChart(root) {
  const METRICS = [['Fno', 'Fno', 1], ['F', 'F', 2], ['beatFno', 'Tracks beaten (Fno)', 3], ['beatF', 'Tracks beaten (F)', 4]];
  const SWEEPS = [['dev', 'Tuned and scored on dev tracks', 'var(--series-1)'], ['ceiling', 'Tuned and scored on test tracks (ceiling)', 'var(--series-2)']];
  let metric = 'Fno';
  const controls = html('div', { class: 'chart-controls' }, root);
  toggles(controls, 'Score', METRICS.map(([k, n]) => [k, n]), metric, (v) => { metric = v; update(); });
  legend(root, SWEEPS.map(([, n, c]) => [c, n]), 'dot');
  const col = () => METRICS.find(([k]) => k === metric)[2], isShare = () => metric.startsWith('beat');
  const fmt = (v) => (isShare() ? pct(v) : f3(v));
  const chart = frame(root, 320, () => `Scatter: ${METRICS.find(([k]) => k === metric)[1]} against median onset delay for every HMM setting tried on vocadito. The table below has the best setting per delay band.`, (svg, W, H, show) => {
    const c = col(), pts = SWEEPS.flatMap(([k, , color]) => data.sweeps[k].trials.map((t) => ({ t, k, color })));
    // Scores: from just under the 15th percentile, so the settings that broke don't flatten the rest.
    const vals = pts.map((p) => p.t[c]).sort((a, b) => a - b);
    const lo = isShare() ? 0 : Math.max(0, vals[Math.floor(0.15 * vals.length)] - 0.01), hi = isShare() ? 1 : vals[vals.length - 1] + 0.005;
    const L = 48, R = 10, T = 14, B = H - 34, yt = niceTicks(lo, hi, 5);
    const shown = pts.filter((p) => p.t[c] >= yt[0]);
    const y = yAxis(svg, yt, L, W - R, T, B, fmt), xt = niceTicks(0, Math.max(...shown.map((p) => p.t[0])), 6);
    const x = (ms) => L + (ms / xt[xt.length - 1]) * (W - L - R);
    for (const t of xt) el('text', { x: x(t), y: B + 16, 'text-anchor': 'middle', class: 'tick' }, svg).textContent = `${t}`;
    el('text', { x: (L + W - R) / 2, y: H - 4, 'text-anchor': 'middle', class: 'tick' }, svg).textContent = 'median onset delay (ms)';
    const visible = shown;
    below.textContent = pts.length > shown.length ? `${pts.length - shown.length} settings that scored below ${fmt(yt[0])} are off the bottom of the chart.` : '';
    for (const p of visible) { p.x = x(p.t[0]); p.y = y(p.t[c]); el('circle', { cx: p.x, cy: p.y, r: 3.5, fill: p.color, class: 'dot' }, svg); }
    if (isShare()) refLine(svg, y(0.95), L, W - R, 'target: 95% of tracks');
    else for (const [k, n] of [['dev', 'dev'], ['ceiling', 'test']]) {
      const v = data.sweeps[k].baseline[metric];
      if (v >= yt[0]) refLine(svg, y(v), L, W - R, `tuned original on ${n}: ${f3(v)}`);
    }
    const ring = el('circle', { r: 6, class: 'ring', cx: L, cy: T, visibility: 'hidden' }, svg);
    const hit = el('rect', { x: L, y: T, width: W - L - R, height: B - T, class: 'hit' }, svg);
    hit.addEventListener('pointermove', (e) => {
      let best = null, bd = 24 * 24;
      for (const p of visible) { const d = (p.x - e.offsetX) ** 2 + (p.y - e.offsetY) ** 2; if (d < bd) { bd = d; best = p; } }
      if (!best) { ring.setAttribute('visibility', 'hidden'); return show(); }
      ring.setAttribute('cx', best.x); ring.setAttribute('cy', best.y); ring.setAttribute('visibility', 'visible');
      const [ms, fno, f, bfno, bf] = best.t;
      show(best.x, best.y, [fmt(best.t[c]), SWEEPS.find(([k]) => k === best.k)[1], `onset delay ${Math.round(ms)} ms · Fno ${f3(fno)} · F ${f3(f)}`, `beats the tuned original on ${pct(bfno)} (Fno) / ${pct(bf)} (F) of tracks`]);
    });
    hit.addEventListener('pointerleave', () => { ring.setAttribute('visibility', 'hidden'); show(); });
  });
  const below = html('p', { class: 'note' }, root);
  const tableBox = html('div', {}, root);
  function update() {
    chart.render();
    const edges = [0, 46, 93, 140, 230, 460, Infinity], c = col();
    const bands = Object.fromEntries(SWEEPS.map(([k]) => [k, bestByBand(data.sweeps[k].trials, edges, c)]));
    tableBox.replaceChildren();
    table(tableBox, 'Table: best setting per delay band', ['Median onset delay', ...SWEEPS.map(([, n]) => n)],
      bands.dev.map((b, i) => [b.to === Infinity ? `${b.from} ms and up` : `${b.from}–${b.to} ms`,
        ...SWEEPS.map(([k]) => { const x = bands[k][i]; return x.best === null ? '–' : `${fmt(x.best)} (${x.n} settings)`; })]));
  }
  update();
}

// The main results, grouped by dataset: one row per decoder, one labelled column per number.
function resultsTable(root) {
  const rows = [['offline_default', 'Original, default (melodia trick on)'], ['bar', 'Original, tuned per dataset (the bar)'],
    ['hmm_current', 'Live: streaming HMM, starting parameters'], ['hmm_latcap_perds', 'Streaming HMM, tuned per dataset'],
    ['rnn_D4', 'Learned decoder, 4 frames of look-ahead']];
  const wrap = html('div', { class: 'scroll' }, root), t = html('table', { class: 'results' }, wrap);
  const head = html('tr', {}, html('thead', {}, t));
  for (const h of ['Decoder', 'Fno\n(onsets)', 'F\n(with offsets)', 'Tracks beaten\non Fno', 'Tracks beaten\non F', 'Onset delay\n(median)']) {
    const th = html('th', { scope: 'col' }, head);
    h.split('\n').forEach((part, i) => { if (i) th.append(document.createElement('br')); th.append(part); });
  }
  const body = html('tbody', {}, t);
  for (const ds of data.datasets) {
    const g = html('td', { colspan: 6 }, html('tr', { class: 'group' }, body), ds.name);
    html('span', {}, g, `${ds.n} test tracks`);
    for (const [k, name] of rows) {
      const s = k === 'bar' ? data.summary[ds.key].bar : data.summary[ds.key][k];
      const tr = html('tr', { class: k === 'bar' ? 'bar' : k === 'hmm_current' ? 'shipped' : '' }, body);
      html('td', {}, tr, name);
      html('td', {}, tr, f3(s.Fno));
      html('td', {}, tr, f3(s.F));
      for (const m of ['beatFno', 'beatF']) html('td', k === 'bar' ? { class: 'dim' } : {}, tr, k === 'bar' ? '–' : pct(s[m]));
      html('td', s.delayMs == null ? { class: 'dim' } : {}, tr, s.delayMs == null ? 'whole file' : `${s.delayMs} ms`);
    }
  }
}

let done = false;
export function renderReport() {
  if (done) return;
  done = true;
  beatsChart(document.getElementById('chart-beats'));
  resultsTable(document.getElementById('results-table'));
  tracksChart(document.getElementById('chart-tracks'));
  sweepChart(document.getElementById('chart-sweep'));
}
