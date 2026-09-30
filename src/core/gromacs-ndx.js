/**
 * @module core/gromacs-ndx
 *
 * GROMACS index files (`.ndx`): the default groups `gmx make_ndx` makes, the
 * custom groups an MD set-up needs, and the file itself.
 *
 * Almost every `.mdp` option that names atoms (`tc-grps`, `energygrps`,
 * `pull-group1-name`, `freezegrps`, ...) resolves the name against an index
 * group, and grompp is unforgiving: a missing name, an atom in two
 * temperature-coupling groups, or a coupling set that leaves atoms out are
 * all fatal. The groups here are built the way GROMACS builds them, so a name
 * this module offers is a name grompp will find, holding the atoms it expects.
 *
 * ## Fidelity to make_ndx
 *
 * `defaultGroups` ports `analyse()`, `analyse_prot()` and `analyse_other()`
 * from `src/gromacs/topology/index.cpp` (GROMACS 2025.1) with their quirks
 * intact, and has been checked against `gmx make_ndx` byte for byte (see
 * `tools/check-gromacs-ndx.mjs`), except that a nameless group is written
 * `[ Group ]`: make_ndx writes `[  ]` for a blank residue name, which
 * GROMACS's own init_index reads back as atom numbers of the group before
 * it. Among the quirks worth knowing:
 *
 *   - Residue types come from `residuetypes.dat`, looked up case-sensitively
 *     (`Cal` is an ion, `CAL` is Other), and anything absent is "Other". So
 *     CHARMM's `TIP3` water and `SOD`/`CLA` ions are Other to GROMACS, which
 *     is why a CHARMM-GUI system has no `Water_and_ions` group.
 *   - `Prot-Masses` is compared with the group ten places back, not with
 *     `Protein`: it is left out when it equals whatever preceded `Protein`
 *     (usually `System`, so a protein-only system has no `Prot-Masses`).
 *   - Only the first of DNA, RNA or Other gets its category group; the
 *     per-residue-name groups then cover every residue that is not Protein,
 *     DNA, RNA or Water, ions included.
 *
 * `makeNdx` ports the make_ndx command language (`1 | 13`, `r LIG`,
 * `a CA & r 1-50`, `!a H*`, `splitres 3`, `name 20 Foo`, ...) so a group gets
 * exactly the name make_ndx would give it, which is what users type into an
 * `.mdp` file.
 *
 * ## Reading structures
 *
 * The structure is read here with GROMACS's own column rules rather than by
 * `core/structure.js`. The distinction matters for atom numbering, which is
 * the whole content of an index file: GROMACS reads a PDB residue name from
 * four columns (`POPC`, `TIP3`), stops at the first `ENDMDL`, keeps residue 0
 * and atoms whose coordinates it cannot read, and takes the residue name of a
 * `.gro` line with `sscanf("%5s")`. A parser that drops one line shifts every
 * atom number after it. A `core/structure.js` parse result is still accepted
 * everywhere a structure is, for convenience, with the caveat that its PDB
 * residue names are cut to three characters.
 *
 * Atoms are numbered from 1 by their position in the file, as GROMACS
 * numbers them; the serial written in the file (which wraps after 99 999) is
 * ignored. Coordinates are held in nanometre.
 *
 * ## Shapes
 *
 * A group is `{ name: string, atoms: number[] }`, atom numbers counted from 1,
 * in the order they are written. Functions that take a structure accept what
 * `readGromacsStructure` returns, or a `core/structure.js` parse result.
 */

import { elementSymbol } from './structure.js';
import {
  compileSelection, SpatialGrid, SOLVENT_RESIDUES, ION_RESIDUES, NUCLEIC_RESIDUES
} from './selection.js';

/* ------------------------------------------------------------------ *
 * Residue types
 * ------------------------------------------------------------------ */

/*
 * share/top/residuetypes.dat from GROMACS 2025.1 (identical in 2025.0), in
 * file order. GROMACS keeps the first type given for a name; the only repeat
 * in the file (HYP) repeats the same type.
 */
const RESIDUE_TYPE_SOURCE = [
  ['Protein', 'ABU ACE AIB ALA ARG ARGN ASN ASN1 ASP ASP1 ASPH ASPP ASH CT3 CYS CYS1 CYS2 CYSH ' +
    'DALA GLN GLU GLUH GLUP GLH GLY HIS HIS1 HISA HISB HISH HISD HISE HISP HSD HSE HSP HYP ' +
    'ILE LEU LSN LYS LYSN LYSH MELEU MET MEVAL NAC NME NHE NH2 PHE PHEH PHEU PHL PRO SER THR ' +
    'TRP TRPH TRPU TYR TYRH TYRU VAL PGLU HID HIE HIP LYP LYN CYN CYM CYX DAB ORN HYP NALA ' +
    'NGLY NSER NTHR NLEU NILE NVAL NASN NGLN NARG NHID NHIE NHIP NHISD NHISE NHISH NTRP NPHE ' +
    'NTYR NGLU NASP NLYS NORN NDAB NLYSN NPRO NHYP NCYS NCYS2 NMET NASPH NGLUH CALA CGLY CSER ' +
    'CTHR CLEU CILE CVAL CASN CGLN CARG CHID CHIE CHIP CHISD CHISE CHISH CTRP CPHE CTYR CGLU ' +
    'CASP CLYS CORN CDAB CLYSN CPRO CHYP CCYS CCYS2 CMET CASPH CGLUH'],
  ['DNA', 'DA DG DC DT DA5 DG5 DC5 DT5 DA3 DG3 DC3 DT3 DAN DGN DCN DTN'],
  ['RNA', 'A U C G RA RU RC RG RA5 RT5 RU5 RC5 RG5 RA3 RT3 RU3 RC3 RG3 RAN RTN RUN RCN RGN'],
  ['Water', 'SOL WAT HOH OHH TIP T3P T4P T5P T3H'],
  ['Ion', 'K NA CA MG CL ZN CU1 CU LI NA+ RB CS F CL- BR I OH Cal IB+']
];

/**
 * GROMACS's residue-type table: residue name to Protein, DNA, RNA, Water or
 * Ion. Keys are case-sensitive, as GROMACS's lookup effectively is.
 *
 * @type {Readonly<Object<string,string>>}
 */
export const RESIDUE_TYPES = (() => {
  const table = Object.create(null);
  for (const [type, names] of RESIDUE_TYPE_SOURCE) {
    for (const name of names.split(' ')) if (!(name in table)) table[name] = type;
  }
  return Object.freeze(table);
})();

/**
 * The type GROMACS gives a residue name: Protein, DNA, RNA, Water, Ion, or
 * Other for anything not in `residuetypes.dat`.
 *
 * @param {string} name
 * @returns {string}
 */
export function residueTypeOf(name) {
  return RESIDUE_TYPES[name] || 'Other';
}

/* ------------------------------------------------------------------ *
 * Residue roles (for suggestions, not for the default groups)
 * ------------------------------------------------------------------ */

/**
 * Water residue names in common force fields, beyond the few GROMACS knows:
 * CHARMM's TIP3, AMBER's WAT, OPC, and the Martini beads.
 */
export const WATER_NAMES = Object.freeze(new Set([
  ...SOLVENT_RESIDUES,
  'SOL', 'WAT', 'HOH', 'OHH', 'TIP', 'T3P', 'T4P', 'T5P', 'T3H',
  'TIP3', 'TIP4', 'TIP5', 'TP3', 'TP4', 'TP5', 'TP4E', 'T4E', 'SPC', 'SPCE', 'SPE', 'OPC',
  'OPC3', 'H2O', 'DOD', 'D2O', 'SWM4', 'SWM6', 'TIP3P', 'TIP4P',
  // Martini: standard, polarisable, antifreeze, small and tiny water.
  'W', 'PW', 'WF', 'SW', 'TW', 'BMW'
]));

/**
 * Ion residue names in common force fields: CHARMM's SOD, POT and CLA, AMBER's
 * `Na+`/`Cl-` spellings, and Martini's ION residue.
 */
export const ION_NAMES = Object.freeze(new Set([
  ...ION_RESIDUES,
  'K', 'NA', 'CA', 'MG', 'CL', 'ZN', 'CU1', 'CU', 'LI', 'NA+', 'RB', 'CS', 'F', 'CL-', 'BR',
  'I', 'OH', 'CAL', 'IB+', 'SOD', 'POT', 'CLA', 'CES', 'LIT', 'RUB', 'BAR', 'ZN2', 'CD2',
  'K+', 'LI+', 'RB+', 'CS+', 'F-', 'BR-', 'I-', 'MG2+', 'CA2+', 'ZN2+', 'ION'
]));

/**
 * Lipid residue names across CHARMM36, Slipids, Martini 2/3 and the AMBER
 * lipid force fields (whole-lipid names; AMBER's split head/tail residues are
 * in `AMBER_LIPID_HEADS` and `AMBER_LIPID_TAILS`). Sterols are included,
 * since they belong to the membrane.
 */
export const LIPID_NAMES = Object.freeze(new Set([
  // Phosphatidylcholines.
  'POPC', 'DPPC', 'DOPC', 'DMPC', 'DSPC', 'DLPC', 'DYPC', 'DAPC', 'DEPC', 'DGPC', 'DNPC',
  'DXPC', 'DIPC', 'DUPC', 'DRPC', 'DTPC', 'SOPC', 'SDPC', 'SAPC', 'SLPC', 'PLPC', 'PAPC',
  'PDPC', 'PIPC', 'PUPC', 'PGPC', 'PEPC', 'LPPC',
  // Phosphatidylethanolamines.
  'POPE', 'DPPE', 'DOPE', 'DMPE', 'DSPE', 'DLPE', 'DYPE', 'DAPE', 'DIPE', 'DUPE', 'SOPE',
  'SDPE', 'SAPE', 'SLPE', 'PLPE', 'PAPE', 'PIPE', 'PUPE', 'PDPE', 'PYPE', 'PMPE', 'PVPE', 'QMPE',
  // Phosphatidylglycerols, -serines, acids and inositols.
  'POPG', 'DPPG', 'DOPG', 'DMPG', 'DSPG', 'DLPG', 'DYPG', 'PVPG', 'PMPG', 'SOPG',
  'POPS', 'DPPS', 'DOPS', 'DMPS', 'DSPS', 'DLPS', 'DYPS', 'SOPS', 'SDPS', 'PAPS', 'PUPS',
  'POPA', 'DPPA', 'DOPA', 'DMPA', 'DLPA', 'SAPA',
  'POPI', 'SAPI', 'PAPI', 'PUPI', 'SAPI13', 'SAPI14', 'SAPI15', 'SAPI24', 'SAPI25', 'SAPI35',
  'POPI13', 'POPI14', 'POPI15', 'POPI24', 'POPI25', 'POPI35', 'POP1', 'POP2', 'POP3',
  // Cardiolipins.
  'TOCL1', 'TOCL2', 'TMCL1', 'TMCL2', 'CDL0', 'CDL1', 'CDL2',
  // Sphingolipids, ceramides and glycolipids.
  'PSM', 'SSM', 'NSM', 'DPSM', 'DBSM', 'DXSM', 'PNSM', 'POSM', 'CER160', 'CER180',
  'DPCE', 'DXCE', 'PNCE', 'GM1', 'GM3', 'DPG1', 'DPG3', 'DPGS', 'DBG1', 'DBG3', 'DBGS',
  'DPMG', 'DPSG', 'DPGG', 'OPMG', 'OPSG', 'OPGG', 'FPMG', 'FPSG', 'FPGG',
  // Sterols.
  'CHL1', 'CHOL', 'ERG', 'SITO', 'STIG', 'LANO', 'CHSD', 'CHSP'
]));

/**
 * AMBER Lipid14/17/21 split each lipid into head and tail residues. These
 * names are short and collide with other uses (AR is also argon, PA a tail
 * and not phosphatidic acid), so they count as lipid only when a head and a
 * tail appear together.
 */
export const AMBER_LIPID_HEADS = Object.freeze(new Set([
  'PC', 'PE', 'PS', 'PGR', 'PGS', 'PH-', 'PH', 'PI', 'SPM', 'CHL'
]));

/** Tails of the AMBER split-residue lipids; see `AMBER_LIPID_HEADS`. */
export const AMBER_LIPID_TAILS = Object.freeze(new Set([
  'LA', 'MY', 'PA', 'ST', 'OL', 'LEO', 'LEN', 'AR', 'DHA', 'LAL'
]));

/**
 * Nucleotide residue names GROMACS files under Other: CHARMM's ADE, GUA, CYT,
 * THY and URA (for DNA and RNA alike), with the one-letter and deoxy names
 * `core/selection.js` knows.
 */
export const NUCLEIC_NAMES = Object.freeze(new Set([
  ...NUCLEIC_RESIDUES, 'ADE', 'GUA', 'CYT', 'THY', 'URA'
]));

/**
 * Sugar residue names: the PDB chemical-component codes of the common
 * glycan monosaccharides, and CHARMM-GUI's names, whole and cut to the five
 * characters of a .gro file and the four of a PDB file (BGLCNA, BGLCN,
 * BGLC). GLYCAM's three-character codes (4YB, 0MA, VMB) are recognised by
 * their pattern. A sugar joined to the protein is part of the solute (role
 * 'glycan'); a free one is a ligand or a cosolvent like any other molecule.
 */
export const GLYCAN_NAMES = Object.freeze(new Set([
  // PDB: GlcNAc, GalNAc, mannose, galactose, glucose, fucose, xylose,
  // sialic acids, glucuronic and iduronic acids, glucosamines.
  'NAG', 'NDG', 'NGA', 'A2G', 'BMA', 'MAN', 'GAL', 'GLA', 'GLC', 'BGC', 'FUC', 'FUL',
  'XYS', 'XYP', 'SIA', 'SLB', 'NGC', 'NGE', 'GCU', 'BDP', 'IDR', 'SGN', 'GCS', 'PA1',
  // CHARMM-GUI Glycan Reader (alpha/beta prefix).
  'AGLC', 'BGLC', 'AGLCNA', 'BGLCNA', 'AGLCN', 'BGLCN', 'AGAL', 'BGAL', 'AGALNA', 'BGALNA',
  'AGALN', 'BGALN', 'AMAN', 'BMAN', 'AFUC', 'BFUC', 'AXYL', 'BXYL', 'ANE5AC', 'BNE5AC',
  'ANE5A', 'BNE5A', 'ANE5', 'BNE5', 'AGLCA', 'BGLCA', 'AIDOA', 'BIDOA', 'AIDO', 'BIDO',
  'ARHM', 'BRHM', 'AARB', 'BARB', 'AFRU', 'BFRU'
]));

