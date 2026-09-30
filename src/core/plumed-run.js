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
 *     is given MIN, which the script takes from the printed `<label>.<arg>_min`
 *     (`abmd.cn_mean_min` for a shortcut's `cn.mean` from PLUMED 2.10).
 *   - MOVINGRESTRAINT follows the MD step, which a checkpoint keeps, but its
 *     work starts again from zero in each segment. The row printed at the
 *     checkpoint is the only record of the work done by then, so it is kept.
 *
 * PLUMED's time is the step times the time step the engine hands it, and the
 * script cuts files by that time. GROMACS hands over the tpr's dt as a `real`:
 * in single precision, unless GROMACS was built in double, so PLUMED's time
 * runs ahead of the step's by about 1e-10 ps a step. The script therefore
 * reads dt from the tpr itself (a kit made for 2 fs would otherwise cut away
 * half the hills of a 4 fs run) and rounds it as mdrun does.
 */

import { generatePlumedInput } from './plumed.js';
import { buildHeader, launcher, envVars, walltimeToSeconds, submitCommand, getScheduler } from './scheduler.js';

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
 * The time step PLUMED is given by GROMACS, which passes it as a `real`: in
 * a mixed-precision build 0.002 ps arrives as 0.0020000000949949026, in a
 * double-precision build (gmx_d) as 0.002.
 *
 * @param {number} dtPs
 * @param {'mixed'|'double'} [precision] - how GROMACS was built.
 * @returns {string}
 */
export function gromacsPlumedTimestep(dtPs, precision = 'mixed') {
  const d = Number(dtPs);
  const v = precision === 'double' ? d : Math.fround(d);
  return Number.isFinite(v) && v > 0 ? String(Number(v.toPrecision(17))) : '';
}

/**
 * Whether a GROMACS binary name is a double-precision build: GROMACS gives
 * those the suffix `_d` (gmx_d, gmx_mpi_d).
 *
 * @param {string} binary
 * @returns {boolean}
 */
const doubleBuild = (binary) => /_d$/.test(str(binary).split(/[\\/]/).pop());

/**
 * A number as PLUMED reads one in its input, where `pi`, `-pi` and `2pi` or
 * `2*pi` are allowed too.
 *
 * @param {number|string} value
 * @returns {number|null}
 */
function parseValue(value) {
  const t = str(value).toLowerCase();
  if (!t) return null;
  const m = /^([+-]?)(\d*\.?\d*)\*?pi$/.exec(t);
  if (m) {
    const k = m[2] === '' ? 1 : Number(m[2]);
    return Number.isFinite(k) ? (m[1] === '-' ? -1 : 1) * k * Math.PI : null;
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
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
 * The ends may be written as PLUMED takes them, `-pi` to `pi` for a torsion.
 *
 * @param {number|string} from
 * @param {number|string} to
 * @param {number|string} count
 * @returns {string[]} empty when either end is missing or not a number.
 */
export function windowCentres(from, to, count) {
  const a = parseValue(from);
  const b = parseValue(to);
  const n = Math.max(1, Math.floor(Number(count)) || 1);
  if (a === null || b === null) return [];
  if (n === 1) return [String(a)];
  const step = (b - a) / (n - 1);
  const digits = Math.max(0, Math.min(6, 2 - Math.floor(Math.log10(Math.abs(step) || 1))));
  return Array.from({ length: n }, (_, i) => String(Number((a + i * step).toFixed(digits))));
}

/* ------------------------------------------------------------------ *
 * What each method reads back
 * ------------------------------------------------------------------ */

/* The value of KEY=value in a line or block of PLUMED input; a longer keyword
   ending in the same letters (STATE_WFILE for FILE) does not count. */
function keywordValue(text, key) {
  const m = new RegExp(`(?:^|\\s)${key}=(\\S+)`, 'm').exec(String(text || ''));
  return m ? m[1] : '';
}

/* The METAD, PBMETAD or OPES_METAD block of a generated input. */
function biasBlock(input) {
  const m = /^\S+:[ \t]+(?:METAD|PBMETAD|OPES_METAD)[ \t]+\.\.\.[^\n]*\n([\s\S]*?)^\.\.\./m.exec(String(input || ''));
  return m ? m[1] : '';
}

/* A positive whole number of steps, as PLUMED reads PACE or STRIDE. */
function steps(value) {
  const n = parseValue(value);
  return n !== null && Number.isInteger(n) && n > 0 ? n : null;
}

/* The first releases of the generator took lower-case parameter names, and it
   still reads them (a later key wins, as there); so must the kit, or it
   checks files PLUMED never writes. Only the names the kit reads are mapped. */
const LEGACY_KEYS = Object.freeze({ pace: 'PACE', file: 'FILE', at: 'AT', kappa: 'KAPPA' });
function upperParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) out[LEGACY_KEYS[k] || k] = v;
  return out;
}

/**
 * The files PLUMED reads back when a run continues, per method.
 *
 * PACE and the file names are the ones PLUMED will use. They are read from
 * the generated input when `info.input` gives it; otherwise they are worked
 * out as the generator does, from the parameters (lower-case names too) and
 * the defaults of the catalogue. `bias.stride` never reaches PACE there.
 *
 * @param {object} bias - `config.bias` of generatePlumedInput.
 * @param {{targets:string[], label:string, input?:string, printable?:string[]}} info
 *        `printable` is generatePlumedInput's: the ABMD `_min` components are
 *        taken from it, since from PLUMED 2.10 a shortcut's `cn.mean` makes
 *        `abmd.cn_mean_min`, not `abmd.cn.mean_min`.
 * @returns {{hills:string[], state:string[], kernels:string[], abmd:null|
 *   {label:string, columns:string[]}, pace:number, notes:string[]}}
 */
export function restartNeeds(bias, info) {
  const method = str(bias && bias.method) || 'none';
  const p = upperParams(bias && bias.params);
  const block = biasBlock(info && info.input);
  const pace = steps(keywordValue(block, 'PACE')) || steps(p.PACE) || 500;
  const file = keywordValue(block, 'FILE') || str(p.FILE);
  const targets = (info && info.targets) || [];
  const out = { hills: [], state: [], kernels: [], abmd: null, pace, notes: [] };
  switch (method) {
    case 'metad':
    case 'wt_metad':
      out.hills = [file || 'HILLS'];
      break;
    case 'pbmetad':
      // The generator names one file per variable and ignores FILE.
      out.hills = block && file
        ? file.split(',').filter(Boolean)
        : targets.map(a => `HILLS.${a.replace(/[^A-Za-z0-9_-]/g, '_')}`);
      break;
    case 'opes':
      out.state = ['State.data'];
      out.kernels = [file || 'Kernels.data'];
      break;
    case 'abmd': {
      const label = (info && info.label) || 'abmd';
      const printed = ((info && info.printable) || [])
        .filter(c => c.startsWith(`${label}.`) && c.endsWith('_min'));
      out.abmd = {
        label,
        columns: printed.length === targets.length && printed.length
          ? printed : targets.map(a => `${label}.${a}_min`)
      };
      break;
    }
    case 'moving':
      out.notes.push('MOVINGRESTRAINT follows the MD step, which the checkpoint keeps, so the ' +
        'restraint carries on where it was. Its work starts again from zero in each segment, so the ' +
        'script keeps the row printed at the checkpoint, and `analyse_plumed.py work` carries each ' +
        'segment on from the work in that row. That is exact when the checkpoint falls on a step the ' +
        'work was printed at; otherwise the work done since the last printed row is left out of the total.');
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
}

# Times in PLUMED units follow from the time step. TOL is half a step: a row
# within it of a time belongs to that time. The hills files must reach within
# GAP, one and a half hills, of the checkpoint.
set_times() {
  TOL=$(awk -v d="$PLUMED_DT" -v u="$TIME_UNIT" 'BEGIN { t = 0.5 * d / u; printf "%.6g", (t > 1e-6 ? t : 1e-6) }')
  GAP=$(awk -v d="$PLUMED_DT" -v u="$TIME_UNIT" -v p="$PACE" 'BEGIN { printf "%.6g", 1.5 * p * d / u }')
}

# plumed_dt DT PRECISION: the time step PLUMED is handed. GROMACS passes it as
# a real, so a mixed-precision build rounds it to single precision (to
# nearest, ties to even): 0.002 arrives as 0.0020000000949949026.
plumed_dt() {
  awk -v d="$1" -v p="$2" 'BEGIN {
    m = d + 0; if (!(m > 0)) exit 1
    if (p == "double") { printf "%.17g\n", m; exit }
    e = 0; while (m >= 2) { m /= 2; e++ } while (m < 1) { m *= 2; e-- }
    q = m * 8388608; r = int(q); f = q - r
    if (f > 0.5 || (f == 0.5 && r % 2 == 1)) r++
    printf "%.17g\n", r / 8388608 * 2 ^ e
  }'
}

# A separate walker's own hills file can end in a row cut off by a kill. The
# other walkers stop at such a row and wait for the rest of it, but the header
# a restarted walker appends would finish it as a broken row that stops every
# walker reading the file. It is cut off in place: the other walkers hold the
# file open, and would go on reading the old one if it were replaced.
cut_partial_row() {
  local size part
  [ -s "$1" ] || return 0
  [ "$(tail -c 1 "$1" | od -An -c | tr -d ' ')" = '\n' ] && return 0
  size=$(wc -c < "$1"); part=$(tail -n 1 "$1" | wc -c)
  mkdir -p "$BACKUP_ROOT"; tail -n 1 "$1" > "$BACKUP_ROOT/$(basename "$1").cut-row"
  { truncate -s $((size - part)) "$1" 2>/dev/null || dd if=/dev/null of="$1" bs=1 seek=$((size - part)) 2>/dev/null; } ||
    die "could not take the unfinished last row off $1; remove it by hand (a copy is in $BACKUP_ROOT), then submit again."
  log "  $1 ended in a row cut off mid-write; that row was taken out (a copy is in $BACKUP_ROOT)."
}`;

/* GROMACS: what gmx dump reads from a checkpoint and a tpr. */
const GMX_FUNCTIONS = String.raw`

# gmx dump reads the step of a checkpoint, and the length and time step of a run.
cpt_step() { { $GMX_DUMP dump -cp "$1" 2>/dev/null | awk '$1 == "step" && $2 == "=" { print $3; exit }'; } || true; }
# tpr_info FILE: nsteps, init-step and dt of a tpr, on one line.
tpr_info() {
  { $GMX_DUMP dump -s "$1" 2>/dev/null | awk '
      $2 != "=" { next }
      $1 == "nsteps" { n = $3 } $1 ~ /^init[-_]step$/ { i = $3 } $1 ~ /^(dt|delta[-_]t)$/ { d = $3 }
      n != "" && i != "" && d != "" { print n, i, d; exit }'; } || true
}
# The step a run ends at: init-step + nsteps. Nothing for a run without end.
tpr_last() {
  local n i d
  read -r n i d <<< "$(tpr_info "$1")"
  if [ -n "$n" ] && [ "$n" -ge 0 ] 2>/dev/null; then echo $((n + i)); fi
}
# mdrun hands PLUMED its time step as a real: double only in a double build.
gmx_precision() {
  local p
  case "$GMX" in *_d) echo double; return 0 ;; esac
  p=$({ $GMX_DUMP --version 2>/dev/null || true; } | awk '$1 == "Precision:" { print $2; exit }')
  [ -n "$p" ] || p=mixed
  echo "$p"
}
# The tpr's first step, and its time step as PLUMED has it. PLUMED's times
# come from that time step, so any other would cut its files at the wrong
# time; a PLUMED_DT set above must agree with it.
settle_tpr() {
  local n i d want
  read -r n i d <<< "$(tpr_info "$1")"
  INIT_STEP=$i; [ -n "$INIT_STEP" ] || INIT_STEP=0
  if [ -z "$d" ]; then
    [ -n "$PLUMED_DT" ] || die "cannot read the time step of $1 with gmx dump; set GMX_DUMP to the GROMACS that wrote it."
    log "WARNING: cannot read the time step of $1 with gmx dump; PLUMED_DT=$PLUMED_DT is used as it stands."
    return 0
  fi
  want=$(plumed_dt "$d" "$(gmx_precision)") || die "$1 gives the time step as \"$d\", which is not a number of ps."
  if [ -n "$PLUMED_DT" ] && ! awk -v a="$PLUMED_DT" -v b="$want" 'BEGIN { x = a - b; if (x < 0) x = -x; exit !(x <= 1e-6 * b) }'; then
    die "$1 has a time step of $d ps, but PLUMED_DT is $PLUMED_DT. PLUMED's times come from the tpr, so every file would be cut at the wrong time (with half the time step, half the hills would go). Use the tpr these files were made for, or set PLUMED_DT=\"\" to take the time step from the tpr."
  fi
  PLUMED_DT=$want
}`;

function scriptHeader(o, title) {
  // The header's engine picks its resource shape. GROMACS alone is threaded,
  // one rank per node; walkers under -multidir need ranks, a multiple of the
  // walker count, so they take the MPI shape LAMMPS uses: tasksPerNode ranks
  // with cpusPerTask threads each.
  const shape = o.engine === 'gromacs' && o.layout !== 'walkers-mpi' ? 'gromacs' : 'lammps';
  const header = buildHeader({ ...o.scheduler, engine: shape });
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
  if (o.engine === 'gromacs') {
    // GROMACS 2025's own interface always loads PLUMED at run time.
    out.push('# The PLUMED interface built into GROMACS 2025 (and GROMACS patched in runtime');
    out.push('# mode) loads PLUMED from PLUMED_KERNEL, and mdrun -plumed stops without it:');
    out.push('# export PLUMED_KERNEL=/path/to/lib/libplumedKernel.so   # $(plumed info --root)/../libplumedKernel.so');
  } else {
    out.push('# A LAMMPS linked to PLUMED in runtime mode finds PLUMED here:');
    out.push('# export PLUMED_KERNEL=/path/to/lib/libplumedKernel.so');
  }
  if (sch === 'slurm') {
    out.push(`export OMP_NUM_THREADS=\${${env.cpusPerTask}:-1}`);
    // Without it each rank srun starts gets one CPU for all its threads.
    out.push('# SLURM 22.05 and later: srun does not inherit --cpus-per-task; pass it on.');
    out.push(`if [ -n "\${${env.cpusPerTask}:-}" ]; then export SRUN_CPUS_PER_TASK=$${env.cpusPerTask}; fi`);
  } else {
    out.push(`export OMP_NUM_THREADS=${Math.max(1, parseInt(o.scheduler.cpusPerTask, 10) || 1)}`);
  }
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
  L.push('', '# --- Settings ---');
  if (o.engine === 'gromacs') {
    L.push(assign('GMX', o.gmx.binary, 'GROMACS built with PLUMED'));
    L.push(assign('GMX_DUMP', o.gmx.binary, 'runs gmx dump; where an MPI build must run under srun, "srun -n 1 gmx_mpi" or a serial gmx'));
    L.push(assign('DEFFNM', o.gmx.deffnm, `each run directory holds ${o.gmx.deffnm}.tpr`));
    L.push(assign('MAXH', o.hours, 'mdrun stops itself and checkpoints before the wall time'));
    L.push(assign('MDRUN_EXTRA', o.gmx.extra || '', 'more mdrun options, e.g. -nb gpu'));
    L.push(assign('PLUMED_DT', o.plumedDt, o.plumedDt
      ? `ps per step as PLUMED has it; the tpr's dt must agree`
      : `ps per step as PLUMED has it; blank: the tpr's dt, as mdrun passes it`));
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
  if (needs.hills.length) L.push(assign('PACE', needs.pace, 'steps between hills, the PACE of plumed.dat'));
  L.push(assign('TIME_UNIT', o.timeUnitPs, 'ps per PLUMED time unit (UNITS TIME)'));
  L.push(assign('PLUMED_DAT', 'plumed.dat', 'the input of a new run; a continued one gets RESTART added'));
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
  // Hills are due once a multiple of PACE lies past the run's first step,
  // which is init-step for GROMACS: no hill is laid on the first step.
  const expected = '$(( STEP / PACE > INIT_STEP / PACE ? 1 : 0 ))';
  // Walker 0 of an MPI job keeps the files every walker reads.
  const ownsShared = o.layout !== 'walkers-mpi' || dir === 0 || o.engine === 'lammps';
  // Under -multidir the job is inside w0 here, where the shared files are.
  const home = o.layout === 'walkers-mpi' && o.engine === 'gromacs' ? '.' : plan.hillsHome;
  if (o.layout === 'walkers-files') {
    L.push(...walkerFilesLines(needs, plan, I));
  } else if (plan.hills.length && ownsShared) {
    for (const h of plan.hills) L.push(`${I}need_file ${at(h, home)} ${expected}`);
    for (const h of plan.hills) L.push(`${I}trim ${at(h, home)} "$T" le`);
  }
  if (plan.kernels.length && ownsShared) {
    for (const k of plan.kernels) L.push(`${I}trim ${k} "$T" le`);
  }
  // A printed row at the checkpoint time is written again by the continued
  // run, so it goes. Rows that are the only record of something stay: the
  // ABMD ratchet position, and the work of a moving restraint, which the
  // continued run starts again from zero at that time.
  for (const p of plan.prints) L.push(`${I}trim ${p} "$T" ${keepsCheckpointRow(o, p) ? 'le' : 'lt'}`);
  return L;
}

