/*
 * STEMKit, MD Workflow Generator: the GROMACS workflow as data.
 * Author: Olanrewaju M. Daramola
 *
 * No DOM here. The page reads its form into a plain state object; this
 * module turns that into one plan per stage (the .mdp text grompp will read,
 * what grompp will say about it, the -maxwarn it needs and why), the grompp
 * and mdrun lines of the job script, the mdrun GPU flags each stage can take,
 * a README for the zip, size estimates, and the reverse direction: settings
 * for the builder from an .mdp someone already has.
 *
 * Every .mdp comes from src/core/gromacs-mdp.js (generateMdp for the text,
 * checkMdp for the verdict); this module only decides what to ask it for,
 * applies the options the user set by hand, and wires the stages together.
 * What the plan reports about a stage (its length, steps, barostat, whether
 * it needs -r) is read back from the final file, so options set by hand are
 * described as grompp will read them.
 *
 * The GPU rules follow GROMACS 2025's own checks: pme_gpu_supports_input
 * (src/gromacs/ewald/pme.cpp), inputSupportsListedForcesGpu
 * (listed_forces/listed_forces_gpu_impl.cpp), decideWhetherToUseGpuForUpdate
 * and the thread-MPI rank count (taskassignment/decidegpuusage.cpp and
 * resourcedivision.cpp). mdrun stops at start-up when a flag asks for
 * something those checks refuse, so a stage never gets such a flag.
 */

import {
  generateMdp, checkMdp, parseMdp, normaliseName, canonicalName, optionInfo, mdpDocUrl, pullStart,
  FORCE_FIELDS, THERMOSTATS, BAROSTATS, SYSTEM_TYPES, formatDuration, psToSteps,
  MDP_RELEASE, MDP_MANUAL
} from '../src/core/gromacs-mdp.js';

/* ------------------------------------------------------------------ *
 * Stages
 * ------------------------------------------------------------------ */

/**
 * The stages the page offers, in the order the job runs them. `lengthPs`
 * and `output` are the defaults of the form.
 */
export const GX_STAGES = Object.freeze([
  Object.freeze({ key: 'em', label: 'Energy minimisation', short: 'EM', dynamics: false, mdp: 'em.mdp', deffnm: 'em', on: true, posres: false }),
  Object.freeze({ key: 'nvt', label: 'NVT equilibration', short: 'NVT', dynamics: true, mdp: 'nvt.mdp', deffnm: 'nvt', on: true, posres: true, lengthPs: 100,
    output: Object.freeze({ xtcPs: 10, energyPs: 1, logPs: 10, trrPs: 0 }) }),
  Object.freeze({ key: 'npt', label: 'NPT equilibration', short: 'NPT', dynamics: true, mdp: 'npt.mdp', deffnm: 'npt', on: true, posres: true, lengthPs: 100,
    output: Object.freeze({ xtcPs: 10, energyPs: 1, logPs: 10, trrPs: 0 }) }),
  Object.freeze({ key: 'prod', label: 'Production', short: 'MD', dynamics: true, mdp: 'md.mdp', deffnm: 'md', on: true, posres: false, lengthPs: 100000,
    output: Object.freeze({ xtcPs: 10, energyPs: 10, logPs: 100, trrPs: 0 }) }),
  Object.freeze({ key: 'anneal', label: 'Simulated annealing', short: 'Anneal', dynamics: true, mdp: 'anneal.mdp', deffnm: 'anneal', on: false, posres: false, lengthPs: 1000,
    output: Object.freeze({ xtcPs: 10, energyPs: 1, logPs: 10, trrPs: 0 }) }),
  Object.freeze({ key: 'pull', label: 'Pulling', short: 'Pull', dynamics: true, mdp: 'pull.mdp', deffnm: 'pull', on: false, posres: false, lengthPs: 10000,
    output: Object.freeze({ xtcPs: 10, energyPs: 10, logPs: 100, trrPs: 0 }) })
]);

export const GX_STAGE = Object.freeze(Object.fromEntries(GX_STAGES.map(s => [s.key, s])));

/** The default annealing schedule, as the form writes it: time (ps) and temperature (K). */
export const DEFAULT_SCHEDULE = '0 300, 200 400, 600 400, 1000 300';

/**
 * The form's state with every default filled in. The rigid bonds follow the
 * force field, as the page's System view does: bonds to hydrogen for AMBER,
 * CHARMM and OPLS-AA, all bonds for GROMOS (parametrised that way), none for
 * Martini.
 *
 * @param {string} [forceField='amber'] - A key of FORCE_FIELDS.
 * @returns {object}
 */
export function defaultGxState(forceField = 'amber') {
  const ffId = FORCE_FIELDS[forceField] ? forceField : 'amber';
  const stages = {};
  for (const s of GX_STAGES) {
    stages[s.key] = {
      on: s.on, mdp: s.mdp, deffnm: s.deffnm, posres: s.posres,
      lengthPs: s.lengthPs || 0,
      output: { ...(s.output || {}) },
      velocities: 'auto'
    };
  }
  Object.assign(stages.em, { method: 'steep', emtol: 1000, emSteps: 50000 });
  stages.prod.ensemble = 'NPT';
  stages.anneal.schedule = DEFAULT_SCHEDULE;
  stages.anneal.annealType = 'single';
  stages.anneal.pressure = false;
  stages.pull.ensemble = 'NPT';
  stages.pull.pull = { mode: 'umbrella', group1: 'Protein', group2: 'LIG', geometry: 'distance', dim: 'Y Y Y', vec: '0 0 1', k: 1000, rate: 0.01, outputPs: 1 };
  return {
    forceField: ffId, system: 'protein', temperature: 300, pressure: 1.0,
    thermostat: 'v-rescale', barostat: 'c-rescale', couplingType: 'isotropic',
    tcGroups: 'Protein Non-Protein', constraints: FORCE_FIELDS[ffId].constraints, hmr: false, dtFs: null,
    stages, overrides: {}, index: null
  };
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const words = (s) => String(s == null ? '' : s).trim().split(/\s+/).filter(Boolean);
const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Read an annealing schedule: pairs of time (ps) and temperature (K),
 * separated by commas, semicolons or new lines; `0 300`, `0:300` or `0,300;`
 * all work.
 *
 * @param {string} text
 * @returns {{points:number[][], errors:string[]}}
 */
export function parseSchedule(text) {
  const errors = [];
  const points = [];
  const parts = String(text || '').split(/[;\n]+|,(?=\s*[-+.\d]+\s*[:\s]\s*[-+.\d])/).map(p => p.trim()).filter(Boolean);
  for (const part of parts) {
    const nums = part.split(/[\s:,]+/).filter(Boolean).map(Number);
    if (nums.length !== 2 || nums.some(n => !Number.isFinite(n))) {
      errors.push(`"${part}" is not a time and a temperature.`);
      continue;
    }
    points.push(nums);
  }
  for (let i = 1; i < points.length; i++) {
    if (points[i][0] <= points[i - 1][0]) {
      errors.push(`The times must increase: ${points[i][0]} ps comes after ${points[i - 1][0]} ps.`);
      break;
    }
  }
  return { points, errors };
}

/** Bytes in the most readable unit, 1000-based as `ls --si` prints them. */
export function formatBytes(bytes) {
  const b = Number(bytes);
  if (!Number.isFinite(b) || b <= 0) return '0 B';
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = b;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : Number(v.toPrecision(2))} ${units[i]}`;
}

/** A count with thousands separators: 50,000. */
export const formatCount = (n) => Number(n).toLocaleString('en-GB');

/* The canonical spelling of an option, for comparing and storing. */
const optKey = (name) => canonicalName(name) || String(name || '').trim();

/* An enum value as grompp compares it: case, dashes and underscores ignored. */
const norm = (v) => String(v == null ? '' : v).trim().toUpperCase().replace(/[-_\s]/g, '');
const yes = (v) => v === true || /^(yes|true|1)$/i.test(String(v == null ? '' : v).trim());

/**
 * A stage's length for people: "100 ns", or "no limit" for nsteps = -1.
 *
 * @param {{dynamics:boolean, lengthPs:number, unlimited?:boolean}} plan
 * @returns {string}
 */
export function stageLength(plan) {
  if (!plan.dynamics) return 'minimise';
  return plan.unlimited ? 'no limit' : formatDuration(plan.lengthPs);
}

/**
 * The barostat a plan's file uses, as the manual writes it ("C-rescale"),
 * or '' when the stage has none.
 *
 * @param {{barostat:string, barostatLabel?:string}} plan
 * @returns {string}
 */
export function barostatLabel(plan) {
  if (!plan.barostat || plan.barostat === 'none') return '';
  return plan.barostatLabel || (BAROSTATS[plan.barostat] ? BAROSTATS[plan.barostat].value : plan.barostat);
}

/* ------------------------------------------------------------------ *
 * The shell
 * ------------------------------------------------------------------ */

/**
 * One word of the job script. A name the shell reads as one word as it is
 * is written as it is; anything else (a space, a quote, a bracket) goes in
 * double quotes, with `"`, `\` and backquotes escaped. `$` is left alone, so
 * a variable such as `$HOME/topol.top` still expands.
 *
 * @param {string} word
 * @returns {string}
 */
export function shellWord(word) {
  const w = String(word == null ? '' : word);
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(w)) return w;
  return `"${w.replace(/[\\"`]/g, '\\$&')}"`;
}

/* ------------------------------------------------------------------ *
 * Options set by hand
 * ------------------------------------------------------------------ */

/**
 * Apply options set by hand to an .mdp text: replace the value where the
 * file sets the option (keeping the layout), remove it when the value is
 * null, and append options the file does not set under their own heading.
 *
 * @param {string} text
 * @param {Object<string, string|null|{value:string|null, comment?:string}>} overrides
 * @returns {{text:string, changed:Array<{name:string, value:string|null, previous:string|null}>}}
 */
export function applyOverrides(text, overrides = {}) {
  const names = Object.keys(overrides || {});
  if (!names.length) return { text, changed: [] };
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const trailing = lines.length && lines[lines.length - 1] === '';
  if (trailing) lines.pop();
  const parsed = parseMdp(lines.join('\n'));
  const byKey = new Map();
  for (const e of parsed.entries) {
    const k = normaliseName(optKey(e.key));
    if (!byKey.has(k)) byKey.set(k, e);
  }
  const changed = [];
  const remove = new Set();
  const added = [];
  for (const raw of names) {
    const spec = overrides[raw];
    const o = spec !== null && typeof spec === 'object' ? spec : { value: spec };
    const value = o.value === null || o.value === undefined ? null : String(o.value).trim();
    const name = optKey(raw);
    const hit = byKey.get(normaliseName(name));
    if (hit) {
      const idx = hit.line - 1;
      const rawLine = lines[idx];
      if (value === null || value === '') {
        remove.add(idx);
        changed.push({ name, value: null, previous: hit.value });
        continue;
      }
      const comment = o.comment !== undefined ? o.comment
        : (normaliseName(value) === normaliseName(hit.value) ? hit.comment : `set by you; the generator wrote ${hit.value}`);
      const eq = rawLine.indexOf('=');
      const left = rawLine.slice(0, eq).replace(/\s+$/, '');
      const semi = rawLine.indexOf(';');
      let line = `${left.padEnd(Math.max(eq, left.length + 1))}= ${value}`;
      if (comment) {
        const col = semi > 0 ? semi : line.length + 1;
        line = `${line.padEnd(Math.max(col, line.length + 1))}; ${comment}`;
      }
      lines[idx] = line.replace(/\s+$/, '');
      changed.push({ name, value, previous: hit.value });
    } else if (value !== null && value !== '') {
      const info = optionInfo(name);
      const dflt = info && !info.obsolete && info.default !== '' ? `GROMACS default: ${info.default}` : '';
      added.push({ name, value, comment: o.comment !== undefined ? o.comment : ['set by you', dflt].filter(Boolean).join('; ') });
      changed.push({ name, value, previous: null });
    }
  }
  let out = lines.filter((_, i) => !remove.has(i));
  if (added.length) {
    const width = Math.max(24, ...added.map(a => a.name.length));
    const vw = Math.min(28, Math.max(12, ...added.map(a => a.value.length)));
    out.push('', '; ---- Set by you ----');
    for (const a of added) {
      const left = `${a.name.padEnd(width)} = ${a.value}`;
      out.push(a.comment ? `${left.padEnd(width + 3 + vw)} ; ${a.comment}` : left);
    }
  }
  return { text: `${out.join('\n')}\n`, changed };
}

