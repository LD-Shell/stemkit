/**
 * SLURM header adapter for the HPC Script Generator.
 *
 * `script-generator.js` is 2,855 lines, most of which is the PLUMED
 * collective-variable builder and the MDP stage forms | both densely coupled to
 * the DOM. Rewriting the whole file in one step would be a large, hard-to-review
 * change with little benefit, so this module converts only the part with real
 * logic in it: the `#SBATCH` header and its resource warnings.
 *
 * It exposes a function with the same shape as the original
 * `buildSlurmHeader(engine, warnings)`, so the two existing call sites need no
 * change beyond importing this instead of using the local definition. The
 * header itself, the array-memory arithmetic, and the resource checks now come
 * from the tested core.
 *
 * ## Applying this
 *
 * In `js/script-generator.js`:
 *
 *   1. Add at the top of the file (before `document.addEventListener`):
 *
 *        import { buildSlurmHeaderFromDOM } from './script-generator-slurm.js';
 *
 *   2. Delete the local `function buildSlurmHeader(engine, warnings) { ... }`
 *      (around line 1025 through its closing brace).
 *
 *   3. Add a thin forwarder in its place so the call sites are untouched:
 *
 *        const buildSlurmHeader = (engine, warnings) =>
 *          buildSlurmHeaderFromDOM(engine, warnings, { $, getStr, getInt, isChecked });
 *
 *   4. Add `type="module"` to the script tag in `script-generator.html`.
 *
 * The remaining ~2,700 lines are unchanged and keep working exactly as before.
 */

import {
  buildSlurmHeader as coreBuildSlurmHeader,
  validateResources
} from '../src/core/slurm.js';

/**
 * Read the job form and build the `#SBATCH` header through the core.
 *
 * Warnings are appended to the caller's array as HTML strings, matching what
 * the existing rendering code expects. The core returns structured objects, so
 * they are formatted here rather than in the library.
 *
 * @param {'gromacs'|'lammps'} engine
 * @param {string[]} warnings - Mutated in place, as the original did.
 * @param {{$:Function, getStr:Function, getInt:Function, isChecked:Function}} dom
 *        The existing DOM helpers from script-generator.js, injected so this
 *        module has no direct dependency on them.
 * @returns {{header:string, isArray:boolean}}
 */
export function buildSlurmHeaderFromDOM(engine, warnings, dom) {
  const { getStr, getInt, isChecked } = dom;

  const isArray = isChecked('jobArrayToggle');

  const config = {
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
    mailUser: isChecked('useMail') ? getStr('jobMailUser', '') : ''
  };

  const result = coreBuildSlurmHeader(config);
  const resourceWarnings = validateResources(config);

  for (const w of [...result.warnings, ...resourceWarnings]) {
    warnings.push(formatWarning(w));
  }

  // The original warned when mail was enabled without an address; the core
  // simply omits the directive, so that case is reported here.
  if (isChecked('useMail') && !getStr('jobMailUser', '')) {
    warnings.push('Mail notifications enabled but no address given.');
  }

  return { header: result.script, isArray };
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
