import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CV_DEFS, BIAS_DEFS, REDUCTIONS, createCV, generatePlumedInput, biasKeywordUnit, lengthPower,
  valueDomain, defaultBiasValues, biasedArguments, availableArguments, componentsForCV
} from '../src/core/plumed.js';
import { loadSyntax } from '../src/core/plumed-syntax.js';
import {
  convertQuantity, startingParam, cardStarts, rebaseStarts, biasStart, lengthFields, isLengthBlock,
  convertLengthDefaults, convertBlockLengths, convertLength, CATALOGUE_UNITS
} from '../js/script-generator-plumed-model.js';

/*
 * Starting values in the units of the file: every value whose unit depends
 * on UNITS moves by its own unit when the units change, a count starts on a
 * count's grid, and another component brings its own starting grid. The
 * units of each keyword come from what PLUMED 2.11 computes
 * (src/bias/Restraint.cpp, UWalls.cpp, LWalls.cpp, MovingRestraint.cpp,
 * ABMD.cpp); the tests that run PLUMED check that the same restraint
 * written in nm and kJ/mol and in Å and kcal/mol gives the same energy.
 * They are skipped when plumed is not on the PATH.
 */

const hasPlumed = spawnSync('plumed', ['--help'], { encoding: 'utf8' }).status === 0;
const withPlumed = hasPlumed ? test : test.skip;
const modules = (...names) => hasPlumed &&
  spawnSync('plumed', ['config', 'has', 'module', ...names], { encoding: 'utf8' }).status === 0;
const withSymfunc = modules('symfunc', 'adjmat') ? test : test.skip;