/**
 * Whether two values of an option mean the same to grompp.
 *
 * @param {string} name
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameMdpValue(name, a, b) {
  const x = String(a == null ? '' : a).trim();
  const y = String(b == null ? '' : b).trim();
  if (x === y) return true;
  const info = optionInfo(name);
  const kind = info && !info.obsolete ? info.kind : 'text';
  if (kind === 'boolean') {
    const t = (v) => ['yes', 'true', '1'].includes(v.toLowerCase());
    return t(x) === t(y);
  }
  if (kind === 'enum') return normaliseName(x) === normaliseName(y);
  const wx = words(x);
  const wy = words(y);
  if (wx.length !== wy.length) return false;
  return wx.every((w, i) => {
    const p = Number(w);
    const q = Number(wy[i]);
    if (Number.isFinite(p) && Number.isFinite(q)) return Math.abs(p - q) <= 1e-9 * Math.max(1, Math.abs(p), Math.abs(q));
    return kind === 'groups' || kind === 'group' ? w.toLowerCase() === wy[i].toLowerCase() : w === wy[i];
  });
}

/**
 * The options set by hand that turn `generated` into a file grompp reads the
 * same as `wanted`: every option `wanted` sets differently, and every option
 * only the generated file sets, back to its GROMACS default (or removed).
 *
 * @param {string} wanted - An .mdp text, e.g. a file someone already has.
 * @param {string} generated - The file the builder writes.
 * @returns {Object<string, string|null>}
 */
