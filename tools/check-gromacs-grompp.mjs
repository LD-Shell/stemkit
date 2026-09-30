#!/usr/bin/env node
/*
 * check-gromacs-grompp.mjs: hand what the .mdp generator writes, and a set of
 * deliberately broken files, to GROMACS's own grompp.
 *
 * It builds small test systems first: a ten-residue helical peptide (made
 * here from ideal geometry) run through pdb2gmx with four force fields that
 * GROMACS ships, solvated and neutralised, plus a coarse-grained stand-in
 * with Martini 3 non-bonded settings (GROMACS does not ship Martini; the
 * stand-in exercises the .mdp settings, not the force field). Then:
 *
 *   1. every generated preset (stage x force field x barostat x HMR, and
 *      membrane, anisotropic and Nose-Hoover variants) must pass grompp
 *      -maxwarn 0, and the notes grompp prints must be the ones
 *      generateMdp() lists in `expected`;
 *   2. every broken file must get the same verdict (stops or passes) from
 *      checkMdp() as from grompp;
 *   3. every default in the option table must equal what grompp writes to
 *      mdout.mdp for an option the file leaves unset.
 *
 *     GMX_BIN=/path/to/gmx node tools/check-gromacs-grompp.mjs [--verbose] [--keep] [--record]
 *
 * --record  write grompp's verdicts and messages for the broken files to
 *           tests/fixtures/gromacs/broken-mdp.json, which the Jest tests read
 * --workdir reuse a directory (the systems are built once)
 *
 * Exits 0 when nothing fails, or when GMX_BIN is unset (nothing to check).
 * CHARMM36 is not shipped with GROMACS: its settings are checked on a
 * CHARMM27 topology, which uses the same .mdp conventions.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  generateMdp, checkMdp, parseMdp, optionInfo, listOptions, STAGES, FORCE_FIELDS, normaliseName
} from '../src/core/gromacs-mdp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'gromacs', 'broken-mdp.json');
const GMX = process.env.GMX_BIN || '';
const verbose = process.argv.includes('--verbose');
const keep = process.argv.includes('--keep');
const record = process.argv.includes('--record');
const argWorkdir = (() => { const i = process.argv.indexOf('--workdir'); return i > -1 ? process.argv[i + 1] : ''; })();

if (!GMX) {
  console.log('GMX_BIN is not set; nothing to check.');
  process.exit(0);
}

const work = argWorkdir ? path.resolve(argWorkdir) : fs.mkdtempSync(path.join(os.tmpdir(), 'stemkit-gmx-'));
fs.mkdirSync(work, { recursive: true });

function gmx(args, cwd, input) {
  const r = spawnSync(GMX, [...args, '-quiet'], { cwd, input, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 300000 });
  return { status: r.status, out: `${r.stdout || ''}\n${r.stderr || ''}` };
}

/* ------------------------------------------------------------------ *
 * Test systems
 * ------------------------------------------------------------------ */

/* NeRF: place atom d from a, b, c with bond length, angle and torsion. */
function place(a, b, c, bond, angle, torsion) {
  const sub = (p, q) => p.map((x, i) => x - q[i]);
  const cross = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
  const norm = (p) => { const l = Math.hypot(...p); return p.map(x => x / l); };
  const bc = norm(sub(c, b));
  const n = norm(cross(sub(b, a), bc));
  const m = cross(n, bc);
  const r = Math.PI / 180;
  const d = [-bond * Math.cos(angle * r), bond * Math.sin(angle * r) * Math.cos(torsion * r), bond * Math.sin(angle * r) * Math.sin(torsion * r)];
  return c.map((x, i) => x + bc[i] * d[0] + m[i] * d[1] + n[i] * d[2]);
}

const SIDE = {
  GLY: [], ALA: [['CB', 'N', 'C', 'CA', 1.53, 110.5, -122.5]],
  SER: [['CB', 'N', 'C', 'CA', 1.53, 110.5, -122.5], ['OG', 'N', 'CA', 'CB', 1.42, 111, 180]],
  LYS: [['CB', 'N', 'C', 'CA', 1.53, 110.5, -122.5], ['CG', 'N', 'CA', 'CB', 1.52, 114, 180], ['CD', 'CA', 'CB', 'CG', 1.52, 111, 180],
    ['CE', 'CB', 'CG', 'CD', 1.52, 111, 180], ['NZ', 'CG', 'CD', 'CE', 1.49, 111, 180]],
  GLU: [['CB', 'N', 'C', 'CA', 1.53, 110.5, -122.5], ['CG', 'N', 'CA', 'CB', 1.52, 114, 180], ['CD', 'CA', 'CB', 'CG', 1.52, 113, 180],
    ['OE1', 'CB', 'CG', 'CD', 1.25, 118, 0], ['OE2', 'CB', 'CG', 'CD', 1.25, 118, 180]]
};
const SEQUENCE = ['GLY', 'LYS', 'ALA', 'ALA', 'GLU', 'ALA', 'SER', 'LYS', 'ALA', 'GLY'];

/* An ideal alpha helix (phi -57, psi -47), heavy atoms only. */
function peptidePdb() {
  const atoms = [];
  let N = [0, 0, 0];
  let CA = [1.458, 0, 0];
  let C = place([0, 1, 0], N, CA, 1.525, 111, -60);
  SEQUENCE.forEach((res, i) => {
    if (i > 0) {
      const [pN, pCA, pC] = [N, CA, C];
      N = place(pN, pCA, pC, 1.329, 116.2, -47);
      CA = place(pCA, pC, N, 1.458, 121.7, 180);
      C = place(pC, N, CA, 1.525, 111.2, -57);
    }
    const r = { N, CA, C };
    r.O = place(place(N, CA, C, 1.329, 116.2, -47), CA, C, 1.231, 120.5, 180);
    for (const [name, a, b, c, bond, ang, tor] of SIDE[res]) r[name] = place(r[a], r[b], r[c], bond, ang, tor);
    const names = ['N', 'CA', 'C', 'O', ...SIDE[res].map(s => s[0])];
    if (i === SEQUENCE.length - 1) { r.OXT = place(r.O, CA, C, 1.25, 120, 180); names.push('OXT'); }
    for (const name of names) atoms.push({ name, res, resid: i + 1, x: r[name] });
  });
  return atoms.map((a, k) => {
    const nm = a.name.length < 4 ? ` ${a.name}`.padEnd(4) : a.name;
    return `ATOM  ${String(k + 1).padStart(5)} ${nm} ${a.res} A${String(a.resid).padStart(4)}    ` +
      `${a.x.map(v => v.toFixed(3).padStart(8)).join('')}  1.00  0.00           ${a.name[0]}`;
  }).join('\n') + '\nTER\nEND\n';
}

