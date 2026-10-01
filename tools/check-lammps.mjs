#!/usr/bin/env node
/*
 * check-lammps.mjs: hand real LAMMPS the inputs STEMKit checks, and compare.
 *
 * Two corpora:
 *
 *   1. the example inputs that ship with LAMMPS (lammps/examples, the top
 *      level and PACKAGES): every in.* file is run in a copy of its directory;
 *   2. mutations of the examples that pass: one deliberate mistake each (a
 *      typo in a command or style, a command on the wrong side of the box,
 *      an undefined group, compute or variable, a fix ID reused with another
 *      style, kspace without a long-range pair style and the reverse, an
 *      unknown keyword, a missing value, a removed style ...), made the same
 *      way on every run.
 *
 * Each input runs as `lmp -in <file> -skiprun -log none -echo none`. With
 * -skiprun, LAMMPS returns from run and minimize before it sets anything up
 * (Run::command and Minimize::command stop at once when the timer has timed
 * out, and -skiprun sets a timeout of 0), so the checks LAMMPS makes when a
 * run starts would never happen. Each top-level run and minimize line is
 * therefore rewritten, here and in the files the input includes, into one
 * line that switches the timeout off, sets the run up without taking a step,
 * and switches it on again:
 *
 *     run 10000          ->  if "1" then "timer timeout off" "run 0 post no" "timer timeout 0 every 1"
 *     minimize a b c d   ->  if "1" then "timer timeout off" "minimize a b 0 0" "timer timeout 0 every 1"
 *
 * Line numbers do not change. Then checkInput() reads the same text, with the
 * packages of that binary (from `lmp -h`) and the other files of the
 * directory for include, and the verdicts are compared:
 *
 *   - LAMMPS finishes: STEMKit must report no error;
 *   - LAMMPS stops: STEMKit's first error must be on the line LAMMPS stops on
 *     (its "Last command:" mapped to the logical line that ran last with that
 *     text), unless the error is of a class STEMKit cannot know from the
 *     script alone (the content of a data, restart or potential file, a file
 *     that is not there, a value only a run produces, the MPI environment).
 *     Then STEMKit must simply not stop earlier.
 *
 * Screen output goes to stdout through `stdbuf -oL`: with -screen <file> the
 * message of an error that aborts (error->one) is lost in the file buffer.
 *
 * Inputs with `fix plumed` run in LMP_PLUMED_BIN when it is given. A LAMMPS
 * that crashes or hangs (a few examples wait for a network peer) is not
 * compared, and is counted as such.
 *
 *     LMP_BIN=/path/to/lmp [LMP_PLUMED_BIN=/path/to/lmp-with-plumed] \
 *       node tools/check-lammps.mjs [--verbose] [--list] [--only <text>] [--jobs 2]
 *         [--examples-only|--mutations-only] [--per-mutation 12] [--timeout 90]
 *         [--workdir <dir>] [--keep]
 *
 * --workdir keeps the LAMMPS results (keyed by binary and input) between runs,
 * so a second run only re-checks STEMKit. --list prints every case.
 *
 * LAMMPS_SRC points at the LAMMPS source tree (default ./lammps). Exits 0
 * when everything agrees, or when LMP_BIN is unset (nothing to check).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkInput, parseInput, loadLammpsDetails } from '../src/core/lammps-input.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(process.env.LAMMPS_SRC || path.join(ROOT, 'lammps'));
const LMP = process.env.LMP_BIN || '';
const LMP_PLUMED = process.env.LMP_PLUMED_BIN || '';
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : d; };
const verbose = flag('--verbose');
const keep = flag('--keep');
const only = opt('--only', '');
const jobs = Math.max(1, Math.min(4, Number(opt('--jobs', 2))));
const TIMEOUT = Number(opt('--timeout', 90)) * 1000;

if (!LMP) {
  console.log('LMP_BIN is not set; nothing to check.');
  process.exit(0);
}
if (!fs.existsSync(path.join(SRC, 'examples'))) {
  console.log(`No LAMMPS examples at ${SRC}/examples (set LAMMPS_SRC).`);
  process.exit(2);
}

const work = opt('--workdir', '') ? path.resolve(opt('--workdir')) : fs.mkdtempSync(path.join(os.tmpdir(), 'stemkit-lmp-'));
fs.mkdirSync(work, { recursive: true });
const CACHE_FILE = path.join(work, 'lammps-results.json');
const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};

/* ------------------------------------------------------------------ *
 * The binaries
 * ------------------------------------------------------------------ */

