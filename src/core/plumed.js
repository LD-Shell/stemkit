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
 *     `fallback` action name for older releases.
 *   - **The keyword table decides.** Given a table from `plumed-syntax`, a
 *     field the target release does not register is left out and the module an
 *     action needs is read from the table, not from memory.
 *   - **Bias-dependent redundancy.** Some bias methods internally manage
 *     parameters that would then be redundant or contradictory on the CV.
 *     Which keys to suppress is expressed declaratively rather than buried in
 *     rendering code.
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
 * unavailable and the caller is told so.
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
  if (def.fallback) {
    return { action: def.fallback, usedFallback: true, available: true };
  }
  return { action: null, usedFallback: false, available: false };
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
 * Keyed by bias method, then by action name (or `*` for every CV).
 */
export const BIAS_REDUNDANCY = Object.freeze({
  // Metadynamics lays hills on a grid this tool defines, so a per-CV neighbour
  // list does not control the cost of the bias; hiding the knobs avoids
  // implying that it does.
  wt_metad: { '*': ['NL_CUTOFF', 'NL_STRIDE'] },
  metad: { '*': ['NL_CUTOFF', 'NL_STRIDE'] }
});

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
  if (def.components === 'constant') {
    // From 2.10 a list of constants is one vector, named by the bare label.
    if (versionAtLeast(version, '2.10')) return [];
    const list = str(values.VALUES).split(',').map(str).filter(Boolean);
    return list.map((_, i) => `.v-${i}`);
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
    const blocks = reductionBlocks(values[r.k]);
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
 * PRINT: CV labels and components, then function labels.
 *
 * @param {object} config
 * @returns {Array<{arg:string, source:string, kind:'cv'|'function'}>}
 */
export function availableArguments(config = {}) {
  const catalogue = config.catalogue || CV_DEFS;
  const options = { version: config.version, syntax: config.syntax };
  const out = [];
  for (const cv of config.cvs || []) {
    if (!cv || !cv.label) continue;
    const def = catalogue[cv.type] || {};
    if (def.isGroup || cv.isGroup) continue;
    const comps = componentsForCV(cv, catalogue, options);
    if (comps.length) comps.forEach(c => out.push({ arg: cv.label + c, source: cv.label, kind: 'cv' }));
    else out.push({ arg: cv.label, source: cv.label, kind: 'cv' });
  }
  for (const fn of config.functions || []) {
    if (fn && fn.label) out.push({ arg: fn.label, source: fn.label, kind: 'function' });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Creating instances
 * ------------------------------------------------------------------ */

const PERIODIC_TYPES = Object.freeze([
  'TORSION', 'TORSIONS', 'PUCKERING', 'XYTORSIONS'
]);
const ANGLE_TYPES = Object.freeze(['ANGLE', 'ANGLES', 'XANGLES']);
const UNIT_RANGE_TYPES = Object.freeze([
  'TETRAHEDRAL', 'LOCAL_Q6', 'LOCAL_Q4', 'LOCAL_Q3', 'FCCUBIC', 'SMAC', 'ATOMIC_SMAC',
  'TETRA_RADIAL', 'TETRA_ANGULAR', 'Q6', 'Q4', 'Q3'
]);
const LENGTH_TYPES = Object.freeze([
  'DISTANCE', 'RMSD', 'DRMSD', 'GYRATION', 'POSITION', 'INPLANEDISTANCES'
]);

/**
 * Starting grid and hill width for a CV type. They are placeholders for the
 * range a CV usually spans, to be replaced by what a trial run shows.
 *
 * @param {string} type
 * @returns {{comp:string, min:string, max:string, bin:string, sigma:string}}
 */
export function defaultBiasValues(type) {
  const base = { comp: '', min: '0.0', max: '10.0', bin: '200', sigma: '0.1' };
  if (type === 'PATHMSD') return { ...base, min: '1.0', max: '10.0', sigma: '0.5', comp: '.sss' };
  if (type === 'PROPERTYMAP') return { ...base, comp: '.zzz' };
  if (type === 'PCARMSD') return { ...base, comp: '.residual' };
  if (type === 'PROJECTION_ON_AXIS') return { ...base, min: '-5.0', max: '5.0', comp: '.proj' };
  if (PERIODIC_TYPES.includes(type)) return { ...base, min: '-pi', max: 'pi' };
  if (ANGLE_TYPES.includes(type)) return { ...base, min: '0.0', max: 'pi' };
  if (UNIT_RANGE_TYPES.includes(type)) return { ...base, max: '1.0', sigma: '0.02' };
  if (LENGTH_TYPES.includes(type)) return { ...base, max: '5.0', sigma: '0.05' };
  if (['COORDINATION', 'COORDINATIONNUMBER', 'COORDINATIONNUMBER_ADV', 'COORDINATION_MOMENTS',
    'CONTACTMAP'].includes(type)) return { ...base, max: '20.0', sigma: '0.2' };
  return base;
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
    const any = allowedReductions(def).some(r => reductionEnabled(inst, r));
    if (!any && allowedReductions(def).some(r => r.k === 'MEAN')) inst.values.MEAN = true;
    else if (!any && def.seed) Object.assign(inst.values, def.seed);
  }
  const comps = componentsForCV(inst, catalogue, options);
  if (comps.length && !comps.includes(inst.biasValues.comp)) inst.biasValues.comp = comps[0];
  if (!comps.length && def.compStyle) inst.biasValues.comp = '';
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

function pushReduction(parts, r, value) {
  if (r.type === 'flag') {
    if (value) parts.push(r.k);
    return;
  }
  const blocks = reductionBlocks(value);
  if (blocks.length === 1) pushFieldToken(parts, { k: r.k, type: 'text' }, blocks[0]);
  else blocks.forEach((b, i) => pushFieldToken(parts, { k: `${r.k}${i + 1}`, type: 'text' }, b));
}

/**
 * Build the PLUMED line for one CV instance.
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
    return { line: `${label}: ${raw}`, warnings, usedFallback: false, action: actionNameFor(instance, def) || null };
  }

  const resolved = resolveAction(instance.type, def, version);
  if (!resolved.available) {
    return {
      line: null,
      warnings: [
        `${instance.type} requires PLUMED ${def.minVersion} or newer; ` +
        `target is ${version} and no fallback action exists.`
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

  // Order parameters always fold the switching parameters into SWITCH={...};
  // two-group COORDINATION does so only when D_MAX is given, since the block
  // is what enables linked cells.
  let folded = [];
  if (def.switchSpeed) folded = SWITCH_KEYS.slice();
  else if (def.coordSwitch && !blank(values.D_MAX)) folded = SWITCH_KEYS.slice();

  const parts = [];
  for (const f of fields) {
    if (hidden.has(f.k) || folded.includes(f.k)) continue;
    const v = valueOf(f);
    if (f.required && blank(v)) {
      warnings.push(`${instance.type} (${label}) is missing required \`${f.k}\`.`);
    }
    if (REDUCTION_BY_KEY[f.k] && isMulticolvar(def)) pushReduction(parts, REDUCTION_BY_KEY[f.k], v);
    else pushFieldToken(parts, f, v);
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
 * `D_MAX` is worth setting: beyond it the function is exactly zero, which lets
 * PLUMED use linked cells for neighbour search and is often a large speedup.
 * It must sit comfortably above r0, or contacts are truncated while the switch
 * is still appreciable.
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
      'No D_MAX set. Setting it lets PLUMED use linked cells for neighbour ' +
      'search, which is often a substantial speedup for large groups.'
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
 *   temp?:string|number, label?:string}} [options]
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
    min: c.min !== undefined ? str(c.min) : listAt(params.gridMin, i, n),
    max: c.max !== undefined ? str(c.max) : listAt(params.gridMax, i, n),
    bin: c.bin !== undefined ? str(c.bin) : listAt(params.gridBin, i, n),
    sigma: c.sigma !== undefined ? str(c.sigma) : listAt(params.sigma, i, n)
  }));
  const useGrid = legacyGrid ? t.every(c => c.min && c.max) : !!options.grid;
  const useRct = !!options.rct;
  const walkers = options.walkers || { mode: 'none' };
  const stride = str(options.stride) || '500';
  const label = options.label || BIAS_LABEL[method];

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
    if (walkers.mode === 'mpi') return ['    WALKERS_MPI'];
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
      lines.push('    STATE_WFILE=State.data');
      lines.push(`    STATE_WSTRIDE=${Math.max(parseInt(stride, 10) * 20 || 10000, 10000)}`);
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
      components = [`${label}.bias`];
      break;
    }

    default:
      warnings.push(`Unknown bias method "${method}".`);
  }

  return { lines, warnings, components, label, title };
}

/* A wrong GRID_MIN/GRID_MAX does not stop the run; it distorts the
   free-energy surface, so these are reported before a long job. */
function gridWarnings(targets, { useGrid }) {
  const warnings = [];
  for (const c of targets) {
    const sg = parseNumber(c.sigma);
    if (c.sigma && (sg === null || sg <= 0) && c.sigma.toUpperCase() !== 'ADAPTIVE') {
      warnings.push(`SIGMA for \`${c.arg}\` must be a positive number.`);
    }
    if (!useGrid) continue;
    const lo = parseNumber(c.min);
    const hi = parseNumber(c.max);
    const nb = parseNumber(c.bin);
    const periodic = PERIODIC_TYPES.includes(c.type);
    const angle = ANGLE_TYPES.includes(c.type);
    const unit = UNIT_RANGE_TYPES.includes(c.type);

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
    if (periodic && (Math.abs(lo + Math.PI) > 1e-3 || Math.abs(hi - Math.PI) > 1e-3)) {
      warnings.push(
        `**Check grid bounds:** \`${c.arg}\` (${c.type}) is periodic on \`-pi..pi\`, but its ` +
        `grid is ${c.min}..${c.max}. PLUMED stops when a periodic variable's grid is not ` +
        'its period. Set GRID MIN/MAX to `-pi`/`pi`.');
    }
    if (angle && (lo < -1e-6 || hi > Math.PI + 1e-3)) {
      warnings.push(
        `**Check grid bounds:** \`${c.arg}\` (${c.type}) lies in \`0..pi\`, but its grid is ` +
        `${c.min}..${c.max}.`);
    }
    if (unit && hi > 2) {
      warnings.push(
        `**Check grid bounds:** \`${c.arg}\` (${c.type}) normally lies in \`0..1\`, but its ` +
        `grid runs to ${c.max}. Most of the grid would never be visited.`);
    }
    if (!periodic && !angle && !unit && c.min === '0.0' && c.max === '10.0') {
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
      '`plumed --multi N`). On a single-rank job this silently reduces to one walker, and ' +
      'the run looks fine but shares no bias.');
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
    warnings.push(
      `Every walker needs a **different** \`WALKERS_ID\`, but this file hardcodes \`${wid}\`. ` +
      'Use the run files below, which write one input per walker.');
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
 * Expand a PLUMED atom list into indices: `1,2`, `1-100`, `1-100:2`.
 * Labels and `@` selections are returned separately, since only PLUMED can
 * resolve them.
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
    const m = /^(\d+)-(\d+)(?::(\d+))?$/.exec(part);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      const step = m[3] === undefined ? 1 : Number(m[3]);
      if (step < 1) { errors.push(`"${part}" has a stride of zero.`); continue; }
      if (b < a) { errors.push(`"${part}" runs backwards.`); continue; }
      const n = Math.floor((b - a) / step) + 1;
      count += n;
      if (indices.length + n <= limit) {
        for (let i = a; i <= b; i += step) indices.push(i);
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
    if (!has('D_MAX') && !values.NLIST) {
      warnings.push(
        `COORDINATION (${label}) has no speed cutoff. Set \`D_MAX\` (linked cells) or enable ` +
        '`NLIST` with `NL_CUTOFF`/`NL_STRIDE`.');
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
      } else if (dmax < d0 + 1.5 * r0) {
        const s = rationalSwitch(dmax - 1e-9, {
          r0, d0, nn: parseNumber(values.NN) || 6, mm: parseNumber(values.MM) || 0
        });
        warnings.push(
          `${instance.type} (${label}): at \`D_MAX=${values.D_MAX}\` the switching function is ` +
          `still ${s.toFixed(2)}, so contacts are cut off abruptly. PLUMED stretches the ` +
          `function to reach zero there; set D_MAX near ${(d0 + 2 * r0).toFixed(2)} or beyond.`);
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

  const expect = { DISTANCE: [2], TORSION: [4], ANGLE: [3, 4], PUCKERING: [5, 6],
    DIHEDRAL_CORRELATION: [8], PLANE: [3, 4] }[instance.type];
  for (const f of def.fields || []) {
    if (f.type !== 'atoms' || blank(values[f.k])) continue;
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
 *     flush?:string|number},
 *   molinfo?: {structure?:string, moltype?:string},
 *   whole?: {enabled?:boolean, residues?:boolean, entities?:string[]|string},
 *   cvs?: Array<object>,
 *   functions?: Array<object>,
 *   bias?: {method?:string, params?:object, temp?:string, stride?:string,
 *     grid?:boolean, rct?:boolean, walkers?:object},
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
  lines.push('# Check it before the run:  plumed driver --natoms N --parse-only --plumed plumed.dat');
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

  if (!c.cvs.length && !c.functions.length) {
    if (!c.legacy) lines.push('# (No collective variables added yet.)');
    return finish();
  }

  /* --- Collective variables --- */
  const definedAtoms = new Set(splitList(pre.definedLabels));
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
        known: includes.length ? null : definedAtoms
      }));
      if (def.prereq && PREREQS[def.prereq] && !(def.prereqSkipIf && def.prereqSkipIf(cv))) {
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
  const trustUnknown = includes.length > 0;
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
  for (const cv of c.cvs) {
    const def = catalogue[cv.type] || {};
    if (!cv.bias || def.isGroup || cv.isGroup || def.noBias) continue;
    const bv = cv.biasValues || {};
    const comps = componentsForCV(cv, catalogue, { version, syntax });
    let comp = str(bv.comp);
    if (comps.length && !comps.includes(comp)) comp = comps[0];
    if (!comps.length && def.compStyle === 'none') comp = '';
    const t = { arg: cv.label + comp, label: cv.label, type: cv.type };
    if (!c.legacy) Object.assign(t, { min: bv.min, max: bv.max, bin: bv.bin, sigma: bv.sigma });
    targets.push(t);
  }
  for (const fn of c.functions) {
    if (!fn.bias) continue;
    const bv = fn.biasValues || {};
    const periodic = str(fn.values && fn.values.PERIODIC).toUpperCase();
    targets.push({
      arg: fn.label, label: fn.label, type: periodic && periodic !== 'NO' ? 'FUNCTION_PERIODIC' : fn.type,
      min: bv.min, max: bv.max, bin: bv.bin, sigma: bv.sigma
    });
  }

  const biasOptions = c.legacy ? {} : {
    grid: c.bias.grid !== false, rct: !!c.bias.rct, walkers: c.bias.walkers,
    stride: c.bias.stride, temp: c.bias.temp
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
    const line = buildPrintLine(args.map(a => ({ label: a })), { stride, file });
    if (line) { lines.push(c.legacy ? line : line.replace(/ STRIDE=(\S+) FILE=(\S+)$/, ' FILE=$2 STRIDE=$1')); note('PRINT'); }
  });
  const files = c.prints.map((p, i) => str(p.file) || (i === 0 ? 'COLVAR' : `COLVAR.${i}`));
  if (new Set(files).size !== files.length) {
    warnings.push('Two PRINT actions write to the same file. Give each its own file name.');
  }

  return finish(cvLines, targets.map(t => t.arg), [...bias.components, ...extraComponents]);

  function finish(cvLinesOut = [], biased = [], printableOut = []) {
    const modules = [];
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
        const m = syntax.moduleOf(a);
        if (m && !m.defaultOn && !seen.has(m.name)) {
          seen.add(m.name);
          modules.push(m.name);
        }
      }
      for (const m of modules) {
        const users = actions.filter(a => syntax.has(a) && syntax.moduleOf(a).name === m);
        warnings.push(
          `${users.map(a => `\`${a}\``).join(', ')} need${users.length === 1 ? 's' : ''} the ` +
          `**${m}** module, which a default PLUMED ${version} build leaves out. Check with ` +
          `\`plumed config has module ${m}\`, and rebuild with ` +
          `\`./configure --enable-modules=${m}\` (or \`all\`) if it is missing.`);
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
