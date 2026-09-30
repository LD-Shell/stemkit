/*
 * STEMKit, MD Workflow Generator: the GROMACS workflow as data.
 * Author: Olanrewaju M. Daramola
 *
 * No DOM here. The page reads its form into a plain state object; this
 * module turns that into one plan per stage (the .mdp text grompp will read,
 * what grompp will say about it, the -maxwarn it needs and why), the grompp
 * and mdrun lines of the job script, a README for the zip, size estimates,
 * and the reverse direction: settings for the builder from an .mdp someone
 * already has.
 *
 * Every .mdp comes from src/core/gromacs-mdp.js (generateMdp for the text,
 * checkMdp for the verdict); this module only decides what to ask it for,
 * applies the options the user set by hand, and wires the stages together.
 */

import {
  generateMdp, checkMdp, parseMdp, normaliseName, canonicalName, optionInfo,
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
 * The form's state with every default filled in.
 *
 * @returns {object}
 */
export function defaultGxState() {
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
    forceField: 'amber', system: 'protein', temperature: 300, pressure: 1.0,
    thermostat: 'v-rescale', barostat: 'c-rescale', couplingType: 'isotropic',
    tcGroups: 'Protein Non-Protein', constraints: 'h-bonds', hmr: false, dtFs: null,
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

/**
 * Turn the form's state into one plan per enabled stage.
 *
 * @param {object} state - As {@link defaultGxState} returns it, edited.
 * @returns {{stages:object[], warnings:string[], dt:number, forceField:object, hmr:boolean}}
 */
export function resolveWorkflow(state) {
  const s = { ...defaultGxState(), ...(state || {}) };
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

  if (s.hmr && !ff.hmr) warnings.push(`Hydrogen mass repartitioning is off: ${ff.label} has no hydrogens to repartition.`);
  if (hmr && constraints === 'none') {
    warnings.push('Hydrogen mass repartitioning allows 4 fs only with the bonds to hydrogen constrained; choose constraints = h-bonds.');
  }
  if (!cg && constraints === 'none' && dt > 0.001) {
    warnings.push(`With flexible bonds the fastest vibrations (bonds to hydrogen, about 10 fs) need a time step of 1 fs or less; ${dt * 1000} fs will be unstable.`);
  }
  if (!indexNames && !s.hasIndexFile) {
    const extra = tcGroups.filter(g => !DEFAULT_GROUP_NAMES.has(g.toUpperCase()));
    if (extra.length) {
      warnings.push(`tc-grps names ${extra.join(', ')}, which are not groups GROMACS makes by itself: grompp needs an index file that defines ${extra.length === 1 ? 'it' : 'them'} (build one under Index groups, or give yours under Job).`);
    }
  }

  const stages = [];
  let prevDynamics = false;
  for (const def of GX_STAGES) {
    const st = { ...defaultGxState().stages[def.key], ...((s.stages || {})[def.key] || {}) };
    if (!st.on) continue;
    const coreStage = def.key === 'em' ? (st.method === 'cg' ? 'em-cg' : 'em') : def.key;
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

    // Barostat: equilibration uses C-rescale, whatever production uses,
    // unless the box must be coupled anisotropically (C-rescale cannot).
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
        outputPs: num(p.outputPs, 1) > 0 ? num(p.outputPs, 1) : 1
      };
      plan.pullGroups = [settings.pull.group1, settings.pull.group2];
    }

    const gen = generateMdp(settings);
    plan.settings = gen.settings;
    plan.nsteps = gen.settings.nsteps;
    plan.dt = def.dynamics ? gen.settings.dt : null;
    plan.lengthPs = def.dynamics ? plan.nsteps * plan.dt : 0;
    plan.warnings.push(...gen.warnings);

    // The file names the user chose, in the header line.
    const text = gen.text.replace(/^(; [^\n]*?: )[^\s:]+\.mdp$/m, (all, head) => `${head}${plan.file}`);

    // What the shared choices change beyond what generateMdp asks about.
    const auto = {};
    if (def.dynamics && !cg && constraints !== ff.constraints) {
      auto.constraints = {
        value: constraints,
        comment: constraints === 'all-bonds' ? 'every bond is rigid (chosen under System)' : 'flexible bonds: the time step must be 1 fs or less (chosen under System)'
      };
    }
    if (def.dynamics && !cg && num(s.dtFs, NaN) > 0) {
      auto.dt = { value: String(plan.dt), comment: `${Number((plan.dt * 1000).toPrecision(6))} fs, chosen under System` };
    } else if (def.dynamics && !cg && !hmr && constraints === 'none') {
      auto.dt = { value: String(plan.dt), comment: '1 fs, as flexible bonds need' };
    }
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
    const check = checkMdp(plan.text, { context });
    plan.issues = check.issues;
    plan.grompp = check.grompp;
    plan.checked = check.settings;
    const gw = check.issues.filter(i => i.source === 'grompp' && i.severity === 'warning');
    plan.maxwarn = gw.length;
    plan.maxwarnReasons = gw.map(warnReason);
    plan.errors = check.issues.filter(i => i.severity === 'error');
    plan.mdrunStops = check.issues.filter(i => i.source === 'mdrun' && i.severity === 'error');

    if (def.key === 'prod' && plan.posres) plan.warnings.push('Production runs with position restraints: they are usually released for production.');
    if (plan.nsteps === 0 && def.dynamics) plan.warnings.push(`${def.label} has no steps.`);
    stages.push(plan);
    prevDynamics = prevDynamics || def.dynamics;
  }
  if (!stages.length) warnings.push('No stage is switched on.');
  return { stages, warnings, dt, hmr, constraints, tcGroups, forceField: ff, system };
}

