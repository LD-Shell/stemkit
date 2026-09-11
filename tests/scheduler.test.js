import { describe, test, expect } from '@jest/globals';
import {
  SCHEDULERS, DEFAULT_PE,
  getScheduler, submitCommand, envVars, launcher,
  walltimeToSeconds, formatHMS, lsfWallTime, convertMemory, parseArrayRange,
  buildHeader
} from '../src/core/scheduler.js';
import { buildSlurmHeader, DEFAULT_WALLTIME, DEFAULT_ARRAY_RANGE } from '../src/core/slurm.js';

// A GROMACS-shaped request: one rank per node, many threads.
const threaded = {
  engine: 'gromacs', jobName: 'md_prod', nodes: 1, gpus: 1, cpusPerTask: 8,
  walltime: '24:00:00', memory: '32G'
};

// A LAMMPS-shaped request: many ranks per node, one thread each.
const mpi = {
  engine: 'lammps', jobName: 'melt', nodes: 2, gpus: 0, tasksPerNode: 16, cpusPerTask: 1,
  walltime: '1-12:00:00', memory: '64G'
};

const directives = (script, prefix) => script.split('\n').filter(l => l.startsWith(prefix));

describe('SCHEDULERS', () => {
  test('lists the four schedulers with SLURM first', () => {
    expect(SCHEDULERS.map(s => s.id)).toEqual(['slurm', 'pbs', 'lsf', 'sge']);
  });

  test('carries a submit command and directive prefix for each', () => {
    for (const s of SCHEDULERS) {
      expect(s.submit).toMatch(/^(sbatch|qsub|bsub)$/);
      expect(s.prefix.startsWith('#')).toBe(true);
    }
  });

  test('rejects an unknown id rather than falling back', () => {
    expect(() => getScheduler('torque')).toThrow(/Unknown scheduler/);
    expect(() => buildHeader({ scheduler: 'torque' })).toThrow(/Unknown scheduler/);
  });
});

describe('submitCommand', () => {
  test('LSF reads the script from standard input', () => {
    expect(submitCommand('lsf')).toBe('bsub < submit.sh');
  });

  test('the others take the file as an argument', () => {
    expect(submitCommand('slurm')).toBe('sbatch submit.sh');
    expect(submitCommand('pbs')).toBe('qsub submit.sh');
    expect(submitCommand('sge', 'run.sh')).toBe('qsub run.sh');
  });
});

describe('envVars', () => {
  test('names the job id, array index and submit directory for each scheduler', () => {
    expect(envVars('slurm')).toMatchObject({ jobId: 'SLURM_JOB_ID', arrayIndex: 'SLURM_ARRAY_TASK_ID', submitDir: 'SLURM_SUBMIT_DIR' });
    expect(envVars('pbs')).toMatchObject({ jobId: 'PBS_JOBID', arrayIndex: 'PBS_ARRAY_INDEX', submitDir: 'PBS_O_WORKDIR' });
    expect(envVars('lsf')).toMatchObject({ jobId: 'LSB_JOBID', arrayIndex: 'LSB_JOBINDEX', submitDir: 'LS_SUBCWD' });
    expect(envVars('sge')).toMatchObject({ jobId: 'JOB_ID', arrayIndex: 'SGE_TASK_ID', submitDir: 'SGE_O_WORKDIR' });
  });

  test('SLURM and PBS report CPUs per task; PBS exposes the node file instead of a task count', () => {
    expect(envVars('slurm').cpusPerTask).toBe('SLURM_CPUS_PER_TASK');
    expect(envVars('pbs').cpusPerTask).toBe('NCPUS');
    expect(envVars('pbs').ntasks).toBeNull();
    expect(envVars('pbs').nodeFile).toBe('PBS_NODEFILE');
    expect(envVars('lsf').cpusPerTask).toBeNull();
    expect(envVars('lsf').ntasks).toBe('LSB_DJOB_NUMPROC');
    expect(envVars('sge').cpusPerTask).toBeNull();
    expect(envVars('sge').ntasks).toBe('NSLOTS');
  });
});

