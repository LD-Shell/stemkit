import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  KB_KJMOL, parseColvar, fileKind, hillsVariables, hillsMultivariate, columnSummary, roundSig, suggestBias,
  driftOf, sumHills, fesOverTime, basinDifference, hillHeights, reweight, thermalEnergy,
  wellTempered, depositionRate, biasColumn, biasColumns, totalBias
} from '../src/core/plumed-analysis.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures', 'plumed', name), 'utf8');
const read = (name) => parseColvar(fixture(name));

/* A reference surface, shifted so that its lowest point is zero. sum_hills
   names the column "projection" when it integrates a variable out. */
function reference(name) {
  const c = read(name);
  const r = c.columns['file.free'] || c.columns.projection;
  let min = Infinity;
  for (const v of r) if (v < min) min = v;
  return Array.from(r, v => v - min);
}

describe('parseColvar', () => {
  test('reads the header, the period and the rows', () => {
    const c = read('COLVAR');
    expect(c.fields).toEqual(['time', 'd', 't', 'm3.bias', 'm3.rbias']);
    expect(c.rows).toBe(300);
    expect(c.columns.d).toHaveLength(300);
    expect(c.periods.t.min).toBeCloseTo(-Math.PI, 12);
    expect(c.periods.t.max).toBeCloseTo(Math.PI, 12);
    expect(c.periods.d).toBeUndefined();
    expect(c.errors).toEqual([]);
  });

  test('a restarted run repeats its header', () => {
    const c = parseColvar('#! FIELDS time d\n0 1.0\n1 1.1\n#! FIELDS time d\n2 1.2\n');
    expect(c.headers).toBe(2);
    expect(Array.from(c.columns.d)).toEqual([1.0, 1.1, 1.2]);
  });

  test('leaves out rows it cannot use, and says so', () => {
    const c = parseColvar('#! FIELDS time d\n0 1.0\n1 nan\n2\n3 1.3\n');
    expect(c.rows).toBe(2);
    expect(c.skipped).toBe(2);
    expect(c.errors[0]).toContain('2 rows were left out');
  });

  test('names the columns of a file with no header', () => {
    const c = parseColvar('0 1.0 2.0\n1 1.5 2.5\n');
    expect(c.fields).toEqual(['time', 'col2', 'col3']);
    expect(c.errors[0]).toContain('no "#! FIELDS" header');
  });

  test('an empty file', () => {
    expect(parseColvar('').errors).toEqual(['The file is empty.']);
    expect(parseColvar(null).rows).toBe(0);
    expect(parseColvar('#! FIELDS time d\n').errors).toEqual(['The file holds no rows of numbers.']);
  });

  test('tells hills from a COLVAR', () => {
    expect(fileKind(read('HILLS_dt').fields)).toBe('hills');
    expect(fileKind(read('COLVAR').fields)).toBe('colvar');
    expect(hillsVariables(read('HILLS_dt').fields)).toEqual(['d', 't']);
    expect(hillsVariables(read('COLVAR').fields)).toEqual([]);
  });
});

describe('columnSummary', () => {
  test('the sample standard deviation', () => {
    expect(columnSummary([2, 4, 4, 4, 5, 5, 7, 9])).toMatchObject({ n: 8, min: 2, max: 9, mean: 5 });
    expect(columnSummary([2, 4, 4, 4, 5, 5, 7, 9]).sd).toBeCloseTo(Math.sqrt(32 / 7), 12);
    expect(columnSummary([3]).sd).toBe(0);
    expect(columnSummary([]).n).toBe(0);
  });

  test('a periodic variable is averaged round the circle', () => {
    const period = { min: -Math.PI, max: Math.PI };
    // Either side of the edge: the plain mean is near zero, the true one at pi.
    const v = [3.0, 3.1, -3.1, -3.0];
    expect(Math.abs(columnSummary(v).mean)).toBeLessThan(0.01);
    expect(Math.abs(columnSummary(v, period).mean)).toBeGreaterThan(3.1);
    expect(columnSummary(v, period).sd).toBeLessThan(0.2);
    expect(columnSummary(v).sd).toBeGreaterThan(3);
  });

  test('for close values the circular spread is the ordinary one', () => {
    const v = [0.10, 0.12, 0.08, 0.11, 0.09];
    const plain = columnSummary(v);
    const round = columnSummary(v, { min: -Math.PI, max: Math.PI });
    expect(round.mean).toBeCloseTo(plain.mean, 6);
    // The circular form divides by n, the sample form by n - 1.
    expect(round.sd).toBeCloseTo(plain.sd * Math.sqrt(4 / 5), 4);
  });
});

describe('roundSig', () => {
  test('keeps significant figures', () => {
    expect(roundSig(0.066003, 2)).toBe(0.066);
    expect(roundSig(1234.5, 2)).toBe(1200);
    expect(roundSig(-0.3349, 2)).toBe(-0.33);
    expect(roundSig(0, 2)).toBe(0);
  });
});

