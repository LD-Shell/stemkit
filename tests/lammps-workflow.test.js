import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  LMP_FORCE_FIELDS, LMP_FORCE_FIELD, LMP_THERMOSTATS, LMP_BAROSTATS, LMP_STAGES, LMP_DUMP_FORMATS, LMP_FF_FIELDS,
  defaultLammpsState, buildLammpsWorkflow, lammpsRunBlock, lammpsReadme, toSteps, formatTime,
  estimateLammpsOutput, shellValue, fmtNum
} from '../src/core/lammps-workflow.js';
import { launcher } from '../src/core/scheduler.js';
import { parseDataFile, summariseData, groupsFromData } from '../src/core/lammps-data.js';

let checkInput = null;
try { ({ checkInput } = await import('../src/core/lammps-input.js')); } catch { checkInput = null; }

const here = path.dirname(fileURLToPath(import.meta.url));
const LAMMPS = process.env.LAMMPS_SRC || path.join(here, '..', 'lammps');
const hasExamples = fs.existsSync(path.join(LAMMPS, 'examples', 'peptide', 'data.peptide'));

const file = (wf, name) => wf.files.find(f => f.name === name);
const text = (wf, name) => (file(wf, name) || { text: '' }).text;
const commands = (t) => t.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));

/* A state for a preset that builds cleanly without a data file. */
function stateFor(id) {
  const st = defaultLammpsState(id);
  if (id === 'custom') st.ff.lines = 'units real\natom_style full\npair_style lj/cut/coul/long 10.0\nbond_style harmonic\nangle_style harmonic\nkspace_style pppm 1.0e-4';
  if (LMP_FORCE_FIELD[id].family === 'Biomolecular') st.restraint.group = 'type 1:4';
  if (LMP_FORCE_FIELD[id].family === 'Water') st.waterTypes = { o: 1, h: 2, bond: 1, angle: 1 };
  return st;
}

const PLUMED = { files: [{ name: 'plumed.dat', text: 'UNITS LENGTH=A\nd: DISTANCE ATOMS=1,2\nmetad: METAD ARG=d SIGMA=0.1 HEIGHT=0.5 PACE=500 FILE=HILLS\nPRINT ARG=d,metad.bias STRIDE=100 FILE=COLVAR\n' }] };

/* A small summary of the kind src/core/lammps-data.js gives. */
function fakeData(over = {}) {
  return {
    natoms: 3000, atomStyle: 'full', charge: 0, hasCharges: true, density: 1.0,
    types: [{ type: 1, mass: 12.011, charge: 0.5 }, { type: 2, mass: 1.008, charge: 0.1 }, { type: 3, mass: 15.999, charge: -1.0 }, { type: 4, mass: 1.008, charge: 0.4 }],
    hydrogenTypes: [2, 4], soluteTypes: [1, 2], ions: [],
    water: { model: 'TIP3P', oType: 3, hType: 4, bondType: 2, angleType: 3, count: 900 },
    shake: { m: [1.008], b: [1, 2], a: [3] },
    box: { xlo: 0, xhi: 30, ylo: 0, yhi: 30, zlo: 0, zhi: 30, xy: 0, xz: 0, yz: 0, triclinic: false },
    topology: { bonds: 2000 },
    coeffs: { pair: true, bond: true, angle: true, styles: {} },
    ...over
  };
}