describe('launcher', () => {
  test('srun takes the task count from the allocation', () => {
    expect(launcher('slurm')).toBe('srun');
  });

  test('PBS counts the lines of the node file, one per MPI rank', () => {
    expect(launcher('pbs', { cpusPerTask: 4 })).toBe('mpirun -np $(wc -l < "$PBS_NODEFILE")');
  });

  test('LSF and Grid Engine divide slots by threads for hybrid runs', () => {
    expect(launcher('lsf')).toBe('mpirun -np $LSB_DJOB_NUMPROC');
    expect(launcher('lsf', { cpusPerTask: 2 })).toBe('mpirun -np $((LSB_DJOB_NUMPROC / 2))');
    expect(launcher('sge')).toBe('mpirun -np $NSLOTS');
    expect(launcher('sge', { cpusPerTask: 4 })).toBe('mpirun -np $((NSLOTS / 4))');
  });
});

describe('wall-time conversion', () => {
  test('walltimeToSeconds handles every SLURM form', () => {
    expect(walltimeToSeconds('1-12:00:00')).toBe(129600);
    expect(walltimeToSeconds('01:30:15')).toBe(5415);
    expect(walltimeToSeconds('30:00')).toBe(1800);
    expect(walltimeToSeconds('90')).toBe(5400);
    expect(walltimeToSeconds('soon')).toBeNull();
  });

  test('formatHMS does not wrap hours at 24', () => {
    expect(formatHMS(129600)).toBe('36:00:00');
    expect(formatHMS(5415)).toBe('01:30:15');
    expect(formatHMS(0)).toBe('00:00:00');
  });

  test('lsfWallTime rounds seconds up to the next minute and says so', () => {
    expect(lsfWallTime('24:00:00')).toEqual({ value: '24:00', rounded: false });
    expect(lsfWallTime('00:30:30')).toEqual({ value: '0:31', rounded: true });
    expect(lsfWallTime('2-00:00:00')).toEqual({ value: '48:00', rounded: false });
    expect(lsfWallTime('bad')).toBeNull();
  });
});

describe('convertMemory', () => {
  test('PBS sizes are integers with a lower-case suffix', () => {
    expect(convertMemory('32G', 'pbs')).toBe('32gb');
    expect(convertMemory('4000M', 'pbs')).toBe('4000mb');
    expect(convertMemory('1.5T', 'pbs')).toBe('1536gb');
    expect(convertMemory('0.5G', 'pbs')).toBe('512mb');
  });

  test('LSF values are rendered in MB', () => {
    expect(convertMemory('32G', 'lsf')).toBe('32768');
    expect(convertMemory('4000M', 'lsf')).toBe('4000');
    expect(convertMemory('1.5T', 'lsf')).toBe('1572864');
  });

  test('Grid Engine keeps K/M/G and expresses terabytes in gigabytes', () => {
    expect(convertMemory('32G', 'sge')).toBe('32G');
    expect(convertMemory('1.5T', 'sge')).toBe('1536G');
    expect(convertMemory('2.5G', 'sge')).toBe('2560M');
  });

  test('returns null for an unparseable string', () => {
    expect(convertMemory('lots', 'pbs')).toBeNull();
  });
});

describe('parseArrayRange', () => {
  test('splits ranges, steps, lists and the concurrency cap', () => {
    expect(parseArrayRange('1-10')).toEqual({ segments: [{ start: 1, end: 10, step: 1 }], cap: null });
    expect(parseArrayRange('1-100:2%4')).toEqual({ segments: [{ start: 1, end: 100, step: 2 }], cap: 4 });
    expect(parseArrayRange('1,3,5').segments).toHaveLength(3);
    expect(parseArrayRange('1-5,10-15').segments[1]).toEqual({ start: 10, end: 15, step: 1 });
  });

  test('returns null for malformed input', () => {
    expect(parseArrayRange('a-b')).toBeNull();
  });
});

describe('buildHeader: SLURM', () => {
  test('is byte for byte what core/slurm produces', () => {
    const config = { ...threaded, array: true, arrayRange: '1-10%2', partition: 'gpu', mailUser: 'a@b.c' };
    expect(buildHeader({ scheduler: 'slurm', ...config })).toEqual(buildSlurmHeader(config));
    expect(buildHeader(mpi)).toEqual(buildSlurmHeader(mpi));
  });

  test('is the default when no scheduler is named', () => {
    expect(buildHeader(threaded).script).toContain('#SBATCH --cpus-per-task=8');
  });
});

