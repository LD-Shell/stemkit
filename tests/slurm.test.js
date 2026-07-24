import { describe, test, expect } from '@jest/globals';
import {
  DEFAULT_WALLTIME, DEFAULT_ARRAY_RANGE,
  isValidWallTime, isValidArrayRange, parseMemory, arrayConcurrency,
  buildSlurmHeader, validateResources,
  buildModuleBlock, buildGromacsBlock, buildLammpsBlock,
  generateScript, walltimeToHours, estimateCoreHours
} from '../src/core/slurm.js';

describe('isValidWallTime', () => {
  test('accepts the D-HH:MM:SS form', () => {
    expect(isValidWallTime('2-12:00:00')).toBe(true);
  });

  test('accepts HH:MM:SS', () => {
    expect(isValidWallTime('24:00:00')).toBe(true);
    expect(isValidWallTime('1:30:00')).toBe(true);
  });

  test('accepts MM:SS and plain minutes', () => {
    expect(isValidWallTime('30:00')).toBe(true);
    expect(isValidWallTime('120')).toBe(true);
  });

  test('rejects malformed strings', () => {
    expect(isValidWallTime('24 hours')).toBe(false);
    expect(isValidWallTime('1:2:3:4')).toBe(false);
    expect(isValidWallTime('')).toBe(false);
    expect(isValidWallTime(null)).toBe(false);
  });
});

describe('isValidArrayRange', () => {
  test('accepts simple and stepped ranges', () => {
    expect(isValidArrayRange('1-10')).toBe(true);
    expect(isValidArrayRange('1-100:2')).toBe(true);
  });

  test('accepts concurrency caps and comma lists', () => {
    expect(isValidArrayRange('1-100%4')).toBe(true);
    expect(isValidArrayRange('1,3,5')).toBe(true);
    expect(isValidArrayRange('1-5,10-15')).toBe(true);
  });

  test('rejects malformed ranges', () => {
    expect(isValidArrayRange('1..10')).toBe(false);
    expect(isValidArrayRange('a-b')).toBe(false);
    expect(isValidArrayRange('')).toBe(false);
  });
});

describe('parseMemory', () => {
  test('parses gigabyte, megabyte and terabyte forms', () => {
    expect(parseMemory('32G')).toEqual({ value: 32, unit: 'G' });
    expect(parseMemory('4000M')).toEqual({ value: 4000, unit: 'M' });
    expect(parseMemory('1.5T')).toEqual({ value: 1.5, unit: 'T' });
  });

  test('tolerates the trailing B and internal spaces', () => {
    expect(parseMemory('32GB').unit).toBe('G');
    expect(parseMemory('32 G').value).toBe(32);
  });

  test('returns null for unparseable input', () => {
    expect(parseMemory('lots')).toBeNull();
    expect(parseMemory('')).toBeNull();
  });
});

describe('arrayConcurrency', () => {
  test('counts a simple range', () => {
    expect(arrayConcurrency('1-10')).toEqual({ total: 10, concurrent: 10 });
  });

  test('applies a percent concurrency cap', () => {
    expect(arrayConcurrency('1-100%4')).toEqual({ total: 100, concurrent: 4 });
  });

  test('accounts for a step', () => {
    // 1,3,5,7,9 is five tasks.
    expect(arrayConcurrency('1-10:2').total).toBe(5);
  });

  test('counts a comma-separated list', () => {
    expect(arrayConcurrency('1,4,9').total).toBe(3);
  });

  test('returns null for unparseable input', () => {
    expect(arrayConcurrency('nonsense')).toBeNull();
  });
});