/* Whether the row a print file holds at the checkpoint must stay. `keepRow`
   names the files that print a work, under every name a walker gives them. */
function keepsCheckpointRow(o, file) {
  return file === ABMD_FILE || o.keepRow.has(file);
}

/* Separate walkers: every hills file must exist before any walker reads them
   all, and this walker's own must not end in a row cut off by a kill. */
function walkerFilesLines(needs, plan, I) {
  return [
    `${I}# Every walker's hills file must exist before any walker reads them all.`,
    `${I}mkdir -p ${plan.hillsHome}`,
    `${I}for f in ${plan.hills.map(h => `${plan.hillsHome}/${h}`).join(' ')}; do [ -e "$f" ] || : > "$f"; done`,
    ...needs.hills.map(h => `${I}cut_partial_row ${plan.hillsHome}/${h}.$((TASK - 1))`)
  ];
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
      for (let i = 0; i < o.count; i++) {
        for (const p of o.prints) L.push(`  trim ${replicaFile(p, i)} "$T" ${keepsCheckpointRow(o, replicaFile(p, i)) ? 'le' : 'lt'}`);
      }
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
    // The slots of LSF and Grid Engine are ranks times threads, so the launcher
    // needs the threads per rank to start the ranks -partition expects.
    L.push(`  ${launcher(sch, { cpusPerTask: o.scheduler.cpusPerTask })} "$LMP" -partition "\${NW}x\${RANKS_PER_WALKER:-1}" -in "$LMP_IN" -var rstep "\${STEP:--1}" -var plumed_in "$INPUT" -var time_limit "$TIME_LIMIT" -var restart_every "$RESTART_EVERY" -var total_steps "$TOTAL_STEPS"`);
  } else {
    L.push(`  ${launcher(sch, { cpusPerTask: o.scheduler.cpusPerTask })} "$LMP" -in "$LMP_IN" -var rstep "\${STEP:--1}" -var plumed_in "$INPUT" -var time_limit "$TIME_LIMIT" -var restart_every "$RESTART_EVERY" -var total_steps "$TOTAL_STEPS"`);
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
    // Steps are absolute: a run starts at init-step and ends at init-step +
    // nsteps, and the chunks end at multiples of CHUNK, where the state is.
    L.push(`  STEP=$(cpt_step "${cpt}"); STEP=\${STEP:-$INIT_STEP}; LAST=$(tpr_last "${tpr}")`);
    L.push('  if [ -n "$LAST" ] && [ "$STEP" -ge "$LAST" ]; then break; fi');
    L.push('  n=$(( (STEP / CHUNK + 1) * CHUNK - STEP ))');
    L.push('  [ -n "$LAST" ] && [ $((STEP + n)) -gt "$LAST" ] && n=$((LAST - STEP))');
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
    L.push('  if [ -n "$LAST" ] && [ "${STEP:-0}" -ge "$LAST" ]; then break; fi');
    L.push('  continue_run');
    L.push('done');
    L.push(`STEP=$(cpt_step "${cpt}"); LAST=$(tpr_last "${tpr}")`);
  } else {
    L.push('set +e');
    L.push(o.engine === 'gromacs' ? 'run_engine -maxh "$MAXH"' : 'run_engine');
    L.push('status=$?');
    L.push('set -e');
    L.push(`[ "$status" -eq 0 ] || ${failed}`);
    if (o.engine === 'gromacs') L.push(`STEP=$(cpt_step "${cpt}"); LAST=$(tpr_last "${tpr}")`);
    else L.push('STEP=$(restart_steps | head -n 1); LAST=$TOTAL_STEPS; prune_restarts');
  }
  // LAST is the step the run ends at (init-step + nsteps under GROMACS),
  // empty for a run without end.
  L.push('if [ -n "$STEP" ] && [ -n "$LAST" ] && [ "$STEP" -ge "$LAST" ]; then');
  L.push(`  touch ${done}; log "$WHERE is complete: step $STEP of $LAST."`);
  L.push('else');
  L.push('  log "$WHERE stopped at step ${STEP:-?} of ${LAST:-?}. Submit again to continue."');
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
    L.push('settle_tpr "$DEFFNM.tpr"; set_times');
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
    L.push('INIT_STEP=0; set_times');
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
    L.push(...walkerFilesLines(needs, plan, '  '));
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
    L.push('# The walkers run together, so walker 0\'s tpr gives the time step and the first step.');
    L.push('settle_tpr "w0/$DEFFNM.tpr"; set_times');
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
    L.push('INIT_STEP=0; set_times');
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
  } else {
    if (needs.hills.length || needs.state.length) {
      L.push(`  for f in ${[...needs.hills, ...needs.state].join(' ')}; do [ -s "$f" ] && die "$f exists but there is no restart file, which usually means the restart files were lost. Restore them, or move the old files away to start again."; done`);
    }
    // LAMMPS is deterministic: partitions that start alike stay alike, and
    // sample as one walker laying twice the hills.
    L.push('  same=$({ for w in $(seq 0 $((NW - 1))); do if [ -f "system.$w.data" ]; then cksum "system.$w.data"; fi; done; } |');
    L.push('    awk \'{ k = $1 " " $2; if (k in s) { print s[k], $3; exit } s[k] = $3 }\')');
    L.push('  read -r a b <<< "$same"');
    L.push('  if [ -n "$b" ] && cmp -s "$a" "$b"; then');
    L.push('    die "$a and $b are the same, so two walkers would follow one trajectory: LAMMPS is deterministic. Give each walker its own structure or velocities (see README.md), then submit again."');
    L.push('  fi');
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
    '# The jobs log to logs/, which the scheduler may open before job.sh runs.',
    'mkdir -p logs',
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
    ...(part ? [
      '# Each walker starts from its own data file, system.0.data, system.1.data, ...:',
      '# LAMMPS is deterministic, so walkers that start alike stay alike.'
    ] : []),
    'if "${rstep} < 0" then &',
    `  "read_data system${w}.data" &`,
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
  const L = [];
  const dirs = o.layout === 'single' ? '' : `${o.prefix}0 to ${o.prefix}${o.count - 1}`;
  L.push(`# PLUMED run files: ${RUN_LAYOUTS[o.layout].toLowerCase()}, ${RUN_ENGINES[o.engine]}`, '');
  L.push('Written by stemkit.net. The same `job.sh` starts the run and continues it.', '');
  L.push('## Before the first job', '');
  if (o.engine === 'gromacs') {
    if (o.layout === 'single') L.push(`- Put \`${o.gmx.deffnm}.tpr\` beside \`plumed.dat\`.`);
    else L.push(`- Make one \`${o.gmx.deffnm}.tpr\` in each of ${dirs}${o.layout === 'windows' ? ', each started close to its window\'s centre' : ', from different starting structures or velocities'}.`);
    // mdrun -h is no test: GROMACS 2025 registers -plumed whether or not the
    // interface was built, and only a run reports that it was not.
    const tpr = o.layout === 'single' ? `../${o.gmx.deffnm}.tpr` : `../${o.prefix}0/${o.gmx.deffnm}.tpr`;
    L.push('- Check that your GROMACS can run PLUMED with a short trial in a scratch directory ' +
      '(`gmx mdrun -h` is no test: GROMACS 2025 lists `-plumed` whether or not the interface was built):', '');
    L.push('  ```', `  mkdir plumed-check && cd plumed-check && echo 'd: DISTANCE ATOMS=1,2' > p.dat`,
      `  ${o.gmx.binary} mdrun -s ${tpr} -plumed p.dat -nsteps 0${/_mpi/.test(o.gmx.binary) ? '    # under mpirun -np 1 or srun -n 1 where MPI needs it' : ''}`, '  ```', '');
    L.push('  A build without the interface stops with "GROMACS is not compiled with the PLUMED interface". ' +
      'The interface built into GROMACS 2025 loads PLUMED from `PLUMED_KERNEL`, and stops without it: set ' +
      '`export PLUMED_KERNEL=/path/to/lib/libplumedKernel.so` before the trial and in `job.sh`. ' +
      'A GROMACS patched with `plumed patch` in its default mode does not need it. Remove `plumed-check` afterwards.');
    if (o.layout === 'walkers-mpi') {
      const ranks = o.ranks;
      L.push('- The walkers run as one MPI job (`-multidir`), which needs GROMACS patched with PLUMED (`plumed patch -p`): the interface built into GROMACS 2025 does not pass the walkers to PLUMED. ' +
        `mdrun needs a multiple of ${o.count} MPI ranks; \`job.sh\` asks for ${ranks}` +
        (ranks >= o.count && ranks % o.count === 0 ? `, ${ranks / o.count} per walker` : '') + ', each with the threads of `OMP_NUM_THREADS`.');
    }
  } else {
    L.push('- Add the lines in `in.lammps.template` to your LAMMPS input (named in `LMP_IN`).');
    L.push(`- Check that your LAMMPS has the PLUMED package: \`${o.lmp.binary} -h\` lists PLUMED under "Installed packages".`);
    if (o.layout === 'single') L.push('- Put your data file, `system.data`, beside it.');
    else if (o.layout === 'walkers-mpi') {
      L.push(`- The ${o.count} walkers are LAMMPS partitions in this one directory, each starting from its own data file, ` +
        `\`system.0.data\` to \`system.${o.count - 1}.data\`: different structures, or one structure with velocities drawn with a different seed for each ` +
        '(`velocity all create`, then `write_data`). LAMMPS is deterministic, so walkers that start alike follow one trajectory and sample as one walker; ' +
        '`job.sh` stops if two of these files are the same. ' +
        `Request ${o.count} × RANKS_PER_WALKER MPI tasks (\`job.sh\` asks for ${o.ranks}).`);
    } else {
      L.push(`- Put the LAMMPS input and a data file in each of ${dirs}${o.layout === 'windows' ? ', each started close to its window\'s centre' : ', from different starting structures or velocities'}.`);
    }
  }
  L.push(`- Check each input with \`plumed driver --natoms N --parse-only --plumed plumed.dat\`.`, '');
  L.push('## Running', '');
  const submit = o.submit;
  L.push(`Submit \`${submit}\` once, or \`bash chain.sh 10\` to queue ten segments that follow one another. ` +
    'Each segment continues from the last checkpoint, and once the run is complete the rest exit at once.');
  L.push('', `The engine stops itself before the wall time (${o.engine === 'gromacs' ? `\`-maxh ${o.hours}\`` : `\`timer timeout ${o.timeLimit}\``}), ` +
    'so that it writes a checkpoint and PLUMED closes its files cleanly.', '');
  L.push('## What happens when a job continues', '');
  L.push('`job.sh` decides from the checkpoint whether to start or to continue; nothing is edited by hand. Before continuing it:', '');
  L.push(o.engine === 'gromacs'
    ? '1. Reads the checkpoint\'s step, and the time PLUMED had then: the step times the tpr\'s `dt`, which mdrun hands PLUMED in single precision unless GROMACS is a double build (read with `gmx dump -s` and `gmx --version`, so the files are cut at the right time whatever the time step).'
    : '1. Reads the step of the newest restart file, and the time PLUMED had then.');
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
  if (o.engine === 'gromacs') L.push('- `PLUMED_DT` is set in `job.sh` and the tpr\'s time step does not agree with it;');
  L.push('- PLUMED files exist but the checkpoint does not (a lost checkpoint: starting again would drop the bias);');
  if (o.layout === 'walkers-mpi') L.push('- the walkers\' checkpoints are at different steps, or only some walkers have one;');
  L.push('- `plumed.dat` contains `RESTART`, which would stop a new run at the first file it cannot find.', '');
  for (const n of needs.notes) L.push(n, '');
  L.push('## Analysis', '');
  L.push('`analyse_plumed.py` does what the Analyse view of the page does, and reads files from continued runs: COLVAR rows a continued run wrote again are counted once, while every hill in a HILLS file is kept. For example:', '');
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
  // The work of a moving restraint, carried across the continued segments.
  const work = o.prints.find(p => o.keepRow.has(p));
  if (work) L.push(`python3 analyse_plumed.py work ${o.layout === 'single' ? work : `${o.prefix}0/${work}`}`);
  L.push('```', '');
  if (o.layout === 'walkers-files') {
    L.push('With walkers as separate jobs, a killed walker\'s hills file keeps the hills it laid after its last checkpoint, since the other walkers are reading that file. Those hills biased every walker, so `--keep-overlap` keeps them in the surface.', '');
  }
  return `${L.join('\n')}\n`;
}

