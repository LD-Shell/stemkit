/**
 * @module core/lammps-workflow-presets
 *
 * STEMKit, MD Workflow Generator: the LAMMPS force-field presets, the
 * thermostats and barostats, and the facts the workflow builder takes its
 * defaults from. No DOM; the builder is src/core/lammps-workflow.js.
 * Author: Olanrewaju M. Daramola
 *
 * Each preset says what a LAMMPS input needs for one family of force
 * fields: units, atom style, the bonded and pair styles, how 1-2/1-3/1-4
 * pairs are weighted, mixing, long-range electrostatics, the neighbour skin
 * and the time step with and without rigid bonds to hydrogen. Every default
 * is the one the LAMMPS documentation or the force field's authors give,
 * and `sources` names them. The explanations are STEMKit's own words; the
 * links go to docs.lammps.org for the full text.
 *
 * What a restart file keeps was checked against LAMMPS 29 Aug 2024
 * (src/write_restart.cpp): pair styles that read their parameters from a
 * file (eam, tersoff, sw, reaxff) and hybrid styles write no restart data,
 * so read_restart leaves no pair style at all and every stage must give
 * pair_style and pair_coeff again (`pair.restart: false`).
 */

import { LAMMPS_DOCS } from './lammps-reference.js';

const doc = (page) => `${LAMMPS_DOCS}${page}.html`;
const deepFreeze = (v) => {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
};

/* ------------------------------------------------------------------ *
 * Papers and pages the presets cite
 * ------------------------------------------------------------------ */

const REF = {
  bioff: { text: 'LAMMPS Howto: CHARMM, AMBER, COMPASS and DREIDING force fields', url: doc('Howto_bioFF') },
  pairCharmm: { text: 'LAMMPS pair_style lj/charmm and lj/charmmfsw', url: doc('pair_charmm') },
  dihedralCharmm: { text: 'LAMMPS dihedral_style charmm and charmmfsw', url: doc('dihedral_charmm') },
  cmap: { text: 'LAMMPS fix cmap (CHARMM backbone cross-terms)', url: doc('fix_cmap') },
  charmmfswExample: { text: 'LAMMPS examples/charmmfsw: an input CHARMM-GUI wrote', url: 'https://github.com/lammps/lammps/tree/stable/examples/charmmfsw' },
  charmmGui: { text: 'Lee et al., J. Chem. Theory Comput. 12, 405 (2016): CHARMM-GUI inputs for CHARMM36', url: 'https://doi.org/10.1021/acs.jctc.5b00935' },
  charmm36: { text: 'Best et al., J. Chem. Theory Comput. 8, 3257 (2012): CHARMM36 protein force field', url: 'https://doi.org/10.1021/ct300400x' },
  steinbach: { text: 'Steinbach and Brooks, J. Comput. Chem. 15, 667 (1994): force switching', url: 'https://doi.org/10.1002/jcc.540150702' },
  mackerell: { text: 'MacKerell et al., J. Phys. Chem. B 102, 3586 (1998): CHARMM22', url: 'https://doi.org/10.1021/jp973084f' },
  cornell: { text: 'Cornell et al., J. Am. Chem. Soc. 117, 5179 (1995): the AMBER functional form', url: 'https://doi.org/10.1021/ja00124a002' },
  ff14sb: { text: 'Maier et al., J. Chem. Theory Comput. 11, 3696 (2015): ff14SB', url: 'https://doi.org/10.1021/acs.jctc.5b00255' },
  opls: { text: 'Jorgensen, Maxwell and Tirado-Rives, J. Am. Chem. Soc. 118, 11225 (1996): OPLS-AA', url: 'https://doi.org/10.1021/ja9621760' },
  compass: { text: 'Sun, J. Phys. Chem. B 102, 7338 (1998): COMPASS', url: 'https://doi.org/10.1021/jp980939v' },
  pairClass2: { text: 'LAMMPS pair_style lj/class2', url: doc('pair_class2') },
  pairLjCutCoul: { text: 'LAMMPS pair_style lj/cut/coul/long', url: doc('pair_lj_cut_coul') },
  specialBonds: { text: 'LAMMPS special_bonds', url: doc('special_bonds') },
  pairModify: { text: 'LAMMPS pair_modify (mix, shift, tail)', url: doc('pair_modify') },
  kspace: { text: 'LAMMPS kspace_style', url: doc('kspace_style') },
  tip3pHowto: { text: 'LAMMPS Howto: TIP3P water', url: doc('Howto_tip3p') },
  spcHowto: { text: 'LAMMPS Howto: SPC and SPC/E water', url: doc('Howto_spc') },
  tip4pHowto: { text: 'LAMMPS Howto: TIP4P water', url: doc('Howto_tip4p') },
  pairTip4p: { text: 'LAMMPS pair_style lj/cut/tip4p/long', url: doc('pair_lj_cut_tip4p') },
  tip3p: { text: 'Jorgensen et al., J. Chem. Phys. 79, 926 (1983): TIP3P', url: 'https://doi.org/10.1063/1.445869' },
  spce: { text: 'Berendsen, Grigera and Straatsma, J. Phys. Chem. 91, 6269 (1987): SPC/E', url: 'https://doi.org/10.1021/j100308a038' },
  tip4p2005: { text: 'Abascal and Vega, J. Chem. Phys. 123, 234505 (2005): TIP4P/2005', url: 'https://doi.org/10.1063/1.2121687' },
  pairEam: { text: 'LAMMPS pair_style eam, eam/alloy, eam/fs', url: doc('pair_eam') },
  dawBaskes: { text: 'Daw and Baskes, Phys. Rev. B 29, 6443 (1984): the embedded-atom method', url: 'https://doi.org/10.1103/PhysRevB.29.6443' },
  foiles: { text: 'Foiles, Baskes and Daw, Phys. Rev. B 33, 7983 (1986): Cu_u3.eam', url: 'https://doi.org/10.1103/PhysRevB.33.7983' },
  mishin: { text: 'Mishin et al., Phys. Rev. B 63, 224106 (2001): Cu_mishin1.eam.alloy', url: 'https://doi.org/10.1103/PhysRevB.63.224106' },
  finnisSinclair: { text: 'Finnis and Sinclair, Philos. Mag. A 50, 45 (1984): the Finnis-Sinclair form', url: 'https://doi.org/10.1080/01418618408244210' },
  mendelev: { text: 'Mendelev et al., Philos. Mag. 83, 3977 (2003): Fe_mm.eam.fs', url: 'https://doi.org/10.1080/14786430310001613264' },
  pairTersoff: { text: 'LAMMPS pair_style tersoff', url: doc('pair_tersoff') },
  tersoff: { text: 'Tersoff, Phys. Rev. B 37, 6991 (1988): silicon', url: 'https://doi.org/10.1103/PhysRevB.37.6991' },
  pairSw: { text: 'LAMMPS pair_style sw', url: doc('pair_sw') },
  stillingerWeber: { text: 'Stillinger and Weber, Phys. Rev. B 31, 5262 (1985)', url: 'https://doi.org/10.1103/PhysRevB.31.5262' },
  pairReaxff: { text: 'LAMMPS pair_style reaxff', url: doc('pair_reaxff') },
  qeqReaxff: { text: 'LAMMPS fix qeq/reaxff', url: doc('fix_qeq_reaxff') },
  vanDuin: { text: 'van Duin et al., J. Phys. Chem. A 105, 9396 (2001): ReaxFF', url: 'https://doi.org/10.1021/jp004368u' },
  aktulga: { text: 'Aktulga et al., Parallel Comput. 38, 245 (2012): ReaxFF in LAMMPS', url: 'https://doi.org/10.1016/j.parco.2011.08.005' },
  pairLj: { text: 'LAMMPS pair_style lj/cut', url: doc('pair_lj') },
  melt: { text: 'LAMMPS examples/melt: the Lennard-Jones liquid', url: 'https://github.com/lammps/lammps/tree/stable/examples/melt' },
  units: { text: 'LAMMPS units', url: doc('units') },
  readData: { text: 'LAMMPS read_data', url: doc('read_data') }
};

