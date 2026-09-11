/**
 * @module core/scheduler
 *
 * Batch-scheduler abstraction for the MD workflow generator: the directive
 * header, the environment variables and the MPI launch prefix for SLURM,
 * PBS Professional / OpenPBS, IBM Spectrum LSF and Grid Engine (SGE/UGE).
 *
 * SLURM is delegated to `core/slurm` untouched, so a script generated for it
 * is the same byte for byte as before this module existed. The other three
 * take the same configuration object and translate it directive by directive.
 *
 * The resource request keeps the two shapes `core/slurm` distinguishes: the
 * threaded model (GROMACS: one rank per node, `cpusPerTask` threads) and the
 * MPI model (LAMMPS: `tasksPerNode` ranks per node, optionally threaded).
 *
 * Every directive emitted here can be found in the vendor documentation:
 *
 *   - SLURM:       sbatch(1), https://slurm.schedmd.com/sbatch.html
 *   - PBS:         qsub(1B) and pbs_resources(7B) man pages, OpenPBS repository
 *                  (https://github.com/openpbs/openpbs/blob/master/doc/man1/qsub.1B,
 *                  https://github.com/openpbs/openpbs/blob/master/doc/man1/pbs_resources.7B)
 *                  and the PBS Professional User's Guide, chapters "Submitting
 *                  a PBS Job", "Allocating Resources & Placing Jobs" and
 *                  "Job Arrays" (https://help.altair.com/2021.1.3/PBS%20Professional/PBSUserGuide2021.1.3.pdf)
 *   - LSF:         IBM Spectrum LSF 10.1 command reference, bsub
 *                  (https://www.ibm.com/docs/en/spectrum-lsf/10.1.0?topic=reference-bsub)
 *                  and the lsf.conf reference for LSF_UNIT_FOR_LIMITS,
 *                  LSB_GPU_NEW_SYNTAX and LSB_BSUB_PARSE_SCRIPT
 *   - Grid Engine: qsub(1), sge_types(1) and queue_conf(5) man pages
 *                  (https://gridscheduler.sourceforge.net/htmlman/htmlman1/qsub.html)
 *
 * What the vendors leave to the site (the GPU resource name under PBS and
 * Grid Engine, the parallel-environment name, the memory resource and its
 * unit, whether a slot is a core) is marked as site-specific in a comment
 * inside the generated script, so the marker travels with the file rather
 * than staying behind in the browser.
 *
 * Warnings are structured objects, as in `core/slurm`, for the caller to
 * render.
 */

import {
  DEFAULT_WALLTIME,
  DEFAULT_ARRAY_RANGE,
  isValidWallTime,
  isValidArrayRange,
  parseMemory,
  arrayConcurrency,
  walltimeToHours,
  buildSlurmHeader
} from './slurm.js';

/** The default parallel-environment name for Grid Engine. */
export const DEFAULT_PE = 'mpi';

/**
 * Scheduler metadata, in menu order.
 *
 * `stdin` marks LSF, whose `bsub` reads `#BSUB` lines only when the script
 * arrives on standard input; `bsub submit.sh` would run the file as a plain
 * command and ignore every directive unless the site sets
 * `LSB_BSUB_PARSE_SCRIPT=Y` in lsf.conf (the default is N). `logDirAtStart`
 * marks the schedulers that open the log file as the job starts, so `logs/`
 * must exist before submission rather than being created by the script; PBS
 * and LSF spool the streams and copy them back when the job ends.
 *
 * @type {Array<{id:string, label:string, submit:string, prefix:string,
 *               stdin:boolean, logDirAtStart:boolean}>}
 */
export const SCHEDULERS = [
  { id: 'slurm', label: 'SLURM', submit: 'sbatch', prefix: '#SBATCH', stdin: false, logDirAtStart: true },
  { id: 'pbs', label: 'PBS Pro / OpenPBS', submit: 'qsub', prefix: '#PBS', stdin: false, logDirAtStart: false },
  { id: 'lsf', label: 'LSF', submit: 'bsub', prefix: '#BSUB', stdin: true, logDirAtStart: false },
  { id: 'sge', label: 'Grid Engine', submit: 'qsub', prefix: '#$', stdin: false, logDirAtStart: true }
];