describe('suggestBias', () => {
  const c = read('COLVAR');

  test('half the fluctuation, and a grid wider than what was seen', () => {
    const s = suggestBias(c.columns.d, { nonNegative: true });
    expect(Number(s.sigma)).toBeCloseTo(s.summary.sd / 2, 2);
    expect(Number(s.min)).toBeCloseTo(-5 * Number(s.sigma), 6);
    expect(Number(s.max)).toBeGreaterThan(s.summary.max + (s.summary.max - s.summary.min) * 0.99);
    const spacing = (Number(s.max) - Number(s.min)) / Number(s.bin);
    expect(spacing).toBeLessThanOrEqual(Number(s.sigma) / 5 + 1e-12);
    expect(s.notes.some(n => n.includes('cannot be negative'))).toBe(true);
  });

  test('a variable that may be negative is padded on both sides', () => {
    const s = suggestBias(c.columns.d);
    expect(Number(s.min)).toBeLessThan(s.summary.min - (s.summary.max - s.summary.min) * 0.99);
  });

  test('a periodic variable takes its period', () => {
    const s = suggestBias(c.columns.t, { period: c.periods.t });
    expect(s.min).toBe('-pi');
    expect(s.max).toBe('pi');
    expect(s.notes[0]).toContain('periodic');
  });

  test('keeps the SET line\'s own words for a periodic variable, as METAD compares them', () => {
    const text = '#! FIELDS time t f1 s.a\n#! SET min_t -pi\n#! SET max_t pi\n#! SET min_f1 0\n#! SET max_f1 2*pi\n' +
      '#! SET min_s.a -0.5\n#! SET max_s.a +0.5\n' +
      Array.from({ length: 300 }, (_, i) => `${i} ${Math.sin(i) - 1} ${Math.PI + Math.sin(i) - 1} ${0.1 * Math.cos(i)}`).join('\n') + '\n';
    const cv = parseColvar(text);
    expect(cv.periods.f1).toEqual({ min: 0, max: 2 * Math.PI, minText: '0', maxText: '2*pi' });
    const got = (name) => {
      const x = suggestBias(cv.columns[name], { period: cv.periods[name] });
      return [x.min, x.max];
    };
    expect(got('t')).toEqual(['-pi', 'pi']);
    // 0 to 6.28 and -0.5 to 0.5 stop METAD: "GRID_MAX[0] must be adjusted to 2*pi to fit periodicity".
    expect(got('f1')).toEqual(['0', '2*pi']);
    expect(got('s.a')).toEqual(['-0.5', '+0.5']);
    // A period given as numbers alone is written as before.
    expect(suggestBias(cv.columns.t, { period: { min: -Math.PI, max: Math.PI } }).max).toBe('pi');
  });

  test('the grid holds every value seen, whatever their size beside their spread', () => {
    // Rounding to the nearest two significant figures moved a bound inside the
    // values: a volume of 101.5 ± 0.3 got 99 to 100, and METAD stopped.
    const spread = (mean, sd) => Array.from({ length: 2000 }, (_, i) => mean + sd * Math.sqrt(3) * (2 * ((i * 0.618034) % 1) - 1));
    const volume = suggestBias(spread(101.5, 0.3), { nonNegative: true });
    expect(Number(volume.min)).toBeLessThan(volume.summary.min);
    expect(Number(volume.max)).toBeGreaterThan(volume.summary.max);
    let checked = 0;
    for (let mean = 10; mean <= 1000; mean += 0.5) {
      const s = suggestBias(spread(mean, 1));
      const sigma = Number(s.sigma);
      const pad = Math.max(s.summary.max - s.summary.min, 10 * sigma);
      const lo = Number(s.min);
      const hi = Number(s.max);
      // Rounded outwards, by no more than one hill width.
      if (!(lo <= s.summary.min - pad * (1 - 1e-6) && hi >= s.summary.max + pad * (1 - 1e-6))) throw new Error(`mean ${mean}: ${s.min} to ${s.max}`);
      if (!(lo >= s.summary.min - pad - sigma && hi <= s.summary.max + pad + sigma)) throw new Error(`mean ${mean}: ${s.min} to ${s.max} is too wide`);
      expect((hi - lo) / Number(s.bin)).toBeLessThanOrEqual(sigma / 5 + 1e-12);
      checked += 1;
    }
    expect(checked).toBe(1981);
  });

  test('a variable taken to be non-negative that was seen below zero is padded as any other', () => {
    // The x component of a distance, from -0.69 to -0.35: starting the grid
    // just below zero put every value outside it.
    const x = Array.from({ length: 300 }, (_, i) => -0.52 + 0.17 * Math.sin(i * 1.7));
    const s = suggestBias(x, { nonNegative: true });
    expect(Number(s.min)).toBeLessThan(s.summary.min);
    expect(Number(s.max)).toBeGreaterThan(s.summary.max);
    expect(s.notes.join(' ')).not.toContain('cannot be negative');
    expect(s.notes.join(' ')).toContain('below zero');
    expect([s.min, s.max]).toEqual([suggestBias(x).min, suggestBias(x).max]);
  });

  test('too little to go on', () => {
    expect(suggestBias([1, 2, 3])).toBeNull();
    expect(suggestBias(new Array(50).fill(1.5)).notes[0]).toContain('does not change');
    const few = suggestBias(Array.from({ length: 40 }, (_, i) => Math.sin(i)));
    expect(few.notes.some(n => n.includes('Only 40 values'))).toBe(true);
  });
});

