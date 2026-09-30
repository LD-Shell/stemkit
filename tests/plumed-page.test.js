import { describe, test, expect, afterAll } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  sameValueName, findTarget, methodTemperature, restraintHelp, speedOptions, withLengthUnit,
  isLengthField, convertLength, convertLengthDefaults, distinctAtoms, withDistinctNames, atomKeyText,
  nextTicks, pickUnits, queryHasLength, loadedText, NUMBERING_NOTE, parseOnlyCommand, LENGTH_NAMES,
  convertBiasDefaults, convertEnergy, startingParam, ENERGY_PARAMS, modulesToEnable, pickOptions
} from '../js/script-generator-plumed-model.js';
import {
  CV_DEFS, BIAS_DEFS, createCV, generatePlumedInput, buildBiasLine, defaultBiasValues, lengthPower
} from '../src/core/plumed.js';
import { loadSyntax } from '../src/core/plumed-syntax.js';
import { parseStructure } from '../src/core/structure.js';
import {
  speciesOf, perMoleculeGroups, perMoleculeCenters, moleculeOrientations, selectForPlumed
} from '../src/core/plumed-atoms.js';
import { thermalEnergy } from '../src/core/plumed-analysis.js';

/*
 * The rules of the PLUMED tab (js/script-generator-plumed-model.js), each
 * checked against what the program it describes does. PLUMED and GROMACS
 * are run when they are installed (plumed on the PATH; GROMACS from GMX_BIN,
 * or gmx / gmx_mpi on the PATH); without them those tests are skipped.
 */

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const hasPlumed = spawnSync('plumed', ['--help'], { encoding: 'utf8' }).status === 0;
const withPlumed = hasPlumed ? test : test.skip;
const GMX = [process.env.GMX_BIN, 'gmx', 'gmx_mpi']
  .find(g => g && spawnSync(g, ['--version'], { encoding: 'utf8' }).status === 0) || '';
const withGromacs = GMX ? test : test.skip;