/* ------------------------------------------------------------------ *
 * Atomic masses (g/mol) for crystals built in the input
 * ------------------------------------------------------------------ */

/** Standard atomic weights (IUPAC) of the elements a lattice is usually built from. */
export const ELEMENT_MASSES = deepFreeze({
  H: 1.008, Li: 6.94, B: 10.81, C: 12.011, N: 14.007, O: 15.999, Na: 22.98977, Mg: 24.305, Al: 26.9815,
  Si: 28.0855, P: 30.973762, S: 32.06, Ar: 39.948, K: 39.0983, Ca: 40.078, Ti: 47.867, V: 50.9415,
  Cr: 51.996, Fe: 55.845, Co: 58.933, Ni: 58.6934, Cu: 63.546, Zn: 65.38, Ga: 69.723, Ge: 72.63,
  As: 74.9216, Kr: 83.798, Zr: 91.224, Nb: 92.90637, Mo: 95.95, Pd: 106.42, Ag: 107.8682, In: 114.818,
  Sn: 118.71, Xe: 131.293, Ta: 180.94788, W: 183.84, Pt: 195.084, Au: 196.96657, Pb: 207.2
});

/* ------------------------------------------------------------------ *
 * Force fields
 * ------------------------------------------------------------------ */

/*
 * The form of each preset:
 *   id, label, family, units, atomStyle, summary, url, sources
 *   source       'data' (read_data) or 'lattice' (built in the input), the default
 *   styles       bond/angle/dihedral/improper styles, or null for atomic systems
 *   pair         {style, restart}: restart false when read_restart cannot restore it
 *   special      special_bonds arguments, or null
 *   mix          pair_modify mix value, or null (the style decides)
 *   tail, shift  pair_modify tail / shift
 *   kspace       {style, accuracy} or null
 *   dt           {constrained, flexible} in the units' time unit
 *   constraints  'shake' or 'none' by default
 *   options      the preset's own settings and their defaults (state.ff)
 *   defaults     temperature, pressure, lengths, restraint K
 *   lattice      a crystal to build when the source is 'lattice'
 */

