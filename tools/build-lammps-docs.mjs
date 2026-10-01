#!/usr/bin/env node
/*
 * build-lammps-docs.mjs: turn the LAMMPS documentation sources and the style
 * registrations in the LAMMPS source tree into the reference tables
 * src/core/lammps-commands.js (every command and style: kind, doc page,
 * package, accelerator variants, removed names) and src/core/lammps-docs.js
 * (per page: syntax skeleton, per-style arguments, keywords with their value
 * names, units and choices, and the documented defaults).
 *
 * Two sources, because neither is complete on its own:
 *
 *   - lammps/src/<PACKAGE>/*.h holds the style registrations
 *     (`PairStyle(lj/cut/omp, ...)`, `FixStyle(nvt, ...)`), which say exactly
 *     which names exist, which package provides each one and which
 *     accelerated variants are compiled; the directory is the package, and
 *     files at the top level of src/ are the core;
 *   - lammps/doc/src/*.rst says which page documents each name (the
 *     `.. index::` directives, then the Commands_*.rst lists), what the syntax
 *     looks like, the keyword and value names, the units of the values and
 *     the defaults. Commands_category.rst gives the command categories and
 *     Commands_removed.rst the removal dates.
 *
 * Facts only: names, syntax skeletons, value names, units, choices, defaults,
 * packages and page names. No documentation prose is copied (the LAMMPS
 * documentation is GPL-2.0; STEMKit is MIT). The explanations people read are
 * STEMKit's own, in src/core/lammps-summaries.js, and every entry links to
 * docs.lammps.org for the full text.
 *
 * The output is deterministic: keys are sorted, and nothing depends on the
 * order the file system lists files in or on the date.
 *
 * Usage, once per LAMMPS release:
 *     node tools/build-lammps-docs.mjs [--source lammps] [--check] [--report]
 *
 * --source  a LAMMPS source tree (default: ./lammps, which is not in git)
 * --check   compare against the files on disk and exit 1 when they differ
 * --report  print names the documentation and the source disagree about
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_TABLE = path.join(ROOT, 'src', 'core', 'lammps-commands.js');
const OUT_DOCS = path.join(ROOT, 'src', 'core', 'lammps-docs.js');

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}
const SOURCE = path.resolve(ROOT, arg('source', 'lammps'));
const CHECK = process.argv.includes('--check');
const REPORT = process.argv.includes('--report');

const DOC_DIR = path.join(SOURCE, 'doc', 'src');
const SRC_DIR = path.join(SOURCE, 'src');
for (const dir of [DOC_DIR, SRC_DIR]) {
  if (!fs.existsSync(dir)) {
    console.error(`Missing ${dir}. Pass --source <LAMMPS source tree>.`);
    process.exit(2);
  }
}

const readDoc = (page) => fs.readFileSync(path.join(DOC_DIR, `${page}.rst`), 'utf8');

/** The release, from src/version.h: `#define LAMMPS_VERSION "29 Aug 2024"`. */
const RELEASE = (() => {
  const m = /LAMMPS_VERSION\s+"([^"]+)"/.exec(fs.readFileSync(path.join(SRC_DIR, 'version.h'), 'utf8'));
  if (!m) throw new Error('No LAMMPS_VERSION in src/version.h');
  return m[1];
})();

/* ------------------------------------------------------------------ *
 * Kinds
 * ------------------------------------------------------------------ */

// id, the command that sets the style, the registration macro in the source.
const KINDS = [
  ['command', '', 'Command'],
  ['atom', 'atom_style', 'Atom'],
  ['pair', 'pair_style', 'Pair'],
  ['bond', 'bond_style', 'Bond'],
  ['angle', 'angle_style', 'Angle'],
  ['dihedral', 'dihedral_style', 'Dihedral'],
  ['improper', 'improper_style', 'Improper'],
  ['kspace', 'kspace_style', 'KSpace'],
  ['fix', 'fix', 'Fix'],
  ['compute', 'compute', 'Compute'],
  ['dump', 'dump', 'Dump'],
  ['region', 'region', 'Region'],
  ['minimize', 'min_style', 'Minimize'],
  ['integrate', 'run_style', 'Integrate'],
  ['body', 'atom_style body', 'Body'],
  ['reader', 'read_dump format', 'Reader']
];

// docs.lammps.org shows the manual of the newest development version, which
// has renamed or dropped a few pages of the 29 Aug 2024 manual. Links go to
// the new name, or to the stable manual (docs.lammps.org/stable/) while it
// still has the page. Checked against the site on 30 Sep 2026: every other
// page of the table answers 200.
const LIVE_PAGES = {
  fix_addtorque: 'fix_addtorque_group',      // renamed to fix addtorque/group in 10 Dec 2025
  fix_nve_awpmd: 'stable/fix_nve_awpmd',     // AWPMD package removed after 22 Jul 2025
  pair_agni: 'stable/pair_agni',             // pair agni removed after 22 Jul 2025
  pair_awpmd: 'stable/pair_awpmd',
  pair_rann: 'stable/pair_rann'              // ML-RANN package removed after 22 Jul 2025
};

// The page for a style that has none of its own.
const FALLBACK_PAGE = {
  atom: 'atom_style', pair: 'pair_style', bond: 'bond_style', angle: 'angle_style', dihedral: 'dihedral_style',
  improper: 'improper_style', kspace: 'kspace_style', fix: 'fix', compute: 'compute', dump: 'dump',
  region: 'region', minimize: 'min_style', integrate: 'run_style', body: 'Howto_body', reader: 'read_dump'
};
const KIND_BY_COMMAND = new Map(KINDS.filter(k => k[1]).map(([id, command]) => [command, id]));
const KIND_BY_MACRO = new Map(KINDS.map(([id, , macro]) => [macro, id]));

// Accelerator suffixes and the packages that provide them. The letters are
// the ones the Commands_*.rst lists use.
const ACCELERATORS = [
  ['gpu', 'g', 'GPU'],
  ['intel', 'i', 'INTEL'],
  ['kk', 'k', 'KOKKOS'],
  ['omp', 'o', 'OPENMP'],
  ['opt', 't', 'OPT']
];
const ACCEL_SUFFIX = /\/(gpu|intel|kk|omp|opt)(\/device|\/host)?$/;

// Styles the core accepts without registering them.
const PSEUDO_STYLES = ['pair none', 'bond none', 'angle none', 'dihedral none', 'improper none', 'kspace none', 'region delete'];

/* ------------------------------------------------------------------ *
 * The source tree: which names exist, and in which package
 * ------------------------------------------------------------------ */

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.h')) out.push(full);
  }
  return out;
}

// Directories under src/ that are not packages.
const NOT_PACKAGES = new Set(['MAKE', 'STUBS', 'DEPEND', 'fmt']);

