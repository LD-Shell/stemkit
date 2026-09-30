/**
 * @module core/plumed-run
 *
 * The files a PLUMED job needs beside `plumed.dat`: the inputs of every walker
 * or umbrella window, one job script that both starts the run and continues
 * it, a script that queues the segments, and a README.
 *
 * A long biased run is a chain of jobs cut by the wall time, and sometimes by
 * a crash. Continuing it wrongly does not fail: it gives a free-energy surface
 * that looks fine and is not. What each method needs was read from the PLUMED
 * 2.11 source and checked by running PLUMED on a trajectory split at a
 * checkpoint, against the same trajectory in one piece:
 *
 *   - METAD and PBMETAD read their hills back. A hill is never laid on the
 *     first step of a run, so the hill at the checkpoint step is not laid
 *     twice. After a hard kill the files hold hills from past the last
 *     checkpoint; read back, they bias the continued run with hills its own
 *     trajectory never laid (an error of a hill height or more). Trimmed to
 *     the checkpoint, the continued bias is exact.
 *   - A missing hills file stops METAD, but PBMETAD only warns and goes on
 *     with no bias, so the script checks the files itself.
 *   - OPES continued from its kernels file is approximate (18 kJ/mol off in
 *     the test); from STATE_RFILE it is exact, provided the state was written
 *     at the checkpoint. GROMACS tells PLUMED when it checkpoints, so the
 *     state is written then; LAMMPS does not, so the state is written every
 *     `restart` interval of the LAMMPS input.
 *   - With MPI walkers only walker 0 writes the hills and the state. PBMETAD
 *     walkers then need WALKERS_DIR to find them on a restart, or they go on
 *     without them.
 *   - ABMD starts its ratchet again from wherever the variable is unless it
 *     is given MIN, which the script takes from the printed `<label>.<arg>_min`.
 *   - MOVINGRESTRAINT follows the MD step, which a checkpoint keeps, but its
 *     work starts again from zero in each segment.
 *
 * GROMACS passes the time step to PLUMED in single precision, so PLUMED's
 * time runs ahead of the checkpoint's by about 1e-10 ps a step; the script
 * works from the checkpoint's step and PLUMED's own time step instead.
 */

import { generatePlumedInput } from './plumed.js';
import { buildHeader, launcher, envVars, walltimeToSeconds, submitCommand } from './scheduler.js';

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

/** How the simulations of one job are laid out. */
export const RUN_LAYOUTS = Object.freeze({
  single: 'One simulation',
  'walkers-mpi': 'Multiple walkers in one MPI job',
  'walkers-files': 'Multiple walkers as separate jobs',
  windows: 'Umbrella windows as separate jobs'
});

export const RUN_ENGINES = Object.freeze({ gromacs: 'GROMACS', lammps: 'LAMMPS' });

/** Picoseconds per PLUMED time unit. */
const TIME_UNIT_PS = { ps: 1, fs: 0.001, ns: 1000 };

/** Picoseconds per LAMMPS time unit, as fix plumed converts them. */
export const LAMMPS_TIME_PS = Object.freeze({ real: 0.001, metal: 1 });

/**
 * The time step PLUMED is given by GROMACS, which passes it in single
 * precision: 0.002 ps arrives as 0.0020000000949949026.
 *
 * @param {number} dtPs
 * @returns {string}
 */
export function gromacsPlumedTimestep(dtPs) {
  const v = Math.fround(Number(dtPs));
  return Number.isFinite(v) && v > 0 ? String(Number(v.toPrecision(17))) : '';
}

/**
 * How long the MD engine may run before it has to stop and checkpoint, in
 * hours: the wall time less a margin for starting, the checks and the final
 * write. The margin is 3% of the wall time, at least 6 and at most 30 minutes.
 *
 * @param {string} walltime - HH:MM:SS or D-HH:MM:SS.
 * @returns {number|null}
 */
export function runHours(walltime) {
  const s = walltimeToSeconds(walltime);
  if (!(s > 0)) return null;
  const h = s / 3600;
  const margin = Math.min(0.5, Math.max(0.1, 0.03 * h));
  return Math.max(0.05, Math.floor((h - margin) * 100) / 100);
}