const made = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stemkit-plumed-page-'));
  made.push(dir);
  return dir;
};
afterAll(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
const plumed = (dir, args) => spawnSync('plumed', args, { cwd: dir, encoding: 'utf8' });
const fields = (file) => fs.readFileSync(file, 'utf8').split('\n')[0].replace(/^#! FIELDS\s+/, '').split(/\s+/);
const rows = (file) => fs.readFileSync(file, 'utf8').split('\n')
  .filter(l => l.trim() && !l.startsWith('#')).map(l => l.trim().split(/\s+/).map(Number));

/* 100 atoms on a jittered lattice 0.3 nm apart, as an xyz in nm. */
function latticeXyz(n = 100) {
  const lines = [String(n), '5 5 5'];
  for (let i = 0; i < n; i++) {
    const [x, y, z] = [i % 5, Math.floor(i / 5) % 5, Math.floor(i / 25)];
    const j = (k) => 0.02 * Math.sin(7 * i + k);
    lines.push(`X ${(0.3 * x + j(1)).toFixed(4)} ${(0.3 * y + j(2)).toFixed(4)} ${(0.3 * z + j(3)).toFixed(4)}`);
  }
  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ */

describe('Analyse: a biased multicolvar is found in a 2.10+ COLVAR', () => {
  test('label.comp is the column label_comp; an exact name wins', () => {
    expect(sameValueName('cv1.mean', 'cv1_mean')).toBe(true);
    expect(sameValueName('cv2.morethan-2', 'cv2_morethan-2')).toBe(true);
    expect(sameValueName('cv1.mean', 'cv1.mean')).toBe(true);
    expect(sameValueName('cv3', 'cv3')).toBe(true);
    expect(sameValueName('cv1.mean', 'cv1_morethan')).toBe(false);
    expect(sameValueName('cv3', 'cv3_mean')).toBe(false);
    expect(sameValueName('', '')).toBe(false);
    const targets = [{ arg: 'd.x' }, { arg: 'd_x' }];
    expect(findTarget(targets, 'd_x')).toBe(targets[1]);
    expect(findTarget(targets, 'd.x')).toBe(targets[0]);
    expect(findTarget([{ arg: 'cv1.mean' }], 'cv1_mean')).toEqual({ arg: 'cv1.mean' });
    expect(findTarget(undefined, 'x')).toBeUndefined();
  });

  withPlumed('every value the 2.11 builder biases is matched to the column PLUMED 2.11 writes', async () => {
    const syntax = await loadSyntax('2.11');
    const opts = { version: '2.11', syntax };
    const q6 = createCV('Q6', 1, { ...opts, label: 'cv1' });
    const cn = createCV('COORDINATIONNUMBER', 2, { ...opts, label: 'cv2' });
    Object.assign(cn.values, { SPECIES: '1-100', MORE_THAN: '{RATIONAL R_0=0.3};{RATIONAL R_0=0.5}' });
    cn.biasValues.comp = '.morethan-2';
    const d = createCV('DISTANCE', 3, { ...opts, label: 'cv3' });
    d.values.ATOMS = '1,2';
    const g = generatePlumedInput({
      version: '2.11', syntax, cvs: [q6, cn, d], bias: { method: 'none' }, prints: [{ file: 'COLVAR', stride: 1 }]
    });
    expect(g.biased).toEqual(['cv1.mean', 'cv2.morethan-2', 'cv3']);
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'plumed.dat'), g.input);
    fs.writeFileSync(path.join(dir, 'lattice.xyz'), latticeXyz());
    const r = plumed(dir, ['driver', '--plumed', 'plumed.dat', '--ixyz', 'lattice.xyz']);
    expect(r.status).toBe(0);
    const header = fields(path.join(dir, 'COLVAR'));
    // What the page used to look for is not there.
    expect(header).not.toContain('cv1.mean');
    const targets = g.biased.map(arg => ({ arg }));
    for (const t of targets) {
      expect(header.some(col => findTarget(targets, col) === t)).toBe(true);
    }
    expect(findTarget(targets, 'cv1_mean').arg).toBe('cv1.mean');
    expect(findTarget(targets, 'cv2_morethan-2').arg).toBe('cv2.morethan-2');
  });
});

describe('Analyse: the temperature is the one the file is written for', () => {
  test('the method\'s TEMP overrides the global one, as in the file', () => {
    expect(methodTemperature({ TEMP: '350' }, '300')).toBe(350);
    expect(methodTemperature({ TEMP: '' }, '300')).toBe(300);
    expect(methodTemperature({ TEMP: '310,5' }, '300')).toBe(310.5);
    expect(methodTemperature({}, '298')).toBe(298);
    expect(methodTemperature(undefined, '')).toBeNaN();
    // The file of the finding: TEMP=350 in the method, 300 globally.
    const g = generatePlumedInput({
      version: '2.11',
      cvs: [{ ...createCV('DISTANCE', 1, { version: '2.11' }), values: { ATOMS: '1,2' } }],
      bias: { method: 'wt_metad', params: { TEMP: '350' }, temp: '300', grid: true },
      prints: [{ file: 'COLVAR', stride: '100' }]
    });
    expect(g.input).toMatch(/TEMP=350/);
    expect(thermalEnergy(methodTemperature({ TEMP: '350' }, '300'), 'kj/mol')).toBeCloseTo(2.91, 2);
  });
});

describe('Walls and restraints: the help gives PLUMED\'s formulas', () => {
  const energy = {
    restraint: (x, at, k) => 0.5 * k * (x - at) ** 2,
    upper: (x, at, k, off) => (x > at - off ? k * (x - at + off) ** 2 : 0),
    lower: (x, at, k, off) => (x < at + off ? k * (at + off - x) ** 2 : 0)
  };

  test('RESTRAINT has the ½ and no wall; each wall says which way OFFSET moves it', () => {
    const r = restraintHelp('restraint');
    expect(r.kappa).toMatch(/½ KAPPA \(x − AT\)²/);
    expect(r.kappa).not.toMatch(/power EXP|past the wall/);
    expect(r.exp).toBeUndefined();
    expect(r.offset).toBeUndefined();
    expect(restraintHelp('upper').offset).toMatch(/down to AT − OFFSET/);
    expect(restraintHelp('lower').offset).toMatch(/up to AT \+ OFFSET/);
    expect(restraintHelp('upper').kappa).toMatch(/power EXP/);
  });

  withPlumed('PLUMED 2.11 gives the energies the help describes', () => {
    const dir = tmp();
    const seps = [1.0, 1.4, 1.6, 2.0, 2.4, 2.6, 3.0];
    fs.writeFileSync(path.join(dir, 'two.xyz'),
      seps.map(s => `2\n10 10 10\nX 0 0 0\nX ${s} 0 0\n`).join(''));
    fs.writeFileSync(path.join(dir, 'w.dat'), [
      'd: DISTANCE ATOMS=1,2 NOPBC',
      'uw: UPPER_WALLS ARG=d AT=2.0 KAPPA=100 OFFSET=0.5',
      'lw: LOWER_WALLS ARG=d AT=2.0 KAPPA=100 OFFSET=0.5',
      'r: RESTRAINT ARG=d AT=2.0 KAPPA=100',
      'PRINT ARG=d,uw.bias,lw.bias,r.bias FILE=CW STRIDE=1', ''
    ].join('\n'));
    expect(plumed(dir, ['driver', '--plumed', 'w.dat', '--ixyz', 'two.xyz']).status).toBe(0);
    for (const [, d, uw, lw, r] of rows(path.join(dir, 'CW'))) {
      expect(r).toBeCloseTo(energy.restraint(d, 2, 100), 4);
      expect(uw).toBeCloseTo(energy.upper(d, 2, 100, 0.5), 4);
      expect(lw).toBeCloseTo(energy.lower(d, 2, 100, 0.5), 4);
    }
  });
});

describe('Speed options: a box is shown only where the method uses it', () => {
  const target = [{ arg: 'd', label: 'd', type: 'DISTANCE', min: '0', max: '3', bin: '300', sigma: '0.05' }];
  const params = { PACE: '500', HEIGHT: '1.2', BIASFACTOR: '10', TEMP: '300', BARRIER: '40' };
  const line = (method, o) => buildBiasLine(method, target, params, { walkers: { mode: 'none' }, ...o }).lines.join('\n');

  test.each(['metad', 'wt_metad', 'pbmetad', 'opes'])('%s: a hidden box would change nothing', (method) => {
    const use = speedOptions(method);
    expect(use.panel).toBe(true);
    const rct = line(method, { grid: true, rct: true }) !== line(method, { grid: true, rct: false });
    const grid = line(method, { grid: true, rct: false }) !== line(method, { grid: false, rct: false });
    expect(use.rct).toBe(rct);
    expect(use.grid).toBe(grid);
    expect(!!use.note).toBe(!use.rct || !use.grid);
  });

  test('the other methods have no speed panel', () => {
    for (const m of Object.keys(BIAS_DEFS).filter(k => !['metad', 'wt_metad', 'pbmetad', 'opes'].includes(k))) {
      expect(speedOptions(m).panel).toBe(false);
    }
    expect(speedOptions('none').panel).toBe(false);
  });
});

describe('Length units: the cards follow UNITS LENGTH', () => {
  test('labels and help carry the chosen unit', () => {
    expect(withLengthUnit('R_0 (nm)', 'A')).toBe('R_0 (Å)');
    expect(withLengthUnit('R_0 (nm)', 'nm')).toBe('R_0 (nm)');
    expect(withLengthUnit('D_MAX (nm)', 'um')).toBe('D_MAX (µm)');
    expect(withLengthUnit('The r_0 parameter (nm): paper value 0.08 nm.', 'Bohr'))
      .toBe('The r_0 parameter (Bohr): paper value 0.08 nm.');
    expect(Object.keys(LENGTH_NAMES)).toEqual(['nm', 'A', 'um', 'Bohr']);
    expect(isLengthField({ label: 'R_0 (nm)' })).toBe(true);
    expect(isLengthField({ label: 'NN' })).toBe(false);
  });

  test('starting values move with the unit; typed values stay as typed', () => {
    expect(convertLength('0.3', 'nm', 'A')).toBe('3');
    expect(convertLength('3', 'A', 'nm')).toBe('0.3');
    expect(convertLength('0.3', 'nm', 'Bohr')).toBe('5.66918');
    expect(convertLength('pi', 'nm', 'A')).toBe('pi');
    const def = CV_DEFS.COORDINATION;
    const cv = createCV('COORDINATION', 1, { version: '2.11' });
    const toA = convertLengthDefaults(cv.values, def.fields, 'nm', 'A');
    expect(toA.values.R_0).toBe('3');
    expect(toA.changed).toContain('R_0');
    const typed = { ...toA.values, R_0: '4.5' };
    const back = convertLengthDefaults(typed, def.fields, 'A', 'nm');
    expect(back.values.R_0).toBe('4.5');
    // Back in nm, a starting value is the catalogue's own text again.
    expect(back.values.D_0).toBe('0.0');
    expect(convertLengthDefaults(cv.values, def.fields, 'nm', 'nm').changed).toEqual([]);
    // NN is a number of no unit.
    expect(toA.values.NN).toBe(cv.values.NN);
  });

  withPlumed('R_0 moved to Å or Bohr gives PLUMED the same coordination as in nm', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'lattice.xyz'), latticeXyz());
    const values = {};
    for (const unit of ['nm', 'A', 'Bohr']) {
      const cv = createCV('COORDINATION', 1, { version: '2.11', label: 'cn' });
      Object.assign(cv.values, { GROUPA: '1-10', GROUPB: '11-60' });
      cv.values = convertLengthDefaults(cv.values, CV_DEFS.COORDINATION.fields, 'nm', unit).values;
      const g = generatePlumedInput({
        version: '2.11', units: { length: unit, energy: 'kj/mol', time: 'ps' }, cvs: [cv],
        bias: { method: 'none' }, prints: [{ file: `C_${unit}`, stride: 1 }]
      });
      fs.writeFileSync(path.join(dir, `${unit}.dat`), g.input);
      expect(plumed(dir, ['driver', '--plumed', `${unit}.dat`, '--ixyz', 'lattice.xyz']).status).toBe(0);
      values[unit] = rows(path.join(dir, `C_${unit}`))[0][1];
    }
    expect(values.nm).toBeGreaterThan(1);
    expect(values.A).toBeCloseTo(values.nm, 6);
    expect(values.Bohr / values.nm).toBeCloseTo(1, 5);
  });
});

