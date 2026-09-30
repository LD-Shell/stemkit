/*
 * A small solvated system in a rhombic dodecahedron (the triclinic box GROMACS
 * users favour), built in code, with the ligand sitting on a corner of the
 * unit cell so that its atoms are wrapped to four sides of the box. Distance
 * selections on it only come out right through the periodic boundary. The
 * expected atoms in periodic-select.json are what `gmx select` 2025 wrote for
 * this exact text; tools/check-gromacs-ndx.mjs rechecks them.
 */

const f3 = v => v.toFixed(3).padStart(8);

function line(resnr, resname, atomname, atomnr, x, y, z) {
  return `${String(resnr % 100000).padStart(5)}${resname.padEnd(5)}${atomname.padStart(5)}` +
    `${String(atomnr % 100000).padStart(5)}${f3(x)}${f3(y)}${f3(z)}`;
}

/** Box edge in nm; the box is the xy-square rhombic dodecahedron of this size. */
export const PERIODIC_EDGE = 3;

/**
 * Three alanines and a ligand around the cell corner, two ions near faces
 * and 640 waters on a jittered lattice: 1945 atoms.
 *
 * @returns {string} The .gro text.
 */
export function periodicSystemGro() {
  const L = PERIODIC_EDGE;
  const box = [[L, 0, 0], [0, L, 0], [L / 2, L / 2, L * Math.SQRT1_2]];
  // Fractional coordinates, wrapped into the cell, to Cartesian.
  const cart = (u, v, w) => {
    const f = [u, v, w].map(t => t - Math.floor(t));
    return [0, 1, 2].map(d => f[0] * box[0][d] + f[1] * box[1][d] + f[2] * box[2][d]);
  };
  // Cartesian offset from the origin, wrapped into the cell.
  const inv = (x, y, z) => {
    const w = z / box[2][2];
    const v = (y - w * box[2][1]) / L;
    const u = (x - w * box[2][0]) / L;
    return cart(u, v, w);
  };
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

  const rows = [];
  let resnr = 0;
  let atomnr = 0;
  const add = (resname, atoms) => {
    resnr += 1;
    for (const [name, [x, y, z]] of atoms) {
      atomnr += 1;
      rows.push(line(resnr, resname, name, atomnr, x, y, z));
    }
  };
  // A peptide reaching from the corner into the cell, then the ligand on the
  // corner itself: offsets on both sides of zero wrap to opposite faces.
  const ala = ['N', 'CA', 'CB', 'C', 'O'];
  for (let r = 0; r < 3; r++) {
    add('ALA', ala.map((n, k) => [n, inv(0.25 + 0.3 * r + 0.06 * k, 0.2 - 0.05 * k, 0.15 + 0.1 * r)]));
  }
  const lig = [['C1', -0.12, -0.05, -0.08], ['C2', -0.02, 0.1, -0.1], ['C3', 0.1, 0.02, -0.05],
    ['N1', 0.12, -0.1, 0.06], ['O1', -0.08, 0.12, 0.1], ['O2', 0.02, -0.12, 0.12],
    ['H1', -0.2, 0.02, 0.02], ['H2', 0.05, 0.05, 0.2]];
  add('LIG', lig.map(([n, x, y, z]) => [n, inv(x, y, z)]));
  add('NA', [['NA', cart(0.5, 0.02, 0.5)]]);
  add('CL', [['CL', cart(0.97, 0.5, 0.5)]]);
  // 640 waters: an 8 x 8 x 10 lattice in fractional coordinates, jittered.
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      for (let k = 0; k < 10; k++) {
        const u = (i + 0.2 + 0.6 * rand()) / 8;
        const v = (j + 0.2 + 0.6 * rand()) / 8;
        const w = (k + 0.2 + 0.6 * rand()) / 10;
        const [x, y, z] = cart(u, v, w);
        add('SOL', [['OW', [x, y, z]], ['HW1', [x + 0.08, y + 0.05, z]],
          ['HW2', [x - 0.03, y + 0.09, z + 0.02]]]);
      }
    }
  }
  // The .gro box line: v1(x) v2(y) v3(z) v1(y) v1(z) v2(x) v2(z) v3(x) v3(y).
  const b = box;
  const boxLine = [b[0][0], b[1][1], b[2][2], b[0][1], b[0][2], b[1][0], b[1][2], b[2][0], b[2][1]]
    .map(v => v.toFixed(5).padStart(10)).join('');
  return `Periodic test system\n${String(atomnr).padStart(5)}\n${rows.join('\n')}\n${boxLine}\n`;
}