const BIO_LENGTHS = { nvt: [100, 'ps'], npt: [100, 'ps'], prod: [100, 'ns'] };
const MATERIAL_LENGTHS = { nvt: [10, 'ps'], npt: [20, 'ps'], prod: [1, 'ns'] };

/* 1000 kJ/mol/nm², GROMACS's posre.itp default, in each unit system. */
const RESTRAINT_K = { real: 2.39, metal: 0.1036, lj: 10 };

/**
 * The force-field presets the builder offers. `options` are the preset's
 * own settings with their defaults (the state keeps changes under `ff`);
 * `fields` lists which of them the page should show.
 */
export const LMP_FORCE_FIELDS = deepFreeze([
  {
    id: 'charmm', label: 'CHARMM36 (force switching, as CHARMM-GUI writes it)', family: 'Biomolecular',
    units: 'real', atomStyle: 'full', source: 'data',
    summary: 'Proteins, lipids, nucleic acids and sugars with CHARMM36 and CHARMM TIP3P water: LJ force-switched from 10 to 12 Å, PPPM, SHAKE on bonds to hydrogen, 2 fs.',
    url: doc('Howto_bioFF'),
    styles: { bond: 'harmonic', angle: 'charmm', dihedral: 'charmmfsw', improper: 'harmonic' },
    pair: { style: 'lj/charmmfsw/coul/long', restart: true },
    special: 'charmm', mix: 'arithmetic', tail: false, shift: false,
    kspace: { style: 'pppm', accuracy: 1e-6 },
    dt: { constrained: 2, flexible: 1 }, constraints: 'shake',
    options: { inner: 10, cutoff: 12, kspaceAccuracy: 1e-6, cmapFile: '' },
    fields: ['inner', 'cutoff', 'kspaceAccuracy', 'cmapFile', 'styles', 'extraLines'],
    defaults: { temperature: 303.15, pressure: 1, lengths: BIO_LENGTHS, restraintK: RESTRAINT_K.real },
    sources: [REF.bioff, REF.pairCharmm, REF.dihedralCharmm, REF.cmap, REF.charmmfswExample, REF.charmmGui, REF.charmm36, REF.steinbach]
  },
  {
    id: 'charmm-switch', label: 'CHARMM22/27 (energy switching, older data files)', family: 'Biomolecular',
    units: 'real', atomStyle: 'full', source: 'data',
    summary: 'The older CHARMM styles (lj/charmm/coul/long, dihedral charmm), for data files made for them such as LAMMPS examples/peptide. Use CHARMM36 for new work.',
    url: doc('pair_charmm'),
    styles: { bond: 'harmonic', angle: 'charmm', dihedral: 'charmm', improper: 'harmonic' },
    pair: { style: 'lj/charmm/coul/long', restart: true },
    special: 'charmm', mix: 'arithmetic', tail: false, shift: false,
    kspace: { style: 'pppm', accuracy: 1e-6 },
    dt: { constrained: 2, flexible: 1 }, constraints: 'shake',
    options: { inner: 10, cutoff: 12, kspaceAccuracy: 1e-6, cmapFile: '' },
    fields: ['inner', 'cutoff', 'kspaceAccuracy', 'cmapFile', 'styles', 'extraLines'],
    defaults: { temperature: 300, pressure: 1, lengths: BIO_LENGTHS, restraintK: RESTRAINT_K.real },
    sources: [REF.bioff, REF.pairCharmm, REF.dihedralCharmm, REF.mackerell]
  },
  {
    id: 'amber', label: 'AMBER (ff14SB, ff19SB, GAFF)', family: 'Biomolecular',
    units: 'real', atomStyle: 'full', source: 'data',
    summary: 'AMBER force fields converted to a LAMMPS data file: 10 Å cut-off with PPPM, long-range dispersion correction, 1-4 pairs scaled by 1/2 (LJ) and 5/6 (Coulomb).',
    url: doc('Howto_bioFF'),
    styles: { bond: 'harmonic', angle: 'harmonic', dihedral: 'fourier', improper: 'cvff' },
    pair: { style: 'lj/cut/coul/long', restart: true },
    special: 'amber', mix: 'arithmetic', tail: true, shift: false,
    kspace: { style: 'pppm', accuracy: 1e-5 },
    dt: { constrained: 2, flexible: 1 }, constraints: 'shake',
    options: { cutoff: 10, kspaceAccuracy: 1e-5 },
    fields: ['cutoff', 'kspaceAccuracy', 'styles', 'extraLines'],
    defaults: { temperature: 300, pressure: 1, lengths: BIO_LENGTHS, restraintK: RESTRAINT_K.real },
    sources: [REF.bioff, REF.pairLjCutCoul, REF.specialBonds, REF.cornell, REF.ff14sb]
  },
  {
    id: 'opls', label: 'OPLS-AA', family: 'Biomolecular',
    units: 'real', atomStyle: 'full', source: 'data',
    summary: 'OPLS-AA (moltemplate, LigParGen, fftool): 11 Å cut-off with PPPM and tail correction, geometric mixing, 1-4 pairs scaled by 1/2.',
    url: doc('dihedral_opls'),
    styles: { bond: 'harmonic', angle: 'harmonic', dihedral: 'opls', improper: 'harmonic' },
    pair: { style: 'lj/cut/coul/long', restart: true },
    special: 'lj/coul 0.0 0.0 0.5', mix: 'geometric', tail: true, shift: false,
    kspace: { style: 'pppm', accuracy: 1e-5 },
    dt: { constrained: 2, flexible: 1 }, constraints: 'shake',
    options: { cutoff: 11, kspaceAccuracy: 1e-5 },
    fields: ['cutoff', 'kspaceAccuracy', 'styles', 'extraLines'],
    defaults: { temperature: 298.15, pressure: 1, lengths: BIO_LENGTHS, restraintK: RESTRAINT_K.real },
    sources: [REF.pairLjCutCoul, REF.specialBonds, REF.pairModify, REF.opls]
  },
  {
    id: 'class2', label: 'COMPASS / PCFF (class II)', family: 'Biomolecular',
    units: 'real', atomStyle: 'full', source: 'data',
    summary: 'Class II force fields from msi2lmp: 9-6 Lennard-Jones with sixth-power mixing, cross terms in the bonded styles, 1-4 pairs at full strength.',
    url: doc('pair_class2'),
    styles: { bond: 'class2', angle: 'class2', dihedral: 'class2', improper: 'class2' },
    pair: { style: 'lj/class2/coul/long', restart: true },
    special: 'lj/coul 0.0 0.0 1.0', mix: null, tail: true, shift: false,
    kspace: { style: 'pppm', accuracy: 1e-5 },
    dt: { constrained: 1, flexible: 1 }, constraints: 'none',
    options: { cutoff: 9.5, kspaceAccuracy: 1e-5 },
    fields: ['cutoff', 'kspaceAccuracy', 'styles', 'extraLines'],
    defaults: { temperature: 298.15, pressure: 1, lengths: BIO_LENGTHS, restraintK: RESTRAINT_K.real },
    sources: [REF.bioff, REF.pairClass2, REF.compass]
  },
  {
    id: 'tip3p', label: 'Water: TIP3P', family: 'Water',
    units: 'real', atomStyle: 'full', source: 'data',
    summary: 'A box of TIP3P water (Jorgensen 1983), rigid with SHAKE: the model\'s charges and Lennard-Jones parameters are written into the input.',
    url: doc('Howto_tip3p'),
    styles: { bond: 'harmonic', angle: 'harmonic', dihedral: null, improper: null },
    pair: { style: 'lj/cut/coul/long', restart: true },
    special: null, mix: 'arithmetic', tail: true, shift: false,
    kspace: { style: 'pppm', accuracy: 1e-5 },
    dt: { constrained: 2, flexible: 1 }, constraints: 'shake',
    water: { model: 'TIP3P', qO: -0.834, qH: 0.417, epsO: 0.1521, sigO: 3.1507, epsH: 0, sigH: 1.0, r0: 0.9572, theta0: 104.52, kBond: 450, kAngle: 55 },
    options: { cutoff: 10, kspaceAccuracy: 1e-5 },
    fields: ['cutoff', 'kspaceAccuracy', 'waterTypes', 'extraLines'],
    defaults: { temperature: 298.15, pressure: 1, lengths: { nvt: [20, 'ps'], npt: [100, 'ps'], prod: [10, 'ns'] }, restraintK: RESTRAINT_K.real },
    sources: [REF.tip3pHowto, REF.tip3p, REF.pairLjCutCoul]
  },
  {
    id: 'spce', label: 'Water: SPC/E', family: 'Water',
    units: 'real', atomStyle: 'full', source: 'data',
    summary: 'A box of SPC/E water (Berendsen 1987), rigid with SHAKE: the model\'s charges and Lennard-Jones parameters are written into the input.',
    url: doc('Howto_spc'),
    styles: { bond: 'harmonic', angle: 'harmonic', dihedral: null, improper: null },
    pair: { style: 'lj/cut/coul/long', restart: true },
    special: null, mix: 'arithmetic', tail: true, shift: false,
    kspace: { style: 'pppm', accuracy: 1e-5 },
    dt: { constrained: 2, flexible: 1 }, constraints: 'shake',
    water: { model: 'SPC/E', qO: -0.8476, qH: 0.4238, epsO: 0.1553, sigO: 3.166, epsH: 0, sigH: 1.0, r0: 1.0, theta0: 109.47, kBond: 450, kAngle: 55 },
    options: { cutoff: 10, kspaceAccuracy: 1e-5 },
    fields: ['cutoff', 'kspaceAccuracy', 'waterTypes', 'extraLines'],
    defaults: { temperature: 298.15, pressure: 1, lengths: { nvt: [20, 'ps'], npt: [100, 'ps'], prod: [10, 'ns'] }, restraintK: RESTRAINT_K.real },
    sources: [REF.spcHowto, REF.spce, REF.pairLjCutCoul]
  },
  {
    id: 'tip4p2005', label: 'Water: TIP4P/2005', family: 'Water',
    units: 'real', atomStyle: 'full', source: 'data',
    summary: 'A box of TIP4P/2005 water (Abascal and Vega 2005) with the massless M site handled by lj/cut/tip4p/long and pppm/tip4p, rigid with SHAKE.',
    url: doc('Howto_tip4p'),
    styles: { bond: 'harmonic', angle: 'harmonic', dihedral: null, improper: null },
    pair: { style: 'lj/cut/tip4p/long', restart: true },
    special: null, mix: 'arithmetic', tail: true, shift: false,
    kspace: { style: 'pppm/tip4p', accuracy: 1e-5 },
    dt: { constrained: 2, flexible: 1 }, constraints: 'shake',
    water: { model: 'TIP4P/2005', qO: -1.1128, qH: 0.5564, epsO: 0.1852, sigO: 3.1589, epsH: 0, sigH: 1.0, r0: 0.9572, theta0: 104.52, kBond: 450, kAngle: 55, om: 0.1546 },
    options: { cutoff: 8.5, kspaceAccuracy: 1e-5 },
    fields: ['cutoff', 'kspaceAccuracy', 'waterTypes', 'extraLines'],
    defaults: { temperature: 298.15, pressure: 1, lengths: { nvt: [20, 'ps'], npt: [100, 'ps'], prod: [10, 'ns'] }, restraintK: RESTRAINT_K.real },
    sources: [REF.tip4pHowto, REF.pairTip4p, REF.tip4p2005]
  },
  {
    id: 'eam', label: 'Metal: EAM (funcfl, one element)', family: 'Materials',
    units: 'metal', atomStyle: 'atomic', source: 'lattice',
    summary: 'A pure metal with an embedded-atom potential in the single-element funcfl format (Cu_u3.eam and the other *.eam files of lammps/potentials).',
    url: doc('pair_eam'),
    styles: null, pair: { style: 'eam', restart: false },
    special: null, mix: null, tail: false, shift: false, kspace: null,
    dt: { constrained: 0.001, flexible: 0.001 }, constraints: 'none',
    options: { potentialFile: 'Cu_u3.eam', elements: 'Cu' },
    fields: ['potentialFile', 'extraLines'],
    lattice: { style: 'fcc', constant: 3.615, cells: [10, 10, 10], element: 'Cu' },
    defaults: { temperature: 300, pressure: 1, lengths: MATERIAL_LENGTHS, restraintK: RESTRAINT_K.metal },
    sources: [REF.pairEam, REF.dawBaskes, REF.foiles]
  },
  {
    id: 'eam/alloy', label: 'Metal: EAM alloy (setfl)', family: 'Materials',
    units: 'metal', atomStyle: 'atomic', source: 'lattice',
    summary: 'Metals and alloys with an embedded-atom potential in the setfl format (*.eam.alloy): pair_coeff names the element of each atom type.',
    url: doc('pair_eam'),
    styles: null, pair: { style: 'eam/alloy', restart: false },
    special: null, mix: null, tail: false, shift: false, kspace: null,
    dt: { constrained: 0.001, flexible: 0.001 }, constraints: 'none',
    options: { potentialFile: 'Cu_mishin1.eam.alloy', elements: 'Cu' },
    fields: ['potentialFile', 'elements', 'extraLines'],
    lattice: { style: 'fcc', constant: 3.615, cells: [10, 10, 10], element: 'Cu' },
    defaults: { temperature: 300, pressure: 1, lengths: MATERIAL_LENGTHS, restraintK: RESTRAINT_K.metal },
    sources: [REF.pairEam, REF.dawBaskes, REF.mishin]
  },
  {
    id: 'eam/fs', label: 'Metal: Finnis-Sinclair EAM (eam/fs)', family: 'Materials',
    units: 'metal', atomStyle: 'atomic', source: 'lattice',
    summary: 'Metals with a Finnis-Sinclair embedded-atom potential (*.eam.fs), such as the Mendelev potentials for iron.',
    url: doc('pair_eam'),
    styles: null, pair: { style: 'eam/fs', restart: false },
    special: null, mix: null, tail: false, shift: false, kspace: null,
    dt: { constrained: 0.001, flexible: 0.001 }, constraints: 'none',
    options: { potentialFile: 'Fe_mm.eam.fs', elements: 'Fe' },
    fields: ['potentialFile', 'elements', 'extraLines'],
    lattice: { style: 'bcc', constant: 2.8553, cells: [10, 10, 10], element: 'Fe' },
    defaults: { temperature: 300, pressure: 1, lengths: MATERIAL_LENGTHS, restraintK: RESTRAINT_K.metal },
    sources: [REF.pairEam, REF.finnisSinclair, REF.mendelev]
  },
  {
    id: 'tersoff', label: 'Covalent crystal: Tersoff', family: 'Materials',
    units: 'metal', atomStyle: 'atomic', source: 'lattice',
    summary: 'Silicon, carbon, germanium and their compounds with a Tersoff bond-order potential (Si.tersoff, SiC.tersoff, ...).',
    url: doc('pair_tersoff'),
    styles: null, pair: { style: 'tersoff', restart: false },
    special: null, mix: null, tail: false, shift: false, kspace: null,
    dt: { constrained: 0.001, flexible: 0.001 }, constraints: 'none',
    options: { potentialFile: 'Si.tersoff', elements: 'Si' },
    fields: ['potentialFile', 'elements', 'extraLines'],
    lattice: { style: 'diamond', constant: 5.431, cells: [6, 6, 6], element: 'Si' },
    defaults: { temperature: 300, pressure: 1, lengths: MATERIAL_LENGTHS, restraintK: RESTRAINT_K.metal },
    sources: [REF.pairTersoff, REF.tersoff]
  },
  {
    id: 'sw', label: 'Covalent crystal: Stillinger-Weber', family: 'Materials',
    units: 'metal', atomStyle: 'atomic', source: 'lattice',
    summary: 'Silicon and other tetrahedral solids with the Stillinger-Weber three-body potential (Si.sw, ...).',
    url: doc('pair_sw'),
    styles: null, pair: { style: 'sw', restart: false },
    special: null, mix: null, tail: false, shift: false, kspace: null,
    dt: { constrained: 0.001, flexible: 0.001 }, constraints: 'none',
    options: { potentialFile: 'Si.sw', elements: 'Si' },
    fields: ['potentialFile', 'elements', 'extraLines'],
    lattice: { style: 'diamond', constant: 5.431, cells: [6, 6, 6], element: 'Si' },
    defaults: { temperature: 300, pressure: 1, lengths: MATERIAL_LENGTHS, restraintK: RESTRAINT_K.metal },
    sources: [REF.pairSw, REF.stillingerWeber]
  },
  {
    id: 'reaxff', label: 'Reactive: ReaxFF with QEq charges', family: 'Reactive',
    units: 'real', atomStyle: 'charge', source: 'data',
    summary: 'Bond breaking and forming with ReaxFF; charges re-equilibrated every step by fix qeq/reaxff. Short time steps (0.25 fs).',
    url: doc('pair_reaxff'),
    styles: null, pair: { style: 'reaxff', restart: false },
    special: null, mix: null, tail: false, shift: false, kspace: null,
    dt: { constrained: 0.25, flexible: 0.25 }, constraints: 'none',
    options: { potentialFile: 'ffield.reax', elements: 'C H O N', controlFile: 'NULL', qeqTolerance: 1e-6 },
    fields: ['potentialFile', 'elements', 'controlFile', 'qeqTolerance', 'extraLines'],
    defaults: { temperature: 300, pressure: 1, lengths: { nvt: [5, 'ps'], npt: [10, 'ps'], prod: [100, 'ps'] }, restraintK: RESTRAINT_K.real },
    sources: [REF.pairReaxff, REF.qeqReaxff, REF.vanDuin, REF.aktulga]
  },
  {
    id: 'lj', label: 'Lennard-Jones fluid (reduced units)', family: 'Model',
    units: 'lj', atomStyle: 'atomic', source: 'lattice',
    summary: 'Atoms interacting by a Lennard-Jones potential cut at 2.5 σ, in reduced units (σ, ε, m and τ), as in the LAMMPS melt example.',
    url: doc('pair_lj'),
    styles: null, pair: { style: 'lj/cut', restart: true },
    special: null, mix: null, tail: false, shift: false, kspace: null,
    dt: { constrained: 0.005, flexible: 0.005 }, constraints: 'none',
    options: { cutoff: 2.5, epsilon: 1.0, sigma: 1.0, mass: 1.0, ljTail: false, ljShift: false },
    fields: ['cutoff', 'ljTail', 'ljShift', 'extraLines'],
    lattice: { style: 'fcc', constant: 0.8442, cells: [10, 10, 10], element: '' },
    defaults: { temperature: 1.0, pressure: 1.0, lengths: { nvt: [50, 'tau'], npt: [100, 'tau'], prod: [1000, 'tau'] }, restraintK: RESTRAINT_K.lj },
    sources: [REF.pairLj, REF.melt]
  },
  {
    id: 'custom', label: 'My own force-field lines', family: 'Your own',
    units: 'real', atomStyle: 'full', source: 'data',
    summary: 'Your own units, styles and coefficients, pasted as they are. Style lines go before the data file is read; everything else into in.settings, which every stage reads.',
    url: doc('Commands_all'),
    styles: null, pair: { style: '', restart: true },
    special: null, mix: null, tail: false, shift: false, kspace: null,
    dt: { constrained: 2, flexible: 1 }, constraints: 'none',
    options: { lines: '' },
    fields: ['lines', 'units', 'atomStyle'],
    defaults: { temperature: 300, pressure: 1, lengths: BIO_LENGTHS, restraintK: RESTRAINT_K.real },
    sources: [REF.units, REF.readData]
  }
]);

