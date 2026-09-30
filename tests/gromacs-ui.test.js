import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  GX_STAGES, defaultGxState, resolveWorkflow, applyOverrides, diffOverrides, sameMdpValue,
  gromacsRunBlock, estimateOutput, formatBytes, parseSchedule, workflowReadme, builderFromMdp,
  gromacsMdrunFlags, stageGpuFlags, gpuFlagWarnings, gmxBuild, shellWord, stageLength, barostatLabel,
  centralAtom, plumedStages
} from '../js/script-generator-gromacs-model.js';
import { parseMdp, checkMdp, FORCE_FIELDS } from '../src/core/gromacs-mdp.js';
import { readGromacsStructure, writeNdx } from '../src/core/gromacs-ndx.js';
import { periodicSystemGro } from './fixtures/gromacs-ndx/periodic-system.mjs';

// The form's defaults, with the rigid bonds of the force field chosen, as
// the page sets them when a force field is picked.
const state = (over = {}) => {
  const s = defaultGxState(over.forceField);
  const stages = { ...s.stages };
  for (const [k, v] of Object.entries(over.stages || {})) stages[k] = { ...stages[k], ...v };
  return { ...s, ...over, stages };
};
const values = (text) => parseMdp(text).values;
const byKey = (wf) => Object.fromEntries(wf.stages.map(p => [p.key, p]));

describe('resolveWorkflow: the default workflow', () => {
  const wf = resolveWorkflow(defaultGxState());
  const p = byKey(wf);

  test('four stages in order, with the page\'s file names', () => {
    expect(wf.stages.map(x => x.key)).toEqual(['em', 'nvt', 'npt', 'prod']);
    expect(wf.stages.map(x => x.file)).toEqual(['em.mdp', 'nvt.mdp', 'npt.mdp', 'md.mdp']);
    expect(p.prod.deffnm).toBe('md');
    expect(p.prod.text.split('\n')[0]).toBe('; Production: md.mdp');
  });

  test('every file passes grompp with no warning', () => {
    for (const x of wf.stages) {
      expect(x.errors).toEqual([]);
      expect(x.maxwarn).toBe(0);
      expect(x.grompp.passes).toBe(true);
    }
  });

  test('new velocities for the first dynamics stage, carried over after it', () => {
    expect(p.nvt.genVel).toBe(true);
    expect(values(p.nvt.text)['gen-vel']).toBe('yes');
    expect(p.npt.genVel).toBe(false);
    expect(p.npt.continuation).toBe(true);
    expect(values(p.npt.text).continuation).toBe('yes');
    expect(p.prod.fromPrevious).toBe(true);
  });

  test('NVT has no barostat; NPT and production use C-rescale', () => {
    expect(values(p.nvt.text).pcoupl).toBe('no');
    expect(values(p.npt.text).pcoupl).toBe('C-rescale');
    expect(values(p.prod.text).pcoupl).toBe('C-rescale');
    expect(values(p.npt.text)['refcoord-scaling']).toBe('com');
  });

  test('lengths become steps at the force field\'s time step', () => {
    expect(p.nvt.nsteps).toBe(50000);
    expect(p.prod.nsteps).toBe(50000000);
    expect(p.prod.dt).toBe(0.002);
  });
});

describe('resolveWorkflow: choices', () => {
  test('Parrinello-Rahman in production, C-rescale while equilibrating', () => {
    const p = byKey(resolveWorkflow(state({ barostat: 'parrinello-rahman' })));
    expect(values(p.npt.text).pcoupl).toBe('C-rescale');
    expect(p.npt.barostatNote).toMatch(/C-rescale while equilibrating/);
    expect(values(p.prod.text).pcoupl).toBe('Parrinello-Rahman');
  });

  test('anisotropic scaling needs Parrinello-Rahman everywhere', () => {
    const p = byKey(resolveWorkflow(state({ couplingType: 'anisotropic' })));
    expect(values(p.npt.text).pcoupl).toBe('Parrinello-Rahman');
    expect(values(p.prod.text).pcoupltype).toBe('anisotropic');
    expect(values(p.prod.text)['ref-p'].split(/\s+/)).toHaveLength(6);
  });

  test('a membrane couples semi-isotropically', () => {
    const p = byKey(resolveWorkflow(state({ system: 'membrane', couplingType: 'semiisotropic', tcGroups: 'SOLU MEMB SOLV', hasIndexFile: true })));
    expect(values(p.prod.text).pcoupltype).toBe('semiisotropic');
    expect(values(p.prod.text).compressibility.split(/\s+/)).toHaveLength(2);
  });

  test('tc-grps that need an index file say so, until one is given', () => {
    const without = resolveWorkflow(state({ tcGroups: 'SOLU MEMB SOLV' }));
    expect(without.warnings.join(' ')).toMatch(/SOLU, MEMB, SOLV.*index file/);
    expect(resolveWorkflow(state({ tcGroups: 'SOLU MEMB SOLV', hasIndexFile: true })).warnings).toEqual([]);
    expect(resolveWorkflow(state({ tcGroups: 'Protein non-Protein' })).warnings).toEqual([]);
  });

  test('group names are checked against an index built on the page', () => {
    const wf = resolveWorkflow(state({ tcGroups: 'Protein_LIG Water_and_ions', index: { groups: ['System', 'Protein', 'Water_and_ions'], natoms: 10 } }));
    expect(byKey(wf).nvt.errors.map(e => e.message).join(' ')).toMatch(/Protein_LIG/);
  });

  test('GROMOS: one grompp warning per stage, so -maxwarn 1, with the reason', () => {
    const wf = resolveWorkflow(state({ forceField: 'gromos54a7' }));
    for (const x of wf.stages) {
      expect(x.maxwarn).toBe(1);
      expect(x.maxwarnReasons[0]).toMatch(/GROMOS topologies always draw one warning/);
    }
  });

  test('a deprecated thermostat is allowed with -maxwarn, and said why', () => {
    const p = byKey(resolveWorkflow(state({ thermostat: 'berendsen' })));
    expect(p.nvt.maxwarn).toBe(1);
    expect(p.nvt.maxwarnReasons.join(' ')).toMatch(/Berendsen thermostat/);
    expect(p.em.maxwarn).toBe(0);
  });

  test('hydrogen mass repartitioning: 4 fs and the factor in every dynamics stage', () => {
    const wf = resolveWorkflow(state({ hmr: true }));
    const p = byKey(wf);
    expect(wf.dt).toBe(0.004);
    expect(values(p.prod.text).dt).toBe('0.004');
    expect(values(p.prod.text)['mass-repartition-factor']).toBe('3.0');
    expect(values(p.em.text)['mass-repartition-factor']).toBeUndefined();
    expect(p.prod.nsteps).toBe(25000000);
  });

  test('HMR does not apply to Martini, and says so', () => {
    const wf = resolveWorkflow(state({ forceField: 'martini3', hmr: true, system: 'solution', tcGroups: 'System' }));
    expect(wf.hmr).toBe(false);
    expect(wf.warnings.join(' ')).toMatch(/no hydrogens/);
    expect(wf.dt).toBe(0.02);
  });

  test('rigid bonds chosen under System reach the dynamics stages only', () => {
    const p = byKey(resolveWorkflow(state({ constraints: 'all-bonds' })));
    expect(values(p.prod.text).constraints).toBe('all-bonds');
    expect(values(p.em.text).constraints).toBe('none');
  });

  test('flexible bonds take a 1 fs step unless told otherwise, and warn above it', () => {
    const wf = resolveWorkflow(state({ constraints: 'none' }));
    expect(wf.dt).toBe(0.001);
    expect(values(byKey(wf).prod.text).dt).toBe('0.001');
    expect(resolveWorkflow(state({ constraints: 'none', dtFs: 2 })).warnings.join(' ')).toMatch(/1 fs or less/);
  });

  test('without NVT, NPT is the first dynamics and gets new velocities', () => {
    const p = byKey(resolveWorkflow(state({ stages: { nvt: { on: false } } })));
    expect(p.npt.genVel).toBe(true);
    expect(p.npt.fromPrevious).toBe(false);
  });

  test('velocities chosen by hand win over the automatic choice', () => {
    const p = byKey(resolveWorkflow(state({ stages: { prod: { velocities: 'new' }, nvt: { velocities: 'continue' } } })));
    expect(p.prod.genVel).toBe(true);
    expect(p.nvt.genVel).toBe(false);
    expect(p.nvt.fromPrevious).toBe(false);
  });

  test('annealing and pulling stages', () => {
    const wf = resolveWorkflow(state({ stages: { anneal: { on: true, schedule: '0 300, 50 350, 100 300', lengthPs: 100 }, pull: { on: true } } }));
    const p = byKey(wf);
    expect(wf.stages.map(x => x.key)).toEqual(['em', 'nvt', 'npt', 'prod', 'anneal', 'pull']);
    expect(values(p.anneal.text)['annealing-temp']).toBe('300.0 350.0 300.0  300.0 350.0 300.0');
    expect(values(p.anneal.text).pcoupl).toBe('no');
    expect(values(p.pull.text)['pull-group2-name']).toBe('LIG');
    expect(p.pull.pullGroups).toEqual(['Protein', 'LIG']);
  });

  test('conjugate gradient minimisation', () => {
    const p = byKey(resolveWorkflow(state({ stages: { em: { method: 'cg', emtol: 100 } } })));
    expect(values(p.em.text).integrator).toBe('cg');
    expect(values(p.em.text).define).toBe('-DFLEXIBLE');
    expect(values(byKey(resolveWorkflow(state({ stages: { em: { method: 'cg', emtol: 100, posres: true } } }))).em.text).define).toBe('-DPOSRES -DFLEXIBLE');
    expect(values(p['em-steep'].text).define).toBeUndefined();
    expect(values(p.em.text).emtol).toBe('100.0');
  });

  test('every force field and system gives files grompp accepts', () => {
    for (const forceField of Object.keys(FORCE_FIELDS)) {
      for (const system of ['protein', 'membrane', 'solution']) {
        const tcGroups = system === 'solution' ? 'System' : 'Protein Non-Protein';
        const couplingType = system === 'membrane' ? 'semiisotropic' : 'isotropic';
        const wf = resolveWorkflow(state({ forceField, system, tcGroups, couplingType }));
        for (const x of wf.stages) {
          expect(x.errors).toEqual([]);
          expect(x.maxwarn).toBe(forceField === 'gromos54a7' ? 1 : 0);
        }
      }
    }
  });
});