describe('buildHeader: PBS', () => {
  test('threaded request: one rank per node with ompthreads', () => {
    const { script } = buildHeader({ scheduler: 'pbs', ...threaded });
    expect(script.startsWith('#!/bin/bash -e\n#PBS -N md_prod\n')).toBe(true);
    expect(script).toContain('#PBS -l select=1:ncpus=8:mpiprocs=1:ompthreads=8:ngpus=1:mem=32gb');
    expect(script).toContain('#PBS -l walltime=24:00:00');
    expect(script).toContain('#PBS -o logs/\n#PBS -e logs/');
    expect(script).not.toContain('place=');
  });

  test('MPI request: ranks per node, a day-prefixed wall time and scatter placement', () => {
    const { script } = buildHeader({ scheduler: 'pbs', ...mpi });
    expect(script).toContain('#PBS -l select=2:ncpus=16:mpiprocs=16:ompthreads=1:mem=64gb');
    expect(script).toContain('#PBS -l place=scatter');
    expect(script).toContain('#PBS -l walltime=36:00:00');
    expect(script).not.toContain('ngpus');
  });

  test('hybrid MPI request multiplies ranks by threads for ncpus', () => {
    const { script } = buildHeader({ scheduler: 'pbs', ...mpi, cpusPerTask: 2 });
    expect(script).toContain('select=2:ncpus=32:mpiprocs=16:ompthreads=2');
  });

  test('arrays use -J with the concurrency cap and PBS_ARRAY_INDEX is the index', () => {
    const { script, warnings } = buildHeader({ scheduler: 'pbs', ...threaded, array: true, arrayRange: '1-100:2%4' });
    expect(script).toContain('#PBS -J 1-100:2%4');
    expect(warnings.some(w => w.field === 'arrayMemory' && w.concurrent === 4)).toBe(true);
    expect(envVars('pbs').arrayIndex).toBe('PBS_ARRAY_INDEX');
  });

  test('a comma list keeps its first range and warns', () => {
    const { script, warnings } = buildHeader({ scheduler: 'pbs', ...threaded, array: true, arrayRange: '1-5,10-15' });
    expect(script).toContain('#PBS -J 1-5\n');
    expect(warnings.some(w => w.field === 'arrayRange' && /single X-Y/.test(w.message))).toBe(true);
  });

  test('mail is requested on abort and end', () => {
    const { script } = buildHeader({ scheduler: 'pbs', ...threaded, mailUser: 'a@b.c' });
    expect(script).toContain('#PBS -m ae\n#PBS -M a@b.c');
    expect(buildHeader({ scheduler: 'pbs', ...threaded }).script).not.toContain('#PBS -m');
  });

  test('queue, GPU note and fail-fast', () => {
    const { script } = buildHeader({ scheduler: 'pbs', ...threaded, partition: 'gpuq' });
    expect(script).toContain('#PBS -q gpuq');
    expect(script).toContain('Site-specific: ngpus');
    expect(script.trimEnd().endsWith('set -e')).toBe(true);
  });

  test('substitutes defaults for a malformed wall time and array range, and warns', () => {
    const { script, warnings } = buildHeader({ scheduler: 'pbs', ...threaded, walltime: 'two days', array: true, arrayRange: 'bad' });
    expect(script).toContain(`#PBS -l walltime=${DEFAULT_WALLTIME}`);
    expect(script).toContain(`#PBS -J ${DEFAULT_ARRAY_RANGE}`);
    expect(warnings.map(w => w.field)).toEqual(expect.arrayContaining(['walltime', 'arrayRange']));
  });

  test('warns when no memory is requested', () => {
    const { script, warnings } = buildHeader({ scheduler: 'pbs', ...threaded, memory: '' });
    expect(script).not.toContain(':mem=');
    expect(warnings.some(w => w.field === 'memory')).toBe(true);
  });

  test('a zero node, rank or thread count becomes one instead of an invalid chunk', () => {
    const { script } = buildHeader({ scheduler: 'pbs', ...threaded, nodes: 0, cpusPerTask: 0, gpus: -1 });
    expect(script).toContain('#PBS -l select=1:ncpus=1:mpiprocs=1:ompthreads=1:mem=32gb');
    expect(script).not.toContain('ngpus');
    expect(buildHeader({ scheduler: 'lsf', ...mpi, tasksPerNode: 0 }).script).toContain('#BSUB -n 2\n#BSUB -R "span[ptile=1]"');
  });
});

