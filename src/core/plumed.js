/**
 * @module core/plumed
 *
 * PLUMED input-file generation: the one implementation behind both the MD
 * Workflow Generator page and the `stemkit-core` package.
 *
 * PLUMED [Tribello et al., Comput. Phys. Commun. 185 (2014) 604] drives
 * enhanced sampling by reading a plain-text input that declares collective
 * variables (CVs) and the bias acting on them. The file is easy to write badly:
 * an action renamed between releases, a switching function whose cutoff is
 * below the distance it is meant to switch at, or a grid that does not span the
 * CV all produce a run that starts successfully and yields meaningless free
 * energies.
 *
 * {@link generatePlumedInput} takes a plain description of the run and returns
 * the file together with what is wrong or risky about it. Messages use a
 * two-mark notation, `` `code` `` and `**strong**`, so they read as plain text
 * and a page can still typeset them.
 *
 * Three design points are worth stating, since each is easy to get wrong:
 *
 *   - **Version gating.** PLUMED renamed several actions at 2.10 (the
 *     multicolvar rewrite). A CV declares `minVersion` and, where one exists, a
 *     `fallback` action name for older releases. A CV the target cannot write
 *     is left out everywhere, its PRINT and bias arguments included, so the
 *     file never names a value nothing defines.
 *   - **The keyword table decides.** Given a table from `plumed-syntax`, a
 *     field the target release does not register is left out and the modules
 *     an action needs, those of the actions a shortcut expands into included,
 *     are read from the table, not from memory.
 *   - **What a biased value is.** Periodicity and range follow the component
 *     that is biased, not the CV type: `TORSIONS` gives a count of torsions in
 *     a range, and only `phi` and `phs` of `PUCKERING` are periodic. PLUMED
 *     compares a periodic grid with the period as text, so `-pi` is not
 *     `-3.1416`.
 */

import {
  CV_DEFS, BIAS_DEFS, FUNCTION_DEFS, REDUCTIONS, PREREQS
} from './plumed-catalogue.js';

export * from './plumed-catalogue.js';

/** PLUMED releases this module can target. */
export const PLUMED_VERSIONS = Object.freeze(['2.9', '2.10', '2.11']);

/** Default target when none is specified. */
export const DEFAULT_PLUMED_VERSION = '2.9';

/** Units PLUMED assumes when the input has no UNITS line. */
export const DEFAULT_UNITS = Object.freeze({ length: 'nm', energy: 'kj/mol', time: 'ps' });

/** How many nm one unit of each supported length is. */
export const LENGTH_IN_NM = Object.freeze({ nm: 1, A: 0.1, um: 1000, Bohr: 0.0529177210903 });

/** How many kJ/mol one unit of each supported energy is. */
export const ENERGY_IN_KJMOL = Object.freeze({
  'kj/mol': 1, 'kcal/mol': 4.184, eV: 96.48533212, Ha: 2625.499639, 'j/mol': 0.001
});

/** How many ps one unit of each supported time is. */
export const TIME_IN_PS = Object.freeze({ ps: 1, fs: 0.001, ns: 1000 });

const SWITCH_KEYS = Object.freeze(['R_0', 'D_0', 'D_MAX', 'NN', 'MM']);
const LABEL_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const REDUCTION_BY_KEY = Object.freeze(
  Object.fromEntries(REDUCTIONS.map(r => [r.k, r]))
);

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

/**
 * Compare dotted version strings.
 *
 * @param {string} have
 * @param {string} need
 * @returns {boolean} True when `have` is at least `need`.
 */
export function versionAtLeast(have, need) {
  const a = String(have).split('.').map(Number);
  const b = String(need).split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

/**
 * Is a CV definition available under a target version?
 *
 * @param {object} def - Catalogue entry.
 * @param {string} version
 * @returns {boolean}
 */
export function cvAvailable(def, version) {
  if (!def) return true;
  const v = version || DEFAULT_PLUMED_VERSION;
  if (Array.isArray(def.notIn) && def.notIn.includes(v)) return false;
  if (!def.minVersion) return true;
  return versionAtLeast(v, def.minVersion);
}

/**
 * Is a field's keyword part of the target release?
 *
 * @param {{since?:string, until?:string}} field
 * @param {string} version
 * @returns {boolean}
 */
export function fieldAvailable(field, version) {
  if (!field) return false;
  const v = version || DEFAULT_PLUMED_VERSION;
  if (field.since && !versionAtLeast(v, field.since)) return false;
  if (field.until && !versionAtLeast(field.until, v)) return false;
  return true;
}

/**
 * Resolve the action name to emit for a CV under a target version.
 *
 * When a CV requires a newer PLUMED than the target and declares a fallback,
 * the fallback name is emitted instead. Without a fallback the CV is
 * unavailable and the caller is told so. A fallback that is not an action
 * name (advice such as "ANGLES with GROUP and SWITCH") is never emitted:
 * written as an action it would stop PLUMED.
 *
 * @param {string} type - Catalogue key.
 * @param {object} def - Catalogue entry.
 * @param {string} version
 * @returns {{action:string|null, usedFallback:boolean, available:boolean}}
 */
export function resolveAction(type, def, version) {
  if (!def) return { action: null, usedFallback: false, available: false };
  const act = def.act || type;

  if (cvAvailable(def, version)) {
    return { action: act, usedFallback: false, available: true };
  }
  if (def.fallback && ACTION_NAME_RE.test(def.fallback)) {
    return { action: def.fallback, usedFallback: true, available: true };
  }
  return { action: null, usedFallback: false, available: false };
}

const ACTION_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/* Does the target get a line for this CV? A hand-written line always does. */
function cvWritten(cv, catalogue, version) {
  const def = cv && catalogue[cv.type];
  if (!def) return false;
  return !!def.isCustom || resolveAction(cv.type, def, version || DEFAULT_PLUMED_VERSION).available;
}

/**
 * The action name an instance emits: the catalogue's, or the one its variant
 * selector picks (`XANGLES`, `YANGLES`, `ZANGLES` share one entry).
 *
 * @param {{type:string, values?:object}} instance
 * @param {object} def
 * @returns {string}
 */
export function actionNameFor(instance, def) {
  if (!instance || !def) return '';
  if (def.isCustom) {
    const m = /^\s*([A-Z][A-Z0-9_]*)/.exec(str(instance.values && instance.values.__raw));
    return m ? m[1] : '';
  }
  const variant = (def.fields || []).find(f => f.variant);
  const picked = variant && instance.values && instance.values[variant.k];
  return picked || def.act || instance.type;
}

/**
 * Emit one `KEY=value` token for a field.
 *
 * Three shapes occur in the catalogue and are distinguished here:
 *
 *   - a flag contributes its bare keyword when truthy, and nothing otherwise;
 *   - a brace-delimited block (`SWITCH={RATIONAL R_0=0.3}`) is emitted as
 *     `KEY={...}`;
 *   - free text that already contains `KEY=` pairs is a raw fragment and is
 *     passed through verbatim, so a user can hand-write an option the form does
 *     not expose.
 *
 * @param {string[]} parts - Token accumulator, appended in place.
 * @param {{k:string, type?:string, variant?:boolean}} field
 * @param {*} value
 * @returns {void}
 */
export function pushFieldToken(parts, field, value) {
  if (!field || field.variant) return;

  if (field.type === 'flag') {
    if (value) parts.push(field.k);
    return;
  }
  if (value === undefined || value === null || String(value).trim() === '') return;

  const v = String(value).trim();
  if (field.type === 'text') {
    if (v.startsWith('{')) {
      parts.push(`${field.k}=${v}`);
      return;
    }
    // A raw fragment such as "NN=6 MM=12" is passed through unchanged, but a
    // bare numeric list must not be mistaken for one.
    if (/\w+=/.test(v) && !/^[\d.,\-]+$/.test(v)) {
      parts.push(v);
      return;
    }
  }
  parts.push(`${field.k}=${v}`);
}

/**
 * Bias methods that render some CV parameters redundant.
 *
 * Keyed by bias method, then by action name (or `*` for every CV). No method
 * does at present. Metadynamics once hid `NL_CUTOFF` and `NL_STRIDE`, but a
 * CV's neighbour list sets the cost of computing the CV, whatever biases it,
 * and `NLIST` without `NL_CUTOFF` stops PLUMED. The map and
 * {@link hiddenFieldsForBias} stay for a method that does manage a CV
 * parameter.
 */
export const BIAS_REDUNDANCY = Object.freeze({});

/**
 * Field keys to suppress for a CV under the active bias.
 *
 * Only biased CVs are affected; an unbiased CV keeps every parameter.
 *
 * @param {{type:string, bias?:boolean}} instance
 * @param {string} biasMethod
 * @param {Object<string, object>} catalogue
 * @returns {Set<string>}
 */
export function hiddenFieldsForBias(instance, biasMethod, catalogue = CV_DEFS) {
  const keys = new Set();
  if (!instance || !instance.bias) return keys;

  const map = BIAS_REDUNDANCY[biasMethod];
  if (!map) return keys;

  const def = catalogue[instance.type] || {};
  const act = def.act || instance.type;

  for (const k of map['*'] || []) keys.add(k);
  for (const k of map[act] || []) keys.add(k);
  for (const k of map[instance.type] || []) keys.add(k);
  return keys;
}

/* ------------------------------------------------------------------ *
 * Fields, reductions and components
 * ------------------------------------------------------------------ */

function isMulticolvar(def) {
  return !!def && (def.compStyle === 'dot' || def.compStyle === 'underscore');
}

function allowedReductions(def) {
  if (!isMulticolvar(def)) return [];
  const allow = Array.isArray(def.reductions) ? def.reductions : REDUCTIONS.map(r => r.k);
  return REDUCTIONS.filter(r => allow.includes(r.k));
}

function registered(syntax, action, key) {
  if (!syntax || !action || !syntax.has(action)) return true;
  return !!syntax.keyword(action, key);
}

/**
 * Reduction fields a multicolvar supports but does not list among its own
 * fields, so each keyword has exactly one source.
 *
 * @param {object} def
 * @param {{version?:string, syntax?:object, action?:string}} [options]
 * @returns {object[]}
 */
export function reductionFieldsFor(def, options = {}) {
  const own = new Set(((def && def.fields) || []).map(f => f.k));
  return allowedReductions(def).filter(r =>
    !own.has(r.k) &&
    registered(options.syntax, options.action || (def && (def.act || def.__key)), r.k));
}

/**
 * Every field an instance shows and emits under a target: the catalogue's own,
 * then the shared reductions, less anything the release does not register.
 *
 * Switching-function parameters the form folds into `SWITCH={...}` are kept
 * when the action registers `SWITCH`, since that is where they end up.
 *
 * @param {object} def
 * @param {{version?:string, syntax?:object, action?:string}} [options]
 * @returns {object[]}
 */
export function fieldsFor(def, options = {}) {
  if (!def) return [];
  const { version = DEFAULT_PLUMED_VERSION, syntax = null } = options;
  const action = options.action || def.act || def.__key || '';
  const folds = !!(def.switchSpeed || def.coordSwitch);
  const own = (def.fields || []).filter(f => {
    if (!fieldAvailable(f, version)) return false;
    if (f.variant || def.isCustom || f.k.startsWith('__')) return true;
    if (registered(syntax, action, f.k)) return true;
    return folds && SWITCH_KEYS.includes(f.k) && registered(syntax, action, 'SWITCH');
  });
  return own.concat(reductionFieldsFor(def, { syntax, action }));
}

/**
 * The values of one reduction as a list: nothing, one block, or several
 * numbered ones. A value may be an array or blocks separated by `;`.
 *
 * @param {*} value
 * @returns {string[]}
 */
export function reductionBlocks(value) {
  if (Array.isArray(value)) return value.map(str).filter(Boolean);
  const v = str(value);
  if (!v) return [];
  return v.split(/\s*;\s*/).map(str).filter(Boolean);
}

function reductionEnabled(instance, r) {
  const v = instance.values ? instance.values[r.k] : undefined;
  if (r.type === 'flag') return !!v;
  return reductionBlocks(v).length > 0;
}

/**
 * Is this an angle multicolvar weighted by a switching function on its bonds
 * (COORD_ANGLES, or ANGLES with SWITCH, which PLUMED turns into COORD_ANGLES)
 * on a release where a numbered MORE_THAN is broken?
 *
 * PLUMED 2.10 and 2.11 build `label_wmt1` from `label_lt1` instead of
 * `label_mt1`, so MORE_THAN1 either stops the run or, next to a numbered
 * LESS_THAN, silently repeats its values. It is an upstream typo:
 * src/multicolvar/MultiColvarShortcuts.cpp:173 writes `labout + "_lt" + istr`
 * where `"_mt"` is meant. An unnumbered MORE_THAN is computed correctly.
 *
 * @param {{type:string, values?:object}} instance
 * @param {object} def
 * @param {string} version
 * @returns {boolean}
 */
export function weightedAngleShortcut(instance, def, version) {
  if (!instance || !def || !versionAtLeast(version || DEFAULT_PLUMED_VERSION, '2.10')) return false;
  const action = actionNameFor(instance, def);
  if (action === 'COORD_ANGLES') return true;
  return action === 'ANGLES' && !blank((instance.values || {}).SWITCH);
}

/* The blocks of a reduction as they are written: a weighted angle
   multicolvar keeps only the first MORE_THAN, see weightedAngleShortcut. */
function blocksWritten(instance, def, r, version) {
  const blocks = reductionBlocks((instance.values || {})[r.k]);
  if (r.k === 'MORE_THAN' && blocks.length > 1 && weightedAngleShortcut(instance, def, version)) {
    return blocks.slice(0, 1);
  }
  return blocks;
}

/* How many eigenvectors a PCARMSD file holds, as the form says; at least one. */
function eigenvectorCount(values) {
  const n = Math.floor(Number(str(values && values.__eigenvectors)));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 1000) : 1;
}