describe('buildSlurmHeader', () => {
  test('emits a shebang and job name', () => {
    const { script } = buildSlurmHeader({ jobName: 'test_run' });
    expect(script.startsWith('#!/bin/bash -e')).toBe(true);
    expect(script).toContain('#SBATCH --job-name=test_run');
  });

  test('uses the threaded resource model for GROMACS', () => {
    const { script } = buildSlurmHeader({ engine: 'gromacs', cpusPerTask: 16 });
    expect(script).toContain('#SBATCH --ntasks-per-node=1');
    expect(script).toContain('#SBATCH --cpus-per-task=16');
  });

  test('uses the MPI resource model for LAMMPS', () => {
    const { script } = buildSlurmHeader({ engine: 'lammps', tasksPerNode: 8 });
    expect(script).toContain('#SBATCH --ntasks-per-node=8');
  });

  test('requests GPUs only when asked', () => {
    expect(buildSlurmHeader({ gpus: 2 }).script).toContain('#SBATCH --gres=gpu:2');
    expect(buildSlurmHeader({ gpus: 0 }).script).not.toContain('--gres');
  });

  test('includes a partition only when supplied', () => {
    expect(buildSlurmHeader({ partition: 'gpu' }).script).toContain('--partition=gpu');
    expect(buildSlurmHeader({}).script).not.toContain('--partition');
  });

  test('warns when no memory is requested', () => {
    const { warnings } = buildSlurmHeader({});
    expect(warnings.some(w => w.field === 'memory')).toBe(true);
  });

  test('accepts a valid wall time unchanged', () => {
    const { script, warnings } = buildSlurmHeader({ walltime: '12:00:00', memory: '8G' });
    expect(script).toContain('#SBATCH --time=12:00:00');
    expect(warnings.some(w => w.field === 'walltime')).toBe(false);
  });

  test('substitutes a default for a malformed wall time and says so', () => {
    const { script, warnings } = buildSlurmHeader({ walltime: 'two days' });
    expect(script).toContain(`#SBATCH --time=${DEFAULT_WALLTIME}`);
    expect(warnings.some(w => w.field === 'walltime')).toBe(true);
  });

  test('uses array-aware log patterns for array jobs', () => {
    const { script } = buildSlurmHeader({ array: true, arrayRange: '1-10' });
    expect(script).toContain('#SBATCH --array=1-10');
    expect(script).toContain('%A_%a.out');
  });

  test('uses job-id log patterns for non-array jobs', () => {
    const { script } = buildSlurmHeader({ array: false });
    expect(script).toContain('%x_%j.out');
    expect(script).not.toContain('%A_%a');
  });

  test('substitutes a default for a malformed array range', () => {
    const { script, warnings } = buildSlurmHeader({ array: true, arrayRange: 'bad' });
    expect(script).toContain(`--array=${DEFAULT_ARRAY_RANGE}`);
    expect(warnings.some(w => w.field === 'arrayRange')).toBe(true);
  });

  test('adds mail directives only when an address is given', () => {
    expect(buildSlurmHeader({ mailUser: 'a@b.c' }).script).toContain('--mail-user=a@b.c');
    expect(buildSlurmHeader({}).script).not.toContain('--mail-user');
  });

  test('warns that array memory is per task and totals it', () => {
    const { warnings } = buildSlurmHeader({
      array: true, arrayRange: '1-100', memory: '32G'
    });
    const w = warnings.find(x => x.field === 'arrayMemory');
    expect(w).toBeDefined();
    // 100 concurrent tasks at 32G each is 3200G in flight.
    expect(w.totalMemory).toBe(3200);
    expect(w.unit).toBe('G');
  });

  test('respects a concurrency cap when totalling array memory', () => {
    const { warnings } = buildSlurmHeader({
      array: true, arrayRange: '1-100%4', memory: '32G'
    });
    const w = warnings.find(x => x.field === 'arrayMemory');
    expect(w.concurrent).toBe(4);
    expect(w.totalMemory).toBe(128);
  });

  test('does not warn about array memory for a non-array job', () => {
    const { warnings } = buildSlurmHeader({ memory: '32G', array: false });
    expect(warnings.some(w => w.field === 'arrayMemory')).toBe(false);
  });
});

describe('validateResources', () => {
  test('rejects a non-positive node count', () => {
    const w = validateResources({ nodes: 0 });
    expect(w.some(x => x.level === 'error' && x.field === 'nodes')).toBe(true);
  });

  test('warns when LAMMPS ranks do not match GPU count', () => {
    const w = validateResources({ engine: 'lammps', gpus: 4, tasksPerNode: 1 });
    expect(w.some(x => x.field === 'tasksPerNode')).toBe(true);
  });

  test('accepts matched LAMMPS ranks and GPUs', () => {
    const w = validateResources({ engine: 'lammps', gpus: 4, tasksPerNode: 4 });
    expect(w.some(x => x.field === 'tasksPerNode')).toBe(false);
  });

  test('warns about single-threaded GROMACS on CPU', () => {
    const w = validateResources({ engine: 'gromacs', cpusPerTask: 1, gpus: 0 });
    expect(w.some(x => x.field === 'cpusPerTask')).toBe(true);
  });

  test('notes that multi-node GPU GROMACS scales poorly', () => {
    const w = validateResources({ engine: 'gromacs', nodes: 4, gpus: 2, cpusPerTask: 16 });
    expect(w.some(x => x.level === 'info' && x.field === 'nodes')).toBe(true);
  });

  test('is silent for a sensible request', () => {
    const w = validateResources({ engine: 'gromacs', nodes: 1, cpusPerTask: 32, gpus: 0 });
    expect(w).toHaveLength(0);
  });
});

describe('buildModuleBlock', () => {
  test('purges then loads each module', () => {
    const b = buildModuleBlock(['gcc/11', 'gromacs/2023']);
    expect(b).toContain('module purge');
    expect(b).toContain('module load gcc/11');
    expect(b).toContain('module load gromacs/2023');
  });

  test('can skip the purge', () => {
    expect(buildModuleBlock(['gcc'], { purge: false })).not.toContain('module purge');
  });

  test('ignores blank entries', () => {
    expect(buildModuleBlock(['gcc', '', '  '])).toContain('module load gcc');
    expect(buildModuleBlock(['gcc', ''])).not.toContain('module load \n');
  });

  test('returns an empty string for no modules', () => {
    expect(buildModuleBlock([])).toBe('');
    expect(buildModuleBlock(null)).toBe('');
  });
});

