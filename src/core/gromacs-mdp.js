/**
 * @module core/gromacs-mdp
 *
 * GROMACS .mdp files: what every option means, reading a file the way grompp
 * reads it, saying what is wrong with it before grompp does, explaining it
 * line by line, and writing complete, commented files for the usual stages of
 * a simulation (minimisation, NVT and NPT equilibration, production,
 * simulated annealing and umbrella pulling).
 *
 * The option table (`gromacs-mdp-options.js`) is generated from the GROMACS
 * 2025.1 source by tools/build-gromacs-mdp.mjs: names, kinds and defaults come
 * from grompp's own reader (readir.cpp), the text and anchors from the manual
 * (mdp-options.rst). The full documentation of every option is a separate,
 * larger table loaded on request with {@link loadMdpDocs}.
 *
 * The reader follows grompp (src/gromacs/fileio/readinp.cpp):
 *
 *   - `;` starts a comment that runs to the end of the line;
 *   - every other line is `name = value`; a line without `=` is an error;
 *   - names are compared ignoring case, `-` and `_`, so `tau_t`, `tau-t` and
 *     `TAU-T` are one option, given twice is an error;
 *   - a line with nothing after `=` is ignored, and the default applies;
 *   - everything after the first `=` is the value, so `define = -DA -DB=2`
 *     works; the file is not preprocessed, so `#include` is not allowed.
 *
 * The checker then follows grompp's consistency checks (readir.cpp check_ir,
 * get_ir, do_index, triple_check, double_check and grompp.cpp) as far as they
 * can be decided from the .mdp file alone. Checks that need the topology
 * (position restraints present, rigid water, charges) take their answer from
 * `options.context` or a stated guess, and say so.
 *
 * ```js
 * const { issues, grompp } = checkMdp(text);
 * grompp.passes;               // false when grompp -maxwarn 0 would stop
 * explainMdp(text)[3].meaning; // 'Every 5000 steps = 10 ps.'
 * generateMdp({ stage: 'npt', forceField: 'charmm36' }).text;
 * ```
 */

import TABLE from './gromacs-mdp-options.js';

/** GROMACS release the option table describes. */
export const MDP_RELEASE = TABLE.release;

/** The manual page every option links into. */
export const MDP_MANUAL = TABLE.manual;

const MANUAL_ROOT = `https://manual.gromacs.org/${TABLE.release}`;

/* ------------------------------------------------------------------ *
 * The option table
 * ------------------------------------------------------------------ */

/**
 * GROMACS's comparison key for names and enum values (gmx_strcasecmp_min):
 * upper case, with every `-` and `_` removed.
 *
 * @param {string} name
 * @returns {string}
 */
export function normaliseName(name) {
  return String(name == null ? '' : name).toUpperCase().replace(/[-_]/g, '');
}
const key = normaliseName;

const SECTIONS = TABLE.sections.map(([id, title, url], index) => Object.freeze({
  id, title, index, url: url || `${TABLE.manual}#${id}`
}));

const ROWS = TABLE.options;
const ROW_BY_KEY = new Map();
const ROW_BY_NAME = new Map();
for (const row of ROWS) {
  ROW_BY_KEY.set(key(row.n), row);
  ROW_BY_NAME.set(row.n, row);
  if (row.gn) ROW_BY_KEY.set(key(row.gn), row);
}

/* Numbered families: pull-coord{N}-k, awh{N}-dim{M}-start, rot-type{N}, ... */
const FAMILIES = ROWS.filter(r => r.f).map(row => {
  const [template, count, first, inner] = row.f;
  const parts = template.split(/(\{[NM]\})/);
  const re = new RegExp(`^${parts.map(p => (p === '{N}' || p === '{M}' ? '(\\d+)' : key(p))).join('')}$`);
  return { row, template, count, first, inner, re, slots: parts.filter(p => p === '{N}' || p === '{M}') };
});

const OBSOLETE = new Map(Object.entries(TABLE.obsolete).map(([n, [replacement, reason]]) => [key(n), {
  name: n, replacement: replacement || null, reason: reason || null
}]));

/**
 * Find the option a name refers to, as grompp would. Numbered family members
 * (`pull-coord2-k`) resolve to their family with the index filled in.
 *
 * @param {string} name - As written in a file, in any case, with - or _.
 * @returns {{row:object, name:string, index:number[]}|null}
 */
function lookup(name) {
  const k = key(name);
  if (!k) return null;
  for (const fam of FAMILIES) {
    const m = fam.re.exec(k);
    if (!m) continue;
    const idx = m.slice(1);
    // grompp compares the whole name: pull-coord01-k is not pull-coord1-k.
    if (idx.some(d => String(Number(d)) !== d)) continue;
    let i = 0;
    const canonical = fam.template.replace(/\{[NM]\}/g, () => idx[i++]);
    return { row: fam.row, name: canonical, index: idx.map(Number) };
  }
  const row = ROW_BY_KEY.get(k);
  return row ? { row, name: row.n, index: [] } : null;
}

/**
 * The manual's spelling of an option, from any spelling grompp accepts.
 *
 * @param {string} name - e.g. `tau_t`, `Pull_Coord2_K`.
 * @returns {string|null} e.g. `tau-t`, `pull-coord2-k`; null when unknown.
 */
export function canonicalName(name) {
  const hit = lookup(name);
  return hit ? hit.name : null;
}

/**
 * Link into the online manual for an option, or for one of its values.
 *
 * Anchors are those Sphinx gives the page (checked against the live page):
 * `#mdp-tau-t`, `#mdp-value-tcoupl-v-rescale`. Numbered family members link
 * to the documented first member; options the page does not describe link to
 * their section.
 *
 * @param {string} name
 * @param {string} [value]
 * @returns {string} '' for an unknown name.
 */
export function mdpDocUrl(name, value) {
  const hit = lookup(name);
  if (!hit) {
    const obs = OBSOLETE.get(key(name));
    return obs && obs.replacement ? mdpDocUrl(obs.replacement) : '';
  }
  const row = hit.row;
  if (row.x) return SECTIONS[row.s].url;
  const optionAnchor = row.a || `mdp-${row.n}`;
  if (value !== undefined && value !== null && value !== '') {
    const v = findValue(row, value);
    if (v) {
      if (v[2] === 0) return `${TABLE.manual}#${optionAnchor}`;
      return `${TABLE.manual}#${v[2] || sphinxId(`mdp-value-${row.dn || row.n}=${v[0]}`)}`;
    }
    const c = (row.c || []).find(x => x[0] === String(value));
    if (c) return `${TABLE.manual}#${c[2]}`;
  }
  return `${TABLE.manual}#${optionAnchor}`;
}

/* Sphinx's make_id: runs of anything but [a-zA-Z0-9._] become '-'. */
function sphinxId(s) {
  return String(s).replace(/[^a-zA-Z0-9._]+/g, '-').replace(/^[-0-9._]+|[-_]+$/g, '');
}

function findValue(row, value) {
  const k = key(value);
  return (row.v || []).find(v => key(v[0]) === k) || null;
}

/**
 * Everything known about one option.
 *
 * @param {string} name - Any spelling grompp accepts, family members included.
 * @returns {OptionInfo|null} null for a name grompp does not know. An
 *   obsolete name returns `{name, obsolete: true, replacement, reason}`.
 *
 * @typedef {object} OptionInfo
 * @property {string} name - The manual's spelling, e.g. `tau-t`, `pull-coord2-k`.
 * @property {{id:string, title:string, url:string}} section
 * @property {'enum'|'boolean'|'integer'|'real'|'text'|'group'|'groups'|
 *   'group-pairs'|'reals'|'integers'|'words'} kind - How the value is read.
 *   `enum`: one of `values`; `boolean`: yes/no/true/false; `reals`, `integers`,
 *   `words`, `groups`: space-separated lists; `text`: free text.
 * @property {string} default - As grompp uses it ('' when empty).
 * @property {string|null} defaultFrom - Option whose value is the default (pull-coord1-kB).
 * @property {string} unit - e.g. `ps`, `kJ mol⁻¹ nm⁻²`; '' when unitless.
 * @property {string} summary - One plain-English line.
 * @property {string} url - The manual entry.
 * @property {Array<{value:string, summary:string, url:string, status:string|null, note:string}>} values
 *   Documented choices of an enum or boolean. status: deprecated, limited,
 *   unsupported, removed, or rejected (documented, but grompp refuses the spelling).
 * @property {string[]} accepted - Every spelling grompp accepts (enums).
 * @property {Array<{value:string, summary:string, url:string}>} cases - Documented
 *   special values of a number (nstlist 0, awh1-share-group positive).
 * @property {{option:string, when:string}|null} readWhen - grompp only reads
 *   the option when another switches it on; otherwise it warns "Unknown left-hand".
 * @property {{template:string, count:string, first:number, index:number[]}|null} family
 * @property {string|null} per - Option whose entries a list pairs with (tau-t: tc-grps).
 * @property {number|null} count - Fixed number of entries.
 * @property {number|null} times - Entries per group (accelerate: 3).
 * @property {string[]} related - Options the manual text refers to.
 * @property {{status:string, note:string}|null} status - removed, unsupported, renamed.
 * @property {boolean} documented - On the mdp-options page.
 * @property {string|null} gromppName - Spelling grompp writes to mdout.mdp, when different.
 * @property {string|null} docName - Name the manual uses when grompp reads another.
 * @property {string|null} docDefault - Default the manual prints when grompp uses another.
 * @property {string|null} gromppDefault - Default as grompp writes it to mdout.mdp,
 *   when that is an alias of `default` (Potential-shift-Verlet for Potential-shift).
 */
export function optionInfo(name) {
  const hit = lookup(name);
  if (!hit) {
    const obs = OBSOLETE.get(key(name));
    if (!obs) return null;
    return { name: obs.name, obsolete: true, replacement: obs.replacement, reason: obs.reason ||
      `Renamed: grompp reads it as ${obs.replacement}.` };
  }
  return expand(hit.row, hit);
}

const GATE_TEXT = {
  mts: { option: 'mts', when: 'mts = yes' },
  pull: { option: 'pull', when: 'pull = yes' },
  awh: { option: 'awh', when: 'awh = yes' },
  rotation: { option: 'rotation', when: 'rotation = yes' },
  swapcoords: { option: 'swapcoords', when: 'swapcoords is X, Y or Z' },
  expanded: { option: 'free-energy', when: 'free-energy = expanded or simulated-tempering = yes' }
};

function expand(row, hit = { name: row.n, index: [] }) {
  const section = SECTIONS[row.s];
  const values = (row.v || []).map(v => ({
    value: v[0],
    summary: v[1] || '',
    url: mdpDocUrl(row.n, v[0]),
    status: v[3] ? v[3][0] : null,
    note: v[3] ? v[3][1] : ''
  }));
  let accepted = [];
  if (row.k === 'enum') accepted = [...values.filter(v => v.status !== 'rejected').map(v => v.value), ...(row.acc || [])];
  if (row.k === 'boolean') accepted = ['yes', 'no', 'true', 'false', '1', '0'];
  const fam = row.f ? { template: row.f[0], count: row.f[1], first: row.f[2], inner: row.f[3] || null, index: hit.index } : null;
  return {
    name: hit.name,
    section: { id: section.id, title: section.title, url: section.url },
    kind: row.k,
    default: row.d,
    defaultFrom: row.df ? familyName(row.df, hit.index) : null,
    unit: row.u || '',
    summary: row.t,
    url: mdpDocUrl(hit.name),
    values,
    accepted,
    cases: (row.c || []).map(c => ({ value: c[0], summary: c[1], url: `${TABLE.manual}#${c[2]}` })),
    readWhen: row.g ? { ...GATE_TEXT[row.g] } : null,
    family: fam,
    per: row.per || null,
    count: row.count || null,
    times: row.times || null,
    words: row.words || null,
    related: row.r ? row.r.slice() : [],
    status: row.st ? { status: row.st[0], note: row.st[1] } : null,
    documented: !row.x,
    gromppName: row.gn || null,
    docName: row.dn || null,
    docDefault: row.dd === undefined ? null : row.dd,
    gromppDefault: row.gd || null
  };
}

/* pull-coord1-k with index [3] -> pull-coord3-k. */
function familyName(name, index) {
  if (!index || !index.length) return name;
  const hit = lookup(name);
  if (!hit || !hit.row.f) return name;
  let i = 0;
  return hit.row.f[0].replace(/\{[NM]\}/g, () => index[i++] ?? hit.row.f[2]);
}

/**
 * The sections of the manual page in order, each with its options.
 *
 * @param {{undocumented?:boolean}} [options] - Include options the mdp page
 *   does not describe (Shake-SOR, IMD-group, weight-equil-*, nnpot-*); true by default.
 * @returns {Array<{id:string, title:string, url:string, options:string[]}>}
 */
export function sectionsInOrder(options = {}) {
  const { undocumented = true } = options;
  return SECTIONS.map(s => ({
    id: s.id, title: s.title, url: s.url,
    options: ROWS.filter(r => r.s === s.index && (undocumented || !r.x)).map(r => r.n)
  })).filter(s => s.options.length);
}

/**
 * Every option, in the order of the manual.
 *
 * @param {{section?:string, undocumented?:boolean}} [options]
 * @returns {string[]}
 */
export function listOptions(options = {}) {
  const { section = null, undocumented = true } = options;
  return ROWS.filter(r => (!section || SECTIONS[r.s].id === section) && (undocumented || !r.x)).map(r => r.n);
}

/**
 * Names grompp still recognises but ignores or renames (replace_inp_entry).
 *
 * @returns {Array<{name:string, replacement:string|null, reason:string|null}>}
 */
export function obsoleteOptions() {
  return [...OBSOLETE.values()].map(o => ({ ...o }));
}

/**
 * Options whose name, summary or choices match every word of a query, best
 * first: exact name, name prefix, name substring, then summary.
 *
 * @param {string} query
 * @param {{limit?:number}} [options]
 * @returns {Array<{name:string, summary:string, section:string}>}
 */
export function searchOptions(query, options = {}) {
  const { limit = 30 } = options;
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored = [];
  for (const r of ROWS) {
    const name = r.n.toLowerCase();
    const text = `${r.t} ${(r.v || []).map(v => v[0]).join(' ')}`.toLowerCase();
    let score = 0;
    let ok = true;
    for (const w of words) {
      const wk = key(w);
      if (key(name) === wk) score += 100;
      else if (key(name).startsWith(wk)) score += 40;
      else if (key(name).includes(wk)) score += 20;
      else if (text.includes(w)) score += 5;
      else { ok = false; break; }
    }
    if (ok) scored.push({ name: r.n, summary: r.t, section: SECTIONS[r.s].title, score, x: r.x ? 1 : 0 });
  }
  scored.sort((a, b) => b.score - a.score || a.x - b.x);
  return scored.slice(0, limit).map(({ name, summary, section }) => ({ name, summary, section }));
}

/* ------------------------------------------------------------------ *
 * Full documentation, loaded on request
 * ------------------------------------------------------------------ */

let docsPromise = null;

/**
 * Load the full documentation (about 140 kB) and return readers for it.
 * Links between options come out as `<a href="…manual…" data-mdp="name">`,
 * so a page can intercept them and show its own panel instead.
 *
 * @returns {Promise<{option:(name:string)=>string, value:(name:string, value:string)=>string,
 *   section:(id:string)=>string}>} Each returns simple HTML, '' when there is none.
 */
export function loadMdpDocs() {
  if (!docsPromise) {
    docsPromise = import('./gromacs-mdp-docs.js').then(m => createDocs(m.default));
  }
  return docsPromise;
}

function linkify(html) {
  return String(html || '').replace(/<a data-mdp="([^"]*)"( data-value="([^"]*)")?>/g, (all, name, _v, value) => {
    const url = value !== undefined ? mdpDocUrl(unescapeHtml(name), unescapeHtml(value)) : mdpDocUrl(unescapeHtml(name));
    return url ? `<a href="${url}" data-mdp="${name}"${value !== undefined ? ` data-value="${value}"` : ''}>` : '<a>';
  });
}

function unescapeHtml(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function createDocs(docs) {
  const entry = (name) => {
    const hit = lookup(name);
    return hit ? docs.options[hit.row.n] || null : null;
  };
  return Object.freeze({
    option(name) {
      const e = entry(name);
      return e ? linkify(e[0]) : '';
    },
    value(name, value) {
      const e = entry(name);
      if (!e) return '';
      const k = key(value);
      for (const table of e.slice(1)) {
        const hit = Object.keys(table).find(v => key(v) === k || v === String(value));
        if (hit) return linkify(table[hit]);
      }
      // swapcoords documents X, Y and Z together.
      const row = lookup(name).row;
      if (row.n === 'swapcoords' && /^[XYZ]$/i.test(String(value))) return linkify((e[1] || {})['X ; Y ; Z'] || '');
      return '';
    },
    section(id) {
      return linkify(docs.sections[id] || '');
    }
  });
}

/* ------------------------------------------------------------------ *
 * Numbers, as C reads them
 * ------------------------------------------------------------------ */

/* strtol(s, &end, 10): leading blanks, a sign, digits; the rest must be empty. */
function cInteger(s) {
  const m = /^\s*([+-]?\d+)/.exec(s);
  if (!m) return { value: 0, ok: false };
  return { value: Number(m[1]), ok: m[0].length === s.length };
}

/* strtod: decimal or hexadecimal, inf, nan. */
function cReal(s) {
  const m = /^\s*([+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|0[xX](?:[0-9a-fA-F]+\.?[0-9a-fA-F]*|\.[0-9a-fA-F]+)(?:[pP][+-]?\d+)?|inf(?:inity)?|nan(?:\([^)]*\))?))/i.exec(s);
  if (!m) return { value: 0, ok: false };
  const t = m[1];
  let value;
  if (/^[+-]?0x/i.test(t)) {
    const neg = t.startsWith('-');
    const [, mant, exp] = /0x([0-9a-f.]+)(?:p([+-]?\d+))?/i.exec(t);
    const [ip, fp = ''] = mant.split('.');
    value = (parseInt(ip || '0', 16) + (fp ? parseInt(fp, 16) / 16 ** fp.length : 0)) * 2 ** Number(exp || 0);
    if (neg) value = -value;
  } else if (/inf/i.test(t)) {
    value = t.startsWith('-') ? -Infinity : Infinity;
  } else if (/nan/i.test(t)) {
    value = NaN;
  } else {
    value = Number(t);
  }
  return { value, ok: m[0].length === s.length };
}

/* gmx::fromString<real>: the whole word must be a number. */
function strictReal(s) {
  const r = cReal(s);
  return r.ok && s !== '' ? r.value : null;
}

const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean);

/* ------------------------------------------------------------------ *
 * Reading a file
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} MdpEntry
 * @property {number} line - Counted from 1.
 * @property {string} key - The name as written.
 * @property {string} value - Everything after the first `=`, trimmed.
 * @property {string} comment - Text after `;`, trimmed ('' when none).
 * @property {string|null} name - The manual's spelling, or null when grompp
 *   does not know the name.
 * @property {boolean} empty - Nothing after `=`: grompp ignores the line.
 */

/**
 * Read an .mdp file as grompp does.
 *
 * @param {string} text
 * @returns {{entries:MdpEntry[], lines:Array<{line:number, raw:string, kind:'entry'|'empty'|'comment'|'blank'|'invalid',
 *   entry?:MdpEntry, comment:string}>, errors:Array<{line:number, id:string, message:string}>,
 *   values:Object<string,string>}} `values` maps each canonical name set in the
 *   file to its value (the first occurrence of a duplicate).
 */
export function parseMdp(text) {
  const raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  if (raw.length && raw[raw.length - 1] === '') raw.pop();
  const entries = [];
  const lines = [];
  const errors = [];
  const seen = new Map();
  const values = {};

  raw.forEach((rawLine, i) => {
    const line = i + 1;
    const semi = rawLine.indexOf(';');
    const code = (semi < 0 ? rawLine : rawLine.slice(0, semi)).replace(/\s+$/, '');
    const comment = semi < 0 ? '' : rawLine.slice(semi + 1).trim();
    if (!code.trim()) {
      lines.push({ line, raw: rawLine, kind: comment || semi >= 0 ? 'comment' : 'blank', comment });
      return;
    }
    const eq = code.indexOf('=');
    if (eq < 0) {
      errors.push({
        line, id: 'no-equals',
        message: `No "=" on this line, so grompp cannot tell the option from its value: "${code.trim()}". ` +
          (/^\s*#/.test(code) ? 'An .mdp file is not preprocessed: #include and #define do not work here; ' +
            'use the include and define options instead.' : 'Write it as "name = value".')
      });
      lines.push({ line, raw: rawLine, kind: 'invalid', comment });
      return;
    }
    const k = code.slice(0, eq).trim();
    const value = code.slice(eq + 1).trim();
    if (!k) {
      errors.push({
        line, id: 'no-name',
        message: value ? `There is no option name before "=" (the value is "${value}").` : 'This line holds only "=".'
      });
      lines.push({ line, raw: rawLine, kind: 'invalid', comment });
      return;
    }
    const hit = lookup(k);
    const entry = { line, key: k, value, comment, name: hit ? hit.name : null, empty: !value };
    if (!value) {
      // grompp: "Users are probably using this for lines like tcoupl = ;v-rescale".
      lines.push({ line, raw: rawLine, kind: 'empty', entry, comment });
      entries.push(entry);
      return;
    }
    const nk = key(k);
    if (seen.has(nk)) {
      errors.push({
        line, id: 'duplicate',
        message: `"${k}" is given twice (also on line ${seen.get(nk).line}). grompp stops: ` +
          'dashes, underscores and case do not make a different option.'
      });
      entry.duplicate = true;
    } else {
      seen.set(nk, entry);
      values[hit ? hit.name : k] = value;
    }
    entries.push(entry);
    lines.push({ line, raw: rawLine, kind: 'entry', entry, comment });
  });
  return { entries, lines, errors, values };
}

/**
 * The value of an option in a parsed file, by any spelling.
 *
 * @param {ReturnType<typeof parseMdp>} parsed
 * @param {string} name
 * @returns {string|null} null when the file does not set it.
 */
export function mdpValue(parsed, name) {
  const k = key(name);
  const e = parsed.entries.find(x => !x.empty && !x.duplicate && key(x.key) === k);
  return e ? e.value : null;
}

/* ------------------------------------------------------------------ *
 * Checking
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} MdpIssue
 * @property {'error'|'warning'|'note'} severity - As grompp would give it:
 *   an error stops grompp; so does a warning, unless -maxwarn allows it;
 *   a note is information.
 * @property {string} id - Stable code for the check, e.g. `tc-count`.
 * @property {string|null} option - The option it concerns.
 * @property {number|null} line - Where that option is set; null when it is not.
 * @property {string} message - Plain English: what is wrong and what to do.
 * @property {string} url - The manual entry for the option.
 * @property {'grompp'|'mdrun'|'advice'} source - grompp: grompp reports it;
 *   mdrun: grompp accepts it but mdrun will stop; advice: a recommendation.
 * @property {string} [assumes] - For checks that need the topology: what was assumed.
 */