describe('buildHeader: LSF', () => {
  test('threaded request: slots equal threads, kept on one host', () => {
    const { script } = buildHeader({ scheduler: 'lsf', ...threaded });
    expect(script).toContain('#BSUB -J md_prod\n');
    expect(script).toContain('#BSUB -n 8\n#BSUB -R "span[ptile=8]"');
    expect(script).toContain('#BSUB -R "rusage[mem=32768]"');
    expect(script).toContain('#BSUB -gpu "num=1"');
    expect(script).toContain('#BSUB -W 24:00');
    expect(script).toContain('#BSUB -o logs/md_prod_%J.out\n#BSUB -e logs/md_prod_%J.err');
  });

  test('MPI request: ranks times nodes as slots, ranks per host as ptile', () => {
    const { script } = buildHeader({ scheduler: 'lsf', ...mpi });
    expect(script).toContain('#BSUB -n 32\n#BSUB -R "span[ptile=16]"');
    expect(script).toContain('#BSUB -W 36:00');
    expect(script).not.toContain('-gpu');
  });

  test('arrays go into the job name with %I in the log names', () => {
    const { script } = buildHeader({ scheduler: 'lsf', ...threaded, array: true, arrayRange: '1-10%2' });
    expect(script).toContain('#BSUB -J "md_prod[1-10]%2"');
    expect(script).toContain('logs/md_prod_%J_%I.out');
  });

  test('a comma list is passed through as an index list', () => {
    const { script } = buildHeader({ scheduler: 'lsf', ...threaded, array: true, arrayRange: '1-5,10-15:5' });
    expect(script).toContain('#BSUB -J "md_prod[1-5,10-15:5]"');
  });

  test('warns that indices start at 1', () => {
    const { warnings } = buildHeader({ scheduler: 'lsf', ...threaded, array: true, arrayRange: '0-9' });
    expect(warnings.some(w => w.field === 'arrayRange' && /start at 1/.test(w.message))).toBe(true);
  });

  test('wall time loses its seconds field, rounded up with a note', () => {
    const { script, warnings } = buildHeader({ scheduler: 'lsf', ...threaded, walltime: '00:30:30' });
    expect(script).toContain('#BSUB -W 0:31');
    expect(warnings.some(w => w.field === 'walltime' && /rounded up/.test(w.message))).toBe(true);
    expect(buildHeader({ scheduler: 'lsf', ...threaded }).warnings.some(w => w.field === 'walltime')).toBe(false);
  });

  test('mail and queue', () => {
    const { script } = buildHeader({ scheduler: 'lsf', ...threaded, mailUser: 'a@b.c', partition: 'normal' });
    expect(script).toContain('#BSUB -q normal');
    expect(script).toContain('#BSUB -N\n#BSUB -u a@b.c');
  });

  test('says how to submit', () => {
    expect(buildHeader({ scheduler: 'lsf', ...threaded }).script).toContain('bsub < submit.sh');
  });

  test('names the lsf.conf prerequisite for -gpu and the legacy form', () => {
    const { script } = buildHeader({ scheduler: 'lsf', ...threaded, gpus: 2 });
    expect(script).toContain('LSB_GPU_NEW_SYNTAX');
    expect(script).toContain('rusage[ngpus_excl_p=2]');
    expect(buildHeader({ scheduler: 'lsf', ...mpi }).script).not.toContain('LSB_GPU_NEW_SYNTAX');
  });
});

