/**
 * The parts of js/figure-plot.js that need no browser: the figure buildFigure
 * lays out for every series kind (text measured from font averages under
 * Node), the limits matplotlib's autoscaling gives (sticky edges included),
 * contour levels, colour bars, the legend, and the style panel's presets.
 *
 * MPL holds matplotlib 3.6.3's own answers: the contour levels of a grid, and
 * where constrained layout puts a colour bar.
 */
import { describe, test, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { buildFigure, FIGURE_PRESETS, textToHtml } from '../js/figure-plot.js';
import { normaliseFigure, colormapColors } from '../src/core/figure.js';

const MPL = {
  // x = linspace(-2, 2, 21), y = linspace(-1.5, 1.5, 17), Z = 7.3 sin X cos Y + 0.4 X
  levels: {
    filled7: [-8, -6, -4, -2, 0, 2, 4, 6, 8],
    filled10: [-9, -7.5, -6, -4.5, -3, -1.5, 0, 1.5, 3, 4.5, 6, 7.5, 9],
    filled4: [-8, -4, 0, 4, 8]
  },
  // fig.colorbar(pcolormesh(...), ax=ax) with layout='constrained', 6.4 x 4.8 in: position bounds
  colorbar: { ax: [0.07443628472222222, 0.058102546296296305, 0.7948133327132936, 0.9332162037037036], cb: [0.9089902840711805, 0.058102546296296305, 0.03499560763888887, 0.9332162037037036] }
};

const gx = Array.from({ length: 21 }, (_, i) => -2 + (4 * i) / 20);
const gy = Array.from({ length: 17 }, (_, j) => -1.5 + (3 * j) / 16);
const Z = gy.map((y) => gx.map((x) => Math.sin(x) * Math.cos(y) * 7.3 + 0.4 * x));

const one = (series, look = {}) => buildFigure({ export: { tight: false }, ...look, panels: [{ series }] });
const levelsOf = (trace) => {
  // The contour trace works in level-index units: level k at k.
  const c = trace.contours;
  return Array.from({ length: c.end - c.start + 1 }, (_, k) => k);
};

describe('limits, as Axes.autoscale_view makes them', () => {
  test('5% margins, held at the base of bars and histograms', () => {
    const bars = one([{ kind: 'bar', x: [0, 1, 2], y: [2, 4, 3] }]);
    expect(bars.layout.yaxis.range[0]).toBe(0);
    expect(bars.layout.yaxis.range[1]).toBeCloseTo(4.2, 12);
    expect(bars.layout.xaxis.range[0]).toBeCloseTo(-0.4 - 0.14, 12);
    const neg = one([{ kind: 'bar', x: [0, 1], y: [-2, 4] }]);
    expect(neg.layout.yaxis.range[0]).toBeCloseTo(-2.3, 12);
    const hist = one([{ kind: 'histogram', values: [1, 2, 2, 3, 3, 3], bins: 3 }]);
    expect(hist.layout.yaxis.range[0]).toBe(0);
    expect(hist.layout.xaxis.range).toEqual([0.9, 3.1]);
  });

  test('images and contours fill the axes; box plots stop half a place beyond the outer boxes', () => {
    const img = one([{ kind: 'heatmap', x: [0, 1, 2], y: [0, 1], z: [[1, 2, 3], [4, 5, 6]] }]);
    expect(img.layout.xaxis.range).toEqual([-0.5, 2.5]);
    expect(img.layout.yaxis.range).toEqual([-0.5, 1.5]);
    const cont = one([{ kind: 'contour', x: gx, y: gy, z: Z }]);
    expect(cont.layout.xaxis.range).toEqual([-2, 2]);
    const box = buildFigure({ xCategories: ['a', 'b', 'c'], panels: [{ series: [{ kind: 'box', groups: [[1, 2, 3], [2, 3, 4], [5, 6, 7]] }] }] });
    expect(box.layout.xaxis.range).toEqual([-0.5, 2.5]);
  });

  test('reference lines count for their own axis only; axline for its points; text not at all', () => {
    const f = one([{ kind: 'line', x: [0, 1], y: [0, 1] }, { kind: 'hline', y: 5 }, { kind: 'vline', x: -3 }, { kind: 'text', x: 100, y: 100, text: 'far' }]);
    expect(f.layout.yaxis.range[1]).toBeCloseTo(5.25, 12);
    expect(f.layout.xaxis.range[0]).toBeCloseTo(-3.2, 12);
  });

  test('panels share x; each has its own y', () => {
    const f = buildFigure({ panels: [{ series: [{ kind: 'line', x: [0, 10], y: [0, 1] }] }, { ratio: 0.5, series: [{ kind: 'line', x: [5, 20], y: [100, 200] }] }] });
    expect(f.layout.xaxis.range).toEqual(f.layout.xaxis2.range);
    expect(f.layout.xaxis.range[1]).toBeCloseTo(21, 12);
    expect(f.layout.yaxis2.range[1]).toBeCloseTo(205, 12);
    const [top, bottom] = f.info.axes;
    expect(top.l).toBeCloseTo(bottom.l, 9);
    expect((bottom.b - bottom.t) / (top.b - top.t)).toBeCloseTo(0.5, 6);
    // Tick labels and the x label only under the bottom panel.
    expect(f.layout.annotations.filter((a) => a.text === '20.0').length).toBe(1);
  });
});

describe('series as Plotly traces', () => {
  test('one trace per simple series, in the order given', () => {
    const f = one([
      { kind: 'band', x: [0, 1, 2], lower: [0, 1, 1], upper: [1, 2, 3] },
      { kind: 'line', x: [0, 1, 2], y: [0, 1, 2], step: 'mid', marker: 's' },
      { kind: 'scatter', x: [0, 1], y: [1, 0], marker: 'D' },
      { kind: 'errorbar', x: [0, 1], y: [1, 2], yerr: [0.1, 0.2], xerr: [[0.1, 0.1], [0.3, 0.3]], capSize: 2 },
      { kind: 'hline', y: 1 }, { kind: 'vline', x: 1 }, { kind: 'axline', points: [[0, 0], [1, 1]] }
    ]);
    expect(f.data.map((t) => [t.type, t.mode, !!t.fill].join(':'))).toEqual([
      'scatter:lines:true', 'scatter:lines+markers:false', 'scatter:markers:false', 'scatter:markers:false',
      'scatter:lines:false', 'scatter:lines:false', 'scatter:lines:false'
    ]);
    expect(f.data[1].line.shape).toBe('hvh');
    expect(f.data[3].error_y.array).toEqual([0.1, 0.2]);
    expect(f.data[3].error_x.arrayminus).toEqual([0.1, 0.1]);
    expect(f.data[3].error_x.array).toEqual([0.3, 0.3]);
    expect(f.data[4].x).toEqual(f.layout.xaxis.range);
    expect(f.data[5].y).toEqual(f.layout.yaxis.range);
  });

  test('bands split where the data have gaps', () => {
    const f = one([{ kind: 'band', x: [0, 1, 2, 3, 4], lower: [0, 0, NaN, 0, 0], upper: [1, 1, 1, 1, 1] }]);
    expect(f.data[0].x.filter((v) => v === null)).toHaveLength(1);
  });

  test('bars grouped side by side, with their error bars', () => {
    const f = buildFigure({ xCategories: ['a', 'b'], panels: [{ series: [{ kind: 'bar', y: [1, 2], yerr: [0.1, 0.2] }, { kind: 'bar', y: [2, 1] }] }] });
    expect(f.data).toHaveLength(3);
    expect(f.data[1].x).toEqual([-0.2, 0.8]);
    expect(f.data[0].x.slice(0, 2)).toEqual([-0.4, 0]);
    expect(f.layout.annotations.map((a) => a.text)).toEqual(expect.arrayContaining(['a', 'b']));
  });

  test('box plots: boxes, whiskers and caps, medians, outliers, points, means', () => {
    const f = buildFigure({ xCategories: ['a', 'b'], panels: [{ series: [{ kind: 'box', groups: [[1, 2, 3, 4, 20], [2, 3, 4]], points: true, mean: true, fliers: true }] }] });
    expect(f.data).toHaveLength(6);
    expect(f.data[3].y).toEqual([20]);
    expect(f.data[4].x).toHaveLength(8);
    expect(f.data[5].error_y).toBeDefined();
  });

  test('heatmaps: matplotlib\'s colours band for band; vector cells for export', () => {
    const f = one([{ kind: 'heatmap', x: [0, 1, 2], y: [0, 1], z: [[0, 1, 2], [3, 4, NaN]], colormap: 'magma' }]);
    const t = f.data[0];
    expect(t.type).toBe('heatmap');
    expect([t.zmin, t.zmax]).toEqual([0, 4]);
    expect(t.colorscale[0][1]).toBe(colormapColors('magma')[0]);
    expect(t.colorscale[t.colorscale.length - 1][1]).toBe(colormapColors('magma')[255]);
    const v = buildFigure({ export: { tight: false }, panels: [{ series: [{ kind: 'heatmap', x: [0, 1, 2], y: [0, 1], z: [[0, 1, 2], [3, 4, NaN]] }] }] }, { vector: true });
    expect(v.data).toHaveLength(0);
    const cells = v.layout.shapes.filter((s) => s.layer === 'below' && s.fillcolor !== 'rgba(0,0,0,0)');
    expect(cells).toHaveLength(5);   // five colours; the NaN cell is left out
  });

  test('contours: matplotlib\'s levels', () => {
    for (const [n, want] of [[7, MPL.levels.filled7], [10, MPL.levels.filled10], [4, MPL.levels.filled4]]) {
      const f = buildFigure({ panels: [{ series: [{ kind: 'contour', filled: true, levels: n, x: gx, y: gy, z: Z, colorbar: { show: true } }] }] }, { tight: false });
      expect(levelsOf(f.data[0])).toHaveLength(want.length);
      // The colour bar's ticks are the levels (FixedLocator, nbins 10).
      const ticks = f.layout.annotations.map((a) => a.text).filter((t) => /^−?\d/.test(t));
      const expected = want.length > 11 ? want.filter((_, i) => i % 2 === 0) : want;
      expected.forEach((v) => expect(ticks).toContain(textToHtml(String(v)).replace('-', '−')));
    }
  });
});

describe('colour bars, as Figure.colorbar and constrained layout place them', () => {
  test('beside the axes, 1/20 as wide as tall, 5% of the axes\' width away', () => {
    const f = buildFigure({ export: { tight: false }, panels: [{ series: [{ kind: 'heatmap', x: gx, y: gy, z: Z }] }] });
    const W = 6.4 * 96; const H = 4.8 * 96;
    const [ax] = f.info.axes; const [cb] = f.info.colorbars;
    expect(cb.r - cb.l).toBeCloseTo((cb.b - cb.t) / 20, 6);
    expect(cb.t).toBeCloseTo(ax.t, 6);
    expect(cb.b).toBeCloseTo(ax.b, 6);
    // Against matplotlib (text is measured from font averages here, so to a few px).
    const want = MPL.colorbar;
    expect(Math.abs(ax.l / W - want.ax[0]) * W).toBeLessThan(6);
    expect(Math.abs((ax.r - ax.l) / W - want.ax[2]) * W).toBeLessThan(8);
    expect(Math.abs(cb.l / W - want.cb[0]) * W).toBeLessThan(8);
    expect(Math.abs((cb.b - cb.t) / H - want.cb[3]) * H).toBeLessThan(6);
  });

  test('none for line contours; the label beside the bar', () => {
    const lines = buildFigure({ panels: [{ series: [{ kind: 'contour', x: gx, y: gy, z: Z }] }] });
    expect(lines.info.colorbars).toEqual([null]);
    const lab = buildFigure({ panels: [{ series: [{ kind: 'heatmap', x: gx, y: gy, z: Z, colorbar: { label: '$F$ (kJ/mol)' } }] }] });
    const note = lab.layout.annotations.find((a) => a.text === '<i>F</i> (kJ/mol)');
    expect(note.textangle).toBe(-90);
    expect(note.x * lab.layout.width).toBeGreaterThan(lab.info.colorbars[0].r);
  });
});

describe('legend', () => {
  test('labelled series in the order asked for; kinds without a handle left out', () => {
    const f = buildFigure({ panels: [{ legend: { order: ['b'] }, series: [
      { id: 'a', kind: 'line', x: [0, 1], y: [0, 1], label: 'First' },
      { id: 'b', kind: 'bar', x: [0, 1], y: [1, 1], label: 'Second' },
      { id: 'c', kind: 'text', x: 0, y: 0, text: 'note', label: 'never' },
      { id: 'd', kind: 'scatter', x: [0], y: [0], label: 'Hidden', legend: false }
    ] }] });
    const texts = f.layout.annotations.map((a) => a.text);
    expect(texts.indexOf('Second')).toBeLessThan(texts.indexOf('First'));
    expect(texts).not.toContain('never');
    expect(texts).not.toContain('Hidden');
    expect(f.info.legend).not.toBeNull();
  });

  test('"best" keeps clear of bars as matplotlib counts them', () => {
    const f = buildFigure({ panels: [{ series: [{ kind: 'bar', x: [0, 1, 2, 3], y: [9, 9, 1, 1], label: 'Bars' }] }] });
    expect(f.info.legend).toBe('upper right');
    const g = buildFigure({ panels: [{ series: [{ kind: 'bar', x: [0, 1, 2, 3], y: [1, 1, 9, 9], label: 'Bars' }] }] });
    expect(g.info.legend).toBe('upper left');
  });

  test('a title and two columns widen the box', () => {
    const series = [1, 2, 3, 4].map((k) => ({ kind: 'line', x: [0, 1], y: [k, k], label: `Series ${k}` }));
    const plain = buildFigure({ panels: [{ series }] });
    const cols = buildFigure({ legend: { columns: 2, title: 'Runs' }, panels: [{ series }] });
    const w = (f) => f.info.legendBox.r - f.info.legendBox.l;
    const h = (f) => f.info.legendBox.b - f.info.legendBox.t;
    expect(w(cols)).toBeGreaterThan(w(plain));
    expect(h(cols)).toBeLessThan(h(plain));
    expect(cols.layout.annotations.some((a) => a.text === 'Runs')).toBe(true);
  });
});

describe('robustness', () => {
  test('any description, even a broken one, gives a figure', () => {
    expect(() => buildFigure({})).not.toThrow();
    expect(() => buildFigure({ panels: [{ series: [{ kind: 'heatmap' }, { kind: 'contour', z: [[1]] }, { kind: 'box' }, { kind: 'histogram' }, { kind: 'axline', slope: 2 }] }] })).not.toThrow();
    expect(() => buildFigure({ xScale: 'log', panels: [{ yScale: 'log', series: [{ kind: 'line', x: [0, -1, 2], y: [0, 1, 10] }, { kind: 'band', x: [-1, 1, 2], lower: [1, 1, 1], upper: [2, 2, 2] }] }] })).not.toThrow();
    expect(() => buildFigure(normaliseFigure({ width: 1, height: 1, fontSize: 40, title: 'x', panels: [{ series: [{ kind: 'line', x: [1, 2], y: [1, 2] }] }] }))).not.toThrow();
  });

  test('presets hold figure looks and series sizes only', () => {
    for (const p of Object.values(FIGURE_PRESETS)) {
      expect(Object.keys(p).slice(0, 2)).toEqual(['figure', 'series']);
      expect(p.figure.panels).toBeUndefined();
    }
    expect(Object.keys(FIGURE_PRESETS)).toEqual(['publication', 'presentation', 'minimal', 'dark']);
  });
});

describe('long runs', () => {
  // A 500 000-row COLVAR is an ordinary run: nothing may spread a data array
  // into a call (Math.min(...a) and push(...a) run out of stack past ~125 000).
  const N = 1000000;
  const x = Array.from({ length: N }, (_, i) => i * 0.002);
  const y = x.map((v) => Math.sin(v) + 0.01 * Math.sin(97 * v));
  const col = (values, column) => ({ values, source: 'colvar', column });

  test('a million points normalise, bin, box and draw', () => {
    const f = normaliseFigure({ xCategories: null, panels: [
      { series: [
        { kind: 'line', x: col(x, 'time'), y: col(y, 'd1'), label: 'd1' },
        { kind: 'band', x: col(x, 'time'), lower: y.map((v) => v - 0.1), upper: y.map((v) => v + 0.1) },
        { kind: 'scatter', x: col(x, 'time'), y: col(y, 'd1') },
        { kind: 'bracket', x1: 0, x2: 100, y: 1.2 }
      ] },
      { series: [{ kind: 'histogram', values: col(y, 'd1'), bins: 80 }] }
    ] });
    const built = buildFigure(f, { normalised: true });
    expect(built.data[0].x.length).toBeLessThan(20000);   // thinned for the screen
    expect(f.panels[1].series[0].counts.reduce((a, b) => a + b, 0)).toBe(N);
    const box = buildFigure({ xCategories: ['run'], panels: [{ series: [{ kind: 'box', groups: [y], points: true, mean: true }] }] });
    expect(box.data.length).toBeGreaterThan(3);
  }, 180000);

  // Timed in a plain Node process: Jest's module sandbox runs this code about
  // ten times slower, and more so when the other suites run alongside.
  test('in a plain Node process, each step takes about a second or less', () => {
    const url = (p) => JSON.stringify(new URL(p, import.meta.url).href);
    const script = `
      import { normaliseFigure, histogram, boxStats } from ${url('../src/core/figure.js')};
      import { buildFigure } from ${url('../js/figure-plot.js')};
      import { figureScript } from ${url('../src/core/figure-python.js')};
      const N = 1000000;
      const x = Array.from({ length: N }, (_, i) => i * 0.002);
      const y = x.map((v) => Math.sin(v) + 0.01 * Math.sin(97 * v));
      const col = (values, column) => ({ values, source: 'colvar', column });
      const fig = { panels: [{ series: [{ kind: 'line', x: col(x, 'time'), y: col(y, 'd1') }, { kind: 'scatter', x: col(x, 'time'), y: col(y, 'd1') }] },
        { series: [{ kind: 'histogram', values: col(y, 'd1'), bins: 80 }] }] };
      const ms = {};
      const time = (k, f) => { const t = performance.now(); const r = f(); ms[k] = Math.round(performance.now() - t); return r; };
      const f = time('normaliseFigure', () => normaliseFigure(fig));
      time('buildFigure', () => buildFigure(f, { normalised: true }));
      time('histogram', () => histogram(y, 50));
      time('boxStats', () => boxStats(y));
      time('figureScript, files', () => figureScript(f, { data: 'files', files: { colvar: { file: 'COLVAR', format: 'table' } } }));
      time('figureScript, embedded', () => figureScript({ panels: [{ series: [{ kind: 'line', x, y }] }] }));
      console.log(JSON.stringify(ms));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 120000 });
    expect([r.status, r.stderr]).toEqual([0, '']);
    const ms = JSON.parse(r.stdout);
    console.log(`a million points: ${Object.entries(ms).map(([k, v]) => `${k} ${v} ms`).join(', ')}`);
    // Each is well under a second on a desktop; the bound leaves room for a busy machine.
    for (const [k, v] of Object.entries(ms)) if (!(v < 10000)) throw new Error(`${k} took ${v} ms`);
  }, 180000);
});

describe('grid along one axis, text sizes', () => {
  const series = [{ kind: 'line', x: [0, 1, 2, 3], y: [0, 1, 4, 9] }];
  const gridShapes = (f) => f.layout.shapes.filter((s) => s.layer === 'below');
  const verticals = (f) => gridShapes(f).map((s) => s.path.split('M').filter(Boolean)
    .filter((seg) => { const [a, b] = seg.split('L').map((p) => p.split(',').map(Number)); return Math.abs(a[0] - b[0]) < 1e-9; }).length);

  test('grid.axis draws the lines at the x ticks, the y ticks, or both', () => {
    const both = buildFigure({ grid: { show: true }, panels: [{ series }] });
    const x = buildFigure({ grid: { show: true, axis: 'x' }, panels: [{ series }] });
    const y = buildFigure({ grid: { show: true, axis: 'y' }, panels: [{ series }] });
    const count = (f) => gridShapes(f)[0].path.split('M').filter(Boolean).length;
    expect(count(x) + count(y)).toBe(count(both));
    expect(verticals(x)[0]).toBe(count(x));
    expect(verticals(y)[0]).toBe(0);
  });

  test('titleSize and tickSize set their text; left out, they follow fontSize', () => {
    const size = (f, text) => f.layout.annotations.find((a) => a.text === text).font.size;
    const auto = buildFigure({ title: 'T', fontSize: 12, panels: [{ series }] });
    expect(size(auto, 'T')).toBeCloseTo(13 * 96 / 72, 9);
    expect(size(auto, '2')).toBeCloseTo(11 * 96 / 72, 9);
    const set = buildFigure({ title: 'T', fontSize: 12, titleSize: 20, tickSize: 6, panels: [{ series }] });
    expect(size(set, 'T')).toBeCloseTo(20 * 96 / 72, 9);
    expect(size(set, '2')).toBeCloseTo(6 * 96 / 72, 9);
  });
});

describe('markers once per pixel', () => {
  let seed = 3;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const N = 400000;
  const x = Array.from({ length: N }, () => rand() * 10);
  const y = x.map((v) => Math.sin(v) + 0.3 * (rand() - 0.5));

  /* The device pixels the markers' centres fall in, as the axes place them. */
  const occupied = (f, xs, ys, scale) => {
    const [ax] = f.info.axes;
    const [x0, x1] = f.layout.xaxis.range; const [y0, y1] = f.layout.yaxis.range;
    const set = new Set();
    for (let i = 0; i < xs.length; i++) {
      const X = ax.l + ((xs[i] - x0) / (x1 - x0)) * (ax.r - ax.l);
      const Y = ax.b - ((ys[i] - y0) / (y1 - y0)) * (ax.b - ax.t);
      if (X < ax.l || X > ax.r || Y < ax.t || Y > ax.b) continue;
      set.add(`${Math.floor((X - ax.l) * scale)},${Math.floor((Y - ax.t) * scale)}`);
    }
    return set;
  };

  test('the same pixels hold a marker; far fewer markers are drawn', () => {
    const scale = 2;
    const f = buildFigure({ export: { tight: false }, panels: [{ series: [{ kind: 'scatter', x, y }] }] }, { markerScale: scale });
    const t = f.data[0];
    expect(t.x.length).toBeLessThan(N / 3);
    const all = occupied(f, x, y, scale); const drawn = occupied(f, t.x, t.y, scale);
    expect(drawn.size).toBe(all.size);
    for (const k of all) if (!drawn.has(k)) throw new Error(`pixel ${k} lost its marker`);
  });

  test('few points, and error bars that differ, are all kept; the preview\'s budget caps a dense cloud', () => {
    const few = buildFigure({ panels: [{ series: [{ kind: 'scatter', x: x.slice(0, 3000), y: y.slice(0, 3000) }] }] });
    expect(few.data[0].x).toHaveLength(3000);
    const bars = buildFigure({ panels: [{ series: [{ kind: 'errorbar', x: x.slice(0, 5000).map(() => 1), y: x.slice(0, 5000).map(() => 1), yerr: x.slice(0, 5000).map((_, i) => i * 0.001) }] }] });
    expect(bars.data[0].x.length).toBeGreaterThan(100);   // one marker, but bars of many lengths
    const capped = buildFigure({ panels: [{ series: [{ kind: 'scatter', x, y }] }] }, { markerBudget: 20000 });
    expect(capped.data[0].x.length).toBeLessThanOrEqual(20000);
    // A long line with markers: the line thinned, its markers in a trace of their own.
    const line = buildFigure({ panels: [{ series: [{ kind: 'line', x, y, marker: 'o' }] }] });
    expect(line.data.map((t) => t.mode)).toEqual(['lines', 'markers']);
  });
});
