/**
 * @module core/slurm
 *
 * SLURM batch-script generation extracted from STEMKit's HPC Script Generator.
 *
 * The original implementation read every setting directly from the DOM. Here
 * the generator takes a plain configuration object instead, which makes the
 * resource logic testable and lets the same code run in a CI pipeline or a
 * Node script that submits jobs programmatically.
 *
 * Two aspects deserve comment because they are the usual sources of wasted
 * allocation:
 *
 *   1. **The resource model differs by engine.** GROMACS is threaded and wants
 *      one MPI task per node with many CPUs per task; LAMMPS is MPI-parallel
 *      and wants many tasks per node. Emitting the wrong shape either wastes
 *      most of a node or oversubscribes it.
 *   2. **`--mem` in an array job is per task, not per job.** A 32 GB request
 *      across a 100-task array asks the scheduler for 3.2 TB in flight. The
 *      generator computes the real total and warns, since this routinely
 *      wedges a queue.
 *
 * The wall time, the array range and the memory size are read as sbatch reads
 * them. Where sbatch(1) leaves a case open (a field above its usual range, a
 * limit of zero) the behaviour is taken from the Slurm source, master branch
 * at version 26.11: `time_str2secs` in src/common/parse_time.c,
 * `slurm_parse_array_tok` in src/common/slurm_protocol_defs.c and
 * `str_to_mbytes` in src/common/proc_args.c.
 *
 * Warnings are returned as structured objects rather than HTML strings so the
 * caller decides how to present them.
 */

/** Default wall time substituted when the supplied value is unusable. */
export const DEFAULT_WALLTIME = '24:00:00';

/** Default array range substituted when the supplied value is unusable. */
export const DEFAULT_ARRAY_RANGE = '1-5';

/* ------------------------------------------------------------------ *
 * Wall time
 * ------------------------------------------------------------------ */

/** The forms sbatch(1) lists for `--time`, as a phrase for messages. */
const WALLTIME_FORMS = 'minutes, minutes:seconds, hours:minutes:seconds, days-hours, ' +
  'days-hours:minutes or days-hours:minutes:seconds';

/** `time_str2secs` adds the fields up in a C int. */
const MAX_WALL_SECONDS = 2147483647;

