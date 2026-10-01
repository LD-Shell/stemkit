import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseDataFile, summariseData, groupsFromData, guessElement, ATOM_STYLE_COLUMNS
} from '../src/core/lammps-data.js';

/*
 * The reading rules here were checked against LAMMPS 29 Aug 2024 itself:
 * tools/check-lammps-data.mjs runs every data file of the LAMMPS examples,
 * and broken copies of them, through read_data and through this module.
 * The files below are small ones written for these tests.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

/* A data file from a header (string) and sections ([name, lines]). */
function dataFile(header, sections, title = 'STEMKit test') {
  const body = sections.map(([name, lines]) => `\n${name}\n\n${lines.join('\n')}\n`).join('');
  return `${title}\n\n${header.trim()}\n${body}`;
}

const BOX = '0 20 xlo xhi\n0 20 ylo yhi\n0 20 zlo zhi';
const errors = (p) => p.issues.filter(i => i.severity === 'error');
const firstError = (p) => (errors(p)[0] || {}).message || '';

/*
 * A small solvated system, atom_style full: n water molecules of the model
 * given (charges on O and H; a fourth site when m is given), two Na+ and
 * two Cl-, one all-atom methane and one united-atom ethane.
 */
function system({ waters = 8, qo = -0.834, qh = 0.417, m = null, mMass = 1e-3, labels = false } = {}) {
  const atoms = [];
  const bonds = [];
  const angles = [];
  let id = 0;
  let mol = 0;
  const at = (molId, type, q, x, y, z) => { atoms.push(`${++id} ${molId} ${type} ${q} ${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)}`); return id; };
  for (let w = 0; w < waters; w++) {
    const x = 2 + 3.1 * (w % 5);
    const y = 2 + 3.1 * Math.floor(w / 5);
    const z = 3;
    mol++;
    const o = at(mol, 1, m === null ? qo : 0, x, y, z);
    const h1 = at(mol, 2, qh, x + 0.9572, y, z);
    const h2 = at(mol, 2, qh, x - 0.2400, y + 0.9266, z);
    if (m !== null) at(mol, 7, m, x + 0.1, y + 0.1, z);
    bonds.push(`${bonds.length + 1} 1 ${o} ${h1}`, `${bonds.length + 2} 1 ${o} ${h2}`);
    angles.push(`${angles.length + 1} 1 ${h1} ${o} ${h2}`);
  }
  for (const [type, q, x] of [[3, 1, 2], [3, 1, 6], [4, -1, 10], [4, -1, 14]]) at(++mol, type, q, x, 15, 15);
  // Methane: C (type 5) with four H (type 6).
  mol++;
  const c = at(mol, 5, -0.24, 10, 10, 10);
  const hs = [[0.63, 0.63, 0.63], [-0.63, -0.63, 0.63], [-0.63, 0.63, -0.63], [0.63, -0.63, -0.63]]
    .map(([dx, dy, dz]) => at(mol, 6, 0.06, 10 + dx, 10 + dy, 10 + dz));
  for (const h of hs) bonds.push(`${bonds.length + 1} 2 ${c} ${h}`);
  // United-atom ethane: two CH3 sites (type 8).
  mol++;
  const a1 = at(mol, 8, 0, 15, 5, 5);
  const a2 = at(mol, 8, 0, 16.54, 5, 5);
  bonds.push(`${bonds.length + 1} 3 ${a1} ${a2}`);
  const ntypes = 8;
  const masses = ['1 15.9994', '2 1.008', '3 22.98977', '4 35.453', '5 12.011', '6 1.008', `7 ${mMass}`, '8 15.035'];
  const header = `${atoms.length} atoms\n${ntypes} atom types\n${bonds.length} bonds\n3 bond types\n` +
    `${angles.length} angles\n1 angle types\n${BOX}`;
  const sections = [];
  if (labels) sections.push(['Atom Type Labels', ['1 OW', '2 HW', '3 Na', '4 Cl', '5 CT', '6 HC', '7 MW', '8 CH3']]);
  sections.push(['Masses', masses], ['Atoms # full', atoms], ['Bonds', bonds], ['Angles', angles]);
  return dataFile(header, sections);
}

/* Water filling a 9.3 Å box: no gap anywhere. */
function bigEnoughWater() {
  const atoms = [];
  let id = 0;
  for (let k = 0; k < 27; k++) {
    const x = 1.55 + 3.1 * (k % 3);
    const y = 1.55 + 3.1 * (Math.floor(k / 3) % 3);
    const z = 1.55 + 3.1 * Math.floor(k / 9);
    atoms.push(`${++id} ${k + 1} 1 -0.834 ${x} ${y} ${z}`, `${++id} ${k + 1} 2 0.417 ${x + 0.9572} ${y} ${z}`,
      `${++id} ${k + 1} 2 0.417 ${x - 0.24} ${y + 0.9266} ${z}`);
  }
  return dataFile('81 atoms\n2 atom types\n0 9.3 xlo xhi\n0 9.3 ylo yhi\n0 9.3 zlo zhi',
    [['Masses', ['1 15.9994', '2 1.008']], ['Atoms # full', atoms]]);
}