/**
 * Look up a scheduler by id.
 *
 * @param {string} id
 * @returns {{id:string, label:string, submit:string, prefix:string, stdin:boolean, logDirAtStart:boolean}}
 * @throws {Error} for an unknown id, since silently falling back to SLURM
 *   would hand a PBS user an sbatch script.
 */
export function getScheduler(id) {
  const s = SCHEDULERS.find(x => x.id === id);
  if (!s) throw new Error(`Unknown scheduler "${id}"; expected one of ${SCHEDULERS.map(x => x.id).join(', ')}.`);
  return s;
}

/**
 * The command that submits a script.
 *
 * @param {string} scheduler
 * @param {string} [scriptName]
 * @returns {string} e.g. `bsub < submit.sh`
 */
export function submitCommand(scheduler, scriptName = 'submit.sh') {
  const s = getScheduler(scheduler);
  return s.stdin ? `${s.submit} < ${scriptName}` : `${s.submit} ${scriptName}`;
}

/**
 * Names of the environment variables each scheduler sets inside a job.
 *
 * `null` means the scheduler has no such variable: PBS lists one line per MPI
 * rank in `$PBS_NODEFILE` instead of a task count, and neither LSF nor Grid
 * Engine reports threads per task (both count slots, which are cores on most
 * sites, in `ntasks`). PBS does: pbs_resources(7B) sets `NCPUS` to the
 * chunk's `ompthreads` for rank 0, which is where the batch script runs.
 * Sources: sbatch(1) "Output environment variables"; PBS Professional User's
 * Guide, "PBS Environment Variables" and "Job Arrays"; LSF "Environment
 * variables set for job execution"; qsub(1) "ENVIRONMENTAL VARIABLES".
 *
 * @param {string} scheduler
 * @returns {{jobId:string, arrayIndex:string, submitDir:string,
 *            cpusPerTask:(string|null), ntasks:(string|null), nodeFile:(string|null)}}
 */
export function envVars(scheduler) {
  switch (getScheduler(scheduler).id) {
    case 'slurm':
      return { jobId: 'SLURM_JOB_ID', arrayIndex: 'SLURM_ARRAY_TASK_ID', submitDir: 'SLURM_SUBMIT_DIR',
               cpusPerTask: 'SLURM_CPUS_PER_TASK', ntasks: 'SLURM_NTASKS', nodeFile: null };
    case 'pbs':
      return { jobId: 'PBS_JOBID', arrayIndex: 'PBS_ARRAY_INDEX', submitDir: 'PBS_O_WORKDIR',
               cpusPerTask: 'NCPUS', ntasks: null, nodeFile: 'PBS_NODEFILE' };
    case 'lsf':
      return { jobId: 'LSB_JOBID', arrayIndex: 'LSB_JOBINDEX', submitDir: 'LS_SUBCWD',
               cpusPerTask: null, ntasks: 'LSB_DJOB_NUMPROC', nodeFile: null };
    default:
      return { jobId: 'JOB_ID', arrayIndex: 'SGE_TASK_ID', submitDir: 'SGE_O_WORKDIR',
               cpusPerTask: null, ntasks: 'NSLOTS', nodeFile: 'PE_HOSTFILE' };
  }
}

/**
 * The MPI launch prefix, with the rank count taken from the allocation.
 *
 * `srun` reads the allocation itself. Under PBS the node file carries one
 * line per MPI rank (the sum of `mpiprocs` over the chunks), so its line
 * count is the rank count whatever the thread count. LSF and Grid Engine
 * report slots, so a hybrid run divides the slot count by the threads per
 * rank requested in the header.
 *
 * @param {string} scheduler
 * @param {{cpusPerTask?:number}} [config]
 * @returns {string}
 */
export function launcher(scheduler, config = {}) {
  const threads = Math.max(1, parseInt(config.cpusPerTask, 10) || 1);
  switch (getScheduler(scheduler).id) {
    case 'slurm': return 'srun';
    case 'pbs': return 'mpirun -np $(wc -l < "$PBS_NODEFILE")';
    case 'lsf': return threads > 1 ? `mpirun -np $((LSB_DJOB_NUMPROC / ${threads}))` : 'mpirun -np $LSB_DJOB_NUMPROC';
    default: return threads > 1 ? `mpirun -np $((NSLOTS / ${threads}))` : 'mpirun -np $NSLOTS';
  }
}

