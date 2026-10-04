/**
 * @module core/structure
 *
 * Molecular structure parsing, geometry, and format conversion, extracted from
 * STEMKit's Coordinate Manipulator.
 *
 * Supports the three coordinate formats in routine use for classical MD:
 *
 *   - **PDB**, fixed-column ASCII, coordinates in ångström. Columns are
 *     positional, not whitespace-delimited: a residue name may legitimately be
 *     blank and a splitting parser would silently shift every subsequent field.
 *     Only the first model of a multi-model file is read, as GROMACS reads it.
 *   - **GRO**, GROMACS native, coordinates in nanometre, also fixed-column,
 *     with optional velocities after the coordinates and box vectors on the
 *     final line. The width of the coordinate fields is read from the file,
 *     as GROMACS does, so a file written at higher precision is read whole.
 *   - **XYZ**, whitespace-delimited, coordinates in ångström, no box.
 *
 * Where the formats leave room for interpretation, residue names of four
 * characters, residue number 0, several models in one PDB, the fields are
 * read the way GROMACS 2025 reads them (`src/gromacs/fileio/pdbio.cpp` and
 * `groio.cpp`), so that atoms are numbered and grouped as the simulation
 * numbers and groups them.
 *
 * Unit handling is explicit throughout. PDB and XYZ are ångström; GRO is
 * nanometre. Mixing them silently is the single easiest way to produce a
 * structure that is wrong by a factor of ten, so every parse result carries its
 * `unit` and conversion is always deliberate.
 *
 * All functions are pure: parsing returns new objects and transforms return new
 * atom arrays rather than mutating their input.
 */

/**
 * Standard atomic weights, in unified atomic mass units.
 *
 * CIAAW Standard Atomic Weights 2024, which incorporates the 2024 revisions to
 * gadolinium, lutetium and zirconium on top of the Atomic Weights 2021 report.
 *
 * Fourteen elements have no single recommended value because their isotopic
 * composition varies measurably in natural materials; CIAAW publishes an
 * interval for those, and the conventional abridged value is used here.
 * Hydrogen, for instance, is [1.00784, 1.00811] and appears as 1.008. Argon is
 * one of them, and its abridged value of 39.95 differs from the 39.948 that
 * older tables carry.
 *
 * Technetium has no stable isotope and so no standard atomic weight; the mass
 * number of its longest-lived isotope is used, which is the usual convention
 * for a structure file that happens to contain one. The other elements with no
 * standard weight are omitted rather than guessed at, so an atom of one is
 * reported as unidentified instead of being given a fabricated mass.
 *
 * @see https://ciaaw.org/atomic-weights.htm
 */
export const ATOMIC_WEIGHTS = Object.freeze({
  H: 1.008, He: 4.002602, Li: 6.94, Be: 9.0121831, B: 10.81, C: 12.011,
  N: 14.007, O: 15.999, F: 18.998403162, Ne: 20.1797, Na: 22.98976928,
  Mg: 24.305, Al: 26.9815384, Si: 28.085, P: 30.973761998, S: 32.06,
  Cl: 35.45, Ar: 39.95, K: 39.0983, Ca: 40.078, Sc: 44.955907, Ti: 47.867,
  V: 50.9415, Cr: 51.9961, Mn: 54.938043, Fe: 55.845, Co: 58.933194,
  Ni: 58.6934, Cu: 63.546, Zn: 65.38, Ga: 69.723, Ge: 72.63, As: 74.921595,
  Se: 78.971, Br: 79.904, Kr: 83.798, Rb: 85.4678, Sr: 87.62, Y: 88.905838,
  Zr: 91.222, Nb: 92.90637, Mo: 95.95, Tc: 98, Ru: 101.07, Rh: 102.90549,
  Pd: 106.42, Ag: 107.8682, Cd: 112.414, In: 114.818, Sn: 118.71,
  Sb: 121.76, Te: 127.6, I: 126.90447, Xe: 131.293, Cs: 132.90545196,
  Ba: 137.327, La: 138.90547, Ce: 140.116, Pr: 140.90766, Nd: 144.242,
  Sm: 150.36, Eu: 151.964, Gd: 157.249, Tb: 158.925354, Dy: 162.5,
  Ho: 164.930329, Er: 167.259, Tm: 168.934219, Yb: 173.045, Lu: 174.96669,
  Hf: 178.486, Ta: 180.94788, W: 183.84, Re: 186.207, Os: 190.23,
  Ir: 192.217, Pt: 195.084, Au: 196.96657, Hg: 200.592, Tl: 204.38,
  Pb: 207.2, Bi: 208.9804, Th: 232.0377, Pa: 231.03588, U: 238.02891
});

/** Mass assumed for an unrecognised element (carbon). */
export const DEFAULT_MASS = 12.011;

/**
 * Element symbols that are genuinely two letters.
 */
export const TWO_LETTER_ELEMENTS = Object.freeze(
  new Set(Object.keys(ATOMIC_WEIGHTS).filter(s => s.length === 2))
);

/**
 * Two-letter symbols that never occur as a PDB atom-name prefix for an atom of
 * a *different* element.
 *
 * The ambiguity being resolved: in a protein, "CA" means C-alpha and "CB"
 * means C-beta, so a leading C followed by an uppercase remoteness letter is
 * carbon. But "FE", "ZN", and "MG" are not carbon-like patterns, there is no
 * element "F" with a remoteness indicator "E" in standard PDB nomenclature.
 * Symbols listed here are therefore read as elements wherever they appear,
 * including inside a residue of a different name such as heme (FE in HEM) or
 * selenomethionine (SE in MSE).
 *
 * Deliberately excluded: every symbol whose two letters also form a common
 * protein atom name. The PDB remoteness indicators are A, B, G, D, E, Z, H
 * (alpha, beta, gamma, delta, epsilon, zeta, eta), so any symbol matching
 * C/N/O/S/P followed by one of those must be treated as ambiguous, hence the
 * omission of Ca, Cd, Ce, Cs, Cb, Cg, Na, Nd, Ne, Nz, Nh, Od, Oe, Og, Oh, Os,
 * Sb, Sc, Sd, Se(*), Sg, Pa, Pb, Pd. Symbols starting with a letter that is
 * not a common backbone element (F, Z, M, K, ...) carry no such risk.
 *
 * (*) Se is retained despite the Ser/S-epsilon pattern because selenium in
 * selenomethionine is written SE in residue MSE, and no standard amino-acid
 * atom is named "SE", the sulfur positions are SD and SG.
 *
 * Hg is also excluded: after the leading-digit strip, the common hydrogen name
 * "2HG1" (H-gamma-1) reduces to "HG", which would otherwise read as mercury.
 * Mercury in a real structure is almost always accompanied by an explicit
 * element column, which takes priority anyway.
 */
const UNAMBIGUOUS_TWO_LETTER = Object.freeze(new Set([
  'Fe', 'Zn', 'Mg', 'Mn', 'Cu', 'Se', 'Br', 'Li', 'Be', 'Al', 'Si',
  'Ar', 'Ti', 'Cr', 'Co', 'Ni', 'Ga', 'Ge', 'As', 'Kr', 'Rb',
  'Sr', 'Zr', 'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Ag', 'In',
  'Sn', 'Te', 'Xe', 'Ba', 'La', 'Pr', 'Sm',
  'Eu', 'Gd', 'Tb', 'Dy', 'Er', 'Tm', 'Yb', 'Lu', 'Hf', 'Ta',
  'Re', 'Ir', 'Pt', 'Au', 'Tl', 'Bi', 'Th'
]));

const DEG2RAD = Math.PI / 180;

/** Minimum box edge in nm; a planar system would otherwise give a zero cell. */
export const MIN_BOX_NM = 0.1;

/**
 * Parse a fixed-width field as a float.
 *
 * @param {string} v
 * @returns {number} The value, or NaN when the field is blank or malformed.
 */
