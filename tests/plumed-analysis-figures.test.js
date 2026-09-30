/*
 * The figures of the "Analyse a run" view (src/core/plumed-analysis-figures.js)
 * and the Python written for them. The scripts are run on PLUMED's own files
 * (tests/fixtures/plumed) when Python with numpy and matplotlib is installed:
 * the numbers they compute from COLVAR and HILLS are the page's, to 1e-9, and
 * the axis limits matplotlib picks are the preview's (js/figure-plot.js).
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseColvar, poolRuns, sumHills, fesOverTime, reweight, thermalEnergy, valueColumns, biasColumn, biasColumns, totalBias,
  suggestBias
} from '../src/core/plumed-analysis.js';
import {
  PYTHON_FUNCTIONS, ANALYSIS_FIGURES, EMBED_POINTS, availableFigures, analysisFigure, analysisScript, analysisData,
  stripRefs, decimate, rampColours
} from '../src/core/plumed-analysis-figures.js';
import { normaliseFigure } from '../src/core/figure.js';
import { buildFigure } from '../js/figure-plot.js';
import { composeStyle, decomposeStyle, cannotBeNegative, analysisNote } from '../js/script-generator-plumed-analyse.js';
import { findTarget } from '../js/script-generator-plumed-model.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, 'fixtures', 'plumed');
const text = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const read = (name) => parseColvar(text(name), { keepOverlap: false });

const PYTHON = (() => {
  try {
    return spawnSync('python3', ['-c', 'import numpy, matplotlib'], { encoding: 'utf8', timeout: 60000 }).status === 0;
  } catch {
    return false;
  }
})();
const withPython = PYTHON ? test : test.skip;

/* PLUMED itself, when it is installed (PLUMED, PATH, then /opt/bin/plumed). */
const PLUMED = (() => {
  for (const exe of [process.env.PLUMED, 'plumed', '/opt/bin/plumed'].filter(Boolean)) {
    try {
      if (spawnSync(exe, ['info', '--version'], { encoding: 'utf8', timeout: 30000 }).status === 0) return exe;
    } catch {
      /* not this one */
    }
  }
  return null;
})();
const withPlumed = PLUMED ? test : test.skip;

/* ------------------------------------------------------------------ *
 * The functions are analyse_plumed.py's, word for word
 * ------------------------------------------------------------------ */

function pythonFunction(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`def ${name}(`));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !(lines[end].trim() && !/^\s/.test(lines[end]))) end++;
  const block = lines.slice(start, end);
  while (block.length && !block[block.length - 1].trim()) block.pop();
  return block.join('\n');
}

describe('the Python is analyse_plumed.py\'s', () => {
  test('every function is the one in assets/plumed/analyse_plumed.py', () => {
    const cli = fs.readFileSync(path.join(here, '..', 'assets', 'plumed', 'analyse_plumed.py'), 'utf8');
    for (const [name, code] of Object.entries(PYTHON_FUNCTIONS)) expect([name, code]).toEqual([name, pythonFunction(cli, name)]);
    expect(Object.keys(PYTHON_FUNCTIONS)).toEqual(expect.arrayContaining(['parse_colvar', 'pool', 'sum_hills', 'fes_over_time', 'hill_heights', 'reweight']));
  });
});

/* ------------------------------------------------------------------ *
 * Reading: restarts and walkers, as analyse_plumed.py reads them
 * ------------------------------------------------------------------ */

const partA = Array.from({ length: 11 }, (_, t) => `${t} ${t / 10}`).join('\n');
const partB = Array.from({ length: 5 }, (_, i) => `${i + 8} ${5 + (i + 8) / 10}`).join('\n');
const KILLED = `#! FIELDS time d\n${partA}\n#! FIELDS time d\n${partB}\n`;

describe('parseColvar, restarted runs', () => {
  test('by default every row is kept, as before', () => {
    const c = parseColvar(KILLED);
    expect(c.rows).toBe(16);
    expect(c.dropped).toBe(0);
    expect(c.parts).toBe(2);
  });

  test('a part that starts from an earlier checkpoint replaces the older copy', () => {
    const c = parseColvar(KILLED, { keepOverlap: false });
    expect(c).toMatchObject({ rows: 13, dropped: 3, parts: 2, starts: [0, 8] });
    expect(c.columns.time[7]).toBe(7);
    expect(c.columns.d[8]).toBeCloseTo(5.8, 12);
    expect(c.errors[0]).toContain('3 rows written again');
  });

  test('a clean restart writes its first row twice; the newer copy is kept', () => {
    const c = parseColvar('#! FIELDS time d\n0 0\n1 1\n2 2\n#! FIELDS time d\n2 20\n3 3\n', { keepOverlap: false });
    expect(c).toMatchObject({ rows: 4, dropped: 1, parts: 2 });
    expect(Array.from(c.columns.d)).toEqual([0, 1, 20, 3]);
  });

  test('time going back with no new header is a new part too', () => {
    expect(parseColvar('#! FIELDS time d\n0 0\n1 1\n2 2\n1 9\n2 9\n', { keepOverlap: false }))
      .toMatchObject({ rows: 3, dropped: 2, parts: 2 });
  });

  test('walkers sharing one HILLS file write the same time; nothing is dropped', () => {
    const rows = [];
    for (let t = 0; t < 5; t++) for (let w = 0; w < 3; w++) rows.push(`${t} ${0.1 * w} 0.1 1 -1`);
    expect(parseColvar(`#! FIELDS time d sigma_d height biasf\n${rows.join('\n')}\n`, { keepOverlap: false }))
      .toMatchObject({ rows: 15, dropped: 0, parts: 1 });
  });

  test('a last line cut off mid-write is left out, and said', () => {
    const c = parseColvar('#! FIELDS time d e\n0 1 2\n1 1 2\n2 1', { keepOverlap: false });
    expect(c).toMatchObject({ rows: 2, skipped: 1, cut: true });
    expect(c.errors.join(' ')).toContain('cut off mid-write');
    expect(parseColvar('#! FIELDS time d e\n0 1 2\n1 1 nan').cut).toBe(false);
  });
});

