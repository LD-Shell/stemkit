import { describe, test, expect, afterAll } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  RUN_LAYOUTS, gromacsPlumedTimestep, runHours, replicaFile, windowCentres,
  restartNeeds, buildRunKit
} from '../src/core/plumed-run.js';

/*
 * The job scripts were run for real, with GROMACS 2025 and LAMMPS driving
 * PLUMED and the jobs killed at random, for every method and layout; see
 * the module header. These tests pin down what was checked there: the files
 * each layout writes, what the inputs hold, and the shell functions that
 * decide what a continued run starts from.
 */

const DISTANCE = { id: 'cv1', type: 'DISTANCE', label: 'd', values: { ATOMS: '1,2' }, bias: true,
  biasValues: { sigma: '0.05', min: '0', max: '2.5', bin: '250' } };

function plumed(method, params = {}) {
  return {
    version: '2.11',
    cvs: [DISTANCE],
    bias: { method, params, temp: '300', stride: '500', grid: true, walkers: { mode: 'none' } },
    prints: [{ file: 'COLVAR', stride: '100' }]
  };
}

const METHODS = {
  wt_metad: { PACE: '500', HEIGHT: '1.0', BIASFACTOR: '8', TEMP: '300' },
  pbmetad: { PACE: '500', HEIGHT: '1.0', BIASFACTOR: '8', TEMP: '300' },
  opes: { PACE: '500', BARRIER: '20', TEMP: '300' },
  abmd: { TO: '1.5', KAPPA: '100' },
  moving: { STEP0: '0', AT0: '0.5', KAPPA0: '100', STEP1: '100000', AT1: '1.5', KAPPA1: '100' },
  restraint: { AT: '1.0', KAPPA: '500' }
};

function kit(method, extra = {}) {
  return buildRunKit({ plumed: plumed(method, METHODS[method]), temperature: 300, ...extra });
}

const file = (k, p) => (k.files.find(f => f.path === p) || {}).text;

