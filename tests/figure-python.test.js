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
import { normaliseFigure, applyStyle, withBackground } from '../src/core/figure.js';
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


def _panel(a):
    leg = a.get_legend()
    return {
        'xlim': [float(v) for v in a.get_xlim()], 'ylim': [float(v) for v in a.get_ylim()],
        'xscale': a.get_xscale(), 'yscale': a.get_yscale(),
        'lines': len(a.get_lines()), 'collections': [type(c).__name__ for c in a.collections],
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


print('@@FIG@@' + _json.dumps({
    'panels': [_panel(a) for a in fig.axes if a.get_label() != '<colorbar>'],
    'colorbars': [{'label': a.get_ylabel(), 'ylim': [float(v) for v in a.get_ylim()]} for a in fig.axes if a.get_label() == '<colorbar>'],
    'size': [float(v) for v in fig.get_size_inches()],
}))
`;

function run(script, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stemkit-figure-'));
  writeFileSync(join(dir, 'figure.py'), script + INSPECT);
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
  // view starts from the top panel's smallest positive x (0.25), not the
  // lower panel's (0.01), as LogLocator.nonsingular has it.
  minpos: () => ({
    xScale: 'log', export: { filename: 'minpos', format: 'png' }, dpi: 50,
    panels: [
      { series: [{ kind: 'line', x: [0, 0.25, 9.75], y: [1, 1, 1] }] },
      { series: [{ kind: 'line', x: [0.01, 10], y: [1, 2] }] }
    ]
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
    expect(code).toContain('# Needs numpy, scipy and matplotlib 3.6 or later.');
    expect(code).not.toMatch(/^reserved\b/m);
    const plain = figureScript({ panels: [{ series: [{ kind: 'line', x: [1, 2], y: [1, 2] }] }] });
    expect(plain).toContain('# Needs numpy and matplotlib 3.6 or later.');
    expect(figureScript(fig, { prelude: ['stats = {}'] })).toContain('from scipy import stats as scipy_stats');
    expect(figureScript({ panels: [] }, { prelude: ['import pandas as pd'] })).toContain('# Needs numpy, pandas and matplotlib 3.6 or later.');
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

  withPython('a shared log x axis starts from the top panel\'s smallest positive x', () => {
    const [top] = runs.minpos.fig.panels;
    expect(top.xlim[0]).toBeCloseTo(0.20794, 4);
    expect(top.xlim[1]).toBeCloseTo(12.0255, 3);
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