export function safeFloat(v) {
  if (typeof v !== 'string') return NaN;
  const t = v.trim();
  if (t === '') return NaN;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Infer an element symbol from an atom record.
 *
 * PDB atom names are ambiguous by construction and several distinct cases have
 * to be separated:
 *
 *   1. An explicit element column (PDB columns 77-78) always wins.
 *   2. A leading digit is a hydrogen-count prefix ("1HB", "2HG1") so it is
 *      stripped before reading the symbol. Without this, roughly a third of the
 *      hydrogens in a typical structure fall through as unknown.
 *   3. An unambiguous two-letter metal ("FE", "ZN", "SE") is read as that
 *      element wherever it occurs, so heme iron and selenomethionine selenium
 *      are identified correctly.
 *   4. Otherwise a two-letter prefix whose second character is uppercase is a
 *      PDB remoteness indicator, and only the first letter is the element:
 *      "CA" in a protein residue is C-alpha, not calcium.
 *   5. As a final fallback, a two-letter symbol is trusted when the residue
 *      shares its name, which is the convention for monatomic ions.
 *
 * @param {{element?:string, atomName?:string, resName?:string}} atom
 * @returns {string} Element symbol, or 'X' when nothing can be inferred.
 */
export function elementSymbol(atom) {
  if (!atom) return 'X';

  if (atom.element) {
    const e = String(atom.element).trim();
    if (e) return e[0].toUpperCase() + (e[1] ? e[1].toLowerCase() : '');
  }

  // Strip a leading hydrogen-count digit: "1HB" -> "HB".
  const raw = String(atom.atomName || '').trim().replace(/^\d+/, '');
  const m = raw.match(/^([A-Za-z]{1,2})/);
  if (!m) return 'X';
  const s = m[1];

  if (s.length === 2) {
    const twoLetter = s[0].toUpperCase() + s[1].toLowerCase();
    const resn = String(atom.resName || '').trim().toUpperCase();

    // Metals and other symbols with no protein-name collision.
    if (UNAMBIGUOUS_TWO_LETTER.has(twoLetter)) return twoLetter;

    // A monatomic ion sits in a residue of its own name.
    if (TWO_LETTER_ELEMENTS.has(twoLetter) && resn === s.toUpperCase()) {
      return twoLetter;
    }

    // A second uppercase letter marks a PDB remoteness suffix (CA = C alpha).
    if (s[1] === s[1].toUpperCase()) return s[0].toUpperCase();
    return twoLetter;
  }
  return s[0].toUpperCase();
}

/**
 * Atomic mass for an atom record.
 *
 * @param {object} atom
 * @param {Set<string>} [unknown] - Optional sink recording unrecognised symbols
 *        so a caller can warn rather than silently substituting carbon.
 * @returns {number} Mass in u.
 */
/**
 * Atom names used for massless interaction sites.
 *
 * TIP4P and TIP5P water carry a charge site (`MW`, `LP`) that has no mass, and
 * dummy-mass constructions add `MCH3`/`MNH3`. They are real entries in a
 * coordinate file but contribute nothing to the mass of the system, so they
 * are recognised rather than being reported as unidentifiable atoms.
 */
export const VIRTUAL_SITE_NAMES = Object.freeze(new Set([
  'MW', 'MW1', 'MW2', 'LP', 'LP1', 'LP2', 'DUM', 'DUMMY', 'MCH3', 'MNH3', 'MN'
]));

/**
 * Whether an atom is a massless interaction site rather than a nucleus.
 *
 * @param {object} atom
 * @returns {boolean}
 */
export function isVirtualSite(atom) {
  if (!atom) return false;
  const name = String(atom.atomName || '').trim().toUpperCase();
  return VIRTUAL_SITE_NAMES.has(name);
}

/**
 * Mass of one atom, in unified atomic mass units.
 *
 * Three outcomes, deliberately distinct:
 *
 *  - a recognised element returns its standard atomic weight;
 *  - a recognised virtual site returns zero, because that is its mass;
 *  - anything else returns zero and is recorded in `unknown`.
 *
 * The last case used to return carbon's mass. That was a poor default: it is
 * silent in the total and wrong in both directions, and for a TIP4P system , 
 * where every water carries an `MW` site, it inflated the mass of the water
 * by 67%. Contributing zero and naming what was skipped cannot quietly
 * overstate a result.
 *
 * @param {object} atom
 * @param {Set<string>} [unknown] - Collects symbols that could not be identified.
 * @returns {number}
 */
export function atomicMass(atom, unknown) {
  if (isVirtualSite(atom)) return 0;
  const sym = elementSymbol(atom);
  const m = ATOMIC_WEIGHTS[sym];
  if (m === undefined) {
    if (unknown && typeof unknown.add === 'function') unknown.add(sym);
    return 0;
  }
  return m;
}

/**
 * Per-element tally behind the total mass.
 *
 * Returned so the figure can be shown as a working rather than asserted: the
 * count of each element, the weight used, and what each contributes, plus the
 * atoms that were skipped and why.
 *
 * @param {object[]} atoms
 * @returns {{
 *   rows: Array<{symbol:string, count:number, weight:number, subtotal:number}>,
 *   total: number,
 *   virtualSites: number,
 *   unidentified: Array<{symbol:string, count:number}>,
 *   atoms: number
 * }}
 */
export function massBreakdown(atoms) {
  const counts = new Map();
  const missing = new Map();
  let virtual = 0;

  for (const a of Array.isArray(atoms) ? atoms : []) {
    if (isVirtualSite(a)) { virtual++; continue; }
    const sym = elementSymbol(a);
    if (ATOMIC_WEIGHTS[sym] === undefined) {
      missing.set(sym, (missing.get(sym) || 0) + 1);
      continue;
    }
    counts.set(sym, (counts.get(sym) || 0) + 1);
  }

  const rows = [...counts.entries()]
    .map(([symbol, count]) => ({
      symbol,
      count,
      weight: ATOMIC_WEIGHTS[symbol],
      subtotal: count * ATOMIC_WEIGHTS[symbol]
    }))
    .sort((a, b) => b.subtotal - a.subtotal);

  return {
    rows,
    total: rows.reduce((s, r) => s + r.subtotal, 0),
    virtualSites: virtual,
    unidentified: [...missing.entries()]
      .map(([symbol, count]) => ({ symbol, count }))
      .sort((a, b) => b.count - a.count),
    atoms: Array.isArray(atoms) ? atoms.length : 0
  };
}

/**
 * Residue number from a fixed-width field.
 *
 * Zero is a residue number like any other. GROMACS keeps four digits of it in
 * a PDB and five in a .gro file, so residue 10000 of a large system is written
 * as 0; reading 0 as "missing" folded it into residue 1, and two neighbouring
 * waters became one molecule. Only a field with no number in it falls back
 * to 1.
 *
 * @param {string} field
 * @returns {number}
 */
function readResidueNumber(field) {
  const n = parseInt(field, 10);
  return Number.isFinite(n) ? n : 1;
}

/**
 * Residue number of an atom record for writing, 1 when it has none.
 *
 * @param {object} atom
 * @returns {number}
 */
function residueNumberOf(atom) {
  const n = typeof atom.resSeq === 'number' ? atom.resSeq : parseInt(atom.resSeq, 10);
  return Number.isFinite(n) ? Math.trunc(n) : 1;
}

/**
 * Whether CRYST1 cell lengths (Å) are the PDB's placeholder for "no unit
 * cell": the wwPDB format gives a structure not determined by crystallography
 * a = b = c = 1 Å, and PyMOL, Open Babel and many modelling programs write
 * that line for any structure. Taken as a real cell it is 0.1 nm wide, so
 * measuring through it puts every atom within reach of every other.
 *
 * @param {number} a - Cell length a, Å.
 * @param {number} b
 * @param {number} c
 * @returns {boolean}
 */
export function isPlaceholderCell(a, b, c) {
  return [a, b, c].every(x => Math.abs(Number(x) - 1) < 5e-4);
}

/**
 * What a reader says when it drops a placeholder cell. GROMACS does not drop
 * it (read_cryst1 in pdbio.cpp takes the numbers as they stand): gmx editconf
 * writes the 0.1 nm box back out, gmx select measures through it, and grompp
 * stops because the cut-off is longer than half the box.
 */
export const PLACEHOLDER_CELL_WARNING = 'CRYST1 gives a cell of 1 Å (1.000 1.000 1.000), the PDB\'s way of saying ' +
  'there is no unit cell, as PyMOL and many other programs write it: it is read as no box. GROMACS takes it as a ' +
  'real box 0.1 nm wide, so gmx select finds every atom within reach of every other and grompp stops (the cut-off ' +
  'is longer than half the box): set the real box first, with gmx editconf -box or -d.';

/**
 * Parse a PDB file.
 *
 * Fields are read by column position per the PDB v3.3 specification, with two
 * readings taken from GROMACS (`pdbio.cpp`) rather than the letter of the
 * specification, because a structure for a simulation is written by and for
 * GROMACS:
 *
 *   - The residue name is columns 18-21, not 18-20. CHARMM and GROMACS write
 *     four-character names (POPC, TIP3) into column 21, and cutting them to
 *     three merges POPC with POPE and TIP3 with TIP4.
 *   - A multi-model file (an NMR ensemble, frames saved as PDB) is read up to
 *     the first ENDMDL, as GROMACS and PLUMED read it. Concatenating the
 *     models gives every atom several times over, so masses, atom numbers and
 *     anything written back out are wrong by that factor. `{ models: 'all' }`
 *     keeps every model for a caller that wants the ensemble.
 *
 * CRYST1 unit-cell lengths, when present, are converted from ångström to
 * nanometre so that box data is stored in a single consistent unit regardless
 * of source. A cell of 1 Å ({@link isPlaceholderCell}) is the format's
 * placeholder for none, and gives no box and a warning.
 *
 * @param {string} text
 * @param {{models?:'first'|'all'}} [options] - `models` chooses between the
 *        first model (the default, as GROMACS) and every model in turn.
 * @returns {{atoms:object[], box:number[]|null, boxVectors:number[]|null,
 *            unit:'A', format:'pdb', unknownElements:string[],
 *            modelCount:number, warnings:string[]}} `modelCount` is the number
 *            of models holding atoms in the file, whichever were read.
 */
export function parsePDB(text, options = {}) {
  const allModels = !!options && options.models === 'all';
  const atoms = [];
  const unknown = new Set();
  const warnings = [];
  let box = null;
  let boxVectors = null;

  if (typeof text !== 'string') {
    return {
      atoms, box, boxVectors, unit: 'A', format: 'pdb', unknownElements: [],
      modelCount: 0, warnings
    };
  }

  // Models are counted as blocks closed by ENDMDL that hold atoms, so a file
  // that writes ENDMDL without MODEL, or MODEL without ENDMDL, is counted as
  // GROMACS would split it.
  let modelCount = 0;
  let modelHasAtoms = false;
  let reading = true;

  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.startsWith('ENDMDL')) {
      if (modelHasAtoms) {
        modelCount++;
        // GROMACS stops at the first ENDMDL. One closing an empty model is
        // passed over, so a file GROMACS reads as no atoms at all still
        // gives its first structure here; every file GROMACS can read is
        // read the same.
        if (!allModels) reading = false;
      }
      modelHasAtoms = false;
      continue;
    }
    const isAtom = line.startsWith('ATOM') || line.startsWith('HETATM');
    if (isAtom) modelHasAtoms = true;
    // Past the first model only the model count is still wanted.
    if (!reading) continue;

    if (line.startsWith('CRYST1')) {
      const a = safeFloat(line.substring(6, 15));
      const b = safeFloat(line.substring(15, 24));
      const c = safeFloat(line.substring(24, 33));
      // Angles matter: a rhombic dodecahedron or truncated octahedron, the
      // usual choices for a solvated system, is triclinic, and reading only
      // the lengths silently squares the cell off.
      const alpha = safeFloat(line.substring(33, 40));
      const beta = safeFloat(line.substring(40, 47));
      const gamma = safeFloat(line.substring(47, 54));
      if (![a, b, c].some(Number.isNaN) && isPlaceholderCell(a, b, c)) {
        // The cell of a structure that has none: no box, rather than one
        // 1 Å wide that every periodic measure would wrap through.
        box = null;
        boxVectors = null;
        if (!warnings.includes(PLACEHOLDER_CELL_WARNING)) warnings.push(PLACEHOLDER_CELL_WARNING);
      } else if (![a, b, c].some(Number.isNaN)) {
        box = [a / 10, b / 10, c / 10];
        const ang = [alpha, beta, gamma].map(v => (Number.isNaN(v) ? 90 : v));
        if (ang.some(v => Math.abs(v - 90) > 1e-3)) {
          boxVectors = boxVectorsFromAngles(a / 10, b / 10, c / 10, ang[0], ang[1], ang[2]);
        }
      }
      continue;
    }
    if (!isAtom) continue;

    const x = safeFloat(line.substring(30, 38));
    const y = safeFloat(line.substring(38, 46));
    const z = safeFloat(line.substring(46, 54));
    if ([x, y, z].some(Number.isNaN)) continue;

    atoms.push({
      type: line.substring(0, 6).trim(),
      serial: parseInt(line.substring(6, 11), 10) || atoms.length + 1,
      atomName: line.substring(12, 16).trim(),
      altLoc: line.substring(16, 17).trim(),
      resName: line.substring(17, 21).trim(),
      chain: line.substring(21, 22).trim(),
      resSeq: readResidueNumber(line.substring(22, 26)),
      x, y, z,
      vx: null, vy: null, vz: null,
      occupancy: line.substring(54, 60).trim() || '1.00',
      tempFactor: line.substring(60, 66).trim() || '0.00',
      element: line.substring(76, 78).trim() || ''
    });
  }
  if (modelHasAtoms) modelCount++;

  if (!allModels && modelCount > 1) {
    warnings.push(`This PDB holds ${modelCount} models; only the first was read, ` +
      'as GROMACS and PLUMED read it.');
  }

  for (const a of atoms) atomicMass(a, unknown);
  return {
    atoms, box, boxVectors, unit: 'A', format: 'pdb', unknownElements: [...unknown],
    modelCount, warnings
  };
}