/*
 * GLYCAM06 names are a linkage code (0-9 for none or one linkage, P-Z for
 * several), the sugar (upper case for D, lower case for L) and the ring form
 * (A/B for an alpha/beta pyranose, D/U for a furanose): 4YB is a 4-linked
 * beta-GlcNAc, 0MA a terminal alpha-mannose, VMB a 3,6-linked beta-mannose,
 * 0fA an alpha-L-fucose. The pattern is broad, so it only ever labels a
 * residue already found joined to the polymer (see `residueRoles`).
 */
const GLYCAM_NAME = /^[0-9P-Z][A-Za-z][ABDU]$/;

/* Whether a residue name may be a sugar: listed, or shaped like a GLYCAM name. */
function isGlycanName(name) {
  const n = String(name || '');
  return GLYCAN_NAMES.has(up(n)) || GLYCAM_NAME.test(n);
}

/* ------------------------------------------------------------------ *
 * Small string helpers with C semantics
 * ------------------------------------------------------------------ */

const NOTSET = -92637;

/** ASCII-only upper case, as C's toupper in the "C" locale. */
function up(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 97 && c <= 122 ? String.fromCharCode(c - 32) : s[i];
  }
  return out;
}

const plural = n => (n === 1 ? '' : 's');
const isDigit = c => c >= '0' && c <= '9' && c.length === 1;
const isAlpha = c => c.length === 1 && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));
const isAlnum = c => isDigit(c) || isAlpha(c);

/** gmx_strcasecmp() == 0 */
function caseEq(a, b) {
  return up(a) === up(b);
}

/** C strtol(s, nullptr, 10): leading space, sign and digits, else 0. */
function strtol(s) {
  const m = /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(s);
  return m ? parseInt(m[1], 10) : 0;
}

/** C strtod(s, nullptr) for plain decimal numbers, else 0. */
function strtod(s) {
  const m = /^[ \t\n\v\f\r]*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(s);
  return m ? parseFloat(m[1]) : 0;
}

/** Trim spaces only, as GROMACS's symbol table does. */
function trimSpaces(s) {
  return s.replace(/^ +/, '').replace(/ +$/, '');
}

/**
 * Lines as fgets2 gives them: newline removed, cut at the first CR. The
 * newline that ends the last line does not start another.
 */
function fileLines(text) {
  const lines = String(text).split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map(l => {
    const cr = l.indexOf('\r');
    return cr >= 0 ? l.slice(0, cr) : l;
  });
}

/* ------------------------------------------------------------------ *
 * Structure reading
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} GromacsStructure
 * @property {'gromacs-structure'} kind
 * @property {string} format - 'gro', 'pdb' or 'structure' (from core/structure.js).
 * @property {string} title
 * @property {Array<{name:string, resIndex:number, x:number, y:number, z:number,
 *   element:string}>} atoms - In file order; atom number = position + 1.
 *   Coordinates in nm; `element` is the PDB element column when given.
 * @property {Array<{name:string, nr:number, ic:string, chain:string,
 *   first:number, count:number}>} residues - As GROMACS splits them; `first`
 *   is the 0-based position of the first atom, `ic` the insertion code and
 *   `chain` the chain identifier (a space when there is none).
 * @property {number[][]|null} box - Box vectors as rows, in nm.
 * @property {string[]} errors - Problems GROMACS would stop on.
 * @property {string[]} warnings
 */

function emptyStructure(format) {
  return {
    kind: 'gromacs-structure', format, title: '', atoms: [], residues: [], box: null,
    errors: [], warnings: []
  };
}

function addAtom(top, name, x, y, z, element = '') {
  const resIndex = top.residues.length - 1;
  top.atoms.push({ name, resIndex, x, y, z, element });
  top.residues[resIndex].count += 1;
}

function addResidue(top, name, nr, ic, chain) {
  top.residues.push({ name, nr, ic, chain, first: top.atoms.length, count: 0 });
}

/*
 * Port of get_w_conf() in src/gromacs/fileio/groio.cpp. Coordinate width is
 * taken from the spacing of the decimal points on the first atom line, as
 * GROMACS does, so files written with more decimals read correctly.
 */
function readGro(text) {
  const top = emptyStructure('gro');
  const lines = fileLines(text);
  top.title = lines[0] || '';
  const count = /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(lines[1] || '');
  if (!count) {
    top.errors.push('The .gro file does not have the number of atoms on the second line.');
    return top;
  }
  const natoms = parseInt(count[1], 10);
  let ddist = 8;
  let resname = '';
  let oldResname = null;
  let oldRes = 0;
  for (let i = 0; i < natoms; i++) {
    const line = lines[2 + i];
    if (line === undefined) {
      top.errors.push(`Unexpected end of file at line ${i + 3}: ` +
        `the header promises ${natoms} atoms.`);
      break;
    }
    if (line.length < 39) {
      top.errors.push(`Invalid line for atom ${i + 1}: "${line}".`);
      break;
    }
    if (i === 0) {
      const p1 = line.indexOf('.');
      const p2 = p1 < 0 ? -1 : line.indexOf('.', p1 + 1);
      const p3 = p2 < 0 ? -1 : line.indexOf('.', p2 + 1);
      if (p3 < 0) top.errors.push('A coordinate does not contain a "." on the first atom line.');
      else if (p3 - p2 !== p2 - p1) {
        top.errors.push('The spacing of the decimal points is not consistent for x, y and z.');
      } else ddist = p2 - p1;
    }
    const resnr = strtol(line.slice(0, 5));
    // sscanf(line + 5, "%5s"): the first word from column 6, at most five
    // characters, which may run into the atom-name field. When there is no
    // word at all the previous residue name is kept.
    const word = /^[ \t\n\v\f\r]*([^ \t\n\v\f\r]{1,5})/.exec(line.slice(5));
    if (word) resname = word[1];
    if (oldResname === null || resnr !== oldRes || resname !== oldResname) {
      oldRes = resnr;
      addResidue(top, resname, resnr, ' ', ' ');
    }
    oldResname = resname;
    const xyz = [0, 0, 0];
    for (let m = 0; m < 3; m++) {
      const field = line.substr(20 + m * ddist, ddist);
      const v = Number(field.trim());
      if (!field.trim() || !Number.isFinite(v)) {
        if (top.errors.length < 20) {
          top.errors.push(`Something is wrong in the coordinate formatting of atom ${i + 1}.`);
        }
      } else xyz[m] = v;
    }
    addAtom(top, trimSpaces(line.substr(10, 5)), xyz[0], xyz[1], xyz[2]);
  }
  const boxLine = lines[2 + natoms];
  if (boxLine !== undefined && top.atoms.length === natoms) {
    const t = boxLine.trim().split(/\s+/).map(Number);
    if (t.length >= 3 && t.slice(0, 3).every(Number.isFinite)) {
      const f = k => (Number.isFinite(t[k]) ? t[k] : 0);
      top.box = t.length >= 9
        ? [[f(0), f(3), f(4)], [f(5), f(1), f(6)], [f(7), f(8), f(2)]]
        : [[f(0), 0, 0], [0, f(1), 0], [0, 0, f(2)]];
    }
  }
  return top;
}

function boxFromCryst1(a, b, c, alpha, beta, gamma) {
  if (!(a > 0 && b > 0 && c > 0) || a * b * c <= 1e-3) return null;
  const rad = Math.PI / 180;
  if ([alpha, beta, gamma].every(v => Math.abs(v - 90) < 1e-6)) {
    return [[a, 0, 0], [0, b, 0], [0, 0, c]];
  }
  const cosa = Math.cos(alpha * rad);
  const cosb = Math.cos(beta * rad);
  const cosg = Math.cos(gamma * rad);
  const sing = Math.sin(gamma * rad);
  const zx = c * cosb;
  const zy = (c * (cosa - cosb * cosg)) / sing;
  const zz = Math.sqrt(Math.max(0, c * c - zx * zx - zy * zy));
  return [[a, 0, 0], [b * cosg, b * sing, 0], [zx, zy, zz]];
}

/*
 * Port of read_pdbfile() and read_atom() in src/gromacs/fileio/pdbio.cpp:
 * the record name is the first six columns stripped of blanks, the residue
 * name is four columns (18-21), a residue ends when its number, insertion
 * code or name changes, and reading stops at the first ENDMDL.
 */
function readPdb(text) {
  const top = emptyStructure('pdb');
  const lines = fileLines(text);
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const rec = raw.slice(0, 6).trim();
    if (rec === 'ENDMDL') {
      const more = lines.slice(li + 1).filter(l => /^(ATOM  |HETATM)/.test(l)).length;
      if (more) {
        top.warnings.push(`GROMACS reads only the first model; the ${more} atoms after ` +
          'the first ENDMDL are ignored.');
      }
      break;
    }
    if (rec === 'TITLE' || rec === 'HEADER') {
      if (!top.title) top.title = raw.slice(6).trim().split(/ {6}/)[0];
      continue;
    }
    if (rec === 'CRYST1') {
      const n = (s, e) => Number(raw.slice(s, e).trim());
      const box = boxFromCryst1(n(6, 15) / 10, n(15, 24) / 10, n(24, 33) / 10,
        n(33, 40) || 90, n(40, 47) || 90, n(47, 54) || 90);
      if (box) top.box = box;
      continue;
    }
    if (rec !== 'ATOM' && rec !== 'HETATM') continue;
    if (!raw.startsWith('ATOM  ') && !raw.startsWith('HETATM')) {
      // GROMACS counts atoms with the unstripped test and reads them with
      // the stripped one; a line that passes only the second overflows.
      top.errors.push(`GROMACS counts only lines starting "ATOM  " or "HETATM": "${raw}".`);
    }
    const line = raw.padEnd(80, ' ');
    const name = line.slice(12, 16).trim();
    const resnm = line.slice(17, 21).trim();
    const chain = line[21];
    const resnr = strtol(line.slice(22, 26).trim());
    const ic = line[26];
    const prev = top.residues[top.residues.length - 1];
    if (!prev || !top.atoms.length || prev.nr !== resnr || prev.ic !== ic || prev.name !== resnm) {
      addResidue(top, resnm, resnr, ic, chain);
    }
    addAtom(top, name, strtod(line.slice(30, 38)) * 0.1, strtod(line.slice(38, 46)) * 0.1,
      strtod(line.slice(46, 54)) * 0.1, line.slice(76, 78).trim());
  }
  return top;
}

/**
 * Read a structure the way GROMACS reads it for make_ndx and grompp.
 *
 * @param {string} text - File contents.
 * @param {string} [formatOrFilename] - 'gro', 'pdb' (also 'ent', 'brk'), or a
 *        file name whose extension says which. Without it the text is sniffed.
 * @returns {GromacsStructure}
 */
export function readGromacsStructure(text, formatOrFilename = '') {
  const token = String(formatOrFilename || '').toLowerCase();
  let ext = token.includes('.') ? token.split('.').pop() : token;
  if (!ext) ext = /^(ATOM  |HETATM)/m.test(String(text)) ? 'pdb' : 'gro';
  if (ext === 'gro') return readGro(text);
  if (ext === 'pdb' || ext === 'ent' || ext === 'brk') return readPdb(text);
  const top = emptyStructure(ext);
  top.errors.push(`make_ndx reads .gro and .pdb structures here, not .${ext}.`);
  return top;
}

/**
 * Accept what `readGromacsStructure` returns, a `core/structure.js` parse
 * result or a plain atom array, and return the structure as GROMACS holds it.
 *
 * Residues are split where the residue number or name changes, the rule
 * GROMACS applies to `.gro` files. A structure.js PDB result skips any atom
 * line whose coordinates it cannot read, which would shift the numbers of the
 * atoms after it, so read PDB text with `readGromacsStructure` when the
 * numbering must be exactly GROMACS's.
 *
 * @param {GromacsStructure|{atoms:object[], unit?:string, box?:number[]}|object[]} input
 * @param {{unit?:'A'|'nm'}} [options] - Coordinate unit of a plain array
 *        (default nm).
 * @returns {GromacsStructure}
 */
export function toGromacsStructure(input, options = {}) {
  if (input && input.kind === 'gromacs-structure') return input;
  const atoms = Array.isArray(input)
    ? input : (input && Array.isArray(input.atoms) ? input.atoms : []);
  const unit = (!Array.isArray(input) && input && input.unit) || options.unit || 'nm';
  const scale = unit === 'A' ? 0.1 : 1;
  const top = emptyStructure('structure');
  top.title = (input && input.title) || '';
  if (input && input.format === 'pdb') {
    top.warnings.push('This PDB was read by core/structure.js, which skips an atom line whose ' +
      'coordinates it cannot read, so the atoms after one would be numbered differently from ' +
      'GROMACS; read the text with readGromacsStructure to number atoms as GROMACS does.');
  }
  for (const a of atoms) {
    const resName = String(a.resName ?? a.resn ?? '').trim();
    const nr = Number(a.resSeq ?? a.resi ?? 0) || 0;
    const prev = top.residues[top.residues.length - 1];
    if (!prev || prev.nr !== nr || prev.name !== resName) {
      addResidue(top, resName, nr, ' ', String(a.chain || '').trim() || ' ');
    }
    addAtom(top, String(a.atomName ?? a.atom ?? '').trim(), (Number(a.x) || 0) * scale,
      (Number(a.y) || 0) * scale, (Number(a.z) || 0) * scale, String(a.element || '').trim());
  }
  if (input && !Array.isArray(input) && Array.isArray(input.box) && input.box.length >= 3) {
    const b = input.box;
    top.box = [[b[0], 0, 0], [0, b[1], 0], [0, 0, b[2]]];
    const v = input.boxVectors;
    if (Array.isArray(v) && v.length >= 9) {
      top.box = [[v[0], v[3], v[4]], [v[5], v[1], v[6]], [v[7], v[8], v[2]]];
    }
  }
  return top;
}

