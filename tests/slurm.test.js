import { describe, test, expect } from '@jest/globals';
import {
  DEFAULT_WALLTIME, DEFAULT_ARRAY_RANGE,
  isValidWallTime, isValidArrayRange, parseMemory, arrayConcurrency,
  parseWallTime, parseArraySpec, arraySpecProblem, slurmMemory, MAX_ARRAY_INDEX,
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

  // sbatch(1), --time: "Acceptable time formats include "minutes",
  // "minutes:seconds", "hours:minutes:seconds", "days-hours",
  // "days-hours:minutes" and "days-hours:minutes:seconds"".
  test('accepts the day forms without seconds', () => {
    expect(isValidWallTime('1-12')).toBe(true);
    expect(isValidWallTime('1-12:30')).toBe(true);
  });

  // _is_valid_timespec in Slurm's src/common/parse_time.c counts runs of
  // digits and separators; it puts no limit on the digits of a field.
  test('accepts a field of any width', () => {
    expect(isValidWallTime('100:00:00')).toBe(true);
    expect(isValidWallTime('120:00')).toBe(true);
    expect(isValidWallTime('1:5:3')).toBe(true);
    expect(isValidWallTime('10-0:0:0')).toBe(true);
  });

  test('accepts what Slurm reads as no limit', () => {
    expect(isValidWallTime('0')).toBe(true);
    expect(isValidWallTime('-1')).toBe(true);
    expect(isValidWallTime('UNLIMITED')).toBe(true);
    expect(isValidWallTime('infinite')).toBe(true);
  });

  test('rejects what _is_valid_timespec rejects', () => {
    expect(isValidWallTime('1:')).toBe(false);          // a colon with one number
    expect(isValidWallTime(':30')).toBe(false);
    expect(isValidWallTime('1::30')).toBe(false);
    expect(isValidWallTime('1-2:')).toBe(false);
    expect(isValidWallTime('1-2-3')).toBe(false);       // two dashes
    expect(isValidWallTime('1:2-3')).toBe(false);       // a dash after a colon
    expect(isValidWallTime('1 00:00:00')).toBe(false);  // any other character
    expect(isValidWallTime('1.5')).toBe(false);
    expect(isValidWallTime('24h')).toBe(false);
  });

  test('rejects a negative day count, which Slurm would turn into a negative limit', () => {
    expect(isValidWallTime('-30')).toBe(false);
  });
});