/* ------------------------------------------------------------------ *
 * The kit
 * ------------------------------------------------------------------ */

/* Umbrella windows: the restraint of each window is the user's, with AT (and
   KAPPA, when the windows give one) set for the first biased argument; any
   other argument keeps what the input gives it. Returns null, with a
   warning, when the range cannot be read. */
function windowParams(windows, count, probe, bias, warnings) {
  const w = windows || {};
  const centres = windowCentres(w.from, w.to, count);
  if (!centres.length) {
    const given = (v) => (str(v) ? `"${str(v)}"` : 'blank');
    warnings.push('Umbrella windows spread their centres from `from` to `to`, which must be numbers ' +
      `(or multiples of pi, such as -pi and pi); here \`from\` is ${given(w.from)} and \`to\` is ${given(w.to)}. ` +
      'Without a range every window would restrain at the same place, so the kit runs one simulation instead.');
    return null;
  }
  if (new Set(centres).size === 1) {
    warnings.push(`The windows' range starts and ends at ${centres[0]}, so every window restrains at the same centre.`);
  }
  const line = (probe.input.match(/^\S+:[ \t]+RESTRAINT[ \t].*$/m) || [''])[0];
  const n = Math.max(1, probe.biased.length);
  const rest = (key) => keywordValue(line, key).split(',').slice(1, n);
  const kappa = str(w.kappa);
  if (n > 1) {
    warnings.push(`With ${n} biased arguments the windows are spread along the first, \`${probe.biased[0]}\`; ` +
      `the others keep AT=${rest('AT').join(',')}${kappa ? ` and KAPPA=${rest('KAPPA').join(',')}` : ''}.`);
  }
  const base = upperParams(bias && bias.params);
  return centres.map(c => {
    const p = { ...base, AT: [c, ...rest('AT')].join(',') };
    if (kappa) p.KAPPA = [kappa, ...rest('KAPPA')].join(',');
    return p;
  });
}

