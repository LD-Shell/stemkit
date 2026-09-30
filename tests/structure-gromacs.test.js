import { describe, test, expect, afterAll } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parsePDB, parseGRO, formatPDB } from '../src/core/structure.js';
import { selectAtoms } from '../src/core/selection.js';
import { MODELS_PDB, PRECISE_GRO, dodecahedronGro } from './fixtures/structure/systems.mjs';

/*
 * core/structure.js and core/selection.js against GROMACS itself: the
 * structure a PDB or .gro file holds as gmx editconf reads it, and the atoms
 * gmx select finds within a distance through the periodic boundary. GROMACS
 * is taken from GMX_BIN, or gmx / gmx_mpi on the PATH; without it these tests
 * are skipped, and the recorded answers in structure.test.js and
 * selection.test.js still hold the same ground.
 */
const GMX = [process.env.GMX_BIN, 'gmx', 'gmx_mpi']
  .find(g => g && spawnSync(g, ['--version'], { encoding: 'utf8' }).status === 0) || '';
const withGromacs = GMX ? test : test.skip;

const made = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stemkit-structure-gromacs-'));
  made.push(dir);
  return dir;
};
afterAll(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

const gmx = (dir, args) => {
  const r = spawnSync(GMX, args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gmx ${args[0]} failed:\n${r.stderr}`);
  return r;
};

/* The atom records of a .gro file GROMACS wrote, at its %8.3f. */
function groRecords(text) {
  const lines = text.split('\n');
  const n = parseInt(lines[1], 10);
  return lines.slice(2, 2 + n).map(l => ({
    resSeq: parseInt(l.substring(0, 5), 10),
    resName: l.substring(5, 10).trim(),
    atomName: l.substring(10, 15).trim(),
    xyz: [20, 28, 36].map(c => Number(l.substring(c, c + 8)))
  }));
}

/* Our reading in the same shape, coordinates in nm to three decimals. */
function ours(atoms, toNm) {
  return atoms.map(a => ({
    resSeq: a.resSeq,
    resName: a.resName,
    atomName: a.atomName,
    xyz: [a.x, a.y, a.z].map(v => Number((v * toNm).toFixed(3)))
  }));
}

/* Atom numbers in the single group of an index file. */
const ndxAtoms = (text) => text.split('\n').filter(l => !l.startsWith('['))
  .join(' ').trim().split(/\s+/).filter(Boolean).map(Number);

describe('structures are read as gmx editconf reads them', () => {
  withGromacs('a multi-model PDB with four-letter names and residue 0', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'in.pdb'), `${MODELS_PDB}\n`);
    gmx(dir, ['editconf', '-f', 'in.pdb', '-o', 'out.gro']);
    const theirs = groRecords(fs.readFileSync(path.join(dir, 'out.gro'), 'utf8'));
    expect(ours(parsePDB(MODELS_PDB).atoms, 0.1)).toEqual(theirs);
  });

  withGromacs('a .gro file written at higher precision', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'in.gro'), `${PRECISE_GRO}\n`);
    gmx(dir, ['editconf', '-f', 'in.gro', '-o', 'out.gro']);
    const theirs = groRecords(fs.readFileSync(path.join(dir, 'out.gro'), 'utf8'));
    expect(ours(parseGRO(PRECISE_GRO).atoms, 1)).toEqual(theirs);
  });

  withGromacs('a PDB we write is read back by GROMACS as we read it', () => {
    const dir = tmp();
    const r = parsePDB(MODELS_PDB);
    fs.writeFileSync(path.join(dir, 'in.pdb'), `${formatPDB(r.atoms, { box: r.box })}\n`);
    gmx(dir, ['editconf', '-f', 'in.pdb', '-o', 'out.gro']);
    const theirs = groRecords(fs.readFileSync(path.join(dir, 'out.gro'), 'utf8'));
    expect(ours(r.atoms, 0.1)).toEqual(theirs);
  });

  // The PDB's placeholder cell, which GROMACS takes as it stands: the
  // reason parsePDB drops it, and says what GROMACS will do with it.
  withGromacs('a CRYST1 of 1 Å: GROMACS keeps a 0.1 nm box and measures through it; we read no box', () => {
    const dir = tmp();
    const text = ['CRYST1    1.000    1.000    1.000  90.00  90.00  90.00 P 1           1',
      'HETATM    1  OW  SOL A   1       0.500   0.500   0.500  1.00  0.00           O',
      'HETATM    2  OW  SOL A   2      19.500  19.500   0.500  1.00  0.00           O',
      'HETATM    3  OW  SOL A   3      10.000  10.000  10.000  1.00  0.00           O',
      'HETATM    4  C1  LIG A   4       0.200   0.200   0.200  1.00  0.00           C', 'END', ''].join('\n');
    fs.writeFileSync(path.join(dir, 'in.pdb'), text);
    gmx(dir, ['editconf', '-f', 'in.pdb', '-o', 'out.gro']);
    expect(fs.readFileSync(path.join(dir, 'out.gro'), 'utf8').trim().split('\n').pop().trim().split(/\s+/).map(Number)).toEqual([0.1, 0.1, 0.1]);
    gmx(dir, ['select', '-s', 'in.pdb', '-select', 'within 0.3 of resname LIG', '-on', 'sel.ndx']);
    expect(ndxAtoms(fs.readFileSync(path.join(dir, 'sel.ndx'), 'utf8'))).toEqual([1, 2, 3, 4]);
    const r = parsePDB(text);
    expect(r.box).toBeNull();
    expect(r.warnings.join(' ')).toMatch(/0\.1 nm wide/);
    const mine = selectAtoms(r.atoms, 'within:0.3,resn:LIG', { unit: 'nm', coordinateUnit: 'A', box: r.box }).atoms.map(a => a.serial);
    expect(mine).toEqual([1, 4]);
    // What gmx select gives with the periodic boundary off.
    gmx(dir, ['select', '-s', 'in.pdb', '-pbc', 'no', '-select', 'within 0.3 of resname LIG', '-on', 'nopbc.ndx']);
    expect(ndxAtoms(fs.readFileSync(path.join(dir, 'nopbc.ndx'), 'utf8'))).toEqual(mine);
  });
});

describe('within: agrees with gmx select through the periodic boundary', () => {
  // Below half the 3 nm box, where one image suffices, and above it.
  withGromacs.each(['0.5', '1.2', '1.7'])('within %s nm of the ligand, rhombic dodecahedron', (r) => {
    const dir = tmp();
    const text = dodecahedronGro();
    fs.writeFileSync(path.join(dir, 'box.gro'), `${text}\n`);
    gmx(dir, ['select', '-s', 'box.gro', '-select', `within ${r} of resname LIG`, '-on', 'sel.ndx']);
    const theirs = ndxAtoms(fs.readFileSync(path.join(dir, 'sel.ndx'), 'utf8'));
    const g = parseGRO(text);
    const mine = selectAtoms(g.atoms, `within:${r},resn:LIG`,
      { unit: 'nm', coordinateUnit: 'nm', box: g.box, boxVectors: g.boxVectors }).atoms.map(a => a.serial);
    expect(mine).toEqual(theirs);
  });
});
