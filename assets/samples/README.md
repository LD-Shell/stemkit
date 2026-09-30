# Sample structures

Small files the tools can load with one click, bundled so the demonstrations
work offline and without a PDB fetch: the 3D Structure Inspector's two, and the
two the MD Workflow Generator's GROMACS index groups start from.

| File | Contents |
|---|---|
| `helix-ala15.pdb` | Fifteen alanine residues built as an ideal alpha-helix (phi -57, psi -47, omega 180) from textbook backbone geometry (Engh and Huber, 1991). |
| `benzene.xyz` | Benzene in idealised D6h geometry: C-C 1.39 A, C-H 1.08 A. |
| `gromacs/complex.gro` | A small peptide with a ligand (`LIG`), water and two sodium ions, 308 atoms: the index groups show a ligand, the complex and its pocket. |
| `gromacs/membrane.gro` | A CHARMM-style patch of POPC and cholesterol with a peptide, TIP3 water and SOD/CLA ions, 249 atoms: the groups show a membrane, and ion and water names GROMACS does not know. |

The first two are generated from textbook geometry, not experimental data; the
GROMACS ones are the test fixtures of `src/core/gromacs-ndx.js`
(`tests/fixtures/gromacs-ndx/`), built to exercise the index groups, not
equilibrated systems. The B-factors in the helix are a uniform placeholder, and
none of these files should be used as a reference structure for anything but
trying the tools.
