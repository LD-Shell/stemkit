/*
 * STEMKit, MD Workflow Generator: the rules of the PLUMED tab, apart from the DOM.
 * Author: Olanrewaju M. Daramola
 *
 * What the PLUMED tab decides for itself, as opposed to what the file says
 * (src/core/plumed.js): which column of a COLVAR a biased value is, the
 * temperature a run was made at, what a wall's or a restraint's parameters
 * do, which speed options a method uses, the length unit the cards show,
 * how a starting value moves when the units or the biased value change,
 * which atom of a molecule a tick means, the unit of a distance in a
 * selection, and the command that has PLUMED check a file. Each is a plain
 * function, so the tests (tests/plumed-page.test.js, plumed-units.test.js)
 * reach it without a browser and check it against PLUMED and GROMACS
 * themselves.
 */

import {
  LENGTH_IN_NM, ENERGY_IN_KJMOL, BIAS_DEFS, biasKeywordUnit, defaultBiasValues, lengthPower
} from '../src/core/plumed.js';
import { moleculesOf } from '../src/core/plumed-atoms.js';

/* ------------------------------------------------------------------ *
 * The names of values
 * ------------------------------------------------------------------ */

/**
 * Is a COLVAR column the value a builder argument names?
 *
 * From PLUMED 2.10 a multicolvar such as Q6 or COORDINATIONNUMBER is a
 * shortcut, and its reductions are actions of their own: the input may say
 * `cv1.mean`, and PLUMED accepts it, but the COLVAR and HILLS headers say
 * `cv1_mean`. A label cannot hold a dot, so the first dot of an argument is
 * where the label ends.
 *
 * @param {string} arg - The name the builder writes, e.g. `cv1.mean`.
 * @param {string} column - A field of the COLVAR header.
 * @returns {boolean}
 */
export function sameValueName(arg, column) {
  const a = String(arg ?? '');
  const c = String(column ?? '');
  if (!a || !c) return false;
  if (a === c) return true;
  const dot = a.indexOf('.');
  return dot > 0 && `${a.slice(0, dot)}_${a.slice(dot + 1)}` === c;
}

/**
 * The biased value a COLVAR column holds. An exact name wins over the 2.10
 * spelling, so a label that happens to contain `_` is never shadowed.
 *
 * @template {{arg:string}} T
 * @param {T[]} targets - What the bias acts on.
 * @param {string} column
 * @returns {T|undefined}
 */
export function findTarget(targets, column) {
  const list = Array.isArray(targets) ? targets : [];
  return list.find(t => t.arg === column) || list.find(t => sameValueName(t.arg, column));
}

/* ------------------------------------------------------------------ *
 * Temperature
 * ------------------------------------------------------------------ */

