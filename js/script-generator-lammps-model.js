/*
 * STEMKit, MD Workflow Generator: the LAMMPS tab's plain functions.
 * Author: Olanrewaju M. Daramola
 *
 * No DOM here, so the tests run them in Node: the unit labels the form
 * shows, the lengths it converts, the colouring of an input line, and the
 * checks of a set of input files, where a stage that reads a shared file
 * with `include` is checked with that file read in, as LAMMPS reads it.
 */

/** The stages, in the order they run (the workflow module's keys). */
export const STAGE_KEYS = ['min', 'nvt', 'npt', 'prod'];

/** How each severity looks on the page. */
export const SEVERITY = {
  error: { label: 'Error', cls: 'error', badge: 'stk-badge-danger', icon: 'fa-circle-xmark' },
  warning: { label: 'Warning', cls: 'warning', badge: 'stk-badge-warn', icon: 'fa-triangle-exclamation' },
  note: { label: 'Note', cls: 'note', badge: 'stk-badge-accent', icon: 'fa-circle-info' }
};

/*
 * The unit labels of each style, for the form before the reference has
 * loaded (and for a style it does not list). From the units command's page:
 * https://docs.lammps.org/units.html
 */
const FALLBACK_UNITS = {
  real: { time: 'fs', timeInPs: 0.001, distance: 'Å', energy: 'kcal/mol', pressure: 'atm', temperature: 'K', force: 'kcal/mol/Å' },
  metal: { time: 'ps', timeInPs: 1, distance: 'Å', energy: 'eV', pressure: 'bar', temperature: 'K', force: 'eV/Å' },
  lj: { time: 'τ', timeInPs: null, distance: 'σ', energy: 'ε', pressure: 'reduced', temperature: 'reduced', force: 'ε/σ' },
  si: { time: 's', timeInPs: 1e12, distance: 'm', energy: 'J', pressure: 'Pa', temperature: 'K', force: 'N' },
  cgs: { time: 's', timeInPs: 1e12, distance: 'cm', energy: 'erg', pressure: 'dyne/cm²', temperature: 'K', force: 'dyne' },
  electron: { time: 'fs', timeInPs: 0.001, distance: 'Bohr', energy: 'Hartree', pressure: 'Pa', temperature: 'K', force: 'Hartree/Bohr' },
  micro: { time: 'µs', timeInPs: 1e6, distance: 'µm', energy: 'pg·µm²/µs²', pressure: 'pg/(µm·µs²)', temperature: 'K', force: 'pg·µm/µs²' },
  nano: { time: 'ns', timeInPs: 1000, distance: 'nm', energy: 'ag·nm²/ns²', pressure: 'ag/(nm·ns²)', temperature: 'K', force: 'ag·nm/ns²' }
};

const PS = { fs: 0.001, ps: 1, ns: 1000 };

/*
 * A label from the reference's unit table: its entries may be plain strings
 * or {label}; 'Angstroms' and friends are shortened to what a field shows.
 */
function short(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? (v.symbol || v.short || v.label || '') : String(v);
  return s.replace(/^Angstroms?$/i, 'Å').replace(/^femtoseconds?$/i, 'fs').replace(/^picoseconds?$/i, 'ps')
    .replace(/^Kelvin$/i, 'K').replace(/^atmospheres?$/i, 'atm').replace(/^bars?$/i, 'bar');
}

/**
 * The labels and conversions for a units style.
 *
 * @param {object|null} table - UNITS from the reference, or null before it loads.
 * @param {string} style - 'real', 'metal', 'lj', ...
 * @returns {{style:string, timeInPs:number|null, outUnit:string, labels:object,
 *   toTime:(value:number, unit:string)=>number}}
 */
