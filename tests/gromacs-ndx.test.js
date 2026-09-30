import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  RESIDUE_TYPES, residueTypeOf, readGromacsStructure, toGromacsStructure, defaultGroups, makeNdx,
  findGroupMakeNdx, writeNdx, parseNdx, isValidGroupName, sanitiseGroupName, findIndexGroup,
  mergeIndexGroups, renameIndexGroup, checkGroupCoverage, checkMdpGroups, customGroup, orGroups,
  andGroups, notGroup, systemComposition, recommendTcGrps, suggestGroups, describeGroups
} from '../src/core/gromacs-ndx.js';
import { parseGRO } from '../src/core/structure.js';
import { largeSystemGro } from './fixtures/gromacs-ndx/large-system.mjs';

/*
 * Every expected .ndx and digest under fixtures/gromacs-ndx was written by
 * `gmx make_ndx` (GROMACS 2025) itself; tools/check-gromacs-ndx.mjs
 * regenerates and rechecks them against a real GROMACS.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, 'fixtures', 'gromacs-ndx');
const read = name => fs.readFileSync(path.join(FIX, name), 'utf8');
const structureOf = name => readGromacsStructure(read(name), name);
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const group = (groups, name) => groups.find(g => g.name === name);
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

const STRUCTURES = ['complex.gro', 'membrane.gro', 'quirks.pdb', 'order.gro', 'wrap.gro',
  'water-first.gro', 'names.gro'];

/* A small .gro written the way GROMACS writes one. */
function gro(residues, box = '   3.00000   3.00000   3.00000') {
  const rows = [];
  let n = 0;
  residues.forEach(([name, atoms, nr], r) => {
    for (const [atom, x = 0, y = 0, z = 0] of atoms) {
      n += 1;
      const f = v => v.toFixed(3).padStart(8);
      rows.push(`${String((nr ?? r + 1) % 100000).padStart(5)}${name.padEnd(5)}${atom.padStart(5)}` +
        `${String(n % 100000).padStart(5)}${f(x)}${f(y)}${f(z)}`);
    }
  });
  return `test\n${String(n).padStart(5)}\n${rows.join('\n')}\n${box}\n`;
}
const WATER = [['OW'], ['HW1'], ['HW2']];

describe('residue types', () => {
  test('embed residuetypes.dat', () => {
    // 207 lines in the 2025.1 file, HYP listed twice.
    expect(Object.keys(RESIDUE_TYPES)).toHaveLength(206);
    expect(residueTypeOf('ALA')).toBe('Protein');
    expect(residueTypeOf('NME')).toBe('Protein');
    expect(residueTypeOf('DT5')).toBe('DNA');
    expect(residueTypeOf('U')).toBe('RNA');
    expect(residueTypeOf('HOH')).toBe('Water');
    expect(residueTypeOf('CL-')).toBe('Ion');
  });

  test('are looked up case-sensitively, as GROMACS effectively does', () => {
    expect(residueTypeOf('Cal')).toBe('Ion');
    expect(residueTypeOf('CAL')).toBe('Other');
    expect(residueTypeOf('ala')).toBe('Other');
    expect(residueTypeOf('sol')).toBe('Other');
  });

  test('leave CHARMM water, ions and lipids as Other', () => {
    for (const name of ['TIP3', 'SOD', 'CLA', 'POPC', 'CHL1']) expect(residueTypeOf(name)).toBe('Other');
  });
});