/* ------------------------------------------------------------------ *
 * Default groups: port of analyse() in src/gromacs/topology/index.cpp
 * ------------------------------------------------------------------ */

/*
 * Protein groups from analyse_prot(): the defining atom names, whether the
 * group is their complement, the index from which names match as prefixes
 * (-1: never), and the group to compare with (-1: always add).
 */
const PNOH = ['H', 'HN'];
const PNODUM = ['MN1', 'MN2', 'MCB1', 'MCB2', 'MCG1', 'MCG2', 'MCD1', 'MCD2', 'MCE1', 'MCE2',
  'MNZ1', 'MNZ2'];
const MAIN_CHAIN = ['N', 'CA', 'C', 'O', 'O1', 'O2', 'OC1', 'OC2', 'OT', 'OXT'];
const MAIN_CHAIN_CB = ['N', 'CA', 'CB', 'C', 'O', 'O1', 'O2', 'OC1', 'OC2', 'OT', 'OXT'];
const MAIN_CHAIN_H = ['N', 'CA', 'C', 'O', 'O1', 'O2', 'OC1', 'OC2', 'OT', 'OXT', 'H1', 'H2', 'H3',
  'H', 'HN'];
const PROTEIN_GROUPS = [
  { name: 'Protein', names: [], complement: true, wholename: -1, compareto: -1 },
  { name: 'Protein-H', names: PNOH, complement: true, wholename: 0, compareto: -1 },
  { name: 'C-alpha', names: ['CA'], complement: false, wholename: -1, compareto: -1 },
  { name: 'Backbone', names: ['N', 'CA', 'C'], complement: false, wholename: -1, compareto: -1 },
  { name: 'MainChain', names: MAIN_CHAIN, complement: false, wholename: -1, compareto: -1 },
  { name: 'MainChain+Cb', names: MAIN_CHAIN_CB, complement: false, wholename: -1, compareto: -1 },
  { name: 'MainChain+H', names: MAIN_CHAIN_H, complement: false, wholename: -1, compareto: -1 },
  { name: 'SideChain', names: MAIN_CHAIN_H, complement: true, wholename: -1, compareto: -1 },
  { name: 'SideChain-H', names: MAIN_CHAIN_H, complement: true, wholename: 11, compareto: -1 },
  { name: 'Prot-Masses', names: PNODUM, complement: true, wholename: -1, compareto: 0 }
];

