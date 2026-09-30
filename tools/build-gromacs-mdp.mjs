#!/usr/bin/env node
/*
 * build-gromacs-mdp.mjs: turn the GROMACS .mdp documentation and grompp's own
 * reader into the option tables src/core/gromacs-mdp-options.js (names, kinds,
 * defaults, choices, units, one-line summaries) and src/core/gromacs-mdp-docs.js
 * (the full documentation of every option and value, as simple HTML).
 *
 * Two sources, because neither is complete on its own:
 *
 *   - docs/user-guide/mdp-options.rst is what the manual prints: sections,
 *     documented choices and their text, units, and the anchors the online
 *     manual links to;
 *   - src/gromacs/gmxpreprocess/readir.cpp (with readpull.cpp, readrot.cpp and
 *     the AWH reader) is what grompp actually reads: the exact names, the
 *     defaults, every spelling an enum accepts, and which options are read only
 *     when another one switches them on. Where the two disagree the source wins,
 *     and the difference is kept in the table (`docDefault`, `docName`).
 *
 * The one-line summaries are written by hand below (SUMMARIES), from the
 * documentation, so that a newcomer can read what a setting does before the
 * full text. Keep them faithful to the manual.
 *
 * Usage, once per GROMACS release:
 *     node tools/build-gromacs-mdp.mjs [--source gromacs-2025.1] [--check] [--report]
 *
 * --source  a GROMACS source tree (default: ./gromacs-2025.1, which is not in git)
 * --check   compare against the files on disk and exit 1 when they differ
 * --report  print where the documentation and the source disagree
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_OPTIONS = path.join(ROOT, 'src', 'core', 'gromacs-mdp-options.js');
const OUT_DOCS = path.join(ROOT, 'src', 'core', 'gromacs-mdp-docs.js');
const ANCHOR_FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'gromacs', 'manual-anchors-2025.1.txt');

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}
const SOURCE = path.resolve(ROOT, arg('source', 'gromacs-2025.1'));
const CHECK = process.argv.includes('--check');
const REPORT = process.argv.includes('--report');

const read = (rel) => {
  const file = path.join(SOURCE, rel);
  if (!fs.existsSync(file)) {
    console.error(`Missing ${file}. Pass --source <GROMACS source tree>.`);
    process.exit(2);
  }
  return fs.readFileSync(file, 'utf8');
};

const RELEASE = (() => {
  const text = read('cmake/gmxVersionInfo.cmake');
  const major = /set\(GMX_VERSION_MAJOR (\d+)\)/.exec(text);
  const patch = /set\(GMX_VERSION_PATCH (\d+)\)/.exec(text);
  return major ? `${major[1]}${patch && patch[1] !== '0' ? `.${patch[1]}` : ''}` : '2025.1';
})();
const MANUAL = `https://manual.gromacs.org/${RELEASE}/user-guide/mdp-options.html`;

/* GROMACS compares names and enum values with gmx_strcasecmp_min: case is
   ignored and so are '-' and '_', wherever they are. */
const key = (s) => String(s).toUpperCase().replace(/[-_]/g, '');

/* ================================================================== *
 * 1. The reStructuredText documentation
 * ================================================================== */

const RST = read('docs/user-guide/mdp-options.rst').replace(/\r\n?/g, '\n').split('\n');

/* A section heading is a line underlined by ^^^^ (the file's third level). */
function isUnderline(line, ch) {
  return line.length >= 3 && [...line].every(c => c === ch);
}
const indentOf = (line) => line.length - line.trimStart().length;

/* Sphinx's make_id, as used by add_object_type (sphinx/util/nodes.py):
   non-ASCII dropped, runs of anything but [a-zA-Z0-9._] become '-', leading
   '-0-9._' and trailing '-_' stripped. Capitals are kept. */
function sphinxId(s) {
  let id = String(s).normalize('NFKD').replace(/[^\x00-\x7f]/g, '');
  id = id.split(/\s+/).filter(Boolean).join(' ');
  id = id.replace(/[^a-zA-Z0-9._]+/g, '-');
  return id.replace(/^[-0-9._]+|[-_]+$/g, '');
}
function slug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/*
 * Walk the file once and collect sections, option directives and value
 * directives with the raw lines of their bodies. Directive names are
 * case-insensitive in docutils (the file has `.. MDP:: QMMM`); a line such as
 * `.. mdp-value: false` (one colon) is an rst comment and renders as nothing.
 */
function parseRst() {
  const sections = [];
  const options = [];
  const ids = new Set(); // every id Sphinx assigns on the page, for collisions
  let section = null;
  let i = 0;
  const N = RST.length;

  const body = (start, minIndent) => {
    // Lines belonging to a directive: blank, or indented deeper than it.
    const out = [];
    let j = start;
    while (j < N) {
      const l = RST[j];
      if (l.trim() && indentOf(l) <= minIndent) break;
      out.push(l);
      j += 1;
    }
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return { lines: out, next: j };
  };

  while (i < N) {
    const line = RST[i];
    const next = RST[i + 1] || '';
    if (line.trim() && !line.startsWith(' ') && !line.startsWith('..') && isUnderline(next, '^')) {
      section = { id: slug(line.trim()), title: line.trim(), intro: [] };
      sections.push(section);
      ids.add(section.id);
      i += 2;
      continue;
    }
    if (line.trim() && !line.startsWith(' ') && (isUnderline(next, '=') || isUnderline(next, '-'))) {
      ids.add(slug(line.trim()));
      i += 2;
      continue;
    }
    const label = /^\.\. _([^:]+):\s*$/.exec(line);
    if (label) {
      ids.add(label[1]);
      i += 1;
      continue;
    }
    const dir = /^\.\. (mdp|mdp-value)::\s*(.*?)\s*$/i.exec(line);
    if (dir && dir[1].toLowerCase() === 'mdp') {
      const { lines, next: j } = body(i + 1, 0);
      options.push({ written: dir[2], section, line: i + 1, lines });
      i = j;
      continue;
    }
    if (line.startsWith('..')) {
      // Any other directive or comment at the top level, with its body.
      i = body(i + 1, 0).next;
      continue;
    }
    if (section && line.trim()) section.intro.push(line);
    else if (section && section.intro.length) section.intro.push('');
    i += 1;
  }
  return { sections, options, ids };
}

/* Split an option body into its own text and its value directives. A
   paragraph written directly after an empty value directive, at the
   directive's own indent (sc-function does this), is taken as that value's
   text, which is what the author meant; Sphinx shows it after the value. */
function splitValues(lines) {
  const own = [];
  const values = [];
  let k = 0;
  while (k < lines.length) {
    const l = lines[k];
    const m = /^(\s*)\.\. mdp-value::\s*(.*?)\s*$/.exec(l);
    if (m) {
      const ind = m[1].length;
      const vb = [];
      let j = k + 1;
      while (j < lines.length && (!lines[j].trim() || indentOf(lines[j]) > ind)) {
        vb.push(lines[j]);
        j += 1;
      }
      while (vb.length && !vb[vb.length - 1].trim()) vb.pop();
      if (!vb.some(x => x.trim())) {
        // Dangling text: the following paragraph at the same indent.
        const para = [];
        while (j < lines.length && lines[j].trim() && indentOf(lines[j]) === ind &&
          !/^\s*\.\./.test(lines[j])) {
          para.push(lines[j]);
          j += 1;
        }
        vb.push(...para);
      }
      values.push({ written: m[2], lines: vb });
      k = j;
      continue;
    }
    const comment = /^(\s*)\.\.\s+(?!math::)[^:]*$|^(\s*)\.\. mdp-value:[^:]/.exec(l);
    if (comment && /^\s*\.\.\s/.test(l) && !/^\s*\.\. math::/.test(l)) {
      // An rst comment (e.g. `.. mdp-value: false`) hides its indented body.
      const ind = indentOf(l);
      k += 1;
      while (k < lines.length && (!lines[k].trim() || indentOf(lines[k]) > ind)) k += 1;
      continue;
    }
    own.push(l);
    k += 1;
  }
  return { own, values };
}

/* ------------------------------------------------------------------ *
 * Inline markup to HTML and to plain text
 * ------------------------------------------------------------------ */

const SUPERSCRIPT = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '/': 'ᐟ' };
const sup = (s) => [...s].map(c => SUPERSCRIPT[c] || c).join('');
const UNSUP = Object.fromEntries(Object.entries(SUPERSCRIPT).map(([k, v]) => [v, k]));
/* Back from superscripts: 10⁻⁵ -> 10^-5. */
const unsup = (s) => String(s).replace(/[⁻⁰¹²³⁴⁵⁶⁷⁸⁹ᐟ]+/g, (m) => `^${[...m].map(c => UNSUP[c]).join('')}`);

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* Labels :ref: points at, shown the way the manual titles them. */
const REF_TITLES = {
  tpr: 'tpr', mdp: 'mdp', top: 'top', edr: 'edr', trr: 'trr', xtc: 'xtc', qmmm: 'QM/MM', colvars: 'Colvars',
  'electric fields': 'electric fields'
};

/*
 * Convert one paragraph of inline rst. Returns { html, text, refs } where refs
 * lists the options it points at (for `related`).
 *
 * :mdp:`x` becomes <a data-mdp="x">x</a> and :mdp-value:`x=v` becomes
 * <a data-mdp="x" data-value="v">x=v</a>; the reader in gromacs-mdp.js turns
 * these into links to the manual or to the page's own panel.
 */