/** Width of a .gro coordinate field as GROMACS writes it (`%8.3f`). */
const GRO_FIELD_WIDTH = 8;

/**
 * Width of the coordinate fields of a .gro file, from its first atom line.
 *
 * GROMACS writes `%8.3f`, but its reader (`groio.cpp`) accepts any precision:
 * it takes the width from the distance between the first two decimal points
 * and reads every coordinate and velocity of the file at that width. A file
 * written at `%10.5f` for more precision, which older GROMACS versions and
 * other programs produce, would otherwise be sliced through the middle of
 * each number.
 *
 * GROMACS looks for the points from the start of the line; here the search
 * starts at column 21, past the residue and atom names, so that a name with a
 * point in it cannot throw the width off. Every file GROMACS accepts has its
 * first point after column 20, so the two agree on each of them.
 *
 * @param {string} line - The first atom line.
 * @returns {{width:number, consistent:boolean}} `consistent` is false when x,
 *          y and z are not evenly spaced, which GROMACS refuses; the standard
 *          width is used then.
 */
function groFieldWidth(line) {
  const s = String(line || '');
  const p1 = s.indexOf('.', 20);
  const p2 = p1 < 0 ? -1 : s.indexOf('.', p1 + 1);
  const p3 = p2 < 0 ? -1 : s.indexOf('.', p2 + 1);
  if (p3 < 0) return { width: GRO_FIELD_WIDTH, consistent: true };
  const width = p2 - p1;
  // GROMACS writes the width less five decimals, so a field narrower than six
  // has no point in it and spacing that close is not a field width.
  if (width !== p3 - p2 || width < 6) return { width: GRO_FIELD_WIDTH, consistent: false };
  return { width, consistent: true };
}

/**
 * Parse a GROMACS .gro file.
 *
 * The format is strictly positional, title, atom count, N atom records, box
 * vectors, so blank lines cannot be filtered before indexing without risking
 * a one-line shift when the title is empty. Only trailing blanks are dropped.
 * Velocities are preserved when present so that a round-trip does not silently
 * discard them.
 *
 * Coordinates and velocities are read at the field width of the first atom
 * line, as GROMACS reads them (see `groFieldWidth`), rather than at the fixed
 * columns 21-44 of the usual `%8.3f`.
 *
 * @param {string} text
 * @returns {{atoms:object[], box:number[]|null, boxVectors:number[]|null,
 *            unit:'nm', format:'gro', title:string, unknownElements:string[],
 *            warnings:string[]}}
 */
export function parseGRO(text) {
  const atoms = [];
  const unknown = new Set();
  const warnings = [];
  let box = null;
  let boxVectors = null;
  let title = '';

  if (typeof text !== 'string') {
    return { atoms, box, boxVectors, unit: 'nm', format: 'gro', title, unknownElements: [], warnings };
  }

  const lines = text.split(/\r\n|\r|\n/);
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  const src = lines.slice(0, end);
  if (src.length < 3) {
    return { atoms, box, boxVectors, unit: 'nm', format: 'gro', title, unknownElements: [], warnings };
  }

  title = src[0].trim();
  const declared = parseInt(src[1].trim(), 10);
  const atomCount = Number.isFinite(declared) ? declared : src.length - 3;

  // One width for the whole file, taken from its first atom, as GROMACS does.
  const { width: w, consistent } = groFieldWidth(src[2]);
  if (!consistent) {
    warnings.push('The decimal points of the first atom line are not evenly spaced, which ' +
      'GROMACS refuses; the standard .gro columns were used.');
  }
  const field = (line, k) => safeFloat(line.substring(20 + k * w, 20 + (k + 1) * w));

  for (let i = 2; i < 2 + atomCount && i < src.length; i++) {
    const line = src[i];
    if (!line || line.length < 20 + 3 * w) continue;

    const x = field(line, 0);
    const y = field(line, 1);
    const z = field(line, 2);
    if ([x, y, z].some(Number.isNaN)) continue;

    let vx = null;
    let vy = null;
    let vz = null;
    if (line.length >= 20 + 6 * w) {
      vx = field(line, 3);
      vy = field(line, 4);
      vz = field(line, 5);
      if ([vx, vy, vz].some(Number.isNaN)) { vx = null; vy = null; vz = null; }
    }

    atoms.push({
      resSeq: readResidueNumber(line.substring(0, 5)),
      resName: line.substring(5, 10).trim(),
      atomName: line.substring(10, 15).trim(),
      serial: parseInt(line.substring(15, 20), 10) || (i - 1),
      x, y, z, vx, vy, vz,
      occupancy: '1.00',
      tempFactor: '0.00',
      element: ''
    });
  }

  const lastIdx = Math.min(2 + atomCount, src.length - 1);
  const boxTokens = (src[lastIdx] || '').trim().split(/\s+/).filter(Boolean);
  if (boxTokens.length >= 3 && boxTokens.every(v => Number.isFinite(Number(v)))) {
    box = boxTokens.slice(0, 3).map(Number);
    // A triclinic cell carries six further components. Keeping only the
    // diagonal turns a dodecahedral or octahedral box into a rectangular one,
    // which changes the system rather than just its description.
    if (boxTokens.length >= 9) {
      const full = boxTokens.slice(0, 9).map(Number);
      if (isTriclinic(full)) boxVectors = full;
    }
  }

  for (const a of atoms) atomicMass(a, unknown);
  return {
    atoms, box, boxVectors, unit: 'nm', format: 'gro', title, unknownElements: [...unknown],
    warnings
  };
}

/**
 * Parse an XYZ file.
 *
 * @param {string} text
 * @returns {{atoms:object[], box:null, unit:'A', format:'xyz',
 *            comment:string, unknownElements:string[], warnings:string[]}}
 */
export function parseXYZ(text) {
  const atoms = [];
  const unknown = new Set();
  let comment = '';

  if (typeof text !== 'string') {
    return { atoms, box: null, unit: 'A', format: 'xyz', comment, unknownElements: [], warnings: [] };
  }

  const clean = text.split(/\r\n|\r|\n/).filter(l => l.trim().length > 0);
  if (clean.length < 2) {
    return { atoms, box: null, unit: 'A', format: 'xyz', comment, unknownElements: [], warnings: [] };
  }

  const declared = parseInt(clean[0].trim(), 10);
  const atomCount = Number.isFinite(declared) ? declared : clean.length - 2;
  comment = (clean[1] || '').trim();

  for (let i = 2; i < 2 + atomCount && i < clean.length; i++) {
    const tokens = clean[i].trim().split(/\s+/);
    if (tokens.length < 4) continue;
    const x = safeFloat(tokens[1]);
    const y = safeFloat(tokens[2]);
    const z = safeFloat(tokens[3]);
    if ([x, y, z].some(Number.isNaN)) continue;

    atoms.push({
      atomName: tokens[0],
      resName: 'UNK',
      resSeq: 1,
      serial: i - 1,
      x, y, z,
      vx: null, vy: null, vz: null,
      occupancy: '1.00',
      tempFactor: '0.00',
      element: /^[A-Za-z]{1,2}$/.test(tokens[0]) ? tokens[0] : ''
    });
  }

  for (const a of atoms) atomicMass(a, unknown);
  return {
    atoms, box: null, unit: 'A', format: 'xyz', comment, unknownElements: [...unknown],
    warnings: []
  };
}