const made = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stemkit-plumed-units-'));
  made.push(dir);
  return dir;
};
afterAll(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
const plumed = (dir, args) => spawnSync('plumed', args, { cwd: dir, encoding: 'utf8' });
const readColvar = (file) => {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const names = lines[0].replace(/^#! FIELDS\s+/, '').split(/\s+/);
  const rows = lines.filter(l => l.trim() && !l.startsWith('#')).map(l => l.trim().split(/\s+/).map(Number));
  return Object.fromEntries(names.map((n, i) => [n, rows.map(r => r[i])]));
};

const NM = { length: 'nm', energy: 'kj/mol' };
const AK = { length: 'A', energy: 'kcal/mol' };

let syntax = null;
beforeAll(async () => { syntax = await loadSyntax('2.11'); });

/* ------------------------------------------------------------------ */

describe('Units of the bias keywords, from PLUMED 2.11', () => {
  const u = (length, energy) => ({ length, energy });

  test('RESTRAINT: ½ KAPPA (x − AT)² + SLOPE (x − AT)', () => {
    expect(biasKeywordUnit('restraint', 'AT', { power: 1 })).toEqual(u(1, 0));
    expect(biasKeywordUnit('restraint', 'KAPPA', { power: 1 })).toEqual(u(-2, 1));
    expect(biasKeywordUnit('restraint', 'SLOPE', { power: 1 })).toEqual(u(-1, 1));
    expect(biasKeywordUnit('restraint', 'KAPPA', { power: 2 })).toEqual(u(-4, 1));
  });

  test('walls: KAPPA ((x − AT + OFFSET)/EPS)^EXP, with EPS kept as it reads', () => {
    expect(biasKeywordUnit('upper', 'KAPPA', { power: 1 })).toEqual(u(-2, 1));
    expect(biasKeywordUnit('upper', 'KAPPA', { power: 1, exp: '4' })).toEqual(u(-4, 1));
    expect(biasKeywordUnit('lower', 'KAPPA', { power: 2, exp: '' })).toEqual(u(-4, 1));
    expect(biasKeywordUnit('lower', 'OFFSET', { power: 1 })).toEqual(u(1, 0));
    expect(biasKeywordUnit('upper', 'AT', { power: 2 })).toEqual(u(2, 0));
    expect(biasKeywordUnit('upper', 'EPS', { power: 1 })).toBeNull();
    expect(biasKeywordUnit('upper', 'EXP', { power: 1 })).toBeNull();
  });

  test('MOVINGRESTRAINT at each step, ABMD on the square of the distance to TO', () => {
    expect(biasKeywordUnit('moving', 'AT0', { power: 1 })).toEqual(u(1, 0));
    expect(biasKeywordUnit('moving', 'AT1', { power: 1 })).toEqual(u(1, 0));
    expect(biasKeywordUnit('moving', 'KAPPA0', { power: 1 })).toEqual(u(-2, 1));
    expect(biasKeywordUnit('moving', 'KAPPA1', { power: 1 })).toEqual(u(-2, 1));
    expect(biasKeywordUnit('moving', 'STEP1', { power: 1 })).toBeNull();
    expect(biasKeywordUnit('abmd', 'TO', { power: 1 })).toEqual(u(1, 0));
    expect(biasKeywordUnit('abmd', 'KAPPA', { power: 1 })).toEqual(u(-4, 1));
    expect(biasKeywordUnit('abmd', 'NOISE', { power: 1 })).toEqual(u(2, 0));
  });

  test('HEIGHT and BARRIER are energies; SIGMA is in the unit of the value; a count or an angle has no length', () => {
    expect(biasKeywordUnit('wt_metad', 'HEIGHT')).toEqual(u(0, 1));
    expect(biasKeywordUnit(undefined, 'BARRIER')).toEqual(u(0, 1));
    expect(biasKeywordUnit('opes', 'SIGMA', { power: 1 })).toEqual(u(1, 0));
    expect(biasKeywordUnit('metad', 'PACE')).toBeNull();
    for (const m of ['restraint', 'upper', 'moving', 'abmd']) {
      const k = m === 'moving' ? 'KAPPA1' : 'KAPPA';
      expect(biasKeywordUnit(m, k, { power: 0 })).toEqual(u(0, 1));
    }
  });
});

describe('Starting values move with the units, each by its own unit', () => {
  test('a value is converted by its unit; zero, text and lists stay as written', () => {
    const kappa = biasKeywordUnit('restraint', 'KAPPA', { power: 1 });
    expect(convertQuantity('200', kappa, NM, AK)).toBe('0.478011');
    expect(convertQuantity('0.478011', kappa, AK, NM)).toBe('200');
    expect(convertQuantity('200', kappa, NM, NM)).toBe('200');
    expect(convertQuantity('0.0', kappa, NM, AK)).toBe('0.0');
    expect(convertQuantity('pi', { length: 0, energy: 0 }, NM, AK)).toBe('pi');
    expect(convertQuantity('1,2', { length: 1, energy: 0 }, NM, AK)).toBe('1,2');
    expect(convertQuantity('5', null, NM, AK)).toBe('5');
  });

  test('a method\'s starting values follow each biased value: a distance and a torsion differ', () => {
    const upper = (k) => BIAS_DEFS.upper.params.find(p => p.k === k);
    const two = { method: 'upper', targets: [{ power: 1 }, { power: 0 }], exp: '2' };
    expect(startingParam(upper('AT'), AK, two)).toBe('20,2.0');
    expect(startingParam(upper('KAPPA'), AK, two)).toBe('0.358509,35.8509');
    expect(startingParam(upper('KAPPA'), AK, { ...two, exp: '4,2' })).toBe('0.00358509,35.8509');
    expect(startingParam(upper('EPS'), AK, two)).toBe('1');
    expect(startingParam(upper('OFFSET'), AK, two)).toBe('0');
    // In PLUMED's own units the catalogue's text is kept, one value for all.
    expect(startingParam(upper('AT'), NM, two)).toBe('2.0');
    expect(startingParam(upper('KAPPA'), NM, two)).toBe('150');
    const kappa = (m, k = 'KAPPA') => BIAS_DEFS[m].params.find(p => p.k === k);
    const d = { targets: [{ power: 1 }] };
    expect(startingParam(kappa('restraint'), AK, { ...d, method: 'restraint' })).toBe('0.478011');
    expect(startingParam(kappa('moving', 'KAPPA1'), AK, { ...d, method: 'moving' })).toBe('0.478011');
    expect(startingParam(kappa('moving', 'AT1'), AK, { ...d, method: 'moving' })).toBe('10');
    expect(startingParam(kappa('abmd'), AK, { ...d, method: 'abmd' })).toBe('0.00119503');
    // A count is not a length: only the energy moves.
    expect(startingParam(kappa('restraint'), AK, { method: 'restraint', targets: [{ power: 0 }] })).toBe('47.8011');
    // The older form, an energy unit alone, still gives HEIGHT and BARRIER.
    expect(startingParam(BIAS_DEFS.wt_metad.params.find(p => p.k === 'HEIGHT'), 'kcal/mol')).toBe('0.287');
  });

  test('a wall or restraint card starts its KAPPA for what it acts on', () => {
    expect(cardStarts('restraint', { power: 1 }, AK)).toEqual({ kappa: '0.478011' });
    expect(cardStarts('upper', { power: 1, exp: '4' }, AK)).toEqual({ kappa: '0.00358509' });
    expect(cardStarts('lower', { power: 0 }, AK)).toEqual({ kappa: '35.8509' });
    expect(cardStarts('upper', { power: 2 }, NM)).toEqual({ kappa: '150' });
    expect(cardStarts('abmd', { power: 1 }, AK)).toBeNull();
  });

  test('only values still at their start move; a typed value stays', () => {
    const before = { kappa: '150', at: '0.0' };
    const after = { kappa: '1.5', at: '0' };
    expect(rebaseStarts({ kappa: '150', at: '0.0' }, before, after).values).toEqual({ kappa: '1.5', at: '0.0' });
    expect(rebaseStarts({ kappa: '120' }, before, after, ['kappa']).changed).toEqual([]);
    expect(rebaseStarts({ kappa: '150' }, null, after, ['kappa']).changed).toEqual([]);
  });
});

describe('A count starts on a count\'s grid, across the catalogue', () => {
  const block = (r) => (r.k === 'BETWEEN' ? '{GAUSSIAN LOWER=0.1 UPPER=0.5 SMEAR=0.1}' : '{RATIONAL R_0=0.5}');
  const allOn = (type) => {
    const cv = createCV(type, 1, { version: '2.11' });
    for (const r of REDUCTIONS) {
      if (!Object.prototype.hasOwnProperty.call(cv.values, r.k)) continue;
      cv.values[r.k] = r.type === 'flag' ? true : block(r);
    }
    return cv;
  };
  const multicolvars = Object.keys(CV_DEFS).filter(t => ['dot', 'underscore'].includes(CV_DEFS[t].compStyle));

  test.each(multicolvars)('%s: lessthan, morethan and between count items, from 0 to their number', (type) => {
    const cv = allOn(type);
    const counts = componentsForCV(cv, CV_DEFS, { version: '2.11' })
      .filter(c => /^[._](lessthan|morethan|between)(-\d+)?$/.test(c));
    for (const comp of counts) {
      const d = valueDomain(type, comp, { values: cv.values });
      expect({ comp, count: d.count }).toEqual({ comp, count: true });
      expect(lengthPower(type, comp, { values: cv.values })).toBe(0);
      const g = defaultBiasValues(type, comp, { values: cv.values });
      expect(g.min).toBe('0.0');
      expect(g.max).toBe(d.items ? String(d.items) : '10.0');
      expect(Number(g.sigma)).toBeGreaterThanOrEqual(0.2);
      expect((Number(g.max) - Number(g.min)) / Number(g.bin)).toBeLessThanOrEqual(Number(g.sigma) / 2);
      // Not a length: the same grid in every unit.
      expect(biasStart(type, comp, cv.values, 'A')).toEqual(biasStart(type, comp, cv.values, 'nm'));
    }
  });

  test('INPLANEDISTANCES counts its 98 distances; its mean and sum are lengths', () => {
    const cv = createCV('INPLANEDISTANCES', 1, { version: '2.11' });
    expect(cv.biasValues).toMatchObject({ comp: '_lessthan', min: '0.0', max: '98', sigma: '1' });
    expect(lengthPower('INPLANEDISTANCES', '_lessthan', { values: cv.values })).toBe(0);
    expect(defaultBiasValues('INPLANEDISTANCES', '_mean', { values: cv.values }))
      .toMatchObject({ max: '5.0', sigma: '0.05' });
    // 98 distances of up to 5 nm add up to 490 nm.
    expect(defaultBiasValues('INPLANEDISTANCES', '_sum', { values: cv.values })).toMatchObject({ max: '490', sigma: '5' });
    expect(lengthPower('INPLANEDISTANCES', '_sum', { values: cv.values })).toBe(1);
    expect(defaultBiasValues('INPLANEDISTANCES', '_lessthan', { values: { ...cv.values, GROUP: '3-10' } }).max).toBe('8');
    // A group PLUMED resolves is counted there, not here.
    expect(defaultBiasValues('INPLANEDISTANCES', '_lessthan', { values: { ...cv.values, GROUP: 'water' } }).max).toBe('10.0');
  });

  test('sums: of values in 0..1 a count, of coordination numbers 20 per atom, of signed values both ways', () => {
    expect(valueDomain('Q6', '.sum', { values: { SPECIES: '1-64' } })).toMatchObject({ count: true, items: 64 });
    expect(defaultBiasValues('COORDINATIONNUMBER', '.sum', { values: { SPECIES: '1-100' } })).toMatchObject({ min: '0.0', max: '2000' });
    expect(defaultBiasValues('COORDINATIONNUMBER', '.morethan', { values: { SPECIES: '1-100' } })).toMatchObject({ max: '100' });
    expect(defaultBiasValues('FCCUBIC', '.sum', { values: { SPECIES: '1-64' } })).toMatchObject({ min: '-64', max: '64' });
    expect(defaultBiasValues('COORDINATIONNUMBER_ADV', '.lessthan', { values: { SPECIES: '1-100', SPECIESA: '1-10', SPECIESB: '11-100' } }).max).toBe('10');
    expect(defaultBiasValues('ANGLES', '_morethan', { values: { GROUPA: '1-3', GROUPB: '11-20' } }).max).toBe('135');
    expect(defaultBiasValues('ANGLES', '_morethan', { values: { GROUP: '1-5' } }).max).toBe('10');
    // Weighted by a switching function, the count is far under the number of angles.
    expect(valueDomain('COORD_ANGLES', '_morethan', { values: { CATOMS: '1', GROUP: '2-100' } }).items).toBeNull();
    expect(defaultBiasValues('COORD_ANGLES', '_mean')).toMatchObject({ min: '0.0', max: 'pi' });
  });

  test('CONTACTMAP: one contact lies in 0..1, and SUM counts the contacts', () => {
    const one = { ATOMS: 'ATOMS1=1,2 SWITCH1={RATIONAL R_0=0.3} ATOMS2=3,4 SWITCH2={RATIONAL R_0=0.3}' };
    expect(defaultBiasValues('CONTACTMAP', '.contact-1', { values: one })).toMatchObject({ min: '0.0', max: '1.0' });
    expect(defaultBiasValues('CONTACTMAP', '', { values: { ...one, SUM: true } })).toMatchObject({ min: '0.0', max: '2' });
    // With a reference the contact is a difference, and the page does not guess.
    expect(valueDomain('CONTACTMAP', '.contact-1', { values: { ATOMS: `${one.ATOMS} REFERENCE1=0.5` } }).range).toBeNull();
  });

  test('COORDINATION_MOMENTS is a length to the power R_POWER; its moments to R_POWER times their order', () => {
    const v = { R_POWER: '1', SPECIES: '1-100' };
    expect(lengthPower('COORDINATION_MOMENTS', '.mean', { values: v })).toBe(1);
    expect(lengthPower('COORDINATION_MOMENTS', '.moment-3', { values: v })).toBe(3);
    expect(lengthPower('COORDINATION_MOMENTS', '.morethan', { values: v })).toBe(0);
    expect(lengthPower('COORDINATION_MOMENTS', '.mean', { values: { ...v, R_POWER: '0' } })).toBe(0);
    expect(lengthPower('COORDINATIONNUMBER', '.mean', { values: v })).toBe(0);
  });
});

describe('Another component brings its own starting grid', () => {
  test('from the mean of INPLANEDISTANCES to its count, in Å: starts move, typed values stay', () => {
    const cv = createCV('INPLANEDISTANCES', 1, { version: '2.11', values: { MEAN: true } });
    const start = (comp) => biasStart('INPLANEDISTANCES', comp, cv.values, 'A');
    expect(start('_mean')).toMatchObject({ min: '0.0', max: '50', sigma: '0.5' });
    const moved = rebaseStarts({ comp: '_lessthan', ...start('_mean') }, start('_mean'), start('_lessthan'),
      ['min', 'max', 'bin', 'sigma']);
    expect(moved.values).toMatchObject({ min: '0.0', max: '98', sigma: '1' });
    expect(moved.changed).toEqual(['max', 'sigma']);
    const typed = rebaseStarts({ ...start('_mean'), max: '30' }, start('_mean'), start('_lessthan'),
      ['min', 'max', 'bin', 'sigma']);
    expect(typed.values).toMatchObject({ max: '30', sigma: '1' });
  });

  test('the biased values are listed as the ARG of the bias line has them, each with its unit', () => {
    const d = createCV('DISTANCE', 1, { version: '2.11', label: 'd' });
    const ip = createCV('INPLANEDISTANCES', 2, { version: '2.11', label: 'ip' });
    const g = createCV('GYRATION', 3, { version: '2.11', label: 'g', values: { TYPE: 'TRACE' } });
    const off = createCV('TORSION', 4, { version: '2.11', label: 'phi' });
    off.bias = false;
    const config = { version: '2.11', cvs: [d, ip, g, off], bias: { method: 'restraint', params: { AT: '1' } } };
    const list = biasedArguments(config);
    expect(list.map(t => [t.arg, t.power])).toEqual([['d', 1], ['ip_lessthan', 0], ['g', 2]]);
    const line = generatePlumedInput(config).input.split('\n').find(l => l.includes('RESTRAINT'));
    expect(line).toContain(`ARG=${list.map(t => t.arg).join(',')}`);
    expect(availableArguments(config).find(a => a.arg === 'phi').power).toBe(0);
  });
});

describe('Switching functions written as blocks follow UNITS LENGTH', () => {
  test('a distance switch and a length multicolvar\'s starting reduction are lengths; a count\'s switch and a kernel on an angle are not', () => {
    expect(lengthFields(CV_DEFS.SMAC, 'SMAC').map(f => f.k)).toEqual(['SWITCH']);
    expect(lengthFields(CV_DEFS.FCCUBIC, 'FCCUBIC').map(f => f.k)).toEqual(['SWITCH']);
    expect(lengthFields(CV_DEFS.INPLANEDISTANCES, 'INPLANEDISTANCES').map(f => f.k)).toEqual(['LESS_THAN']);
    expect(lengthFields(CV_DEFS.TORSIONS, 'TORSIONS')).toEqual([]);
    expect(lengthFields(CV_DEFS.CONTACTMAP, 'CONTACTMAP').map(f => f.k)).toEqual(['ATOMS']);
    expect(lengthFields(CV_DEFS.COORDINATION, 'COORDINATION').map(f => f.k)).toEqual(['R_0', 'D_0', 'D_MAX', 'NL_CUTOFF']);
    expect(isLengthBlock({ k: 'SWITCH_COORD', type: 'text', def: '{RATIONAL R_0=0.001}' })).toBe(false);
  });

  test('a starting block moves; one typed stays; nm gives the catalogue\'s text back', () => {
    expect(convertBlockLengths('{GAUSSIAN LOWER=0.1 UPPER=0.5 SMEAR=0.1}', 'nm', 'A'))
      .toBe('{GAUSSIAN LOWER=1 UPPER=5 SMEAR=0.1}');
    expect(convertBlockLengths('{RATIONAL R_0=0.3 NN=6 MM=12}', 'nm', 'A')).toBe('{RATIONAL R_0=3 NN=6 MM=12}');
    const cv = createCV('SMAC', 1, { version: '2.11' });
    const fields = lengthFields(CV_DEFS.SMAC, 'SMAC');
    const toA = convertLengthDefaults(cv.values, fields, 'nm', 'A');
    expect(toA.values.SWITCH).toBe('{RATIONAL R_0=6 D_MAX=12}');
    expect(toA.values.SWITCH_COORD).toBe(cv.values.SWITCH_COORD);
    expect(convertLengthDefaults(toA.values, fields, 'A', 'nm').values.SWITCH).toBe(cv.values.SWITCH);
    const typed = convertLengthDefaults({ ...toA.values, SWITCH: '{RATIONAL R_0=5}' }, fields, 'A', 'nm');
    expect(typed.values.SWITCH).toBe('{RATIONAL R_0=5}');
    const ip = createCV('INPLANEDISTANCES', 1, { version: '2.11' });
    expect(convertLengthDefaults(ip.values, lengthFields(CV_DEFS.INPLANEDISTANCES, 'INPLANEDISTANCES'), 'nm', 'A')
      .values.LESS_THAN).toBe('{RATIONAL R_0=5 D_MAX=10}');
  });
});

/* ------------------------------------------------------------------ *
 * PLUMED itself
 * ------------------------------------------------------------------ */

/* 100 atoms on a lattice 0.3 nm apart, in nm, over 30 frames: atom 2 walks
   away from atom 1 (0.3 to 2.6 nm) and every atom shakes, so the distance,
   a torsion, the gyration tensor's trace, a coordination and a count of
   in-plane distances all move. Without the walk every atom keeps the four
   neighbours TETRA_RADIAL needs. */
function walkXyz(frames = 30, walking = true) {
  const out = [];
  for (let f = 0; f < frames; f++) {
    out.push('100', '10 10 10');
    for (let i = 0; i < 100; i++) {
      const [x, y, z] = [i % 5, Math.floor(i / 5) % 5, Math.floor(i / 25)];
      const j = (k) => 0.04 * Math.sin(7 * i + k + 0.9 * f);
      const walk = walking && i === 1 ? 0.08 * f : 0;
      out.push(`X ${(0.3 * x + walk + j(1) + 1).toFixed(4)} ${(0.3 * y + j(2) + 1).toFixed(4)} ${(0.3 * z + j(3) + 1).toFixed(4)}`);
    }
  }
  return `${out.join('\n')}\n`;
}

/* The five variables, written for the units as the page writes them: a
   length field and a starting switching block moved to the length unit. */
function variables(units) {
  const make = (type, seq, label, values) => {
    const cv = createCV(type, seq, { version: '2.11', syntax, label, values });
    cv.values = convertLengthDefaults(cv.values, lengthFields(CV_DEFS[type], type), 'nm', units.length).values;
    return cv;
  };
  return [
    make('DISTANCE', 1, 'd', { NOPBC: true }),
    make('TORSION', 2, 'phi', { ATOMS: '1,7,8,13', NOPBC: true }),
    make('GYRATION', 3, 'g', { TYPE: 'TRACE' }),
    make('COORDINATION', 4, 'cn', { GROUPA: '2', GROUPB: '3-100' }),
    make('INPLANEDISTANCES', 5, 'ip', {})
  ];
}

/* Run a file on the walk and return its columns. */
function run(dir, name, config, walking = true) {
  const g = generatePlumedInput({ version: '2.11', syntax, ...config });
  const sub = path.join(dir, name);
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'walk.xyz'), walkXyz(30, walking));
  fs.writeFileSync(path.join(sub, 'plumed.dat'), g.input);
  const r = plumed(sub, ['driver', '--plumed', 'plumed.dat', '--ixyz', 'walk.xyz']);
  if (r.status !== 0) throw new Error(`${name}: plumed failed\n${g.input}\n${(r.stdout || '').slice(-1500)}${r.stderr || ''}`);
  return readColvar(path.join(sub, 'OUT'));
}