describe('Units: grids, SIGMA and energies start in the chosen unit', () => {
  test('a length\'s grid bounds and SIGMA move while they are starting values', () => {
    expect(convertLength('1', 'nm', 'A', 2)).toBe('100');
    expect(convertLength('1', 'nm', 'A', 0)).toBe('1');
    const d = createCV('DISTANCE', 1, { version: '2.11' });
    const start = defaultBiasValues('DISTANCE', '');
    const toA = convertBiasDefaults(d.biasValues, start, lengthPower('DISTANCE'), 'nm', 'A');
    expect(toA.values).toMatchObject({ min: '0.0', max: '50', sigma: '0.5', bin: start.bin });
    expect(toA.changed).toEqual(['max', 'sigma']);
    // Typed values are left alone, and going back gives the catalogue's numbers.
    const typed = convertBiasDefaults({ ...toA.values, max: '30' }, start, 1, 'A', 'nm');
    expect(typed.values).toMatchObject({ max: '30', sigma: '0.05' });
    // An area scales by the square; an angle or a count not at all.
    const plane = convertBiasDefaults(defaultBiasValues('PLANE', '.x'), defaultBiasValues('PLANE', '.x'),
      lengthPower('PLANE', '.x'), 'nm', 'A');
    expect(plane.values).toMatchObject({ min: '-100', max: '100', sigma: '1' });
    const phi = defaultBiasValues('TORSION', '');
    expect(convertBiasDefaults(phi, phi, lengthPower('TORSION'), 'nm', 'A').changed).toEqual([]);
  });

  test('HEIGHT and BARRIER start in the energy unit; typed values and other parameters do not move', () => {
    expect(ENERGY_PARAMS).toEqual(['HEIGHT', 'BARRIER']);
    const height = BIAS_DEFS.wt_metad.params.find(p => p.k === 'HEIGHT');
    expect(startingParam(height, 'kj/mol')).toBe('1.2');
    expect(startingParam(height, 'kcal/mol')).toBe('0.287');
    expect(startingParam(BIAS_DEFS.opes.params.find(p => p.k === 'BARRIER'), 'kcal/mol')).toBe('7.17');
    expect(startingParam(BIAS_DEFS.wt_metad.params.find(p => p.k === 'PACE'), 'eV')).toBe('500');
    expect(convertEnergy('4.184', 'kj/mol', 'kcal/mol')).toBe('1');
    expect(convertEnergy('x', 'kj/mol', 'eV')).toBe('x');
  });

  withPlumed('a biased distance in Å, grid and SIGMA moved, gets the bias it gets in nm', () => {
    const dir = tmp();
    const frames = Array.from({ length: 40 }, (_, i) =>
      `2\n3 3 3\nX 1 1 1\nX 1.3 1 ${(1 + 0.004 * i).toFixed(4)}`).join('\n');
    fs.writeFileSync(path.join(dir, 'pair.xyz'), `${frames}\n`);
    const bias = {};
    for (const [length, energy] of [['nm', 'kj/mol'], ['A', 'kj/mol'], ['nm', 'kcal/mol']]) {
      const name = `${length}_${energy.replace('/', '')}`;
      const cv = createCV('DISTANCE', 1, { version: '2.11', label: 'd' });
      cv.biasValues = convertBiasDefaults(cv.biasValues, defaultBiasValues('DISTANCE', ''),
        lengthPower('DISTANCE'), 'nm', length).values;
      const params = { PACE: '1', BIASFACTOR: '10', HEIGHT: startingParam(BIAS_DEFS.wt_metad.params[1], energy) };
      const g = generatePlumedInput({
        version: '2.11', units: { length, energy, time: 'ps' }, cvs: [cv],
        bias: { method: 'wt_metad', temp: '300', grid: true, params },
        prints: [{ file: `C_${name}`, stride: 1, args: ['metad.bias'], only: true }]
      });
      fs.writeFileSync(path.join(dir, `${name}.dat`), g.input);
      const r = plumed(dir, ['driver', '--plumed', `${name}.dat`, '--ixyz', 'pair.xyz']);
      expect({ name, status: r.status }).toEqual({ name, status: 0 });
      bias[name] = rows(path.join(dir, `C_${name}`)).map(row => row[1]);
    }
    const last = bias.nm_kjmol[bias.nm_kjmol.length - 1];
    expect(last).toBeGreaterThan(1);
    bias.A_kjmol.forEach((v, i) => expect(v).toBeCloseTo(bias.nm_kjmol[i], 6));
    // 0.287 kcal/mol is 1.2008 kJ/mol: the same bias to three figures.
    bias.nm_kcalmol.forEach((v, i) => {
      expect(Math.abs(v * 4.184 - bias.nm_kjmol[i])).toBeLessThanOrEqual(2e-3 * bias.nm_kjmol[i] + 1e-9);
    });
  });
});

