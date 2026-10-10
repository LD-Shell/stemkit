/**
 * The matplotlib script written for a figure description
 * (src/core/figure-python.js). The scripts are run when Python with numpy,
 * scipy and matplotlib is installed, and what matplotlib drew is compared
 * with the description and with the preview: every kind of series draws
 * the artist a person would expect, the axis limits matplotlib's autoscaling
 * picks are the ones the preview (js/figure-plot.js) computed, and the data
 * read from the person's files are the data the page drew.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { figureScript, identifier, pyStr, pyNum } from '../src/core/figure-python.js';
import { normaliseFigure, applyStyle, withBackground, barData, histogram, histogramBinEdges, violinStats, BIN_RULES, isStack, layoutPads, panelLetters } from '../src/core/figure.js';
import { buildFigure } from '../js/figure-plot.js';

const PYTHON = (() => {
  try {
    return spawnSync('python3', ['-c', 'import numpy, scipy, matplotlib'], { encoding: 'utf8', timeout: 60000 }).status === 0;
  } catch {
    return false;
  }
})();
const withPython = PYTHON ? test : test.skip;

const INSPECT = String.raw`

# --- test only: report what was drawn ---
import json as _json
from matplotlib.colors import to_hex as _hex
fig.canvas.draw()


def _kind(c):
    # fill_between gives a FillBetweenPolyCollection from matplotlib 3.10 on: a PolyCollection.
    return 'PolyCollection' if type(c).__name__ == 'FillBetweenPolyCollection' else type(c).__name__


def _panel(a):
    leg = a.get_legend()
    return {
        'xlim': [float(v) for v in a.get_xlim()], 'ylim': [float(v) for v in a.get_ylim()],
        'xscale': a.get_xscale(), 'yscale': a.get_yscale(),
        'lines': len(a.get_lines()), 'collections': [_kind(c) for c in a.collections],
        'patches': [type(p).__name__ for p in a.patches], 'containers': [type(c).__name__ for c in a.containers],
        'texts': [t.get_text() for t in a.texts],
        'legend': [t.get_text() for t in leg.get_texts()] if leg else None,
        'legendTitle': leg.get_title().get_text() if leg else None,
        'xticklabels': [t.get_text() for t in a.get_xticklabels()],
        'xlabel': a.get_xlabel(), 'ylabel': a.get_ylabel(), 'title': a.get_title(),
        'lineColors': [_hex(l.get_color()) for l in a.get_lines()],
        'lineData': [[None if v != v else float(v) for v in l.get_ydata()[:3]] for l in a.get_lines()],
        'xgrid': a.xaxis.get_major_ticks()[0].gridline.get_visible(),
        'ygrid': a.yaxis.get_major_ticks()[0].gridline.get_visible(),
        'tickSize': a.xaxis.get_major_ticks()[0].label1.get_fontsize(),
        'titleSize': a.title.get_fontsize(),
    }


import math as _math
import matplotlib as _mpl
from matplotlib.transforms import Bbox as _Bbox
_r = fig.canvas.get_renderer()
_LOCS = ['best', 'upper right', 'upper left', 'lower left', 'lower right', 'right', 'center left',
         'center right', 'lower center', 'upper center', 'center']


def _ticks(axis):
    # The ticks inside the view, with the labels their formatters give.
    log = axis.get_scale() == 'log'
    t = _math.log10 if log else float
    lo, hi = sorted(axis.get_view_interval())
    a, b = t(lo), t(hi)
    tol = (b - a) * 1e-10
    out = {}
    for which, locs, fmt in (('major', axis.get_majorticklocs(), axis.get_major_formatter()),
                             ('minor', axis.get_minorticklocs(), axis.get_minor_formatter())):
        locs = [float(v) for v in locs]
        labels = fmt.format_ticks(locs) if locs else []
        out[which] = [[v, s] for v, s in zip(locs, labels) if (v > 0 or not log) and a - tol <= t(v) <= b + tol]
    return out


def _legend_loc(a):
    # Where the legend stands, as the name of the place whose box it fills.
    leg = a.get_legend()
    if leg is None:
        return None
    bb = leg.get_window_extent(_r)
    best = min(range(1, len(_LOCS)), key=lambda i: sum(abs(u - v) for u, v in zip(
        leg._get_anchored_bbox(i, _Bbox.from_bounds(0, 0, bb.width, bb.height), leg.get_bbox_to_anchor(), _r), (bb.x0, bb.y0))))
    return _LOCS[best]


print('@@FIG@@' + _json.dumps({
    'version': _mpl.__version__,
    'panels': [dict(_panel(a), ticks={'x': _ticks(a.xaxis), 'y': _ticks(a.yaxis)}, legendLoc=_legend_loc(a))
               for a in fig.axes if a.get_label() != '<colorbar>'],
    'colorbars': [{'label': a.get_ylabel(), 'ylim': [float(v) for v in a.get_ylim()]} for a in fig.axes if a.get_label() == '<colorbar>'],
    'size': [float(v) for v in fig.get_size_inches()],
}))
`;

function run(script, files = {}, inspect = INSPECT) {
  const dir = mkdtempSync(join(tmpdir(), 'stemkit-figure-'));
  writeFileSync(join(dir, 'figure.py'), script + inspect);
  Object.entries(files).forEach(([name, text]) => writeFileSync(join(dir, name), text));
  return new Promise((resolve) => {
    const child = spawn('python3', ['figure.py'], { cwd: dir, env: { ...process.env, MPLBACKEND: 'Agg' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      const line = stdout.split('\n').find((l) => l.startsWith('@@FIG@@'));
      resolve({ code, stdout, stderr, dir, fig: line ? JSON.parse(line.slice(7)) : null });
    });
  });
}

/* ------------------------------------------------------------------ *
 * Figures of every kind
 * ------------------------------------------------------------------ */

let seed = 7;
const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand());
const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const gx = range(31, (i) => -2 + (4 * i) / 30);
const gy = range(25, (j) => -1.5 + (3 * j) / 24);
const Z = gy.map((y) => gx.map((x) => 10 + 1.5 * (x * x + y * y) - 9 * Math.exp(-((x + 0.8) ** 2 + (y - 0.3) ** 2) / 0.4)));
const t = range(120, (i) => i * 0.5);

const CASES = {
  lines: () => ({
    title: 'Lines', xLabel: 'Time (ps)', export: { filename: 'lines', format: 'svg' },
    panels: [{ yLabel: '$d$ (nm)', series: [
      { id: 'band', kind: 'band', x: t, lower: t.map((v) => Math.sin(v / 9) - 0.2), upper: t.map((v) => Math.sin(v / 9) + 0.2), label: 'Spread' },
      { id: 'cv', kind: 'line', x: t, y: t.map((v) => Math.sin(v / 9)), label: 'CV', marker: 'o', size: 3 },
      { id: 'steps', kind: 'line', x: t, y: t.map((v) => Math.round(Math.cos(v / 11) * 3) / 3), step: 'post', lineStyle: 'dashed', label: 'Steps' },
      { id: 'ref', kind: 'hline', y: 0.5, label: 'Threshold' }, { id: 'at', kind: 'vline', x: 20 },
      { id: 'note', kind: 'text', x: 0.05, y: 0.9, coords: 'axes', text: 'A note' }
    ] }]
  }),
  points: () => ({
    title: 'Points', xLabel: 'Measured', legend: { position: 'upper left', columns: 2, title: 'Kind' },
    export: { filename: 'points', format: 'png' }, dpi: 60,
    panels: [{ yLabel: 'Predicted', series: [
      { id: 'diag', kind: 'axline', points: [[0, 0], [1, 1]], label: 'y = x' },
      { id: 'err', kind: 'errorbar', x: [1, 2, 3, 4], y: [1.1, 2.3, 2.8, 4.2], yerr: [0.1, 0.2, 0.1, 0.3], xerr: [[0.1, 0.1, 0.1, 0.1], [0.2, 0.2, 0.2, 0.2]], capSize: 2, label: 'Samples' },
      { id: 'sc', kind: 'scatter', x: [1.5, 3.5], y: [3, 1], marker: '^', label: 'Controls' },
      { id: 'noMarkers', kind: 'errorbar', x: [2.5], y: [2.5], yerr: [0.4], marker: 'none', label: 'Bars only' }
    ] }]
  }),
  bars: () => ({
    title: 'Bars', xCategories: ['Control', 'Drug A', 'Drug B'], export: { filename: 'bars', format: 'pdf' },
    panels: [{ yLabel: 'Activity', series: [
      { id: 'wt', kind: 'bar', y: [4.1, 6.3, 5.2], yerr: [0.4, 0.5, 0.6], label: 'Wild type' },
      { id: 'mut', kind: 'bar', y: [3.2, 3.9, 5.8], yerr: [0.3, 0.45, 0.5], label: 'Mutant', edgeWidth: 1, edgeColor: '#000000' },
      { id: 'sig', kind: 'bracket', x1: -0.2, x2: 0.8, y: 7.1, text: '**' }
    ] }]
  }),
  boxes: () => ({
    title: 'Boxes', xCategories: ['A', 'B', 'C'], export: { filename: 'boxes', format: 'png' }, dpi: 60,
    panels: [{ yLabel: 'Value', series: [
      { id: 'box', kind: 'box', groups: [range(15, () => 5 + gauss()), [...range(20, () => 6 + gauss()), 14], range(9, () => 4 + 2 * gauss())], points: true, mean: true, fliers: true, meanOffset: 0.3 }
    ] }]
  }),
  hist: () => ({
    title: 'Histograms', xLabel: 'x', export: { filename: 'hist', format: 'png' }, dpi: 60,
    panels: [{ yLabel: 'Count', series: [
      { id: 'a', kind: 'histogram', values: range(300, () => gauss()), bins: 20, label: 'A' },
      { id: 'b', kind: 'histogram', values: range(200, () => 1 + gauss() * 0.5), bins: [-1, 0, 0.5, 1, 1.5, 2, 3], histtype: 'step', label: 'B' },
      { id: 'c', kind: 'histogram', counts: [3, 5, 2], edges: [3, 3.5, 4, 5], histtype: 'bar', label: 'Binned' }
    ] }]
  }),
  surface: () => ({
    title: 'Surface', xLabel: '$s_1$', export: { filename: 'surface', format: 'png' }, dpi: 60, colormap: 'magma',
    panels: [{ yLabel: '$s_2$', series: [
      { id: 'map', kind: 'heatmap', x: gx, y: gy, z: Z, colorbar: { label: '$F$ (kJ/mol)' } },
      { id: 'lines', kind: 'contour', x: gx, y: gy, z: Z, levels: 6, colors: '#ffffff', lineWidth: 0.6 }
    ] }]
  }),
  filled: () => ({
    title: 'Filled', export: { filename: 'filled', format: 'png' }, dpi: 60,
    panels: [{ series: [
      { id: 'bands', kind: 'contour', filled: true, x: gx, y: gy, z: Z, levels: [0, 4, 8, 12, 20, 30], colorbar: { label: 'Energy' } },
      { id: 'cmapLines', kind: 'contour', x: gx, y: gy, z: Z, levels: 4, colormap: 'Greys' }
    ] }]
  }),
  // A log x axis shared by two panels, the top one's data reaching 0: the
  // view starts from the smallest positive x of both panels (the lower
  // one's 0.01), as LogLocator.nonsingular has it since matplotlib 3.8; the
  // script tells 3.6 and 3.7, which took the top panel's 0.25.
  minpos: () => ({
    xScale: 'log', export: { filename: 'minpos', format: 'png' }, dpi: 50,
    panels: [
      { series: [{ kind: 'line', x: [0, 0.25, 9.75], y: [1, 1, 1] }] },
      { series: [{ kind: 'line', x: [0.01, 10], y: [1, 2] }] }
    ]
  }),
  // Log axes where matplotlib 3.11 places and labels ticks its own way: six
  // decades and five on short panels (a tick every second and every fifth
  // decade), and a log x axis from about 4 to 60, one decade tick, whose
  // minor ticks get labels.
  logTicks: () => ({
    xScale: 'log', width: 4, height: 3.2, export: { filename: 'logticks', format: 'png' }, dpi: 60,
    panels: [
      { yScale: 'log', series: [{ id: 'up', kind: 'line', x: [4, 15, 60], y: [1e-3, 1, 1e3], label: 'Up' }] },
      { ratio: 0.4, yScale: 'log', series: [{ id: 'down', kind: 'scatter', x: [4, 15, 60], y: [1e4, 30, 0.1] }] }
    ]
  }),
  // Error bars on log axes: matplotlib 3.8 to 3.10 take their limits in log
  // units when the axis is logarithmic as they are drawn, so the script sets
  // the scales after the data.
  logErrors: () => ({
    xScale: 'log', export: { filename: 'logerrors', format: 'png' }, dpi: 60,
    panels: [{ yScale: 'log', series: [
      { id: 'err', kind: 'errorbar', x: [1, 3, 10, 30, 100], y: [2, 5, 20, 60, 150], yerr: [0.5, 1, 4, 10, 30], xerr: [0.2, 0.5, 2, 5, 20], capSize: 2, label: 'Rates' }
    ] }, { ratio: 0.5, series: [
      { id: 'bars', kind: 'bar', x: [1, 3, 10, 30, 100], y: [1, 2, 3, 2, 1], yerr: [0.2, 0.3, 0.2, 0.4, 0.1], width: 0.2 }
    ] }]
  }),
  // "best" keeps clear of a band's outline and of text on the axes, as
  // matplotlib 3.9 and later weigh them.
  bestBand: () => ({
    export: { filename: 'bestband', format: 'png' }, dpi: 60,
    panels: [{ series: [
      { id: 'band', kind: 'band', x: range(60, (i) => i / 6), lower: range(60, (i) => i / 30 - 1), upper: range(60, (i) => i / 30 + 3), label: 'Band' },
      { id: 'mid', kind: 'line', x: range(60, (i) => i / 6), y: range(60, (i) => i / 30 + 1), label: 'Middle' }
    ] }]
  }),
  bestText: () => ({
    export: { filename: 'besttext', format: 'png' }, dpi: 60,
    panels: [{ series: [
      { id: 'fall', kind: 'line', x: [0, 10], y: [1, 0], label: 'Falling' },
      { id: 'note', kind: 'text', x: 9, y: 0.95, text: 'Note here' }
    ] }]
  }),
  panels: () => ({
    title: 'Two panels', xLabel: 'Time (ps)', height: 5.5, xScale: 'log',
    export: { filename: 'panels', format: 'png' }, dpi: 60,
    panels: [
      { id: 'cv', yLabel: 'CV', yScale: 'log', yTicks: { direction: 'in', minor: true }, series: [{ id: 'cv', kind: 'line', x: t.slice(1), y: t.slice(1).map((v) => 1 + v * v), label: 'CV' }] },
      { id: 'bias', ratio: 0.5, yLabel: 'Bias', yLim: [0, null], series: [{ id: 'bias', kind: 'line', x: t.slice(1), y: t.slice(1).map((v) => Math.log(v)), legend: false }] }
    ]
  })
};

/* Each case made once: its data are random. */
const FIGS = Object.fromEntries(Object.entries(CASES).map(([name, make]) => [name, make()]));
const runs = {};
beforeAll(async () => {
  if (!PYTHON) return;
  await Promise.all(Object.entries(FIGS).map(async ([name, fig]) => { runs[name] = await run(figureScript(fig)); }));
}, 180000);
afterAll(() => Object.values(runs).forEach((r) => rmSync(r.dir, { recursive: true, force: true })));

/* The preview's view of each panel: [x range, y range] in data units. */
function previewRanges(fig) {
  const f = normaliseFigure(fig);
  const layout = buildFigure(f).layout;
  return f.panels.map((p, i) => {
    const ax = layout[i === 0 ? 'xaxis' : `xaxis${i + 1}`]; const ay = layout[i === 0 ? 'yaxis' : `yaxis${i + 1}`];
    const un = (a) => (a.type === 'log' ? a.range.map((v) => 10 ** v) : a.range);
    return [un(ax), un(ay)];
  });
}
const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/* matplotlib's version, as [major, minor], from the run. */
const versionOf = (r) => r.fig.version.split('.').slice(0, 2).map(Number);
const atLeast = (r, minor) => { const [a, b] = versionOf(r); return a > 3 || (a === 3 && b >= minor); };
/* A tick label as text to compare: matplotlib's mathtext and the preview's HTML alike. */
const plainLabel = (t) => String(t)
  .replace(/\\mathdefault\{((?:[^{}]|\{[^{}]*\})*)\}/g, '$1').replace(/\$/g, '')
  .replace(/<sup>(.*?)<\/sup>/g, '^{$1}').replace(/\\times/g, '×')
  .replace(/[\s\u2006]/g, '').replace(/\u2212/g, '-');

