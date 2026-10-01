import { describe, test, expect, beforeAll } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  LAMMPS_VERSION, LAMMPS_DOCS, UNITS, COMMAND_KINDS, ACCELERATORS, styleKind, lammpsDocUrl, commandInfo,
  styleExists, listCommands, searchCommands, loadLammpsDetails, lammpsDetailsLoaded
} from '../src/core/lammps-reference.js';
import SUMMARIES from '../src/core/lammps-summaries.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const url = (page) => `https://docs.lammps.org/${page}.html`;

describe('release and units', () => {
  test('describe LAMMPS 29 Aug 2024 and link to docs.lammps.org', () => {
    expect(LAMMPS_VERSION).toBe('29 Aug 2024');
    expect(LAMMPS_DOCS).toBe('https://docs.lammps.org/');
  });

  test('cover the eight unit styles with every quantity', () => {
    expect(Object.keys(UNITS).sort()).toEqual(['cgs', 'electron', 'lj', 'metal', 'micro', 'nano', 'real', 'si']);
    for (const [style, u] of Object.entries(UNITS)) {
      for (const q of ['label', 'time', 'distance', 'energy', 'mass', 'temperature', 'pressure', 'charge', 'velocity', 'force', 'url']) {
        expect(typeof u[q]).toBe('string');
      }
      expect(u.url).toBe(url('units'));
      expect(u.timestep).toBeGreaterThan(0);
      expect(u.skin).toBeGreaterThan(0);
      expect('density' in u && 'timeInPs' in u).toBe(true);
      expect(Object.isFrozen(u)).toBe(true);
      if (style !== 'lj') expect(u.timeInPs).toBeGreaterThan(0);
    }
    expect(Object.isFrozen(UNITS)).toBe(true);
  });

  test('match the units page: time units and default timesteps', () => {
    expect(UNITS.lj.timeInPs).toBeNull();
    expect([UNITS.real.time, UNITS.real.timeInPs, UNITS.real.timestep]).toEqual(['fs', 0.001, 1]);
    expect([UNITS.metal.time, UNITS.metal.timeInPs, UNITS.metal.timestep]).toEqual(['ps', 1, 0.001]);
    expect([UNITS.si.timeInPs, UNITS.si.timestep]).toEqual([1e12, 1e-8]);
    expect([UNITS.cgs.timeInPs, UNITS.cgs.timestep]).toEqual([1e12, 1e-8]);
    expect([UNITS.electron.time, UNITS.electron.timestep]).toEqual(['fs', 0.001]);
    expect([UNITS.micro.timeInPs, UNITS.micro.timestep]).toEqual([1e6, 2]);
    expect([UNITS.nano.timeInPs, UNITS.nano.timestep]).toEqual([1000, 0.00045]);
    expect(UNITS.lj.timestep).toBe(0.005);
    expect([UNITS.real.energy, UNITS.real.pressure, UNITS.metal.energy, UNITS.metal.pressure]).toEqual(['kcal/mol', 'atm', 'eV', 'bar']);
    expect(UNITS.electron.density).toBeNull();
  });
});

describe('kinds', () => {
  test('list every kind once, with the command that selects it', () => {
    const ids = COMMAND_KINDS.map(k => k.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['command', 'atom', 'pair', 'bond', 'angle', 'dihedral', 'improper', 'kspace', 'fix', 'compute', 'dump', 'region', 'minimize', 'integrate']) {
      expect(ids).toContain(id);
    }
    expect(COMMAND_KINDS.find(k => k.id === 'pair').command).toBe('pair_style');
    expect(COMMAND_KINDS.find(k => k.id === 'minimize').command).toBe('min_style');
    expect(ACCELERATORS.map(a => a.suffix)).toEqual(['gpu', 'intel', 'kk', 'omp', 'opt']);
  });

  test('map commands to kinds', () => {
    expect(styleKind('pair_style')).toBe('pair');
    expect(styleKind('min_style')).toBe('minimize');
    expect(styleKind('run_style')).toBe('integrate');
    expect(styleKind('fix')).toBe('fix');
    expect(styleKind('units')).toBe('');
  });
});

