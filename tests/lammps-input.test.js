import { describe, test, expect, beforeAll } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  parseInput, stripComment, splitWords, findSubstitutions, formatC, formatPs, isLammpsNumber, isLammpsInteger,
  checkInput, checkChain, explainInput, explainChain, loadLammpsDetails, UNITS, lammpsDocUrl
} from '../src/core/lammps-input.js';
import { LMP_FORCE_FIELDS, buildLammpsWorkflow, defaultLammpsState } from '../src/core/lammps-workflow.js';
import { parseDataFile, summariseData } from '../src/core/lammps-data.js';
import { bigWaterSystem } from './fixtures/lammps-data/big-system.mjs';

beforeAll(() => loadLammpsDetails());

/* A small LJ system that LAMMPS runs as it is; tests change one line. */
const LJ = [
  'units lj',
  'atom_style atomic',
  'lattice fcc 0.8442',
  'region box block 0 5 0 5 0 5',
  'create_box 1 box',
  'create_atoms 1 box',
  'mass 1 1.0',
  'velocity all create 3.0 87287 loop geom',
  'pair_style lj/cut 2.5',
  'pair_coeff 1 1 1.0 1.0 2.5',
  'neighbor 0.3 bin',
  'fix 1 all nve',
  'thermo 50',
  'run 250'
].join('\n') + '\n';

/* A small charged molecular system in real units. */
const REAL = [
  'units real',
  'atom_style full',
  'region box block 0 20 0 20 0 20 units box',
  'create_box 2 box bond/types 1 extra/bond/per/atom 2',
  'create_atoms 1 random 50 12345 NULL',
  'create_atoms 2 random 50 54321 NULL',
  'mass 1 15.999',
  'mass 2 1.008',
  'set type 1 charge -0.8',
  'set type 2 charge 0.8',
  'pair_style lj/cut/coul/long 10.0',
  'pair_coeff * * 0.1 3.0',
  'kspace_style pppm 1.0e-4',
  'bond_style harmonic',
  'bond_coeff 1 450 0.96',
  'timestep 1.0',
  'fix 1 all nvt temp 300 300 100',
  'thermo 1000',
  'run 10000'
].join('\n') + '\n';

const errors = (r) => r.issues.filter(i => i.severity === 'error');
const ids = (r, sev) => r.issues.filter(i => !sev || i.severity === sev).map(i => i.id);
const replaceLine = (text, n, line) => text.split('\n').map((l, i) => (i === n - 1 ? line : l)).join('\n');
const insertAfter = (text, n, line) => { const a = text.split('\n'); a.splice(n, 0, line); return a.join('\n'); };

/* ------------------------------------------------------------------ */