/**
 * Check an .mdp file.
 *
 * @param {string|ReturnType<typeof parseMdp>} input - Text or a parsed file.
 * @param {object} [options]
 * @param {object} [options.context] - What the topology holds, for the checks
 *   that need it. `posres` (default: true when define has -DPOSRES), `rigidWater`
 *   (SETTLE water; default true), `charged` (default true), `system`
 *   ('all-atom' default, 'coarse-grained', or 'unknown' to skip time-step
 *   estimates), `usedMacros` (names the topology tests with #ifdef; grompp
 *   warns about any other -D in define), `forceField` (a key of {@link FORCE_FIELDS}: GROMOS topologies
 *   always draw a grompp warning, and AMBER, CHARMM and OPLS a note with
 *   constraints = all-bonds), `indexGroups` (names; when given, group names
 *   are checked).
 * @param {number} [options.maxwarn=0] - grompp -maxwarn.
 * @returns {{issues:MdpIssue[], parsed:ReturnType<typeof parseMdp>,
 *   grompp:{passes:boolean, errors:number, warnings:number, notes:number},
 *   settings:Object<string,*>}} `settings` holds every option as grompp
 *   resolved it (after its own adjustments, e.g. nstcalcenergy).
 */
export function checkMdp(input, options = {}) {
  const parsed = typeof input === 'string' || input == null ? parseMdp(input) : input;
  const ctx = options.context || {};
  const issues = [];
  const run = new Checker(parsed, ctx, issues);
  run.all();
  const counted = issues.filter(i => i.source === 'grompp');
  const errors = counted.filter(i => i.severity === 'error').length;
  const warnings = counted.filter(i => i.severity === 'warning').length;
  const notes = counted.filter(i => i.severity === 'note').length;
  const maxwarn = Number(options.maxwarn) || 0;
  return {
    issues,
    parsed,
    grompp: { passes: errors === 0 && warnings <= maxwarn, errors, warnings, notes },
    settings: run.settings()
  };
}

/* Integrator classes, as md_enums.h defines them. */
const EI = {
  VV: (i) => i === 'MDVV' || i === 'MDVVAVEK',
  MD: (i) => i === 'MD' || i === 'MDVV' || i === 'MDVVAVEK' || i === 'MIMIC',
  SD: (i) => i === 'SD',
  RANDOM: (i) => i === 'SD' || i === 'BD',
  DYNAMICS: (i) => EI.MD(i) || EI.RANDOM(i),
  EM: (i) => i === 'STEEP' || i === 'CG' || i === 'LBFGS',
  TPI: (i) => i === 'TPI' || i === 'TPIC',
  STATE_VELOCITY: (i) => EI.MD(i) || EI.SD(i)
};
const COULOMB = {
  RF: (c) => ['REACTIONFIELD', 'GENERALIZEDREACTIONFIELD(UNUSED)', 'REACTIONFIELDNEC(UNSUPPORTED)', 'REACTIONFIELDZERO'].includes(c),
  PME: (c) => ['PME', 'PMESWITCH', 'PMEUSER', 'PMEUSERSWITCH', 'P3MAD'].includes(c),
  PME_OR_EWALD: (c) => COULOMB.PME(c) || c === 'EWALD',
  FULL: (c) => COULOMB.PME_OR_EWALD(c) || c === 'POISSON',
  USER_TABLE: (c) => ['USER', 'PMEUSER', 'PMEUSERSWITCH'].includes(c)
};
const MIN_STEPS_PER_TAU = 5;
const MIN_STEPS_PER_PERIOD = 20;
const GMX_REAL_EPS = 1.19209290e-07; // GMX_FLOAT_EPS: mixed precision, the usual build
const BOLTZ = 0.0083144626181532; // kJ mol^-1 K^-1

function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

class Checker {
  constructor(parsed, ctx, issues) {
    this.parsed = parsed;
    this.ctx = ctx;
    this.issues = issues;
    this.byKey = new Map();
    for (const e of parsed.entries) {
      if (e.empty || e.duplicate) continue;
      this.byKey.set(key(e.key), e);
    }
    this.used = new Set(); // keys grompp consumed
    this.v = {};           // canonical name -> resolved value
    this.set = {};         // canonical name -> entry, when set in the file
  }

  add(severity, id, option, message, extra = {}) {
    const name = option ? (canonicalName(option) || option) : null;
    const e = name ? this.set[name] : null;
    const line = extra.line !== undefined ? extra.line : (e ? e.line : null);
    const issue = { severity, id, option: name, line, message, url: name ? mdpDocUrl(name) : '', source: extra.source || 'grompp' };
    if (extra.assumes) issue.assumes = extra.assumes;
    if (extra.fatal) Object.defineProperty(issue, 'fatal', { value: true, enumerable: false });
    this.issues.push(issue);
    return issue;
  }

  settings() {
    return { ...this.v };
  }

  /* ---- reading, in grompp's order ---- */

  /* Take an entry for a name (any spelling), as get_einp does. */
  take(name) {
    const k = key(name);
    const e = this.byKey.get(k);
    if (e) this.used.add(k);
    return e || null;
  }

  read(name, row = lookup(name).row) {
    const e = this.take(name);
    if (e) this.set[name] = e;
    const raw = e ? e.value : null;
    let value;
    switch (row.k) {
      case 'integer': {
        if (raw === null) { value = row.df ? null : Number(row.d); break; }
        const r = cInteger(raw);
        if (!r.ok) {
          this.add('error', 'not-integer', name, `${name} needs a whole number, but "${raw}" is not one` +
            (/^[+-]?\d*\.\d*([eE][+-]?\d+)?$|^[+-]?\d+[eE]/.test(raw) ? ' (no decimal point or exponent)' : '') +
            '. grompp stops here.');
        }
        value = r.value;
        break;
      }
      case 'real': {
        if (raw === null) { value = row.df ? null : Number(row.d); break; }
        const r = cReal(raw);
        if (!r.ok) {
          this.add('error', 'not-real', name, `${name} needs a number, but "${raw}" is not one` +
            (/,/.test(raw) ? ' (use a point, not a comma, for decimals)' : '') + '. grompp stops here.');
        }
        value = r.value;
        break;
      }
      case 'enum': {
        if (raw === null) { value = row.d; break; }
        value = this.matchEnum(name, row, raw);
        break;
      }
      case 'boolean': {
        if (raw === null) { value = row.d === 'true'; break; }
        const low = raw.toLowerCase();
        if (['1', 'yes', 'true'].includes(low)) value = true;
        else if (['0', 'no', 'false'].includes(low)) value = false;
        else {
          this.add('error', 'bad-value', name, `${name} is a switch: write yes or no (true or false), not "${raw}".`);
          value = row.d === 'true';
        }
        break;
      }
      default:
        value = raw === null ? row.d : raw;
    }
    this.v[name] = value;
    return value;
  }

  isModule(row) {
    return /^(electric-field|density-guided|qmmm-cp2k|colvars|nnpot)/.test(row.n);
  }

  matchEnum(name, row, raw) {
    const k = key(raw);
    const docs = (row.v || []).filter(v => !(v[3] && v[3][0] === 'rejected'));
    const all = [...docs.map(v => v[0]), ...(row.acc || [])];
    if (this.isModule(row)) {
      // Options framework: case-sensitive prefix match, shortest wins.
      const hits = all.filter(a => a.startsWith(raw));
      if (hits.length) return hits.sort((a, b) => a.length - b.length)[0];
    } else {
      const hit = all.find(a => key(a) === k);
      if (hit) return hit;
    }
    const rejected = (row.v || []).find(v => v[3] && v[3][0] === 'rejected' && key(v[0]) === k);
    const shown = docs.map(v => v[0]);
    let message = `"${raw}" is not a value of ${name}. ` +
      `grompp stops; use one of: ${shown.join(', ')}.`;
    if (rejected) {
      message = `"${raw}" is how the GROMACS manual spells it, but grompp ${MDP_RELEASE} does not accept it: ${rejected[3][1]}`;
    } else if (/^(adress|implicit-solvent)$/.test(name)) {
      message = `${name === 'adress' ? 'AdResS' : 'Implicit solvent'} was removed from GROMACS; grompp accepts only ${name} = no.`;
    } else {
      const near = nearest(raw, all);
      if (near) message += ` Did you mean ${near}?`;
    }
    this.add('error', 'bad-enum', name, message);
    return row.d;
  }

  /* Read every member of a family (pull-coord{N}-*) for index i. */
  readFamily(template, index) {
    const out = {};
    // Only the members with as many indices as given: awh{N}- is not awh{N}-dim{M}-.
    for (const fam of FAMILIES.filter(f => f.template.startsWith(template) && f.slots.length === index.length)) {
      let j = 0;
      const name = fam.template.replace(/\{[NM]\}/g, () => index[j++]);
      out[fam.row.n] = this.read(name, fam.row);
    }
    return out;
  }

  is(name, value) {
    return key(this.v[name]) === key(value);
  }

  /* ---- all checks ---- */

  /*
   * The checks run in grompp's order and stop where grompp stops, so that a
   * value grompp would never get to (because it replaced an invalid one by
   * the default, say) does not raise follow-on messages:
   *
   *   1. reading: read_inpfile and the reading part of get_ir, which ends
   *      in write_inpfile ("Unknown left-hand") and stops on any error;
   *   2. the rest of get_ir, check_ir and the topology checks of new_status
   *      (double_check); grompp then stops if there are errors;
   *   3. the checks between reading the topology and the index groups; grompp
   *      stops again if there are errors;
   *   4. do_index;
   *   5. the Verlet buffer, triple_check, the PME grid and the rest.
   *
   * A fatal error (gmx_fatal) stops grompp at once. Warnings never stop it
   * early: they are counted at the end.
   */
  all() {
    for (const e of this.parsed.errors) {
      this.issues.push({
        severity: 'error', id: e.id, option: null, line: e.line, message: e.message, url: '', source: 'grompp'
      });
    }
    this.obsoleteNames();
    if (this.hasFatal()) return;
    this.readAll();
    this.readingChecks();
    this.unknownNames();
    if (this.hasErrors()) return;
    this.getIrChecks();
    if (this.hasFatal()) return;
    this.checkIr();
    if (this.hasFatal()) return;
    this.gromppEarly();
    this.doubleCheck();
    if (this.hasErrors()) return;
    this.gromppChecks();
    if (this.hasErrors()) return;
    this.indexChecks();
    if (this.hasErrors()) return;
    this.bufferChecks();
    this.tripleCheck();
    this.finalChecks();
  }

  hasErrors() {
    return this.issues.some(i => i.severity === 'error' && i.source === 'grompp');
  }

  hasFatal() {
    return this.issues.some(i => i.fatal);
  }

  /* replace_inp_entry: renamed and ignored names. */
  obsoleteNames() {
    for (const e of this.parsed.entries) {
      if (e.empty || e.duplicate) continue;
      const obs = OBSOLETE.get(key(e.key));
      if (!obs || lookup(e.key)) continue;
      if (obs.replacement) {
        const other = this.byKey.get(key(obs.replacement));
        if (other) {
          this.add('error', 'obsolete-both', obs.replacement,
            `"${e.key}" is the old name of ${obs.replacement}, and the file sets both (lines ${e.line} and ${other.line}). ` +
            'grompp stops; keep only the new name.', { line: e.line, fatal: true });
        } else {
          // grompp renames it and carries on; move the entry to the new name.
          this.byKey.delete(key(e.key));
          this.byKey.set(key(obs.replacement), e);
          this.add('note', 'obsolete-renamed', obs.replacement,
            `"${e.key}" is the old name of ${obs.replacement}; grompp reads it as that. Use the new name.`,
            { line: e.line, source: 'advice' });
        }
      } else {
        this.used.add(key(e.key));
        this.add('note', 'obsolete-ignored', null, `"${e.key}" is obsolete and grompp ignores it. ${obs.reason}`,
          { line: e.line, source: 'advice' });
      }
    }
  }

  readAll() {
    const gate = { mts: false, pull: false, awh: false, rotation: false, swapcoords: false, expanded: false };
    // The switches first: they decide what else grompp reads.
    this.read('integrator');
    gate.mts = this.read('mts') === 'yes';
    gate.pull = this.read('pull') === 'yes';
    gate.awh = this.read('awh') === 'yes';
    gate.rotation = this.read('rotation') === 'yes';
    gate.swapcoords = key(this.read('swapcoords')) !== 'NO';
    const fe = this.read('free-energy');
    gate.expanded = key(fe) === 'EXPANDED' || this.read('simulated-tempering') === 'yes';
    this.gate = gate;

    for (const row of ROWS) {
      if (row.f) continue;
      if (row.g && !gate[row.g]) continue;
      if (this.v[row.n] !== undefined) continue;
      this.read(row.n, row);
    }
    // Numbered families, as far as their counts reach.
    const counts = {};
    if (gate.pull) {
      counts.groups = Math.max(0, this.v['pull-ngroups']);
      counts.coords = Math.max(0, this.v['pull-ncoords']);
      for (let g = 1; g <= counts.groups; g++) this.readFamily('pull-group{N}-', [g]);
      for (let c = 1; c <= counts.coords; c++) this.readFamily('pull-coord{N}-', [c]);
    }
    if (gate.awh) {
      const nbias = Math.max(0, this.v['awh-nbias']);
      for (let b = 1; b <= nbias; b++) {
        const bias = this.readFamily('awh{N}-', [b]);
        const ndim = bias['awh1-ndim'];
        for (let d = 1; d <= Math.min(Math.max(0, ndim), 4); d++) this.readFamily('awh{N}-dim{M}-', [b, d]);
      }
    }
    if (gate.rotation) {
      const n = Math.max(0, this.v['rot-ngroups']);
      for (let g = 0; g < n; g++) this.readFamily('rot-', [g]);
    }
    if (gate.swapcoords) {
      const n = Math.max(0, this.v.iontypes);
      for (let t = 0; t < n; t++) this.readFamily('iontype{N}-', [t]);
    }
  }

  /* Whatever grompp did not read: "Unknown left-hand '...' in parameter file". */
  unknownNames() {
    for (const e of this.parsed.entries) {
      if (e.empty || e.duplicate) continue;
      const k = key(e.key);
      if (this.used.has(k)) continue;
      if (OBSOLETE.has(k) && !lookup(e.key)) continue;
      const hit = lookup(e.key);
      if (hit) {
        const row = hit.row;
        let why;
        if (row.g && !this.gate[row.g]) {
          why = `${hit.name} is only read when ${GATE_TEXT[row.g].when}; otherwise grompp does not know it`;
        } else if (row.f) {
          const fam = FAMILIES.find(f => f.row === row);
          const first = fam.first;
          const n = this.v[fam.count];
          why = fam.inner
            ? `${hit.name} is beyond the counts set by ${fam.count} and ${fam.inner.replace('{N}', hit.index[0])}, so grompp does not read it`
            : `${fam.count} = ${n} means grompp reads ${fam.template.replace('{N}', first)} to ${fam.template.replace('{N}', first + n - 1)} only; ` +
              `${hit.name} is not among them`;
        } else {
          why = `grompp did not read ${hit.name}`;
        }
        this.add('warning', 'inactive', hit.name, `${why} and warns "Unknown left-hand '${e.key}' in parameter file".`, { line: e.line });
        continue;
      }
      let hint = '';
      if (key(e.key) === 'LMCMCMOVE') {
        hint = ' The manual documents it as lmc-mc-move, but grompp reads lmc-move.';
      } else {
        let near = nearest(e.key, [...ROWS.map(r => r.n), ...[...OBSOLETE.values()].map(o => o.name)]);
        // A near miss of an old name points at its replacement.
        const old = near && !ROW_BY_NAME.has(near) ? OBSOLETE.get(key(near)) : null;
        if (old) near = old.replacement || '';
        if (near) hint = ` Did you mean ${near}?`;
      }
      this.add('warning', 'unknown', null, `"${e.key}" is not an option of GROMACS ${MDP_RELEASE}; grompp warns ` +
        `"Unknown left-hand '${e.key}' in parameter file" and stops unless -maxwarn allows it.${hint}`, { line: e.line });
    }
  }

  /* Checks grompp makes while reading, before write_inpfile: module options,
     read_pullparams, read_rotparams and the AWH reader. */
  readingChecks() {
    const v = this.v;
    this.useMts = v.mts === 'yes' && EI.DYNAMICS(key(v.integrator));
    // Module options read as lists (electricfield.cpp, densityfittingoptions.cpp)
    for (const axis of ['x', 'y', 'z']) {
      const n = `electric-field-${axis}`;
      const ws = words(v[n]);
      if (!this.set[n] || !ws.length) continue;
      if (ws.length !== 4 || ws.some(w => strictReal(w) === null)) {
        this.add('error', 'electric-field', n, `${n} needs four numbers, E0 omega t0 sigma (for a static field: E0 0 0 0). grompp stops.`);
      } else if (Number(ws[3]) === 0 && Number(ws[2]) !== 0) {
        this.add('error', 'electric-field', n, `With sigma = 0 the field is not pulsed and t0 is ignored: set t0 to 0 in ${n}.`);
      }
    }
    for (const [n, need] of [['density-guided-simulation-shift-vector', 3], ['density-guided-simulation-transformation-matrix', 9]]) {
      if (!this.set[n]) continue;
      const parts = String(v[n]).split(/[\s,]+/).filter(Boolean);
      if (parts.length !== need || parts.some(w => strictReal(w) === null)) {
        this.add('error', 'density-guided-vector', n, `${n} needs ${need} numbers separated by commas.`);
      }
    }

    // Pulling, rotation and AWH (read_pullparams, read_rotparams, AwhParams)
    if (this.gate.pull) this.pullChecks();
    if (this.gate.rotation && v['rot-ngroups'] < 1) this.add('error', 'rot-ngroups', 'rot-ngroups', 'rot-ngroups must be 1 or more.');
    if (this.gate.awh) {
      if (v['awh-nbias'] <= 0) this.add('error', 'awh-nbias', 'awh-nbias', 'awh-nbias must be a whole number above 0.');
      for (let b = 1; b <= Math.max(0, v['awh-nbias']); b++) {
        const ndim = v[`awh${b}-ndim`];
        if (!(ndim > 0 && ndim <= 4)) {
          this.add('error', 'awh-ndim', `awh${b}-ndim`, `awh${b}-ndim must be between 1 and 4. Note that grompp's default is 0, ` +
            'not 1 as the manual says, so it has to be set.');
        }
      }
    }
    if (this.gate.swapcoords && v.iontypes < 1) this.add('error', 'iontypes', 'iontypes', 'At least one ion type is needed for position swapping.');
  }

  /* ---- get_ir: processing after reading ---- */

  getIrChecks() {
    const v = this.v;
    const I = key(v.integrator);
    this.I = I;
    this.epc = key(v.pcoupl);
    this.etc = key(v.tcoupl);
    this.efep = key(v['free-energy']);
    this.nshake = key(v.constraints) === 'NONE' ? 0 : 1;
    this.useMts = v.mts === 'yes' && EI.DYNAMICS(I);

    // Pressure coupling values: how many pcoupltype needs.
    this.compress = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    this.refp = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    if (this.epc !== 'NO') {
      const type = key(v.pcoupltype);
      const need = type === 'ISOTROPIC' ? 1 : type === 'ANISOTROPIC' ? 6 : 2;
      for (const [name, target] of [['compressibility', this.compress], ['ref-p', this.refp]]) {
        const nums = scanReals(v[name], need);
        if (nums.length < need) {
          this.add('error', 'pcoupl-count', name,
            `pcoupltype = ${v.pcoupltype} needs exactly ${need} value${need > 1 ? 's' : ''} of ${name}` +
            (need === 2 ? ' (x/y, then z)' : need === 6 ? ' (xx yy zz xy xz yz)' : '') +
            `; the file gives ${words(v[name]).length || 'none'}. grompp stops.`,
            { line: this.set[name] ? this.set[name].line : (this.set.pcoupl ? this.set.pcoupl.line : null) });
        }
        const d = [...nums, 0, 0, 0, 0, 0, 0];
        if (type === 'ISOTROPIC') { target[0][0] = target[1][1] = target[2][2] = d[0]; }
        else if (type === 'ANISOTROPIC') {
          target[0][0] = d[0]; target[1][1] = d[1]; target[2][2] = d[2];
          target[0][1] = target[1][0] = d[3]; target[0][2] = target[2][0] = d[4]; target[1][2] = target[2][1] = d[5];
        } else { target[0][0] = target[1][1] = d[0]; target[2][2] = d[1]; }
      }
      if (type === 'ANISOTROPIC' && this.refp[0][1] !== 0 && this.refp[0][2] !== 0 && this.refp[1][2] !== 0) {
        this.add('warning', 'shear-stress', 'ref-p', 'All three off-diagonal reference pressures are non-zero: ' +
          'this applies a threefold shear stress. grompp warns; check that this is what you want.');
      }
    }
    if (key(v['comm-mode']) === 'NONE') v.nstcomm = 0;

    // Free energy
    const couple = String(v['couple-moltype'] || '').trim();
    if (couple) {
      if (this.efep !== 'NO') {
        if (key(v['couple-lambda0']) === key(v['couple-lambda1'])) {
          this.add('warning', 'couple-same', 'couple-lambda1', 'couple-lambda0 and couple-lambda1 are the same, so ' +
            `${couple} is not decoupled at all. grompp warns.`);
        }
        if (!EI.RANDOM(I) && (key(v['couple-lambda0']) === 'NONE' || key(v['couple-lambda1']) === 'NONE')) {
          this.add('note', 'couple-sd', 'integrator', 'A fully decoupled molecule is sampled properly only with ' +
            'stochastic dynamics (integrator = sd).');
        }
      } else {
        this.add('note', 'couple-no-fep', 'couple-moltype', `free-energy = no, so ${couple} is not decoupled.`);
      }
    }
    if (this.efep !== 'NO' && Number(v['delta-lambda']) !== 0) this.efep = 'SLOWGROWTH';
    if (key(v['dhdl-print-energy']) === 'YES') {
      this.add('note', 'dhdl-print-energy-yes', 'dhdl-print-energy', 'dhdl-print-energy = yes is the old spelling; grompp reads it as total.');
    }
    this.lambdas = { n: 0, arrays: {} };
    if (this.efep !== 'NO' || v['simulated-tempering'] === 'yes') this.fepParams();
    if (this.efep !== 'NO' && this.lambdas.n === 0 && Number(v['sc-alpha']) !== 0 &&
      ['VDWQ', 'VDW'].includes(key(v['couple-lambda0'])) && ['VDWQ', 'VDW'].includes(key(v['couple-lambda1']))) {
      this.add('warning', 'softcore-unneeded', 'sc-alpha', 'Soft-core is on (sc-alpha is not 0) while the van der Waals ' +
        'interactions are not decoupled. It does no harm, but needs much more sampling; consider sc-alpha = 0.');
    }

    // Walls
    const nwall = v.nwall;
    if (nwall > 0) {
      const types = words(v['wall-atomtype']);
      if (types.length !== nwall) {
        this.add('error', 'wall-atomtype-count', 'wall-atomtype', `nwall = ${nwall} needs ${nwall} wall atom type${nwall > 1 ? 's' : ''}; ` +
          `wall-atomtype gives ${types.length}. grompp stops.`, { fatal: true });
      }
      if (['93', '104'].includes(key(v['wall-type']))) {
        const dens = words(v['wall-density']);
        if (dens.length !== nwall) {
          this.add('error', 'wall-density-count', 'wall-density', `nwall = ${nwall} needs ${nwall} wall density value${nwall > 1 ? 's' : ''}; ` +
            `wall-density gives ${dens.length}. grompp stops.`, { fatal: true });
        } else if (dens.some(d => !(strictReal(d) > 0))) {
          this.add('error', 'wall-density', 'wall-density', 'Every wall density must be a positive number. grompp stops.', { fatal: true });
        }
      }
    }
    if (v.orire === 'yes' && words(v['orire-fitgrp']).length !== 1) {
      this.add('error', 'orire-fitgrp', 'orire-fitgrp', 'Orientation restraints need exactly one fit group in orire-fitgrp.');
    }

    // Deformation
    this.deform = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const deformText = String(v.deform || '').trim();
    if (deformText) {
      const nums = scanReals(deformText, 7);
      if (nums.length !== 6) {
        this.add('error', 'deform-count', 'deform', `deform needs exactly six numbers (a b c b(x) c(x) c(y) in nm/ps); ` +
          `"${deformText}" does not give six. grompp stops.`);
      }
      const d = [...nums, 0, 0, 0, 0, 0, 0];
      this.deform = [[d[0], 0, 0], [d[3], d[1], 0], [d[4], d[5], d[2]]];
      if (this.epc !== 'NO') {
        let bad = false;
        for (let i = 0; i < 3; i++) for (let j = 0; j <= i; j++) if (this.deform[i][j] !== 0 && this.compress[i][j] !== 0) bad = true;
        if (bad) {
          this.add('error', 'deform-compressibility', 'deform', 'A box element is both deformed (deform) and pressure-coupled ' +
            '(compressibility above 0). Set the compressibility of deformed elements to 0.');
        }
      }
    }
    this.haveDeform = this.deform.some(r => r.some(x => x !== 0));

    // Swapping
    if (this.gate.swapcoords) {
      if (v['swap-frequency'] < 1) this.add('error', 'swap-frequency', 'swap-frequency', 'swap-frequency must be 1 or more.');
      if (v['coupl-steps'] < 1) this.add('error', 'coupl-steps', 'coupl-steps', 'coupl-steps must be 1 or more.');
      if (v.threshold < 1) this.add('error', 'swap-threshold', 'threshold', 'threshold must be at least 1.');
      for (const n of ['bulk-offsetA', 'bulk-offsetB']) {
        if (!(v[n] > -1 && v[n] < 1)) this.add('error', 'bulk-offset', n, `${n} must be between -1 and 1 (exclusive).`);
      }
    }

    // Multiple time stepping
    this.mtsFactor = 1;
    if (this.useMts) {
      if (v['mts-levels'] !== 2) this.add('error', 'mts-levels', 'mts-levels', 'Only mts-levels = 2 is supported.');
      const known = ['longrange-nonbonded', 'nonbonded', 'pair', 'dihedral', 'angle', 'pull', 'awh'];
      this.mtsGroups = words(v['mts-level2-forces']).map(w => w.toLowerCase());
      for (const g of this.mtsGroups) {
        if (!known.includes(g)) this.add('error', 'mts-force-group', 'mts-level2-forces', `Unknown MTS force group "${g}"; use ${known.join(', ')}.`);
      }
      this.mtsFactor = v['mts-level2-factor'];
      if (this.mtsFactor <= 1) this.add('error', 'mts-factor', 'mts-level2-factor', 'mts-level2-factor must be larger than 1.');
      this.validMts = v['mts-levels'] === 2 && this.mtsFactor > 1;
    }

  }

