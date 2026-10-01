/**
 * @module core/lammps-workflow
 *
 * STEMKit, MD Workflow Generator: a LAMMPS run as data.
 * Author: Olanrewaju M. Daramola
 *
 * No DOM here. The page keeps its form as a plain state object
 * ({@link defaultLammpsState}); {@link buildLammpsWorkflow} turns it into the
 * input files of a minimise -> NVT -> NPT -> production run, with a note on
 * every line that holds a choice (why this value, in plain words with
 * units), the issues of the choices, and what each stage reads, writes and
 * costs on disk. {@link lammpsRunBlock} is the part of submit.sh that runs
 * the stages, and {@link lammpsReadme} the README of the zip. The presets
 * live in lammps-workflow-presets.js and the job block in
 * lammps-workflow-job.js; this module re-exports what the page needs.
 *
 * ## The files
 *
 * - `in.system`: how the system is made (units, styles, read_data or a
 *   lattice). Only the first stage reads it.
 * - `in.settings`: what every stage needs once the system is loaded, because
 *   a restart file does not keep it (read_restart docs): kspace, neighbour
 *   lists, the coefficients of pair styles that write no restart data
 *   (eam, tersoff, sw, reaxff, hybrid), fix qeq for ReaxFF, groups and the
 *   time step.
 * - `in.min`, `in.nvt`, `in.npt`, `in.prod`: one input per stage, chained by
 *   restart files: `min.restart`, then `nvt.restart.<step>`,
 *   `npt.restart.<step>` and production's `restart.<step>` (the names the
 *   PLUMED tab's job kit uses). A dynamics stage is complete once it has
 *   written the restart file of its last step; the next stage reads that file.
 * - `plumed.dat` (and the files its INCLUDE lines read) when PLUMED is on,
 *   and `README.md`.
 *
 * ## Variables the stage files expect
 *
 * Every dynamics stage file defines these with `variable ... index`, so a
 * value given on the command line (`-var name value`) wins and a file run
 * by hand (`lmp -in in.nvt`) starts the stage:
 *
 * | name | first run | continuation |
 * |---|---|---|
 * | `rstep` | `-1` | the step of the stage's newest restart file, e.g. `25000` for `nvt.restart.25000` |
 * | `time_limit` | `off`, or the wall time left in seconds | the same |
 * | `plumed_in` (stages with PLUMED only) | `plumed.dat` | `plumed.restart.dat` (`RESTART` + plumed.dat) |
 *
 * `in.min` takes no variables. `workflow.vars` gives these values for each
 * stage (`{nvt: {first, continue}, ...}`, with `rstep` of a continuation set
 * to the stage's first restart step as an example), so a checker can follow
 * the `if` lines; `workflow.files` holds `in.system` and `in.settings` for
 * the `include` lines.
 *
 * ## The state (defaultLammpsState)
 *
 * Plain JSON. Times are in the time unit of the units style (fs for real,
 * ps for metal, τ for lj) unless a field gives its own unit; temperatures
 * in K (real, metal) or ε/k_B (lj); pressures in atm (real), bar (metal) or
 * ε/σ³ (lj). `null` means "the preset's default", which the workflow
 * reports back (e.g. `workflow.timestep`, `stage.output`).
 *
 * - `forceField` (string): an id of {@link LMP_FORCE_FIELDS}.
 * - `ff` (object): the preset's own settings, changed by hand; keys and
 *   defaults are the preset's `options`, and {@link LMP_FF_FIELDS} labels
 *   those its `fields` list for the form: `inner`, `cutoff` (distance units),
 *   `kspaceAccuracy` (relative force error), `cmapFile`, `potentialFile`,
 *   `elements` (space-separated, one per atom type), `controlFile`,
 *   `qeqTolerance`, `epsilon`, `sigma`, `mass`, `ljTail`, `ljShift`
 *   (booleans); for 'custom': `lines` (your force-field lines), `units`,
 *   `atomStyle`.
 * - `styles` ({bond, angle, dihedral, improper}): bonded styles your data
 *   file was written for, '' for the preset's.
 * - `waterTypes` ({o, h, bond, angle}): water's atom, bond and angle types,
 *   null to take them from the data file.
 * - `extraLines` (string): more lines for in.settings, read by every stage
 *   (pair_coeff lines a data file lacks, for example).
 * - `system.source`: 'data' | 'lattice' | 'restart'; `system.dataFile`,
 *   `system.restartFile` (file names); `system.boundary` ('p p p');
 *   `system.lattice` ({style, constant, cells:[nx, ny, nz], element, mass}):
 *   constant in Å (reduced density for lj), mass in g/mol (null: from the
 *   element or the potential file).
 * - `temperature`, `pressure` (numbers, units above).
 * - `timestep` (time units, null: the preset's, which depends on rigid bonds).
 * - `constraints`: 'shake' | 'rattle' | 'none' (bonds to hydrogen and rigid water).
 * - `thermostat`: an id of {@link LMP_THERMOSTATS}; `tdamp` (time units,
 *   null: 100 time steps).
 * - `barostat`: an id of {@link LMP_BAROSTATS}; `pdamp` (time units, null:
 *   1000 time steps); `coupling`: an id of {@link LMP_COUPLINGS};
 *   `bulkModulus` (pressure units, Berendsen only; null: the preset's).
 * - `groups` ([{name, args, note}]): group commands written in this order in
 *   in.settings (`group <name> <args>`), with `note` as the line's note
 *   (groupsFromData's `why`). Restart files keep groups, and defining one
 *   again adds the same atoms, so every stage can define them.
 * - `restraint` ({group, k}): `group` one word naming a group of `groups`
 *   (or 'all'), or the arguments of a group command ('type 1:12',
 *   'molecule 1'), written as `group restrained ...`; '' for 'solute_heavy'
 *   when `groups` defines it, else the solute's heavy atoms from the data
 *   file; `k` the spring constant in energy/distance² (kcal/(mol·Å²) for
 *   real), null: 1000 kJ/(mol·nm²), GROMACS's default.
 * - `seed` (positive integer below 900,000,000): velocities and stochastic thermostats.
 * - `velocities`: 'create' (new ones at the temperature in the first
 *   dynamics stage) | 'keep' (those in the data or restart file).
 * - `dump` ({format, unwrap}): format an id of {@link LMP_DUMP_FORMATS};
 *   unwrap true for unwrapped coordinates, false for wrapped ones with image flags.
 * - `plumedStages`: 'prod' | 'all' (every dynamics stage), when the PLUMED
 *   tab gives an input.
 * - `stages.min`: {on, style (an id of {@link LMP_MIN_STYLES}), etol
 *   (unitless), ftol (force units), maxiter, maxeval, boxRelax (bool),
 *   restrain (bool), thermo (iterations between lines)}.
 * - `stages.nvt`, `stages.npt`, `stages.prod`: {on, length, lengthUnit
 *   ('fs' | 'ps' | 'ns' | 'tau' | 'steps'), restrain (bool), thermostat
 *   (null: the shared one), barostat (npt, prod; null: the shared one),
 *   ensemble (prod: 'NPT' | 'NVT' | 'NVE'), output: {unit (as lengthUnit),
 *   thermo, dump, restart} (intervals in `unit`, null: the default; dump 0
 *   for none)}.
 *
 * ## The workflow (buildLammpsWorkflow)
 *
 * `files` (each with `notes`: line number -> why), `stages` (key, label,
 * file, steps, time, ensemble, thermostat, barostat, coupling, restrain,
 * plumed, from, writes, output {thermo, dump, restart} in steps, bytes),
 * `issues` ({severity, message, stage?, url?}), `vars` (above), `needs`
 * (the files the user puts next to the inputs: data, potentials, CMAP),
 * `packages` (the LAMMPS packages the inputs use), `expectedWarnings`
 * ({text, why}: warnings LAMMPS will print for these inputs, such as the
 * wall-time stop), `plumed` (what the job script must know to continue
 * PLUMED), and the resolved `units`, `timestep`, `tdamp`, `pdamp`,
 * `temperature`, `pressure`, `natoms`.
 */

import { UNITS, LAMMPS_DOCS, LAMMPS_VERSION, commandInfo } from './lammps-reference.js';
import {
  LMP_FORCE_FIELDS, LMP_FORCE_FIELD, LMP_THERMOSTATS, LMP_BAROSTATS, LMP_COUPLINGS, LMP_DUMP_FORMATS,
  LMP_MIN_STYLES, LMP_FF_FIELDS, ELEMENT_MASSES, NO_RESTART_PAIR
} from './lammps-workflow-presets.js';

export {
  LMP_FORCE_FIELDS, LMP_FORCE_FIELD, LMP_THERMOSTATS, LMP_BAROSTATS, LMP_COUPLINGS, LMP_DUMP_FORMATS,
  LMP_MIN_STYLES, LMP_FF_FIELDS, ELEMENT_MASSES
};
export { lammpsRunBlock, shellValue } from './lammps-workflow-job.js';

const doc = (page) => `${LAMMPS_DOCS}${page}.html`;
const freeze = (v) => {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) freeze(x);
    Object.freeze(v);
  }
  return v;
};

/* ------------------------------------------------------------------ *
 * Stages
 * ------------------------------------------------------------------ */

/**
 * The stages, in the order they run. `prefix` names the stage's restart
 * files (`<prefix>.<step>`; minimisation writes the single `min.restart`),
 * `log` its log file.
 */
export const LMP_STAGES = freeze([
  { key: 'min', label: 'Energy minimisation', short: 'Min', file: 'in.min', dynamics: false, prefix: 'min.restart', log: 'min.log',
    what: 'Removes the worst contacts so dynamics can start: atoms move downhill in energy until the forces are small.' },
  { key: 'nvt', label: 'NVT equilibration', short: 'NVT', file: 'in.nvt', dynamics: true, prefix: 'nvt.restart', log: 'nvt.log',
    what: 'Brings the system to the temperature at fixed volume, with new velocities and the solute held near its start.' },
  { key: 'npt', label: 'NPT equilibration', short: 'NPT', file: 'in.npt', dynamics: true, prefix: 'npt.restart', log: 'npt.log',
    what: 'Lets the box relax to the pressure, so the density settles, still holding the solute near its start.' },
  { key: 'prod', label: 'Production', short: 'MD', file: 'in.prod', dynamics: true, prefix: 'restart', log: 'prod.log',
    what: 'The run you analyse: no restraints, output at the intervals you chose, continued across jobs from its newest restart file.' }
]);


/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const num = (v, fallback) => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const words = (s) => str(s).split(/\s+/).filter(Boolean);
const plural = (n, one, many = `${one}s`) => `${fmtCount(n)} ${n === 1 ? one : many}`;
const listText = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** A count with thousands separators: 50,000. */
export const fmtCount = (n) => Number(n).toLocaleString('en-GB');

/** A number as LAMMPS should read it: no trailing zeros, no exponent below 1e-4. */
export function fmtNum(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return String(x);
  if (n !== 0 && (Math.abs(n) < 1e-4 || Math.abs(n) >= 1e9)) return n.toExponential().replace(/\.?0+e/, 'e').replace('e+', 'e');
  return String(Number(n.toPrecision(10)));
}

/* A small tolerance as LAMMPS examples write it: 1.0e-4. */
const sci = (x) => {
  const n = Number(x);
  if (!Number.isFinite(n) || n === 0 || Math.abs(n) >= 1e-2) return fmtNum(n);
  const [m, e] = n.toExponential().split('e');
  const mm = /\./.test(m) ? m : `${m}.0`;
  return `${mm}e${Number(e)}`;
};

/* A float in an input: one decimal at least, so 300 reads as 300.0. */
const fl = (x) => {
  const t = fmtNum(x);
  return /[.e]/.test(t) ? t : `${t}.0`;
};

/* Ranges of integers in the form the group command takes: 1:4 7 9:10. */
function typeRanges(list) {
  const t = [...new Set(list.map(Number).filter(n => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < t.length;) {
    let j = i;
    while (j + 1 < t.length && t[j + 1] === t[j] + 1) j++;
    out.push(j - i >= 2 ? `${t[i]}:${t[j]}` : t.slice(i, j + 1).join(' '));
    i = j + 1;
  }
  return out.join(' ');
}

/* Types for people: 1-3, 5 and 7. */
const typeText = (list) => listText(typeRanges(list).split(' ').map(r => r.replace(':', '-')));

/* ------------------------------------------------------------------ *
 * Time
 * ------------------------------------------------------------------ */

const TIME_UNITS_PS = { fs: 0.001, ps: 1, ns: 1000, us: 1e6 };

/** The time unit of a units style, as the inputs write it: fs, ps or τ. */
export function timeUnit(units) {
  return (UNITS[units] || UNITS.real).time;
}

/**
 * A time for people: '500 fs', '100 ps', '1.5 ns', or in τ for lj.
 *
 * @param {number} t - In the time unit of `units`.
 * @param {string} units
 * @returns {string}
 */
export function formatTime(t, units) {
  const u = UNITS[units] || UNITS.real;
  if (!u.timeInPs) return `${fmtNum(Number(t.toPrecision(6)))} ${u.time}`;
  const ps = t * u.timeInPs;
  const pick = ps >= 1000 ? ['ns', 1000] : ps >= 1 ? ['ps', 1] : ['fs', 0.001];
  return `${fmtNum(Number((ps / pick[1]).toPrecision(6)))} ${pick[0]}`;
}

/**
 * A length or interval as steps of the time step.
 *
 * @param {number} value
 * @param {string} unit - 'fs', 'ps', 'ns', 'tau' (lj), 'steps', or the units' own time unit.
 * @param {number} dt - The time step in the time unit of `units`.
 * @param {string} units
 * @returns {{steps:number, exact:boolean, valid:boolean}} `valid` false when
 *   the unit has no meaning in these units (fs with lj); `exact` false when
 *   the time is not a whole number of steps (it is rounded).
 */
export function toSteps(value, unit, dt, units) {
  const v = Math.max(0, num(value, 0));
  const u = UNITS[units] || UNITS.real;
  const name = str(unit) || 'steps';
  if (name === 'steps') return { steps: Math.round(v), exact: Number.isInteger(v), valid: true };
  let t;
  if (name === 'tau' || name === u.time) t = v;
  else if (TIME_UNITS_PS[name] && u.timeInPs) t = (v * TIME_UNITS_PS[name]) / u.timeInPs;
  else return { steps: Math.round(v / dt), exact: false, valid: false };
  const raw = t / dt;
  const steps = Math.round(raw);
  return { steps, exact: Math.abs(raw - steps) < 1e-6 * Math.max(1, raw), valid: true };
}

/* Round an interval to a tidy number of steps: 1, 2 or 5 times a power of ten. */
function tidySteps(n) {
  if (!(n >= 1)) return 1;
  const p = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 5, 10]) if (m * p >= n * 0.999) return m * p;
  return n;
}

/* ------------------------------------------------------------------ *
 * The state
 * ------------------------------------------------------------------ */

/* Output intervals by default, in ps (τ for lj): thermo, dump, restart. */
const DEFAULT_OUTPUT = { nvt: [1, 10, 10], npt: [1, 10, 10], prod: [10, 10, 100] };

/**
 * The form's state with every default filled in, for a preset.
 *
 * @param {string} [forceField='charmm'] - An id of {@link LMP_FORCE_FIELDS}.
 * @returns {object} See the module documentation for every field.
 */
export function defaultLammpsState(forceField = 'charmm') {
  const ff = LMP_FORCE_FIELD[forceField] || LMP_FORCE_FIELD.charmm;
  const lj = ff.units === 'lj';
  const unit = (key) => ff.defaults.lengths[key];
  const out = () => ({ unit: lj ? 'tau' : 'ps', thermo: null, dump: null, restart: null });
  return {
    forceField: ff.id,
    ff: {},
    styles: { bond: '', angle: '', dihedral: '', improper: '' },
    waterTypes: { o: null, h: null, bond: null, angle: null },
    extraLines: '',
    system: {
      source: ff.source,
      dataFile: 'system.data',
      restartFile: 'system.restart',
      boundary: 'p p p',
      lattice: ff.lattice ? { ...ff.lattice, cells: [...ff.lattice.cells], mass: null } : { style: 'fcc', constant: 3.615, cells: [10, 10, 10], element: 'Cu', mass: null }
    },
    temperature: ff.defaults.temperature,
    pressure: ff.defaults.pressure,
    timestep: null,
    constraints: ff.constraints,
    thermostat: 'nose-hoover',
    tdamp: null,
    barostat: 'mtk',
    pdamp: null,
    coupling: 'iso',
    bulkModulus: null,
    groups: [],
    restraint: { group: '', k: null },
    seed: 4928459,
    velocities: 'create',
    dump: { format: 'custom', unwrap: true },
    plumedStages: 'prod',
    stages: {
      min: { on: true, style: 'cg', etol: 1e-4, ftol: 1e-6, maxiter: 5000, maxeval: 50000, boxRelax: false, restrain: false, thermo: 100 },
      nvt: { on: true, length: unit('nvt')[0], lengthUnit: unit('nvt')[1], restrain: ff.family === 'Biomolecular', thermostat: null, output: out() },
      npt: { on: true, length: unit('npt')[0], lengthUnit: unit('npt')[1], restrain: ff.family === 'Biomolecular', thermostat: null, barostat: null, output: out() },
      prod: { on: true, length: unit('prod')[0], lengthUnit: unit('prod')[1], restrain: false, ensemble: 'NPT', thermostat: null, barostat: null, output: out() }
    }
  };
}