/**
 * Every registered style: {styles: kind -> name -> Set of packages ('' = core),
 * classes: kind -> name -> C++ class}. Two names with one class are the same
 * style under two names (an alias kept for old inputs). Internal styles (upper
 * case, like STORE/ATOM) are skipped: LAMMPS does not list them, and they
 * cannot be used from an input script.
 */
function scanSource() {
  const styles = new Map(KINDS.map(([id]) => [id, new Map()]));
  const classes = new Map(KINDS.map(([id]) => [id, new Map()]));
  const fileStyles = new Map();   // 'KSPACE/pair_lj_cut_coul_long.h' -> [[kind, name]]
  const flags = new Map();        // 'dump atom/zstd' -> 'LAMMPS_ZSTD': registered only with that compile flag
  const macro = /^\s*(Atom|Integrate|Minimize|Pair|Bond|Angle|Dihedral|Improper|KSpace|Fix|Compute|Region|Dump|Command|Body|Reader)Style\(\s*([^,\s)]+)\s*,\s*([A-Za-z0-9_]+)/gm;
  for (const file of walk(SRC_DIR)) {
    const rel = path.relative(SRC_DIR, file).split(path.sep);
    const pkg = rel.length > 1 ? rel[0] : '';
    if (NOT_PACKAGES.has(pkg)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(macro)) {
      const kind = KIND_BY_MACRO.get(m[1]);
      const name = m[2];
      if (/^[A-Z]/.test(name)) continue;
      const map = styles.get(kind);
      if (!map.has(name)) map.set(name, new Set());
      map.get(name).add(pkg);
      if (!classes.get(kind).has(name)) classes.get(kind).set(name, m[3]);
      const guard = /^#ifdef (LAMMPS_\w+)\s*$/m.exec(text.slice(0, m.index));
      if (guard) flags.set(`${kind} ${name}`, guard[1]);
      const relName = rel.join('/');
      if (!fileStyles.has(relName)) fileStyles.set(relName, []);
      fileStyles.get(relName).push([kind, name]);
    }
  }
  return { styles, classes, fileStyles, flags };
}

/**
 * Packages a style needs besides its own: a package's Install.sh copies a
 * file only when a file of another package is there (`action
 * pair_srp_react.h fix_bond_break.h`: pair srp/react of MISC needs MC).
 *
 * @returns {Map<string, Set<string>>} 'kind name' -> packages
 */
function scanDependencies(fileStyles) {
  const home = new Map();   // file name -> package ('' = core)
  for (const entry of fs.readdirSync(SRC_DIR, { withFileTypes: true })) {
    if (entry.isFile()) home.set(entry.name, '');
  }
  const packages = fs.readdirSync(SRC_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && !NOT_PACKAGES.has(e.name)).map(e => e.name).sort();
  for (const pkg of packages) {
    for (const name of fs.readdirSync(path.join(SRC_DIR, pkg)).sort()) if (!home.has(name)) home.set(name, pkg);
  }
  const out = new Map();
  for (const pkg of packages) {
    const install = path.join(SRC_DIR, pkg, 'Install.sh');
    if (!fs.existsSync(install)) continue;
    for (const m of fs.readFileSync(install, 'utf8').matchAll(/^\s*action\s+([\w.-]+)\.(?:h|cpp)\s+([\w.-]+\.(?:h|cpp))\s*$/gm)) {
      const dep = home.get(m[2]);
      if (dep === undefined || dep === '' || dep === pkg) continue;
      for (const [kind, name] of fileStyles.get(`${pkg}/${m[1]}.h`) || []) {
        const key = `${kind} ${name}`;
        if (!out.has(key)) out.set(key, new Set());
        out.get(key).add(dep);
      }
    }
  }
  return out;
}

/**
 * Commands run by the input reader itself (src/input.cpp) rather than
 * registered as command styles: `mycmd == "units"` and the like.
 */
function scanInputCommands() {
  const text = fs.readFileSync(path.join(SRC_DIR, 'input.cpp'), 'utf8');
  const names = new Set();
  for (const m of text.matchAll(/mycmd == "([a-z_0-9/]+)"/g)) names.add(m[1]);
  return names;
}

/* ------------------------------------------------------------------ *
 * The documentation
 * ------------------------------------------------------------------ */

const DOC_PAGES = fs.readdirSync(DOC_DIR).filter(f => f.endsWith('.rst')).map(f => f.slice(0, -4)).sort();

/** rst inline markup to plain text: roles, emphasis, literals, escapes. */
function plain(text) {
  return String(text)
    .replace(/:(?:doc|ref|math|cite|numref|term|code|file):`([^`<]*?)\s*(?:<[^>]*>)?`/g, '$1')
    .replace(/``([^`]*)``/g, '$1')
    .replace(/`([^`<]*?)\s*(?:<[^>]*>)?`_*/g, '$1')
    .replace(/\\([*_\\^])/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1');
}

/** Split an rst page into its sections by heading: {title, sections: {Syntax: [lines], ...}}. */
function sections(text) {
  const lines = text.split('\n');
  const out = { title: '', sections: {} };
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] || '';
    const underline = /^(=+|"+|-+|\^+|~+|\*+)\s*$/.exec(next);
    if (underline && line.trim() && !/^\s/.test(line) && next.trim().length >= line.trim().length - 2) {
      if (next[0] === '=' && !out.title) out.title = line.trim();
      if (next[0] === '"' || next[0] === '-' || next[0] === '=') {
        current = line.trim();
        if (!out.sections[current]) out.sections[current] = [];
        i++;
        continue;
      }
    }
    if (current) out.sections[current].push(line);
  }
  return out;
}

/** Every `.. index::` directive: [{kind, name}] (name '' for a command page). */
function indexEntries(text) {
  const out = [];
  for (const m of text.matchAll(/^\.\. index:: (.+)$/gm)) {
    const words = m[1].trim().split(/\s+/);
    if (words.length === 1) {
      out.push({ kind: 'command', name: words[0] });
    } else if (words.length === 2 && KIND_BY_COMMAND.has(words[0])) {
      out.push({ kind: KIND_BY_COMMAND.get(words[0]), name: words[1] });
    }
  }
  return out;
}

/**
 * The entries of a Commands_*.rst list: `* :doc:`lj/cut (gikot) <pair_lj>``.
 * The heading above each list decides the kind (Commands_bond.rst has four).
 */
function commandLists() {
  const out = [];
  const files = {
    Commands_all: 'command', Commands_pair: 'pair', Commands_fix: 'fix', Commands_compute: 'compute',
    Commands_kspace: 'kspace', Commands_dump: 'dump', Commands_bond: 'bond'
  };
  for (const [file, defaultKind] of Object.entries(files)) {
    let kind = defaultKind;
    let skip = file === 'Commands_all';   // the first list there is the navigation bar
    for (const line of readDoc(file).split('\n')) {
      const heading = /^\.\. _(bond|angle|dihedral|improper):/.exec(line);
      if (heading) kind = heading[1];
      if (file === 'Commands_all' && /^General commands/.test(line)) skip = false;
      if (skip) continue;
      const m = /^\s*\* :doc:`([^`<(]+?)\s*(?:\(([a-z]+)\))?\s*<([^>]+)>`/.exec(line);
      if (m) out.push({ kind, name: m[1].trim(), letters: m[2] || '', page: m[3].trim() });
    }
  }
  return out;
}