/**
 * Parse a structure, dispatching on an explicit format or a filename.
 *
 * @param {string} text
 * @param {string} formatOrFilename - 'pdb' | 'gro' | 'xyz', or a filename whose
 *        extension selects the parser.
 * @param {{models?:'first'|'all'}} [options] - Passed to the PDB parser.
 * @returns {object|null} Parse result, or null for an unsupported format.
 */
export function parseStructure(text, formatOrFilename = '', options = {}) {
  const token = String(formatOrFilename).toLowerCase();
  const ext = token.includes('.') ? token.split('.').pop() : token;

  switch (ext) {
    case 'pdb':
    case 'ent':
      return parsePDB(text, options);
    case 'gro':
      return parseGRO(text);
    case 'xyz':
      return parseXYZ(text);
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/**
 * Unweighted centroid of the coordinates.
 *
 * @param {object[]} atoms
 * @returns {{x:number, y:number, z:number}}
 */
export function geometricCentre(atoms) {
  if (!Array.isArray(atoms) || atoms.length === 0) return { x: 0, y: 0, z: 0 };
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const a of atoms) {
    sx += a.x;
    sy += a.y;
    sz += a.z;
  }
  const n = atoms.length;
  return { x: sx / n, y: sy / n, z: sz / n };
}

/**
 * Mass-weighted centre, R = sum(m_i r_i) / sum(m_i).
 *
 * @param {object[]} atoms
 * @param {Set<string>} [unknown]
 * @returns {{x:number, y:number, z:number, mass:number}} `mass` is the total
 *          molecular weight in u.
 */
export function centreOfMass(atoms, unknown) {
  if (!Array.isArray(atoms) || atoms.length === 0) {
    return { x: 0, y: 0, z: 0, mass: 0 };
  }
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let total = 0;
  for (const a of atoms) {
    const m = atomicMass(a, unknown);
    sx += a.x * m;
    sy += a.y * m;
    sz += a.z * m;
    total += m;
  }
  if (total === 0) return { ...geometricCentre(atoms), mass: 0 };
  return { x: sx / total, y: sy / total, z: sz / total, mass: total };
}

/**
 * Axis-aligned bounding box.
 *
 * @param {object[]} atoms
 * @returns {{minX:number, maxX:number, minY:number, maxY:number,
 *            minZ:number, maxZ:number}}
 */
export function boundingBox(atoms) {
  if (!Array.isArray(atoms) || atoms.length === 0) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const a of atoms) {
    if (a.x < minX) minX = a.x;
    if (a.x > maxX) maxX = a.x;
    if (a.y < minY) minY = a.y;
    if (a.y > maxY) maxY = a.y;
    if (a.z < minZ) minZ = a.z;
    if (a.z > maxZ) maxZ = a.z;
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

/**
 * Radius of gyration about the centre of mass.
 *
 * Rg^2 = sum(m_i |r_i - R|^2) / sum(m_i)
 *
 * @param {object[]} atoms
 * @returns {number} Rg in the same length unit as the coordinates.
 */
export function radiusOfGyration(atoms) {
  if (!Array.isArray(atoms) || atoms.length === 0) return NaN;
  const com = centreOfMass(atoms);
  if (com.mass === 0) return NaN;

  let sum = 0;
  for (const a of atoms) {
    const m = atomicMass(a);
    const dx = a.x - com.x;
    const dy = a.y - com.y;
    const dz = a.z - com.z;
    sum += m * (dx * dx + dy * dy + dz * dz);
  }
  return Math.sqrt(sum / com.mass);
}

/**
 * Build the composed rotation matrix R = Rz(gamma) Ry(beta) Rx(alpha).
 *
 * Intrinsic Z-Y-X Euler convention, matching the original tool.
 *
 * @param {number} degX
 * @param {number} degY
 * @param {number} degZ
 * @returns {number[]} Row-major 3x3 matrix as a flat array of nine elements.
 */
export function rotationMatrix(degX, degY, degZ) {
  const ax = degX * DEG2RAD;
  const ay = degY * DEG2RAD;
  const az = degZ * DEG2RAD;
  const cx = Math.cos(ax);
  const sx = Math.sin(ax);
  const cy = Math.cos(ay);
  const sy = Math.sin(ay);
  const cz = Math.cos(az);
  const sz = Math.sin(az);

  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx
  ];
}

/**
 * Rotate atoms about a pivot by intrinsic Z-Y-X Euler angles.
 *
 * Velocities are vectors and rotate with the frame, but are never translated.
 * Returns new atom objects; the input array is not modified.
 *
 * @param {object[]} atoms
 * @param {number} degX
 * @param {number} degY
 * @param {number} degZ
 * @param {{x:number, y:number, z:number}} pivot
 * @returns {object[]} Rotated atoms.
 */
export function rotateAtoms(atoms, degX, degY, degZ, pivot) {
  return rotateAtomsByMatrix(atoms, rotationMatrix(degX, degY, degZ), pivot);
}

/**
 * Rotate atoms about a pivot by a rotation matrix.
 *
 * Velocities are vectors and rotate with the frame, but are never translated.
 * Returns new atom objects; the input array is not modified.
 *
 * @param {object[]} atoms
 * @param {number[]} r - Row-major 3x3 rotation, as rotationMatrix returns it.
 * @param {{x:number, y:number, z:number}} [pivot] - The origin when omitted.
 * @returns {object[]} Rotated atoms.
 */
export function rotateAtomsByMatrix(atoms, r, pivot) {
  if (!Array.isArray(atoms)) return [];
  const p = pivot || { x: 0, y: 0, z: 0 };
  const [r00, r01, r02, r10, r11, r12, r20, r21, r22] = r;

  return atoms.map(a => {
    const dx = a.x - p.x;
    const dy = a.y - p.y;
    const dz = a.z - p.z;
    const out = {
      ...a,
      x: r00 * dx + r01 * dy + r02 * dz + p.x,
      y: r10 * dx + r11 * dy + r12 * dz + p.y,
      z: r20 * dx + r21 * dy + r22 * dz + p.z
    };
    if (a.vx !== null && a.vx !== undefined) {
      out.vx = r00 * a.vx + r01 * a.vy + r02 * a.vz;
      out.vy = r10 * a.vx + r11 * a.vy + r12 * a.vz;
      out.vz = r20 * a.vx + r21 * a.vy + r22 * a.vz;
    }
    return out;
  });
}

/* ------------------------------------------------------------------ *
 * Rotations as matrices
 *
 * A rotation is a flat, row-major array of nine numbers, as rotationMatrix
 * returns it. These turn one into the three angles of the same convention,
 * into the single turn about one axis that it amounts to, and into the
 * quaternion a 3D view takes, and back.
 * ------------------------------------------------------------------ */

const RAD2DEG = 180 / Math.PI;
const clampUnit = v => Math.max(-1, Math.min(1, v));
const tidy = v => (Math.abs(v) < 1e-12 ? 0 : v);

/** The rotation that changes nothing. */
export const IDENTITY_ROTATION = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/**
 * The product a·b: the rotation b followed by the rotation a.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number[]}
 */
export function multiplyRotations(a, b) {
  const out = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return out;
}

/**
 * The transpose of a rotation, which is its inverse.
 *
 * @param {number[]} r
 * @returns {number[]}
 */
export function transposeRotation(r) {
  return [r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]];
}

/**
 * Apply a rotation to one vector.
 *
 * @param {number[]} r
 * @param {number[]} v - [x, y, z]
 * @returns {number[]}
 */
export function rotateVector(r, v) {
  return [
    r[0] * v[0] + r[1] * v[1] + r[2] * v[2],
    r[3] * v[0] + r[4] * v[1] + r[5] * v[2],
    r[6] * v[0] + r[7] * v[1] + r[8] * v[2]
  ];
}

/**
 * The angles (x, y, z) for which rotationMatrix gives this rotation,
 * R = Rz(z) Ry(y) Rx(x).
 *
 * y comes out between -90 and 90 degrees. At y = ±90 the first and last turns
 * are about the same line and only their sum (or difference) is fixed; the
 * whole of it is then given to z, and x is zero.
 *
 * @param {number[]} r
 * @returns {{x:number, y:number, z:number}} Degrees.
 */
export function eulerFromMatrix(r) {
  // r[7] and r[8] are cos(y) sin(x) and cos(y) cos(x), so their length is
  // cos(y): with -sin(y) in r[6] that gives y without the loss of asin near
  // ±90, and while cos(y) is not lost to rounding they still give x.
  const cy = Math.hypot(r[7], r[8]);
  const y = Math.atan2(-r[6], cy);
  let x;
  let z;
  if (cy > 1e-9) {
    x = Math.atan2(r[7], r[8]);
    z = Math.atan2(r[3], r[0]);
  } else {
    x = 0;
    z = Math.atan2(-r[1], r[4]);
  }
  return { x: tidy(x * RAD2DEG), y: tidy(y * RAD2DEG), z: tidy(z * RAD2DEG) };
}

/**
 * The unit quaternion [x, y, z, w] of a rotation.
 *
 * @param {number[]} r
 * @returns {number[]}
 */