const ATOMISTIC = [
  { id: 'amber', ff: 'amber99sb-ildn', water: 'tip3p', box: 'spc216.gro' },
  { id: 'charmm36', ff: 'charmm27', water: 'tip3p', box: 'spc216.gro' },
  { id: 'gromos54a7', ff: 'gromos54a7', water: 'spc', box: 'spc216.gro' },
  { id: 'opls-aa', ff: 'oplsaa', water: 'tip4p', box: 'tip4p.gro' }
];

function must(r, what) {
  if (r.status !== 0) {
    console.error(`${what} failed:\n${r.out.split('\n').slice(-25).join('\n')}`);
    process.exit(2);
  }
}

function buildAtomistic(sys) {
  const dir = path.join(work, sys.id);
  if (fs.existsSync(path.join(dir, 'index.ndx'))) return dir;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'peptide.pdb'), peptidePdb());
  must(gmx(['pdb2gmx', '-f', 'peptide.pdb', '-o', 'pep.gro', '-p', 'topol.top', '-ff', sys.ff, '-water', sys.water, '-ignh'], dir), `pdb2gmx ${sys.ff}`);
  // A 1.3 nm margin keeps the box above twice the 1.4 nm GROMOS cut-off plus buffer.
  must(gmx(['editconf', '-f', 'pep.gro', '-o', 'box.gro', '-d', '1.3', '-bt', 'dodecahedron'], dir), 'editconf');
  must(gmx(['solvate', '-cp', 'box.gro', '-cs', sys.box, '-o', 'solv.gro', '-p', 'topol.top'], dir), 'solvate');
  fs.writeFileSync(path.join(dir, 'ions.mdp'), 'integrator = steep\nnsteps = 0\n');
  must(gmx(['grompp', '-f', 'ions.mdp', '-c', 'solv.gro', '-p', 'topol.top', '-o', 'ions.tpr', '-maxwarn', '5'], dir), 'grompp ions');
  must(gmx(['genion', '-s', 'ions.tpr', '-o', 'sys.gro', '-p', 'topol.top', '-pname', 'NA', '-nname', 'CL', '-neutral', '-conc', '0.15'], dir, 'SOL\n'), 'genion');
  writeIndex(dir, (res) => (res === 'SOL' ? 'water' : res === 'NA' || res === 'CL' ? 'ion' : 'protein'));
  return dir;
}

/*
 * A coarse-grained stand-in with Martini 3 bead sizes: a ten-bead peptide
 * (named with amino-acid residues so GROMACS groups it as Protein), W water
 * beads on a lattice and TQ5-like ions. Written here, so no download is needed.
 */
function buildMartini() {
  const dir = path.join(work, 'martini3');
  if (fs.existsSync(path.join(dir, 'index.ndx'))) return dir;
  fs.mkdirSync(dir, { recursive: true });
  const L = 6.0;
  const beads = [];
  const chain = [['LYS', 'Q5', 1], ['ALA', 'P2', 0], ['ALA', 'P2', 0], ['GLU', 'Q5', -1], ['ALA', 'P2', 0],
    ['SER', 'P2', 0], ['LYS', 'Q5', 1], ['ALA', 'P2', 0], ['ALA', 'P2', 0], ['GLY', 'P2', 0]];
  chain.forEach(([res], i) => beads.push({ res, resid: i + 1, name: 'BB', x: [1.5 + 0.35 * i, L / 2, L / 2] }));
  const water = [];
  const step = 0.5;
  for (let i = 0; i < L / step; i++) {
    for (let j = 0; j < L / step; j++) {
      for (let k = 0; k < L / step; k++) {
        const x = [(i + 0.5) * step, (j + 0.5) * step, (k + 0.5) * step];
        if (beads.some(b => Math.hypot(...b.x.map((v, d) => v - x[d])) < 0.45)) continue;
        water.push(x);
      }
    }
  }
  const charge = chain.reduce((s, c) => s + c[2], 0); // +1
  const nCl = Math.max(0, charge) + 5;
  const nNa = nCl - charge;
  const ions = [];
  for (let i = 0; i < nNa; i++) ions.push({ res: 'NA', name: 'NA', x: water.pop() });
  for (let i = 0; i < nCl; i++) ions.push({ res: 'CL', name: 'CL', x: water.pop() });
  const all = [
    ...beads,
    ...water.map((x, i) => ({ res: 'W', resid: beads.length + 1 + i, name: 'W', x })),
    ...ions.map((a, i) => ({ ...a, resid: beads.length + water.length + 1 + i }))
  ];
  const gro = ['Martini-style test system', String(all.length),
    ...all.map((a, i) => `${String(a.resid % 100000).padStart(5)}${a.res.padEnd(5)}${a.name.padStart(5)}${String((i + 1) % 100000).padStart(5)}` +
      a.x.map(v => v.toFixed(3).padStart(8)).join('')),
    `${L.toFixed(5).padStart(10)}${L.toFixed(5).padStart(10)}${L.toFixed(5).padStart(10)}`];
  fs.writeFileSync(path.join(dir, 'sys.gro'), `${gro.join('\n')}\n`);
  const atoms = chain.map(([res, type, q], i) => `${String(i + 1).padStart(4)} ${type.padEnd(4)} ${String(i + 1).padStart(4)} ${res}  BB ${String(i + 1).padStart(4)} ${q.toFixed(1).padStart(5)} 72.0`);
  const bonds = chain.slice(1).map((_, i) => `${i + 1} ${i + 2} 1 0.350 1250`);
  const angles = chain.slice(2).map((_, i) => `${i + 1} ${i + 2} ${i + 3} 2 127 20`);
  fs.writeFileSync(path.join(dir, 'topol.top'), [
    '; Stand-in with Martini 3 bead sizes; not the Martini force field.',
    '[ defaults ]', '1 2 no 1.0 1.0', '',
    '[ atomtypes ]', 'W   72.0 0.000 A 0.470 4.650', 'P2  72.0 0.000 A 0.470 4.500', 'Q5  72.0 0.000 A 0.470 5.000',
    'TQ5 36.0 0.000 A 0.340 2.000', '',
    '[ moleculetype ]', 'PEP 1', '[ atoms ]', ...atoms, '[ bonds ]', ...bonds, '[ angles ]', ...angles, '',
    '#ifdef POSRES', '[ position_restraints ]', ...chain.map((_, i) => `${i + 1} 1 1000 1000 1000`), '#endif', '',
    '[ moleculetype ]', 'W 1', '[ atoms ]', '1 W 1 W W 1 0 72.0', '',
    '[ moleculetype ]', 'NA 0', '[ atoms ]', '1 TQ5 1 NA NA 1 1.0 36.0', '',
    '[ moleculetype ]', 'CL 0', '[ atoms ]', '1 TQ5 1 CL CL 1 -1.0 36.0', '',
    '[ system ]', 'Martini-style test system', '',
    '[ molecules ]', 'PEP 1', `W ${water.length}`, `NA ${nNa}`, `CL ${nCl}`, ''
  ].join('\n'));
  writeIndex(dir, (res) => (res === 'W' ? 'water' : res === 'NA' || res === 'CL' ? 'ion' : 'protein'));
  return dir;
}