describe('reading structures as GROMACS does', () => {
  test('numbers atoms by position, whatever the file calls them', () => {
    const top = structureOf('wrap.gro');
    expect(top.errors).toEqual([]);
    expect(top.atoms).toHaveLength(17);
    // Serials 99990..99999 then 0..6 in the file; positions 1..17 here.
    expect(defaultGroups(top)[0].atoms).toEqual(range(1, 17));
  });

  test('split .gro residues where the number or the name changes', () => {
    const top = structureOf('wrap.gro');
    expect(top.residues.map(r => `${r.name}${r.nr}:${r.count}`)).toEqual(
      ['SOL99998:3', 'SOL99999:3', 'SOL0:3', 'ALA1:4', 'GLY2:1', 'CA2:1', 'C2:1', 'GLY2:1']);
  });

  test('read a .gro residue name with sscanf("%5s"), running into the atom name', () => {
    // A blank name field lets the atom name through: residue CA (an ion),
    // residue C (RNA); a right-aligned name runs on into a five-letter atom.
    expect(structureOf('wrap.gro').residues.map(r => r.name)).toContain('CA');
    expect(structureOf('names.gro').residues.map(r => r.name)).toContain('ABCHH');
  });

  test('read PDB residue names from four columns and stop at ENDMDL', () => {
    const top = structureOf('quirks.pdb');
    expect(top.errors).toEqual([]);
    expect(top.atoms).toHaveLength(98);
    const names = top.residues.map(r => r.name);
    expect(names).toContain('TIP3');
    expect(names).toContain('POPC');
    expect(top.title).toBe('QUIRKS TEST');
    expect(top.box).toEqual([[4, 0, 0], [0, 4, 0], [0, 0, 4]]);
  });

  test('split PDB residues on insertion codes, keeping alternate locations', () => {
    const res = structureOf('quirks.pdb').residues;
    expect(res.filter(r => r.name === 'GLY').map(r => `${r.nr}${r.ic.trim()}:${r.count}`)).toEqual(['2:7', '2A:5']);
    expect(res.find(r => r.name === 'SER').count).toBe(7);
    expect(res.find(r => r.name === 'DA').chain).toBe('B');
  });

  test('say when later models are ignored', () => {
    expect(structureOf('quirks.pdb').warnings).toEqual(
      ['GROMACS reads only the first model; the 4 atoms after the first ENDMDL are ignored.']);
  });

  test('read CRLF files the same', () => {
    const crlf = readGromacsStructure(read('quirks.pdb').replace(/\n/g, '\r\n'), 'quirks.pdb');
    expect(writeNdx(defaultGroups(crlf))).toBe(read('quirks.ndx'));
  });

  test('take the coordinate width from the decimal points', () => {
    const text = 'wide\n    2\n    1SOL     OW    1   0.1234   1.5000  -2.2500\n' +
      '    1SOL    HW1    2   0.2000   1.6000  -2.3000\n   3.0   3.0   3.0\n';
    const top = readGromacsStructure(text, 'gro');
    expect(top.errors).toEqual([]);
    expect([top.atoms[0].x, top.atoms[0].y, top.atoms[0].z]).toEqual([0.1234, 1.5, -2.25]);
  });

  test('keep a triclinic box', () => {
    const dodecahedron = '   5.00000   5.00000   3.53553   0.00000   0.00000   0.00000' +
      '   0.00000   2.50000   2.50000';
    const top = readGromacsStructure(gro([['SOL', WATER]], dodecahedron), 'gro');
    expect(top.box).toEqual([[5, 0, 0], [0, 5, 0], [2.5, 2.5, 3.53553]]);
  });

  test('report what GROMACS would stop on', () => {
    expect(readGromacsStructure('title\nno count\n', 'gro').errors[0]).toMatch(/number of atoms/);
    expect(readGromacsStructure('title\n    3\n    1SOL     OW    1   0.000   0.000   0.000\n', 'gro').errors[0])
      .toMatch(/Unexpected end of file/);
    expect(readGromacsStructure('title\n    1\n    1SOL  OW\n', 'gro').errors[0]).toMatch(/Invalid line/);
    expect(readGromacsStructure('x', 'mol2').errors[0]).toMatch(/\.gro and \.pdb/);
  });

  test('sniff the format when none is given', () => {
    expect(readGromacsStructure(read('quirks.pdb')).format).toBe('pdb');
    expect(readGromacsStructure(read('complex.gro')).format).toBe('gro');
  });

  test('accept a core/structure.js parse result', () => {
    const fromStructure = toGromacsStructure(parseGRO(read('complex.gro')));
    expect(writeNdx(defaultGroups(fromStructure))).toBe(read('complex.ndx'));
    expect(defaultGroups(parseGRO(read('membrane.gro')))).toEqual(defaultGroups(structureOf('membrane.gro')));
  });

  test('warn that a structure.js PDB loses four-letter residue names', () => {
    const atoms = [{ resName: 'POP', resSeq: 1, atomName: 'P' }];
    const top = toGromacsStructure({ format: 'pdb', unit: 'A', atoms });
    expect(top.warnings[0]).toMatch(/three characters/);
  });

  test('accept a plain atom array, converting ångström', () => {
    const top = toGromacsStructure([{ resName: 'SOL', resSeq: 1, atomName: 'OW', x: 10, y: 0, z: 0 }], { unit: 'A' });
    expect(top.atoms[0].x).toBe(1);
    expect(toGromacsStructure(top)).toBe(top);
  });
});