/* ------------------------------------------------------------------ *
 * Wall time
 * ------------------------------------------------------------------ */

/**
 * Convert a SLURM-style wall time to whole seconds.
 *
 * @param {string} t - D-HH:MM:SS, HH:MM:SS, MM:SS or plain minutes.
 * @returns {number|null}
 */
export function walltimeToSeconds(t) {
  const h = walltimeToHours(t);
  return h === null ? null : Math.round(h * 3600);
}

/**
 * Format seconds as HH:MM:SS, the form PBS `walltime` and Grid Engine `h_rt`
 * accept. Hours are not wrapped at 24: both accept `48:00:00`.
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatHMS(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const pad = n => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/**
 * Convert a wall time to LSF's `-W [hour:]minute` form, which has no seconds
 * field. Seconds are rounded up rather than dropped, so the job is never
 * given less time than was asked for.
 *
 * @param {string} t
 * @returns {{value:string, rounded:boolean}|null}
 */
export function lsfWallTime(t) {
  const sec = walltimeToSeconds(t);
  if (sec === null) return null;
  const minutes = Math.ceil(sec / 60);
  const pad = n => String(n).padStart(2, '0');
  return { value: `${Math.floor(minutes / 60)}:${pad(minutes % 60)}`, rounded: sec % 60 !== 0 };
}

/**
 * Resolve the wall time for a non-SLURM header, substituting the same
 * default `core/slurm` uses when the string is unusable.
 *
 * @param {string} walltime
 * @param {Array<object>} warnings
 * @returns {string} A valid SLURM-style wall time.
 */
function effectiveWalltime(walltime, warnings) {
  if (isValidWallTime(walltime)) return walltime.trim();
  warnings.push({
    level: 'warn',
    field: 'walltime',
    message: `Wall time looks malformed, expected D-HH:MM:SS, HH:MM:SS, or ` +
             `minutes. Substituted ${DEFAULT_WALLTIME}.`
  });
  return DEFAULT_WALLTIME;
}

/* ------------------------------------------------------------------ *
 * Memory
 * ------------------------------------------------------------------ */

const UNIT_ORDER = ['K', 'M', 'G', 'T'];

/**
 * Express a memory amount with an integer value, stepping down to a smaller
 * unit when needed (1.5T becomes 1536G). PBS and Grid Engine sizes take an
 * integer; kilobytes are rounded when nothing smaller would help.
 *
 * @param {number} value
 * @param {'M'|'G'|'T'} unit
 * @returns {{value:number, unit:string}}
 */
function integerAmount(value, unit) {
  let v = value;
  let i = UNIT_ORDER.indexOf(unit);
  while (!Number.isInteger(v) && i > 0) {
    v *= 1024;
    i -= 1;
  }
  return { value: Math.round(v), unit: UNIT_ORDER[i] };
}

/**
 * Convert a SLURM-style memory string to a scheduler's own spelling.
 *
 *   - PBS:  a size, integer plus `kb|mb|gb|tb` (PBS Professional Reference
 *           Guide, "Formats": size).
 *   - LSF:  a bare number in the unit `LSF_UNIT_FOR_LIMITS` selects, MB on
 *           most sites, so the value is rendered in MB.
 *   - SGE:  a memory specifier, integer plus `K|M|G` (sge_types(1)); T is not
 *           universal, so terabytes are expressed in gigabytes.
 *
 * @param {string} mem - e.g. "32G", "4000M", "1.5T".
 * @param {'pbs'|'lsf'|'sge'} scheduler
 * @returns {string|null} null when the string cannot be parsed.
 */
export function convertMemory(mem, scheduler) {
  const parsed = parseMemory(mem);
  if (!parsed) return null;
  if (scheduler === 'lsf') {
    const factor = { M: 1, G: 1024, T: 1024 * 1024 }[parsed.unit];
    return String(Math.ceil(parsed.value * factor));
  }
  let { value, unit } = parsed;
  if (scheduler === 'sge' && unit === 'T') {
    value *= 1024;
    unit = 'G';
  }
  const a = integerAmount(value, unit);
  return scheduler === 'pbs' ? `${a.value}${a.unit.toLowerCase()}b` : `${a.value}${a.unit}`;
}