/* Default-like groups plus the names the presets use (-n replaces the
   default groups entirely). SOLU/MEMB/SOLV stand in for a membrane system. */
function writeIndex(dir, kind) {
  const lines = fs.readFileSync(path.join(dir, 'sys.gro'), 'utf8').split('\n');
  const n = Number(lines[1]);
  const groups = { System: [], Protein: [], 'Non-Protein': [], Water: [], SOL: [], Ion: [], Water_and_ions: [], NA: [], CL: [], Chain_A: [], Chain_B: [] };
  for (let i = 0; i < n; i++) {
    const l = lines[2 + i];
    const resid = Number(l.slice(0, 5));
    const res = l.slice(5, 10).trim();
    const id = i + 1;
    const k = kind(res);
    groups.System.push(id);
    if (k === 'protein') {
      groups.Protein.push(id);
      (resid <= 5 ? groups.Chain_A : groups.Chain_B).push(id);
    } else {
      groups['Non-Protein'].push(id);
      groups.Water_and_ions.push(id);
      if (k === 'water') { groups.Water.push(id); groups.SOL.push(id); }
      if (k === 'ion') { groups.Ion.push(id); (res === 'NA' ? groups.NA : groups.CL).push(id); }
    }
  }
  groups.SOLU = groups.Protein;
  groups.MEMB = groups.Ion;
  groups.SOLV = groups.Water;
  const out = [];
  for (const [name, ids] of Object.entries(groups)) {
    out.push(`[ ${name} ]`);
    for (let i = 0; i < ids.length; i += 15) out.push(ids.slice(i, i + 15).join(' '));
  }
  fs.writeFileSync(path.join(dir, 'index.ndx'), `${out.join('\n')}\n`);
}

/* ------------------------------------------------------------------ *
 * Running grompp
 * ------------------------------------------------------------------ */

let seq = 0;
function grompp(dir, mdpText, extra = []) {
  const name = `case${++seq}`;
  const mdp = path.join(dir, `${name}.mdp`);
  fs.writeFileSync(mdp, mdpText);
  const r = gmx(['grompp', '-f', `${name}.mdp`, '-c', 'sys.gro', '-r', 'sys.gro', '-p', 'topol.top', '-n', 'index.ndx',
    '-o', `${name}.tpr`, '-po', `${name}.out.mdp`, '-maxwarn', '0', ...extra], dir);
  const blocks = [];
  const re = /^(NOTE|WARNING|ERROR) \d+ \[file ([^\],]*)(?:, line (\d+))?\]:\n((?:.+\n?)+?)(?:\n|$)/gm;
  let m;
  while ((m = re.exec(r.out))) {
    blocks.push({ severity: m[1].toLowerCase(), file: m[2], line: m[3] ? Number(m[3]) : null, text: m[4].replace(/\s+/g, ' ').trim() });
  }
  const fatal = /Fatal error:\n([\s\S]*?)\n\n/.exec(r.out);
  const res = {
    status: r.status,
    passes: r.status === 0,
    errors: blocks.filter(b => b.severity === 'error'),
    warnings: blocks.filter(b => b.severity === 'warning'),
    notes: blocks.filter(b => b.severity === 'note'),
    fatal: fatal ? fatal[1].replace(/\s+/g, ' ').trim() : null,
    out: r.out,
    mdout: path.join(dir, `${name}.out.mdp`)
  };
  if (!keep) {
    for (const f of [`${name}.tpr`]) fs.rmSync(path.join(dir, f), { force: true });
  }
  return res;
}

/* grompp's notes by what they are about, to compare with the checker's ids. */
const NOTE_IDS = [
  [/Removing center of mass motion in the presence of position restraints/, 'posres-comm'],
  [/has an estimated oscillational period/, 'bond-period'],
  [/You are combining position restraints with/, 'posres-pr'],
  [/the optimal nstlist is >= 10/, 'nstlist-small'],
  [/Setting nstcalcenergy/, 'nstcalcenergy-reduced'],
  [/leapfrog does not yet support Nose-Hoover chains/, 'nh-chain-leapfrog'],
  [/nstcomm < nstcalcenergy defeats the purpose/, 'nstcomm-small'],
  [/COM removal frequency is set to/, 'nstcomm-global'],
  [/Setting tcoupl from/, 'tcoupl-ignored'],
  [/Setting pcoupl from/, 'pcoupl-ignored'],
  [/The optimal PME mesh load/, 'pme-load'],
  [/For free energy simulations, the optimal load limit/, 'pme-load-fep'],
  [/This run will generate roughly/, 'data-size'],
  [/You are using a plain Coulomb cut-off/, 'plain-cutoff'],
  [/NVE simulation/, 'nve-buffer'],
  [/You are applying a switch function to vdw forces/, 'rvdw-switch-wide'],
  [/Replacing vdwtype/, 'vdwtype-replaced'],
  [/Old option for temperature coupling given/, 'tcoupl-yes'],
  [/Old option for pressure coupling given/, 'pcoupl-isotropic'],
  [/For a correct single-point energy evaluation with nsteps = 0/, 'nsteps-zero'],
  [/Zero-step energy minimization/, 'em-zero-steps'],
  [/There is a temperature jump when your annealing loops back/, 'annealing-jump'],
  [/rlist is equal to rvdw and\/or rcoulomb/, 'rlist-no-buffer'],
  [/You have set rlist larger than the interaction cut-off/, 'rlist-ignored'],
  [/tau-t = -1 is the value to signal/, 'tau-t-zero'],
  [/Tumbling and flying ice-cubes/, 'flying-ice-cube'],
  [/The switch\/shift interaction settings are just for compatibility/, 'switch-shift-legacy']
];
function noteId(text) {
  const hit = NOTE_IDS.find(([re]) => re.test(text));
  return hit ? hit[1] : `unclassified: ${text.slice(0, 90)}`;
}
/* Notes only grompp can give: they need the coordinates or the whole topology. */
const TOPOLOGY_ONLY = new Set(['pme-load', 'pme-load-fep', 'data-size']);

