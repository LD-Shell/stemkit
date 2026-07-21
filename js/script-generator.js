/*
 * STEMKit — HPC Script Generator (SLURM + GROMACS/LAMMPS)
 * Author: Olanrewaju M. Daramola
 *
 * Client-side only. Generates SLURM batch scripts, a staged GROMACS workflow
 * (EM / NVT / NPT / Production with grompp->mdrun chaining), a GROMACS .top
 * header, and LAMMPS submission scripts.
 *
 * Correctness references (see on-page "Method & References"):
 *  - Force field <-> combination rule <-> fudge factors are coupled:
 *        AMBER    : comb 2, fudgeLJ 0.5, fudgeQQ 0.8333
 *        CHARMM36 : comb 2, fudgeLJ 1.0, fudgeQQ 1.0
 *        OPLS-AA  : comb 3, fudgeLJ 0.5, fudgeQQ 0.5
 *    (GROMACS manual + shipped forcefield.itp files.)
 *  - GROMACS staging: each grompp -c reads the previous stage .gro; -t reads
 *    the previous .cpt (continuation); -r supplies the restraint reference
 *    (often identical to -c) when position restraints are used.
 *  - GROMACS GPU offload: gmx mdrun -nb gpu -pme gpu -bonded gpu -update gpu.
 *  - GROMACS is threaded (set --cpus-per-task); LAMMPS is MPI-parallel
 *    (set --ntasks). LAMMPS GPU: -sf gpu -pk gpu N ; KOKKOS: -k on g N -sf kk.
 *  - #!/bin/bash -e so failures abort and show as FAILED in sacct.
 */