/** Command categories from Commands_category.rst: name -> category heading. */
function commandCategories() {
  const out = new Map();
  const lines = readDoc('Commands_category').split('\n');
  let category = '';
  for (let i = 0; i < lines.length; i++) {
    if (/^-{3,}\s*$/.test(lines[i + 1] || '') && lines[i].trim()) category = lines[i].trim();
    const m = /^\s*\* :doc:`([^`<]+?)\s*<([^>]+)>`/.exec(lines[i]);
    if (m && category && !out.has(m[1].trim())) out.set(m[1].trim(), category);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Syntax, keywords and defaults of one page
 * ------------------------------------------------------------------ */

// Words that mark a value description as prose rather than a list of names.
const PROSE = new Set(('a an the of for to in on at by from with this that these those is are be ' +
  'each every many per which same see discussed below above list how when where whether any all ' +
  'not only than into its it will can may should used use using defined specified').split(' '));

// The quantities the documentation names in `(... units)` after a value.
const UNIT_NAMES = 'distance|time|energy|temperature|pressure|force|velocity|mass|charge|density|length|' +
  'volume|area|viscosity|dipole|torque|electric field|energy/distance|force/distance|energy/distance\\^2|' +
  'energy/length|energy/time|energy/area|energy/volume|distance/time|distance\\^2|distance\\^3|' +
  'temperature/distance|mass/time|force/velocity|energy/radian\\^2|energy/degree|energy/mass|' +
  'charge/distance|1/distance|1/time|inverse distance|inverse time|energy-distance|force/distance\\^2';
const UNIT_RE = new RegExp(`\\((?:in\\s+)?(${UNIT_NAMES})(?:\\s+units)?\\)`, 'i');
const ANGLE_RE = /\((degrees|radians)\)/i;

/** The unit named in a description, or ''. */
function unitOf(text) {
  const u = UNIT_RE.exec(text);
  if (u) return u[1].toLowerCase().replace(/^inverse /, '1/');
  const a = ANGLE_RE.exec(text);
  return a ? a[1].toLowerCase() : '';
}

const identifierLike = (t) => /[A-Z0-9_\-/.]|^[a-z]$|^\.\.\.?$|^\.\.$/.test(t) || /^\(.*\)$/.test(t);

/**
 * The value names after `=` in `*temp* values = Tstart Tstop Tdamp`: a list
 * of names, one entry per value (alternatives joined with `|`, as in
 * `no|yes`), [] for none, or null when what follows is a description in words.
 *
 * @param {string} spec the text after `=`
 * @param {Set<string>} explained names the section explains (`Tdamp = ...`)
 * @returns {{values: string[]|null, choices: string[]|null, unit: string}}
 */
function valueSpec(spec, explained) {
  let text = spec.replace(/\\\s?/g, '').replace(/:doc:`([^`<]*?)\s*(?:<[^>]*>)?`/g, '$1').trim();
  // `N = something`: the names stop at a second `=`.
  text = text.split(/\s=\s|\s=$/)[0].trim().replace(/[,;.]\s*$/, '');
  if (!text || /^(none|no args?|no arguments?)$/i.test(text)) return { values: [], choices: null, unit: '' };
  // `0/1 (optional) for static/dynamic radii`: the names before `(optional)` may be left out.
  const optional = /^(\S+(?:\s+\S+)?)\s+\(optional\)\s+\S/.exec(text);
  if (optional) {
    const inner = valueSpec(optional[1], explained);
    if (inner.values) return { ...inner, values: inner.values.map(v => `(${v})`) };
  }
  // Parenthesised words: an optional value `(cutoff2)` stays, a note `(> 0.0)`
  // or a unit `(energy units)` goes.
  let unit = '';
  text = text.replace(/\s*\(([^()]*)\)/g, (all, inner) => {
    if (/^[A-Za-z][\w-]*$/.test(inner) && !/^(optional|degrees|radians)$/i.test(inner)) return ` (${inner})`;
    const u = unitOf(`(${inner})`);
    if (u) unit = u;
    return '';
  }).trim();
  const alternatives = text.split(/\s+or\s+/);
  if (alternatives.length > 1) {
    // `*yes* or *no*`, `*off* or *id* or N or -N`, `*default* or a number`.
    const alts = alternatives.map(a => a.trim().replace(/^an?\s+/, '').replace(/\*/g, ''));
    const prose = alternatives.some(a => !/^\*[^*\s]+\*$/.test(a.trim()) &&
      a.trim().replace(/^an?\s+/, '').split(/\s+/).some(w => PROSE.has(w.toLowerCase())));
    if (alts.every(Boolean) && !prose) {
      const starred = alternatives.every(a => /^\*[^*\s]+\*$/.test(a.trim()));
      return { values: [alts.join('|')], choices: starred ? alts : null, unit };
    }
    return { values: null, choices: null, unit };
  }
  const words = text.replace(/\*/g, '').split(/\s+/).filter(Boolean);
  if (words.length > 10 || words.some(w => /^[a-z]+$/.test(w) && PROSE.has(w))) return { values: null, choices: null, unit };
  if (words.length >= 2) {
    const named = words.some(w => w.replace(/[()]/g, '').split(',').some(n => explained.has(n)));
    if (!named && !words.every(identifierLike)) return { values: null, choices: null, unit };
  }
  return { values: words, choices: null, unit };
}

/** Starred names at the start of a line: `*x* or *y* or *z* values = ...`. */
function starredHead(line) {
  const m = /^(\s*)(?:\*\s+)?((?:\*[^*\s]+\*(?:\s*,\s*|\s+or\s+|\s*,\s*or\s+|\s+and\s+)?)+)\s*(args|arg|value|values|attributes|attribute|keyword|keywords|params|parameters|options)?\s*=\s*(.*)$/.exec(line);
  if (!m) return null;
  const names = [...m[2].matchAll(/\*([^*\s]+)\*/g)].map(x => x[1].replace(/\\/g, ''));
  return { indent: m[1].length, names, word: m[3] || '', rest: m[4] };
}