describe('driftOf', () => {
  test('a variable still moving one way', () => {
    const rising = Array.from({ length: 300 }, (_, i) => i * 0.01 + 0.05 * Math.sin(i));
    expect(driftOf(rising).drifting).toBe(true);
    const steady = Array.from({ length: 300 }, (_, i) => 1 + 0.05 * Math.sin(i));
    expect(driftOf(steady).drifting).toBe(false);
    expect(driftOf([1, 2]).drifting).toBe(false);
  });

  test('a torsion sitting on the edge of its period is not drifting', () => {
    const period = { min: -Math.PI, max: Math.PI };
    // Fluctuates about pi, so the values jump between near -pi and near pi.
    const edge = Array.from({ length: 300 }, (_, i) => {
      const v = Math.PI + 0.2 * Math.sin(i * 1.3);
      return v > Math.PI ? v - 2 * Math.PI : v;
    });
    expect(driftOf(edge, period).drifting).toBe(false);
    // A real turn from -2 to 2 through pi is still seen.
    const turning = Array.from({ length: 300 }, (_, i) => {
      const v = -2 - (i / 299) * (2 * Math.PI - 4) + 0.02 * Math.sin(i);
      return v < -Math.PI ? v + 2 * Math.PI : v;
    });
    expect(driftOf(turning, period).drifting).toBe(true);
  });
});

describe('sumHills against plumed sum_hills', () => {
  test('one variable, well-tempered', () => {
    const s = sumHills(read('HILLS_d'), { bins: 100, ranges: { d: { min: 0, max: 1.5 } } });
    const ref = reference('fes_d.dat');
    expect(s.shape).toEqual([100]);
    expect(s.hills).toBe(123);
    expect(s.x[99]).toBeCloseTo(1.5, 12);
    for (let i = 0; i < ref.length; i++) expect(s.f[i]).toBeCloseTo(ref[i], 7);
  });

  test('one periodic variable', () => {
    const s = sumHills(read('HILLS_t'), { bins: 60 });
    const ref = reference('fes_t.dat');
    expect(s.periodic).toEqual([true]);
    expect(s.x[0]).toBeCloseTo(-Math.PI, 12);
    expect(s.x[59]).toBeCloseTo(Math.PI - (2 * Math.PI) / 60, 12);
    for (let i = 0; i < ref.length; i++) expect(s.f[i]).toBeCloseTo(ref[i], 7);
  });

  test('two variables', () => {
    const s = sumHills(read('HILLS_dt'), { bins: [30, 20], ranges: { d: { min: 0, max: 1.5 } } });
    const ref = reference('fes_dt.dat');
    expect(s.shape).toEqual([30, 20]);
    expect(s.variables).toEqual(['d', 't']);
    // PLUMED writes the first variable fastest; here it is the row.
    for (let i = 0; i < ref.length; i++) {
      const ix = i % 30;
      const iy = Math.floor(i / 30);
      expect(s.f[ix * 20 + iy]).toBeCloseTo(ref[i], 7);
    }
  });

  test('the lowest point is zero and nothing is negative', () => {
    const s = sumHills(read('HILLS_d'));
    expect(Math.min(...s.f)).toBe(0);
    expect(s.max).toBeGreaterThan(0);
  });

  test('earlier in the run there is less of it', () => {
    const hills = read('HILLS_d');
    const early = sumHills(hills, { upTo: 20, ranges: { d: { min: 0, max: 1.5 } } });
    const late = sumHills(hills, { ranges: { d: { min: 0, max: 1.5 } } });
    expect(early.hills).toBe(20);
    expect(early.max).toBeLessThan(late.max);
    expect(sumHills(hills, { upTo: 0 }).max).toBe(0);
  });

  test('picks one variable out of two, with the other integrated out at kT', () => {
    const s = sumHills(read('HILLS_dt'), { variables: ['t'], bins: 60, kT: 2.5 });
    expect(s.variables).toEqual(['t']);
    expect(s.shape).toEqual([60]);
    expect(s.integrated).toEqual(['d']);
    expect(s.kT).toBe(2.5);
    // As plumed sum_hills --idw refuses to without --kt.
    expect(sumHills(read('HILLS_dt'), { variables: ['t'], bins: 60 })).toBeNull();
    expect(sumHills(read('HILLS_dt'), { bins: 20 }).integrated).toEqual([]);
  });

  test('a file that is not hills', () => {
    expect(sumHills(read('COLVAR'))).toBeNull();
  });
});