/**
 * Expand `MOMENTS=2-4,6` into the moments it names.
 *
 * @param {string} spec
 * @returns {number[]}
 */
export function expandMoments(spec) {
  const out = [];
  for (const part of str(spec).split(',').map(str).filter(Boolean)) {
    const m = /^(\d+)-(\d+)$/.exec(part);
    if (m) {
      for (let i = Number(m[1]); i <= Number(m[2]) && out.length < 64; i++) out.push(i);
    } else if (/^\d+$/.test(part)) {
      out.push(Number(part));
    }
  }
  return out;
}

/**
 * The component suffixes a CV exposes, separator included: `['.mean',
 * '.morethan-1']` or `['_lessthan']`. An empty list means the bare label is
 * the value.
 *
 * PLUMED has two conventions. Classic multicolvars expose components of one
 * action (`label.mean`); the shortcut families create one action per
 * reduction, named `label_mean`. A reduction given several times is numbered
 * from one: `MORE_THAN1`, `MORE_THAN2` give `morethan-1`, `morethan-2`.
 *
 * @param {{type:string, values?:object}} instance
 * @param {Object<string, object>} [catalogue]
 * @param {{version?:string, syntax?:object}} [options]
 * @returns {string[]}
 */
export function componentsForCV(instance, catalogue = CV_DEFS, options = {}) {
  if (!instance) return [];
  const def = catalogue[instance.type] || {};
  const values = instance.values || {};

  if (def.isCustom) {
    return str(values.__components).split(/[,\s]+/).map(str).filter(Boolean)
      .map(c => (c.startsWith('.') || c.startsWith('_') ? c : `.${c}`));
  }
  const version = options.version || DEFAULT_PLUMED_VERSION;
  if (Array.isArray(def.components)) return def.components.map(c => `.${c}`);
  if (def.components === 'puckering') {
    const n = parseAtomList(values.ATOMS).count;
    return (n === 5 ? ['phs', 'amp', 'Zx', 'Zy'] : ['qx', 'qy', 'qz', 'phi', 'theta', 'amplitude'])
      .map(c => `.${c}`);
  }
  if (def.components === 'contactmap') {
    if (values.SUM || values.CMDIST) return [];
    const n = new Set((str(values.ATOMS).match(/\bATOMS(\d+)=/g) || [])).size;
    return Array.from({ length: Math.max(n, 1) }, (_, i) => `.contact-${i + 1}`);
  }
  if (def.components === 'propertymap') {
    const names = str(values.PROPERTY).split(',').map(str).filter(Boolean);
    return [...names, 'zzz'].map(c => `.${c}`);
  }
  if (def.components === 'pcarmsd') {
    // One eig-N per frame of EIGENVECTORS, counted from zero.
    return [...Array.from({ length: eigenvectorCount(values) }, (_, i) => `eig-${i}`), 'residual']
      .map(c => `.${c}`);
  }
  if (def.components === 'constant') {
    // From 2.10 a list of constants is one vector, named by the bare label.
    if (versionAtLeast(version, '2.10')) return [];
    // In 2.9 one number is a plain value too; only a list makes v-0, v-1, ...
    const list = str(values.VALUES).split(',').map(str).filter(Boolean);
    return list.length > 1 ? list.map((_, i) => `.v-${i}`) : [];
  }
  if (instance.type === 'PLANES') {
    const out = [];
    if (values.VMEAN) out.push('_vmean');
    if (values.VSUM) out.push('_vsum');
    return out;
  }
  if (def.componentsWhen) {
    const out = [];
    for (const [flag, comps] of Object.entries(def.componentsWhen)) {
      if (values[flag]) comps.forEach(c => out.push(`.${c}`));
    }
    if (out.length) return out;
  }
  if (!isMulticolvar(def)) return [];

  // The shortcut families exist from 2.10; in 2.9 every multicolvar is one
  // action with components.
  const sep = def.compStyle === 'underscore' && versionAtLeast(version, '2.10') ? '_' : '.';
  const action = actionNameFor(instance, def);
  const out = [];
  for (const r of allowedReductions(def)) {
    if (!registered(options.syntax, action, r.k) || !reductionEnabled(instance, r)) continue;
    if (r.type === 'flag') {
      out.push(sep + r.comp);
      continue;
    }
    const blocks = blocksWritten(instance, def, r, version);
    if (blocks.length === 1) out.push(sep + r.comp);
    else blocks.forEach((_, i) => out.push(`${sep}${r.comp}-${i + 1}`));
  }
  if (!blank(values.MOMENTS) && (def.fields || []).some(f => f.k === 'MOMENTS')) {
    for (const m of expandMoments(values.MOMENTS)) out.push(`${sep}moment-${m}`);
  }
  if (values.VMEAN && (def.fields || []).some(f => f.k === 'VMEAN')) out.push(`${sep}vmean`);
  return out;
}

/**
 * Every argument a configuration makes available to a bias, a function or
 * PRINT: CV labels and components, then function labels. A CV the target
 * release cannot write defines nothing, so it offers nothing.
 *
 * `power` is {@link lengthPower} of the value; a function's is 0, since the
 * builder does not know the unit of a function, so only the energy part of
 * a force constant on it follows the units.
 *
 * @param {object} config
 * @returns {Array<{arg:string, source:string, kind:'cv'|'function', power:number}>}
 */
export function availableArguments(config = {}) {
  const catalogue = config.catalogue || CV_DEFS;
  const options = { version: config.version, syntax: config.syntax };
  const out = [];
  for (const cv of config.cvs || []) {
    if (!cv || !cv.label) continue;
    const def = catalogue[cv.type] || {};
    if (def.isGroup || cv.isGroup) continue;
    if (catalogue[cv.type] && !cvWritten(cv, catalogue, config.version)) continue;
    const comps = componentsForCV(cv, catalogue, options);
    const power = (c) => lengthPower(cv.type, c, { values: cv.values });
    if (comps.length) comps.forEach(c => out.push({ arg: cv.label + c, source: cv.label, kind: 'cv', power: power(c) }));
    else out.push({ arg: cv.label, source: cv.label, kind: 'cv', power: power('') });
  }
  for (const fn of config.functions || []) {
    if (fn && fn.label) out.push({ arg: fn.label, source: fn.label, kind: 'function', power: 0 });
  }
  return out;
}

/**
 * The values the bias acts on, in the order its ARG lists them: each CV
 * with Bias on (the component chosen for it, or its first), then each
 * function with Bias on. A CV the target release cannot write has no value
 * to bias. generatePlumedInput builds its targets from this list, so the
 * page's per-argument starting values line up with the file's ARG.
 *
 * @param {object} config - As for generatePlumedInput: `cvs`, `functions`,
 *        `version`, `syntax`, `catalogue`.
 * @returns {Array<{arg:string, label:string, type:string, comp:string,
 *   source:object, kind:'cv'|'function', power:number}>} `source` is the CV
 *   or function; `power` as in {@link availableArguments}.
 */
export function biasedArguments(config = {}) {
  const catalogue = config.catalogue || CV_DEFS;
  const version = config.version || DEFAULT_PLUMED_VERSION;
  const out = [];
  for (const cv of config.cvs || []) {
    if (!cv) continue;
    const def = catalogue[cv.type] || {};
    if (!cv.bias || def.isGroup || cv.isGroup || def.noBias) continue;
    // A CV the target cannot write has no value to bias.
    if (catalogue[cv.type] && !cvWritten(cv, catalogue, version)) continue;
    const comps = componentsForCV(cv, catalogue, { version, syntax: config.syntax });
    let comp = str((cv.biasValues || {}).comp);
    if (comps.length && !comps.includes(comp)) comp = comps[0];
    if (!comps.length && def.compStyle === 'none') comp = '';
    out.push({
      arg: cv.label + comp, label: cv.label, type: cv.type, comp, source: cv, kind: 'cv',
      power: lengthPower(cv.type, comp, { values: cv.values })
    });
  }
  for (const fn of config.functions || []) {
    if (!fn || !fn.bias) continue;
    out.push({ arg: fn.label, label: fn.label, type: fn.type, comp: '', source: fn, kind: 'function', power: 0 });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Creating instances
 * ------------------------------------------------------------------ */

/* The range of the per-item value of the order parameters and angles, which
   their mean, lowest, highest and similar reductions share. TETRAHEDRAL is a
   sum of four cubes that PLUMED does not normalise: an ideal tetrahedron
   gives 8/sqrt(3) = 4.62. LOCAL_Q, FCCUBIC and TETRA_ANGULAR go negative.
   COORD_ANGLES's mean is a mean of angles weighted by their bonds. */
const PER_ITEM_RANGE = Object.freeze({
  Q6: [0, 1], Q4: [0, 1], Q3: [0, 1], SMAC: [0, 1], ATOMIC_SMAC: [0, 1], TETRA_RADIAL: [0, 1],
  LOCAL_Q6: [-1, 1], LOCAL_Q4: [-1, 1], LOCAL_Q3: [-1, 1], FCCUBIC: [-1, 1],
  TETRA_ANGULAR: [-3, 1], TETRAHEDRAL: [-4.62, 4.62],
  ANGLES: [0, Math.PI], XANGLES: [0, Math.PI], COORD_ANGLES: [0, Math.PI]
});
const ANGLE_ITEMS = new Set(['ANGLES', 'XANGLES', 'COORD_ANGLES']);
/* Starting grids for those ranges, wide enough for every value. */
const PER_ITEM_GRID = Object.freeze({
  '0,1': { min: '0.0', max: '1.0', bin: '200', sigma: '0.02' },
  '-1,1': { min: '-1.0', max: '1.0', bin: '200', sigma: '0.02' },
  '-3,1': { min: '-3.0', max: '1.0', bin: '400', sigma: '0.02' },
  '-4.62,4.62': { min: '-5.0', max: '5.0', bin: '200', sigma: '0.1' }
});
/* Reductions that count the items below, above or between thresholds: PLUMED
   sums a switching function of each item (MultiColvarShortcuts.cpp), so the
   value runs from 0 to the number of items, whatever the items are. */
const COUNT_REDUCTIONS = new Set(['morethan', 'lessthan', 'between']);
/* Reductions that add the items up. */
const SUM_REDUCTIONS = new Set(['sum', 'vsum']);
const LENGTH_TYPES = Object.freeze([
  'DISTANCE', 'RMSD', 'DRMSD', 'GYRATION', 'POSITION', 'INPLANEDISTANCES'
]);
const COORDINATION_TYPES = Object.freeze([
  'COORDINATION', 'COORDINATIONNUMBER', 'COORDINATIONNUMBER_ADV', 'COORDINATION_MOMENTS',
  'CONTACTMAP'
]);

/* How many atoms a list names, or 0 when it holds a label, a selection or a
   mistake, which only PLUMED can count. */
function atomsIn(spec) {
  // Counted, not listed: a range of a million atoms is one number here.
  const r = parseAtomList(spec, { limit: 0 });
  return r.labels.length || r.errors.length ? 0 : r.count;
}

/* How many items a multicolvar computes, when its atoms are written as
   numbers: one per SPECIES atom (SPECIESA when there are two sets) for the
   symmetry functions, one per numbered ATOMS for the angle and torsion
   families, one per triple for ANGLES and one per VECTORSTART, VECTOREND
   and GROUP atom for INPLANEDISTANCES (src/multicolvar/Angles.cpp,
   InPlaneDistances.cpp). Null when it cannot be told here, and for the
   angles PLUMED weights by a switching function (COORD_ANGLES, ANGLES with
   SWITCH), whose count is well under the number of angles. */
function itemCount(type, values = {}) {
  const has = (k) => !blank(values[k]);
  const numbered = () => new Set(str(values.ATOMS).match(/\bATOMS\d+=/g) || []).size;
  let n = 0;
  if (type === 'INPLANEDISTANCES') {
    n = atomsIn(values.VECTORSTART) * atomsIn(values.VECTOREND) * atomsIn(values.GROUP);
  } else if (type === 'ANGLES') {
    if (has('SWITCH')) return null;
    if (has('GROUP')) {
      const g = atomsIn(values.GROUP);
      n = g * (g - 1) * (g - 2) / 6;
    } else if (has('GROUPC')) {
      n = atomsIn(values.GROUPA) * atomsIn(values.GROUPB) * atomsIn(values.GROUPC);
    } else {
      const b = atomsIn(values.GROUPB);
      n = atomsIn(values.GROUPA) * b * (b - 1) / 2;
    }
  } else if (['TORSIONS', 'XYTORSIONS', 'XANGLES'].includes(type)) {
    n = numbered();
  } else if (((CV_DEFS[type] || {}).fields || []).some(f => f.k === 'SPECIES')) {
    n = atomsIn(has('SPECIESA') ? values.SPECIESA : values.SPECIES);
  }
  return n > 0 ? n : null;
}

/* The range the builder gives one item of a multicolvar, for the grid of a
   sum of them: the order parameters' own range, and the starting grid of a
   length or a coordination number. */
function itemRange(type) {
  if (PER_ITEM_RANGE[type]) return PER_ITEM_RANGE[type];
  if (LENGTH_TYPES.includes(type)) return [0, 5];
  if (COORDINATION_TYPES.includes(type)) return [0, 20];
  return null;
}

/* A starting grid from lo to hi for a count or a sum. A hill is a fifth of
   an item wide, as for a coordination number, or a hundredth of the range
   when that is wider, and there are enough bins for a spacing under half of
   SIGMA. With no bounds the generic 0..10 is kept, which the checks flag. */
function spanGrid(lo, hi) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
    return { min: '0.0', max: '10.0', bin: '200', sigma: '0.2' };
  }
  const a = Math.floor(lo);
  const b = Math.ceil(hi);
  const sigma = Math.max(0.2, Number(((b - a) / 100).toPrecision(1)));
  const bin = Math.max(200, Math.ceil((2 * (b - a)) / sigma / 100) * 100);
  return { min: a === 0 ? '0.0' : String(a), max: String(b), bin: String(bin), sigma: String(sigma) };
}

