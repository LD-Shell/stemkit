#!/usr/bin/env node
/*
 * STEMKit, check of the LAMMPS workflow builder against the real LAMMPS.
 * Author: Olanrewaju M. Daramola
 *
 * For every force-field preset, builds the files of a minimise -> NVT ->
 * NPT -> production run for a real system (LAMMPS's own examples and
 * potentials, and water boxes built with LAMMPS here), runs the whole chain
 * through the job block submit.sh would run, and checks the logs: no ERROR,
 * no WARNING without an explanation, every stage ending at exactly its last
 * step. Then:
 *
 *   - continuation: production stopped by its wall time (a short TIME_LIMIT)
 *     and run again continues from its newest restart file, ends at exactly
 *     the requested step, and leaves one unbroken thermo record and
 *     trajectory; the same with fix plumed, where COLVAR and HILLS carry on
 *     with no row twice and no backup files;
 *   - SHAKE holds the bonds it constrains (lengths from the final data file);
 *   - the water boxes reach their temperature in NVT and a sensible density
 *     in NPT.
 *
 * Usage:
 *   LMP_BIN=/path/to/lmp [LMP_PLUMED_BIN=/path/to/lmp-with-plumed] [LMP_NP=2] \
 *     [LMP_WORK=/tmp/dir] node tools/check-lammps-workflow.mjs [case ...]
 *
 * The LAMMPS source tree (examples and potentials) is read from ./lammps or
 * LAMMPS_SRC. Runs are short (a few hundred steps per stage) and niced.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  defaultLammpsState, buildLammpsWorkflow, lammpsRunBlock, LMP_FORCE_FIELD
} from '../src/core/lammps-workflow.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAMMPS = process.env.LAMMPS_SRC || path.join(ROOT, 'lammps');
const LMP = process.env.LMP_BIN;
const LMP_PLUMED = process.env.LMP_PLUMED_BIN || '';
const NP = Math.max(1, parseInt(process.env.LMP_NP || '2', 10) || 2);
const WORK = process.env.LMP_WORK || path.join(os.tmpdir(), 'stemkit-lammps-workflow');
const only = process.argv.slice(2);

if (!LMP) {
  console.error('Set LMP_BIN to a LAMMPS executable (29 Aug 2024 or later).');
  process.exit(2);
}
if (!fs.existsSync(path.join(LAMMPS, 'examples'))) {
  console.error(`No LAMMPS source tree at ${LAMMPS}: set LAMMPS_SRC.`);
  process.exit(2);
}

let dataModule = null;
try { dataModule = await import('../src/core/lammps-data.js'); } catch { dataModule = null; }
let inputModule = null;
try { inputModule = await import('../src/core/lammps-input.js'); } catch { inputModule = null; }

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const ex = (...p) => path.join(LAMMPS, 'examples', ...p);
const pot = (name) => path.join(LAMMPS, 'potentials', name);

function fresh(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function copy(src, dir, name = path.basename(src)) {
  fs.copyFileSync(src, path.join(dir, name));
  return name;
}

function readText(file) {
  const buf = fs.readFileSync(file);
  return file.endsWith('.gz') ? zlib.gunzipSync(buf).toString() : buf.toString();
}

/* Run LAMMPS on a script in a directory (for building systems). */
function lmpScript(dir, name, text, bin = LMP) {
  fs.writeFileSync(path.join(dir, name), text);
  const r = spawnSync('nice', ['-n', '10', bin, '-in', name, '-log', `${name}.log`], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, OMP_NUM_THREADS: '1' }, maxBuffer: 1 << 26
  });
  if (r.status !== 0 || /ERROR/.test(r.stdout)) {
    throw new Error(`LAMMPS failed on ${name} in ${dir}:\n${(r.stdout || '').split('\n').filter(l => /ERROR/.test(l)).join('\n')}`);
  }
  return r.stdout;
}

/* The data summary the page would pass (src/core/lammps-data.js). */
function summary(text, units, opts = {}) {
  if (!dataModule) return null;
  const parsed = dataModule.parseDataFile(text, opts);
  const s = dataModule.summariseData(parsed, { units });
  if (opts.fixes && /crossterms/.test(text)) s.topology = { ...s.topology, crossterms: Number((/(\d+)\s+crossterms/.exec(text) || [])[1] || 0) };
  return { summary: s, parsed };
}

/* Thermo rows of a LAMMPS log: [{Step, Temp, ...}], per run. */
function thermoRuns(text) {
  const runs = [];
  let cols = null;
  let rows = null;
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (/^Step\s/.test(t)) { cols = t.split(/\s+/); rows = []; runs.push(rows); continue; }
    if (!cols) continue;
    if (/^Loop time/.test(t)) { cols = null; continue; }
    const w = t.split(/\s+/);
    if (w.length !== cols.length || !/^\d+$/.test(w[0])) continue;
    const row = {};
    cols.forEach((c, i) => { row[c] = Number(w[i]); });
    rows.push(row);
  }
  return runs;
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);

/* Every ERROR and WARNING line of the logs and the job output. A warning
   is explained when the workflow said LAMMPS would print it
   (workflow.expectedWarnings); the wall-time stop only where the test asks
   for one. */
function scanLogs(dir, output, ctx) {
  const EXPLAINED = (ctx.wf ? ctx.wf.expectedWarnings : [])
    .filter(w => ctx.expectWallStop || !/Wall time/.test(w.text))
    .map(w => ({ re: new RegExp(w.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), text: w.text, why: w.why, when: () => true }));
  const errors = [];
  const warnings = [];
  const explained = [];
  const texts = [['job output', output]];
  for (const f of fs.readdirSync(dir)) if (/\.log$/.test(f) && !/^(build|analyse)/.test(f)) texts.push([f, fs.readFileSync(path.join(dir, f), 'utf8')]);
  for (const [name, text] of texts) {
    for (const line of text.split('\n')) {
      if (/^ERROR/.test(line) || /\bERROR:/.test(line)) errors.push(`${name}: ${line.trim()}`);
      if (/^WARNING/.test(line)) {
        const e = EXPLAINED.find(x => x.re.test(line) && x.when(ctx));
        if (e) explained.push(`"${e.text}": ${e.why}`);
        else warnings.push(`${name}: ${line.trim()}`);
      }
    }
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)], explained: [...new Set(explained)] };
}

