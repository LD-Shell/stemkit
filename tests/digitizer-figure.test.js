/**
 * The Plot Digitizer's plot of the digitised series (digitizerFigure) and
 * its matplotlib script (digitizerFigureScript), from src/core/digitizer.js.
 * The scripts are run when Python with numpy and matplotlib is installed:
 * they read the CSV the page saves (generateCSV), and the axis limits
 * matplotlib picks are the ones the preview (js/figure-plot.js) computed.
 */
import { describe, test, expect, afterAll } from '@jest/globals';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateCSV, formatValue, exportNames, digitizerFigure, digitizerFigureScript, digitisePoints
} from '../src/core/digitizer.js';
import { normaliseFigure, applyStyle } from '../src/core/figure.js';
import { buildFigure } from '../js/figure-plot.js';

const PYTHON = (() => {
  try {
    return spawnSync('python3', ['-c', 'import numpy, matplotlib'], { encoding: 'utf8', timeout: 60000 }).status === 0;
  } catch {
    return false;
  }
})();
const withPython = PYTHON ? test : test.skip;

const INSPECT = String.raw`

# --- test only: report what was drawn ---
import json as _json
fig.canvas.draw()


def _panel(a):
    leg = a.get_legend()
    return {
        'xlim': [float(v) for v in a.get_xlim()], 'ylim': [float(v) for v in a.get_ylim()],
        'xscale': a.get_xscale(), 'yscale': a.get_yscale(),
        'legend': [t.get_text() for t in leg.get_texts()] if leg else None,
        'xlabel': a.get_xlabel(), 'ylabel': a.get_ylabel(),
        'lineX': [[float(v) for v in l.get_xdata()] for l in a.get_lines()],
        'lineY': [[float(v) for v in l.get_ydata()] for l in a.get_lines()],
        'colors': [l.get_color() for l in a.get_lines()],
    }


print('@@FIG@@' + _json.dumps({'panels': [_panel(a) for a in fig.axes]}))
`;

const dirs = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function run(script, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stemkit-digitizer-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'plot.py'), script + INSPECT);
  Object.entries(files).forEach(([name, text]) => writeFileSync(join(dir, name), text));
  return new Promise((resolve) => {
    const child = spawn('python3', ['plot.py'], { cwd: dir, env: { ...process.env, MPLBACKEND: 'Agg' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      const line = stdout.split('\n').find((l) => l.startsWith('@@FIG@@'));
      resolve({ code, stderr, dir, fig: line ? JSON.parse(line.slice(7)) : null });
    });
  });
}

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
function expectSameLimits(fig, drawn, name) {
  const want = previewRanges(fig);
  expect(drawn.panels).toHaveLength(want.length);
  drawn.panels.forEach((p, i) => {
    const [x, y] = want[i];
    const ok = [...p.xlim.map((v, k) => close(v, x[k])), ...p.ylim.map((v, k) => close(v, y[k]))].every(Boolean);
    if (!ok) throw new Error(`${name} panel ${i + 1}: matplotlib x ${p.xlim} y ${p.ylim}, preview x ${x} y ${y}`);
  });
}

/* Two curves traced on a figure 0-10 across and 0-100 up (the page's sample),
   clicked out of order, plus an empty series and one on a log axis. */
const LINEAR = { pxX1: 90, pxX2: 760, pxY1: 480, pxY2: 50, valX1: 0, valX2: 10, valY1: 0, valY2: 100 };
const px = (x, y) => ({ pxX: 90 + (x / 10) * 670 + 0.37, pxY: 480 - (y / 100) * 430 - 0.21 });
const trace = (f, xs) => xs.map((x) => px(x, f(x)));
const DATASETS = [
  { id: 'ds_1', name: 'Fast, "first" run', color: '#ef4444', points: trace((x) => 100 * (1 - Math.exp(-x / 3)), [3, 0, 1, 2, 5, 4, 7, 6, 9, 8, 10]) },
  { id: 'ds_2', name: 'Series 2', color: '#3b82f6', points: [] },
  { id: 'ds_3', name: '  ', color: '#10b981', points: trace((x) => 100 * (1 - Math.exp(-x / 7)), [0, 2.5, 5, 7.5, 10]) },
  { id: 'ds_4', name: 'Fast, "first" run', color: '#f59e0b', points: trace((x) => 50 + 3 * x, [1, 9]) }
].map((ds) => ({ ...ds, points: digitisePoints(ds.points, LINEAR) }));

const csvOf = (datasets) => {
  const names = exportNames(datasets);
  return generateCSV(datasets.map((ds, i) => ({ ...ds, name: names[i] })));
};