/* The kT the references in tests/fixtures/plumed were integrated at. */
const KT_REF = 2.494339;
const within = (got, want, tol) => {
  expect(got.length).toBe(want.length);
  let worst = 0;
  for (let i = 0; i < want.length; i++) worst = Math.max(worst, Math.abs(got[i] - want[i]));
  expect(worst).toBeLessThan(tol);
};
/* PLUMED writes two-dimensional grids with the first variable fastest. */
const plumedOrder = (s) => {
  const [nx, ny] = s.shape;
  return Array.from({ length: nx * ny }, (_, k) => s.f[(k % nx) * ny + Math.floor(k / nx)]);
};

describe('a variable integrated out, as plumed sum_hills --idw --kt', () => {
  // Summing the hills of a two-variable run along d alone counts each hill in
  // full whatever its t, which is not a free energy: for HILLS_dt it gave a
  // surface 2.6 times as high as sum_hills --idw d.
  test('F(d) = -kT ln of the sum over t of exp(-F(d,t)/kT)', () => {
    const s = sumHills(read('HILLS_dt'), {
      variables: ['d'], bins: 100, ranges: { d: { min: 0, max: 1.5 } }, kT: KT_REF, integrateBins: 40
    });
    expect(s.integrated).toEqual(['t']);
    expect(s.integratedBins).toEqual([40]);
    within(s.f, reference('fes_dt_d.dat'), 1e-7);
  });

  test('along the periodic variable, the other integrated out', () => {
    const s = sumHills(read('HILLS_dt'), { variables: ['t'], bins: 60, ranges: { d: { min: 0, max: 1.5 } }, kT: KT_REF });
    expect(s.integrated).toEqual(['d']);
    within(s.f, reference('fes_dt_t.dat'), 1e-7);
  });

  test('the surface through the run is integrated the same way, slice by slice', () => {
    const hills = read('HILLS_dt');
    const slices = fesOverTime(hills, { variable: 'd', slices: 4, bins: 80, kT: KT_REF });
    expect(slices.map(x => x.hills)).toEqual([30, 61, 91, 121]);
    expect(slices[0].integrated).toEqual(['t']);
    // One pass over the hills gives what summing each slice anew gives.
    const range = { d: { min: slices[0].x[0], max: slices[0].x[79] } };
    for (const x of slices) {
      const one = sumHills(hills, { variables: ['d'], bins: 80, upTo: x.hills, ranges: range, kT: KT_REF });
      within(x.f, one.f, 1e-9);
    }
    expect(fesOverTime(hills, { variable: 'd' })).toEqual([]);
  });
});

