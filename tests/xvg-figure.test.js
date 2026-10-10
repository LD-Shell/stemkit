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
  xvgFigure, xvgFigureScript, xvgReadLines, xvgColors, runningMean, averageWindow, graceToTex, graceToPlain,
  xvgSeries, xvgWindow, xvgEmbeddedCount
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

// Two (x, y) sets of different lengths, one after the other, as gmx tcaf
// and gmx analyze write them: `xmgrace -nxy` makes them s0 and s1.
const TWO_SETS = [
  '@    title "TCAF fits"', '@    xaxis  label "Time (ps)"', '@    yaxis  label "C(t)"', '@TYPE xy',
  '@ s0 legend "k = 1.0"', '@ s1 legend "k = 2.0"',
  ...Array.from({ length: 40 }, (_, i) => `${i} ${Math.exp(-i / 10).toFixed(5)}`), '&',
  ...Array.from({ length: 25 }, (_, i) => `${i * 2} ${Math.exp(-i / 4).toFixed(5)}`), '&'
].join('\n') + '\n';

// Two y columns in two blocks (gmx rms -split): s0 and s1, then s2 and s3.
const SPLIT = [
  '@    xaxis  label "Time (ps)"', '@    yaxis  label "RMSD (nm)"', '@TYPE xy',
  '@ s0 legend "Protein"', '@ s1 legend "Backbone"', '@ s2 legend "Protein, part 2"',
  ...Array.from({ length: 20 }, (_, i) => `${i * 10} ${(0.1 + 0.01 * Math.sin(i)).toFixed(4)} ${(0.2 + 0.001 * i).toFixed(4)}`), '&',
  ...Array.from({ length: 30 }, (_, i) => `${i * 10} ${(0.3 + 0.01 * Math.cos(i)).toFixed(4)} ${(0.4 + 0.001 * i).toFixed(4)}`)
].join('\n') + '\n';