/**
 * What values a biased argument takes, which decides its grid and what is
 * checked about it. It follows the component, not only the CV type: the
 * `between` of TORSIONS is a count of torsions, not an angle, and of
 * PUCKERING only `phs` (five atoms) and `phi` (six) are periodic.
 *
 * @param {string} type - Catalogue key, or `FUNCTION_PERIODIC` for a function
 *        declared periodic.
 * @param {string} [comp] - The component, separator included (`.mean`,
 *        `_between`), or '' for the bare label.
 * @param {{values?:object, period?:string}} [options] - `values` of the CV;
 *        `period` is a function's `PERIODIC` value.
 * @returns {{periodic:string[]|null, range:number[]|null, angle:boolean,
 *   count:boolean, sum:boolean, items:number|null}} `periodic` is the period
 *   as PLUMED writes it; `range` the values a bounded quantity takes;
 *   `count` marks a count of items, from 0 to `items`; `sum` a sum of
 *   `items` values that is not a count. `items` is null when the atoms do
 *   not tell it.
 */
export function valueDomain(type, comp = '', options = {}) {
  const d = { periodic: null, range: null, angle: false, count: false, sum: false, items: null };
  const c = str(comp).replace(/^[._]/, '');
  const base = c.replace(/-\d+$/, '');
  const values = options.values || {};
  if (type === 'FUNCTION_PERIODIC') {
    const parts = str(options.period).split(',').map(str);
    if (parts.length === 2 && parts[0] && parts[1]) d.periodic = parts;
    return d;
  }
  if (type === 'TORSION') return { ...d, periodic: ['-pi', 'pi'] };
  if (type === 'ANGLE') return { ...d, range: [0, Math.PI], angle: true };
  if (type === 'PUCKERING') {
    if (c === 'phs') d.periodic = ['-pi', 'pi'];
    else if (c === 'phi') d.periodic = ['0', '2pi'];
    else if (c === 'theta') Object.assign(d, { range: [0, Math.PI], angle: true });
    return d;
  }
  if (type === 'CONTACTMAP') {
    // Each contact is WEIGHT (s(r) - REFERENCE) (colvar/ContactMap.cpp): one
    // switching function, from 0 to 1, until a weight or a reference is
    // given. SUM adds them, which counts the contacts made.
    const text = str(values.ATOMS);
    if (/\b(REFERENCE|WEIGHT)\d*=/.test(text) || values.CMDIST) return d;
    if (/^contact-\d+$/.test(c)) return { ...d, range: [0, 1] };
    if (!c && values.SUM) return { ...d, count: true, items: new Set(text.match(/\bATOMS\d+=/g) || []).size || null };
    return d;
  }
  const multi = isMulticolvar(CV_DEFS[type]);
  if (multi && (COUNT_REDUCTIONS.has(base) || SUM_REDUCTIONS.has(base))) {
    const items = itemCount(type, values);
    const per = PER_ITEM_RANGE[type];
    // A sum of values between 0 and 1 counts too: Q6 summed over 64 atoms
    // is at most 64.
    if (COUNT_REDUCTIONS.has(base) || (per && per[0] === 0 && per[1] === 1)) {
      return { ...d, count: true, items };
    }
    return { ...d, sum: true, items, range: per && items ? [items * per[0], items * per[1]] : null };
  }
  if (PER_ITEM_RANGE[type]) {
    d.range = PER_ITEM_RANGE[type].slice();
    d.angle = ANGLE_ITEMS.has(type);
  }
  return d;
}

/* A starting grid for a domain, or null when the domain says nothing. */
function gridForDomain(d, type, comp) {
  if (d.periodic) return { min: d.periodic[0], max: d.periodic[1] };
  if (d.angle) return { min: '0.0', max: 'pi' };
  if (d.count) return spanGrid(0, d.items);
  if (d.sum) {
    // N items each in lo..hi add up to N lo..N hi: 98 in-plane distances of
    // up to 5 nm, or 100 coordination numbers of up to 20.
    const one = itemRange(type);
    return d.items && one ? spanGrid(d.items * one[0], d.items * one[1]) : spanGrid();
  }
  if (d.range && PER_ITEM_GRID[d.range.join(',')]) return { ...PER_ITEM_GRID[d.range.join(',')] };
  if (d.range) return spanGrid(d.range[0], d.range[1]);
  if (type === 'PUCKERING') {
    // Cremer-Pople coordinates and amplitudes are lengths of a few hundredths
    // of a nanometre; the amplitude is never negative.
    return /^(amp|amplitude)$/.test(str(comp).replace(/^[._]/, ''))
      ? { min: '0.0', max: '1.0', bin: '200', sigma: '0.01' }
      : { min: '-1.0', max: '1.0', bin: '400', sigma: '0.01' };
  }
  return null;
}

/**
 * Starting grid and hill width for a CV type. They are placeholders for the
 * range a CV usually spans, to be replaced by what a trial run shows.
 *
 * @param {string} type
 * @param {string} [comp] - The biased component; without it the one the type
 *        biases first.
 * @param {{values?:object}} [options] - The CV's values, for a count whose
 *        largest value follows from them.
 * @returns {{comp:string, min:string, max:string, bin:string, sigma:string}}
 */
export function defaultBiasValues(type, comp, options = {}) {
  const base = { comp: '', min: '0.0', max: '10.0', bin: '200', sigma: '0.1' };
  const fixed = {
    PATHMSD: { min: '1.0', max: '10.0', sigma: '0.5', comp: '.sss' },
    PROPERTYMAP: { comp: '.zzz' },
    PCARMSD: { comp: '.residual' },
    PROJECTION_ON_AXIS: { min: '-5.0', max: '5.0', comp: '.proj' }
  }[type];
  const out = { ...base, ...(fixed || {}) };
  if (comp !== undefined && comp !== null) out.comp = str(comp);
  const grid = gridForDomain(valueDomain(type, out.comp, options), type, out.comp);
  if (grid) return { ...out, ...grid };
  if (fixed) return out;
  if (LENGTH_TYPES.includes(type)) {
    // A component of a distance has a sign; the distance itself does not.
    const signed = type === 'DISTANCE' && /^[._]?[xyz]$/.test(out.comp);
    return { ...out, min: signed ? '-5.0' : '0.0', max: '5.0', sigma: '0.05' };
  }
  if (COORDINATION_TYPES.includes(type)) return { ...out, max: '20.0', sigma: '0.2' };
  // PLANE's components are those of a cross product of two bond vectors, in
  // nm² and of either sign.
  if (type === 'PLANE') return { ...out, min: '-1.0', max: '1.0', bin: '400', sigma: '0.01' };
  return out;
}

/**
 * The power of length in the unit of a biased value, which is how its grid
 * bounds and SIGMA scale under `UNITS LENGTH`, and with them the AT, KAPPA
 * and the other values of a restraint on it (see {@link biasKeywordUnit}):
 * 1 for a length (DISTANCE, RMSD, a radius of gyration, a sum of in-plane
 * distances), 2 for an area (PLANE, RMSD or DRMSD with SQUARED, GYRATION
 * TYPE=TRACE), R_POWER for COORDINATION_MOMENTS, 0 for anything else
 * (angles, counts, coordination numbers, order parameters, and the values
 * whose unit the builder does not know, which start from the generic 0..10
 * grid).
 *
 * @param {string} type - Catalogue key.
 * @param {string} [comp] - The biased component, separator included, or ''.
 * @param {{values?:object}} [options] - The CV's values: TYPE of GYRATION,
 *        SQUARED of RMSD, R_POWER, and the atoms of a count.
 * @returns {number}
 */
export function lengthPower(type, comp = '', options = {}) {
  const values = options.values || {};
  const c = str(comp).replace(/^[._]/, '');
  const base = c.replace(/-\d+$/, '');
  const d = valueDomain(type, str(comp), options);
  if (d.periodic || d.angle || d.count || d.range) return 0;
  if (type === 'COORDINATION_MOMENTS') {
    // Each item is the sum of s(r) r^k over the neighbours, k = R_POWER, and
    // moment-m the mean m-th power of its spread (symfunc/CoordinationNumbers.cpp).
    const k = Number(str(values.R_POWER));
    if (!Number.isFinite(k) || !str(values.R_POWER)) return 0;
    const m = /^moment-(\d+)$/.exec(c);
    return m ? k * Number(m[1]) : k;
  }
  if (type === 'PLANE') return 2;
  if (type === 'PUCKERING' || type === 'PROJECTION_ON_AXIS') return 1;
  if (!LENGTH_TYPES.includes(type)) return 0;
  // Counts of the distances below, above or between thresholds.
  if (['lessthan', 'morethan', 'between'].includes(base)) return 0;
  // SCALED_COMPONENTS are fractions of the cell vectors.
  if (type === 'DISTANCE' && /^[abc]$/.test(c)) return 0;
  if (type === 'GYRATION') {
    const kind = str(values.TYPE).toUpperCase();
    if (kind === 'KAPPA2') return 0;
    if (kind === 'TRACE') return 2;
  }
  if ((type === 'RMSD' || type === 'DRMSD') && values.SQUARED === true) return 2;
  return 1;
}

/**
 * The unit of a bias keyword as powers of length and energy, from what
 * PLUMED computes with it (src/bias/*.cpp), for an argument whose unit is
 * length to the power `power` (see {@link lengthPower}):
 *
 *   RESTRAINT          ½ KAPPA (x - AT)² + SLOPE (x - AT)
 *   UPPER/LOWER_WALLS  KAPPA ((x - AT ± OFFSET) / EPS)^EXP
 *   MOVINGRESTRAINT    ½ KAPPAn (x - ATn)² at STEPn, interpolated between
 *   ABMD               ½ KAPPA (ρ - ρmin)², ρ = (x - TO)²; NOISE and MIN are ρ
 *   METAD, PBMETAD     HEIGHT; OPES_METAD BARRIER; SIGMA in the unit of x
 *
 * EPS is in the unit of x too, but its starting value of 1 is kept as it
 * reads, as users write it, so a wall's KAPPA carries the length instead:
 * energy per (unit of x)^EXP, the same energy for any EPS left as it was.
 * PLUMED converts none of these itself; they are read in the file's units.
 *
 * @param {string} method - Key of BIAS_DEFS (`restraint`, `upper`, `lower`,
 *        `moving`, `abmd`, `metad`...); a wall or restraint card uses its type.
 * @param {string} key - The keyword, in either case (`KAPPA` or `kappa`).
 * @param {{power?:number, exp?:number|string}} [options] - `exp` is the wall's
 *        EXP for this argument; blank or not a number is PLUMED's 2.
 * @returns {{length:number, energy:number}|null} Null for a keyword with no
 *          unit (PACE, EXP, EPS, STEP0, BIASFACTOR, TEMP, FILE...).
 */
export function biasKeywordUnit(method, key, options = {}) {
  const k = str(key).toUpperCase();
  const p = Number(options.power) || 0;
  const e = str(options.exp) !== '' && Number.isFinite(Number(str(options.exp))) ? Number(str(options.exp)) : 2;
  const unit = (length, energy) => ({ length: length || 0, energy });
  if (k === 'HEIGHT' || k === 'BARRIER') return unit(0, 1);
  switch (method) {
    case 'restraint':
      return { AT: unit(p, 0), KAPPA: unit(-2 * p, 1), SLOPE: unit(-p, 1) }[k] || null;
    case 'moving':
      if (/^AT\d+$/.test(k)) return unit(p, 0);
      return /^KAPPA\d+$/.test(k) ? unit(-2 * p, 1) : null;
    case 'upper':
    case 'lower':
      return { AT: unit(p, 0), OFFSET: unit(p, 0), KAPPA: unit(-p * e, 1) }[k] || null;
    case 'abmd':
      return { TO: unit(p, 0), KAPPA: unit(-4 * p, 1), NOISE: unit(2 * p, 0), MIN: unit(2 * p, 0) }[k] || null;
    case 'metad':
    case 'wt_metad':
    case 'pbmetad':
    case 'opes':
      return k === 'SIGMA' ? unit(p, 0) : null;
    default:
      return null;
  }
}

/**
 * A new CV instance with the catalogue's starting values.
 *
 * @param {string} type - Catalogue key.
 * @param {number|string} seq - Used for the id and the first label.
 * @param {{catalogue?:object, version?:string, syntax?:object, label?:string,
 *   values?:object}} [options]
 * @returns {object|null} Null when the catalogue has no such entry.
 */
export function createCV(type, seq, options = {}) {
  const catalogue = options.catalogue || CV_DEFS;
  const def = catalogue[type];
  if (!def) return null;

  const inst = {
    id: `cv${seq}`,
    type,
    label: options.label || `cv${seq}`,
    bias: !def.isGroup && !def.noBias && !def.noBiasDefault,
    isGroup: !!def.isGroup,
    noBias: !!def.noBias,
    values: {},
    biasValues: defaultBiasValues(type)
  };
  for (const f of def.fields || []) inst.values[f.k] = f.def;
  for (const r of reductionFieldsFor(def, options)) inst.values[r.k] = r.def;
  Object.assign(inst.values, options.values || {});

  if (isMulticolvar(def)) {
    // A multicolvar is only usable once it reduces to a scalar.
    // An entry's own starting reduction comes first; MEAN otherwise.
    const any = allowedReductions(def).some(r => reductionEnabled(inst, r));
    if (!any && def.seed) Object.assign(inst.values, def.seed);
    else if (!any && allowedReductions(def).some(r => r.k === 'MEAN')) inst.values.MEAN = true;
  }
  const comps = componentsForCV(inst, catalogue, options);
  let comp = inst.biasValues.comp;
  if (comps.length && !comps.includes(comp)) comp = comps[0];
  if (!comps.length && def.compStyle) comp = '';
  // The grid suits the component biased, which may not be the type's first.
  inst.biasValues = defaultBiasValues(type, comp, { values: inst.values });
  return inst;
}

