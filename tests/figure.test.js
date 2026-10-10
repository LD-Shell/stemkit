/**
 * The figure description (src/core/figure.js): normalising, the person's
 * style laid over the page's description, and the numbers each kind works
 * out as numpy and matplotlib do (box statistics, histogram bins, colormap
 * lookups). REF holds matplotlib's and numpy's own answers, the same from
 * matplotlib 3.6.3 with numpy 1.26 and from 3.11.2 with numpy 2.5.
 */
import { describe, test, expect } from '@jest/globals';
import {
  normaliseFigure, applyStyle, cleanStyle, defaultFigure, boxStats, histogram, linspace, colormapColors, colormapIndex,
  colormapColor, colorCycle, COLOR_CYCLE, COLOR_CYCLE_DARK, COLORMAPS, SERIES_KINDS, jitterOffsets, unitsPerInch, formatSize,
  BACKGROUNDS, withBackground, backgroundChoice, readableInk, hasAxis, SECONDARY_KINDS, LOOK_KEYS,
  histogramBinEdges, histogramHeights, BIN_RULES, gaussianKde, kdeBandwidth, violinStats, groupMeans, legendOrder, barData, lookOnly, numpySum,
  panelLetters, panelEdges, layoutPads, isStack, titledPanel, SHARE_X, SHARE_Y, PANEL_LABEL_STYLES, MAX_PANELS
} from '../src/core/figure.js';
import { defaultPlotStyle, normalisePlotStyle, textSizes } from '../src/core/plot-style.js';

const REF = {
  box: { values: [3.1, 4.5, 2.2, 8.9, 5.5, 4.4, 4.0, 3.3, 21.0, 4.8, 5.1], q1: 3.65, med: 4.5, q3: 5.3, whislo: 2.2, whishi: 5.5, fliers: [8.9, 21.0], mean: 6.072727272727272 },
  hist: {
    values: [3.769563, -4.044631, 1.010768, -0.665208, -0.469504, -0.066515, -3.133976, -0.094285, -1.170862, 5.949099, 0.683837, -0.299472, -0.178189, -0.835679, -1.493756, -0.364362, 1.119307, -0.105541, 1.92819, -0.039664, 0.341241, 2.927895, 1.226679, -0.558889, -0.010826, 1.218893, 3.58965, -0.158355, -0.11405, 2.003933, -1.206982, -0.195924, 1.800316, 1.286595, 0.455578, 1.439177, -4.507876, 2.036222, -1.331396, -2.536654, 0.769958, 1.490926, -0.456105, -1.52989, 0.344412, 0.21033, 2.689517, 1.570594, 0.629487, 2.189776, -0.049389, -1.274029, 1.292899, 1.290315, -0.065209, -1.030775, 0.689562],
    counts: [2, 2, 7, 18, 15, 8, 3, 1, 1],
    edges: [-4.507876, -3.345989888888889, -2.184103777777778, -1.0222176666666671, 0.13966844444444426, 1.3015545555555557, 2.463440666666666, 3.6253267777777785, 4.787212888888889, 5.949099],
    density: { edges: [-4, -1, 0, 0.5, 2, 5], counts: [0.05555555555555555, 0.3333333333333333, 0.14814814814814814, 0.19753086419753085, 0.04320987654320988] }
  },
  // viridis through Normalize(1.5, 7.25), as matplotlib.colors.to_hex gives it
  cmap: [[1.5, '#440154'], [1.52, '#440154'], [3.3, '#33638d'], [7.2499, '#fde725'], [7.25, '#fde725'], [9.0, '#fde725'], [0.0, '#440154']],
  // numpy.histogram_bin_edges(hist.values, bins=rule): the number of bins of each rule, and 'fd' in full
  rules: { auto: 12, fd: 12, sturges: 7, sqrt: 8, scott: 7, rice: 8, doane: 8 },
  fd: { counts: [2, 1, 1, 7, 10, 15, 11, 5, 2, 2, 0, 1], edge1: -3.636461416666667 },
  // The same rules on data with little in it: values all alike, one value, two, three; and values with no
  // spread between their quartiles, where 'auto' is numpy 2.3's rule (seven bins; numpy before 2.3 made five)
  awkward: [
    { values: [1, 1, 1, 1, 1, 1, 1, 1, 2, 10], edges: { auto: [1.0, 2.2857142857142856, 3.5714285714285716, 4.857142857142858, 6.142857142857143, 7.428571428571429, 8.714285714285715, 10.0], fd: [1.0, 10.0], sturges: [1.0, 2.8, 4.6, 6.4, 8.2, 10.0], sqrt: [1.0, 3.25, 5.5, 7.75, 10.0], scott: [1.0, 4.0, 7.0, 10.0], rice: [1.0, 2.8, 4.6, 6.4, 8.2, 10.0], doane: [1.0, 2.2857142857142856, 3.5714285714285716, 4.857142857142858, 6.142857142857143, 7.428571428571429, 8.714285714285715, 10.0] } },
    { values: [2.5, 2.5, 2.5, 2.5], edges: { auto: [2, 3], fd: [2, 3], sturges: [2, 3], sqrt: [2, 3], scott: [2, 3], rice: [2, 3], doane: [2, 3] } },
    { values: [7], edges: { auto: [6.5, 7.5], fd: [6.5, 7.5], sturges: [6.5, 7.5], sqrt: [6.5, 7.5], scott: [6.5, 7.5], rice: [6.5, 7.5], doane: [6.5, 7.5] } },
    { values: [1, 2], edges: { auto: [1, 1.5, 2], fd: [1, 1.5, 2], sturges: [1, 1.5, 2], sqrt: [1, 1.5, 2], scott: [1, 2], rice: [1, 1.3333333333333333, 1.6666666666666665, 2], doane: [1, 2] } },
    { values: [1, 2, 4], edges: { auto: [1, 2, 3, 4], fd: [1, 2.5, 4], sturges: [1, 2, 3, 4], sqrt: [1, 2.5, 4], scott: [1, 4], rice: [1, 2, 3, 4], doane: [1, 1.75, 2.5, 3.25, 4] } }
  ],
  // scipy.stats.gaussian_kde(hist.values, bw_method): sqrt(covariance) and the density at -2, 0, 1.5, the smallest and the largest value
  kde: {
    scott: { bw: 0.7964973355455699, at: [0.06964707599828518, 0.2442636275351568, 0.1736976872276028, 0.018627468587294544, 0.009113244602019784] },
    silverman: { bw: 0.8436689671417232, at: [0.07250511524582416, 0.23952050295574656, 0.17265188004795368, 0.018228123696597938, 0.008776197746169221] }
  },
  // cbook.boxplot_stats(box.values, whis=(low, high)): whiskers and fliers; and the notch of the default
  whis: [
    { whis: [5, 95], whislo: 3.1, whishi: 8.9, fliers: [2.2, 21.0] }, { whis: [10, 90], whislo: 3.1, whishi: 8.9, fliers: [2.2, 21.0] },
    { whis: [0, 100], whislo: 2.2, whishi: 21.0, fliers: [] }, { whis: [25, 75], whislo: 3.65, whishi: 5.3, fliers: [2.2, 3.1, 3.3, 5.5, 8.9, 21.0] }
  ],
  notch: [3.718934861871303, 5.281065138128697],
  // Three groups of replicates: numpy's mean and std(ddof=1), the standard error, and scipy's t interval at 95%
  groups: { values: [[4.1, 5.2, 6.3, 5.5], [2.0, 2.5], [9.0]], mean: [5.275, 2.25, 9.0], sd: [0.9105858919765157, 0.3535533905932738, NaN],
    sem: [0.45529294598825787, 0.25, NaN], ci: [1.4489453537823187, 3.1765511841080234, NaN] }
};

