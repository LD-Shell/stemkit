import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KB_KJMOL, parseColvar, fileKind, hillsVariables, columnSummary, roundSig, suggestBias,
  driftOf, sumHills, fesOverTime, basinDifference, hillHeights, reweight, thermalEnergy,
  wellTempered, depositionRate
} from '../src/core/plumed-analysis.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures', 'plumed', name), 'utf8');
const read = (name) => parseColvar(fixture(name));

/* A reference surface, shifted so that its lowest point is zero. */
function reference(name) {
  const r = read(name).columns['file.free'];
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

  test('picks one variable out of two', () => {
    const s = sumHills(read('HILLS_dt'), { variables: ['t'], bins: 60 });
    expect(s.variables).toEqual(['t']);
    expect(s.shape).toEqual([60]);
  });

  test('a file that is not hills', () => {
    expect(sumHills(read('COLVAR'))).toBeNull();
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