function hms(hours) {
  const total = Math.round(hours * 3600);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * The name PLUMED gives a file in replica `i` of a multi-replica run: the
 * number goes before an extension of one to four characters, or at the end.
 *
 * @param {string} file
 * @param {number} i
 * @returns {string}
 */
export function replicaFile(file, i) {
  const n = file.lastIndexOf('.');
  if (n > 0 && n + 1 < file.length && n + 5 >= file.length) {
    const ext = file.slice(n + 1);
    const base = file.slice(0, n);
    if (!ext.includes('/') && !base.endsWith('/')) return `${base}.${i}.${ext}`;
  }
  return `${file}.${i}`;
}

/**
 * The umbrella centres: `count` values spread evenly from `from` to `to`.
 *
 * @param {number|string} from
 * @param {number|string} to
 * @param {number|string} count
 * @returns {string[]}
 */
export function windowCentres(from, to, count) {
  const a = Number(from);
  const b = Number(to);
  const n = Math.max(1, Math.floor(Number(count)) || 1);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return [];
  if (n === 1) return [String(a)];
  const step = (b - a) / (n - 1);
  const digits = Math.max(0, Math.min(6, 2 - Math.floor(Math.log10(Math.abs(step) || 1))));
  return Array.from({ length: n }, (_, i) => String(Number((a + i * step).toFixed(digits))));
}

/* ------------------------------------------------------------------ *
 * What each method reads back
 * ------------------------------------------------------------------ */

/**
 * The files PLUMED reads back when a run continues, per method.
 *
 * @param {object} bias - `config.bias` of generatePlumedInput.
 * @param {{targets:string[], label:string}} info
 * @returns {{hills:string[], state:string[], kernels:string[], abmd:null|
 *   {label:string, columns:string[]}, pace:number, notes:string[]}}
 */
export function restartNeeds(bias, info) {
  const method = str(bias && bias.method) || 'none';
  const p = (bias && bias.params) || {};
  const pace = parseInt(str(p.PACE) || str(bias && bias.stride) || '500', 10) || 500;
  const out = { hills: [], state: [], kernels: [], abmd: null, pace, notes: [] };
  switch (method) {
    case 'metad':
    case 'wt_metad':
      out.hills = [str(p.FILE) || 'HILLS'];
      break;
    case 'pbmetad':
      out.hills = info.targets.map(a => `HILLS.${a.replace(/[^A-Za-z0-9_-]/g, '_')}`);
      break;
    case 'opes':
      out.state = ['State.data'];
      out.kernels = [str(p.FILE) || 'Kernels.data'];
      break;
    case 'abmd':
      out.abmd = { label: info.label || 'abmd', columns: info.targets.map(a => `${info.label || 'abmd'}.${a}_min`) };
      break;
    case 'moving':
      out.notes.push('MOVINGRESTRAINT follows the MD step, which the checkpoint keeps, so the ' +
        'restraint carries on where it was. Its work starts again from zero in each segment: ' +
        '`analyse_plumed.py work` adds the segments up.');
      break;
    default:
      break;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

function inputFor(plumed, changes) {
  const bias = { ...(plumed.bias || {}), ...(changes.bias || {}) };
  const preamble = { ...(plumed.preamble || {}), restart: false };
  if (changes.flush) preamble.flush = changes.flush;
  return generatePlumedInput({ ...plumed, preamble, bias });
}

/* ------------------------------------------------------------------ *
 * The job script
 * ------------------------------------------------------------------ */

const q = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;

/* Functions every job script shares. Written once, tested on real runs. */
const COMMON_FUNCTIONS = String.raw`log() { printf '%s  %s\n' "$(date '+%F %T')" "$*"; }
die() { printf '%s  STOP: %s\n' "$(date '+%F %T')" "$*" >&2; exit 1; }

# The last time in a PLUMED file, or nothing when it holds no rows.
last_time() {
  awk '/^#/ || NF < 2 { next } $1 ~ /^[-+0-9.eE]+$/ { t = $1 } END { if (t != "") print t }' "$1"
}

# trim FILE TIME le|lt: keep the rows up to TIME (le) or before it (lt), and
# drop a row cut off mid-write. A changed file's old copy goes to $BACKUP.
trim() {
  [ -s "$1" ] || return 0
  awk -v t="$2" -v mode="$3" -v tol="$TOL" '
    /^#! FIELDS/ { n = NF - 2; print; next }
    /^#/ { print; next }
    (n && NF != n) || $1 !~ /^[-+0-9.eE]+$/ { cut++; next }
    ($1 + 0 < t - tol) || (mode == "le" && $1 + 0 <= t + tol) { print; next }
    { late++ }
    END { if (late + cut) printf "  %s: %d row(s) at or past the checkpoint and %d cut off taken out\n", FILENAME, late, cut > "/dev/stderr" }
  ' "$1" > "$1.trim" || die "could not trim $1"
  if cmp -s "$1" "$1.trim"; then rm -f "$1.trim"; return 0; fi
  mkdir -p "$BACKUP/$(dirname "$1")"
  cp -p "$1" "$BACKUP/$1" && mv "$1.trim" "$1"
}

# A file PLUMED reads back must be there, whole, and reach the checkpoint.
# need_file FILE EXPECT: EXPECT is 1 when rows must exist by now.
need_file() {
  if [ ! -s "$1" ]; then
    if [ "$2" = 1 ]; then
      die "$1 is missing or empty, so the bias built up so far would be lost (PBMETAD goes on without it, and says so only in its log). Restore it from $BACKUP_ROOT or a copy, then submit again."
    fi
    : > "$1"   # nothing laid yet: an empty file reads as no hills
    return 0
  fi
  local last
  last=$(last_time "$1")
  if [ "$2" = 1 ] && [ -n "$last" ] && awk -v a="$last" -v t="$T" -v g="$GAP" 'BEGIN { exit !(a + g < t) }'; then
    die "$1 ends at time $last, but the checkpoint is at $T: hills laid after $last are missing, and the run would go on with less bias than it built. Restore the file, then submit again."
  fi
}

# OPES reads its whole state back, and the state must belong to the checkpoint
# the run continues from: its kernel counter is one more than the kernels laid
# by then. PLUMED writes the state when it hears of a checkpoint, before the
# engine has finished writing it, so a job that stops in between leaves a state
# one checkpoint newer than the checkpoint; one that stops while PLUMED writes
# leaves a state cut off. PLUMED keeps the state before as bck.last.State.data.
# Every pair of state and checkpoint is tried, newest first.
whole() { [ -s "$1" ] && grep -q '^#! FIELDS' "$1" && [ "$(tail -c 1 "$1" | od -An -c | tr -d ' ')" = '\n' ]; }
state_counter() { awk '$1 == "#!" && $2 == "SET" && $3 == "counter" { print $4; exit }' "$1"; }
rows_upto() { awk -v t="$2" -v tol="$TOL" '/^#/ || NF < 2 { next } $1 + 0 <= t + tol { n++ } END { print n + 0 }' "$1"; }
time_of() { awk -v s="$1" -v dt="$PLUMED_DT" -v u="$TIME_UNIT" 'BEGIN { printf "%.9f", s * dt / u }'; }
settle_state() {
  local state=$1 kern=$2 prev c s k=0 f
  prev="$(dirname "$state")/bck.last.$(basename "$state")"
  for s in $(candidates); do
    k=$(rows_upto "$kern" "$(time_of "$s")")
    for f in "$state" "$prev"; do
      whole "$f" || continue
      c=$(state_counter "$f")
      if [ -z "$c" ]; then
        log "  $f has no kernel counter, so its match with the checkpoint cannot be checked."
      elif [ "$k" -ne $((c - 1)) ]; then
        continue
      fi
      if [ "$f" != "$state" ]; then
        log "  $state does not belong to the checkpoint (the job stopped while the state or the checkpoint was being written); using PLUMED's previous state, which does."
        mkdir -p "$BACKUP_ROOT/state"
        cp -p "$state" "$BACKUP_ROOT/state/" 2>/dev/null || true
        cp -p "$f" "$state"
      fi
      use_step "$s"
      return 0
    done
  done
  die "No OPES state here matches a checkpoint (the newest state holds $(( $(state_counter "$state" 2>/dev/null || echo 1) - 1 )) kernels; $kern has $k up to the oldest checkpoint). Restore a State.data and checkpoint written together, then submit again."
}

# ABMD: the ratchet's position <label>.<arg>_min at time $3, from ABMD_MIN,
# which PLUMED prints at full precision at every step a checkpoint can fall on.
abmd_min() {
  awk -v want="$2" -v t="$3" -v tol="$TOL" '
    /^#! FIELDS/ { delete c; for (i = 3; i <= NF; i++) c[$i] = i - 2; next }
    /^#/ || NF < 2 { next }
    { d = $1 - t; if (d < 0) d = -d; if (d > tol) next
      split(want, w, ","); v = ""; ok = 1
      for (k = 1; k in w; k++) { if (!(w[k] in c)) { ok = 0; break } v = v (k > 1 ? "," : "") $(c[w[k]]) }
      if (ok) last = v }
    END { if (last != "") print last }
  ' "$1"
}
# The newest checkpoint whose ratchet position was printed. Without it ABMD
# would start its ratchet again from wherever the variable is.
settle_abmd() {
  local s v
  for s in $(candidates); do
    v=$(abmd_min "$1" "$2" "$(time_of "$s")")
    if [ -n "$v" ]; then use_step "$s"; MIN=$v; return 0; fi
  done
  if [ "$ABMD_RESET" = 1 ]; then
    MIN=""; log "  WARNING: no ratchet position for any checkpoint; ABMD starts again from the current value (ABMD_RESET=1)."
    return 0
  fi
  die "$1 has no ratchet position for any checkpoint, so ABMD would start again from wherever the variable is. Restore $1, or set ABMD_RESET=1 to accept that, then submit again."
}

# Keep the three newest backups.
prune_backups() {
  [ -d "$BACKUP_ROOT" ] || return 0
  { ls -d "$BACKUP_ROOT"/step* 2>/dev/null | sort -V | head -n -3 | while read -r old; do rm -rf -- "$old"; done; } || true
}`;

function scriptHeader(o, title) {
  const cfg = { ...o.scheduler, engine: o.engine };
  const header = buildHeader(cfg);
  const lines = [header.script.replace(/\n+$/, ''), ''];
  lines.push('# ==================================================================');
  lines.push(`# ${title}  -  generated by stemkit.net`);
  lines.push('# The same script starts the run and continues it. Submit it again');
  lines.push('# (chain.sh queues several) until it reports that the run is complete.');
  lines.push('# What it checks before continuing is in README.md.');
  lines.push('# ==================================================================');
  lines.push('set -o pipefail');
  return { lines, warnings: header.warnings || [] };
}

function envLines(o) {
  const sch = o.scheduler.scheduler || 'slurm';
  const env = envVars(sch);
  const out = ['', '# --- Environment ---'];
  if (sch === 'pbs') out.push('cd "$PBS_O_WORKDIR"');
  else if (sch === 'lsf') out.push('cd "$LS_SUBCWD"');
  out.push('mkdir -p logs');
  out.push(`module load ${o.engine === 'lammps' ? 'lammps' : 'gromacs'}   # adjust to your cluster; the build must include PLUMED`);
  out.push('# A build patched in runtime mode finds PLUMED here:');
  out.push('# export PLUMED_KERNEL=/path/to/libplumedKernel.so');
  if (sch === 'slurm') out.push(`export OMP_NUM_THREADS=\${${env.cpusPerTask}:-1}`);
  else out.push(`export OMP_NUM_THREADS=${Math.max(1, parseInt(o.scheduler.cpusPerTask, 10) || 1)}`);
  return out;
}

function assign(name, value, comment) {
  const v = typeof value === 'number' ? String(value) : q(value);
  return comment ? `${`${name}=${v}`.padEnd(34)}# ${comment}` : `${name}=${v}`;
}

/* The directory a per-directory job works in: "." or the array task's. */
function runDirLines(o) {
  if (o.layout === 'single') return [assign('RUN_DIR', '.', 'where the tpr, plumed.dat and the outputs are')];
  const idx = envVars(o.scheduler.scheduler || 'slurm').arrayIndex;
  return [
    `# Array task k (1 to ${o.count}) runs directory ${o.prefix}$((k-1)); "bash job.sh k" runs one by hand.`,
    `TASK=\${${idx}:-\${1:-}}`,
    `[ -n "$TASK" ] || { echo "Give the task number: bash job.sh 1 (to ${o.count})" >&2; exit 1; }`,
    `RUN_DIR="${o.prefix}$((TASK - 1))"`
  ];
}

function settingLines(o, needs) {
  const L = [];
  const gap = (needs.pace * o.dtPs * 1.5) / o.timeUnitPs;
  const tol = Math.max((0.5 * o.dtPs) / o.timeUnitPs, 1e-6);
  L.push('', '# --- Settings ---');
  if (o.engine === 'gromacs') {
    L.push(assign('GMX', o.gmx.binary, 'GROMACS built with PLUMED'));
    L.push(assign('GMX_DUMP', o.gmx.binary, 'runs gmx dump; where an MPI build must run under srun, "srun -n 1 gmx_mpi" or a serial gmx'));
    L.push(assign('DEFFNM', o.gmx.deffnm, `each run directory holds ${o.gmx.deffnm}.tpr`));
    L.push(assign('MAXH', o.hours, 'mdrun stops itself and checkpoints before the wall time'));
    L.push(assign('MDRUN_EXTRA', o.gmx.extra || '', 'more mdrun options, e.g. -nb gpu'));
    L.push(assign('PLUMED_DT', o.plumedDt, 'ps per step as PLUMED has it (GROMACS passes it in single precision)'));
  } else {
    L.push(assign('LMP', o.lmp.binary, 'LAMMPS built with the PLUMED package'));
    L.push(assign('LMP_IN', o.lmp.input, 'your input, with the lines README.md lists'));
    L.push(assign('TOTAL_STEPS', o.lmp.totalSteps, 'the step the whole run ends at'));
    L.push(assign('RESTART_EVERY', o.lmp.restartEvery, 'steps between restart files (and OPES states)'));
    L.push(assign('TIME_LIMIT', o.timeLimit, 'LAMMPS stops itself before the wall time'));
    L.push(assign('PLUMED_DT', o.plumedDt, `ps per step: timestep ${o.lmp.timestep} in ${o.lmp.units} units`));
  }
  if (chunked(o, needs)) {
    L.push(assign('CHUNK', o.chunk, `steps per mdrun chunk; ${needs.state.length ? 'the OPES state is' : 'the ABMD ratchet position is'} written at the end of each`));
    L.push(assign('WALL_SECONDS', o.wallSeconds, 'the wall time of the job'));
    L.push(assign('MARGIN', Math.round((o.wallSeconds / 3600 - o.hours) * 3600), 'seconds kept free at the end'));
    L.push(assign('MIN_LEFT', 60, 'no chunk starts with less wall time than this, in seconds'));
  }
  L.push(assign('TIME_UNIT', o.timeUnitPs, 'ps per PLUMED time unit (UNITS TIME)'));
  L.push(assign('PLUMED_DAT', 'plumed.dat', 'the input of a new run; a continued one gets RESTART added'));
  L.push(assign('GAP', Number(gap.toPrecision(6)), 'the hills files must reach this close to the checkpoint'));
  L.push(assign('TOL', Number(tol.toPrecision(6)), 'half a step, in PLUMED time'));
  return L;
}

/* Per-directory lists of the files a continued run reads back and trims. */
function filePlan(o, needs, dirIndex) {
  const multi = o.layout === 'walkers-mpi';
  const lammpsMulti = multi && o.engine === 'lammps';
  const prints = o.prints.map(f => (multi ? replicaFile(f, dirIndex) : f));
  let hillsHome = '.';
  if (o.layout === 'walkers-files') hillsHome = '../hills';
  else if (multi && !lammpsMulti) hillsHome = '../w0';
  const hills = [];
  if (o.layout === 'walkers-files') {
    // One file per walker in the shared directory; PBMETAD files per variable.
    for (let w = 0; w < o.count; w++) for (const h of needs.hills) hills.push(`${h}.${w}`);
  } else hills.push(...needs.hills);
  return { prints, hills, hillsHome, state: needs.state, kernels: needs.kernels };
}

function prepareLines(o, needs, plan, dir, indent) {
  const I = indent;
  const L = [];
  const at = (f, home = '.') => (home === '.' ? f : `${home}/${f}`);
  const expected = `$(( STEP / ${needs.pace} > 0 ? 1 : 0 ))`;
  // Walker 0 of an MPI job keeps the files every walker reads.
  const ownsShared = o.layout !== 'walkers-mpi' || dir === 0 || o.engine === 'lammps';
  // Under -multidir the job is inside w0 here, where the shared files are.
  const home = o.layout === 'walkers-mpi' && o.engine === 'gromacs' ? '.' : plan.hillsHome;
  if (o.layout === 'walkers-files') {
    L.push(`${I}# Every walker's hills file must exist before any walker reads them all.`);
    L.push(`${I}mkdir -p ${plan.hillsHome}`);
    L.push(`${I}for f in ${plan.hills.map(h => at(h, plan.hillsHome)).join(' ')}; do [ -e "$f" ] || : > "$f"; done`);
  } else if (plan.hills.length && ownsShared) {
    for (const h of plan.hills) L.push(`${I}need_file ${at(h, home)} ${expected}`);
    for (const h of plan.hills) L.push(`${I}trim ${at(h, home)} "$T" le`);
  }
  if (plan.kernels.length && ownsShared) {
    for (const k of plan.kernels) L.push(`${I}trim ${k} "$T" le`);
  }
  // A printed row at the checkpoint time is written again by the continued
  // run, so it goes; the ABMD ratchet position at that time stays, since it
  // is the only record of it if the job stops before printing it again.
  for (const p of plan.prints) L.push(`${I}trim ${p} "$T" ${p === ABMD_FILE ? 'le' : 'lt'}`);
  return L;
}

function restartInputLines(o, needs, I) {
  const L = [];
  if (needs.abmd) {
    L.push(`${I}if [ -n "$MIN" ]; then`);
    L.push(`${I}  log "  ABMD carries on from MIN=$MIN."`);
    L.push(`${I}  { echo RESTART; sed -E "/^${needs.abmd.label}:[[:space:]]+ABMD[[:space:]]/{ s/[[:space:]]MIN=[^[:space:]]+//; s/[[:space:]]*\\$/ MIN=$MIN/; }" "$PLUMED_DAT"; } > plumed.restart.dat`);
    L.push(`${I}else`);
    L.push(`${I}  { echo RESTART; cat "$PLUMED_DAT"; } > plumed.restart.dat`);
    L.push(`${I}fi`);
  } else {
    L.push(`${I}{ echo RESTART; cat "$PLUMED_DAT"; } > plumed.restart.dat`);
  }
  return L;
}

function freshGuardLines(o, plan, I) {
  // Outputs without a checkpoint mean the checkpoint was lost: starting again
  // would set the bias aside and begin from nothing.
  const own = [...(o.layout === 'walkers-files' ? [] : plan.hills), ...plan.state, ...plan.prints];
  if (!own.length) return [];
  return [
    `${I}for f in ${own.join(' ')}; do`,
    `${I}  [ -s "$f" ] && die "$WHERE: $f exists but there is no checkpoint, which usually means the checkpoint was lost. Starting again would put the bias aside and begin from nothing. Restore the checkpoint, or move the old files away to start again."`,
    `${I}done`
  ];
}

const GMX_TOOLS = [
  '# gmx dump reads the step of a checkpoint and the length of the run.',
  'cpt_step() { { $GMX_DUMP dump -cp "$1" 2>/dev/null | awk \'$1 == "step" && $2 == "=" { print $3; exit }\'; } || true; }',
  'tpr_nsteps() { { $GMX_DUMP dump -s "$1" 2>/dev/null | awk \'$1 == "nsteps" && $2 == "=" { print $3; exit }\'; } || true; }'
];

/* OPES and ABMD on GROMACS run in chunks. OPES must continue from the state
   written at the step of the checkpoint, and ABMD from the ratchet position
   printed then. GROMACS checkpoints by wall-clock time, and
   GROMACS 2025 never clears PLUMED's checkpoint flag once set, so that OPES
   then writes its state at every deposition and the state of a checkpoint is
   soon overwritten. Running mdrun for a fixed number of steps at a time, with
   the state written every chunk (STATE_WSTRIDE) and no periodic checkpoints,
   puts every checkpoint on a step where the state was written. */
const chunked = (o, needs) => o.engine === 'gromacs' && (needs.state.length > 0 || !!needs.abmd);

/* The file ABMD's ratchet position is printed to, at full precision. */
const ABMD_FILE = 'ABMD_MIN';

/* The body of "continue from the checkpoint", shared by the first continuation
   of a job and the steps between chunks. Sets STEP, T and INPUT. */
function continueFunction(o, needs) {
  const L = ['continue_run() {'];
  if (o.layout === 'walkers-mpi') {
    L.push(...settleLines(o, needs, '  ', o.engine === 'gromacs' ? 'w0' : ''));
    L.push('  T=$(time_of "$STEP")');
    L.push('  log "Continuing all walkers from step $STEP (PLUMED time $T)."');
    if (o.engine === 'gromacs') {
      for (let i = 0; i < o.count; i++) {
        const plan = filePlan(o, needs, i);
        L.push(`  cd "$BASE/${o.prefix}${i}"; BACKUP="$BACKUP_ROOT/step$STEP"`);
        L.push(...prepareLines(o, needs, plan, i, '  '));
        L.push(...restartInputLines(o, needs, '  '));
        L.push('  prune_backups');
      }
      L.push('  cd "$BASE"');
    } else {
      L.push('  BACKUP="$BACKUP_ROOT/step$STEP"');
      const plan = filePlan(o, needs, 0);
      L.push(...prepareLines(o, needs, { ...plan, prints: [] }, 0, '  '));
      for (let i = 0; i < o.count; i++) for (const p of o.prints) L.push(`  trim ${replicaFile(p, i)} "$T" lt`);
      L.push(...restartInputLines(o, needs, '  '));
      L.push('  prune_backups');
      L.push('  prune_restarts');
    }
  } else {
    const plan = filePlan(o, needs, 0);
    L.push(...settleLines(o, needs, '  '));
    L.push('  T=$(time_of "$STEP")');
    L.push('  BACKUP="$BACKUP_ROOT/step$STEP"');
    L.push('  log "Continuing $WHERE from step $STEP (PLUMED time $T)."');
    L.push(...prepareLines(o, needs, plan, 0, '  '));
    L.push(...restartInputLines(o, needs, '  '));
    L.push('  prune_backups');
    if (o.engine === 'lammps') L.push('  prune_restarts');
  }
  L.push('  INPUT=plumed.restart.dat');
  L.push('}');
  return L;
}

/* One run of the engine, from the current checkpoint. Extra mdrun options
   (the chunk length) come as arguments. */
function engineFunction(o) {
  const sch = o.scheduler.scheduler || 'slurm';
  const L = ['run_engine() {'];
  if (o.engine === 'gromacs') {
    const multi = o.layout === 'walkers-mpi';
    const launch = multi || /_mpi$/.test(o.gmx.binary) ? `${launcher(sch, { cpusPerTask: o.scheduler.cpusPerTask })} ` : '';
    const where = multi ? '-multidir $DIRS ' : '';
    L.push(`  ${launch}"$GMX" mdrun ${where}-deffnm "$DEFFNM" -cpi "$DEFFNM.cpt" -plumed "$INPUT" $MDRUN_EXTRA -ntomp "$OMP_NUM_THREADS" "$@"`);
  } else if (o.layout === 'walkers-mpi') {
    L.push(`  ${launcher(sch, {})} "$LMP" -partition "\${NW}x\${RANKS_PER_WALKER:-1}" -in "$LMP_IN" -var rstep "\${STEP:--1}" -var plumed_in "$INPUT" -var time_limit "$TIME_LIMIT" -var restart_every "$RESTART_EVERY" -var total_steps "$TOTAL_STEPS"`);
  } else {
    L.push(`  ${launcher(sch, {})} "$LMP" -in "$LMP_IN" -var rstep "\${STEP:--1}" -var plumed_in "$INPUT" -var time_limit "$TIME_LIMIT" -var restart_every "$RESTART_EVERY" -var total_steps "$TOTAL_STEPS"`);
  }
  L.push('}');
  return L;
}

/* Run to the end of the job: once, or chunk by chunk for OPES on GROMACS. */
function runLines(o, needs) {
  const L = ['', '# --- Run ---'];
  const multi = o.layout === 'walkers-mpi';
  const cpt = multi ? 'w0/$DEFFNM.cpt' : '$DEFFNM.cpt';
  const tpr = multi ? 'w0/$DEFFNM.tpr' : '$DEFFNM.tpr';
  const done = multi && o.engine === 'gromacs' ? 'w0/RUN_COMPLETE' : 'RUN_COMPLETE';
  const failed = o.engine === 'gromacs'
    ? `die "mdrun stopped with status $status. Read ${multi ? 'w0/' : ''}$DEFFNM.log. Submitting again continues from the last checkpoint."`
    : 'die "LAMMPS stopped with status $status. Read its log. Submitting again continues from the newest restart files."';
  if (chunked(o, needs)) {
    L.push('# mdrun runs to the next multiple of CHUNK steps at a time; see README.md.');
    L.push('LONGEST=0');
    L.push('while :; do');
    L.push(`  STEP=$(cpt_step "${cpt}"); STEP=\${STEP:-0}; NSTEPS=$(tpr_nsteps "${tpr}")`);
    L.push('  if [ -n "$NSTEPS" ] && [ "$NSTEPS" -ge 0 ] && [ "$STEP" -ge "$NSTEPS" ]; then break; fi');
    L.push('  n=$(( (STEP / CHUNK + 1) * CHUNK - STEP ))');
    L.push('  [ -n "$NSTEPS" ] && [ "$NSTEPS" -ge 0 ] && [ $((STEP + n)) -gt "$NSTEPS" ] && n=$((NSTEPS - STEP))');
    L.push('  left=$(( WALL_SECONDS - ($(date +%s) - JOB_START) - MARGIN ))');
    L.push('  if [ "$LONGEST" -gt 0 ] && [ "$left" -lt $(( LONGEST * 3 / 2 )) ]; then');
    L.push('    log "Not enough wall time left for another chunk ($left s left, the longest took $LONGEST s)."');
    L.push('    break');
    L.push('  fi');
    L.push('  [ "$left" -gt "$MIN_LEFT" ] || { log "Less than $MIN_LEFT s of wall time left; no new chunk."; break; }');
    L.push('  t0=$(date +%s)');
    L.push('  set +e');
    L.push('  run_engine -nsteps "$n" -cpt 1000000 -maxh "$(awk -v s="$left" \'BEGIN { printf "%.4f", s / 3600 }\')"');
    L.push('  status=$?');
    L.push('  set -e');
    L.push(`  [ "$status" -eq 0 ] || ${failed}`);
    L.push('  t=$(( $(date +%s) - t0 )); [ "$t" -gt "$LONGEST" ] && LONGEST=$t');
    L.push(`  STEP=$(cpt_step "${cpt}")`);
    L.push('  # The next chunk continues this one, unless the run is complete.');
    L.push('  if [ -n "$NSTEPS" ] && [ "$NSTEPS" -ge 0 ] && [ "${STEP:-0}" -ge "$NSTEPS" ]; then break; fi');
    L.push('  continue_run');
    L.push('done');
    L.push(`STEP=$(cpt_step "${cpt}"); NSTEPS=$(tpr_nsteps "${tpr}")`);
  } else {
    L.push('set +e');
    L.push(o.engine === 'gromacs' ? 'run_engine -maxh "$MAXH"' : 'run_engine');
    L.push('status=$?');
    L.push('set -e');
    L.push(`[ "$status" -eq 0 ] || ${failed}`);
    if (o.engine === 'gromacs') L.push(`STEP=$(cpt_step "${cpt}"); NSTEPS=$(tpr_nsteps "${tpr}")`);
    else L.push('STEP=$(restart_steps | head -n 1); NSTEPS=$TOTAL_STEPS; prune_restarts');
  }
  L.push('if [ -n "$STEP" ] && [ -n "$NSTEPS" ] && [ "$NSTEPS" -ge 0 ] && [ "$STEP" -ge "$NSTEPS" ]; then');
  L.push(`  touch ${done}; log "$WHERE is complete: step $STEP of $NSTEPS."`);
  L.push('else');
  L.push('  log "$WHERE stopped at step ${STEP:-?} of ${NSTEPS:-?}. Submit again to continue."');
  L.push('fi');
  return L;
}

/* OPES: settle the state before the time of the checkpoint is fixed. */
function settleLines(o, needs, I, where = '') {
  const at = (f) => (where ? `${where}/${f}` : f);
  const L = [];
  if (needs.state.length) L.push(`${I}WHAT="the OPES state"; settle_state ${at(needs.state[0])} ${at(needs.kernels[0])}`);
  if (needs.abmd) L.push(`${I}WHAT="the ABMD ratchet position"; settle_abmd ${at(ABMD_FILE)} ${q(needs.abmd.columns.join(','))}`);
  return L;
}

const LOCK_LINES = [
  '# One job at a time per run: a second one would trim files the first is writing.',
  'if command -v flock >/dev/null 2>&1; then',
  '  exec 9> .plumed-job.lock',
  '  flock -n 9 || die "another job is working here (it holds .plumed-job.lock). Two jobs on one run would corrupt its files; wait for that one to end."',
  'fi'
];

/* GROMACS or LAMMPS: one simulation in RUN_DIR (single, separate walkers, windows). */
function perDirectoryBody(o, needs) {
  const plan = filePlan(o, needs, 0);
  const L = [];
  L.push('', '# --- Start or continue ---');
  L.push('JOB_START=$(date +%s)');
  L.push('cd "$RUN_DIR" || die "there is no directory $RUN_DIR"');
  L.push(o.layout === 'single' ? 'WHERE="the run"' : 'WHERE="$RUN_DIR"');
  L.push(...LOCK_LINES);
  L.push('BACKUP_ROOT=backup');
  L.push('[ -f RUN_COMPLETE ] && { log "$WHERE is complete (RUN_COMPLETE). Nothing to do."; exit 0; }');
  L.push('[ -f "$PLUMED_DAT" ] || die "$WHERE: $PLUMED_DAT is missing."');
  L.push('grep -Eq \'^[[:space:]]*RESTART([[:space:]]|$)\' "$PLUMED_DAT" && die "$PLUMED_DAT contains RESTART: take it out. This script adds it when the run continues, and a new run with it stops at the first file it cannot find."');
  if (o.engine === 'gromacs') {
    L.push('[ -f "$DEFFNM.tpr" ] || die "$WHERE: $DEFFNM.tpr is missing; make it with gmx grompp first."');
    L.push(...GMX_TOOLS);
    L.push('CPT="$DEFFNM.cpt"; CPT_PREV="${DEFFNM}_prev.cpt"');
    L.push('# The checkpoints a continued run may start from, newest first.');
    L.push('candidates() { echo "$STEP"; p=$(cpt_step "$CPT_PREV"); [ -f "$CPT_PREV" ] && [ -n "$p" ] && echo "$p"; true; }');
    L.push('use_step() {');
    L.push('  [ "$1" = "$STEP" ] && return 0');
    L.push('  log "  Going back to the checkpoint before the last (step $1), which $WHAT belongs to."');
    L.push('  mkdir -p "$BACKUP_ROOT/rollback"; cp -p "$CPT" "$BACKUP_ROOT/rollback/"; cp -p "$CPT_PREV" "$CPT"');
    L.push('  STEP=$1');
    L.push('}');
  } else {
    L.push('# The restart files LAMMPS wrote (restart.<step>), newest first.');
    L.push('restart_steps() { { ls restart.* 2>/dev/null | sed -n \'s/^restart\\.\\([0-9][0-9]*\\)$/\\1/p\' | sort -rn; } || true; }');
    L.push('candidates() { restart_steps; }');
    L.push('use_step() {');
    L.push('  [ "$1" = "$STEP" ] && return 0');
    L.push('  log "  Going back to restart.$1, which $WHAT belongs to."');
    L.push('  mkdir -p "$BACKUP_ROOT/rollback"');
    L.push('  for s in $(restart_steps); do [ "$s" -gt "$1" ] && mv "restart.$s" "$BACKUP_ROOT/rollback/"; done');
    L.push('  STEP=$1');
    L.push('}');
    L.push('# Keep the three newest restart files.');
    L.push('prune_restarts() { { restart_steps | tail -n +4 | while read -r s; do rm -f -- "restart.$s"; done; } || true; }');
  }
  L.push(...continueFunction(o, needs));
  L.push(...engineFunction(o));
  if (o.engine === 'gromacs') {
    L.push('if [ -f "$CPT" ]; then');
    L.push('  STEP=$(cpt_step "$CPT")');
    L.push('  [ -n "$STEP" ] || die "cannot read the step of $CPT with gmx dump; set GMX_DUMP to the GROMACS that wrote it."');
  } else {
    L.push('STEP=$(restart_steps | head -n 1)');
    L.push('if [ -n "$STEP" ]; then');
  }
  L.push('  continue_run');
  L.push('else');
  L.push(...freshGuardLines(o, plan, '  '));
  if (o.layout === 'walkers-files') {
    // Separate walkers always run with RESTART on files that exist, so that no
    // walker ever puts aside a file another walker is reading.
    L.push('  mkdir -p ../hills');
    L.push(`  for f in ${plan.hills.map(h => `../hills/${h}`).join(' ')}; do [ -e "$f" ] || : > "$f"; done`);
    L.push('  { echo RESTART; cat "$PLUMED_DAT"; } > plumed.restart.dat');
    L.push('  INPUT=plumed.restart.dat');
  } else {
    L.push('  INPUT="$PLUMED_DAT"');
  }
  L.push('  log "Starting $WHERE."');
  L.push('fi');
  L.push(...runLines(o, needs));
  return L;
}

/* Walkers in one MPI job: GROMACS -multidir, or LAMMPS -partition. */
function multiBody(o, needs) {
  const L = [];
  const dirs = Array.from({ length: o.count }, (_, i) => `${o.prefix}${i}`);
  L.push('', '# --- Start or continue ---');
  L.push('JOB_START=$(date +%s)');
  L.push('BASE=$PWD');
  L.push('WHERE="The run"');
  L.push(...LOCK_LINES);
  L.push('BACKUP_ROOT=backup');
  if (o.engine === 'gromacs') {
    L.push(assign('DIRS', dirs.join(' '), 'one directory per walker; walker 0 keeps the shared files'));
    L.push('[ -f w0/RUN_COMPLETE ] && { log "The run is complete (w0/RUN_COMPLETE). Nothing to do."; exit 0; }');
    L.push(...GMX_TOOLS);
    L.push('have=0; STEP=""');
    L.push('for d in $DIRS; do');
    L.push('  [ -f "$d/$DEFFNM.tpr" ] || die "$d/$DEFFNM.tpr is missing: make one tpr per walker with gmx grompp first."');
    L.push('  [ -f "$d/$PLUMED_DAT" ] || die "$d/$PLUMED_DAT is missing."');
    L.push('  grep -Eq \'^[[:space:]]*RESTART([[:space:]]|$)\' "$d/$PLUMED_DAT" && die "$d/$PLUMED_DAT contains RESTART: take it out; this script adds it when the run continues."');
    L.push('  if [ -f "$d/$DEFFNM.cpt" ]; then');
    L.push('    have=$((have + 1)); s=$(cpt_step "$d/$DEFFNM.cpt")');
    L.push('    [ -n "$s" ] || die "cannot read the step of $d/$DEFFNM.cpt with gmx dump; set GMX_DUMP to the GROMACS that wrote it."');
    L.push('    [ -z "$STEP" ] || [ "$s" = "$STEP" ] || die "the walkers\' checkpoints are at different steps ($STEP and $s in $d). -multidir writes them together, so one was restored or copied from elsewhere; put back a matching set."');
    L.push('    STEP=$s');
    L.push('  fi');
    L.push('done');
    L.push(`N=${o.count}`);
    L.push('# The checkpoints the walkers may continue from together, newest first.');
    L.push('candidates() {');
    L.push('  echo "$STEP"');
    L.push('  local prev="" s d');
    L.push('  for d in $DIRS; do');
    L.push('    [ -f "$d/${DEFFNM}_prev.cpt" ] || return 0');
    L.push('    s=$(cpt_step "$d/${DEFFNM}_prev.cpt")');
    L.push('    { [ -n "$s" ] && { [ -z "$prev" ] || [ "$s" = "$prev" ]; }; } || return 0');
    L.push('    prev=$s');
    L.push('  done');
    L.push('  echo "$prev"');
    L.push('}');
    L.push('use_step() {');
    L.push('  [ "$1" = "$STEP" ] && return 0');
    L.push('  log "  Every walker goes back to the checkpoints before the last (step $1), which $WHAT belongs to."');
    L.push('  for d in $DIRS; do');
    L.push('    mkdir -p "$d/$BACKUP_ROOT/rollback"; cp -p "$d/$DEFFNM.cpt" "$d/$BACKUP_ROOT/rollback/"; cp -p "$d/${DEFFNM}_prev.cpt" "$d/$DEFFNM.cpt"');
    L.push('  done');
    L.push('  STEP=$1');
    L.push('}');
  } else {
    L.push(assign('NW', o.count, 'walkers, one LAMMPS partition each'));
    L.push('[ -f RUN_COMPLETE ] && { log "The run is complete (RUN_COMPLETE). Nothing to do."; exit 0; }');
    L.push('[ -f "$PLUMED_DAT" ] || die "$PLUMED_DAT is missing."');
    L.push('grep -Eq \'^[[:space:]]*RESTART([[:space:]]|$)\' "$PLUMED_DAT" && die "$PLUMED_DAT contains RESTART: take it out; this script adds it when the run continues."');
    L.push('# Steps with a restart file for every partition (restart.<step>.<walker>), newest first.');
    L.push('restart_steps() {');
    L.push('  { ls restart.*.* 2>/dev/null | sed -n \'s/^restart\\.\\([0-9][0-9]*\\)\\.[0-9][0-9]*$/\\1/p\' | sort -n | uniq -c | awk -v n="$NW" \'$1 == n { print $2 }\' | sort -rn; } || true');
    L.push('}');
    L.push('candidates() { restart_steps; }');
    L.push('use_step() {');
    L.push('  [ "$1" = "$STEP" ] && return 0');
    L.push('  log "  Going back to the restart files of step $1, which $WHAT belongs to."');
    L.push('  mkdir -p "$BACKUP_ROOT/rollback"');
    L.push('  for s in $(restart_steps); do [ "$s" -gt "$1" ] && mv restart."$s".* "$BACKUP_ROOT/rollback/"; done');
    L.push('  STEP=$1');
    L.push('}');
    L.push('# Keep the three newest sets of restart files.');
    L.push('prune_restarts() { { restart_steps | tail -n +4 | while read -r s; do rm -f -- restart."$s".*; done; } || true; }');
    L.push('STEP=$(restart_steps | head -n 1); have=0; N=1; [ -n "$STEP" ] && have=1');
  }
  L.push(...continueFunction(o, needs));
  L.push(...engineFunction(o));
  L.push('if [ "$have" -gt 0 ] && [ "$have" -lt "$N" ]; then');
  L.push('  die "$have of $N walkers have a checkpoint. They run as one job and stop together, so the others were lost or never started; put back a matching set, or move all of them away to start again."');
  L.push('fi');
  L.push('if [ "$have" -gt 0 ]; then');
  L.push('  continue_run');
  L.push('else');
  if (o.engine === 'gromacs') {
    L.push('  for d in $DIRS; do');
    L.push(`    for f in ${[...needs.hills, ...needs.state].join(' ') || 'COLVAR'}; do [ -s "$d/$f" ] && die "$d/$f exists but there is no checkpoint, which usually means the checkpoints were lost. Starting again would put the bias aside; restore them, or move the old files away."; done`);
    L.push('  done');
  } else if (needs.hills.length || needs.state.length) {
    L.push(`  for f in ${[...needs.hills, ...needs.state].join(' ')}; do [ -s "$f" ] && die "$f exists but there is no restart file, which usually means the restart files were lost. Restore them, or move the old files away to start again."; done`);
  }
  L.push('  INPUT="$PLUMED_DAT"');
  L.push('  log "Starting all walkers."');
  L.push('fi');
  L.push(...runLines(o, needs));
  return L;
}

/* ------------------------------------------------------------------ *
 * Chain, LAMMPS input and README
 * ------------------------------------------------------------------ */

function chainScript(o) {
  const sch = o.scheduler.scheduler || 'slurm';
  const L = ['#!/bin/bash', '# Queue several segments of job.sh, each starting when the one before it ends,',
    '# however it ended. A segment continues from the last checkpoint and does',
    '# nothing once the run is complete, so queueing too many costs nothing.',
    '# Usage: bash chain.sh [segments, default 5]', 'set -e', 'N=${1:-5}', 'prev=""',
    'for i in $(seq 1 "$N"); do'];
  if (sch === 'slurm') {
    L.push('  id=$(sbatch --parsable ${prev:+--dependency=afterany:$prev} job.sh)');
    L.push('  id=${id%%;*}');
  } else if (sch === 'pbs') {
    L.push('  id=$(qsub ${prev:+-W depend=afterany:$prev} job.sh)');
  } else if (sch === 'lsf') {
    L.push('  id=$(bsub ${prev:+-w "ended($prev)"} < job.sh | sed -n \'s/^Job <\\([0-9]*\\)>.*/\\1/p\')');
  } else {
    L.push('  id=$(qsub -terse ${prev:+-hold_jid $prev} job.sh | cut -d. -f1)');
  }
  L.push('  [ -n "$id" ] || { echo "Submitting segment $i failed." >&2; exit 1; }');
  L.push('  echo "Segment $i queued as job $id."');
  L.push('  prev=$id');
  L.push('done');
  return `${L.join('\n')}\n`;
}

function lammpsTemplate(o) {
  const part = o.layout === 'walkers-mpi';
  const w = part ? '.${w}' : '';
  return [
    '# The lines a LAMMPS input needs so that job.sh can start and continue it.',
    '# Copy them into your input around your own system definition.',
    '# job.sh passes: rstep (-1 for a new run), plumed_in, time_limit, restart_every, total_steps.',
    '',
    `units           ${o.lmp.units}`,
    ...(part ? [`variable        w world ${Array.from({ length: o.count }, (_, i) => i).join(' ')}`] : []),
    '',
    '# A new run reads the data file; a continued one the restart file of its step',
    '# (rstep is -1 for a new run: LAMMPS compares numbers, not words).',
    'if "${rstep} < 0" then &',
    '  "read_data system.data" &',
    'else &',
    `  "read_restart restart.\${rstep}${w}"`,
    '',
    '# ... your force field, groups and thermostat. read_restart keeps the',
    '# atoms, the box and most pair coefficients, but no fixes: define them here.',
    '',
    `timestep        ${o.lmp.timestep}`,
    'fix             pl all plumed plumedfile ${plumed_in} outfile plumed.log',
    '',
    '# Stop before the wall time, keep restart files, never reset the step.',
    'timer           timeout ${time_limit} every 1000',
    `restart         \${restart_every} restart.*${w}`,
    'run             ${total_steps} upto',
    `write_restart   restart.*${w}`,
    ''
  ].join('\n');
}

function readme(o, needs) {
  const sch = o.scheduler.scheduler || 'slurm';
  const L = [];
  const dirs = o.layout === 'single' ? '' : `${o.prefix}0 to ${o.prefix}${o.count - 1}`;
  L.push(`# PLUMED run files: ${RUN_LAYOUTS[o.layout].toLowerCase()}, ${RUN_ENGINES[o.engine]}`, '');
  L.push('Written by stemkit.net. The same `job.sh` starts the run and continues it.', '');
  L.push('## Before the first job', '');
  if (o.engine === 'gromacs') {
    if (o.layout === 'single') L.push(`- Put \`${o.gmx.deffnm}.tpr\` beside \`plumed.dat\`.`);
    else L.push(`- Make one \`${o.gmx.deffnm}.tpr\` in each of ${dirs}${o.layout === 'windows' ? ', each started close to its window\'s centre' : ', from different starting structures or velocities'}.`);
    L.push('- Check that your GROMACS can run PLUMED: `gmx mdrun -h` lists `-plumed`. A build that lacks it says "GROMACS is not compiled with the PLUMED interface".');
    if (o.layout === 'walkers-mpi') {
      L.push('- The walkers run as one MPI job (`-multidir`), which needs GROMACS patched with PLUMED (`plumed patch -p`): the interface built into GROMACS 2025 does not pass the walkers to PLUMED. Request a multiple of ' + o.count + ' MPI tasks.');
    }
  } else {
    L.push('- Add the lines in `in.lammps.template` to your LAMMPS input (named in `LMP_IN`).');
    if (o.layout === 'single') L.push('- Put your data file, `system.data`, beside it.');
    else if (o.layout === 'walkers-mpi') L.push(`- The ${o.count} walkers are LAMMPS partitions in this one directory; request ${o.count} × RANKS_PER_WALKER MPI tasks.`);
    else L.push(`- Put the LAMMPS input and a data file in each of ${dirs}.`);
  }
  L.push(`- Check each input with \`plumed driver --natoms N --parse-only --plumed plumed.dat\`.`, '');
  L.push('## Running', '');
  const submit = submitCommand(sch, 'job.sh');
  L.push(`Submit \`${submit}\` once, or \`bash chain.sh 10\` to queue ten segments that follow one another. ` +
    'Each segment continues from the last checkpoint, and once the run is complete the rest exit at once.');
  L.push('', `The engine stops itself before the wall time (${o.engine === 'gromacs' ? `\`-maxh ${o.hours}\`` : `\`timer timeout ${o.timeLimit}\``}), ` +
    'so that it writes a checkpoint and PLUMED closes its files cleanly.', '');
  L.push('## What happens when a job continues', '');
  L.push('`job.sh` decides from the checkpoint whether to start or to continue; nothing is edited by hand. Before continuing it:', '');
  L.push('1. Reads the checkpoint\'s step, and the time PLUMED had then.');
  if (needs.hills.length) {
    L.push(`2. Checks that ${needs.hills.map(h => `\`${h}\``).join(', ')} exist${o.layout === 'walkers-files' ? '' : ' and reach the checkpoint'}. ` +
      'A missing hills file stops METAD, but PBMETAD goes on with no bias and says so only in its log, so the script stops first.');
  }
  if (needs.state.length) {
    L.push('2. Checks that `State.data`, the OPES state, is whole and belongs to the checkpoint: its kernel count must equal the kernels laid by the checkpoint\'s time. ' +
      'OPES restarts exactly from its state; from the kernels file alone it would be approximate (18 kJ/mol off in a test run). ' +
      (o.engine === 'gromacs'
        ? `mdrun runs ${o.chunk} steps at a time, and the state is written at the end of each chunk, where the checkpoint is. ` +
          'Periodic checkpoints are off (`-cpt`), because GROMACS 2025 never clears the checkpoint signal it gives PLUMED, after which the state is rewritten at every deposition and soon no longer matches any checkpoint. '
        : `The state is written every ${o.lmp.restartEvery} steps, with each LAMMPS restart file. `) +
      'A state cut off, or one checkpoint ahead because the job stopped between the two writes, is replaced by the one before it, and the matching checkpoint is used.');
  }
  if (needs.abmd) {
    L.push(`2. Takes the ratchet's position at the checkpoint (${needs.abmd.columns.map(c => `\`${c}\``).join(', ')}, printed in full to \`${ABMD_FILE}\` at every step a checkpoint can fall on) and passes it back as \`MIN\`, or ABMD would start its ratchet again from wherever the variable is. ` +
      (o.engine === 'gromacs' ? `mdrun runs ${o.chunk} steps at a time, so every checkpoint falls on such a step. ` : '') +
      'If no checkpoint has a printed position the script stops; `ABMD_RESET=1 bash job.sh` accepts the reset.');
  }
  if (o.layout === 'walkers-files') {
    L.push('3. Leaves the hills files alone. Other walkers are reading them, and a file cut short under a reader breaks it; hills a killed walker laid past its checkpoint stay, as they would from one more walker.');
  } else {
    L.push('3. After a hard kill (a node failure, or the scheduler killing the job) the files hold rows written after the last checkpoint. ' +
      'Read back, those hills would bias the continued run with hills its trajectory never laid. The script trims every PLUMED file to the checkpoint, ' +
      'and a row cut off mid-write with it. The old copy of anything changed is kept in `backup/step<N>/`; the three newest are kept.');
  }
  L.push('4. Writes `plumed.restart.dat`: `RESTART` and `plumed.dat`. PLUMED then appends to its files instead of setting them aside.', '');
  if (o.layout === 'walkers-mpi') {
    L.push('With MPI walkers only walker 0 writes the hills' + (needs.state.length ? ' and the state' : '') + '; every walker reads them from ' +
      (o.engine === 'gromacs' ? '`w0`' : 'this directory') + ' on a restart. Each walker keeps its own COLVAR (`COLVAR.0`, `COLVAR.1`, ...).', '');
  }
  if (o.layout === 'walkers-files') {
    L.push(`Every walker writes its own \`HILLS.<walker>\` in \`hills/\` and reads the others every WALKERS_RSTRIDE steps. The script creates any walker's file that does not exist yet and always runs with \`RESTART\`, so that a walker that starts late, or restarts while another has not started, never sets aside a file the others are reading.`, '');
  }
  L.push('The script stops with a message, without running, when:', '');
  L.push('- a file PLUMED must read back is missing, cut short, or ends before the checkpoint;');
  L.push('- PLUMED files exist but the checkpoint does not (a lost checkpoint: starting again would drop the bias);');
  if (o.layout === 'walkers-mpi') L.push('- the walkers\' checkpoints are at different steps, or only some walkers have one;');
  L.push('- `plumed.dat` contains `RESTART`, which would stop a new run at the first file it cannot find.', '');
  for (const n of needs.notes) L.push(n, '');
  L.push('## Analysis', '');
  L.push('`analyse_plumed.py` does what the Analyse view of the page does, and reads files from continued runs: rows a continued run wrote again are counted once. For example:', '');
  // Where the files are: walker 0's directory under -multidir, the job
  // directory for LAMMPS partitions, each walker's or window's directory.
  const multiGmx = o.layout === 'walkers-mpi' && o.engine === 'gromacs';
  const colvar = o.layout === 'walkers-mpi' ? replicaFile(o.prints[0] || 'COLVAR', 0) : (o.prints[0] || 'COLVAR');
  const colvarPath = o.layout === 'single' || (o.layout === 'walkers-mpi' && o.engine === 'lammps') ? colvar : `${o.prefix}0/${colvar}`;
  const hillsPaths = needs.hills.map(h => (o.layout === 'walkers-files' ? `hills/${h}.*` : multiGmx ? `w0/${h}` : h));
  L.push('```');
  if (needs.hills.length === 1) {
    // Separate walkers leave hills from a killed segment in the shared files.
    // They biased every walker, so the sum keeps them.
    const keep = o.layout === 'walkers-files' ? ' --keep-overlap' : '';
    L.push(`python3 analyse_plumed.py fes ${hillsPaths[0]} --temp ${o.temperature}${keep}`);
  }
  L.push(`python3 analyse_plumed.py all ${colvarPath} --temp ${o.temperature}`);
  L.push('```', '');
  if (o.layout === 'walkers-files') {
    L.push('With walkers as separate jobs, a killed walker\'s hills file keeps the hills it laid after its last checkpoint, since the other walkers are reading that file. Those hills biased every walker, so `--keep-overlap` keeps them in the surface.', '');
  }
  return `${L.join('\n')}\n`;
}