describe('normaliseFigure', () => {
  test('an empty description is one empty panel with plot-style\'s look', () => {
    const f = normaliseFigure({});
    const s = defaultPlotStyle();
    expect(f.panels).toHaveLength(1);
    expect(f.panels[0].series).toEqual([]);
    for (const k of ['width', 'height', 'dpi', 'fontFamily', 'fontSize', 'background', 'foreground']) expect(f[k]).toBe(s[k]);
    expect(f.xTicks).toEqual(s.xTicks);
    expect(f.grid).toEqual(s.grid);
    expect(normaliseFigure(defaultFigure())).toEqual(f);
  });

  test('keeps numbers in range and falls back on unknown values', () => {
    const f = normaliseFigure({ width: 99, fontSize: 'big', xScale: 'weird', legend: { position: 'nowhere', columns: 40 }, colormap: 'rainbow',
      panels: [{ yLim: ['1', 'x'], series: [{ kind: 'nonsense', x: [1], y: [2] }, { kind: 'line', lineStyle: 'wavy', lineWidth: -3 }] }] });
    expect(f.width).toBe(30);
    expect(f.fontSize).toBe(11);
    expect(f.xScale).toBe('linear');
    expect(f.legend.position).toBe('best');
    expect(f.legend.columns).toBe(10);
    expect(f.colormap).toBe('viridis');
    expect(f.panels[0].yLim).toEqual([1, null]);
    expect(f.panels[0].series.map((q) => q.kind)).toEqual(['line', 'line']);
    expect(f.panels[0].series[1]).toMatchObject({ lineStyle: 'solid', lineWidth: 0 });
  });

  test('series take the colour cycle in order, unless they have a colour; lines and notes take the foreground', () => {
    const f = normaliseFigure({ panels: [{ series: [{ kind: 'line' }, { kind: 'scatter', color: '#ABC' }, { kind: 'bar' }, { kind: 'hline' }, { kind: 'text', text: 'a' }, { kind: 'band' }] }] });
    expect(f.panels[0].series.map((q) => q.color)).toEqual([COLOR_CYCLE[0], '#aabbcc', COLOR_CYCLE[1], f.foreground, f.foreground, COLOR_CYCLE[2]]);
    const dark = normaliseFigure({ background: '#101418', foreground: '#eeeeee', panels: [{ series: [{ kind: 'line' }] }] });
    expect(dark.panels[0].series[0].color).toBe(COLOR_CYCLE_DARK[0]);
    expect(colorCycle('#ffffff')).toBe(COLOR_CYCLE);
  });

  test('series ids are unique, and stable when given', () => {
    const f = normaliseFigure({ panels: [{ series: [{ id: 'a', kind: 'line' }, { id: 'a', kind: 'line' }, { kind: 'scatter' }] }, { series: [{ kind: 'scatter' }] }] });
    expect(f.panels.flatMap((p) => p.series.map((q) => q.id))).toEqual(['a', 'a_', 'scatter3', 'scatter1']);
  });

  test('data fields keep where the script finds them, also when normalised again', () => {
    const f = normaliseFigure({ panels: [{ series: [
      { kind: 'line', x: { values: [1, 2], source: 'colvar', column: 'time' }, y: { values: [3, '4'], name: 'cv1' } },
      { kind: 'box', groups: [{ values: { values: [1, 2, 3], name: 'first' } }] }
    ] }] });
    const [line, box] = f.panels[0].series;
    expect(line.x).toEqual([1, 2]);
    expect(line.y).toEqual([3, 4]);
    expect(line.refs).toEqual({ x: { source: 'colvar', column: 'time' }, y: { name: 'cv1' } });
    const again = normaliseFigure(f);
    expect(again.panels[0].series[0].refs).toEqual(line.refs);
    expect(again.panels[0].series[1].groups[0].ref).toEqual({ name: 'first' });
    expect(box.groups[0].stats.med).toBe(2);
  });

  test('bars that share positions stand side by side within the width', () => {
    const f = normaliseFigure({ xCategories: ['a', 'b'], panels: [{ series: [{ kind: 'bar', y: [1, 2] }, { kind: 'bar', y: [2, 3] }, { kind: 'bar', y: [1, 1], width: 0.6 }] }] });
    const bars = f.panels[0].series;
    expect(bars[0].x).toEqual([0, 1]);
    expect(bars.map((b) => +b.barWidth.toFixed(6))).toEqual([0.266667, 0.266667, 0.2]);
    expect(bars.map((b) => +b.offset.toFixed(6))).toEqual([-0.266667, 0, 0.2]);
  });

  test('every kind normalises', () => {
    for (const kind of SERIES_KINDS) {
      const f = normaliseFigure({ panels: [{ series: [{ kind, x: [1, 2], y: [1, 2], z: [[1, 2], [3, 4]], values: [1, 2, 3], groups: [[1, 2, 3]], lower: [0, 1], upper: [2, 3] }] }] });
      expect(f.panels[0].series[0].kind).toBe(kind);
    }
  });
});

describe('the person\'s style over the page\'s description', () => {
  const page = {
    title: 'Run', xLabel: 'Time (ps)',
    panels: [{ yLabel: 'CV', series: [{ id: 'cv', kind: 'line', x: [0, 1], y: [1, 2], label: 'CV' }] }, { yLabel: 'Bias', series: [{ id: 'bias', kind: 'line', x: [0, 1], y: [0, 3] }] }]
  };

  test('named fields win; everything else is the page\'s', () => {
    const style = { width: 3.5, xTicks: { direction: 'in' }, panels: [{}, { yLabel: 'Bias (kJ/mol)', yLim: [0, null] }], series: { cv: { color: '#ff0000', lineWidth: 3 } } };
    const f = normaliseFigure(applyStyle(page, style));
    expect(f.width).toBe(3.5);
    expect(f.xTicks.direction).toBe('in');
    expect(f.xTicks.length).toBe(3.5);
    expect(f.title).toBe('Run');
    expect(f.panels[1].yLabel).toBe('Bias (kJ/mol)');
    expect(f.panels[1].yLim).toEqual([0, null]);
    expect(f.panels[0].series[0]).toMatchObject({ color: '#ff0000', lineWidth: 3, label: 'CV', x: [0, 1] });
    // New data from the page keep the style.
    const next = normaliseFigure(applyStyle({ ...page, panels: [{ ...page.panels[0], series: [{ ...page.panels[0].series[0], y: [5, 6] }] }, page.panels[1]] }, style));
    expect(next.panels[0].series[0]).toMatchObject({ color: '#ff0000', y: [5, 6] });
  });

  test('a stored style carries only the look', () => {
    const clean = cleanStyle({ width: 4, panels: [{ yLabel: 'y', series: [1] }], series: { cv: { color: '#000000', x: [9] }, other: { y: [1] } }, data: [1] });
    expect(clean).toEqual({ width: 4, panels: [{ yLabel: 'y' }], series: { cv: { color: '#000000' } } });
    expect(applyStyle(page, {})).toEqual(page);
  });
});