describe('default groups agree with gmx make_ndx', () => {
  test.each(STRUCTURES)('%s, byte for byte', (name) => {
    const expected = read(name.replace(/\.(gro|pdb)$/, '.ndx'));
    expect(writeNdx(defaultGroups(structureOf(name)))).toBe(expected);
  });

  test('protein, ligand, water and ions', () => {
    expect(defaultGroups(structureOf('complex.gro')).map(g => g.name)).toEqual([
      'System', 'Protein', 'Protein-H', 'C-alpha', 'Backbone', 'MainChain', 'MainChain+Cb',
      'MainChain+H', 'SideChain', 'SideChain-H', 'Prot-Masses', 'non-Protein', 'Other', 'LIG',
      'NA', 'CL', 'Water', 'SOL', 'non-Water', 'Ion', 'Water_and_ions']);
  });

  test('a protein-only system has no Prot-Masses: it is compared with System', () => {
    const top = readGromacsStructure(gro([['ALA', [['N'], ['CA'], ['C'], ['O']]]]), 'gro');
    expect(defaultGroups(top).map(g => g.name)).not.toContain('Prot-Masses');
  });

  test('Prot-Masses is compared with the group before Protein, here non-Water', () => {
    const names = defaultGroups(structureOf('water-first.gro')).map(g => g.name);
    expect(names.slice(0, 4)).toEqual(['System', 'Water', 'SOL', 'non-Water']);
    expect(names).not.toContain('Prot-Masses');
  });

  test('Prot-Masses leaves out dummy masses', () => {
    const g = defaultGroups(structureOf('quirks.pdb'));
    expect(group(g, 'Protein').atoms.length - group(g, 'Prot-Masses').atoms.length).toBe(2);
  });

  test('hydrogens are found after leading digits, ignoring case', () => {
    const top = readGromacsStructure(gro([['ALA', [['N'], ['1HB'], ['hb2'], ['CA'], ['HN'], ['C'], ['O']]]]), 'gro');
    const g = defaultGroups(top);
    expect(group(g, 'Protein-H').atoms).toEqual([1, 4, 6, 7]);
    expect(group(g, 'MainChain+H').atoms).toEqual([1, 4, 5, 6, 7]);
  });

  test('only the first of DNA, RNA and Other gets a category group', () => {
    const names = defaultGroups(structureOf('order.gro')).map(g => g.name);
    expect(names).toContain('DNA');
    expect(names).not.toContain('Other');
    expect(names).not.toContain('RNA');
    // Per-residue-name groups cover ions and Other alike.
    expect(names.slice(names.indexOf('DNA') + 1))
      .toEqual(['HEM', 'Water', 'ION', 'NA', 'MeOH', 'Ion', 'Water_and_ions']);
  });

  test('Water_and_ions joins the last groups named Water and Ion', () => {
    const g = defaultGroups(structureOf('names.gro'));
    expect(g.filter(x => x.name === 'Water')).toHaveLength(2);
    expect(group(g, 'Water_and_ions').atoms).toEqual([8, 2, 10]);
  });

  test('CHARMM water and ions give no Water_and_ions', () => {
    const names = defaultGroups(structureOf('membrane.gro')).map(g => g.name);
    expect(names.slice(-6)).toEqual(['Other', 'POPC', 'CHL1', 'TIP3', 'SOD', 'CLA']);
    expect(names).not.toContain('Water_and_ions');
  });

  test('an empty structure has only System', () => {
    expect(defaultGroups(readGromacsStructure('', 'gro'))).toEqual([{ name: 'System', atoms: [] }]);
  });

  test('a system past 99 999 atoms and residues', () => {
    const expected = JSON.parse(read('large-system.json'));
    const groups = defaultGroups(readGromacsStructure(largeSystemGro(), 'large.gro'));
    expect(groups.map(g => [g.name, g.atoms.length])).toEqual(expected.groups);
    expect(sha(writeNdx(groups))).toBe(expected.sha256);
  });
});