// A CSV in two sets: a header row, a note and a short row among the numbers,
// and a comma at the end of every row.
const MESSY_SETS = 'time,a,b,\n' + Array.from({ length: 12 }, (_, i) => (i === 5 ? 'note: restart,' : `${i},${(i * 0.5).toFixed(1)},${i * i},`)).join('\n') +
  '\n&\n' + Array.from({ length: 9 }, (_, i) => (i === 2 ? `${i},7,` : `${i},${(3 + i * 0.25).toFixed(2)},${50 - i},`)).join('\n') + '\n';

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

  // What Grace 5.1.25 draws (gracebat, PostScript output) for a title of
  // "\#{41}\#{e4} [\#{110000}] [\#{4}] [\#{zz}] [\#{4142}]": the bytes A, ä,
  // [0x11 0x00 0x00] (no glyphs), [], [0x00] and [AB]. The argument is pairs
  // of hexadecimal digits, a character of the font's 8-bit table each, not
  // one Unicode number.
  test('\\#{...} gives characters by pairs of hexadecimal digits, as Grace draws them', () => {
    expect(graceToPlain('\\#{41}\\#{e4}')).toBe('Aä');
    expect(graceToPlain('[\\#{4142}]')).toBe('[AB]');
    expect(graceToPlain('d (\\#{c5})')).toBe('d (Å)');
    expect(graceToPlain('[\\#{4}] [\\#{zz}] [\\#{}]')).toBe('[] [] []');
    expect(graceToTex('nm\\S\\#{b2}\\N')).toBe('nm$^{²}$');
    // In the Symbol font the character is a Greek letter, as one typed is.
    expect(graceToPlain('\\xa\\#{62}\\f{}')).toBe('αβ');
  });

  test('a code above 10FFFF, or any other, never throws', () => {
    expect(graceToPlain('[\\#{110000}]')).toBe('[]');
    expect(graceToTex('A\\#{110000}\\S2\\N')).toBe('A$^{2}$');
    expect(graceToPlain('\\#{FFFFFFFF}')).toBe('ÿÿÿÿ');
    for (const s of ['\\#{-1}', '\\#{D800}', '\\#{7FFFFFFFFFFFFFFF}', '\\#{1e99}', '\\#', '\\#{', '\\', '\\f', '\\x\\#{']) {
      expect(() => graceToTex(s)).not.toThrow();
      expect(() => graceToPlain(s)).not.toThrow();
    }
  });

  // Grace prints "X2 \#{41 open" as "X2 #{41 open" and "Y2 \f{Symbol open"
  // as "Y2 f{Symbol open": without its closing brace the escape is its letter.
  test('an escape whose brace never closes keeps the text after it', () => {
    expect(graceToPlain('X2 \\#{41 open')).toBe('X2 #{41 open');
    expect(graceToPlain('Y2 \\f{Symbol open')).toBe('Y2 f{Symbol open');
    expect(graceToTex('\\R{red nm\\S2\\N')).toBe('R{red nm$^{2}$');
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

describe('xvgFigure, files of several data sets', () => {
  const two = parseXvg(TWO_SETS, { fallbackTitle: 'tcaf.xvg' });
  const split = parseXvg(SPLIT);

  test('offers a series for each column of each set, numbered through the file', () => {
    expect(xvgSeries(two)).toEqual([
      { index: 1, block: 0, column: 1, rows: 40, id: 'col1', name: 'k = 1.0' },
      { index: 3, block: 1, column: 1, rows: 25, id: 'set2_col1', name: 'k = 2.0' }
    ]);
    expect(xvgSeries(split).map((q) => [q.index, q.id, q.name])).toEqual([
      [1, 'col1', 'Protein'], [2, 'col2', 'Backbone'], [4, 'set2_col1', 'Protein, part 2'], [5, 'set2_col2', 'Dataset 4']
    ]);
    // With another column along x, the first is a series of every set.
    expect(xvgSeries(split, 1).map((q) => q.index)).toEqual([0, 2, 3, 5]);
    // A file in one block: its columns, numbered as before.
    expect(xvgSeries(parseXvg(SAMPLE)).map((q) => [q.index, q.id])).toEqual([[1, 'col1'], [2, 'col2']]);
  });

  test('a name that sets share says which set each series is', () => {
    const p = parseXvg('@ xaxis label "t"\n@ s0 legend "A"\n@ s1 legend "A"\n0 1\n1 2\n&\n0 3\n1 4\n');
    expect(xvgSeries(p).map((q) => q.name)).toEqual(['A (set 1)', 'A (set 2)']);
    expect(xvgFigure(p, { series: [1, 3] }).panels[0].series.map((q) => q.label)).toEqual(['A (set 1)', 'A (set 2)']);
    // With another column along x, the first column is a series of each set.
    expect(xvgSeries(p, 1).map((q) => q.name)).toEqual(['t (set 1)', 't (set 2)']);
    expect(xvgSeries(two).map((q) => q.name)).toEqual(['k = 1.0', 'k = 2.0']);
  });

  test('draws each set against its own x column, under its own legend', () => {
    const fig = xvgFigure(two, { series: [1, 3] });
    const [a, b] = fig.panels[0].series;
    expect([a.id, a.label, b.id, b.label]).toEqual(['col1', 'k = 1.0', 'set2_col1', 'k = 2.0']);
    expect(a.x.values).toEqual(extractColumn(two.matrix.slice(0, 40), 0));
    expect(a.y.values).toEqual(extractColumn(two.matrix.slice(0, 40), 1));
    expect(b.x.values).toEqual(extractColumn(two.matrix.slice(40), 0));
    expect(b.y.values).toEqual(extractColumn(two.matrix.slice(40), 1));
    expect(b.x.values.slice(0, 3)).toEqual([0, 2, 4]);
    expect([a.x.column, a.y.column, b.x.column, b.y.column]).toEqual([0, 1, 2, 3]);
    expect(fig.xLabel).toBe('Time (ps)');
    expect(fig.panels[0].yLabel).toBe('C(t)');
  });

  test('gives every series a colour of its own, kept whichever others are drawn', () => {
    const cycle = colorCycle();
    expect(xvgColors(3, 0, '#ffffff', 2)).toEqual({ 1: cycle[0], 2: cycle[1], 4: cycle[2], 5: cycle[3] });
    const all = xvgFigure(split, { series: [1, 2, 4, 5] }).panels[0].series.map((q) => q.color);
    expect(all).toEqual(cycle.slice(0, 4));
    expect(xvgFigure(split, { series: [5] }).panels[0].series[0].color).toBe(cycle[3]);
  });

  test('a series of another set goes in the lower panel like any other', () => {
    const fig = xvgFigure(split, { series: [1, 4, 5], lower: [5] });
    expect(fig.panels.map((p) => p.series.map((q) => q.id))).toEqual([['col1', 'set2_col1'], ['set2_col2']]);
    expect(fig.panels[1].yLabel).toBe('Dataset 4');
  });

  test('takes the running mean over each set by itself, no wider than the shortest drawn', () => {
    expect(xvgWindow(two, [1, 3], 10)).toBe(10);
    expect(xvgWindow(two, [1, 3], 30)).toBe(25);
    expect(xvgWindow(two, [1], 30)).toBe(30);
    expect(xvgWindow(two, [], 30)).toBe(0);
    const fig = xvgFigure(two, { series: [1, 3], average: 30 });
    expect(fig.legend.title).toBe('Running mean, 25 points');
    const mean = fig.panels[0].series[3];
    expect(mean.id).toBe('set2_col1_mean');
    expect(mean.y.values).toEqual(runningMean(extractColumn(two.matrix.slice(40), 1), 25));
    expect(mean.x.values).toEqual(runningMean(extractColumn(two.matrix.slice(40), 0), 25));
    expect(fig.panels[0].series[1].y.values).toHaveLength(40 - 24);
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

  test('reads a file of several data sets set by set', () => {
    const p = parseXvg(TWO_SETS);
    const code = xvgFigureScript(xvgFigure(p, { series: [1, 3] }), p, { filename: 'tcaf.xvg' });
    expect(code).toContain('def read_sets(path):');
    expect(code).toContain("sets = read_sets('tcaf.xvg')");
    expect(code).toMatch(/^Time_ps = sets\[0\]\[:, 0\] {2}# set 1, column 0: Time \(ps\)$/m);
    expect(code).toMatch(/^k_1_0 = sets\[0\]\[:, 1\] {2}# set 1, column 1: k = 1\.0$/m);
    expect(code).toMatch(/^Time_ps_2 = sets\[1\]\[:, 0\]/m);
    expect(code).toMatch(/^k_2_0 = sets\[1\]\[:, 1\]/m);
    expect(code).toContain('ax.plot(Time_ps_2, k_2_0,');
    expect(code).not.toContain('data = np.loadtxt');
    // Rows the page rejected are left out of every set.
    const messy = xvgReadLines(parseXvg(MESSY_SETS), 'm.csv').join('\n');
    expect(messy).toContain('def is_record(line):');
    expect(messy).toContain('elif is_record(line):');
    expect(messy).toContain("delimiter=','");
  });

  test('holds the numbers of each set when asked', () => {
    const p = parseXvg('@ s0 legend "A"\n@ s1 legend "B"\n0 1\n1 2\n&\n5 3\n6 4\n7 5\n');
    const code = xvgFigureScript(xvgFigure(p, { series: [1, 3] }), p, { source: 'embed' });
    expect(code).toContain('# Set 2, column 1: B\nB = np.array([3, 4, 5], dtype=float)');
    expect(code).toContain('# Set 2, column 0: X\nX_2 = np.array([5, 6, 7], dtype=float)');
    expect(code).toContain('A = np.array([1, 2], dtype=float)');
    expect(code).not.toContain('read_sets');
  });
});

describe('the numbers a script would hold', () => {
  const parsed = parseXvg(SAMPLE);
  const rows = parsed.rowCount;

  test('are every row of each column drawn, the x column among them', () => {
    expect(xvgEmbeddedCount(xvgFigure(parsed, { series: [1] }), parsed)).toBe(2 * rows);
    expect(xvgEmbeddedCount(xvgFigure(parsed, { series: [1, 2], lower: [2] }), parsed)).toBe(3 * rows);
  });

  test('count the columns behind a running mean when the data are not drawn', () => {
    const fig = xvgFigure(parsed, { series: [1, 2], average: 10, raw: false });
    expect(xvgEmbeddedCount(fig, parsed)).toBe(3 * rows);
    expect(xvgEmbeddedCount(xvgFigure(parsed, { series: [1, 2], average: 10 }), parsed)).toBe(3 * rows);
    // It is the count of what the script writes out.
    const code = xvgFigureScript(fig, parsed, { source: 'embed' });
    const held = [...code.matchAll(/= np\.array\(\[([^\]]*)\]/g)].reduce((n, m) => n + m[1].split(',').filter((v) => v.trim() !== '').length, 0);
    expect(held).toBe(3 * rows);
  });

  test('count each set\'s own rows, and survive the style panel\'s copy of the figure', () => {
    const two = parseXvg(TWO_SETS);
    expect(xvgEmbeddedCount(xvgFigure(two, { series: [1, 3] }), two)).toBe(2 * 40 + 2 * 25);
    expect(xvgEmbeddedCount(xvgFigure(two, { series: [3], average: 5, raw: false }), two)).toBe(2 * 25);
    expect(xvgEmbeddedCount(normaliseFigure(xvgFigure(two, { series: [1, 3] })), two)).toBe(130);
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

  withPython('a file of several data sets: each set a line of its own, read from the file or held', async () => {
    const two = parseXvg(TWO_SETS);
    const tFig = xvgFigure(two, { series: [1, 3], filename: 'tcaf.xvg' });
    const split = parseXvg(SPLIT);
    const sFig = xvgFigure(split, { series: [1, 2, 4, 5], lower: [2, 5], average: 4, filename: 'split.xvg' });
    const messy = parseXvg(MESSY_SETS);
    const mFig = xvgFigure(messy, { series: [1, 4], filename: 'sets.csv' });
    const [t, e, s, m] = await Promise.all([
      run(xvgFigureScript(tFig, two, { filename: 'tcaf.xvg' }), { 'tcaf.xvg': TWO_SETS }),
      run(xvgFigureScript(tFig, two, { source: 'embed', filename: 'tcaf.xvg' })),
      run(xvgFigureScript(sFig, split, { filename: 'split.xvg' }), { 'split.xvg': SPLIT }),
      run(xvgFigureScript(mFig, messy, { filename: 'sets.csv' }), { 'sets.csv': MESSY_SETS })
    ]);
    for (const r of [t, e, s, m]) expect([r.code, r.stderr]).toEqual([0, '']);
    expectSameLimits(tFig, t.fig, 'two sets');
    expectSameLimits(tFig, e.fig, 'two sets, held');
    expectSameLimits(sFig, s.fig, 'split');
    expectSameLimits(mFig, m.fig, 'messy sets');
    for (const r of [t, e]) {
      expect(r.fig.panels[0].legend).toEqual(['k = 1.0', 'k = 2.0']);
      expect(r.fig.panels[0].lineLengths).toEqual([40, 25]);
      expect(r.fig.panels[0].lineData).toEqual([extractColumn(two.matrix, 1).slice(0, 3), extractColumn(two.matrix.slice(40), 1).slice(0, 3)]);
    }
    // s0 and s1 are the first block's columns, s2 the second block's first.
    expect(s.fig.panels[0].legend).toEqual(['Protein', 'Protein, part 2']);
    expect(s.fig.panels[1].legend).toEqual(['Backbone', 'Dataset 4']);
    expect(s.fig.panels[0].lineLengths).toEqual([20, 17, 30, 27]);
    const mean = runningMean(extractColumn(split.matrix.slice(20), 2), 4);
    s.fig.panels[1].lineData[3].forEach((v, i) => expect(close(v, mean[i])).toBe(true));
    // The note and the short row are left out of the set they are in.
    expect(m.fig.panels[0].legend).toEqual(['a (set 1)', 'a (set 2)']);
    expect(m.fig.panels[0].lineLengths).toEqual([11, 8]);
  }, 60000);
});