describe('buildGromacsBlock', () => {
  test('invokes gmx mdrun with the run name', () => {
    const b = buildGromacsBlock({ tpr: 'md.tpr', deffnm: 'run1' });
    expect(b).toContain('gmx mdrun -s md.tpr -deffnm run1');
  });

  test('binds thread count to the SLURM allocation', () => {
    const b = buildGromacsBlock({});
    expect(b).toContain('export OMP_NUM_THREADS=${SLURM_CPUS_PER_TASK:-1}');
    expect(b).toContain('-ntomp ${OMP_NUM_THREADS}');
  });

  test('adds GPU offload flags when GPUs are requested', () => {
    expect(buildGromacsBlock({ gpus: 1 })).toContain('-nb gpu');
    expect(buildGromacsBlock({ gpus: 0 })).not.toContain('-nb gpu');
  });

  test('emits checkpoint resume logic by default', () => {
    const b = buildGromacsBlock({ deffnm: 'md' });
    expect(b).toContain('if [ -f md.cpt ]');
    expect(b).toContain('-cpi md.cpt -append');
  });

  test('can omit checkpoint logic', () => {
    expect(buildGromacsBlock({ appendCheckpoint: false })).not.toContain('if [ -f');
  });

  test('adds a PLUMED input when supplied', () => {
    expect(buildGromacsBlock({ plumed: 'plumed.dat' })).toContain('-plumed plumed.dat');
  });

  test('adds a wall-clock limit when supplied', () => {
    expect(buildGromacsBlock({ maxh: 23.5 })).toContain('-maxh 23.5');
  });
});

describe('buildLammpsBlock', () => {
  test('invokes lmp through srun with the input file', () => {
    const b = buildLammpsBlock({ input: 'in.melt' });
    expect(b).toContain('srun lmp');
    expect(b).toContain('-in in.melt');
  });

  test('adds GPU package flags when GPUs are requested', () => {
    const b = buildLammpsBlock({ gpus: 2 });
    expect(b).toContain('-sf gpu');
    expect(b).toContain('-pk gpu 2');
  });

  test('honours an explicit accelerator suffix', () => {
    expect(buildLammpsBlock({ suffix: 'omp' })).toContain('-sf omp');
  });
});

describe('generateScript', () => {
  test('assembles header, modules and engine block in order', () => {
    const { script } = generateScript({
      engine: 'gromacs', jobName: 'prod', memory: '32G',
      walltime: '24:00:00', cpusPerTask: 16,
      modules: ['gromacs/2023']
    });
    const headerAt = script.indexOf('#SBATCH');
    const moduleAt = script.indexOf('module load');
    const runAt = script.indexOf('gmx mdrun');
    expect(headerAt).toBeLessThan(moduleAt);
    expect(moduleAt).toBeLessThan(runAt);
  });

  test('selects the LAMMPS block for the LAMMPS engine', () => {
    const { script } = generateScript({ engine: 'lammps', memory: '8G', walltime: '1:00:00' });
    expect(script).toContain('srun lmp');
    expect(script).not.toContain('gmx mdrun');
  });

  test('aggregates header and resource warnings', () => {
    const { warnings } = generateScript({ engine: 'gromacs', cpusPerTask: 1, nodes: 0 });
    expect(warnings.some(w => w.field === 'memory')).toBe(true);
    expect(warnings.some(w => w.field === 'nodes')).toBe(true);
  });

  test('collapses runs of blank lines', () => {
    const { script } = generateScript({ memory: '8G', walltime: '1:00:00' });
    expect(script).not.toMatch(/\n{3,}/);
  });
});

describe('walltimeToHours', () => {
  test('converts HH:MM:SS', () => {
    expect(walltimeToHours('24:00:00')).toBeCloseTo(24, 10);
    expect(walltimeToHours('1:30:00')).toBeCloseTo(1.5, 10);
  });

  test('converts the day-prefixed form', () => {
    expect(walltimeToHours('2-00:00:00')).toBeCloseTo(48, 10);
    expect(walltimeToHours('1-12:00:00')).toBeCloseTo(36, 10);
  });

  test('converts MM:SS and plain minutes', () => {
    expect(walltimeToHours('30:00')).toBeCloseTo(0.5, 10);
    expect(walltimeToHours('90')).toBeCloseTo(1.5, 10);
  });

  test('returns null for malformed input', () => {
    expect(walltimeToHours('forever')).toBeNull();
  });
});

describe('estimateCoreHours', () => {
  test('multiplies cores by hours for a threaded job', () => {
    const e = estimateCoreHours({
      engine: 'gromacs', nodes: 2, cpusPerTask: 16, walltime: '10:00:00'
    });
    expect(e.cores).toBe(32);
    expect(e.hours).toBeCloseTo(10, 10);
    expect(e.coreHours).toBeCloseTo(320, 10);
  });

  test('counts ranks times threads for an MPI job', () => {
    const e = estimateCoreHours({
      engine: 'lammps', nodes: 1, tasksPerNode: 8, cpusPerTask: 4, walltime: '2:00:00'
    });
    expect(e.cores).toBe(32);
    expect(e.coreHours).toBeCloseTo(64, 10);
  });

  test('returns null when the wall time is unusable', () => {
    expect(estimateCoreHours({ walltime: 'bad' })).toBeNull();
  });
});
