import { describe, test, expect } from '@jest/globals';
import {
  compressAtomList, numberAtoms, moleculesOf, speciesOf, safeLabel, isLabel,
  perMoleculeGroups, perMoleculeCenters, moleculeOrientations, wholeMoleculeEntities,
  selectForPlumed, backboneTorsion
} from '../src/core/plumed-atoms.js';
import { parseAtomList } from '../src/core/plumed.js';
import { parseGRO } from '../src/core/structure.js';
import { lintPlumedInput } from '../src/core/plumed-parse.js';

/* Urea has eight atoms; water three. */
const UREA = ['C', 'O', 'N1', 'H11', 'H12', 'N2', 'H21', 'H22'];
const WATER = ['OW', 'HW1', 'HW2'];

function system(nUrea, nWater) {
  const atoms = [];
  let res = 0;
  const add = (resName, names) => {
    res += 1;
    for (const atomName of names) {
      // Serial and residue numbers wrap round, as in a large .gro file.
      atoms.push({ resName, resSeq: res % 100, atomName, serial: (atoms.length + 1) % 1000, x: 0, y: 0, z: 0 });
    }
  };
  for (let i = 0; i < nUrea; i++) add('UREA', UREA);
  for (let i = 0; i < nWater; i++) add('SOL', WATER);
  return atoms;
}

describe('compressAtomList', () => {
  test('folds runs into ranges and strides', () => {
    expect(compressAtomList([1, 2, 3, 4, 5])).toBe('1-5');
    expect(compressAtomList([1, 9, 17, 25])).toBe('1-25:8');
    expect(compressAtomList([1, 2, 3, 10, 20, 30, 41])).toBe('1-3,10-30:10,41');
  });

  test('leaves a pair as two numbers', () => {
    expect(compressAtomList([3, 6])).toBe('3,6');
    expect(compressAtomList([1, 2])).toBe('1,2');
    expect(compressAtomList([7])).toBe('7');
  });

  test('keeps the order it was given', () => {
    expect(compressAtomList([5, 1])).toBe('5,1');
    expect(compressAtomList([9, 7, 5, 3])).toBe('9,7,5,3');
    expect(compressAtomList([10, 1, 2, 3])).toBe('10,1-3');
  });

  test('drops what is not an atom number', () => {
    expect(compressAtomList([0, -1, 1.5, 2, NaN, '3'])).toBe('2,3');
    expect(compressAtomList(null)).toBe('');
  });

  test('says the same atoms as the list it was given', () => {
    const lists = [[1, 9, 17, 25, 26, 27, 40], [3, 6], [2401, 2404, 2407, 5000], [1, 2, 3, 5, 8, 13, 21]];
    for (const l of lists) expect(parseAtomList(compressAtomList(l)).indices).toEqual(l);
  });
});

describe('molecules and species', () => {
  const atoms = system(300, 3085);

  test('numbers atoms by position, not by the serial in the file', () => {
    const n = numberAtoms(atoms);
    expect(n[0].index).toBe(1);
    expect(n[999].index).toBe(1000);
    expect(n[999].serial).toBe(0);
    expect(numberAtoms(null)).toEqual([]);
  });

  test('a residue number that wraps round still starts a new molecule', () => {
    const mols = moleculesOf(atoms);
    expect(mols).toHaveLength(300 + 3085);
    expect(mols[0]).toMatchObject({ name: 'UREA', first: 1 });
    expect(mols[300]).toMatchObject({ name: 'SOL', first: 2401 });
    expect(mols[300].atoms.map(a => a.index)).toEqual([2401, 2402, 2403]);
  });

  test('summarises what the system is made of', () => {
    expect(speciesOf(atoms)).toEqual([
      { name: 'UREA', molecules: 300, atomsPerMolecule: 8, atomNames: UREA, firstAtom: 1, lastAtom: 2400, uniform: true, contiguous: true },
      { name: 'SOL', molecules: 3085, atomsPerMolecule: 3, atomNames: WATER, firstAtom: 2401, lastAtom: 11655, uniform: true, contiguous: true }
    ]);
  });

  test('notices copies that differ', () => {
    const odd = system(2, 0);
    odd.pop();
    expect(speciesOf(odd)[0].uniform).toBe(false);
    expect(speciesOf([])).toEqual([]);
  });

  test('reads a real .gro file', () => {
    const gro = ['two ureas', '    4',
      '    1UREA     C    1   0.100   0.200   0.300',
      '    1UREA     O    2   0.150   0.200   0.300',
      '    2UREA     C    3   1.100   0.200   0.300',
      '    2UREA     O    4   1.150   0.200   0.300',
      '   2.00000   2.00000   2.00000', ''].join('\n');
    const { atoms: read } = parseGRO(gro);
    expect(speciesOf(read)[0]).toMatchObject({ name: 'UREA', molecules: 2, atomNames: ['C', 'O'] });
    expect(perMoleculeGroups(read, 'UREA', ['O']).lines).toEqual(['O: GROUP ATOMS=2,4']);
  });
});

