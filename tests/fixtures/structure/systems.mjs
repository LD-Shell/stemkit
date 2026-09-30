/*
 * Structures read as GROMACS 2025 reads them, shared by tests/structure.test.js,
 * tests/selection.test.js and tests/structure-gromacs.test.js, which runs
 * gmx editconf and gmx select on the same text when GROMACS is installed.
 */

import { formatGRO } from '../../../src/core/structure.js';

/** Two models of a membrane fragment: four-letter names, residue 0 and 9999. */
export const MODELS_PDB = `CRYST1   30.000   30.000   30.000  90.00  90.00  90.00 P 1           1
MODEL        1
ATOM      1  P   POPC    0       1.000   2.000   3.000  1.00  0.00           P
ATOM      2  N   POPC    0       2.000   2.000   3.000  1.00  0.00           N
HETATM    3  OW  TIP3    1       5.000   5.000   5.000  1.00  0.00           O
HETATM    4  OW  TIP3 9999       6.000   5.000   5.000  1.00  0.00           O
ENDMDL
MODEL        2
ATOM      1  P   POPC    0       1.100   2.000   3.000  1.00  0.00           P
ATOM      2  N   POPC    0       2.100   2.000   3.000  1.00  0.00           N
HETATM    3  OW  TIP3    1       5.100   5.000   5.000  1.00  0.00           O
HETATM    4  OW  TIP3 9999       6.100   5.000   5.000  1.00  0.00           O
ENDMDL
END`;

/** Written at %10.5f, which groio.cpp reads by the spacing of the points. */
export const PRECISE_GRO = `variable precision
    3
    0SOL     OW    1   1.12345   2.23456   3.34567   0.12345  -0.23456   0.34567
    0SOL    HW1    2  11.00001  -2.00002  13.00003   1.00000   2.00000   3.00000
    1SOL    HW2    3   0.90000   2.00000   3.00000   0.00000  -0.10000   0.00000
   5.00000   6.00000   7.00000`;

/*
 * A small system in a rhombic dodecahedron, the triclinic box GROMACS users
 * favour, built in code so that the text is the same on every run. A ligand
 * sits on a corner of the cell, so its two atoms are at opposite ends of the
 * box, and one water in five is written a box vector out of the cell, as a
 * molecule made whole would be. Which waters are near the ligand therefore
 * only comes out right through the periodic boundary.
 *
 * tests/selection.test.js holds what `gmx select` 2025 selected on this text;
 * tests/structure-gromacs.test.js reruns gmx select when GROMACS is installed.
 */

/** Box rows of the dodecahedron, edge 3 nm, square in xy. */
export const DODECAHEDRON = [[3, 0, 0], [0, 3, 0], [1.5, 1.5, 3 * Math.SQRT1_2]];

/**
 * The system as .gro text: 2 ligand atoms and 40 waters.
 *
 * @returns {string}
 */
export function dodecahedronGro() {
  let seed = 2025;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const B = DODECAHEDRON;
  const at = (u, v, w) => [0, 1, 2].map(d => u * B[0][d] + v * B[1][d] + w * B[2][d]);
  const atoms = [];
  const add = (resSeq, resName, atomName, [x, y, z]) =>
    atoms.push({ resSeq, resName, atomName, serial: atoms.length + 1, x, y, z });

  add(1, 'LIG', 'C1', [0.05, 0.05, 0.05]);
  add(1, 'LIG', 'C2', at(0.98, 0.99, 0.02));
  for (let r = 0; r < 40; r++) {
    const out = rnd() < 0.2 ? 1 : 0;
    add(r + 2, 'SOL', 'OW', at(rnd() + out, rnd(), rnd() - out));
  }
  const boxVectors = [B[0][0], B[1][1], B[2][2], B[0][1], B[0][2], B[1][0], B[1][2], B[2][0], B[2][1]];
  return formatGRO(atoms, { title: 'dodecahedron', box: boxVectors.slice(0, 3), boxVectors });
}