function sameList(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function analyseProt(top, isProtein, groups) {
  const protAtoms = [];
  const names = [];
  top.atoms.forEach((a, i) => {
    if (!isProtein[a.resIndex]) return;
    protAtoms.push(i);
    // Leading digits are skipped ("1HB" is a hydrogen).
    names.push(up(a.name.replace(/^[0-9]+/, '')));
  });
  PROTEIN_GROUPS.forEach((def, i) => {
    const defs = def.names.map(up);
    const aid = [];
    protAtoms.forEach((atom, k) => {
      const nm = names[k];
      let match = false;
      for (let j = 0; j < defs.length && !match; j++) {
        match = def.wholename === -1 || j < def.wholename ? nm === defs[j] : nm.startsWith(defs[j]);
      }
      if (def.complement !== match) aid.push(atom);
    });
    // grp_cmp() with a negative index counts back from the end of the list.
    let add = def.compareto === -1;
    if (!add) {
      const at = groups.length - 1 + (def.compareto - i);
      add = !(at >= 0 && sameList(groups[at].idx, aid));
    }
    if (add) groups.push({ name: def.name, idx: aid });
  });
}

function analyseOther(top, types, groups) {
  const skip = types.map(t => ['PROTEIN', 'DNA', 'RNA', 'WATER'].includes(up(t)));
  if (skip.every(Boolean)) return;
  const order = [];
  const seen = new Set();
  for (const a of top.atoms) {
    if (skip[a.resIndex]) continue;
    const rname = top.residues[a.resIndex].name;
    if (!seen.has(rname)) { seen.add(rname); order.push(rname); }
  }
  const byName = new Map(order.map(n => [n, []]));
  top.atoms.forEach((a, i) => {
    const list = byName.get(top.residues[a.resIndex].name);
    if (list) list.push(i);
  });
  for (const n of order) groups.push({ name: n, idx: byName.get(n) });
}

function defaultGroupsIdx(top) {
  const n = top.atoms.length;
  const groups = [{ name: 'System', idx: Array.from({ length: n }, (_, i) => i) }];
  const types = top.residues.map(r => residueTypeOf(r.name));
  const typesUp = types.map(up);
  const categories = [];
  for (const t of types) if (!categories.includes(t)) categories.push(t);

  // mk_aid(): atoms whose residue type is (or is not) `type`, ignoring case.
  const atomsOfType = (type, match) => {
    const key = up(type);
    const out = [];
    const atoms = top.atoms;
    for (let i = 0; i < atoms.length; i++) {
      if ((typesUp[atoms[i].resIndex] === key) === match) out.push(i);
    }
    return out;
  };

  let haveAnalysedOther = false;
  for (const category of categories) {
    const aid = atomsOfType(category, true);
    if (caseEq(category, 'Protein') && aid.length) {
      analyseProt(top, types.map(t => caseEq(t, 'Protein')), groups);
      const non = atomsOfType('Protein', false);
      if (non.length && non.length < n) groups.push({ name: 'non-Protein', idx: non });
    } else if (caseEq(category, 'Water') && aid.length) {
      groups.push({ name: category, idx: aid });
      // Kept as SOL too, for older GROMACS versions.
      groups.push({ name: 'SOL', idx: aid });
      const non = atomsOfType('Water', false);
      if (non.length && non.length < n) groups.push({ name: 'non-Water', idx: non });
    } else if (caseEq(category, 'Ion') && aid.length) {
      groups.push({ name: category, idx: aid });
    } else if (aid.length && !haveAnalysedOther) {
      groups.push({ name: category, idx: aid });
      analyseOther(top, types, groups);
      haveAnalysedOther = true;
    }
  }

  // The last groups called Water and Ion, whichever they are.
  let iw = -1;
  let ii = -1;
  groups.forEach((g, i) => {
    if (caseEq(g.name, 'Water')) iw = i;
    else if (caseEq(g.name, 'Ion')) ii = i;
  });
  if (iw >= 0 && ii >= 0 && groups[iw].idx.length && groups[ii].idx.length) {
    groups.push({ name: 'Water_and_ions', idx: [...groups[iw].idx, ...groups[ii].idx] });
  }
  return groups;
}

const toGroup = g => ({ name: g.name, atoms: g.idx.map(i => i + 1) });
const toIdxGroup = g => ({ name: g.name, idx: (g.atoms || []).map(a => a - 1) });

/**
 * The groups `gmx make_ndx` makes when given a structure and no index file:
 * the same names, in the same order, with the same atoms.
 *
 * @param {GromacsStructure|object} structure - From `readGromacsStructure`, or a
 *        `core/structure.js` parse result.
 * @returns {Array<{name:string, atoms:number[]}>} Atom numbers from 1.
 */
export function defaultGroups(structure) {
  return defaultGroupsIdx(toGromacsStructure(structure)).map(toGroup);
}

/* ------------------------------------------------------------------ *
 * The make_ndx command language: port of edit_index() and parse_entry()
 * in src/gromacs/tools/make_ndx.cpp
 * ------------------------------------------------------------------ */

/**
 * make_ndx's group lookup for a quoted name: a whole-name match first, then
 * a prefix, then any substring, ignoring case and treating '-' and '_' as
 * absent. More than one match is an error (-1).
 *
 * @param {string} s
 * @param {Array<{name:string}>} groups
 * @returns {number} Index into `groups`, or -1.
 */
export function findGroupMakeNdx(s, groups) {
  const names = groups.map(g => g.name);
  const strip = t => up(t).replace(/[-_]/g, '');
  let aa = -1;
  let multiple = false;
  const key = strip(s);
  names.forEach((n, i) => {
    if (strip(n) === key) { if (aa !== -1) multiple = true; aa = i; }
  });
  if (aa === -1) {
    names.forEach((n, i) => {
      if (strncasecmpMin(s, n, s.length) === 0) { if (aa !== -1) multiple = true; aa = i; }
    });
  }
  if (aa === -1) {
    const k = up(s).replace(/-/g, '_');
    names.forEach((n, i) => {
      if (up(n).replace(/-/g, '_').includes(k)) { if (aa !== -1) multiple = true; aa = i; }
    });
  }
  return multiple ? -1 : aa;
}

/* gmx_strncasecmp_min: n counts characters consumed, skipped ones included. */
function strncasecmpMin(s1, s2, n) {
  let i1 = 0;
  let i2 = 0;
  let c1;
  let c2;
  do {
    do { c1 = up(s1[i1++] || ''); } while (c1 === '-' || c1 === '_');
    do { c2 = up(s2[i2++] || ''); } while (c2 === '-' || c2 === '_');
    if (c1 !== c2) return 1;
  } while (c1 !== '' && i1 < n && i2 < n);
  return 0;
}

/* comp_name(): '?' matches one character and a trailing '*' the rest. */
function compName(name, search, caseSensitive) {
  let i = 0;
  let j = 0;
  let matches = true;
  for (; i < name.length && j < search.length && matches; i++, j++) {
    if (search[j] === '?') continue;
    if (search[j] === '*') return j + 1 === search.length;
    matches = caseSensitive ? name[i] === search[j] : up(name[i]) === up(search[j]);
  }
  return matches && i === name.length && (j === search.length || search[j] === '*');
}

/**
 * Run make_ndx commands, as if typed at its prompt, on a structure.
 *
 * Supported: group numbers and "quoted names", `a` (atom numbers, ranges and
 * names with `?` and `*`), `r` (residue numbers with insertion codes, ranges
 * and names), `ri` (residue indices), `res`, `chain`, `!`, `&` and `|` read
 * left to right, `name`, `del`, `keep`, `case`, `splitres`, `splitat`,
 * `splitch` and `q`. `t` needs a run input file, as it does in make_ndx.
 *
 * @param {GromacsStructure|object} structure
 * @param {string|string[]} commands - One command per line; reading stops at
 *        a line starting with `q`.
 * @param {{groups?:Array<{name:string, atoms:number[]}>}} [options] - The
 *        groups to start from; the default groups when not given.
 * @returns {{groups:Array<{name:string, atoms:number[]}>, log:string[]}}
 *          The groups make_ndx would write, and what it would print.
 */
export function makeNdx(structure, commands, options = {}) {
  const top = toGromacsStructure(structure);
  const natoms = top.atoms.length;
  const groups = options.groups ? options.groups.map(toIdxGroup) : defaultGroupsIdx(top);
  const log = [];
  const lines = Array.isArray(commands) ? commands.slice() : String(commands ?? '').split('\n');
  let caseSensitive = false;
  let gname = '';

  // A cursor over the command line; '' stands for C's terminating NUL.
  let s = '';
  let p = 0;
  const ch = (k = 0) => s[p + k] || '';
  const skipSpaces = () => { while (ch() === ' ') p++; };

  function parseIntChar() {
    const orig = p;
    skipSpaces();
    let nr = NOTSET;
    let c = ' ';
    let ok = false;
    if (isDigit(ch())) {
      nr = 0;
      while (isDigit(ch())) { nr = nr * 10 + Number(ch()); p++; }
      if (isAlpha(ch())) { c = ch(); p++; }
      if (!isAlnum(ch())) ok = true;
      else p = orig;
    }
    return { ok, nr, c };
  }

  function parseInt_() {
    const orig = p;
    const r = parseIntChar();
    if (r.ok && r.c !== ' ') { p = orig; return { ok: false, nr: r.nr }; }
    return { ok: r.ok, nr: r.nr };
  }

  function parseString() {
    skipSpaces();
    let nr = NOTSET;
    if (ch() === '"') {
      p++;
      const close = s.indexOf('"', p);
      if (close >= 0) {
        nr = findGroupMakeNdx(s.slice(p, close), groups);
        p = close + 1;
      }
    }
    return { ok: nr !== NOTSET, nr };
  }

  const isNameChar = c => c !== '' && !' !&|'.includes(c);
  function parseNames() {
    const names = [];
    while (isNameChar(ch()) || ch() === ' ') {
      if (isNameChar(ch())) {
        let n = '';
        while (isNameChar(ch())) { n += ch(); p++; }
        if (n.length > 1024) {
          log.push('Name is too long, the maximum is 1024 characters');
          return [];
        }
        names.push(caseSensitive ? n : up(n));
      } else p++;
    }
    return names;
  }

  function selectAtomNumbers(n1, out) {
    skipSpaces();
    if (ch() === '-') {
      p++;
      const hi = parseInt_().nr;
      if (n1 < 1 || n1 > natoms || hi < 1 || hi > natoms) log.push('Invalid atom range');
      else {
        for (let i = n1 - 1; i <= hi - 1; i++) out.push(i);
        log.push(`Found ${out.length} atom${plural(out.length)} in range ${n1}-${hi}`);
        gname = n1 === hi ? `a_${n1}` : `a_${n1}-${hi}`;
      }
      return;
    }
    let i = n1;
    let name = 'a';
    let more;
    do {
      if (i - 1 >= 0 && i - 1 < natoms) { out.push(i - 1); name += `_${i}`; }
      else { log.push(`Invalid atom number ${i}`); out.length = 0; }
      gname = name;
      more = out.length !== 0 && (() => { const r = parseInt_(); i = r.nr; return r.ok; })();
    } while (more);
  }

  function selectResidues(n1, c, out, byIndex) {
    skipSpaces();
    const key = a => (byIndex ? a.resIndex + 1 : top.residues[a.resIndex].nr);
    if (ch() === '-') {
      if (c !== ' ') {
        log.push('Error: residue insertion codes can not be used with residue range selection');
        return;
      }
      p++;
      const hi = parseInt_().nr;
      top.atoms.forEach((a, i) => {
        const v = key(a);
        if (v >= n1 && v <= hi) out.push(i);
      });
      log.push(`Found ${out.length} atom${plural(out.length)} with ` +
        `${byIndex ? 'resind.+1' : 'res.nr.'} in range ${n1}-${hi}`);
      gname = n1 === hi ? `r_${n1}` : `r_${n1}-${hi}`;
      return;
    }
    let j = n1;
    let code = c;
    let name = 'r';
    let r;
    do {
      top.atoms.forEach((a, i) => {
        if (key(a) === j && top.residues[a.resIndex].ic === code) out.push(i);
      });
      name += `_${j}`;
      r = parseIntChar();
      j = r.nr;
      code = r.c;
    } while (r.ok);
    gname = name;
  }

  function selectByName(names, field, what, out) {
    top.atoms.forEach((a, i) => {
      const v = field(a);
      if (names.some(n => compName(v, n, caseSensitive))) out.push(i);
    });
    log.push(`Found ${out.length} ${what}${plural(names.length)} ${names.join(' ')}`);
  }

  // parse_entry(): one operand, optionally complemented. Returns its atoms
  // (0-based, in make_ndx's order) or null.
  function parseEntry() {
    skipSpaces();
    let compl = false;
    if (ch() === '!') { compl = true; p++; skipSpaces(); }
    const out = [];
    let ok = false;
    let r = parseInt_();
    if (!r.ok) r = parseString();
    if (r.ok) {
      if (r.nr >= 0 && r.nr < groups.length) {
        out.push(...groups[r.nr].idx);
        gname = groups[r.nr].name;
        log.push(`Copied index group ${r.nr} '${groups[r.nr].name}'`);
        ok = true;
      } else log.push(`Group ${r.nr} does not exist`);
    } else if (ch() === 'a') {
      p++;
      const n = parseInt_();
      if (n.ok) {
        selectAtomNumbers(n.nr, out);
        ok = out.length !== 0;
      } else {
        const names = parseNames();
        if (names.length) {
          top.atoms.forEach((a, i) => {
            if (names.some(nm => compName(a.name, nm, caseSensitive))) out.push(i);
          });
          log.push(`Found ${out.length} atoms with name${plural(names.length)} ${names.join(' ')}`);
          ok = out.length !== 0;
          gname = names.join('_');
        }
      }
    } else if (ch() === 't') {
      p++;
      if (parseNames().length) log.push('Need a run input file to select atom types');
    } else if (s.startsWith('res', p)) {
      p += 3;
      const n = parseInt_();
      if (n.ok && n.nr >= 0 && n.nr < groups.length) {
        const g = groups[n.nr];
        if (g.idx.some(v => v >= top.residues.length)) {
          const bad = g.idx.find(v => v >= top.residues.length);
          log.push(`Index ${g.name} contains number>nres (${bad + 1}>${top.residues.length})`);
        } else {
          const wanted = new Set(g.idx.map(v => v + 1));
          top.atoms.forEach((a, i) => {
            if (wanted.has(top.residues[a.resIndex].nr)) out.push(i);
          });
          log.push(`Found ${out.length} atom${plural(out.length)} in ${g.idx.length} residues ` +
            `from group ${g.name}`);
          ok = out.length !== 0;
        }
        gname = `atom_${g.name}`;
      }
    } else if (s.startsWith('ri', p)) {
      p += 2;
      const n = parseIntChar();
      if (n.ok) {
        selectResidues(n.nr, n.c, out, true);
        ok = out.length !== 0;
      }
    } else if (ch() === 'r') {
      p++;
      const n = parseIntChar();
      if (n.ok) {
        selectResidues(n.nr, n.c, out, false);
        ok = out.length !== 0;
      } else {
        const names = parseNames();
        if (names.length) {
          selectByName(names, a => top.residues[a.resIndex].name, 'atoms with residue name', out);
          ok = out.length !== 0;
          gname = names.join('_');
        }
      }
    } else if (s.startsWith('chain', p)) {
      p += 5;
      const names = parseNames();
      if (names.length) {
        top.atoms.forEach((a, i) => {
          const c = top.residues[a.resIndex].chain;
          if (names.some(nm => compName(c, nm, caseSensitive))) out.push(i);
        });
        log.push(`Found ${out.length} atom${plural(out.length)} with chain ` +
          `identifier${plural(names.length)} ${names.join(' ')}`);
        ok = out.length !== 0;
        gname = `ch${names.join('')}`;
      }
    }
    if (ok && compl) {
      const inGroup = new Set(out);
      const room = natoms - out.length;
      const comp = [];
      for (let i = 0; i < natoms; i++) {
        if (inGroup.has(i)) continue;
        if (comp.length >= room) { log.push('There are double atoms in your index group'); break; }
        comp.push(i);
      }
      out.length = 0;
      out.push(...comp);
      gname = `!${gname}`;
      log.push(`Complemented group: ${out.length} atoms`);
    }
    return ok ? out : null;
  }

  function orGroups(a, b) {
    let notIncr = false;
    let max = 0;
    [a, b].forEach(list => list.forEach((v, i) => {
      if (i > 0 && v <= max) notIncr = true;
      max = v;
    }));
    if (notIncr) { log.push('One of your groups is not ascending'); return []; }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (j === b.length || (i < a.length && a[i] < b[j])) out.push(a[i++]);
      else {
        if (j < b.length && (i === a.length || a[i] > b[j])) out.push(b[j]);
        j++;
      }
    }
    log.push(`Merged two groups with OR: ${a.length} ${b.length} -> ${out.length}`);
    return out;
  }

  function andGroups(a, b) {
    const count = new Map();
    for (const v of b) count.set(v, (count.get(v) || 0) + 1);
    const out = [];
    for (const v of a) for (let k = count.get(v) || 0; k > 0; k--) out.push(v);
    log.push(`Merged two groups with AND: ${a.length} ${b.length} -> ${out.length}`);
    return out;
  }

  function removeGroups(first, last) {
    for (let j = 0; j <= last - first; j++) {
      if (first < 0 || first >= groups.length) log.push(`Group ${first + j} does not exist`);
      else {
        log.push(`Removed group ${first + j} '${groups[first].name}'`);
        groups.splice(first, 1);
      }
    }
  }

  function splitGroup(sel, byAtom) {
    const g = groups[sel];
    log.push(`Splitting group ${sel} '${g.name}' into ${byAtom ? 'atoms' : 'residues'}`);
    let prev = -1;
    for (const a of g.idx) {
      const at = top.atoms[a];
      if (byAtom || prev === -1 || top.atoms[prev].resIndex !== at.resIndex) {
        const res = top.residues[at.resIndex];
        groups.push({
          name: byAtom ? `${g.name}_${at.name}_${a + 1}` : `${g.name}_${res.name}_${res.nr}`,
          idx: []
        });
      }
      groups[groups.length - 1].idx.push(a);
      prev = a;
    }
  }

  // split_chain(): chains end where consecutive C-alpha atoms are 0.45 nm
  // or more apart, measured in single precision as GROMACS does.
  function splitChain(sel) {
    const f = Math.fround;
    const starts = [];
    const ends = [];
    let caStart = 0;
    while (caStart < natoms) {
      while (caStart < natoms && top.atoms[caStart].name !== 'CA') caStart++;
      if (caStart >= natoms) break;
      let st = caStart;
      while (st > 0 && top.atoms[st - 1].resIndex === top.atoms[caStart].resIndex) st--;
      let i = caStart;
      let caEnd;
      for (;;) {
        caEnd = i;
        do { i++; } while (i < natoms && top.atoms[i].name !== 'CA');
        if (i >= natoms) break;
        const A = top.atoms[caEnd];
        const B = top.atoms[i];
        const dx = f(f(A.x) - f(B.x));
        const dy = f(f(A.y) - f(B.y));
        const dz = f(f(A.z) - f(B.z));
        const d = f(Math.sqrt(f(f(f(dx * dx) + f(dy * dy)) + f(dz * dz))));
        if (!(d < 0.45)) break;
      }
      let en = caEnd;
      while (en + 1 < natoms && top.atoms[en + 1].resIndex === top.atoms[caEnd].resIndex) en++;
      starts.push(st);
      ends.push(en);
      caStart = en + 1;
    }
    log.push(starts.length === 1
      ? 'Found 1 chain, will not split' : `Found ${starts.length} chains`);
    if (starts.length > 1) {
      const base = groups[sel];
      starts.forEach((st, j) => {
        const idx = base.idx.filter(a => a >= st && a <= ends[j]);
        if (idx.length) groups.push({ name: `${base.name}_chain${j + 1}`, idx });
      });
    }
  }

  function listResidues() {
    const out = [];
    const res = top.residues;
    if (!top.atoms.length) return;
    let start = top.atoms[0].resIndex;
    let prevRes = start;
    top.atoms.forEach((a, i) => {
      const r = a.resIndex;
      const last = i === natoms - 1;
      if (r !== prevRes || last) {
        const diff = res[r].name !== res[start].name;
        if (diff || last) {
          const end = diff ? prevRes : r;
          const nr = k => String(k + 1).padStart(4);
          if (end < start + 3) {
            for (let j = start; j <= end; j++) out.push(`${nr(j)} ${res[j].name.padEnd(5)}`);
          } else out.push(` ${nr(start)} - ${nr(end)} ${res[start].name.padEnd(5)}  `);
          start = r;
        }
      }
      prevRes = r;
    });
    log.push(out.join(''));
  }

  for (const rawLine of lines) {
    s = String(rawLine).replace(/\r$/, '');
    p = 0;
    skipSpaces();
    const rest = () => s.slice(p);
    if (ch() === 'h') {
      log.push('See the make_ndx help for the command syntax.');
    } else if (rest().startsWith('del')) {
      p += 3;
      const a = parseInt_();
      if (a.ok) {
        skipSpaces();
        let b = a.nr;
        if (ch() === '-') { p++; b = parseInt_().nr; }
        skipSpaces();
        if (ch() === '') removeGroups(a.nr, b);
        else log.push(`Syntax error: "${rest()}"`);
      }
    } else if (rest().startsWith('keep')) {
      p += 4;
      const a = parseInt_();
      if (a.ok) {
        removeGroups(a.nr + 1, groups.length - 1);
        removeGroups(0, a.nr - 1);
      }
    } else if (rest().startsWith('name')) {
      p += 4;
      const a = parseInt_();
      if (a.ok && a.nr >= 0 && a.nr < groups.length) {
        const word = /^\s*(\S+)/.exec(rest());
        // With no new name, sscanf leaves the buffer as it was: make_ndx
        // then uses the name of the last group it built.
        if (word) gname = word[1];
        if (gname) groups[a.nr].name = gname;
      }
    } else if (rest().startsWith('case')) {
      caseSensitive = !caseSensitive;
      log.push(`Switched to case ${caseSensitive ? 'sensitive' : 'insensitive'}`);
    } else if (ch() === 'v') {
      log.push('Turned verbose on');
    } else if (ch() === 'l') {
      listResidues();
    } else if (rest().startsWith('splitch')) {
      p += 7;
      const a = parseInt_();
      if (a.ok && a.nr >= 0 && a.nr < groups.length) splitChain(a.nr);
    } else if (rest().startsWith('splitres')) {
      p += 8;
      const a = parseInt_();
      if (a.ok && a.nr >= 0 && a.nr < groups.length) splitGroup(a.nr, false);
    } else if (rest().startsWith('splitat')) {
      p += 7;
      const a = parseInt_();
      if (a.ok && a.nr >= 0 && a.nr < groups.length) splitGroup(a.nr, true);
    } else if (ch() === '') {
      // An empty line lists the groups.
    } else if (ch() !== 'q') {
      let current = [];
      const first = parseEntry();
      if (first) {
        current = first;
        let more;
        do {
          skipSpaces();
          const and = ch() === '&';
          const or = ch() === '|';
          more = and || or;
          if (more) {
            p++;
            // make_ndx parses the right operand into a second name buffer,
            // so a failed operand leaves the running name alone.
            const leftName = gname;
            const right = parseEntry();
            if (right) {
              current = or ? orGroups(current, right) : andGroups(current, right);
              gname = or ? `${leftName}_${gname}` : `${leftName}_&_${gname}`;
            } else gname = leftName;
          }
        } while (more);
      }
      skipSpaces();
      if (ch() !== '') log.push(`Syntax error: "${rest()}"`);
      else if (current.length > 0) {
        groups.push({ name: gname, idx: current });
        log.push(`${String(groups.length - 1).padStart(3)} ${gname.padEnd(20)}: ` +
          `${String(current.length).padStart(5)} atoms`);
      } else log.push('Group is empty');
    }
    if (ch() === 'q') break;
  }
  return { groups: groups.map(toGroup), log };
}

/* ------------------------------------------------------------------ *
 * The .ndx file
 * ------------------------------------------------------------------ */

/**
 * Is a name usable as an index group? GROMACS reads the first word between
 * the brackets, `;` starts a comment in both `.ndx` and `.mdp` files, and an
 * `.mdp` line splits group names on white space.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isValidGroupName(name) {
  return typeof name === 'string' && /^[^\s[\];]+$/.test(name);
}

/**
 * Make a name usable as an index group: white space, brackets and
 * semicolons become underscores.
 *
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string}
 */
export function sanitiseGroupName(name, fallback = 'Group') {
  const s = String(name ?? '').trim().replace(/[\s[\];]+/g, '_');
  return s || fallback;
}

/**
 * Write groups as GROMACS writes an index file: `[ name ]`, then the atom
 * numbers fifteen to a line, each `%4d` and separated by one space.
 *
 * Names that GROMACS could not read back are made safe with
 * `sanitiseGroupName`.
 *
 * @param {Array<{name:string, atoms:number[]}>} groups
 * @returns {string}
 */
export function writeNdx(groups) {
  const out = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    let text = `[ ${isValidGroupName(g.name) ? g.name : sanitiseGroupName(g.name)} ]`;
    const atoms = g.atoms || [];
    for (let k = 0; k < atoms.length; k++) {
      text += (k % 15 === 0 ? '\n' : ' ') + String(Math.trunc(atoms[k])).padStart(4);
    }
    out.push(`${text}\n`);
  }
  return out.join('');
}