describe('the header', () => {
  test('reads counts, types and an orthogonal box', () => {
    const p = parseDataFile(system());
    expect(p.ok).toBe(true);
    expect(p.counts).toMatchObject({ atoms: 8 * 3 + 4 + 5 + 2, bonds: 16 + 4 + 1, angles: 8 });
    expect(p.types).toMatchObject({ atom: 8, bond: 3, angle: 1 });
    expect(p.box).toMatchObject({ xlo: 0, xhi: 20, lx: 20, triclinic: false, volume: 8000 });
  });

  test('reads tilt factors, and the avec/bvec/cvec of a general triclinic box as LAMMPS turns it', () => {
    const tilted = parseDataFile(dataFile(`1 atoms\n1 atom types\n${BOX}\n2.0 -1.0 0.5 xy xz yz`,
      [['Masses', ['1 1.0']], ['Atoms # atomic', ['1 1 1 1 1']]]));
    expect(tilted.box).toMatchObject({ triclinic: true, xy: 2, xz: -1, yz: 0.5, general: false });
    const general = parseDataFile(dataFile('1 atoms\n1 atom types\n0 3 4 avec\n5 0 0 bvec\n1 1.6 -1.2 cvec\n1 1 1 abc origin',
      [['Masses', ['1 1.0']], ['Atoms # atomic', ['1 1 2 1 2']]]));
    expect(general.ok).toBe(true);
    // LAMMPS turns A = (0,3,4) onto x: lx 5; B is then (0,5,0) and C (0,1,2),
    // as read_data reports it (xhi 6, yhi 6, zhi 3, yz 1).
    const b = general.box;
    [b.lx, b.ly, b.lz, b.xy, b.xz, b.yz].forEach((v, i) => expect(v).toBeCloseTo([5, 5, 2, 0, 0, 1][i], 12));
    expect([b.xlo, b.ylo, b.zlo]).toEqual([1, 1, 1]);
    expect(b.general).toBe(true);
    const left = parseDataFile(dataFile('1 atoms\n1 atom types\n5 0 0 avec\n0 0 2 bvec\n0 5 0 cvec', [['Atoms # atomic', ['1 1 1 1 1']]]));
    expect(firstError(left)).toMatch(/right-handed/);
  });

  test('takes a comment only after a space: "2 atoms# x" ends the header', () => {
    const ok = parseDataFile(dataFile(`2 atoms # two\n1 atom types\n${BOX}`, [['Atoms # atomic', ['1 1 1 1 1', '2 1 2 2 2']]]));
    expect(ok.ok).toBe(true);
    const glued = parseDataFile(dataFile(`2 atoms# two\n1 atom types\n${BOX}`, [['Atoms # atomic', ['1 1 1 1 1', '2 1 2 2 2']]]));
    expect(firstError(glued)).toMatch(/"2 atoms" is not a section/);
  });

  test('reads the units the title names', () => {
    const p = parseDataFile(dataFile(`0 atoms\n${BOX}`, [], 'LAMMPS data file via write_data, version 29 Aug 2024, timestep = 0, units = metal'));
    expect(p.unitsHint).toBe('metal');
  });

  test('accepts a file that ends inside the header, as LAMMPS does', () => {
    const p = parseDataFile(`title\n\n0 atoms\n${BOX}\n`);
    expect(p.ok).toBe(true);
    expect(p.sections).toEqual([]);
    const lost = parseDataFile(`title\n\n5 atoms\n1 atom types\n${BOX}\n`);
    expect(lost.ok).toBe(true);
    expect(lost.issues.map(i => i.message).join(' ')).toMatch(/ends before any section/);
  });

  test('refuses topology the atom style cannot hold, and bonds without bond types', () => {
    const p = parseDataFile(dataFile(`1 atoms\n1 atom types\n1 bond types\n${BOX}`, [['Atoms # atomic', ['1 1 1 1 1']]]));
    expect(firstError(p)).toMatch(/No bonds allowed/);
    const q = parseDataFile(dataFile(`2 atoms\n1 atom types\n1 bonds\n${BOX}`, [['Atoms # bond', ['1 1 1 1 1 1', '2 1 1 2 2 2']], ['Bonds', ['1 1 1 2']]]));
    expect(firstError(q)).toMatch(/no bond types/);
  });

  test('refuses bounds that are not increasing', () => {
    const p = parseDataFile(dataFile('1 atoms\n1 atom types\n5 5 xlo xhi', [['Atoms # atomic', ['1 1 5 0 0']]]));
    expect(firstError(p)).toMatch(/upper bound must be larger/);
  });
});

