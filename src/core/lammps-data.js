/**
 * STEMKit, LAMMPS data files: reading them, saying what is in them, and the
 * groups a set-up needs.
 * Author: Olanrewaju M. Daramola
 *
 * @module core/lammps-data
 *
 * The reader follows `read_data` in LAMMPS 29 Aug 2024 (ReadData::header,
 * ReadData::parse_keyword and the section readers in src/read_data.cpp, and
 * Atom::data_atoms, data_vels, data_bonds, ... in src/atom.cpp), so a file
 * this module accepts is a file LAMMPS accepts, and the other way round.
 * Checked against the real program on every data file in the LAMMPS
 * examples, and on broken copies of them, by tools/check-lammps-data.mjs.
 * The rules worth knowing:
 *
 *   - the first line is always skipped (a title; a `units = real` in it is
 *     read as a hint);
 *   - the header is read until the first line that is not blank and not a
 *     header keyword. `#` starts a comment, but a count written as
 *     `100 atoms#` (no space before the `#`) is not a header line any more;
 *   - a section name stands alone on its line (`Atoms`, `Pair Coeffs`), with
 *     an optional `# style` comment, and the line after it is always
 *     skipped, whatever it holds;
 *   - a section has exactly as many lines as the header says (atoms, types,
 *     bonds, ...): blank and comment lines inside it count as lines, so they
 *     leave an atom or a bond out, which LAMMPS then stops on;
 *   - the Atoms section decides from its first line (and again every 1024
 *     lines) whether image flags follow the columns of the atom style;
 *   - lines longer than 254 characters are cut there;
 *   - a file that ends inside the header, with no section at all, is
 *     accepted as it is.
 *
 * `parseDataFile` reads a file into compact typed arrays (a million atoms
 * in well under a second in Node), `summariseData` says what the system is
 * made of (per type: mass, element, count, charge; water and its model,
 * ions, hydrogen types for SHAKE, the solute; charge, volume, density), and
 * `groupsFromData` suggests the `group` commands for it.
 *
 * ```js
 * const data = parseDataFile(text);             // atom style from '# full' or the columns
 * const summary = summariseData(data, { units: 'real' });
 * summary.water;          // { model: 'TIP3P', oType: 1, hType: 2, bondType: 1, angleType: 1, count: 4012, ... }
 * groupsFromData(summary);  // [{ name: 'water', command: 'group water type 1 2', count: 12036, why }]
 * ```
 */

const DOCS = 'https://docs.lammps.org/';
const docUrl = (page) => `${DOCS}${page}.html`;
const READ_DATA_URL = docUrl('read_data');

/* ------------------------------------------------------------------ *
 * Atom styles
 * ------------------------------------------------------------------ */

/* Columns per field (default 1) and the fields read as integers. */
const FIELD_COLS = { x: 3, mu3: 3, v: 3, omega: 3, angmom: 3, x0: 3, sp: 4, cs: 2 };
const INT_FIELDS = new Set(['id', 'molecule', 'ellipsoid', 'line', 'tri', 'body', 'molindex',
  'molatom', 'espin', 'etag', 'rheo_status']);

/* What each field is called in a column list shown to the user. */
const FIELD_NAMES = {
  id: ['atom-ID'], type: ['atom-type'], molecule: ['molecule-ID'], q: ['q'], x: ['x', 'y', 'z'],
  mu3: ['mux', 'muy', 'muz'], radius: ['diameter'], rmass: ['density'], ellipsoid: ['ellipsoidflag'],
  line: ['lineflag'], tri: ['triangleflag'], body: ['bodyflag'], molindex: ['template-index'],
  molatom: ['template-atom'], vfrac: ['volume'], sp: ['spx', 'spy', 'spz', 'sp'], espin: ['espin'],
  eradius: ['eradius'], etag: ['etag'], cs: ['cs_re', 'cs_im'], dpdTheta: ['theta'], rho: ['rho'],
  esph: ['esph'], cv: ['cv'], edpd_temp: ['edpd_temp'], edpd_cv: ['edpd_cv'], cc: ['cc'],
  rheo_status: ['status'], area: ['area'], ed: ['ed'], em: ['em'], epsilon: ['epsilon'],
  curvature: ['curvature'], contact_radius: ['cradius'], x0: ['x0', 'y0', 'z0'],
  v: ['vx', 'vy', 'vz'], omega: ['wx', 'wy', 'wz'], angmom: ['lx', 'ly', 'lz'], ervel: ['ervel']
};

/*
 * The atom styles of LAMMPS 29 Aug 2024: the fields of an Atoms line and of
 * a Velocities line in file order (fields_data_atom and fields_data_vel of
 * each atom_vec_*.cpp), whether the style is molecular (1) or uses molecule
 * templates (2), which topology it allows (bonds, angles, dihedrals,
 * impropers), whether masses are per type (a Masses section) or per atom,
 * and the extra section its finite-size particles need.
 */
const S = (atom, vel, flags = {}) => ({
  atom: atom.split(' '), vel: vel.split(' '), molecular: 0, topo: 0, perType: true, bonus: null,
  ...flags
});
const TOPO_ALL = 4;
const ATOM_STYLE_TABLE = {
  amoeba: S('id molecule type q x', 'id v', { molecular: 1, topo: TOPO_ALL }),
  angle: S('id molecule type x', 'id v', { molecular: 1, topo: 2 }),
  atomic: S('id type x', 'id v'),
  body: S('id type body rmass x', 'id v angmom', { perType: false, bonus: 'body' }),
  bond: S('id molecule type x', 'id v', { molecular: 1, topo: 1 }),
  'bpm/sphere': S('id molecule type radius rmass x', 'id v omega', { molecular: 1, topo: 1, perType: false }),
  charge: S('id type q x', 'id v'),
  dielectric: S('id molecule type q x mu3 area ed em epsilon curvature', 'id v', { molecular: 1, topo: TOPO_ALL }),
  dipole: S('id type q x mu3', 'id v'),
  dpd: S('id type dpdTheta x', 'id v'),
  edpd: S('id type edpd_temp edpd_cv x', 'id v'),
  electron: S('id type q espin eradius x', 'id v ervel'),
  ellipsoid: S('id type ellipsoid rmass x', 'id v angmom', { perType: false, bonus: 'ellipsoid' }),
  full: S('id molecule type q x', 'id v', { molecular: 1, topo: TOPO_ALL }),
  line: S('id molecule type line rmass x', 'id v omega', { perType: false, bonus: 'line' }),
  mdpd: S('id type rho x', 'id v'),
  molecular: S('id molecule type x', 'id v', { molecular: 1, topo: TOPO_ALL }),
  oxdna: S('id type x', 'id v', { molecular: 1, topo: 1 }),
  peri: S('id type vfrac rmass x', 'id v', { perType: false }),
  rheo: S('id type rheo_status rho x', 'id v'),
  'rheo/thermal': S('id type rheo_status rho esph x', 'id v'),
  smd: S('id type molecule vfrac rmass radius contact_radius x0 x', 'id v'),
  sph: S('id type rho esph cv x', 'id v'),
  sphere: S('id type radius rmass x', 'id v omega', { perType: false }),
  spin: S('id type x sp', 'id v'),
  tdpd: S('id type x cc', 'id v'),
  template: S('id molecule molindex molatom type x', 'id v', { molecular: 2, topo: 0 }),
  tri: S('id molecule type tri rmass x', 'id v omega angmom', { perType: false, bonus: 'tri' }),
  wavepacket: S('id type q espin eradius etag cs x', 'id v ervel')
};

/**
 * The columns of an Atoms line for each atom style LAMMPS 29 Aug 2024
 * knows, as the user writes them (`atom-ID molecule-ID atom-type q x y z`
 * for full). Image flags (nx ny nz) may follow the last column.
 *
 * @type {Readonly<Object<string, string[]>>}
 */
export const ATOM_STYLE_COLUMNS = Object.freeze(Object.fromEntries(Object.entries(ATOM_STYLE_TABLE)
  .map(([name, st]) => [name, Object.freeze(st.atom.flatMap(f => (f === 'cc' ? ['cc1', '...'] : FIELD_NAMES[f] || [f])))])));

/*
 * Resolve an atom_style (`full`, `hybrid full sphere`, `tdpd 2`, `body
 * nparticle 2 6`) to its fields. Returns null for a style LAMMPS does not
 * have; `hybrid` without sub-styles resolves with `known: false`.
 */