export function unitLabels(table, style) {
  const fb = FALLBACK_UNITS[style] || FALLBACK_UNITS.real;
  const t = (table && table[style]) || {};
  const pick = (k) => short(t[k]) || fb[k];
  const timeInPs = Number.isFinite(Number(t.timeInPs)) && Number(t.timeInPs) > 0 ? Number(t.timeInPs) : fb.timeInPs;
  const lj = style === 'lj' || !timeInPs;
  const distance = pick('distance');
  const energy = pick('energy');
  const labels = {
    time: pick('time'),
    'time-out': lj ? pick('time') : 'ps',
    distance,
    energy,
    pressure: pick('pressure'),
    temperature: pick('temperature'),
    force: pick('force') || `${energy}/${distance}`,
    spring: `${energy}/${distance}²`
  };
  return {
    style,
    timeInPs: lj ? null : timeInPs,
    outUnit: lj ? 'tau' : 'ps',
    labels,
    /* A value in fs, ps or ns (or tau) in the style's time unit. */
    toTime(value, unit) {
      const v = Number(value);
      if (!Number.isFinite(v)) return 0;
      if (lj || unit === 'tau') return v;
      const ps = v * (PS[unit] ?? 1);
      return round(ps / timeInPs);
    }
  };
}

/* Rounding that removes the binary noise of a unit conversion. */
function round(x) {
  return Number(Number(x).toPrecision(12));
}

/**
 * The units a stage length can be given in.
 *
 * @param {string} style
 * @returns {Array<{value:string, label:string}>}
 */
export function lengthOptions(style) {
  if (style === 'lj') return [{ value: 'tau', label: 'τ' }];
  return [{ value: 'fs', label: 'fs' }, { value: 'ps', label: 'ps' }, { value: 'ns', label: 'ns' }];
}

/**
 * A time in the style's units, for reading: "100 ps", "2 fs", "5,000 τ".
 *
 * @param {number} t - In the style's time unit.
 * @param {{timeInPs:number|null, labels:object}} units - From unitLabels.
 * @returns {string}
 */
export function formatTime(t, units) {
  const v = Number(t);
  if (!Number.isFinite(v)) return '';
  if (!units || !units.timeInPs) return `${formatNumber(v)} ${units ? units.labels.time : ''}`.trim();
  const ps = v * units.timeInPs;
  if (ps === 0) return '0 ps';
  if (ps < 1) return `${formatNumber(ps * 1000)} fs`;
  if (ps < 1000) return `${formatNumber(ps)} ps`;
  if (ps < 1e6) return `${formatNumber(ps / 1000)} ns`;
  return `${formatNumber(ps / 1e6)} µs`;
}

function formatNumber(x) {
  const r = Number(Number(x).toPrecision(6));
  return r.toLocaleString('en-GB', { maximumFractionDigits: 6 });
}

/** Whole numbers with thousands separators. */
export function formatCount(n) {
  return Number.isFinite(Number(n)) ? Math.round(Number(n)).toLocaleString('en-GB') : '';
}