  fepParams() {
    const v = this.v;
    const names = ['fep-lambdas', 'mass-lambdas', 'coul-lambdas', 'vdw-lambdas', 'bonded-lambdas', 'restraint-lambdas', 'temperature-lambdas'];
    const arrays = {};
    let first = 0;
    for (const n of names) {
      const ws = words(v[n]);
      arrays[n] = ws.map(w => {
        const x = strictReal(w);
        if (x === null) this.add('error', 'lambda-value', n, `"${w}" in ${n} is not a number.`);
        return x === null ? 0 : x;
      });
      if (!first && ws.length) first = ws.length;
    }
    for (const n of names) {
      if (arrays[n].length && arrays[n].length !== first) {
        this.add('error', 'lambda-count', n, `${n} has ${arrays[n].length} values but the other lambda arrays have ${first}; ` +
          'every lambda array that is given must have the same length. grompp stops.', { fatal: true });
      }
    }
    this.lambdas = { n: first, arrays };
    for (const n of names) if (!arrays[n].length && n !== 'fep-lambdas') arrays[n] = arrays['fep-lambdas'].slice();
    for (const [n, label] of [['init-lambda-weights', 'weights'], ['init-lambda-counts', 'counts'], ['init-wl-histogram-counts', 'histogram counts']]) {
      const c = words(v[n]).length;
      if (c && c !== first) {
        this.add('error', 'lambda-count', n, `${n} has ${c} ${label} but there are ${first} lambda states. grompp stops.`, { fatal: true });
      }
    }
  }