/* ------------------------------------------------------------------ *
 * The kit
 * ------------------------------------------------------------------ */

/**
 * Every file of a restart-safe PLUMED job.
 *
 * @param {{
 *   plumed: object,
 *   engine?: 'gromacs'|'lammps',
 *   layout?: 'single'|'walkers-mpi'|'walkers-files'|'windows',
 *   count?: number,
 *   windows?: {from:number|string, to:number|string, kappa?:string},
 *   dtPs?: number,
 *   gromacs?: {binary?:string, deffnm?:string, extra?:string},
 *   lammps?: {binary?:string, input?:string, units?:'real'|'metal', timestep?:number,
 *     restartEvery?:number, totalSteps?:number},
 *   scheduler?: object,
 *   temperature?: number|string,
 *   extraFiles?: Object<string, string>
 * }} config - `plumed` is the configuration generatePlumedInput takes.
 * @returns {{files:Array<{path:string, text:string, executable?:boolean}>,
 *   warnings:string[], submit:string}}
 */
export function buildRunKit(config) {
  const plumed = config.plumed || {};
  const engine = config.engine === 'lammps' ? 'lammps' : 'gromacs';
  let layout = RUN_LAYOUTS[config.layout] ? config.layout : 'single';
  const method = str(plumed.bias && plumed.bias.method) || 'none';
  const warnings = [];
  const family = ['metad', 'wt_metad', 'pbmetad', 'opes'].includes(method);
  if ((layout === 'walkers-mpi' || layout === 'walkers-files') && !family) {
    warnings.push('Multiple walkers share a metadynamics or OPES bias; with this method each walker would run alone. Set the method, or run one simulation.');
    layout = 'single';
  }
  if (layout === 'walkers-files' && method === 'opes') {
    warnings.push('OPES shares its bias between walkers through MPI only, so the walkers run as one MPI job.');
    layout = 'walkers-mpi';
  }
  if (layout === 'windows' && method !== 'restraint') {
    warnings.push('Umbrella windows need the Harmonic restraint method, one window per centre.');
    layout = 'single';
  }
  const count = layout === 'single' ? 1 : Math.max(2, Math.min(256, parseInt(config.count, 10) || 4));
  const prefix = layout === 'windows' ? 'win' : 'w';
  const units = (plumed.units && plumed.units.time) || 'ps';
  const timeUnitPs = TIME_UNIT_PS[units] || 1;
  const lmp = {
    binary: 'lmp', input: 'in.lammps', units: 'real', timestep: 2, restartEvery: 10000, totalSteps: 5000000,
    ...(config.lammps || {})
  };
  if (!LAMMPS_TIME_PS[lmp.units]) lmp.units = 'real';
  const dtPs = engine === 'lammps'
    ? Number(lmp.timestep) * LAMMPS_TIME_PS[lmp.units]
    : (Number(config.dtPs) > 0 ? Number(config.dtPs) : 0.002);
  const scheduler = { scheduler: 'slurm', jobName: 'plumed', nodes: 1, cpusPerTask: 8, tasksPerNode: 1, walltime: '24:00:00', ...(config.scheduler || {}) };
  if (layout === 'walkers-files' || layout === 'windows') {
    scheduler.array = true;
    scheduler.arrayRange = `1-${count}`;
  } else {
    scheduler.array = false;
  }
  if (layout === 'walkers-mpi' && (parseInt(scheduler.tasksPerNode, 10) || 1) * (parseInt(scheduler.nodes, 10) || 1) < count) {
    warnings.push(`${count} walkers in one MPI job need at least ${count} MPI tasks; the job asks for fewer.`);
  }
  const hours = runHours(scheduler.walltime) || 23.28;
  const wallSeconds = walltimeToSeconds(scheduler.walltime) || 86400;
  const biasParams = (plumed.bias && plumed.bias.params) || {};
  const pace = parseInt(str(biasParams.PACE) || str(plumed.bias && plumed.bias.stride) || '500', 10) || 500;
  // Chunks and restart intervals are whole numbers of depositions: PLUMED
  // refuses a state interval shorter than PACE.
  const multipleOfPace = (v, fallback) => Math.max(pace, Math.round((parseInt(v, 10) || fallback) / pace) * pace);
  const chunk = multipleOfPace(config.gromacs && config.gromacs.chunk, pace * 100);
  if (method === 'opes') lmp.restartEvery = multipleOfPace(lmp.restartEvery, pace * 20);
  const o = {
    engine, layout, count, prefix, timeUnitPs, dtPs, hours, wallSeconds, chunk,
    timeLimit: hms(hours),
    plumedDt: engine === 'gromacs' ? gromacsPlumedTimestep(dtPs) : String(Number(dtPs.toPrecision(15))),
    gmx: {
      binary: layout === 'walkers-mpi' ? 'gmx_mpi' : 'gmx', deffnm: 'md', extra: '',
      ...(config.gromacs || {})
    },
    lmp, scheduler,
    temperature: str(config.temperature) || str(plumed.bias && plumed.bias.temp) || '300'
  };
  if (layout === 'walkers-mpi' && !/_mpi$/.test(o.gmx.binary) && engine === 'gromacs') {
    warnings.push(`-multidir needs an MPI build of GROMACS, usually called gmx_mpi, not ${o.gmx.binary}.`);
  }

  /* Per-directory inputs. */
  const walkersBase = { ...((plumed.bias && plumed.bias.walkers) || {}) };
  const stateStride = engine === 'lammps' ? String(lmp.restartEvery) : String(chunk);
  // LAMMPS does not tell PLUMED when it writes a restart file, and PLUMED
  // flushes its files every 10 000 steps otherwise, so after a hard kill the
  // hills on disk could stop short of the restart file. FLUSH at the restart
  // interval (PLUMED flushes before LAMMPS writes the file) closes the gap.
  let flush = '';
  if (engine === 'lammps') {
    const own = parseInt(str(plumed.preamble && plumed.preamble.flush), 10);
    flush = own > 0 && lmp.restartEvery % own === 0 ? String(own) : String(lmp.restartEvery);
  }
  const inputs = [];
  let biasTargets = [];
  let biasLabel = '';
  for (let i = 0; i < count; i++) {
    const bias = { stateStride };
    if (layout === 'walkers-mpi') {
      bias.walkers = { ...walkersBase, mode: 'mpi', sharedDir: engine === 'gromacs' ? '../w0' : '' };
    } else if (layout === 'walkers-files') {
      bias.walkers = { ...walkersBase, mode: 'disk', n: count, id: i, dir: '../hills', perWalkerFiles: true };
    } else {
      bias.walkers = { mode: 'none' };
    }
    if (layout === 'windows') {
      const centres = windowCentres(config.windows && config.windows.from, config.windows && config.windows.to, count);
      bias.params = { ...((plumed.bias && plumed.bias.params) || {}), AT: centres[i] || '' };
      if (config.windows && str(config.windows.kappa)) bias.params.KAPPA = str(config.windows.kappa);
    }
    const r = inputFor(plumed, { bias, flush });
    biasTargets = r.biased;
    biasLabel = (r.printable.find(c => /\.bias$/.test(c)) || '').replace(/\.bias$/, '');
    inputs.push(r);
    if (i === 0) {
      for (const w of r.warnings) {
        if (/WALKERS_ID|hardcodes|different|RESTART/.test(w)) continue;
        warnings.push(w);
      }
    }
  }
  const printFiles = [];
  for (const m of inputs[0].input.matchAll(/^PRINT .*FILE=(\S+)/gm)) printFiles.push(m[1]);
  o.prints = printFiles.length ? printFiles : ['COLVAR'];
  const needs = restartNeeds({ ...(plumed.bias || {}) }, { targets: biasTargets, label: biasLabel });
  if (needs.abmd) {
    // The ratchet position, at every step a checkpoint can fall on, in full.
    const every = engine === 'lammps' ? lmp.restartEvery : chunk;
    const line = `PRINT ARG=${needs.abmd.columns.join(',')} FILE=${ABMD_FILE} STRIDE=${every} FMT=%.15g`;
    for (const r of inputs) r.input = r.input.replace(/\n*$/, `\n# The ratchet position, read back when the run continues\n${line}\n`);
    o.prints.push(ABMD_FILE);
  }
  if (needs.state.length && engine === 'lammps') {
    needs.notes.push(`OPES writes its state every ${lmp.restartEvery} steps (STATE_WSTRIDE), the interval of the LAMMPS restart files, so that a restart file and a state always come from the same step.`);
  }

  /* The job script. */
  const title = `PLUMED ${method === 'none' ? 'run' : method.toUpperCase()}, ${RUN_LAYOUTS[layout].toLowerCase()}, ${RUN_ENGINES[engine]}`;
  const head = scriptHeader(o, title);
  warnings.push(...head.warnings.map(w => (typeof w === 'string' ? w : w.message)).filter(Boolean));
  const job = [
    ...head.lines,
    ...envLines(o),
    ...settingLines(o, needs),
    ...(layout === 'walkers-mpi' ? [] : runDirLines(o)),
    ...(layout === 'walkers-mpi' && engine === 'lammps' ? [assign('RANKS_PER_WALKER', Math.max(1, Math.floor(((parseInt(scheduler.tasksPerNode, 10) || 1) * (parseInt(scheduler.nodes, 10) || 1)) / count)), 'MPI ranks for each walker')] : []),
    '', '# --- Functions ---', COMMON_FUNCTIONS,
    ...(layout === 'walkers-mpi' ? multiBody(o, needs) : perDirectoryBody(o, needs))
  ].join('\n');

  const files = [{ path: 'job.sh', text: `${job}\n`, executable: true }];
  files.push({ path: 'chain.sh', text: chainScript(o), executable: true });
  const extra = config.extraFiles || {};
  if (layout === 'single' || (layout === 'walkers-mpi' && engine === 'lammps')) {
    files.push({ path: 'plumed.dat', text: inputs[0].input });
    for (const [name, text] of Object.entries(extra)) files.push({ path: name, text });
  } else {
    inputs.forEach((r, i) => {
      files.push({ path: `${prefix}${i}/plumed.dat`, text: r.input });
      for (const [name, text] of Object.entries(extra)) files.push({ path: `${prefix}${i}/${name}`, text });
    });
    if (layout === 'walkers-files') files.push({ path: 'hills/.keep', text: '' });
  }
  if (engine === 'lammps') files.push({ path: 'in.lammps.template', text: lammpsTemplate(o) });
  files.push({ path: 'README.md', text: readme(o, needs) });
  return { files, warnings: [...new Set(warnings)], submit: submitCommand(scheduler.scheduler, 'job.sh'), layout, engine, count };
}
