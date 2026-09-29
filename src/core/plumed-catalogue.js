/**
 * @module core/plumed-catalogue
 *
 * The curated part of the PLUMED builder: which actions it offers, the fields
 * each one shows, sensible starting values in nm and kJ/mol, and the notes
 * that the keyword tables cannot supply.
 *
 * Keyword names, defaults and modules are checked against the tables in
 * `plumed-syntax/` by tests/plumed-catalogue.test.js, for every release the
 * builder targets, so an entry cannot drift from what PLUMED parses.
 *
 * Field types: `atoms` (an atom list), `text`, `num`, `select`, `flag`.
 * A field may carry `since` or `until` (a release) when the keyword exists
 * only in part of the supported range.
 *
 * An entry says which values it outputs: `components` lists the ones always
 * there, `componentsWhen` the ones a flag adds, and `compStyle` marks a
 * multicolvar, whose components follow from the reductions switched on. With
 * none of these the label itself is the value.
 */

/** Groups the builder files collective variables under. */
export const CV_CATEGORIES = {
  'geometry':    'Distances & geometry',
  'angles':      'Angles & torsions',
  'contacts':    'Coordination & contacts',
  'shape':       'Shape & gyration',
  'rmsd':        'RMSD & path',
  'position':    'Position & cell',
  'nucleic':     'Nucleic-acid / sugar',
  'order':       'Structure / order parameters',
  'energy':      'Energy & electrostatics',
  'custom':      'Custom (raw PLUMED line)'
};

/** Short help for keywords, shown where a field has none of its own. */
export const KEY_HELP = {
  ATOMS: 'The atoms (or centres) this CV acts on. Accepts indices (1,2), ranges (1-100), strides (1-100:2), group labels, or @-selections when MOLINFO is set.',
  ATOM: 'The single atom (or centre) for this CV.',
  GROUP: 'Atom group for this CV. Accepts indices, ranges, group labels, or an NDX group (set NDX_FILE/NDX_GROUP).',
  GROUPA: 'First atom group. Accepts indices, ranges, labels, or an NDX group.',
  GROUPB: 'Second atom group. If empty, all pairs within GROUPA are used.',
  R_0: 'The r_0 parameter of the switching function (nm): the distance at which the switch is ~0.5.',
  NN: 'Exponent n of the rational switching function (default 6).',
  MM: 'Exponent m of the rational switching function (0 means 2*NN).',
  D_0: 'The d_0 offset of the switching function (nm).',
  SWITCH: 'Full switching-function definition, e.g. {RATIONAL R_0=0.3 NN=6 MM=12}. Overrides R_0/NN/MM.',
  SPECIES: 'The atoms whose local order parameter is computed (each atom is compared with its neighbours).',
  D_MAX: 'Distance beyond which the switching function is exactly zero. Setting it lets PLUMED use linked cells for neighbour search, a large speedup. Choose it a little above where the switch has decayed to ~0.',
  MEAN: 'Output the mean of the per-atom values as a single scalar CV.',
  VMEAN: 'Output the norm of the mean per-atom vector.',
  __raw: 'Everything after the label. Write any valid PLUMED action, e.g. COORDINATION GROUPA=1-10 GROUPB=20-40 R_0=0.3.',
  NLIST: 'Use a neighbour list to speed up the calculation. Requires NL_CUTOFF and NL_STRIDE.',
  NL_CUTOFF: 'Neighbour-list cutoff (nm). Must be larger than the switching range.',
  NL_STRIDE: 'How often (in steps) the neighbour list is rebuilt.',
  COMPONENTS: 'Also output the x, y and z components separately (label.x, label.y, label.z).',
  NOPBC: 'Ignore periodic boundary conditions when computing this CV.',
  TYPE: 'Which quantity to compute (e.g. RADIUS of gyration, or a shape descriptor).',
  MASS_WEIGHTED: 'Weight atoms by mass (uses the centre of mass).',
  REFERENCE: 'A PDB file with the reference structure/atoms for this CV.',
  LAMBDA: 'Smoothing parameter for path CVs; roughly 2.3/(RMSD between adjacent frames).',
  SQUARED: 'Return the mean-squared displacement instead of the RMSD.',
  AT: 'The reference (centre) value(s) the restraint/wall is applied at.',
  KAPPA: 'Force constant(s) of the restraint/wall (energy per CV-unit^2).',
  SLOPE: 'Adds a linear term to the restraint (energy per CV-unit).',
  EXP: 'Exponent of the wall potential (default 2 = harmonic).',
  EPS: 'Rescaling factor inside the wall potential (default 1).',
  OFFSET: 'Offset added to the wall position.',
  I: 'Ionic strength (mol/L) for the Debye-Hückel screening.',
  TEMP: 'System temperature (K). Needed for well-tempered methods and reweighting.',
  LOWER_CUTOFF: 'Ignore reference distances below this value (nm).',
  UPPER_CUTOFF: 'Ignore reference distances above this value (nm).',
  AXIS_ATOMS: 'Two atoms that define the direction of the axis of interest.',
  AVERAGE: 'A PDB file containing the reference average structure.',
  EIGENVECTORS: 'A PDB file containing the eigenvectors.',
  SQUARED_ROOT: 'Set to output the RMSD instead of mean squared displacement.',
  PROPERTY: 'The property string mapped in the REMARK field of the reference PDB.',
  NEIGH_SIZE: 'Size of the neighbor list for PATH computations.',
  Q: 'The exponent of the dimer potential.',
  DSIGMA: 'The interaction strength of the dimer bond.',
  ALLATOMS: 'Use every atom of the system (overrides ATOMS1/ATOMS2).',
  NOVSITES: 'Flag indicating configuration has no virtual sites at centroid positions.',
  // --- Advanced order-parameter / multicolvar keywords ---
  SPECIESA: 'First set of atoms (the ones whose order parameter is computed). Use with SPECIESB for a two-group variant.',
  SPECIESB: 'Second set of atoms that can sit in the first coordination sphere of the SPECIESA atoms.',
  CUTOFF: 'Distance cutoff (nm) that defines the first coordination sphere used by the tetrahedrality descriptors.',
  MORE_THAN: 'Reduce the per-atom vector to a scalar count of how many values exceed a threshold, via a rational switching function, e.g. {RATIONAL R_0=0.5}. Faster than storing the whole distribution when you only need a count.',
  LESS_THAN: 'Reduce the per-atom vector to a scalar count of how many values fall below a threshold, via a rational switching function, e.g. {RATIONAL R_0=0.5}.',
  LOWMEM: 'Lower the memory footprint of the multicolvar at some CPU cost. PLUMED 2.9 only: from 2.10 the flag is accepted and does nothing.',
  R_POWER: 'Multiply the coordination-number function by the pairwise distance raised to this power (indirectly biases the radial distribution). Used by COORDINATION_MOMENTS.',
  MOMENTS: 'Which moments of the distance distribution in the first coordination sphere to evaluate, e.g. 2-4.',
  ALPHA: 'The alpha parameter of the angular part of the FCCUBIC symmetry function; PLUMED uses 3.0 when it is left out.',
  KERNEL1: 'First angular kernel for SMAC, e.g. {GAUSSIAN CENTER=0 SIGMA=0.480}. Set so it is 1 for the solid-like relative orientation.',
  KERNEL2: 'Second angular kernel for SMAC, e.g. {GAUSSIAN CENTER=pi SIGMA=0.7}.',
  SWITCH_COORD: 'Switching function on the coordination count that weights how many neighbours a molecule must have to be counted as ordered, e.g. {RATIONAL R_0=0.001}.',
  PHI: 'Euler angle (rad) that rotates the bond vectors into a reference frame before the tetrahedrality is computed.',
  THETA: 'Euler angle (rad) applied after PHI to rotate the bond vectors into the reference frame.',
  PSI: 'Third Euler angle (rad) completing the rotation of the bond vectors into the reference frame.',
  VSUM: 'Output the sum of the per-atom vectors (rather than the mean).',
  SUM: 'Output the sum of the values, a single scalar.',
  CMDIST: 'Output the distance from a reference contact map, given with numbered REFERENCE keywords.',
  C: 'The constant C of the GHBFIX switching function.',
  TYPES: 'File with the interaction type of each atom.',
  PARAMS: 'File with the scaling parameter for each pair of types.',
  ENERGY_UNITS: 'Units of the energies in the PARAMS file.',
  NL_BUFFER: 'Buffer (nm) added to the intrinsic cutoff when the neighbour list is built.',
  ATOMS1: 'Atoms that are the first bead of each dimer.',
  ATOMS2: 'Atoms that are the second bead of each dimer, in the same order.',
  NEIGH_STRIDE: 'How often the neighbour list of reference frames is rebuilt.',
  GROUPC: 'A third group, used with GROUPA and GROUPB: angles are then taken between a bond to GROUPB and a bond to GROUPC.',
  NAME: 'Name of the variable as the MD engine computes it.'
};

/** Input-level prerequisites a CV can declare with `prereq`. */
export const PREREQS = {
  wholemolecules: {
    label: 'WHOLEMOLECULES',
    note: 'requires a WHOLEMOLECULES line (before this CV) so PLUMED reconstructs whole chains across periodic boundaries, otherwise the CV is wrong for codes like GROMACS. Not needed if you use TYPE=DRMSD.'
  }
};