describe('documentation links', () => {
  test.each([
    [['fix', 'nvt'], 'fix_nh'],
    [['fix', 'npt'], 'fix_nh'],
    [['fix', 'nph'], 'fix_nh'],
    [['fix nvt/omp'], 'fix_nh'],
    [['fix', 'npt/kk/device'], 'fix_nh'],
    [['pair_style', 'lj/cut/coul/long'], 'pair_lj_cut_coul'],
    [['pair_style', 'lj/cut/coul/long/gpu'], 'pair_lj_cut_coul'],
    [['pair', 'lj/cut/omp'], 'pair_lj'],
    [['pair_style', 'lj/charmm/coul/long/opt'], 'pair_charmm'],
    [['pair_style', 'eam/alloy/intel'], 'pair_eam'],
    [['pair_style', 'lj/sdk'], 'pair_spica'],
    [['kspace_style', 'pppm/tip4p'], 'kspace_style'],
    [['bond_style', 'harmonic'], 'bond_harmonic'],
    [['dihedral_style', 'charmmfsw'], 'dihedral_charmm'],
    [['compute', 'msd'], 'compute_msd'],
    [['dump', 'xtc'], 'dump'],
    [['dump', 'image'], 'dump_image'],
    [['atom_style', 'full'], 'atom_style'],
    [['region', 'block'], 'region'],
    [['min_style', 'spin'], 'min_spin'],
    [['run_style', 'respa/omp'], 'run_style'],
    [['fix', 'rigid/nvt/small'], 'fix_rigid'],
    [['fix', 'qeq/reax'], 'fix_qeq_reaxff'],
    [['units'], 'units'],
    [['fix'], 'fix'],
    [['read_data'], 'read_data'],
    [['kim'], 'kim_commands']
  ])('%j -> %s.html', (args, page) => {
    expect(lammpsDocUrl(...args)).toBe(url(page));
  });

  test('send unknown styles to the command page and unknown commands nowhere', () => {
    expect(lammpsDocUrl('pair_style', 'no/such/style')).toBe(url('pair_style'));
    expect(lammpsDocUrl('fix', 'nope')).toBe(url('fix'));
    expect(lammpsDocUrl('nonsense')).toBeNull();
    expect(lammpsDocUrl('')).toBeNull();
  });

  test('follow pages that moved on docs.lammps.org', () => {
    expect(lammpsDocUrl('fix', 'addtorque')).toBe(url('fix_addtorque_group'));
    expect(lammpsDocUrl('pair_style', 'agni')).toBe(url('stable/pair_agni'));
  });
});

describe('commandInfo', () => {
  test('describes a plain style', () => {
    const info = commandInfo('fix', 'nvt');
    expect(info).toMatchObject({
      key: 'fix nvt', kind: 'fix', command: 'fix', style: 'nvt', base: 'nvt', accelerator: null,
      exists: true, page: 'fix_nh', url: url('fix_nh'), package: null, packages: []
    });
    expect(info.accelerators).toEqual(expect.arrayContaining(['gpu', 'intel', 'kk', 'omp']));
    expect(info.syntax).toBe('fix ID group-ID nvt keyword value ...');
    expect(info.summary).toMatch(/Nosé-Hoover/);
  });

  test('resolves accelerated variants to their plain style', () => {
    const info = commandInfo('pair_style', 'lj/cut/coul/long/omp');
    expect(info).toMatchObject({
      key: 'pair_style lj/cut/coul/long/omp', base: 'lj/cut/coul/long', accelerator: 'omp',
      package: 'OPENMP', exists: true, page: 'pair_lj_cut_coul'
    });
    expect(info.packages.sort()).toEqual(['KSPACE', 'OPENMP']);
    expect(info.summary).toBe(commandInfo('pair_style', 'lj/cut/coul/long').summary);
    expect(info.syntax).toBe('pair_style lj/cut/coul/long cutoff (cutoff2)');
    expect(info.args).toEqual(['cutoff', '(cutoff2)']);
    expect(commandInfo('fix', 'nvt/kk/host')).toMatchObject({ accelerator: 'kk', package: 'KOKKOS', exists: true });
  });

  test('says when an accelerated variant does not exist', () => {
    expect(commandInfo('pair_style', 'lj/cut/coul/wolf/gpu').exists).toBe(false);
    expect(styleExists('pair_style', 'lj/cut/coul/wolf/gpu')).toBe(false);
    expect(styleExists('pair_style', 'lj/cut/coul/wolf/omp')).toBe(true);
  });

  test('describes commands, with their category', () => {
    const info = commandInfo('units');
    expect(info).toMatchObject({ key: 'units', kind: 'command', command: 'units', style: '', package: null, category: 'Initialization' });
    expect(info.syntax).toBe('units style');
    expect(commandInfo('fix nvt').key).toBe('fix nvt');
    expect(commandInfo('nonsense')).toBeNull();
    expect(commandInfo('fix', 'nonsense')).toBeNull();
  });

  test('follows aliases to the documented name', () => {
    expect(commandInfo('angle_style', 'sdk')).toMatchObject({ alias: 'spica', page: 'angle_spica', exists: true });
    expect(commandInfo('fix', 'acks2/reax')).toMatchObject({ alias: 'acks2/reaxff', exists: true });
    expect(commandInfo('fix', 'qeq/reax')).toMatchObject({ alias: 'qeq/reaxff', exists: true });
    expect(commandInfo('fix', 'qeq/reax').removed).toBeUndefined();
  });

  test('fills in the style for skeletons written for several styles', () => {
    expect(commandInfo('region', 'sphere').syntax).toBe('region ID sphere x y z radius keyword arg ...');
    expect(commandInfo('fix', 'langevin').syntax).toMatch(/^fix ID group-ID langevin Tstart Tstop damp seed/);
    expect(commandInfo('atom_style', 'full').syntax).toBe('atom_style full');
    expect(commandInfo('kspace_style', 'pppm').syntax).toBe('kspace_style pppm accuracy');
  });
});

