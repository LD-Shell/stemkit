/**
 * The Plot Builder's core (src/core/plot-builder.js): files are read as the
 * script it writes reads them (Python's csv module and float()), and the
 * figure it describes is drawn by matplotlib as the preview draws it. When
 * Python with numpy and matplotlib is installed the scripts are run on sample
 * CSV files, reading them by column name and with the numbers embedded, and
 * matplotlib's axis limits and data are compared with the preview's.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pyFloat, parseCsv, sniffDelimiter, readTable, columnName, slug, sourceId, exampleCsv, EXAMPLE_LABELS,
  builderFigure, builderLook, pythonFiles, seriesNote, houseStyle,
  CHART_KINDS, DRAW_MODES, gridFromXyz, histogram2d, boxGroups, suggestColumns, seriesColumns, axisChoices,
  parseEdges, replicateGroups, histogramOptions, LEVELS, BIN_MODES, EXAMPLES, builderExample, exampleState,
  builderLayout, builderPanels, MAX_GRID_ROWS, MAX_GRID_COLS, MAX_INSETS
} from '../src/core/plot-builder.js';
import { figureScript } from '../src/core/figure-python.js';
import { normaliseFigure, applyStyle, COLOR_CYCLE, isStack, panelLetters, panelEdges } from '../src/core/figure.js';
import { buildFigure } from '../js/figure-plot.js';

const PYTHON = (() => {
  try {
    return spawnSync('python3', ['-c', 'import numpy, matplotlib'], { encoding: 'utf8', timeout: 60000 }).status === 0;
  } catch {
    return false;
  }
})();
const withPython = PYTHON ? test : test.skip;

function python(code, input = '') {
  const r = spawnSync('python3', ['-c', code], { input, encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

const FLOATS = ['1', ' 2.5 ', '-3e2', '+.5', '5.', '1_000', '1__0', '_1', '1_', '1e1_0', 'inf', '-Infinity', 'NaN', '-nan', 'in',
  '', '  ', 'abc', '1,5', '0x10', '1e', 'e5', '.', '1.2.3', '١٢', ' 7 ', '1e400', '-0', '12abc', 'Inf5', '1 2'];

describe('pyFloat', () => {
  test('reads numbers as float() does', () => {
    expect(pyFloat('1')).toBe(1);
    expect(pyFloat(' 2.5 ')).toBe(2.5);
    expect(pyFloat('1_000')).toBe(1000);
    expect(pyFloat('-Infinity')).toBe(-Infinity);
    expect(pyFloat('1,5')).toBeNaN();
    expect(pyFloat('')).toBeNaN();
    expect(pyFloat(undefined)).toBeNaN();
    expect(pyFloat('0x10')).toBeNaN();
  });

  withPython('agrees with Python for every case', () => {
    const want = python(String.raw`
import json, sys
out = []
for t in json.load(sys.stdin):
    try:
        v = float(t)
        out.append('nan' if v != v else ('inf' if v == float('inf') else ('-inf' if v == -float('inf') else repr(v))))
    except ValueError:
        out.append('nan')
print(json.dumps(out))`, JSON.stringify(FLOATS));
    const got = FLOATS.map((t) => {
      const v = pyFloat(t);
      if (Number.isNaN(v)) return 'nan';
      if (v === Infinity) return 'inf';
      if (v === -Infinity) return '-inf';
      return v;
    });
    // Python's non-ASCII digits are the one known difference: '١٢' is 12.0 there.
    const i = FLOATS.indexOf('١٢');
    want[i] = 'nan';
    expect(got).toEqual(want.map((w) => (['nan', 'inf', '-inf'].includes(w) ? w : Number(w))));
  });
});

const CSVS = [
  'a,b,c\n1,2,3\n4,5,6\n',
  'a,b\r\n1,2\r\n\r\n3,4',
  'name,"quoted, with comma","say ""hi"""\nx,"line\nbreak",3\n',
  'a,b\n1,"2"x,3\n"unclosed,4\n',
  'x;y\n1,5;2\n\n\n3;4;extra\n5\n',
  'a\tb\n1\t2\n',
  'a,b\n,\n  ,\n1,\n',
  'a,b\n1,2\r3,4\r'
];

describe('parseCsv', () => {
  test('splits quoted fields, doubled quotes and line breaks in quotes', () => {
    expect(parseCsv('a,"b ""q"", c",d\n1,"x\ny"z,3')).toEqual([['a', 'b "q", c', 'd'], ['1', 'x\nyz', '3']]);
    expect(parseCsv('\na,b')).toEqual([[], ['a', 'b']]);
    expect(parseCsv('a,\n')).toEqual([['a', '']]);
  });

  withPython('gives the records csv.reader gives, blank lines aside', () => {
    const want = python(String.raw`
import csv, io, json, sys
out = []
for text, d in json.load(sys.stdin):
    out.append([r for r in csv.reader(io.StringIO(text, newline=''), delimiter=d) if r])
print(json.dumps(out))`, JSON.stringify(CSVS.map((t) => [t, sniffDelimiter(t)])));
    expect(CSVS.map((t) => parseCsv(t, sniffDelimiter(t)).filter((r) => r.length))).toEqual(want);
  });
});

describe('sniffDelimiter and readTable', () => {
  test('find the delimiter that splits the header and the rows alike', () => {
    expect(sniffDelimiter('a,b\n1,2')).toBe(',');
    expect(sniffDelimiter('a\tb, c\n1\t2')).toBe('\t');
    expect(sniffDelimiter('time;value\n1,5;2,3\n2,5;3,1')).toBe(';');
    expect(sniffDelimiter('a|b|c\n1|2|3')).toBe('|');
    expect(sniffDelimiter('one column\n1\n2')).toBe(',');
  });

  test('read headers, numbers and the columns the script can name', () => {
    const t = readTable('﻿ x , y ,x,label\n1,2,3,a\n2,,4,b\n3,oops,5,c\n');
    expect(t.ok).toBe(true);
    expect(t.headers).toEqual(['x', 'y', 'x', 'label']);
    expect(t.rows).toBe(3);
    expect(t.columns[1]).toEqual([2, NaN, NaN]);
    expect(t.numeric).toEqual([true, false, true, false]);
    expect(t.counts).toEqual([3, 1, 3, 0]);
    // Python's DictReader keeps the last of two columns named alike.
    expect(t.readable).toEqual([false, true, true, true]);
  });

  test('say what is wrong with a file they cannot read', () => {
    expect(readTable('').error).toMatch(/first line/);
    expect(readTable('\nx,y\n1,2').error).toMatch(/first line/);
    expect(readTable('just one\n1\n2').error).toMatch(/two columns/);
    expect(readTable('a,b\n').error).toMatch(/no rows/);
    expect(readTable('a,b\n1,�\n').notUtf8).toBe(true);
  });

  test('name columns, files and exports', () => {
    expect(columnName(['a', ''], 1)).toBe('Column 2');
    expect(slug('OD$_{600}$ growth: day 1')).toBe('od-growth-day-1');
    expect(slug('')).toBe('figure');
    const taken = new Set();
    expect(sourceId('My Data.csv', taken)).toBe('my_data');
    expect(sourceId('my-data.tsv', taken)).toBe('my_data_2');
    expect(sourceId('2024.csv', taken)).toBe('data_2024');
  });
});

/* ------------------------------------------------------------------ *
 * The figure
 * ------------------------------------------------------------------ */

const fileOf = (name, text, extra = {}) => ({ id: name, name, source: sourceId(name, new Set()), table: readTable(text), ...extra });

describe('builderFigure', () => {
  const ex = { id: 'example', name: 'growth_example.csv', example: true, labels: EXAMPLE_LABELS, table: readTable(exampleCsv()) };

  test('is null without series, and one unlabelled series needs no legend', () => {
    expect(builderFigure({ files: [ex], series: [] })).toBeNull();
    const f = builderFigure({ files: [ex], series: [{ id: 's1', fileId: 'example', x: 0, y: 1, draw: 'line' }] });
    expect(f.panels).toHaveLength(1);
    expect(f.panels[0].series[0]).toMatchObject({ id: 's1', kind: 'line', marker: 'none', legend: false, label: 'control_OD600' });
    expect(f.xLabel).toBe('Time (h)');
    expect(f.panels[0].yLabel).toBe('OD$_{600}$');
    expect(f).toMatchObject({ width: 3.5, height: 2.6, fontSize: 9, export: { tight: false, filename: 'figure' } });
  });

  test('draws lines, points, error bars, bands and panels', () => {
    const f = builderFigure({ files: [ex], series: [
      { id: 'a', fileId: 'example', x: 0, y: 1, draw: 'both', yerr: 2, label: 'Control' },
      { id: 'b', fileId: 'example', x: 0, y: 3, draw: 'points' },
      { id: 'c', fileId: 'example', x: 0, y: 1, y2: 3, draw: 'band', panel: 2 },
      { id: 'd', fileId: 'example', x: 0, y: 4, draw: 'line', xerr: 2 }
    ] }, { title: 'Growth' });
    expect(f.export.filename).toBe('growth');
    expect(f.panels.map((p) => p.series.map((q) => q.kind))).toEqual([['errorbar', 'scatter', 'errorbar'], ['band']]);
    const [a, b, d] = f.panels[0].series;
    expect(a).toMatchObject({ label: 'Control', marker: 'o', lineStyle: 'solid', legend: true });
    expect(b.marker).toBe('s');
    expect(d).toMatchObject({ marker: 'none', lineStyle: 'solid' });
    expect(d.xerr.name).toBe('control_sd');
    expect(f.panels[1].series[0].label).toBe('control_OD600 to treated_OD600');
    // The example is never read from a file.
    expect(a.x.source).toBeUndefined();
  });

  test('names the file and column of every field the script can read', () => {
    const f1 = fileOf('run.csv', 'x,y,x\n1,2,3\n');
    const f = builderFigure({ files: [f1], series: [{ id: 's', fileId: 'run.csv', x: 0, y: 1, draw: 'line', yerr: 2 }] });
    const q = f.panels[0].series[0];
    expect(q.y).toMatchObject({ source: 'run', column: 'y', name: 'y' });
    expect(q.x.source).toBeUndefined();   // a repeated name: embedded
    expect(q.yerr).toMatchObject({ source: 'run', column: 'x' });
    expect(pythonFiles({ files: [f1], series: [{ fileId: 'run.csv' }] })).toEqual({ run: { file: 'run.csv', format: 'csv' } });
    expect(pythonFiles({ files: [fileOf('a.tsv', 'p\tq\n1\t2\n')], series: [{ fileId: 'a.tsv' }] })).toEqual({ a: { file: 'a.tsv', format: 'csv', delimiter: '\t' } });
  });

  test('notes what a series leaves out', () => {
    const f = fileOf('gaps.csv', 'x,y,w\n1,1,a\n2,,b\n3,3,c\n4,-1,d\n');
    expect(seriesNote(f, { x: 0, y: 1, draw: 'line' })).toBe('1 of 4 rows have no number in x or y; the line breaks there.');
    expect(seriesNote(f, { x: 0, y: 1, draw: 'points' }, { yLog: true })).toMatch(/left out\. 1 point is at or below zero/);
    expect(seriesNote(f, { x: 0, y: 2, draw: 'line' })).toMatch(/nothing is drawn/);
    expect(seriesNote(f, { x: 0, y: 0, draw: 'line' })).toBe('X and Y are the same column.');
    const big = fileOf('big.csv', 'x,y\n' + Array.from({ length: 12001 }, (_, i) => `${i - 1000},${i % 7}`).join('\n'));
    expect(seriesNote(big, { x: 0, y: 1, draw: 'points' }, { xLog: true })).toBe('1,001 points are at or below zero and cannot be shown on a log axis.');
  });

  test('keeps the house style, not this figure\'s', () => {
    const kept = houseStyle({ width: 7, title: 'T', xLabel: 'x', xLim: [0, 1], xScale: 'log', fontSize: 8,
      legend: { position: 'upper left', title: 'Kind' }, export: { filename: 'mine', format: 'png' },
      xTicks: { direction: 'out', mode: 'list', values: [1, 2] }, panels: [{ yLabel: 'y', yTicks: { minor: true, values: [3] } }],
      series: { s1: { color: '#000000' } }, grid: { show: true, axis: 'y' } });
    expect(kept).toEqual({ width: 7, fontSize: 8, grid: { show: true, axis: 'y' }, legend: { position: 'upper left' }, export: { format: 'png' },
      xTicks: { direction: 'out' }, panels: [{ yTicks: { minor: true } }] });
    expect(builderLook().xTicks).toEqual({ direction: 'in', mirror: true });
  });
});