/** Names listed as `keyword = *a* or *b* or ...` (possibly over several lines). */
function keywordList(lines, start) {
  let text = lines[start].replace(/^.*?\b(?:keyword|keywords|kw)\s*=\s*/, '');
  for (let j = start + 1; j < lines.length; j++) {
    const next = lines[j].trim();
    if (/^(or\s+)?\*[^*]+\*(\s+or\s+\*[^*]+\*)*(\s+or)?\s*$/.test(next)) text += ' ' + next;
    else break;
  }
  text = text.split(/\s=\s/)[0];
  return [...text.matchAll(/\*([^*\s]+)\*/g)].map(x => x[1].replace(/\\/g, ''));
}

/**
 * Parse the Syntax section of a page.
 *
 * @param {string[]} lines the section
 * @param {Set<string>} styles the style names this page documents
 * @returns {{skeleton: string[], args: Object<string, string[]>, keywords: Object<string, object>,
 *            kwOrder: string[], units: Object<string, string>, names: Set<string>}}
 */
function parseSyntax(lines, styles) {
  const skeleton = [];
  const args = {};
  const keywords = {};
  const kwOrder = [];
  const units = {};
  const listed = new Set();
  const explained = new Set();
  // The skeleton: the command lines of every code block in the section
  // (pair_coul.rst has one for coul/* and one for tip4p/*), or of the first
  // literal block when there is no code block.
  let starts = lines.map((l, j) => (/^\.\. code-block::/.test(l) ? j : -1)).filter(j => j > -1);
  if (!starts.length) starts = [lines.findIndex(l => /^\.\. parsed-literal::|::\s*$/.test(l))].filter(j => j > -1);
  for (const i of starts) {
    let found = false;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) { if (found) break; continue; }
      if (!/^\s/.test(l)) break;
      found = true;
      const line = plain(l).trim().replace(/\s+/g, ' ');
      if (!line.startsWith('*') && !skeleton.includes(line)) skeleton.push(line);
    }
  }
  // First pass: every `name = ...` explanation (bullets included), and the
  // unit it names. `Tstart,Tstop = ... (temperature units)`.
  const choices = {};
  for (const raw of lines) {
    if (starredHead(raw)) continue;
    const m = /^\s*(?:\*\s+)?([A-Za-z][\w-]*(?:\s*,\s*[A-Za-z][\w-]*)*)\s+=\s+(.*)$/.exec(raw);
    if (!m) continue;
    const unit = unitOf(plain(m[2]));
    // `flag_buck = *long* or *cut*`: a positional value with fixed choices.
    const closed = /^(\*[^*\s]+\*)(\s+or\s+\*[^*\s]+\*)+\s*$/.test(m[2].trim()) ? [...m[2].matchAll(/\*([^*\s]+)\*/g)].map(x => x[1]) : null;
    for (const name of m[1].split(/\s*,\s*/)) {
      explained.add(name);
      if (unit && !units[name]) units[name] = unit;
      if (closed && !choices[name] && !/^(style|keyword|keywords)$/.test(name)) choices[name] = closed;
    }
  }
  const addKeyword = (name, spec) => {
    if (!keywords[name]) { keywords[name] = {}; kwOrder.push(name); }
    const kw = keywords[name];
    if (spec.values && !kw.values) kw.values = spec.values;
    if (spec.choices && !kw.choices) kw.choices = spec.choices;
    if (spec.unit && spec.values && spec.values.length === 1 && !units[spec.values[0]]) units[spec.values[0]] = spec.unit;
  };
  // `possible keywords = step, elapsed, ...` (thermo_style custom) and
  // `possible attributes = id, mol, ...` (dump custom): the words a style or
  // keyword takes, for the starred names above them ('' when there are none).
  const words = {};
  let context = [''];
  for (let j = 0; j < lines.length; j++) {
    const lead = /^\s*(?:\*\s+)?((?:\*[^*\s]+\*(?:\s*,\s*|\s+or\s+|\s*,\s*or\s+)?)+)/.exec(lines[j]);
    if (lead) context = [...lead[1].matchAll(/\*([^*\s]+)\*/g)].map(x => x[1].replace(/\\/g, ''));
    const m = /^\s*possible (?:keywords|attributes|values) = (.*)$/.exec(lines[j]);
    if (!m) continue;
    let text = m[1];
    for (let k = j + 1; k < lines.length && /^\s+[\w\[\]:,\s]+,?\s*$/.test(lines[k]) && !/\s=\s/.test(lines[k]); k++) text += ' ' + lines[k];
    const list = text.split(/[\s,]+/).filter(w => /^[\w\[\]:/]+$/.test(w));
    for (const name of context) if (list.length && !words[name]) words[name] = list;
  }
  let headIndent = Infinity;
  for (let j = 0; j < lines.length; j++) {
    const raw = lines[j];
    if (/\b(?:keyword|keywords)\s*=\s*\*/.test(raw)) {
      for (const k of keywordList(lines, j)) listed.add(k);
      headIndent = Infinity;
      continue;
    }
    const head = starredHead(raw);
    if (!head) continue;
    const isStyle = head.names.every(n => styles.has(n)) && /^(args|arg|attributes|attribute|value|values|params|parameters|)$/.test(head.word);
    const isListed = head.names.some(n => listed.has(n));
    // A starred line deeper than the last keyword line explains one of its
    // values (`*no* = do not ...`), unless it is a keyword of a nested list.
    if (head.indent > headIndent && !isListed && !isStyle) continue;
    headIndent = Math.min(headIndent, head.indent);
    const spec = valueSpec(head.rest, explained);
    // `*tchain* value = length of thermostat chain`: one value, described in words.
    if (spec.values === null && /^(value|arg)$/.test(head.word)) {
      spec.values = ['value'];
      if (spec.unit) units.value = units.value || spec.unit;
    }
    if (isStyle && (head.word || !isListed)) {
      for (const n of head.names) if (!args[n] && spec.values) args[n] = spec.values;
      continue;
    }
    if (!head.word && !spec.choices && !isListed && (listed.size || spec.values === null)) continue;
    for (const n of head.names) addKeyword(n, spec);
  }
  // Keywords named in a `keyword = ...` list but never given values.
  for (const k of listed) if (!keywords[k] && !styles.has(k)) addKeyword(k, { values: null, choices: null, unit: '' });
  const names = new Set([...explained, ...kwOrder, ...Object.values(args).flat().map(v => v.replace(/[()]/g, ''))]);
  for (const l of skeleton) for (const w of l.split(' ')) names.add(w.replace(/[[\]()]/g, ''));
  return { skeleton, args, keywords, kwOrder, units, choices, words, names };
}

/**
 * The Default section as facts: `{name: value}` pairs from sentences like
 * `The keyword defaults are tchain = 3, pchain = 3, mtk = yes`, for names the
 * syntax section knows, or the command lines of a code block (`units lj`).
 * Long, conditional or worded values are left out; the page has them.
 */