describe('packages', () => {
  test.each([
    ['fix', 'nvt', null],
    ['fix', 'shake', 'RIGID'],
    ['fix', 'rigid/small', 'RIGID'],
    ['fix', 'plumed', 'PLUMED'],
    ['fix', 'colvars', 'COLVARS'],
    ['fix', 'qeq/reaxff', 'REAXFF'],
    ['fix', 'gcmc', 'MC'],
    ['fix', 'temp/csvr', 'EXTRA-FIX'],
    ['pair_style', 'lj/cut', null],
    ['pair_style', 'lj/cut/coul/long', 'KSPACE'],
    ['pair_style', 'lj/charmm/coul/charmm', 'MOLECULE'],
    ['pair_style', 'eam/alloy', 'MANYBODY'],
    ['pair_style', 'reaxff', 'REAXFF'],
    ['pair_style', 'lj/class2', 'CLASS2'],
    ['pair_style', 'lj/cut/coul/debye', 'EXTRA-PAIR'],
    ['bond_style', 'harmonic', 'MOLECULE'],
    ['kspace_style', 'pppm', 'KSPACE'],
    ['atom_style', 'full', 'MOLECULE'],
    ['atom_style', 'atomic', null],
    ['compute', 'msd', null],
    ['dump', 'xtc', 'EXTRA-DUMP'],
    ['dump', 'custom/gz', 'COMPRESS'],
    ['pair_style', 'lj/cut/gpu', 'GPU'],
    ['pair_style', 'lj/cut/opt', 'OPT'],
    ['pair_style', 'hybrid/omp', null]
  ])('%s %s is in %s', (command, style, pkg) => {
    expect(commandInfo(command, style).package).toBe(pkg);
  });

  test('know the packages a style needs besides its own', () => {
    expect(commandInfo('pair_style', 'srp/react').packages.sort()).toEqual(['MC', 'MISC']);
    expect(commandInfo('python').packages).toEqual(['PYTHON']);
  });

  test('decide whether a build has a style', () => {
    const lmp = ['KSPACE', 'MOLECULE', 'OPENMP', 'RIGID'];
    expect(styleExists('pair_style', 'lj/cut/coul/long', { packages: lmp })).toBe(true);
    expect(styleExists('pair_style', 'lj/cut/coul/long/omp', { packages: lmp })).toBe(true);
    expect(styleExists('pair_style', 'lj/cut/coul/long/gpu', { packages: lmp })).toBe(false);
    expect(styleExists('pair_style', 'eam', { packages: lmp })).toBe(false);
    expect(styleExists('pair_style', 'lj/cut/coul/long/omp', { packages: ['OPENMP'] })).toBe(false);
    expect(styleExists('dump', 'custom/zstd', { packages: ['COMPRESS'], flags: ['LAMMPS_GZIP'] })).toBe(false);
    expect(styleExists('dump', 'custom/zstd', { packages: ['COMPRESS'], flags: ['LAMMPS_ZSTD'] })).toBe(true);
  });
});

