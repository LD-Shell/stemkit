/**
 * @module core/lammps-workflow-job
 *
 * STEMKit, MD Workflow Generator: the part of submit.sh that runs the
 * stages of a LAMMPS workflow (src/core/lammps-workflow.js builds it).
 * Author: Olanrewaju M. Daramola
 *
 * Each stage is skipped once its restart files reach its last step, and an
 * interrupted one continues from its newest restart file, with the
 * variables the stage files expect (rstep, time_limit, plumed_in). A
 * continued PLUMED stage runs with RESTART, after the rows written past
 * the restart step by a killed run are cut, as the PLUMED tab's job kit
 * (src/core/plumed-run.js) does it; text trajectories are cut the same way.
 */

const num = (v, fallback) => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const fmtCount = (n) => Number(n).toLocaleString('en-GB');
const fmtNum = (x) => {
  const n = Number(x);
  if (!Number.isFinite(n)) return String(x);
  if (n !== 0 && (Math.abs(n) < 1e-4 || Math.abs(n) >= 1e9)) return n.toExponential().replace(/\.?0+e/, 'e').replace('e+', 'e');
  return String(Number(n.toPrecision(10)));
};
const listText = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/* The trajectory file of a stage. */
const trajName = (key, fmt) => (fmt.style ? `${key}.${fmt.ext}` : '');

/* ------------------------------------------------------------------ *
 * The job script
 * ------------------------------------------------------------------ */

/*
 * A value for NAME="..." in the job script. $VAR, $(...) and $((...)) still
 * expand there, as the launcher strings of src/core/scheduler.js need
 * (`mpirun -np $(wc -l < "$PBS_NODEFILE")`). Inside $( ) bash starts a new
 * quoting context, so only a double quote or backslash outside every
 * command substitution is escaped.
 */
export function shellValue(value) {
  const t = String(value == null ? '' : value);
  let out = '';
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '$' && t[i + 1] === '(') { depth++; out += '$('; i++; continue; }
    if (depth > 0 && c === '(') { depth++; out += c; continue; }
    if (depth > 0 && c === ')') { depth--; out += c; continue; }
    if (depth === 0 && (c === '"' || c === '\\')) { out += `\\${c}`; continue; }
    out += c;
  }
  return `"${out}"`;
}

/* A word of the job script: as it is when the shell reads it as one word. */
const shq = (s) => (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(String(s)) ? String(s) : shellValue(s));

/**
 * The bash that submit.sh runs after its header: the stages in order, each
 * skipped once complete, each continued from its newest restart file after
 * a wall-time stop. It reads TIME_LIMIT from the environment (or from
 * `timeLimit`): the wall time LAMMPS may use in this job, in seconds or
 * H:MM:SS, which the job should set a few minutes below its wall time;
 * every stage gets what is left of it. Without it LAMMPS runs without a limit.
 *
 * @param {object} workflow - {@link buildLammpsWorkflow}'s result.
 * @param {object} [opts]
 * @param {string} [opts.lmp='lmp'] - The LAMMPS executable.
 * @param {string} [opts.launch=''] - What starts it on the job's ranks, e.g. 'srun' or 'mpirun -np 4'.
 * @param {string} [opts.flags=''] - Accelerator and package flags, e.g. '-sf omp -pk omp 4'.
 * @param {string|number} [opts.timeLimit] - A default for TIME_LIMIT.
 * @param {number} [opts.minLeft=300] - No stage starts with fewer seconds left.
 * @returns {string}
 */