/* ------------------------------------------------------------------ *
 * 1. Generated presets
 * ------------------------------------------------------------------ */

function presetCases() {
  const cases = [];
  const ffs = ['amber', 'charmm36', 'gromos54a7', 'opls-aa', 'martini3'];
  for (const ff of ffs) {
    const cg = FORCE_FIELDS[ff].resolution === 'coarse-grained';
    for (const stage of Object.keys(STAGES)) {
      const dyn = STAGES[stage].dynamics;
      const hmrs = dyn && !cg ? [false, true] : [false];
      const baros = ['npt', 'prod', 'pull'].includes(stage) ? ['c-rescale', 'parrinello-rahman'] : [undefined];
      for (const hmr of hmrs) {
        for (const barostat of baros) {
          const s = { stage, forceField: ff, hmr };
          if (barostat) s.barostat = barostat;
          if (stage === 'pull') s.pull = { mode: 'steered' };
          cases.push({ name: `${ff} ${stage}${barostat ? ` ${barostat}` : ''}${hmr ? ' HMR' : ''}`, ff, settings: s });
        }
      }
    }
    cases.push({ name: `${ff} npt membrane`, ff, settings: { stage: 'npt', forceField: ff, system: 'membrane' } });
    cases.push({ name: `${ff} prod membrane`, ff, settings: { stage: 'prod', forceField: ff, system: 'membrane' } });
    cases.push({ name: `${ff} prod anisotropic`, ff, settings: { stage: 'prod', forceField: ff, couplingType: 'anisotropic', barostat: 'parrinello-rahman' } });
    cases.push({ name: `${ff} prod nose-hoover`, ff, settings: { stage: 'prod', forceField: ff, thermostat: 'nose-hoover', barostat: 'parrinello-rahman' } });
    cases.push({ name: `${ff} nvt solution`, ff, settings: { stage: 'nvt', forceField: ff, system: 'solution' } });
    cases.push({ name: `${ff} anneal npt`, ff, settings: { stage: 'anneal', forceField: ff, anneal: { barostat: 'c-rescale' } } });
    cases.push({ name: `${ff} pull umbrella direction`, ff, settings: { stage: 'pull', forceField: ff, pull: { mode: 'umbrella', geometry: 'direction', dim: 'N N Y', vec: '0 0 1' } } });
  }
  return cases;
}

/* ------------------------------------------------------------------ *
 * 2. Broken files
 * ------------------------------------------------------------------ */

/* A valid NVT file for the AMBER system; each case changes one thing. */
const BASE = {
  integrator: 'md', dt: '0.002', nsteps: '1000', 'cutoff-scheme': 'Verlet', coulombtype: 'PME', rcoulomb: '1.0',
  rvdw: '1.0', DispCorr: 'EnerPres', constraints: 'h-bonds', tcoupl: 'V-rescale', 'tc-grps': 'Protein Non-Protein',
  'tau-t': '0.1 0.1', 'ref-t': '300 300', 'gen-vel': 'yes', 'gen-temp': '300', nstenergy: '1000', nstlog: '1000'
};
const NPT = { pcoupl: 'C-rescale', 'tau-p': '2.0', compressibility: '4.5e-5', 'ref-p': '1.0', 'gen-vel': 'no', continuation: 'yes' };

function mdp(changes = {}, extraLines = []) {
  const o = { ...BASE, ...changes };
  const lines = ['; STEMKit broken-file case'];
  for (const [k, v] of Object.entries(o)) if (v !== null) lines.push(`${k} = ${v}`);
  return `${[...lines, ...extraLines].join('\n')}\n`;
}

/* The macros the pdb2gmx AMBER topology tests with #ifdef (topol.top, tip3p.itp, ions.itp). */
const TOPOLOGY_MACROS = ['POSRES', 'FLEXIBLE', 'POSRES_WATER'];

/* Each case: a name, what is wrong, the file, and the context checkMdp needs
   for checks that depend on the topology. */
