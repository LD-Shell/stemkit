/*
 * assets/plumed/analyse_plumed.py, the Python form of the Analyse view, run
 * on the same files as tests/plumed-analysis.test.js. The expected numbers
 * come from src/core/plumed-analysis.js and from PLUMED's own sum_hills, so
 * the script, the page and PLUMED stay in step.
 *
 * Needs python3 with numpy; without them the suite says so and is skipped.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  KB_KJMOL, parseColvar, suggestBias, driftOf, sumHills, fesOverTime, hillHeights, reweight, thermalEnergy,
  biasColumns, totalBias
} from '../src/core/plumed-analysis.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'assets', 'plumed', 'analyse_plumed.py');
const FIX = path.join(here, 'fixtures', 'plumed');
const fixture = (name) => path.join(FIX, name);
const readFixture = (name) => parseColvar(fs.readFileSync(fixture(name), 'utf8'));

const probe = spawnSync('python3', ['-c', 'import numpy'], { encoding: 'utf8' });
const HAVE_PYTHON = probe.status === 0;
const HAVE_MPL = HAVE_PYTHON &&
  spawnSync('python3', ['-c', 'import matplotlib'], { encoding: 'utf8' }).status === 0;

let tmp;
function run(args, { ok = true } = {}) {
  const r = spawnSync('python3', [SCRIPT, ...args], { encoding: 'utf8', cwd: tmp, timeout: 60000 });
  if (ok && r.status !== 0) throw new Error(`analyse_plumed.py ${args.join(' ')} failed:\n${r.stderr}`);
  return r;
}
/* A directory of its own for each call, so that files cannot be mixed up. */
let outN = 0;
function out() {
  outN += 1;
  return path.join(tmp, `out${outN}`);
}
const readOut = (dir, name) => parseColvar(fs.readFileSync(path.join(dir, name), 'utf8'));
const shifted = (values) => {
  let min = Infinity;
  for (const v of values) if (v < min) min = v;
  return Array.from(values, v => v - min);
};

const suite = HAVE_PYTHON ? describe : describe.skip;

if (!HAVE_PYTHON) {
  describe('analyse_plumed.py', () => {
    test.skip('needs python3 with numpy, which this machine does not have', () => {});
  });
}