describe('figureScript', () => {
  test('is deterministic, and keeps user text out of the code', () => {
    expect(figureScript(FIGS.lines)).toBe(figureScript(FIGS.lines));
    const code = figureScript({ title: "It's\nimport os", panels: [{ yLabel: '$\\tau$', series: [{ id: 'a\nimport os', kind: 'line', x: [1], y: [2], label: 'x\ny' }] }] });
    expect(code).not.toMatch(/^import os/m);
    expect(code).toContain("ax.set_title('It\\'s\\nimport os')");
    expect(code).toContain("ax.set_ylabel(r'$\\tau$')");
  });

  test('embeds each set of numbers once, at full precision', () => {
    const code = figureScript({ panels: [{ series: [
      { kind: 'line', x: { values: [0.1, 0.2], name: 'time' }, y: [1 / 3, 2] },
      { kind: 'line', x: { values: [0.1, 0.2], name: 'time' }, y: [5, 6] }
    ] }] });
    expect(code.match(/^time = np\.array/gm)).toHaveLength(1);
    expect(code).toContain(String(1 / 3));
  });

  test('names are readable and never clash with the script\'s own', () => {
    const taken = new Set();
    expect(identifier('fig', taken)).toBe('fig_2');
    expect(identifier('2 cv', taken)).toBe('_2_cv');
    expect(identifier('λ', taken)).toBe('λ');
    expect(identifier('λ', taken)).toBe('λ_2');
    expect(pyStr('a\\b')).toBe("r'a\\b'");
    expect(pyNum(Infinity)).toBe('np.inf');
  });

  test('a shared log x axis whose data reach 0 tells every panel where it starts', () => {
    const code = figureScript(FIGS.minpos);
    expect(code).toContain('x_min_positive = min(axes.dataLim.minposx for axes in (ax, ax_panel2))');
    expect(code).toContain('    axes.update_datalim([(x_min_positive, 1)], updatey=False)');
    // Only then: all x positive, one panel, or a linear axis need nothing.
    expect(figureScript(FIGS.panels)).not.toContain('update_datalim');
    expect(figureScript({ ...FIGS.minpos, panels: FIGS.minpos.panels.slice(0, 1) })).not.toContain('update_datalim');
    expect(figureScript({ ...FIGS.minpos, xScale: 'linear' })).not.toContain('update_datalim');
    // Bars, boxes and heatmaps reach 0 by their edges.
    const bars = { xScale: 'log', panels: [{ series: [{ kind: 'bar', x: [0.3, 1], y: [1, 2] }] }, { series: [{ kind: 'line', x: [1, 2], y: [1, 2] }] }] };
    expect(figureScript(bars)).toContain('update_datalim');
  });

  test('a million points read from a file make a short script', () => {
    const N = 1000000;
    const x = Array.from({ length: N }, (_, i) => i);
    const y = x.map((v) => Math.sin(v / 1000));
    const col = (values, column) => ({ values, source: 'colvar', column });
    const code = figureScript({ panels: [
      { series: [{ kind: 'line', x: col(x, 'time'), y: col(y, 'd1') }] },
      { series: [{ kind: 'histogram', values: col(y, 'd1'), bins: 100 }] }
    ] }, { data: 'files', files: { colvar: { file: 'COLVAR', format: 'table' } } });
    expect(code.length).toBeLessThan(20000);
    expect(code).toContain("d1 = colvar_columns['d1']");
    const embedded = figureScript({ panels: [{ series: [{ kind: 'line', x, y }] }] });
    expect(embedded).toContain('], dtype=float)');
  }, 180000);

  test('reads the columns a page names from the person\'s files', () => {
    const fig = { panels: [{ series: [
      { kind: 'line', x: { values: [0, 1], source: 'colvar', column: 'time' }, y: { values: [1, 2], source: 'colvar', column: 'd1' } },
      { kind: 'scatter', x: { values: [0], source: 'csv', column: 'dose' }, y: { values: [3], source: 'csv', column: 2 } }
    ] }] };
    const files = { colvar: { file: 'COLVAR', format: 'table' }, csv: { file: 'data.csv', format: 'csv', delimiter: ';' } };
    const embedded = figureScript(fig, { files });
    expect(embedded).not.toContain('read_table');
    const read = figureScript(fig, { data: 'files', files });
    expect(read).toContain("colvar_columns = read_table('COLVAR')");
    expect(read).toContain("time = colvar_columns['time']");
    expect(read).toContain("csv_columns = read_csv('data.csv', delimiter=';')");
    expect(read).toContain('csv_columns[2]');
  });
});

/* The fields added for the page agents: size units, grid along one axis,
   title and tick sizes, and lines a page draws after the series. */
const LOOKS = {
  width: 85 / 25.4, height: 60 / 25.4, sizeUnit: 'mm', title: 'Looks', titleSize: 14, tickSize: 7,
  grid: { show: true, axis: 'y', minor: true }, xCategories: ['A', 'B'], export: { filename: 'looks', format: 'png' }, dpi: 60,
  panels: [{ yLabel: 'Value', series: [{ id: 'bars', kind: 'bar', y: [3, 5], yerr: [0.4, 0.5] }] }]
};
const AFTER = (axes) => [
  '# test: a bracket worked out in Python',
  `${axes[0]}.plot([0, 0, 1, 1], [6, 6.3, 6.3, 6], color='black', linewidth=1, zorder=5)`,
  `${axes[0]}.text(0.5, 6.3, '**', ha='center', va='bottom', zorder=6)`
];