function inline(src) {
  const refs = [];
  let html = '';
  let text = '';
  const s = String(src).replace(/\|Gromacs\|/g, 'GROMACS').replace(/\\ :sup:/g, ':sup:');
  const re = /:(mdp-value|mdp|ref|sup|math|sub):`([^`]*)`|``([^`]+)``|`([^`<]+?)\s*<([^>]+)>`_{1,2}|`([^`]+)`_{1,2}|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|`([^`]+)`|\b([A-Za-z]+)_\b|\\(.)/g;
  let last = 0;
  let m;
  const plain = (t) => { html += escapeHtml(t); text += t; };
  while ((m = re.exec(s))) {
    plain(s.slice(last, m.index));
    last = re.lastIndex;
    if (m[1] === 'mdp') {
      const name = m[2].trim();
      const eq = name.indexOf('=');
      if (eq > 0) {
        // A value written with the option role, as in :mdp:`x=constant`.
        refs.push(name.slice(0, eq));
        html += `<a data-mdp="${escapeHtml(name.slice(0, eq))}" data-value="${escapeHtml(name.slice(eq + 1))}">${escapeHtml(name)}</a>`;
      } else {
        refs.push(name);
        html += `<a data-mdp="${escapeHtml(name)}">${escapeHtml(name)}</a>`;
      }
      text += name;
    } else if (m[1] === 'mdp-value') {
      const v = m[2].trim();
      const eq = v.indexOf('=');
      if (eq > 0) {
        refs.push(v.slice(0, eq));
        html += `<a data-mdp="${escapeHtml(v.slice(0, eq))}" data-value="${escapeHtml(v.slice(eq + 1))}">${escapeHtml(v)}</a>`;
      } else {
        html += `<code>${escapeHtml(v)}</code>`;
      }
      text += v;
    } else if (m[1] === 'ref') {
      const r = /^(.*?)\s*<([^>]+)>$/.exec(m[2]);
      const shown = r ? r[1] : (REF_TITLES[m[2]] || m[2]);
      if (/^gmx /.test(shown)) html += `<code>${escapeHtml(shown)}</code>`;
      else html += escapeHtml(shown);
      text += shown;
    } else if (m[1] === 'sup') {
      html += `<sup>${escapeHtml(m[2])}</sup>`;
      text += sup(m[2]);
    } else if (m[1] === 'sub') {
      html += `<sub>${escapeHtml(m[2])}</sub>`;
      text += m[2];
    } else if (m[1] === 'math') {
      html += `<code class="math">${escapeHtml(m[2])}</code>`;
      text += m[2];
    } else if (m[3] !== undefined) {
      html += `<code>${escapeHtml(m[3])}</code>`;
      text += m[3];
    } else if (m[4] !== undefined) {
      const url = m[5].trim();
      if (/^https?:/.test(url)) html += `<a href="${escapeHtml(url)}">${escapeHtml(m[4])}</a>`;
      else html += escapeHtml(m[4]);
      text += m[4];
    } else if (m[6] !== undefined) {
      // `reference manual`_ and similar named links: the text only.
      plain(m[6]);
    } else if (m[7] !== undefined) {
      html += `<strong>${escapeHtml(m[7])}</strong>`;
      text += m[7];
    } else if (m[8] !== undefined) {
      html += `<em>${escapeHtml(m[8])}</em>`;
      text += m[8];
    } else if (m[9] !== undefined) {
      // Default role, used by a few entries for `sc-function=beutler`.
      html += `<code>${escapeHtml(m[9])}</code>`;
      text += m[9];
    } else if (m[10] !== undefined) {
      plain(m[10]); // walls_ : an internal link to a section
    } else if (m[11] !== undefined) {
      plain(m[11]);
    }
  }
  plain(s.slice(last));
  return { html, text, refs };
}

/* Block structure: paragraphs, indented quotes, literal blocks and maths. */
function blocks(lines) {
  const trimmed = lines.map(l => l.replace(/\s+$/, ''));
  const base = Math.min(...trimmed.filter(l => l.trim()).map(indentOf), 99);
  const out = [];
  let k = 0;
  while (k < trimmed.length) {
    const l = trimmed[k];
    if (!l.trim()) { k += 1; continue; }
    const math = /^\s*\.\. math::\s*(.*)$/.exec(l);
    if (math) {
      const ind = indentOf(l);
      const parts = [math[1]];
      k += 1;
      while (k < trimmed.length && (!trimmed[k].trim() || indentOf(trimmed[k]) > ind)) {
        if (trimmed[k].trim()) parts.push(trimmed[k].trim());
        k += 1;
      }
      out.push({ type: 'math', text: parts.filter(Boolean).join(' ') });
      continue;
    }
    const ind = indentOf(l);
    const para = [];
    while (k < trimmed.length && trimmed[k].trim() && indentOf(trimmed[k]) === ind &&
      !/^\s*\.\. math::/.test(trimmed[k])) {
      para.push(trimmed[k].trim());
      k += 1;
    }
    // A deeper line straight after a paragraph continues a definition-style
    // block (``electric-field-x = ...`` followed by an indented line).
    while (k < trimmed.length && trimmed[k].trim() && indentOf(trimmed[k]) > ind) {
      para.push(trimmed[k].trim());
      k += 1;
    }
    let joined = para.join(' ');
    let literal = false;
    if (/::$/.test(joined)) {
      joined = joined.replace(/\s*::$/, joined.endsWith(' ::') ? '' : ':');
      literal = true;
    }
    out.push({ type: ind > base ? 'quote' : 'p', text: joined });
    if (literal) {
      // The indented block that follows is shown verbatim.
      while (k < trimmed.length && !trimmed[k].trim()) k += 1;
      const code = [];
      const lind = k < trimmed.length ? indentOf(trimmed[k]) : 0;
      while (k < trimmed.length && (!trimmed[k].trim() || indentOf(trimmed[k]) >= lind)) {
        code.push(trimmed[k].slice(lind));
        k += 1;
      }
      while (code.length && !code[code.length - 1].trim()) code.pop();
      out.push({ type: 'pre', text: code.join('\n') });
    }
  }
  return out;
}

function renderBlocks(lines) {
  const refs = [];
  const html = [];
  const text = [];
  for (const b of blocks(lines)) {
    if (b.type === 'pre') {
      html.push(`<pre>${escapeHtml(b.text)}</pre>`);
      text.push(b.text);
    } else if (b.type === 'math') {
      html.push(`<pre class="math">${escapeHtml(b.text)}</pre>`);
      text.push(b.text);
    } else {
      const r = inline(b.text);
      refs.push(...r.refs);
      html.push(b.type === 'quote' ? `<blockquote><p>${r.html}</p></blockquote>` : `<p>${r.html}</p>`);
      text.push(r.text);
    }
  }
  return { html: html.join(''), text: text.join('\n\n'), refs };
}

/* The "(default) [unit]" preamble of an option: "(0.001) [ps]", "(10\ :sup:`-5`)",
   "[ps]", "(0) [nm] or [deg]", "(-1) Random seed ...", "(\1)". */
function preamble(ownLines) {
  const firstBlock = blocks(ownLines)[0];
  if (!firstBlock || firstBlock.type === 'pre') return { docDefault: null, unit: '', rest: ownLines };
  let t = firstBlock.text;
  let docDefault = null;
  const d = /^\(([^()]*(?:\([^()]*\))?[^()]*)\)\s*/.exec(t);
  // "(Despite the name, ...)" is prose in brackets, not a default.
  if (d && !/[a-z]{3,}\s+[a-z]{3,}/i.test(d[1])) {
    docDefault = inline(d[1].replace(/^\\/, '')).text.trim();
    t = t.slice(d[0].length);
  }
  const units = [];
  let u;
  while ((u = /^(?:(?:or|,|\/)\s*)?\[([^\]]*)\]\s*/.exec(t))) {
    units.push(inline(u[1]).text.trim());
    t = t.slice(u[0].length);
  }
  // [integer], [real] and [array] describe the value, not a unit.
  const unit = units.filter(x => x && !/^(integer|real|array)$/.test(x)).join(' or ');
  // Rebuild the lines without the preamble: the first paragraph (up to the
  // first blank line) is replaced by what is left of it.
  const i0 = ownLines.findIndex(l => l.trim());
  let i1 = i0;
  while (i1 < ownLines.length && ownLines[i1].trim()) i1 += 1;
  const head = t.trim() ? [`${' '.repeat(indentOf(ownLines[i0]))}${t.trim()}`] : [];
  return { docDefault, unit, rest: [...head, ...ownLines.slice(i1)] };
}

/* ================================================================== *
 * 2. What grompp reads
 * ================================================================== */

/* Enum spellings: every `enumValueToString(Type enumValue)` table. */
function enumTables() {
  const out = {};
  const files = [
    'src/gromacs/mdtypes/md_enums.cpp', 'src/gromacs/mdlib/vcm.cpp',
    'src/gromacs/applied_forces/awh/read_params.cpp'
  ];
  for (const f of files) {
    const text = read(f);
    const re = /const char\* enumValueToString\((\w+) enumValue\)\s*\{[^{]*?=\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(text))) {
      out[m[1]] = [...m[2].matchAll(/"([^"]*)"/g)].map(x => x[1]);
    }
  }
  out.PbcType = [...read('src/gromacs/pbcutil/pbc.cpp').matchAll(/c_pbcTypeNames = \{\s*\{([^}]*)\}/g)]
    .flatMap(m => [...m[1].matchAll(/"([^"]*)"/g)].map(x => x[1]));
  // The defaults: `Default = Member` in the enum declarations.
  const defaults = {};
  for (const f of ['api/legacy/include/gromacs/mdtypes/md_enums.h', 'src/gromacs/mdtypes/awh_params.h']) {
    const text = read(f);
    for (const m of text.matchAll(/enum class (\w+)[^{]*\{([^}]*)\}/g)) {
      const members = m[2].replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').split(',').map(x => x.trim()).filter(Boolean);
      const names = members.filter(x => !/=/.test(x) || /^\w+\s*=\s*\d+$/.test(x)).map(x => x.split('=')[0].trim())
        .filter(x => x !== 'Count');
      const def = members.find(x => /^Default\s*=/.test(x));
      if (def) defaults[m[1]] = names.indexOf(def.split('=')[1].trim());
    }
  }
  // Static arrays in readir.cpp.
  const readir = read('src/gromacs/gmxpreprocess/readir.cpp');
  for (const m of readir.matchAll(/static const char\* const (\w+)\[[^\]]*\]\s*=\s*\{([^}]*)\}/g)) {
    out[`readir:${m[1]}`] = [...m[2].matchAll(/"([^"]*)"/g)].map(x => x[1]);
  }
  out['readir:no_names'] = ['no'];
  out['readir:pbcTypesNamesChar'] = out.PbcType;
  return { names: out, defaults };
}

/* C default expressions: 1E-6, 0., -1, 0.00001, pullCoord.k, nullptr, "Y Y Y". */
function cDefault(expr) {
  const e = String(expr).trim();
  if (e === 'nullptr' || e === 'NULL') return '';
  const s = /^"(.*)"$/.exec(e);
  if (s) return s[1];
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(e)) return Number(e);
  return { expr: e };
}

/* printf's %g, which is how grompp writes a real default into mdout.mdp. */
function formatG(x) {
  if (x === 0) return '0';
  const exp = Math.floor(Math.log10(Math.abs(x)));
  if (exp < -4 || exp >= 6) {
    const [mant, e] = x.toExponential(5).split('e');
    const m = String(Number(mant));
    const n = Number(e);
    return `${m}e${n < 0 ? '-' : '+'}${String(Math.abs(n)).padStart(2, '0')}`;
  }
  return String(Number(x.toPrecision(6)));
}

/*
 * Every option read, in the order grompp reads it. Numbered families are
 * written with their first index as the manual does (pull-coord1-k,
 * awh1-dim1-start, rot-type0, iontype0-name); `family` records the pattern.
 */
function sourceReads(enums) {
  const reads = [];
  const add = (name, reader, args, file, extra = {}) => {
    const r = { name, reader: reader.replace(/^getEnum<(\w+)>$/, 'getEnum'), file, ...extra };
    if (/^getEnum<\w+>$/.test(reader)) r.enumType = /^getEnum<(\w+)>$/.exec(reader)[1];
    const parts = splitArgs(args);
    if (r.reader === 'get_eint' || r.reader === 'get_eint64' || r.reader === 'get_ereal') {
      r.def = cDefault(parts[0]);
    } else if (r.reader === 'setStringEntry') {
      r.def = cDefault(parts.length > 1 ? parts[1] : parts[0]);
    } else if (r.reader === 'get_eeenum') {
      r.enumType = `readir:${parts[0].trim()}`;
    }
    reads.push(r);
  };

  function splitArgs(s) {
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of s) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out.map(x => x.trim()).filter(x => x && x !== 'wi');
  }

  const CALL = /(get_eint64|get_eint|get_ereal|get_eeenum|setStringEntry|getEnum<\w+>)\(\s*&?inp\s*,\s*("([^"]+)"|buf|opt(?:\.c_str\(\))?)\s*(?:,\s*([\s\S]*?))?\)\s*;/g;

  function scan(file, text, gate, prefixFor = null) {
    // Track sprintf(buf, "...") and opt = ... so a call on buf/opt gets its name.
    const events = [];
    for (const m of text.matchAll(/sprintf\(buf,\s*"([^"]+)"/g)) events.push({ at: m.index, kind: 'buf', value: m[1] });
    for (const m of text.matchAll(/\bopt\s*=\s*(?:(prefix\w*)\s*\+\s*)?"([^"]+)"\s*;/g)) {
      events.push({ at: m.index, kind: 'opt', value: m[2], prefix: m[1] || null });
    }
    events.sort((a, b) => a.at - b.at);
    for (const m of text.matchAll(CALL)) {
      let name = m[3];
      if (!name) {
        const kind = m[2].startsWith('buf') ? 'buf' : 'opt';
        const ev = events.filter(e => e.kind === kind && e.at < m.index).pop();
        if (!ev) continue;
        name = ev.value;
        if (ev.prefix && prefixFor) name = prefixFor(m.index) + name;
      }
      name = name.replace(/%d/g, (x, off) => (/^rot-|^iontype/.test(name) ? '0' : '1'));
      add(name, m[1], m[4] || '', file, { gate: typeof gate === 'function' ? gate(name, m.index) : gate });
    }
  }

  const readir = read('src/gromacs/gmxpreprocess/readir.cpp');
  const getIr = readir.slice(readir.indexOf('void get_ir('), readir.indexOf('/* Process options if necessary */'));
  scan('readir.cpp', getIr, (name) => {
    if (/^mts-/.test(name)) return { option: 'mts', value: 'yes' };
    if (SWAP_OPTIONS.has(name)) return { option: 'swapcoords', not: 'no' };
    return null;
  });
  const expanded = readir.slice(readir.indexOf('static void read_expandedparams('), readir.indexOf('static bool couple_lambda_has_vdw_on'));
  scan('readir.cpp', expanded, { expanded: true });
  scan('readpull.cpp', read('src/gromacs/gmxpreprocess/readpull.cpp'), { option: 'pull', value: 'yes' });
  scan('readrot.cpp', read('src/gromacs/gmxpreprocess/readrot.cpp'), { option: 'rotation', value: 'yes' });
  const awh = read('src/gromacs/applied_forces/awh/read_params.cpp');
  const dimStart = awh.indexOf('AwhDimParams::AwhDimParams(');
  const biasStart = awh.indexOf('AwhBiasParams::AwhBiasParams(');
  const topStart = awh.indexOf('AwhParams::AwhParams(');
  scan('read_params.cpp', awh, { option: 'awh', value: 'yes' }, (at) => {
    if (at > dimStart && at < biasStart) return 'awh1-dim1';
    if (at > biasStart && at < topStart) return 'awh1';
    return '';
  });
  // Module options (KeyValueTree), always read. Their kinds and defaults are
  // listed by hand in MODULE_OPTIONS below, checked against mdout.mdp by
  // tools/check-gromacs-grompp.mjs.
  for (const [name, spec] of Object.entries(MODULE_OPTIONS)) {
    reads.push({ name, reader: 'module', file: spec.file, def: spec.def, moduleKind: spec.kind, enumValues: spec.values || null });
  }
  return reads;
}

const SWAP_OPTIONS = new Set([
  'swap-frequency', 'iontypes', 'split-group0', 'split-group1', 'massw-split0', 'massw-split1',
  'solvent-group', 'cyl0-r', 'cyl0-up', 'cyl0-down', 'cyl1-r', 'cyl1-up', 'cyl1-down', 'coupl-steps',
  'iontype0-name', 'iontype0-in-A', 'iontype0-in-B', 'bulk-offsetA', 'bulk-offsetB', 'threshold'
]);

/* Options of the MDModules (read through a key-value tree, not get_ir). */
const MODULE_OPTIONS = {
  'electric-field-x': { file: 'electricfield.cpp', kind: 'reals', def: '0 0 0 0', count: 4 },
  'electric-field-y': { file: 'electricfield.cpp', kind: 'reals', def: '0 0 0 0', count: 4 },
  'electric-field-z': { file: 'electricfield.cpp', kind: 'reals', def: '0 0 0 0', count: 4 },
  'density-guided-simulation-active': { file: 'densityfittingoptions.cpp', kind: 'boolean', def: 'false' },
  'density-guided-simulation-group': { file: 'densityfittingoptions.cpp', kind: 'group', def: 'protein' },
  'density-guided-simulation-similarity-measure': { file: 'densityfittingoptions.cpp', kind: 'enum', def: 'inner-product', values: ['inner-product', 'relative-entropy', 'cross-correlation'] },
  'density-guided-simulation-atom-spreading-weight': { file: 'densityfittingoptions.cpp', kind: 'enum', def: 'unity', values: ['unity', 'mass', 'charge'] },
  'density-guided-simulation-force-constant': { file: 'densityfittingoptions.cpp', kind: 'real', def: '1e+09' },
  'density-guided-simulation-gaussian-transform-spreading-width': { file: 'densityfittingoptions.cpp', kind: 'real', def: '0.2' },
  'density-guided-simulation-gaussian-transform-spreading-range-in-multiples-of-width': { file: 'densityfittingoptions.cpp', kind: 'real', def: '4' },
  'density-guided-simulation-reference-density-filename': { file: 'densityfittingoptions.cpp', kind: 'text', def: 'reference.mrc' },
  'density-guided-simulation-nst': { file: 'densityfittingoptions.cpp', kind: 'integer', def: '1' },
  'density-guided-simulation-normalize-densities': { file: 'densityfittingoptions.cpp', kind: 'boolean', def: 'true' },
  'density-guided-simulation-adaptive-force-scaling': { file: 'densityfittingoptions.cpp', kind: 'boolean', def: 'false' },
  'density-guided-simulation-adaptive-force-scaling-time-constant': { file: 'densityfittingoptions.cpp', kind: 'real', def: '4' },
  // The manual writes these (0,0,0), but grompp splits them at white space
  // only (parsedArrayFromInputString), so a comma-separated vector is refused.
  'density-guided-simulation-shift-vector': { file: 'densityfittingoptions.cpp', kind: 'reals', def: '0 0 0', count: 3 },
  'density-guided-simulation-transformation-matrix': { file: 'densityfittingoptions.cpp', kind: 'reals', def: '1 0 0 0 1 0 0 0 1', count: 9 },
  'qmmm-cp2k-active': { file: 'qmmmoptions.cpp', kind: 'boolean', def: 'false' },
  'qmmm-cp2k-qmgroup': { file: 'qmmmoptions.cpp', kind: 'group', def: 'System' },
  'qmmm-cp2k-qmmethod': { file: 'qmmmoptions.cpp', kind: 'enum', def: 'PBE', values: ['PBE', 'BLYP', 'INPUT'] },
  'qmmm-cp2k-qmcharge': { file: 'qmmmoptions.cpp', kind: 'integer', def: '0' },
  'qmmm-cp2k-qmmultiplicity': { file: 'qmmmoptions.cpp', kind: 'integer', def: '1' },
  'qmmm-cp2k-qmfilenames': { file: 'qmmmoptions.cpp', kind: 'text', def: '' },
  'colvars-active': { file: 'colvarsoptions.cpp', kind: 'boolean', def: 'false' },
  'colvars-configfile': { file: 'colvarsoptions.cpp', kind: 'text', def: '' },
  'colvars-seed': { file: 'colvarsoptions.cpp', kind: 'integer', def: '-1' },
  // Neural-network potentials: new in 2025, documented in the reference
  // manual (special/nnpot) rather than on the mdp page.
  'nnpot-active': { file: 'nnpotoptions.cpp', kind: 'boolean', def: 'false' },
  'nnpot-modelfile': { file: 'nnpotoptions.cpp', kind: 'text', def: 'model.pt' },
  'nnpot-input-group': { file: 'nnpotoptions.cpp', kind: 'group', def: 'System' },
  'nnpot-model-input1': { file: 'nnpotoptions.cpp', kind: 'text', def: '' },
  'nnpot-model-input2': { file: 'nnpotoptions.cpp', kind: 'text', def: '' },
  'nnpot-model-input3': { file: 'nnpotoptions.cpp', kind: 'text', def: '' },
  'nnpot-model-input4': { file: 'nnpotoptions.cpp', kind: 'text', def: '' }
};

/* Names grompp renames or ignores (replace_inp_entry), with why. */
function obsoleteNames() {
  const text = read('src/gromacs/gmxpreprocess/readir.cpp');
  const out = {};
  for (const m of text.matchAll(/replace_inp_entry\(inp,\s*"([^"]+)",\s*(nullptr|"([^"]+)")\)/g)) {
    const name = m[1].replace(/_/g, '-');
    out[name] = m[3] ? { replacement: m[3] } : { replacement: null, reason: OBSOLETE_REASONS[name] || OBSOLETE_REASONS[name.replace(/-.*$/, '-*')] || 'No longer used; grompp ignores it.' };
  }
  return out;
}

const OBSOLETE_REASONS = {
  title: 'No longer used; grompp ignores it. Put a comment (;) at the top of the file instead.',
  cpp: 'No longer used: grompp has its own preprocessor. grompp ignores it.',
  'domain-decomposition': 'No longer used; domain decomposition is set up by mdrun. grompp ignores it.',
  // The Andersen thermostats draw from ir->andersen_seed, which grompp never
  // sets and tpxio forces to 0: they take no user seed at all (not ld-seed).
  'andersen-seed': 'No longer used; grompp ignores it (the Andersen thermostats no longer take a seed from the .mdp file).',
  dihre: 'Dihedral restraints are now switched on by the [ dihedral_restraints ] section of the topology. grompp ignores it.',
  'dihre-fc': 'Dihedral-restraint force constants are now given in the topology. grompp ignores it.',
  'dihre-tau': 'Time-averaged dihedral restraints were removed. grompp ignores it.',
  nstdihreout: 'Dihedral-restraint output was removed. grompp ignores it.',
  nstcheckpoint: 'Checkpoints are set by mdrun -cpt (in minutes). grompp ignores it.',
  'optimize-fft': 'FFT planning is automatic. grompp ignores it.',
  'adress-*': 'AdResS (adaptive resolution) was removed from GROMACS. grompp ignores it.',
  rlistlong: 'Belonged to the removed group cut-off scheme; the Verlet scheme sets its own buffer. grompp ignores it.',
  nstcalclr: 'Belonged to the removed group cut-off scheme. grompp ignores it.',
  'pull-print-com2': 'Removed; use pull-print-com. grompp ignores it.',
  'gb-*': 'Implicit solvent (generalised Born) was removed from GROMACS. grompp ignores it.',
  nstgbradii: 'Implicit solvent was removed from GROMACS. grompp ignores it.',
  rgbradii: 'Implicit solvent was removed from GROMACS. grompp ignores it.',
  'sa-*': 'Implicit solvent (surface area term) was removed from GROMACS. grompp ignores it.',
  'ns-type': 'Neighbour searching is always grid based with the Verlet scheme. grompp ignores it.'
};

/* ================================================================== *
 * 3. Options that come in numbered families
 * ================================================================== */

/* The manual documents the first member; files may use any index. */
const FAMILIES = [
  { re: /^pull-group1-/, template: (n) => n.replace('pull-group1-', 'pull-group{N}-'), count: 'pull-ngroups', from: 1 },
  { re: /^pull-coord1-/, template: (n) => n.replace('pull-coord1-', 'pull-coord{N}-'), count: 'pull-ncoords', from: 1 },
  { re: /^awh1-dim1-/, template: (n) => n.replace('awh1-dim1-', 'awh{N}-dim{M}-'), count: 'awh-nbias', inner: 'awh{N}-ndim', from: 1 },
  { re: /^awh1-/, template: (n) => n.replace('awh1-', 'awh{N}-'), count: 'awh-nbias', from: 1 },
  { re: /^rot-(group|type|massw|vec|pivot|rate|k|slab-dist|min-gauss|eps|fit-method|potfit-nsteps|potfit-step)0$/, template: (n) => n.replace(/0$/, '{N}'), count: 'rot-ngroups', from: 0 },
  { re: /^iontype0-/, template: (n) => n.replace('iontype0-', 'iontype{N}-'), count: 'iontypes', from: 0 }
];

/* ================================================================== *
 * 4. Kinds, for the options read as free strings
 * ================================================================== */

/*
 * setStringEntry reads a string; what the string holds decides how a checker
 * reads it. per: the option whose entries a list pairs with; count: fixed
 * number of entries; times: entries per group.
 */
const STRING_KINDS = {
  include: { kind: 'text' },
  define: { kind: 'text' },
  'comm-grps': { kind: 'groups' },
  'compressed-x-grps': { kind: 'groups' },
  energygrps: { kind: 'groups' },
  'energygrp-table': { kind: 'group-pairs' },
  'energygrp-excl': { kind: 'group-pairs' },
  'tc-grps': { kind: 'groups' },
  'tau-t': { kind: 'reals', per: 'tc-grps' },
  'ref-t': { kind: 'reals', per: 'tc-grps' },
  compressibility: { kind: 'reals', per: 'pcoupltype' },
  'ref-p': { kind: 'reals', per: 'pcoupltype' },
  'QMMM-grps': { kind: 'groups' },
  annealing: { kind: 'words', per: 'tc-grps', words: ['no', 'single', 'periodic'] },
  'annealing-npoints': { kind: 'integers', per: 'tc-grps' },
  'annealing-time': { kind: 'reals', per: 'annealing-npoints' },
  'annealing-temp': { kind: 'reals', per: 'annealing-npoints' },
  'wall-atomtype': { kind: 'words', per: 'nwall' },
  'wall-density': { kind: 'reals', per: 'nwall' },
  'IMD-group': { kind: 'group' },
  'orire-fitgrp': { kind: 'group' },
  'couple-moltype': { kind: 'text' },
  'fep-lambdas': { kind: 'reals' },
  'mass-lambdas': { kind: 'reals' },
  'coul-lambdas': { kind: 'reals' },
  'vdw-lambdas': { kind: 'reals' },
  'bonded-lambdas': { kind: 'reals' },
  'restraint-lambdas': { kind: 'reals' },
  'temperature-lambdas': { kind: 'reals' },
  'init-lambda-weights': { kind: 'reals', per: 'fep-lambdas' },
  'init-lambda-counts': { kind: 'integers', per: 'fep-lambdas' },
  'init-wl-histogram-counts': { kind: 'reals', per: 'fep-lambdas' },
  'acc-grps': { kind: 'groups' },
  accelerate: { kind: 'reals', per: 'acc-grps', times: 3 },
  freezegrps: { kind: 'groups' },
  freezedim: { kind: 'words', per: 'freezegrps', times: 3, words: ['Y', 'N'] },
  deform: { kind: 'reals', count: 6 },
  'user1-grps': { kind: 'groups' },
  'user2-grps': { kind: 'groups' },
  'mts-level2-forces': { kind: 'words', words: ['longrange-nonbonded', 'nonbonded', 'pair', 'dihedral', 'angle', 'pull', 'awh'] },
  'pull-group1-name': { kind: 'group' },
  'pull-group1-weights': { kind: 'reals' },
  'pull-coord1-potential-provider': { kind: 'text' },
  'pull-coord1-expression': { kind: 'text' },
  'pull-coord1-groups': { kind: 'integers' },
  'pull-coord1-dim': { kind: 'words', count: 3, words: ['Y', 'N'] },
  'pull-coord1-origin': { kind: 'reals', count: 3 },
  'pull-coord1-vec': { kind: 'reals', count: 3 },
  'rot-group0': { kind: 'group' },
  'rot-vec0': { kind: 'reals', count: 3 },
  'rot-pivot0': { kind: 'reals', count: 3 },
  'split-group0': { kind: 'group' },
  'split-group1': { kind: 'group' },
  'solvent-group': { kind: 'group' },
  // make_swap_groups looks the ion type up as an index group, like the split
  // and solvent groups (readir.cpp; reference manual, comp-electrophys).
  'iontype0-name': { kind: 'group' }
};

/* Units the documentation leaves out but the option plainly has. */
const EXTRA_UNITS = {
  nstcalcenergy: 'steps', 'pull-nstxout': 'steps', 'pull-nstfout': 'steps', 'awh-nstout': 'steps',
  'awh-nstsample': 'steps', nstexpanded: 'steps', nstdhdl: 'steps', 'nst-transition-matrix': 'steps',
  'rot-nstrout': 'steps', 'rot-nstsout': 'steps', 'swap-frequency': 'steps', 'density-guided-simulation-nst': 'steps',
  'lmc-forced-nstart': 'steps', 'mc-temperature': 'K', 'init-wl-delta': 'kT', 'rot-potfit-step0': 'deg',
  'rot-min-gauss0': '', 'pull-constr-tol': '', 'dh-hist-spacing': 'kJ mol⁻¹'
};


/* ================================================================== *
 * 5. Parse both sources
 * ================================================================== */

function build() {
  const { sections, options: rstOptions, ids } = parseRst();
  const enums = enumTables();
  const reads = sourceReads(enums);
  const obsolete = obsoleteNames();

  const readByKey = new Map();
  for (const r of reads) if (!readByKey.has(key(r.name))) readByKey.set(key(r.name), r);

  /* Anchors, in page order, as Sphinx assigns them. */
  const serial = { 'mdp': 0, 'mdp-value': 0 };
  const makeAnchor = (prefix, term) => {
    let id = sphinxId(`${prefix}-${term}`);
    if (!id || id === prefix || ids.has(id)) {
      do { id = `${prefix}-${serial[prefix]++}`; } while (ids.has(id));
    }
    ids.add(id);
    return id;
  };

  /* Group consecutive directives that share one body (fourier-nx/ny/nz,
     electric-field-x/y/z, the user options). */
  const docs = {};
  const records = [];
  for (let k = 0; k < rstOptions.length; k++) {
    const o = rstOptions[k];
    let shared = o;
    const hasBody = (x) => x.lines.some(l => l.trim());
    if (!hasBody(o)) {
      let j = k + 1;
      while (j < rstOptions.length && !hasBody(rstOptions[j]) &&
        rstOptions[j].line === rstOptions[j - 1].line + 1) j += 1;
      if (j < rstOptions.length && rstOptions[j].line === rstOptions[j - 1].line + 1) shared = rstOptions[j];
    }
    const name = o.written.replace(/\s*\(.*\)\s*$/, '').trim(); // "userint1 (0)" -> userint1
    const anchor = makeAnchor('mdp', o.written);
    const { own, values } = splitValues(shared.lines);
    const pre = preamble(own);
    const inlineDefault = /\(([^)]*)\)\s*$/.exec(o.written);
    const valueRecords = values.map(v => {
      const vAnchor = makeAnchor('mdp-value', `${o.written}=${v.written}`);
      const r = renderBlocks(v.lines);
      return { written: v.written, anchor: vAnchor, html: r.html, text: r.text, refs: r.refs };
    });
    const body = renderBlocks(pre.rest);
    records.push({
      name, written: o.written, section: o.section, anchor, sharedWith: shared !== o ? shared.written : null,
      docDefault: pre.docDefault !== null ? pre.docDefault : (inlineDefault ? inlineDefault[1] : null),
      unit: pre.unit, html: body.html, text: body.text, refs: body.refs, values: valueRecords
    });
  }

  return { sections, records, reads, readByKey, enums, obsolete, ids };
}

/* ================================================================== *
 * 6. Assemble
 * ================================================================== */

/* Sections the manual page does not have, for options documented elsewhere. */
const EXTRA_SECTIONS = [
  {
    id: 'neural-network-potentials', title: 'Neural network potentials', after: 'collective-variables-colvars-module',
    url: `https://manual.gromacs.org/${RELEASE}/reference-manual/special/nnpot.html#usage`
  }
];
/* Where the options missing from mdp-options.rst belong. */
const UNDOCUMENTED_SECTION = {
  'Shake-SOR': 'bonds', 'IMD-group': 'output-control',
  'weight-equil-number-all-lambda': 'expanded-ensemble-calculations', 'weight-equil-number-samples': 'expanded-ensemble-calculations',
  'weight-equil-number-steps': 'expanded-ensemble-calculations', 'weight-equil-wl-delta': 'expanded-ensemble-calculations',
  'weight-equil-count-ratio': 'expanded-ensemble-calculations', 'weight-c-range': 'expanded-ensemble-calculations'
};
/* rst names grompp does not read, and the name it reads instead. */
const DOC_NAME_FOR = { 'lmc-move': 'lmc-mc-move' };