describe('sections', () => {
  test('always skip the line after a section name', () => {
    // "Atoms" on the skipped line is fine (some example files do it); a
    // missing blank line costs the first atom.
    const text = 'title\n\n2 atoms\n1 atom types\n0 9 xlo xhi\n0 9 ylo yhi\n0 9 zlo zhi\n\nAtoms\nAtoms\n\n1 1 1 1 1\n2 1 2 2 2\n'
      .replace('\n\n1 1 1 1 1', '\n1 1 1 1 1');
    expect(parseDataFile(text, { atomStyle: 'atomic' }).ok).toBe(true);
    const noBlank = 'title\n\n2 atoms\n1 atom types\n0 9 xlo xhi\n0 9 ylo yhi\n0 9 zlo zhi\n\nAtoms\n1 1 1 1 1\n2 1 2 2 2\n';
    expect(parseDataFile(noBlank, { atomStyle: 'atomic' }).ok).toBe(false);
  });

  test('count blank and comment lines inside a section as lines', () => {
    const p = parseDataFile(dataFile(`3 atoms\n1 atom types\n${BOX}`, [['Atoms # atomic', ['1 1 1 1 1', '', '2 1 2 2 2', '3 1 3 3 3']]]));
    expect(firstError(p)).toMatch(/blank or comment line inside Atoms/);
    const masses = parseDataFile(dataFile(`1 atoms\n2 atom types\n${BOX}`, [['Masses', ['1 1.0', '', '2 2.0']], ['Atoms # atomic', ['1 1 1 1 1']]]));
    expect(firstError(masses)).toMatch(/blank line inside Masses/);
  });

  test('name an unknown section, with the likely one', () => {
    const p = parseDataFile(dataFile(`1 atoms\n1 atom types\n${BOX}`, [['Mass', ['1 1.0']], ['Atoms # atomic', ['1 1 1 1 1']]]));
    expect(firstError(p)).toMatch(/"Mass" is not a section .* Did you mean "Masses"/);
  });

  test('read UreyBradley Coeffs only after the first section, as LAMMPS does', () => {
    const atoms = ['1 1 1 1 0 0', '2 1 1 2 0 0', '3 1 1 3 0 0'];
    const head = `3 atoms\n1 atom types\n1 angle types\n${BOX}`;
    expect(parseDataFile(dataFile(head, [['UreyBradley Coeffs', ['1 0 0']], ['Atoms # angle', atoms]])).ok).toBe(false);
    expect(parseDataFile(dataFile(head, [['Atoms # angle', atoms], ['UreyBradley Coeffs', ['1 0 0']]])).ok).toBe(true);
  });

  test('find a count that is too small or too large', () => {
    const atoms = ['1 1 1 1 1', '2 1 2 2 2', '3 1 3 3 3'];
    const small = parseDataFile(dataFile(`2 atoms\n1 atom types\n${BOX}`, [['Atoms # atomic', atoms], ['Masses', ['1 1.0']]]));
    expect(firstError(small)).toMatch(/"3 1 3 3 3" is not a section/);
    const large = parseDataFile(dataFile(`4 atoms\n1 atom types\n${BOX}`, [['Atoms # atomic', atoms], ['Masses', ['1 1.0']]]));
    expect(errors(large).length).toBeGreaterThan(0);
  });

  test('need Atoms before Velocities and Bonds, and labels before the sections that use types', () => {
    const v = parseDataFile(dataFile(`1 atoms\n1 atom types\n${BOX}`, [['Velocities', ['1 0 0 0']], ['Atoms # atomic', ['1 1 1 1 1']]]));
    expect(firstError(v)).toMatch(/Velocities must come after Atoms/);
    const late = parseDataFile(dataFile(`1 atoms\n1 atom types\n${BOX}`, [['Masses', ['1 1.0']], ['Atom Type Labels', ['1 C']], ['Atoms # atomic', ['1 C 1 1 1']]]));
    expect(firstError(late)).toMatch(/must come before Masses/);
  });

  test('read type labels wherever a type is named', () => {
    const p = parseDataFile(system({ labels: true }).replace(/^(\d+ \d+) 1 (\S+ \S+ \S+ \S+)$/gm, '$1 OW $2').replace('Masses\n\n1 15.9994', 'Masses\n\nOW 15.9994'));
    expect(p.ok).toBe(true);
    expect(p.labels.atom[1]).toBe('OW');
    expect(p.masses[0]).toMatchObject({ type: 1, mass: 15.9994, label: 'OW', element: 'O' });
    const undefinedLabel = parseDataFile(dataFile(`1 atoms\n1 atom types\n${BOX}`, [['Atoms # atomic', ['1 C 1 1 1']]]));
    expect(firstError(undefinedLabel)).toMatch(/is a label, but no Atom Type Labels/);
  });

  test('stop on what LAMMPS stops on in coefficient sections', () => {
    const head = `2 atoms\n2 atom types\n${BOX}`;
    const atoms = ['Atoms # atomic', ['1 1 1 1 1', '2 2 2 2 2']];
    expect(parseDataFile(dataFile(head, [['Pair Coeffs # lj/cut', ['1 0.1 3.0', '2 0.2 3.5']], atoms])).ok).toBe(true);
    expect(firstError(parseDataFile(dataFile(head, [['Pair Coeffs', ['1 0.1 3.0', '3 0.2 3.5']], atoms])))).toMatch(/not between 1 and 2/);
    expect(firstError(parseDataFile(dataFile(head, [['PairIJ Coeffs', ['1 1 0.1 3', '2 1 0.1 3', '2 2 0.1 3']], atoms])))).toMatch(/I > J/);
    const p = parseDataFile(dataFile(head, [['Pair Coeffs # lj/cut/coul/long', ['1 0.1 3.0', '2 0.2 3.5']], atoms]));
    expect(p.coefficients.pair.map(r => r.types[0])).toEqual([1, 2]);
    expect(p.coefficients.styles.pair).toBe('lj/cut/coul/long');
  });

  test('read CHARMM CMAP crossterms without being told, and say what the input needs', () => {
    const atoms = Array.from({ length: 5 }, (_, i) => `${i + 1} 1 1 0.0 ${i} 0 0`);
    const text = dataFile(`5 atoms\n1 atom types\n4 bonds\n1 bond types\n1 crossterms\n${BOX}`,
      [['Masses', ['1 12.011']], ['Atoms # full', atoms], ['Bonds', ['1 1 1 2', '2 1 2 3', '3 1 3 4', '4 1 4 5']], ['CMAP', ['1 1 1 2 3 4 5']]]);
    const p = parseDataFile(text);
    expect(p.ok).toBe(true);
    expect(p.counts.crossterms).toBe(1);
    expect(p.crossterms.n).toBe(1);
    expect(p.cmap).toEqual({ count: 1, needsFix: true });
    expect(p.issues.find(i => /fix cmap/.test(i.message)).message).toMatch(/read_data <file> fix cmap crossterm CMAP/);
    expect(summariseData(p).topology.crossterms).toBe(1);
    const told = parseDataFile(text, { fixes: [{ header: 'crossterm', section: 'CMAP' }] });
    expect(told.ok).toBe(true);
    expect(told.issues).toEqual([]);
    expect(told.counts.crossterms).toBe(1);
  });
});