describe('every hill of a restarted or joined HILLS file counts', () => {
  // A restarted METAD reads every hill in the file back into its bias, the
  // ones an earlier part laid after the checkpoint too (MetaD.cpp,
  // readGaussians), and plumed sum_hills sums them all.
  test('a run continued from an earlier checkpoint: all 118 hills, as sum_hills', () => {
    const h = parseColvar(fixture('HILLS_restart'), { keepOverlap: false });
    expect(h).toMatchObject({ rows: 118, dropped: 0, overlap: 19, parts: 2 });
    expect(h.errors.join(' ')).toContain('19 hills lie at or after the time where a later part of the file starts');
    expect(h.errors.join(' ')).not.toContain('written again');
    const s = sumHills(h, { bins: 100, ranges: { d: { min: 0.3, max: 0.7 } } });
    expect(s.hills).toBe(118);
    within(s.f, reference('fes_restart.dat'), 1e-7);
  });

  test('the bias PLUMED applied after the restart holds the hills past the checkpoint', () => {
    const h = parseColvar(fixture('HILLS_restart'), { keepOverlap: false });
    const c = parseColvar(fixture('COLVAR_restart'));
    // The first row of the continued part, at t = 2.0, before it lays a hill.
    const at = c.starts[1];
    expect(c.columns.time[at]).toBeCloseTo(2, 9);
    const d0 = c.columns.d[at];
    const floor = Math.exp(-6.25);
    const bias = (n) => {
      let v = 0;
      for (let i = 0; i < n; i++) {
        const dp2 = (d0 - h.columns.d[i]) ** 2 / (2 * h.columns.sigma_d[i] ** 2);
        if (dp2 < 6.25) v += h.columns.height[i] * 0.9 * (Math.exp(-dp2) - floor) / (1 - floor);
      }
      return v;
    };
    const firstPart = h.starts[1];
    expect(firstPart).toBe(59);
    expect(bias(firstPart)).toBeCloseTo(c.columns['m.bias'][at], 4);
    // Without the 19 hills laid after the checkpoint it is well off.
    const before = h.columns.time.findIndex(t => t >= 2);
    expect(Math.abs(bias(before) - c.columns['m.bias'][at])).toBeGreaterThan(1);
  });

  test('walkers\' files joined into one (cat HILLS.0 HILLS.1) sum as sum_hills sums them', () => {
    const lines = fixture('HILLS_dt').split('\n');
    const head = lines.filter(l => l.startsWith('#'));
    const rows = lines.filter(l => l.trim() && !l.startsWith('#'));
    const joined = [0, 1].map(w => [...head, ...rows.filter((_, i) => i % 2 === w)].join('\n')).join('\n') + '\n';
    const h = parseColvar(joined, { keepOverlap: false });
    expect(h).toMatchObject({ rows: 121, dropped: 0, overlap: 60, parts: 2 });
    expect(h.errors.join(' ')).not.toContain('checkpoints');
    const s = sumHills(h, { bins: [30, 20], ranges: { d: { min: 0, max: 1.5 } } });
    within(plumedOrder(s), reference('fes_dt.dat'), 1e-7);
  });

  test('a row several later parts reach is counted once', () => {
    const part = '#! FIELDS time d sigma_d height biasf\n0 1 0.1 1 -1\n1 1 0.1 1 -1\n2 1 0.1 1 -1\n';
    expect(parseColvar(part + part + part, { keepOverlap: false })).toMatchObject({ rows: 9, overlap: 6, parts: 3 });
    const three = `${part}#! FIELDS time d sigma_d height biasf\n1.5 1 0.1 1 -1\n3 1 0.1 1 -1\n` +
      '#! FIELDS time d sigma_d height biasf\n0.5 1 0.1 1 -1\n';
    // 1 and 2 from the first part, then 1 to 3 again from the start at 0.5.
    expect(parseColvar(three, { keepOverlap: false })).toMatchObject({ rows: 6, overlap: 4, parts: 3 });
  });

  test('a COLVAR still drops the older copy of rows a later part wrote again', () => {
    const c = parseColvar('#! FIELDS time d\n0 0\n1 1\n2 2\n#! FIELDS time d\n1 5\n2 6\n', { keepOverlap: false });
    expect(c).toMatchObject({ rows: 3, dropped: 2, overlap: 0 });
  });
});

describe('hills placed and shaped as PLUMED 2.11 places and shapes them', () => {
  test('hills wider than half a periodic axis: the window starts from the point below the centre', () => {
    // A hill 1.5 rad wide reaches round the torsion's period, so sum_hills adds
    // it twice at some points; which ones depends on where the window starts.
    const s = sumHills(read('HILLS_wide'), { bins: 100 });
    within(s.f, reference('fes_wide.dat'), 1e-7);
  });

  test('a file with no kerneltype (PLUMED 2.7 and older) is read as stretched', () => {
    const text = fixture('HILLS_d').split('\n').filter(l => !l.includes('kerneltype')).join('\n');
    const s = sumHills(parseColvar(text), { bins: 100, ranges: { d: { min: 0, max: 1.5 } } });
    within(s.f, reference('fes_d_nokernel.dat'), 1e-7);
  });

  test('a plain Gaussian is not cut inside its window', () => {
    const text = fixture('HILLS_d').replace('stretched-gaussian', 'gaussian');
    const s = sumHills(parseColvar(text), { bins: 100, ranges: { d: { min: 0, max: 1.5 } } });
    within(s.f, reference('fes_d_gaussian.dat'), 1e-7);
  });
});

describe('multivariate hills (ADAPTIVE=DIFF or GEOM)', () => {
  const h = read('HILLS_adaptive');

  test('are hills on their variables', () => {
    expect(fileKind(h.fields)).toBe('hills');
    expect(hillsVariables(h.fields)).toEqual(['d', 't']);
    expect(hillsMultivariate(h)).toBe(true);
    expect(hillsMultivariate(read('HILLS_dt'))).toBe(false);
  });

  test('sum with their full covariance, as sum_hills', () => {
    const s = sumHills(h, { bins: [30, 20], ranges: { d: { min: 0, max: 1.5 } } });
    within(plumedOrder(s), reference('fes_adaptive.dat'), 1e-7);
  });

  test('along one variable, the other integrated out', () => {
    const s = sumHills(h, { variables: ['d'], bins: 100, ranges: { d: { min: 0, max: 1.5 } }, kT: KT_REF, integrateBins: 40 });
    within(s.f, reference('fes_adaptive_d.dat'), 1e-7);
  });

  test('in one dimension they are the plain hills', () => {
    const text = fixture('HILLS_d').replace('multivariate false', 'multivariate true').replace('sigma_d ', 'sigma_d_d ');
    const one = parseColvar(text);
    expect(hillsVariables(one.fields)).toEqual(['d']);
    const s = sumHills(one, { bins: 100, ranges: { d: { min: 0, max: 1.5 } } });
    within(s.f, reference('fes_d.dat'), 1e-7);
  });
});