export function quaternionFromMatrix(r) {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = r;
  const trace = m00 + m11 + m22;
  let x;
  let y;
  let z;
  let w;
  // The branch with the largest divisor, so none is taken near zero.
  if (trace > 0) {
    const s = 2 * Math.sqrt(trace + 1);
    w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4;
  }
  const n = Math.hypot(x, y, z, w) || 1;
  return [x / n, y / n, z / n, w / n];
}

/**
 * The rotation of a quaternion [x, y, z, w]; it need not be normalised.
 *
 * @param {number[]} q
 * @returns {number[]}
 */
export function matrixFromQuaternion(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  const x = q[0] / n;
  const y = q[1] / n;
  const z = q[2] / n;
  const w = q[3] / n;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)
  ];
}

/**
 * A rotation as one turn about one axis (Euler's rotation theorem).
 *
 * @param {number[]} r
 * @returns {{angle:number, axis:number[]}} The angle in degrees, 0 to 180,
 *          and the unit axis; (0, 0, 1) for the identity.
 */
export function axisAngleFromMatrix(r) {
  let [x, y, z, w] = quaternionFromMatrix(r);
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const n = Math.hypot(x, y, z);
  if (n < 1e-12) return { angle: 0, axis: [0, 0, 1] };
  return { angle: 2 * Math.atan2(n, w) * RAD2DEG, axis: [tidy(x / n), tidy(y / n), tidy(z / n)] };
}

/**
 * The smallest rotation that turns the direction u onto the direction v.
 *
 * Opposite directions are half a turn apart about any line across them; the
 * one across the lab axis least aligned with u is taken, so the answer is
 * always the same.
 *
 * @param {number[]} u
 * @param {number[]} v
 * @returns {number[]}
 */
export function rotationBetween(u, v) {
  const nu = Math.hypot(u[0], u[1], u[2]);
  const nv = Math.hypot(v[0], v[1], v[2]);
  if (!(nu > 0) || !(nv > 0)) return IDENTITY_ROTATION.slice();
  const a = [u[0] / nu, u[1] / nu, u[2] / nu];
  const b = [v[0] / nv, v[1] / nv, v[2] / nv];
  const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (c > 1 - 1e-12) return IDENTITY_ROTATION.slice();
  if (c < -1 + 1e-12) {
    const k = Math.abs(a[0]) <= Math.abs(a[1]) && Math.abs(a[0]) <= Math.abs(a[2]) ? 0
      : Math.abs(a[1]) <= Math.abs(a[2]) ? 1 : 2;
    const e = [0, 0, 0];
    e[k] = 1;
    const p = [a[1] * e[2] - a[2] * e[1], a[2] * e[0] - a[0] * e[2], a[0] * e[1] - a[1] * e[0]];
    const np = Math.hypot(p[0], p[1], p[2]);
    const [px, py, pz] = [p[0] / np, p[1] / np, p[2] / np];
    return [
      2 * px * px - 1, 2 * px * py, 2 * px * pz,
      2 * py * px, 2 * py * py - 1, 2 * py * pz,
      2 * pz * px, 2 * pz * py, 2 * pz * pz - 1
    ];
  }
  // Rodrigues: R = I + K + K^2 / (1 + c), K the cross-product matrix of a x b.
  const kx = a[1] * b[2] - a[2] * b[1];
  const ky = a[2] * b[0] - a[0] * b[2];
  const kz = a[0] * b[1] - a[1] * b[0];
  const f = 1 / (1 + c);
  return [
    1 - f * (ky * ky + kz * kz), -kz + f * kx * ky, ky + f * kx * kz,
    kz + f * kx * ky, 1 - f * (kx * kx + kz * kz), -kx + f * ky * kz,
    -ky + f * kx * kz, kx + f * ky * kz, 1 - f * (kx * kx + ky * ky)
  ];
}

/* Eigenvalues and eigenvectors of a symmetric 3x3 matrix, by Jacobi
 * rotations: largest eigenvalue first, each vector with its largest
 * component positive so the same shape always gives the same axes. */
function symmetricEigen3(m) {
  const a = [[m[0], m[1], m[2]], [m[3], m[4], m[5]], [m[6], m[7], m[8]]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 64; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    const diag = Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]);
    if (off <= 1e-15 * diag) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (a[p][q] === 0) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p];
        const akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k];
        const aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p];
        const vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const pairs = [0, 1, 2].map(i => {
    let vec = [v[0][i], v[1][i], v[2][i]];
    const n = Math.hypot(vec[0], vec[1], vec[2]) || 1;
    vec = vec.map(c => c / n);
    const big = vec.reduce((best, c, k) => (Math.abs(c) > Math.abs(vec[best]) ? k : best), 0);
    if (vec[big] < 0) vec = vec.map(c => -c);
    return { value: a[i][i], vector: vec.map(tidy) };
  }).sort((p, q) => q.value - p.value);
  return { values: pairs.map(p => Math.max(0, p.value)), vectors: pairs.map(p => p.vector) };
}

/**
 * The principal axes of a structure: the directions along which the atoms
 * spread most, next and least, from the covariance of the positions about
 * the geometric centre (every atom counts equally).
 *
 * @param {object[]} atoms
 * @returns {{centre:{x:number,y:number,z:number}, variances:number[], axes:number[][]}|null}
 *          Variances in the squared length unit of the coordinates, largest
 *          first, each with its unit axis; null for fewer than two atoms.
 */
export function principalAxes(atoms) {
  if (!Array.isArray(atoms) || atoms.length < 2) return null;
  const c = geometricCentre(atoms);
  let xx = 0;
  let xy = 0;
  let xz = 0;
  let yy = 0;
  let yz = 0;
  let zz = 0;
  for (const a of atoms) {
    const dx = a.x - c.x;
    const dy = a.y - c.y;
    const dz = a.z - c.z;
    xx += dx * dx; xy += dx * dy; xz += dx * dz;
    yy += dy * dy; yz += dy * dz; zz += dz * dz;
  }
  const n = atoms.length;
  const eig = symmetricEigen3([xx / n, xy / n, xz / n, xy / n, yy / n, yz / n, xz / n, yz / n, zz / n]);
  return { centre: c, variances: eig.values, axes: eig.vectors };
}

/**
 * The one axis a structure's shape singles out, if it has one: the long axis
 * of something rod-like (a helix, a chain), or the normal of something flat
 * (a ring, a sheet). A shape that is neither, or too even to say, has none.
 *
 * The test is on the variances along the principal axes, v1 >= v2 >= v3:
 * rod-like when v1 stands at least a tenth above v2, flat when v3 stands at
 * least a tenth of v1 below v2.
 *
 * @param {object[]} atoms
 * @returns {{kind:'long'|'normal', axis:number[], centre:object, halfLength:number}|null}
 *          halfLength is twice the standard deviation along the longest
 *          axis, a length to draw the axis at.
 */
export function shapeAxis(atoms) {
  const p = principalAxes(atoms);
  if (!p) return null;
  const [v1, v2, v3] = p.variances;
  if (!(v1 > 0)) return null;
  const halfLength = 2 * Math.sqrt(v1);
  if ((v1 - v2) / v1 >= 0.1) return { kind: 'long', axis: p.axes[0], centre: p.centre, halfLength };
  if ((v2 - v3) / v1 >= 0.1) return { kind: 'normal', axis: p.axes[2], centre: p.centre, halfLength };
  return null;
}

/**
 * The angles between a line and the three coordinate axes.
 *
 * A line has no direction, so each angle is between 0 and 90 degrees.
 *
 * @param {number[]} axis
 * @returns {{x:number, y:number, z:number}} Degrees.
 */
export function axisTilt(axis) {
  const n = Math.hypot(axis[0], axis[1], axis[2]);
  if (!(n > 0)) return { x: NaN, y: NaN, z: NaN };
  const tilt = c => Math.acos(clampUnit(Math.abs(c) / n)) * RAD2DEG;
  return { x: tilt(axis[0]), y: tilt(axis[1]), z: tilt(axis[2]) };
}

/* ------------------------------------------------------------------ *
 * A record of what was done, and the same steps as a script and as maths
 *
 * A step is one of
 *   { type: 'rotate', angles: {x, y, z}, pivot: 'geometric'|'mass'|'origin', centre: {x, y, z} }
 *   { type: 'translate', vector: {x, y, z} }
 *   { type: 'centre', mode: 'geometric'|'mass', centre: {x, y, z} }
 * with angles in degrees and lengths in the unit of the source file. `centre`
 * is the point the step turned about or moved to the origin, as it was when
 * the step was applied.
 * ------------------------------------------------------------------ */

const xyz = p => [p.x, p.y, p.z];

/**
 * The whole list of steps as one rigid transform, r' = M r + d.
 *
 * @param {object[]} steps
 * @returns {{matrix:number[], offset:number[]}}
 */
export function netTransform(steps) {
  let m = IDENTITY_ROTATION.slice();
  let d = [0, 0, 0];
  for (const step of Array.isArray(steps) ? steps : []) {
    if (step.type === 'rotate') {
      const r = rotationMatrix(step.angles.x, step.angles.y, step.angles.z);
      const c = xyz(step.centre);
      const rc = rotateVector(r, c);
      const rd = rotateVector(r, d);
      m = multiplyRotations(r, m);
      d = [rd[0] + c[0] - rc[0], rd[1] + c[1] - rc[1], rd[2] + c[2] - rc[2]];
    } else if (step.type === 'translate') {
      const t = xyz(step.vector);
      d = [d[0] + t[0], d[1] + t[1], d[2] + t[2]];
    } else if (step.type === 'centre') {
      const c = xyz(step.centre);
      d = [d[0] - c[0], d[1] - c[1], d[2] - c[2]];
    }
  }
  return { matrix: m, offset: d };
}