describe('atoms', () => {
  test('give every atom style its columns', () => {
    expect(ATOM_STYLE_COLUMNS.full).toEqual(['atom-ID', 'molecule-ID', 'atom-type', 'q', 'x', 'y', 'z']);
    expect(ATOM_STYLE_COLUMNS.sphere).toEqual(['atom-ID', 'atom-type', 'diameter', 'density', 'x', 'y', 'z']);
    expect(ATOM_STYLE_COLUMNS.dipole).toEqual(['atom-ID', 'atom-type', 'q', 'x', 'y', 'z', 'mux', 'muy', 'muz']);
    // The template style's columns as atom_vec_template.cpp reads them.
    expect(ATOM_STYLE_COLUMNS.template.slice(0, 5)).toEqual(['atom-ID', 'molecule-ID', 'template-index', 'template-atom', 'atom-type']);
  });

  test('read hybrid styles as id type x y z, then each sub-style\'s new columns', () => {
    const p = parseDataFile(dataFile(`1 atoms\n1 atom types\n${BOX}`,
      [['Masses', ['1 2.0']], ['Atoms # hybrid', ['1 1 1 2 3 7 -0.5 1.0 1.5']]]), { atomStyle: 'hybrid full sphere' });
    expect(p.ok).toBe(true);
    expect(p.columns).toEqual(['atom-ID', 'atom-type', 'x', 'y', 'z', 'molecule-ID', 'q', 'diameter', 'density']);
    expect(p.atoms.mol[0]).toBe(7);
    expect(p.atoms.q[0]).toBe(-0.5);
    expect(p.atoms.rmass[0]).toBeCloseTo(1.5 * 4 / 3 * Math.PI * 0.5 ** 3, 12);
    const bare = parseDataFile(dataFile(`1 atoms\n1 atom types\n${BOX}`, [['Atoms # hybrid', ['1 1 1 2 3 7 -0.5 1.0 1.5']]]));
    expect(bare.issues.map(i => i.message).join(' ')).toMatch(/not which sub-styles/);
    expect(Array.from(bare.atoms.x)).toEqual([1, 2, 3]);
  });

  test('give spheres and ellipsoids their masses as LAMMPS does', () => {
    const s = parseDataFile(dataFile(`2 atoms\n1 atom types\n${BOX}`, [['Atoms # sphere', ['1 1 2.0 3.0 1 1 1', '2 1 0 3.0 2 2 2']]]));
    expect(s.atoms.rmass[0]).toBeCloseTo(3 * 4 / 3 * Math.PI, 12);
    expect(s.atoms.rmass[1]).toBe(3);
    const masses = parseDataFile(dataFile(`1 atoms\n1 atom types\n${BOX}`, [['Masses', ['1 1.0']], ['Atoms # sphere', ['1 1 1 1 1 1 1']]]));
    expect(firstError(masses)).toMatch(/cannot have a Masses section/);
    const e = parseDataFile(dataFile(`2 atoms\n1 atom types\n1 ellipsoids\n${BOX}`,
      [['Atoms # ellipsoid', ['1 1 1 2.0 1 1 1', '2 1 0 2.0 2 2 2']], ['Ellipsoids', ['1 2 4 6 1 0 0 0']]]));
    expect(e.ok).toBe(true);
    expect(e.atoms.rmass[0]).toBeCloseTo(2 * 4 / 3 * Math.PI * 1 * 2 * 3, 12);
    expect(e.atoms.rmass[1]).toBe(2);
  });

  test('read image flags, all lines or none', () => {
    const p = parseDataFile(dataFile(`2 atoms\n1 atom types\n${BOX}`, [['Atoms # atomic', ['1 1 1 1 1 0 1 -2', '2 1 2 2 2 0 0 0']]]));
    expect(p.imageFlags).toBe(true);
    expect(Array.from(p.atoms.image)).toEqual([0, 1, -2, 0, 0, 0]);
    const mixed = parseDataFile(dataFile(`2 atoms\n1 atom types\n${BOX}`, [['Atoms # atomic', ['1 1 1 1 1', '2 1 2 2 2 0 0 0']]]));
    expect(firstError(mixed)).toMatch(/where the lines before have 5/);
  });

  test('decide about image flags afresh every 1024 lines, as LAMMPS does', () => {
    const lines = Array.from({ length: 1100 }, (_, i) => `${i + 1} 1 ${i % 20} ${Math.floor(i / 20) % 20} 1` +
      (i >= 1024 ? ' 0 0 1' : ''));
    const p = parseDataFile(dataFile(`1100 atoms\n1 atom types\n${BOX}`, [['Atoms # atomic', lines]]));
    expect(p.ok).toBe(true);
    expect([p.atoms.image[3 * 1023 + 2], p.atoms.image[3 * 1024 + 2]]).toEqual([0, 1]);
    lines[1024] = '# a comment where the second chunk starts';
    const q = parseDataFile(dataFile(`1100 atoms\n1 atom types\n${BOX}`, [['Atoms # atomic', lines]]));
    expect(firstError(q)).toMatch(/must not start with a blank or comment line/);
  });

  test('cut lines after 254 characters, as LAMMPS does', () => {
    const text = (pad) => dataFile(`1 atoms\n1 atom types\n${BOX}`, [['Atoms # atomic', [`1 1 1 1${pad}1`]]]);
    expect(parseDataFile(text(' '.repeat(240))).ok).toBe(true);
    expect(parseDataFile(text(' '.repeat(260))).ok).toBe(false);
  });

  test('stop on a type out of range, a bad number or an atom ID of 0', () => {
    const head = `2 atoms\n2 atom types\n${BOX}`;
    expect(firstError(parseDataFile(dataFile(head, [['Atoms # atomic', ['1 1 1 1 1', '2 3 2 2 2']]])))).toMatch(/Atom type 3 is not between 1 and 2/);
    expect(firstError(parseDataFile(dataFile(head, [['Atoms # atomic', ['1 1 1 1.0.5 1', '2 2 2 2 2']]])))).toMatch(/"1.0.5"/);
    expect(firstError(parseDataFile(dataFile(head, [['Atoms # atomic', ['0 1 1 1 1', '2 2 2 2 2']]])))).toMatch(/Atom ID 0/);
    // Numbers as LAMMPS reads them: 1e3, .5 and 5. are fine, 0x10 and inf are not.
    expect(parseDataFile(dataFile(head, [['Atoms # atomic', ['1 1 1e3 .5 5.', '2 2 -2E-1 +2 2']]])).ok).toBe(true);
    expect(parseDataFile(dataFile(head, [['Atoms # atomic', ['1 1 inf 1 1', '2 2 2 2 2']]])).ok).toBe(false);
  });

  test('stop on repeated atom IDs when LAMMPS can tell, and warn when it cannot', () => {
    const head = `3 atoms\n1 atom types\n${BOX}`;
    const stops = parseDataFile(dataFile(head, [['Atoms # atomic', ['1 1 1 1 1', '2 1 2 2 2', '2 1 3 3 3']]]));
    expect(firstError(stops)).toMatch(/Duplicate atom IDs/);
    const passes = parseDataFile(dataFile(head, [['Atoms # atomic', ['1 1 1 1 1', '1 1 2 2 2', '3 1 3 3 3']]]));
    expect(passes.ok).toBe(true);
    expect(passes.issues.find(i => i.severity === 'warning').message).toMatch(/used twice/);
  });

  test('lose atoms outside a box that is not periodic, as LAMMPS does', () => {
    const text = dataFile(`2 atoms\n1 atom types\n0 10 xlo xhi\n0 10 ylo yhi\n0 10 zlo zhi`, [['Atoms # atomic', ['1 1 1 1 1', '2 1 12 1 1']]]);
    expect(parseDataFile(text).ok).toBe(true);
    expect(firstError(parseDataFile(text, { boundary: 'f p p' }))).toMatch(/outside the box/);
    expect(firstError(parseDataFile(text, { boundary: 's p p' }))).toMatch(/outside the box/);
  });

  test('work the atom style out from the columns when the file does not say it', () => {
    const noHint = system().replace('Atoms # full', 'Atoms');
    const p = parseDataFile(noHint);
    expect(p.atomStyle).toBe('full');
    expect(p.atomStyleSource).toBe('columns');
    expect(p.issues.find(i => i.severity === 'note').message).toMatch(/read as atom_style full/);
    const sphere = parseDataFile(dataFile(`2 atoms\n2 atom types\n${BOX}`, [['Atoms', ['1 1 1 1 1 1 0', '2 2 1 1 2 2 0']]]));
    expect(sphere.atomStyle).toBe('sphere');
    const charge = parseDataFile(dataFile(`2 atoms\n2 atom types\n${BOX}`, [['Atoms', ['1 1 0.5 1 1 1', '2 2 -0.5 2 2 2']]]));
    expect(charge.atomStyle).toBe('charge');
    const bond = parseDataFile(dataFile(`2 atoms\n1 atom types\n1 bonds\n1 bond types\n${BOX}`, [['Atoms', ['1 1 1 1 1 1', '2 1 1 2 2 2']], ['Bonds', ['1 1 1 2']]]));
    expect(bond.atomStyle).toBe('bond');
    const images = parseDataFile(dataFile(`1 atoms\n1 atom types\n${BOX}`, [['Atoms', ['1 1 1 1 1 0 0 0']]]));
    expect(images.atomStyle).toBe('atomic');
    expect(images.imageFlags).toBe(true);
  });

  test('read velocities, and ignore IDs that are gaps', () => {
    const p = parseDataFile(dataFile(`2 atoms\n1 atom types\n${BOX}`, [['Atoms # atomic', ['1 1 1 1 1', '3 1 2 2 2']], ['Velocities', ['3 0.5 0 0', '2 9 9 9']]]));
    expect(p.ok).toBe(true);
    expect(Array.from(p.velocities)).toEqual([0, 0, 0, 0.5, 0, 0]);
    expect(p.issues[0].message).toMatch(/not in Atoms; LAMMPS ignores them/);
  });
});

