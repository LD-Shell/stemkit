/**
 * @module core/selection
 *
 * Atom selection language and spatial queries, extracted from STEMKit's
 * Structure Inspector.
 *
 * The original implementation was written against the 3Dmol.js viewer and
 * called back into it to resolve sub-selections. That coupling made the query
 * language impossible to test without a browser and a WebGL context, even
 * though the language itself is pure string parsing and geometry.
 *
 * Here the engine operates on plain atom records, the same shape
 * `core/structure.js` produces, so a selection can be evaluated in a script,
 * in a test, or on a trajectory frame that is never rendered.
 *
 * ## Query syntax
 *
 * Whitespace-separated terms, each `key:value`, combined with AND:
 *
 *   chain:A resi:1-50            chain A, residues 1 to 50
 *   resn:ALA,GLY                 either residue name
 *   !elem:H                      everything except hydrogen
 *   within:5,chain:B             within 5 units of any chain B atom
 *   or:chain:A|chain:B           union of two clauses
 *   protein: solvent:            named groups
 *   b:>50                        numeric comparison on B-factor
 *   x:10-20                      coordinate range
 *
 * A leading `!` or `not:` negates a term.
 *
 * ## Units
 *
 * Distances in a query are interpreted in the unit given by the `unit` option
 * and converted to the coordinate unit of the atoms. A structure read from a
 * `.gro` file is in nanometre while its PDB counterpart is in angstrom, so
 * `within:5` means very different things without this, a factor of ten in a
 * neighbour search is the difference between a contact shell and half the box.
 *
 * ## Periodic boundaries
 *
 * A structure from a simulation sits in a periodic box: a water at one face
 * is a neighbour of a ligand at the opposite face. Given the `box` option,
 * `within:` measures the distance to the nearest periodic image, as
 * `gmx select` does, for a rectangular or a triclinic cell. Without a box it
 * measures straight-line distances, which is right for a crystal structure
 * or anything else that is not periodic.
 */

/** Residue names conventionally treated as solvent. */
export const SOLVENT_RESIDUES = Object.freeze(new Set([
  'HOH', 'WAT', 'SOL', 'TIP', 'TIP3', 'TIP4', 'SPC', 'H2O', 'DOD', 'D2O'
]));

/** Residue names conventionally treated as monatomic ions. */
export const ION_RESIDUES = Object.freeze(new Set([
  'NA', 'CL', 'K', 'MG', 'CA', 'ZN', 'FE', 'MN', 'CU', 'BR', 'IOD', 'I',
  'LI', 'RB', 'CS', 'SR', 'BA', 'CO', 'NI', 'CD', 'HG', 'SOD', 'CLA', 'POT'
]));

/** The 20 standard amino acids, plus common variants. */
export const PROTEIN_RESIDUES = Object.freeze(new Set([
  'ALA', 'ARG', 'ASN', 'ASP', 'CYS', 'GLN', 'GLU', 'GLY', 'HIS', 'ILE',
  'LEU', 'LYS', 'MET', 'PHE', 'PRO', 'SER', 'THR', 'TRP', 'TYR', 'VAL',
  'MSE', 'HID', 'HIE', 'HIP', 'CYX', 'ASH', 'GLH', 'LYN', 'HSD', 'HSE', 'HSP'
]));

/** Standard nucleic acid residues, DNA and RNA. */
export const NUCLEIC_RESIDUES = Object.freeze(new Set([
  'A', 'C', 'G', 'T', 'U',
  'DA', 'DC', 'DG', 'DT', 'DU',
  'RA', 'RC', 'RG', 'RU',
  'ADE', 'CYT', 'GUA', 'THY', 'URA'
]));

/** Protein backbone atom names. */
export const BACKBONE_ATOMS = Object.freeze(new Set([
  'N', 'CA', 'C', 'O', 'OXT',
  // Nucleic acid backbone.
  'P', 'OP1', 'OP2', "O5'", "C5'", "C4'", "O4'", "C3'", "O3'", "C2'", "C1'"
]));

/**
 * Uniform grid for neighbour queries.
 *
 * Building the grid once turns a `within:` query from an O(n*m) scan into
 * something close to O(n): only the cells overlapping the search radius are
 * examined rather than every target atom.
 */