/** The presets by id. */
export const LMP_FORCE_FIELD = deepFreeze(Object.fromEntries(LMP_FORCE_FIELDS.map(f => [f.id, f])));

/**
 * Pair styles whose restart data LAMMPS does not write (restartinfo = 0 in
 * the source): read_restart then leaves no pair style, so it must be given
 * again with its coefficients. Matched on the style as written, without an
 * accelerator suffix.
 */
export const NO_RESTART_PAIR = /^(hybrid|hybrid\/overlay|hybrid\/scaled|eam(\/.*)?|tersoff(\/.*)?|sw(\/.*)?|reaxff|reax\/c|meam(\/.*)?|snap|mliap|pace|airebo(\/.*)?|rebo|comb3?|bop|edip(\/.*)?|vashishta(\/.*)?|table|adp|polymorphic|extep|lcbop|nb3b(\/.*)?|threebody\/table|gw(\/.*)?|tersoff\/mod|smtbq|kim|lj\/smooth\/linear\/omp_x)$/;

/* ------------------------------------------------------------------ *
 * Thermostats and barostats
 * ------------------------------------------------------------------ */

/** Thermostats the builder offers. `productionOk` false: equilibration only. */
export const LMP_THERMOSTATS = deepFreeze([
  { id: 'nose-hoover', label: 'Nosé-Hoover chain (fix nvt / npt)', fix: 'nvt', productionOk: true, url: doc('fix_nh'),
    summary: 'Deterministic, samples the canonical ensemble; a chain of three thermostats by default. Can oscillate when started far from the target temperature.' },
  { id: 'csvr', label: 'Stochastic velocity rescaling (fix temp/csvr + nve)', fix: 'temp/csvr', productionOk: true, url: doc('fix_temp_csvr'),
    summary: 'Bussi-Donadio-Parrinello: canonical ensemble, robust from the first step, gentle on the dynamics. Needs the EXTRA-FIX package.' },
  { id: 'langevin', label: 'Langevin (fix langevin + nve)', fix: 'langevin', productionOk: true, url: doc('fix_langevin'),
    summary: 'Friction and random kicks on every atom: canonical and very robust, but it slows diffusion and other dynamics in proportion to the friction.' },
  { id: 'berendsen', label: 'Berendsen (fix temp/berendsen + nve), equilibration only', fix: 'temp/berendsen', productionOk: false, url: doc('fix_temp_berendsen'),
    summary: 'Scales velocities towards the target: fast and stable, but it suppresses the kinetic-energy fluctuations, so the ensemble is wrong. Use it to equilibrate only.' }
]);