describe('Modules: a card names every module a default build leaves out', () => {
  test('a 2.10+ shortcut needs the modules of what it expands to', async () => {
    const v211 = await loadSyntax('2.11');
    expect(modulesToEnable(v211, 'Q6')).toEqual(['symfunc', 'adjmat']);
    expect(modulesToEnable(v211, 'DISTANCE')).toEqual([]);
    expect(modulesToEnable(v211, 'OPES_METAD')).toEqual(['opes']);
    expect(modulesToEnable(await loadSyntax('2.9'), 'Q6')).toEqual(['crystallization']);
    expect(modulesToEnable(null, 'Q6')).toEqual([]);
    expect(modulesToEnable(v211, 'NOT_AN_ACTION')).toEqual([]);
  });

  withPlumed('the command the note gives checks every module at once', () => {
    const r = plumed(os.tmpdir(), ['config', 'module', 'symfunc', 'adjmat']);
    expect(r.stdout).toMatch(/^symfunc (on|off)$/m);
    expect(r.stdout).toMatch(/^adjmat (on|off)$/m);
  });
});

describe('Atoms: a tick picks that atom, in the order ticked', () => {
  const L = (n, name, r, x) => `HETATM${String(n).padStart(5)}  ${name.padEnd(3)} UNL  ${String(r).padStart(4)}    ` +
    `${[x, 0, 0].map(v => v.toFixed(3).padStart(8)).join('')}  1.00  0.00`;
  // Two copies of C-C-O named by element, as Open Babel names them (Å).
  const pdb = [L(1, 'C', 1, 1), L(2, 'C', 1, 2.5), L(3, 'O', 1, 3), L(4, 'C', 2, 11), L(5, 'C', 2, 12.5),
    L(6, 'O', 2, 13), 'END'].join('\n');
  const atoms = parseStructure(pdb, 'x.pdb').atoms;
  const keyed = withDistinctNames(atoms, 'UNL');

  test('atoms that share a name get keys by their place', () => {
    expect(distinctAtoms(['C', 'C', 'O', 'H', 'H'])).toEqual([
      { name: 'C', key: 'C', nth: 1, of: 2, text: 'C (1st)' }, { name: 'C', key: 'C#2', nth: 2, of: 2, text: 'C (2nd)' },
      { name: 'O', key: 'O', nth: 1, of: 1, text: 'O' }, { name: 'H', key: 'H', nth: 1, of: 2, text: 'H (1st)' },
      { name: 'H', key: 'H#2', nth: 2, of: 2, text: 'H (2nd)' }
    ]);
    expect(atomKeyText('C#2')).toBe('C (2nd)');
    expect(atomKeyText('C', ['C', 'C', 'O'])).toBe('C (1st)');
    expect(atomKeyText('O', ['C', 'C', 'O'])).toBe('O');
    expect(atomKeyText('H#11')).toBe('H (11th)');
    expect(atomKeyText('H#23')).toBe('H (23rd)');
    expect(atomKeyText('O')).toBe('O');
    expect(keyed.map(a => a.atomName)).toEqual(['C', 'C#2', 'O', 'C', 'C#2', 'O']);
    expect(atoms.map(a => a.atomName)).toEqual(['C', 'C', 'O', 'C', 'C', 'O']);
    expect(withDistinctNames(atoms, 'SOL')).toEqual(atoms);
  });

  test('the second C is the second C of every copy, for groups, centres and directions', () => {
    expect(perMoleculeGroups(keyed, 'UNL', ['C#2']).lines).toEqual(['C_2: GROUP ATOMS=2,5']);
    expect(perMoleculeCenters(keyed, 'UNL', { atomNames: ['C'], prefix: 'c' }).lines)
      .toEqual(['c1: CENTER ATOMS=1', 'c2: CENTER ATOMS=4']);
    const r = moleculeOrientations(keyed, 'UNL', { start: 'C', end: 'C#2', version: '2.11', label: 'unl_dir' });
    expect(r.warnings).toEqual([]);
    expect(r.lines).toContain('  ATOMS1=1,2 LOCATION1=1');
    const back = moleculeOrientations(keyed, 'UNL', { start: 'O', end: 'C', version: '2.11' });
    expect(back.lines).toContain('  ATOMS1=3,1 LOCATION1=3');
  });

  test('the order of ticking is kept', () => {
    let t = [];
    t = nextTicks(t, 2, true);
    t = nextTicks(t, 0, true);
    expect(t).toEqual([2, 0]);
    t = nextTicks(t, 2, false);
    t = nextTicks(t, 2, true);
    expect(t).toEqual([0, 2]);
    expect(nextTicks(undefined, 1, false)).toEqual([]);
  });

  withPlumed('PLUMED 2.11 reads the direction as C to the second C, not a zero vector', () => {
    const dir = tmp();
    const r = moleculeOrientations(keyed, 'UNL', { start: 'C', end: 'C#2', version: '2.11', label: 'unl_dir' });
    fs.writeFileSync(path.join(dir, 'dir.dat'), `${r.lines.join('\n')}\nPRINT ARG=unl_dir.x FILE=CD\n`);
    fs.writeFileSync(path.join(dir, 'six.xyz'), `6\n10 10 10\n${atoms.map(a =>
      `X ${(a.x / 10).toFixed(3)} ${(a.y / 10).toFixed(3)} ${(a.z / 10).toFixed(3)}`).join('\n')}\n`);
    expect(plumed(dir, ['driver', '--plumed', 'dir.dat', '--ixyz', 'six.xyz']).status).toBe(0);
    const [, x1, x2] = rows(path.join(dir, 'CD'))[0];
    expect(x1).toBeCloseTo(0.15, 5);
    expect(x2).toBeCloseTo(0.15, 5);
  });
});