/* Two walkers: one run's hills dealt alternately into two files. */
function walkers(name) {
  const lines = text(name).split('\n');
  const head = lines.filter((l) => l.startsWith('#'));
  const rows = lines.filter((l) => l.trim() && !l.startsWith('#'));
  return [0, 1].map((w) => [...head, ...rows.filter((_, i) => i % 2 === w), ''].join('\n'));
}

describe('poolRuns', () => {
  test('the walkers\' hills in time order sum to the one run\'s surface', () => {
    const [a, b] = walkers('HILLS_dt').map((t) => parseColvar(t, { keepOverlap: false }));
    const pooled = poolRuns([a, b], ['HILLS.0', 'HILLS.1']);
    expect(pooled).toMatchObject({ rows: 121, walkers: 2, name: 'HILLS.0, HILLS.1' });
    const one = read('HILLS_dt');
    expect(Array.from(pooled.columns.time)).toEqual(Array.from(one.columns.time));
    expect(Array.from(sumHills(pooled, { bins: 40 }).f)).toEqual(Array.from(sumHills(one, { bins: 40 }).f));
  });

  test('files of other columns are not pooled', () => {
    expect(poolRuns([read('HILLS_d'), read('HILLS_dt')])).toBeNull();
    const one = read('HILLS_d');
    expect(poolRuns([one])).toBe(one);
  });
});

/* ------------------------------------------------------------------ *
 * The figures
 * ------------------------------------------------------------------ */

const COLVAR = read('COLVAR');
const HILLS_DT = read('HILLS_dt');
const HILLS_D = read('HILLS_d');
const HILLS_T = read('HILLS_t');
const COLVAR_WALL = read('COLVAR_wall');
const HILLS_ADAPTIVE = read('HILLS_adaptive');
const HILLS_RESTART = read('HILLS_restart');
const colvarRun = { colvar: COLVAR, colvarFile: 'COLVAR' };
const hillsRun = (hills, files = ['HILLS']) => ({ hills, hillsFiles: files });

