/**
 * The XVG Visualizer's figure (xvgFigure) and its matplotlib script
 * (xvgFigureScript), from src/core/xvg-parser.js. The scripts are run when
 * Python with numpy and matplotlib is installed: they read the file as the
 * page read it, and the axis limits matplotlib picks are the ones the
 * preview (js/figure-plot.js) computed.
 */
import { describe, test, expect, afterAll } from '@jest/globals';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseXvg, generateSampleXvg, extractColumn,
  xvgFigure, xvgFigureScript, xvgReadLines, xvgColors, runningMean, averageWindow, graceToTex, graceToPlain
} from '../src/core/xvg-parser.js';
import { normaliseFigure, applyStyle, colorCycle } from '../src/core/figure.js';
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
        'yscale': a.get_yscale(), 'lines': len(a.get_lines()),
        'legend': [t.get_text() for t in leg.get_texts()] if leg else None,
        'legendTitle': leg.get_title().get_text() if leg else None,
        'xlabel': a.get_xlabel(), 'ylabel': a.get_ylabel(), 'title': a.get_title(),
        'lineData': [[float(v) for v in l.get_ydata()[:3]] for l in a.get_lines()],
        'lineLengths': [len(l.get_ydata()) for l in a.get_lines()],
    }


print('@@FIG@@' + _json.dumps({'panels': [_panel(a) for a in fig.axes]}))
`;

const dirs = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function run(script, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stemkit-xvg-'));
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

function expectSameLimits(fig, drawn, name) {
  const want = previewRanges(fig);
  expect(drawn.panels).toHaveLength(want.length);
  drawn.panels.forEach((p, i) => {
    const [x, y] = want[i];
    const ok = [...p.xlim.map((v, k) => close(v, x[k])), ...p.ylim.map((v, k) => close(v, y[k]))].every(Boolean);
    if (!ok) throw new Error(`${name} panel ${i + 1}: matplotlib x ${p.xlim} y ${p.ylim}, preview x ${x} y ${y}`);
  });
}

/* ------------------------------------------------------------------ *
 * Files
 * ------------------------------------------------------------------ */

const SAMPLE = generateSampleXvg({ seed: 11 });

// gmx gyrate writes Grace escapes in its legends.
const GYRATE = [
  '# This file was created by gmx gyrate',
  '@    title "Radius of gyration (total and around axes)"',
  '@    xaxis  label "Time (ps)"',
  '@    yaxis  label "Rg (nm)"',
  '@TYPE xy',
  '@ s0 legend "Rg"',
  '@ s1 legend "Rg\\sX\\N"',
  '@ s2 legend "\\xD\\f{}Rg\\S2\\N"',
  ...Array.from({ length: 60 }, (_, i) => `${(i * 5).toFixed(1)}  ${(1.8 + 0.02 * Math.sin(i / 5)).toFixed(4)}  ${(1.2 + 0.01 * Math.cos(i / 7)).toFixed(4)}  ${(0.001 * i * i).toFixed(4)}`)
].join('\n') + '\n';

// A CSV with a header, a stray text row and an empty cell among the numbers,
// and a comma at the end of every row.
const MESSY_CSV = 'time,a,b,\n' + Array.from({ length: 40 }, (_, i) => {
  if (i === 7) return 'note: restart here,';
  if (i === 12) return `${i},,${i * 2},`;
  return `${i},${(Math.sin(i / 4) * 3).toFixed(3)},${(i * 0.5 + 2).toFixed(2)},`;
}).join('\n') + '\n';

const HEADED_CSV = '# exported\n\n"Time (ns)", "Distance (nm)"\r\n' +
  Array.from({ length: 30 }, (_, i) => `${i * 0.1}, ${(1 + i * i * 0.01).toFixed(3)}`).join('\r\n') + '\r\n';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

describe('running means', () => {
  test('are numpy.convolve with equal weights, mode valid', () => {
    expect(runningMean([1, 2, 3, 4, 5], 2)).toEqual([1.5, 2.5, 3.5, 4.5]);
    expect(runningMean([2, 4, 6], 3)).toEqual([4]);
    expect(runningMean([1, 2], 3)).toEqual([]);
    expect(runningMean([1, 2], 0)).toEqual([]);
  });

  test('stay accurate over a long run with a wide window', () => {
    const v = Array.from({ length: 30000 }, (_, i) => 1e6 + Math.sin(i / 50) * 100);
    const fast = runningMean(v, 1001);
    let s = 0;
    for (let j = 25000; j < 26001; j++) s += v[j];
    expect(Math.abs(fast[25000] - s / 1001)).toBeLessThan(1e-6);
  });

  test('take a window from 2 up to the number of rows', () => {
    expect(averageWindow(10, 100)).toBe(10);
    expect(averageWindow(500, 100)).toBe(100);
    expect(averageWindow(1, 100)).toBe(0);
    expect(averageWindow('x', 100)).toBe(0);
    expect(averageWindow(10, 1)).toBe(0);
  });
});

describe('Grace text', () => {
  test('sub- and superscripts and Greek letters become mathematics', () => {
    expect(graceToTex('Rg\\sX\\N')).toBe('Rg$_{\\mathrm{X}}$');
    expect(graceToTex('Area (nm\\S2\\N)')).toBe('Area (nm$^{2}$)');
    expect(graceToTex('\\xD\\f{}G (kJ mol\\S-1\\N)')).toBe('$\\Delta$G (kJ mol$^{-1}$)');
    expect(graceToTex('k\\s\\xq\\f{}\\N')).toBe('k$_{\\theta}$');
  });

  test('text without escapes is left as it is, dollars and all', () => {
    expect(graceToTex('Cost ($)')).toBe('Cost ($)');
    expect(graceToTex('$\\tau$ (ps)')).toBe('$\\tau$ (ps)');
  });

  test('a dollar beside Grace mathematics is escaped', () => {
    expect(graceToTex('$ per nm\\S2\\N')).toBe('\\$ per nm$^{2}$');
  });

  test('reads as plain text for lists and names', () => {
    expect(graceToPlain('Rg\\sX\\N')).toBe('Rg_X');
    expect(graceToPlain('\\xa\\f{}-helix')).toBe('α-helix');
    expect(graceToPlain('Area (nm\\S2\\N)')).toBe('Area (nm^2)');
  });
});

describe('xvgFigure', () => {
  const parsed = parseXvg(SAMPLE, { fallbackTitle: 'rmsd.xvg' });

  test('draws the chosen columns with the file\'s labels and legends', () => {
    const fig = xvgFigure(parsed, { series: [1, 2], filename: 'rmsd.xvg' });
    expect(fig.title).toBe('RMSD & Radius of Gyration');
    expect(fig.xLabel).toBe('Time (ps)');
    expect(fig.export.filename).toBe('rmsd_plot');
    expect(fig.panels).toHaveLength(1);
    expect(fig.panels[0].yLabel).toBe('nm');
    expect(fig.panels[0].series.map((s) => s.label)).toEqual(['Backbone RMSD', 'Rg']);
    expect(fig.panels[0].series[0].y).toEqual({ values: extractColumn(parsed.matrix, 1), source: 'xvg', column: 1 });
  });

  test('is null with nothing to draw', () => {
    expect(xvgFigure(parsed, { series: [] })).toBeNull();
    expect(xvgFigure(parsed, { series: [0] })).toBeNull();
    expect(xvgFigure(parseXvg(''), { series: [1] })).toBeNull();
  });

  test('puts columns on another scale in a panel below, while one stays above', () => {
    const fig = xvgFigure(parsed, { series: [1, 2], lower: [2] });
    expect(fig.panels.map((p) => p.series.map((s) => s.id))).toEqual([['col1'], ['col2']]);
    expect(fig.panels[1].yLabel).toBe('Rg');
    expect(xvgFigure(parsed, { series: [1, 2], lower: [1, 2] }).panels).toHaveLength(1);
  });

  test('keeps each column\'s colour whichever others are drawn', () => {
    const one = xvgFigure(parsed, { series: [2] });
    const both = xvgFigure(parsed, { series: [1, 2] });
    expect(one.panels[0].series[0].color).toBe(both.panels[0].series[1].color);
    expect(xvgColors(3, 0)).toEqual({ 1: colorCycle()[0], 2: colorCycle()[1] });
    expect(xvgColors(3, 0, '#111111')[1]).toBe(colorCycle('#111111')[0]);
  });

  test('draws a running mean over the faded data, in the same colour', () => {
    const fig = xvgFigure(parsed, { series: [1], average: 10 });
    const [data, mean] = fig.panels[0].series;
    expect(data.legend).toBe(false);
    expect(data.alpha).toBeLessThan(1);
    expect(mean.color).toBe(data.color);
    expect(mean.y.values).toEqual(runningMean(extractColumn(parsed.matrix, 1), 10));
    expect(mean.x.values).toHaveLength(parsed.rowCount - 9);
    expect(fig.legend.title).toBe('Running mean, 10 points');
    expect(xvgFigure(parsed, { series: [1], average: 10, raw: false }).panels[0].series.map((s) => s.id)).toEqual(['col1_mean']);
  });

  test('sets Grace escapes as mathematics', () => {
    const fig = xvgFigure(parseXvg(GYRATE), { series: [1, 2, 3] });
    expect(fig.panels[0].series.map((s) => s.label)).toEqual(['Rg', 'Rg$_{\\mathrm{X}}$', '$\\Delta$Rg$^{2}$']);
    expect(fig.panels[0].yLabel).toBe('Rg (nm)');
  });
});

describe('xvgFigureScript', () => {
  const parsed = parseXvg(SAMPLE);

  test('reads the columns by number and names them after their headers', () => {
    const code = xvgFigureScript(xvgFigure(parsed, { series: [1, 2] }), parsed, { filename: 'rmsd.xvg' });
    expect(code).toContain("data = np.loadtxt('rmsd.xvg', comments=['@', '#', '&'], ndmin=2)");
    expect(code).toContain('Time_ps = data[:, 0]');
    expect(code).toContain('Backbone_RMSD = data[:, 1]');
    expect(code).not.toContain('np.array([');
    expect(code).toBe(xvgFigureScript(xvgFigure(parsed, { series: [1, 2] }), parsed, { filename: 'rmsd.xvg' }));
  });

  test('holds the numbers when asked', () => {
    const code = xvgFigureScript(xvgFigure(parsed, { series: [1] }), parsed, { source: 'embed' });
    expect(code).toContain('Backbone_RMSD = np.array([');
    expect(code).not.toContain('loadtxt');
  });

  test('keeps a long trajectory in the file: the script stays short', () => {
    let big = '@ s0 legend "d"\n';
    for (let i = 0; i < 200000; i++) big += `${i} ${Math.sin(i / 100).toFixed(4)}\n`;
    const p = parseXvg(big);
    const code = xvgFigureScript(xvgFigure(p, { series: [1], average: 50 }), p, { filename: 'big.xvg' });
    expect(code.length).toBeLessThan(10000);
  });

  test('reads a CSV\'s header and odd rows as the page did', () => {
    const csv = parseXvg(HEADED_CSV);
    expect(xvgReadLines(csv, 'd.csv').join('\n')).toContain("delimiter=',', skiprows=3");
    const messy = parseXvg(MESSY_CSV);
    const lines = xvgReadLines(messy, 'm.csv').join('\n');
    expect(lines).toContain('def is_record(line):');
    expect(lines).toContain('len(fields) == 3');
    expect(lines).toContain("usecols=range(3)");
  });

  test('never gives a column the name of a series or a panel', () => {
    const p = parseXvg('t,col1,ax_lower\n0,1,2\n1,2,3\n2,3,5\n');
    const code = xvgFigureScript(xvgFigure(p, { series: [1, 2], lower: [2] }), p, { filename: 'x.csv' });
    expect(code).toMatch(/^col1_2 = data\[:, 1\]/m);
    expect(code).toMatch(/^ax_lower_2 = data\[:, 2\]/m);
  });
});

/* ------------------------------------------------------------------ *
 * The scripts run, read the file, and draw the preview's figure
 * ------------------------------------------------------------------ */

describe('the script draws what the page shows', () => {
  withPython('two panels, a running mean and markers, read from the .xvg', async () => {
    const parsed = parseXvg(SAMPLE);
    const fig = xvgFigure(parsed, { series: [1, 2], lower: [2], average: 7, markers: true, filename: 'rmsd.xvg' });
    const r = await run(xvgFigureScript(fig, parsed, { filename: 'rmsd.xvg' }), { 'rmsd.xvg': SAMPLE });
    expect([r.code, r.stderr]).toEqual([0, '']);
    expect(existsSync(join(r.dir, 'rmsd_plot.pdf'))).toBe(true);
    expectSameLimits(fig, r.fig, 'sample');
    const [top, bottom] = r.fig.panels;
    expect(top.legend).toEqual(['Backbone RMSD']);
    expect(top.legendTitle).toBe('Running mean, 7 points');
    expect(bottom.xlabel).toBe('Time (ps)');
    expect(top.lineLengths).toEqual([parsed.rowCount, parsed.rowCount - 6]);
    const mean = runningMean(extractColumn(parsed.matrix, 1), 7);
    top.lineData[1].forEach((v, i) => expect(close(v, mean[i])).toBe(true));
    expect(top.lineData[0]).toEqual(extractColumn(parsed.matrix, 1).slice(0, 3));
  }, 60000);

  withPython('the same figure with the numbers in the script, and with the person\'s log scale', async () => {
    const parsed = parseXvg(SAMPLE);
    const fig = applyStyle(xvgFigure(parsed, { series: [1, 2], lower: [1] }), { panels: [{ yScale: 'log' }, { yScale: 'log' }], xLabel: 'Time / ps' });
    const r = await run(xvgFigureScript(normaliseFigure(fig), parsed, { source: 'embed' }));
    expect([r.code, r.stderr]).toEqual([0, '']);
    expectSameLimits(fig, r.fig, 'embedded, log');
    expect(r.fig.panels.map((p) => p.yscale)).toEqual(['log', 'log']);
    expect(r.fig.panels[1].xlabel).toBe('Time / ps');
  }, 60000);

  withPython('Grace escapes, a messy CSV and a CSV with a header row', async () => {
    const gyr = parseXvg(GYRATE);
    const gFig = xvgFigure(gyr, { series: [1, 2, 3], lower: [3], filename: 'gyrate.xvg' });
    const messy = parseXvg(MESSY_CSV);
    const mFig = xvgFigure(messy, { series: [1, 2], average: 5, raw: false, filename: 'messy.csv' });
    const headed = parseXvg(HEADED_CSV);
    const hFig = xvgFigure(headed, { series: [1], filename: 'headed.csv' });
    const [g, m, h] = await Promise.all([
      run(xvgFigureScript(gFig, gyr, { filename: 'gyrate.xvg' }), { 'gyrate.xvg': GYRATE }),
      run(xvgFigureScript(mFig, messy, { filename: 'messy.csv' }), { 'messy.csv': MESSY_CSV }),
      run(xvgFigureScript(hFig, headed, { filename: 'headed.csv' }), { 'headed.csv': HEADED_CSV })
    ]);
    for (const r of [g, m, h]) expect([r.code, r.stderr]).toEqual([0, '']);
    expectSameLimits(gFig, g.fig, 'gyrate');
    expectSameLimits(mFig, m.fig, 'messy');
    expectSameLimits(hFig, h.fig, 'headed');
    expect(g.fig.panels[0].legend).toEqual(['Rg', 'Rg$_{\\mathrm{X}}$']);
    expect(g.fig.panels[1].ylabel).toBe('$\\Delta$Rg$^{2}$');
    expect(g.fig.panels[0].title).toBe('Radius of gyration (total and around axes)');
    // The rows the page skipped are skipped by the script too.
    expect(m.fig.panels[0].lineLengths).toEqual([messy.rowCount - 4, messy.rowCount - 4]);
    expect(h.fig.panels[0].ylabel).toBe('Distance (nm)');
    expect(h.fig.panels[0].lineLengths).toEqual([30]);
  }, 60000);
});