describe('Atoms: distances in a selection are in nm, whatever the file', () => {
  // A ligand, a water 0.3 nm from it and one 0.8 nm from it.
  const pdb = [
    'HETATM    1  C1  LIG A   1       0.000   0.000   0.000  1.00  0.00           C',
    'HETATM    2  OW  SOL A   2       3.000   0.000   0.000  1.00  0.00           O',
    'HETATM    3  OW  SOL A   3       8.000   0.000   0.000  1.00  0.00           O',
    'END'
  ].join('\n');
  const gro = ['three', '    3',
    '    1LIG     C1    1   0.000   0.000   0.000',
    '    2SOL     OW    2   0.300   0.000   0.000',
    '    3SOL     OW    3   0.800   0.000   0.000',
    '   2.00000   2.00000   2.00000', ''].join('\n');
  const count = (text, name, q) => {
    const p = parseStructure(text, name);
    return selectForPlumed(p.atoms, q, pickUnits(p.unit)).count;
  };

  test('within:0.5 means 0.5 nm for a PDB and a .gro alike', () => {
    expect(pickUnits('A')).toEqual({ unit: 'nm', coordinateUnit: 'A' });
    expect(pickUnits('nm')).toEqual({ unit: 'nm', coordinateUnit: 'nm' });
    expect(count(pdb, 'x.pdb', 'within:0.5,resn:LIG')).toBe(2);
    expect(count(gro, 'x.gro', 'within:0.5,resn:LIG')).toBe(2);
    expect(count(pdb, 'x.pdb', 'x:0.5-1')).toBe(1);
    expect(queryHasLength('within:0.5,resn:LIG')).toBe(true);
    expect(queryHasLength('resn:SOL !x:0-1')).toBe(true);
    expect(queryHasLength('resn:UREA atom:C')).toBe(false);
  });

  withGromacs('the same structure as PDB and as gmx editconf\'s .gro selects the same atoms', () => {
    const src = path.join(ROOT, 'gromacs-2025.1/src/gromacs/gmxpreprocess/tests/cyc-rna.pdb');
    const dir = tmp();
    const input = fs.existsSync(src) ? src : path.join(dir, 'x.pdb');
    if (!fs.existsSync(src)) fs.writeFileSync(input, `CRYST1   20.000   20.000   20.000  90.00  90.00  90.00 P 1           1\n${pdb}\n`);
    const r = spawnSync(GMX, ['editconf', '-f', input, '-o', path.join(dir, 'x.gro')], { cwd: dir, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const pdbText = fs.readFileSync(input, 'utf8');
    const groText = fs.readFileSync(path.join(dir, 'x.gro'), 'utf8');
    const resn = parseStructure(pdbText, 'x.pdb').atoms[0].resName;
    const q = `within:0.5,resn:${resn}`;
    expect(count(pdbText, 'x.pdb', q)).toBe(count(groText, 'x.gro', q));
    expect(count(pdbText, 'x.pdb', q)).toBeGreaterThan(
      parseStructure(pdbText, 'x.pdb').atoms.filter(a => a.resName === resn).length);
  });
});

describe('Atoms: within: measures through the periodic box, as gmx select does', () => {
  // A ligand near one corner of a 2 nm box, a water 0.17 nm from it through
  // the corner, and one in the middle of the box.
  const gro = ['corner', '    3',
    '    1LIG     C1    1   0.050   0.050   0.050',
    '    2SOL     OW    2   1.950   1.950   0.050',
    '    3SOL     OW    3   1.000   1.000   1.000',
    '   2.00000   2.00000   2.00000', ''].join('\n');
  const pdb = (cryst) => [cryst,
    'HETATM    1  C1  LIG A   1       0.500   0.500   0.500  1.00  0.00           C',
    'HETATM    2  OW  SOL A   2      19.500  19.500   0.500  1.00  0.00           O',
    'HETATM    3  OW  SOL A   3      10.000  10.000  10.000  1.00  0.00           O',
    'END'].join('\n');
  const pick = (text, name, q) => {
    const p = parseStructure(text, name);
    return selectForPlumed(p.atoms, q, pickOptions(p)).indices;
  };

  test('the file\'s box goes with the query, in nm', () => {
    const p = parseStructure(gro, 'x.gro');
    expect(pickOptions(p)).toEqual({ unit: 'nm', coordinateUnit: 'nm', box: [2, 2, 2], boxVectors: null });
    expect(pick(gro, 'x.gro', 'within:0.3,resn:LIG')).toEqual([1, 2]);
    expect(selectForPlumed(p.atoms, 'within:0.3,resn:LIG', pickUnits(p.unit)).indices).toEqual([1]);
    const withCell = pdb('CRYST1   20.000   20.000   20.000  90.00  90.00  90.00 P 1           1');
    expect(pickOptions(parseStructure(withCell, 'x.pdb')).box).toEqual([2, 2, 2]);
    expect(pick(withCell, 'x.pdb', 'within:0.3,resn:LIG')).toEqual([1, 2]);
  });

  test('a PDB\'s CRYST1 of 1 Å, which means no cell, is not measured through', () => {
    const none = pdb('CRYST1    1.000    1.000    1.000  90.00  90.00  90.00 P 1           1');
    expect(pickOptions(parseStructure(none, 'x.pdb'))).toMatchObject({ box: null, boxVectors: null });
    expect(pick(none, 'x.pdb', 'within:0.3,resn:LIG')).toEqual([1]);
    expect(pick(pdb(''), 'x.pdb', 'within:0.3,resn:LIG')).toEqual([1]);
  });

  test('what the reader warned of is part of the load message', () => {
    const two = ['MODEL        1',
      'ATOM      1  CA  ALA A   1       0.000   0.000   0.000  1.00  0.00           C', 'ENDMDL',
      'MODEL        2',
      'ATOM      1  CA  ALA A   1       1.000   0.000   0.000  1.00  0.00           C', 'ENDMDL', 'END'].join('\n');
    const p = parseStructure(two, 'two.pdb');
    expect(p.warnings.length).toBeGreaterThan(0);
    const text = loadedText('two.pdb', p.atoms.length, speciesOf(p.atoms), p.warnings);
    expect(text).toBe(`two.pdb: 1 atom in 1 residue. ${p.warnings.join(' ')}`);
    expect(text).toMatch(/only the first was read/);
    expect(loadedText('one.gro', 1, [{ molecules: 1 }], [])).toBe('one.gro: 1 atom in 1 residue.');
  });

  withGromacs('the atoms are the ones gmx select finds', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'x.gro'), gro);
    const r = spawnSync(GMX, ['select', '-s', 'x.gro', '-select', 'within 0.3 of resname LIG', '-on', 'x.ndx'],
      { cwd: dir, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const ndx = fs.readFileSync(path.join(dir, 'x.ndx'), 'utf8');
    const theirs = ndx.split('\n').filter(l => l.trim() && !l.startsWith('[')).join(' ').trim().split(/\s+/).map(Number);
    expect(pick(gro, 'x.gro', 'within:0.3,resn:LIG')).toEqual(theirs);
  });
});

describe('Atoms: the page says residues and how PLUMED numbers atoms', () => {
  test('a peptide and waters are counted as residues', () => {
    const gro = ['pep', '    9',
      '    1ALA      N    1   0.000   0.000   0.000',
      '    1ALA     CA    2   0.100   0.000   0.000',
      '    1ALA      C    3   0.200   0.000   0.000',
      '    2GLY      N    4   0.300   0.000   0.000',
      '    2GLY     CA    5   0.400   0.000   0.000',
      '    2GLY      C    6   0.500   0.000   0.000',
      '    3SOL     OW    7   1.000   0.000   0.000',
      '    4SOL     OW    8   1.300   0.000   0.000',
      '    5SOL     OW    9   1.600   0.000   0.000',
      '   2.00000   2.00000   2.00000', ''].join('\n');
    const p = parseStructure(gro, 'pep.gro');
    expect(loadedText('pep.gro', p.atoms.length, speciesOf(p.atoms))).toBe('pep.gro: 9 atoms in 5 residues.');
    expect(loadedText('one.gro', 1, [{ molecules: 1 }])).toBe('one.gro: 1 atom in 1 residue.');
  });

  test('the numbering is stated for GROMACS, with the LAMMPS exception', () => {
    expect(NUMBERING_NOTE).toMatch(/GROMACS/);
    expect(NUMBERING_NOTE).toMatch(/LAMMPS PLUMED uses the atom IDs/);
    const fix = path.join(ROOT, 'lammps/src/PLUMED/fix_plumed.cpp');
    if (fs.existsSync(fix)) expect(fs.readFileSync(fix, 'utf8')).toMatch(/gatindex\[i\]=atom->tag\[i\]-1/);
  });
});

describe('Checking a file: the parse-only command PLUMED accepts', () => {
  test('the atom count is always given', () => {
    expect(parseOnlyCommand(11655)).toBe('plumed driver --plumed plumed.dat --natoms 11655 --parse-only');
    expect(parseOnlyCommand(0)).toBe('plumed driver --plumed plumed.dat --natoms N --parse-only');
    expect(parseOnlyCommand(undefined, 'in.dat')).toBe('plumed driver --plumed in.dat --natoms N --parse-only');
  });

  withPlumed('PLUMED 2.11 runs the command, and refuses it without --natoms', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'plumed.dat'), 'd: DISTANCE ATOMS=1,2\nPRINT ARG=d FILE=COLVAR\n');
    const args = parseOnlyCommand(100).split(' ').slice(1);
    expect(plumed(dir, args).status).toBe(0);
    const bare = plumed(dir, ['driver', '--plumed', 'plumed.dat', '--parse-only']);
    expect(`${bare.stdout}${bare.stderr}`).toMatch(/--natoms/);
  });
});