/** Barostats the builder offers. */
export const LMP_BAROSTATS = deepFreeze([
  { id: 'mtk', label: 'Martyna-Tobias-Klein (fix npt / nph)', productionOk: true, url: doc('fix_nh'),
    summary: 'The Nosé-Hoover barostat with the MTK correction: samples the isothermal-isobaric ensemble. Volume oscillates if the box starts far from equilibrium.' },
  { id: 'berendsen', label: 'Berendsen (fix press/berendsen), equilibration only', productionOk: false, url: doc('fix_press_berendsen'),
    summary: 'Scales the box towards the target pressure: robust far from equilibrium, but the volume fluctuations are wrong. Use it to equilibrate only. Needs the bulk modulus.' }
]);

/** How the box responds to pressure. */
export const LMP_COUPLINGS = deepFreeze([
  { id: 'iso', label: 'Isotropic', summary: 'x, y and z scale together under the hydrostatic pressure: liquids and solutions.' },
  { id: 'aniso', label: 'Anisotropic (x, y, z apart)', summary: 'x, y and z each follow their own diagonal pressure: crystals whose cell edges may change differently.' },
  { id: 'tri', label: 'Fully flexible (triclinic)', summary: 'Edges and tilt angles all change: crystals that may shear. Needs a triclinic box and fix npt (not Berendsen).' },
  { id: 'membrane', label: 'Membrane (x and y together, z apart)', summary: 'The bilayer plane (x, y) scales as one and the normal (z) on its own, as GROMACS semi-isotropic coupling does.' }
]);