/* Gates: an option read only inside `if (...)` in grompp. Outside the gate
   grompp does not know the name and warns "Unknown left-hand". */
function gateCode(g) {
  if (!g) return undefined;
  if (g.expanded) return 'expanded';
  if (g.option === 'swapcoords') return 'swapcoords';
  return g.option; // mts, pull, awh, rotation
}

function firstSentence(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const m = /^(.{12,}?[.!?])(\s|$)(?=[A-Z(]|$)/.exec(s);
  let out = m ? m[1] : s;
  if (out.length > 180) out = `${out.slice(0, 177).replace(/\s+\S*$/, '')}...`;
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function assemble() {
  const { sections, records, reads, enums, obsolete } = build();
  const byDocKey = new Map(records.map(r => [key(r.name), r]));
  const usedDocs = new Set();

  const sectionList = sections.map(s => ({ id: s.id, title: s.title, url: `${MANUAL}#${s.id}` }));
  for (const extra of EXTRA_SECTIONS) {
    const at = sectionList.findIndex(s => s.id === extra.after);
    sectionList.splice(at + 1, 0, { id: extra.id, title: extra.title, url: extra.url });
  }
  const sectionIndex = new Map(sectionList.map((s, i) => [s.id, i]));

  const seen = new Set();
  const options = [];
  const problems = [];
  const differences = [];

  for (const r of reads) {
    const k = key(r.name);
    if (seen.has(k)) continue; // dh_hist_size and dh_hist_spacing are read twice
    seen.add(k);
    const docName = DOC_NAME_FOR[r.name];
    const doc = byDocKey.get(key(docName || r.name)) || null;
    if (doc) usedDocs.add(doc);
    const name = doc && !docName ? doc.name : r.name.replace(/_/g, '-');

    /* kind, and what a list pairs with */
    let kind;
    let accepted = null;
    let defIndex = 0;
    const shape = {};
    if (r.reader === 'module') {
      kind = r.moduleKind;
      if (r.enumValues) accepted = r.enumValues;
      const spec = MODULE_OPTIONS[r.name];
      if (spec.count) shape.count = spec.count;
    } else if (r.reader === 'get_eint' || r.reader === 'get_eint64') {
      kind = 'integer';
    } else if (r.reader === 'get_ereal') {
      kind = 'real';
    } else if (r.reader === 'getEnum' || r.reader === 'get_eeenum') {
      kind = 'enum';
      const type = r.enumType.replace(/\.data\(\)$/, '');
      accepted = enums.names[type];
      if (!accepted) problems.push(`${r.name}: no enum table for ${type}`);
      defIndex = r.reader === 'getEnum' ? (enums.defaults[type] ?? 0) : 0;
    } else {
      const sk = STRING_KINDS[r.name];
      kind = sk ? sk.kind : 'text';
      if (sk) for (const f of ['per', 'count', 'times', 'words']) if (sk[f] !== undefined) shape[f] = sk[f];
      if (!sk && !/^(include|define)$/.test(r.name)) problems.push(`${r.name}: string option without a kind`);
    }

    /* default, as grompp writes it into mdout.mdp */
    let def = '';
    let defaultFrom;
    let gromppDefault;
    if (kind === 'enum' && r.reader !== 'module') {
      def = accepted ? accepted[defIndex] : '';
    } else if (r.reader === 'module') {
      def = r.def;
    } else if (r.def && typeof r.def === 'object') {
      defaultFrom = 'pull-coord1-k';
      def = '';
    } else if (typeof r.def === 'number') {
      def = kind === 'integer' ? String(r.def) : formatG(r.def);
    } else {
      def = r.def === undefined ? '' : String(r.def);
    }
    if (DEFAULT_OVERRIDES[name]) {
      // What grompp runs with differs from what it reads and writes back.
      def = DEFAULT_OVERRIDES[name].d;
      gromppDefault = DEFAULT_OVERRIDES[name].gd;
    }

    /* documented choices, matched to the spellings grompp accepts */
    const values = [];
    const cases = [];
    if (doc) {
      for (const v of doc.values) {
        const parts = v.written === 'X ; Y ; Z' ? ['X', 'Y', 'Z'] : [v.written];
        for (const p of parts) {
          const entry = { value: p, anchor: v.anchor, text: v.text, html: v.html, refs: v.refs };
          if (kind === 'enum' || kind === 'boolean') values.push(entry);
          else cases.push(entry); // nstlist >0 / 0 / <0, awh1-share-group 0 / positive
        }
      }
    }
    if (kind === 'enum') {
      for (const v of values) {
        const hit = accepted.find(a => key(a) === key(v.value));
        if (!hit) v.rejected = true;
      }
      // Default in the documented spelling when there is one. grompp's
      // Potential-shift-Verlet is an internal alias it turns into
      // Potential-shift (process_interaction_modifier).
      const docSpelling = values.find(v => !v.rejected && key(v.value) === key(def));
      if (docSpelling) def = docSpelling.value;
      else if (key(def) === 'POTENTIALSHIFTVERLET') { gromppDefault = def; def = 'Potential-shift'; }
    }
    if (kind === 'boolean' && !values.length) {
      values.push({ value: 'true' }, { value: 'false' });
    } else if (kind === 'boolean') {
      if (!values.some(v => v.value === 'false')) values.push({ value: 'false' });
    }

    /* differences between the manual and grompp */
    let docDefault;
    if (doc && doc.docDefault !== null && doc.docDefault !== undefined) {
      const a = unsup(doc.docDefault).replace(/^10\^(-?\d+)$/, '1e$1');
      const truth = { yes: 'true', no: 'false' };
      const same = kind === 'real' || kind === 'integer'
        ? Number(a) === Number(def)
        : key(a) === key(def) || a.replace(/[, ]+/g, ' ').trim() === String(def).replace(/[, ]+/g, ' ').trim() ||
          (kind === 'boolean' && (truth[a] || a) === def);
      if (!same && !defaultFrom) {
        docDefault = doc.docDefault;
        differences.push(`${name}: the manual says (${doc.docDefault}), grompp uses ${def === '' ? 'an empty value' : def}`);
      }
    }
    if (docName) differences.push(`${name}: the manual documents it as ${docName}, which grompp does not read`);
    for (const v of values.filter(x => x.rejected)) {
      differences.push(`${name} = ${v.value}: documented, but grompp only accepts ${accepted.join(', ')}`);
    }

    const fam = FAMILIES.find(f => f.re.test(name));
    const summary = SUMMARIES[name];
    if (!summary) problems.push(`${name}: no summary`);

    const rec = {
      n: name,
      s: doc ? sectionIndex.get(doc.section.id) : sectionIndex.get(UNDOCUMENTED_SECTION[name] ||
        (/^nnpot-/.test(name) ? 'neural-network-potentials' : 'run-control')),
      k: kind,
      d: def,
      t: summary || ''
    };
    if (r.name !== name) rec.gn = r.name;
    if (docName) rec.dn = docName;
    if (!doc) rec.x = 1; // not on the mdp-options page
    if (doc && doc.anchor !== `mdp-${name}`) rec.a = doc.anchor;
    const unit = (doc && doc.unit) || EXTRA_UNITS[name] || '';
    if (unit) rec.u = unit;
    if (docDefault !== undefined) rec.dd = docDefault;
    if (defaultFrom) rec.df = defaultFrom;
    if (gromppDefault) rec.gd = gromppDefault;
    if (r.reader === 'get_eint64') rec.i64 = 1; // strtoll: no 32-bit wrap-around
    if (kind === 'enum') {
      const documented = new Set(values.filter(v => !v.rejected).map(v => key(v.value)));
      const extra = accepted.filter(a => !documented.has(key(a)));
      if (extra.length) rec.acc = extra; // accepted but not documented
      const notes = {};
      for (const a of extra) if (ACC_STATUS[`${name}=${a}`]) notes[a] = ACC_STATUS[`${name}=${a}`];
      if (Object.keys(notes).length) rec.as = notes;
      for (const k of Object.keys(ACC_STATUS).filter(x => x.startsWith(`${name}=`))) {
        if (!extra.includes(k.slice(name.length + 1))) problems.push(`${k}: status for a spelling grompp does not accept`);
      }
    }
    if (values.length) {
      rec.v = values.map(v => {
        const row = [v.value, VALUE_SUMMARIES[`${name}=${v.value}`] || firstSentence(v.text)];
        const status = VALUE_STATUS[`${name}=${v.value}`] || (v.rejected ? ['rejected', `grompp does not accept this spelling; use one of: ${accepted.join(', ')}.`] : null);
        // Values the manual has no entry for (true/false of a module switch)
        // have no anchor: 0.
        if (!v.anchor) row[2] = 0;
        else if (v.anchor !== sphinxId(`mdp-value-${doc.written}=${v.value}`)) row[2] = v.anchor;
        if (status) {
          if (row[2] === undefined) row[2] = '';
          row[3] = status;
        }
        return row;
      });
    }
    if (cases.length) rec.c = cases.map(v => [v.value, firstSentence(v.text), v.anchor]);
    const gate = gateCode(r.gate);
    if (gate) rec.g = gate;
    if (fam) rec.f = [fam.template(name), fam.count, fam.from, fam.inner || undefined].filter(x => x !== undefined);
    for (const [f, val] of Object.entries(shape)) rec[f] = val;
    const related = doc ? [...new Set([...doc.refs, ...doc.values.flatMap(v => v.refs)])]
      .map(x => x.trim()).filter(x => key(x) !== key(name)) : [];
    if (related.length) rec.r = related;
    if (OPTION_STATUS[name]) rec.st = OPTION_STATUS[name];
    options.push({ rec, doc, values });
  }

  for (const d of records) {
    if (!usedDocs.has(d)) problems.push(`${d.name}: documented, but grompp never reads it`);
  }
  for (const n of Object.keys(SUMMARIES)) {
    if (!options.some(o => o.rec.n === n)) problems.push(`summary for unknown option ${n}`);
  }

  // Manual order: the documented options in page order, the rest after the
  // last option of their section.
  const pageOrder = new Map(records.map((d, i) => [d, i]));
  options.forEach((o, i) => { o.order = o.doc ? pageOrder.get(o.doc) : null; o.i = i; });
  const ordered = [];
  const bySection = sectionList.map((_, si) => options.filter(o => o.rec.s === si));
  for (const list of bySection) {
    const documented = list.filter(o => o.order !== null).sort((a, b) => a.order - b.order);
    const extra = list.filter(o => o.order === null).sort((a, b) => a.i - b.i);
    ordered.push(...documented, ...extra);
  }

  const obs = {};
  for (const [n, o] of Object.entries(obsolete)) obs[n] = o.replacement ? [o.replacement] : [null, o.reason];

  const table = {
    release: RELEASE,
    manual: MANUAL,
    sections: sectionList.map(s => [s.id, s.title, s.url === `${MANUAL}#${s.id}` ? undefined : s.url].filter(x => x !== undefined)),
    options: ordered.map(o => o.rec),
    obsolete: obs
  };

  const docs = {};
  for (const o of ordered) {
    if (!o.doc) continue;
    const vals = {};
    for (const v of o.values) if (v.html) vals[v.value] = v.html;
    const entry = [o.doc.html];
    if (Object.keys(vals).length) entry.push(vals);
    const cases = o.doc.values.filter(v => !(o.rec.k === 'enum' || o.rec.k === 'boolean'));
    if (cases.length) entry.push(Object.fromEntries(cases.map(v => [v.written, v.html])));
    docs[o.rec.n] = entry;
  }
  // Section introductions (annealing's worked example, the pull and AWH notes).
  const intros = {};
  for (const s of sections) {
    const text = s.intro.join('\n').trim();
    if (text) intros[s.id] = renderBlocks(s.intro).html;
  }

  return { table, docs: { release: RELEASE, options: docs, sections: intros }, problems, differences };
}

/* ================================================================== *
 * 8. Written by hand
 * ================================================================== */

/* Status of a whole option: removed, deprecated or unsupported. */
const OPTION_STATUS = {
  adress: ['removed', 'AdResS was removed from GROMACS; grompp accepts only no.'],
  'implicit-solvent': ['removed', 'Implicit solvent was removed from GROMACS; grompp accepts only no.'],
  QMMM: ['removed', 'The old QM/MM interface was removed: yes is an error. Use integrator = mimic for MiMiC or qmmm-cp2k-active for CP2K.'],
  'energygrp-excl': ['unsupported', 'Energy group exclusions are not supported with the Verlet cut-off scheme, the only one left.'],
  'energygrp-table': ['unsupported', 'User tables are not supported with the Verlet cut-off scheme.'],
  'lmc-move': ['renamed', 'The manual calls this option lmc-mc-move, but grompp only reads lmc-move.']
};

/* Status of single values. deprecated: grompp warns or notes; unsupported:
   grompp stops with the Verlet scheme, or the manual calls the value
   unsupported (the note says which); removed: grompp stops; rejected: the
   manual's spelling that grompp does not accept. */
const VALUE_STATUS = {
  'cutoff-scheme=group': ['removed', 'The group scheme was removed in GROMACS 2020; grompp stops with an error.'],
  'coulombtype=User': ['unsupported', 'User tables are not supported with the Verlet scheme; grompp stops with an error.'],
  // check_ir only refuses the user-table types; usingPme() includes PME-Switch.
  'coulombtype=PME-Switch': ['unsupported', 'The manual lists it as unsupported, though grompp accepts it (and warns when the switching range is wider than 5% of rcoulomb). Use PME.'],
  'coulombtype=PME-User': ['unsupported', 'Not supported with the Verlet scheme; grompp stops with an error.'],
  'coulombtype=PME-User-Switch': ['unsupported', 'Not supported with the Verlet scheme; grompp stops with an error.'],
  'vdwtype=User': ['unsupported', 'User tables are not supported with the Verlet scheme; grompp stops with an error.'],
  'vdwtype=Shift': ['deprecated', 'grompp replaces it by vdwtype = Cut-off with vdw-modifier = Force-switch (a note).'],
  'vdwtype=Switch': ['deprecated', 'grompp replaces it by vdwtype = Cut-off with vdw-modifier = Potential-switch (a note).'],
  'tcoupl=berendsen': ['deprecated', 'Does not give the correct kinetic-energy distribution; grompp warns. Use v-rescale.'],
  'pcoupl=Berendsen': ['deprecated', 'Does not give a correct ensemble; grompp warns. Use C-rescale.'],
  'pcoupl=MTTK': ['deprecated', 'Deprecated in GROMACS; needs md-vv, Nose-Hoover and no constraints.'],
  'tcoupl=andersen': ['limited', 'Only with the velocity Verlet integrators (md-vv), and not with constraints.'],
  'tcoupl=andersen-massive': ['limited', 'Only with the velocity Verlet integrators (md-vv).'],
  'integrator=md-vv-avek': ['limited', 'Meant mainly for validation; grompp notes this and needs nsttcouple = nstpcouple = 1.'],
  'QMMM=no': null
};

/*
 * Spellings grompp's reader takes that the manual does not describe (the rest
 * of each enum's string table), with what then happens: [status, note], where
 * status is as for VALUE_STATUS or null for a plain alias. Checked against
 * grompp and mdrun 2025.0.
 */
const ACC_STATUS = {
  'integrator=sd2 - removed': ['removed', 'The sd2 integrator was removed: grompp accepts the name, but mdrun stops ("SD2 integrator has been removed"). Use sd.'],
  'pbc=unset': ['unsupported', 'An internal placeholder rather than a choice: grompp crashes on it (an assertion). Use xyz, xy or no.'],
  'pbc=screw': ['limited', 'Screw periodic boundaries along x, for a rectangular box; grompp refuses it with PME or Ewald.'],
  'coulombtype=Generalized-Reaction-Field (unused)': ['removed', 'Generalised reaction field was removed; grompp stops with an error. Use Reaction-Field.'],
  'coulombtype=Poisson': ['unsupported', 'Not supported with the Verlet scheme; grompp stops with an error.'],
  'coulombtype=Switch': ['unsupported', 'Not supported with the Verlet scheme; grompp stops with an error.'],
  'coulombtype=Shift': ['unsupported', 'Not supported with the Verlet scheme; grompp stops with an error.'],
  'coulombtype=Generalized-Born (unused)': ['removed', 'Implicit solvent was removed; grompp stops with an error.'],
  'coulombtype=Reaction-Field-nec (unsupported)': ['removed', 'No longer supported; grompp stops with an error. Use Reaction-Field.'],
  'coulombtype=Encad-shift (unused)': ['unsupported', 'Not supported with the Verlet scheme; grompp stops with an error.'],
  'coulombtype=Reaction-Field-zero': [null, 'Reaction field with epsilon-rf = 0 (infinity), so that potential and force go to zero at the cut-off.'],
  'coulomb-modifier=Potential-shift-Verlet': [null, 'Old name of Potential-shift; grompp reads it as that.'],
  'coulomb-modifier=Potential-switch': ['unsupported', 'Not supported for Coulomb with the Verlet scheme; grompp stops with an error.'],
  'coulomb-modifier=Exact-cutoff': ['unsupported', 'Not supported for Coulomb with the Verlet scheme; grompp stops with an error.'],
  'coulomb-modifier=Force-switch': ['unsupported', 'Not supported for Coulomb with the Verlet scheme; grompp stops with an error.'],
  'vdwtype=Encad-shift (unused)': ['unsupported', 'Not supported with the Verlet scheme; grompp stops with an error.'],
  'vdw-modifier=Potential-shift-Verlet': [null, 'Old name of Potential-shift; grompp reads it as that.'],
  'vdw-modifier=Exact-cutoff': ['unsupported', 'grompp stops ("Unimplemented VdW modifier") when it sizes the pair-list buffer for dynamics; only minimisation gets past it.'],
  'ensemble-temperature-setting=not available': [null, 'How grompp spells not-available (with a space).'],
  'tcoupl=yes': ['deprecated', 'Old spelling of berendsen: grompp reads it as Berendsen, with a note, and warns as for berendsen.'],
  'pcoupl=Isotropic': ['deprecated', 'Old spelling of Berendsen: grompp reads it as Berendsen, with a note.'],
  'lmc-stats=minvar': [null, 'How grompp spells min-variance.'],
  'lmc-move=metropolis': [null, 'How grompp spells metropolis-transition.'],
  'lmc-move=barker': [null, 'How grompp spells barker-transition.'],
  'dhdl-print-energy=yes': ['deprecated', 'Old spelling of total: grompp reads it as total, with a note.'],
  'QMMM=yes': ['removed', 'The old QM/MM interface was removed: grompp stops with an error.']
};

/*
 * Defaults grompp runs with that differ from what it reads and writes back to
 * mdout.mdp. d: what grompp uses; gd: what mdout.mdp shows.
 */
const DEFAULT_OVERRIDES = {
  // read_params.cpp: a diffusion constant <= 0 (the value read when unset) is
  // replaced by 1e-5, with a note, so 0 is never used.
  'awh1-dim1-diffusion': { d: '1e-05', gd: '0' }
};

/* Value summaries where the manual's first sentence does not stand alone. */
const VALUE_SUMMARIES = {
  'integrator=md': 'Leap-frog molecular dynamics: the usual choice.',
  'integrator=md-vv': 'Velocity Verlet dynamics: more accurate Nose-Hoover and Parrinello-Rahman coupling, at extra cost.',
  'integrator=md-vv-avek': 'Velocity Verlet with the kinetic energy averaged over half steps, as leap-frog does.',
  'integrator=sd': 'Stochastic (Langevin) dynamics: the integrator itself keeps the temperature, using tau-t as inverse friction.',
  'integrator=bd': 'Brownian (position Langevin) dynamics.',
  'integrator=steep': 'Steepest-descent energy minimisation: robust, the usual first step.',
  'integrator=cg': 'Conjugate-gradient energy minimisation: converges further after steepest descent.',
  'integrator=l-bfgs': 'Quasi-Newton (L-BFGS) energy minimisation; not parallelised.',
  'integrator=nm': 'Normal-mode analysis of the structure; needs GROMACS in double precision.',
  'integrator=tpi': 'Test-particle insertion of the last molecule into frames of a trajectory (mdrun -rerun).',
  'integrator=tpic': 'Test-particle insertion into a predefined cavity.',
  'integrator=mimic': 'MiMiC QM/MM coupling with CPMD, which does the integration.',
  'mts=no': 'Every force is computed every step.',
  'mts=yes': 'Some forces (mts-level2-forces) are computed only every mts-level2-factor steps.',
  'comm-mode=Linear': 'Removes the drift of the centre of mass.',
  'comm-mode=Angular': 'Removes centre-of-mass translation and rotation, for systems without periodic boundaries.',
  'comm-mode=Linear-acceleration-correction': 'Removes centre-of-mass translation, correcting for a steady acceleration.',
  'comm-mode=None': 'Leaves the centre of mass free.',
  'cutoff-scheme=Verlet': 'Buffered pair lists, sized automatically: the only supported scheme.',
  'cutoff-scheme=group': 'Pair lists by charge group: removed.',
  'pbc=xyz': 'Periodic in all three directions.',
  'pbc=no': 'No periodic boundaries: the box is ignored.',
  'pbc=xy': 'Periodic in x and y only, for use with walls.',
  'coulombtype=Cut-off': 'Plain cut-off: fast but can cause artefacts with charged systems.',
  'coulombtype=Ewald': 'Classical Ewald sum; slow, mainly for reference.',
  'coulombtype=PME': 'Particle-mesh Ewald: accurate long-range electrostatics, the usual choice.',
  'coulombtype=P3M-AD': 'Particle-particle particle-mesh; like PME with a grid-optimised influence function.',
  'coulombtype=Reaction-Field': 'Reaction field beyond the cut-off with dielectric constant epsilon-rf (as used by Martini and GROMOS).',
  'coulombtype=User': 'User-supplied tables: unsupported.',
  'coulombtype=PME-Switch': 'PME with a switched direct-space part: unsupported.',
  'coulombtype=PME-User': 'PME with user tables: unsupported.',
  'coulombtype=PME-User-Switch': 'PME with switched user tables: unsupported.',
  'coulomb-modifier=Potential-shift': 'Shifts the potential to zero at the cut-off; forces and sampling are unchanged.',
  'coulomb-modifier=None': 'Leaves the potential unmodified, for comparing energies with other programs.',
  'vdwtype=Cut-off': 'Lennard-Jones with a cut-off at rvdw: the usual choice.',
  'vdwtype=PME': 'Lennard-Jones PME: long-range dispersion on a grid.',
  'vdwtype=Shift': 'Deprecated: same as Cut-off with vdw-modifier = Force-switch.',
  'vdwtype=Switch': 'Deprecated: same as Cut-off with vdw-modifier = Potential-switch.',
  'vdwtype=User': 'User-supplied tables: unsupported.',
  'vdw-modifier=Potential-shift': 'Shifts the potential to zero at the cut-off; forces are unchanged.',
  'vdw-modifier=None': 'Leaves the potential unmodified.',
  'vdw-modifier=Force-switch': 'Switches the force smoothly to zero between rvdw-switch and rvdw, as CHARMM force fields require.',
  'vdw-modifier=Potential-switch': 'Switches the potential smoothly to zero between rvdw-switch and rvdw; only when a force field requires it.',
  'DispCorr=no': 'No long-range dispersion correction.',
  'DispCorr=EnerPres': 'Corrects energy and pressure for dispersion beyond the cut-off.',
  'DispCorr=Ener': 'Corrects the energy only.',
  'ensemble-temperature-setting=auto': 'grompp decides from the thermostat settings.',
  'ensemble-temperature-setting=constant': 'One constant ensemble temperature, set by ensemble-temperature.',
  'ensemble-temperature-setting=variable': 'The temperature changes during the run (annealing, simulated tempering).',
  'ensemble-temperature-setting=not-available': 'No ensemble temperature. Write it as not available (with a space): grompp rejects not-available.',
  'tcoupl=no': 'No thermostat (constant energy, or a stochastic integrator).',
  'tcoupl=berendsen': 'Berendsen weak coupling: kept only to reproduce old runs.',
  'tcoupl=nose-hoover': 'Nose-Hoover extended ensemble; tau-t is the period of the temperature oscillations.',
  'tcoupl=andersen': 'Randomises some velocities each step (md-vv only).',
  'tcoupl=andersen-massive': 'Randomises all velocities at intervals of tau-t (md-vv only).',
  'tcoupl=v-rescale': 'Stochastic velocity rescaling (Bussi et al. 2007): correct canonical ensemble, robust. Recommended.',
  'pcoupl=no': 'No barostat: the box stays fixed (NVT).',
  'pcoupl=Berendsen': 'Berendsen weak coupling: kept only to reproduce old runs.',
  'pcoupl=C-rescale': 'Stochastic cell rescaling (Bernetti and Bussi 2020): correct fluctuations, fine for equilibration and production. Recommended.',
  'pcoupl=Parrinello-Rahman': 'Extended-ensemble barostat; can oscillate strongly when started far from the target pressure.',
  'pcoupl=MTTK': 'Martyna-Tuckerman-Tobias-Klein barostat for md-vv; deprecated.',
  'pcoupltype=isotropic': 'The box is scaled equally in all directions: one compressibility and ref-p.',
  'pcoupltype=semiisotropic': 'x and y are scaled together, z separately, as for membranes: two values (xy, z).',
  'pcoupltype=anisotropic': 'Every box element separately: six values (xx yy zz xy xz yz).',
  'pcoupltype=surface-tension': 'Surface tension in x/y and pressure along z, for interfaces: two values.',
  'refcoord-scaling=no': 'Restraint reference positions are not scaled with the box.',
  'refcoord-scaling=all': 'Restraint reference positions are scaled with the box.',
  'refcoord-scaling=com': 'Only the centre of mass of the reference positions is scaled with the box.',
  'annealing=no': 'No annealing for this group.',
  'annealing=single': 'One pass through the control points, then the last temperature is kept.',
  'annealing=periodic': 'The schedule repeats from the first point after the last one.',
  'gen-vel=no': 'Keeps the velocities from the input structure (zero if it has none).',
  'gen-vel=yes': 'Draws new random velocities at gen-temp: for the first dynamics run after minimisation.',
  'constraints=none': 'No bonds are constrained (other than rigid water, which uses SETTLE).',
  'constraints=h-bonds': 'Bonds to hydrogen are constrained: the usual choice, allows a 2 fs time step.',
  'constraints=all-bonds': 'All bonds are constrained.',
  'constraints=h-angles': 'All bonds, and angles involving hydrogen, are constrained.',
  'constraints=all-angles': 'All bonds and all angles are constrained.',
  'constraint-algorithm=LINCS': 'LINCS: fast and parallel, the default.',
  'constraint-algorithm=SHAKE': 'SHAKE: slower, but works with angle constraints; not for energy minimisation.',
  'continuation=no': 'Constrains the starting structure: for a run that does not continue an earlier one.',
  'continuation=yes': 'Does not constrain the starting structure: for continuing an earlier run exactly.',
  'free-energy=no': 'Only topology state A is used.',
  'free-energy=yes': 'Interpolates between states A and B and writes dH/dlambda and energy differences.',
  'free-energy=expanded': 'Expanded ensemble: the lambda state changes during the run.',
  'couple-lambda0=vdw-q': 'All interactions on.',
  'couple-lambda0=vdw': 'Van der Waals on, charges off.',
  'couple-lambda0=q': 'Charges on, van der Waals off (needs soft-core).',
  'couple-lambda0=none': 'All non-bonded interactions off (needs soft-core).',
  'swapcoords=no': 'No ion/water swapping.',
  'swapcoords=X': 'Swaps ions and water along x.',
  'swapcoords=Y': 'Swaps ions and water along y.',
  'swapcoords=Z': 'Swaps ions and water along z (membranes in the x-y plane).',
  'pull-coord1-type=umbrella': 'A harmonic potential on the coordinate: umbrella sampling and steered MD.',
  'pull-coord1-type=constraint': 'A rigid constraint on the coordinate.',
  'pull-coord1-type=constant-force': 'A constant force (pull-coord1-k is minus the force).',
  'pull-coord1-type=flat-bottom': 'Harmonic above pull-coord1-init, no force below.',
  'pull-coord1-type=flat-bottom-high': 'Harmonic below pull-coord1-init, no force above.',
  'pull-coord1-type=external-potential': 'The potential comes from another module, such as AWH.',
  'pull-coord1-geometry=distance': 'The distance between the two groups.',
  'pull-coord1-geometry=direction': 'The distance along pull-coord1-vec.',
  'pull-coord1-geometry=direction-periodic': 'As direction, but may exceed half the box (no pressure coupling along it).',
  'pull-coord1-geometry=direction-relative': 'As direction, with the vector set by two further groups.',
  'pull-coord1-geometry=cylinder': 'Along pull-coord1-vec, relative to a local cylinder of the reference group (for layers).',
  'pull-coord1-geometry=angle': 'The angle between two vectors, each defined by two groups.',
  'pull-coord1-geometry=angle-axis': 'The angle between the vector of two groups and pull-coord1-vec.',
  'pull-coord1-geometry=dihedral': 'The dihedral angle defined by six groups.',
  'pull-coord1-geometry=transformation': 'A function (pull-coord1-expression) of other pull coordinates.',
  'lmc-move=metropolis-transition': 'Documented name; grompp accepts metropolis.',
  'lmc-move=barker-transition': 'Documented name; grompp accepts barker.',
  'lmc-stats=min-variance': 'Documented name; grompp accepts minvar.'
};

/*
 * One line per option, in plain English, written from the manual. Numbered
 * families are summarised on their first member (pull-coord1-k stands for
 * pull-coordN-k).
 */
const SUMMARIES = {
  // Preprocessing
  include: 'Extra directories the topology preprocessor searches for #include files, written as -I/path.',
  define: 'Preprocessor macros for the topology, such as -DPOSRES to switch on position restraints or -DFLEXIBLE for flexible water.',
  // Run control
  integrator: 'The algorithm that moves the system: molecular dynamics (md, sd, ...), energy minimisation (steep, cg, l-bfgs) or another method (nm, tpi).',
  tinit: 'Time of the first step in ps; output times and time-dependent settings (pull rates, annealing, electric-field pulses) count from it.',
  dt: 'Integration time step in ps: 0.002 (2 fs) is usual with h-bonds constraints, 0.004 with hydrogen mass repartitioning.',
  nsteps: 'Number of steps to integrate, or the most steps a minimisation may take; -1 runs without limit.',
  'init-step': 'Step number to start counting from, so that time, lambda and other schedules continue exactly after a restart.',
  'simulation-part': 'Part number of this run within a longer simulation, used to keep the output of each part apart.',
  mts: 'Switches on multiple time stepping, in which chosen slow forces are computed only every few steps.',
  'mts-levels': 'Number of multiple time-stepping levels; only 2 is supported.',
  'mts-level2-forces': 'The force groups computed only every mts-level2-factor steps (long-range non-bonded forces by default).',
  'mts-level2-factor': 'Number of steps between evaluations of the slow (level 2) forces.',
  'mass-repartition-factor': 'Multiplies the mass of the lightest atoms (hydrogens) by this factor, taking the mass from the atom they are bonded to; 3 with h-bonds constraints usually allows a 4 fs time step.',
  'comm-mode': 'How drift of the centre of mass is removed: its translation (Linear), also its rotation (Angular), or not at all (None).',
  nstcomm: 'Number of steps between removals of centre-of-mass motion.',
  'comm-grps': 'Index groups whose centre-of-mass motion is removed separately; the whole system by default.',
  'IMD-group': 'Index group sent to an interactive MD (IMD) client such as VMD; left empty, interactive MD is off. Not described on the mdp page.',
  // Langevin dynamics
  'bd-fric': 'Friction coefficient for Brownian dynamics; 0 takes each atom\'s friction as its mass divided by tau-t.',
  'ld-seed': 'Random seed for the noise of sd and bd dynamics and of the v-rescale thermostat and C-rescale barostat; -1 picks one at random.',
  // Energy minimisation
  emtol: 'Minimisation stops when the largest force on any atom is below this value.',
  emstep: 'Initial step size of steepest-descent minimisation.',
  nstcgsteep: 'How often conjugate-gradient minimisation takes a steepest-descent step instead.',
  nbfgscorr: 'Number of correction steps L-BFGS minimisation keeps; more is more accurate but slower.',
  // Shell molecular dynamics
  niter: 'Most iterations used each step to relax shell positions and flexible constraints.',
  fcstep: 'Step size for optimising flexible constraints.',
  // Test particle insertion
  rtpi: 'Radius of the sphere around a random point in which repeated test-particle insertions are made.',
  // Output control
  nstxout: 'Steps between writing full-precision coordinates to the .trr file; 0 writes none (the last frame is always saved in confout.gro).',
  nstvout: 'Steps between writing velocities to the .trr file; 0 writes none.',
  nstfout: 'Steps between writing forces to the .trr file; 0 writes none.',
  nstlog: 'Steps between writing energies to the log file.',
  nstcalcenergy: 'Steps between energy calculations; less often is faster in parallel. nstenergy should be a multiple of it.',
  nstenergy: 'Steps between writing energies to the .edr energy file; should be a multiple of nstcalcenergy.',
  'nstxout-compressed': 'Steps between writing compressed coordinates to the .xtc file, the usual trajectory for analysis; 0 writes none.',
  'compressed-x-precision': 'Precision of .xtc coordinates: 1000 keeps them to 0.001 nm.',
  'compressed-x-grps': 'Index groups written to the .xtc file (for example Protein, to leave out water); the whole system by default.',
  energygrps: 'Index groups whose short-range non-bonded energies are written out separately (not on GPUs).',
  // Neighbour searching
  'cutoff-scheme': 'How pair lists are built; only Verlet (buffered lists) is still supported.',
  nstlist: 'Steps between pair-list updates; with the Verlet scheme mdrun may raise it, and it does not affect accuracy.',
  pbc: 'Periodic boundary conditions: in all directions (xyz), none (no) or in x and y only (xy, with walls).',
  'periodic-molecules': 'Set to yes for molecules bonded to their own periodic images, such as an infinite crystal or sheet.',
  'verlet-buffer-tolerance': 'Largest energy drift per atom allowed from the pair-list buffer; grompp sets rlist from it. -1 uses rlist as given.',
  'verlet-buffer-pressure-tolerance': 'Largest error in the average pressure allowed from the pair-list buffer.',
  rlist: 'Pair-list cut-off; with dynamics it is set from verlet-buffer-tolerance and this value is ignored.',
  // Electrostatics
  coulombtype: 'How electrostatics are computed: PME (the usual choice with periodic boundaries), reaction field, plain cut-off or Ewald.',
  'coulomb-modifier': 'Shifts the Coulomb potential to zero at the cut-off (Potential-shift) or leaves it as it is (None); forces are the same.',
  'rcoulomb-switch': 'Where switching of the Coulomb potential starts, for switched methods only.',
  rcoulomb: 'Real-space Coulomb cut-off; with PME, mdrun may raise it while tuning performance.',
  'epsilon-r': 'Relative dielectric constant of the medium: 1 for all-atom force fields, 15 for Martini; 0 means infinity.',
  'epsilon-rf': 'Dielectric constant beyond the cut-off for reaction-field electrostatics; 0 means infinity.',
  // Van der Waals
  vdwtype: 'How Lennard-Jones interactions are treated: with a cut-off (usual) or with PME for long-range dispersion.',
  'vdw-modifier': 'How the Lennard-Jones interaction reaches zero at the cut-off: a shifted potential (default) or a force or potential switch where the force field requires one (CHARMM).',
  'rvdw-switch': 'Where force or potential switching of the Lennard-Jones interaction starts.',
  rvdw: 'Lennard-Jones cut-off distance.',
  DispCorr: 'Adds an analytical correction for the dispersion energy (and pressure) missing beyond the cut-off.',
  // Tables
  'table-extension': 'How far the lookup tables for 1-4 pair interactions extend beyond the cut-off.',
  'energygrp-table': 'Pairs of energy groups given their own user tables; unsupported with the Verlet scheme.',
  // Ewald
  fourierspacing: 'Largest spacing of the PME grid; the number of grid points along each box edge follows from it.',
  'fourier-nx': 'Number of PME grid points along x; 0 takes it from fourierspacing.',
  'fourier-ny': 'Number of PME grid points along y; 0 takes it from fourierspacing.',
  'fourier-nz': 'Number of PME grid points along z; 0 takes it from fourierspacing.',
  'pme-order': 'Interpolation order of PME (4 is cubic); GPUs support only 4.',
  'ewald-rtol': 'Relative strength of the direct-space Coulomb potential at the cut-off; smaller is more accurate but needs a finer grid.',
  'ewald-rtol-lj': 'As ewald-rtol, for Lennard-Jones PME.',
  'lj-pme-comb-rule': 'Combination rule for the grid part of Lennard-Jones PME; Geometric is faster and usually recommended.',
  'ewald-geometry': 'Ewald sum in three dimensions (3d), or with a correction for a slab in the x-y plane (3dc).',
  'epsilon-surface': 'Dielectric constant of the surroundings for the Ewald dipole correction; 0 turns it off, which is usual.',
  // Temperature coupling
  'ensemble-temperature-setting': 'Whether the system has one ensemble temperature, which AWH and the C-rescale barostat need; auto works it out from the thermostat.',
  'ensemble-temperature': 'The ensemble temperature, used only when ensemble-temperature-setting is constant.',
  tcoupl: 'The thermostat: v-rescale (recommended), nose-hoover, andersen or no; berendsen only reproduces old runs.',
  nsttcouple: 'Steps between thermostat updates; -1 lets grompp choose (100, or fewer if tau-t needs it).',
  'nh-chain-length': 'Length of the Nose-Hoover chain with velocity Verlet; leap-frog (md) supports only 1.',
  'print-nose-hoover-chain-variables': 'Writes the Nose-Hoover chain variables to the energy file.',
  'tc-grps': 'Index groups coupled to separate heat baths, such as Protein Non-Protein; one entry of tau-t and ref-t each.',
  'tau-t': 'Thermostat time constant for each group in tc-grps; -1 leaves a group uncoupled.',
  'ref-t': 'Target temperature for each group in tc-grps.',
  // Pressure coupling
  pcoupl: 'The barostat: C-rescale (recommended), Parrinello-Rahman, MTTK or no; Berendsen only reproduces old runs.',
  pcoupltype: 'Which box dimensions scale together: all (isotropic), x/y apart from z (semiisotropic, for membranes), each on its own (anisotropic) or surface-tension.',
  nstpcouple: 'Steps between barostat updates; -1 lets grompp choose.',
  'tau-p': 'Barostat time constant.',
  compressibility: 'Compressibility of the system (4.5e-5 bar⁻¹ for water); as many values as pcoupltype needs.',
  'ref-p': 'Target pressure; as many values as pcoupltype needs.',
  'refcoord-scaling': 'How reference positions of position restraints follow the box when it is scaled; use all or com with pressure coupling.',
  // Simulated annealing
  annealing: 'Simulated annealing for each temperature group: no, single (one pass) or periodic (repeating).',
  'annealing-npoints': 'Number of control points in the annealing schedule of each temperature group.',
  'annealing-time': 'Times of the annealing control points, for each group in turn.',
  'annealing-temp': 'Temperatures at the annealing control points, for each group in turn.',
  // Velocity generation
  'gen-vel': 'Draws random starting velocities from a Maxwell distribution at gen-temp; for the first dynamics run only.',
  'gen-temp': 'Temperature of the generated velocities.',
  'gen-seed': 'Random seed for generated velocities; -1 picks one at random.',
  // Bonds
  constraints: 'Which bonds (and angles) are made rigid; h-bonds allows a 2 fs time step with all-atom force fields.',
  'constraint-algorithm': 'The constraint solver: LINCS (default, parallel) or SHAKE.',
  continuation: 'Set to yes when continuing an earlier run, so the starting structure is not constrained again (formerly unconstrained-start).',
  'Shake-SOR': 'Uses successive over-relaxation to speed up SHAKE. Not described on the mdp page.',
  'shake-tol': 'Relative tolerance of SHAKE.',
  'lincs-order': 'Order of the LINCS matrix expansion; 4 is enough for normal MD.',
  'lincs-iter': 'Number of LINCS correction iterations; 1 for normal MD, 2 for accurate energy conservation.',
  'lincs-warnangle': 'LINCS warns when a bond rotates more than this in one step.',
  morse: 'Replaces harmonic bonds by Morse potentials.',
  // Energy group exclusions
  'energygrp-excl': 'Pairs of energy groups whose interactions are left out; not supported with the Verlet scheme.',
  // Walls
  nwall: 'Number of walls: 1 at z = 0, 2 also at the top of the box; needs pbc = xy.',
  'wall-atomtype': 'Force-field atom type of each wall.',
  'wall-type': 'The wall potential: 9-3, 10-4 or 12-6 Lennard-Jones forms, or a table.',
  'wall-r-linpot': 'Below this distance from a wall its force stays constant; a positive value helps when atoms start beyond a wall.',
  'wall-density': 'Number density of wall atoms, for each wall (9-3 and 10-4 walls).',
  'wall-ewald-zfac': 'Factor by which the box height is stretched for Ewald sums with two walls (at least 2).',
  // COM pulling
  pull: 'Switches on centre-of-mass pulling: umbrella sampling, steered MD or constraints between groups.',
  'pull-cylinder-r': 'Radius of the cylinder in the cylinder pull geometry.',
  'pull-constr-tol': 'Relative tolerance of constraint pulling.',
  'pull-print-com': 'Also writes the centre of mass of each pull group to pullx.xvg.',
  'pull-print-ref-value': 'Also writes the reference value of each pull coordinate to pullx.xvg.',
  'pull-print-components': 'Also writes the x, y and z components of each pull coordinate to pullx.xvg.',
  'pull-nstxout': 'Steps between writing pull coordinates to pullx.xvg; 0 never.',
  'pull-nstfout': 'Steps between writing pull forces to pullf.xvg; 0 never.',
  'pull-pbc-ref-prev-step-com': 'Uses the previous step\'s centre of mass as the periodic reference, for large or flexible pull groups.',
  'pull-xout-average': 'Writes pull coordinates averaged since the last output rather than instantaneous ones.',
  'pull-fout-average': 'Writes pull forces averaged since the last output rather than instantaneous ones.',
  'pull-ngroups': 'Number of pull groups, not counting the absolute reference (group 0).',
  'pull-ncoords': 'Number of pull coordinates.',
  'pull-group1-name': 'Index group whose centre of mass this pull group uses.',
  'pull-group1-weights': 'Optional weights, multiplied with the masses, for this pull group\'s centre of mass.',
  'pull-group1-pbcatom': 'Reference atom for making this pull group whole across periodic boundaries; 0 uses the middle atom.',
  'pull-coord1-type': 'What acts on this coordinate: a harmonic umbrella potential, a constraint, a constant force, a flat-bottomed potential or an external one.',
  'pull-coord1-potential-provider': 'Module (such as awh) that supplies the potential when the type is external-potential.',
  'pull-coord1-geometry': 'How the coordinate is measured from its groups: a distance, along a direction, in a cylinder, an angle, a dihedral or a transformation.',
  'pull-coord1-expression': 'Formula of lower-numbered pull coordinates (x1, x2, ... and time t) for the transformation geometry.',
  'pull-coord1-dx': 'Finite-difference step for the derivatives of a transformation coordinate.',
  'pull-coord1-groups': 'Numbers of the pull groups this coordinate uses (two for a distance, more for angles); 0 is an absolute reference.',
  'pull-coord1-dim': 'Which of x, y and z the coordinate uses, Y or N for each.',
  'pull-coord1-origin': 'Reference position used when group 0 (an absolute reference) is one of the groups.',
  'pull-coord1-vec': 'Pull direction for the direction, cylinder and angle-axis geometries; grompp normalises it.',
  'pull-coord1-start': 'Adds the starting value of the coordinate to pull-coord1-init, so the reference begins where the system is.',
  'pull-coord1-init': 'Reference value of the coordinate at time 0.',
  'pull-coord1-rate': 'Rate at which the reference value moves; 0 keeps it fixed, as in umbrella sampling.',
  'pull-coord1-k': 'Force constant of the pull potential (for a constant force, minus the force).',
  'pull-coord1-kB': 'Force constant in state B, for free-energy runs; pull-coord1-k by default.',
  // AWH
  awh: 'Switches on AWH (accelerated weight histogram), which adaptively biases pull coordinates or lambda and estimates the free-energy profile.',
  'awh-potential': 'How the bias acts: a smooth convolved potential (default) or an umbrella moved by Monte Carlo.',
  'awh-share-multisim': 'Shares biases between simulations started with mdrun -multidir.',
  'awh-seed': 'Random seed for the umbrella Monte Carlo moves; -1 picks one at random.',
  'awh-nstout': 'Steps between writing AWH data to the energy file; a multiple of nstenergy.',
  'awh-nstsample': 'Steps between samples of the reaction coordinate.',
  'awh-nsamples-update': 'Number of samples between updates of the bias.',
  'awh-nbias': 'Number of independent AWH biases.',
  'awh1-error-init': 'Estimated initial error of the free-energy profile, which sets the initial update rate; keep the default for a new run.',
  'awh1-growth': 'How the reference histogram grows: a near-exponential initial stage then linear (exp-linear), or linear from the start.',
  'awh1-growth-factor': 'Growth factor of the histogram during the exponential stage.',
  'awh1-equilibrate-histogram': 'Waits until the sampled histogram follows the target before the initial stage starts.',
  'awh1-target': 'The distribution the bias drives towards: flat (constant), flat up to a free-energy cut-off, or Boltzmann-like.',
  'awh1-target-beta-scaling': 'Factor between 0 and 1 scaling beta for the boltzmann and local-boltzmann targets.',
  'awh1-target-cutoff': 'Free-energy cut-off of the cutoff target.',
  'awh1-user-data': 'Starts from a free-energy profile and target read from awhinit.xvg.',
  'awh1-share-group': 'Group for sharing this bias between simulations; 0 does not share.',
  'awh1-target-metric-scaling': 'Scales the target by the friction metric, so slow regions are sampled more.',
  'awh1-target-metric-scaling-limit': 'Upper limit of the metric scaling, relative to the average.',
  'awh1-ndim': 'Number of dimensions of this bias\'s reaction coordinate.',
  'awh1-dim1-coord-provider': 'Where this dimension\'s coordinate comes from: a pull coordinate or the free-energy lambda state.',
  'awh1-dim1-coord-index': 'Index of the pull coordinate this dimension uses.',
  'awh1-dim1-force-constant': 'Force constant of the umbrella potentials along this dimension.',
  'awh1-dim1-start': 'Start of the sampling interval along this dimension.',
  'awh1-dim1-end': 'End of the sampling interval along this dimension.',
  'awh1-dim1-diffusion': 'Rough estimate of the diffusion constant along this dimension, which sets the initial update rate; left at 0, grompp uses 1e-5 and notes it.',
  'awh1-dim1-cover-diameter': 'Distance one simulation must sample around a point before that point counts as covered.',
  // Enforced rotation
  rotation: 'Switches on enforced rotation of groups of atoms.',
  'rot-ngroups': 'Number of rotation groups.',
  'rot-group0': 'Index group that this rotation group rotates.',
  'rot-type0': 'Rotation potential of this group: iso, pm, rm, rm2, flex, flex2, their -pf variants, flex-t or flex2-t.',
  'rot-massw0': 'Uses mass-weighted positions for this rotation group.',
  'rot-vec0': 'Rotation axis of this group; grompp normalises it.',
  'rot-pivot0': 'Pivot point for the iso, pm, rm and rm2 potentials.',
  'rot-rate0': 'Rotation rate of this group.',
  'rot-k0': 'Force constant of this rotation group.',
  'rot-slab-dist0': 'Slab distance for the flexible-axis potentials.',
  'rot-min-gauss0': 'Gaussian weight below which forces are not computed (flexible-axis potentials).',
  'rot-eps0': 'Additive constant epsilon for the rm2 and flex2 potentials.',
  'rot-fit-method0': 'How the actual angle of the group is found: rmsd, norm or potential.',
  'rot-potfit-nsteps0': 'Number of angles tried around the reference with the potential fit method.',
  'rot-potfit-step0': 'Spacing between those angles.',
  'rot-nstrout': 'Steps between writing the angle, torque and energy of the rotation groups.',
  'rot-nstsout': 'Steps between writing per-slab data of the flexible-axis potentials.',
  // NMR refinement
  disre: 'Whether the topology\'s distance restraints are used: no, simple (per molecule) or ensemble averaged.',
  'disre-weighting': 'How a restraint\'s force is divided over its atom pairs: equally or conservatively.',
  'disre-mixed': 'Bases the force on the square root of the time-averaged times the instantaneous violation.',
  'disre-fc': 'Force constant for distance restraints, scaled for each restraint by its fac column in the topology.',
  'disre-tau': 'Time constant for time-averaged distance restraints; 0 turns averaging off.',
  nstdisreout: 'Steps between writing restraint distances to the energy file (which can make it large).',
  orire: 'Whether the topology\'s orientation restraints are used.',
  'orire-fc': 'Force constant for orientation restraints; 0 only monitors the orientations.',
  'orire-tau': 'Time constant for time-averaged orientation restraints; 0 turns averaging off.',
  'orire-fitgrp': 'Index group fitted to find the rotation of the system for orientation restraints (backbone for a protein).',
  nstorireout: 'Steps between writing orientation-restraint data to the energy file.',
  // Free energy calculations
  'free-energy': 'Switches on free-energy perturbation between topology states A and B (yes), or expanded-ensemble sampling of lambda (expanded).',
  'init-lambda': 'Starting lambda for slow-growth runs; otherwise use init-lambda-state.',
  'delta-lambda': 'Change of lambda per step, for slow-growth runs.',
  'init-lambda-state': 'Which column of the lambda vectors this run samples, counting from 0.',
  'fep-lambdas': 'Lambda values for every component not given its own vector.',
  'coul-lambdas': 'Lambda values for electrostatic interactions.',
  'vdw-lambdas': 'Lambda values for van der Waals interactions.',
  'bonded-lambdas': 'Lambda values for bonded interactions.',
  'restraint-lambdas': 'Lambda values for restraints (dihedral restraints and pull restraints).',
  'mass-lambdas': 'Lambda values for the particle masses.',
  'temperature-lambdas': 'Lambda values for the temperatures, for simulated tempering.',
  'calc-lambda-neighbors': 'Number of neighbouring lambda states whose energy differences are written; -1 writes all, as MBAR needs.',
  'sc-function': 'The soft-core function: Beutler et al. or Gapsys et al.',
  'sc-alpha': 'Soft-core alpha of the Beutler function; 0 interpolates linearly, without soft-core.',
  'sc-r-power': 'Power of r in the soft-core function; only 6 is supported.',
  'sc-coul': 'Also applies soft-core to Coulomb interactions (Beutler, with several lambda components).',
  'sc-power': 'Power of lambda in the soft-core function: 1 or 2.',
  'sc-sigma': 'Soft-core sigma for atoms with zero C6 or C12, for the Beutler function.',
  'sc-gapsys-scale-linpoint-lj': 'Softness of Lennard-Jones interactions in the Gapsys function; 0 gives hard-core interactions.',
  'sc-gapsys-scale-linpoint-q': 'Softness of Coulomb interactions in the Gapsys function; 0 gives hard-core interactions.',
  'sc-gapsys-sigma-lj': 'Soft-core sigma for atoms with zero C6 or C12, for the Gapsys function.',
  'couple-moltype': 'Molecule type whose interactions are switched on or off between lambda 0 and 1, for solvation or binding free energies.',
  'couple-lambda0': 'Which interactions of couple-moltype are on at lambda = 0: vdw-q, vdw, q or none.',
  'couple-lambda1': 'Which interactions of couple-moltype are on at lambda = 1: vdw-q, vdw, q or none.',
  'couple-intramol': 'Whether interactions within the coupled molecule are switched too (yes), or kept whole (no, the usual choice).',
  nstdhdl: 'Steps between writing dH/dlambda and energy differences; a multiple of nstcalcenergy.',
  'dhdl-derivatives': 'Writes the derivative dH/dlambda every nstdhdl steps.',
  'dhdl-print-energy': 'Also writes the total or potential energy to the dhdl file, needed when states differ in temperature.',
  'separate-dhdl-file': 'Writes the free-energy data to dhdl.xvg (yes) or into the energy file (no).',
  'dh-hist-size': 'If not 0, bins energy differences into histograms of this many bins in the energy file, to save space.',
  'dh-hist-spacing': 'Bin width of those histograms.',
  // Expanded ensemble
  nstexpanded: 'Steps between attempts to change the lambda state in expanded-ensemble runs.',
  'lmc-stats': 'How the expanded-ensemble weights are updated: no, Metropolis, Barker, Wang-Landau or minimum variance.',
  'lmc-move': 'How the next lambda state is chosen: Metropolis, Barker, Gibbs or Metropolized Gibbs. The manual names it lmc-mc-move, but grompp reads lmc-move.',
  'lmc-seed': 'Random seed for Monte Carlo moves between lambda states; -1 picks one at random.',
  'mc-temperature': 'Temperature for accepting Monte Carlo moves; the first ref-t by default.',
  'wl-ratio': 'How flat the Wang-Landau histogram must be before the incrementor is scaled down.',
  'wl-scale': 'Factor applied to the Wang-Landau incrementor each time the histogram is flat.',
  'init-wl-delta': 'Initial Wang-Landau incrementor.',
  'wl-oneovert': 'Makes the Wang-Landau incrementor fall as 1/t at long times.',
  'lmc-repeats': 'Number of times each Monte Carlo move type is repeated per iteration.',
  'lmc-gibbsdelta': 'Limits Gibbs sampling to this many neighbouring states; -1 considers all.',
  'lmc-forced-nstart': 'Steps spent in each state during an initial forced walk through all lambda states, to get starting weights.',
  'nst-transition-matrix': 'Steps between writing the transition matrix; negative writes it only at the end.',
  'symmetrized-transition-matrix': 'Symmetrises the empirical transition matrix.',
  'mininum-var-min': 'Samples each state needs before the minimum-variance method starts (the name is spelled this way in GROMACS).',
  'init-lambda-weights': 'Initial weights (free energies) of the lambda states.',
  'init-wl-histogram-counts': 'Initial Wang-Landau histogram counts, to continue an earlier run.',
  'init-lambda-counts': 'Initial visit counts of the lambda states, to continue an earlier run.',
  'lmc-weights-equil': 'When the weights stop changing: never (no), from the start (yes), or once a criterion is met.',
  'weight-equil-number-all-lambda': 'Samples needed at every lambda state before the weights are frozen (lmc-weights-equil = number-all-lambda). Not described on the mdp page.',
  'weight-equil-number-samples': 'Total samples before the weights are frozen (lmc-weights-equil = number-samples). Not described on the mdp page.',
  'weight-equil-number-steps': 'Steps before the weights are frozen (lmc-weights-equil = number-steps). Not described on the mdp page.',
  'weight-equil-wl-delta': 'Wang-Landau incrementor below which the weights are frozen (lmc-weights-equil = wl-delta). Not described on the mdp page.',
  'weight-equil-count-ratio': 'Ratio of least- to most-visited state above which the weights are frozen (lmc-weights-equil = count-ratio). Not described on the mdp page.',
  'weight-c-range': 'Range of trial values of the constant C in the Barker, Metropolis and minimum-variance weight updates; 0 uses C = 0 only. Not described on the mdp page.',
  'simulated-tempering': 'Switches on simulated tempering: expanded-ensemble sampling over temperatures.',
  'sim-temp-low': 'Lowest temperature of simulated tempering.',
  'sim-temp-high': 'Highest temperature of simulated tempering.',
  'simulated-tempering-scaling': 'How the temperatures between sim-temp-low and sim-temp-high are spaced: linear, geometric or exponential.',
  // Non-equilibrium MD
  'acc-grps': 'Index groups given a constant acceleration.',
  accelerate: 'Acceleration (x, y, z) of each group in acc-grps.',
  freezegrps: 'Index groups whose atoms are held in place.',
  freezedim: 'For each frozen group, Y or N for x, y and z: the directions in which it is frozen.',
  'cos-acceleration': 'Amplitude of a cosine-shaped acceleration along x, for measuring viscosity.',
  deform: 'Speeds at which box elements change (a, b, c and the off-diagonal terms), to strain or shear the system.',
  'deform-init-flow': 'Adds the flow profile matching deform to the starting velocities.',
  // Electric fields
  'electric-field-x': 'Electric field along x as four numbers, E0 omega t0 sigma: strength, angular frequency, pulse centre and pulse width.',
  'electric-field-y': 'Electric field along y as four numbers, E0 omega t0 sigma.',
  'electric-field-z': 'Electric field along z as four numbers, E0 omega t0 sigma.',
  // Mixed quantum/classical
  'QMMM-grps': 'Index group treated quantum mechanically by MiMiC QM/MM.',
  QMMM: 'Switch of the old QM/MM interface, which was removed; only no is accepted.',
  // Computational electrophysiology
  swapcoords: 'Switches on ion/water position swapping (computational electrophysiology) along X, Y or Z.',
  'swap-frequency': 'Steps between checks of the ion counts in each compartment.',
  'split-group0': 'Index group of the membrane-embedded part of channel 0, whose centre marks a compartment boundary.',
  'split-group1': 'Index group of channel 1, marking the other compartment boundary.',
  'massw-split0': 'Uses the centre of mass (yes) rather than the geometric centre of split-group0.',
  'massw-split1': 'Uses the centre of mass (yes) rather than the geometric centre of split-group1.',
  'solvent-group': 'Index group of the solvent molecules that are swapped with ions.',
  'coupl-steps': 'Number of swap-attempt steps over which ion counts are averaged.',
  iontypes: 'Number of ion types whose counts are controlled.',
  'iontype0-name': 'Index group of the ions of this type (usually their molecule name).',
  'iontype0-in-A': 'Requested number of ions of this type in compartment A; -1 keeps the count at the start.',
  'iontype0-in-B': 'Requested number of ions of this type in compartment B; -1 keeps the count at the start.',
  'bulk-offsetA': 'Offset of the swap layer of compartment A from its midplane, between -1 and 1.',
  'bulk-offsetB': 'Offset of the swap layer of compartment B from its midplane, between -1 and 1.',
  threshold: 'Ions are swapped only when the count differs from the requested one by at least this much.',
  'cyl0-r': 'Radius of split cylinder 0, used to count which channel ions pass through.',
  'cyl0-up': 'Upper extension of split cylinder 0.',
  'cyl0-down': 'Lower extension of split cylinder 0.',
  'cyl1-r': 'Radius of split cylinder 1.',
  'cyl1-up': 'Upper extension of split cylinder 1.',
  'cyl1-down': 'Lower extension of split cylinder 1.',
  // Density-guided simulations
  'density-guided-simulation-active': 'Switches on forces that fit the structure into a density map, such as one from cryo-EM.',
  'density-guided-simulation-group': 'Atoms that feel the fitting force and make up the simulated density.',
  'density-guided-simulation-similarity-measure': 'How simulated and reference densities are compared: inner product, relative entropy or cross-correlation.',
  'density-guided-simulation-atom-spreading-weight': 'Weight of each atom spread on the grid: the same for all, its mass or its charge.',
  'density-guided-simulation-force-constant': 'Scaling factor of the fitting forces; may be negative.',
  'density-guided-simulation-gaussian-transform-spreading-width': 'RMS width of the Gaussian that spreads atoms on the grid.',
  'density-guided-simulation-gaussian-transform-spreading-range-in-multiples-of-width': 'Where that Gaussian is cut off, in multiples of its width.',
  'density-guided-simulation-reference-density-filename': 'File with the reference density map.',
  'density-guided-simulation-nst': 'Steps between evaluations of the fitting forces.',
  'density-guided-simulation-normalize-densities': 'Normalises both densities so their voxels sum to one.',
  'density-guided-simulation-adaptive-force-scaling': 'Adapts the force constant so that the similarity rises steadily.',
  'density-guided-simulation-adaptive-force-scaling-time-constant': 'Time constant of the adaptive force scaling.',
  'density-guided-simulation-shift-vector': 'Vector added to the fitted atoms before the fitting forces are computed.',
  'density-guided-simulation-transformation-matrix': 'Matrix (nine values, row by row) applied to the fitted atoms before the fitting forces are computed.',
  // QM/MM with CP2K
  'qmmm-cp2k-active': 'Switches on QM/MM with CP2K (GROMACS must be built with CP2K).',
  'qmmm-cp2k-qmgroup': 'Index group treated with quantum mechanics.',
  'qmmm-cp2k-qmmethod': 'QM method: PBE or BLYP density functional theory, or INPUT for your own CP2K input file.',
  'qmmm-cp2k-qmcharge': 'Total charge of the QM region.',
  'qmmm-cp2k-qmmultiplicity': 'Spin multiplicity of the QM region (1 is a singlet).',
  'qmmm-cp2k-qmfilenames': 'Base name of the CP2K files written during the run.',
  // Colvars
  'colvars-active': 'Switches on the Colvars collective-variables module.',
  'colvars-configfile': 'The Colvars configuration file.',
  'colvars-seed': 'Random seed for Colvars\' stochastic methods; -1 picks one at random.',
  // Neural network potentials
  'nnpot-active': 'Switches on a neural-network potential for part or all of the system (new in GROMACS 2025).',
  'nnpot-modelfile': 'TorchScript model file of the neural-network potential.',
  'nnpot-input-group': 'Index group handled by the neural-network potential; System gives a pure NNP simulation.',
  'nnpot-model-input1': 'First input passed to the model: atom-positions, atom-numbers, box or pbc.',
  'nnpot-model-input2': 'Second input passed to the model.',
  'nnpot-model-input3': 'Third input passed to the model.',
  'nnpot-model-input4': 'Fourth input passed to the model.',
  // User defined
  'user1-grps': 'Index groups passed to user code; for GROMACS developers.',
  'user2-grps': 'Index groups passed to user code; for GROMACS developers.',
  userint1: 'Integer passed to user code; for GROMACS developers.',
  userint2: 'Integer passed to user code; for GROMACS developers.',
  userint3: 'Integer passed to user code; for GROMACS developers.',
  userint4: 'Integer passed to user code; for GROMACS developers.',
  userreal1: 'Real number passed to user code; for GROMACS developers.',
  userreal2: 'Real number passed to user code; for GROMACS developers.',
  userreal3: 'Real number passed to user code; for GROMACS developers.',
  userreal4: 'Real number passed to user code; for GROMACS developers.',
  // Removed features
  adress: 'AdResS (adaptive resolution) was removed; only no is accepted.',
  'implicit-solvent': 'Implicit solvent was removed; only no is accepted.'
};

/* ================================================================== *
 * 7. Write
 * ================================================================== */

function main() {

  const out = assemble();

  if (REPORT || out.problems.length) {
    if (out.problems.length) {
      console.error(`${out.problems.length} problem(s):`);
      for (const p of out.problems) console.error(`  ${p}`);
    }
    if (REPORT) {
      console.log(`Where the manual (mdp-options.rst) and grompp (readir.cpp) disagree, ${out.differences.length}:`);
      for (const d of out.differences) console.log(`  ${d}`);
    }
  }

  /* Every anchor must be one the online manual has. */
  if (fs.existsSync(ANCHOR_FIXTURE)) {
    const real = new Set(fs.readFileSync(ANCHOR_FIXTURE, 'utf8').split('\n').filter(l => l && !l.startsWith('#')));
    const mine = [];
    for (const o of out.table.options) {
      if (o.x) continue;
      mine.push(o.a || `mdp-${o.n}`);
      for (const v of o.v || []) {
      if (v[2] === 0) continue;
      mine.push(v[2] || sphinxId(`mdp-value-${o.dn || o.n}=${v[0]}`));
    }
    }
    const missing = mine.filter(a => !real.has(a));
    if (missing.length) {
      console.error(`Anchors not on the manual page: ${missing.join(', ')}`);
      process.exitCode = 1;
    }
  }

  const HEADER = (what) => `/**
   * GROMACS ${RELEASE} .mdp options: ${what}
   *
   * Generated by tools/build-gromacs-mdp.mjs from docs/user-guide/mdp-options.rst
   * and src/gromacs/gmxpreprocess/readir.cpp (with readpull.cpp, readrot.cpp and
   * the AWH reader) of GROMACS ${RELEASE}. Do not edit by hand.
   *
   * GROMACS is free software distributed under the GNU LGPL v2.1 or later; the
   * documentation text here is taken from it. See THIRD_PARTY_LICENSES.md.
   *
   * Read it through ../gromacs-mdp.js rather than directly.
  `;

  const optionsBody = `${HEADER('names, kinds, defaults, choices, units and summaries.')} *
   * options: one row per option in manual order, with short keys:
   *   n name (the manual's spelling)   s section index     k kind
   *   d default (as grompp uses it)    t one-line summary  u unit
   *   a manual anchor, when not mdp-<n>        gn name as grompp writes it, when different
   *   dn name the manual documents, when grompp reads another
   *   dd default the manual prints, when grompp uses another
   *   df option the default is copied from     x 1 = not on the mdp-options page
 *   gd default as grompp writes it to mdout.mdp, when that differs from d
   *   v documented choices [value, summary, anchor?, [status, note]?]
   *   acc other spellings grompp accepts       c documented cases of a number
   *   as what grompp does with some acc spellings: {spelling: [status|null, note]}
   *   i64 1 = read as a 64-bit integer (no 32-bit wrap-around)
   *   g read only when switched on by: mts, pull, awh, rotation, swapcoords, expanded
   *   f numbered family [template, count option, first index, inner count?]
   *   per / count / times / words: what a list holds   r options the text refers to
   *   st [status, note] for the option as a whole
   * obsolete: name -> [replacement] or [null, reason]
   */
  export default ${JSON.stringify(out.table)};
  `;

  const docsBody = `${HEADER('the full documentation, as simple HTML.')} *
   * options: name -> [html, {value: html}?, {case: html}?]; sections: id -> html.
   * Links to other options are <a data-mdp="name"> and <a data-mdp="name"
   * data-value="v">; mdpDocs() in gromacs-mdp.js turns them into real links.
   */
  export default ${JSON.stringify(out.docs)};
  `;

  if (CHECK) {
    let stale = false;
    for (const [file, body] of [[OUT_OPTIONS, optionsBody], [OUT_DOCS, docsBody]]) {
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (current !== body) {
        console.error(`${path.relative(ROOT, file)} is out of date.`);
        stale = true;
      } else {
        console.log(`${path.relative(ROOT, file)} is up to date.`);
      }
    }
    if (stale) process.exit(1);
  } else if (!process.argv.includes('--dry-run')) {
    fs.writeFileSync(OUT_OPTIONS, optionsBody);
    fs.writeFileSync(OUT_DOCS, docsBody);
    const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(0);
    console.log(`${path.relative(ROOT, OUT_OPTIONS)}: ${out.table.options.length} options, ${kb(optionsBody)} kB`);
    console.log(`${path.relative(ROOT, OUT_DOCS)}: ${Object.keys(out.docs.options).length} documented, ${kb(docsBody)} kB`);
  }
  if (out.problems.length) process.exitCode = 1;
}

main();