const printAll = { file: 'OUT', stride: 1, fmt: '%.10f' };
/* Five figures, so that a length moved to Å (or an area, ×100) is still
   written exactly with the six figures the page keeps. */
const round5 = (x) => Number(x.toPrecision(5));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/* The largest gap between each energy in kJ/mol and the same energy printed
   in kcal/mol, absolute and relative to the largest energy of its column. */
function compare(kj, kcal, columns) {
  let abs = 0;
  let rel = 0;
  for (const c of columns) {
    const scale = Math.max(...kj[c].map(Math.abs));
    expect({ c, scale: scale > 0 }).toEqual({ c, scale: true });
    kj[c].forEach((v, i) => {
      const gap = Math.abs(kcal[c][i] * 4.184 - v);
      abs = Math.max(abs, gap);
      rel = Math.max(rel, gap / scale);
    });
  }
  return { abs, rel };
}

describe('PLUMED 2.11 gives the same energy in nm and kJ/mol as in Å and kcal/mol', () => {
  // PLUMED_UNITS_REPORT=1 prints the largest gaps found.
  const report = {};
  afterAll(() => {
    if (process.env.PLUMED_UNITS_REPORT && Object.keys(report).length) {
      console.log(`bias energies, kJ/mol against kcal/mol × 4.184:\n${JSON.stringify(report, null, 1)}`);
    }
  });

  /* What the five variables do on the walk, in nm, to put restraints where
     they act. */
  function observed(dir) {
    const cols = run(dir, 'observe', { units: NM, cvs: variables(NM), bias: { method: 'none' }, prints: [printAll] });
    return ['d', 'phi', 'g', 'cn', 'ip_lessthan'].map((k) => {
      const v = cols[k];
      return { median: round5(median(v)), min: round5(Math.min(...v)), max: round5(Math.max(...v)) };
    });
  }

  /* One value per argument, in nm and kJ/mol, and the same written in Å and
     kcal/mol by the page's rule for the keyword (exact: 4.184 times a round
     number of kcal/mol, and lengths of five figures). */
  const perArg = (method, key, list, powers, exp) => ({
    nm: list.join(','),
    A: list.map((v, i) => convertQuantity(String(v), biasKeywordUnit(method, key, {
      power: powers[i], exp: exp ? exp.split(',')[i] : ''
    }), NM, AK)).join(',')
  });

  withSymfunc('RESTRAINT, walls, MOVINGRESTRAINT and ABMD: every value converted by its own unit', () => {
    const dir = tmp();
    const obs = observed(dir);
    const powers = biasedArguments({ version: '2.11', syntax, cvs: variables(NM) }).map(t => t.power);
    expect(powers).toEqual([1, 0, 2, 0, 0]);
    const mid = obs.map(o => o.median);
    const spread = obs.map(o => round5((o.max - o.min) / 10));
    const kj = (k) => obs.map(() => Number((4.184 * k).toFixed(3)));
    const sets = {
      restraint: { AT: mid, KAPPA: kj(100), SLOPE: kj(10) },
      moving: { STEP0: '0', STEP1: '29', AT0: obs.map(o => o.min), AT1: obs.map(o => o.max), KAPPA0: kj(50), KAPPA1: kj(100) },
      upper: { AT: mid, KAPPA: kj(100), EXP: '4,2,2,2,2', EPS: '1,1,0.5,1,1', OFFSET: spread },
      lower: { AT: mid, KAPPA: kj(100), EXP: '2,2,4,2,2', EPS: '1,0.5,1,1,1', OFFSET: spread },
      abmd: { TO: obs.map(o => o.min), KAPPA: kj(10) }
    };
    for (const [method, set] of Object.entries(sets)) {
      const params = { nm: {}, A: {} };
      for (const [key, v] of Object.entries(set)) {
        if (Array.isArray(v)) {
          const x = perArg(method, key, v, powers, set.EXP);
          params.nm[key] = x.nm;
          params.A[key] = x.A;
        } else {
          params.nm[key] = v;
          params.A[key] = v;
        }
      }
      const cols = {};
      for (const [name, units] of [['nm', NM], ['A', AK]]) {
        cols[name] = run(dir, `${method}-${name}`, {
          units, cvs: variables(units), bias: { method, params: params[name] },
          prints: [{ ...printAll, args: [`${BIAS_DEFS[method].params[0].def}.*`], only: true }]
        });
      }
      const label = BIAS_DEFS[method].params[0].def;
      const energies = [`${label}.bias`, ...(method === 'moving' ? [`${label}.work`] : [])];
      const gap = compare(cols.nm, cols.A, energies);
      report[`${method} (every value by its rule)`] = gap;
      // The conversions are exact, so the energies agree to the last digits a
      // double carries (printed to ten decimals; a steep wall reaches 10⁵).
      expect(gap.rel).toBeLessThan(1e-11);
    }
  });

  withSymfunc('the page\'s own starting values, method and cards, agree to the six figures they are written with', () => {
    const dir = tmp();
    const obs = observed(dir);
    for (const method of ['restraint', 'moving', 'upper', 'lower', 'abmd']) {
      const cols = {};
      for (const [name, units] of [['nm', NM], ['A', AK]]) {
        const cvs = variables(units);
        const targets = biasedArguments({ version: '2.11', syntax, cvs }).map(t => ({ power: t.power }));
        const params = {};
        const exp = (BIAS_DEFS[method].params.find(p => p.k === 'EXP') || {}).def;
        for (const p of BIAS_DEFS[method].params) params[p.k] = startingParam(p, units, { method, targets, exp });
        // Cards beside the bias: AT is typed, so it is written by its rule;
        // KAPPA is the card's starting value.
        const powers = new Map(availableArguments({ version: '2.11', syntax, cvs }).map(a => [a.arg, a.power]));
        const card = (type, arg, at, extra = {}) => ({
          type, label: `${type}_${arg.replace(/\W/g, '')}`, arg,
          at: convertQuantity(String(at), biasKeywordUnit(type, 'AT', { power: powers.get(arg) }), NM, units),
          kappa: cardStarts(type, { power: powers.get(arg), exp: extra.exp }, units).kappa, ...extra
        });
        const restraints = [
          card('upper', 'd', obs[0].median, { exp: '4' }),
          card('lower', 'g', obs[2].median),
          card('restraint', 'ip_lessthan', obs[4].median),
          card('restraint', 'phi', obs[1].median)
        ];
        cols[name] = run(dir, `start-${method}-${name}`, {
          units, cvs, restraints, bias: { method, params },
          prints: [{ ...printAll, args: [`${params.LABEL}.bias`, ...restraints.map(r => `${r.label}.bias`)], only: true }]
        });
      }
      const label = BIAS_DEFS[method].params[0].def;
      const columns = Object.keys(cols.nm).filter(c => c.endsWith('.bias') && Math.max(...cols.nm[c].map(Math.abs)) > 0);
      expect(columns).toContain('restraint_ip_lessthan.bias');
      if (method !== 'lower') expect(columns).toContain(`${label}.bias`);
      const gap = compare(cols.nm, cols.A, columns);
      report[`${method} starting values, with cards`] = gap;
      expect(gap.rel).toBeLessThan(1e-5);
    }
  });

  withPlumed('METAD and OPES_METAD: HEIGHT, BARRIER, SIGMA and the grid, each by its unit', () => {
    const dir = tmp();
    for (const method of ['wt_metad', 'opes']) {
      const cols = {};
      for (const [name, units] of [['nm', NM], ['A', AK]]) {
        const cvs = variables(units).slice(0, 2);
        const [d, phi] = cvs;
        // SIGMA and the grid of the distance move by its length; the torsion's do not.
        const len = (v, p = 1) => convertLength(v, 'nm', units.length, p);
        Object.assign(d.biasValues, { min: '0.0', max: len('4.0'), bin: '400', sigma: len('0.05') });
        Object.assign(phi.biasValues, { min: '-pi', max: 'pi', bin: '200', sigma: '0.2' });
        const e = (v) => convertQuantity(v, { length: 0, energy: 1 }, NM, units);
        const params = method === 'opes'
          ? { PACE: '2', BARRIER: e('41.84'), TEMP: '300', SIGMA: `${len('0.05')},0.2` }
          : { PACE: '2', HEIGHT: e('4.184'), BIASFACTOR: '8', TEMP: '300' };
        cols[name] = run(dir, `${method}-${name}`, {
          units, cvs, bias: { method, params, grid: true, temp: '300' },
          prints: [{ ...printAll, args: [`${method === 'opes' ? 'opes' : 'metad'}.bias`], only: true }]
        });
      }
      const column = method === 'opes' ? 'opes.bias' : 'metad.bias';
      const gap = compare(cols.nm, cols.A, [column]);
      report[`${method} (every value by its rule)`] = gap;
      expect(gap.rel).toBeLessThan(1e-9);
    }
  });
});