/** A size in bytes as B, kB, MB or GB (powers of 1000). */
export function formatBytes(b) {
  const v = Number(b) || 0;
  if (v < 1000) return `${Math.round(v)} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let x = v / 1000;
  let i = 0;
  while (x >= 1000 && i < units.length - 1) { x /= 1000; i++; }
  return `${Number(x.toPrecision(3))} ${units[i]}`;
}

/* ------------------------------------------------------------------ *
 * Colouring a line
 * ------------------------------------------------------------------ */

/* Where the style name sits after the command, for the commands that have one. */
const STYLE_AT = {
  fix: 2, compute: 2, dump: 2, region: 1,
  pair_style: 0, bond_style: 0, angle_style: 0, dihedral_style: 0, improper_style: 0,
  kspace_style: 0, atom_style: 0, min_style: 0, run_style: 0, units: 0, boundary: -1
};

/**
 * One physical line of a LAMMPS input as HTML: the command, the style,
 * variables, strings, the comment and a continuation mark each coloured.
 * Every character is kept, so the pane's text is the file.
 *
 * @param {string} line
 * @param {(s:string)=>string} esc - HTML escaping.
 * @param {boolean} [continued] - The line carries on the command above (after `&`).
 * @returns {string}
 */
export function lammpsLineHtml(line, esc, continued = false) {
  const span = (cls, text) => `<span class="${cls}">${esc(text)}</span>`;
  const trimmed = line.trimStart();
  if (!trimmed) return esc(line);
  if (trimmed.startsWith('#') && !continued) {
    return span(/^#\s*[-=]{3,}/.test(trimmed) ? 'tok-h' : 'tok-c', line);
  }
  // The comment starts at the first # outside quotes.
  let cut = -1;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    if (quote) {
      if (line.startsWith(quote, i)) { i += quote.length - 1; quote = null; }
      continue;
    }
    if (line.startsWith('"""', i)) { quote = '"""'; i += 2; continue; }
    const c = line[i];
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#') { cut = i; break; }
  }
  const code = cut < 0 ? line : line.slice(0, cut);
  const comment = cut < 0 ? '' : line.slice(cut);
  let out = '';
  let index = continued ? 1 : 0;
  let command = '';
  const re = /(\s+)|("""[^]*?(?:"""|$)|"[^"]*(?:"|$)|'[^']*(?:'|$))|(\S+)/g;
  let m;
  while ((m = re.exec(code))) {
    if (m[1]) { out += esc(m[1]); continue; }
    if (m[2]) { out += span('tok-s', m[2]); index++; continue; }
    const word = m[3];
    if (index === 0) {
      command = word;
      out += span('tok-k', word);
    } else if (word === '&' && /^\s*$/.test(code.slice(re.lastIndex))) {
      out += span('tok-d', word);
    } else if (/\$/.test(word)) {
      out += word.split(/(\$\{[^}]*\}|\$\([^)]*\)?|\$[A-Za-z0-9_])/).map((p, i) => (i % 2 ? span('tok-v', p) : esc(p))).join('');
    } else if (!continued && STYLE_AT[command] !== undefined && index - 1 === STYLE_AT[command]) {
      out += span('tok-st', word);
    } else {
      out += esc(word);
    }
    index++;
  }
  if (comment) out += span('tok-c', comment);
  return out;
}

/**
 * One line of any of the run files, as HTML.
 *
 * @param {string} kind - 'lammps', 'sh', 'md' or 'plumed'.
 * @param {string} line
 * @param {(s:string)=>string} esc
 * @param {Function} highlightLine - The page's shell colouring.
 * @param {boolean} [continued]
 * @returns {string}
 */
export function lineHtml(kind, line, esc, highlightLine, continued = false) {
  if (kind === 'lammps') return lammpsLineHtml(line, esc, continued);
  if (kind === 'sh') return highlightLine(line, {});
  if (kind === 'md') return /^#/.test(line) ? `<span class="tok-d">${esc(line)}</span>` : esc(line);
  if (kind === 'plumed') return /^\s*#/.test(line) ? `<span class="tok-c">${esc(line)}</span>` : esc(line);
  return esc(line);
}

/* ------------------------------------------------------------------ *
 * Checking the files
 * ------------------------------------------------------------------ */

const INCLUDE = /^\s*include\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:#.*)?$/;

/**
 * A file with the files it includes read in, the way LAMMPS reads them,
 * and where each line came from.
 *
 * @param {string} name
 * @param {Map<string, {text:string}>} byName
 * @param {Set<string>} [seen] - Guards against a file including itself.
 * @returns {{lines:string[], map:Array<{file:string, line:number}>, includes:string[]}}
 */
export function expandIncludes(name, byName, seen = new Set()) {
  const f = byName.get(name);
  const own = String(f ? f.text : '').replace(/\n$/, '').split('\n');
  const lines = [];
  const map = [];
  const includes = [];
  own.forEach((l, i) => {
    const m = INCLUDE.exec(l);
    const target = m ? (m[1] || m[2] || m[3]) : null;
    if (target && byName.has(target) && !seen.has(target) && target !== name) {
      // The include line stays, as a comment, so line numbers still map;
      // what LAMMPS reads from the file follows it.
      lines.push(`# ${l}`);
      map.push({ file: name, line: i + 1, include: target });
      const sub = expandIncludes(target, byName, new Set([...seen, name]));
      lines.push(...sub.lines);
      map.push(...sub.map);
      includes.push(target, ...sub.includes);
    } else {
      lines.push(l);
      map.push({ file: name, line: i + 1 });
    }
  });
  return { lines, map, includes };
}

