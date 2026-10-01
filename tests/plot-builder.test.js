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
  builderFigure, builderLook, pythonFiles, seriesNote, houseStyle
} from '../src/core/plot-builder.js';
import { figureScript } from '../src/core/figure-python.js';
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