/**
 * A new function instance.
 *
 * @param {string} type - Key of {@link FUNCTION_DEFS}.
 * @param {number|string} seq
 * @param {{label?:string, args?:string[], values?:object}} [options]
 * @returns {object|null}
 */
export function createFunction(type, seq, options = {}) {
  const def = FUNCTION_DEFS[type];
  if (!def) return null;
  const fn = {
    id: `fn${seq}`,
    type,
    label: options.label || `f${seq}`,
    args: Array.isArray(options.args) ? options.args.slice() : [],
    values: {},
    bias: false,
    biasValues: { comp: '', min: '-5.0', max: '5.0', bin: '200', sigma: '0.1' }
  };
  for (const f of def.fields || []) fn.values[f.k] = f.def;
  Object.assign(fn.values, options.values || {});
  return fn;
}

/* ------------------------------------------------------------------ *
 * Lines
 * ------------------------------------------------------------------ */

function switchBlockFrom(values, keys) {
  const parts = [];
  for (const k of keys) {
    if (!blank(values[k])) parts.push(`${k}=${str(values[k])}`);
  }
  return parts.length ? `SWITCH={RATIONAL ${parts.join(' ')}}` : '';
}

function pushReduction(parts, r, blocks) {
  if (r.type === 'flag') {
    if (blocks) parts.push(r.k);
    return;
  }
  if (blocks.length === 1) pushFieldToken(parts, { k: r.k, type: 'text' }, blocks[0]);
  else blocks.forEach((b, i) => pushFieldToken(parts, { k: `${r.k}${i + 1}`, type: 'text' }, b));
}

/* Is a field set: a flag on, or a value typed? */
function isSet(field, value) {
  return field && field.type === 'flag' ? !!value : !blank(value);
}

/**
 * Build the PLUMED line for one CV instance.
 *
 * A field is written under its own keyword, or the one its `writeAs` names;
 * one whose `excludedBy` fields are set is left out, since PLUMED reads only
 * one of the two ways of giving the same thing and stops at the other.
 *
 * @param {{type:string, label:string, values?:object, bias?:boolean}} instance
 * @param {Object<string, object>} [catalogue]
 * @param {{version?:string, biasMethod?:string, syntax?:object}} [options]
 * @returns {{line:string|null, warnings:string[], usedFallback:boolean, action:string|null}}
 */
export function buildCVLine(instance, catalogue = CV_DEFS, options = {}) {
  const { version = DEFAULT_PLUMED_VERSION, biasMethod = 'none', syntax = null } = options;
  const warnings = [];

  if (!instance || !instance.type) {
    return { line: null, warnings: ['CV instance has no type.'], usedFallback: false, action: null };
  }

  const def = catalogue[instance.type];
  if (!def) {
    return {
      line: null,
      warnings: [`Unknown CV type "${instance.type}".`],
      usedFallback: false,
      action: null
    };
  }

  const label = instance.label || instance.type.toLowerCase();
  const values = instance.values || {};

  if (def.isCustom) {
    const raw = str(values.__raw);
    if (!raw) warnings.push(`Custom CV (${label}) is empty, type a PLUMED action.`);
    // A few actions take no label (VES_OUTPUT_FES, WHAM_WEIGHTS): PLUMED
    // stops at LABEL= on them, so such a line is written without one.
    const line = instance.noLabel ? raw : `${label}: ${raw}`;
    return { line, warnings, usedFallback: false, action: actionNameFor(instance, def) || null };
  }

  const resolved = resolveAction(instance.type, def, version);
  if (!resolved.available) {
    const hint = def.olderHint || (def.fallback && !ACTION_NAME_RE.test(def.fallback) ? def.fallback : '');
    return {
      line: null,
      warnings: [
        `${instance.type} (${label}) requires PLUMED ${def.minVersion} or newer; ` +
        `target is ${version} and no fallback action exists, so it is left out of the file, ` +
        'with everything that refers to it.' +
        (hint ? ` In PLUMED ${version} write ${hint} instead.` : '')
      ],
      usedFallback: false,
      action: null
    };
  }
  if (resolved.usedFallback) {
    warnings.push(
      `${instance.type} is named ${def.fallback} in PLUMED ${version}; ` +
      `emitted the older action name.`
    );
  }
  const action = resolved.usedFallback ? resolved.action : actionNameFor(instance, def);

  const hidden = hiddenFieldsForBias(instance, biasMethod, catalogue);
  const fields = fieldsFor(def, { version, syntax, action });
  const valueOf = (f) => (Object.prototype.hasOwnProperty.call(values, f.k) ? values[f.k] : f.def);
  const byKey = new Map(fields.map(f => [f.k, f]));
  const excluded = (f) => (f.excludedBy || []).some(k => byKey.has(k) && isSet(byKey.get(k), valueOf(byKey.get(k))));

  // Order parameters always fold the switching parameters into SWITCH={...}.
  // Two-group COORDINATION does so only when D_MAX is given, since D_MAX is a
  // parameter of the block and not a keyword of the action.
  let folded = [];
  if (def.switchSpeed) folded = SWITCH_KEYS.slice();
  else if (def.coordSwitch && !blank(values.D_MAX)) folded = SWITCH_KEYS.slice();

  const parts = [];
  for (const f of fields) {
    if (hidden.has(f.k) || folded.includes(f.k) || f.k.startsWith('__') || excluded(f)) continue;
    const v = valueOf(f);
    if (f.required && blank(v)) {
      warnings.push(`${instance.type} (${label}) is missing required \`${f.k}\`.`);
    }
    if (f.pairedWith && isSet(f, v) && byKey.has(f.pairedWith) &&
      !isSet(byKey.get(f.pairedWith), valueOf(byKey.get(f.pairedWith)))) {
      warnings.push(
        `${instance.type} (${label}) sets \`${f.k}\` without \`${f.pairedWith}\`; PLUMED needs both.`);
    }
    const r = REDUCTION_BY_KEY[f.k];
    if (r && isMulticolvar(def)) {
      const blocks = r.type === 'flag' ? v : blocksWritten(instance, def, r, version);
      if (r.type !== 'flag' && blocks.length < reductionBlocks(v).length) {
        warnings.push(
          `${instance.type} (${label}): PLUMED ${version} computes a numbered \`MORE_THAN\` of ` +
          'angles weighted by a SWITCH from the LESS_THAN values (an upstream bug), so only the ' +
          `first threshold, \`${blocks[0]}\`, is written. Add a second ${instance.type} for another one.`);
      }
      pushReduction(parts, r, blocks);
    } else {
      pushFieldToken(parts, f.writeAs ? { ...f, k: f.writeAs } : f, v);
    }
  }
  if (folded.length) {
    const present = Object.fromEntries(
      fields.filter(f => folded.includes(f.k)).map(f => [f.k, valueOf(f)]));
    for (const f of fields) {
      if (folded.includes(f.k) && f.required && blank(present[f.k])) {
        warnings.push(`${instance.type} (${label}) is missing required \`${f.k}\`.`);
      }
    }
    const block = switchBlockFrom(present, ['R_0', 'D_0', 'NN', 'MM', 'D_MAX']);
    if (block) parts.push(block);
  }

  const line = parts.length ? `${label}: ${action} ${parts.join(' ')}` : `${label}: ${action}`;
  return { line, warnings, usedFallback: resolved.usedFallback, action };
}

/**
 * Build a rational switching-function block.
 *
 * PLUMED's rational switch is
 *
 *   s(r) = [1 - ((r - d0)/r0)^n] / [1 - ((r - d0)/r0)^m],   m = 2n when m = 0.
 *
 * `D_MAX` is worth setting: beyond it the function is exactly zero. The
 * actions built on contact matrices (COORDINATIONNUMBER, Q6, ...) then search
 * neighbours with linked cells, often a large speedup; COORDINATION has none
 * and still visits every pair, so there only NLIST cuts the cost. D_MAX must
 * sit comfortably above r0, or contacts are truncated while the switch is still
 * appreciable.
 *
 * @param {{r0:number, d0?:number, nn?:number, mm?:number, dmax?:number}} params
 * @returns {{block:string, warnings:string[]}}
 */
export function buildSwitchBlock(params = {}) {
  const { r0, d0 = 0, nn = 6, mm = 0, dmax } = params;
  const warnings = [];

  if (!Number.isFinite(r0) || r0 <= 0) {
    return { block: '', warnings: ['Switching function requires a positive R_0.'] };
  }

  const parts = [`RATIONAL R_0=${r0}`];
  if (d0) parts.push(`D_0=${d0}`);
  if (nn !== 6) parts.push(`NN=${nn}`);
  if (mm) parts.push(`MM=${mm}`);

  if (Number.isFinite(dmax)) {
    parts.push(`D_MAX=${dmax}`);
    // At r = d0 + 2*r0 the rational switch has decayed to roughly 1-2%.
    if (dmax < d0 + 2 * r0) {
      warnings.push(
        `D_MAX=${dmax} is close to R_0=${r0}; the switching function is still ` +
        `appreciable there, so contacts will be truncated abruptly. ` +
        `Consider D_MAX >= ${(d0 + 2 * r0).toFixed(3)}.`
      );
    }
  } else {
    warnings.push(
      'No D_MAX set. Beyond D_MAX the function is exactly zero, and the actions built ' +
      'on contact matrices (COORDINATIONNUMBER, Q6, ...) then use linked cells, often a ' +
      'substantial speedup for large groups. COORDINATION has no linked cells: there ' +
      'only NLIST reduces the cost.'
    );
  }

  return { block: `{${parts.join(' ')}}`, warnings };
}

/**
 * Value of the rational switching function at a distance.
 *
 * @param {number} r
 * @param {{r0:number, d0?:number, nn?:number, mm?:number, dmax?:number}} params
 * @returns {number} Between 0 and 1; NaN when `r0` is not positive.
 */
export function rationalSwitch(r, params = {}) {
  const { r0, d0 = 0, nn = 6, dmax } = params;
  const mm = params.mm ? params.mm : 2 * nn;
  if (!Number.isFinite(r0) || r0 <= 0 || !Number.isFinite(r)) return NaN;
  if (Number.isFinite(dmax) && r >= dmax) return 0;
  const x = (r - d0) / r0;
  if (x <= 0) return 1;
  if (Math.abs(x - 1) < 1e-9) return nn / mm;
  return (1 - Math.pow(x, nn)) / (1 - Math.pow(x, mm));
}

/**
 * Build the line for one function of other values.
 *
 * @param {{type:string, label:string, args?:string[], values?:object}} fn
 * @param {{known?:Set<string>}} [options] - `known` lists the arguments
 *        defined above the function; a reference outside it is reported.
 * @returns {{line:string|null, warnings:string[]}}
 */
export function buildFunctionLine(fn, options = {}) {
  const warnings = [];
  if (!fn || !fn.type) return { line: null, warnings: ['Function has no type.'] };
  const def = FUNCTION_DEFS[fn.type];
  if (!def) return { line: null, warnings: [`Unknown function type "${fn.type}".`] };

  const label = fn.label || fn.type.toLowerCase();
  const args = (fn.args || []).map(str).filter(Boolean);
  const values = fn.values || {};

  if (!args.length) {
    warnings.push(`${fn.type} (${label}) has no arguments. Pick the values it combines.`);
  }
  if (options.known) {
    for (const a of args) {
      if (!options.known.has(a)) {
        warnings.push(`${fn.type} (${label}) uses \`${a}\`, which nothing above it defines.`);
      }
    }
  }

  const parts = [`ARG=${args.join(',')}`];
  const n = args.length;

  if (fn.type === 'COMBINE') {
    for (const key of ['COEFFICIENTS', 'PARAMETERS', 'POWERS']) {
      const v = str(values[key]);
      if (!v) continue;
      const count = v.split(',').map(str).filter(Boolean).length;
      if (n && count !== n) {
        warnings.push(
          `${fn.type} (${label}): \`${key}\` has ${count} value${count === 1 ? '' : 's'} ` +
          `for ${n} argument${n === 1 ? '' : 's'}. PLUMED needs one per argument.`);
      }
      parts.push(`${key}=${v}`);
    }
    if (values.NORMALIZE) parts.push('NORMALIZE');
  } else {
    const vars = str(values.VAR);
    const names = vars ? vars.split(',').map(str).filter(Boolean) : [];
    if (names.length && n && names.length !== n) {
      warnings.push(
        `${fn.type} (${label}): \`VAR\` names ${names.length} variable${names.length === 1 ? '' : 's'} ` +
        `for ${n} argument${n === 1 ? '' : 's'}.`);
    }
    if (!names.length && n > 3) {
      warnings.push(
        `${fn.type} (${label}) has ${n} arguments but no \`VAR\`. Without it only ` +
        '`x`, `y` and `z` are defined; name one variable per argument.');
    }
    if (names.length) parts.push(`VAR=${names.join(',')}`);
    const func = str(values.FUNC);
    if (!func) warnings.push(`${fn.type} (${label}) has no \`FUNC\` expression.`);
    // PLUMED splits the line on spaces, so an expression is written without them.
    parts.push(`FUNC=${func.replace(/\s+/g, '')}`);
  }

  const periodic = str(values.PERIODIC) || 'NO';
  if (periodic.toUpperCase() !== 'NO' && !/^[^,]+,[^,]+$/.test(periodic)) {
    warnings.push(
      `${fn.type} (${label}): \`PERIODIC\` is either \`NO\` or the two ends of the period, ` +
      'such as `-pi,pi`.');
  }
  parts.push(`PERIODIC=${periodic}`);

  return { line: `${label}: ${fn.type} ${parts.join(' ')}`, warnings };
}