export function lammpsRunBlock(workflow, { lmp = 'lmp', launch = '', flags = '', timeLimit = '', minLeft = 300 } = {}) {
  const wf = workflow;
  const L = [];
  const plumedStages = wf.stages.filter(p => p.plumed);
  L.push('# ==== LAMMPS: the stages ====');
  L.push('# Each stage is skipped once its restart files reach its last step; an');
  L.push('# interrupted one continues from its newest restart file. LAMMPS stops');
  L.push('# itself (timer timeout) when TIME_LIMIT, the wall time it may use in this');
  L.push('# job (seconds or H:MM:SS), runs out: submit the job again to carry on.');
  const assign = (name, value, comment) => {
    const a = `${name}=${shellValue(value)}`;
    return `${a}${' '.repeat(Math.max(1, 34 - a.length))}# ${comment}`;
  };
  L.push(assign('LMP', str(lmp) || 'lmp', 'the LAMMPS executable'));
  L.push(assign('LMP_LAUNCH', str(launch), 'what starts it on the job\'s MPI ranks'));
  L.push(assign('LMP_FLAGS', str(flags), 'accelerator and package flags'));
  if (str(timeLimit)) L.push(`TIME_LIMIT=\${TIME_LIMIT:-${shellValue(str(timeLimit)).slice(1, -1)}}`);
  L.push(`MIN_LEFT=${Math.max(0, Math.round(num(minLeft, 300)))}${' '.repeat(22)}# seconds: no stage starts with less wall time left`);
  L.push('');
  L.push(String.raw`log() { printf '%s  %s\n' "$(date '+%F %T')" "$*"; }
die() { printf '%s  STOP: %s\n' "$(date '+%F %T')" "$*" >&2; exit 1; }
# Seconds in "H:MM:SS", "MM:SS" or plain seconds.
seconds() { awk -F: '{ s = 0; for (i = 1; i <= NF; i++) s = s * 60 + $i; printf "%d\n", s }' <<< "$1"; }
JOB_START=$(date +%s)
LIMIT=0; [ -n "${'$'}{TIME_LIMIT:-}" ] && LIMIT=$(seconds "$TIME_LIMIT")
# The wall time LAMMPS may still use, in seconds, or "off" without a limit.
time_left() { if [ "$LIMIT" -gt 0 ]; then echo $(( LIMIT - $(date +%s) + JOB_START )); else echo off; fi; }
# The steps of the PREFIX.<step> restart files, newest first.
restart_steps() { local f s; for f in "$1".*; do s=${'$'}{f#"$1".}; case $s in ''|*[!0-9]*) continue ;; esac; echo "$s"; done | sort -rn; }
newest() { restart_steps "$1" | head -n 1; }
# Keep the three newest restart files of a stage.
prune() { restart_steps "$1" | tail -n +4 | while read -r s; do rm -f -- "$1.$s"; done; }
lmp_run() { $LMP_LAUNCH "$LMP" $LMP_FLAGS -log none "$@"; }
# stage LABEL INPUT PREFIX LAST FROM [lammps arguments]: run INPUT until
# PREFIX.LAST exists; a new stage needs FROM, the file it starts from.
stage() {
  local label=$1 input=$2 prefix=$3 last=$4 from=$5 step left; shift 5
  step=$(newest "$prefix")
  if [ -n "$step" ] && [ "$step" -ge "$last" ]; then log "$label: complete ($prefix.$step); skipped."; return 0; fi
  if [ -z "$step" ] && [ -n "$from" ] && [ ! -f "$from" ]; then die "$label cannot start: $from is missing."; fi
  left=$(time_left)
  if [ "$left" != off ] && [ "$left" -lt "$MIN_LEFT" ]; then log "$label: only $left s of wall time left. Submit the job again to carry on."; exit 0; fi
  if [ -n "$step" ]; then log "$label: continuing from $prefix.$step."; else log "$label: starting."; fi
  lmp_run -in "$input" -var rstep "${'$'}{step:--1}" -var time_limit "$left" "$@" || die "LAMMPS stopped in $input: read its log."
  step=$(newest "$prefix"); prune "$prefix"
  if [ -z "$step" ] || [ "$step" -lt "$last" ]; then
    log "$label: stopped at step ${'$'}{step:-0} of $last (wall time). Submit the job again to continue it."
    exit 0
  fi
  log "$label: complete (step $step)."
}`);
  if (plumedStages.length && wf.plumed) {
    const pf = wf.plumed;
    L.push('');
    L.push(`# PLUMED: ${pf.name} is read by ${listText(plumedStages.map(p => p.file))}. A continued stage`);
    L.push('# runs with RESTART added, so PLUMED appends to its files instead of setting');
    L.push('# them aside; rows written after the restart step (by a run that was killed)');
    L.push('# are cut first, so no row appears twice.');
    L.push(`PLUMED_DAT=${shq(pf.name)}`);
    L.push(`PLUMED_DT=${fmtNum(Number(pf.dtPlumed.toPrecision(12)))}${' '.repeat(12)}# PLUMED time per MD step (${pf.natural ? 'natural units' : `${fmtNum(wf.timestep)} ${wf.timeUnit} in PLUMED's time unit`})`);
    L.push(`[ -f "$PLUMED_DAT" ] || die "$PLUMED_DAT is missing: build it in the PLUMED tab and put it here."`);
    L.push('grep -Eq \'^[[:space:]]*RESTART([[:space:]]|$)\' "$PLUMED_DAT" && die "$PLUMED_DAT contains RESTART: take it out. This script adds it when a stage continues."');
    L.push(String.raw`# trim FILE TIME lt|le: keep the rows before TIME (lt) or up to it (le).
trim() {
  [ -s "$1" ] || return 0
  awk -v t="$2" -v mode="$3" -v tol="$(awk -v d="$PLUMED_DT" 'BEGIN { printf "%.6g", d / 2 }')" '
    /^#/ { print; next }
    NF < 2 || $1 !~ /^[-+0-9.eE]+$/ { next }
    ($1 + 0 < t - tol) || (mode == "le" && $1 + 0 <= t + tol) { print }
  ' "$1" > "$1.trim" && mv "$1.trim" "$1"
}
# plumed_prepare PREFIX LAST: sets PLUMED_IN for the next run of a stage.
plumed_prepare() {
  local step t; step=$(newest "$1"); PLUMED_IN=$PLUMED_DAT
  if [ -z "$step" ] || [ "$step" -ge "$2" ]; then return 0; fi
  t=$(awk -v s="$step" -v d="$PLUMED_DT" 'BEGIN { printf "%.9f", s * d }')`);
    for (const f of pf.prints) L.push(`  trim ${shq(f)} "$t" lt`);
    for (const f of pf.hills) L.push(`  trim ${shq(f)} "$t" le`);
    L.push('  { echo RESTART; cat "$PLUMED_DAT"; } > plumed.restart.dat');
    L.push('  PLUMED_IN=plumed.restart.dat');
    L.push('}');
  }
  const textDumps = wf.stages.filter(p => p.dynamics && p.output.dump && wf.dump && wf.dump.append);
  if (textDumps.length) {
    L.push('');
    L.push(String.raw`# dump_prepare PREFIX LAST FILE: a run killed after its newest restart file
# had written frames past it; the continued run writes them again, so they go.
dump_prepare() {
  local step; step=$(newest "$1")
  if [ -z "$step" ] || [ "$step" -ge "$2" ] || [ ! -s "$3" ] || [ ! "$3" -nt "$1.$step" ]; then return 0; fi
  awk -v s="$step" '/^ITEM: TIMESTEP/ { getline t; keep = (t + 0 <= s); if (keep) { print; print t }; next } keep' "$3" > "$3.trim" && mv "$3.trim" "$3"
}`);
  }
  const needs = (wf.needs || []).filter(Boolean);
  if (needs.length) {
    L.push('');
    L.push(`for f in ${needs.map(shq).join(' ')}; do [ -f "$f" ] || die "$f is missing: put it next to the input files (see README.md)."; done`);
  }
  for (const p of wf.stages) {
    L.push('');
    if (!p.dynamics) {
      L.push(`# ---- ${p.label}: ${p.file} -> min.restart ----`);
      L.push('if [ -f min.restart ]; then');
      L.push(`  log "${p.label}: complete (min.restart); skipped."`);
      L.push('else');
      L.push('  left=$(time_left)');
      L.push(`  if [ "$left" != off ] && [ "$left" -lt "$MIN_LEFT" ]; then log "${p.label}: only $left s of wall time left. Submit the job again to carry on."; exit 0; fi`);
      if (!p.first) L.push(`  [ -f ${shq(p.from)} ] || die "${p.label} cannot start: ${p.from} is missing."`);
      L.push(`  log "${p.label}: starting."`);
      L.push(`  lmp_run -in ${p.file} || die "LAMMPS stopped in ${p.file}: read min.log."`);
      L.push(`  [ -f min.restart ] || die "${p.file} ended without writing min.restart: read min.log."`);
      L.push('fi');
      continue;
    }
    L.push(`# ---- ${p.label}: ${p.file}, ${p.time} = ${fmtCount(p.steps)} steps -> ${p.prefix}.${p.steps} ----`);
    const from = p.first ? (p.from && wf.source !== 'lattice' ? p.from : '') : p.from;
    const args = [shq(p.label), p.file, shq(p.prefix), String(p.steps), shq(from || '')];
    if (textDumps.includes(p)) L.push(`dump_prepare ${shq(p.prefix)} ${p.steps} ${shq(trajName(p.key, wf.dump))}`);
    if (p.plumed) {
      L.push(`plumed_prepare ${shq(p.prefix)} ${p.steps}`);
      args.push('-var plumed_in "$PLUMED_IN"');
    }
    L.push(`stage ${args.join(' ')}`);
  }
  L.push('');
  L.push('log "All stages are complete."');
  return `${L.join('\n')}\n`;
}