describe('make_ndx commands', () => {
  const cases = JSON.parse(read('commands.json'));

  test.each(cases.map(c => [c.file, c.commands, c]))('%s: %j', (file, commands, c) => {
    const { groups } = makeNdx(structureOf(file), `${commands}\nq`);
    expect(groups).toHaveLength(c.groups);
    expect(groups[groups.length - 1].name).toBe(c.last);
    expect(sha(writeNdx(groups))).toBe(c.sha256);
  });

  test('name groups the way make_ndx does', () => {
    const top = structureOf('complex.gro');
    const last = cmd => { const g = makeNdx(top, cmd).groups; return g[g.length - 1]; };
    expect(last('1 | 13').name).toBe('Protein_LIG');
    expect(last('r 1-5 & a CA').name).toBe('r_1-5_&_CA');
    expect(last('! "Water_and_ions"').name).toBe('!Water_and_ions');
    expect(last('chain A').name).toBe('Water_and_ions');
  });

  test('say what they did', () => {
    const { log } = makeNdx(structureOf('complex.gro'), ['1 | 13', 'foo', 'r XYZ', 't CA', 'q']);
    expect(log).toContain('Merged two groups with OR: 198 16 -> 214');
    expect(log).toContain('Syntax error: "foo"');
    expect(log).toContain('Group is empty');
    expect(log).toContain('Need a run input file to select atom types');
  });

  test('stop at q', () => {
    const { groups } = makeNdx(structureOf('complex.gro'), 'q\n1 | 13');
    expect(groups).toHaveLength(21);
  });

  test('start from given groups', () => {
    const top = structureOf('complex.gro');
    const own = [{ name: 'A', atoms: [1, 2, 3] }, { name: 'B', atoms: [3, 4] }];
    const { groups } = makeNdx(top, '0 | 1\n0 & 1\n!0', { groups: own });
    expect(groups.slice(2)).toEqual([
      { name: 'A_B', atoms: [1, 2, 3, 4] },
      { name: 'A_&_B', atoms: [3] },
      { name: '!A', atoms: range(4, 308) }]);
  });

  test('find quoted groups by whole name, then prefix, then substring', () => {
    const g = [{ name: 'Protein' }, { name: 'Protein-H' }, { name: 'Water' }, { name: 'Water_and_ions' }];
    expect(findGroupMakeNdx('protein', g)).toBe(0);
    expect(findGroupMakeNdx('ProteinH', g)).toBe(1);
    expect(findGroupMakeNdx('Wat', g)).toBe(-1);
    expect(findGroupMakeNdx('and', g)).toBe(3);
  });
});

describe('.ndx files', () => {
  test('are written fifteen numbers to a line, each four wide', () => {
    const text = writeNdx([{ name: 'A', atoms: range(1, 16) }, { name: 'Empty', atoms: [] },
      { name: 'Big', atoms: [9999, 10000, 123456] }]);
    expect(text).toBe('[ A ]\n   1    2    3    4    5    6    7    8    9   10   11   12   13   14   15\n' +
      '  16\n[ Empty ]\n[ Big ]\n9999 10000 123456\n');
  });

  test('read back what was written', () => {
    const groups = defaultGroups(structureOf('complex.gro'));
    const parsed = parseNdx(writeNdx(groups));
    expect(parsed.errors).toEqual([]);
    expect(parsed.groups).toEqual(groups);
  });

  test('are read as GROMACS reads them', () => {
    const text = '; made by hand\n\n[ Protein ligand ]  ; first word only\n 1 2\t3\r\n4\n' +
      '[Water]\n5 6 7\n  [ empty ]\n[ odd ]\n8x -1 abc\n';
    const r = parseNdx(text);
    expect(r.errors).toEqual([]);
    expect(r.groups).toEqual([
      { name: 'Protein', atoms: [1, 2, 3, 4] },
      { name: 'Water', atoms: [5, 6, 7] },
      { name: 'empty', atoms: [] },
      { name: 'odd', atoms: [8, -1, 0] }]);
    expect(r.warnings[0]).toMatch(/odd has 2 atom numbers below 1/);
  });

  test('report files GROMACS refuses', () => {
    expect(parseNdx('1 2 3\n[ A ]\n').errors[0]).toMatch(/first header/);
    expect(parseNdx('[ A \n1\n').errors[0]).toMatch(/not terminated/);
  });

  test('carry only usable group names', () => {
    expect(isValidGroupName('Protein_LIG')).toBe(true);
    expect(isValidGroupName('Water and ions')).toBe(false);
    expect(isValidGroupName('a;b')).toBe(false);
    expect(isValidGroupName('')).toBe(false);
    expect(sanitiseGroupName(' My [group]; ')).toBe('My_group_');
    expect(writeNdx([{ name: 'My group', atoms: [1] }])).toBe('[ My_group ]\n   1\n');
  });

  test('find groups as grompp does: the first match, ignoring case', () => {
    const g = [{ name: 'SOL' }, { name: 'Protein' }, { name: 'protein' }];
    expect(findIndexGroup(g, 'PROTEIN')).toBe(1);
    expect(findIndexGroup(g, 'Prot')).toBe(-1);
  });

  test('merge, renaming, replacing or keeping clashes', () => {
    const old = [{ name: 'System', atoms: [1, 2, 3] }, { name: 'LIG', atoms: [3] }];
    const add = [{ name: 'lig', atoms: [2] }, { name: 'System', atoms: [1, 2, 3] }, { name: 'New', atoms: [1] }];
    const r = mergeIndexGroups(old, add);
    expect(r.groups.map(g => g.name)).toEqual(['System', 'LIG', 'lig_2', 'New']);
    expect(r.renamed).toEqual([{ from: 'lig', to: 'lig_2' }]);
    expect(r.skipped).toEqual(['System']);
    expect(mergeIndexGroups(old, add, { onConflict: 'replace' }).groups[1]).toEqual({ name: 'lig', atoms: [2] });
    expect(mergeIndexGroups(old, add, { onConflict: 'keep' }).groups.map(g => g.name))
      .toEqual(['System', 'LIG', 'New']);
    expect(old[1]).toEqual({ name: 'LIG', atoms: [3] });
  });

  test('rename, refusing names grompp could not use', () => {
    const g = [{ name: 'A', atoms: [1] }, { name: 'B', atoms: [2] }];
    expect(renameIndexGroup(g, 'a', 'Ligand').groups[0].name).toBe('Ligand');
    expect(renameIndexGroup(g, 1, 'Solvent').groups[1].name).toBe('Solvent');
    expect(renameIndexGroup(g, 0, 'b').error).toMatch(/already called B/);
    expect(renameIndexGroup(g, 0, 'two words').error).toMatch(/cannot be a group name/);
    expect(renameIndexGroup(g, 'C', 'D').error).toMatch(/no group C/);
  });
});