describe('applyOverrides', () => {
  const text = resolveWorkflow(defaultGxState()).stages[3].text;

  test('replaces a value where the file sets it, keeping the layout', () => {
    const { text: out, changed } = applyOverrides(text, { tau_p: '2.0' });
    const line = out.split('\n').find(l => l.startsWith('tau-p'));
    expect(line).toMatch(/^tau-p {20}= 2\.0 +; set by you; the generator wrote 1\.0$/);
    expect(line.indexOf('=')).toBe(text.split('\n').find(l => l.startsWith('tau-p')).indexOf('='));
    expect(changed).toEqual([{ name: 'tau-p', value: '2.0', previous: '1.0' }]);
  });

  test('removes an option set to null, and appends one the file lacks', () => {
    const { text: out } = applyOverrides(text, { DispCorr: null, 'cos-acceleration': '0.1' });
    const v = values(out);
    expect(v.DispCorr).toBeUndefined();
    expect(v['cos-acceleration']).toBe('0.1');
    expect(out).toMatch(/; ---- Set by you ----\ncos-acceleration +=/);
    expect(checkMdp(out).issues.filter(i => i.id === 'duplicate')).toEqual([]);
  });

  test('a comment of its own', () => {
    const { text: out } = applyOverrides(text, { nstlist: { value: '20', comment: 'why' } });
    expect(out).toMatch(/nstlist += 20 +; why\n/);
  });
});

describe('sameMdpValue and diffOverrides', () => {
  test('compare as grompp reads them', () => {
    expect(sameMdpValue('pcoupl', 'c-rescale', 'C-rescale')).toBe(true);
    expect(sameMdpValue('gen-vel', 'YES', 'yes')).toBe(true);
    expect(sameMdpValue('gen-vel', 'yes', 'no')).toBe(false);
    expect(sameMdpValue('ref-t', '300 300', '300.0 300.00')).toBe(true);
    expect(sameMdpValue('tc-grps', 'protein SOL', 'Protein sol')).toBe(true);
    expect(sameMdpValue('ref-t', '300', '300 300')).toBe(false);
  });

  test('an .mdp file comes back through the builder as the same file', () => {
    const wanted = [
      'integrator = md', 'dt = 0.002', 'nsteps = 250000', 'tcoupl = nose-hoover', 'nh-chain-length = 1',
      'tc-grps = Protein SOL', 'tau_t = 0.5 0.5', 'ref_t = 310 310', 'pcoupl = Parrinello-Rahman',
      'tau_p = 2', 'ref_p = 1', 'compressibility = 4.5e-5', 'constraints = h-bonds', 'cutoff-scheme = Verlet',
      'rvdw = 1.2', 'rcoulomb = 1.2', 'vdw-modifier = force-switch', 'rvdw-switch = 1.0', 'coulombtype = PME',
      'gen_vel = no', 'continuation = yes', 'nstxout-compressed = 5000', 'nstenergy = 5000', 'energygrps = Protein'
    ].join('\n');
    const guess = builderFromMdp(wanted);
    expect(guess.stage).toBe('prod');
    expect(guess.shared).toMatchObject({ forceField: 'charmm36', temperature: 310, thermostat: 'nose-hoover', barostat: 'parrinello-rahman', tcGroups: 'Protein SOL' });
    expect(guess.stageState.lengthPs).toBe(500);
    const s = state({ ...guess.shared, stages: { prod: guess.stageState } });
    const plan = byKey(resolveWorkflow(s)).prod;
    const overrides = diffOverrides(wanted, plan.generatedText);
    const again = byKey(resolveWorkflow({ ...s, overrides: { prod: overrides } })).prod;
    const a = values(again.text);
    const w = values(wanted);
    for (const [k, v] of Object.entries(w)) {
      const name = Object.keys(a).find(n => n.toLowerCase().replace(/[-_]/g, '') === k.toLowerCase().replace(/[-_]/g, ''));
      expect([k, sameMdpValue(name, a[name], v)]).toEqual([k, true]);
    }
    expect(overrides.energygrps).toBe('Protein');
    expect(overrides['tau-p']).toBe('2');
  });

  test('detects minimisation, NVT, NPT, annealing and pulling', () => {
    expect(builderFromMdp('integrator = cg\nemtol = 50').stage).toBe('em');
    expect(builderFromMdp('integrator = cg').stageState.method).toBe('cg');
    expect(builderFromMdp('define = -DPOSRES\ngen-vel = yes\npcoupl = no').stage).toBe('nvt');
    expect(builderFromMdp('define = -DPOSRES\npcoupl = C-rescale').stage).toBe('npt');
    expect(builderFromMdp('annealing = single').stage).toBe('anneal');
    expect(builderFromMdp('pull = yes').stage).toBe('pull');
    expect(builderFromMdp('mass-repartition-factor = 3\ndt = 0.004').shared).toMatchObject({ hmr: true, dtFs: null });
  });
});