/** Seconds as H:MM:SS, hours not wrapped at 24. */
function clock(seconds) {
  const pad = n => String(n).padStart(2, '0');
  return `${Math.floor(seconds / 3600)}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}

/**
 * Read a wall time the way Slurm does.
 *
 * sbatch(1): "Acceptable time formats include "minutes", "minutes:seconds",
 * "hours:minutes:seconds", "days-hours", "days-hours:minutes" and
 * "days-hours:minutes:seconds"", and "A time limit of zero requests that no
 * time limit be imposed". The details follow `time_str2secs` and
 * `_is_valid_timespec` in Slurm's src/common/parse_time.c:
 *
 *   - a field is any run of digits: `100:00:00` and `120:00` are fine;
 *   - no field is range-checked. The fields are multiplied out and added, so
 *     `99:99:99` is accepted and means 100:40:39. `carried` lists the fields
 *     that spill into the next one, for the caller to point out;
 *   - `-1`, `INFINITE` and `UNLIMITED` ask for no limit, as does a total of
 *     zero (`arg_set_time_limit` in src/common/slurm_opt.c);
 *   - a day count with nothing after the dash (`2-`) is read as whole days.
 *
 * A lone `-N` other than `-1` also passes Slurm's check, as a negative
 * number of days; it is refused here.
 *
 * @param {string} t
 * @returns {{seconds:number, unlimited:boolean, form:string, carried:string[]}|null}
 *   `seconds` is Infinity when no limit is asked for; null when sbatch would
 *   answer "Invalid --time specification".
 */
export function parseWallTime(t) {
  if (typeof t !== 'string') return null;
  const s = t.trim();
  if (!s) return null;
  if (s === '-1' || /^(infinite|unlimited)$/i.test(s)) {
    return { seconds: Infinity, unlimited: true, form: 'unlimited', carried: [] };
  }

  let d = 0, h = 0, m = 0, sec = 0, form, x;
  if ((x = /^(\d+)$/.exec(s))) {
    m = Number(x[1]); form = 'minutes';
  } else if ((x = /^(\d+):(\d+)$/.exec(s))) {
    m = Number(x[1]); sec = Number(x[2]); form = 'minutes:seconds';
  } else if ((x = /^(\d+):(\d+):(\d+)$/.exec(s))) {
    h = Number(x[1]); m = Number(x[2]); sec = Number(x[3]); form = 'hours:minutes:seconds';
  } else if ((x = /^(\d+)-(\d*)$/.exec(s))) {
    d = Number(x[1]); h = Number(x[2] || 0); form = 'days-hours';
  } else if ((x = /^(\d+)-(\d+):(\d+)$/.exec(s))) {
    d = Number(x[1]); h = Number(x[2]); m = Number(x[3]); form = 'days-hours:minutes';
  } else if ((x = /^(\d+)-(\d+):(\d+):(\d+)$/.exec(s))) {
    d = Number(x[1]); h = Number(x[2]); m = Number(x[3]); sec = Number(x[4]); form = 'days-hours:minutes:seconds';
  } else {
    return null;
  }

  const seconds = d * 86400 + h * 3600 + m * 60 + sec;
  if (!(seconds <= MAX_WALL_SECONDS)) return null;
  if (seconds === 0) return { seconds: Infinity, unlimited: true, form, carried: [] };

  // A field above its usual range is only odd where a larger field exists
  // for it to spill into: 120 in "120:00" is simply 120 minutes.
  const carried = [];
  if (form.startsWith('days') && h > 23) carried.push(`${h} hours`);
  if (form.includes('hours:minutes') && m > 59) carried.push(`${m} minutes`);
  if (form.endsWith('seconds') && sec > 59) carried.push(`${sec} seconds`);
  return { seconds, unlimited: false, form, carried };
}

/**
 * Validate a SLURM wall-time string: true for what sbatch accepts.
 *
 * @param {string} t
 * @returns {boolean}
 */
export function isValidWallTime(t) {
  return parseWallTime(t) !== null;
}

/**
 * Settle the wall time for a header: the value to use and what to tell the
 * user about it. Shared with `core/scheduler`, whose other schedulers take
 * the same field and translate it.
 *
 * @param {string} walltime
 * @param {{unlimited?:boolean, scheduler?:string}} [options] - `unlimited`
 *   says whether "no limit" can be written for this scheduler (sbatch only);
 *   `scheduler` names it in the message when it cannot.
 * @returns {{value:string, seconds:number, warnings:Array<object>}} `value`
 *   is trimmed and valid: the given time, or the default.
 */
export function resolveWallTime(walltime, options = {}) {
  const { unlimited = true, scheduler = 'This scheduler' } = options;
  const warnings = [];
  const text = walltime == null ? '' : String(walltime).trim();
  const fallback = () => ({ value: DEFAULT_WALLTIME, seconds: parseWallTime(DEFAULT_WALLTIME).seconds, warnings });
  const parsed = parseWallTime(text);

  if (!parsed) {
    warnings.push({
      level: 'warn',
      field: 'walltime',
      message: (text ? `Wall time "${text}" was not understood. ` : 'No wall time was given. ') +
               `Use ${WALLTIME_FORMS}, for example 24:00:00 or 2-12. Substituted ${DEFAULT_WALLTIME}.`
    });
    return fallback();
  }

  if (parsed.unlimited) {
    if (!unlimited) {
      warnings.push({
        level: 'warn',
        field: 'walltime',
        message: `Wall time ${text} means no time limit, which only sbatch can be asked for. ` +
                 `${scheduler} needs a time. Substituted ${DEFAULT_WALLTIME}.`
      });
      return fallback();
    }
    warnings.push({
      level: 'info',
      field: 'walltime',
      message: `Wall time ${text} asks sbatch for no time limit. A partition with a maximum ` +
               'leaves such a job pending, so give a time unless your site allows unlimited jobs.'
    });
    return { value: text, seconds: Infinity, warnings };
  }

  if (parsed.carried.length) {
    warnings.push({
      level: 'warn',
      field: 'walltime',
      message: `Wall time ${text} has ${parsed.carried.join(' and ')}. A field above its usual range ` +
               `is not refused (sbatch adds the fields up), so this asks for ${clock(parsed.seconds)}. ` +
               'Check that this is what you meant.'
    });
  }
  return { value: text, seconds: parsed.seconds, warnings };
}

/* ------------------------------------------------------------------ *
 * Job arrays
 * ------------------------------------------------------------------ */

/**
 * The largest array index any Slurm installation takes: slurm.conf(5) says
 * of MaxArraySize that "The value may not exceed 4000001" and that the
 * largest index is one less.
 */
export const MAX_ARRAY_INDEX = 4000000;

/** The largest index under the default MaxArraySize of 1001 (slurm.conf(5)). */
export const DEFAULT_MAX_ARRAY_INDEX = 1000;

/**
 * Read an `--array` specification, or say why sbatch would not take it.
 *
 * sbatch(1): "Multiple values may be specified using a comma separated list
 * and/or a range of values with a "-" separator ... A step function can also
 * be specified with a suffix containing a colon and number ... A maximum
 * number of simultaneously running tasks from the job array may be specified
 * using a "%" separator ... The minimum index value is 0." The checks are
 * those of `slurm_parse_array_tok` in Slurm's src/common/slurm_protocol_defs.c:
 * a step only after a range, a step of at least 1, a range that does not run
 * backwards. Indices go into a bitmap there, so one named twice counts once.
 *
 * @param {string} range
 * @returns {{spec:object}|{problem:string}}
 */
function readArraySpec(range) {
  if (typeof range !== 'string' || !range.trim()) return { problem: 'it is empty' };
  const text = range.trim();
  if (/\s/.test(text)) return { problem: 'it has a space in it' };

  const parts = text.split('%');
  if (parts.length > 2 || (parts.length === 2 && !/^\d+$/.test(parts[1]))) {
    return { problem: 'the % limit goes once, at the very end, followed by a number (as in 1-20%4)' };
  }
  // sbatch reads %0 as no limit at all.
  const cap = parts.length === 2 ? Number(parts[1]) || null : null;

  const segments = [];
  for (const item of parts[0].split(',')) {
    if (!item) return { problem: parts[0] ? 'there is nothing between two commas, or before or after one' : 'no index comes before the %' };
    const m = /^(\d+)(?:-(\d+)(?::(\d+))?)?$/.exec(item);
    if (!m) {
      if (/^\d+:\d+$/.test(item)) return { problem: `the step in ${item} needs a range before it (as in 0-15:4)` };
      return { problem: `"${item}" is not an index (5), a range (1-10) or a range with a step (0-15:4)` };
    }
    const start = Number(m[1]);
    const end = m[2] === undefined ? start : Number(m[2]);
    const step = m[3] === undefined ? 1 : Number(m[3]);
    if (end < start) return { problem: `the range ${item} runs backwards` };
    if (step < 1) return { problem: `the step in ${item} is 0` };
    if (end > MAX_ARRAY_INDEX) {
      return { problem: `index ${m[2] === undefined ? m[1] : m[2]} is above ${MAX_ARRAY_INDEX}, the largest any Slurm configuration allows` };
    }
    segments.push({ start, end, step });
  }

  // Distinct indices, as the controller's bitmap holds them.
  const top = segments.reduce((hi, s) => Math.max(hi, s.end), 0);
  const seen = new Uint8Array(top + 1);
  for (const s of segments) {
    if (s.step === 1) seen.fill(1, s.start, s.end + 1);
    else for (let i = s.start; i <= s.end; i += s.step) seen[i] = 1;
  }
  let total = 0, min = -1, max = -1;
  for (let i = 0; i <= top; i++) {
    if (!seen[i]) continue;
    total += 1;
    if (min < 0) min = i;
    max = i;
  }

  // The same indices as one start-end:step range, when they are evenly spaced.
  let progression = { start: min, end: max, step: 1 };
  if (total > 1) {
    const step = (max - min) / (total - 1);
    progression.step = step;
    if (!Number.isInteger(step)) progression = null;
    else for (let i = min; i <= max; i += step) if (!seen[i]) { progression = null; break; }
  }

  return { spec: { segments, cap, total, concurrent: cap ? Math.min(cap, total) : total, min, max, progression } };
}

/**
 * Parse an `--array` specification such as `1-100:2%4` or `0,6,16-32`.
 *
 * @param {string} range
 * @returns {{segments:Array<{start:number, end:number, step:number}>,
 *            cap:(number|null), total:number, concurrent:number, min:number,
 *            max:number, progression:({start:number, end:number, step:number}|null)}|null}
 *   `total` counts distinct indices and `concurrent` applies the `%` limit;
 *   `progression` is the whole set as a single range when it can be written
 *   as one. null when sbatch would reject the specification.
 */
export function parseArraySpec(range) {
  return readArraySpec(range).spec || null;
}

/**
 * Why an `--array` specification is not valid, as the end of a sentence.
 *
 * @param {string} range
 * @returns {string|null} null when it is valid.
 */
export function arraySpecProblem(range) {
  return readArraySpec(range).problem || null;
}

/**
 * Validate a SLURM array-range specification such as `1-100:2%4`.
 *
 * @param {string} r
 * @returns {boolean}
 */
export function isValidArrayRange(r) {
  return parseArraySpec(r) !== null;
}

/**
 * Determine how many array tasks may run at once.
 *
 * A `%N` suffix caps concurrency; without it every task in the range may be
 * scheduled simultaneously.
 *
 * @param {string} range
 * @returns {{total:number, concurrent:number}|null}
 */
export function arrayConcurrency(range) {
  const spec = parseArraySpec(range);
  return spec ? { total: spec.total, concurrent: spec.concurrent } : null;
}

/**
 * Settle the array range for a header: the specification to use and what to
 * tell the user about it. Shared with `core/scheduler`.
 *
 * @param {string} arrayRange
 * @returns {{range:string, spec:object, warnings:Array<object>}} `range` is
 *   trimmed and valid: the given one, or the default.
 */
export function resolveArrayRange(arrayRange) {
  const text = arrayRange == null ? '' : String(arrayRange).trim();
  const read = readArraySpec(text);
  if (read.spec) return { range: text, spec: read.spec, warnings: [] };
  return {
    range: DEFAULT_ARRAY_RANGE,
    spec: readArraySpec(DEFAULT_ARRAY_RANGE).spec,
    warnings: [{
      level: 'warn',
      field: 'arrayRange',
      message: (text ? `Array range "${text}" is not valid: ${read.problem}. ` : 'No array range was given. ') +
               'Give indexes and ranges separated by commas, with an optional :step after a range and ' +
               `one %limit at the end, for example 1-10, 0-15:4 or 1,3,5-8%2. Substituted ${DEFAULT_ARRAY_RANGE}.`
    }]
  };
}

/* ------------------------------------------------------------------ *
 * Memory
 * ------------------------------------------------------------------ */

/**
 * Parse a memory specification into a value and unit.
 *
 * This is the form the generator takes for every scheduler and converts to
 * each one's own spelling: a number, then K, M, G or T with an optional B,
 * in either case. A number on its own is megabytes, which is what sbatch
 * makes of it ("Default units are mebibytes", sbatch(1) under `--mem`);
 * `bare` marks that case so the caller can say so.
 *
 * @param {string} mem - e.g. "32G", "4000M", "1.5T", "512000K", "4000".
 * @returns {{value:number, unit:'K'|'M'|'G'|'T', bare?:boolean}|null}
 */
export function parseMemory(mem) {
  if (!mem || typeof mem !== 'string') return null;
  const m = mem.trim().match(/^(\d+(?:\.\d+)?)\s*(?:([KMGT])B?)?$/i);
  if (!m) return null;
  const value = parseFloat(m[1]);
  if (!Number.isFinite(value)) return null;
  return m[2] ? { value, unit: m[2].toUpperCase() } : { value, unit: 'M', bare: true };
}

/**
 * The value for `--mem`: sbatch takes a whole number with K, M, G or T
 * (`str_to_mbytes` in Slurm's src/common/proc_args.c reads it with strtoll,
 * so `1.5T` is an "Invalid --mem specification"). A fraction is written in
 * the next unit down, and rounded up to a megabyte, the resolution Slurm
 * keeps.
 *
 * @param {string} mem
 * @returns {string|null} null when the string cannot be parsed.
 */
export function slurmMemory(mem) {
  const parsed = parseMemory(mem);
  if (!parsed) return null;
  if (parsed.value === 0) return '0';
  const units = ['M', 'G', 'T'];
  let v = parsed.value;
  let i = units.indexOf(parsed.unit);
  if (i < 0) return `${Math.ceil(v)}K`;
  while (!Number.isInteger(v) && i > 0) {
    v *= 1024;
    i -= 1;
  }
  return `${Math.ceil(v)}${units[i]}`;
}

/**
 * Settle the memory request for a header. `write` turns a parsed, non-zero
 * amount into the scheduler's own spelling; this adds the messages every
 * scheduler shares, so a bad value reads the same whichever one is chosen.
 *
 * @param {string} memory
 * @param {{directive:string, omitted:string, scheduler?:string, zero?:boolean,
 *          write:function(string):string}} target - `directive` names the
 *   request in the "none given" message, `omitted` is the sentence saying no
 *   line was written, `zero` says whether 0 is a request this scheduler has.
 * @returns {{value:(string|null), parsed:(object|null), warnings:Array<object>}}
 */
export function resolveMemory(memory, target) {
  const warnings = [];
  const text = memory == null ? '' : String(memory).trim();
  if (!text) {
    warnings.push({
      level: 'warn',
      field: 'memory',
      message: 'No memory requested. Most clusters then apply a small default ' +
               `(often ~1 GB/CPU), which can kill MD jobs. Set a value for ${target.directive}.`
    });
    return { value: null, parsed: null, warnings };
  }

  const parsed = parseMemory(text);
  if (!parsed) {
    warnings.push({
      level: 'warn',
      field: 'memory',
      message: `Memory "${text}" was not understood. Give a number and a unit, K, M, G or T, ` +
               `for example 32G or 4000M; a number on its own is megabytes. ${target.omitted}`
    });
    return { value: null, parsed: null, warnings };
  }

  if (parsed.value === 0) {
    if (!target.zero) {
      warnings.push({
        level: 'warn',
        field: 'memory',
        message: 'Memory 0 means all the memory of each node, which only sbatch can be asked for. ' +
                 `${target.scheduler} needs an amount, for example 32G. ${target.omitted}`
      });
      return { value: null, parsed: null, warnings };
    }
    warnings.push({
      level: 'info',
      field: 'memory',
      message: 'Memory 0 asks sbatch for all the memory on each node the job gets.'
    });
    return { value: '0', parsed, warnings };
  }

  if (parsed.bare) {
    warnings.push({
      level: 'warn',
      field: 'memory',
      message: `Memory "${text}" has no unit, so it was read as ${text} megabytes, which is what sbatch ` +
               `makes of a bare number. Add the unit (${text}G for gigabytes) if you meant more.`
    });
  }
  return { value: target.write(text), parsed, warnings };
}

/**
 * The array-memory total: the request is per task, so what is in flight is
 * that times the tasks running at once.
 *
 * @param {{value:number, unit:string}} mem - From `parseMemory`.
 * @param {{total:number, concurrent:number}} tasks
 * @param {{request:string, limit:string}} words - How the request and the
 *   limit it must fit are named for this scheduler.
 * @returns {object} A warning.
 */
export function arrayMemoryWarning(mem, tasks, words) {
  const total = mem.value * tasks.concurrent;
  return {
    level: 'warn',
    field: 'arrayMemory',
    message: `Array job: ${words.request} is per task. With ${tasks.concurrent} ` +
             `task(s) running concurrently that is ${total}${mem.unit} in flight. ` +
             `Confirm this fits your ${words.limit} limit, if not, cap concurrency ` +
             `in the array range (e.g. 1-${tasks.total}%4).`,
    totalMemory: total,
    unit: mem.unit,
    concurrent: tasks.concurrent
  };
}

/**
 * Build the `#SBATCH` header block.
 *
 * @param {{
 *   engine?: 'gromacs'|'lammps',
 *   jobName?: string,
 *   partition?: string,
 *   nodes?: number,
 *   gpus?: number,
 *   cpusPerTask?: number,
 *   tasksPerNode?: number,
 *   walltime?: string,
 *   memory?: string,
 *   array?: boolean,
 *   arrayRange?: string,
 *   mailUser?: string
 * }} config
 * @returns {{script:string, warnings:Array<{level:string, message:string}>}}
 */
export function buildSlurmHeader(config = {}) {
  const {
    engine = 'gromacs',
    jobName = 'md_job',
    partition = '',
    nodes = 1,
    gpus = 0,
    cpusPerTask = 1,
    tasksPerNode = 1,
    walltime = '',
    memory = '',
    array = false,
    arrayRange = '',
    mailUser = ''
  } = config;

  const warnings = [];
  const lines = ['#!/bin/bash -e'];

  lines.push(`#SBATCH --job-name=${jobName}`);
  if (partition) lines.push(`#SBATCH --partition=${partition}`);
  lines.push(`#SBATCH --nodes=${nodes}`);

  if (engine === 'gromacs') {
    // Threaded model: one rank per node, many threads per rank.
    lines.push('#SBATCH --ntasks-per-node=1');
    lines.push(`#SBATCH --cpus-per-task=${cpusPerTask}`);
  } else {
    // MPI model: many ranks per node.
    lines.push(`#SBATCH --ntasks-per-node=${tasksPerNode}`);
    if (cpusPerTask > 1) lines.push(`#SBATCH --cpus-per-task=${cpusPerTask}`);
  }

  if (gpus > 0) lines.push(`#SBATCH --gres=gpu:${gpus}`);

  const mem = resolveMemory(memory, {
    directive: '--mem',
    omitted: 'No --mem line was written.',
    zero: true,
    write: slurmMemory
  });
  if (mem.value !== null) lines.push(`#SBATCH --mem=${mem.value}`);
  warnings.push(...mem.warnings);

  const wall = resolveWallTime(walltime);
  lines.push(`#SBATCH --time=${wall.value}`);
  warnings.push(...wall.warnings);

  let tasks = null;
  if (array) {
    const resolved = resolveArrayRange(arrayRange);
    tasks = resolved.spec;
    lines.push(`#SBATCH --array=${resolved.range}`);
    warnings.push(...resolved.warnings);
    if (tasks.max > DEFAULT_MAX_ARRAY_INDEX) {
      warnings.push({
        level: 'info',
        field: 'arrayRange',
        message: `Array index ${tasks.max} is above ${DEFAULT_MAX_ARRAY_INDEX}, the largest a default ` +
                 'Slurm configuration takes (MaxArraySize is 1001 unless the site raises it). ' +
                 'Check with: scontrol show config | grep MaxArraySize'
      });
    }
    lines.push('#SBATCH --output=logs/%x_%A_%a.out');
    lines.push('#SBATCH --error=logs/%x_%A_%a.err');
  } else {
    lines.push('#SBATCH --output=logs/%x_%j.out');
    lines.push('#SBATCH --error=logs/%x_%j.err');
  }

  if (mailUser) {
    lines.push(`#SBATCH --mail-user=${mailUser}`);
    lines.push('#SBATCH --mail-type=END,FAIL,TIME_LIMIT_80');
  }

  // Array memory is requested per task; surface the true in-flight total.
  if (tasks && mem.parsed && mem.parsed.value > 0) {
    warnings.push(arrayMemoryWarning(mem.parsed, tasks, { request: `--mem=${mem.value}`, limit: 'partition' }));
  }

  return { script: lines.join('\n') + '\n', warnings };
}

/**
 * Sanity-check a resource request against common cluster conventions.
 *
 * These are heuristics, not hard rules (a site may legitimately differ) but
 * each flags a pattern that usually indicates a misconfiguration.
 *
 * @param {object} config - Same shape as `buildSlurmHeader`.
 * @returns {Array<{level:string, field:string, message:string}>}
 */
export function validateResources(config = {}) {
  const {
    engine = 'gromacs',
    nodes = 1,
    gpus = 0,
    cpusPerTask = 1,
    tasksPerNode = 1
  } = config;

  const warnings = [];

  if (nodes < 1 || !Number.isInteger(nodes)) {
    warnings.push({ level: 'error', field: 'nodes',
      message: 'Node count must be a positive integer.' });
  }

  if (gpus > 0 && engine === 'lammps' && tasksPerNode !== gpus) {
    warnings.push({
      level: 'warn', field: 'tasksPerNode',
      message: `GPU runs usually pair one MPI rank with each GPU. You have ` +
               `${tasksPerNode} rank(s) per node and ${gpus} GPU(s).`
    });
  }

  if (engine === 'gromacs' && cpusPerTask === 1 && gpus === 0) {
    warnings.push({
      level: 'warn', field: 'cpusPerTask',
      message: 'GROMACS is threaded; requesting a single CPU per task will run ' +
               'far below the throughput of the node.'
    });
  }

  if (nodes > 1 && engine === 'gromacs' && gpus > 0) {
    warnings.push({
      level: 'info', field: 'nodes',
      message: 'Multi-node GPU GROMACS scales poorly for most systems. Confirm ' +
               'the run genuinely benefits before requesting more than one node.'
    });
  }

  return warnings;
}

/**
 * Build a module-loading block.
 *
 * @param {string[]} modules
 * @param {{purge?:boolean}} [options]
 * @returns {string}
 */
export function buildModuleBlock(modules, options = {}) {
  const { purge = true } = options;
  if (!Array.isArray(modules) || modules.length === 0) return '';

  const lines = [];
  if (purge) lines.push('module purge');
  for (const m of modules) {
    if (m && String(m).trim()) lines.push(`module load ${String(m).trim()}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Build a GROMACS run block.
 *
 * @param {{
 *   tpr?: string, deffnm?: string, cpusPerTask?: number, gpus?: number,
 *   maxh?: number, appendCheckpoint?: boolean, plumed?: string
 * }} config
 * @returns {string}
 */
export function buildGromacsBlock(config = {}) {
  const {
    tpr = 'topol.tpr',
    deffnm = 'md',
    cpusPerTask = 1,
    gpus = 0,
    maxh = null,
    appendCheckpoint = true,
    plumed = ''
  } = config;

  const lines = [];
  lines.push('mkdir -p logs');
  lines.push('');
  lines.push('export OMP_NUM_THREADS=${SLURM_CPUS_PER_TASK:-1}');
  lines.push('');

  // One thread-MPI rank with the task's CPUs as OpenMP threads: given -ntomp
  // alone, the thread-MPI gmx starts a rank for every core it can see, which
  // oversubscribes a node the job shares. Without GPUs, -nb cpu keeps mdrun
  // off a GPU the node shows but the job did not ask for.
  let cmd = `gmx mdrun -s ${tpr} -deffnm ${deffnm}`;
  cmd += ` -ntmpi 1 -ntomp \${OMP_NUM_THREADS}`;
  cmd += gpus > 0 ? ' -nb gpu -pme gpu -bonded gpu' : ' -nb cpu';
  if (Number.isFinite(maxh) && maxh > 0) cmd += ` -maxh ${maxh}`;
  if (plumed) cmd += ` -plumed ${plumed}`;

  if (appendCheckpoint) {
    lines.push(`# Resume from a checkpoint when one exists, so a requeued job`);
    lines.push(`# continues rather than silently restarting from t = 0.`);
    lines.push(`if [ -f ${deffnm}.cpt ]; then`);
    lines.push(`    ${cmd} -cpi ${deffnm}.cpt -append`);
    lines.push('else');
    lines.push(`    ${cmd}`);
    lines.push('fi');
  } else {
    lines.push(cmd);
  }

  return lines.join('\n') + '\n';
}

/**
 * Build a LAMMPS run block.
 *
 * @param {{input?:string, log?:string, gpus?:number, suffix?:string}} config
 * @returns {string}
 */
export function buildLammpsBlock(config = {}) {
  const { input = 'in.lammps', log = 'log.lammps', gpus = 0, suffix = '' } = config;

  const lines = ['mkdir -p logs', ''];
  let cmd = 'srun lmp';
  if (gpus > 0) {
    cmd += ` -sf ${suffix || 'gpu'} -pk gpu ${gpus}`;
  } else if (suffix) {
    cmd += ` -sf ${suffix}`;
  }
  cmd += ` -in ${input} -log ${log}`;
  lines.push(cmd);

  return lines.join('\n') + '\n';
}

/**
 * Assemble a complete batch script.
 *
 * @param {object} config - Merged header, module, and engine configuration.
 * @returns {{script:string, warnings:Array<object>}}
 */
export function generateScript(config = {}) {
  const header = buildSlurmHeader(config);
  const resourceWarnings = validateResources(config);

  const parts = [header.script];

  const modules = buildModuleBlock(config.modules || [], config);
  if (modules) parts.push('', modules);

  if (config.engine === 'lammps') {
    parts.push('', buildLammpsBlock(config));
  } else {
    parts.push('', buildGromacsBlock(config));
  }

  return {
    script: parts.join('\n').replace(/\n{3,}/g, '\n\n'),
    warnings: [...header.warnings, ...resourceWarnings]
  };
}

/**
 * Estimate total core-hours for a request, for allocation planning.
 *
 * @param {{nodes?:number, cpusPerTask?:number, tasksPerNode?:number,
 *          walltime?:string, engine?:string}} config
 * @returns {{coreHours:number, hours:number, cores:number}|null}
 */
export function estimateCoreHours(config = {}) {
  const {
    nodes = 1, cpusPerTask = 1, tasksPerNode = 1,
    walltime = '', engine = 'gromacs'
  } = config;

  const hours = walltimeToHours(walltime);
  if (hours === null) return null;

  const coresPerNode = engine === 'gromacs'
    ? cpusPerTask
    : tasksPerNode * Math.max(1, cpusPerTask);
  const cores = nodes * coresPerNode;

  return { coreHours: cores * hours, hours, cores };
}

/**
 * Convert a SLURM wall-time string to hours, adding the fields up as Slurm
 * does (see `parseWallTime`).
 *
 * @param {string} t
 * @returns {number|null} Hours; null when the string is unparseable or asks
 *   for no limit, since neither is a number of hours to plan with.
 */
export function walltimeToHours(t) {
  const parsed = parseWallTime(t);
  return parsed && !parsed.unlimited ? parsed.seconds / 3600 : null;
}