const PIVOT_NAME = { geometric: 'the geometric centre', mass: 'the centre of mass', origin: 'the origin' };
const UNIT_NAME = { A: 'Å', nm: 'nm' };

/* A number as Python reads it, without the noise of binary fractions. */
function pyNumber(v) {
  const n = Number(Number(v).toPrecision(12));
  if (!Number.isFinite(n)) return "float('nan')";
  const s = String(Object.is(n, -0) ? 0 : n);
  return /[.e]/.test(s) ? s : `${s}.0`;
}
const pyVector = p => `[${xyz(p).map(pyNumber).join(', ')}]`;
const pyString = s => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ')}'`;
const plain = v => String(Number(Number(v).toPrecision(10)));
const triple = p => `(${xyz(p).map(plain).join(', ')})`;

/** One line that says what a step did. */
export function describeStep(step, unit = 'A') {
  const u = UNIT_NAME[unit] || unit;
  if (step.type === 'rotate') {
    return `Rotate by ${triple(step.angles)} degrees about ${PIVOT_NAME[step.pivot] || PIVOT_NAME.geometric}`;
  }
  if (step.type === 'translate') return `Translate by ${triple(step.vector)} ${u}`;
  if (step.type === 'centre') return `Move ${PIVOT_NAME[step.mode] || PIVOT_NAME.geometric} to the origin`;
  return '';
}

const PY_ROTATION = [
  'def rotation(ax, ay, az):',
  '    """R = Rz(az) Ry(ay) Rx(ax), angles in degrees:',
  '    a turn about x, then y, then z, each about the fixed axis."""',
  '    ax, ay, az = np.radians([ax, ay, az])',
  '    cx, sx = np.cos(ax), np.sin(ax)',
  '    cy, sy = np.cos(ay), np.sin(ay)',
  '    cz, sz = np.cos(az), np.sin(az)',
  '    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])',
  '    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])',
  '    Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])',
  '    return Rz @ Ry @ Rx'
];

/**
 * The steps as a Python script.
 *
 * `variant: 'mdanalysis'` is a whole script: it reads the file with
 * MDAnalysis, applies the steps and writes the result. MDAnalysis works in
 * ångström whatever the file uses, so lengths from a nanometre source are
 * converted. `variant: 'numpy'` is a function of an (N, 3) array in the unit
 * of the source file, for use with any reader.
 *
 * @param {object[]} steps
 * @param {object} [options]
 * @param {'mdanalysis'|'numpy'} [options.variant='mdanalysis']
 * @param {'A'|'nm'} [options.unit='A'] - Unit of the source file.
 * @param {string} [options.input='input.pdb']
 * @param {string} [options.output='output.pdb']
 * @param {boolean} [options.velocities=false] - The source carries velocities.
 * @param {{lengths:number[], angles?:number[]}|null} [options.box] - The cell to
 *        write, lengths in nm, angles (alpha, beta, gamma) in degrees.
 * @returns {string}
 */
export function transformScript(steps, options = {}) {
  const list = Array.isArray(steps) ? steps : [];
  const numpy = options.variant === 'numpy';
  const unit = options.unit === 'nm' ? 'nm' : 'A';
  const input = options.input || 'input.pdb';
  const output = options.output || 'output.pdb';
  const vel = Boolean(options.velocities);
  const hasRotation = list.some(s => s.type === 'rotate');
  const needsMass = list.some(s => (s.type === 'rotate' && s.pivot === 'mass') || (s.type === 'centre' && s.mode === 'mass'));
  // In the whole script the coordinates are in ångström; in the function they
  // are in the unit of the source file.
  const toScript = (!numpy && unit === 'nm') ? 10 : 1;
  const lengthUnit = numpy ? UNIT_NAME[unit] : 'Å';
  const pad = numpy ? '    ' : '';
  const masses = numpy ? 'masses' : 'u.atoms.masses';

  const L = [];
  L.push('"""The steps applied in STEMKit\'s Coordinate Manipulator, in order.');
  L.push('https://stemkit.net/coordinate-manipulator.html');
  L.push('');
  if (numpy) {
    L.push(`transform(x) takes an (N, 3) array of coordinates in ${UNIT_NAME[unit]},`);
    L.push(`the unit of ${input}, and returns the new coordinates.`);
    L.push('Needs numpy.');
  } else {
    L.push(`Reads ${input} and writes ${output}.`);
    L.push('Needs numpy and MDAnalysis (pip install MDAnalysis).');
  }
  L.push('"""');
  L.push('import numpy as np');
  if (!numpy) L.push('import MDAnalysis as mda');
  if (hasRotation) L.push('', '', ...PY_ROTATION);
  L.push('', '');

  if (numpy) {
    L.push('def transform(x, masses=None):');
    L.push('    x = np.array(x, dtype=float)');
    if (needsMass) {
      L.push('    if masses is None:');
      L.push("        raise ValueError('a step uses the centre of mass: pass the atomic masses')");
    }
  } else {
    L.push(`u = mda.Universe(${pyString(input)})`);
    L.push('x = u.atoms.positions.astype(float)  # MDAnalysis works in ångström');
    if (vel) L.push('v = u.atoms.velocities.astype(float)');
  }

  if (!list.length) L.push('', `${pad}# No step has been applied yet.`);

  const short = p => `(${xyz(p).map(v => String(Number(Number(v).toFixed(4)))).join(', ')})`;
  const massNote = (centre) => (numpy ? [] : [
    `${pad}# MDAnalysis guesses the masses from the atom names. The page uses`,
    `${pad}# standard atomic weights by element, and found this centre at`,
    `${pad}# ${short(centre)} ${UNIT_NAME[unit]}.`
  ]);

  list.forEach((step, i) => {
    L.push('', `${pad}# ${i + 1}. ${describeStep(step, unit)}`);
    if (step.type === 'rotate') {
      L.push(`${pad}R = rotation(${xyz(step.angles).map(pyNumber).join(', ')})`);
      if (step.pivot === 'origin') {
        L.push(`${pad}x = x @ R.T`);
      } else {
        if (step.pivot === 'mass') {
          L.push(...massNote(step.centre));
          L.push(`${pad}c = np.average(x, axis=0, weights=${masses})`);
        } else {
          L.push(`${pad}c = x.mean(axis=0)`);
        }
        L.push(`${pad}x = (x - c) @ R.T + c`);
      }
      if (numpy) L.push(`${pad}# velocities, if you carry any, turn the same way: v @ R.T`);
      else if (vel) L.push('v = v @ R.T');
    } else if (step.type === 'translate') {
      if (toScript !== 1) {
        L.push(`${pad}# nm on the page, ångström here`);
        L.push(`${pad}x += ${toScript} * np.array(${pyVector(step.vector)})`);
      } else {
        L.push(`${pad}x += np.array(${pyVector(step.vector)})`);
      }
    } else if (step.type === 'centre') {
      if (step.mode === 'mass') {
        L.push(...massNote(step.centre));
        L.push(`${pad}x -= np.average(x, axis=0, weights=${masses})`);
      } else {
        L.push(`${pad}x -= x.mean(axis=0)`);
      }
    }
  });

  L.push('');
  if (numpy) {
    L.push('    return x');
  } else {
    L.push('u.atoms.positions = x');
    if (vel) L.push('u.atoms.velocities = v');
    const box = options.box;
    if (box && Array.isArray(box.lengths) && box.lengths.length >= 3 && box.lengths.every(v => Number.isFinite(v) && v > 0)) {
      const ang = Array.isArray(box.angles) && box.angles.length >= 3 ? box.angles : [90, 90, 90];
      const dims = [...box.lengths.slice(0, 3).map(v => v * 10), ...ang.slice(0, 3)].map(pyNumber).join(', ');
      L.push('# The cell: lengths in ångström, then the angles.');
      L.push(`u.dimensions = [${dims}]`);
    }
    L.push(`u.atoms.write(${pyString(output)})`);
  }
  return `${L.join('\n')}\n`;
}

/* TeX pieces. */
const texNumber = (v, digits) => {
  const s = Number(v).toFixed(digits);
  return /^-0\.?0*$/.test(s) ? s.slice(1) : s;
};
const texAngle = v => `${plain(v)}^\\circ`;
const texMatrix = (m, digits = 4) => `\\begin{pmatrix} ${[0, 1, 2].map(i => [0, 1, 2].map(j => texNumber(m[i * 3 + j], digits)).join(' & ')).join(' \\\\ ')} \\end{pmatrix}`;
const texVector = (v, digits) => `\\begin{pmatrix} ${v.map(c => texNumber(c, digits)).join(' \\\\ ')} \\end{pmatrix}`;
const TEX_UNIT = { A: '\\text{\\AA}', nm: '\\text{nm}' };
const TEX_CENTRE = {
  geometric: '\\frac{1}{N}\\sum_i \\mathbf{r}_i',
  mass: '\\frac{\\sum_i m_i\\,\\mathbf{r}_i}{\\sum_i m_i}'
};

/**
 * The steps as equations: each step with the matrix or vector it used, and
 * the one transform they add up to.
 *
 * @param {object[]} steps
 * @param {{unit?: 'A'|'nm'}} [options]
 * @returns {{blocks: {heading:string, tex:string, note?:string}[], latex:string}}
 *          `blocks` for typesetting one at a time; `latex` the same as a
 *          fragment for a document that loads amsmath.
 */