/** Trajectory formats; `package` is what LAMMPS needs for the dump style. */
export const LMP_DUMP_FORMATS = deepFreeze([
  { id: 'custom', label: 'Text, custom columns (.lammpstrj)', style: 'custom', ext: 'lammpstrj', package: null, append: true,
    summary: 'Readable text that OVITO and VMD open; the columns are chosen here. Large: about 60 bytes per atom per frame.' },
  { id: 'atom', label: 'Text, atom style (.lammpstrj)', style: 'atom', ext: 'lammpstrj', package: null, append: true,
    summary: 'id, type and scaled coordinates with image flags: the classic LAMMPS dump.' },
  { id: 'dcd', label: 'DCD (CHARMM/NAMD binary)', style: 'dcd', ext: 'dcd', package: 'EXTRA-DUMP', append: false,
    summary: 'Binary single precision, 12 bytes per atom per frame; VMD and MDAnalysis read it. Needs the EXTRA-DUMP package.' },
  { id: 'xtc', label: 'XTC (GROMACS compressed)', style: 'xtc', ext: 'xtc', package: 'EXTRA-DUMP', append: false,
    summary: 'Compressed to 0.001 nm, about 4 bytes per atom per frame; GROMACS tools, MDAnalysis and VMD read it. Needs the EXTRA-DUMP package.' },
  { id: 'none', label: 'No trajectory', style: null, ext: '', package: null, append: true, summary: 'Thermodynamic output and restart files only.' }
]);