function resolveAtomStyle(spec) {
  const words = String(spec || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const name = words[0];
  const widthOf = (field, args) => {
    if (field === 'cc') {
      const n = parseInt(args[0], 10);
      return n > 0 ? n : 1;
    }
    return FIELD_COLS[field] || 1;
  };
  const build = (styleName, styles) => {
    const atomFields = [];
    const velFields = [];
    const widths = {};
    const add = (list, f, w) => { if (!list.includes(f)) { list.push(f); widths[f] = w; } };
    let molecular = 0;
    let topo = 0;
    let perType = false;
    const bonus = [];
    for (const [st, args] of styles) {
      for (const f of st.atom) add(atomFields, f, widthOf(f, args));
      for (const f of st.vel) add(velFields, f, widthOf(f, args));
      molecular = Math.max(molecular, st.molecular);
      topo = Math.max(topo, st.topo);
      perType = perType || st.perType;
      if (st.bonus) bonus.push(st.bonus);
    }
    // A hybrid style starts from id, type and x, then adds each sub-style's
    // fields that are not there yet, in the order given.
    const cols = {};
    let at = 0;
    for (const f of atomFields) { cols[f] = at; at += widths[f]; }
    let vat = 0;
    const vcols = {};
    for (const f of velFields) { vcols[f] = vat; vat += widths[f]; }
    return {
      name: styleName, spec: words.join(' '), known: true, fields: atomFields, widths, cols,
      size: at, velFields, velSize: vat, vcols, molecular, topo, perType,
      rmass: atomFields.includes('rmass'), bonus
    };
  };
  if (name === 'hybrid') {
    const styles = [];
    let i = 1;
    while (i < words.length) {
      const st = ATOM_STYLE_TABLE[words[i]];
      if (!st) return null;
      if (words[i] === 'hybrid') return null;
      let j = i + 1;
      while (j < words.length && !ATOM_STYLE_TABLE[words[j]]) j++;
      styles.push([st, words.slice(i + 1, j)]);
      i = j;
    }
    if (!styles.length) {
      // Sub-styles unknown: only id, type and x are sure (they come first).
      const r = build('hybrid', [[S('id type x', 'id v'), []]]);
      return { ...r, known: false, perType: true, topo: TOPO_ALL, molecular: 1 };
    }
    return build('hybrid', [[S('id type x', 'id v'), []], ...styles]);
  }
  const st = ATOM_STYLE_TABLE[name];
  if (!st) return null;
  return build(name, [[st, words.slice(1)]]);
}

/* ------------------------------------------------------------------ *
 * Numbers, as LAMMPS's utils::numeric / inumeric / bnumeric read them
 * ------------------------------------------------------------------ */

const POW10 = [1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14,
  1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22];
const DBL_MIN = 2.2250738585072014e-308;

/*
 * A floating-point number as utils::numeric accepts it: [+-] digits with an
 * optional point and exponent (no inf, nan or hex), and within the range of
 * a double (std::stod also refuses a value that underflows). NaN when not.
 * Short decimals are converted exactly without making a string.
 */
function numberAt(t, s, e) {
  let i = s;
  let c = t.charCodeAt(i);
  let neg = false;
  if (c === 43 || c === 45) { neg = c === 45; i++; }
  let mant = 0;
  let digits = 0;       // significant digits in mant
  let nd = 0;           // digits seen
  let scale = 0;        // decimal exponent adjustment
  let nonzero = false;
  let exact = true;
  while (i < e) {
    c = t.charCodeAt(i);
    if (c < 48 || c > 57) break;
    if (c !== 48) nonzero = true;
    if (digits < 15) { mant = mant * 10 + (c - 48); if (mant) digits++; } else { scale++; exact = false; }
    nd++; i++;
  }
  if (i < e && c === 46) {
    i++;
    while (i < e) {
      c = t.charCodeAt(i);
      if (c < 48 || c > 57) break;
      if (c !== 48) nonzero = true;
      if (digits < 15) { mant = mant * 10 + (c - 48); if (mant) digits++; scale--; } else exact = false;
      nd++; i++;
    }
  }
  if (nd === 0) return NaN;
  let exp = 0;
  if (i < e && (c === 101 || c === 69)) {
    i++;
    let eneg = false;
    c = t.charCodeAt(i);
    if (c === 43 || c === 45) { eneg = c === 45; i++; }
    let ed = 0;
    while (i < e) {
      c = t.charCodeAt(i);
      if (c < 48 || c > 57) return NaN;
      if (exp < 100000) exp = exp * 10 + (c - 48);
      ed++; i++;
    }
    if (!ed) return NaN;
    if (eneg) exp = -exp;
  }
  if (i !== e) return NaN;
  let v;
  const p = scale + exp;
  if (exact && p >= -22 && p <= 22) v = p >= 0 ? mant * POW10[p] : mant / POW10[-p];
  else v = Number(t.slice(neg || t.charCodeAt(s) === 43 ? s + 1 : s, e));
  if (!Number.isFinite(v)) return NaN;
  if (nonzero && (v === 0 || v < DBL_MIN)) return NaN;
  return neg ? -v : v;
}

/* A whole number as utils::inumeric accepts it ([+-]digits, int32). */
function intAt(t, s, e, max = 2147483647) {
  let i = s;
  let c = t.charCodeAt(i);
  let neg = false;
  if (c === 43 || c === 45) { neg = c === 45; i++; }
  if (i >= e) return NaN;
  let v = 0;
  for (; i < e; i++) {
    c = t.charCodeAt(i);
    if (c < 48 || c > 57) return NaN;
    v = v * 10 + (c - 48);
  }
  if (neg ? v > max + 1 : v > max) return NaN;
  return neg ? -v : v;
}
const BIGINT_MAX = 9223372036854775807;
const MAXTAGINT = 2147483647;

/* utils::is_type: 0 a number, 1 a type label, -1 neither. */
function typeKind(t, s, e) {
  let numeric = true;
  let nstar = 0;
  for (let i = s; i < e; i++) {
    const c = t.charCodeAt(i);
    if (c >= 48 && c <= 57) continue;
    if (c === 42) { nstar++; continue; }
    numeric = false;
  }
  if (numeric && nstar < 2) return 0;
  const c0 = t.charCodeAt(s);
  if ((c0 >= 48 && c0 <= 57) || c0 === 42 || c0 === 35) return -1;
  for (let i = s; i < e; i++) if (t.charCodeAt(i) > 127) return -1;
  return 1;
}

/* ------------------------------------------------------------------ *
 * Lines and words
 * ------------------------------------------------------------------ */

/* LAMMPS reads 254 characters of a line and drops the rest. */
const MAXCHARS = 254;

class LineReader {
  constructor(text) {
    this.t = text;
    this.n = text.length;
    this.pos = 0;
    this.no = 0;
    this.a = 0;
    this.b = 0;
  }

  /* Next line into [a, b); false at the end of the file. */
  next() {
    if (this.pos >= this.n) return false;
    let e = this.t.indexOf('\n', this.pos);
    if (e < 0) e = this.n;
    this.a = this.pos;
    this.b = e - this.pos > MAXCHARS ? this.pos + MAXCHARS : e;
    this.pos = e + 1;
    this.no++;
    return true;
  }

  str() { return this.t.slice(this.a, this.b); }
}

let TS = new Int32Array(64);
let TE = new Int32Array(64);

/* Split [a, b) at C white space (Tokenizer's " \t\r\n\f"); with `cut`, stop
   at the first '#' anywhere (utils::trim_comment). Returns the word count;
   word k is t.slice(TS[k], TE[k]). */
function words(t, a, b, cut = false) {
  let n = 0;
  let i = a;
  while (i < b) {
    let c = t.charCodeAt(i);
    if (c === 32 || c === 9 || c === 13 || c === 10 || c === 12) { i++; continue; }
    if (cut && c === 35) break;
    const s = i;
    let hash = false;
    while (i < b) {
      c = t.charCodeAt(i);
      if (c === 32 || c === 9 || c === 13 || c === 10 || c === 12) break;
      if (cut && c === 35) { hash = true; break; }
      i++;
    }
    if (n === TS.length) {
      const ns = new Int32Array(n * 2); ns.set(TS); TS = ns;
      const ne = new Int32Array(n * 2); ne.set(TE); TE = ne;
    }
    TS[n] = s; TE[n] = i; n++;
    if (hash) break;
  }
  return n;
}

/* Words before the first one that starts with '#'. */
function wordsBeforeComment(t, n) {
  for (let k = 0; k < n; k++) if (t.charCodeAt(TS[k]) === 35) return k;
  return n;
}

const word = (t, k) => t.slice(TS[k], TE[k]);

/* A growable typed array. */
class Grow {
  constructor(Type, width = 1, hint = 1024) {
    this.Type = Type;
    this.w = width;
    this.a = new Type(Math.max(16, hint) * width);
    this.n = 0;
  }

  reserve() {
    if ((this.n + 1) * this.w > this.a.length) {
      const b = new this.Type(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    return this.n++ * this.w;
  }

  done() { return this.a.subarray(0, this.n * this.w); }
}

/* ------------------------------------------------------------------ *
 * The header
 * ------------------------------------------------------------------ */

/* isspace, and LAMMPS's regex \f (a character of a number). */
const W = '[ \\t\\n\\v\\f\\r]';
const F = '[0-9+\\-.eE]';
const rx = (s, anchored = true) => new RegExp(`${anchored ? '^' : ''}${s}`);
const COUNT_KEYS = [
  ['atoms', rx(`${W}*\\d+${W}+atoms${W}`)],
  ['ellipsoids', rx(`${W}*\\d+${W}+ellipsoids${W}`)],
  ['lines', rx(`${W}*\\d+${W}+lines${W}`)],
  ['triangles', rx(`${W}*\\d+${W}+triangles${W}`)],
  ['bodies', rx(`${W}*\\d+${W}+bodies${W}`)],
  ['bonds', rx(`${W}*\\d+${W}+bonds${W}`)],
  ['angles', rx(`${W}*\\d+${W}+angles${W}`)],
  ['dihedrals', rx(`${W}*\\d+${W}+dihedrals${W}`)],
  ['impropers', rx(`${W}*\\d+${W}+impropers${W}`)]
];
const TYPE_KEYS = [
  ['atom', rx(`${W}*\\d+${W}+atom${W}+types${W}`)],
  // LAMMPS does not anchor this one.
  ['bond', rx(`${W}*\\d+${W}+bond${W}+types${W}`, false)],
  ['angle', rx(`${W}*\\d+${W}+angle${W}+types${W}`)],
  ['dihedral', rx(`${W}*\\d+${W}+dihedral${W}+types${W}`)],
  ['improper', rx(`${W}*\\d+${W}+improper${W}+types${W}`)]
];
const EXTRA_KEYS = [
  ['bond', 'extra bond per atom'], ['angle', 'extra angle per atom'],
  ['dihedral', 'extra dihedral per atom'], ['improper', 'extra improper per atom'],
  ['special', 'extra special per atom']
];
const BOX_KEYS = [
  ['x', 2, rx(`${W}*${F}+${W}+${F}+${W}+xlo${W}+xhi${W}`)],
  ['y', 2, rx(`${W}*${F}+${W}+${F}+${W}+ylo${W}+yhi${W}`)],
  ['z', 2, rx(`${W}*${F}+${W}+${F}+${W}+zlo${W}+zhi${W}`)],
  ['tilt', 3, rx(`${W}*${F}+${W}+${F}+${W}+${F}+${W}+xy${W}+xz${W}+yz${W}`)],
  ['avec', 3, rx(`${W}*${F}+${W}+${F}+${W}+${F}+${W}+avec${W}`)],
  ['bvec', 3, rx(`${W}*${F}+${W}+${F}+${W}+${F}+${W}+bvec${W}`)],
  ['cvec', 3, rx(`${W}*${F}+${W}+${F}+${W}+${F}+${W}+cvec${W}`)],
  ['origin', 3, rx(`${W}*${F}+${W}+${F}+${W}+${F}+${W}+abc${W}+origin${W}`)]
];

/* The sections LAMMPS knows (UreyBradley Coeffs is read, but only after the
   first section: the check on the first section name leaves it out). */
const SECTIONS = new Set([
  'Atoms', 'Velocities', 'Ellipsoids', 'Lines', 'Triangles', 'Bodies',
  'Bonds', 'Angles', 'Dihedrals', 'Impropers',
  'Masses', 'Pair Coeffs', 'PairIJ Coeffs', 'Bond Coeffs', 'Angle Coeffs',
  'Dihedral Coeffs', 'Improper Coeffs',
  'BondBond Coeffs', 'BondAngle Coeffs', 'MiddleBondTorsion Coeffs',
  'EndBondTorsion Coeffs', 'AngleTorsion Coeffs',
  'AngleAngleTorsion Coeffs', 'BondBond13 Coeffs', 'AngleAngle Coeffs',
  'Atom Type Labels', 'Bond Type Labels', 'Angle Type Labels',
  'Dihedral Type Labels', 'Improper Type Labels'
]);

/* Coefficient sections: which type they are indexed by, and the key in
   `coefficients`. */
const COEFF_SECTIONS = {
  'Pair Coeffs': ['atom', 'pair'], 'PairIJ Coeffs': ['atom', 'pairIJ'],
  'Bond Coeffs': ['bond', 'bond'], 'Angle Coeffs': ['angle', 'angle'],
  'Dihedral Coeffs': ['dihedral', 'dihedral'], 'Improper Coeffs': ['improper', 'improper'],
  'BondBond Coeffs': ['angle', 'bondBond'], 'BondAngle Coeffs': ['angle', 'bondAngle'],
  'UreyBradley Coeffs': ['angle', 'ureyBradley'],
  'MiddleBondTorsion Coeffs': ['dihedral', 'middleBondTorsion'],
  'EndBondTorsion Coeffs': ['dihedral', 'endBondTorsion'],
  'AngleTorsion Coeffs': ['dihedral', 'angleTorsion'],
  'AngleAngleTorsion Coeffs': ['dihedral', 'angleAngleTorsion'],
  'BondBond13 Coeffs': ['dihedral', 'bondBond13'], 'AngleAngle Coeffs': ['improper', 'angleAngle']
};
const TOPO_OF = { bond: 1, angle: 2, dihedral: 3, improper: 4 };
const LABEL_SECTIONS = {
  'Atom Type Labels': 'atom', 'Bond Type Labels': 'bond', 'Angle Type Labels': 'angle',
  'Dihedral Type Labels': 'dihedral', 'Improper Type Labels': 'improper'
};
/* The header line fix cmap reads: "16 crossterms" or "16 cmap crossterms". */
const CMAP_HEADER = /^[ \t\n\v\f\r]*(\d+)[ \t\n\v\f\r]+(?:cmap[ \t\n\v\f\r]+)?crossterms[ \t\n\v\f\r]/;
const TOPO_SECTIONS = { Bonds: ['bond', 2], Angles: ['angle', 3], Dihedrals: ['dihedral', 4], Impropers: ['improper', 4] };
const BONUS = { Ellipsoids: ['ellipsoid', 'ellipsoids', 8], Lines: ['line', 'lines', 5], Triangles: ['tri', 'triangles', 10] };

/* ------------------------------------------------------------------ *
 * Atom style from the file
 * ------------------------------------------------------------------ */

/* Find the Atoms section without reading the file: its '# style' comment
   and a sample of its lines. */
function scanAtoms(text) {
  const re = /^[ \t\r]*Atoms[ \t\r]*(?:#([^\n]*))?$/m;
  const m = re.exec(text);
  if (!m) return null;
  const hint = (m[1] || '').trim();
  let pos = m.index + m[0].length + 1;
  pos = text.indexOf('\n', pos);          // the skipped line
  if (pos < 0) return { hint, lines: [] };
  pos++;
  const lines = [];
  while (lines.length < 2000 && pos < text.length) {
    let e = text.indexOf('\n', pos);
    if (e < 0) e = text.length;
    const line = text.slice(pos, e);
    pos = e + 1;
    const body = line.replace(/#.*/, '').trim();
    if (!body) { if (lines.length) break; continue; }
    if (/^[A-Za-z]/.test(body) && /^[A-Z][A-Za-z0-9 ]*$/.test(body)) break;
    lines.push(body.split(/[ \t\r\f]+/));
  }
  return { hint, lines };
}

const isInt = (s) => /^[+-]?\d+$/.test(s);
const isNum = (s) => /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s);

/*
 * Atom styles whose columns fit the sampled Atoms lines, best first. Only
 * the common styles are considered; any other must be named.
 */
function inferAtomStyle(sample, header) {
  const lines = sample.lines;
  if (!lines.length) return { style: null, candidates: [], images: false };
  const ncol = lines[0].length;
  const ntypes = header.types.atom || Infinity;
  const allLines = (f) => lines.every(f);
  const col = (k, test) => allLines(w => w.length > k && test(w[k]));
  const typeOk = (s) => (isInt(s) ? +s >= 1 && +s <= ntypes : /^[A-Za-z_]/.test(s));
  const imagesPossible = ncol >= 8 && allLines(w => w.length === ncol &&
    isInt(w[ncol - 1]) && isInt(w[ncol - 2]) && isInt(w[ncol - 3]));
  const topo = header.counts.bonds || header.counts.angles || header.counts.dihedrals ||
    header.counts.impropers || header.types.bond || header.types.angle ||
    header.types.dihedral || header.types.improper;
  const found = [];
  const consider = (name, images, score) => {
    const st = resolveAtomStyle(name);
    if (st.size + (images ? 3 : 0) !== ncol) return;
    const c = st.cols;
    if (!col(c.id, isInt) || !col(c.type, typeOk)) return;
    for (let k = 0; k < 3; k++) if (!col(c.x + k, isNum)) return;
    if (c.molecule !== undefined && !col(c.molecule, isInt)) return;
    if (c.q !== undefined && !col(c.q, isNum)) return;
    if (c.radius !== undefined && !col(c.radius, s => isNum(s) && +s >= 0)) return;
    if (c.rmass !== undefined && !col(c.rmass, s => isNum(s) && +s > 0)) return;
    if (c.ellipsoid !== undefined && !col(c.ellipsoid, s => s === '0' || s === '1')) return;
    if (c.mu3 !== undefined && !col(c.mu3, isNum)) return;
    if (topo && !(st.topo >= (header.counts.impropers || header.types.improper ? 4
      : header.counts.dihedrals || header.types.dihedral ? 3
        : header.counts.angles || header.types.angle ? 2 : 1))) return;
    if (header.counts.ellipsoids && name !== 'ellipsoid') return;
    found.push({ style: name, images, score });
  };
  for (const images of imagesPossible ? [true, false] : [false]) {
    consider('atomic', images, 10);
    consider('charge', images, 8);
    // Molecular styles in order of the topology they allow; the smallest
    // that holds the file's topology is what a user would write.
    consider('full', images, 9);
    consider('molecular', images, 6);
    consider('angle', images, 6.5);
    consider('bond', images, 7);
    consider('sphere', images, 5);
    consider('ellipsoid', images, 4);
    consider('dipole', images, 3);
  }
  // Prefer image flags when the last three columns are whole numbers: a
  // style needing three more whole-number columns is rarer.
  found.sort((a, b) => (b.images - a.images) || (b.score - a.score));
  // charge (id type q) and the bond-molecular family (id mol type) both
  // take six columns: a third column with a fraction is a charge; a
  // second column beyond the number of types is a molecule ID.
  const has = (s) => found.some(f => f.style === s);
  const pickOrder = [];
  if (has('charge') && (has('bond') || has('angle') || has('molecular'))) {
    const c3 = lines.map(w => w[2]);
    const c2 = lines.map(w => w[1]);
    // Whole numbers all above zero in the third column would be a large net
    // charge; as atom types they are ordinary.
    const typesLike = c3.every(s => isInt(s) && +s >= 1 && +s <= ntypes);
    const mol = topo || c2.some(s => isInt(s) && +s > ntypes) || typesLike;
    const q = c3.some(s => !isInt(s));
    if (mol && !q) pickOrder.push('bond', 'angle', 'molecular');
    else pickOrder.push('charge');
  }
  if (has('full') && has('sphere')) {
    // full is id mol type q, sphere id type diameter density: a fraction in
    // the third column is a diameter; a fourth column that is positive on
    // every line is a density (charges that are all positive are rare).
    const c3 = lines.map(w => w[2]);
    const c4 = lines.map(w => w[3]);
    if (topo || (c3.every(isInt) && !c4.every(s => +s > 0))) pickOrder.push('full');
    else pickOrder.push('sphere');
  }
  // With topology, the smallest molecular style that holds it.
  if (topo) {
    const need = header.counts.impropers || header.types.improper ? 4
      : header.counts.dihedrals || header.types.dihedral ? 3
        : header.counts.angles || header.types.angle ? 2 : 1;
    const fam = need >= 3 ? 'molecular' : need === 2 ? 'angle' : 'bond';
    if (has(fam) && !pickOrder.length) pickOrder.push(fam);
  }
  for (const p of pickOrder.reverse()) {
    const i = found.findIndex(f => f.style === p);
    if (i > 0) found.unshift(found.splice(i, 1)[0]);
  }
  // Without topology, bond/angle/molecular read the same as each other.
  const names = [...new Set(found.map(f => f.style))];
  return { style: found.length ? found[0].style : null, candidates: names, images: found.length ? found[0].images : false };
}

/* ------------------------------------------------------------------ *
 * The reader
 * ------------------------------------------------------------------ */

/**
 * Read a LAMMPS data file the way `read_data` does.
 *
 * @param {string} text - The file.
 * @param {object} [options]
 * @param {string} [options.atomStyle] - The input script's atom_style
 *   (`full`, `hybrid full sphere`, `tdpd 2`). When absent, the `# style`
 *   comment on the Atoms line is used, else the style is worked out from
 *   the columns (and `atomStyleSource` says so; an ambiguous case is a note).
 * @param {number} [options.dimension=3]
 * @param {string} [options.boundary='p p p'] - As the `boundary` command
 *   takes it; atoms outside the box in a non-periodic direction are lost.
 * @param {Array<{header?:string|null, section:string}>} [options.fixes] -
 *   The `fix` keywords of read_data: header lines containing `header` and
 *   sections called `section` are the fix's (one line per atom, or the
 *   count its header line gives).
 * @param {{atom?:number, bond?:number, angle?:number, dihedral?:number,
 *   improper?:number}} [options.extraTypes] - read_data's extra/X/types.
 * @param {number} [options.maxIssuesPerKind=5] - Repeats of one problem
 *   beyond this are counted, not listed.
 * @returns {object} `{title, unitsHint, counts, types, extra, box, masses,
 *   labels, sections, sectionInfo, coefficients, atomStyle,
 *   atomStyleSource, atomStyleCandidates, columns, imageFlags, atoms,
 *   velocities, bonds, angles, dihedrals, impropers, crossterms, cmap,
 *   maxAtomId, issues, ok}`. CHARMM CMAP crossterms (a `N crossterms`
 *   header line and a CMAP section) are read even without `fixes`:
 *   `cmap` is then `{count, needsFix: true}` and a warning says which
 *   fix cmap and read_data lines the input needs.
 *   `atoms` holds typed arrays: `id`, `type`, `mol` (or null), `q` (or
 *   null), `x` (x, y, z per atom), `image` (or null), `rmass` (per-atom
 *   masses, or null) and `line` (file line of each atom); `bonds` etc. hold
 *   `type` and `atoms` (atom IDs, 2 to 4 per entry) and `line`. Issues are
 *   `{line, severity: 'error'|'warning'|'note', message, url}`; an error is
 *   something LAMMPS stops on.
 */
export function parseDataFile(text, options = {}) {
  text = String(text ?? '');
  const {
    dimension = 3, boundary = 'p p p', fixes = [], extraTypes = {}, maxIssuesPerKind = 5
  } = options;
  const issues = [];
  const kindCount = new Map();
  const issue = (line, severity, message, kind = null, url = READ_DATA_URL) => {
    if (kind) {
      const n = (kindCount.get(kind) || 0) + 1;
      kindCount.set(kind, n);
      if (n > maxIssuesPerKind) return;
    }
    issues.push({ line, severity, message, url });
  };
  const error = (line, message, kind) => issue(line, 'error', message, kind);
  const warn = (line, message, kind) => issue(line, 'warning', message, kind);
  const note = (line, message, kind) => issue(line, 'note', message, kind);

  const periodic = parseBoundary(boundary);
  const R = new LineReader(text);
  let atoms = null;
  const t = text;

  const result = {
    title: '',
    unitsHint: null,
    counts: { atoms: 0, bonds: 0, angles: 0, dihedrals: 0, impropers: 0, ellipsoids: 0, lines: 0, triangles: 0, bodies: 0, crossterms: 0 },
    types: { atom: 0, bond: 0, angle: 0, dihedral: 0, improper: 0 },
    extra: { bond: 0, angle: 0, dihedral: 0, improper: 0, special: 0 },
    box: null,
    masses: [],
    labels: { atom: null, bond: null, angle: null, dihedral: null, improper: null },
    sections: [],
    sectionInfo: [],
    coefficients: {},
    atomStyle: null,
    atomStyleSource: null,
    atomStyleCandidates: [],
    columns: [],
    imageFlags: false,
    atoms: emptyAtoms(),
    velocities: null,
    bonds: emptyTopo(2),
    angles: emptyTopo(3),
    dihedrals: emptyTopo(4),
    impropers: emptyTopo(4),
    crossterms: emptyTopo(5),
    cmap: null,
    maxAtomId: 0,
    issues,
    ok: true
  };
  atoms = result.atoms;

  /* ---- title ---- */
  if (!R.next()) {
    error(1, 'The file is empty; LAMMPS stops at its first line ("Unexpected end of data file").');
    return finish(result, kindCount, maxIssuesPerKind);
  }
  result.title = R.str().replace(/\r$/, '').trim();
  const um = /units = (\w+)/.exec(R.str());
  if (um) result.unitsHint = um[1];

  /* ---- header ---- */
  const fixHeaders = fixes.filter(f => f && f.header && f.header !== 'NULL');
  const fixCounts = new Map();
  const counts = result.counts;
  const types = result.types;
  const flags = { x: false, y: false, z: false, tilt: false, avec: false, bvec: false, cvec: false, origin: false };
  const lo = [-0.5, -0.5, -0.5];
  const hi = [0.5, 0.5, 0.5];
  const tilt = [0, 0, 0];
  const avec = [1, 0, 0];
  const bvec = [0, 1, 0];
  const cvec = [0, 0, 1];
  const origin = [0, 0, dimension === 2 ? -0.5 : 0];
  const headerLines = {};
  let cmapAuto = false;
  let fatal = false;
  let endLine = null;        // the line that ended the header (null at EOF)
  let endLineNo = 0;
  let endRaw = '';

  while (R.next()) {
    const raw = R.str();
    const hash = raw.indexOf('#');
    const line = hash >= 0 ? raw.slice(0, hash) : `${raw}\n`;
    if (/^[ \t\n\r]*$/.test(line)) continue;
    const fixed = fixHeaders.find(f => line.includes(f.header));
    if (fixed) {
      const m = /^\s*(\d+)/.exec(line);
      if (m) fixCounts.set(fixed, +m[1]);
      if (m && CMAP_HEADER.test(line)) { counts.crossterms = +m[1]; headerLines.crossterms = R.no; }
      continue;
    }
    // CHARMM's CMAP crossterms belong to fix cmap: without it LAMMPS stops
    // here, but the file is fine, so read on and say what the input needs.
    const cm = CMAP_HEADER.exec(line);
    if (cm) {
      counts.crossterms = +cm[1];
      headerLines.crossterms = R.no;
      cmapAuto = true;
      continue;
    }
    const w = line.trim().split(/[ \t\n\v\f\r]+/);
    let matched = false;
    for (const [key, re] of COUNT_KEYS) {
      if (re.test(line)) {
        const v = bigAt(w[0]);
        if (Number.isNaN(v)) { error(R.no, `"${w[0]}" is too big for a count.`); fatal = true; }
        counts[key] = v;
        headerLines[key] = R.no;
        matched = true;
        break;
      }
    }
    if (!matched) {
      for (const [key, re] of TYPE_KEYS) {
        if (re.test(line)) {
          const v = intAt(w[0], 0, w[0].length);
          if (Number.isNaN(v)) { error(R.no, `"${w[0]}" is not a number of ${key} types LAMMPS can read.`); fatal = true; }
          types[key] = v;
          headerLines[`${key} types`] = R.no;
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      for (const [key, phrase] of EXTRA_KEYS) {
        if (line.includes(phrase)) {
          const v = intAt(w[0], 0, w[0].length);
          if (Number.isNaN(v)) { error(R.no, `"${w[0]}" should be the number of ${phrase}.`); fatal = true; }
          result.extra[key] = Math.max(result.extra[key], v || 0);
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      for (const [key, n, re] of BOX_KEYS) {
        if (re.test(line)) {
          const vals = w.slice(0, n).map(s => numberAt(s, 0, s.length));
          const bad = vals.findIndex(v => Number.isNaN(v));
          if (bad >= 0) { error(R.no, `"${w[bad]}" is not a number LAMMPS can read.`); fatal = true; }
          flags[key] = true;
          if (key === 'x' || key === 'y' || key === 'z') {
            const d = 'xyz'.indexOf(key);
            lo[d] = vals[0]; hi[d] = vals[1];
          } else {
            const dest = { tilt, avec, bvec, cvec, origin }[key];
            dest[0] = vals[0]; dest[1] = vals[1]; dest[2] = vals[2];
          }
          headerLines[key] = R.no;
          matched = true;
          break;
        }
      }
    }
    if (!matched) { endLine = line; endLineNo = R.no; endRaw = raw; break; }
  }
  if (fatal) return finish(result, kindCount, maxIssuesPerKind);

  /* ---- atom style ---- */
  const sample = scanAtoms(text);
  let style = null;
  if (options.atomStyle) {
    style = resolveAtomStyle(options.atomStyle);
    if (!style) {
      error(null, `atom_style ${options.atomStyle} is not an atom style of LAMMPS 29 Aug 2024.`);
      return finish(result, kindCount, maxIssuesPerKind);
    }
    result.atomStyleSource = 'option';
  } else if (sample && sample.hint && hintStyle(sample.hint)) {
    style = resolveAtomStyle(hintStyle(sample.hint));
    result.atomStyleSource = 'hint';
  } else if (sample) {
    const inf = inferAtomStyle(sample, result);
    result.atomStyleCandidates = inf.candidates;
    if (inf.style) {
      style = resolveAtomStyle(inf.style);
      result.atomStyleSource = 'columns';
    }
  }
  if (!style && counts.atoms > 0 && sample && sample.lines.length) {
    error(null, 'The Atoms lines fit no common atom style; give the atom_style of the input script ' +
      'to read them.');
  }
  if (!style) style = resolveAtomStyle('atomic');
  result.atomStyle = style.spec;
  result.columns = style.fields.flatMap(f => (f === 'cc'
    ? Array.from({ length: style.widths.cc }, (_, k) => `cc${k + 1}`) : FIELD_NAMES[f] || [f]));
  if (result.atomStyleSource === 'columns') {
    const others = result.atomStyleCandidates.filter(c => c !== style.name);
    note(null, `The Atoms section has no "# style" comment; its ${sample.lines[0].length} columns ` +
      `read as atom_style ${style.name}` + (others.length
      ? ` (they also fit ${others.join(', ')}: set the style if that is not it).`
      : '.'));
  }
  if (!style.known) {
    warn(null, 'The Atoms section says "# hybrid" but not which sub-styles: STEMKit read atom IDs, ' +
      'types and positions only. Give the full atom_style (hybrid full sphere, say) to read charges, ' +
      'molecules and masses.');
  }
  if (sample && sample.hint && result.atomStyleSource === 'option') {
    const hintName = sample.hint.split(/\s+/)[0];
    if (!styleMatch(sample.hint, style.name) && resolveAtomStyle(hintName)) {
      warn(null, `The Atoms section says "# ${sample.hint}" but atom_style is ${style.spec}: ` +
        'LAMMPS warns and reads the columns as the atom style says.');
    }
  }

  // Header checks that need the style (the ellipsoids, lines, ... counts are
  // checked as they are read).
  const bonusOk = (b) => style.bonus.includes(b) || !style.known;
  for (const [key, bonus] of [['ellipsoids', 'ellipsoid'], ['lines', 'line'], ['triangles', 'tri'], ['bodies', 'body']]) {
    if (headerLines[key] !== undefined && !bonusOk(bonus)) {
      error(headerLines[key], `"${key}" in the header needs atom_style ${bonus}; LAMMPS stops ` +
        `("No ${key} allowed with this atom style").`);
      return finish(result, kindCount, maxIssuesPerKind);
    }
  }

  // Box consistency.
  const general = flags.avec || flags.bvec || flags.cvec || flags.origin;
  if (general && (flags.x || flags.y || flags.z || flags.tilt)) {
    error(headerLines.avec || headerLines.bvec || headerLines.cvec || headerLines.origin,
      'The header gives both xlo/xhi-style bounds and avec/bvec/cvec vectors; LAMMPS takes one or the other.');
    return finish(result, kindCount, maxIssuesPerKind);
  }
  if (dimension === 2) {
    if (!general && (lo[2] >= 0 || hi[2] <= 0)) {
      error(headerLines.z, 'In 2d, zlo and zhi must straddle 0.');
      return finish(result, kindCount, maxIssuesPerKind);
    }
  }
  const box = makeBox({ general, tilt: flags.tilt, lo, hi, tiltv: tilt, avec, bvec, cvec, origin });
  if (box.error) {
    error(headerLines.avec || headerLines.x, box.error);
    return finish(result, kindCount, maxIssuesPerKind);
  }
  result.box = box;
  if (!(flags.x && flags.y && (flags.z || dimension === 2)) && !general && counts.atoms > 0) {
    warn(null, `The header does not give all of xlo xhi, ylo yhi and zlo zhi; LAMMPS takes -0.5 to 0.5 ` +
      'for the missing ones.');
  }
  if (box.triclinic && !general) {
    const ly = box.yhi - box.ylo;
    const lz = box.zhi - box.zlo;
    if ((Math.abs(box.xy / ly) > 0.5 && periodic[1]) ||
        ((Math.abs(box.xz) + Math.abs(box.yz)) / lz > 0.5 && periodic[2])) {
      warn(headerLines.tilt, 'The box is tilted by more than half its length; LAMMPS runs, but slowly ' +
        '("Triclinic box skew is large").');
    }
  }
  if (result.unitsHint && options.units && result.unitsHint !== options.units) {
    warn(1, `The title says units = ${result.unitsHint}, the input script ${options.units}.`);
  }

  // Header limits that depend on the style.
  const limits = {
    atom: types.atom + (extraTypes.atom || 0), bond: types.bond + (extraTypes.bond || 0),
    angle: types.angle + (extraTypes.angle || 0), dihedral: types.dihedral + (extraTypes.dihedral || 0),
    improper: types.improper + (extraTypes.improper || 0)
  };

  const state = {
    atomflag: false, bondflag: false, angleflag: false, dihedralflag: false, improperflag: false,
    settype: false, masses: null, labels: {}, bonusSeen: {}, idMap: null
  };
  const masses = new Float64Array(limits.atom + 1).fill(NaN);
  const massNames = new Array(limits.atom + 1).fill('');
  state.masses = masses;

  if (endLine === null) {
    // End of file inside the header: LAMMPS returns without looking for a
    // section, and without the checks that follow the header.
    if (counts.atoms > 0) {
      warn(null, `The header says ${counts.atoms} atoms but the file ends before any section. LAMMPS ` +
        'accepts it and makes an empty box; the atoms are not there.');
    }
    return finalise();
  }

  // Header checks LAMMPS makes once the header is read.
  let key = keywordOf(endLine);
  let keyStyle = hintOf(endRaw);
  let keyLine = endLineNo;
  // The line after a section name is skipped; at the end of the file there
  // is no section.
  if (!R.next()) key = '';
  if (!SECTIONS.has(key)) {
    unknownSection(key, keyLine);
    return finish(result, kindCount, maxIssuesPerKind);
  }
  const topoNames = ['bond', 'angle', 'dihedral', 'improper'];
  for (let k = 0; k < 4; k++) {
    const nm = topoNames[k];
    const n = counts[`${nm}s`];
    if ((n || limits[nm]) && style.topo <= k) {
      error(headerLines[`${nm}s`] || headerLines[`${nm} types`], `The header lists ${nm}s but atom_style ` +
        `${style.spec} has none; LAMMPS stops ("No ${nm}s allowed with this atom style"). ` +
        `Use a style with ${nm}s (${k === 0 ? 'bond, ' : k === 1 ? 'angle, ' : ''}molecular or full).`);
      return finish(result, kindCount, maxIssuesPerKind);
    }
    if (n > 0 && limits[nm] <= 0) {
      error(headerLines[`${nm}s`], `The header lists ${n} ${nm}s but no ${nm} types; LAMMPS stops.`);
      return finish(result, kindCount, maxIssuesPerKind);
    }
  }
  if (style.molecular === 2 && (counts.bonds || counts.angles || counts.dihedrals || counts.impropers)) {
    error(null, 'atom_style template takes its bonds from the molecule template, not from the data file.');
    return finish(result, kindCount, maxIssuesPerKind);
  }

  /* ---- sections ---- */
  const idMapOf = () => state.idMap;

  while (key) {
    const sectionLine = keyLine;
    const info = { name: key, line: sectionLine, style: keyStyle || null, lines: 0 };
    result.sectionInfo.push(info);
    if (!result.sections.includes(key)) result.sections.push(key);
    let ok = true;
    if (key === 'Atoms') ok = readAtoms(info);
    else if (key === 'Velocities') ok = readVelocities(info);
    else if (TOPO_SECTIONS[key]) ok = readTopology(info, ...TOPO_SECTIONS[key]);
    else if (BONUS[key]) ok = readBonus(info, ...BONUS[key]);
    else if (key === 'Bodies') ok = readBodies(info);
    else if (key === 'Masses') ok = readMasses(info);
    else if (COEFF_SECTIONS[key]) ok = readCoeffs(info, ...COEFF_SECTIONS[key]);
    else if (LABEL_SECTIONS[key]) ok = readLabels(info, LABEL_SECTIONS[key]);
    else if (key === 'CMAP' && (cmapAuto || fixes.some(f => f && f.section === 'CMAP'))) {
      const fix = fixes.find(f => f && f.section === 'CMAP');
      ok = readCmap(info, fix && fixCounts.has(fix) ? fixCounts.get(fix) : counts.crossterms);
    } else {
      const fix = fixes.find(f => f && (f.section === key));
      if (fix) {
        const n = fixCounts.has(fix) ? fixCounts.get(fix) : counts.atoms;
        info.lines = n;
        if (!skipLines(n)) { eof(key); ok = false; }
      } else {
        unknownSection(key, sectionLine);
        ok = false;
      }
    }
    if (!ok) return finish(result, kindCount, maxIssuesPerKind);
    // Next section name: skip blank and comment lines, then the name, then
    // one more line, whatever it holds.
    key = '';
    while (R.next()) {
      const raw = R.str();
      if (/^[ \t\n\r]*(#|$)/.test(raw)) continue;
      keyLine = R.no;
      keyStyle = hintOf(raw);
      const k = keywordOf(raw.includes('#') ? raw.slice(0, raw.indexOf('#')) : raw);
      if (R.next()) key = k;
      break;
    }
  }

  if (counts.atoms > 0 && !state.atomflag) {
    error(null, `The header says ${counts.atoms} atoms but there is no Atoms section; LAMMPS stops ` +
      '("No valid atoms found in data file").');
  }
  for (const [nm, flag] of [['bonds', 'bondflag'], ['angles', 'angleflag'], ['dihedrals', 'dihedralflag'], ['impropers', 'improperflag']]) {
    if (counts[nm] && !state[flag]) {
      const sec = nm[0].toUpperCase() + nm.slice(1);
      error(headerLines[nm], `The header says ${counts[nm]} ${nm} but there is no ${sec} section; LAMMPS stops.`);
    }
  }
  if (counts.crossterms && !state.bonusSeen.CMAP) {
    warn(headerLines.crossterms, `The header says ${counts.crossterms} crossterms but there is no CMAP section.`);
  }
  if (cmapAuto) {
    result.cmap = { count: counts.crossterms, needsFix: true };
    issues.push({
      line: headerLines.crossterms, severity: 'warning', url: docUrl('fix_cmap'),
      message: `The file has ${counts.crossterms} CHARMM CMAP crossterms, which LAMMPS reads only through fix cmap. ` +
        'Put "fix cmap all cmap charmm36.cmap" (the CMAP file of your force field) and "fix_modify cmap energy yes" ' +
        'before read_data, and read the file with "read_data <file> fix cmap crossterm CMAP"; a plain ' +
        'read_data stops at the crossterms line ("Unknown identifier in data file").'
    });
  } else if (counts.crossterms) {
    result.cmap = { count: counts.crossterms, needsFix: false };
  }
  for (const [nm, sec] of [['ellipsoids', 'Ellipsoids'], ['lines', 'Lines'], ['triangles', 'Triangles'], ['bodies', 'Bodies']]) {
    if (counts[nm] && !state.bonusSeen[sec]) {
      error(headerLines[nm], `The header says ${counts[nm]} ${nm} but there is no ${sec} section; LAMMPS stops.`);
    }
  }
  return finalise();

  /* ---------------- helpers of the reader ---------------- */

  function finalise() {
    for (let ty = 1; ty <= limits.atom; ty++) {
      result.masses.push({
        type: ty,
        mass: Number.isNaN(masses[ty]) ? null : masses[ty],
        label: state.labels.atom ? state.labels.atom[ty] || null : null,
        name: massNames[ty] || null,
        element: null
      });
    }
    for (const k of Object.keys(result.labels)) result.labels[k] = state.labels[k] || null;
    for (const m of result.masses) {
      if (m.mass === null) continue;
      m.element = guessElement(m.mass, { name: m.name || m.label, units: options.units || result.unitsHint }).element;
    }
    if (atoms.q && atoms.n) {
      let q = 0;
      for (let i = 0; i < atoms.n; i++) q += atoms.q[i];
      if (Math.abs(q) >= 1e-3) {
        warn(null, `The charges add up to ${q.toFixed(4)}, not zero. LAMMPS runs, but Ewald and PPPM then ` +
          'treat the box as having a uniform background charge; check the charges or add counter-ions.');
      }
    }
    if (state.atomflag && style.perType && !style.rmass) {
      const missing = result.masses.filter(m => m.mass === null).map(m => m.type);
      if (missing.length) {
        warn(null, `No mass for atom type${missing.length > 1 ? 's' : ''} ${compressList(missing)}: set ` +
          `${missing.length > 1 ? 'them' : 'it'} with the mass command before the run, or LAMMPS stops ` +
          '("Not all per-type masses are set").');
      }
    }
    return finish(result, kindCount, maxIssuesPerKind);
  }

  function unknownSection(k, line) {
    if (!k) {
      error(line, 'The file ends right after a section name. LAMMPS stops ("Unknown identifier in data file").');
      return;
    }
    const near = nearestSection(k);
    error(line, `"${k}" is not a section LAMMPS knows; it stops here ("Unknown identifier in data file").` +
      (near ? ` Did you mean "${near}"?` : ' A count that is too small for the section before leaves ' +
        'its extra lines here, too.'));
  }

  function eof(sectionName) {
    error(R.no, `The file ends inside the ${sectionName} section: it has fewer lines than the header ` +
      'says. LAMMPS stops ("Unexpected end of data file").');
  }

  function skipLines(n) {
    for (let i = 0; i < n; i++) if (!R.next()) return false;
    return true;
  }

  function lookupLabel(kind, s, e) {
    const map = state.labels[`${kind}Map`];
    if (!map) return -1;
    const v = map.get(t.slice(s, e));
    return v === undefined ? -1 : v;
  }

  /* A type word: a number from 1 to n, or a label defined earlier. */
  function typeOf(kind, s, e, max) {
    const k = typeKind(t, s, e);
    if (k === 0) {
      const v = intAt(t, s, e);
      if (Number.isNaN(v) || v < 1 || v > max) return -1;
      return v;
    }
    if (k === 1) return lookupLabel(kind, s, e);
    return -1;
  }

  function readMasses(info) {
    state.settype = true;
    const n = types.atom;
    for (let i = 0; i < n; i++) {
      if (!R.next()) { eof('Masses'); return false; }
      info.lines++;
      const nt = words(t, R.a, R.b);
      const nw = wordsBeforeComment(t, nt);
      if (!style.perType && style.known) {
        error(R.no, `atom_style ${style.spec} gives each atom its own mass, so the file cannot have a Masses ` +
          'section; LAMMPS stops ("Cannot set mass for atom style").');
        return false;
      }
      if (nw !== 2) {
        error(R.no, nw === 0
          ? `A blank line inside Masses: it needs one line per atom type (${n}), with no gaps.`
          : `A Masses line is "type mass"; this one has ${nw} values.`, 'masses-format');
        return false;
      }
      const ty = typeOf('atom', TS[0], TE[0], limits.atom);
      if (ty < 0) {
        error(R.no, `Atom type "${word(t, 0)}" in Masses is not between 1 and ${limits.atom}` +
          (typeKind(t, TS[0], TE[0]) === 1 ? ' nor a type label defined above' : '') + '.');
        return false;
      }
      const m = numberAt(t, TS[1], TE[1]);
      if (Number.isNaN(m)) { error(R.no, `"${word(t, 1)}" is not a number LAMMPS can read.`); return false; }
      if (m <= 0) { error(R.no, `The mass of type ${ty} must be positive; LAMMPS stops.`); return false; }
      masses[ty] = m;
      if (nw < nt) {
        const c = t.slice(TS[nw], R.b).replace(/^#+/, '').trim();
        if (c) massNames[ty] = c;
      }
    }
    return true;
  }

  function readCoeffs(info, kind, key) {
    const topo = TOPO_OF[kind];
    if (topo && style.known && style.topo < topo) {
      error(info.line, `A ${info.name} section needs ${kind}s, which atom_style ${style.spec} does not have; ` +
        'LAMMPS stops ("Invalid data file section").');
      return false;
    }
    const nt = types[kind];
    const pairIJ = key === 'pairIJ';
    const n = pairIJ ? nt * (nt + 1) / 2 : nt;
    if (!n) return true;
    const rows = result.coefficients[key] || (result.coefficients[key] = []);
    if (!result.coefficients.styles) result.coefficients.styles = {};
    if (info.style) result.coefficients.styles[key] = info.style;
    for (let i = 0; i < n; i++) {
      if (!R.next()) { eof(info.name); return false; }
      info.lines++;
      state.settype = true;
      const nw = words(t, R.a, R.b, true);
      if (nw === 0) {
        error(R.no, `A blank line inside ${info.name}: it needs ${n} lines, one per ` +
          `${pairIJ ? 'pair of atom types' : `${kind} type`}, with no gaps.`);
        return false;
      }
      const nIds = key === 'pair' || pairIJ ? (pairIJ ? 2 : 1) : 1;
      const ids = [];
      for (let k = 0; k < nIds; k++) {
        const v = k < nw ? intAt(t, TS[k], TE[k]) : NaN;
        if (Number.isNaN(v) || v < 1 || v > limits[kind]) {
          error(R.no, k < nw && Number.isNaN(v)
            ? `"${word(t, k)}" in ${info.name} should be a ${kind} type number (type labels are not ` +
              'allowed in coefficient sections).'
            : `${kind[0].toUpperCase() + kind.slice(1)} type ${k < nw ? word(t, k) : '(missing)'} in ` +
              `${info.name} is not between 1 and ${limits[kind]}.`);
          return false;
        }
        ids.push(v);
      }
      if (pairIJ && ids[0] > ids[1]) {
        error(R.no, `PairIJ Coeffs lists each pair once with I <= J; "${ids[0]} ${ids[1]}" has I > J and ` +
          'LAMMPS stops ("Incorrect args for pair coefficients").');
        return false;
      }
      const vals = [];
      for (let k = nIds; k < nw; k++) vals.push(word(t, k));
      rows.push({ line: R.no, types: ids, values: vals });
    }
    return true;
  }

  function readLabels(info, kind) {
    if (kind !== 'atom' && !types[kind]) return true;
    if (kind === 'atom' && state.atomflag) {
      error(info.line, 'Atom Type Labels must come before Atoms; LAMMPS stops.');
      return false;
    }
    const topoFlag = { bond: 'bondflag', angle: 'angleflag', dihedral: 'dihedralflag', improper: 'improperflag' }[kind];
    if (topoFlag && state[topoFlag]) {
      const sec = { bond: 'Bonds', angle: 'Angles', dihedral: 'Dihedrals', improper: 'Impropers' }[kind];
      error(info.line, `${info.name} must come before ${sec}; LAMMPS stops.`);
      return false;
    }
    if (state.settype) {
      error(info.line, `${info.name} must come before Masses and the Coeffs sections; LAMMPS stops ` +
        '("Must read Type Labels before any section involving types").');
      return false;
    }
    const n = types[kind];
    if (!n) return true;
    const labels = new Array(n + 1).fill(null);
    const map = new Map();
    for (let i = 0; i < n; i++) {
      if (!R.next()) { eof(info.name); return false; }
      info.lines++;
      const nt = words(t, R.a, R.b);
      const nw = wordsBeforeComment(t, nt);
      if (nw !== 2) {
        error(R.no, `A ${info.name} line is "type label"; this one has ${nw} values.`);
        return false;
      }
      const label = word(t, 1);
      if (typeKind(t, TS[1], TE[1]) !== 1) {
        error(R.no, `"${label}" is not a valid type label: it may not start with a digit, * or #.`);
        return false;
      }
      const ty = intAt(t, TS[0], TE[0]);
      if (Number.isNaN(ty) || ty < 1 || ty > n) {
        error(R.no, `Type "${word(t, 0)}" in ${info.name} is not between 1 and ${n}.`);
        return false;
      }
      labels[ty] = label;
      map.set(label, ty);
    }
    if (labels.slice(1).some(l => l === null) || map.size !== n) {
      error(info.line, `${info.name} must give every ${kind} type its own label; LAMMPS stops ` +
        '("Type Labels map is incomplete").');
      return false;
    }
    state.labels[kind] = labels;
    state.labels[`${kind}Map`] = map;
    return true;
  }

  function readAtoms(info) {
    if (state.atomflag) {
      error(info.line, 'A second Atoms section: LAMMPS reads it as more atoms than the header says and stops.');
      return false;
    }
    state.atomflag = true;
    const n = counts.atoms;
    const hint = Math.min(n, 1 << 16);
    const id = new Grow(Int32Array, 1, hint);
    const type = new Grow(Int32Array, 1, hint);
    const mol = style.cols.molecule !== undefined ? new Grow(Int32Array, 1, hint) : null;
    const q = style.cols.q !== undefined ? new Grow(Float64Array, 1, hint) : null;
    const x = new Grow(Float64Array, 3, hint);
    const rmass = style.rmass ? new Grow(Float64Array, 1, hint) : null;
    const flag = style.bonus.length ? new Grow(Int8Array, 1, hint) : null;
    const lineNo = new Grow(Int32Array, 1, hint);
    let image = null;
    const fields = style.fields;
    const cols = style.cols;
    const size = style.size;
    const xcol = cols.x;
    const bonusField = ['ellipsoid', 'line', 'tri', 'body'].find(f => cols[f] !== undefined);
    const small = [0, 1, 2].map(d => 1e-4 * box.len[d]);
    const bnd = boundaryKinds(boundary);
    let nwords = 0;
    let imageflag = false;
    let skipped = 0;
    let lost = 0;
    let resetImages = [false, false, false];
    let anyImageCol = false;
    let maxId = 0;
    const lambda = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      if (!R.next()) { eof('Atoms'); return false; }
      info.lines++;
      const nt = words(t, R.a, R.b);
      if (i % 1024 === 0) {
        // LAMMPS decides the column count from the first line of each chunk
        // of 1024 lines.
        nwords = wordsBeforeComment(t, nt);
        if (style.known ? nwords !== size && nwords !== size + 3 : nwords < 5) {
          error(R.no, nwords === 0
            ? 'Atoms lines must not start with a blank or comment line; LAMMPS stops ("Incorrect format in ' +
              'Atoms section").'
            : `This Atoms line has ${nwords} values; atom_style ${style.spec} needs ${size} ` +
              `(${result.columns.join(' ')}), or ${size + 3} with image flags. LAMMPS stops ` +
              '("Incorrect format in Atoms section").' + styleAdvice(nwords));
          return false;
        }
        imageflag = style.known ? nwords > size : false;
        if (imageflag) anyImageCol = true;
      }
      if (nt === 0 || t.charCodeAt(TS[0]) === 35) { skipped++; if (skipped <= 3) blankAtom(R.no); continue; }
      if (nt < nwords || (nt > nwords && t.charCodeAt(TS[nwords]) !== 35)) {
        error(R.no, `This Atoms line has ${wordsBeforeComment(t, nt)} values where the lines before have ` +
          `${nwords}; LAMMPS stops ("Incorrect format in Atoms section").`, 'atoms-format');
        return false;
      }
      let ix = 0; let iy = 0; let iz = 0;
      if (imageflag) {
        const ip = nwords - 3;
        ix = intAt(t, TS[ip], TE[ip]); iy = intAt(t, TS[ip + 1], TE[ip + 1]); iz = intAt(t, TS[ip + 2], TE[ip + 2]);
        if (Number.isNaN(ix) || Number.isNaN(iy) || Number.isNaN(iz)) {
          error(R.no, 'The image flags (the last three values) must be whole numbers.', 'atoms-number');
          return false;
        }
        if (dimension === 2 && iz !== 0) { error(R.no, 'In 2d the z image flag must be 0.'); return false; }
        if (!periodic[0] && ix) { resetImages[0] = true; ix = 0; }
        if (!periodic[1] && iy) { resetImages[1] = true; iy = 0; }
        if (!periodic[2] && iz) { resetImages[2] = true; iz = 0; }
      }
      const px = numberAt(t, TS[xcol], TE[xcol]);
      const py = numberAt(t, TS[xcol + 1], TE[xcol + 1]);
      let pz = numberAt(t, TS[xcol + 2], TE[xcol + 2]);
      if (Number.isNaN(px) || Number.isNaN(py) || Number.isNaN(pz)) {
        const k = Number.isNaN(px) ? xcol : Number.isNaN(py) ? xcol + 1 : xcol + 2;
        error(R.no, `"${word(t, k)}" is not a coordinate LAMMPS can read.`, 'atoms-number');
        return false;
      }
      if (dimension === 2) {
        if (Math.abs(pz) > 1e-12) { error(R.no, 'In 2d every atom needs z = 0.'); return false; }
        pz = 0;
      }
      // Every other field, parsed as its type is.
      let tag = 0; let ty = -1; let mv = 0; let qv = 0; let dens = NaN; let diam = NaN; let fl = 0;
      for (const f of fields) {
        const c = cols[f];
        if (f === 'x') continue;
        if (f === 'type') {
          ty = typeOf('atom', TS[c], TE[c], limits.atom);
          if (ty < 0) {
            const k = typeKind(t, TS[c], TE[c]);
            error(R.no, k === 1 && !state.labels.atomMap
              ? `Atom type "${word(t, c)}" is a label, but no Atom Type Labels section comes before Atoms.`
              : `Atom type ${word(t, c)} is not between 1 and ${limits.atom}` +
                (k === 1 ? ' nor a defined label' : '') + '; LAMMPS stops ("Invalid atom type").', 'atoms-type');
            return false;
          }
          continue;
        }
        const w = style.widths[f];
        for (let k = 0; k < w; k++) {
          const s = TS[c + k]; const e = TE[c + k];
          if (INT_FIELDS.has(f)) {
            const v = intAt(t, s, e);
            if (Number.isNaN(v)) {
              error(R.no, `"${t.slice(s, e)}" (${(FIELD_NAMES[f] || [f])[k] || f}) must be a whole number.`, 'atoms-number');
              return false;
            }
            if (f === 'id') tag = v;
            else if (f === 'molecule') mv = v;
            else if (f === bonusField) fl = v;
          } else {
            const v = numberAt(t, s, e);
            if (Number.isNaN(v)) {
              error(R.no, `"${t.slice(s, e)}" (${(FIELD_NAMES[f] || [f])[k] || f}) is not a number LAMMPS can read.`, 'atoms-number');
              return false;
            }
            if (f === 'q') qv = v;
            else if (f === 'rmass') dens = v;
            else if (f === 'radius') diam = v;
          }
        }
      }
      if (tag <= 0) {
        error(R.no, `Atom ID ${tag} is not allowed: IDs are whole numbers from 1. LAMMPS stops ("Invalid atom ID").`, 'atoms-id');
        return false;
      }
      // Is the atom inside the box in the directions that are not periodic?
      if (!(periodic[0] && periodic[1] && periodic[2])) {
        let inside = true;
        const pos = [px, py, pz];
        const coord = box.triclinic ? toLambda(box, pos, lambda) : pos;
        for (let d = 0; d < 3; d++) {
          if (periodic[d]) continue;
          const lo = box.triclinic ? 0 : box.lo[d];
          const hi = box.triclinic ? 1 : box.hi[d];
          const pad = bnd[d] === 'f' ? 0 : (box.triclinic ? 1e-4 : small[d]);
          if (!(coord[d] >= lo - pad && coord[d] < hi + pad)) inside = false;
        }
        if (!inside) {
          lost++;
          if (lost <= 3) {
            error(R.no, `Atom ${tag} lies outside the box in a direction that is not periodic, so LAMMPS loses ` +
              'it and stops ("Did not assign all atoms correctly"). Enlarge the box or make that direction periodic.');
          }
          continue;
        }
      }
      // Per-atom mass, as the style's data_atom_post works it out.
      let mass = 0;
      if (rmass) {
        if (cols.radius !== undefined) mass = diam > 0 ? dens * 4 * Math.PI / 3 * (diam / 2) ** 3 : dens;
        else if (bonusField === 'line' || bonusField === 'tri') mass = fl === 0 ? dens * 4 * Math.PI / 3 * 0.125 : dens;
        else mass = dens;
        if (!(mass > 0)) {
          error(R.no, `Atom ${tag} has a density (or mass) that is not positive; LAMMPS stops ("Invalid density").`, 'atoms-density');
          return false;
        }
      }
      if (bonusField && fl !== 0 && fl !== 1) {
        error(R.no, `The ${bonusField} flag of atom ${tag} must be 0 or 1.`, 'atoms-flag');
        return false;
      }
      const j = id.reserve();
      id.a[j] = tag;
      type.reserve(); type.a[j] = ty;
      if (mol) { mol.reserve(); mol.a[j] = mv; }
      if (q) { q.reserve(); q.a[j] = qv; }
      if (rmass) { rmass.reserve(); rmass.a[j] = mass; }
      if (flag) { flag.reserve(); flag.a[j] = fl; }
      lineNo.reserve(); lineNo.a[j] = R.no;
      const o = x.reserve();
      x.a[o] = px; x.a[o + 1] = py; x.a[o + 2] = pz;
      if (imageflag && !image) {
        // Image flags from this chunk on: the atoms before it have 0 0 0.
        image = new Grow(Int32Array, 3, hint);
        image.a = growTo(image.a, (j + 1) * 3);
        image.n = j;
      }
      if (image) {
        const p = image.reserve();
        image.a[p] = ix; image.a[p + 1] = iy; image.a[p + 2] = iz;
      }
      if (tag > maxId) maxId = tag;
    }
    for (let d = 0; d < 3; d++) {
      if (resetImages[d]) {
        warn(info.line, `Some atoms have a non-zero ${'xyz'[d]} image flag, but ${'xyz'[d]} is not periodic: ` +
          'LAMMPS sets these flags to 0 and warns.');
      }
    }
    if (skipped > 3) blankAtomMore(skipped - 3);
    const nread = id.n;
    atoms.n = nread;
    atoms.id = id.done();
    atoms.type = type.done();
    atoms.mol = mol ? mol.done() : null;
    atoms.q = q ? q.done() : null;
    atoms.x = x.done();
    atoms.rmass = rmass ? rmass.done() : null;
    atoms.flag = flag ? flag.done() : null;
    atoms.line = lineNo.done();
    atoms.image = image ? image.done() : null;
    result.imageFlags = anyImageCol;
    result.maxAtomId = maxId;
    if (nread + skipped + lost !== n) return false;
    if (nread !== n) {
      error(info.line, `The Atoms section gave ${nread} atoms, the header ${n}: blank or comment lines inside ` +
        'it, or lost atoms, leave some out. LAMMPS stops ("Did not assign all atoms correctly").');
      return false;
    }
    if (maxId >= MAXTAGINT) { error(info.line, 'An atom ID is too big for LAMMPS.'); return false; }
    if (nread && maxId < n) {
      error(info.line, `The largest atom ID is ${maxId} but there are ${n} atoms, so some IDs repeat. LAMMPS ` +
        'stops ("Duplicate atom IDs exist").');
      return false;
    }
    state.idMap = buildIdMap(atoms.id, maxId);
    if (state.idMap.duplicates) {
      warn(info.line, `${state.idMap.duplicates} atom ID${state.idMap.duplicates > 1 ? 's are' : ' is'} used ` +
        `twice (first: ${state.idMap.firstDuplicate}). LAMMPS does not stop, but bonds and velocities then ` +
        'reach only one of the two atoms.');
    }
    // Finite-size particles: the header count must match the flags.
    if (bonusField && bonusField !== 'body') {
      const hdr = { ellipsoid: 'ellipsoids', line: 'lines', tri: 'triangles' }[bonusField];
      let k = 0;
      for (let a = 0; a < nread; a++) if (atoms.flag[a] === 1) k++;
      if (k !== counts[hdr]) {
        error(info.line, `${k} atoms have ${bonusField} flag 1 but the header says ${counts[hdr]} ${hdr}; ` +
          'LAMMPS stops.');
        return false;
      }
    }
    if (bonusField === 'body') {
      let k = 0;
      for (let a = 0; a < nread; a++) if (atoms.flag[a] === 1) k++;
      if (k !== counts.bodies) {
        error(info.line, `${k} atoms have body flag 1 but the header says ${counts.bodies} bodies; LAMMPS stops.`);
        return false;
      }
    }
    return true;
  }

  function blankAtom(line) {
    error(line, 'A blank or comment line inside Atoms: it counts as one of the atom lines, so one atom is ' +
      'missing and LAMMPS stops ("Did not assign all atoms correctly").');
  }

  function blankAtomMore(k) {
    error(null, `${k} more blank or comment lines inside Atoms.`);
  }

  function styleAdvice(nw) {
    if (result.atomStyleSource !== 'option') return '';
    const fits = Object.keys(ATOM_STYLE_TABLE).filter(nm => {
      const st = resolveAtomStyle(nm);
      return st && (st.size === nw || st.size + 3 === nw);
    });
    return fits.length ? ` ${nw} values fit atom_style ${fits.slice(0, 4).join(', ')}.` : '';
  }

  function readVelocities(info) {
    if (!state.atomflag) {
      error(info.line, 'Velocities must come after Atoms; LAMMPS stops.');
      return false;
    }
    const n = counts.atoms;
    const nv = style.velSize;
    const vel = result.velocities || new Float64Array(atoms.n * 3);
    result.velocities = vel;
    const map = idMapOf();
    let gaps = 0;
    for (let i = 0; i < n; i++) {
      if (!R.next()) { eof('Velocities'); return false; }
      info.lines++;
      const nw = words(t, R.a, R.b, true);
      if (nw === 0) continue;
      if (style.known ? nw !== nv : nw < 4) {
        error(R.no, `A Velocities line for atom_style ${style.spec} has ${nv} values ` +
          `(${style.velFields.flatMap(f => FIELD_NAMES[f] || [f]).join(' ')}); this one has ${nw}.`, 'vel-format');
        return false;
      }
      const tag = intAt(t, TS[0], TE[0]);
      if (Number.isNaN(tag)) { error(R.no, `"${word(t, 0)}" (atom-ID) must be a whole number.`, 'vel-number'); return false; }
      if (tag <= 0 || tag > result.maxAtomId) {
        error(R.no, `Velocities names atom ${tag}, but atom IDs go from 1 to ${result.maxAtomId}; LAMMPS stops.`, 'vel-id');
        return false;
      }
      for (let k = 1; k < nw; k++) {
        const v = numberAt(t, TS[k], TE[k]);
        if (Number.isNaN(v)) { error(R.no, `"${word(t, k)}" is not a number LAMMPS can read.`, 'vel-number'); return false; }
      }
      const a = map.get(tag);
      if (a < 0) { gaps++; continue; }
      vel[3 * a] = numberAt(t, TS[1], TE[1]);
      vel[3 * a + 1] = numberAt(t, TS[2], TE[2]);
      vel[3 * a + 2] = numberAt(t, TS[3], TE[3]);
    }
    if (gaps) {
      warn(info.line, `${gaps} Velocities line${gaps > 1 ? 's name atom IDs' : ' names an atom ID'} not in Atoms; ` +
        'LAMMPS ignores them.');
    }
    return true;
  }

  function readTopology(info, kind, width) {
    const plural = `${kind}s`;
    const n = counts[plural];
    const flagName = `${kind}flag`;
    if (n === 0) {
      error(info.line, `A ${info.name} section, but the header gives no ${plural}; LAMMPS stops ("Invalid data file section").`);
      return false;
    }
    if (!state.atomflag) {
      error(info.line, `${info.name} must come after Atoms; LAMMPS stops.`);
      return false;
    }
    if (state[flagName]) {
      error(info.line, `A second ${info.name} section; LAMMPS stops ("${info.name[0].toUpperCase() + kind.slice(1)}s assigned incorrectly").`);
      return false;
    }
    state[flagName] = true;
    const topo = result[plural];
    const hint = Math.min(n, 1 << 16);
    const type = new Grow(Int32Array, 1, hint);
    const ids = new Grow(Int32Array, width, hint);
    const lines = new Grow(Int32Array, 1, hint);
    const map = idMapOf();
    const maxId = result.maxAtomId;
    const home = kind === 'bond' ? 0 : 1;   // the atom LAMMPS stores it with
    let assigned = 0;
    let skipped = 0;
    let homeMissing = 0;
    let otherMissing = 0;
    let firstMissing = null;
    for (let i = 0; i < n; i++) {
      if (!R.next()) { eof(info.name); return false; }
      info.lines++;
      const nt = words(t, R.a, R.b);
      const nw = wordsBeforeComment(t, nt);
      if (nw === 0) { skipped++; if (skipped <= 3) blankTopo(info.name, R.no, kind); continue; }
      if (nw !== width + 2) {
        error(R.no, `A ${info.name} line is "ID type ${Array.from({ length: width }, (_, k) => `atom${k + 1}`).join(' ')}"; ` +
          `this one has ${nw} values. LAMMPS stops ("Incorrect format in ${info.name} section").`, `${kind}-format`);
        return false;
      }
      const ty = typeOf(kind, TS[1], TE[1], limits[kind]);
      const a = [0, 0, 0, 0];
      for (let k = 0; k < width; k++) {
        a[k] = intAt(t, TS[2 + k], TE[2 + k]);
        if (Number.isNaN(a[k])) {
          error(R.no, `"${word(t, 2 + k)}" must be an atom ID (a whole number).`, `${kind}-number`);
          return false;
        }
      }
      if (ty < 0) {
        const k = typeKind(t, TS[1], TE[1]);
        error(R.no, `${kind[0].toUpperCase() + kind.slice(1)} type ${word(t, 1)} is not between 1 and ` +
          `${limits[kind]}${k === 1 ? ' nor a defined label' : ''}; LAMMPS stops ("Invalid ${kind} type").`, `${kind}-type`);
        return false;
      }
      let bad = false;
      for (let k = 0; k < width; k++) {
        if (a[k] <= 0 || a[k] > maxId) bad = true;
        for (let m = 0; m < k; m++) if (a[m] === a[k]) bad = true;
      }
      if (bad) {
        error(R.no, `${info.name.slice(0, -1)} ${word(t, 0)} names atom IDs ${a.slice(0, width).join(' ')}: each must ` +
          `be between 1 and ${maxId} and all different. LAMMPS stops ("Invalid atom ID in ${info.name} section").`, `${kind}-id`);
        return false;
      }
      for (let k = 0; k < width; k++) {
        if (map.get(a[k]) < 0) {
          if (!firstMissing) firstMissing = { line: R.no, id: a[k] };
          if (k === home) homeMissing++;
          else otherMissing++;
        }
      }
      if (map.get(a[home]) >= 0) assigned++;
      const j = type.reserve();
      type.a[j] = ty;
      const o = ids.reserve();
      for (let k = 0; k < width; k++) ids.a[o + k] = a[k];
      lines.reserve(); lines.a[j] = R.no;
    }
    if (skipped > 3) error(null, `${skipped - 3} more blank or comment lines inside ${info.name}.`);
    topo.n = type.n;
    topo.type = type.done();
    topo.atoms = ids.done();
    topo.line = lines.done();
    if (homeMissing + otherMissing) {
      const what = homeMissing ? `LAMMPS stops ("${kind[0].toUpperCase() + kind.slice(1)}s assigned incorrectly")`
        : kind === 'bond' ? 'LAMMPS crashes while it builds the lists of bonded neighbours'
          : `LAMMPS stops when the run starts ("${kind[0].toUpperCase() + kind.slice(1)} atoms missing")`;
      error(firstMissing.line, `${homeMissing + otherMissing} ${plural} name atoms that are not in the Atoms ` +
        `section (the first: atom ${firstMissing.id}); ${what}.`);
      return false;
    }
    if (assigned !== n) {
      if (!skipped) error(info.line, `${info.name} has ${assigned} ${plural}, the header ${n}; LAMMPS stops.`);
      return false;
    }
    return true;
  }

  function blankTopo(name, line, kind) {
    error(line, `A blank or comment line inside ${name}: it counts as one of the lines, so one ${kind} is ` +
      `missing and LAMMPS stops ("${kind[0].toUpperCase() + kind.slice(1)}s assigned incorrectly").`);
  }

  function readBonus(info, field, header, width) {
    if (!bonusOk(field)) {
      error(info.line, `A ${info.name} section needs atom_style ${field === 'tri' ? 'tri' : field}; LAMMPS stops ` +
        '("Invalid data file section").');
      return false;
    }
    if (!state.atomflag) {
      error(info.line, `${info.name} must come after Atoms; LAMMPS stops.`);
      return false;
    }
    state.bonusSeen[info.name] = true;
    const n = counts[header];
    const map = idMapOf();
    const seen = new Set();
    for (let i = 0; i < n; i++) {
      if (!R.next()) { eof(info.name); return false; }
      info.lines++;
      const nw = words(t, R.a, R.b, true);
      if (nw === 0) continue;
      if (nw !== width) {
        error(R.no, `A ${info.name} line has ${width} values; this one has ${nw}. LAMMPS stops.`, `${field}-format`);
        return false;
      }
      const tag = intAt(t, TS[0], TE[0]);
      if (Number.isNaN(tag) || tag <= 0 || tag > result.maxAtomId) {
        error(R.no, `"${word(t, 0)}" is not an atom ID from 1 to ${result.maxAtomId}; LAMMPS stops.`, `${field}-id`);
        return false;
      }
      const v = [];
      for (let k = 1; k < nw; k++) {
        const x = numberAt(t, TS[k], TE[k]);
        if (Number.isNaN(x)) { error(R.no, `"${word(t, k)}" is not a number LAMMPS can read.`, `${field}-number`); return false; }
        v.push(x);
      }
      const a = map.get(tag);
      if (a < 0) continue;
      if (!style.known) continue;
      if (atoms.flag[a] !== 1 || seen.has(a)) {
        error(R.no, `Atom ${tag} is not a finite-size ${field} (its flag in Atoms is 0), or is listed twice; ` +
          'LAMMPS stops.', `${field}-flag`);
        return false;
      }
      seen.add(a);
      if (field === 'ellipsoid') {
        if (!(v[0] > 0 && v[1] > 0 && v[2] > 0)) {
          error(R.no, `The three diameters of ellipsoid ${tag} must be positive.`, 'ellipsoid-shape');
          return false;
        }
        atoms.rmass[a] *= 4 * Math.PI / 3 * (v[0] / 2) * (v[1] / 2) * (v[2] / 2);
      } else if (field === 'line') {
        atoms.rmass[a] *= Math.hypot(v[2] - v[0], v[3] - v[1]);
      } else if (field === 'tri') {
        const e1 = [v[3] - v[0], v[4] - v[1], v[5] - v[2]];
        const e2 = [v[6] - v[0], v[7] - v[1], v[8] - v[2]];
        const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        atoms.rmass[a] *= 0.5 * Math.hypot(cr[0], cr[1], cr[2]);
      }
    }
    return true;
  }

  /* fix cmap's CMAP section: "ID type atom1 ... atom5" per crossterm. */
  function readCmap(info, n) {
    state.bonusSeen.CMAP = true;
    const map = idMapOf();
    const type = new Grow(Int32Array, 1, Math.min(n, 1 << 12));
    const ids = new Grow(Int32Array, 5, Math.min(n, 1 << 12));
    const lines = new Grow(Int32Array, 1, Math.min(n, 1 << 12));
    let missing = 0;
    let firstMissing = null;
    for (let i = 0; i < n; i++) {
      if (!R.next()) { eof('CMAP'); return false; }
      info.lines++;
      const nw = words(t, R.a, R.b, true);
      const v = [];
      for (let k = 1; k < nw; k++) v.push(intAt(t, TS[k], TE[k]));
      if (nw !== 7 || v.some(x => Number.isNaN(x))) {
        error(R.no, 'A CMAP line is "ID type atom1 atom2 atom3 atom4 atom5"; LAMMPS cannot read this one ' +
          '("Incorrect format of CMAP section").', 'cmap-format');
        return false;
      }
      if (map) {
        for (let k = 1; k < 6; k++) {
          if (map.get(v[k]) < 0) { missing++; if (!firstMissing) firstMissing = { line: R.no, id: v[k] }; }
        }
      }
      const j = type.reserve();
      type.a[j] = v[0];
      const o = ids.reserve();
      for (let k = 0; k < 5; k++) ids.a[o + k] = v[k + 1];
      lines.reserve(); lines.a[j] = R.no;
    }
    const ct = result.crossterms;
    ct.n = type.n;
    ct.type = type.done();
    ct.atoms = ids.done();
    ct.line = lines.done();
    if (missing) {
      error(firstMissing.line, `${missing} CMAP entries name atoms that are not in the Atoms section (the first: ` +
        `atom ${firstMissing.id}); LAMMPS stops when the run starts ("CMAP atoms missing").`);
      return false;
    }
    return true;
  }

  function readBodies(info) {
    if (!bonusOk('body')) {
      error(info.line, 'A Bodies section needs atom_style body; LAMMPS stops ("Invalid data file section").');
      return false;
    }
    if (!state.atomflag) {
      error(info.line, 'Bodies must come after Atoms; LAMMPS stops.');
      return false;
    }
    state.bonusSeen.Bodies = true;
    const n = counts.bodies;
    for (let i = 0; i < n; i++) {
      if (!R.next()) { eof('Bodies'); return false; }
      info.lines++;
      const nw = words(t, R.a, R.b, true);
      const tag = nw > 0 ? intAt(t, TS[0], TE[0]) : NaN;
      const ni = nw > 1 ? intAt(t, TS[1], TE[1]) : NaN;
      // LAMMPS reads the count of doubles as a double, then keeps its integer part.
      const nd = nw > 2 ? Math.trunc(numberAt(t, TS[2], TE[2])) : NaN;
      if (nw !== 3 || Number.isNaN(tag) || Number.isNaN(ni) || Number.isNaN(nd) || tag <= 0 ||
          tag > result.maxAtomId || ni < 0 || nd < 0) {
        error(R.no, 'Each body starts with a line "atom-ID Ninteger Ndouble"; LAMMPS cannot read this one.');
        return false;
      }
      for (const need of [ni, nd]) {
        let got = 0;
        while (got < need) {
          if (!R.next()) { eof('Bodies'); return false; }
          info.lines++;
          const k = words(t, R.a, R.b, true);
          if (k === 0) { error(R.no, 'Too few values in the body lines; LAMMPS stops.'); return false; }
          got += k;
        }
        if (got > need) { error(R.no, 'Too many values in the body lines; LAMMPS stops.'); return false; }
      }
    }
    return true;
  }
}

/* Unknown-section suggestions: a near miss of a known name. */
function nearestSection(k) {
  const lower = k.toLowerCase().replace(/\s+/g, ' ');
  let best = null;
  let bestD = Infinity;
  for (const s of [...SECTIONS, 'UreyBradley Coeffs']) {
    const d = editDistance(lower, s.toLowerCase());
    if (d < bestD) { bestD = d; best = s; }
  }
  return bestD <= Math.max(2, Math.floor(best.length / 5)) ? best : null;
}

function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 4) return 99;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/* A section name: the line without surrounding blanks, tabs and returns. */
function keywordOf(line) {
  return line.replace(/^[ \t\n\r]+/, '').replace(/[ \t\n\r]+$/, '');
}

/* The '# style' comment after a section name. */
function hintOf(raw) {
  const i = raw.indexOf('#');
  if (i < 0) return '';
  return raw.slice(i + 1).replace(/^[ \t]+/, '').replace(/[ \t\n\r]+$/, '');
}

/* The atom style a '# style' comment names: all of it ('hybrid full
   sphere'), or its first word ('# dielectric: id mol type ...'). */
function hintStyle(hint) {
  if (resolveAtomStyle(hint)) return hint;
  const first = hint.split(/\s+/)[0].replace(/[^A-Za-z0-9/_]+$/, '');
  return resolveAtomStyle(first) ? first : null;
}

/* ReadData::style_match, for the atom style comment. */
function styleMatch(one, two) {
  return !one || one === two || two.startsWith(one);
}

function bigAt(s) {
  if (!/^[+-]?\d+$/.test(s)) return NaN;
  const v = Number(s);
  return v > BIGINT_MAX ? NaN : v;
}

function growTo(a, n) {
  if (a.length >= n) return a;
  let len = a.length;
  while (len < n) len *= 2;
  const b = new a.constructor(len);
  b.set(a);
  return b;
}

function emptyAtoms() {
  return {
    n: 0, id: new Int32Array(0), type: new Int32Array(0), mol: null, q: null, x: new Float64Array(0),
    image: null, rmass: null, flag: null, line: new Int32Array(0)
  };
}

function emptyTopo(width) {
  return { n: 0, width, type: new Int32Array(0), atoms: new Int32Array(0), line: new Int32Array(0) };
}

function finish(result, kindCount, max) {
  for (const [kind, n] of kindCount) {
    if (n > max) result.issues.push({ line: null, severity: 'note', message: `${n - max} more problems like the ones above.`, url: READ_DATA_URL, kind });
  }
  result.ok = !result.issues.some(i => i.severity === 'error');
  return result;
}

/* Atom ID to index: a flat array when IDs are dense, a Map when sparse. */
function buildIdMap(ids, maxId) {
  const n = ids.length;
  let duplicates = 0;
  let firstDuplicate = null;
  if (maxId <= 4 * n + 1024) {
    const arr = new Int32Array(maxId + 1).fill(-1);
    for (let i = 0; i < n; i++) {
      if (arr[ids[i]] >= 0) { duplicates++; if (firstDuplicate === null) firstDuplicate = ids[i]; } else arr[ids[i]] = i;
    }
    return { get: (id) => (id >= 0 && id <= maxId ? arr[id] : -1), duplicates, firstDuplicate, array: arr };
  }
  const m = new Map();
  for (let i = 0; i < n; i++) {
    if (m.has(ids[i])) { duplicates++; if (firstDuplicate === null) firstDuplicate = ids[i]; } else m.set(ids[i], i);
  }
  return { get: (id) => { const v = m.get(id); return v === undefined ? -1 : v; }, duplicates, firstDuplicate, array: null };
}

/* ------------------------------------------------------------------ *
 * Box
 * ------------------------------------------------------------------ */

function parseBoundary(b) {
  return boundaryKinds(b).map(k => k === 'p');
}

function boundaryKinds(b) {
  const w = String(b || 'p p p').trim().split(/\s+/);
  // A face pair like 'fs' counts as non-periodic; its first letter decides the padding.
  return [0, 1, 2].map(d => (w[d] || 'p')[0]);
}

/*
 * The box as LAMMPS holds it (restricted triclinic when tilted), with its
 * edge vectors A, B, C. A general triclinic box (avec, bvec, cvec) is turned
 * the way LAMMPS turns it: A along x, B in the xy plane.
 */
function makeBox({ general, tilt, lo, hi, tiltv, avec, bvec, cvec, origin }) {
  let xlo; let xhi; let ylo; let yhi; let zlo; let zhi; let xy = 0; let xz = 0; let yz = 0;
  if (general) {
    const cross = [avec[1] * bvec[2] - avec[2] * bvec[1], avec[2] * bvec[0] - avec[0] * bvec[2], avec[0] * bvec[1] - avec[1] * bvec[0]];
    const dot = cross[0] * cvec[0] + cross[1] * cvec[1] + cross[2] * cvec[2];
    if (dot === 0) return { error: 'The avec, bvec and cvec vectors lie in one plane; LAMMPS stops.' };
    if (dot < 0) return { error: 'avec, bvec and cvec must be right-handed (avec x bvec pointing along cvec); LAMMPS stops.' };
    const la = Math.hypot(...avec);
    const ahat = avec.map(v => v / la);
    const bx = bvec[0] * ahat[0] + bvec[1] * ahat[1] + bvec[2] * ahat[2];
    const lb2 = bvec[0] ** 2 + bvec[1] ** 2 + bvec[2] ** 2;
    const by = Math.sqrt(Math.max(0, lb2 - bx * bx));
    const cx = cvec[0] * ahat[0] + cvec[1] * ahat[1] + cvec[2] * ahat[2];
    const bc = bvec[0] * cvec[0] + bvec[1] * cvec[1] + bvec[2] * cvec[2];
    const cy = (bc - bx * cx) / by;
    const lc2 = cvec[0] ** 2 + cvec[1] ** 2 + cvec[2] ** 2;
    const cz = Math.sqrt(Math.max(0, lc2 - cx * cx - cy * cy));
    xlo = origin[0]; ylo = origin[1]; zlo = origin[2];
    xhi = xlo + la; yhi = ylo + by; zhi = zlo + cz;
    xy = bx; xz = cx; yz = cy;
  } else {
    [xlo, ylo, zlo] = lo;
    [xhi, yhi, zhi] = hi;
    if (tilt) [xy, xz, yz] = tiltv;
  }
  if (!(xlo < xhi && ylo < yhi && zlo < zhi)) {
    return { error: 'Each box upper bound must be larger than its lower bound; LAMMPS stops ("Box bounds are invalid").' };
  }
  const lx = xhi - xlo;
  const ly = yhi - ylo;
  const lz = zhi - zlo;
  return {
    xlo, xhi, ylo, yhi, zlo, zhi, xy, xz, yz,
    triclinic: !!(tilt || general), general: !!general,
    avec: general ? [...avec] : null, bvec: general ? [...bvec] : null, cvec: general ? [...cvec] : null,
    origin: general ? [...origin] : null,
    lo: [xlo, ylo, zlo], hi: [xhi, yhi, zhi], len: [lx, ly, lz],
    lx, ly, lz, volume: lx * ly * lz,
    // Edge vectors of the box the coordinates in the file are in.
    edges: general ? [[...avec], [...bvec], [...cvec]] : [[lx, 0, 0], [xy, ly, 0], [xz, yz, lz]]
  };
}

/* Fractional coordinates in a restricted triclinic box (Domain::x2lamda). */
function toLambda(box, p, out) {
  const lx = box.lx; const ly = box.ly; const lz = box.lz;
  const d0 = p[0] - box.xlo; const d1 = p[1] - box.ylo; const d2 = p[2] - box.zlo;
  const h3 = box.yz; const h4 = box.xz; const h5 = box.xy;
  out[0] = d0 / lx + (-h5 / (lx * ly)) * d1 + ((h3 * h5 - ly * h4) / (lx * ly * lz)) * d2;
  out[1] = d1 / ly + (-h3 / (ly * lz)) * d2;
  out[2] = d2 / lz;
  return out;
}

/* ------------------------------------------------------------------ *
 * Elements from masses
 * ------------------------------------------------------------------ */

/* Standard atomic weights (IUPAC, abridged), and the masses force fields use. */
const ELEMENT_MASSES = [
  ['H', 1.008], ['He', 4.0026], ['Li', 6.94], ['Be', 9.0122], ['B', 10.81], ['C', 12.011],
  ['N', 14.007], ['O', 15.999], ['F', 18.998], ['Ne', 20.18], ['Na', 22.99], ['Mg', 24.305],
  ['Al', 26.982], ['Si', 28.085], ['P', 30.974], ['S', 32.06], ['Cl', 35.45], ['Ar', 39.948],
  ['K', 39.098], ['Ca', 40.078], ['Sc', 44.956], ['Ti', 47.867], ['V', 50.942], ['Cr', 51.996],
  ['Mn', 54.938], ['Fe', 55.845], ['Co', 58.933], ['Ni', 58.693], ['Cu', 63.546], ['Zn', 65.38],
  ['Ga', 69.723], ['Ge', 72.63], ['As', 74.922], ['Se', 78.971], ['Br', 79.904], ['Kr', 83.798],
  ['Rb', 85.468], ['Sr', 87.62], ['Y', 88.906], ['Zr', 91.224], ['Nb', 92.906], ['Mo', 95.95],
  ['Ru', 101.07], ['Rh', 102.91], ['Pd', 106.42], ['Ag', 107.87], ['Cd', 112.41], ['In', 114.82],
  ['Sn', 118.71], ['Sb', 121.76], ['Te', 127.6], ['I', 126.9], ['Xe', 131.29], ['Cs', 132.91],
  ['Ba', 137.33], ['La', 138.91], ['Ce', 140.12], ['Nd', 144.24], ['Sm', 150.36], ['Eu', 151.96],
  ['Gd', 157.25], ['Dy', 162.5], ['Er', 167.26], ['Yb', 173.05], ['Hf', 178.49], ['Ta', 180.95],
  ['W', 183.84], ['Re', 186.21], ['Os', 190.23], ['Ir', 192.22], ['Pt', 195.08], ['Au', 196.97],
  ['Hg', 200.59], ['Tl', 204.38], ['Pb', 207.2], ['Bi', 208.98], ['Th', 232.04], ['U', 238.03]
];
const ELEMENT_MASS = Object.fromEntries(ELEMENT_MASSES);

/* United atoms (a heavy atom with its hydrogens as one site) and the like. */
const UNITED_ATOMS = [
  ['CH', 13.019], ['CH2', 14.027], ['CH3', 15.035], ['CH4', 16.043], ['NH', 15.015],
  ['NH2', 16.023], ['NH3', 17.031], ['OH', 17.007], ['SH', 33.068]
];

/**
 * Guess what a type is from its mass: an element (with a confidence), a
 * united atom (CH3 = 15.035), a light virtual site, or nothing. A name (the
 * comment on the Masses line, or a type label) that starts with an element
 * symbol of about that mass settles a close call.
 *
 * @param {number} mass
 * @param {{name?:string, units?:string}} [options] - In lj units masses
 *   are reduced, so no element is guessed.
 * @returns {{element:string|null, confidence:'high'|'medium'|'low'|null,
 *   kind:'element'|'united-atom'|'hydrogen-heavy'|'virtual'|'coarse'|null,
 *   label:string, note:string}}
 */
export function guessElement(mass, options = {}) {
  const { name = '', units = null } = options;
  const none = (kind = null, label = '', note = '') => ({ element: null, confidence: null, kind, label, note });
  if (!(mass > 0)) return none();
  if (units === 'lj') return none(null, '', 'Reduced (lj) units: masses do not name elements.');
  if (units && !['real', 'metal', 'electron', undefined, null].includes(units)) {
    // si, cgs, micro, nano: masses are not atomic masses.
    return none(null, '', `In ${units} units the mass is not an atomic mass.`);
  }
  if (mass < 0.5) {
    const drude = /^(d|dp|dc|drude|dr)\b/i.test(name) || /drude/i.test(name);
    return none('virtual', drude ? 'Drude particle' : 'light site',
      drude ? 'A Drude particle (a light charged site on a spring).'
        : 'Too light for an atom: a virtual site (TIP4P M, a lone pair) or a Drude particle.');
  }
  // A name like 'OW', 'HW1', 'c3', 'Na+', 'CLA' names an element when its
  // leading letters are one and the mass agrees.
  const fromName = elementFromName(name, mass);
  if (fromName) return { element: fromName, confidence: 'high', kind: 'element', label: fromName, note: '' };

  const cands = [];
  for (const [el, m] of ELEMENT_MASSES) cands.push({ el, m, kind: 'element' });
  for (const [ua, m] of UNITED_ATOMS) cands.push({ el: ua, m, kind: 'united-atom' });
  cands.push({ el: 'H', m: 2.014, kind: 'hydrogen-heavy', label: 'D (deuterium)' });
  cands.push({ el: 'H', m: 3.024, kind: 'hydrogen-heavy', label: 'H (mass repartitioned)' });
  cands.push({ el: 'H', m: 4.032, kind: 'hydrogen-heavy', label: 'H (mass repartitioned)' });
  cands.sort((a, b) => Math.abs(a.m - mass) - Math.abs(b.m - mass));
  const best = cands[0];
  const d = Math.abs(best.m - mass);
  const second = cands[1];
  const gap = Math.abs(second.m - mass) - d;
  let confidence = d <= 0.012 ? 'high' : d <= 0.1 ? 'medium' : d <= 0.6 ? 'low' : null;
  if (!confidence) {
    if ([72, 54, 36, 45].includes(mass)) {
      return none('coarse', 'coarse-grained bead', 'A mass like a Martini bead (72, 54, 36 or 45): a coarse-grained site.');
    }
    return none(null, '', 'No element or united atom has this mass.');
  }
  // Two candidates about as close: say the best, less sure.
  // A second candidate about as close makes the call less sure.
  const ratio = (d + gap) / Math.max(d, 1e-4);
  if (ratio < 2) confidence = 'low';
  else if (ratio < 4) confidence = confidence === 'high' ? 'medium' : 'low';
  if (best.kind === 'united-atom') {
    return { element: null, confidence, kind: 'united-atom', label: `${best.el} (united atom)`,
      note: `A ${best.el} group as one site (united-atom force field), not an element.` };
  }
  if (best.kind === 'hydrogen-heavy') {
    return { element: 'H', confidence: best.m === 2.014 ? 'medium' : 'low', kind: 'hydrogen-heavy', label: best.label,
      note: best.m === 2.014 ? 'Deuterium, or hydrogen with a doubled mass.'
        : 'Hydrogen with its mass raised (hydrogen mass repartitioning) for a longer timestep.' };
  }
  return { element: best.el, confidence, kind: 'element', label: best.el, note: '' };
}

/* An element symbol at the start of a name, if its mass is close to `mass`. */
function elementFromName(name, mass) {
  const n = String(name || '').trim().replace(/^[#\s]+/, '');
  if (!n) return null;
  const m = /^([A-Za-z]{1,2})/.exec(n);
  if (!m) return null;
  const tries = [];
  const two = m[1].length === 2 ? m[1][0].toUpperCase() + m[1][1].toLowerCase() : null;
  const one = m[1][0].toUpperCase();
  if (two) tries.push(two);
  tries.push(one);
  for (const el of tries) {
    const w = ELEMENT_MASS[el];
    if (w && Math.abs(w - mass) <= Math.max(0.6, 0.01 * w)) return el;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

/* g/cm^3 per (mass unit / distance unit^3) of each unit style, and the
   names of the units. */
const DENSITY_FACTOR = {
  real: 1.66053906660, metal: 1.66053906660, electron: 1.66053906660 / 0.529177210903 ** 3,
  si: 1e-3, cgs: 1, micro: 1, nano: 1e3
};
const DISTANCE_UNIT = { real: 'Å', metal: 'Å', electron: 'bohr', si: 'm', cgs: 'cm', micro: 'µm', nano: 'nm', lj: 'σ' };
const TO_ANGSTROM = { real: 1, metal: 1, electron: 0.529177210903, nano: 10, si: 1e10, cgs: 1e8, micro: 1e4 };

/*
 * Water models by the charges of their sites: `o` is the charge on the
 * oxygen of a three-site model, `m` the charge of the fourth site (which
 * LAMMPS's tip4p pair styles put on O and move to M themselves), `h` on
 * each hydrogen. rOH in Å, angle in degrees, qdist (O-M, Å) for tip4p.
 */
const WATER_MODELS = [
  { model: 'TIP3P', sites: 3, o: -0.834, h: 0.417, rOH: 0.9572, angle: 104.52, note: 'CHARMM and AMBER use the same charges.' },
  { model: 'SPC/E', sites: 3, o: -0.8476, h: 0.4238, rOH: 1.0, angle: 109.47 },
  { model: 'SPC', sites: 3, o: -0.82, h: 0.41, rOH: 1.0, angle: 109.47, note: 'SPC/Fw, the flexible version, has the same charges.' },
  { model: 'TIP3P-FB', sites: 3, o: -0.848448, h: 0.424224, rOH: 1.0118, angle: 108.15 },
  { model: 'TIP3P (Ewald, Price and Brooks)', sites: 3, o: -0.830, h: 0.415, rOH: 0.9572, angle: 104.52 },
  { model: 'OPC3', sites: 3, o: -0.89517, h: 0.447585, rOH: 0.97888, angle: 109.47 },
  { model: 'TIP4P', sites: 4, m: -1.04, h: 0.52, rOH: 0.9572, angle: 104.52, qdist: 0.15 },
  { model: 'TIP4P-Ew', sites: 4, m: -1.04844, h: 0.52422, rOH: 0.9572, angle: 104.52, qdist: 0.125 },
  { model: 'TIP4P/2005', sites: 4, m: -1.1128, h: 0.5564, rOH: 0.9572, angle: 104.52, qdist: 0.1546 },
  { model: 'TIP4P/Ice', sites: 4, m: -1.1794, h: 0.5897, rOH: 0.9572, angle: 104.52, qdist: 0.1577 },
  { model: 'TIP4P-FB', sites: 4, m: -1.05269, h: 0.526345, rOH: 0.9572, angle: 104.52, qdist: 0.10527 },
  { model: 'TIP4P-D', sites: 4, m: -1.16, h: 0.58, rOH: 0.9572, angle: 104.52, qdist: 0.1546 },
  { model: 'OPC', sites: 4, m: -1.3582, h: 0.6791, rOH: 0.8724, angle: 103.6, qdist: 0.1594 },
  { model: 'TIP5P', sites: 5, o: 0, l: -0.241, h: 0.241, rOH: 0.9572, angle: 104.52 }
];

/* Elements seen as ions when alone and charged. */
const ION_ELEMENTS = new Set(['Li', 'Na', 'K', 'Rb', 'Cs', 'Mg', 'Ca', 'Sr', 'Ba', 'Zn', 'Cu', 'Fe',
  'Mn', 'Ni', 'Co', 'Cd', 'Al', 'F', 'Cl', 'Br', 'I']);

/**
 * Say what a system is made of, from `parseDataFile`'s result.
 *
 * @param {object} parsed - What parseDataFile returned.
 * @param {{units?:string}} [options] - The units the input script uses
 *   (default real, or what the file's title says): masses become elements
 *   and the density g/cm³ only in atomic units.
 * @returns {object} `{units, atomStyle, natoms, types:[{type, label, name,
 *   mass, element, elementConfidence, kind, what, count, charge, charges,
 *   role, roleCounts}], molecules, molecularUnits, charge, chargeAbs,
 *   hasCharges, mass, volume, density, numberDensity, box, water, ions, hydrogenTypes,
 *   hydrogenBondTypes, shake, soluteTypes, solute, coeffs, topology,
 *   velocities, imageFlags, vacuum, notes}`. `molecules` counts the
 *   molecule IDs above 0; `vacuum` is the widest empty slab
 *   `{axis, size, fraction, from, to}` or null; `shake` is
 *   `{m, t, b, a, mixedBondTypes}` for fix shake. `water` is `{model, confidence,
 *   sites, oType, hType, mType, bondType, angleType, count, atoms,
 *   oCharge, hCharge, mCharge, rOH, angleHOH, qdist, pairTip4p}` or null.
 */
export function summariseData(parsed, options = {}) {
  const units = options.units || parsed.unitsHint || 'real';
  const atomic = ['real', 'metal', 'electron'].includes(units);
  const A = parsed.atoms;
  const n = A.n;
  const ntypes = Math.max(parsed.types.atom, parsed.masses.length);
  const notes = [];
  const types = [];
  const massOf = new Float64Array(ntypes + 1).fill(NaN);
  for (const m of parsed.masses) if (m.mass !== null && m.type <= ntypes) massOf[m.type] = m.mass;

  // Per type: count, charge, per-atom mass when the style has one.
  const count = new Float64Array(ntypes + 1);
  const qsum = new Float64Array(ntypes + 1);
  const qmin = new Float64Array(ntypes + 1).fill(Infinity);
  const qmax = new Float64Array(ntypes + 1).fill(-Infinity);
  const rsum = new Float64Array(ntypes + 1);
  for (let i = 0; i < n; i++) {
    const ty = A.type[i];
    count[ty]++;
    if (A.q) {
      const q = A.q[i];
      qsum[ty] += q;
      if (q < qmin[ty]) qmin[ty] = q;
      if (q > qmax[ty]) qmax[ty] = q;
    }
    if (A.rmass) rsum[ty] += A.rmass[i];
  }
  let totalMass = 0;
  for (let ty = 1; ty <= ntypes; ty++) {
    const meta = parsed.masses[ty - 1] || {};
    const perAtomMass = A.rmass ? (count[ty] ? rsum[ty] / count[ty] : null) : null;
    const mass = A.rmass ? perAtomMass : (Number.isNaN(massOf[ty]) ? null : massOf[ty]);
    const guess = mass ? guessElement(mass, { name: meta.name || meta.label || '', units }) : guessElement(0);
    const q = A.q && count[ty] ? {
      total: qsum[ty], min: qmin[ty], max: qmax[ty], each: qmax[ty] - qmin[ty] < 1e-9 ? qmin[ty] : null
    } : null;
    types.push({
      type: ty,
      label: meta.label || null,
      name: meta.name || null,
      mass,
      element: guess.element,
      elementConfidence: guess.confidence,
      kind: guess.kind,
      what: guess.label || guess.element || '',
      count: count[ty],
      charge: q ? q.total : 0,
      charges: q,
      role: null
    });
    totalMass += A.rmass ? rsum[ty] : (Number.isNaN(massOf[ty]) ? 0 : massOf[ty] * count[ty]);
  }
  const typeInfo = (ty) => types[ty - 1];
  const isH = (ty) => { const t = typeInfo(ty); return !!t && t.element === 'H'; };

  // Charge.
  let charge = 0;
  let chargeAbs = 0;
  if (A.q) for (let i = 0; i < n; i++) { charge += A.q[i]; chargeAbs += Math.abs(A.q[i]); }
  const hasCharges = !!A.q && chargeAbs > 0;

  // Molecules: by molecule ID where the style has them, and by bonds.
  const ids = parsed.atoms.id;
  const idMap = n ? buildIdMap(ids, parsed.maxAtomId || maxOf(ids)) : null;
  const fragments = molecularUnits(parsed, idMap);
  let molecules = 0;
  if (A.mol) {
    const seen = new Set();
    for (let i = 0; i < n; i++) if (A.mol[i] > 0) seen.add(A.mol[i]);
    molecules = seen.size;
  }

  // Classify units: water, ions, the rest is solute.
  const role = new Int8Array(n); // 0 solute, 1 water, 2 ion
  const kinds = classifyUnits(parsed, fragments, types, idMap);
  const waterKind = pickWater(kinds, parsed, types);
  if (waterKind) for (const u of waterKind.members) for (const a of u) role[a] = 1;
  const ions = [];
  for (const k of kinds) {
    if (!k.ion) continue;
    for (const u of k.members) for (const a of u) role[a] = 2;
  }
  // Ions by type (a type used only by lone charged atoms).
  const ionByType = new Map();
  for (let i = 0; i < n; i++) if (role[i] === 2) ionByType.set(A.type[i], (ionByType.get(A.type[i]) || 0) + 1);
  for (const [ty, c] of [...ionByType].sort((a, b) => a[0] - b[0])) {
    const ti = typeInfo(ty);
    const q = ti.charges ? ti.charges.each : null;
    ions.push({
      type: ty, element: ti.element, charge: q, count: c,
      name: ti.element ? `${ti.element}${q === null ? '' : ionSign(q)}` : `type ${ty}`,
      allOfType: c === ti.count
    });
  }

  // Per-type roles.
  const roleCount = types.map(() => [0, 0, 0]);
  for (let i = 0; i < n; i++) roleCount[A.type[i] - 1][role[i]]++;
  types.forEach((ti, k) => {
    const [s, w, io] = roleCount[k];
    ti.role = !ti.count ? 'unused' : w && !s && !io ? 'water' : io && !s && !w ? 'ion' : s && !w && !io ? 'solute' : 'mixed';
    ti.roleCounts = { solute: s, water: w, ion: io };
  });

  // Hydrogens.
  const hydrogenTypes = types.filter(ti => ti.element === 'H' && ti.count).map(ti => ti.type);
  const hBondTypes = new Set();
  const nonHBondTypes = new Set();
  const B = parsed.bonds;
  if (B.n && idMap) {
    for (let b = 0; b < B.n; b++) {
      const i = idMap.get(B.atoms[2 * b]);
      const j = idMap.get(B.atoms[2 * b + 1]);
      if (i < 0 || j < 0) continue;
      if (isH(A.type[i]) || isH(A.type[j])) hBondTypes.add(B.type[b]);
      else nonHBondTypes.add(B.type[b]);
    }
  }
  const hydrogenBondTypes = [...hBondTypes].sort((a, b) => a - b);
  const mixedBondTypes = hydrogenBondTypes.filter(bt => nonHBondTypes.has(bt));

  // Water.
  let water = null;
  if (waterKind) water = describeWater(waterKind, parsed, types, units, idMap, notes);

  // SHAKE: hydrogens by mass, bond types to hydrogen, the water angle.
  let shake = null;
  if (hydrogenTypes.length || water) {
    const hm = [...new Set(hydrogenTypes.map(ty => typeInfo(ty).mass).filter(m => m))].sort((a, b) => a - b);
    shake = {
      m: hm.map(m => +m.toFixed(4)),
      t: hydrogenTypes,
      b: hydrogenBondTypes,
      a: water && water.angleType ? [water.angleType] : [],
      mixedBondTypes
    };
    if (mixedBondTypes.length) {
      notes.push(`Bond type${mixedBondTypes.length > 1 ? 's' : ''} ${mixedBondTypes.join(' ')} join hydrogens in some ` +
        'bonds and heavy atoms in others; constrain by mass (fix shake ... m) or by atom type (t), not by bond type.');
    }
  }

  // Solute.
  const soluteTypes = [];
  types.forEach((ti, k) => { if (roleCount[k][0]) soluteTypes.push(ti.type); });
  const soluteKinds = kinds.filter(k => !k.ion && k !== waterKind && k.members.length)
    .map(k => ({
      formula: k.formula, count: k.members.length, atoms: k.natoms, charge: k.charge,
      types: k.types, bonded: k.bonded
    }))
    .sort((a, b) => b.atoms * b.count - a.atoms * a.count);
  let soluteAtoms = 0;
  for (let i = 0; i < n; i++) if (role[i] === 0) soluteAtoms++;
  const solute = { atoms: soluteAtoms, molecules: soluteKinds.reduce((s, k) => s + k.count, 0), kinds: soluteKinds.slice(0, 20) };

  // Box, volume, density.
  const box = parsed.box;
  const volume = box ? box.volume : null;
  let density = null;
  let numberDensity = null;
  if (box && volume > 0) {
    numberDensity = n / volume;
    if (DENSITY_FACTOR[units] && totalMass > 0) density = totalMass / volume * DENSITY_FACTOR[units];
  }

  // Coefficient sections.
  const co = parsed.coefficients || {};
  const coeffs = {
    pair: !!(co.pair && co.pair.length), pairIJ: !!(co.pairIJ && co.pairIJ.length),
    bond: !!(co.bond && co.bond.length), angle: !!(co.angle && co.angle.length),
    dihedral: !!(co.dihedral && co.dihedral.length), improper: !!(co.improper && co.improper.length),
    class2: ['bondBond', 'bondAngle', 'middleBondTorsion', 'endBondTorsion', 'angleTorsion', 'angleAngleTorsion', 'bondBond13', 'angleAngle']
      .some(k => co[k] && co[k].length),
    ureyBradley: !!(co.ureyBradley && co.ureyBradley.length),
    styles: { ...(co.styles || {}) }
  };

  // Notes in plain words.
  const du = DISTANCE_UNIT[units] || 'distance units';
  if (n && box) {
    notes.unshift(`${fmtInt(n)} atoms of ${ntypes} type${ntypes === 1 ? '' : 's'} in a ` +
      `${fmt(box.lx)} × ${fmt(box.ly)} × ${fmt(box.lz)} ${du} box${box.triclinic ? ' (triclinic)' : ''}` +
      (density ? `, ${density.toFixed(3)} g/cm³` : '') + '.');
  }
  if (A.q) {
    const round = Math.abs(charge) < 1e-6 ? 0 : charge;
    if (!hasCharges) notes.push('The atom style has charges, but they are all zero.');
    else if (Math.abs(round) >= 1e-3) {
      notes.push(`The net charge is ${charge.toFixed(4)} e, not zero. With Ewald or PPPM this acts as a uniform ` +
        'background charge, which is rarely what you want: check the charges or add counter-ions.');
    } else if (round !== 0) {
      notes.push(`The net charge is ${charge.toExponential(2)} e: rounding in the charges, harmless.`);
    }
  }
  const unused = types.filter(ti => !ti.count).map(ti => ti.type);
  if (unused.length && n) notes.push(`Atom type${unused.length > 1 ? 's' : ''} ${compressList(unused)} ${unused.length > 1 ? 'have' : 'has'} no atoms (fine: types reserved for later).`);
  const noMass = types.filter(ti => ti.mass === null && ti.count).map(ti => ti.type);
  if (noMass.length) notes.push(`No mass for type${noMass.length > 1 ? 's' : ''} ${compressList(noMass)}: the input script must set ${noMass.length > 1 ? 'them' : 'it'} with the mass command.`);
  if (atomic) {
    const ua = types.filter(ti => ti.kind === 'united-atom').map(ti => `${ti.type} (${ti.what})`);
    if (ua.length) notes.push(`United-atom types: ${ua.join(', ')}; their hydrogens are part of the site.`);
    const heavyH = types.filter(ti => ti.kind === 'hydrogen-heavy' && ti.count).map(ti => ti.type);
    if (heavyH.length) notes.push(`Type${heavyH.length > 1 ? 's' : ''} ${heavyH.join(' ')} look like hydrogen with a raised mass (repartitioning or deuterium).`);
  }
  if (ions.length) {
    notes.push(`Ions: ${ions.map(io => `${fmtInt(io.count)} ${io.name}`).join(', ')}.`);
  }
  if (solute.molecules) {
    const k0 = soluteKinds[0];
    notes.push(`Solute: ${fmtInt(soluteAtoms)} atoms in ${fmtInt(solute.molecules)} molecule${solute.molecules > 1 ? 's' : ''}` +
      (soluteKinds.length === 1 && k0.count > 1 ? ` (${fmtInt(k0.count)} × ${k0.formula || `${k0.atoms} atoms`})` : '') + '.');
  }
  if (parsed.velocities) notes.push('The file has velocities: skip velocity create if you want to keep them.');
  if (parsed.counts.crossterms) {
    notes.push(`${fmtInt(parsed.counts.crossterms)} CHARMM CMAP crossterms: the input needs fix cmap with the force ` +
      'field\'s .cmap file before read_data, and read_data ... fix cmap crossterm CMAP.');
  }
  const topology = {
    bonds: parsed.bonds.n, angles: parsed.angles.n, dihedrals: parsed.dihedrals.n, impropers: parsed.impropers.n,
    crossterms: parsed.counts.crossterms || 0,
    bondTypes: parsed.types.bond, angleTypes: parsed.types.angle, dihedralTypes: parsed.types.dihedral,
    improperTypes: parsed.types.improper
  };
  if (parsed.bonds.n && box && idMap) checkBondLengths(parsed, idMap, units, notes);
  const vacuum = box && n ? findVacuum(parsed, units) : null;
  if (vacuum) {
    notes.push(`The atoms leave an empty slab ${fmt(vacuum.size)} ${du} wide along ${vacuum.axis} ` +
      `(${Math.round(vacuum.fraction * 100)}% of the box): a slab or an interface with vacuum. A barostat in that ` +
      `direction would close the gap; with Ewald or PPPM, kspace_modify slab 3.0 suits a gap along z.`);
  }

  return {
    units,
    atomStyle: parsed.atomStyle,
    natoms: n,
    types,
    molecules,
    molecularUnits: fragments.count,
    charge,
    chargeAbs,
    hasCharges,
    mass: totalMass,
    volume,
    density,
    numberDensity,
    box: box ? {
      xlo: box.xlo, xhi: box.xhi, ylo: box.ylo, yhi: box.yhi, zlo: box.zlo, zhi: box.zhi,
      xy: box.xy, xz: box.xz, yz: box.yz, lx: box.lx, ly: box.ly, lz: box.lz, triclinic: box.triclinic
    } : null,
    water,
    ions,
    hydrogenTypes,
    hydrogenBondTypes,
    shake,
    soluteTypes,
    solute,
    coeffs,
    topology,
    velocities: !!parsed.velocities,
    imageFlags: parsed.imageFlags,
    vacuum,
    notes
  };
}

/*
 * The widest empty slab across the box along x, y or z (along the box
 * edges when tilted), from a histogram of the wrapped positions. A gap of
 * at least a fifth of the box, and a few atom diameters, counts.
 */
function findVacuum(parsed, units) {
  const A = parsed.atoms;
  const box = parsed.box;
  const n = A.n;
  if (n < 10) return null;
  const scale = TO_ANGSTROM[units] || null;
  const lam = [0, 0, 0];
  let best = null;
  for (let d = 0; d < 3; d++) {
    const L = box.len[d];
    const nb = Math.max(20, Math.min(2000, scale ? Math.ceil(L * scale) : 200));
    const occ = new Uint8Array(nb);
    for (let i = 0; i < n; i++) {
      let f;
      if (box.triclinic && !box.general) f = toLambda(box, [A.x[3 * i], A.x[3 * i + 1], A.x[3 * i + 2]], lam)[d];
      else if (box.general) f = generalFraction(box, A.x, i, d);
      else f = (A.x[3 * i + d] - box.lo[d]) / L;
      f -= Math.floor(f);
      occ[Math.min(nb - 1, Math.floor(f * nb))] = 1;
    }
    // Longest run of empty bins, going round the periodic box.
    let run = 0;
    let longest = 0;
    let end = -1;
    for (let k = 0; k < 2 * nb; k++) {
      if (!occ[k % nb]) { run++; if (run > longest) { longest = run; end = k; } } else run = 0;
    }
    if (longest >= nb) return null;   // no atoms at all along d (cannot happen with n > 0)
    const fraction = longest / nb;
    const size = fraction * L;
    if (fraction < 0.2 || (scale && size * scale < 8)) continue;
    if (!best || fraction > best.fraction) {
      const to = ((end + 1) % nb) / nb;
      const from = ((end + 1 - longest + nb) % nb) / nb;
      best = { axis: 'xyz'[d], size, fraction, from: box.lo[d] + from * L, to: box.lo[d] + to * L };
    }
  }
  return best;
}

/* Fraction along edge d of a general triclinic box. */
function generalFraction(box, x, i, d) {
  const inv = invert3(box.edges);
  const o = box.origin;
  const p0 = x[3 * i] - o[0];
  const p1 = x[3 * i + 1] - o[1];
  const p2 = x[3 * i + 2] - o[2];
  return inv[0][d] * p0 + inv[1][d] * p1 + inv[2][d] * p2;
}

function maxOf(a) {
  let m = 0;
  for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
  return m;
}

function ionSign(q) {
  const r = Math.round(q);
  if (Math.abs(q - r) > 0.05 || r === 0) return `(${q > 0 ? '+' : ''}${+q.toFixed(3)})`;
  return r > 0 ? (r === 1 ? '+' : `${r}+`) : (r === -1 ? '-' : `${-r}-`);
}

/*
 * Molecular units: atoms joined by bonds (union-find), merged with atoms
 * that share a molecule ID when no bond joins them (a TIP4P M site, a
 * rigid water without bonds). Returns `unit[i]` (unit index of each atom),
 * the atoms of each unit (CSR: start, list) and the count.
 */
function molecularUnits(parsed, idMap) {
  const A = parsed.atoms;
  const n = A.n;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (i, j) => {
    const a = find(i); const b = find(j);
    if (a !== b) { if (a < b) parent[b] = a; else parent[a] = b; }
  };
  const B = parsed.bonds;
  if (idMap) {
    for (let b = 0; b < B.n; b++) {
      const i = idMap.get(B.atoms[2 * b]);
      const j = idMap.get(B.atoms[2 * b + 1]);
      if (i >= 0 && j >= 0) union(i, j);
    }
  }
  // Molecule IDs join what bonds do not (only small molecules: a molecule
  // ID shared by thousands of atoms is a whole polymer or a whole phase).
  if (A.mol) {
    let maxMol = 0;
    for (let i = 0; i < n; i++) if (A.mol[i] > maxMol) maxMol = A.mol[i];
    if (maxMol <= 4 * n + 1024) {
      const size = new Int32Array(maxMol + 1);
      const firstOf = new Int32Array(maxMol + 1).fill(-1);
      for (let i = 0; i < n; i++) if (A.mol[i] > 0) size[A.mol[i]]++;
      for (let i = 0; i < n; i++) {
        const m = A.mol[i];
        if (m <= 0 || size[m] > 8) continue;
        if (firstOf[m] < 0) firstOf[m] = i; else union(firstOf[m], i);
      }
    } else {
      const firstOf = new Map();
      const size = new Map();
      for (let i = 0; i < n; i++) {
        const m = A.mol[i];
        if (m > 0) size.set(m, (size.get(m) || 0) + 1);
      }
      for (let i = 0; i < n; i++) {
        const m = A.mol[i];
        if (m <= 0 || size.get(m) > 8) continue;
        const f = firstOf.get(m);
        if (f === undefined) firstOf.set(m, i);
        else union(f, i);
      }
    }
  }
  const root = new Int32Array(n);
  const index = new Int32Array(n).fill(-1);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (index[r] < 0) index[r] = count++;
    root[i] = index[r];
  }
  const start = new Int32Array(count + 1);
  for (let i = 0; i < n; i++) start[root[i] + 1]++;
  for (let u = 0; u < count; u++) start[u + 1] += start[u];
  const fill = start.slice(0, count);
  const list = new Int32Array(n);
  for (let i = 0; i < n; i++) list[fill[root[i]]++] = i;
  return { unit: root, start, list, count };
}

/* Group units by composition (sorted types) and bond count. */
function classifyUnits(parsed, U, types, idMap) {
  const A = parsed.atoms;
  const nb = new Int32Array(U.count);
  const B = parsed.bonds;
  if (idMap) {
    for (let b = 0; b < B.n; b++) {
      const i = idMap.get(B.atoms[2 * b]);
      if (i >= 0) nb[U.unit[i]]++;
    }
  }
  const byKey = new Map();
  const tmp = [];
  for (let u = 0; u < U.count; u++) {
    const s = U.start[u];
    const e = U.start[u + 1];
    const size = e - s;
    let key;
    if (size === 1) key = `1:${A.type[U.list[s]]}`;
    else if (size <= 64) {
      tmp.length = 0;
      for (let k = s; k < e; k++) tmp.push(A.type[U.list[k]]);
      tmp.sort((a, b) => a - b);
      key = `${size}:${nb[u]}:${tmp.join(',')}`;
    } else {
      // Large molecules: same size, bonds and count of each type.
      const hist = new Map();
      for (let k = s; k < e; k++) hist.set(A.type[U.list[k]], (hist.get(A.type[U.list[k]]) || 0) + 1);
      key = `${size}:${nb[u]}:${[...hist].sort((a, b) => a[0] - b[0]).map(([ty, c]) => `${ty}x${c}`).join(',')}`;
    }
    let k = byKey.get(key);
    if (!k) {
      k = { key, members: [], natoms: size, bonded: nb[u], types: [], formula: '', charge: 0, ion: false };
      byKey.set(key, k);
    }
    k.members.push(U.list.subarray(s, e));
  }
  const kinds = [...byKey.values()];
  for (const k of kinds) {
    const first = k.members[0];
    const tset = new Set();
    let q = 0;
    for (const a of first) { tset.add(A.type[a]); if (A.q) q += A.q[a]; }
    k.types = [...tset].sort((a, b) => a - b);
    k.charge = q;
    k.formula = formulaOf(first, A, types);
    if (k.natoms === 1 && !k.bonded) {
      const ti = types[A.type[first[0]] - 1];
      const qa = A.q ? A.q[first[0]] : 0;
      k.ion = !!ti && ((ti.element && ION_ELEMENTS.has(ti.element) && Math.abs(qa) >= 0.5) ||
        (Math.abs(qa) >= 0.5 && Math.abs(qa - Math.round(qa)) < 0.05 && ti.kind === 'element'));
    }
  }
  return kinds;
}

function formulaOf(atoms, A, types) {
  const c = new Map();
  for (const a of atoms) {
    const ti = types[A.type[a] - 1];
    const el = ti && (ti.element || (ti.kind === 'united-atom' ? ti.what.split(' ')[0] : null));
    if (!el) return '';
    c.set(el, (c.get(el) || 0) + 1);
  }
  const order = [...c.keys()].sort((a, b) => {
    const r = (x) => (x.startsWith('C') && x !== 'Cl' && x !== 'Ca' && x !== 'Cu' && x !== 'Cs' && x !== 'Co' && x !== 'Cd' ? 0 : x === 'H' ? 1 : 2);
    return r(a) - r(b) || a.localeCompare(b);
  });
  return order.map(el => `${el}${c.get(el) > 1 ? c.get(el) : ''}`).join('');
}

/* The unit kind that is water: one O and two H (plus an optional light
   site, or two light sites for TIP5P), the O bonded to both H when the
   file has bonds. The largest such kind wins. */
function pickWater(kinds, parsed, types) {
  const A = parsed.atoms;
  const hasBonds = parsed.bonds.n > 0;
  let best = null;
  for (const k of kinds) {
    if (k.natoms < 3 || k.natoms > 5) continue;
    const first = k.members[0];
    let o = 0; let h = 0; let light = 0; let other = 0;
    for (const a of first) {
      const ti = types[A.type[a] - 1];
      if (ti.element === 'O' && ti.elementConfidence) o++;
      else if (ti.element === 'H') h++;
      else if (ti.kind === 'virtual' || (ti.mass !== null && ti.mass < 0.5) || (ti.mass === null && !ti.element)) light++;
      else other++;
    }
    if (o !== 1 || h !== 2 || other || light > 2 || k.natoms !== 3 + light) continue;
    if (hasBonds && k.bonded < 2) continue;
    if (!best || k.members.length > best.members.length) best = k;
  }
  return best;
}

function describeWater(kind, parsed, types, units, idMap, notes) {
  const A = parsed.atoms;
  const first = kind.members[0];
  let oType = 0; let hType = 0; let mType = 0; let lType = 0;
  let oAtom = -1;
  const hAtoms = [];
  const light = [];
  for (const a of first) {
    const ti = types[A.type[a] - 1];
    if (ti.element === 'O') { oType = ti.type; oAtom = a; } else if (ti.element === 'H') { hType = hType || ti.type; hAtoms.push(a); } else light.push(a);
  }
  if (light.length === 1) mType = A.type[light[0]];
  if (light.length === 2) lType = A.type[light[0]];
  // Every member must use the same types for a `group water type` to hold.
  const hTypes = new Set();
  for (const u of kind.members) for (const a of u) if (types[A.type[a] - 1].element === 'H') hTypes.add(A.type[a]);
  // Bond and angle types used by water.
  const inWater = new Uint8Array(A.n);
  for (const u of kind.members) for (const a of u) inWater[a] = 1;
  const bondTypes = new Map();
  const B = parsed.bonds;
  for (let b = 0; b < B.n; b++) {
    const i = idMap.get(B.atoms[2 * b]);
    const j = idMap.get(B.atoms[2 * b + 1]);
    if (i >= 0 && j >= 0 && inWater[i] && inWater[j]) {
      const hh = types[A.type[i] - 1].element === 'H' && types[A.type[j] - 1].element === 'H';
      if (!hh) bondTypes.set(B.type[b], (bondTypes.get(B.type[b]) || 0) + 1);
    }
  }
  const angleTypes = new Map();
  const G = parsed.angles;
  for (let g = 0; g < G.n; g++) {
    const j = idMap.get(G.atoms[3 * g + 1]);
    if (j >= 0 && inWater[j]) angleTypes.set(G.type[g], (angleTypes.get(G.type[g]) || 0) + 1);
  }
  const top = (m) => ([...m].sort((a, b) => b[1] - a[1])[0] || [0])[0] || null;
  const bondType = top(bondTypes);
  const angleType = top(angleTypes);

  // Charges and geometry, averaged over the water molecules.
  const qo = A.q ? A.q[oAtom] : null;
  const qh = A.q && hAtoms.length ? A.q[hAtoms[0]] : null;
  const qm = A.q && light.length ? A.q[light[0]] : null;
  let rSum = 0; let aSum = 0; let k = 0;
  const box = parsed.box;
  const step = Math.max(1, Math.floor(kind.members.length / 2000));
  for (let m = 0; m < kind.members.length; m += step) {
    const u = kind.members[m];
    let o = -1; const h = [];
    for (const a of u) {
      const el = types[A.type[a] - 1].element;
      if (el === 'O') o = a; else if (el === 'H') h.push(a);
    }
    if (o < 0 || h.length !== 2) continue;
    const d1 = minImage(box, A.x, o, h[0]);
    const d2 = minImage(box, A.x, o, h[1]);
    const r1 = Math.hypot(...d1);
    const r2 = Math.hypot(...d2);
    rSum += (r1 + r2) / 2;
    const cos = (d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2]) / (r1 * r2);
    aSum += Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
    k++;
  }
  const scale = TO_ANGSTROM[units] || null;
  const rOH = k && scale ? rSum / k * scale : null;
  const angleHOH = k ? aSum / k : null;

  // The model, from the charges.
  const sites = 3 + light.length;
  let model = null;
  let confidence = null;
  let match = null;
  if (qh !== null) {
    let bestD = Infinity;
    for (const w of WATER_MODELS) {
      let d;
      if (sites === 3 && w.sites === 3) d = Math.abs(w.o - qo) + Math.abs(w.h - qh);
      else if (sites === 3 && w.sites === 4) d = Math.abs(w.m - qo) + Math.abs(w.h - qh);   // M charge on O
      else if (sites === 4 && w.sites === 4) d = Math.abs(w.m - qm) + Math.abs(w.h - qh) + Math.abs(qo);
      else if (sites === 5 && w.sites === 5) d = Math.abs(w.l - qm) + Math.abs(w.h - qh) + Math.abs(qo);
      else continue;
      if (d < bestD) { bestD = d; match = w; }
    }
    if (match && bestD < 0.004) { model = match.model; confidence = 'high'; } else if (match && bestD < 0.02) { model = match.model; confidence = 'low'; } else match = null;
  }
  const count = kind.members.length;
  const water = {
    model, confidence, sites,
    implicitM: sites === 3 && !!match && match.sites === 4,
    oType, hType, mType: mType || null, lType: lType || null,
    hTypes: [...hTypes].sort((a, b) => a - b),
    bondType, angleType,
    bondTypes: [...bondTypes.keys()].sort((a, b) => a - b),
    angleTypes: [...angleTypes.keys()].sort((a, b) => a - b),
    count,
    atoms: count * kind.natoms,
    oCharge: qo, hCharge: qh, mCharge: qm,
    rOH, angleHOH,
    qdist: match && match.qdist ? match.qdist : null,
    pairTip4p: null,
    note: ''
  };
  const du = DISTANCE_UNIT[units] || '';
  const geom = rOH !== null ? ` O-H ${rOH.toFixed(4)} Å, H-O-H ${angleHOH.toFixed(2)}°` : '';
  if (model) {
    water.note = `${fmtInt(count)} water molecules; charges match ${model}` +
      (water.implicitM ? ' with the M-site charge on O, as the LAMMPS tip4p pair styles expect' : '') + '.' +
      (geom ? ` Geometry from the coordinates:${geom}.` : '');
    if (match.note) water.note += ` ${match.note}`;
  } else if (qh !== null) {
    water.note = `${fmtInt(count)} water molecules; their charges (O ${fmtQ(qo)}, H ${fmtQ(qh)}` +
      (qm !== null ? `, M ${fmtQ(qm)}` : '') + ') match no model STEMKit knows.' + (geom ? ` Geometry:${geom}.` : '');
  } else {
    water.note = `${fmtInt(count)} water molecules (no charges in this atom style).`;
  }
  if (water.implicitM && bondType && angleType) {
    water.pairTip4p = `lj/cut/tip4p/long ${oType} ${hType} ${bondType} ${angleType} ${match.qdist}`;
  }
  if (!bondType && parsed.types.bond) notes.push('The water molecules have no bonds, so fix shake cannot hold them rigid; use fix rigid/small molecule or add bonds.');
  if (bondType && !angleType) notes.push('The water has bonds but no H-O-H angle: fix shake needs the angle (a) to keep water rigid.');
  if (hTypes.size > 1) notes.push(`Water hydrogens use ${hTypes.size} types (${[...hTypes].join(' ')}).`);
  if (du && rOH !== null && match && Math.abs(rOH - match.rOH) > 0.02) {
    notes.push(`The water O-H length in the file (${rOH.toFixed(3)} Å) differs from ${model}'s ${match.rOH} Å; ` +
      'SHAKE will pull it to the bond length of the Bond Coeffs.');
  }
  return water;
}

function fmtQ(q) { return q === null ? '?' : (q > 0 ? '+' : '') + (+q.toFixed(5)); }

/* Minimum-image vector from atom i to atom j (in the file's frame). */
function minImage(box, x, i, j, out = [0, 0, 0]) {
  const d0 = x[3 * j] - x[3 * i];
  const d1 = x[3 * j + 1] - x[3 * i + 1];
  const d2 = x[3 * j + 2] - x[3 * i + 2];
  const inv = box ? invert3(box.edges) : null;
  if (!inv) { out[0] = d0; out[1] = d1; out[2] = d2; return out; }
  const E = box.edges;
  // Solve d = f0 E0 + f1 E1 + f2 E2 for the fractions, then wrap them.
  let f0 = inv[0][0] * d0 + inv[1][0] * d1 + inv[2][0] * d2;
  let f1 = inv[0][1] * d0 + inv[1][1] * d1 + inv[2][1] * d2;
  let f2 = inv[0][2] * d0 + inv[1][2] * d1 + inv[2][2] * d2;
  f0 -= Math.round(f0); f1 -= Math.round(f1); f2 -= Math.round(f2);
  out[0] = f0 * E[0][0] + f1 * E[1][0] + f2 * E[2][0];
  out[1] = f0 * E[0][1] + f1 * E[1][1] + f2 * E[2][1];
  out[2] = f0 * E[0][2] + f1 * E[1][2] + f2 * E[2][2];
  return out;
}

/* Inverse of the matrix whose rows are the edge vectors (cached per box). */
const INV_CACHE = new WeakMap();
function invert3(E) {
  if (INV_CACHE.has(E)) return INV_CACHE.get(E);
  const [a, b, c] = E;
  const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  if (!det) return null;
  // inv such that for row vector f: d = f . E  =>  f = d . inv
  const inv = [
    [(b[1] * c[2] - b[2] * c[1]) / det, (a[2] * c[1] - a[1] * c[2]) / det, (a[1] * b[2] - a[2] * b[1]) / det],
    [(b[2] * c[0] - b[0] * c[2]) / det, (a[0] * c[2] - a[2] * c[0]) / det, (a[2] * b[0] - a[0] * b[2]) / det],
    [(b[0] * c[1] - b[1] * c[0]) / det, (a[1] * c[0] - a[0] * c[1]) / det, (a[0] * b[1] - a[1] * b[0]) / det]
  ];
  INV_CACHE.set(E, inv);
  return inv;
}

/* Bonds that are long for their units, or cross the box with image flags
   that do not say so (what LAMMPS warns "Inconsistent image flags" about). */
function checkBondLengths(parsed, idMap, units, notes) {
  const A = parsed.atoms;
  const B = parsed.bonds;
  const box = parsed.box;
  const scale = TO_ANGSTROM[units];
  let longest = 0;
  let longestId = null;
  let inconsistent = 0;
  const half = [box.lx / 2, box.ly / 2, box.lz / 2];
  const tmp = [0, 0, 0];
  for (let b = 0; b < B.n; b++) {
    const i = idMap.get(B.atoms[2 * b]);
    const j = idMap.get(B.atoms[2 * b + 1]);
    if (i < 0 || j < 0) continue;
    const d = minImage(box, A.x, i, j, tmp);
    const r = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
    if (r > longest) { longest = r; longestId = b; }
    if (A.image && !box.general) {
      // Unwrapped distance along each axis, as Domain::image_check does.
      const E = box.edges;
      const im = A.image;
      const x = A.x;
      const a0 = im[3 * i] - im[3 * j];
      const a1 = im[3 * i + 1] - im[3 * j + 1];
      const a2 = im[3 * i + 2] - im[3 * j + 2];
      let far = false;
      for (let c = 0; c < 3 && !far; c++) {
        const du = x[3 * i + c] - x[3 * j + c] + a0 * E[0][c] + a1 * E[1][c] + a2 * E[2][c];
        if (Math.abs(du) > half[c]) far = true;
      }
      if (far) inconsistent++;
    }
  }
  if (scale && longest * scale > 3.5) {
    notes.push(`The longest bond is ${(longest * scale).toFixed(2)} Å (bond at line ${B.line[longestId]}), long for a ` +
      'chemical bond: check the coordinates, or the image flags if the molecule crosses the box edge.');
  }
  if (inconsistent) {
    notes.push(`${fmtInt(inconsistent)} bond${inconsistent > 1 ? 's' : ''} cross the box but the image flags of ` +
      'their atoms do not say so; LAMMPS warns "Inconsistent image flags" and unwrapped coordinates ' +
      '(centre of mass, diffusion) will be wrong for those molecules.');
  }
}

/* ------------------------------------------------------------------ *
 * Groups
 * ------------------------------------------------------------------ */

/**
 * Suggested `group` commands for a system summarised by `summariseData`:
 * water, ions, solute, hydrogens and solute heavy atoms, and one group per
 * kind of solute molecule when there are several. Each is chosen so that
 * it holds exactly the atoms named (a type is used only when every atom of
 * it is in the group).
 *
 * @param {object} summary - What summariseData returned.
 * @returns {Array<{name:string, command:string, count:number, why:string}>}
 */
export function groupsFromData(summary) {
  const out = [];
  if (!summary || !summary.natoms) return out;
  const types = summary.types;
  const typeOnly = (list, role) => list.every(ty => types[ty - 1] && types[ty - 1].role === role);
  const water = summary.water;
  if (water) {
    const wt = [...new Set([water.oType, ...water.hTypes, water.mType, water.lType].filter(Boolean))].sort((a, b) => a - b);
    if (typeOnly(wt, 'water')) {
      out.push({
        name: 'water', command: `group water type ${wt.join(' ')}`, count: water.atoms,
        why: `The ${fmtInt(water.count)} water molecules${water.model ? ` (${water.model})` : ''}: for fix shake, ` +
          'a separate thermostat, or water analysis.'
      });
    }
  }
  const ionTypes = summary.ions.filter(io => io.allOfType).map(io => io.type);
  if (ionTypes.length && typeOnly(ionTypes, 'ion')) {
    const count = summary.ions.filter(io => io.allOfType).reduce((s, io) => s + io.count, 0);
    out.push({
      name: 'ions', command: `group ions type ${ionTypes.join(' ')}`, count,
      why: `The ${summary.ions.map(io => io.name).join(', ')} ions: often thermostatted with the water.`
    });
  }
  const hasWater = out.some(g => g.name === 'water');
  const hasIons = out.some(g => g.name === 'ions');
  const soluteAtoms = summary.solute.atoms;
  if (soluteAtoms && soluteAtoms < summary.natoms && (hasWater || hasIons)) {
    const sub = ['water', 'ions'].filter(nm => out.some(g => g.name === nm));
    const solventCount = out.filter(g => sub.includes(g.name)).reduce((s, g) => s + g.count, 0);
    if (summary.natoms - solventCount === soluteAtoms) {
      out.push({
        name: 'solute', command: `group solute subtract all ${sub.join(' ')}`, count: soluteAtoms,
        why: 'Everything that is not water or ions: for restraints, centring and a thermostat of its own.'
      });
    }
  }
  if (hasWater || hasIons) {
    const sub = ['water', 'ions'].filter(nm => out.some(g => g.name === nm));
    const count = out.filter(g => sub.includes(g.name)).reduce((s, g) => s + g.count, 0);
    if (sub.length === 2) {
      out.push({
        name: 'solvent', command: 'group solvent union water ions', count,
        why: 'Water and ions together: the usual second thermostat group next to the solute.'
      });
    }
  }
  const hTypes = summary.hydrogenTypes;
  if (hTypes.length) {
    const count = hTypes.reduce((s, ty) => s + types[ty - 1].count, 0);
    out.push({
      name: 'hydrogens', command: `group hydrogens type ${hTypes.join(' ')}`, count,
      why: 'Every hydrogen: the atoms fix shake constrains, and the ones to leave out of heavy-atom restraints.'
    });
    if (out.some(g => g.name === 'solute')) {
      const soluteH = hTypes.reduce((s, ty) => s + types[ty - 1].roleCounts.solute, 0);
      const heavy = soluteAtoms - soluteH;
      if (heavy > 0) {
        out.push({
          name: 'solute_heavy', command: 'group solute_heavy subtract solute hydrogens', count: heavy,
          why: 'Solute atoms other than hydrogen: the usual target of position restraints (fix spring/self).'
        });
      }
    }
  }
  // One group per kind of solute molecule when there are several kinds and
  // each kind has types of its own.
  const kinds = summary.solute.kinds;
  if (kinds.length > 1) {
    const used = new Map();
    for (const k of kinds) for (const ty of k.types) used.set(ty, (used.get(ty) || 0) + 1);
    const taken = new Set(out.map(g => g.name));
    for (const k of kinds.slice(0, 6)) {
      if (!k.types.every(ty => used.get(ty) === 1)) continue;
      if (!k.types.every(ty => types[ty - 1].role === 'solute')) continue;
      const total = k.types.reduce((s, ty) => s + types[ty - 1].count, 0);
      if (total !== k.count * k.atoms) continue;
      let name = sanitiseName(k.formula || `mol${k.atoms}`);
      while (taken.has(name)) name = `${name}_2`;
      taken.add(name);
      out.push({
        name, command: `group ${name} type ${k.types.join(' ')}`, count: total,
        why: `The ${fmtInt(k.count)} ${k.formula || `${k.atoms}-atom`} molecule${k.count > 1 ? 's' : ''}, whose atom types no other molecule uses.`
      });
    }
  }
  return out;
}

function sanitiseName(s) {
  const n = String(s).replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+/, '');
  return n || 'molecules';
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function fmt(v) { return Number.isFinite(v) ? String(+v.toPrecision(6)) : String(v); }
function fmtInt(n) { return Number(n).toLocaleString('en-GB'); }

/* 1 2 3 5 -> '1-3 5' (for messages), or LAMMPS's 1*3 with star. */
function compressList(list) {
  const s = [...list].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < s.length;) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(j > i + 1 ? `${s[i]}-${s[j]}` : j === i + 1 ? `${s[i]} ${s[j]}` : `${s[i]}`);
    i = j + 1;
  }
  return parts.join(' ');
}