describe('The PLUMED panels promise only what the page does', () => {
  const html = fs.readFileSync(path.join(ROOT, 'script-generator.html'), 'utf8');
  const start = html.indexOf('id="plumedStructTitle"');
  const end = html.indexOf('<!-- OUTPUT COLUMN -->');
  const plumedPanels = html.slice(start, end);

  test('no PLUMED run files are promised', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(plumedPanels).not.toMatch(/under Run files/);
    expect(plumedPanels).not.toMatch(/run files write one input per walker/i);
    expect(plumedPanels).toMatch(/download each with its button/);
  });

  test('the atom count is not said to complete the check command', () => {
    const tip = /for="plumedNatoms"[^>]*>[^<]*<span[^>]*data-tip="([^"]*)"/.exec(plumedPanels);
    expect(tip && tip[1]).toBeTruthy();
    expect(tip[1]).not.toMatch(/complete/);
    expect(tip[1]).toMatch(/--natoms N/);
  });

  test('the speed panel has a note for the boxes a method hides', () => {
    expect(plumedPanels).toMatch(/id="plumedSpeedNote"/);
  });

  test('the units note says which starting values follow a new unit', () => {
    expect(plumedPanels).toMatch(/Starting values you have not changed follow the new units, each by its own unit \(lengths and switching functions, a length's grid and SIGMA, HEIGHT and BARRIER, and the AT and KAPPA of restraints and walls; a count or an angle has no length\)/);
  });

  test('a clean check claims only what the checks cover', () => {
    const check = fs.readFileSync(path.join(ROOT, 'js/script-generator-plumed-check.js'), 'utf8');
    expect(check).toContain('No problems found by these checks');
    expect(check).not.toContain('Nothing that stops PLUMED');
  });
});