describe('the figures a run can show', () => {
  test('a COLVAR with a bias, hills, or both', () => {
    expect(availableFigures(colvarRun)).toEqual(['series', 'histogram', 'reweight']);
    expect(availableFigures(hillsRun(HILLS_D))).toEqual(['fes', 'convergence', 'heights']);
    expect(availableFigures({ ...colvarRun, ...hillsRun(HILLS_DT) })).toEqual(ANALYSIS_FIGURES.map((f) => f.id));
    const unbiased = parseColvar('#! FIELDS time d\n0 1\n1 2\n2 3\n');
    expect(availableFigures({ colvar: unbiased })).toEqual(['series', 'histogram']);
    expect(analysisFigure('fes', colvarRun)).toBeNull();
  });

  test('the time series: a panel for each value and the bias, sharing time', () => {
    const a = analysisFigure('series', colvarRun, { timeUnit: 'ns' });
    expect(a.options.columns).toEqual(['d', 't', 'm3.rbias']);
    expect(a.figure.xLabel).toBe('Time (ns)');
    expect(a.figure.panels.map((p) => p.yLabel)).toEqual(['d', 't', 'm3.rbias']);
    // Ids keep to letters, digits, _ and -, as saved looks are keyed by them.
    expect(a.figure.panels.map((p) => p.series[0].id)).toEqual(['trace-d', 'trace-t', 'trace-m3_rbias']);
    expect(a.panelKeys).toEqual(['d', 't', 'm3.rbias']);
    expect(a.figure.panels[2].series[0].y.py).toBe('m3_rbias');
    expect(a.python.prelude).toContain("m3_rbias = colvar['columns']['m3.rbias']");
    const b = analysisFigure('series', colvarRun, { columns: ['m3.bias', 'nope'] });
    expect(b.options.columns).toEqual(['m3.bias']);
    expect(b.figure.height).toBe(3.2);
  });

  test('reweighting leaves out the first fifth with a plain bias', () => {
    const a = analysisFigure('reweight', colvarRun, {});
    expect(a.result).toMatchObject({ bias: 'm3.rbias', skip: 0, frames: 300 });
    const noR = parseColvar(text('COLVAR').split('\n').map((l) => (l.startsWith('#! FIELDS') ? l.replace(' m3.rbias', '') : l.startsWith('#') ? l : l.trim().split(/\s+/).slice(0, 4).join(' '))).join('\n'));
    expect(biasColumn(noR)).toBe('m3.bias');
    const b = analysisFigure('reweight', { colvar: noR }, {});
    expect(b.result).toMatchObject({ bias: 'm3.bias', skip: 60, frames: 240 });
    expect(b.python.prelude).toContain("skip = int(math.floor(colvar['rows'] * 0.2))");
  });

  test('the free energy over two variables is a heatmap with contour lines and a colour bar', () => {
    const a = analysisFigure('fes', hillsRun(HILLS_DT), { energy: 'kcal/mol' });
    const [map, lines] = a.figure.panels[0].series;
    expect(map).toMatchObject({ kind: 'heatmap', colorbar: { label: 'Free energy (kcal/mol)' } });
    expect(lines).toMatchObject({ kind: 'contour', show: true });
    expect(map.z.values).toHaveLength(100);
    expect(map.z.values[0]).toHaveLength(100);
    // z[j][i] at x[i], y[j]: the core's f[i][j].
    expect(map.z.values[7][3]).toBe(a.result.f[3 * 100 + 7]);
    expect(analysisFigure('fes', hillsRun(HILLS_DT), { contours: false }).figure.panels[0].series[1].show).toBe(false);
    const one = analysisFigure('fes', hillsRun(HILLS_DT), { along: ['t'] });
    expect(one.styleKey).toBe('fes-1d');
    expect(one.figure.xLabel).toBe('t');
  });

  test('the surface through the run: faint to strong, a titled legend', () => {
    const a = analysisFigure('convergence', hillsRun(HILLS_D), { slices: 4 });
    expect(a.figure.legend.title).toBe('Hills summed');
    expect(a.figure.panels[0].series.map((s) => s.color)).toEqual(rampColours(4));
    expect(a.figure.panels[0].series[3].lineWidth).toBe(2.5);
    expect(a.result.change).toBeGreaterThan(0);
  });

  test('along one variable of two, the other is integrated out at the run\'s kT', () => {
    // The hills summed along d alone gave 50.5 kJ/mol where sum_hills --idw d
    // gives 19.3: each hill counted in full whatever its t.
    const kT = thermalEnergy(310, 'kcal/mol');
    const a = analysisFigure('fes', hillsRun(HILLS_DT), { along: ['d'], temperature: 310, energy: 'kcal/mol' });
    expect(a.title).toBe('Free energy along d, t integrated out');
    expect(a.result).toMatchObject({ integrated: ['t'], kT });
    expect(Array.from(a.result.f)).toEqual(Array.from(sumHills(HILLS_DT, { variables: ['d'], bins: 300, kT }).f));
    expect(a.python.prelude).toContain("fes = sum_hills(hills, ['d'], 300, kT=kT)");
    expect(a.python.prelude).toContain('TEMPERATURE = 310  # K');
    const data = parseColvar(analysisData(a).text);
    expect(data.sets).toMatchObject({ integrated: 't' });
    expect(Number(data.sets.kT)).toBeCloseTo(kT, 12);
    // Both variables: nothing to integrate, and no kT in the script.
    const two = analysisFigure('fes', hillsRun(HILLS_DT));
    expect(two.result.integrated).toEqual([]);
    expect(two.python.prelude.join('\n')).not.toContain('kT=kT');
  });

  test('the surface through the run, along one variable of two, is integrated the same way', () => {
    const a = analysisFigure('convergence', hillsRun(HILLS_DT), { variable: 'd' });
    expect(a.title).toBe('The surface along d through the run, t integrated out');
    const slices = fesOverTime(HILLS_DT, { variable: 'd', slices: 5, bins: 300, kT: thermalEnergy(300) });
    a.result.slices.forEach((x, k) => expect(Array.from(x.f)).toEqual(Array.from(slices[k].f)));
    // Summed along d alone it seemed to move by 10.1 kJ/mol over the last fifth.
    expect(a.result.change).toBeLessThan(3);
    expect(a.python.prelude).toContain("slices = fes_over_time(hills, 'd', 5, 300, kT=kT)");
    expect(analysisData(a).text).toContain('#! SET integrated t');
  });

  test('reweighting weighs each frame with every bias: the METAD\'s rbias and the wall', () => {
    const run = { colvar: COLVAR_WALL, colvarFile: 'COLVAR_wall' };
    const a = analysisFigure('reweight', run, { column: 'd' });
    expect(a.result).toMatchObject({ bias: 'metad.rbias + uw.bias', biases: ['metad.rbias', 'uw.bias'], skip: 0 });
    const kT = thermalEnergy(300);
    const both = reweight(COLVAR_WALL.columns.d, totalBias(COLVAR_WALL, biasColumns(COLVAR_WALL)), { kT, bins: 60 });
    expect(Array.from(a.result.f)).toEqual(Array.from(both.f));
    const alone = reweight(COLVAR_WALL.columns.d, COLVAR_WALL.columns['metad.rbias'], { kT, bins: 60 });
    const apart = Array.from(both.f).map((f, k) => Math.abs(f - alone.f[k])).filter(Number.isFinite);
    expect(Math.max(...apart)).toBeGreaterThan(1);
    expect(a.python.prelude).toContain("bias_total = total_bias(colvar, ['metad.rbias', 'uw.bias'])");
    expect(a.python.header[0]).toContain('reweighted with metad.rbias + uw.bias');
  });

  test('multivariate hills (ADAPTIVE) have their figures', () => {
    expect(availableFigures(hillsRun(HILLS_ADAPTIVE))).toEqual(['fes', 'convergence', 'heights']);
    const a = analysisFigure('fes', hillsRun(HILLS_ADAPTIVE));
    expect(a.title).toBe('Free-energy surface over d and t');
    expect(a.result.max).toBeGreaterThan(0);
  });

  test('a restarted HILLS file: every hill in the surface', () => {
    expect(HILLS_RESTART).toMatchObject({ rows: 118, dropped: 0, overlap: 19 });
    expect(analysisFigure('fes', hillsRun(HILLS_RESTART)).result.hills).toBe(118);
  });

  test('the numbers behind a figure, to download', () => {
    const fes = analysisData(analysisFigure('fes', hillsRun(HILLS_D)));
    expect(fes.filename).toBe('fes.dat');
    expect(parseColvar(fes.text).rows).toBe(300);
    const two = parseColvar(analysisData(analysisFigure('fes', hillsRun(HILLS_DT))).text);
    expect(two.fields).toEqual(['d', 't', 'file.free']);
    expect(two.rows).toBe(10000);
    expect(analysisData(analysisFigure('convergence', hillsRun(HILLS_D))).text).toContain(`#! SET hills_5 ${HILLS_D.rows}`);
    expect(analysisData(analysisFigure('series', colvarRun))).toBeNull();
  });
});