function memoryWarning(directive) {
  return {
    level: 'warn',
    field: 'memory',
    message: 'No memory requested. Most clusters then apply a small default ' +
             `(often ~1 GB/CPU), which can kill MD jobs. Set a value for ${directive}.`
  };
}

/* ------------------------------------------------------------------ *
 * Job arrays
 * ------------------------------------------------------------------ */

/**
 * Parse a SLURM-style array range into its segments.
 *
 * @param {string} range - e.g. `1-10`, `1-100:2%4`, `1,3,5`, `1-5,10-15`.
 * @returns {{segments:Array<{start:number, end:number, step:number}>, cap:(number|null)}|null}
 */
export function parseArrayRange(range) {
  if (!isValidArrayRange(range)) return null;
  const [body, capText] = range.trim().split('%');
  const segments = body.split(',').map(seg => {
    const m = seg.match(/^(\d+)(?:-(\d+))?(?::(\d+))?$/);
    return { start: parseInt(m[1], 10), end: m[2] ? parseInt(m[2], 10) : parseInt(m[1], 10),
             step: m[3] ? parseInt(m[3], 10) : 1 };
  });
  return { segments, cap: capText ? parseInt(capText, 10) : null };
}

/**
 * Resolve the array range, substituting the SLURM default and warning when
 * it is unusable; the caller renders it in its own syntax.
 *
 * @param {string} arrayRange
 * @param {Array<object>} warnings
 * @returns {{range:string, parsed:{segments:Array<object>, cap:(number|null)}}}
 */
function effectiveArray(arrayRange, warnings) {
  let range = arrayRange;
  let parsed = parseArrayRange(range);
  if (!parsed) {
    range = DEFAULT_ARRAY_RANGE;
    parsed = parseArrayRange(range);
    warnings.push({
      level: 'warn',
      field: 'arrayRange',
      message: `Array range looks malformed, expected e.g. 1-10 or 1-100:2. ` +
               `Substituted ${DEFAULT_ARRAY_RANGE}.`
    });
  }
  return { range: range.trim(), parsed };
}

/**
 * A single `X-Y[:Z]` range for the schedulers whose array option takes one
 * range only (PBS `-J`, Grid Engine `-t`). A comma list keeps its first
 * segment and says so.
 */
function singleRange(parsed, range, option, warnings) {
  const seg = parsed.segments[0];
  if (parsed.segments.length > 1) {
    warnings.push({
      level: 'warn',
      field: 'arrayRange',
      message: `${option} takes a single X-Y[:Z] range, so only the first part of ` +
               `${range} was used. Submit the other parts as separate arrays.`
    });
  }
  return `${seg.start}-${seg.end}${seg.step > 1 ? `:${seg.step}` : ''}`;
}

/** The array-memory total, as `core/slurm` reports it. */
function arrayMemoryWarning(memory, range, warnings) {
  const mem = parseMemory(memory);
  const conc = arrayConcurrency(range);
  if (!mem || !conc) return;
  const total = mem.value * conc.concurrent;
  warnings.push({
    level: 'warn',
    field: 'arrayMemory',
    message: `Array job: the memory request is per task. With ${conc.concurrent} ` +
             `task(s) running concurrently that is ${total}${mem.unit} in flight. ` +
             `Confirm this fits your queue limit, if not, cap concurrency ` +
             `in the array range (e.g. 1-${conc.total}%4).`,
    totalMemory: total,
    unit: mem.unit,
    concurrent: conc.concurrent
  });
}

/* ------------------------------------------------------------------ *
 * Headers
 * ------------------------------------------------------------------ */

/** A count that must be at least one: every scheduler here rejects a zero. */
const atLeastOne = n => Math.max(1, parseInt(n, 10) || 1);