/**
 * Read an index file as GROMACS does (init_index): a group starts at the
 * first word inside `[ ]`, `;` starts a comment, and every word after is an
 * atom number read with strtol.
 *
 * @param {string} text
 * @returns {{groups:Array<{name:string, atoms:number[]}>, errors:string[],
 *   warnings:string[]}}
 */
export function parseNdx(text) {
  const groups = [];
  const errors = [];
  const warnings = [];
  let lineNo = 0;
  for (const raw of String(text ?? '').split('\n')) {
    lineNo += 1;
    const semi = raw.indexOf(';');
    const line = semi >= 0 ? raw.slice(0, semi) : raw;
    if (!line.trim()) continue;
    const open = line.indexOf('[');
    if (open >= 0) {
      const close = line.indexOf(']', open + 1);
      if (close < 0) {
        errors.push(`Line ${lineNo}: the header is not terminated: "${raw.trim()}".`);
        break;
      }
      const word = line.slice(open + 1, close).trim().split(/\s+/)[0];
      if (word) {
        groups.push({ name: word, atoms: [] });
        continue;
      }
    }
    if (!groups.length) {
      errors.push('The first header of the index file is invalid.');
      break;
    }
    const list = groups[groups.length - 1].atoms;
    for (const tok of line.trim().split(/\s+/)) list.push(strtol(tok));
  }
  for (const g of groups) {
    const bad = g.atoms.filter(a => a < 1);
    if (bad.length) {
      warnings.push(`Group ${g.name} has ${bad.length} atom number${plural(bad.length)} below 1.`);
    }
  }
  return { groups, errors, warnings };
}

/**
 * The group grompp takes for a name: the first whose name matches ignoring
 * case.
 *
 * @param {Array<{name:string}>} groups
 * @param {string} name
 * @returns {number} Index, or -1.
 */
export function findIndexGroup(groups, name) {
  const list = Array.isArray(groups) ? groups : [];
  const key = up(String(name ?? ''));
  return list.findIndex(g => up(g.name) === key);
}

/**
 * Merge new groups into an existing index (a user's `.ndx`, say).
 *
 * Names are compared ignoring case, since grompp does and would silently take
 * the first. A new group identical to an existing one is dropped.
 *
 * @param {Array<{name:string, atoms:number[]}>} existing
 * @param {Array<{name:string, atoms:number[]}>} added
 * @param {{onConflict?:'rename'|'replace'|'keep'}} [options] - What to do
 *        when a name is taken by a different group: add the new one as
 *        `name_2` (default), replace the old one in place, or keep the old.
 * @returns {{groups:Array<{name:string, atoms:number[]}>,
 *   renamed:Array<{from:string, to:string}>, replaced:string[], skipped:string[]}}
 */
export function mergeIndexGroups(existing, added, options = {}) {
  const { onConflict = 'rename' } = options;
  const groups = (existing || []).map(g => ({ name: g.name, atoms: [...g.atoms] }));
  const renamed = [];
  const replaced = [];
  const skipped = [];
  for (const g of added || []) {
    const at = findIndexGroup(groups, g.name);
    if (at < 0) { groups.push({ name: g.name, atoms: [...g.atoms] }); continue; }
    if (sameList(groups[at].atoms, g.atoms)) { skipped.push(g.name); continue; }
    if (onConflict === 'replace') {
      groups[at] = { name: g.name, atoms: [...g.atoms] };
      replaced.push(g.name);
    } else if (onConflict === 'keep') {
      skipped.push(g.name);
    } else {
      let k = 2;
      while (findIndexGroup(groups, `${g.name}_${k}`) >= 0) k++;
      const to = `${g.name}_${k}`;
      groups.push({ name: to, atoms: [...g.atoms] });
      renamed.push({ from: g.name, to });
    }
  }
  return { groups, renamed, replaced, skipped };
}

/**
 * Rename a group.
 *
 * @param {Array<{name:string, atoms:number[]}>} groups
 * @param {number|string} which - Index, or name (matched as grompp does).
 * @param {string} newName
 * @returns {{groups:Array<{name:string, atoms:number[]}>, error:string}}
 *          The new list; on error, the list unchanged and a reason.
 */
export function renameIndexGroup(groups, which, newName) {
  const list = Array.isArray(groups) ? groups : [];
  const at = typeof which === 'number' ? which : findIndexGroup(list, which);
  if (!(at >= 0 && at < list.length)) return { groups: list, error: `There is no group ${which}.` };
  if (!isValidGroupName(newName)) {
    return {
      groups: list,
      error: `"${newName}" cannot be a group name: use no spaces, brackets or semicolons.`
    };
  }
  const clash = list.findIndex((g, i) => i !== at && up(g.name) === up(newName));
  if (clash >= 0) {
    return {
      groups: list,
      error: `Group ${clash} is already called ${list[clash].name}; grompp would take the first.`
    };
  }
  return { groups: list.map((g, i) => (i === at ? { ...g, name: newName } : g)), error: '' };
}

/* ------------------------------------------------------------------ *
 * Checks for .mdp group options
 * ------------------------------------------------------------------ */

/**
 * Check a list of group names the way grompp's do_numbering() does: every
 * name must exist, no atom may be in two of the groups (or twice in one), and
 * depending on the option the groups must cover every atom.
 *
 * @param {Array<{name:string, atoms:number[]}>} groups - The index.
 * @param {string|string[]} names - As in the `.mdp` (e.g. "Protein non-Protein").
 * @param {number} natoms - Atoms in the system.
 * @param {{coverage?:'all'|'rest'|'partial'|'one', option?:string}} [options]
 *        `all`: every atom must be covered (tc-grps); `rest`: uncovered atoms
 *        form a rest group (energygrps, freezegrps, acc-grps); `partial`:
 *        allowed, with a note (comm-grps); `one`: the groups are merged into
 *        one (compressed-x-grps).
 * @returns {{ok:boolean, errors:string[], notes:string[], missing:string[],
 *   overlaps:number, uncovered:number, found:Array<{name:string, index:number,
 *   atoms:number}>}}
 */
export function checkGroupCoverage(groups, names, natoms, options = {}) {
  const { coverage = 'all', option = 'tc-grps' } = options;
  const list = Array.isArray(names)
    ? names : String(names ?? '').trim().split(/\s+/).filter(Boolean);
  const errors = [];
  const notes = [];
  const missing = [];
  const found = [];
  const owner = new Int32Array(Math.max(0, natoms)).fill(-1);
  let overlaps = 0;
  let total = 0;
  let firstOverlap = null;
  let outOfRange = 0;
  list.forEach((name, gi) => {
    const at = findIndexGroup(groups, name);
    if (at < 0) { missing.push(name); return; }
    found.push({ name, index: at, atoms: groups[at].atoms.length });
    for (const a of groups[at].atoms) {
      if (!(a >= 1 && a <= natoms)) { outOfRange++; continue; }
      if (owner[a - 1] >= 0) {
        overlaps++;
        if (!firstOverlap) firstOverlap = { atom: a, first: owner[a - 1] + 1, second: gi + 1 };
      } else {
        owner[a - 1] = coverage === 'one' ? 0 : gi;
        total++;
      }
    }
  });
  for (const m of missing) {
    errors.push(`Group ${m} in ${option} is not in the index.`);
  }
  if (outOfRange) {
    errors.push(`${outOfRange} atom numbers in the ${option} groups lie outside the ` +
      `${natoms} atoms of the system.`);
  }
  if (firstOverlap) {
    const more = overlaps > 1 ? `, and ${overlaps - 1} more atoms overlap` : '';
    errors.push(`Atom ${firstOverlap.atom} is in two ${option} groups (${firstOverlap.first} and ` +
      `${firstOverlap.second})${more}; grompp stops on this.`);
  }
  const uncovered = missing.length ? 0 : natoms - total;
  // No names at all is the default for the options that allow a rest group,
  // but for tc-grps with a thermostat it leaves every atom uncoupled, which
  // grompp's do_numbering() stops on like any other gap.
  if (!missing.length && uncovered > 0 && (list.length || coverage === 'all')) {
    const msg = `${uncovered} atoms are not part of any of the ${option} groups`;
    if (coverage === 'all') errors.push(`${msg}; grompp stops on this.`);
    else if (coverage === 'partial') notes.push(`${msg}.`);
    else if (coverage === 'rest') notes.push(`${msg}; grompp puts them in a rest group.`);
  }
  return { ok: errors.length === 0, errors, notes, missing, overlaps, uncovered, found };
}

const MDP_GROUP_OPTIONS = {
  'tc-grps': 'all',
  'acc-grps': 'rest',
  'freezegrps': 'rest',
  'energygrps': 'rest',
  'comm-grps': 'partial',
  'user1-grps': 'rest',
  'user2-grps': 'rest',
  'compressed-x-grps': 'one',
  'xtc-grps': 'one',
  'orire-fitgrp': 'rest',
  'qmmm-grps': 'rest'
};
const MDP_SINGLE_GROUPS = new RegExp('^(pull-group\\d+-name|rot-group\\d+|swap-group|' +
  'split-group[01]|solvent-group|imd-group|density-guided-simulation-group|qmmm-cp2k-qmgroup)$');

/*
 * The single groups grompp refuses when empty: readpull.cpp ("Pull group %d
 * '%s' is empty"), readrot.cpp ("Rotation group %d '%s' is empty"),
 * make_swap_groups() in readir.cpp ("Swap group %s does not contain any
 * atoms") and qmmmoptions.cpp ("Group %s defining QM atoms should not be
 * empty"). An empty IMD or density-guided group passes grompp.
 */
const MDP_EMPTY_IS_FATAL = new RegExp('^(pull-group\\d+-name|rot-group\\d+|swap-group|' +
  'split-group[01]|solvent-group|qmmm-cp2k-qmgroup)$');

/* An .mdp enum value as grompp compares it: case, dashes and underscores ignored. */
const mdpEnum = v => String(v ?? '').toLowerCase().replace(/[-_]/g, '');

/*
 * integratorHasReferenceTemperature() in inputrec.cpp: sd, bd and the test
 * particle insertion integrators always have one; the md integrators have
 * one when a thermostat is on. grompp sets tcoupl to no for every other
 * integrator (energy minimisation, normal modes) before it gets here.
 */
function hasReferenceTemperature(integrator, tcoupl) {
  const ei = mdpEnum(integrator || 'md');
  if (['sd', 'bd', 'tpi', 'tpic'].includes(ei)) return true;
  if (['steep', 'cg', 'lbfgs', 'nm'].includes(ei)) return false;
  return mdpEnum(tcoupl || 'no') !== 'no';
}

/**
 * Check every group an `.mdp` names against an index, with the coverage
 * rule grompp applies to each option.
 *
 * tc-grps must cover every atom only when the run has a reference
 * temperature (a thermostat on an md integrator, or sd, bd, tpi); otherwise
 * grompp puts the atoms left out in a rest group, as it does for energygrps.
 * `integrator` and `tcoupl` are read from the same object, with grompp's
 * defaults (md, no) when absent. An empty tc-grps is checked too, since a
 * thermostat with no groups couples nothing and grompp stops on it.
 *
 * @param {Array<{name:string, atoms:number[]}>} groups
 * @param {Object<string,string>} mdp - Option to value, e.g.
 *        `{ tcoupl: 'v-rescale', 'tc-grps': 'Protein non-Protein',
 *        pull_group1_name: 'LIG' }`; underscores and dashes are equivalent,
 *        as in grompp.
 * @param {number} natoms
 * @returns {{ok:boolean, options:Array<{option:string, ok:boolean,
 *   errors:string[], notes:string[]}>}}
 */
export function checkMdpGroups(groups, mdp, natoms) {
  const results = [];
  const entries = Object.entries(mdp || {}).map(([rawKey, rawValue]) => [
    String(rawKey).trim().toLowerCase().replace(/_/g, '-'),
    String(rawValue ?? '').split(';')[0].trim()
  ]);
  const setting = new Map(entries);
  const reference = hasReferenceTemperature(setting.get('integrator'), setting.get('tcoupl'));
  for (const [key, value] of entries) {
    if (key in MDP_GROUP_OPTIONS) {
      const coverage = key === 'tc-grps' && !reference ? 'rest' : MDP_GROUP_OPTIONS[key];
      if (!value && coverage !== 'all') continue;
      const r = checkGroupCoverage(groups, value, natoms, { coverage, option: key });
      results.push({ option: key, ok: r.ok, errors: r.errors, notes: r.notes });
    } else if (key === 'energygrp-excl' || key === 'energygrp-table') {
      const errors = value.split(/\s+/).filter(Boolean)
        .filter(n => findIndexGroup(groups, n) < 0)
        .map(n => `Group ${n} in ${key} is not in the index.`);
      results.push({ option: key, ok: !errors.length, errors, notes: [] });
    } else if (MDP_SINGLE_GROUPS.test(key) && value) {
      const at = findIndexGroup(groups, value);
      const errors = at < 0 ? [`Group ${value} in ${key} is not in the index.`] : [];
      const notes = [];
      if (at >= 0 && !groups[at].atoms.length) {
        if (MDP_EMPTY_IS_FATAL.test(key)) {
          errors.push(`Group ${value} in ${key} is empty; grompp stops on this.`);
        } else notes.push(`Group ${value} is empty.`);
      }
      results.push({ option: key, ok: !errors.length, errors, notes });
    }
  }
  return { ok: results.every(r => r.ok), options: results };
}

/* ------------------------------------------------------------------ *
 * Custom groups
 * ------------------------------------------------------------------ */

const topCache = new WeakMap();
function cached(top, key, make) {
  let entry = topCache.get(top);
  if (!entry) { entry = {}; topCache.set(top, entry); }
  if (!(key in entry)) entry[key] = make();
  return entry[key];
}

/*
 * Ion names, as residue or atom names, to the element. A .gro file has no
 * element column, and a guess from the atom name alone reads CHARMM's SOD as
 * sulphur, CLA as carbon and POT as phosphorus, and AMBER's NA+ as nitrogen.
 * In a residue that is an ion the name is the ion's, so it is looked up here
 * first.
 */