export function transformLatex(steps, options = {}) {
  const list = Array.isArray(steps) ? steps : [];
  const unit = options.unit === 'nm' ? 'nm' : 'A';
  const u = TEX_UNIT[unit];
  const digits = unit === 'nm' ? 4 : 3;
  const blocks = [];
  const aligned = rows => `\\begin{aligned} ${rows.join(' \\\\[4pt] ')} \\end{aligned}`;

  if (list.some(s => s.type === 'rotate')) {
    blocks.push({
      heading: 'How the three angles make one rotation',
      tex: aligned([
        'R(\\alpha, \\beta, \\gamma) &= R_z(\\gamma)\\,R_y(\\beta)\\,R_x(\\alpha)',
        'R_x(\\alpha) &= \\begin{pmatrix} 1 & 0 & 0 \\\\ 0 & \\cos\\alpha & -\\sin\\alpha \\\\ 0 & \\sin\\alpha & \\cos\\alpha \\end{pmatrix}',
        'R_y(\\beta) &= \\begin{pmatrix} \\cos\\beta & 0 & \\sin\\beta \\\\ 0 & 1 & 0 \\\\ -\\sin\\beta & 0 & \\cos\\beta \\end{pmatrix}',
        'R_z(\\gamma) &= \\begin{pmatrix} \\cos\\gamma & -\\sin\\gamma & 0 \\\\ \\sin\\gamma & \\cos\\gamma & 0 \\\\ 0 & 0 & 1 \\end{pmatrix}'
      ]),
      note: 'The rightmost matrix acts first: a turn of α about x, then β about y, then γ about z, each about the fixed axis.'
    });
  }

  list.forEach((step, i) => {
    const heading = `Step ${i + 1}. ${describeStep(step, unit)}`;
    if (step.type === 'rotate') {
      const r = rotationMatrix(step.angles.x, step.angles.y, step.angles.z);
      const rows = [
        step.pivot === 'origin' ? "\\mathbf{r}' &= R\\,\\mathbf{r}" : "\\mathbf{r}' &= \\mathbf{c} + R\\,(\\mathbf{r} - \\mathbf{c})",
        `R &= R_z(${texAngle(step.angles.z)})\\,R_y(${texAngle(step.angles.y)})\\,R_x(${texAngle(step.angles.x)}) = ${texMatrix(r)}`
      ];
      if (step.pivot !== 'origin') {
        rows.push(`\\mathbf{c} &= ${TEX_CENTRE[step.pivot] || TEX_CENTRE.geometric} = ${texVector(xyz(step.centre), digits)}\\,${u}`);
      }
      blocks.push({ heading, tex: aligned(rows) });
    } else if (step.type === 'translate') {
      blocks.push({ heading, tex: aligned(["\\mathbf{r}' &= \\mathbf{r} + \\mathbf{t}", `\\mathbf{t} &= ${texVector(xyz(step.vector), digits)}\\,${u}`]) });
    } else if (step.type === 'centre') {
      blocks.push({ heading, tex: aligned(["\\mathbf{r}' &= \\mathbf{r} - \\mathbf{c}", `\\mathbf{c} &= ${TEX_CENTRE[step.mode] || TEX_CENTRE.geometric} = ${texVector(xyz(step.centre), digits)}\\,${u}`]) });
    }
  });

  if (list.length) {
    const net = netTransform(list);
    const turn = axisAngleFromMatrix(net.matrix);
    const e = eulerFromMatrix(net.matrix);
    const one = v => plain(Number(v.toFixed(2)));
    blocks.push({
      heading: list.length > 1 ? `All ${list.length} steps as one` : 'The step as one transform',
      tex: aligned(["\\mathbf{r}' &= M\\,\\mathbf{r} + \\mathbf{d}", `M &= ${texMatrix(net.matrix)}`, `\\mathbf{d} &= ${texVector(net.offset, digits)}\\,${u}`]),
      note: turn.angle < 1e-9
        ? 'M is the identity: the structure was moved but not turned.'
        : `M is one turn of ${one(turn.angle)}° about the axis (${turn.axis.map(c => texNumber(c, 3)).join(', ')}), ` +
          `the same as the angles x ${one(e.x)}°, y ${one(e.y)}°, z ${one(e.z)}°.`
    });
  }

  const latex = blocks.map(b => `% ${b.heading}\n\\[\n${b.tex}\n\\]${b.note ? `\n% ${b.note}` : ''}`).join('\n\n');
  return { blocks, latex: latex ? `${latex}\n` : '' };
}

/**
 * Translate atoms by a fixed displacement.
 *
 * @param {object[]} atoms
 * @param {number} dx
 * @param {number} dy
 * @param {number} dz
 * @returns {object[]} Translated atoms.
 */
export function translateAtoms(atoms, dx, dy, dz) {
  if (!Array.isArray(atoms)) return [];
  return atoms.map(a => ({ ...a, x: a.x + dx, y: a.y + dy, z: a.z + dz }));
}

/**
 * Translate atoms so that a chosen centre lands at the origin.
 *
 * @param {object[]} atoms
 * @param {'geometric'|'mass'} [mode='geometric']
 * @returns {object[]}
 */
export function centreAtoms(atoms, mode = 'geometric') {
  if (!Array.isArray(atoms) || atoms.length === 0) return [];
  const c = mode === 'mass' ? centreOfMass(atoms) : geometricCentre(atoms);
  return translateAtoms(atoms, -c.x, -c.y, -c.z);
}

/**
 * Scale coordinates by a constant factor about the origin.
 *
 * Used for unit conversion, where velocities scale identically.
 *
 * @param {object[]} atoms
 * @param {number} factor
 * @returns {object[]}
 */
export function scaleAtoms(atoms, factor) {
  if (!Array.isArray(atoms)) return [];
  return atoms.map(a => {
    const out = { ...a, x: a.x * factor, y: a.y * factor, z: a.z * factor };
    if (a.vx !== null && a.vx !== undefined) {
      out.vx = a.vx * factor;
      out.vy = a.vy * factor;
      out.vz = a.vz * factor;
    }
    return out;
  });
}

/**
 * Conversion factor between length units.
 *
 * @param {'A'|'nm'} from
 * @param {'A'|'nm'} to
 * @returns {number} Multiplicative factor, or 1 when the units match.
 */
export function unitFactor(from, to) {
  if (from === to) return 1;
  if (from === 'nm' && to === 'A') return 10;
  if (from === 'A' && to === 'nm') return 0.1;
  return 1;
}

/**
 * Native length unit of an output format.
 *
 * @param {'pdb'|'gro'|'xyz'} format
 * @returns {'A'|'nm'}
 */
export function targetUnit(format) {
  return format === 'gro' ? 'nm' : 'A';
}

/**
 * Compute a padded cubic box from the structure's extent.
 *
 * Every dimension is held at or above `MIN_BOX_NM`, since a planar or linear
 * molecule has zero extent along an axis and would otherwise yield an invalid
 * cell.
 *
 * @param {object[]} atoms
 * @param {'A'|'nm'} unit - Unit of the incoming coordinates.
 * @param {number} [padPercent=10] - Padding added to each dimension.
 * @returns {number[]} Box lengths in nm.
 */
export function computeBoxFromBounds(atoms, unit, padPercent = 10) {
  const bb = boundingBox(atoms);
  const toNm = unit === 'nm' ? 1 : 0.1;
  const pad = 1 + padPercent / 100;
  const dim = (lo, hi) => Math.max(MIN_BOX_NM, Math.abs(hi - lo) * toNm * pad);
  return [
    dim(bb.minX, bb.maxX),
    dim(bb.minY, bb.maxY),
    dim(bb.minZ, bb.maxZ)
  ];
}

/**
 * Check whether a structure fits inside a box.
 *
 * @param {object[]} atoms
 * @param {'A'|'nm'} unit
 * @param {number[]} box - Box lengths in nm.
 * @returns {{fits:boolean, overflow:string[]}} Axis labels that overflow.
 */
export function boxFitsStructure(atoms, unit, box) {
  const bb = boundingBox(atoms);
  const toNm = unit === 'nm' ? 1 : 0.1;
  const extents = [
    Math.abs(bb.maxX - bb.minX) * toNm,
    Math.abs(bb.maxY - bb.minY) * toNm,
    Math.abs(bb.maxZ - bb.minZ) * toNm
  ];
  const labels = ['x', 'y', 'z'];
  const overflow = [];
  for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(box[i]) || extents[i] > box[i]) overflow.push(labels[i]);
  }
  return { fits: overflow.length === 0, overflow };
}

/* ------------------------------------------------------------------ *
 * Output formatting
 * ------------------------------------------------------------------ */

/**
 * Pad or truncate a string to an exact width.
 *
 * @param {*} str
 * @param {number} len
 * @param {boolean} [leftAlign=false]
 * @returns {string}
 */
export function padStr(str, len, leftAlign = false) {
  const s = String(str);
  if (s.length >= len) return s.substring(0, len);
  return leftAlign ? s + ' '.repeat(len - s.length) : ' '.repeat(len - s.length) + s;
}

/**
 * Serialise atoms as an XYZ file.
 *
 * @param {object[]} atoms
 * @param {{comment?:string, factor?:number}} [options]
 * @returns {string}
 */
export function formatXYZ(atoms, options = {}) {
  const { comment = 'Generated by STEMKit Coordinate Manipulator (units: Angstrom)',
          factor = 1 } = options;
  const rows = [String(atoms.length), comment];
  for (const a of atoms) {
    rows.push(
      `${padStr(elementSymbol(a), 4, true)} ` +
      `${(a.x * factor).toFixed(6).padStart(14)}` +
      `${(a.y * factor).toFixed(6).padStart(14)}` +
      `${(a.z * factor).toFixed(6).padStart(14)}`
    );
  }
  return rows.join('\n');
}

/**
 * Serialise atoms as a PDB file.
 *
 * @param {object[]} atoms
 * @param {{factor?:number, box?:number[]}} [options]
 * @returns {string}
 */