/**
 * Read the shared configuration with the same defaults as `core/slurm`.
 *
 * Node, rank and thread counts are raised to at least one. `core/slurm`
 * passes a zero through unchanged, and its output is not touched here, but
 * a PBS chunk with `ncpus=0` or an LSF `-n 0` is rejected at submission
 * rather than merely wasteful, so the translated headers are kept valid.
 */
function readConfig(config) {
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
    mailUser = '',
    pe = DEFAULT_PE
  } = config;
  const threaded = engine === 'gromacs';
  const threads = atLeastOne(cpusPerTask);
  const ranksPerNode = threaded ? 1 : atLeastOne(tasksPerNode);
  return {
    engine, jobName, partition,
    nodes: atLeastOne(nodes),
    gpus: Math.max(0, parseInt(gpus, 10) || 0),
    cpusPerTask, tasksPerNode, walltime,
    memory, array, arrayRange, mailUser, pe: (pe && String(pe).trim()) || DEFAULT_PE,
    threaded, threads, ranksPerNode,
    coresPerNode: ranksPerNode * threads
  };
}

/**
 * Fail-fast repeated in the body, since whether the `-e` on the shebang line
 * reaches bash depends on how each scheduler starts the script.
 *
 *   - PBS hands the script's file name to the login shell (or the `-S`
 *     shell) on standard input, so the kernel reads the shebang and its
 *     options apply; a MoM built with `--disable-shell-pipe` feeds the
 *     script text to the shell instead, and then they do not.
 *   - LSF runs the spooled script with the interpreter named on its first
 *     line (/bin/sh when there is none); the documentation does not say
 *     whether the options on that line are kept.
 *   - Grid Engine's default `shell_start_mode` is `posix_compliant`, which
 *     ignores the shebang line altogether and runs the script through the
 *     `-S` shell or the queue's default (queue_conf(5)).
 */
const SET_E = {
  pbs: '# PBS starts the script through your login shell, which normally lets the\n' +
       '# #! line apply; fail-fast is repeated here so it does not depend on that.\n' +
       'set -e\n',
  lsf: '# LSF runs the spooled script with the interpreter on its first line; whether\n' +
       '# the options on that line survive is not documented, so fail-fast is repeated.\n' +
       'set -e\n',
  sge: '# Grid Engine (shell_start_mode posix_compliant, the default) ignores the #!\n' +
       '# line and runs the script through the -S shell, so fail-fast is set here.\n' +
       'set -e\n'
};

/**
 * PBS Professional / OpenPBS header.
 *
 * Directives, per qsub(1B): `-N` (job name), `-q` (destination), `-l
 * select=[N:]<chunk>` with the chunk resources `ncpus`, `mpiprocs`,
 * `ompthreads` and `mem` from pbs_resources(7B) plus the customary `ngpus`,
 * `-l walltime`, `-l place`, `-J X-Y[:Z][%max]` (indices "must be greater
 * than or equal to zero"; `%max` sets `max_run_subjobs`), `-o`/`-e` (a path
 * without a file name yields `<job ID>.OU` / `.ER`), `-m` with `a` (aborted)
 * and `e` (terminates), `-M`.
 */