const ION_ELEMENTS = (() => {
  const source = {
    Li: 'LI LI+ LIT', Na: 'NA NA+ SOD', K: 'K K+ POT', Rb: 'RB RB+ RUB', Cs: 'CS CS+ CES',
    Mg: 'MG MG2 MG2+', Ca: 'CA CA2 CA2+ CAL', Sr: 'SR SR2+', Ba: 'BA BA2+ BAR',
    Zn: 'ZN ZN2 ZN2+', Cd: 'CD CD2 CD2+', Cu: 'CU CU1 CU+ CU2 CU2+', Fe: 'FE FE2 FE3 FE2+ FE3+',
    Mn: 'MN MN2 MN2+', Co: 'CO CO2+', Ni: 'NI NI2+', Hg: 'HG HG2+',
    F: 'F F-', Cl: 'CL CL- CLA', Br: 'BR BR-', I: 'I I- IOD'
  };
  const table = new Map();
  for (const [el, names] of Object.entries(source)) for (const n of names.split(' ')) table.set(n, el);
  return table;
})();

/* The first letters of the elements a protein, nucleic-acid or water residue holds. */
const ORGANIC_ELEMENTS = new Set(['C', 'H', 'N', 'O', 'S', 'P']);

/*
 * The element of one atom. The PDB element column wins when there is one;
 * otherwise the residue decides how the atom name is read:
 *
 *   - In an ion residue (SOD, CLA, NA+, Cal, Martini's ION) the atom or
 *     residue name is the ion.
 *   - In a residue GROMACS types as Protein, DNA, RNA or Water, every real
 *     atom is C, H, N, O, S or P, so the first letter is the element; a name
 *     starting with M is a dummy mass or virtual site (MNZ1 and MCB1 of the
 *     virtual-site topologies, MW of TIP4P) and has none, where a guess from
 *     the name would read MNZ1 as manganese.
 *   - Anything else is guessed from the name as `core/structure.js` does.
 */
function atomElement(top, a) {
  const res = top.residues[a.resIndex];
  if (!String(a.element || '').trim()) {
    const resName = up(res.name);
    const type = residueTypeOf(res.name);
    if (type === 'Ion' || ION_NAMES.has(resName)) {
      const el = ION_ELEMENTS.get(up(a.name)) ||
        (res.count === 1 ? ION_ELEMENTS.get(resName) : undefined);
      if (el) return el;
    } else if (type !== 'Other' || WATER_NAMES.has(resName)) {
      const first = up(String(a.name).trim().replace(/^\d+/, '')).charAt(0);
      if (ORGANIC_ELEMENTS.has(first)) return first;
      if (first === 'M') return 'X';
    }
  }
  return elementSymbol({ element: a.element, atomName: a.name, resName: res.name });
}

function elements(top) {
  return cached(top, 'elements', () => top.atoms.map(a => atomElement(top, a)));
}

function maskToAtoms(mask) {
  const out = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) out.push(i + 1);
  return out;
}

function expandToResidues(top, mask) {
  const res = new Uint8Array(top.residues.length);
  top.atoms.forEach((a, i) => { if (mask[i]) res[a.resIndex] = 1; });
  const out = new Uint8Array(mask.length);
  top.atoms.forEach((a, i) => { if (res[a.resIndex]) out[i] = 1; });
  return out;
}

/*
 * The shifts to the periodic images a distance search must look through:
 * the box itself and, with a usable box, its 26 neighbours. With them,
 * distances across the periodic boundary count, which a structure straight
 * out of a simulation (molecules made whole, sticking out of the box) needs.
 * `lo` and `hi` bound every atom, so an image farther than the cutoff from
 * that box can be skipped.
 */
function periodicImages(top, pbc) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const a of top.atoms) {
    if (a.x < lo[0]) lo[0] = a.x;
    if (a.y < lo[1]) lo[1] = a.y;
    if (a.z < lo[2]) lo[2] = a.z;
    if (a.x > hi[0]) hi[0] = a.x;
    if (a.y > hi[1]) hi[1] = a.y;
    if (a.z > hi[2]) hi[2] = a.z;
  }
  const shifts = [];
  const box = pbc && top.box && top.box.every(v => v.some(c => c !== 0)) ? top.box : null;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
    if (!box && (i || j || k)) continue;
    shifts.push(box
      ? [0, 1, 2].map(d => i * box[0][d] + j * box[1][d] + k * box[2][d])
      : [0, 0, 0]);
  }
  const reachable = (x, y, z, cutoff) => !(x < lo[0] - cutoff || x > hi[0] + cutoff ||
    y < lo[1] - cutoff || y > hi[1] + cutoff || z < lo[2] - cutoff || z > hi[2] + cutoff);
  return { shifts, reachable, periodic: !!box };
}

/*
 * Atoms within `cutoff` nm of any target atom, through the periodic images
 * when `pbc` is set and the structure has a box.
 */
function withinMask(top, targets, cutoff, pbc, candidates = null) {
  const n = top.atoms.length;
  const mask = new Uint8Array(n);
  if (!targets.length || !(cutoff >= 0) || !n) return mask;
  const { shifts, reachable } = periodicImages(top, pbc);
  const points = [];
  for (const s of shifts) {
    for (const t of targets) {
      const a = top.atoms[t];
      const x = a.x + s[0];
      const y = a.y + s[1];
      const z = a.z + s[2];
      if (reachable(x, y, z, cutoff)) points.push({ x, y, z });
    }
  }
  const grid = new SpatialGrid(points, Math.max(cutoff, 1e-3));
  // Only the atoms that could still be selected need a search.
  for (let i = 0; i < n; i++) {
    if (candidates && !candidates[i]) continue;
    const a = top.atoms[i];
    if (grid.hasNeighbourWithin(a.x, a.y, a.z, cutoff)) mask[i] = 1;
  }
  return mask;
}

/*
 * The pool the selection language's `within:` searches, made periodic.
 * compileSelection finds the atoms a `within:` term measures from with
 * `pool.filter(test)`; this pool answers with those atoms and their copies in
 * the neighbouring periodic images, so a query measures across the boundary
 * as the builder's `within` and gmx select do. The test is applied to the
 * atoms themselves, so a coordinate test (`within:0.5,x:<1`) picks the same
 * atoms with images as without. Everything else sees the plain atom list.
 */
class PeriodicPool extends Array {
  // Array methods, the filter below included, return plain arrays.
  static get [Symbol.species]() { return Array; }

  filter(test, thisArg) {
    const hits = super.filter(test, thisArg);
    const { shifts, reachable, reach } = this.images;
    const n = hits.length;
    for (const s of shifts) {
      if (!s[0] && !s[1] && !s[2]) continue;
      for (let i = 0; i < n; i++) {
        const a = hits[i];
        const x = a.x + s[0];
        const y = a.y + s[1];
        const z = a.z + s[2];
        if (reachable(x, y, z, reach)) hits.push({ ...a, x, y, z });
      }
    }
    return hits;
  }
}

/*
 * The largest `within:` radius in a query, in nm, as compileSelection reads
 * it, or -1 when there is none: images farther than that from every atom
 * cannot be reached.
 */
function withinReach(query, unit) {
  let reach = -1;
  for (const m of String(query ?? '').matchAll(/within:([^,\s|]*),/gi)) {
    const r = Number(m[1]) * (unit === 'A' ? 0.1 : 1);
    if (Number.isFinite(r) && r > reach) reach = r;
  }
  return reach;
}

function listOf(v) {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : String(v).split(/[\s,]+/))
    .map(x => String(x).trim()).filter(Boolean);
}

/* "1-50,60 70-80" or [1, [5, 9]] -> predicate on a number */
function numberSet(v) {
  const ranges = [];
  const pair = Array.isArray(v) && v.length === 2 && v.every(x => typeof x === 'number');
  const items = pair ? [v] : (Array.isArray(v) ? v : [v]);
  for (const item of items) {
    if (Array.isArray(item)) { ranges.push([Math.min(...item), Math.max(...item)]); continue; }
    if (typeof item === 'number') { ranges.push([item, item]); continue; }
    for (const part of String(item).split(/[\s,]+/).filter(Boolean)) {
      const m = /^(-?\d+)(?:\s*(?:-|to|:)\s*(-?\d+))?$/.exec(part);
      if (m) {
        const a = Number(m[1]);
        const b = m[2] === undefined ? a : Number(m[2]);
        ranges.push([Math.min(a, b), Math.max(a, b)]);
      } else return null;
    }
  }
  return x => ranges.some(([a, b]) => x >= a && x <= b);
}

function specName(spec) {
  const parts = [];
  const names = v => listOf(v).map(up).join('_');
  if (spec.group) parts.push(String(spec.group));
  if (spec.resname !== undefined) parts.push(names(spec.resname));
  // A pair of numbers is a range, named as make_ndx names `r 1-50`.
  const nums = v => (Array.isArray(v) && v.length === 2 && v.every(x => typeof x === 'number')
    ? `${v[0]}-${v[1]}` : listOf(v).join('_'));
  if (spec.resnr !== undefined) parts.push(`r_${nums(spec.resnr)}`);
  if (spec.resindex !== undefined) parts.push(`ri_${nums(spec.resindex)}`);
  if (spec.atomname !== undefined) parts.push(names(spec.atomname));
  if (spec.atoms !== undefined) parts.push(`a_${listOf(spec.atoms).join('_')}`);
  if (spec.chain !== undefined) parts.push(`ch${listOf(spec.chain).join('')}`);
  if (spec.element !== undefined) parts.push(listOf(spec.element).join('_'));
  if (spec.role !== undefined) {
    parts.push(listOf(spec.role).map(r => r[0].toUpperCase() + r.slice(1)).join('_'));
  }
  if (spec.query !== undefined) parts.push('Selection');
  if (spec.within) {
    const of = typeof spec.within.of === 'string' ? spec.within.of : specName(spec.within.of || {});
    parts.push(`within_${spec.within.distance}_of_${of}`);
  }
  if (spec.or) parts.push(spec.or.map(specName).join('_'));
  if (spec.and) parts.push(spec.and.map(specName).join('_&_'));
  if (spec.not) parts.push(`!${specName(spec.not)}`);
  return sanitiseGroupName(parts.join('_&_'), 'Custom');
}

function evalSpec(ctx, spec) {
  const { top } = ctx;
  const n = top.atoms.length;
  if (typeof spec === 'string') spec = { group: spec };
  let mask = new Uint8Array(n).fill(1);
  const and = (m) => { for (let i = 0; i < n; i++) mask[i] &= m[i]; };
  const byAtom = (pred) => {
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (pred(i)) m[i] = 1;
    return m;
  };
  const nameTest = (v) => {
    const wanted = listOf(v);
    return s => wanted.some(w => compName(s, w, !!ctx.caseSensitive));
  };

  if (spec.group !== undefined) {
    const at = findIndexGroup(ctx.groups(), spec.group);
    if (at < 0) {
      ctx.errors.push(`There is no group ${spec.group}.`);
      and(new Uint8Array(n));
    } else {
      const m = new Uint8Array(n);
      for (const a of ctx.groups()[at].atoms) if (a >= 1 && a <= n) m[a - 1] = 1;
      and(m);
    }
  }
  if (spec.resname !== undefined) {
    const t = nameTest(spec.resname);
    and(byAtom(i => t(top.residues[top.atoms[i].resIndex].name)));
  }
  if (spec.resnr !== undefined || spec.resindex !== undefined) {
    const byIndex = spec.resnr === undefined;
    const test = numberSet(byIndex ? spec.resindex : spec.resnr);
    if (!test) {
      ctx.errors.push(`Cannot read the residue numbers "${byIndex ? spec.resindex : spec.resnr}".`);
      and(new Uint8Array(n));
    } else {
      const key = a => (byIndex ? a.resIndex + 1 : top.residues[a.resIndex].nr);
      and(byAtom(i => test(key(top.atoms[i]))));
    }
  }
  if (spec.atomname !== undefined) {
    const t = nameTest(spec.atomname);
    and(byAtom(i => t(top.atoms[i].name)));
  }
  if (spec.atoms !== undefined) {
    const test = numberSet(spec.atoms);
    if (!test) {
      ctx.errors.push(`Cannot read the atom numbers "${spec.atoms}".`);
      and(new Uint8Array(n));
    } else and(byAtom(i => test(i + 1)));
  }
  if (spec.chain !== undefined) {
    const wanted = new Set(listOf(spec.chain));
    and(byAtom(i => wanted.has(top.residues[top.atoms[i].resIndex].chain.trim())));
  }
  if (spec.element !== undefined) {
    const wanted = new Set(listOf(spec.element)
      .map(e => e[0].toUpperCase() + e.slice(1).toLowerCase()));
    const el = elements(top);
    and(byAtom(i => wanted.has(el[i])));
  }
  if (spec.role !== undefined) {
    const wanted = new Set(listOf(spec.role).map(r => r.toLowerCase()));
    const roles = residueRoles(top, ctx.options);
    and(byAtom(i => {
      const r = roles[top.atoms[i].resIndex];
      return wanted.has(r) ||
        (wanted.has('solvent') && ['water', 'ion', 'cosolvent'].includes(r)) ||
        (wanted.has('polymer') && ['protein', 'nucleic'].includes(r));
    }));
  }
  if (spec.query !== undefined) {
    const records = cached(top, 'records', () => top.atoms.map((a, i) => {
      const r = top.residues[a.resIndex];
      return {
        atomName: a.name, resName: r.name, resSeq: r.nr, chain: r.chain.trim(),
        element: elements(top)[i], serial: i + 1, x: a.x, y: a.y, z: a.z
      };
    }));
    const unit = ctx.options.unit || 'nm';
    // `within:` measures through the periodic images, as the builder's
    // `within` does, unless the caller turns periodic boundaries off.
    const reach = withinReach(spec.query, unit);
    const images = reach >= 0 ? periodicImages(top, ctx.options.pbc !== false) : null;
    let pool = records;
    if (images && images.periodic) {
      pool = PeriodicPool.from(records);
      pool.images = { ...images, reach };
    }
    const c = compileSelection(spec.query, pool, { unit, coordinateUnit: 'nm' });
    ctx.errors.push(...c.errors);
    and(byAtom(i => c.predicate(records[i])));
  }
  if (spec.within) {
    const w = spec.within;
    const distance = Number(w.distance);
    if (!(distance >= 0) || w.of === undefined || w.of === null) {
      ctx.errors.push('within needs a distance in nm and the group or description it is ' +
        'measured from.');
      and(new Uint8Array(n));
    } else {
      const target = evalSpec(ctx, w.of);
      const idx = [];
      target.forEach((v, i) => { if (v) idx.push(i); });
      // Whole residues can reach beyond the atoms selected so far.
      let m = withinMask(top, idx, distance, w.pbc !== false, w.byResidue ? null : mask);
      if (w.byResidue) m = expandToResidues(top, m);
      and(m);
    }
  }
  if (Array.isArray(spec.or)) {
    const u = new Uint8Array(n);
    for (const sub of spec.or) {
      const m = evalSpec(ctx, sub);
      for (let i = 0; i < n; i++) u[i] |= m[i];
    }
    and(u);
  }
  if (Array.isArray(spec.and)) for (const sub of spec.and) and(evalSpec(ctx, sub));
  if (spec.not !== undefined) {
    const m = evalSpec(ctx, spec.not);
    and(m.map(v => 1 - v));
  }
  if (spec.byResidue) mask = expandToResidues(top, mask);
  return mask;
}