describe('custom groups', () => {
  const complex = structureOf('complex.gro');
  const defaults = defaultGroups(complex);
  const lig = group(defaults, 'LIG').atoms;

  test('by residue name, number, index, atom name and atom number', () => {
    expect(customGroup(complex, { resname: 'lig' })).toEqual({ name: 'LIG', atoms: lig, errors: [] });
    expect(customGroup(complex, { resnr: [1, 3], atomname: 'CA' }))
      .toEqual({ name: 'r_1-3_&_CA', atoms: [5, 22, 33], errors: [] });
    expect(customGroup(complex, { resnr: '1-3', atomname: 'CA' }).atoms)
      .toEqual(customGroup(complex, { resindex: [1, 3], atomname: 'CA' }).atoms);
    expect(customGroup(complex, { atoms: '1-3, 10' }).atoms).toEqual([1, 2, 3, 10]);
    expect(customGroup(complex, { resname: 'L*' }).atoms)
      .toEqual(customGroup(complex, { resname: ['LEU', 'LYS', 'LIG'] }).atoms);
  });

  test('match make_ndx for the same selection', () => {
    const viaCommands = makeNdx(complex, 'r 1-5 & a C* & ! a CA').groups.pop().atoms;
    const spec = { resnr: '1-5', atomname: 'C*', not: { atomname: 'CA' } };
    expect(customGroup(complex, spec).atoms).toEqual(viaCommands);
    const complexGroup = makeNdx(complex, '1 | 13').groups.pop();
    expect(customGroup(complex, { or: [{ group: 'Protein' }, { resname: 'LIG' }] }).atoms)
      .toEqual(complexGroup.atoms);
  });

  test('by chain and element', () => {
    const q = structureOf('quirks.pdb');
    expect(customGroup(q, { chain: 'B' }).atoms).toEqual(range(68, 80));
    expect(customGroup(q, { element: 'zn' }).atoms).toEqual([98]);
    const oxygens = customGroup(complex, { element: 'O', resname: 'SOL' });
    expect(oxygens.atoms).toHaveLength(30);
  });

  test('by the selection language, distances in nm', () => {
    const r = customGroup(complex, { query: 'resn:LIG elem:O' });
    expect(r.errors).toEqual([]);
    expect(r.atoms).toEqual([lig[7], lig[8]]);
    const near = customGroup(complex, { query: 'resn:SOL within:0.5,resn:LIG', name: 'Shell' });
    const same = customGroup(complex, { resname: 'SOL', within: { distance: 0.5, of: 'LIG', pbc: false } });
    expect(near.atoms).toEqual(same.atoms);
    expect(near.name).toBe('Shell');
  });

  test('within a distance, as whole residues', () => {
    const pocket = customGroup(complex,
      { group: 'Protein', within: { distance: 0.5, of: { resname: 'LIG' }, byResidue: true } });
    expect(pocket.atoms.length).toBeGreaterThan(0);
    // Whole residues: every atom of a touched residue is in.
    const res = new Set(pocket.atoms.map(a => complex.atoms[a - 1].resIndex));
    const whole = complex.atoms.map((a, i) => i + 1).filter(i => res.has(complex.atoms[i - 1].resIndex));
    expect(pocket.atoms).toEqual(whole);
    expect(pocket.atoms.every(a => group(defaults, 'Protein').atoms.includes(a))).toBe(true);
  });

  test('within a distance across the periodic boundary', () => {
    const top = readGromacsStructure(gro([['AR', [['AR', 0.05, 1, 1]]], ['KR', [['KR', 2.95, 1, 1]]]]), 'gro');
    expect(customGroup(top, { resname: 'KR', within: { distance: 0.2, of: 'AR' } }).atoms).toEqual([2]);
    expect(customGroup(top, { resname: 'KR', within: { distance: 0.2, of: 'AR', pbc: false } }).atoms).toEqual([]);
  });

  test('by role', () => {
    expect(customGroup(complex, { role: 'ligand' }).atoms).toEqual(lig);
    expect(customGroup(complex, { role: 'solvent' }).atoms)
      .toEqual(group(defaults, 'non-Protein').atoms.filter(a => !lig.includes(a)));
    const m = structureOf('membrane.gro');
    expect(customGroup(m, { role: 'lipid' }).atoms).toHaveLength(120);
  });

  test('report what they could not do', () => {
    expect(customGroup(complex, { group: 'Nope' }))
      .toEqual({ name: 'Nope', atoms: [], errors: ['There is no group Nope.'] });
    expect(customGroup(complex, { resnr: 'x-y' }).errors[0]).toMatch(/residue numbers/);
    expect(customGroup(complex, { within: { distance: 0.5 } }).errors[0]).toMatch(/within needs/);
    expect(customGroup(complex, { query: 'bogus' }).errors[0]).toMatch(/Ignored/);
  });

  test('set operations', () => {
    const a = { name: 'A', atoms: [5, 1, 3] };
    const b = { name: 'B', atoms: [3, 4] };
    expect(orGroups(a, b)).toEqual({ name: 'A_B', atoms: [1, 3, 4, 5] });
    expect(andGroups(a, b)).toEqual({ name: 'A_&_B', atoms: [3] });
    expect(notGroup(a, 6)).toEqual({ name: '!A', atoms: [2, 4, 6] });
    expect(notGroup(a, complex, 'Rest').atoms).toHaveLength(305);
  });
});