describe('topology', () => {
  test('stores bonds, angles and their types as typed arrays', () => {
    const p = parseDataFile(system({ waters: 2 }));
    expect(p.bonds.n).toBe(4 + 4 + 1);
    expect(Array.from(p.bonds.atoms.subarray(0, 4))).toEqual([1, 2, 1, 3]);
    expect(p.angles.atoms.length).toBe(6);
  });

  test('stop on a bond to an atom that is not there', () => {
    const base = system({ waters: 2 });
    const beyond = base.replace(/^1 1 1 2$/m, '1 1 1 999');
    expect(firstError(parseDataFile(beyond))).toMatch(/atom IDs 1 999: each must be between 1/);
    // A gap in the IDs: atom 2 is missing, bond 1 names it.
    const gap = base.replace(/^2 1 2 0.417 .*\n/m, '').replace(/^\d+ atoms/m, n => `${parseInt(n, 10) - 1} atoms`);
    expect(firstError(parseDataFile(gap))).toMatch(/name atoms that are not in the Atoms section \(the first: atom 2\)/);
  });

  test('stop on a bond type out of range and a wrong bond count', () => {
    const base = system({ waters: 2 });
    expect(firstError(parseDataFile(base.replace(/^1 1 1 2$/m, '1 4 1 2')))).toMatch(/Bond type 4 is not between 1 and 3/);
    expect(errors(parseDataFile(base.replace(/^9 bonds/m, '10 bonds'))).length).toBeGreaterThan(0);
  });
});