/* ------------------------------------------------------------------ *
 * The script, run
 * ------------------------------------------------------------------ */

const INSPECT = String.raw`

# --- test only: report what was drawn ---
import json as _json
fig.canvas.draw()


def _data(l):
    return [[None if v != v else float(v) for v in l.get_xdata()], [None if v != v else float(v) for v in l.get_ydata()]]


def _kind(c):
    # fill_between gives a FillBetweenPolyCollection from matplotlib 3.10 on: a PolyCollection.
    return 'PolyCollection' if type(c).__name__ == 'FillBetweenPolyCollection' else type(c).__name__


print('@@FIG@@' + _json.dumps({
    'panels': [{
        'xlim': [float(v) for v in a.get_xlim()], 'ylim': [float(v) for v in a.get_ylim()],
        'yscale': a.get_yscale(), 'lines': [_data(l) for l in a.get_lines()],
        'collections': [_kind(c) for c in a.collections],
        'legend': [t.get_text() for t in a.get_legend().get_texts()] if a.get_legend() else None,
        'xlabel': a.get_xlabel(), 'ylabel': a.get_ylabel(),
    } for a in fig.axes],
    'insets': [{'xlim': [float(v) for v in c.get_xlim()], 'ylim': [float(v) for v in c.get_ylim()], 'lines': len(c.get_lines())}
               for a in fig.axes for c in a.child_axes],
    'size': [float(v) for v in fig.get_size_inches()],
}))
`;