function buildPbsHeader(c, warnings) {
  const lines = ['#!/bin/bash -e', `#PBS -N ${c.jobName}`];
  if (c.partition) lines.push(`#PBS -q ${c.partition}`);

  // One chunk per node. pbs_resources(7B): the node file lists each chunk's
  // host mpiprocs times, and ompthreads is what rank 0 sees as NCPUS and
  // OMP_NUM_THREADS.
  let chunk = `select=${c.nodes}:ncpus=${c.coresPerNode}:mpiprocs=${c.ranksPerNode}:ompthreads=${c.threads}`;
  if (c.gpus > 0) chunk += `:ngpus=${c.gpus}`;
  let memory = null;
  if (c.memory) {
    memory = convertMemory(c.memory, 'pbs');
    if (memory) chunk += `:mem=${memory}`;
    else warnings.push({ level: 'warn', field: 'memory',
      message: `Memory "${c.memory}" was not understood (expected e.g. 32G or 4000M) and was left out of the select line.` });
  } else {
    warnings.push(memoryWarning('mem in the select chunk'));
  }
  lines.push(`#PBS -l ${chunk}`);
  // Without it PBS may pack two small chunks onto one host, which is not what
  // a request for N nodes means.
  if (c.nodes > 1) lines.push('#PBS -l place=scatter');

  const wall = effectiveWalltime(c.walltime, warnings);
  lines.push(`#PBS -l walltime=${formatHMS(walltimeToSeconds(wall))}`);

  let effectiveRange = c.arrayRange;
  if (c.array) {
    const { range, parsed } = effectiveArray(c.arrayRange, warnings);
    effectiveRange = range;
    const single = singleRange(parsed, range, 'PBS -J', warnings);
    lines.push(`#PBS -J ${single}${parsed.cap ? `%${parsed.cap}` : ''}`);
    if (parsed.cap) {
      warnings.push({ level: 'info', field: 'arrayRange',
        message: `The %${parsed.cap} concurrency cap needs a PBS server that supports max_run_subjobs (OpenPBS and current PBS Professional); an older server rejects the -J line.` });
    }
  }

  lines.push('#PBS -o logs/');
  lines.push('#PBS -e logs/');

  if (c.mailUser) {
    lines.push('#PBS -m ae');
    lines.push(`#PBS -M ${c.mailUser}`);
  }

  if (c.array && memory) arrayMemoryWarning(c.memory, effectiveRange, warnings);

  const notes = [];
  if (c.gpus > 0) {
    notes.push('# Site-specific: ngpus is the usual GPU chunk resource on PBS Professional');
    notes.push('# and OpenPBS, but some sites define their own name (check `pbsnodes -av`).');
  }
  notes.push('# PBS has no %j-style tokens: with a directory as -o/-e it writes');
  notes.push('# logs/<job ID>.OU and logs/<job ID>.ER, one pair per subjob in an array.');

  return lines.join('\n') + '\n' + notes.join('\n') + '\n' + SET_E.pbs;
}

/**
 * IBM Spectrum LSF header.
 *
 * Directives, per the bsub reference: `-J name` or `"name[index_list]%limit"`
 * (indices start at 1), `-q`, `-n` (slots), `-R "span[ptile=n]"` (slots per
 * host), `-R "rusage[mem=n]"` (the unit is `LSF_UNIT_FOR_LIMITS` from
 * lsf.conf, MB by default), `-gpu "num=n"` ("by default, the number is per
 * host"; needs `LSB_GPU_NEW_SYNTAX=Y` or `extend` in lsf.conf, otherwise the
 * legacy `ngpus_shared` / `ngpus_excl_p` rusage resources apply), `-W
 * [hour:]minute`, `-o`/`-e` with `%J` (job ID) and `%I` (array index), `-N`
 * (job report by mail when the job finishes), `-u` (recipient).
 */
