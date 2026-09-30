/*
 * A large system built in code, so a test can check atom numbering past
 * 99 999 (where .gro atom and residue numbers wrap round) without keeping a
 * 14 MB structure in the repository. The expected groups are counts and
 * SHA-256 digests of what `gmx make_ndx` 2025 wrote for this exact text.
 */

const f3 = v => v.toFixed(3).padStart(8);

function line(resnr, resname, atomname, atomnr, x, y, z) {
  return `${String(resnr % 100000).padStart(5)}${resname.padEnd(5)}${atomname.padStart(5)}` +
    `${String(atomnr % 100000).padStart(5)}${f3(x)}${f3(y)}${f3(z)}`;
}

const PEPTIDE = [
  ['ALA', ['N', 'H', 'CA', 'HA', 'CB', 'HB1', 'HB2', 'HB3', 'C', 'O']],
  ['GLY', ['N', 'H', 'CA', 'HA1', 'HA2', 'C', 'O']],
  ['SER', ['N', 'H', 'CA', 'HA', 'CB', 'HB1', 'HB2', 'OG', 'HG', 'C', 'O', 'OXT']]
];

/**
 * Four hundred tripeptides, a ligand, 101 000 waters and 40 ions:
 * 314 648 atoms and 102 241 residues.
 *
 * @returns {string} The .gro text.
 */
export function largeSystemGro() {
  const rows = [];
  let resnr = 0;
  let atomnr = 0;
  const L = 16;
  const add = (resname, names) => {
    resnr += 1;
    for (const name of names) {
      atomnr += 1;
      const k = atomnr * 7919;
      rows.push(line(resnr, resname, name, atomnr,
        (k % 1597) / 1597 * L, (k % 1601) / 1601 * L, (k % 1607) / 1607 * L));
    }
  };
  for (let i = 0; i < 400; i++) for (const [res, names] of PEPTIDE) add(res, names);
  add('LIG', ['C1', 'C2', 'C3', 'N1', 'O1', 'H1', 'H2', 'H3']);
  for (let i = 0; i < 101000; i++) add('SOL', ['OW', 'HW1', 'HW2']);
  for (let i = 0; i < 20; i++) add('NA', ['NA']);
  for (let i = 0; i < 20; i++) add('CL', ['CL']);
  return `Large test system\n${String(atomnr).padStart(5)}\n${rows.join('\n')}\n` +
    `${f3(L).padStart(10)}${f3(L).padStart(10)}${f3(L).padStart(10)}\n`;
}