export function diffOverrides(wanted, generated) {
  const values = (text) => {
    const p = parseMdp(text);
    const m = new Map();
    for (const e of p.entries) {
      if (e.empty || e.duplicate) continue;
      m.set(optKey(e.key), e.value);
    }
    return m;
  };
  const w = values(wanted);
  const g = values(generated);
  const out = {};
  for (const [name, value] of w) {
    if (!g.has(name) || !sameMdpValue(name, value, g.get(name))) out[name] = value;
  }
  for (const [name, value] of g) {
    if (w.has(name)) continue;
    const info = optionInfo(name);
    if (!info || info.obsolete) { out[name] = null; continue; }
    if (info.default === '' || info.default === null) { out[name] = null; continue; }
    if (!sameMdpValue(name, info.default, value)) out[name] = info.default;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The plan
 * ------------------------------------------------------------------ */

/* Names make_ndx always makes when the system has them; anything else in
   tc-grps needs an index file. */
const DEFAULT_GROUP_NAMES = new Set(['SYSTEM', 'PROTEIN', 'PROTEIN-H', 'C-ALPHA', 'BACKBONE', 'MAINCHAIN',
  'MAINCHAIN+CB', 'MAINCHAIN+H', 'SIDECHAIN', 'SIDECHAIN-H', 'PROT-MASSES', 'NON-PROTEIN', 'WATER', 'SOL',
  'NON-WATER', 'ION', 'WATER_AND_IONS', 'OTHER', 'DNA', 'RNA', 'NA', 'CL', 'K', 'NA+', 'CL-']);

/* Options whose value is one or more index group names, as grompp reads
   them (readir.cpp do_index). The checker in src/core checks them all
   against an index when there is one; this module lists the names a file
   uses when there is none. */
const MULTI_GROUP_OPTIONS = ['tc-grps', 'comm-grps', 'energygrps', 'compressed-x-grps', 'acc-grps', 'freezegrps',
  'user1-grps', 'user2-grps', 'QMMM-grps', 'orire-fitgrp', 'energygrp-excl', 'energygrp-table'];
const SINGLE_GROUP_OPTION = /^(pull-group\d+-name|rot-group\d+|swap-group|split-group[01]|solvent-group|imd-group|density-guided-simulation-group)$/i;

/* Every group name a resolved file uses, with the option naming it. The
   checked settings hold every option grompp reads, module defaults included
   (density-guided-simulation-group = protein), so an option counts only
   while grompp looks its group up: pull, rotation and swap groups while that
   feature is on, a module's group while the module is active. */
function groupUses(settings) {
  const uses = [];
  const v = settings || {};
  const swapping = norm(v.swapcoords) !== '' && norm(v.swapcoords) !== 'NO';
  for (const [name, value] of Object.entries(v)) {
    if (value === null || value === undefined || value === '') continue;
    const multi = MULTI_GROUP_OPTIONS.some(o => o.toLowerCase() === name.toLowerCase());
    if (!multi && !SINGLE_GROUP_OPTION.test(name)) continue;
    // Pull groups count only while pulling is on; grompp reads them then.
    if (/^pull-/i.test(name) && !yes(v.pull)) continue;
    const m = /^pull-group(\d+)-name$/i.exec(name);
    if (m && Number(m[1]) > Number(v['pull-ngroups'] || 0)) continue;
    const r = /^rot-group(\d+)$/i.exec(name);
    if (r && (!yes(v.rotation) || Number(r[1]) >= Number(v['rot-ngroups'] || 0))) continue;
    if (/^(swap-group|split-group[01]|solvent-group)$/i.test(name) && !swapping) continue;
    if (/^density-guided-simulation-group$/i.test(name) && !yes(v['density-guided-simulation-active'])) continue;
    const list = multi ? words(value) : [String(value).trim()];
    for (const g of list) if (g) uses.push({ option: name, group: g });
  }
  return uses;
}

/* Why grompp warns, in a line for the job script. */
const WARN_REASON = {
  'gromos-twin-range': 'GROMOS topologies always draw one warning (the force field was fitted with a twin-range cut-off GROMACS no longer has); no .mdp setting avoids it.',
  'berendsen-t': 'the Berendsen thermostat you chose is deprecated.',
  'berendsen-p': 'the Berendsen barostat you chose is deprecated.'
};

function warnReason(issue) {
  if (WARN_REASON[issue.id]) return WARN_REASON[issue.id];
  if (/berendsen/i.test(issue.message)) {
    return /pcoupl|barostat|pressure/i.test(`${issue.option} ${issue.message}`)
      ? WARN_REASON['berendsen-p'] : WARN_REASON['berendsen-t'];
  }
  const first = String(issue.message).split(/(?<=\.)\s/)[0];
  return first.length > 150 ? `${first.slice(0, 147)}...` : first;
}

/* The time step the file will use, in ps. */
function effectiveDt(state, ff) {
  const cg = ff.resolution === 'coarse-grained';
  const given = num(state.dtFs, NaN);
  if (given > 0) return given / 1000;
  if (state.hmr && ff.hmr) return 0.004;
  if (!cg && state.constraints === 'none') return 0.001;
  return ff.dt;
}

/* The barostat key of BAROSTATS for a pcoupl value, 'none' for no. */
function barostatKey(pcoupl) {
  const n = norm(pcoupl);
  if (!n || n === 'NO') return 'none';
  const hit = Object.keys(BAROSTATS).find(k => norm(BAROSTATS[k].value) === n || norm(k) === n);
  return hit || String(pcoupl).trim();
}

/*
 * How far a pull coordinate may go before mdrun stops, in nm: 0.49 of the
 * box along the dimensions it uses, as max_pull_distance2 in
 * src/gromacs/pulling/pull.cpp works it out (mdrun stops once the distance
 * passes 0.98 of half that length). `box` holds the box vectors as rows.
 */
function pullLimitNm(box, geometry, dim, vec) {
  if (!Array.isArray(box) || box.length < 3) return null;
  const b = box.map(r => (Array.isArray(r) ? r.map(Number) : [0, 0, 0]));
  let max2 = Infinity;
  if (geometry === 'direction') {
    for (let m = 0; m < 3; m++) {
      if (!vec[m]) continue;
      let d2 = b[m][m] ** 2;
      for (let d = m + 1; d < 3; d++) d2 -= b[d][m] ** 2;
      max2 = Math.min(max2, d2);
    }
  } else {
    for (let m = 0; m < 3; m++) {
      if (!dim[m]) continue;
      let d2 = b[m][m] ** 2;
      for (let d = 0; d < m; d++) if (dim[d]) d2 += b[m][d] ** 2;
      max2 = Math.min(max2, d2);
    }
  }
  return Number.isFinite(max2) && max2 > 0 ? 0.49 * Math.sqrt(max2) : null;
}

/* Whether a box (vectors as rows) has off-diagonal elements: triclinic. */
function isTriclinic(box) {
  if (!Array.isArray(box) || box.length < 3) return false;
  return [[1, 0], [2, 0], [2, 1]].some(([i, j]) => Math.abs(Number((box[i] || [])[j]) || 0) > 1e-6);
}

/**
 * An atom near the centre of a group, for pull-groupN-pbcatom. grompp takes
 * a pull group's periodic images from a reference atom, the middle one by
 * number unless one is named, and stops when the group reaches further than
 * a quarter of the box from it ("a centrally placed atom should be chosen as
 * pbcatom", src/gromacs/gmxpreprocess/readpull.cpp).
 *
 * The centre is found through the periodic boundary: along each box vector,
 * the mean direction of the atoms' fractional positions taken as angles, so
 * a group split across the edge of the box (a protein, a ligand, a membrane
 * in a box that starts at its middle) has its centre inside it. Along a
 * direction the group fills (a membrane's plane) every atom is as central as
 * any other. Without a box, the plain centroid.
 *
 * @param {Array<{x:number, y:number, z:number}>} coords - The structure's atoms, in order (nm).
 * @param {number[]} members - The group's atom numbers, from 1.
 * @param {number[][]|null} [box] - Box vectors as rows (nm), as GROMACS writes them
 *   (a along x, b in the xy plane).
 * @returns {number} The number (from 1) of the atom nearest the centre; 0 for an empty group.
 */
export function centralAtom(coords, members, box = null) {
  const atoms = (members || []).filter(n => Number.isInteger(n) && n >= 1 && coords[n - 1]);
  if (!atoms.length) return 0;
  const b = Array.isArray(box) && box.length >= 3 ? box.map(r => (Array.isArray(r) ? r.map(Number) : [0, 0, 0])) : null;
  const periodic = b && b[0][0] > 0 && b[1][1] > 0 && b[2][2] > 0 &&
    Math.abs(b[0][1] || 0) < 1e-9 && Math.abs(b[0][2] || 0) < 1e-9 && Math.abs(b[1][2] || 0) < 1e-9;
  if (!periodic) {
    const c = [0, 0, 0];
    for (const n of atoms) { const a = coords[n - 1]; c[0] += a.x; c[1] += a.y; c[2] += a.z; }
    c.forEach((v, d) => { c[d] = v / atoms.length; });
    let best = atoms[0];
    let min = Infinity;
    for (const n of atoms) {
      const a = coords[n - 1];
      const d2 = (a.x - c[0]) ** 2 + (a.y - c[1]) ** 2 + (a.z - c[2]) ** 2;
      if (d2 < min) { min = d2; best = n; }
    }
    return best;
  }
  // Fractional coordinates along a, b and c.
  const frac = (a) => {
    const sc = a.z / b[2][2];
    const sb = (a.y - sc * b[2][1]) / b[1][1];
    const sa = (a.x - sb * b[1][0] - sc * b[2][0]) / b[0][0];
    return [sa, sb, sc];
  };
  const cos = [0, 0, 0];
  const sin = [0, 0, 0];
  const fr = atoms.map((n) => {
    const f = frac(coords[n - 1]);
    for (let d = 0; d < 3; d++) { cos[d] += Math.cos(2 * Math.PI * f[d]); sin[d] += Math.sin(2 * Math.PI * f[d]); }
    return f;
  });
  const centre = [0, 1, 2].map(d => Math.atan2(sin[d], cos[d]) / (2 * Math.PI));
  // How concentrated the group is along each vector: 1 for a point, 0 for
  // atoms spread evenly across the box. Offsets along a direction the group
  // fills count for little, so a membrane's atom is picked by its height.
  const weight = [0, 1, 2].map(d => Math.hypot(cos[d], sin[d]) / atoms.length);
  const length = b.map(r => Math.hypot(r[0], r[1], r[2]));
  let best = atoms[0];
  let min = Infinity;
  fr.forEach((f, i) => {
    let d2 = 0;
    for (let d = 0; d < 3; d++) {
      // The shortest periodic offset, in fractions of the box vector.
      const x = f[d] - centre[d];
      d2 += (weight[d] * (x - Math.round(x)) * length[d]) ** 2;
    }
    if (d2 < min) { min = d2; best = atoms[i]; }
  });
  return best;
}

/*
 * The steered-pulling check: with a rate, the reference moves rate x length,
 * and mdrun stops once the distance passes 0.49 of the box along the pulled
 * dimensions (pull.cpp, "is larger than 0.49 times the box size"). With the
 * structure loaded, the groups' distance at the start is known (`start`,
 * from pullStart), and the reference goes from there; with only its box,
 * the travel is compared with the limit; without either the page warns once
 * the travel exceeds what a 5 nm box allows.
 */
function pullTravel(plan, v, box, start) {
  const rate = Number(v['pull-coord1-rate']) || 0;
  if (!yes(v.pull) || !rate || plan.unlimited) return;
  const geometry = String(v['pull-coord1-geometry'] || 'distance').toLowerCase();
  if (!['distance', 'direction'].includes(geometry)) return;
  const travel = Math.abs(rate) * plan.lengthPs;
  const dim = words(v['pull-coord1-dim'] || 'Y Y Y').map(w => /^y/i.test(w));
  const vec = words(v['pull-coord1-vec'] || '0 0 0').map(Number);
  const limit = pullLimitNm(box, geometry, dim, vec);
  const fmt = (x) => Number(x.toPrecision(3));
  const moves = `The reference moves ${fmt(travel)} nm (${rate} nm/ps for ${formatDuration(plan.lengthPs)})`;
  const periodic = geometry === 'direction' ? ', or use pull-coord1-geometry = direction-periodic under All options' : '';
  const c = start && start.coords[0];
  if (c && c.checked && c.value !== null && Number.isFinite(c.limit)) {
    // Already too far at the start: checkMdp reports grompp stopping.
    if (c.tooFar) return;
    const end = c.value + rate * plan.lengthPs;
    const at = `from the ${fmt(Math.abs(c.value))} nm the groups start at in ${start.name || 'the structure'}`;
    const stop = (message) => {
      const issue = { severity: 'error', id: 'pull-box', option: 'pull-coord1-rate', line: null, message, url: mdpDocUrl('pull-coord1-rate'), source: 'mdrun',
        assumes: `the coordinates of ${start.name || 'the structure loaded under Index groups'}; the stage starts from what the stages before it leave` };
      plan.issues.push(issue);
      plan.mdrunStops.push(issue);
    };
    // A distance cannot be negative: mdrun stops once the reference passes 0
    // ("Pull reference distance ... needs to be non-negative", pull.cpp).
    if (geometry === 'distance' && end < 0) {
      stop(`${moves} ${at}, so it would pass 0 after ${formatDuration(c.value / Math.abs(rate))}, and mdrun stops there ` +
        '("Pull reference distance ... needs to be non-negative"). Shorten the stage or lower the rate, or pull along a vector ' +
        '(geometry direction), whose value may be negative.');
      return;
    }
    if (Math.abs(end) + 1e-9 < c.limit) return;
    stop(`${moves} ${at} to ${fmt(Math.abs(end))} nm, but mdrun stops once the distance between the groups passes ${fmt(c.limit)} nm, ` +
      `0.49 of this box along the pulled dimensions ("Distance between pull groups ... is larger than 0.49 times the box size"). ` +
      `Shorten the stage or lower the rate${periodic}.`);
    return;
  }
  if (limit !== null) {
    if (travel + 1e-9 < limit) return;
    const message = `${moves}, but mdrun stops once the distance between the groups passes ${fmt(limit)} nm, 0.49 of this box ` +
      `along the pulled dimensions ("Distance between pull groups ... is larger than 0.49 times the box size"). ` +
      `Shorten the stage or lower the rate${periodic}.`;
    const issue = { severity: 'error', id: 'pull-box', option: 'pull-coord1-rate', line: null, message, url: mdpDocUrl('pull-coord1-rate'), source: 'mdrun' };
    plan.issues.push(issue);
    plan.mdrunStops.push(issue);
    return;
  }
  if (travel <= 0.49 * 5) return;
  plan.pullWarning = `${moves}. With geometry ${geometry}, mdrun stops once the distance between the groups passes 0.49 of the box ` +
    `along the pulled dimensions (2.45 nm in a 5 nm box, 4.9 nm in a 10 nm one), counted from where it starts: ` +
    `shorten the stage or lower the rate${periodic}. Load the structure under Index groups for a check against its box.`;
  plan.warnings.push(plan.pullWarning);
}

/*
 * Group names a stage uses that grompp cannot find. With an index built on
 * the page, checkMdp looks every group grompp would look up (pull, rotation
 * and module groups included, while they are on) in it, through
 * context.indexGroups, and reports the missing ones as grompp errors. With no
 * index at all, a name that is not one of the groups GROMACS makes by itself
 * needs one, unless the system has a residue of that name (GROMACS makes a
 * group for each residue name it does not class as protein, DNA, RNA or water).
 */
function groupChecks(plan, v, idx) {
  if (idx.names || idx.given) return;
  const names = [];
  for (const u of groupUses(v)) {
    if (!DEFAULT_GROUP_NAMES.has(u.group.toUpperCase()) && !names.includes(u.group)) names.push(u.group);
  }
  plan.needsIndex = names;
}

/* The message for names that need an index file nobody gave. */
function needsIndexMessage(names, lost) {
  const list = names.join(', ');
  if (lost && lost.name) {
    return `${list} ${names.length === 1 ? 'is a group' : 'are groups'} of ${lost.name}, which was built on the page from ` +
      `${lost.file || 'a structure'} on an earlier visit. The page does not keep the structure, so ${lost.name} is not in the zip, ` +
      `while submit.sh still passes -n ${lost.name}: load ${lost.file || 'the structure'} again under Index groups to rebuild it, ` +
      `or put the ${lost.name} from an earlier download next to the run files.`;
  }
  return `${list} ${names.length === 1 ? 'is not a group' : 'are not groups'} GROMACS makes by itself: grompp stops ` +
    `("Group ... referenced in the .mdp file was not found") unless an index file defines ${names.length === 1 ? 'it' : 'them'} ` +
    '(build one under Index groups, or give yours under Job) or the system has a residue of that name.';
}

/**
 * Turn the form's state into one plan per enabled stage.
 *
 * Conjugate-gradient minimisation gets a steepest-descent stage before it
 * (key `em-steep`), which relieves the clashes of a freshly solvated system
 * (the manual: CG "is slower than steepest descent in the early stages"),
 * and runs with flexible water (define = -DFLEXIBLE): GROMACS's cg cannot
 * use SETTLE, and with rigid water mdrun stops, even after steep, with "The
 * coordinates could not be constrained. Minimizer 'cg' can not handle
 * constraint failures" (src/gromacs/mdrun/minimize.cpp).
 *
 * Each plan's `nsteps`, `dt`, `lengthPs` (Infinity with `unlimited` for
 * nsteps = -1), `barostat` and `restrained` describe the final file, after
 * the options set by hand.
 *
 * @param {object} state - As {@link defaultGxState} returns it, edited. It may
 *   also say `hasIndexFile` (an index is named under Job), `indexLost`
 *   (`{name, file}`: an index built on an earlier visit, no longer on the
 *   page), `box` (box vectors as rows, nm, from a loaded structure) and
 *   `structure` (the loaded structure with its index groups, as checkMdp's
 *   context.structure takes it: each plan then has `pullStart`, where the
 *   pull groups start, and the pull checks grompp makes on it).
 * @returns {{stages:object[], warnings:string[], dt:number, forceField:object, hmr:boolean,
 *   constraints:string, tcGroups:string[], system:string, needsIndex:string[], indexWarning:string|null}}
 *   `needsIndex`: group names the files use that no index defines; `indexWarning`
 *   says so (it is in `warnings` too).
 */
export function resolveWorkflow(state) {
  // A state that leaves out the rigid bonds gets the force field's.
  const s = { ...defaultGxState(state && state.forceField), ...(state || {}) };
  const ff = FORCE_FIELDS[s.forceField] || FORCE_FIELDS.amber;
  const cg = ff.resolution === 'coarse-grained';
  const system = SYSTEM_TYPES[s.system] ? s.system : 'protein';
  const hmr = !!s.hmr && !!ff.hmr;
  const dt = effectiveDt(s, ff);
  const constraints = cg ? 'none' : (['h-bonds', 'all-bonds', 'none'].includes(s.constraints) ? s.constraints : ff.constraints);
  const tcGroups = words(s.tcGroups).length ? words(s.tcGroups) : SYSTEM_TYPES[system].tcGroups.slice();
  const warnings = [];
  const index = s.index && Array.isArray(s.index.groups) ? s.index : null;
  const indexNames = index ? index.groups : null;
  const lost = !indexNames && s.indexLost && s.indexLost.name ? s.indexLost : null;
  const idx = { names: indexNames, given: !!s.hasIndexFile && !lost };
  const box = Array.isArray(s.box) ? s.box : null;
  // The loaded structure with the index built from it, for the pull checks
  // grompp makes on the coordinates it reads (checkMdp's context.structure).
  const structure = s.structure && Array.isArray(s.structure.atoms) && s.structure.atoms.length && Array.isArray(s.structure.groups)
    ? s.structure : null;

  if (s.hmr && !ff.hmr) warnings.push(`Hydrogen mass repartitioning is off: ${ff.label} has no hydrogens to repartition.`);
  if (hmr && constraints === 'none') {
    warnings.push('Hydrogen mass repartitioning allows 4 fs only with the bonds to hydrogen constrained; choose constraints = h-bonds.');
  }
  if (!cg && constraints === 'none' && dt > 0.001) {
    warnings.push(`With flexible bonds the fastest vibrations (bonds to hydrogen, about 10 fs) need a time step of 1 fs or less; ${dt * 1000} fs will be unstable.`);
  }

  const stages = [];
  let prevDynamics = false;

  /* One stage: generate, apply the options set by hand, check. */
  const planStage = (def, st, coreStage) => {
    const plan = {
      key: def.key, label: def.label, short: def.short, dynamics: def.dynamics,
      file: String(st.mdp || def.mdp).trim() || def.mdp,
      deffnm: String(st.deffnm || def.deffnm).trim() || def.deffnm,
      posres: !!st.posres,
      warnings: []
    };
    // Velocities: new for the first dynamics, carried over after that,
    // unless the stage says otherwise.
    let genVel = false;
    let continuation = false;
    if (def.dynamics) {
      const v = st.velocities || 'auto';
      genVel = v === 'new' || (v === 'auto' && !prevDynamics);
      continuation = !genVel;
      plan.velocities = v;
      plan.velocitiesAuto = v === 'auto';
    }
    plan.genVel = genVel;
    plan.continuation = continuation;
    plan.fromPrevious = def.dynamics && continuation && prevDynamics;

    // Barostat: equilibration swaps Parrinello-Rahman for C-rescale, unless
    // the box must be coupled anisotropically (C-rescale cannot); a Berendsen
    // choice is kept.
    let barostat = 'none';
    const chosen = BAROSTATS[s.barostat] ? s.barostat : 'c-rescale';
    if (def.key === 'npt') {
      barostat = chosen === 'parrinello-rahman' && s.couplingType !== 'anisotropic' ? 'c-rescale' : chosen;
      if (barostat !== chosen) plan.barostatNote = 'C-rescale while equilibrating: Parrinello-Rahman oscillates when the box is far from equilibrium.';
    } else if (def.key === 'prod' || def.key === 'pull') {
      barostat = st.ensemble === 'NVT' ? 'none' : chosen;
    } else if (def.key === 'anneal') {
      barostat = st.pressure ? chosen : 'none';
    }
    plan.barostat = barostat;

    const lengthPs = Math.max(0, num(st.lengthPs, def.lengthPs || 0));
    const settings = {
      stage: coreStage,
      forceField: ff.id,
      system,
      temperature: num(s.temperature, 300),
      pressure: num(s.pressure, 1),
      thermostat: THERMOSTATS[s.thermostat] ? s.thermostat : 'v-rescale',
      barostat,
      couplingType: ['isotropic', 'semiisotropic', 'anisotropic'].includes(s.couplingType) ? s.couplingType : SYSTEM_TYPES[system].pcoupltype,
      tcGroups,
      hmr,
      dt: def.dynamics ? dt : null,
      lengthNs: lengthPs / 1000,
      posres: plan.posres,
      genVel,
      continuation
    };
    if (def.dynamics) {
      const o = st.output || {};
      settings.output = {
        xtcPs: Math.max(0, num(o.xtcPs, 0)), energyPs: Math.max(0, num(o.energyPs, 0)),
        logPs: Math.max(0, num(o.logPs, 0)), trrPs: Math.max(0, num(o.trrPs, 0)), xtcGroups: o.xtcGroups || ''
      };
    } else {
      settings.emtol = Math.max(0, num(st.emtol, coreStage === 'em-cg' ? 100 : 1000));
      settings.emSteps = Math.max(0, Math.round(num(st.emSteps, 50000)));
    }
    if (def.key === 'anneal') {
      const sched = parseSchedule(st.schedule || DEFAULT_SCHEDULE);
      plan.warnings.push(...sched.errors);
      settings.anneal = { type: st.annealType === 'periodic' ? 'periodic' : 'single', points: sched.points.length >= 2 ? sched.points : parseSchedule(DEFAULT_SCHEDULE).points, barostat };
    }
    if (def.key === 'pull') {
      const p = st.pull || {};
      settings.pull = {
        mode: p.mode === 'steered' ? 'steered' : 'umbrella',
        group1: String(p.group1 || '').trim() || 'Protein',
        group2: String(p.group2 || '').trim() || 'LIG',
        geometry: p.geometry === 'direction' ? 'direction' : 'distance',
        dim: String(p.dim || 'Y Y Y').trim(),
        vec: String(p.vec || '0 0 1').trim(),
        k: num(p.k, 1000),
        rateNmPerPs: num(p.rate, 0.01),
        outputPs: num(p.outputPs, 1) > 0 ? num(p.outputPs, 1) : 1,
        // Atoms near the centre of each group (from 1; 0 for none), which the
        // page finds in a loaded structure: grompp takes a group's periodic
        // images from its reference atom, and stops when a group reaches
        // further than a quarter of the box from it (readpull.cpp).
        pbcatom1: Math.max(0, Math.round(num(p.pbcatom1, 0))),
        pbcatom2: Math.max(0, Math.round(num(p.pbcatom2, 0)))
      };
      plan.pullGroups = [settings.pull.group1, settings.pull.group2];
      plan.pbcAtoms = [settings.pull.pbcatom1, settings.pull.pbcatom2];
    }

    const gen = generateMdp(settings);
    plan.settings = gen.settings;
    plan.nsteps = gen.settings.nsteps;
    plan.dt = def.dynamics ? gen.settings.dt : null;
    plan.lengthPs = def.dynamics ? plan.nsteps * plan.dt : 0;
    plan.warnings.push(...gen.warnings);

    // The file names the user chose, in the header line.
    let text = gen.text.replace(/^(; [^\n]*?: )[^\s:]+\.mdp$/m, (all, head) => `${head}${plan.file}`);

    // What the shared choices change beyond what generateMdp asks about.
    const auto = {};
    // GROMACS's conjugate gradient cannot use constraints, SETTLE water
    // included (reference manual, energy minimisation: "If water is present
    // it must be of a flexible model ... define = -DFLEXIBLE"); with rigid
    // water mdrun stops with "The coordinates could not be constrained".
    // The water models of the GROMACS force fields switch with FLEXIBLE.
    if (coreStage === 'em-cg' && !cg) {
      const flexible = 'flexible water: conjugate gradient cannot use SETTLE';
      const define = String(parseMdp(text).values.define || '').trim();
      if (!define) {
        text = text.replace(/^(integrator\s*=[^\n]*)$/m, (line) => `${line}\n${'define'.padEnd(25)}= ${'-DFLEXIBLE'.padEnd(16)}; ${flexible}`);
      } else if (!/(^|\s)-DFLEXIBLE(\s|=|$)/.test(define)) {
        auto.define = { value: `${define} -DFLEXIBLE`, comment: `${plan.posres ? 'position restraints; ' : ''}${flexible}` };
      }
    }
    // Rigid bonds other than the force field's: the constraints line, and
    // the dt and HMR lines that give them as the reason for the time step,
    // say what the file does.
    const otherBonds = def.dynamics && !cg && constraints !== ff.constraints;
    const rigid = { 'h-bonds': 'bonds to hydrogen are constrained', 'all-bonds': 'all bonds are constrained' }[constraints];
    const generated = otherBonds ? parseMdp(text).values : {};
    if (otherBonds) {
      auto.constraints = {
        value: constraints,
        comment: constraints === 'all-bonds' ? 'every bond is rigid (chosen under System)'
          : constraints === 'h-bonds' ? 'only the bonds to hydrogen are rigid (chosen under System)'
            : 'flexible bonds: the time step must be 1 fs or less (chosen under System)'
      };
    }
    if (def.dynamics && !cg && num(s.dtFs, NaN) > 0) {
      auto.dt = { value: String(plan.dt), comment: `${Number((plan.dt * 1000).toPrecision(6))} fs, chosen under System` };
    } else if (def.dynamics && !cg && !hmr && constraints === 'none') {
      auto.dt = { value: String(plan.dt), comment: '1 fs, as flexible bonds need' };
    } else if (otherBonds && generated.dt !== undefined) {
      auto.dt = {
        value: generated.dt,
        comment: !rigid ? '4 fs with flexible bonds is unstable: constrain the bonds to hydrogen under System'
          : hmr ? `4 fs, possible because hydrogens are 3x heavier (mass-repartition-factor) and ${rigid}`
            : `${Number((plan.dt * 1000).toPrecision(6))} fs, possible because ${rigid}`
      };
    }
    if (otherBonds && hmr && rigid && generated['mass-repartition-factor'] !== undefined) {
      auto['mass-repartition-factor'] = {
        value: generated['mass-repartition-factor'],
        comment: 'hydrogens become 3x heavier, the mass taken from their bonded atom (GROMACS manual: a factor of 3 ' +
          `with the bonds to hydrogen constrained allows 4 fs${constraints === 'all-bonds' ? '; here all bonds are' : ''})`
      };
    }
    const generatedLength = def.dynamics ? formatDuration(plan.lengthPs) : '';
    const manual = (s.overrides || {})[def.key] || {};
    const overrides = { ...auto, ...manual };
    const applied = applyOverrides(text, overrides);
    plan.generatedText = text;
    plan.text = applied.text;
    plan.overridden = Object.keys(manual).map(optKey);
    plan.changed = applied.changed;

    const context = {
      posres: plan.posres,
      forceField: ff.id,
      system: cg ? 'coarse-grained' : 'all-atom'
    };
    if (indexNames) context.indexGroups = indexNames;
    if (structure) context.structure = structure;
    const check = checkMdp(plan.text, { context });
    plan.issues = check.issues;
    // Where the pull groups start, from the loaded structure. grompp reads
    // the coordinates the stage before leaves, which equilibration has
    // moved a little from these: the checks say so.
    plan.pullStart = null;
    if (structure && yes(check.settings.pull)) {
      const start = pullStart(check.settings, structure, { equalMasses: cg });
      if (start) plan.pullStart = { ...start, name: structure.name || '' };
      const prev = stages[stages.length - 1];
      if (prev) {
        for (const i of plan.issues) {
          if (i.assumes && /^pull-(distance|pbcatom)$/.test(i.id)) i.assumes += `; this stage starts from ${prev.deffnm}.gro, which the stages before it move a little from these`;
        }
      }
    }
    plan.grompp = check.grompp;
    plan.checked = check.settings;
    const gw = check.issues.filter(i => i.source === 'grompp' && i.severity === 'warning');
    plan.maxwarn = gw.length;
    plan.maxwarnReasons = gw.map(warnReason);
    // grompp's errors; mdrun's are counted apart, in mdrunStops.
    plan.errors = check.issues.filter(i => i.severity === 'error' && i.source !== 'mdrun');
    plan.mdrunStops = check.issues.filter(i => i.source === 'mdrun' && i.severity === 'error');

    // Read back from the final file: what grompp will run.
    const v = plan.checked;
    const steps = Number(v.nsteps);
    if (Number.isFinite(steps)) plan.nsteps = steps;
    if (def.dynamics) {
      const dtFinal = Number(v.dt);
      if (dtFinal > 0) plan.dt = dtFinal;
      plan.unlimited = plan.nsteps < 0;
      plan.lengthPs = plan.unlimited ? Infinity : plan.nsteps * plan.dt;
      const finalLength = plan.unlimited ? 'no limit' : formatDuration(plan.lengthPs);
      if (finalLength !== generatedLength) {
        // The header's "| 100 ns" follows nsteps and dt set by hand.
        const lines = plan.text.split('\n');
        const at = lines.findIndex((l, i) => i < 4 && /^; .*\| /.test(l) && l.endsWith(`| ${generatedLength}`));
        if (at >= 0) {
          lines[at] = `${lines[at].slice(0, lines[at].length - generatedLength.length)}${finalLength}`;
          plan.text = lines.join('\n');
        }
      }
    }
    plan.barostat = def.dynamics ? barostatKey(v.pcoupl) : 'none';
    if (plan.barostat !== 'none' && !BAROSTATS[plan.barostat]) plan.barostatLabel = String(v.pcoupl).trim();
    if (plan.barostatNote && plan.barostat !== 'c-rescale') delete plan.barostatNote;
    // grompp needs -r whenever the topology's restraints are on, and a
    // restraint is switched on with a -D macro in define (-DPOSRES, but also
    // -DPOSRES_CA or a macro of the user's own), so any -D asks for it but
    // -DFLEXIBLE, which only makes water flexible; an -r grompp does not
    // need is read by nothing.
    const define = String(v.define || '');
    plan.restrained = plan.posres || /-DPOSRES/i.test(define);
    plan.needsRef = plan.posres || words(define).some(w => /^-D\S/.test(w) && !/^-DFLEXIBLE(=|$)/.test(w));

    groupChecks(plan, v, idx);
    if (def.key === 'pull') pullTravel(plan, v, box, plan.pullStart);
    // grompp's note about C=O bonds at 4 fs needs such bonds, which a liquid
    // of water and ions does not have: for that system type it depends on
    // the topology, so it is not counted.
    if (system === 'solution') {
      const conditional = plan.issues.filter(i => i.id === 'bond-period' && i.severity === 'note');
      if (conditional.length) {
        plan.conditionalNotes = conditional;
        plan.grompp = { ...plan.grompp, notes: Math.max(0, plan.grompp.notes - conditional.length) };
      }
    }

    if (def.key === 'prod' && plan.posres) plan.warnings.push('Production runs with position restraints: they are usually released for production.');
    if (plan.nsteps === 0 && def.dynamics) plan.warnings.push(`${def.label} has no steps.`);
    return plan;
  };

  for (const def of GX_STAGES) {
    const st = { ...defaultGxState().stages[def.key], ...((s.stages || {})[def.key] || {}) };
    if (!st.on) continue;
    let coreStage = def.key;
    if (def.key === 'em') {
      coreStage = st.method === 'cg' ? 'em-cg' : 'em';
      if (coreStage === 'em-cg') {
        const file = String(st.mdp || def.mdp).trim() || def.mdp;
        const deffnm = String(st.deffnm || def.deffnm).trim() || def.deffnm;
        const pre = {
          ...def, key: 'em-steep', label: 'Energy minimisation, steepest descent first', short: 'EM steep',
          mdp: file.replace(/(\.mdp)?$/i, '-steep.mdp'), deffnm: `${deffnm}-steep`
        };
        const plan = planStage(pre, { ...st, mdp: pre.mdp, deffnm: pre.deffnm, method: 'steep', emtol: 1000 }, 'em');
        plan.before = 'em';
        stages.push(plan);
      }
    }
    const plan = planStage(def, st, coreStage);
    if (coreStage === 'em-cg') {
      plan.afterSteep = true;
      if (num(st.emtol, 1000) >= 1000) {
        plan.warnings.push(`Conjugate gradient stops below ${num(st.emtol, 1000)} kJ/mol/nm, as the steepest descent before it does, so it has nothing left to do: set a lower force (100, for example).`);
      }
    }
    stages.push(plan);
    prevDynamics = prevDynamics || def.dynamics;
  }

  // Names that need an index file, across the stages.
  const needsIndex = [];
  for (const p of stages) for (const n of p.needsIndex || []) if (!needsIndex.includes(n)) needsIndex.push(n);
  for (const p of stages) {
    if (p.needsIndex && p.needsIndex.length) p.needsIndexMessage = needsIndexMessage(p.needsIndex, lost);
  }
  let indexWarning = needsIndex.length ? needsIndexMessage(needsIndex, lost) : null;
  if (lost && !indexWarning) {
    indexWarning = `${lost.name} was built on the page from ${lost.file || 'a structure'} on an earlier visit, and the page does not keep ` +
      `the structure, so it is not in the zip while submit.sh still passes -n ${lost.name}: load ${lost.file || 'the structure'} ` +
      `again under Index groups, or put the ${lost.name} from an earlier download next to the run files.`;
  }
  if (indexWarning) warnings.push(indexWarning);
  if (s.couplingType === 'anisotropic' && isTriclinic(box) && stages.some(p => p.barostat !== 'none')) {
    warnings.push('Anisotropic pressure coupling keeps the off-diagonal compressibilities at 0, and the structure loaded under Index groups ' +
      'has a triclinic box: as the box shrinks it becomes too skewed and mdrun stops ("Triclinic box is too skewed"). ' +
      'Use a rectangular box (editconf -bt cubic, or -bt triclinic with its default right angles) or another box scaling.');
  }

  if (!stages.length) warnings.push('No stage is switched on.');
  return { stages, warnings, dt, hmr, constraints, tcGroups, forceField: ff, system, needsIndex, indexWarning };
}

/* ------------------------------------------------------------------ *
 * mdrun on GPUs
 * ------------------------------------------------------------------ */

/**
 * What a GROMACS executable's name says about its build, by the names the
 * GROMACS installation gives them: a `_mpi` suffix is the library-MPI build
 * (no thread-MPI, so no -ntmpi; ranks come from srun or mpirun), a `_d`
 * suffix double precision, which has no GPU support at all (CMake stops a
 * double-precision CUDA, SYCL or OpenCL build).
 *
 * @param {string} name - As typed, e.g. 'gmx', 'gmx_mpi_d' or a full path.
 * @returns {{name:string, mpi:boolean, double:boolean}}
 */
export function gmxBuild(name) {
  const full = String(name || '').trim() || 'gmx';
  const base = full.split('/').pop();
  return { name: full, mpi: /_mpi(_|$)/i.test(base), double: /_d(_|$)/i.test(base) };
}

/* Integrators mdrun counts as dynamics (EI_DYNAMICS in md_enums.h). */
const DYNAMICS = new Set(['MD', 'MDVV', 'MDVVAVEK', 'SD', 'BD']);
const PME_COULOMB = new Set(['PME', 'PMESWITCH', 'PMEUSER', 'PMEUSERSWITCH', 'P3MAD']);

/* "a, b and c" */
const listText = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/* Split a flag string into [flag, value] pairs, e.g. ['-nb', 'gpu']. */
function flagPairs(flags) {
  const t = String(flags || '').trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i + 1] !== undefined && !/^-/.test(t[i + 1])) { out.push([t[i], t[i + 1]]); i++; } else out.push([t[i]]);
  }
  return out;
}

