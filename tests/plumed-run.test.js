import { describe, test, expect } from '@jest/globals';
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

/* The shell functions, cut out of a generated script and run on files made
   to look like what a killed job leaves behind. */
describe('the shell functions', () => {
  const functions = (k) => {
    const j = file(k, 'job.sh');
    const settings = j.slice(j.indexOf('# --- Settings ---'), j.indexOf('# --- Functions ---'));
    const fns = j.slice(j.indexOf('# --- Functions ---'), j.indexOf('# --- Start or continue ---'));
    return `${settings.replace(/^RUN_DIR=.*$/m, '')}\n${fns}`;
  };
  const run = (k, body, files) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-run-'));
    for (const [name, text] of Object.entries(files || {})) fs.writeFileSync(path.join(dir, name), text);
    const r = spawnSync('bash', ['-c', `set -e -o pipefail\n${functions(k)}\nBACKUP=backup/step1; BACKUP_ROOT=backup\n${body}`],
      { cwd: dir, encoding: 'utf8' });
    const read = (n) => (fs.existsSync(path.join(dir, n)) ? fs.readFileSync(path.join(dir, n), 'utf8') : null);
    const out = { status: r.status, stdout: r.stdout, stderr: r.stderr, read, dir };
    return out;
  };
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
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-parse-'));
          fs.writeFileSync(path.join(dir, 'plumed.dat'), f.text);
          const r = spawnSync('plumed', ['driver', '--natoms', '4', '--parse-only', '--plumed', 'plumed.dat'],
            { cwd: dir, encoding: 'utf8', timeout: 60000 });
          if (r.status !== 0) throw new Error(`${method}/${engine}/${k.layout} ${f.path}:\n${(r.stdout + r.stderr).split('\n').filter(l => /ERROR|error/.test(l)).slice(0, 5).join('\n')}`);
        }
      }
    }
  });
});
