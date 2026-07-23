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
    const escapeHtml = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

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
    // Supported PLUMED target versions. The selected target gates version-only
    // actions (e.g. the 2.10 multicolvar rewrite) and drives the doc-link base.
    const PLUMED_VERSIONS = ['2.9', '2.10'];
    // The currently selected target version (read from the #plumedVersion UI
    // control; falls back to the default when the control is absent).
    function targetVersion() {
        const el = $('plumedVersion');
        const v = el && el.value;
        return PLUMED_VERSIONS.includes(v) ? v : PLUMED_VERSION;
    }
    // Compare dotted versions: returns true if `have` >= `need`.
    function versionAtLeast(have, need) {
        const a = String(have).split('.').map(Number);
        const b = String(need).split('.').map(Number);
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
            const x = a[i] || 0, y = b[i] || 0;
            if (x !== y) return x > y;
        }
        return true;
    }
    // Is a CV def available under the current target version?
    function cvAvailable(def, ver) {
        if (!def || !def.minVersion) return true;
        return versionAtLeast(ver || targetVersion(), def.minVersion);
    }
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
        LOWMEM: 'Lower the memory footprint of the multicolvar at some CPU cost. Useful for very large SPECIES lists.',
        R_POWER: 'Multiply the coordination-number function by the pairwise distance raised to this power (indirectly biases the radial distribution). Used by COORDINATION_MOMENTS.',
        MOMENTS: 'Which moments of the distance distribution in the first coordination sphere to evaluate, e.g. 2-4.',
        ALPHA: 'The alpha parameter of the angular part of the FCCUBIC symmetry function (source default 27; sharper as it grows).',
        KERNEL: 'A single kernel (e.g. {GAUSSIAN CENTER=0 SIGMA=0.48}) used by ATOMIC_SMAC in the function of the bond angles.',
        KERNEL1: 'First angular kernel for SMAC, e.g. {GAUSSIAN CENTER=0 SIGMA=0.480}. Set so it is 1 for the solid-like relative orientation.',
        KERNEL2: 'Second angular kernel for SMAC, e.g. {GAUSSIAN CENTER=pi SIGMA=0.7}.',
        SWITCH_COORD: 'Switching function on the coordination count that weights how many neighbours a molecule must have to be counted as ordered, e.g. {RATIONAL R_0=0.001}.',
        PHI: 'Euler angle (rad) that rotates the bond vectors into a reference frame before the tetrahedrality is computed.',
        THETA: 'Euler angle (rad) applied after PHI to rotate the bond vectors into the reference frame.',
        PSI: 'Third Euler angle (rad) completing the rotation of the bond vectors into the reference frame.',
        VSUM: 'Output the sum of the per-atom vectors (rather than the mean).'
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

    // PLUMED module gating. A CV whose def carries `module: '<key>'` is not part
    // of a stock PLUMED build and needs that module compiled in. The core colvar
    // and multicolvar modules ship by default, so CVs from them omit `module`.
    // Each entry: a human name and the rebuild hint shown to the user and folded
    // into the generated file header. `prereq` lets a CV declare an input-level
    // prerequisite (e.g. WHOLEMOLECULES) surfaced as a warning + header note.
    const PLUMED_MODULES = {
        secondarystructure: {
            name: 'secondarystructure',
            hint: 'Rebuild PLUMED with the "secondarystructure" module enabled (./configure --enable-modules=secondarystructure or all).'
        },
        opes: {
            name: 'opes',
            hint: 'Rebuild PLUMED with the "opes" module enabled (./configure --enable-modules=opes or all).'
        },
        isdb: {
            name: 'ISDB',
            hint: 'Rebuild PLUMED with the "isdb" module enabled (./configure --enable-modules=isdb or all).'
        },
        sasa: {
            name: 'SASA',
            hint: 'Rebuild PLUMED with the "sasa" module enabled (./configure --enable-modules=sasa or all).'
        },
        funnel: {
            name: 'FUNNEL',
            hint: 'Rebuild PLUMED with the "funnel" module enabled (./configure --enable-modules=funnel or all).'
        },
        membranefusion: {
            name: 'membranefusion',
            hint: 'Rebuild PLUMED with the "membranefusion" module enabled (./configure --enable-modules=membranefusion or all).'
        },
        piv: {
            name: 'PIV',
            hint: 'Rebuild PLUMED with the "piv" module enabled (./configure --enable-modules=piv or all).'
        }
    };
    // Named input-level prerequisites a CV can declare via `prereq: '<key>'`.
    const PLUMED_PREREQS = {
        wholemolecules: {
            label: 'WHOLEMOLECULES',
            note: 'requires a WHOLEMOLECULES line (before this CV) so PLUMED reconstructs whole chains across periodic boundaries — otherwise the CV is wrong for codes like GROMACS. Not needed if you use TYPE=DRMSD.'
        }
    };

    // Build the PLUMED v2.9 documentation URL for an action. The doxygen page
    // name mangles each uppercase letter to "_" + lowercase and doubles the
    // underscore around a literal "_" (verified against the CV index):
    //   COORDINATIONNUMBER -> _c_o_o_r_d_i_n_a_t_i_o_n_n_u_m_b_e_r.html
    //   PROJECTION_ON_AXIS -> _p_r_o_j_e_c_t_i_o_n__o_n__a_x_i_s.html
    function plumedDocMangle(action) {
        let s = '';
        for (const ch of action) {
            if (ch >= 'A' && ch <= 'Z') s += '_' + ch.toLowerCase();
            else if (ch === '_') s += '_';
            else s += ch;
        }
        return s;
    }
    // Resolve the doc URL for a CV def (optionally an instance, for variants).
    function plumedDocUrl(def, inst) {
        if (!def) return '';
        if (def.doc) return def.doc;                 // explicit override
        if (def.isCustom) return '';                 // CUSTOM: no single doc page
        // The action name is def.act, or the catalogue key when act is omitted
        // (for most core CVs the key IS the action name, e.g. DISTANCE).
        let action = def.act || def.__key || null;
        if (!action) return '';
        if (inst) {
            const vf = (def.fields || []).find(f => f.variant);
            if (vf && inst.values[vf.k]) action = inst.values[vf.k];
        }
        // Use the current target's docs, EXCEPT for a version-gated action:
        // its page does not exist in older docs, so always link to a version
        // where it does (its minVersion, or the target if that is already newer).
        let docVer = targetVersion();
        if (def.minVersion && !versionAtLeast(docVer, def.minVersion)) {
            docVer = def.minVersion;
        }
        return `https://www.plumed.org/doc-v${docVer}/user-doc/html/${plumedDocMangle(action)}.html`;
    }

    // field types: 'atoms' (atom list), 'text', 'num', 'select', 'flag'
    const PLUMED_CV_DEFS = {
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
        DIHEDRAL_CORRELATION: {
            cat: 'angles', minVersion: '2.10', fallback: 'DIHCOR', desc: 'Measure the correlation between a pair of dihedral angles (phi and psi).',
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
            cat: 'energy', desc: 'Calculates EEF1 solvation free energy for a group of non-hydrogen atoms.',
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
            fields: [
                { k: 'ATOM', label: 'ATOM', type: 'atoms', def: '1', required: true },
                { k: 'NOPBC', label: 'NOPBC', type: 'flag', def: false }
            ]
        },
        PROJECTION_ON_AXIS: {
            cat: 'position', desc: 'Calculate a position based on the projection along and extension from a defined axis.',
            fields: [
                { k: 'AXIS_ATOMS', label: 'AXIS_ATOMS (2)', type: 'atoms', def: '1,2', required: true },
                { k: 'ATOM', label: 'ATOM (1)', type: 'atoms', def: '3', required: true },
                { k: 'NOPBC', label: 'NOPBC', type: 'flag', def: false }
            ]
        },
        PLANE: {
            cat: 'position', minVersion: '2.10', fallback: 'PLANES', desc: 'Calculate the plane perpendicular to two vectors representing planar orientation.',
            fields: [
                { k: 'ATOMS', label: 'ATOMS (3 or 4)', type: 'atoms', def: '1,2,3', required: true },
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
                { k: 'UPPER_CUTOFF', label: 'UPPER_CUTOFF (nm)', type: 'num', def: '0.8' },
                { k: 'TYPE', label: 'TYPE', type: 'select', def: 'DRMSD', options: ['DRMSD', 'INTER-DRMSD', 'INTRA-DRMSD'] },
                { k: 'SQUARED', label: 'SQUARED', type: 'flag', def: false },
                { k: 'NOPBC', label: 'NOPBC', type: 'flag', def: false }
            ]
        },
        PCARMSD: {
            cat: 'rmsd', desc: 'Calculate the PCA components against an average structure.',
            fields: [
                { k: 'AVERAGE', label: 'AVERAGE (.pdb)', type: 'text', def: 'average.pdb', required: true },
                { k: 'EIGENVECTORS', label: 'EIGENVECTORS (.pdb)', type: 'text', def: 'eigenvec.pdb', required: true },
                { k: 'SQUARED_ROOT', label: 'SQUARED_ROOT', type: 'flag', def: false }
            ]
        },
        PATHMSD: {
            cat: 'rmsd', desc: 'Path collective variables (progress s and distance z along a path).',
            fields: [
                { k: 'REFERENCE', label: 'REFERENCE (.pdb)', type: 'text', def: 'path.pdb', required: true },
                { k: 'LAMBDA', label: 'LAMBDA', type: 'num', def: '500', required: true }
            ]
        },
        PROPERTYMAP: {
            cat: 'rmsd', desc: 'Calculate generic property maps based on distances to reference frames.',
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
            fields: [
                { k: 'ATOMS', label: 'ATOMS (5 or 6, in order)', type: 'atoms', def: '1,2,3,4,5,6', required: true }
            ]
        },
        ALPHARMSD: {
            cat: 'rmsd', act: 'ALPHARMSD',
            module: 'secondarystructure', prereq: 'wholemolecules',
            prereqSkipIf: (inst) => String(inst.values.TYPE || '').toUpperCase() === 'DRMSD',
            compStyle: 'dot', reductions: ['LESS_THAN', 'MIN', 'ALT_MIN', 'LOWEST', 'HIGHEST'],
            desc: 'Alpha-helical content: counts six-residue segments whose configuration resembles an idealised alpha helix (bare label = number of segments). Needs MOLINFO.',
            fields: [
                { k: 'RESIDUES', label: 'RESIDUES', type: 'text', def: 'all', required: true, help: 'Residues that could form the structure — "all" or a list. Requires a MOLINFO reference structure.' },
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
            module: 'secondarystructure', prereq: 'wholemolecules',
            prereqSkipIf: (inst) => String(inst.values.TYPE || '').toUpperCase() === 'DRMSD',
            compStyle: 'dot', reductions: ['LESS_THAN', 'MIN', 'ALT_MIN', 'LOWEST', 'HIGHEST'],
            desc: 'Antiparallel beta-sheet content: counts six-residue segments resembling an idealised antiparallel beta sheet (bare label = number of segments). Needs MOLINFO.',
            fields: [
                { k: 'RESIDUES', label: 'RESIDUES', type: 'text', def: 'all', required: true, help: 'Residues that could form the sheet — "all" or a list. Requires a MOLINFO reference structure.' },
                { k: 'TYPE', label: 'TYPE', type: 'select', def: 'DRMSD', options: ['DRMSD', 'OPTIMAL', 'SIMPLE'], help: 'RMSD metric. DRMSD needs no WHOLEMOLECULES; OPTIMAL/SIMPLE do.' },
                { k: 'R_0', label: 'R_0 (nm)', type: 'num', def: '0.08', required: true, help: 'r_0 of the switching function (paper value 0.08 nm).' },
                { k: 'D_0', label: 'D_0 (nm)', type: 'num', def: '0.0' },
                { k: 'NN', label: 'NN', type: 'num', def: '8' },
                { k: 'MM', label: 'MM', type: 'num', def: '12' },
                { k: 'STYLE', label: 'STYLE', type: 'select', def: 'all', options: ['all', 'inter', 'intra'], help: 'all: any geometry; inter: only two-chain sheets; intra: only single-chain sheets.' },
                { k: 'STRANDS_CUTOFF', label: 'STRANDS_CUTOFF (nm)', type: 'num', def: '1', help: 'Skip the RMSD when the two strands are further apart than this — a large speedup, but only valid with LESS_THAN.' },
                { k: 'NOPBC', label: 'NOPBC', type: 'flag', def: false }
            ]
        },
        PARABETARMSD: {
            cat: 'rmsd', act: 'PARABETARMSD',
            module: 'secondarystructure', prereq: 'wholemolecules',
            prereqSkipIf: (inst) => String(inst.values.TYPE || '').toUpperCase() === 'DRMSD',
            compStyle: 'dot', reductions: ['LESS_THAN', 'MIN', 'ALT_MIN', 'LOWEST', 'HIGHEST'],
            desc: 'Parallel beta-sheet content: counts six-residue segments resembling an idealised parallel beta sheet (bare label = number of segments). Needs MOLINFO.',
            fields: [
                { k: 'RESIDUES', label: 'RESIDUES', type: 'text', def: 'all', required: true, help: 'Residues that could form the sheet — "all" or a list. Requires a MOLINFO reference structure.' },
                { k: 'TYPE', label: 'TYPE', type: 'select', def: 'DRMSD', options: ['DRMSD', 'OPTIMAL', 'SIMPLE'], help: 'RMSD metric. DRMSD needs no WHOLEMOLECULES; OPTIMAL/SIMPLE do.' },
                { k: 'R_0', label: 'R_0 (nm)', type: 'num', def: '0.08', required: true, help: 'r_0 of the switching function (paper value 0.08 nm).' },
                { k: 'D_0', label: 'D_0 (nm)', type: 'num', def: '0.0' },
                { k: 'NN', label: 'NN', type: 'num', def: '8' },
                { k: 'MM', label: 'MM', type: 'num', def: '12' },
                { k: 'STYLE', label: 'STYLE', type: 'select', def: 'all', options: ['all', 'inter', 'intra'], help: 'all: any geometry; inter: only two-chain sheets; intra: only single-chain sheets.' },
                { k: 'STRANDS_CUTOFF', label: 'STRANDS_CUTOFF (nm)', type: 'num', def: '1', help: 'Skip the RMSD when the two strands are further apart than this — a large speedup, but only valid with LESS_THAN.' },
                { k: 'NOPBC', label: 'NOPBC', type: 'flag', def: false }
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
                { k: 'D_MAX', label: 'D_MAX (nm)', type: 'num', def: '0.6', help: 'Distance beyond which the switch is exactly zero; enables linked-cell neighbour search — a large speedup.' },
                { k: 'NL_CUTOFF', label: 'NL_CUTOFF (nm)', type: 'num', def: '' },
                { k: 'NL_STRIDE', label: 'NL_STRIDE (steps)', type: 'num', def: '' }
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
                { k: 'NOPBC', label: 'NOPBC', type: 'flag', def: false, help: 'Ignore periodic boundary conditions — can speed up a localised selection.' }
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
                { k: 'R_0', label: 'R_0 (nm)', type: 'num', def: '0.2', required: true },
                { k: 'D_0', label: 'D_0 (nm)', type: 'num', def: '1.3' },
                { k: 'D_MAX', label: 'D_MAX (nm)', type: 'num', def: '', help: 'Distance beyond which the switch is exactly zero; enables the linked-cell speedup.' },
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
                { k: 'R_0', label: 'R_0 (nm)', type: 'num', def: '0.2', required: true },
                { k: 'D_0', label: 'D_0 (nm)', type: 'num', def: '1.3' },
                { k: 'D_MAX', label: 'D_MAX (nm)', type: 'num', def: '', help: 'Distance beyond which the switch is exactly zero; enables the linked-cell speedup.' },
                { k: 'LOWMEM', label: 'LOWMEM', type: 'flag', def: false }
            ]
        },
        LOCAL_Q4: {
            cat: 'order', act: 'LOCAL_Q4',
            desc: 'Local Steinhardt Q4 (average dot product with the first coordination sphere).',
            switchSpeed: true, compStyle: 'dot',
            fields: [
                { k: 'SPECIES', label: 'SPECIES (base Q4 labels)', type: 'text', def: 'q4a,q4b', required: true, help: 'References the labels of one or more base Q4 actions defined earlier.' },
                { k: 'R_0', label: 'R_0 (nm)', type: 'num', def: '0.2', required: true },
                { k: 'D_0', label: 'D_0 (nm)', type: 'num', def: '1.3' },
                { k: 'D_MAX', label: 'D_MAX (nm)', type: 'num', def: '' },
                { k: 'LOWMEM', label: 'LOWMEM', type: 'flag', def: false }
            ]
        },
        LOCAL_Q3: {
            cat: 'order', act: 'LOCAL_Q3',
            desc: 'Local Steinhardt Q3 (average dot product with the first coordination sphere).',
            switchSpeed: true, compStyle: 'dot',
            fields: [
                { k: 'SPECIES', label: 'SPECIES (base Q3 labels)', type: 'text', def: 'q3a,q3b', required: true, help: 'References the labels of one or more base Q3 actions defined earlier.' },
                { k: 'R_0', label: 'R_0 (nm)', type: 'num', def: '0.2', required: true },
                { k: 'D_0', label: 'D_0 (nm)', type: 'num', def: '1.3' },
                { k: 'D_MAX', label: 'D_MAX (nm)', type: 'num', def: '' },
                { k: 'LOWMEM', label: 'LOWMEM', type: 'flag', def: false }
            ]
        },
        SMAC: {
            cat: 'order', act: 'SMAC',
            desc: 'Symmetry function for molecules: detects crystal-like ordering from relative orientations and torsional angles.',
            compStyle: 'dot',
            fields: [
                { k: 'SPECIES', label: 'SPECIES (orient. action)', type: 'text', def: 'm1', required: true, help: 'Label of the DISTANCES/PLANES/MOLECULES action that defines the molecular orientations.' },
                { k: 'KERNEL1', label: 'KERNEL1 (block)', type: 'text', def: '{GAUSSIAN CENTER=0 SIGMA=0.480}', required: true },
                { k: 'KERNEL2', label: 'KERNEL2 (block)', type: 'text', def: '{GAUSSIAN CENTER=pi SIGMA=0.700}' },
                { k: 'SWITCH', label: 'SWITCH (block)', type: 'text', def: '{RATIONAL D_0=0.639 R_0=0.1 D_MAX=0.64}', required: true },
                { k: 'SWITCH_COORD', label: 'SWITCH_COORD (block)', type: 'text', def: '{RATIONAL R_0=0.001}' },
                { k: 'LOWMEM', label: 'LOWMEM', type: 'flag', def: false }
            ]
        },
        ATOMIC_SMAC: {
            cat: 'order', minVersion: '2.10', fallback: 'SMAC (molecular SMAC)', act: 'ATOMIC_SMAC',
            desc: 'Atomic SMAC: whether the environment is ordered, from the distribution of angles between bonds in the first coordination sphere.',
            compStyle: 'dot',
            fields: [
                { k: 'SPECIES', label: 'SPECIES', type: 'atoms', def: '1-64', required: true },
                { k: 'KERNEL', label: 'KERNEL (block)', type: 'text', def: '{GAUSSIAN CENTER=0 SIGMA=0.480}', required: true },
                { k: 'SWITCH', label: 'SWITCH (block)', type: 'text', def: '{RATIONAL R_0=0.3 D_MAX=0.5}', required: true },
                { k: 'SWITCH_COORD', label: 'SWITCH_COORD (block)', type: 'text', def: '{RATIONAL R_0=0.001}' },
                { k: 'LOWMEM', label: 'LOWMEM', type: 'flag', def: false }
            ]
        },
        FCCUBIC: {
            cat: 'order', act: 'FCCUBIC',
            desc: 'How similar the environment around an atom is to a face-centred-cubic structure.',
            compStyle: 'dot',
            fields: [
                { k: 'SPECIES', label: 'SPECIES', type: 'atoms', def: '1-64', required: true },
                { k: 'SWITCH', label: 'SWITCH (block)', type: 'text', def: '{CUBIC D_0=1.2 D_MAX=1.5}', required: true, help: 'Switching function for the contact matrix, e.g. {CUBIC D_0=1.2 D_MAX=1.5}. Setting D_MAX enables the linked-cell speedup.' },
                { k: 'ALPHA', label: 'ALPHA', type: 'num', def: '3.0', help: 'Alpha parameter of the angular function (PLUMED source default 27; this tool defaults to 3.0 per the project spec).' },
            ]
        },
        // ================================================================
        // Shortcut multicolvar families (ActionShortcut in the PLUMED source).
        // These expand internally into separate reduction actions, so their
        // components use the UNDERSCORE convention (label_mean, label_lessthan).
        // DIHCOR/ALPHABETA collapse to a single scalar (compStyle 'none').
        // ================================================================
        ANGLES: {
            cat: 'angles', act: 'ANGLES', compStyle: 'underscore',
            desc: 'Functions of a distribution of angles (optionally weighted by a switching function on the bond lengths). Older-style multicolvar shortcut.',
            fields: [
                { k: 'GROUPA', label: 'GROUPA (central)', type: 'atoms', def: '1-10', help: 'Central atoms about which angles are calculated. Use with GROUPB (+SWITCH).' },
                { k: 'GROUPB', label: 'GROUPB', type: 'atoms', def: '11-100' },
                { k: 'GROUPC', label: 'GROUPC (opt.)', type: 'atoms', def: '' },
                { k: 'GROUP', label: 'GROUP (single set)', type: 'atoms', def: '', help: 'Use instead of GROUPA/B/C to take every distinct triple in one group.' },
                { k: 'SWITCH', label: 'SWITCH (block)', type: 'text', def: '{GAUSSIAN R_0=1.0}', help: 'Only bonds shorter than this switching function contribute. Required when using GROUPA/GROUPB.' }
            ]
        },
        TORSIONS: {
            cat: 'angles', act: 'TORSIONS', compStyle: 'underscore',
            desc: 'Functions of a distribution of torsional angles. Specify each torsion with numbered ATOMS keywords or MOLINFO @phi/@psi selectors.',
            fields: [
                { k: 'ATOMS', label: 'ATOMS (numbered)', type: 'text', def: 'ATOMS1=1,2,3,4 ATOMS2=5,6,7,8', required: true, help: 'Numbered four-atom sets, e.g. ATOMS1=.. ATOMS2=.. (or @phi-3/@psi-3 with MOLINFO).' }
            ]
        },
        XANGLES: {
            cat: 'angles', act: 'XANGLES', compStyle: 'underscore',
            desc: 'Angles between atom-pair vectors and the positive x axis (also YANGLES/ZANGLES via the variant field).',
            fields: [
                { k: '__variant', label: 'Axis', type: 'select', def: 'XANGLES', options: ['XANGLES','YANGLES','ZANGLES'], variant: true, help: 'Which Cartesian axis the angle is measured against.' },
                { k: 'ATOMS', label: 'ATOMS (numbered pairs)', type: 'text', def: 'ATOMS1=3,5 ATOMS2=1,2', required: true, help: 'Numbered atom pairs, e.g. ATOMS1=3,5 ATOMS2=1,2.' }
            ]
        },
        XYTORSIONS: {
            cat: 'angles', act: 'XYTORSIONS', compStyle: 'underscore',
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
                { k: 'SWITCH', label: 'SWITCH (block)', type: 'text', def: '{RATIONAL R_0=1.0}', required: true, help: 'Only bonds shorter than this switching function are considered.' }
            ]
        },
        INPLANEDISTANCES: {
            cat: 'geometry', act: 'INPLANEDISTANCES', compStyle: 'underscore',
            desc: 'Perpendicular distances between a group of atoms and an axis (defined by two atoms) — i.e. distances within the plane perpendicular to that axis.',
            fields: [
                { k: 'VECTORSTART', label: 'VECTORSTART', type: 'atoms', def: '1', required: true, help: 'First atom defining the axis.' },
                { k: 'VECTOREND', label: 'VECTOREND', type: 'atoms', def: '2', required: true, help: 'Second atom defining the axis.' },
                { k: 'GROUP', label: 'GROUP', type: 'atoms', def: '3-100', required: true, help: 'Atoms whose in-plane distances are computed.' }
            ]
        },
        PLANES: {
            cat: 'shape', act: 'PLANES', compStyle: 'underscore', reductions: [],
            desc: 'Normals to the planes containing groups of three atoms; VMEAN/VSUM give the norm of the mean/sum vector (orientational order of the planes).',
            fields: [
                { k: 'ATOMS', label: 'ATOMS (numbered triples)', type: 'text', def: 'ATOMS1=9,10,11 ATOMS2=89,90,91', required: true, help: 'Numbered three-atom sets, e.g. ATOMS1=9,10,11 ATOMS2=89,90,91.' },
                { k: 'VMEAN', label: 'VMEAN', type: 'flag', def: true, help: 'Output the norm of the mean of the plane-normal vectors.' },
                { k: 'VSUM', label: 'VSUM', type: 'flag', def: false, help: 'Output the norm of the sum of the plane-normal vectors.' }
            ]
        },
        CONSTANT: {
            cat: 'custom', act: 'CONSTANT', noBias: true,
            desc: 'Return one or more constant values (with or without derivatives). Not biased itself — use it as a fixed reference/target inside a CUSTOM/MATHEVAL combination, e.g. diff: CUSTOM ARG=cv,ref FUNC=x-y.',
            fields: [
                { k: 'VALUE', label: 'VALUE (single)', type: 'text', def: '', help: 'A single constant, referenced by the bare label. Leave blank if you use VALUES instead.' },
                { k: 'VALUES', label: 'VALUES (comma list)', type: 'text', def: '1.0,2.0', help: 'A list of constants, referenced as label.v-0, label.v-1, ... Leave blank if you use VALUE instead.' },
                { k: 'NODERIV', label: 'NODERIV', type: 'flag', def: false, help: 'Output the values without derivatives (set when the constant is not differentiated).' }
            ]
        },
        MASS: {
            cat: 'custom', desc: 'Extracts the masses of one or multiple atoms.',
            fields: [
                { k: 'ATOMS', label: 'ATOMS', type: 'atoms', def: '1', required: true }
            ]
        },
        CHARGE: {
            cat: 'custom', desc: 'Extracts the charges of one or multiple atoms.',
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
            cat: 'custom', desc: 'Write any PLUMED action line yourself — the label is added automatically. Use this for CVs not in the catalogue, MATHEVAL/CUSTOM combinations, or advanced options.',
            isCustom: true,
            fields: [
                { k: '__raw', label: 'Full action (after the label)', type: 'text', def: 'DISTANCE ATOMS=1,2', required: true,
                  help: 'Everything after "label:". Example: COORDINATION GROUPA=1-10 GROUPB=20-40 R_0=0.3 NLIST NL_CUTOFF=0.5 NL_STRIDE=100' }
            ]
        }
    };

    // Stamp each def with its catalogue key so helpers (e.g. plumedDocUrl) can
    // resolve the action name when a def omits an explicit `act`.
    Object.keys(PLUMED_CV_DEFS).forEach(k => { PLUMED_CV_DEFS[k].__key = k; });

    // Concise example use-cases per CV, shown under the description. Kept in one
    // block so they are easy to extend. Keyed by catalogue key; a def may also
    // carry its own `example` which takes precedence.
    const PLUMED_CV_EXAMPLES = {
        GROUP: 'Load ice-binding face atoms once from an index file (NDX_FILE=atoms.ndx NDX_GROUP=binding_face) and reuse the label in later CVs.',
        COM: 'Track the centre of mass of a protein so a restraint follows the molecule as it diffuses.',
        DISTANCE: 'Monitor an end-to-end distance of a polymer, or the separation between an ion and a binding site.',
        ANGLE: 'Follow the bend of a three-atom motif, e.g. a hydrogen-bond donor–H–acceptor angle.',
        TORSION: 'Bias a backbone φ/ψ dihedral to sample different protein conformations.',
        DIHEDRAL_CORRELATION: 'Measure how correlated two adjacent backbone dihedrals are along a chain.',
        DIHCOR: 'Summed similarity of consecutive dihedral pairs — a compact descriptor of local chain order.',
        COORDINATION: 'Count water molecules in the first hydration shell of an ion to follow (de)solvation.',
        CONTACTMAP: 'Track many native contacts at once to follow folding/unfolding.',
        COORDINATIONNUMBER_ADV: 'Per-atom coordination number of interfacial waters to detect ordering near a clay slab.',
        COORDINATION_MOMENTS: 'Higher moments of the neighbour-distance distribution to distinguish liquid vs ordered shells.',
        COORD_ANGLES: 'Distribution of bond angles in the first shell — sensitive to local packing geometry.',
        GYRATION: 'Follow the compactness (radius of gyration) of a polymer or peptide during collapse.',
        TETRA_RADIAL: 'Detect ice-like tetrahedral ordering of water near a surface from radial geometry.',
        TETRA_ANGULAR: 'Angular tetrahedral order of water to distinguish liquid from ice-like layers.',
        TETRAHEDRAL: 'Shell-averaged tetrahedrality to monitor disruption of ordered water at an interface.',
        PLANES: 'Orientational order of planar molecules (e.g. aromatic rings) via their plane normals.',
        RMSD: 'Distance from a folded reference structure to drive folding/unfolding.',
        DRMSD: 'Distance-based RMSD that avoids alignment — useful for flexible or periodic systems.',
        PCARMSD: 'Project motion onto PCA eigenvectors to bias along dominant collective modes.',
        PATHMSD: 'Progress (s) and distance (z) along a predefined transition path between two states.',
        PROPERTYMAP: 'Map the system onto arbitrary reference properties for path-like sampling.',
        Q6: 'Sixth-order Steinhardt parameter to distinguish crystalline from liquid local order during nucleation.',
        Q4: 'Fourth-order Steinhardt parameter — sensitive to cubic/FCC-like local order.',
        Q3: 'Third-order Steinhardt parameter for local bond-orientational order.',
        COORDINATIONNUMBER: 'Classic per-atom coordination number for density/neighbour analysis.',
        LOCAL_Q6: 'Local Q6 (averaged with neighbours) to identify solid-like nuclei without system-size artifacts.',
        LOCAL_Q4: 'Local Q4 for neighbour-averaged cubic order during crystallization.',
        LOCAL_Q3: 'Local Q3 for neighbour-averaged bond-orientational order.',
        SMAC: 'Detect crystal-like molecular packing from relative orientations, e.g. in nucleation of molecular crystals.',
        ATOMIC_SMAC: 'Atomic variant of SMAC for ordered vs disordered atomic environments.',
        FCCUBIC: 'Measure FCC-like local structure to count solid-like atoms at a solid–liquid interface.',
        POSITION: 'Track an atom or centre along a chosen axis (e.g. permeation through a channel).',
        PROJECTION_ON_AXIS: 'Project a position onto a defined axis — e.g. depth of a ligand along a pore.',
        PLANE: 'Represent a planar group orientation via its normal vector.',
        CELL: 'Follow simulation-cell components under variable-cell (e.g. NPT phase transitions).',
        VOLUME: 'Bias the box volume to explore density changes or pressure-driven transitions.',
        DIPOLE: 'Track the dipole moment of a group — e.g. reorientation of water in a field.',
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
        ANGLES: 'Distribution of many bond angles at once — e.g. counting near-tetrahedral angles in a shell.',
        TORSIONS: 'Count how many of a set of torsions fall in a target range (e.g. helical φ/ψ).',
        XANGLES: 'Angle of atom-pair vectors to a Cartesian axis — orientational order relative to a surface normal.',
        XYTORSIONS: 'Torsion of atom-pair vectors around a Cartesian axis — anisotropic orientational order.',
        ALPHABETA: 'Similarity of a set of dihedrals to reference values — a soft "how native" descriptor.',
        INPLANEDISTANCES: 'Count atoms inside a cylinder around an axis, e.g. waters in a pore cross-section.',
        CONSTANT: 'Provide a fixed target value to subtract inside a CUSTOM combination (e.g. diff: CUSTOM ARG=cv,ref FUNC=x-y).',
        MASS: 'Expose atom masses for use inside a CUSTOM/MATHEVAL expression.',
        CHARGE: 'Expose atom charges for use inside a CUSTOM/MATHEVAL expression.',
        EXTRACV: 'Read a CV computed natively by the MD engine (e.g. an alchemical lambda).',
        CUSTOM: 'Combine existing CVs with an arbitrary function, e.g. a normalized local order parameter.'
    };

    // the PLUMED bias module source (Restraint, MovingRestraint, WallsScalar,
    // MetaD, PBMetaD, ABMD).
    // Note: SIGMA is no longer defined globally for metadynamics methods.
    // It is configured per-CV dynamically within the CV cards to respect individual thermal fluctuations.
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
            { k: 'PACE', label: 'PACE', def: '500', help: 'How often (in MD steps) a hill is deposited. Smaller = more frequent, faster filling but more overhead.' }
        ]},
        wt_metad: { cat: 'metad', label: 'Well-Tempered Metadynamics', params: [
            { k: 'HEIGHT', label: 'HEIGHT', def: '1.2', help: 'Initial hill height (energy units). In well-tempered MetaD the height is progressively scaled down.' },
            { k: 'PACE', label: 'PACE', def: '500', help: 'Steps between hill deposition.' },
            { k: 'BIASFACTOR', label: 'BIASFACTOR', def: '10', help: 'Well-tempered bias factor γ. Higher = explores higher free-energy barriers; typical range 5–20. Needs TEMP.' },
            { k: 'TEMP', label: 'TEMP (K)', def: '300', help: 'System temperature. Required for well-tempered metadynamics.' }
        ]},
        pbmetad: { cat: 'metad', label: 'Parallel-Bias Metadynamics (PBMETAD)', params: [
            { k: 'HEIGHT', label: 'HEIGHT', def: '1.2', help: 'Initial hill height (energy units).' },
            { k: 'PACE', label: 'PACE', def: '500', help: 'Steps between hill deposition.' },
            { k: 'BIASFACTOR', label: 'BIASFACTOR', def: '10', help: 'Well-tempered bias factor γ (typical 5–20).' },
            { k: 'TEMP', label: 'TEMP (K)', def: '300', help: 'System temperature.' }
        ]},
        opes: { cat: 'metad', label: 'OPES (probability enhanced)', module: 'opes', params: [
            { k: 'PACE', label: 'PACE', def: '500', help: 'How often (steps) a kernel is deposited.' },
            { k: 'BARRIER', label: 'BARRIER', def: '30', help: 'The largest free-energy barrier (energy units) you expect to cross. The single most important OPES setting — it also sets BIASFACTOR, EPSILON and KERNEL_CUTOFF to sensible values. Set it a bit above your estimated barrier.' },
            { k: 'TEMP', label: 'TEMP (K)', def: '300', help: 'System temperature. If your MD code passes it to PLUMED you can leave the emitted default.' },
            { k: 'SIGMA', label: 'SIGMA', def: 'ADAPTIVE', help: 'Initial kernel widths. Leave as ADAPTIVE (recommended) to let OPES estimate them from the fluctuations; or give one value per biased CV to fix them.' }
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

        // Array jobs request --mem PER TASK, so the in-flight total is
        // multiplied by the number of concurrent tasks. A default left
        // untouched on a large array can wedge the queue.
        if (isArray && jMem) {
            const m = String(jMem).trim().match(/^(\d+(?:\.\d+)?)\s*([GMT])B?$/i);
            const rm = getStr('jobArrayRange', '').match(/^(\d+)\s*-\s*(\d+)(?::\d+)?(?:%(\d+))?/);
            if (m && rm) {
                const per = parseFloat(m[1]);
                const unit = m[2].toUpperCase();
                const nTasks = parseInt(rm[2], 10) - parseInt(rm[1], 10) + 1;
                const cap = rm[3] ? parseInt(rm[3], 10) : nTasks;
                const concurrent = Math.min(cap, nTasks);
                warnings.push(
                    `Array job: <code>--mem=${jMem}</code> is per <em>task</em>. With ${concurrent} task${concurrent > 1 ? 's' : ''} running concurrently that is <strong>${(per * concurrent)}${unit}</strong> in flight. ` +
                    `Confirm this fits your partition limit — if not, cap concurrency in the array range (e.g. <code>${rm[1]}-${rm[2]}%4</code>).`
                );
            } else {
                warnings.push('Array job: <code>--mem</code> is requested per <em>task</em>, so the in-flight total is multiplied by the number of concurrent tasks. Confirm it fits your partition.');
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
            warnings.push('<strong>Action needed in your .mdp:</strong> <code>-update gpu</code> (GPU-resident mode) <strong>requires <code>constraints = h-bonds</code></strong> (or <code>all-bonds</code>). Without it <code>grompp</code> fails before <code>mdrun</code> ever starts — the error comes from your .mdp, not from this script. GPU-resident mode also disables dynamic load balancing; for efficiency use infrequent T/P coupling and a larger <code>nstcalcenergy</code>.');
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
        // GROMACS executable name. Many HPC modules ship the MPI build as
        // gmx_mpi, so this is user-settable rather than hardcoded.
        const gmxBin = (getStr('gmxBinary', 'gmx') || 'gmx').trim() || 'gmx';
        if (/\s/.test(gmxBin)) {
            warnings.push(`The GROMACS executable name "<code>${gmxBin}</code>" contains a space. Use just the command name (e.g. <code>gmx</code> or <code>gmx_mpi</code>).`);
        }
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

        // If GPU-resident mode is on, put the .mdp requirement INTO the script.
        // UI warnings are lost the moment someone copies the file, and grompp
        // fails before mdrun runs — users otherwise blame the generated script.
        if (isChecked('gpuUpdate')) {
            s += `# ==============================================================\n`;
            s += `# IMPORTANT - '-update gpu' requires this in EVERY MD .mdp file:\n`;
            s += `#     constraints = h-bonds      ; (or all-bonds)\n`;
            s += `# Without it grompp FAILS before mdrun starts. That error comes\n`;
            s += `# from the .mdp, not from this script.\n`;
            s += `# ==============================================================\n\n`;
        }

        let prev = null; // previous stage (for -c / -t wiring)
        stages.forEach((st, i) => {
            const tpr = `${st.deffnm}.tpr`;
            s += `# ---- ${st.key.toUpperCase()} ----\n`;

            // grompp: -c from previous stage .gro (or initial conf), -r for restraints,
            // -t from previous .cpt for continuation (NPT onward / production).
            let grompp = `${gmxBin} grompp -f ${st.mdp} -p ${topol}${ndxFlag}`;
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
            let mdrun = `${gmxBin} mdrun -deffnm ${st.deffnm}${stageGpu} -pin on`;            if (st.key !== 'em') {
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
    // ---------------------------------------------------------------------
    // Multi-component (dot-notation) support.
    // Given a CV instance, return the list of named components it exposes so
    // the UI can offer "label.component" choices and PRINT can expand them.
    // Multicolvars advertise their scalar reductions via def.components; a few
    // legacy CVs have fixed component names handled explicitly below.
    // ---------------------------------------------------------------------
    // ---------------------------------------------------------------------
    // Multi-component support (dot- vs underscore-style).
    //
    // PLUMED exposes two component-access conventions and which one a CV uses
    // depends on how the action is implemented:
    //   * Classic v2.9 multicolvars (COORDINATIONNUMBER, TETRAHEDRAL, Q6, SMAC,
    //     FCCUBIC, DISTANCES, ...) expose real value components -> label.mean
    //     (DOT). Verified against the v2.9 colvar docs.
    //   * Shortcut-expanded reductions (the ANGLES/TORSIONS/PLANES/COORD_ANGLES
    //     family) are separate actions created by MultiColvarShortcuts, whose
    //     labels are label_mean, label_lessthan, ... (UNDERSCORE).
    //   * A few CVs are pure scalars (DIHCOR, ALPHABETA): the label itself is
    //     the value, so there is no component suffix at all.
    // Each CV therefore declares compStyle: 'dot' | 'underscore' | 'none'.
    //
    // The reduction menu itself is shared: every multicolvar can reduce its
    // per-atom vector with any of these. Flag-type reductions (MEAN, SUM, ...)
    // are toggles; block-type ones (MORE_THAN, LESS_THAN, BETWEEN) carry a
    // switching-function/kernel block and only appear when filled in.
    // ---------------------------------------------------------------------
    const MULTICOLVAR_REDUCTIONS = [
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
    const REDUCTION_BY_KEY = Object.fromEntries(MULTICOLVAR_REDUCTIONS.map(r => [r.k, r]));

    // Return the reduction field descriptors a multicolvar CV supports but does
    // NOT already declare explicitly in def.fields (so each field has exactly
    // one source and never renders twice). A def may restrict the menu via
    // def.reductions (list of keys); otherwise the whole shared menu applies.
    function reductionFieldsFor(def) {
        if (!def || (!def.compStyle && !def.isMulticolvar)) return [];
        if (def.compStyle === 'none') return [];
        const allow = Array.isArray(def.reductions) ? def.reductions : MULTICOLVAR_REDUCTIONS.map(r => r.k);
        const already = new Set((def.fields || []).map(f => f.k));
        return MULTICOLVAR_REDUCTIONS.filter(r => allow.includes(r.k) && !already.has(r.k));
    }

    // All reduction descriptors relevant to a def, whether declared inline in
    // def.fields or supplied by the shared menu. Used to resolve components.
    function allReductionsFor(def) {
        if (!def || def.compStyle === 'none') return [];
        const allow = Array.isArray(def.reductions) ? def.reductions : MULTICOLVAR_REDUCTIONS.map(r => r.k);
        return MULTICOLVAR_REDUCTIONS.filter(r => allow.includes(r.k));
    }

    // Is a given reduction currently switched on for this instance?
    function reductionEnabled(inst, r) {
        const v = inst.values[r.k];
        if (r.type === 'flag') return !!v;
        return !!(v && String(v).trim());
    }

    const CV_FIXED_COMPONENTS = {
        PATHMSD: ['s', 'z'],
        PROJECTION_ON_AXIS: ['proj', 'ext'],
        PLANE: ['x', 'y', 'z'],
        PCARMSD: ['residual']
    };
    // Return the component SUFFIXES (including separator) a CV exposes, e.g.
    // ['.mean', '.morethan'] or ['_mean', '_lessthan']. An empty suffix ('')
    // means "use the bare label" (scalars and single-value CVs).
    function componentsForCV(inst) {
        const def = PLUMED_CV_DEFS[inst.type] || {};
        if (CV_FIXED_COMPONENTS[inst.type]) return CV_FIXED_COMPONENTS[inst.type].map(c => '.' + c);
        // PLANES exposes VMEAN/VSUM norm components (underscore-style) per flag.
        if (inst.type === 'PLANES') {
            const out = [];
            if (inst.values.VMEAN) out.push('_vmean');
            if (inst.values.VSUM)  out.push('_vsum');
            return out;
        }
        // CONSTANT: VALUES=a,b,c exposes indexed components label.v-0, label.v-1
        // ...; VALUE=x (singular) is referenced by the bare label instead.
        if (inst.type === 'CONSTANT') {
            const vals = String(inst.values.VALUES || '').trim();
            if (vals) {
                const n = vals.split(',').map(s => s.trim()).filter(Boolean).length;
                return Array.from({ length: n }, (_, i) => `.v-${i}`);
            }
            return []; // single VALUE -> bare label
        }
        // COMPONENTS flag turns a vector CV (DISTANCE, DIPOLE) into x/y/z.
        if (inst.values && inst.values.COMPONENTS) return ['.x', '.y', '.z'];
        const style = def.compStyle;
        if (style === 'none') return [];              // pure scalar: bare label only
        if (style === 'dot' || style === 'underscore') {
            const sep = (style === 'underscore') ? '_' : '.';
            const rfields = allReductionsFor(def);
            // If the def enumerates an explicit component list, intersect with it.
            const allowComp = Array.isArray(def.components) ? new Set(def.components) : null;
            return rfields
                .filter(r => (!allowComp || allowComp.has(r.comp)) && reductionEnabled(inst, r))
                .map(r => sep + r.comp);
        }
        return [];
    }
    // Does this CV type reduce to a bare scalar (no component suffix)?
    function isScalarCV(inst) {
        const def = PLUMED_CV_DEFS[inst.type] || {};
        return def.compStyle === 'none';
    }

    // ---------------------------------------------------------------------
    // Bias-dependent parameter elimination.
    // PLUMED physics means some bias methods internally manage parameters that
    // would then be redundant (or conflicting) on the CV definition. This map
    // is intentionally declarative so the parameters to hide can be edited
    // without touching rendering logic:  { <biasMethod>: { <ACTION|"*">: [KEYS] } }.
    // "*" applies to every CV; an action key narrows it to that CV type.
    // ---------------------------------------------------------------------
    const biasRedundancyMap = {
        // Well-tempered / standard MetaD lay hills on a grid the tool defines,
        // so a per-CV neighbour list on the CV is not what controls MetaD cost;
        // hide the NL_* knobs to avoid the impression they tune the bias.
        wt_metad: { '*': ['NL_CUTOFF', 'NL_STRIDE'] },
        metad:    { '*': ['NL_CUTOFF', 'NL_STRIDE'] },
        // OPES manages its own kernel bandwidth adaptively; the per-CV MORE_THAN
        // reduction is meaningless as a biased quantity here.
        opes:     { '*': ['MORE_THAN', 'LESS_THAN'] }
    };
    // Return the set of field keys to hide for a given CV under the active bias.
    function hiddenFieldsForBias(inst) {
        const method = getStr('plumedBias', 'none');
        const map = biasRedundancyMap[method];
        if (!map || !inst.bias) return new Set();          // only biased CVs are affected
        const keys = new Set();
        (map['*'] || []).forEach(k => keys.add(k));
        const act = (PLUMED_CV_DEFS[inst.type] || {}).act || inst.type;
        (map[act] || []).forEach(k => keys.add(k));
        (map[inst.type] || []).forEach(k => keys.add(k));  // also allow catalogue-key targeting
        return keys;
    }

    // Emit a single "KEY=value" (or bare flag / block) token for one field.
    // Handles the three shapes used by the catalogue:
    //   flag            -> pushes just the keyword when truthy
    //   {...} block text -> pushes "KEY={...}" (e.g. SWITCH, KERNEL1, MORE_THAN)
    //   free-form text   -> if the value already contains "KEY=" pairs it is a
    //                       raw fragment and is passed through verbatim
    //   everything else  -> "KEY=value"
    function pushFieldToken(parts, f, val) {
        if (f.variant) return;   // __variant only selects the action name
        if (f.type === 'flag') { if (val) parts.push(f.k); return; }
        if (val === undefined || String(val).trim() === '') return;
        const v = String(val).trim();
        if (f.type === 'text') {
            if (v.startsWith('{')) { parts.push(`${f.k}=${v}`); return; }     // block value
            if (/\w+=/.test(v) && !/^[\d.,\-]+$/.test(v)) { parts.push(v); return; } // raw "K=V ..." fragment
        }
        parts.push(`${f.k}=${v}`);
    }

    // Declared fields plus any shared reduction fields the def does not itself
    // list. This is the authoritative field list for both rendering and output.
    function allFieldsFor(def) {
        return (def.fields || []).concat(reductionFieldsFor(def));
    }

    function buildCVLine(inst) {
        const def = PLUMED_CV_DEFS[inst.type];
        if (!def) return '';
        // Custom: the raw field IS the whole action after the label.
        if (def.isCustom) {
            const raw = (inst.values.__raw || '').trim();
            return `${inst.label}: ${raw}`;
        }
        // The emitted action keyword can differ from the catalogue key
        // (e.g. COORDINATIONNUMBER_ADV -> COORDINATIONNUMBER). Variant CVs pick
        // the action name from a __variant selector field (XANGLES/YANGLES/...).
        let actName = def.act || inst.type;
        const variantField = (def.fields || []).find(f => f.variant);
        if (variantField && inst.values[variantField.k]) actName = inst.values[variantField.k];
        const parts = [actName];
        // Skip any field the active bias method manages/eliminates so the
        // generated line stays consistent with what the CV card shows.
        const hidden = hiddenFieldsForBias(inst);
        const emit = (p, f, v) => { if (!hidden.has(f.k)) pushFieldToken(p, f, v); };
        // For order-parameter CVs, fold R_0/D_0/D_MAX into a single SWITCH={...}
        // block. Specifying D_MAX makes PLUMED use linked cells (large speedup).
        const switchKeys = def.switchSpeed ? ['R_0', 'D_0', 'D_MAX', 'NN', 'MM'] : [];
        if (def.switchSpeed) {
            const sw = [];
            switchKeys.forEach(k => {
                const v = inst.values[k];
                if (v !== undefined && String(v).trim() !== '') sw.push(`${k}=${String(v).trim()}`);
            });
            allFieldsFor(def).forEach(f => {
                if (switchKeys.includes(f.k)) return; // handled in SWITCH block
                emit(parts, f, inst.values[f.k]);
            });
            if (sw.length) parts.push(`SWITCH={RATIONAL ${sw.join(' ')}}`);
            return `${inst.label}: ${parts.join(' ')}`;
        }
        // Two-group COORDINATION: when D_MAX is given, use a SWITCH={...} block
        // (enables linked cells); otherwise keep the bare R_0/NN/MM keywords.
        if (def.coordSwitch) {
            const useSwitch = inst.values.D_MAX !== undefined && String(inst.values.D_MAX).trim() !== '';
            const swKeys = ['R_0', 'D_0', 'NN', 'MM', 'D_MAX'];
            allFieldsFor(def).forEach(f => {
                if (useSwitch && swKeys.includes(f.k)) return; // folded into SWITCH
                emit(parts, f, inst.values[f.k]);
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
        allFieldsFor(def).forEach(f => emit(parts, f, inst.values[f.k]));
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
        if (inst.type === 'CONSTANT') {
            const hasValue  = inst.values.VALUE  && String(inst.values.VALUE).trim() !== '';
            const hasValues = inst.values.VALUES && String(inst.values.VALUES).trim() !== '';
            if (hasValue && hasValues) {
                warnings.push(`CONSTANT (${inst.label}) sets both <code>VALUE</code> and <code>VALUES</code> — use one or the other, not both.`);
            } else if (!hasValue && !hasValues) {
                warnings.push(`CONSTANT (${inst.label}) needs a <code>VALUE</code> (single) or <code>VALUES</code> (list).`);
            }
        }
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
        // Multiple walkers. Two mutually exclusive modes:
        //   'mpi'  -> WALKERS_MPI (requires a multi-replica launch)
        //   'disk' -> WALKERS_N/ID/DIR/RSTRIDE (independent jobs sharing a dir)
        // The legacy checkbox id is still honoured so older saved states work.
        const walkersMode = (function () {
            const m = getStr('plumedWalkersMode', '');
            if (m) return m;
            return isChecked('plumedWalkers') ? 'mpi' : 'none';
        })();
        const useWalkers = walkersMode === 'mpi';
        // Emit the walker keywords for a given action, honouring the mode.
        // `allowDisk` is false for OPES, which supports MPI walkers only.
        const walkerLines = (allowDisk) => {
            if (walkersMode === 'mpi') return `    WALKERS_MPI\n`;
            if (walkersMode === 'disk') {
                if (!allowDisk) return `    WALKERS_MPI\n`;  // OPES: MPI only
                const wn = getStr('plumedWalkersN', '4').trim() || '4';
                const wid = getStr('plumedWalkersId', '0').trim() || '0';
                const wdir = getStr('plumedWalkersDir', '../hills').trim() || '../hills';
                const wrs = getStr('plumedWalkersRstride', '100').trim() || '100';
                return `    WALKERS_N=${wn}\n    WALKERS_ID=${wid}\n    WALKERS_DIR=${wdir}\n    WALKERS_RSTRIDE=${wrs}\n`;
            }
            return '';
        };
        const stride = getStr('plumedStride', '500');
        const molinfo = getStr('plumedMolinfo', '');
        const useWhole = isChecked('plumedWhole');
        const wholeResidues = isChecked('plumedWholeResidues');
        const wholeEntities = getStr('plumedWholeEntities', '');
        const printFile = getStr('plumedPrintFile', 'COLVAR');
        const printStride = getStr('plumedPrintStride', stride);
        const printExtra = getStr('plumedPrintExtra', '');
        const uLength = getStr('plumedUnitLength', 'nm');
        const uEnergy = getStr('plumedUnitEnergy', 'kj/mol');
        const uTime   = getStr('plumedUnitTime', 'ps');

        let s = `# ==================================================================\n`;
        s += `# PLUMED input (plumed.dat)  -  generated by stemkit.net\n`;
        s += `# Target: PLUMED v${targetVersion()} (colvar + bias modules).\n`;
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

        // Optional WHOLEMOLECULES: reconstruct molecules split by PBC. Must come
        // before the CVs that depend on it, so it is emitted here (after MOLINFO).
        if (useWhole) {
            let wmLine = '';
            if (wholeResidues) {
                wmLine = `WHOLEMOLECULES RESIDUES=all MOLTYPE=protein`;
                if (!molinfo) warnings.push('<code>WHOLEMOLECULES RESIDUES=all</code> needs a MOLINFO reference structure — set one above.');
            } else {
                const ents = wholeEntities.split(/[\n,]+/).map(e => e.trim()).filter(Boolean);
                if (ents.length) {
                    wmLine = 'WHOLEMOLECULES ' + ents.map((e, i) => `ENTITY${i}=${e}`).join(' ');
                } else {
                    warnings.push('<code>WHOLEMOLECULES</code> is enabled but no entities are listed — add an atom range (e.g. 1-100) or switch to RESIDUES=all.');
                }
            }
            if (wmLine) {
                s += `# --- Reconstruct whole molecules across PBC (must precede the CVs) ---\n`;
                s += wmLine + `\n\n`;
            }
        }

        if (!plumedCVs.length) {
            s += `# (No collective variables added yet - add one on the left.)\n`;
            out.textContent = s;
            setWarnings($('slurmWarnings'), warnings);
            return;
        }

        // Module & prerequisite scan: collect any non-core modules and
        // input-level prerequisites the chosen CVs depend on, so we can both
        // annotate the file header and raise warnings. Modules can be required
        // by CVs and/or by the selected bias method; we track why so the warning
        // is accurate.
        const usedModules = new Map();   // module key -> Set of reasons ('CV'/'bias')
        const noteModule = (key, reason) => {
            if (!key || !PLUMED_MODULES[key]) return;
            if (!usedModules.has(key)) usedModules.set(key, new Set());
            usedModules.get(key).add(reason);
        };
        const usedPrereqs = new Set();
        plumedCVs.forEach(c => {
            const d = PLUMED_CV_DEFS[c.type] || {};
            if (d.module) noteModule(d.module, 'CV');
            // Prereqs can be conditional (e.g. WHOLEMOLECULES not needed for DRMSD).
            if (d.prereq && PLUMED_PREREQS[d.prereq]) {
                const skip = (d.prereqSkipIf && d.prereqSkipIf(c));
                if (!skip) usedPrereqs.add(d.prereq);
            }
        });
        // The selected bias method may itself live in a non-core module (e.g.
        // OPES lives in the opes module) — but only if it is actually emitted
        // (a bias with no biased CVs produces nothing). n is computed further
        // below, so count biased CVs locally here.
        const biasDef = PLUMED_BIAS_DEFS[bias];
        const nBiasedForModule = plumedCVs.filter(c => c.bias && !c.isGroup).length;
        if (biasDef && biasDef.module && nBiasedForModule > 0) noteModule(biasDef.module, 'bias');
        if (usedModules.size) {
            s += `# --- Build requirements ---\n`;
            usedModules.forEach((reasons, m) => {
                const who = reasons.has('CV') && reasons.has('bias') ? 'A CV and the bias method'
                          : reasons.has('bias') ? 'The selected bias method'
                          : 'One or more CVs';
                s += `# Requires the ${PLUMED_MODULES[m].name} module. ${PLUMED_MODULES[m].hint}\n`;
                warnings.push(`${who} need${who === 'One or more CVs' ? '' : 's'} the <strong>${PLUMED_MODULES[m].name}</strong> module, which is not in a stock PLUMED build. ${PLUMED_MODULES[m].hint}`);
            });
            s += `\n`;
        }
        if (usedPrereqs.size) {
            usedPrereqs.forEach(p => {
                // If the prerequisite is WHOLEMOLECULES and the user has already
                // enabled emission of it, the requirement is satisfied — no warning.
                if (p === 'wholemolecules' && useWhole) return;
                warnings.push(`One or more CVs ${PLUMED_PREREQS[p].note}` +
                    (p === 'wholemolecules' ? ' Enable “Rebuild whole molecules (WHOLEMOLECULES)” above to emit it.' : ''));
            });
        }

        // 1) CV definitions
        s += `# --- Collective variables ---\n`;
        plumedCVs.forEach(inst => {
            plumedWarningsForCV(inst, warnings);
            s += buildCVLine(inst) + `\n`;
        });
        s += `\n`;

        // Filter for CVs actively feeding into the bias ARG list
        const biasedCVs = plumedCVs.filter(c => c.bias && !c.isGroup);
        const n = biasedCVs.length;

        // Bias needs at least one biased CV
        const biasNeedsArg = (bias !== 'none');
        if (biasNeedsArg && n === 0) {
            warnings.push('A bias method is selected but no CV is marked “Bias”. Tick “Bias” on at least one CV, or set the method to “None”.');
        }

        const biasArg = biasedCVs.map(c => c.label + (c.biasValues.comp || '')).join(',');
        const gridMin = biasedCVs.map(c => c.biasValues.min).join(',');
        const gridMax = biasedCVs.map(c => c.biasValues.max).join(',');
        const gridBin = biasedCVs.map(c => c.biasValues.bin).join(',');
        const sigmas  = biasedCVs.map(c => c.biasValues.sigma).join(',');

        // -----------------------------------------------------------------
        // Grid-bounds sanity checks. A wrong GRID_MIN/GRID_MAX does not crash
        // the run — it silently distorts the free-energy surface — so these
        // are worth flagging loudly before a long metadynamics job.
        // -----------------------------------------------------------------
        // Only meaningful for the metadynamics family (grid + hills).
        const gridRelevant = ['wt_metad', 'metad', 'pbmetad', 'opes'].includes(bias) && n > 0;
        if (gridRelevant) {
            // CVs whose natural range is periodic on [-pi, pi].
            const PERIODIC_TYPES = ['TORSION', 'TORSIONS', 'PUCKERING', 'DIHEDRAL_CORRELATION',
                                    'ALPHABETA', 'XYTORSIONS', 'XANGLES', 'ANGLES', 'ANGLE'];
            // CVs whose natural range is [0, 1]-ish (order parameters).
            const UNIT_TYPES = ['TETRAHEDRAL', 'LOCAL_Q6', 'LOCAL_Q4', 'LOCAL_Q3',
                                'FCCUBIC', 'SMAC', 'ATOMIC_SMAC', 'TETRA_RADIAL', 'TETRA_ANGULAR',
                                'Q6', 'Q4', 'Q3'];
            const numOrNull = (v) => {
                const t = String(v ?? '').trim();
                if (/^-?pi$/i.test(t)) return (t[0] === '-' ? -Math.PI : Math.PI);
                const n = parseFloat(t);
                return Number.isFinite(n) ? n : null;
            };
            biasedCVs.forEach(c => {
                const lo = numOrNull(c.biasValues.min);
                const hi = numOrNull(c.biasValues.max);
                const sg = numOrNull(c.biasValues.sigma);
                const nb = numOrNull(c.biasValues.bin);
                const isPeriodic = PERIODIC_TYPES.includes(c.type);
                const isUnit     = UNIT_TYPES.includes(c.type);

                if (lo === null || hi === null) {
                    warnings.push(`Grid bounds for <code>${c.label}</code> are not numeric — check GRID MIN/MAX (use numbers, or <code>-pi</code>/<code>pi</code> for angles).`);
                    return;
                }
                if (hi <= lo) {
                    warnings.push(`<strong>Grid error:</strong> <code>${c.label}</code> has GRID_MAX (${c.biasValues.max}) ≤ GRID_MIN (${c.biasValues.min}). The run will fail or produce nonsense.`);
                    return;
                }
                // Periodic CV on a clearly non-periodic grid: almost certainly wrong.
                if (isPeriodic && (lo < -Math.PI - 1e-6 || hi > Math.PI + 1e-6 || (lo >= 0 && hi > 3.2))) {
                    warnings.push(`<strong>Check grid bounds:</strong> <code>${c.label}</code> (${c.type}) is periodic on <code>-pi..pi</code>, but its grid is ${c.biasValues.min}..${c.biasValues.max}. Metadynamics on a mismatched grid silently distorts the free-energy surface. Set GRID MIN/MAX to <code>-pi</code>/<code>pi</code>.`);
                }
                // Order parameter left on the generic 0..10 default.
                if (isUnit && hi > 2) {
                    warnings.push(`<strong>Check grid bounds:</strong> <code>${c.label}</code> (${c.type}) normally lies in <code>0..1</code>, but its grid runs to ${c.biasValues.max}. Most of the grid would never be visited.`);
                }
                // Untouched generic default on a CV with no type-specific default.
                if (!isPeriodic && !isUnit &&
                    String(c.biasValues.min).trim() === '0.0' && String(c.biasValues.max).trim() === '10.0') {
                    warnings.push(`<code>${c.label}</code> is still using the generic default grid <code>0.0..10.0</code>. Confirm this actually covers the range your CV explores — hills outside the grid are an error in PLUMED.`);
                }
                // Grid far too coarse/fine relative to SIGMA.
                if (sg && nb && sg > 0 && nb > 0) {
                    const spacing = (hi - lo) / nb;
                    if (spacing > sg) {
                        warnings.push(`<code>${c.label}</code>: grid spacing (${spacing.toFixed(4)}) is wider than SIGMA (${sg}). Increase GRID BIN so at least a few bins fall inside one Gaussian, or the bias is poorly resolved.`);
                    }
                }
                if (sg && sg > 0 && (hi - lo) < 4 * sg) {
                    warnings.push(`<code>${c.label}</code>: the grid spans less than 4×SIGMA. Widen GRID MIN/MAX or reduce SIGMA.`);
                }
            });
        }

        const perCV = (method, key) => {
            const v = String(biasVal(method, key) ?? '').trim();
            if (v === '') return '';
            if (v.includes(',')) return v; // user provided explicit list
            return Array(n).fill(v).join(',');
        };

        const scalar = (method, key) => String(biasVal(method, key) ?? '').trim();
        let biasComponents = [];   // components to optionally add to PRINT

        // Dimensionality Guardrails
        if ((bias === 'metad' || bias === 'wt_metad') && n > 2) {
            warnings.push('Standard Metadynamics with &gt; 2 CVs scales poorly and requires massive grid memory. Consider reducing biased CVs or switching to PBMETAD / OPES.');
        }
        if (useGrid && n > 3) {
            warnings.push(`A ${n}D grid will allocate massive amounts of RAM and may crash PLUMED. Use PBMETAD or disable the grid.`);
        }

        // ---- Multiple-walkers validation -------------------------------
        if (walkersMode !== 'none' && n > 0) {
            if (walkersMode === 'mpi') {
                warnings.push('<strong><code>WALKERS_MPI</code> only does something in a multi-replica run.</strong> Launch the replicas as one MPI job (e.g. <code>mpirun -np N gmx_mpi mdrun -multidir w0 w1 …</code>, or <code>plumed --multi N</code>). On a single-rank job this silently reduces to one walker, and the run looks fine but shares no bias.');
            }
            if (walkersMode === 'disk') {
                const wn = parseInt(getStr('plumedWalkersN', '4'), 10);
                const wid = getStr('plumedWalkersId', '0').trim();
                const widNum = parseInt(wid, 10);
                if (Number.isFinite(wn) && Number.isFinite(widNum) && widNum >= wn) {
                    warnings.push(`<strong>Walker id out of range:</strong> <code>WALKERS_ID=${wid}</code> must be between 0 and ${wn - 1} for <code>WALKERS_N=${wn}</code>.`);
                }
                if (/^\d+$/.test(wid)) {
                    warnings.push(`Every walker needs a <strong>different</strong> <code>WALKERS_ID</code>, but this file hardcodes <code>${wid}</code>. Generate one file per walker, or set it from the array index (e.g. <code>WALKERS_ID=\${SLURM_ARRAY_TASK_ID}</code>) and template the file at submit time.`);
                }
                warnings.push('All walkers must share the same <code>WALKERS_DIR</code> and it must exist before the run starts (<code>mkdir -p</code> it in the job script).');
                if (bias === 'opes') {
                    warnings.push('OPES supports <strong>MPI walkers only</strong> — the shared-directory keywords do not apply, so <code>WALKERS_MPI</code> was emitted instead. Switch to MPI mode, or use METAD/PBMETAD for disk-based walkers.');
                }
            }
        }

        if ((bias === 'metad' || bias === 'wt_metad') && n > 0) {
            const wt = (bias === 'wt_metad');
            s += `# --- ${wt ? 'Well-Tempered ' : ''}Metadynamics ---\n`;
            s += `metad: METAD ...\n`;
            s += `    ARG=${biasArg}\n`;
            s += `    PACE=${scalar(bias, 'PACE') || stride}\n`;
            s += `    HEIGHT=${scalar(bias, 'HEIGHT')}\n`;
            s += `    SIGMA=${sigmas}\n`;
            if (wt) { s += `    BIASFACTOR=${scalar(bias, 'BIASFACTOR')}\n    TEMP=${scalar(bias, 'TEMP')}\n`; }
            s += `    FILE=HILLS\n`;
            if (useGrid) {
                s += `    GRID_MIN=${gridMin}\n`;
                s += `    GRID_MAX=${gridMax}\n`;
                s += `    GRID_BIN=${gridBin}\n`;
            }
            if (useRct)     s += `    CALC_RCT RCT_USTRIDE=10\n`;
            s += walkerLines(true);
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
            s += `    SIGMA=${sigmas}\n`;
            s += `    BIASFACTOR=${scalar(bias, 'BIASFACTOR')}\n    TEMP=${scalar(bias, 'TEMP')}\n`;
            s += `    FILE=${biasedCVs.map(c => 'HILLS.' + c.label).join(',')}\n`;
            if (useGrid) {
                s += `    GRID_MIN=${gridMin}\n`;
                s += `    GRID_MAX=${gridMax}\n`;
                s += `    GRID_BIN=${gridBin}\n`;
            }
            s += walkerLines(true);
            s += `... PBMETAD\n\n`;
            biasComponents = ['pb.bias'];
        } else if (bias === 'opes' && n > 0) {
            s += `# --- OPES (well-tempered target; opes module) ---\n`;
            s += `opes: OPES_METAD ...\n`;
            s += `    ARG=${biasArg}\n`;
            s += `    PACE=${scalar(bias, 'PACE') || stride}\n`;
            s += `    BARRIER=${scalar(bias, 'BARRIER')}\n`;
            s += `    TEMP=${scalar(bias, 'TEMP')}\n`;
            // SIGMA defaults to ADAPTIVE, which is the recommended mode. Only
            // emit an explicit SIGMA line if the user set fixed widths. BARRIER
            // already sets BIASFACTOR/EPSILON/KERNEL_CUTOFF, so we do NOT hardcode
            // BIASFACTOR (that would override the sensible auto value).
            const opesSigma = (scalar(bias, 'SIGMA') || 'ADAPTIVE').trim();
            if (opesSigma && opesSigma.toUpperCase() !== 'ADAPTIVE') {
                s += `    SIGMA=${sigmas}\n`;
            } else {
                s += `    # SIGMA is ADAPTIVE by default (estimated from the fluctuations)\n`;
            }
            s += `    FILE=Kernels.data\n`;
            s += `    STATE_WFILE=State.data\n`;
            s += `    STATE_WSTRIDE=${Math.max(parseInt(stride, 10) * 20 || 10000, 10000)}\n`;
            if (n >= 2) s += `    NLIST   # neighbour list over kernels speeds up multi-CV OPES\n`;
            s += walkerLines(false);   // OPES supports MPI walkers only
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

        // 3) PRINT — Must explicitly expand multi-component variables
        s += `# --- Output ---\n`;
        let printList = [];
        
        plumedCVs.filter(c => !c.isGroup).forEach(c => {
            const comps = componentsForCV(c);   // suffixes already include the separator
            if (comps.length) {
                comps.forEach(suffix => printList.push(c.label + suffix));
            } else {
                printList.push(c.label);
            }
        });

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
        const ver = targetVersion();
        cvSel.innerHTML = '';
        Object.keys(PLUMED_CV_DEFS)
            .filter(name => PLUMED_CV_DEFS[name].cat === cat)
            .forEach(name => {
                const def = PLUMED_CV_DEFS[name];
                const opt = document.createElement('option');
                opt.value = name;
                // Version-gated CVs stay visible (so users can discover them) but
                // are disabled and flagged when the target version is too low.
                if (!cvAvailable(def, ver)) {
                    opt.textContent = `${name}  (needs PLUMED ≥ ${def.minVersion})`;
                    opt.disabled = true;
                } else {
                    opt.textContent = name;
                }
                cvSel.appendChild(opt);
            });
        // Ensure the selected option isn't a disabled one.
        if (cvSel.selectedOptions.length && cvSel.selectedOptions[0].disabled) {
            const firstEnabled = Array.from(cvSel.options).find(o => !o.disabled);
            if (firstEnabled) cvSel.value = firstEnabled.value;
        }
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

        // Module-availability note for the selected bias method (e.g. OPES lives
        // in the opes module and needs a custom PLUMED build).
        const bmod = def && def.module && PLUMED_MODULES[def.module];
        if (bmod) {
            const mn = document.createElement('p');
            mn.className = 'text-[9px] leading-snug mb-2 px-1.5 py-1 rounded bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800/40';
            mn.innerHTML = `<i class="fa-solid fa-cube mr-1"></i>Requires the <strong>${bmod.name}</strong> module — not in a stock PLUMED build. <span class="plumed-help" tabindex="0" data-tip="${bmod.hint.replace(/"/g,'&quot;')}">?</span>`;
            host.appendChild(mn);
        }

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
        if (!def) { descEl.textContent = ''; return; }
        let html = escapeHtml(def.desc || '');
        const example = def.example || PLUMED_CV_EXAMPLES[cvSel.value];
        if (example) {
            html += ` <span class="plumed-cv-example"><strong>Example use-case:</strong> ${escapeHtml(example)}</span>`;
        }
        if (!cvAvailable(def)) {
            html += ` <span class="plumed-cv-gate"><strong>Needs PLUMED ≥ ${escapeHtml(def.minVersion)}</strong> (your target is ${escapeHtml(targetVersion())}).` +
                (def.fallback ? ` On ${escapeHtml(targetVersion())} use <code>${escapeHtml(def.fallback)}</code> instead.` : '') +
                `</span>`;
        }
        const url = plumedDocUrl(def);
        if (url) {
            html += ` <a class="plumed-doclink" href="${url}" target="_blank" rel="noopener">See documentation ↗</a>`;
        }
        descEl.innerHTML = html;
    }

    function addPlumedCV() {
        const cvSel = $('plumedCVSelect');
        if (!cvSel || !cvSel.value) return;
        const type = cvSel.value;
        const def = PLUMED_CV_DEFS[type];
        // Defense in depth: never add a CV that the target version cannot parse.
        if (!cvAvailable(def)) {
            setWarnings($('slurmWarnings'), [
                `${type} needs PLUMED ≥ ${def.minVersion}; your target is ${targetVersion()}. ` +
                (def.fallback ? `On ${targetVersion()} use ${def.fallback} instead.` : 'Switch the target version to use it.')
            ]);
            return;
        }
        const seq = ++plumedCVSeq;
        
        let comp = '', min = '0.0', max = '10.0', bin = '200', sigma = '0.1';
        if (type === 'PATHMSD') { min = '1.0'; max = '10.0'; sigma = '0.5'; comp = '.s'; }
        else if (type === 'PROJECTION_ON_AXIS') { min = '-5.0'; max = '5.0'; sigma = '0.1'; comp = '.proj'; }
        else if (['TORSION', 'PUCKERING', 'DIHEDRAL_CORRELATION'].includes(type)) { min = '-pi'; max = 'pi'; sigma = '0.1'; }
        else if (type === 'ANGLE') { min = '0.0'; max = 'pi'; sigma = '0.1'; }
        else if (['DISTANCE','RMSD','DRMSD','GYRATION','ERMSD','CONTACTMAP','COORDINATION','COORDINATIONNUMBER','DIPOLE','POSITION'].includes(type)) { min = '0.0'; max = '5.0'; sigma = '0.05'; }
        else if (type === 'PCARMSD') { comp = '.residual'; }
        else if (type === 'PROPERTYMAP') { comp = '.zzz'; }
        // Multicolvars (order parameters, tetrahedrality, SMAC, FCCUBIC, the
        // angle/torsion family, ...) output named components. Give the [0,1]-ish
        // descriptors a tighter grid than the generic distance default. The
        // default biased component is resolved after the instance is built,
        // once its reduction flags are seeded.
        const isMC = !!(def.compStyle && def.compStyle !== 'none');
        if (isMC) {
            if (['TETRA_RADIAL','TETRA_ANGULAR','TETRAHEDRAL','LOCAL_Q6','LOCAL_Q4','LOCAL_Q3','FCCUBIC','SMAC','ATOMIC_SMAC'].includes(type)) {
                min = '0.0'; max = '1.0'; bin = '200'; sigma = '0.02';
            } else if (['COORDINATIONNUMBER_ADV','COORDINATION_MOMENTS'].includes(type)) {
                min = '0.0'; max = '20.0'; bin = '200'; sigma = '0.1';
            } else if (['ANGLES','TORSIONS','XANGLES','YANGLES','ZANGLES',
                        'XYTORSIONS','XZTORSIONS','YXTORSIONS','YZTORSIONS','ZXTORSIONS','ZYTORSIONS'].includes(type)) {
                min = '-pi'; max = 'pi'; sigma = '0.1';
            } else if (['COORD_ANGLES','INPLANEDISTANCES'].includes(type)) {
                min = '0.0'; max = '5.0'; sigma = '0.1';
            }
        }

        const inst = {
            id: `cv${seq}`,
            type,
            label: `cv${seq}`,
            // GROUP/COM are atom-definitions (not printed, not biased). CONSTANT
            // and similar noBias CVs ARE printed/usable as ARG references but are
            // never a bias target.
            bias: !def.isGroup && !def.noBias,
            isGroup: !!def.isGroup,
            noBias: !!def.noBias,
            values: {},
            biasValues: { comp, min, max, bin, sigma }
        };
        def.fields.forEach(f => { inst.values[f.k] = f.def; });
        // Seed the shared reduction fields (MEAN, SUM, MORE_THAN, ...) for
        // multicolvars so the component picker and output stay consistent.
        reductionFieldsFor(def).forEach(r => { inst.values[r.k] = r.def; });
        // A multicolvar must reduce to at least one scalar to be usable, so
        // default MEAN on when the CV exposes it and nothing else is preset.
        if (isMC && inst.values.MEAN === false && allReductionsFor(def).some(r => r.k === 'MEAN')) {
            const anyOn = allReductionsFor(def).some(r => reductionEnabled(inst, r));
            if (!anyOn) inst.values.MEAN = true;
        }
        // Now that reductions are seeded, pick a sensible default component.
        if (isMC) {
            const comps = componentsForCV(inst);            // suffix-carrying
            inst.biasValues.comp = comps.length ? comps[0] : '';
        } else if (def.compStyle === 'none') {
            inst.biasValues.comp = '';
        }
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
            if (!inst.isGroup && !inst.noBias) {
                const biasLbl = document.createElement('label');
                biasLbl.className = 'flex items-center gap-1 text-[10px] font-bold uppercase cursor-pointer ' +
                    (inst.bias ? 'text-rose-600 dark:text-rose-400' : 'text-slate-400');
                biasLbl.title = 'Feed this CV to the bias (unchecked = tracked/printed only)';
                biasLbl.innerHTML = `<input type="checkbox" data-cv="${inst.id}" data-field="__bias" ${inst.bias ? 'checked' : ''} class="w-3.5 h-3.5 text-rose-600 rounded focus:ring-rose-500"> Bias`;
                right.appendChild(biasLbl);
            } else if (inst.noBias) {
                const tag = document.createElement('span');
                tag.className = 'text-[9px] font-bold uppercase text-slate-400';
                tag.title = 'This action is a reference value, not a bias target. It is printed and can be used as an ARG in a CUSTOM combination.';
                tag.textContent = 'ref only';
                right.appendChild(tag);
            }
            const rm = document.createElement('button');
            rm.className = 'text-slate-400 hover:text-rose-500 text-xs';
            rm.innerHTML = '<i class="fa-solid fa-trash"></i>';
            rm.addEventListener('click', () => removePlumedCV(inst.id));
            right.appendChild(rm);
            head.appendChild(right);
            card.appendChild(head);

            // Concise example use-case + documentation link for this CV.
            const cardExample = def.example || PLUMED_CV_EXAMPLES[inst.type];
            const cardDocUrl = plumedDocUrl(def, inst);
            if (cardExample || cardDocUrl) {
                const ex = document.createElement('p');
                ex.className = 'plumed-cv-example text-slate-500 dark:text-slate-400 mb-1.5 leading-snug';
                let exHtml = '';
                if (cardExample) exHtml += escapeHtml(cardExample) + ' ';
                if (cardDocUrl) exHtml += `<a class="plumed-doclink" href="${cardDocUrl}" target="_blank" rel="noopener">See documentation ↗</a>`;
                ex.innerHTML = exHtml;
                card.appendChild(ex);
            }

            // Module-availability + input-prerequisite notices for this CV.
            const mod = def.module && PLUMED_MODULES[def.module];
            if (mod) {
                const mn = document.createElement('p');
                mn.className = 'text-[9px] leading-snug mb-1.5 px-1.5 py-1 rounded bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800/40';
                mn.innerHTML = `<i class="fa-solid fa-cube mr-1"></i>Requires the <strong>${mod.name}</strong> module — not in a stock PLUMED build. <span class="plumed-help" tabindex="0" data-tip="${mod.hint.replace(/"/g,'&quot;')}">?</span>`;
                card.appendChild(mn);
            }
            const prq = def.prereq && PLUMED_PREREQS[def.prereq];
            if (prq) {
                const pn = document.createElement('p');
                pn.className = 'text-[9px] leading-snug mb-1.5 px-1.5 py-1 rounded bg-sky-50 dark:bg-sky-900/20 text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800/40';
                pn.innerHTML = `<i class="fa-solid fa-circle-info mr-1"></i>Needs a <code>${prq.label}</code> line. <span class="plumed-help" tabindex="0" data-tip="${prq.note.replace(/"/g,'&quot;')}">?</span>`;
                card.appendChild(pn);
            }

            const grid = document.createElement('div');
            grid.className = 'grid grid-cols-2 gap-2';
            const helpFor = (f) => {
                const h = (f.help || PLUMED_KEY_HELP[f.k] || '').replace(/"/g, '&quot;');
                return h ? `<span class="plumed-help" tabindex="0" data-tip="${h}">?</span>` : '';
            };
            // Fields the active bias makes redundant are shown but disabled
            // (blacked-out) so users can see they don't apply for this method,
            // rather than silently disappearing. They are still excluded from
            // the generated output (see buildCVLine).
            const disabledSet = hiddenFieldsForBias(inst);
            let disCount = 0;
            const biasName = (PLUMED_BIAS_DEFS[getStr('plumedBias','none')] || {}).label || 'the selected bias';
            const renderField = (f, host) => {
                const off = disabledSet.has(f.k);
                if (off) disCount++;
                const dTip = off ? ` data-tip="Managed by ${escapeHtml(biasName)} — this parameter doesn't apply here and is left out of the output."` : '';
                const wrap = document.createElement('div');
                if (off) wrap.classList.add('plumed-field-off');
                const dis = off ? 'disabled' : '';
                if (f.type === 'flag') {
                    wrap.className = 'col-span-2 flex items-center gap-2' + (off ? ' plumed-field-off' : '');
                    wrap.innerHTML = `
                        <input type="checkbox" data-cv="${inst.id}" data-field="${f.k}" ${inst.values[f.k] ? 'checked' : ''} ${dis}
                               class="w-3.5 h-3.5 text-rose-600 rounded focus:ring-rose-500">
                        <label class="text-[11px] text-slate-600 dark:text-slate-300"${off ? ' tabindex="0"'+dTip.replace('data-tip','data-tip').replace(/^ /,' ') : ''}>${f.label}</label>${off ? `<span class="plumed-help" tabindex="0"${dTip}>?</span>` : helpFor(f)}`;
                } else if (f.type === 'select') {
                    const opts = f.options.map(o => `<option value="${o}" ${o===inst.values[f.k]?'selected':''}>${o}</option>`).join('');
                    wrap.innerHTML = `
                        <label class="text-[9px] font-bold text-slate-400 flex items-center gap-1">${f.label}${off ? `<span class="plumed-help" tabindex="0"${dTip}>?</span>` : helpFor(f)}</label>
                        <select data-cv="${inst.id}" data-field="${f.k}" ${dis}
                                class="w-full bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 border border-slate-300 dark:border-slate-600 rounded px-1.5 py-1 text-[11px] mt-0.5 outline-none focus:ring-2 focus:ring-rose-500">${opts}</select>`;
                } else {
                    wrap.innerHTML = `
                        <label class="text-[9px] font-bold text-slate-400 flex items-center gap-1">${f.label}${off ? `<span class="plumed-help" tabindex="0"${dTip}>?</span>` : helpFor(f)}</label>
                        <input type="text" data-cv="${inst.id}" data-field="${f.k}" value="${inst.values[f.k] ?? ''}" ${dis}
                               class="w-full bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 border border-slate-300 dark:border-slate-600 rounded px-1.5 py-1 text-[11px] mt-0.5 font-mono outline-none focus:ring-2 focus:ring-rose-500">`;
                }
                host.appendChild(wrap);
            };
            (def.fields || []).forEach(f => renderField(f, grid));
            card.appendChild(grid);

            // Shared reduction menu for multicolvars, in its own labelled block
            // so the (up to nine) reductions don't crowd the main parameters.
            const shared = reductionFieldsFor(def);
            if (shared.length) {
                const secLbl = document.createElement('p');
                secLbl.className = 'text-[9px] font-bold text-slate-400 uppercase mt-2 mb-1 flex items-center gap-1';
                secLbl.innerHTML = `Reductions <span class="plumed-help" tabindex="0" data-tip="Reduce the per-atom vector to scalar CVs. Toggle a flag (MEAN, SUM, HIGHEST, LOWEST) or give a switching/kernel block (MORE_THAN, LESS_THAN, BETWEEN, MIN, MAX). Each enabled reduction becomes a selectable component (${inst.label}${(componentsForCV(inst)[0]||(def.compStyle==='underscore'?'_mean':'.mean'))}).">?</span>`;
                card.appendChild(secLbl);
                const rgrid = document.createElement('div');
                rgrid.className = 'grid grid-cols-2 gap-2';
                shared.forEach(f => renderField(f, rgrid));
                card.appendChild(rgrid);
            }
            if (disCount) {
                const hn = document.createElement('p');
                hn.className = 'text-[9px] text-slate-400 italic mt-1.5 leading-snug';
                hn.innerHTML = `<i class="fa-solid fa-ban mr-1"></i>${disCount} field${disCount > 1 ? 's' : ''} greyed out — managed by the selected bias method and left out of the output.`;
                card.appendChild(hn);
            }

            // Bias Settings Accordion Extender
            if (!inst.isGroup && !inst.noBias) {
                const biasWrap = document.createElement('div');
                biasWrap.className = `mt-3 pt-3 border-t border-slate-200 dark:border-slate-700 bg-rose-50/50 dark:bg-rose-900/10 p-2 rounded-lg ${inst.bias ? 'block' : 'hidden'}`;

                // Multi-component CVs get a dropdown so the user picks the exact
                // component (e.g. ".mean" for a v2.9 multicolvar or "_lessthan"
                // for a shortcut-expanded reduction) and the tool appends it to
                // the bias ARG automatically. componentsForCV returns suffixes
                // that already carry the right separator. Pure-scalar CVs show a
                // read-only note; other CVs keep a free-text field.
                const compList = componentsForCV(inst);   // e.g. ['.mean','_lessthan']
                let compControl;
                if (compList.length) {
                    const cur = inst.biasValues.comp || '';
                    // If the current stored suffix is no longer valid, snap to the first.
                    const curValid = compList.includes(cur) ? cur : compList[0];
                    const opts = compList.map(suffix =>
                        `<option value="${suffix}" ${curValid === suffix ? 'selected' : ''}>${inst.label}${suffix}</option>`
                    ).join('');
                    compControl = `
                        <select data-cv-bias="${inst.id}" data-field="comp"
                                class="w-full bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 border border-slate-300 dark:border-slate-600 rounded px-1.5 py-1 text-[11px] mt-0.5 font-mono outline-none focus:ring-2 focus:ring-rose-500">${opts}</select>`;
                } else if (isScalarCV(inst)) {
                    compControl = `<p class="text-[10px] text-slate-400 italic mt-0.5">Scalar CV — bias uses the bare label <code>${inst.label}</code> (no component).</p>`;
                } else {
                    compControl = `<input type="text" data-cv-bias="${inst.id}" data-field="comp" value="${inst.biasValues.comp || ''}" placeholder="e.g. .sss" class="w-full bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 border border-slate-300 dark:border-slate-600 rounded px-1.5 py-1 text-[11px] mt-0.5 font-mono outline-none focus:ring-2 focus:ring-rose-500">`;
                }

                biasWrap.innerHTML = `
                    <div class="mb-2">
                        <label class="text-[9px] font-bold text-rose-600 flex items-center gap-1 uppercase">Target Component <span class="plumed-help" tabindex="0" data-tip="The specific component to bias if the CV outputs multiple (dot notation, e.g. ${inst.label}.mean). Leave blank for scalar CVs.">?</span></label>
                        ${compControl}
                    </div>
                    <div class="grid grid-cols-4 gap-2">
                        <div>
                            <label class="text-[9px] font-bold text-rose-600 flex items-center gap-1 uppercase">Grid Min</label>
                            <input type="text" data-cv-bias="${inst.id}" data-field="min" value="${inst.biasValues.min}" class="w-full bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 border border-slate-300 dark:border-slate-600 rounded px-1.5 py-1 text-[11px] mt-0.5 font-mono outline-none focus:ring-2 focus:ring-rose-500">
                        </div>
                        <div>
                            <label class="text-[9px] font-bold text-rose-600 flex items-center gap-1 uppercase">Grid Max</label>
                            <input type="text" data-cv-bias="${inst.id}" data-field="max" value="${inst.biasValues.max}" class="w-full bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 border border-slate-300 dark:border-slate-600 rounded px-1.5 py-1 text-[11px] mt-0.5 font-mono outline-none focus:ring-2 focus:ring-rose-500">
                        </div>
                        <div>
                            <label class="text-[9px] font-bold text-rose-600 flex items-center gap-1 uppercase">Grid Bin</label>
                            <input type="text" data-cv-bias="${inst.id}" data-field="bin" value="${inst.biasValues.bin}" class="w-full bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 border border-slate-300 dark:border-slate-600 rounded px-1.5 py-1 text-[11px] mt-0.5 font-mono outline-none focus:ring-2 focus:ring-rose-500">
                        </div>
                        <div>
                            <label class="text-[9px] font-bold text-rose-600 flex items-center gap-1 uppercase">Sigma <span class="plumed-help" tabindex="0" data-tip="Width of the Gaussian hill (SIGMA) for this CV.">?</span></label>
                            <input type="text" data-cv-bias="${inst.id}" data-field="sigma" value="${inst.biasValues.sigma}" class="w-full bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 border border-slate-300 dark:border-slate-600 rounded px-1.5 py-1 text-[11px] mt-0.5 font-mono outline-none focus:ring-2 focus:ring-rose-500">
                        </div>
                    </div>
                `;
                card.appendChild(biasWrap);
            }
            
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
                // Fields that change which components a CV exposes (or its label,
                // shown inside the component options) need a card re-render so the
                // Target Component dropdown stays in sync. Any reduction toggle
                // (MEAN, SUM, MORE_THAN, ...) qualifies, as does COMPONENTS.
                const COMPONENT_AFFECTING = ['__label', 'COMPONENTS', 'VMEAN', 'VSUM', '__variant', 'VALUE', 'VALUES'].concat(
                    MULTICOLVAR_REDUCTIONS.map(r => r.k)
                );
                if (field === '__label') {
                    inst.label = t.value.trim() || inst.id;
                } else if (field === '__bias') {
                    inst.bias = t.checked;
                    renderPlumedCVList(); // refresh the Bias label colour and accordion
                    generatePlumedScript();
                    return;
                } else if (t.type === 'checkbox') {
                    inst.values[field] = t.checked;
                } else {
                    inst.values[field] = t.value;
                }
                if (COMPONENT_AFFECTING.includes(field)) {
                    // Keep the biased component valid if it just disappeared.
                    const comps = componentsForCV(inst);   // already suffix-carrying
                    if (comps.length && inst.biasValues.comp && !comps.includes(inst.biasValues.comp)) {
                        inst.biasValues.comp = comps[0];
                    }
                    renderPlumedCVList();
                }
                generatePlumedScript();
            });
        });
        
        // wire bias accordion edits (text inputs fire "input"; selects fire "change")
        host.querySelectorAll('[data-cv-bias]').forEach(el => {
            const evt = (el.tagName === 'SELECT') ? 'change' : 'input';
            el.addEventListener(evt, (e) => {
                const t = e.currentTarget;
                const inst = plumedCVs.find(c => c.id === t.getAttribute('data-cv-bias'));
                if (!inst) return;
                inst.biasValues[t.getAttribute('data-field')] = t.value;
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
        'gmxTopol','gmxStartConf','gmxIndex','gmxBinary','gpuNtmpi',
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
    if ($('plumedVersion')) $('plumedVersion').addEventListener('change', () => {
        populatePlumedCVSelect();   // re-mark gated CVs
        renderPlumedCVList();       // doc links + any version-dependent notes
        generatePlumedScript();     // header comment + doc base
    });
    if ($('plumedCategory')) $('plumedCategory').addEventListener('change', populatePlumedCVSelect);
    if ($('plumedCVSelect')) $('plumedCVSelect').addEventListener('change', updatePlumedCVDesc);
    if ($('plumedAddCV'))     $('plumedAddCV').addEventListener('click', addPlumedCV);
    if ($('plumedBias'))      $('plumedBias').addEventListener('change', () => {
        renderBiasParams();
        renderPlumedCVList(); // apply bias-dependent field elimination to the CV cards
    });
    ['plumedBias','plumedTemp','plumedStride','plumedMolinfo','plumedPrintFile','plumedPrintStride','plumedPrintExtra','plumedUnitLength','plumedUnitEnergy','plumedUnitTime'].forEach(id => {
        const el = $(id); if (el) { el.addEventListener('input', generatePlumedScript); el.addEventListener('change', generatePlumedScript); }
    });
    ['plumedGrid','plumedRct','plumedWalkers'].forEach(id => {
        const el = $(id); if (el) el.addEventListener('change', generatePlumedScript);
    });
    // Multiple-walkers mode: show the shared-directory fields only in disk mode.
    if ($('plumedWalkersMode')) $('plumedWalkersMode').addEventListener('change', (e) => {
        const w = $('plumedWalkersDisk');
        if (w) toggleVisibility(w, e.target.value === 'disk');
        generatePlumedScript();
    });
    ['plumedWalkersN','plumedWalkersId','plumedWalkersDir','plumedWalkersRstride'].forEach(id => {
        const el = $(id); if (el) el.addEventListener('input', generatePlumedScript);
    });
    // WHOLEMOLECULES controls: toggle the sub-panel and regenerate.
    if ($('plumedWhole')) $('plumedWhole').addEventListener('change', (e) => {
        const w = $('plumedWholeWrap');
        if (w) toggleVisibility(w, e.target.checked);
        generatePlumedScript();
    });
    if ($('plumedWholeResidues')) $('plumedWholeResidues').addEventListener('change', generatePlumedScript);
    if ($('plumedWholeEntities')) $('plumedWholeEntities').addEventListener('input', generatePlumedScript);

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

    // Docked script preview (stacked layout): collapse/expand so the user can
    // reclaim screen space for the settings without losing the script entirely.
    if ($('dockToggle')) {
        $('dockToggle').addEventListener('click', (e) => {
            const col = $('outputColumn');
            if (!col) return;
            const collapsed = col.classList.toggle('dock-collapsed');
            const btn = e.currentTarget;
            btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            const icon = btn.querySelector('i');
            const text = btn.querySelector('.dock-toggle-text');
            if (icon) icon.className = collapsed ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down';
            if (text) text.textContent = collapsed ? 'Show' : 'Hide';
        });
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