  pullChecks() {
    const v = this.v;
    if (v['pull-ngroups'] < 1) this.add('error', 'pull-ngroups', 'pull-ngroups', 'pull-ngroups must be 1 or more. grompp stops.');
    if (v['pull-ncoords'] < 1) this.add('error', 'pull-ncoords', 'pull-ncoords', 'pull-ncoords must be 1 or more. grompp stops.');
    const ngroup = Math.max(0, v['pull-ngroups']);
    for (let c = 1; c <= Math.max(0, v['pull-ncoords']); c++) {
      const p = (s) => `pull-coord${c}-${s}`;
      const type = key(v[p('type')]);
      const geom = key(v[p('geometry')]);
      const need = geom === 'DIHEDRAL' ? 6 : (geom === 'DIRECTIONRELATIVE' || geom === 'ANGLE') ? 4 : geom === 'TRANSFORMATION' ? 0 : 2;
      const groups = scanInts(v[p('groups')], 7);
      if (groups.length !== need) {
        this.add('error', 'pull-groups-count', p('groups'), `With geometry ${v[p('geometry')]}, ${p('groups')} needs ${need} pull group ` +
          `numbers; it has ${groups.length}. grompp stops.`);
      }
      for (const g of groups.slice(0, need)) {
        if (g < 0 || g > ngroup) {
          this.add('error', 'pull-group-range', p('groups'), `${p('groups')} names pull group ${g}, but only 0 to ${ngroup} exist ` +
            '(pull-ngroups). grompp stops.');
          break;
        }
      }
      if (need >= 2 && groups[0] === groups[1] && groups.length >= 2) {
        this.add('error', 'pull-groups-same', p('groups'), `The two groups of ${p('groups')} are the same. grompp stops.`);
      }
      if (type === 'CONSTRAINT' && ['CYLINDER', 'DIRECTIONRELATIVE', 'ANGLE', 'ANGLEAXIS', 'DIHEDRAL'].includes(geom)) {
        this.add('error', 'pull-constraint-geometry', p('type'), `Constraint pulling cannot be combined with geometry ${v[p('geometry')]}; use umbrella.`);
      }
      if (type === 'EXTERNALPOTENTIAL') {
        if (!String(v[p('potential-provider')] || '').trim()) {
          this.add('error', 'pull-provider', p('potential-provider'), `Type external-potential needs ${p('potential-provider')} (for example awh).`);
        }
        if (v[p('rate')] !== 0) this.add('error', 'pull-external-rate', p('rate'), 'An external potential needs pull rate 0.');
      }
      if (this.useMts && type === 'CONSTRAINT') {
        this.add('error', 'pull-constraint-mts', p('type'), 'Constraint pulling is not supported with multiple time stepping.');
      }
      // Dimensions
      const dims = words(v[p('dim')]);
      const dim = [0, 0, 0];
      let bad = false;
      for (let d = 0; d < 3; d++) {
        const w = dims[d];
        if (w === undefined) { this.add('error', 'pull-dim', p('dim'), `${p('dim')} needs three entries, Y or N. grompp stops.`); bad = true; break; }
        if (/^n/i.test(w)) dim[d] = 0;
        else if (/^y/i.test(w)) dim[d] = 1;
        else { this.add('error', 'pull-dim', p('dim'), `Use Y or N in ${p('dim')}, not "${w}". grompp stops.`); bad = true; break; }
      }
      const ndim = dim.reduce((a, b) => a + b, 0);
      if (!bad && ndim === 0) this.add('error', 'pull-dim', p('dim'), `${p('dim')} is N N N: the coordinate would act in no direction.`);
      if (!bad && geom === 'DIHEDRAL' && ndim < 3) this.add('error', 'pull-dim', p('dim'), 'The dihedral geometry needs pull-coord-dim = Y Y Y.');
      if (!bad && (geom === 'ANGLE' || geom === 'ANGLEAXIS') && ndim < 2) {
        this.add('error', 'pull-dim', p('dim'), `The ${v[p('geometry')]} geometry needs Y for at least two dimensions.`);
      }
      const origin = scanReals(v[p('origin')], 3);
      if (groups[0] !== 0 && origin.some(x => x !== 0)) {
        this.add('error', 'pull-origin', p('origin'), 'A pull origin can only be set when the first group is 0 (an absolute reference).');
      }
      const init = v[p('init')];
      if (v[p('start')] === 'yes') {
        if (geom === 'DISTANCE' && init < 0) {
          this.add('warning', 'pull-init-negative', p('init'), `${p('init')} is negative with the distance geometry, where distances ` +
            'cannot be negative. With start = yes this may still work; use geometry direction for signed distances.');
        } else if ((geom === 'ANGLE' || geom === 'ANGLEAXIS') && (init < 0 || init > 180)) {
          this.add('warning', 'pull-init-angle', p('init'), `${p('init')} is outside 0 to 180 degrees for an angle geometry.`);
        } else if (geom === 'DIHEDRAL' && (init < -180 || init > 180)) {
          this.add('warning', 'pull-init-angle', p('init'), `${p('init')} is outside -180 to 180 degrees for a dihedral.`);
        }
      }
      const vec = scanReals(v[p('vec')], 3);
      const vecSet = vec.some(x => x !== 0);
      if (['DIRECTION', 'CYLINDER', 'DIRECTIONPERIODIC', 'ANGLEAXIS'].includes(geom)) {
        if (!vecSet) {
          this.add('error', 'pull-vec-zero', p('vec'), `With geometry ${v[p('geometry')]} the pull vector ${p('vec')} cannot be 0 0 0. grompp stops.`);
        } else {
          for (let d = 0; d < 3; d++) {
            if (vec[d] !== 0 && !dim[d]) {
              this.add('error', 'pull-vec-dim', p('vec'), `${p('vec')} has a ${'xyz'[d]} component but ${p('dim')} is N for ${'xyz'[d]}. grompp stops.`);
              break;
            }
          }
        }
      } else if (vecSet) {
        this.add('warning', 'pull-vec-unused', p('vec'), `A pull vector is given but geometry ${v[p('geometry')]} does not use it; ` +
          `grompp warns. Use geometry ${geom === 'ANGLE' ? 'angle-axis' : 'direction'} to pull along it, or remove it.`);
      }
      if (geom === 'TRANSFORMATION') {
        if (type === 'CONSTRAINT') this.add('error', 'pull-transformation', p('type'), 'A transformation coordinate cannot be of type constraint.');
        const expr = String(v[p('expression')] || '').trim();
        if (!expr) this.add('error', 'pull-transformation', p('expression'), `${p('expression')} must be set for geometry transformation.`);
        else if (/^["']/.test(expr)) this.add('error', 'pull-transformation', p('expression'), 'Write the expression without quotes.');
        if (v[p('dx')] === 0) this.add('error', 'pull-transformation', p('dx'), `${p('dx')} cannot be 0.`);
      }
      if (type === 'EXTERNALPOTENTIAL' && geom === 'CYLINDER') {
        this.add('note', 'pull-external-cylinder', p('geometry'), 'With an external potential and the cylinder geometry, keep the ' +
          'distance along the cylinder axis below half the box.');
      }
      this.pullCoordGeom = this.pullCoordGeom || [];
      this.pullCoordGeom.push({ c, geom, groups, dim, vec });
    }
  }

  /* ---- check_ir ---- */

  checkIr() {
    const v = this.v;
    const I = this.I;
    const dyn = EI.DYNAMICS(I);
    const ct = key(v.coulombtype);
    this.ct = ct;
    let cmod = key(v['coulomb-modifier']);
    let vmod = key(v['vdw-modifier']);
    let vt = key(v.vdwtype);
    const pbc = key(v.pbc);
    const nbounded = pbc === 'XYZ' || pbc === 'SCREW' ? 3 : pbc === 'XY' ? (v.nwall === 2 ? 3 : 2) : 0;
    this.nbounded = nbounded;

    if (dyn && !(v.dt > 0)) this.add('error', 'dt', 'dt', 'dt must be larger than 0 for dynamics.');

    // MTS requirements
    if (this.useMts && this.validMts) {
      const f = this.mtsFactor;
      if (I !== 'MD') this.add('error', 'mts-integrator', 'mts', 'Multiple time stepping works only with integrator = md.');
      if ((COULOMB.FULL(ct) || vt === 'PME') && !this.mtsGroups.includes('longrange-nonbonded')) {
        this.add('error', 'mts-longrange', 'mts-level2-forces', 'With PME or Ewald, mts-level2-forces must include longrange-nonbonded.');
      }
      const mult = [['nstcalcenergy', v.nstcalcenergy > 0], ['nstenergy', true], ['nstlog', true], ['nstfout', true]];
      if (this.efep !== 'NO') mult.push(['nstdhdl', true]);
      if (this.mtsGroups.includes('nonbonded')) mult.push(['nstlist', true]);
      for (const [n, on] of mult) {
        if (on && v[n] % f !== 0) this.add('error', 'mts-interval', n, `With multiple time stepping, ${n} = ${v[n]} must be a multiple of mts-level2-factor = ${f}.`);
      }
      if (this.gate.pull) {
        const pf = this.mtsGroups.includes('pull') ? f : 1;
        if (v['pull-nstxout'] % pf) this.add('error', 'mts-interval', 'pull-nstxout', 'pull-nstxout must be a multiple of mts-level2-factor.');
        if (v['pull-nstfout'] % pf) this.add('error', 'mts-interval', 'pull-nstfout', 'pull-nstfout must be a multiple of mts-level2-factor.');
      }
    }

    if (ct === 'REACTIONFIELDNEC(UNSUPPORTED)') this.add('error', 'coulombtype-removed', 'coulombtype', 'Reaction-Field-nec is no longer supported.');

    // Cut-offs
    if (v.rcoulomb < 0) this.add('error', 'rcoulomb-negative', 'rcoulomb', 'rcoulomb cannot be negative.');
    if (v.rvdw < 0) this.add('error', 'rvdw-negative', 'rvdw', 'rvdw cannot be negative.');
    const verlet = key(v['cutoff-scheme']) === 'VERLET';
    if (verlet && v.rcoulomb === 0 && v.rvdw === 0) {
      this.add('error', 'cutoffs-zero', 'rcoulomb', 'With the Verlet scheme at least one of rcoulomb and rvdw must be above 0.');
    }
    let rlist = v.rlist;
    const vbt = v['verlet-buffer-tolerance'];
    if (rlist < 0 && !(verlet && vbt > 0)) this.add('error', 'rlist-negative', 'rlist', 'rlist cannot be negative.');
    if (v.nstlist < 0) this.add('error', 'nstlist-negative', 'nstlist', 'nstlist cannot be negative.');

    if (cmod === 'POTENTIALSHIFTVERLET') cmod = 'POTENTIALSHIFT';
    if (vmod === 'POTENTIALSHIFTVERLET') vmod = 'POTENTIALSHIFT';

    if (!verlet) {
      this.add('error', 'group-scheme', 'cutoff-scheme', 'The group cut-off scheme was removed in GROMACS 2020; use cutoff-scheme = Verlet. grompp stops.', { fatal: true });
      return;
    } else {
      if (nbounded < 3) {
        this.add('error', 'verlet-pbc', 'pbc', 'The Verlet scheme needs periodic boundaries in all directions, or pbc = xy with two walls.');
      }
      if (v.rcoulomb !== v.rvdw && !(COULOMB.PME_OR_EWALD(ct) && vt === 'CUTOFF' && v.rcoulomb > v.rvdw)) {
        this.add('error', 'rc-mismatch', 'rvdw', `rcoulomb (${v.rcoulomb}) and rvdw (${v.rvdw}) differ. With the Verlet scheme they must be equal, ` +
          'except for rcoulomb larger than rvdw with PME.');
      }
      if (vt === 'SHIFT' || vt === 'SWITCH') {
        if (vmod === 'NONE' || vmod === 'POTENTIALSHIFT') {
          const nm = vt === 'SHIFT' ? 'Force-switch' : 'Potential-switch';
          this.add('note', 'vdwtype-replaced', 'vdwtype', `vdwtype = ${v.vdwtype} is replaced by vdwtype = Cut-off with vdw-modifier = ${nm}, ` +
            'which is the same; write it that way.');
          vmod = vt === 'SHIFT' ? 'FORCESWITCH' : 'POTENTIALSWITCH';
          vt = 'CUTOFF';
        } else {
          this.add('error', 'vdwtype-modifier', 'vdw-modifier', `vdwtype = ${v.vdwtype} cannot be combined with vdw-modifier = ${v['vdw-modifier']}.`);
        }
      }
      if (!(vt === 'CUTOFF' || vt === 'PME')) {
        this.add('error', 'verlet-vdwtype', 'vdwtype', 'With the Verlet scheme only vdwtype = Cut-off or PME is supported.');
      }
      if (!(ct === 'CUTOFF' || COULOMB.RF(ct) || COULOMB.PME(ct) || ct === 'EWALD')) {
        this.add('error', 'verlet-coulombtype', 'coulombtype', 'With the Verlet scheme only cut-off, reaction-field, PME and Ewald electrostatics are supported.');
      }
      if (!(cmod === 'NONE' || cmod === 'POTENTIALSHIFT')) {
        this.add('error', 'verlet-coulomb-modifier', 'coulomb-modifier', `coulomb-modifier = ${v['coulomb-modifier']} is not supported; use Potential-shift or None.`);
      }
      if (COULOMB.USER_TABLE(ct)) {
        this.add('error', 'verlet-user-table', 'coulombtype', `coulombtype = ${v.coulombtype} is not supported with the Verlet scheme.`);
      }
      if (v.nstlist <= 0) this.add('error', 'nstlist-zero', 'nstlist', 'With the Verlet scheme nstlist must be above 0.');
      if (v.nstlist < 10) {
        this.add('note', 'nstlist-small', 'nstlist', `nstlist = ${v.nstlist}: with the Verlet scheme 10 or more is best (20 or more with GPUs); ` +
          'nstlist does not change the accuracy.');
      }
      const rcMax = Math.max(v.rvdw, v.rcoulomb);
      if (EI.TPI(I)) {
        rlist = rcMax;
      } else if (vbt <= 0) {
        if (vbt === 0) this.add('error', 'vbt-zero', 'verlet-buffer-tolerance', 'verlet-buffer-tolerance cannot be exactly 0; use -1 to set rlist yourself.');
        if (rlist < rcMax) this.add('error', 'rlist-short', 'rlist', 'rlist cannot be shorter than rvdw or rcoulomb.');
        if (rlist === rcMax && v.nstlist > 1) {
          this.add('note', 'rlist-no-buffer', 'rlist', 'rlist equals the cut-off, so there is no Verlet buffer; a larger rlist may be ' +
            'needed for good energy conservation.');
        }
        if (v['verlet-buffer-pressure-tolerance'] > 0 && v.nstlist > 1) {
          this.add('note', 'vbpt-ignored', 'verlet-buffer-pressure-tolerance', 'verlet-buffer-pressure-tolerance is ignored when verlet-buffer-tolerance < 0.');
        }
      } else {
        if (v['verlet-buffer-pressure-tolerance'] === 0) {
          this.add('error', 'vbpt-zero', 'verlet-buffer-pressure-tolerance', 'verlet-buffer-pressure-tolerance cannot be exactly 0.');
        }
        if (rlist > rcMax) {
          this.add('note', 'rlist-ignored', 'rlist', 'rlist is larger than the cut-off but verlet-buffer-tolerance is above 0, so grompp ' +
            'sets rlist itself and ignores this value.');
        }
        if (v.nstlist === 1) rlist = rcMax;
        else if (dyn) {
          if (nbounded < 3) {
            this.add('error', 'vbt-no-volume', 'verlet-buffer-tolerance', 'The buffer is computed from the box volume, which a box ' +
              'open in some direction does not have: set rlist yourself with verlet-buffer-tolerance = -1.');
          }
          rlist = rcMax;
        } else {
          rlist = 1.05 * rcMax;
        }
      }
    }
    this.rlist = rlist;
    this.vt = vt;
    this.vmod = vmod;
    this.cmod = cmod;

    // General integrator
    if (!EI.MD(I)) {
      if (this.etc !== 'NO') {
        this.add('note', EI.RANDOM(I) ? 'tcoupl-sd' : 'tcoupl-ignored', 'tcoupl', EI.RANDOM(I)
          ? `integrator = ${v.integrator} controls the temperature itself (with tau-t and ref-t), so tcoupl is set to no.`
          : `Temperature coupling does not apply to integrator = ${v.integrator}; grompp sets tcoupl = no.`);
      }
      this.etc = 'NO';
    }
    if (I === 'MDVVAVEK') {
      this.add('note', 'md-vv-avek', 'integrator', 'md-vv-avek is meant mainly for validation; md or md-vv are the usual choices.');
    }
    if (!dyn) {
      if (this.epc !== 'NO') {
        this.add('note', 'pcoupl-ignored', 'pcoupl', `Pressure coupling does not apply to integrator = ${v.integrator}; grompp sets pcoupl = no.`);
      }
      this.epc = 'NO';
    }

    let nstcalcenergy = v.nstcalcenergy;
    this.nstpcouple = v.nstpcouple;
    if (dyn) {
      if (nstcalcenergy < 0) nstcalcenergy = 100;
      const nstdhdl = v.nstdhdl;
      const fep = this.efep !== 'NO';
      if ((v.nstenergy > 0 && nstcalcenergy > v.nstenergy) || (fep && nstdhdl > 0 && nstcalcenergy > nstdhdl)) {
        let minName = 'nstenergy';
        let minNst = v.nstenergy;
        if (fep && nstdhdl > 0 && (v.nstenergy === 0 || nstdhdl < v.nstenergy)) { minNst = nstdhdl; minName = 'nstdhdl'; }
        this.add('note', 'nstcalcenergy-reduced', 'nstcalcenergy', `nstcalcenergy (${nstcalcenergy}) is larger than ${minName} (${minNst}); ` +
          `grompp sets nstcalcenergy = ${minNst}.`, { line: this.set.nstcalcenergy ? this.set.nstcalcenergy.line : (this.set[minName] ? this.set[minName].line : null) });
        nstcalcenergy = minNst;
      }
      if (this.epc !== 'NO') {
        if (this.nstpcouple < 0) this.nstpcouple = this.optimalNstpcouple();
        if (this.useMts && this.validMts && this.nstpcouple % this.mtsFactor !== 0) {
          this.add('error', 'mts-nstpcouple', 'nstpcouple', 'With multiple time stepping, nstpcouple must be a multiple of mts-level2-factor.');
        }
      }
      if (nstcalcenergy > 0) {
        if (fep) this.checkNst(nstcalcenergy, 'nstdhdl');
        if (this.gate.expanded && v.nstexpanded > 0) this.checkNst(nstcalcenergy, 'nstexpanded');
        this.checkNst(nstcalcenergy, 'nstenergy');
      }
    }
    this.nstcalcenergy = nstcalcenergy;
    v.nstcalcenergy = nstcalcenergy;

    if (v.nsteps === 0 && v.continuation !== 'yes') {
      this.add('note', 'nsteps-zero', 'nsteps', 'For a correct single-point energy with nsteps = 0, set continuation = yes so the ' +
        'input coordinates are not constrained.');
    }
    if (EI.RANDOM(I) && v.continuation === 'yes' && v['ld-seed'] !== -1) {
      this.add('note', 'ld-seed-continuation', 'ld-seed', 'This continues an sd or bd run with a fixed ld-seed: make sure it differs ' +
        'from the previous run (ld-seed = -1 does that).');
    }
    if (EI.TPI(I)) {
      if (pbc !== 'XYZ') this.add('error', 'tpi-pbc', 'pbc', 'Test-particle insertion needs pbc = xyz.');
      if (v.nstlist <= 0) this.add('error', 'tpi-nstlist', 'nstlist', 'Test-particle insertion needs nstlist above 0.');
      if (COULOMB.FULL(ct) && !COULOMB.PME(ct)) this.add('error', 'tpi-elec', 'coulombtype', 'Test-particle insertion works only with PME among the long-range methods.');
    }
    if (this.nshake > 0 && v.morse === 'yes') {
      this.add('warning', 'morse-constraints', 'morse', 'Morse bonds are useless when the bonds are constrained (constraints is not none).');
    }

    if (v['simulated-tempering'] === 'yes') this.simulatedTempering();
    if (this.efep !== 'NO') this.freeEnergy();
    if (v['simulated-tempering'] === 'yes' || this.efep === 'EXPANDED') this.expandedEnsemble();

    // Walls and vacuum
    if (v.nwall && pbc !== 'XY') this.add('error', 'walls-pbc', 'nwall', 'Walls need pbc = xy.');
    if (pbc !== 'XYZ' && v.nwall !== 2) {
      if (pbc === 'NO') {
        if (this.epc !== 'NO') {
          this.add('warning', 'vacuum-pcoupl', 'pcoupl', 'Without periodic boundaries (pbc = no) there is no pressure to couple to; grompp turns pressure coupling off and warns.');
          this.epc = 'NO';
        }
      } else if (this.epc !== 'NO') {
        this.add('error', 'pbc-pcoupl', 'pcoupl', `Pressure coupling needs pbc = xyz (or pbc = xy with two walls), not pbc = ${v.pbc}.`);
      }
      if (COULOMB.FULL(ct)) this.add('error', 'vacuum-ewald', 'coulombtype', `PME and Ewald need periodic boundaries in all directions, not pbc = ${v.pbc}.`);
      if (key(v.DispCorr) !== 'NO') this.add('error', 'vacuum-dispcorr', 'DispCorr', `Dispersion correction needs periodic boundaries, not pbc = ${v.pbc}.`);
    }
    if (rlist === 0) {
      if ((ct !== 'CUTOFF' && ct !== 'USER') || pbc !== 'NO' || v.rcoulomb !== 0 || v.rvdw !== 0) {
        this.add('error', 'rlist-zero', 'rlist', 'rlist = 0 (no cut-off) is only possible with coulombtype = Cut-off, pbc = no and rcoulomb = rvdw = 0.');
      }
      if (v.nstlist > 0) this.add('note', 'no-cutoff-nstlist', 'nstlist', 'Without cut-offs, nstlist = 0 with one MPI rank can be slightly faster.');
    }

    // Centre-of-mass motion
    this.commMode = key(v['comm-mode']);
    let nstcomm = v.nstcomm;
    if (nstcomm === 0) this.commMode = 'NONE';
    if (this.commMode !== 'NONE') {
      if (nstcomm < 0) {
        this.add('warning', 'nstcomm-negative', 'nstcomm', 'A negative nstcomm once meant removing rotation too; use comm-mode = Angular instead. ' +
          'grompp takes its absolute value and warns.');
        nstcomm = Math.abs(nstcomm);
      }
      if (nstcalcenergy > 0 && nstcomm < nstcalcenergy && this.commMode !== 'LINEARACCELERATIONCORRECTION') {
        this.add('note', 'nstcomm-small', 'nstcomm', `nstcomm (${nstcomm}) is smaller than nstcalcenergy (${nstcalcenergy}), which costs time for ` +
          'nothing; set nstcomm equal to nstcalcenergy.');
      }
      if (this.commMode === 'ANGULAR') {
        if (v['periodic-molecules'] === 'yes') this.add('error', 'angular-periodic', 'comm-mode', 'Rotation cannot be removed with periodic molecules.');
        if (pbc !== 'NO') {
          this.add('warning', 'angular-pbc', 'comm-mode', 'comm-mode = Angular in a periodic system can cause artefacts; use it only for a single ' +
            'molecule or cluster that does not cross the box edges.');
        }
      }
    }
    this.nstcomm = nstcomm;
    if (EI.STATE_VELOCITY(I) && !EI.SD(I) && pbc === 'NO' && this.commMode !== 'ANGULAR') {
      this.add('note', 'flying-ice-cube', 'comm-mode', 'Without periodic boundaries rotation of the whole system is not removed ' +
        '("flying ice cube"); set comm-mode = Angular or use integrator = sd.');
    }

    // Temperature coupling
    if (this.etc === 'YES') {
      this.add('note', 'tcoupl-yes', 'tcoupl', 'tcoupl = yes is the old spelling of berendsen; grompp reads it as Berendsen.');
      this.etc = 'BERENDSEN';
    }
    let nhchain = v['nh-chain-length'];
    if (this.etc === 'NOSEHOOVER' || this.epc === 'MTTK') {
      if (nhchain < 1) {
        this.add('warning', 'nh-chain-short', 'nh-chain-length', 'nh-chain-length cannot be below 1; grompp sets it to 1 and warns.');
        nhchain = 1;
      }
      if (this.etc === 'NOSEHOOVER' && !EI.VV(I) && nhchain > 1) {
        this.add('note', 'nh-chain-leapfrog', 'nh-chain-length', `The leap-frog integrator (md) supports only Nose-Hoover chains of length 1; ` +
          `grompp resets nh-chain-length from ${nhchain} (the default is 10) to 1. Set nh-chain-length = 1 to silence this.`);
        nhchain = 1;
      }
    }
    if (I === 'MDVVAVEK' && (v.nsttcouple !== 1 || this.nstpcouple !== 1)) {
      this.add('error', 'md-vv-avek-nst', 'integrator', 'md-vv-avek needs nsttcouple = 1 and nstpcouple = 1.');
    }
    if (this.etc === 'ANDERSEN' || this.etc === 'ANDERSENMASSIVE') {
      if (!EI.VV(I)) this.add('error', 'andersen-integrator', 'tcoupl', `${v.tcoupl} temperature control needs integrator md-vv or md-vv-avek.`);
      if (nstcomm > 0 && this.etc === 'ANDERSEN') {
        this.add('note', 'andersen-comm', 'nstcomm', 'Centre-of-mass removal is not needed with Andersen coupling, which re-randomises velocities.');
      }
      if (nstcomm > 1 && this.etc === 'ANDERSEN') this.add('error', 'andersen-nstcomm', 'nstcomm', 'With Andersen coupling nstcomm must be 1.');
      if (this.nshake !== 0 && this.etc === 'ANDERSEN') {
        this.add('error', 'andersen-constraints', 'tcoupl', 'Andersen coupling does not work with constraints; use andersen-massive.');
      }
    }
    if (this.etc === 'BERENDSEN') {
      this.add('warning', 'berendsen-thermostat', 'tcoupl', 'The Berendsen thermostat does not give the correct distribution of kinetic energy ' +
        'and should not be used for new simulations; grompp warns. Use tcoupl = v-rescale.');
    }
    if (this.epc === 'BERENDSEN') {
      this.add('warning', 'berendsen-barostat', 'pcoupl', 'The Berendsen barostat does not give a correct ensemble and should not be used for ' +
        'new simulations; grompp warns. Use pcoupl = C-rescale, which also suits equilibration.');
    }
    if (this.epc === 'ISOTROPIC') {
      this.add('note', 'pcoupl-isotropic', 'pcoupl', 'pcoupl = isotropic is the old spelling of Berendsen; grompp reads it as Berendsen.');
      this.epc = 'BERENDSEN';
    }
    if (this.epc === 'CRESCALE' && !['ISOTROPIC', 'SEMIISOTROPIC', 'SURFACETENSION'].includes(key(v.pcoupltype))) {
      this.add('error', 'crescale-type', 'pcoupltype', `C-rescale does not support pcoupltype = ${v.pcoupltype} yet; use Parrinello-Rahman for anisotropic coupling.`);
    }
    if (this.epc !== 'NO') {
      // check_ir keeps nstpcouple x dt in a real (single precision).
      const dtP = f32(this.nstpcouple * v.dt);
      if (v['tau-p'] <= 0) this.add('error', 'tau-p', 'tau-p', 'tau-p must be larger than 0.');
      const min = ['BERENDSEN', 'CRESCALE', 'ISOTROPIC'].includes(this.epc) ? MIN_STEPS_PER_TAU : MIN_STEPS_PER_PERIOD;
      if (f32(f32(v['tau-p']) / dtP) < min - 10 * GMX_REAL_EPS) {
        this.add('warning', 'tau-p-short', 'tau-p', `tau-p (${v['tau-p']} ps) should be at least ${min} times nstpcouple x dt ` +
          `(${fmt(dtP)} ps) for ${v.pcoupl} to be integrated properly. Increase tau-p or lower nstpcouple.`);
      }
      const c = this.compress;
      const trace = c[0][0] + c[1][1] + c[2][2];
      if (c[0][0] < 0 || c[1][1] < 0 || c[2][2] < 0 || (trace === 0 && c[1][0] <= 0 && c[2][0] <= 0 && c[2][1] <= 0)) {
        this.add('error', 'compressibility', 'compressibility', 'With pressure coupling the compressibility must be above 0 ' +
          '(4.5e-5 bar^-1 for water).', { line: this.set.compressibility ? this.set.compressibility.line : (this.set.pcoupl ? this.set.pcoupl.line : null) });
      }
      if (this.epc === 'PARRINELLORAHMAN' && v['gen-vel'] === 'yes') {
        this.add('warning', 'pr-genvel', 'pcoupl', 'Parrinello-Rahman with gen-vel = yes: new velocities mean an unequilibrated system, ' +
          'where Parrinello-Rahman can oscillate strongly. Equilibrate with C-rescale first. grompp warns.');
      }
    }
    if (!EI.VV(I) && this.epc === 'MTTK') this.add('error', 'mttk-integrator', 'pcoupl', 'MTTK pressure coupling needs integrator md-vv.');

    // Electrostatics
    let epsR = v['epsilon-r'];
    let epsRf = v['epsilon-rf'];
    if (ct === 'SWITCH') {
      this.add('warning', 'coulomb-switch', 'coulombtype', 'coulombtype = Switch is for testing and can cause serious artefacts; use Reaction-Field-zero or PME.');
    }
    if (COULOMB.RF(ct) && epsRf === 1 && epsR !== 1) {
      this.add('warning', 'epsilon-swapped', 'epsilon-rf', `epsilon-r = ${epsR} with epsilon-rf = 1 looks like the old convention; grompp swaps them and warns. ` +
        'Set epsilon-rf to the dielectric constant beyond the cut-off (0 for infinity) instead.');
      epsRf = epsR;
      epsR = 1;
    }
    if (epsR === 0 && COULOMB.FULL(ct)) {
      this.add('error', 'epsilon-r-infinite', 'epsilon-r', 'epsilon-r = 0 (infinite) switches electrostatics off; long-range electrostatics are then pointless.');
    }
    if (epsR < 0) this.add('error', 'epsilon-r-negative', 'epsilon-r', 'epsilon-r cannot be negative.');
    if (COULOMB.RF(ct)) {
      if (ct === 'REACTIONFIELDZERO' && epsRf !== 0) {
        this.add('warning', 'rf-zero-epsilon', 'epsilon-rf', 'With Reaction-Field-zero, epsilon-rf must be 0; grompp assumes it is.');
        epsRf = 0;
      }
      if ((epsRf < epsR && epsRf !== 0) || epsR === 0) {
        this.add('error', 'epsilon-rf', 'epsilon-rf', 'epsilon-rf must be at least epsilon-r (or 0, meaning infinity).');
      }
      if (epsRf === epsR) {
        this.add('warning', 'epsilon-rf-equal', 'epsilon-rf', 'epsilon-rf equal to epsilon-r makes the reaction field pointless.');
      }
    }
    const coulSwitched = ['SWITCH', 'SHIFT', 'PMESWITCH', 'PMEUSERSWITCH'].includes(ct) || cmod === 'POTENTIALSWITCH' || cmod === 'FORCESWITCH';
    if (coulSwitched && v['rcoulomb-switch'] >= v.rcoulomb) {
      this.add('error', 'rcoulomb-switch', 'rcoulomb-switch', 'rcoulomb-switch must be smaller than rcoulomb.');
    }
    if ((ct === 'SWITCH' || ct === 'SHIFT') && cmod !== 'NONE') {
      this.add('error', 'coulomb-switch-modifier', 'coulomb-modifier', 'Switch and Shift electrostatics cannot be combined with a coulomb-modifier.');
    }
    if ((vt === 'SWITCH' || vt === 'SHIFT') && vmod !== 'NONE') {
      this.add('error', 'vdw-switch-modifier', 'vdw-modifier', 'Switch and Shift van der Waals cannot be combined with a vdw-modifier.');
    }
    if (ct === 'SWITCH' || ct === 'SHIFT' || vt === 'SWITCH' || vt === 'SHIFT') {
      this.add('note', 'switch-shift-legacy', 'vdwtype', 'The switch/shift interaction types are kept for compatibility; potential modifiers are faster.');
    }
    if ((ct === 'PMESWITCH' || cmod === 'POTENTIALSWITCH') && v['rcoulomb-switch'] / v.rcoulomb < 0.9499) {
      this.add('warning', 'coulomb-switch-range', 'rcoulomb-switch', 'The Coulomb switching range should be 5% of the cut-off or less for accurate energies.');
    }
    if ((vt === 'SWITCH' || vmod === 'POTENTIALSWITCH') && v['rvdw-switch'] === 0) {
      this.add('warning', 'rvdw-switch-zero', 'rvdw-switch', 'rvdw-switch is 0 with a switched Lennard-Jones potential, which suggests it was ' +
        'forgotten and can cause large energy errors. 0.05 to 0.1 nm below rvdw is usual.');
    }
    if (['PMESWITCH', 'PMEUSER', 'PMEUSERSWITCH'].includes(ct) && v.rcoulomb > rlist) {
      this.add('error', 'rcoulomb-rlist', 'rcoulomb', `With coulombtype = ${v.coulombtype}, rcoulomb must not exceed rlist.`);
    }
    if (COULOMB.PME(ct) || vt === 'PME') {
      const max = ct === 'P3MAD' ? 8 : 12;
      if (v['pme-order'] < 3 || v['pme-order'] > max) {
        this.add('error', 'pme-order', 'pme-order', `pme-order must be between 3 and ${max}.`);
      }
    }
    if (v.nwall === 2 && COULOMB.FULL(ct)) {
      if (key(v['ewald-geometry']) === '3D') this.add('warning', 'walls-ewald-geometry', 'ewald-geometry', 'With two walls use ewald-geometry = 3dc.');
      if (v['wall-ewald-zfac'] < 2) this.add('error', 'wall-ewald-zfac', 'wall-ewald-zfac', 'wall-ewald-zfac must be at least 2.');
    }
    if (key(v['ewald-geometry']) === '3DC' && pbc !== 'XY' && COULOMB.FULL(ct)) {
      this.add('warning', 'ewald-3dc-pbc', 'ewald-geometry', 'ewald-geometry = 3dc is meant for pbc = xy (a slab between walls).');
    }
    if (v['epsilon-surface'] !== 0 && COULOMB.FULL(ct)) {
      if (v['periodic-molecules'] === 'yes') this.add('error', 'epsilon-surface-periodic', 'epsilon-surface', 'epsilon-surface cannot be used with periodic molecules.');
      this.add('note', 'epsilon-surface-neutral', 'epsilon-surface', 'With epsilon-surface above 0 every molecule should be neutral.');
      this.add('note', 'epsilon-surface-dd', 'epsilon-surface', 'With epsilon-surface above 0, domain decomposition works only with small molecules ' +
        'whose bonds are all constrained.');
    }
    const vdwSwitched = vt === 'SWITCH' || vt === 'SHIFT' || vmod === 'POTENTIALSWITCH' || vmod === 'FORCESWITCH';
    if (vdwSwitched) {
      if (v['rvdw-switch'] >= v.rvdw) this.add('error', 'rvdw-switch-range', 'rvdw-switch', `rvdw-switch (${v['rvdw-switch']}) must be smaller than rvdw (${v.rvdw}).`);
      if (v['rvdw-switch'] < 0.5 * v.rvdw) {
        this.add('note', 'rvdw-switch-wide', 'rvdw-switch', `The switch runs from ${v['rvdw-switch']} to ${v.rvdw} nm, more than half the cut-off; ` +
          'switching is meant to act only near the cut-off.');
      }
    }
    if (vt === 'PME' && !(vmod === 'NONE' || vmod === 'POTENTIALSHIFT')) {
      this.add('error', 'ljpme-modifier', 'vdw-modifier', 'With vdwtype = PME only Potential-shift or None is supported as vdw-modifier.');
    }
    if (vt === 'USER' && key(v.DispCorr) !== 'NO') {
      this.add('note', 'user-dispcorr', 'DispCorr', 'User tables with dispersion correction: the dispersion is corrected as -C6/r^6 beyond rvdw-switch.');
    }
    if (I === 'LBFGS' && (ct === 'CUTOFF' || vt === 'CUTOFF') && v.rvdw !== 0) {
      this.add('warning', 'lbfgs-cutoff', 'integrator', 'L-BFGS minimisation is inefficient with plain cut-offs; use PME or switched interactions.');
    }
    if (I === 'LBFGS' && v.nbfgscorr <= 0) this.add('warning', 'lbfgs-nbfgscorr', 'nbfgscorr', 'L-BFGS with nbfgscorr <= 0 is just steepest descent.');
    if (ct === 'GENERALIZEDBORN(UNUSED)') this.add('error', 'coulombtype-gb', 'coulombtype', 'Generalized-Born is not a valid coulombtype.');
    if (v.QMMM === 'yes') {
      this.add('error', 'qmmm-removed', 'QMMM', 'The QM/MM interface this switched on was removed. Use integrator = mimic for MiMiC, or qmmm-cp2k-active = true for CP2K.');
    }
    if (v['cos-acceleration'] !== 0 && I !== 'MD') this.add('error', 'cos-acceleration', 'cos-acceleration', 'cos-acceleration works only with integrator = md.');
    if (this.haveDeform && v['deform-init-flow'] !== 'yes') {
      if (v['gen-vel'] === 'yes') {
        this.add('error', 'deform-genvel', 'deform-init-flow', 'The box is deformed and velocities are generated: set deform-init-flow = yes so the flow profile is set up.');
      } else if (v.continuation !== 'yes') {
        this.add('note', 'deform-init-flow', 'deform-init-flow', 'Unless the starting velocities already follow the flow, set deform-init-flow = yes with deform.');
      }
    }
    this.nhchain = nhchain;
    this.epsR = epsR;
    this.epsRf = epsRf;
  }

  checkNst(nstcalcenergy, name) {
    const val = this.v[name];
    if (val > 0 && val % nstcalcenergy !== 0) {
      const up = (Math.floor(val / nstcalcenergy) + 1) * nstcalcenergy;
      this.add('warning', `${name}-multiple`, name, `${name} (${val}) should be a multiple of nstcalcenergy (${nstcalcenergy}); ` +
        `grompp changes it to ${up} and warns. Use a multiple of ${nstcalcenergy}.`);
      this.v[name] = up;
    }
  }

  /* ir_optimal_nstpcouple and ir_optimal_nsttcouple (inputrec.cpp). */
  optimalNstpcouple() {
    const v = this.v;
    const min = ['BERENDSEN', 'CRESCALE', 'ISOTROPIC'].includes(this.epc) ? MIN_STEPS_PER_TAU : this.epc === 'NO' ? 0 : MIN_STEPS_PER_PERIOD;
    const wanted = 100;
    const minNst = this.useMts && this.validMts ? this.mtsFactor : 1;
    let n;
    // delta_t is a double in GROMACS; tau-p is single precision (real).
    const dt = Number(v.dt);
    const tauP = f32(v['tau-p']);
    if (min === 0 || wanted * dt <= f32(tauP / min)) {
      n = wanted;
    } else {
      n = Math.floor(tauP / (dt * min) + 0.001);
      if (n < minNst) n = minNst;
      if (!(this.useMts && this.validMts)) while (wanted % n !== 0) n -= 1;
    }
    if (this.useMts && this.validMts) n -= n % minNst;
    return n;
  }

  optimalNsttcouple(tauMin) {
    const min = this.etc === 'NOSEHOOVER' ? MIN_STEPS_PER_PERIOD : ['BERENDSEN', 'VRESCALE', 'YES'].includes(this.etc) ? MIN_STEPS_PER_TAU
      : this.etc === 'NO' ? 0 : 1;
    const wanted = 100;
    const dt = Number(this.v.dt);
    if (min === 0 || dt * wanted <= f32(tauMin / min)) return wanted;
    let n = Math.floor(tauMin / (dt * min) + 0.001);
    if (n < 1) n = 1;
    while (wanted % n !== 0) n -= 1;
    return n;
  }

  simulatedTempering() {
    const v = this.v;
    const temps = this.lambdas.arrays['temperature-lambdas'] || [];
    if (temps.some(t => t < 0)) this.add('error', 'simtemp-lambda', 'temperature-lambdas', 'temperature-lambdas cannot be negative.');
    if (temps.some(t => t > 1)) {
      this.add('warning', 'simtemp-lambda-large', 'temperature-lambdas', 'Some temperature-lambdas are above 1; use this only if you know why.');
    }
    if (!temps.some(t => t > 0)) this.add('error', 'simtemp-lambda-zero', 'temperature-lambdas', 'With simulated tempering, temperature-lambdas cannot all be 0.');
    if (this.I !== 'MDVV') this.add('error', 'simtemp-integrator', 'integrator', 'Simulated tempering works only with integrator = md-vv.');
    if (this.etc === 'NOSEHOOVER') this.add('note', 'simtemp-nh', 'tcoupl', 'Nose-Hoover may not be entirely consistent with simulated tempering.');
    if (v['sim-temp-high'] <= v['sim-temp-low']) this.add('error', 'simtemp-range', 'sim-temp-high', 'sim-temp-high must be above sim-temp-low.');
    if (v['sim-temp-high'] <= 0) this.add('error', 'simtemp-range', 'sim-temp-high', 'sim-temp-high must be above 0.');
    if (v['sim-temp-low'] <= 0) this.add('error', 'simtemp-range', 'sim-temp-low', 'sim-temp-low must be above 0.');
  }

  freeEnergy() {
    const v = this.v;
    const n = this.lambdas.n;
    const alpha = v['sc-alpha'];
    const gapsys = key(v['sc-function']) === 'GAPSYS';
    const softcore = alpha > 0 || gapsys;
    if (alpha !== 0 && v['sc-power'] !== 1 && v['sc-power'] !== 2) this.add('error', 'sc-power', 'sc-power', 'sc-power must be 1 or 2.');
    if (alpha !== 0 && v['sc-r-power'] !== 6) this.add('error', 'sc-r-power', 'sc-r-power', 'sc-r-power must be 6 (48 is no longer supported).');
    const init = v['init-lambda'];
    const dl = v['delta-lambda'];
    const state = v['init-lambda-state'];
    if (dl < 0 && init > 1 && n <= 0 && softcore) {
      this.add('error', 'init-lambda-softcore', 'init-lambda', 'init-lambda above 1 with no lambda arrays makes coul- and vdw-lambdas exceed 1, which soft-core cannot handle.');
    }
    if (dl !== 0) {
      if (state >= 0 && state < n) {
        let capAt = v.nsteps;
        const mult = (n - 1) * dl;
        if (dl > 0) capAt = Math.round((n - 1 - state) / mult);
        else if (dl < 0) capAt = Math.round((0 - state) / mult);
        if (capAt < v.nsteps || v.nsteps < 0) {
          this.add('warning', 'delta-lambda-cap', 'delta-lambda', `With init-lambda-state = ${state} and delta-lambda = ${dl}, lambda stops changing after step ${capAt}.`);
        }
      } else if (init >= 0) {
        let capAt = v.nsteps;
        if (dl > 0) {
          capAt = Math.round(Math.max((1 - init) / dl, 0));
          if ((capAt < v.nsteps || v.nsteps < 0) && n <= 0) {
            if (softcore) this.add('error', 'delta-lambda-softcore', 'delta-lambda', 'lambda would exceed 1 during the run with no lambda arrays, which soft-core cannot handle.');
            capAt = v.nsteps;
          }
        } else if (dl < 0) {
          capAt = Math.round((0 - init) / dl);
        }
        if (capAt < v.nsteps || (v.nsteps < 0 && !(dl > 0 && n <= 0))) {
          this.add('warning', 'delta-lambda-cap', 'delta-lambda', `With init-lambda = ${init} and delta-lambda = ${dl}, lambda stops changing after step ${capAt}.`);
        }
      } else if (n === 1) {
        this.add('warning', 'delta-lambda-one', 'delta-lambda', 'delta-lambda has no effect with lambda arrays of one column.');
      }
    }
    if (dl > 0 && this.efep === 'EXPANDED') this.add('error', 'expanded-delta-lambda', 'delta-lambda', 'Expanded ensemble cannot use a positive delta-lambda.');
    if (!EI.VV(this.I) && this.efep === 'EXPANDED') this.add('error', 'expanded-integrator', 'integrator', 'Expanded ensemble works only with integrator = md-vv.');
    if (this.ct === 'EWALD') this.add('error', 'fep-ewald', 'coulombtype', 'Free-energy calculations are not implemented with Ewald; use PME.');
    if (n === 0) {
      if (state >= 0) this.add('error', 'lambda-state-none', 'init-lambda-state', `init-lambda-state = ${state}, but no lambda arrays are given.`);
    } else if (state >= n) {
      this.add('error', 'lambda-state-range', 'init-lambda-state', `init-lambda-state = ${state} does not exist: the lambda arrays have ${n} columns (0 to ${n - 1}).`);
    }
    if (state < 0 && init < 0) {
      this.add('error', 'lambda-unset', 'init-lambda-state', 'Set the lambda state, with init-lambda-state (usual) or init-lambda.');
    }
    if (state >= 0 && init >= 0) {
      this.add('error', 'lambda-both', 'init-lambda', 'Set the lambda state with init-lambda-state or with init-lambda, not both.');
    }
    if (init >= 0 && dl === 0) {
      const given = ['mass-lambdas', 'coul-lambdas', 'vdw-lambdas', 'bonded-lambdas', 'restraint-lambdas', 'fep-lambdas']
        .filter(x => words(v[x]).length).length;
      if (given > 1) {
        this.add('warning', 'init-lambda-vectors', 'init-lambda', 'With lambda vectors, set the state with init-lambda-state, not init-lambda.');
      } else if (n > 0) {
        this.add('note', 'init-lambda-deprecated', 'init-lambda', 'init-lambda is deprecated for choosing a lambda state; use init-lambda-state.');
      }
    }
    const arrays = this.lambdas.arrays;
    for (const [nm, list] of Object.entries(arrays)) {
      if ((nm === 'coul-lambdas' || nm === 'vdw-lambdas') && softcore) {
        list.forEach((x, i) => { if (x < 0 || x > 1) this.add('error', 'lambda-range', nm, `With soft-core, entry ${i} of ${nm} must be between 0 and 1; it is ${x}.`); });
      } else {
        list.forEach((x, i) => { if (x < 0) this.add('error', 'lambda-range', nm, `Entry ${i} of ${nm} cannot be negative (${x}).`); });
      }
    }
    const scCoul = v['sc-coul'] === 'yes' || (alpha > 0 && !['mass-lambdas', 'coul-lambdas', 'vdw-lambdas', 'bonded-lambdas', 'restraint-lambdas', 'temperature-lambdas']
      .some(x => words(v[x]).length));
    const beutlerBad = !gapsys && alpha > 0 && !scCoul;
    const gapsysBad = gapsys && v['sc-gapsys-scale-linpoint-lj'] > 0 && v['sc-gapsys-scale-linpoint-q'] === 0;
    if ((beutlerBad || gapsysBad) && alpha > 0) {
      const cl = arrays['coul-lambdas'] || [];
      const vl = arrays['vdw-lambdas'] || [];
      for (let i = 0; i < n; i++) {
        if (cl[i] > 0 && cl[i] < 1 && vl[i] > 0 && vl[i] < 1) {
          this.add('error', 'softcore-both-changing', 'coul-lambdas', `In state ${i} both vdw-lambdas and coul-lambdas change while only ` +
            'van der Waals interactions are soft-cored: this crashes. Change them in separate states or set sc-coul = yes.');
        }
      }
    }
    if (!gapsys && scCoul && COULOMB.PME(this.ct)) {
      this.add('note', 'softcore-pme', 'sc-coul', 'With PME, soft-cored Coulomb interactions have a small effect at the cut-off; usually negligible.');
    }
    if (gapsys) {
      if (v['sc-gapsys-scale-linpoint-q'] < 0) this.add('note', 'gapsys-q', 'sc-gapsys-scale-linpoint-q', 'sc-gapsys-scale-linpoint-q must be 0 or more.');
      const lj = v['sc-gapsys-scale-linpoint-lj'];
      if (lj < 0 || lj >= 1) this.add('note', 'gapsys-lj', 'sc-gapsys-scale-linpoint-lj', 'sc-gapsys-scale-linpoint-lj must be at least 0 and below 1.');
    }
  }

  expandedEnsemble() {
    const v = this.v;
    const eq = key(v['lmc-weights-equil']);
    const pairs = [
      ['weight-equil-number-all-lambda', 'NUMBERALLLAMBDA', 'number-all-lambda'],
      ['weight-equil-number-samples', 'NUMBERSAMPLES', 'number-samples'],
      ['weight-equil-number-steps', 'NUMBERSTEPS', 'number-steps'],
      ['weight-equil-wl-delta', 'WLDELTA', 'wl-delta'],
      ['weight-equil-count-ratio', 'COUNTRATIO', 'count-ratio']
    ];
    for (const [n, k, label] of pairs) {
      if (v[n] > 0 && eq !== k) this.add('error', 'weight-equil-ignored', n, `${n} is ignored unless lmc-weights-equil = ${label}; remove it or set lmc-weights-equil.`);
      if (v[n] <= 0 && eq === k) this.add('error', 'weight-equil-missing', n, `lmc-weights-equil = ${label} needs ${n} above 0.`);
    }
    if (eq === 'WLDELTA' && !['WANGLANDAU', 'WEIGHTEDWANGLANDAU'].includes(key(v['lmc-stats']))) {
      this.add('error', 'weight-equil-wl', 'lmc-weights-equil', 'lmc-weights-equil = wl-delta needs lmc-stats = wang-landau or weighted-wang-landau.');
    }
    if (v['lmc-repeats'] <= 0) this.add('error', 'lmc-repeats', 'lmc-repeats', 'lmc-repeats must be above 0.');
    if (v['mininum-var-min'] <= 0) this.add('error', 'minvar-min', 'mininum-var-min', 'mininum-var-min must be above 0.');
    if (v['weight-c-range'] < 0) this.add('error', 'weight-c-range', 'weight-c-range', 'weight-c-range cannot be negative.');
    const state = v['init-lambda-state'];
    if (state !== 0 && v['lmc-forced-nstart'] > 0 && key(v['lmc-move']) !== 'NO') {
      this.add('error', 'lmc-forced-nstart-state', 'init-lambda-state', 'With lmc-forced-nstart above 0, init-lambda-state must be 0.');
    }
    if (v['lmc-forced-nstart'] < 0) this.add('error', 'lmc-forced-nstart', 'lmc-forced-nstart', 'lmc-forced-nstart cannot be negative.');
    if (state < 0 || state >= this.lambdas.n) {
      this.add('error', 'expanded-state', 'init-lambda-state', 'init-lambda-state must be between 0 and the number of lambda states minus 1.');
    }
    if (v['init-wl-delta'] < 0) this.add('error', 'init-wl-delta', 'init-wl-delta', 'init-wl-delta cannot be negative.');
    if (v['wl-ratio'] <= 0 || v['wl-ratio'] >= 1) this.add('error', 'wl-ratio', 'wl-ratio', 'wl-ratio must be between 0 and 1.');
    if (v['wl-scale'] <= 0 || v['wl-scale'] >= 1) this.add('error', 'wl-scale', 'wl-scale', 'wl-scale must be between 0 and 1.');
    const hasRefT = this.etc !== 'NO' || EI.RANDOM(this.I) || EI.TPI(this.I);
    if (!hasRefT && key(v['lmc-move']) !== 'NO' && v['mc-temperature'] <= 0) {
      this.add('error', 'mc-temperature', 'mc-temperature', 'Without a thermostat, Monte Carlo moves need mc-temperature above 0.');
    }
    if (v['nst-transition-matrix'] > 0) {
      if (v.nstlog === 0) this.add('error', 'nstlog-zero', 'nstlog', 'nst-transition-matrix needs nstlog above 0.');
      else if (v['nst-transition-matrix'] % v.nstlog !== 0) {
        this.add('error', 'nst-transition-matrix', 'nst-transition-matrix', 'nst-transition-matrix must be a multiple of nstlog.');
      }
    }
  }

  /* ---- grompp.cpp, between check_ir and do_index ---- */

  /* grompp.cpp from check_ir to the first check_warning_error. */
  gromppEarly() {
    const v = this.v;
    const I = this.I;
    const ctx = this.ctx;
    if (EI.STATE_VELOCITY(I) && v['gen-vel'] === 'yes' && v.continuation === 'yes') {
      this.add('error', 'genvel-continuation', 'gen-vel', 'gen-vel = yes and continuation = yes contradict each other: new velocities mean a new ' +
        'start. Choose one; when continuing from a checkpoint, use gen-vel = no.');
    }
    const rigidWater = ctx.rigidWater !== false;
    const constrained = this.nshake > 0 || rigidWater;
    if (constrained && key(v['constraint-algorithm']) === 'SHAKE') {
      if (I === 'CG' || I === 'LBFGS') {
        this.add('error', 'shake-minimiser', 'constraint-algorithm', `${v.integrator} cannot be used with SHAKE; use LINCS.`,
          { assumes: this.nshake > 0 ? undefined : 'the topology has rigid (SETTLE) water' });
      }
      if (v['periodic-molecules'] === 'yes') this.add('error', 'shake-periodic', 'constraint-algorithm', 'SHAKE does not work with periodic molecules; use LINCS.');
    }
    // Raised while reading the topology (topio.cpp and grompp.cpp): known
    // only when the caller says which force field the topology uses.
    const ffid = String(ctx.forceField || '').toLowerCase();
    if (/gromos/.test(ffid)) {
      this.add('warning', 'gromos-twin-range', null, 'grompp warns for every GROMOS topology: GROMOS was parametrised with a ' +
        'twin-range cut-off scheme GROMACS no longer has, so properties such as the density may differ. No .mdp setting avoids ' +
        'it; after reading it, run grompp with -maxwarn 1.', { assumes: 'the topology uses a GROMOS force field', line: null });
    }
    if (/amber|charmm|opls/.test(ffid) && key(v.constraints) === 'ALLBONDS' && v.dt < 0.0026) {
      this.add('note', 'all-bonds-ff', 'constraints', 'This force field was parametrised with only bonds to hydrogen constrained; ' +
        'constraints = h-bonds is better and faster.', { assumes: 'the topology uses an AMBER, CHARMM or OPLS force field' });
    }
    this.posres = ctx.posres !== undefined ? !!ctx.posres : /(^|\s)-DPOSRES(\s|=|$)/.test(String(v.define || ''));
    this.posresAssumed = ctx.posres === undefined;
    // gmxcpp.cpp: every -D macro must be used by the topology.
    const macros = words(v.define).map(w => /^-D([A-Za-z_]\w*)/.exec(w)).filter(Boolean).map(m => m[1]);
    const unused = Array.isArray(ctx.usedMacros) ? macros.filter(m => !ctx.usedMacros.includes(m))
      : ctx.posres === false ? macros.filter(m => m === 'POSRES') : [];
    if (unused.length) {
      this.add('warning', 'define-unused', 'define', `The topology does not use ${unused.map(m => `-D${m}`).join(', ')}; grompp ` +
        `warns about macros defined but never used. ${unused.includes('POSRES') ? 'Remove -DPOSRES when the topology has no position restraints.' : 'Remove it or check its spelling.'}`,
        { assumes: Array.isArray(ctx.usedMacros) ? 'the topology uses only the macros listed' : 'the topology has no position restraints' });
    }
  }

  /* grompp.cpp between the two check_warning_error calls. */
  gromppChecks() {
    const v = this.v;
    const I = this.I;
    const ctx = this.ctx;
    if (this.posres && (this.epc === 'PARRINELLORAHMAN' || this.epc === 'MTTK')) {
      this.add('note', 'posres-pr', 'pcoupl', `Position restraints with ${v.pcoupl} pressure coupling can be unstable; C-rescale is ` +
        'the suggested barostat with restraints.', this.assumePosres());
    }
    if (v['mass-repartition-factor'] < 1) this.add('error', 'mass-repartition', 'mass-repartition-factor', 'mass-repartition-factor must be 1 or more.');
    if (EI.DYNAMICS(I) && I !== 'BD') this.timeStepEstimate();
    if (EI.EM(I) && v.nsteps === 0) {
      this.add('note', 'em-zero-steps', 'nsteps', 'A zero-step minimisation still changes the coordinates; for the energy of one structure use ' +
        'zero-step MD with continuation = yes, or mdrun -rerun.');
    }
  }

  assumePosres() {
    return this.posresAssumed ? { assumes: this.posres ? 'define contains -DPOSRES, so the topology has position restraints'
      : 'no -DPOSRES, so no position restraints' } : {};
  }

  /*
   * check_bonds_timestep needs the topology. For an all-atom topology the
   * fastest bonds are X-H (period about 9 fs) and, with those constrained,
   * C=O and C-N (about 24 fs); grompp notes a period under 10 dt and warns
   * under 5 dt.
   */
  timeStepEstimate() {
    const v = this.v;
    const system = this.ctx.system || 'all-atom';
    if (system !== 'all-atom') return;
    const dt = v.dt;
    const factor = v['mass-repartition-factor'];
    let period;
    let what;
    if (this.nshake === 0) {
      period = factor >= 2 ? 0.0125 * Math.sqrt(Math.min(factor, 4) / 2) : 0.009;
      what = 'bonds to hydrogen (about 9 fs)';
    } else if (key(v.constraints) === 'HBONDS') {
      period = 0.0238;
      what = 'C=O bonds (about 24 fs)';
    } else {
      return;
    }
    const assumes = { assumes: 'an all-atom topology (estimated from typical bond constants)' };
    if (period < 5 * dt) {
      this.add('warning', 'bond-period', 'dt', `dt = ${dt} ps is too long for ${what}: grompp warns when a bond period is under ` +
        `5 time steps. ${this.nshake === 0 ? 'Set constraints = h-bonds.' : 'Use a shorter dt.'}`, assumes);
    } else if (period < 10 * dt) {
      this.add('note', 'bond-period', 'dt', `dt = ${dt} ps: grompp notes that ${what} oscillate in under 10 time steps. ` +
        (this.nshake === 0 ? 'Consider constraints = h-bonds.' : 'This is expected with a 4 fs step and hydrogen mass repartitioning.'), assumes);
    }
    if (dt > 0.0025 && this.nshake > 0 && factor < 2 && key(v.constraints) === 'HBONDS') {
      this.add('warning', 'dt-without-hmr', 'dt', `dt = ${dt} ps with only bonds to hydrogen constrained is unstable: angles involving ` +
        'hydrogen are too fast. Use dt = 0.002, or mass-repartition-factor = 3 for dt = 0.004.', { source: 'advice' });
    }
  }

  /* ---- do_index: groups, temperature coupling and annealing ---- */

  indexChecks() {
    const v = this.v;
    const I = this.I;
    const tcg = words(v['tc-grps']);
    const tau = words(v['tau-t']);
    const reft = words(v['ref-t']);
    this.ngtc = tcg.length;
    // grompp's errors in do_index are fatal: it stops at the first one.
    if (tau.length !== tcg.length || reft.length !== tcg.length) {
      this.add('error', 'tc-count', tau.length !== tcg.length ? 'tau-t' : 'ref-t',
        `tc-grps has ${tcg.length} group${tcg.length === 1 ? '' : 's'}, ref-t ${reft.length} value${reft.length === 1 ? '' : 's'} and ` +
        `tau-t ${tau.length}: each group needs one ref-t and one tau-t. grompp stops.`);
      return;
    }
    const hasRefT = this.etc !== 'NO' || EI.RANDOM(I) || EI.TPI(I);
    this.hasRefT = hasRefT;
    if (hasRefT && tcg.length === 0) {
      const why = this.etc !== 'NO' ? `tcoupl = ${v.tcoupl}` : `integrator = ${v.integrator}`;
      this.add('error', 'tc-grps-missing', 'tc-grps', `${why} needs temperature-coupling groups: set tc-grps (for example System, ` +
        'or Protein Non-Protein) with one tau-t and ref-t each. Without them grompp stops: "atoms are not part of any of the T-Coupling groups".',
        { line: this.set.tcoupl ? this.set.tcoupl.line : this.set.integrator ? this.set.integrator.line : null });
      return;
    }
    this.taus = tau.map(w => strictReal(w));
    this.refts = reft.map(w => strictReal(w));
    if (this.ctx.indexGroups) this.groupNames();
    this.tauMax = 0;
    this.refMax = 0;
    if (hasRefT && tcg.length && tau.length === tcg.length && reft.length === tcg.length) {
      if (this.taus.some(x => x === null)) this.add('error', 'tau-t-number', 'tau-t', 'tau-t should hold only numbers separated by spaces.');
      if (this.refts.some(x => x === null)) this.add('error', 'ref-t-number', 'ref-t', 'ref-t should hold only numbers separated by spaces.');
      let tauMin = 1e20;
      this.taus.forEach((t) => {
        if (t === null) return;
        if (I === 'BD' && t <= 0) this.add('error', 'bd-tau-t', 'tau-t', 'With integrator = bd every tau-t must be above 0.');
        if (this.etc !== 'VRESCALE' && t === 0) {
          this.add('note', 'tau-t-zero', 'tau-t', 'tau-t = -1 is how a group is left uncoupled; tau-t = 0 is treated as -1.');
        }
        if (t >= 0) tauMin = Math.min(tauMin, f32(t));
      });
      this.nsttcouple = v.nsttcouple;
      if (this.etc !== 'NO' && this.nsttcouple === -1) this.nsttcouple = this.optimalNsttcouple(tauMin);
      if (EI.VV(I)) {
        if (this.etc === 'NOSEHOOVER' && this.epc === 'BERENDSEN') {
          this.add('error', 'vv-nh-berendsen', 'pcoupl', 'md-vv cannot combine Nose-Hoover with Berendsen pressure coupling.');
        }
        if (this.epc === 'MTTK') {
          this.add('note', 'mttk-deprecated', 'pcoupl', 'MTTK coupling is deprecated and will soon be removed.');
          if (this.etc !== 'NOSEHOOVER') this.add('error', 'mttk-nh', 'tcoupl', 'MTTK pressure coupling needs Nose-Hoover temperature coupling.');
          else if (this.nstpcouple !== this.nsttcouple) {
            this.add('note', 'mttk-nst', 'nstpcouple', 'With md-vv, nsttcouple and nstpcouple must be equal; grompp sets both to the smaller.');
          }
        }
      }
      if ((this.etc === 'ANDERSEN' || this.etc === 'ANDERSENMASSIVE') && this.nsttcouple !== 1) {
        this.add('note', 'andersen-nsttcouple', 'nsttcouple', 'Andersen coupling assumes nsttcouple = 1; grompp sets it.');
        this.nsttcouple = 1;
      }
      const nstcmin = this.etc === 'NOSEHOOVER' ? MIN_STEPS_PER_PERIOD : ['BERENDSEN', 'VRESCALE'].includes(this.etc) ? MIN_STEPS_PER_TAU : 1;
      if (nstcmin > 1 && this.etc !== 'VRESCALE' && tauMin < 1e20) {
        if (tauMin / (v.dt * this.nsttcouple) < nstcmin - 10 * GMX_REAL_EPS) {
          this.add('warning', 'tau-t-short', 'tau-t', `tau-t (${tauMin} ps) should be at least ${nstcmin} times nsttcouple x dt ` +
            `(${fmt(this.nsttcouple * v.dt)} ps) for ${v.tcoupl} to be integrated properly.`);
        }
      }
      if (this.refts.some(x => x !== null && x < 0)) {
        this.add('error', 'ref-t-negative', 'ref-t', 'ref-t cannot be negative. grompp stops.');
        return;
      }
      this.tauMax = Math.max(0, ...this.taus.filter(x => x !== null));
      this.refMax = Math.max(0, ...this.refts.filter(x => x !== null));
    } else {
      this.nsttcouple = v.nsttcouple;
    }

    this.annealing(tcg.length);
    if (this.hasErrors()) return;

    // Acceleration and freezing
    const acc = words(v['acc-grps']);
    const accVals = words(v.accelerate);
    if (acc.length * 3 !== accVals.length) {
      this.add('error', 'accelerate-count', 'accelerate', `acc-grps has ${acc.length} group${acc.length === 1 ? '' : 's'}, so accelerate needs ` +
        `${acc.length * 3} numbers (x y z for each); it has ${accVals.length}. grompp stops.`);
    }
    this.useAcceleration = accVals.some(w => strictReal(w));
    const frz = words(v.freezegrps);
    const frzDim = words(v.freezedim);
    if (frzDim.length !== frz.length * 3) {
      this.add('error', 'freezedim-count', 'freezedim', `freezegrps has ${frz.length} group${frz.length === 1 ? '' : 's'}, so freezedim needs ` +
        `${frz.length * 3} entries (Y or N for x, y and z of each); it has ${frzDim.length}. grompp stops.`);
    } else {
      const bad = frzDim.find(w => !/^[YN]/i.test(w));
      if (bad) this.add('warning', 'freezedim-value', 'freezedim', `Use Y or N in freezedim, not "${bad}".`);
    }
    this.frozenAll = [0, 1, 2].map(d => frz.some((_, g) => /^y/i.test(frzDim[g * 3 + d] || '')));

    if (words(v['QMMM-grps']).length > 1) this.add('error', 'qmmm-groups', 'QMMM-grps', 'MiMiC supports only one QM group.');
    if (words(v['energygrp-excl']).length) {
      this.add('error', 'energygrp-excl', 'energygrp-excl', 'Energy group exclusions are not supported with the Verlet scheme.');
      if (COULOMB.FULL(this.ct)) this.add('warning', 'energygrp-excl-ewald', 'energygrp-excl', 'The lattice Coulomb energy cannot be excluded between energy groups.');
    }
    if (words(v['energygrp-table']).length && !(this.vt === 'USER' || ['USER', 'PMEUSER', 'PMEUSERSWITCH'].includes(this.ct))) {
      this.add('error', 'energygrp-table', 'energygrp-table', 'Energy group tables need user tables for van der Waals or Coulomb. grompp stops.');
    }
    if (v['simulated-tempering'] === 'yes' && v.nstexpanded < 0) {
      this.add('warning', 'nstexpanded-unset', 'nstexpanded', 'nstexpanded is not set for simulated tempering; grompp uses 2 x tau-t / dt. Set it explicitly.');
    }

    // Ensemble temperature (processEnsembleTemperature)
    const setting = key(v['ensemble-temperature-setting']);
    const allCoupled = tcg.length > 0;
    let ens = 'NOTAVAILABLE';
    const equalRefT = this.refts.length > 0 && this.refts.every(x => x === this.refts[0]);
    if (setting === 'CONSTANT') {
      ens = 'CONSTANT';
      if (v['ensemble-temperature'] < 0) this.add('error', 'ensemble-temperature-negative', 'ensemble-temperature', 'ensemble-temperature cannot be negative.');
      else if (hasRefT && equalRefT && v['ensemble-temperature'] !== this.refts[0]) {
        this.add('warning', 'ensemble-temperature-mismatch', 'ensemble-temperature', 'ensemble-temperature differs from the reference temperature (ref-t).');
      }
    } else if (setting === 'VARIABLE') {
      ens = 'VARIABLE';
    } else if (setting === 'AUTO') {
      if (hasRefT) {
        if (!allCoupled) ens = 'NOTAVAILABLE';
        else if (this.anneals && tcg.length > 1) ens = 'NOTAVAILABLE';
        else if (this.anneals || v['simulated-tempering'] === 'yes') ens = 'VARIABLE';
        else ens = equalRefT ? 'CONSTANT' : 'NOTAVAILABLE';
      }
    }
    this.ensemble = ens;
    this.equalRefT = equalRefT;
  }

  groupNames() {
    const known = new Set(this.ctx.indexGroups.map(g => String(g).toLowerCase()));
    for (const n of ['tc-grps', 'comm-grps', 'energygrps', 'compressed-x-grps', 'acc-grps', 'freezegrps', 'user1-grps', 'user2-grps', 'QMMM-grps', 'orire-fitgrp']) {
      for (const g of words(this.v[n])) {
        if (!known.has(g.toLowerCase())) {
          this.add('error', 'group-unknown', n, `Group ${g} in ${n} is not in the index: group names must match [ moleculetype ] names, ` +
            'default groups or groups of the index file given to grompp -n.');
        }
      }
    }
  }

  annealing(ngtc) {
    const v = this.v;
    let types = words(v.annealing);
    if (types.length === 1 && /^n/i.test(types[0])) types = [];
    this.anneals = false;
    if (!types.length) return;
    if (types.length !== ngtc) {
      this.add('error', 'annealing-count', 'annealing', `annealing has ${types.length} entr${types.length === 1 ? 'y' : 'ies'} but tc-grps has ` +
        `${ngtc} group${ngtc === 1 ? '' : 's'}: give one (no, single or periodic) per group. grompp stops.`);
      return;
    }
    const kinds = types.map(t => (/^s/i.test(t) ? 'single' : /^p/i.test(t) ? 'periodic' : 'no'));
    if (!kinds.some(k => k !== 'no')) return;
    this.anneals = true;
    const np = words(v['annealing-npoints']);
    if (np.length !== types.length) {
      this.add('error', 'annealing-npoints-count', 'annealing-npoints', `annealing-npoints needs ${types.length} number${types.length === 1 ? '' : 's'} ` +
        `(one per temperature group); it has ${np.length}. grompp stops.`);
      return;
    }
    const npts = np.map(w => {
      const r = cInteger(w);
      if (!r.ok) this.add('error', 'annealing-npoints-number', 'annealing-npoints', 'annealing-npoints should hold whole numbers only.');
      return r.value;
    });
    if (npts.some(n => n === 1)) {
      this.add('error', 'annealing-one-point', 'annealing-npoints', 'An annealing schedule needs at least a start and an end point (2 or more). grompp stops.');
      return;
    }
    const total = npts.reduce((a, b) => a + b, 0);
    const times = words(v['annealing-time']);
    const temps = words(v['annealing-temp']);
    if (times.length !== total) {
      this.add('error', 'annealing-time-count', 'annealing-time', `annealing-time needs ${total} values (the sum of annealing-npoints); it has ${times.length}. grompp stops.`);
      return;
    }
    if (temps.length !== total) {
      this.add('error', 'annealing-temp-count', 'annealing-temp', `annealing-temp needs ${total} values (the sum of annealing-npoints); it has ${temps.length}. grompp stops.`);
      return;
    }
    const tv = times.map(strictReal);
    const Tv = temps.map(strictReal);
    if (tv.some(x => x === null)) this.add('error', 'annealing-time-number', 'annealing-time', 'annealing-time should hold numbers only.');
    if (Tv.some(x => x === null)) this.add('error', 'annealing-temp-number', 'annealing-temp', 'annealing-temp should hold numbers only.');
    let k = 0;
    for (let g = 0; g < npts.length; g++) {
      for (let j = 0; j < npts[g]; j++, k++) {
        if (j === 0 && tv[k] > v.tinit + GMX_REAL_EPS) {
          this.add('error', 'annealing-start', 'annealing-time', `The first annealing time of group ${g + 1} (${tv[k]} ps) is after tinit (${v.tinit} ps). grompp stops.`);
        }
        if (j > 0 && tv[k] < tv[k - 1]) {
          this.add('error', 'annealing-order', 'annealing-time', `Annealing times are out of order in group ${g + 1}: ${tv[k]} comes after ${tv[k - 1]}. grompp stops.`);
        }
        if (Tv[k] < 0) this.add('error', 'annealing-negative', 'annealing-temp', 'An annealing temperature is negative. grompp stops.');
      }
      if (kinds[g] === 'periodic' && npts[g] > 0 && Math.abs(Tv[k - 1] - Tv[k - npts[g]]) > GMX_REAL_EPS) {
        this.add('note', 'annealing-jump', 'annealing-temp', `Periodic annealing of group ${g + 1} jumps from ${Tv[k - 1]} K back to ${Tv[k - npts[g]]} K when it repeats.`);
      }
    }
  }

  /* ---- triple_check ---- */

  tripleCheck() {
    const v = this.v;
    const I = this.I;
    const ctx = this.ctx;
    const verlet = key(v['cutoff-scheme']) === 'VERLET';
    if (this.commMode !== 'NONE' && this.posres) {
      this.add('note', 'posres-comm', 'comm-mode', 'Centre-of-mass motion is removed while position restraints are on, which can cause small ' +
        'artefacts; they are usually negligible when equilibrating a macromolecule.', this.assumePosres());
    }
    if (verlet && v['verlet-buffer-tolerance'] > 0 && v.nstlist > 1 && (EI.MD(I) || EI.SD(I)) &&
      (this.etc === 'VRESCALE' || this.etc === 'BERENDSEN')) {
      const T = this.refMax;
      const tau = this.tauMax;
      if (T > 0) {
        const maxErr = 0.5 * tau * v['verlet-buffer-tolerance'] / (2 * BOLTZ * T);
        if (maxErr > 0.002) {
          this.add('warning', 'buffer-thermostat', 'tau-t', `With verlet-buffer-tolerance = ${v['verlet-buffer-tolerance']}, ref-t ${T} K and tau-t ${tau} ps ` +
            `the temperature may be off by up to ${(100 * maxErr).toFixed(1)}%. Decrease tau-t or verlet-buffer-tolerance.`);
        }
      }
    }
    if (this.etc === 'ANDERSEN' || this.etc === 'ANDERSENMASSIVE') {
      if (this.taus.some(t => t !== this.taus[0])) this.add('error', 'andersen-tau', 'tau-t', 'With Andersen coupling every tau-t must be equal.');
      if (this.taus.some(t => t < 0)) this.add('error', 'andersen-tau', 'tau-t', 'With Andersen coupling every tau-t must be positive.');
    }
    const absRef = this.frozenAll.every(Boolean);
    if (EI.DYNAMICS(I) && !EI.SD(I) && I !== 'BD' && this.commMode === 'NONE' && !(absRef || this.posres || v.nsteps <= 10) &&
      !(this.etc === 'ANDERSEN' || this.etc === 'ANDERSENMASSIVE')) {
      this.add('warning', 'no-comm', 'comm-mode', 'Centre-of-mass motion is not removed (comm-mode = None or nstcomm = 0): rounding errors can make ' +
        'the whole system drift. Use comm-mode = Linear.', this.assumePosres());
    }
    const haveEns = this.ensemble === 'CONSTANT' || this.ensemble === 'VARIABLE';
    if (this.epc === 'CRESCALE' && !haveEns) {
      let why = 'there is no thermostat';
      if (this.anneals && this.ngtc > 1) why = 'simulated annealing with more than one temperature group leaves no single ensemble temperature';
      else if (this.hasRefT && !this.equalRefT) why = 'the groups have different ref-t';
      else if (key(v['ensemble-temperature-setting']) === 'NOTAVAILABLE') why = 'ensemble-temperature-setting says there is none';
      this.add('error', 'crescale-temperature', 'pcoupl', `C-rescale needs an ensemble temperature, and ${why}. ` +
        (this.anneals && this.ngtc > 1 ? 'Couple the whole system as one group (tc-grps = System) or anneal without pressure coupling.'
          : 'Use a thermostat with one ref-t for all groups, or set ensemble-temperature-setting = constant.'));
    }
    if (this.epc === 'PARRINELLORAHMAN' && this.etc === 'NOSEHOOVER' && v['tau-p'] < 1.9 * this.tauMax) {
      this.add('warning', 'pr-nh-resonance', 'tau-p', `With Nose-Hoover and Parrinello-Rahman, tau-p (${v['tau-p']}) should be at least twice ` +
        `tau-t (${this.tauMax}) to avoid resonances.`);
    }
    if (this.epc !== 'NO' && key(v['refcoord-scaling']) === 'NO' && this.posres) {
      if ([0, 1, 2].some(d => this.compress[d].some(x => x !== 0))) {
        this.add('warning', 'posres-refcoord', 'refcoord-scaling', 'Pressure coupling with position restraints and refcoord-scaling = no gives ' +
          'artefacts; set refcoord-scaling = com (or all).', { ...this.assumePosres(), line: this.set['refcoord-scaling'] ? this.set['refcoord-scaling'].line : (this.set.pcoupl ? this.set.pcoupl.line : null) });
      }
    }
    if (this.epc === 'MTTK' && this.ensemble !== 'CONSTANT') this.add('error', 'mttk-temperature', 'pcoupl', 'MTTK needs a constant ensemble temperature.');
    const charged = ctx.charged !== false;
    if (!charged && COULOMB.FULL(this.ct)) {
      this.add('warning', 'full-elec-no-charges', 'coulombtype', `${v.coulombtype} for a system without charges only costs time; use Cut-off.`, { assumes: 'the system has no charges' });
    } else if (charged && this.ct === 'CUTOFF' && v.rcoulomb > 0) {
      this.add('note', 'plain-cutoff', 'coulombtype', 'A plain Coulomb cut-off can cause artefacts; PME is usually better.', { assumes: 'the system has charges' });
    }
    if (this.ct === 'GENERALIZEDREACTIONFIELD(UNUSED)') {
      this.add('error', 'grf', 'coulombtype', 'Generalized reaction field is no longer supported; use Reaction-Field.');
    }
    if (this.gate.pull && this.pullCoordGeom) {
      let warned = false;
      for (const pc of this.pullCoordGeom) {
        if (warned || pc.geom === 'TRANSFORMATION') continue;
        if (pc.groups[0] === 0 || pc.groups[1] === 0) {
          if ([0, 1, 2].some(d => pc.dim[d] && !(this.frozenAll[d] || this.posres))) {
            this.add('warning', 'pull-absolute', `pull-coord${pc.c}-groups`, 'The pull coordinate uses an absolute reference (group 0), but ' +
              'nothing else holds the system in place, which gives artefacts. Restrain or freeze something, or pull between two groups.', this.assumePosres());
            warned = true;
          }
        }
      }
      const dynamicBox = this.epc !== 'NO' || this.haveDeform;
      for (const pc of this.pullCoordGeom) {
        if (pc.geom === 'DIRECTIONPERIODIC' && dynamicBox) {
          const dims = [0, 1, 2].filter(d => pc.vec[d] !== 0 && ((this.epc !== 'NO' && this.compress[d].some(x => x !== 0)) || this.deform[d].some(x => x !== 0)));
          if (dims.length) this.add('error', 'pull-periodic-box', `pull-coord${pc.c}-geometry`, 'Geometry direction-periodic needs a box that does not change along the pull direction. grompp stops.');
        }
      }
    }
    if (this.gate.awh && this.ensemble !== 'CONSTANT') {
      this.add('error', 'awh-temperature', 'awh', 'AWH needs a constant ensemble temperature: a thermostat with one ref-t, or ensemble-temperature-setting = constant.');
    }
    if (this.haveDeform) {
      if (EI.DYNAMICS(I) && I !== 'MD' && (EI.SD(I) || this.etc !== 'NO')) {
        this.add('note', 'deform-thermostat', 'deform', 'With integrators other than md the thermostat also scales the flow from deform.');
      }
      if (this.ngtc !== 1) this.add('error', 'deform-tc-grps', 'tc-grps', 'Box deformation needs exactly one temperature-coupling group.');
    }
    const nonEq = [this.useAcceleration, v['cos-acceleration'] !== 0, this.haveDeform].filter(Boolean).length;
    if (nonEq > 1) {
      this.add('error', 'non-equilibrium', 'deform', 'Use only one of acceleration groups, cos-acceleration and deform at a time.');
    }
  }

  /* ---- double_check, and the rest of grompp ---- */

  doubleCheck() {
    const v = this.v;
    const I = this.I;
    const normalConstraints = this.nshake > 0;
    const anyConstraints = normalConstraints || this.ctx.rigidWater !== false;
    const shake = key(v['constraint-algorithm']) === 'SHAKE';
    if (normalConstraints && shake && v['shake-tol'] <= 0) this.add('error', 'shake-tol', 'shake-tol', 'shake-tol must be above 0.');
    if (!shake && normalConstraints) {
      if (I === 'MD' && this.etc === 'NO' && v['lincs-iter'] === 1) {
        this.add('note', 'lincs-nve', 'lincs-iter', 'For energy conservation with LINCS (no thermostat), use lincs-iter = 2 or more.');
      }
      if ((I === 'CG' || I === 'LBFGS') && v['lincs-order'] < 8) {
        this.add('note', 'lincs-order-em', 'lincs-order', `For accurate ${v.integrator} minimisation with LINCS constraints, use lincs-order = 8 or more.`);
      }
      if (this.epc === 'MTTK') this.add('error', 'mttk-lincs', 'pcoupl', 'MTTK does not work with LINCS; use SHAKE.');
    }
    if (anyConstraints && this.epc === 'MTTK') {
      this.add('error', 'mttk-constraints', 'pcoupl', 'MTTK pressure coupling does not work with constraints.',
        { assumes: normalConstraints ? undefined : 'the topology has rigid (SETTLE) water' });
    }
    if (v['lincs-warnangle'] > 90) this.add('warning', 'lincs-warnangle', 'lincs-warnangle', 'lincs-warnangle cannot exceed 90 degrees; grompp uses 90 and warns.');
    if (key(v.pbc) !== 'NO' && v.nstlist === 0) {
      this.add('warning', 'nstlist-zero-pbc', 'nstlist', 'With nstlist = 0 atoms are put back in the box only at the start; drifting atoms can crash the run.');
    }
  }

  /* Sizing the Verlet buffer, after do_index (grompp.cpp). */
  bufferChecks() {
    const v = this.v;
    const I = this.I;
    if (key(v['cutoff-scheme']) === 'VERLET' && v['verlet-buffer-tolerance'] > 0 && EI.DYNAMICS(I) && this.nbounded === 3) {
      if (EI.MD(I) && this.etc === 'NO') {
        this.add('note', 'nve-buffer', 'tcoupl', v['gen-vel'] === 'yes'
          ? `No thermostat (NVE): grompp sizes the Verlet buffer for the starting temperature, gen-temp = ${v['gen-temp']} K.`
          : 'No thermostat (NVE): grompp sizes the Verlet buffer for the temperature of the starting velocities.');
      } else if (this.hasRefT && this.taus.some(t => t !== null && t < 0)) {
        this.add('warning', 'tau-t-uncoupled', 'tau-t', 'Some temperature groups are not coupled (tau-t = -1); grompp assumes they are no hotter ' +
          'than the others when sizing the Verlet buffer, and warns.');
      }
    }
  }

  finalChecks() {
    const v = this.v;
    const nk = [v['fourier-nx'], v['fourier-ny'], v['fourier-nz']];
    if ((COULOMB.FULL(this.ct) || this.vt === 'PME') && !nk.every(x => x > 0) && nk.every(x => x !== 0)) {
      this.add('error', 'fourier-partial', 'fourier-nx', 'Some of the Fourier grid sizes are set, but all of them need to be set.');
    }
    // COM removal frequency against the global communication period (grompp.cpp).
    if (this.commMode !== 'NONE' && EI.DYNAMICS(this.I) && this.nstcomm > 0) {
      let glob;
      if (this.nstcalcenergy === 0 && this.etc === 'NO' && this.epc !== 'NO') glob = 200;
      else {
        glob = gcd(gcd(this.nstcalcenergy, this.etc !== 'NO' ? (this.nsttcouple > 0 ? this.nsttcouple : 0) : 0),
          this.epc !== 'NO' ? this.nstpcouple : 0);
        if (glob > 200) glob = gcd(glob, 200);
      }
      if (glob > 0 && this.nstcomm % glob !== 0) {
        this.add('note', 'nstcomm-global', 'nstcomm', `nstcomm (${this.nstcomm}) is not a multiple of the global communication period ` +
          `(${glob} steps, from nstcalcenergy, nsttcouple and nstpcouple), which costs extra communication in parallel. Set nstcomm to a multiple of ${glob}.`);
      }
    }
    v.nsttcouple = this.nsttcouple;
    v.nstpcouple = this.nstpcouple;
    v.rlist = this.rlist;
    v['nh-chain-length'] = this.nhchain;
  }
}

/* sscanf("%lf %lf ...") as grompp reads compressibility, ref-p and deform:
   numbers from the start, stopping at the first that does not parse. */
function scanReals(text, max) {
  const out = [];
  let s = String(text || '');
  while (out.length < max) {
    const m = /^\s*([+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|inf(?:inity)?|nan))/i.exec(s);
    if (!m) break;
    out.push(Number(/inf/i.test(m[1]) ? (m[1].startsWith('-') ? -Infinity : Infinity) : m[1]));
    s = s.slice(m[0].length);
  }
  return out;
}

function scanInts(text, max) {
  const out = [];
  let s = String(text || '');
  while (out.length < max) {
    const m = /^\s*([+-]?\d+)/.exec(s);
    if (!m) break;
    out.push(Number(m[1]));
    s = s.slice(m[0].length);
  }
  return out;
}

/* Round to single precision, as a mixed-precision grompp stores reals. */
function f32(x) {
  return Math.fround(Number(x));
}

function fmt(x) {
  return String(Number(Number(x).toPrecision(6)));
}

function editDistance(a, b) {
  const s = String(a);
  const t = String(b);
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[t.length];
}

/* The closest known name, compared as grompp compares names. */
function nearest(word, candidates) {
  const w = key(word);
  let best = '';
  let score = Infinity;
  for (const c of candidates) {
    const d = editDistance(w, key(c));
    if (d < score) { score = d; best = c; }
  }
  return score <= Math.max(1, Math.floor(w.length / 4)) ? best : '';
}

/* ------------------------------------------------------------------ *
 * Explaining
 * ------------------------------------------------------------------ */

/**
 * Explain a file line by line, in plain English.
 *
 * @param {string|ReturnType<typeof parseMdp>} input
 * @param {{context?:object}} [options] - As for {@link checkMdp}.
 * @returns {Array<{line:number, kind:'entry'|'empty'|'comment'|'blank'|'invalid', text:string,
 *   name:string|null, value:string, summary:string, meaning:string, url:string, valueUrl:string,
 *   unit:string, default:string, isDefault:boolean, status:'ok'|'unknown'|'obsolete'|'inactive'|'duplicate'|'ignored',
 *   comment:string, issues:MdpIssue[]}>} One row per line of the file.
 */
export function explainMdp(input, options = {}) {
  const parsed = typeof input === 'string' || input == null ? parseMdp(input) : input;
  const { issues, settings } = checkMdp(parsed, options);
  const dt = typeof settings.dt === 'number' ? settings.dt : 0.001;
  const I = key(settings.integrator);
  const dynamics = EI.DYNAMICS(I);
  const byLine = new Map();
  for (const i of issues) {
    if (i.line === null) continue;
    if (!byLine.has(i.line)) byLine.set(i.line, []);
    byLine.get(i.line).push(i);
  }
  return parsed.lines.map(l => {
    const row = {
      line: l.line, kind: l.kind, text: l.raw, name: null, value: '', summary: '', meaning: '', url: '', valueUrl: '',
      unit: '', default: '', isDefault: false, status: 'ok', comment: l.comment || '', issues: byLine.get(l.line) || []
    };
    if (l.kind === 'comment') { row.meaning = 'A comment: grompp ignores everything after ;'; return row; }
    if (l.kind === 'blank') return row;
    if (l.kind === 'invalid') { row.meaning = 'grompp cannot read this line.'; row.status = 'unknown'; return row; }
    const e = l.entry;
    row.value = e.value;
    const info = optionInfo(e.key);
    if (!info) {
      row.status = 'unknown';
      const hint = row.issues.find(i => i.id === 'unknown');
      const near = hint && /Did you mean ([^?]+)\?|documents it as lmc-mc-move/.exec(hint.message);
      row.meaning = `Not an option of GROMACS ${MDP_RELEASE}; grompp warns "Unknown left-hand".` +
        (near ? (near[1] ? ` Did you mean ${near[1]}?` : ' grompp reads lmc-move.') : '');
      return row;
    }
    if (e.empty) {
      row.name = info.name;
      row.status = 'ignored';
      row.summary = info.summary || info.reason || '';
      row.url = info.obsolete ? '' : info.url;
      row.meaning = `No value, so grompp ignores the line${info.obsolete || info.default === '' ? '' : ` and uses the default (${info.default})`}.`;
      return row;
    }
    if (info.obsolete) {
      row.name = info.name;
      row.status = 'obsolete';
      row.url = info.replacement ? mdpDocUrl(info.replacement) : '';
      row.summary = info.replacement ? `Old name of ${info.replacement}.` : 'Obsolete.';
      row.meaning = info.reason;
      return row;
    }
    row.name = info.name;
    row.summary = info.summary;
    row.url = info.url;
    row.unit = info.unit;
    row.default = info.default;
    if (e.duplicate) {
      row.status = 'duplicate';
      row.meaning = 'Given twice: grompp stops.';
      return row;
    }
    row.valueUrl = info.values.length ? mdpDocUrl(info.name, e.value) : '';
    if (row.issues.some(i => i.id === 'inactive')) {
      row.status = 'inactive';
      row.meaning = `Not read: ${info.readWhen ? `${info.name} is only used when ${info.readWhen.when}`
        : 'it is beyond the count of its numbered family'}, so grompp warns "Unknown left-hand".`;
      return row;
    }
    row.isDefault = isDefaultValue(info, e.value);
    row.meaning = meaningOf(info, e.value, { dt, dynamics, settings, parsed }) +
      (row.isDefault ? ' (This is the default.)' : '');
    return row;
  });
}

function isDefaultValue(info, value) {
  const d = info.default;
  if (d === '' && info.defaultFrom) return false;
  if (info.kind === 'integer' || info.kind === 'real') {
    const a = cReal(value);
    return a.ok && d !== '' && a.value === Number(d);
  }
  if (info.kind === 'enum') return key(value) === key(d) || (info.gromppDefault !== null && key(value) === key(info.gromppDefault));
  if (info.kind === 'boolean') return ['1', 'yes', 'true'].includes(value.toLowerCase()) === (d === 'true');
  return words(value).join(' ') === words(d).join(' ');
}

const STEP_OUTPUTS = new Set(['nstxout', 'nstvout', 'nstfout', 'nstlog', 'nstcalcenergy', 'nstenergy', 'nstxout-compressed',
  'nstcomm', 'nstlist', 'nsttcouple', 'nstpcouple', 'nstdhdl', 'nstexpanded', 'pull-nstxout', 'pull-nstfout', 'awh-nstout',
  'awh-nstsample', 'nstdisreout', 'nstorireout', 'rot-nstrout', 'rot-nstsout', 'swap-frequency', 'density-guided-simulation-nst']);

const DEFINES = {
  POSRES: 'switches on the position restraints of the topology (the posre.itp files pdb2gmx writes)',
  FLEXIBLE: 'uses flexible instead of rigid water (for minimisation or normal modes)'
};

function meaningOf(info, value, ctx) {
  const n = info.name;
  const base = info.family ? n.replace(/\d+/g, '1') : n;
  const num = cReal(value);
  const ps = (steps) => formatDuration(steps * ctx.dt);
  if (info.kind === 'enum' || info.kind === 'boolean') {
    const v = info.values.find(x => key(x.value) === key(value)) ||
      (info.kind === 'boolean' ? info.values.find(x => x.value === (['1', 'yes', 'true'].includes(value.toLowerCase()) ? 'true' : 'false')) : null);
    if (v) return `${value}: ${v.summary || info.summary}${v.status && v.note ? ` ${v.note}` : ''}`;
    if (info.accepted.some(a => key(a) === key(value))) return `${value}: accepted by grompp, though the manual does not describe it.`;
    return `"${value}" is not one of the values of ${n}.`;
  }
  if (n === 'nsteps' && num.ok) {
    if (num.value < 0) return 'Runs without a step limit.';
    const I = key(ctx.settings.integrator);
    if (EI.EM(I)) return `At most ${num.value.toLocaleString('en-GB')} minimisation steps.`;
    if (!ctx.dynamics) return `${num.value.toLocaleString('en-GB')} steps.`;
    return `${num.value.toLocaleString('en-GB')} steps of ${ctx.dt} ps = ${formatDuration(num.value * ctx.dt)}.`;
  }
  if (n === 'dt' && num.ok) return `${fmt(num.value * 1000)} fs per step.`;
  if (STEP_OUTPUTS.has(base) && num.ok) {
    if (num.value === 0) {
      if (/^nst(x|v|f)out|nstxout-compressed|nstenergy|nstdhdl|pull-nst/.test(base)) return 'Never written.';
      if (base === 'nstcomm') return 'Centre-of-mass motion is not removed.';
      if (base === 'nstcalcenergy') return 'Energies are never calculated.';
      return '0.';
    }
    if (num.value < 0) return base === 'nsttcouple' || base === 'nstpcouple' ? 'grompp chooses (100 steps, or fewer if the time constant needs it).' : 'Negative.';
    return ctx.dynamics ? `Every ${num.value.toLocaleString('en-GB')} steps = ${ps(num.value)}.` : `Every ${num.value.toLocaleString('en-GB')} steps.`;
  }
  if (n === 'define') {
    const flags = words(value);
    return flags.map(f => {
      const m = /^-D([A-Za-z_]\w*)(=(.*))?$/.exec(f);
      if (!m) return `${f}: passed to the topology preprocessor.`;
      const known = DEFINES[m[1]];
      return `-D${m[1]}${m[2] || ''}: ${known || `defines ${m[1]}${m[3] ? ` = ${m[3]}` : ''} for #ifdef blocks in the topology`}.`;
    }).join(' ');
  }
  if (n === 'include') return `Topology include paths: ${words(value).join(', ')}.`;
  if (n === 'tc-grps' || n === 'tau-t' || n === 'ref-t') {
    const g = words(ctx.parsed.values['tc-grps'] || ctx.settings['tc-grps']);
    const tau = words(ctx.parsed.values['tau-t'] || '');
    const T = words(ctx.parsed.values['ref-t'] || '');
    if (g.length) {
      return g.map((grp, i) => `${grp}: ${T[i] !== undefined ? `${T[i]} K` : '? K'}, tau-t ${tau[i] !== undefined ? (Number(tau[i]) < 0 ? 'uncoupled' : `${tau[i]} ps`) : '?'}`).join('; ') + '.';
    }
  }
  if (n === 'ref-p' || n === 'compressibility') {
    const type = key(ctx.settings.pcoupltype);
    const labels = type === 'ISOTROPIC' ? ['all directions'] : type === 'ANISOTROPIC' ? ['xx', 'yy', 'zz', 'xy', 'xz', 'yz'] : ['x/y', 'z'];
    const unit = n === 'ref-p' ? (type === 'SURFACETENSION' ? ['bar nm', 'bar'] : ['bar']) : ['bar^-1'];
    return words(value).slice(0, labels.length).map((w, i) => `${labels[i]}: ${w} ${unit[Math.min(i, unit.length - 1)]}`).join('; ') + '.';
  }
  if (n === 'mass-repartition-factor' && num.ok) {
    if (num.value <= 1) return 'Masses are not changed.';
    return `The lightest atoms (hydrogens, 1.008 u) become ${fmt(num.value * 1.008)} u; the mass comes from the atom each is bonded to.`;
  }
  if (info.unit && num.ok && (info.kind === 'real' || info.kind === 'integer')) {
    return `${value} ${info.unit.replace(/ or .*/, '')}.`;
  }
  if (info.per) return `${words(value).length} value${words(value).length === 1 ? '' : 's'}: ${words(value).join(', ')}.`;
  return value ? `${value}.` : '';
}

/* ------------------------------------------------------------------ *
 * Units
 * ------------------------------------------------------------------ */

/**
 * Steps for a time, rounded to the nearest step (at least 1 for a positive time).
 *
 * @param {number} ps - Time in ps.
 * @param {number} dt - Time step in ps.
 * @returns {number}
 */
export function psToSteps(ps, dt) {
  const t = Number(ps);
  const d = Number(dt);
  if (!(d > 0) || !Number.isFinite(t)) return 0;
  if (t <= 0) return 0;
  return Math.max(1, Math.round(t / d));
}

/**
 * @param {number} ns - Time in ns.
 * @param {number} dt - Time step in ps.
 * @returns {number} Steps.
 */
export function nsToSteps(ns, dt) {
  return psToSteps(Number(ns) * 1000, dt);
}

/**
 * @param {number} steps
 * @param {number} dt - Time step in ps.
 * @returns {number} Time in ps.
 */
export function stepsToPs(steps, dt) {
  return Number((Number(steps) * Number(dt)).toPrecision(12));
}

/**
 * A time in ps written in the most readable unit: `500 fs`, `10 ps`, `1.5 ns`, `2 µs`.
 *
 * @param {number} ps
 * @returns {string}
 */
export function formatDuration(ps) {
  const t = Number(ps);
  if (!Number.isFinite(t)) return '';
  const a = Math.abs(t);
  const f = (x) => String(Number(x.toPrecision(4)));
  if (a === 0) return '0 ps';
  if (a < 1) return `${f(t * 1000)} fs`;
  if (a < 1000) return `${f(t)} ps`;
  if (a < 1e6) return `${f(t / 1000)} ns`;
  return `${f(t / 1e6)} µs`;
}

/* ------------------------------------------------------------------ *
 * Writing files
 * ------------------------------------------------------------------ */

const FF_GUIDE = `${MANUAL_ROOT}/user-guide/force-fields.html`;
const MD_ALGORITHMS = `${MANUAL_ROOT}/reference-manual/algorithms/molecular-dynamics.html`;

/**
 * Force-field conventions for the non-bonded settings, time step and
 * coupling constants, with where each comes from.
 *
 * `references` are shown in the generated file's header. Values are those the
 * force field was parametrised with, or the GROMACS manual's recommendation.
 */
export const FORCE_FIELDS = Object.freeze({
  amber: Object.freeze({
    id: 'amber', label: 'AMBER (ff99SB-ILDN, ff14SB, ff19SB)', resolution: 'all-atom', water: 'TIP3P (OPC with ff19SB)',
    dt: 0.002, constraints: 'h-bonds', hmr: true, nstlist: 10,
    coulombtype: 'PME', rcoulomb: 1.0, vdwtype: 'Cut-off', vdwModifier: 'Potential-shift', rvdw: 1.0, rvdwSwitch: null,
    dispCorr: 'EnerPres', epsilonR: null, epsilonRf: null,
    tauT: { 'v-rescale': 0.1, 'nose-hoover': 0.5, berendsen: 0.1 },
    tauP: { 'c-rescale': 1.0, 'parrinello-rahman': 5.0, berendsen: 1.0 },
    compressibility: 4.5e-5,
    why: {
      cutoff: 'AMBER: 1.0 nm real-space cut-off with PME',
      dispCorr: 'AMBER force fields expect a long-range dispersion correction (AMBER\'s own default, vdwmeth = 1)'
    },
    references: [
      { text: 'GROMACS manual, force fields: AMBER', url: `${FF_GUIDE}#gmx-amber-ff` },
      { text: 'AMBER manual, vdwmeth: continuum correction for energy and pressure by default', url: 'https://ambermd.org/Manuals.php' }
    ]
  }),
  charmm36: Object.freeze({
    id: 'charmm36', label: 'CHARMM36 (CHARMM36m)', resolution: 'all-atom', water: 'CHARMM TIP3P',
    dt: 0.002, constraints: 'h-bonds', hmr: true, nstlist: 10,
    coulombtype: 'PME', rcoulomb: 1.2, vdwtype: 'Cut-off', vdwModifier: 'Force-switch', rvdw: 1.2, rvdwSwitch: 1.0,
    dispCorr: 'no', epsilonR: null, epsilonRf: null,
    tauT: { 'v-rescale': 0.1, 'nose-hoover': 0.5, berendsen: 0.1 },
    tauP: { 'c-rescale': 1.0, 'parrinello-rahman': 5.0, berendsen: 1.0 },
    compressibility: 4.5e-5,
    why: {
      cutoff: 'CHARMM36 as the GROMACS manual gives it: PME with 1.2 nm, LJ force-switched from 1.0 to 1.2 nm',
      dispCorr: 'CHARMM36: no dispersion correction for bilayers (the manual: use EnerPres only for monolayers)'
    },
    references: [
      { text: 'GROMACS manual, force fields: settings for CHARMM36', url: `${FF_GUIDE}#gmx-charmm-ff` }
    ]
  }),
  gromos54a7: Object.freeze({
    id: 'gromos54a7', label: 'GROMOS 54A7 (united atom)', resolution: 'united-atom', water: 'SPC',
    dt: 0.002, constraints: 'h-bonds', hmr: true, nstlist: 10,
    coulombtype: 'PME', rcoulomb: 1.4, vdwtype: 'Cut-off', vdwModifier: 'Potential-shift', rvdw: 1.4, rvdwSwitch: null,
    dispCorr: 'no', epsilonR: null, epsilonRf: null,
    tauT: { 'v-rescale': 0.1, 'nose-hoover': 0.5, berendsen: 0.1 },
    tauP: { 'c-rescale': 1.0, 'parrinello-rahman': 5.0, berendsen: 1.0 },
    compressibility: 4.5e-5,
    why: {
      cutoff: 'GROMOS: keep the 1.4 nm cut-off the parameters were fitted with (then with a reaction field; PME is the usual choice now)',
      dispCorr: 'GROMOS was parametrised without a long-range dispersion correction'
    },
    notes: ['The GROMACS manual warns that GROMOS was parametrised with a twin-range cut-off scheme GROMACS no longer has, so properties such as the density may differ slightly from the intended values.'],
    references: [
      { text: 'GROMACS manual, force fields: GROMOS (and its warning)', url: `${FF_GUIDE}#gmx-gromos-ff` },
      { text: 'Schmid et al., Eur. Biophys. J. 40, 843 (2011): GROMOS 54A7', url: 'https://doi.org/10.1007/s00249-011-0700-9' }
    ]
  }),
  'opls-aa': Object.freeze({
    id: 'opls-aa', label: 'OPLS-AA', resolution: 'all-atom', water: 'TIP4P (or TIP3P)',
    dt: 0.002, constraints: 'h-bonds', hmr: true, nstlist: 10,
    coulombtype: 'PME', rcoulomb: 1.0, vdwtype: 'Cut-off', vdwModifier: 'Potential-shift', rvdw: 1.0, rvdwSwitch: null,
    dispCorr: 'EnerPres', epsilonR: null, epsilonRf: null,
    tauT: { 'v-rescale': 0.1, 'nose-hoover': 0.5, berendsen: 0.1 },
    tauP: { 'c-rescale': 1.0, 'parrinello-rahman': 5.0, berendsen: 1.0 },
    compressibility: 4.5e-5,
    why: {
      cutoff: 'OPLS-AA: 1.0 nm cut-offs with PME, the usual choice in GROMACS',
      dispCorr: 'OPLS-AA was fitted to liquid properties with long-range Lennard-Jones corrections'
    },
    references: [
      { text: 'GROMACS manual, force fields: OPLS', url: `${FF_GUIDE}#gmx-opls` },
      { text: 'Jorgensen, Maxwell and Tirado-Rives, J. Am. Chem. Soc. 118, 11225 (1996)', url: 'https://doi.org/10.1021/ja9621760' }
    ]
  }),
  martini3: Object.freeze({
    id: 'martini3', label: 'Martini 3 (coarse-grained)', resolution: 'coarse-grained', water: 'Martini W',
    dt: 0.02, constraints: 'none', hmr: false, nstlist: 20,
    coulombtype: 'Reaction-Field', rcoulomb: 1.1, vdwtype: 'Cut-off', vdwModifier: 'Potential-shift', rvdw: 1.1, rvdwSwitch: null,
    dispCorr: 'no', epsilonR: 15, epsilonRf: 0,
    tauT: { 'v-rescale': 1.0, 'nose-hoover': 4.0, berendsen: 1.0 },
    tauP: { 'c-rescale': 4.0, 'parrinello-rahman': 12.0, berendsen: 4.0 },
    compressibility: 3e-4,
    why: {
      cutoff: 'Martini 3: reaction field with epsilon-r = 15, epsilon-rf = 0 (infinity) and 1.1 nm cut-offs (de Jong et al. 2016)',
      dispCorr: 'Martini is used without a dispersion correction'
    },
    notes: ['Martini topologies keep their own [ constraints ] (rings, helices); constraints = none only leaves ordinary bonds flexible.'],
    references: [
      { text: 'de Jong, Baoukina, Ingolfsson and Marrink, Comput. Phys. Commun. 199, 1 (2016): Martini with a 1.1 nm cut-off and the Verlet scheme', url: 'https://doi.org/10.1016/j.cpc.2015.09.014' },
      { text: 'Souza et al., Nat. Methods 18, 382 (2021): Martini 3', url: 'https://doi.org/10.1038/s41592-021-01098-3' },
      { text: 'Martini force field: example input files', url: 'https://cgmartini.nl' }
    ]
  })
});

/** Thermostats the generator offers, and what the checker will say about each. */
export const THERMOSTATS = Object.freeze({
  'v-rescale': Object.freeze({ id: 'v-rescale', value: 'V-rescale', label: 'V-rescale (stochastic velocity rescaling)', recommended: true,
    note: 'Correct canonical ensemble and robust from the first step; the GROMACS recommendation.' }),
  'nose-hoover': Object.freeze({ id: 'nose-hoover', value: 'Nose-Hoover', label: 'Nose-Hoover', recommended: false,
    note: 'Correct ensemble but oscillatory; start from an equilibrated temperature. tau-t is a period, 4-5 times a first-order time constant.' }),
  berendsen: Object.freeze({ id: 'berendsen', value: 'Berendsen', label: 'Berendsen (deprecated)', recommended: false, deprecated: true,
    note: 'Wrong kinetic-energy distribution; grompp warns, so the file needs -maxwarn. Only to reproduce old runs.' })
});

/** Barostats the generator offers. */
export const BAROSTATS = Object.freeze({
  'c-rescale': Object.freeze({ id: 'c-rescale', value: 'C-rescale', label: 'C-rescale (stochastic cell rescaling)', recommended: true,
    note: 'Correct volume fluctuations, suits equilibration and production; no anisotropic coupling in GROMACS 2025.' }),
  'parrinello-rahman': Object.freeze({ id: 'parrinello-rahman', value: 'Parrinello-Rahman', label: 'Parrinello-Rahman', recommended: false,
    note: 'Extended ensemble; oscillates far from equilibrium, so use it after equilibration. Needs a time constant 4-5 times larger.' }),
  berendsen: Object.freeze({ id: 'berendsen', value: 'Berendsen', label: 'Berendsen (deprecated)', recommended: false, deprecated: true,
    note: 'No correct ensemble; grompp warns, so the file needs -maxwarn. Use C-rescale.' })
});

/**
 * The stages the generator writes. `id` is also the default file and
 * -deffnm name (em.mdp, nvt.mdp, ...), matching the page's workflow.
 */
export const STAGES = Object.freeze({
  em: Object.freeze({ id: 'em', label: 'Energy minimisation (steepest descent)', integrator: 'steep', dynamics: false, posres: false }),
  'em-cg': Object.freeze({ id: 'em-cg', label: 'Energy minimisation (conjugate gradient)', integrator: 'cg', dynamics: false, posres: false }),
  nvt: Object.freeze({ id: 'nvt', label: 'NVT equilibration', integrator: 'md', dynamics: true, posres: true, ensemble: 'NVT',
    lengthNs: 0.1, genVel: true }),
  npt: Object.freeze({ id: 'npt', label: 'NPT equilibration', integrator: 'md', dynamics: true, posres: true, ensemble: 'NPT',
    lengthNs: 0.1, genVel: false }),
  prod: Object.freeze({ id: 'prod', label: 'Production', integrator: 'md', dynamics: true, posres: false, ensemble: 'NPT',
    lengthNs: 100, genVel: false }),
  anneal: Object.freeze({ id: 'anneal', label: 'Simulated annealing', integrator: 'md', dynamics: true, posres: false, ensemble: 'NVT',
    lengthNs: 1, genVel: false }),
  pull: Object.freeze({ id: 'pull', label: 'Pulling (umbrella window or steered MD)', integrator: 'md', dynamics: true, posres: false,
    ensemble: 'NPT', lengthNs: 10, genVel: false })
});

/** System types: how the box is coupled and which groups are thermostatted. */
export const SYSTEM_TYPES = Object.freeze({
  protein: Object.freeze({ id: 'protein', label: 'Protein (or other solute) in water', pcoupltype: 'isotropic', tcGroups: ['Protein', 'Non-Protein'] }),
  membrane: Object.freeze({ id: 'membrane', label: 'Membrane (semi-isotropic coupling)', pcoupltype: 'semiisotropic', tcGroups: ['SOLU', 'MEMB', 'SOLV'] }),
  solution: Object.freeze({ id: 'solution', label: 'Liquid or solution (one coupling group)', pcoupltype: 'isotropic', tcGroups: ['System'] })
});

/**
 * Settings for a stage with every default filled in. Pass the result (edited)
 * to {@link generateMdp}.
 *
 * @param {string} stage - A key of {@link STAGES}.
 * @param {object} [overrides] - Any setting of {@link generateMdp}.
 * @returns {object}
 */
export function defaultSettings(stage = 'prod', overrides = {}) {
  const st = STAGES[stage] || STAGES.prod;
  const ffId = overrides.forceField && FORCE_FIELDS[overrides.forceField] ? overrides.forceField : 'amber';
  const ff = FORCE_FIELDS[ffId];
  const systemId = overrides.system && SYSTEM_TYPES[overrides.system] ? overrides.system : 'protein';
  const sys = SYSTEM_TYPES[systemId];
  const cg = ff.resolution === 'coarse-grained';
  const s = {
    stage: st.id,
    forceField: ffId,
    system: systemId,
    temperature: 300,
    pressure: 1.0,
    thermostat: 'v-rescale',
    barostat: st.ensemble === 'NPT' ? 'c-rescale' : 'none',
    couplingType: sys.pcoupltype,
    tcGroups: sys.tcGroups.slice(),
    hmr: false,
    dt: null,
    lengthNs: st.lengthNs || null,
    nsteps: null,
    // A pure liquid has no solute to restrain (and grompp warns about an
    // unused -DPOSRES).
    posres: st.posres && systemId !== 'solution',
    posresDefine: '-DPOSRES',
    define: '',
    genVel: st.genVel === true,
    continuation: st.dynamics ? !st.genVel : false,
    output: st.dynamics
      ? (st.id === 'prod' || st.id === 'pull'
        ? { xtcPs: cg ? 100 : 10, energyPs: cg ? 100 : 10, logPs: cg ? 1000 : 100, trrPs: 0, xtcGroups: '' }
        : { xtcPs: cg ? 100 : 10, energyPs: cg ? 10 : 1, logPs: cg ? 100 : 10, trrPs: 0, xtcGroups: '' })
      : { energySteps: 500, logSteps: 500 },
    emtol: st.id === 'em-cg' ? 100 : 1000,
    emstep: 0.01,
    emSteps: 50000,
    anneal: { type: 'single', points: [[0, 300], [200, 400], [600, 400], [1000, 300]], barostat: 'none' },
    pull: {
      mode: 'umbrella', group1: 'Chain_A', group2: 'Chain_B', geometry: 'distance', dim: 'Y Y Y', vec: '0 0 1',
      k: 1000, rateNmPerPs: 0.01, outputPs: 1
    }
  };
  if (st.id === 'pull') s.barostat = 'c-rescale';
  const merged = { ...s, ...overrides };
  merged.output = { ...s.output, ...(overrides.output || {}) };
  merged.anneal = { ...s.anneal, ...(overrides.anneal || {}) };
  merged.pull = { ...s.pull, ...(overrides.pull || {}) };
  if (!overrides.tcGroups && overrides.system) merged.tcGroups = sys.tcGroups.slice();
  if (!overrides.couplingType && overrides.system) merged.couplingType = sys.pcoupltype;
  return merged;
}

/**
 * Write a complete, commented .mdp file for one stage.
 *
 * @param {object} [settings] - Anything left out takes the value
 *   {@link defaultSettings} gives for the stage:
 *   - `stage`: 'em' | 'em-cg' | 'nvt' | 'npt' | 'prod' | 'anneal' | 'pull'
 *   - `forceField`: a key of {@link FORCE_FIELDS}; `system`: a key of {@link SYSTEM_TYPES}
 *   - `temperature` (K), `pressure` (bar), `thermostat`, `barostat` ('c-rescale',
 *     'parrinello-rahman', 'berendsen', or 'none' for NVT), `couplingType`
 *     ('isotropic', 'semiisotropic', 'anisotropic'), `tcGroups` (index group names)
 *   - `hmr` (hydrogen mass repartitioning: mass-repartition-factor = 3, dt = 0.004 ps)
 *   - `dt` (ps; null for the force field's), `lengthNs` or `nsteps`
 *   - `posres`, `posresDefine`, `define` (extra -D flags), `genVel`, `continuation`
 *   - `output`: `{xtcPs, energyPs, logPs, trrPs, xtcGroups}`; for minimisation `{energySteps, logSteps}`
 *   - `emtol`, `emstep`, `emSteps` (minimisation)
 *   - `anneal`: `{type: 'single'|'periodic', points: [[time ps, temperature K], ...]}`
 *   - `pull`: `{mode: 'umbrella'|'steered', group1, group2, geometry: 'distance'|'direction',
 *     dim, vec, k (kJ mol^-1 nm^-2), rateNmPerPs, outputPs}`
 * @returns {{text:string, fileName:string, stage:string, settings:object,
 *   entries:Array<{name:string, value:string, comment:string, section:string}>,
 *   warnings:string[], expected:Array<{severity:string, id:string, message:string}>}}
 *   `warnings` are choices worth a second look (and adjustments the generator
 *   made); `expected` are the notes (and, for GROMOS, the one topology
 *   warning) grompp will print for this file, which are fine. grompp gives no
 *   errors, and no warnings apart from that GROMOS one, for a generated file,
 *   unless a deprecated method was chosen on purpose (listed in `warnings`).
 */
export function generateMdp(settings = {}) {
  const s = defaultSettings(settings.stage || 'prod', settings);
  const st = STAGES[s.stage];
  const ff = FORCE_FIELDS[s.forceField];
  const warnings = [];
  const out = [];
  const cg = ff.resolution === 'coarse-grained';
  let section = '';
  const head = (title) => { section = title; out.push({ section: title, heading: true }); };
  const put = (name, value, comment) => out.push({ name, value: String(value), comment: comment || '', section });

  // Time step and hydrogen mass repartitioning
  let hmr = !!s.hmr && st.dynamics;
  if (hmr && !ff.hmr) {
    warnings.push(`Hydrogen mass repartitioning does not apply to ${ff.label}: it has no hydrogens to repartition. Ignored.`);
    hmr = false;
  }
  const dt = st.dynamics ? (Number(s.dt) > 0 ? Number(s.dt) : (hmr ? 0.004 : ff.dt)) : null;
  if (st.dynamics && !cg && dt > 0.0025 && !hmr) {
    warnings.push(`dt = ${dt} ps without hydrogen mass repartitioning is too long for an ${ff.resolution} force field: angles involving hydrogen become unstable. Use 0.002 ps, or switch on HMR for 0.004 ps.`);
  }
  if (st.dynamics && hmr && dt > 0.004) {
    warnings.push(`dt = ${dt} ps is beyond what hydrogen mass repartitioning is known to allow; the GROMACS manual gives 4 fs with a factor of 3.`);
  }
  let nsteps;
  if (!st.dynamics) nsteps = Math.max(0, Math.round(Number(s.emSteps) || 0));
  else if (Number.isFinite(Number(s.nsteps)) && s.nsteps !== null && s.nsteps !== '') nsteps = Math.round(Number(s.nsteps));
  else nsteps = nsToSteps(s.lengthNs, dt);

  // Coupling choices. NVT equilibration has no barostat and NPT equilibration
  // always has one; production and pulling may run at constant volume
  // (barostat 'none'); annealing is NVT unless anneal.barostat says otherwise.
  const thermostat = THERMOSTATS[s.thermostat] ? s.thermostat : 'v-rescale';
  const wanted = s.stage === 'anneal' ? (s.anneal || {}).barostat : s.barostat;
  let barostat = 'none';
  if (s.stage === 'npt') barostat = BAROSTATS[wanted] ? wanted : 'c-rescale';
  else if (s.stage === 'prod' || s.stage === 'pull' || s.stage === 'anneal') barostat = BAROSTATS[wanted] ? wanted : 'none';
  if ((s.stage === 'prod' || s.stage === 'pull') && wanted === undefined) barostat = 'c-rescale';
  let couplingType = ['isotropic', 'semiisotropic', 'anisotropic'].includes(s.couplingType) ? s.couplingType : 'isotropic';
  if (barostat === 'c-rescale' && couplingType === 'anisotropic') {
    warnings.push('C-rescale does not support anisotropic coupling in GROMACS 2025; Parrinello-Rahman is used instead.');
    barostat = 'parrinello-rahman';
  }
  if (THERMOSTATS[thermostat].deprecated) warnings.push(`${THERMOSTATS[thermostat].label}: ${THERMOSTATS[thermostat].note}`);
  if (barostat !== 'none' && BAROSTATS[barostat].deprecated) warnings.push(`${BAROSTATS[barostat].label}: ${BAROSTATS[barostat].note}`);
  const posres = !!s.posres;
  if (posres && barostat === 'parrinello-rahman') {
    warnings.push('Parrinello-Rahman with position restraints can be unstable (grompp notes this); C-rescale is the better barostat for restrained equilibration.');
  }
  let tcGroups = (Array.isArray(s.tcGroups) ? s.tcGroups : words(s.tcGroups)).filter(Boolean);
  if (!tcGroups.length) tcGroups = ['System'];
  if (s.stage === 'anneal' && barostat !== 'none' && tcGroups.length > 1) {
    warnings.push('Annealing with pressure coupling needs a single temperature group (C-rescale needs one ensemble temperature): tc-grps = System is used.');
    tcGroups = ['System'];
  }
  let genVel = st.dynamics ? !!s.genVel : false;
  let continuation = st.dynamics ? !!s.continuation : false;
  if (genVel && continuation) {
    warnings.push('gen-vel = yes and continuation = yes contradict each other; continuation = no is used with new velocities.');
    continuation = false;
  }
  if (genVel && barostat === 'parrinello-rahman') {
    warnings.push('Parrinello-Rahman with newly generated velocities: grompp warns, as the system is not yet equilibrated. Equilibrate with C-rescale first.');
  }

  // Output intervals: nstenergy a multiple of nstcalcenergy, nstcomm equal to it.
  const o = s.output || {};
  const steps = (ps) => (Number(ps) > 0 ? psToSteps(ps, dt) : 0);
  const nstxtc = st.dynamics ? steps(o.xtcPs) : 0;
  const nsttrr = st.dynamics ? steps(o.trrPs) : 0;
  const nstenergy = st.dynamics ? steps(o.energyPs) : Math.max(0, Math.round(Number(o.energySteps) || 0));
  const nstlog = st.dynamics ? steps(o.logPs) : Math.max(0, Math.round(Number(o.logSteps) || 0));
  let nstcalcenergy = 100;
  if (st.dynamics && nstenergy > 0) {
    nstcalcenergy = 1;
    for (let d = Math.min(100, nstenergy); d >= 1; d--) if (nstenergy % d === 0) { nstcalcenergy = d; break; }
  }

  /* ---- header ---- */
  const lines = [];
  const title = `${st.label}`;
  const bits = [ff.label];
  if (st.dynamics) {
    bits.push(`${s.temperature} K`);
    if (barostat !== 'none') bits.push(`${s.pressure} bar`);
    bits.push(formatDuration(nsteps * dt));
    if (hmr) bits.push('HMR, 4 fs');
  }
  lines.push(`; ${title}: ${fileBase(s.stage)}.mdp`);
  lines.push(`; ${bits.join(' | ')}`);
  lines.push(`; Written by the STEMKit MD workflow generator for GROMACS ${MDP_RELEASE}.`);
  lines.push(`; Every option: ${MDP_MANUAL}`);
  for (const r of ff.references) lines.push(`; ${r.text}: ${r.url}`);
  for (const n of ff.notes || []) lines.push(`; Note: ${n}`);
  if (ff.id === 'gromos54a7') {
    lines.push('; grompp warns for every GROMOS topology (twin-range parametrisation, see the note above);',
      '; no .mdp setting avoids it: read the warning, then run grompp with -maxwarn 1.');
  }

  /* ---- preprocessing ---- */
  const defines = [];
  if (posres) defines.push(s.posresDefine || '-DPOSRES');
  for (const d of words(s.define)) if (!defines.includes(d)) defines.push(d);
  if (defines.length) {
    head('Preprocessing');
    put('define', defines.join(' '), posres ? 'switch on the position restraints of the topology (posre.itp); they hold the solute while the solvent relaxes' : 'topology macros');
  }

  /* ---- run control ---- */
  head('Run control');
  if (!st.dynamics) {
    put('integrator', st.integrator, st.integrator === 'steep' ? 'steepest descent: robust for relieving clashes after building and solvating' : 'conjugate gradient: converges further after steepest descent');
    put('emtol', real(s.emtol), `stop when the largest force is below ${s.emtol} kJ mol^-1 nm^-1`);
    if (st.integrator === 'steep') put('emstep', real(s.emstep), 'initial step size (nm)');
    else put('nstcgsteep', 1000, 'a steepest-descent step every 1000 steps keeps CG efficient');
    put('nsteps', nsteps, 'upper limit on minimisation steps');
  } else {
    put('integrator', 'md', 'leap-frog molecular dynamics');
    put('dt', real(dt), hmr ? '4 fs, possible because hydrogens are 3x heavier (mass-repartition-factor) and bonds to H are constrained'
      : cg ? '20 fs, the usual Martini time step' : '2 fs, possible because bonds to hydrogen are constrained');
    put('nsteps', nsteps, `${nsteps} x ${dt} ps = ${formatDuration(nsteps * dt)}`);
    if (hmr) put('mass-repartition-factor', real(3), 'hydrogens become 3x heavier, the mass taken from their bonded atom (GROMACS manual: a factor of 3 with h-bonds constraints allows 4 fs)');
    put('comm-mode', 'Linear', 'remove centre-of-mass drift');
    put('nstcomm', nstcalcenergy, 'as often as energies are calculated, so it costs no extra communication');
  }

  /* ---- output ---- */
  head('Output control');
  if (!st.dynamics) {
    put('nstlog', nstlog, 'minimisation progress to the log every so many steps');
    put('nstenergy', nstenergy, 'energies to the .edr file every so many steps (plot with gmx energy)');
    put('nstxout', 0, 'no trajectory; the minimised structure is written at the end');
  } else {
    put('nstxout-compressed', nstxtc, nstxtc ? `coordinates to the .xtc file every ${formatDuration(nstxtc * dt)}` : 'no .xtc trajectory');
    if (nstxtc && String(o.xtcGroups || '').trim()) put('compressed-x-grps', o.xtcGroups, 'only these groups go to the .xtc file');
    if (cg && nstxtc) put('compressed-x-precision', 100, 'precision of 0.01 nm is plenty for coarse-grained beads');
    put('nstxout', nsttrr, nsttrr ? `full-precision coordinates to the .trr file every ${formatDuration(nsttrr * dt)}` : 'no .trr coordinates; the checkpoint holds the full state for continuing');
    put('nstvout', nsttrr, nsttrr ? 'velocities with them' : 'no .trr velocities');
    put('nstfout', 0, 'no forces');
    put('nstenergy', nstenergy, nstenergy ? `energies to the .edr file every ${formatDuration(nstenergy * dt)}` : 'no energy file output');
    put('nstcalcenergy', nstcalcenergy, 'calculate energies every so many steps; nstenergy is a multiple of it');
    put('nstlog', nstlog, nstlog ? `energies to the log every ${formatDuration(nstlog * dt)}` : 'only first and last step in the log');
  }

  /* ---- neighbour searching and non-bonded interactions ---- */
  head('Neighbour searching and non-bonded interactions');
  put('cutoff-scheme', 'Verlet', 'buffered pair lists, the only scheme GROMACS supports');
  put('nstlist', ff.nstlist, cg ? 'Martini: pair list every 20 steps' : 'pair-list update interval; mdrun may raise it, accuracy is kept by the buffer');
  put('pbc', 'xyz', 'periodic in all directions');
  if (st.dynamics) put('verlet-buffer-tolerance', real(0.005), 'grompp sizes the pair-list buffer (rlist) from this; the default');
  put('coulombtype', ff.coulombtype, ff.why.cutoff);
  put('rcoulomb', real(ff.rcoulomb), 'real-space Coulomb cut-off (nm)');
  if (ff.epsilonR !== null) put('epsilon-r', ff.epsilonR, 'Martini screens electrostatics with a relative dielectric constant of 15');
  if (ff.epsilonRf !== null) put('epsilon-rf', ff.epsilonRf, 'reaction field with infinite dielectric beyond the cut-off');
  put('vdwtype', ff.vdwtype, 'Lennard-Jones with a cut-off');
  put('vdw-modifier', ff.vdwModifier, ff.vdwModifier === 'Force-switch' ? 'CHARMM36 needs the force switched to zero' : 'shift the potential to zero at the cut-off (forces unchanged)');
  if (ff.rvdwSwitch !== null) put('rvdw-switch', real(ff.rvdwSwitch), 'switching starts here (nm)');
  put('rvdw', real(ff.rvdw), 'Lennard-Jones cut-off (nm); must equal rcoulomb with the Verlet scheme');
  put('DispCorr', ff.dispCorr, ff.why.dispCorr);
  if (ff.coulombtype === 'PME') {
    put('fourierspacing', real(0.12), 'PME grid spacing (nm); mdrun may tune it with the cut-off');
    put('pme-order', 4, 'cubic interpolation, the only order GPUs support');
  }

  /* ---- temperature coupling ---- */
  if (st.dynamics) {
    head('Temperature coupling');
    const th = THERMOSTATS[thermostat];
    const tau = ff.tauT[thermostat];
    put('tcoupl', th.value, thermostat === 'v-rescale' ? 'stochastic velocity rescaling: correct canonical ensemble (Bussi et al. 2007)'
      : thermostat === 'nose-hoover' ? 'Nose-Hoover: tau-t is the period of the temperature oscillations' : 'Berendsen: deprecated, grompp warns');
    if (thermostat === 'nose-hoover') put('nh-chain-length', 1, 'leap-frog supports only chains of length 1');
    put('tc-grps', tcGroups.join(' '), tcGroups.length > 1 ? 'coupled separately; the names must exist as default or index groups (grompp -n)' : 'the whole system as one group');
    put('tau-t', tcGroups.map(() => real(tau)).join(' '), `time constant (ps) for each group${thermostat === 'nose-hoover' ? '; the manual advises 4-5 times a first-order time constant' : ''}`);
    const T = Number(s.temperature);
    put('ref-t', tcGroups.map(() => real(T)).join(' '), 'target temperature (K) for each group');
  }

  /* ---- simulated annealing ---- */
  if (s.stage === 'anneal') {
    head('Simulated annealing');
    const pts = (s.anneal.points || []).map(p => [Number(p[0]), Number(p[1])]).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (pts.length < 2) warnings.push('An annealing schedule needs at least two points; the default schedule is used.');
    const use = pts.length >= 2 ? pts : defaultSettings('anneal').anneal.points;
    if (use[0][0] > 0) warnings.push('The first annealing point must be at t = 0 (tinit); grompp stops otherwise.');
    const type = s.anneal.type === 'periodic' ? 'periodic' : 'single';
    put('annealing', tcGroups.map(() => type).join(' '), type === 'single' ? 'one pass through the schedule, then hold the last temperature' : 'repeat the schedule');
    put('annealing-npoints', tcGroups.map(() => use.length).join(' '), 'control points per group');
    put('annealing-time', tcGroups.map(() => use.map(p => real(p[0])).join(' ')).join('  '), 'times (ps) of the points, group after group');
    put('annealing-temp', tcGroups.map(() => use.map(p => real(p[1])).join(' ')).join('  '), 'temperatures (K) at those times');
    const end = nsteps * dt;
    if (use[use.length - 1][0] > end) warnings.push(`The annealing schedule runs to ${use[use.length - 1][0]} ps but the run is ${formatDuration(end)} long.`);
  }

  /* ---- pressure coupling ---- */
  if (st.dynamics) {
    head('Pressure coupling');
    if (barostat === 'none') {
      put('pcoupl', 'no', 'constant volume (NVT)');
    } else {
      const b = BAROSTATS[barostat];
      put('pcoupl', b.value, barostat === 'c-rescale' ? 'stochastic cell rescaling: correct fluctuations, fine for equilibration and production (Bernetti and Bussi 2020)'
        : barostat === 'parrinello-rahman' ? 'extended ensemble; best once the system is equilibrated' : 'Berendsen: deprecated, grompp warns');
      put('pcoupltype', couplingType, couplingType === 'semiisotropic' ? 'membrane plane (x/y) and normal (z) scaled separately'
        : couplingType === 'anisotropic' ? 'every box element scaled on its own' : 'the box keeps its shape');
      const tauP = ff.tauP[barostat];
      put('tau-p', real(tauP), barostat === 'parrinello-rahman' ? 'time constant (ps); the manual advises 4-5 times that of a first-order barostat' : 'time constant (ps)');
      const k = ff.compressibility;
      const P = Number(s.pressure);
      const count = couplingType === 'isotropic' ? 1 : couplingType === 'semiisotropic' ? 2 : 6;
      const comp = count === 6 ? [k, k, k, 0, 0, 0] : Array(count).fill(k);
      const refp = count === 6 ? [P, P, P, 0, 0, 0] : Array(count).fill(P);
      put('compressibility', comp.map(real).join(' '), cg ? 'Martini: 3e-4 bar^-1' : 'compressibility of water, 4.5e-5 bar^-1' + (count === 2 ? ' (x/y, z)' : count === 6 ? ' (xx yy zz xy xz yz)' : ''));
      put('ref-p', refp.map(real).join(' '), `target pressure (bar)${count === 2 ? ' (x/y, z)' : ''}`);
      if (posres) put('refcoord-scaling', 'com', 'scale the restraint reference positions with the box, as grompp requires with pressure coupling');
    }
  }

  /* ---- bonds ---- */
  head('Bonds and constraints');
  const constraints = st.dynamics ? ff.constraints : 'none';
  put('constraints', constraints, !st.dynamics ? 'flexible bonds let the minimiser relax bond lengths too'
    : constraints === 'h-bonds' ? 'bonds to hydrogen are rigid, which allows the time step above' : 'Martini topologies bring their own [ constraints ]');
  put('constraint-algorithm', 'LINCS', 'fast parallel constraint solver');
  if (st.dynamics) {
    put('continuation', continuation ? 'yes' : 'no', continuation ? 'continues the previous stage (grompp -t state.cpt): do not re-constrain the start'
      : 'first dynamics after minimisation: constrain the starting structure');
    put('lincs-iter', 1, 'enough with a thermostat');
    put('lincs-order', 4, 'enough for normal MD');
  }

  /* ---- velocities ---- */
  if (st.dynamics) {
    head('Velocity generation');
    put('gen-vel', genVel ? 'yes' : 'no', genVel ? 'random velocities for the first dynamics run' : 'keep the velocities from the previous stage');
    if (genVel) {
      put('gen-temp', real(s.temperature), 'from a Maxwell distribution at the target temperature');
      put('gen-seed', -1, 'random seed; -1 picks one');
    }
  }

  /* ---- pulling ---- */
  if (s.stage === 'pull') {
    head('COM pulling');
    const p = s.pull;
    const steered = p.mode === 'steered';
    const geometry = p.geometry === 'direction' ? 'direction' : 'distance';
    const outSteps = Math.max(1, psToSteps(Number(p.outputPs) || 1, dt));
    put('pull', 'yes', 'switch on the pull code');
    put('pull-ngroups', 2, 'a reference group and a pulled group');
    put('pull-ncoords', 1, 'one pull coordinate');
    put('pull-group1-name', p.group1, 'reference group (index group name)');
    put('pull-group2-name', p.group2, 'pulled group (index group name)');
    put('pull-coord1-type', 'umbrella', 'harmonic potential on the coordinate');
    put('pull-coord1-geometry', geometry, geometry === 'distance' ? 'the distance between the two centres of mass' : 'the distance along pull-coord1-vec');
    put('pull-coord1-groups', '1 2', 'from group 1 to group 2');
    put('pull-coord1-dim', p.dim || 'Y Y Y', 'dimensions the coordinate uses');
    if (geometry === 'direction') put('pull-coord1-vec', p.vec || '0 0 1', 'pull direction (normalised by grompp)');
    put('pull-coord1-start', 'yes', 'start the reference at the current value');
    put('pull-coord1-rate', real(steered ? Number(p.rateNmPerPs) : 0), steered ? 'reference moves at this rate (nm/ps): steered MD' : 'fixed reference: one umbrella-sampling window');
    put('pull-coord1-k', real(Number(p.k)), 'force constant (kJ mol^-1 nm^-2)');
    put('pull-nstxout', outSteps, `pull coordinate to pullx.xvg every ${formatDuration(outSteps * dt)}`);
    put('pull-nstfout', outSteps, `pull force to pullf.xvg every ${formatDuration(outSteps * dt)}`);
  }

  // Format: aligned like mdout.mdp, comments after ';'.
  const width = Math.max(24, ...out.filter(x => !x.heading).map(x => x.name.length));
  const valueWidth = Math.min(28, Math.max(12, ...out.filter(x => !x.heading).map(x => x.value.length)));
  for (const x of out) {
    if (x.heading) { lines.push('', `; ---- ${x.section} ----`); continue; }
    const left = `${x.name.padEnd(width)} = ${x.value}`;
    lines.push(x.comment ? `${left.padEnd(width + 3 + valueWidth)} ; ${asciiOnly(x.comment)}` : left);
  }
  const text = `${lines.join('\n')}\n`;

  // What grompp will say about it.
  const context = { posres, forceField: ff.id, system: ff.resolution === 'coarse-grained' ? 'coarse-grained' : 'all-atom' };
  const { issues } = checkMdp(text, { context });
  const expected = issues.filter(i => i.source === 'grompp').map(i => ({ severity: i.severity, id: i.id, message: i.message }));
  for (const i of issues.filter(x => x.source !== 'grompp' && x.severity !== 'note')) warnings.push(i.message);

  return {
    text,
    fileName: `${fileBase(s.stage)}.mdp`,
    stage: s.stage,
    settings: { ...s, dt, nsteps, barostat, thermostat, couplingType, tcGroups, hmr, genVel, continuation },
    entries: out.filter(x => !x.heading).map(({ name, value, comment, section: sec }) => ({ name, value, comment, section: sec })),
    warnings,
    expected
  };
}

function fileBase(stage) {
  return stage;
}

/* A real as people write it in .mdp files: 1.0, 0.002, 4.5e-5. */
function real(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return String(x);
  if (Number.isInteger(n)) return n.toFixed(1);
  if (Math.abs(n) < 1e-3) return n.toExponential().replace(/e([+-])(\d)$/, 'e$1$2').replace('e+', 'e');
  return String(Number(n.toPrecision(10)));
}

function asciiOnly(s) {
  return String(s).replace(/[⁻]/g, '^-').replace(/[²]/g, '2').replace(/[–—]/g, '-').replace(/[^\x20-\x7e]/g, '');
}

/**
 * Files for a whole workflow, sharing one set of choices: by default
 * minimisation, NVT and NPT equilibration and production.
 *
 * @param {object} [settings] - As for {@link generateMdp}, applied to every stage
 *   (the stage-specific defaults for position restraints, velocities and
 *   output still apply unless given).
 * @param {string[]} [stages]
 * @returns {Array<ReturnType<typeof generateMdp>>}
 */
export function generateWorkflow(settings = {}, stages = ['em', 'nvt', 'npt', 'prod']) {
  const shared = { ...settings };
  delete shared.stage;
  delete shared.perStage;
  // What differs from stage to stage keeps the stage's default unless set
  // for that stage in settings.perStage.
  for (const k of ['posres', 'genVel', 'continuation', 'lengthNs', 'nsteps', 'output']) delete shared[k];
  return stages.map(stage => generateMdp({ ...shared, stage, ...((settings.perStage || {})[stage] || {}) }));
}
