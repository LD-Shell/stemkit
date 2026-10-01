# Sample files

Small files the tools can load with one click, bundled so the demonstrations
work offline and without a PDB fetch: the two structures of the Structure
Inspector and the Coordinate Manipulator, the two the MD Workflow Generator's
GROMACS index groups start from, and the PLUMED run its "Analyse a run" tab
opens.

| File | Contents |
|---|---|
| `helix-ala15.pdb` | Fifteen alanine residues built as an ideal alpha-helix (phi -57, psi -47, omega 180) from textbook backbone geometry (Engh and Huber, 1991). |
| `benzene.xyz` | Benzene in idealised D6h geometry: C-C 1.39 A, C-H 1.08 A. |
| `gromacs/complex.gro` | A small peptide with a ligand (`LIG`), water and two sodium ions, 308 atoms: the index groups show a ligand, the complex and its pocket. |
| `gromacs/membrane.gro` | A CHARMM-style patch of POPC and cholesterol with a peptide, TIP3 water and SOD/CLA ions, 249 atoms: the groups show a membrane, and ion and water names GROMACS does not know. |
| `plumed/COLVAR` | The distance `d`, the torsion `t` and the bias (`m3.bias`, `m3.rbias`) of a two-variable well-tempered metadynamics run, 300 frames. |
| `plumed/HILLS` | The 121 hills of that run, on `d` and `t`, bias factor 8. |

The first two are generated from textbook geometry, not experimental data; the
GROMACS ones are the test fixtures of `src/core/gromacs-ndx.js`
(`tests/fixtures/gromacs-ndx/`), built to exercise the index groups, not
equilibrated systems; the PLUMED ones are `COLVAR` and `HILLS_dt` of
`tests/fixtures/plumed/`, written by PLUMED from `plumed driver` on a
four-atom random walk. The B-factors in the helix are a uniform placeholder, and
none of these files should be used as a reference structure for anything but
trying the tools.