/* The state with every field present: defaults under what the page saved. */
function completeState(state) {
  const s = state || {};
  const base = defaultLammpsState(s.forceField);
  const merged = { ...base, ...s };
  merged.ff = { ...(s.ff || {}) };
  merged.styles = { ...base.styles, ...(s.styles || {}) };
  merged.waterTypes = { ...base.waterTypes, ...(s.waterTypes || {}) };
  merged.system = { ...base.system, ...(s.system || {}) };
  merged.system.lattice = { ...base.system.lattice, ...((s.system || {}).lattice || {}) };
  merged.restraint = { ...base.restraint, ...(s.restraint || {}) };
  merged.groups = Array.isArray(s.groups) ? s.groups.filter(g => g && typeof g === 'object').map(g => ({ ...g })) : [];
  merged.dump = { ...base.dump, ...(s.dump || {}) };
  merged.stages = {};
  for (const key of Object.keys(base.stages)) {
    const given = (s.stages || {})[key] || {};
    merged.stages[key] = { ...base.stages[key], ...given };
    if (base.stages[key].output) merged.stages[key].output = { ...base.stages[key].output, ...(given.output || {}) };
  }
  return merged;
}

/* ------------------------------------------------------------------ *
 * What the data file says
 * ------------------------------------------------------------------ */

/*
 * The facts the builder reads from the summary of src/core/lammps-data.js
 * (summariseData), tolerant of fields it may not have.
 */
function dataFacts(data) {
  if (!data || typeof data !== 'object') return null;
  const asTypes = (v) => (Array.isArray(v) ? v.map(x => (x && typeof x === 'object' ? Number(x.type) : Number(x))).filter(n => Number.isInteger(n) && n > 0) : []);
  const types = Array.isArray(data.types) ? data.types : [];
  const charges = types.map(t => Number(t && t.charge)).filter(Number.isFinite);
  const hasCharges = data.hasCharges !== undefined && data.hasCharges !== null ? !!data.hasCharges
    : (charges.length ? charges.some(q => Math.abs(q) > 1e-8) : null);
  const w = data.water && typeof data.water === 'object' ? data.water : null;
  const hTypes = asTypes(data.hydrogenTypes);
  // Hydrogen masses for SHAKE's m keyword: LAMMPS matches within 0.1, so
  // masses closer than that need one entry.
  const shake = data.shake && typeof data.shake === 'object' ? data.shake : {};
  const rawMasses = Array.isArray(shake.m) && shake.m.length ? shake.m.map(Number)
    : types.filter(t => hTypes.includes(Number(t.type))).map(t => Number(t.mass));
  const hMasses = [];
  for (const m of rawMasses.filter(x => x > 0)) if (!hMasses.some(x => Math.abs(x - m) <= 0.1)) hMasses.push(m);
  const counts = data.counts || {};
  const topo = data.topology || {};
  const box = data.box || null;
  const angleTypes = Array.isArray(shake.a) ? shake.a.map(Number).filter(n => n > 0) : [];
  return {
    natoms: num(data.natoms, num(counts.atoms, 0)),
    types,
    hTypes,
    hMasses,
    soluteTypes: asTypes(data.soluteTypes),
    ionTypes: asTypes(data.ions),
    water: w ? {
      model: str(w.model), o: num(w.oType, null), h: num(w.hType, null),
      bond: num(w.bondType, null), angle: num(w.angleType, angleTypes[0] || null), count: num(w.count, 0),
      sites: num(w.sites, 3), m: num(w.mType, null)
    } : null,
    charge: Number.isFinite(Number(data.charge)) ? Number(data.charge) : null,
    hasCharges,
    crossterms: num(counts.crossterms, num(topo.crossterms, num(data.crossterms, 0))),
    bonds: num(topo.bonds, num(counts.bonds, num(data.bonds, null))),
    triclinic: box ? !!(box.triclinic || Number(box.xy) || Number(box.xz) || Number(box.yz)) : null,
    box,
    vacuum: data.vacuum || data.gap || null,
    density: Number.isFinite(Number(data.density)) ? Number(data.density) : null,
    coeffs: data.coeffs || {},
    styles: (data.coeffs && data.coeffs.styles && Object.keys(data.coeffs.styles).length ? data.coeffs.styles : null) || data.styles || null,
    atomStyle: str(data.atomStyle),
    velocities: data.velocities === true
  };
}

/* ------------------------------------------------------------------ *
 * Writing a file with notes
 * ------------------------------------------------------------------ */

/*
 * Lines of one input file, with the note of each line that holds a choice
 * (keyed by line number, from 1). Commands are written as LAMMPS examples
 * do: the command padded to 15 characters, then its arguments.
 */
function fileWriter(name, kind, stage) {
  const lines = [];
  const notes = {};
  // A section's header is written with its first line, so a section that
  // ends up empty leaves no header behind.
  let pending = '';
  const flush = () => {
    if (!pending) return;
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.push(`# ---- ${pending} ----`);
    pending = '';
  };
  const w = {
    name, kind, stage,
    comment(text = '') { flush(); lines.push(text ? `# ${text}` : '#'); return w; },
    blank() { pending = ''; if (lines.length && lines[lines.length - 1] !== '') lines.push(''); return w; },
    cmd(command, args = '', note = '') {
      flush();
      const a = str(args);
      lines.push(a ? `${command.padEnd(15)} ${a}` : command);
      if (note) notes[lines.length] = note;
      return w;
    },
    raw(text, note = '') {
      flush();
      const parts = String(text).split('\n');
      lines.push(parts[0]);
      if (note) notes[lines.length] = note;
      for (const p of parts.slice(1)) lines.push(p);
      return w;
    },
    section(title) { pending = title; return w; },
    file() {
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
      const f = { name, kind, text: `${lines.join('\n')}\n`, notes: { ...notes } };
      if (stage) f.stage = stage;
      return f;
    }
  };
  return w;
}

/* ------------------------------------------------------------------ *
 * The force field
 * ------------------------------------------------------------------ */

/* Commands the 'custom' lines may hold that must come before the box exists. */
const BEFORE_BOX = new Set(['units', 'atom_style', 'boundary', 'dimension', 'newton', 'atom_modify', 'bond_style',
  'angle_style', 'dihedral_style', 'improper_style', 'pair_style', 'special_bonds', 'processors', 'comm_modify']);