describe('removed names', () => {
  test('stubs that stop the run', () => {
    const info = commandInfo('pair_style', 'reax/c');
    expect(info.removed).toMatchObject({ status: 'stops', since: '7 Feb 2024', replacement: 'pair_style reaxff' });
    expect(info.removed.note).toMatch(/stops/);
    expect(info.exists).toBe(false);
    expect(info.url).toBe(url('Commands_removed'));
    expect(styleExists('pair_style', 'reax/c')).toBe(false);
    expect(commandInfo('fix', 'ave/spatial').removed).toMatchObject({ status: 'stops', replacement: 'fix ave/chunk' });
    expect(commandInfo('min_style', 'fire/old').removed).toMatchObject({ status: 'stops', replacement: 'min_style fire' });
    expect(commandInfo('dump', 'custom/mpiio').removed).toMatchObject({ status: 'stops', replacement: 'dump custom' });
  });

  test('commands LAMMPS still runs under a new name, or ignores', () => {
    expect(commandInfo('reset_ids').removed).toMatchObject({ status: 'renamed', renamed: 'reset_atoms id' });
    expect(commandInfo('reset_mol_ids').removed).toMatchObject({ status: 'renamed', renamed: 'reset_atoms mol' });
    expect(commandInfo('kim_init').removed).toMatchObject({ status: 'renamed', renamed: 'kim init' });
    expect(styleExists('reset_ids')).toBe(true);
    expect(commandInfo('box').removed).toMatchObject({ status: 'ignored' });
    expect(styleExists('box')).toBe(true);
    expect(commandInfo('message').removed).toMatchObject({ status: 'stops' });
  });

  test('names nothing registers any more', () => {
    expect(commandInfo('fix', 'latte').removed).toMatchObject({ status: 'unknown', replacement: 'fix mdi/qm' });
    expect(styleExists('fix', 'latte')).toBe(false);
  });
});

describe('keywords, units and defaults (loaded on request)', () => {
  beforeAll(() => loadLammpsDetails());

  test('are empty until loaded, then filled', () => {
    expect(lammpsDetailsLoaded()).toBe(true);
  });

  test('fix nvt: keywords, value units, defaults', () => {
    const info = commandInfo('fix', 'nvt');
    const temp = info.keywords.find(k => k.name === 'temp');
    expect(temp).toEqual({ name: 'temp', values: ['Tstart', 'Tstop', 'Tdamp'], units: { Tdamp: 'time' } });
    expect(info.keywords.find(k => k.name === 'mtk').choices).toEqual(['yes', 'no']);
    expect(info.keywords.find(k => k.name === 'couple').choices).toEqual(['none', 'xyz', 'xy', 'yz', 'xz']);
    expect(info.defaults).toMatchObject({ tchain: '3', pchain: '3', mtk: 'yes', drag: '0.0' });
    expect(info.units.Pdamp).toBe('time');
  });

  test('value words are not keywords', () => {
    const names = commandInfo('fix', 'langevin').keywords.map(k => k.name);
    expect(names).toEqual(['angmom', 'gjf', 'omega', 'scale', 'tally', 'zero']);
    expect(commandInfo('fix', 'langevin').keywords[0].values).toEqual(['no|factor']);
    expect(commandInfo('fix', 'langevin').units).toMatchObject({ Tstart: 'temperature', damp: 'time' });
    expect(commandInfo('neigh_modify').keywords.map(k => k.name)).not.toContain('yes');
    expect(commandInfo('kspace_style', 'pppm').keywords).toEqual([]);
  });

  test('positional choices, style attributes and keyword words', () => {
    expect(commandInfo('pair_style', 'buck/long/coul/long').choices.flag_buck).toEqual(['long', 'cut']);
    expect(commandInfo('dump', 'custom').attributes).toEqual(expect.arrayContaining(['id', 'type', 'x', 'xu', 'vx', 'fx', 'c_ID', 'v_name']));
    const custom = commandInfo('thermo_style').keywords.find(k => k.name === 'custom');
    expect(custom.words).toEqual(expect.arrayContaining(['step', 'temp', 'press', 'pe', 'etotal', 'density', 'c_ID', 'v_name']));
  });

  test('command defaults written as a command line', () => {
    expect(commandInfo('units').defaults).toEqual(['units lj']);
  });
});