describe('labels', () => {
  test('makes a word a label', () => {
    expect(safeLabel('N1')).toBe('N1');
    expect(safeLabel("O5'")).toBe('O5_');
    expect(safeLabel('1HB')).toBe('g1HB');
    expect(safeLabel('', 'c')).toBe('c');
    expect(isLabel('Ncenter')).toBe(true);
    expect(isLabel('a.b')).toBe(false);
  });
});

describe('perMoleculeGroups', () => {
  const atoms = system(300, 3085);

  test('writes the groups of the published urea input', () => {
    const r = perMoleculeGroups(atoms, 'UREA', ['C', 'O', 'N1', 'N2']);
    expect(r.lines).toEqual([
      'C: GROUP ATOMS=1-2393:8', 'O: GROUP ATOMS=2-2394:8',
      'N1: GROUP ATOMS=3-2395:8', 'N2: GROUP ATOMS=6-2398:8'
    ]);
    expect(r.groups[0].count).toBe(300);
    expect(r.warnings).toEqual([]);
    // 1-2400:8 in the published file names the same 300 atoms.
    expect(parseAtomList('1-2393:8').indices).toEqual(parseAtomList('1-2400:8').indices);
  });

  test('water oxygens', () => {
    expect(perMoleculeGroups(atoms, 'SOL', ['OW'], { labels: { OW: 'W' } }).lines)
      .toEqual(['W: GROUP ATOMS=2401-11653:3']);
  });

  test('reports a name or a molecule that is not there', () => {
    expect(perMoleculeGroups(atoms, 'UREA', ['CX']).warnings[0]).toContain('No UREA molecule has an atom named "CX"');
    expect(perMoleculeGroups(atoms, 'GLY', ['C']).warnings[0]).toContain('no molecule named "GLY"');
  });
});

