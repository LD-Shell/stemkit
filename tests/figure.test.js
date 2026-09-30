/**
 * The figure description (src/core/figure.js): normalising, the person's
 * style laid over the page's description, and the numbers each kind works
 * out as numpy and matplotlib do (box statistics, histogram bins, colormap
 * lookups). REF holds matplotlib 3.6.3's and numpy 1.26's own answers.
 */
import { describe, test, expect } from '@jest/globals';
import {
  normaliseFigure, applyStyle, cleanStyle, defaultFigure, boxStats, histogram, linspace, colormapColors, colormapIndex,
  colormapColor, colorCycle, COLOR_CYCLE, COLOR_CYCLE_DARK, COLORMAPS, SERIES_KINDS, jitterOffsets, unitsPerInch, formatSize,
  BACKGROUNDS, withBackground, backgroundChoice, readableInk
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
  cmap: [[1.5, '#440154'], [1.52, '#440154'], [3.3, '#33638d'], [7.2499, '#fde725'], [7.25, '#fde725'], [9.0, '#fde725'], [0.0, '#440154']]
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
