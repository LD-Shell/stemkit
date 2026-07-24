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
 *   - **GRO**, GROMACS native, coordinates in nanometre, also fixed-column,
 *     with optional velocities in columns 45-68 and box vectors on the final
 *     line.
 *   - **XYZ**, whitespace-delimited, coordinates in ångström, no box.
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
 * Parse a PDB file.
 *
 * Fields are read by column position per the PDB v3.3 specification. CRYST1
 * unit-cell lengths, when present, are converted from ångström to nanometre so
 * that box data is stored in a single consistent unit regardless of source.
 *
 * @param {string} text
 * @returns {{atoms:object[], box:number[]|null, unit:'A', format:'pdb',
 *            unknownElements:string[]}}
 */
export function parsePDB(text) {
  const atoms = [];
  const unknown = new Set();
  let box = null;
  let boxVectors = null;

  if (typeof text !== 'string') {
    return { atoms, box, boxVectors, unit: 'A', format: 'pdb', unknownElements: [] };
  }

  for (const line of text.split(/\r\n|\r|\n/)) {
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
      if (![a, b, c].some(Number.isNaN)) {
        box = [a / 10, b / 10, c / 10];
        const ang = [alpha, beta, gamma].map(v => (Number.isNaN(v) ? 90 : v));
        if (ang.some(v => Math.abs(v - 90) > 1e-3)) {
          boxVectors = boxVectorsFromAngles(a / 10, b / 10, c / 10, ang[0], ang[1], ang[2]);
        }
      }
      continue;
    }
    if (!(line.startsWith('ATOM') || line.startsWith('HETATM'))) continue;

    const x = safeFloat(line.substring(30, 38));
    const y = safeFloat(line.substring(38, 46));
    const z = safeFloat(line.substring(46, 54));
    if ([x, y, z].some(Number.isNaN)) continue;

    atoms.push({
      type: line.substring(0, 6).trim(),
      serial: parseInt(line.substring(6, 11), 10) || atoms.length + 1,
      atomName: line.substring(12, 16).trim(),
      altLoc: line.substring(16, 17).trim(),
      resName: line.substring(17, 20).trim(),
      chain: line.substring(21, 22).trim(),
      resSeq: parseInt(line.substring(22, 26), 10) || 1,
      x, y, z,
      vx: null, vy: null, vz: null,
      occupancy: line.substring(54, 60).trim() || '1.00',
      tempFactor: line.substring(60, 66).trim() || '0.00',
      element: line.substring(76, 78).trim() || ''
    });
  }

  for (const a of atoms) atomicMass(a, unknown);
  return { atoms, box, boxVectors, unit: 'A', format: 'pdb', unknownElements: [...unknown] };
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
 * @param {string} text
 * @returns {{atoms:object[], box:number[]|null, unit:'nm', format:'gro',
 *            title:string, unknownElements:string[]}}
 */
export function parseGRO(text) {
  const atoms = [];
  const unknown = new Set();
  let box = null;
  let boxVectors = null;
  let title = '';

  if (typeof text !== 'string') {
    return { atoms, box, boxVectors, unit: 'nm', format: 'gro', title, unknownElements: [] };
  }

  const lines = text.split(/\r\n|\r|\n/);
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  const src = lines.slice(0, end);
  if (src.length < 3) {
    return { atoms, box, boxVectors, unit: 'nm', format: 'gro', title, unknownElements: [] };
  }

  title = src[0].trim();
  const declared = parseInt(src[1].trim(), 10);
  const atomCount = Number.isFinite(declared) ? declared : src.length - 3;

  for (let i = 2; i < 2 + atomCount && i < src.length; i++) {
    const line = src[i];
    if (!line || line.length < 44) continue;

    const x = safeFloat(line.substring(20, 28));
    const y = safeFloat(line.substring(28, 36));
    const z = safeFloat(line.substring(36, 44));
    if ([x, y, z].some(Number.isNaN)) continue;

    let vx = null;
    let vy = null;
    let vz = null;
    if (line.length >= 68) {
      vx = safeFloat(line.substring(44, 52));
      vy = safeFloat(line.substring(52, 60));
      vz = safeFloat(line.substring(60, 68));
      if ([vx, vy, vz].some(Number.isNaN)) { vx = null; vy = null; vz = null; }
    }

    atoms.push({
      resSeq: parseInt(line.substring(0, 5), 10) || 1,
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
  return { atoms, box, boxVectors, unit: 'nm', format: 'gro', title, unknownElements: [...unknown] };
}

/**
 * Parse an XYZ file.
 *
 * @param {string} text
 * @returns {{atoms:object[], box:null, unit:'A', format:'xyz',
 *            comment:string, unknownElements:string[]}}
 */
export function parseXYZ(text) {
  const atoms = [];
  const unknown = new Set();
  let comment = '';

  if (typeof text !== 'string') {
    return { atoms, box: null, unit: 'A', format: 'xyz', comment, unknownElements: [] };
  }

  const clean = text.split(/\r\n|\r|\n/).filter(l => l.trim().length > 0);
  if (clean.length < 2) {
    return { atoms, box: null, unit: 'A', format: 'xyz', comment, unknownElements: [] };
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
  return { atoms, box: null, unit: 'A', format: 'xyz', comment, unknownElements: [...unknown] };
}

/**
 * Parse a structure, dispatching on an explicit format or a filename.
 *
 * @param {string} text
 * @param {string} formatOrFilename - 'pdb' | 'gro' | 'xyz', or a filename whose
 *        extension selects the parser.
 * @returns {object|null} Parse result, or null for an unsupported format.
 */
export function parseStructure(text, formatOrFilename = '') {
  const token = String(formatOrFilename).toLowerCase();
  const ext = token.includes('.') ? token.split('.').pop() : token;

  switch (ext) {
    case 'pdb':
    case 'ent':
      return parsePDB(text);
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
  if (!Array.isArray(atoms)) return [];
  const p = pivot || { x: 0, y: 0, z: 0 };
  const [r00, r01, r02, r10, r11, r12, r20, r21, r22] =
    rotationMatrix(degX, degY, degZ);

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
      padStr(serial, 5) + ' ' +
      padStr(a.atomName || 'X', 4, true) +
      padStr(a.altLoc || '', 1, true) +
      padStr(a.resName || 'UNK', 3) + ' ' +
      padStr(a.chain || 'A', 1) +
      padStr(a.resSeq || 1, 4) + '    ' +
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
      padStr(a.resSeq || 1, 5) +
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