const BROKEN = [
  ['valid-nvt', 'The base file: must pass.', mdp()],
  ['valid-npt', 'The base file with C-rescale: must pass.', mdp(NPT)],
  ['no-equals', 'A line without "=".', mdp({}, ['nstxout 100'])],
  ['no-name', 'Nothing before "=".', mdp({}, ['= 5'])],
  ['duplicate-dash-underscore', 'tau-t and tau_t are one option.', mdp({}, ['tau_t = 0.2 0.2'])],
  ['empty-value', 'An empty value is ignored: passes.', mdp({}, ['nstxout ='])],
  ['comment-only-value', 'A value that is only a comment: passes.', mdp({}, ['tcoupl2 = ; not an option'])],
  ['unknown-option', 'A misspelt option.', mdp({}, ['nstxtcouts = 100'])],
  ['inactive-pull-option', 'A pull option with pull = no.', mdp({}, ['pull-ncoords = 1'])],
  ['obsolete-renamed', 'nstxtcout is renamed: passes.', mdp({}, ['nstxtcout = 500'])],
  ['obsolete-ignored', 'title is ignored: passes.', mdp({}, ['title = my run'])],
  ['obsolete-both', 'Old and new name together.', mdp({}, ['nstxtcout = 500', 'nstxout-compressed = 500'])],
  ['bad-enum', 'An enum value that does not exist.', mdp({ tcoupl: 'v-rescal' })],
  ['enum-case-dashes', 'Enum values ignore case and dashes: passes.', mdp({ tcoupl: 'V_RESCALE', constraints: 'HBONDS' })],
  ['not-integer', 'nsteps with a decimal point.', mdp({ nsteps: '1000.0' })],
  ['not-integer-exponent', 'nsteps written as 1e5.', mdp({ nsteps: '1e5' })],
  ['not-real', 'dt with a decimal comma.', mdp({ dt: '0,002' })],
  ['ensemble-not-available', 'The manual\'s spelling not-available.', mdp({ 'ensemble-temperature-setting': 'not-available' })],
  ['lmc-mc-move', 'The manual\'s name for lmc-move (with expanded ensemble off).', mdp({}, ['lmc-mc-move = no'])],
  ['tc-count', 'Two groups but one tau-t.', mdp({ 'tau-t': '0.1' })],
  ['tc-grps-missing', 'A thermostat without groups.', mdp({ 'tc-grps': null, 'tau-t': null, 'ref-t': null })],
  ['ref-t-negative', 'A negative temperature.', mdp({ 'ref-t': '300 -10' })],
  ['berendsen-thermostat', 'Berendsen: grompp warns.', mdp({ tcoupl: 'Berendsen' })],
  ['tcoupl-yes', 'The old tcoupl = yes: a note, then the Berendsen warning.', mdp({ tcoupl: 'yes' })],
  ['nose-hoover-default-chain', 'Nose-Hoover with the default chain: a note only.', mdp({ tcoupl: 'Nose-Hoover', 'tau-t': '0.5 0.5' })],
  ['nose-hoover-tau-short', 'Nose-Hoover with tau-t too short for nsttcouple.', mdp({ tcoupl: 'Nose-Hoover', 'tau-t': '0.1 0.1', nsttcouple: '10', 'nh-chain-length': '1' })],
  ['berendsen-barostat', 'Berendsen barostat: grompp warns.', mdp({ ...NPT, pcoupl: 'Berendsen' })],
  ['pcoupl-isotropic', 'The old pcoupl = isotropic: a note only.', mdp({ ...NPT, pcoupl: 'isotropic' })],
  ['crescale-anisotropic', 'C-rescale cannot couple anisotropically.', mdp({ ...NPT, pcoupltype: 'anisotropic', compressibility: '4.5e-5 4.5e-5 4.5e-5 0 0 0', 'ref-p': '1 1 1 0 0 0' })],
  ['crescale-no-thermostat', 'C-rescale needs an ensemble temperature.', mdp({ ...NPT, tcoupl: 'no', 'tc-grps': null, 'tau-t': null, 'ref-t': null })],
  ['crescale-different-ref-t', 'Two ref-t values leave no ensemble temperature.', mdp({ ...NPT, 'ref-t': '300 310' })],
  ['semiiso-one-value', 'Semi-isotropic coupling with one compressibility.', mdp({ ...NPT, pcoupltype: 'semiisotropic', 'ref-p': '1 1' })],
  ['pcoupl-no-compressibility', 'Pressure coupling without compressibility.', mdp({ ...NPT, compressibility: null })],
  ['em-pcoupl-no-compressibility', 'Minimisation with pcoupl but no values: still an error.', mdp({ integrator: 'steep', ...NPT, compressibility: null, 'ref-p': null, continuation: null })],
  ['tau-p-short', 'tau-p shorter than 5 x nstpcouple x dt.', mdp({ ...NPT, 'tau-p': '0.5', nstpcouple: '100' })],
  ['pr-gen-vel', 'Parrinello-Rahman with new velocities.', mdp({ ...NPT, pcoupl: 'Parrinello-Rahman', 'tau-p': '5.0', 'gen-vel': 'yes', continuation: 'no' })],
  ['posres-refcoord-scaling', 'Position restraints with pressure coupling and refcoord-scaling = no.', mdp({ ...NPT, define: '-DPOSRES' })],
  ['posres-refcoord-com', 'The same with refcoord-scaling = com: passes with a note.', mdp({ ...NPT, define: '-DPOSRES', 'refcoord-scaling': 'com' })],
  ['posres-pr', 'Position restraints with Parrinello-Rahman: notes only.', mdp({ ...NPT, pcoupl: 'Parrinello-Rahman', 'tau-p': '5.0', define: '-DPOSRES', 'refcoord-scaling': 'com' })],
  ['pr-nh-resonance', 'Nose-Hoover and Parrinello-Rahman with tau-p < 2 tau-t.', mdp({ ...NPT, pcoupl: 'Parrinello-Rahman', 'tau-p': '1.0', tcoupl: 'Nose-Hoover', 'tau-t': '1.0 1.0', 'nh-chain-length': '1' })],
  ['nstenergy-multiple', 'nstenergy not a multiple of nstcalcenergy.', mdp({ nstenergy: '150' })],
  ['nstcalcenergy-large', 'nstcalcenergy above nstenergy: a note only.', mdp({ nstenergy: '50', nstcalcenergy: '100' })],
  ['nstcomm-small', 'nstcomm below nstcalcenergy: a note only.', mdp({ nstcomm: '10' })],
  ['rc-mismatch', 'rvdw larger than rcoulomb.', mdp({ rvdw: '1.2' })],
  ['rc-pme-longer', 'rcoulomb above rvdw with PME: allowed.', mdp({ rcoulomb: '1.2' })],
  ['force-switch-range', 'rvdw-switch not below rvdw.', mdp({ 'vdw-modifier': 'Force-switch', 'rvdw-switch': '1.0', DispCorr: 'no' })],
  ['potential-switch-zero', 'Potential-switch with rvdw-switch = 0.', mdp({ 'vdw-modifier': 'Potential-switch', DispCorr: 'no' })],
  ['vdwtype-shift', 'The old vdwtype = shift: replaced, a note.', mdp({ vdwtype: 'shift', 'rvdw-switch': '0.9' })],
  ['verlet-buffer-zero', 'verlet-buffer-tolerance = 0.', mdp({ 'verlet-buffer-tolerance': '0' })],
  ['group-scheme', 'The removed group scheme.', mdp({ 'cutoff-scheme': 'group' })],
  ['coulomb-user', 'User tables, unsupported.', mdp({ coulombtype: 'User' })],
  ['rf-epsilon', 'Reaction field with epsilon-rf below epsilon-r.', mdp({ coulombtype: 'Reaction-Field', 'epsilon-r': '15', 'epsilon-rf': '5', DispCorr: 'no' })],
  ['rf-epsilon-old', 'The old epsilon-rf = 1 convention: grompp swaps and warns.', mdp({ coulombtype: 'Reaction-Field', 'epsilon-r': '15', 'epsilon-rf': '1', DispCorr: 'no' })],
  ['pbc-no-pme', 'PME without periodic boundaries.', mdp({ pbc: 'no' })],
  ['walls-pbc', 'Walls with pbc = xyz.', mdp({ nwall: '2', 'wall-atomtype': 'OW OW', 'wall-density': '10 10' })],
  ['gen-vel-continuation', 'New velocities and continuation together.', mdp({ continuation: 'yes' })],
  ['dt-no-constraints', 'dt = 2 fs with no constraints.', mdp({ constraints: 'none' })],
  ['dt-4fs-hmr', '4 fs with HMR: passes with a note.', mdp({ dt: '0.004', 'mass-repartition-factor': '3' })],
  ['hmr-below-one', 'mass-repartition-factor below 1.', mdp({ 'mass-repartition-factor': '0.5' })],
  ['mts-sd', 'Multiple time stepping with integrator sd.', mdp({ integrator: 'sd', mts: 'yes' })],
  ['mts-nstenergy', 'MTS with nstenergy not a multiple of the factor.', mdp({ mts: 'yes', 'mts-level2-factor': '3', nstcalcenergy: '99', nstenergy: '1000', nstlog: '999' })],
  ['comm-none', 'No centre-of-mass removal.', mdp({ 'comm-mode': 'None' })],
  ['comm-angular-pbc', 'Angular COM removal in a periodic box.', mdp({ 'comm-mode': 'Angular' })],
  ['nstlist-zero', 'nstlist = 0 with the Verlet scheme.', mdp({ nstlist: '0' })],
  ['nstlist-five', 'nstlist = 5: a note only.', mdp({ nstlist: '5' })],
  ['ensemble-constant-unset', 'A constant ensemble temperature that is not given.', mdp({ 'ensemble-temperature-setting': 'constant' })],
  ['annealing-count', 'annealing for one group of two.', mdp({ annealing: 'single', 'annealing-npoints': '2', 'annealing-time': '0 1', 'annealing-temp': '300 310' })],
  ['annealing-points', 'annealing-time with too few entries.', mdp({ annealing: 'single single', 'annealing-npoints': '2 2', 'annealing-time': '0 1 0', 'annealing-temp': '300 310 300 310' })],
  ['annealing-crescale', 'Annealing two groups with C-rescale.', mdp({ ...NPT, annealing: 'single single', 'annealing-npoints': '2 2', 'annealing-time': '0 1 0 1', 'annealing-temp': '300 310 300 310' })],
  ['annealing-crescale-one-group', 'Annealing one group with C-rescale: passes.', mdp({ ...NPT, 'tc-grps': 'System', 'tau-t': '0.1', 'ref-t': '300', annealing: 'single', 'annealing-npoints': '2', 'annealing-time': '0 1', 'annealing-temp': '300 310' })],
  ['annealing-late-start', 'The first annealing point after tinit.', mdp({ annealing: 'single single', 'annealing-npoints': '2 2', 'annealing-time': '5 10 0 1', 'annealing-temp': '300 310 300 310' })],
  ['freezedim-count', 'freezedim with the wrong number of entries.', mdp({ freezegrps: 'Protein', freezedim: 'Y Y' })],
  ['accelerate-count', 'accelerate with the wrong number of values.', mdp({ 'acc-grps': 'Protein', accelerate: '0.1 0' })],
  ['deform-gen-vel', 'Box deformation with new velocities.', mdp({ 'tc-grps': 'System', 'tau-t': '0.1', 'ref-t': '300', deform: '0 0 0 0.01 0 0' })],
  ['lambda-lengths', 'Lambda arrays of different lengths.', mdp({ 'free-energy': 'yes', 'init-lambda-state': '0', 'coul-lambdas': '0 0.5 1', 'vdw-lambdas': '0 1' })],
  ['lambda-state-range', 'init-lambda-state beyond the arrays.', mdp({ 'free-energy': 'yes', 'init-lambda-state': '5', 'fep-lambdas': '0 0.5 1' })],
  ['lambda-unset', 'Free energy without a lambda state.', mdp({ 'free-energy': 'yes', 'fep-lambdas': '0 0.5 1' })],
  ['sc-r-power', 'sc-r-power 48, removed.', mdp({ 'free-energy': 'yes', 'init-lambda-state': '0', 'fep-lambdas': '0 1', 'sc-alpha': '0.5', 'sc-r-power': '48' })],
  ['pull-groups-count', 'A distance pull coordinate with one group.', mdp({}, ['pull = yes', 'pull-ngroups = 2', 'pull-ncoords = 1', 'pull-group1-name = Chain_A', 'pull-group2-name = Chain_B', 'pull-coord1-groups = 1', 'pull-coord1-k = 1000'])],
  ['pull-direction-no-vec', 'Direction pulling without a vector.', mdp({}, ['pull = yes', 'pull-ngroups = 2', 'pull-ncoords = 1', 'pull-group1-name = Chain_A', 'pull-group2-name = Chain_B', 'pull-coord1-groups = 1 2', 'pull-coord1-geometry = direction', 'pull-coord1-k = 1000'])],
  ['pull-coord-beyond', 'pull-coord2 options with pull-ncoords = 1.', mdp({}, ['pull = yes', 'pull-ngroups = 2', 'pull-ncoords = 1', 'pull-group1-name = Chain_A', 'pull-group2-name = Chain_B', 'pull-coord1-groups = 1 2', 'pull-coord1-k = 1000', 'pull-coord2-k = 500'])],
  ['pull-valid', 'A valid umbrella window: passes.', mdp({}, ['pull = yes', 'pull-ngroups = 2', 'pull-ncoords = 1', 'pull-group1-name = Chain_A', 'pull-group2-name = Chain_B', 'pull-coord1-groups = 1 2', 'pull-coord1-start = yes', 'pull-coord1-k = 1000'])],
  ['awh-no-ndim', 'AWH without awh1-ndim (grompp\'s default is 0).', mdp({}, ['pull = yes', 'pull-ngroups = 2', 'pull-ncoords = 1', 'pull-group1-name = Chain_A', 'pull-group2-name = Chain_B', 'pull-coord1-groups = 1 2', 'pull-coord1-type = external-potential', 'pull-coord1-potential-provider = awh', 'awh = yes'])],
  ['shake-cg', 'Conjugate gradients with SHAKE.', mdp({ integrator: 'cg', 'constraint-algorithm': 'SHAKE', 'gen-vel': null })],
  ['lincs-warnangle', 'lincs-warnangle above 90.', mdp({ 'lincs-warnangle': '100' })],
  ['electric-field-three', 'An electric field with three numbers.', mdp({}, ['electric-field-x = 1 0 0'])],
  ['density-guided-maybe', 'A module switch that is not yes/no.', mdp({}, ['density-guided-simulation-active = maybe'])],
  ['qmmm-yes', 'The removed QM/MM switch.', mdp({ QMMM: 'yes' })],
  ['implicit-solvent-yes', 'Removed implicit solvent.', mdp({ 'implicit-solvent': 'yes' })],
  ['tau-t-uncoupled', 'One group left uncoupled (tau-t = -1).', mdp({ 'tau-t': '0.1 -1' })],
  ['nsteps-zero', 'nsteps = 0 without continuation: a note only.', mdp({ nsteps: '0' })],
  ['sd-tcoupl', 'sd with tcoupl set: a note only.', mdp({ integrator: 'sd', 'tau-t': '1.0 1.0' })],
  ['em-tcoupl', 'Minimisation with a thermostat: a note only.', mdp({ integrator: 'steep', 'gen-vel': null })],
  ['md-vv-avek', 'md-vv-avek without nsttcouple = 1.', mdp({ integrator: 'md-vv-avek' })],
  ['andersen-leapfrog', 'Andersen with leap-frog.', mdp({ tcoupl: 'andersen-massive' })],
  ['cos-acceleration-sd', 'cos-acceleration with sd.', mdp({ integrator: 'sd', 'cos-acceleration': '0.1' })],
  ['epsilon-surface-note', 'epsilon-surface with PME: notes only.', mdp({ 'epsilon-surface': '80' })],
  ['couple-same', 'couple-lambda0 equal to couple-lambda1.', mdp({ 'free-energy': 'yes', 'init-lambda-state': '0', 'fep-lambdas': '0 1', 'couple-moltype': 'Protein_chain_A', 'couple-lambda0': 'vdw', 'couple-lambda1': 'vdw' })],
  ['plain-cutoff', 'A plain Coulomb cut-off: a note only.', mdp({ coulombtype: 'Cut-off' })],
  ['nve', 'No thermostat: an NVE buffer note.', mdp({ tcoupl: 'no', 'tc-grps': null, 'tau-t': null, 'ref-t': null })],
  ['define-unused', 'A misspelt -DPOSRE, which the topology never uses.', mdp({ define: '-DPOSRE' }), { usedMacros: TOPOLOGY_MACROS }],
  ['define-used', '-DPOSRES and -DFLEXIBLE, both used: passes (with the position-restraint note).', mdp({ define: '-DPOSRES -DFLEXIBLE' }), { usedMacros: TOPOLOGY_MACROS }]
];