describe('fesOverTime', () => {
  test('gives the surface at equal steps through the run', () => {
    const slices = fesOverTime(read('HILLS_d'), { slices: 3, bins: 50 });
    expect(slices.map(s => s.hills)).toEqual([41, 82, 123]);
    expect(slices[2].time).toBeCloseTo(2.46, 6);
    expect(slices.every(s => s.x.length === 50 && s.f.length === 50)).toBe(true);
    // Every slice is drawn on the same axis, so that they can be compared.
    expect(Array.from(slices[0].x)).toEqual(Array.from(slices[2].x));
    expect(fesOverTime(read('COLVAR'))).toEqual([]);
  });
});

describe('basinDifference', () => {
  test('two wells of known depth', () => {
    const kT = 2.5;
    const x = Array.from({ length: 201 }, (_, i) => -2 + i * 0.02);
    // Wells at -1 and +1; the right one 5 units higher.
    const f = x.map(v => Math.min(20 * (v + 1) ** 2, 5 + 20 * (v - 1) ** 2));
    const d = basinDifference(x, f, { a: [-2, 0], b: [0, 2], kT });
    expect(d).toBeCloseTo(5, 1);
    expect(basinDifference(x, f, { a: [-2, 0], b: [5, 6], kT })).toBeNaN();
    expect(basinDifference(x, f, { a: [-2, 0], b: [0, 2], kT: 0 })).toBeNaN();
  });
});

describe('hillHeights', () => {
  test('undoes the factor a well-tempered file carries', () => {
    const h = hillHeights(read('HILLS_d'));
    expect(h.tempered).toBe(true);
    expect(h.biasFactor).toBe(8);
    expect(h.first).toBeCloseTo(1.2, 10);
    expect(h.last).toBeLessThan(h.first);
    expect(h.ratio).toBeCloseTo(h.last / h.first, 12);
    expect(h.time).toHaveLength(h.height.length);
  });

  test('a run that is not tempered keeps its height', () => {
    const h = hillHeights(read('HILLS_t'));
    expect(h.tempered).toBe(false);
    expect(h.first).toBe(1);
    expect(h.ratio).toBe(1);
  });

  test('thins a long run', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => `${i} 1.0 0.1 ${1 / (1 + i / 500)} -1`).join('\n');
    const h = hillHeights(parseColvar(`#! FIELDS time d sigma_d height biasf\n${rows}\n`), { points: 100 });
    expect(h.height.length).toBeLessThanOrEqual(100);
    expect(h.height[0]).toBeGreaterThan(h.height[h.height.length - 1]);
  });

  test('no hills', () => {
    expect(hillHeights(read('COLVAR')).height).toEqual([]);
  });
});

describe('reweight', () => {
  test('recovers a known surface from a biased sample', () => {
    // Frames spread evenly over x, as a flat-histogram run would leave them,
    // carrying the bias that flattened F(x) = 10 x^2: V = -F.
    const kT = 2.5;
    const x = Array.from({ length: 4001 }, (_, i) => -1 + i * 0.0005);
    const bias = x.map(v => -10 * v * v);
    const r = reweight(x, bias, { kT, bins: 20, min: -1, max: 1 });
    expect(r.frames).toBe(4001);
    for (let k = 0; k < 20; k++) {
      const centre = r.x[k];
      expect(r.f[k] - r.f[10]).toBeCloseTo(10 * centre * centre - 10 * r.x[10] ** 2, 0);
    }
    expect(r.effective).toBeLessThan(r.frames);
    expect(r.effective).toBeGreaterThan(100);
  });

  test('with no bias every frame counts the same', () => {
    const x = Array.from({ length: 100 }, (_, i) => i / 100);
    const r = reweight(x, new Array(100).fill(0), { kT: 2.5, bins: 10 });
    expect(r.effective).toBeCloseTo(100, 8);
    expect(Array.from(r.f).every(v => Math.abs(v) < 1e-12)).toBe(true);
  });

  test('reads the printed bias of a real run', () => {
    const c = read('COLVAR');
    const r = reweight(c.columns.d, c.columns['m3.rbias'], { kT: thermalEnergy(300), bins: 20, skip: 50 });
    expect(r.frames).toBe(250);
    expect(r.effective).toBeGreaterThan(1);
    expect(r.effective).toBeLessThanOrEqual(250);
    expect(Math.min(...Array.from(r.f).filter(Number.isFinite))).toBe(0);
  });

  test('a large bias does not overflow', () => {
    const r = reweight([0.1, 0.2, 0.3], [5000, 5001, 5002], { kT: 2.5, bins: 3 });
    expect(Array.from(r.f).every(Number.isFinite)).toBe(true);
  });

  test('refuses what it cannot use', () => {
    expect(reweight([1, 2], [0, 0], { kT: 0 })).toBeNull();
    expect(reweight([1], [0], { kT: 2.5 })).toBeNull();
    expect(reweight([1, 1, 1], [0, 0, 0], { kT: 2.5 })).toBeNull();
  });
});