/** Ways a multicolvar reduces its per-atom values to a scalar. */
export const REDUCTIONS = [
  { k: 'MEAN',      comp: 'mean',     type: 'flag', def: false, help: 'Output the mean of the per-atom values as a single scalar CV.' },
  { k: 'SUM',       comp: 'sum',      type: 'flag', def: false, help: 'Output the sum of all the per-atom values.' },
  { k: 'MIN',       comp: 'min',      type: 'text', def: '', help: 'Continuous minimum, e.g. {BETA=0.1}. Larger BETA -> closer to the true minimum.' },
  { k: 'ALT_MIN',   comp: 'altmin',   type: 'text', def: '', help: 'Continuous minimum via the alternative exp(-beta*s) formula, e.g. {BETA=0.1}.' },
  { k: 'MAX',       comp: 'max',      type: 'text', def: '', help: 'Continuous maximum, e.g. {BETA=0.1}.' },
  { k: 'HIGHEST',   comp: 'highest',  type: 'flag', def: false, help: 'Recover the single largest of the per-atom values.' },
  { k: 'LOWEST',    comp: 'lowest',   type: 'flag', def: false, help: 'Recover the single smallest of the per-atom values.' },
  { k: 'MORE_THAN', comp: 'morethan', type: 'text', def: '', help: 'Count of values above a threshold via a switching function, e.g. {RATIONAL R_0=0.5}.' },
  { k: 'LESS_THAN', comp: 'lessthan', type: 'text', def: '', help: 'Count of values below a threshold via a switching function, e.g. {RATIONAL R_0=0.5}.' },
  { k: 'BETWEEN',   comp: 'between',  type: 'text', def: '', help: 'Count of values within a range via a kernel, e.g. {GAUSSIAN LOWER=0 UPPER=1 SMEAR=0.1}.' }
];