describe('parseInput follows LAMMPS reading rules', () => {
  test('comments, blank lines and commands', () => {
    const p = parseInput('# a comment\n\nunits real   # trailing\n');
    expect(p.lines.map(l => l.kind)).toEqual(['comment', 'blank', 'command']);
    expect(p.lines[2]).toMatchObject({ line: 3, lastLine: 3, command: 'units', args: ['real'], comment: 'trailing' });
  });

  test('& joins lines with nothing in between, and keeps both line numbers', () => {
    const p = parseInput('fix 1 all nvt temp 300 300 100 &\n   tchain 3\nrun 10\n');
    expect(p.lines[0]).toMatchObject({ line: 1, lastLine: 2, command: 'fix' });
    expect(p.lines[0].text).toBe('fix 1 all nvt temp 300 300 100    tchain 3');
    expect(p.lines[0].args).toEqual(['1', 'all', 'nvt', 'temp', '300', '300', '100', 'tchain', '3']);
    expect(p.lines[1]).toMatchObject({ line: 3, command: 'run' });
    // No space is added: "abc&\ndef" is one word.
    expect(parseInput('print abc&\ndef\n').lines[0].args).toEqual(['abcdef']);
  });

  test('a comment ending in & swallows the next line', () => {
    const p = parseInput('# comment &\nrun 10\nunits lj\n');
    expect(p.lines[0]).toMatchObject({ kind: 'comment', line: 1, lastLine: 2 });
    expect(p.lines[1]).toMatchObject({ command: 'units', line: 3 });
  });

  test('triple quotes span lines and keep their line breaks', () => {
    const p = parseInput('print """\nline one\nline two\n"""\nrun 0\n');
    expect(p.lines[0]).toMatchObject({ line: 1, lastLine: 4, command: 'print' });
    expect(p.lines[0].args[0]).toBe('\nline one\nline two\n');
    expect(p.lines[1]).toMatchObject({ line: 5, command: 'run' });
  });

  test('quotes protect # and spaces; a quote is special only at the start of a word', () => {
    expect(parseInput('print "a # b" screen no\n').lines[0].args).toEqual(['a # b', 'screen', 'no']);
    expect(stripComment("print 'x#y' # z")).toMatchObject({ code: "print 'x#y' ", comment: 'z' });
    expect(splitWords('a"b c" d').words).toEqual(['a"b', 'c"', 'd']);
    expect(splitWords('"x"y').error).toBe('Input line quote not followed by white-space');
  });

  test('an unmatched quote is an error LAMMPS stops on', () => {
    const p = parseInput("print don't\n");
    expect(p.errors[0]).toMatchObject({ line: 1, id: 'quote' });
    const r = checkInput("units lj\nprint don't\n");
    expect(r.firstError).toMatchObject({ line: 2, lammps: 'Unmatched single quote in command' });
  });

  test('the last line needs no line break; a final & stays a word', () => {
    expect(parseInput('units lj').lines[0].args).toEqual(['lj']);
    expect(parseInput('run 10 &\n').lines[0].args).toEqual(['10', '&']);
  });

  test('$ references are found outside quotes only', () => {
    const f = findSubstitutions('region b block 0 $x 0 ${len} 0 $(v_a*2:%.3f) "$y"');
    expect(f.refs.map(r => [r.kind, r.name])).toEqual([['char', 'x'], ['name', 'len'], ['immediate', 'v_a*2']]);
    expect(f.refs[2].format).toBe('%.3f');
    expect(findSubstitutions('print ${open').error).toBe('Invalid variable name');
    expect(parseInput('run $n\n').lines[0].hasVars).toBe(true);
  });

  test('LAMMPS number rules', () => {
    expect(['1', '-2.5', '.5', '5.', '1e-3', '+3E+4'].every(isLammpsNumber)).toBe(true);
    expect(['1.2.3', 'abc', '1e', '', '0x10'].some(isLammpsNumber)).toBe(false);
    expect(isLammpsInteger('100')).toBe(true);
    expect(isLammpsInteger('1e5')).toBe(false);
  });

  test('C formatting as LAMMPS prints values', () => {
    expect(formatC('%.20g', 1 / 3)).toBe('0.33333333333333331483');
    expect(formatC('%.15g', 0.1 + 0.2)).toBe('0.3');
    expect(formatC('%10.3f', Math.PI)).toBe('     3.142');
    expect(formatC('%g', 1e-5)).toBe('1e-05');
    expect(formatPs(0.002)).toBe('2 fs');
    expect(formatPs(1000)).toBe('1 ns');
  });
});

/* ------------------------------------------------------------------ */

describe('checkInput: variables and control flow', () => {
  test('a clean script has no errors', () => {
    expect(errors(checkInput(LJ))).toEqual([]);
    expect(errors(checkInput(REAL))).toEqual([]);
  });

  test('$ substitution uses the value at that point; an undefined name stops LAMMPS', () => {
    const r = checkInput(replaceLine(LJ, 14, 'run ${steps}'));
    expect(r.firstError).toMatchObject({ line: 14, id: 'undefined-variable', lammps: 'Substitution for illegal variable steps' });
    const ok = checkInput(insertAfter(replaceLine(LJ, 14, 'run ${steps}'), 1, 'variable steps equal 2*50'));
    expect(errors(ok)).toEqual([]);
    expect(ok.state.runs[0].steps).toBe(100);
  });

  test('-var values come in through options.vars', () => {
    expect(errors(checkInput(replaceLine(LJ, 14, 'run $N'), { vars: { N: '100' } }))).toEqual([]);
  });

  test('loops with index variables, next and jump run as in LAMMPS', () => {
    const text = 'variable t index 100 200 300\nlabel loop\nprint "T = $t"\nnext t\njump SELF loop\nprint done\n';
    const r = checkInput(text);
    expect(errors(r)).toEqual([]);
    expect(r.trace.filter(t => t.line === 3)).toHaveLength(3);
    expect(r.trace.some(t => t.line === 6)).toBe(true);
  });

  test('a jump to a missing label stops LAMMPS', () => {
    const r = checkInput('jump SELF nowhere\nprint hi\n');
    expect(r.firstError).toMatchObject({ id: 'label-missing', lammps: "Label wasn't found in input script" });
  });

  test('variables keep their style', () => {
    const r = checkInput('variable a equal 1\nvariable a string x\n');
    expect(r.firstError).toMatchObject({ line: 2, lammps: 'Cannot redefine variable as a different style' });
    expect(checkInput('variable a index 1\nvariable a index 2\nprint $a\n').issues.find(i => i.id === 'variable-kept')).toBeTruthy();
  });

  test('immediate formulas and formats', () => {
    expect(errors(checkInput('print "$(2*PI:%.3f) nm"\n'))).toEqual([]);
    expect(checkInput('print $(1/0)\n').firstError).toMatchObject({ lammps: 'Divide by 0 in variable formula' });
    expect(checkInput('print $(sqrt(2,3))\n').firstError).toMatchObject({ lammps: 'Invalid math function in variable formula' });
    expect(checkInput('print $(2:%d)\n').firstError).toMatchObject({ lammps: 'Incorrect conversion in format string' });
  });

  test('charge() without charges is reported, since LAMMPS crashes on it', () => {
    const r = checkInput(`${LJ}print "$(charge(all))"\n`);
    expect(r.firstError).toMatchObject({ line: 15, id: 'charge-crash' });
    expect(errors(checkInput(`${REAL}print "$(charge(all))"\n`))).toEqual([]);
  });

  test('thermo keywords in formulas need a box and a run', () => {
    expect(checkInput('print $(step)\n').firstError).toMatchObject({ lammps: 'Variable evaluation before simulation box is defined' });
    const r = checkInput(replaceLine(LJ, 13, 'print "$(pe)"'));
    expect(r.firstError).toMatchObject({ line: 13, lammps: 'Energy was not tallied on needed timestep' });
    expect(errors(checkInput(`${LJ}print "$(pe)"\n`))).toEqual([]);
  });

  test('if follows the condition when it is known', () => {
    const text = 'variable a equal 2\nif "${a} > 1" then "print big" else "undefinedcommand"\n';
    expect(errors(checkInput(text))).toEqual([]);
    const r = checkInput('variable a equal 0\nif "${a} > 1" then "print big" else "undefinedcommand"\n');
    expect(r.firstError).toMatchObject({ line: 2, id: 'unknown-command' });
  });

  test('include reads files given in options.files, and issues name the file', () => {
    const files = { 'in.settings': 'pair_style lj/cut 2.5\npair_coeff 1 1 1.0 1.0\nfix 1 all nvee\n' };
    const text = LJ.replace('pair_style lj/cut 2.5\npair_coeff 1 1 1.0 1.0 2.5\n', 'include in.settings\n');
    const r = checkInput(text, { files });
    expect(r.firstError).toMatchObject({ file: 'in.settings', line: 3, id: 'unknown-style' });
    const missing = checkInput(text);
    expect(missing.issues.find(i => i.id === 'include-missing')).toBeTruthy();
    expect(errors(missing)).toEqual([]);
  });

  test('include inside if/then follows the condition and the vars', () => {
    const files = { 'in.system': LJ.split('\n').slice(0, 7).join('\n') };
    const text = 'if "${rstep} < 0" then "include in.system" else "read_restart a.restart"\npair_style lj/cut 2.5\npair_coeff 1 1 1 1\nfix 1 all nve\nrun 10\n';
    const r = checkInput(text, { files, vars: { rstep: '-1' } });
    expect(errors(r)).toEqual([]);
    expect(r.state.units).toBe('lj');
  });
});

