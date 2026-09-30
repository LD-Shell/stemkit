import { describe, test, expect } from '@jest/globals';
import {
  GX_STAGES, defaultGxState, resolveWorkflow, applyOverrides, diffOverrides, sameMdpValue,
  gromacsRunBlock, estimateOutput, formatBytes, parseSchedule, workflowReadme, builderFromMdp
} from '../js/script-generator-gromacs-model.js';
import { parseMdp, checkMdp, FORCE_FIELDS } from '../src/core/gromacs-mdp.js';

const state = (over = {}) => {
  const s = defaultGxState();
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