/**
 * The GPU flags one stage's mdrun can take, out of those chosen for the job,
 * and why the others are left out. The reasons are GROMACS 2025's own checks,
 * which stop mdrun at start-up when a flag asks for what they refuse:
 *
 * - `-pme gpu` needs a dynamical integrator, PME electrostatics, no LJ-PME
 *   and pme-order = 4 (pme_gpu_supports_input); `-npme` goes with it, since
 *   a separate PME rank means nothing without PME.
 * - `-bonded gpu` needs a dynamical integrator, no multiple time stepping
 *   and at most one energy group (inputSupportsListedForcesGpu).
 * - `-update gpu` needs integrator = md and none of Nose-Hoover, MTTK,
 *   acceleration, box deformation, frozen atoms, constraint pulling, SHAKE,
 *   Ewald surface correction, multiple time stepping or virtual sites
 *   (decideWhetherToUseGpuForUpdate).
 *
 * @param {object} plan - One of `resolveWorkflow(...).stages`.
 * @param {string} flags - The job's flags, e.g. ' -nb gpu -pme gpu -ntmpi 1'.
 * @param {{virtualSites?:boolean, water?:string}} [topology] - Whether the
 *   topology has virtual sites (a TIP4P or TIP5P water), and the water's name.
 * @returns {{flags:string, dropped:Array<{flag:string, reason:string}>}}
 */