const number = (v) => {
  const n = parseFloat(String(v ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};

/**
 * The temperature the file is written for: the method's own TEMP when it is
 * typed, which the generator writes in place of the global one, else the
 * global TEMP.
 *
 * @param {object} params - The method's parameters (`TEMP` when it takes one).
 * @param {string|number} globalTemp - The TEMP field of the page.
 * @returns {number} Kelvin, or NaN when neither is a number.
 */
export function methodTemperature(params, globalTemp) {
  const own = number(params && params.TEMP);
  if (own > 0) return own;
  const global = number(globalTemp);
  return global > 0 ? global : NaN;
}

/* ------------------------------------------------------------------ *
 * Walls and restraints
 * ------------------------------------------------------------------ */

/**
 * The help of each field of a wall or restraint card, from what PLUMED
 * computes (src/bias/UWalls.cpp, LWalls.cpp and Restraint.cpp):
 *
 *   UPPER_WALLS  KAPPA ((x - AT + OFFSET)/EPS)^EXP  where x > AT - OFFSET
 *   LOWER_WALLS  KAPPA ((AT + OFFSET - x)/EPS)^EXP  where x < AT + OFFSET
 *   RESTRAINT    1/2 KAPPA (x - AT)^2 + SLOPE (x - AT)
 *
 * The half is in the restraint only, so the same KAPPA pulls half as hard
 * there as in a harmonic wall.
 *
 * @param {'upper'|'lower'|'restraint'} type
 * @returns {{at:string, kappa:string, exp?:string, offset?:string}}
 */
export function restraintHelp(type) {
  if (type === 'restraint') {
    return {
      at: 'The value the restraint pulls toward.',
      kappa: 'Force constant, in energy per unit of the value squared. The energy is ½ KAPPA (x − AT)², ' +
        'half of what a wall with EXP=2 gives for the same KAPPA.'
    };
  }
  const upper = type === 'upper';
  return {
    at: upper
      ? 'The wall is felt when the value rises above this (above AT − OFFSET when OFFSET is set).'
      : 'The wall is felt when the value falls below this (below AT + OFFSET when OFFSET is set).',
    kappa: 'Force constant, in energy per unit of the value to the power EXP. The energy is KAPPA times ' +
      'the distance past the wall, to the power EXP, with no factor of ½.',
    exp: 'Power of the wall. 2 is harmonic; 4 is flatter near the wall and steeper beyond.',
    offset: upper
      ? 'Moves the start of the wall down to AT − OFFSET, without moving AT.'
      : 'Moves the start of the wall up to AT + OFFSET, without moving AT.'
  };
}

/* ------------------------------------------------------------------ *
 * Speed options
 * ------------------------------------------------------------------ */

/**
 * Which speed and replica options a method uses. PBMETAD has a grid but no
 * CALC_RCT; OPES_METAD has neither (it compresses its kernels, and gives
 * c(t) as opes.rct anyway), so the boxes are hidden there, with the reason,
 * rather than shown and ignored.
 *
 * @param {string} method - Key of BIAS_DEFS.
 * @returns {{panel:boolean, grid:boolean, rct:boolean, note:string}}
 */
export function speedOptions(method) {
  switch (method) {
    case 'metad':
    case 'wt_metad':
      return { panel: true, grid: true, rct: true, note: '' };
    case 'pbmetad':
      return {
        panel: true, grid: true, rct: false,
        note: 'PBMETAD has no CALC_RCT, so on-the-fly reweighting is not offered.'
      };
    case 'opes':
      return {
        panel: true, grid: false, rct: false,
        note: 'OPES keeps its kernels compressed rather than on a grid, and gives c(t) itself as opes.rct, ' +
          'so neither the grid nor CALC_RCT applies.'
      };
    default:
      return { panel: false, grid: false, rct: false, note: '' };
  }
}

/* ------------------------------------------------------------------ *
 * Length units
 * ------------------------------------------------------------------ */

/** How each UNITS LENGTH choice is written next to a number. */
export const LENGTH_NAMES = Object.freeze({ nm: 'nm', A: 'Å', um: 'µm', Bohr: 'Bohr' });

/**
 * A catalogue label or help with its `(nm)` in the chosen length unit. The
 * catalogue is written in nm, PLUMED's default; after `UNITS LENGTH=A` the
 * same field takes Å, and the card should say so.
 *
 * @param {string} text
 * @param {string} unit - A key of LENGTH_NAMES.
 * @returns {string}
 */
export function withLengthUnit(text, unit) {
  const s = String(text ?? '');
  const name = LENGTH_NAMES[unit];
  if (!name || unit === 'nm') return s;
  return s.replace(/\(nm\)/g, `(${name})`);
}

/** Is a catalogue field a length (its label carries the unit)? */
export const isLengthField = (f) => !!f && /\(nm\)/.test(String(f.label || ''));

/**
 * Is a catalogue field a block whose starting text holds lengths: a
 * distance switching function (`SWITCH={RATIONAL R_0=0.3 D_MAX=0.6}`, or
 * CONTACTMAP's numbered `SWITCH1=`), or a starting reduction of a
 * multicolvar whose items are lengths (see {@link lengthFields})?
 * SWITCH_COORD switches on a count and KERNELn on an angle, so neither is.
 */
export const isLengthBlock = (f) => !!f && (f.block === true ||
  (f.type === 'text' && typeof f.def === 'string' &&
    (f.k === 'SWITCH' || /\bSWITCH\d+=\{/.test(f.def))));

/* The keywords of a switching function or kernel that are lengths when the
   block switches on a distance. */
const BLOCK_LENGTHS = /\b(R_0|D_0|D_MAX|LOWER|UPPER)=([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(?=[\s}]|$)/g;

/**
 * A block with its lengths (R_0, D_0, D_MAX, and a kernel's LOWER and
 * UPPER) written in another unit; SMEAR, NN, MM and the rest have none.
 *
 * @param {string} text - e.g. `{RATIONAL R_0=0.3 D_MAX=0.6}`.
 * @param {string} from - A key of LENGTH_IN_NM.
 * @param {string} to
 * @returns {string}
 */
export function convertBlockLengths(text, from, to) {
  const s = String(text ?? '');
  if (from === to || !LENGTH_IN_NM[from] || !LENGTH_IN_NM[to]) return s;
  return s.replace(BLOCK_LENGTHS, (all, key, value) => `${key}=${convertLength(value, from, to)}`);
}

/**
 * The fields of a catalogue entry whose starting values follow UNITS LENGTH:
 * the lengths (labelled `(nm)`), the distance switching functions written as
 * blocks, and a starting reduction (`seed`) of a multicolvar whose items are
 * lengths, such as INPLANEDISTANCES' `LESS_THAN={RATIONAL R_0=0.5 D_MAX=1.0}`,
 * whose threshold is an in-plane distance. A seed of TORSIONS is an angle and
 * of Q6 a number, and stays as it is.
 *
 * @param {object} def - Catalogue entry.
 * @param {string} type - Its key.
 * @returns {object[]} Fields in the form convertLengthDefaults takes.
 */
export function lengthFields(def, type) {
  const out = ((def && def.fields) || []).filter(f => isLengthField(f) || isLengthBlock(f));
  const sep = def && def.compStyle === 'underscore' ? '_' : '.';
  if (def && def.seed && lengthPower(type, `${sep}mean`) > 0) {
    for (const [k, v] of Object.entries(def.seed)) {
      if (typeof v === 'string') out.push({ k, def: v, type: 'text', block: true });
    }
  }
  return out;
}

/**
 * A length written in another unit, to six significant figures.
 *
 * @param {string|number} value
 * @param {string} from - A key of LENGTH_IN_NM.
 * @param {string} to
 * @param {number} [power] - 2 for an area such as nm².
 * @returns {string} The value unchanged when it is not a number.
 */
export function convertLength(value, from, to, power = 1) {
  const n = number(value);
  if (!Number.isFinite(n) || !LENGTH_IN_NM[from] || !LENGTH_IN_NM[to]) return String(value ?? '');
  if (from === to || !power) return String(value);
  return String(Number((n * (LENGTH_IN_NM[from] / LENGTH_IN_NM[to]) ** power).toPrecision(6)));
}

/**
 * Move the lengths a card still holds at their starting values to a new
 * unit. A value the person typed is left alone: it was typed for a unit the
 * page cannot know, and the note under the units says every length must be
 * in the chosen one.
 *
 * @param {object} values - The card's values, by keyword.
 * @param {object[]} fields - Its catalogue fields.
 * @param {string} from - The unit the starting values are in now.
 * @param {string} to
 * @returns {{values:object, changed:string[]}} New values, and the keywords moved.
 */
export function convertLengthDefaults(values, fields, from, to) {
  const out = { ...(values || {}) };
  const changed = [];
  if (from === to || !LENGTH_IN_NM[from] || !LENGTH_IN_NM[to]) return { values: out, changed };
  for (const f of fields || []) {
    if (f && isLengthBlock(f) && typeof f.def === 'string' && f.def.trim()) {
      // A block is compared as text: it is a start only while it reads as one.
      if (String(out[f.k] ?? '').trim() !== convertBlockLengths(f.def, 'nm', from).trim()) continue;
      const moved = convertBlockLengths(f.def, 'nm', to);
      if (moved !== String(out[f.k])) {
        out[f.k] = moved;
        changed.push(f.k);
      }
      continue;
    }
    if (!isLengthField(f) || f.def === undefined || String(f.def).trim() === '') continue;
    const now = number(out[f.k]);
    const start = number(convertLength(f.def, 'nm', from));
    if (!Number.isFinite(now) || !Number.isFinite(start)) continue;
    if (Math.abs(now - start) > 1e-9 * Math.max(1, Math.abs(start))) continue;
    out[f.k] = convertLength(f.def, 'nm', to);
    changed.push(f.k);
  }
  return { values: out, changed };
}

/**
 * Move a biased value's grid bounds and SIGMA to a new length unit while
 * they still hold their starting values, as convertLengthDefaults does for
 * the fields. `start` is what defaultBiasValues gives, in nm; `power` is
 * lengthPower of the value (0 leaves everything as it is). A bound at zero
 * is the same in every unit and is left as written.
 *
 * @param {object} biasValues - {min, max, bin, sigma, comp}.
 * @param {{min?:string, max?:string, sigma?:string}} start
 * @param {number} power
 * @param {string} from - The unit the values are in now.
 * @param {string} to
 * @returns {{values:object, changed:string[]}}
 */
export function convertBiasDefaults(biasValues, start, power, from, to) {
  const out = { ...(biasValues || {}) };
  const changed = [];
  if (!power || from === to || !LENGTH_IN_NM[from] || !LENGTH_IN_NM[to]) return { values: out, changed };
  for (const k of ['min', 'max', 'sigma']) {
    const def = start && start[k];
    const nm = number(def);
    if (!Number.isFinite(nm) || nm === 0) continue;
    const now = number(out[k]);
    const was = number(convertLength(def, 'nm', from, power));
    if (!Number.isFinite(now) || Math.abs(now - was) > 1e-9 * Math.max(1, Math.abs(was))) continue;
    out[k] = convertLength(def, 'nm', to, power);
    changed.push(k);
  }
  return { values: out, changed };
}

/* ------------------------------------------------------------------ *
 * Energy units
 * ------------------------------------------------------------------ */

/** Method parameters that are energies: their starting values follow UNITS ENERGY. */
export const ENERGY_PARAMS = Object.freeze(['HEIGHT', 'BARRIER']);

/**
 * An energy written in another unit, to `digits` significant figures.
 *
 * @param {string|number} value
 * @param {string} from - A key of ENERGY_IN_KJMOL.
 * @param {string} to
 * @param {number} [digits]
 * @returns {string} The value unchanged when it is not a number.
 */
export function convertEnergy(value, from, to, digits = 6) {
  const n = number(value);
  if (!Number.isFinite(n) || !ENERGY_IN_KJMOL[from] || !ENERGY_IN_KJMOL[to]) return String(value ?? '');
  if (from === to) return String(value);
  return String(Number((n * ENERGY_IN_KJMOL[from] / ENERGY_IN_KJMOL[to]).toPrecision(digits)));
}

/* ------------------------------------------------------------------ *
 * Starting values in the units of the file
 * ------------------------------------------------------------------ */

/** The units the catalogue's starting values are written in: PLUMED's own. */
export const CATALOGUE_UNITS = Object.freeze({ length: 'nm', energy: 'kj/mol' });

/* One number as written, or NaN: `2pi`, `1,2` and `0.5nm` are not one. */
function strictNumber(value) {
  const t = String(value ?? '').trim();
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t) ? Number(t) : NaN;
}

/* Do two values read the same: equal numbers, or the same text? */
function sameValue(a, b) {
  const x = strictNumber(a);
  const y = strictNumber(b);
  if (Number.isFinite(x) && Number.isFinite(y)) return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(y));
  return String(a ?? '').trim() === String(b ?? '').trim();
}

/* The value of a comma-separated per-argument list for argument i of n: a
   single value stands for every argument, as the generator reads it. */
function listItem(value, i, n) {
  const parts = String(value ?? '').split(',').map(x => x.trim());
  if (parts.length === 1 && n > 1) return parts[0];
  return parts[i] === undefined ? '' : parts[i];
}

/**
 * A value whose unit is length^a energy^b, written in other units, to
 * `digits` significant figures.
 *
 * @param {string|number} value
 * @param {{length?:number, energy?:number}|null} unit - As biasKeywordUnit gives it.
 * @param {{length?:string, energy?:string}} from - Keys of LENGTH_IN_NM and ENERGY_IN_KJMOL.
 * @param {{length?:string, energy?:string}} to
 * @param {number} [digits=6]
 * @returns {string} The value as written when it is not one number, has no
 *          unit, is zero, or the units give it the same number.
 */
export function convertQuantity(value, unit, from, to, digits = 6) {
  const text = String(value ?? '');
  const n = strictNumber(text);
  if (!unit || !Number.isFinite(n) || n === 0) return text;
  const f = { ...CATALOGUE_UNITS, ...(from || {}) };
  const t = { ...CATALOGUE_UNITS, ...(to || {}) };
  const L = [LENGTH_IN_NM[f.length], LENGTH_IN_NM[t.length]];
  const E = [ENERGY_IN_KJMOL[f.energy], ENERGY_IN_KJMOL[t.energy]];
  if (!L[0] || !L[1] || !E[0] || !E[1]) return text;
  const factor = (L[0] / L[1]) ** (unit.length || 0) * (E[0] / E[1]) ** (unit.energy || 0);
  if (factor === 1) return text;
  return String(Number((n * factor).toPrecision(digits)));
}

/**
 * A method parameter's starting value in the chosen units, for the values
 * the method biases. The catalogue writes every value in nm and kJ/mol; the
 * unit of each keyword (biasKeywordUnit) says how it moves. After
 * `UNITS ENERGY=kcal/mol` a hill starts at 0.287, not 1.2; after
 * `UNITS LENGTH=A` an upper wall on a distance starts at AT=20 with
 * KAPPA=1.5 kJ/mol/Å², and on a torsion at AT=2.0 with KAPPA=150: when the
 * biased values differ the start is one value per argument. HEIGHT and
 * BARRIER keep three figures, the rest six. A value the person typed is
 * not a starting value and is never passed here.
 *
 * @param {{k:string, def?:string}} param - A BIAS_DEFS parameter.
 * @param {string|{length?:string, energy?:string}} units - The file's units;
 *        a string is an energy unit, with lengths in nm.
 * @param {{method?:string, targets?:Array<{power:number}>, exp?:string}} [context]
 *        The method, the biased values in ARG order with lengthPower of
 *        each (none counts as one value of no length), and a wall's EXP as
 *        the method panel holds it.
 * @returns {string}
 */
export function startingParam(param, units, context = {}) {
  const def = param && param.def !== undefined && param.def !== null ? String(param.def) : '';
  if (!param || !def.trim()) return def;
  const to = typeof units === 'string' ? { length: 'nm', energy: units } : { ...CATALOGUE_UNITS, ...(units || {}) };
  const digits = ENERGY_PARAMS.includes(param.k) ? 3 : 6;
  const targets = Array.isArray(context.targets) && context.targets.length ? context.targets : [{ power: 0 }];
  const n = targets.length;
  const each = targets.map((t, i) => convertQuantity(def,
    biasKeywordUnit(context.method, param.k, { power: t.power, exp: listItem(context.exp, i, n) }),
    CATALOGUE_UNITS, to, digits));
  return each.every(v => v === each[0]) ? each[0] : each.join(',');
}

/**
 * The starting values of a wall or restraint card, for the value it acts
 * on, in the chosen units. KAPPA starts where the method panel's does, 200
 * for RESTRAINT and 150 for a wall in kJ/mol per nm² of a distance, and
 * moves with the units and with the argument's unit; AT is the person's to
 * choose and starts blank.
 *
 * @param {'upper'|'lower'|'restraint'} type
 * @param {{power?:number, exp?:string}} arg - lengthPower of the argument and
 *        the card's EXP.
 * @param {{length?:string, energy?:string}} [units]
 * @returns {{kappa:string}|null} Null for an unknown type.
 */
export function cardStarts(type, arg = {}, units = CATALOGUE_UNITS) {
  const kappa = ((BIAS_DEFS[type] && BIAS_DEFS[type].params) || []).find(p => p.k === 'KAPPA');
  if (!kappa || !['upper', 'lower', 'restraint'].includes(type)) return null;
  const unit = biasKeywordUnit(type, 'KAPPA', { power: arg.power, exp: arg.exp });
  return { kappa: convertQuantity(kappa.def, unit, CATALOGUE_UNITS, units) };
}

/**
 * Starting values that follow a change: of the units, of the component a
 * bias acts on, of a wall's argument or EXP. `before` and `after` hold the
 * starting value of each key under the old and the new state; a value still
 * at its old start takes the new one, and a value the person typed stays
 * as typed. A start that reads the same either way (a bound at 0) is left
 * as written.
 *
 * @param {object} values
 * @param {object|null} before - Starting values by key, before the change.
 * @param {object|null} after - The same after it.
 * @param {string[]} [keys] - The keys to follow; all of `after` by default.
 * @returns {{values:object, changed:string[]}}
 */
export function rebaseStarts(values, before, after, keys) {
  const out = { ...(values || {}) };
  const changed = [];
  if (!before || !after) return { values: out, changed };
  for (const k of keys || Object.keys(after)) {
    if (before[k] === undefined || after[k] === undefined) continue;
    if (!sameValue(out[k], before[k]) || sameValue(out[k], after[k])) continue;
    out[k] = after[k];
    changed.push(k);
  }
  return { values: out, changed };
}

/**
 * The starting grid bounds, bins and SIGMA of a biased value in a length
 * unit: defaultBiasValues, in nm, moved by the value's power of length. A
 * bound at 0 reads as the catalogue writes it.
 *
 * @param {string} type - Catalogue key.
 * @param {string} comp - The biased component, or ''.
 * @param {object} values - The CV's values.
 * @param {string} unit - A key of LENGTH_IN_NM.
 * @returns {{min:string, max:string, bin:string, sigma:string}}
 */
export function biasStart(type, comp, values, unit) {
  const start = defaultBiasValues(type, comp, { values });
  const power = lengthPower(type, comp, { values });
  const out = { min: start.min, max: start.max, bin: start.bin, sigma: start.sigma };
  for (const k of ['min', 'max', 'sigma']) {
    if (strictNumber(out[k]) !== 0) out[k] = convertLength(out[k], 'nm', unit, power);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Atoms of one molecule
 * ------------------------------------------------------------------ */

/*
 * A molecule built by Open Babel or for Packmol names its atoms by element:
 * C, C, O, H, H... A tick must mean that atom, not the first atom of that
 * name, so an atom whose name comes again is given a key with its place
 * among the atoms of that name (`C`, `C#2`). The same rule is applied to
 * every copy, so the key picks the same atom of each.
 */
const nthKey = (name, k) => (k > 1 ? `${name}#${k}` : name);

/** 1st, 2nd, 3rd, 4th... 11th, 12th, 13th, 21st. */
export function ordinal(n) {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${suffix}`;
}

/**
 * The atoms of one copy, each with a key that tells it from an atom of the
 * same name, and the words that name it for the person.
 *
 * @param {string[]} names - Atom names of one copy, in order.
 * @returns {Array<{name:string, key:string, nth:number, of:number,
 *   text:string}>} `of` is how many atoms of the copy share the name;
 *   `text` is `C (2nd)` for the second of two C, the bare name otherwise.
 */
export function distinctAtoms(names) {
  const list = (Array.isArray(names) ? names : []).map(String);
  const total = new Map();
  for (const n of list) total.set(n, (total.get(n) || 0) + 1);
  const seen = new Map();
  return list.map((name) => {
    const nth = (seen.get(name) || 0) + 1;
    seen.set(name, nth);
    const of = total.get(name);
    return { name, key: nthKey(name, nth), nth, of, text: of > 1 ? `${name} (${ordinal(nth)})` : name };
  });
}

/**
 * The structure with the atoms of one residue name keyed as distinctAtoms
 * keys them, for the per-molecule functions of src/core/plumed-atoms.js,
 * which find atoms by name. Other atoms are the same objects as before.
 *
 * @param {object[]} atoms - Records from src/core/structure.js.
 * @param {string} species - Residue name.
 * @returns {object[]}
 */
export function withDistinctNames(atoms, species) {
  const list = Array.isArray(atoms) ? atoms : [];
  const out = list.slice();
  for (const m of moleculesOf(list)) {
    if (m.name !== species) continue;
    const seen = new Map();
    for (const a of m.atoms) {
      const nth = (seen.get(a.name) || 0) + 1;
      seen.set(a.name, nth);
      if (nth > 1) out[a.index - 1] = { ...list[a.index - 1], atomName: nthKey(a.name, nth) };
    }
  }
  return out;
}

/**
 * How a key is shown to the person: `C (2nd)` for `C#2`. Given the names of
 * the copy, the first of a repeated name is `C (1st)`, not a bare `C`.
 *
 * @param {string} key
 * @param {string[]} [names] - Atom names of one copy.
 * @returns {string}
 */
export function atomKeyText(key, names) {
  const k = String(key ?? '');
  if (Array.isArray(names)) {
    const hit = distinctAtoms(names).find(a => a.key === k);
    if (hit) return hit.text;
  }
  const m = /^(.*)#(\d+)$/.exec(k);
  return m ? `${m[1]} (${ordinal(Number(m[2]))})` : k;
}

/**
 * The ticked atoms after one box changes, in the order they were ticked. A
 * direction runs from the first to the second, so the order is the person's,
 * not the order of the atoms in the molecule.
 *
 * @param {number[]} ticks - Places of the ticked atoms, first ticked first.
 * @param {number} place - The box that changed.
 * @param {boolean} checked
 * @returns {number[]}
 */
export function nextTicks(ticks, place, checked) {
  const out = (Array.isArray(ticks) ? ticks : []).filter(x => x !== place);
  if (checked) out.push(place);
  return out;
}

/**
 * The options of a selection query: its distances (within:, x:, y:, z:) are
 * in nm, the unit of a PLUMED input, and the atoms are in the file's unit
 * (nm for .gro, Å for PDB). Without this, within:0.5 on a PDB meant 0.5 Å.
 *
 * @param {string} fileUnit - `unit` of the parsed structure.
 * @returns {{unit:'nm', coordinateUnit:string}}
 */
export function pickUnits(fileUnit) {
  return { unit: 'nm', coordinateUnit: fileUnit === 'A' ? 'A' : 'nm' };
}

/**
 * Everything a selection on the PLUMED tab is made with: the units of
 * pickUnits, and the file's periodic box, so `within:` measures to the
 * nearest image as PLUMED and `gmx select` do. core/structure.js keeps every
 * box in nm, a PDB's CRYST1 included, which is selection.js's `boxUnit` by
 * default; `boxVectors` (nine components) carries a triclinic cell.
 *
 * @param {{unit?:string, box?:number[]|null, boxVectors?:number[]|null}} structure
 *        A parse result of core/structure.js, or what the page kept of one.
 * @returns {{unit:'nm', coordinateUnit:string, box:number[]|null, boxVectors:number[]|null}}
 */
export function pickOptions(structure) {
  const s = structure || {};
  // `CRYST1 1.000 1.000 1.000` is the PDB's way of saying there is no cell
  // (wwPDB format, CRYST1), as PyMOL writes it: measured through, a 1 Å box
  // would put every atom within reach of every other.
  const dummy = Array.isArray(s.box) && s.box.length >= 3 &&
    s.box.slice(0, 3).every(v => Math.abs(Number(v) - 0.1) < 1e-9);
  return {
    ...pickUnits(s.unit),
    box: Array.isArray(s.box) && !dummy ? s.box : null,
    boxVectors: Array.isArray(s.boxVectors) && !dummy ? s.boxVectors : null
  };
}

/** Does a query hold a distance, whose unit the result should name? */
export const queryHasLength = (query) => /(^|[\s!])(within|x|y|z):/i.test(String(query ?? ''));

/**
 * What loading a structure found. The structure is split by residue, so a
 * peptide of ten residues counts ten: the count is of residues, and says so.
 * What the reader warned of (models after the first skipped, uneven .gro
 * columns) follows.
 *
 * @param {string} name - File name.
 * @param {number} atoms
 * @param {Array<{molecules:number}>} species - From speciesOf.
 * @param {string[]} [warnings] - `warnings` of the parse result.
 * @returns {string}
 */
export function loadedText(name, atoms, species, warnings = []) {
  const residues = (species || []).reduce((n, s) => n + (s.molecules || 0), 0);
  const fmt = (n) => Number(n).toLocaleString('en-GB');
  const said = (Array.isArray(warnings) ? warnings : []).filter(Boolean);
  return `${name}: ${fmt(atoms)} atom${atoms === 1 ? '' : 's'} in ${fmt(residues)} residue${residues === 1 ? '' : 's'}.` +
    (said.length ? ` ${said.join(' ')}` : '');
}

/**
 * How the lists are numbered. GROMACS hands PLUMED the atoms in the order of
 * the run's structure; LAMMPS's fix plumed hands it the atom ID (tag - 1,
 * lammps/src/PLUMED/fix_plumed.cpp), which is the same only for a file
 * listed by ID from 1 with no gaps.
 */
export const NUMBERING_NOTE =
  'Every list below numbers them in the order of the file, from 1, as GROMACS passes them to PLUMED. ' +
  'Under LAMMPS PLUMED uses the atom IDs instead, which are the same numbers only when the file lists the ' +
  'atoms by ID, from 1, with no gaps. A molecule of several residues, such as a protein, is listed residue ' +
  'by residue.';

/* ------------------------------------------------------------------ *
 * Checking a file with PLUMED
 * ------------------------------------------------------------------ */

/**
 * The command that has PLUMED read a file without running it. PLUMED 2.11
 * refuses `--parse-only` without `--natoms` (cltools/Driver.cpp), so the
 * atom count is always given: the number when it is known, N when not.
 *
 * @param {number} [natoms]
 * @param {string} [file]
 * @returns {string}
 */
export function parseOnlyCommand(natoms, file = 'plumed.dat') {
  const n = Number.isInteger(natoms) && natoms > 0 ? String(natoms) : 'N';
  return `plumed driver --plumed ${file} --natoms ${n} --parse-only`;
}

/* ------------------------------------------------------------------ *
 * Modules a default build leaves out
 * ------------------------------------------------------------------ */

/**
 * The modules an action needs that a default `./configure` leaves out. From
 * PLUMED 2.10 a shortcut such as Q6 is written in one module (symfunc) and
 * builds actions from others (CONTACT_MATRIX, in adjmat), so every module
 * of what it expands to counts, not only its own.
 *
 * @param {object|null} syntax - A table from src/core/plumed-syntax.js.
 * @param {string} action
 * @returns {string[]} Module names, the action's own first.
 */
export function modulesToEnable(syntax, action) {
  if (!syntax || !action || !syntax.has(action)) return [];
  const all = typeof syntax.modulesFor === 'function'
    ? syntax.modulesFor(action) : [syntax.moduleOf(action)];
  return all.filter(m => m && m.name && !m.defaultOn).map(m => m.name);
}