export class SpatialGrid {
  /**
   * @param {Array<{x:number,y:number,z:number}>} atoms
   * @param {number} cellSize - Grid spacing, in coordinate units. A value near
   *        the search radius is usually best; much smaller wastes memory and
   *        much larger degrades to a linear scan.
   */
  constructor(atoms, cellSize) {
    this.cell = cellSize > 0 ? cellSize : 1;
    this.map = new Map();

    for (const a of (Array.isArray(atoms) ? atoms : [])) {
      if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(a.z)) {
        continue;
      }
      const k = this._key(a.x, a.y, a.z);
      let bucket = this.map.get(k);
      if (!bucket) {
        bucket = [];
        this.map.set(k, bucket);
      }
      bucket.push(a);
    }
  }

  /** @private */
  _key(x, y, z) {
    return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)},${Math.floor(z / this.cell)}`;
  }

  /**
   * Is any indexed atom within `radius` of the point?
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} radius
   * @returns {boolean}
   */
  hasNeighbourWithin(x, y, z, radius) {
    if (!Number.isFinite(radius) || radius < 0) return false;
    const r2 = radius * radius;
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    const cz = Math.floor(z / this.cell);
    const span = Math.ceil(radius / this.cell);

    for (let i = -span; i <= span; i++) {
      for (let j = -span; j <= span; j++) {
        for (let k = -span; k <= span; k++) {
          const bucket = this.map.get(`${cx + i},${cy + j},${cz + k}`);
          if (!bucket) continue;
          for (const b of bucket) {
            const dx = b.x - x;
            const dy = b.y - y;
            const dz = b.z - z;
            if (dx * dx + dy * dy + dz * dz <= r2) return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * Every indexed atom within `radius` of the point.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} radius
   * @returns {Array<object>}
   */
  neighboursWithin(x, y, z, radius) {
    const out = [];
    if (!Number.isFinite(radius) || radius < 0) return out;
    const r2 = radius * radius;
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    const cz = Math.floor(z / this.cell);
    const span = Math.ceil(radius / this.cell);

    for (let i = -span; i <= span; i++) {
      for (let j = -span; j <= span; j++) {
        for (let k = -span; k <= span; k++) {
          const bucket = this.map.get(`${cx + i},${cy + j},${cz + k}`);
          if (!bucket) continue;
          for (const b of bucket) {
            const dx = b.x - x;
            const dy = b.y - y;
            const dz = b.z - z;
            if (dx * dx + dy * dy + dz * dz <= r2) out.push(b);
          }
        }
      }
    }
    return out;
  }

  /** Number of occupied cells; useful for judging whether the spacing suits. */
  get cellCount() {
    return this.map.size;
  }
}

/**
 * Squared distance between two atoms.
 *
 * Avoids a square root in hot loops, where only ordering or a threshold
 * comparison is needed.
 *
 * @param {{x:number,y:number,z:number}} a
 * @param {{x:number,y:number,z:number}} b
 * @returns {number}
 */
export function distanceSquared(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Distance between two atoms.
 *
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
export function distance(a, b) {
  return Math.sqrt(distanceSquared(a, b));
}

/* ------------------------------------------------------------------ *
 * Periodic cells
 * ------------------------------------------------------------------ */

const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.sqrt(dot(a, a));

/**
 * Box vectors, as rows, from any of the shapes a box arrives in.
 *
 * @param {number[]|number[][]} box - Three edge lengths (a rectangular box),
 *        nine components in the order GROMACS writes them on the last line of
 *        a .gro file (`v1x v2y v3z v1y v1z v2x v2z v3x v3y`, what
 *        `core/structure.js` keeps as `boxVectors`), or three vectors.
 * @returns {number[][]|null} Null when the value is not a box.
 */
function boxRows(box) {
  if (!Array.isArray(box)) return null;
  let rows = null;
  if (box.length === 3 && box.every(Array.isArray)) {
    rows = box.map(r => [0, 1, 2].map(d => Number(r[d]) || 0));
  } else if (box.length >= 9) {
    const v = box.map(Number);
    rows = [[v[0], v[3], v[4]], [v[5], v[1], v[6]], [v[7], v[8], v[2]]];
  } else if (box.length >= 3) {
    const v = box.map(Number);
    rows = [[v[0], 0, 0], [0, v[1], 0], [0, 0, v[2]]];
  }
  return rows && rows.every(r => r.every(Number.isFinite)) ? rows : null;
}

/**
 * The periodic cell a `within:` search measures through.
 *
 * Which directions are periodic follows GROMACS (`guessPbcType`): a box of
 * zeros is no box, and a box whose third vector is zero is periodic in x and
 * y only, as for a slab. A cell that is flat in a direction it claims to be
 * periodic in cannot be measured through and is treated as no box.
 *
 * @param {number[]|number[][]} box - See `boxRows`.
 * @param {number} scale - Box unit to coordinate unit.
 * @returns {{rows:number[][], inverse:number[][], periodic:boolean[],
 *            height:number[], cover:number}|null} `height` is the distance
 *          between opposite faces; `cover` is the farthest any point can be
 *          from the nearest image of a given atom, or Infinity when the cell
 *          is not periodic in every direction.
 */
function periodicCell(box, scale) {
  const raw = boxRows(box);
  if (!raw) return null;
  const rows = raw.map(r => r.map(c => c * scale));
  const zero = (r) => r.every(c => c === 0);
  if (rows.every(zero)) return null;
  const periodic = [true, true, !zero(rows[2])];

  // A slab has no third vector; a unit normal stands in for it so that
  // fractional coordinates are still defined, and that direction is never
  // wrapped or shifted.
  if (!periodic[2]) {
    const n = cross(rows[0], rows[1]);
    const len = norm(n);
    if (!(len > 0)) return null;
    rows[2] = n.map(c => c / len);
  }

  const det = dot(rows[0], cross(rows[1], rows[2]));
  if (!(Math.abs(det) > 1e-12)) return null;

  // Cartesian from fractional is r = f0 v0 + f1 v1 + f2 v2; the inverse maps
  // back, row i giving fractional coordinate i.
  const c12 = cross(rows[1], rows[2]);
  const c20 = cross(rows[2], rows[0]);
  const c01 = cross(rows[0], rows[1]);
  const inverse = [c12, c20, c01].map(c => c.map(x => x / det));
  const height = [c12, c20, c01].map(c => Math.abs(det) / norm(c));

  // Any point lies within half the longest body diagonal of an image of any
  // atom: its offset from the nearest lattice corner has every fractional
  // component within ±1/2.
  let cover = Infinity;
  if (periodic.every(Boolean)) {
    cover = 0;
    for (const s1 of [1, -1]) {
      for (const s2 of [1, -1]) {
        const d = [0, 1, 2].map(k => rows[0][k] + s1 * rows[1][k] + s2 * rows[2][k]);
        cover = Math.max(cover, norm(d) / 2);
      }
    }
  }
  return { rows, inverse, periodic, height, cover };
}

/**
 * A point moved into the cell by whole box vectors, along the periodic
 * directions.
 *
 * @param {{x:number,y:number,z:number}} a
 * @param {object} cell - From `periodicCell`.
 * @returns {number[]} Fractional coordinates, each periodic one in [0, 1).
 */
function fractionalInCell(a, cell) {
  const r = [a.x, a.y, a.z];
  return cell.inverse.map((row, i) => {
    const f = dot(row, r);
    return cell.periodic[i] ? f - Math.floor(f) : f;
  });
}

/**
 * Cartesian coordinates of a fractional position in the cell.
 *
 * @param {number[]} f
 * @param {number[][]} rows - Box vectors.
 * @returns {{x:number, y:number, z:number}}
 */
function cartesian(f, rows) {
  return {
    x: f[0] * rows[0][0] + f[1] * rows[1][0] + f[2] * rows[2][0],
    y: f[0] * rows[0][1] + f[1] * rows[1][1] + f[2] * rows[2][1],
    z: f[0] * rows[0][2] + f[1] * rows[1][2] + f[2] * rows[2][2]
  };
}

/**
 * Every periodic image of the targets that can lie within `radius` of a point
 * in the cell.
 *
 * With the targets and the tested atom both moved into the cell, an image
 * within `radius` of the atom is within `radius` of the cell, which bounds its
 * fractional coordinates to [-radius/height, 1 + radius/height) along each
 * periodic direction. Searching all of those images is the minimum image
 * convention made exact: rounding each fractional coordinate to the nearest
 * image, the usual shortcut, can miss a nearer image in a triclinic cell, and
 * a radius beyond half the box needs more than one image of a target.
 *
 * @param {Array<{x:number,y:number,z:number}>} targets
 * @param {object} cell - From `periodicCell`.
 * @param {number} radius
 * @returns {Array<{x:number,y:number,z:number}>}
 */
function periodicImages(targets, cell, radius) {
  const out = [];
  // The margin absorbs rounding in the wrap, which can leave a point a hair
  // outside the cell.
  const reach = cell.height.map(h => radius / h + 1e-9);
  const span = reach.map((m, i) => (cell.periodic[i] ? Math.ceil(m) + 1 : 0));
  const inRange = (g, i) => !cell.periodic[i] || (g >= -reach[i] && g < 1 + reach[i]);

  for (const t of targets) {
    if (!Number.isFinite(t.x) || !Number.isFinite(t.y) || !Number.isFinite(t.z)) continue;
    const f = fractionalInCell(t, cell);
    for (let i = -span[0]; i <= span[0]; i++) {
      const g0 = f[0] + i;
      if (!inRange(g0, 0)) continue;
      for (let j = -span[1]; j <= span[1]; j++) {
        const g1 = f[1] + j;
        if (!inRange(g1, 1)) continue;
        for (let k = -span[2]; k <= span[2]; k++) {
          const g2 = f[2] + k;
          if (!inRange(g2, 2)) continue;
          out.push(cartesian([g0, g1, g2], cell.rows));
        }
      }
    }
  }
  return out;
}

/**
 * Conversion factor from one length unit to another.
 *
 * @param {'A'|'nm'} from
 * @param {'A'|'nm'} to
 * @returns {number}
 */
function lengthFactor(from, to) {
  if (from === 'nm' && to === 'A') return 10;
  if (from === 'A' && to === 'nm') return 0.1;
  return 1;
}

/**
 * Parse a numeric comparison such as `>50`, `<=2.5`, or a range `10-20`.
 *
 * A leading minus is not mistaken for a range separator, so `-10--5` parses as
 * the range from -10 to -5 rather than failing.
 *
 * @param {string} value
 * @returns {{kind:'range', lo:number, hi:number}
 *          |{kind:'compare', op:string, val:number}
 *          |null}
 */
export function parseComparison(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return null;

  const cmp = s.match(/^(>=|<=|>|<|=)\s*(-?\d*\.?\d+)$/);
  if (cmp) {
    const val = Number(cmp[2]);
    return Number.isFinite(val) ? { kind: 'compare', op: cmp[1], val } : null;
  }

  const range = s.match(/^(-?\d*\.?\d+)\s*-\s*(-?\d*\.?\d+)$/);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    return { kind: 'range', lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
  }

  const plain = Number(s);
  return Number.isFinite(plain) ? { kind: 'compare', op: '=', val: plain } : null;
}

/**
 * Predicate for a named residue or atom group.
 *
 * @param {string} name
 * @returns {((atom:object)=>boolean)|null}
 */
export function namedGroupPredicate(name) {
  const key = String(name || '').toLowerCase();
  const resn = (a) => String(a.resn || a.resName || '').trim().toUpperCase();
  const atomName = (a) => String(a.atom || a.atomName || '').trim().toUpperCase();

  switch (key) {
    case 'protein':
      return a => PROTEIN_RESIDUES.has(resn(a));
    case 'nucleic':
      return a => NUCLEIC_RESIDUES.has(resn(a));
    case 'solvent':
      return a => SOLVENT_RESIDUES.has(resn(a));
    case 'ion':
      return a => ION_RESIDUES.has(resn(a));
    case 'backbone':
      return a => PROTEIN_RESIDUES.has(resn(a)) && BACKBONE_ATOMS.has(atomName(a));
    case 'sidechain':
      return a => PROTEIN_RESIDUES.has(resn(a)) && !BACKBONE_ATOMS.has(atomName(a));
    case 'hetero':
      // Anything that is not a standard polymer residue or water.
      return a => {
        const r = resn(a);
        return !PROTEIN_RESIDUES.has(r) &&
               !NUCLEIC_RESIDUES.has(r) &&
               !SOLVENT_RESIDUES.has(r);
      };
    default:
      return null;
  }
}

/**
 * Read an atom field, tolerating the naming used by different parsers.
 *
 * 3Dmol calls them `resn`/`resi`/`atom`; `core/structure.js` calls the same
 * things `resName`/`resSeq`/`atomName`. Accepting both means a selection
 * written for one works against the other.
 *
 * @param {object} atom
 * @param {string} field
 * @returns {*}
 */
export function atomField(atom, field) {
  if (!atom) return undefined;
  const aliases = {
    resn: ['resn', 'resName'],
    resi: ['resi', 'resSeq'],
    atom: ['atom', 'atomName'],
    elem: ['elem', 'element'],
    chain: ['chain'],
    serial: ['serial', 'index'],
    b: ['b', 'tempFactor'],
    x: ['x'], y: ['y'], z: ['z'],
    charge: ['charge']
  };
  for (const key of (aliases[field] || [field])) {
    if (atom[key] !== undefined && atom[key] !== null) return atom[key];
  }
  return undefined;
}

/**
 * Compile a selection string into a predicate.
 *
 * @param {string} query
 * @param {Array<object>} atoms - The pool a `within:` sub-selection searches.
 * @param {{unit?:'A'|'nm', coordinateUnit?:'A'|'nm',
 *          box?:number[]|number[][]|null, boxVectors?:number[]|null,
 *          boxUnit?:'A'|'nm'}} [options] - With `box`, `within:` measures
 *        to the nearest periodic image. The box is three edge lengths, the
 *        nine GROMACS components, or three vectors; `boxVectors` (nine
 *        components) takes precedence when it is given, so a
 *        `core/structure.js` parse result can be passed as
 *        `{ box: r.box, boxVectors: r.boxVectors }`. The box is read in
 *        `boxUnit`, nanometre by default because that is the unit
 *        `core/structure.js` keeps every box in, a PDB's CRYST1 included,
 *        whatever the unit of the coordinates.
 * @returns {{predicate:(atom:object)=>boolean, errors:string[], terms:number}}
 */
export function compileSelection(query, atoms = [], options = {}) {
  const { unit = 'A', coordinateUnit = 'A', boxUnit = 'nm' } = options;
  const errors = [];

  // Distances in the query are in `unit`; atoms are in `coordinateUnit`.
  const unitMult = lengthFactor(unit, coordinateUnit);

  // Built on the first `within:` term only: most queries never measure.
  let cell;
  const cellOf = () => {
    if (cell === undefined) {
      const nine = Array.isArray(options.boxVectors) && options.boxVectors.length >= 9;
      cell = periodicCell(nine ? options.boxVectors : options.box,
        lengthFactor(boxUnit, coordinateUnit));
    }
    return cell;
  };

  const q = String(query == null ? '' : query).trim();
  if (!q) {
    return { predicate: () => true, errors, terms: 0 };
  }

  const predicates = [];
  const tokens = q.split(/\s+/);
  let termCount = 0;

  for (let raw of tokens) {
    let negate = false;
    if (raw.startsWith('!')) { negate = true; raw = raw.slice(1); }
    if (raw.startsWith('not:')) { negate = true; raw = raw.slice(4); }

    const idx = raw.indexOf(':');
    if (idx === -1) {
      errors.push(`Ignored "${raw}": expected key:value.`);
      continue;
    }

    const key = raw.slice(0, idx).toLowerCase();
    const val = raw.slice(idx + 1);
    termCount++;

    // ---- Named groups (value may be empty: "protein:") ----
    const named = namedGroupPredicate(key);
    if (named) {
      predicates.push(negate ? (a => !named(a)) : named);
      continue;
    }

    if (!val) {
      errors.push(`Ignored "${raw}": no value given.`);
      termCount--;
      continue;
    }

    // ---- Union: or:chain:A|chain:B ----
    if (key === 'or') {
      const clauses = val.split('|')
        .map(c => compileSelection(c, atoms, options));
      for (const c of clauses) errors.push(...c.errors);
      const preds = clauses.map(c => c.predicate);
      const p = a => preds.some(f => f(a));
      predicates.push(negate ? (a => !p(a)) : p);
      continue;
    }

    // ---- Distance: within:5,chain:A ----
    if (key === 'within') {
      const comma = val.indexOf(',');
      if (comma === -1) {
        errors.push(`Ignored "within:${val}": expected within:RADIUS,SELECTION.`);
        continue;
      }
      const radius = Number(val.slice(0, comma)) * unitMult;
      if (!Number.isFinite(radius) || radius < 0) {
        errors.push(`Ignored "within:${val}": radius is not a positive number.`);
        continue;
      }

      const inner = compileSelection(val.slice(comma + 1), atoms, options);
      errors.push(...inner.errors);
      // Found with the pool's own filter: a caller may hand in a pool whose
      // filter adds images of what it finds (core/gromacs-ndx does).
      const targets = atoms.filter(inner.predicate);

      if (targets.length === 0) {
        // An empty target set selects nothing, or everything when negated.
        predicates.push(negate ? (() => true) : (() => false));
        continue;
      }

      const box = cellOf();
      let p;
      if (!box) {
        const grid = new SpatialGrid(targets, Math.max(radius, 1e-6));
        p = a => grid.hasNeighbourWithin(a.x, a.y, a.z, radius);
      } else if (radius >= box.cover) {
        // Every point in a periodic system is this close to an image of each
        // target, so there is nothing to search.
        p = () => true;
      } else {
        // Minimum image: the tested atom is moved into the cell and searched
        // against the target images around it, so an atom near one face finds
        // a target near the opposite one, and a molecule sticking out of the
        // box is measured as GROMACS measures it.
        const grid = new SpatialGrid(periodicImages(targets, box, radius), Math.max(radius, 1e-6));
        p = (a) => {
          const w = cartesian(fractionalInCell(a, box), box.rows);
          return grid.hasNeighbourWithin(w.x, w.y, w.z, radius);
        };
      }
      predicates.push(negate ? (a => !p(a)) : p);
      continue;
    }

    // ---- Numeric comparisons ----
    if (['x', 'y', 'z', 'b', 'serial', 'charge'].includes(key)) {
      const cmp = parseComparison(val);
      if (!cmp) {
        errors.push(`Ignored "${key}:${val}": not a number, comparison, or range.`);
        continue;
      }
      // Only coordinates carry a length unit; a B-factor or serial does not.
      const scale = ['x', 'y', 'z'].includes(key) ? unitMult : 1;

      const p = (a) => {
        const v = atomField(a, key);
        if (v === undefined || v === null) return false;
        if (cmp.kind === 'range') {
          return v >= cmp.lo * scale && v <= cmp.hi * scale;
        }
        switch (cmp.op) {
          case '>=': return v >= cmp.val * scale;
          case '<=': return v <= cmp.val * scale;
          case '>': return v > cmp.val * scale;
          case '<': return v < cmp.val * scale;
          default: return Math.abs(v - cmp.val * scale) < 1e-3;
        }
      };
      predicates.push(negate ? (a => !p(a)) : p);
      continue;
    }

    // ---- Residue index, supporting ranges and lists ----
    if (key === 'resi') {
      const range = val.match(/^(-?\d+)\s*-\s*(-?\d+)$/);
      let p;
      if (range) {
        const lo = Math.min(Number(range[1]), Number(range[2]));
        const hi = Math.max(Number(range[1]), Number(range[2]));
        p = a => {
          const v = Number(atomField(a, 'resi'));
          return Number.isFinite(v) && v >= lo && v <= hi;
        };
      } else {
        const wanted = new Set(val.split(',').map(v => String(v).trim()));
        p = a => wanted.has(String(atomField(a, 'resi')));
      }
      predicates.push(negate ? (a => !p(a)) : p);
      continue;
    }

    // ---- Plain attribute match, comma-separated for alternatives ----
    const wanted = new Set(
      val.split(',').map(v => String(v).trim().toUpperCase()).filter(Boolean)
    );
    const p = (a) => {
      const v = atomField(a, key);
      if (v === undefined || v === null) return false;
      return wanted.has(String(v).trim().toUpperCase());
    };
    predicates.push(negate ? (a => !p(a)) : p);
  }

  const predicate = predicates.length
    ? (a => predicates.every(f => f(a)))
    : (() => true);

  return { predicate, errors, terms: termCount };
}

/**
 * Select atoms matching a query.
 *
 * @param {Array<object>} atoms
 * @param {string} query
 * @param {{unit?:string, coordinateUnit?:string, byres?:boolean,
 *          box?:number[]|number[][]|null, boxVectors?:number[]|null,
 *          boxUnit?:string}} [options] - As for `compileSelection`; `box`
 *        makes `within:` periodic.
 * @returns {{atoms:Array<object>, errors:string[], count:number}}
 */
export function selectAtoms(atoms, query, options = {}) {
  const pool = Array.isArray(atoms) ? atoms : [];
  const { predicate, errors } = compileSelection(query, pool, options);
  let selected = pool.filter(predicate);

  if (options.byres) selected = expandToResidues(pool, selected);

  return { atoms: selected, errors, count: selected.length };
}

/**
 * Expand a selection to every atom of each touched residue.
 *
 * Residue identity is the (chain, index, name) triple: two residues numbered 1
 * in different chains are different residues, and relying on the number alone
 * silently merges them.
 *
 * @param {Array<object>} allAtoms
 * @param {Array<object>} selected
 * @returns {Array<object>}
 */
export function expandToResidues(allAtoms, selected) {
  if (!Array.isArray(allAtoms) || !Array.isArray(selected)) return [];

  const keyOf = (a) =>
    `${atomField(a, 'chain') ?? ''}|${atomField(a, 'resi') ?? ''}|${atomField(a, 'resn') ?? ''}`;

  const wanted = new Set(selected.map(keyOf));
  return allAtoms.filter(a => wanted.has(keyOf(a)));
}

/**
 * Find contacts between two atom sets.
 *
 * @param {Array<object>} groupA
 * @param {Array<object>} groupB
 * @param {number} cutoff
 * @returns {Array<{a:object, b:object, distance:number}>} Sorted by distance.
 */
export function findContacts(groupA, groupB, cutoff) {
  const out = [];
  if (!Array.isArray(groupA) || !Array.isArray(groupB)) return out;
  if (!Number.isFinite(cutoff) || cutoff <= 0) return out;

  const grid = new SpatialGrid(groupB, Math.max(cutoff, 1e-6));
  for (const a of groupA) {
    for (const b of grid.neighboursWithin(a.x, a.y, a.z, cutoff)) {
      if (a === b) continue;
      out.push({ a, b, distance: distance(a, b) });
    }
  }
  return out.sort((p, q) => p.distance - q.distance);
}

/**
 * Summarise a selection.
 *
 * @param {Array<object>} atoms
 * @returns {{nAtoms:number, nResidues:number, nChains:number,
 *            elements:Object<string,number>, residues:Object<string,number>}}
 */
export function selectionSummary(atoms) {
  const list = Array.isArray(atoms) ? atoms : [];
  const residues = new Set();
  const chains = new Set();
  const elements = {};
  const resCounts = {};

  for (const a of list) {
    const chain = atomField(a, 'chain') ?? '';
    const resi = atomField(a, 'resi') ?? '';
    const resn = String(atomField(a, 'resn') ?? '').toUpperCase();

    residues.add(`${chain}|${resi}|${resn}`);
    if (chain) chains.add(chain);

    const el = String(atomField(a, 'elem') ?? '?').trim();
    elements[el] = (elements[el] || 0) + 1;
    if (resn) resCounts[resn] = (resCounts[resn] || 0) + 1;
  }

  return {
    nAtoms: list.length,
    nResidues: residues.size,
    nChains: chains.size,
    elements,
    residues: resCounts
  };
}