export function stageGpuFlags(plan, flags, topology = {}) {
  const v = plan.checked || {};
  const integrator = norm(v.integrator || (plan.dynamics ? 'md' : 'steep'));
  const dynamics = DYNAMICS.has(integrator);
  const reasons = { pme: null, bonded: null, update: null };
  if (!dynamics) {
    const why = 'mdrun computes PME, bonded forces and the update on the GPU only in dynamics, not in minimisation';
    reasons.pme = why; reasons.bonded = why; reasons.update = why;
  } else {
    const coulomb = norm(v.coulombtype || 'PME');
    if (!PME_COULOMB.has(coulomb)) reasons.pme = `PME on the GPU needs PME electrostatics, and the file has coulombtype = ${v.coulombtype}`;
    else if (norm(v.vdwtype) === 'PME') reasons.pme = 'PME on the GPU does not do Lennard-Jones PME (vdwtype = PME)';
    else if (v['pme-order'] !== undefined && Number(v['pme-order']) !== 4) reasons.pme = `PME on the GPU takes only pme-order = 4, and the file has ${v['pme-order']}`;

    if (yes(v.mts)) reasons.bonded = 'mdrun computes bonded forces on the GPU only without multiple time stepping (mts = yes)';
    else if (words(v.energygrps).length > 1) reasons.bonded = 'mdrun computes bonded forces on the GPU only with a single energy group, and the file sets energygrps';

    const u = [];
    if (integrator !== 'MD') u.push(`integrator = ${v.integrator} (the GPU update takes only md)`);
    if (norm(v.tcoupl) === 'NOSEHOOVER') u.push('Nose-Hoover temperature coupling');
    if (norm(v.pcoupl) === 'MTTK') u.push('MTTK pressure coupling');
    if (words(v.freezegrps).length) u.push('frozen atoms (freezegrps)');
    if ((Number(v['cos-acceleration']) || 0) !== 0 || words(v['acc-grps']).length) u.push('acceleration');
    if (words(v.deform).some(x => Number(x) !== 0)) u.push('box deformation (deform)');
    if (PME_COULOMB.has(norm(v.coulombtype)) || norm(v.coulombtype) === 'EWALD') {
      if ((Number(v['epsilon-surface']) || 0) !== 0) u.push('Ewald surface correction (epsilon-surface)');
    }
    if (yes(v.pull) && Object.entries(v).some(([k, x]) => /^pull-coord\d+-type$/i.test(k) && norm(x) === 'CONSTRAINT')) u.push('constraint pulling');
    if (norm(v['constraint-algorithm']) === 'SHAKE' && norm(v.constraints) !== 'NONE' && v.constraints) u.push('SHAKE constraints');
    if (yes(v.mts)) u.push('multiple time stepping');
    if (topology.virtualSites) u.push(`virtual sites (the ${topology.water || 'water'} in the topology header has one)`);
    if (u.length) reasons.update = `mdrun cannot run the update on the GPU with ${listText(u)}`;
  }
  const kept = [];
  const dropped = [];
  const pmeOff = !!reasons.pme;
  for (const pair of flagPairs(flags)) {
    const [flag, value] = pair;
    const text = pair.join(' ');
    const gpu = String(value || '').toLowerCase() === 'gpu';
    let why = null;
    if (flag === '-pme' && gpu) why = reasons.pme;
    else if (flag === '-npme' && pmeOff) why = reasons.pme;
    else if (flag === '-bonded' && gpu) why = reasons.bonded;
    else if (flag === '-update' && gpu) why = reasons.update;
    if (why) dropped.push({ flag: text, reason: why });
    else kept.push(text);
  }
  return { flags: kept.length ? ` ${kept.join(' ')}` : '', dropped };
}