function buildLsfHeader(c, warnings) {
  const lines = ['#!/bin/bash -e'];

  let effectiveRange = c.arrayRange;
  if (c.array) {
    const { range, parsed } = effectiveArray(c.arrayRange, warnings);
    effectiveRange = range;
    if (parsed.segments.some(s => s.start === 0)) {
      warnings.push({ level: 'warn', field: 'arrayRange',
        message: 'LSF array indices start at 1; an index of 0 is rejected at submission. Start the range at 1.' });
    }
    const list = parsed.segments.map(s => s.start === s.end ? `${s.start}` :
      `${s.start}-${s.end}${s.step > 1 ? `:${s.step}` : ''}`).join(',');
    lines.push(`#BSUB -J "${c.jobName}[${list}]${parsed.cap ? `%${parsed.cap}` : ''}"`);
  } else {
    lines.push(`#BSUB -J ${c.jobName}`);
  }
  if (c.partition) lines.push(`#BSUB -q ${c.partition}`);

  // Slots are cores on most sites: ranks times threads per rank, kept together
  // per host by ptile.
  const slots = c.nodes * c.coresPerNode;
  lines.push(`#BSUB -n ${slots}`);
  lines.push(`#BSUB -R "span[ptile=${c.coresPerNode}]"`);

  let memory = null;
  if (c.memory) {
    memory = convertMemory(c.memory, 'lsf');
    if (memory) lines.push(`#BSUB -R "rusage[mem=${memory}]"`);
    else warnings.push({ level: 'warn', field: 'memory',
      message: `Memory "${c.memory}" was not understood (expected e.g. 32G or 4000M) and no rusage[mem] line was written.` });
  } else {
    warnings.push(memoryWarning('rusage[mem]'));
  }
  if (c.gpus > 0) lines.push(`#BSUB -gpu "num=${c.gpus}"`);

  const wall = lsfWallTime(effectiveWalltime(c.walltime, warnings));
  lines.push(`#BSUB -W ${wall.value}`);
  if (wall.rounded) {
    warnings.push({ level: 'info', field: 'walltime',
      message: `LSF -W has minute resolution, so ${c.walltime.trim()} was rounded up to ${wall.value} (hours:minutes).` });
  }

  const suffix = c.array ? '%J_%I' : '%J';
  lines.push(`#BSUB -o logs/${c.jobName}_${suffix}.out`);
  lines.push(`#BSUB -e logs/${c.jobName}_${suffix}.err`);

  if (c.mailUser) {
    lines.push('#BSUB -N');
    lines.push(`#BSUB -u ${c.mailUser}`);
  }

  if (c.array && memory) arrayMemoryWarning(c.memory, effectiveRange, warnings);

  const notes = [
    '# Site-specific: -n counts slots, which are cores on most LSF sites (ranks x',
    '# threads per rank); span[ptile] keeps that many on each host. rusage[mem] is',
    '# in MB unless LSF_UNIT_FOR_LIMITS in lsf.conf says otherwise, and is reserved',
    '# per host unless the site sets RESOURCE_RESERVE_PER_TASK.'
  ];
  if (c.gpus > 0) {
    notes.push('# -gpu needs LSB_GPU_NEW_SYNTAX=Y (or extend) in lsf.conf; a site without it');
    notes.push(`# takes the legacy form, e.g. -R "rusage[ngpus_excl_p=${c.gpus}]".`);
  }
  notes.push('# Submit with `bsub < submit.sh`: given as an argument the file runs as a plain');
  notes.push('# command and its #BSUB lines are ignored (LSB_BSUB_PARSE_SCRIPT=N, the default).');

  return lines.join('\n') + '\n' + notes.join('\n') + '\n' + SET_E.lsf;
}

/**
 * Grid Engine (SGE / UGE / OGS) header.
 *
 * Directives, per qsub(1): `-N` (a `name` as sge_types(1) defines it), `-S`
 * (interpreting shell; needed because the default `shell_start_mode` ignores
 * the shebang line and the default queue shell is csh), `-cwd`, `-q`, `-pe
 * <name> <slots>`, `-l h_rt` (hh:mm:ss), `-l h_vmem` (a memory specifier
 * with K, M or G; no T), `-t n-m[:s]` with `1 <= n`, `-tc` (concurrent
 * tasks), `-o` (a directory takes the default file name `<job
 * name>.o<job ID>`), `-j y`, `-m` with `e` (end) and `a` (aborted), `-M`.
 * GPUs have no standard request, so the header carries a commented
 * placeholder rather than an invented resource name.
 */