/* ------------------------------------------------------------------ *
 * Bias
 * ------------------------------------------------------------------ */

const LEGACY_PARAM_KEYS = Object.freeze({
  pace: 'PACE', height: 'HEIGHT', biasfactor: 'BIASFACTOR', temp: 'TEMP', barrier: 'BARRIER',
  at: 'AT', kappa: 'KAPPA', slope: 'SLOPE', at0: 'AT0', at1: 'AT1', step0: 'STEP0',
  step1: 'STEP1', file: 'FILE', to: 'TO', exp: 'EXP', eps: 'EPS', offset: 'OFFSET'
});

/* The first releases of this module took lower-case parameters and one
   comma-separated list per grid keyword. Both are still read. */
function normaliseParams(method, params = {}) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (LEGACY_PARAM_KEYS[k]) out[LEGACY_PARAM_KEYS[k]] = v;
    else out[k] = v;
  }
  if (method === 'moving' && params.kappa !== undefined) {
    if (out.KAPPA0 === undefined) out.KAPPA0 = params.kappa;
    if (out.KAPPA1 === undefined) out.KAPPA1 = params.kappa;
    delete out.KAPPA;
  }
  if (method === 'opes' && params.sigma !== undefined) out.SIGMA = params.sigma;
  return out;
}

function listAt(value, i, n) {
  const v = str(value);
  if (!v) return '';
  const parts = v.split(',').map(str);
  if (parts.length === 1 && n > 1) return parts[0];
  return parts[i] === undefined ? '' : parts[i];
}