/**
 * The mdrun flags for a job's ranks and GPUs, and what the page should say
 * about them (plain text; code between backquotes).
 *
 * - A thread-MPI build (plain `gmx`, `gmx_d`) always gets -ntmpi, one rank
 *   unless a number is typed, with or without GPUs. Given -ntomp alone,
 *   thread-MPI mdrun starts as many ranks of that many threads as the node
 *   has cores it can see (get_tmpi_omp_thread_division, resourcedivision.cpp):
 *   where the job has no cpuset of its own that is every core of the node,
 *   beyond the CPUs the job was given, and a small box then has no domain
 *   decomposition for them and mdrun stops. With a GPU in use (one the node
 *   shows, even with none asked for) it stops instead with "setting the
 *   number of OpenMP threads without specifying the number of ranks can
 *   lead to conflicting demands" whenever PME is not on the GPU. -nt, which
 *   the manual gives for running on part of a node, does not help: mdrun
 *   takes OMP_NUM_THREADS, which the job sets, as -ntomp, so -nt alone
 *   stops the same way, and left to split -nt itself mdrun stops on counts
 *   with a large prime factor ("contains a large prime factor").
 * - An MPI build (`gmx_mpi`) rejects -ntmpi; its ranks come from the
 *   launcher, one per node as the job header asks.
 * - GPU flags only with GPUs, and not with a double-precision build, which
 *   has no GPU support.
 * - PME on the GPU with more than one rank needs -npme (decidegpuusage.cpp):
 *   one PME rank.
 *
 * @param {object} o
 * @param {number} o.gpus - GPUs per node.
 * @param {boolean} [o.nb] - `-nb gpu` ticked.
 * @param {boolean} [o.pme]
 * @param {boolean} [o.bonded]
 * @param {boolean} [o.update]
 * @param {string|number} [o.ntmpi] - Thread-MPI ranks as typed; '' for automatic.
 * @param {string} [o.gmx='gmx'] - The executable.
 * @param {number} [o.nodes=1]
 * @param {string} [o.constraints] - `resolveWorkflow(...).constraints`.
 * @param {string} [o.system] - `resolveWorkflow(...).system`.
 * @returns {{flags:string, ntmpi:number, ranks:number, autoNtmpi:boolean, warnings:string[]}}
 */
export function gromacsMdrunFlags(o = {}) {
  const build = gmxBuild(o.gmx);
  const nodes = Math.max(1, parseInt(o.nodes, 10) || 1);
  const gpus = Math.max(0, parseInt(o.gpus, 10) || 0);
  const warnings = [];

  const typed = String(o.ntmpi == null ? '' : o.ntmpi).trim();
  let ntmpi = 0;
  if (typed) {
    const n = Number(typed);
    if (Number.isInteger(n) && n > 0) ntmpi = n;
    else warnings.push(`\`-ntmpi ${typed}\` is not a number of ranks, so it is left out.`);
  }
  let autoNtmpi = false;
  if (build.mpi) {
    if (ntmpi) {
      warnings.push(`\`${build.name}\` is an MPI build, which has no thread-MPI: mdrun stops on \`-ntmpi\` ("Setting the number of ` +
        'thread-MPI ranks is only supported with thread-MPI"), so it is left out. An MPI build takes its ranks from the launcher ' +
        '(srun or mpirun), one per node as the job asks.');
    }
    ntmpi = 0;
  } else if (!ntmpi) {
    ntmpi = 1;
    autoNtmpi = true;
  }
  const ranks = build.mpi ? nodes : ntmpi;
  const rankFlags = ntmpi ? ` -ntmpi ${ntmpi}` : '';

  // Without GPUs, the ranks and -nb cpu: the thread-MPI build's -ntmpi keeps
  // mdrun to the CPUs the job was given, and -nb cpu keeps it off a GPU the
  // node shows but the job did not ask for (mdrun would otherwise take it).
  if (!gpus || build.double) {
    if (gpus) {
      warnings.push(`\`${build.name}\` is a double-precision build, and GROMACS has no GPU support in double precision: ` +
        'the GPU flags are left out. Use the mixed-precision `gmx` (or `gmx_mpi`) on a GPU node, or set GPUs per node to 0.');
    }
    return { flags: ` -nb cpu${rankFlags}`, ntmpi, ranks, autoNtmpi, warnings };
  }
  const flags = [];
  if (o.nb) flags.push('-nb gpu');
  if (o.pme) flags.push('-pme gpu');
  if (o.bonded) flags.push('-bonded gpu');
  if (o.update) flags.push('-update gpu');
  if (ntmpi) flags.push(`-ntmpi ${ntmpi}`);

  if (o.bonded && !o.nb) {
    warnings.push('`-bonded gpu` requires the short-range non-bonded task on the GPU too. Enable `-nb gpu`.');
  }
  // inputSupportsListedForcesGpu: "None of the bonded types are implemented
  // on the GPU" stops mdrun when there is nothing bonded to offload, as in a
  // box of rigid water and ions; whether a liquid has bonds is its own affair.
  if (o.bonded && o.system === 'solution') {
    warnings.push('`-bonded gpu` stops mdrun when the system has no bonded interactions at all, as a box of rigid water and ions has none ' +
      '("None of the bonded types are implemented on the GPU"): untick it for such a liquid.');
  }
  if (o.pme && ranks > 1) {
    flags.push('-npme 1');
    warnings.push('PME on GPU supports only one PME rank, so `-npme 1` was added automatically.');
  }
  // GPU-resident mode takes only small groups of coupled constraints, and
  // all-bonds on a protein couples far more than that. Whether it does
  // depends on the molecules, so the page warns rather than drops it.
  if (o.update && o.constraints === 'all-bonds') {
    warnings.push('`-update gpu` (GPU-resident mode) needs `constraints = h-bonds`: with all bonds rigid, `mdrun` refuses the GPU update on a protein at startup. Choose bonds to hydrogen under System, or drop `-update gpu`.');
  }
  return { flags: flags.length ? ` ${flags.join(' ')}` : '', ntmpi, ranks, autoNtmpi, warnings };
}

/**
 * What the page should say about GPU flags the dynamics stages leave out
 * (minimisation leaving them out is expected, and said in the script only).
 *
 * @param {object[]} plans - `resolveWorkflow(...).stages`.
 * @param {string} flags - The job's flags.
 * @param {{virtualSites?:boolean, water?:string}} [topology]
 * @returns {string[]} Plain text, code between backquotes.
 */
export function gpuFlagWarnings(plans, flags, topology = {}) {
  const groups = new Map();
  for (const p of plans) {
    if (!p.dynamics) continue;
    for (const d of stageGpuFlags(p, flags, topology).dropped) {
      if (/^-npme/.test(d.flag)) continue;
      const k = `${d.flag}\u0000${d.reason}`;
      if (!groups.has(k)) groups.set(k, { ...d, files: [] });
      groups.get(k).files.push(p.file);
    }
  }
  return [...groups.values()].map(g => `\`${g.flag}\` is left out of ${listText(g.files)}, where mdrun would stop at start-up: ${g.reason}.`);
}

/* ------------------------------------------------------------------ *
 * The job script
 * ------------------------------------------------------------------ */

/**
 * The stages whose mdrun reads the PLUMED input (-plumed): every dynamics
 * stage, or production only, as chosen under Job. Minimisation never does.
 *
 * @param {object[]} plans - `resolveWorkflow(...).stages`.
 * @param {{on:boolean, file?:string, scope?:'prod'|'all'}} [plumed]
 * @returns {object[]}
 */
export function plumedStages(plans, plumed) {
  if (!plumed || !plumed.on) return [];
  return (plans || []).filter(p => p.dynamics && (plumed.scope === 'all' || p.key === 'prod'));
}

/**
 * The grompp and mdrun lines of the job script.
 *
 * @param {object[]} plans - `resolveWorkflow(...).stages`.
 * @param {object} opts
 * @param {string} [opts.gmx='gmx'] - The GROMACS command.
 * @param {string} [opts.topol='topol.top']
 * @param {string} [opts.startConf='system.gro']
 * @param {string} [opts.index=''] - Index file; '' for none.
 * @param {string} [opts.filesDir=''] - Where the .mdp files (and an index
 *   built on the page) are, e.g. '$SUBMIT_DIR/' for a job array.
 * @param {boolean} [opts.indexFromFiles=false] - The index came with the .mdp files.
 * @param {string} [opts.gpuFlags=''] - mdrun GPU flags for the job, with a
 *   leading space; each stage keeps those it can take ({@link stageGpuFlags}).
 * @param {{virtualSites?:boolean, water?:string}} [opts.topology] - For the GPU update.
 * @param {string} [opts.launcher=''] - What starts an MPI mdrun on several
 *   nodes, e.g. 'srun'; grompp is serial and never gets it.
 * @param {{on:boolean, file:string, scope:'prod'|'all'}} [opts.plumed]
 * @param {boolean} [opts.resume=true] - Skip stages that already finished,
 *   and continue an interrupted one from its checkpoint (-cpi). Off, every
 *   stage starts from the beginning each time the script runs.
 * @returns {string}
 */