/* ------------------------------------------------------------------ *
 * 3. Defaults against mdout.mdp
 * ------------------------------------------------------------------ */

const GATES_ON = [
  'integrator = md-vv', 'nsteps = 0', 'mts = yes', 'pull = yes', 'pull-ngroups = 2', 'pull-ncoords = 1',
  'pull-group1-name = Chain_A', 'pull-group2-name = Chain_B', 'pull-coord1-groups = 1 2',
  'awh = yes', 'awh1-ndim = 1', 'rotation = yes', 'rot-group0 = Protein', 'swapcoords = Z',
  'free-energy = expanded', 'simulated-tempering = yes', 'density-guided-simulation-active = true',
  'qmmm-cp2k-active = true', 'colvars-active = true', 'nnpot-active = true'
];

function mdoutValues(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const code = line.replace(/;.*$/, '');
    const i = code.indexOf('=');
    if (i < 0) continue;
    out[normaliseName(code.slice(0, i).trim())] = { name: code.slice(0, i).trim(), value: code.slice(i + 1).trim() };
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

const dirs = {};
for (const sys of ATOMISTIC) dirs[sys.id] = buildAtomistic(sys);
dirs.martini3 = buildMartini();
console.log(`Test systems in ${work}`);

let failures = 0;
const fail = (msg) => { failures += 1; console.log(`FAIL  ${msg}`); };

/* 1 */
const presets = presetCases();
const noteTally = {};
let presetFailures = 0;
for (const c of presets) {
  const g = generateMdp(c.settings);
  const r = grompp(dirs[c.ff], g.text);
  const got = r.notes.map(n => noteId(n.text)).filter(id => !TOPOLOGY_ONLY.has(id)).sort();
  const want = g.expected.filter(e => e.severity === 'note').map(e => e.id).sort();
  for (const n of r.notes) {
    const id = noteId(n.text);
    noteTally[id] = (noteTally[id] || 0) + 1;
  }
  const deprecated = /berendsen/.test(`${c.settings.thermostat} ${c.settings.barostat}`);
  // GROMOS topologies always draw one warning (topio.cpp), which generateMdp
  // lists in `expected`; everything else must pass -maxwarn 0.
  const expectedWarnings = g.expected.filter(e => e.severity === 'warning').length;
  const onlyExpected = r.errors.length === 0 && r.warnings.length === expectedWarnings &&
    (!r.fatal || /^Too many warnings/.test(r.fatal));
  if (!r.passes && !deprecated && !onlyExpected) {
    presetFailures += 1;
    fail(`preset ${c.name}: grompp stops\n      ${[...r.errors, ...r.warnings].map(b => b.text).join('\n      ') || r.fatal}`);
    if (verbose) console.log(g.text);
  } else if (JSON.stringify(got) !== JSON.stringify(want)) {
    presetFailures += 1;
    fail(`preset ${c.name}: grompp notes [${got.join(', ')}], generateMdp expected [${want.join(', ')}]`);
  } else if (verbose) {
    console.log(`ok    preset ${c.name}${got.length ? ` (notes: ${got.join(', ')})` : ''}`);
  }
}
console.log(`Presets: ${presets.length - presetFailures} of ${presets.length} pass grompp -maxwarn 0 with the expected notes.`);
console.log(`  Notes grompp gave across all presets: ${Object.entries(noteTally).map(([k, v]) => `${k} x${v}`).join(', ') || 'none'}`);

/* 2 */
const recorded = [];
let agree = 0;
for (const [name, description, text, context] of BROKEN) {
  const r = grompp(dirs.amber, text);
  const mine = checkMdp(text, context ? { context } : {});
  const same = mine.grompp.passes === r.passes;
  if (same) agree += 1;
  else {
    fail(`broken ${name}: grompp ${r.passes ? 'passes' : 'stops'}, checkMdp says ${mine.grompp.passes ? 'passes' : 'stops'}\n` +
      `      grompp: ${[...r.errors, ...r.warnings].map(b => `${b.severity}: ${b.text}`).join(' | ').slice(0, 600) || r.fatal}\n` +
      `      checkMdp: ${mine.issues.filter(i => i.source === 'grompp' && i.severity !== 'note').map(i => `${i.severity} ${i.id}`).join(', ')}`);
  }
  if (verbose && same) {
    console.log(`ok    broken ${name}: ${r.passes ? 'passes' : 'stops'} (grompp ${r.errors.length}E ${r.warnings.length}W ${r.notes.length}N` +
      `${r.fatal && !/There (was|were) \d+ error|Too many warnings/.test(r.fatal) ? ', fatal' : ''}; checkMdp ${mine.grompp.errors}E ${mine.grompp.warnings}W ${mine.grompp.notes}N)`);
  }
  recorded.push({
    name, description, mdp: text, ...(context ? { context } : {}),
    grompp: {
      passes: r.passes,
      errors: r.errors.length, warnings: r.warnings.length, notes: r.notes.length,
      fatal: r.fatal && !/^There (was|were) \d+ errors? in input file|^Too many warnings/.test(r.fatal) ? r.fatal.slice(0, 300) : null,
      messages: [...r.errors, ...r.warnings].map(b => `${b.severity}: ${b.text.slice(0, 240)}`)
    }
  });
}
console.log(`Broken files: checkMdp agrees with grompp on ${agree} of ${BROKEN.length}.`);

/* 3 */
const d = grompp(dirs.amber, `${GATES_ON.join('\n')}\n`);
const written = mdoutValues(d.mdout);
let defaultsChecked = 0;
let defaultsBad = 0;
const setByCase = new Set(GATES_ON.map(l => normaliseName(l.split('=')[0].trim())));
/* The density-guided module writes these two to mdout.mdp only when they are set. */
const NOT_IN_MDOUT = new Set(['density-guided-simulation-shift-vector', 'density-guided-simulation-transformation-matrix']);
for (const name of listOptions()) {
  const info = optionInfo(name);
  const k = normaliseName(info.gromppName || name);
  if (setByCase.has(k) || NOT_IN_MDOUT.has(name)) continue;
  const w = written[k];
  if (!w) {
    defaultsBad += 1;
    fail(`default ${name}: not in mdout.mdp`);
    continue;
  }
  defaultsChecked += 1;
  let same;
  if (info.defaultFrom) same = true; // pull-coord1-kB copies pull-coord1-k
  else if (info.kind === 'integer' || info.kind === 'real') same = Number(w.value) === Number(info.default) ||
    (/seed/.test(name) && info.default === '-1'); // grompp writes the seed it drew
  else if (info.kind === 'enum') same = normaliseName(w.value) === normaliseName(info.gromppDefault || info.default);
  else same = w.value.replace(/[\s,]+/g, ' ').trim() === String(info.default).replace(/[\s,]+/g, ' ').trim();
  if (!same) { defaultsBad += 1; fail(`default ${name}: table says "${info.default}", grompp writes "${w.value}"`); }
}
const unknownInTable = Object.values(written).filter(w => !optionInfo(w.name));
for (const w of unknownInTable) fail(`mdout.mdp has ${w.name}, which the table does not know`);
console.log(`Defaults: ${defaultsChecked - defaultsBad} of ${defaultsChecked} match mdout.mdp; ${unknownInTable.length} mdout names unknown to the table.`);

/* 4 (--mdrun): run each force field's workflow for a few hundred steps, each
   stage starting from the previous one's output and checkpoint, the way the
   page's job script chains them. This catches what grompp cannot: a file
   that grompp accepts but mdrun rejects or that blows up at once. */
if (process.argv.includes('--mdrun')) {
  const short = { lengthNs: 0.001, output: { xtcPs: 0.1, energyPs: 0.1, logPs: 0.1, trrPs: 0 } };
  let runs = 0;
  let ranOk = 0;
  for (const ff of ['amber', 'charmm36', 'gromos54a7', 'opls-aa', 'martini3']) {
    const dir = dirs[ff];
    const cg = FORCE_FIELDS[ff].resolution === 'coarse-grained';
    const maxwarn = ff === 'gromos54a7' ? ['-maxwarn', '1'] : [];
    const chain = [
      ['em', { stage: 'em', emSteps: 500 }, 'sys.gro', null],
      ['nvt', { stage: 'nvt', ...short }, 'em.gro', null],
      ['npt', { stage: 'npt', ...short }, 'nvt.gro', 'nvt.cpt'],
      ['prod', { stage: 'prod', ...short }, 'npt.gro', 'npt.cpt'],
      ['anneal', { stage: 'anneal', ...short, anneal: { points: [[0, 300], [1, 320]] } }, 'npt.gro', 'npt.cpt'],
      ['pull', { stage: 'pull', ...short, pull: { mode: 'steered' } }, 'npt.gro', 'npt.cpt']
    ];
    if (!cg) chain.push(['prod-hmr', { stage: 'prod', ...short, hmr: true }, 'npt.gro', 'npt.cpt']);
    for (const [name, settings, conf, cpt] of chain) {
      runs += 1;
      const g = generateMdp({ forceField: ff, ...settings });
      fs.writeFileSync(path.join(dir, `${name}.mdp`), g.text);
      const gr = gmx(['grompp', '-f', `${name}.mdp`, '-c', conf, '-r', conf, '-p', 'topol.top', '-n', 'index.ndx',
        '-o', `${name}.tpr`, ...(cpt ? ['-t', cpt] : []), ...maxwarn], dir);
      if (gr.status !== 0) { fail(`mdrun ${ff} ${name}: grompp stops\n${gr.out.split('\n').filter(l => /ERROR|WARNING|Fatal|error/.test(l)).slice(0, 6).join('\n')}`); continue; }
      const md = gmx(['mdrun', '-deffnm', name, '-nt', '4', '-pin', 'off'], dir);
      if (md.status !== 0) {
        const md2 = gmx(['mdrun', '-deffnm', name, '-ntomp', '4', '-pin', 'off'], dir);
        if (md2.status !== 0) {
          fail(`mdrun ${ff} ${name}: mdrun stops\n      ${md2.out.split('\n').filter(l => l.trim()).slice(-8).join('\n      ')}`);
          continue;
        }
      }
      const log = fs.existsSync(path.join(dir, `${name}.log`)) ? fs.readFileSync(path.join(dir, `${name}.log`), 'utf8') : '';
      const lincs = (log.match(/LINCS WARNING|SETTLE warning/g) || []).length;
      if (lincs) fail(`mdrun ${ff} ${name}: ${lincs} constraint warnings in the log`);
      else { ranOk += 1; if (verbose) console.log(`ok    mdrun ${ff} ${name}`); }
    }
  }
  console.log(`mdrun: ${ranOk} of ${runs} stages ran without errors or constraint warnings.`);
}

if (record) {
  const payload = {
    about: 'Verdicts of real grompp (GROMACS ' + (gmx(['--version'], work).out.match(/GROMACS version:\s+(\S+)/) || [])[1] +
      ', mixed precision) on the broken-file cases of tools/check-gromacs-grompp.mjs, run with -maxwarn 0 on a ' +
      'solvated AMBER99SB-ILDN peptide with position restraints available. Regenerate with GMX_BIN=... node ' +
      'tools/check-gromacs-grompp.mjs --record.',
    cases: recorded
  };
  fs.writeFileSync(FIXTURE, `${JSON.stringify(payload, null, 1)}\n`);
  console.log(`Recorded ${recorded.length} cases in ${path.relative(ROOT, FIXTURE)}`);
}

if (!keep && !argWorkdir) fs.rmSync(work, { recursive: true, force: true });
else console.log(`Files kept in ${work}`);
console.log(failures ? `${failures} failure(s).` : 'Everything agrees with grompp.');
process.exit(failures ? 1 : 0);