describe('The PLUMED files another tab can zip', () => {
  test('currentPlumedFiles gives the input and the files it INCLUDEs, as the tab writes them', async () => {
    // The tab's module draws in a browser; a stand-in is enough to build a file.
    const had = { window: globalThis.window, document: globalThis.document };
    globalThis.window = { matchMedia: () => ({ matches: true, addEventListener() {}, addListener() {} }), addEventListener() {} };
    globalThis.document = { querySelectorAll: () => [], getElementById: () => null, addEventListener() {} };
    try {
      const { createPlumedBuilder, currentPlumedFiles } = await import('../js/script-generator-plumed.js');
      expect(await currentPlumedFiles()).toEqual([]);
      const fields = { plumedVersion: '2.11', plumedBias: 'none', plumedInclude: '', plumedNatoms: '' };
      const el = (id) => ({ id, value: fields[id], addEventListener() {} });
      let shown = '';
      const ctx = {
        $: (id) => (id === 'plumedVersion' || id === 'slurmOutput' ? el(id) : null),
        getStr: (id, d = '') => (fields[id] !== undefined ? fields[id] : d),
        isChecked: () => false, setWarnings() {}, escapeHtml: (x) => String(x),
        renderOutput: (node, text) => { shown = text; }
      };
      const tab = createPlumedBuilder(ctx);
      expect(await currentPlumedFiles()).toEqual([]);
      tab.restore({
        cvs: [{ id: 'cv1', type: 'DISTANCE', label: 'd', values: { ATOMS: '1,2' } }],
        files: { 'centres.dat': { text: 'c1: CENTER ATOMS=1-8\n', labels: ['c1'] } }
      });
      fields.plumedInclude = 'centres.dat elsewhere.dat';
      const files = await currentPlumedFiles('md.plumed');
      expect(files.map(f => f.name)).toEqual(['md.plumed', 'centres.dat']);
      expect(files[1].text).toBe('c1: CENTER ATOMS=1-8\n');
      // The same file the tab shows in its output pane.
      tab.generate();
      expect(files[0].text).toBe(`${shown}\n`);
      expect(files[0].text).toMatch(/^# Target: PLUMED 2\.11$/m);
      expect(files[0].text).toMatch(/^INCLUDE FILE=centres\.dat$/m);
      expect(files[0].text).toMatch(/^d: DISTANCE ATOMS=1,2$/m);
      expect((await currentPlumedFiles())[0].name).toBe('plumed.dat');
    } finally {
      globalThis.window = had.window;
      globalThis.document = had.document;
    }
  });
});