function buildSgeHeader(c, warnings) {
  const lines = ['#!/bin/bash -e', `#$ -N ${c.jobName}`, '#$ -S /bin/bash', '#$ -cwd'];
  // sge_types(1) allows any alphanumeric string, but the qmaster refuses a
  // leading digit at submission: 'denied: "1abc" is not a valid object name
  // (cannot start with a digit)'.
  if (/^\d/.test(c.jobName)) {
    warnings.push({ level: 'warn', field: 'jobName',
      message: `Grid Engine rejects a job name that starts with a digit ("${c.jobName}"). Start it with a letter.` });
  }
  if (c.partition) lines.push(`#$ -q ${c.partition}`);
  if (/\s/.test(c.pe)) {
    warnings.push({ level: 'warn', field: 'pe',
      message: `The parallel environment name "${c.pe}" contains whitespace; qsub takes a single name (see qconf -spl).` });
  }
  lines.push(`#$ -pe ${c.pe} ${c.nodes * c.coresPerNode}`);

  const wall = effectiveWalltime(c.walltime, warnings);
  lines.push(`#$ -l h_rt=${formatHMS(walltimeToSeconds(wall))}`);

  let memory = null;
  if (c.memory) {
    memory = convertMemory(c.memory, 'sge');
    if (memory) lines.push(`#$ -l h_vmem=${memory}`);
    else warnings.push({ level: 'warn', field: 'memory',
      message: `Memory "${c.memory}" was not understood (expected e.g. 32G or 4000M) and no h_vmem line was written.` });
  } else {
    warnings.push(memoryWarning('-l h_vmem'));
  }

  let effectiveRange = c.arrayRange;
  if (c.array) {
    const { range, parsed } = effectiveArray(c.arrayRange, warnings);
    effectiveRange = range;
    if (parsed.segments[0].start === 0) {
      warnings.push({ level: 'warn', field: 'arrayRange',
        message: 'Grid Engine array indices are 1-based (qsub -t requires n >= 1); a range starting at 0 is rejected at submission.' });
    }
    lines.push(`#$ -t ${singleRange(parsed, range, 'Grid Engine -t', warnings)}`);
    if (parsed.cap) lines.push(`#$ -tc ${parsed.cap}`);
  }

  lines.push('#$ -o logs/');
  lines.push('#$ -j y');

  if (c.mailUser) {
    lines.push('#$ -m ea');
    lines.push(`#$ -M ${c.mailUser}`);
  }

  if (c.array && memory) arrayMemoryWarning(c.memory, effectiveRange, warnings);

  // h_vmem is two things at once: an address-space limit on each process
  // and, where the site declares it consumable (qconf -sc), a reservation
  // multiplied by the slot count. Neither a per-node nor a per-slot figure
  // is right on every site, so the script states what the line does here
  // and leaves the choice to the reader.
  const notes = [
    '# Site-specific: the parallel environment name (`qconf -spl`; a shared-memory',
    '# PE such as smp for threaded runs, an MPI one for ranks across hosts) and the',
    '# memory resource. h_vmem limits the address space of each process and, where',
    '# the site makes it consumable (`qconf -sc`), is reserved per slot' +
      (memory ? `: ${memory} x ${c.coresPerNode}` : '') + ' on',
    '# each host. Some sites use mem_free or m_mem_free instead; ask before submitting.'
  ];
  if (c.nodes > 1) {
    notes.push('# A plain PE does not pin slots per host; to hold the node count above, use a');
    notes.push('# PE whose allocation_rule is the slots per node.');
  }
  if (c.gpus > 0) {
    notes.push('# Grid Engine has no standard GPU request. Ask your administrator for the');
    notes.push('# resource name (gpu, ngpus, gpu_card ...), then uncomment and adjust:');
    notes.push(`# #$ -l gpu=${c.gpus}`);
    warnings.push({ level: 'info', field: 'gpus',
      message: `Grid Engine has no standard GPU request. The script carries a commented placeholder for ${c.gpus} GPU(s); fill in your site's resource name before submitting.` });
  }
  notes.push('# With a directory as -o, Grid Engine writes logs/<job name>.o<job ID> (plus');
  notes.push('# .<task ID> for array tasks); -j y merges stderr into it.');

  return lines.join('\n') + '\n' + notes.join('\n') + '\n' + SET_E.sge;
}

/**
 * Build the directive header for a scheduler.
 *
 * For SLURM this is exactly `buildSlurmHeader` from `core/slurm`. For the
 * others the same configuration is translated; `pe` names the Grid Engine
 * parallel environment.
 *
 * @param {{
 *   scheduler?: 'slurm'|'pbs'|'lsf'|'sge',
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
 *   mailUser?: string,
 *   pe?: string
 * }} config
 * @returns {{script:string, warnings:Array<{level:string, field:string, message:string}>}}
 */
export function buildHeader(config = {}) {
  const id = getScheduler(config.scheduler || 'slurm').id;
  if (id === 'slurm') return buildSlurmHeader(config);

  const warnings = [];
  const c = readConfig(config);
  const script = id === 'pbs' ? buildPbsHeader(c, warnings)
    : id === 'lsf' ? buildLsfHeader(c, warnings)
    : buildSgeHeader(c, warnings);
  return { script, warnings };
}