describe('elements from masses', () => {
  test('name elements, united atoms and light sites', () => {
    expect(guessElement(15.9994)).toMatchObject({ element: 'O', confidence: 'high' });
    expect(guessElement(1.008)).toMatchObject({ element: 'H', confidence: 'high' });
    expect(guessElement(12.0)).toMatchObject({ element: 'C' });
    expect(guessElement(15.035)).toMatchObject({ element: null, kind: 'united-atom', label: 'CH3 (united atom)' });
    expect(guessElement(14.027)).toMatchObject({ element: null, kind: 'united-atom' });
    expect(guessElement(14.007)).toMatchObject({ element: 'N', confidence: 'high' });
    expect(guessElement(0.4)).toMatchObject({ element: null, kind: 'virtual' });
    expect(guessElement(3.024)).toMatchObject({ element: 'H', kind: 'hydrogen-heavy' });
    expect(guessElement(72)).toMatchObject({ element: null, kind: 'coarse' });
  });

  test('let a name settle a close call, and stay silent in lj units', () => {
    expect(guessElement(40.08, { name: 'CAL' }).element).toBe('Ca');
    expect(guessElement(12.011, { name: 'CA' }).element).toBe('C');
    expect(guessElement(1.0, { units: 'lj' }).element).toBe(null);
  });
});