function parseDefaults(lines, names) {
  if (!lines) return null;
  const text = lines.join('\n');
  const block = /^\.\. code-block::[^\n]*\n\s*\n((?:[ \t]+\S[^\n]*\n?)+)/m.exec(text);
  if (block) {
    return { line: block[1].split('\n').map(l => l.trim()).filter(Boolean).map(l => plain(l)) };
  }
  const flat = plain(text.replace(/\n-{4,}[\s\S]*$/, '')).replace(/\s+/g, ' ').trim();
  if (!flat || /^none\.?$/i.test(flat)) return null;
  const pairs = {};
  const clauses = flat.split(/,\s+(?:and\s+)?|;\s+|\.\s+|\s+and\s+(?=[\w/-]+\s*=)/);
  for (const clause of clauses) {
    const m = /(?:^|\s)((?:[\w/-]+\s*=\s*)+)([^=]+?)\.?$/.exec(clause.trim());
    if (!m) continue;
    const keys = m[1].split('=').map(s => s.trim()).filter(Boolean);
    const value = m[2].trim().replace(/\.$/, '').replace(/\s*\([^)]*\)$/, '');
    const words = value.split(/\s+/);
    if (!value || words.length > 3 || words.some(w => PROSE.has(w.toLowerCase())) ||
        /\b(if|unless|when|otherwise|depends|see|for|as)\b/i.test(value) || /[|]/.test(value)) continue;
    for (const name of keys) {
      if (!names.has(name)) continue;
      if (!(name in pairs)) pairs[name] = value;
    }
  }
  return Object.keys(pairs).length ? { pairs } : null;
}

/** The package a page's Restrictions section names, when it names just one. */
function docPackage(lines) {
  if (!lines) return '';
  const text = plain(lines.join(' ')).replace(/\s+/g, ' ');
  const found = new Set();
  for (const m of text.matchAll(/part of the ([A-Z][A-Z0-9-]+) package/g)) found.add(m[1]);
  return found.size === 1 ? [...found][0] : '';
}

/* ------------------------------------------------------------------ *
 * Removed names
 * ------------------------------------------------------------------ */

// Removed commands and styles: what the stubs in src/*_deprecated.h and
// Commands_removed.rst name, with the replacement (a key in the table, or '')
// and, for commands LAMMPS still runs under a new name (src/deprecated.cpp),
// what it runs instead. The date is read from the page's `.. deprecated::`
// directive under that heading. What LAMMPS does with each name is worked out
// from the source in build(): a stub stops with an error, `box` is ignored,
// a renamed command runs, and a name nothing registers is unknown.
const REMOVED = [
  ['command box', 'Box command', ''],
  ['command reset_ids', 'Reset_ids, reset_atom_ids, reset_mol_ids commands', 'command reset_atoms', 'reset_atoms id'],
  ['command reset_atom_ids', 'Reset_ids, reset_atom_ids, reset_mol_ids commands', 'command reset_atoms', 'reset_atoms id'],
  ['command reset_mol_ids', 'Reset_ids, reset_atom_ids, reset_mol_ids commands', 'command reset_atoms', 'reset_atoms mol'],
  ['command kim_init', 'KIM commands', 'command kim', 'kim init'],
  ['command kim_interactions', 'KIM commands', 'command kim', 'kim interactions'],
  ['command kim_param', 'KIM commands', 'command kim', 'kim param'],
  ['command kim_property', 'KIM commands', 'command kim', 'kim property'],
  ['command kim_query', 'KIM commands', 'command kim', 'kim query'],
  ['command message', 'MESSAGE package', 'command mdi'],
  ['command server', 'MESSAGE package', 'command mdi'],
  ['fix ave/spatial', 'Fix ave/spatial and fix ave/spatial/sphere', 'fix ave/chunk'],
  ['fix ave/spatial/sphere', 'Fix ave/spatial and fix ave/spatial/sphere', 'fix ave/chunk'],
  ['fix lb/pc', 'LATBOLTZ package', 'fix nve'],
  ['fix lb/rigid/pc/sphere', 'LATBOLTZ package', 'fix rigid'],
  ['fix client/md', 'MESSAGE package', 'fix mdi/qm'],
  ['fix mscg', 'MSCG package', ''],
  ['fix latte', 'LATTE package', 'fix mdi/qm'],
  ['fix reax/c/bonds', 'USER-REAXC package', 'fix reaxff/bonds'],
  ['fix reax/c/species', 'USER-REAXC package', 'fix reaxff/species'],
  ['pair reax', 'REAX package', 'pair reaxff'],
  ['pair reax/c', 'USER-REAXC package', 'pair reaxff'],
  ['pair meam/c', 'MEAM package', 'pair meam'],
  ['pair mesont/tpm', 'Pair style mesont/tpm, compute style mesont, atom style mesont', 'pair mesocnt'],
  ['compute mesont', 'Pair style mesont/tpm, compute style mesont, atom style mesont', ''],
  ['atom mesont', 'Pair style mesont/tpm, compute style mesont, atom style mesont', ''],
  ['minimize fire/old', 'Minimize style fire/old', 'minimize fire'],
  ['dump atom/mpiio', 'MPIIO package', 'dump atom'],
  ['dump cfg/mpiio', 'MPIIO package', 'dump cfg'],
  ['dump custom/mpiio', 'MPIIO package', 'dump custom'],
  ['dump xyz/mpiio', 'MPIIO package', 'dump xyz']
];

// What src/deprecated.cpp does with the deprecated commands that still work.
const IGNORED_COMMANDS = new Set(['command box']);