function packagesOf(bin) {
  const r = spawnSync(bin, ['-h'], { encoding: 'utf8', env: { ...process.env, OMP_NUM_THREADS: '1' }, maxBuffer: 1 << 24 });
  const out = `${r.stdout || ''}`;
  const m = /Installed packages:\s*\n\n?([\s\S]*?)\n\s*\n/.exec(out);
  if (!m) throw new Error(`Cannot read the installed packages from ${bin} -h`);
  const version = (/Simulator - ([^\n]+)/.exec(out) || [])[1] || '';
  return { packages: m[1].split(/\s+/).filter(Boolean), version };
}

const BINS = { lmp: { bin: LMP, ...packagesOf(LMP) } };
if (LMP_PLUMED) BINS.plumed = { bin: LMP_PLUMED, ...packagesOf(LMP_PLUMED) };
const binKey = (b) => {
  const st = fs.statSync(fs.realpathSync(b.bin.split(' ')[0]));
  return `${b.bin}|${st.size}|${st.mtimeMs}`;
};

/* ------------------------------------------------------------------ *
 * Running LAMMPS on a case
 * ------------------------------------------------------------------ */

function treeFor(k) {
  const t = path.join(work, `tree${k}`);
  if (!fs.existsSync(t)) {
    fs.mkdirSync(t, { recursive: true });
    for (const e of fs.readdirSync(SRC)) if (e !== 'examples') fs.symlinkSync(path.join(SRC, e), path.join(t, e));
  }
  return t;
}

/* Run one input text in a fresh copy of its example directory. */
function runLammps(c, tree) {
  return new Promise((resolve) => {
    const dir = path.join(tree, c.dir);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.cpSync(path.join(SRC, c.dir), dir, { recursive: true, verbatimSymlinks: true });
    const input = '__stemkit_case.in';
    fs.writeFileSync(path.join(dir, input), c.text);
    for (const n of c.changed) fs.writeFileSync(path.join(dir, n), c.files[n]);
    const bin = BINS[c.bin].bin;
    const t0 = Date.now();
    const p = spawn('nice', ['stdbuf', '-oL', '-eL', bin, '-in', input, '-skiprun', '-log', 'none', '-echo', 'none'],
      { cwd: dir, env: { ...process.env, OMP_NUM_THREADS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => { if (out.length < 4e6) out += d; });
    p.stderr.on('data', d => { if (out.length < 4e6) out += d; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, TIMEOUT);
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      fs.rmSync(dir, { recursive: true, force: true });
      const m = /ERROR(?: on proc \d+)?: ([^\n]*?)(?: \([^()\n]*:\d+\))?\nLast command: ([^\n]*(?:\n(?!-{10}|\n|NOTE|MPI_ABORT|\[)[^\n]*)*)/.exec(out);
      const plain = m ? null : /ERROR(?: on proc \d+)?: ([^\n]*)/.exec(out);
      resolve({
        code, signal, timedOut, ms: Date.now() - t0,
        error: m ? m[1] : plain ? plain[1].replace(/ \([^()\n]*:\d+\)$/, '') : null,
        last: m ? m[2].replace(/\s+$/, '') : null,
        warnings: [...out.matchAll(/WARNING: ([^\n]*?)(?: \([^()\n]*:\d+\))?\n/g)].map(x => x[1]).slice(0, 40)
      });
    });
  });
}

async function runAll(cases) {
  const todo = cases.filter(c => !cache[c.key]);
  let next = 0;
  let done = 0;
  const worker = async (k) => {
    const tree = treeFor(k);
    while (next < todo.length) {
      const c = todo[next++];
      cache[c.key] = await runLammps(c, tree);
      done += 1;
      if (done % 50 === 0) {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
        if (verbose) console.log(`  ... ${done}/${todo.length} LAMMPS runs`);
      }
    }
  };
  await Promise.all(Array.from({ length: jobs }, (_, k) => worker(k)));
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
}

/* ------------------------------------------------------------------ *
 * The cases
 * ------------------------------------------------------------------ */

function findExamples() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /^in\./.test(e.name)) out.push(path.relative(SRC, p));
    }
  };
  walk(path.join(SRC, 'examples'));
  return out;
}

/* The other text files of a directory, for include and jump. */
const filesCache = new Map();
function dirFiles(dir) {
  if (filesCache.has(dir)) return filesCache.get(dir);
  const files = {};
  for (const e of fs.readdirSync(path.join(SRC, dir), { withFileTypes: true })) {
    const p = path.join(SRC, dir, e.name);
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > 512 * 1024) continue;
      const text = fs.readFileSync(p, 'utf8');
      if (text.includes('\u0000')) continue;
      files[e.name] = text;
    } catch { /* a broken link */ }
  }
  filesCache.set(dir, files);
  return files;
}