describe('the biases a frame is weighted with', () => {
  test('each rbias in place of its own bias, and every other bias', () => {
    expect(biasColumns(read('COLVAR'))).toEqual(['m3.rbias']);
    expect(biasColumns(read('COLVAR_wall'))).toEqual(['metad.rbias', 'uw.bias']);
    expect(biasColumns({ fields: ['time', 'd', 'metad.bias', 'lw.bias', 'uw.bias'] })).toEqual(['metad.bias', 'lw.bias', 'uw.bias']);
    expect(biasColumns({ fields: ['time', 'd'] })).toEqual([]);
    // Unchanged: the column that says whether there is a bias at all.
    expect(biasColumn(read('COLVAR_wall'))).toBe('metad.rbias');
  });

  test('added up row by row', () => {
    const c = parseColvar('#! FIELDS time d a.bias w.bias\n0 1 1.5 0.25\n1 2 2 0\n');
    expect(Array.from(totalBias(c, ['a.bias', 'w.bias']))).toEqual([1.75, 2]);
    expect(Array.from(totalBias(c, []))).toEqual([0, 0]);
  });

  test('with a wall beside the metadynamics, both are needed to get the surface back', () => {
    // Frames spread evenly over x, flattened by a metadynamics bias and a wall
    // above x = 0.5 that together cancel F(x) = 10 x^2.
    const kT = 2.5;
    const x = Array.from({ length: 4001 }, (_, i) => -1 + i * 0.0005);
    const wall = x.map(v => (v > 0.5 ? 50 * (v - 0.5) ** 2 : 0));
    const metad = x.map((v, i) => -10 * v * v - wall[i]);
    const c = { rows: x.length, columns: { 'metad.bias': metad, 'uw.bias': wall } };
    const both = reweight(x, totalBias(c, ['metad.bias', 'uw.bias']), { kT, bins: 20, min: -1, max: 1 });
    const alone = reweight(x, metad, { kT, bins: 20, min: -1, max: 1 });
    const error = (r) => Math.max(...Array.from(r.f, (f, k) => Math.abs(f - r.f[10] - 10 * (r.x[k] ** 2 - r.x[10] ** 2))));
    expect(error(both)).toBeLessThan(0.1);
    expect(error(alone)).toBeGreaterThan(5);
  });
});