/* Directories the tests make, removed when they are done. */
const made = [];
const tmpDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
afterAll(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
const paths = (k) => k.files.map(f => f.path).sort();

const hasBash = spawnSync('bash', ['-c', 'true']).status === 0;
const hasPlumed = spawnSync('plumed', ['--help'], { encoding: 'utf8' }).status === 0;

describe('helpers', () => {
  test('GROMACS hands PLUMED the time step in single precision', () => {
    expect(gromacsPlumedTimestep(0.002)).toBe('0.0020000000949949026');
    expect(gromacsPlumedTimestep(0.004)).toBe('0.004000000189989805');
    expect(gromacsPlumedTimestep(0)).toBe('');
  });

  test('the engine stops before the wall time, with a margin of 6 to 30 minutes', () => {
    expect(runHours('24:00:00')).toBe(23.5);
    expect(runHours('01:00:00')).toBe(0.9);
    expect(runHours('2-00:00:00')).toBe(47.5);
    expect(runHours('')).toBeNull();
  });

  test('replica files are named as PLUMED names them', () => {
    // The number goes before an extension of one to four characters.
    expect(replicaFile('COLVAR', 1)).toBe('COLVAR.1');
    expect(replicaFile('colvar.dat', 0)).toBe('colvar.0.dat');
    expect(replicaFile('HILLS.d', 2)).toBe('HILLS.2.d');
    expect(replicaFile('out.xyzab', 1)).toBe('out.xyzab.1');
    expect(replicaFile('dir.v2/COLVAR', 3)).toBe('dir.v2/COLVAR.3');
  });

  test('umbrella centres are spread evenly', () => {
    expect(windowCentres(0.4, 0.8, 3)).toEqual(['0.4', '0.6', '0.8']);
    expect(windowCentres(0, 1, 5)).toEqual(['0', '0.25', '0.5', '0.75', '1']);
    expect(windowCentres(2, 2, 1)).toEqual(['2']);
    expect(windowCentres('a', 1, 3)).toEqual([]);
  });
});

describe('what each method reads back', () => {
  const info = { targets: ['d'], label: 'b' };
  test('metadynamics reads its hills, PBMETAD one file per variable', () => {
    expect(restartNeeds({ method: 'wt_metad', params: {} }, info).hills).toEqual(['HILLS']);
    expect(restartNeeds({ method: 'metad', params: { FILE: 'H' } }, info).hills).toEqual(['H']);
    expect(restartNeeds({ method: 'pbmetad', params: {} }, { targets: ['d', 't.x'], label: 'pb' }).hills)
      .toEqual(['HILLS.d', 'HILLS.t_x']);
  });
  test('OPES reads its state; ABMD its ratchet; MOVINGRESTRAINT nothing', () => {
    const o = restartNeeds({ method: 'opes', params: {} }, info);
    expect(o.state).toEqual(['State.data']);
    expect(o.kernels).toEqual(['Kernels.data']);
    expect(restartNeeds({ method: 'abmd', params: {} }, info).abmd.columns).toEqual(['b.d_min']);
    // The names generatePlumedInput prints win: from 2.10 a shortcut's cn.mean makes cn_mean_min.
    expect(restartNeeds({ method: 'abmd', params: {} },
      { targets: ['cn.mean', 'd'], label: 'b', printable: ['b.bias', 'b.cn_mean_min', 'b.d_min'] }).abmd.columns)
      .toEqual(['b.cn_mean_min', 'b.d_min']);
    const m = restartNeeds({ method: 'moving', params: {} }, info);
    expect(m.hills).toEqual([]);
    expect(m.notes.join(' ')).toMatch(/work starts again from zero/);
  });
});

describe('the files of each layout', () => {
  test('one simulation', () => {
    expect(paths(kit('wt_metad'))).toEqual(['README.md', 'chain.sh', 'job.sh', 'plumed.dat']);
    expect(paths(kit('wt_metad', { engine: 'lammps' })))
      .toEqual(['README.md', 'chain.sh', 'in.lammps.template', 'job.sh', 'plumed.dat']);
  });

  test('walkers in one MPI job: one directory each under GROMACS, one input under LAMMPS', () => {
    const g = kit('wt_metad', { layout: 'walkers-mpi', count: 3, scheduler: { tasksPerNode: 3 } });
    expect(paths(g)).toEqual(['README.md', 'chain.sh', 'job.sh', 'w0/plumed.dat', 'w1/plumed.dat', 'w2/plumed.dat']);
    expect(file(g, 'job.sh')).toMatch(/mdrun -multidir \$DIRS/);
    const l = kit('wt_metad', { engine: 'lammps', layout: 'walkers-mpi', count: 2, scheduler: { tasksPerNode: 2 } });
    expect(paths(l)).toContain('plumed.dat');
    expect(file(l, 'job.sh')).toMatch(/-partition "\$\{NW\}x/);
  });

  test('walkers as separate jobs share a hills directory, one array task each', () => {
    const k = kit('wt_metad', { layout: 'walkers-files', count: 2 });
    expect(paths(k)).toEqual(['README.md', 'chain.sh', 'hills/.keep', 'job.sh', 'w0/plumed.dat', 'w1/plumed.dat']);
    expect(file(k, 'job.sh')).toMatch(/#SBATCH --array=1-2/);
  });

  test('umbrella windows get one centre each', () => {
    const k = kit('restraint', { layout: 'windows', count: 3, windows: { from: 0.4, to: 0.8, kappa: '800' } });
    expect(['win0', 'win1', 'win2'].map(d => (file(k, `${d}/plumed.dat`).match(/AT=(\S+)/) || [])[1]))
      .toEqual(['0.4', '0.6', '0.8']);
    expect(file(k, 'win1/plumed.dat')).toMatch(/KAPPA=800/);
  });

  test('a layout the method cannot use falls back, and says why', () => {
    const a = kit('restraint', { layout: 'walkers-mpi', count: 2 });
    expect(a.layout).toBe('single');
    expect(a.warnings.join(' ')).toMatch(/Multiple walkers share a metadynamics or OPES bias/);
    const b = kit('opes', { layout: 'walkers-files', count: 2, scheduler: { tasksPerNode: 2 } });
    expect(b.layout).toBe('walkers-mpi');
    const c = kit('wt_metad', { layout: 'windows', count: 3 });
    expect(c.layout).toBe('single');
  });

  test('extra files go beside every input', () => {
    const k = kit('wt_metad', { layout: 'walkers-files', count: 2, extraFiles: { 'centres.dat': 'c: CENTER ATOMS=1-3\n' } });
    expect(paths(k)).toEqual(expect.arrayContaining(['w0/centres.dat', 'w1/centres.dat']));
  });
});

describe('what the inputs hold', () => {
  test('no input starts with RESTART: the job script adds it', () => {
    for (const m of Object.keys(METHODS)) {
      for (const f of kit(m).files.filter(x => x.path.endsWith('plumed.dat'))) {
        expect(f.text).not.toMatch(/^RESTART/m);
      }
    }
  });

  test('OPES writes its state at every chunk (GROMACS) or restart file (LAMMPS), and reads it back', () => {
    const g = file(kit('opes', { gromacs: { chunk: 30000 } }), 'plumed.dat');
    expect(g).toMatch(/STATE_RFILE=State\.data/);
    expect(g).toMatch(/STATE_WSTRIDE=30000/);
    const l = file(kit('opes', { engine: 'lammps', lammps: { restartEvery: 12345 } }), 'plumed.dat');
    // Rounded to whole depositions: PLUMED refuses a state interval under PACE.
    expect(l).toMatch(/STATE_WSTRIDE=12500/);
  });

  test('LAMMPS inputs flush at the restart interval', () => {
    expect(file(kit('wt_metad', { engine: 'lammps', lammps: { restartEvery: 5000 } }), 'plumed.dat')).toMatch(/^FLUSH STRIDE=5000$/m);
    // A flush interval of the user's own that divides it is kept.
    const own = plumed('wt_metad', METHODS.wt_metad);
    own.preamble = { flush: '1000' };
    const k = buildRunKit({ plumed: own, engine: 'lammps', lammps: { restartEvery: 5000 } });
    expect(file(k, 'plumed.dat')).toMatch(/^FLUSH STRIDE=1000$/m);
    expect(file(kit('wt_metad'), 'plumed.dat')).not.toMatch(/^FLUSH/m);
  });

  test('ABMD prints its ratchet position in full at every step a checkpoint can fall on', () => {
    const g = kit('abmd', { gromacs: { chunk: 20000 } });
    expect(file(g, 'plumed.dat')).toMatch(/^PRINT ARG=abmd\.d_min FILE=ABMD_MIN STRIDE=20000 FMT=%\.15g$/m);
    expect(file(g, 'job.sh')).toMatch(/^CHUNK=20000/m);
    const l = kit('abmd', { engine: 'lammps', lammps: { restartEvery: 5000 } });
    expect(file(l, 'plumed.dat')).toMatch(/FILE=ABMD_MIN STRIDE=5000/);
  });

  test('ABMD of a shortcut component prints the column PLUMED makes', () => {
    const cn = { id: 'cv1', type: 'COORDINATIONNUMBER', label: 'cn', bias: true,
      values: { SPECIES: '1-20', R_0: '0.3', D_MAX: '0.6', MEAN: true },
      biasValues: { comp: '.mean', min: '0', max: '20', bin: '200', sigma: '0.2' } };
    const at = (version) => file(buildRunKit({ plumed: { ...plumed('abmd', METHODS.abmd), version, cvs: [cn, DISTANCE] },
      temperature: 300, gromacs: { chunk: 20000 } }), 'plumed.dat');
    for (const v of ['2.10', '2.11']) {
      expect(at(v)).toMatch(/^PRINT ARG=abmd\.cn_mean_min,abmd\.d_min FILE=ABMD_MIN /m);
    }
    expect(at('2.9')).toMatch(/^PRINT ARG=abmd\.cn\.mean_min,abmd\.d_min FILE=ABMD_MIN /m);
  });

  (hasPlumed ? test : test.skip)('PLUMED reads the ABMD_MIN line of a shortcut component', () => {
    const version = (spawnSync('plumed', ['info', '--version'], { encoding: 'utf8' }).stdout.match(/\d+\.\d+/) || [''])[0];
    if (!['2.10', '2.11'].includes(version)) return;
    const cn = { id: 'cv1', type: 'COORDINATIONNUMBER', label: 'cn', bias: true,
      values: { SPECIES: '1-20', R_0: '0.3', D_MAX: '0.6', MEAN: true },
      biasValues: { comp: '.mean', min: '0', max: '20', bin: '200', sigma: '0.2' } };
    const dir = tmpDir('stemkit-abmd-');
    const text = file(buildRunKit({ plumed: { ...plumed('abmd', METHODS.abmd), version, cvs: [cn, DISTANCE] }, temperature: 300 }), 'plumed.dat');
    fs.writeFileSync(path.join(dir, 'plumed.dat'), text);
    const r = spawnSync('plumed', ['driver', '--plumed', 'plumed.dat', '--natoms', '40', '--parse-only'], { cwd: dir, encoding: 'utf8' });
    expect({ status: r.status, error: (`${r.stdout}${r.stderr}`.match(/ERROR[^\n]*|not known[^\n]*|cannot find[^\n]*/i) || [''])[0] })
      .toEqual({ status: 0, error: '' });
  });

  test('the README says which repeated rows are counted once', () => {
    const readme = file(kit('wt_metad'), 'README.md');
    expect(readme).toContain('COLVAR rows a continued run wrote again are counted once, while every hill in a HILLS file is kept.');
  });

  test('MPI walkers under GROMACS read the shared files from walker 0', () => {
    const k = kit('pbmetad', { layout: 'walkers-mpi', count: 2, scheduler: { tasksPerNode: 2 } });
    for (const d of ['w0', 'w1']) {
      const t = file(k, `${d}/plumed.dat`);
      expect(t).toMatch(/WALKERS_MPI/);
      expect(t).toMatch(/WALKERS_DIR=\.\.\/w0/);
    }
    const o = kit('opes', { layout: 'walkers-mpi', count: 2, scheduler: { tasksPerNode: 2 } });
    expect(file(o, 'w1/plumed.dat')).toMatch(/STATE_RFILE=\.\.\/w0\/State\.data/);
  });

  test('separate walkers each get their own id', () => {
    const k = kit('wt_metad', { layout: 'walkers-files', count: 3 });
    expect([0, 1, 2].map(i => (file(k, `w${i}/plumed.dat`).match(/WALKERS_ID=(\d+)/) || [])[1])).toEqual(['0', '1', '2']);
    expect(file(k, 'w0/plumed.dat')).toMatch(/WALKERS_N=3/);
    expect(file(k, 'w0/plumed.dat')).toMatch(/WALKERS_DIR=\.\.\/hills/);
    // The warning about one id for all walkers belongs to a single file, not to these.
    expect(k.warnings.join(' ')).not.toMatch(/hardcodes/);
  });

  test('too few MPI tasks for the walkers is reported', () => {
    expect(kit('wt_metad', { layout: 'walkers-mpi', count: 4, scheduler: { tasksPerNode: 2 } }).warnings.join(' '))
      .toMatch(/4 walkers in one MPI job need at least 4 MPI tasks/);
  });
});

describe('the job scripts', () => {
  const combos = [];
  for (const engine of ['gromacs', 'lammps']) {
    for (const layout of Object.keys(RUN_LAYOUTS)) {
      for (const method of Object.keys(METHODS)) {
        for (const scheduler of ['slurm', 'pbs', 'lsf', 'sge']) combos.push({ engine, layout, method, scheduler });
      }
    }
  }

  (hasBash ? test : test.skip)(`every combination is valid bash (${combos.length} scripts)`, () => {
    const bad = [];
    for (const c of combos) {
      const k = kit(c.method, { engine: c.engine, layout: c.layout, count: 2, scheduler: { scheduler: c.scheduler, tasksPerNode: 2 },
        windows: { from: 0.5, to: 1.0 } });
      for (const name of ['job.sh', 'chain.sh']) {
        const r = spawnSync('bash', ['-n'], { input: file(k, name), encoding: 'utf8' });
        if (r.status !== 0) bad.push(`${c.engine}/${k.layout}/${c.method}/${c.scheduler} ${name}: ${r.stderr.trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test('OPES and ABMD run in chunks on GROMACS, with periodic checkpoints off', () => {
    for (const m of ['opes', 'abmd']) {
      const j = file(kit(m), 'job.sh');
      expect(j).toMatch(/run_engine -nsteps "\$n" -cpt 1000000/);
    }
    expect(file(kit('wt_metad'), 'job.sh')).toMatch(/run_engine -maxh "\$MAXH"/);
    expect(file(kit('opes', { engine: 'lammps' }), 'job.sh')).not.toMatch(/-nsteps/);
  });

  test('one job at a time per run directory', () => {
    expect(file(kit('wt_metad'), 'job.sh')).toMatch(/flock -n 9 \|\| die/);
  });

  test('the chain script queues with each scheduler\'s own dependency', () => {
    const chain = (s) => file(kit('wt_metad', { scheduler: { scheduler: s } }), 'chain.sh');
    expect(chain('slurm')).toMatch(/--dependency=afterany:\$prev/);
    expect(chain('pbs')).toMatch(/-W depend=afterany:\$prev/);
    expect(chain('lsf')).toMatch(/-w "ended\(\$prev\)"/);
    expect(chain('sge')).toMatch(/-hold_jid \$prev/);
  });

  test('the README tells separate walkers to keep overlapping hills', () => {
    expect(file(kit('wt_metad', { layout: 'walkers-files', count: 2 }), 'README.md')).toMatch(/fes hills\/HILLS\.\* .*--keep-overlap/);
    expect(file(kit('wt_metad'), 'README.md')).not.toMatch(/--keep-overlap/);
  });
});

/* The settings and functions of a generated script, with the time step a
   GROMACS job would read from a tpr of 2 fs (unless the body sets its own). */
const functions = (k) => {
  const j = file(k, 'job.sh');
  const settings = j.slice(j.indexOf('# --- Settings ---'), j.indexOf('# --- Functions ---'));
  const fns = j.slice(j.indexOf('# --- Functions ---'), j.indexOf('# --- Start or continue ---'));
  // The directory lines of an array job need a task number; the functions do not.
  return `${settings.replace(/^(RUN_DIR=|TASK=|\[ -n "\$TASK" \]).*$/gm, '')}\n${fns}`;
};
const runFunctions = (k, body, files, { dt = '0.0020000000949949026' } = {}) => {
  const dir = tmpDir('stk-run-');
  for (const [name, text] of Object.entries(files || {})) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  const times = dt ? `PLUMED_DT=\${PLUMED_DT:-${dt}}; INIT_STEP=0; set_times` : '';
  const r = spawnSync('bash', ['-c', `set -e -o pipefail\n${functions(k)}\nBACKUP=backup/step1; BACKUP_ROOT=backup\n${times}\n${body}`],
    { cwd: dir, encoding: 'utf8' });
  const read = (n) => (fs.existsSync(path.join(dir, n)) ? fs.readFileSync(path.join(dir, n), 'utf8') : null);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, read, dir };
};

/* The shell functions, cut out of a generated script and run on files made
   to look like what a killed job leaves behind. */
describe('the shell functions', () => {
  const run = runFunctions;
  const b = hasBash ? test : test.skip;
  const g = kit('wt_metad');

  const HILLS = '#! FIELDS time d sigma_d height biasf\n#! SET multivariate false\n' +
    ' 1 0.5 0.05 1.2 8\n 2 0.6 0.05 1.1 8\n 3 0.7 0.05 1.0 8\n';

  b('trim keeps the rows up to the checkpoint, and the old copy', () => {
    // A hard kill: hills at 3 and a restarted header and row after the checkpoint at 2.
    const r = run(g, 'trim HILLS 2 le; trim COLVAR 2 lt', {
      HILLS: `${HILLS}#! FIELDS time d sigma_d height biasf\n 4 0.8 0.05 0.9 8\n`,
      COLVAR: '#! FIELDS time d\n 1 0.5\n 2 0.6\n 2.5 0.65\n'
    });
    expect(r.status).toBe(0);
    expect(r.read('HILLS').trim().split('\n').filter(l => !l.startsWith('#')).map(l => l.trim().split(/\s+/)[0])).toEqual(['1', '2']);
    expect(r.read('COLVAR').trim().split('\n').filter(l => !l.startsWith('#')).map(l => l.trim().split(/\s+/)[0])).toEqual(['1']);
    expect(r.read('backup/step1/HILLS')).toMatch(/ 4 0\.8/);
    expect(r.stderr).toMatch(/HILLS: 2 row\(s\) at or past the checkpoint/);
  });

  b('trim drops a row cut off mid-write, and leaves an untouched file alone', () => {
    const r = run(g, 'trim HILLS 9 le; trim COLVAR 9 lt', { HILLS: `${HILLS} 4 0.8 0.0`, COLVAR: '#! FIELDS time d\n 1 0.5\n' });
    expect(r.read('HILLS')).not.toMatch(/ 4 0\.8/);
    expect(r.stderr).toMatch(/1 cut off/);
    expect(r.read('backup/step1/COLVAR')).toBeNull();
  });

  b('a hills file that stops short of the checkpoint stops the job', () => {
    const r = run(g, 'T=10; need_file HILLS 1', { HILLS });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/HILLS ends at time 3, but the checkpoint is at 10/);
    const ok = run(g, 'T=3.5; need_file HILLS 1', { HILLS });
    expect(ok.status).toBe(0);
  });

  b('a missing hills file stops the job once hills are due, and is created before', () => {
    expect(run(g, 'T=10; need_file HILLS 1').stderr).toMatch(/HILLS is missing or empty/);
    const early = run(g, 'T=0.2; need_file HILLS 0');
    expect(early.status).toBe(0);
    expect(early.read('HILLS')).toBe('');
  });

  const o = kit('opes');
  const KERNELS = '#! FIELDS time d sigma_d height logweight\n' + [1, 2, 3, 4, 5].map(t => ` ${t} 0.5 0.05 1 0`).join('\n') + '\n';
  const state = (counter) => `#! FIELDS time d sigma_d height\n#! SET action OPES_METAD_state\n#! SET counter ${counter}\n 1 0.5 0.05 1\n`;
  // Steps and times: PLUMED_DT is 0.002 ps in single precision, so step 1500
  // is time 3.0000001, which holds kernels 1 to 3.
  const helpers = 'candidates() { echo 2000; echo 1500; }; use_step() { echo "USE $1"; }; WHAT="the OPES state"';

  b('the OPES state is matched to the checkpoint by its kernel count', () => {
    // The state holds 3 kernels (counter 4): it belongs to step 1500, not 2000.
    const r = run(o, `${helpers}; settle_state State.data Kernels.data`, { 'State.data': state(4), 'Kernels.data': KERNELS });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/USE 1500/);
  });

  b('a state cut off, or one checkpoint ahead, gives way to PLUMED\'s previous copy', () => {
    const cut = run(o, `${helpers}; settle_state State.data Kernels.data`, {
      'State.data': '#! FIELDS time d', 'bck.last.State.data': state(4), 'Kernels.data': KERNELS
    });
    expect(cut.stdout).toMatch(/USE 1500/);
    expect(cut.read('State.data')).toMatch(/counter 4/);
    const ahead = run(o, `${helpers}; settle_state State.data Kernels.data`, {
      'State.data': state(6), 'bck.last.State.data': state(5), 'Kernels.data': KERNELS
    });
    // Counter 5 is 4 kernels, up to time 4: step 2000.
    expect(ahead.stdout).toMatch(/USE 2000/);
    expect(ahead.stdout).toMatch(/using PLUMED's previous state/);
  });

  b('no state matching any checkpoint stops the job', () => {
    const r = run(o, `${helpers}; settle_state State.data Kernels.data`, { 'State.data': state(9), 'Kernels.data': KERNELS });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/No OPES state here matches a checkpoint/);
  });

  const a = kit('abmd');
  const MIN = '#! FIELDS time abmd.d_min\n 0 0.99\n 3.0000001 0.0125\n 4 0.01\n';
  b('ABMD carries on from the ratchet position at the checkpoint', () => {
    const r = run(a, `candidates() { echo 1500; }; use_step() { echo "USE $1"; }; settle_abmd ABMD_MIN abmd.d_min; echo "MIN=$MIN"`, { ABMD_MIN: MIN });
    expect(r.stdout).toMatch(/USE 1500/);
    expect(r.stdout).toMatch(/MIN=0\.0125/);
  });

  b('with no position for any checkpoint ABMD stops, unless the reset is accepted', () => {
    const body = 'candidates() { echo 2500; }; use_step() { :; }; settle_abmd ABMD_MIN abmd.d_min; echo "MIN=[$MIN]"';
    const r = run(a, body, { ABMD_MIN: MIN });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/ABMD_RESET=1/);
    const reset = run(a, `ABMD_RESET=1; ${body}`, { ABMD_MIN: MIN });
    expect(reset.stdout).toMatch(/MIN=\[\]/);
  });
});

/* The real parser, when a PLUMED binary is on the path. */
(hasPlumed ? describe : describe.skip)('PLUMED reads every input', () => {
  test.each(Object.keys(METHODS))('%s', (method) => {
    const layouts = ['single', 'walkers-files', 'windows'];
    for (const layout of layouts) {
      for (const engine of ['gromacs', 'lammps']) {
        const k = kit(method, { layout, engine, count: 2, windows: { from: 0.5, to: 1 } });
        for (const f of k.files.filter(x => x.path.endsWith('plumed.dat'))) {
          const dir = tmpDir('stk-parse-');
          fs.writeFileSync(path.join(dir, 'plumed.dat'), f.text);
          const r = spawnSync('plumed', ['driver', '--natoms', '4', '--parse-only', '--plumed', 'plumed.dat'],
            { cwd: dir, encoding: 'utf8', timeout: 60000 });
          if (r.status !== 0) throw new Error(`${method}/${engine}/${k.layout} ${f.path}:\n${(r.stdout + r.stderr).split('\n').filter(l => /ERROR|error/.test(l)).slice(0, 5).join('\n')}`);
        }
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Found in review. Each test is the reproduction, or checks the fix
 * against the program the finding came from when it is installed.
 * ------------------------------------------------------------------ */

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const GMX = [process.env.GMX_BIN, 'gmx', 'gmx_mpi']
  .find(g => g && spawnSync(g, ['--version'], { encoding: 'utf8' }).status === 0) || '';
const hasNumpy = spawnSync('python3', ['-c', 'import numpy'], { encoding: 'utf8' }).status === 0;
const E = { id: 'cv2', type: 'DISTANCE', label: 'e', values: { ATOMS: '3,4' }, bias: true,
  biasValues: { sigma: '0.05', min: '0', max: '2.5', bin: '250' } };
const b = hasBash ? test : test.skip;
const lines = (text) => text.split('\n');
const dataRows = (text) => lines(text).filter(l => l.trim() && !l.startsWith('#'));

/* A stand-in for gmx, so that job.sh runs whole without GROMACS. The "tpr" is
   the text gmx dump prints and a "checkpoint" holds its step. mdrun writes the
   checkpoint where it stops, and the rows PLUMED would have printed by then at
   PLUMED's time, the step times dt in single precision: a hill every PACE
   steps after the first step, and with FAKE_CHUNK the ABMD ratchet at every
   multiple of it. It stops after FAKE_SEGMENT steps, as -maxh would. */
const FAKE_GMX = String.raw`#!/bin/bash
case "$1" in
  --version) p=$FAKE_PRECISION; [ -n "$p" ] || p=mixed; echo "Precision:           $p"; exit 0 ;;
  dump) if [ "$2" = -s ]; then cat "$3"; elif [ -f "$3" ]; then echo "   step = $(cat "$3")"; fi; exit 0 ;;
  mdrun) ;;
  *) exit 1 ;;
esac
shift; nsteps=""; cpi=""; deffnm=md
while [ $# -gt 0 ]; do
  case "$1" in -cpi) cpi=$2; shift ;; -nsteps) nsteps=$2; shift ;; -deffnm) deffnm=$2; shift ;; esac
  shift
done
read -r n i d <<< "$(awk '$1 == "nsteps" { n = $3 } $1 == "init-step" { i = $3 } $1 == "dt" { d = $3 } END { print n, i, d }' "$deffnm.tpr")"
start=$i; [ -f "$cpi" ] && start=$(cat "$cpi")
last=$((i + n)); [ -n "$nsteps" ] && last=$((start + nsteps))
seg=$FAKE_SEGMENT; [ -n "$seg" ] || seg=1000000000
end=$((start + seg)); [ "$end" -gt "$last" ] && end=$last
dt=$(awk -v d="$d" 'BEGIN { m = d; e = 0; while (m >= 2) { m /= 2; e++ } while (m < 1) { m *= 2; e-- } printf "%.17g", int(m * 8388608 + 0.5) / 8388608 * 2 ^ e }')
[ -s HILLS ] || echo '#! FIELDS time d sigma_d height biasf' >> HILLS
awk -v a="$start" -v b="$end" -v p=500 -v dt="$dt" 'BEGIN { for (s = (int(a / p) + 1) * p; s <= b; s += p) printf " %.6f 1.0 0.05 1.0 8\n", s * dt }' >> HILLS
if [ -n "$FAKE_CHUNK" ]; then
  [ -s ABMD_MIN ] || echo '#! FIELDS time abmd.d_min' >> ABMD_MIN
  awk -v a="$start" -v b="$end" -v p="$FAKE_CHUNK" -v dt="$dt" 'BEGIN { for (s = int((a + p - 1) / p) * p; s <= b; s += p) printf " %.15g 0.5\n", s * dt }' >> ABMD_MIN
fi
echo "$end" > "$deffnm.cpt"
`;

const tprText = ({ dt, nsteps, init = 0 }) =>
  `md.tpr:\ninputrec:\n   integrator                     = md\n   tinit                          = 0\n` +
  `   dt                             = ${dt}\n   nsteps                         = ${nsteps}\n   init-step                      = ${init}\n`;

/* Runs a kit's job.sh `times` times over, as chained jobs would, with the
   stand-in gmx (or the given programs) first on the PATH. */
function runJobs(k, { tpr, env = {}, times = 1, bin = { gmx: FAKE_GMX }, extra = {} }) {
  const dir = tmpDir('stk-job-');
  fs.mkdirSync(path.join(dir, 'bin'));
  for (const [name, text] of Object.entries({ module: '#!/bin/sh\nexit 0\n', ...bin })) {
    fs.writeFileSync(path.join(dir, 'bin', name), text, { mode: 0o755 });
  }
  for (const f of k.files) {
    fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
    fs.writeFileSync(path.join(dir, f.path), f.text);
  }
  if (tpr) fs.writeFileSync(path.join(dir, 'md.tpr'), tprText(tpr));
  for (const [name, text] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), text);
  const runs = [];
  for (let i = 0; i < times; i++) {
    const r = spawnSync('bash', ['job.sh'], {
      cwd: dir, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, SLURM_CPUS_PER_TASK: '1', ...env }
    });
    runs.push({ status: r.status, out: r.stdout, err: r.stderr });
  }
  const read = (n) => (fs.existsSync(path.join(dir, n)) ? fs.readFileSync(path.join(dir, n), 'utf8') : null);
  return { dir, runs, read };
}

/* A tpr of 213 SPC waters, made with the real grompp, in a new directory. */
function gromacsTpr(mdp) {
  const dir = tmpDir('stk-gmx-');
  const g = (args) => spawnSync(GMX, args, { cwd: dir, encoding: 'utf8', timeout: 120000, env: { ...process.env, OMP_NUM_THREADS: '1' } });
  fs.writeFileSync(path.join(dir, 'topol.top'), '#include "oplsaa.ff/forcefield.itp"\n#include "oplsaa.ff/spc.itp"\n[ system ]\nwater\n[ molecules ]\n');
  fs.writeFileSync(path.join(dir, 'md.mdp'), `integrator = md\n${mdp}cutoff-scheme = Verlet\ncoulombtype = PME\nrcoulomb = 0.8\nrvdw = 0.8\n` +
    'tcoupl = v-rescale\ntc-grps = System\ntau-t = 0.1\nref-t = 300\n');
  expect(g(['solvate', '-cs', 'spc216.gro', '-box', '1.9', '-o', 'conf.gro', '-p', 'topol.top']).status).toBe(0);
  expect(g(['grompp', '-f', 'md.mdp', '-c', 'conf.gro', '-p', 'topol.top', '-o', 'md.tpr', '-maxwarn', '5']).status).toBe(0);
  return dir;
}

describe('#1, #11: the time step comes from the tpr, in the precision mdrun passes it', () => {
  test('without a time step the kit leaves PLUMED_DT to the tpr; with one it writes it for the build', () => {
    expect(file(kit('wt_metad'), 'job.sh')).toMatch(/^PLUMED_DT=""/m);
    expect(file(kit('wt_metad'), 'job.sh')).toMatch(/^settle_tpr "\$DEFFNM\.tpr"; set_times$/m);
    expect(file(kit('wt_metad', { dtPs: 0.002 }), 'job.sh')).toMatch(/^PLUMED_DT="0\.0020000000949949026"/m);
    // gmx_d hands PLUMED the time step in double precision.
    expect(file(kit('wt_metad', { dtPs: 0.002, gromacs: { binary: 'gmx_d' } }), 'job.sh')).toMatch(/^PLUMED_DT="0\.002"/m);
    expect(gromacsPlumedTimestep(0.002, 'double')).toBe('0.002');
  });

  b('a 4 fs run stopped by -maxh halfway keeps every hill (it lost half before)', () => {
    const r = runJobs(kit('wt_metad'), { tpr: { dt: 0.004, nsteps: 24000 }, env: { FAKE_SEGMENT: '12000' }, times: 2 });
    expect(r.runs.map(x => x.status)).toEqual([0, 0]);
    expect(r.runs[0].out).toMatch(/stopped at step 12000 of 24000/);
    expect(r.runs[1].out).toMatch(/Continuing the run from step 12000 \(PLUMED time 48\.0000022/);
    expect(r.runs[1].err).not.toMatch(/at or past the checkpoint/);
    expect(r.runs[1].out).toMatch(/complete: step 24000 of 24000/);
    // 24000 / 500 hills, none deleted.
    expect(dataRows(r.read('HILLS'))).toHaveLength(48);
  });

  b('a PLUMED_DT the tpr does not agree with stops the job before it runs', () => {
    const r = runJobs(kit('wt_metad', { dtPs: 0.002 }), { tpr: { dt: 0.004, nsteps: 24000 } });
    expect(r.runs[0].status).not.toBe(0);
    expect(r.runs[0].err).toMatch(/md\.tpr has a time step of 0\.004 ps, but PLUMED_DT is 0\.0020000000949949026/);
    expect(r.read('md.cpt')).toBeNull();
  });

  b('the time step is rounded as a mixed or a double build passes it', () => {
    const body = (gmx, precision) => `chmod +x fakegmx; GMX=${gmx}; GMX_DUMP=./fakegmx; FAKE_PRECISION=${precision}; export FAKE_PRECISION; ` +
      'PLUMED_DT=""; settle_tpr md.tpr; echo "DT=$PLUMED_DT INIT=$INIT_STEP"';
    const files = { fakegmx: FAKE_GMX, 'md.tpr': tprText({ dt: 0.002, nsteps: 100, init: 7 }) };
    const mixed = runFunctions(kit('abmd'), body('gmx', 'mixed'), files, { dt: '' });
    expect(Number(mixed.stdout.match(/DT=(\S+)/)[1])).toBe(Math.fround(0.002));
    expect(mixed.stdout).toMatch(/INIT=7/);
    const dbl = runFunctions(kit('abmd'), body('gmx', 'double'), files, { dt: '' });
    expect(dbl.stdout).toMatch(/DT=0\.002 /);
    // The binary's name is enough: GROMACS names double builds *_d.
    expect(runFunctions(kit('abmd'), body('gmx_mpi_d', 'mixed'), files, { dt: '' }).stdout).toMatch(/DT=0\.002 /);
  });

  b('with gmx_d, ABMD finds the ratchet at step 2e7 (it stopped there before)', () => {
    const k = kit('abmd', { gromacs: { binary: 'gmx_d', chunk: 2000 } });
    const r = runFunctions(k, 'chmod +x fakegmx; GMX_DUMP=./fakegmx; PLUMED_DT=""; settle_tpr md.tpr; set_times; STEP=20000000; ' +
      'candidates() { echo $STEP; }; use_step() { :; }; WHAT=x; settle_abmd ABMD_MIN abmd.d_min; echo "MIN=$MIN"', {
      fakegmx: FAKE_GMX, 'md.tpr': tprText({ dt: 0.002, nsteps: 20000000 }),
      ABMD_MIN: '#! FIELDS time abmd.d_min\n 39996.000000 0.61\n 40000.000000 0.6\n'
    }, { dt: '' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/MIN=0\.6$/m);
  });

  (GMX ? test : test.skip)('real GROMACS: dt, init-step and the end step are read from a tpr and a checkpoint', () => {
    const dir = gromacsTpr('dt = 0.004\nnsteps = 200\ninit-step = 1000\n');
    const g = spawnSync(GMX, ['mdrun', '-deffnm', 'md', '-nsteps', '50', '-ntomp', '1', ...(/_mpi/.test(GMX) ? [] : ['-ntmpi', '1'])],
      { cwd: dir, encoding: 'utf8', timeout: 120000, env: { ...process.env, OMP_NUM_THREADS: '1' } });
    expect(g.status).toBe(0);
    const r = spawnSync('bash', ['-c', `${functions(kit('wt_metad'))}\nGMX=${GMX}; GMX_DUMP=${GMX}; settle_tpr md.tpr; set_times\n` +
      'echo "DT=$PLUMED_DT INIT=$INIT_STEP STEP=$(cpt_step md.cpt) LAST=$(tpr_last md.tpr) T=$(time_of 12000)"'], { cwd: dir, encoding: 'utf8' });
    expect(Number(r.stdout.match(/DT=(\S+)/)[1])).toBe(Math.fround(0.004));
    // The checkpoint's step is absolute: 1000 + 50. The run ends at 1000 + 200.
    expect(r.stdout).toMatch(/INIT=1000 STEP=1050 LAST=1200 T=48\.0000022/);
  }, 120000);
});

describe('#12: a tpr with init-step > 0 runs to init-step + nsteps', () => {
  test('the chunks start from init-step, and the end is init-step + nsteps', () => {
    const j = file(kit('opes'), 'job.sh');
    expect(j).toMatch(/STEP=\$\{STEP:-\$INIT_STEP\}; LAST=\$\(tpr_last/);
    expect(j).not.toMatch(/NSTEPS/);
    expect(file(kit('wt_metad'), 'job.sh')).toMatch(/need_file HILLS \$\(\( STEP \/ PACE > INIT_STEP \/ PACE \? 1 : 0 \)\)/);
  });

  b('a first segment that stops at step 1050 of 1000 + 200 is not taken for the end', () => {
    const r = runJobs(kit('wt_metad'), { tpr: { dt: 0.004, nsteps: 200, init: 1000 }, env: { FAKE_SEGMENT: '50' }, times: 5 });
    expect(r.runs[0].out).toMatch(/stopped at step 1050 of 1200/);
    expect(r.runs[2].out).toMatch(/stopped at step 1150 of 1200/);
    expect(r.runs[3].out).toMatch(/complete: step 1200 of 1200/);
    expect(r.runs[4].out).toMatch(/complete \(RUN_COMPLETE\)\. Nothing to do/);
  });

  b('chunks end on multiples of CHUNK from init-step, where ABMD printed its ratchet', () => {
    const r = runJobs(kit('abmd', { gromacs: { chunk: 2000 } }), { tpr: { dt: 0.002, nsteps: 5000, init: 1000 }, env: { FAKE_CHUNK: '2000' } });
    expect(r.runs[0].err).toBe('');
    expect(r.runs[0].status).toBe(0);
    expect(r.runs[0].out).toMatch(/Continuing the run from step 2000/);
    expect(r.runs[0].out).toMatch(/Continuing the run from step 4000/);
    expect(r.runs[0].out).toMatch(/complete: step 6000 of 6000/);
  });
});

describe('#2: LAMMPS walkers in one job start from their own data files', () => {
  const k = kit('wt_metad', { engine: 'lammps', layout: 'walkers-mpi', count: 2 });
  test('the template reads system.<walker>.data, and the README says why', () => {
    expect(file(k, 'in.lammps.template')).toMatch(/"read_data system\.\$\{w\}\.data"/);
    expect(file(k, 'README.md')).toMatch(/system\.0\.data` to `system\.1\.data`/);
    expect(file(k, 'README.md')).toMatch(/LAMMPS is deterministic/);
    // One simulation keeps its one data file.
    expect(file(kit('wt_metad', { engine: 'lammps' }), 'in.lammps.template')).toMatch(/"read_data system\.data"/);
  });

  b('job.sh will not start walkers from two copies of one data file', () => {
    const srun = '#!/bin/sh\necho "srun $*" >> launched\n';
    const same = runJobs(k, { bin: { srun }, extra: { 'system.0.data': 'A\n', 'system.1.data': 'A\n' } });
    expect(same.runs[0].status).not.toBe(0);
    expect(same.runs[0].err).toMatch(/system\.0\.data and system\.1\.data are the same/);
    expect(same.read('launched')).toBeNull();
    // Any two walkers, not only walker 0 and another.
    const three = kit('wt_metad', { engine: 'lammps', layout: 'walkers-mpi', count: 3 });
    const pair = runJobs(three, { bin: { srun }, extra: { 'system.0.data': 'A\n', 'system.1.data': 'B\n', 'system.2.data': 'B\n' } });
    expect(pair.runs[0].err).toMatch(/system\.1\.data and system\.2\.data are the same/);
    const own = runJobs(k, { bin: { srun }, extra: { 'system.0.data': 'A\n', 'system.1.data': 'B\n' } });
    expect(own.runs[0].err).toBe('');
    expect(own.read('launched')).toMatch(/-partition 2x1/);
  });
});

describe('#3: umbrella windows', () => {
  const windowsKit = (cvs, params, windows) => buildRunKit({
    plumed: { version: '2.11', cvs, bias: { method: 'restraint', params, walkers: { mode: 'none' } }, prints: [{ file: 'COLVAR', stride: '100' }] },
    layout: 'windows', count: 3, windows
  });
  const ats = (k) => k.files.filter(f => f.path.endsWith('plumed.dat')).map(f => f.text.match(/AT=(\S+)/)[1]);

  test('the range may be written in pi, as PLUMED takes it', () => {
    expect(windowCentres('-pi', 'pi', 3)).toEqual(['-3.14', '0', '3.14']);
    // Rounded, as every centre, to the precision of the step between them.
    expect(windowCentres('0', '2pi', 2)).toEqual(['0', '6.28']);
    expect(windowCentres('', 1, 3)).toEqual([]);
    expect(ats(windowsKit([DISTANCE], { AT: '1.0', KAPPA: '500' }, { from: '-pi', to: 'pi' }))).toEqual(['-3.14', '0', '3.14']);
  });

  test('a range that cannot be read is said, and does not put every window at 0', () => {
    for (const w of [undefined, { from: 'a', to: 'b' }, { from: '0.5' }]) {
      const k = windowsKit([DISTANCE], { AT: '1.0', KAPPA: '500' }, w);
      expect(k.layout).toBe('single');
      expect(k.warnings.join(' ')).toMatch(/Umbrella windows spread their centres from `from` to `to`/);
      // The user's AT stands.
      expect(file(k, 'plumed.dat')).toMatch(/AT=1\.0 /);
    }
    expect(windowsKit([DISTANCE], { AT: '1', KAPPA: '5' }, { from: 1, to: 1 }).warnings.join(' ')).toMatch(/every window restrains at the same centre/);
  });

  test('with two biased variables the windows move the first and keep the user\'s AT for the second', () => {
    const k = windowsKit([DISTANCE, E], { AT: '1.0,2.0', KAPPA: '500,300' }, { from: 0.5, to: 1.5, kappa: '800' });
    expect(ats(k)).toEqual(['0.5,2.0', '1,2.0', '1.5,2.0']);
    expect(file(k, 'win0/plumed.dat')).toMatch(/KAPPA=800,300/);
    expect(k.warnings.join(' ')).toMatch(/windows are spread along the first, `d`; the others keep AT=2\.0 and KAPPA=300/);
    // Legacy lower-case names are the user's AT too.
    expect(ats(windowsKit([DISTANCE, E], { at: '1.0,2.0', kappa: '500' }, { from: 0.5, to: 1.5 }))).toEqual(['0.5,2.0', '1,2.0', '1.5,2.0']);
  });
});

describe('#4: the work of a moving restraint is carried across restarts', () => {
  test('the row at the checkpoint of a file that prints the work stays; FLUSH comes last on LAMMPS', () => {
    const j = file(kit('moving'), 'job.sh');
    expect(j).toMatch(/trim COLVAR "\$T" le/);
    expect(file(kit('wt_metad'), 'job.sh')).toMatch(/trim COLVAR "\$T" lt/);
    const l = file(kit('moving', { engine: 'lammps', lammps: { restartEvery: 1000 } }), 'plumed.dat').trim().split('\n');
    expect(l[l.length - 1]).toBe('FLUSH STRIDE=1000');
    expect(l.findIndex(x => /^PRINT /.test(x))).toBeLessThan(l.length - 1);
  });

  test('a print stride a checkpoint can fall between is said', () => {
    expect(kit('moving').warnings.join(' ')).toMatch(/work of the moving restraint is printed to `COLVAR` every 100 steps.*divides 5/);
    const every5 = plumed('moving', METHODS.moving);
    every5.prints = [{ file: 'COLVAR', stride: '5' }];
    expect(buildRunKit({ plumed: every5 }).warnings.join(' ')).not.toMatch(/work of the moving/);
    // LAMMPS: restart files every 1000 steps and timer checks 1000 steps apart.
    expect(kit('moving', { engine: 'lammps', lammps: { restartEvery: 1000 } }).warnings.join(' ')).not.toMatch(/work of the moving/);
    expect(kit('moving', { engine: 'lammps', lammps: { restartEvery: 1050 } }).warnings.join(' ')).toMatch(/divides 50/);
    expect(file(kit('moving'), 'README.md')).toMatch(/keeps the row printed at the checkpoint/);
    expect(file(kit('moving'), 'README.md')).toMatch(/^python3 analyse_plumed\.py work COLVAR$/m);
    expect(file(kit('wt_metad'), 'README.md')).not.toMatch(/analyse_plumed\.py work/);
  });

  ((hasPlumed && hasNumpy && hasBash) ? test : test.skip)('PLUMED: a run continued at a checkpoint has the work of one in one piece', () => {
    const params = { STEP0: '0', AT0: '0.6', KAPPA0: '200', STEP1: '6000', AT1: '1.6', KAPPA1: '200' };
    const p = plumed('moving', params);
    p.prints = [{ file: 'COLVAR', stride: '10' }];
    const k = buildRunKit({ plumed: p, dtPs: 0.002 });
    const mode = file(k, 'job.sh').match(/trim COLVAR "\$T" (le|lt)/)[1];
    const dir = tmpDir('stk-work-');
    let d = 0.6;
    let seed = 1;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    const frames = [];
    for (let i = 0; i <= 6000; i++) { frames.push(`2\n\nX 1 1 1\nX ${(1 + d).toFixed(9)} 1 1\n`); d = Math.min(2.2, Math.max(0.3, d + 0.00017 + 0.02 * rnd())); }
    for (const sub of ['full', 'seg']) {
      fs.mkdirSync(path.join(dir, sub));
      fs.writeFileSync(path.join(dir, sub, 'plumed.dat'), file(k, 'plumed.dat'));
    }
    fs.writeFileSync(path.join(dir, 'all.xyz'), frames.join(''));
    fs.writeFileSync(path.join(dir, 'a.xyz'), frames.slice(0, 3001).join(''));
    fs.writeFileSync(path.join(dir, 'b.xyz'), frames.slice(3000).join(''));
    const drive = (sub, xyz, input, step) => spawnSync('plumed', ['driver', '--ixyz', `../${xyz}`, '--timestep', '0.0020000000949949026',
      '--plumed', input, '--box', '10,10,10', ...(step ? ['--initial-step', String(step)] : [])], { cwd: path.join(dir, sub), encoding: 'utf8' });
    expect(drive('full', 'all.xyz', 'plumed.dat').status).toBe(0);
    expect(drive('seg', 'a.xyz', 'plumed.dat').status).toBe(0);
    const t = spawnSync('bash', ['-c', `${functions(k)}\nBACKUP=backup/s; BACKUP_ROOT=backup; set_times\n` +
      `T=$(time_of 3000); trim COLVAR "$T" ${mode}; { echo RESTART; cat plumed.dat; } > plumed.restart.dat`], { cwd: path.join(dir, 'seg'), encoding: 'utf8' });
    expect(t.status).toBe(0);
    expect(drive('seg', 'b.xyz', 'plumed.restart.dat', 3000).status).toBe(0);
    const work = (sub) => {
      const r = spawnSync('python3', [path.join(ROOT, 'assets/plumed/analyse_plumed.py'), 'work', 'COLVAR'],
        { cwd: path.join(dir, sub), encoding: 'utf8', env: { ...process.env, MPLBACKEND: 'Agg' } });
      expect(r.status).toBe(0);
      return Number(dataRows(fs.readFileSync(path.join(dir, sub, 'work.dat'), 'utf8')).pop().trim().split(/\s+/)[1]);
    };
    expect(work('seg')).toBeCloseTo(work('full'), 5);
  }, 120000);
});

describe('#5, #6: MPI walkers get the ranks their launch needs', () => {
  /* The MPI ranks a job starts: what the header allocates, as the launch line counts them. */
  const ranksOf = (j) => {
    const threads = Number((j.match(/\/ (\d+)\)\)/) || [])[1] || 1);
    let m;
    if ((m = j.match(/#SBATCH --ntasks-per-node=(\d+)/))) return Number(m[1]) * Number(j.match(/#SBATCH --nodes=(\d+)/)[1]);
    if ((m = j.match(/mpiprocs=(\d+)/))) return Number(m[1]) * Number(j.match(/select=(\d+)/)[1]);
    if ((m = j.match(/#BSUB -n (\d+)/))) return Number(m[1]) / threads;
    return Number(j.match(/#\$ -pe \S+ (\d+)/)[1]) / threads;
  };
  test.each(['slurm', 'pbs', 'lsf', 'sge'])('GROMACS -multidir under %s asks for one rank per walker by default', (s) => {
    const k = kit('wt_metad', { layout: 'walkers-mpi', count: 2, scheduler: { scheduler: s } });
    expect(ranksOf(file(k, 'job.sh'))).toBe(2);
    expect(k.warnings.join(' ')).not.toMatch(/MPI tasks/);
    // On two nodes, one rank each.
    expect(ranksOf(file(kit('wt_metad', { layout: 'walkers-mpi', count: 4, scheduler: { scheduler: s, nodes: 2 } }), 'job.sh'))).toBe(4);
  });

  test('a rank count that is not a multiple of the walkers is said', () => {
    expect(kit('wt_metad', { layout: 'walkers-mpi', count: 2, scheduler: { tasksPerNode: 3 } }).warnings.join(' '))
      .toMatch(/need a multiple of 2 MPI tasks.*asks for 3, which mdrun -multidir refuses/);
    expect(kit('wt_metad', { layout: 'walkers-mpi', count: 2, scheduler: { tasksPerNode: 1 } }).warnings.join(' '))
      .toMatch(/need at least 2 MPI tasks; the job asks for 1/);
  });

  test.each(['slurm', 'pbs', 'lsf', 'sge'])('LAMMPS -partition under %s starts NW x RANKS_PER_WALKER ranks', (s) => {
    const j = file(kit('wt_metad', { engine: 'lammps', layout: 'walkers-mpi', count: 2, scheduler: { scheduler: s, tasksPerNode: 2, cpusPerTask: 8 } }), 'job.sh');
    const perWalker = Number(j.match(/^RANKS_PER_WALKER=(\d+)/m)[1]);
    expect(ranksOf(j)).toBe(2 * perWalker);
  });
});

describe('#7: logs/ exists before a SLURM or Grid Engine job starts', () => {
  test.each([['slurm', 'mkdir -p logs && sbatch job.sh'], ['sge', 'mkdir -p logs && qsub job.sh'], ['pbs', 'qsub job.sh'], ['lsf', 'bsub < job.sh']])('%s', (s, submit) => {
    const k = kit('wt_metad', { scheduler: { scheduler: s } });
    expect(k.submit).toBe(submit);
    expect(file(k, 'README.md')).toContain(`Submit \`${submit}\` once`);
    expect(file(k, 'chain.sh')).toMatch(/^mkdir -p logs$/m);
  });
});

describe('#8: the kit reads PACE and the file names as PLUMED will', () => {
  test('lower-case names, and PACE from the input rather than bias.stride', () => {
    const info = { targets: ['d'], label: 'm' };
    const legacy = restartNeeds({ method: 'wt_metad', params: { pace: '1000', file: 'MYHILLS' } }, info);
    expect(legacy.hills).toEqual(['MYHILLS']);
    expect(legacy.pace).toBe(1000);
    expect(restartNeeds({ method: 'wt_metad', stride: '100', params: {} }, info).pace).toBe(500);
    expect(restartNeeds({ method: 'opes', params: {} }, { ...info, input: 'o: OPES_METAD ...\n    PACE=250\n    FILE=K.data\n    STATE_WFILE=State.data\n...\n' }))
      .toMatchObject({ pace: 250, kernels: ['K.data'] });
  });

  b('bias.stride without PACE: PLUMED lays a hill every 500 steps, and job.sh expects that', () => {
    const p = plumed('wt_metad', { HEIGHT: '1', BIASFACTOR: '8', TEMP: '300' });
    p.bias.stride = '100';
    const k = buildRunKit({ plumed: p });
    expect(file(k, 'plumed.dat')).toMatch(/PACE=500/);
    expect(file(k, 'job.sh')).toMatch(/^PACE=500/m);
    const hills = `#! FIELDS time d sigma_d height biasf\n${[500, 1000].map(s => ` ${(s * 0.0020000000949949026).toFixed(6)} 1.0 0.05 1.0 8`).join('\n')}\n`;
    const r = runFunctions(k, 'STEP=1400; T=$(time_of $STEP); need_file HILLS $(( STEP / PACE > INIT_STEP / PACE ? 1 : 0 )) && echo continues', { HILLS: hills });
    expect(r.stdout).toMatch(/continues/);
  });

  test('legacy {pace, file}: job.sh checks the file PLUMED writes', () => {
    const k = buildRunKit({ plumed: plumed('wt_metad', { pace: '1000', file: 'MYHILLS', height: '1', biasfactor: '8' }) });
    expect(file(k, 'plumed.dat')).toMatch(/FILE=MYHILLS/);
    expect(file(k, 'job.sh')).toMatch(/need_file MYHILLS /);
    expect(file(k, 'job.sh')).toMatch(/^PACE=1000/m);
  });

  (hasPlumed ? test : test.skip)('OPES with bias.stride and a short chunk: the state interval is a whole number of depositions', () => {
    const p = plumed('opes', { BARRIER: '20', TEMP: '300' });
    p.bias.stride = '100';
    const k = buildRunKit({ plumed: p, gromacs: { chunk: 300 } });
    expect(file(k, 'plumed.dat')).toMatch(/STATE_WSTRIDE=500/);
    const dir = tmpDir('stk-opes-');
    fs.writeFileSync(path.join(dir, 'plumed.dat'), file(k, 'plumed.dat'));
    const r = spawnSync('plumed', ['driver', '--natoms', '4', '--parse-only', '--plumed', 'plumed.dat'], { cwd: dir, encoding: 'utf8', timeout: 60000 });
    expect(r.status).toBe(0);
  }, 60000);
});

describe('#9: the README checks PLUMED in GROMACS by running it', () => {
  test('a trial mdrun -plumed, and PLUMED_KERNEL for the GROMACS 2025 interface', () => {
    const r = file(kit('wt_metad'), 'README.md');
    expect(r).not.toMatch(/`gmx mdrun -h` lists `-plumed`\./);
    expect(r).toMatch(/gmx mdrun -s \.\.\/md\.tpr -plumed p\.dat -nsteps 0/);
    expect(r).toMatch(/GROMACS 2025 loads PLUMED from `PLUMED_KERNEL`/);
    expect(file(kit('wt_metad', { layout: 'walkers-files', count: 2 }), 'README.md')).toMatch(/-s \.\.\/w0\/md\.tpr/);
    expect(file(kit('wt_metad'), 'job.sh')).toMatch(/built into GROMACS 2025 .*\n# mode\) loads PLUMED from PLUMED_KERNEL, and mdrun -plumed stops without it/);
    expect(file(kit('wt_metad', { engine: 'lammps' }), 'README.md')).toMatch(/lmp -h` lists PLUMED/);
  });

  (GMX ? test : test.skip)('real GROMACS: the README\'s trial run answers, where mdrun -h cannot', () => {
    // GROMACS 2025 lists -plumed whether or not the interface was built.
    const h = spawnSync(GMX, ['mdrun', '-h'], { encoding: 'utf8' });
    expect(`${h.stdout}${h.stderr}`).toMatch(/-plumed/);
    const dir = gromacsTpr('dt = 0.002\nnsteps = 10\n');
    const readme = file(kit('wt_metad', { gromacs: { binary: GMX } }), 'README.md');
    const block = readme.slice(readme.indexOf('  ```\n  mkdir plumed-check') + 6, readme.indexOf('  ```', readme.indexOf('mkdir plumed-check'))).trim();
    const r = spawnSync('bash', ['-c', block.split('\n').map(l => l.replace(/#.*$/, '').trim()).join('\n')],
      { cwd: dir, encoding: 'utf8', timeout: 120000, env: { ...process.env, OMP_NUM_THREADS: '1' } });
    // A build with the interface runs the step; one without it says so.
    if (r.status !== 0) expect(`${r.stdout}${r.stderr}`).toMatch(/not compiled with the PLUMED interface|PLUMED_KERNEL/);
    else expect(fs.existsSync(path.join(dir, 'plumed-check', 'md.log')) || fs.existsSync(path.join(dir, 'plumed-check', 'confout.gro'))).toBe(true);
  }, 120000);
});

describe('#10: on LAMMPS, FLUSH writes out the ABMD ratchet of each restart step', () => {
  test('FLUSH is the last line, after the ABMD_MIN print', () => {
    const l = file(kit('abmd', { engine: 'lammps', lammps: { restartEvery: 1000 } }), 'plumed.dat').trim().split('\n');
    expect(l[l.length - 1]).toBe('FLUSH STRIDE=1000');
    expect(l.findIndex(x => /FILE=ABMD_MIN/.test(x))).toBe(l.length - 4);
  });
});

describe('#13: separate walkers: a walker\'s own cut-off last row', () => {
  test('job.sh takes it off before the walker runs, in both branches', () => {
    const j = file(kit('wt_metad', { layout: 'walkers-files', count: 2 }), 'job.sh');
    expect(j.match(/cut_partial_row \.\.\/hills\/HILLS\.\$\(\(TASK - 1\)\)/g)).toHaveLength(2);
  });

  b('the row goes, in place, and a whole file is left alone', () => {
    const k = kit('wt_metad', { layout: 'walkers-files', count: 2 });
    const whole = '#! FIELDS time d sigma_d height biasf\n 1 0.5 0.05 1 8\n';
    const r = runFunctions(k, 'ls -i HILLS.0 | cut -d" " -f1 > ino.before; cut_partial_row HILLS.0; cut_partial_row HILLS.1; ' +
      'ls -i HILLS.0 | cut -d" " -f1 > ino.after', { 'HILLS.0': `${whole} 2.2 0.9`, 'HILLS.1': whole });
    expect(r.status).toBe(0);
    expect(r.read('HILLS.0')).toBe(whole);
    expect(r.read('HILLS.1')).toBe(whole);
    // The other walkers hold the file open: it must be the same file.
    expect(r.read('ino.after')).toBe(r.read('ino.before'));
    expect(r.read('backup/HILLS.0.cut-row')).toMatch(/2\.2 0\.9/);
  });

  ((hasPlumed && hasBash) ? test : test.skip)('PLUMED: after the cut, the restarted walker and the others read the file', () => {
    const k = buildRunKit({ plumed: plumed('wt_metad', { PACE: '100', HEIGHT: '1', BIASFACTOR: '8', TEMP: '300' }), layout: 'walkers-files', count: 2 });
    const dir = tmpDir('stk-walk-');
    for (const f of k.files) {
      fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
      fs.writeFileSync(path.join(dir, f.path), f.text);
    }
    const frames = [];
    for (let i = 0; i <= 1000; i++) frames.push(`2\n\nX 1 1 1\nX ${(1.8 + 0.5 * ((i * 37) % 100) / 100).toFixed(6)} 1 1\n`);
    fs.writeFileSync(path.join(dir, 'traj.xyz'), frames.join(''));
    for (const w of ['w0', 'w1']) fs.writeFileSync(path.join(dir, w, 'plumed.restart.dat'), `RESTART\n${file(k, `${w}/plumed.dat`)}`);
    for (const h of ['HILLS.0', 'HILLS.1']) fs.writeFileSync(path.join(dir, 'hills', h), '');
    const drive = (w, step) => spawnSync('plumed', ['driver', '--ixyz', '../traj.xyz', '--timestep', '0.002', '--plumed', 'plumed.restart.dat',
      '--box', '10,10,10', ...(step ? ['--initial-step', String(step)] : [])], { cwd: path.join(dir, w), encoding: 'utf8', timeout: 60000 });
    expect(drive('w0').status).toBe(0);
    fs.appendFileSync(path.join(dir, 'hills', 'HILLS.0'), ' 2.2 0.9');
    const cut = spawnSync('bash', ['-c', `${functions(k)}\nBACKUP_ROOT=backup; TASK=1; cut_partial_row ../hills/HILLS.$((TASK - 1))`],
      { cwd: path.join(dir, 'w0'), encoding: 'utf8' });
    expect(cut.status).toBe(0);
    expect(drive('w0', 1000).status).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'hills', 'HILLS.0'), 'utf8')).not.toMatch(/2\.2 0\.9/);
    const other = drive('w1');
    expect(`${other.stdout}${other.stderr}`).not.toMatch(/mismatch between number of fields/);
    expect(other.status).toBe(0);
  }, 120000);
});