document.addEventListener('DOMContentLoaded', () => {

    const $ = (id) => document.getElementById(id);

    // =====================================================================
    // Canonical force-field parameter table
    // =====================================================================
    const FF_PRESETS = {
        'amber99sb-ildn': { label: 'AMBER99SB-ILDN', comb: '2', fudgeLJ: '0.5', fudgeQQ: '0.8333', family: 'amber' },
        'charmm36':       { label: 'CHARMM36',       comb: '2', fudgeLJ: '1.0', fudgeQQ: '1.0',    family: 'charmm' },
        'opls-aa':        { label: 'OPLS-AA',        comb: '3', fudgeLJ: '0.5', fudgeQQ: '0.5',    family: 'opls' }
    };

    // =====================================================================
    // Shared state
    // =====================================================================
    let currentEngine = 'gromacs'; // 'gromacs' | 'lammps' | 'plumed'
    let manualOverride = false;
    let plumedCVs = [];            // list of CV instances the user has added
    let plumedCVSeq = 0;

    // =====================================================================
    // PLUMED CV catalogue (verified against the colvar module source,
    // PLUMED v2.9). Each entry: label, category, a short doc string, and the
    // fields the user fills in. `tmpl` builds the plumed line from field vals.
    // =====================================================================
    const PLUMED_VERSION = '2.9';
    // Concise, source-derived help for PLUMED keywords (shown as ? tooltips).
    const PLUMED_KEY_HELP = {
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
        D_MAX: 'Distance beyond which the switching function is exactly zero. Setting it lets PLUMED use linked cells for neighbour search — a large speedup. Choose it a little above where the switch has decayed to ~0.',
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
        CUTOFF: 'Distance cutoff for the eRMSD contact calculation.',
        LOWER_CUTOFF: 'Ignore reference distances below this value (nm).',
        UPPER_CUTOFF: 'Ignore reference distances above this value (nm).'
    };

    const PLUMED_CATEGORIES = {
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

    // field types: 'atoms' (atom list), 'text', 'num', 'select', 'flag'
    const PLUMED_CV_DEFS = {
        GROUP: {
            cat: 'position', desc: 'Define a named atom group you can reuse in other CVs (by index list, an .ndx group, or another group).',
            isGroup: true,
            fields: [
                { k: 'ATOMS', label: 'ATOMS (list/range)', type: 'atoms', def: '', help: 'Atoms in the group (indices/ranges). Leave blank if you are loading from an index file instead.' },
                { k: 'NDX_FILE', label: 'NDX_FILE', type: 'text', def: '', help: 'GROMACS-style index file to read the group from, e.g. index.ndx.' },
                { k: 'NDX_GROUP', label: 'NDX_GROUP', type: 'text', def: '', help: 'Name of the group inside NDX_FILE, e.g. Protein or C-alpha.' }
            ]
        },
        COM: {
            cat: 'position', desc: 'Centre of mass of a group of atoms; use its label anywhere an atom is expected.',
            isGroup: true,
            fields: [
                { k: 'ATOMS', label: 'ATOMS', type: 'atoms', def: '1-100', required: true }
            ]
        },
        DISTANCE: {
            cat: 'geometry', desc: 'Distance between a pair of atoms (or two centres).',
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
        DIHCOR: {
            cat: 'angles', desc: 'Correlation between sets of dihedral angles.',
            fields: [
                { k: 'ATOMS', label: 'ATOMS (numbered sets)', type: 'text', def: 'ATOMS1=1,2,3,4,5,6', required: true }
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
                { k: 'D_MAX', label: 'D_MAX (nm)', type: 'num', def: '', help: 'Distance beyond which the switch is exactly zero. Setting it makes PLUMED use fast linked cells — an alternative to a neighbour list. Leave blank if you use NLIST instead.' },
                { k: 'NLIST', label: 'NLIST (neighbour list)', type: 'flag', def: false },
                { k: 'NL_CUTOFF', label: 'NL_CUTOFF (nm)', type: 'num', def: '' },
                { k: 'NL_STRIDE', label: 'NL_STRIDE (steps)', type: 'num', def: '' }
            ]
        },
        CONTACTMAP: {
            cat: 'contacts', desc: 'Distances for many atom pairs, each through a switching function.',
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
                { k: 'I', label: 'I (ionic strength, M)', type: 'num', def: '0.1' },
                { k: 'TEMP', label: 'TEMP (K)', type: 'num', def: '300' }
            ]
        },
        POSITION: {
            cat: 'position', desc: 'Position (x,y,z) of an atom or centre.',
            fields: [
                { k: 'ATOM', label: 'ATOM', type: 'atoms', def: '1', required: true },
                { k: 'NOPBC', label: 'NOPBC', type: 'flag', def: false }
            ]
        },
        CELL: {
            cat: 'position', desc: 'Components of the simulation cell.',
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
                { k: 'UPPER_CUTOFF', label: 'UPPER_CUTOFF (nm)', type: 'num', def: '0.8' }
            ]
        },
        PATHMSD: {
            cat: 'rmsd', desc: 'Path collective variables (progress s and distance z along a path).',
            fields: [
                { k: 'REFERENCE', label: 'REFERENCE (.pdb)', type: 'text', def: 'path.pdb', required: true },
                { k: 'LAMBDA', label: 'LAMBDA', type: 'num', def: '500', required: true }
            ]
        },
        PUCKERING: {
            cat: 'nucleic', desc: 'Sugar-ring pseudorotation coordinates (5- or 6-membered rings).',
            fields: [
                { k: 'ATOMS', label: 'ATOMS (5 or 6, in order)', type: 'atoms', def: '1,2,3,4,5,6', required: true }
            ]
        },
        ERMSD: {
            cat: 'nucleic', desc: 'eRMSD for nucleic-acid structures vs a reference.',
            fields: [
                { k: 'REFERENCE', label: 'REFERENCE (.pdb)', type: 'text', def: 'ref.pdb', required: true },
                { k: 'CUTOFF', label: 'CUTOFF', type: 'num', def: '2.4' }
            ]
        },
        Q6: {
            cat: 'order', desc: 'Steinhardt Q6 bond-orientational order parameter — the standard descriptor for crystalline vs liquid local structure.',
            switchSpeed: true,
            fields: [
                { k: 'SPECIES', label: 'SPECIES', type: 'atoms', def: '1-64', required: true, help: 'The atoms whose local environment (order parameter) is computed. Use SPECIESA/SPECIESB via CUSTOM for two-group variants.' },
                { k: 'R_0', label: 'R_0 (nm)', type: 'num', def: '0.25', required: true },
                { k: 'D_0', label: 'D_0 (nm)', type: 'num', def: '0.0', help: 'Offset of the switching function; the switch begins to decay at D_0.' },
                { k: 'D_MAX', label: 'D_MAX (nm)', type: 'num', def: '0.5', help: 'Distance beyond which the switch is exactly zero. Setting it enables linked-cell neighbour search — a large speedup. Set it a bit above where the switch has decayed to ~0.' },
                { k: 'MEAN', label: 'MEAN', type: 'flag', def: true, help: 'Output the mean of the per-atom Q6 values (a single scalar CV).' },
                { k: 'VMEAN', label: 'VMEAN', type: 'flag', def: false, help: 'Output the norm of the mean Steinhardt vector.' }
            ]
        },
        Q4: {
            cat: 'order', desc: 'Steinhardt Q4 bond-orientational order parameter — distinguishes cubic/FCC-like local order.',
            switchSpeed: true,
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
            switchSpeed: true,
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
            switchSpeed: true,
            fields: [
                { k: 'SPECIES', label: 'SPECIES', type: 'atoms', def: '1-100', required: true },
                { k: 'R_0', label: 'R_0 (nm)', type: 'num', def: '0.3', required: true },
                { k: 'D_0', label: 'D_0 (nm)', type: 'num', def: '0.0' },
                { k: 'D_MAX', label: 'D_MAX (nm)', type: 'num', def: '0.6', help: 'Distance beyond which the switch is exactly zero; enables linked-cell speedup.' },
                { k: 'MEAN', label: 'MEAN', type: 'flag', def: true }
            ]
        },
        CUSTOM: {
            cat: 'custom', desc: 'Write any PLUMED action line yourself — the label is added automatically. Use this for CVs not in the catalogue, MATHEVAL/CUSTOM combinations, or advanced options.',
            isCustom: true,
            fields: [
                { k: '__raw', label: 'Full action (after the label)', type: 'text', def: 'DISTANCE ATOMS=1,2', required: true,
                  help: 'Everything after "label:". Example: COORDINATION GROUPA=1-10 GROUPB=20-40 R_0=0.3 NLIST NL_CUTOFF=0.5 NL_STRIDE=100' }
            ]
        }
    };

    // Bias / enhanced-sampling methods, categorised. Keywords verified against
    // the PLUMED bias module source (Restraint, MovingRestraint, WallsScalar,
    // MetaD, PBMetaD, ABMD).
    const PLUMED_BIAS_CATEGORIES = {
        'none':    'None — track only',
        'metad':   'Metadynamics family',
        'restraint':'Restraints & walls'
    };
    // Each bias method exposes editable parameters. `perCV: true` params take
    // one value per biased CV (the tool repeats/joins them). Tooltips are
    // condensed from the PLUMED bias-module source.
    const PLUMED_BIAS_DEFS = {
        none:      { cat: 'none',  label: 'None (track CVs only)', params: [] },
        metad: { cat: 'metad', label: 'Metadynamics (standard)', params: [
            { k: 'HEIGHT', label: 'HEIGHT', def: '1.2', help: 'Height of the Gaussian hills, in energy units. Larger hills fill the surface faster but converge less precisely.' },
            { k: 'SIGMA', label: 'SIGMA', def: '0.1', perCV: true, help: 'Width of the Gaussian hills for each CV. Set to roughly 1/2–1/3 of the CV fluctuations in an unbiased run.' },
            { k: 'PACE', label: 'PACE', def: '500', help: 'How often (in MD steps) a hill is deposited. Smaller = more frequent, faster filling but more overhead.' }
        ]},
        wt_metad: { cat: 'metad', label: 'Well-Tempered Metadynamics', params: [
            { k: 'HEIGHT', label: 'HEIGHT', def: '1.2', help: 'Initial hill height (energy units). In well-tempered MetaD the height is progressively scaled down.' },
            { k: 'SIGMA', label: 'SIGMA', def: '0.1', perCV: true, help: 'Gaussian width per CV. Set to ~1/2–1/3 of the CV fluctuations in an unbiased run.' },
            { k: 'PACE', label: 'PACE', def: '500', help: 'Steps between hill deposition.' },
            { k: 'BIASFACTOR', label: 'BIASFACTOR', def: '10', help: 'Well-tempered bias factor γ. Higher = explores higher free-energy barriers; typical range 5–20. Needs TEMP.' },
            { k: 'TEMP', label: 'TEMP (K)', def: '300', help: 'System temperature. Required for well-tempered metadynamics.' }
        ]},
        pbmetad: { cat: 'metad', label: 'Parallel-Bias Metadynamics (PBMETAD)', params: [
            { k: 'HEIGHT', label: 'HEIGHT', def: '1.2', help: 'Initial hill height (energy units).' },
            { k: 'SIGMA', label: 'SIGMA', def: '0.1', perCV: true, help: 'Gaussian width per CV; PBMETAD keeps one 1-D bias per CV.' },
            { k: 'PACE', label: 'PACE', def: '500', help: 'Steps between hill deposition.' },
            { k: 'BIASFACTOR', label: 'BIASFACTOR', def: '10', help: 'Well-tempered bias factor γ (typical 5–20).' },
            { k: 'TEMP', label: 'TEMP (K)', def: '300', help: 'System temperature.' }
        ]},
        opes: { cat: 'metad', label: 'OPES (probability enhanced)', params: [
            { k: 'PACE', label: 'PACE', def: '500', help: 'How often (steps) a kernel is deposited.' },
            { k: 'BARRIER', label: 'BARRIER', def: '30', help: 'The largest free-energy barrier (energy units) you expect to cross. The single most important OPES setting — set it a bit above your estimated barrier.' },
            { k: 'SIGMA', label: 'SIGMA', def: '0.15', perCV: true, help: 'Initial kernel width per CV. OPES can adapt this automatically if you leave the default.' },
            { k: 'TEMP', label: 'TEMP (K)', def: '300', help: 'System temperature.' }
        ]},
        restraint: { cat: 'restraint', label: 'Harmonic RESTRAINT (umbrella)', params: [
            { k: 'AT', label: 'AT', def: '0.0', perCV: true, help: 'The centre of the restraint for each CV — the value it is pulled toward.' },
            { k: 'KAPPA', label: 'KAPPA', def: '200', perCV: true, help: 'Harmonic force constant per CV (energy per CV-unit²). Larger = stiffer restraint.' },
            { k: 'SLOPE', label: 'SLOPE', def: '', perCV: true, help: 'Optional linear term per CV (energy per CV-unit); adds a constant force. Leave blank for a pure harmonic restraint.' }
        ]},
        moving: { cat: 'restraint', label: 'MOVINGRESTRAINT (steered MD)', params: [
            { k: 'STEP0', label: 'STEP0', def: '0', help: 'MD step at which the restraint takes the AT0/KAPPA0 values (the start of the pulling schedule).' },
            { k: 'AT0', label: 'AT0', def: '0.0', perCV: true, help: 'Restraint centre per CV at STEP0 (the starting position).' },
            { k: 'KAPPA0', label: 'KAPPA0', def: '0', perCV: true, help: 'Force constant per CV at STEP0. Often 0 so the pull ramps up.' },
            { k: 'STEP1', label: 'STEP1', def: '100000', help: 'MD step at which the restraint reaches the AT1/KAPPA1 values (end of the pull). Values are linearly interpolated between steps.' },
            { k: 'AT1', label: 'AT1', def: '1.0', perCV: true, help: 'Restraint centre per CV at STEP1 (the target position you steer toward).' },
            { k: 'KAPPA1', label: 'KAPPA1', def: '200', perCV: true, help: 'Force constant per CV at STEP1.' }
        ]},
        upper: { cat: 'restraint', label: 'UPPER_WALLS', params: [
            { k: 'AT', label: 'AT', def: '2.0', perCV: true, help: 'Position of the wall per CV. The potential is felt when the CV goes above this value.' },
            { k: 'KAPPA', label: 'KAPPA', def: '150', perCV: true, help: 'Force constant of the wall per CV (energy per CV-unit²).' },
            { k: 'EXP', label: 'EXP', def: '2', perCV: true, help: 'Exponent of the wall potential (2 = harmonic; higher = steeper/stiffer).' },
            { k: 'EPS', label: 'EPS', def: '1', perCV: true, help: 'Rescaling factor inside the wall expression (usually 1).' },
            { k: 'OFFSET', label: 'OFFSET', def: '0', perCV: true, help: 'Offset added to the wall position (shifts where the potential starts).' }
        ]},
        lower: { cat: 'restraint', label: 'LOWER_WALLS', params: [
            { k: 'AT', label: 'AT', def: '0.2', perCV: true, help: 'Position of the wall per CV. The potential is felt when the CV goes below this value.' },
            { k: 'KAPPA', label: 'KAPPA', def: '150', perCV: true, help: 'Force constant of the wall per CV (energy per CV-unit²).' },
            { k: 'EXP', label: 'EXP', def: '2', perCV: true, help: 'Exponent of the wall potential (2 = harmonic; higher = steeper).' },
            { k: 'EPS', label: 'EPS', def: '1', perCV: true, help: 'Rescaling factor inside the wall expression (usually 1).' },
            { k: 'OFFSET', label: 'OFFSET', def: '0', perCV: true, help: 'Offset added to the wall position.' }
        ]},
        abmd: { cat: 'restraint', label: 'ABMD (ratchet)', params: [
            { k: 'TO', label: 'TO', def: '0.0', perCV: true, help: 'Target value per CV the ratchet moves toward. The restraint only tightens as the CV approaches TO — it never pushes backward.' },
            { k: 'KAPPA', label: 'KAPPA', def: '50', perCV: true, help: 'Force constant per CV of the moving (ratchet) restraint.' },
            { k: 'NOISE', label: 'NOISE', def: '', perCV: true, help: 'Optional white-noise intensity per CV — effectively adds a temperature to the ABMD so it can occasionally relax backward. Leave blank for a strict ratchet.' }
        ]}
    };

    // Per-session store of user-edited bias parameter values, keyed by method.
    const plumedBiasVals = {};
    function biasVal(method, key) {
        const def = PLUMED_BIAS_DEFS[method];
        if (!def) return '';
        if (plumedBiasVals[method] && plumedBiasVals[method][key] !== undefined) return plumedBiasVals[method][key];
        const p = (def.params || []).find(p => p.k === key);
        return p ? p.def : '';
    }

    // =====================================================================
    // Helpers
    // =====================================================================
    function toggleVisibility(el, show) {
        if (!el) return;
        el.classList.toggle('hidden', !show);
        el.classList.toggle('flex', show);
    }

    function setWarnings(container, messages) {
        if (!container) return;
        if (!messages.length) {
            container.classList.add('hidden');
            container.innerHTML = '';
            return;
        }
        container.classList.remove('hidden');
        container.innerHTML = messages.map(m =>
            `<div class="flex items-start gap-2 text-[11px] leading-snug">
                <i class="fa-solid fa-triangle-exclamation mt-0.5 shrink-0"></i>
                <span>${m}</span>
             </div>`
        ).join('');
    }

    function isValidWallTime(t) {
        if (!t) return false;
        return /^(\d+-)?\d{1,2}:\d{2}:\d{2}$/.test(t)
            || /^\d{1,2}:\d{2}$/.test(t)
            || /^\d+$/.test(t);
    }

    function isValidArrayRange(r) {
        if (!r) return false;
        return /^\d+(-\d+)?(:\d+)?(,\d+(-\d+)?(:\d+)?)*(%\d+)?$/.test(r.trim());
    }

    function getInt(id, dflt) {
        const v = parseInt(($(id)?.value || ''), 10);
        return Number.isFinite(v) ? v : dflt;
    }
    function getStr(id, dflt) {
        const v = ($(id)?.value || '').trim();
        return v || dflt;
    }
    function isChecked(id) { return !!($(id) && $(id).checked); }

    // =====================================================================
    // SLURM header (shared, but resource model differs per engine)
    // =====================================================================
    function buildSlurmHeader(engine, warnings) {
        const jName  = getStr('jobName', 'md_job');
        const jNodes = getInt('jobNodes', 1);
        const jGpus  = getInt('jobGpus', 0);
        const jTime  = getStr('jobTime', '');
        const jMem   = getStr('jobMem', '');
        const cpus   = getInt('jobCpus', 1);       // GROMACS: threads/task
        const ntasks = getInt('jobTasks', 1);      // LAMMPS: MPI ranks/node

        let s = `#!/bin/bash -e\n`;
        s += `#SBATCH --job-name=${jName}\n`;

        if (isChecked('usePartition')) {
            const p = getStr('jobPartition', '');
            if (p) s += `#SBATCH --partition=${p}\n`;
        }

        s += `#SBATCH --nodes=${jNodes}\n`;

        if (engine === 'gromacs') {
            // Threaded: 1 task/node, many CPUs/task.
            s += `#SBATCH --ntasks-per-node=1\n`;
            s += `#SBATCH --cpus-per-task=${cpus}\n`;
        } else {
            // MPI: many tasks/node. For GPU, tasks usually == GPUs/node.
            s += `#SBATCH --ntasks-per-node=${ntasks}\n`;
            const lcpt = getInt('lmpCpus', 1);
            if (lcpt > 1) s += `#SBATCH --cpus-per-task=${lcpt}\n`;
        }

        if (jGpus > 0) s += `#SBATCH --gres=gpu:${jGpus}\n`;

        if (jMem) {
            s += `#SBATCH --mem=${jMem}\n`;
        } else {
            warnings.push('No memory requested. Most clusters then apply a small default (often ~1&nbsp;GB/CPU), which can kill MD jobs. Set a value for <code>--mem</code>.');
        }

        if (isValidWallTime(jTime)) {
            s += `#SBATCH --time=${jTime}\n`;
        } else {
            s += `#SBATCH --time=24:00:00\n`;
            warnings.push('Wall time looks malformed — expected <code>D-HH:MM:SS</code>, <code>HH:MM:SS</code>, or minutes. Substituted <code>24:00:00</code>.');
        }

        const isArray = isChecked('jobArrayToggle');
        if (isArray) {
            const r = getStr('jobArrayRange', '');
            if (isValidArrayRange(r)) {
                s += `#SBATCH --array=${r}\n`;
            } else {
                s += `#SBATCH --array=1-5\n`;
                warnings.push('Array range looks malformed — expected e.g. <code>1-10</code>, <code>1-100:2</code>. Substituted <code>1-5</code>.');
            }
            s += `#SBATCH --output=logs/%x_%A_%a.out\n`;
            s += `#SBATCH --error=logs/%x_%A_%a.err\n`;
        } else {
            s += `#SBATCH --output=logs/%x_%j.out\n`;
            s += `#SBATCH --error=logs/%x_%j.err\n`;
        }

        if (isChecked('useMail')) {
            const addr = getStr('jobMailUser', '');
            if (addr) {
                s += `#SBATCH --mail-user=${addr}\n`;
                s += `#SBATCH --mail-type=END,FAIL,TIME_LIMIT_80\n`;
            } else {
                warnings.push('Mail notifications enabled but no address given.');
            }
        }

        return { header: s, isArray };
    }

    function envBlock(engine) {
        let e = `\n# --- Environment ---\n`;
        e += `mkdir -p logs\n`;
        e += `module purge\n`;
        if (engine === 'gromacs') {
            e += `module load gromacs/2023   # adjust to your cluster's module name\n\n`;
            e += `# Match OpenMP threads to the CPUs Slurm granted.\n`;
            e += `export OMP_NUM_THREADS=\${SLURM_CPUS_PER_TASK:-1}\n`;
            e += `# Slurm > 22.05: also export for srun-launched steps.\n`;
            e += `export SRUN_CPUS_PER_TASK=\$SLURM_CPUS_PER_TASK\n\n`;
        } else {
            e += `module load lammps         # adjust to your cluster's module name\n\n`;
            e += `# LAMMPS is MPI-parallel; keep OpenMP off unless using USER-OMP/KOKKOS-OMP.\n`;
            e += `export OMP_NUM_THREADS=\${SLURM_CPUS_PER_TASK:-1}\n\n`;
        }
        return e;
    }

    // =====================================================================
    // GROMACS: GPU flag string from advanced toggles.
    // Encodes rules from the GROMACS "Getting good performance from mdrun"
    // guide. Returns { flags, warnings }.
    // =====================================================================
    function gmxGpuFlags() {
        const gpus = getInt('jobGpus', 0);
        if (gpus <= 0) return { flags: '', warnings: [] };

        const warnings = [];
        const nb     = isChecked('gpuNb');
        const pme    = isChecked('gpuPme');
        const bonded = isChecked('gpuBonded');
        const update = isChecked('gpuUpdate');
        const ntmpiStr = getStr('gpuNtmpi', '');
        const ntmpi = parseInt(ntmpiStr, 10);

        const flags = [];
        if (nb)     flags.push('-nb gpu');
        if (pme)    flags.push('-pme gpu');
        if (bonded) flags.push('-bonded gpu');
        if (update) flags.push('-update gpu');
        if (ntmpiStr) flags.push(`-ntmpi ${ntmpiStr}`);

        // Rule: bonded offload requires the short-range non-bonded task on GPU.
        if (bonded && !nb) {
            warnings.push('<code>-bonded gpu</code> requires the short-range non-bonded task on the GPU too. Enable <code>-nb gpu</code>.');
        }

        // Rule: PME on GPU supports only a single PME rank. If more than one
        // rank is requested, pin -npme 1 automatically.
        if (pme && Number.isFinite(ntmpi) && ntmpi > 1) {
            if (!flags.some(f => f.startsWith('-npme'))) {
                flags.push('-npme 1');
            }
            warnings.push('PME on GPU supports only one PME rank, so <code>-npme 1</code> was added automatically.');
        }

        // Note: GPU-resident mode (-update gpu) is incompatible with dynamic
        // load balancing and needs constraints = h-bonds.
        if (update) {
            warnings.push('GPU-resident mode (<code>-update gpu</code>) needs <code>constraints = h-bonds</code> in your .mdp and disables dynamic load balancing. For efficiency, use infrequent coupling and a larger <code>nstcalcenergy</code>.');
        }

        return { flags: flags.length ? ' ' + flags.join(' ') : '', warnings };
    }

    // =====================================================================
    // GROMACS staged workflow
    // =====================================================================
    // Stage definitions come from the DOM. Each stage row has:
    //   toggle checkbox (data-stage), mdp input, deffnm input, posres checkbox
    const GMX_STAGES = ['em', 'nvt', 'npt', 'prod'];

    function readStage(key) {
        return {
            key,
            enabled: isChecked(`stage_${key}_on`),
            mdp:     getStr(`stage_${key}_mdp`, `${key}.mdp`),
            deffnm:  getStr(`stage_${key}_deffnm`, key),
            posres:  isChecked(`stage_${key}_posres`)
        };
    }

    function generateGromacsScript() {
        const out = $('slurmOutput');
        if (!out) return;
        const warnings = [];

        const { header, isArray } = buildSlurmHeader('gromacs', warnings);
        let s = header;
        s += envBlock('gromacs');

        s += `# --- Execution ---\n`;

        if (isArray) {
            const baseDir = getStr('jobArrayDir', 'run_');
            s += `# One directory per array task.\n`;
            s += `SYSTEM_DIR="${baseDir}\${SLURM_ARRAY_TASK_ID}"\n`;
            s += `cd "\$SYSTEM_DIR" || { echo "Missing directory \$SYSTEM_DIR" >&2; exit 1; }\n\n`;
        }

        const topol = getStr('gmxTopol', 'topol.top');
        const startConf = getStr('gmxStartConf', 'system.gro');
        const ndx = getStr('gmxIndex', '');
        const ndxFlag = ndx ? ` -n ${ndx}` : '';
        const gpuResult = gmxGpuFlags();
        const gpuFlags = gpuResult.flags;
        gpuResult.warnings.forEach(w => { if (!warnings.includes(w)) warnings.push(w); });

        // Optional PLUMED coupling for GROMACS mdrun.
        const usePlumed = isChecked('gmxUsePlumed');
        const plumedFile = getStr('gmxPlumedFile', 'plumed.dat');
        const plumedScope = getStr('gmxPlumedScope', 'prod'); // 'prod' | 'all'

        const stages = GMX_STAGES.map(readStage).filter(st => st.enabled);

        if (!stages.length) {
            s += `# (No workflow stages enabled — enable EM/NVT/NPT/Production on the left.)\n`;
            out.textContent = s;
            setWarnings($('slurmWarnings'), warnings);
            return;
        }

        // Warn if a restrained stage lacks a prior coordinate source is fine;
        // but warn if production has restraints (unusual).
        stages.forEach(st => {
            if (st.key === 'prod' && st.posres) {
                warnings.push('Production stage has position restraints enabled — unusual; restraints are normally released for production.');
            }
        });

        let prev = null; // previous stage (for -c / -t wiring)
        stages.forEach((st, i) => {
            const tpr = `${st.deffnm}.tpr`;
            s += `# ---- ${st.key.toUpperCase()} ----\n`;

            // grompp: -c from previous stage .gro (or initial conf), -r for restraints,
            // -t from previous .cpt for continuation (NPT onward / production).
            let grompp = `gmx grompp -f ${st.mdp} -p ${topol}${ndxFlag}`;
            const cSource = prev ? `${prev.deffnm}.gro` : startConf;
            grompp += ` -c ${cSource}`;
            if (st.posres) grompp += ` -r ${cSource}`;   // restraint reference (often == -c)
            if (prev)      grompp += ` -t ${prev.deffnm}.cpt`; // continuation
            grompp += ` -o ${tpr}`;
            s += grompp + `\n`;

            // mdrun. Energy minimisation is not an MD integrator, so drop
            // -update gpu and the checkpoint restart there; keep -nb/-pme.
            let stageGpu = gpuFlags;
            if (st.key === 'em') {
                stageGpu = stageGpu.replace(' -update gpu', '');
            }
            let mdrun = `gmx mdrun -deffnm ${st.deffnm}${stageGpu} -pin on`;
            if (st.key !== 'em') {
                // -cpi allows a safe restart; harmless if the .cpt is absent.
                mdrun += ` -cpi ${st.deffnm}.cpt`;
            }
            // Optional PLUMED: attach to production only, or to every MD stage.
            if (usePlumed) {
                const attachHere = plumedScope === 'all'
                    ? (st.key !== 'em')       // all MD stages (not EM)
                    : (st.key === 'prod');    // production only
                if (attachHere) mdrun += ` -plumed ${plumedFile}`;
            }
            s += mdrun + `\n\n`;

            prev = st;
        });

        s += `echo "Workflow complete."\n`;

        out.textContent = s;
        setWarnings($('slurmWarnings'), warnings);
    }

    // =====================================================================
    // LAMMPS script
    // =====================================================================
    function generateLammpsScript() {
        const out = $('slurmOutput');
        if (!out) return;
        const warnings = [];

        const { header, isArray } = buildSlurmHeader('lammps', warnings);
        let s = header;
        s += envBlock('lammps');

        s += `# --- Execution ---\n`;

        if (isArray) {
            const baseDir = getStr('jobArrayDir', 'run_');
            s += `SYSTEM_DIR="${baseDir}\${SLURM_ARRAY_TASK_ID}"\n`;
            s += `cd "\$SYSTEM_DIR" || { echo "Missing directory \$SYSTEM_DIR" >&2; exit 1; }\n\n`;
        }

        const inFile = getStr('lmpInput', 'in.lammps');
        const logFile = getStr('lmpLog', 'log.lammps');
        const gpus = getInt('jobGpus', 0);
        const accel = getStr('lmpAccel', 'none'); // none | gpu | kokkos | intel | omp | opt
        const ompThreads = getInt('lmpCpus', 1); // cpus-per-task = OpenMP threads/rank

        let lmpArgs = `-in ${inFile} -log ${logFile}`;
        let note = '';

        switch (accel) {
            case 'gpu':
                // GPU package: -sf appends /gpu to supported styles; -pk sets GPUs/node.
                lmpArgs += ` -sf gpu -pk gpu ${gpus > 0 ? gpus : 1}`;
                note = '# GPU package: -sf gpu appends /gpu to supported styles; -pk gpu N sets GPUs/node.';
                if (gpus <= 0) warnings.push('GPU package selected but 0 GPUs requested. Set GPUs / Node &gt; 0.');
                break;
            case 'kokkos':
                // KOKKOS on GPU: typically one MPI rank per GPU.
                lmpArgs += ` -k on g ${gpus > 0 ? gpus : 1} -sf kk -pk kokkos`;
                note = '# KOKKOS (GPU): typically one MPI rank per GPU (-k on g N).';
                if (gpus <= 0) warnings.push('KOKKOS/GPU selected but 0 GPUs requested. Set GPUs / Node &gt; 0, or use the OPENMP package for CPU threading.');
                break;
            case 'intel':
                // INTEL package: vectorised CPU (and optional Phi offload).
                lmpArgs += ` -sf intel -pk intel 0`;
                note = '# INTEL package: -pk intel 0 = CPU only (use a nonzero value only for Xeon Phi offload). Your input may also need "package intel 0".';
                break;
            case 'omp':
                // OPENMP package: hybrid MPI + OpenMP. -pk omp N must match cpus-per-task.
                lmpArgs += ` -sf omp -pk omp ${ompThreads}`;
                note = '# OPENMP package: hybrid MPI x OpenMP. -pk omp N matches --cpus-per-task; benchmark 1/2/4 threads per rank.';
                if (ompThreads <= 1) {
                    warnings.push('OPENMP package with 1 thread/rank behaves like MPI-only. Set CPUs / Task &gt; 1 to use threading (2 is often optimal).');
                }
                break;
            case 'opt':
                // OPT package: templated CPU pair-style speedups (5-25%).
                lmpArgs += ` -sf opt`;
                note = '# OPT package: templated CPU pair styles (typically 5-25% faster). No -pk needed.';
                break;
            case 'none':
            default:
                if (gpus > 0) {
                    warnings.push('GPUs requested but no accelerator package selected. Choose <b>GPU</b> or <b>KOKKOS</b>, or set GPUs to 0.');
                }
                break;
        }

        if (note) s += note + `\n`;
        s += `srun lmp ${lmpArgs}\n`;
        s += `echo "LAMMPS run complete. Check the Performance line in ${logFile}."\n`;
        s += `# Tip: accelerating is not always faster. Benchmark task/thread/GPU\n`;
        s += `#      combinations for YOUR system and styles before production runs.\n`;

        out.textContent = s;
        setWarnings($('slurmWarnings'), warnings);
    }

    // =====================================================================
    // PLUMED: build a single CV line from an instance's field values
    // =====================================================================
    function buildCVLine(inst) {
        const def = PLUMED_CV_DEFS[inst.type];
        if (!def) return '';
        // Custom: the raw field IS the whole action after the label.
        if (def.isCustom) {
            const raw = (inst.values.__raw || '').trim();
            return `${inst.label}: ${raw}`;
        }
        const parts = [inst.type];
        // For order-parameter CVs, fold R_0/D_0/D_MAX into a single SWITCH={...}
        // block. Specifying D_MAX makes PLUMED use linked cells (large speedup).
        const switchKeys = def.switchSpeed ? ['R_0', 'D_0', 'D_MAX', 'NN', 'MM'] : [];
        if (def.switchSpeed) {
            const sw = [];
            switchKeys.forEach(k => {
                const v = inst.values[k];
                if (v !== undefined && String(v).trim() !== '') sw.push(`${k}=${String(v).trim()}`);
            });
            def.fields.forEach(f => {
                if (switchKeys.includes(f.k)) return; // handled in SWITCH block
                const val = inst.values[f.k];
                if (f.type === 'flag') { if (val) parts.push(f.k); }
                else if (val !== undefined && String(val).trim() !== '') parts.push(`${f.k}=${String(val).trim()}`);
            });
            if (sw.length) parts.push(`SWITCH={RATIONAL ${sw.join(' ')}}`);
            return `${inst.label}: ${parts.join(' ')}`;
        }
        // Two-group COORDINATION: when D_MAX is given, use a SWITCH={...} block
        // (enables linked cells); otherwise keep the bare R_0/NN/MM keywords.
        if (def.coordSwitch) {
            const useSwitch = inst.values.D_MAX !== undefined && String(inst.values.D_MAX).trim() !== '';
            const swKeys = ['R_0', 'D_0', 'NN', 'MM', 'D_MAX'];
            def.fields.forEach(f => {
                if (useSwitch && swKeys.includes(f.k)) return; // folded into SWITCH
                const val = inst.values[f.k];
                if (f.type === 'flag') { if (val) parts.push(f.k); }
                else if (val !== undefined && String(val).trim() !== '') parts.push(`${f.k}=${String(val).trim()}`);
            });
            if (useSwitch) {
                const sw = [];
                swKeys.forEach(k => {
                    const v = inst.values[k];
                    if (v !== undefined && String(v).trim() !== '') sw.push(`${k}=${String(v).trim()}`);
                });
                parts.push(`SWITCH={RATIONAL ${sw.join(' ')}}`);
            }
            return `${inst.label}: ${parts.join(' ')}`;
        }
        def.fields.forEach(f => {
            const val = inst.values[f.k];
            if (f.type === 'flag') {
                if (val) parts.push(f.k);
            } else if (val !== undefined && String(val).trim() !== '') {
                if (f.type === 'text' && /=|\{/.test(String(val)) && !/^[\d.,\-]+$/.test(String(val))) {
                    parts.push(String(val).trim());
                } else {
                    parts.push(`${f.k}=${String(val).trim()}`);
                }
            }
        });
        return `${inst.label}: ${parts.join(' ')}`;
    }

    function plumedWarningsForCV(inst, warnings) {
        const def = PLUMED_CV_DEFS[inst.type];
        if (!def) return;
        if (def.isCustom) {
            if (!inst.values.__raw || !inst.values.__raw.trim()) {
                warnings.push(`Custom CV (${inst.label}) is empty — type a PLUMED action.`);
            }
            return;
        }
        def.fields.forEach(f => {
            if (f.required) {
                const v = inst.values[f.k];
                if (v === undefined || String(v).trim() === '') {
                    warnings.push(`${inst.type} (${inst.label}) is missing required <code>${f.k}</code>.`);
                }
            }
        });
        if (inst.type === 'COORDINATION') {
            if (inst.values.NLIST && (!inst.values.NL_CUTOFF || !inst.values.NL_STRIDE)) {
                warnings.push('COORDINATION with <code>NLIST</code> requires both <code>NL_CUTOFF</code> and <code>NL_STRIDE</code> to be set.');
            }
            const hasDmax = inst.values.D_MAX && String(inst.values.D_MAX).trim() !== '';
            if (!hasDmax && !inst.values.NLIST) {
                warnings.push(`COORDINATION (${inst.label}) has no speed cutoff. Set <code>D_MAX</code> (linked cells) or enable <code>NLIST</code> with <code>NL_CUTOFF</code>/<code>NL_STRIDE</code>.`);
            }
        }
        if (def.switchSpeed && (!inst.values.D_MAX || String(inst.values.D_MAX).trim() === '')) {
            warnings.push(`${inst.type} (${inst.label}) has no <code>D_MAX</code>. Setting it enables linked-cell neighbour search &mdash; a large speedup for order parameters.`);
        }
    }

    // =====================================================================
    // PLUMED script generator (plumed.dat)
    // =====================================================================
    function generatePlumedScript() {
        const out = $('slurmOutput');
        if (!out) return;
        const warnings = [];

        const bias = getStr('plumedBias', 'none');
        const useGrid = isChecked('plumedGrid');
        const useRct  = isChecked('plumedRct');
        const useWalkers = isChecked('plumedWalkers');
        const temp = getStr('plumedTemp', '300');
        const stride = getStr('plumedStride', '500');
        const molinfo = getStr('plumedMolinfo', '');
        const printFile = getStr('plumedPrintFile', 'COLVAR');
        const printStride = getStr('plumedPrintStride', stride);
        const printExtra = getStr('plumedPrintExtra', '');
        const uLength = getStr('plumedUnitLength', 'nm');
        const uEnergy = getStr('plumedUnitEnergy', 'kj/mol');
        const uTime   = getStr('plumedUnitTime', 'ps');

        let s = `# ==================================================================\n`;
        s += `# PLUMED input (plumed.dat)  -  generated by stemkit.net\n`;
        s += `# Target: PLUMED v${PLUMED_VERSION} (colvar + bias modules).\n`;
        s += `# Verify against your build:  plumed --version ; plumed manual --action=<NAME>\n`;
        s += `# ==================================================================\n\n`;

        // UNITS: only emit when any is non-default (nm / kj/mol / ps).
        const nonDefaultUnits = (uLength !== 'nm') || (uEnergy !== 'kj/mol') || (uTime !== 'ps');
        if (nonDefaultUnits) {
            const parts = [];
            if (uLength !== 'nm')    parts.push(`LENGTH=${uLength}`);
            if (uEnergy !== 'kj/mol') parts.push(`ENERGY=${uEnergy}`);
            if (uTime !== 'ps')      parts.push(`TIME=${uTime}`);
            s += `# --- Units (PLUMED input units; defaults are nm, kj/mol, ps) ---\n`;
            s += `UNITS ${parts.join(' ')}\n\n`;
            warnings.push(`Non-default units set (${parts.join(', ')}). All lengths/energies you enter below (R_0, D_MAX, HEIGHT, KAPPA, ...) must be in these units.`);
        }

        // Optional MOLINFO for named groups / index-style selections
        if (molinfo) {
            s += `# --- Structure reference (enables @group selectors like @backbone, @sidechain) ---\n`;
            s += `MOLINFO STRUCTURE=${molinfo}\n\n`;
        }

        if (!plumedCVs.length) {
            s += `# (No collective variables added yet - add one on the left.)\n`;
            out.textContent = s;
            setWarnings($('slurmWarnings'), warnings);
            return;
        }

        // 1) CV definitions
        s += `# --- Collective variables ---\n`;
        plumedCVs.forEach(inst => {
            plumedWarningsForCV(inst, warnings);
            s += buildCVLine(inst) + `\n`;
        });
        s += `\n`;

        // Biased CVs feed the bias ARG; tracked-only CVs are still printed.
        const biasedCVs = plumedCVs.filter(c => c.bias && !c.isGroup);
        const allLabels = plumedCVs.filter(c => !c.isGroup).map(c => c.label);
        const biasArg = biasedCVs.map(c => c.label).join(',');
        const n = biasedCVs.length;
        const rep = (v) => Array(n).fill(v).join(',');

        // Bias needs at least one biased CV
        const biasNeedsArg = (bias !== 'none');
        if (biasNeedsArg && n === 0) {
            warnings.push('A bias method is selected but no CV is marked “Bias”. Tick “Bias” on at least one CV, or set the method to “None”.');
        }

        let biasComponents = [];   // components to optionally add to PRINT

        // Expand a per-CV parameter: a single value repeats across all biased
        // CVs; a comma-containing value is passed through verbatim.
        const perCV = (method, key) => {
            const v = String(biasVal(method, key) ?? '').trim();
            if (v === '') return '';
            if (v.includes(',')) return v;         // user gave an explicit list
            return Array(n).fill(v).join(',');
        };
        const scalar = (method, key) => String(biasVal(method, key) ?? '').trim();

        if ((bias === 'metad' || bias === 'wt_metad') && n > 0) {
            const wt = (bias === 'wt_metad');
            s += `# --- ${wt ? 'Well-Tempered ' : ''}Metadynamics ---\n`;
            s += `metad: METAD ...\n`;
            s += `    ARG=${biasArg}\n`;
            s += `    PACE=${scalar(bias, 'PACE') || stride}\n`;
            s += `    HEIGHT=${scalar(bias, 'HEIGHT')}\n`;
            s += `    SIGMA=${perCV(bias, 'SIGMA')}\n`;
            if (wt) { s += `    BIASFACTOR=${scalar(bias, 'BIASFACTOR')}\n    TEMP=${scalar(bias, 'TEMP')}\n`; }
            s += `    FILE=HILLS\n`;
            if (useGrid) {
                s += `    GRID_MIN=${rep('-pi')}\n    GRID_MAX=${rep('pi')}\n    GRID_BIN=${rep('200')}\n`;
            }
            if (useRct)     s += `    CALC_RCT RCT_USTRIDE=10\n`;
            if (useWalkers) s += `    WALKERS_MPI\n`;
            s += `... METAD\n\n`;
            biasComponents = ['metad.bias'];
            if (useRct) biasComponents.push('metad.rbias', 'metad.rct');
            if (wt && !useGrid) warnings.push('Well-tempered MetaD without a grid gets slower as hills accumulate. Enable the grid speed option.');
            if (useRct && !useGrid) warnings.push('<code>CALC_RCT</code> requires the bias on a grid. Enable the grid speed option.');
        } else if (bias === 'pbmetad' && n > 0) {
            s += `# --- Parallel-Bias Metadynamics ---\n`;
            s += `pb: PBMETAD ...\n`;
            s += `    ARG=${biasArg}\n`;
            s += `    PACE=${scalar(bias, 'PACE') || stride}\n`;
            s += `    HEIGHT=${scalar(bias, 'HEIGHT')}\n`;
            s += `    SIGMA=${perCV(bias, 'SIGMA')}\n`;
            s += `    BIASFACTOR=${scalar(bias, 'BIASFACTOR')}\n    TEMP=${scalar(bias, 'TEMP')}\n`;
            s += `    FILE=${biasedCVs.map(c => 'HILLS.' + c.label).join(',')}\n`;
            if (useGrid) s += `    GRID_MIN=${rep('-pi')}\n    GRID_MAX=${rep('pi')}\n    GRID_BIN=${rep('200')}\n`;
            if (useWalkers) s += `    WALKERS_MPI\n`;
            s += `... PBMETAD\n\n`;
            biasComponents = ['pb.bias'];
        } else if (bias === 'opes' && n > 0) {
            s += `# --- OPES (well-tempered target) ---\n`;
            s += `opes: OPES_METAD ...\n`;
            s += `    ARG=${biasArg}\n`;
            s += `    PACE=${scalar(bias, 'PACE') || stride}\n`;
            s += `    BARRIER=${scalar(bias, 'BARRIER')}\n`;
            s += `    TEMP=${scalar(bias, 'TEMP')}\n`;
            s += `    SIGMA=${perCV(bias, 'SIGMA')}\n`;
            s += `    BIASFACTOR=10\n`;
            s += `    FILE=Kernels.data\n`;
            s += `    STATE_WFILE=State.data\n`;
            s += `    STATE_WSTRIDE=${Math.max(parseInt(stride, 10) * 20 || 10000, 10000)}\n`;
            if (n >= 2) s += `    NLIST   # neighbour list over kernels speeds up multi-CV OPES\n`;
            if (useWalkers) s += `    WALKERS_MPI\n`;
            s += `... OPES_METAD\n\n`;
            biasComponents = ['opes.bias', 'opes.rct', 'opes.zed', 'opes.neff', 'opes.nker'];
        } else if (bias === 'restraint' && n > 0) {
            let line = `restraint: RESTRAINT ARG=${biasArg} AT=${perCV(bias, 'AT')} KAPPA=${perCV(bias, 'KAPPA')}`;
            const slope = perCV(bias, 'SLOPE');
            if (slope) line += ` SLOPE=${slope}`;
            s += `# --- Harmonic restraint (umbrella window) ---\n${line}\n\n`;
            biasComponents = ['restraint.bias'];
        } else if (bias === 'moving' && n > 0) {
            s += `# --- Moving restraint (steered MD): pull from STEP0 to STEP1 ---\n`;
            s += `steer: MOVINGRESTRAINT ...\n`;
            s += `    ARG=${biasArg}\n`;
            s += `    STEP0=${scalar(bias, 'STEP0')} AT0=${perCV(bias, 'AT0')} KAPPA0=${perCV(bias, 'KAPPA0')}\n`;
            s += `    STEP1=${scalar(bias, 'STEP1')} AT1=${perCV(bias, 'AT1')} KAPPA1=${perCV(bias, 'KAPPA1')}\n`;
            s += `... MOVINGRESTRAINT\n\n`;
            biasComponents = ['steer.bias'];
        } else if (bias === 'upper' && n > 0) {
            s += `# --- Upper walls ---\n`;
            s += `uwall: UPPER_WALLS ARG=${biasArg} AT=${perCV(bias, 'AT')} KAPPA=${perCV(bias, 'KAPPA')} EXP=${perCV(bias, 'EXP')} EPS=${perCV(bias, 'EPS')} OFFSET=${perCV(bias, 'OFFSET')}\n\n`;
            biasComponents = ['uwall.bias'];
        } else if (bias === 'lower' && n > 0) {
            s += `# --- Lower walls ---\n`;
            s += `lwall: LOWER_WALLS ARG=${biasArg} AT=${perCV(bias, 'AT')} KAPPA=${perCV(bias, 'KAPPA')} EXP=${perCV(bias, 'EXP')} EPS=${perCV(bias, 'EPS')} OFFSET=${perCV(bias, 'OFFSET')}\n\n`;
            biasComponents = ['lwall.bias'];
        } else if (bias === 'abmd' && n > 0) {
            let line = `abmd: ABMD ARG=${biasArg} TO=${perCV(bias, 'TO')} KAPPA=${perCV(bias, 'KAPPA')}`;
            const noise = perCV(bias, 'NOISE');
            if (noise) line += ` NOISE=${noise}`;
            s += `# --- ABMD (ratchet-and-pawl) ---\n${line}\n\n`;
            biasComponents = ['abmd.bias'];
        }

        // 3) PRINT — user picks what to print (all CVs by default + bias comps
        // + any extra components they typed), the file, and the stride.
        s += `# --- Output ---\n`;
        let printList = allLabels.slice();
        biasComponents.forEach(c => printList.push(c));
        if (printExtra) {
            printExtra.split(/[,\s]+/).filter(Boolean).forEach(x => {
                if (!printList.includes(x)) printList.push(x);
            });
        }
        s += `PRINT ARG=${printList.join(',')} FILE=${printFile} STRIDE=${printStride}\n`;

        out.textContent = s;
        setWarnings($('slurmWarnings'), warnings);
    }

    // =====================================================================
    // PLUMED CV builder UI
    // =====================================================================
    function populatePlumedCVSelect() {
        const catSel = $('plumedCategory');
        const cvSel = $('plumedCVSelect');
        if (!catSel || !cvSel) return;
        const cat = catSel.value;
        cvSel.innerHTML = '';
        Object.keys(PLUMED_CV_DEFS)
            .filter(name => PLUMED_CV_DEFS[name].cat === cat)
            .forEach(name => {
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                cvSel.appendChild(opt);
            });
        updatePlumedCVDesc();
    }

    function populatePlumedBiasSelect() {
        const sel = $('plumedBias');
        if (!sel) return;
        const current = sel.value;
        sel.innerHTML = '';
        const groups = {
            none: 'None',
            metad: 'Free energy (metadynamics)',
            restraint: 'Restraints & walls'
        };
        Object.keys(groups).forEach(catKey => {
            const og = document.createElement('optgroup');
            og.label = groups[catKey];
            Object.keys(PLUMED_BIAS_DEFS)
                .filter(k => PLUMED_BIAS_DEFS[k].cat === catKey)
                .forEach(k => {
                    const opt = document.createElement('option');
                    opt.value = k;
                    opt.textContent = PLUMED_BIAS_DEFS[k].label;
                    og.appendChild(opt);
                });
            sel.appendChild(og);
        });
        sel.value = current && PLUMED_BIAS_DEFS[current] ? current : 'wt_metad';
    }

    // Render the editable parameter fields for the currently-selected bias.
    function renderBiasParams() {
        const host = $('plumedBiasParams');
        const sel = $('plumedBias');
        if (!host || !sel) return;
        const method = sel.value;
        const def = PLUMED_BIAS_DEFS[method];
        host.innerHTML = '';
        if (!def || !def.params || !def.params.length) return;

        const wrap = document.createElement('div');
        wrap.className = 'grid grid-cols-2 gap-2 pt-1';
        def.params.forEach(p => {
            if (!plumedBiasVals[method]) plumedBiasVals[method] = {};
            const cur = plumedBiasVals[method][p.k] !== undefined ? plumedBiasVals[method][p.k] : p.def;
            const help = (p.help || '').replace(/"/g, '&quot;');
            const badge = help ? `<span class="plumed-help" tabindex="0" data-tip="${help}">?</span>` : '';
            const perTag = p.perCV ? '<span class="text-[8px] text-slate-400 font-normal">/CV</span>' : '';
            const cell = document.createElement('div');
            cell.innerHTML = `
                <label class="text-[9px] font-bold text-slate-400 flex items-center gap-1">${p.label}${perTag}${badge}</label>
                <input type="text" data-bias-key="${p.k}" value="${cur ?? ''}" ${p.def === '' ? 'placeholder="(optional)"' : ''}
                       class="w-full bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 border border-slate-300 dark:border-slate-600 rounded px-1.5 py-1 text-[11px] mt-0.5 font-mono outline-none focus:ring-2 focus:ring-rose-500">`;
            wrap.appendChild(cell);
        });
        host.appendChild(wrap);
        if (def.params.some(p => p.perCV)) {
            const note = document.createElement('p');
            note.className = 'text-[10px] text-slate-400 mt-2 leading-snug';
            note.innerHTML = '<span class="text-slate-400">/CV</span> fields apply one value to every biased CV. To set them individually, type a comma-separated list (one per biased CV).';
            host.appendChild(note);
        }

        host.querySelectorAll('[data-bias-key]').forEach(el => {
            el.addEventListener('input', (e) => {
                const t = e.currentTarget;
                if (!plumedBiasVals[method]) plumedBiasVals[method] = {};
                plumedBiasVals[method][t.getAttribute('data-bias-key')] = t.value;
                generatePlumedScript();
            });
        });
    }

    function updatePlumedCVDesc() {
        const cvSel = $('plumedCVSelect');
        const descEl = $('plumedCVDesc');
        if (!cvSel || !descEl) return;
        const def = PLUMED_CV_DEFS[cvSel.value];
        descEl.textContent = def ? def.desc : '';
    }

    function addPlumedCV() {
        const cvSel = $('plumedCVSelect');
        if (!cvSel || !cvSel.value) return;
        const type = cvSel.value;
        const def = PLUMED_CV_DEFS[type];
        const seq = ++plumedCVSeq;
        const inst = {
            id: `cv${seq}`,
            type,
            label: `cv${seq}`,
            bias: !def.isGroup,   // GROUP/COM are definitions, not biasable CVs
            isGroup: !!def.isGroup,
            values: {}
        };
        def.fields.forEach(f => { inst.values[f.k] = (f.type === 'flag') ? f.def : f.def; });
        plumedCVs.push(inst);
        renderPlumedCVList();
        generatePlumedScript();
    }

    function removePlumedCV(id) {
        plumedCVs = plumedCVs.filter(c => c.id !== id);
        renderPlumedCVList();
        generatePlumedScript();
    }

    function renderPlumedCVList() {
        const host = $('plumedCVList');
        if (!host) return;
        host.innerHTML = '';
        if (!plumedCVs.length) {
            host.innerHTML = '<p class="text-[11px] text-slate-400 italic px-1">No CVs yet. Pick a category and CV above, then “Add”.</p>';
            return;
        }
        plumedCVs.forEach(inst => {
            const def = PLUMED_CV_DEFS[inst.type];
            const card = document.createElement('div');
            card.className = 'border border-slate-200 dark:border-slate-700 rounded-lg p-2.5 bg-slate-50 dark:bg-slate-950/40';

            const head = document.createElement('div');
            head.className = 'flex items-center justify-between mb-2 gap-2';
            head.innerHTML = `
                <div class="flex items-center gap-2 min-w-0">
                    <span class="text-[10px] font-bold text-rose-600 dark:text-rose-400 uppercase shrink-0">${inst.type}</span>
                    <input data-cv="${inst.id}" data-field="__label" value="${inst.label}"
                           class="w-24 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 border border-slate-300 dark:border-slate-600 rounded px-1.5 py-0.5 text-[11px] font-mono outline-none focus:ring-2 focus:ring-rose-500"
                           title="Label for this CV" />
                </div>`;
            const right = document.createElement('div');
            right.className = 'flex items-center gap-2 shrink-0';
            if (!inst.isGroup) {
                const biasLbl = document.createElement('label');
                biasLbl.className = 'flex items-center gap-1 text-[10px] font-bold uppercase cursor-pointer ' +
                    (inst.bias ? 'text-rose-600 dark:text-rose-400' : 'text-slate-400');
                biasLbl.title = 'Feed this CV to the bias (unchecked = tracked/printed only)';
                biasLbl.innerHTML = `<input type="checkbox" data-cv="${inst.id}" data-field="__bias" ${inst.bias ? 'checked' : ''} class="w-3.5 h-3.5 text-rose-600 rounded focus:ring-rose-500"> Bias`;
                right.appendChild(biasLbl);
            }
            const rm = document.createElement('button');
            rm.className = 'text-slate-400 hover:text-rose-500 text-xs';
            rm.innerHTML = '<i class="fa-solid fa-trash"></i>';
            rm.addEventListener('click', () => removePlumedCV(inst.id));
            right.appendChild(rm);
            head.appendChild(right);
            card.appendChild(head);

            const grid = document.createElement('div');
            grid.className = 'grid grid-cols-2 gap-2';
            const helpFor = (f) => {
                const h = (f.help || PLUMED_KEY_HELP[f.k] || '').replace(/"/g, '&quot;');
                return h ? `<span class="plumed-help" tabindex="0" data-tip="${h}">?</span>` : '';
            };
            def.fields.forEach(f => {
                const wrap = document.createElement('div');
                if (f.type === 'flag') {
                    wrap.className = 'col-span-2 flex items-center gap-2';
                    wrap.innerHTML = `
                        <input type="checkbox" data-cv="${inst.id}" data-field="${f.k}" ${inst.values[f.k] ? 'checked' : ''}
                               class="w-3.5 h-3.5 text-rose-600 rounded focus:ring-rose-500">
                        <label class="text-[11px] text-slate-600 dark:text-slate-300">${f.label}</label>${helpFor(f)}`;
                } else if (f.type === 'select') {
                    const opts = f.options.map(o => `<option value="${o}" ${o===inst.values[f.k]?'selected':''}>${o}</option>`).join('');
                    wrap.innerHTML = `
                        <label class="text-[9px] font-bold text-slate-400 flex items-center gap-1">${f.label}${helpFor(f)}</label>
                        <select data-cv="${inst.id}" data-field="${f.k}"
                                class="w-full bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 border border-slate-300 dark:border-slate-600 rounded px-1.5 py-1 text-[11px] mt-0.5 outline-none focus:ring-2 focus:ring-rose-500">${opts}</select>`;
                } else {
                    wrap.innerHTML = `
                        <label class="text-[9px] font-bold text-slate-400 flex items-center gap-1">${f.label}${helpFor(f)}</label>
                        <input type="text" data-cv="${inst.id}" data-field="${f.k}" value="${inst.values[f.k] ?? ''}"
                               class="w-full bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 border border-slate-300 dark:border-slate-600 rounded px-1.5 py-1 text-[11px] mt-0.5 font-mono outline-none focus:ring-2 focus:ring-rose-500">`;
                }
                grid.appendChild(wrap);
            });
            card.appendChild(grid);
            host.appendChild(card);
        });

        // wire field edits
        host.querySelectorAll('[data-cv]').forEach(el => {
            const evt = (el.type === 'checkbox' || el.tagName === 'SELECT') ? 'change' : 'input';
            el.addEventListener(evt, (e) => {
                const t = e.currentTarget;
                const inst = plumedCVs.find(c => c.id === t.getAttribute('data-cv'));
                if (!inst) return;
                const field = t.getAttribute('data-field');
                if (field === '__label') {
                    inst.label = t.value.trim() || inst.id;
                } else if (field === '__bias') {
                    inst.bias = t.checked;
                    renderPlumedCVList(); // refresh the Bias label colour
                } else if (t.type === 'checkbox') {
                    inst.values[field] = t.checked;
                } else {
                    inst.values[field] = t.value;
                }
                generatePlumedScript();
            });
        });
    }

    // =====================================================================
    // Dispatcher
    // =====================================================================
    function generateSubmitScript() {
        if (currentEngine === 'gromacs') generateGromacsScript();
        else if (currentEngine === 'lammps') generateLammpsScript();
        else if (currentEngine === 'plumed') generatePlumedScript();
    }

    // =====================================================================
    // Topology header (GROMACS only)
    // =====================================================================
    function applyForcefieldPreset() {
        const sel = $('topForcefield');
        if (!sel) return;
        const preset = FF_PRESETS[sel.value];
        if (!preset) return;
        if ($('topComb'))  $('topComb').value  = preset.comb;
        if ($('topFudge')) $('topFudge').value = preset.family;
    }

    function resolveFudge() {
        switch ($('topFudge')?.value) {
            case 'amber':  return { LJ: '0.5', QQ: '0.8333' };
            case 'charmm': return { LJ: '1.0', QQ: '1.0' };
            case 'opls':   return { LJ: '0.5', QQ: '0.5' };
            case 'none':   return { LJ: '1.0', QQ: '1.0' };
            default:       return { LJ: '1.0', QQ: '1.0' };
        }
    }

    function generateTopologyHeader() {
        const out = $('topOutput');
        if (!out) return;

        const ffKey    = $('topForcefield') ? $('topForcefield').value : 'amber99sb-ildn';
        const preset   = FF_PRESETS[ffKey];
        const solv     = $('topSolvent') ? $('topSolvent').value : 'spce';
        const comb     = $('topComb') ? $('topComb').value : (preset ? preset.comb : '2');
        const fudge    = resolveFudge();
        const includes = $('topIncludes') ? $('topIncludes').value : '';

        const warnings = [];
        if (preset) {
            if (comb !== preset.comb) {
                warnings.push(`Combination rule <b>${comb}</b> is non-canonical for ${preset.label}, which ships with <b>rule ${preset.comb}</b>. grompp uses your <code>[ defaults ]</code> line, so this may not match the force field.`);
            }
            if (fudge.LJ !== preset.fudgeLJ || fudge.QQ !== preset.fudgeQQ) {
                warnings.push(`Fudge factors <b>${fudge.LJ}/${fudge.QQ}</b> differ from ${preset.label}'s canonical <b>${preset.fudgeLJ}/${preset.fudgeQQ}</b>. Only override if intentional.`);
            }
        }

        let t = `; ==================================================================\n`;
        t += `; STEMKit (stemkit.net) auto-generated GROMACS topology header\n`;
        t += `; Force field: ${preset ? preset.label : ffKey}\n`;
        t += `; NOTE: grompp reads these [ defaults ] before the force field's own\n`;
        t += `;       forcefield.itp. Keep them consistent with the force field.\n`;
        t += `; ==================================================================\n\n`;

        t += `[ defaults ]\n`;
        t += `; nbfunc  comb-rule  gen-pairs  fudgeLJ  fudgeQQ\n`;
        t += `1         ${comb.padEnd(9, ' ')} yes        ${fudge.LJ.padEnd(8, ' ')} ${fudge.QQ}\n\n`;

        t += `; --- Core force field ---\n`;
        t += `#include "${ffKey}.ff/forcefield.itp"\n\n`;

        if (includes && includes.trim() !== '') {
            t += `; --- Custom / additional topologies ---\n`;
            t += `${includes.trim()}\n\n`;
        }

        t += `; --- Water model ---\n`;
        t += `#include "${ffKey}.ff/${solv}.itp"\n\n`;

        t += `; --- Ions ---\n`;
        t += `#include "${ffKey}.ff/ions.itp"\n\n`;

        t += `[ system ]\n; Name\nMD system\n\n`;
        t += `[ molecules ]\n; Compound   #mols\n`;
        t += `; Fill in with your actual species and counts, e.g.:\n`;
        t += `; Protein_A    1\n; SOL          10000\n; NA           30\n; CL           28\n`;

        out.textContent = t;
        setWarnings($('topWarnings'), warnings);
    }

    // =====================================================================
    // Engine tab switching
    // =====================================================================
    function switchEngine(engine) {
        currentEngine = engine;

        document.querySelectorAll('[data-engine-tab]').forEach(btn => {
            const active = btn.getAttribute('data-engine-tab') === engine;
            if (active) {
                // Inline style guarantees the active colour even if the
                // bg-rose-600 utility is not present in the compiled CSS.
                btn.style.backgroundColor = '#e11d48'; // rose-600
                btn.style.color = '#ffffff';
                btn.classList.add('shadow-sm');
            } else {
                btn.style.backgroundColor = '';
                btn.style.color = '';
                btn.classList.remove('shadow-sm');
            }
            btn.classList.toggle('text-slate-700', !active);
            btn.classList.toggle('dark:text-slate-300', !active);
            btn.classList.toggle('hover:bg-slate-200', !active);
            btn.classList.toggle('dark:hover:bg-slate-800', !active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });

        // Panels visible per engine
        toggleVisibility($('gromacsPanel'), engine === 'gromacs');
        toggleVisibility($('lammpsPanel'),  engine === 'lammps');
        toggleVisibility($('plumedPanel'),  engine === 'plumed');

        // Resource-model fields: GROMACS shows CPUs/task, LAMMPS shows tasks/node.
        // PLUMED generates an input file, so the SLURM resource card is hidden.
        toggleVisibility($('gmxCpuField'),  engine === 'gromacs');
        toggleVisibility($('lmpTaskField'), engine === 'lammps');
        toggleVisibility($('lmpCpuField'),  engine === 'lammps');
        const clusterCard = $('clusterCard');
        if (clusterCard) clusterCard.classList.toggle('hidden', engine === 'plumed');

        // Topology + GROMACS GPU flags only relevant to GROMACS
        const topCard = $('topologyCard');
        if (topCard) topCard.classList.toggle('hidden', engine !== 'gromacs');
        const gmxGpuCard = $('gmxGpuCard');
        if (gmxGpuCard) gmxGpuCard.classList.toggle('hidden', engine !== 'gromacs');
        const lmpGpuCard = $('lmpGpuCard');
        if (lmpGpuCard) lmpGpuCard.classList.toggle('hidden', engine !== 'lammps');

        // Output labels + secondary box
        const lbl = $('primaryOutputLabel');
        if (lbl) lbl.textContent = (engine === 'plumed') ? 'plumed.dat' : 'submit.sh';
        const topBox = $('topologyOutputBox');
        if (topBox) topBox.classList.toggle('hidden', engine !== 'gromacs');

        if (engine === 'plumed') {
            populatePlumedCVSelect();
            populatePlumedBiasSelect();
            renderBiasParams();
            renderPlumedCVList();
        }
        generateSubmitScript();
        if (engine === 'gromacs') generateTopologyHeader();
    }

    // =====================================================================
    // Wire up events
    // =====================================================================
    // Engine tabs
    document.querySelectorAll('[data-engine-tab]').forEach(btn => {
        btn.addEventListener('click', () => switchEngine(btn.getAttribute('data-engine-tab')));
    });

    // Generic inputs that affect the submit script
    const submitInputIds = [
        'jobName','jobPartition','jobNodes','jobCpus','jobTasks','lmpCpus','jobGpus',
        'jobTime','jobMem','jobArrayRange','jobArrayDir','jobMailUser',
        'gmxTopol','gmxStartConf','gmxIndex','gpuNtmpi',
        'lmpInput','lmpLog'
    ];
    submitInputIds.forEach(id => { const el = $(id); if (el) el.addEventListener('input', generateSubmitScript); });

    const submitToggleIds = [
        'jobArrayToggle','usePartition','useMail',
        'gpuNb','gpuPme','gpuBonded','gpuUpdate'
    ];
    submitToggleIds.forEach(id => { const el = $(id); if (el) el.addEventListener('change', generateSubmitScript); });

    if ($('lmpAccel')) $('lmpAccel').addEventListener('change', generateSubmitScript);

    // PLUMED
    if ($('plumedCategory')) $('plumedCategory').addEventListener('change', populatePlumedCVSelect);
    if ($('plumedCVSelect')) $('plumedCVSelect').addEventListener('change', updatePlumedCVDesc);
    if ($('plumedAddCV'))     $('plumedAddCV').addEventListener('click', addPlumedCV);
    if ($('plumedBias'))      $('plumedBias').addEventListener('change', renderBiasParams);
    ['plumedBias','plumedTemp','plumedStride','plumedMolinfo','plumedPrintFile','plumedPrintStride','plumedPrintExtra','plumedUnitLength','plumedUnitEnergy','plumedUnitTime'].forEach(id => {
        const el = $(id); if (el) { el.addEventListener('input', generatePlumedScript); el.addEventListener('change', generatePlumedScript); }
    });
    ['plumedGrid','plumedRct','plumedWalkers'].forEach(id => {
        const el = $(id); if (el) el.addEventListener('change', generatePlumedScript);
    });

    // GROMACS + PLUMED coupling
    ['gmxUsePlumed','gmxPlumedScope'].forEach(id => {
        const el = $(id); if (el) el.addEventListener('change', () => {
            const w = $('gmxPlumedWrap');
            if (id === 'gmxUsePlumed' && w) w.classList.toggle('hidden', !$('gmxUsePlumed').checked);
            generateGromacsScript();
        });
    });
    if ($('gmxPlumedFile')) $('gmxPlumedFile').addEventListener('input', generateGromacsScript);

    // Array show/hide
    if ($('jobArrayToggle')) $('jobArrayToggle').addEventListener('change', (e) => toggleVisibility($('arraySettings'), e.target.checked));
    if ($('usePartition'))   $('usePartition').addEventListener('change', (e) => {
        const inp = $('jobPartition'); if (inp) inp.disabled = !e.target.checked;
        const w = $('partitionWrap'); if (w) w.classList.toggle('opacity-40', !e.target.checked);
    });
    if ($('useMail')) $('useMail').addEventListener('change', (e) => toggleVisibility($('mailWrap'), e.target.checked));

    // GROMACS stage rows
    GMX_STAGES.forEach(key => {
        ['on','mdp','deffnm','posres'].forEach(suffix => {
            const el = $(`stage_${key}_${suffix}`);
            if (!el) return;
            const evt = (el.type === 'checkbox') ? 'change' : 'input';
            el.addEventListener(evt, generateGromacsScript);
        });
    });

    // Force field coupling
    if ($('topForcefield')) $('topForcefield').addEventListener('change', () => {
        if (!manualOverride) applyForcefieldPreset();
        generateTopologyHeader();
    });
    if ($('topSolvent'))  $('topSolvent').addEventListener('change', generateTopologyHeader);
    if ($('topIncludes')) $('topIncludes').addEventListener('input', generateTopologyHeader);
    if ($('topAdvancedToggle')) $('topAdvancedToggle').addEventListener('change', (e) => {
        manualOverride = e.target.checked;
        toggleVisibility($('topAdvancedPanel'), e.target.checked);
        if (!manualOverride) applyForcefieldPreset();
        generateTopologyHeader();
    });
    if ($('topComb'))  $('topComb').addEventListener('change', generateTopologyHeader);
    if ($('topFudge')) $('topFudge').addEventListener('change', generateTopologyHeader);

    // =====================================================================
    // Copy buttons
    // =====================================================================
    function showToast(message) {
        const c = $('toastContainer');
        if (!c) return;
        const toast = document.createElement('div');
        toast.className = 'bg-slate-800 text-white text-xs font-bold px-4 py-2 rounded-lg shadow-xl transform transition-all duration-300 translate-y-[-20px] opacity-0';
        toast.textContent = message;
        c.appendChild(toast);
        requestAnimationFrame(() => {
            toast.classList.remove('translate-y-[-20px]', 'opacity-0');
            toast.classList.add('translate-y-0', 'opacity-100');
        });
        setTimeout(() => {
            toast.classList.remove('translate-y-0', 'opacity-100');
            toast.classList.add('translate-y-[-20px]', 'opacity-0');
            setTimeout(() => toast.remove(), 300);
        }, 2000);
    }

    document.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const targetId = e.currentTarget.getAttribute('data-target');
            const node = $(targetId);
            if (!node) return;
            const code = node.textContent;
            const el = e.currentTarget;

            const done = () => {
                showToast('Code copied to clipboard!');
                const originalHTML = el.innerHTML;
                el.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
                el.classList.replace('bg-slate-800', 'bg-emerald-600');
                el.classList.remove('hover:bg-slate-700');
                setTimeout(() => {
                    el.innerHTML = originalHTML;
                    el.classList.replace('bg-emerald-600', 'bg-slate-800');
                    el.classList.add('hover:bg-slate-700');
                }, 2000);
            };
            const fallbackCopy = () => {
                const ta = document.createElement('textarea');
                ta.value = code; ta.style.position = 'fixed'; ta.style.opacity = '0';
                document.body.appendChild(ta); ta.select();
                try { document.execCommand('copy'); done(); } catch (_) {}
                document.body.removeChild(ta);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(code).then(done).catch(fallbackCopy);
            } else { fallbackCopy(); }
        });
    });

    // =====================================================================
    // Init
    // =====================================================================
    applyForcefieldPreset();
    switchEngine('gromacs');
});