/* Run the job block in a directory. */
function runJob(dir, wf, { timeLimit = '', minLeft = 300, plumed = false } = {}) {
  const bin = plumed ? LMP_PLUMED : LMP;
  const launch = NP > 1 ? `nice -n 10 mpirun -np ${NP} --bind-to none` : 'nice -n 10';
  const block = lammpsRunBlock(wf, { lmp: bin, launch, flags: '', minLeft });
  fs.writeFileSync(path.join(dir, 'submit.sh'), `#!/bin/bash\nset -o pipefail\ncd "$(dirname "$0")"\n${block}`);
  const env = { ...process.env, OMP_NUM_THREADS: '1' };
  if (timeLimit) env.TIME_LIMIT = String(timeLimit); else delete env.TIME_LIMIT;
  const t0 = Date.now();
  const r = spawnSync('bash', ['submit.sh'], { cwd: dir, encoding: 'utf8', env, maxBuffer: 1 << 28 });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, seconds: (Date.now() - t0) / 1000 };
}

function writeFiles(dir, wf) {
  for (const f of wf.files) fs.writeFileSync(path.join(dir, f.name), f.text);
}

/* The steps of the PREFIX.<step> files in a directory. */
function restartSteps(dir, prefix) {
  return fs.readdirSync(dir).map(f => (f.startsWith(`${prefix}.`) ? f.slice(prefix.length + 1) : null))
    .filter(s => s !== null && /^\d+$/.test(s)).map(Number).sort((a, b) => a - b);
}

/* Frames (steps) of a text dump. */
function dumpSteps(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const steps = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].startsWith('ITEM: TIMESTEP')) steps.push(Number(lines[i + 1]));
  return steps;
}

/* Rows of a PLUMED output file: first column (time). */
function plumedTimes(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => Number(l.trim().split(/\s+/)[0]));
}

/* Bond lengths of given types in a data file, minimum image. */
function bondDeviation(dataText, wanted) {
  const p = dataModule.parseDataFile(dataText);
  const idx = new Map();
  for (let i = 0; i < p.atoms.n; i++) idx.set(p.atoms.id[i], i);
  const b = p.box;
  const L = [b.xhi - b.xlo, b.yhi - b.ylo, b.zhi - b.zlo];
  let worst = 0;
  let count = 0;
  for (let k = 0; k < p.bonds.n; k++) {
    const type = p.bonds.type[k];
    if (!wanted.has(type)) continue;
    const i = idx.get(p.bonds.atoms[2 * k]);
    const j = idx.get(p.bonds.atoms[2 * k + 1]);
    const d = [0, 1, 2].map(c => {
      let x = p.atoms.x[3 * i + c] - p.atoms.x[3 * j + c];
      x -= Math.round(x / L[c]) * L[c];
      return x;
    });
    const r = Math.hypot(...d);
    worst = Math.max(worst, Math.abs(r - wanted.get(type)));
    count++;
  }
  return { worst, count };
}

/* ------------------------------------------------------------------ *
 * Systems built with LAMMPS
 * ------------------------------------------------------------------ */

const TIP3P_MOL = `# water, TIP3P geometry
3 atoms
2 bonds
1 angles

Coords

1    0.00000  -0.06556   0.00000
2    0.75695   0.52032   0.00000
3   -0.75695   0.52032   0.00000

Types

1 1
2 2
3 2

Charges

1 -0.834
2  0.417
3  0.417

Bonds

1 1 1 2
2 1 1 3

Angles

1 1 2 1 3
`;

const SPCE_MOL = TIP3P_MOL.replace('TIP3P geometry', 'SPC/E geometry')
  .replace('1    0.00000  -0.06556   0.00000', '1    0.00000  -0.06461   0.00000')
  .replace('2    0.75695   0.52032   0.00000', '2    0.81649   0.51275   0.00000')
  .replace('3   -0.75695   0.52032   0.00000', '3   -0.81649   0.51275   0.00000');

/* A box of water molecules, inserted at random by LAMMPS and written as a data file. */
function buildWater(dir, model, { side = 25, molecules = 450 } = {}) {
  const spce = model === 'spce';
  fs.writeFileSync(path.join(dir, 'water.mol'), spce ? SPCE_MOL : TIP3P_MOL);
  lmpScript(dir, 'build.in', `units real
atom_style full
region box block 0 ${side} 0 ${side} 0 ${side}
create_box 2 box bond/types 1 angle/types 1 extra/bond/per/atom 2 extra/angle/per/atom 1 extra/special/per/atom 2
mass 1 15.9994
mass 2 1.008
pair_style lj/cut/coul/cut 8.0
pair_coeff 1 1 0.1521 3.1507
pair_coeff 2 2 0.0 1.0
bond_style harmonic
bond_coeff 1 450 ${spce ? '1.0' : '0.9572'}
angle_style harmonic
angle_coeff 1 55 ${spce ? '109.47' : '104.52'}
molecule water water.mol
create_atoms 0 random ${molecules} 34564 NULL mol water 25367 overlap 1.6 maxtry 200
write_data system.data
`);
  return 'system.data';
}

/* A crystal replicated from a data file, as LAMMPS writes it. */
function replicateData(dir, src, styles, reps) {
  copy(src, dir, 'cell.data');
  lmpScript(dir, 'build.in', `units real
atom_style full
${styles}
read_data cell.data
replicate ${reps}
write_data system.data
`);
  return 'system.data';
}

/* The OPLS ethanol/water box of examples/PACKAGES/fep, with its dihedrals
   rewritten for dihedral_style fourier: the form AMBER converters write. */