describe('PLUMED 2.11: a count\'s starting grid holds what PLUMED prints', () => {
  withSymfunc('every count on a 100-atom lattice lies inside its starting grid', () => {
    const dir = tmp();
    const values = {
      INPLANEDISTANCES: { MORE_THAN: '{RATIONAL R_0=0.5}', BETWEEN: '{GAUSSIAN LOWER=0.1 UPPER=0.5 SMEAR=0.1}', SUM: true },
      Q6: { SUM: true, MORE_THAN: '{RATIONAL R_0=0.3}', LESS_THAN: '{RATIONAL R_0=0.3}' },
      COORDINATIONNUMBER: { SUM: true, MORE_THAN: '{RATIONAL R_0=4}', LESS_THAN: '{RATIONAL R_0=4}' },
      TETRA_RADIAL: { SUM: true, MORE_THAN: '{RATIONAL R_0=0.5}' },
      ANGLES: { MORE_THAN: '{RATIONAL R_0=1.5}', SWITCH: '', GROUP: '', GROUPA: '1-3', GROUPB: '11-20' },
      XANGLES: { MORE_THAN: '{RATIONAL R_0=1.5}' },
      TORSIONS: {}
    };
    const cvs = Object.entries(values).map(([type, v], i) => {
      const cv = createCV(type, i + 1, { version: '2.11', syntax, label: type.toLowerCase(), values: v });
      cv.bias = false;
      return cv;
    });
    const cols = run(dir, 'counts', { units: NM, cvs, bias: { method: 'none' }, prints: [printAll] }, false);
    let checked = 0;
    for (const cv of cvs) {
      for (const comp of componentsForCV(cv, CV_DEFS, { version: '2.11', syntax })) {
        const d = valueDomain(cv.type, comp, { values: cv.values });
        if (!d.count && !d.sum) continue;
        const name = `${cv.label}${comp}`.replace('.', '_');
        const printed = cols[name] || cols[`${cv.label}${comp}`];
        expect({ name, printed: !!printed }).toEqual({ name, printed: true });
        const g = defaultBiasValues(cv.type, comp, { values: cv.values });
        for (const v of printed) {
          expect({ name, inside: v >= Number(g.min) && v <= Number(g.max) }).toEqual({ name, inside: true });
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(12);
  });

  withPlumed('metadynamics on the count of in-plane distances runs on its grid, and stops on the old length grid', () => {
    const dir = tmp();
    const make = (grid) => {
      const cv = createCV('INPLANEDISTANCES', 1, { version: '2.11', syntax, label: 'ip' });
      Object.assign(cv.biasValues, grid);
      return { units: NM, cvs: [cv], bias: { method: 'wt_metad', params: { PACE: '1', TEMP: '300' }, grid: true, temp: '300' }, prints: [printAll] };
    };
    const cols = run(dir, 'ip-count', make({}));
    expect(Math.max(...cols.ip_lessthan)).toBeGreaterThan(5);
    expect(() => run(dir, 'ip-old', make({ min: '0.0', max: '5.0', sigma: '0.05' }))).toThrow(/plumed failed/);
  });

  withSymfunc('COORDINATION_MOMENTS with R_POWER=1 is a length: in Å it is ten times its value in nm', () => {
    const dir = tmp();
    const got = {};
    for (const [name, units] of [['nm', NM], ['A', AK]]) {
      const cv = createCV('COORDINATION_MOMENTS', 1, { version: '2.11', syntax, label: 'cm', values: { SPECIES: '1-50' } });
      cv.bias = false;
      cv.values = convertLengthDefaults(cv.values, lengthFields(CV_DEFS.COORDINATION_MOMENTS, 'COORDINATION_MOMENTS'), 'nm', units.length).values;
      got[name] = run(dir, `cm-${name}`, { units, cvs: [cv], bias: { method: 'none' }, prints: [printAll] });
    }
    const p = lengthPower('COORDINATION_MOMENTS', '.mean', { values: { R_POWER: '1' } });
    expect(p).toBe(1);
    got.nm.cm_mean.forEach((v, i) => expect(got.A.cm_mean[i]).toBeCloseTo(v * 10 ** p, 6));
    const p2 = lengthPower('COORDINATION_MOMENTS', '.moment-2', { values: { R_POWER: '1' } });
    got.nm['cm_moment-2'].forEach((v, i) => expect(got.A['cm_moment-2'][i]).toBeCloseTo(v * 10 ** p2, 5));
  });
});

test('the catalogue\'s units are PLUMED\'s own', () => {
  expect(CATALOGUE_UNITS).toEqual({ length: 'nm', energy: 'kj/mol' });
});