describe('the data in the script', () => {
  test('a long line is thinned to its extremes, and a large histogram written as counts', () => {
    const n = 100000;
    const x = Array.from({ length: n }, (_, i) => i * 0.002);
    const y = x.map((v) => Math.sin(v) + (v === 100 ? 5 : 0));
    const d = decimate(x, y, EMBED_POINTS);
    expect(d.thinned).toBe(true);
    expect(d.x.length).toBeLessThanOrEqual(EMBED_POINTS + 4);
    expect(Math.max(...d.y)).toBe(Math.max(...y));
    expect(d.x[0]).toBe(0);
    expect(d.x[d.x.length - 1]).toBe(x[n - 1]);
    const fig = normaliseFigure({ panels: [{ series: [
      { id: 'l', kind: 'line', x: { values: x, py: 'x' }, y: { values: y, py: 'y' } },
      { id: 'h', kind: 'histogram', values: { values: y, py: 'y' }, bins: 20 }
    ] }] });
    const { figure, thinned } = stripRefs(fig);
    expect(thinned).toBe(true);
    expect(figure.panels[0].series[0].x.length).toBeLessThanOrEqual(EMBED_POINTS);
    expect(figure.panels[0].series[1].values).toBeNull();
    expect(figure.panels[0].series[1].counts).toEqual(fig.panels[0].series[1].counts);
    const script = analysisScript(fig, 'embed', { header: ['A test'] });
    expect(script).toContain('thinned');
    expect(script).not.toContain('colvar');
  });
});

describe('the look follows the data', () => {
  test('labels by what the figure is along, panels by what they show', () => {
    const styles = {};
    const a = analysisFigure('series', colvarRun, { columns: ['d', 't'] });
    decomposeStyle(styles, a, { width: 5, xLabel: 'Time / ps', panels: [{ yLabel: '$d$ (nm)' }, { yLim: [-4, 4] }] });
    const b = analysisFigure('series', colvarRun, { columns: ['t', 'm3.rbias'] });
    expect(composeStyle(styles, b)).toEqual({ width: 5, xLabel: 'Time / ps', panels: [{ yLim: [-4, 4] }, {}] });
    const h = analysisFigure('histogram', colvarRun, { column: 'd' });
    decomposeStyle(styles, h, { height: 3, xLabel: 'Distance', series: { hist: { color: '#000000', label: 'x' } } });
    const g = analysisFigure('histogram', colvarRun, { column: 't' });
    expect(composeStyle(styles, g)).toEqual({ height: 3, series: { hist: { color: '#000000' } } });
    expect(composeStyle(styles, h)).toEqual({ height: 3, xLabel: 'Distance', series: { hist: { color: '#000000', label: 'x' } } });
    decomposeStyle(styles, h, {});
    expect(composeStyle(styles, h)).toEqual({});
  });
});

/* ------------------------------------------------------------------ *
 * What the page says and suggests (js/script-generator-plumed-analyse.js)
 * ------------------------------------------------------------------ */