describe('summariseData', () => {
  test('finds TIP3P water, its types for SHAKE, ions and the solute', () => {
    const s = summariseData(parseDataFile(system()), { units: 'real' });
    expect(s.natoms).toBe(35);
    expect(s.water).toMatchObject({ model: 'TIP3P', confidence: 'high', sites: 3, oType: 1, hType: 2, bondType: 1, angleType: 1, count: 8, atoms: 24 });
    expect(s.water.rOH).toBeCloseTo(0.9572, 3);
    expect(s.water.angleHOH).toBeCloseTo(104.5, 0);
    expect(s.ions.map(i => [i.name, i.count])).toEqual([['Na+', 2], ['Cl-', 2]]);
    expect(s.hydrogenTypes).toEqual([2, 6]);
    expect(s.shake).toMatchObject({ m: [1.008], t: [2, 6], b: [1, 2], a: [1] });
    expect(s.soluteTypes).toEqual([5, 6, 8]);
    expect(s.solute).toMatchObject({ atoms: 7, molecules: 2 });
    expect(s.types[7]).toMatchObject({ type: 8, kind: 'united-atom', element: null, role: 'solute' });
    expect(s.types[6]).toMatchObject({ type: 7, role: 'unused' });
    expect(s.molecules).toBe(14);
    expect(s.charge).toBeCloseTo(0, 12);
    expect(s.coeffs).toMatchObject({ pair: false, bond: false });
    expect(s.density).toBeCloseTo(s.mass / 8000 * 1.66053906660, 10);
  });

  test('names other water models by their charges', () => {
    const spce = summariseData(parseDataFile(system({ qo: -0.8476, qh: 0.4238 })));
    expect(spce.water.model).toBe('SPC/E');
    // TIP4P/2005 as LAMMPS's tip4p pair styles want it: three sites, the M charge on O.
    const tip4p = summariseData(parseDataFile(system({ qo: -1.1128, qh: 0.5564 })));
    expect(tip4p.water).toMatchObject({ model: 'TIP4P/2005', implicitM: true, qdist: 0.1546 });
    expect(tip4p.water.pairTip4p).toBe('lj/cut/tip4p/long 1 2 1 1 0.1546');
    // An explicit, nearly massless M site.
    const four = summariseData(parseDataFile(system({ m: -1.04844, qh: 0.52422 })));
    expect(four.water).toMatchObject({ model: 'TIP4P-Ew', sites: 4, mType: 7, count: 8 });
    const odd = summariseData(parseDataFile(system({ qo: -0.7, qh: 0.35 })));
    expect(odd.water.model).toBe(null);
    expect(odd.water.note).toMatch(/match no model/);
  });

  test('reports a net charge that is not zero', () => {
    const p = parseDataFile(system().replace(/^(\d+ \d+ 3) 1 /m, '$1 2 '));
    expect(p.issues.find(i => i.severity === 'warning').message).toMatch(/add up to 1.0000, not zero/);
    expect(summariseData(p).notes.join(' ')).toMatch(/net charge is 1.0000 e/);
  });

  test('finds a vacuum gap, which a barostat would close', () => {
    const slab = summariseData(parseDataFile(system().replace('0 20 zlo zhi', '0 60 zlo zhi')));
    expect(slab.vacuum).toMatchObject({ axis: 'z' });
    expect(slab.vacuum.size).toBeGreaterThan(35);
    expect(slab.notes.join(' ')).toMatch(/empty slab .* along z/);
    expect(summariseData(parseDataFile(bigEnoughWater())).vacuum).toBe(null);
  });

  test('knows no elements in lj units', () => {
    const s = summariseData(parseDataFile(dataFile(`2 atoms\n1 atom types\n${BOX}`, [['Masses', ['1 1.0']], ['Atoms # atomic', ['1 1 1 1 1', '2 1 2 2 2']]])), { units: 'lj' });
    expect(s.types[0].element).toBe(null);
    expect(s.density).toBe(null);
    expect(s.numberDensity).toBeCloseTo(2 / 8000, 15);
  });
});