/* The rewrite described at the top: each run sets up without taking steps. */
function setupRuns(text) {
  if (!/^\s*(run|minimize)\s/m.test(text)) return text;
  const lines = text.split('\n');
  const parsed = parseInput(text).lines.filter(l => l.kind === 'command' && (l.command === 'run' || l.command === 'minimize'));
  for (const l of parsed.reverse()) {
    if (l.hasVars && l.command === 'minimize') {
      // minimize ${a} ${b} ...: keep the tolerances, whatever they are.
    }
    const a = l.args;
    const inner = l.command === 'run' ? 'run 0 post no' : `minimize ${a[0] ?? 0} ${a[1] ?? 0} 0 0`;
    const repl = `if "1" then "timer timeout off" "${inner}" "timer timeout 0 every 1"`;
    const blank = Array.from({ length: l.lastLine - l.line }, () => '');
    lines.splice(l.line - 1, l.lastLine - l.line + 1, repl, ...blank);
  }
  return lines.join('\n');
}

const usesPlumed = (text) => /^\s*fix\s+\S+\s+\S+\s+plumed\b/m.test(text);

function makeCase(kind, name, dir, file, original) {
  const text = setupRuns(original);
  const bin = usesPlumed(text) && BINS.plumed ? 'plumed' : 'lmp';
  const files = {};
  for (const [n, t] of Object.entries(dirFiles(dir))) files[n] = setupRuns(t);
  const changed = Object.entries(files).filter(([n, t]) => t !== dirFiles(dir)[n]).map(([n]) => n);
  const key = crypto.createHash('sha1').update(`${binKey(BINS[bin])}\n${dir}\n${text}\n${changed.map(n => `${n}\n${files[n]}`).join('\n')}`).digest('hex');
  return { kind, name, dir, file, original, text, bin, key, files, changed };
}

/* ------------------------------------------------------------------ *
 * Comparing
 * ------------------------------------------------------------------ */

/*
 * Errors whose cause is outside the script: the class, and why STEMKit
 * cannot know it. Checked in order; the first match wins.
 */