describe('perMoleculeCenters', () => {
  const atoms = system(300, 0);

  test('writes one centre per molecule and a group of them', () => {
    const r = perMoleculeCenters(atoms, 'UREA', { atomNames: ['N1', 'N2'], prefix: 'c', group: 'Ncenter' });
    expect(r.lines).toHaveLength(300);
    expect(r.lines.slice(0, 3)).toEqual(['c1: CENTER ATOMS=3,6', 'c2: CENTER ATOMS=11,14', 'c3: CENTER ATOMS=19,22']);
    expect(r.lines[299]).toBe('c300: CENTER ATOMS=2395,2398');
    expect(r.groupLine.startsWith('Ncenter: GROUP ATOMS=c1,c2,c3,')).toBe(true);
    expect(r.groupLine.endsWith(',c300')).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  test('the whole molecule, by mass', () => {
    const r = perMoleculeCenters(system(2, 0), 'UREA', { mass: true });
    expect(r.lines).toEqual(['c1: CENTER ATOMS=1-8 MASS', 'c2: CENTER ATOMS=9-16 MASS']);
    expect(perMoleculeCenters(system(1, 0), 'UREA', { action: 'COM' }).lines).toEqual(['c1: COM ATOMS=1-8']);
  });

  test('what it writes is a sound PLUMED input', () => {
    const r = perMoleculeCenters(atoms, 'UREA', { atomNames: ['N1', 'N2'], group: 'Ncenter' });
    const text = [...r.lines, r.groupLine, 'cn: COORDINATIONNUMBER SPECIES=Ncenter SWITCH={RATIONAL R_0=0.6} MEAN'].join('\n');
    expect(lintPlumedInput(text, { natoms: 2400 }).summary.errors).toBe(0);
  });

  test('warns when the group would share a label with a centre', () => {
    const r = perMoleculeCenters(system(2, 0), 'UREA', { prefix: 'c', group: 'c1' });
    expect(r.warnings[0]).toContain('also the label of a centre');
  });
});

describe('moleculeOrientations', () => {
  const atoms = system(3, 2);

  test('MOLECULES for PLUMED 2.9', () => {
    const r = moleculeOrientations(atoms, 'UREA', { start: 'C', end: 'O', label: 'm1', version: '2.9' });
    expect(r.lines).toEqual(['MOLECULES ...', '  MOL1=1,2,1', '  MOL2=9,10,9', '  MOL3=17,18,17', '  LABEL=m1', '...']);
    expect(r.count).toBe(3);
  });

  test('DISTANCES with LOCATION from 2.10', () => {
    const r = moleculeOrientations(atoms, 'UREA', { start: 'N1', end: 'N2', centre: 'C', version: '2.11' });
    expect(r.lines).toEqual([
      'DISTANCES ...', '  ATOMS1=3,6 LOCATION1=1', '  ATOMS2=11,14 LOCATION2=9',
      '  ATOMS3=19,22 LOCATION3=17', '  COMPONENTS LABEL=m1', '...'
    ]);
    expect(lintPlumedInput(r.lines.join('\n')).summary.errors).toBe(0);
  });

  test('reports what is missing', () => {
    expect(moleculeOrientations(atoms, 'UREA', { start: 'C' }).warnings[0]).toContain('Name the two atoms');
    expect(moleculeOrientations(atoms, 'UREA', { start: 'C', end: 'C' }).warnings[0]).toContain('to itself');
    expect(moleculeOrientations(atoms, 'UREA', { start: 'C', end: 'XX' }).warnings[0]).toContain('3 of 3');
    expect(moleculeOrientations(atoms, 'NOPE', { start: 'C', end: 'O' }).count).toBe(0);
  });
});

describe('wholeMoleculeEntities', () => {
  test('one entity per molecule', () => {
    expect(wholeMoleculeEntities(system(2, 1), ['UREA']).entities).toEqual(['1-8', '9-16']);
  });

  test('bonded residues of a chain are one entity', () => {
    const chain = [];
    for (let r = 1; r <= 3; r++) {
      for (const atomName of ['N', 'CA', 'C']) chain.push({ resName: 'ALA', resSeq: r, chain: 'A', atomName });
    }
    expect(wholeMoleculeEntities(chain, ['ALA'], { joinChains: true }).entities).toEqual(['1-9']);
    expect(wholeMoleculeEntities(chain, ['ALA']).entities).toEqual(['1-3', '4-6', '7-9']);
  });

  test('warns when there are too many to rebuild', () => {
    const r = wholeMoleculeEntities(system(0, 600), ['SOL']);
    expect(r.entities).toHaveLength(500);
    expect(r.warnings[0]).toContain('600 molecules');
  });
});

describe('selectForPlumed', () => {
  const atoms = system(300, 3085);

  test('writes a selection as PLUMED reads it', () => {
    expect(selectForPlumed(atoms, 'resn:UREA atom:C')).toMatchObject({ list: '1-2393:8', count: 300 });
    expect(selectForPlumed(atoms, 'resn:SOL atom:OW').list).toBe('2401-11653:3');
    expect(selectForPlumed(atoms, 'resn:UREA').list).toBe('1-2400');
  });

  test('nothing selected', () => {
    expect(selectForPlumed(atoms, 'resn:GLY')).toMatchObject({ list: '', count: 0 });
  });
});

describe('backboneTorsion', () => {
  const chain = [];
  for (let r = 1; r <= 3; r++) {
    for (const atomName of ['N', 'H', 'CA', 'C', 'O']) chain.push({ resName: 'ALA', resSeq: r, chain: 'A', atomName });
  }

  test('phi and psi of a residue', () => {
    expect(backboneTorsion(chain, 'phi', 2).list).toBe('4,6,8,9');
    expect(backboneTorsion(chain, 'psi', 2).list).toBe('6,8,9,11');
  });

  test('the ends of a chain lack one of the two', () => {
    expect(backboneTorsion(chain, 'phi', 1).error).toContain('needs the residue before');
    expect(backboneTorsion(chain, 'psi', 3).error).toContain('needs the residue after');
    expect(backboneTorsion(chain, 'phi', 9).error).toContain('no residue 9');
    expect(backboneTorsion(chain, 'chi', 2).error).toContain('Unknown torsion');
  });
});
