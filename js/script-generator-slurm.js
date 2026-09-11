/**
 * Scheduler-header adapter for the MD workflow generator.
 *
 * `script-generator.js` is mostly the PLUMED collective-variable builder and
 * the MDP stage forms, both densely coupled to the DOM. Converting all of it
 * would be a large, hard-to-review change with little benefit, so this module
 * covers only the part with real logic in it: the directive header and its
 * resource warnings. The page reads the form, this module turns it into the
 * configuration object `core/scheduler` takes, and the tested core produces
 * the header. For SLURM the result is byte for byte what the page produced
 * before the core existed.
 *
 * The function keeps the shape of the page's original
 * `buildSlurmHeader(engine, warnings)`: it returns the header text and the
 * array flag, and appends warnings to the caller's array as HTML strings,
 * which is what the page's rendering code expects.
 */

import { buildHeader, DEFAULT_PE } from '../src/core/scheduler.js';
import { validateResources } from '../src/core/slurm.js';

/**
 * Read the job form and build the directive header through the core.
 *
 * @param {'gromacs'|'lammps'} engine
 * @param {string[]} warnings - Mutated in place, as the original did.
 * @param {{$:Function, getStr:Function, getInt:Function, isChecked:Function}} dom
 *        The page's DOM helpers, injected so this module has no direct
 *        dependency on them.
 * @returns {{header:string, isArray:boolean, scheduler:string}}
 */
export function buildHeaderFromDOM(engine, warnings, dom) {
  const { getStr, getInt, isChecked } = dom;

  const isArray = isChecked('jobArrayToggle');
  const scheduler = getStr('jobScheduler', 'slurm');

  const config = {
    scheduler,
    engine,
    jobName: getStr('jobName', 'md_job'),
    partition: isChecked('usePartition') ? getStr('jobPartition', '') : '',
    nodes: getInt('jobNodes', 1),
    gpus: getInt('jobGpus', 0),
    // GROMACS is threaded (CPUs per task); LAMMPS is MPI (tasks per node,
    // optionally with threads on top).
    cpusPerTask: engine === 'gromacs' ? getInt('jobCpus', 1) : getInt('lmpCpus', 1),
    tasksPerNode: getInt('jobTasks', 1),
    walltime: getStr('jobTime', ''),
    memory: getStr('jobMem', ''),
    array: isArray,
    arrayRange: getStr('jobArrayRange', ''),
    mailUser: isChecked('useMail') ? getStr('jobMailUser', '') : '',
    pe: getStr('sgePe', DEFAULT_PE)
  };

  const result = buildHeader(config);
  const resourceWarnings = validateResources(config);

  for (const w of [...result.warnings, ...resourceWarnings]) {
    warnings.push(formatWarning(w));
  }

  // The original warned when mail was enabled without an address; the core
  // simply omits the directive, so that case is reported here.
  if (isChecked('useMail') && !getStr('jobMailUser', '')) {
    warnings.push('Mail notifications enabled but no address given.');
  }

  return { header: result.script, isArray, scheduler };
}

/**
 * Render a structured warning as the HTML the page already styles.
 *
 * Backticked fragments in the core's messages become `<code>` elements, so a
 * directive such as `--mem` is set in monospace as it was before.
 *
 * @param {{level:string, field:string, message:string}} w
 * @returns {string}
 */
function formatWarning(w) {
  const text = escapeHtml(w.message)
    // Directives, sizes, and time formats read better in monospace.
    .replace(/(--[a-z-]+(?:=[^\s.,]+)?)/g, '<code>$1</code>')
    .replace(/\b(\d+-?\d*:\d{2}:\d{2})\b/g, '<code>$1</code>')
    .replace(/\b(\d+-\d+(?::\d+)?(?:%\d+)?)\b/g, '<code>$1</code>');
  return text;
}

/**
 * Escape text for insertion into HTML.
 *
 * The core's messages are plain text and may contain characters that would
 * otherwise be parsed as markup.
 *
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