/** The collective variables the builder offers. */
export const CV_DEFS = {
  GROUP: {
    cat: 'position', desc: 'Define a named atom group you can reuse in other CVs (by index list, an .ndx group, or another group).',
    isGroup: true,
    fields: [
      { k: 'ATOMS', label: 'ATOMS (list/range)', type: 'atoms', def: '', help: 'Atoms in the group (indices/ranges, e.g. 1-90:3). Leave blank if you are loading from an index file instead.' },
      { k: 'NDX_FILE', label: 'NDX_FILE', type: 'text', def: '', help: 'GROMACS-style index file to read the group from, e.g. atoms.ndx.' },
      { k: 'NDX_GROUP', label: 'NDX_GROUP', type: 'text', def: '', help: 'Name of the group inside NDX_FILE, e.g. OW, Protein or a custom group name. The first group is used if left blank.' },
      { k: 'REMOVE', label: 'REMOVE (opt.)', type: 'text', def: '', help: 'Remove these atoms/labels from the list, e.g. REMOVE=ox to get hydrogens after taking oxygens.' },
      { k: 'SORT', label: 'SORT', type: 'flag', def: false, help: 'Sort the resulting list by increasing serial number.' },
      { k: 'UNIQUE', label: 'UNIQUE', type: 'flag', def: false, help: 'Sort and remove duplicate atoms from the list.' }
    ]
  },
  COM: {
    cat: 'position', desc: 'Centre of mass of a group of atoms; use its label anywhere an atom is expected.',
    isGroup: true,
    fields: [
      { k: 'ATOMS', label: 'ATOMS', type: 'atoms', def: '1-100', required: true }
    ]
  },
  CENTER: {
    cat: 'position', desc: 'Geometric centre of a group of atoms, or a weighted one; use its label anywhere an atom is expected.',
    isGroup: true,
    fields: [
      { k: 'ATOMS', label: 'ATOMS', type: 'atoms', def: '1-100', required: true },
      { k: 'MASS', label: 'MASS (centre of mass)', type: 'flag', def: false, help: 'Weight the atoms by mass, which makes this the centre of mass.' },
      { k: 'NOPBC', label: 'NOPBC', type: 'flag', def: false }
    ]
  },
  DISTANCE: {
    cat: 'geometry', desc: 'Distance between a pair of atoms (or two centres).',
    componentsWhen: { COMPONENTS: ['x', 'y', 'z'] },
    fields: [
      { k: 'ATOMS', label: 'ATOMS (pair)', type: 'atoms', def: '1,2', required: true },
      { k: 'COMPONENTS', label: 'COMPONENTS (x,y,z)', type: 'flag', def: false },
      { k: 'NOPBC', label: 'NOPBC', type: 'flag', def: false }
    ]
  },
  ANGLE: {
    cat: 'angles', desc: 'Angle between three atoms (or between two vectors of four atoms).',
    fields: [
      { k: 'ATOMS', label: 'ATOMS (3 or 4)', type: 'atoms', def: '1,2,3', required: true },
      { k: 'NOPBC', label: 'NOPBC', type: 'flag', def: false }
    ]
  },
  TORSION: {
    cat: 'angles', desc: 'Dihedral (torsional) angle between four atoms.',
    fields: [
      { k: 'ATOMS', label: 'ATOMS (4)', type: 'atoms', def: '1,2,3,4', required: true },
      { k: 'NOPBC', label: 'NOPBC', type: 'flag', def: false }
    ]
  },
  DIHEDRAL_CORRELATION: {
    cat: 'angles', minVersion: '2.11', desc: 'Measure the correlation between a pair of dihedral angles (phi and psi).',
    fields: [
      { k: 'ATOMS', label: 'ATOMS (8 atoms)', type: 'atoms', def: '1,2,3,4,5,6,7,8', required: true },
      { k: 'NOPBC', label: 'NOPBC', type: 'flag', def: false }
    ]
  },
  COORDINATION: {
    cat: 'contacts', desc: 'Coordination number between two groups via a switching function.',
    coordSwitch: true,
    fields: [
      { k: 'GROUPA', label: 'GROUPA', type: 'atoms', def: '1-10', required: true },
      { k: 'GROUPB', label: 'GROUPB', type: 'atoms', def: '11-20' },
      { k: 'R_0', label: 'R_0 (nm)', type: 'num', def: '0.3', required: true },
      { k: 'D_0', label: 'D_0 (nm)', type: 'num', def: '0.0' },
      { k: 'NN', label: 'NN', type: 'num', def: '6' },
      { k: 'MM', label: 'MM (0 = 2*NN)', type: 'num', def: '0' },
      { k: 'D_MAX', label: 'D_MAX (nm)', type: 'num', def: '', help: 'Distance beyond which the switch is exactly zero. Setting it makes PLUMED use fast linked cells, an alternative to a neighbour list. Leave blank if you use NLIST instead.' },
      { k: 'NLIST', label: 'NLIST (neighbour list)', type: 'flag', def: false },
      { k: 'NL_CUTOFF', label: 'NL_CUTOFF (nm)', type: 'num', def: '' },
      { k: 'NL_STRIDE', label: 'NL_STRIDE (steps)', type: 'num', def: '' }
    ]
  },
  CONTACTMAP: {
    cat: 'contacts', desc: 'Distances for many atom pairs, each through a switching function.',
    components: 'contactmap',
    fields: [
      { k: 'ATOMS', label: 'ATOMS/SWITCH (numbered)', type: 'text', def: 'ATOMS1=1,2 SWITCH1={RATIONAL R_0=0.3}', required: true },
      { k: 'SUM', label: 'SUM', type: 'flag', def: false },
      { k: 'CMDIST', label: 'CMDIST (vs reference)', type: 'flag', def: false }
    ]
  },
  GYRATION: {
    cat: 'shape', desc: 'Radius of gyration (or related shape descriptor) of a group.',
    fields: [
      { k: 'ATOMS', label: 'ATOMS', type: 'atoms', def: '1-100', required: true },
      { k: 'TYPE', label: 'TYPE', type: 'select', def: 'RADIUS',
       options: ['RADIUS','TRACE','GTPC_1','GTPC_2','GTPC_3','ASPHERICITY','ACYLINDRICITY','KAPPA2'] },
      { k: 'MASS_WEIGHTED', label: 'MASS_WEIGHTED', type: 'flag', def: false }
    ]
  },
  DIPOLE: {
    cat: 'energy', desc: 'Dipole moment of a group of atoms.',
    componentsWhen: { COMPONENTS: ['x', 'y', 'z'] },
    fields: [
      { k: 'GROUP', label: 'GROUP', type: 'atoms', def: '1-50', required: true },
      { k: 'COMPONENTS', label: 'COMPONENTS', type: 'flag', def: false }
    ]
  },
  ENERGY: {
    cat: 'energy', desc: 'Total potential energy of the simulation box (needs engine support).',
    fields: []
  },
  DHENERGY: {
    cat: 'energy', desc: 'Debye-Hückel interaction energy between GROUPA and GROUPB.',
    fields: [
      { k: 'GROUPA', label: 'GROUPA', type: 'atoms', def: '1-10', required: true },
      { k: 'GROUPB', label: 'GROUPB', type: 'atoms', def: '11-20', required: true },
      { k: 'I', label: 'I (ionic strength, M)', type: 'num', def: '0.1', help: 'Ionic strength in mol/L. PLUMED assumes 1.0 when it is left out; 0.1 to 0.15 is the physiological range.' },
      { k: 'TEMP', label: 'TEMP (K)', type: 'num', def: '300' }
    ]
  },
  GHBFIX: {
    cat: 'energy', desc: 'Calculate the GHBFIX interaction energy between GROUPA and GROUPB.',
    fields: [
      { k: 'GROUPA', label: 'GROUPA', type: 'atoms', def: '1-10', required: true },
      { k: 'GROUPB', label: 'GROUPB', type: 'atoms', def: '11-20', required: true },
      { k: 'D_0', label: 'D_0 (nm)', type: 'num', def: '0.2', required: true },
      { k: 'D_MAX', label: 'D_MAX (nm)', type: 'num', def: '0.3', required: true },
      { k: 'C', label: 'C', type: 'num', def: '0.8', required: true },
      { k: 'TYPES', label: 'TYPES (.dat)', type: 'text', def: 'typesTable.dat', required: true },
      { k: 'PARAMS', label: 'PARAMS (.dat)', type: 'text', def: 'scalingParameters.dat', required: true },
      { k: 'ENERGY_UNITS', label: 'ENERGY_UNITS', type: 'text', def: 'kj/mol' }
    ]
  },
  EEFSOLV: {
    cat: 'energy', desc: 'Calculates EEF1 solvation free energy for a group of non-hydrogen atoms. Needs MOLINFO.',
    needsMolinfo: true,
    fields: [
      { k: 'ATOMS', label: 'ATOMS (Non-H)', type: 'atoms', def: '1-100', required: true },
      { k: 'NL_BUFFER', label: 'NL_BUFFER (nm)', type: 'num', def: '0.1' },
      { k: 'NL_STRIDE', label: 'NL_STRIDE', type: 'num', def: '40' }
    ]
  },
  DIMER: {
    cat: 'energy', desc: 'Computes the dimer interaction energy for a collection of dimers (e.g. for Replica Exchange).',
    fields: [
      { k: 'TEMP', label: 'TEMP (K)', type: 'num', def: '300', required: true },
      { k: 'Q', label: 'Q (exponent)', type: 'num', def: '0.5', required: true },
      { k: 'DSIGMA', label: 'DSIGMA', type: 'text', def: '0.002', required: true },
      { k: 'ATOMS1', label: 'ATOMS1', type: 'atoms', def: '1,5,7' },
      { k: 'ATOMS2', label: 'ATOMS2', type: 'atoms', def: '23,27,29' },
      { k: 'ALLATOMS', label: 'ALLATOMS', type: 'flag', def: false, help: 'Overrides ATOMS1/ATOMS2 to use every atom.' },
      { k: 'NOVSITES', label: 'NOVSITES', type: 'flag', def: false, help: 'Flag indicating no virtual sites at centroid positions.' }
    ]
  },
  POSITION: {
    cat: 'position', desc: 'Position (x,y,z) of an atom or centre.',
    components: ['x', 'y', 'z'],
    fields: [
      { k: 'ATOM', label: 'ATOM', type: 'atoms', def: '1', required: true },
      { k: 'NOPBC', label: 'NOPBC', type: 'flag', def: false }
    ]
  },
  PROJECTION_ON_AXIS: {
    cat: 'position', desc: 'Calculate a position based on the projection along and extension from a defined axis.',
    components: ['proj', 'ext'],
    fields: [
      { k: 'AXIS_ATOMS', label: 'AXIS_ATOMS (2)', type: 'atoms', def: '1,2', required: true },
      { k: 'ATOM', label: 'ATOM (1)', type: 'atoms', def: '3', required: true },
      { k: 'NOPBC', label: 'NOPBC', type: 'flag', def: false }
    ]
  },
  PLANE: {
    cat: 'position', minVersion: '2.10', components: ['x', 'y', 'z'], desc: 'Calculate the plane perpendicular to two vectors representing planar orientation.',
    fields: [
      { k: 'ATOMS', label: 'ATOMS (3 or 4)', type: 'atoms', def: '1,2,3', required: true },
      { k: 'NOPBC', label: 'NOPBC', type: 'flag', def: false }
    ]
  },
  CELL: {
    cat: 'position', desc: 'Components of the simulation cell.',
    components: ['ax', 'ay', 'az', 'bx', 'by', 'bz', 'cx', 'cy', 'cz'],
    fields: []
  },
  VOLUME: {
    cat: 'position', desc: 'Volume of the simulation box.',
    fields: []
  },
  RMSD: {
    cat: 'rmsd', desc: 'RMSD from a reference structure (SIMPLE or OPTIMAL alignment).',
    fields: [
      { k: 'REFERENCE', label: 'REFERENCE (.pdb)', type: 'text', def: 'ref.pdb', required: true },
      { k: 'TYPE', label: 'TYPE', type: 'select', def: 'OPTIMAL', options: ['OPTIMAL','SIMPLE'] },
      { k: 'SQUARED', label: 'SQUARED (MSD)', type: 'flag', def: false }
    ]
  },
  DRMSD: {
    cat: 'rmsd', desc: 'Distance-RMSD: RMSD computed from interatomic distances.',
    fields: [
      { k: 'REFERENCE', label: 'REFERENCE (.pdb)', type: 'text', def: 'ref.pdb', required: true },
      { k: 'LOWER_CUTOFF', label: 'LOWER_CUTOFF (nm)', type: 'num', def: '0.1' },
      { k: 'UPPER_CUTOFF', label: 'UPPER_CUTOFF (nm)', type: 'num', def: '0.8' },
      { k: 'TYPE', label: 'TYPE', type: 'select', def: 'DRMSD', options: ['DRMSD', 'INTER-DRMSD', 'INTRA-DRMSD'] },
      { k: 'SQUARED', label: 'SQUARED', type: 'flag', def: false, since: '2.10' },
      { k: 'NOPBC', label: 'NOPBC', type: 'flag', def: false }
    ]
  },
  PCARMSD: {
    cat: 'rmsd', desc: 'Calculate the PCA components against an average structure.',
    components: ['eig-0', 'eig-1', 'residual'],
    fields: [
      { k: 'AVERAGE', label: 'AVERAGE (.pdb)', type: 'text', def: 'average.pdb', required: true },
      { k: 'EIGENVECTORS', label: 'EIGENVECTORS (.pdb)', type: 'text', def: 'eigenvec.pdb', required: true },
      { k: 'SQUARED_ROOT', label: 'SQUARED_ROOT', type: 'flag', def: false }
    ]
  },
  PATHMSD: {
    cat: 'rmsd', desc: 'Path collective variables (progress s and distance z along a path).',
    components: ['sss', 'zzz'],
    fields: [
      { k: 'REFERENCE', label: 'REFERENCE (.pdb)', type: 'text', def: 'path.pdb', required: true },
      { k: 'LAMBDA', label: 'LAMBDA', type: 'num', def: '500', required: true }
    ]
  },
  PROPERTYMAP: {
    cat: 'rmsd', desc: 'Calculate generic property maps based on distances to reference frames.',
    components: 'propertymap',
    fields: [
      { k: 'REFERENCE', label: 'REFERENCE (.pdb)', type: 'text', def: 'allv.pdb', required: true },
      { k: 'PROPERTY', label: 'PROPERTY (X,Y...)', type: 'text', def: 'X,Y', required: true },
      { k: 'LAMBDA', label: 'LAMBDA', type: 'num', def: '69087', required: true },
      { k: 'NEIGH_SIZE', label: 'NEIGH_SIZE', type: 'num', def: '8' },
      { k: 'NEIGH_STRIDE', label: 'NEIGH_STRIDE', type: 'num', def: '4' }
    ]
  },
  PUCKERING: {
    cat: 'nucleic', desc: 'Sugar-ring pseudorotation coordinates (5- or 6-membered rings).',
    components: 'puckering',
    fields: [
      { k: 'ATOMS', label: 'ATOMS (5 or 6, in order)', type: 'atoms', def: '1,2,3,4,5,6', required: true }
    ]
  },
  ALPHARMSD: {
    cat: 'rmsd', act: 'ALPHARMSD',
    prereq: 'wholemolecules', needsMolinfo: true,
    prereqSkipIf: (inst) => String(inst.values.TYPE || '').toUpperCase() === 'DRMSD',
    desc: 'Alpha-helical content: counts six-residue segments whose configuration resembles an idealised alpha helix (bare label = number of segments). Needs MOLINFO.',
    fields: [
      { k: 'RESIDUES', label: 'RESIDUES', type: 'text', def: 'all', required: true, help: 'Residues that could form the structure, "all" or a list. Requires a MOLINFO reference structure.' },
      { k: 'TYPE', label: 'TYPE', type: 'select', def: 'DRMSD', options: ['DRMSD', 'OPTIMAL', 'SIMPLE'], help: 'How the RMSD to the ideal element is measured. DRMSD needs no WHOLEMOLECULES; OPTIMAL/SIMPLE do.' },
      { k: 'R_0', label: 'R_0 (nm)', type: 'num', def: '0.08', required: true, help: 'r_0 of the switching function. The reference value used in the original paper was 0.08 nm.' },
      { k: 'D_0', label: 'D_0 (nm)', type: 'num', def: '0.0' },
      { k: 'NN', label: 'NN', type: 'num', def: '8' },
      { k: 'MM', label: 'MM', type: 'num', def: '12' },
      { k: 'NOPBC', label: 'NOPBC', type: 'flag', def: false }
    ]
  },
  ANTIBETARMSD: {
    cat: 'rmsd', act: 'ANTIBETARMSD',
    prereq: 'wholemolecules', needsMolinfo: true,
    prereqSkipIf: (inst) => String(inst.values.TYPE || '').toUpperCase() === 'DRMSD',
    desc: 'Antiparallel beta-sheet content: counts six-residue segments resembling an idealised antiparallel beta sheet (bare label = number of segments). Needs MOLINFO.',
    fields: [
      { k: 'RESIDUES', label: 'RESIDUES', type: 'text', def: 'all', required: true, help: 'Residues that could form the sheet, "all" or a list. Requires a MOLINFO reference structure.' },
      { k: 'TYPE', label: 'TYPE', type: 'select', def: 'DRMSD', options: ['DRMSD', 'OPTIMAL', 'SIMPLE'], help: 'RMSD metric. DRMSD needs no WHOLEMOLECULES; OPTIMAL/SIMPLE do.' },
      { k: 'R_0', label: 'R_0 (nm)', type: 'num', def: '0.08', required: true, help: 'r_0 of the switching function (paper value 0.08 nm).' },
      { k: 'D_0', label: 'D_0 (nm)', type: 'num', def: '0.0' },
      { k: 'NN', label: 'NN', type: 'num', def: '8' },
      { k: 'MM', label: 'MM', type: 'num', def: '12' },
      { k: 'STYLE', label: 'STYLE', type: 'select', def: 'all', options: ['all', 'inter', 'intra'], help: 'all: any geometry; inter: only two-chain sheets; intra: only single-chain sheets.' },
      { k: 'STRANDS_CUTOFF', label: 'STRANDS_CUTOFF (nm)', type: 'num', def: '1', help: 'Skip the RMSD when the two strands are further apart than this, a large speedup, but only valid with LESS_THAN.' },
      { k: 'NOPBC', label: 'NOPBC', type: 'flag', def: false }
    ]
  },
  PARABETARMSD: {
    cat: 'rmsd', act: 'PARABETARMSD',
    prereq: 'wholemolecules', needsMolinfo: true,
    prereqSkipIf: (inst) => String(inst.values.TYPE || '').toUpperCase() === 'DRMSD',
    desc: 'Parallel beta-sheet content: counts six-residue segments resembling an idealised parallel beta sheet (bare label = number of segments). Needs MOLINFO.',
    fields: [
      { k: 'RESIDUES', label: 'RESIDUES', type: 'text', def: 'all', required: true, help: 'Residues that could form the sheet, "all" or a list. Requires a MOLINFO reference structure.' },
      { k: 'TYPE', label: 'TYPE', type: 'select', def: 'DRMSD', options: ['DRMSD', 'OPTIMAL', 'SIMPLE'], help: 'RMSD metric. DRMSD needs no WHOLEMOLECULES; OPTIMAL/SIMPLE do.' },
      { k: 'R_0', label: 'R_0 (nm)', type: 'num', def: '0.08', required: true, help: 'r_0 of the switching function (paper value 0.08 nm).' },
      { k: 'D_0', label: 'D_0 (nm)', type: 'num', def: '0.0' },
      { k: 'NN', label: 'NN', type: 'num', def: '8' },
      { k: 'MM', label: 'MM', type: 'num', def: '12' },
      { k: 'STYLE', label: 'STYLE', type: 'select', def: 'all', options: ['all', 'inter', 'intra'], help: 'all: any geometry; inter: only two-chain sheets; intra: only single-chain sheets.' },
      { k: 'STRANDS_CUTOFF', label: 'STRANDS_CUTOFF (nm)', type: 'num', def: '1', help: 'Skip the RMSD when the two strands are further apart than this, a large speedup, but only valid with LESS_THAN.' },
      { k: 'NOPBC', label: 'NOPBC', type: 'flag', def: false }
    ]
  },
  ERMSD: {
    cat: 'nucleic', desc: 'eRMSD for nucleic-acid structures vs a reference.',
    fields: [
      { k: 'REFERENCE', label: 'REFERENCE (.pdb)', type: 'text', def: 'ref.pdb', required: true },
      { k: 'CUTOFF', label: 'CUTOFF', type: 'num', def: '2.4', help: 'Only pairs of nucleotides closer than this enter the eRMSD. It is measured in eRMSD\'s scaled, dimensionless distance, not in nm; the default is 2.4.' }
    ]
  },
  Q6: {
    cat: 'order', desc: 'Steinhardt Q6 bond-orientational order parameter, the standard descriptor for crystalline vs liquid local structure.',
    switchSpeed: true, compStyle: 'dot',
    fields: [
      { k: 'SPECIES', label: 'SPECIES', type: 'atoms', def: '1-64', required: true, help: 'The atoms whose local environment (order parameter) is computed. Use SPECIESA/SPECIESB via CUSTOM for two-group variants.' },
      { k: 'R_0', label: 'R_0 (nm)', type: 'num', def: '0.25', required: true },
      { k: 'D_0', label: 'D_0 (nm)', type: 'num', def: '0.0', help: 'Offset of the switching function; the switch begins to decay at D_0.' },
      { k: 'D_MAX', label: 'D_MAX (nm)', type: 'num', def: '0.5', help: 'Distance beyond which the switch is exactly zero. Setting it enables linked-cell neighbour search, a large speedup. Set it a bit above where the switch has decayed to ~0.' },
      { k: 'MEAN', label: 'MEAN', type: 'flag', def: true, help: 'Output the mean of the per-atom Q6 values (a single scalar CV).' },
      { k: 'VMEAN', label: 'VMEAN', type: 'flag', def: false, help: 'Output the norm of the mean Steinhardt vector.' }
    ]
  },
  Q4: {
    cat: 'order', desc: 'Steinhardt Q4 bond-orientational order parameter, distinguishes cubic/FCC-like local order.',
    switchSpeed: true, compStyle: 'dot',
    fields: [
      { k: 'SPECIES', label: 'SPECIES', type: 'atoms', def: '1-64', required: true },
      { k: 'R_0', label: 'R_0 (nm)', type: 'num', def: '0.25', required: true },
      { k: 'D_0', label: 'D_0 (nm)', type: 'num', def: '0.0' },
      { k: 'D_MAX', label: 'D_MAX (nm)', type: 'num', def: '0.5', help: 'Distance beyond which the switch is exactly zero; enables linked-cell speedup.' },
      { k: 'MEAN', label: 'MEAN', type: 'flag', def: true },
      { k: 'VMEAN', label: 'VMEAN', type: 'flag', def: false }
    ]
  },
  Q3: {
    cat: 'order', desc: 'Steinhardt Q3 bond-orientational order parameter.',
    switchSpeed: true, compStyle: 'dot',
    fields: [
      { k: 'SPECIES', label: 'SPECIES', type: 'atoms', def: '1-64', required: true },
      { k: 'R_0', label: 'R_0 (nm)', type: 'num', def: '0.25', required: true },
      { k: 'D_0', label: 'D_0 (nm)', type: 'num', def: '0.0' },
      { k: 'D_MAX', label: 'D_MAX (nm)', type: 'num', def: '0.5', help: 'Distance beyond which the switch is exactly zero; enables linked-cell speedup.' },
      { k: 'MEAN', label: 'MEAN', type: 'flag', def: true }
    ]
  },
  COORDINATIONNUMBER: {
    cat: 'order', desc: 'Per-atom coordination number within a group (local density / neighbour count).',
    switchSpeed: true, compStyle: 'dot',
    fields: [
      { k: 'SPECIES', label: 'SPECIES', type: 'atoms', def: '1-100', required: true },
      { k: 'R_0', label: 'R_0 (nm)', type: 'num', def: '0.3', required: true },
      { k: 'D_0', label: 'D_0 (nm)', type: 'num', def: '0.0' },
      { k: 'D_MAX', label: 'D_MAX (nm)', type: 'num', def: '0.6', help: 'Distance beyond which the switch is exactly zero; enables linked-cell speedup.' },
      { k: 'MEAN', label: 'MEAN', type: 'flag', def: true }
    ]
  },
  // ================================================================
  // Advanced coordination / tetrahedrality / order parameters.
  // These are PLUMED "multicolvars": they compute a per-atom vector
  // and reduce it to named scalar components (mean, morethan, ...).
  // `components` drives the dot-notation picker on the bias/PRINT side.
  // ================================================================
  COORDINATIONNUMBER_ADV: {
    cat: 'contacts', act: 'COORDINATIONNUMBER',
    desc: 'Number of atoms within a defined first coordination sphere (multicolvar form). Critical for defining hydration shells.',
    switchSpeed: true, compStyle: 'dot',
    fields: [
      { k: 'SPECIES', label: 'SPECIES', type: 'atoms', def: '1-100', required: true },
      { k: 'SPECIESA', label: 'SPECIESA (opt.)', type: 'atoms', def: '' },
      { k: 'SPECIESB', label: 'SPECIESB (opt.)', type: 'atoms', def: '' },
      { k: 'R_0', label: 'R_0 (nm)', type: 'num', def: '0.3', required: true },
      { k: 'D_0', label: 'D_0 (nm)', type: 'num', def: '0.0' },
      { k: 'NN', label: 'NN', type: 'num', def: '6' },
      { k: 'MM', label: 'MM (0 = 2*NN)', type: 'num', def: '0' },
      { k: 'D_MAX', label: 'D_MAX (nm)', type: 'num', def: '0.6', help: 'Distance beyond which the switch is exactly zero; enables linked-cell neighbour search, a large speedup.' },
      { k: 'MOMENTS', label: 'MOMENTS (opt.)', type: 'text', def: '', help: 'Moments of the distribution of coordination numbers to output, e.g. 2 or 2-4. Each becomes a component, label.moment-2.' }
    ]
  },
  COORDINATION_MOMENTS: {
    cat: 'contacts', minVersion: '2.10', fallback: 'COORDINATIONNUMBER with R_POWER and MOMENTS', act: 'COORDINATION_MOMENTS',
    desc: 'Moments of the distance distribution in the first coordination sphere.',
    switchSpeed: true, compStyle: 'dot',
    fields: [
      { k: 'SPECIES', label: 'SPECIES', type: 'atoms', def: '1-100', required: true },
      { k: 'R_0', label: 'R_0 (nm)', type: 'num', def: '0.3', required: true },
      { k: 'D_0', label: 'D_0 (nm)', type: 'num', def: '0.0' },
      { k: 'NN', label: 'NN', type: 'num', def: '6' },
      { k: 'MM', label: 'MM (0 = 2*NN)', type: 'num', def: '0' },
      { k: 'D_MAX', label: 'D_MAX (nm)', type: 'num', def: '0.6', help: 'Distance beyond which the switch is exactly zero; enables the linked-cell speedup.' },
      { k: 'R_POWER', label: 'R_POWER', type: 'num', def: '1', required: true },
      { k: 'MOMENTS', label: 'MOMENTS', type: 'text', def: '2-4', required: true },
    ]
  },
  TETRA_RADIAL: {
    cat: 'shape', minVersion: '2.10', act: 'TETRA_RADIAL',
    desc: 'Radial tetrahedrality: whether the four nearest atoms sit on the vertices of a regular tetrahedron, based on radial distances.',
    compStyle: 'dot',
    fields: [
      { k: 'SPECIES', label: 'SPECIES', type: 'atoms', def: '1-64', required: true },
      { k: 'CUTOFF', label: 'CUTOFF (nm)', type: 'num', def: '0.5', required: true },
      { k: 'NOPBC', label: 'NOPBC', type: 'flag', def: false, help: 'Ignore periodic boundary conditions, can speed up a localised selection.' }
    ]
  },
  TETRA_ANGULAR: {
    cat: 'shape', minVersion: '2.10', act: 'TETRA_ANGULAR',
    desc: 'Angular tetrahedrality: order from the variance of the angles between the central atom and its four nearest neighbours.',
    compStyle: 'dot',
    fields: [
      { k: 'SPECIES', label: 'SPECIES', type: 'atoms', def: '1-64', required: true },
      { k: 'CUTOFF', label: 'CUTOFF (nm)', type: 'num', def: '0.5', required: true },
      { k: 'NOPBC', label: 'NOPBC', type: 'flag', def: false }
    ]
  },
  TETRAHEDRAL: {
    cat: 'shape', act: 'TETRAHEDRAL',
    desc: 'Degree to which the whole first coordination shell is arranged like a tetrahedron.',
    switchSpeed: true, compStyle: 'dot',
    fields: [
      { k: 'SPECIES', label: 'SPECIES', type: 'atoms', def: '1-64', required: true },
      { k: 'R_0', label: 'R_0 (nm)', type: 'num', def: '0.3', required: true },
      { k: 'D_0', label: 'D_0 (nm)', type: 'num', def: '0.0' },
      { k: 'D_MAX', label: 'D_MAX (nm)', type: 'num', def: '0.6', help: 'Distance beyond which the switch is exactly zero; enables the linked-cell speedup.' },
      { k: 'PHI', label: 'PHI (rad)', type: 'num', def: '' },
      { k: 'THETA', label: 'THETA (rad)', type: 'num', def: '' },
      { k: 'PSI', label: 'PSI (rad)', type: 'num', def: '' }
    ]
  },
  LOCAL_Q6: {
    cat: 'order', act: 'LOCAL_Q6',
    desc: 'Local Steinhardt Q6: average dot product between the Steinhardt vector on an atom and those in its first coordination sphere. Prevents system-size artifacts during nucleation analysis.',
    switchSpeed: true, compStyle: 'dot',
    fields: [
      { k: 'SPECIES', label: 'SPECIES (base Q6 labels)', type: 'text', def: 'q6a,q6b', required: true, help: 'References the labels of one or more base Q6 actions defined earlier (e.g. two Q6 CVs).' },
      { k: 'R_0', label: 'R_0 (nm)', type: 'num', def: '0.3', required: true },
      { k: 'D_0', label: 'D_0 (nm)', type: 'num', def: '0.0' },
      { k: 'D_MAX', label: 'D_MAX (nm)', type: 'num', def: '0.6', help: 'Distance beyond which the switch is exactly zero; enables the linked-cell speedup.' },
      { k: 'LOWMEM', label: 'LOWMEM', type: 'flag', def: false, until: '2.9' }
    ]
  },
  LOCAL_Q4: {
    cat: 'order', act: 'LOCAL_Q4',
    desc: 'Local Steinhardt Q4 (average dot product with the first coordination sphere).',
    switchSpeed: true, compStyle: 'dot',
    fields: [
      { k: 'SPECIES', label: 'SPECIES (base Q4 labels)', type: 'text', def: 'q4a,q4b', required: true, help: 'References the labels of one or more base Q4 actions defined earlier.' },
      { k: 'R_0', label: 'R_0 (nm)', type: 'num', def: '0.3', required: true },
      { k: 'D_0', label: 'D_0 (nm)', type: 'num', def: '0.0' },
      { k: 'D_MAX', label: 'D_MAX (nm)', type: 'num', def: '0.6' },
      { k: 'LOWMEM', label: 'LOWMEM', type: 'flag', def: false, until: '2.9' }
    ]
  },
  LOCAL_Q3: {
    cat: 'order', act: 'LOCAL_Q3',
    desc: 'Local Steinhardt Q3 (average dot product with the first coordination sphere).',
    switchSpeed: true, compStyle: 'dot',
    fields: [
      { k: 'SPECIES', label: 'SPECIES (base Q3 labels)', type: 'text', def: 'q3a,q3b', required: true, help: 'References the labels of one or more base Q3 actions defined earlier.' },
      { k: 'R_0', label: 'R_0 (nm)', type: 'num', def: '0.3', required: true },
      { k: 'D_0', label: 'D_0 (nm)', type: 'num', def: '0.0' },
      { k: 'D_MAX', label: 'D_MAX (nm)', type: 'num', def: '0.6' },
      { k: 'LOWMEM', label: 'LOWMEM', type: 'flag', def: false, until: '2.9' }
    ]
  },
  SMAC: {
    cat: 'order', act: 'SMAC',
    desc: 'Symmetry function for molecules: detects crystal-like ordering from relative orientations and torsional angles.',
    compStyle: 'dot',
    fields: [
      { k: 'SPECIES', label: 'SPECIES (orient. action)', type: 'text', def: 'm1', required: true, help: 'Label of the action that gives each molecule a position and a direction: MOLECULES in PLUMED 2.9, DISTANCES with COMPONENTS and LOCATION from 2.10. The per-molecule generator writes either.' },
      { k: 'KERNEL1', label: 'KERNEL1 (block)', type: 'text', def: '{GAUSSIAN CENTER=0 SIGMA=0.480}', required: true },
      { k: 'KERNEL2', label: 'KERNEL2 (block)', type: 'text', def: '{GAUSSIAN CENTER=pi SIGMA=0.700}' },
      { k: 'SWITCH', label: 'SWITCH (block)', type: 'text', def: '{RATIONAL R_0=0.6 D_MAX=1.2}', required: true, help: 'Which molecules count as neighbours: set R_0 near the first minimum of the centre-of-mass radial distribution function.' },
      { k: 'SWITCH_COORD', label: 'SWITCH_COORD (block)', type: 'text', def: '{RATIONAL R_0=0.001}' },
      { k: 'LOWMEM', label: 'LOWMEM', type: 'flag', def: false, until: '2.9' }
    ]
  },
  ATOMIC_SMAC: {
    cat: 'order', minVersion: '2.10', fallback: 'SMAC (molecular SMAC)', act: 'ATOMIC_SMAC',
    desc: 'Atomic SMAC: whether the environment is ordered, from the distribution of angles between bonds in the first coordination sphere.',
    compStyle: 'dot',
    fields: [
      { k: 'SPECIES', label: 'SPECIES', type: 'atoms', def: '1-64', required: true },
      { k: 'KERNEL1', label: 'KERNEL1 (block)', type: 'text', def: '{GAUSSIAN CENTER=pi/2 SIGMA=0.480}', required: true, help: 'First kernel on the angle between two bonds, centred on an angle the ordered structure has.' },
      { k: 'KERNEL2', label: 'KERNEL2 (block)', type: 'text', def: '', help: 'A second kernel, for a structure with two characteristic angles.' },
      { k: 'SWITCH', label: 'SWITCH (block)', type: 'text', def: '{RATIONAL R_0=0.3 D_MAX=0.5}', required: true },
      { k: 'SWITCH_COORD', label: 'SWITCH_COORD (block)', type: 'text', def: '{RATIONAL R_0=0.001}' },
      { k: 'LOWMEM', label: 'LOWMEM', type: 'flag', def: false, until: '2.9' }
    ]
  },
  FCCUBIC: {
    cat: 'order', act: 'FCCUBIC',
    desc: 'How similar the environment around an atom is to a face-centred-cubic structure.',
    compStyle: 'dot',
    fields: [
      { k: 'SPECIES', label: 'SPECIES', type: 'atoms', def: '1-64', required: true },
      { k: 'SWITCH', label: 'SWITCH (block)', type: 'text', def: '{CUBIC D_0=0.3 D_MAX=0.45}', required: true, help: 'Switching function for the contact matrix: 1 up to D_0, falling to 0 at D_MAX. Place the pair between the first and second neighbour shells of your crystal; the manual\'s 1.2 and 1.5 are in Lennard-Jones units.' },
      { k: 'ALPHA', label: 'ALPHA', type: 'num', def: '3.0', help: 'Alpha parameter of the angular function. PLUMED uses 3.0 when it is left out.' },
    ]
  },
  // ================================================================
  // Shortcut multicolvar families (ActionShortcut in the PLUMED source).
  // These expand internally into separate reduction actions, so their
  // components use the UNDERSCORE convention (label_mean, label_lessthan).
  // DIHCOR/ALPHABETA collapse to a single scalar (compStyle 'none').
  // ================================================================
  ANGLES: {
    cat: 'angles', act: 'ANGLES', compStyle: 'underscore', reductions: ['MEAN', 'MORE_THAN', 'LESS_THAN', 'BETWEEN'],
    desc: 'Functions of a distribution of angles (optionally weighted by a switching function on the bond lengths). Older-style multicolvar shortcut.',
    fields: [
      { k: 'GROUPA', label: 'GROUPA (central)', type: 'atoms', def: '1-10', help: 'Central atoms about which angles are calculated. Use with GROUPB (+SWITCH).' },
      { k: 'GROUPB', label: 'GROUPB', type: 'atoms', def: '11-100' },
      { k: 'GROUPC', label: 'GROUPC (opt.)', type: 'atoms', def: '' },
      { k: 'GROUP', label: 'GROUP (single set)', type: 'atoms', def: '', help: 'Use instead of GROUPA/B/C to take every distinct triple in one group.' },
      { k: 'SWITCH', label: 'SWITCH (block)', type: 'text', def: '{RATIONAL R_0=0.3 D_MAX=0.6}', help: 'Only bonds shorter than this switching function contribute. Required when using GROUPA/GROUPB.' }
    ]
  },
  TORSIONS: {
    cat: 'angles', act: 'TORSIONS', compStyle: 'underscore', reductions: ['BETWEEN'], notIn: ['2.10'],
    seed: { BETWEEN: '{GAUSSIAN LOWER=-pi UPPER=0 SMEAR=0.05}' },
    desc: 'Functions of a distribution of torsional angles: how many fall in a range. Specify each torsion with numbered ATOMS keywords or MOLINFO @phi/@psi selectors. An angle is periodic, so a mean is not defined.',
    fields: [
      { k: 'ATOMS', label: 'ATOMS (numbered)', type: 'text', def: 'ATOMS1=1,2,3,4 ATOMS2=5,6,7,8', required: true, help: 'Numbered four-atom sets, e.g. ATOMS1=.. ATOMS2=.. (or @phi-3/@psi-3 with MOLINFO).' }
    ]
  },
  XANGLES: {
    cat: 'angles', act: 'XANGLES', compStyle: 'underscore', reductions: ['MEAN', 'MORE_THAN', 'LESS_THAN', 'BETWEEN'],
    desc: 'Angles between atom-pair vectors and the positive x axis (also YANGLES/ZANGLES via the variant field).',
    fields: [
      { k: '__variant', label: 'Axis', type: 'select', def: 'XANGLES', options: ['XANGLES','YANGLES','ZANGLES'], variant: true, help: 'Which Cartesian axis the angle is measured against.' },
      { k: 'ATOMS', label: 'ATOMS (numbered pairs)', type: 'text', def: 'ATOMS1=3,5 ATOMS2=1,2', required: true, help: 'Numbered atom pairs, e.g. ATOMS1=3,5 ATOMS2=1,2.' }
    ]
  },
  XYTORSIONS: {
    cat: 'angles', act: 'XYTORSIONS', compStyle: 'underscore', reductions: ['BETWEEN'],
    seed: { BETWEEN: '{GAUSSIAN LOWER=-pi UPPER=0 SMEAR=0.05}' },
    desc: 'Torsional angle of atom-pair vectors around one Cartesian axis relative to another axis (XY/XZ/YX/YZ/ZX/ZY variants).',
    fields: [
      { k: '__variant', label: 'Planes', type: 'select', def: 'XYTORSIONS', options: ['XYTORSIONS','XZTORSIONS','YXTORSIONS','YZTORSIONS','ZXTORSIONS','ZYTORSIONS'], variant: true, help: 'Axis to rotate around and reference direction.' },
      { k: 'ATOMS', label: 'ATOMS (numbered pairs)', type: 'text', def: 'ATOMS1=3,5 ATOMS2=1,2', required: true }
    ]
  },
  DIHCOR: {
    cat: 'angles', act: 'DIHCOR', compStyle: 'none',
    desc: 'Similarity between pairs of dihedral angles: sums ½[1+cos(φ−ψ)] over the specified 8-atom sets. Collapses to a single scalar.',
    fields: [
      { k: 'ATOMS', label: 'ATOMS (numbered, 8 each)', type: 'text', def: 'ATOMS1=1,2,3,4,5,6,7,8', required: true, help: 'Numbered 8-atom sets (two torsions each), e.g. ATOMS1=1,2,3,4,5,6,7,8.' },
      { k: 'NOPBC', label: 'NOPBC', type: 'flag', def: false }
    ]
  },
  ALPHABETA: {
    cat: 'angles', act: 'ALPHABETA', compStyle: 'none',
    desc: 'Distance (with PBC) between a set of torsional angles and reference values: sums ½[1+cos(φ−φ_ref)]. Single scalar output.',
    fields: [
      { k: 'ATOMS', label: 'ATOMS (numbered, 4 each)', type: 'text', def: 'ATOMS1=168,170,172,188 ATOMS2=170,172,188,190', required: true, help: 'Numbered four-atom torsion sets (or @phi/@psi with MOLINFO).' },
      { k: 'REFERENCE', label: 'REFERENCE', type: 'text', def: '3.14', required: true, help: 'A single reference value used for all torsions, or numbered REFERENCE1=.. entries.' },
      { k: 'COEFFICIENT', label: 'COEFFICIENT (opt.)', type: 'text', def: '', help: 'Optional per-torsion weights (single value or numbered).' }
    ]
  },
  COORD_ANGLES: {
    cat: 'contacts', minVersion: '2.10', fallback: 'ANGLES with GROUP and SWITCH', act: 'COORD_ANGLES', compStyle: 'underscore',
    desc: 'Functions of the distribution of angles between bonds in the first coordination spheres of a set of central atoms.',
    fields: [
      { k: 'CATOMS', label: 'CATOMS (central)', type: 'atoms', def: '1', required: true, help: 'Central atoms; all angles between the bonds radiating from each are computed.' },
      { k: 'GROUP', label: 'GROUP (neighbours)', type: 'atoms', def: '2-100', required: true },
      { k: 'SWITCH', label: 'SWITCH (block)', type: 'text', def: '{RATIONAL R_0=0.3 D_MAX=0.6}', required: true, help: 'Only bonds shorter than this switching function are considered.' }
    ]
  },
  INPLANEDISTANCES: {
    cat: 'geometry', act: 'INPLANEDISTANCES', compStyle: 'underscore',
    desc: 'Perpendicular distances between a group of atoms and an axis (defined by two atoms), i.e. distances within the plane perpendicular to that axis.',
    fields: [
      { k: 'VECTORSTART', label: 'VECTORSTART', type: 'atoms', def: '1', required: true, help: 'First atom defining the axis.' },
      { k: 'VECTOREND', label: 'VECTOREND', type: 'atoms', def: '2', required: true, help: 'Second atom defining the axis.' },
      { k: 'GROUP', label: 'GROUP', type: 'atoms', def: '3-100', required: true, help: 'Atoms whose in-plane distances are computed.' }
    ]
  },
  PLANES: {
    cat: 'shape', act: 'PLANES', minVersion: '2.10', compStyle: 'underscore', reductions: [],
    desc: 'Normals to the planes containing groups of three atoms; VMEAN/VSUM give the norm of the mean/sum vector (orientational order of the planes).',
    fields: [
      { k: 'ATOMS', label: 'ATOMS (numbered triples)', type: 'text', def: 'ATOMS1=9,10,11 ATOMS2=89,90,91', required: true, help: 'Numbered three-atom sets, e.g. ATOMS1=9,10,11 ATOMS2=89,90,91.' },
      { k: 'VMEAN', label: 'VMEAN', type: 'flag', def: true, help: 'Output the norm of the mean of the plane-normal vectors.' },
      { k: 'VSUM', label: 'VSUM', type: 'flag', def: false, help: 'Output the norm of the sum of the plane-normal vectors.' }
    ]
  },
  CONSTANT: {
    cat: 'custom', act: 'CONSTANT', noBias: true, components: 'constant',
    desc: 'Return one or more constant values (with or without derivatives). Not biased itself, use it as a fixed reference/target inside a CUSTOM/MATHEVAL combination, e.g. diff: CUSTOM ARG=cv,ref FUNC=x-y.',
    fields: [
      { k: 'VALUE', label: 'VALUE (single)', type: 'text', def: '', help: 'A single constant, referenced by the bare label. Leave blank if you use VALUES instead.' },
      { k: 'VALUES', label: 'VALUES (comma list)', type: 'text', def: '1.0,2.0', help: 'A list of constants, referenced as label.v-0, label.v-1, ... Leave blank if you use VALUE instead.' },
      { k: 'NODERIV', label: 'NODERIV', type: 'flag', def: false, until: '2.9', help: 'Output the values without derivatives (set when the constant is not differentiated).' }
    ]
  },
  MASS: {
    cat: 'custom', minVersion: '2.10', desc: 'Extracts the masses of one or multiple atoms.',
    fields: [
      { k: 'ATOMS', label: 'ATOMS', type: 'atoms', def: '1', required: true }
    ]
  },
  CHARGE: {
    cat: 'custom', minVersion: '2.10', desc: 'Extracts the charges of one or multiple atoms.',
    fields: [
      { k: 'ATOMS', label: 'ATOMS', type: 'atoms', def: '1', required: true }
    ]
  },
  EXTRACV: {
    cat: 'custom', desc: 'Allows PLUMED to use collective variables computed natively within the MD engine.',
    fields: [
      { k: 'NAME', label: 'NAME', type: 'text', def: 'lambda', required: true }
    ]
  },
  CUSTOM: {
    cat: 'custom', desc: 'Write any PLUMED action line yourself, the label is added automatically. Use this for CVs not in the catalogue, for actions that a LOAD line adds, or for advanced options.',
    isCustom: true,
    fields: [
      { k: '__raw', label: 'Full action (after the label)', type: 'text', def: 'DISTANCE ATOMS=1,2', required: true,
       help: 'Everything after "label:". Example: COORDINATION GROUPA=1-10 GROUPB=20-40 R_0=0.3 NLIST NL_CUTOFF=0.5 NL_STRIDE=100' },
      { k: '__components', label: 'Components (opt.)', type: 'text', def: '', help: 'Names of the values the action outputs, comma separated, e.g. mean,moment2. They become label.mean and label.moment2 in the bias and PRINT lists. Leave blank when the label itself is the value.' }
    ]
  }
};