describe('gromacsRunBlock', () => {
  const wf = resolveWorkflow(state({ forceField: 'gromos54a7' }));

  test('chains the stages: -c, -r with restraints, -t when velocities carry over', () => {
    const out = gromacsRunBlock(wf.stages, { resume: false });
    expect(out).toContain('gmx grompp -f em.mdp -p topol.top -c system.gro -o em.tpr -maxwarn 1');
    expect(out).toContain('gmx grompp -f nvt.mdp -p topol.top -c em.gro -r em.gro -o nvt.tpr -maxwarn 1');
    expect(out).toContain('gmx grompp -f npt.mdp -p topol.top -c nvt.gro -r nvt.gro -t nvt.cpt -o npt.tpr -maxwarn 1');
    expect(out).toContain('gmx grompp -f md.mdp -p topol.top -c npt.gro -t npt.cpt -o md.tpr -maxwarn 1');
    expect(out).toMatch(/# -maxwarn 1: grompp stops at any warning unless allowed\. Expected here:\n# {3}GROMOS/);
    expect(out).not.toContain('if [');
  });

  test('restarts, index, GPU flags, PLUMED and files kept in the submission directory', () => {
    const plain = resolveWorkflow(defaultGxState()).stages;
    const out = gromacsRunBlock(plain, {
      gmx: 'gmx_mpi', index: 'index.ndx', indexFromFiles: true, filesDir: '$SUBMIT_DIR/',
      gpuFlags: ' -nb gpu -update gpu', plumed: { on: true, file: 'plumed.dat', scope: 'prod' }
    });
    expect(out).toContain('if [ ! -f md.gro ]; then');
    expect(out).toContain('gmx_mpi grompp -f "$SUBMIT_DIR/em.mdp" -p topol.top -n "$SUBMIT_DIR/index.ndx" -c system.gro -o em.tpr');
    expect(out).toContain('gmx_mpi mdrun -deffnm em -nb gpu -ntomp $OMP_NUM_THREADS -pin on\n');
    expect(out).toContain('gmx_mpi mdrun -deffnm md -nb gpu -update gpu -ntomp $OMP_NUM_THREADS -pin on -cpi md.cpt -plumed plumed.dat');
    expect(out).not.toMatch(/-deffnm nvt[^\n]*-plumed/);
    expect(out).not.toContain('-maxwarn');
  });

  test('new velocities after a dynamics stage: no checkpoint', () => {
    const p = resolveWorkflow(state({ stages: { prod: { velocities: 'new' } } })).stages;
    const out = gromacsRunBlock(p, {});
    expect(out).toContain('-c npt.gro -o md.tpr');
  });
});

describe('small helpers', () => {
  test('parseSchedule', () => {
    expect(parseSchedule('0 300, 200 400; 600:400\n1000,300').points).toEqual([[0, 300], [200, 400], [600, 400], [1000, 300]]);
    expect(parseSchedule('0 300, 10 x').errors[0]).toMatch(/not a time and a temperature/);
    expect(parseSchedule('0 300, 0 310').errors[0]).toMatch(/must increase/);
  });

  test('estimateOutput counts frames from the resolved intervals', () => {
    const prod = byKey(resolveWorkflow(defaultGxState())).prod;
    const e = estimateOutput(prod, 6020);
    expect(e.frames.xtc).toBe(10001);
    expect(e.bytes.xtc).toBeGreaterThan(2e8);
    expect(e.bytes.xtc).toBeLessThan(2.4e8);
    expect(e.frames.trr).toBe(0);
  });

  test('formatBytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(222609622)).toBe('223 MB');
    expect(formatBytes(4.2e9)).toBe('4.2 GB');
  });

  test('the README lists the files, the stages and what grompp will say', () => {
    const wf = resolveWorkflow(state({ forceField: 'gromos54a7' }));
    const md = workflowReadme(wf, { jobName: 'x', natoms: 1000, files: [{ name: 'submit.sh', note: 'the job' }], index: 'index.ndx', indexBuilt: true, date: new Date(2026, 0, 2) });
    expect(md).toMatch(/^# GROMACS workflow: x/);
    expect(md).toContain('| `submit.sh` | the job |');
    expect(md).toContain('| NVT equilibration | `nvt.mdp` | 100 ps | 50,000 | 2 fs | yes | new |');
    expect(md).toContain('submit.sh passes -maxwarn 1');
    expect(md).toContain('## Expected output (1,000 atoms, approximate)');
    expect(md).toContain('2026-01-02');
  });

  test('stage defaults match the page', () => {
    expect(GX_STAGES.map(s => [s.key, s.mdp, s.deffnm, s.on])).toEqual([
      ['em', 'em.mdp', 'em', true], ['nvt', 'nvt.mdp', 'nvt', true], ['npt', 'npt.mdp', 'npt', true],
      ['prod', 'md.mdp', 'md', true], ['anneal', 'anneal.mdp', 'anneal', false], ['pull', 'pull.mdp', 'pull', false]
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Checked against what GROMACS 2025 does with the files and the script
 * ------------------------------------------------------------------ */

const lineOf = (block, re) => (block.split('\n').find(l => re.test(l)) || '').trim();

describe('GPU flags: each stage gets only what mdrun accepts', () => {
  const defaults = gromacsMdrunFlags({ gpus: 1, nb: true, pme: true, gmx: 'gmx' });

  test('page defaults: minimisation keeps -nb gpu only, dynamics keep -pme gpu', () => {
    // pme.cpp: "PME GPU does not support: Non-dynamical integrator".
    const block = gromacsRunBlock(resolveWorkflow(defaultGxState()).stages, { gpuFlags: defaults.flags });
    expect(lineOf(block, /mdrun -deffnm em\b/)).toBe('gmx mdrun -deffnm em -nb gpu -ntmpi 1 -ntomp $OMP_NUM_THREADS -pin on');
    expect(lineOf(block, /mdrun -deffnm nvt\b/)).toContain(' -nb gpu -pme gpu -ntmpi 1 ');
    expect(block).toMatch(/# -pme gpu left out: mdrun computes PME, bonded forces and the update on the GPU only in dynamics/);
  });

  test('-pme, -bonded and -update gpu never reach a minimisation stage', () => {
    const all = gromacsMdrunFlags({ gpus: 1, nb: true, pme: true, bonded: true, update: true, gmx: 'gmx' });
    const plans = resolveWorkflow(state({ stages: { em: { method: 'cg', emtol: 100 } } })).stages;
    const em = plans.filter(p => !p.dynamics);
    expect(em).toHaveLength(2);
    for (const p of em) expect(stageGpuFlags(p, all.flags).flags).toBe(' -nb gpu -ntmpi 1');
    expect(stageGpuFlags(plans.find(p => p.key === 'prod'), all.flags).flags).toBe(' -nb gpu -pme gpu -bonded gpu -update gpu -ntmpi 1');
  });

  test('a reaction-field force field (Martini 3): no -pme gpu, and no -npme, in any stage', () => {
    // pme.cpp: "Systems that do not use PME for electrostatics"; domdec_setup.cpp stops on -npme without PME.
    const wf = resolveWorkflow(state({ forceField: 'martini3', system: 'solution', tcGroups: 'System' }));
    const f = gromacsMdrunFlags({ gpus: 1, nb: true, pme: true, gmx: 'gmx', ntmpi: '2' });
    expect(f.flags).toBe(' -nb gpu -pme gpu -ntmpi 2 -npme 1');
    for (const p of wf.stages) expect(stageGpuFlags(p, f.flags).flags).toBe(' -nb gpu -ntmpi 2');
    expect(gpuFlagWarnings(wf.stages, f.flags).join(' '))
      .toMatch(/`-pme gpu` is left out of nvt\.mdp, npt\.mdp and md\.mdp, where mdrun would stop at start-up: .*coulombtype = Reaction-Field/);
  });

  test('Nose-Hoover or virtual sites: no -update gpu, with the reason', () => {
    // decidegpuusage.cpp: "Nose-Hoover temperature coupling is not supported", "Virtual sites are not supported".
    const f = gromacsMdrunFlags({ gpus: 1, nb: true, pme: true, update: true, gmx: 'gmx' });
    const nh = resolveWorkflow(state({ thermostat: 'nose-hoover' }));
    for (const p of nh.stages) expect(stageGpuFlags(p, f.flags).flags).not.toContain('-update gpu');
    expect(gpuFlagWarnings(nh.stages, f.flags).join(' ')).toMatch(/Nose-Hoover temperature coupling/);
    const prod = byKey(resolveWorkflow(defaultGxState())).prod;
    expect(stageGpuFlags(prod, f.flags).flags).toContain('-update gpu');
    const vs = stageGpuFlags(prod, f.flags, { virtualSites: true, water: 'TIP4P' });
    expect(vs.flags).not.toContain('-update gpu');
    expect(vs.dropped[0].reason).toMatch(/virtual sites \(the TIP4P in the topology header/);
    // Flexible bonds (Martini, constraints = none) are fine for GPU update.
    const cgm = resolveWorkflow(state({ forceField: 'martini3', system: 'solution', tcGroups: 'System' }));
    expect(stageGpuFlags(byKey(cgm).prod, f.flags).flags).toContain('-update gpu');
    // All bonds rigid depends on the molecules: a warning, the flag stays.
    const ab = gromacsMdrunFlags({ gpus: 1, nb: true, update: true, constraints: 'all-bonds' });
    expect(ab.flags).toContain('-update gpu');
    expect(ab.warnings.join(' ')).toMatch(/constraints = h-bonds/);
  });

  test('thread-MPI always gets -ntmpi (1 unless set); an MPI build never does; double precision gets nothing', () => {
    // resourcedivision.cpp: -ntomp without -ntmpi and a GPU in use is fatal
    // unless PME is on the GPU; the MPI build rejects -ntmpi.
    expect(gromacsMdrunFlags({ gpus: 1, nb: true, gmx: 'gmx' }).flags).toBe(' -nb gpu -ntmpi 1');
    expect(gromacsMdrunFlags({ gpus: 1, gmx: 'gmx' }).flags).toBe(' -ntmpi 1');
    expect(gromacsMdrunFlags({ gpus: 1, nb: true, pme: true, gmx: 'gmx', ntmpi: '4' }).flags).toBe(' -nb gpu -pme gpu -ntmpi 4 -npme 1');
    const mpi = gromacsMdrunFlags({ gpus: 1, nb: true, pme: true, gmx: 'gmx_mpi', ntmpi: '2' });
    expect(mpi.flags).toBe(' -nb gpu -pme gpu');
    expect(mpi.warnings.join(' ')).toMatch(/`gmx_mpi` is an MPI build.*left out/);
    const dbl = gromacsMdrunFlags({ gpus: 1, nb: true, gmx: '/opt/gromacs/bin/gmx_mpi_d' });
    expect(dbl.flags).toBe('');
    expect(dbl.warnings.join(' ')).toMatch(/double-precision/);
    expect(gromacsMdrunFlags({ gpus: 0, nb: true, pme: true }).flags).toBe('');
    expect(gmxBuild('gmx_mpi_d')).toMatchObject({ mpi: true, double: true });
    expect(gmxBuild('gmx')).toMatchObject({ mpi: false, double: false });
  });

  test('several nodes with the MPI build: a rank per node through the launcher, grompp without it', () => {
    const f = gromacsMdrunFlags({ gpus: 1, nb: true, pme: true, gmx: 'gmx_mpi', nodes: 2 });
    expect(f.ranks).toBe(2);
    expect(f.flags).toBe(' -nb gpu -pme gpu -npme 1');
    const block = gromacsRunBlock(resolveWorkflow(defaultGxState()).stages, { gmx: 'gmx_mpi', gpuFlags: f.flags, launcher: 'srun' });
    expect(block).toContain('    srun gmx_mpi mdrun -deffnm md -nb gpu -pme gpu -npme 1 -ntomp $OMP_NUM_THREADS');
    expect(block).toContain('    gmx_mpi grompp -f em.mdp');
    expect(block).not.toContain('srun gmx_mpi grompp');
  });
});

describe('the plan describes the final file', () => {
  test('nsteps set by hand: length, steps, header, script and README follow it', () => {
    const wf = resolveWorkflow(state({ overrides: { prod: { nsteps: '1000' } } }));
    const prod = byKey(wf).prod;
    expect(prod.nsteps).toBe(1000);
    expect(stageLength(prod)).toBe('2 ps');
    expect(prod.text.split('\n')[1]).toMatch(/\| 2 ps$/);
    expect(gromacsRunBlock(wf.stages, {})).toContain('# ---- Production: md.mdp -> md.*, 2 ps ----');
    expect(workflowReadme(wf, {})).toContain('| Production | `md.mdp` | 2 ps | 1,000 | 2 fs |');
  });

  test('dt set by hand, and nsteps = -1 as no limit', () => {
    const dt = byKey(resolveWorkflow(state({ overrides: { prod: { dt: '0.001' } } }))).prod;
    expect(dt.dt).toBe(0.001);
    expect(stageLength(dt)).toBe('50 ns');
    const wf = resolveWorkflow(state({ overrides: { prod: { nsteps: '-1' } } }));
    const open = byKey(wf).prod;
    expect(open.unlimited).toBe(true);
    expect(stageLength(open)).toBe('no limit');
    expect(estimateOutput(open, 1000).unknown).toBe(true);
    expect(workflowReadme(wf, {})).toContain('| Production | `md.mdp` | no limit | no limit |');
  });

  test('a barostat set by hand is the one reported', () => {
    const wf = resolveWorkflow(state({ overrides: { npt: { pcoupl: 'Berendsen' } } }));
    const npt = byKey(wf).npt;
    expect(npt.barostat).toBe('berendsen');
    expect(barostatLabel(npt)).toBe('Berendsen');
    expect(workflowReadme(wf, {})).toMatch(/`npt\.mdp`: [^\n]*; barostat Berendsen\./);
    // C-rescale cannot scale anisotropically: the file, and the plan, say Parrinello-Rahman.
    const an = byKey(resolveWorkflow(state({ couplingType: 'anisotropic' })));
    expect(barostatLabel(an.npt)).toBe('Parrinello-Rahman');
  });

  test('restraints switched on under All options get grompp -r', () => {
    // grompp.cpp: "Cannot find position restraint file restraint.gro (option -r)".
    const wf = resolveWorkflow(state({ overrides: { prod: { define: '-DPOSRES' }, nvt: { define: '-DPOSRES_CA' } }, stages: { nvt: { posres: false } } }));
    const block = gromacsRunBlock(wf.stages, { resume: false });
    expect(lineOf(block, /grompp -f md\.mdp/)).toMatch(/-c npt\.gro -r npt\.gro -t npt\.cpt/);
    expect(lineOf(block, /grompp -f nvt\.mdp/)).toMatch(/-c em\.gro -r em\.gro/);
    expect(lineOf(gromacsRunBlock(resolveWorkflow(defaultGxState()).stages, {}), /grompp -f md\.mdp/)).not.toContain(' -r ');
  });
});

describe('index groups the files name', () => {
  test('a membrane with no index: the stages that name SOLU MEMB SOLV need one, and say so everywhere', () => {
    const wf = resolveWorkflow(state({ system: 'membrane', couplingType: 'semiisotropic', tcGroups: 'SOLU MEMB SOLV' }));
    expect(wf.needsIndex).toEqual(['SOLU', 'MEMB', 'SOLV']);
    expect(byKey(wf).nvt.needsIndex).toEqual(['SOLU', 'MEMB', 'SOLV']);
    expect(byKey(wf).em.needsIndex).toEqual([]);
    expect(wf.indexWarning).toMatch(/grompp stops/);
    expect(gromacsRunBlock(wf.stages, {})).toContain('# CHECK: grompp stops unless an index file defines SOLU, MEMB, SOLV; see the page.');
    expect(workflowReadme(wf, {})).toMatch(/`nvt\.mdp`: [^\n]*\n {2}- SOLU, MEMB, SOLV are not groups GROMACS makes by itself/);
    expect(resolveWorkflow(state({ system: 'membrane', tcGroups: 'SOLU MEMB SOLV', hasIndexFile: true })).needsIndex).toEqual([]);
  });

  test('pull groups: without an index they need one; with an index, a missing one stops grompp', () => {
    const pullOn = { stages: { pull: { on: true } } };
    expect(byKey(resolveWorkflow(state(pullOn))).pull.needsIndex).toEqual(['LIG']);
    const idx = { groups: ['System', 'Protein', 'Non-Protein', 'LIG'], natoms: 10 };
    expect(byKey(resolveWorkflow(state({ ...pullOn, index: idx }))).pull.errors).toEqual([]);
    const pull = byKey(resolveWorkflow(state({ ...pullOn, index: idx, stages: { pull: { on: true, pull: { group1: 'Protein', group2: 'FOO' } } } }))).pull;
    expect(pull.errors.map(e => e.message).join(' ')).toMatch(/Group FOO in pull-group2-name is not in the index/);
    expect(pull.grompp.passes).toBe(false);
  });

  test('an index built on an earlier visit, no longer on the page, is said to be missing', () => {
    const wf = resolveWorkflow(state({ tcGroups: 'Protein_LIG Water_and_ions', hasIndexFile: true, indexLost: { name: 'index.ndx', file: 'complex.gro' } }));
    expect(wf.needsIndex).toEqual(['Protein_LIG']);
    expect(wf.indexWarning).toMatch(/index\.ndx, which was built on the page from complex\.gro.*not in the zip/);
    const md = workflowReadme(wf, { index: 'index.ndx', indexBuilt: false, indexLost: { name: 'index.ndx', file: 'complex.gro' } });
    expect(md).toContain('not in this zip');
    expect(md).not.toContain('put your index file next to the run files');
  });

  test('a job array with an index built on the page says every system must match it', () => {
    const md = workflowReadme(resolveWorkflow(defaultGxState()), { index: 'index.ndx', indexBuilt: true, array: true });
    expect(md).toMatch(/Every task of the job array reads the same `index\.ndx`.*atom for atom/);
  });
});

describe('stages', () => {
  test('conjugate gradient runs after a steepest-descent stage of its own', () => {
    // minimize.cpp: "Minimizer 'cg' can not handle constraint failures, use minimizer 'steep' before using 'cg'".
    const wf = resolveWorkflow(state({ stages: { em: { method: 'cg', emtol: 100 } } }));
    expect(wf.stages.map(p => p.key)).toEqual(['em-steep', 'em', 'nvt', 'npt', 'prod']);
    const p = byKey(wf);
    expect(values(p['em-steep'].text).integrator).toBe('steep');
    expect(values(p.em.text).integrator).toBe('cg');
    expect(values(p.em.text).define).toBe('-DFLEXIBLE');
    expect(values(byKey(resolveWorkflow(state({ stages: { em: { method: 'cg', emtol: 100, posres: true } } }))).em.text).define).toBe('-DPOSRES -DFLEXIBLE');
    expect(values(p['em-steep'].text).define).toBeUndefined();
    const block = gromacsRunBlock(wf.stages, { resume: false });
    expect(block).toContain('gmx grompp -f em-steep.mdp -p topol.top -c system.gro -o em-steep.tpr');
    expect(block).toContain('gmx grompp -f em.mdp -p topol.top -c em-steep.gro -o em.tpr');
    expect(resolveWorkflow(state({ stages: { em: { method: 'cg', emtol: 1000 } } })).stages[1].warnings.join(' ')).toMatch(/nothing left to do/);
  });

  test('steered pulling: the travel is checked against the box', () => {
    // pull.cpp: "Distance between pull groups ... is larger than 0.49 times the box size".
    const steer = (lengthPs, rate, box) => byKey(resolveWorkflow(state({ box, stages: { pull: { on: true, lengthPs, pull: { mode: 'steered', rate } } } }))).pull;
    expect(steer(10000, 0.01).pullWarning).toMatch(/moves 100 nm/);
    const cube = [[5, 0, 0], [0, 5, 0], [0, 0, 5]];
    const stop = steer(10000, 0.01, cube);
    expect(stop.mdrunStops.map(i => i.message).join(' ')).toMatch(/passes 2\.45 nm, 0\.49 of this box/);
    expect(steer(100, 0.01, cube).mdrunStops).toEqual([]);
    expect(steer(10000, 0).pullWarning).toBeUndefined();
  });

  test('anisotropic coupling with a triclinic box warns; a rectangular one does not', () => {
    const dodecahedron = [[5, 0, 0], [0, 5, 0], [2.5, 2.5, 3.54]];
    expect(resolveWorkflow(state({ couplingType: 'anisotropic', box: dodecahedron })).warnings.join(' ')).toMatch(/too skewed/);
    expect(resolveWorkflow(state({ couplingType: 'anisotropic', box: [[5, 0, 0], [0, 5, 0], [0, 0, 5]] })).warnings).toEqual([]);
  });

  test('HMR in a liquid: the C=O note depends on the molecules, so it is not counted', () => {
    const liquid = resolveWorkflow(state({ hmr: true, system: 'solution', tcGroups: 'System', stages: { nvt: { posres: false }, npt: { posres: false } } }));
    expect(byKey(liquid).prod.grompp.notes).toBe(0);
    expect(byKey(liquid).prod.conditionalNotes).toHaveLength(1);
    expect(workflowReadme(liquid, {})).toContain('1 more note if the molecules have bonds between heavy atoms');
    expect(byKey(resolveWorkflow(state({ hmr: true }))).prod.grompp.notes).toBe(1);
  });
});

describe('the job script', () => {
  test('restarts off: no -cpi, and the README says every stage starts over', () => {
    const wf = resolveWorkflow(defaultGxState());
    expect(gromacsRunBlock(wf.stages, { resume: false })).not.toContain('-cpi');
    expect(gromacsRunBlock(wf.stages, {})).toContain('-cpi md.cpt');
    const off = workflowReadme(wf, { resume: false });
    expect(off).not.toContain('Each stage is skipped');
    expect(off).toContain('starts the whole workflow over');
    expect(workflowReadme(wf, {})).toContain('Each stage is skipped once its final .gro exists');
  });

  test('file names with spaces are quoted', () => {
    expect(shellWord('em.mdp')).toBe('em.mdp');
    expect(shellWord('my nvt.mdp')).toBe('"my nvt.mdp"');
    expect(shellWord('a"b`c')).toBe('"a\\"b\\`c"');
    expect(shellWord('$HOME/my topol.top')).toBe('"$HOME/my topol.top"');
    const wf = resolveWorkflow(state({ stages: { nvt: { mdp: 'my nvt.mdp', deffnm: 'my nvt' } } }));
    const block = gromacsRunBlock(wf.stages, { topol: 'my topol.top' });
    expect(block).toContain('if [ ! -f "my nvt.gro" ]; then');
    expect(block).toContain('gmx grompp -f "my nvt.mdp" -p "my topol.top" -c em.gro -r em.gro -o "my nvt.tpr"');
    expect(block).toContain('gmx mdrun -deffnm "my nvt" -ntomp $OMP_NUM_THREADS -pin on -cpi "my nvt.cpt"');
    expect(block).toContain('-c "my nvt.gro" -r "my nvt.gro" -t "my nvt.cpt" -o npt.tpr');
    const arr = gromacsRunBlock(wf.stages, { filesDir: '$SUBMIT_DIR/' });
    expect(arr).toContain('-f "$SUBMIT_DIR/my nvt.mdp"');
  });
});

describe('rigid bonds follow the force field', () => {
  test('the default state takes the force field\'s bonds: all of them for GROMOS', () => {
    expect(defaultGxState().constraints).toBe('h-bonds');
    expect(defaultGxState('gromos54a7').constraints).toBe('all-bonds');
    expect(defaultGxState('martini3').constraints).toBe('none');
    // A state that leaves the bonds out gets the force field's.
    const wf = resolveWorkflow({ forceField: 'gromos54a7' });
    expect(wf.constraints).toBe('all-bonds');
    const p = byKey(wf);
    expect(values(p.em.text).constraints).toBe('none');
    expect(p.prod.text).toMatch(/^constraints\s+= all-bonds\s+; GROMOS was parametrised with all bond lengths constrained/m);
    expect(p.prod.text).toMatch(/^dt\s+= 0\.002\s+; 2 fs, possible because all bonds are constrained$/m);
    expect(p.prod.changed).toEqual([]);
    expect(p.prod.maxwarn).toBe(1);
  });

  test('bonds to hydrogen chosen for GROMOS: the constraints, dt and HMR comments say so', () => {
    const p = byKey(resolveWorkflow(state({ forceField: 'gromos54a7', constraints: 'h-bonds', hmr: true }))).prod;
    expect(p.text).toMatch(/^constraints\s+= h-bonds\s+; only the bonds to hydrogen are rigid \(chosen under System\)$/m);
    expect(p.text).toMatch(/^dt\s+= 0\.004\s+; 4 fs, possible because hydrogens are 3x heavier \(mass-repartition-factor\) and bonds to hydrogen are constrained$/m);
    expect(p.text).toMatch(/^mass-repartition-factor\s+= 3\.0\s+; .*allows 4 fs\)$/m);
    expect(p.text).not.toMatch(/all bonds are/);
    expect(p.overridden).toEqual([]);
    expect(p.errors).toEqual([]);
  });

  test('all bonds chosen for AMBER: every bond is rigid, and the time step says why', () => {
    const p = byKey(resolveWorkflow(state({ constraints: 'all-bonds' }))).nvt;
    expect(p.text).toMatch(/^constraints\s+= all-bonds\s+; every bond is rigid \(chosen under System\)$/m);
    expect(p.text).toMatch(/^dt\s+= 0\.002\s+; 2 fs, possible because all bonds are constrained$/m);
  });
});

describe('pull groups: a central atom each for their periodic images', () => {
  // Distance between two periodic images, the shortest over the 27 nearest.
  const minImage = (a, b, box) => {
    let best = Infinity;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
      const d = [0, 1, 2].map(m => b[m] - a[m] + i * box[0][m] + j * box[1][m] + k * box[2][m]);
      best = Math.min(best, Math.hypot(...d));
    }
    return best;
  };
  const xyz = (a) => [a.x, a.y, a.z];

  test('a group split across the box edge gets an atom inside it, not the empty middle', () => {
    const box = [[4, 0, 0], [0, 4, 0], [0, 0, 4]];
    const coords = [3.9, 3.95, 0.05, 0.1].map(x => ({ x, y: 2, z: 2 }));
    const c = centralAtom(coords, [1, 2, 3, 4], box);
    expect([2, 3]).toContain(c);
    // Without a box, the plain centroid; an empty group has none.
    expect([1, 2, 3, 4]).toContain(centralAtom(coords, [1, 2, 3, 4]));
    expect(centralAtom(coords, [])).toBe(0);
    expect(centralAtom(coords, [0, 9])).toBe(0);
  });

  test('a membrane gets an atom of its mid-plane, even split across the box', () => {
    const slab = (zs) => {
      const coords = [];
      for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) for (const z of zs) coords.push({ x: 0.4 * i + 0.2, y: 0.4 * j + 0.2, z });
      return coords;
    };
    const box = [[4, 0, 0], [0, 4, 0], [0, 0, 10]];
    const mid = slab([4, 4.5, 5, 5.5, 6]);
    expect(mid[centralAtom(mid, mid.map((_, i) => i + 1), box) - 1].z).toBe(5);
    const split = slab([9, 9.5, 0, 0.5, 1]);
    expect(split[centralAtom(split, split.map((_, i) => i + 1), box) - 1].z).toBe(0);
  });

  test('a ligand wrapped across a corner of a rhombic dodecahedron', () => {
    const top = readGromacsStructure(periodicSystemGro(), 'gro');
    const lig = [];
    top.atoms.forEach((a, i) => { if (top.residues[a.resIndex].name === 'LIG') lig.push(i + 1); });
    expect(lig.length).toBeGreaterThan(3);
    const c = centralAtom(top.atoms, lig, top.box);
    expect(lig).toContain(c);
    // The farthest atom of the ligand is as near as it can be: no other
    // ligand atom has all the others closer.
    const far = (a) => Math.max(...lig.map(n => minImage(xyz(top.atoms[a - 1]), xyz(top.atoms[n - 1]), top.box)));
    expect(far(c)).toBeCloseTo(Math.min(...lig.map(far)), 6);
    expect(far(c)).toBeLessThan(0.31);
  });

  test('the pull file names them, with pull-pbc-ref-prev-step-com; without a structure it says one is needed', () => {
    const idx = { groups: ['System', 'Protein', 'Non-Protein', 'LIG'], natoms: 3000 };
    const p = byKey(resolveWorkflow(state({ index: idx, stages: { pull: { on: true, pull: { group1: 'Protein', group2: 'LIG', pbcatom1: 812, pbcatom2: 1403 } } } }))).pull;
    const v = values(p.text);
    expect([v['pull-group1-pbcatom'], v['pull-group2-pbcatom'], v['pull-pbc-ref-prev-step-com']]).toEqual(['812', '1403', 'yes']);
    expect(p.pbcAtoms).toEqual([812, 1403]);
    expect(p.warnings.join(' ')).not.toMatch(/quarter of the box/);
    expect(p.errors).toEqual([]);
    const bare = byKey(resolveWorkflow(state({ stages: { pull: { on: true } } }))).pull;
    expect(values(bare.text)['pull-group1-pbcatom']).toBeUndefined();
    expect(bare.warnings.join(' ')).toMatch(/quarter of the box/);
    // The default pulled group, LIG, is not a group GROMACS makes by itself.
    expect(bare.needsIndex).toEqual(['LIG']);
  });

  test('a module\'s default group is looked up only while the module is on, and a missing pull group is one error', () => {
    // checkMdp's settings hold density-guided-simulation-group = protein with
    // the module off; grompp never looks it up, so an index with no Protein
    // (a liquid, a bilayer of lipids alone) is fine.
    const liquid = resolveWorkflow(state({ system: 'solution', tcGroups: 'System', index: { groups: ['System', 'Other', 'SOL'], natoms: 30 },
      stages: { nvt: { posres: false }, npt: { posres: false } } }));
    for (const p of liquid.stages) expect([p.key, p.errors]).toEqual([p.key, []]);
    const pull = byKey(resolveWorkflow(state({ index: { groups: ['System', 'Protein', 'Non-Protein'], natoms: 10 }, stages: { pull: { on: true } } }))).pull;
    expect(pull.errors.filter(e => /\bLIG\b/.test(e.message))).toHaveLength(1);
    expect(pull.grompp.passes).toBe(false);
  });
});

describe('PLUMED: the input is not in the zip, and the script and README say so', () => {
  const wf = resolveWorkflow(defaultGxState());

  test('the stages whose mdrun reads it', () => {
    expect(plumedStages(wf.stages, { on: true, scope: 'prod' }).map(p => p.key)).toEqual(['prod']);
    expect(plumedStages(wf.stages, { on: true, scope: 'all' }).map(p => p.key)).toEqual(['nvt', 'npt', 'prod']);
    expect(plumedStages(wf.stages, { on: false, scope: 'all' })).toEqual([]);
    const noProd = resolveWorkflow(state({ stages: { prod: { on: false } } }));
    expect(plumedStages(noProd.stages, { on: true, scope: 'prod' })).toEqual([]);
    expect(gromacsRunBlock(noProd.stages, { plumed: { on: true, scope: 'prod' } })).not.toMatch(/plumed/i);
  });

  test('submit.sh stops before the first stage while the input is missing', () => {
    const block = gromacsRunBlock(wf.stages, { resume: false, plumed: { on: true, file: 'my plumed.dat', scope: 'prod' } });
    const guard = block.slice(0, block.indexOf('# ---- Energy minimisation'));
    expect(guard).toContain('# PLUMED: mdrun reads my plumed.dat (-plumed) in production.');
    expect(guard).toContain('if [ ! -f "my plumed.dat" ]; then');
    expect(block).toContain('-plumed "my plumed.dat"');
    expect(gromacsRunBlock(wf.stages, {})).not.toMatch(/plumed/i);
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stemkit-plumed-'));
    try {
      const missing = spawnSync('bash', ['-c', guard], { cwd: d, encoding: 'utf8' });
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain('my plumed.dat is missing: mdrun -plumed reads it.');
      fs.writeFileSync(path.join(d, 'my plumed.dat'), 'd: DISTANCE ATOMS=1,2\n');
      expect(spawnSync('bash', ['-c', guard], { cwd: d, encoding: 'utf8' }).status).toBe(0);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  test('the README says to add it, with the files the PLUMED tab wrote for its INCLUDE lines', () => {
    const md = workflowReadme(wf, { plumed: { on: true, file: 'plumed.dat', scope: 'all', includes: ['groups.dat'] } });
    expect(md).toContain('**`plumed.dat` is not in this zip.** mdrun reads it with -plumed when it runs `nvt.mdp`, `npt.mdp` and `md.mdp`.');
    expect(md).toContain('wrote `groups.dat`');
    expect(md).toContain('submit.sh stops before the first stage while `plumed.dat` is missing.');
    expect(workflowReadme(wf, {})).not.toMatch(/plumed/i);
  });

  test('once the PLUMED tab has built the input, the README says the zip holds it, and names what it lacks', () => {
    const text = 'INCLUDE FILE=groups.dat\nINCLUDE FILE=extra.dat\nd: DISTANCE ATOMS=1,2\nPRINT ARG=d FILE=COLVAR\n';
    const md = workflowReadme(wf, { plumed: {
      on: true, file: 'plumed.dat', scope: 'all', includes: ['groups.dat'], inZip: ['plumed.dat', 'groups.dat'], text
    } });
    expect(md).toContain('`plumed.dat` is in this zip, as the PLUMED tab built it, with `groups.dat` that its INCLUDE lines read.');
    expect(md).toContain('mdrun reads it with -plumed when it runs `nvt.mdp`, `npt.mdp` and `md.mdp`.');
    expect(md).toContain('Its INCLUDE lines also read `extra.dat`, which the PLUMED tab does not hold');
    expect(md).not.toContain('is not in this zip');
    // The input alone, with nothing missing.
    const alone = workflowReadme(wf, { plumed: { on: true, file: 'plumed.dat', scope: 'prod', inZip: ['plumed.dat'], text: 'd: DISTANCE ATOMS=1,2\n' } });
    expect(alone).toContain('`plumed.dat` is in this zip, as the PLUMED tab built it. mdrun reads it with -plumed when it runs `md.mdp`.');
    expect(alone).not.toMatch(/INCLUDE lines also read/);
  });
});

/*
 * With GROMACS installed (GMX_BIN, or gmx / gmx_mpi on the PATH), the lines
 * the script writes are run as they are, on a small box of TIP3P water.
 * mdrun runs with one thread and a few steps; with an NVIDIA GPU and a GPU
 * build it also runs the GPU flags the page writes. Without GROMACS these
 * tests are skipped.
 */
const GMX = [process.env.GMX_BIN, 'gmx', 'gmx_mpi']
  .find(g => g && spawnSync(g, ['--version'], { encoding: 'utf8' }).status === 0) || '';
const withGromacs = GMX ? describe : describe.skip;
const gpuBuild = GMX && /GPU support:\s+(CUDA|SYCL)/.test(spawnSync(GMX, ['-quiet', '--version'], { encoding: 'utf8' }).stdout || '')
  && spawnSync('nvidia-smi', ['-L'], { encoding: 'utf8' }).status === 0;

withGromacs('the script\'s lines, run by GROMACS', () => {
  let dir = '';
  const tmpDirs = [];
  const threads = () => (gmxBuild(GMX).mpi ? '' : ' -ntmpi 1');
  const sh = (cwd, line, env = {}) => spawnSync('bash', ['-c', line.replace('-pin on', '-pin off')], {
    cwd, encoding: 'utf8', env: { ...process.env, OMP_NUM_THREADS: '1', ...env }
  });
  const fresh = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stemkit-gx-'));
    tmpDirs.push(d);
    for (const f of ['topol.top', 'system.gro']) fs.copyFileSync(path.join(dir, f), path.join(d, f));
    return d;
  };
  const write = (d, plans) => { for (const p of plans) fs.writeFileSync(path.join(d, p.file), p.text); };
  const liquid = (over = {}) => state({ system: 'solution', tcGroups: 'System', ...over,
    stages: { nvt: { posres: false }, npt: { posres: false }, ...(over.stages || {}) } });

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stemkit-gx-'));
    tmpDirs.push(dir);
    // A restraint behind a macro of the topology's own, as -DPOSRES_CA is.
    fs.writeFileSync(path.join(dir, 'topol.top'),
      '#include "amber99sb-ildn.ff/forcefield.itp"\n#include "amber99sb-ildn.ff/tip3p.itp"\n' +
      '#ifdef POSRES_CA\n[ position_restraints ]\n1 1 1000 1000 1000\n#endif\n[ system ]\nwater\n[ molecules ]\n');
    const r = spawnSync(GMX, ['-quiet', 'solvate', '-cs', 'spc216.gro', '-box', '2.5', '2.5', '2.5', '-o', 'system.gro', '-p', 'topol.top'],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, OMP_NUM_THREADS: '1' } });
    if (r.status !== 0) throw new Error(r.stderr);
  }, 60000);
  afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

  test('restraints switched on under All options: grompp passes with the -r the script adds', () => {
    const d = fresh();
    const wf = resolveWorkflow(liquid({ overrides: { nvt: { define: '-DPOSRES_CA' } } }));
    write(d, wf.stages);
    fs.copyFileSync(path.join(d, 'system.gro'), path.join(d, 'em.gro'));
    const line = lineOf(gromacsRunBlock(wf.stages, { gmx: GMX, resume: false }), /grompp -f nvt\.mdp/);
    expect(line).toContain('-r em.gro');
    expect(sh(d, line).status).toBe(0);
    const without = sh(d, line.replace(' -r em.gro', ''));
    expect(without.status).not.toBe(0);
    expect(without.stderr + without.stdout).toMatch(/position restraint file/);
  }, 60000);

  test('group names: what the page predicts is what grompp does', () => {
    const d = fresh();
    const memb = resolveWorkflow(liquid({ tcGroups: 'SOLU MEMB SOLV' }));
    expect(byKey(memb).nvt.needsIndex).toEqual(['SOLU', 'MEMB', 'SOLV']);
    write(d, memb.stages);
    const r = sh(d, `${GMX} grompp -f nvt.mdp -c system.gro -p topol.top -o nvt.tpr`);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/Group SOLU referenced in the \.mdp file was not found/);

    const natoms = Number(fs.readFileSync(path.join(d, 'system.gro'), 'utf8').split('\n')[1]);
    const ids = Array.from({ length: natoms }, (_, i) => i + 1);
    const all = ids.map((n, i) => (i % 15 === 14 ? `${n}\n` : `${n} `)).join('');
    fs.writeFileSync(path.join(d, 'index.ndx'), `[ System ]\n${all}\n[ SOL ]\n${all}\n`);
    const pull = { on: true, pull: { group1: 'SOL', group2: 'LIG' } };
    const wf = resolveWorkflow(liquid({ index: { groups: ['System', 'SOL'], natoms }, stages: { pull } }));
    const p = byKey(wf).pull;
    expect(p.errors.map(e => e.message).join(' ')).toMatch(/Group LIG in pull-group2-name is not in the index/);
    write(d, wf.stages);
    const g = sh(d, `${GMX} grompp -f pull.mdp -c system.gro -p topol.top -n index.ndx -o pull.tpr`);
    expect(g.status).not.toBe(0);
    expect(g.stderr + g.stdout).toMatch(/Group LIG referenced in the \.mdp file was not found/);
  }, 60000);

  test('conjugate gradient after steepest descent runs; file names with spaces run as written', () => {
    const d = fresh();
    fs.renameSync(path.join(d, 'topol.top'), path.join(d, 'my topol.top'));
    const wf = resolveWorkflow(liquid({
      stages: { em: { method: 'cg', emtol: 100, deffnm: 'my em', mdp: 'my em.mdp' }, nvt: { on: false }, npt: { on: false }, prod: { on: false } },
      overrides: { 'em-steep': { nsteps: '50' }, em: { nsteps: '50' } }
    }));
    write(d, wf.stages);
    const block = gromacsRunBlock(wf.stages, { gmx: GMX, topol: 'my topol.top', resume: false, gpuFlags: threads() });
    const lines = block.split('\n').filter(l => /grompp|mdrun/.test(l) && !l.startsWith('#'));
    expect(lines).toHaveLength(4);
    for (const l of lines) {
      const r = sh(d, l, { GMX_DISABLE_GPU_DETECTION: '1' });
      expect([l, r.status]).toEqual([l, 0]);
    }
    expect(fs.existsSync(path.join(d, 'my em.gro'))).toBe(true);
  }, 120000);

  test('pull groups with the page\'s central atoms: grompp passes and mdrun runs; without them grompp stops', () => {
    const d = fresh();
    const top = readGromacsStructure(fs.readFileSync(path.join(d, 'system.gro'), 'utf8'), 'system.gro');
    const L = top.box[0][0];
    // A slab of water 0.64 box lengths thick, split across the x = 0 face:
    // no atom of it lies within a quarter of the box of all the others, so
    // grompp needs a reference atom (readpull.cpp), and only one found
    // through the periodic boundary sits inside the slab.
    const mols = [];
    top.atoms.forEach((a, i) => { if (a.name === 'OW') mols.push({ x: a.x, y: a.y, z: a.z, atoms: [i + 1, i + 2, i + 3] }); });
    const slab = mols.filter(m => m.x < 0.32 * L || m.x > 0.68 * L).flatMap(m => m.atoms);
    const off = (m) => Math.hypot(m.x - 0.4 * L, m.y - 0.5 * L, m.z - 0.5 * L);
    const one = mols.filter(m => m.x >= 0.32 * L && m.x <= 0.68 * L).sort((a, b) => off(a) - off(b))[0].atoms;
    const natoms = top.atoms.length;
    fs.writeFileSync(path.join(d, 'index.ndx'), writeNdx([
      { name: 'System', atoms: top.atoms.map((_, i) => i + 1) }, { name: 'Slab', atoms: slab }, { name: 'One', atoms: one }]));
    const pullStage = (pbcatom1, pbcatom2) => byKey(resolveWorkflow(liquid({
      index: { groups: ['System', 'Slab', 'One'], natoms },
      stages: { em: { on: false }, nvt: { on: false }, npt: { on: false }, prod: { on: false },
        pull: { on: true, ensemble: 'NVT', pull: { group1: 'Slab', group2: 'One', dim: 'Y N N', pbcatom1, pbcatom2 } } },
      overrides: { pull: { nsteps: '10' } }
    }))).pull;
    const grompp = `${GMX} grompp -f pull.mdp -c system.gro -p topol.top -n index.ndx -o pull.tpr`;
    const c1 = centralAtom(top.atoms, slab, top.box);
    const p = pullStage(c1, centralAtom(top.atoms, one, top.box));
    expect(p.errors).toEqual([]);
    expect(values(p.text)['pull-group1-pbcatom']).toBe(String(c1));
    fs.writeFileSync(path.join(d, 'pull.mdp'), p.text);
    const ok = sh(d, grompp);
    expect([ok.status, ok.status ? ok.stderr.slice(-600) : '']).toEqual([0, '']);
    const threads = gmxBuild(GMX).mpi ? '-ntomp 2' : '-ntmpi 1 -ntomp 2';
    const md = sh(d, `${GMX} mdrun -deffnm pull ${threads} -pin off`, { OMP_NUM_THREADS: '2', GMX_DISABLE_GPU_DETECTION: '1' });
    expect([md.status, md.status ? md.stderr.slice(-600) : '']).toEqual([0, '']);
    expect(fs.existsSync(path.join(d, 'pull_pullx.xvg'))).toBe(true);

    // No reference atom: grompp takes the middle one by number and stops.
    fs.writeFileSync(path.join(d, 'pull.mdp'), pullStage(0, 0).text);
    const none = sh(d, grompp);
    expect(none.status).not.toBe(0);
    expect(none.stderr + none.stdout).toMatch(/centrally\s+placed\s+atom\s+should\s+be\s+chosen\s+as\s+pbcatom/);
    // The centroid without the periodic boundary lies between the two halves
    // of the slab: its nearest atom is at the slab's edge, and grompp stops.
    fs.writeFileSync(path.join(d, 'pull.mdp'), pullStage(centralAtom(top.atoms, slab, null), 0).text);
    expect(sh(d, grompp).status).not.toBe(0);
  }, 120000);

  test('GROMOS with all bonds rigid, as the page now writes it: grompp passes and mdrun runs', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stemkit-gx-'));
    tmpDirs.push(d);
    // A small peptide, GLY-ALA-ALA-ALA, heavy atoms only; pdb2gmx adds the
    // GROMOS hydrogens.
    const atoms = [
      ['N', 'GLY', 1, 0, 0, 0], ['CA', 'GLY', 1, 1.458, 0, 0], ['C', 'GLY', 1, 2.005, 0.712, -1.233], ['O', 'GLY', 1, 2.904, 1.546, -1.126],
      ['N', 'ALA', 2, 1.456, 0.376, -2.396], ['CA', 'ALA', 2, 1.887, 0.982, -3.65], ['C', 'ALA', 2, 1.753, 2.501, -3.603], ['O', 'ALA', 2, 2.675, 3.221, -3.985], ['CB', 'ALA', 2, 3.331, 0.581, -3.957],
      ['N', 'ALA', 3, 0.603, 2.974, -3.135], ['CA', 'ALA', 3, 0.347, 4.406, -3.038], ['C', 'ALA', 3, 1.406, 5.099, -2.186], ['O', 'ALA', 3, 1.939, 6.138, -2.576], ['CB', 'ALA', 3, 0.294, 5.025, -4.436],
      ['N', 'ALA', 4, 1.7, 4.518, -1.028], ['CA', 'ALA', 4, 2.695, 5.078, -0.121], ['C', 'ALA', 4, 4.046, 5.232, -0.811], ['O', 'ALA', 4, 4.683, 6.281, -0.709], ['CB', 'ALA', 4, 2.211, 6.425, 0.419]
    ];
    const f = (v) => v.toFixed(3).padStart(8);
    fs.writeFileSync(path.join(d, 'pep.pdb'), `${atoms.map(([n, r, nr, x, y, z], i) =>
      `ATOM  ${String(i + 1).padStart(5)}  ${n.padEnd(3)} ${r} A${String(nr).padStart(4)}    ${f(x)}${f(y)}${f(z)}  1.00  0.00           ${n[0]}`).join('\n')}\nEND\n`);
    for (const line of [
      `${GMX} pdb2gmx -f pep.pdb -o pep.gro -p topol.top -ff gromos54a7 -water spc -ignh`,
      `${GMX} editconf -f pep.gro -o box.gro -box 3 -c`,
      `${GMX} solvate -cp box.gro -cs spc216.gro -o system.gro -p topol.top`
    ]) {
      const r = sh(d, line);
      expect([line, r.status]).toEqual([line, 0]);
    }
    const wf = resolveWorkflow(state({ forceField: 'gromos54a7', stages: { npt: { on: false }, prod: { on: false } },
      overrides: { em: { nsteps: '500' }, nvt: { nsteps: '50' } } }));
    expect(values(byKey(wf).nvt.text).constraints).toBe('all-bonds');
    write(d, wf.stages);
    const block = gromacsRunBlock(wf.stages, { gmx: GMX, resume: false, gpuFlags: threads() });
    const lines = block.split('\n').filter(l => /grompp|mdrun/.test(l) && !l.startsWith('#'));
    expect(lines.filter(l => / grompp /.test(l)).every(l => l.endsWith('-maxwarn 1'))).toBe(true);
    for (const l of lines) {
      const r = sh(d, l, { GMX_DISABLE_GPU_DETECTION: '1' });
      expect([l, r.status, r.status ? (r.stderr || '').slice(-600) : '']).toEqual([l, 0, '']);
    }
    expect(fs.readFileSync(path.join(d, 'nvt.log'), 'utf8')).not.toMatch(/LINCS WARNING/);
  }, 180000);

  (gpuBuild ? test : test.skip)('on a GPU: the page\'s flags run for minimisation, reaction field and Nose-Hoover', () => {
    const d = fresh();
    const nsteps = { nsteps: '20' };
    const run = (wf, flags, keys) => {
      write(d, wf.stages);
      const block = gromacsRunBlock(wf.stages, { gmx: GMX, resume: false, gpuFlags: flags });
      for (const l of block.split('\n').filter(x => /grompp|mdrun/.test(x) && !x.startsWith('#'))) {
        if (!keys.some(k => l.includes(`-deffnm ${k} `) || l.includes(`-o ${k}.tpr`))) continue;
        const r = sh(d, l);
        expect([l, r.status, r.status ? (r.stderr || '').slice(-400) : '']).toEqual([l, 0, '']);
      }
    };
    // A box of water has nothing bonded, so no -bonded gpu (the page warns).
    const all = gromacsMdrunFlags({ gpus: 1, nb: true, pme: true, update: true, gmx: GMX }).flags;
    run(resolveWorkflow(liquid({ overrides: { em: nsteps, nvt: nsteps } })), all, ['em', 'nvt']);
    run(resolveWorkflow(liquid({ thermostat: 'nose-hoover', overrides: { nvt: nsteps } })), all, ['nvt']);
    run(resolveWorkflow(liquid({ overrides: { nvt: { ...nsteps, coulombtype: 'Reaction-Field', 'epsilon-rf': '0' } } })), all, ['nvt']);
  }, 180000);
});