describe('buildHeader: Grid Engine', () => {
  test('threaded request: a PE with the thread count as slots', () => {
    const { script } = buildHeader({ scheduler: 'sge', ...threaded });
    expect(script).toContain('#$ -N md_prod\n#$ -S /bin/bash\n#$ -cwd\n');
    expect(script).toContain(`#$ -pe ${DEFAULT_PE} 8`);
    expect(script).toContain('#$ -l h_rt=24:00:00');
    expect(script).toContain('#$ -l h_vmem=32G');
    expect(script).toContain('#$ -o logs/\n#$ -j y');
  });

  test('MPI request across nodes multiplies out the slots', () => {
    const { script } = buildHeader({ scheduler: 'sge', ...mpi, pe: 'openmpi' });
    expect(script).toContain('#$ -pe openmpi 32');
    expect(script).toContain('#$ -l h_rt=36:00:00');
    expect(script).toContain('allocation_rule');
  });

  test('arrays use -t and -tc', () => {
    const { script } = buildHeader({ scheduler: 'sge', ...threaded, array: true, arrayRange: '1-100:2%4' });
    expect(script).toContain('#$ -t 1-100:2\n#$ -tc 4');
  });

  test('warns that arrays are 1-based', () => {
    const { warnings } = buildHeader({ scheduler: 'sge', ...threaded, array: true, arrayRange: '0-9' });
    expect(warnings.some(w => w.field === 'arrayRange' && /1-based/.test(w.message))).toBe(true);
    expect(buildHeader({ scheduler: 'sge', ...threaded, array: true, arrayRange: '1-9' })
      .warnings.some(w => /1-based/.test(w.message))).toBe(false);
  });

  test('GPUs become a commented placeholder, never an invented resource', () => {
    const { script, warnings } = buildHeader({ scheduler: 'sge', ...threaded, gpus: 2 });
    expect(script).toContain('# #$ -l gpu=2');
    expect(directives(script, '#$ ').some(l => /gpu/.test(l))).toBe(false);
    expect(warnings.some(w => w.field === 'gpus' && w.level === 'info')).toBe(true);
  });

  test('mail, queue and a blank PE falling back to the default', () => {
    const { script } = buildHeader({ scheduler: 'sge', ...threaded, mailUser: 'a@b.c', partition: 'all.q', pe: '  ' });
    expect(script).toContain('#$ -q all.q');
    expect(script).toContain('#$ -m ea\n#$ -M a@b.c');
    expect(script).toContain('#$ -pe mpi 8');
  });

  test('warns about a job name starting with a digit', () => {
    const { warnings } = buildHeader({ scheduler: 'sge', ...threaded, jobName: '1abc' });
    expect(warnings.some(w => w.field === 'jobName')).toBe(true);
  });

  test('the memory note states what h_vmem reserves per host', () => {
    expect(buildHeader({ scheduler: 'sge', ...threaded }).script).toContain('reserved per slot: 32G x 8 on');
    expect(buildHeader({ scheduler: 'sge', ...mpi, cpusPerTask: 2 }).script).toContain('64G x 32 on');
    expect(buildHeader({ scheduler: 'sge', ...threaded, memory: '' }).script).toContain('reserved per slot on');
  });
});

describe('buildHeader: shared behaviour', () => {
  test('every non-SLURM header ends with set -e and carries no SLURM directive', () => {
    for (const scheduler of ['pbs', 'lsf', 'sge']) {
      const { script } = buildHeader({ scheduler, ...mpi });
      expect(script.trimEnd().endsWith('set -e')).toBe(true);
      expect(script).not.toContain('#SBATCH');
    }
  });

  test('marks site-specific values inside the script', () => {
    for (const scheduler of ['pbs', 'lsf', 'sge']) {
      expect(buildHeader({ scheduler, ...threaded }).script).toContain('Site-specific');
    }
  });

  test('directive lines come before every comment and command', () => {
    for (const [scheduler, prefix] of [['pbs', '#PBS'], ['lsf', '#BSUB'], ['sge', '#$ ']]) {
      const lines = buildHeader({ scheduler, ...threaded, array: true, arrayRange: '1-4', mailUser: 'a@b.c' })
        .script.split('\n');
      const last = lines.map(l => l.startsWith(prefix)).lastIndexOf(true);
      expect(lines.slice(1, last).every(l => l.startsWith(prefix))).toBe(true);
    }
  });
});
