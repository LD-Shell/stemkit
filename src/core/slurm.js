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
 * Warnings are returned as structured objects rather than HTML strings so the
 * caller decides how to present them.
 */

/** Wall-time formats SLURM accepts. */
const WALLTIME_PATTERNS = [
  /^(\d+-)?\d{1,2}:\d{2}:\d{2}$/, // D-HH:MM:SS or HH:MM:SS
  /^\d{1,2}:\d{2}$/,              // MM:SS
  /^\d+$/                         // plain minutes
];

/** Default wall time substituted when the supplied value is unusable. */
export const DEFAULT_WALLTIME = '24:00:00';

/** Default array range substituted when the supplied value is unusable. */
export const DEFAULT_ARRAY_RANGE = '1-5';

/**
 * Validate a SLURM wall-time string.
 *
 * @param {string} t
 * @returns {boolean}
 */
export function isValidWallTime(t) {
  if (!t || typeof t !== 'string') return false;
  const s = t.trim();
  return WALLTIME_PATTERNS.some(re => re.test(s));
}

/**
 * Validate a SLURM array-range specification such as `1-100:2%4`.
 *
 * @param {string} r
 * @returns {boolean}
 */
export function isValidArrayRange(r) {
  if (!r || typeof r !== 'string') return false;
  return /^\d+(-\d+)?(:\d+)?(,\d+(-\d+)?(:\d+)?)*(%\d+)?$/.test(r.trim());
}

/**
 * Parse a memory specification into a value and unit.
 *
 * @param {string} mem - e.g. "32G", "4000M", "1.5T".
 * @returns {{value:number, unit:'M'|'G'|'T'}|null}
 */
export function parseMemory(mem) {
  if (!mem || typeof mem !== 'string') return null;
  const m = mem.trim().match(/^(\d+(?:\.\d+)?)\s*([GMT])B?$/i);
  if (!m) return null;
  return { value: parseFloat(m[1]), unit: m[2].toUpperCase() };
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
  if (!range || typeof range !== 'string') return null;
  const m = range.trim().match(/^(\d+)\s*-\s*(\d+)(?::(\d+))?(?:%(\d+))?/);
  if (!m) {
    // A bare list such as "1,4,9", count the entries.
    const list = range.trim().match(/^(\d+)(,\d+)*(?:%(\d+))?$/);
    if (!list) return null;
    const capMatch = range.match(/%(\d+)/);
    const total = range.split('%')[0].split(',').length;
    const cap = capMatch ? parseInt(capMatch[1], 10) : total;
    return { total, concurrent: Math.min(cap, total) };
  }

  const start = parseInt(m[1], 10);
  const end = parseInt(m[2], 10);
  const step = m[3] ? parseInt(m[3], 10) : 1;
  const cap = m[4] ? parseInt(m[4], 10) : Infinity;

  const total = step > 0 ? Math.floor((end - start) / step) + 1 : 0;
  return { total, concurrent: Math.min(cap, total) };
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

  if (memory) {
    lines.push(`#SBATCH --mem=${memory}`);
  } else {
    warnings.push({
      level: 'warn',
      field: 'memory',
      message: 'No memory requested. Most clusters then apply a small default ' +
               '(often ~1 GB/CPU), which can kill MD jobs. Set a value for --mem.'
    });
  }

  if (isValidWallTime(walltime)) {
    lines.push(`#SBATCH --time=${walltime}`);
  } else {
    lines.push(`#SBATCH --time=${DEFAULT_WALLTIME}`);
    warnings.push({
      level: 'warn',
      field: 'walltime',
      message: `Wall time looks malformed, expected D-HH:MM:SS, HH:MM:SS, or ` +
               `minutes. Substituted ${DEFAULT_WALLTIME}.`
    });
  }

  let effectiveRange = arrayRange;
  if (array) {
    if (isValidArrayRange(arrayRange)) {
      lines.push(`#SBATCH --array=${arrayRange}`);
    } else {
      effectiveRange = DEFAULT_ARRAY_RANGE;
      lines.push(`#SBATCH --array=${DEFAULT_ARRAY_RANGE}`);
      warnings.push({
        level: 'warn',
        field: 'arrayRange',
        message: `Array range looks malformed, expected e.g. 1-10 or 1-100:2. ` +
                 `Substituted ${DEFAULT_ARRAY_RANGE}.`
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
  if (array && memory) {
    const mem = parseMemory(memory);
    const conc = arrayConcurrency(effectiveRange);
    if (mem && conc) {
      const total = mem.value * conc.concurrent;
      warnings.push({
        level: 'warn',
        field: 'arrayMemory',
        message: `Array job: --mem=${memory} is per task. With ${conc.concurrent} ` +
                 `task(s) running concurrently that is ${total}${mem.unit} in flight. ` +
                 `Confirm this fits your partition limit, if not, cap concurrency ` +
                 `in the array range (e.g. 1-${conc.total}%4).`,
        totalMemory: total,
        unit: mem.unit,
        concurrent: conc.concurrent
      });
    }
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

  let cmd = `gmx mdrun -s ${tpr} -deffnm ${deffnm}`;
  cmd += ` -ntomp \${OMP_NUM_THREADS}`;
  if (gpus > 0) cmd += ' -nb gpu -pme gpu -bonded gpu';
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
 * Convert a SLURM wall-time string to hours.
 *
 * @param {string} t
 * @returns {number|null} Hours, or null when the string is unparseable.
 */
export function walltimeToHours(t) {
  if (!isValidWallTime(t)) return null;
  const s = t.trim();

  // Plain minutes.
  if (/^\d+$/.test(s)) return parseInt(s, 10) / 60;

  // MM:SS.
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    const [mm, ss] = s.split(':').map(Number);
    return mm / 60 + ss / 3600;
  }

  // [D-]HH:MM:SS.
  let days = 0;
  let rest = s;
  if (s.includes('-')) {
    const [d, r] = s.split('-');
    days = parseInt(d, 10);
    rest = r;
  }
  const [hh, mm, ss] = rest.split(':').map(Number);
  return days * 24 + hh + mm / 60 + ss / 3600;
}
