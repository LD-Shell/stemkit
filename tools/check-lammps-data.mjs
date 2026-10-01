#!/usr/bin/env node
/*
 * check-lammps-data.mjs: hand every data file of the LAMMPS examples (and
 * broken copies of some of them) to LAMMPS itself, and compare what
 * read_data makes of it with what src/core/lammps-data.js makes of it.
 *
 *     LMP_BIN=/path/to/lmp node tools/check-lammps-data.mjs [--verbose] [--no-mutants]
 *       [--only <substring>] [--limit N] [--big] [file ...]
 *
 * The cases: each example input script's first read_data, with the units,
 * atom_style, dimension, boundary and fix property/atom commands it gives
 * before it; then every data.* file no script reads, with the atom style
 * its "# style" comment names or STEMKit infers from the columns. Files
 * named on the command line are read as their comment or columns say.
 * Atom styles the LAMMPS binary lacks are skipped (and counted).
 *
 * Each case runs `read_data <file> nocoeff` (so no pair or bond style is
 * needed: the coefficient sections are still read and checked), prints the
 * counts, box, total charge and mass, then per atom type the count, charge
 * and mass, the count of each group groupsFromData suggests, and after
 * `run 0` (zero pair and bond styles) the number of molecules. Where
 * LAMMPS rejects a file, STEMKit must report an error; where it accepts,
 * STEMKit must report none, and every number must agree to 1e-6 relative.
 *
 * Then the mutants: copies of accepted files with one thing broken (an
 * atom line dropped, a section name misspelt, a type out of range, a count
 * off by one, a bond to a missing atom, a blank line in Masses, ...), which
 * LAMMPS and STEMKit must judge alike. --big adds a generated system of
 * about a million atoms (water and ions) and reports the parse time.
 *
 * Exits 0 when everything agrees, or when LMP_BIN is unset (nothing to
 * check); runs LAMMPS with nice and one OpenMP thread.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseDataFile, summariseData, groupsFromData, ATOM_STYLE_COLUMNS } from '../src/core/lammps-data.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const mutants = !args.includes('--no-mutants');
const big = args.includes('--big');
const onlyAt = args.indexOf('--only');
const only = onlyAt >= 0 ? args[onlyAt + 1] : null;
const limitAt = args.indexOf('--limit');
const limit = limitAt >= 0 ? +args[limitAt + 1] : Infinity;
const extraFiles = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--only' && args[i - 1] !== '--limit');

const LMP = process.env.LMP_BIN;
if (!LMP) {
  console.log('LMP_BIN is not set; nothing to check.');
  process.exit(0);
}
const EXAMPLES = path.join(root, 'lammps', 'examples');
const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'check-lammps-data-'));

/* ---------------- the LAMMPS binary ---------------- */

function runLammps(input, cwd = work) {
  // The input lives in the work directory; LAMMPS runs where the example
  // script would, so the files its fixes name (CMAP tables) are found.
  const file = path.join(work, 'in.check');
  fs.writeFileSync(file, input);
  // Line-buffered output: an error that aborts MPI would otherwise take
  // the buffered output (and its own message) with it.
  const r = spawnSync('nice', ['-n', '10', 'stdbuf', '-oL', '-eL', LMP, '-in', file, '-log', 'none', '-echo', 'none', '-nocite'],
    { cwd, encoding: 'utf8', timeout: 600000, maxBuffer: 1 << 28, env: { ...process.env, OMP_NUM_THREADS: '1' } });
  return { out: `${r.stdout || ''}\n${r.stderr || ''}`, status: r.status, signal: r.signal };
}

const help = spawnSync(LMP, ['-h'], { encoding: 'utf8', env: { ...process.env, OMP_NUM_THREADS: '1' } }).stdout || '';
const styleBlock = /\* Atom styles:\s*\n([\s\S]*?)\n\s*\*/.exec(help);
const installed = new Set(styleBlock ? styleBlock[1].split(/\s+/).filter(Boolean) : ['atomic', 'charge', 'full']);
const packages = new Set(((/Installed packages:\s*\n([\s\S]*?)\n\s*\n/.exec(help) || [])[1] || '').split(/\s+/).filter(Boolean));
const version = (/LAMMPS \(([^)]+)\)/.exec(help) || /Large-scale[^-]*- (.*)/.exec(help) || [, '?'])[1];

function styleInstalled(spec) {
  const w = spec.trim().split(/\s+/);
  // atom_style body is in the core, its body styles in the BODY package.
  if (w.includes('body') && !packages.has('BODY')) return false;
  if (w[0] !== 'hybrid') return installed.has(w[0]);
  if (!installed.has('hybrid')) return false;
  return w.slice(1).filter(x => ATOM_STYLE_COLUMNS[x]).every(x => installed.has(x));
}

/* ---------------- the example scripts ---------------- */

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/* Logical lines of a script: & continuations joined, comments dropped. */
function scriptLines(text) {
  const lines = [];
  let buf = '';
  for (const raw of text.split('\n')) {
    let line = raw.replace(/\r$/, '');
    const cont = /&\s*$/.test(line);
    if (cont) line = line.replace(/&\s*$/, '');
    buf += line;
    if (cont) continue;
    let q = null;
    let cut = buf.length;
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i];
      if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '#') { cut = i; break; }
    }
    lines.push(buf.slice(0, cut).trim());
    buf = '';
  }
  return lines.filter(Boolean);
}