describe('groupsFromData', () => {
  test('offers groups that hold exactly the atoms they name', () => {
    // The methane H shares no type with water here, so water can go by type.
    const text = system();
    const s = summariseData(parseDataFile(text));
    const g = Object.fromEntries(groupsFromData(s).map(x => [x.name, x]));
    expect(g.water).toMatchObject({ command: 'group water type 1 2', count: 24 });
    expect(g.ions).toMatchObject({ command: 'group ions type 3 4', count: 4 });
    expect(g.solute).toMatchObject({ command: 'group solute subtract all water ions', count: 7 });
    expect(g.solvent).toMatchObject({ command: 'group solvent union water ions', count: 28 });
    expect(g.hydrogens).toMatchObject({ command: 'group hydrogens type 2 6', count: 20 });
    expect(g.solute_heavy).toMatchObject({ command: 'group solute_heavy subtract solute hydrogens', count: 3 });
    for (const x of Object.values(g)) expect(x.why.length).toBeGreaterThan(10);
  });

  test('do not group water by type when a water type is used elsewhere', () => {
    const shared = system().replace(/^(\d+ \d+) 6 0.06 /gm, '$1 2 0.06 ');
    const s = summariseData(parseDataFile(shared));
    expect(s.water.count).toBe(8);
    expect(groupsFromData(s).find(x => x.name === 'water')).toBeUndefined();
  });
});

/*
 * Speed: parse a generated system of a million atoms in a child process
 * (a clock inside a busy Jest worker measures the machine, not the code).
 */
describe('speed', () => {
  test('reads a million atoms in a few seconds', () => {
    const script = `
      import { bigWaterSystem } from ${JSON.stringify(path.join(here, 'fixtures', 'lammps-data', 'big-system.mjs'))};
      import { parseDataFile } from ${JSON.stringify(path.join(ROOT, 'src', 'core', 'lammps-data.js'))};
      const text = bigWaterSystem(333334);
      const t0 = process.hrtime.bigint();
      const p = parseDataFile(text);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      console.log(JSON.stringify({ ms, atoms: p.atoms.n, bonds: p.bonds.n, ok: p.ok }));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 120000, maxBuffer: 1 << 20 });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    expect(out).toMatchObject({ atoms: 1000134, bonds: 666668, ok: true });
    // Shared CI runners are slower and busier than a desktop.
    expect(out.ms).toBeLessThan(process.env.CI ? 15000 : 6000);
  }, 180000);
});

/*
 * With LAMMPS installed (LMP_BIN), hand a good file and broken copies to
 * read_data. tools/check-lammps-data.mjs does this for every example data
 * file; this makes sure the setup still runs and agrees.
 */
const LMP = process.env.LMP_BIN || '';
const withLammps = LMP && fs.existsSync(LMP) ? describe : describe.skip;

withLammps('real read_data (LMP_BIN)', () => {
  let dir;
  const read = (text, style = 'full') => {
    fs.writeFileSync(path.join(dir, 'test.data'), text);
    fs.writeFileSync(path.join(dir, 'in.test'), `units real\natom_style ${style}\nread_data test.data nocoeff\n` +
      'print "COUNTS $(atoms) $(bonds) $(angles) $(charge(all):%.12g) $(mass(all):%.12g)"\n');
    const r = spawnSync('stdbuf', ['-oL', LMP, '-in', 'in.test', '-log', 'none', '-echo', 'none', '-nocite'],
      { cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, OMP_NUM_THREADS: '1' } });
    const m = /COUNTS (\S+) (\S+) (\S+) (\S+) (\S+)/.exec(r.stdout || '');
    return m ? m.slice(1).map(Number) : null;
  };
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stemkit-lmp-data-')); });
  afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  test('agrees on a good file and on broken ones', () => {
    const good = system();
    const cases = [
      good,
      good.replace('Masses', 'Mass'),
      good.replace(/^(\d+ \d+) 3 1 /m, '$1 9 1 '),
      good.replace(/^1 1 1 2$/m, '1 1 1 999'),
      good.replace(/^\d+ atoms/m, n => `${parseInt(n, 10) + 1} atoms`),
      good.replace(/^2 1 2 0.417 .*\n/m, '').replace(/^\d+ atoms/m, n => `${parseInt(n, 10) - 1} atoms`)
    ];
    cases.forEach((text, i) => {
      const lmp = read(text);
      const p = parseDataFile(text);
      expect([i, lmp !== null]).toEqual([i, p.ok]);
      if (lmp) {
        const s = summariseData(p);
        expect(lmp.slice(0, 3)).toEqual([p.counts.atoms, p.bonds.n, p.angles.n]);
        expect(lmp[3]).toBeCloseTo(s.charge, 9);
        expect(lmp[4]).toBeCloseTo(s.mass, 9);
      }
    });
  }, 120000);
});