describe('summaries', () => {
  test('every key names something LAMMPS has, written as in an input', () => {
    for (const key of Object.keys(SUMMARIES)) {
      const info = commandInfo(key);
      expect(info && info.key).toBe(key);
      expect(styleExists(key)).toBe(true);
    }
  });

  test('every core command has one', () => {
    const core = listCommands({ kind: 'command' }).filter(i => !i.removed && !i.packages.length);
    expect(core.length).toBeGreaterThan(90);
    expect(core.filter(i => !i.summary).map(i => i.key)).toEqual([]);
  });

  test('are single plain lines', () => {
    for (const [key, text] of Object.entries(SUMMARIES)) {
      expect(text).toMatch(/^[A-Z0-9r].*\.$/);   // r for rRESPA
      expect(text).not.toMatch(/\n/);
      expect(text.length).toBeLessThan(170);
      expect(text.length).toBeGreaterThan(10);
      expect([key, /\bminimiz|behavior\b|\bcolor\b/i.test(text)]).toEqual([key, false]);   // British spelling
    }
  });

  test('accelerated variants and aliases share them, unknown entries give an empty string', () => {
    expect(commandInfo('pair_style', 'lj/cut/gpu').summary).toBe(SUMMARIES['pair_style lj/cut']);
    expect(commandInfo('pair_style', 'lj/sdk').summary).toBe(SUMMARIES['pair_style lj/spica']);
    expect(commandInfo('pair_style', 'beck/gpu').summary).toBe(SUMMARIES['pair_style beck']);
    expect(commandInfo('compute', 'ackland/atom').summary).toBe(SUMMARIES['compute ackland/atom']);
    expect(commandInfo('pair_style', 'tri/lj').summary).toBe('');
  });
});

describe('listing and search', () => {
  test('listCommands lists plain styles of a kind, in name order', () => {
    const fixes = listCommands({ kind: 'fix' });
    expect(fixes.length).toBeGreaterThan(250);
    expect(fixes.every(i => i.kind === 'fix' && !i.accelerator)).toBe(true);
    const names = fixes.map(i => i.name);
    expect([...names].sort()).toEqual(names);
    expect(listCommands({ kind: 'pair_style' }).map(i => i.name)).toContain('lj/cut');
    expect(listCommands().length).toBeGreaterThan(1000);
  });

  test.each([
    ['nvt', 'fix nvt'],
    ['fix nvt', 'fix nvt'],
    ['lj/cut', 'pair_style lj/cut'],
    ['pair lj cut', 'pair_style lj/cut'],
    ['pair_style lj/cut/coul/long', 'pair_style lj/cut/coul/long'],
    ['units', 'units'],
    ['read data', 'read_data'],
    ['lagevin', 'fix langevin'],
    ['langevn', 'fix langevin'],
    ['neighbour', 'neighbor'],
    ['minimise', 'minimize'],
    ['pppm', 'kspace_style pppm'],
    ['shake', 'fix shake'],
    ['diffusion', 'compute msd'],
    ['radial distribution', 'compute rdf']
  ])('%s finds %s first', (query, key) => {
    expect(searchCommands(query)[0].key).toBe(key);
  });

  test('summary words find the styles people use', () => {
    const thermostats = searchCommands('thermostat', { limit: 12 }).map(i => i.key);
    expect(thermostats).toEqual(expect.arrayContaining(['fix nvt', 'fix langevin', 'fix temp/csvr', 'fix temp/berendsen']));
    const barostats = searchCommands('barostat', { limit: 8 }).map(i => i.key);
    expect(barostats).toEqual(expect.arrayContaining(['fix npt', 'fix nph', 'fix press/berendsen']));
  });

  test('the kind option narrows the search, and limit caps it', () => {
    expect(searchCommands('harmonic', { kind: 'bond' }).every(i => i.kind === 'bond')).toBe(true);
    expect(searchCommands('harmonic', { kind: 'bond_style' })[0].key).toBe('bond_style harmonic');
    expect(searchCommands('lj', { limit: 3 })).toHaveLength(3);
    expect(searchCommands('')).toEqual([]);
    expect(searchCommands('zzzzqqq')).toEqual([]);
  });
});