describe('suggestions', () => {
  test('a protein-ligand complex in water with ions', () => {
    const top = structureOf('complex.gro');
    const s = suggestGroups(top);
    const defaults = defaultGroups(top);
    expect(s.ligands).toEqual([{ name: 'LIG', residues: 1, atoms: 16 }]);
    const complex = group(s.groups, 'Protein_LIG');
    expect(complex.kind).toBe('complex');
    expect(complex.atoms).toEqual(orGroups(group(defaults, 'Protein'), group(defaults, 'LIG')).atoms);
    const pocket = group(s.groups, 'Pocket_LIG');
    expect(pocket.atoms.length).toBeGreaterThan(0);
    expect(pocket.atoms.every(a => group(defaults, 'Protein').atoms.includes(a))).toBe(true);
    expect(s.tcGrps.names).toEqual(['Protein_LIG', 'Water_and_ions']);
    expect(s.tcGrps.line).toBe('tc-grps = Protein_LIG Water_and_ions');
    expect(s.tcGrps.groups).toEqual([]);
  });

  test('a protein in water with ions: Protein and non-Protein', () => {
    const top = structureOf('complex.gro');
    const records = top.atoms.map(a => {
      const r = top.residues[a.resIndex];
      return { ...a, atomName: a.name, resName: r.name, resSeq: r.nr };
    });
    const noLigand = toGromacsStructure(records.filter(a => a.resName !== 'LIG'));
    const s = suggestGroups(noLigand);
    expect(s.groups).toEqual([]);
    expect(s.tcGrps.names).toEqual(['Protein', 'non-Protein']);
  });

  test('a CHARMM membrane: lipids and CHARMM solvent recognised', () => {
    const top = structureOf('membrane.gro');
    const s = suggestGroups(top);
    expect(s.lipids).toEqual(['POPC', 'CHL1']);
    expect(s.ligands).toEqual([]);
    expect(group(s.groups, 'Membrane').atoms).toHaveLength(120);
    const solvent = group(s.groups, 'Solvent');
    expect(solvent.atoms).toHaveLength(39);
    expect(solvent.reason).toMatch(/under Other/);
    expect(s.tcGrps.names).toEqual(['Protein_Membrane', 'Solvent']);
    expect(group(s.groups, 'Protein_Membrane').kind).toBe('tc-grps');
  });

  test('a bare bilayer: Membrane and Solvent', () => {
    const rows = [];
    for (let i = 0; i < 4; i++) rows.push(['DPPC', [['N'], ['P'], ['C21'], ['C31']]]);
    for (let i = 0; i < 20; i++) rows.push(['SOL', WATER]);
    const tc = recommendTcGrps(readGromacsStructure(gro(rows), 'gro'));
    expect(tc.names).toEqual(['Membrane', 'Water']);
    expect(tc.groups.map(g => g.name)).toEqual(['Membrane']);
  });

  test('AMBER split lipids count only with heads and tails together', () => {
    const split = [['PA', [['C1']]], ['PC', [['P']]], ['OL', [['C1']]], ['WAT', WATER]];
    const lipid = systemComposition(readGromacsStructure(gro(split), 'gro'));
    expect(lipid.map(c => c.role)).toEqual(['lipid', 'lipid', 'lipid', 'water']);
    const argon = systemComposition(readGromacsStructure(gro([['AR', [['AR']]], ['SOL', WATER]]), 'gro'));
    expect(argon[0].role).toBe('ligand');
  });

  test('a modified amino acid in the chain is protein, not a ligand', () => {
    const aa = name => [name, [['N', 0.1], ['CA', 0.2], ['C', 0.3], ['O', 0.4], ['CB', 0.5]]];
    const rows = [aa('ALA'), aa('SEP'), aa('GLY'), ['LIG', [['C1', 0.6], ['N1', 0.6, 0.1]]]];
    for (let i = 0; i < 40; i++) rows.push(['SOL', WATER.map(([n]) => [n, 1 + i * 0.05, 1, 1])]);
    const top = readGromacsStructure(gro(rows), 'gro');
    expect(systemComposition(top).map(c => `${c.name}:${c.type}:${c.role}`).slice(0, 4))
      .toEqual(['ALA:Protein:protein', 'SEP:Other:protein', 'GLY:Protein:protein', 'LIG:Other:ligand']);
    const s = suggestGroups(top, { minAtoms: 10 });
    expect(s.ligands.map(l => l.name)).toEqual(['LIG']);
    expect(group(s.groups, 'Protein_SEP_LIG').atoms).toEqual(range(1, 17));
    expect(s.tcGrps.names).toEqual(['Protein_SEP_LIG', 'Water']);
    // Alone, the same residue is a ligand.
    expect(systemComposition(readGromacsStructure(gro([aa('SEP'), ['SOL', WATER]]), 'gro'))[0].role).toBe('ligand');
  });

  test('many copies of a small molecule are a cosolvent', () => {
    const rows = [['LIG', [['C1'], ['C2']]]];
    for (let i = 0; i < 8; i++) rows.push(['EOH', [['C1'], ['O1']]]);
    rows.push(['SOL', WATER]);
    const c = systemComposition(readGromacsStructure(gro(rows), 'gro'));
    expect(c.map(x => `${x.name}:${x.role}:${x.residues}`))
      .toEqual(['LIG:ligand:1', 'EOH:cosolvent:8', 'SOL:water:1']);
    expect(systemComposition(readGromacsStructure(gro(rows), 'gro'), { maxLigandCopies: 10 })[1].role).toBe('ligand');
  });

  test('one bath when there is no solvent or the solute is tiny', () => {
    const vacuum = readGromacsStructure(gro([['ALA', [['N'], ['CA'], ['C'], ['O']]]]), 'gro');
    expect(recommendTcGrps(vacuum).names).toEqual(['System']);
    const small = readGromacsStructure(gro([['ALA', [['N'], ['CA'], ['C'], ['O']]], ['SOL', WATER]]), 'gro');
    const r = recommendTcGrps(small);
    expect(r.names).toEqual(['System']);
    expect(r.reason).toMatch(/only 4 atoms/);
    expect(recommendTcGrps(small, { minAtoms: 1 }).names).toEqual(['Protein', 'non-Protein']);
    expect(recommendTcGrps(readGromacsStructure(gro([['SOL', WATER]]), 'gro')).names).toEqual(['System']);
  });

  test('every suggestion is a valid, grompp-ready index', () => {
    for (const name of STRUCTURES) {
      const top = structureOf(name);
      const s = suggestGroups(top);
      const all = [...defaultGroups(top), ...s.groups];
      // New names are valid and clash with no default name, ignoring case.
      const taken = new Set(defaultGroups(top).map(g => g.name.toUpperCase()));
      for (const g of s.groups) {
        expect(isValidGroupName(g.name)).toBe(true);
        expect(taken.has(g.name.toUpperCase())).toBe(false);
        taken.add(g.name.toUpperCase());
      }
      expect(parseNdx(writeNdx(all)).groups).toHaveLength(all.length);
      expect(checkGroupCoverage(all, s.tcGrps.names, top.atoms.length).ok).toBe(true);
    }
  });
});