export function gromacsRunBlock(plans, opts = {}) {
  const gmx = opts.gmx || 'gmx';
  const q = shellWord;
  const topol = q(opts.topol || 'topol.top');
  const start = q(opts.startConf || 'system.gro');
  const dir = opts.filesDir || '';
  const inDir = (f) => (dir ? `"${dir}${String(f).replace(/[\\"`]/g, '\\$&')}"` : q(f));
  const index = opts.index ? (opts.indexFromFiles ? inDir(opts.index) : q(opts.index)) : '';
  const plumed = opts.plumed || { on: false };
  const plumedFile = String(plumed.file || '').trim() || 'plumed.dat';
  const withPlumed = new Set(plumedStages(plans, plumed));
  const resume = opts.resume !== false;
  const launch = opts.launcher ? `${opts.launcher} ` : '';
  const out = [];
  // The PLUMED input is not one of the run files: stop before the first
  // stage when it is missing, rather than hours later at the stage that reads it.
  if (withPlumed.size) {
    const stages = listText([...withPlumed].map(p => (/^[A-Z]{2}/.test(p.label) ? p.label : p.label.toLowerCase())));
    out.push(`# PLUMED: mdrun reads ${plumedFile} (-plumed) in ${stages}.`,
      '# It is not written with these files: build it in the PLUMED tab and put it',
      '# here, with any file its INCLUDE lines read.',
      `if [ ! -f ${q(plumedFile)} ]; then`,
      `    echo ${q(`${plumedFile} is missing: mdrun -plumed reads it. Build it in the PLUMED tab and put it here.`)} >&2`,
      '    exit 1',
      'fi', '');
  }
  let prev = null;
  for (const p of plans) {
    const tpr = q(`${p.deffnm}.tpr`);
    const length = p.dynamics ? `, ${stageLength(p)}` : '';
    out.push(`# ---- ${p.label}: ${p.file} -> ${p.deffnm}.*${length} ----`);
    if (p.maxwarn) {
      out.push(`# -maxwarn ${p.maxwarn}: grompp stops at any warning unless allowed. Expected here:`);
      for (const r of p.maxwarnReasons) out.push(`#   ${r}`);
    }
    if (p.errors && p.errors.length) {
      out.push(`# CHECK: grompp will stop on this file (${p.errors.length} error${p.errors.length === 1 ? '' : 's'}); see the page.`);
    } else if (p.needsIndex && p.needsIndex.length) {
      out.push(`# CHECK: grompp stops unless an index file defines ${p.needsIndex.join(', ')}; see the page.`);
    }
    if (p.mdrunStops && p.mdrunStops.length) out.push('# CHECK: mdrun will stop in this stage; see the page.');
    const c = prev ? q(`${prev.deffnm}.gro`) : start;
    let grompp = `${gmx} grompp -f ${inDir(p.file)} -p ${topol}`;
    if (index) grompp += ` -n ${index}`;
    grompp += ` -c ${c}`;
    if (p.needsRef || p.posres) grompp += ` -r ${c}`;
    if (prev && prev.dynamics && p.dynamics && p.continuation) grompp += ` -t ${q(`${prev.deffnm}.cpt`)}`;
    grompp += ` -o ${tpr}`;
    if (p.maxwarn) grompp += ` -maxwarn ${p.maxwarn}`;

    const gpu = stageGpuFlags(p, opts.gpuFlags || '', opts.topology || {});
    if (gpu.dropped.length) {
      const reasons = [...new Set(gpu.dropped.map(d => d.reason))];
      out.push(`# ${gpu.dropped.map(d => d.flag).join(' ')} left out: ${reasons.join('; ')}.`);
    }
    // -pin auto (mdrun's default, written out): threads are pinned when mdrun
    // uses every CPU it can see and nothing else has set the binding, which on
    // a cluster that binds jobs to their CPUs means the job's own allocation.
    // -pin on would pin from core 0 whatever the scheduler gave, so two jobs
    // sharing an unbound node would land on the same cores
    // (mdrun-performance.rst, -pin).
    let mdrun = `${launch}${gmx} mdrun -deffnm ${q(p.deffnm)}${gpu.flags} -ntomp $OMP_NUM_THREADS -pin auto`;
    // -cpi continues from a checkpoint a previous run left; without the
    // resume logic a re-run must start afresh, not continue an old stage.
    if (p.dynamics && resume) mdrun += ` -cpi ${q(`${p.deffnm}.cpt`)}`;
    if (withPlumed.has(p)) mdrun += ` -plumed ${q(plumedFile)}`;

    if (resume) {
      out.push(`if [ ! -f ${q(`${p.deffnm}.gro`)} ]; then`, `    ${grompp}`, `    ${mdrun}`, 'fi', '');
    } else {
      out.push(grompp, mdrun, '');
    }
    prev = p;
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------ *
 * Sizes
 * ------------------------------------------------------------------ */

/*
 * Bytes per atom and frame, measured on GROMACS 2025 output of a solvated
 * peptide (6020 atoms): .xtc 3.6 (precision 1000), .trr 24 for coordinates
 * and velocities, .cpt 24; an .edr frame is about 370 bytes and a log entry
 * about 1 kB after a 20 kB header.
 */
const SIZE = { xtc: 3.6, xtcFrame: 90, trr: 24, trrFrame: 200, edr: 380, logHead: 20000, logEntry: 1000, cpt: 24, cptHead: 2000 };

/**
 * Estimated output of a stage, for a system of `natoms`.
 *
 * @param {object} plan - One of `resolveWorkflow(...).stages`.
 * @param {number} natoms
 * @returns {{frames:{xtc:number, trr:number, edr:number, log:number}, bytes:{xtc:number, trr:number,
 *   edr:number, log:number, cpt:number}, total:number, unknown?:boolean}} `unknown` for a
 *   stage with no step limit (nsteps = -1), whose counts are then 0.
 */
export function estimateOutput(plan, natoms) {
  const n = Math.max(0, Number(natoms) || 0);
  const v = plan.checked || {};
  // nsteps = -1 runs until stopped: no size to give.
  if (plan.unlimited) {
    return { frames: { xtc: 0, trr: 0, edr: 0, log: 0 }, bytes: { xtc: 0, trr: 0, edr: 0, log: 0, cpt: 0 }, total: 0, unknown: true };
  }
  const steps = Math.max(0, plan.nsteps || 0);
  const frames = (every) => (Number(every) > 0 ? Math.floor(steps / every) + 1 : 0);
  let f;
  if (plan.dynamics) {
    f = {
      xtc: frames(v['nstxout-compressed']),
      trr: frames(v.nstxout),
      edr: frames(v.nstenergy),
      log: frames(v.nstlog)
    };
  } else {
    // Minimisation usually converges long before nsteps: count the final frame.
    f = { xtc: 0, trr: 1, edr: 0, log: 0 };
  }
  const bytes = {
    xtc: f.xtc * (n * SIZE.xtc + SIZE.xtcFrame),
    trr: f.trr * (n * (plan.dynamics ? SIZE.trr : 12) + SIZE.trrFrame),
    edr: plan.dynamics ? f.edr * SIZE.edr : 60000,
    log: plan.dynamics ? SIZE.logHead + f.log * SIZE.logEntry : 150000,
    cpt: plan.dynamics ? n * SIZE.cpt + SIZE.cptHead : 0
  };
  const total = Object.values(bytes).reduce((a, b) => a + b, 0);
  return { frames: f, bytes, total };
}

/* ------------------------------------------------------------------ *
 * README
 * ------------------------------------------------------------------ */

/**
 * The README that goes into the zip.
 *
 * @param {object} wf - `resolveWorkflow(...)`.
 * @param {object} opts - `{jobName, scheduler (label), submit (command), startConf, topol,
 *   index, indexBuilt, natoms, date, files: [{name, note}]}`, and `resume` (default
 *   true: the script skips finished stages), `array` (a job array: every task reads
 *   the same index), `indexLost` (`{name, file}`: an index built on an earlier
 *   visit that is not in the zip) and `plumed` (`{on, file, scope, includes}`, as
 *   gromacsRunBlock takes it, plus the names of the files the PLUMED tab wrote for
 *   its INCLUDE lines: the input is not in the zip, and the README says so).
 * @returns {string}
 */
export function workflowReadme(wf, opts = {}) {
  const ff = wf.forceField;
  const L = [];
  const date = opts.date instanceof Date ? opts.date : new Date();
  L.push(`# GROMACS workflow${opts.jobName ? `: ${opts.jobName}` : ''}`, '');
  L.push(`Written by the STEMKit MD Workflow Generator (https://stemkit.net/script-generator.html) ` +
    `for GROMACS ${MDP_RELEASE}, ${date.toISOString().slice(0, 10)}.`, '');
  L.push('## The files', '', '| File | What it is for |', '|---|---|');
  for (const f of opts.files || []) L.push(`| \`${f.name}\` | ${f.note} |`);
  L.push('');
  L.push('## What you add', '');
  L.push(`Put these next to the files above (or in each run directory of a job array): ` +
    `\`${opts.startConf || 'system.gro'}\`, the start coordinates; \`${opts.topol || 'topol.top'}\`, the topology, ` +
    'with the .itp files it includes' + (wf.stages.some(p => p.posres) ? ' (and the posre.itp files that -DPOSRES switches on)' : '') + '.', '');
  const plumedRuns = plumedStages(wf.stages, opts.plumed);
  const inZip = (opts.plumed && opts.plumed.inZip) || [];
  if (plumedRuns.length && inZip.includes(String(opts.plumed.file || '').trim() || 'plumed.dat')) {
    const file = String(opts.plumed.file || '').trim() || 'plumed.dat';
    const where = listText(plumedRuns.map(p => `\`${p.file}\``));
    const text = String(opts.plumed.text || '');
    // INCLUDE lines of the input that name a file the zip does not hold.
    const missing = [...new Set([...text.matchAll(/\bINCLUDE\b[^\n]*?\bFILE=(\S+)/g)].map(m => m[1]))]
      .filter(n => !inZip.includes(n));
    L.push(`\`${file}\` is in this zip, as the PLUMED tab built it` +
      (inZip.length > 1 ? `, with ${listText(inZip.slice(1).map(n => `\`${n}\``))} that its INCLUDE lines read` : '') +
      `. mdrun reads it with -plumed when it runs ${where}.` +
      (missing.length ? ` Its INCLUDE lines also read ${listText(missing.map(n => `\`${n}\``))}, which the PLUMED tab does not hold: put ${missing.length === 1 ? 'it' : 'them'} next to it.` : ''), '');
  } else if (plumedRuns.length) {
    const file = String(opts.plumed.file || '').trim() || 'plumed.dat';
    const where = listText(plumedRuns.map(p => `\`${p.file}\``));
    const includes = (opts.plumed.includes || []).map(n => `\`${n}\``);
    L.push(`**\`${file}\` is not in this zip.** mdrun reads it with -plumed when it runs ${where}. ` +
      'Build it in the PLUMED tab of the page and download it there, then put it next to the run files with every file its INCLUDE lines read' +
      (includes.length ? ` (the PLUMED tab's per-molecule tools wrote ${listText(includes)}; download ${includes.length === 1 ? 'it' : 'each'} there too)` : '') +
      `. submit.sh stops before the first stage while \`${file}\` is missing.`, '');
  }
  L.push('## The stages', '', '| Stage | File | Length | Steps | Time step | Restrained | Velocities |', '|---|---|---|---|---|---|---|');
  for (const p of wf.stages) {
    L.push(`| ${p.label} | \`${p.file}\` | ${p.dynamics ? stageLength(p) : '-'} | ${p.nsteps < 0 ? 'no limit' : formatCount(p.nsteps)} | ` +
      `${p.dynamics ? `${Number((p.dt * 1000).toPrecision(4))} fs` : '-'} | ${p.restrained || p.posres ? 'yes' : 'no'} | ` +
      `${!p.dynamics ? '-' : p.genVel ? 'new' : p.fromPrevious ? 'from the previous stage' : 'from the start file'} |`);
  }
  L.push('');
  L.push('## Shared settings', '');
  L.push(`- Force field: ${ff.label}. ${ff.why.cutoff}; ${ff.why.dispCorr}.`);
  const first = wf.stages.find(p => p.dynamics);
  if (first) {
    const st = first.settings;
    L.push(`- Temperature: ${st.temperature} K, thermostat ${THERMOSTATS[st.thermostat].value}, tc-grps = ${wf.tcGroups.join(' ')}.`);
  }
  const npt = wf.stages.find(p => p.barostat && p.barostat !== 'none');
  if (npt) L.push(`- Pressure: ${npt.settings.pressure} bar, ${npt.settings.couplingType} coupling; barostat per stage in the table below.`);
  L.push(`- Bonds: constraints = ${wf.constraints}${wf.hmr ? '; hydrogen masses repartitioned (mass-repartition-factor = 3, GROMACS 2024 or newer) for a 4 fs time step' : ''}.`);
  L.push('');
  L.push('## What grompp will say', '');
  for (const p of wf.stages) {
    const counts = [];
    if (p.grompp.errors) counts.push(`${p.grompp.errors} error${p.grompp.errors === 1 ? '' : 's'}`);
    if (p.grompp.warnings) counts.push(`${p.grompp.warnings} warning${p.grompp.warnings === 1 ? '' : 's'} (submit.sh passes -maxwarn ${p.maxwarn})`);
    if (p.grompp.notes) counts.push(`${p.grompp.notes} note${p.grompp.notes === 1 ? '' : 's'}`);
    if (p.conditionalNotes && p.conditionalNotes.length) {
      counts.push(`${p.conditionalNotes.length} more note${p.conditionalNotes.length === 1 ? '' : 's'} if the molecules have bonds between heavy atoms (C=O, C-C); water and ions have none`);
    }
    const baro = barostatLabel(p);
    L.push(`- \`${p.file}\`: ${counts.length ? counts.join(', ') : 'nothing'}${baro ? `; barostat ${baro}` : ''}.`);
    for (const i of p.issues.filter(x => x.source === 'grompp' && x.severity !== 'note')) L.push(`  - ${i.message}`);
    if (!p.errors.length && p.needsIndexMessage) L.push(`  - ${p.needsIndexMessage}`);
    for (const i of p.mdrunStops || []) L.push(`  - mdrun: ${i.message}`);
  }
  L.push('');
  if (opts.natoms > 0) {
    L.push(`## Expected output (${formatCount(opts.natoms)} atoms, approximate)`, '');
    L.push('| Stage | .xtc frames | Output |', '|---|---|---|');
    let total = 0;
    for (const p of wf.stages) {
      const e = estimateOutput(p, opts.natoms);
      total += e.total;
      L.push(`| ${p.label} | ${!p.dynamics || e.unknown ? '-' : formatCount(e.frames.xtc)} | ${e.unknown ? 'no limit' : formatBytes(e.total)} |`);
    }
    L.push(`| All | | ${formatBytes(total)} |`, '');
  }
  L.push('## Running it', '');
  const submit = `Submit with \`${opts.submit || 'sbatch submit.sh'}\`${opts.scheduler ? ` (${opts.scheduler})` : ''}. `;
  L.push(opts.resume === false
    ? `${submit}Every stage runs from its start each time the script runs, and overwrites what an earlier run wrote: ` +
      'if the job reaches its wall time, submitting it again starts the whole workflow over. ' +
      'Switch on "Skip stages that already finished" under Job for a script that carries on instead.'
    : `${submit}Each stage is skipped once its final .gro exists, so if the job reaches its wall time, submit it again: ` +
      'finished stages are skipped and the interrupted one continues from its checkpoint (-cpi).', '');
  if (opts.index) {
    const lost = opts.indexLost && opts.indexLost.name === opts.index ? opts.indexLost : null;
    L.push(opts.indexBuilt
      ? `\`${opts.index}\` was built from your structure with the groups gmx make_ndx makes, plus the ones listed in it; grompp reads it with -n.`
      : lost
        ? `submit.sh passes -n ${opts.index}, which was built on the page from ${lost.file || 'a structure'} on an earlier visit and is ` +
          `not in this zip: load ${lost.file || 'that structure'} again under Index groups and download again, or put the ${opts.index} ` +
          'from an earlier download next to the run files.'
        : `submit.sh passes -n ${opts.index}: put your index file next to the run files.`, '');
    if (opts.array && opts.indexBuilt) {
      L.push(`Every task of the job array reads the same \`${opts.index}\`, from the submission directory, and it was built from one ` +
        'structure: an index group is a list of atom numbers, so the system in every run directory must match that structure ' +
        'atom for atom (the same molecules in the same order). For systems that differ, remove the index built on the page and ' +
        'name your own under Job instead: each task then reads it from its run directory.', '');
    }
  }
  L.push('## Read more', '');
  L.push(`- Every .mdp option: ${MDP_MANUAL}`);
  for (const r of ff.references) L.push(`- ${r.text}: ${r.url}`);
  L.push(`- Getting good performance from mdrun: https://manual.gromacs.org/${MDP_RELEASE}/user-guide/mdrun-performance.html`, '');
  return `${L.join('\n')}`;
}