describe('numbers as matplotlib and numpy work them out', () => {
  test('box statistics: cbook.boxplot_stats', () => {
    const b = boxStats(REF.box.values);
    for (const k of ['q1', 'med', 'q3', 'whislo', 'whishi', 'mean']) expect(b[k]).toBeCloseTo(REF.box[k], 12);
    expect(b.fliers.sort((p, q) => p - q)).toEqual(REF.box.fliers);
    expect(boxStats([NaN, 2, null, 4]).n).toBe(2);
    expect(boxStats([])).toBeNull();
  });

  test('the mean\'s interval: Student\'s t', () => {
    const b = boxStats([1, 2, 3, 4, 5], { level: 0.95 });
    // scipy.stats.t.ppf(0.975, 4) = 2.7764451051977987; sd = 1.5811388300841898
    expect(b.ciHigh - b.mean).toBeCloseTo(2.7764451051977987 * 1.5811388300841898 / Math.sqrt(5), 10);
    expect(Number.isNaN(boxStats([2]).ciLow)).toBe(true);
  });

  test('histogram: numpy.histogram, equal bins and given edges, counts and density', () => {
    const h = histogram(REF.hist.values, 9);
    expect(h.counts).toEqual(REF.hist.counts);
    h.edges.forEach((e, i) => expect(e).toBe(REF.hist.edges[i]));
    const d = histogram(REF.hist.values, REF.hist.density.edges, { density: true });
    d.counts.forEach((c, i) => expect(c).toBeCloseTo(REF.hist.density.counts[i], 14));
    expect(histogram([2, 2, 2], 4).edges).toEqual(linspace(1.5, 2.5, 5));
    expect(histogram([0, 1, 1, 2], [0, 1, 2]).counts).toEqual([1, 3]);   // the last bin is closed
  });

  test('colormaps: matplotlib\'s lookup tables and its Normalize', () => {
    for (const [v, want] of REF.cmap) expect(colormapColor('viridis', v, 1.5, 7.25)).toBe(want);
    expect(colormapIndex(NaN, 0, 1)).toBe(-1);
    for (const name of COLORMAPS) {
      const lut = colormapColors(name);
      expect(lut).toHaveLength(256);
      lut.forEach((c) => expect(c).toMatch(/^#[0-9a-f]{6}$/));
    }
    expect(colormapColors('Greys')[0]).toBe('#ffffff');
    expect(colormapColors('nope')).toBe(colormapColors('viridis'));
  });

  test('jitter: evenly spread, the same every time', () => {
    const j = jitterOffsets(50, 0.2);
    expect(j).toEqual(jitterOffsets(50, 0.2));
    j.forEach((v) => { expect(v).toBeGreaterThanOrEqual(-0.1); expect(v).toBeLessThan(0.1); });
  });
});

describe('size units, grid along one axis, text sizes', () => {
  test('new look fields default to what figures had before', () => {
    const f = normaliseFigure({});
    expect([f.sizeUnit, f.titleSize, f.tickSize, f.grid.axis]).toEqual(['in', null, null, 'both']);
    const s = normalisePlotStyle({});
    expect([s.titleSize, s.tickSize, s.grid.axis]).toEqual([null, null, 'both']);
    expect(textSizes(s)).toEqual({ title: 12, tick: 10 });
  });

  test('an old stored style is still valid, and unknown values fall back', () => {
    const old = { width: 5, grid: { show: true, color: '#ff0000' }, fontSize: 9 };
    const s = normalisePlotStyle(old);
    expect([s.width, s.grid.show, s.grid.color, s.grid.axis, s.titleSize]).toEqual([5, true, '#ff0000', 'both', null]);
    const f = normaliseFigure({ sizeUnit: 'furlong', titleSize: 'big', tickSize: 200, grid: { axis: 'z' } });
    expect([f.sizeUnit, f.titleSize, f.tickSize, f.grid.axis]).toEqual(['in', null, 60, 'both']);
    expect(textSizes({ fontSize: 9, titleSize: 20, tickSize: null })).toEqual({ title: 20, tick: 8 });
  });

  test('sizes are kept in inches and written in the unit chosen', () => {
    expect(unitsPerInch('mm')).toBe(25.4);
    expect(unitsPerInch('px', 150)).toBe(150);
    expect(formatSize(85 / 25.4, 'mm')).toBe('85 mm');
    expect(formatSize(6.4, 'px', 300)).toBe('1920 px');
    expect(formatSize(6.52, 'in')).toBe('6.52 in');
    expect(formatSize(3.5, 'cm')).toBe('8.89 cm');
  });

  test('notes and brackets take the tick size', () => {
    const f = normaliseFigure({ tickSize: 7, panels: [{ series: [{ kind: 'text', text: 'a' }, { kind: 'bracket' }] }] });
    expect(f.panels[0].series.map((q) => q.fontSize)).toEqual([7, 7]);
  });
});

describe('series ids of any spelling', () => {
  test('dots and spaces in ids: the style finds them, the script names them', async () => {
    const page = { panels: [{ series: [{ id: 'trace-m3.rbias', kind: 'line', x: [0, 1], y: [0, 1] }, { id: 'my series 2', kind: 'scatter', x: [0], y: [1], label: 'p' }] }] };
    const style = cleanStyle({ series: { 'trace-m3.rbias': { color: '#aa3377' }, 'my series 2': { size: 9 } } });
    const f = normaliseFigure(applyStyle(page, style));
    expect(f.panels[0].series.map((q) => q.id)).toEqual(['trace-m3.rbias', 'my series 2']);
    expect(f.panels[0].series[0].color).toBe('#aa3377');
    expect(f.panels[0].series[1].size).toBe(9);
    const { figureScript } = await import('../src/core/figure-python.js');
    const code = figureScript(f);
    expect(code).toContain('trace_m3_rbias_x = np.array');
    expect(code).toMatch(/^my_series_2, = ax\.plot\(/m);
  });
});

describe('the background picker: white, transparent, dark, custom', () => {
  const page = { panels: [{ series: [
    { id: 'cycled', kind: 'line', x: [0, 1], y: [0, 1] },
    { id: 'blue', kind: 'scatter', x: [0], y: [0], color: COLOR_CYCLE[0], edgeColor: COLOR_CYCLE[0] },
    { id: 'own', kind: 'line', x: [0], y: [0], color: '#123456' }
  ] }] };
  const look = (style) => {
    const f = normaliseFigure(applyStyle(page, style));
    return { background: f.background, foreground: f.foreground, grid: f.grid.color, transparent: f.export.transparent,
      colours: f.panels[0].series.map((q) => [q.color, q.edgeColor]) };
  };

  test('each choice gives its look, whatever came before', () => {
    const white = look({});
    for (const before of [{}, withBackground({}, page, 'dark'), withBackground({}, page, 'transparent', { ink: 'light' }), withBackground({}, page, 'custom', { background: '#334455' })]) {
      const dark = look(withBackground(before, page, 'dark'));
      expect(dark).toMatchObject({ background: BACKGROUNDS.dark.background, foreground: BACKGROUNDS.dark.foreground, grid: BACKGROUNDS.dark.grid, transparent: false });
      // A series left to the cycle follows the ground; one of the cycle's colours moves to the same hue; one's own stays.
      expect(dark.colours[0][0]).toBe(COLOR_CYCLE_DARK[0]);
      expect(dark.colours[1]).toEqual([COLOR_CYCLE_DARK[0], COLOR_CYCLE_DARK[0]]);
      expect(dark.colours[2][0]).toBe('#123456');
      expect(look(withBackground(before, page, 'white'))).toEqual(white);
      const clear = look(withBackground(before, page, 'transparent', { ink: 'dark' }));
      expect(clear).toMatchObject({ background: '#ffffff', foreground: '#1a1a1a', transparent: true });
      expect(clear.colours[1]).toEqual([COLOR_CYCLE[0], COLOR_CYCLE[0]]);
      const clearLight = look(withBackground(before, page, 'transparent', { ink: 'light' }));
      expect(clearLight).toMatchObject({ foreground: BACKGROUNDS.dark.foreground, grid: BACKGROUNDS.dark.grid, transparent: true });
      expect(clearLight.colours[1]).toEqual([COLOR_CYCLE_DARK[0], COLOR_CYCLE_DARK[0]]);
    }
  });

  test('White after Dark and a transparent page in light ink is the White look again, and no style at all', () => {
    let s = {};
    s = withBackground(s, page, 'dark');
    s = withBackground(s, page, 'transparent', { ink: 'light' });
    s = withBackground(s, page, 'white');
    expect(s).toEqual({});
    expect(look(s)).toEqual(look({}));
    // The person's other settings stay.
    const kept = withBackground(withBackground({ grid: { show: true }, fontSize: 14 }, page, 'dark'), page, 'white');
    expect(kept).toEqual({ grid: { show: true }, fontSize: 14 });
  });

  test('which choice a look is: old styles of the Dark preset are Dark', () => {
    expect(backgroundChoice(normaliseFigure({}))).toEqual({ choice: 'white', ink: 'dark' });
    expect(backgroundChoice({ background: '#0f172a', foreground: '#e2e8f0', grid: { color: '#64748b' } })).toEqual({ choice: 'dark', ink: 'light' });
    expect(backgroundChoice({ background: '#0f172a', foreground: '#e2e8f0', export: { transparent: true } })).toEqual({ choice: 'transparent', ink: 'light' });
    expect(backgroundChoice({ export: { transparent: true } })).toEqual({ choice: 'transparent', ink: 'dark' });
    expect(backgroundChoice({ background: '#fdf6e3' }).choice).toBe('custom');
    // An old stored style with the Dark preset and the transparent box ticked.
    const old = cleanStyle({ background: '#0f172a', foreground: '#e2e8f0', grid: { color: '#64748b' }, series: { a: { color: COLOR_CYCLE_DARK[1] } } });
    expect(backgroundChoice(normaliseFigure(applyStyle(page, old))).choice).toBe('dark');
  });

  test('custom: the ink follows the background unless given', () => {
    expect(readableInk('#fdf6e3')).toBe('#1a1a1a');
    expect(readableInk('#1b2a4a')).toBe('#e2e8f0');
    expect(look(withBackground({}, page, 'custom', { background: '#1b2a4a' }))).toMatchObject({ background: '#1b2a4a', foreground: '#e2e8f0', transparent: false });
    expect(look(withBackground({}, page, 'custom', { background: '#1b2a4a', foreground: '#ffcc00' })).foreground).toBe('#ffcc00');
    // A dark custom ground moves the cycle's colours as Dark does.
    expect(look(withBackground({}, page, 'custom', { background: '#1b2a4a' })).colours[1][0]).toBe(COLOR_CYCLE_DARK[0]);
    // From transparent: opaque again, the colours kept.
    const fromClear = withBackground(withBackground({}, page, 'transparent', { ink: 'light' }), page, 'custom', { background: '#0f172a', foreground: '#e2e8f0' });
    expect(look(fromClear)).toMatchObject({ background: '#0f172a', transparent: false });
  });
});

describe('second axes: a y axis on the right, an x axis on top', () => {
  const line = (o = {}) => ({ kind: 'line', x: [0, 1], y: [1, 2], ...o });

  test('series stand on the first axes unless they say otherwise; panels start with second axes like their first', () => {
    const f = normaliseFigure({ panels: [{ series: [line(), line({ yAxis: 'right' }), line({ xAxis: 'top', yAxis: 'right' }), line({ xAxis: 'side', yAxis: 'up' })] }] });
    const [p] = f.panels;
    expect(p.series.map((q) => [q.xAxis, q.yAxis])).toEqual([['bottom', 'left'], ['bottom', 'right'], ['top', 'right'], ['bottom', 'left']]);
    expect(p).toMatchObject({ y2Label: '', y2Scale: 'linear', y2Lim: [null, null], y2Color: null, x2Label: '', x2Scale: 'linear', x2Lim: [null, null], x2Color: null });
    expect(p.y2Ticks).toEqual({ ...p.yTicks, mirror: false });
    expect(p.x2Ticks).toEqual({ ...f.xTicks, mirror: false });
    expect([hasAxis(p, 'y2'), hasAxis(p, 'x2')]).toEqual([true, true]);
  });

  test('images, contours and box plots stay on the first axes', () => {
    const f = normaliseFigure({ panels: [{ series: [
      { kind: 'heatmap', x: [0, 1], y: [0, 1], z: [[1, 2], [3, 4]], yAxis: 'right', xAxis: 'top' },
      { kind: 'contour', x: [0, 1], y: [0, 1], z: [[1, 2], [3, 4]], yAxis: 'right' },
      { kind: 'box', groups: [[1, 2, 3]], yAxis: 'right' }
    ] }] });
    expect(f.panels[0].series.every((q) => q.xAxis === 'bottom' && q.yAxis === 'left')).toBe(true);
    expect(hasAxis(f.panels[0], 'y2')).toBe(false);
    expect(SECONDARY_KINDS).not.toContain('heatmap');
  });

  test('a hidden series draws no second axis', () => {
    const f = normaliseFigure({ panels: [{ series: [line(), line({ yAxis: 'right', show: false })] }] });
    expect(hasAxis(f.panels[0], 'y2')).toBe(false);
  });

  test('labels, scales, limits and ticks of their own, kept in range', () => {
    const f = normaliseFigure({ panels: [{
      y2Label: 'Pressure (kPa)', y2Scale: 'log', y2Lim: ['1', 'x'], y2Ticks: { mode: 'step', step: 0.5, direction: 'out', length: 99, mirror: true },
      x2Label: 7, x2Scale: 'sideways', x2Lim: [null, 30], x2Ticks: { minor: true },
      yTicks: { direction: 'in', length: 5, minor: true }, series: [line({ yAxis: 'right' })]
    }] });
    const [p] = f.panels;
    expect(p).toMatchObject({ y2Label: 'Pressure (kPa)', y2Scale: 'log', y2Lim: [1, null], x2Label: '7', x2Scale: 'linear', x2Lim: [null, 30] });
    expect(p.y2Ticks).toMatchObject({ mode: 'step', step: 0.5, direction: 'out', length: 20, minor: true, mirror: false });
    // What a second axis does not set it takes from the axis opposite.
    const inherit = normaliseFigure({ xTicks: { direction: 'inout', width: 2 }, panels: [{ yTicks: { direction: 'in', length: 5, minor: true, mode: 'step', step: 2 } }] }).panels[0];
    expect(inherit.y2Ticks).toMatchObject({ direction: 'in', length: 5, minor: true, mode: 'auto', step: null });
    expect(inherit.x2Ticks).toMatchObject({ direction: 'inout', width: 2, minor: false });
  });

  test('an axis colour: a colour, none, or the colour of its one series', () => {
    const one = normaliseFigure({ panels: [{ y2Color: 'auto', x2Color: 'auto', series: [line(), line({ yAxis: 'right' })] }] }).panels[0];
    expect(one.y2Color).toBe(COLOR_CYCLE[1]);
    expect(one.x2Color).toBeNull();   // no series on top
    const two = normaliseFigure({ panels: [{ y2Color: 'auto', series: [line({ yAxis: 'right' }), line({ yAxis: 'right' })] }] }).panels[0];
    expect(two.y2Color).toBeNull();
    const own = normaliseFigure({ panels: [{ y2Color: '#ABC', x2Color: 'red', series: [line({ yAxis: 'right' })] }] }).panels[0];
    expect([own.y2Color, own.x2Color]).toEqual(['#aabbcc', null]);
    // On a dark background the series and the axis take the dark cycle's colour alike.
    const dark = normaliseFigure({ background: '#0f172a', panels: [{ y2Color: 'auto', series: [line(), line({ yAxis: 'right' })] }] }).panels[0];
    expect(dark.y2Color).toBe(COLOR_CYCLE_DARK[1]);
    // Normalised again, the colour stays.
    expect(normaliseFigure(normaliseFigure({ panels: [{ y2Color: 'auto', series: [line({ yAxis: 'right' })] }] })).panels[0].y2Color).toBe(COLOR_CYCLE[0]);
  });

  test('bars group with the bars on their own axes; a bracket rises by the span of its own axis', () => {
    const f = normaliseFigure({ panels: [{ series: [
      { kind: 'bar', x: [0, 1], y: [1, 2] }, { kind: 'bar', x: [0, 1], y: [3, 4] },
      { kind: 'bar', x: [0, 1], y: [100, 200], yAxis: 'right' },
      { kind: 'bracket', x1: 0, x2: 1, y: 5 }, { kind: 'bracket', x1: 0, x2: 1, y: 250, yAxis: 'right' }
    ] }] });
    const [a, b, c, left, right] = f.panels[0].series;
    expect([a.barWidth, b.barWidth, c.barWidth]).toEqual([0.4, 0.4, 0.8]);
    expect([a.offset, b.offset, c.offset]).toEqual([-0.2, 0.2, 0]);
    expect(left.height).toBeCloseTo(0.025 * 5, 12);     // 0 to 5 on the left
    expect(right.height).toBeCloseTo(0.025 * 250, 12);  // 0 to 250 on the right
  });

  test('the person\'s style keeps the second axes and which axes a series stands on', () => {
    for (const k of ['y2Label', 'y2Scale', 'y2Lim', 'y2Ticks', 'y2Color', 'x2Label', 'x2Scale', 'x2Lim', 'x2Ticks', 'x2Color']) expect(LOOK_KEYS.panel).toContain(k);
    expect(LOOK_KEYS.series).toEqual(expect.arrayContaining(['xAxis', 'yAxis']));
    const page = { panels: [{ series: [line({ id: 'a' }), line({ id: 'b' })] }] };
    const style = cleanStyle({ panels: [{ y2Label: 'Right', y2Scale: 'log', x2Lim: [0, 5], data: [1] }], series: { b: { yAxis: 'right', xAxis: 'top', x: [9] } } });
    expect(style).toEqual({ panels: [{ y2Label: 'Right', y2Scale: 'log', x2Lim: [0, 5] }], series: { b: { yAxis: 'right', xAxis: 'top' } } });
    const f = normaliseFigure(applyStyle(page, style));
    expect(f.panels[0]).toMatchObject({ y2Label: 'Right', y2Scale: 'log', x2Lim: [0, 5] });
    expect(f.panels[0].series[1]).toMatchObject({ yAxis: 'right', xAxis: 'top', color: COLOR_CYCLE[1] });
  });
});

/* ------------------------------------------------------------------ *
 * Horizontal and stacked bars, bar widths, histogram options, violins,
 * box options, bars of means
 * ------------------------------------------------------------------ */

describe('bars: lying flat, stacked, as wide as asked', () => {
  const bars = (series, panel = {}) => normaliseFigure({ panels: [{ ...panel, series }] }).panels[0];

  test('a width is in data units, with no upper limit; the spacing of the bars is kept beside it', () => {
    const [b] = bars([{ kind: 'bar', x: [0, 5, 10, 20], y: [1, 2, 3, 4], width: 4 }]).series;
    expect([b.width, b.barWidth, b.spacing]).toEqual([4, 4, 5]);
    const [c] = bars([{ kind: 'bar', x: [0.1, 0.11, 0.13], y: [1, 2, 3], width: 0.008 }]).series;
    expect(c.width).toBe(0.008);
    expect(c.spacing).toBeCloseTo(0.01, 12);
    // Bars on categories are as before: 0.8 of the place each has.
    const [d] = bars([{ kind: 'bar', y: [1, 2, 3] }]).series;
    expect([d.width, d.spacing, d.orientation, d.stack]).toEqual([0.8, 1, 'v', 'none']);
    expect(bars([{ kind: 'bar', y: [5] }]).series[0].spacing).toBe(1);
    // The style panel still knows the spacing when the data are left out.
    const look = normaliseFigure(lookOnly({ panels: [{ series: [{ kind: 'bar', x: [0, 5, 10], y: [1, 2, 3] }, { kind: 'bar', orientation: 'h', y: [0, 2], x: [1, 2] }] }] }));
    expect(look.panels[0].series.map((q) => q.spacing)).toEqual([5, 2]);
    expect(look.panels[0].series[0].y).toEqual([]);
  });

  test('horizontal bars: positions on y, lengths and errors along x, on the panel\'s own axes', () => {
    const p = bars([
      { kind: 'bar', orientation: 'h', y: [0, 1, 2], x: [3, 4, 5], xerr: [0.1, 0.2, 0.3], xAxis: 'top', yAxis: 'right' },
      { kind: 'bar', orientation: 'h', x: [1, 2, 3] }
    ], { yCategories: ['c', 'b', 'a'], yScale: 'log' });
    const [a, b] = p.series;
    expect(barData(a)).toEqual({ horizontal: true, positions: [0, 1, 2], values: [3, 4, 5], errors: [[0.1, 0.2, 0.3], [0.1, 0.2, 0.3]] });
    expect([a.xAxis, a.yAxis, a.yerr]).toEqual(['bottom', 'left', null]);
    expect(b.y).toEqual([0, 1, 2]);                     // positions, when none are given
    // Side by side, the first series above the second.
    expect([a.barWidth, b.barWidth]).toEqual([0.4, 0.4]);
    expect([a.offset, b.offset]).toEqual([0.2, -0.2]);
    expect(a.heights).toEqual([3, 4, 5]);
    expect(a.bottoms).toEqual([0, 0, 0]);
    // Names on the y axis make it linear, as names on x do.
    expect(p.yCategories).toEqual(['c', 'b', 'a']);
    expect(p.yScale).toBe('linear');
    expect(bars([{ kind: 'bar', y: [1] }]).yCategories).toBeNull();
    // Upright bars and lying ones do not share places.
    const mixed = bars([{ kind: 'bar', y: [1, 2] }, { kind: 'bar', orientation: 'h', x: [1, 2] }]).series;
    expect(mixed.map((q) => q.barWidth)).toEqual([0.8, 0.8]);
  });

  test('a base for each bar', () => {
    const [a, b] = bars([{ kind: 'bar', y: [1, 2, 3], bottom: [10, 20, 30] }, { kind: 'bar', y: [1, 2], bottom: 5 }]).series;
    expect(a.bottom).toEqual([10, 20, 30]);
    expect(a.bottoms).toEqual([10, 20, 30]);
    expect(b.bottom).toBe(5);
    expect(b.bottoms).toEqual([5, 5]);
  });

  test('stacked: each series stands on the ones before it, values below zero downwards', () => {
    const p = bars([
      { id: 'a', kind: 'bar', y: [3, 4, -2, 5], stack: 'stack', yerr: [0.3, 0.2, 0.4, 0.1], label: 'A' },
      { id: 'b', kind: 'bar', y: [2, -1, 3, 1], stack: 'stack', label: 'B' },
      { id: 'c', kind: 'bar', y: [1, 2, 2, NaN], stack: true, label: 'C' },
      { id: 'd', kind: 'bar', y: [4, 4, 4, 4], label: 'Beside' }
    ]);
    const [a, b, c, d] = p.series;
    expect(a.bottoms).toEqual([0, 0, 0, 0]);
    expect(b.bottoms).toEqual([3, 0, 0, 5]);
    expect(c.bottoms).toEqual([5, 4, 3, 6]);
    expect([a.stacked, b.stacked, c.stacked, d.stacked]).toEqual(['stack', 'stack', 'stack', 'none']);
    expect(Number.isNaN(c.heights[3])).toBe(true);
    // The stack is one place beside the other bars.
    expect([a.barWidth, b.barWidth, c.barWidth, d.barWidth]).toEqual([0.4, 0.4, 0.4, 0.4]);
    expect([a.offset, b.offset, c.offset, d.offset]).toEqual([-0.2, -0.2, -0.2, 0.2]);
    expect(a.errs).toEqual([[0.3, 0.2, 0.4, 0.1], [0.3, 0.2, 0.4, 0.1]]);
    // The legend reads down the stack; the bars beside it keep their place.
    expect(legendOrder(p)).toEqual(['c', 'b', 'a', 'd']);
    expect(legendOrder(bars([{ id: 'a', kind: 'bar', y: [1] }, { id: 'b', kind: 'bar', y: [2] }]))).toEqual([]);
    expect(legendOrder(bars([{ id: 'a', kind: 'bar', y: [1], stack: 'stack' }, { id: 'b', kind: 'bar', y: [2], stack: 'stack' }], { legend: { order: ['a', 'b'] } }))).toEqual(['a', 'b']);
    // Bars lying flat stack to the right: the legend keeps the order given.
    expect(legendOrder(bars([{ id: 'a', kind: 'bar', orientation: 'h', x: [1], stack: 'stack' }, { id: 'b', kind: 'bar', orientation: 'h', x: [2], stack: 'stack' }]))).toEqual([]);
  });

  test('stacked to 100%: shares of the sum of the sizes at each position, errors scaled with them', () => {
    const [a, b, c] = bars([
      { kind: 'bar', x: [0, 5, 10, 15], y: [3, 4, 2, 5], stack: 'percent' },
      { kind: 'bar', x: [0, 5, 10], y: [2, 1, 3], stack: 'percent', yerr: [[0.2, 0.2, 0.2], [0.4, 0.4, 0.4]] },
      { kind: 'bar', x: [5, 10, 15, 20], y: [1, 2, 2, 0], stack: 'stack' }      // the first stacked series sets the way
    ]).series;
    expect(a.heights).toEqual([60, 100 * 4 / 6, 100 * 2 / 7, 100 * 5 / 7]);
    expect(b.heights).toEqual([40, 100 / 6, 300 / 7]);
    expect(b.bottoms).toEqual([60, 100 * 4 / 6, 100 * 2 / 7]);
    expect(c.bottoms[0]).toBe(100 * 4 / 6 + 100 / 6);
    expect(c.heights[0] + c.bottoms[0]).toBeCloseTo(100, 12);
    expect(c.stacked).toBe('percent');
    expect(b.errs[1][0]).toBeCloseTo(8, 12);            // 0.4 of 5 is 8%
    expect(Number.isNaN(c.heights[3])).toBe(true);       // nothing to share at 20
    expect(a.y).toEqual([3, 4, 2, 5]);                   // the data are kept
    // Series on other axes, and series not shown, are not in the stack.
    const other = bars([{ kind: 'bar', y: [1, 2], stack: 'stack' }, { kind: 'bar', y: [3, 4], stack: 'stack', yAxis: 'right' }, { kind: 'bar', y: [9, 9], stack: 'stack', show: false }]).series;
    expect(other.map((q) => q.bottoms)).toEqual([[0, 0], [0, 0], [0, 0]]);
  });
});

describe('histogram options, as numpy and matplotlib have them', () => {
  test('numpy\'s rules for the number of bins', () => {
    expect(BIN_RULES).toEqual(['auto', 'fd', 'sturges', 'sqrt', 'scott', 'rice', 'doane']);
    for (const rule of BIN_RULES) expect([rule, histogramBinEdges(REF.hist.values, rule).length - 1]).toEqual([rule, REF.rules[rule]]);
    const h = histogram(REF.hist.values, 'fd');
    expect(h.counts).toEqual(REF.fd.counts);
    expect(h.edges[1]).toBe(REF.fd.edge1);
    expect(h.edges[0]).toBe(Math.min(...REF.hist.values));
    expect(h.edges[12]).toBe(Math.max(...REF.hist.values));
    for (const { values, edges } of REF.awkward) for (const rule of BIN_RULES) expect([values, rule, histogramBinEdges(values, rule)]).toEqual([values, rule, edges[rule]]);
    expect(histogramBinEdges([], 'fd')).toEqual([0, 1]);
    expect(histogramBinEdges([NaN, 3, null], 'auto')).toEqual([2.5, 3.5]);
    expect(histogramBinEdges([1, 2, 3], [0, 2, 4])).toEqual([0, 2, 4]);
    expect(histogramBinEdges(REF.hist.values, 9)).toEqual(REF.hist.edges);
  });

  test('numpy\'s sum, pairwise: the means the rules use are numpy\'s to the last bit', () => {
    // np.add.reduce(1 / (np.arange(n) + 1.0)) with numpy 1.26; adding one by one gives other last digits from 130 on
    const sums = { 7: 2.5928571428571425, 9: 2.8289682539682537, 130: 5.4485913382659765, 1000: 7.485470860550345, 8200: 9.589166072524293, 20000: 10.480728217229329 };
    for (const [n, want] of Object.entries(sums)) expect([n, numpySum(Array.from({ length: Number(n) }, (_, k) => 1 / (k + 1)))]).toEqual([n, want]);
  });

  test('counts, density, fraction and percent; and the running total', () => {
    const counts = [2, 2, 7, 18, 15, 8, 3, 1, 1];
    const edges = REF.hist.edges;
    expect(histogramHeights(counts, edges)).toEqual(counts);
    expect(histogramHeights(counts, edges, { normalise: 'fraction' }).slice(0, 3)).toEqual([0.03508771929824561, 0.03508771929824561, 0.12280701754385964]);
    expect(histogramHeights(counts, edges, { normalise: 'percent' })[3]).toBe(100 * 18 / 57);
    expect(histogramHeights(counts, edges, { cumulative: true })).toEqual([2, 4, 11, 29, 44, 52, 55, 56, 57]);
    // matplotlib's hist(density=True, cumulative=True): the fraction up to the end of each bin.
    const cd = histogramHeights(counts, edges, { normalise: 'density', cumulative: true });
    expect(cd[7]).toBeCloseTo(0.9824561403508771, 14);
    expect(cd[8]).toBeCloseTo(1, 14);
    expect(histogramHeights(counts, edges, { normalise: 'percent', cumulative: true })[8]).toBeCloseTo(100, 12);
  });

  test('a series takes a rule, a way to scale and `cumulative`; `density: true` still means density', () => {
    const one = (o) => normaliseFigure({ panels: [{ series: [{ kind: 'histogram', values: REF.hist.values, ...o }] }] }).panels[0].series[0];
    expect(one({ bins: 'fd' }).counts).toEqual(REF.fd.counts);
    expect(one({ bins: 'fd' }).bins).toBe('fd');
    expect(one({ bins: 'nonsense' }).bins).toBe(10);
    const plain = one({ bins: 9 });
    expect([plain.normalise, plain.density, plain.cumulative]).toEqual(['counts', false, false]);
    expect(plain.counts).toEqual(REF.hist.counts);
    const old = one({ bins: REF.hist.density.edges, density: true });
    expect([old.normalise, old.density]).toEqual(['density', true]);
    old.counts.forEach((c, i) => expect(c).toBeCloseTo(REF.hist.density.counts[i], 14));
    expect(one({ bins: 9, normalise: 'density' }).counts).toEqual(histogram(REF.hist.values, 9, { density: true }).counts);
    expect(one({ bins: 9, normalise: 'percent', cumulative: true }).counts[8]).toBeCloseTo(100, 12);
    expect(one({ bins: 9, normalise: 'fraction', density: true }).density).toBe(false);   // the newer word wins
    // Counts already binned are drawn as given.
    const binned = normaliseFigure({ panels: [{ series: [{ kind: 'histogram', counts: [3, 5, 2], edges: [0, 1, 2, 3], cumulative: true, normalise: 'percent' }] }] }).panels[0].series[0];
    expect([binned.counts, binned.cumulative, binned.normalise]).toEqual([[3, 5, 2], false, 'counts']);
  });
});

describe('box options and violins', () => {
  test('whiskers by percentiles, and the notch: cbook.boxplot_stats', () => {
    for (const r of REF.whis) {
      const b = boxStats(REF.box.values, { whis: r.whis });
      expect([r.whis, b.whislo, b.whishi]).toEqual([r.whis, r.whislo, r.whishi]);
      expect(b.fliers.slice().sort((p, q) => p - q)).toEqual(r.fliers);
    }
    const b = boxStats(REF.box.values);
    expect(b.notchLow).toBeCloseTo(REF.notch[0], 13);
    expect(b.notchHigh).toBeCloseTo(REF.notch[1], 13);
  });

  test('a box series takes the whisker rule as a number, a pair or the text a select gives', () => {
    const box = (o) => normaliseFigure({ panels: [{ series: [{ kind: 'box', groups: [REF.box.values], ...o }] }] }).panels[0].series[0];
    expect([box({}).whis, box({}).notch, box({}).level]).toEqual([1.5, false, 0.95]);
    expect(box({ whis: [5, 95] }).whis).toEqual([5, 95]);
    expect(box({ whis: '5,95' }).whis).toEqual([5, 95]);
    expect(box({ whis: '0,100' }).groups[0].stats.whishi).toBe(21);
    expect(box({ whis: 'range' }).whis).toEqual([0, 100]);
    expect(box({ whis: '2' }).whis).toBe(2);
    expect(box({ whis: [95, 5] }).whis).toBe(1.5);
    expect(box({ whis: 'x' }).whis).toBe(1.5);
    expect(box({ notch: true, level: '0.99' })).toMatchObject({ notch: true, level: 0.99 });
    expect(LOOK_KEYS.series).toEqual(expect.arrayContaining(['whis', 'level', 'notch', 'inner', 'bandwidth', 'cut', 'scale']));
  });

  test('a violin\'s density: scipy.stats.gaussian_kde, Scott\'s and Silverman\'s bandwidth', () => {
    const lo = Math.min(...REF.hist.values); const hi = Math.max(...REF.hist.values);
    for (const rule of ['scott', 'silverman']) {
      expect(kdeBandwidth(REF.hist.values, rule)).toBeCloseTo(REF.kde[rule].bw, 14);
      gaussianKde(REF.hist.values, [-2, 0, 1.5, lo, hi], rule).forEach((d, i) => expect(d).toBeCloseTo(REF.kde[rule].at[i], 14));
    }
    const v = violinStats(REF.hist.values);
    expect(v.coords).toEqual(linspace(lo, hi, 100));      // matplotlib's 100 points over the data
    expect(v.density[0]).toBeCloseTo(REF.kde.scott.at[3], 14);
    expect(v.density[99]).toBeCloseTo(REF.kde.scott.at[4], 14);
    expect(v.peak).toBe(Math.max(...v.density));
    const cut = violinStats(REF.hist.values, { cut: 2, bandwidth: 'silverman' });
    expect(cut.coords[0]).toBeCloseTo(lo - 2 * REF.kde.silverman.bw, 12);
    expect(cut.coords[99]).toBeCloseTo(hi + 2 * REF.kde.silverman.bw, 12);
    // Nothing to estimate from: a line at the value, as matplotlib draws it.
    for (const values of [[3], [2, 2, 2]]) expect(violinStats(values)).toMatchObject({ flat: true, bw: 0, coords: new Array(100).fill(values[0]) });
    expect(violinStats([NaN, 1, null, 3]).n).toBe(2);
    expect(violinStats([])).toBeNull();
  });

  test('a violin series: groups as a box plot\'s, each as wide as asked or all of one area', () => {
    const groups = [REF.hist.values, REF.hist.values.map((x) => 5 + x / 4), [3, 3, 3], []];
    const violin = (o) => normaliseFigure({ xCategories: ['a', 'b', 'c', 'd'], panels: [{ series: [{ kind: 'violin', groups, ...o }] }] }).panels[0].series[0];
    const v = violin({});
    expect(SERIES_KINDS).toContain('violin');
    expect(v).toMatchObject({ bandwidth: 'scott', cut: 0, scale: 'width', inner: 'box', width: 0.8, points: false, legend: false, color: COLOR_CYCLE[0], xAxis: 'bottom', yAxis: 'left' });
    expect(v.groups.map((g) => g.position)).toEqual([0, 1, 2, 3]);
    expect(Math.max(...v.groups[0].half)).toBeCloseTo(0.4, 12);
    expect(Math.max(...v.groups[1].half)).toBeCloseTo(0.4, 12);
    expect(v.groups[2].half).toEqual(new Array(100).fill(0.4));
    expect(v.groups[3].kde).toBeNull();
    expect(v.groups[0].stats.med).toBeCloseTo(boxStats(REF.hist.values).med, 12);
    // One scale for all: the narrower spread is four times as dense, so the wide one is a quarter as wide.
    const area = violin({ scale: 'area', width: 1 });
    expect(Math.max(...area.groups[1].half)).toBeCloseTo(0.5, 12);
    expect(Math.max(...area.groups[0].half)).toBeCloseTo(0.125, 6);
    expect(violin({ yAxis: 'right', inner: 'nonsense', bandwidth: 'x', cut: -1 })).toMatchObject({ yAxis: 'left', inner: 'box', bandwidth: 'scott', cut: 0 });
  });
});

describe('bars of means', () => {
  test('the mean of each group and its SD, SEM or t interval: numpy and scipy', () => {
    const g = REF.groups;
    const same = (got, want) => got.forEach((v, i) => (Number.isNaN(want[i]) ? expect(Number.isNaN(v)).toBe(true) : expect(v).toBeCloseTo(want[i], 9)));
    const sd = groupMeans(g.values, { error: 'sd' });
    expect(sd.n).toEqual([4, 2, 1]);
    expect(sd.mean).toEqual(g.mean);
    expect(sd.err).toEqual(g.sd);
    expect(groupMeans(g.values, { error: 'sem' }).err).toEqual(g.sem);
    same(groupMeans(g.values, { error: 'ci', level: 0.95 }).err, g.ci);
    expect(groupMeans([[]]).mean).toEqual([NaN]);
  });

  test('a bar series of replicates: the rows grouped by their codes', () => {
    const values = [4.1, 2.0, 5.2, NaN, 6.3, 2.5, 5.5, 9.0, 1.0];
    const codes = [0, 1, 0, 0, 0, 1, 0, 2, -1];
    const bar = (o = {}) => normaliseFigure({ xCategories: ['a', 'b', 'c'], panels: [{ series: [{ kind: 'bar', replicates: { values: { values, name: 'response', source: 'f', column: 'response' }, codes, names: ['a', 'b', 'c'], ...o.replicates }, ...o.series }] }] }).panels[0].series[0];
    const b = bar();
    expect(b.x).toEqual([0, 1, 2]);
    expect(b.y).toEqual(REF.groups.mean);
    expect(b.yerr[0].slice(0, 2)).toEqual(REF.groups.sd.slice(0, 2));
    expect(Number.isNaN(b.yerr[1][2])).toBe(true);        // one value: no error bar
    expect(b.replicates.groups).toEqual(REF.groups.values);
    expect(b.replicates).toMatchObject({ error: 'sd', level: 0.95, names: ['a', 'b', 'c'] });
    expect(b.refs.replicates).toEqual({ name: 'response', source: 'f', column: 'response' });
    expect([b.points, b.pointSize, b.jitter, b.marker]).toEqual([false, 3, 0.5, 'o']);
    expect(bar({ replicates: { error: 'sem' } }).yerr[0].slice(0, 2)).toEqual(REF.groups.sem.slice(0, 2));
    expect(bar({ replicates: { error: 'ci', level: 0.95 } }).yerr[0][0]).toBeCloseTo(REF.groups.ci[0], 9);
    expect(bar({ replicates: { error: 'none' } }).yerr).toBeNull();
    // Lying flat, the means run along x.
    const h = bar({ series: { orientation: 'h', points: true } });
    expect([h.x, h.y, h.yerr, h.points]).toEqual([REF.groups.mean, [0, 1, 2], null, true]);
    expect(h.xerr[0].slice(0, 2)).toEqual(REF.groups.sd.slice(0, 2));
    // More names than codes used: a place with no bar.
    expect(bar({ replicates: { names: ['a', 'b', 'c', 'd'] } }).y).toHaveLength(4);
  });
});

/* ------------------------------------------------------------------ *
 * Panels on a grid, shared axes, the gap, letters and insets
 * ------------------------------------------------------------------ */

describe('panel layout', () => {
  const line = (id, y = [1, 2]) => ({ id, kind: 'line', x: [0, 1], y });
  const panel = (id, o = {}) => ({ id, series: [line(`s_${id}`)], ...o });
  const cells = (f) => f.panels.map((p) => (p.inset ? 'inset' : [p.row, p.col, p.rowSpan, p.colSpan].join(',')));

  test('a figure with no layout is the stack it has always been', () => {
    const f = normaliseFigure({ xLabel: 'Time', xScale: 'log', xLim: [1, null], panels: [panel('a'), panel('b', { ratio: 0.5 }), panel('c')] });
    expect(f.layout).toEqual({ rows: 3, cols: 1, widthRatios: [1], heightRatios: [1, 0.5, 1] });
    expect([f.sharex, f.sharey, f.panelGap, f.panelLabels.show]).toEqual(['all', 'none', { h: null, w: null }, false]);
    expect(cells(f)).toEqual(['0,0,1,1', '1,0,1,1', '2,0,1,1']);
    expect(isStack(f)).toBe(true);
    // Every panel draws the figure's x axis; only the last labels it.
    expect(f.panels.map((p) => [p.xLabel, p.xScale, p.xLim, p.shareX, p.xOuter, p.shareY, p.yOuter])).toEqual([
      ['Time', 'log', [1, null], 0, false, 0, true], ['Time', 'log', [1, null], 0, false, 1, true], ['Time', 'log', [1, null], 0, true, 2, true]]);
    expect(titledPanel(f)).toBe(0);
    expect(panelLetters(f)).toEqual(['', '', '']);
    expect(panelEdges(f)).toEqual([null, null, null]);
    expect(layoutPads(f)).toEqual({ h: null, w: null });
    // Normalising again changes nothing.
    expect(normaliseFigure(f)).toEqual(f);
    expect([SHARE_X, SHARE_Y]).toEqual([['none', 'col', 'all'], ['none', 'row', 'all']]);
  });

  test('panels take the next free cell, row by row; a grid has the columns asked for and the rows it needs', () => {
    const f = normaliseFigure({ layout: { cols: 2 }, panels: ['a', 'b', 'c'].map((id) => panel(id)) });
    expect(f.layout).toEqual({ rows: 2, cols: 2, widthRatios: [1, 1], heightRatios: [1, 1] });
    expect(cells(f)).toEqual(['0,0,1,1', '0,1,1,1', '1,0,1,1']);
    // On a grid of several columns nothing is shared unless asked.
    expect([f.sharex, f.sharey, isStack(f)]).toEqual(['none', 'none', false]);
    expect(f.panels.map((p) => [p.shareX, p.xOuter, p.shareY, p.yOuter])).toEqual([[0, true, 0, true], [1, true, 1, true], [2, true, 2, true]]);
    // More rows than the panels need stay, empty; more columns than 6, or rows than 12, do not.
    expect(normaliseFigure({ layout: { rows: 3, cols: 2 }, panels: [panel('a')] }).layout.rows).toBe(3);
    expect(normaliseFigure({ layout: { rows: 40, cols: 40 } }).layout).toMatchObject({ rows: 12, cols: 6 });
    expect(normaliseFigure({ layout: { rows: 'x', cols: -2 } }).layout).toMatchObject({ rows: 1, cols: 1 });
    expect(normaliseFigure({ panels: Array.from({ length: 40 }, (_, i) => panel(`p${i}`)) }).panels).toHaveLength(MAX_PANELS);
    expect(normaliseFigure(f)).toEqual(f);
  });

  test('a panel that names its cell takes it, with its spans; the others fill the gaps', () => {
    const f = normaliseFigure({ layout: { cols: 3 }, panels: [panel('wide', { colSpan: 2 }), panel('b'), panel('named', { row: 1, col: 1, colSpan: 2 }), panel('d'), panel('tall', { row: 2, col: 0, rowSpan: 2 })] });
    expect(cells(f)).toEqual(['0,0,1,2', '0,2,1,1', '1,1,1,2', '1,0,1,1', '2,0,2,1']);
    expect(f.layout.rows).toBe(4);
    // A span stops at the edge of the grid; a cell already taken sends the panel to the next free one.
    const g = normaliseFigure({ layout: { cols: 2 }, panels: [panel('a', { row: 0, col: 1, colSpan: 5 }), panel('b', { row: 0, col: 1 }), panel('c', { row: 0, col: 9 })] });
    expect(cells(g)).toEqual(['0,1,1,1', '0,0,1,1', '1,0,1,1']);
    expect(normaliseFigure(g)).toEqual(g);
  });

  test('widths and heights: the panels\' ratios in one column, the grid\'s on a grid', () => {
    const grid = normaliseFigure({ layout: { cols: 2, widthRatios: [2, 'x'], heightRatios: [1, 3, 9] }, panels: ['a', 'b', 'c', 'd'].map((id) => panel(id, { ratio: 5 })) });
    expect(grid.layout).toEqual({ rows: 2, cols: 2, widthRatios: [2, 1], heightRatios: [1, 3] });
    const column = normaliseFigure({ layout: { heightRatios: [9, 9] }, panels: [panel('a', { ratio: 2 }), panel('b')] });
    expect(column.layout.heightRatios).toEqual([2, 1]);
    expect(normaliseFigure({ layout: { cols: 2, widthRatios: [0, 1000] }, panels: [panel('a'), panel('b')] }).layout.widthRatios).toEqual([0.05, 20]);
  });

  test('shared axes: one scale, limits and ticks for the group, labels on its outer panels', () => {
    const f = normaliseFigure({
      layout: { rows: 2, cols: 2 }, sharex: 'col', sharey: 'row', xLabel: 'Time',
      panels: [panel('a', { xLim: [0, 5], yScale: 'log', yLabel: 'A' }), panel('b', { xScale: 'log', yLim: [1, 2], yLabel: 'B' }),
        panel('c', { xLim: [9, 9], xScale: 'log', xLabel: 'Below a', yLabel: 'C' }), panel('d', { yTicks: { minor: true }, xTicks: { minor: true } })]
    });
    expect(f.panels.map((p) => [p.shareX, p.shareY, p.xOuter, p.yOuter])).toEqual([[0, 0, false, true], [1, 0, false, false], [0, 2, true, true], [1, 2, true, false]]);
    // Each group follows its first panel in reading order.
    expect(f.panels.map((p) => [p.xScale, p.xLim, p.yScale, p.yLim])).toEqual([
      ['linear', [0, 5], 'log', [null, null]], ['log', [null, null], 'log', [null, null]],
      ['linear', [0, 5], 'linear', [null, null]], ['log', [null, null], 'linear', [null, null]]]);
    expect(f.panels[3].xTicks.minor).toBe(false);
    expect(f.panels[3].yTicks.minor).toBe(false);
    // The labels stay each panel's own: the outer ones are drawn.
    expect(f.panels.map((p) => p.xLabel)).toEqual(['Time', 'Time', 'Below a', 'Time']);
    expect(normaliseFigure(f)).toEqual(f);
    const all = normaliseFigure({ layout: { cols: 2 }, sharex: true, sharey: 'all', panels: ['a', 'b', 'c'].map((id) => panel(id)) });
    expect([all.sharex, all.sharey]).toEqual(['all', 'all']);
    // c is the bottom of the left column; b has nothing under it; a and c are the left of their rows.
    expect(all.panels.map((p) => [p.shareX, p.shareY, p.xOuter, p.yOuter])).toEqual([[0, 0, false, true], [0, 0, true, false], [0, 0, true, true]]);
    expect(normaliseFigure({ sharex: false, panels: [panel('a'), panel('b')] }).panels.map((p) => [p.shareX, p.xOuter])).toEqual([[0, true], [1, true]]);
    expect(normaliseFigure({ sharex: 'sideways', sharey: 7, panels: [panel('a'), panel('b')] })).toMatchObject({ sharex: 'all', sharey: 'none' });
    // A panel that spans the columns is under both of them.
    const span = normaliseFigure({ layout: { cols: 2 }, sharex: 'all', panels: [panel('a'), panel('b'), panel('wide', { colSpan: 2 })] });
    expect(span.panels.map((p) => p.xOuter)).toEqual([false, false, true]);
    // By column, a panel shares with those in exactly its columns.
    expect(normaliseFigure({ layout: { cols: 2 }, sharex: 'col', panels: [panel('a'), panel('b'), panel('wide', { colSpan: 2 })] }).panels.map((p) => [p.shareX, p.xOuter])).toEqual([[0, true], [1, true], [2, true]]);
  });

  test('each panel has an x axis of its own: its fields fall back to the figure\'s', () => {
    const f = normaliseFigure({
      sharex: 'none', xLabel: 'Time (s)', xScale: 'log', xLim: [1, 100], xTicks: { direction: 'in', length: 5 }, xCategories: null,
      panels: [panel('a'), panel('b', { xLabel: '', xScale: 'linear', xLim: [null, 4], xTicks: { minor: true } }), panel('c', { xCategories: ['u', 'v'], xScale: 'log' })]
    });
    expect(f.panels.map((p) => [p.xLabel, p.xScale, p.xLim, p.xTicks.direction, p.xTicks.length, p.xTicks.minor, p.xCategories])).toEqual([
      ['Time (s)', 'log', [1, 100], 'in', 5, false, null], ['', 'linear', [null, 4], 'in', 5, true, null], ['Time (s)', 'linear', [1, 100], 'in', 5, false, ['u', 'v']]]);
    // The second axis on top takes the look of the panel's own x ticks.
    expect(f.panels[1].x2Ticks).toMatchObject({ direction: 'in', length: 5, minor: true });
    // The figure's names are every panel's unless a panel turns them down.
    const named = normaliseFigure({ xCategories: ['p', 'q'], panels: [panel('a'), panel('b', { xCategories: false })] });
    expect(named.panels.map((p) => p.xCategories)).toEqual([['p', 'q'], ['p', 'q']]);                    // shared: the first panel's
    expect(normaliseFigure({ sharex: 'none', xCategories: ['p', 'q'], panels: [panel('a'), panel('b', { xCategories: false })] }).panels.map((p) => p.xCategories)).toEqual([['p', 'q'], null]);
    expect(normaliseFigure(f)).toEqual(f);
  });

  test('the gap between panels: points both ways, or null for matplotlib\'s own', () => {
    const gap = (v) => normaliseFigure({ panelGap: v }).panelGap;
    expect(gap(undefined)).toEqual({ h: null, w: null });
    expect(gap(4)).toEqual({ h: 4, w: 4 });
    expect(gap({ h: 0 })).toEqual({ h: 0, w: null });
    expect(gap({ h: '12', w: -3 })).toEqual({ h: 12, w: 0 });
    expect(gap({ h: 'wide', w: 1e6 })).toEqual({ h: null, w: 144 });
    // What it means to constrained layout: the pad each side, the space shared out, what the edge keeps.
    const pads = (panelGap, o = {}) => layoutPads(normaliseFigure({ width: 6, height: 4, panelGap, panels: [panel('a'), panel('b')], ...o }));
    expect(pads({ h: 0 })).toEqual({ h: { pad: 0, space: 0, inset: 3 }, w: null });
    expect(pads({ h: 4 })).toEqual({ h: { pad: 2, space: 0, inset: 1 }, w: null });
    expect(pads({ h: 6, w: 6 })).toEqual({ h: { pad: 3, space: 0, inset: 0 }, w: { pad: 3, space: 0, inset: 0 } });
    // Past 6 pt: hspace, a share of the figure's height for the two rows, half of it each side of a panel.
    const wide = pads({ h: 20, w: 20 }, { layout: { cols: 2 }, panels: ['a', 'b', 'c', 'd'].map((id) => panel(id)) });
    expect(wide.h.pad).toBe(3);
    expect(wide.h.space * 4 * 72 / 2).toBeCloseTo(20, 12);
    expect(wide.w.space * 6 * 72 / 2).toBeCloseTo(20, 12);
    expect(wide.h.inset).toBe(0);
  });

  test('panel letters: in reading order, in the style asked for, from the letter asked for', () => {
    const fig = (panelLabels, panels = ['a', 'b', 'c'].map((id) => panel(id))) => normaliseFigure({ layout: { cols: 2 }, panelLabels, panels });
    expect(fig(undefined).panelLabels).toEqual({ show: false, style: '(a)', start: 1, position: 'inside', fontSize: null, bold: true });
    expect(panelLetters(fig(true))).toEqual(['(a)', '(b)', '(c)']);
    const styled = (style) => panelLetters(fig({ show: true, style }));
    expect(PANEL_LABEL_STYLES.map((s) => styled(s)[1])).toEqual(['(b)', 'b', 'b)', 'B', '(B)']);
    expect(fig({ show: true, style: 'i.' }).panelLabels.style).toBe('(a)');
    expect(panelLetters(fig({ show: true, start: 'c' }))).toEqual(['(c)', '(d)', '(e)']);
    expect(panelLetters(fig({ show: true, start: 26, style: 'A' }))).toEqual(['Z', 'AA', 'AB']);
    expect(fig({ show: true, start: 0, position: 'above', fontSize: 2, bold: 0 }).panelLabels).toMatchObject({ start: 1, position: 'inside', fontSize: 4, bold: false });
    // In reading order, whatever the order of the description; a panel may say its own.
    const placed = fig({ show: true }, [panel('last', { row: 1, col: 1 }), panel('first'), panel('own', { letter: 'B: control' }), panel('none', { letter: '' })]);
    expect(cells(placed)).toEqual(['1,1,1,1', '0,0,1,1', '0,1,1,1', '1,0,1,1']);
    expect(panelLetters(placed)).toEqual(['(d)', '(a)', 'B: control', '']);
    // An inset has none, unless it is given one.
    const inside = fig({ show: true }, [panel('a'), panel('in', { inset: { parent: 'a' } }), panel('b'), panel('own', { inset: { parent: 'b' }, letter: 'zoom' })]);
    expect(panelLetters(inside)).toEqual(['(a)', '', '(b)', 'zoom']);
    expect(panelLetters(fig({ show: false }, [panel('a', { letter: 'x' })]))).toEqual(['']);
  });

  test('an inset: inside a panel of the grid, with axes of its own and no place on the grid', () => {
    const f = normaliseFigure({
      xLabel: 'Time', xScale: 'log', panelLabels: { show: true },
      panels: [panel('main'), panel('zoom', { inset: { parent: 'main', x: 0.5, y: 0.4, w: 0.9, h: 0.3, zoom: 1 }, xLim: [1, 2], yLim: [0, 1] }), panel('low')]
    });
    expect(cells(f)).toEqual(['0,0,1,1', 'inset', '1,0,1,1']);
    expect(f.layout.rows).toBe(2);
    expect(f.panels[1].inset).toEqual({ parent: 'main', parentIndex: 0, x: 0.5, y: 0.4, w: 0.5, h: 0.3, zoom: true });
    // It keeps the figure's scale and ticks, but has no label and no legend unless it asks, and shares nothing.
    expect(f.panels[1]).toMatchObject({ xLabel: '', xScale: 'log', xLim: [1, 2], shareX: 1, shareY: 1, xOuter: true, yOuter: true, row: null, col: null });
    expect(f.panels[1].legend.show).toBe(false);
    expect(normaliseFigure({ panels: [panel('a'), panel('in', { inset: {}, legend: { show: true }, xLabel: 'x' })] }).panels[1]).toMatchObject({ xLabel: 'x', legend: { show: true } });
    expect(isStack(f)).toBe(false);
    expect(f.panels.map((p) => p.shareX)).toEqual([0, 1, 0]);
    expect(normaliseFigure(f)).toEqual(f);
    // The parent: by id or by place; anything else (itself, another inset, nothing) is the first panel of the grid.
    const parents = (list) => normaliseFigure({ panels: list }).panels.map((p) => (p.inset ? p.inset.parentIndex : null));
    expect(parents([panel('a'), panel('b'), panel('i', { inset: { parent: 1 } }), panel('j', { inset: { parent: 'i' } }), panel('k', { inset: { parent: 'k' } }), panel('l', { inset: {} })])).toEqual([null, null, 1, 0, 0, 0]);
    expect(parents([panel('i', { inset: { parent: 'a' } }), panel('a')])).toEqual([1, null]);
    // A figure of insets alone has nowhere to put them: the first is a panel.
    expect(parents([panel('i', { inset: {} }), panel('j', { inset: {} })])).toEqual([null, 0]);
    expect(normaliseFigure({ panels: [panel('a'), panel('i', { inset: { x: 7, y: -1, w: 0, h: 9 } })] }).panels[1].inset).toMatchObject({ x: 0.95, y: 0, w: 0.05, h: 1 });
  });

  test('edges that panels share: a gap of 0 where nothing has to stand between them', () => {
    const stack = (o = {}, panels = [panel('a'), panel('b'), panel('c')]) => normaliseFigure({ panelGap: { h: 0 }, panels, ...o });
    const none = { top: false, bottom: false, left: false, right: false };
    expect(panelEdges(stack())).toEqual([{ ...none, bottom: true }, { ...none, top: true, bottom: true }, { ...none, top: true }]);
    expect(panelEdges(stack({ panelGap: { h: 0.5 } }))).toEqual([null, null, null]);
    expect(panelEdges(stack({ panelGap: { w: 0 } }))).toEqual([null, null, null]);
    // The x tick labels of an unshared axis stand between; so do a top axis, a letter outside and the title.
    expect(panelEdges(stack({ sharex: 'none' }))).toEqual([null, null, null]);
    expect(panelEdges(stack({}, [panel('a'), { id: 'b', series: [{ ...line('s'), xAxis: 'top' }] }, panel('c')]))).toEqual([null, { ...none, bottom: true }, { ...none, top: true }]);
    expect(panelEdges(stack({ panelLabels: { show: true, position: 'outside' } }))).toEqual([null, null, null]);
    expect(panelEdges(stack({ panelLabels: { show: true } }))[1]).toEqual({ ...none, top: true, bottom: true });
    expect(panelEdges(stack({ title: 'T' }, [panel('a'), panel('b')]))).toEqual([{ ...none, bottom: true }, { ...none, top: true }]);
    // Side by side: the right one shows no y tick labels, the left one has nothing on its right.
    const row = (o = {}, left = panel('a')) => normaliseFigure({ layout: { cols: 2 }, sharey: 'row', panelGap: 0, panels: [left, panel('b')], ...o });
    expect(panelEdges(row())).toEqual([{ ...none, right: true }, { ...none, left: true }]);
    expect(panelEdges(row({ sharey: 'none' }))).toEqual([null, null]);
    expect(panelEdges(row({}, { id: 'a', series: [{ ...line('s'), yAxis: 'right' }] }))).toEqual([null, null]);
    expect(panelEdges(row({}, { id: 'a', series: [{ id: 'h', kind: 'heatmap', x: [0, 1], y: [0, 1], z: [[1, 2], [3, 4]] }] }))).toEqual([null, null]);
    expect(panelEdges(row({ legend: { position: 'outside right' } }))).toEqual([null, null]);
    // On a grid both ways at once; panels of different widths do not meet in one line.
    const grid = normaliseFigure({ layout: { cols: 2 }, sharex: 'col', sharey: 'row', panelGap: 0, panels: ['a', 'b', 'c', 'd'].map((id) => panel(id)) });
    expect(panelEdges(grid)).toEqual([{ ...none, bottom: true, right: true }, { ...none, bottom: true, left: true }, { ...none, top: true, right: true }, { ...none, top: true, left: true }]);
    const uneven = normaliseFigure({ layout: { cols: 2 }, sharex: 'all', panelGap: 0, panels: [panel('wide', { colSpan: 2 }), panel('b'), panel('c')] });
    expect(panelEdges(uneven)).toEqual([null, null, null]);
  });

  test('the style lays the gap, the letters, each panel\'s x axis and the grid\'s proportions over the description', () => {
    for (const k of ['panelGap', 'panelLabels']) expect(LOOK_KEYS.figure).toContain(k);
    for (const k of ['xLabel', 'xScale', 'xLim', 'xTicks', 'letter']) expect(LOOK_KEYS.panel).toContain(k);
    expect(LOOK_KEYS.layout).toEqual(['widthRatios', 'heightRatios']);
    const page = { layout: { rows: 2, cols: 2, widthRatios: [1, 2] }, sharex: 'none', xLabel: 'x', panels: ['a', 'b', 'c', 'd'].map((id) => panel(id)) };
    const style = { panelGap: { h: 0 }, panelLabels: { show: true, style: 'A' }, layout: { rows: 9, cols: 9, sharex: 'all', widthRatios: [null, 3], heightRatios: [2] },
      panels: [{ xLabel: 'Own', xLim: [0, null] }, { xScale: 'log', xTicks: { minor: true }, letter: 'B!' }] };
    const f = normaliseFigure(applyStyle(page, style));
    expect(f.layout).toEqual({ rows: 2, cols: 2, widthRatios: [1, 3], heightRatios: [2, 1] });       // the grid itself stays the page's
    expect(f.sharex).toBe('none');
    expect(f.panelGap).toEqual({ h: 0, w: null });
    expect(panelLetters(f)).toEqual(['A', 'B!', 'C', 'D']);
    expect(f.panels.map((p) => [p.xLabel, p.xScale, p.xLim, p.xTicks.minor])).toEqual([['Own', 'linear', [0, null], false], ['x', 'log', [null, null], true], ['x', 'linear', [null, null], false], ['x', 'linear', [null, null], false]]);
    expect(page.layout).toEqual({ rows: 2, cols: 2, widthRatios: [1, 2] });                          // the page's description is not touched
    expect(cleanStyle({ ...style, sharex: 'all', panels: [{ row: 3, inset: {}, xLabel: 'Own' }] })).toEqual({
      panelGap: { h: 0 }, panelLabels: { show: true, style: 'A' }, layout: { widthRatios: [null, 3], heightRatios: [2] }, panels: [{ xLabel: 'Own' }] });
    expect(cleanStyle({ layout: { rows: 3 } })).toEqual({});
    // In one column the heights are still each panel's ratio.
    const column = normaliseFigure(applyStyle({ panels: [panel('a'), panel('b')] }, { layout: { heightRatios: [5, 5] }, panels: [{}, { ratio: 0.4 }] }));
    expect(column.layout.heightRatios).toEqual([1, 0.4]);
  });
});