/* Each entry knows its own key, so a helper handed the entry alone can name
   the action. */
for (const key of Object.keys(CV_DEFS)) CV_DEFS[key].__key = key;

/** One use case per collective variable. */
export const CV_EXAMPLES = {
  GROUP: 'Load ice-binding face atoms once from an index file (NDX_FILE=atoms.ndx NDX_GROUP=binding_face) and reuse the label in later CVs.',
  COM: 'Track the centre of mass of a protein so a restraint follows the molecule as it diffuses.',
  CENTER: 'One centre per molecule, so that an order parameter sees molecules and not atoms.',
  DISTANCE: 'Monitor an end-to-end distance of a polymer, or the separation between an ion and a binding site.',
  ANGLE: 'Follow the bend of a three-atom motif, e.g. a hydrogen-bond donor–H–acceptor angle.',
  TORSION: 'Bias a backbone φ/ψ dihedral to sample different protein conformations.',
  DIHEDRAL_CORRELATION: 'Measure how correlated two adjacent backbone dihedrals are along a chain.',
  DIHCOR: 'Summed similarity of consecutive dihedral pairs, a compact descriptor of local chain order.',
  COORDINATION: 'Count water molecules in the first hydration shell of an ion to follow (de)solvation.',
  CONTACTMAP: 'Track many native contacts at once to follow folding/unfolding.',
  COORDINATIONNUMBER_ADV: 'Per-atom coordination number of interfacial waters to detect ordering near a clay slab.',
  COORDINATION_MOMENTS: 'Higher moments of the neighbour-distance distribution to distinguish liquid vs ordered shells.',
  COORD_ANGLES: 'Distribution of bond angles in the first shell, sensitive to local packing geometry.',
  GYRATION: 'Follow the compactness (radius of gyration) of a polymer or peptide during collapse.',
  TETRA_RADIAL: 'Detect ice-like tetrahedral ordering of water near a surface from radial geometry.',
  TETRA_ANGULAR: 'Angular tetrahedral order of water to distinguish liquid from ice-like layers.',
  TETRAHEDRAL: 'Shell-averaged tetrahedrality to monitor disruption of ordered water at an interface.',
  PLANES: 'Orientational order of planar molecules (e.g. aromatic rings) via their plane normals.',
  RMSD: 'Distance from a folded reference structure to drive folding/unfolding.',
  DRMSD: 'Distance-based RMSD that avoids alignment, useful for flexible or periodic systems.',
  PCARMSD: 'Project motion onto PCA eigenvectors to bias along dominant collective modes.',
  PATHMSD: 'Progress (s) and distance (z) along a predefined transition path between two states.',
  PROPERTYMAP: 'Map the system onto arbitrary reference properties for path-like sampling.',
  Q6: 'Sixth-order Steinhardt parameter to distinguish crystalline from liquid local order during nucleation.',
  Q4: 'Fourth-order Steinhardt parameter, sensitive to cubic/FCC-like local order.',
  Q3: 'Third-order Steinhardt parameter for local bond-orientational order.',
  COORDINATIONNUMBER: 'Classic per-atom coordination number for density/neighbour analysis.',
  LOCAL_Q6: 'Local Q6 (averaged with neighbours) to identify solid-like nuclei without system-size artifacts.',
  LOCAL_Q4: 'Local Q4 for neighbour-averaged cubic order during crystallization.',
  LOCAL_Q3: 'Local Q3 for neighbour-averaged bond-orientational order.',
  SMAC: 'Detect crystal-like molecular packing from relative orientations, e.g. in nucleation of molecular crystals.',
  ATOMIC_SMAC: 'Atomic variant of SMAC for ordered vs disordered atomic environments.',
  FCCUBIC: 'Measure FCC-like local structure to count solid-like atoms at a solid–liquid interface.',
  POSITION: 'Track an atom or centre along a chosen axis (e.g. permeation through a channel).',
  PROJECTION_ON_AXIS: 'Project a position onto a defined axis, e.g. depth of a ligand along a pore.',
  PLANE: 'Represent a planar group orientation via its normal vector.',
  CELL: 'Follow simulation-cell components under variable-cell (e.g. NPT phase transitions).',
  VOLUME: 'Bias the box volume to explore density changes or pressure-driven transitions.',
  DIPOLE: 'Track the dipole moment of a group, e.g. reorientation of water in a field.',
  ENERGY: 'Use total potential energy as a CV for multithermal/energy-based sampling.',
  DHENERGY: 'Debye–Hückel electrostatic interaction energy between two groups in implicit solvent.',
  GHBFIX: 'Tuned hydrogen-bond interaction energy for RNA/AMBER-style corrections.',
  EEFSOLV: 'EEF1 implicit-solvation free energy as a CV for folding in implicit solvent.',
  DIMER: 'Dimer interaction energy for replica-exchange dimer sampling.',
  PUCKERING: 'Sugar-ring pseudorotation to sample nucleic-acid ribose conformations.',
  ERMSD: 'Nucleic-acid eRMSD from a reference to bias base-pairing geometry.',
  ALPHARMSD: 'Count α-helical segments to bias helix formation/melting in a peptide.',
  ANTIBETARMSD: 'Count antiparallel β-sheet segments to study β-hairpin formation.',
  PARABETARMSD: 'Count parallel β-sheet segments to study sheet assembly.',
  ANGLES: 'Distribution of many bond angles at once, e.g. counting near-tetrahedral angles in a shell.',
  TORSIONS: 'Count how many of a set of torsions fall in a target range (e.g. helical φ/ψ).',
  XANGLES: 'Angle of atom-pair vectors to a Cartesian axis, orientational order relative to a surface normal.',
  XYTORSIONS: 'Torsion of atom-pair vectors around a Cartesian axis, anisotropic orientational order.',
  ALPHABETA: 'Similarity of a set of dihedrals to reference values, a soft "how native" descriptor.',
  INPLANEDISTANCES: 'Count atoms inside a cylinder around an axis, e.g. waters in a pore cross-section.',
  CONSTANT: 'Provide a fixed target value to subtract inside a CUSTOM combination (e.g. diff: CUSTOM ARG=cv,ref FUNC=x-y).',
  MASS: 'Expose atom masses for use inside a CUSTOM/MATHEVAL expression.',
  CHARGE: 'Expose atom charges for use inside a CUSTOM/MATHEVAL expression.',
  EXTRACV: 'Read a CV computed natively by the MD engine (e.g. an alchemical lambda).',
  CUSTOM: 'An action from a LOAD file, e.g. PAIRENTROPY ATOMS=1-2400:8 MAXR=0.6 SIGMA=0.05.'
};