/*
 * The generated tables match the LAMMPS source tree they come from, when it
 * is there (it is not in git): node tools/build-lammps-docs.mjs --check.
 */
const SOURCE = path.join(ROOT, 'lammps');
const withSource = fs.existsSync(path.join(SOURCE, 'doc', 'src', 'Commands_all.rst')) ? describe : describe.skip;

withSource('the generated tables', () => {
  test('are up to date with the LAMMPS source', () => {
    const run = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-lammps-docs.mjs'), '--check'], { encoding: 'utf8' });
    expect(run.stdout).toMatch(/up to date/);
    expect(run.status).toBe(0);
  });
});

/*
 * With a LAMMPS binary (LMP_BIN), every style `lmp -h` lists resolves, the
 * packages the reference gives are installed in that build, and every name
 * the reference expects in a build with those packages and compile flags is
 * listed. Without LMP_BIN these tests are skipped.
 */
const LMP = process.env.LMP_BIN || '';
const withLammps = LMP ? describe : describe.skip;

const HEADINGS = {
  Atom: 'atom', Integrate: 'integrate', Minimize: 'minimize', Pair: 'pair', Bond: 'bond', Angle: 'angle',
  Dihedral: 'dihedral', Improper: 'improper', KSpace: 'kspace', Fix: 'fix', Compute: 'compute',
  Region: 'region', Dump: 'dump', Command: 'command'
};

function parseHelp(text) {
  const block = (title) => {
    const m = new RegExp(`${title}:\\s*\\n\\s*\\n([\\s\\S]*?)\\n\\s*\\n`).exec(text);
    return m ? m[1] : '';
  };
  const packages = block('Installed packages').trim().split(/\s+/).filter(Boolean);
  const flags = [...block('Active compile time flags').matchAll(/-D(\w+)/g)].map(m => m[1]);
  const styles = [];
  let kind = null;
  for (const line of text.slice(text.indexOf('List of individual style options')).split('\n')) {
    const h = /^\* (\w+) styles/.exec(line);
    if (h) { kind = HEADINGS[h[1]] || null; continue; }
    if (kind && line.trim()) for (const name of line.trim().split(/\s+/)) styles.push([kind, name]);
  }
  return { packages, flags, styles };
}

withLammps(`styles of the LAMMPS binary (${LMP})`, () => {
  let help = null;
  beforeAll(() => {
    const run = spawnSync(LMP, ['-h'], { encoding: 'utf8', env: { ...process.env, OMP_NUM_THREADS: '1' } });
    help = parseHelp(run.stdout);
  });

  test('every listed style resolves through commandInfo', () => {
    expect(help.styles.length).toBeGreaterThan(300);
    const missing = help.styles.filter(([kind, name]) => !(kind === 'command' ? commandInfo(name) : commandInfo(kind, name)));
    expect(missing).toEqual([]);
  });

  test('every listed style needs only packages the build has', () => {
    const wrong = [];
    for (const [kind, name] of help.styles) {
      const info = kind === 'command' ? commandInfo(name) : commandInfo(kind, name);
      const lacking = info.packages.filter(p => !help.packages.includes(p));
      if (lacking.length) wrong.push(`${info.key}: ${lacking.join(' ')}`);
    }
    expect(wrong).toEqual([]);
  });

  test('every style the reference expects in this build is listed', () => {
    const listed = new Set(help.styles.map(([k, n]) => `${k} ${n}`));
    const absent = [];
    for (const info of listCommands()) {
      if (info.kind === 'body' || info.kind === 'reader' || info.builtin) continue;   // lmp -h does not list these
      for (const name of [info.base, ...info.accelerators.map(a => `${info.base}/${a}`)]) {
        const args = info.kind === 'command' ? [name] : [info.kind, name];
        if (!styleExists(...args, { packages: help.packages, flags: help.flags })) continue;
        if (!listed.has(`${info.kind} ${name}`)) absent.push(`${info.kind} ${name}`);
      }
    }
    expect(absent).toEqual([]);
  });
});