/* The user's own lines, split into what goes before read_data and the rest. */
function splitCustom(text) {
  const before = [];
  const after = [];
  let units = '';
  let atomStyle = '';
  let pairStyle = '';
  // Join continuation lines (& at the end) so a command stays in one piece.
  const raw = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const joined = [];
  let acc = '';
  for (const line of raw) {
    const t = line.replace(/\s+$/, '');
    if (/&$/.test(t)) { acc += `${t}\n`; continue; }
    joined.push(acc + t);
    acc = '';
  }
  if (acc) joined.push(acc.replace(/\n$/, ''));
  for (const line of joined) {
    const code = line.replace(/#.*$/s, '').trim();
    if (!code) continue;
    const cmd = code.split(/\s+/)[0];
    if (cmd === 'units') { units = code.split(/\s+/)[1] || ''; continue; }
    if (cmd === 'atom_style') { atomStyle = code.split(/\s+/).slice(1).join(' '); continue; }
    if (cmd === 'pair_style') pairStyle = code.split(/\s+/)[1] || '';
    if (BEFORE_BOX.has(cmd)) before.push(line);
    else after.push(line);
  }
  return { before, after, units, atomStyle, pairStyle };
}

/* ------------------------------------------------------------------ *
 * Building the workflow
 * ------------------------------------------------------------------ */

/**
 * Turn the form's state into the files of a LAMMPS run.
 *
 * @param {object} state - As {@link defaultLammpsState} returns it, edited.
 * @param {object} [opts]
 * @param {object|null} [opts.data] - The summary of the loaded data file
 *   (src/core/lammps-data.js summariseData): types with masses and charges,
 *   water, hydrogen and solute types, net charge, box.
 * @param {{files:Array<{name:string, text:string}>}|null} [opts.plumed] - The
 *   PLUMED tab's input; the first file is plumed.dat.
 * @returns {{units:string, timestep:number, timeUnit:string, forceField:object,
 *   files:Array<{name:string, kind:'lammps'|'md'|'plumed', text:string, stage?:string, notes:Object<number,string>}>,
 *   stages:object[], issues:Array<{severity:'error'|'warning'|'note', message:string, stage?:string, url?:string}>,
 *   vars:object, needs:string[], packages:string[], plumed:object|null, natoms:number}}
 */
export function buildLammpsWorkflow(state, { data = null, plumed = null } = {}) {
  const s = completeState(state);
  const ff = LMP_FORCE_FIELD[s.forceField] || LMP_FORCE_FIELD.charmm;
  const o = { ...ff.options, ...s.ff };
  const issues = [];
  const issue = (severity, message, extra = {}) => issues.push({ severity, message, ...extra });
  // LAMMPS warnings these inputs are expected to print, and why.
  const expectedWarnings = [
    { text: 'Wall time limit reached', why: 'TIME_LIMIT ran out: the stage stopped cleanly and continues in the next job (timer timeout).' },
    { text: 'Restart file used different # of processors', why: 'The restart file was written on a different number of MPI ranks (your own restart file, or a job submitted again on other ranks). LAMMPS reads it all the same; the run is then not bit-for-bit what the old one would have done, and a CSVR thermostat starts a new random sequence.' }
  ];
  const expect = (text, why) => { if (!expectedWarnings.some(w => w.text === text)) expectedWarnings.push({ text, why }); };
  const D = dataFacts(data);
  const custom = ff.id === 'custom' ? splitCustom(o.lines) : null;
  // A pair style that writes no restart data is given again by every stage,
  // so its pair_style line goes to in.settings with the coefficients.
  if (custom && NO_RESTART_PAIR.test(custom.pairStyle)) {
    const i = custom.before.findIndex(l => /^\s*pair_style\b/.test(l));
    if (i >= 0) custom.after.unshift(...custom.before.splice(i, 1));
  }

  // Units and atom style: the preset's, or what the user's own lines say.
  let units = ff.units;
  let atomStyle = ff.atomStyle;
  if (custom) {
    units = custom.units || str(o.units) || 'real';
    atomStyle = custom.atomStyle || str(o.atomStyle) || 'full';
    if (!UNITS[units]) {
      issue('error', `Units "${units}" are not a LAMMPS unit style.`, { url: doc('units') });
      units = 'real';
    }
    if (!str(o.lines)) issue('warning', 'Your force-field lines are empty: paste the pair, bond and kspace lines your system needs.');
  }
  const U = UNITS[units];
  const tu = U.time;
  const lj = units === 'lj';
  const source = ['data', 'lattice', 'restart'].includes(s.system.source) ? s.system.source : ff.source;
  const molecular = !['atomic', 'charge'].includes(atomStyle.split(/\s+/)[0]) && (D ? D.bonds !== 0 : true);
  const charged = ['full', 'charge'].includes(atomStyle.split(/\s+/)[0]) || /\bcharge\b|\bq\b/.test(atomStyle);

  // Rigid bonds.
  let constraints = ['shake', 'rattle', 'none'].includes(s.constraints) ? s.constraints : ff.constraints;
  if (constraints !== 'none' && !molecular) {
    if (s.constraints !== ff.constraints) issue('note', `SHAKE and RATTLE need bonds; atom style ${atomStyle} has none, so the bonds are not constrained.`);
    constraints = 'none';
  }
  const rigid = constraints !== 'none';

  // Time step.
  const dtDefault = rigid ? ff.dt.constrained : ff.dt.flexible;
  const dt = num(s.timestep, 0) > 0 ? num(s.timestep, 0) : dtDefault;
  const dtPs = U.timeInPs ? dt * U.timeInPs : null;
  if (lj && dt > 0.02) {
    issue('error', `A time step of ${fmtNum(dt)} τ is ${fmtNum(Math.round(dt / 0.005))} times LAMMPS's 0.005 τ for lj units: it looks like a time in fs. ` +
      'Reduced units need about 0.005 τ; atoms would fly apart at once.', { url: doc('units') });
  }
  if (!lj && molecular && ff.family !== 'Reactive' && dtPs !== null) {
    const fs = dtPs * 1000;
    if (!rigid && fs > 1.0 + 1e-9) {
      issue('warning', `${fmtNum(fs)} fs with flexible bonds to hydrogen: they vibrate with a period of about 10 fs, and a step longer than 1 fs makes the run unstable. Constrain them (SHAKE) or use 1 fs.`, { url: doc('fix_shake') });
    } else if (rigid && fs > 2.0 + 1e-9) {
      issue('warning', `${fmtNum(fs)} fs is longer than the 2 fs that rigid bonds to hydrogen allow; without hydrogen mass repartitioning the run will drift or fail.`, { url: doc('fix_shake') });
    }
  }
  if (ff.family === 'Reactive' && dtPs !== null && dtPs * 1000 > 0.5 + 1e-9) {
    issue('warning', `${fmtNum(dtPs * 1000)} fs is long for ReaxFF: bonds form and break with hydrogen moving fast; 0.1 to 0.5 fs is usual (0.25 fs here by default).`, { url: doc('pair_reaxff') });
  }
  if (units === 'metal' && dtPs !== null && dtPs > 0.005 + 1e-12) {
    issue('warning', `${fmtNum(dtPs * 1000)} fs is long for atoms in a crystal: 1 to 2 fs (0.001 to 0.002 ps) is usual for metals, less at high temperature or with light atoms.`, { url: doc('timestep') });
  }

  const T = num(s.temperature, ff.defaults.temperature);
  const P = num(s.pressure, ff.defaults.pressure);
  if (!(T > 0)) issue('error', `The temperature must be above 0 ${U.temperature}; Nosé-Hoover and velocity create cannot use ${fmtNum(T)}.`);
  const tdamp = num(s.tdamp, 0) > 0 ? num(s.tdamp, 0) : Number((100 * dt).toPrecision(6));
  const pdamp = num(s.pdamp, 0) > 0 ? num(s.pdamp, 0) : Number((1000 * dt).toPrecision(6));
  const coupling = LMP_COUPLINGS.some(c => c.id === s.coupling) ? s.coupling : 'iso';
  const seed = Math.max(1, Math.min(899999999, Math.round(num(s.seed, 4928459))));
  if (num(s.seed, 4928459) !== seed) issue('note', `The random seed must be a whole number from 1 to 900,000,000 (LAMMPS's random number generator); ${seed} is used.`);

  // Water: types for the water presets and for rigid water under SHAKE.
  const waterModel = ff.water || null;
  const wt = {
    o: num(s.waterTypes.o, D && D.water ? D.water.o : null),
    h: num(s.waterTypes.h, D && D.water ? D.water.h : null),
    bond: num(s.waterTypes.bond, D && D.water ? D.water.bond : null),
    angle: num(s.waterTypes.angle, D && D.water ? D.water.angle : null)
  };
  const waterGiven = wt.o !== null && wt.h !== null;
  if (waterModel && !waterGiven) {
    issue('warning', `The ${waterModel.model} lines need water's atom types: load the data file, or give them under Force field. Types 1 (O) and 2 (H), bond type 1 and angle type 1 are assumed.`);
  }
  const W = waterModel ? { o: wt.o || 1, h: wt.h || 2, bond: wt.bond || 1, angle: wt.angle || 1 } : wt;

  /* ---- Groups ---- */
  const groups = [];
  const groupNotes = {};
  for (const g of s.groups) {
    const name = str(g.name);
    const args = str(g.args);
    if (!name || !args) continue;
    if (!/^[A-Za-z0-9_]+$/.test(name) || name === 'all') {
      issue('error', `"${name}" cannot be a group name: LAMMPS takes letters, digits and underscores, and "all" exists already.`, { url: doc('group') });
      continue;
    }
    if (groups.some(([n]) => n === name)) continue;
    groups.push([name, args]);
    groupNotes[name] = str(g.note) || `The group ${name}, as you defined it.`;
  }
  let restrainGroup = '';
  const restrainedStages = ['min', 'nvt', 'npt', 'prod'].filter(k => s.stages[k].on && s.stages[k].restrain);
  if (restrainedStages.length) {
    const given = str(s.restraint.group);
    const groupWords = /^(type|id|molecule|region|subtract|union|intersect|dynamic|static|clear|delete|include|variable|empty)$/;
    if (given && /^[A-Za-z0-9_]+$/.test(given) && !groupWords.test(given)) {
      // One word: the name of a group, defined above or "all".
      if (given === 'all' || groups.some(([n]) => n === given)) restrainGroup = given;
      else issue('warning', `The restraints name the group "${given}", which is not among the groups defined: no atoms are restrained. Define it under Groups, or give group-command arguments (e.g. "type 1:12").`, { url: doc('group') });
    } else if (given) {
      groups.push(['restrained', given]);
      groupNotes.restrained = `The atoms the restraints hold, as you gave them (${given}).`;
      restrainGroup = 'restrained';
    } else if (groups.some(([n]) => n === 'solute_heavy')) {
      restrainGroup = 'solute_heavy';
    } else if (D && D.soluteTypes.length) {
      const heavy = D.soluteTypes.filter(t => !D.hTypes.includes(t));
      if (heavy.length) {
        groups.push(['restrained', `type ${typeRanges(heavy)}`]);
        groupNotes.restrained = `The solute's heavy atoms: the data file's types other than water and ions (${typeRanges(D.soluteTypes)}), less its hydrogen types${D.hTypes.length ? ` (${typeRanges(D.hTypes.filter(t => D.soluteTypes.includes(t))) || 'none'})` : ''}. GROMACS restrains the same atoms (posre.itp).`;
        restrainGroup = 'restrained';
      }
    }
    if (!restrainGroup && !given) {
      issue('warning', D ? 'Restraints are on, but the data file has no solute (only water and ions): no atoms are restrained. Switch them off, or name a group under Restraints.'
        : 'Restraints are on, but no group is given and no data file is loaded to find the solute: no atoms are restrained. Load the data file, or give the group (e.g. "type 1:12" or "molecule 1").',
      { url: doc('group') });
    }
  }
  // LAMMPS allows 32 groups, "all" among them (group.cpp, MAX_GROUP).
  if (groups.length + 1 > 32) {
    issue('error', `${groups.length + 1} groups with "all": LAMMPS allows 32 at most and stops ("Too many groups"). Define fewer.`, { url: doc('group') });
  }

  /* ---- SHAKE / RATTLE arguments ---- */
  let shakeArgs = '';
  let shakeWhat = '';
  if (rigid) {
    const parts = [];
    const what = [];
    if (waterModel) {
      parts.push(`b ${W.bond}`, `a ${W.angle}`);
      what.push(`water's O-H bonds (bond type ${W.bond}) and H-O-H angle (angle type ${W.angle}), so the ${waterModel.model} molecule is rigid as the model is defined`);
    } else {
      const masses = D && D.hMasses.length ? D.hMasses : [1.008];
      const m = [...new Set(masses.map(x => fmtNum(Number(x.toFixed(3)))))];
      parts.push(`m ${m.join(' ')}`);
      what.push(`every bond to an atom of mass ${listText(m)} (hydrogen; LAMMPS matches masses within 0.1)`);
      const wa = wt.angle;
      if (wa) {
        parts.push(`a ${wa}`);
        what.push(`water's H-O-H angle (angle type ${wa}${D && D.water && D.water.model ? `, ${D.water.model}` : ''}), so water is fully rigid as TIP3P is defined`);
      } else if (D && D.water && D.water.count) {
        issue('note', 'The data file has water, but its angle type is unknown, so SHAKE holds the O-H bonds only and the H-O-H angle stays flexible. Give the angle type under Force field to make water rigid.');
      }
    }
    shakeArgs = parts.join(' ');
    shakeWhat = listText(what);
  }

  /* ---- Stages ---- */
  const on = LMP_STAGES.filter(d => s.stages[d.key] && s.stages[d.key].on);
  if (!on.length) issue('error', 'No stage is switched on.');
  const thermo = (id) => LMP_THERMOSTATS.find(t => t.id === id) || LMP_THERMOSTATS[0];
  const baro = (id) => LMP_BAROSTATS.find(b => b.id === id) || LMP_BAROSTATS[0];
  const dumpFormat = LMP_DUMP_FORMATS.find(f => f.id === s.dump.format) || LMP_DUMP_FORMATS[0];
  const firstDyn = on.find(d => d.dynamics);
  const plumedOn = !!(plumed && Array.isArray(plumed.files) && plumed.files.length && str(plumed.files[0].text));
  const plumedName = plumedOn ? (str(plumed.files[0].name) || 'plumed.dat') : 'plumed.dat';
  const plumedKeys = plumedOn ? on.filter(d => d.dynamics && (s.plumedStages === 'all' || d.key === 'prod')).map(d => d.key) : [];
  if (plumedOn && !plumedKeys.length) issue('warning', 'PLUMED has an input, but no stage it runs in is switched on (production by default).');

  const plans = [];
  let prev = null;
  for (const d of on) {
    const st = s.stages[d.key];
    const plan = { key: d.key, label: d.label, short: d.short, file: d.file, dynamics: d.dynamics, prefix: d.prefix, log: d.log, what: d.what };
    plan.restrain = !!st.restrain && !!restrainGroup;
    plan.from = prev ? (prev.dynamics ? `${prev.prefix}.${prev.steps}` : 'min.restart')
      : source === 'data' ? str(s.system.dataFile) || 'system.data'
        : source === 'restart' ? str(s.system.restartFile) || 'system.restart' : '';
    plan.first = !prev;
    if (d.dynamics) {
      const len = toSteps(st.length, st.lengthUnit, dt, units);
      if (!len.valid) issue('error', `${d.label}: a length in ${st.lengthUnit} has no meaning in ${units} units; give it in ${lj ? 'τ' : 'fs, ps or ns'} or in steps.`, { stage: d.key });
      if (!len.exact && len.valid) issue('note', `${d.label}: ${fmtNum(st.length)} ${st.lengthUnit} is not a whole number of ${fmtNum(dt)} ${tu} steps; it is rounded to ${fmtCount(len.steps)} steps.`, { stage: d.key });
      plan.steps = len.steps;
      if (!plan.steps) issue('error', `${d.label} has no steps.`, { stage: d.key });
      plan.time = formatTime(plan.steps * dt, units);
      plan.ensemble = d.key === 'nvt' ? 'NVT' : d.key === 'npt' ? 'NPT' : (['NPT', 'NVT', 'NVE'].includes(st.ensemble) ? st.ensemble : 'NPT');
      plan.thermostat = plan.ensemble === 'NVE' ? null : thermo(st.thermostat || s.thermostat).id;
      plan.barostat = plan.ensemble === 'NPT' ? baro(st.barostat || s.barostat).id : null;
      plan.coupling = plan.ensemble === 'NPT' ? coupling : null;
      if (plan.barostat === 'berendsen' && coupling === 'tri') {
        issue('warning', `${d.label}: the Berendsen barostat cannot change the tilt of the box (fix press/berendsen has no tri), so it couples x, y and z apart (aniso). Use the MTK barostat for a fully flexible cell.`, { stage: d.key, url: doc('fix_press_berendsen') });
        plan.coupling = 'aniso';
      }
      // Output intervals.
      const outSt = st.output || {};
      const dflt = DEFAULT_OUTPUT[d.key];
      const unitPs = lj ? 1 : U.timeInPs;
      const auto = (i) => Math.max(1, Math.min(plan.steps || 1, tidySteps((dflt[i] / unitPs) / dt)));
      const pick = (field, i) => {
        if (outSt[field] === null || outSt[field] === undefined || outSt[field] === '') return auto(i);
        const r = toSteps(outSt[field], outSt.unit || (lj ? 'tau' : 'ps'), dt, units);
        if (!r.valid) issue('error', `${d.label}: an output interval in ${outSt.unit} has no meaning in ${units} units.`, { stage: d.key });
        return r.steps;
      };
      plan.output = { thermo: Math.max(1, pick('thermo', 0)), dump: dumpFormat.style ? pick('dump', 1) : 0, restart: Math.max(1, pick('restart', 2)) };
      if (plan.output.restart > plan.steps && plan.steps) plan.output.restart = plan.steps;
      plan.velocities = firstDyn && firstDyn.key === d.key && s.velocities !== 'keep' ? 'create' : (firstDyn && firstDyn.key === d.key ? 'keep' : 'previous');
      plan.plumed = plumedKeys.includes(d.key);
      plan.restarts = `${d.prefix}.<step>`;
      plan.writes = [`${d.prefix}.${plan.steps}`, d.log, ...(plan.output.dump ? [trajName(d.key, dumpFormat)] : [])];
    } else {
      plan.steps = Math.max(0, Math.round(num(st.maxiter, 5000)));
      plan.time = 'minimise';
      plan.ensemble = 'min';
      plan.output = { thermo: Math.max(1, Math.round(num(st.thermo, 100))), dump: 0, restart: 0 };
      plan.writes = ['min.restart', 'min.log'];
    }
    plan.output.unitSteps = true;
    plans.push(plan);
    prev = plan;
  }
  for (const p of plans) {
    if (p.ensemble === 'NPT' && p.barostat === 'berendsen' && p.key === 'prod') {
      issue('warning', 'Production uses the Berendsen barostat: it scales the box towards the pressure but gives the wrong volume fluctuations, so densities are right and compressibilities and fluctuation properties are not. Use MTK for production.', { stage: 'prod', url: doc('fix_press_berendsen') });
    }
    if (p.thermostat === 'berendsen' && p.key === 'prod') {
      issue('warning', 'Production uses the Berendsen thermostat: it suppresses the kinetic-energy fluctuations, so the run does not sample the canonical ensemble. Use Nosé-Hoover or CSVR for production.', { stage: 'prod', url: doc('fix_temp_berendsen') });
    }
    if (p.thermostat === 'langevin' && p.key === 'prod') {
      issue('note', `Production uses a Langevin thermostat with damp ${fmtNum(tdamp)} ${tu}: its friction (1/damp) slows diffusion and other dynamics. For dynamical properties use CSVR or Nosé-Hoover, or a damp ten times longer (${fmtNum(10 * tdamp)} ${tu}) or more.`, { stage: 'prod', url: doc('fix_langevin') });
    }
    if (p.key === 'prod' && p.restrain) issue('note', 'Production keeps the position restraints: they are usually released for production.', { stage: 'prod' });
    if (p.ensemble === 'NVE') issue('note', 'Production is NVE: no thermostat, so watch the total energy (etotal) for drift; a drift means the time step or the cut-offs are too coarse.', { stage: 'prod' });
  }
  const tSteps = tdamp / dt;
  const pSteps = pdamp / dt;
  if (tSteps < 10 && plans.some(p => p.thermostat)) {
    issue('warning', `Tdamp ${fmtNum(tdamp)} ${tu} is ${fmtNum(Number(tSteps.toPrecision(3)))} time steps: the temperature will swing wildly. LAMMPS suggests about 100 steps (fix_nh).`, { url: doc('fix_nh') });
  }
  if (pSteps < 100 && plans.some(p => p.barostat)) {
    issue('warning', `Pdamp ${fmtNum(pdamp)} ${tu} is ${fmtNum(Number(pSteps.toPrecision(3)))} time steps: the box will oscillate wildly. LAMMPS suggests about 1000 steps (fix_nh).`, { url: doc('fix_nh') });
  }
  if (plans.some(p => p.coupling === 'tri') && (source === 'lattice' || (D && D.triclinic === false))) {
    issue('error', 'Fully flexible (tri) coupling needs a triclinic box, and this one is orthogonal: LAMMPS stops ("Cannot use fix npt with tilt factors on an orthogonal box" or similar). Make the box triclinic (change_box all triclinic in in.settings) or couple anisotropically.', { url: doc('fix_nh') });
  }
  // A vacuum gap and a barostat: the gap collapses.
  const npt = plans.filter(p => p.ensemble === 'NPT');
  if (npt.length && D && D.vacuum) {
    const gap = typeof D.vacuum === 'object' ? D.vacuum : { axis: '', size: D.vacuum };
    issue('warning', `The data file leaves a vacuum gap${gap.axis ? ` along ${gap.axis}` : ''}${gap.size ? ` (${fmtNum(Number(Number(gap.size).toPrecision(3)))} Å)` : ''}: a barostat squeezes it shut, which is not the pressure you want. Couple only the directions the material fills (membrane coupling for a slab normal to z), or run NVT.`, { url: doc('fix_nh') });
  } else if (npt.length && D && D.density !== null && units === 'real' && ff.family !== 'Reactive' && D.density < 0.5) {
    issue('warning', `The data file's density is ${fmtNum(Number(D.density.toPrecision(3)))} g/cm³, far below a liquid or solid: if the box has a vacuum gap or the molecules are spread thin, a barostat will collapse it. Check the box before running NPT.`);
  }

  // A strongly tilted cell (domain.cpp: |xy|/ly or (|xz| + |yz|)/lz above 0.5).
  if (D && D.box && D.triclinic) {
    const b = D.box;
    const ly = num(b.ly, num(b.yhi, 0) - num(b.ylo, 0));
    const lz = num(b.lz, num(b.zhi, 0) - num(b.zlo, 0));
    const sxy = ly > 0 ? Math.abs(num(b.xy, 0)) / ly : 0;
    const sz = lz > 0 ? (Math.abs(num(b.xz, 0)) + Math.abs(num(b.yz, 0))) / lz : 0;
    if (sxy > 0.5 || sz > 0.5) {
      issue('note', `The data file's cell is strongly tilted (tilt over box length ${fmtNum(Number(Math.max(sxy, sz).toFixed(2)))}, above 0.5), so LAMMPS warns that it will run inefficiently. It runs correctly; a less skewed choice of cell vectors for the same crystal would be faster.`, { url: doc('Howto_triclinic') });
      expect('Triclinic box skew is large', 'The data file\'s cell is strongly tilted; LAMMPS runs it correctly, a little less efficiently.');
    }
  }

  if (firstDyn && s.velocities === 'keep' && source === 'lattice') {
    issue('warning', 'Velocities are kept, but a crystal built in the input has none: the atoms start at 0 K and only the thermostat warms them. Choose new velocities for the first dynamics stage.', { stage: firstDyn.key, url: doc('velocity') });
  } else if (firstDyn && s.velocities !== 'keep' && D && D.velocities) {
    issue('note', `The data file has velocities; ${firstDyn.label} replaces them with new ones at ${fmtNum(T)} ${U.temperature}. Keep them instead under Velocities if they come from an equilibrated run.`, { stage: firstDyn.key, url: doc('velocity') });
  }

  // Boundaries: a barostat and PPPM need periodic directions.
  const bounds = words(s.system.boundary || 'p p p');
  const open = ['x', 'y', 'z'].filter((_, i) => bounds[i] && !/^p/.test(bounds[i]));
  if (source !== 'restart' && open.length) {
    const scaled = (p) => (p.coupling === 'membrane' || p.coupling === 'iso' || p.coupling === 'aniso' || p.coupling === 'tri' ? ['x', 'y', 'z'] : []);
    if (plans.some(p => p.ensemble === 'NPT' && scaled(p).some(d => open.includes(d)))) {
      issue('error', `The box is not periodic along ${listText(open)}, and a barostat can only change periodic directions: LAMMPS stops ("Cannot use fix npt on a non-periodic ${open[0]} dimension"). Run NVT, or make the box periodic.`, { url: doc('fix_nh') });
    }
    const kspaceLines = String(s.extraLines || '') + (custom ? custom.after.join('\n') : '');
    if (ff.kspace && !/kspace_modify[^\n]*slab/.test(kspaceLines)) {
      issue('error', `PPPM needs a periodic box, and this one is not periodic along ${listText(open)}: LAMMPS stops ("Cannot use non-periodic boundaries with PPPM"). For a slab periodic in x and y, use boundary p p f and add "kspace_modify slab 3.0" under Extra lines.`, { url: doc('kspace_modify') });
    }
  }

  /* ---- Charges ---- */
  const kspace = ff.kspace ? { style: ff.kspace.style, accuracy: num(o.kspaceAccuracy, ff.kspace.accuracy) } : null;
  if (kspace && D) {
    if (D.hasCharges === false && !waterModel) {
      issue('warning', `The data file has no charges, so ${kspace.style} has nothing to compute: LAMMPS warns "Using kspace solver on system with no charge". Use a pair style without /coul/long, or check that the Atoms section carries charges.`, { url: doc('kspace_style') });
      expect('Using kspace solver on system with no charge', 'The data file has no charges (see the issues).');
    }
    if (D.charge !== null && Math.abs(D.charge) > 1e-3 && !waterModel) {
      issue('warning', `The system's net charge is ${fmtNum(Number(D.charge.toFixed(4)))} e. PPPM then adds a uniform background charge to make it neutral, and LAMMPS warns "System is not charge neutral". Add counter-ions unless the charge is intended${Math.abs(D.charge) < 0.05 ? '; a charge this small is usually rounding in the data file\'s charges, and harmless' : ''}.`, { url: doc('kspace_style') });
      expect('System is not charge neutral', `The data file's charges add up to ${fmtNum(Number(D.charge.toFixed(4)))} e; PPPM neutralises them with a uniform background.`);
    }
  }
  if (D && D.crossterms > 0 && ff.id.startsWith('charmm') && !str(o.cmapFile)) {
    issue('error', `The data file lists ${plural(D.crossterms, 'CMAP cross-term')}, and read_data stops on them unless fix cmap reads a CMAP file first. Name the file (charmm36.cmap from lammps/potentials for CHARMM36) under Force field.`, { url: doc('fix_cmap') });
  }
  if (D && D.crossterms > 0 && !ff.id.startsWith('charmm')) {
    issue('error', `The data file lists ${plural(D.crossterms, 'CMAP cross-term')}: those belong to CHARMM; choose a CHARMM preset (with its CMAP file).`, { url: doc('fix_cmap') });
  }
  const cmapFile = ff.id.startsWith('charmm') ? str(o.cmapFile) : '';

  /* ---- Coefficients the data file lacks ---- */
  if (D && !custom && D.coeffs && ff.source === 'data' && ff.pair.restart) {
    const extra = String(s.extraLines || '');
    const given = (cmd) => new RegExp(`^\\s*${cmd}\\b`, 'm').test(extra);
    const topo = (data && data.topology) || {};
    if (D.coeffs.pair === false && !given('pair_coeff')) {
      const covered = waterModel ? [W.o, W.h] : [];
      const missing = D.types.map(t => Number(t.type)).filter(t => t > 0 && !covered.includes(t));
      if (missing.length) {
        issue('error', `The data file has no Pair Coeffs section, and no pair_coeff lines give atom type${missing.length === 1 ? '' : 's'} ${typeText(missing)} their Lennard-Jones parameters: LAMMPS stops ("All pair coeffs are not set"). Add the pair_coeff lines under Extra lines.`, { url: doc('pair_coeff') });
      }
    }
    for (const k of ['bond', 'angle', 'dihedral', 'improper']) {
      const ntypes = num(topo[`${k}Types`], 0);
      if (!ntypes || D.coeffs[k] !== false || given(`${k}_coeff`)) continue;
      const covered = waterModel ? (k === 'bond' ? [W.bond] : k === 'angle' ? [W.angle] : []) : [];
      const missing = Array.from({ length: ntypes }, (_, i) => i + 1).filter(t => !covered.includes(t));
      if (missing.length) {
        issue('error', `The data file has no ${k[0].toUpperCase()}${k.slice(1)} Coeffs section, and no ${k}_coeff lines give ${k} type${missing.length === 1 ? '' : 's'} ${typeText(missing)} their parameters: LAMMPS stops ("${k[0].toUpperCase()}${k.slice(1)} coeffs are not set"). Add the ${k}_coeff lines under Extra lines.`, { url: doc(`${k}_coeff`) });
      }
    }
  }

  /* ---- Styles ---- */
  const styles = ff.styles ? { ...ff.styles } : null;
  if (styles) {
    for (const k of Object.keys(styles)) {
      const given = str(s.styles[k]);
      if (given) styles[k] = given;
      else if (D && D.styles && str(D.styles[k]) && styles[k] && str(D.styles[k]) !== styles[k]) {
        issue('warning', `The data file was written for ${k}_style ${str(D.styles[k])}, and the preset uses ${styles[k]}: read_data reads the coefficients by the style given, so they would be wrong or rejected. Set the ${k} style to ${str(D.styles[k])} under Force field.`);
      }
    }
  }

  /* ---- Pair style ---- */
  const pair = pairSetup(ff, o, { W, custom });
  for (const i of pair.issues) issue(i.severity, i.message, i.url ? { url: i.url } : {});

  const ctx = {
    s, ff, o, units, U, tu, lj, atomStyle, source, molecular, charged, D, dt, dtPs, T, P, tdamp, pdamp, seed,
    constraints, rigid, shakeArgs, shakeWhat, waterModel, W, groups, groupNotes, restrainGroup, kspace, cmapFile, styles,
    pair, custom, dumpFormat, plumedName, plans, issue
  };

  const files = [];
  files.push(systemFile(ctx));
  files.push(settingsFile(ctx));
  for (const p of plans) files.push(p.dynamics ? dynamicsFile(p, ctx) : minFile(p, ctx));

  // PLUMED.
  let plumedInfo = null;
  if (plumedOn) {
    for (const f of plumed.files) {
      if (!str(f.name)) continue;
      files.push({ name: f.name, kind: 'plumed', text: String(f.text || ''), notes: {} });
    }
    plumedInfo = plumedFacts(plumed.files[0].text, { dt, units, name: plumedName });
    plumedInfo.stages = plumedKeys;
    for (const m of plumedInfo.warnings) issue('warning', m, { url: 'https://www.plumed.org/doc-v2.9/user-doc/html/_r_e_s_t_a_r_t.html' });
  }

  // What the user adds to the run directory.
  const needs = [];
  if (source === 'data') needs.push(str(s.system.dataFile) || 'system.data');
  if (source === 'restart') needs.push(str(s.system.restartFile) || 'system.restart');
  for (const f of pair.files) if (!needs.includes(f)) needs.push(f);
  if (cmapFile) needs.push(cmapFile);

  // Packages the inputs use, from the reference tables.
  const packages = packageList(files.filter(f => f.kind === 'lammps'));

  const natoms = D ? D.natoms : latticeAtoms(s.system.lattice, source);
  for (const p of plans) {
    const e = estimateLammpsOutput(p, natoms, { format: dumpFormat.id, molecular, charged });
    p.bytes = e.total;
    p.size = e;
  }

  // Variables the stage files take, for a checker to follow them.
  const vars = {};
  for (const p of plans) {
    if (!p.dynamics) { vars[p.key] = { first: {}, continue: null }; continue; }
    const first = { rstep: '-1', time_limit: 'off' };
    const cont = { rstep: String(Math.min(p.output.restart, p.steps)), time_limit: '3600' };
    if (p.plumed) { first.plumed_in = plumedName; cont.plumed_in = 'plumed.restart.dat'; }
    vars[p.key] = { first, continue: cont };
  }

  if (on.some(d => d.key === 'min') && s.stages.min.boxRelax) {
    expect('extra global DOFs will be included in minimizer energies', 'fix box/relax adds the box dimensions to what the minimiser moves, and their pV energy to the energy it minimises; LAMMPS says so at the start.');
  }
  if (rigid && on.some(d => d.key === 'min') && ff.styles && ff.styles.bond === 'zero') {
    expect('with minimization', 'SHAKE in minimisation is replaced by stiff restraints (fix_shake).');
  }

  const workflow = {
    version: LAMMPS_VERSION,
    units, timeUnit: tu, timestep: dt, timestepDefault: dtDefault, temperature: T, pressure: P, tdamp, pdamp,
    forceField: ff, options: o, atomStyle, source, constraints, coupling, seed,
    files, stages: plans, issues, vars, needs, packages, plumed: plumedInfo, natoms,
    dump: dumpFormat, expectedWarnings, settingsWhat: ctx.settingsWhat
  };
  files.push({ name: 'README.md', kind: 'md', text: lammpsReadme(workflow), notes: {} });
  return workflow;
}

/* The trajectory file of a stage. */
function trajName(key, fmt) {
  return fmt.style ? `${key}.${fmt.ext}` : '';
}

/* Atoms in a lattice block: atoms per cell times cells. */
function latticeAtoms(lat, source) {
  if (source !== 'lattice' || !lat) return 0;
  const per = { sc: 1, bcc: 2, fcc: 4, hcp: 4, diamond: 8 }[lat.style] || 1;
  const c = (lat.cells || []).map(x => Math.max(1, Math.round(num(x, 1))));
  return per * (c[0] || 1) * (c[1] || 1) * (c[2] || 1);
}

/* ------------------------------------------------------------------ *
 * The pair style of each preset
 * ------------------------------------------------------------------ */

/*
 * The pair_style line, the coefficient lines the preset writes itself, the
 * files they read, and whether they go into in.settings (read again after
 * every read_restart) or before read_data.
 */
function pairSetup(ff, o, { W, custom }) {
  const out = { style: '', args: '', note: '', inSettings: false, coeffs: [], files: [], issues: [], mix: ff.mix, modify: [] };
  const restartable = ff.pair.restart;
  const cut = num(o.cutoff, ff.options.cutoff);
  switch (ff.id) {
    case 'charmm':
    case 'charmm-switch': {
      const inner = num(o.inner, 10);
      out.style = ff.pair.style;
      out.args = `${fl(inner)} ${fl(cut)}`;
      if (!(inner < cut)) out.issues.push({ severity: 'error', message: `The inner cut-off (${fmtNum(inner)} Å) must be below the outer one (${fmtNum(cut)} Å); LAMMPS stops otherwise.`, url: doc('pair_charmm') });
      out.note = ff.id === 'charmm'
        ? `CHARMM36 was fitted with the LJ force switched smoothly to zero between ${fmtNum(inner)} and ${fmtNum(cut)} Å; lj/charmmfsw is that force switching (Steinbach and Brooks), and LAMMPS recommends it over the older energy-switched lj/charmm styles. Coulomb: real space within ${fmtNum(cut)} Å, the rest by PPPM.`
        : `The older CHARMM style: LJ energy switched to zero between ${fmtNum(inner)} and ${fmtNum(cut)} Å. Its force has a kink at the switch, which LAMMPS's own notes say can disturb minimisation and dynamics; it is here for data files made for it (CHARMM22/27). Coulomb by PPPM beyond ${fmtNum(cut)} Å.`;
      break;
    }
    case 'amber':
    case 'opls':
      out.style = 'lj/cut/coul/long';
      out.args = fl(cut);
      out.note = ff.id === 'amber'
        ? `Lennard-Jones and real-space Coulomb cut at ${fmtNum(cut)} Å, the rest of the Coulomb sum by PPPM. AMBER's own default is 8 Å with PME and a dispersion correction; 9 to 10 Å is common and costs a little more.`
        : `Lennard-Jones and real-space Coulomb cut at ${fmtNum(cut)} Å, the rest by PPPM. The OPLS-AA papers used 11 to 13 Å cut-offs with long-range LJ corrections; moltemplate's OPLS-AA writes 11 Å.`;
      break;
    case 'class2':
      out.style = 'lj/class2/coul/long';
      out.args = fl(cut);
      out.note = `COMPASS's 9-6 Lennard-Jones and real-space Coulomb within ${fmtNum(cut)} Å (9.5 Å is the cut-off usual with COMPASS), the rest of the Coulomb sum by PPPM. lj/class2 always mixes by the sixth-power rule COMPASS uses.`;
      break;
    case 'tip3p':
    case 'spce': {
      const m = ff.water;
      out.style = 'lj/cut/coul/long';
      out.args = fl(cut);
      out.note = `${m.model}: Lennard-Jones on oxygen only, cut at ${fmtNum(cut)} Å with the long-range LJ correction (tail), and Coulomb by PPPM beyond ${fmtNum(cut)} Å (LAMMPS Howto_${ff.id === 'spce' ? 'spc' : 'tip3p'}).`;
      out.coeffs.push(['pair_coeff', `${W.o} ${W.o} ${fmtNum(m.epsO)} ${fmtNum(m.sigO)}`, `${m.model} oxygen: ε = ${fmtNum(m.epsO)} kcal/mol, σ = ${fmtNum(m.sigO)} Å (${ff.id === 'spce' ? 'Berendsen et al. 1987' : 'Jorgensen et al. 1983'}; LAMMPS Howto_${ff.id === 'spce' ? 'spc' : 'tip3p'}).`]);
      out.coeffs.push(['pair_coeff', `${W.h} ${W.h} ${fmtNum(m.epsH)} ${fmtNum(m.sigH)}`, `${m.model} hydrogen has no Lennard-Jones (ε = 0); σ = 1 Å only keeps the mixing rule defined.`]);
      out.coeffs.push(['bond_coeff', `${W.bond} ${fmtNum(m.kBond)} ${fmtNum(m.r0)}`, `O-H length ${fmtNum(m.r0)} Å, the model's. SHAKE holds it exactly in dynamics; the force constant (${fmtNum(m.kBond)} kcal/(mol·Å²), the flexible TIP3P value LAMMPS lists) only keeps the shape during minimisation.`]);
      out.coeffs.push(['angle_coeff', `${W.angle} ${fmtNum(m.kAngle)} ${fmtNum(m.theta0)}`, `H-O-H angle ${fmtNum(m.theta0)}°, the model's; held by SHAKE in dynamics, the force constant only matters in minimisation.`]);
      break;
    }
    case 'tip4p2005': {
      const m = ff.water;
      out.style = 'lj/cut/tip4p/long';
      out.args = `${W.o} ${W.h} ${W.bond} ${W.angle} ${fmtNum(m.om)} ${fl(cut)}`;
      out.note = `TIP4P/2005 puts oxygen's charge on a massless site M ${fmtNum(m.om)} Å along the H-O-H bisector; this style places M from O, H, the bond type and the angle type (${W.o} ${W.h} ${W.bond} ${W.angle}), so the data file needs no M atoms. LJ cut at ${fmtNum(cut)} Å with tail correction, as Abascal and Vega ran it; Coulomb by pppm/tip4p beyond.`;
      out.coeffs.push(['pair_coeff', `${W.o} ${W.o} ${fmtNum(m.epsO)} ${fmtNum(m.sigO)}`, `TIP4P/2005 oxygen: ε = ${fmtNum(m.epsO)} kcal/mol, σ = ${fmtNum(m.sigO)} Å (Abascal and Vega 2005; LAMMPS Howto_tip4p).`]);
      out.coeffs.push(['pair_coeff', `${W.h} ${W.h} 0.0 1.0`, 'Hydrogen has no Lennard-Jones (ε = 0); σ = 1 Å only keeps the mixing rule defined.']);
      out.coeffs.push(['bond_coeff', `${W.bond} ${fmtNum(m.kBond)} ${fmtNum(m.r0)}`, `O-H length ${fmtNum(m.r0)} Å, the model's; SHAKE holds it in dynamics, the force constant only matters in minimisation (LAMMPS Howto_tip4p: rigid models ignore it).`]);
      out.coeffs.push(['angle_coeff', `${W.angle} ${fmtNum(m.kAngle)} ${fmtNum(m.theta0)}`, `H-O-H angle ${fmtNum(m.theta0)}°, the model's; held by SHAKE in dynamics.`]);
      break;
    }
    case 'eam':
    case 'eam/alloy':
    case 'eam/fs':
    case 'tersoff':
    case 'sw': {
      const file = str(o.potentialFile) || ff.options.potentialFile;
      const el = words(o.elements || ff.options.elements);
      out.style = ff.pair.style;
      out.args = '';
      out.inSettings = true;
      out.files.push(file);
      const what = { eam: 'embedded-atom', 'eam/alloy': 'embedded-atom (setfl)', 'eam/fs': 'Finnis-Sinclair embedded-atom', tersoff: 'Tersoff bond-order', sw: 'Stillinger-Weber' }[ff.id];
      out.note = `The ${what} potential: its whole form is in the file pair_coeff reads. It writes nothing into restart files, so every stage gives pair_style and pair_coeff again (read_restart docs).`;
      if (ff.id === 'eam') {
        out.coeffs.push(['pair_coeff', `* * ${file}`, `${file}: a funcfl file for one element; LAMMPS also takes the element's mass from it. Copy it from lammps/potentials or the potential's source.`]);
      } else {
        if (!el.length) out.issues.push({ severity: 'error', message: `${ff.pair.style} needs the element of each atom type, in type order (e.g. "Cu" or "Cu Ni").`, url: doc(ff.id.startsWith('eam') ? 'pair_eam' : `pair_${ff.id}`) });
        out.coeffs.push(['pair_coeff', `* * ${file} ${el.join(' ')}`, `${file}, with ${el.length === 1 ? `every atom type taken as ${el[0]}` : `atom types 1 to ${el.length} taken as ${el.join(', ')}`}: the names must match the elements in the file, one per atom type.${ff.id.startsWith('eam') ? ' LAMMPS takes the masses from the file.' : ''}`]);
      }
      break;
    }
    case 'reaxff': {
      const file = str(o.potentialFile) || 'ffield.reax';
      const el = words(o.elements);
      const control = str(o.controlFile) || 'NULL';
      out.style = 'reaxff';
      out.args = control;
      out.inSettings = true;
      out.files.push(file);
      if (control !== 'NULL') out.files.push(control);
      out.note = `ReaxFF${control === 'NULL' ? ' with its default control settings (NULL: no control file)' : `, with the control settings in ${control}`}. It writes nothing into restart files, so every stage gives pair_style and pair_coeff again.`;
      if (!el.length) out.issues.push({ severity: 'error', message: 'ReaxFF needs the element of each atom type, in type order (e.g. "C H O N"), as named in the force-field file.', url: doc('pair_reaxff') });
      out.coeffs.push(['pair_coeff', `* * ${file} ${el.join(' ')}`, `The ReaxFF parameters in ${file}, with atom types 1 to ${el.length || '?'} taken as ${el.join(', ') || '?'}: the names must match elements in the file.`]);
      break;
    }
    case 'lj': {
      const eps = num(o.epsilon, 1);
      const sig = num(o.sigma, 1);
      out.style = 'lj/cut';
      out.args = fmtNum(cut);
      out.note = `Lennard-Jones cut at ${fmtNum(cut)} σ, the cut-off of LAMMPS's melt example; the potential there is ${fmtNum(Number((4 * eps * ((sig / cut) ** 12 - (sig / cut) ** 6)).toPrecision(3)))} ε, small enough to leave unshifted.`;
      out.coeffs.push(['pair_coeff', `1 1 ${fl(eps)} ${fl(sig)} ${fl(cut)}`, `ε = ${fmtNum(eps)} and σ = ${fmtNum(sig)}: in reduced units every length is in σ, every energy in ε.`]);
      if (o.ljShift) out.modify.push(['shift yes', 'Shifts the potential so it is zero at the cut-off: no energy jump when pairs cross it, which helps energy conservation.']);
      if (o.ljTail) out.modify.push(['tail yes', 'Adds the analytic correction for the Lennard-Jones attraction beyond the cut-off to the energy and pressure: densities closer to the full potential\'s.']);
      break;
    }
    case 'custom':
      out.style = custom.pairStyle;
      out.inSettings = NO_RESTART_PAIR.test(out.style);
      break;
    default:
      break;
  }
  if (ff.id !== 'custom' && !restartable) out.inSettings = true;
  return out;
}

/* ------------------------------------------------------------------ *
 * in.system
 * ------------------------------------------------------------------ */

function header(w, title, lines) {
  w.comment(`${title}`);
  for (const l of lines) w.comment(l);
  w.comment(`Written by the STEMKit MD Workflow Generator for LAMMPS ${LAMMPS_VERSION}.`);
}

function systemFile(ctx) {
  const { s, ff, units, atomStyle, source, styles, pair, cmapFile, waterModel, W, custom, D } = ctx;
  const w = fileWriter('in.system', 'lammps');
  header(w, 'How the system is made. Only the first stage reads this file;', [
    'the stages after it start from the restart file of the stage before,',
    'which keeps the atoms, the box, the styles and most coefficients.'
  ]);
  if (source === 'restart') {
    w.section('From your restart file');
    const file = str(s.system.restartFile) || 'system.restart';
    w.cmd('read_restart', file, `Starts from your restart file ${file}: it holds the units, atom style, box, atoms, velocities, groups, styles and most coefficients, so none of them is given here. LAMMPS reads restart files written by the same version on the same kind of machine; convert others with lmp -restart2data.`);
    if (cmapFile) {
      w.cmd('fix', `cmap all cmap ${cmapFile}`, 'fix cmap goes after read_restart: the restart keeps the list of cross-terms, and the fix must be given again with the same ID to use it (fix_cmap).');
      w.cmd('fix_modify', 'cmap energy yes', 'Counts the CMAP energy in the potential energy, as minimisation and the thermo output need.');
    }
    return w.file();
  }
  w.section('Units and atoms');
  w.cmd('units', units, unitsNote(ctx));
  w.cmd('atom_style', atomStyle, atomStyleNote(atomStyle, ff));
  w.cmd('boundary', str(s.system.boundary) || 'p p p', /^p p p$/.test(str(s.system.boundary) || 'p p p')
    ? 'Periodic in x, y and z: a bulk system with no walls or surfaces.'
    : `Boundaries as you set them (${str(s.system.boundary)}); a barostat can only act along periodic directions.`);
  if (custom) {
    if (custom.before.length) {
      w.section('Your force-field lines (styles)');
      for (const line of custom.before) w.raw(line, 'Your line, as you wrote it: a style or setting that must come before the data file is read.');
    }
  } else {
    w.section('Force field');
    if (styles) {
      for (const k of ['bond', 'angle', 'dihedral', 'improper']) {
        if (!styles[k]) continue;
        w.cmd(`${k}_style`, styles[k], styleNote(k, styles[k], ff));
      }
    }
    if (!pair.inSettings && pair.style) w.cmd('pair_style', `${pair.style} ${pair.args}`.trim(), pair.note);
    if (ff.special) w.cmd('special_bonds', ff.special, specialNote(ff));
  }
  if (source === 'data') {
    const file = str(s.system.dataFile) || 'system.data';
    if (cmapFile) {
      w.cmd('fix', `cmap all cmap ${cmapFile}`, `CHARMM's backbone cross-term correction (CMAP), with the grids in ${cmapFile} (charmm36.cmap in lammps/potentials for CHARMM36). It must come before read_data, which hands it the CMAP section.`);
      w.cmd('fix_modify', 'cmap energy yes', 'Counts the CMAP energy in the potential energy, as minimisation and the thermo output need.');
    }
    w.section('The atoms');
    w.cmd('read_data', `${file}${cmapFile ? ' fix cmap crossterm CMAP' : ''}`, `${ctx.molecular ? 'Atoms, box, topology' : 'Atoms and box'}${ff.id === 'custom' || !ctx.molecular ? '' : ' and the coefficients the file holds'} from ${file}${D && D.natoms ? ` (${fmtCount(D.natoms)} atoms)` : ''}.${cmapFile ? ' The crossterm keyword gives fix cmap the CMAP section.' : ''}`);
    if (waterModel) {
      w.cmd('set', `type ${W.o} charge ${fmtNum(waterModel.qO)}`, `${waterModel.model} charges, whatever the data file holds: ${fmtNum(waterModel.qO)} e on oxygen${waterModel.om ? ' (placed on the M site by the pair style)' : ''}.`);
      w.cmd('set', `type ${W.h} charge ${fmtNum(waterModel.qH)}`, `and ${fmtNum(waterModel.qH)} e on each hydrogen, so each molecule is neutral.`);
    }
  } else {
    const lat = s.system.lattice || {};
    const style = str(lat.style) || 'fcc';
    const a = num(lat.constant, ff.lattice ? ff.lattice.constant : 3.615);
    const c = (lat.cells || [10, 10, 10]).map(x => Math.max(1, Math.round(num(x, 10))));
    w.section('The crystal');
    w.cmd('lattice', `${style} ${fmtNum(a)}`, ctx.lj
      ? `An ${style} lattice at reduced density ${fmtNum(a)} (in lj units the lattice command takes a density, not a spacing); 0.8442 is the liquid near the triple point used in the melt example.`
      : `An ${style} lattice with a lattice constant of ${fmtNum(a)} Å${lat.element ? ` (${lat.element})` : ''}. Use the constant at your temperature, or relax it (minimisation with box relaxation, then NPT).`);
    w.cmd('region', `box block 0 ${c[0]} 0 ${c[1]} 0 ${c[2]}`, `${c[0]} × ${c[1]} × ${c[2]} unit cells (${fmtCount(latticeAtoms({ style, cells: c }, 'lattice'))} atoms). A periodic box must be at least twice the cut-off wide.`);
    w.cmd('create_box', '1 box', 'One atom type in that box.');
    w.cmd('create_atoms', '1 box', 'Fills the box with atoms on the lattice sites.');
    const el = str(lat.element) || words(ctx.o.elements)[0] || '';
    const mass = num(lat.mass, null) || (ctx.lj ? num(ctx.o.mass, 1) : ELEMENT_MASSES[el]);
    const fileMass = ['eam', 'eam/alloy', 'eam/fs'].includes(ff.id);
    if (!fileMass) {
      if (mass) w.cmd('mass', `1 ${fl(mass)}`, ctx.lj ? 'Mass 1: in reduced units masses are in m.' : `The mass of ${el || 'the atoms'} in g/mol (IUPAC standard atomic weight).`);
      else ctx.issue('error', `No mass for "${el || '?'}": give the element or the mass under System.`);
    } else if (num(lat.mass, null)) {
      w.cmd('mass', `1 ${fmtNum(mass)}`, 'The mass you gave; pair eam would otherwise take it from the potential file.');
    }
  }
  return w.file();
}

function unitsNote(ctx) {
  const { units, ff, U } = ctx;
  const why = ff.id === 'custom' ? `Your lines say ${units}` : {
    Biomolecular: `${ff.label.split(' (')[0]} parameters are written in real units`,
    Water: `The ${ff.water ? ff.water.model : ''} parameters are given in real units`,
    Reactive: 'ReaxFF force-field files are written for real units',
    Materials: 'Potential files for metals and covalent crystals (eam, tersoff, sw) are written in metal units',
    Model: 'Reduced Lennard-Jones units'
  }[ff.family] || `${units} units`;
  return `${why}: energy in ${U.energy}, distance in ${U.distance}, time in ${U.time}, temperature in ${U.temperature}, pressure in ${U.pressure}. Every number below is in these units.`;
}

function atomStyleNote(style, ff) {
  const s = style.split(/\s+/)[0];
  return {
    full: 'full: molecule IDs, charges, bonds, angles, dihedrals and impropers, as a biomolecular data file holds them.',
    atomic: 'atomic: positions and types only; the potential gives everything else.',
    charge: `charge: positions, types and a charge per atom${ff.id === 'reaxff' ? ', which fix qeq/reaxff recomputes every step' : ''}.`,
    molecular: 'molecular: bonds and molecule IDs without charges.'
  }[s] || `${style}, as your data file is written.`;
}

function styleNote(kind, style, ff) {
  const notes = {
    'bond harmonic': 'Harmonic bonds, E = K(r - r0)²: LAMMPS\'s K already holds the factor 1/2.',
    'bond class2': 'Class II bonds: quadratic, cubic and quartic terms.',
    'angle charmm': 'CHARMM angles: harmonic, plus the Urey-Bradley 1-3 term.',
    'angle harmonic': 'Harmonic angles, E = K(θ - θ0)².',
    'angle class2': 'Class II angles with their bond-angle and bond-bond cross terms.',
    'dihedral charmmfsw': 'CHARMM dihedrals for force-switched LJ: the 1-4 pairs they include are computed consistently with lj/charmmfsw (dihedral_charmm docs).',
    'dihedral charmm': 'CHARMM dihedrals, which also compute the 1-4 LJ and Coulomb pairs with their own weights.',
    'dihedral fourier': 'Sums of cosines, the form AMBER torsions take; use the style your converter wrote (some write charmm or harmonic).',
    'dihedral opls': 'OPLS dihedrals: a four-term Fourier series.',
    'dihedral class2': 'Class II dihedrals with their cross terms.',
    'improper harmonic': 'Harmonic impropers, the CHARMM and OPLS form.',
    'improper cvff': 'cvff impropers, E = K[1 + d cos(nφ)]: AMBER\'s improper torsions as converters write them.',
    'improper class2': 'Class II out-of-plane terms (Wilson angles).'
  };
  return notes[`${kind} ${style}`] || `${style} ${kind}s, as your data file is written for.${ff.id === 'custom' ? '' : ' The data file\'s coefficients must be for this style.'}`;
}

function specialNote(ff) {
  return {
    charmm: 'CHARMM: 1-2, 1-3 and 1-4 pairs are left out of the pair style (weights 0 0 0); the CHARMM dihedral style adds the 1-4 pairs itself.',
    amber: 'AMBER: 1-2 and 1-3 pairs left out, 1-4 pairs scaled by 1/2 (LJ) and 5/6 (Coulomb), as Cornell et al. defined it.',
    'lj/coul 0.0 0.0 0.5': 'OPLS-AA: 1-2 and 1-3 pairs left out, 1-4 pairs at half strength for both LJ and Coulomb (Jorgensen et al. 1996).',
    'lj/coul 0.0 0.0 1.0': 'COMPASS: 1-2 and 1-3 pairs left out, 1-4 pairs at full strength (LAMMPS Howto_bioFF).'
  }[ff.special] || `special_bonds ${ff.special}.`;
}

/* ------------------------------------------------------------------ *
 * in.settings
 * ------------------------------------------------------------------ */

function settingsFile(ctx) {
  const { ff, pair, kspace, s, units, U, dt, groups, groupNotes, custom, o } = ctx;
  const what = [];
  if (pair.inSettings && (pair.style || custom)) what.push('the potential (pair_style and pair_coeff)');
  else if (pair.coeffs.length) what.push('the preset\'s coefficients');
  if (kspace || (custom && custom.after.some(l => /^\s*kspace_style/.test(l)))) what.push('long-range Coulomb');
  if (ff.id === 'reaxff') what.push('charge equilibration');
  what.push('neighbour lists');
  if (groups.length) what.push('groups');
  what.push('the time step');
  ctx.settingsWhat = listText(what);
  const w = fileWriter('in.settings', 'lammps');
  header(w, 'Settings every stage reads once its system is loaded.', [
    'A restart file does not keep these (read_restart docs), so each stage',
    'gives them again after read_data or read_restart.'
  ]);
  w.section('Interactions');
  if (pair.inSettings && pair.style && !custom) w.cmd('pair_style', `${pair.style} ${pair.args}`.trim(), pair.note);
  for (const [cmd, args, note] of pair.coeffs) w.cmd(cmd, args, note);
  if (!custom && pair.style && ff.pair.restart) {
    const mods = [];
    if (ff.mix) mods.push(['mix', ff.mix, ff.mix === 'arithmetic'
      ? `Unlike pairs from the like ones by the Lorentz-Berthelot rule (σ averaged, ε geometric), as ${ff.family === 'Water' ? 'the water models assume' : `${ff.label.split(' (')[0]} is defined`}${ff.id.startsWith('charmm') ? '; lj/charmm mixes this way by default' : ''}.`
      : ff.id === 'lj' ? 'Unlike pairs by the geometric rule, LAMMPS\'s default; with one atom type there are none.'
        : 'Unlike pairs by the geometric rule for both σ and ε, as OPLS-AA defines them.']);
    if (ff.tail) mods.push(['tail', 'yes', `Adds the Lennard-Jones attraction beyond the cut-off to the energy and pressure analytically: without it a ${fmtNum(num(o.cutoff, 10))} Å cut-off makes the liquid too light under a barostat.`]);
    for (const [k, v, note] of mods) w.cmd('pair_modify', `${k} ${v}`, note);
  }
  for (const [args, note] of pair.modify) w.cmd('pair_modify', args, note);
  if (ff.id === 'tip4p2005') {
    const m = ff.water;
    const need = num(o.cutoff, ff.options.cutoff) + m.om + m.r0 + U.skin;
    const cut = Math.ceil(need * 10) / 10;
    w.cmd('comm_modify', `cutoff ${fl(cut)}`, `Ghost atoms out to ${fmtNum(cut)} Å: a TIP4P M site can sit beyond its oxygen, so the pair style needs the Coulomb cut-off plus the O-M distance, an O-H bond and the skin (${fmtNum(Number(need.toFixed(4)))} Å). Set here, LAMMPS need not raise it itself, which it does with two warnings.`);
  }
  if (kspace) {
    w.cmd('kspace_style', `${kspace.style} ${sci(kspace.accuracy)}`, `Long-range Coulomb by ${kspace.style === 'pppm/tip4p' ? 'PPPM with the charge on TIP4P\'s M site' : 'particle-particle particle-mesh (PPPM)'}, to a relative force error of ${fmtNum(kspace.accuracy)}${ff.id.startsWith('charmm') ? ', what CHARMM-GUI writes (LAMMPS examples/charmmfsw)' : ': between the 1e-4 of most LAMMPS examples and the 1e-6 CHARMM-GUI writes'}. A restart file does not keep it.`);
  }
  if (ff.id === 'reaxff') {
    const tol = num(o.qeqTolerance, 1e-6);
    w.cmd('fix', `qeq all qeq/reaxff 1 0.0 10.0 ${sci(tol)} reaxff`, `Charge equilibration every step, as ReaxFF needs: charges from the electronegativities in the force field (reaxff), within a 10 Å taper, converged to ${fmtNum(tol)} (the LAMMPS examples' values). A fix, so every stage defines it.`);
  }
  if (custom && custom.after.length) {
    w.section('Your force-field lines');
    for (const line of custom.after) w.raw(line, 'Your line, as you wrote it. It is read by every stage, after read_data or read_restart.');
  }
  if (str(s.extraLines)) {
    w.section('Your extra lines');
    for (const line of String(s.extraLines).replace(/\r\n?/g, '\n').split('\n')) {
      if (!line.trim()) continue;
      w.raw(line, line.trim().startsWith('#') ? '' : 'Your line, as you wrote it; every stage reads it.');
    }
  }
  w.section('Neighbour lists');
  const skin = U.skin;
  w.cmd('neighbor', `${fl(skin)} bin`, `Pairs within the cut-off plus ${fmtNum(skin)} ${U.distance} are listed, so the list stays valid while atoms move; ${fmtNum(skin)} ${U.distance} is LAMMPS's default skin for ${units} units.`);
  w.cmd('neigh_modify', 'every 1 delay 0 check yes', 'Rebuild the list as soon as any atom has moved half the skin: always safe, and what LAMMPS does by default (minimisation requires every 1 delay 0). A restart file does not keep it.');
  if (groups.length) {
    w.section('Groups');
    for (const [name, args] of groups) w.cmd('group', `${name} ${args}`, groupNotes[name] || '');
  }
  w.section('Time step');
  const dtNote = timestepNote(ctx);
  w.cmd('timestep', fl(dt), dtNote);
  return w.file();
}

function timestepNote(ctx) {
  const { dt, tu, ff, rigid, s, lj, dtPs } = ctx;
  if (num(s.timestep, 0) > 0) return `${fmtNum(dt)} ${tu}, as you set it.`;
  if (lj) return `${fmtNum(dt)} τ, LAMMPS's default time step for lj units.`;
  if (ff.family === 'Reactive') return `${fmtNum(dt)} fs: ReaxFF needs 0.1 to 0.5 fs, as bonds form and break and hydrogens move fast.`;
  if (ff.units === 'metal') return `${fmtNum(dt)} ps = ${fmtNum(dtPs * 1000)} fs, LAMMPS's default for metal units and safe for atoms in a crystal up to well above room temperature.`;
  return rigid
    ? `${fmtNum(dt)} fs, possible because SHAKE holds the bonds to hydrogen (their vibration, about 10 fs, would otherwise need 1 fs)${ff.id === 'charmm' ? '; CHARMM-GUI writes 2 fs with SHAKE' : ''}.`
    : `${fmtNum(dt)} fs: the bonds to hydrogen are flexible, and their vibration (about 10 fs) needs a step of 1 fs or less.`;
}

/* ------------------------------------------------------------------ *
 * in.min
 * ------------------------------------------------------------------ */

function minFile(p, ctx) {
  const { s, ff, molecular, kspace, charged, cmapFile, lj, U, P, restrainGroup, rigid, constraints, shakeArgs } = ctx;
  const st = s.stages.min;
  const w = fileWriter(p.file, 'lammps', p.key);
  header(w, `${p.label}.`, [
    `Reads ${p.first ? (ctx.source === 'lattice' ? 'in.system (the crystal is built there)' : `in.system (${p.from})`) : p.from}; writes min.restart and min.log.`,
    'Run: lmp -in in.min'
  ]);
  w.blank();
  w.cmd('log', 'min.log', 'The stage\'s own log file, so each stage keeps its record.');
  w.section('The system');
  if (p.first) {
    w.cmd('include', 'in.system', 'How the system is made: units, styles and atoms.');
  } else {
    w.cmd('read_restart', p.from, `The state ${p.from.replace(/\.restart.*$/, '')} ended in.`);
    if (cmapFile) {
      w.cmd('fix', `cmap all cmap ${cmapFile}`, 'Given again after read_restart, which keeps the cross-terms for it (fix_cmap).');
      w.cmd('fix_modify', 'cmap energy yes', 'Counts the CMAP energy in the potential energy.');
    }
  }
  w.cmd('include', 'in.settings', `Settings a restart file does not keep: ${ctx.settingsWhat}.`);
  const restrain = !!st.restrain && !!restrainGroup;
  w.section('Holding atoms');
  if (restrain) {
    w.cmd('fix', `posres_min ${restrainGroup} spring/self ${fmtNum(restraintK(ctx))}`, restraintNote(ctx, 'min'));
    w.cmd('fix_modify', 'posres_min energy yes', 'The minimiser must see the spring energy, or energy and forces disagree and it stops early (fix_spring_self).');
  }
  if (rigid && ff.styles && ff.styles.bond === 'zero') {
    w.cmd('fix', `constrain all ${constraints} 1.0e-4 20 0 ${shakeArgs}`, 'The bonds have no force of their own (bond_style zero), so SHAKE holds them during minimisation too, as stiff springs (LAMMPS warns that it substitutes restraints; fix_shake).');
  }
  const boxRelax = !!st.boxRelax;
  if (boxRelax) {
    w.section('Box relaxation');
    const cpl = s.coupling === 'membrane' ? `x ${fl(P)} y ${fl(P)} z ${fl(P)} couple xy` : `${s.coupling === 'tri' ? 'tri' : s.coupling === 'aniso' ? 'aniso' : 'iso'} ${fl(P)}`;
    w.cmd('fix', `relax all box/relax ${cpl} vmax 0.001`, `The box shrinks or grows during minimisation until the pressure is ${fmtNum(P)} ${U.pressure} (${s.coupling === 'membrane' ? 'x and y together, z apart' : s.coupling}); the volume changes by at most 0.1% per iteration (vmax), ten times LAMMPS's default, for crystals far from their lattice constant. LAMMPS notes the minimiser may need restarting to converge fully.`);
    if (!['cg', 'sd'].includes(st.style)) ctx.issue('error', `Box relaxation works only with the cg and sd minimisers (min_style ${st.style} does not support fix box/relax).`, { stage: 'min', url: doc('fix_box_relax') });
  }
  w.section('Output');
  const cols = ['step', 'pe'];
  if (molecular) cols.push('ebond', 'eangle', ...(ff.styles && ff.styles.dihedral ? ['edihed'] : []), ...(ff.styles && ff.styles.improper ? ['eimp'] : []));
  if (molecular || charged) cols.push('evdwl', 'ecoul');
  if (kspace) cols.push('elong');
  cols.push('press', 'fnorm', 'fmax');
  if (boxRelax) cols.push('vol');
  w.cmd('thermo_style', `custom ${cols.join(' ')}`, `The energy terms, the pressure, and fnorm (the length of the force vector over all atoms) and fmax (the largest force on any atom, ${U.force}): watch both fall.`);
  w.cmd('thermo_modify', `norm ${lj ? 'yes' : 'no'} flush yes`, `${lj ? 'Energies per atom, the lj convention' : 'Energies for the whole system (LAMMPS\'s default for real and metal units)'}; flush writes each line to the log at once, so you can follow it and nothing is lost if the job is killed.`);
  w.cmd('thermo', String(p.output.thermo), `A line every ${plural(p.output.thermo, 'iteration')}.`);
  w.section('Minimise');
  const style = LMP_MIN_STYLES.find(m => m.id === st.style) || LMP_MIN_STYLES[0];
  w.cmd('min_style', style.id, `${style.summary}`);
  const etol = num(st.etol, 1e-4);
  const ftol = num(st.ftol, 1e-6);
  const maxiter = Math.max(1, Math.round(num(st.maxiter, 5000)));
  const maxeval = Math.max(maxiter, Math.round(num(st.maxeval, 50000)));
  w.cmd('minimize', `${sci(etol)} ${sci(ftol)} ${maxiter} ${maxeval}`, `Stops when the energy changes by less than ${fmtNum(etol)} of itself between iterations, or the force vector falls below ${fmtNum(ftol)} ${U.force}, or after ${fmtCount(maxiter)} iterations or ${fmtCount(maxeval)} force evaluations. ${kspace ? 'With PPPM the minimiser often stops on "linesearch alpha is zero" before the tolerances: the long-range forces are accurate only to the kspace accuracy, and the structure is relaxed enough for dynamics.' : 'The minimisation statistics at the end of min.log say which criterion stopped it.'}`);
  w.section('Hand on');
  w.cmd('write_restart', 'min.restart', 'The minimised state, which the next stage reads (and which tells the job script this stage is done).');
  return w.file();
}

function restraintK(ctx) {
  const k = num(ctx.s.restraint.k, null);
  return k !== null && k > 0 ? k : ctx.ff.defaults.restraintK;
}

function restraintNote(ctx, key) {
  const k = restraintK(ctx);
  const given = num(ctx.s.restraint.k, null);
  const unit = { real: 'kcal/(mol·Å²)', metal: 'eV/Å²', lj: 'ε/σ²' }[ctx.units] || `${ctx.U.energy}/${ctx.U.distance}²`;
  const ref = given ? 'as you set it' : '1000 kJ/(mol·nm²), the strength GROMACS\'s posre.itp uses';
  return `Ties each restrained atom to where it is when the ${key === 'min' ? 'minimisation' : 'stage'} starts, with a spring of ${fmtNum(k)} ${unit} (${ref}), so the solvent settles around a structure that keeps its shape. A restart file keeps the anchor points, so a continued stage keeps them too.`;
}

/* ------------------------------------------------------------------ *
 * The dynamics stages
 * ------------------------------------------------------------------ */

function dynamicsFile(p, ctx) {
  const { s, U, tu, T, P, dt, seed, rigid, constraints, shakeArgs, shakeWhat, restrainGroup, cmapFile, dumpFormat, lj, molecular, charged, plumedName, units } = ctx;
  const w = fileWriter(p.file, 'lammps', p.key);
  const traj = trajName(p.key, dumpFormat);
  header(w, `${p.label}: ${p.time} (${fmtCount(p.steps)} steps of ${fmtNum(dt)} ${tu}), ${p.ensemble}${p.thermostat ? ` at ${fmtNum(T)} ${U.temperature}` : ''}${p.barostat ? ` and ${fmtNum(P)} ${U.pressure}` : ''}${p.restrain ? ', restrained' : ''}.`, [
    `Starts from ${p.first ? (ctx.source === 'lattice' ? 'the crystal built in in.system' : `in.system (${p.from})`) : p.from}; writes ${p.prefix}.<step> every ${fmtCount(p.output.restart)} steps, ${p.log}${traj ? ` and ${traj}` : ''}.`,
    'submit.sh continues it from its newest restart file; by hand: lmp -in ' + p.file
  ]);
  w.section('Start or continue');
  w.cmd('variable', 'rstep index -1', `The step of this stage's restart file to continue from: submit.sh passes it (-var rstep ${Math.min(p.output.restart, p.steps)} continues from ${p.prefix}.${Math.min(p.output.restart, p.steps)}); -1, the default, starts the stage.`);
  w.cmd('variable', 'time_limit index off', 'The wall time LAMMPS may use, in seconds: submit.sh passes what the job has left, and LAMMPS stops cleanly before it runs out (timer timeout). off: no limit.');
  w.raw(`if "\${rstep} < 0" then "log ${p.log}" else "log ${p.log} append"`, 'A new stage starts its log; a continued one adds to it, so the log holds one unbroken record.');
  const freshLines = [];
  const contLines = [`"read_restart ${p.prefix}.\${rstep}"`];
  if (p.first) {
    freshLines.push('"include in.system"');
  } else {
    freshLines.push(`"read_restart ${p.from}"`);
  }
  if (cmapFile) {
    const cm = [`"fix cmap all cmap ${cmapFile}"`, '"fix_modify cmap energy yes"'];
    if (!p.first) freshLines.push(...cm);
    contLines.push(...cm);
  }
  freshLines.push('"reset_timestep 0"');
  w.raw(`if "\${rstep} < 0" then &\n  ${freshLines.join(' &\n  ')} &\nelse &\n  ${contLines.join(' &\n  ')}`,
    `A new stage ${p.first ? 'builds the system (in.system)' : `starts from ${p.from}, the state ${(ctx.plans[ctx.plans.indexOf(p) - 1] || {}).label || 'the stage before'} ended in,`} and counts its steps from 0; a continued one reads its own newest restart file, which keeps the step, positions, velocities${p.restrain ? ', restraint anchors' : ''} and the thermostat's state.${cmapFile ? ' fix cmap follows read_restart, which keeps its cross-terms.' : ''}`);
  w.cmd('include', 'in.settings', `Settings a restart file does not keep: ${ctx.settingsWhat}.`);
  const stochastic = ['langevin', 'csvr'].includes(p.thermostat);
  if (stochastic) {
    w.cmd('variable', `seed equal ${seed}+v_rstep+1`, `The ${p.thermostat === 'langevin' ? 'Langevin' : 'CSVR'} thermostat's random seed: ${seed} for a new stage, a different one each time the stage continues, so a continued run does not repeat the random kicks of its start.`);
  }

  // Forces first, then integration, then constraints, then the box.
  const forceFixes = [];
  if (p.restrain) forceFixes.push(['fix', `posres_${p.key} ${restrainGroup} spring/self ${fmtNum(restraintK(ctx))}`, restraintNote(ctx, p.key)]);
  if (p.plumed) {
    forceFixes.push(['variable', `plumed_in index ${plumedName}`, `The PLUMED input: ${plumedName} for a new stage; submit.sh passes plumed.restart.dat (RESTART, then ${plumedName}) when the stage continues, so PLUMED appends to its files instead of setting them aside.`]);
    forceFixes.push(['raw', `if "\${rstep} < 0" then "variable plumed_log string plumed.${p.key}.log" else "variable plumed_log string plumed.${p.key}.\${rstep}.log"`,
      `PLUMED's own log: plumed.${p.key}.log for a new stage, plumed.${p.key}.<step>.log for each continuation, since PLUMED would set an existing log aside (bck.0.*) rather than add to it.`]);
    forceFixes.push(['fix', `plumed all plumed plumedfile \${plumed_in} outfile \${plumed_log}`, 'PLUMED adds its bias forces every step. It comes before the thermostat, SHAKE and the barostat: LAMMPS stops if a fix that computes the pressure comes first (fix_plumed), and SHAKE must see every force.']);
  }
  const ens = ensembleFixes(p, ctx);
  if (forceFixes.length) {
    w.section(p.plumed && !p.restrain ? 'PLUMED' : p.plumed ? 'Restraints and PLUMED' : 'Restraints');
    for (const f of forceFixes) {
      if (f[0] === 'raw') w.raw(f[1], f[2]);
      else w.cmd(...f);
    }
  }
  w.section(p.ensemble === 'NVE' ? 'Integration' : p.ensemble === 'NPT' ? 'Temperature and pressure' : 'Temperature');
  for (const f of ens.before) w.cmd(...f);
  if (rigid) {
    const style = constraints === 'rattle' && ens.boxFinalIntegrate ? 'shake' : constraints;
    if (constraints === 'rattle' && ens.boxFinalIntegrate) {
      ctx.issue('note', `${p.label}: RATTLE cannot be used with fix ${ens.boxFix}: it must come before any fix that changes the box, yet after every integration fix, and ${ens.boxFix} is both. This stage uses SHAKE.`, { stage: p.key, url: doc('fix_shake') });
    }
    w.cmd('fix', `constrain all ${style} 1.0e-4 20 0 ${shakeArgs}`, `${style === 'rattle' ? 'RATTLE' : 'SHAKE'} holds ${shakeWhat}, solved to a relative tolerance of 1e-4 in at most 20 iterations. It comes after every fix that adds forces and before ${ens.boxFix ? `fix ${ens.boxFix}, which changes the box (LAMMPS requires that order)` : 'any fix that changes the box'}.`);
  }
  for (const f of ens.after) w.cmd(...f);

  if (p.velocities === 'create') {
    w.section('Velocities (new stage only)');
    const create = `velocity all create ${fl(T)} ${seed} dist gaussian mom yes rot yes`;
    if (rigid) {
      w.raw(`if "\${rstep} < 0" then &\n  "${create}" &\n  "run 0 post no" &\n  "velocity all scale ${fl(T)}"`,
        `New velocities at ${fmtNum(T)} ${U.temperature} (seed ${seed}), drawn from a Gaussian, with no net momentum (mom) or rotation (rot). SHAKE removes some of the motion they carry, so a zero-step run counts the constrained degrees of freedom and the velocities are scaled back to ${fmtNum(T)} ${U.temperature}, as the velocity docs advise.`);
    } else {
      w.raw(`if "\${rstep} < 0" then "${create}"`,
        `New velocities at ${fmtNum(T)} ${U.temperature} (seed ${seed}), drawn from a Gaussian, with no net momentum (mom) or rotation (rot). A continued stage keeps the velocities of its restart file.`);
    }
  }

  w.section('Output');
  const cols = ['step', 'time', 'temp', 'press', 'pe', 'ke', 'etotal'];
  if (p.ensemble === 'NPT') cols.push('density', 'vol');
  if (p.coupling && p.coupling !== 'iso') cols.push('lx', 'ly', 'lz', 'pxx', 'pyy', 'pzz');
  if (p.ensemble === 'NVE' || ['nose-hoover', 'csvr'].includes(p.thermostat)) cols.push('econserve');
  w.cmd('thermo_style', `custom ${cols.join(' ')}`, thermoNote(p, ctx));
  w.cmd('thermo_modify', `norm ${lj ? 'yes' : 'no'} flush yes`, `${lj ? 'Energies per atom, the lj convention' : 'Energies for the whole system (LAMMPS\'s default for real and metal units)'}; flush writes each line to the log at once, so nothing is lost if the job is killed.`);
  w.cmd('thermo', String(p.output.thermo), `A line every ${plural(p.output.thermo, 'step')} (${formatTime(p.output.thermo * dt, units)}).`);
  if (p.output.dump && dumpFormat.style) {
    const id = 'traj';
    let cols2 = '';
    if (dumpFormat.style === 'custom') {
      const c = ['id'];
      if (molecular) c.push('mol');
      c.push('type');
      if (charged) c.push('q');
      c.push(...(s.dump.unwrap ? ['xu', 'yu', 'zu'] : ['x', 'y', 'z', 'ix', 'iy', 'iz']));
      cols2 = ` ${c.join(' ')}`;
    }
    const fileArg = dumpFormat.append ? traj : '${traj}';
    if (!dumpFormat.append) {
      w.raw(`if "\${rstep} < 0" then "variable traj string ${traj}" else "variable traj string ${p.key}.\${rstep}.${dumpFormat.ext}"`,
        `${dumpFormat.style.toUpperCase()} files cannot be appended to (dump_modify append), so a continued stage writes a new file named after the step it continues from (${p.key}.<step>.${dumpFormat.ext}); join them in order for analysis.`);
    }
    w.cmd('dump', `${id} all ${dumpFormat.style} ${p.output.dump} ${fileArg}${cols2}`, dumpNote(p, ctx));
    const mods = [];
    if (dumpFormat.style === 'custom' || dumpFormat.style === 'atom') mods.push('sort id');
    if (dumpFormat.style === 'atom') mods.push('image yes');
    if ((dumpFormat.style === 'dcd' || dumpFormat.style === 'xtc') && s.dump.unwrap) mods.push('unwrap yes');
    if (mods.length) {
      w.cmd('dump_modify', `${id} ${mods.join(' ')}`, mods.includes('sort id')
        ? `Atoms in the order of their IDs in every frame, which VMD, OVITO and analysis scripts expect (LAMMPS writes them unsorted otherwise)${mods.includes('image yes') ? ', with image flags, so molecules can be made whole' : ''}.`
        : 'Unwrapped coordinates: a molecule crossing the box edge stays whole, and diffusion can be measured directly.');
    }
    w.raw(`if "\${rstep} >= 0" then "dump_modify ${id}${dumpFormat.append ? ' append yes' : ''} delay $(v_rstep+1)"`,
      `A continued stage ${dumpFormat.append ? 'appends to the trajectory and ' : ''}starts writing after the step it continues from, which the previous run already wrote: no frame twice.`);
  }
  const rname = `${p.prefix}.*`;
  w.cmd('restart', `${p.output.restart} ${rname}`, `A restart file every ${plural(p.output.restart, 'step')} (${formatTime(p.output.restart * dt, units)}), named by its step (${p.prefix}.<step>): what this stage continues from after a wall-time stop or a crash. submit.sh keeps the three newest.`);
  w.section('Run');
  w.cmd('timer', 'timeout ${time_limit} every 100', 'Stops the run cleanly once the wall time LAMMPS was given runs out, checking every 100 steps; the restart file written next lets the stage continue. LAMMPS prints "Wall time limit reached" as a warning then.');
  w.cmd('run', `${p.steps} upto`, `Runs to step ${fmtCount(p.steps)} counted from the stage's start (upto), whether the stage is new or continued, so it always ends exactly there.`);
  w.cmd('write_restart', rname, `The state where the run stopped: ${p.prefix}.${p.steps} when the stage is complete${p.key === 'prod' ? '' : ', which the next stage reads'}, or the step the wall time cut it at.`);
  if (p.key === 'prod') {
    w.raw(`if "$(step) >= ${p.steps}" then "write_data prod.data nocoeff"`, 'At the very end, the final state as a data file too: plain text that any LAMMPS version reads (restart files are tied to the version and machine). nocoeff leaves out the coefficients, which in.system and in.settings hold.');
  }
  return w.file();
}

/* The fixes that integrate and couple temperature and pressure. */
function ensembleFixes(p, ctx) {
  const { T, P, tdamp, pdamp, tu, U, dt, s, ff } = ctx;
  const before = [];
  const after = [];
  const out = { before, after, boxFix: '', boxFinalIntegrate: false };
  const steps = (x) => Number((x / dt).toPrecision(4));
  const tNote = (what) => `${what} Tdamp ${fmtNum(tdamp)} ${tu} = ${fmtNum(steps(tdamp))} steps of ${fmtNum(dt)} ${tu}: ${num(s.tdamp, 0) > 0 ? 'as you set it' : 'LAMMPS suggests about 100 steps (fix_nh)'}.`;
  const cpl = (c) => (c === 'membrane'
    ? `x ${fl(P)} ${fl(P)} ${fl(pdamp)} y ${fl(P)} ${fl(P)} ${fl(pdamp)} z ${fl(P)} ${fl(P)} ${fl(pdamp)} couple xy`
    : `${c} ${fl(P)} ${fl(P)} ${fl(pdamp)}`);
  const cplWhat = {
    iso: 'x, y and z scaled together',
    aniso: 'x, y and z each following its own pressure',
    tri: 'all six cell parameters free',
    membrane: 'x and y scaled together, z on its own'
  }[p.coupling] || '';
  const pNote = (what) => `${what} ${fmtNum(P)} ${U.pressure} with ${cplWhat}, Pdamp ${fmtNum(pdamp)} ${tu} = ${fmtNum(steps(pdamp))} steps: ${num(s.pdamp, 0) > 0 ? 'as you set it' : 'LAMMPS suggests about 1000 steps'}.`;
  const modulus = num(s.bulkModulus, null) || bulkModulus(ff, ctx.units);
  const langevin = () => ['fix', `tstat all langevin ${fl(T)} ${fl(T)} ${fl(tdamp)} \${seed} zero yes`,
    tNote(`Langevin thermostat at ${fmtNum(T)} ${U.temperature}: friction and random kicks on every atom (fix_langevin);`) +
    ' zero yes removes the net random force, so the system does not drift.'];
  const csvr = () => ['fix', `tstat all temp/csvr ${fl(T)} ${fl(T)} ${fl(tdamp)} \${seed}`,
    tNote(`Stochastic velocity rescaling (Bussi et al. 2007) at ${fmtNum(T)} ${U.temperature}: samples the canonical ensemble and is robust from the first step;`)];
  const berendsenT = () => ['fix', `tstat all temp/berendsen ${fl(T)} ${fl(T)} ${fl(tdamp)}`,
    tNote(`Berendsen thermostat at ${fmtNum(T)} ${U.temperature}: fast and stable, but the kinetic energy fluctuates too little, so use it to equilibrate only;`)];
  const nve = (why) => ['fix', 'md all nve', why];
  if (p.ensemble === 'NVE') {
    before.push(nve('Plain velocity-Verlet integration: constant energy, no thermostat. The total energy (etotal) must stay flat; a drift means the time step is too long.'));
    return out;
  }
  if (p.ensemble === 'NVT') {
    switch (p.thermostat) {
      case 'nose-hoover':
        before.push(['fix', `md all nvt temp ${fl(T)} ${fl(T)} ${fl(tdamp)}`, tNote(`Integration with a Nosé-Hoover chain thermostat (three links, LAMMPS's default) at ${fmtNum(T)} ${U.temperature};`)]);
        break;
      case 'langevin':
        before.push(langevin());
        before.push(nve('The Langevin fix only adds forces; fix nve moves the atoms.'));
        break;
      case 'csvr':
        before.push(nve('fix temp/csvr only rescales velocities; fix nve moves the atoms.'));
        before.push(csvr());
        break;
      default:
        before.push(nve('fix temp/berendsen only rescales velocities; fix nve moves the atoms.'));
        before.push(berendsenT());
    }
    return out;
  }
  // NPT.
  if (p.barostat === 'mtk') {
    if (p.thermostat === 'nose-hoover') {
      after.push(['fix', `md all npt temp ${fl(T)} ${fl(T)} ${fl(tdamp)} ${cpl(p.coupling)}`,
        `Nosé-Hoover thermostat and Martyna-Tobias-Klein barostat in one: ${fmtNum(T)} ${U.temperature} with Tdamp ${fmtNum(tdamp)} ${tu} = ${fmtNum(steps(tdamp))} steps (LAMMPS suggests 100), and ${pNote('').trim()}`]);
      out.boxFix = 'npt';
    } else {
      if (p.thermostat === 'langevin') before.push(langevin());
      else if (p.thermostat === 'csvr') before.push(csvr());
      else before.push(berendsenT());
      after.push(['fix', `md all nph ${cpl(p.coupling)} ptemp ${fl(T)}`,
        pNote('Integration with the Martyna-Tobias-Klein barostat (fix nph; the temperature is left to the thermostat above):') +
        ` ptemp gives the barostat the target temperature for its mass.`]);
      out.boxFix = 'nph';
    }
    out.boxFinalIntegrate = true;
    return out;
  }
  // Berendsen barostat with any thermostat.
  if (p.thermostat === 'nose-hoover') before.push(['fix', `md all nvt temp ${fl(T)} ${fl(T)} ${fl(tdamp)}`, tNote(`Integration with a Nosé-Hoover chain thermostat at ${fmtNum(T)} ${U.temperature};`)]);
  else if (p.thermostat === 'langevin') { before.push(langevin()); before.push(nve('The Langevin fix only adds forces; fix nve moves the atoms.')); }
  else if (p.thermostat === 'csvr') { before.push(nve('fix temp/csvr only rescales velocities; fix nve moves the atoms.')); before.push(csvr()); }
  else { before.push(nve('fix temp/berendsen only rescales velocities; fix nve moves the atoms.')); before.push(berendsenT()); }
  const c = p.coupling === 'tri' ? 'aniso' : p.coupling;
  after.push(['fix', `pstat all press/berendsen ${cpl(c)} modulus ${fmtNum(modulus)}`,
    pNote('Berendsen barostat: scales the box towards') +
    ` The volume fluctuations are wrong, so use it to equilibrate only. modulus ${fmtNum(modulus)} ${U.pressure} is the bulk modulus that sets how fast the box responds (${num(s.bulkModulus, null) ? 'as you set it' : bulkModulusWhy(ff, ctx.units)}); LAMMPS's own default, 10, suits only a Lennard-Jones liquid.`]);
  out.boxFix = 'press/berendsen';
  out.boxFinalIntegrate = false;
  return out;
}

function bulkModulus(ff, units) {
  if (units === 'lj') return 10;
  if (units === 'metal') return ff.family === 'Materials' ? 1.0e6 : 2.2e4;
  return ff.family === 'Reactive' ? 1.0e5 : 2.17e4;
}

function bulkModulusWhy(ff, units) {
  if (units === 'lj') return 'LAMMPS\'s default, for a Lennard-Jones liquid';
  if (units === 'metal') return ff.family === 'Materials' ? 'about 100 GPa, the order of most metals and silicon; a larger value only slows the response' : 'water\'s 2.2 GPa';
  return ff.family === 'Reactive' ? 'about 10 GPa, a molecular solid; a larger value only slows the response' : 'water\'s 2.2 GPa, close to that of other liquids and soft matter';
}

function thermoNote(p, ctx) {
  const parts = ['Step, time, temperature, pressure and the energies'];
  if (p.ensemble === 'NPT') parts.push(`density (${ctx.U.density}) and volume, which settle as the box relaxes`);
  if (p.coupling && p.coupling !== 'iso') parts.push('the box edges and the diagonal pressures, which the coupling acts on');
  if (p.ensemble === 'NVE' || ['nose-hoover', 'csvr'].includes(p.thermostat)) parts.push('econserve, the total energy plus what the thermostat and barostat exchanged, which should stay flat');
  return `${listText(parts)}. ${ctx.lj ? 'The pressure of a small system swings widely' : `The pressure of a small system swings by hundreds of ${ctx.U.pressure}`}; judge its average.`;
}

function dumpNote(p, ctx) {
  const { dumpFormat, s, dt, units } = ctx;
  const every = `every ${plural(p.output.dump, 'step')} (${formatTime(p.output.dump * dt, units)})`;
  switch (dumpFormat.id) {
    case 'custom':
      return `A text trajectory ${every}: IDs, ${ctx.molecular ? 'molecule IDs, ' : ''}types, ${ctx.charged ? 'charges, ' : ''}and ${s.dump.unwrap ? 'unwrapped coordinates (xu yu zu: a molecule crossing the box edge stays whole)' : 'wrapped coordinates with image flags (ix iy iz count the box crossings)'}. OVITO and VMD read it.`;
    case 'atom':
      return `The classic LAMMPS trajectory ${every}: IDs, types and coordinates scaled to the box.`;
    case 'dcd':
      return `A DCD trajectory ${every}, single-precision binary (EXTRA-DUMP package). VMD and MDAnalysis read it with a topology from the data file.`;
    case 'xtc':
      return `A compressed XTC trajectory ${every}, coordinates to 0.001 nm (EXTRA-DUMP package). GROMACS tools, MDAnalysis and VMD read it.`;
    default:
      return '';
  }
}

/* ------------------------------------------------------------------ *
 * PLUMED
 * ------------------------------------------------------------------ */

/*
 * What the job script must know about a PLUMED input to continue it: the
 * files it prints (trimmed to before the restart step) and the hills it
 * lays (trimmed to the restart step), PLUMED's time per MD step, and the
 * methods whose exact continuation needs more than RESTART.
 */
function plumedFacts(text, { dt, units, name }) {
  const t = String(text || '');
  const lines = t.replace(/\r\n?/g, '\n').split('\n');
  // Join PLUMED's "..." continuation blocks into one line each.
  const actions = [];
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i].replace(/#.*$/, '');
    if (/\.\.\.\s*$/.test(l) && !/^\s*\.\.\./.test(l)) {
      const block = [l.replace(/\.\.\.\s*$/, '')];
      while (++i < lines.length && !/^\s*\.\.\./.test(lines[i])) block.push(lines[i].replace(/#.*$/, ''));
      l = block.join(' ');
    }
    if (l.trim()) actions.push(l.trim());
  }
  const prints = [];
  const hills = [];
  const warnings = [];
  let timeUnit = 1;
  let restartInside = false;
  for (const a of actions) {
    const m = /^(?:\S+:\s+)?([A-Z_0-9]+)\b(.*)$/.exec(a);
    if (!m) continue;
    const [, action, rest] = m;
    const file = (/(?:^|\s)FILE=(\S+)/.exec(rest) || [])[1];
    if (action === 'RESTART') restartInside = true;
    if (action === 'PRINT') prints.push(file || 'COLVAR');
    if (action === 'METAD') hills.push(file || 'HILLS');
    if (action === 'PBMETAD') {
      if (file) hills.push(...file.split(','));
      else warnings.push('PBMETAD writes one hills file per variable (HILLS.<name>); the job script cannot trim them before continuing, so after a hard kill they may hold hills from past the restart step. The PLUMED tab\'s job kit handles that exactly.');
    }
    if (action === 'UNITS') {
      const tu = (/(?:^|\s)TIME=(\S+)/.exec(rest) || [])[1];
      if (tu) timeUnit = { ps: 1, fs: 0.001, ns: 1000 }[tu] || num(tu, 1);
    }
    if (/^OPES/.test(action)) warnings.push(`${action} continues exactly only from a state file written at the restart step; with RESTART alone it reads its kernels back, which is close but not exact. The PLUMED tab's job kit writes the state with every restart file.`);
    if (action === 'ABMD') warnings.push('ABMD starts its ratchet again from wherever the variable is when the run continues, unless MIN is set; the PLUMED tab\'s job kit carries it over.');
  }
  if (restartInside) warnings.push(`${name} contains RESTART: a new run would stop at the first file it cannot find. Take it out; the job script adds it when a stage continues.`);
  const psPerStep = units === 'lj' ? dt : dt * ((UNITS[units] || UNITS.real).timeInPs || 1);
  return { name, prints: [...new Set(prints)], hills: [...new Set(hills)], timeUnit, dtPlumed: psPerStep / timeUnit, warnings, natural: units === 'lj' };
}

/* ------------------------------------------------------------------ *
 * Packages
 * ------------------------------------------------------------------ */

const STYLE_COMMANDS = new Set(['pair_style', 'bond_style', 'angle_style', 'dihedral_style', 'improper_style', 'kspace_style', 'atom_style', 'min_style']);

/* The LAMMPS packages the commands of the inputs come from. */
function packageList(files) {
  const found = new Set();
  for (const f of files) {
    for (const raw of f.text.split('\n')) {
      const line = raw.replace(/#.*$/, '').trim();
      const quoted = [...line.matchAll(/"([^"]+)"/g)].map(m => m[1]);
      for (const l of [line, ...quoted]) {
        const w = l.split(/\s+/);
        let info = null;
        if (STYLE_COMMANDS.has(w[0]) && w[1]) info = commandInfo(w[0], w[1]);
        else if (w[0] === 'fix' && w[3]) info = commandInfo('fix', w[3]);
        else if (w[0] === 'dump' && w[3]) info = commandInfo('dump', w[3]);
        if (info && info.package) found.add(info.package);
      }
    }
  }
  return [...found].sort();
}

/* ------------------------------------------------------------------ *
 * Output size
 * ------------------------------------------------------------------ */

/*
 * Bytes per atom and frame, measured on LAMMPS 29 Aug 2024 output of the
 * check harness (tools/check-lammps-workflow.mjs): a custom text dump with
 * molecule IDs and charges (id mol type q xu yu zu) about 42 bytes, with
 * charges only 40, positions and types only 31; atom style about 40; DCD 12
 * plus a 56-byte frame record; XTC about 4.5 at 0.001 nm precision. A
 * thermo line is about 15 bytes per column after a 5 kB set-up record.
 * Restart files hold about 170 bytes per atom with full topology, 100 for
 * atom style charge and 88 for atomic.
 */
const SIZE = { full: 42, charge: 40, atomic: 31, atom: 40, dcd: 12, dcdFrame: 56, xtc: 4.5, xtcFrame: 90, thermoCol: 15, logHead: 5000, restartFull: 170, restartCharge: 100, restartAtomic: 88 };

/**
 * Estimated output of a stage: trajectory, log and the restart files kept.
 *
 * @param {object} stage - One of `buildLammpsWorkflow(...).stages`.
 * @param {number} natoms
 * @param {{format?:string, molecular?:boolean, charged?:boolean}} [opts] - The
 *   dump format (an id of LMP_DUMP_FORMATS), and what the atom style holds.
 * @returns {{frames:{dump:number, thermo:number}, bytes:{dump:number, log:number, restart:number}, total:number}}
 */
export function estimateLammpsOutput(stage, natoms, opts = {}) {
  const n = Math.max(0, Number(natoms) || 0);
  const steps = Math.max(0, stage.steps || 0);
  const molecular = opts.molecular !== false;
  const charged = opts.charged !== undefined ? !!opts.charged : molecular;
  const frames = (every) => (every > 0 ? Math.floor(steps / every) + 1 : 0);
  const o = stage.output || {};
  const f = { dump: stage.dynamics ? frames(o.dump) : 0, thermo: stage.dynamics ? frames(o.thermo) : Math.ceil(steps / Math.max(1, o.thermo || 100)) };
  const text = molecular ? SIZE.full : charged ? SIZE.charge : SIZE.atomic;
  const perAtom = { custom: text, atom: SIZE.atom, dcd: SIZE.dcd, xtc: SIZE.xtc }[opts.format] || 0;
  const perFrame = { dcd: SIZE.dcdFrame, xtc: SIZE.xtcFrame, custom: 150, atom: 150 }[opts.format] || 0;
  const restartOne = n * (molecular ? SIZE.restartFull : charged ? SIZE.restartCharge : SIZE.restartAtomic) + 4000;
  const bytes = {
    dump: f.dump * (n * perAtom + perFrame),
    log: SIZE.logHead + f.thermo * SIZE.thermoCol * 10,
    // The job script keeps the three newest restart files of a stage.
    restart: stage.dynamics ? Math.min(3, Math.max(1, Math.floor(steps / Math.max(1, o.restart || steps)))) * restartOne : restartOne
  };
  return { frames: f, bytes, total: bytes.dump + bytes.log + bytes.restart };
}

/** Bytes in the most readable unit, 1000-based. */
export function formatBytes(bytes) {
  const b = Number(bytes);
  if (!Number.isFinite(b) || b <= 0) return '0 B';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = b;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : Number(v.toPrecision(2))} ${units[i]}`;
}

/* ------------------------------------------------------------------ *
 * README
 * ------------------------------------------------------------------ */

/**
 * The README of the zip.
 *
 * @param {object} workflow - {@link buildLammpsWorkflow}'s result.
 * @param {object} [opts] - `{jobName, submit (command), scheduler (label), date, files:[{name, note}]}`.
 * @returns {string}
 */
export function lammpsReadme(workflow, opts = {}) {
  const wf = workflow;
  const ff = wf.forceField;
  const U = UNITS[wf.units] || UNITS.real;
  const L = [];
  const date = opts.date instanceof Date ? opts.date : new Date();
  L.push(`# LAMMPS workflow${opts.jobName ? `: ${opts.jobName}` : ''}`, '');
  L.push(`Written by the STEMKit MD Workflow Generator (https://stemkit.net/script-generator.html) for LAMMPS ${wf.version}, ${date.toISOString().slice(0, 10)}.`, '');
  L.push(`${ff.label}, ${wf.units} units (energy in ${U.energy}, distance in ${U.distance}, time in ${U.time}, pressure in ${U.pressure}).`, '');

  L.push('## The files', '', '| File | What it is for |', '|---|---|');
  const fileNotes = {
    'in.system': 'How the system is made (units, styles, atoms). Only the first stage reads it.',
    'in.settings': `What every stage needs once the system is loaded and a restart file does not keep: ${wf.settingsWhat || 'neighbour lists and the time step'}.`,
    'README.md': 'This file.'
  };
  for (const p of wf.stages) fileNotes[p.file] = `${p.label}${p.dynamics ? `: ${p.time}, ${p.ensemble}` : ''}.`;
  const listed = new Set();
  for (const f of opts.files || []) { L.push(`| \`${f.name}\` | ${f.note} |`); listed.add(f.name); }
  for (const f of wf.files) {
    if (listed.has(f.name)) continue;
    const note = fileNotes[f.name] || (f.kind === 'plumed' ? 'The PLUMED input, as the PLUMED tab built it.' : '');
    L.push(`| \`${f.name}\` | ${note} |`);
  }
  L.push('');

  if (wf.needs.length) {
    L.push('## What you add', '');
    L.push(`Put these next to the input files: ${wf.needs.map(n => `\`${n}\``).join(', ')}.` +
      (wf.forceField.pair.restart ? '' : ' Potential files come with LAMMPS in its `potentials` directory, or from the potential\'s authors (the NIST Interatomic Potentials Repository lists many).'), '');
  }

  L.push('## The stages', '', '| Stage | File | Length | Steps | Ensemble | Restrained | Reads | Writes |', '|---|---|---|---|---|---|---|---|');
  for (const p of wf.stages) {
    L.push(`| ${p.label} | \`${p.file}\` | ${p.dynamics ? p.time : '-'} | ${p.dynamics ? fmtCount(p.steps) : `up to ${fmtCount(p.steps)} iterations`} | ${p.dynamics ? p.ensemble : '-'} | ${p.restrain ? 'yes' : 'no'} | ${p.first ? (wf.source === 'lattice' ? 'in.system (crystal)' : `\`${p.from}\``) : `\`${p.from}\``} | ${p.dynamics ? `\`${p.prefix}.${p.steps}\`, \`${p.log}\`` : '`min.restart`, `min.log`'} |`);
  }
  L.push('');
  L.push('## Shared settings', '');
  L.push(`- Time step: ${fmtNum(wf.timestep)} ${wf.timeUnit}${wf.constraints !== 'none' ? `, with ${wf.constraints.toUpperCase()} on the bonds to hydrogen${ff.water ? ' and the water angle' : ''}` : ''}.`);
  const dyn = wf.stages.filter(p => p.dynamics);
  if (dyn.some(p => p.thermostat)) {
    const ts = [...new Set(dyn.filter(p => p.thermostat).map(p => LMP_THERMOSTATS.find(t => t.id === p.thermostat).label))];
    L.push(`- Temperature: ${fmtNum(wf.temperature)} ${U.temperature}; ${ts.join(', ')}; Tdamp ${fmtNum(wf.tdamp)} ${wf.timeUnit}.`);
  }
  if (dyn.some(p => p.barostat)) {
    const by = new Map();
    for (const p of dyn.filter(x => x.barostat)) {
      const label = LMP_BAROSTATS.find(b => b.id === p.barostat).label;
      by.set(label, [...(by.get(label) || []), p.key === 'prod' ? 'production' : p.label]);
    }
    const bs = [...by].map(([label, stages]) => `${label} in ${listText(stages)}`);
    L.push(`- Pressure: ${fmtNum(wf.pressure)} ${U.pressure}, ${(LMP_COUPLINGS.find(c => c.id === wf.coupling) || {}).label.toLowerCase()} coupling; ${bs.join('; ')}; Pdamp ${fmtNum(wf.pdamp)} ${wf.timeUnit}.`);
  }
  L.push('');

  L.push('## Running it', '');
  L.push(`${opts.submit ? `Submit with \`${opts.submit}\`${opts.scheduler ? ` (${opts.scheduler})` : ''}. ` : ''}The job runs the stages in order. A stage that already finished is skipped. ` +
    'LAMMPS stops itself before the wall time (`timer timeout`, from TIME_LIMIT in the job script) and writes a restart file; submitting the job again continues the stage from its newest restart file ' +
    '(`-var rstep <step>`) and ends it at exactly its last step (`run N upto`). The step counter starts at 0 in each new stage and is never reset in a continued one, so the log and the trajectory carry on where they stopped ' +
    '(a continued run prints the thermo line of its first step, which the stopped run may have printed already: the two lines are the same state' +
    (wf.plumed && wf.plumed.hills.length ? ', though with metadynamics the second energy includes the hill laid at that step' : '') + ').', '');
  L.push('By hand, without the job script, each stage runs as it is:', '', '```');
  for (const p of wf.stages) L.push(`lmp -in ${p.file}`);
  L.push('```', '');
  L.push('and a stage stopped at step N continues with `lmp -in in.<stage> -var rstep N`.', '');
  L.push('If a job is killed outright (a node failure, or the scheduler before LAMMPS could stop), the stage continues from its newest periodic restart file, and the steps since then are run again: the job script first cuts the frames of a text trajectory' +
    (wf.plumed && wf.plumed.stages.length ? ' and the PLUMED rows' : '') + ' written after that step, so none appears twice, but the log keeps the lines of the killed run before the continued one' +
    (wf.dump && !wf.dump.append ? `, and a ${wf.dump.style.toUpperCase()} file of the killed run holds frames past the step its continuation starts from: drop those when you join the pieces` : '') + '. ' +
    'A job killed while LAMMPS was writing a restart file can leave that file cut short, and read_restart then stops: move it aside and submit again, and the stage continues from the restart file before it (the script keeps three).', '');

  if (wf.plumed && wf.plumed.stages.length) {
    L.push('## PLUMED', '');
    L.push(`\`${wf.plumed.name}\` is read by fix plumed in ${listText(wf.stages.filter(p => p.plumed).map(p => `\`${p.file}\``))}. ` +
      'Your LAMMPS must include the PLUMED package (`lmp -h` lists it under "Installed packages"). ' +
      'When a stage continues, the job script writes `plumed.restart.dat` (RESTART, then the input), so PLUMED appends to ' +
      `${listText([...wf.plumed.prints, ...wf.plumed.hills].map(f => `\`${f}\``)) || 'its files'} instead of renaming them, and first cuts any rows written after the restart step by a run that was killed, so none appears twice.`, '');
  }

  L.push('## What to check', '');
  for (const p of wf.stages) {
    if (!p.dynamics) {
      L.push(`- \`min.log\`: the "Minimization stats" at the end say which criterion stopped it; fmax should have fallen by orders of magnitude.`);
    } else if (p.ensemble === 'NVT') {
      L.push(`- \`${p.log}\`: the temperature reaches ${fmtNum(wf.temperature)} ${U.temperature} within a few Tdamp and fluctuates around it.`);
    } else if (p.ensemble === 'NPT' && p.key !== 'prod') {
      L.push(`- \`${p.log}\`: the density (and volume) drifts at first, then fluctuates around a steady value; the pressure averages to ${fmtNum(wf.pressure)} ${U.pressure}, though single values swing widely.`);
    } else if (p.key === 'prod' && p.ensemble !== 'NVE') {
      L.push(`- \`${p.log}\`: temperature${p.ensemble === 'NPT' ? ', pressure and density' : ' and pressure'} fluctuate around the values equilibration reached, with no drift; econserve${['nose-hoover', 'csvr'].includes(p.thermostat) ? '' : ' (where printed)'} changes slowly if at all.`);
    } else {
      L.push(`- \`${p.log}\`: the total energy (etotal) stays flat; a drift means the time step is too long.`);
    }
  }
  if (wf.constraints !== 'none') L.push('- SHAKE: LAMMPS stops with "Shake determinant = 0.0" or warns "Shake determinant < 0.0" if a constrained bond is badly stretched: minimise longer, or start with a smaller time step.');
  L.push('- Every log: no ERROR, and no WARNING you cannot explain. These ones are expected here:');
  for (const w of wf.expectedWarnings || []) L.push(`  - "${w.text}": ${w.why}`);
  L.push('');

  const issues = wf.issues.filter(i => i.severity !== 'note');
  if (issues.length) {
    L.push('## Before you run', '');
    for (const i of issues) L.push(`- ${i.severity === 'error' ? '**Error:** ' : ''}${i.message}`);
    L.push('');
  }

  if (wf.natoms > 0) {
    L.push(`## Expected output (${fmtCount(wf.natoms)} atoms, approximate)`, '', '| Stage | Frames | Output |', '|---|---|---|');
    let total = 0;
    for (const p of wf.stages) {
      total += p.bytes || 0;
      L.push(`| ${p.label} | ${p.dynamics && p.size ? fmtCount(p.size.frames.dump) : '-'} | ${formatBytes(p.bytes || 0)} |`);
    }
    L.push(`| All | | ${formatBytes(total)} |`, '');
  }

  if (wf.packages.length) {
    L.push('## LAMMPS packages these inputs use', '');
    L.push(`${wf.packages.join(', ')}. \`lmp -h\` lists the packages your LAMMPS was built with.`, '');
  }

  L.push('## Read more', '');
  for (const r of ff.sources) L.push(`- ${r.text}: ${r.url}`);
  L.push(`- Restarting a run (what a restart file keeps): ${doc('read_restart')}`);
  L.push(`- Thermostats: ${doc('Howto_thermostat')}; barostats: ${doc('Howto_barostat')}`);
  L.push('');
  return L.join('\n');
}