/* Whether the checker follows `include` into files it is given
   (checkInput(text, {files})); asked once per module. */
const FOLLOWS = new WeakMap();
/**
 * Whether the checker follows `include` into the files it is given.
 *
 * @param {object} api - src/core/lammps-input.js.
 * @returns {boolean}
 */
export function followsIncludes(api) {
  if (!api || typeof api !== 'object') return false;
  if (!FOLLOWS.has(api)) {
    let ok = false;
    try {
      const r = api.checkInput('include stemkit.probe\n', { files: { 'stemkit.probe': 'units metal\n' } });
      ok = !!(r && r.state && r.state.units === 'metal');
    } catch (_) { ok = false; }
    FOLLOWS.set(api, ok);
  }
  return FOLLOWS.get(api);
}

/* The files another file includes, by name: a plain `include` line or one
   inside an `if ... then "include ..."`. */
function includedNames(files) {
  const names = new Set();
  for (const f of files) {
    for (const g of files) {
      if (g === f) continue;
      const word = g.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(^|[\\s"'])include\\s+["']?${word}(?=["'\\s]|$)`, 'm').test(f.text)) names.add(g.name);
    }
  }
  return names;
}

/**
 * Check and explain every LAMMPS input of a workflow. Each file is read with
 * the files it includes, so a stage sees the units and styles its shared
 * settings set; what is found on an included line is reported in that file.
 *
 * When the checker follows includes itself (`files`), it is given every
 * input and reads them as LAMMPS does, `if` and all; otherwise plain
 * `include` lines are read in here.
 *
 * @param {object} api - src/core/lammps-input.js (checkInput, explainInput).
 * @param {Array<{name:string, kind:string, text:string}>} files
 * @param {object} [options] - Passed to checkInput and explainInput (`vars`, `packages`,
 *   `restart`); `order`, the file names in the order the stages run.
 * @returns {{rows:Map<string, object[]>, issues:Map<string, object[]>, runs:Map<string, object>}}
 */
export function explainFiles(api, files, options = {}) {
  const lammps = (files || []).filter(f => f.kind === 'lammps');
  const rows = new Map();
  const issues = new Map(lammps.map(f => [f.name, []]));
  const runs = new Map();
  const seen = new Set();
  const report = (i, file, line, via) => {
    const key = `${file}|${i.id || ''}|${line}|${i.message}`;
    if (seen.has(key) || !issues.has(file)) return;
    seen.add(key);
    issues.get(file).push({ ...i, line, file, via: via !== file ? via : null });
  };
  const call = (fn, text, opts) => { try { return fn ? fn(text, opts) : null; } catch (_) { return null; } };

  if (followsIncludes(api)) {
    const texts = Object.fromEntries(lammps.map(f => [f.name, f.text]));
    const included = includedNames(lammps);
    const { order, ...rest } = options;
    const opts = { ...rest, files: texts };
    // The stages in the order they run, so that each read_restart gets what
    // the stage before it saved (checkChain), when the checker can.
    const roots = lammps.filter(x => !included.has(x.name));
    if (Array.isArray(order)) {
      const at = (n) => { const i = order.indexOf(n); return i < 0 ? order.length : i; };
      roots.sort((a, b) => at(a.name) - at(b.name));
    }
    let chain = null;
    let explained = null;
    const stages = roots.map(f => ({ name: f.name, text: f.text }));
    if (api.checkChain) {
      try { chain = api.checkChain(stages, opts); } catch (_) { chain = null; }
    }
    // The explanations too follow the chain, so a stage after a restart
    // speaks in the units the restart brings back.
    if (api.explainChain) {
      try { explained = api.explainChain(stages, opts); } catch (_) { explained = null; }
    }
    for (const f of roots) {
      const checked = chain ? chain.find(c => c.name === f.name) || null : call(api.checkInput, f.text, opts);
      runs.set(f.name, checked);
      for (const i of (checked && checked.issues) || []) report(i, i.file || f.name, i.line || 0, f.name);
      const bucket = new Map();
      const given = explained ? (explained.find(e => e.name === f.name) || {}).rows : null;
      for (const r of given || call(api.explainInput, f.text, opts) || []) {
        const file = r.file || f.name;
        if (!bucket.has(file)) bucket.set(file, []);
        bucket.get(file).push({ ...r, file });
      }
      for (const [file, list] of bucket) if (!rows.has(file)) rows.set(file, list);
    }
    // An included file the explanations did not reach: on its own.
    for (const f of lammps) {
      if (!rows.has(f.name)) rows.set(f.name, (call(api.explainInput, f.text, opts) || []).map(r => ({ ...r, file: f.name })));
    }
  } else {
    const byName = new Map(lammps.map(f => [f.name, f]));
    const expansions = lammps.map(f => ({ f, ex: expandIncludes(f.name, byName) }));
    const included = new Set(expansions.flatMap(({ ex }) => ex.includes));
    // A file another includes is read only where it is included: on its own
    // it lacks what the including file set before it (units, the box).
    const { order, ...rest } = options;
    void order;
    for (const { f, ex } of expansions.filter(({ f }) => !included.has(f.name))) {
      const text = `${ex.lines.join('\n')}\n`;
      const checked = call(api.checkInput, text, rest);
      runs.set(f.name, checked);
      for (const i of (checked && checked.issues) || []) {
        const at = ex.map[(i.line || 1) - 1] || { file: f.name, line: 0 };
        report(i, at.file, i.line ? at.line : 0, f.name);
      }
      const bucket = new Map();
      for (const r of call(api.explainInput, text, rest) || []) {
        const at = ex.map[(r.line || 1) - 1];
        if (!at) continue;
        const end = ex.map[((r.lastLine || r.line) || 1) - 1];
        const row = { ...r, line: at.line, lastLine: end && end.file === at.file ? end.line : at.line, file: at.file };
        if (at.include) {
          // The include line, shown as the command it is.
          Object.assign(row, {
            kind: 'command', command: 'include', style: '', title: 'include', text: `include ${at.include}`,
            meaning: `Reads ${at.include} here, as if its lines were written in this file.`,
            summary: '', url: 'https://docs.lammps.org/include.html', status: 'ok', issues: []
          });
        }
        if (!bucket.has(at.file)) bucket.set(at.file, []);
        bucket.get(at.file).push(row);
      }
      for (const [file, list] of bucket) if (!rows.has(file)) rows.set(file, list);
    }
  }
  // Without the explainer, each command still gets its name, the
  // reference's summary and its page.
  for (const f of lammps) {
    if (rows.has(f.name) && rows.get(f.name).length) continue;
    rows.set(f.name, basicRows(api, f));
  }
  // Each row carries the problems found on its lines.
  for (const [file, list] of rows) {
    const found = issues.get(file) || [];
    for (const r of list) {
      const last = r.lastLine || r.line;
      const have = new Set((r.issues || []).map(i => i.message));
      const own = found.filter(i => i.line && i.line >= r.line && i.line <= last && !have.has(i.message));
      r.issues = [...(r.issues || []), ...own];
    }
  }
  return { rows, issues, runs };
}

/* Where the style name sits after the command, for the reference. */
const STYLE_ARG = { fix: 2, compute: 2, dump: 2, region: 1 };

/**
 * The rows of a file from the reader and the reference alone, for when the
 * explainer is not there: the command, its style, the reference's summary
 * and its page.
 *
 * @param {object} api - src/core/lammps-input.js.
 * @param {{name:string, text:string}} f
 * @returns {object[]} One row per logical line, as explainInput gives them.
 */
export function basicRows(api, f) {
  if (!api || !api.parseInput) return [];
  let parsed;
  try { parsed = api.parseInput(f.text); } catch (_) { return []; }
  return parsed.lines.map((l) => {
    const row = { line: l.line, lastLine: l.lastLine, kind: l.kind, text: l.text, command: l.command, comment: l.comment, file: f.name, issues: [], status: 'ok' };
    if (l.kind !== 'command') return row;
    const pos = STYLE_ARG[l.command];
    const kind = api.styleKind ? api.styleKind(l.command) : '';
    const style = pos !== undefined ? l.args[pos] : kind ? l.args[0] : '';
    let info = null;
    try { info = api.commandInfo ? (style ? api.commandInfo(l.command, style) : api.commandInfo(l.command)) : null; } catch (_) { info = null; }
    row.style = style || '';
    row.title = info ? info.key.replace(/^(\S+ \S+).*$/, '$1') : (style ? `${l.command} ${style}` : l.command);
    row.summary = info ? info.summary || '' : '';
    row.url = info ? info.url || '' : (api.lammpsDocUrl ? api.lammpsDocUrl(l.command, style) || '' : '');
    row.package = info && info.package ? info.package : '';
    return row;
  });
}

/**
 * A file's verdict: what the tab and the stage card show.
 *
 * @param {{name:string, kind:string}} file
 * @param {{issues:Map<string, object[]>}|null} checks - From explainFiles.
 * @returns {{level:'ok'|'error'|'warning', badge:string, text:string}|null}
 */
export function statusOfFile(file, checks) {
  if (!file || file.kind !== 'lammps' || !checks) return null;
  const list = checks.issues.get(file.name) || [];
  const errors = list.filter(i => i.severity === 'error').length;
  const warnings = list.filter(i => i.severity === 'warning').length;
  if (errors) return { level: 'error', badge: 'LAMMPS stops', text: `LAMMPS stops: ${errors} error${errors === 1 ? '' : 's'}` };
  if (warnings) return { level: 'warning', badge: `${warnings} warning${warnings === 1 ? '' : 's'}`, text: `${warnings} warning${warnings === 1 ? '' : 's'}` };
  const notes = list.length;
  return { level: 'ok', badge: 'checked', text: notes ? `No problems; ${notes} note${notes === 1 ? '' : 's'}` : 'No problems found' };
}

/**
 * The packages a LAMMPS build has, from what `lmp -h` prints.
 *
 * @param {string} text
 * @returns {{packages:string[], styles:Object<string, string[]>, version:string}|null}
 *   null when the text has no package list.
 */
export function packagesFromHelp(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  const version = (/Large-scale Atomic\/Molecular Massively Parallel Simulator - ([^\n]+)/.exec(src) || [])[1] || '';
  const at = src.search(/^Installed packages:\s*$/m);
  if (at < 0) return null;
  const rest = src.slice(at).split('\n').slice(1);
  const words = [];
  let started = false;
  for (const l of rest) {
    if (!l.trim()) { if (started) break; continue; }
    if (/:\s*$/.test(l) || /^List of/.test(l)) break;
    started = true;
    words.push(...l.trim().split(/\s+/));
  }
  const styles = {};
  const re = /^\* ([A-Za-z ]+) styles:?[ \t]*$/gm;
  let m;
  while ((m = re.exec(src))) {
    const kind = m[1].trim().toLowerCase();
    // The names follow a blank line and end at the next one.
    const body = src.slice(re.lastIndex).replace(/^\s*\n/, '').split(/\n[ \t]*\n/)[0] || '';
    styles[kind] = body.trim().split(/\s+/).filter(Boolean);
  }
  return { packages: words.filter(w => /^[A-Z0-9-]+$/.test(w)), styles, version: version.trim() };
}