function run(script, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stemkit-builder-'));
  writeFileSync(join(dir, 'figure.py'), script + INSPECT);
  Object.entries(files).forEach(([name, text]) => writeFileSync(join(dir, name), text));
  return new Promise((resolve) => {
    const child = spawn('python3', ['figure.py'], { cwd: dir, env: { ...process.env, MPLBACKEND: 'Agg' } });
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

// A run with a gap and a text cell; a second file with semicolons, quoted headers with spaces,
// a repeated column name, blank lines, CRLF endings and values in scientific notation.
const RUN_CSV = 'time (s),signal,signal_err,lower,upper\n'
  + Array.from({ length: 40 }, (_, i) => {
    const t = i * 0.25; const y = 2 + Math.sin(t) * Math.exp(-t / 6);
    if (i === 13) return `${t},,0.1,${y - 0.3},${y + 0.3}`;
    if (i === 21) return `${t},n/a,0.1,${y - 0.3},${y + 0.3}`;
    return `${t},${y.toFixed(4)},${(0.05 + 0.01 * (i % 5)).toFixed(3)},${(y - 0.3).toFixed(4)},${(y + 0.3).toFixed(4)}`;
  }).join('\n') + '\n';
const DOSE_CSV = '" dose (mM) ";"rate";rate;"note"\r\n'
  + [[0.01, 3, 1.2], [0.03, 8, 2.5], [0.1, 20, 4], [], [0.3, 45, 9.5], [1, 70, 1.1e1], [3, 82, 12], [10, 88, 1.25e1]]
    .map((r) => (r.length ? `${r[0]};${r[1]};${r[2]};"a;b"` : '')).join('\r\n') + '\r\n';

const FILES = [fileOf('run.csv', RUN_CSV), fileOf('dose response.csv', DOSE_CSV)];
const STATE = {
  files: FILES,
  series: [
    { id: 's1', fileId: 'run.csv', x: 0, y: 1, draw: 'line' },
    { id: 's2', fileId: 'run.csv', x: 0, y: 1, draw: 'points', yerr: 2 },
    { id: 's3', fileId: 'run.csv', x: 0, y: 3, y2: 4, draw: 'band' },
    { id: 's4', fileId: 'dose response.csv', x: 0, y: 1, draw: 'both', yerr: 2, panel: 1 },
    { id: 's5', fileId: 'dose response.csv', x: 0, y: 2, draw: 'points', panel: 1 }
  ]
};
// A log y with a limit of its own in the second panel; the person's colour and name for a series.
const LOG_STYLE = { panels: [{}, { yScale: 'log', yLim: [null, 200] }], series: { s2: { color: '#000000', label: 'With errors' } }, title: 'Two runs' };
// Log x, on one panel and shared by two: the run's first time, 0, is left off as matplotlib
// leaves it, and the smallest positive x of all the panels sets the lower limit (matplotlib
// 3.8's rule; the script gives 3.6 and 3.7 the same).
const LOGX_STATE = { files: FILES, series: STATE.series.slice(0, 3) };
const FIGS = {
  linear: applyStyle(builderFigure(STATE, { title: 'Two runs' }), { title: 'Two runs' }),
  log: applyStyle(builderFigure(STATE, { title: 'Two runs' }), LOG_STYLE),
  logx: applyStyle(builderFigure(LOGX_STATE), { xScale: 'log', panels: [{ yScale: 'log' }] }),
  logx2: applyStyle(builderFigure(STATE), { xScale: 'log', panels: [{}, { yScale: 'log' }] }),
  example: builderFigure({ files: [{ id: 'example', name: 'growth_example.csv', example: true, labels: EXAMPLE_LABELS, table: readTable(exampleCsv()) }],
    series: [{ id: 'a', fileId: 'example', x: 0, y: 1, yerr: 2, draw: 'both', label: 'Control' }, { id: 'b', fileId: 'example', x: 0, y: 3, yerr: 4, draw: 'both', label: 'Treated' }] })
};
const CSV_FILES = { 'run.csv': RUN_CSV, 'dose response.csv': DOSE_CSV };

const runs = {};
beforeAll(async () => {
  if (!PYTHON) return;
  const jobs = [];
  for (const [name, fig] of Object.entries(FIGS)) {
    for (const data of ['files', 'embed']) {
      const script = figureScript(fig, { data, files: pythonFiles(name === 'example' ? { files: [], series: [] } : STATE) });
      jobs.push(run(script, data === 'files' ? CSV_FILES : {}).then((r) => { runs[`${name}/${data}`] = { ...r, script }; }));
    }
  }
  await Promise.all(jobs);
}, 180000);
afterAll(() => Object.values(runs).forEach((r) => rmSync(r.dir, { recursive: true, force: true })));

describe('the script the builder writes', () => {
  test('reads each CSV by its column names, and embeds only what it cannot read', () => {
    const code = figureScript(FIGS.linear, { data: 'files', files: pythonFiles(STATE) });
    expect(code).toContain("run_columns = read_csv('run.csv')");
    expect(code).toContain("dose_response_columns = read_csv('dose response.csv', delimiter=';')");
    expect(code).toContain("signal = run_columns['signal']");
    expect(code).toContain("dose_response_columns['dose (mM)']");
    // The first of the two 'rate' columns cannot be read by name, so its numbers are in the script.
    expect(code).toMatch(/^rate = np\.array/m);
    expect(code).toContain("dose_response_columns['rate']");
    const embedded = figureScript(FIGS.linear, { data: 'embed', files: pythonFiles(STATE) });
    expect(embedded).not.toContain('read_csv');
    expect(embedded).toContain('np.nan');
  });

  withPython('runs without errors or warnings, reading the files or with the data in it', () => {
    for (const [name, r] of Object.entries(runs)) {
      expect([name, r.code, r.stderr]).toEqual([name, 0, '']);
      const { filename, format } = normaliseFigure(FIGS[name.split('/')[0]]).export;
      expect(existsSync(join(r.dir, `${filename}.${format}`))).toBe(true);
    }
  });

  withPython('matplotlib picks the axis limits the preview shows', () => {
    for (const [name, r] of Object.entries(runs)) {
      const want = previewRanges(FIGS[name.split('/')[0]]);
      expect(r.fig.panels).toHaveLength(want.length);
      r.fig.panels.forEach((p, i) => {
        const [x, y] = want[i];
        const ok = [...p.xlim.map((v, k) => close(v, x[k])), ...p.ylim.map((v, k) => close(v, y[k]))].every(Boolean);
        if (!ok) throw new Error(`${name} panel ${i + 1}: matplotlib x ${p.xlim} y ${p.ylim}, preview x ${x} y ${y}`);
      });
    }
  });

  withPython('draws the numbers the page drew, gaps and all, at the size set', () => {
    for (const mode of ['files', 'embed']) {
      const f = runs[`linear/${mode}`].fig;
      expect(f.size).toEqual([3.5, 2.6]);
      const [top, bottom] = f.panels;
      const line = top.lines[0];
      const table = FILES[0].table;
      expect(line[0]).toEqual(table.columns[0]);
      expect(line[1]).toEqual(table.columns[1].map((v) => (Number.isFinite(v) ? v : null)));
      expect(line[1][13]).toBeNull();
      expect(line[1][21]).toBeNull();
      expect(top.collections).toContain('PolyCollection');   // the band
      expect(top.legend).toEqual(['signal', 'signal', 'lower to upper']);
      expect(bottom.lines[0][0]).toEqual([0.01, 0.03, 0.1, 0.3, 1, 3, 10]);
      expect(bottom.legend).toEqual(['rate', 'rate']);
      expect(top.xlabel).toBe('');
      expect(bottom.xlabel).toBe('time (s)');
      expect(top.ylabel).toBe('signal');
      expect(bottom.ylabel).toBe('rate');
    }
    const log = runs['log/files'].fig;
    expect(log.panels[1].yscale).toBe('log');
    expect(log.panels[0].legend).toEqual(['signal', 'With errors', 'lower to upper']);
  });

  withPython('the example runs on its own, with its labels', () => {
    for (const mode of ['files', 'embed']) {
      const r = runs[`example/${mode}`];
      expect(r.script).not.toContain('read_csv');
      expect(r.fig.panels[0].xlabel).toBe('Time (h)');
      expect(r.fig.panels[0].ylabel).toBe('OD$_{600}$');
      expect(r.fig.panels[0].legend).toEqual(['Control', 'Treated']);
    }
  });
});


/* ------------------------------------------------------------------ *
 * Charts made from columns
 * ------------------------------------------------------------------ */

describe('charts made from columns', () => {
  const rows = ['group,dose,response,err,x,y,z'];
  for (let i = 0; i < 12; i++) {
    const g = ['control', 'low', 'high'][i % 3];
    rows.push(`${g},${i % 3},${(2 + (i % 3) * 1.5 + Math.sin(i * 1.7)).toFixed(3)},${(0.2 + (i % 4) * 0.1).toFixed(2)},${i % 4},${Math.floor(i / 4)},${(i * 0.5).toFixed(1)}`);
  }
  const trial = fileOf('trial.csv', rows.join('\n'));
  const col = (n) => trial.table.headers.indexOf(n);
  const fig = (series, files = [trial]) => builderFigure({
    files, series: series.map((s, i) => ({ id: `s${i + 1}`, fileId: files[0].id, x: 0, y: 1, draw: 'line', panel: 0, ...s }))
  });

  test('the table keeps the text of every cell, trimmed', () => {
    expect(trial.table.texts[0].slice(0, 3)).toEqual(['control', 'low', 'high']);
    expect(trial.table.texts[2][0]).toBe('2.000');
    const t = readTable('a, b\n 1 , x \n2,\n');
    expect(t.texts).toEqual([['1', '2'], ['x', '']]);
  });

  test('the chart kinds and the step mode are listed', () => {
    expect(CHART_KINDS).toEqual(['curve', 'bar', 'bars-mean', 'hist', 'box', 'violin', 'heatmap', 'contour', 'hist2d']);
    expect(DRAW_MODES).toEqual(['line', 'points', 'both', 'step', 'band']);
  });

  test('step draws the line as steps, with no markers and no error bars', () => {
    const f = fig([{ draw: 'step', x: col('x'), y: col('z'), yerr: col('err') }]);
    const q = f.panels[0].series[0];
    expect(q).toMatchObject({ kind: 'line', marker: 'none', step: 'mid' });
    expect(q.yerr).toBeUndefined();
    expect(normaliseFigure(f).panels[0].series[0].step).toBe('mid');
  });

  test('bars on text names sit at 0, 1, 2 … under those names, one bar per row', () => {
    const f = fig([{ chart: 'bar', x: col('group'), y: col('response'), yerr: col('err') }]);
    const q = f.panels[0].series[0];
    expect(q.kind).toBe('bar');
    expect(q.x.values).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(f.xCategories.slice(0, 4)).toEqual(['control', 'low', 'high', 'control']);
    expect(q.y).toMatchObject({ name: 'response', values: trial.table.columns[col('response')] });
    expect(q.yerr.values).toEqual(trial.table.columns[col('err')]);
    expect(f.xLabel).toBe('group');
    expect(f.panels[0].yLabel).toBe('response');
    const n = normaliseFigure(f);
    expect(n.xCategories).toHaveLength(12);
    expect(n.panels[0].series[0].yerr[0]).toHaveLength(12);
  });

  test('bars on numbers keep the numbers and are four fifths of the closest gap wide', () => {
    const t = fileOf('d.csv', 'x,y\n0,1\n0.5,2\n1.5,3\n');
    const q = fig([{ chart: 'bar', x: 0, y: 1 }], [t]).panels[0].series[0];
    expect(q.width).toBeCloseTo(0.4, 12);
    expect(q.x.name).toBe('x');
    expect(fig([{ chart: 'bar', x: 0, y: 1 }], [t]).xCategories).toBeUndefined();
    // However far apart: bars 10 apart are 8 wide, bars 0.01 apart 0.008.
    const sparse = fileOf('e.csv', 'x,y\n0,1\n10,2\n');
    expect(fig([{ chart: 'bar', x: 0, y: 1 }], [sparse]).panels[0].series[0].width).toBe(8);
    expect(normaliseFigure(fig([{ chart: 'bar', x: 0, y: 1 }], [sparse])).panels[0].series[0].barWidth).toBe(8);
    const dense = fileOf('f.csv', 'x,y\n0.1,1\n0.11,2\n0.13,3\n');
    expect(fig([{ chart: 'bar', x: 0, y: 1 }], [dense]).panels[0].series[0].width).toBeCloseTo(0.008, 12);
    expect(fig([{ chart: 'bar', x: 0, y: 1 }], [fileOf('g.csv', 'x,y\n3,1\n')]).panels[0].series[0].width).toBe(0.8);
  });

  test('bars leave out rows with no number, with the names of the rows that stay', () => {
    const t = fileOf('m.csv', 'name,v\na,1\nb,\nc,3\n');
    const f = fig([{ chart: 'bar', x: 0, y: 1 }], [t]);
    expect(f.xCategories).toEqual(['a', 'c']);
    expect(f.panels[0].series[0].y.values).toEqual([1, 3]);
    expect(f.panels[0].series[0].x.values).toEqual([0, 1]);
  });

  test('a histogram counts the column, in the bins and units set', () => {
    const f = fig([{ chart: 'hist', y: col('response'), bins: 5 }, { chart: 'hist', y: col('z'), bins: 4, density: true }]);
    const [a, b] = f.panels[0].series;
    expect(a).toMatchObject({ kind: 'histogram', bins: 5, density: false });
    expect(b).toMatchObject({ kind: 'histogram', bins: 4, density: true });
    const n = normaliseFigure(f).panels[0].series[0];
    expect(n.counts).toHaveLength(5);
    expect(n.counts.reduce((p, c) => p + c, 0)).toBe(12);
    expect(f.panels[0].yLabel).toBe('Count');
    expect(fig([{ chart: 'hist', y: col('z'), density: true }]).panels[0].yLabel).toBe('Density');
    expect(fig([{ chart: 'hist', y: col('z'), bins: 99999 }]).panels[0].series[0].bins).toBe(1000);
  });

  test('box plots group the values by the text of a column, or take the column whole', () => {
    expect(boxGroups(trial.table, col('response'), col('group')).map((g) => [g.label, g.values.length])).toEqual([['control', 4], ['low', 4], ['high', 4]]);
    // A column of numbers groups in number order.
    expect(boxGroups(trial.table, col('response'), col('dose')).map((g) => g.label)).toEqual(['0', '1', '2']);
    expect(boxGroups(trial.table, col('response'), null)).toEqual([{ label: 'response', values: trial.table.columns[col('response')] }]);
    const f = fig([{ chart: 'box', y: col('response'), groupBy: col('group') }]);
    const q = f.panels[0].series[0];
    expect(q.groups.map((g) => g.position)).toEqual([0, 1, 2]);
    expect(f.xCategories).toEqual(['control', 'low', 'high']);
    expect(f.xLabel).toBe('group');
    expect(normaliseFigure(f).panels[0].series[0].groups[1].stats.n).toBe(4);
    // Two columns, no grouping: a box each, side by side, named for the columns; the script reads them.
    const two = fig([{ chart: 'box', y: col('response') }, { chart: 'box', y: col('z') }]);
    expect(two.xCategories).toEqual(['response', 'z']);
    expect(two.panels[0].series.map((q) => q.groups[0].position)).toEqual([0, 1]);
    expect(two.panels[0].series[0].groups[0].values).toMatchObject({ name: 'response', source: 'trial', column: 'response' });
  });

  test('a heatmap and a contour lay x, y and z on the grid of their values', () => {
    const g = gridFromXyz([1, 2, 1, 2, 3], [1, 1, 2, 2, 2], [5, 6, 7, 8, 9]);
    expect(g).toMatchObject({ x: [1, 2, 3], y: [1, 2], cells: 6, filled: 5, repeated: 0, rows: 5 });
    expect(g.z).toEqual([[5, 6, NaN], [7, 8, 9]]);
    expect(gridFromXyz([1, 1], [1, 1], [1, 2])).toMatchObject({ x: [1], y: [1], z: [[2]], repeated: 1, filled: 1 });
    expect(gridFromXyz([1, NaN], [1, 1], [1, 1]).rows).toBe(1);
    const h = fig([{ chart: 'heatmap', x: col('x'), y: col('y'), z: col('z') }]);
    const q = h.panels[0].series[0];
    expect(q).toMatchObject({ kind: 'heatmap', colorbar: { show: true, label: 'z' } });
    expect(q.x.values).toEqual([0, 1, 2, 3]);
    expect(q.y.values).toEqual([0, 1, 2]);
    expect(q.z.values[1]).toEqual([2, 2.5, 3, 3.5]);
    const n = normaliseFigure(h).panels[0].series[0];
    expect(n.z).toHaveLength(3);
    expect(n.z[0]).toHaveLength(4);
    const c = fig([{ chart: 'contour', x: col('x'), y: col('y'), z: col('z'), levels: 5, filled: false }]).panels[0].series[0];
    expect(c).toMatchObject({ kind: 'contour', levels: 5, filled: false });
    expect(fig([{ chart: 'contour', x: col('x'), y: col('y'), z: col('z') }]).panels[0].series[0]).toMatchObject({ levels: 7, filled: true });
  });

  test('a 2D histogram counts as numpy does: a bin takes its left edge, the last bin its right too', () => {
    const h = histogram2d([0, 1, 2, 3, 4], [0, 1, 2, 3, 4], 2, 2);
    expect(h.z).toEqual([[2, 0], [0, 3]]);
    expect(h.x).toEqual([1, 3]);
    expect(h.total).toBe(5);
    // No width of range: widened by one half each side, as numpy does.
    expect(histogram2d([2, 2], [5, 5], 2, 2).xEdges).toEqual([1.5, 2, 2.5]);
    expect(histogram2d([NaN], [1], 3).x).toEqual([]);
    const f = fig([{ chart: 'hist2d', x: col('x'), y: col('z'), bins: 4 }]);
    const q = f.panels[0].series[0];
    expect(q).toMatchObject({ kind: 'heatmap', colorbar: { show: true, label: 'Count' } });
    expect(q.z.values.flat().reduce((p, c) => p + c, 0)).toBe(12);
  });

  withPython('2D histogram counts equal numpy.histogram2d on random data', () => {
    let seed = 11;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const xs = Array.from({ length: 500 }, () => rand() * 10 - 3);
    const ys = Array.from({ length: 500 }, () => rand() ** 2 * 7);
    xs.push(7, -3);
    ys.push(7, 0);
    const want = python('import json,sys,numpy as np\nd=json.load(sys.stdin)\nh,_,_=np.histogram2d(d["x"],d["y"],bins=[9,5])\nprint(json.dumps(h.T.tolist()))', JSON.stringify({ x: xs, y: ys }));
    expect(histogram2d(xs, ys, 9, 5).z).toEqual(want);
  });

  test('a map or histogram with nothing to draw is left out, and the figure is null when that is all', () => {
    const t = fileOf('n.csv', 'a,b,c\n1,,3\n,2,3\n');
    expect(fig([{ chart: 'heatmap', x: 0, y: 1, z: 2 }], [t])).toBeNull();
    expect(fig([{ chart: 'hist2d', x: 0, y: 1 }], [t])).toBeNull();
    const kept = fig([{ chart: 'heatmap', x: 0, y: 1, z: 2 }, { chart: 'curve', x: 0, y: 2 }], [t]);
    expect(kept.panels[0].series.map((q) => q.kind)).toEqual(['line']);
  });

  test('suggests the columns each chart needs', () => {
    const t = trial.table;
    expect(suggestColumns(t, 'bar')).toEqual({ x: 0, y: 1 });
    expect(suggestColumns(t, 'box')).toEqual({ y: 1, groupBy: 0 });
    expect(suggestColumns(t, 'hist')).toEqual({ y: 1 });
    expect(suggestColumns(t, 'heatmap')).toEqual({ x: 1, y: 2, z: 3 });
    expect(suggestColumns(readTable('a,b\n1,2\n'), 'heatmap')).toEqual({ x: 0, y: 1, z: 1 });
    expect(suggestColumns(t, 'curve')).toEqual({});
  });

  test('says what each chart leaves out or doubles', () => {
    const file = trial;
    const ser = (o) => ({ x: 0, y: 1, draw: 'line', ...o });
    expect(seriesColumns(file.table, ser({ chart: 'bar', x: col('group'), y: col('response') }))).toEqual([col('response')]);
    expect(seriesColumns(file.table, ser({ chart: 'bar', x: col('dose'), y: col('response') }))).toEqual([col('dose'), col('response')]);
    expect(seriesNote(file, ser({ chart: 'bar', x: col('group'), y: col('response') }))).toMatch(/12 rows share 3 names/);
    const grid = fileOf('g.csv', 'x,y,z\n1,1,5\n2,1,6\n1,2,7\n1,2,8\n');
    expect(seriesNote(grid, { chart: 'heatmap', x: 0, y: 1, z: 2 })).toMatch(/1 row repeats a cell/);
    expect(seriesNote(grid, { chart: 'contour', x: 0, y: 1, z: 2 })).toMatch(/1 of 4 cells.*blank/);
    expect(seriesNote(file, ser({ chart: 'heatmap', x: 1, y: 1, z: 1 }))).toMatch(/diagonal/);
    expect(seriesNote(fileOf('s.csv', 'g,v\na,1\na,2\na,3\nb,3\n'), { chart: 'box', y: 1, groupBy: 0 })).toBe('Group "b" has fewer than three values.');
    expect(seriesNote(file, ser({ chart: 'hist', y: col('response') }))).toBe('');
  });

  const sample = (series) => ({ files: [trial], series: series.map((s, i) => ({ id: `s${i + 1}`, fileId: 'trial.csv', x: 0, y: 1, draw: 'line', panel: 0, ...s })) });
  const CASES = {
    bar: [{ chart: 'bar', x: col('group'), y: col('response'), yerr: col('err') }],
    barNumbers: [{ chart: 'bar', x: col('dose'), y: col('response') }],
    hist: [{ chart: 'hist', y: col('response'), bins: 5 }, { chart: 'hist', y: col('z'), bins: 5, density: true }],
    box: [{ chart: 'box', y: col('response'), groupBy: col('group') }],
    boxColumns: [{ chart: 'box', y: col('response') }, { chart: 'box', y: col('z') }],
    heatmap: [{ chart: 'heatmap', x: col('x'), y: col('y'), z: col('z') }],
    contour: [{ chart: 'contour', x: col('x'), y: col('y'), z: col('z'), levels: 4 }],
    contourLines: [{ chart: 'contour', x: col('x'), y: col('y'), z: col('z'), filled: false }],
    hist2d: [{ chart: 'hist2d', x: col('x'), y: col('z'), bins: 3 }],
    step: [{ chart: 'curve', draw: 'step', x: col('x'), y: col('z') }],
    mixed: [{ chart: 'curve', draw: 'both', x: col('dose'), y: col('response'), panel: 0 }, { chart: 'hist', y: col('z'), panel: 1 }]
  };

  withPython('every chart kind writes a script that runs, reading the file or with the numbers in it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-charts-'));
    try {
      writeFileSync(join(dir, 'trial.csv'), rows.join('\n'));
      for (const [name, series] of Object.entries(CASES)) {
        const state = sample(series);
        const desc = normaliseFigure(builderFigure(state, { title: name }));
        for (const mode of ['files', 'embed']) {
          const file = join(dir, `${name}_${mode}.py`);
          writeFileSync(file, figureScript(desc, { data: mode, files: pythonFiles(state) }));
          const r = spawnSync('python3', [file], { cwd: dir, encoding: 'utf8', timeout: 120000, env: { ...process.env, MPLBACKEND: 'Agg' } });
          expect([name, mode, r.status, r.stderr.split('\n').filter((l) => /Error|Warning/.test(l))]).toEqual([name, mode, 0, []]);
        }
        expect(existsSync(join(dir, `${desc.export.filename}.pdf`))).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * Second axes: a y axis on the right, an x axis on top
 * ------------------------------------------------------------------ */

describe('series on a second axis', () => {
  const HEAT_CSV = 'time,temperature,pressure,wavelength,absorbance,wavenumber,sample\n'
    + Array.from({ length: 30 }, (_, i) => {
      const wl = 400 + 10 * i;
      return `${i * 5},${(290 + 30 * (1 - Math.exp(-i / 8))).toFixed(3)},${(i === 4 ? '' : (100 * Math.exp(i / 15)).toFixed(3))},${wl},${Math.exp(-(((wl - 550) / 60) ** 2)).toFixed(4)},${(1e7 / wl).toFixed(3)},${'ABCDEF'[i % 6]}`;
    }).join('\n') + '\n';
  const heat = fileOf('heat.csv', HEAT_CSV);
  const c = (n) => heat.table.headers.indexOf(n);
  const state = (series) => ({ files: [heat], series: series.map((q, i) => ({ id: `s${i + 1}`, fileId: 'heat.csv', draw: 'line', ...q })) });

  test('which charts may stand on a second axis', () => {
    const t = heat.table;
    expect(axisChoices(t, { chart: 'curve' })).toEqual({ x: true, y: true });
    expect(axisChoices(t, { chart: 'hist' })).toEqual({ x: true, y: true });
    expect(axisChoices(t, { chart: 'bar', x: c('time'), y: c('pressure') })).toEqual({ x: true, y: true });
    expect(axisChoices(t, { chart: 'bar', x: c('sample'), y: c('pressure') })).toEqual({ x: false, y: true });
    for (const chart of ['box', 'heatmap', 'contour', 'hist2d']) expect(axisChoices(t, { chart })).toEqual({ x: false, y: false });
  });

  test('a right-hand series names the right axis; the left keeps the first left-hand one; the axis takes the colour of its one series', () => {
    const f = builderFigure(state([
      { x: c('time'), y: c('temperature') },
      { x: c('time'), y: c('pressure'), yAxis: 'right' }
    ]));
    const [p] = f.panels;
    expect(p.series.map((q) => q.yAxis)).toEqual([undefined, 'right']);
    expect([p.yLabel, p.y2Label, f.xLabel]).toEqual(['temperature', 'pressure', 'time']);
    expect(normaliseFigure(f).panels[0].y2Color).toBe(COLOR_CYCLE[1]);
    // Two on the right: the axis in the text's colour.
    const two = builderFigure(state([
      { x: c('time'), y: c('temperature'), yAxis: 'right' },
      { x: c('time'), y: c('pressure'), yAxis: 'right' }
    ]));
    expect(normaliseFigure(two).panels[0]).toMatchObject({ y2Label: 'temperature', y2Color: null, yLabel: '' });
    // A chart that cannot stand there stays on the left.
    const map = builderFigure(state([{ chart: 'heatmap', x: c('time'), y: c('temperature'), z: c('pressure'), yAxis: 'right', xAxis: 'top' }]));
    expect(map.panels[0].series[0].yAxis).toBeUndefined();
    expect(map.panels[0].y2Label).toBeUndefined();
  });

  test('a top series names the top axis from its x column; bars named by text stay on the bottom', () => {
    const f = builderFigure(state([
      { x: c('wavelength'), y: c('absorbance') },
      { x: c('wavenumber'), y: c('absorbance'), xAxis: 'top', draw: 'points' },
      { chart: 'bar', x: c('sample'), y: c('pressure'), xAxis: 'top', yAxis: 'right', panel: 1 }
    ]));
    expect(f.xLabel).toBe('wavelength');
    expect(f.panels[0]).toMatchObject({ x2Label: 'wavenumber', x2Color: 'auto' });
    expect(f.panels[0].series[1].xAxis).toBe('top');
    expect(f.panels[1].series[0]).toMatchObject({ kind: 'bar', yAxis: 'right' });
    expect(f.panels[1].series[0].xAxis).toBeUndefined();
    expect(f.panels[1].x2Label).toBeUndefined();
    // Every series on top: the bottom axis has no label of its own.
    expect(builderFigure(state([{ x: c('wavenumber'), y: c('absorbance'), xAxis: 'top' }])).xLabel).toBe('');
  });

  test('the note speaks of the scale of the axis the series stands on', () => {
    const s = { id: 's1', fileId: 'heat.csv', chart: 'curve', draw: 'line', x: c('time'), y: c('temperature') };
    const zero = { ...s, x: c('wavelength'), y: c('time') };   // time starts at 0
    expect(seriesNote(heat, zero, { yLog: true })).toMatch(/1 point is at or below zero/);
    // On the right, the left axis' log scale does not matter, the right one's does.
    expect(seriesNote(heat, { ...zero, yAxis: 'right' }, { yLog: true })).toBe('');
    expect(seriesNote(heat, { ...zero, yAxis: 'right' }, { y2Log: true })).toMatch(/1 point is at or below zero/);
    // On top, the top axis' scale.
    expect(seriesNote(heat, { ...s, xAxis: 'top' }, { xLog: true })).toBe('');
    expect(seriesNote(heat, { ...s, xAxis: 'top' }, { x2Log: true })).toMatch(/at or below zero/);
  });

  withPython('the script runs, reading the file or with the numbers in it, and matplotlib\'s twins show what the preview shows', async () => {
    const st = state([
      { x: c('time'), y: c('temperature'), draw: 'both' },
      { x: c('time'), y: c('pressure'), yAxis: 'right' },
      { x: c('wavenumber'), y: c('temperature'), xAxis: 'top', draw: 'points' },
      { chart: 'hist', y: c('absorbance'), xAxis: 'top', yAxis: 'right', panel: 1 },
      { x: c('wavelength'), y: c('absorbance'), panel: 1 }
    ]);
    const fig = applyStyle(builderFigure(st), { panels: [{ y2Scale: 'log' }] });
    const views = buildFigure(normaliseFigure(fig)).info.views;
    // fig.axes in the order the script makes them: the panels, then each panel's twins.
    const want = [[views[0].x, views[0].y], [views[1].x, views[1].y], [views[0].x, views[0].y2], [views[0].x2, views[0].y],
      [views[1].x, views[1].y2], [views[1].x2, views[1].y], [views[1].x2, views[1].y2]];
    for (const data of ['files', 'embed']) {
      const script = figureScript(fig, { data, files: pythonFiles(st) });
      expect(script.includes("read_csv('heat.csv')")).toBe(data === 'files');
      const r = await run(script, data === 'files' ? { 'heat.csv': HEAT_CSV } : {});
      try {
        expect([data, r.code, r.stderr]).toEqual([data, 0, '']);
        expect(r.fig.panels).toHaveLength(want.length);
        r.fig.panels.forEach((p, i) => {
          const [x, y] = want[i];
          const ok = [...p.xlim.map((v, k) => close(v, x.view[k])), ...p.ylim.map((v, k) => close(v, y.view[k]))].every(Boolean);
          if (!ok) throw new Error(`${data} axes ${i}: matplotlib x ${p.xlim} y ${p.ylim}, preview x ${x.view} y ${y.view}`);
        });
        expect(r.fig.panels[2]).toMatchObject({ yscale: 'log', ylabel: 'pressure' });
        expect(r.fig.panels[3].xlabel).toBe('wavenumber');
        // One legend, on the twin made last, for the series of every axes of the panel.
        expect(r.fig.panels[3].legend).toEqual(['temperature', 'pressure', 'temperature']);
        expect(r.fig.panels[0].legend).toBeNull();
      } finally {
        rmSync(r.dir, { recursive: true, force: true });
      }
    }
  }, 120000);
});

/* ------------------------------------------------------------------ *
 * Bars lying flat, stacked bars, bars of means, histogram options, box
 * options and violins
 * ------------------------------------------------------------------ */

describe('more charts from columns', () => {
  // Replicate rows: four treatments of different sizes, one with a single value, a row with no name, a row with no number.
  let seed = 11;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const gauss = () => Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand());
  const repRows = ['treatment,batch,response,weight,dose'];
  [['control', 7, 5], ['low', 6, 6.2], ['mid', 5, 7.9], ['high', 8, 9.1]].forEach(([name, n, mu], g) => {
    for (let i = 0; i < n; i++) repRows.push(`${name},${'ABC'[i % 3]},${(mu + gauss()).toFixed(3)},${(20 + mu + 2 * gauss()).toFixed(2)},${g * 5}`);
  });
  repRows.push('single,A,4.200,22.10,40', ',B,3.300,21.00,40', 'low,C,,25.00,5');
  const reps = fileOf('reps.csv', repRows.join('\n'));
  const totals = fileOf('totals.csv', 'name,pos,north,south,west,err\nQ1,0,3.0,2.0,1.0,0.3\nQ2,5,4.0,-1.0,2.0,0.2\nQ3,10,2.5,3.0,2.0,0.4\nQ4,15,5.0,1.0,0.5,0.1\n');
  const rc = (n) => reps.table.headers.indexOf(n);
  const tc = (n) => totals.table.headers.indexOf(n);
  const stateOf = (file, series) => ({ files: [file], series: series.map((s, i) => ({ id: `s${i + 1}`, fileId: file.id, x: 0, y: 1, draw: 'line', panel: 0, ...s })) });
  const fig = (file, series) => builderFigure(stateOf(file, series));

  test('bars lying flat: the names go up the left axis, the first at the top; lengths and errors along x', () => {
    const f = fig(totals, [
      { chart: 'bar', x: tc('name'), y: tc('north'), yerr: tc('err'), orientation: 'h' },
      { chart: 'bar', x: tc('name'), y: tc('south'), orientation: 'h' }
    ]);
    const [a, b] = f.panels[0].series;
    expect(a).toMatchObject({ kind: 'bar', orientation: 'h' });
    expect(a.y).toEqual({ values: [3, 2, 1, 0], name: 'name_position' });
    expect(a.x).toMatchObject({ name: 'north', values: [3, 4, 2.5, 5], source: 'totals', column: 'north' });
    expect(a.xerr.column).toBe('err');
    expect([a.yerr, b.xerr]).toEqual([undefined, undefined]);
    expect(f.panels[0].yCategories).toEqual(['Q4', 'Q3', 'Q2', 'Q1']);
    expect(f.xCategories).toBeUndefined();
    expect([f.xLabel, f.panels[0].yLabel]).toEqual(['north', 'name']);
    const n = normaliseFigure(f);
    expect(n.panels[0].series.map((q) => q.offset)).toEqual([0.2, -0.2]);             // the first series above the second
    // Placed by numbers, they lie at those numbers, four fifths of the gap thick.
    const g = fig(totals, [{ chart: 'bar', x: tc('pos'), y: tc('north'), orientation: 'h' }]);
    expect(g.panels[0].series[0]).toMatchObject({ orientation: 'h', width: 4, y: { column: 'pos' }, x: { column: 'north' } });
    expect(g.panels[0].yCategories).toBeUndefined();
    expect([g.xLabel, g.panels[0].yLabel]).toEqual(['north', 'pos']);
    // Upright bars are described as before.
    const up = fig(totals, [{ chart: 'bar', x: tc('name'), y: tc('north'), yerr: tc('err') }]);
    expect(Object.keys(up.panels[0].series[0]).sort()).toEqual(['id', 'kind', 'label', 'legend', 'x', 'y', 'yerr']);
    expect(up.panels[0].yCategories).toBeUndefined();
  });

  test('horizontal bars stand on the panel\'s own axes; stacked ones may stand on the right', () => {
    const t = totals.table;
    expect(axisChoices(t, { chart: 'bar', x: tc('pos'), y: tc('north'), orientation: 'h' })).toEqual({ x: false, y: false });
    expect(axisChoices(t, { chart: 'bar', x: tc('pos'), y: tc('north'), stack: 'stack' })).toEqual({ x: true, y: true });
    expect(axisChoices(reps.table, { chart: 'bars-mean', x: 0, y: 2 })).toEqual({ x: false, y: true });
    expect(axisChoices(reps.table, { chart: 'bars-mean', x: 0, y: 2, orientation: 'h' })).toEqual({ x: false, y: false });
    expect(axisChoices(reps.table, { chart: 'violin', y: 2 })).toEqual({ x: false, y: false });
    const f = fig(totals, [{ chart: 'bar', x: tc('pos'), y: tc('north'), orientation: 'h', xAxis: 'top', yAxis: 'right' }]);
    expect([f.panels[0].series[0].xAxis, f.panels[0].series[0].yAxis]).toEqual([undefined, undefined]);
    expect(seriesNote(totals, { chart: 'bar', x: tc('pos'), y: tc('north'), orientation: 'h', yAxis: 'right' })).toMatch(/Horizontal bars stand on the bottom and left axes/);
    expect(seriesNote(totals, { chart: 'bar', x: tc('pos'), y: tc('north'), orientation: 'h' })).toBe('');
  });

  test('stacked bars: each series says how it stands; to 100% the axis is a share', () => {
    const f = fig(totals, [
      { chart: 'bar', x: tc('name'), y: tc('north'), stack: 'stack' }, { chart: 'bar', x: tc('name'), y: tc('south'), stack: 'stack' },
      { chart: 'bar', x: tc('name'), y: tc('west') }
    ]);
    expect(f.panels[0].series.map((q) => q.stack)).toEqual(['stack', 'stack', undefined]);
    expect(f.panels[0].yLabel).toBe('north');
    const [a, b, c] = normaliseFigure(f).panels[0].series;
    expect(b.bottoms).toEqual([3, 0, 2.5, 5]);
    expect([a.offset, b.offset, c.offset]).toEqual([-0.2, -0.2, 0.2]);
    const pc = fig(totals, [{ chart: 'bar', x: tc('pos'), y: tc('north'), stack: 'percent' }, { chart: 'bar', x: tc('pos'), y: tc('west'), stack: 'percent', yAxis: 'right' }]);
    expect(pc.panels[0].yLabel).toBe('Share (%)');
    expect(pc.panels[0].y2Label).toBe('Share (%)');
    const flat = fig(totals, [{ chart: 'bar', x: tc('name'), y: tc('north'), stack: 'percent', orientation: 'h' }, { chart: 'bar', x: tc('name'), y: tc('west'), stack: 'percent', orientation: 'h' }]);
    expect([flat.xLabel, flat.panels[0].yLabel]).toEqual(['Share (%)', 'name']);
    expect(normaliseFigure(flat).panels[0].series[1].heights[0]).toBe(25);
    // A stacked series with nothing to stand with is told so.
    const lone = { chart: 'bar', x: tc('name'), y: tc('north'), stack: 'stack' };
    expect(seriesNote(totals, lone, { stackPartners: 0 })).toMatch(/No other stacked bars in this panel/);
    expect(seriesNote(totals, lone, { stackPartners: 1 })).toBe('');
    expect(seriesNote(totals, lone)).toBe('');
  });

  test('bars of means: the rows grouped by name, the group of each row for the script', () => {
    const g = replicateGroups(reps.table, rc('response'), rc('treatment'));
    expect(g.names).toEqual(['control', 'low', 'mid', 'high', 'single']);
    expect(g.counts).toEqual([7, 6, 5, 8, 1]);
    expect(g.codes.slice(0, 8)).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(g.codes.slice(-3)).toEqual([4, -1, 1]);                                      // one value; no name; a known name with no number
    // Names that are numbers are put in order.
    expect(replicateGroups(reps.table, rc('response'), rc('dose')).names).toEqual(['0', '5', '10', '15', '40']);
    expect(suggestColumns(reps.table, 'bars-mean')).toEqual({ x: 0, y: 2 });
    expect(seriesColumns(reps.table, { chart: 'bars-mean', x: 0, y: 2 })).toEqual([2]);
    const f = fig(reps, [{ chart: 'bars-mean', x: rc('treatment'), y: rc('response'), error: 'ci', level: 0.99, points: true }]);
    const q = f.panels[0].series[0];
    expect(q).toMatchObject({ kind: 'bar', points: true, x: { values: [0, 1, 2, 3, 4], name: 'treatment_position' } });
    expect(q.replicates).toMatchObject({ error: 'ci', level: 0.99, names: g.names, codes: g.codes, values: { name: 'response', source: 'reps', column: 'response' } });
    expect(f.xCategories).toEqual(g.names);
    expect([f.xLabel, f.panels[0].yLabel]).toEqual(['treatment', 'response']);
    const n = normaliseFigure(f).panels[0].series[0];
    const control = reps.table.columns[rc('response')].slice(0, 7);
    expect(n.y[0]).toBeCloseTo(control.reduce((a, b) => a + b, 0) / 7, 12);
    expect(n.replicates.stats.n).toEqual([7, 6, 5, 8, 1]);
    expect(Number.isNaN(n.yerr[0][4])).toBe(true);
    // Defaults: the standard deviation, no points; an unknown level is 95%.
    const plain = fig(reps, [{ chart: 'bars-mean', x: rc('treatment'), y: rc('response'), level: 0.5 }]).panels[0].series[0];
    expect([plain.replicates.error, plain.replicates.level, plain.points]).toEqual(['sd', 0.95, undefined]);
    expect(LEVELS).toEqual([0.9, 0.95, 0.99]);
    // Lying flat: the first name at the top.
    const h = fig(reps, [{ chart: 'bars-mean', x: rc('treatment'), y: rc('response'), orientation: 'h' }]);
    expect(h.panels[0].series[0].y.values).toEqual([4, 3, 2, 1, 0]);
    expect(h.panels[0].yCategories).toEqual(['single', 'high', 'mid', 'low', 'control']);
    expect([h.xLabel, h.panels[0].yLabel]).toEqual(['response', 'treatment']);
    // Nothing to draw.
    expect(fig(fileOf('n.csv', 'name,v\n,1\n,2\n'), [{ chart: 'bars-mean', x: 0, y: 1 }])).toBeNull();
  });

  test('the note of bars of means counts the values of each name', () => {
    const s = { chart: 'bars-mean', x: rc('treatment'), y: rc('response') };
    const note = seriesNote(reps, s);
    expect(note).toContain('Values per name: control 7, low 6, mid 5, high 8, single 1.');
    expect(note).toContain('"single" has one value, so no error bar.');
    expect(note).toContain('1 row has no name and is left out.');
    expect(note).toMatch(/^1 of 29 rows have no number in response/);
    expect(seriesNote(reps, { ...s, error: 'none' })).not.toContain('no error bar');
    expect(seriesNote(reps, { ...s, x: rc('dose') })).toContain('The names column holds numbers: each different number is a bar.');
    const many = fileOf('many.csv', 'name,v\n' + Array.from({ length: 40 }, (_, i) => `n${i % 10},${i}`).join('\n'));
    expect(seriesNote(many, { chart: 'bars-mean', x: 0, y: 1 })).toBe('10 names, 4 values each.');
    // Bars with one bar per row point to them.
    expect(seriesNote(reps, { chart: 'bar', x: rc('treatment'), y: rc('response') })).toMatch(/28 rows share 6 names, and each row is a bar\. For one bar per name, choose Bars of means\./);
  });

  test('bin edges typed in: numbers that increase, or a reason', () => {
    expect(parseEdges('0, 1, 2.5;10')).toEqual({ edges: [0, 1, 2.5, 10], error: '' });
    expect(parseEdges(' -1e1  0 5 ')).toEqual({ edges: [-10, 0, 5], error: '' });
    expect(parseEdges('')).toEqual({ edges: null, error: 'Type the bin edges, for example 0, 1, 2, 5, 10.' });
    expect(parseEdges('1')).toEqual({ edges: null, error: 'Bins need at least two edges.' });
    expect(parseEdges('1, two, 3').error).toBe('"two" is not a number.');
    expect(parseEdges('1, 3, 2').error).toBe('The edges must increase: 2 comes after 3.');
    expect(parseEdges('1, 1').error).toMatch(/must increase/);
    expect(parseEdges('1,5 2,5').edges).toBeNull();                                     // decimal commas: four numbers that do not increase
    expect(parseEdges('0, inf').edges).toBeNull();
  });

  test('a histogram takes a number of bins, a rule of numpy\'s or edges, a way to scale, and a running total', () => {
    expect(BIN_MODES).toEqual(['number', 'rule', 'edges']);
    expect(histogramOptions({ bins: 7 })).toEqual({ bins: 7, normalise: 'counts', cumulative: false, error: '' });
    expect(histogramOptions({ binsMode: 'rule', binRule: 'fd', bins: 7 }).bins).toBe('fd');
    expect(histogramOptions({ binsMode: 'rule', binRule: 'nonsense' }).bins).toBe('auto');
    expect(histogramOptions({ binsMode: 'edges', binEdges: '0, 5, 10' }).bins).toEqual([0, 5, 10]);
    expect(histogramOptions({ binsMode: 'edges', binEdges: '5, 0', bins: 4 })).toMatchObject({ bins: 4, error: 'The edges must increase: 0 comes after 5.' });
    expect(histogramOptions({ density: true }).normalise).toBe('density');
    expect(histogramOptions({ density: true, normalise: 'percent', cumulative: 1 })).toMatchObject({ normalise: 'percent', cumulative: true });
    const one = (o) => fig(reps, [{ chart: 'hist', y: rc('response'), ...o }]);
    const q = (o) => one(o).panels[0].series[0];
    // The description of a plain histogram has not changed.
    expect(q({ bins: 6 })).toEqual({ id: 's1', label: 'response', legend: false, kind: 'histogram', values: expect.any(Object), bins: 6, density: false });
    expect(q({ density: true })).toMatchObject({ bins: 10, density: true });
    expect(q({ binsMode: 'rule', binRule: 'scott', normalise: 'fraction', cumulative: true })).toMatchObject({ bins: 'scott', density: false, normalise: 'fraction', cumulative: true });
    expect(q({ binsMode: 'edges', binEdges: '2, 4, 6, 12', normalise: 'density' })).toMatchObject({ bins: [2, 4, 6, 12], density: true });
    expect(q({ normalise: 'density' }).normalise).toBeUndefined();
    const labels = [[{}, 'Count'], [{ density: true }, 'Density'], [{ normalise: 'fraction' }, 'Fraction'], [{ normalise: 'percent' }, 'Percent'],
      [{ cumulative: true }, 'Cumulative count'], [{ normalise: 'density', cumulative: true }, 'Cumulative fraction'], [{ normalise: 'percent', cumulative: true }, 'Cumulative percent']];
    for (const [o, label] of labels) expect([o, one(o).panels[0].yLabel]).toEqual([o, label]);
    const n = normaliseFigure(one({ binsMode: 'rule', binRule: 'sturges', normalise: 'percent', cumulative: true })).panels[0].series[0];
    expect(n.edges).toHaveLength(Math.ceil(Math.log2(27) + 1) + 1);
    expect(n.counts[n.counts.length - 1]).toBeCloseTo(100, 10);
    // Notes: edges that cannot be used, and values the edges leave out.
    const base = { chart: 'hist', y: rc('dose') };
    expect(seriesNote(reps, { ...base, binsMode: 'edges', binEdges: '5, 0' })).toBe('The edges must increase: 0 comes after 5. Until the edges are right, 10 equal bins are drawn.');
    expect(seriesNote(reps, { ...base, binsMode: 'edges', binEdges: '0, 10, 20' })).toBe('2 values lie outside the edges and are not counted.');
    expect(seriesNote(reps, { ...base, binsMode: 'edges', binEdges: '0, 10, 40' })).toBe('');
    expect(seriesNote(reps, { ...base, binsMode: 'rule', binRule: 'fd' })).toBe('');
  });

  test('box options: the whisker rule, a notch, and the mean with its interval', () => {
    const q = (o) => fig(reps, [{ chart: 'box', y: rc('response'), groupBy: rc('treatment'), ...o }]).panels[0].series[0];
    expect(Object.keys(q({})).sort()).toEqual(['groups', 'id', 'kind', 'label', 'legend']);    // as before
    expect(q({ whis: '1.5', notch: false, interval: null }).whis).toBeUndefined();
    expect(q({ whis: '5,95', notch: true, interval: 0.99 })).toMatchObject({ whis: '5,95', notch: true, mean: true, level: 0.99 });
    expect(q({ interval: 0.5 }).mean).toBeUndefined();
    const n = normaliseFigure(fig(reps, [{ chart: 'box', y: rc('response'), groupBy: rc('treatment'), whis: '0,100', notch: true, interval: 0.9 }])).panels[0].series[0];
    expect(n).toMatchObject({ whis: [0, 100], notch: true, mean: true, level: 0.9 });
    expect(n.groups[0].stats.fliers).toEqual([]);
  });

  test('violins: grouped as box plots are, with their options', () => {
    expect(suggestColumns(reps.table, 'violin')).toEqual({ y: 2, groupBy: 0 });
    const f = fig(reps, [{ chart: 'violin', y: rc('response'), groupBy: rc('treatment') }]);
    const q = f.panels[0].series[0];
    expect(Object.keys(q).sort()).toEqual(['groups', 'id', 'kind', 'label', 'legend']);
    expect(q.kind).toBe('violin');
    expect(q.groups.map((g) => g.position)).toEqual([0, 1, 2, 3, 4]);
    expect(f.xCategories).toEqual(['control', 'low', 'mid', 'high', 'single']);
    expect([f.xLabel, f.panels[0].yLabel]).toEqual(['treatment', 'response']);
    const o = fig(reps, [{ chart: 'violin', y: rc('response'), groupBy: rc('treatment'), bandwidth: 'silverman', cut: '2', scale: 'area', inner: 'quartiles', points: true }]).panels[0].series[0];
    expect(o).toMatchObject({ bandwidth: 'silverman', cut: 2, scale: 'area', inner: 'quartiles', points: true });
    const n = normaliseFigure(f).panels[0].series[0];
    expect(n.groups[4].kde.flat).toBe(true);
    expect(n.groups[0].kde.coords).toHaveLength(100);
    // One violin for a whole column, read by its name; after a box plot it takes the next place.
    const two = fig(reps, [{ chart: 'box', y: rc('response') }, { chart: 'violin', y: rc('weight') }]);
    expect(two.xCategories).toEqual(['response', 'weight']);
    expect(two.panels[0].series[1].groups[0]).toMatchObject({ position: 1, values: { column: 'weight' } });
    expect(seriesNote(reps, { chart: 'violin', y: rc('response'), groupBy: rc('treatment') })).toBe('1 of 29 rows have no number in response and are left out. "single" has one value or values all alike, drawn as a line.');
    expect(seriesNote(fileOf('s.csv', 'g,v\na,1\na,2\na,3\nb,3\nb,4\n'), { chart: 'violin', y: 1, groupBy: 0 })).toBe('Group "b" has fewer than three values.');
  });

  const CASES = {
    lying: [totals, [{ chart: 'bar', x: tc('name'), y: tc('north'), yerr: tc('err'), orientation: 'h' }, { chart: 'bar', x: tc('name'), y: tc('south'), orientation: 'h' }]],
    lyingNumbers: [totals, [{ chart: 'bar', x: tc('pos'), y: tc('north'), yerr: tc('err'), orientation: 'h' }]],
    wide: [totals, [{ chart: 'bar', x: tc('pos'), y: tc('north'), yerr: tc('err') }, { chart: 'bar', x: tc('pos'), y: tc('west') }]],
    stacked: [totals, [{ chart: 'bar', x: tc('name'), y: tc('north'), yerr: tc('err'), stack: 'stack' }, { chart: 'bar', x: tc('name'), y: tc('south'), stack: 'stack' }, { chart: 'bar', x: tc('name'), y: tc('west'), stack: 'stack' }]],
    percent: [totals, [{ chart: 'bar', x: tc('pos'), y: tc('north'), yerr: tc('err'), stack: 'percent' }, { chart: 'bar', x: tc('pos'), y: tc('west'), stack: 'percent' }]],
    lyingPercent: [totals, [{ chart: 'bar', x: tc('name'), y: tc('north'), orientation: 'h', stack: 'percent' }, { chart: 'bar', x: tc('name'), y: tc('west'), orientation: 'h', stack: 'percent', yerr: tc('err') }]],
    stackedRight: [totals, [{ chart: 'curve', x: tc('pos'), y: tc('err'), draw: 'both' }, { chart: 'bar', x: tc('pos'), y: tc('north'), stack: 'stack', yAxis: 'right' }, { chart: 'bar', x: tc('pos'), y: tc('west'), stack: 'stack', yAxis: 'right' }]],
    means: [reps, [{ chart: 'bars-mean', x: rc('treatment'), y: rc('response'), error: 'sd', points: true }]],
    meansInterval: [reps, [{ chart: 'bars-mean', x: rc('treatment'), y: rc('response'), error: 'ci', level: 0.99 }, { chart: 'bars-mean', x: rc('treatment'), y: rc('weight'), error: 'sem', yAxis: 'right' }]],
    meansLying: [reps, [{ chart: 'bars-mean', x: rc('treatment'), y: rc('response'), error: 'sem', points: true, orientation: 'h' }]],
    histRule: [reps, [{ chart: 'hist', y: rc('response'), binsMode: 'rule', binRule: 'fd', normalise: 'percent' }, { chart: 'hist', y: rc('weight'), binsMode: 'edges', binEdges: '15, 24, 26, 27, 28, 30, 40', normalise: 'fraction', cumulative: true, panel: 1 }]],
    histRunning: [reps, [{ chart: 'hist', y: rc('response'), binsMode: 'rule', binRule: 'auto', cumulative: true }, { chart: 'hist', y: rc('weight'), bins: 12, density: true, cumulative: true, panel: 1 }]],
    boxOptions: [reps, [{ chart: 'box', y: rc('response'), groupBy: rc('treatment'), whis: '5,95', notch: true, interval: 0.99 }]],
    boxRange: [reps, [{ chart: 'box', y: rc('response'), groupBy: rc('treatment'), whis: '0,100' }]],
    violin: [reps, [{ chart: 'violin', y: rc('response'), groupBy: rc('treatment'), points: true }]],
    violinOptions: [reps, [{ chart: 'violin', y: rc('response'), groupBy: rc('treatment'), inner: 'quartiles', scale: 'area', cut: 2, bandwidth: 'silverman' }, { chart: 'violin', y: rc('weight'), inner: 'median' }]]
  };

  withPython('every new chart writes a script that runs both ways and draws within the limits the preview shows', async () => {
    const files = { 'reps.csv': repRows.join('\n') + '\n', 'totals.csv': 'name,pos,north,south,west,err\nQ1,0,3.0,2.0,1.0,0.3\nQ2,5,4.0,-1.0,2.0,0.2\nQ3,10,2.5,3.0,2.0,0.4\nQ4,15,5.0,1.0,0.5,0.1\n' };
    const jobs = [];
    for (const [name, [file, series]] of Object.entries(CASES)) {
      const st = stateOf(file, series);
      const desc = builderFigure(st, { title: name });
      const views = buildFigure(normaliseFigure(desc)).info.views;
      // fig.axes in the order the script makes them: the panels, then each panel's right axes.
      const want = [...views.map((v) => [v.x, v.y]), ...views.filter((v) => v.y2).map((v) => [v.x, v.y2])];
      for (const data of ['files', 'embed']) {
        const script = figureScript(desc, { data, files: pythonFiles(st) });
        // The groups of a box plot or violin split by a column are written into the script; everything else is read.
        const split = series.every((q) => (q.chart === 'box' || q.chart === 'violin') && q.groupBy !== undefined);
        expect([name, data, script.includes(`read_csv('${file.name}')`)]).toEqual([name, data, data === 'files' && !split]);
        jobs.push(run(script, data === 'files' ? files : {}).then((r) => ({ name, data, r, want })));
      }
    }
    const done = await Promise.all(jobs);
    try {
      const drawn = {};
      for (const { name, data, r, want } of done) {
        expect([name, data, r.code, r.stderr]).toEqual([name, data, 0, '']);
        expect([name, r.fig.panels.length]).toEqual([name, want.length]);
        r.fig.panels.forEach((p, i) => {
          const [x, y] = want[i];
          const ok = [...p.xlim.map((v, k) => close(v, x.view[k])), ...p.ylim.map((v, k) => close(v, y.view[k]))].every(Boolean);
          if (!ok) throw new Error(`${name} ${data} axes ${i}: matplotlib x ${p.xlim} y ${p.ylim}, preview x ${x.view} y ${y.view}`);
        });
        // Reading the file and with the numbers in the script: the same figure.
        const key = JSON.stringify(r.fig.panels);
        if (drawn[name] === undefined) drawn[name] = key; else expect([name, key]).toEqual([name, drawn[name]]);
      }
      const of = (name) => done.find((d) => d.name === name && d.data === 'files').r.fig.panels;
      expect(of('lying')[0]).toMatchObject({ xlabel: 'north', ylabel: 'name', legend: ['north', 'south'] });
      expect(of('stacked')[0].legend).toEqual(['west', 'south', 'north']);                 // down the stack
      expect(of('percent')[0].ylim).toEqual([0, expect.closeTo(105, 9)]);
      expect(of('lyingPercent')[0].xlim[0]).toBe(0);
      expect(of('lyingPercent')[0].xlim[1]).toBeGreaterThan(105);                         // the last series' error bars reach past 100
      expect(of('stackedRight')[1].legend).toEqual(['err', 'west', 'north']);
      expect(of('means')[0]).toMatchObject({ xlabel: 'treatment', ylabel: 'response' });
      expect(of('histRule')[0].ylabel).toBe('Percent');
      expect(of('histRunning')[1].ylim[1]).toBeCloseTo(1.05, 9);
    } finally {
      for (const { r } of done) rmSync(r.dir, { recursive: true, force: true });
    }
  }, 240000);
});

/* ------------------------------------------------------------------ *
 * The built-in examples
 * ------------------------------------------------------------------ */

describe('the built-in examples', () => {
  const all = EXAMPLES.map((e) => ({ ...e, ex: builderExample(e.id), state: exampleState(e.id) }));
  // The figure an example draws: its series, laid out as it asks, in the look it brings.
  const figureOf = (e) => applyStyle(builderFigure(e.state, { title: e.name }), e.state.style);

  test('the list: an id, a name and a line of description each, none twice', () => {
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(15);
    expect(EXAMPLES[0].id).toBe('growth');
    for (const key of ['id', 'name', 'description']) expect(new Set(EXAMPLES.map((e) => e[key])).size).toBe(EXAMPLES.length);
    for (const e of EXAMPLES) {
      expect(e.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect([e.id, e.name.length > 3 && e.name.length <= 24]).toEqual([e.id, true]);
      expect([e.id, /^[A-Z].{15,80}\.$/.test(e.description)]).toEqual([e.id, true]);
    }
    expect(Object.isFrozen(EXAMPLES) && Object.isFrozen(EXAMPLES[0])).toBe(true);
    expect(builderExample('no-such-example')).toBeNull();
    expect(exampleState('no-such-example')).toBeNull();
  });

  test('the first is the growth curves the page has always loaded', () => {
    const { ex, state } = all[0];
    expect(ex.files).toEqual([{ name: 'growth_example.csv', csv: exampleCsv(), labels: EXAMPLE_LABELS }]);
    expect(state.series.map((s) => [s.x, s.y, s.yerr, s.draw, s.label])).toEqual([[0, 1, 2, 'both', 'Control'], [0, 3, 4, 'both', 'Treated']]);
    expect(state.files[0]).toMatchObject({ id: 'example', example: true });
  });

  test('every example is small, the same every time, and reads as a table with its columns found', () => {
    for (const e of all) {
      expect([e.id, JSON.stringify(builderExample(e.id))]).toEqual([e.id, JSON.stringify(e.ex)]);
      expect([e.id, e.ex.files.length >= 1, e.ex.series.length >= 1]).toEqual([e.id, true, true]);
      e.ex.files.forEach((f, i) => {
        const t = e.state.files[i].table;
        expect([e.id, f.name, t.ok, /^[a-z_]+_example\.csv$/.test(f.name)]).toEqual([e.id, f.name, true, true]);
        expect([e.id, t.rows > 2 && t.rows <= 700]).toEqual([e.id, true]);
        expect([e.id, f.csv.length < 12000]).toEqual([e.id, true]);
        // Every label is for a column the file has.
        for (const header of Object.keys(f.labels)) expect([e.id, header, t.headers.includes(header)]).toEqual([e.id, header, true]);
        expect(e.state.files[i]).toMatchObject({ example: true, name: f.name, labels: f.labels });
      });
      e.state.series.forEach((s, k) => {
        const file = e.state.files.find((f) => f.id === s.fileId);
        for (const key of ['x', 'y', 'y2', 'z', 'yerr', 'xerr', 'groupBy']) {
          if (e.ex.series[k][key] === undefined) continue;
          expect([e.id, key, file.table.headers[s[key]]]).toEqual([e.id, key, e.ex.series[k][key]]);
        }
        expect(s.file).toBeUndefined();
      });
    }
  });

  test('every example builds a figure with labelled axes and nothing to warn about', () => {
    for (const e of all) {
      const fig = figureOf(e);
      expect([e.id, fig !== null]).toEqual([e.id, true]);
      const n = normaliseFigure(fig);
      expect([e.id, n.panels.every((p) => p.series.length > 0)]).toEqual([e.id, true]);
      // An axis that shows numbers says what they are; a unit goes in brackets. (A shared axis is
      // labelled on its outer panels; an inset, too small for labels, has none.)
      const labels = n.panels.filter((p) => !p.inset).flatMap((p) => [p.xOuter ? (p.xCategories ? 'names' : p.xLabel) : 'shared', p.yOuter ? (p.yCategories ? 'names' : p.yLabel) : 'shared']);
      expect([e.id, labels.every((l) => l.length > 0)]).toEqual([e.id, true]);
      const byId = new Map(e.state.files.map((f) => [f.id, f]));
      const notes = e.state.series.map((s) => seriesNote(byId.get(s.fileId), s, { stackPartners: 2 })).filter(Boolean);
      expect([e.id, notes]).toEqual([e.id, e.id === 'bars-of-means' ? ['Values per name: Control 6, Low dose 6, High dose 6, Washout 6.'] : []]);
      expect([e.id, buildFigure(n).info.notes]).toEqual([e.id, []]);
      // The example's numbers are never read from a file.
      expect(pythonFiles(e.state)).toEqual({});
    }
  });

  test('between them the examples show every kind of chart the builder draws', () => {
    const of = (id) => normaliseFigure(figureOf(all.find((e) => e.id === id)));
    const kinds = new Set(all.flatMap((e) => normaliseFigure(figureOf(e)).panels.flatMap((p) => p.series.map((q) => q.kind))));
    expect([...kinds].sort()).toEqual(['bar', 'box', 'contour', 'errorbar', 'heatmap', 'histogram', 'line', 'scatter', 'violin']);
    expect(new Set(all.flatMap((e) => e.state.series.map((s) => s.chart || 'curve')))).toEqual(new Set(CHART_KINDS));
    expect(of('two-axes').panels[0]).toMatchObject({ yLabel: 'Temperature (K)', y2Label: 'Pressure (kPa)' });
    expect(of('two-axes').panels[0].series.map((q) => q.yAxis)).toEqual(['left', 'right']);
    expect(of('spectrum').panels[0]).toMatchObject({ x2Label: 'Wavenumber (cm$^{-1}$)' });
    expect(of('spectrum').panels[0].series[1].xAxis).toBe('top');
    expect(of('grouped-bars').panels[0].series.map((q) => [q.kind, q.offset, !!q.yerr])).toEqual([['bar', -0.2, true], ['bar', 0.2, true]]);
    expect(of('bars-of-means').panels[0].series[0]).toMatchObject({ points: true, replicates: { error: 'ci', level: 0.95 } });
    expect(of('stacked-bars').panels[0].series.map((q) => [q.orientation, q.stacked])).toEqual([['h', 'percent'], ['h', 'percent'], ['h', 'percent']]);
    expect(of('stacked-bars').panels[0].yCategories[0]).toBe('Channel');                      // the first site, Ridge, at the top
    expect(of('histograms').panels.map((p) => [p.yLabel, p.series[0].bins, p.series[0].cumulative])).toEqual([['Density', 'fd', false], ['Cumulative fraction', 'fd', true]]);
    // Boxes above, violins below, the groups of one over the groups of the other.
    const bv = of('box-violin');
    expect(bv.panels.map((p) => p.series[0].kind)).toEqual(['box', 'violin']);
    expect(bv.panels.map((p) => p.series[0].groups.map((g) => g.position))).toEqual([[0, 1, 2, 3], [0, 1, 2, 3]]);
    expect(bv.xCategories).toEqual(['WT', 'mutA', 'mutB', 'mutAB']);
    expect(of('surface').panels[0].series.map((q) => [q.kind, q.filled])).toEqual([['heatmap', undefined], ['contour', false]]);
    expect(of('surface').panels[0].series[0].z).toHaveLength(25);
    expect(of('hist2d').panels[0].series[0].colorbar.label).toBe('Count');
    expect(of('steps').panels[0].series[0].step).toBe('mid');
    expect(of('panels').panels.map((p) => p.series[0].kind)).toEqual(['line', 'heatmap']);
    expect(all.find((e) => e.id === 'panels').state.files.map((f) => f.id)).toEqual(['example', 'example2']);
  });

  test('boxes and violins of two panels stand over each other; a place with two names carries both', () => {
    const t = fileOf('g.csv', 'g,h,v,w\na,x,1,5\na,x,2,6\nb,y,3,7\nb,y,4,8\n');
    const series = (list) => list.map((s, i) => ({ id: `s${i + 1}`, fileId: 'g.csv', x: 0, y: 2, draw: 'line', panel: 0, ...s }));
    const two = builderFigure({ files: [t], series: series([{ chart: 'box', y: 2, groupBy: 0 }, { chart: 'violin', y: 3, groupBy: 0, panel: 1 }]) });
    expect(two.panels.map((p) => p.series[0].groups.map((g) => g.position))).toEqual([[0, 1], [0, 1]]);
    expect(two.xCategories).toEqual(['a', 'b']);
    // In one panel they stand side by side, as before.
    const one = builderFigure({ files: [t], series: series([{ chart: 'box', y: 2, groupBy: 0 }, { chart: 'violin', y: 3, groupBy: 0 }]) });
    expect(one.panels[0].series.map((q) => q.groups.map((g) => g.position))).toEqual([[0, 1], [2, 3]]);
    expect(one.xCategories).toEqual(['a', 'b', 'a', 'b']);
    const mixed = builderFigure({ files: [t], series: series([{ chart: 'box', y: 2, groupBy: 0 }, { chart: 'box', y: 3, groupBy: 1, panel: 1 }]) });
    expect(mixed.xCategories).toEqual(['a / x', 'b / y']);
  });

  withPython('every example\'s script runs with its numbers in it, whichever way the data are asked for, and draws within the preview\'s limits', async () => {
    const jobs = [];
    for (const e of all) {
      const desc = figureOf(e);
      const info = buildFigure(normaliseFigure(desc)).info;
      // fig.axes in the order the script makes them: the panels, then each panel's right and top axes.
      // An inset is its panel's child, not the figure's.
      const views = info.views.filter((v, i) => info.insets[i] < 0);
      const want = [...views.map((v) => [v.x, v.y]), ...views.flatMap((v) => [...(v.y2 ? [[v.x, v.y2]] : []), ...(v.x2 ? [[v.x2, v.y]] : [])])];
      const inside = info.views.filter((v, i) => info.insets[i] >= 0).map((v) => [v.x, v.y]);
      for (const data of ['files', 'embed']) {
        const script = figureScript(desc, { data, files: pythonFiles(e.state) });
        expect([e.id, data, /read_csv|read_table/.test(script)]).toEqual([e.id, data, false]);
        jobs.push(run(script).then((r) => ({ id: e.id, data, r, want, inside, script })));
      }
    }
    const done = await Promise.all(jobs);
    try {
      const scripts = {};
      for (const { id, data, r, want, inside, script } of done) {
        expect([id, data, r.code, r.stderr]).toEqual([id, data, 0, '']);
        // (Colour bars are axes too, made after the others.)
        const axes = r.fig.panels.slice(0, want.length);
        expect([id, axes.length, r.fig.insets.length]).toEqual([id, want.length, inside.length]);
        [...axes, ...r.fig.insets].forEach((p, i) => {
          const [x, y] = [...want, ...inside][i];
          const ok = [...p.xlim.map((v, k) => close(v, x.view[k])), ...p.ylim.map((v, k) => close(v, y.view[k]))].every(Boolean);
          if (!ok) throw new Error(`${id} ${data} axes ${i}: matplotlib x ${p.xlim} y ${p.ylim}, preview x ${x.view} y ${y.view}`);
        });
        // With no file to read, both ways of asking give the same script.
        if (scripts[id] === undefined) scripts[id] = script; else expect([id, script === scripts[id]]).toEqual([id, true]);
      }
    } finally {
      for (const { r } of done) rmSync(r.dir, { recursive: true, force: true });
    }
  }, 240000);
});

/* ------------------------------------------------------------------ *
 * Layout: a grid of panels, shared axes, insets
 * ------------------------------------------------------------------ */

describe('panel layout', () => {
  const t = fileOf('run.csv', RUN_CSV);
  const groups = fileOf('g.csv', 'site,kind,value,other\nA,x,1,5\nA,x,2,6\nB,y,3,7\nB,y,4,8\nC,x,5,9\n');
  const series = (list) => list.map((q, i) => ({ id: `s${i + 1}`, fileId: 'run.csv', x: 0, y: 1, draw: 'line', panel: 0, ...q }));

  test('the layout, complete: one panel sharing x in a column, nothing shared on a grid', () => {
    expect(builderLayout(undefined)).toEqual({ rows: 1, cols: 1, sharex: 'all', sharey: 'none', insets: [] });
    expect(builderLayout({ rows: 3, cols: 2 })).toMatchObject({ rows: 3, cols: 2, sharex: 'none', sharey: 'none' });
    expect(builderLayout({ rows: 99, cols: 99, sharex: 'col', sharey: 'row' })).toMatchObject({ rows: MAX_GRID_ROWS, cols: MAX_GRID_COLS, sharex: 'col', sharey: 'row' });
    expect(builderLayout({ rows: 'two', cols: 0, sharex: 'both', sharey: null })).toMatchObject({ rows: 1, cols: 1, sharex: 'all', sharey: 'none' });
    // In one column, down a column is all the panels and along a row is each alone.
    expect(builderLayout({ rows: 3, sharex: 'col', sharey: 'row' })).toMatchObject({ sharex: 'all', sharey: 'none' });
    expect(builderLayout({ rows: 3, sharex: 'none', sharey: 'all' })).toMatchObject({ sharex: 'none', sharey: 'all' });
    // An inset: in a cell, at a share of it, inside it; its limits its own.
    const inset = builderLayout({ insets: [{ parent: 2, x: 0.7, y: 2, w: 0.9, zoom: 1, xLim: [0, ''], yLim: ['a', 3] }, null] }).insets;
    expect(inset[0]).toEqual({ id: 'inset1', parent: 2, x: 0.7, y: 0.9, w: expect.closeTo(0.3, 12), h: expect.closeTo(0.1, 12), zoom: true, xLim: [0, null], yLim: [null, 3] });
    expect(inset[1]).toMatchObject({ id: 'inset2', parent: 0, x: 0.55, y: 0.5, w: 0.4, h: 0.4, zoom: false, xLim: [null, null] });
    expect(builderLayout({ insets: Array.from({ length: 9 }, () => ({})) }).insets).toHaveLength(MAX_INSETS);
  });

  test('the panels in use: the cells row by row, then the insets', () => {
    const layout = { rows: 2, cols: 2, insets: [{ id: 'one', parent: 3 }, { id: 'two', parent: 0 }] };
    const state = { series: series([{ panel: 3 }, { panel: 0 }, { panel: 'two' }, { panel: 3 }, { panel: 'gone' }, { panel: -4 }]), layout };
    expect(builderPanels(state).map((p) => [p.key, p.cell, p.inset && p.inset.parent])).toEqual([[0, 0, null], [3, 3, null], ['two', null, 0]]);
    expect(builderPanels({ series: [] })).toEqual([]);
  });

  test('one column is the stack it has always been, whatever the rows; empty panels are left out', () => {
    const list = series([{}, { y: 3, panel: 2 }]);
    const plain = builderFigure({ files: [t], series: list });
    expect(builderFigure({ files: [t], series: list, layout: { rows: 4, cols: 1 } })).toEqual(plain);
    expect(plain.panels.map((p) => [p.id, p.row, p.name, p.xLabel])).toEqual([['panel1', undefined, undefined, undefined], ['panel3', undefined, undefined, undefined]]);
    expect([plain.layout, plain.sharex, plain.sharey, plain.xLabel]).toEqual([undefined, undefined, undefined, 'time (s)']);
    expect(isStack(normaliseFigure(plain))).toBe(true);
    // Sharing nothing, or the y axis, is said; then every panel labels its own x.
    const apart = builderFigure({ files: [t], series: series([{}, { x: 3, y: 4, panel: 1 }]), layout: { sharex: 'none', sharey: 'all' } });
    expect([apart.sharex, apart.sharey, apart.xLabel, apart.layout]).toEqual(['none', 'all', '', undefined]);
    expect(apart.panels.map((p) => p.xLabel)).toEqual(['time (s)', 'lower']);
    expect(normaliseFigure(apart).panels.map((p) => [p.xOuter, p.shareY])).toEqual([[true, 0], [true, 0]]);
  });

  test('a grid: each series in its cell, each panel named and labelled by its own columns', () => {
    const state = { files: [t, groups], layout: { rows: 2, cols: 2 }, series: series([{}, { y: 3, panel: 1 }, { x: 3, y: 4, panel: 3, draw: 'points' }, { panel: 3, x: 3, y: 1 }]) };
    const fig = builderFigure(state);
    expect(fig.layout).toEqual({ rows: 2, cols: 2 });
    expect([fig.sharex, fig.sharey, fig.xLabel]).toEqual(['none', undefined, '']);
    expect(fig.panels.map((p) => [p.id, p.row, p.col, p.name, p.xLabel, p.yLabel, p.series.length])).toEqual([
      ['panel1', 0, 0, 'row 1, column 1', 'time (s)', 'signal', 1], ['panel2', 0, 1, 'row 1, column 2', 'time (s)', 'lower', 1], ['panel4', 1, 1, 'row 2, column 2', 'lower', 'upper', 2]]);
    const n = normaliseFigure(fig);
    expect(n.panels.map((p) => [p.row, p.col])).toEqual([[0, 0], [0, 1], [1, 1]]);
    expect(isStack(n)).toBe(false);
    // More rows than asked for when a series is further down; fewer columns move nothing here.
    expect(builderFigure({ ...state, layout: { rows: 1, cols: 2 } }).layout).toEqual({ rows: 2, cols: 2 });
    expect(builderFigure({ ...state, layout: { rows: 3, cols: 2, sharex: 'col', sharey: 'row' } })).toMatchObject({ layout: { rows: 3, cols: 2 }, sharex: 'col', sharey: 'row' });
    // Names along x belong to the panels that share the axis: each panel's own, a column's, or everyone's.
    const boxes = (layout) => builderFigure({ files: [groups], layout, series: [
      { id: 'a', fileId: 'g.csv', chart: 'box', y: 2, groupBy: 0, panel: 0 }, { id: 'b', fileId: 'g.csv', chart: 'box', y: 3, groupBy: 1, panel: 1 }, { id: 'c', fileId: 'g.csv', chart: 'violin', y: 3, groupBy: 1, panel: 2 }] });
    const own = boxes({ rows: 2, cols: 2 });
    expect(own.xCategories).toBeUndefined();
    expect(own.panels.map((p) => p.xCategories)).toEqual([['A', 'B', 'C'], ['x', 'y'], ['x', 'y']]);
    expect(boxes({ rows: 2, cols: 2, sharex: 'col' }).panels.map((p) => p.xCategories)).toEqual([['A / x', 'B / y', 'C'], ['x', 'y'], ['A / x', 'B / y', 'C']]);
    expect(boxes({ rows: 2, cols: 2, sharex: 'all' }).panels.map((p) => p.xCategories)).toEqual(Array.from({ length: 3 }, () => ['A / x', 'B / y', 'C']));
    expect(normaliseFigure(own).panels.map((p) => p.series[0].groups.map((g) => g.position))).toEqual([[0, 1, 2], [0, 1], [0, 1]]);
  });

  test('an inset: a panel inside the panel of a cell, with the series that name it', () => {
    const layout = { insets: [{ id: 'inset1', parent: 0, x: 0.5, y: 0.5, w: 0.45, h: 0.4, zoom: true, xLim: [2, 4], yLim: [null, null] }, { id: 'unused', parent: 0 }] };
    const fig = builderFigure({ files: [t], layout, series: series([{}, { panel: 'inset1', label: '' }, { panel: 'nowhere', y: 3 }]) });
    expect(fig.panels.map((p) => [p.id, p.series.map((q) => q.id)])).toEqual([['panel1', ['s1', 's3']], ['inset1', ['s2']]]);
    expect(fig.panels[1]).toMatchObject({ name: 'inset 1', xLabel: '', yLabel: '', xLim: [2, 4], inset: { parent: 'panel1', x: 0.5, y: 0.5, w: 0.45, h: 0.4, zoom: true } });
    expect(fig.panels[1].yLim).toBeUndefined();
    expect([fig.sharex, fig.xLabel, fig.panels[0].xLabel, fig.panels[0].yLabel]).toEqual(['all', '', 'time (s)', 'signal']);
    const n = normaliseFigure(fig);
    expect(n.panels[1].inset).toMatchObject({ parentIndex: 0, zoom: true });
    expect(n.panels[1].series[0].label).toBe('');
    // In the cell it names, when that cell is in use; else in the first panel.
    const two = (parent) => builderFigure({ files: [t], layout: { cols: 2, insets: [{ id: 'i', parent }] }, series: series([{}, { panel: 1 }, { panel: 'i' }]) }).panels[2].inset.parent;
    expect([two(1), two(0), two(3)]).toEqual(['panel2', 'panel1', 'panel1']);
    // The figure's letters and gap come with the style, as any look does.
    const styled = normaliseFigure(applyStyle(fig, { panelGap: { h: 0 }, panelLabels: { show: true } }));
    expect(panelLetters(styled)).toEqual(['(a)', '']);
    expect(pythonFiles({ files: [t], layout, series: series([{}, { panel: 'inset1' }]) })).toEqual({ run: { file: 'run.csv', format: 'csv' } });
  });

  test('the layout examples: a grid with letters and shared axes, spectra with no gap, a zoomed inset', () => {
    const of = (id) => { const st = exampleState(id); return { st, ex: builderExample(id), f: normaliseFigure(applyStyle(builderFigure(st), st.style)) }; };
    const grid = of('grid');
    expect(grid.st.layout).toEqual({ rows: 2, cols: 2, sharex: 'col', sharey: 'row' });
    expect(grid.f.layout).toMatchObject({ rows: 2, cols: 2 });
    expect(grid.f.panels.map((p) => [p.row, p.col, p.shareX, p.shareY, p.xOuter, p.yOuter])).toEqual([[0, 0, 0, 0, false, true], [0, 1, 1, 0, false, false], [1, 0, 0, 2, true, true], [1, 1, 1, 2, true, false]]);
    expect(panelLetters(grid.f)).toEqual(['(a)', '(b)', '(c)', '(d)']);
    expect(grid.f.panelLabels.position).toBe('outside');
    expect(grid.f.panels.map((p) => [p.xLabel, p.yLabel, p.series[0].label])).toEqual([10, 20, 30, 40].map((c) => ['Time (min)', 'Substrate (mM)', `${c} °C`]));
    const spectra = of('stacked-spectra');
    expect(spectra.st.layout).toBeUndefined();
    expect(isStack(spectra.f)).toBe(true);
    expect(spectra.f.panelGap).toEqual({ h: 0, w: null });
    expect(panelEdges(spectra.f).map((e) => [e.top, e.bottom])).toEqual([[false, true], [true, true], [true, false]]);
    expect(spectra.f.panels.map((p) => p.series[0].label)).toEqual(['Calcite', 'Aragonite', 'Dolomite']);
    const inset = of('inset');
    expect(inset.f.panels.map((p) => !!p.inset)).toEqual([false, true]);
    expect(inset.f.panels[1]).toMatchObject({ xLim: [0, 6], yLim: [0.25, 1], inset: { parentIndex: 0, zoom: true } });
    // The inset shows the same curve in the same colour; one line needs no legend.
    expect(inset.f.panels[1].series[0].color).toBe(inset.f.panels[0].series[0].color);
    expect(inset.f.panels[0].legend.show).toBe(false);
    // The bars stacked to 100% fill their panel: the legend stands beside it.
    const bars = of('stacked-bars');
    expect(bars.ex.style).toEqual({ panels: [{ legend: { position: 'outside right' } }] });
    expect(bars.f.panels[0].legend.position).toBe('outside right');
    const drawn = buildFigure(bars.f);
    expect(drawn.info.legends).toEqual(['outside right']);
    expect(drawn.info.legendBox.l).toBeGreaterThan(drawn.info.axes[0].r);
    // An example's style names its series as exampleState does.
    for (const e of EXAMPLES) {
      const st = exampleState(e.id);
      for (const id of Object.keys((st.style && st.style.series) || {})) expect([e.id, st.series.some((q) => q.id === id)]).toEqual([e.id, true]);
    }
  });

  withPython('a grid with shared axes, a colour bar, a right axis and an inset runs from the files and with the numbers in it', async () => {
    const grid = 'x,y,z\n' + [0, 1, 2].flatMap((x) => [0, 1].map((y) => `${x},${y},${x + 2 * y}`)).join('\n') + '\n';
    const files = [t, fileOf('grid.csv', grid)];
    const state = {
      files,
      layout: { rows: 2, cols: 2, sharex: 'col', insets: [{ id: 'inset1', parent: 0, x: 0.5, y: 0.5, w: 0.45, h: 0.4, zoom: true, xLim: [2, 4], yLim: [1.5, 3] }] },
      series: [
        { id: 's1', fileId: 'run.csv', x: 0, y: 1, draw: 'line', panel: 0 },
        { id: 's2', fileId: 'run.csv', x: 0, y: 2, draw: 'points', panel: 0, yAxis: 'right' },
        { id: 's3', fileId: 'grid.csv', chart: 'heatmap', x: 0, y: 1, z: 2, panel: 1 },
        { id: 's4', fileId: 'run.csv', x: 0, y: 3, y2: 4, draw: 'band', panel: 2 },
        { id: 's5', fileId: 'run.csv', x: 0, y: 1, draw: 'line', panel: 'inset1', label: '' }
      ]
    };
    const desc = applyStyle(builderFigure(state), { panelGap: { h: 0, w: 8 }, panelLabels: { show: true }, legend: { position: 'upper right' }, export: { format: 'png' }, dpi: 50 });
    const info = buildFigure(desc).info;
    expect(info.insets).toEqual([-1, -1, -1, 0]);
    expect(info.edges.map((e) => e && Object.keys(e).filter((k) => e[k]))).toEqual([['bottom'], null, ['top'], null]);
    const out = [];
    try {
      for (const data of ['files', 'embed']) {
        const script = figureScript(desc, { data, files: pythonFiles(state) });
        expect(/read_csv/.test(script)).toBe(data === 'files');
        expect(script).toContain("fig = plt.figure(figsize=(3.5, 2.6), layout='constrained', facecolor='#ffffff')");
        expect(script).toContain('ax_panel3 = fig.add_subplot(grid[1, 0], sharex=ax)');
        expect(script).toContain('ax_inset1 = ax_right.inset_axes([0.5, 0.5, 0.45, 0.4])');
        const r = await run(script, data === 'files' ? { 'run.csv': RUN_CSV, 'grid.csv': grid } : {});
        out.push(r);
        expect([data, r.code, r.stderr]).toEqual([data, 0, '']);
        // The panels, then the right axis of the first; the colour bar after; the inset inside the first.
        const views = info.views.filter((v, i) => info.insets[i] < 0);
        const want = [...views.map((v) => [v.x, v.y]), [views[0].x, views[0].y2], null, [info.views[3].x, info.views[3].y]];
        const have = [...r.fig.panels, ...r.fig.insets];
        expect(have).toHaveLength(6);
        have.forEach((p, i) => {
          if (!want[i]) return;
          const [x, y] = want[i];
          const ok = [...p.xlim.map((v, k) => close(v, x.view[k])), ...p.ylim.map((v, k) => close(v, y.view[k]))].every(Boolean);
          if (!ok) throw new Error(`${data} axes ${i}: matplotlib x ${p.xlim} y ${p.ylim}, preview x ${x.view} y ${y.view}`);
        });
        // Down the first column the x axis is one.
        expect(r.fig.panels[0].xlim).toEqual(r.fig.panels[2].xlim);
        expect(r.fig.insets[0]).toMatchObject({ xlim: [2, 4], ylim: [1.5, 3], lines: 1 });
      }
    } finally {
      for (const r of out) rmSync(r.dir, { recursive: true, force: true });
    }
  }, 120000);
});