/** Groups of bias methods. */
export const BIAS_CATEGORIES = {
  'none':    'None, track only',
  'metad':   'Metadynamics family',
  'restraint':'Restraints & walls'
};

/** Bias methods and their editable parameters. `perCV` parameters take one value per biased argument. */
export const BIAS_DEFS = {
  none:      { cat: 'none',  label: 'None (track CVs only)', params: [] },
  metad: { cat: 'metad', action: 'METAD', label: 'Metadynamics (standard)', params: [
    { k: 'HEIGHT', label: 'HEIGHT', def: '1.2', help: 'Height of the Gaussian hills, in energy units. Larger hills fill the surface faster but converge less precisely.' },
    { k: 'PACE', label: 'PACE', def: '500', help: 'How often (in MD steps) a hill is deposited. Smaller = more frequent, faster filling but more overhead.' }
  ]},
  wt_metad: { cat: 'metad', action: 'METAD', label: 'Well-Tempered Metadynamics', params: [
    { k: 'HEIGHT', label: 'HEIGHT', def: '1.2', help: 'Initial hill height (energy units). In well-tempered MetaD the height is progressively scaled down.' },
    { k: 'PACE', label: 'PACE', def: '500', help: 'Steps between hill deposition.' },
    { k: 'BIASFACTOR', label: 'BIASFACTOR', def: '10', help: 'Well-tempered bias factor γ. Higher = explores higher free-energy barriers; typical range 5–20. Needs TEMP.' },
    { k: 'TEMP', label: 'TEMP (K)', def: '', fallback: 'plumedTemp', help: 'System temperature. Required for well-tempered metadynamics. Leave blank to use the global TEMP above.' }
  ]},
  pbmetad: { cat: 'metad', action: 'PBMETAD', label: 'Parallel-Bias Metadynamics (PBMETAD)', params: [
    { k: 'HEIGHT', label: 'HEIGHT', def: '1.2', help: 'Initial hill height (energy units).' },
    { k: 'PACE', label: 'PACE', def: '500', help: 'Steps between hill deposition.' },
    { k: 'BIASFACTOR', label: 'BIASFACTOR', def: '10', help: 'Well-tempered bias factor γ (typical 5–20).' },
    { k: 'TEMP', label: 'TEMP (K)', def: '', fallback: 'plumedTemp', help: 'System temperature. Leave blank to use the global TEMP above.' }
  ]},
  opes: { cat: 'metad', action: 'OPES_METAD', label: 'OPES (probability enhanced)', params: [
    { k: 'PACE', label: 'PACE', def: '500', help: 'How often (steps) a kernel is deposited.' },
    { k: 'BARRIER', label: 'BARRIER', def: '30', help: 'The largest free-energy barrier (energy units) you expect to cross. The single most important OPES setting, it also sets BIASFACTOR, EPSILON and KERNEL_CUTOFF to sensible values. Set it a bit above your estimated barrier.' },
    { k: 'TEMP', label: 'TEMP (K)', def: '', fallback: 'plumedTemp', help: 'System temperature. Leave blank to use the global TEMP above.' },
    { k: 'SIGMA', label: 'SIGMA', def: 'ADAPTIVE', help: 'Initial kernel widths. Leave as ADAPTIVE (recommended) to let OPES estimate them from the fluctuations; or give one value per biased CV to fix them.' }
  ]},
  restraint: { cat: 'restraint', action: 'RESTRAINT', label: 'Harmonic RESTRAINT (umbrella)', params: [
    { k: 'AT', label: 'AT', def: '0.0', perCV: true, help: 'The centre of the restraint for each CV, the value it is pulled toward.' },
    { k: 'KAPPA', label: 'KAPPA', def: '200', perCV: true, help: 'Harmonic force constant per CV (energy per CV-unit²). Larger = stiffer restraint.' },
    { k: 'SLOPE', label: 'SLOPE', def: '', perCV: true, help: 'Optional linear term per CV (energy per CV-unit); adds a constant force. Leave blank for a pure harmonic restraint.' }
  ]},
  moving: { cat: 'restraint', action: 'MOVINGRESTRAINT', label: 'MOVINGRESTRAINT (steered MD)', params: [
    { k: 'STEP0', label: 'STEP0', def: '0', help: 'MD step at which the restraint takes the AT0/KAPPA0 values (the start of the pulling schedule).' },
    { k: 'AT0', label: 'AT0', def: '0.0', perCV: true, help: 'Restraint centre per CV at STEP0 (the starting position).' },
    { k: 'KAPPA0', label: 'KAPPA0', def: '0', perCV: true, help: 'Force constant per CV at STEP0. Often 0 so the pull ramps up.' },
    { k: 'STEP1', label: 'STEP1', def: '100000', help: 'MD step at which the restraint reaches the AT1/KAPPA1 values (end of the pull). Values are linearly interpolated between steps.' },
    { k: 'AT1', label: 'AT1', def: '1.0', perCV: true, help: 'Restraint centre per CV at STEP1 (the target position you steer toward).' },
    { k: 'KAPPA1', label: 'KAPPA1', def: '200', perCV: true, help: 'Force constant per CV at STEP1.' }
  ]},
  upper: { cat: 'restraint', action: 'UPPER_WALLS', label: 'UPPER_WALLS', params: [
    { k: 'AT', label: 'AT', def: '2.0', perCV: true, help: 'Position of the wall per CV. The potential is felt when the CV goes above this value.' },
    { k: 'KAPPA', label: 'KAPPA', def: '150', perCV: true, help: 'Force constant of the wall per CV (energy per CV-unit²).' },
    { k: 'EXP', label: 'EXP', def: '2', perCV: true, help: 'Exponent of the wall potential (2 = harmonic; higher = steeper/stiffer).' },
    { k: 'EPS', label: 'EPS', def: '1', perCV: true, help: 'Rescaling factor inside the wall expression (usually 1).' },
    { k: 'OFFSET', label: 'OFFSET', def: '0', perCV: true, help: 'Offset added to the wall position (shifts where the potential starts).' }
  ]},
  lower: { cat: 'restraint', action: 'LOWER_WALLS', label: 'LOWER_WALLS', params: [
    { k: 'AT', label: 'AT', def: '0.2', perCV: true, help: 'Position of the wall per CV. The potential is felt when the CV goes below this value.' },
    { k: 'KAPPA', label: 'KAPPA', def: '150', perCV: true, help: 'Force constant of the wall per CV (energy per CV-unit²).' },
    { k: 'EXP', label: 'EXP', def: '2', perCV: true, help: 'Exponent of the wall potential (2 = harmonic; higher = steeper).' },
    { k: 'EPS', label: 'EPS', def: '1', perCV: true, help: 'Rescaling factor inside the wall expression (usually 1).' },
    { k: 'OFFSET', label: 'OFFSET', def: '0', perCV: true, help: 'Offset added to the wall position.' }
  ]},
  abmd: { cat: 'restraint', action: 'ABMD', label: 'ABMD (ratchet)', params: [
    { k: 'TO', label: 'TO', def: '0.0', perCV: true, help: 'Target value per CV the ratchet moves toward. The restraint only tightens as the CV approaches TO, it never pushes backward.' },
    { k: 'KAPPA', label: 'KAPPA', def: '50', perCV: true, help: 'Force constant per CV of the moving (ratchet) restraint.' },
    { k: 'NOISE', label: 'NOISE', def: '', perCV: true, help: 'Optional white-noise intensity per CV, effectively adds a temperature to the ABMD so it can occasionally relax backward. Leave blank for a strict ratchet.' }
  ]}
};