const CLASSES = [
  ['environment', 'needs MPI ranks, partitions, a GPU, Python, KIM, a plugin or a network connection (IMD) that this run does not have',
    /World variable count|partition|Python|python|KIM|kim_|GPU|Kokkos|KOKKOS|processors|# of procs|Universe\/uloop|lock file|plugin|MPI|mdi|MDI|error in IMD/],
  ['lammps-bug', 'is a consistency check inside LAMMPS that fails for this style ("Contact the developer"), not a mistake in the input',
    /Contact the developer|contact the developers/],
  ['files', 'reads a file that is not in the example directory (often written by another example)',
    /Cannot open|cannot open|No such file|Could not open|Unable to open|unable to open|does not exist: |File .* not found|Cannot read|Error opening/],
  ['data', 'depends on the content of a data, restart, molecule or potential file',
    /section|data file|Data file|restart file|Restart file|potential file|Potential file|parameter file|Molecule file|molecule file|Invalid atom type|Invalid bond type|Invalid angle type|Invalid atom ID|Atom IDs must|Did not assign all|Incorrect format|Unexpected end of|Unknown identifier|(Bond|Angle|Dihedral|Improper) atoms? .*missing|bond atoms missing|All (bond|angle|dihedral|improper) coeffs are not set|coeffs are not set|Bond coeffs for|element|Element|Invalid .* in .* file|tabulated|Table|table file|Invalid .*keyword in .* file|ffield|library file|Did not find keyword/],
  ['runtime', 'needs a value only a run produces (runs here are set up but take no steps, so averages, energies and moved atoms are not there yet)',
    /Energy was not tallied|Box bounds are invalid|Divide by 0 in variable|Modulo 0|not computed at compatible time|Lost atoms|Out of range atoms|Neighbor list overflow|is not current|Shake|SHAKE|Domain too large|Too many|Non-numeric|nan|NaN|inf\b|Invalid timestep reset|bad timestep|Atom count|Insertion|insert|Overlap|overlap|Rigid body atoms|rigid body|Cannot (compute|use) .* with 0 atoms|no atoms|Sqrt of negative|Log of zero|Arcsin|Arccos|Invalid power|Fix .* not computed|Variable .* is not current|Compute used in variable .* is not current|out of range|exceeds|Fix ave.* does not|Fix bond|Must not have/]
];

function classify(error) {
  for (const [id, why, re] of CLASSES) if (re.test(error)) return { id, why };
  return null;
}

/*
 * Where LAMMPS stopped: a command that ran with the "Last command" text.
 * LAMMPS prints the command as it read it (continuation lines joined), or,
 * for print and if, the text it was working on. When that text ran more than
 * once (a loop), the first time is taken, unless STEMKit's own first error is
 * on one of them.
 */
function stopIndex(trace, last, firstAt) {
  if (last === null || last === undefined) return -1;
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
  const want = norm(last);
  if (!want) return -1;
  const exact = [];
  const loose = [];
  for (let i = 0; i < trace.length; i++) {
    const t = norm(trace[i].text);
    if (t === want) exact.push(i);
    else if ((t.includes(want) && want.length > 2) || (want.includes(t) && t.length > 8)) loose.push(i);
  }
  const list = exact.length ? exact : loose;
  if (!list.length) return -1;
  if (list.includes(firstAt)) return firstAt;
  return list[0];
}

const where = (t) => (t ? `${t.file ? `${t.file}:` : ''}${t.line}` : '?');

function compare(c, lmp) {
  const mine = checkInput(c.text, { packages: BINS[c.bin].packages, files: c.files });
  const first = mine.firstError;
  const firstAt = mine.firstErrorAt;
  const res = { case: c, lmp, mine, first };
  if (lmp.timedOut) return { ...res, verdict: 'skip', why: 'LAMMPS did not finish within the time limit' };
  if (lmp.signal && !lmp.error) {
    // LAMMPS crashes on charge() without charges; STEMKit says so instead.
    if (first && first.id === 'charge-crash') return { ...res, verdict: 'agree' };
    return { ...res, verdict: 'skip', why: `LAMMPS crashed (${lmp.signal})` };
  }
  if (!lmp.error && lmp.code !== 0) return { ...res, verdict: 'skip', why: `LAMMPS exited with ${lmp.code} and no message` };
  if (!lmp.error) {
    return first ? { ...res, verdict: 'disagree', why: `LAMMPS finishes; STEMKit stops at ${where(first)}: ${first.lammps || first.message}` }
      : { ...res, verdict: 'agree' };
  }
  const at = stopIndex(mine.trace, lmp.last, firstAt);
  const stopLine = at >= 0 ? mine.trace[at] : null;
  const cls = classify(lmp.error);
  const sameLine = first && stopLine && (first.file || '') === (stopLine.file || '') && first.line === stopLine.line;
  if (sameLine) return { ...res, verdict: 'agree', stopLine };
  if (cls) {
    if (!first || (at >= 0 && firstAt > at) || (at < 0 && !first)) return { ...res, verdict: 'class', cls, stopLine };
    return { ...res, verdict: 'disagree', cls, stopLine, why: `LAMMPS stops at ${where(stopLine)} (${cls.id}: ${lmp.error}); STEMKit stops earlier, at ${where(first)}: ${first.lammps || first.message}` };
  }
  if (at < 0) return { ...res, verdict: 'disagree', why: `LAMMPS stops ("${lmp.error}", last command "${String(lmp.last).slice(0, 80)}") on a command STEMKit did not run; STEMKit ${first ? `stops at ${where(first)}: ${first.lammps || first.message}` : 'finds no error'}` };
  return { ...res, verdict: 'disagree', stopLine, why: `LAMMPS stops at ${where(stopLine)}: "${lmp.error}"; STEMKit ${first ? `stops at ${where(first)}: ${first.lammps || first.message}` : 'finds no error'}` };
}

/* ------------------------------------------------------------------ *
 * Mutations
 * ------------------------------------------------------------------ */

/* Logical lines with their physical extent, to edit a text by command. */
function commands(text) {
  return parseInput(text).lines.filter(l => l.kind === 'command' && !l.hasVars);
}

function replaceLine(text, l, newText) {
  const lines = text.split('\n');
  lines.splice(l.line - 1, l.lastLine - l.line + 1, newText);
  return lines.join('\n');
}

function insertAfter(text, l, newText) {
  const lines = text.split('\n');
  lines.splice(l.lastLine, 0, newText);
  return lines.join('\n');
}

function insertBefore(text, l, newText) {
  const lines = text.split('\n');
  lines.splice(l.line - 1, 0, newText);
  return lines.join('\n');
}

function moveLine(text, from, beforeLine) {
  const lines = text.split('\n');
  const block = lines.slice(from.line - 1, from.lastLine);
  lines.splice(from.line - 1, block.length);
  const at = beforeLine.line - 1 - (beforeLine.line > from.line ? block.length : 0);
  lines.splice(at, 0, ...block);
  return lines.join('\n');
}

const BOX = /^(read_data|read_restart|create_box)$/;
const typo = (w) => (w.length > 4 ? w.slice(0, 2) + w.slice(3) : `${w}x`);

/*
 * Each mutation: a name and a function (text, commands) -> new text or null
 * when it does not apply to this example.
 */
const MUTATIONS = [
  ['typo-command', (t, cs) => {
    const l = cs.find(x => /^(velocity|thermo_style|neighbor|neigh_modify|timestep|thermo)$/.test(x.command));
    return l && replaceLine(t, l, l.text.replace(l.command, typo(l.command)));
  }],
  ['typo-fix-style', (t, cs) => {
    const l = cs.find(x => x.command === 'fix' && x.args[2] && /^(nve|nvt|npt|langevin|enforce2d|setforce|momentum)$/.test(x.args[2]));
    return l && replaceLine(t, l, `fix ${l.args[0]} ${l.args[1]} ${l.args[2]}e ${l.args.slice(3).join(' ')}`);
  }],
  ['typo-pair-style', (t, cs) => {
    const l = cs.find(x => x.command === 'pair_style' && x.args[0] && !/^hybrid/.test(x.args[0]));
    return l && replaceLine(t, l, `pair_style ${l.args[0]}x ${l.args.slice(1).join(' ')}`);
  }],
  ['units-after-box', (t, cs) => {
    const u = cs.find(x => x.command === 'units');
    const b = cs.find(x => BOX.test(x.command));
    return u && b && b.line > u.line && insertAfter(t, b, u.text);
  }],
  ['atom-style-after-box', (t, cs) => {
    const b = cs.find(x => BOX.test(x.command));
    const a = cs.find(x => x.command === 'atom_style');
    return a && b && b.line > a.line && insertAfter(t, b, a.text);
  }],
  ['pair-coeff-before-box', (t, cs) => {
    const b = cs.find(x => BOX.test(x.command));
    const p = cs.find(x => x.command === 'pair_coeff');
    return b && p && p.line > b.line && moveLine(t, p, b);
  }],
  ['mass-before-box', (t, cs) => {
    const b = cs.find(x => BOX.test(x.command));
    const p = cs.find(x => x.command === 'mass');
    return b && p && p.line > b.line && moveLine(t, p, b);
  }],
  ['velocity-before-box', (t, cs) => {
    const b = cs.find(x => BOX.test(x.command));
    const p = cs.find(x => x.command === 'velocity');
    return b && p && p.line > b.line && moveLine(t, p, b);
  }],
  ['second-read-data', (t, cs) => {
    const b = cs.find(x => x.command === 'read_data');
    return b && insertAfter(t, b, b.text.replace(/#.*/, ''));
  }],
  ['create-atoms-before-box', (t, cs) => {
    const b = cs.find(x => x.command === 'create_box');
    const p = cs.find(x => x.command === 'create_atoms');
    return b && p && p.line > b.line && moveLine(t, p, b);
  }],
  ['undefined-group', (t, cs) => {
    const l = cs.find(x => x.command === 'fix' && x.args.length > 3);
    return l && replaceLine(t, l, `fix ${l.args[0]} nosuchgroup ${l.args.slice(2).join(' ')}`);
  }],
  ['undefined-compute-thermo', (t, cs) => {
    const l = cs.find(x => x.command === 'thermo_style' && x.args[0] === 'custom');
    return l && replaceLine(t, l, `${l.code.trim()} c_nosuchcompute`);
  }],
  ['undefined-fix-thermo', (t, cs) => {
    const l = cs.find(x => x.command === 'thermo_style' && x.args[0] === 'custom');
    return l && replaceLine(t, l, `${l.code.trim()} f_nosuchfix`);
  }],
  ['undefined-variable-thermo', (t, cs) => {
    const l = cs.find(x => x.command === 'thermo_style' && x.args[0] === 'custom');
    return l && replaceLine(t, l, `${l.code.trim()} v_nosuchvar`);
  }],
  ['unknown-thermo-keyword', (t, cs) => {
    const l = cs.find(x => x.command === 'thermo_style' && x.args[0] === 'custom');
    return l && replaceLine(t, l, `${l.code.trim()} tempp`);
  }],
  ['fix-id-reused', (t, cs) => {
    const l = cs.find(x => x.command === 'fix' && x.args[2] && x.args[2] !== 'momentum' && x.args.length > 3);
    return l && insertAfter(t, l, `fix ${l.args[0]} ${l.args[1]} momentum 100 linear 1 1 1`);
  }],
  ['compute-id-reused', (t, cs) => {
    const l = cs.find(x => x.command === 'compute' && x.args.length >= 3);
    return l && insertAfter(t, l, `compute ${l.args[0]} all ke`);
  }],
  ['kspace-without-long-pair', (t, cs) => {
    const k = cs.find(x => x.command === 'kspace_style');
    if (k) return null;
    const p = cs.find(x => x.command === 'pair_style');
    return p && insertAfter(t, p, 'kspace_style pppm 1.0e-4');
  }],
  ['long-pair-without-kspace', (t, cs) => {
    const k = cs.find(x => x.command === 'kspace_style');
    if (!k) return null;
    const out = t.split('\n').map((s, i) => (i + 1 >= k.line && i + 1 <= k.lastLine ? `# ${s}` : /^\s*kspace_modify/.test(s) ? `# ${s}` : s));
    return out.join('\n');
  }],
  ['unknown-fix-keyword', (t, cs) => {
    const l = cs.find(x => x.command === 'fix' && /^(nvt|npt|nph|langevin|temp\/berendsen|temp\/rescale|setforce|momentum|ave\/time|shake|rigid|rigid\/small|deform|box\/relax)$/.test(x.args[2]));
    return l && replaceLine(t, l, `${l.code.trim()} bogus 1`);
  }],
  ['missing-keyword-value', (t, cs) => {
    const l = cs.find(x => x.command === 'fix' && /^(nvt|npt|nph)$/.test(x.args[2]) && /^(temp|iso|aniso|tri|x|y|z)$/.test(x.args[x.args.length - 4] || ''));
    return l && replaceLine(t, l, `fix ${l.args.slice(0, -1).join(' ')}`);
  }],
  ['undefined-variable', (t, cs) => {
    // Not on run lines: the rewrite above replaces their arguments.
    const l = cs.find(x => /^(thermo|timestep)$/.test(x.command) && x.args.length);
    return l && replaceLine(t, l, `${l.command} \${nosuchvariable}`);
  }],
  ['removed-style', (t, cs) => {
    const b = cs.filter(x => x.command === 'run').pop();
    return b && insertBefore(t, b, 'fix stemkit_removed all ave/spatial 10 10 100 x lower 0.5 vx');
  }],
  ['renamed-and-ignored-commands', (t, cs) => {
    // reset_ids runs as reset_atoms id (with a warning) and box is ignored: LAMMPS goes on.
    const b = cs.find(x => BOX.test(x.command));
    return b && insertAfter(t, b, 'reset_ids\nbox tilt large');
  }],
  ['removed-command', (t, cs) => {
    const b = cs.find(x => BOX.test(x.command));
    return b && insertAfter(t, b, 'message client md file tmp.couple');
  }],
  ['unfix-unknown', (t, cs) => {
    const b = cs.filter(x => x.command === 'run').pop();
    return b && insertBefore(t, b, 'unfix nosuchfix');
  }],
  ['uncompute-unknown', (t, cs) => {
    const b = cs.filter(x => x.command === 'run').pop();
    return b && insertBefore(t, b, 'uncompute nosuchcompute');
  }],
  ['undump-unknown', (t, cs) => {
    const b = cs.filter(x => x.command === 'run').pop();
    return b && insertBefore(t, b, 'undump nosuchdump');
  }],
  ['group-undefined-region', (t, cs) => {
    const b = cs.find(x => BOX.test(x.command));
    return b && insertAfter(t, b, 'group stemkit region nosuchregion');
  }],
  ['bad-timestep', (t, cs) => {
    const l = cs.find(x => x.command === 'timestep');
    return l && replaceLine(t, l, 'timestep 2fs');
  }],
  ['bad-units', (t, cs) => {
    const l = cs.find(x => x.command === 'units');
    return l && replaceLine(t, l, `units ${l.args[0]}x`);
  }],
  ['variable-restyled', (t, cs) => {
    const l = cs.find(x => x.command === 'variable' && x.args[1] === 'equal');
    return l && insertAfter(t, l, `variable ${l.args[0]} string abc`);
  }],
  ['pair-coeff-count', (t, cs) => {
    const ps = cs.find(x => x.command === 'pair_style' && /^lj\/cut(\/coul\/(cut|long))?$|^lj\/charmm\/coul\/long$/.test(x.args[0]));
    const l = ps && cs.find(x => x.command === 'pair_coeff' && x.line > ps.line);
    return l && replaceLine(t, l, `${l.code.trim()} 1.0 2.0 3.0`);
  }],
  ['dump-undefined-group', (t, cs) => {
    const l = cs.find(x => x.command === 'dump' && x.args.length >= 5);
    return l && replaceLine(t, l, `dump ${l.args[0]} nosuchgroup ${l.args.slice(2).join(' ')}`);
  }],
  ['dump-custom-bad-column', (t, cs) => {
    const l = cs.find(x => x.command === 'dump' && x.args[2] === 'custom');
    return l && replaceLine(t, l, `${l.code.trim()} velocity`);
  }],
  ['bond-coeff-count', (t, cs) => {
    const l = cs.find(x => /^(bond|angle)_coeff$/.test(x.command) && x.args.length >= 3);
    return l && replaceLine(t, l, `${l.code.trim()} 1.0`);
  }],
  ['special-bonds-bad-keyword', (t, cs) => {
    const l = cs.find(x => x.command === 'special_bonds');
    return l && replaceLine(t, l, `${l.code.trim()} lj/col 0 0 0.5`);
  }],
  ['velocity-bad-seed', (t, cs) => {
    const l = cs.find(x => x.command === 'velocity' && x.args[1] === 'create' && /^\d+$/.test(x.args[3] || ''));
    return l && replaceLine(t, l, `velocity ${l.args[0]} create ${l.args[2]} 0 ${l.args.slice(4).join(' ')}`);
  }],
  ['drop-mass-lines', (t, cs) => {
    // Without mass lines LAMMPS stops at the run, unless the pair style
    // (EAM, MEAM, ADP, EIM, BOP) sets the masses from its potential file.
    const ms = cs.filter(x => x.command === 'mass');
    if (!ms.length || !cs.some(x => x.command === 'create_box')) return null;
    let out = t;
    for (const m of ms.slice().reverse()) out = replaceLine(out, m, `# ${m.raw.split('\n').join(' ')}`);
    return out;
  }],
  ['quote-unbalanced', (t, cs) => {
    const l = cs.find(x => x.command === 'print');
    return l && replaceLine(t, l, `print "unbalanced ${l.args[0] ? 'quote' : ''}`);
  }]
];

const PER_MUTATION = Number(opt('--per-mutation', 12));

function mutationsOf(passing) {
  const out = [];
  for (const [name, fn] of MUTATIONS) {
    let n = 0;
    // Spread the picks over the corpus: examples in a fixed, hashed order.
    const order = passing.slice().sort((a, b) => crypto.createHash('md5').update(name + a.name).digest('hex').localeCompare(crypto.createHash('md5').update(name + b.name).digest('hex')));
    for (const c of order) {
      if (n >= PER_MUTATION) break;
      let text;
      try { text = fn(c.original, commands(c.original)); } catch { text = null; }
      if (!text || text === c.original) continue;
      out.push(makeCase('mutation', `${name}: ${c.name}`, c.dir, c.file, text));
      n += 1;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

await loadLammpsDetails();

const report = (title, results) => {
  const n = (v) => results.filter(r => r.verdict === v).length;
  const classes = {};
  for (const r of results.filter(x => x.verdict === 'class')) classes[r.cls.id] = (classes[r.cls.id] || 0) + 1;
  const compared = results.length - n('skip');
  console.log(`${title}: ${n('agree') + n('class')}/${compared} agree (${n('agree')} on the verdict and line, ${n('class')} where LAMMPS stops for a reason outside the script` +
    `${Object.keys(classes).length ? `: ${Object.entries(classes).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}); ${n('skip')} not compared.`);
  return { agree: n('agree') + n('class'), compared, disagree: results.filter(r => r.verdict === 'disagree') };
};

console.log(`LAMMPS ${BINS.lmp.version}; packages: ${BINS.lmp.packages.join(' ')}`);
if (BINS.plumed) console.log(`With PLUMED: ${BINS.plumed.bin}`);
console.log(`Work directory ${work}`);

const files = findExamples().filter(f => !only || f.includes(only));
const exampleCases = files.map(f => makeCase('example', f, path.dirname(f), path.basename(f), fs.readFileSync(path.join(SRC, f), 'utf8')));

let failures = 0;
let exResults = [];
if (!flag('--mutations-only')) {
  await runAll(exampleCases);
  exResults = exampleCases.map(c => compare(c, cache[c.key]));
}

let muResults = [];
if (!flag('--examples-only')) {
  if (!exResults.length) {
    await runAll(exampleCases);
    exResults = exampleCases.map(c => compare(c, cache[c.key]));
  }
  const passing = exResults.filter(r => r.verdict === 'agree' && !r.case.case && !r.lmp.error).map(r => r.case);
  const muCases = mutationsOf(passing);
  await runAll(muCases);
  muResults = muCases.map(c => compare(c, cache[c.key]));
}

console.log('');
const ex = exResults.length && !flag('--mutations-only') ? report('Examples', exResults) : null;
const mu = muResults.length ? report('Mutations', muResults) : null;

if (mu) {
  // Per kind of mistake: cases, how many LAMMPS stops on, how many agree.
  const kinds = {};
  for (const r of muResults) {
    const k = r.case.name.split(':')[0];
    const e = kinds[k] || (kinds[k] = { n: 0, stops: 0, agree: 0 });
    e.n += 1;
    if (r.lmp && r.lmp.error) e.stops += 1;
    if (r.verdict === 'agree' || r.verdict === 'class') e.agree += 1;
  }
  console.log(`  By mistake (cases / LAMMPS stops / agree): ${Object.entries(kinds).map(([k, e]) => `${k} ${e.n}/${e.stops}/${e.agree}`).join('; ')}`);
}
const pkgMissing = exResults.filter(r => r.lmp && r.lmp.error && /package which is not enabled/.test(r.lmp.error)).length;
if (ex) console.log(`  ${pkgMissing} examples stop on a style from a package this build lacks (STEMKit is told the packages and must say the same).`);
const classCount = [...exResults, ...muResults].filter(r => r.verdict === 'class');
if (classCount.length) {
  console.log(`  Reasons outside the script: ${classCount.length} cases`);
  for (const [id, why] of CLASSES) {
    const k = classCount.filter(r => r.cls.id === id).length;
    if (k) console.log(`    ${id} (${k}): ${why}`);
  }
}
const skipped = [...exResults, ...muResults].filter(r => r.verdict === 'skip');
for (const r of skipped) if (verbose) console.log(`  skipped ${r.case.name}: ${r.why}`);
if (skipped.length) console.log(`  Not compared: ${skipped.length} (${[...new Set(skipped.map(r => r.why.replace(/\(.*\)|\d+/g, '').trim()))].join('; ')})`);

/*
 * Warnings: of the LAMMPS warnings STEMKit models, how many it also gives
 * (where LAMMPS finished, so every warning was printed).
 */
const WARNINGS = [
  [/No fixes with time integration/, 'no-integrator'],
  [/time integrated more than once/, 'double-integration'],
  [/Changing timestep from/, 'units-resets-timestep'],
  [/Replacing a fix, but new group != old group/, 'fix-replace-group'],
  [/New thermo_style command, previous thermo_modify settings will be lost/, 'thermo-modify-lost'],
  [/Use special bonds = 0,1,1 with bond style fene/, 'special-bonds'],
  [/has been renamed to/, 'renamed-command'],
  [/Detected non-ASCII characters/, 'non-ascii']
];
let wSeen = 0;
let wGot = 0;
const wMissed = {};
for (const r of [...exResults, ...muResults]) {
  if (!r.lmp || r.lmp.error || r.verdict !== 'agree') continue;
  for (const [re, id] of WARNINGS) {
    if (!r.lmp.warnings.some(w => re.test(w))) continue;
    wSeen += 1;
    if (r.mine.issues.some(i => i.id === id)) wGot += 1;
    else wMissed[id] = (wMissed[id] || 0) + 1;
  }
}
// Where both stop on the same line: does STEMKit quote the message LAMMPS prints?
const sameLine = [...exResults, ...muResults].filter(r => r.verdict === 'agree' && r.lmp && r.lmp.error && r.first);
const sameText = sameLine.filter(r => (r.first.lammps || '').trim() === r.lmp.error.replace(/^Variable \S+: /, '').trim() || (r.first.lammps || '').trim() === r.lmp.error.trim());
console.log(`Messages: where both stop on the same line, STEMKit quotes LAMMPS's own message word for word in ${sameText.length} of ${sameLine.length} cases.`);
if (verbose) for (const r of sameLine.filter(x => !sameText.includes(x)).slice(0, 40)) console.log(`  differs: ${r.case.name}\n      LAMMPS:  ${r.lmp.error}\n      STEMKit: ${r.first.lammps || r.first.message}`);
console.log(`Warnings: STEMKit gives ${wGot} of the ${wSeen} modelled LAMMPS warnings printed by inputs that run` +
  `${Object.keys(wMissed).length ? ` (missed: ${Object.entries(wMissed).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}.`);

const dis = [...(ex ? ex.disagree : []), ...(mu ? mu.disagree : [])];
if (dis.length) {
  console.log(`\nDisagreements (${dis.length}):`);
  for (const r of dis) console.log(`  ${r.case.name}\n      ${r.why}`);
  failures += dis.length;
}

if (flag('--list')) {
  for (const r of [...exResults, ...muResults]) {
    console.log(`${r.verdict.padEnd(8)} ${r.case.name} | LAMMPS: ${r.lmp && r.lmp.error ? r.lmp.error.slice(0, 100) : 'ok'} | STEMKit: ${r.first ? `${where(r.first)} ${(r.first.lammps || r.first.id).slice(0, 80)}` : 'ok'}`);
  }
}

if (!keep && !opt('--workdir', '')) fs.rmSync(work, { recursive: true, force: true });
console.log(failures ? `\n${failures} disagreement(s).` : '\nSTEMKit agrees with LAMMPS on every case.');
process.exit(failures ? 1 : 0);