/**
 * Build a group from a description. Every criterion given must hold (they
 * are ANDed); `or`, `and` and `not` nest further descriptions.
 *
 * ```js
 * customGroup(top, { resname: 'LIG' })
 * customGroup(top, { chain: 'A', resnr: '1-50', atomname: 'CA' })
 * customGroup(top, { role: 'polymer', within: { distance: 0.5, of: { resname: 'LIG' } },
 *                    byResidue: true, name: 'Pocket' })
 * customGroup(top, { or: [{ group: 'Protein' }, { resname: 'LIG' }] })
 * customGroup(top, { query: 'elem:C !resn:SOL' })
 * ```
 *
 * @param {GromacsStructure|object} structure
 * @param {object|string} spec - A group name, or an object with any of:
 *   `name` (of the result), `group` (an existing group, matched as grompp
 *   does), `resname`, `atomname` (lists; `?` and a trailing `*` as in
 *   make_ndx, case-insensitive), `resnr` (residue numbers as in the file:
 *   5, [1, 50], '1-50,60'), `resindex` (residues counted from 1), `atoms`
 *   (atom numbers, same forms), `chain`, `element`, `role` ('protein',
 *   'nucleic', 'polymer', 'glycan', 'ligand', 'lipid', 'water', 'ion',
 *   'cosolvent', 'solvent'), `query` (the `core/selection.js` language,
 *   distances in nm unless `unit` says 'A', `within:` through the periodic
 *   boundary unless `pbc` is false), `within: {distance, of, byResidue?, pbc?}`
 *   (distance in nm; `of` is a spec or group name), `byResidue` (whole
 *   residues), `or`, `and`, `not`.
 * @param {{groups?:Array<{name:string, atoms:number[]}>, unit?:'nm'|'A',
 *   caseSensitive?:boolean, pbc?:boolean}} [options] - `groups` resolves
 *   `group:` names; the default groups are used when not given. `pbc`
 *   (default true) lets a `query`'s `within:` measure across the periodic
 *   boundary of the structure's box, as `within` does.
 * @returns {{name:string, atoms:number[], errors:string[]}}
 */
export function customGroup(structure, spec, options = {}) {
  const top = toGromacsStructure(structure);
  let groupsCache = options.groups || null;
  const ctx = {
    top,
    options,
    caseSensitive: !!options.caseSensitive,
    errors: [],
    groups: () => (groupsCache || (groupsCache = defaultGroups(top)))
  };
  const s = typeof spec === 'string' ? { group: spec } : (spec || {});
  const mask = evalSpec(ctx, s);
  const name = s.name ? sanitiseGroupName(s.name) : specName(s);
  return { name, atoms: maskToAtoms(mask), errors: ctx.errors };
}

/**
 * Atoms in either group, ascending, each once.
 *
 * @param {{name:string, atoms:number[]}} a
 * @param {{name:string, atoms:number[]}} b
 * @param {string} [name] - Default `a_b`, as make_ndx names `1 | 13`.
 * @returns {{name:string, atoms:number[]}}
 */
export function orGroups(a, b, name) {
  const atoms = [...new Set([...(a.atoms || []), ...(b.atoms || [])])].sort((x, y) => x - y);
  return { name: name || `${a.name}_${b.name}`, atoms };
}

/**
 * Atoms in both groups, ascending, each once.
 *
 * @param {{name:string, atoms:number[]}} a
 * @param {{name:string, atoms:number[]}} b
 * @param {string} [name] - Default `a_&_b`, as make_ndx names `1 & 13`.
 * @returns {{name:string, atoms:number[]}}
 */
export function andGroups(a, b, name) {
  const inB = new Set(b.atoms || []);
  const atoms = [...new Set((a.atoms || []).filter(x => inB.has(x)))].sort((x, y) => x - y);
  return { name: name || `${a.name}_&_${b.name}`, atoms };
}

/**
 * Every atom of the system not in the group.
 *
 * @param {{name:string, atoms:number[]}} g
 * @param {number|GromacsStructure|object} natomsOrStructure
 * @param {string} [name] - Default `!name`, as make_ndx names `! 13`.
 * @returns {{name:string, atoms:number[]}}
 */
export function notGroup(g, natomsOrStructure, name) {
  const n = typeof natomsOrStructure === 'number'
    ? natomsOrStructure : toGromacsStructure(natomsOrStructure).atoms.length;
  const inG = new Set(g.atoms || []);
  const atoms = [];
  for (let i = 1; i <= n; i++) if (!inG.has(i)) atoms.push(i);
  return { name: name || `!${g.name}`, atoms };
}

/* ------------------------------------------------------------------ *
 * Suggestions
 * ------------------------------------------------------------------ */

/*
 * Covalent bonds between heavy atoms are 0.14-0.15 nm in a glycosidic or
 * N-glycosidic link (C1-O, C1-ND2). Nothing that is not bonded comes as close:
 * hydrogen-bonded heavy atoms stay 0.25 nm or more apart, and even
 * `gmx insert-molecules`, which packs cosolvent tighter than an equilibrated
 * liquid, keeps heavy atoms 0.17 nm apart at its default scale (0.57 of the
 * van der Waals sum).
 */
const BOND_CUTOFF = 0.165;

/*
 * Residues joined to the polymer, directly or through one another: a glycan
 * on an asparagine, the next sugar on that glycan. A .gro file has no bonds,
 * so two heavy atoms within BOND_CUTOFF stand for one, measured through the
 * periodic boundary since a molecule may be split across it. `candidate`
 * marks the residues to test, `polymer` the ones the search starts from.
 */
function joinedResidues(top, polymer, candidate) {
  const el = elements(top);
  const heavy = i => el[i] !== 'H' && el[i] !== 'X';
  const joined = new Uint8Array(top.residues.length);
  const open = new Uint8Array(top.atoms.length);
  let targets = [];
  top.atoms.forEach((a, i) => {
    if (!heavy(i)) return;
    if (polymer[a.resIndex]) targets.push(i);
    else if (candidate[a.resIndex]) open[i] = 1;
  });
  while (targets.length && open.some(Boolean)) {
    const hit = withinMask(top, targets, BOND_CUTOFF, true, open);
    const found = new Set();
    hit.forEach((v, i) => { if (v) found.add(top.atoms[i].resIndex); });
    if (!found.size) break;
    targets = [];
    for (const ri of found) {
      joined[ri] = 1;
      const r = top.residues[ri];
      for (let i = r.first; i < r.first + r.count; i++) {
        if (!open[i]) continue;
        open[i] = 0;
        targets.push(i);
      }
    }
  }
  return joined;
}

/*
 * One role per residue: what the residue is for the purposes of a set-up,
 * which is not always what GROMACS calls it (TIP3 is water, POPC a lipid,
 * CHARMM's ADE a nucleotide).
 */
function residueRoles(top, options = {}) {
  const maxCopies = options.maxLigandCopies ?? 5;
  return cached(top, `roles:${maxCopies}`, () => {
    const names = top.residues.map(r => up(r.name));
    const present = new Set(names);
    const amberLipids = [...present].some(n => AMBER_LIPID_HEADS.has(n)) &&
      [...present].some(n => AMBER_LIPID_TAILS.has(n));
    const copies = new Map();
    for (const n of names) copies.set(n, (copies.get(n) || 0) + 1);
    const types = top.residues.map(r => residueTypeOf(r.name));
    // A residue GROMACS does not know, with N, CA and C, next to a protein
    // residue is a modified amino acid (SEP, MSE, NLE), not a ligand.
    const aminoAcidLike = (r, i) => {
      if (types[i - 1] !== 'Protein' && types[i + 1] !== 'Protein') return false;
      const atomNames = new Set(top.atoms.slice(r.first, r.first + r.count).map(a => a.name));
      return atomNames.has('N') && atomNames.has('CA') && atomNames.has('C');
    };
    const roles = top.residues.map((r, i) => {
      const type = types[i];
      if (type === 'Protein') return 'protein';
      if (type === 'DNA' || type === 'RNA') return 'nucleic';
      if (type === 'Water') return 'water';
      if (type === 'Ion') return 'ion';
      const n = names[i];
      if (WATER_NAMES.has(n)) return 'water';
      if (ION_NAMES.has(n)) return 'ion';
      if (NUCLEIC_NAMES.has(n)) return 'nucleic';
      if (LIPID_NAMES.has(n)) return 'lipid';
      if (amberLipids && (AMBER_LIPID_HEADS.has(n) || AMBER_LIPID_TAILS.has(n))) return 'lipid';
      if (aminoAcidLike(r, i)) return 'protein';
      return copies.get(n) > maxCopies ? 'cosolvent' : 'ligand';
    });
    // A residue joined to the protein or nucleic acid is part of the solute
    // however many copies there are: eight NAG on a glycoprotein are not a
    // cosolvent to couple with the water. Only the residues whose role this
    // can change are searched: many copies, or a sugar's name.
    const polymer = roles.map(r => (r === 'protein' || r === 'nucleic' ? 1 : 0));
    const candidate = roles.map((role, i) => (role === 'cosolvent' ||
      (role === 'ligand' && isGlycanName(top.residues[i].name)) ? 1 : 0));
    if (polymer.includes(1) && candidate.includes(1)) {
      const joined = joinedResidues(top, polymer, candidate);
      joined.forEach((v, i) => {
        if (v) roles[i] = isGlycanName(top.residues[i].name) ? 'glycan' : 'ligand';
      });
    }
    return roles;
  });
}

/* What a solute bath holds, and what a solvent bath holds. */
const SOLUTE_ROLES = ['protein', 'nucleic', 'glycan', 'ligand'];
const SOLVENT_ROLES = ['water', 'ion', 'cosolvent'];

function idxOfRoles(top, roles, wanted) {
  const out = [];
  top.atoms.forEach((a, i) => { if (wanted.includes(roles[a.resIndex])) out.push(i); });
  return out;
}

/**
 * What a structure is made of, one entry per residue name in order of first
 * appearance: GROMACS's residue type and the role used for suggestions
 * ('protein', 'nucleic', 'glycan', 'ligand', 'lipid', 'water', 'ion' or
 * 'cosolvent'). A residue joined to the protein or nucleic acid (a sugar of a
 * glycan, say) is never a cosolvent, however many copies there are.
 *
 * @param {GromacsStructure|object} structure
 * @param {{maxLigandCopies?:number}} [options] - A non-standard residue with
 *        more copies than this (default 5) is a cosolvent, not a ligand.
 * @returns {Array<{name:string, type:string, role:string, residues:number,
 *   atoms:number}>}
 */
export function systemComposition(structure, options = {}) {
  const top = toGromacsStructure(structure);
  const roles = residueRoles(top, options);
  const by = new Map();
  top.residues.forEach((r, i) => {
    let e = by.get(r.name);
    if (!e) {
      e = { name: r.name, type: residueTypeOf(r.name), role: roles[i], residues: 0, atoms: 0 };
      by.set(r.name, e);
    }
    e.residues += 1;
    e.atoms += r.count;
  });
  return [...by.values()];
}

/* Same atoms, in any order: grompp does not care about the order. */
function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = Int32Array.from(a).sort();
  const sb = Int32Array.from(b).sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

/**
 * Recommend `tc-grps` for a system: few groups, each with enough atoms for
 * a meaningful temperature, split where heat is exchanged slowly (solute
 * against solvent, bilayer against water).
 *
 * @param {GromacsStructure|object} structure
 * @param {{minAtoms?:number, maxLigandCopies?:number,
 *   groups?:Array<{name:string, atoms:number[]}>}} [options] - A solute,
 *   membrane or solvent with fewer atoms than `minAtoms` (default 100) gets
 *   no bath of its own: one bath then covers the system. `groups` are the
 *   index groups to reuse (the default groups when not given).
 * @returns {{names:string[], groups:Array<{name:string, atoms:number[]}>,
 *   reason:string, line:string}} `groups` holds any group the index needs
 *   beyond those given.
 */