/* What a script sets up before its first read_data, or null. */
function scanScript(file) {
  const text = fs.readFileSync(file, 'utf8');
  const vars = {};
  const sub = (s) => s.replace(/\$\{(\w+)\}|\$(\w)/g, (m, a, b) => {
    const k = a || b;
    if (!(k in vars)) throw new Error(`unknown variable ${k}`);
    return vars[k];
  });
  const st = { units: 'lj', atomStyle: 'atomic', dimension: 3, boundary: 'p p p', pre: [], fixLines: [], script: file };
  try {
    for (const line0 of scriptLines(text)) {
      const w0 = line0.split(/\s+/);
      if (w0[0] === 'variable') {
        if (['index', 'string', 'loop', 'world', 'universe', 'uloop', 'getenv'].includes(w0[2]) && w0[3] !== undefined) {
          if (!(w0[1] in vars)) vars[w0[1]] = w0[2] === 'loop' ? (w0[4] ? w0[3] : '1') : w0[3].replace(/^["']|["']$/g, '');
        }
        continue;
      }
      if (!['units', 'atom_style', 'dimension', 'boundary', 'atom_modify', 'newton', 'fix', 'read_data', 'molecule',
        'create_box', 'read_restart', 'include', 'region', 'lattice', 'create_atoms'].includes(w0[0])) continue;
      const line = sub(line0);
      const w = line.split(/\s+/);
      switch (w[0]) {
        case 'units': st.units = w[1]; break;
        case 'atom_style': st.atomStyle = w.slice(1).join(' '); break;
        case 'dimension': st.dimension = +w[1]; break;
        case 'boundary': st.boundary = w.slice(1, 4).join(' '); break;
        case 'atom_modify': {
          // Only the map matters to read_data (first names a group made later).
          if (/\bid\s+no\b/.test(line)) return null;
          const m = /\bmap\s+(\S+)/.exec(line);
          if (m) st.pre.push(`atom_modify map ${m[1]}`);
          break;
        }
        case 'newton': st.pre.push(line); break;
        case 'fix': st.fixLines.push({ id: w[1], line }); break;
        case 'molecule': case 'create_box': case 'read_restart': case 'include': return null;
        case 'read_data': {
          if (w.includes('add')) return null;
          const rest = w.slice(2);
          const fixes = [];
          const keep = [];
          for (let i = 0; i < rest.length; i++) {
            if (rest[i] === 'fix') { fixes.push({ id: rest[i + 1], header: rest[i + 2], section: rest[i + 3] === 'NULL' ? rest[i + 1] : rest[i + 3] }); keep.push(...rest.slice(i, i + 4)); i += 3; }
            else if (/^extra\//.test(rest[i])) { keep.push(rest[i], rest[i + 1]); i++; }
            else if (rest[i] === 'group') i++;
          }
          const df = path.resolve(path.dirname(file), w[1].replace(/^["']|["']$/g, ''));
          if (!fs.existsSync(df)) return null;
          // The fixes read_data hands sections to (property/atom, cmap, ...).
          for (const f of fixes) {
            const fl = st.fixLines.filter(x => x.id === f.id).pop();
            if (!fl) return null;
            st.pre.push(fl.line);
          }
          return { ...st, file: df, keywords: keep.join(' '), fixes, cwd: path.dirname(file) };
        }
        default: break;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/* ---------------- one case ---------------- */

function readText(file) {
  const buf = fs.readFileSync(file);
  return /\.gz$/.test(file) ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
}

const near = (a, b, scale = 0) => {
  if (a === b) return true;
  const tol = 1e-6 * Math.max(Math.abs(a), Math.abs(b)) + 1e-9 * scale;
  return Math.abs(a - b) <= tol;
};

/* Does the atom style (or one of its hybrid sub-styles) have this column? */
function styleHas(spec, column) {
  const w = spec.trim().split(/\s+/);
  const names = w[0] === 'hybrid' ? w.slice(1) : [w[0]];
  return names.some(nm => ATOM_STYLE_COLUMNS[nm] && ATOM_STYLE_COLUMNS[nm].includes(column));
}

function lammpsInput(c, groups, molecules, box = null) {
  // charge(group) dereferences the charges, which an atom style without
  // them does not have: LAMMPS 29 Aug 2024 crashes on it.
  const q = styleHas(c.atomStyle, 'q');
  let cut = { lj: 1.5, si: 1e-9, cgs: 1e-7, micro: 1e-3, nano: 0.5 }[c.units] || 5.0;
  if (box) cut = Math.min(cut, 0.2 * Math.min(box.lx, box.ly, box.lz));
  cut = +cut.toPrecision(6);
  const charge = (g) => (q ? `$(charge(${g}):%.17g)` : '0');
  const lines = [
    `units ${c.units}`, `dimension ${c.dimension}`, `boundary ${c.boundary}`, `atom_style ${c.atomStyle}`,
    ...c.pre,
    `read_data ${c.dataPath} nocoeff ${c.keywords || ''}`.trim(),
    'print "STEMKIT read ok"',
    // No spatial sorting: a long thin box can need more sort bins than LAMMPS allows.
    'atom_modify sort 0 0.0',
    // fix cmap keeps the crossterms; write_data puts their count in its header.
    ...((c.fixes || []).some(f => f.section === 'CMAP') ? [`write_data ${path.join(work, 'cmap.data')} nocoeff`] : []),
    'print "STEMKIT counts $(atoms) $(bonds) $(angles) $(dihedrals) $(impropers)"',
    'print "STEMKIT box $(xlo:%.17g) $(xhi:%.17g) $(ylo:%.17g) $(yhi:%.17g) $(zlo:%.17g) $(zhi:%.17g) $(xy:%.17g) $(xz:%.17g) $(yz:%.17g)"',
    `print "STEMKIT total ${charge('all')} $(mass(all):%.17g)"`,
    'variable nt equal extract_setting(ntypes)',
    'print "STEMKIT ntypes ${nt}"',
    'variable i loop ${nt}',
    'label tloop',
    'group tt type ${i}',
    `print "STEMKIT type \${i} $(count(tt)) ${charge('tt')} $(mass(tt):%.17g)"`,
    'group tt delete',
    'next i',
    'jump SELF tloop'
  ];
  for (const g of groups) {
    lines.push(g.command, `print "STEMKIT group ${g.name} $(count(${g.name}))"`);
  }
  lines.push('print "STEMKIT groups ok"');
  // run 0 builds the bond lists: a bond to an atom that is not there stops
  // it. Zero styles, so no coefficients are needed.
  lines.push('variable nbt equal extract_setting(nbondtypes)', 'variable nat equal extract_setting(nangletypes)',
    'variable ndt equal extract_setting(ndihedraltypes)', 'variable nit equal extract_setting(nimpropertypes)',
    // A cutoff well inside the box, so a tiny box does not drown in ghosts.
    `pair_style zero ${cut} nocoeff`, `neighbor ${cut / 5} bin`,
    'pair_coeff * *',
    'if "${nbt} > 0" then "bond_style zero nocoeff" "bond_coeff *"',
    'if "${nat} > 0" then "angle_style zero nocoeff" "angle_coeff *"',
    'if "${ndt} > 0" then "dihedral_style zero nocoeff" "dihedral_coeff *"',
    'if "${nit} > 0" then "improper_style zero nocoeff" "improper_coeff *"',
    'thermo_style custom step atoms', 'thermo_modify lost warn');
  if (molecules) lines.push('compute cc all chunk/atom molecule compress yes');
  lines.push('run 0 post no', 'print "STEMKIT run ok"');
  if (molecules) lines.push('print "STEMKIT molecules $(c_cc)"');
  return `${lines.join('\n')}\n`;
}

function parseOutput(out) {
  const r = { read: false, groupsOk: false, runOk: false, types: {}, groups: {} };
  for (const line of out.split('\n')) {
    const w = line.trim().split(/\s+/);
    if (w[0] !== 'STEMKIT') continue;
    if (w[1] === 'read') r.read = true;
    else if (w[1] === 'counts') r.counts = w.slice(2).map(Number);
    else if (w[1] === 'box') r.box = w.slice(2).map(Number);
    else if (w[1] === 'total') { r.charge = +w[2]; r.mass = +w[3]; }
    else if (w[1] === 'ntypes') r.ntypes = +w[2];
    else if (w[1] === 'type') r.types[+w[2]] = { count: +w[3], charge: +w[4], mass: +w[5] };
    else if (w[1] === 'group') r.groups[w[2]] = +w[3];
    else if (w[1] === 'groups') r.groupsOk = true;
    else if (w[1] === 'run') r.runOk = true;
    else if (w[1] === 'molecules') r.molecules = +w[2];
  }
  const err = /ERROR(?: on proc \d+)?: ([^\n]*)/.exec(out);
  r.error = err ? err[1].replace(/ \(src\/[^)]*\)/, '').trim() : (r.read ? '' : 'LAMMPS crashed or stopped');
  if (!err && !r.runOk && /Segmentation fault|Signal: /.test(out)) r.error = 'LAMMPS crashed (segmentation fault)';
  return r;
}

/* A run-time stop that is about the input script, not the data file. */
const SCRIPT_ONLY = /Not all per-type masses are set|Cannot use neighbor bins|Too many neighbor bins|Too many atom sorting bins|All pair coeffs are not set|Bond coeffs for bond type \d+ not set|Atom style .* requires|Pair style .* requires|Fix .* requires|Neighbor list overflow/;

const stats = {
  cases: 0, accepted: 0, rejected: 0, verdictAgree: 0, numbers: 0, numbersAgree: 0, typeRows: 0,
  groups: 0, groupsAgree: 0, molecules: 0, moleculesAgree: 0, cmap: 0, cmapAgree: 0, runRejected: 0, skippedStyle: 0,
  skippedOther: 0, inferred: 0, inferredRight: 0, mutants: 0, mutantsAgree: 0, mutantRejects: 0
};
const problems = [];

function checkCase(c, label, { isMutant = false } = {}) {
  const text = readText(c.file);
  let dataPath = c.file;
  if (/\.gz$/.test(c.file)) {
    dataPath = path.join(work, `case-${stats.cases}.data`);
    fs.writeFileSync(dataPath, text);
  }
  c.dataPath = dataPath;
  const opts = { atomStyle: c.atomStyle, dimension: c.dimension, boundary: c.boundary, fixes: c.fixes || [] };
  const extra = {};
  for (const m of (c.keywords || '').matchAll(/extra\/(atom|bond|angle|dihedral|improper)\/types\s+(\d+)/g)) extra[m[1]] = +m[2];
  opts.extraTypes = extra;
  const parsed = parseDataFile(text, opts);
  const ours = parsed.ok;
  let groups = [];
  let summary = null;
  if (ours) {
    summary = summariseData(parsed, { units: c.units });
    groups = groupsFromData(summary);
  }
  const hasMolecules = styleHas(c.atomStyle, 'molecule-ID');
  const cmapFile = path.join(work, 'cmap.data');
  fs.rmSync(cmapFile, { force: true });
  const res = runLammps(lammpsInput(c, groups, hasMolecules && ours, parsed.box), c.cwd || work);
  const L = parseOutput(res.out);
  if (fs.existsSync(cmapFile)) {
    const m = /^\s*(\d+)\s+crossterms/m.exec(fs.readFileSync(cmapFile, 'utf8'));
    L.crossterms = m ? +m[1] : 0;
  }
  // LAMMPS's verdict on the data file: read_data stopped, or the first run
  // did, for a reason that lies in the file.
  const runStop = L.read && L.groupsOk && !L.runOk && L.error && !SCRIPT_ONLY.test(L.error);
  const lammpsOk = L.read && !runStop;
  stats.cases++;
  if (isMutant) stats.mutants++;
  if (lammpsOk) stats.accepted++; else stats.rejected++;
  if (runStop) stats.runRejected++;
  const firstError = parsed.issues.find(i => i.severity === 'error');
  const agree = lammpsOk === ours;
  if (agree) { stats.verdictAgree++; if (isMutant) stats.mutantsAgree++; }
  if (isMutant && !lammpsOk && agree) stats.mutantRejects++;
  const diffs = [];
  if (!agree) {
    diffs.push(lammpsOk ? `LAMMPS accepts, STEMKit: ${firstError ? `line ${firstError.line}: ${firstError.message}` : '?'}`
      : `LAMMPS stops (${L.error}), STEMKit accepts`);
  } else if (lammpsOk && ours) {
    const A = parsed.atoms;
    const n = (a, b, what, scale) => {
      stats.numbers++;
      if (near(a, b, scale)) stats.numbersAgree++; else diffs.push(`${what}: LAMMPS ${a}, STEMKit ${b}`);
    };
    const cnt = [parsed.counts.atoms, parsed.bonds.n, parsed.angles.n, parsed.dihedrals.n, parsed.impropers.n];
    ['atoms', 'bonds', 'angles', 'dihedrals', 'impropers'].forEach((k, i) => n(L.counts[i], cnt[i], k));
    const b = parsed.box;
    if (!/[sm]/.test(c.boundary)) {
      [b.xlo, b.xhi, b.ylo, b.yhi, b.zlo, b.zhi, b.xy, b.xz, b.yz]
        .forEach((v, i) => n(L.box[i], v, ['xlo', 'xhi', 'ylo', 'yhi', 'zlo', 'zhi', 'xy', 'xz', 'yz'][i], Math.max(b.lx, b.ly, b.lz)));
    }
    let qabs = 0;
    if (A.q) for (let i = 0; i < A.n; i++) qabs += Math.abs(A.q[i]);
    n(L.charge, summary.charge, 'charge(all)', qabs);
    n(L.mass, summary.mass, 'mass(all)');
    n(L.ntypes, summary.types.length, 'atom types');
    for (const t of summary.types) {
      const lt = L.types[t.type];
      if (!lt) { diffs.push(`type ${t.type}: not printed by LAMMPS`); continue; }
      stats.typeRows++;
      n(lt.count, t.count, `type ${t.type} count`);
      n(lt.charge, t.charge, `type ${t.type} charge`, t.charges ? Math.abs(t.charges.min) * t.count + Math.abs(t.charges.max) * t.count : 0);
      const m = A.rmass ? null : (t.mass === null ? 0 : t.mass * t.count);
      n(lt.mass, m === null ? massOfType(parsed, t.type) : m, `type ${t.type} mass`);
    }
    for (const g of groups) {
      stats.groups++;
      if (L.groups[g.name] === g.count) stats.groupsAgree++;
      else diffs.push(`group ${g.name} (${g.command}): LAMMPS ${L.groups[g.name]}, STEMKit ${g.count}`);
    }
    if (L.molecules !== undefined && A.mol) {
      // chunk/atom molecule counts every distinct molecule ID, 0 included;
      // the summary's `molecules` leaves 0 (no molecule) out.
      const distinct = new Set(A.mol).size;
      const zero = A.mol.some(m => m <= 0) ? new Set([...A.mol].filter(m => m <= 0)).size : 0;
      stats.molecules++;
      if (L.molecules === distinct && summary.molecules === distinct - zero) stats.moleculesAgree++;
      else diffs.push(`molecules: LAMMPS ${L.molecules} molecule IDs, STEMKit ${distinct} (${summary.molecules} above 0)`);
    }
    if (L.crossterms !== undefined) {
      // And without being told about fix cmap, STEMKit must still read it all.
      const auto = parseDataFile(text, { ...opts, fixes: [] });
      stats.cmap++;
      if (L.crossterms === parsed.crossterms.n && auto.ok && auto.crossterms.n === L.crossterms &&
          auto.counts.atoms === parsed.counts.atoms && auto.bonds.n === parsed.bonds.n) stats.cmapAgree++;
      else diffs.push(`crossterms: LAMMPS ${L.crossterms}, STEMKit ${parsed.crossterms.n}, without the fix ${auto.crossterms.n} (ok ${auto.ok})`);
    }
    if (!L.groupsOk && !runStop) diffs.push(`LAMMPS stopped after reading: ${L.error}`);
  }
  if (diffs.length) problems.push({ label, diffs, style: c.atomStyle, script: c.script });
  if (diffs.length && process.env.CHECK_DUMP) {
    fs.writeFileSync(path.join(process.env.CHECK_DUMP, `case-${stats.cases}.out`), res.out);
    fs.copyFileSync(path.join(work, 'in.check'), path.join(process.env.CHECK_DUMP, `case-${stats.cases}.in`));
  }
  if (verbose || diffs.length) {
    console.log(`${diffs.length ? 'DIFF' : 'ok  '} ${label} [${c.atomStyle}] ${lammpsOk ? 'accepted' : `rejected: ${L.error}`}`);
    for (const d of diffs) console.log(`       ${d}`);
  }
  return { parsed, lammpsOk, ours, L, summary };
}

function massOfType(parsed, ty) {
  const A = parsed.atoms;
  let m = 0;
  for (let i = 0; i < A.n; i++) if (A.type[i] === ty) m += A.rmass[i];
  return m;
}

/* ---------------- the cases ---------------- */

const cases = [];
const seen = new Set();
const key = (c) => [c.file, c.atomStyle, c.boundary, c.dimension, c.keywords || '', c.pre.join(';')].join('|');
if (fs.existsSync(EXAMPLES)) {
  const all = walk(EXAMPLES);
  const scripts = all.filter(f => /(^|\/)in\.[^/]*$/.test(f) && !/\.(gz|png|jpg)$/.test(f));
  for (const s of scripts.sort()) {
    const c = scanScript(s);
    if (!c) continue;
    const k = key(c);
    if (seen.has(k)) continue;
    seen.add(k);
    cases.push({ ...c, from: 'script' });
  }
  const referenced = new Set(cases.map(c => c.file));
  for (const f of all.filter(f => /(^|\/)data\.[^/]*$/.test(f)).sort()) {
    if (referenced.has(f)) continue;
    cases.push({ file: f, from: 'file', units: 'real', dimension: 3, boundary: 'p p p', pre: [] });
  }
} else {
  console.log(`No LAMMPS examples at ${EXAMPLES}; only the files named are checked.`);
}
for (const f of extraFiles) cases.push({ file: path.resolve(f), from: 'file', units: 'real', dimension: 3, boundary: 'p p p', pre: [] });

const accepted = [];
let done = 0;
for (const c of cases) {
  if (only && !c.file.includes(only)) continue;
  if (done >= limit) break;
  const label = path.relative(root, c.file) + (c.from === 'script' ? ` (${path.relative(path.dirname(c.file), c.script)})` : '');
  if (c.from === 'file') {
    // No script: the style from the file, as a user loading it would get.
    let text;
    try { text = readText(c.file); } catch { stats.skippedOther++; continue; }
    if (text.length > 64e6 || /\0/.test(text.slice(0, 4096))) { stats.skippedOther++; continue; }
    const p = parseDataFile(text);
    if (!p.atomStyle || p.atomStyleSource === null) { stats.skippedOther++; continue; }
    if (p.atomStyle === 'hybrid' || /^(template|tdpd|body)/.test(p.atomStyle)) { stats.skippedOther++; continue; }
    c.atomStyle = p.atomStyle;
    c.inferred = p.atomStyleSource === 'columns';
    if (p.cmap && p.cmap.needsFix) {
      // As the builder does: fix cmap first, then read_data ... fix cmap crossterm CMAP.
      c.pre = [`fix cmap all cmap ${path.join(root, 'lammps', 'potentials', 'charmm36.cmap')}`];
      c.keywords = 'fix cmap crossterm CMAP';
      c.fixes = [{ id: 'cmap', header: 'crossterm', section: 'CMAP' }];
    }
  } else if (c.inferred === undefined) {
    // How STEMKit's own guess compares with the script's atom_style.
    try {
      const p = parseDataFile(readText(c.file));
      if (p.atomStyleSource === 'columns') {
        stats.inferred++;
        const same = p.atomStyle === c.atomStyle.split(/\s+/)[0] ||
          (['bond', 'angle', 'molecular'].includes(p.atomStyle) && ['bond', 'angle', 'molecular'].includes(c.atomStyle));
        if (same) stats.inferredRight++;
        else if (verbose) console.log(`     inferred ${p.atomStyle}, script says ${c.atomStyle}: ${label}`);
      }
    } catch { /* unreadable: the case itself reports it */ }
  }
  if (!styleInstalled(c.atomStyle) || /^template/.test(c.atomStyle)) { stats.skippedStyle++; continue; }
  done++;
  const r = checkCase(c, label);
  if (r.lammpsOk && r.ours) accepted.push({ c, parsed: r.parsed });
}

/* ---------------- mutants ---------------- */

function lineOf(lines, no) { return no - 1; }

function mutate(text, parsed, kind) {
  const lines = text.split('\n');
  const sec = (name) => parsed.sectionInfo.find(s => s.name === name);
  const atomsSec = sec('Atoms');
  const firstData = (s) => s.line + 1;     // index (0-based) of the first data line = keyword line + 1
  const dataLines = (s) => {
    const out = [];
    for (let i = s.line + 1; i < s.line + 1 + s.lines; i++) out.push(i);
    return out;
  };
  const replaceWord = (i, k, v) => {
    const parts = lines[i].trim().split(/\s+/);
    parts[k] = v;
    lines[i] = parts.join(' ');
  };
  const headerIndex = (re) => lines.findIndex((l, i) => i > 0 && re.test(l.replace(/#.*/, '')));
  switch (kind) {
    case 'drop-atom-line': {
      if (!atomsSec || atomsSec.lines < 3) return null;
      const d = dataLines(atomsSec).filter(i => lines[i].trim() && !lines[i].trim().startsWith('#'));
      lines.splice(d[Math.min(2, d.length - 1)], 1);
      return lines.join('\n');
    }
    case 'misspell-atoms': {
      if (!atomsSec) return null;
      lines[lineOf(lines, atomsSec.line)] = lines[lineOf(lines, atomsSec.line)].replace('Atoms', 'Atom');
      return lines.join('\n');
    }
    case 'misspell-masses': {
      const m = sec('Masses');
      if (!m) return null;
      lines[lineOf(lines, m.line)] = lines[lineOf(lines, m.line)].replace('Masses', 'Mass');
      return lines.join('\n');
    }
    case 'type-out-of-range': {
      if (!atomsSec || !parsed.atoms.n) return null;
      const st = parsed.columns.indexOf('atom-type');
      const i = parsed.atoms.line[0] - 1;
      replaceWord(i, st, String(parsed.types.atom + 1));
      return lines.join('\n');
    }
    case 'type-zero': {
      if (!atomsSec || !parsed.atoms.n) return null;
      const st = parsed.columns.indexOf('atom-type');
      replaceWord(parsed.atoms.line[parsed.atoms.n - 1] - 1, st, '0');
      return lines.join('\n');
    }
    case 'atoms-count-plus': case 'atoms-count-minus': {
      const i = headerIndex(/^\s*\d+\s+atoms(\s|$)/);
      if (i < 0 || !parsed.counts.atoms) return null;
      lines[i] = lines[i].replace(/\d+/, String(parsed.counts.atoms + (kind.endsWith('plus') ? 1 : -1)));
      return lines.join('\n');
    }
    case 'bonds-count-plus': {
      const i = headerIndex(/^\s*\d+\s+bonds(\s|$)/);
      if (i < 0 || !parsed.counts.bonds) return null;
      lines[i] = lines[i].replace(/\d+/, String(parsed.counts.bonds + 1));
      return lines.join('\n');
    }
    case 'bond-beyond-ids': {
      if (!parsed.bonds.n) return null;
      replaceWord(parsed.bonds.line[0] - 1, 3, String(parsed.maxAtomId + 1));
      return lines.join('\n');
    }
    case 'bond-to-gap': case 'bond-from-gap': {
      // Drop one atom that is bonded, keep its bonds: the bond names a
      // missing atom inside the ID range.
      if (!parsed.bonds.n || parsed.atoms.n < 3) return null;
      const B = parsed.bonds;
      const victim = kind === 'bond-to-gap' ? B.atoms[1] : B.atoms[0];
      if (victim === parsed.maxAtomId) return null;
      const idx = parsed.atoms.id.indexOf(victim);
      if (idx < 0) return null;
      const ai = headerIndex(/^\s*\d+\s+atoms(\s|$)/);
      lines[ai] = lines[ai].replace(/\d+/, String(parsed.counts.atoms - 1));
      lines.splice(parsed.atoms.line[idx] - 1, 1);
      return lines.join('\n');
    }
    case 'angle-to-gap': {
      if (!parsed.angles.n || parsed.atoms.n < 3) return null;
      const G = parsed.angles;
      const victim = G.atoms[0];
      if (victim === parsed.maxAtomId) return null;
      const idx = parsed.atoms.id.indexOf(victim);
      const ai = headerIndex(/^\s*\d+\s+atoms(\s|$)/);
      lines[ai] = lines[ai].replace(/\d+/, String(parsed.counts.atoms - 1));
      lines.splice(parsed.atoms.line[idx] - 1, 1);
      return lines.join('\n');
    }
    case 'bond-type-out-of-range': {
      if (!parsed.bonds.n) return null;
      replaceWord(parsed.bonds.line[0] - 1, 1, String(parsed.types.bond + 1));
      return lines.join('\n');
    }
    case 'blank-in-masses': {
      const m = sec('Masses');
      if (!m || m.lines < 2) return null;
      lines.splice(firstData(m) + 1, 0, '');
      return lines.join('\n');
    }
    case 'mass-zero': {
      const m = sec('Masses');
      if (!m) return null;
      replaceWord(firstData(m), 1, '0.0');
      return lines.join('\n');
    }
    case 'extra-column': {
      if (!parsed.atoms.n) return null;
      const i = parsed.atoms.line[Math.min(1, parsed.atoms.n - 1)] - 1;
      lines[i] = `${lines[i].replace(/#.*/, '').trimEnd()} 7`;
      return lines.join('\n');
    }
    case 'bad-number': {
      if (!parsed.atoms.n) return null;
      const xc = parsed.columns.indexOf('x');
      replaceWord(parsed.atoms.line[0] - 1, xc, '1.0.5');
      return lines.join('\n');
    }
    case 'duplicate-id': {
      if (parsed.atoms.n < 3) return null;
      const i = parsed.atoms.line[1] - 1;
      const idc = parsed.columns.indexOf('atom-ID');
      replaceWord(i, idc, String(parsed.atoms.id[0]));
      return lines.join('\n');
    }
    case 'no-skip-line': {
      // The line after a section name is skipped: without the blank line
      // the first atom is lost.
      if (!atomsSec || lines[atomsSec.line].trim() !== '') return null;
      lines.splice(atomsSec.line, 1);
      return lines.join('\n');
    }
    case 'velocities-first': {
      const v = sec('Velocities');
      if (!v || !atomsSec || v.line < atomsSec.line) return null;
      const block = lines.slice(v.line - 1, v.line + v.lines + 1);
      lines.splice(v.line - 1, v.lines + 2);
      lines.splice(atomsSec.line - 1, 0, ...block, '');
      return lines.join('\n');
    }
    case 'header-comment-glued': {
      const i = headerIndex(/^\s*\d+\s+atoms(\s|$)/);
      if (i < 0) return null;
      lines[i] = `${lines[i].replace(/#.*/, '').trimEnd()}# glued comment`;
      return lines.join('\n');
    }
    case 'label-atom-type': {
      if (!parsed.atoms.n) return null;
      const st = parsed.columns.indexOf('atom-type');
      replaceWord(parsed.atoms.line[0] - 1, st, 'CT');
      return lines.join('\n');
    }
    case 'pairij-reversed': {
      const p = sec('PairIJ Coeffs');
      if (!p || p.lines < 2) return null;
      const i = firstData(p) + 1;
      const w = lines[i].trim().split(/\s+/);
      if (w[0] === w[1]) return null;
      [w[0], w[1]] = [w[1], w[0]];
      lines[i] = w.join(' ');
      return lines.join('\n');
    }
    case 'pair-type-out-of-range': {
      const p = sec('Pair Coeffs');
      if (!p) return null;
      replaceWord(firstData(p), 0, String(parsed.types.atom + 1));
      return lines.join('\n');
    }
    case 'image-flags-one-line': {
      if (parsed.imageFlags || parsed.atoms.n < 2) return null;
      const i = parsed.atoms.line[1] - 1;
      lines[i] = `${lines[i].replace(/#.*/, '').trimEnd()} 0 0 1`;
      return lines.join('\n');
    }
    case 'crlf':
      return text.replace(/\r?\n/g, '\r\n');
    case 'tabs': {
      if (!atomsSec) return null;
      for (const i of dataLines(atomsSec)) lines[i] = lines[i].replace(/ +/g, '\t');
      return lines.join('\n');
    }
    case 'images-from-second-chunk': {
      // LAMMPS decides about image flags afresh every 1024 lines.
      if (parsed.imageFlags || parsed.atoms.n <= 1100) return null;
      for (let a = 1024; a < parsed.atoms.n; a++) {
        const i = parsed.atoms.line[a] - 1;
        lines[i] = `${lines[i].replace(/#.*/, '').trimEnd()} 0 0 0`;
      }
      return lines.join('\n');
    }
    case 'comment-starts-chunk': {
      if (parsed.atoms.n <= 1100) return null;
      lines[parsed.atoms.line[1024] - 1] = '# a comment where the second chunk starts';
      return lines.join('\n');
    }
    case 'long-line': {
      // Past 254 characters LAMMPS drops the rest of the line.
      if (!parsed.atoms.n) return null;
      const i = parsed.atoms.line[0] - 1;
      const w = lines[i].replace(/#.*/, '').trim().split(/\s+/);
      lines[i] = `${w.slice(0, -1).join(' ')}${' '.repeat(260)}${w[w.length - 1]}`;
      return lines.join('\n');
    }
    case 'long-comment': {
      if (!parsed.atoms.n) return null;
      const i = parsed.atoms.line[0] - 1;
      lines[i] = `${lines[i].replace(/#.*/, '').trimEnd()} # ${'x'.repeat(300)}`;
      return lines.join('\n');
    }
    case 'truncate-in-atoms': {
      if (!parsed.atoms.n) return null;
      return lines.slice(0, parsed.atoms.line[Math.floor(parsed.atoms.n / 2)] - 1).join('\n') + '\n';
    }
    default: return null;
  }
}

const KINDS = ['drop-atom-line', 'misspell-atoms', 'misspell-masses', 'type-out-of-range', 'type-zero',
  'atoms-count-plus', 'atoms-count-minus', 'bonds-count-plus', 'bond-beyond-ids', 'bond-to-gap', 'bond-from-gap',
  'angle-to-gap', 'bond-type-out-of-range', 'blank-in-masses', 'mass-zero', 'extra-column', 'bad-number',
  'duplicate-id', 'no-skip-line', 'velocities-first', 'header-comment-glued', 'label-atom-type',
  'pairij-reversed', 'pair-type-out-of-range', 'image-flags-one-line', 'truncate-in-atoms', 'crlf', 'tabs',
  'images-from-second-chunk', 'comment-starts-chunk', 'long-line', 'long-comment'];

if (mutants && accepted.length) {
  // A spread of styles and sizes: the smaller files of each atom style.
  const byStyle = new Map();
  for (const a of accepted) {
    const k = a.c.atomStyle;
    if (!byStyle.has(k)) byStyle.set(k, []);
    byStyle.get(k).push(a);
  }
  const picks = [];
  for (const list of byStyle.values()) {
    list.sort((x, y) => x.parsed.atoms.n - y.parsed.atoms.n);
    const small = list.filter(a => a.parsed.atoms.n <= 50000);
    picks.push(...small.slice(0, 4));
    // And one with more than one 1024-line chunk of atoms.
    const chunked = small.find(a => a.parsed.atoms.n > 1100);
    if (chunked && !picks.includes(chunked)) picks.push(chunked);
  }
  const mdir = path.join(work, 'mutants');
  fs.mkdirSync(mdir);
  let m = 0;
  for (const { c, parsed } of picks) {
    const text = readText(c.file);
    for (const kind of KINDS) {
      const t = mutate(text, parsed, kind);
      if (t === null) continue;
      const file = path.join(mdir, `m${m++}-${kind}.data`);
      fs.writeFileSync(file, t);
      checkCase({ ...c, file }, `${path.relative(root, c.file)} :: ${kind}`, { isMutant: true });
    }
  }
}

/* ---------------- a million atoms ---------------- */

if (big) {
  const { bigWaterSystem } = await import('../tests/fixtures/lammps-data/big-system.mjs');
  const text = bigWaterSystem(333334);
  const file = path.join(work, 'big.data');
  fs.writeFileSync(file, text);
  const t0 = process.hrtime.bigint();
  const p = parseDataFile(text);
  const t1 = process.hrtime.bigint();
  const s = summariseData(p, { units: 'real' });
  const t2 = process.hrtime.bigint();
  console.log(`big system: ${p.counts.atoms} atoms, parse ${(Number(t1 - t0) / 1e6).toFixed(0)} ms, ` +
    `summary ${(Number(t2 - t1) / 1e6).toFixed(0)} ms; water ${s.water && s.water.model} x ${s.water && s.water.count}`);
  checkCase({ file, atomStyle: 'full', units: 'real', dimension: 3, boundary: 'p p p', pre: [], from: 'file' }, 'generated system (1 000 134 atoms)');
}

/* ---------------- report ---------------- */

const pct = (a, b) => (b ? `${a}/${b}` : '0/0');
console.log(`\nLAMMPS ${version}; atom styles available: ${[...installed].join(' ')}`);
console.log(`cases: ${stats.cases} (${stats.accepted} accepted by LAMMPS, ${stats.rejected} rejected, ` +
  `${stats.runRejected} of them only when the run starts); mutants: ${stats.mutants}`);
console.log(`verdicts agree: ${pct(stats.verdictAgree, stats.cases)}; mutants: ${pct(stats.mutantsAgree, stats.mutants)} ` +
  `(${stats.mutantRejects} rejected by both)`);
console.log(`numbers agree (counts, box, charge, mass, per type): ${pct(stats.numbersAgree, stats.numbers)} ` +
  `over ${stats.typeRows} atom types`);
console.log(`suggested groups agree: ${pct(stats.groupsAgree, stats.groups)}; molecule counts: ${pct(stats.moleculesAgree, stats.molecules)}; ` +
  `CMAP crossterm counts (with and without fix options): ${pct(stats.cmapAgree, stats.cmap)}`);
console.log(`atom style worked out from the columns, against the script's: ${pct(stats.inferredRight, stats.inferred)}`);
console.log(`skipped: ${stats.skippedStyle} (atom style not in this LAMMPS, or template), ${stats.skippedOther} (other)`);
if (problems.length) console.log(`\n${problems.length} case(s) differ.`);
fs.rmSync(work, { recursive: true, force: true });
process.exit(problems.length ? 1 : 0);