describe('parseWallTime', () => {
  // time_str2secs in Slurm's src/common/parse_time.c: sscanf reads the
  // fields, then d*86400 + h*3600 + m*60 + s.
  test('adds the fields up for each documented form', () => {
    expect(parseWallTime('90')).toMatchObject({ seconds: 5400, form: 'minutes' });
    expect(parseWallTime('30:15')).toMatchObject({ seconds: 1815, form: 'minutes:seconds' });
    expect(parseWallTime('01:30:15')).toMatchObject({ seconds: 5415, form: 'hours:minutes:seconds' });
    expect(parseWallTime('1-12')).toMatchObject({ seconds: 129600, form: 'days-hours' });
    expect(parseWallTime('1-12:30')).toMatchObject({ seconds: 131400, form: 'days-hours:minutes' });
    expect(parseWallTime('1-02:03:04')).toMatchObject({ seconds: 93784, form: 'days-hours:minutes:seconds' });
  });

  test('two fields are minutes and seconds, never hours and minutes', () => {
    expect(parseWallTime('24:00').seconds).toBe(24 * 60);
  });

  test('more than 99 minutes is fine where minutes is the leading field', () => {
    expect(parseWallTime('120:00')).toMatchObject({ seconds: 7200, carried: [] });
    expect(parseWallTime('1440')).toMatchObject({ seconds: 86400, carried: [] });
  });

  test('a field above its usual range is accepted, added up and listed', () => {
    // 99 h + 99 min + 99 s = 362439 s: Slurm does no range check.
    expect(parseWallTime('99:99:99')).toMatchObject({ seconds: 362439, carried: ['99 minutes', '99 seconds'] });
    expect(parseWallTime('10:75')).toMatchObject({ seconds: 675, carried: ['75 seconds'] });
    expect(parseWallTime('1-36')).toMatchObject({ seconds: 216000, carried: ['36 hours'] });
    expect(parseWallTime('23:59:59').carried).toEqual([]);
  });

  test('a day count with nothing after the dash is whole days', () => {
    expect(parseWallTime('2-').seconds).toBe(172800);
  });

  // sbatch(1): "A time limit of zero requests that no time limit be imposed."
  test('zero, -1, INFINITE and UNLIMITED ask for no limit', () => {
    for (const t of ['0', '00:00:00', '0-0', '-1', 'INFINITE', 'Unlimited']) {
      expect(parseWallTime(t)).toMatchObject({ unlimited: true, seconds: Infinity });
    }
  });

  test('ignores surrounding whitespace and returns null for anything else', () => {
    expect(parseWallTime('  12:00:00 ').seconds).toBe(43200);
    expect(parseWallTime('two days')).toBeNull();
    expect(parseWallTime(undefined)).toBeNull();
  });

  test('a total too large for the int Slurm adds it up in is refused', () => {
    expect(parseWallTime('99999999999')).toBeNull();
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

  // slurm_parse_array_tok in Slurm's src/common/slurm_protocol_defs.c:
  // "if (last < first) return false", "if ((step <= 0) ...) return false",
  // and a ':' is only looked for after a range.
  test('rejects a range that runs backwards', () => {
    expect(isValidArrayRange('10-1')).toBe(false);
    expect(isValidArrayRange('1-5,9-7')).toBe(false);
  });

  test('rejects a step of zero', () => {
    expect(isValidArrayRange('1-10:0')).toBe(false);
  });

  test('rejects a step without a range before it', () => {
    expect(isValidArrayRange('5:2')).toBe(false);
  });

  test('takes one % limit, at the end only', () => {
    expect(isValidArrayRange('1-5,10-15%2')).toBe(true);
    expect(isValidArrayRange('1-5%2,10-15')).toBe(false);
    expect(isValidArrayRange('1-10%2%3')).toBe(false);
    expect(isValidArrayRange('1-10%')).toBe(false);
    expect(isValidArrayRange('%4')).toBe(false);
  });

  test('rejects empty items, signs and spaces', () => {
    expect(isValidArrayRange('1,,3')).toBe(false);
    expect(isValidArrayRange('1,2,')).toBe(false);
    expect(isValidArrayRange('-3')).toBe(false);
    expect(isValidArrayRange('1 - 10')).toBe(false);
  });

  // sbatch(1): "The minimum index value is 0."
  test('accepts index 0, a single index and a one-element range', () => {
    expect(isValidArrayRange('0-15')).toBe(true);
    expect(isValidArrayRange('7')).toBe(true);
    expect(isValidArrayRange('3-3')).toBe(true);
  });

  // slurm.conf(5), MaxArraySize: "The value may not exceed 4000001", and the
  // largest index is one less.
  test('rejects an index no Slurm configuration can allow', () => {
    expect(isValidArrayRange(`0-${MAX_ARRAY_INDEX}`)).toBe(true);
    expect(isValidArrayRange(`0-${MAX_ARRAY_INDEX + 1}`)).toBe(false);
    expect(isValidArrayRange('99999999999999999999')).toBe(false);
  });
});

describe('parseArraySpec', () => {
  test('returns the segments, the limit and the index bounds', () => {
    expect(parseArraySpec('0,6,16-32:4%3')).toMatchObject({
      segments: [{ start: 0, end: 0, step: 1 }, { start: 6, end: 6, step: 1 }, { start: 16, end: 32, step: 4 }],
      cap: 3, total: 7, concurrent: 3, min: 0, max: 32
    });
  });

  // sbatch(1): ""--array=0-15:4" is equivalent to "--array=0,4,8,12"".
  test('a step stops at the last index it reaches', () => {
    expect(parseArraySpec('0-15:4')).toMatchObject({ total: 4, max: 12 });
    expect(parseArraySpec('0,4,8,12')).toMatchObject({ total: 4, max: 12 });
  });

  test('says when the indices amount to one evenly spaced range', () => {
    expect(parseArraySpec('1,3,5').progression).toEqual({ start: 1, end: 5, step: 2 });
    expect(parseArraySpec('1-3,4-6').progression).toEqual({ start: 1, end: 6, step: 1 });
    expect(parseArraySpec('7').progression).toEqual({ start: 7, end: 7, step: 1 });
    expect(parseArraySpec('1-5,10-15').progression).toBeNull();
    expect(parseArraySpec('1,2,4').progression).toBeNull();
  });

  test('a limit of 0 is no limit, as sbatch reads it', () => {
    // job_mgr.c: "max_run_tasks = atoi(sep + 1); if (max_run_tasks > 0) ...".
    expect(parseArraySpec('1-10%0')).toMatchObject({ cap: null, concurrent: 10 });
  });

  test('explains what is wrong with a range', () => {
    expect(arraySpecProblem('1-10')).toBeNull();
    expect(arraySpecProblem('10-1')).toMatch(/runs backwards/);
    expect(arraySpecProblem('1-10:0')).toMatch(/step in 1-10:0 is 0/);
    expect(arraySpecProblem('5:2')).toMatch(/needs a range before it/);
    expect(arraySpecProblem('1-5%2,10-15')).toMatch(/% limit goes once, at the very end/);
    expect(arraySpecProblem('1,,3')).toMatch(/nothing between two commas/);
    expect(arraySpecProblem('a-b')).toMatch(/"a-b" is not an index/);
    expect(arraySpecProblem('')).toMatch(/empty/);
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

  // sbatch(1), --mem: "Default units are mebibytes. Different units can be
  // specified using the suffix [K|M|G|T]."
  test('a number on its own is megabytes, and marked as bare', () => {
    expect(parseMemory('4000')).toEqual({ value: 4000, unit: 'M', bare: true });
    expect(parseMemory('32G').bare).toBeUndefined();
  });

  test('parses kilobytes and lower case', () => {
    expect(parseMemory('512000K')).toEqual({ value: 512000, unit: 'K' });
    expect(parseMemory('32gb')).toEqual({ value: 32, unit: 'G' });
  });

  test('rejects a unit it does not know, a sign and a bare B', () => {
    expect(parseMemory('zz')).toBeNull();
    expect(parseMemory('32X')).toBeNull();
    expect(parseMemory('-4G')).toBeNull();
    expect(parseMemory('32B')).toBeNull();
    expect(parseMemory('G')).toBeNull();
  });
});

describe('slurmMemory', () => {
  // str_to_mbytes in Slurm's src/common/proc_args.c reads the number with
  // strtoll, so --mem takes whole numbers only.
  test('writes a whole number with a single-letter unit', () => {
    expect(slurmMemory('32G')).toBe('32G');
    expect(slurmMemory('32 GB')).toBe('32G');
    expect(slurmMemory('4000m')).toBe('4000M');
    expect(slurmMemory('512000K')).toBe('512000K');
  });

  test('a bare number is written with the M it means', () => {
    expect(slurmMemory('4000')).toBe('4000M');
  });

  test('a fraction moves to the next unit down', () => {
    expect(slurmMemory('1.5T')).toBe('1536G');
    expect(slurmMemory('0.5G')).toBe('512M');
  });

  test('a fraction of a megabyte is rounded up', () => {
    expect(slurmMemory('1.1G')).toBe('1127M');   // 1126.4 MB
  });

  test('zero stays zero and nonsense is null', () => {
    expect(slurmMemory('0')).toBe('0');
    expect(slurmMemory('zz')).toBeNull();
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

  test('counts every range of a comma list and applies the limit to the whole array', () => {
    expect(arrayConcurrency('1-5,10-15%2')).toEqual({ total: 11, concurrent: 2 });
  });

  test('counts a list that mixes single indices and ranges', () => {
    expect(arrayConcurrency('1,3-5')).toEqual({ total: 4, concurrent: 4 });
    expect(arrayConcurrency('0,6,16-32')).toEqual({ total: 19, concurrent: 19 });
  });

  // The controller sets a bit per index, so an index named twice is one task.
  test('counts an index named twice once', () => {
    expect(arrayConcurrency('1-5,3-8')).toEqual({ total: 8, concurrent: 8 });
    expect(arrayConcurrency('4,4,4')).toEqual({ total: 1, concurrent: 1 });
    expect(arrayConcurrency('0-10:2,0-10:5')).toEqual({ total: 7, concurrent: 7 });
  });

  test('a limit above the task count changes nothing', () => {
    expect(arrayConcurrency('1-3%10')).toEqual({ total: 3, concurrent: 3 });
  });

  test('returns null, not a negative or zero count, for what sbatch rejects', () => {
    expect(arrayConcurrency('10-1')).toBeNull();
    expect(arrayConcurrency('1-10:0')).toBeNull();
  });

  test('counts the largest array any configuration allows without delay', () => {
    expect(arrayConcurrency(`0-${MAX_ARRAY_INDEX}`).total).toBe(MAX_ARRAY_INDEX + 1);
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

  test('writes a wall time in a day form as given', () => {
    const { script, warnings } = buildSlurmHeader({ walltime: '2-12', memory: '8G' });
    expect(script).toContain('#SBATCH --time=2-12\n');
    expect(warnings.some(w => w.field === 'walltime')).toBe(false);
  });

  test('keeps a wall time with a field out of range, and warns with the total', () => {
    const { script, warnings } = buildSlurmHeader({ walltime: '99:99:99', memory: '8G' });
    expect(script).toContain('#SBATCH --time=99:99:99\n');
    const w = warnings.find(x => x.field === 'walltime');
    expect(w.level).toBe('warn');
    expect(w.message).toContain('99 minutes and 99 seconds');
    expect(w.message).toContain('100:40:39');
  });

  test('says that a wall time of zero asks for no limit', () => {
    const { script, warnings } = buildSlurmHeader({ walltime: '0', memory: '8G' });
    expect(script).toContain('#SBATCH --time=0\n');
    expect(warnings.find(x => x.field === 'walltime')).toMatchObject({ level: 'info' });
  });

  test('names the bad wall time and the forms sbatch takes', () => {
    const w = buildSlurmHeader({ walltime: 'two days' }).warnings.find(x => x.field === 'walltime');
    expect(w.message).toContain('"two days"');
    expect(w.message).toContain('days-hours:minutes:seconds');
  });

  test('leaves out a memory value it cannot read, and says so', () => {
    const { script, warnings } = buildSlurmHeader({ memory: 'zz', walltime: '1:00:00' });
    expect(script).not.toContain('--mem');
    const w = warnings.filter(x => x.field === 'memory');
    expect(w).toHaveLength(1);
    expect(w[0].message).toContain('Memory "zz" was not understood');
    expect(w[0].message).toContain('No --mem line was written.');
  });

  test('writes memory in the form sbatch takes', () => {
    expect(buildSlurmHeader({ memory: '32 GB' }).script).toContain('#SBATCH --mem=32G\n');
    expect(buildSlurmHeader({ memory: '1.5T' }).script).toContain('#SBATCH --mem=1536G\n');
  });

  test('reads a bare memory number as megabytes, writes the unit and warns', () => {
    const { script, warnings } = buildSlurmHeader({ memory: '32', walltime: '1:00:00' });
    expect(script).toContain('#SBATCH --mem=32M\n');
    expect(warnings.find(x => x.field === 'memory').message).toContain('32 megabytes');
  });

  // sbatch(1): "A memory size specification of zero is treated as a special
  // case and grants the job access to all of the memory on each node."
  test('passes a memory of zero through with a note', () => {
    const { script, warnings } = buildSlurmHeader({ memory: '0', array: true, arrayRange: '1-4' });
    expect(script).toContain('#SBATCH --mem=0\n');
    expect(warnings.find(x => x.field === 'memory')).toMatchObject({ level: 'info' });
    expect(warnings.some(x => x.field === 'arrayMemory')).toBe(false);
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

  test('says what is wrong with the array range it replaced', () => {
    const w = buildSlurmHeader({ array: true, arrayRange: '10-1' }).warnings.find(x => x.field === 'arrayRange');
    expect(w.message).toContain('Array range "10-1" is not valid: the range 10-1 runs backwards.');
    expect(w.message).toContain(`Substituted ${DEFAULT_ARRAY_RANGE}.`);
  });

  test('writes a comma list with its limit as given', () => {
    const { script, warnings } = buildSlurmHeader({ array: true, arrayRange: ' 1-5,10-15%2 ', memory: '8G', walltime: '1:00:00' });
    expect(script).toContain('#SBATCH --array=1-5,10-15%2\n');
    expect(warnings.some(w => w.field === 'arrayRange')).toBe(false);
  });

  // slurm.conf(5), MaxArraySize: "The default value is 1001."
  test('notes an index above the default MaxArraySize', () => {
    const big = buildSlurmHeader({ array: true, arrayRange: '1-2000', memory: '8G' }).warnings;
    expect(big.find(w => w.field === 'arrayRange')).toMatchObject({ level: 'info' });
    const ok = buildSlurmHeader({ array: true, arrayRange: '0-1000', memory: '8G' }).warnings;
    expect(ok.some(w => w.field === 'arrayRange')).toBe(false);
  });

  test('totals array memory over every range of a list, under its limit', () => {
    const { warnings } = buildSlurmHeader({ array: true, arrayRange: '1-5,10-15%2', memory: '32G' });
    const w = warnings.find(x => x.field === 'arrayMemory');
    expect(w.concurrent).toBe(2);
    expect(w.totalMemory).toBe(64);
    expect(w.message).toContain('1-11%4');
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
    // One thread-MPI rank: -ntomp alone would start a rank for every core the
    // thread-MPI gmx can see, oversubscribing a shared node.
    expect(b).toContain('-ntmpi 1 -ntomp ${OMP_NUM_THREADS}');
  });

  test('adds GPU offload flags when GPUs are requested', () => {
    expect(buildGromacsBlock({ gpus: 1 })).toContain('-nb gpu');
    expect(buildGromacsBlock({ gpus: 0 })).not.toContain('-nb gpu');
    // Without GPUs mdrun is kept off any GPU the node shows.
    expect(buildGromacsBlock({ gpus: 0 })).toContain(' -nb cpu');
    expect(buildGromacsBlock({ gpus: 1 })).not.toContain('-nb cpu');
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

  test('converts the day forms without seconds', () => {
    expect(walltimeToHours('2-12')).toBeCloseTo(60, 10);
    expect(walltimeToHours('1-12:30')).toBeCloseTo(36.5, 10);
  });

  test('converts hours of three digits and minutes above 99', () => {
    expect(walltimeToHours('100:00:00')).toBeCloseTo(100, 10);
    expect(walltimeToHours('120:00')).toBeCloseTo(2, 10);
  });

  test('adds up out-of-range fields as Slurm does', () => {
    expect(walltimeToHours('99:99:99')).toBeCloseTo(362439 / 3600, 10);
  });

  test('returns null for no limit, which is not a number of hours', () => {
    expect(walltimeToHours('0')).toBeNull();
    expect(walltimeToHours('UNLIMITED')).toBeNull();
    expect(estimateCoreHours({ walltime: '0' })).toBeNull();
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