/* FLUSH writes out what the actions before it have written, and PLUMED runs
   its actions in input order: before a PRINT, it would leave that PRINT's row
   at a restart step unwritten when LAMMPS writes the restart file. */
function flushLast(input) {
  const m = input.match(/^FLUSH[ \t]+STRIDE=\S+[ \t]*$/m);
  if (!m) return input;
  const rest = input.replace(/^FLUSH[ \t]+STRIDE=\S+[ \t]*\n/m, '').replace(/\n*$/, '');
  return `${rest}\n\n# Last, so that every row printed at the same step is written out with it\n${m[0].trim()}\n`;
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/* The work of a moving restraint is exact across a restart only when the
   checkpoint falls on a step it was printed at. Checkpoints fall on GROMACS's
   neighbour-search steps, every nstlist steps (mdrun may raise nstlist to 20,
   25, 40, 50, 80 or 100, all multiples of 5), and on LAMMPS's restart files
   and the steps `timer timeout ... every 1000` stops at, 1000 steps apart
   from the start of each run. */
function workNotes(o, workPrints, needs, warnings) {
  if (!workPrints.length) return;
  const every = Math.max(1, parseInt(o.lmp.restartEvery, 10) || 1);
  const g = o.engine === 'lammps' ? gcd(every, 1000) : 5;
  if (o.engine === 'lammps') {
    needs.notes.push(`LAMMPS continues from the restart files, written every ${every} steps, or from where \`timer timeout\` stopped it, ` +
      `a multiple of 1000 steps into the run: print the work at a stride that divides ${g}, and every restart has its row.`);
  } else {
    needs.notes.push('GROMACS checkpoints on neighbour-search steps, every nstlist steps, and mdrun may raise nstlist to 20, 25, 40, 50, 80 or 100: ' +
      'print the work every 5 steps, or at a stride that divides the nstlist `md.log` reports, and every checkpoint has its row.');
  }
  for (const { file, stride } of workPrints) {
    if (g % stride === 0) continue;
    warnings.push(`The work of the moving restraint is printed to \`${file}\` every ${stride} steps, but a run can continue from a step between two prints ` +
      (o.engine === 'lammps'
        ? `(restart files come every ${every} steps, and \`timer timeout\` stops a run a multiple of 1000 steps in)`
        : '(GROMACS checkpoints every nstlist steps, and mdrun may raise nstlist to 20, 25, 40, 50, 80 or 100)') +
      `. The work done since the last print is then left out of the total at each restart. Print it at a stride that divides ${g}.`);
  }
}

/**
 * Every file of a restart-safe PLUMED job.
 *
 * With `dtPs` left out, a GROMACS job reads the time step from the tpr; given,
 * the tpr must agree with it or the job stops. Walkers in one MPI job get, unless
 * `scheduler.tasksPerNode` says otherwise, the fewest ranks per node that give
 * every walker the same share.
 *
 * @param {{
 *   plumed: object,
 *   engine?: 'gromacs'|'lammps',
 *   layout?: 'single'|'walkers-mpi'|'walkers-files'|'windows',
 *   count?: number,
 *   windows?: {from:number|string, to:number|string, kappa?:string},
 *   dtPs?: number,
 *   gromacs?: {binary?:string, deffnm?:string, extra?:string, chunk?:number},
 *   lammps?: {binary?:string, input?:string, units?:'real'|'metal', timestep?:number,
 *     restartEvery?:number, totalSteps?:number},
 *   scheduler?: object,
 *   temperature?: number|string,
 *   extraFiles?: Object<string, string>
 * }} config - `plumed` is the configuration generatePlumedInput takes.
 * @returns {{files:Array<{path:string, text:string, executable?:boolean}>,
 *   warnings:string[], submit:string, layout:string, engine:string, count:number}}
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
  const requested = Math.max(2, Math.min(256, parseInt(config.count, 10) || 4));
  // The input as the generator writes it, before anything per directory. PACE,
  // the file names and the biased arguments are read from it, so that the
  // script checks what PLUMED will do.
  const probe = inputFor(plumed, {});
  const windows = layout === 'windows' ? windowParams(config.windows, requested, probe, plumed.bias, warnings) : null;
  if (layout === 'windows' && !windows) layout = 'single';
  const count = layout === 'single' ? 1 : requested;
  const prefix = layout === 'windows' ? 'win' : 'w';
  const units = (plumed.units && plumed.units.time) || 'ps';
  const timeUnitPs = TIME_UNIT_PS[units] || 1;
  const lmp = {
    binary: 'lmp', input: 'in.lammps', units: 'real', timestep: 2, restartEvery: 10000, totalSteps: 5000000,
    ...(config.lammps || {})
  };
  if (!LAMMPS_TIME_PS[lmp.units]) lmp.units = 'real';
  const gmx = {
    binary: layout === 'walkers-mpi' ? 'gmx_mpi' : 'gmx', deffnm: 'md', extra: '',
    ...(config.gromacs || {})
  };
  const givenDt = Number(config.dtPs) > 0 ? Number(config.dtPs) : null;
  const dtPs = engine === 'lammps' ? Number(lmp.timestep) * LAMMPS_TIME_PS[lmp.units] : (givenDt || 0.002);
  const scheduler = { scheduler: 'slurm', jobName: 'plumed', nodes: 1, cpusPerTask: 8, tasksPerNode: 1, walltime: '24:00:00', ...(config.scheduler || {}) };
  if (layout === 'walkers-files' || layout === 'windows') {
    scheduler.array = true;
    scheduler.arrayRange = `1-${count}`;
  } else {
    scheduler.array = false;
  }
  const nodes = Math.max(1, parseInt(scheduler.nodes, 10) || 1);
  if (layout === 'walkers-mpi' && !str(config.scheduler && config.scheduler.tasksPerNode)) {
    // The fewest ranks per node that give every walker the same share.
    scheduler.tasksPerNode = count / gcd(count, nodes);
  }
  const ranks = Math.max(1, parseInt(scheduler.tasksPerNode, 10) || 1) * nodes;
  if (layout === 'walkers-mpi') {
    if (ranks < count) {
      warnings.push(`${count} walkers in one MPI job need at least ${count} MPI tasks; the job asks for ${ranks}.`);
    } else if (ranks % count) {
      warnings.push(`${count} walkers in one MPI job need a multiple of ${count} MPI tasks, the same share for each; the job asks for ${ranks}, ` +
        `which ${engine === 'gromacs' ? 'mdrun -multidir' : 'LAMMPS -partition'} refuses.`);
    }
  }
  const hours = runHours(scheduler.walltime) || 23.28;
  const wallSeconds = walltimeToSeconds(scheduler.walltime) || 86400;
  const pace = restartNeeds(plumed.bias, { targets: probe.biased, label: '', input: probe.input }).pace;
  // Chunks and restart intervals are whole numbers of depositions: PLUMED
  // refuses a state interval shorter than PACE.
  const multipleOfPace = (v, fallback) => Math.max(pace, Math.round((parseInt(v, 10) || fallback) / pace) * pace);
  const chunk = multipleOfPace(config.gromacs && config.gromacs.chunk, pace * 100);
  if (method === 'opes') lmp.restartEvery = multipleOfPace(lmp.restartEvery, pace * 20);
  const logsFirst = getScheduler(scheduler.scheduler).logDirAtStart;
  const o = {
    engine, layout, count, prefix, timeUnitPs, dtPs, hours, wallSeconds, chunk, ranks,
    timeLimit: hms(hours),
    // Blank for GROMACS unless a time step was given: job.sh reads the tpr's.
    plumedDt: engine === 'gromacs'
      ? (givenDt ? gromacsPlumedTimestep(givenDt, doubleBuild(gmx.binary) ? 'double' : 'mixed') : '')
      : String(Number(dtPs.toPrecision(15))),
    gmx, lmp, scheduler,
    // SLURM and Grid Engine open the log in logs/ before job.sh runs.
    submit: `${logsFirst ? 'mkdir -p logs && ' : ''}${submitCommand(scheduler.scheduler, 'job.sh')}`,
    temperature: str(config.temperature) || str(plumed.bias && plumed.bias.temp) || '300'
  };
  if (layout === 'walkers-mpi' && !/_mpi(_d)?$/.test(o.gmx.binary) && engine === 'gromacs') {
    warnings.push(`-multidir needs an MPI build of GROMACS, usually called gmx_mpi, not ${o.gmx.binary}.`);
  }

  /* Per-directory inputs. */
  const walkersBase = { ...((plumed.bias && plumed.bias.walkers) || {}) };
  const stateStride = engine === 'lammps' ? String(lmp.restartEvery) : String(chunk);
  // LAMMPS does not tell PLUMED when it writes a restart file, and PLUMED
  // flushes its files every 10 000 steps otherwise, so after a hard kill the
  // files on disk could stop short of the restart file. FLUSH at the restart
  // interval, after every PRINT, closes the gap: PLUMED flushes before LAMMPS
  // writes the file.
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
    if (windows) bias.params = windows[i];
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
  const printLines = (inputs[0].input.match(/^PRINT[ \t].*$/gm) || []);
  const prints = printLines.map(l => ({ line: l, file: keywordValue(l, 'FILE'), stride: steps(keywordValue(l, 'STRIDE')) || 1 }))
    .filter(p => p.file);
  o.prints = prints.length ? prints.map(p => p.file) : ['COLVAR'];
  // Files that print a work, which starts again from zero in a continued run:
  // their row at the checkpoint is the only record of the work done by then.
  const printsWork = inputs[0].printable.some(c => /work$/.test(c));
  const workPrints = prints.filter(p => keywordValue(p.line, 'ARG').split(',')
    .some(a => /work$/.test(a) || (printsWork && /[*?]/.test(a))));
  o.keepRow = new Set();
  for (const { file } of workPrints) {
    o.keepRow.add(file);
    if (layout === 'walkers-mpi') for (let i = 0; i < count; i++) o.keepRow.add(replicaFile(file, i));
  }
  const needs = restartNeeds({ ...(plumed.bias || {}) }, {
    targets: biasTargets, label: biasLabel, input: inputs[0].input, printable: inputs[0].printable
  });
  if (needs.abmd) {
    // The ratchet position, at every step a checkpoint can fall on, in full.
    const every = engine === 'lammps' ? lmp.restartEvery : chunk;
    const line = `PRINT ARG=${needs.abmd.columns.join(',')} FILE=${ABMD_FILE} STRIDE=${every} FMT=%.15g`;
    for (const r of inputs) r.input = r.input.replace(/\n*$/, `\n# The ratchet position, read back when the run continues\n${line}\n`);
    o.prints.push(ABMD_FILE);
  }
  for (const r of inputs) r.input = flushLast(r.input);
  if (needs.state.length && engine === 'lammps') {
    needs.notes.push(`OPES writes its state every ${lmp.restartEvery} steps (STATE_WSTRIDE), the interval of the LAMMPS restart files, so that a restart file and a state always come from the same step.`);
  }
  workNotes(o, workPrints, needs, warnings);

  /* The job script. */
  const title = `PLUMED ${method === 'none' ? 'run' : method.toUpperCase()}, ${RUN_LAYOUTS[layout].toLowerCase()}, ${RUN_ENGINES[engine]}`;
  const head = scriptHeader(o, title);
  warnings.push(...head.warnings.map(w => (typeof w === 'string' ? w : w.message)).filter(Boolean));
  const job = [
    ...head.lines,
    ...envLines(o),
    ...settingLines(o, needs),
    ...(layout === 'walkers-mpi' ? [] : runDirLines(o)),
    ...(layout === 'walkers-mpi' && engine === 'lammps' ? [assign('RANKS_PER_WALKER', Math.max(1, Math.floor(ranks / count)), 'MPI ranks for each walker')] : []),
    '', '# --- Functions ---', COMMON_FUNCTIONS + (engine === 'gromacs' ? GMX_FUNCTIONS : ''),
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
  return { files, warnings: [...new Set(warnings)], submit: o.submit, layout, engine, count };
}