/* ------------------------------------------------------------------ *
 * The job script
 * ------------------------------------------------------------------ */

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
 * @param {string} [opts.gpuFlags=''] - mdrun GPU flags, with a leading space.
 * @param {{on:boolean, file:string, scope:'prod'|'all'}} [opts.plumed]
 * @param {boolean} [opts.resume=true] - Skip stages that already finished.
 * @returns {string}
 */
export function gromacsRunBlock(plans, opts = {}) {
  const gmx = opts.gmx || 'gmx';
  const topol = opts.topol || 'topol.top';
  const start = opts.startConf || 'system.gro';
  const dir = opts.filesDir || '';
  const inDir = (f) => (dir ? `"${dir}${f}"` : f);
  const index = opts.index ? (opts.indexFromFiles ? inDir(opts.index) : opts.index) : '';
  const plumed = opts.plumed || { on: false };
  const resume = opts.resume !== false;
  const out = [];
  let prev = null;
  for (const p of plans) {
    const tpr = `${p.deffnm}.tpr`;
    const length = p.dynamics ? `, ${formatDuration(p.lengthPs)}` : '';
    out.push(`# ---- ${p.label}: ${p.file} -> ${p.deffnm}.*${length} ----`);
    if (p.maxwarn) {
      out.push(`# -maxwarn ${p.maxwarn}: grompp stops at any warning unless allowed. Expected here:`);
      for (const r of p.maxwarnReasons) out.push(`#   ${r}`);
    }
    if (p.errors && p.errors.length) {
      out.push(`# CHECK: grompp will stop on this file (${p.errors.length} error${p.errors.length === 1 ? '' : 's'}); see the page.`);
    }
    const c = prev ? `${prev.deffnm}.gro` : start;
    let grompp = `${gmx} grompp -f ${inDir(p.file)} -p ${topol}`;
    if (index) grompp += ` -n ${index}`;
    grompp += ` -c ${c}`;
    if (p.posres) grompp += ` -r ${c}`;
    if (prev && prev.dynamics && p.dynamics && p.continuation) grompp += ` -t ${prev.deffnm}.cpt`;
    grompp += ` -o ${tpr}`;
    if (p.maxwarn) grompp += ` -maxwarn ${p.maxwarn}`;

    let gpu = opts.gpuFlags || '';
    if (!p.dynamics) gpu = gpu.replace(' -update gpu', '');
    let mdrun = `${gmx} mdrun -deffnm ${p.deffnm}${gpu} -ntomp $OMP_NUM_THREADS -pin on`;
    if (p.dynamics) mdrun += ` -cpi ${p.deffnm}.cpt`;
    if (plumed.on && p.dynamics && (plumed.scope === 'all' || p.key === 'prod')) mdrun += ` -plumed ${plumed.file || 'plumed.dat'}`;

    if (resume) {
      out.push(`if [ ! -f ${p.deffnm}.gro ]; then`, `    ${grompp}`, `    ${mdrun}`, 'fi', '');
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
 *   edr:number, log:number, cpt:number}, total:number}}
 */
export function estimateOutput(plan, natoms) {
  const n = Math.max(0, Number(natoms) || 0);
  const v = plan.checked || {};
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
 *   index, indexBuilt, natoms, date, files: [{name, note}]}`.
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
  L.push('## The stages', '', '| Stage | File | Length | Steps | Time step | Restrained | Velocities |', '|---|---|---|---|---|---|---|');
  for (const p of wf.stages) {
    L.push(`| ${p.label} | \`${p.file}\` | ${p.dynamics ? formatDuration(p.lengthPs) : '-'} | ${formatCount(p.nsteps)} | ` +
      `${p.dynamics ? `${Number((p.dt * 1000).toPrecision(4))} fs` : '-'} | ${p.posres ? 'yes' : 'no'} | ` +
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
    L.push(`- \`${p.file}\`: ${counts.length ? counts.join(', ') : 'nothing'}${p.barostat && p.barostat !== 'none' ? `; barostat ${BAROSTATS[p.barostat].value}` : ''}.`);
    for (const i of p.issues.filter(x => x.source === 'grompp' && x.severity !== 'note')) L.push(`  - ${i.message}`);
  }
  L.push('');
  if (opts.natoms > 0) {
    L.push(`## Expected output (${formatCount(opts.natoms)} atoms, approximate)`, '');
    L.push('| Stage | .xtc frames | Output |', '|---|---|---|');
    let total = 0;
    for (const p of wf.stages) {
      const e = estimateOutput(p, opts.natoms);
      total += e.total;
      L.push(`| ${p.label} | ${p.dynamics ? formatCount(e.frames.xtc) : '-'} | ${formatBytes(e.total)} |`);
    }
    L.push(`| All | | ${formatBytes(total)} |`, '');
  }
  L.push('## Running it', '');
  L.push(`Submit with \`${opts.submit || 'sbatch submit.sh'}\`${opts.scheduler ? ` (${opts.scheduler})` : ''}. ` +
    'Each stage is skipped once its final .gro exists, so if the job reaches its wall time, submit it again: ' +
    'finished stages are skipped and the interrupted one continues from its checkpoint (-cpi).', '');
  if (opts.index) {
    L.push(opts.indexBuilt
      ? `\`${opts.index}\` was built from your structure with the groups gmx make_ndx makes, plus the ones listed in it; grompp reads it with -n.`
      : `submit.sh passes -n ${opts.index}: put your index file next to the run files.`, '');
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