export function formatPDB(atoms, options = {}) {
  const { factor = 1, box = null, boxVectors = null } = options;
  const rows = [];

  if (box && box.length >= 3) {
    // A triclinic cell is described by its angles here. Without them a
    // dodecahedral or octahedral box would be written out as a rectangular
    // one, which silently changes the system.
    const ang = boxVectors && isTriclinic(boxVectors)
      ? anglesFromBoxVectors(boxVectors)
      : { alpha: 90, beta: 90, gamma: 90 };
    // CRYST1 is written in angstrom; the box store is nm.
    // For a triclinic cell the CRYST1 lengths are the edge lengths, which are
    // not the same as the diagonal components stored in `box`: the third edge
    // of a dodecahedron is longer than its z-extent.
    const lengths = boxVectors && isTriclinic(boxVectors)
      ? [ang.a, ang.b, ang.c]
      : [box[0], box[1], box[2]];

    rows.push(
      'CRYST1' +
      padStr((lengths[0] * 10).toFixed(3), 9) +
      padStr((lengths[1] * 10).toFixed(3), 9) +
      padStr((lengths[2] * 10).toFixed(3), 9) +
      padStr(ang.alpha.toFixed(2), 7) +
      padStr(ang.beta.toFixed(2), 7) +
      padStr(ang.gamma.toFixed(2), 7) +
      ' P 1           1'
    );
  }

  atoms.forEach((a, i) => {
    const serial = a.serial || i + 1;
    rows.push(
      padStr(a.type === 'HETATM' ? 'HETATM' : 'ATOM', 6, true) +
      // Numbers that outgrow their columns wrap, as GROMACS writes them
      // (pdbio.cpp), rather than losing their last digit.
      padStr(typeof serial === 'number' ? serial % 100000 : serial, 5) + ' ' +
      padStr(a.atomName || 'X', 4, true) +
      padStr(a.altLoc || '', 1, true) +
      // Columns 18-21, laid out as GROMACS lays them: up to three characters
      // right-aligned before a blank column 21, four filling it.
      padStr(`${String(a.resName || 'UNK').slice(0, 4)} `, 4) +
      padStr(a.chain || 'A', 1) +
      padStr(residueNumberOf(a) % 10000, 4) + '    ' +
      padStr((a.x * factor).toFixed(3), 8) +
      padStr((a.y * factor).toFixed(3), 8) +
      padStr((a.z * factor).toFixed(3), 8) +
      padStr(a.occupancy || '1.00', 6) +
      padStr(a.tempFactor || '0.00', 6) + '          ' +
      padStr(elementSymbol(a), 2)
    );
  });
  rows.push('END');
  return rows.join('\n');
}

/**
 * Serialise atoms as a GROMACS .gro file.
 *
 * Velocities are written only when every atom carries them, since a partially
 * populated velocity block is invalid.
 *
 * @param {object[]} atoms
 * @param {{title?:string, factor?:number, box?:number[]}} [options]
 * @returns {string}
 */
export function formatGRO(atoms, options = {}) {
  const { title = 'Generated by STEMKit Coordinate Manipulator',
          factor = 1, box = [0, 0, 0], boxVectors = null } = options;

  const rows = [title, String(atoms.length)];
  const hasVel = atoms.length > 0 &&
    atoms.every(a => a.vx !== null && a.vx !== undefined);

  atoms.forEach((a, i) => {
    let line =
      padStr(residueNumberOf(a) % 100000, 5) +
      padStr(a.resName || 'UNK', 5, true) +
      padStr(a.atomName || 'X', 5) +
      padStr((a.serial || i + 1) % 100000, 5) +
      (a.x * factor).toFixed(3).padStart(8) +
      (a.y * factor).toFixed(3).padStart(8) +
      (a.z * factor).toFixed(3).padStart(8);

    if (hasVel) {
      line +=
        (a.vx * factor).toFixed(4).padStart(8) +
        (a.vy * factor).toFixed(4).padStart(8) +
        (a.vz * factor).toFixed(4).padStart(8);
    }
    rows.push(line);
  });

  rows.push(
    (boxVectors && isTriclinic(boxVectors)
      // GROMACS reads a triclinic cell as nine components on this line; the
      // last six are what make the box non-rectangular.
      ? boxVectors.map(v => (v || 0).toFixed(5).padStart(10)).join('')
      : `${(box[0] || 0).toFixed(5).padStart(10)}` +
        `${(box[1] || 0).toFixed(5).padStart(10)}` +
        `${(box[2] || 0).toFixed(5).padStart(10)}`)
  );
  return rows.join('\n');
}

/**
 * Serialise a structure to any supported format, converting units as required.
 *
 * @param {object[]} atoms
 * @param {'pdb'|'gro'|'xyz'} format
 * @param {{sourceUnit?:'A'|'nm', box?:number[], title?:string}} [options]
 * @returns {string}
 */
export function formatStructure(atoms, format, options = {}) {
  const { sourceUnit = 'A', box = null, boxVectors = null, title } = options;
  const factor = unitFactor(sourceUnit, targetUnit(format));

  switch (format) {
    case 'xyz':
      return formatXYZ(atoms, { factor });
    case 'pdb':
      return formatPDB(atoms, { factor, box, boxVectors });
    case 'gro':
      return formatGRO(atoms, {
        factor,
        box: box || [0, 0, 0],
        boxVectors,
        ...(title ? { title } : {})
      });
    default:
      return '';
  }
}

/**
 * Summary statistics for a parsed structure.
 *
 * @param {object[]} atoms
 * @returns {{nAtoms:number, nResidues:number, nChains:number,
 *            totalMass:number, centreOfMass:object, geometricCentre:object,
 *            boundingBox:object, radiusOfGyration:number,
 *            elements:Object<string,number>}}
 */
export function structureStats(atoms) {
  const list = Array.isArray(atoms) ? atoms : [];
  const residues = new Set();
  const chains = new Set();
  const elements = {};

  for (const a of list) {
    residues.add(`${a.chain || ''}:${a.resSeq}:${a.resName}`);
    if (a.chain) chains.add(a.chain);
    const sym = elementSymbol(a);
    elements[sym] = (elements[sym] || 0) + 1;
  }

  const com = centreOfMass(list);
  return {
    nAtoms: list.length,
    nResidues: residues.size,
    nChains: chains.size,
    totalMass: com.mass,
    centreOfMass: com,
    geometricCentre: geometricCentre(list),
    boundingBox: boundingBox(list),
    radiusOfGyration: radiusOfGyration(list),
    elements
  };
}

/* ------------------------------------------------------------------ */
/* Triclinic cells                                                     */
/* ------------------------------------------------------------------ */

/**
 * Whether a set of GROMACS box vectors describes a non-rectangular cell.
 *
 * @param {number[]|null} vectors - Up to nine values in GROMACS order.
 * @returns {boolean}
 */
export function isTriclinic(vectors) {
  if (!Array.isArray(vectors) || vectors.length < 9) return false;
  return vectors.slice(3).some(v => Number.isFinite(v) && Math.abs(v) > 1e-6);
}

/**
 * Build GROMACS box vectors from cell lengths and angles.
 *
 * GROMACS stores a cell as three vectors written in the order
 * `v1x v2y v3z v1y v1z v2x v2z v3x v3y`, and requires the cell to be
 * lower-triangular: v1y, v1z and v2z are always zero. That is the same
 * convention PDB's CRYST1 record expresses as lengths plus angles, so this is
 * the standard crystallographic conversion between the two.
 *
 * @param {number} a - Length of the first edge.
 * @param {number} b - Length of the second edge.
 * @param {number} c - Length of the third edge.
 * @param {number} alpha - Angle between b and c, in degrees.
 * @param {number} beta - Angle between a and c, in degrees.
 * @param {number} gamma - Angle between a and b, in degrees.
 * @returns {number[]} Nine values in GROMACS order.
 */
export function boxVectorsFromAngles(a, b, c, alpha, beta, gamma) {
  const rad = Math.PI / 180;
  const ca = Math.cos(alpha * rad);
  const cb = Math.cos(beta * rad);
  const cg = Math.cos(gamma * rad);
  const sg = Math.sin(gamma * rad);

  const v1x = a;
  const v2x = b * cg;
  const v2y = b * sg;
  const v3x = c * cb;
  const v3y = sg === 0 ? 0 : c * (ca - cb * cg) / sg;
  // Clamped: rounding in the cosines can drive this fractionally negative for
  // a cell that is very nearly degenerate.
  const v3z = Math.sqrt(Math.max(0, c * c - v3x * v3x - v3y * v3y));

  return [v1x, v2y, v3z, 0, 0, v2x, 0, v3x, v3y];
}

/**
 * Recover cell lengths and angles from GROMACS box vectors.
 *
 * The inverse of {@link boxVectorsFromAngles}, used when writing a CRYST1
 * record for a structure that arrived as a `.gro` file.
 *
 * @param {number[]} v - Up to nine values in GROMACS order.
 * @returns {{a:number, b:number, c:number, alpha:number, beta:number, gamma:number}}
 */
export function anglesFromBoxVectors(v) {
  const [v1x, v2y, v3z, , , v2x = 0, , v3x = 0, v3y = 0] = v;

  const a = v1x;
  const b = Math.hypot(v2x, v2y);
  const c = Math.hypot(v3x, v3y, v3z);
  const deg = 180 / Math.PI;

  const safe = (num, den) => (den === 0 ? 0 : Math.min(1, Math.max(-1, num / den)));

  return {
    a, b, c,
    alpha: Math.acos(safe(v2x * v3x + v2y * v3y, b * c)) * deg,
    beta: Math.acos(safe(v3x, c)) * deg,
    gamma: Math.acos(safe(v2x, b)) * deg
  };
}