describe('exportNames', () => {
  test('gives every series a name of its own', () => {
    expect(exportNames([{ name: 'A' }, { name: ' ' }, { name: 'A' }, { name: 'A ' }, {}])).toEqual(['A', 'Series 2', 'A (2)', 'A (3)', 'Series 5']);
    expect(exportNames(null)).toEqual([]);
  });
});

describe('digitizerFigure', () => {
  test('draws each series with points, as the CSV holds them', () => {
    const fig = digitizerFigure(DATASETS, { filename: 'run_plot' });
    const s = fig.panels[0].series;
    expect(s.map((q) => q.label)).toEqual(['Fast, "first" run', 'Series 3', 'Fast, "first" run (2)']);
    expect(s.map((q) => q.color)).toEqual(['#ef4444', '#10b981', '#f59e0b']);
    expect(s[0].marker).toBe('o');
    const x = s[0].x.values;
    expect(x).toEqual([...x].sort((a, b) => a - b));
    expect(x.every((v) => String(v) === formatValue(v))).toBe(true);
    expect(fig.export.filename).toBe('run_plot');
  });

  test('is null until a series has a point', () => {
    expect(digitizerFigure([{ id: 'a', name: 'A', points: [] }])).toBeNull();
    expect(digitizerFigure(null)).toBeNull();
  });

  test('takes the axes\' log scales, and a panel per series when asked', () => {
    const fig = digitizerFigure(DATASETS, { logX: true, logY: true, panels: true, xLabel: 'Time (h)', yLabel: 'Conversion (%)' });
    expect(fig.xScale).toBe('log');
    expect(fig.panels).toHaveLength(3);
    expect(fig.panels.every((p) => p.yScale === 'log' && p.yLabel === 'Conversion (%)')).toBe(true);
    expect(fig.panels[1].name).toBe('Series 3');
    expect(digitizerFigure(DATASETS.slice(0, 1), { panels: true }).panels).toHaveLength(1);
  });
});

describe('digitizerFigureScript', () => {
  test('reads each series from the CSV by its name', () => {
    const code = digitizerFigureScript(digitizerFigure(DATASETS), { csvName: 'run.csv' });
    expect(code).toMatch(/^import csv\n\nimport numpy as np$/m);
    expect(code).toContain("points = read_digitised('run.csv')");
    expect(code).toContain("Series_3_x, Series_3_y = points['Series 3']");
    expect(code).toContain("points['Fast, \"first\" run (2)']");
    expect(code).not.toContain('np.array([');
  });

  test('holds the points when asked', () => {
    const code = digitizerFigureScript(digitizerFigure(DATASETS), { source: 'embed' });
    expect(code).not.toContain('import csv');
    expect(code).toContain('Series_3_x = np.array([');
  });
});

describe('the script draws what the page shows', () => {
  withPython('from the CSV, with the person\'s style', async () => {
    const fig = applyStyle(digitizerFigure(DATASETS, { filename: 'run_plot' }), { xLabel: 'Time (h)', panels: [{ yLabel: 'Conversion (%)', yLim: [0, null] }], grid: { show: true } });
    const r = await run(digitizerFigureScript(normaliseFigure(fig), { csvName: 'run.csv' }), { 'run.csv': csvOf(DATASETS) });
    expect([r.code, r.stderr]).toEqual([0, '']);
    expect(existsSync(join(r.dir, 'run_plot.pdf'))).toBe(true);
    expectSameLimits(fig, r.fig, 'linear');
    const [p] = r.fig.panels;
    expect(p.legend).toEqual(['Fast, "first" run', 'Series 3', 'Fast, "first" run (2)']);
    expect(p.xlabel).toBe('Time (h)');
    const want = normaliseFigure(fig).panels[0].series;
    p.lineX.forEach((xs, i) => expect(xs).toEqual(want[i].x));
    p.lineY.forEach((ys, i) => expect(ys).toEqual(want[i].y));
  }, 60000);

  withPython('log axes in a panel per series, from the CSV and held in the script', async () => {
    const LOG = { ...LINEAR, valX1: 1, valX2: 1000, valY1: 0.01, valY2: 100, logX: true, logY: true };
    const sets = DATASETS.map((ds) => ({ ...ds, points: digitisePoints(ds.points, LOG) }));
    const fig = digitizerFigure(sets, { logX: true, logY: true, panels: true });
    const [a, b] = await Promise.all([
      run(digitizerFigureScript(fig, {}), { 'extracted_data.csv': csvOf(sets) }),
      run(digitizerFigureScript(fig, { source: 'embed' }))
    ]);
    for (const r of [a, b]) {
      expect([r.code, r.stderr]).toEqual([0, '']);
      expectSameLimits(fig, r.fig, 'log');
      expect(r.fig.panels.map((p) => [p.xscale, p.yscale])).toEqual([['log', 'log'], ['log', 'log'], ['log', 'log']]);
    }
  }, 60000);
});