function parseNumber(value) {
  const t = str(value).toLowerCase();
  if (!t) return null;
  const m = /^([+-]?)(\d*\.?\d*)\*?pi$/.exec(t);
  if (m) {
    const k = m[2] === '' ? 1 : Number(m[2]);
    return (m[1] === '-' ? -1 : 1) * k * Math.PI;
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const BIAS_LABEL = Object.freeze({
  metad: 'metad', wt_metad: 'metad', pbmetad: 'pb', opes: 'opes', restraint: 'restraint',
  moving: 'steer', upper: 'uwall', lower: 'lwall', abmd: 'abmd'
});

/**
 * The label a bias line gets: the one asked for, the method's `LABEL`
 * parameter, or the method's usual name.
 *
 * @param {string} method
 * @param {object} [params]
 * @param {string} [label]
 * @returns {string}
 */
export function biasLabelFor(method, params = {}, label = '') {
  return str(label) || str(params && params.LABEL) || BIAS_LABEL[method] || '';
}

/* How often OPES rewrites its state when nothing else is asked: a hundred
   kernels, as in PLUMED's own example (STATE_WSTRIDE=500*100). Waiting for
   the MD engine's checkpoints writes nothing under LAMMPS, which signals
   none, and under GROMACS 2025 nothing before the first periodic checkpoint
   and then the whole state at every step. */
function defaultStateStride(pace) {
  const n = Number(str(pace));
  return Number.isInteger(n) && n > 0 ? String(n * 100) : '50000';
}

/**
 * Build the bias block.
 *
 * Each target carries its own argument and, for the metadynamics family, its
 * own grid and hill width: `{arg, label, type, min, max, bin, sigma}`. The
 * older form, a list of `{label}` with lower-case parameters, is accepted too.
 *
 * @param {string} method - 'wt_metad' | 'metad' | 'pbmetad' | 'opes' |
 *        'restraint' | 'moving' | 'upper' | 'lower' | 'abmd' | 'none'
 * @param {Array<object>} targets
 * @param {object} [params] - Method parameters keyed by PLUMED keyword.
 * @param {{grid?:boolean, rct?:boolean, walkers?:object, stride?:string|number,
 *   temp?:string|number, label?:string, stateStride?:string|number}} [options]
 *   `walkers.sharedDir` is the directory of walker 0 that MPI walkers read
 *   on a restart. `stateStride` is how often OPES writes its state; blank
 *   gives a hundred times PACE. The label is `options.label`, else
 *   `params.LABEL`, else the method's usual name. A target may carry `value`,
 *   the name of the value when it differs from `arg`, and `domain`, from
 *   {@link valueDomain}.
 * @returns {{lines:string[], warnings:string[], components:string[], label:string,
 *   title:string}}
 */
export function buildBiasLine(method, targets, params = {}, options = {}) {
  const warnings = [];
  const lines = [];
  const none = { lines, warnings, components: [], label: '', title: '' };

  if (!method || method === 'none') return none;
  if (!BIAS_DEFS[method]) {
    return { ...none, warnings: [`Unknown bias method "${method}".`] };
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    return {
      ...none,
      warnings: [
        `Bias method "${method}" selected but no CV is marked for biasing. ` +
        'Switch Bias on for at least one CV or function, or set the method to None.'
      ]
    };
  }

  const p = normaliseParams(method, params);
  const n = targets.length;
  const legacyGrid = options.grid === undefined;
  const t = targets.map((c, i) => ({
    arg: c.arg || c.label,
    label: c.label || c.arg,
    type: c.type || '',
    // The name PLUMED gives the value, when it differs from the argument as
    // written: from 2.10 `cn.mean` of a shortcut is the value `cn_mean`.
    value: c.value || c.arg || c.label,
    domain: c.domain || null,
    min: c.min !== undefined ? str(c.min) : listAt(params.gridMin, i, n),
    max: c.max !== undefined ? str(c.max) : listAt(params.gridMax, i, n),
    bin: c.bin !== undefined ? str(c.bin) : listAt(params.gridBin, i, n),
    sigma: c.sigma !== undefined ? str(c.sigma) : listAt(params.sigma, i, n)
  }));
  const useGrid = legacyGrid ? t.every(c => c.min && c.max) : !!options.grid;
  const useRct = !!options.rct;
  const walkers = options.walkers || { mode: 'none' };
  const stride = str(options.stride) || '500';
  const label = biasLabelFor(method, p, options.label);

  const arg = t.map(c => c.arg).join(',');
  const join = (key) => t.map(c => c[key]).join(',');
  const param = (key) => {
    const own = str(p[key]);
    if (own) return own;
    const def = (BIAS_DEFS[method].params || []).find(x => x.k === key);
    if (def && def.fallback === 'plumedTemp') return str(options.temp) || (legacyGrid ? '300' : '');
    return def ? str(def.def) : '';
  };
  const perCV = (key) => {
    const v = param(key);
    if (!v) return '';
    if (v.includes(',')) {
      const count = v.split(',').length;
      if (count !== n) {
        warnings.push(
          `\`${key}\` has ${count} values for ${n} biased argument${n === 1 ? '' : 's'}. ` +
          'Give one value, which is repeated, or one per argument.');
      }
      return v;
    }
    return Array(n).fill(v).join(',');
  };
  const tempLine = () => {
    const v = param('TEMP');
    if (v) return `    TEMP=${v}`;
    warnings.push(
      'TEMP is blank, both for the method and in the global TEMP field. PLUMED then ' +
      'relies on the MD engine to pass the temperature; set it explicitly.');
    return '';
  };
  const walkerLines = (allowDisk) => {
    if (walkers.mode === 'mpi') {
      // Only walker 0 writes the hills. With WALKERS_DIR every walker reads
      // them from walker 0's directory on a restart; without it PBMETAD's
      // other walkers find no file, warn and go on with no bias.
      const dir = str(walkers.sharedDir);
      return allowDisk && dir ? ['    WALKERS_MPI', `    WALKERS_DIR=${dir}`] : ['    WALKERS_MPI'];
    }
    if (walkers.mode === 'disk') {
      if (!allowDisk) return ['    WALKERS_MPI'];
      return [
        `    WALKERS_N=${str(walkers.n) || '4'}`,
        `    WALKERS_ID=${str(walkers.id) || '0'}`,
        `    WALKERS_DIR=${str(walkers.dir) || '../hills'}`,
        `    WALKERS_RSTRIDE=${str(walkers.rstride) || '100'}`
      ];
    }
    return [];
  };
  const gridLines = () => {
    const out = [`    GRID_MIN=${join('min')}`, `    GRID_MAX=${join('max')}`];
    if (t.every(c => c.bin)) out.push(`    GRID_BIN=${join('bin')}`);
    return out;
  };

  const family = ['metad', 'wt_metad', 'pbmetad', 'opes'].includes(method);
  if (family) warnings.push(...gridWarnings(t, { method, useGrid }));
  if ((method === 'metad' || method === 'wt_metad') && n > 2) {
    warnings.push(
      'Standard Metadynamics with > 2 CVs scales poorly and requires massive grid memory. ' +
      'Consider reducing biased CVs or switching to PBMETAD / OPES.');
  }
  if (useGrid && n > 3 && (method === 'metad' || method === 'wt_metad')) {
    warnings.push(
      `A ${n}D grid will allocate massive amounts of RAM and may crash PLUMED. ` +
      'Use PBMETAD or disable the grid.');
  }
  if (walkers.mode && walkers.mode !== 'none' && family) {
    warnings.push(...walkerWarnings(walkers, method));
  }

  let components = [];
  let title = '';
  const sigmas = join('sigma');
  const needSigma = () => {
    if (t.some(c => !c.sigma)) {
      warnings.push('SIGMA is unset; metadynamics requires one width per biased CV.');
    }
  };

  switch (method) {
    case 'metad':
    case 'wt_metad': {
      const wt = method === 'wt_metad';
      needSigma();
      title = `${wt ? 'Well-Tempered ' : ''}Metadynamics`;
      lines.push(`${label}: METAD ...`);
      lines.push(`    ARG=${arg}`);
      lines.push(`    PACE=${param('PACE') || stride}`);
      lines.push(`    HEIGHT=${param('HEIGHT')}`);
      lines.push(`    SIGMA=${sigmas}`);
      if (wt) {
        lines.push(`    BIASFACTOR=${param('BIASFACTOR')}`);
        const temp = tempLine();
        if (temp) lines.push(temp);
      }
      lines.push(`    FILE=${param('FILE') || 'HILLS'}`);
      if (useGrid) lines.push(...gridLines());
      else {
        warnings.push(
          'No grid bounds set. Without GRID_MIN/GRID_MAX the hill sum is evaluated over ' +
          'every deposited hill, which slows steadily as the run proceeds.');
      }
      if (useRct) lines.push('    CALC_RCT RCT_USTRIDE=10');
      lines.push(...walkerLines(true));
      lines.push('...');
      components = [`${label}.bias`];
      if (useRct) components.push(`${label}.rbias`, `${label}.rct`);
      if (useRct && !useGrid) {
        warnings.push('`CALC_RCT` requires the bias on a grid. Enable the grid speed option.');
      }
      break;
    }

    case 'pbmetad': {
      needSigma();
      title = 'Parallel-Bias Metadynamics';
      lines.push(`${label}: PBMETAD ...`);
      lines.push(`    ARG=${arg}`);
      lines.push(`    PACE=${param('PACE') || stride}`);
      lines.push(`    HEIGHT=${param('HEIGHT')}`);
      lines.push(`    SIGMA=${sigmas}`);
      lines.push(`    BIASFACTOR=${param('BIASFACTOR')}`);
      const temp = tempLine();
      if (temp) lines.push(temp);
      lines.push(`    FILE=${t.map(c => `HILLS.${c.arg.replace(/[^A-Za-z0-9_-]/g, '_')}`).join(',')}`);
      if (useGrid) lines.push(...gridLines());
      lines.push(...walkerLines(true));
      lines.push('...');
      components = [`${label}.bias`];
      break;
    }

    case 'opes': {
      const barrier = param('BARRIER');
      title = 'OPES (well-tempered target; opes module)';
      lines.push(`${label}: OPES_METAD ...`);
      lines.push(`    ARG=${arg}`);
      lines.push(`    PACE=${param('PACE') || stride}`);
      lines.push(`    BARRIER=${barrier}`);
      const temp = tempLine();
      if (temp) lines.push(temp);
      // BARRIER already sets BIASFACTOR, EPSILON and KERNEL_CUTOFF, so none of
      // them is written: doing so would override the value OPES works out.
      const sigma = param('SIGMA') || 'ADAPTIVE';
      if (sigma.toUpperCase() !== 'ADAPTIVE') {
        lines.push(`    SIGMA=${sigma.includes(',') || n === 1 ? sigma : sigmas}`);
      } else {
        lines.push('    # SIGMA is ADAPTIVE by default (estimated from the fluctuations)');
      }
      lines.push(`    FILE=${param('FILE') || 'Kernels.data'}`);
      // A restart from the kernels file is approximate; the state file makes
      // it exact. STATE_RFILE is read only when the run restarts.
      const stateDir = walkers.mode === 'mpi' && str(walkers.sharedDir) ? `${str(walkers.sharedDir)}/` : '';
      lines.push(`    STATE_RFILE=${stateDir}State.data`);
      lines.push('    STATE_WFILE=State.data');
      const every = str(options.stateStride) || defaultStateStride(param('PACE') || stride);
      lines.push(`    STATE_WSTRIDE=${every}   # a restart continues from the state written last`);
      if (n >= 2) lines.push('    NLIST   # neighbour list over kernels speeds up multi-CV OPES');
      lines.push(...walkerLines(false));
      lines.push('...');
      components = ['bias', 'rct', 'zed', 'neff', 'nker'].map(c => `${label}.${c}`);
      if (!Number.isFinite(Number(barrier)) || Number(barrier) <= 0) {
        warnings.push(
          'BARRIER must be a positive energy; it is the single most important OPES setting.');
      }
      break;
    }

    case 'restraint': {
      if (blank(p.AT) && params.at === undefined && legacyGrid) {
        warnings.push('RESTRAINT requires an AT value per biased CV.');
      }
      let line = `${label}: RESTRAINT ARG=${arg} AT=${perCV('AT')} KAPPA=${perCV('KAPPA')}`;
      const slope = perCV('SLOPE');
      if (slope) line += ` SLOPE=${slope}`;
      title = 'Harmonic restraint (umbrella window)';
      lines.push(line);
      components = [`${label}.bias`];
      break;
    }

    case 'moving': {
      if (legacyGrid && (blank(p.AT0) || blank(p.AT1))) {
        warnings.push('MOVINGRESTRAINT requires both AT0 and AT1.');
      }
      title = 'Moving restraint (steered MD): pull from STEP0 to STEP1';
      lines.push(`${label}: MOVINGRESTRAINT ...`);
      lines.push(`    ARG=${arg}`);
      lines.push(`    STEP0=${param('STEP0')} AT0=${perCV('AT0')} KAPPA0=${perCV('KAPPA0')}`);
      lines.push(`    STEP1=${param('STEP1')} AT1=${perCV('AT1')} KAPPA1=${perCV('KAPPA1')}`);
      lines.push('...');
      components = [`${label}.bias`, `${label}.work`];
      break;
    }

    case 'upper':
    case 'lower': {
      const action = method === 'upper' ? 'UPPER_WALLS' : 'LOWER_WALLS';
      title = `${method === 'upper' ? 'Upper' : 'Lower'} walls`;
      lines.push(
        `${label}: ${action} ARG=${arg} AT=${perCV('AT')} KAPPA=${perCV('KAPPA')} ` +
        `EXP=${perCV('EXP')} EPS=${perCV('EPS')} OFFSET=${perCV('OFFSET')}`);
      components = [`${label}.bias`];
      break;
    }

    case 'abmd': {
      let line = `${label}: ABMD ARG=${arg} TO=${perCV('TO')} KAPPA=${perCV('KAPPA')}`;
      const noise = perCV('NOISE');
      if (noise) line += ` NOISE=${noise}`;
      title = 'ABMD (ratchet-and-pawl)';
      lines.push(line);
      // <arg>_min is the closest approach so far; a restart passes it back as
      // MIN, or the ratchet starts again from wherever the variable is.
      // PLUMED names it after the value, `cn_mean_min` for `cn.mean` from 2.10.
      components = [`${label}.bias`, ...t.map(c => `${label}.${c.value}_min`)];
      break;
    }

    default:
      warnings.push(`Unknown bias method "${method}".`);
  }

  return { lines, warnings, components, label, title };
}

/* A grid wrong for its variable either stops PLUMED (a periodic variable
   whose grid is not its period, written exactly as PLUMED writes it; a value
   that leaves the grid) or distorts the free-energy surface, so both are
   reported before a long job. Only METAD and PBMETAD write a grid. */
function gridWarnings(targets, { method, useGrid }) {
  const warnings = [];
  const writesGrid = useGrid && method !== 'opes';
  for (const c of targets) {
    const sg = parseNumber(c.sigma);
    if (c.sigma && (sg === null || sg <= 0) && c.sigma.toUpperCase() !== 'ADAPTIVE') {
      warnings.push(`SIGMA for \`${c.arg}\` must be a positive number.`);
    }
    if (!writesGrid) continue;
    const lo = parseNumber(c.min);
    const hi = parseNumber(c.max);
    const nb = parseNumber(c.bin);
    const comp = c.label && c.arg.startsWith(c.label) ? c.arg.slice(c.label.length) : '';
    const d = c.domain || valueDomain(c.type, comp);
    const what = c.type && c.type !== 'FUNCTION_PERIODIC' ? ` (${c.type})` : '';

    if (lo === null || hi === null) {
      warnings.push(
        `Grid bounds for \`${c.arg}\` are not numeric, check GRID MIN/MAX ` +
        '(use numbers, or `-pi`/`pi` for angles).');
      continue;
    }
    if (hi <= lo) {
      warnings.push(
        `**Grid error:** \`${c.arg}\` has GRID_MAX (${c.max}) ≤ GRID_MIN (${c.min}). ` +
        'The run will fail or produce nonsense.');
      continue;
    }
    if (d.periodic) {
      // PLUMED compares the bounds with the period as text (MetaD.cpp), so
      // -3.1416 for -pi stops the run as surely as 0 does.
      const [pmin, pmax] = d.periodic;
      if (str(c.min) !== pmin || str(c.max) !== pmax) {
        warnings.push(
          `**Check grid bounds:** \`${c.arg}\`${what} is periodic on \`${pmin}..${pmax}\`, but its ` +
          `grid is written ${c.min}..${c.max}. PLUMED stops unless GRID_MIN and GRID_MAX of a ` +
          `periodic variable read exactly as its period. Set GRID MIN/MAX to \`${pmin}\`/\`${pmax}\`.`);
      }
    } else if (d.angle && (lo < -1e-6 || hi > Math.PI + 1e-3)) {
      warnings.push(
        `**Check grid bounds:** \`${c.arg}\`${what} lies in \`0..pi\`, but its grid is ` +
        `${c.min}..${c.max}.`);
    } else if (d.range && !d.angle) {
      const [a, b] = d.range;
      const w = b - a;
      if (hi > b + w || lo < a - w) {
        warnings.push(
          `**Check grid bounds:** \`${c.arg}\`${what} normally lies in \`${a}..${b}\`, but its ` +
          `grid is ${c.min}..${c.max}. Most of the grid would never be visited.`);
      }
    }
    if (d.count && d.items && hi < d.items) {
      warnings.push(
        `**Check grid bounds:** \`${c.arg}\` counts up to ${d.items}, but its grid stops at ` +
        `${c.max}. PLUMED stops when the value leaves the grid; set GRID MAX to ${d.items}.`);
    }
    if (!d.periodic && !d.angle && !d.range && c.min === '0.0' && c.max === '10.0') {
      warnings.push(
        `\`${c.arg}\` is still using the generic default grid \`0.0..10.0\`. Confirm this ` +
        'covers the range your CV explores, hills outside the grid are an error in PLUMED.');
    }
    if (sg && nb && sg > 0 && nb > 0) {
      const spacing = (hi - lo) / nb;
      if (spacing > sg / 2) {
        const need = Math.ceil((hi - lo) / (sg / 2));
        warnings.push(
          `\`${c.arg}\`: grid spacing (${spacing.toPrecision(3)}) is wider than half of SIGMA ` +
          `(${c.sigma}), so a hill is poorly resolved. Use at least ${need} bins.`);
      }
    }
    if (sg && sg > 0 && (hi - lo) < 4 * sg) {
      warnings.push(`\`${c.arg}\`: the grid spans less than 4×SIGMA. Widen GRID MIN/MAX or reduce SIGMA.`);
    }
  }
  return warnings;
}

function walkerWarnings(walkers, method) {
  const warnings = [];
  if (walkers.mode === 'mpi') {
    warnings.push(
      '**`WALKERS_MPI` only does something in a multi-replica run.** Launch the replicas as ' +
      'one MPI job (e.g. `mpirun -np N gmx_mpi mdrun -multidir w0 w1 …`, or ' +
      '`mpirun -np N plumed driver --multi N …`). On a single-rank job this silently ' +
      'reduces to one walker, and the run looks fine but shares no bias.');
    return warnings;
  }
  if (walkers.mode !== 'disk') return warnings;
  const wn = parseInt(str(walkers.n) || '4', 10);
  const wid = str(walkers.id) || '0';
  const widNum = parseInt(wid, 10);
  if (Number.isFinite(wn) && Number.isFinite(widNum) && /^\d+$/.test(wid) && widNum >= wn) {
    warnings.push(
      `**Walker id out of range:** \`WALKERS_ID=${wid}\` must be between 0 and ${wn - 1} ` +
      `for \`WALKERS_N=${wn}\`.`);
  }
  if (/^\d+$/.test(wid) && !walkers.perWalkerFiles) {
    const last = Number.isFinite(wn) && wn > 0 ? wn - 1 : 'N−1';
    warnings.push(
      `Every walker needs a **different** \`WALKERS_ID\`, but this file hardcodes \`${wid}\`. ` +
      `Save one copy of this input per walker, each with its own \`WALKERS_ID\` (0 to ${last}).`);
  }
  warnings.push(
    'All walkers must share the same `WALKERS_DIR` and it must exist before the run ' +
    'starts (`mkdir -p` it in the job script).');
  if (method === 'opes') {
    warnings.push(
      'OPES supports **MPI walkers only**, the shared-directory keywords do not apply, so ' +
      '`WALKERS_MPI` was emitted instead. Switch to MPI mode, or use METAD/PBMETAD for ' +
      'disk-based walkers.');
  }
  return warnings;
}

/**
 * Build one restraint or wall that acts alongside the main bias, the usual
 * way to keep a metadynamics run inside the region of interest.
 *
 * @param {{type:'upper'|'lower'|'restraint', label?:string, arg:string, at:string,
 *   kappa:string, exp?:string, eps?:string, offset?:string}} r
 * @param {{known?:Set<string>}} [options]
 * @returns {{line:string|null, warnings:string[], component:string}}
 */
export function buildRestraintLine(r, options = {}) {
  const warnings = [];
  const ACTIONS = { upper: 'UPPER_WALLS', lower: 'LOWER_WALLS', restraint: 'RESTRAINT' };
  if (!r || !ACTIONS[r.type]) return { line: null, warnings: ['Unknown restraint type.'], component: '' };
  const action = ACTIONS[r.type];
  const label = r.label || `${r.type}1`;
  const arg = str(r.arg);

  if (!arg) warnings.push(`${action} (${label}) has no argument. Pick the value it acts on.`);
  else if (options.known && !arg.split(',').every(a => options.known.has(str(a)))) {
    warnings.push(`${action} (${label}) acts on \`${arg}\`, which nothing above it defines.`);
  }
  if (blank(r.at)) warnings.push(`${action} (${label}) needs an \`AT\` value.`);
  const kappa = parseNumber(r.kappa);
  if (kappa === null || kappa <= 0) {
    warnings.push(`${action} (${label}) needs a positive \`KAPPA\`.`);
  }

  const parts = [`ARG=${arg}`, `AT=${str(r.at)}`, `KAPPA=${str(r.kappa)}`];
  if (r.type !== 'restraint') {
    if (!blank(r.exp) && Number(r.exp) !== 2) parts.push(`EXP=${str(r.exp)}`);
    if (!blank(r.eps) && Number(r.eps) !== 1) parts.push(`EPS=${str(r.eps)}`);
    if (!blank(r.offset) && Number(r.offset) !== 0) parts.push(`OFFSET=${str(r.offset)}`);
  }
  return { line: `${label}: ${action} ${parts.join(' ')}`, warnings, component: `${label}.bias` };
}

/* ------------------------------------------------------------------ *
 * PRINT and labels
 * ------------------------------------------------------------------ */

/**
 * Build the PRINT line.
 *
 * @param {Array<{label:string}>} cvs
 * @param {{stride?:number|string, file?:string, extra?:string[]}} [options]
 * @returns {string}
 */
export function buildPrintLine(cvs, options = {}) {
  const { stride = 500, file = 'COLVAR', extra = [] } = options;
  const labels = (Array.isArray(cvs) ? cvs : []).map(c => c.label);
  const args = [];
  for (const a of [...labels, ...extra]) {
    if (a && !args.includes(a)) args.push(a);
  }
  if (args.length === 0) return '';
  return `PRINT ARG=${args.join(',')} STRIDE=${stride} FILE=${file}`;
}

/**
 * Check labels for the problems PLUMED will reject or silently mishandle.
 *
 * @param {Array<{label:string}>} cvs
 * @returns {string[]}
 */
export function validateLabels(cvs) {
  const warnings = [];
  const seen = new Set();
  if (!Array.isArray(cvs)) return warnings;

  for (const cv of cvs) {
    const l = cv && cv.label;
    if (!l) {
      warnings.push('A CV has no label.');
      continue;
    }
    if (seen.has(l)) {
      warnings.push(`Duplicate label "${l}"; PLUMED requires unique labels.`);
    }
    seen.add(l);

    // A label containing a dot would be parsed as a component reference.
    if (l.includes('.')) {
      warnings.push(`Label "${l}" contains a dot, which PLUMED reads as a component reference.`);
    } else if (!LABEL_RE.test(l) || /^\d/.test(l)) {
      warnings.push(
        `Label "${l}" is not a valid PLUMED identifier, use a letter followed ` +
        `by letters, digits, or underscores.`
      );
    }
    if (l.startsWith('@')) {
      warnings.push(`Label "${l}" starts with @, which PLUMED reserves for its own selections.`);
    }
  }
  return warnings;
}

/* ------------------------------------------------------------------ *
 * Checks on a CV
 * ------------------------------------------------------------------ */

/**
 * Expand a PLUMED atom list into indices: `1,2`, `1-100`, `1-100:2`, and a
 * range that runs down with a negative stride, `10-1:-3` (10, 7, 4, 1), as
 * PLUMED's Tools::interpretRanges reads it. Labels and `@` selections are
 * returned separately, since only PLUMED can resolve them.
 *
 * @param {string} spec
 * @param {{limit?:number}} [options] - Stop expanding past this many atoms.
 * @returns {{indices:number[], labels:string[], errors:string[], count:number}}
 */
export function parseAtomList(spec, options = {}) {
  const { limit = 2000000 } = options;
  const indices = [];
  const labels = [];
  const errors = [];
  let count = 0;
  for (const part of str(spec).split(',').map(str).filter(Boolean)) {
    const m = /^(\d+)-(\d+)(?::([+-]?\d+))?$/.exec(part);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      const step = m[3] === undefined ? 1 : Number(m[3]);
      if (step === 0) { errors.push(`"${part}" has a stride of zero.`); continue; }
      // PLUMED runs up with a positive stride and down with a negative one,
      // and stops at anything else.
      if (a <= b && step < 0) { errors.push(`"${part}" runs up but its stride is negative.`); continue; }
      if (b < a && step > 0) {
        errors.push(`"${part}" runs backwards; a range that runs down needs a negative stride, ` +
          `e.g. "${a}-${b}:-1".`);
        continue;
      }
      const n = Math.floor(Math.abs(b - a) / Math.abs(step)) + 1;
      count += n;
      if (indices.length + n <= limit) {
        if (step > 0) for (let i = a; i <= b; i += step) indices.push(i);
        else for (let i = a; i >= b; i += step) indices.push(i);
      }
    } else if (/^\d+$/.test(part)) {
      indices.push(Number(part));
      count += 1;
    } else if (/^@?[A-Za-z_][A-Za-z0-9_.:@-]*$/.test(part)) {
      labels.push(part);
    } else {
      errors.push(`"${part}" is not an atom index, a range or a label.`);
    }
  }
  return { indices, labels, errors, count };
}

/**
 * What is wrong or risky about one CV beyond its syntax.
 *
 * @param {object} instance
 * @param {Object<string, object>} [catalogue]
 * @param {{version?:string, natoms?:number, units?:object, known?:Set<string>}} [options]
 * @returns {string[]}
 */
export function checkCV(instance, catalogue = CV_DEFS, options = {}) {
  const warnings = [];
  const def = instance && catalogue[instance.type];
  if (!def || def.isCustom) return warnings;
  const values = instance.values || {};
  const label = instance.label || instance.type;
  const has = (k) => !blank(values[k]);

  if (instance.type === 'CONSTANT') {
    if (has('VALUE') && has('VALUES')) {
      warnings.push(`CONSTANT (${label}) sets both \`VALUE\` and \`VALUES\`, use one or the other, not both.`);
    } else if (!has('VALUE') && !has('VALUES')) {
      warnings.push(`CONSTANT (${label}) needs a \`VALUE\` (single) or \`VALUES\` (list).`);
    }
  }
  if (instance.type === 'GROUP' && !has('ATOMS') && !has('NDX_FILE')) {
    warnings.push(`GROUP (${label}) needs \`ATOMS\`, or an \`NDX_FILE\` to read them from.`);
  }
  if (instance.type === 'COORDINATION') {
    if (values.NLIST && (!has('NL_CUTOFF') || !has('NL_STRIDE'))) {
      warnings.push('COORDINATION with `NLIST` requires both `NL_CUTOFF` and `NL_STRIDE` to be set.');
    }
    // COORDINATION has no linked cells in any release: it visits every pair
    // at every step, and D_MAX only truncates the switch. Only a neighbour
    // list cuts the cost, which matters once there are many pairs.
    const a = parseAtomList(values.GROUPA);
    const b = parseAtomList(values.GROUPB);
    const known = !a.labels.length && !b.labels.length;
    const pairs = has('GROUPB') ? a.count * b.count : (a.count * (a.count - 1)) / 2;
    if (!values.NLIST && (!known || pairs > 10000)) {
      warnings.push(
        `COORDINATION (${label}) visits every ${has('GROUPB') ? 'GROUPA–GROUPB' : 'GROUPA'} pair at ` +
        `every step${known ? `, ${pairs.toLocaleString('en-GB')} of them` : ''}; \`D_MAX\` only ` +
        'truncates the switching function and does not make it faster. For large groups enable ' +
        '`NLIST` with `NL_CUTOFF`/`NL_STRIDE`, or use COORDINATIONNUMBER, which uses linked cells.');
    }
    const cut = parseNumber(values.NL_CUTOFF);
    const r0 = parseNumber(values.R_0);
    if (values.NLIST && cut !== null && r0 !== null && cut < 2 * r0) {
      warnings.push(
        `COORDINATION (${label}): \`NL_CUTOFF=${values.NL_CUTOFF}\` is under twice \`R_0\`, where ` +
        'the switching function is still appreciable, so contacts are dropped from the list.');
    }
  }
  if (def.switchSpeed && !has('D_MAX')) {
    warnings.push(
      `${instance.type} (${label}) has no \`D_MAX\`. Setting it enables linked-cell ` +
      'neighbour search, a large speedup for order parameters.');
  }
  if ((def.switchSpeed || def.coordSwitch) && has('D_MAX')) {
    const r0 = parseNumber(values.R_0);
    const d0 = parseNumber(values.D_0) || 0;
    const dmax = parseNumber(values.D_MAX);
    if (r0 !== null && dmax !== null) {
      if (dmax <= d0) {
        warnings.push(`${instance.type} (${label}): \`D_MAX\` must be larger than \`D_0\`.`);
      } else if (dmax < d0 + r0) {
        // PLUMED stretches and shifts the function so that it reaches zero at
        // D_MAX; this close to R_0 that changes its shape considerably.
        const s = rationalSwitch(dmax - 1e-9, {
          r0, d0, nn: parseNumber(values.NN) || 6, mm: parseNumber(values.MM) || 0
        });
        warnings.push(
          `${instance.type} (${label}): \`D_MAX=${values.D_MAX}\` is inside \`R_0\`, where the ` +
          `switching function is still ${s.toFixed(2)}. PLUMED rescales the function to reach ` +
          'zero at D_MAX, so its shape is no longer the one R_0 describes. Set D_MAX ' +
          `beyond ${(d0 + r0).toFixed(2)}.`);
      }
    }
  }

  // A cutoff of several nanometres usually means the value was copied from an
  // example in reduced (Lennard-Jones) units.
  const lengthUnit = (options.units && options.units.length) || 'nm';
  const nm = LENGTH_IN_NM[lengthUnit] || 1;
  for (const k of ['R_0', 'D_0', 'D_MAX']) {
    const f = (def.fields || []).find(x => x.k === k);
    const v = parseNumber(values[k]);
    if (f && v !== null && v * nm > 2.5) {
      warnings.push(
        `${instance.type} (${label}): \`${k}=${values[k]}\` is ${(v * nm).toFixed(2)} nm, far ` +
        'beyond a first coordination shell. Check the value is in the input units and not ' +
        'in reduced units.');
    }
  }

  // PLUMED 2.9's INPLANEDISTANCES is unreliable at run time: its MEAN aborts
  // on the first step ("celn[j]>=0 && celn[j]<ncells[j]", a linked-cell
  // assertion), and even LESS_THAN crashes on some geometries. It parses, so
  // only a run shows it.
  if (instance.type === 'INPLANEDISTANCES' && !versionAtLeast(options.version || DEFAULT_PLUMED_VERSION, '2.10')) {
    warnings.push(
      `INPLANEDISTANCES (${label}): PLUMED 2.9 can abort or crash on the first step of this ` +
      'action (its MEAN always did in our tests, LESS_THAN on some geometries). Run ' +
      '`plumed driver` on a frame of your system first, or target PLUMED 2.10 or newer.');
  }

  const expect = { DISTANCE: [2], TORSION: [4], ANGLE: [3, 4], PUCKERING: [5, 6],
    DIHEDRAL_CORRELATION: [8], PLANE: [3, 4] }[instance.type];
  for (const f of def.fields || []) {
    if (f.type !== 'atoms' || blank(values[f.k])) continue;
    // A field another one replaces is not written, so it is not checked.
    const other = (k) => (def.fields || []).find(x => x.k === k);
    if ((f.excludedBy || []).some(k => other(k) && isSet(other(k), values[k]))) continue;
    const parsed = parseAtomList(values[f.k]);
    for (const e of parsed.errors) warnings.push(`${instance.type} (${label}), \`${f.k}\`: ${e}`);
    if (parsed.indices.includes(0)) {
      warnings.push(`${instance.type} (${label}), \`${f.k}\`: PLUMED counts atoms from 1, there is no atom 0.`);
    }
    if (options.natoms && parsed.indices.length) {
      const max = parsed.indices.reduce((a, b) => Math.max(a, b), 0);
      if (max > options.natoms) {
        warnings.push(
          `${instance.type} (${label}), \`${f.k}\`: atom ${max} does not exist, ` +
          `the structure has ${options.natoms} atoms.`);
      }
    }
    if (options.known) {
      for (const l of parsed.labels) {
        if (!l.startsWith('@') && !options.known.has(l)) {
          warnings.push(
            `${instance.type} (${label}), \`${f.k}\`: \`${l}\` is not a group or centre defined above it.`);
        }
      }
    }
    if (expect && f.k === 'ATOMS' && !parsed.labels.some(l => l.startsWith('@'))) {
      const n = parsed.count + parsed.labels.length;
      if (!expect.includes(n)) {
        warnings.push(
          `${instance.type} (${label}) takes ${expect.join(' or ')} atoms, \`ATOMS\` lists ${n}.`);
      }
    }
  }
  return warnings;
}

/* ------------------------------------------------------------------ *
 * The whole file
 * ------------------------------------------------------------------ */

function normaliseConfig(config) {
  const c = { ...config };
  c.catalogue = config.catalogue || CV_DEFS;
  c.version = config.version || DEFAULT_PLUMED_VERSION;
  c.cvs = Array.isArray(config.cvs) ? config.cvs.filter(Boolean) : [];
  c.functions = Array.isArray(config.functions) ? config.functions.filter(Boolean) : [];
  c.restraints = Array.isArray(config.restraints) ? config.restraints.filter(Boolean) : [];

  const bias = config.bias && typeof config.bias === 'object' ? { ...config.bias } : {};
  c.legacy = !config.bias && (config.biasMethod !== undefined || config.biasParams !== undefined);
  if (c.legacy) {
    bias.method = config.biasMethod || 'none';
    bias.params = config.biasParams || {};
  }
  bias.method = bias.method || 'none';
  bias.params = bias.params || {};
  bias.walkers = bias.walkers || { mode: 'none' };
  c.bias = bias;

  const prints = [];
  if (Array.isArray(config.prints)) prints.push(...config.prints.filter(Boolean));
  if (!prints.length) {
    prints.push({
      file: config.printFile || 'COLVAR',
      stride: config.printStride !== undefined ? config.printStride : (bias.stride || 500),
      extra: config.printExtra || ''
    });
  }
  c.prints = prints;
  return c;
}

function splitList(value) {
  if (Array.isArray(value)) return value.map(str).filter(Boolean);
  return str(value).split(/[\n,;]+|\s+/).map(str).filter(Boolean);
}

/**
 * Assemble a complete PLUMED input file.
 *
 * @param {{
 *   version?: string,
 *   syntax?: object,
 *   catalogue?: Object<string, object>,
 *   natoms?: number,
 *   units?: {length?:string, energy?:string, time?:string},
 *   preamble?: {restart?:boolean, load?:string[]|string, include?:string[]|string,
 *     flush?:string|number, trusted?:string[], definedLabels?:string[]},
 *   molinfo?: {structure?:string, moltype?:string},
 *   whole?: {enabled?:boolean, residues?:boolean, entities?:string[]|string},
 *   cvs?: Array<object>,
 *   functions?: Array<object>,
 *   bias?: {method?:string, params?:object, temp?:string, stride?:string,
 *     grid?:boolean, rct?:boolean, walkers?:object, stateStride?:string|number},
 *   restraints?: Array<object>,
 *   prints?: Array<{file?:string, stride?:string|number, extra?:string|string[],
 *     args?:string[], only?:boolean}>
 * }} config
 * @returns {{input:string, warnings:string[], cvLines:string[], arguments:string[],
 *   printable:string[], biased:string[], actions:string[], modules:string[]}}
 *   `printable` lists the values the bias and the walls add to `arguments`.
 */
export function generatePlumedInput(config = {}) {
  const c = normaliseConfig(config);
  const { catalogue, version, syntax } = c;
  const warnings = [];
  const lines = [];
  const actions = [];
  const note = (a) => { if (a && !actions.includes(a)) actions.push(a); };

  lines.push('# ==================================================================');
  lines.push('# PLUMED input (plumed.dat)  -  generated by stemkit.net');
  lines.push(`# Target: PLUMED ${version}`);
  const natoms = Number.isInteger(Number(c.natoms)) && Number(c.natoms) > 0 ? Number(c.natoms) : 'N';
  lines.push(`# Check it before the run:  plumed driver --natoms ${natoms} --parse-only --plumed plumed.dat`);
  lines.push('# ==================================================================');
  lines.push('');

  /* --- Setup actions come before everything else: RESTART, UNITS, LOAD --- */
  const pre = c.preamble || {};
  const units = c.units || null;
  const setup = [];
  if (pre.restart) { setup.push('RESTART'); note('RESTART'); }
  if (units) {
    const parts = [];
    const explicit = c.legacy;
    const differs = (k) => units[k] && (explicit || units[k] !== DEFAULT_UNITS[k]);
    if (differs('length')) parts.push(`LENGTH=${units.length}`);
    if (differs('energy')) parts.push(`ENERGY=${units.energy}`);
    if (differs('time')) parts.push(`TIME=${units.time}`);
    if (parts.length) {
      setup.push(`UNITS ${parts.join(' ')}`);
      note('UNITS');
      if (!explicit) {
        warnings.push(
          `Non-default units set (${parts.join(', ')}). All lengths/energies you enter below ` +
          '(R_0, D_MAX, HEIGHT, KAPPA, ...) must be in these units.');
      }
    }
  }
  for (const f of splitList(pre.load)) { setup.push(`LOAD FILE=${f}`); note('LOAD'); }
  if (setup.length) {
    if (!c.legacy) lines.push('# --- Setup (PLUMED defaults are nm, kj/mol, ps) ---');
    lines.push(...setup, '');
  }
  if (pre.restart) {
    warnings.push(
      '`RESTART` makes PLUMED append to `HILLS`, `COLVAR` and the other outputs and read ' +
      'the hills already deposited. Use it only when continuing a run, with the files ' +
      'from that run in place.');
  }
  if (splitList(pre.load).some(f => /\.(cpp|cc|cxx)$/i.test(f))) {
    warnings.push(
      '`LOAD` compiles the source file when PLUMED starts, so the machine running the job ' +
      'needs the compiler PLUMED was built with, and the code must match the PLUMED version.');
  }

  /* --- MOLINFO and WHOLEMOLECULES --- */
  const molinfo = c.molinfo && str(c.molinfo.structure) ? c.molinfo : null;
  if (molinfo) {
    const mt = str(molinfo.moltype) ? ` MOLTYPE=${str(molinfo.moltype)}` : '';
    lines.push('# --- Structure reference (enables @ selections such as @phi-2) ---');
    lines.push(`MOLINFO STRUCTURE=${str(molinfo.structure)}${mt}`, '');
    note('MOLINFO');
  }
  const whole = c.whole || {};
  if (whole.enabled) {
    let line = '';
    if (whole.residues) {
      line = 'WHOLEMOLECULES RESIDUES=all MOLTYPE=protein';
      if (!molinfo) {
        warnings.push('`WHOLEMOLECULES RESIDUES=all` needs a MOLINFO reference structure; set one above.');
      }
    } else {
      const ents = splitListKeepRanges(whole.entities);
      if (ents.length) line = `WHOLEMOLECULES ${ents.map((e, i) => `ENTITY${i}=${e}`).join(' ')}`;
      else {
        warnings.push(
          '`WHOLEMOLECULES` is enabled but no entities are listed, add an atom range ' +
          '(e.g. 1-100) or switch to RESIDUES=all.');
      }
    }
    if (line) {
      lines.push('# --- Reconstruct whole molecules across PBC (must precede the CVs) ---');
      lines.push(line, '');
      note('WHOLEMOLECULES');
    }
  }

  /* --- INCLUDE: files of definitions, read where they stand --- */
  const includes = splitList(pre.include);
  if (includes.length) {
    lines.push('# --- Definitions kept in other files ---');
    for (const f of includes) { lines.push(`INCLUDE FILE=${f}`); note('INCLUDE'); }
    lines.push('');
  }

  const everything = [...c.cvs, ...c.functions];
  warnings.push(...validateLabels(everything));
  // The bias line has a label too, fixed by the method unless one is given,
  // and PLUMED stops at a second line with the same label.
  const biasLabel = BIAS_DEFS[c.bias.method] && c.bias.method !== 'none'
    ? biasLabelFor(c.bias.method, c.bias.params, c.bias.label) : '';
  if (biasLabel) {
    if (everything.some(x => x && x.label === biasLabel)) {
      warnings.push(
        `Duplicate label "${biasLabel}"; PLUMED requires unique labels. The bias line is called ` +
        `\`${biasLabel}\`: rename the variable, or give the bias another Label.`);
    }
    if (!LABEL_RE.test(biasLabel)) {
      warnings.push(`The bias label "${biasLabel}" is not a valid PLUMED label; use letters, digits and underscores.`);
    }
  }

  if (!c.cvs.length && !c.functions.length) {
    if (!c.legacy) lines.push('# (No collective variables added yet.)');
    return finish();
  }

  /* --- Collective variables --- */
  const definedAtoms = new Set(splitList(pre.definedLabels));
  const trusted = new Set(splitList(pre.trusted));
  const unknownIncludes = includes.some(f => !trusted.has(f));
  const prereqs = new Set();
  const cvLines = [];
  if (c.cvs.length) lines.push('# --- Collective variables ---');
  for (const cv of c.cvs) {
    const def = catalogue[cv.type] || null;
    const r = buildCVLine(cv, catalogue, { version, biasMethod: c.bias.method, syntax });
    warnings.push(...r.warnings);
    if (def) {
      warnings.push(...checkCV(cv, catalogue, {
        version, natoms: c.natoms, units: { ...DEFAULT_UNITS, ...(units || {}) },
        known: unknownIncludes ? null : definedAtoms
      }));
      if (def.prereq && PREREQS[def.prereq] && r.line &&
        !(def.prereqSkipIf && def.prereqSkipIf(cv, version))) {
        prereqs.add(def.prereq);
      }
      if (def.needsMolinfo && !molinfo) {
        warnings.push(
          `${cv.type} (${cv.label}) selects residues, so it needs a MOLINFO reference ` +
          'structure. Name the PDB file under Structure.');
      }
    }
    if (r.line) {
      cvLines.push(r.line);
      lines.push(r.line);
      note(r.action);
      if (cv.label) definedAtoms.add(cv.label);
    }
  }
  if (c.cvs.length) lines.push('');

  for (const p of prereqs) {
    if (p === 'wholemolecules' && whole.enabled) continue;
    warnings.push(
      `One or more CVs ${PREREQS[p].note}` +
      (p === 'wholemolecules' ? ' Switch on Rebuild whole molecules (WHOLEMOLECULES) to emit it.' : ''));
  }

  /* --- Functions --- */
  const known = new Set(availableArguments({ ...c, functions: [] }).map(a => a.arg));
  // An included file this page did not write may define anything.
  const trustUnknown = unknownIncludes;
  if (c.functions.length) {
    lines.push('# --- Functions of the variables above ---');
    for (const fn of c.functions) {
      const r = buildFunctionLine(fn, { known: trustUnknown ? null : known });
      warnings.push(...r.warnings);
      if (r.line) {
        lines.push(r.line);
        note(fn.type);
        if (fn.label) known.add(fn.label);
      }
    }
    lines.push('');
  }

  /* --- Bias --- */
  const targets = [];
  for (const b of biasedArguments({ cvs: c.cvs, functions: c.functions, catalogue, version, syntax })) {
    const bv = b.source.biasValues || {};
    if (b.kind === 'function') {
      const fn = b.source;
      const period = str(fn.values && fn.values.PERIODIC);
      const periodic = period && period.toUpperCase() !== 'NO';
      const type = periodic ? 'FUNCTION_PERIODIC' : fn.type;
      targets.push({
        arg: fn.label, label: fn.label, type,
        domain: valueDomain(type, '', { period }),
        min: bv.min, max: bv.max, bin: bv.bin, sigma: bv.sigma
      });
      continue;
    }
    const cv = b.source;
    const def = catalogue[cv.type] || {};
    const comp = b.comp;
    const t = {
      arg: b.arg, label: cv.label, type: cv.type,
      domain: valueDomain(cv.type, comp, { values: cv.values })
    };
    // From 2.10 a shortcut multicolvar makes `cv.mean` a value of its own,
    // `cv_mean`, and the actions that name components after their argument
    // (ABMD's `_min`) use that name.
    if (def.compStyle === 'dot' && comp.startsWith('.') && versionAtLeast(version, '2.10')) {
      t.value = `${cv.label}_${comp.slice(1)}`;
    }
    if (!c.legacy) Object.assign(t, { min: bv.min, max: bv.max, bin: bv.bin, sigma: bv.sigma });
    targets.push(t);
  }

  const biasOptions = c.legacy ? {} : {
    grid: c.bias.grid !== false, rct: !!c.bias.rct, walkers: c.bias.walkers,
    stride: c.bias.stride, temp: c.bias.temp, stateStride: c.bias.stateStride,
    label: str(c.bias.label)
  };
  const bias = buildBiasLine(c.bias.method, targets, c.bias.params, biasOptions);
  warnings.push(...bias.warnings);
  if (bias.lines.length) {
    lines.push(`# --- ${bias.title} ---`, ...bias.lines, '');
    note(BIAS_DEFS[c.bias.method] && BIAS_DEFS[c.bias.method].action);
  }

  /* --- Restraints and walls beside the bias --- */
  const extraComponents = [];
  if (c.restraints.length) {
    lines.push('# --- Restraints and walls ---');
    const labels = new Set(everything.map(x => x.label));
    if (bias.label) labels.add(bias.label);
    c.restraints.forEach((r, i) => {
      const label = r.label || `${r.type === 'restraint' ? 'res' : r.type === 'upper' ? 'uw' : 'lw'}${i + 1}`;
      if (labels.has(label)) {
        warnings.push(`Duplicate label "${label}"; PLUMED requires unique labels.`);
      }
      labels.add(label);
      const out = buildRestraintLine({ ...r, label }, { known: trustUnknown ? null : known });
      warnings.push(...out.warnings);
      if (out.line) {
        lines.push(out.line);
        extraComponents.push(out.component);
        note(out.line.split(/\s+/)[1]);
      }
    });
    lines.push('');
  }

  /* --- Output --- */
  const all = availableArguments(c).map(a => a.arg);
  const printable = new Set([...all, ...bias.components, ...extraComponents]);
  lines.push('# --- Output ---');
  if (!blank(pre.flush)) {
    const n = parseNumber(pre.flush);
    if (n === null || n < 1 || !Number.isInteger(n)) {
      warnings.push('`FLUSH STRIDE` must be a whole number of steps.');
    }
    lines.push(`FLUSH STRIDE=${str(pre.flush)}`);
    note('FLUSH');
  }
  c.prints.forEach((p, i) => {
    const extra = splitList(p.extra);
    let args;
    if (Array.isArray(p.args) && (p.args.length || p.only)) args = p.args.map(str).filter(Boolean);
    else args = [...all, ...bias.components, ...extraComponents];
    if (!args.length && !extra.length) {
      warnings.push(
        `The output file \`${str(p.file) || `COLVAR.${i}`}\` has nothing to write. Pick the values ` +
        'it should hold, or remove it.');
      return;
    }
    for (const x of extra) if (!args.includes(x)) args.push(x);
    if (!c.legacy && !trustUnknown) {
      for (const a of args) {
        if (!printable.has(a) && !/[*?]/.test(a)) {
          warnings.push(
            `PRINT (${str(p.file) || 'COLVAR'}) lists \`${a}\`, which nothing in this file ` +
            'defines. PLUMED stops at an argument it cannot find.');
        }
      }
    }
    const stride = str(p.stride) || '500';
    const n = parseNumber(stride);
    if (n === null || n < 1 || !Number.isInteger(n)) {
      warnings.push(`PRINT STRIDE must be a whole number of steps, not "${stride}".`);
    }
    const file = str(p.file) || (i === 0 ? 'COLVAR' : `COLVAR.${i}`);
    let line = buildPrintLine(args.map(a => ({ label: a })), { stride, file });
    if (line) {
      if (!c.legacy) line = line.replace(/ STRIDE=(\S+) FILE=(\S+)$/, ' FILE=$2 STRIDE=$1');
      // The number format, e.g. %10.5f; PLUMED splits the line on spaces.
      if (!blank(p.fmt)) line += ` FMT=${str(p.fmt).replace(/\s+/g, '')}`;
      lines.push(line);
      note('PRINT');
    }
  });
  const files = c.prints.map((p, i) => str(p.file) || (i === 0 ? 'COLVAR' : `COLVAR.${i}`));
  if (new Set(files).size !== files.length) {
    warnings.push('Two PRINT actions write to the same file. Give each its own file name.');
  }

  return finish(cvLines, targets.map(t => t.arg), [...bias.components, ...extraComponents]);

  function finish(cvLinesOut = [], biased = [], printableOut = []) {
    const modules = [];
    const modulesOf = (a) => (syntax && typeof syntax.modulesFor === 'function'
      ? syntax.modulesFor(a) : [syntax && syntax.moduleOf(a)]);
    if (syntax) {
      const seen = new Set();
      for (const a of actions) {
        if (!syntax.has(a)) {
          if (a && !splitList(pre.load).length) {
            warnings.push(
              `\`${a}\` is not an action of PLUMED ${version}. Check the name, or change ` +
              'the target version.');
          }
          continue;
        }
        // A shortcut needs the modules of the actions it expands into as
        // well: from 2.10 Q6 is symfunc, but its CONTACT_MATRIX is adjmat.
        for (const m of modulesOf(a)) {
          if (m && !m.defaultOn && !seen.has(m.name)) {
            seen.add(m.name);
            modules.push(m.name);
          }
        }
      }
      for (const m of modules) {
        const own = actions.filter(a => syntax.has(a) && (syntax.moduleOf(a) || {}).name === m);
        const via = actions.filter(a => syntax.has(a) && !own.includes(a) &&
          modulesOf(a).some(x => x && x.name === m));
        const who = [...own, ...via].map(a => `\`${a}\``).join(', ');
        warnings.push(
          `${who} need${own.length + via.length === 1 ? 's' : ''} the **${m}** module` +
          (via.length && !own.length ? ` for the actions ${via.length === 1 ? 'it expands' : 'they expand'} into` : '') +
          `, which a default PLUMED ${version} build leaves out. Check with ` +
          `\`plumed config has module ${m}\`, and rebuild with ` +
          `\`./configure --enable-modules=${modules.join(':')}\` (or \`all\`) if it is missing` +
          (modules.length > 1 ? ': the input needs every module listed there.' : '.'));
      }
      if (modules.length) {
        const at = lines.indexOf('') + 1;
        lines.splice(at, 0,
          `# Needs PLUMED built with: --enable-modules=${modules.join(':')}`, '');
      }
    }
    const unique = [];
    for (const w of warnings) if (!unique.includes(w)) unique.push(w);
    return {
      input: `${lines.join('\n').replace(/\n+$/, '')}\n`,
      warnings: unique,
      cvLines: cvLinesOut,
      arguments: availableArguments(c).map(a => a.arg),
      printable: printableOut,
      biased,
      actions,
      modules
    };
  }
}

/* WHOLEMOLECULES entities are one atom list each, so commas inside a line
   belong to the list; entities are separated by new lines or semicolons. */
function splitListKeepRanges(value) {
  if (Array.isArray(value)) return value.map(str).filter(Boolean);
  return str(value).split(/[\n;]+/).map(s => s.replace(/\s+/g, '')).filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

/**
 * Typeset a message as HTML: `` `code` `` and `**strong**`, everything else
 * escaped.
 *
 * @param {string} text
 * @returns {string}
 */
export function messageToHtml(text) {
  const esc = String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return esc
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/**
 * The same message with the marks removed.
 *
 * @param {string} text
 * @returns {string}
 */
export function messageToText(text) {
  return String(text == null ? '' : text)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1');
}