describe('tc-grps and other .mdp groups', () => {
  const top = structureOf('complex.gro');
  const groups = defaultGroups(top);
  const n = top.atoms.length;

  test('accept groups that cover the system once, names in any case', () => {
    const r = checkGroupCoverage(groups, 'protein NON-PROTEIN', n);
    expect(r.ok).toBe(true);
    expect(r.found.map(f => f.index)).toEqual([1, 11]);
  });

  test('reject overlaps, gaps and unknown names', () => {
    const overlap = checkGroupCoverage(groups, ['Protein', 'System'], n);
    expect(overlap.ok).toBe(false);
    expect(overlap.errors[0]).toMatch(/^Atom 1 is in two tc-grps groups \(1 and 2\), and 197 more/);
    const gap = checkGroupCoverage(groups, 'Protein Water', n);
    expect(gap.uncovered).toBe(20);
    expect(gap.errors[0]).toMatch(/20 atoms are not part of any of the tc-grps groups/);
    expect(checkGroupCoverage(groups, 'Protein Solvent', n).missing).toEqual(['Solvent']);
    const repeated = checkGroupCoverage([{ name: 'A', atoms: [1, 1, 2] }], 'A', 2);
    expect(repeated.overlaps).toBe(1);
  });

  test('let energy groups leave a rest and comm-grps a part', () => {
    expect(checkGroupCoverage(groups, 'Protein', n, { coverage: 'rest', option: 'energygrps' }).notes[0])
      .toMatch(/rest group/);
    const partial = checkGroupCoverage(groups, 'Protein', n, { coverage: 'partial', option: 'comm-grps' });
    expect(partial.ok).toBe(true);
    expect(partial.notes).toHaveLength(1);
  });

  test('check a whole .mdp', () => {
    const r = checkMdpGroups(groups, {
      tc_grps: 'Protein_LIG Water_and_ions ; coupling',
      'energygrps': 'Protein LIG',
      pull_group1_name: 'LIG',
      'pull-group2-name': 'Pocket',
      'comm-grps': '',
      nsteps: '1000'
    }, n);
    expect(r.ok).toBe(false);
    expect(r.options.map(o => [o.option, o.ok])).toEqual([
      ['tc-grps', false], ['energygrps', true], ['pull-group1-name', true], ['pull-group2-name', false]]);
    const withComplex = [...groups, orGroups(group(groups, 'Protein'), group(groups, 'LIG'))];
    expect(checkMdpGroups(withComplex, { 'tc-grps': 'Protein_LIG Water_and_ions' }, n).ok).toBe(true);
  });
});