/** Minimisers the builder offers (min_style). */
export const LMP_MIN_STYLES = deepFreeze([
  { id: 'cg', label: 'Conjugate gradient (cg)', boxRelax: true, summary: 'Polak-Ribière conjugate gradient, LAMMPS\'s default and the most efficient for most systems.' },
  { id: 'sd', label: 'Steepest descent (sd)', boxRelax: true, summary: 'Slower than cg but sometimes more robust for badly overlapping atoms.' },
  { id: 'fire', label: 'FIRE (damped dynamics)', boxRelax: false, summary: 'Damped dynamics with an adaptive step: robust for strained or overlapping structures; no box relaxation.' }
]);

/**
 * The preset settings the page can show (a preset's `fields`), with a
 * label, the kind of input, the unit (in the preset's units) and a line of
 * help. `units` is filled in by the units style: '{distance}' and the like.
 */
export const LMP_FF_FIELDS = deepFreeze({
  inner: { label: 'LJ switching starts at', kind: 'number', unit: '{distance}', help: 'Where the CHARMM switching function starts; 2 Å below the cut-off is usual.' },
  cutoff: { label: 'Cut-off', kind: 'number', unit: '{distance}', help: 'Lennard-Jones (and real-space Coulomb) cut-off.' },
  kspaceAccuracy: { label: 'PPPM accuracy', kind: 'number', unit: '', help: 'Relative error of the long-range forces: 1e-4 is LAMMPS\'s usual example value, 1e-6 what CHARMM-GUI writes.' },
  cmapFile: { label: 'CMAP file', kind: 'file', unit: '', help: 'The CMAP grids for CHARMM proteins (charmm36.cmap in lammps/potentials). Needed when the data file lists crossterms.' },
  potentialFile: { label: 'Potential file', kind: 'file', unit: '', help: 'The file pair_coeff reads, copied next to the inputs (lammps/potentials has many).' },
  elements: { label: 'Elements by atom type', kind: 'text', unit: '', help: 'One element per atom type, in type order, as named in the potential file (e.g. "Cu Ni").' },
  controlFile: { label: 'ReaxFF control file', kind: 'file', unit: '', help: 'NULL for ReaxFF\'s defaults, or the name of a control file.' },
  qeqTolerance: { label: 'QEq tolerance', kind: 'number', unit: '', help: 'Convergence of the charge equilibration; 1e-6 as in the LAMMPS examples.' },
  ljTail: { label: 'Tail correction', kind: 'boolean', unit: '', help: 'Add the Lennard-Jones energy and pressure beyond the cut-off.' },
  ljShift: { label: 'Shift to zero at the cut-off', kind: 'boolean', unit: '', help: 'Remove the energy jump at the cut-off.' },
  styles: { label: 'Bonded styles', kind: 'styles', unit: '', help: 'The bond, angle, dihedral and improper styles your data file was written for.' },
  waterTypes: { label: 'Water types', kind: 'types', unit: '', help: 'Oxygen and hydrogen atom types, and the O-H bond and H-O-H angle types; found in the data file when one is loaded.' },
  extraLines: { label: 'Extra lines', kind: 'lines', unit: '', help: 'Lines every stage reads after the system is loaded, such as pair_coeff lines the data file lacks.' },
  lines: { label: 'Your force-field lines', kind: 'lines', unit: '', help: 'units, atom_style, styles, coefficients and kspace, as you would write them.' },
  units: { label: 'Units', kind: 'select', unit: '', help: 'The units style, when your lines do not say.' },
  atomStyle: { label: 'Atom style', kind: 'text', unit: '', help: 'The atom style, when your lines do not say.' }
});