/* ------------------------------------------------------------------ */

describe('checkInput: commands, styles and order', () => {
  test('unknown commands, with a suggestion', () => {
    const r = checkInput(replaceLine(LJ, 8, 'velocty all create 3.0 87287'));
    expect(r.firstError).toMatchObject({ line: 8, id: 'unknown-command' });
    expect(r.firstError.lammps).toMatch(/^Unknown command: velocty/);
    expect(r.firstError.message).toMatch(/Did you mean velocity\?/);
  });

  test('unknown styles, and styles from packages the build lacks', () => {
    expect(checkInput(replaceLine(LJ, 12, 'fix 1 all nvee')).firstError).toMatchObject({ line: 12, lammps: "Unrecognized fix style 'nvee'" });
    const r = checkInput(REAL, { packages: ['MOLECULE'] });
    expect(r.firstError).toMatchObject({ line: 11, id: 'missing-package' });
    expect(r.firstError.lammps).toBe("Unrecognized pair style 'lj/cut/coul/long' is part of the KSPACE package which is not enabled in this LAMMPS binary.");
  });

  test('removed and renamed names', () => {
    expect(checkInput(insertAfter(LJ, 12, 'fix 2 all ave/spatial 1 1 1 x lower 0.5 vx')).firstError).toMatchObject({ line: 13, lammps: 'This fix style is no longer available' });
    const r = checkInput(insertAfter(LJ, 7, 'reset_ids'));
    // reset_atoms id sets the system up first, so before the masses it stops LAMMPS.
    expect(checkInput(insertAfter(LJ, 6, 'reset_ids')).firstError).toMatchObject({ line: 7, lammps: 'Not all per-type masses are set. Type 1 is missing.' });
    expect(errors(r)).toEqual([]);
    expect(r.issues.find(i => i.id === 'renamed-command')).toBeTruthy();
  });

  test('settings that must come before the box', () => {
    expect(checkInput(insertAfter(LJ, 5, 'units real')).firstError).toMatchObject({ line: 6, lammps: 'Units command after simulation box is defined' });
    expect(checkInput(insertAfter(LJ, 5, 'atom_style full')).firstError).toMatchObject({ lammps: 'Atom_style command after simulation box is defined' });
    expect(checkInput(insertAfter(LJ, 5, 'boundary p p f')).firstError).toMatchObject({ lammps: 'Boundary command after simulation box is defined' });
  });

  test('commands that need the box', () => {
    const before = (cmd) => checkInput(insertAfter(LJ, 2, cmd)).firstError;
    expect(before('mass 1 1.0')).toMatchObject({ line: 3, lammps: 'Mass command before simulation box is defined' });
    expect(before('pair_style lj/cut 2.5\npair_coeff 1 1 1 1')).toMatchObject({ line: 4, lammps: 'Pair_coeff command before simulation box is defined' });
    expect(before('group g type 1')).toMatchObject({ lammps: 'Group command before simulation box is defined' });
    expect(before('fix 9 all nve')).toMatchObject({ lammps: 'Fix command before simulation box is defined' });
    expect(before('velocity all create 1 1')).toMatchObject({ lammps: 'Velocity command before simulation box is defined' });
  });

  test('a second read_data needs add; create_atoms needs a box and a lattice', () => {
    expect(checkInput('units real\nread_data a.data\nread_data b.data\n').firstError).toMatchObject({ line: 3, lammps: 'Cannot use read_data without add keyword after simulation box is defined' });
    expect(errors(checkInput('units real\nread_data a.data\nread_data b.data add append\n'))).toEqual([]);
    expect(checkInput('units lj\ncreate_atoms 1 box\n').firstError).toMatchObject({ lammps: 'Create_atoms command before simulation box is defined' });
    expect(checkInput(LJ.replace('lattice fcc 0.8442\n', '').replace('region box block 0 5 0 5 0 5', 'region box block 0 5 0 5 0 5 units box')).firstError)
      .toMatchObject({ lammps: 'Cannot create atoms with undefined lattice' });
  });

  test('IDs: groups, fixes, computes, dumps, regions', () => {
    expect(checkInput(replaceLine(LJ, 12, 'fix 1 mobile nve')).firstError).toMatchObject({ line: 12, lammps: 'Could not find fix group ID mobile' });
    expect(checkInput(insertAfter(LJ, 12, 'fix 1 all langevin 3.0 3.0 1.0 48279')).firstError).toMatchObject({ line: 13, lammps: 'Replacing a fix, but new style != old style' });
    expect(checkInput(insertAfter(LJ, 12, 'unfix 2')).firstError).toMatchObject({ lammps: 'Could not find fix ID 2 to delete' });
    expect(checkInput(insertAfter(LJ, 12, 'compute thermo_temp all temp')).firstError).toMatchObject({ lammps: "Reuse of compute ID 'thermo_temp'" });
    expect(checkInput(insertAfter(LJ, 12, 'uncompute nope')).firstError).toMatchObject({ lammps: 'Could not find compute ID nope to delete' });
    expect(checkInput(insertAfter(LJ, 12, 'undump nope')).firstError).toMatchObject({ lammps: 'Could not find undump ID: nope' });
    expect(checkInput(insertAfter(LJ, 12, 'group g region nowhere')).firstError).toMatchObject({ lammps: 'Region nowhere for group region does not exist' });
    expect(checkInput(insertAfter(LJ, 4, 'region box block 0 1 0 1 0 1')).firstError).toMatchObject({ lammps: 'Reuse of region ID box' });
    expect(checkInput(insertAfter(LJ, 12, 'dump 1 nogroup atom 100 x.dump')).firstError).toMatchObject({ lammps: 'Could not find dump group ID: nogroup' });
  });

  test('a fix creates computes of its own (ID_temp), which compute_modify can use', () => {
    const r = checkInput(replaceLine(LJ, 12, 'fix 1 all nvt temp 3.0 3.0 0.5\ncompute_modify 1_temp dynamic/dof yes'));
    expect(errors(r)).toEqual([]);
  });

  test('thermo_style custom references', () => {
    const bad = (w) => checkInput(insertAfter(LJ, 12, `thermo_style custom step temp ${w}`)).firstError;
    expect(bad('c_nope')).toMatchObject({ line: 13, lammps: 'Could not find thermo custom compute ID: nope' });
    expect(bad('f_nope')).toMatchObject({ lammps: 'Could not find thermo custom fix ID: nope' });
    expect(bad('v_nope')).toMatchObject({ lammps: 'Could not find thermo custom variable name: nope' });
    expect(bad('tempp')).toMatchObject({ lammps: "Unknown keyword 'tempp' in thermo_style custom command" });
    expect(bad('c_thermo_pe')).toBeNull();
    const peratom = checkInput(insertAfter(LJ, 12, 'compute pa all pe/atom\nthermo_style custom step c_pa')).firstError;
    expect(peratom).toMatchObject({ lammps: 'Thermo compute does not compute scalar' });
  });

  test('keywords and values of common styles, as LAMMPS reads them', () => {
    expect(checkInput(replaceLine(REAL, 17, 'fix 1 all nvt temp 300 300 100 tchian 3')).firstError).toMatchObject({ line: 17, lammps: 'Unknown fix nvt keyword: tchian' });
    expect(checkInput(replaceLine(REAL, 17, 'fix 1 all nvt temp 300 300')).firstError).toMatchObject({ lammps: 'Illegal fix nvt temp command: missing argument(s)' });
    expect(checkInput(replaceLine(REAL, 17, 'fix 1 all nvt temp 300 300 abc')).firstError).toMatchObject({ lammps: "Expected floating point parameter instead of 'abc' in input script or data file" });
    expect(checkInput(replaceLine(LJ, 8, 'velocity all create 3.0 87287 dist gauss')).firstError).toMatchObject({ line: 8 });
    expect(checkInput(replaceLine(LJ, 8, 'velocity all create 3.0 0')).firstError).toMatchObject({ lammps: 'Illegal velocity create seed argument: 0' });
    expect(checkInput(replaceLine(LJ, 12, 'fix 1 all langevin 3.0 3.0 1.0 0')).firstError).toMatchObject({ lammps: 'Illegal fix langevin command' });
    expect(checkInput(replaceLine(LJ, 14, 'run 250 every')).firstError).toMatchObject({ line: 14, lammps: 'Illegal run every command: missing argument(s)' });
    expect(checkInput(replaceLine(LJ, 14, 'run 2.5')).firstError).toMatchObject({ lammps: "Expected integer parameter instead of '2.5' in input script or data file" });
    expect(checkInput(replaceLine(LJ, 11, 'neigh_modify every 1 delay 0 chek yes')).firstError).toMatchObject({ lammps: 'Unknown neigh_modify keyword: chek' });
  });

  test('styles with lists or forms are read whole', () => {
    expect(errors(checkInput(insertAfter(LJ, 12, 'fix 2 all gravity 1.0 vector 0 0 -1')))).toEqual([]);
    expect(errors(checkInput(insertAfter(LJ, 12, 'restart 1000 a.restart b.restart')))).toEqual([]);
    expect(errors(checkInput(insertAfter(LJ, 12, 'neigh_modify exclude type 1 1 every 2')))).toEqual([]);
    expect(errors(checkInput(insertAfter(LJ, 12, 'compute r all rdf 50 1 1 cutoff 2.5')))).toEqual([]);
    expect(errors(checkInput(insertAfter(LJ, 12, 'compute k all ke/atom\ncompute s all reduce sum c_k\nfix av all ave/time 10 5 50 c_s c_thermo_temp file t.dat')))).toEqual([]);
    expect(checkInput(insertAfter(LJ, 12, 'fix av all ave/time 10 5 45 c_thermo_temp')).firstError).toMatchObject({ lammps: 'Inconsistent fix ave/time nevery/nrepeat/nfreq values' });
    expect(checkInput(insertAfter(LJ, 12, 'fix av all ave/time 10 5 50 c_nope')).firstError).toMatchObject({ lammps: 'Compute ID nope for fix ave/time does not exist' });
    expect(checkInput(insertAfter(LJ, 12, 'dump d all custom 100 x.dump id type x y z velocity')).firstError).toMatchObject({ lammps: 'Invalid attribute velocity in dump custom command' });
    expect(checkInput(REAL.replace('fix 1 all nvt', 'fix 2 all shake 1e-4 20 0 b 1 foo\nfix 1 all nvt')).firstError).toMatchObject({ lammps: "Expected integer parameter instead of 'foo' in input script or data file" });
  });

  test('pair_coeff arguments follow the pair style', () => {
    expect(checkInput(replaceLine(LJ, 10, 'pair_coeff 1 1 1.0 1.0 2.5 3.0')).firstError).toMatchObject({ line: 10, lammps: 'Incorrect args for pair coefficients' });
    expect(checkInput(replaceLine(LJ, 10, 'pair_coeff 1 2 1.0 1.0')).firstError).toMatchObject({ lammps: 'Numeric index 2 is out of bounds (1-1)' });
    expect(checkInput('units metal\nlattice fcc 3.6\nregion b block 0 2 0 2 0 2\ncreate_box 1 b\npair_style eam/alloy\npair_coeff 1 1 Cu.eam.alloy Cu\n').firstError)
      .toMatchObject({ lammps: 'Pair_coeff must start with * * for pair style eam/alloy' });
  });
});