/**
 * Functions of other values. A function takes the arguments picked for it,
 * is printed like a CV and can be biased like one.
 */
export const FUNCTION_DEFS = {
  COMBINE: {
    label: 'COMBINE (weighted sum)',
    desc: 'A polynomial combination of the arguments: the sum of COEFFICIENTS × (argument − PARAMETERS) ^ POWERS. With the defaults it is a plain sum; with fitted coefficients it is a linear reaction coordinate.',
    fields: [
      { k: 'COEFFICIENTS', label: 'COEFFICIENTS', type: 'text', def: '', help: 'One coefficient per argument, comma separated. Leave blank for 1.0 each.' },
      { k: 'PARAMETERS', label: 'PARAMETERS (opt.)', type: 'text', def: '', help: 'One offset per argument, subtracted before the power is taken. Leave blank for 0.0 each.' },
      { k: 'POWERS', label: 'POWERS (opt.)', type: 'text', def: '', help: 'One power per argument. Leave blank for 1.0 each.' },
      { k: 'NORMALIZE', label: 'NORMALIZE', type: 'flag', def: false, help: 'Scale the coefficients so that they sum to one, which turns the sum into a weighted mean.' },
      { k: 'PERIODIC', label: 'PERIODIC', type: 'text', def: 'NO', required: true, help: 'NO, or the two ends of the period such as -pi,pi when the result is an angle.' }
    ]
  },
  CUSTOM: {
    label: 'CUSTOM (any expression)',
    desc: 'An expression of the arguments, evaluated by the Lepton library: + - * / ^, sqrt, exp, log, sin, cos, step and more. Known as MATHEVAL in older inputs.',
    fields: [
      { k: 'VAR', label: 'VAR (opt.)', type: 'text', def: '', help: 'A name for each argument, in order, comma separated. Leave blank to use x, y and z for up to three arguments.' },
      { k: 'FUNC', label: 'FUNC', type: 'text', def: 'x-y', required: true, help: 'The expression, e.g. x-y or sqrt(x^2+y^2). Spaces are removed when it is written.' },
      { k: 'PERIODIC', label: 'PERIODIC', type: 'text', def: 'NO', required: true, help: 'NO, or the two ends of the period such as -pi,pi when the result is an angle.' }
    ]
  }
};

/** One use case per function. */
export const FUNCTION_EXAMPLES = {
  COMBINE: 'A reaction coordinate fitted by a dimensionality-reduction method, written as a weighted sum of ten order parameters and then biased.',
  CUSTOM: 'The difference between two distances, x-y, to follow a proton or a ligand moving from one site to another.'
};