suite('analyse_plumed.py', () => {
  beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-py-')); });
  afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  describe('fes against plumed sum_hills and the page', () => {
    test('one variable, well-tempered', () => {
      const dir = out();
      run(['fes', fixture('HILLS_d'), '--min', '0', '--max', '1.5', '--bins', '100', '--out', dir, '--no-plots', '--quiet']);
      const mine = readOut(dir, 'fes.dat');
      expect(mine.fields).toEqual(['d', 'file.free']);
      expect(mine.rows).toBe(100);
      const ref = shifted(readFixture('fes_d.dat').columns['file.free']);
      const js = sumHills(readFixture('HILLS_d'), { bins: 100, ranges: { d: { min: 0, max: 1.5 } } });
      mine.columns['file.free'].forEach((v, i) => {
        expect(Math.abs(v - ref[i])).toBeLessThan(1e-6);
        expect(Math.abs(v - js.f[i])).toBeLessThan(1e-6);
      });
      expect(mine.columns.d[99]).toBeCloseTo(1.5, 9);
    });

    test('one periodic variable', () => {
      const dir = out();
      run(['fes', fixture('HILLS_t'), '--bins', '60', '--out', dir, '--no-plots', '--quiet']);
      const mine = readOut(dir, 'fes.dat');
      const ref = shifted(readFixture('fes_t.dat').columns['file.free']);
      expect(mine.rows).toBe(60);
      expect(mine.sets.min_t).toBe('-pi');
      expect(mine.sets.periodic_t).toBe('true');
      mine.columns['file.free'].forEach((v, i) => expect(Math.abs(v - ref[i])).toBeLessThan(1e-6));
    });

    test('two variables, written as PLUMED writes them', () => {
      const dir = out();
      run(['fes', fixture('HILLS_dt'), '--bins', '30,20', '--min', '0', '--max', '1.5', '--out', dir, '--no-plots', '--quiet']);
      const mine = readOut(dir, 'fes.dat');
      const ref = readFixture('fes_dt.dat');
      expect(mine.fields).toEqual(['d', 't', 'file.free']);
      expect(mine.rows).toBe(600);
      // The first variable runs fastest, as in PLUMED's own file.
      const refF = shifted(ref.columns['file.free']);
      mine.columns['file.free'].forEach((v, i) => {
        expect(mine.columns.d[i]).toBeCloseTo(ref.columns.d[i], 8);
        expect(mine.columns.t[i]).toBeCloseTo(ref.columns.t[i], 8);
        expect(Math.abs(v - refF[i])).toBeLessThan(1e-6);
      });
    });

    test('the surface at earlier times and the hill heights match the page', () => {
      const dir = out();
      run(['fes', fixture('HILLS_d'), '--slices', '5', '--out', dir, '--no-plots', '--quiet']);
      const slices = readOut(dir, 'fes_slices.dat');
      const js = fesOverTime(readFixture('HILLS_d'), { slices: 5, bins: 300 });
      expect(slices.fields).toHaveLength(6);
      js.forEach((s, k) => {
        expect(Number(slices.sets[`hills_${k + 1}`])).toBe(s.hills);
        expect(Number(slices.sets[`time_${k + 1}`])).toBeCloseTo(s.time, 9);
        const col = slices.columns[`file.free.${k + 1}`];
        s.f.forEach((v, i) => expect(Math.abs(col[i] - v)).toBeLessThan(1e-6));
      });
      const heights = readOut(dir, 'hill_heights.dat');
      const h = hillHeights(readFixture('HILLS_d'));
      expect(Number(heights.sets.first)).toBeCloseTo(h.first, 8);
      expect(Number(heights.sets.last)).toBeCloseTo(h.last, 8);
      expect(Number(heights.sets.ratio)).toBeCloseTo(h.ratio, 8);
      expect(heights.rows).toBe(h.height.length);
    });

    test('several walkers are summed together, and a gzipped file is read', () => {
      // Split one run's hills between two files, as two walkers would write them.
      const text = fs.readFileSync(fixture('HILLS_d'), 'utf8').split('\n');
      const head = text.filter(l => l.startsWith('#'));
      const rows = text.filter(l => l.trim() && !l.startsWith('#'));
      fs.writeFileSync(path.join(tmp, 'HILLS.0'), [...head, ...rows.filter((_, i) => i % 2 === 0), ''].join('\n'));
      fs.writeFileSync(path.join(tmp, 'HILLS.1.gz'),
        zlib.gzipSync([...head, ...rows.filter((_, i) => i % 2 === 1), ''].join('\n')));
      const dir = out();
      const r = run(['fes', 'HILLS.0', 'HILLS.1.gz', '--min', '0', '--max', '1.5', '--bins', '100', '--out', dir, '--no-plots']);
      expect(r.stdout).toContain('123 hills');
      const ref = shifted(readFixture('fes_d.dat').columns['file.free']);
      readOut(dir, 'fes.dat').columns['file.free'].forEach((v, i) => expect(Math.abs(v - ref[i])).toBeLessThan(1e-6));
    });
  });

  describe('suggest', () => {
    test('the same widths and grids as the page, to the digit', () => {
      const dir = out();
      const r = run(['suggest', fixture('COLVAR'), '--nonnegative', 'd', '--out', dir]);
      expect(r.stdout).toContain('This run was biased');
      const rows = fs.readFileSync(path.join(dir, 'suggest.dat'), 'utf8').split('\n')
        .filter(l => l && !l.startsWith('#')).map(l => l.split(/\s+/));
      const c = readFixture('COLVAR');
      expect(rows.map(x => x[1])).toEqual(['d', 't']);
      const cases = { d: { nonNegative: true }, t: { period: c.periods.t } };
      for (const row of rows) {
        const name = row[1];
        const js = suggestBias(c.columns[name], cases[name]);
        expect(row.slice(7, 11)).toEqual([js.sigma, js.min, js.max, js.bin]);
        expect(Number(row[2])).toBe(js.summary.n);
        expect(Number(row[3])).toBeCloseTo(js.summary.mean, 8);
        expect(Number(row[4])).toBeCloseTo(js.summary.sd, 8);
        const drift = driftOf(c.columns[name], cases[name].period);
        expect(row[11]).toBe(drift.drifting ? 'yes' : 'no');
      }
    });

    test('a fraction other than half', () => {
      const dir = out();
      run(['suggest', fixture('COLVAR'), '--sigma-fraction', '0.25', '--out', dir, '--quiet']);
      const row = fs.readFileSync(path.join(dir, 'suggest.dat'), 'utf8').split('\n')[1].split(/\s+/);
      const js = suggestBias(readFixture('COLVAR').columns.d, { sigmaFraction: 0.25 });
      expect(row.slice(7, 11)).toEqual([js.sigma, js.min, js.max, js.bin]);
    });
  });

  describe('reweight', () => {
    const c = readFixture('COLVAR');
    const kT = thermalEnergy(300);

    const compare = (dir, js) => {
      const mine = readOut(dir, 'fes_reweighted.dat');
      expect(Number(mine.sets.frames)).toBe(js.frames);
      expect(Number(mine.sets.effective)).toBeCloseTo(js.effective, 6);
      // parseColvar leaves out a row holding nan, so compare by position.
      const text = fs.readFileSync(path.join(dir, 'fes_reweighted.dat'), 'utf8').split('\n')
        .filter(l => l && !l.startsWith('#')).map(l => l.split(/\s+/));
      expect(text).toHaveLength(js.x.length);
      text.forEach(([x, f], k) => {
        expect(Number(x)).toBeCloseTo(js.x[k], 8);
        if (Number.isNaN(js.f[k])) expect(f).toBe('nan');
        else expect(Math.abs(Number(f) - js.f[k])).toBeLessThan(1e-7);
      });
    };

    test('with the bias less its offset, the whole run', () => {
      const dir = out();
      run(['reweight', fixture('COLVAR'), '--arg', 'd', '--out', dir, '--no-plots', '--quiet']);
      compare(dir, reweight(c.columns.d, c.columns['m3.rbias'], { kT, bins: 60, skip: 0 }));
    });

    test('with the plain bias, the first fifth left out', () => {
      const dir = out();
      const r = run(['reweight', fixture('COLVAR'), '--arg', 'd', '--bias', 'm3.bias', '--out', dir, '--no-plots']);
      expect(r.stdout).toContain('The first 60 frames are left out');
      compare(dir, reweight(c.columns.d, c.columns['m3.bias'], { kT, bins: 60, skip: 60 }));
    });

    test('a periodic value takes its period, in another energy unit', () => {
      const dir = out();
      run(['reweight', fixture('COLVAR'), '--arg', 't', '--energy', 'kcal/mol', '--temp', '310', '--bins', '30',
        '--out', dir, '--no-plots', '--quiet']);
      compare(dir, reweight(c.columns.t, c.columns['m3.rbias'],
        { kT: thermalEnergy(310, 'kcal/mol'), bins: 30, skip: 0, period: c.periods.t }));
    });
  });

  describe('restarted runs', () => {
    const inspect = (name, text, extra = []) => {
      fs.writeFileSync(path.join(tmp, name), text);
      return JSON.parse(run(['inspect', name, '--json', ...extra]).stdout)[0];
    };

    test('a part that starts from an earlier checkpoint replaces the older copy', () => {
      const a = Array.from({ length: 11 }, (_, t) => `${t} ${t / 10}`).join('\n');
      const b = Array.from({ length: 5 }, (_, i) => `${i + 8} ${5 + (i + 8) / 10}`).join('\n');
      const text = `#! FIELDS time d\n${a}\n#! FIELDS time d\n${b}\n`;
      const o = inspect('killed', text);
      expect(o).toMatchObject({ rows: 13, parts: 2, dropped: 3, time: [0, 12] });
      expect(o.errors[0]).toContain('3 rows written again');
      expect(inspect('killed', text, ['--keep-overlap'])).toMatchObject({ rows: 16, dropped: 0 });
    });

    test('a clean restart writes its first row twice; the newer copy is kept', () => {
      const o = inspect('clean', '#! FIELDS time d\n0 0\n1 1\n2 2\n#! FIELDS time d\n2 20\n3 3\n');
      expect(o).toMatchObject({ rows: 4, dropped: 1, parts: 2 });
      const dir = out();
      run(['trace', 'clean', '--out', dir, '--no-plots', '--quiet']);
    });

    test('time going back with no new header is also a new part', () => {
      expect(inspect('back', '#! FIELDS time d\n0 0\n1 1\n2 2\n1 9\n2 9\n'))
        .toMatchObject({ rows: 3, dropped: 2, parts: 2 });
    });

    test('walkers sharing one HILLS file write the same time; nothing is dropped', () => {
      const rows = [];
      for (let t = 0; t < 5; t++) for (let w = 0; w < 3; w++) rows.push(`${t} ${0.1 * w} 0.1 1 -1`);
      const o = inspect('mpi', `#! FIELDS time d sigma_d height biasf\n${rows.join('\n')}\n`);
      expect(o).toMatchObject({ kind: 'hills', rows: 15, dropped: 0, parts: 1 });
    });

    test('a last line cut off mid-write is left out', () => {
      const o = inspect('cut', '#! FIELDS time d e\n0 1 2\n1 1 2\n2 1');
      expect(o).toMatchObject({ rows: 2, skipped: 1, cut: true });
      expect(o.errors.join(' ')).toContain('cut off mid-write');
    });

    test('the work of a steered run is carried across the parts', () => {
      const a = Array.from({ length: 11 }, (_, t) => `${t} ${t}`).join('\n');
      const b = Array.from({ length: 5 }, (_, i) => `${i + 8} ${i}`).join('\n');
      fs.writeFileSync(path.join(tmp, 'pull'), `#! FIELDS time moving.work\n${a}\n#! FIELDS time moving.work\n${b}\n`);
      const dir = out();
      run(['work', 'pull', '--arg', 'moving.work', '--out', dir, '--no-plots', '--quiet']);
      const w = readOut(dir, 'work.dat');
      expect(Array.from(w.columns.time)).toEqual(Array.from({ length: 13 }, (_, t) => t));
      expect(Array.from(w.columns['moving.work'])).toEqual(Array.from({ length: 13 }, (_, t) => t));
    });
  });

  describe('against PLUMED 2.11: projections, restarts, walkers, kernels, grids, biases', () => {
    // The kT the references were integrated at, and the temperature that gives it.
    const KT_REF = 2.494339;
    const TEMP_REF = String(KT_REF / KB_KJMOL);
    const reference = (name) => {
      const c = readFixture(name);
      return shifted(c.columns['file.free'] || c.columns.projection);
    };
    const near = (got, want, tol = 1e-6) => {
      expect(got.length).toBe(want.length);
      got.forEach((v, i) => { if (!(Math.abs(v - want[i]) < tol)) throw new Error(`[${i}] ${v} against ${want[i]}`); });
    };

    test('one variable of two: the other integrated out at kT, as sum_hills --idw --kt', () => {
      const dir = out();
      const r = run(['fes', fixture('HILLS_dt'), '--cv', 'd', '--min', '0', '--max', '1.5', '--bins', '100',
        '--integrate-bins', '40', '--temp', TEMP_REF, '--out', dir, '--no-plots']);
      expect(r.stdout).toContain('with t integrated out');
      expect(r.stdout).toContain('plumed sum_hills --idw d --kt');
      const mine = readOut(dir, 'fes.dat');
      expect(mine.sets).toMatchObject({ integrated: 't' });
      near(Array.from(mine.columns['file.free']), reference('fes_dt_d.dat'));
      const js = sumHills(readFixture('HILLS_dt'), {
        variables: ['d'], bins: 100, ranges: { d: { min: 0, max: 1.5 } }, kT: KT_REF, integrateBins: 40
      });
      near(Array.from(mine.columns['file.free']), Array.from(js.f));
      // The slices too, each integrated the same way.
      const slices = readOut(dir, 'fes_slices.dat');
      const jsSlices = fesOverTime(readFixture('HILLS_dt'), {
        variable: 'd', slices: 5, bins: 100, kT: KT_REF, integrateBins: 40, ranges: { d: { min: 0, max: 1.5 } }
      });
      jsSlices.forEach((sl, k) => near(Array.from(slices.columns[`file.free.${k + 1}`]), Array.from(sl.f)));
    });

    test('multivariate hills from ADAPTIVE=DIFF, in two dimensions and along one', () => {
      const dir = out();
      run(['fes', fixture('HILLS_adaptive'), '--bins', '30,20', '--min', '0', '--max', '1.5', '--out', dir, '--no-plots', '--quiet']);
      near(Array.from(readOut(dir, 'fes.dat').columns['file.free']), reference('fes_adaptive.dat'));
      const one = out();
      run(['fes', fixture('HILLS_adaptive'), '--cv', 'd', '--bins', '100', '--min', '0', '--max', '1.5', '--integrate-bins', '40',
        '--temp', TEMP_REF, '--out', one, '--no-plots', '--quiet']);
      near(Array.from(readOut(one, 'fes.dat').columns['file.free']), reference('fes_adaptive_d.dat'));
    });

    test('a run continued from an earlier checkpoint keeps every hill, as METAD read them back', () => {
      fs.writeFileSync(path.join(tmp, 'HILLS_restart'), fs.readFileSync(fixture('HILLS_restart')));
      const o = JSON.parse(run(['inspect', 'HILLS_restart', '--json']).stdout)[0];
      expect(o).toMatchObject({ kind: 'hills', rows: 118, dropped: 0, overlap: 19, parts: 2 });
      expect(o.errors[0]).toContain('19 hills lie at or after');
      const dir = out();
      run(['fes', fixture('HILLS_restart'), '--min', '0.3', '--max', '0.7', '--bins', '100', '--out', dir, '--no-plots', '--quiet']);
      near(Array.from(readOut(dir, 'fes.dat').columns['file.free']), reference('fes_restart.dat'));
    });

    test('walkers\' files joined into one sum as sum_hills sums them', () => {
      const lines = fs.readFileSync(fixture('HILLS_dt'), 'utf8').split('\n');
      const head = lines.filter(l => l.startsWith('#'));
      const rows = lines.filter(l => l.trim() && !l.startsWith('#'));
      fs.writeFileSync(path.join(tmp, 'HILLS_joined'),
        [0, 1].map(w => [...head, ...rows.filter((_, i) => i % 2 === w)].join('\n')).join('\n') + '\n');
      const dir = out();
      const r = run(['fes', 'HILLS_joined', '--bins', '30,20', '--min', '0', '--max', '1.5', '--out', dir, '--no-plots']);
      expect(r.stdout).toContain('121 hills');
      expect(r.stdout).not.toContain('checkpoints');
      near(Array.from(readOut(dir, 'fes.dat').columns['file.free']), reference('fes_dt.dat'));
    });

    test('wide periodic hills, a file with no kerneltype, and a plain Gaussian', () => {
      const wide = out();
      run(['fes', fixture('HILLS_wide'), '--bins', '100', '--out', wide, '--no-plots', '--quiet']);
      near(Array.from(readOut(wide, 'fes.dat').columns['file.free']), reference('fes_wide.dat'));
      const text = fs.readFileSync(fixture('HILLS_d'), 'utf8');
      fs.writeFileSync(path.join(tmp, 'HILLS_nokernel'), text.split('\n').filter(l => !l.includes('kerneltype')).join('\n'));
      fs.writeFileSync(path.join(tmp, 'HILLS_gaussian'), text.replace('stretched-gaussian', 'gaussian'));
      for (const [file, ref] of [['HILLS_nokernel', 'fes_d_nokernel.dat'], ['HILLS_gaussian', 'fes_d_gaussian.dat']]) {
        const dir = out();
        run(['fes', file, '--min', '0', '--max', '1.5', '--bins', '100', '--out', dir, '--no-plots', '--quiet']);
        near(Array.from(readOut(dir, 'fes.dat').columns['file.free']), reference(ref));
      }
    });

    test('hills with no variable to sum along are stopped with a message', () => {
      fs.writeFileSync(path.join(tmp, 'HILLS_novar'), '#! FIELDS time sigma_q height biasf\n0 0.1 1 -1\n1 0.1 1 -1\n');
      const r = run(['fes', 'HILLS_novar', '--no-plots'], { ok: false });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('cannot be summed');
      expect(r.stderr).not.toContain('Traceback');
    });

    test('suggested grids: rounded outwards, the period in its own words, the page\'s to the digit', () => {
      const n = 2000;
      const rows = Array.from({ length: n }, (_, i) => {
        const q = Math.sqrt(3) * (2 * ((i * 0.618034) % 1) - 1);
        return [i, 101.5 + 0.3 * q, -0.52 + 0.17 * Math.sin(i * 1.7), Math.PI + Math.sin(i) - 1, 0.1 * Math.cos(i)]
          .map(v => v.toFixed(6)).join(' ');
      });
      const text = '#! FIELDS time v dx f1 s.a\n#! SET min_f1 0\n#! SET max_f1 2*pi\n#! SET min_s.a -0.5\n#! SET max_s.a +0.5\n' +
        rows.join('\n') + '\n';
      fs.writeFileSync(path.join(tmp, 'COLVAR_grids'), text);
      const dir = out();
      run(['suggest', 'COLVAR_grids', '--nonnegative', 'v,dx', '--out', dir, '--quiet']);
      const got = Object.fromEntries(fs.readFileSync(path.join(dir, 'suggest.dat'), 'utf8').split('\n')
        .filter(l => l && !l.startsWith('#')).map(l => l.split(/\s+/)).map(r => [r[1], r.slice(7, 11)]));
      const c = parseColvar(text);
      for (const name of ['v', 'dx', 'f1', 's.a']) {
        const js = suggestBias(c.columns[name], { period: c.periods[name], nonNegative: name === 'v' || name === 'dx' });
        expect([name, got[name]]).toEqual([name, [js.sigma, js.min, js.max, js.bin]]);
      }
      const summary = (name) => suggestBias(c.columns[name]).summary;
      expect(Number(got.v[1])).toBeLessThan(summary('v').min);
      expect(Number(got.v[2])).toBeGreaterThan(summary('v').max);
      expect(Number(got.dx[1])).toBeLessThan(summary('dx').min);
      expect(got.f1.slice(1, 3)).toEqual(['0', '2*pi']);
      expect(got['s.a'].slice(1, 3)).toEqual(['-0.5', '+0.5']);
    });

    test('reweighting adds up every bias the run printed: the METAD\'s rbias and the wall', () => {
      const dir = out();
      const r = run(['reweight', fixture('COLVAR_wall'), '--arg', 'd', '--out', dir, '--no-plots']);
      expect(r.stdout).toContain('V from metad.rbias + uw.bias');
      const mine = readOut(dir, 'fes_reweighted.dat');
      expect(mine.sets.bias).toBe('metad.rbias + uw.bias');
      const c = readFixture('COLVAR_wall');
      const js = reweight(c.columns.d, totalBias(c, biasColumns(c)), { kT: thermalEnergy(300), bins: 60, skip: 0 });
      const text = fs.readFileSync(path.join(dir, 'fes_reweighted.dat'), 'utf8').split('\n')
        .filter(l => l && !l.startsWith('#')).map(l => l.split(/\s+/));
      text.forEach(([, f], k) => {
        if (Number.isNaN(js.f[k])) expect(f).toBe('nan');
        else expect(Math.abs(Number(f) - js.f[k])).toBeLessThan(1e-7);
      });
      // Named columns are still taken as given, and added up.
      const one = out();
      run(['reweight', fixture('COLVAR_wall'), '--arg', 'd', '--bias', 'metad.bias,uw.bias', '--out', one, '--no-plots', '--quiet']);
      expect(readOut(one, 'fes_reweighted.dat').sets).toMatchObject({ bias: 'metad.bias + uw.bias', skip: '120' });
    });
  });

  describe('the command line', () => {
    test('help names every command with an example', () => {
      const r = run(['--help']);
      for (const c of ['all', 'suggest', 'fes', 'reweight', 'trace', 'work', 'inspect']) {
        expect(r.stdout).toContain(`python3 analyse_plumed.py ${c}`);
      }
    });

    test('all, on a COLVAR and HILLS together', () => {
      const dir = out();
      run(['all', fixture('COLVAR'), fixture('HILLS_dt'), '--out', dir, '--quiet', ...(HAVE_MPL ? [] : ['--no-plots'])]);
      const files = fs.readdirSync(dir);
      for (const f of ['suggest.dat', 'fes.dat', 'hill_heights.dat', 'fes_reweighted.dat']) expect(files).toContain(f);
      if (HAVE_MPL) for (const f of ['fes.png', 'trace.png', 'hill_heights.png', 'fes_reweighted.png']) expect(files).toContain(f);
      // Two variables in the hills: the surface over both, as on the page.
      expect(readOut(dir, 'fes.dat').fields).toEqual(['d', 't', 'file.free']);
    });

    test('mistakes are stopped with a message', () => {
      const r = run(['fes', fixture('COLVAR'), '--no-plots'], { ok: false });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('is not a HILLS file');
      const e = run(['reweight', fixture('COLVAR'), '--arg', 'nothing', '--no-plots'], { ok: false });
      expect(e.stderr).toContain('has no column "nothing"');
      expect(run(['suggest', 'missing-file'], { ok: false }).stderr).toContain('Could not read missing-file');
    });
  });
});