describe('the grid the page suggests', () => {
  test('a distance cannot be negative; the components of DISTANCE can', () => {
    expect(cannotBeNegative({ arg: 'd', type: 'DISTANCE' })).toBe(true);
    expect(cannotBeNegative({ arg: 'c', type: 'COORDINATION' })).toBe(true);
    expect(cannotBeNegative({ arg: 'dd.mean', type: 'DISTANCES' })).toBe(true);
    for (const arg of ['d.x', 'd.y', 'd.z', 'd.a', 'd.b', 'd.c']) {
      expect([arg, cannotBeNegative({ arg, type: 'DISTANCE' })]).toEqual([arg, false]);
    }
    expect(cannotBeNegative({ arg: 't', type: 'TORSION' })).toBe(false);
    // Global Steinhardt parameters are norms; the local ones run from -1 to 1.
    expect(cannotBeNegative({ arg: 'q6.mean', type: 'Q6' })).toBe(true);
    for (const type of ['LOCAL_Q3', 'LOCAL_Q4', 'LOCAL_Q6']) {
      expect([type, cannotBeNegative({ arg: 'lq.mean', type })]).toEqual([type, false]);
    }
    expect(cannotBeNegative(undefined)).toBe(false);
  });

  test('a component seen only above zero is padded below as any variable is, not floored', () => {
    // A trial run that happened to keep d.x between 0.01 and 0.09 nm: marked
    // non-negative, its grid stopped five widths below zero.
    const values = Array.from({ length: 400 }, (_, i) => 0.05 + 0.04 * Math.sin(i * 0.7));
    const floored = suggestBias(values, { nonNegative: true });
    expect(Number(floored.min)).toBeCloseTo(-5 * Number(floored.sigma), 12);
    // The builder names the value d.x; PLUMED 2.10 heads its column d_x.
    const targets = [{ arg: 'd.x', type: 'DISTANCE' }];
    for (const column of ['d.x', 'd_x']) {
      const s = suggestBias(values, { nonNegative: cannotBeNegative(findTarget(targets, column)) });
      expect(s).toEqual(suggestBias(values, {}));
      expect(Number(s.min)).toBeLessThan(Number(floored.min));
      expect(s.notes.join(' ')).not.toContain('cannot be negative');
    }
    // The distance itself keeps its floor.
    const d = suggestBias(values, { nonNegative: cannotBeNegative({ arg: 'd', type: 'DISTANCE' }) });
    expect(d.min).toBe(floored.min);
  });
});