describe('presets and the files they make', () => {
  test.each(LMP_FORCE_FIELDS.map(f => [f.id]))('%s: the stage files, the shared files and no errors', (id) => {
    const wf = buildLammpsWorkflow(stateFor(id));
    const names = wf.files.map(f => f.name);
    expect(names).toEqual(expect.arrayContaining(['in.system', 'in.settings', 'in.min', 'in.nvt', 'in.npt', 'in.prod', 'README.md']));
    expect(wf.issues.filter(i => i.severity === 'error')).toEqual([]);
    expect(wf.units).toBe(LMP_FORCE_FIELD[id].units === 'real' && id === 'custom' ? 'real' : LMP_FORCE_FIELD[id].units);
    // The first stage reads in.system, the others the restart file of the stage before.
    expect(text(wf, 'in.min')).toMatch(/^include\s+in\.system$/m);
    expect(text(wf, 'in.nvt')).toMatch(/"read_restart min\.restart"/);
    expect(text(wf, 'in.npt')).toMatch(new RegExp(`"read_restart nvt\\.restart\\.${wf.stages[1].steps}"`));
    expect(text(wf, 'in.prod')).toMatch(/"read_restart restart\.\$\{rstep\}"/);
    for (const name of ['in.nvt', 'in.npt', 'in.prod', 'in.min']) expect(text(wf, name)).toMatch(/^include\s+in\.settings$/m);
    expect(text(wf, 'in.prod')).toMatch(/^run\s+\d+ upto$/m);
    expect(text(wf, 'in.prod')).toMatch(/^restart\s+\d+ restart\.\*$/m);
    expect(text(wf, 'in.prod')).toMatch(/^timer\s+timeout \$\{time_limit\} every 100$/m);
  });

  test.each(LMP_FORCE_FIELDS.map(f => [f.id]))('%s: every command line has a note', (id) => {
    const st = stateFor(id);
    st.stages.min.boxRelax = LMP_FORCE_FIELD[id].family === 'Materials';
    const wf = buildLammpsWorkflow(st, { plumed: PLUMED });
    for (const f of wf.files.filter(x => x.kind === 'lammps')) {
      const lines = f.text.split('\n');
      let continued = false;
      lines.forEach((l, i) => {
        const inside = continued;
        continued = /&\s*$/.test(l);
        if (inside || !l.trim() || l.startsWith('#')) return;
        expect([f.name, i + 1, l, typeof f.notes[i + 1]]).toEqual([f.name, i + 1, l, 'string']);
        expect(f.notes[i + 1].length).toBeGreaterThan(15);
      });
    }
  });

  test.each(LMP_FORCE_FIELDS.map(f => [f.id]))('%s: no section header without lines under it', (id) => {
    const wf = buildLammpsWorkflow(stateFor(id), { plumed: PLUMED });
    for (const f of wf.files.filter(x => x.kind === 'lammps')) {
      const lines = f.text.split('\n');
      lines.forEach((l, i) => {
        if (!/^# ----/.test(l)) return;
        const next = lines.slice(i + 1).find(x => x.trim() !== '');
        expect([f.name, l, !!next && !/^# ----/.test(next)]).toEqual([f.name, l, true]);
      });
    }
  });

  test.each(LMP_FORCE_FIELDS.map(f => [f.id]))('%s: no charges asked of an atom style without them', (id) => {
    for (const format of ['custom', 'atom']) {
      const st = stateFor(id);
      st.dump.format = format;
      const wf = buildLammpsWorkflow(st, { plumed: PLUMED });
      const all = wf.files.filter(f => f.kind === 'lammps').map(f => f.text).join('\n');
      // LAMMPS 29 Aug 2024 crashes on charge() and on a q column without charges.
      if (!['full', 'charge'].includes(wf.atomStyle)) {
        expect(all).not.toMatch(/\bcharge\(/);
        expect(all).not.toMatch(/^dump\s.*\bq\b/m);
        expect(all).not.toMatch(/property\/atom.*\bq\b/);
      }
    }
  });

  test('the shape the page relies on', () => {
    const st = defaultLammpsState();
    expect(st.forceField).toBe('charmm');
    expect(Object.keys(st.stages)).toEqual(['min', 'nvt', 'npt', 'prod']);
    expect(st.stages.nvt.output).toEqual({ unit: 'ps', thermo: null, dump: null, restart: null });
    expect(st.groups).toEqual([]);
    expect(defaultLammpsState('lj').stages.prod.output.unit).toBe('tau');
    expect(defaultLammpsState('nonsense').forceField).toBe('charmm');
    expect(JSON.parse(JSON.stringify(st))).toEqual(st);
    expect(LMP_STAGES.map(s => s.file)).toEqual(['in.min', 'in.nvt', 'in.npt', 'in.prod']);
    expect(LMP_THERMOSTATS.find(t => t.id === 'berendsen').productionOk).toBe(false);
    expect(LMP_BAROSTATS.find(b => b.id === 'berendsen').productionOk).toBe(false);
    expect(LMP_DUMP_FORMATS.find(f => f.id === 'xtc').package).toBe('EXTRA-DUMP');
    for (const f of LMP_FORCE_FIELDS) {
      for (const k of f.fields) expect([f.id, k, !!LMP_FF_FIELDS[k]]).toEqual([f.id, k, true]);
      expect(f.sources.length).toBeGreaterThan(0);
      for (const r of f.sources) expect(r.url).toMatch(/^https:\/\//);
    }
    const wf = buildLammpsWorkflow(st);
    expect(wf.vars.nvt.first).toEqual({ rstep: '-1', time_limit: 'off' });
    expect(Number(wf.vars.prod.continue.rstep)).toBe(wf.stages[3].output.restart);
    expect(wf.vars.min).toEqual({ first: {}, continue: null });
    expect(wf.expectedWarnings.map(w => w.text)).toContain('Wall time limit reached');
  });

  test('CHARMM36 uses the force-switched styles; CHARMM22/27 the energy-switched ones', () => {
    const c36 = buildLammpsWorkflow(stateFor('charmm'));
    expect(text(c36, 'in.system')).toMatch(/^pair_style\s+lj\/charmmfsw\/coul\/long 10\.0 12\.0$/m);
    expect(text(c36, 'in.system')).toMatch(/^dihedral_style\s+charmmfsw$/m);
    expect(text(c36, 'in.system')).toMatch(/^special_bonds\s+charmm$/m);
    expect(text(c36, 'in.settings')).toMatch(/^kspace_style\s+pppm 1\.0e-6$/m);
    const sys = file(c36, 'in.system');
    const line = sys.text.split('\n').findIndex(l => l.startsWith('pair_style')) + 1;
    expect(sys.notes[line]).toMatch(/force switch/i);
    const old = buildLammpsWorkflow(stateFor('charmm-switch'));
    expect(text(old, 'in.system')).toMatch(/^pair_style\s+lj\/charmm\/coul\/long 10\.0 12\.0$/m);
    expect(text(old, 'in.system')).toMatch(/^dihedral_style\s+charmm$/m);
  });

  test('systems from a lattice or a restart file of your own', () => {
    const cu = buildLammpsWorkflow(defaultLammpsState('eam'));
    expect(text(cu, 'in.system')).toMatch(/^lattice\s+fcc 3\.615\nregion\s+box block 0 10 0 10 0 10\ncreate_box\s+1 box\ncreate_atoms\s+1 box$/m);
    expect(text(cu, 'in.system')).not.toMatch(/^mass/m);
    expect(cu.natoms).toBe(4000);
    const si = buildLammpsWorkflow(defaultLammpsState('tersoff'));
    expect(text(si, 'in.system')).toMatch(/^mass\s+1 28\.0855$/m);
    const st = defaultLammpsState('charmm');
    Object.assign(st.system, { source: 'restart', restartFile: 'equil.restart' });
    st.ff.cmapFile = 'charmm36.cmap';
    st.restraint.group = 'type 1';
    const wf = buildLammpsWorkflow(st);
    expect(text(wf, 'in.system')).toMatch(/^read_restart\s+equil\.restart\nfix\s+cmap all cmap charmm36\.cmap\nfix_modify\s+cmap energy yes$/m);
    expect(text(wf, 'in.system')).not.toMatch(/^units|^read_data/m);
    expect(wf.needs).toEqual(['equil.restart', 'charmm36.cmap']);
  });

  test('pair styles without restart data are given again in every stage', () => {
    for (const id of ['eam', 'eam/alloy', 'eam/fs', 'tersoff', 'sw', 'reaxff']) {
      const wf = buildLammpsWorkflow(stateFor(id));
      expect(text(wf, 'in.settings')).toMatch(/^pair_style\s/m);
      expect(text(wf, 'in.settings')).toMatch(/^pair_coeff\s+\* \* \S+/m);
      expect(text(wf, 'in.system')).not.toMatch(/^pair_style/m);
    }
    expect(text(buildLammpsWorkflow(stateFor('reaxff')), 'in.settings')).toMatch(/^fix\s+qeq all qeq\/reaxff 1 0\.0 10\.0 1\.0e-6 reaxff$/m);
    const custom = defaultLammpsState('custom');
    custom.ff.lines = 'units metal\natom_style atomic\npair_style eam/alloy\npair_coeff * * CuNi.eam.alloy Ni';
    custom.system.source = 'lattice';
    const wf = buildLammpsWorkflow(custom);
    expect(wf.units).toBe('metal');
    expect(text(wf, 'in.settings')).toMatch(/^pair_style eam\/alloy$/m);
    expect(text(wf, 'in.system')).not.toMatch(/pair_style/);
  });

  test('water models: their parameters, charges, TIP4P site and rigid water', () => {
    const t4 = buildLammpsWorkflow(defaultLammpsState('tip4p2005'), { data: fakeData({ soluteTypes: [] }) });
    expect(text(t4, 'in.system')).toMatch(/^pair_style\s+lj\/cut\/tip4p\/long 3 4 2 3 0\.1546 8\.5$/m);
    expect(text(t4, 'in.settings')).toMatch(/^kspace_style\s+pppm\/tip4p 1\.0e-5$/m);
    expect(text(t4, 'in.settings')).toMatch(/^comm_modify\s+cutoff 11\.7$/m);
    expect(text(t4, 'in.system')).toMatch(/^set\s+type 3 charge -1\.1128$/m);
    expect(text(t4, 'in.nvt')).toMatch(/^fix\s+constrain all shake 1\.0e-4 20 0 b 2 a 3$/m);
    const spce = buildLammpsWorkflow(defaultLammpsState('spce'), { data: fakeData({ soluteTypes: [] }) });
    expect(text(spce, 'in.settings')).toMatch(/^pair_coeff\s+3 3 0\.1553 3\.166$/m);
    expect(text(spce, 'in.settings')).toMatch(/^bond_coeff\s+2 450 1$/m);
    expect(text(spce, 'in.settings')).toMatch(/^angle_coeff\s+3 55 109\.47$/m);
    // Without water types the model assumes 1 and 2, and says so.
    const bare = buildLammpsWorkflow(defaultLammpsState('tip3p'));
    expect(bare.issues.some(i => /water's atom types/.test(i.message))).toBe(true);
  });

  test('SHAKE from the data file: hydrogen masses and the water angle', () => {
    const wf = buildLammpsWorkflow(defaultLammpsState('charmm'), { data: fakeData() });
    expect(text(wf, 'in.nvt')).toMatch(/^fix\s+constrain all shake 1\.0e-4 20 0 m 1\.008 a 3$/m);
    // SHAKE comes before the box-changing fix npt, after fix nvt and the restraints.
    const npt = commands(text(wf, 'in.npt'));
    const at = (re) => npt.findIndex(l => re.test(l));
    expect(at(/spring\/self/)).toBeLessThan(at(/shake/));
    expect(at(/shake/)).toBeLessThan(at(/ npt /));
    // RATTLE where fix npt would follow it: SHAKE, with a note.
    const st = defaultLammpsState('charmm');
    st.constraints = 'rattle';
    const r = buildLammpsWorkflow(st, { data: fakeData() });
    expect(text(r, 'in.nvt')).toMatch(/constrain all rattle/);
    expect(text(r, 'in.npt')).toMatch(/constrain all shake/);
    expect(r.issues.some(i => /RATTLE cannot be used with fix npt/.test(i.message))).toBe(true);
  });

  test('restraints: the solute\'s heavy atoms, a named group, or arguments', () => {
    const wf = buildLammpsWorkflow(defaultLammpsState('charmm'), { data: fakeData() });
    expect(text(wf, 'in.settings')).toMatch(/^group\s+restrained type 1$/m);
    expect(text(wf, 'in.nvt')).toMatch(/^fix\s+posres_nvt restrained spring\/self 2\.39$/m);
    expect(text(wf, 'in.npt')).toMatch(/^fix\s+posres_npt restrained spring\/self 2\.39$/m);
    expect(text(wf, 'in.prod')).not.toMatch(/spring\/self/);
    const st = defaultLammpsState('charmm');
    st.groups = [{ name: 'water', args: 'type 3 4', note: 'The water.' }, { name: 'solute_heavy', args: 'type 1', note: 'Heavy atoms.' }];
    st.restraint.group = 'solute_heavy';
    const named = buildLammpsWorkflow(st, { data: fakeData() });
    const settings = text(named, 'in.settings');
    expect(settings).toMatch(/^group\s+water type 3 4\n^group\s+solute_heavy type 1$/m);
    expect(settings).not.toMatch(/group\s+restrained/);
    expect(text(named, 'in.nvt')).toMatch(/posres_nvt solute_heavy spring\/self/);
    st.restraint.group = 'nothing_here';
    expect(buildLammpsWorkflow(st, { data: fakeData() }).issues.some(i => /not among the groups/.test(i.message))).toBe(true);
    st.groups = Array.from({ length: 32 }, (_, i) => ({ name: `g${i}`, args: 'type 1' }));
    expect(buildLammpsWorkflow(st).issues.some(i => i.severity === 'error' && /32 at most/.test(i.message))).toBe(true);
  });

  test('thermostats and barostats: the fixes and their order', () => {
    const fixes = (thermostat, barostat, coupling = 'iso') => {
      const st = defaultLammpsState('spce');
      Object.assign(st, { thermostat, barostat, coupling, waterTypes: { o: 1, h: 2, bond: 1, angle: 1 } });
      return commands(text(buildLammpsWorkflow(st), 'in.npt')).filter(l => /^fix/.test(l)).map(l => l.split(/\s+/)[3]);
    };
    expect(fixes('nose-hoover', 'mtk')).toEqual(['shake', 'npt']);
    expect(fixes('csvr', 'mtk')).toEqual(['temp/csvr', 'shake', 'nph']);
    expect(fixes('langevin', 'mtk')).toEqual(['langevin', 'shake', 'nph']);
    expect(fixes('nose-hoover', 'berendsen')).toEqual(['nvt', 'shake', 'press/berendsen']);
    expect(fixes('csvr', 'berendsen')).toEqual(['nve', 'temp/csvr', 'shake', 'press/berendsen']);
    const st = defaultLammpsState('spce');
    st.coupling = 'membrane';
    expect(text(buildLammpsWorkflow(st), 'in.npt')).toMatch(/npt temp 298\.15 298\.15 200\.0 x 1\.0 1\.0 2000\.0 y 1\.0 1\.0 2000\.0 z 1\.0 1\.0 2000\.0 couple xy$/m);
    expect(text(buildLammpsWorkflow(st), 'in.npt')).toMatch(/thermo_style\s+custom .*lx ly lz pxx pyy pzz/);
    st.thermostat = 'langevin';
    expect(text(buildLammpsWorkflow(st), 'in.nvt')).toMatch(/^variable\s+seed equal 4928459\+v_rstep\+1$/m);
  });

  test('velocities: new in the first dynamics stage only, scaled back after SHAKE', () => {
    const wf = buildLammpsWorkflow(defaultLammpsState('charmm'), { data: fakeData() });
    expect(text(wf, 'in.nvt')).toMatch(/"velocity all create 303\.15 4928459 dist gaussian mom yes rot yes" &\n {2}"run 0 post no" &\n {2}"velocity all scale 303\.15"/);
    expect(text(wf, 'in.npt')).not.toMatch(/velocity/);
    const st = defaultLammpsState('eam');
    st.stages.nvt.on = false;
    const eam = buildLammpsWorkflow(st);
    expect(text(eam, 'in.npt')).toMatch(/^if "\$\{rstep\} < 0" then "velocity all create 300\.0 4928459/m);
    expect(text(eam, 'in.npt')).toMatch(/"read_restart min\.restart"/);
  });
});

describe('lengths and conversions', () => {
  test('time to steps in each unit style', () => {
    expect(toSteps(100, 'ps', 2, 'real')).toEqual({ steps: 50000, exact: true, valid: true });
    expect(toSteps(1, 'ns', 0.001, 'metal')).toEqual({ steps: 1000000, exact: true, valid: true });
    expect(toSteps(500, 'fs', 2, 'real')).toEqual({ steps: 250, exact: true, valid: true });
    expect(toSteps(3, 'fs', 2, 'real')).toMatchObject({ steps: 2, exact: false });
    expect(toSteps(50, 'tau', 0.005, 'lj')).toEqual({ steps: 10000, exact: true, valid: true });
    expect(toSteps(10, 'ps', 0.005, 'lj').valid).toBe(false);
    expect(toSteps(1234, 'steps', 2, 'real').steps).toBe(1234);
    expect(formatTime(50000 * 2, 'real')).toBe('100 ps');
    expect(formatTime(2e6, 'real')).toBe('2 ns');
    expect(formatTime(500, 'real')).toBe('500 fs');
    expect(formatTime(0.5, 'metal')).toBe('500 fs');
    expect(formatTime(50, 'lj')).toBe('50 τ');
    expect(fmtNum(0.0001)).toBe('0.0001');
  });

  test('stage lengths, output intervals and their notes', () => {
    const st = defaultLammpsState('charmm');
    st.stages.prod.length = 10;
    st.stages.prod.lengthUnit = 'ns';
    st.stages.prod.output = { unit: 'ps', thermo: 2, dump: 20, restart: 500 };
    const wf = buildLammpsWorkflow(st, { data: fakeData() });
    const prod = wf.stages.find(p => p.key === 'prod');
    expect(prod.steps).toBe(5000000);
    expect(prod.time).toBe('10 ns');
    expect(prod.output).toMatchObject({ thermo: 1000, dump: 10000, restart: 250000 });
    const f = file(wf, 'in.prod');
    const lines = f.text.split('\n');
    const at = (re) => lines.findIndex(l => re.test(l)) + 1;
    expect(f.notes[at(/^thermo\s+1000$/)]).toMatch(/1,000 steps \(2 ps\)/);
    expect(f.notes[at(/^restart\s/)]).toMatch(/250,000 steps \(500 ps\)/);
    expect(f.notes[at(/^run\s/)]).toMatch(/5,000,000/);
    const nvt = file(wf, 'in.nvt');
    const tline = nvt.text.split('\n').findIndex(l => /fix\s+md all nvt/.test(l)) + 1;
    expect(nvt.notes[tline]).toMatch(/Tdamp 200 fs = 100 steps of 2 fs/);
    // Defaults: thermo every 1 ps, dump every 10 ps in equilibration.
    expect(wf.stages.find(p => p.key === 'nvt').output).toMatchObject({ thermo: 500, dump: 5000, restart: 5000 });
  });

  test('output size estimates grow with atoms and frames', () => {
    const stage = { dynamics: true, steps: 100000, output: { thermo: 1000, dump: 1000, restart: 10000 } };
    const a = estimateLammpsOutput(stage, 10000, { format: 'custom', molecular: true });
    const b = estimateLammpsOutput(stage, 20000, { format: 'custom', molecular: true });
    const x = estimateLammpsOutput(stage, 10000, { format: 'xtc', molecular: true });
    expect(a.frames.dump).toBe(101);
    expect(b.bytes.dump).toBeGreaterThan(1.9 * a.bytes.dump);
    expect(x.bytes.dump).toBeLessThan(a.bytes.dump / 5);
    expect(a.bytes.restart).toBeCloseTo(3 * (10000 * 170 + 4000), -3);
    const wf = buildLammpsWorkflow(defaultLammpsState('charmm'), { data: fakeData() });
    expect(wf.stages.every(p => p.bytes > 0)).toBe(true);
    expect(text(wf, 'README.md')).toMatch(/## Expected output \(3,000 atoms, approximate\)/);
  });
});

describe('issues', () => {
  const issues = (st, opts) => buildLammpsWorkflow(st, opts).issues;
  const has = (list, severity, re) => list.some(i => i.severity === severity && re.test(i.message));

  test('time steps', () => {
    const st = defaultLammpsState('charmm');
    st.constraints = 'none';
    st.timestep = 2;
    expect(has(issues(st), 'warning', /2 fs with flexible bonds/)).toBe(true);
    const lj = defaultLammpsState('lj');
    lj.timestep = 2;
    expect(has(issues(lj), 'error', /looks like a time in fs/)).toBe(true);
    const rx = defaultLammpsState('reaxff');
    rx.timestep = 1;
    expect(has(issues(rx), 'warning', /long for ReaxFF/)).toBe(true);
    // Without SHAKE the default step is 1 fs, with no warning.
    const flex = defaultLammpsState('charmm');
    flex.constraints = 'none';
    const wf = buildLammpsWorkflow(flex, { data: fakeData() });
    expect(wf.timestep).toBe(1);
    expect(wf.issues.some(i => /flexible bonds/.test(i.message))).toBe(false);
  });

  test('Berendsen and Langevin in production, NVE', () => {
    const st = defaultLammpsState('spce');
    st.thermostat = 'berendsen';
    st.barostat = 'berendsen';
    const list = issues(st);
    expect(has(list, 'warning', /Production uses the Berendsen thermostat/)).toBe(true);
    expect(has(list, 'warning', /Production uses the Berendsen barostat/)).toBe(true);
    const lg = defaultLammpsState('spce');
    lg.thermostat = 'langevin';
    expect(has(issues(lg), 'note', /Langevin thermostat .* slows diffusion/)).toBe(true);
    const nve = defaultLammpsState('spce');
    nve.stages.prod.ensemble = 'NVE';
    expect(has(issues(nve), 'note', /Production is NVE/)).toBe(true);
    expect(text(buildLammpsWorkflow(nve), 'in.prod')).toMatch(/^fix\s+md all nve$/m);
  });

  test('from the data file: vacuum, charges, CMAP, styles, tilt', () => {
    const st = defaultLammpsState('charmm');
    expect(has(issues(st, { data: fakeData({ vacuum: { axis: 'z', size: 40, fraction: 0.5 } }) }), 'warning', /vacuum gap along z \(40 Å\)/)).toBe(true);
    expect(has(issues(st, { data: fakeData({ hasCharges: false }) }), 'warning', /no charges/)).toBe(true);
    const charged = buildLammpsWorkflow(st, { data: fakeData({ charge: 2 }) });
    expect(has(charged.issues, 'warning', /net charge is 2 e/)).toBe(true);
    expect(charged.expectedWarnings.map(w => w.text)).toContain('System is not charge neutral');
    expect(has(issues(st, { data: fakeData({ topology: { bonds: 10, crossterms: 16 } }) }), 'error', /16 CMAP cross-terms/)).toBe(true);
    const cmap = defaultLammpsState('charmm');
    cmap.ff.cmapFile = 'charmm36.cmap';
    const wf = buildLammpsWorkflow(cmap, { data: fakeData({ topology: { bonds: 10, crossterms: 16 } }) });
    expect(wf.issues.some(i => /CMAP/.test(i.message))).toBe(false);
    expect(text(wf, 'in.system')).toMatch(/^fix\s+cmap all cmap charmm36\.cmap\nfix_modify\s+cmap energy yes\n\n# ---- The atoms ----\nread_data\s+system\.data fix cmap crossterm CMAP$/m);
    expect(text(wf, 'in.npt')).toMatch(/"read_restart nvt\.restart\.\d+" &\n {2}"fix cmap all cmap charmm36\.cmap" &\n {2}"fix_modify cmap energy yes"/);
    expect(wf.needs).toContain('charmm36.cmap');
    expect(has(issues(defaultLammpsState('amber'), { data: fakeData({ coeffs: { styles: { dihedral: 'charmm' } } }) }), 'warning', /written for dihedral_style charmm/)).toBe(true);
    const tilted = buildLammpsWorkflow(defaultLammpsState('reaxff'), { data: fakeData({ atomStyle: 'charge', box: { xlo: 0, xhi: 13.6, ylo: 0, yhi: 17.1, zlo: 0, zhi: 15.2, xy: -5.8, xz: -6.3, yz: 7.4, triclinic: true } }) });
    expect(tilted.expectedWarnings.map(w => w.text)).toContain('Triclinic box skew is large');
  });

  test('coefficients the data file lacks', () => {
    const noPairs = fakeData({ coeffs: { pair: false, bond: true, angle: false, styles: {} }, topology: { bonds: 10, bondTypes: 2, angleTypes: 3 } });
    const list = issues(defaultLammpsState('opls'), { data: noPairs });
    expect(has(list, 'error', /no Pair Coeffs section.*atom types 1-4/)).toBe(true);
    expect(has(list, 'error', /no Angle Coeffs section.*angle types 1-3/)).toBe(true);
    const st = defaultLammpsState('opls');
    st.extraLines = 'pair_coeff * * 0.1 3.0\nangle_coeff * 50 109.5';
    expect(issues(st, { data: noPairs }).filter(i => i.severity === 'error')).toEqual([]);
    // A water preset writes water's own coefficients; only the other types are missing.
    const water = issues(defaultLammpsState('spce'), { data: fakeData({ coeffs: { pair: false, bond: false, angle: false, styles: {} }, topology: { bonds: 10, bondTypes: 2, angleTypes: 3 } }) });
    expect(has(water, 'error', /atom types 1 and 2 their/)).toBe(true);
    expect(has(water, 'error', /bond type 1 their/)).toBe(true);
    expect(has(water, 'error', /angle types 1 and 2 their/)).toBe(true);
  });

  test('coupling: tri needs a triclinic box; Berendsen cannot do tri', () => {
    const st = defaultLammpsState('eam');
    st.coupling = 'tri';
    expect(has(issues(st), 'error', /needs a triclinic box/)).toBe(true);
    st.barostat = 'berendsen';
    const wf = buildLammpsWorkflow(st);
    expect(has(wf.issues, 'warning', /cannot change the tilt/)).toBe(true);
    expect(text(wf, 'in.npt')).toMatch(/press\/berendsen aniso/);
  });

  test('non-periodic boundaries: no barostat, PPPM only with a slab correction', () => {
    const st = defaultLammpsState('spce');
    st.system.boundary = 'p p f';
    const list = issues(st);
    expect(has(list, 'error', /non-periodic z dimension/)).toBe(true);
    expect(has(list, 'error', /Cannot use non-periodic boundaries with PPPM/)).toBe(true);
    st.extraLines = 'kspace_modify slab 3.0';
    st.stages.npt.on = false;
    st.stages.prod.ensemble = 'NVT';
    expect(issues(st).filter(i => i.severity === 'error')).toEqual([]);
  });

  test('PLUMED: RESTART in the input, methods that need the job kit', () => {
    const st = defaultLammpsState('charmm');
    const bad = { files: [{ name: 'plumed.dat', text: 'RESTART\nd: DISTANCE ATOMS=1,2\nPRINT ARG=d FILE=COLVAR\n' }] };
    expect(has(issues(st, { plumed: bad }), 'warning', /contains RESTART/)).toBe(true);
    const opes = { files: [{ name: 'plumed.dat', text: 'd: DISTANCE ATOMS=1,2\nOPES_METAD ARG=d PACE=500 BARRIER=40\n' }] };
    expect(has(issues(st, { plumed: opes }), 'warning', /OPES_METAD continues exactly only/)).toBe(true);
  });
});

describe('PLUMED in the stages', () => {
  test('production by default, every dynamics stage on request', () => {
    const st = defaultLammpsState('charmm');
    const wf = buildLammpsWorkflow(st, { plumed: PLUMED });
    expect(file(wf, 'plumed.dat').kind).toBe('plumed');
    expect(text(wf, 'in.prod')).toMatch(/^variable\s+plumed_in index plumed\.dat$/m);
    expect(text(wf, 'in.prod')).toMatch(/^fix\s+plumed all plumed plumedfile \$\{plumed_in\} outfile \$\{plumed_log\}$/m);
    expect(text(wf, 'in.nvt')).not.toMatch(/plumed/);
    expect(wf.vars.prod.first.plumed_in).toBe('plumed.dat');
    expect(wf.vars.prod.continue.plumed_in).toBe('plumed.restart.dat');
    expect(wf.plumed).toMatchObject({ prints: ['COLVAR'], hills: ['HILLS'], stages: ['prod'] });
    expect(wf.plumed.dtPlumed).toBeCloseTo(0.002, 12);
    // fix plumed before SHAKE and the barostat (LAMMPS stops otherwise).
    const prod = commands(text(wf, 'in.prod'));
    const at = (re) => prod.findIndex(l => re.test(l));
    expect(at(/fix\s+plumed/)).toBeLessThan(at(/shake/));
    expect(at(/shake/)).toBeLessThan(at(/ npt /));
    st.plumedStages = 'all';
    const all = buildLammpsWorkflow(st, { plumed: PLUMED });
    expect(all.stages.filter(p => p.plumed).map(p => p.key)).toEqual(['nvt', 'npt', 'prod']);
  });
});

describe('the job block', () => {
  test('runs the stages in order, each skipped once complete', () => {
    const wf = buildLammpsWorkflow(defaultLammpsState('charmm'), { data: fakeData(), plumed: PLUMED });
    const block = lammpsRunBlock(wf, { lmp: 'lmp_mpi', launch: 'srun', flags: '-sf omp -pk omp 4' });
    expect(block).toMatch(/^LMP="lmp_mpi"/m);
    expect(block).toMatch(/^LMP_LAUNCH="srun"/m);
    expect(block).toMatch(/^LMP_FLAGS="-sf omp -pk omp 4"/m);
    expect(block).toMatch(/^stage "NVT equilibration" in\.nvt nvt\.restart 50000 min\.restart$/m);
    expect(block).toMatch(/^stage "NPT equilibration" in\.npt npt\.restart 50000 nvt\.restart\.50000$/m);
    expect(block).toMatch(/^plumed_prepare restart 50000000\nstage Production in\.prod restart 50000000 npt\.restart\.50000 -var plumed_in "\$PLUMED_IN"$/m);
    expect(block).toMatch(/trim COLVAR "\$t" lt\n {2}trim HILLS "\$t" le/);
    expect(block).toMatch(/^for f in system\.data; do/m);
    expect(spawnSync('bash', ['-n'], { input: block, encoding: 'utf8' }).status).toBe(0);
  });

  test('every scheduler\'s launcher expands to the right command in bash', () => {
    const wf = buildLammpsWorkflow(defaultLammpsState('eam'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stemkit-lmp-launch-'));
    try {
      fs.writeFileSync(path.join(dir, 'nodes'), 'n1\nn1\nn2\nn2\n');
      const env = { PATH: process.env.PATH, PBS_NODEFILE: path.join(dir, 'nodes'), NSLOTS: '4', LSB_DJOB_NUMPROC: '4', OMP_NUM_THREADS: '2' };
      const cases = [['slurm', 1, 'srun'], ['pbs', 1, 'mpirun -np 4'], ['lsf', 1, 'mpirun -np 4'], ['lsf', 2, 'mpirun -np 2'], ['sge', 1, 'mpirun -np 4'], ['sge', 2, 'mpirun -np 2']];
      for (const [sched, threads, want] of cases) {
        const block = lammpsRunBlock(wf, { lmp: '/opt/my lammps/lmp', launch: launcher(sched, { cpusPerTask: threads }), flags: '-sf omp -pk omp $OMP_NUM_THREADS' });
        const head = block.split('\n').filter(l => /^LMP(_LAUNCH|_FLAGS)?=/.test(l)).join('\n');
        const r = spawnSync('bash', ['-c', `${head}\nprintf '%s|%s|%s' "$LMP" "$LMP_LAUNCH" "$LMP_FLAGS"`], { encoding: 'utf8', env });
        expect([sched, threads, r.stdout]).toEqual([sched, threads, `/opt/my lammps/lmp|${want}|-sf omp -pk omp 2`]);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(shellValue('a "b" $(c "d")')).toBe('"a \\"b\\" $(c "d")"');
  });

  /*
   * The block's own logic, with a stand-in for lmp that writes the restart
   * files a stage would: done when TIME_LIMIT allows, half way otherwise.
   */
  test('skips finished stages and continues an interrupted one (stand-in lmp)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stemkit-lmp-block-'));
    try {
      const st = defaultLammpsState('eam');
      st.stages.nvt.length = 1000; st.stages.nvt.lengthUnit = 'steps';
      st.stages.npt.length = 1000; st.stages.npt.lengthUnit = 'steps';
      st.stages.prod.length = 4000; st.stages.prod.lengthUnit = 'steps';
      const wf = buildLammpsWorkflow(st, { plumed: PLUMED });
      for (const f of wf.files) fs.writeFileSync(path.join(dir, f.name), f.text);
      fs.writeFileSync(path.join(dir, 'Cu_u3.eam'), '');
      // The stand-in: reads -in, -var rstep and -var time_limit; a limit under 1000 s stops half way.
      fs.writeFileSync(path.join(dir, 'fake-lmp'), `#!/bin/bash
while [ $# -gt 0 ]; do case $1 in -in) in=$2; shift 2 ;; -var) eval "v_$2=\\"$3\\""; shift 3 ;; *) shift ;; esac; done
echo "$in rstep=\${v_rstep:-} time_limit=\${v_time_limit:-}" >> calls.txt
if [ "$in" = in.min ]; then : > min.restart; exit 0; fi
last=$(sed -n 's/^run *\\([0-9]*\\) upto$/\\1/p' "$in"); prefix=$(sed -n 's/^write_restart *\\(.*\\)\\.\\*$/\\1/p' "$in")
step=$last
if [ "\${v_time_limit:-off}" != off ] && [ "\${v_time_limit}" -lt 1000 ]; then step=$(( (\${v_rstep:-0} < 0 ? 0 : \${v_rstep:-0}) + last / 2 )); [ $step -gt $last ] && step=$last; fi
: > "$prefix.$step"
`);
      fs.chmodSync(path.join(dir, 'fake-lmp'), 0o755);
      // set -euo pipefail, as strict job scripts have: the block must survive it.
      fs.writeFileSync(path.join(dir, 'job.sh'), `#!/bin/bash\nset -euo pipefail\n${lammpsRunBlock(wf, { lmp: './fake-lmp', minLeft: 0 })}`);
      const run = (env = {}) => spawnSync('bash', ['job.sh'], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
      // A short TIME_LIMIT: the first dynamics stage stops half way.
      let r = run({ TIME_LIMIT: '0:10:00' });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/NVT equilibration: stopped at step 500 of 1000/);
      expect(fs.existsSync(path.join(dir, 'min.restart'))).toBe(true);
      // Again: minimisation skipped, NVT continues from 500 and finishes.
      r = run({ TIME_LIMIT: '1:00:00' });
      expect(r.stdout).toMatch(/Energy minimisation: complete \(min\.restart\); skipped\./);
      expect(r.stdout).toMatch(/NVT equilibration: continuing from nvt\.restart\.500\./);
      expect(r.stdout).toMatch(/All stages are complete\./);
      const calls = fs.readFileSync(path.join(dir, 'calls.txt'), 'utf8').trim().split('\n');
      expect(calls[0]).toBe('in.min rstep= time_limit=');
      expect(calls[1]).toMatch(/^in\.nvt rstep=-1 time_limit=\d+$/);
      expect(calls[2]).toMatch(/^in\.nvt rstep=500 time_limit=3\d{3}$/);
      expect(calls.slice(3).map(c => c.split(' ')[0])).toEqual(['in.npt', 'in.prod']);
      expect(fs.readFileSync(path.join(dir, 'calls.txt'), 'utf8')).toMatch(/in\.prod rstep=-1/);
      // Everything complete: nothing runs.
      r = run();
      expect(r.stdout).toMatch(/Production: complete \(restart\.4000\); skipped\./);
      expect(fs.readFileSync(path.join(dir, 'calls.txt'), 'utf8').trim().split('\n')).toHaveLength(5);
      // A missing input file stops the job before any stage.
      fs.rmSync(path.join(dir, 'Cu_u3.eam'));
      expect(run().stderr).toMatch(/Cu_u3\.eam is missing/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the README names the files, the stages, how to continue and what to check', () => {
    const wf = buildLammpsWorkflow(defaultLammpsState('charmm'), { data: fakeData(), plumed: PLUMED });
    const md = lammpsReadme(wf, { jobName: 'peptide', submit: 'sbatch submit.sh', scheduler: 'SLURM', date: new Date('2026-09-30') });
    expect(md).toMatch(/^# LAMMPS workflow: peptide$/m);
    expect(md).toMatch(/LAMMPS 29 Aug 2024, 2026-09-30/);
    expect(md).toMatch(/\| `in\.settings` \|/);
    expect(md).toMatch(/\| NPT equilibration \| `in\.npt` \| 100 ps \| 50,000 \| NPT \| yes \| `nvt\.restart\.50000` \|/);
    expect(md).toMatch(/run N upto/);
    expect(md).toMatch(/## PLUMED/);
    expect(md).toMatch(/## What to check/);
    expect(md).toMatch(/KSPACE, MOLECULE, PLUMED, RIGID/);
  });
});

/* The inputs through the checker of src/core/lammps-input.js. */
const withChecker = checkInput ? describe : describe.skip;
withChecker('the checker of src/core/lammps-input.js', () => {
  test.each(LMP_FORCE_FIELDS.map(f => [f.id]))('%s: no errors in any stage, new or continued', (id) => {
    const st = stateFor(id);
    st.stages.min.boxRelax = LMP_FORCE_FIELD[id].family === 'Materials';
    const wf = buildLammpsWorkflow(st, { plumed: PLUMED });
    const files = Object.fromEntries(wf.files.filter(f => f.kind === 'lammps').map(f => [f.name, f.text]));
    for (const f of wf.files.filter(x => x.kind === 'lammps' && x.stage)) {
      for (const which of ['first', 'continue']) {
        const vars = wf.vars[f.stage][which];
        if (!vars) continue;
        const res = checkInput(f.text, { vars, files });
        const errors = res.issues.filter(i => i.severity === 'error').map(i => `${f.name} (${which}) ${i.line}: ${i.message}`);
        expect(errors).toEqual([]);
      }
    }
  });
});

/*
 * A small data file of its own (a CH4-like solute in three TIP3P waters),
 * through lammps-data.js, so the data path is covered without the LAMMPS
 * source tree (CI has none).
 */
const TINY_DATA = `tiny test system

14 atoms
4 atom types
10 bonds
2 bond types
3 angles
1 angle types

0 20 xlo xhi
0 20 ylo yhi
0 20 zlo zhi

Masses

1 12.011
2 1.008
3 15.9994
4 1.008

Atoms # full

1 1 1 -0.24 10.0000 10.0000 10.0000
2 1 2 0.06 10.6293 10.6293 10.6293
3 1 2 0.06 10.6293 9.3707 9.3707
4 1 2 0.06 9.3707 10.6293 9.3707
5 1 2 0.06 9.3707 9.3707 10.6293
6 2 3 -0.834 4.0000 4.0000 4.0000
7 2 4 0.417 4.7570 4.5859 4.0000
8 2 4 0.417 3.2430 4.5859 4.0000
9 3 3 -0.834 16.0000 4.0000 15.0000
10 3 4 0.417 16.7570 4.5859 15.0000
11 3 4 0.417 15.2430 4.5859 15.0000
12 4 3 -0.834 4.0000 15.0000 16.0000
13 4 4 0.417 4.7570 15.5859 16.0000
14 4 4 0.417 3.2430 15.5859 16.0000

Bonds

1 1 1 2
2 1 1 3
3 1 1 4
4 1 1 5
5 2 6 7
6 2 6 8
7 2 9 10
8 2 9 11
9 2 12 13
10 2 12 14

Angles

1 1 7 6 8
2 1 10 9 11
3 1 13 12 14
`;

describe('a data file through lammps-data.js', () => {
  const sum = summariseData(parseDataFile(TINY_DATA), { units: 'real' });

  test('groups, SHAKE, restraints and water from the summary', () => {
    expect(sum.water).toMatchObject({ model: 'TIP3P', oType: 3, hType: 4, bondType: 2, angleType: 1 });
    const st = defaultLammpsState('charmm');
    st.groups = groupsFromData(sum).map(g => ({ name: g.name, args: g.command.replace(/^group\s+\S+\s+/, ''), note: g.why }));
    const wf = buildLammpsWorkflow(st, { data: sum });
    expect(text(wf, 'in.nvt')).toMatch(/^fix\s+constrain all shake 1\.0e-4 20 0 m 1\.008 a 1$/m);
    expect(text(wf, 'in.settings')).toMatch(/^group\s+water type 3 4$/m);
    expect(text(wf, 'in.nvt')).toMatch(/^fix\s+posres_nvt solute_heavy spring\/self 2\.39$/m);
    expect(wf.natoms).toBe(14);
    // The data file has no coefficients: the builder says what is missing.
    expect(wf.issues.some(i => i.severity === 'error' && /no Pair Coeffs section/.test(i.message))).toBe(true);
    // Without groups from the page, the heavy atoms of the solute by type.
    const plain = buildLammpsWorkflow(defaultLammpsState('charmm'), { data: sum });
    expect(text(plain, 'in.settings')).toMatch(/^group\s+restrained type 1$/m);
  });

  test('a water preset on it writes the model\'s coefficients for the water types', () => {
    const wf = buildLammpsWorkflow(defaultLammpsState('tip4p2005'), { data: sum });
    expect(text(wf, 'in.system')).toMatch(/^pair_style\s+lj\/cut\/tip4p\/long 3 4 2 1 0\.1546 8\.5$/m);
    expect(text(wf, 'in.settings')).toMatch(/^bond_coeff\s+2 450 0\.9572$/m);
    // The solute's types still need coefficients from somewhere.
    expect(wf.issues.some(i => i.severity === 'error' && /atom types 1 and 2 their/.test(i.message))).toBe(true);
  });
});

/* Real data files from the LAMMPS examples, through lammps-data.js. */
const withExamples = hasExamples ? describe : describe.skip;
withExamples('LAMMPS example data (lammps/examples)', () => {
  test('examples/peptide: groups, SHAKE and restraints from the summary', () => {
    const sum = summariseData(parseDataFile(fs.readFileSync(path.join(LAMMPS, 'examples', 'peptide', 'data.peptide'), 'utf8')), { units: 'real' });
    const st = defaultLammpsState('charmm-switch');
    st.groups = groupsFromData(sum).map(g => ({ name: g.name, args: g.command.replace(/^group\s+\S+\s+/, ''), note: g.why }));
    const wf = buildLammpsWorkflow(st, { data: sum });
    expect(text(wf, 'in.nvt')).toMatch(/^fix\s+constrain all shake 1\.0e-4 20 0 m 1\.008 a 31$/m);
    expect(text(wf, 'in.nvt')).toMatch(/^fix\s+posres_nvt solute_heavy spring\/self/m);
    expect(text(wf, 'in.settings')).toMatch(/^group\s+solute_heavy subtract solute hydrogens$/m);
    expect(wf.natoms).toBe(2004);
    expect(wf.issues.filter(i => i.severity !== 'note')).toEqual([]);
  });
});

/*
 * With LAMMPS installed (LMP_BIN), the whole chain runs through the job
 * block on a small copper crystal. tools/check-lammps-workflow.mjs runs every
 * preset this way.
 */
const LMP = process.env.LMP_BIN || '';
const withLammps = LMP && fs.existsSync(LMP) && hasExamples ? describe : describe.skip;
withLammps('real LAMMPS (LMP_BIN)', () => {
  test('a copper crystal: minimise, NVT, NPT, production, then nothing left to do', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stemkit-lmp-chain-'));
    try {
      const st = defaultLammpsState('eam');
      st.system.lattice.cells = [4, 4, 4];
      st.stages.min.maxiter = 50;
      for (const k of ['nvt', 'npt', 'prod']) Object.assign(st.stages[k], { length: 100, lengthUnit: 'steps', output: { unit: 'steps', thermo: 50, dump: 50, restart: 50 } });
      const wf = buildLammpsWorkflow(st);
      for (const f of wf.files) fs.writeFileSync(path.join(dir, f.name), f.text);
      fs.copyFileSync(path.join(LAMMPS, 'potentials', 'Cu_u3.eam'), path.join(dir, 'Cu_u3.eam'));
      fs.writeFileSync(path.join(dir, 'job.sh'), `#!/bin/bash\n${lammpsRunBlock(wf, { lmp: LMP })}`);
      const run = () => spawnSync('bash', ['job.sh'], { cwd: dir, encoding: 'utf8', env: { ...process.env, OMP_NUM_THREADS: '1' } });
      const r = run();
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/All stages are complete/);
      expect(r.stdout).not.toMatch(/ERROR|WARNING/);
      for (const name of ['min.restart', 'nvt.restart.100', 'npt.restart.100', 'restart.100', 'prod.data']) expect(fs.existsSync(path.join(dir, name))).toBe(true);
      expect(run().stdout).toMatch(/Production: complete \(restart\.100\); skipped/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});
