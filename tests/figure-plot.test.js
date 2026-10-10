/**
 * The parts of js/figure-plot.js that need no browser: the figure buildFigure
 * lays out for every series kind (text measured from font averages under
 * Node), the limits matplotlib's autoscaling gives (sticky edges included),
 * contour levels, colour bars, the legend, and the style panel's presets.
 *
 * MPL holds matplotlib's own answers: the contour levels of a grid, and
 * where constrained layout puts a colour bar (recorded with 3.6.3; 3.11.2
 * gives the same levels and the bar within a pixel).
 */
import { describe, test, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { buildFigure, FIGURE_PRESETS, textToHtml } from '../js/figure-plot.js';
import { normaliseFigure, colormapColors, COLOR_CYCLE } from '../src/core/figure.js';

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

  test('presets hold figure looks and series sizes only; the background has a picker of its own', () => {
    for (const p of Object.values(FIGURE_PRESETS)) {
      expect(Object.keys(p)).toEqual(['figure', 'series']);
      expect(p.figure.panels).toBeUndefined();
      expect(p.figure.background).toBeUndefined();
      expect(p.figure.foreground).toBeUndefined();
    }
    expect(Object.keys(FIGURE_PRESETS)).toEqual(['publication', 'presentation', 'minimal']);
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

  // matplotlib 3.6.3, running the script: the grid is hidden under a
  // pcolormesh and a contourf, and contour lines cross over it. The script
  // calls set_axisbelow(True), which puts the grid at zorder 0.5, and gives
  // its series zorder 1 and up. (Left alone, axes.axisbelow is 'line': the
  // grid at zorder 1.5, over a mesh at 1 and under lines at 2.) So the
  // preview's grid is under every trace, and a vector export draws it
  // before the cells of a heatmap.
  test('the grid lies under heatmaps and contours, where the script puts it', async () => {
    const { figureScript } = await import('../src/core/figure-python.js');
    const z = [[0, 1, 2], [3, 4, 5]];
    for (const kind of [{ kind: 'heatmap' }, { kind: 'contour', filled: true }, { kind: 'contour' }]) {
      const fig = { grid: { show: true }, panels: [{ series: [{ id: 'q', x: [0, 1, 2], y: [0, 1], z, ...kind }] }] };
      const f = buildFigure(fig);
      expect(f.data).toHaveLength(1);
      expect(gridShapes(f)).toHaveLength(1);
      const code = figureScript(fig);
      expect(code).toContain('axes.set_axisbelow(True)');
      expect(code).toMatch(/ax\.(pcolormesh|contourf|contour)\([^)]*zorder=1\)/);
    }
    const v = buildFigure({ grid: { show: true }, panels: [{ series: [{ kind: 'heatmap', x: [0, 1, 2], y: [0, 1], z }] }] }, { vector: true });
    const clear = v.layout.shapes.map((s) => s.layer === 'below' && s.fillcolor === 'rgba(0,0,0,0)');
    const cells = v.layout.shapes.map((s) => s.layer === 'below' && s.fillcolor !== 'rgba(0,0,0,0)');
    expect(cells.filter(Boolean)).toHaveLength(6);
    expect(clear.indexOf(true)).toBeLessThan(cells.indexOf(true));
    // A figure of lines alone: one grid shape under its traces, as ever.
    expect(gridShapes(buildFigure({ grid: { show: true }, panels: [{ series }] }))).toHaveLength(1);
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

describe('second axes: a y axis on the right, an x axis on top', () => {
  const t = [0, 10, 20, 30, 40];
  const temp = { id: 'T', kind: 'line', x: t, y: [290, 300, 310, 315, 318], label: 'Temperature' };
  const pres = { id: 'p', kind: 'line', x: t, y: [100, 120, 150, 190, 240], label: 'Pressure', yAxis: 'right' };
  const twin = (look = {}, series = [temp, pres]) => buildFigure({ export: { tight: false }, xLabel: 'Time (s)', ...look,
    panels: [{ yLabel: 'T (K)', y2Label: 'p (kPa)', y2Color: 'auto', ...(look.panel || {}), series }] });
  const at = (f, text) => f.layout.annotations.filter((a) => a.text === text);
  const px = (f, a) => [a.x * f.layout.width, (1 - a.y) * f.layout.height];

  test('the right axis autoscales from its own series; tick labels stand right of the axes in its colour', () => {
    const f = twin();
    const [view] = f.info.views;
    expect(view.y.view[0]).toBeCloseTo(290 - 1.4, 9);
    expect(view.y2.view).toEqual([100 - 7, 240 + 7]);
    expect(f.info.ticks[0].y2.major.map((k) => k.text)).toEqual(['100', '120', '140', '160', '180', '200', '220', '240']);
    const [box] = f.info.axes;
    const label = at(f, '160')[0];
    const [x] = px(f, label);
    expect(x).toBeGreaterThan(box.r);
    expect(label.font.color).toBe(COLOR_CYCLE[1]);
    // The axis label reads upward, right of the tick labels.
    const name = at(f, 'p (kPa)')[0];
    expect(name.textangle).toBe(-90);
    expect(px(f, name)[0]).toBeGreaterThan(x);
  });

  test('the layout makes room on the right, as for the left', () => {
    const one = twin({}, [temp, { ...pres, yAxis: 'left' }]);
    const two = twin();
    const W = 6.4 * 96;
    expect(W - two.info.axes[0].r).toBeGreaterThan(W - one.info.axes[0].r + 20);
    expect(two.info.axes[0].l).toBeCloseTo(one.info.axes[0].l, 6);
  });

  test('a right-axis series is drawn where its own scale puts it, on the panel\'s Plotly axes', () => {
    const f = twin();
    const [box] = f.info.axes;
    const { y: left, y2: right } = f.info.views[0];
    const toPx = (v, a) => box.b - ((v - a.view[0]) / (a.view[1] - a.view[0])) * (box.b - box.t);
    const trace = f.data[1];
    pres.y.forEach((v, i) => expect(toPx(trace.y[i], left)).toBeCloseTo(toPx(v, right), 6));
    // And on a log scale.
    const log = twin({ panel: { y2Scale: 'log' } });
    const [lbox] = log.info.axes;
    const { y: ly, y2: ry } = log.info.views[0];
    const lin = (v, a) => lbox.b - ((v - a.view[0]) / (a.view[1] - a.view[0])) * (lbox.b - lbox.t);
    const logPx = (v, a) => lbox.b - ((Math.log10(v) - Math.log10(a.view[0])) / (Math.log10(a.view[1]) - Math.log10(a.view[0]))) * (lbox.b - lbox.t);
    expect(ry.log).toBe(true);
    pres.y.forEach((v, i) => expect(lin(log.data[1].y[i], ly)).toBeCloseTo(logPx(v, ry), 6));
  });

  test('limits and a log scale of its own; error bars follow its scale', () => {
    const f = twin({ panel: { y2Lim: [0, 500] } }, [temp, { ...pres, kind: 'errorbar', yerr: [10, 10, 10, 10, 10] }]);
    expect(f.info.views[0].y2.view).toEqual([0, 500]);
    const tr = f.data[1];
    const { y: left } = f.info.views[0];
    const k = (left.view[1] - left.view[0]) / 500;
    expect(tr.error_y.array[0]).toBeCloseTo(10 * k, 9);
    expect(tr.error_y.arrayminus[0]).toBeCloseTo(10 * k, 9);
  });

  test('the left axis keeps its marks off the right side; the right spine and marks take the axis colour', () => {
    const f = twin({ panel: { yTicks: { mirror: true } } });
    const [box] = f.info.axes;
    const shapes = f.layout.shapes.filter((s) => s.layer === 'above');
    const rightX = (box.r) / f.layout.width;
    const nearRight = (s) => s.path && s.path.split(/[ML]/).filter(Boolean).every((p) => Math.abs(Number(p.split(',')[0]) - rightX) < 0.02);
    const coloured = shapes.filter((s) => s.line && s.line.color === COLOR_CYCLE[1]);
    expect(coloured.length).toBeGreaterThanOrEqual(2);   // the spine and the tick marks
    expect(shapes.filter((s) => s.line && s.line.color !== COLOR_CYCLE[1]).some(nearRight)).toBe(false);
  });

  test('one legend lists the series of both axes; "best" weighs the axes it stands on', () => {
    const f = twin();
    const texts = f.layout.annotations.map((a) => a.text);
    expect(texts).toEqual(expect.arrayContaining(['Temperature', 'Pressure']));
    expect(f.info.legends).toHaveLength(1);
  });

  test('a top x axis: its own limits, tick labels above, its label above them, the title above all', () => {
    const wl = [400, 500, 600, 700];
    const f = buildFigure({ export: { tight: false }, title: 'Spectrum', xLabel: 'Wavelength (nm)', panels: [{ x2Label: 'Wavenumber (cm$^{-1}$)', series: [
      { kind: 'line', x: wl, y: [0.2, 0.9, 0.4, 0.2], label: 'A' },
      { kind: 'scatter', x: wl.map((v) => 1e7 / v), y: [0.2, 0.9, 0.4, 0.2], xAxis: 'top', label: 'B' }
    ] }] });
    const [box] = f.info.axes;
    const v = f.info.views[0];
    expect(v.x2.view[0]).toBeCloseTo(1e7 / 700 - 0.05 * (1e7 / 400 - 1e7 / 700), 6);
    expect(f.info.ticks[0].x2.major.length).toBeGreaterThan(2);
    const tick = at(f, f.info.ticks[0].x2.major[0].text)[0];
    const label = f.layout.annotations.find((a) => a.text.startsWith('Wavenumber'));
    const title = at(f, 'Spectrum')[0];
    expect(px(f, tick)[1]).toBeLessThan(box.t);
    expect(px(f, label)[1]).toBeLessThan(px(f, tick)[1]);
    expect(px(f, title)[1]).toBeLessThan(px(f, label)[1]);
    // The top series lands on the bottom axes' scale where its own puts it.
    const tr = f.data[1];
    const toX = (val, a) => box.l + ((val - a.view[0]) / (a.view[1] - a.view[0])) * (box.r - box.l);
    tr.x.forEach((xv, i) => expect(toX(xv, v.x)).toBeCloseTo(toX(1e7 / wl[i], v.x2), 6));
  });

  test('both at once, in one panel of two; the other panel has none', () => {
    const f = buildFigure({ export: { tight: false }, panels: [
      { series: [temp, pres, { kind: 'line', x: [1, 2], y: [5, 6], xAxis: 'top', yAxis: 'right' }] },
      { series: [{ kind: 'line', x: t, y: [1, 2, 3, 4, 5] }] }
    ] });
    expect(f.info.views[0].x2.view).toEqual([0.95, 2.05]);
    expect(f.info.views[0].y2.view[0]).toBeCloseTo(5 - 11.75, 9);   // 5 to 240 with 5% margins
    expect(f.info.views[1].x2).toBeNull();
    expect(f.info.views[1].y2).toBeNull();
    expect(f.info.ticks[1].y2).toBeUndefined();
    // The panels still share the bottom x and line up.
    expect(f.info.axes[0].l).toBeCloseTo(f.info.axes[1].l, 6);
    expect(f.info.axes[0].r).toBeCloseTo(f.info.axes[1].r, 6);
  });
});

describe('bars lying flat, stacked bars, wide bars', () => {
  const rectsOf = (trace) => {
    // The corners of each rectangle of a filled path: [x0, x1, y0, y1].
    const out = [];
    for (let i = 0; i < trace.x.length; i += 6) out.push([trace.x[i], trace.x[i + 1], trace.y[i], trace.y[i + 2]]);
    return out;
  };

  test('horizontal bars: lengths along x from a sticky base, names on the y axis, error bars along x', () => {
    const f = one([
      { kind: 'bar', orientation: 'h', y: [2, 1, 0], x: [4, 6, 5], xerr: [0.4, 0.5, 0.6], label: 'A' },
      { kind: 'bar', orientation: 'h', y: [2, 1, 0], x: [3, 4, 6], label: 'B' }
    ], { panel: null });
    const g = buildFigure({ export: { tight: false }, panels: [{ yCategories: ['c', 'b', 'a'], series: [
      { kind: 'bar', orientation: 'h', y: [2, 1, 0], x: [4, 6, 5], xerr: [0.4, 0.5, 0.6], label: 'A' },
      { kind: 'bar', orientation: 'h', y: [2, 1, 0], x: [3, 4, 6], label: 'B' }] }] });
    for (const fig of [f, g]) {
      expect(fig.layout.xaxis.range[0]).toBe(0);                        // the base holds the margin back
      expect(fig.layout.xaxis.range[1]).toBeCloseTo(6.5 * 1.05, 9);     // 6 + 0.5, plus 5%
      expect(fig.layout.yaxis.range).toEqual([-0.4 - 0.14, 2.4 + 0.14].map((v) => expect.closeTo(v, 9)));
    }
    // The first series lies above the second at each place.
    expect(rectsOf(g.data[0])).toEqual([[0, 4, 2, 2.4], [0, 6, 1, 1.4], [0, 5, 0, 0.4]].map((r) => r.map((v) => expect.closeTo(v, 12))));
    expect(rectsOf(g.data[2])[0]).toEqual([0, 3, 1.6, 2].map((v) => expect.closeTo(v, 12)));
    expect(g.data[1].error_x.array).toEqual([0.4, 0.5, 0.6]);
    expect(g.data[1].error_y).toBeUndefined();
    expect(g.data[1].y).toEqual([2.2, 1.2, 0.2].map((v) => expect.closeTo(v, 12)));
    expect(g.info.ticks[0].y.major.map((t) => t.text)).toEqual(['c', 'b', 'a']);
    expect(g.info.ticks[0].y.minor).toEqual([]);
    // Upright bars are drawn as they were.
    const up = one([{ kind: 'bar', x: [0, 1, 2], y: [2, 4, 3], yerr: [0.1, 0.2, 0.3] }]);
    expect(rectsOf(up.data[0])).toEqual([[-0.4, 0.4, 0, 2], [0.6, 1.4, 0, 4], [1.6, 2.4, 0, 3]]);
    expect(up.data[1].error_y.array).toEqual([0.1, 0.2, 0.3]);
  });

  test('bars as wide as asked, on bases of their own', () => {
    const f = one([{ kind: 'bar', x: [0, 5, 10], y: [1, 2, 3], width: 4, bottom: [0.5, 1, -1] }]);
    expect(rectsOf(f.data[0])).toEqual([[-2, 2, 0.5, 1.5], [3, 7, 1, 3], [8, 12, -1, 2]]);
    expect(f.layout.xaxis.range).toEqual([-2 - 0.7, 12 + 0.7].map((v) => expect.closeTo(v, 9)));
    // Each base is a sticky edge: the lowest holds the margin back.
    expect(f.layout.yaxis.range).toEqual([-1, 3 + 0.2].map((v) => expect.closeTo(v, 9)));
  });

  test('stacked bars stand on each other; the limits take the whole stack; the legend reads down it', () => {
    const f = one([
      { id: 'a', kind: 'bar', y: [3, 4, -2], stack: 'stack', yerr: [0.3, 0.2, 0.4], label: 'Lower' },
      { id: 'b', kind: 'bar', y: [2, -1, 3], stack: 'stack', label: 'Upper' }
    ], { legend: { position: 'upper right' } });
    expect(rectsOf(f.data[0]).map((r) => r.slice(2))).toEqual([[0, 3], [0, 4], [0, -2]]);
    expect(rectsOf(f.data[2]).map((r) => r.slice(2))).toEqual([[3, 5], [0, -1], [0, 3]]);
    expect(rectsOf(f.data[2]).map((r) => r.slice(0, 2))).toEqual(rectsOf(f.data[0]).map((r) => r.slice(0, 2)));   // one place
    expect(f.data[1].y).toEqual([3, 4, -2]);                            // error bars at the ends of the bars
    expect(f.layout.yaxis.range).toEqual([-2.4 - 0.37, 5 + 0.37].map((v) => expect.closeTo(v, 9)));
    const y = (text) => f.layout.annotations.find((a) => a.text === text).y;
    expect(y('Upper')).toBeGreaterThan(y('Lower'));
    const plain = one([{ kind: 'bar', y: [1, 2], label: 'Lower' }, { kind: 'bar', y: [2, 1], label: 'Upper' }], { legend: { position: 'upper right' } });
    const yp = (text) => plain.layout.annotations.find((a) => a.text === text).y;
    expect(yp('Lower')).toBeGreaterThan(yp('Upper'));
    // To 100%.
    const pc = one([{ kind: 'bar', y: [3, 1], stack: 'percent' }, { kind: 'bar', y: [1, 3], stack: 'percent' }]);
    expect(rectsOf(pc.data[1]).map((r) => r.slice(2))).toEqual([[75, 100], [25, 100]]);
    expect(pc.layout.yaxis.range).toEqual([0, 105]);
  });

  test('a bar with no number takes no room, as matplotlib leaves it out of the limits', () => {
    const f = one([{ kind: 'bar', x: [0, 1, 2], y: [1, 2, NaN] }]);
    expect(f.layout.xaxis.range).toEqual([-0.4 - 0.09, 1.4 + 0.09].map((v) => expect.closeTo(v, 9)));
    const g = one([{ kind: 'bar', x: [0, 1, 2], y: [1, 2, NaN], yerr: [0.1, 0.1, 0.1] }]);
    expect(g.layout.xaxis.range).toEqual([-0.4 - 0.12, 2 + 0.12].map((v) => expect.closeTo(v, 9)));   // its error bar still stands at 2
  });

  test('bars of means: the bar, its error bar, and each value over it', () => {
    const values = [4, 6, 1, 3, 5, 7, 9];
    const f = one([{ kind: 'bar', replicates: { values, codes: [0, 0, 1, 1, 1, 2, -1], error: 'sd' }, points: true }]);
    expect(rectsOf(f.data[0]).map((r) => r[3])).toEqual([5, 3, 7]);
    expect(f.data[1].error_y.array.slice(0, 2)).toEqual([Math.SQRT2, 2].map((v) => expect.closeTo(v, 12)));
    expect(Number.isNaN(f.data[1].error_y.array[2])).toBe(true);        // one value: no error bar
    expect(f.data[2].mode).toBe('markers');
    expect(f.data[2].y).toEqual([4, 6, 1, 3, 5, 7]);
    f.data[2].x.forEach((x, i) => expect(Math.abs(x - [0, 0, 1, 1, 1, 2][i])).toBeLessThanOrEqual(0.2));
    expect(f.data[2].marker.color).toMatch(/^rgba\(26, ?26, ?26, ?0\.6\)$/);                // the text colour, not the bar's
    expect(one([{ kind: 'bar', replicates: { values, codes: [0, 0, 1, 1, 1, 2, -1] } }]).data).toHaveLength(2);
  });
});

describe('histogram options, notched boxes and violins in the preview', () => {
  const values = [1, 2, 2, 3, 3, 3, 4, 4, 5, 9];

  test('a running total is drawn as steps going up, from the baseline', () => {
    const f = one([{ kind: 'histogram', values, bins: [1, 3, 5, 9], cumulative: true, histtype: 'step' }]);
    expect(f.data[0].y).toEqual([0, 3, 3, 8, 8, 10, 10, 0]);
    expect(f.layout.yaxis.range).toEqual([0, 10.5]);
    const pc = one([{ kind: 'histogram', values, bins: [1, 3, 5, 9], normalise: 'percent' }]);
    expect(pc.data[0].y.slice(1, 7)).toEqual([30, 30, 50, 50, 20, 20]);
    // numpy's rule gives the bins the preview draws.
    const rule = one([{ kind: 'histogram', values, bins: 'sturges' }]);
    expect(rule.data[0].x[0]).toBe(1);
    expect((rule.data[0].x.length - 3) / 2).toBe(5);                    // ceil(9 / (9 / (log2(10) + 1))) bins, and the path closed
  });

  test('a notched box: in to a quarter of its width at the median, the median line as wide', () => {
    const f = one([{ kind: 'box', groups: [values], notch: true }]);
    const st = normaliseFigure({ panels: [{ series: [{ kind: 'box', groups: [values] }] }] }).panels[0].series[0].groups[0].stats;
    expect(f.data[0].x).toEqual([-0.25, 0.25, 0.25, 0.125, 0.25, 0.25, -0.25, -0.25, -0.125, -0.25, -0.25]);
    expect(f.data[0].y).toEqual([st.q1, st.q1, st.notchLow, st.med, st.notchHigh, st.q3, st.q3, st.notchHigh, st.med, st.notchLow, st.q1]);
    expect(f.data[2].x.slice(0, 2)).toEqual([-0.125, 0.125]);
    // matplotlib's limits count the caps and the median line, not the box: 5% beyond a quarter of the width.
    expect(f.layout.xaxis.range).toEqual([-0.125 - 0.0125, 0.125 + 0.0125].map((v) => expect.closeTo(v, 12)));
    const plain = one([{ kind: 'box', groups: [values] }]);
    expect(plain.layout.xaxis.range).toEqual([-0.275, 0.275].map((v) => expect.closeTo(v, 12)));
    // Whiskers to the smallest and the largest value: nothing is beyond them.
    const range = one([{ kind: 'box', groups: [values], whis: [0, 100] }]);
    expect(range.data.filter((t) => t.mode === 'markers')).toHaveLength(0);
    expect(plain.data.filter((t) => t.mode === 'markers')).toHaveLength(1);
  });

  test('a violin: its outline filled, a box, a line and a dot inside, points when asked', () => {
    const f = one([{ kind: 'violin', groups: [values, [2, 2, 2]], points: true }]);
    const q = normaliseFigure({ panels: [{ series: [{ kind: 'violin', groups: [values, [2, 2, 2]] }] }] }).panels[0].series[0];
    const [body, points, whisker, box, dot] = f.data;
    expect(body.fill).toBe('toself');
    expect(body.fillcolor).toMatch(/0\.35\)$/);
    expect(body.x.slice(0, 100)).toEqual(q.groups[0].half.map((w) => -w));
    expect(body.y.slice(0, 100)).toEqual(q.groups[0].kde.coords);
    expect(body.x).toHaveLength(2 * 201 + 1);                           // two closed outlines and the gap between them
    expect(points.y).toEqual([...values, 2, 2, 2]);
    const st = q.groups[0].stats;
    expect([whisker.x, whisker.y]).toEqual([[0, 0, null], [st.whislo, st.whishi, null]]);
    expect(box.y).toEqual([st.q1, st.q3, null]);
    expect(box.line.width).toBeCloseTo(4 * whisker.line.width, 12);
    expect([dot.x, dot.y]).toEqual([[0], [st.med]]);                    // the group of one value has nothing inside
    expect(dot.marker.color).toMatch(/^rgba\(255, ?255, ?255, ?1\)$/);
    // The limits are the outline's: the data's range and the widest point, with matplotlib's margins.
    expect(f.layout.yaxis.range).toEqual([1 - 0.4, 9 + 0.4].map((v) => expect.closeTo(v, 9)));
    expect(f.layout.xaxis.range).toEqual([-0.4 - 0.09, 1.4 + 0.09].map((v) => expect.closeTo(v, 9)));
    // Quartile lines reach the outline; past the data the violin is longer.
    const lines = one([{ kind: 'violin', groups: [values], inner: 'quartiles', cut: 2 }]);
    expect(lines.data).toHaveLength(3);
    expect(lines.data[1].line.dash).not.toBe('solid');
    expect(lines.data[2].line.dash).toBe('solid');
    expect(lines.data[2].x[1]).toBeGreaterThan(0.1);
    expect(lines.data[2].x[1]).toBeLessThanOrEqual(0.4001);             // the density at the median, against the highest of the outline's 100 points
    expect(lines.layout.yaxis.range[1]).toBeGreaterThan(f.layout.yaxis.range[1]);
    expect(one([{ kind: 'violin', groups: [values], inner: 'none' }]).data).toHaveLength(1);
    // On a dark figure the marks are light and the dot takes the background.
    const dark = one([{ kind: 'violin', groups: [values] }], { background: '#0f172a', foreground: '#e2e8f0' });
    expect(dark.data[1].line.color).toBe('#e2e8f0');
    expect(dark.data[3].marker.color).toMatch(/^rgba\(15, ?23, ?42, ?1\)$/);
    expect(dark.info.notes).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Panels on a grid, shared axes, the gap, letters and insets
 * ------------------------------------------------------------------ */

describe('panel layout, as constrained layout makes it', () => {
  const W = 6.4 * 96; const H = 4.8 * 96; const PT = 96 / 72;
  const xs = Array.from({ length: 41 }, (_, i) => i / 4);
  const line = (k, o = {}) => ({ id: `s${k}`, kind: 'line', x: xs, y: xs.map((v) => Math.sin(v * k) * k), ...o });
  const build = (fig, options = {}) => buildFigure({ export: { tight: false }, ...fig }, options);
  const w = (b) => b.r - b.l; const h = (b) => b.b - b.t;
  // Every straight piece drawn as a shape on the page, in px from its top left: [x0, y0, x1, y1].
  const segments = (f) => f.layout.shapes.filter((q) => q.xref === 'paper').flatMap((q) => q.path.split('M').filter(Boolean).flatMap((piece) => {
    const closed = piece.endsWith('Z');
    const pts = piece.replace('Z', '').split('L').map((t) => t.split(',').map(Number)).filter((t) => t.length === 2 && t.every(Number.isFinite))
      .map(([fx, fy]) => [fx * f.layout.width, (1 - fy) * f.layout.height]);
    if (closed && pts.length) pts.push(pts[0]);
    return pts.slice(1).map((b, i) => [...pts[i], ...b]);
  }));
  const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
  const labels = (f, text) => f.layout.annotations.filter((a) => a.text === text).length;

  test('a grid: the columns and the rows line up, and share what is left at their ratios', () => {
    const f = build({ layout: { rows: 2, cols: 2 }, panels: [1, 2, 3, 4].map((k) => ({ yLabel: 'y', series: [line(k)] })) });
    const [a, b, c, d] = f.info.axes;
    expect(f.info.grid).toEqual({ rows: 2, cols: 2 });
    expect(f.info.cells).toEqual([[0, 0], [0, 1], [1, 0], [1, 1]].map(([row, col]) => ({ row, col, rowSpan: 1, colSpan: 1 })));
    for (const [p, q, side] of [[a, c, 'l'], [a, c, 'r'], [b, d, 'l'], [b, d, 'r'], [a, b, 't'], [a, b, 'b'], [c, d, 't'], [c, d, 'b']]) expect(p[side]).toBeCloseTo(q[side], 9);
    expect(w(a)).toBeCloseTo(w(b), 9);
    expect(h(a)).toBeCloseTo(h(c), 9);
    expect(b.l).toBeGreaterThan(a.r + 2 * 3 * PT);                      // the pads, and the y tick labels of the right column
    expect(c.t).toBeGreaterThan(a.b + 2 * 3 * PT);
    // Every panel has its own Plotly axes, in the order of the panels.
    expect(f.info.plotly).toEqual([{ x: 'x', y: 'y' }, { x: 'x2', y: 'y2' }, { x: 'x3', y: 'y3' }, { x: 'x4', y: 'y4' }]);
    expect(f.layout.xaxis4.domain[0]).toBeCloseTo(d.l / W, 9);
    expect(f.layout.yaxis4.domain[1]).toBeCloseTo(1 - d.t / H, 9);
    // Widths and heights at the grid's ratios.
    const r = build({ layout: { rows: 2, cols: 2, widthRatios: [2, 1], heightRatios: [1, 3] }, panels: [1, 2, 3, 4].map((k) => ({ series: [line(k)] })) }).info.axes;
    expect(w(r[0]) / w(r[1])).toBeCloseTo(2, 9);
    expect(h(r[2]) / h(r[0])).toBeCloseTo(3, 9);
    // A cell left empty keeps its place.
    const three = build({ layout: { rows: 2, cols: 2 }, panels: [1, 2, 3].map((k) => ({ series: [line(k)] })) });
    expect(three.info.axes).toHaveLength(3);
    expect(w(three.info.axes[2])).toBeCloseTo(w(three.info.axes[0]), 9);
  });

  test('a panel that spans cells reaches from the first to the last; panels spanning alike are alike', () => {
    const f = build({ layout: { cols: 2 }, panels: [{ colSpan: 2, series: [line(1)] }, { series: [line(2)] }, { series: [line(3)] }] });
    const [wide, l, r] = f.info.axes;
    expect(wide.l).toBeCloseTo(l.l, 9);
    expect(wide.r).toBeCloseTo(r.r, 9);
    expect(w(wide)).toBeGreaterThan(w(l) + w(r));
    const tall = build({ layout: { cols: 2 }, panels: [{ rowSpan: 2, series: [line(1)] }, { series: [line(2)] }, { series: [line(3)] }] }).info.axes;
    expect([tall[0].t, tall[0].b]).toEqual([expect.closeTo(tall[1].t, 9), expect.closeTo(tall[2].b, 9)]);
    // matplotlib's example: 'AAAB' over 'CCDD'. The margin inside C is made as wide as the one between
    // A and B, so that C and D come out the same width, to a pad or two (as matplotlib's do).
    const m = build({ layout: { cols: 4 }, panels: [{ colSpan: 3, series: [line(1)] }, { series: [line(2)] }, { colSpan: 2, series: [line(3)] }, { colSpan: 2, series: [line(4)] }] }).info.axes;
    expect(Math.abs(w(m[2]) - w(m[3]))).toBeLessThan(3 * 3 * PT);
    expect(m[2].r).toBeLessThan(m[3].l);
    expect(m[3].r).toBeCloseTo(m[1].r, 9);
    // matplotlib widens the margins inside a spanning panel by a pad for every axes that spans, a
    // twin included: a right axis on the wide panel moves the two under it 3 pt further apart each side.
    const fixed = { yLim: [0, 1], yTicks: { mode: 'list', values: [0.5] }, xLim: [0, 10], xTicks: { mode: 'list', values: [5] } };
    const under = (o) => build({ layout: { cols: 2 }, panels: [{ ...fixed, colSpan: 2, y2Lim: [0, 1], y2Ticks: { mode: 'list', values: [] }, series: [line(1), line(2, o)] }, { ...fixed, series: [line(3)] }, { ...fixed, series: [line(4)] }] }).info.axes;
    const one = under({}); const twin = under({ yAxis: 'right' });
    expect((twin[2].l - twin[1].r) - (one[2].l - one[1].r)).toBeCloseTo(2 * 3 * PT, 6);
  });

  test('shared axes: one range for the group, tick labels and axis labels on its outer panels', () => {
    const f = build({
      layout: { rows: 2, cols: 2 }, sharex: 'col', sharey: 'row', xLabel: 'Time (s)',
      panels: [{ yLabel: 'Top', series: [line(1)] }, { yLabel: 'Inner', series: [line(2, { x: xs.map((v) => v + 100) })] },
        { yLabel: 'Bottom', series: [line(3, { x: xs.map((v) => 2 * v) })] }, { series: [line(4)] }]
    });
    const L = f.layout;
    // Down a column the x range is the two panels' together; along a row the y range.
    expect(L.xaxis.range).toEqual(L.xaxis3.range);
    expect(L.xaxis.range[1]).toBeCloseTo(21, 9);
    expect(L.xaxis2.range).toEqual(L.xaxis4.range);
    expect(L.xaxis2.range[0]).toBeCloseTo(-5.5, 9);
    expect(L.yaxis.range).toEqual(L.yaxis2.range);
    expect(L.yaxis3.range).toEqual(L.yaxis4.range);
    expect(L.yaxis.range).not.toEqual(L.yaxis3.range);
    expect(f.info.share).toEqual([{ x: 0, y: 0, xLabels: false, yLabels: true }, { x: 1, y: 0, xLabels: false, yLabels: false },
      { x: 0, y: 2, xLabels: true, yLabels: true }, { x: 1, y: 2, xLabels: true, yLabels: false }]);
    // The x label under both bottom panels, the y labels on the left only; no tick label drawn twice.
    expect(labels(f, 'Time (s)')).toBe(2);
    expect([labels(f, 'Top'), labels(f, 'Bottom'), labels(f, 'Inner')]).toEqual([1, 1, 0]);
    expect(f.info.ticks[0].x.major.some((t) => t.text === '10')).toBe(true);
    expect(labels(f, '10')).toBe(1);                                    // under the lower left panel only
    expect(labels(f, '100')).toBe(1);                                   // under the lower right one
    // With nothing shared every panel has its own range and its own labels.
    const own = build({ layout: { rows: 2, cols: 2 }, xLabel: 'Time (s)', panels: [1, 2, 3, 4].map((k) => ({ series: [line(k, { x: xs.map((v) => v * k) })] })) });
    expect(new Set(['xaxis', 'xaxis2', 'xaxis3', 'xaxis4'].map((k) => own.layout[k].range[1])).size).toBe(4);
    expect(labels(own, 'Time (s)')).toBe(4);
    // Shared by all, a log scale and limits set on the first panel are everyone's.
    const all = build({ layout: { cols: 2 }, sharex: 'all', sharey: 'all', panels: [{ xScale: 'log', yLim: [-9, 9], series: [line(1, { x: xs.map((v) => v + 1) })] }, { series: [line(2, { x: xs.map((v) => v + 1) })] }] });
    expect([all.layout.xaxis2.type, all.layout.yaxis2.range]).toEqual(['log', [-9, 9]]);
  });

  test('the gap between panels: matplotlib\'s 6 pt unless set, plus what sticks out of them', () => {
    // Ticks that do not depend on the panels' heights, so that only the gap differs.
    const fig = (panelGap, o = {}) => build({ panelGap, sharex: 'none', panels: [0, 1].map(() => ({ yLim: [0, 1], yTicks: { mode: 'list', values: [0.5] }, xTicks: { mode: 'list', values: [5] }, series: [line(1)] })), ...o }).info.axes;
    const auto = fig(null);
    const gap = (a) => a[1].t - a[0].b;
    expect(fig({ h: 6 }).map((b) => [b.t, b.b])).toEqual(auto.map((b) => [expect.closeTo(b.t, 9), expect.closeTo(b.b, 9)]));
    expect(gap(fig({ h: 20 })) - gap(auto)).toBeCloseTo(14 * PT, 6);
    expect(gap(fig({ h: 2 })) - gap(auto)).toBeCloseTo(-4 * PT, 6);
    expect(gap(fig({ h: 0 })) - gap(auto)).toBeCloseTo(-6 * PT, 6);
    expect(gap(fig({ h: 0 }))).toBeGreaterThan(10);                     // the upper panel's x tick labels still need their room
    // The edge of the figure keeps its 3 pt whatever the gap.
    for (const g of [0, 2, 20]) {
      const a = fig({ h: g });
      expect([g, a[0].t, a[1].b]).toEqual([g, expect.closeTo(auto[0].t, 6), expect.closeTo(auto[1].b, 6)]);
    }
    // Between columns likewise.
    const cols = (panelGap) => build({ panelGap, layout: { cols: 2 }, panels: [0, 1].map(() => ({ yLim: [0, 1], yTicks: { mode: 'list', values: [0.5] }, xTicks: { mode: 'list', values: [5] }, series: [line(1)] })) }).info.axes;
    expect((cols({ w: 30 })[1].l - cols({ w: 30 })[0].r) - (cols(null)[1].l - cols(null)[0].r)).toBeCloseTo(24 * PT, 6);
    expect(cols({ w: 30 })[0].l).toBeCloseTo(cols(null)[0].l, 6);
    expect(cols({ h: 30 })).toEqual(cols(null).map((b) => ({ l: expect.closeTo(b.l, 9), r: expect.closeTo(b.r, 9), t: expect.closeTo(b.t, 9), b: expect.closeTo(b.b, 9) })));
  });

  test('a gap of 0: panels that share an axis share an edge, drawn once, with no tick label across it', () => {
    const fig = (o = {}) => build({ panelGap: { h: 0 }, xLabel: 'x', panels: [0, 1, 2].map(() => ({ yLabel: 'y', yLim: [-1, 1], series: [line(1)] })), ...o });
    const f = fig();
    const [a, b, c] = f.info.axes;
    expect(a.b).toBeCloseTo(b.t, 9);
    expect(b.b).toBeCloseTo(c.t, 9);
    expect(h(a)).toBeCloseTo(h(b), 9);
    expect(f.info.edges).toEqual([{ top: false, bottom: true, left: false, right: false }, { top: true, bottom: true, left: false, right: false }, { top: true, bottom: false, left: false, right: false }]);
    // The labels at −1 and 1 would reach across the shared edges: one of each is left, at the outside.
    const hidden = f.info.hiddenLabels.map((x) => [x.panel, x.axis, x.v]);
    expect(hidden).toEqual([[0, 'y', -1], [1, 'y', -1], [1, 'y', 1], [2, 'y', 1]]);
    expect([labels(f, '1.0'), labels(f, '−1.0'), labels(f, '0.0')]).toEqual([1, 1, 3]);
    // One line along each shared edge, the lower panel's; the upper panel's tick marks, pointing out, are gone.
    const seg = segments(f);
    const along = (y) => seg.filter(([x0, y0, x1, y1]) => near(y0, y) && near(y1, y) && Math.abs(x1 - x0) > w(a) - 1);
    expect([along(a.b).length, along(b.b).length, along(c.b).length, along(a.t).length]).toEqual([1, 1, 1, 1]);
    const marksBelow = (y) => seg.filter(([x0, y0, x1, y1]) => near(x0, x1) && near(Math.min(y0, y1), y) && Math.abs(y1 - y0) < 10 && Math.abs(y1 - y0) > 1);
    expect([marksBelow(a.b).length, marksBelow(b.b).length]).toEqual([0, 0]);
    expect(marksBelow(c.b).length).toBe(f.info.ticks[2].x.major.length);
    // Pointing in, the marks stay on both sides of the line; the frame's top line is the edge even when the frame has none.
    const inward = fig({ xTicks: { direction: 'in', mirror: true }, spines: { top: false, right: false } });
    const s2 = segments(inward);
    const [ia, ib] = inward.info.axes;
    const at = (y, up) => s2.filter(([x0, y0, x1, y1]) => near(x0, x1) && near(up ? Math.max(y0, y1) : Math.min(y0, y1), y) && Math.abs(y1 - y0) < 10 && Math.abs(y1 - y0) > 1).length;
    expect([at(ia.b, true), at(ib.t, false)]).toEqual([inward.info.ticks[0].x.major.length, inward.info.ticks[1].x.major.length]);
    expect(s2.filter(([x0, y0, x1, y1]) => near(y0, ia.b) && near(y1, ia.b) && Math.abs(x1 - x0) > w(ia) - 1)).toHaveLength(1);
    expect(s2.filter(([x0, y0, x1, y1]) => near(y0, ia.t) && near(y1, ia.t) && Math.abs(x1 - x0) > w(ia) - 1)).toHaveLength(0);
    // Without the shared axis there is no shared edge: the labels need their room.
    const apart = fig({ sharex: 'none' });
    expect(apart.info.edges).toEqual([null, null, null]);
    expect(apart.info.hiddenLabels).toEqual([]);
    expect(apart.info.axes[1].t - apart.info.axes[0].b).toBeGreaterThan(10);
    // Side by side, sharing y: the same between columns, with the x labels at the edge left out.
    const row = build({ panelGap: 0, layout: { cols: 2 }, sharey: 'row', panels: [0, 1].map(() => ({ xLim: [0, 10], series: [line(1)] })) });
    expect(row.info.axes[0].r).toBeCloseTo(row.info.axes[1].l, 9);
    expect(row.info.hiddenLabels.map((x) => [x.panel, x.axis, x.v])).toEqual([[0, 'x', 10], [1, 'x', 0]]);
    expect([labels(row, '0'), labels(row, '10')]).toEqual([1, 1]);
  });

  test('panel letters: at the top left corner, inside or outside, and counted in the margins', () => {
    const fig = (panelLabels, o = {}) => build({ layout: { cols: 2 }, fontSize: 12, panelLabels, panels: [1, 2].map((k) => ({ series: [line(k)] })), ...o });
    const f = fig({ show: true });
    expect(f.info.letters.map((l) => l.text)).toEqual(['(a)', '(b)']);
    expect(labels(f, '<b>(a)</b>')).toBe(1);
    f.info.letters.forEach((l, i) => {
      const box = f.info.axes[i];
      expect(l.l).toBeCloseTo(box.l + 6 * PT, 6);                      // half a font size in and down
      expect(l.t).toBeCloseTo(box.t + 6 * PT, 6);
    });
    expect(f.info.axes).toEqual(fig({ show: false }).info.axes);        // inside, they take no room
    expect(fig({ show: false }).info.letters).toEqual([null, null]);
    const out = fig({ show: true, position: 'outside', style: 'A', bold: false, fontSize: 16 });
    expect(labels(out, 'A')).toBe(1);
    out.info.letters.forEach((l, i) => {
      const box = out.info.axes[i];
      expect(l.r).toBeCloseTo(box.l - 3 * PT, 6);
      expect(l.b).toBeCloseTo(box.t - 6 * PT, 6);
      expect(l.t).toBeGreaterThan(3);                                   // on the page, under its 3 pt edge
    });
    expect(out.info.axes[0].t - fig({ show: false }).info.axes[0].t).toBeGreaterThan(16);
    // A panel's own text; an empty one for none.
    const own = build({ panelLabels: { show: true }, panels: [{ letter: 'Control', series: [line(1)] }, { letter: '', series: [line(2)] }] });
    expect(own.info.letters.map((l) => l && l.text)).toEqual(['Control', null]);
  });

  test('an inset: its share of its parent, over it, taking no room', () => {
    const main = { id: 'main', series: [line(1)] };
    const zoom = { id: 'zoom', inset: { parent: 'main', x: 0.5, y: 0.55, w: 0.45, h: 0.4, zoom: true }, xLim: [2, 4], yLim: [0, 0.5], series: [line(1, { id: 'again' })] };
    const f = build({ panels: [main, zoom] });
    const alone = build({ panels: [main] });
    const [p, i] = f.info.axes;
    expect(p).toEqual(alone.info.axes[0]);
    expect(i.l).toBeCloseTo(p.l + 0.5 * w(p), 9);
    expect(i.b).toBeCloseTo(p.b - 0.55 * h(p), 9);
    expect([w(i) / w(p), h(i) / h(p)]).toEqual([expect.closeTo(0.45, 9), expect.closeTo(0.4, 9)]);
    expect(f.info.insets).toEqual([-1, 0]);
    expect(f.info.cells[1]).toBeNull();
    expect([f.layout.xaxis2.range, f.layout.yaxis2.range]).toEqual([[2, 4], [0, 0.5]]);
    // Its background lies on its own axes, over the parent's line and under its own.
    const ground = f.layout.shapes.filter((q) => q.xref === 'x2' && q.yref === 'y2');
    expect(ground).toHaveLength(1);
    expect(ground[0]).toMatchObject({ layer: 'below', fillcolor: '#ffffff', path: 'M2,0L4,0L4,0.5L2,0.5Z' });
    expect(build({ panels: [main, zoom] }, { transparent: true }).layout.shapes.filter((q) => q.xref === 'x2')).toHaveLength(0);
    // The box of its limits on the parent, and the two lines matplotlib joins: here the box lies left of and
    // below the inset, so its upper left and lower right corners go to the inset's.
    const mark = f.layout.shapes.find((q) => /0\.5\)$/.test(q.line.color));
    const view = alone.info.views[0];
    const X = (v) => p.l + ((v - view.x.view[0]) / (view.x.view[1] - view.x.view[0])) * w(p);
    const Y = (v) => p.b - ((v - view.y.view[0]) / (view.y.view[1] - view.y.view[0])) * h(p);
    const pieces = segments({ layout: { ...f.layout, shapes: [mark] } });
    const has = (x0, y0, x1, y1) => pieces.some((q) => (near(q[0], x0) && near(q[1], y0) && near(q[2], x1) && near(q[3], y1)) || (near(q[0], x1) && near(q[1], y1) && near(q[2], x0) && near(q[3], y0)));
    expect(pieces).toHaveLength(6);
    expect(has(X(2), Y(0), X(4), Y(0)) && has(X(4), Y(0), X(4), Y(0.5)) && has(X(2), Y(0.5), X(4), Y(0.5)) && has(X(2), Y(0), X(2), Y(0.5))).toBe(true);
    expect(has(i.l, i.t, X(2), Y(0.5))).toBe(true);
    expect(has(i.r, i.b, X(4), Y(0))).toBe(true);
    // A box that reaches above the inset's top is joined by its two right-hand corners instead.
    const high = build({ panels: [main, { ...zoom, yLim: [0, 1] }] });
    const lines = segments({ layout: { ...high.layout, shapes: [high.layout.shapes.find((q) => /0\.5\)$/.test(q.line.color))] } });
    const joins = (x0, y0, x1, y1) => lines.some((q) => near(q[0], x0) && near(q[1], y0) && near(q[2], x1) && near(q[3], y1));
    expect([joins(i.r, i.t, X(4), Y(1)), joins(i.r, i.b, X(4), Y(0)), joins(i.l, i.t, X(2), Y(1))]).toEqual([true, true, false]);
    expect(build({ panels: [main, { ...zoom, inset: { ...zoom.inset, zoom: false } }] }).layout.shapes.some((q) => /0\.5\)$/.test(q.line.color))).toBe(false);
    // The tight page is the parent's: the inset is left out of it, as of the layout.
    const tight = buildFigure({ panels: [main, zoom] }); const tightAlone = buildFigure({ panels: [main] });
    expect([tight.info.widthPx, tight.info.heightPx]).toEqual([tightAlone.info.widthPx, tightAlone.info.heightPx]);
    // An inset first in the description is still drawn last, over its parent.
    const first = build({ panels: [zoom, main] });
    expect(first.info.plotly).toEqual([{ x: 'x2', y: 'y2' }, { x: 'x', y: 'y' }]);
    expect(first.info.insets).toEqual([1, -1]);
    expect(first.layout.xaxis2.range).toEqual([2, 4]);
    // The grid of an inset is drawn on its own axes too, over the parent's.
    const gridded = build({ grid: { show: true }, panels: [main, zoom] });
    expect(gridded.layout.shapes.filter((q) => q.xref === 'x2' && q.fillcolor === 'rgba(0,0,0,0)')).toHaveLength(1);
  });

  test('colour bars on a grid: each beside its panel, in the room of its column', () => {
    const heat = (o = {}) => ({ kind: 'heatmap', x: [1, 2, 3, 4], y: [0, 1, 2], z: [[1, 2, 3, 4], [4, 5, 6, 7], [7, 8, 9, 12]], colorbar: { label: 'Z' }, ...o });
    const f = build({ layout: { cols: 2 }, panels: [{ series: [heat()] }, { series: [line(2)] }, { series: [line(3)] }, { series: [heat({ colormap: 'magma' })] }] });
    const [a, b, c, d] = f.info.axes; const [ca, cb, cc, cd] = f.info.colorbars;
    expect([cb, cc]).toEqual([null, null]);
    // 5% of the panel's width beyond whatever sticks out of the panels of its column on that side.
    expect(ca.l - a.r).toBeGreaterThanOrEqual(0.05 * w(a) - 1e-9);
    expect(ca.l - a.r).toBeLessThan(0.05 * w(a) + 12);
    expect(ca.r).toBeLessThan(b.l);
    expect(cd.l - d.r).toBeGreaterThanOrEqual(0.05 * w(d) - 1e-9);
    expect(cd.r).toBeLessThan(W);
    expect([ca.t, ca.b]).toEqual([expect.closeTo(a.t, 6), expect.closeTo(a.b, 6)]);
    // The panels of a column are as wide as each other, with or without a bar.
    expect(w(a)).toBeCloseTo(w(c), 9);
    expect(w(b)).toBeCloseTo(w(d), 9);
    expect(w(a)).toBeCloseTo(w(b), 9);
    expect(f.info.notes).toEqual([]);
  });

  test('a legend larger than its panel sticks out of it, and the layout makes room, as for any decoration', () => {
    // Six short panels, three of them with a legend of two entries, taller than the panel.
    const fig = (legend) => build({ height: 3, legend, panels: [0, 1, 2, 3, 4, 5].map((k) => ({ series: k % 2 ? [line(1)] : [line(1, { label: 'One' }), line(2, { label: 'Two' })] })) });
    const f = fig({ position: 'upper right' });
    const a = f.info.axes;
    const boxes = f.info.legendLayouts.map((g) => g && g.box);
    expect(boxes.map(Boolean)).toEqual([true, false, true, false, true, false]);
    expect(boxes[0].b - boxes[0].t).toBeGreaterThan(h(a[0]));
    // The legend hangs from the top of its panel past its bottom; the next panel starts under it.
    expect(boxes[0].t).toBeGreaterThan(a[0].t);
    expect(a[1].t).toBeGreaterThanOrEqual(boxes[0].b + 3 * PT - 1e-6);
    expect(a[1].t - a[0].b).toBeGreaterThan(a[2].t - a[1].b + 5);
    // Without legends the panels are evenly apart, and taller.
    const plain = fig({ show: false }).info.axes;
    expect(plain[1].t - plain[0].b).toBeCloseTo(plain[2].t - plain[1].b, 1);
    expect(h(plain[0])).toBeGreaterThan(h(a[0]) + 5);
    // A legend that fits changes nothing.
    const roomy = (legend) => build({ legend, panels: [{ series: [line(1, { label: 'One' })] }, { series: [line(2)] }] }).info.axes;
    expect(roomy({ position: 'upper right' })).toEqual(roomy({ show: false }));
  });

  test('the title of a grid is the figure\'s, centred over all of it; of one column, the top panel\'s', () => {
    const f = build({ title: 'Four runs', layout: { cols: 2 }, panels: [1, 2].map((k) => ({ series: [line(k)] })) });
    const t = f.info.title;
    expect((t.l + t.r) / 2).toBeCloseTo(W / 2, 6);
    expect(t.t).toBeCloseTo(3 * PT, 6);
    expect(f.info.axes[0].t).toBeGreaterThanOrEqual(t.b + 2 * 3 * PT - 1e-9);                // two pads under it, then the panels' own
    expect(labels(f, 'Four runs')).toBe(1);
    const column = build({ title: 'Two runs', panels: [1, 2].map((k) => ({ series: [line(k)] })) });
    expect(column.info.title).toBeNull();
    const at = column.layout.annotations.find((a) => a.text === 'Two runs');
    expect(Math.abs(at.x * W - (column.info.axes[0].l + column.info.axes[0].r) / 2)).toBeLessThan(1);
  });
});