describe('the note under a figure', () => {
  const code = (s) => `<code>${s}</code>`;
  const say = (unit = 'kJ/mol') => ({ unit, temperature: '300', code, count: (n) => String(n) });

  test('the free energy along one variable of two names the sum_hills call that gives it', () => {
    const a = analysisFigure('fes', hillsRun(HILLS_DT), { along: ['d'] });
    const note = analysisNote(a, say());
    const kT = thermalEnergy(300);
    expect(note).toBe(`The ${HILLS_DT.rows} hills summed over <code>d</code> and <code>t</code>, with <code>t</code> ` +
      'integrated out at kT = 2.49 kJ/mol, as <code>plumed sum_hills --idw d --kt 2.49434</code> gives it, with its ' +
      `lowest point at zero; it reaches ${Number(a.result.max.toPrecision(3))} kJ/mol.`);
    expect(Number(note.match(/--kt ([\d.]+)/)[1])).toBeCloseTo(kT, 5);
    expect(note).not.toContain('negative sum');
    // In kcal/mol at 310 K the command carries that kT.
    const b = analysisFigure('fes', hillsRun(HILLS_DT), { along: ['t'], temperature: 310, energy: 'kcal/mol' });
    expect(analysisNote(b, say('kcal/mol'))).toContain(
      `with <code>d</code> integrated out at kT = 0.616 kcal/mol, as <code>plumed sum_hills --idw t --kt ${Number(thermalEnergy(310, 'kcal/mol').toPrecision(6))}</code> gives it`);
  });

  test('over every variable of the hills it is their negative sum, as plain sum_hills gives it', () => {
    const two = analysisFigure('fes', hillsRun(HILLS_DT));
    expect(analysisNote(two, say())).toMatch(new RegExp(`^The negative sum of all ${HILLS_DT.rows} hills, as ` +
      '<code>plumed sum_hills</code> gives it, with its lowest point at zero; it reaches [\\d.]+ kJ/mol\\. ' +
      'The colour bar gives the free energy; dark is low\\.$'));
    const one = analysisFigure('fes', hillsRun(HILLS_D));
    expect(analysisNote(one, say())).toMatch(/^The negative sum of all \d+ hills, as <code>plumed sum_hills<\/code> gives it, with its lowest point at zero; it reaches [\d.]+ kJ\/mol\.$/);
  });

  test('the surface through the run says what it integrated out', () => {
    const a = analysisFigure('convergence', hillsRun(HILLS_DT), { variable: 'd' });
    expect(analysisNote(a, say())).toMatch(/^Each line sums the hills up to a time, with <code>t<\/code> integrated out at kT = 2\.49 kJ\/mol; the darkest/);
    const b = analysisFigure('convergence', hillsRun(HILLS_D));
    expect(analysisNote(b, say())).toMatch(/^Each line sums the hills up to a time; the darkest/);
  });

  withPlumed('the command the note names gives the surface the page draws', () => {
    const a = analysisFigure('fes', hillsRun(HILLS_DT), { along: ['d'] });
    const command = analysisNote(a, say()).match(/<code>(plumed sum_hills [^<]+)<\/code>/)[1].split(' ');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-note-'));
    try {
      fs.writeFileSync(path.join(dir, 'HILLS'), text('HILLS_dt'));
      // The page's own grid along d, and PLUMED's default across t.
      const s = a.result;
      const r = spawnSync(PLUMED, [...command.slice(1), '--hills', 'HILLS', '--min', `${s.x[0]},-pi`,
        '--max', `${s.x[s.x.length - 1]},pi`, '--bin', `${s.x.length - 1},100`, '--outfile', 'idw.dat'],
      { cwd: dir, encoding: 'utf8', timeout: 120000 });
      expect(r.status).toBe(0);
      const ref = parseColvar(fs.readFileSync(path.join(dir, 'idw.dat'), 'utf8')).columns.projection;
      const min = Math.min(...ref);
      let worst = 0;
      ref.forEach((v, i) => { worst = Math.max(worst, Math.abs(v - min - s.f[i])); });
      // kT is written to six figures in the note.
      expect(worst).toBeLessThan(1e-4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});

/* ------------------------------------------------------------------ *
 * The scripts run, and compute and draw what the page does
 * ------------------------------------------------------------------ */

const INSPECT = (names) => String.raw`

# --- test only: what was computed and drawn ---
import json as _json
fig.canvas.draw()


def _list(a):
    return [None if v != v else float(v) for v in np.asarray(a, dtype=float).ravel()]


print('@@RUN@@' + _json.dumps({
    'numbers': {${Object.entries(names).map(([k, v]) => `${JSON.stringify(k)}: _list(${v})`).join(', ')}},
    'panels': [{'xlim': [float(v) for v in a.get_xlim()], 'ylim': [float(v) for v in a.get_ylim()],
                'legend': [t.get_text() for t in a.get_legend().get_texts()] if a.get_legend() else None}
               for a in fig.axes if a.get_label() != '<colorbar>'],
    'colorbars': [a.get_ylabel() for a in fig.axes if a.get_label() == '<colorbar>'],
}))
`;

function runScript(script, files, names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stemkit-plumed-fig-'));
  fs.writeFileSync(path.join(dir, 'figure.py'), script + INSPECT(names));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return new Promise((resolve) => {
    const child = spawn('python3', ['figure.py'], { cwd: dir, env: { ...process.env, MPLBACKEND: 'Agg' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      const line = stdout.split('\n').find((l) => l.startsWith('@@RUN@@'));
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ code, stdout, stderr, out: line ? JSON.parse(line.slice(7)) : null });
    });
  });
}

function previewRanges(fig) {
  const layout = buildFigure(fig).layout;
  return fig.panels.map((p, i) => [layout[i === 0 ? 'xaxis' : `xaxis${i + 1}`].range, layout[i === 0 ? 'yaxis' : `yaxis${i + 1}`].range]);
}
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
const flat = (v) => (Array.isArray(v) && Array.isArray(v[0]) ? v.flat() : Array.from(v));
function sameNumbers(label, got, want, tol = 1e-9) {
  expect([label, got.length]).toEqual([label, want.length]);
  got.forEach((g, i) => {
    const w = want[i];
    if (g === null || !Number.isFinite(w)) {
      if (!((g === null) && !Number.isFinite(w))) throw new Error(`${label}[${i}]: python ${g}, page ${w}`);
      return;
    }
    if (!close(g, w, tol)) throw new Error(`${label}[${i}]: python ${g}, page ${w}`);
  });
}

/* A COLVAR continued from an earlier checkpoint, cut off at the end. */
const RESTARTED = (() => {
  const lines = text('COLVAR').split('\n');
  const head = lines.filter((l) => l.startsWith('#'));
  const rows = lines.filter((l) => l.trim() && !l.startsWith('#'));
  const again = rows.slice(150, 200).map((l) => l.replace(/^(\S+) (\S+)/, (m, t, d) => `${t} ${(Number(d) + 0.05).toFixed(6)}`));
  return [...head, ...rows.slice(0, 180), ...head, ...again, ...rows.slice(200), '0.5 0.1'].join('\n');
})();

const [WALKER0, WALKER1] = walkers('HILLS_dt');

/* A run long enough for the page to thin its line. */
const LONG = `#! FIELDS time d\n${Array.from({ length: 60000 }, (_, i) => `${(i * 0.002).toFixed(3)} ${(0.5 + 0.1 * Math.sin(i / 700) + 0.03 * Math.sin(i * 1.7)).toFixed(6)}`).join('\n')}\n`;

/* Each case: the figure, the files the script reads, and what to compare. */
const CASES = {
  series: () => ({ a: analysisFigure('series', colvarRun), files: { COLVAR: text('COLVAR') }, names: { time: 'time', d: 'd', t: 't', bias: 'm3_rbias' } }),
  restarted: () => {
    const c = parseColvar(RESTARTED, { keepOverlap: false });
    return { a: analysisFigure('series', { colvar: c, colvarFile: 'colvar.dat' }, { columns: ['d'] }), files: { 'colvar.dat': RESTARTED }, names: { time: 'time', d: 'd' }, rows: c.rows };
  },
  histogram: () => ({ a: analysisFigure('histogram', colvarRun, { column: 't', bins: 40 }), files: { COLVAR: text('COLVAR') }, names: { counts: 'hist_counts', edges: 'hist_edges' } }),
  reweight: () => ({ a: analysisFigure('reweight', colvarRun, { column: 'd' }), files: { COLVAR: text('COLVAR') }, names: { x: "rw['x']", f: "rw['f']" } }),
  reweightPeriodic: () => ({ a: analysisFigure('reweight', colvarRun, { column: 't', energy: 'kcal/mol', temperature: 310, reweightBins: 30 }), files: { COLVAR: text('COLVAR') }, names: { x: "rw['x']", f: "rw['f']" } }),
  long: () => {
    const c = parseColvar(LONG, { keepOverlap: false });
    return { a: analysisFigure('series', { colvar: c, colvarFile: 'long.dat' }), files: { 'long.dat': LONG }, names: { d: 'd' }, column: c.columns.d };
  },
  fes2d: () => ({ a: analysisFigure('fes', hillsRun(HILLS_DT)), files: { HILLS: text('HILLS_dt') }, names: { x: "fes['x']", y: "fes['y']", z: 'fes_z' } }),
  walkers: () => {
    const pooled = poolRuns([WALKER0, WALKER1].map((t) => parseColvar(t, { keepOverlap: false })), ['HILLS.0', 'HILLS.1']);
    return { a: analysisFigure('fes', hillsRun(pooled, ['HILLS.0', 'HILLS.1'])), files: { 'HILLS.0': WALKER0, 'HILLS.1': WALKER1 }, names: { z: 'fes_z' } };
  },
  fes1d: () => ({ a: analysisFigure('fes', hillsRun(HILLS_D)), files: { HILLS: text('HILLS_d') }, names: { x: "fes['x']", f: "fes['f']" } }),
  fesPeriodic: () => ({ a: analysisFigure('fes', hillsRun(HILLS_T)), files: { HILLS: text('HILLS_t') }, names: { x: "fes['x']", f: "fes['f']" } }),
  convergence: () => ({ a: analysisFigure('convergence', hillsRun(HILLS_D)), files: { HILLS: text('HILLS_d') }, names: Object.fromEntries([0, 1, 2, 3, 4].map((k) => [`f${k}`, `slices[${k}]['f']`])) }),
  heights: () => ({ a: analysisFigure('heights', hillsRun(HILLS_D)), files: { HILLS: text('HILLS_d') }, names: { time: "heights['time']", height: "heights['height']" } }),
  fesProjected: () => ({ a: analysisFigure('fes', hillsRun(HILLS_DT), { along: ['d'] }), files: { HILLS: text('HILLS_dt') }, names: { x: "fes['x']", f: "fes['f']" } }),
  convergenceProjected: () => ({ a: analysisFigure('convergence', hillsRun(HILLS_DT), { variable: 't', slices: 3 }), files: { HILLS: text('HILLS_dt') }, names: { f0: "slices[0]['f']", f1: "slices[1]['f']", f2: "slices[2]['f']" } }),
  reweightWall: () => ({ a: analysisFigure('reweight', { colvar: COLVAR_WALL, colvarFile: 'COLVAR_wall' }, { column: 'd' }), files: { COLVAR_wall: text('COLVAR_wall') }, names: { x: "rw['x']", f: "rw['f']" } }),
  fesAdaptive: () => ({ a: analysisFigure('fes', hillsRun(HILLS_ADAPTIVE)), files: { HILLS: text('HILLS_adaptive') }, names: { x: "fes['x']", y: "fes['y']", z: 'fes_z' } }),
  fesAdaptiveProjected: () => ({ a: analysisFigure('fes', hillsRun(HILLS_ADAPTIVE), { along: ['t'] }), files: { HILLS: text('HILLS_adaptive') }, names: { x: "fes['x']", f: "fes['f']" } }),
  hillsRestart: () => ({ a: analysisFigure('fes', hillsRun(HILLS_RESTART)), files: { HILLS: text('HILLS_restart') }, names: { x: "fes['x']", f: "fes['f']" } }),
  heightsFlat: () => ({ a: analysisFigure('heights', hillsRun(HILLS_T)), files: { HILLS: text('HILLS_t') }, names: { height: "heights['height']" } })
};

/* What the page has for each name. */
function pageNumbers(name, c) {
  const f = normaliseFigure(c.a.figure);
  const s = f.panels[0].series;
  const q = (id) => f.panels.flatMap((p) => p.series).find((x) => x.id === id);
  switch (name) {
    case 'series': return { time: q('trace-d').x, d: q('trace-d').y, t: q('trace-t').y, bias: q('trace-m3_rbias').y };
    case 'restarted': return { time: s[0].x, d: s[0].y };
    case 'histogram': return { counts: s[0].counts, edges: s[0].edges };
    case 'reweight': case 'reweightPeriodic': case 'fes1d': case 'fesPeriodic': case 'fesProjected':
    case 'reweightWall': case 'fesAdaptiveProjected': case 'hillsRestart': return { x: s[0].x, f: s[0].y };
    case 'fes2d': case 'fesAdaptive': return { x: s[0].x, y: s[0].y, z: flat(s[0].z) };
    case 'convergenceProjected': return Object.fromEntries(s.map((x, k) => [`f${k}`, x.y]));
    case 'walkers': return { z: flat(analysisFigure('fes', hillsRun(HILLS_DT)).figure.panels[0].series[0].z.values) };
    case 'convergence': return Object.fromEntries(s.map((x, k) => [`f${k}`, x.y]));
    case 'heights': return { time: s[0].x, height: s[0].y };
    case 'heightsFlat': return { height: s[0].y };
    default: return {};
  }
}

const cases = Object.fromEntries(Object.entries(CASES).map(([k, make]) => [k, make()]));
const runs = {};
beforeAll(async () => {
  if (!PYTHON) return;
  const jobs = Object.entries(cases).flatMap(([name, c]) => {
    const fig = normaliseFigure(c.a.figure);
    return [
      () => runScript(analysisScript(fig, 'files', c.a.python), c.files, c.names).then((r) => { runs[name] = r; }),
      () => runScript(analysisScript(fig, 'embed', c.a.python), {}, {}).then((r) => { runs[`${name}:embed`] = r; })
    ];
  });
  // One at a time, so that the suites timed beside this one keep their pace.
  for (const job of jobs) await job();
}, 240000);

describe('the scripts', () => {
  withPython('run without errors or warnings, reading the files or holding the numbers', () => {
    for (const [name, r] of Object.entries(runs)) expect([name, r.code, r.stderr]).toEqual([name, 0, '']);
  });

  withPython('compute from COLVAR and HILLS the numbers the page computed', () => {
    for (const name of Object.keys(cases)) {
      const want = pageNumbers(name, cases[name]);
      for (const [k, got] of Object.entries(runs[name].out.numbers)) if (want[k]) sameNumbers(`${name}.${k}`, got, Array.from(want[k]));
    }
    // A long run: the page draws it thinned, the script reads every row.
    expect(cases.long.a.result.thinned).toBe(true);
    expect(cases.long.a.figure.panels[0].series[0].y.values.length).toBeLessThan(21000);
    sameNumbers('long.d', runs.long.out.numbers.d, Array.from(cases.long.column));
    // Restarted: the older copy of the rewritten rows dropped, the cut line left out.
    expect(runs.restarted.out.numbers.d).toHaveLength(cases.restarted.rows);
    expect(runs.restarted.stdout).toContain('rows written again by a later part of the run were dropped');
    expect(runs.restarted.stdout).toContain('cut off mid-write');
    expect(runs.reweight.stdout).toContain('300 frames carry the weight of');
    expect(runs.convergence.stdout).toMatch(/Over the last fifth of the run the surface moved by at most [\d.]+ kJ\/mol\./);
    // Restarted hills: every one kept, and said.
    expect(runs.hillsRestart.stdout).toContain('19 hills lie at or after the time where a later part of the file starts');
    expect(runs.hillsRestart.stdout).toContain('118 hills summed');
  });

  withPython('draw with the axis limits of the preview', () => {
    for (const name of Object.keys(cases)) {
      const fig = normaliseFigure(cases[name].a.figure);
      const want = previewRanges(fig);
      for (const r of [runs[name], runs[`${name}:embed`]]) {
        r.out.panels.forEach((p, i) => {
          const [x, y] = want[i];
          const ok = [...p.xlim.map((v, k) => close(v, x[k])), ...p.ylim.map((v, k) => close(v, y[k]))].every(Boolean);
          if (!ok) throw new Error(`${name} panel ${i + 1}: matplotlib x ${p.xlim} y ${p.ylim}, preview x ${x} y ${y}`);
        });
      }
    }
    expect(runs.fes2d.out.colorbars).toEqual(['Free energy (kJ/mol)']);
    expect(runs.convergence.out.panels[0].legend).toEqual(cases.convergence.a.figure.panels[0].series.map((s) => s.label));
    expect(runs.series.out.panels).toHaveLength(3);
  });
});

test('valueColumns and biasColumn', () => {
  expect(valueColumns(COLVAR)).toEqual(['d', 't']);
  expect(biasColumn(COLVAR)).toBe('m3.rbias');
  expect(biasColumn({ fields: ['time', 'd'] })).toBe('');
  expect(valueColumns(COLVAR_WALL)).toEqual(['d']);
});