/* ------------------------------------------------------------------ *
 * From an .mdp back to the builder
 * ------------------------------------------------------------------ */

const lc = (v) => String(v == null ? '' : v).trim().toLowerCase();

/**
 * Read an .mdp file into the builder's terms: which stage it looks like, the
 * shared choices it makes, and that stage's settings. Options the builder has
 * no field for are left to {@link diffOverrides}.
 *
 * @param {string} text
 * @param {object} [current] - The form's state, for anything the file does not say.
 * @returns {{stage:string, shared:object, stageState:object, notes:string[]}}
 */
export function builderFromMdp(text, current = defaultGxState()) {
  const p = parseMdp(text);
  const v = (name) => {
    const k = normaliseName(name);
    const e = p.entries.find(x => !x.empty && !x.duplicate && normaliseName(optKey(x.key)) === k);
    return e ? e.value : null;
  };
  const notes = [];
  const integrator = lc(v('integrator') || 'md');
  const em = ['steep', 'cg', 'l-bfgs'].includes(integrator);
  const pcoupl = lc(v('pcoupl') || 'no');
  const genVel = ['yes', 'true', '1'].includes(lc(v('gen-vel')));
  const posres = /-DPOSRES\b/.test(v('define') || '');
  const anneal = words(v('annealing')).some(w => lc(w) !== 'no');
  const pull = ['yes', 'true', '1'].includes(lc(v('pull')));
  let stage;
  if (em) stage = 'em';
  else if (anneal) stage = 'anneal';
  else if (pull) stage = 'pull';
  else if (pcoupl === 'no') stage = posres || genVel ? 'nvt' : 'prod';
  else stage = posres ? 'npt' : 'prod';

  // Force field, from its non-bonded conventions.
  const rvdw = Number(v('rvdw'));
  const coul = lc(v('coulombtype'));
  const mod = lc(v('vdw-modifier'));
  let forceField = current.forceField || 'amber';
  if (coul.startsWith('reaction') && Number(v('epsilon-r')) >= 10) forceField = 'martini3';
  else if (mod === 'force-switch' || (Math.abs(rvdw - 1.2) < 1e-6 && lc(v('vdwtype')) !== 'cut-off')) forceField = 'charmm36';
  else if (Math.abs(rvdw - 1.4) < 1e-6) forceField = 'gromos54a7';
  else if (Math.abs(rvdw - 1.0) < 1e-6 && lc(v('dispcorr')) === 'enerpres') {
    forceField = ['amber', 'opls-aa'].includes(current.forceField) ? current.forceField : 'amber';
  }
  const ff = FORCE_FIELDS[forceField];

  const shared = { forceField };
  const refT = words(v('ref-t')).map(Number).filter(Number.isFinite);
  if (refT.length) shared.temperature = refT[0];
  const refP = words(v('ref-p')).map(Number).filter(Number.isFinite);
  if (refP.length) shared.pressure = refP[0];
  const tcoupl = lc(v('tcoupl'));
  const tMap = { 'v-rescale': 'v-rescale', 'nose-hoover': 'nose-hoover', berendsen: 'berendsen' };
  if (tMap[tcoupl]) shared.thermostat = tMap[tcoupl];
  const pMap = { 'c-rescale': 'c-rescale', 'parrinello-rahman': 'parrinello-rahman', berendsen: 'berendsen' };
  if (pMap[pcoupl] && stage !== 'npt') shared.barostat = pMap[pcoupl];
  const pt = normaliseName(v('pcoupltype') || '');
  if (pt === 'SEMIISOTROPIC') shared.couplingType = 'semiisotropic';
  else if (pt === 'ANISOTROPIC') shared.couplingType = 'anisotropic';
  else if (pt === 'ISOTROPIC') shared.couplingType = 'isotropic';
  if (shared.couplingType === 'semiisotropic') shared.system = 'membrane';
  if (v('tc-grps')) {
    shared.tcGroups = words(v('tc-grps')).join(' ');
    if (!v('pcoupltype') && words(v('tc-grps')).length === 1 && lc(v('tc-grps')) === 'system') shared.system = 'solution';
  }
  const constraints = lc(v('constraints'));
  if (['h-bonds', 'all-bonds', 'none'].includes(constraints) && !em) shared.constraints = constraints;
  const dt = Number(v('dt'));
  const mrf = Number(v('mass-repartition-factor'));
  if (!em) {
    shared.hmr = mrf > 1 && !!ff.hmr;
    if (dt > 0) {
      const auto = shared.hmr ? 0.004 : ff.dt;
      shared.dtFs = Math.abs(dt - auto) < 1e-9 ? null : Number((dt * 1000).toPrecision(6));
    }
  }

  const stageState = { on: true, posres, velocities: 'auto' };
  const nsteps = Number(v('nsteps'));
  if (em) {
    stageState.method = integrator === 'cg' ? 'cg' : 'steep';
    if (integrator === 'l-bfgs') notes.push('L-BFGS is kept as an option you set; the builder offers steepest descent and conjugate gradient.');
    if (Number(v('emtol')) >= 0 && v('emtol') !== null) stageState.emtol = Number(v('emtol'));
    if (nsteps >= 0 && v('nsteps') !== null) stageState.emSteps = nsteps;
  } else {
    const step = dt > 0 ? dt : 0.001;
    if (nsteps > 0) stageState.lengthPs = Number((nsteps * step).toPrecision(10));
    else if (nsteps < 0) notes.push('nsteps = -1 (no limit) is kept as an option you set.');
    // An interval the file leaves out is grompp's default (nstenergy and
    // nstlog: 1000 steps), in ps.
    const every = (name) => {
      const raw = v(name) === null ? (optionInfo(name) || {}).default : v(name);
      const n = Number(raw);
      return n > 0 ? Number((n * step).toPrecision(10)) : 0;
    };
    const out = {};
    for (const [field, name] of [['xtcPs', 'nstxout-compressed'], ['energyPs', 'nstenergy'], ['logPs', 'nstlog'], ['trrPs', 'nstxout']]) {
      out[field] = every(name);
    }
    stageState.output = out;
    if (genVel) stageState.velocities = 'new';
    if (stage === 'prod' || stage === 'pull') stageState.ensemble = pcoupl === 'no' ? 'NVT' : 'NPT';
    if (stage === 'anneal') {
      stageState.pressure = pcoupl !== 'no';
      const times = words(v('annealing-time')).map(Number);
      const temps = words(v('annealing-temp')).map(Number);
      const n = Number(words(v('annealing-npoints'))[0]) || Math.min(times.length, temps.length);
      if (n >= 2) stageState.schedule = Array.from({ length: n }, (_, i) => `${times[i]} ${temps[i]}`).join(', ');
      stageState.annealType = lc(words(v('annealing'))[0]) === 'periodic' ? 'periodic' : 'single';
    }
    if (stage === 'pull') {
      stageState.pull = {
        mode: Number(v('pull-coord1-rate')) ? 'steered' : 'umbrella',
        group1: v('pull-group1-name') || 'Protein',
        group2: v('pull-group2-name') || 'LIG',
        geometry: lc(v('pull-coord1-geometry')) === 'direction' ? 'direction' : 'distance',
        dim: v('pull-coord1-dim') || 'Y Y Y',
        vec: v('pull-coord1-vec') || '0 0 1',
        k: Number(v('pull-coord1-k')) || 1000,
        rate: Number(v('pull-coord1-rate')) || 0.01,
        outputPs: Number(v('pull-nstxout')) > 0 ? Number((Number(v('pull-nstxout')) * step).toPrecision(6)) : 1
      };
    }
  }
  return { stage, shared, stageState, notes };
}