describe('describeGroups', () => {
  const top = structureOf('complex.gro');

  test('count atoms, residues and residue names', () => {
    const d = describeGroups(defaultGroups(top), top);
    expect(d.natoms).toBe(308);
    const protein = d.groups[1];
    expect([protein.name, protein.atoms, protein.residues, protein.first, protein.last])
      .toEqual(['Protein', 198, 12, 1, 198]);
    expect(protein.residueNames[0]).toEqual({ name: 'MET', residues: 2, atoms: 36 });
    expect(d.groups.find(g => g.name === 'Water_and_ions').residueNames.map(r => r.name))
      .toEqual(['SOL', 'NA', 'CL']);
    expect(d.warnings).toEqual([]);
  });

  test('warn about what grompp would trip on', () => {
    const d = describeGroups([
      { name: 'Empty', atoms: [] },
      { name: 'Far', atoms: [1, 400] },
      { name: 'Twice', atoms: [2, 2] },
      { name: 'far', atoms: [3] },
      { name: 'two words', atoms: [4] }
    ], top, { tcGrps: 'Empty Twice' });
    const messages = d.warnings.map(w => `${w.level}: ${w.message}`);
    expect(messages).toEqual([
      'warning: Empty is empty.',
      'error: Far has 1 atom numbers outside 1-308; grompp stops on these.',
      'warning: Twice lists 1 atoms more than once.',
      'warning: far repeats the name of group 1 (ignoring case); grompp uses the first.',
      'warning: "two words" is not a usable group name; it will be written as two_words.',
      'error: Atom 2 is in two tc-grps groups (2 and 2); grompp stops on this.',
      'error: 307 atoms are not part of any of the tc-grps groups; grompp stops on this.'
    ]);
    expect(d.tcGrps.ok).toBe(false);
  });
});