export function recommendTcGrps(structure, options = {}) {
  const top = toGromacsStructure(structure);
  const { minAtoms = 100 } = options;
  const n = top.atoms.length;
  const known = options.groups ? options.groups.map(toIdxGroup) : defaultGroupsIdx(top);
  const roles = residueRoles(top, options);
  const solute = idxOfRoles(top, roles, SOLUTE_ROLES);
  const membrane = idxOfRoles(top, roles, ['lipid']);
  const solvent = idxOfRoles(top, roles, SOLVENT_ROLES);
  const extra = [];

  // An existing group with one of the preferred names and the same atoms,
  // else a new group (renamed if its name is taken by different atoms).
  const pick = (idx, preferred, fallbackName) => {
    for (const name of preferred) {
      const at = known.findIndex(g => caseEq(g.name, name));
      if (at >= 0 && sameSet(known[at].idx, idx)) return known[at].name;
    }
    let name = fallbackName;
    for (let k = 2; known.some(g => caseEq(g.name, name)); k++) name = `${fallbackName}_${k}`;
    extra.push({ name, idx });
    return name;
  };

  const result = (names, reason) => ({
    names,
    groups: extra.map(toGroup),
    reason,
    line: `tc-grps = ${names.join(' ')}`
  });

  if (!n) return result([], 'The structure has no atoms.');
  if (!solvent.length || solvent.length === n) {
    return result(['System'], solvent.length
      ? 'Everything is solvent, so one bath covers it.'
      : 'There is no solvent to couple separately (vacuum, or a single phase), so one bath ' +
        'covers it.');
  }
  const soluteName = soluteLabel(top, roles);
  const solventPreferred = ['Water_and_ions', 'Water', 'SOL', 'Solvent'];

  // Every bath, not only the solute's, needs enough atoms for its
  // temperature to mean anything. A handful of counter-ions or crystal
  // waters in a bath of their own is the case the GROMACS FAQ answers
  // "Should I couple a handful of ions to their own temperature-coupling
  // bath? No.", and grompp accepts it silently. Below `minAtoms`, the small
  // part shares the one bath with everything else.
  const contents = (wanted) => {
    const counts = new Map();
    top.residues.forEach((r, i) => {
      if (wanted.includes(roles[i])) counts.set(r.name, (counts.get(r.name) || 0) + 1);
    });
    const list = [...counts].map(([name, k]) => `${k} ${name}`);
    return list.length > 4 ? `${list.slice(0, 4).join(', ')}, ...` : list.join(', ');
  };
  const tooSmall = (what, idx, wanted) => (idx.length >= minAtoms ? null
    : result(['System'], `The ${what} has only ${idx.length} atom${plural(idx.length)} ` +
      `(${contents(wanted)}), too few for a meaningful temperature of a bath of its own, ` +
      'so one bath covers the system.'));
  const split = (sizes) => `each bath has at least ${minAtoms} atoms (${sizes}), enough for a ` +
    'meaningful temperature';

  if (membrane.length) {
    if (!solute.length) {
      const small = tooSmall('membrane', membrane, ['lipid']) ||
        tooSmall('solvent', solvent, SOLVENT_ROLES);
      if (small) return small;
      const names = [pick(membrane, ['Membrane'], 'Membrane'),
        pick(solvent, solventPreferred, 'Solvent')];
      return result(names, 'A bilayer in solvent: couple the membrane and the solvent ' +
        `separately, since heat crosses the interface slowly; ${split(
          `${membrane.length} and ${solvent.length}`)}.`);
    }
    const joined = [...solute, ...membrane].sort((a, b) => a - b);
    const small = tooSmall('solute with the membrane', joined, [...SOLUTE_ROLES, 'lipid']) ||
      tooSmall('solvent', solvent, SOLVENT_ROLES);
    if (small) return small;
    const name = `${soluteName}_Membrane`;
    const names = [pick(joined, [name], name), pick(solvent, solventPreferred, 'Solvent')];
    return result(names, 'The solute sits in the bilayer and exchanges heat with it directly, ' +
      'so the two share a bath; the solvent gets its own (the CHARMM-GUI convention), and ' +
      `${split(`${joined.length} and ${solvent.length}`)}.`);
  }
  if (solute.length < minAtoms) {
    return result(['System'], `The solute has only ${solute.length} atoms, too few for a ` +
      'meaningful temperature of its own, so one bath covers the system.');
  }
  const small = tooSmall('solvent', solvent, SOLVENT_ROLES);
  if (small) return small;
  const soluteGroup = pick(solute, [soluteName], soluteName);
  // Protein against non-Protein is the pairing most tutorials use.
  const solventGroup = soluteGroup === 'Protein'
    ? pick(solvent, ['non-Protein', ...solventPreferred], 'Solvent')
    : pick(solvent, solventPreferred, 'Solvent');
  return result([soluteGroup, solventGroup], 'Couple the solute and the solvent separately: they ' +
    `exchange heat slowly, and ${split(`${solute.length} and ${solvent.length}`)}.`);
}

function soluteLabel(top, roles) {
  const parts = [];
  const seen = new Set();
  top.residues.forEach((r, i) => {
    let label = null;
    if (SOLUTE_ROLES.includes(roles[i])) {
      const type = residueTypeOf(r.name);
      if (type !== 'Other') label = type;
      else if (roles[i] === 'glycan') label = 'Glycan';
      else if (roles[i] === 'nucleic') {
        // CHARMM names DNA and RNA nucleotides alike (ADE, CYT, ...); the
        // 2'-hydroxyl tells them apart.
        const atoms = top.atoms.slice(r.first, r.first + r.count);
        label = atoms.some(a => a.name === "O2'" || a.name === 'O2*') ? 'RNA' : 'DNA';
      } else label = r.name;
    }
    if (label && !seen.has(label)) { seen.add(label); parts.push(label); }
  });
  // Polymers first, then other residues in order of appearance, as make_ndx
  // would name `1 | 13`: Protein_LIG, Protein_SEP_LIG.
  const polymers = parts.filter(p => p === 'Protein' || p === 'DNA' || p === 'RNA');
  const rest = parts.filter(p => !polymers.includes(p));
  return sanitiseGroupName([...polymers, ...rest].join('_'), 'Solute');
}

/**
 * Groups worth adding to the defaults for a typical set-up: the ligand(s),
 * the protein-ligand complex (tc-grps, pulling), the binding pocket, the
 * membrane and the solvent, plus the recommended `tc-grps`.
 *
 * ```js
 * const top = readGromacsStructure(text, 'conf.gro');
 * const s = suggestGroups(top);
 * const index = writeNdx([...defaultGroups(top), ...s.groups]);
 * ```
 *
 * @param {GromacsStructure|object} structure
 * @param {{pocketCutoff?:number, pbc?:boolean, maxLigandCopies?:number,
 *   minAtoms?:number}} [options] - `pocketCutoff` in nm (default 0.5):
 *   residues with any atom this close to the ligand form the pocket.
 * @returns {{composition:Array<object>, ligands:Array<{name:string,
 *   residues:number, atoms:number}>, lipids:string[],
 *   groups:Array<{name:string, atoms:number[], kind:string, reason:string}>,
 *   tcGrps:{names:string[], groups:Array<{name:string, atoms:number[]}>,
 *   reason:string, line:string}, notes:string[]}}
 */
export function suggestGroups(structure, options = {}) {
  const top = toGromacsStructure(structure);
  const { pocketCutoff = 0.5, pbc = true } = options;
  const defaults = defaultGroupsIdx(top);
  const roles = residueRoles(top, options);
  const comp = systemComposition(top, options);
  const notes = [];
  const out = [];
  const taken = new Set(defaults.map(g => up(g.name)));
  // Skip a group the defaults already hold under this name, or, when
  // `anyName` is set, under any name (a Solvent that is Water_and_ions).
  const add = (name, idx, kind, reason, anyName = false) => {
    const existing = defaults.find(g => (anyName || caseEq(g.name, name)) && sameSet(g.idx, idx));
    if (existing || !idx.length) return;
    let nm = sanitiseGroupName(name);
    while (taken.has(up(nm))) nm = `${nm}_2`;
    taken.add(up(nm));
    out.push({ name: nm, atoms: idx.map(i => i + 1), kind, reason });
  };

  const ligands = comp.filter(c => c.role === 'ligand');
  const polymer = idxOfRoles(top, roles, ['protein', 'nucleic']);
  const ligandIdx = idxOfRoles(top, roles, ['ligand']);
  const ligandNames = ligands.map(l => l.name);

  if (ligands.length > 1) {
    add(sanitiseGroupName(ligandNames.join('_')), ligandIdx, 'ligand',
      'Every ligand together, for analysis or as one pull group.');
  }
  if (ligands.length && polymer.length) {
    const label = soluteLabel(top, roles);
    // The whole solute: glycans joined to the protein go with it.
    const complex = idxOfRoles(top, roles, SOLUTE_ROLES);
    add(label, complex, 'complex', 'The complex as one group, for tc-grps with the solvent ' +
      'and for centring or fitting; for pulling, use the ligand and the protein groups ' +
      'separately.');
    const isPolymer = new Uint8Array(top.atoms.length);
    for (const i of polymer) isPolymer[i] = 1;
    for (const lig of ligands) {
      const ligAtoms = [];
      top.atoms.forEach((a, i) => {
        if (top.residues[a.resIndex].name === lig.name) ligAtoms.push(i);
      });
      const polyMask = withinMask(top, ligAtoms, pocketCutoff, pbc, isPolymer);
      const pocket = maskToAtoms(expandToResidues(top, polyMask)).map(a => a - 1)
        .filter(i => ['protein', 'nucleic'].includes(roles[top.atoms[i].resIndex]));
      if (pocket.length) {
        add(`Pocket_${lig.name}`, pocket, 'pocket', `Whole residues with any atom within ` +
          `${pocketCutoff} nm of ${lig.name}, for restraints or binding-site analysis.`);
      } else notes.push(`No residue lies within ${pocketCutoff} nm of ${lig.name}.`);
    }
  }

  const lipidIdx = idxOfRoles(top, roles, ['lipid']);
  const lipids = comp.filter(c => c.role === 'lipid').map(c => c.name);
  if (lipidIdx.length) {
    add('Membrane', lipidIdx, 'membrane', `Every lipid (${lipids.join(', ')}), for tc-grps, ` +
      'comm-grps and membrane analysis.');
  }
  const solvent = idxOfRoles(top, roles, SOLVENT_ROLES);
  const unknownSolvent = comp.filter(c => ['water', 'ion'].includes(c.role) && c.type === 'Other');
  if (solvent.length && solvent.length < top.atoms.length &&
      (unknownSolvent.length || comp.some(c => c.role === 'cosolvent') || lipidIdx.length)) {
    const names = comp.filter(c => ['water', 'ion', 'cosolvent'].includes(c.role)).map(c => c.name);
    add('Solvent', solvent, 'solvent', `Water, ions and cosolvent together (${names.join(', ')})` +
      (unknownSolvent.length
        ? `; GROMACS files ${unknownSolvent.map(c => c.name).join(', ')} under Other, so its ` +
          'Water_and_ions group misses them.'
        : '.'), true);
  }

  const tc = recommendTcGrps(top, { ...options, groups: [...defaults.map(toGroup), ...out] });
  for (const g of tc.groups) {
    out.push({ ...g, kind: 'tc-grps', reason: `Needed by the recommended ${tc.line}.` });
  }
  return {
    composition: comp,
    ligands: ligands.map(l => ({ name: l.name, residues: l.residues, atoms: l.atoms })),
    lipids,
    groups: out,
    tcGrps: tc,
    notes
  };
}

/* ------------------------------------------------------------------ *
 * Description for the UI
 * ------------------------------------------------------------------ */

/**
 * Summarise groups for display, with the problems grompp would meet.
 *
 * @param {Array<{name:string, atoms:number[]}>} groups
 * @param {GromacsStructure|object} structure
 * @param {{tcGrps?:string|string[]}} [options] - Also check these names as
 *        `tc-grps`: they must exist and cover every atom exactly once.
 * @returns {{natoms:number, groups:Array<{index:number, name:string,
 *   atoms:number, residues:number, residueNames:Array<{name:string,
 *   residues:number, atoms:number}>, chains:string[], first:number|null,
 *   last:number|null}>, warnings:Array<{level:'error'|'warning',
 *   group:string|null, message:string}>, tcGrps:object|null}}
 */
export function describeGroups(groups, structure, options = {}) {
  const top = toGromacsStructure(structure);
  const n = top.atoms.length;
  const warnings = [];
  const list = Array.isArray(groups) ? groups : [];
  const seenNames = new Map();
  const described = list.map((g, index) => {
    const atoms = g.atoms || [];
    const residues = new Set();
    const byName = new Map();
    const chains = new Set();
    let outOfRange = 0;
    let repeated = 0;
    const seen = new Set();
    for (const a of atoms) {
      if (seen.has(a)) repeated++;
      seen.add(a);
      if (!(a >= 1 && a <= n)) { outOfRange++; continue; }
      const ri = top.atoms[a - 1].resIndex;
      const res = top.residues[ri];
      let e = byName.get(res.name);
      if (!e) { e = { name: res.name, residues: new Set(), atoms: 0 }; byName.set(res.name, e); }
      e.residues.add(ri);
      e.atoms++;
      residues.add(ri);
      if (res.chain.trim()) chains.add(res.chain);
    }
    if (!atoms.length) {
      warnings.push({ level: 'warning', group: g.name, message: `${g.name} is empty.` });
    }
    if (outOfRange) {
      warnings.push({ level: 'error', group: g.name,
        message: `${g.name} has ${outOfRange} atom numbers outside 1-${n}; grompp stops on ` +
          'these.' });
    }
    if (repeated) {
      warnings.push({ level: 'warning', group: g.name,
        message: `${g.name} lists ${repeated} atoms more than once.` });
    }
    if (!isValidGroupName(g.name)) {
      warnings.push({ level: 'warning', group: g.name,
        message: `"${g.name}" is not a usable group name; it will be written as ` +
          `${sanitiseGroupName(g.name)}.` });
    }
    const key = up(String(g.name));
    if (seenNames.has(key)) {
      warnings.push({ level: 'warning', group: g.name,
        message: `${g.name} repeats the name of group ${seenNames.get(key)} (ignoring case); ` +
          'grompp uses the first.' });
    } else seenNames.set(key, index);
    return {
      index,
      name: g.name,
      atoms: atoms.length,
      residues: residues.size,
      residueNames: [...byName.values()]
        .map(e => ({ name: e.name, residues: e.residues.size, atoms: e.atoms })),
      chains: [...chains],
      first: atoms.length ? atoms.reduce((m, a) => (a < m ? a : m), Infinity) : null,
      last: atoms.length ? atoms.reduce((m, a) => (a > m ? a : m), -Infinity) : null
    };
  });
  let tc = null;
  if (options.tcGrps !== undefined) {
    tc = checkGroupCoverage(list, options.tcGrps, n, { coverage: 'all', option: 'tc-grps' });
    for (const e of tc.errors) warnings.push({ level: 'error', group: null, message: e });
  }
  return { natoms: n, groups: described, warnings, tcGrps: tc };
}