/** Removal dates from Commands_removed.rst: heading -> '22 Dec 2022' (or ''). */
function removalDates() {
  const out = new Map();
  const lines = readDoc('Commands_removed').split('\n');
  let heading = '';
  for (let i = 0; i < lines.length; i++) {
    if (/^-{3,}\s*$/.test(lines[i + 1] || '') && lines[i].trim()) { heading = lines[i].trim(); out.set(heading, ''); }
    const m = /^\.\. (?:deprecated|versionchanged):: (\d{1,2})([A-Z][a-z]{2})(\d{4})/.exec(lines[i]);
    if (m && heading && !out.get(heading)) out.set(heading, `${m[1]} ${m[2]} ${m[3]}`);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

function build() {
  const { styles: source, classes, fileStyles, flags } = scanSource();
  const requires = scanDependencies(fileStyles);
  const builtins = scanInputCommands();
  const report = [];

  // Every documented name -> page, from the index directives first.
  const docPage = new Map();         // 'fix nvt' -> 'fix_nh'
  const pageStyles = new Map();      // page -> Set of style names documented there
  const parsed = new Map();          // page -> sections
  for (const page of DOC_PAGES) {
    const text = readDoc(page);
    const entries = indexEntries(text);
    if (!entries.length) continue;
    parsed.set(page, sections(text));
    for (const { kind, name } of entries) {
      const key = `${kind} ${name}`;
      if (!docPage.has(key)) docPage.set(key, page);
      if (kind !== 'command') {
        if (!pageStyles.has(page)) pageStyles.set(page, new Set());
        pageStyles.get(page).add(name);
      }
    }
  }
  // Then the Commands_*.rst lists, for names the index misses.
  const listLetters = new Map();
  for (const { kind, name, letters, page } of commandLists()) {
    const key = `${kind} ${name}`;
    if (!docPage.has(key) && fs.existsSync(path.join(DOC_DIR, `${page}.rst`))) docPage.set(key, page);
    if (letters) listLetters.set(key, letters);
  }
  // Styles documented on their command's page (atom_style, region, min_style,
  // run_style) have no index directive of their own: take them from the
  // `style = *a* or *b*` line of that page.
  for (const [kind, command] of [['atom', 'atom_style'], ['region', 'region'], ['minimize', 'min_style'], ['integrate', 'run_style'], ['dump', 'dump']]) {
    const secs = sections(readDoc(command));
    parsed.set(command, secs);
    const line = (secs.sections.Syntax || []).find(l => /^\* style = /.test(l)) || '';
    const names = [...line.matchAll(/\*([^*\s]+)\*/g)].map(m => m[1]);
    if (!pageStyles.has(command)) pageStyles.set(command, new Set());
    for (const name of names) {
      pageStyles.get(command).add(name);
      if (!docPage.has(`${kind} ${name}`)) docPage.set(`${kind} ${name}`, command);
    }
  }
  // Styles whose page says `discussed ... on :doc:`min_style spin <min_spin>``.
  for (const [kind, command] of [['minimize', 'min_style'], ['dump', 'dump']]) {
    for (const line of parsed.get(command).sections.Syntax || []) {
      const m = /^\s*\*([^*\s]+)\*.*:doc:`[^`<]*<([^>]+)>`/.exec(line);
      if (m && fs.existsSync(path.join(DOC_DIR, `${m[2]}.rst`)) && docPage.get(`${kind} ${m[1]}`) === command) {
        docPage.set(`${kind} ${m[1]}`, m[2]);
      }
    }
  }

  // Rows: one per command and base style.
  const rows = new Map();   // key -> {kind, name, page, packages:Set, accel:Set, srcNames:Set}
  const row = (kind, name) => {
    const key = `${kind} ${name}`;
    if (!rows.has(key)) rows.set(key, { kind, name, page: '', packages: new Set(), accel: new Map(), inSource: false, variantsOnly: false });
    return rows.get(key);
  };
  for (const [kind, map] of source) {
    for (const [name, pkgs] of map) {
      const m = ACCEL_SUFFIX.exec(name);
      if (m) {
        const base = name.slice(0, m.index);
        const r = row(kind, base);
        const suffix = m[1] + (m[2] || '');
        if (!r.accel.has(suffix)) r.accel.set(suffix, new Set());
        for (const p of pkgs) r.accel.get(suffix).add(p);
      } else {
        const r = row(kind, name);
        r.inSource = true;
        for (const p of pkgs) r.packages.add(p);
      }
    }
  }
  for (const name of builtins) {
    const r = row('command', name);
    r.inSource = true;
    r.builtin = true;
    r.packages.add('');
  }
  // Names the core handles itself rather than registering as a style:
  // `pair_style none` and the like (src/force.cpp), `region ID delete`
  // (src/domain.cpp).
  for (const key of PSEUDO_STYLES) {
    const r = row(key.split(' ')[0], key.split(' ')[1]);
    r.inSource = true;
    r.builtin = true;
    r.packages.add('');
  }
  // Documented names the source does not register (removed, or a page for a
  // family) still get a row, so they have a link.
  for (const key of docPage.keys()) {
    const [kind, name] = [key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1)];
    if (ACCEL_SUFFIX.test(name)) continue;
    row(kind, name);
  }

  // Pages, packages and letters.
  const removedDates = removalDates();
  // status: 'renamed' (runs as `renamed`, with a warning), 'ignored' (a
  // message, then nothing), 'stops' (a stub that ends the run with an error),
  // 'unknown' (nothing registers the name any more). A name a real class
  // still registers is an alias, not removed (fix qeq/reax).
  const removed = new Map();
  for (const [key, heading, replacement, renamed = ''] of REMOVED) {
    const kind = key.slice(0, key.indexOf(' '));
    const name = key.slice(key.indexOf(' ') + 1);
    const cls = classes.get(kind).get(name);
    if (cls && !/Deprecated/.test(cls)) {
      if (REPORT) report.push(`still registered, not removed: ${key} (${cls})`);
      continue;
    }
    const status = !cls ? 'unknown' : renamed ? 'renamed' : IGNORED_COMMANDS.has(key) ? 'ignored' : 'stops';
    removed.set(key, { since: removedDates.get(heading) || '', replacement, status, renamed });
  }
  // Aliases: a name registered with the same C++ class as a documented one
  // (lj/sdk and lj/spica, fix python and fix python/invoke).
  const aliases = new Map();
  for (const [key, r] of rows) {
    if (docPage.has(key) || !r.inSource) continue;
    const cls = classes.get(r.kind).get(r.name);
    const same = [...classes.get(r.kind)].filter(([n, c]) => c === cls && n !== r.name && !ACCEL_SUFFIX.test(n) && docPage.has(`${r.kind} ${n}`)).map(([n]) => n).sort(cmp);
    if (same.length) aliases.set(key, same[0]);
  }
  for (const key of removed.keys()) {
    const [kind, name] = [key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1)];
    row(kind, name);
  }
  for (const [key, r] of rows) {
    r.page = docPage.get(key) || '';
    if (!r.page && aliases.has(key)) r.page = docPage.get(`${r.kind} ${aliases.get(key)}`);
    // A removed name without a page of its own: the page of removed commands.
    if (!r.page && removed.has(key)) r.page = 'Commands_removed';
    if (!r.page && r.kind !== 'command') {
      // A style without a page of its own: the page of the command that sets it.
      if (!removed.has(key) && !r.builtin && !['body', 'reader'].includes(r.kind)) report.push(`no page: ${key}`);
      r.page = FALLBACK_PAGE[r.kind];
    }
    if (!r.page && r.kind === 'command') {
      if (fs.existsSync(path.join(DOC_DIR, `${r.name}.rst`))) r.page = r.name;
      else if (!removed.has(key)) report.push(`no page: ${key}`);
    }
    if (!r.inSource && r.accel.size) r.variantsOnly = true;
    // The documented package, when the source does not say.
    const secs = parsed.get(r.page) || (r.page && fs.existsSync(path.join(DOC_DIR, `${r.page}.rst`)) ? sections(readDoc(r.page)) : null);
    if (secs && !parsed.has(r.page)) parsed.set(r.page, secs);
    const doc = secs ? docPackage(secs.sections.Restrictions) : '';
    if (!r.packages.size && doc && !removed.has(key)) r.packages.add(doc);
    else if (REPORT && doc && r.inSource && !r.packages.has(doc)) report.push(`package: ${key} source ${[...r.packages].join('+') || 'core'} docs ${doc}`);
    // Compare the accelerator letters of the lists with the source.
    const letters = listLetters.get(key);
    if (REPORT && letters) {
      const have = ACCELERATORS.filter(([s]) => r.accel.has(s)).map(([, l]) => l).join('');
      const want = letters.split('').sort().join('');
      if ([...have].sort().join('') !== want) report.push(`accelerators: ${key} source ${have || '-'} docs ${letters}`);
    }
  }
  // Every style is a style of its page, whichever way the page was found.
  for (const r of rows.values()) {
    if (r.kind === 'command' || !r.page) continue;
    if (!pageStyles.has(r.page)) pageStyles.set(r.page, new Set());
    pageStyles.get(r.page).add(r.name);
  }
  // The python command is run by the input reader in every build, but it
  // only works with the PYTHON package (otherwise LAMMPS stops with an error).
  if (rows.has('command python')) {
    if (!requires.has('command python')) requires.set('command python', new Set());
    requires.get('command python').add('PYTHON');
  }
  if (REPORT) {
    for (const [key, r] of rows) if (!r.inSource && !r.variantsOnly && !removed.has(key) && r.kind !== 'command') report.push(`documented, not in source: ${key}`);
  }
  return { rows, removed, aliases, requires, flags, parsed, pageStyles, report };
}

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function emit() {
  const { rows, removed, aliases, requires, flags, parsed, pageStyles, report } = build();
  const categories = commandCategories();

  const packages = [...new Set([...rows.values()].flatMap(r => [...r.packages, ...[...r.accel.values()].flatMap(s => [...s])]))]
    .filter(Boolean).sort(cmp);
  const pkgIndex = new Map(packages.map((p, i) => [p, i]));
  const pages = [...new Set([...rows.values()].map(r => r.page).filter(Boolean))].sort(cmp);
  const pageIndex = new Map(pages.map((p, i) => [p, i]));
  const categoryList = [...new Set(categories.values())];
  const catIndex = new Map(categoryList.map((c, i) => [c, i]));

  // kind -> sorted rows
  const byKind = {};
  for (const [id] of KINDS) byKind[id] = {};
  const sortedKeys = [...rows.keys()].sort(cmp);
  for (const key of sortedKeys) {
    const r = rows.get(key);
    // [page, packages, variants, flags, category]
    //   packages: index, or a list when several packages register the name
    //   variants: accelerator suffixes in letter code, 'K' = kk/device and kk/host too
    const pk = [...r.packages].filter(Boolean).map(p => pkgIndex.get(p)).sort((a, b) => a - b);
    let letters = '';
    for (const [suffix, letter] of ACCELERATORS) if (r.accel.has(suffix)) letters += letter;
    if (r.accel.has('kk/device') || r.accel.has('kk/host')) letters += 'K';
    let flags = 0;
    if (!r.inSource) flags |= r.variantsOnly ? 2 : 1;   // 1 documented only, 2 only accelerated variants exist
    if (r.builtin) flags |= 4;                          // run by the input reader or the core, not a registered style
    const cell = [r.page ? pageIndex.get(r.page) : -1, pk.length === 0 ? -1 : pk.length === 1 ? pk[0] : pk, letters];
    const cat = r.kind === 'command' ? categories.get(r.name) : undefined;
    if (flags || cat !== undefined) cell.push(flags);
    if (cat !== undefined) cell.push(catIndex.get(cat));
    byKind[r.kind][r.name] = cell;
  }
  // Accelerated variants registered somewhere other than the accelerator's
  // package (pair hybrid/omp is in the core): the packages that register
  // them, [] for the core. The reference assumes the accelerator's package
  // for every other variant.
  const variantPackages = {};
  for (const key of sortedKeys) {
    const r = rows.get(key);
    for (const [suffix, pkgs] of [...r.accel].sort((a, b) => cmp(a[0], b[0]))) {
      const own = ACCELERATORS.find(a => a[0] === suffix.split('/')[0])[2];
      if (pkgs.size === 1 && pkgs.has(own)) continue;
      variantPackages[`${key}/${suffix}`] = [...pkgs].filter(Boolean).sort(cmp);
    }
  }
  // Only what the plain style's own package does not already say: an
  // accelerated variant needs its plain style's package anyway.
  const requiresOut = {};
  for (const key of [...requires.keys()].sort(cmp)) {
    const kind = key.slice(0, key.indexOf(' '));
    const name = key.slice(key.indexOf(' ') + 1);
    const m = ACCEL_SUFFIX.exec(name);
    const base = rows.get(`${kind} ${m ? name.slice(0, m.index) : name}`);
    const pk = [...requires.get(key)].filter(p => !(base && base.packages.has(p))).sort(cmp);
    if (pk.length) requiresOut[key] = pk;
  }
  const aliasOut = {};
  for (const key of [...aliases.keys()].sort(cmp)) aliasOut[key] = aliases.get(key);
  const removedOut = {};
  for (const key of [...removed.keys()].sort(cmp)) {
    const { since, replacement, status, renamed } = removed.get(key);
    removedOut[key] = renamed ? [since, status, replacement, renamed] : replacement ? [since, status, replacement] : [since, status];
  }

  const header = `/**
 * LAMMPS commands and styles: kinds, documentation pages, packages,
 * accelerator variants and removed names.
 *
 * Generated by tools/build-lammps-docs.mjs from the LAMMPS ${RELEASE} source:
 * the style registrations in src/ and the documentation in doc/src/*.rst
 * (index directives, Commands_*.rst, Restrictions sections). Facts only,
 * from the LAMMPS ${RELEASE} documentation; the full text of every page is at
 * https://docs.lammps.org/<page>.html. Do not edit by hand.
 *
 * Read it through ./lammps-reference.js rather than directly.
 *
 * kinds: id -> {name: row}; row = [page, package, variants, flags?, category?]
 *   page      index into pages (-1: none)
 *   package   index into packages, a list of indices, or -1 for the core
 *   variants  accelerated versions: g gpu, i intel, k kk, o omp, t opt,
 *             K kk/device and kk/host as well
 *   flags     1 documented but not in the source, 2 only accelerated variants exist,
 *             4 handled by the input reader or the core itself, so lmp -h does not list it
 *   category  index into categories (commands only)
 * variantPackages: 'kind name/suffix' -> packages registering that variant, when
 *   not just the accelerator's own ([] = the core)
 * requires: 'kind name' (plain or accelerated) -> packages it needs besides its own
 * compileFlags: 'kind name' -> the compile flag it needs (LAMMPS_ZSTD: built with libzstd)
 * aliases: 'kind name' -> the documented name registered with the same code
 * removed: 'kind name' -> [since, status, replacement key?, what LAMMPS runs instead?]
 *   status: renamed (runs under the new name with a warning), ignored (a message,
 *   then nothing), stops (ends the run with an error), unknown (no longer registered)
 * pageUrls: page -> where docs.lammps.org has it now, when not at <page>.html
 * syntax: page -> {s: syntax skeleton lines, a: {style: [argument names]}}
 */
`;
  // Syntax skeletons and style arguments are small and wanted at once (the
  // explainer shows them next to every line); keywords, units and defaults go
  // to the lazily loaded lammps-docs.js.
  const docs = buildDocs(parsed, pageStyles, pages);
  const syntax = {};
  const details = {};
  for (const page of Object.keys(docs)) {
    const { s, a, ...rest } = docs[page];
    if (s || a) syntax[page] = { ...(s ? { s } : {}), ...(a ? { a } : {}) };
    if (Object.keys(rest).length) details[page] = rest;
  }
  const table = {
    release: RELEASE,
    docs: 'https://docs.lammps.org/',
    kindOrder: KINDS.map(k => [k[0], k[1]]),
    packages,
    pages,
    categories: categoryList,
    kinds: byKind,
    ...(Object.keys(variantPackages).length ? { variantPackages } : {}),
    requires: requiresOut,
    compileFlags: Object.fromEntries([...flags].sort((a, b) => cmp(a[0], b[0]))),
    aliases: aliasOut,
    removed: removedOut,
    pageUrls: Object.fromEntries(Object.entries(LIVE_PAGES).filter(([page]) => pages.includes(page)).sort((a, b) => cmp(a[0], b[0]))),
    syntax
  };
  const text = header + 'export default ' + stringify(table) + ';\n';

  const docsText = `/**
 * LAMMPS syntax facts per documentation page: keyword names with their value
 * names, units and choices, and the documented defaults.
 *
 * Generated by tools/build-lammps-docs.mjs from the LAMMPS ${RELEASE}
 * documentation (doc/src/*.rst). Facts only, no documentation text; the full
 * page is at https://docs.lammps.org/<page>.html. Do not edit by hand.
 *
 * Loaded on request by ./lammps-reference.js (loadLammpsDetails).
 *
 * page -> {k: [[keyword, [value names] | null, {value: unit} | 0, 1 when the values are a closed choice]],
 *          u: {positional value: unit}, c: {positional value: [choices]},
 *          w: {style or keyword ('' for the page): [the words it takes, as in thermo_style custom]},
 *          d: {name: default} | [default command lines]}
 * A value with alternatives is one entry joined by |: 'yes|no', 'off|id|N|-N'.
 */
export default ` + stringify(details) + ';\n';

  return { text, docsText, report };
}

function buildDocs(parsed, pageStyles, pages) {
  const out = {};
  for (const page of pages) {
    const secs = parsed.get(page) || (fs.existsSync(path.join(DOC_DIR, `${page}.rst`)) ? sections(readDoc(page)) : null);
    if (!secs) continue;
    const styles = pageStyles.get(page) || new Set();
    const syn = parseSyntax(secs.sections.Syntax || [], styles);
    const def = parseDefaults(secs.sections.Default, syn.names);
    const entry = {};
    if (syn.skeleton.length) entry.s = syn.skeleton;
    const args = {};
    for (const name of Object.keys(syn.args).sort(cmp)) args[name] = syn.args[name];
    if (Object.keys(args).length) entry.a = args;
    const kws = syn.kwOrder.map(name => {
      const kw = syn.keywords[name];
      const cell = [name, kw.values || null];
      const u = {};
      for (const v of kw.values || []) {
        const bare = v.replace(/[()]/g, '');
        if (syn.units[bare]) u[bare] = syn.units[bare];
      }
      if (Object.keys(u).length || kw.choices) cell.push(Object.keys(u).length ? u : 0);
      if (kw.choices) cell.push(1);
      return cell;
    });
    if (kws.length) entry.k = kws;
    // Units of the positional values: the skeleton's words and the style arguments.
    const positional = new Set();
    for (const l of syn.skeleton) for (const w of l.split(' ')) positional.add(w.replace(/[[\]()]/g, ''));
    for (const vals of Object.values(args)) for (const v of vals) positional.add(v.replace(/[()]/g, ''));
    const au = {};
    const ac = {};
    for (const name of [...positional].sort(cmp)) {
      if (syn.units[name]) au[name] = syn.units[name];
      if (syn.choices[name]) ac[name] = syn.choices[name];
    }
    if (Object.keys(au).length) entry.u = au;
    if (Object.keys(ac).length) entry.c = ac;
    if (Object.keys(syn.words).length) entry.w = Object.fromEntries(Object.keys(syn.words).sort(cmp).map(k => [k, syn.words[k]]));
    if (def) entry.d = def.pairs || def.line;
    if (Object.keys(entry).length) out[page] = entry;
  }
  return out;
}

/** JSON with one row per line for the big maps, so diffs stay readable. */
function stringify(value, depth = 0) {
  if (Array.isArray(value) || value === null || typeof value !== 'object') return JSON.stringify(value);
  const keys = Object.keys(value);
  if (depth >= 2) return JSON.stringify(value);
  const pad = '  '.repeat(depth + 1);
  return '{\n' + keys.map(k => `${pad}${JSON.stringify(k)}: ${stringify(value[k], depth + 1)}`).join(',\n') + '\n' + '  '.repeat(depth) + '}';
}

/* ------------------------------------------------------------------ */

const { text, docsText, report } = emit();
if (REPORT) for (const line of report.sort(cmp)) console.log(line);
if (CHECK) {
  const same = (file, want) => fs.existsSync(file) && fs.readFileSync(file, 'utf8') === want;
  const ok = same(OUT_TABLE, text) && same(OUT_DOCS, docsText);
  console.log(ok ? 'lammps-commands.js and lammps-docs.js are up to date.' : 'The LAMMPS tables are out of date: run node tools/build-lammps-docs.mjs');
  process.exit(ok ? 0 : 1);
}
fs.writeFileSync(OUT_TABLE, text);
fs.writeFileSync(OUT_DOCS, docsText);
console.log(`Wrote ${path.relative(ROOT, OUT_TABLE)} (${(text.length / 1024).toFixed(1)} kB) and ${path.relative(ROOT, OUT_DOCS)} (${(docsText.length / 1024).toFixed(1)} kB).`);