/* ------------------------------------------------------------------ */

describe('checkInput: what LAMMPS checks when a run starts', () => {
  test('kspace needs a long-range pair style, and the reverse', () => {
    const noLong = checkInput(REAL.replace('lj/cut/coul/long 10.0', 'lj/cut/coul/cut 10.0'));
    expect(noLong.firstError).toMatchObject({ line: 19, lammps: 'KSpace style is incompatible with Pair style' });
    expect(noLong.firstError.related).toEqual(expect.arrayContaining([11, 13]));
    const noKspace = checkInput(REAL.replace('kspace_style pppm 1.0e-4\n', ''));
    expect(noKspace.firstError).toMatchObject({ line: 18, lammps: 'Pair style requires a KSpace style' });
  });

  test('Coulomb needs charges; kspace is checked first', () => {
    const molecular = REAL.replace('atom_style full', 'atom_style molecular').replace(/set type.*\n/g, '');
    expect(checkInput(molecular).firstError).toMatchObject({ line: 17, lammps: 'Kspace style requires atom attribute q' });
    const noK = checkInput(molecular.replace('kspace_style pppm 1.0e-4\n', ''));
    expect(noK.firstError).toMatchObject({ lammps: 'Pair style lj/cut/coul/long requires atom attribute q' });
  });

  test('atoms made by create_atoms have no charge until set gives them one', () => {
    const r = checkInput(REAL.replace(/set type.*\n/g, ''));
    expect(r.firstError).toMatchObject({ line: 17, lammps: 'Must use kspace_modify gewald for uncharged system' });
    expect(errors(checkInput(REAL.replace(/set type.*\n/g, '').replace('kspace_style pppm 1.0e-4', 'kspace_style pppm 1.0e-4\nkspace_modify gewald 0.3')))).toEqual([]);
  });

  test('TIP4P kspace with a plain pair style', () => {
    const r = checkInput(REAL.replace('kspace_style pppm 1.0e-4', 'kspace_style pppm/tip4p 1.0e-4'));
    expect(r.firstError).toMatchObject({ lammps: 'KSpace style is incompatible with Pair style' });
  });

  test('pair coefficients and masses must be complete', () => {
    expect(checkInput(LJ.replace('create_box 1 box', 'create_box 2 box').replace('mass 1 1.0', 'mass * 1.0')).firstError)
      .toMatchObject({ line: 14, lammps: 'All pair coeffs are not set' });
    expect(checkInput(LJ.replace('create_box 1 box', 'create_box 2 box').replace('pair_coeff 1 1 1.0 1.0 2.5', 'pair_coeff * * 1.0 1.0')).firstError)
      .toMatchObject({ lammps: 'Not all per-type masses are set. Type 2 is missing.' });
    // morse cannot mix i,j from i,i and j,j.
    const morse = LJ.replace('create_box 1 box', 'create_box 2 box').replace('mass 1 1.0', 'mass * 1.0')
      .replace('pair_style lj/cut 2.5\npair_coeff 1 1 1.0 1.0 2.5', 'pair_style morse 2.5\npair_coeff 1 1 1 1 1\npair_coeff 2 2 1 1 1');
    expect(checkInput(morse).firstError).toMatchObject({ lammps: 'All pair coeffs are not set' });
  });

  test('EAM, MEAM and friends set masses from their files', () => {
    const text = 'units metal\natom_style atomic\nlattice fcc 3.615\nregion box block 0 4 0 4 0 4\ncreate_box 1 box\ncreate_atoms 1 box\n' +
      'pair_style eam\npair_coeff * * Cu_u3.eam\nminimize 1e-4 1e-6 100 1000\nwrite_restart min.restart\n';
    expect(errors(checkInput(text))).toEqual([]);
  });

  test('integration: none, twice, and SHAKE with rigid bodies', () => {
    expect(ids(checkInput(replaceLine(LJ, 12, 'fix 1 all langevin 3.0 3.0 1.0 4928')), 'warning')).toContain('no-integrator');
    expect(ids(checkInput(insertAfter(LJ, 12, 'fix 2 all nvt temp 3.0 3.0 0.5')), 'warning')).toContain('double-integration');
  });

  test('fix shake must come before a barostat', () => {
    const text = REAL.replace('fix 1 all nvt temp 300 300 100', 'fix 1 all npt temp 300 300 100 iso 1 1 1000\nfix 2 all shake 1e-4 20 0 m 1.008');
    expect(checkInput(text).firstError).toMatchObject({ lammps: 'Fix shake must come before any box changing fix' });
    const fine = REAL.replace('fix 1 all nvt temp 300 300 100', 'fix 2 all shake 1e-4 20 0 m 1.008\nfix 1 all npt temp 300 300 100 iso 1 1 1000');
    expect(errors(checkInput(fine))).toEqual([]);
  });

  test('timestep advice for the units and force field', () => {
    const metal = checkInput('units metal\nregion b block 0 5 0 5 0 5\ncreate_box 1 b\ncreate_atoms 1 random 10 1 NULL\nmass 1 63.5\npair_style lj/cut 5\npair_coeff * * 0.1 2.3\ntimestep 1\nfix 1 all nve\nrun 10\n');
    expect(metal.issues.find(i => i.id === 'timestep')).toMatchObject({ severity: 'warning' });
    expect(metal.issues.find(i => i.id === 'timestep').message).toMatch(/1 ps per step/);
    const real2 = checkInput(REAL.replace('timestep 1.0', 'timestep 2.0'));
    expect(real2.issues.find(i => i.id === 'timestep').message).toMatch(/without SHAKE/);
    const shake = checkInput(REAL.replace('timestep 1.0', 'timestep 2.0').replace('fix 1 all nvt', 'fix 2 all shake 1e-4 20 0 b 1\nfix 1 all nvt'));
    expect(shake.issues.find(i => i.id === 'timestep')).toBeUndefined();
    const none = checkInput(REAL.replace('timestep 1.0\n', ''));
    expect(none.issues.find(i => i.id === 'default-timestep').message).toMatch(/1 fs/);
  });

  test('thermostat and barostat damping against the manual\'s advice', () => {
    const tight = checkInput(REAL.replace('temp 300 300 100', 'temp 300 300 1'));
    expect(tight.issues.find(i => i.id === 'damping')).toMatchObject({ severity: 'warning', line: 17 });
    expect(tight.issues.find(i => i.id === 'damping').url).toBe('https://docs.lammps.org/fix_nh.html');
    const ok = checkInput(REAL);
    expect(ok.issues.find(i => i.id === 'damping')).toBeUndefined();
    const baro = checkInput(REAL.replace('fix 1 all nvt temp 300 300 100', 'fix 1 all npt temp 300 300 100 iso 1 1 10'));
    expect(baro.issues.find(i => i.id === 'damping').message).toMatch(/Pdamp/);
  });

  test('data-file content is not guessed', () => {
    const r = checkInput('units real\natom_style full\nread_data data.peptide\npair_style lj/cut 10\nfix 1 all nve\nrun 10\n');
    expect(errors(r)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */

describe('restart files and chains of inputs', () => {
  test('after read_restart the units are unknown unless told', () => {
    const r = checkInput('read_restart a.restart\ntimestep 2.0\nfix 1 all nve\nrun 100\n');
    expect(r.state.units).toBeNull();
    expect(r.issues.find(i => i.id === 'timestep')).toBeUndefined();
    const told = checkInput('read_restart a.restart\ntimestep 2.0\nfix 1 all nve\nrun 100\n', { restart: { units: 'real' } });
    expect(told.state.units).toBe('real');
  });

  test('checkChain carries what write_restart saved', () => {
    const stages = [
      { name: 'in.a', text: REAL.replace('run 10000', 'run 10000\nwrite_restart a.restart') },
      { name: 'in.b', text: 'read_restart a.restart\nkspace_style pppm 1e-4\nfix 1 all nvt temp 300 300 100\nrun 1000\n' }
    ];
    const [a, b] = checkChain(stages);
    expect(errors(a)).toEqual([]);
    expect(errors(b)).toEqual([]);
    expect(b.state.units).toBe('real');
    const rows = explainChain(stages)[1].rows;
    expect(rows.find(r => r.command === 'run').meaning).toMatch(/1 ps/);
  });

  test('every preset of the workflow builder checks without errors', () => {
    const data = summariseData(parseDataFile(bigWaterSystem(200)), { units: 'real' });
    for (const ff of LMP_FORCE_FIELDS) {
      for (const d of [null, data]) {
        const wf = buildLammpsWorkflow(defaultLammpsState(ff.id), { data: d });
        const files = Object.fromEntries(wf.files.filter(f => f.kind === 'lammps').map(f => [f.name, f.text]));
        const stages = wf.stages.map(s => ({ name: s.file, text: files[s.file] }));
        for (const r of checkChain(stages, { files, vars: { rstep: '-1', time_limit: 'off' } })) {
          expect({ preset: ff.id, data: !!d, stage: r.name, errors: errors(r).map(i => `${i.file || r.name}:${i.line} ${i.lammps}`) })
            .toEqual({ preset: ff.id, data: !!d, stage: r.name, errors: [] });
        }
      }
    }
  });
});

/* ------------------------------------------------------------------ */

describe('explainInput', () => {
  const rows = () => explainInput([
    'units real', 'atom_style full', 'read_data data.peptide', 'pair_style lj/charmm/coul/long 8 10', 'special_bonds charmm',
    'kspace_style pppm 1e-4', 'timestep 2.0', 'velocity all create 300 4928459 dist gaussian mom yes rot yes',
    'fix 1 all nvt temp 300 300 100', 'fix 2 all shake 0.0001 10 0 m 1.0', 'thermo 1000',
    'dump 1 all custom 5000 traj.lammpstrj id type x y z', 'run 500000'
  ].join('\n') + '\n');
  const row = (title) => rows().find(r => r.title === title);

  test('one row per logical line, with links and summaries', () => {
    const r = rows();
    expect(r).toHaveLength(13);
    expect(r[8]).toMatchObject({ title: 'fix nvt', url: 'https://docs.lammps.org/fix_nh.html', status: 'ok' });
    expect(r[8].summary).not.toBe('');
  });

  test('values in the units of the script', () => {
    expect(row('timestep').meaning).toMatch(/2\.0 fs/);
    expect(row('fix nvt').meaning).toMatch(/300 K throughout, damping 100 fs = 50 steps/);
    expect(row('thermo').meaning).toMatch(/every 1000 steps \(every 2 ps\)/);
    expect(row('run').meaning).toMatch(/500,000 steps = 1 ns/);
    expect(row('pair_style lj/charmm/coul/long').meaning).toMatch(/switched off between 8 Å and 10 Å.*Coulomb split at 10 Å/);
    expect(row('velocity').meaning).toMatch(/300 K \(seed 4928459\).*Gaussian.*no net momentum.*no net rotation/);
    expect(row('dump custom').meaning).toMatch(/every 5000 steps \(every 10 ps\).*atom ID, atom type, x, y, z/);
    expect(row('special_bonds').meaning).toMatch(/CHARMM/);
    expect(row('kspace_style pppm').meaning).toMatch(/PPPM.*1e-4/);
    expect(row('fix shake').meaning).toMatch(/mass 1\.0 \(within 0\.1, i\.e\. hydrogens\)/);
  });

  test('issues and status per row; rows of included files carry the file', () => {
    const r = explainInput('units lj\nincludee x\ninclude in.b\n', { files: { 'in.b': 'atom_style atomic\nfix 1 all nve\n' } });
    expect(r[1]).toMatchObject({ status: 'error', command: 'includee' });
    const inc = r.filter(x => x.file === 'in.b');
    expect(inc.map(x => x.line)).toEqual([1, 2]);
    expect(inc[1].status).toBe('error');
  });
});

/* ------------------------------------------------------------------ */

/*
 * With LAMMPS installed (LMP_BIN), the same small inputs go through lmp:
 * where lmp stops, checkInput must stop on the same line; where lmp
 * finishes, checkInput must report no error. Runs are set up but not run.
 */
const LMP = process.env.LMP_BIN || '';
const withLammps = LMP && fs.existsSync(LMP) ? describe : describe.skip;

withLammps('agrees with the real lmp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stemkit-lmp-test-'));
  const lmp = (text) => {
    const setup = text.replace(/^run (\d+)$/gm, 'run 0 post no');
    fs.writeFileSync(path.join(dir, 'in.test'), setup);
    const r = spawnSync('stdbuf', ['-oL', LMP, '-in', 'in.test', '-log', 'none', '-echo', 'none'], { cwd: dir, encoding: 'utf8', env: { ...process.env, OMP_NUM_THREADS: '1' }, timeout: 60000 });
    const out = `${r.stdout}\n${r.stderr}`;
    const m = /ERROR(?: on proc \d+)?: ([^\n]*?)(?: \([^()\n]*:\d+\))?\nLast command: ([^\n]*)/.exec(out);
    return { setup, error: m ? m[1] : null, last: m ? m[2].trim() : null };
  };
  const cases = [
    ['clean', LJ],
    ['typo command', replaceLine(LJ, 8, 'velocty all create 3.0 87287')],
    ['units after box', insertAfter(LJ, 5, 'units real')],
    ['undefined group', replaceLine(LJ, 12, 'fix 1 mobile nve')],
    ['fix restyled', insertAfter(LJ, 12, 'fix 1 all langevin 3.0 3.0 1.0 48279')],
    ['thermo compute', insertAfter(LJ, 12, 'thermo_style custom step c_nope')],
    ['kspace without charges', insertAfter(LJ, 10, 'kspace_style pppm 1e-4')],
    ['pair coeff count', replaceLine(LJ, 10, 'pair_coeff 1 1 1.0 1.0 2.5 3.0')],
    ['masses', LJ.replace('create_box 1 box', 'create_box 2 box').replace('pair_coeff 1 1 1.0 1.0 2.5', 'pair_coeff * * 1.0 1.0')],
    ['ave/time timing', insertAfter(LJ, 12, 'fix av all ave/time 10 5 45 c_thermo_temp')],
    ['dump column', insertAfter(LJ, 12, 'dump d all custom 100 x.dump id type x y z velocity')],
    ['lists read whole', insertAfter(LJ, 12, 'fix 2 all gravity 1.0 vector 0 0 -1\nrestart 1000 a.restart b.restart\nneigh_modify exclude type 1 1 every 2')],
    ['real units clean', REAL],
    ['kspace with cut-off Coulomb', REAL.replace('lj/cut/coul/long 10.0', 'lj/cut/coul/cut 10.0')],
    ['long-range without kspace', REAL.replace('kspace_style pppm 1.0e-4\n', '')]
  ];
  for (const [name, text] of cases) {
    test(name, () => {
      const real = lmp(text);
      const mine = checkInput(real.setup);
      if (!real.error) expect(mine.firstError).toBeNull();
      else {
        expect(mine.firstError).not.toBeNull();
        expect(mine.firstError.lammps).toBe(real.error);
        const stop = real.setup.split('\n').findIndex(l => l.trim() === real.last) + 1;
        expect(mine.firstError.line).toBe(stop);
      }
    });
  }
});