describe('size units, grid along one axis, text sizes and lines after the series', () => {
  test('the script says the size in the unit chosen and draws the grid along y only', () => {
    const code = figureScript(LOOKS, { after: AFTER });
    expect(code).toContain('# The figure is 85 x 60 mm; matplotlib takes its size in inches.');
    expect(code).toMatch(/axes\.grid\(True, which='major', axis='y'/);
    expect(code).toContain("'axes.titlesize': 14,");
    expect(code).toContain("'xtick.labelsize': 7, 'ytick.labelsize': 7,");
    expect(code.indexOf("ax.plot([0, 0, 1, 1]")).toBeGreaterThan(code.indexOf('ax.bar('));
    expect(code.indexOf("ax.plot([0, 0, 1, 1]")).toBeLessThan(code.indexOf('# Axes'));
    expect(figureScript(LOOKS, { after: ['x = 1'] })).toContain('\nx = 1\n');
    // The defaults write nothing new.
    const plain = figureScript({ panels: [{ series: [{ kind: 'line', x: [1, 2], y: [1, 2] }] }] });
    expect(plain).not.toMatch(/grid\(True, which='major', axis=|The figure is/);
    expect(plain).toContain("'axes.titlesize': 12,");
  });

  withPython('matplotlib draws them so', async () => {
    const r = await run(figureScript(LOOKS, { after: AFTER }));
    try {
      expect([r.code, r.stderr]).toEqual([0, '']);
      const [p] = r.fig.panels;
      expect(r.fig.size[0]).toBeCloseTo(85 / 25.4, 9);
      expect(r.fig.size[1]).toBeCloseTo(60 / 25.4, 9);
      expect(p.xgrid).toBe(false);
      expect(p.ygrid).toBe(true);
      expect(p.tickSize).toBeCloseTo(7, 9);
      expect(p.titleSize).toBeCloseTo(14, 9);
      expect(p.texts).toEqual(['**']);
      expect(p.lines).toBe(3);   // the error bars' two caps, and the bracket
      expect(p.ylim[1]).toBeGreaterThan(6.3);   // the bracket counts for the limits, as any ax.plot does
      expect(p.ylim[0]).toBe(0);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  }, 60000);
});

describe('the background picker in the script', () => {
  const page = { width: 3, height: 2, legend: { show: true }, panels: [{ series: [{ id: 'a', kind: 'line', x: [0, 1, 2], y: [0, 1, 0], label: 'a' }] }] };
  const CHOICES = [['white', {}, false], ['dark', {}, false], ['transparent', { ink: 'dark' }, true], ['transparent', { ink: 'light' }, true], ['custom', { background: '#fdf6e3' }, false]];
  const figureOf = (choice, opts, format) => normaliseFigure(applyStyle({ ...page, export: { filename: 'bg', format } }, withBackground({}, page, choice, opts)));

  test('savefig is transparent for the transparent choice, whatever the format', () => {
    for (const format of ['pdf', 'png', 'svg']) {
      for (const [choice, opts, clear] of CHOICES) {
        const code = figureScript(figureOf(choice, opts, format));
        expect(code).toMatch(new RegExp(`fig\\.savefig\\('bg\\.${format}', dpi=\\d+, transparent=${clear ? 'True' : 'False'}`));
      }
    }
    expect(figureScript(figureOf('transparent', { ink: 'light' }, 'png'))).toContain("'text.color': '#e2e8f0'");
  });

  withPython('the PNG is clear at its corners and the SVG has no page fill; White is opaque', async () => {
    const runs = [];
    try {
      for (const [format, choice, opts] of [['png', 'transparent', { ink: 'light' }], ['svg', 'transparent', { ink: 'dark' }], ['png', 'white', {}]]) {
        const r = await run(figureScript(figureOf(choice, opts, format)));
        runs.push(r);
        expect([r.code, r.stderr]).toEqual([0, '']);
        if (format === 'png') {
          const alpha = spawnSync('python3', ['-c', "import matplotlib.image as m; a = m.imread('bg.png'); print(a[0, 0, 3], a[-1, -1, 3], a[0, -1, 3])"], { cwd: r.dir, encoding: 'utf8' }).stdout.trim().split(/\s+/).map(Number);
          expect(alpha).toEqual(choice === 'transparent' ? [0, 0, 0] : [1, 1, 1]);
        } else {
          const svg = readFileSync(join(r.dir, 'bg.svg'), 'utf8');
          const patch = svg.match(/<g id="patch_1">\s*<path [^>]*style="([^"]*)"/);
          expect(patch && patch[1]).toMatch(/fill: none/);
        }
      }
    } finally {
      runs.forEach((r) => rmSync(r.dir, { recursive: true, force: true }));
    }
  }, 60000);
});

describe('a prelude and what is worked out from its names', () => {
  const fig = { panels: [
    { series: [{ kind: 'histogram', values: { values: [1, 2, 3], py: 'd' }, bins: 5, label: 'd' }] },
    { series: [{ kind: 'box', groups: [{ values: { values: [1, 2, 3, 4], py: 'd' } }, [2, 3, 4, 5]] }] }
  ] };
  const prelude = ['d = np.array([1., 2., 3., 4., 2.5])'];

  test('the data first, then the prelude, then the lines worked out from both', () => {
    const code = figureScript(fig, { prelude });
    const at = (t) => code.indexOf(t);
    expect(at('box1_group2 = np.array')).toBeLessThan(at(prelude[0]));
    expect(at(prelude[0])).toBeLessThan(at('np.histogram(d[np.isfinite(d)]'));
    expect(at(prelude[0])).toBeLessThan(at('box1_groups = [d[np.isfinite(d)]'));
  });

  withPython('runs without a NameError', async () => {
    const r = await run(figureScript(fig, { prelude }));
    try {
      expect([r.code, r.stderr]).toEqual([0, '']);
      expect(r.fig.panels[0].patches).toEqual(['StepPatch']);
      expect(r.fig.panels[1].patches.filter((x) => x === 'PathPatch')).toHaveLength(2);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  }, 60000);
});

describe('a legend title wider than its entries', () => {
  const fig = { legend: { title: 'Running mean, 10 points' }, export: { filename: 'legend', format: 'png' }, dpi: 60,
    panels: [{ series: [{ id: 'a', kind: 'line', x: [0, 1, 2], y: [0, 1, 4], label: 'a' }, { id: 'b', kind: 'line', x: [0, 1, 2], y: [1, 2, 3], label: 'b' }] }] };

  test('the preview centres the entries under it', () => {
    const { box, entries } = buildFigure(fig).info.legendLayouts[0];
    const left = entries.l - box.l; const right = box.r - entries.r;
    expect(left).toBeCloseTo(right, 9);
    expect(left).toBeGreaterThan(10);   // well in from the frame
  });

  withPython('as matplotlib centres them (VPacker align=\'center\')', async () => {
    const probe = [
      '',
      'fig.canvas.draw()',
      '_r = fig.canvas.get_renderer()',
      '_lg = ax.get_legend()',
      '_box = _lg.get_window_extent(_r)',
      '_hb = _lg._legend_handle_box.get_window_extent(_r)',
      "print('@@LEG@@', _hb.x0 - _box.x0, _box.x1 - _hb.x1, fig.dpi)"
    ].join('\n');
    const r = await run(figureScript(fig) + probe);
    try {
      expect([r.code, r.stderr]).toEqual([0, '']);
      const [left, right, dpi] = r.stdout.split('\n').find((l) => l.startsWith('@@LEG@@')).split(' ').slice(1).map(Number);
      expect(Math.abs(left - right)).toBeLessThan(1.5);   // centred, to a pixel
      // The preview's gap, in the same units (points), is matplotlib's to within its font metrics.
      const { box, entries } = buildFigure(fig).info.legendLayouts[0];
      const previewGap = ((entries.l - box.l) * 72) / 96;
      const mplGap = (left * 72) / dpi;
      expect(Math.abs(previewGap - mplGap)).toBeLessThan(0.25 * mplGap + 3);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  }, 60000);
});

describe('the page\'s names are left alone', () => {
  const prelude = [
    'fit = stats.linregress([1, 2, 3], [2, 4.1, 5.9])',
    'mean = 42.0',
    'values = [7, 8, 9]',
    'position, half = 3, 0.5'
  ];
  const fig = {
    xCategories: ['A', 'B'],
    panels: [{ series: [
      { id: 'fit', kind: 'line', x: [0, 1], y: [1, 2], label: 'Fit' },
      { id: 'values', kind: 'scatter', x: [0, 1], y: [2, 1], label: 'Values' },
      { id: 'box', kind: 'box', groups: [[1, 2, 3, 4], [2, 3, 5, 6]], points: true, mean: true }
    ] }]
  };
  const after = (axes) => [`${axes[0]}.text(0, fit.slope, f'{mean:.0f} {len(values)} {position} {half}')`, 'check = (fit.slope, mean, values, position, half)'];
  const options = { prelude, after, imports: ['from scipy import stats'], names: ['reserved'] };

  test('the series and the script\'s own loop take other names; the header lists scipy', () => {
    const code = figureScript(fig, options);
    expect(code).toMatch(/^fit_2, = ax\.plot\(/m);
    expect(code).toMatch(/^values_2, = ax\.plot\(/m);
    expect(code).toContain('for _position, _values in zip(');
    expect(code).toContain('# Needs numpy, scipy and matplotlib 3.6 or later (3.11 or later to match the preview).');
    expect(code).not.toMatch(/^reserved\b/m);
    const plain = figureScript({ panels: [{ series: [{ kind: 'line', x: [1, 2], y: [1, 2] }] }] });
    expect(plain).toContain('# Needs numpy and matplotlib 3.6 or later (3.11 or later to match the preview).');
    expect(figureScript(fig, { prelude: ['stats = {}'] })).toContain('from scipy import stats as scipy_stats');
    expect(figureScript({ panels: [] }, { prelude: ['import pandas as pd'] })).toContain('# Needs numpy, pandas and matplotlib 3.6 or later (3.11 or later to match the preview).');
  });

  withPython('the prelude\'s values survive the figure', async () => {
    const code = figureScript(fig, options) + "\nprint('@@CHECK@@', check[0] > 1.9, check[1], check[2], check[3], check[4])\n";
    const r = await run(code);
    try {
      expect([r.code, r.stderr]).toEqual([0, '']);
      expect(r.stdout).toContain('@@CHECK@@ True 42.0 [7, 8, 9] 3 0.5');
      expect(r.fig.panels[0].texts).toEqual(['42 3 3 0.5']);
      expect(r.fig.panels[0].legend).toEqual(['Fit', 'Values']);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  }, 60000);
});

describe('the script runs and draws what the page describes', () => {
  withPython('without errors or warnings, saving the file asked for', () => {
    for (const [name, r] of Object.entries(runs)) {
      expect([name, r.code, r.stderr]).toEqual([name, 0, '']);
      const { filename, format } = normaliseFigure(FIGS[name]).export;
      expect(existsSync(join(r.dir, `${filename}.${format}`))).toBe(true);
    }
  });

  withPython('the axis limits matplotlib picks are the preview\'s', () => {
    for (const [name, r] of Object.entries(runs)) {
      const want = previewRanges(FIGS[name]);
      r.fig.panels.forEach((p, i) => {
        const [x, y] = want[i];
        const ok = [...p.xlim.map((v, k) => close(v, x[k])), ...p.ylim.map((v, k) => close(v, y[k]))].every(Boolean);
        if (!ok) throw new Error(`${name} panel ${i + 1}: matplotlib x ${p.xlim} y ${p.ylim}, preview x ${x} y ${y}`);
      });
    }
  });

  withPython('the ticks, their labels and the legend\'s place are the preview\'s', () => {
    // On log axes the ticks follow matplotlib 3.11, which changed the decades
    // a log axis ticks and which minor ticks it labels; minor ticks on a
    // linear axis follow 3.8; "best" weighs bands and text from 3.9 on. Older
    // versions are held to what has not changed since.
    let checked = 0;
    for (const [name, r] of Object.entries(runs)) {
      const f = normaliseFigure(FIGS[name]);
      const { info } = buildFigure(f);
      r.fig.panels.forEach((p, i) => {
        for (const k of ['x', 'y']) {
          const log = (k === 'x' ? f.xScale : f.panels[i].yScale) === 'log';
          if (log && !atLeast(r, 11)) continue;
          const [lo, hi] = log ? p[`${k}lim`].map(Math.log10) : p[`${k}lim`];
          const at = (v) => (log ? Math.log10(v) : v);
          for (const which of ['major', 'minor']) {
            if (which === 'minor' && !log && !atLeast(r, 8)) continue;
            const got = p.ticks[k][which];
            const want = info.ticks[i][k][which];
            const where = `${name} panel ${i + 1} ${k} ${which}`;
            expect([where, got.length]).toEqual([where, want.length]);
            got.forEach(([v, text], j) => {
              expect([where, Math.abs(at(v) - at(want[j].v)) <= 1e-9 * Math.abs(hi - lo)]).toEqual([where, true]);
              expect([where, plainLabel(text)]).toEqual([where, plainLabel(want[j].text)]);
              checked++;
            });
          }
        }
        if (atLeast(r, 9)) {
          const same = (a) => (a === 'center right' ? 'right' : a);
          expect([name, i, same(p.legendLoc)]).toEqual([name, i, same(info.legends[i])]);
        }
      });
    }
    expect(checked).toBeGreaterThan(50);
  });

  withPython('lines, bands, reference lines and notes', () => {
    const [p] = runs.lines.fig.panels;
    expect(p.collections).toEqual(['PolyCollection']);
    expect(p.lines).toBe(4);   // two lines, hline, vline
    expect(p.legend).toEqual(['Spread', 'CV', 'Steps', 'Threshold']);
    expect(p.texts).toEqual(['A note']);
    expect(p.lineColors[0]).toBe(normaliseFigure(FIGS.lines).panels[0].series[1].color);
  });

  withPython('error bars in x and y, scatter, axline, and a titled legend in two columns', () => {
    const [p] = runs.points.fig.panels;
    expect(p.containers).toEqual(['ErrorbarContainer', 'ErrorbarContainer']);
    expect(p.legend).toEqual(['y = x', 'Samples', 'Controls', 'Bars only']);
    expect(p.legendTitle).toBe('Kind');
  });

  withPython('grouped bars on categories, with error bars and a bracket', () => {
    const [p] = runs.bars.fig.panels;
    expect(p.containers.filter((c) => c === 'BarContainer')).toHaveLength(2);
    expect(p.patches).toHaveLength(6);
    expect(p.xticklabels).toEqual(['Control', 'Drug A', 'Drug B']);
    expect(p.texts).toEqual(['**']);
    expect(p.legend).toEqual(['Wild type', 'Mutant']);
    expect(readFileSync(join(runs.bars.dir, 'bars.pdf')).subarray(0, 5).toString()).toBe('%PDF-');
  });

  withPython('box plots with points and the mean with its interval', () => {
    const [p] = runs.boxes.fig.panels;
    expect(p.patches.filter((x) => x === 'PathPatch')).toHaveLength(3);
    expect(p.containers).toHaveLength(3);   // a mean with its interval for each box
    expect(p.xticklabels).toEqual(['A', 'B', 'C']);
    expect(p.legend).toBeNull();
  });

  withPython('histograms: filled, outline and already binned', () => {
    const [p] = runs.hist.fig.panels;
    expect(p.patches.filter((x) => x === 'StepPatch')).toHaveLength(2);
    expect(p.containers).toEqual(['BarContainer']);
    expect(p.legend).toEqual(['A', 'B', 'Binned']);
  });

  withPython('a heatmap with contour lines and a colour bar; filled contours with theirs', () => {
    const s = runs.surface.fig;
    expect(s.panels).toHaveLength(1);
    expect(s.panels[0].collections).toContain('QuadMesh');
    expect(s.colorbars).toEqual([{ label: '$F$ (kJ/mol)', ylim: expect.any(Array) }]);
    const f = runs.filled.fig;
    expect(f.colorbars[0].label).toBe('Energy');
    expect(f.colorbars[0].ylim).toEqual([0, 30]);
  });

  withPython('a shared log x axis starts from the smallest positive x of all the panels', () => {
    const [top] = runs.minpos.fig.panels;
    expect(top.xlim[0]).toBeCloseTo(0.0070795, 6);
    expect(top.xlim[1]).toBeCloseTo(14.1254, 3);
  });

  withPython('two panels sharing a log x axis, with their own y', () => {
    const f = runs.panels.fig;
    expect(f.panels).toHaveLength(2);
    expect(f.panels[0].xscale).toBe('log');
    expect(f.panels[0].yscale).toBe('log');
    expect(f.panels[1].ylim[0]).toBe(0);
    expect(f.panels[1].xlabel).toBe('Time (ps)');
    expect(f.panels[0].xlabel).toBe('');
    expect(f.size).toEqual([6.4, 5.5]);
  });

  withPython('reads a PLUMED COLVAR, a CSV file and a listed grid', async () => {
    const colvar = '#! FIELDS time d1 d2\n#! SET min_d1 0\n' + range(6, (i) => `${i} ${i * 0.5} ${10 - i}`).join('\n') + '\n# a comment\n';
    const csv = 'dose; response ;other\n1;2;x\n2;;y\n3;6;z\n';
    const fes = range(3, (j) => range(4, (i) => `${i} ${j} ${i + 10 * j}`).join('\n')).join('\n\n') + '\n';
    const fig = { panels: [{ series: [
      { kind: 'line', x: { values: [], source: 'colvar', column: 'time' }, y: { values: [], source: 'colvar', column: 2 } },
      { kind: 'scatter', x: { values: [], source: 'csv', column: 'dose' }, y: { values: [], source: 'csv', column: 'response' } },
      { kind: 'heatmap', x: [0], y: [0], z: { values: [[0]], source: 'fes', column: 2, x: 0, y: 1 } }
    ] }] };
    const files = { colvar: { file: 'COLVAR', format: 'table' }, csv: { file: 'data.csv', format: 'csv', delimiter: ';' }, fes: { file: 'fes.dat', format: 'table' } };
    const r = await run(figureScript(fig, { data: 'files', files }), { COLVAR: colvar, 'data.csv': csv, 'fes.dat': fes });
    try {
      expect([r.code, r.stderr]).toEqual([0, '']);
      const [p] = r.fig.panels;
      expect(p.lineData[0]).toEqual([10, 9, 8]);                      // the third column, by number
      expect(p.lineData[1]).toEqual([2, null, 6]);                     // response, by its header; a blank cell is NaN
      expect(p.xlim[0]).toBeLessThanOrEqual(-0.5);                     // the grid's cells reach half a step out
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  }, 60000);
});

/* ------------------------------------------------------------------ *
 * Second axes: twinx and twiny
 * ------------------------------------------------------------------ */

/* What each axes the script names (ax, ax_right, ax_top …) drew. */
const TWIN_INSPECT = String.raw`

# --- test only: report each axes by its name ---
import json as _json
import math as _math
import matplotlib as _mpl
from matplotlib.colors import to_hex as _hex
fig.canvas.draw()


def _ticks(axis):
    log = axis.get_scale() == 'log'
    t = _math.log10 if log else float
    lo, hi = sorted(axis.get_view_interval())
    a, b = t(lo), t(hi)
    tol = (b - a) * 1e-10
    out = {}
    for which, locs, fmt in (('major', axis.get_majorticklocs(), axis.get_major_formatter()),
                             ('minor', axis.get_minorticklocs(), axis.get_minor_formatter())):
        locs = [float(v) for v in locs]
        labels = fmt.format_ticks(locs) if locs else []
        out[which] = [[v, s] for v, s in zip(locs, labels) if (v > 0 or not log) and a - tol <= t(v) <= b + tol]
    return out


def _axes(a):
    leg = a.get_legend()
    return {
        'xlim': [float(v) for v in a.get_xlim()], 'ylim': [float(v) for v in a.get_ylim()],
        'xscale': a.get_xscale(), 'yscale': a.get_yscale(), 'xlabel': a.get_xlabel(), 'ylabel': a.get_ylabel(),
        'xlabelColor': _hex(a.xaxis.label.get_color()), 'ylabelColor': _hex(a.yaxis.label.get_color()),
        'spines': {k: v.get_visible() for k, v in a.spines.items()},
        'spineColors': {k: _hex(v.get_edgecolor()) for k, v in a.spines.items()},
        'xticks': _ticks(a.xaxis), 'yticks': _ticks(a.yaxis),
        'yticksAt': a.yaxis.get_ticks_position(), 'xticksAt': a.xaxis.get_ticks_position(),
        'legend': [t.get_text() for t in leg.get_texts()] if leg else None,
        'lines': len(a.get_lines()), 'containers': [type(c).__name__ for c in a.containers],
        'lineData': [[float(v) for v in l.get_ydata()[:2]] for l in a.get_lines()],
    }


print('@@FIG@@' + _json.dumps({
    'version': _mpl.__version__,
    'axes': {k: _axes(v) for k, v in list(globals().items()) if k.startswith('ax') and isinstance(v, _mpl.axes.Axes)},
}))
`;

describe('second axes: a y axis on the right, an x axis on top', () => {
  const tt = range(25, (i) => i * 4);
  const TWINS = {
    // Temperature and pressure against time: the pressure on a log axis on the right, with error bars.
    right: () => ({
      title: 'Heating', xLabel: 'Time (s)', yTicks: { mirror: true }, export: { filename: 'right', format: 'png' }, dpi: 50,
      panels: [{ yLabel: 'T (K)', yTicks: { mirror: true, direction: 'in' }, y2Label: 'p (kPa)', y2Scale: 'log', y2Color: 'auto', y2Ticks: { minor: true },
        series: [
          { id: 'T', kind: 'line', x: tt, y: tt.map((v) => 290 + 30 * (1 - Math.exp(-v / 30))), label: 'Temperature' },
          { id: 'p', kind: 'errorbar', x: tt, y: tt.map((v) => 100 * Math.exp(v / 40)), yerr: tt.map((v) => 5 + v / 10), capSize: 2, yAxis: 'right', label: 'Pressure' }
        ] }]
    }),
    // A spectrum: wavelength along the bottom, the same data by wavenumber on top, with limits of its own.
    top: () => ({
      title: 'Spectrum', xLabel: 'Wavelength (nm)', export: { filename: 'top', format: 'png' }, dpi: 50,
      panels: [{ yLabel: 'Absorbance', x2Label: 'Wavenumber (cm$^{-1}$)', x2Lim: [12000, null], x2Color: '#7b61c9',
        series: [
          { id: 'byWl', kind: 'line', x: range(31, (i) => 400 + 10 * i), y: range(31, (i) => Math.exp(-(((i - 15) / 5) ** 2))), label: 'by wavelength' },
          { id: 'byWn', kind: 'scatter', x: range(31, (i) => 1e7 / (400 + 10 * i)), y: range(31, (i) => Math.exp(-(((i - 15) / 5) ** 2))), xAxis: 'top', label: 'by wavenumber' }
        ] }]
    }),
    // Both at once in the top panel, bars on the right; a shared log x reaching 0, and a plain second panel.
    both: () => ({
      xScale: 'log', height: 5, export: { filename: 'both', format: 'png' }, dpi: 50,
      panels: [
        { id: 'upper', y2Label: 'Right', x2Label: 'Top', series: [
          { id: 'l', kind: 'line', x: [0, 1, 10, 100], y: [1, 2, 3, 4], label: 'left' },
          { id: 'r', kind: 'bar', x: [1, 10, 100], y: [5, 50, 20], width: 0.5, yAxis: 'right', label: 'right' },
          { id: 'tl', kind: 'line', x: [-5, 5], y: [2, 3], xAxis: 'top', label: 'top' },
          { id: 'tr', kind: 'scatter', x: [-3, 0, 3], y: [10, 30, 60], xAxis: 'top', yAxis: 'right', label: 'top right' }
        ] },
        { id: 'lower', ratio: 0.6, series: [{ id: 'low', kind: 'line', x: [0.5, 50], y: [3, 1] }] }
      ]
    })
  };
  const FIG = Object.fromEntries(Object.entries(TWINS).map(([k, make]) => [k, make()]));
  const got = {};
  beforeAll(async () => {
    if (!PYTHON) return;
    await Promise.all(Object.entries(FIG).map(async ([k, fig]) => { got[k] = await run(figureScript(fig), {}, TWIN_INSPECT); }));
  }, 120000);
  afterAll(() => Object.values(got).forEach((r) => rmSync(r.dir, { recursive: true, force: true })));

  test('twinx, twiny and both, the series drawn against their own axes', () => {
    const right = figureScript(FIG.right);
    expect(right).toContain('ax_right = ax.twinx()');
    expect(right).not.toContain('twiny');
    expect(right).toMatch(/^p = ax_right\.errorbar\(/m);
    expect(right).toMatch(/^T, = ax\.plot\(/m);
    expect(right).toContain("ax_right.set_yscale('log')");
    expect(right).toContain("ax_right.set_ylabel('p (kPa)')");
    expect(right).toContain(`ax_right.tick_params(axis='y', which='both', colors='${normaliseFigure(FIG.right).panels[0].series[1].color}')`);
    expect(right).toContain("ax.spines['right'].set_visible(False)");
    // The left axis' marks stay off the right side, where the right axis has its own.
    expect(right).not.toContain("axes.tick_params(axis='y', which='both', right=True)");
    // One legend for both axes, on the axes drawn last.
    expect(right).toContain('ax_right.legend(handles=[T, p]');
    const both = figureScript(FIG.both);
    for (const line of ['ax_right = ax.twinx()', 'ax_top = ax.twiny()', 'ax_top_right = ax_right.twiny()', 'ax_top_right.sharex(ax_top)', 'ax_top_right.xaxis.set_visible(False)']) expect(both).toContain(line);
    expect(both).toMatch(/^tr, = ax_top_right\.plot\(/m);
    expect(both).toContain('ax_top_right.legend(handles=[l, r, tl, tr]');
    expect(both).toContain("ax_top.set_xlabel('Top')");
    expect(both).not.toMatch(/ax_lower_(right|top)/);
    // A figure without second axes is written as before.
    expect(figureScript(FIGS.lines)).not.toMatch(/twin[xy]/);
  });

  withPython('runs, and matplotlib\'s twins have the limits, scales and ticks the preview shows', () => {
    for (const [name, r] of Object.entries(got)) {
      expect([name, r.code, r.stderr]).toEqual([name, 0, '']);
      const f = normaliseFigure(FIG[name]);
      const { info } = buildFigure(f);
      const views = info.views;
      const pairs = [['ax', 0, 'x', 'y'], ['ax_right', 0, 'x', 'y2'], ['ax_top', 0, 'x2', 'y'], ['ax_top_right', 0, 'x2', 'y2']];
      if (name === 'both') pairs.push(['ax_lower', 1, 'x', 'y']);
      for (const [axes, i, kx, ky] of pairs) {
        const a = r.fig.axes[axes];
        if (!views[i][kx] || !views[i][ky]) { expect([name, axes, a]).toEqual([name, axes, undefined]); continue; }
        const where = `${name} ${axes}`;
        const same = (lim, v) => lim.every((x, k) => close(x, v.view[k]));
        if (!same(a.xlim, views[i][kx]) || !same(a.ylim, views[i][ky])) {
          throw new Error(`${where}: matplotlib x ${a.xlim} y ${a.ylim}, preview x ${views[i][kx].view} y ${views[i][ky].view}`);
        }
        expect([where, a.xscale, a.yscale]).toEqual([where, views[i][kx].log ? 'log' : 'linear', views[i][ky].log ? 'log' : 'linear']);
      }
      // The second axes' ticks and labels, as the preview has them (log axes as matplotlib 3.11 ticks them).
      for (const [axes, k, key] of [['ax_right', 'y2', 'yticks'], ['ax_top', 'x2', 'xticks']]) {
        const a = r.fig.axes[axes];
        if (!a || !info.ticks[0][k]) continue;
        if (views[0][k].log && !atLeast(r, 11)) continue;
        for (const which of ['major', 'minor']) {
          if (which === 'minor' && !views[0][k].log && !atLeast(r, 8)) continue;
          const want = info.ticks[0][k][which];
          const have = a[key][which];
          expect([name, axes, which, have.map(([, t]) => plainLabel(t))]).toEqual([name, axes, which, want.map((t) => plainLabel(t.text))]);
        }
      }
    }
  });

  withPython('one legend with the series of every axes; frame lines and labels where they belong, in their colours', () => {
    const right = got.right.fig.axes;
    const colour = normaliseFigure(FIG.right).panels[0].series[1].color;
    expect(right.ax_right.legend).toEqual(['Temperature', 'Pressure']);
    expect(right.ax.legend).toBeNull();
    expect(right.ax_right.ylabel).toBe('p (kPa)');
    expect(right.ax_right.ylabelColor).toBe(colour);
    expect(right.ax_right.spineColors.right).toBe(colour);
    expect(right.ax_right.spines).toEqual({ left: false, right: true, bottom: false, top: false });
    expect(right.ax.spines.right).toBe(false);
    expect(right.ax.yticksAt).toBe('left');
    expect(right.ax_right.yticksAt).toBe('right');
    expect(right.ax_right.containers).toEqual(['ErrorbarContainer']);
    const top = got.top.fig.axes;
    expect(top.ax_top.xlabel).toBe('Wavenumber (cm$^{-1}$)');
    expect(top.ax_top.xlabelColor).toBe('#7b61c9');
    expect(top.ax_top.xlim[0]).toBe(12000);
    expect(top.ax_top.xticksAt).toBe('top');
    expect(top.ax.xticksAt).toBe('bottom');
    const both = got.both.fig.axes;
    expect(both.ax_top_right.legend).toEqual(['left', 'right', 'top', 'top right']);
    expect(both.ax_top_right.spines).toEqual({ left: false, right: false, bottom: false, top: false });
    expect(both.ax_right.containers).toEqual(['BarContainer']);
    expect(both.ax_lower.legend).toBeNull();
  });

  withPython('reads the data from the person\'s file for the series on either axis', async () => {
    const csv = 'time,temp,pres\n' + tt.map((v) => `${v},${290 + v / 4},${100 + v}`).join('\n') + '\n';
    const fig = { panels: [{ y2Label: 'p', series: [
      { id: 'T', kind: 'line', x: { values: tt, source: 'run', column: 'time' }, y: { values: tt.map((v) => 290 + v / 4), source: 'run', column: 'temp' } },
      { id: 'p', kind: 'line', x: { values: tt, source: 'run', column: 'time' }, y: { values: tt.map((v) => 100 + v), source: 'run', column: 'pres' }, yAxis: 'right' }
    ] }] };
    const code = figureScript(fig, { data: 'files', files: { run: { file: 'run.csv', format: 'csv' } } });
    expect(code).toContain("read_csv('run.csv')");
    const r = await run(code, { 'run.csv': csv }, TWIN_INSPECT);
    try {
      expect([r.code, r.stderr]).toEqual([0, '']);
      expect(r.fig.axes.ax_right.lineData[0]).toEqual([100, 104]);
      expect(r.fig.axes.ax.lineData[0]).toEqual([290, 291]);
      const views = buildFigure(fig).info.views[0];
      expect(r.fig.axes.ax_right.ylim.every((v, k) => close(v, views.y2.view[k]))).toBe(true);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  }, 60000);
});

/* ------------------------------------------------------------------ *
 * Horizontal and stacked bars, histogram options, box options, violins,
 * bars of means
 * ------------------------------------------------------------------ */

/* What each axes the script names drew, artist by artist. */
const KINDS_INSPECT = String.raw`

# --- test only: report the artists of each axes ---
import json as _json
import math as _math
import matplotlib as _mpl
from matplotlib.patches import Rectangle as _Rectangle, StepPatch as _StepPatch, PathPatch as _PathPatch
from matplotlib.collections import PolyCollection as _PolyCollection
from matplotlib.container import ErrorbarContainer as _ErrorbarContainer
fig.canvas.draw()


def _n(v):
    v = float(v)
    return None if v != v else v


def _ticks(axis):
    log = axis.get_scale() == 'log'
    t = _math.log10 if log else float
    lo, hi = sorted(axis.get_view_interval())
    a, b = t(lo), t(hi)
    tol = (b - a) * 1e-10
    locs = [float(v) for v in axis.get_majorticklocs()]
    labels = axis.get_major_formatter().format_ticks(locs) if locs else []
    return [[v, s] for v, s in zip(locs, labels) if (v > 0 or not log) and a - tol <= t(v) <= b + tol]


def _axes(a):
    leg = a.get_legend()
    return {
        'xlim': [float(v) for v in a.get_xlim()], 'ylim': [float(v) for v in a.get_ylim()],
        'xscale': a.get_xscale(), 'yscale': a.get_yscale(), 'xlabel': a.get_xlabel(), 'ylabel': a.get_ylabel(),
        'bars': [[_n(p.get_x()), _n(p.get_y()), _n(p.get_width()), _n(p.get_height())] for p in a.patches if isinstance(p, _Rectangle)],
        'stairs': [{'values': [_n(v) for v in p.get_data().values], 'edges': [_n(v) for v in p.get_data().edges]}
                   for p in a.patches if isinstance(p, _StepPatch)],
        'paths': [[[_n(x), _n(y)] for x, y in p.get_path().vertices] for p in a.patches if isinstance(p, _PathPatch)],
        'polys': [[[_n(x), _n(y)] for x, y in c.get_paths()[0].vertices] for c in a.collections if isinstance(c, _PolyCollection)],
        'lines': [{'x': [_n(v) for v in l.get_xdata()], 'y': [_n(v) for v in l.get_ydata()], 'style': l.get_linestyle(),
                   'width': l.get_linewidth(), 'marker': l.get_marker()} for l in a.get_lines()],
        'errors': [[[[_n(v) for v in pt] for pt in seg] for seg in col.get_segments()]
                   for c in a.containers if isinstance(c, _ErrorbarContainer) for col in c[2]],
        'legend': [t.get_text() for t in leg.get_texts()] if leg else None,
        'xticks': _ticks(a.xaxis), 'yticks': _ticks(a.yaxis),
    }


print('@@FIG@@' + _json.dumps({
    'version': _mpl.__version__,
    'axes': {k: _axes(v) for k, v in list(globals().items()) if k.startswith('ax') and k != 'axes' and isinstance(v, _mpl.axes.Axes)},
}))
`;

describe('horizontal and stacked bars, histogram options, box options, violins and bars of means', () => {
  const reps = range(46, (i) => 5 + (i % 4) * 1.3 + gauss());
  const codes = range(46, (i) => (i === 45 ? 4 : i % 4));          // the last row is the only one of its group
  const wide = range(60, () => 5 + 2 * gauss());
  const narrow = range(80, () => 6 + 0.5 * gauss());
  const KINDS = {
    // Grouped bars lying flat on named places, with error bars along x.
    hbar: () => ({
      xLabel: 'Activity', export: { filename: 'hbar', format: 'png' }, dpi: 50,
      panels: [{ yLabel: 'Sample', yCategories: ['Drug B', 'Drug A', 'Control'], series: [
        { id: 'wt', kind: 'bar', orientation: 'h', y: [2, 1, 0], x: [4.1, 6.3, 5.2], xerr: [0.4, 0.5, 0.6], label: 'Wild type' },
        { id: 'mut', kind: 'bar', orientation: 'h', y: [2, 1, 0], x: [3.2, 3.9, 5.8], xerr: [[0.3, 0.2, 0.1], [0.45, 0.5, 0.2]], label: 'Mutant' }
      ] }]
    }),
    // Lying flat on a log axis, from 1, placed by numbers 5 apart and 4 wide.
    hlog: () => ({
      xScale: 'log', export: { filename: 'hlog', format: 'png' }, dpi: 50,
      panels: [{ series: [{ id: 'a', kind: 'bar', orientation: 'h', y: [0, 5, 10], x: [3, 300, 30], bottom: 1, width: 4 }] }]
    }),
    // Upright bars 5 apart and 4 wide, each on a base of its own.
    wide: () => ({
      export: { filename: 'wide', format: 'png' }, dpi: 50,
      panels: [{ series: [{ id: 'a', kind: 'bar', x: [0, 5, 10, 20], y: [1, 2, 3, 2], width: 4, bottom: [0.5, 1, -1, 0], yerr: [0.1, 0.2, 0.1, 0.3] }] }]
    }),
    // A stack with values below zero, a missing value and error bars, and a series beside it.
    stack: () => ({
      xCategories: ['Q1', 'Q2', 'Q3', 'Q4'], export: { filename: 'stack', format: 'pdf' },
      panels: [{ series: [
        { id: 'a', kind: 'bar', y: [3, 4, -2, 5], stack: 'stack', label: 'A', yerr: [0.3, 0.2, 0.4, 0.1] },
        { id: 'b', kind: 'bar', y: [2, -1, 3, 1], stack: 'stack', label: 'B' },
        { id: 'c', kind: 'bar', y: [1, 2, 2, NaN], stack: 'stack', label: 'C', yerr: [0.3, 0.2, 0.4, 0.1] },
        { id: 'd', kind: 'bar', y: [4, 4, 4, 4], label: 'Beside' }
      ] }]
    }),
    // To 100%, the series at different positions, errors below and above.
    percent: () => ({
      export: { filename: 'percent', format: 'png' }, dpi: 50,
      panels: [{ series: [
        { id: 'a', kind: 'bar', x: [0, 5, 10, 15], y: [3, 4, 2, 5], stack: 'percent', label: 'A', width: 4 },
        { id: 'b', kind: 'bar', x: [0, 5, 10], y: [2, 1, 3], stack: 'percent', label: 'B', width: 4, yerr: [[0.2, 0.2, 0.2], [0.4, 0.4, 0.4]] },
        { id: 'c', kind: 'bar', x: [5, 10, 15, 20], y: [1, 2, 2, 0], stack: 'percent', label: 'C', width: 4 }
      ] }]
    }),
    // Lying flat and stacked to 100%; and a stack on the right axis of a second panel.
    hstack: () => ({
      height: 5, export: { filename: 'hstack', format: 'png' }, dpi: 50,
      panels: [
        { yCategories: ['c', 'b', 'a'], series: [
          { id: 'a', kind: 'bar', orientation: 'h', x: [3, 4, 2], stack: 'percent', label: 'A', xerr: [0.3, 0.4, 0.2] },
          { id: 'b', kind: 'bar', orientation: 'h', x: [2, 1, 3], stack: 'percent', label: 'B' }] },
        { id: 'lower', y2Label: 'Right', series: [
          { id: 'l', kind: 'line', x: [0, 1, 2], y: [1, 3, 2], label: 'Line' },
          { id: 'r1', kind: 'bar', x: [0, 1, 2], y: [10, 20, 30], stack: 'stack', yAxis: 'right', label: 'R1' },
          { id: 'r2', kind: 'bar', x: [0, 1, 2], y: [5, 5, 5], stack: 'stack', yAxis: 'right', label: 'R2' }] }
      ]
    }),
    // numpy's rules, the ways to scale, running totals, and a log y axis.
    hist: () => ({
      height: 5, export: { filename: 'hist', format: 'png' }, dpi: 50,
      panels: [{ series: [
        { id: 'a', kind: 'histogram', values: range(300, () => gauss()), bins: 'fd', normalise: 'percent', label: 'A' },
        { id: 'b', kind: 'histogram', values: range(200, () => 1 + gauss() * 0.5), bins: 'auto', normalise: 'fraction', cumulative: true, histtype: 'step', label: 'B' },
        { id: 'e', kind: 'histogram', values: [...range(90, () => 4 + gauss()), NaN], bins: [1, 3, 4, 4.5, 5, 7], normalise: 'density', cumulative: true, histtype: 'bar', label: 'E' }
      ] }, { id: 'lower', yScale: 'log', series: [
        { id: 'c', kind: 'histogram', values: range(300, () => gauss()), bins: 'doane', density: true },
        { id: 'd', kind: 'histogram', values: range(300, () => gauss() * 2), bins: 'scott', cumulative: true, histtype: 'step' },
        { id: 'f', kind: 'histogram', values: range(120, () => gauss() * 2), bins: 'rice' },
        { id: 'g', kind: 'histogram', values: range(120, () => gauss() * 2), bins: 'sturges', normalise: 'fraction' },
        { id: 'h', kind: 'histogram', values: range(120, () => gauss() * 2), bins: 'sqrt', normalise: 'percent', cumulative: true }
      ] }]
    }),
    // Whiskers at percentiles, notches, and the mean with a 99% interval.
    box: () => ({
      xCategories: ['A', 'B', 'C'], export: { filename: 'box', format: 'png' }, dpi: 50,
      panels: [{ series: [{ id: 'box', kind: 'box', groups: [range(15, () => 5 + gauss()), [...range(20, () => 6 + gauss()), 14], range(9, () => 4 + 2 * gauss())],
        whis: [5, 95], notch: true, mean: true, level: 0.99, meanOffset: 0.3 }] }]
    }),
    boxRange: () => ({
      export: { filename: 'boxrange', format: 'png' }, dpi: 50,
      panels: [{ series: [{ id: 'box', kind: 'box', groups: [{ position: 1, values: [...range(20, () => 6 + gauss()), 14] }, { position: 3, values: range(12, () => gauss()) }], whis: [0, 100] }] }]
    }),
    // Violins on named places: a box inside, points, values all alike, and no values.
    violin: () => ({
      xCategories: ['A', 'B', 'C', 'D', 'E'], export: { filename: 'violin', format: 'pdf' },
      panels: [{ yLabel: 'Value', series: [{ id: 'v', kind: 'violin', groups: [wide, [...narrow, 9], range(9, () => 4 + 2 * gauss()), [3, 3, 3], []], points: true }] }]
    }),
    // One scale for all, past the data, Silverman's bandwidth, quartile lines; and a median line.
    violinArea: () => ({
      export: { filename: 'violinarea', format: 'png' }, dpi: 50,
      panels: [{ series: [
        { id: 'v', kind: 'violin', groups: [{ position: 1, values: wide }, { position: 3, values: narrow }], scale: 'area', cut: 2, bandwidth: 'silverman', inner: 'quartiles', width: 1 },
        { id: 'w', kind: 'violin', groups: [{ position: 5, values: wide }], inner: 'median', lineWidth: 0, faceAlpha: 1 },
        { id: 'u', kind: 'violin', groups: [{ position: 6, values: narrow }], inner: 'none' }
      ] }]
    }),
    // Bars of means with a t interval and the values over them.
    means: () => ({
      xCategories: ['a', 'b', 'c', 'd', 'e'], export: { filename: 'means', format: 'png' }, dpi: 50,
      panels: [{ series: [{ id: 'm', kind: 'bar', replicates: { values: [...reps, NaN], codes: [...codes, 0], names: ['a', 'b', 'c', 'd', 'e'], error: 'ci', level: 0.9 }, points: true, label: 'Means' }] }]
    }),
    // Lying flat, with standard errors; and standard deviations beside them.
    hmeans: () => ({
      export: { filename: 'hmeans', format: 'png' }, dpi: 50,
      panels: [{ yCategories: ['e', 'd', 'c', 'b', 'a'], series: [
        { id: 'm', kind: 'bar', orientation: 'h', y: [4, 3, 2, 1, 0], replicates: { values: reps, codes, error: 'sem' }, points: true, label: 'SEM' },
        { id: 'n', kind: 'bar', orientation: 'h', y: [4, 3, 2, 1, 0], replicates: { values: reps.map((v) => v / 2), codes, error: 'sd' }, label: 'SD' },
        { id: 'o', kind: 'bar', orientation: 'h', y: [4, 3, 2, 1, 0], replicates: { values: reps.map((v) => v / 3), codes, error: 'none' }, label: 'None' }
      ] }]
    })
  };
  const FIG = Object.fromEntries(Object.entries(KINDS).map(([k, make]) => [k, make()]));
  const N = Object.fromEntries(Object.entries(FIG).map(([k, fig]) => [k, normaliseFigure(fig)]));
  const got = {};
  beforeAll(async () => {
    if (!PYTHON) return;
    await Promise.all(Object.entries(FIG).map(async ([k, fig]) => { got[k] = await run(figureScript(fig), {}, KINDS_INSPECT); }));
  }, 180000);
  afterAll(() => Object.values(got).forEach((r) => rmSync(r.dir, { recursive: true, force: true })));

  const near = (a, b, tol = 1e-9) => (a === null || b === null || Number.isNaN(b) ? (a === null) === (b === null || Number.isNaN(b)) : Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b)));
  const sameList = (where, a, b, tol) => {
    expect([where, a.length]).toEqual([where, b.length]);
    a.forEach((v, i) => { if (!near(v, b[i], tol)) throw new Error(`${where}[${i}]: matplotlib ${v}, the description ${b[i]}`); });
  };
  /* The rectangles matplotlib draws for a bar series: [x, y, width, height]. */
  const rectsOf = (q) => {
    const { horizontal, positions } = barData(q);
    const h = q.barWidth / 2;
    return positions.map((p, i) => (horizontal ? [q.bottoms[i], p + q.offset - h, q.heights[i], q.barWidth] : [p + q.offset - h, q.bottoms[i], q.barWidth, q.heights[i]]));
  };
  const barsOf = (name, panel = 0) => N[name].panels[panel].series.filter((q) => q.kind === 'bar');

  test('figures without the new options are written as before', () => {
    const bars = figureScript(FIGS.bars);
    expect(bars).toContain("wt = ax.bar(wt_x, wt_y, width=0.4, color=");
    expect(bars).not.toMatch(/barh|bottom=|left=|stack_|np\.cumsum|violin|notch/);
    expect(figureScript(FIGS.hist)).toContain('a_counts, a_edges = np.histogram(a_values[np.isfinite(a_values)], bins=20)');
    expect(figureScript(FIGS.hist)).toMatch(/b_counts, b_edges = np\.histogram\(b_values\[np\.isfinite\(b_values\)\],\s+bins=\[-1, 0, 0\.5, 1, 1\.5, 2, 3\]\)/);
    const boxes = figureScript(FIGS.boxes);
    expect(boxes).toContain('# Quartiles, the median, whiskers to the last value within 1.5 × IQR of the box, and the values beyond.');
    expect(boxes).toMatch(/ax\.boxplot\(box_groups, positions=\[0, 1, 2\], widths=0\.5, whis=1\.5,\s+patch_artist=True/);
    // A scalar base is still one number.
    expect(figureScript({ panels: [{ series: [{ kind: 'bar', y: [1, 2], bottom: 3 }] }] })).toMatch(/ax\.bar\(bar1_x, bar1_y, width=0\.8, bottom=3, /);
  });

  test('horizontal bars: barh at the y positions, the names on the y axis', () => {
    const code = figureScript(FIG.hbar);
    expect(code).toMatch(/^wt = ax\.barh\(wt_y, wt_x, height=0\.4, color=/m);
    expect(code).toMatch(/xerr=wt_xerr, capsize=3/);
    expect(code).toMatch(/xerr=\[mut_xerr_minus, mut_xerr_plus\]/);
    expect(code).toContain("# y axis: one tick for each group.");
    expect(code).toContain('ax.yaxis.set_major_locator(ticker.FixedLocator([0, 1, 2]))');
    expect(code).toContain("ax.yaxis.set_major_formatter(ticker.FixedFormatter(['Drug B', 'Drug A', 'Control']))");
    expect(code).not.toMatch(/ax\.bar\(/);
    // The base of a lying bar is its left end; each bar may have its own.
    expect(figureScript(FIG.hlog)).toMatch(/ax\.barh\(a_y, a_x, height=4, left=1, /);
    expect(figureScript(FIG.wide)).toMatch(/ax\.bar\(a_x, a_y, width=4, bottom=a_bottom, /);
    expect(figureScript(FIG.wide)).toContain('a_bottom = np.array([0.5, 1, -1, 0], dtype=float)');
  });

  test('stacked bars: the script adds up the bases itself, in the order of the series', () => {
    const code = figureScript(FIG.stack);
    for (const line of [
      'stack_up = np.zeros(len(a_x))  # how far the stack reaches above zero so far',
      'a_bottom = np.where(a_y < 0, stack_down, stack_up)',
      'stack_up = stack_up + np.where(a_y > 0, a_y, 0)',
      'stack_down = stack_down + np.where(a_y < 0, a_y, 0)',
      'c_bottom = np.where(c_y < 0, stack_down, stack_up)'
    ]) expect(code).toContain(line);
    expect(code).toMatch(/^b = ax\.bar\(a_x, b_y, width=0\.4, bottom=b_bottom, /m);          // the stack shares its positions
    expect(code).toMatch(/^d = ax\.bar\(d_x, d_y, width=0\.4, color=/m);   // the series beside the stack
    // The legend reads down the stack.
    expect(code).toContain('ax.legend(handles=[c, b, a, d]');
    // At different positions the bases are found by position; to 100% the values become shares.
    const pc = figureScript(FIG.percent);
    for (const line of [
      'stack_at = np.unique(np.concatenate([a_x, b_x, c_x]))  # every position that has a bar',
      'b_at = np.searchsorted(stack_at, b_x)',
      'np.add.at(stack_total, b_at, np.where(np.isfinite(b_y), np.abs(b_y), 0))',
      'stack_total[stack_total == 0] = np.nan  # no bars where every value is 0',
      'b_share = 100 * b_y / stack_total[b_at]',
      'b_error_share_plus = 100 * b_yerr_plus / stack_total[b_at]',
      'b_bottom = np.where(b_share < 0, stack_down[b_at], stack_up[b_at])',
      'np.add.at(stack_up, b_at, np.where(b_share > 0, b_share, 0))'
    ]) expect(pc).toContain(line);
    expect(pc).toMatch(/^b = ax\.bar\(b_x, b_share, width=4, bottom=b_bottom, [^\n]*\n\s+linewidth=0, yerr=\[b_error_share_minus, b_error_share_plus\]/m);
    const hs = figureScript(FIG.hstack);
    expect(hs).toMatch(/^b = ax\.barh\(a_y, b_share, height=0\.8, left=b_left, /m);
    expect(hs).toContain('stack_total = sum([\n    np.where(np.isfinite(a_x), np.abs(a_x), 0),\n    np.where(np.isfinite(b_x), np.abs(b_x), 0),\n])');
    expect(hs).toMatch(/^r2 = ax_lower_right\.bar\(\w+, r2_y, width=0\.8, bottom=r2_bottom, /m);
    expect(hs).toContain('ax.legend(handles=[a, b]');                         // lying flat: the order given
    expect(hs).toContain('ax_lower_right.legend(handles=[l, r2, r1]');
  });

  test('histogram options: numpy takes the rule by name; scaling and running totals are one line each', () => {
    const code = figureScript(FIG.hist);
    expect(code).toContain("# The histogram of a_values: the bins numpy's 'fd' rule gives (Freedman-Diaconis), as\n# the page's.");
    expect(code).toContain("a_counts, a_edges = np.histogram(a_values[np.isfinite(a_values)], bins='fd')");
    // 'auto' changed in numpy 2.3, so the script counts those bins itself and every numpy draws the same.
    expect(code).toContain('def auto_bins(values):');
    expect(code).toContain('bins=auto_bins(b_values[np.isfinite(b_values)]))');
    expect(figureScript({ panels: [{ series: [{ id: 'a', kind: 'histogram', values: [1, 2, 3, 4], bins: 'fd' }] }] })).not.toContain('auto_bins');
    expect(code).toContain('a_counts = 100 * a_counts / max(a_counts.sum(), 1)  # the percentage in each bin');
    expect(code).toContain('b_counts = b_counts / max(b_counts.sum(), 1)  # the fraction in each bin');
    expect(code).toContain('b_counts = np.cumsum(b_counts)  # the running total, up to the end of each bin');
    expect(code).toMatch(/c_counts, c_edges = np\.histogram\(c_values\[np\.isfinite\(c_values\)\], bins='doane',\s+density=True\)/);
    expect(code).toMatch(/e_counts, e_edges = np\.histogram\(e_values\[np\.isfinite\(e_values\)\],\s+bins=\[1, 3, 4, 4\.5, 5, 7\], density=True\)/);
    expect(code).toContain('e_counts = np.cumsum(e_counts * np.diff(e_edges))  # the fraction up to the end of each bin');
    expect(code).toContain("ax_lower.set_yscale('log')");
  });

  test('box options: whiskers by percentiles and a notch', () => {
    const code = figureScript(FIG.box);
    expect(code).toContain('# Quartiles, the median, whiskers to the last values within percentiles 5 and 95, and\n# the values beyond.');
    expect(code).toContain('# The notch is the median ± 1.57 × IQR / √n, about its 95% confidence interval.');
    expect(code).toMatch(/ax\.boxplot\(box_groups, positions=\[0, 1, 2\], widths=0\.5, whis=\(5, 95\), notch=True,\s+patch_artist=True/);
    expect(code).toContain('stats.t.ppf(0.995, len(_values) - 1)');
    expect(figureScript(FIG.boxRange)).toContain('# Quartiles, the median, and whiskers to the smallest and the largest value.');
    expect(figureScript(FIG.boxRange)).toContain('whis=(0, 100)');
  });

  test('violins: a density worked out with numpy alone, filled between its two sides', () => {
    const code = figureScript(FIG.violin);
    expect(code).toContain("def violin_density(values, bandwidth='scott', cut=0, at=None, points=100):");
    expect(code).toContain('# Needs numpy and matplotlib 3.6 or later');
    expect(code).not.toMatch(/from scipy|ax\.violinplot/);
    expect(code).toContain('v_groups = [v_group1[np.isfinite(v_group1)], v_group2[np.isfinite(v_group2)]');
    expect(code).toContain("    _coords, _density = violin_density(_values, 'scott', cut=0)");
    expect(code).toContain('    _half = 0.4 * _density / _top');
    expect(code).toMatch(/ax\.fill_betweenx\(_coords, _position - _half, _position \+ _half,\s+facecolor=matplotlib\.colors\.to_rgba\('#1f5c96', 0\.35\)/);
    expect(code).toContain('    if _values.min() < _values.max():  # values all alike have nothing inside');
    const area = figureScript(FIG.violinArea);
    expect(area).toContain("v_peak = max((violin_density(_values, 'silverman', cut=2)[1].max() for _values in v_groups\n              if len(_values) > 1 and _values.min() < _values.max()), default=1.0)");
    expect(area).toContain('    _top = v_peak if _values.min() < _values.max() else 1.0');
    expect(area).toContain("        _reach = 0.5 * violin_density(_values, 'silverman', cut=2, at=_marks)[1] / _top");
    expect(area).toContain("for _value, _r, _style in zip(_marks, _reach, ('dashed', 'solid', 'dashed')):");
    expect((area.match(/^def violin_density/gm) || []).length).toBe(1);
    // A page's own name is left alone.
    expect(identifier('violin_density', new Set())).toBe('violin_density_2');
  });

  test('bars of means: the group of each row goes into the script, which works out the means and errors', () => {
    const code = figureScript(FIG.means);
    expect(code).toContain('# The group of each row of m_values: 0 a, 1 b, 2 c, 3 d, 4 e (-1: none).');
    expect(code).toMatch(/^m_group = np\.array\(\[\n {4}0, 1, 2, 3, 0, 1, 2, 3, /m);
    expect(code).toContain('m_groups = [m_values[(m_group == k) & np.isfinite(m_values)] for k in range(5)]');
    expect(code).toContain('m_mean = np.array([v.mean() if len(v) else np.nan for v in m_groups])');
    expect(code).toContain('m_sd = np.array([v.std(ddof=1) if len(v) > 1 else np.nan for v in m_groups])');
    expect(code).toContain('m_ci = stats.t.ppf(0.95, np.maximum(m_n - 1, 1)) * m_sd / np.sqrt(np.maximum(m_n, 1))');
    expect(code).toContain('from scipy import stats');
    expect(code).toContain('# Needs numpy, scipy and matplotlib 3.6 or later');
    expect(code).toMatch(/^m = ax\.bar\(m_x, m_mean, width=0\.8, [^\n]*\n\s+yerr=m_ci, /m);
    expect(code).toContain('for _position, _values in zip(m_x, m_groups):');
    // A standard error or deviation needs numpy only.
    const h = figureScript(FIG.hmeans);
    expect(h).not.toContain('scipy');
    expect(h).toContain('m_sem = m_sd / np.sqrt(np.maximum(m_n, 1))');
    expect(h).toMatch(/^m = ax\.barh\(m_y, m_mean, height=0\.26666666666666666, [\s\S]{0,120}?xerr=m_sem, /m);
    expect(h).toMatch(/xerr=n_sd, /);
    expect(h).not.toMatch(/o_sd|xerr=o_/);
    expect(h).toMatch(/ax\.plot\(_values, _position \+ _jitter, /);
  });

  withPython('every figure runs without errors or warnings and saves its file', () => {
    for (const [name, r] of Object.entries(got)) {
      expect([name, r.code, r.stderr]).toEqual([name, 0, '']);
      const { filename, format } = N[name].export;
      expect(existsSync(join(r.dir, `${filename}.${format}`))).toBe(true);
    }
  });

  withPython('the limits, the major ticks and their labels are the preview\'s, on every axes', () => {
    let checked = 0;
    for (const [name, r] of Object.entries(got)) {
      const f = N[name];
      const { info } = buildFigure(f);
      f.panels.forEach((p, i) => {
        const base = i === 0 ? 'ax' : `ax_${p.id}`;
        const pairs = [[base, 'x', 'y']];
        if (info.views[i].y2) pairs.push([`${base}_right`, 'x', 'y2']);
        for (const [axes, kx, ky] of pairs) {
          const a = r.fig.axes[axes];
          const where = `${name} ${axes}`;
          const vx = info.views[i][kx]; const vy = info.views[i][ky];
          if (![...a.xlim.map((v, k) => close(v, vx.view[k])), ...a.ylim.map((v, k) => close(v, vy.view[k]))].every(Boolean)) {
            throw new Error(`${where}: matplotlib x ${a.xlim} y ${a.ylim}, preview x ${vx.view} y ${vy.view}`);
          }
          for (const [k, view, ticks] of [[kx, vx, a.xticks], [ky, vy, a.yticks]]) {
            if (view.log && !atLeast(r, 11)) continue;
            const want = info.ticks[i][k].major;
            expect([where, k, ticks.map(([, t]) => plainLabel(t))]).toEqual([where, k, want.map((t) => plainLabel(t.text))]);
            ticks.forEach(([v], j) => expect([where, k, close(v, want[j].v)]).toEqual([where, k, true]));
            checked += ticks.length;
          }
        }
      });
    }
    expect(checked).toBeGreaterThan(150);
  });

  withPython('bars lie where the description puts them: flat, on their own bases, stacked and to 100%', () => {
    const check = (name, axes, series) => {
      const want = series.flatMap(rectsOf);
      const have = got[name].fig.axes[axes].bars;
      expect([name, have.length]).toEqual([name, want.length]);
      have.forEach((rect, i) => sameList(`${name} bar ${i}`, rect, want[i]));
    };
    check('hbar', 'ax', barsOf('hbar'));
    check('hlog', 'ax', barsOf('hlog'));
    check('wide', 'ax', barsOf('wide'));
    check('stack', 'ax', barsOf('stack'));
    check('percent', 'ax', barsOf('percent'));
    check('hstack', 'ax', barsOf('hstack'));
    check('hstack', 'ax_lower_right', barsOf('hstack', 1));
    check('means', 'ax', barsOf('means'));
    check('hmeans', 'ax', barsOf('hmeans'));
    // What that means on the page: bars 4 wide; the stack's tops; shares that fill 100.
    expect(got.wide.fig.axes.ax.bars.map((b) => b[2])).toEqual([4, 4, 4, 4]);
    expect(got.stack.fig.axes.ax.bars.slice(4, 8).map((b) => [b[1], b[3]])).toEqual([[3, 2], [0, -1], [0, 3], [5, 1]]);
    expect(got.stack.fig.axes.ax.bars[11]).toEqual([expect.any(Number), 6, 0.4, null]);   // no number: no bar
    const share = got.percent.fig.axes.ax.bars;
    expect(share[1][3] + share[5][3] + share[7][3]).toBeCloseTo(100, 10);                  // the three series at x = 5
    expect(got.hstack.fig.axes.ax.bars.map((b) => b[0] + b[2]).slice(3)).toEqual([100, 100, 100].map((v) => expect.closeTo(v, 10)));
    expect(got.hbar.fig.axes.ax.yticks.map(([, t]) => t)).toEqual(['Drug B', 'Drug A', 'Control']);
    expect(got.hbar.fig.axes.ax.ylabel).toBe('Sample');
    // Error bars stand at the end of each bar, along it, scaled with it when it is a share.
    const errs = (name, axes = 'ax') => got[name].fig.axes[axes].errors;
    const ends = (seg, k) => [seg[0][k], seg[1][k]];
    const [wt] = barsOf('hbar');
    errs('hbar')[0].forEach((seg, i) => sameList(`hbar error ${i}`, ends(seg, 0), [wt.x[i] - wt.xerr[0][i], wt.x[i] + wt.xerr[1][i]]));
    const [, pb] = barsOf('percent');
    errs('percent')[0].forEach((seg, i) => sameList(`percent error ${i}`, ends(seg, 1), [pb.bottoms[i] + pb.heights[i] - pb.errs[0][i], pb.bottoms[i] + pb.heights[i] + pb.errs[1][i]]));
    expect(pb.errs[1][0]).toBeCloseTo(8, 10);
    const [sa] = barsOf('stack');
    sameList('stack error', ends(errs('stack')[0][2], 1), [-2.4, -1.6]);                   // below zero: at the lower end
    expect(sa.bottoms[2]).toBe(0);
  });

  withPython('legends: down a stack, in the order given otherwise', () => {
    expect(got.stack.fig.axes.ax.legend).toEqual(['C', 'B', 'A', 'Beside']);
    expect(got.percent.fig.axes.ax.legend).toEqual(['C', 'B', 'A']);
    expect(got.hstack.fig.axes.ax.legend).toEqual(['A', 'B']);
    expect(got.hstack.fig.axes.ax_lower_right.legend).toEqual(['Line', 'R2', 'R1']);
    expect(got.hbar.fig.axes.ax.legend).toEqual(['Wild type', 'Mutant']);
  });

  withPython('histograms: numpy\'s edges for each rule, and the heights scaled and added up as the preview has them', () => {
    const series = N.hist.panels.flatMap((p) => p.series);
    const drawn = [...got.hist.fig.axes.ax.stairs, ...got.hist.fig.axes.ax_lower.stairs];
    const stairs = series.filter((q) => q.histtype !== 'bar');
    expect(drawn).toHaveLength(stairs.length);
    stairs.forEach((q, i) => {
      expect([q.id, drawn[i].edges]).toEqual([q.id, q.edges]);                            // the same doubles
      sameList(`hist ${q.id}`, drawn[i].values, q.counts, 1e-12);
    });
    const e = series.find((q) => q.id === 'e');
    const bars = got.hist.fig.axes.ax.bars;
    sameList('hist e', bars.map((b) => b[3]), e.counts, 1e-12);
    expect(e.counts[e.counts.length - 1]).toBeCloseTo(1, 12);
    const by = Object.fromEntries(series.map((q) => [q.id, q]));
    expect(by.a.counts.reduce((x, y) => x + y, 0)).toBeCloseTo(100, 10);
    expect(by.b.counts[by.b.counts.length - 1]).toBeCloseTo(1, 12);
    expect(by.d.counts[by.d.counts.length - 1]).toBe(300);
    expect(by.h.counts[by.h.counts.length - 1]).toBeCloseTo(100, 10);
    expect(got.hist.fig.axes.ax_lower.yscale).toBe('log');
  });

  withPython('boxes: the whiskers end at the last values inside the percentiles; the notch is matplotlib\'s', () => {
    const [q] = N.box.panels[0].series;
    const a = got.box.fig.axes.ax;
    q.groups.forEach((g, i) => {
      const st = g.stats;
      const whiskers = a.lines.filter((l) => l.marker !== 'o' && l.x.length === 2 && l.x[0] === g.position && l.x[1] === g.position);
      expect(whiskers.map((l) => l.y)).toEqual([[st.q1, st.whislo], [st.q3, st.whishi]]);
      const path = a.paths[i];
      const w = q.width / 2;
      sameList(`notch ${i} x`, path.slice(0, 5).map((v) => v[0]), [g.position - w, g.position + w, g.position + w, g.position + w / 2, g.position + w]);
      sameList(`notch ${i} y`, path.slice(0, 5).map((v) => v[1]), [st.q1, st.q1, st.notchLow, st.med, st.notchHigh]);
      // The median is as wide as the notch.
      expect(a.lines.some((l) => l.x.length === 2 && near(l.x[0], g.position - w / 2) && near(l.x[1], g.position + w / 2) && l.y[0] === st.med)).toBe(true);
    });
    // 5th to 95th percentile: values beyond are fliers.
    expect(q.groups[1].stats.fliers).toContain(14);
    // The mean's interval at 99%.
    q.groups.forEach((g, i) => sameList(`interval ${i}`, [got.box.fig.axes.ax.errors[i][0][0][1], got.box.fig.axes.ax.errors[i][0][1][1]], [g.stats.ciLow, g.stats.ciHigh], 1e-7));
    const [r] = N.boxRange.panels[0].series;
    const lines = got.boxRange.fig.axes.ax.lines;
    r.groups.forEach((g) => {
      const whiskers = lines.filter((l) => l.marker !== 'o' && l.x.length === 2 && l.x[0] === g.position && l.x[1] === g.position);
      expect(whiskers.map((l) => l.y[1])).toEqual([Math.min(...g.values), Math.max(...g.values)]);
      expect(g.stats.fliers).toEqual([]);
    });
  });

  withPython('violins: matplotlib fills the outline the preview draws; marks and points inside', () => {
    /* fill_betweenx's polygon: the first right-hand point, the left side up, the last right-hand point, the right side down. */
    const outline = (name, k, q, g) => {
      const poly = got[name].fig.axes.ax.polys[k];
      const n = g.kde.coords.length;
      expect([name, k, poly.length]).toEqual([name, k, 2 * n + 3]);
      sameList(`${name} violin ${k} left`, poly.slice(1, n + 1).map((v) => v[0]), g.half.map((w) => g.position - w), 1e-10);
      sameList(`${name} violin ${k} right`, poly.slice(n + 2, 2 * n + 2).map((v) => v[0]), g.half.map((w) => g.position + w).reverse(), 1e-10);
      sameList(`${name} violin ${k} coords`, poly.slice(1, n + 1).map((v) => v[1]), g.kde.coords, 1e-12);
    };
    const [v] = N.violin.panels[0].series;
    const drawn = v.groups.filter((g) => g.kde);
    expect(got.violin.fig.axes.ax.polys).toHaveLength(4);                                   // the empty group draws nothing
    drawn.forEach((g, k) => outline('violin', k, v, g));
    expect(Math.max(...drawn[0].half)).toBeCloseTo(0.4, 12);
    expect(drawn[3].kde.flat).toBe(true);
    const a = got.violin.fig.axes.ax;
    // Each violin with a spread: its points, a thin line, a thick one over the quartiles, a dot at the median.
    const lines = a.lines;
    expect(lines).toHaveLength(3 * 4 + 1);
    drawn.slice(0, 3).forEach((g, k) => {
      const [points, whisker, box, dot] = lines.slice(4 * k, 4 * k + 4);
      expect(points.y).toEqual(g.values);
      expect([whisker.y, box.y, dot.y]).toEqual([[g.stats.whislo, g.stats.whishi], [g.stats.q1, g.stats.q3], [g.stats.med]]);
      expect([whisker.width, box.width, dot.marker]).toEqual([1, 4, 'o']);
    });
    expect(lines[12].y).toEqual([3, 3, 3]);
    expect(a.xticks.map(([, t]) => t)).toEqual(['A', 'B', 'C', 'D']);
    // All to one scale: the narrow spread is the widest; quartile lines reach the outline.
    const [w, m, u] = N.violinArea.panels[0].series;
    w.groups.forEach((g, k) => outline('violinArea', k, w, g));
    outline('violinArea', 2, m, m.groups[0]);
    outline('violinArea', 3, u, u.groups[0]);
    expect(Math.max(...w.groups[1].half)).toBeCloseTo(0.5, 12);
    expect(Math.max(...w.groups[0].half)).toBeLessThan(0.2);
    const marks = got.violinArea.fig.axes.ax.lines;
    expect(marks).toHaveLength(3 + 3 + 1);
    expect(marks.slice(0, 3).map((l) => l.style)).toEqual(['--', '-', '--']);
    const g0 = w.groups[0];
    expect(marks.slice(0, 3).map((l) => l.y[0])).toEqual([g0.stats.q1, g0.stats.med, g0.stats.q3]);
    marks.slice(0, 3).forEach((l) => { expect(l.x[1] - g0.position).toBeGreaterThan(0.01); expect(l.x[1] - g0.position).toBeLessThanOrEqual(Math.max(...g0.half) * 1.0001); });
    expect(marks[6].y).toEqual([m.groups[0].stats.med, m.groups[0].stats.med]);
  });

  withPython('bars of means: numpy\'s means, deviations and errors, scipy\'s t interval, the values over the bars', () => {
    const [q] = barsOf('means');
    const a = got.means.fig.axes.ax;
    expect(q.replicates.stats.n).toEqual([12, 11, 11, 11, 1]);
    sameList('means', a.bars.map((b) => b[3]), q.y, 1e-13);
    const ci = a.errors[0];
    expect(ci[4]).toEqual([]);                                                           // one value: no error bar
    ci.slice(0, 4).forEach((seg, i) => sameList(`interval ${i}`, [seg[0][1], seg[1][1]], [q.y[i] - q.yerr[0][i], q.y[i] + q.yerr[1][i]], 1e-8));
    expect(Number.isNaN(q.yerr[0][4])).toBe(true);
    const points = a.lines.filter((l) => l.marker === 'o');                               // the caps of the error bars are lines too
    expect(points).toHaveLength(5);
    points.forEach((l, i) => {
      expect(l.y).toEqual(q.replicates.groups[i]);
      sameList(`points ${i}`, l.x, q.replicates.groups[i].map((_, k) => i + (((k * 0.6180339887498949) % 1) - 0.5) * 0.5 * 0.8), 1e-12);
    });
    const [m, n] = barsOf('hmeans');
    const h = got.hmeans.fig.axes.ax;
    expect(h.bars.slice(0, 5).map((b) => b[2])).toEqual(m.x);                               // the same doubles as numpy's
    expect(h.bars.slice(5, 10).map((b) => b[2])).toEqual(n.x);
    h.errors[0].slice(0, 4).forEach((seg, i) => expect([seg[0][0], seg[1][0]]).toEqual([m.x[i] - m.xerr[0][i], m.x[i] + m.xerr[1][i]]));
    h.errors[1].slice(0, 4).forEach((seg, i) => expect([seg[0][0], seg[1][0]]).toEqual([n.x[i] - n.xerr[0][i], n.x[i] + n.xerr[1][i]]));
    expect(h.errors).toHaveLength(2);
    expect(h.yticks.map(([, t]) => t)).toEqual(['e', 'd', 'c', 'b', 'a']);
  });

  withPython('numpy\'s bin edges and scipy\'s density, on random and awkward data', async () => {
    const sets = {
      normal: range(57, () => gauss()), thousand: range(1000, () => 3 + 2 * gauss()), many: range(20000, () => gauss() * 1e3),
      skew: range(300, () => Math.exp(gauss())), constant: [2.5, 2.5, 2.5, 2.5], one: [7], two: [1, 2], three: [1, 2, 4],
      outliers: [...range(200, () => gauss()), 60, -45], ties: range(500, () => Math.round(gauss() * 3)),
      halfAlike: [...range(80, () => 1), ...range(20, () => gauss())], whole: range(100, (i) => i % 7),
      tiny: range(40, () => 1e-9 * gauss()), far: range(40, () => 1e6 + gauss()), negative: range(33, () => -10 - rand())
    };
    const mine = {};
    for (const [name, values] of Object.entries(sets)) {
      const scott = violinStats(values); const silverman = violinStats(values, { bandwidth: 'silverman', cut: 1.5 });
      mine[name] = {
        edges: Object.fromEntries(BIN_RULES.map((rule) => [rule, histogramBinEdges(values, rule)])),
        counts: Object.fromEntries(BIN_RULES.map((rule) => [rule, histogram(values, rule).counts])),
        kde: scott.flat ? null : { scott: [scott.bw, scott.coords, scott.density], silverman: [silverman.bw, silverman.coords, silverman.density] }
      };
    }
    const reference = String.raw`
import json, numpy as np
from scipy import stats
sets = json.load(open('sets.json'))
out = {}
for name, values in sets.items():
    x = np.array(values, dtype=float)
    out[name] = {'edges': {}, 'counts': {}, 'kde': None}
    for rule in ['auto', 'fd', 'sturges', 'sqrt', 'scott', 'rice', 'doane']:
        bins = rule
        if rule == 'auto' and tuple(int(p) for p in np.__version__.split('.')[:2]) < (2, 3):
            # numpy before 2.3 took the Freedman-Diaconis width as it was; the rule it has had since, written out.
            span = np.ptp(x)
            fd = 2.0 * np.subtract(*np.percentile(x, [75, 25])) * x.size ** (-1.0 / 3.0)
            width = min(max(fd, span / np.sqrt(x.size) / 2), span / (np.log2(x.size) + 1.0))
            bins = int(np.ceil(span / width)) if width else 1
        counts, edges = np.histogram(x, bins=bins)
        out[name]['edges'][rule] = edges.tolist()
        out[name]['counts'][rule] = counts.tolist()
    if len(x) > 1 and x.min() < x.max():
        out[name]['kde'] = {}
        for rule, cut in (('scott', 0), ('silverman', 1.5)):
            kde = stats.gaussian_kde(x, bw_method=rule)
            bw = float(np.sqrt(kde.covariance[0, 0]))
            coords = np.linspace(x.min() - cut * bw, x.max() + cut * bw, 100)
            out[name]['kde'][rule] = [bw, coords.tolist(), kde(coords).tolist()]
print('@@FIG@@' + json.dumps(out))
`;
    const dir = mkdtempSync(join(tmpdir(), 'stemkit-numpy-'));
    try {
      writeFileSync(join(dir, 'sets.json'), JSON.stringify(sets));
      const r = spawnSync('python3', ['-c', reference], { cwd: dir, encoding: 'utf8', timeout: 120000, maxBuffer: 1 << 28 });
      expect([r.status, r.stderr]).toEqual([0, '']);
      const ref = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('@@FIG@@')).slice(7));
      let densities = 0;
      for (const name of Object.keys(sets)) {
        for (const rule of BIN_RULES) {
          // numpy's edges and counts, to the last bit.
          expect([name, rule, mine[name].edges[rule]]).toEqual([name, rule, ref[name].edges[rule]]);
          expect([name, rule, mine[name].counts[rule]]).toEqual([name, rule, ref[name].counts[rule]]);
        }
        expect([name, mine[name].kde === null]).toEqual([name, ref[name].kde === null]);
        if (!ref[name].kde) continue;
        for (const rule of ['scott', 'silverman']) {
          const [bw, coords, density] = mine[name].kde[rule]; const [rbw, rcoords, rdensity] = ref[name].kde[rule];
          expect(Math.abs(bw - rbw)).toBeLessThanOrEqual(1e-13 * rbw);
          sameList(`${name} ${rule} coords`, coords, rcoords, 1e-13);
          // scipy scales the values before it subtracts them, which costs digits where they are far from zero.
          density.forEach((v, i) => { if (Math.abs(v - rdensity[i]) > (name === 'far' ? 1e-8 : 1e-11) * Math.max(rdensity[i], 1e-300)) throw new Error(`${name} ${rule} density ${i}: ${v}, scipy ${rdensity[i]}`); });
          densities += density.length;
        }
      }
      expect(densities).toBe(13 * 200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);

  withPython('read from the person\'s file, the script works out what the page drew; other rows give other bars', async () => {
    const names = ['control', 'low', 'high'];
    const rows = range(30, (i) => [names[i % 3], (2 + (i % 3) * 1.5 + gauss() * 0.4).toFixed(3), (10 + gauss()).toFixed(3), i % 3, (1 + (i % 4)).toFixed(1)]);
    const csv = (list) => 'group,response,weight,place,part\n' + list.map((r) => r.join(',')).join('\n') + '\n';
    const col = (k) => rows.map((r) => Number(r[k]));
    const field = (k, name) => ({ values: col(k), name, source: 'trial', column: name });
    const fig = {
      height: 6, xCategories: names, export: { filename: 'file', format: 'png' }, dpi: 50,
      panels: [
        { series: [{ id: 'm', kind: 'bar', replicates: { values: field(1, 'response'), codes: rows.map((r) => names.indexOf(r[0])), names, error: 'sd' }, points: true }] },
        { id: 'v', series: [{ id: 'v', kind: 'violin', groups: names.map((n, k) => ({ position: k, values: { values: col(1).filter((_, i) => i % 3 === k), name: `response_${n}` } })) }] },
        { id: 's', series: [
          { id: 'p1', kind: 'bar', x: field(3, 'place'), y: field(4, 'part'), stack: 'percent' },
          { id: 'p2', kind: 'bar', x: field(3, 'place'), y: field(2, 'weight'), stack: 'percent' }] },
        { id: 'h', series: [{ id: 'h', kind: 'histogram', values: field(2, 'weight'), bins: 'sturges', normalise: 'fraction', cumulative: true, xAxis: 'top' }] }
      ]
    };
    const files = { trial: { file: 'trial.csv', format: 'csv' } };
    const read = figureScript(fig, { data: 'files', files });
    expect(read).toContain("response = trial_columns['response']");
    expect(read).toContain('m_groups = [response[(m_group == k) & np.isfinite(response)] for k in range(3)]');
    expect(read).toContain("h_counts, h_edges = np.histogram(weight[np.isfinite(weight)], bins='sturges')");
    expect(read).toContain('p1_share = 100 * part / stack_total[p1_at]');   // several rows at each place: found by position
    expect(read).not.toContain('response = np.array');
    // The same rows with the first group's values doubled.
    const other = rows.map((r) => (r[0] === 'control' ? [r[0], (2 * Number(r[1])).toFixed(3), ...r.slice(2)] : r));
    const [a, b, c] = await Promise.all([
      run(read, { 'trial.csv': csv(rows) }, KINDS_INSPECT), run(figureScript(fig), {}, KINDS_INSPECT), run(read, { 'trial.csv': csv(other) }, KINDS_INSPECT)
    ]);
    try {
      for (const r of [a, b, c]) expect([r.code, r.stderr]).toEqual([0, '']);
      // From the file and from the numbers in the script: the same drawing.
      expect(a.fig.axes).toEqual(b.fig.axes);
      const [m] = normaliseFigure(fig).panels[0].series;
      expect(a.fig.axes.ax.bars.map((r) => r[3])).toEqual(m.y);
      expect(a.fig.axes.ax.errors[0].map((seg) => seg[1][1] - seg[0][1])).toEqual(m.y.map((v, i) => (v + m.yerr[1][i]) - (v - m.yerr[0][i])));
      const views = buildFigure(fig).info.views;
      ['ax', 'ax_v', 'ax_s', 'ax_h'].forEach((k, i) => expect([k, a.fig.axes[k].ylim.every((v, j) => close(v, views[i].y.view[j]))]).toEqual([k, true]));
      // The file changed: the script follows it.
      expect(c.fig.axes.ax.bars[0][3]).toBeCloseTo(2 * m.y[0], 9);
      expect(c.fig.axes.ax.bars[1][3]).toBe(m.y[1]);
    } finally {
      for (const r of [a, b, c]) rmSync(r.dir, { recursive: true, force: true });
    }
  }, 120000);
});

/* ------------------------------------------------------------------ *
 * Panels on a grid, shared axes, the gap, letters and insets
 * ------------------------------------------------------------------ */

/* Reports the axes the script named (NAMES, in the order of the figure's
   panels): where they are on the page in px at 96 per inch, from its top
   left, as the preview counts; their limits; the axes they share with; the
   tick labels drawn; their frame lines and texts. */
const LAYOUT_INSPECT = String.raw`

# --- test only: report where things are, as saved (no further draw: each one lays the figure out again) ---
import json as _json
import matplotlib as _mpl
_W, _H = fig.get_size_inches() * 96
_K = 96 / fig.dpi


def _place(bb):
    return [bb.x0 * _K, _H - bb.y1 * _K, bb.x1 * _K, _H - bb.y0 * _K]


def _drawn(axis):
    # The values of the ticks inside the view whose label is drawn.
    lo, hi = sorted(axis.get_view_interval())
    tol = 1e-9 * (hi - lo)
    return [float(t.get_loc()) for t in axis.get_major_ticks()
            if lo - tol <= t.get_loc() <= hi + tol and t.label1.get_visible() and t.label1.get_text()]


_names = NAMES
_axes = [globals()[n] for n in _names]
print('@@FIG@@' + _json.dumps({
    'version': _mpl.__version__,
    'axes': [{
        'box': _place(a.get_window_extent()),
        'xlim': [float(v) for v in a.get_xlim()], 'ylim': [float(v) for v in a.get_ylim()],
        'xscale': a.get_xscale(), 'yscale': a.get_yscale(),
        'sharex': sorted(i for i, b in enumerate(_axes) if b in a.get_shared_x_axes().get_siblings(a)),
        'sharey': sorted(i for i, b in enumerate(_axes) if b in a.get_shared_y_axes().get_siblings(a)),
        'xticks': _drawn(a.xaxis), 'yticks': _drawn(a.yaxis),
        'xlabel': a.get_xlabel(), 'ylabel': a.get_ylabel(), 'title': a.get_title(),
        'spines': {k: bool(v.get_visible()) for k, v in a.spines.items()},
        'texts': [[t.get_text()] + _place(t.get_window_extent()) for t in a.texts],
        'inLayout': bool(a.get_in_layout()), 'child': a in [c for b in fig.axes for c in b.child_axes],
        'patches': [type(p).__name__ for p in a.patches],
    } for a in _axes],
    'colorbars': [_place(a.get_window_extent()) for a in fig.axes if a.get_label() == '<colorbar>'],
    'suptitle': [fig._suptitle.get_text()] + _place(fig._suptitle.get_window_extent()) if fig._suptitle is not None else None,
    'count': len(fig.axes),
}))
`;

describe('panel layout in the script', () => {
  const xs = range(41, (i) => i / 4);
  const wave = (k, o = {}) => ({ id: `s${k}`, kind: 'line', x: xs, y: xs.map((v) => Math.sin(v * k) * k), label: `Run ${k}`, ...o });
  const map = (o = {}) => ({ id: 'map', kind: 'heatmap', x: [1, 2, 3, 4], y: [0, 1, 2], z: [[1, 2, 3, 4], [4, 5, 6, 7], [7, 8, 9, 12]], colorbar: { label: 'Z' }, ...o });
  const page = (name) => ({ export: { filename: name, format: 'png', tight: false }, dpi: 50, legend: { position: 'upper right' } });
  const LAYOUTS = {
    // Four panels, x shared down the columns and y along the rows, lettered, under one title.
    grid: () => ({ ...page('grid'), layout: { rows: 2, cols: 2 }, sharex: 'col', sharey: 'row', title: 'Four runs', xLabel: 'Time (s)', panelLabels: { show: true },
      panels: [1, 2, 3, 4].map((k) => ({ id: `p${k}`, yLabel: `Signal ${k}`, series: [wave(k, k === 2 ? { x: xs.map((v) => v + 100) } : {})] })) }),
    // A stack with no gap: the panels edge to edge, the labels at the shared edges left out.
    stack0: () => ({ ...page('stack0'), panelGap: { h: 0 }, xLabel: 'Time (s)',
      panels: [1, 2, 3].map((k) => ({ id: `p${k}`, yLabel: 'y', yLim: [-1, 1], series: [wave(1, { id: `s${k}` })] })) }),
    // A grid with no gap either way, ticks pointing in on all sides, an open frame, capital letters.
    grid0: () => ({ ...page('grid0'), panelGap: 0, layout: { cols: 2 }, sharex: 'col', sharey: 'row', xLabel: 'x', xLim: [0, 10], xTicks: { direction: 'in', mirror: true },
      spines: { top: false, right: false }, panelLabels: { show: true, style: 'A', bold: false },
      panels: [1, 2, 3, 4].map((k) => ({ id: `p${k}`, yLabel: 'y', yLim: [-4, 4], yTicks: { direction: 'in', mirror: true }, series: [wave(k)] })) }),
    // Wide gaps both ways, set in points.
    gaps: () => ({ ...page('gaps'), panelGap: { h: 20, w: 30 }, layout: { cols: 2 }, title: 'Apart',
      panels: [1, 2, 3, 4].map((k) => ({ id: `p${k}`, series: [wave(k)] })) }),
    // A narrow gap, under matplotlib's own.
    narrow: () => ({ ...page('narrow'), panelGap: { h: 2 }, sharex: 'none', panels: [1, 2].map((k) => ({ id: `p${k}`, series: [wave(k)] })) }),
    // A panel across the top, a line and a map with its colour bar under it; rows and columns of their own sizes; letters outside.
    spans: () => ({ ...page('spans'), layout: { cols: 2, heightRatios: [1, 2], widthRatios: [2, 1] }, panelLabels: { show: true, position: 'outside', style: 'a)' },
      panels: [{ id: 'wide', colSpan: 2, series: [wave(1)] }, { id: 'left', series: [wave(2)] }, { id: 'right', series: [map()] }] }),
    // Three panels on a grid of four cells, sharing both axes: the panel over the empty cell labels its own x.
    holes: () => ({ ...page('holes'), layout: { cols: 2, rows: 2 }, sharex: 'all', sharey: 'all', xLabel: 'x',
      panels: [{ id: 'a', yLabel: 'y', series: [wave(1)] }, { id: 'b', series: [wave(2)] }, { id: 'c', yLabel: 'y', series: [wave(3)] }] }),
    // Colour bars on two panels of a grid, and a right axis on a third.
    bars: () => ({ ...page('bars'), layout: { cols: 2 },
      panels: [{ id: 'a', series: [map()] }, { id: 'b', y2Label: 'Right', series: [wave(2), wave(1, { id: 'r', yAxis: 'right' })] }, { id: 'c', series: [wave(3)] }, { id: 'd', series: [map({ id: 'map2', colormap: 'magma' })] }] }),
    // Six short panels with outside letters; the legends of those with a right axis are taller than their panels and hang out of them.
    crowded: () => ({ ...page('crowded'), panelGap: 12, panelLabels: { show: true, position: 'outside', style: 'A' },
      panels: [1, 2, 3, 4, 5, 6].map((k) => ({ id: `p${k}`, series: k % 3 === 1 ? [wave(k), wave(1, { id: `r${k}`, yAxis: 'right', label: 'Right' })] : [wave(k, { label: '' })] })) }),
    // An inset that enlarges part of its panel, which also has a right axis.
    inset: () => ({ ...page('inset'), xLabel: 'Time (s)',
      panels: [{ id: 'main', yLabel: 'Signal', y2Label: 'Other', series: [wave(1), wave(2, { id: 'other', yAxis: 'right' })] },
        { id: 'zoom', inset: { parent: 'main', x: 0.08, y: 0.08, w: 0.4, h: 0.35, zoom: true }, xLim: [6, 9], yLim: [0, 1], series: [wave(1, { id: 'again', label: '' })] }] }),
    // An inset in the second panel of a row, with a top axis of its own, and no box drawn for it.
    insetRow: () => ({ ...page('insetrow'), layout: { cols: 2 }, sharey: 'row',
      panels: [{ id: 'a', series: [wave(1)] }, { id: 'b', series: [wave(2)] },
        { id: 'in', inset: { parent: 'b', x: 0.5, y: 0.5, w: 0.45, h: 0.4 }, x2Label: 'Top', legend: { show: true }, series: [wave(3), wave(1, { id: 't', xAxis: 'top', x: xs.map((v) => v * 10) })] }] })
  };
  const FIG = Object.fromEntries(Object.entries(LAYOUTS).map(([k, make]) => [k, make()]));
  const got = {};
  // The script, and the names it gives the panels' axes.
  const scriptOf = (fig, options = {}) => { const names = []; return { script: figureScript(fig, { ...options, after: (n) => { names.push(...n); return []; } }), names }; };
  beforeAll(async () => {
    if (!PYTHON) return;
    await Promise.all(Object.entries(FIG).map(async ([k, fig]) => {
      const { script, names } = scriptOf(fig);
      got[k] = await run(script, {}, LAYOUT_INSPECT.replace('NAMES', JSON.stringify(names)));
    }));
  }, 180000);
  afterAll(() => Object.values(got).forEach((r) => rmSync(r.dir, { recursive: true, force: true })));
  const infoOf = (k) => buildFigure(FIG[k]).info;

  test('a plain stack is written as it always was; a full grid is plt.subplots, anything else a GridSpec', () => {
    const stack = figureScript({ panels: [{ series: [wave(1)] }, { ratio: 0.5, series: [wave(2)] }] });
    expect(stack).toContain("fig, (ax, ax_panel2) = plt.subplots(2, 1, sharex=True, figsize=(6.4, 4.8),\n                                    layout='constrained',\n                                    gridspec_kw={'height_ratios': [1, 0.5]},");
    expect(stack).not.toMatch(/get_layout_engine|annotate|add_gridspec|inset_axes|draw_without_rendering|suptitle/);
    const grid = scriptOf(FIG.grid);
    expect(grid.names).toEqual(['ax', 'ax_p2', 'ax_p3', 'ax_p4']);
    expect(grid.script).toContain("fig, panels = plt.subplots(2, 2, sharex='col', sharey='row', figsize=(6.4, 4.8),");
    expect(grid.script).toContain('(ax, ax_p2), (ax_p3, ax_p4) = panels');
    expect(grid.script).toContain('# 4 panels on a grid of 2 rows and 2 columns, the x axis shared down each column, the y');
    expect(grid.script).toContain("fig.suptitle('Four runs', fontsize=plt.rcParams['axes.titlesize'])");
    expect(grid.script).not.toContain('set_title');
    // Labels on the outer panels; the ticks of a shared axis set once.
    expect(grid.script.match(/^ax\w*\.set_xlabel.*$/gm)).toEqual(["ax_p3.set_xlabel('Time (s)')", "ax_p4.set_xlabel('Time (s)')"]);
    expect(grid.script.match(/^ax\w*\.set_ylabel.*$/gm)).toEqual(["ax.set_ylabel('Signal 1')", "ax_p3.set_ylabel('Signal 3')"]);
    const ticked = figureScript({ ...FIG.grid, xTicks: { mode: 'count', count: 4 }, panels: FIG.grid.panels.map((p) => ({ ...p, yTicks: { mode: 'step', step: 1 } })) });
    expect(ticked.match(/^# [xy] axis.*$/gm)).toEqual(['# x axis shared by panels 1 and 3: about 4 ticks.', '# x axis shared by panels 2 and 4: about 4 ticks.',
      '# y axis shared by panels 1 and 2: a tick every 1.', '# y axis shared by panels 3 and 4: a tick every 1.']);
    expect(ticked.match(/^ax\w*\.[xy]axis\.set_major_locator/gm)).toEqual(['ax.xaxis.set_major_locator', 'ax_p2.xaxis.set_major_locator', 'ax.yaxis.set_major_locator', 'ax_p3.yaxis.set_major_locator']);
    // One row, one column that is not a plain stack, one panel with an inset: plt.subplots still.
    expect(figureScript({ layout: { cols: 2 }, panels: [{ series: [wave(1)] }, { series: [wave(2)] }] })).toContain("fig, (ax, ax_panel2) = plt.subplots(1, 2, figsize=(6.4, 4.8), layout='constrained',");
    expect(figureScript({ sharex: 'none', sharey: 'all', panels: [{ series: [wave(1)] }, { series: [wave(2)] }] })).toContain('fig, (ax, ax_panel2) = plt.subplots(2, 1, sharey=True, figsize=(6.4, 4.8),');
    expect(figureScript(FIG.inset)).toContain("fig, ax = plt.subplots(figsize=(6.4, 4.8), layout='constrained', facecolor='#ffffff')");
    // Spans and empty cells: a GridSpec, the shared axes named, the inner tick labels switched off.
    const spans = scriptOf(FIG.spans).script;
    expect(spans).toContain("fig = plt.figure(figsize=(6.4, 4.8), layout='constrained', facecolor='#ffffff')");
    expect(spans).toContain('grid = fig.add_gridspec(2, 2, width_ratios=[2, 1], height_ratios=[1, 2])');
    expect(spans.match(/^ax\w* = fig\.add_subplot.*$/gm)).toEqual(['ax = fig.add_subplot(grid[0, :])', 'ax_left = fig.add_subplot(grid[1, 0])', 'ax_right = fig.add_subplot(grid[1, 1])']);
    const holes = scriptOf(FIG.holes).script;
    expect(holes.match(/^ax\w* = fig\.add_subplot.*$/gm)).toEqual(['ax = fig.add_subplot(grid[0, 0])', 'ax_b = fig.add_subplot(grid[0, 1], sharex=ax, sharey=ax)', 'ax_c = fig.add_subplot(grid[1, 0], sharex=ax, sharey=ax)']);
    expect(holes).toContain("ax.tick_params(axis='x', which='both', labelbottom=False)\nax.xaxis.offsetText.set_visible(False)\nax_b.tick_params(axis='y', which='both', labelleft=False)\nax_b.yaxis.offsetText.set_visible(False)");
    // A name the page's own lines use is left alone.
    expect(figureScript(FIG.spans, { prelude: ['grid = 3'] })).toContain('grid_2 = fig.add_gridspec(');
    expect(figureScript(FIG.grid, { prelude: ['panels = 3'] })).toContain('fig, panels_2 = plt.subplots(');
  });

  test('the gap goes to the layout engine: pads in inches, the space as a share of the figure, the edge kept', () => {
    const gap = (panelGap, o = {}) => (figureScript({ panelGap, panels: [{ series: [wave(1)] }, { series: [wave(2)] }], ...o }).match(/^fig\.get_layout_engine\(\)\.set\(.*\)$/m) || [null])[0];
    expect(gap(null)).toBeNull();
    // No pad at all: the 3 pt the figure's edge keeps are 0.87% of its 4.8 in, top and bottom.
    expect(gap({ h: 0 })).toBe('fig.get_layout_engine().set(h_pad=0, hspace=0, rect=(0, 0.008681, 1, 0.982638))');
    expect(gap({ h: 3 })).toBe('fig.get_layout_engine().set(h_pad=0.020833, hspace=0, rect=(0, 0.00434, 1, 0.99132))');
    expect(gap({ h: 6 })).toBe('fig.get_layout_engine().set(h_pad=0.041667, hspace=0)');
    // 20 pt between two rows of a figure 4.8 in high: 40 pt of its 345.6.
    expect(gap({ h: 20 })).toBe('fig.get_layout_engine().set(h_pad=0.041667, hspace=0.115741)');
    const both = figureScript({ panelGap: { h: 0, w: 12 }, layout: { cols: 2 }, panels: [{ series: [wave(1)] }, { series: [wave(2)] }] });
    expect(both).toContain('fig.get_layout_engine().set(h_pad=0, hspace=0, w_pad=0.041667, wspace=0.052083,\n                            rect=(0, 0.008681, 1, 0.982638))');
    const pads = layoutPads(normaliseFigure({ panelGap: { h: 20 }, panels: [{}, {}] }));
    expect(pads.h.space).toBeCloseTo(0.115741, 6);
    expect(figureScript({ panelGap: { h: 0 }, panels: [{ series: [wave(1)] }, { series: [wave(2)] }] })).toMatch(/# The gap between the panels: 0 pt between the rows, besides the room their tick labels\n# need/);
  });

  test('letters are annotations at the corner; shared edges and what the layout decides are written out', () => {
    const grid = scriptOf(FIG.grid).script;
    expect(grid).toContain("for axes, letter in ((ax, '(a)'), (ax_p2, '(b)'), (ax_p3, '(c)'), (ax_p4, '(d)')):\n    axes.annotate(letter, xy=(0, 1), xycoords='axes fraction', xytext=(5.5, -5.5),\n                  textcoords='offset points', ha='left', va='top', fontsize=11,\n                  fontweight='bold')");
    const spans = scriptOf(FIG.spans).script;
    expect(spans).toContain("    axes.annotate(letter, xy=(0, 1), xycoords='axes fraction', xytext=(-3, 6),\n                  textcoords='offset points', ha='right', va='bottom', fontsize=11,\n                  fontweight='bold')");
    expect(scriptOf(FIG.grid0).script).toContain("for axes, letter in ((ax, 'A'), (ax_p2, 'B'), (ax_p3, 'C'), (ax_p4, 'D')):");
    expect(scriptOf(FIG.grid0).script).not.toContain('fontweight');
    expect(figureScript({ panelLabels: { show: true }, panels: [{ letter: "It's", series: [wave(1)] }] })).toContain("for axes, letter in ((ax, 'It\\'s'),):");
    // No gap: the lower panel draws the shared line, tick marks pointing out across it go, and the
    // labels that reach across it are hidden once the figure is laid out.
    const stack = scriptOf(FIG.stack0).script;
    expect(stack).toContain("ax.spines['bottom'].set_visible(False)\nax.tick_params(axis='x', which='both', bottom=False)\nax_p2.spines['bottom'].set_visible(False)\nax_p2.tick_params(axis='x', which='both', bottom=False)\nax_p2.spines['top'].set_visible(True)\nax_p3.spines['top'].set_visible(True)");
    expect(stack).toContain("fig.draw_without_rendering()");
    expect(stack).toContain("for axes, axis, side in (\n        (ax, ax.yaxis, 'bottom'), (ax_p2, ax_p2.yaxis, 'top'),\n        (ax_p2, ax_p2.yaxis, 'bottom'), (ax_p3, ax_p3.yaxis, 'top'),\n):\n    box = axes.get_window_extent()\n    for label in axis.get_ticklabels(which='both'):\n        at = label.get_window_extent()\n        past = {'top': at.y1 > box.y1, 'bottom': at.y0 < box.y0,\n                'left': at.x0 < box.x0, 'right': at.x1 > box.x1}\n        if past[side]:\n            label.set_visible(False)");
    expect(stack.split('\n').filter((line) => line.length > 100)).toEqual([]);
    expect(stack.indexOf('fig.draw_without_rendering()')).toBeGreaterThan(stack.indexOf('.legend('));
    expect(stack.indexOf('fig.draw_without_rendering()')).toBeLessThan(stack.indexOf('fig.savefig('));
    // Ticks pointing in stay; a right axis is trimmed with its panel.
    const inward = scriptOf(FIG.grid0).script;
    expect(inward).not.toMatch(/bottom=False|top=False|left=False|right=False/);
    expect(inward).toContain("ax.spines['right'].set_visible(False)");
    const twin = figureScript({ panelGap: { h: 0 }, panels: [{ series: [wave(1), wave(2, { id: 'r', yAxis: 'right' })] }, { series: [wave(3)] }] });
    expect(twin).toContain("        (ax, ax.yaxis, 'bottom'), (ax, ax_right.yaxis, 'bottom'),\n        (ax_panel2, ax_panel2.yaxis, 'top'),\n):");
    // An inset: inside its parent, out of the layout, its box and lines drawn after a layout.
    const inset = scriptOf(FIG.inset);
    expect(inset.names).toEqual(['ax', 'ax_zoom']);
    // Its panel has a right axis, drawn after the panel's own: the inset is made on that one, to lie over both.
    expect(inset.script).toContain('ax_zoom = ax_right.inset_axes([0.08, 0.08, 0.4, 0.35])\nax_zoom.set_in_layout(False)');
    expect(inset.script.indexOf('ax_right = ax.twinx()')).toBeLessThan(inset.script.indexOf('ax_zoom = ax_right.inset_axes'));
    expect(figureScript({ panels: [{ id: 'main', series: [wave(1)] }, FIG.inset.panels[1]] })).toContain('ax_zoom = ax.inset_axes([0.08, 0.08, 0.4, 0.35])');
    expect(inset.script).toContain("fig.draw_without_rendering()\n# What the inset enlarges: the box of its limits on its panel, and two lines to its\n# corners.\nax.indicate_inset_zoom(ax_zoom, edgecolor='#1a1a1a', alpha=0.5)");
    expect(inset.script).toContain('ax_zoom.set_xlim(6, 9)\n');
    expect(inset.script).toContain('for axes in (ax, ax_zoom):\n    axes.set_facecolor(');
    const row = scriptOf(FIG.insetRow).script;
    expect(row).toContain('ax_in = ax_b.inset_axes([0.5, 0.5, 0.45, 0.4])');
    expect(row).toContain('ax_in_top = ax_in.twiny()\nax_in_top.set_in_layout(False)');
    expect(row).not.toMatch(/indicate_inset|draw_without_rendering/);
    expect(row).toMatch(/^ax_in_top\.legend\(/m);
    // A map in an inset has no colour bar, in the script as in the preview.
    const mapped = { panels: [{ id: 'main', series: [wave(1)] }, { id: 'in', inset: { parent: 'main' }, series: [map()] }] };
    expect(figureScript(mapped)).toMatch(/^map_mesh = ax_in\.pcolormesh\(/m);
    expect(figureScript(mapped)).not.toContain('fig.colorbar');
    expect(buildFigure(mapped).info.colorbars).toEqual([null, null]);
  });

  withPython('every layout runs without errors or warnings', () => {
    for (const [k, r] of Object.entries(got)) {
      expect([k, r.code, r.stderr]).toEqual([k, 0, '']);
      expect([k, r.fig.axes.length]).toEqual([k, normaliseFigure(FIG[k]).panels.length]);
    }
  });

  withPython('matplotlib puts the panels, the colour bars and the insets where the preview does', () => {
    // Text is measured from font averages here, so to a few px, as for the colour bar above.
    const TOL = 8;
    for (const [k, r] of Object.entries(got)) {
      const info = infoOf(k);
      r.fig.axes.forEach((a, i) => {
        const b = info.axes[i];
        const off = [a.box[0] - b.l, a.box[1] - b.t, a.box[2] - b.r, a.box[3] - b.b].map(Math.abs);
        if (Math.max(...off) > TOL) throw new Error(`${k} panel ${i}: matplotlib ${a.box.map((v) => v.toFixed(1))}, preview ${[b.l, b.t, b.r, b.b].map((v) => v.toFixed(1))}`);
      });
      const bars = info.colorbars.filter(Boolean);
      expect([k, r.fig.colorbars.length]).toEqual([k, bars.length]);
      r.fig.colorbars.forEach((c, i) => {
        const b = bars[i];
        expect([k, i, Math.max(...[c[0] - b.l, c[1] - b.t, c[2] - b.r, c[3] - b.b].map(Math.abs)) < TOL]).toEqual([k, i, true]);
      });
      if (info.title) {
        const t = r.fig.suptitle;
        expect([k, t[0]]).toEqual([k, FIG[k].title]);
        expect(Math.abs((t[1] + t[3]) / 2 - (info.title.l + info.title.r) / 2)).toBeLessThan(1.5);
        expect(Math.abs(t[2] - info.title.t)).toBeLessThan(2);
      } else expect([k, r.fig.suptitle]).toEqual([k, null]);
    }
    // Rows and columns at their ratios, and the same on both sides to a small fraction.
    const s = got.spans.fig.axes;
    expect((s[2].box[3] - s[2].box[1]) / (s[0].box[3] - s[0].box[1])).toBeCloseTo(2, 2);
    const p = infoOf('spans').axes;
    expect((p[2].b - p[2].t) / (p[0].b - p[0].t)).toBeCloseTo(2, 9);
  });

  withPython('the limits, the scales and what is shared are matplotlib\'s', () => {
    for (const [k, r] of Object.entries(got)) {
      const info = infoOf(k);
      r.fig.axes.forEach((a, i) => {
        const v = info.views[i];
        const ok = [...a.xlim.map((x, j) => close(x, v.x.view[j])), ...a.ylim.map((y, j) => close(y, v.y.view[j]))].every(Boolean);
        if (!ok) throw new Error(`${k} panel ${i}: matplotlib x ${a.xlim} y ${a.ylim}, preview x ${v.x.view} y ${v.y.view}`);
        // The panels matplotlib links are the ones the description shares.
        const group = (key) => info.share.map((q, j) => j).filter((j) => info.share[j][key] === info.share[i][key]);
        expect([k, i, a.sharex, a.sharey]).toEqual([k, i, group('x'), group('y')]);
      });
    }
    // Down a column the x axis is one; along a row the y axis.
    const g = got.grid.fig.axes;
    expect(g[0].xlim).toEqual(g[2].xlim);
    expect(g[1].xlim).toEqual(g[3].xlim);
    expect(g[1].xlim[1]).toBeGreaterThan(100);
    expect(g[0].xlim[1]).toBeLessThan(20);
    expect(g[0].ylim).toEqual(g[1].ylim);
    expect(g[2].ylim).not.toEqual(g[0].ylim);
  });

  withPython('tick labels and axis labels stand on the outer panels only, as in the preview', () => {
    for (const [k, r] of Object.entries(got)) {
      const info = infoOf(k);
      const f = normaliseFigure(FIG[k]);
      r.fig.axes.forEach((a, i) => {
        expect([k, i, a.xticks.length > 0, a.yticks.length > 0]).toEqual([k, i, info.share[i].xLabels, info.share[i].yLabels]);
        expect([k, i, a.xlabel, a.ylabel]).toEqual([k, i, f.panels[i].xOuter ? f.panels[i].xLabel : '', f.panels[i].yOuter ? f.panels[i].yLabel : '']);
        // The labels drawn are the preview's ticks, less the ones left out at a shared edge.
        const gone = info.hiddenLabels.filter((x) => x.panel === i);
        for (const axis of ['x', 'y']) {
          const want = info.share[i][`${axis}Labels`] ? info.ticks[i][axis].major.filter((t) => t.text && !gone.some((x) => x.axis === axis && x.v === t.v)).map((t) => t.v) : [];
          const have = a[`${axis}ticks`];
          if (have.length !== want.length || have.some((v, j) => !close(v, want[j]))) throw new Error(`${k} panel ${i} ${axis} tick labels: matplotlib ${have}, preview ${want}`);
        }
      });
    }
    // The grid with a hole: the panel over the empty cell keeps its x labels.
    expect(got.holes.fig.axes.map((a) => [a.xticks.length > 0, a.yticks.length > 0])).toEqual([[false, true], [true, false], [true, true]]);
  });

  withPython('no gap: matplotlib\'s panels meet in one line, drawn by the lower or right-hand one', () => {
    const touch = (a, b, side) => Math.abs(side === 'below' ? a.box[3] - b.box[1] : a.box[2] - b.box[0]);
    const s = got.stack0.fig.axes;
    expect(touch(s[0], s[1], 'below')).toBeLessThan(0.05);
    expect(touch(s[1], s[2], 'below')).toBeLessThan(0.05);
    expect(s.map((a) => [a.spines.bottom, a.spines.top])).toEqual([[false, true], [false, true], [true, true]]);
    // The labels at the shared edges are gone in both: −1 above an edge, 1 below one.
    expect(infoOf('stack0').hiddenLabels.map((x) => [x.panel, x.v])).toEqual([[0, -1], [1, -1], [1, 1], [2, 1]]);
    expect(s.map((a) => [a.yticks.includes(-1), a.yticks.includes(1)])).toEqual([[false, true], [false, false], [true, false]]);
    const g = got.grid0.fig.axes;
    expect([touch(g[0], g[2], 'below'), touch(g[1], g[3], 'below'), touch(g[0], g[1], 'beside'), touch(g[2], g[3], 'beside')].every((d) => d < 0.05)).toBe(true);
    // The frame has no top or right line, but the shared edges are drawn: by the lower panel's top line, the right-hand panel's left one.
    expect(g.map((a) => [a.spines.left, a.spines.bottom, a.spines.top, a.spines.right])).toEqual([[true, false, false, false], [true, false, false, false], [true, true, true, false], [true, true, true, false]]);
    expect(infoOf('grid0').edges.map((e) => Object.keys(e).filter((side) => e[side]).sort())).toEqual([['bottom', 'right'], ['bottom', 'left'], ['right', 'top'], ['left', 'top']]);
    // With a gap asked for, the panels stand that much further apart than matplotlib's own 6 pt (the
    // same in the preview: only the gap differs).
    const own = buildFigure({ ...FIG.narrow, panelGap: null }).info.axes;
    const narrow = infoOf('narrow').axes;
    expect((own[1].t - own[0].b) - (narrow[1].t - narrow[0].b)).toBeCloseTo(4 * 96 / 72, 0);
    const n = got.narrow.fig.axes;
    expect(Math.abs((n[1].box[1] - n[0].box[3]) - (narrow[1].t - narrow[0].b))).toBeLessThan(4);
    const wide = got.gaps.fig.axes; const wideP = infoOf('gaps').axes;
    expect(Math.abs((wide[2].box[1] - wide[0].box[3]) - (wideP[2].t - wideP[0].b))).toBeLessThan(4);
    expect(Math.abs((wide[1].box[0] - wide[0].box[2]) - (wideP[1].l - wideP[0].r))).toBeLessThan(6);
    expect(wide[2].box[1] - wide[0].box[3]).toBeGreaterThan(20 * 96 / 72);
  });

  withPython('letters stand at the corner the preview puts them at', () => {
    for (const k of ['grid', 'grid0', 'spans']) {
      const info = infoOf(k);
      const f = normaliseFigure(FIG[k]);
      const letters = panelLetters(f);
      got[k].fig.axes.forEach((a, i) => {
        const [text, l, t, r, b] = a.texts[a.texts.length - 1];
        expect([k, i, text]).toEqual([k, i, letters[i]]);
        const L = info.letters[i];
        // Measured from the panel's own corner, in matplotlib and in the preview: where the layout put the
        // panel is checked above, and at this resolution a tick label's width moves it by a pixel or two from
        // one FreeType to the next. The corner the letter is anchored at is exact; its far side depends on the font.
        const [al, at] = a.box; const A = info.axes[i];
        if (f.panelLabels.position === 'outside') expect([k, i, Math.abs((r - al) - (L.r - A.l)) < 0.5, Math.abs((b - at) - (L.b - A.t)) < 0.5]).toEqual([k, i, true, true]);
        else expect([k, i, Math.abs((l - al) - (L.l - A.l)) < 0.5, Math.abs((t - at) - (L.t - A.t)) < 0.5]).toEqual([k, i, true, true]);
      });
    }
    // Outside, a letter is inside the page: the layout made room for it.
    const outside = got.spans.fig.axes[0].texts.slice(-1)[0];
    expect(outside[2]).toBeGreaterThan(0);
  });

  withPython('an inset is its parent\'s child, out of the layout, where the preview draws it', () => {
    for (const [k, at, parent] of [['inset', 1, 0], ['insetRow', 2, 1]]) {
      const a = got[k].fig.axes; const spec = normaliseFigure(FIG[k]).panels[at].inset;
      expect([k, a[at].child, a[at].inLayout, a[parent].child, a[parent].inLayout]).toEqual([k, true, false, false, true]);
      const pb = a[parent].box; const ib = a[at].box;
      expect((ib[0] - pb[0]) / (pb[2] - pb[0])).toBeCloseTo(spec.x, 4);
      expect((pb[3] - ib[3]) / (pb[3] - pb[1])).toBeCloseTo(spec.y, 4);
      expect((ib[2] - ib[0]) / (pb[2] - pb[0])).toBeCloseTo(spec.w, 4);
      expect((ib[3] - ib[1]) / (pb[3] - pb[1])).toBeCloseTo(spec.h, 4);
      // The inset takes no room: its parent is where it would be without it.
      const without = buildFigure({ ...FIG[k], panels: FIG[k].panels.filter((p) => !p.inset) }).info.axes[parent];
      expect(infoOf(k).axes[parent]).toEqual(without);
    }
    expect([got.inset.fig.axes[1].xlim, got.inset.fig.axes[1].ylim]).toEqual([[6, 9], [0, 1]]);
    // The zoom box is drawn on the parent (a Rectangle and its connectors before matplotlib 3.10, one artist since).
    const version = got.inset.fig.version.split('.').map(Number);
    if (version[0] === 3 && version[1] < 10) expect(got.inset.fig.axes[0].patches).toEqual(['Rectangle', 'ConnectionPatch', 'ConnectionPatch', 'ConnectionPatch', 'ConnectionPatch']);
    expect(got.insetRow.fig.axes[1].patches).toEqual([]);
    // The right axis of the parent and the top axis of the inset are axes too: 2 panels and their twins.
    expect(got.inset.fig.count).toBe(2);
    expect(isStack(normaliseFigure(FIG.inset))).toBe(false);
  });
});
