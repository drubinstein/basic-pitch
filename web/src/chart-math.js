// Small helpers behind the report's charts.

// Round tick values covering [lo, hi], about `count` intervals (1, 2 or 5 times a power of ten).
export function niceTicks(lo, hi, count) {
  const raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw)), err = raw / mag;
  const step = mag * (err >= Math.sqrt(50) ? 10 : err >= Math.sqrt(10) ? 5 : err >= Math.sqrt(2) ? 2 : 1);
  const digits = Math.max(0, -Math.floor(Math.log10(step)) + 1), ticks = [];
  for (let i = Math.floor(lo / step + 1e-9); i <= Math.ceil(hi / step - 1e-9); i++) ticks.push(+(i * step).toFixed(digits));
  return ticks;
}

// trials: rows with the delay (ms) in column 0. For each band [edges[i], edges[i + 1]), the best
// value in column `col` and how many trials fell in it.
export function bestByBand(trials, edges, col) {
  const out = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const inBand = trials.filter((t) => t[0] >= edges[i] && t[0] < edges[i + 1]);
    out.push({ from: edges[i], to: edges[i + 1], best: inBand.length ? Math.max(...inBand.map((t) => t[col])) : null, n: inBand.length });
  }
  return out;
}

// rows: [name, ...scores]. Each track's decoder score minus the bar's, best first, and how many
// tracks the decoder is strictly ahead on.
export function trackGaps(rows, barCol, decCol) {
  const gaps = rows.map((r) => ({ name: r[0], value: r[decCol], bar: r[barCol], gap: r[decCol] - r[barCol] })).sort((a, b) => b.gap - a.gap);
  return { gaps, ahead: gaps.filter((g) => g.gap > 0).length };
}