function oplsToFourier(text) {
  const out = [];
  let inDih = false;
  for (const line of text.split('\n')) {
    if (/^Dihedral Coeffs/.test(line)) { inDih = true; out.push('Dihedral Coeffs # fourier'); continue; }
    if (inDih && /^\s*[A-Z]/.test(line)) inDih = false;
    if (inDih && /^\s*\d/.test(line)) {
      const [id, ...k] = line.replace(/#.*/, '').trim().split(/\s+/).map(Number);
      const terms = [];
      [[k[0], 1, 0], [k[1], 2, 180], [k[2], 3, 0], [k[3], 4, 180]].forEach(([K, n, d]) => { if (K) terms.push(`${K / 2} ${n} ${d}`); });
      if (!terms.length) terms.push('0.0 1 0');
      out.push(`${id} ${terms.length} ${terms.join(' ')}`);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

const FEP_PAIRS = `pair_coeff 1 1 0.066 3.5
pair_coeff 2 2 0.066 3.5
pair_coeff 3 3 0.030 2.5
pair_coeff 4 4 0.030 2.5
pair_coeff 5 5 0.170 3.12
pair_coeff 6 6 0.0 1.0
pair_coeff 7 7 0.0 1.0
pair_coeff 8 8 0.155425 3.1655`;

/* ------------------------------------------------------------------ *
 * The cases
 * ------------------------------------------------------------------ */

/* Short stages: lengths in steps, output often enough to see. */
function shortStages(st, { min = 200, nvt = 200, npt = 300, prod = 300, every = 50 } = {}) {
  const o = (n) => ({ unit: 'steps', thermo: Math.min(every, n), dump: Math.min(every * 2, n), restart: Math.max(1, Math.floor(n / 2)) });
  Object.assign(st.stages.min, { maxiter: min, maxeval: min * 10, thermo: 50 });
  Object.assign(st.stages.nvt, { length: nvt, lengthUnit: 'steps', output: o(nvt) });
  Object.assign(st.stages.npt, { length: npt, lengthUnit: 'steps', output: o(npt) });
  Object.assign(st.stages.prod, { length: prod, lengthUnit: 'steps', output: o(prod) });
  return st;
}

const CASES = [
  {
    id: 'charmm-peptide', title: 'CHARMM22 peptide in TIP3P (examples/peptide)', preset: 'charmm-switch', shake: true,
    prepare(dir) { return { data: copy(ex('peptide', 'data.peptide'), dir, 'system.data'), units: 'real' }; },
    state(st) { st.groups = 'auto'; st.restraint.group = 'solute_heavy'; return shortStages(st); }
  },
  {
    id: 'charmm-from-restart', title: 'The peptide again, starting from a restart file of your own (system.restart)', preset: 'charmm-switch', shake: false,
    prepare(dir) {
      copy(ex('peptide', 'data.peptide'), dir, 'start.data');
      lmpScript(dir, 'build.in', `units real
atom_style full
pair_style lj/charmm/coul/long 10.0 12.0
bond_style harmonic
angle_style charmm
dihedral_style charmm
improper_style harmonic
special_bonds charmm
read_data start.data
kspace_style pppm 1.0e-4
write_restart system.restart
`);
      return { data: 'start.data', units: 'real' };
    },
    state(st) {
      st.system.source = 'restart'; st.groups = 'auto'; st.restraint.group = 'solute_heavy';
      return shortStages(st, { min: 100, nvt: 100, npt: 100, prod: 100, every: 50 });
    }
  },
  {
    id: 'charmm36-cmap', title: 'CHARMM36 + CMAP, solvated peptide (examples/charmmfsw)', preset: 'charmm', shake: true,
    prepare(dir) {
      copy(ex('charmmfsw', 'charmmff.cmap'), dir);
      return { data: copy(ex('charmmfsw', 'data.charmmfsw.gz'), dir, 'system.data.gz'), units: 'real', fixes: [{ header: 'crossterms', section: 'CMAP' }] };
    },
    state(st) {
      st.ff.cmapFile = 'charmmff.cmap'; st.system.dataFile = 'system.data.gz'; st.groups = 'auto';
      return shortStages(st, { min: 100, nvt: 100, npt: 100, prod: 100, every: 25 });
    }
  },
  {
    id: 'opls-ethanol', title: 'OPLS-AA ethanol in water (examples/PACKAGES/fep CC-CO)', preset: 'opls', shake: true,
    prepare(dir) { return { data: copy(ex('PACKAGES', 'fep', 'CC-CO', 'fep01', 'data.0.lmp'), dir, 'system.data'), units: 'real' }; },
    state(st) { st.extraLines = FEP_PAIRS; st.groups = 'auto'; return shortStages(st); }
  },
  {
    id: 'opls-rattle', title: 'The same box with RATTLE, CSVR and a Berendsen barostat in NPT (MTK, so SHAKE, in production)', preset: 'opls', shake: true,
    prepare(dir) { return { data: copy(ex('PACKAGES', 'fep', 'CC-CO', 'fep01', 'data.0.lmp'), dir, 'system.data'), units: 'real' }; },
    state(st) {
      st.extraLines = FEP_PAIRS; st.groups = 'auto'; st.constraints = 'rattle'; st.thermostat = 'csvr'; st.stages.npt.barostat = 'berendsen';
      return shortStages(st);
    }
  },
  {
    id: 'amber-ethanol', title: 'AMBER styles (lj/cut/coul/long, fourier, special amber) on the same box, membrane coupling', preset: 'amber', shake: true,
    prepare(dir) {
      fs.writeFileSync(path.join(dir, 'system.data'), oplsToFourier(readText(ex('PACKAGES', 'fep', 'CC-CO', 'fep01', 'data.0.lmp'))));
      return { data: 'system.data', units: 'real' };
    },
    state(st) { st.extraLines = FEP_PAIRS; st.groups = 'auto'; st.coupling = 'membrane'; return shortStages(st); }
  },
  {
    id: 'class2-apatite', title: 'COMPASS-style class II hydroxyapatite crystal (msi2lmp test)', preset: 'class2',
    prepare(dir) {
      const data = replicateData(dir, path.join(LAMMPS, 'tools', 'msi2lmp', 'test', 'reference', 'hap_crystal-class2b.data'),
        'pair_style lj/class2/coul/long 9.5\nbond_style class2\nangle_style class2\nimproper_style class2\nkspace_style pppm 1e-4', '3 2 4');
      return { data, units: 'real' };
    },
    state(st) { st.coupling = 'aniso'; st.stages.nvt.restrain = false; st.stages.npt.restrain = false; return shortStages(st); }
  },
  ...['tip3p', 'spce', 'tip4p2005'].map(model => ({
    id: `water-${model}`, title: `${LMP_FORCE_FIELD[model].label.replace('Water: ', '')} water box built with LAMMPS`, preset: model, shake: true, water: true,
    prepare(dir) { return { data: buildWater(dir, model === 'spce' ? 'spce' : 'tip3p'), units: 'real' }; },
    state(st) {
      shortStages(st, { min: 300, nvt: 3000, npt: 15000, prod: 500, every: 100 });
      st.stages.npt.output.dump = 0; st.stages.nvt.output.dump = 0;
      return st;
    }
  })),
  {
    id: 'cu-eam', title: 'Cu fcc, EAM funcfl (Cu_u3.eam)', preset: 'eam',
    prepare(dir) { copy(pot('Cu_u3.eam'), dir); return {}; },
    state(st) { return shortStages(st); }
  },
  {
    id: 'cu-eam-alloy', title: 'Cu fcc, eam/alloy (Cu_mishin1), box relaxed in minimisation', preset: 'eam/alloy',
    prepare(dir) { copy(pot('Cu_mishin1.eam.alloy'), dir); return {}; },
    state(st) { st.stages.min.boxRelax = true; st.system.lattice.constant = 3.60; return shortStages(st); }
  },
  {
    id: 'fe-eam-fs', title: 'Fe bcc, eam/fs (Fe_mm), CSVR + Berendsen barostat in NPT', preset: 'eam/fs',
    prepare(dir) { copy(pot('Fe_mm.eam.fs'), dir); return {}; },
    state(st) { st.thermostat = 'csvr'; st.stages.npt.barostat = 'berendsen'; return shortStages(st); }
  },
  {
    id: 'si-tersoff', title: 'Si diamond, Tersoff (Si.tersoff), Langevin', preset: 'tersoff',
    prepare(dir) { copy(pot('Si.tersoff'), dir); return {}; },
    state(st) { st.thermostat = 'langevin'; st.stages.prod.thermostat = 'nose-hoover'; st.coupling = 'aniso'; return shortStages(st); }
  },
  {
    id: 'si-sw', title: 'Si diamond, Stillinger-Weber (Si.sw), NVE production', preset: 'sw',
    prepare(dir) { copy(pot('Si.sw'), dir); return {}; },
    state(st) { st.stages.prod.ensemble = 'NVE'; st.dump.format = 'xtc'; return shortStages(st); }
  },
  {
    id: 'reaxff-tatb', title: 'ReaxFF TATB crystal, triclinic, tri coupling (examples/reaxff)', preset: 'reaxff',
    prepare(dir) {
      copy(ex('reaxff', 'ffield.reax'), dir);
      return { data: copy(ex('reaxff', 'data.tatb'), dir, 'system.data'), units: 'real' };
    },
    state(st) {
      st.ff = { potentialFile: 'ffield.reax', elements: 'C H O N' }; st.coupling = 'tri';
      return shortStages(st, { min: 50, nvt: 100, npt: 100, prod: 100, every: 25 });
    }
  },
  {
    id: 'lj-melt', title: 'Lennard-Jones fluid, reduced units (examples/melt lattice)', preset: 'lj',
    prepare() { return {}; },
    state(st) { st.dump.format = 'dcd'; return shortStages(st, { nvt: 500, npt: 1000, prod: 500, every: 100 }); }
  },
  {
    id: 'custom-ni', title: 'My own lines: Ni with eam/alloy (CuNi.eam.alloy), given again after every read_restart', preset: 'custom',
    prepare(dir) { copy(pot('CuNi.eam.alloy'), dir); return {}; },
    state(st) {
      st.ff.lines = 'units metal\natom_style atomic\npair_style eam/alloy\npair_coeff * * CuNi.eam.alloy Ni';
      st.system.source = 'lattice';
      st.system.lattice = { style: 'fcc', constant: 3.52, cells: [8, 8, 8], element: 'Ni', mass: null };
      st.timestep = 0.001;
      st.temperature = 300; st.pressure = 1;
      st.stages.nvt.restrain = false; st.stages.npt.restrain = false;
      return shortStages(st);
    }
  }
];

/* Continuation: production stopped by TIME_LIMIT and run again. */
const KILL_CASES = [
  {
    id: 'continue-cu', title: 'Production stopped by TIME_LIMIT, then continued (Cu EAM, Nosé-Hoover)', preset: 'eam', plumed: false,
    prepare(dir) { copy(pot('Cu_u3.eam'), dir); return {}; },
    state(st) {
      shortStages(st, { min: 50, nvt: 200, npt: 200, prod: 60000, every: 100 });
      st.stages.prod.output = { unit: 'steps', thermo: 500, dump: 1000, restart: 5000 };
      return st;
    }
  },
  {
    id: 'continue-plumed', title: 'The same with fix plumed (metadynamics), CSVR', preset: 'eam', plumed: true,
    prepare(dir) { copy(pot('Cu_u3.eam'), dir); return {}; },
    plumedText: 'UNITS LENGTH=A\nd: DISTANCE ATOMS=1,2\nmetad: METAD ARG=d SIGMA=0.05 HEIGHT=0.1 PACE=100 FILE=HILLS\nPRINT ARG=d,metad.bias STRIDE=50 FILE=COLVAR\n',
    state(st) {
      st.thermostat = 'csvr';
      shortStages(st, { min: 50, nvt: 200, npt: 200, prod: 40000, every: 100 });
      // Thermo every 100 steps, as often as the timer checks: the stop step is
      // always on the thermo grid, so both runs print it.
      st.stages.prod.output = { unit: 'steps', thermo: 100, dump: 1000, restart: 5000 };
      return st;
    }
  }
];

/* ------------------------------------------------------------------ *
 * Running a case
 * ------------------------------------------------------------------ */

function prepareCase(c, dir) {
  const st = defaultLammpsState(c.preset);
  const prep = c.prepare(dir) || {};
  let sum = null;
  let parsed = null;
  if (prep.data) {
    const r = summary(readText(path.join(dir, prep.data)), prep.units || 'real', prep.fixes ? { fixes: prep.fixes } : {});
    if (r) { sum = r.summary; parsed = r.parsed; }
  }
  c.state(st);
  if (st.groups === 'auto') {
    st.groups = sum && dataModule ? dataModule.groupsFromData(sum).map(g => ({ name: g.name, args: g.command.replace(/^group\s+\S+\s+/, ''), note: g.why })) : [];
  }
  return { st, sum, parsed };
}

/* The checker of src/core/lammps-input.js on every generated input, when it has one. */
function checkInputs(wf) {
  if (!inputModule || typeof inputModule.checkInput !== 'function') return { checked: false, errors: [] };
  const errors = [];
  const files = Object.fromEntries(wf.files.filter(f => f.kind === 'lammps').map(f => [f.name, f.text]));
  for (const f of wf.files.filter(x => x.kind === 'lammps' && x.stage)) {
    for (const which of ['first', 'continue']) {
      const vars = (wf.vars[f.stage] || {})[which];
      if (!vars) continue;
      let res;
      try { res = inputModule.checkInput(f.text, { vars, files }); } catch (e) { errors.push(`${f.name} (${which}): checker threw ${e.message}`); continue; }
      for (const i of res.issues || []) if (i.severity === 'error') errors.push(`${f.name} (${which}) line ${i.line}: ${i.message}`);
    }
  }
  return { checked: true, errors };
}

function finalChecks(dir, wf, c, res) {
  const fails = [];
  for (const p of wf.stages) {
    if (!p.dynamics) {
      if (!fs.existsSync(path.join(dir, 'min.restart'))) fails.push('min.restart missing');
      continue;
    }
    const steps = restartSteps(dir, p.prefix);
    if (!steps.includes(p.steps)) fails.push(`${p.prefix}.${p.steps} missing (have ${steps.join(', ') || 'none'})`);
    const runs = thermoRuns(fs.existsSync(path.join(dir, p.log)) ? fs.readFileSync(path.join(dir, p.log), 'utf8') : '');
    const last = runs.length ? runs[runs.length - 1] : [];
    const lastStep = last.length ? last[last.length - 1].Step : null;
    if (lastStep !== p.steps) fails.push(`${p.log} ends at step ${lastStep}, not ${p.steps}`);
    res.stageRows = res.stageRows || {};
    res.stageRows[p.key] = runs.flat();
  }
  if (wf.stages.some(p => p.key === 'prod') && !fs.existsSync(path.join(dir, 'prod.data'))) fails.push('prod.data missing');
  return fails;
}

/* SHAKE: every constrained bond within 0.001 Å of its length. */
function shakeCheck(dir, wf, sum, parsed, c) {
  if (!dataModule || !fs.existsSync(path.join(dir, 'prod.data')) || !parsed) return null;
  const wanted = new Map();
  const ff = wf.forceField;
  if (ff.water) {
    const b = sum && sum.water ? sum.water.bondType : 1;
    wanted.set(b, ff.water.r0);
  } else {
    const r0 = new Map((parsed.coefficients.bond || []).map(e => [e.types[0], Number(e.values[e.values.length - 1])]));
    for (const t of (sum.shake && sum.shake.b) || []) if (r0.has(t)) wanted.set(t, r0.get(t));
  }
  if (!wanted.size) return null;
  const r = bondDeviation(readText(path.join(dir, 'prod.data')), wanted);
  void c;
  return { ...r, types: [...wanted.keys()] };
}

/*
 * What read_restart leaves out, for this preset: production's last restart
 * file read on its own and run for 0 steps, without and then with
 * in.settings. The first should stop with the error naming what is missing
 * (kspace, a pair style that writes no restart data), the second run clean.
 */
function restartProbe(dir, wf) {
  const prod = wf.stages.find(p => p.key === 'prod');
  if (!prod) return null;
  const file = `${prod.prefix}.${prod.steps}`;
  const run = (name, lines) => {
    fs.writeFileSync(path.join(dir, name), `${lines.join('\n')}\n`);
    const r = spawnSync('nice', ['-n', '10', LMP, '-in', name, '-log', 'none', '-screen', 'none', '-echo', 'none'], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, OMP_NUM_THREADS: '1' }
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const err = out.split('\n').find(l => /ERROR/.test(l));
    return err ? err.replace(/\s*\(src\/[^)]*\)\s*$/, '').replace(/^ERROR:\s*/, '') : '';
  };
  // -screen none hides the messages; write them to a log the probe reads.
  const probe = (name, lines) => {
    const r = run(name, [`log ${name}.log`, ...lines]);
    const log = fs.existsSync(path.join(dir, `${name}.log`)) ? fs.readFileSync(path.join(dir, `${name}.log`), 'utf8') : '';
    const err = log.split('\n').find(l => /^ERROR/.test(l));
    return r || (err ? err.replace(/\s*\(src\/[^)]*\)\s*$/, '').replace(/^ERROR:\s*/, '') : '');
  };
  const without = probe('analyse-bare.in', [`read_restart ${file}`, 'run 0']);
  const withSettings = probe('analyse-settings.in', [`read_restart ${file}`, 'include in.settings', 'run 0']);
  return { without, withSettings };
}

function runCase(c) {
  const dir = fresh(path.join(WORK, c.id));
  const row = { id: c.id, title: c.title, preset: c.preset, ok: false, notes: [] };
  try {
    const { st, sum, parsed } = prepareCase(c, dir);
    const wf = buildLammpsWorkflow(st, { data: sum });
    row.atoms = wf.natoms;
    const errs = wf.issues.filter(i => i.severity === 'error');
    if (errs.length) { row.notes.push(`builder errors: ${errs.map(e => e.message).join(' | ')}`); return row; }
    for (const i of wf.issues) row.notes.push(`${i.severity}: ${i.message.slice(0, 120)}`);
    const chk = checkInputs(wf);
    if (chk.errors.length) row.notes.push(`checker: ${chk.errors.slice(0, 3).join(' | ')}`);
    row.checker = chk.checked ? (chk.errors.length ? `${chk.errors.length} errors` : 'clean') : 'n/a';
    writeFiles(dir, wf);
    const job = runJob(dir, wf);
    row.seconds = job.seconds;
    fs.writeFileSync(path.join(dir, 'job.out'), job.out);
    const scan = scanLogs(dir, job.out, { wf });
    const fails = [];
    if (job.status !== 0) fails.push(`job exited ${job.status}: ${job.out.split('\n').filter(l => /STOP|ERROR/.test(l)).slice(0, 3).join(' | ')}`);
    if (!/All stages are complete/.test(job.out)) fails.push('the job did not report all stages complete');
    fails.push(...scan.errors.slice(0, 5));
    if (scan.warnings.length) fails.push(...scan.warnings.slice(0, 5).map(w => `unexplained ${w}`));
    row.warnings = scan.explained.length ? [...new Set(scan.explained)].join('; ') : '';
    fails.push(...finalChecks(dir, wf, c, row));
    if (c.shake) {
      const sh = shakeCheck(dir, wf, sum, parsed, c);
      if (sh) {
        row.shake = `${sh.count} bonds, max dev ${sh.worst.toExponential(1)} Å`;
        if (sh.worst > 2e-3) fails.push(`SHAKE: a constrained bond is ${sh.worst.toFixed(4)} Å off`);
      } else row.shake = 'n/a';
    }
    const rp = restartProbe(dir, wf);
    if (rp) {
      row.restart = rp.without ? `restart alone: "${rp.without}"` : 'restart alone runs';
      if (rp.withSettings) fails.push(`the last restart file with in.settings still stops: ${rp.withSettings}`);
    }
    if (c.water) {
      const nvt = (row.stageRows.nvt || []).filter(r => r.Step >= wf.stages.find(p => p.key === 'nvt').steps / 3);
      const npt = (row.stageRows.npt || []).filter(r => r.Step >= wf.stages.find(p => p.key === 'npt').steps / 2);
      const T = mean(nvt.map(r => r.Temp));
      const rho = mean(npt.map(r => r.Density));
      row.physics = `NVT T = ${T.toFixed(1)} K, NPT density = ${rho.toFixed(3)} g/cm³`;
      if (Math.abs(T - wf.temperature) > 0.06 * wf.temperature) fails.push(`NVT temperature ${T.toFixed(1)} K, target ${wf.temperature}`);
      if (!(rho > 0.95 && rho < 1.05)) fails.push(`NPT density ${rho.toFixed(3)} g/cm³, expected about 1.0`);
    }
    row.fails = fails;
    row.ok = !fails.length;
  } catch (e) {
    row.notes.push(`threw: ${e.message}`);
  }
  return row;
}

function runKill(c) {
  const dir = fresh(path.join(WORK, c.id));
  const row = { id: c.id, title: c.title, preset: c.preset, ok: false, notes: [] };
  if (c.plumed && !LMP_PLUMED) { row.skipped = 'LMP_PLUMED_BIN not set'; return row; }
  try {
    const { st } = prepareCase(c, dir);
    const plumed = c.plumed ? { files: [{ name: 'plumed.dat', text: c.plumedText }] } : null;
    // A: equilibration only.
    const a = JSON.parse(JSON.stringify(st));
    a.stages.prod.on = false;
    const wfA = buildLammpsWorkflow(a, { plumed });
    writeFiles(dir, wfA);
    const jobA = runJob(dir, wfA, { plumed: c.plumed });
    const fails = [];
    if (jobA.status !== 0) fails.push(`equilibration failed: ${jobA.out.slice(-400)}`);
    // B: production with little wall time left, C: the rest.
    const wf = buildLammpsWorkflow(st, { plumed });
    writeFiles(dir, wf);
    const prod = wf.stages.find(p => p.key === 'prod');
    const jobB = runJob(dir, wf, { timeLimit: 8, minLeft: 0, plumed: c.plumed });
    const stopB = restartSteps(dir, 'restart');
    const sB = stopB.length ? stopB[stopB.length - 1] : 0;
    if (!(sB > 0 && sB < prod.steps)) fails.push(`the first production job did not stop mid-way (newest restart.${sB}, last step ${prod.steps})`);
    if (!/stopped at step/.test(jobB.out)) fails.push('the job did not report the wall-time stop');
    const colvarB = plumedTimes(path.join(dir, 'COLVAR'));
    const jobC = runJob(dir, wf, { plumed: c.plumed });
    if (jobC.status !== 0 || !/All stages are complete/.test(jobC.out)) fails.push(`the continuation failed: ${jobC.out.split('\n').filter(l => /STOP|ERROR/.test(l)).join(' | ')}`);
    if (!new RegExp(`continuing from restart\\.${sB}`).test(jobC.out)) fails.push(`the continuation did not start from restart.${sB}`);
    fs.writeFileSync(path.join(dir, 'job.out'), `${jobA.out}\n${jobB.out}\n${jobC.out}`);
    const scan = scanLogs(dir, `${jobA.out}\n${jobB.out}\n${jobC.out}`, { expectWallStop: true, wf });
    fails.push(...scan.errors.slice(0, 5));
    if (scan.warnings.length) fails.push(...scan.warnings.slice(0, 5).map(w => `unexplained ${w}`));
    if (!scan.explained.some(w => /Wall time limit/.test(w))) fails.push('LAMMPS never reported the wall-time stop');
    fails.push(...finalChecks(dir, wf, c, row));
    // One unbroken thermo record: every step on the thermo grid, once.
    const rows = thermoRuns(fs.readFileSync(path.join(dir, 'prod.log'), 'utf8')).flat();
    const steps = rows.map(r => r.Step);
    const grid = steps.filter(s => s % prod.output.thermo === 0);
    const want = Array.from({ length: prod.steps / prod.output.thermo + 1 }, (_, i) => i * prod.output.thermo);
    // The step the stage continued from is printed again when the stopped run
    // had printed it too (it was on the thermo grid); the two lines must be
    // the same state, which is also a check that the restart is exact.
    const dupe = steps.filter((s, i) => steps.indexOf(s) !== i);
    if (dupe.some(x => x !== sB)) fails.push(`prod.log repeats steps ${[...new Set(dupe)].slice(0, 5).join(', ')}`);
    if (dupe.includes(sB)) {
      const [a, b] = rows.filter(r => r.Step === sB);
      // With metadynamics the continued run's bias holds the hill laid at
      // that very step, which the stopped run printed its energy before
      // laying: the energies differ by about a hill, the state does not.
      const energies = c.plumed ? ['PotEng', 'TotEng', 'Econserve'] : [];
      const off = Object.keys(a).filter(k => !energies.includes(k) && Math.abs(a[k] - b[k]) > 1e-6 * Math.max(1, Math.abs(a[k])));
      if (off.length) fails.push(`the two lines of step ${sB} differ in ${off.join(', ')}`);
      if (c.plumed) row.biasStep = `PotEng at step ${sB}: ${a.PotEng} then ${b.PotEng} (the hill laid at that step)`;
    }
    if ([...new Set(grid)].join() !== want.join()) fails.push(`prod.log thermo steps are not 0, ${prod.output.thermo}, ... ${prod.steps} (missing ${want.filter(s => !grid.includes(s)).slice(0, 5).join(', ')})`);
    if (!steps.includes(sB)) fails.push(`prod.log has no line at the continuation step ${sB}`);
    for (let i = 1; i < steps.length; i++) if (steps[i] < steps[i - 1]) { fails.push(`prod.log goes back from ${steps[i - 1]} to ${steps[i]}`); break; }
    // The trajectory: every frame once.
    const frames = dumpSteps(path.join(dir, 'prod.lammpstrj'));
    const wantF = Array.from({ length: prod.steps / prod.output.dump + 1 }, (_, i) => i * prod.output.dump);
    if (frames.join() !== wantF.join()) fails.push(`prod.lammpstrj frames are not every ${prod.output.dump} steps once (${frames.length} frames)`);
    row.continuation = `stopped at ${sB} of ${prod.steps}, continued to ${restartSteps(dir, 'restart').pop()}; ${steps.length} thermo lines${dupe.includes(sB) ? ` (step ${sB} twice, identical)` : ''}, ${frames.length} frames once each`;
    if (c.plumed) {
      const pstride = 50;
      const dtps = wf.timestep * 1;   // metal units: ps
      const times = plumedTimes(path.join(dir, 'COLVAR'));
      const wantT = Array.from({ length: prod.steps / pstride + 1 }, (_, i) => Number((i * pstride * dtps).toFixed(6)));
      const got = times.map(t => Number(t.toFixed(6)));
      if (got.join() !== wantT.join()) fails.push(`COLVAR rows are not every ${pstride * dtps} ps once (${got.length} rows, ${wantT.length} wanted)`);
      const hills = plumedTimes(path.join(dir, 'HILLS'));
      for (let i = 1; i < hills.length; i++) if (!(hills[i] > hills[i - 1])) { fails.push(`HILLS times not increasing at row ${i}`); break; }
      const wantH = Math.floor(prod.steps / 100);
      if (hills.length !== wantH) fails.push(`HILLS has ${hills.length} hills, ${wantH} expected (one per PACE)`);
      const bck = fs.readdirSync(dir).filter(f => /^bck\./.test(f));
      if (bck.length) fails.push(`PLUMED set files aside: ${bck.join(', ')}`);
      row.plumed = `COLVAR ${got.length} rows (${colvarB.length} before the stop), HILLS ${hills.length}, backups ${bck.length}${row.biasStep ? `; ${row.biasStep}` : ''}`;
    }
    row.fails = fails;
    row.ok = !fails.length;
    row.seconds = jobA.seconds + jobB.seconds + jobC.seconds;
  } catch (e) {
    row.notes.push(`threw: ${e.message}`);
  }
  return row;
}

/* A hard kill: the job is killed (SIGKILL, as a node failure or the
   scheduler would) after production has written a restart file and gone on
   past it. The run is then continued: frames, COLVAR rows and hills written
   after that restart file must be cut, not repeated. */
const HARD_KILL = {
  id: 'kill-plumed', title: 'Production killed (SIGKILL) past a restart file, then continued, with fix plumed', preset: 'eam', plumed: true,
  prepare(dir) { copy(pot('Cu_u3.eam'), dir); return {}; },
  // FLUSH writes PLUMED's rows at once, so the kill leaves rows past the restart file to cut.
  plumedText: KILL_CASES[1].plumedText.replace('\n', '\nFLUSH STRIDE=50\n'),
  state(st) {
    shortStages(st, { min: 50, nvt: 200, npt: 200, prod: 40000, every: 100 });
    st.stages.prod.output = { unit: 'steps', thermo: 500, dump: 1000, restart: 5000 };
    return st;
  }
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* The processes running in a directory (Linux /proc). */
function jobPids(dir) {
  const real = fs.realpathSync(dir);
  const pids = [];
  for (const p of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(p) || Number(p) === process.pid) continue;
    try { if (fs.readlinkSync(`/proc/${p}/cwd`) === real) pids.push(Number(p)); } catch { /* not ours */ }
  }
  return pids;
}

async function runHardKill(c) {
  const dir = fresh(path.join(WORK, c.id));
  const row = { id: c.id, title: c.title, preset: c.preset, ok: false, notes: [] };
  const usePlumed = !!LMP_PLUMED;
  try {
    const { st } = prepareCase(c, dir);
    const plumed = usePlumed ? { files: [{ name: 'plumed.dat', text: c.plumedText }] } : null;
    const wf = buildLammpsWorkflow(st, { plumed });
    writeFiles(dir, wf);
    const prod = wf.stages.find(p => p.key === 'prod');
    const bin = usePlumed ? LMP_PLUMED : LMP;
    const launch = NP > 1 ? `nice -n 10 mpirun -np ${NP} --bind-to none` : 'nice -n 10';
    fs.writeFileSync(path.join(dir, 'submit.sh'), `#!/bin/bash\nset -o pipefail\ncd "$(dirname "$0")"\n${lammpsRunBlock(wf, { lmp: bin, launch })}`);
    const env = { ...process.env, OMP_NUM_THREADS: '1' };
    delete env.TIME_LIMIT;
    const t0 = Date.now();
    const child = spawn('bash', ['submit.sh'], { cwd: dir, env, detached: true, stdio: 'ignore' });
    // Wait until production has written a restart file at step 10000 or
    // later and a frame past it, then kill every process of the job: the
    // script, mpirun and the LAMMPS ranks (found by their working directory).
    for (let i = 0; i < 2400; i++) {
      await sleep(100);
      const steps = restartSteps(dir, 'restart');
      const newest = steps.length ? steps[steps.length - 1] : 0;
      const frames = dumpSteps(path.join(dir, 'prod.lammpstrj'));
      const cv = plumedTimes(path.join(dir, 'COLVAR'));
      const pastColvar = !LMP_PLUMED || (cv.length && cv[cv.length - 1] > newest * 0.001 + 0.5);
      if (newest >= 10000 && frames.length && frames[frames.length - 1] > newest && pastColvar) break;
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    for (let round = 0; round < 20; round++) {
      const pids = jobPids(dir);
      if (!pids.length) break;
      for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      await sleep(200);
    }
    const fails = [];
    const before = restartSteps(dir, 'restart');
    const s0 = before.length ? before[before.length - 1] : 0;
    const framesBefore = dumpSteps(path.join(dir, 'prod.lammpstrj'));
    const lastFrame = framesBefore.length ? framesBefore[framesBefore.length - 1] : 0;
    if (!(s0 >= 10000 && s0 < prod.steps)) fails.push(`the kill did not land mid-production (newest restart.${s0})`);
    if (!(lastFrame > s0)) fails.push(`no frames were written past restart.${s0} before the kill (last frame ${lastFrame}), so the test proves nothing`);
    const colvarBefore = usePlumed ? plumedTimes(path.join(dir, 'COLVAR')) : [];
    const job = runJob(dir, wf, { plumed: usePlumed });
    fs.writeFileSync(path.join(dir, 'job.out'), job.out);
    if (job.status !== 0 || !/All stages are complete/.test(job.out)) fails.push(`the continuation failed: ${job.out.split('\n').filter(l => /STOP|ERROR/.test(l)).join(' | ')}`);
    if (!new RegExp(`continuing from restart\\.${s0}`).test(job.out)) fails.push(`the continuation did not start from restart.${s0}`);
    const scan = scanLogs(dir, job.out, { wf });
    fails.push(...scan.errors.slice(0, 5));
    if (scan.warnings.length) fails.push(...scan.warnings.slice(0, 5).map(w => `unexplained ${w}`));
    fails.push(...finalChecks(dir, wf, c, row));
    const frames = dumpSteps(path.join(dir, 'prod.lammpstrj'));
    const wantF = Array.from({ length: prod.steps / prod.output.dump + 1 }, (_, i) => i * prod.output.dump);
    if (frames.join() !== wantF.join()) fails.push(`prod.lammpstrj frames are not every ${prod.output.dump} steps once (${frames.length} frames, ${wantF.length} wanted)`);
    row.continuation = `killed with frames up to ${lastFrame} past restart.${s0}; continued to ${restartSteps(dir, 'restart').pop()}; ${frames.length} frames, none twice`;
    if (usePlumed) {
      const times = plumedTimes(path.join(dir, 'COLVAR')).map(t => Number(t.toFixed(6)));
      const wantT = Array.from({ length: prod.steps / 50 + 1 }, (_, i) => Number((i * 50 * wf.timestep).toFixed(6)));
      if (times.join() !== wantT.join()) fails.push(`COLVAR rows are not every 0.05 ps once (${times.length} rows, ${wantT.length} wanted)`);
      const hills = plumedTimes(path.join(dir, 'HILLS'));
      if (hills.length !== Math.floor(prod.steps / 100)) fails.push(`HILLS has ${hills.length} hills, ${Math.floor(prod.steps / 100)} expected`);
      for (let i = 1; i < hills.length; i++) if (!(hills[i] > hills[i - 1])) { fails.push(`HILLS times not increasing at row ${i}`); break; }
      const bck = fs.readdirSync(dir).filter(f => /^bck\./.test(f));
      if (bck.length) fails.push(`PLUMED set files aside: ${bck.join(', ')}`);
      row.plumed = `COLVAR had ${colvarBefore.length} rows at the kill (last at ${colvarBefore[colvarBefore.length - 1]} ps, restart at ${(s0 * wf.timestep).toFixed(2)} ps); now ${times.length}, none twice; HILLS ${hills.length}`;
    }
    row.fails = fails;
    row.ok = !fails.length;
    row.seconds = (Date.now() - t0) / 1000;
  } catch (e) {
    row.notes.push(`threw: ${e.message}`);
  }
  return row;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

fs.mkdirSync(WORK, { recursive: true });
console.log(`LAMMPS: ${LMP}${LMP_PLUMED ? `; with PLUMED: ${LMP_PLUMED}` : ''}; ${NP} MPI rank${NP === 1 ? '' : 's'}; work in ${WORK}`);
const rows = [];
for (const c of [...CASES, ...KILL_CASES, HARD_KILL]) {
  if (only.length && !only.includes(c.id)) continue;
  process.stdout.write(`${c.id} ... `);
  const r = c === HARD_KILL ? await runHardKill(c) : KILL_CASES.includes(c) ? runKill(c) : runCase(c);
  rows.push(r);
  console.log(r.skipped ? `skipped (${r.skipped})` : r.ok ? `ok (${r.seconds ? r.seconds.toFixed(0) : '?'} s)` : 'FAILED');
  if (!r.ok && !r.skipped) for (const f of [...(r.fails || []), ...r.notes.filter(n => /^(builder|threw|checker)/.test(n))]) console.log(`    ${f}`);
}

console.log('\n| Case | Preset | Atoms | Result | Checker | Details |');
console.log('|---|---|---|---|---|---|');
for (const r of rows) {
  const details = [r.shake ? `SHAKE ${r.shake}` : '', r.physics || '', r.restart || '', r.continuation || '', r.plumed || '', r.warnings ? `expected warning ${r.warnings}` : '']
    .filter(Boolean).join('; ');
  console.log(`| ${r.id} | ${r.preset} | ${r.atoms || '-'} | ${r.skipped ? 'skipped' : r.ok ? 'pass' : 'FAIL'} | ${r.checker || '-'} | ${details || r.title} |`);
}
const failed = rows.filter(r => !r.ok && !r.skipped);
console.log(`\n${rows.length - failed.length} of ${rows.length} passed.`);
process.exit(failed.length ? 1 : 0);