describe('calculators', () => {
  test('kT at 300 K', () => {
    expect(thermalEnergy(300)).toBeCloseTo(2.4943, 4);
    expect(thermalEnergy(300, 'kcal/mol')).toBeCloseTo(0.59616, 4);
    expect(thermalEnergy(300, 'eV')).toBeCloseTo(0.025852, 5);
    expect(thermalEnergy(300, 'furlongs')).toBeNaN();
    expect(thermalEnergy(0)).toBeNaN();
    expect(KB_KJMOL).toBeCloseTo(0.0083144626, 10);
  });

  test('what a bias factor leaves of a barrier', () => {
    const r = wellTempered({ barrier: 50, biasFactor: 10, temperature: 300 });
    expect(r.residual).toBe(5);
    expect(r.residualInKT).toBeCloseTo(5 / 2.4943, 3);
    expect(r.effectiveTemperature).toBe(3000);
    expect(r.suggested).toBe(10);
    expect(wellTempered({ barrier: 3, biasFactor: 10, temperature: 300 }).suggested).toBe(2);
    expect(wellTempered({ barrier: 0, biasFactor: 10, temperature: 300 })).toBeNull();
    expect(wellTempered({ barrier: 50, biasFactor: 1, temperature: 300 }).residual).toBeNaN();
  });

  test('how fast hills are laid down', () => {
    const r = depositionRate({ height: 1.2, pace: 500, timestep: 0.002, depth: 60 });
    expect(r.perPs).toBeCloseTo(1.2, 12);
    expect(r.hillsPerNs).toBeCloseTo(1000, 9);
    expect(r.fillNs).toBeCloseTo(0.05, 12);
    expect(depositionRate({ height: 1.2, pace: 500, timestep: 0.002 }).fillNs).toBeNull();
    expect(depositionRate({ height: 0, pace: 500, timestep: 0.002 })).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * PLUMED itself, when it is installed: the suggested grids run in METAD, and
 * the page's own grid sums as sum_hills sums it. Skipped without PLUMED.
 * ------------------------------------------------------------------ */

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

describe('in PLUMED', () => {
  let dir;
  const plumed = (args) => {
    const r = spawnSync(PLUMED, args, { cwd: dir, encoding: 'utf8', timeout: 120000 });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  /* A trajectory for plumed driver: each frame's box and atoms. */
  const xyz = (name, frames) => fs.writeFileSync(path.join(dir, name), frames.map(({ box, atoms }) =>
    `${atoms.length}\n${box.join(' ')}\n${atoms.map(a => `X ${a.map(v => v.toFixed(6)).join(' ')}`).join('\n')}\n`).join(''));
  /* Suggest a grid from an unbiased run, then run METAD on it. */
  const suggestThenRun = (defs, arg, options) => {
    fs.writeFileSync(path.join(dir, 'unbiased.dat'), `${defs}PRINT ARG=${arg} FILE=COLVAR_${arg} FMT=%.6f\n`);
    expect(plumed(['driver', '--ixyz', 'traj.xyz', '--plumed', 'unbiased.dat']).status).toBe(0);
    const c = parseColvar(fs.readFileSync(path.join(dir, `COLVAR_${arg}`), 'utf8'));
    const s = suggestBias(c.columns[arg], { period: c.periods[arg], ...options });
    fs.writeFileSync(path.join(dir, 'metad.dat'), `${defs}m: METAD ARG=${arg} SIGMA=${s.sigma} HEIGHT=1 PACE=10 ` +
      `GRID_MIN=${s.min} GRID_MAX=${s.max} GRID_BIN=${s.bin} FILE=HILLS_${arg}\n`);
    const r = plumed(['driver', '--ixyz', 'traj.xyz', '--plumed', 'metad.dat']);
    expect([arg, r.status, /outside the grid|ERROR/.test(r.out) ? r.out.split('\n').find(l => /outside|ERROR/.test(l)) : '']).toEqual([arg, 0, '']);
    return s;
  };

  beforeAll(() => { if (PLUMED) dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-plumed-')); });
  afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  withPlumed('a volume large beside its spread: the grid holds it', () => {
    xyz('traj.xyz', Array.from({ length: 2000 }, (_, i) => {
      const L = (101.5 + 0.3 * Math.sqrt(3) * (2 * ((i * 0.618034) % 1) - 1)) ** (1 / 3);
      return { box: [L, L, L], atoms: [[1, 1, 1]] };
    }));
    const s = suggestThenRun('v: VOLUME\n', 'v', { nonNegative: true });
    expect(Number(s.min)).toBeLessThan(s.summary.min);
  }, 60000);

  withPlumed('a component of a distance, marked non-negative as its DISTANCE is', () => {
    xyz('traj.xyz', Array.from({ length: 300 }, (_, i) => ({
      box: [5, 5, 5],
      atoms: [[2, 2, 2], [1.5 + 0.05 * Math.sin(i * 1.3), 2 + 0.05 * Math.sin(i * 2.1), 2 + 0.05 * Math.cos(i * 0.7)]]
    })));
    suggestThenRun('d: DISTANCE ATOMS=1,2 COMPONENTS\n', 'd.x', { nonNegative: true });
  }, 60000);

  withPlumed('periodic variables whose domain is not -pi to pi', () => {
    xyz('traj.xyz', Array.from({ length: 300 }, (_, i) => ({
      box: [5, 5, 5],
      atoms: [[1, 1, 1], [1.4, 1, 1], [1.4, 1.4, 1], [1.8, 1.4, 1.3]].map((a, k) => a.map((v, j) => v + 0.03 * Math.sin(i * (1.1 + k) + j)))
    })));
    const defs = 't: TORSION ATOMS=1,2,3,4\nf1: CUSTOM ARG=t FUNC=x+pi PERIODIC=0,2*pi\ns: DISTANCE ATOMS=1,2 SCALED_COMPONENTS\n';
    expect([suggestThenRun(defs, 'f1').max, suggestThenRun(defs, 's.a').max, suggestThenRun(defs, 't').max]).toEqual(['2*pi', '+0.5', 'pi']);
  }, 60000);

  withPlumed('the page\'s own grid along one variable of two is sum_hills --idw', () => {
    const kT = thermalEnergy(300);
    const s = sumHills(read('HILLS_dt'), { variables: ['d'], bins: 300, kT });
    fs.writeFileSync(path.join(dir, 'HILLS'), fixture('HILLS_dt'));
    const r = plumed(['sum_hills', '--hills', 'HILLS', '--idw', 'd', '--kt', String(kT), '--min', `${s.x[0]},-pi`,
      '--max', `${s.x[299]},pi`, '--bin', '299,100', '--outfile', 'idw.dat']);
    expect(r.status).toBe(0);
    const ref = parseColvar(fs.readFileSync(path.join(dir, 'idw.dat'), 'utf8')).columns.projection;
    const min = Math.min(...ref);
    let worst = 0;
    ref.forEach((v, i) => { worst = Math.max(worst, Math.abs(v - min - s.f[i])); });
    expect(worst).toBeLessThan(1e-8);
  }, 60000);
});
