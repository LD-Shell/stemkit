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
 *     works; the file is not preprocessed, so `#include` is not allowed;
 *   - white space is C's (space, tab and line breaks): a no-break space or a
 *     byte-order mark is part of a word, and lines end at a line feed only,
 *     so a file with old Mac line ends (a lone carriage return) is one line.
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

/* ------------------------------------------------------------------ *
 * GROMACS versions
 * ------------------------------------------------------------------ */

const versionRecord = (id, release, note = '') => Object.freeze({
  id, label: `GROMACS ${id}`, release, note,
  manual: `https://manual.gromacs.org/${release}/user-guide/mdp-options.html`
});

/**
 * The GROMACS releases files are written for and checked as, newest first.
 * The option table is GROMACS 2025.1's; what the older releases do not
 * read, or read differently, is in {@link MDP_VERSION_CHANGES}. It was found
 * by comparing the readers (readir.cpp with readpull.cpp, readrot.cpp, the
 * AWH reader and the MDModules' options) and the checks of the last patch
 * release of each series, `release` below, and confirmed with their grompp.
 * From 2022 to 2025 options were only added, never renamed or removed, and
 * no value changed its spelling; two defaults changed.
 */
export const GROMACS_VERSIONS = Object.freeze([
  versionRecord('2025', TABLE.release),
  versionRecord('2024', '2024.6'),
  versionRecord('2023', '2023.5', 'Ubuntu 24.04 packages GROMACS 2023.3'),
  versionRecord('2022', '2022.6')
]);
const VERSION_BY_ID = new Map(GROMACS_VERSIONS.map(v => [v.id, v]));

/** The version files are written for unless another is chosen. */
export const DEFAULT_GROMACS_VERSION = '2025';

/**
 * The version a choice means: '2023', 2023, '2023.3' and 'GROMACS 2023' are
 * all 2023. Anything that is not one of {@link GROMACS_VERSIONS} is the default.
 *
 * @param {string|number} [version]
 * @returns {string} e.g. '2023'
 */
export function gromacsVersion(version) {
  const m = /(20\d\d)/.exec(String(version == null ? '' : version));
  return m && VERSION_BY_ID.has(m[1]) ? m[1] : DEFAULT_GROMACS_VERSION;
}

/** The record of a version: label, the patch release read, its manual. */
export function gromacsVersionInfo(version) {
  return VERSION_BY_ID.get(gromacsVersion(version));
}

const added = (since, note, ...options) => options.map(option => Object.freeze({ option, since, change: 'added', note }));

/**
 * What changed in the .mdp options from GROMACS 2022 to 2025. `added`:
 * grompp reads the option from release `since` on; an older grompp does not
 * know it and warns "Unknown left-hand", which stops it without -maxwarn.
 * `default`: the default was `before` in the releases before `since`.
 * Numbered families are named by their first member (awh1-growth-factor).
 */
export const MDP_VERSION_CHANGES = Object.freeze([
  ...added('2023', 'the ensemble temperature that C-rescale, AWH and MTTK work with; before 2023 they take the ref-t of the temperature groups',
    'ensemble-temperature-setting', 'ensemble-temperature'),
  ...added('2024', 'hydrogen mass repartitioning by grompp; before 2024 the topology itself has to carry the repartitioned masses',
    'mass-repartition-factor'),
  ...added('2024', 'a Verlet buffer that also bounds the error in the pressure; before 2024 only the energy drift sets the buffer',
    'verlet-buffer-pressure-tolerance'),
  ...added('2024', 'the flow profile of deform, which corrects velocities for shear flow from 2024 on', 'deform-init-flow'),
  ...added('2024', 'AWH growth control; before 2024 the growth factor was fixed at 3 and the target was not scaled',
    'awh1-growth-factor', 'awh1-target-metric-scaling', 'awh1-target-metric-scaling-limit'),
  ...added('2024', 'the Colvars module built into GROMACS', 'colvars-active', 'colvars-configfile', 'colvars-seed'),
  ...added('2025', 'expanded-ensemble counts carried over between runs', 'init-lambda-counts', 'init-wl-histogram-counts'),
  ...added('2025', 'neural-network potentials', 'nnpot-active', 'nnpot-modelfile', 'nnpot-input-group',
    'nnpot-model-input1', 'nnpot-model-input2', 'nnpot-model-input3', 'nnpot-model-input4'),
  Object.freeze({ option: 'tau-p', since: '2024', change: 'default', before: '1',
    note: 'the default pressure-coupling time is 5 ps from 2024 on, 1 ps before' }),
  Object.freeze({ option: 'awh-nsamples-update', since: '2025', change: 'default', before: '10',
    note: 'the default is 100 samples per AWH update from 2025 on, 10 before' })
]);

/* What to do instead, for a file meant for a release that lacks the option. */
const VERSION_ADVICE = {
  'ensemble-temperature-setting': 'Leave it out: before 2023, C-rescale, AWH and MTTK take the ref-t of the temperature groups.',
  'ensemble-temperature': 'Leave it out: before 2023, C-rescale, AWH and MTTK take the ref-t of the temperature groups.',
  'mass-repartition-factor': 'Before 2024, repartition the hydrogen masses in the topology itself (for example with ParmEd\'s ' +
    'HMassRepartition) and leave the option out.',
  'verlet-buffer-pressure-tolerance': 'Leave it out: before 2024 verlet-buffer-tolerance (or a fixed rlist) alone sets the buffer.',
  'deform-init-flow': 'Leave it out: before 2024 deform keeps no flow profile.',
  'awh1-growth-factor': 'Leave it out: before 2024 the growth factor is 3.',
  'awh1-target-metric-scaling': 'Leave it out: before 2024 the target is not scaled by the friction metric.',
  'awh1-target-metric-scaling-limit': 'Leave it out: before 2024 the target is not scaled by the friction metric.',
  'colvars-active': 'Before 2024, Colvars needs a GROMACS patched with the Colvars library.',
  'nnpot-active': 'Neural-network potentials need GROMACS 2025.'
};
const ADDED_IN = new Map(MDP_VERSION_CHANGES.filter(c => c.change === 'added').map(c => [c.option, c]));
const DEFAULT_BEFORE = new Map(MDP_VERSION_CHANGES.filter(c => c.change === 'default').map(c => [c.option, c]));

/* Whether the grompp of a version reads a row of the table. */
function rowInVersion(row, version) {
  const c = ADDED_IN.get(row.n);
  return !c || Number(version) >= Number(c.since);
}

/* A row's default in a version. */
function rowDefault(row, version) {
  const c = DEFAULT_BEFORE.get(row.n);
  return c && Number(version) < Number(c.since) ? c.before : row.d;
}

/**
 * What a version lacks or reads differently, compared with the newest:
 * the {@link MDP_VERSION_CHANGES} after it.
 *
 * @param {string|number} version
 * @returns {Array<{option:string, since:string, change:'added'|'default', note:string, before?:string}>}
 */
export function versionChanges(version) {
  const v = Number(gromacsVersion(version));
  return MDP_VERSION_CHANGES.filter(c => Number(c.since) > v);
}

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

/* The spellings grompp's reader takes for an enum: the documented values it
   accepts, then the rest of its string table. */
function enumSpellings(row) {
  const docs = (row.v || []).filter(v => !(v[3] && v[3][0] === 'rejected'));
  return [...docs.map(v => v[0]), ...(row.acc || [])];
}

/* Options of the MDModules, read through the options framework rather than
   by get_ir. */
function isModuleRow(row) {
  return /^(electric-field|density-guided|qmmm-cp2k|colvars|nnpot)/.test(row.n);
}

/*
 * The spelling grompp reads a value as, or null when it refuses it. The .mdp
 * reader compares as normaliseName does (case, - and _ ignored); the options
 * framework of the MDModules takes the shortest value that starts with what
 * is written, with case (findEnumValue in basicoptions.cpp), so for those
 * `inner` is inner-product and `Inner-Product` is refused.
 */
function matchEnumValue(row, raw) {
  const all = enumSpellings(row);
  if (isModuleRow(row)) {
    const hits = all.filter(a => a.startsWith(raw));
    return hits.length ? hits.sort((a, b) => a.length - b.length)[0] : null;
  }
  const k = key(raw);
  return all.find(a => key(a) === k) || null;
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
 * @property {string[]} accepted - The spellings of an enum to offer: the documented
 *   values grompp reads (their `status` says which are deprecated or refused
 *   later) and the undocumented ones that do not make grompp or mdrun stop.
 * @property {Array<{value:string, status:string|null, note:string}>} undocumented -
 *   Every spelling grompp's reader takes that the manual does not describe, with
 *   what then happens (status as for `values`; null for a plain alias such as
 *   Potential-shift-Verlet). Summaries and notes of family members name the
 *   member itself (pull-coord2-k, not pull-coord1-k).
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
 *   when that differs from `default`: an alias (Potential-shift-Verlet for
 *   Potential-shift), or a value grompp replaces (awh1-dim1-diffusion: 0, run as 1e-5).
 * @property {string|null} since - The first GROMACS release that reads the
 *   option, when it is newer than 2022 (see {@link MDP_VERSION_CHANGES}).
 * @property {{value:string, before:string}|null} olderDefault - The default in
 *   the releases before `before`, when it changed (tau-p: 1 before 2024).
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
  const here = (text) => localise(text, row, hit.index);
  const values = (row.v || []).map(v => ({
    value: v[0],
    summary: here(v[1] || ''),
    url: mdpDocUrl(row.n, v[0]),
    status: v[3] ? v[3][0] : null,
    note: v[3] ? here(v[3][1]) : ''
  }));
  const undocumented = (row.acc || []).map(a => {
    const st = (row.as || {})[a];
    return { value: a, status: st ? st[0] : null, note: st ? st[1] : '' };
  });
  let accepted = [];
  // Undocumented spellings that make grompp or mdrun stop are left out.
  if (row.k === 'enum') {
    accepted = [...values.filter(v => v.status !== 'rejected').map(v => v.value),
      ...undocumented.filter(u => u.status !== 'unsupported' && u.status !== 'removed').map(u => u.value)];
  }
  if (row.k === 'boolean') accepted = ['yes', 'no', 'true', 'false', '1', '0'];
  const fam = row.f ? { template: row.f[0], count: row.f[1], first: row.f[2], inner: row.f[3] || null, index: hit.index } : null;
  return {
    name: hit.name,
    section: { id: section.id, title: section.title, url: section.url },
    kind: row.k,
    default: row.d,
    defaultFrom: row.df ? familyName(row.df, hit.index) : null,
    unit: row.u || '',
    summary: here(row.t),
    undocumented,
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
    gromppDefault: row.gd || null,
    since: ADDED_IN.has(row.n) ? ADDED_IN.get(row.n).since : null,
    olderDefault: DEFAULT_BEFORE.has(row.n) ? { value: DEFAULT_BEFORE.get(row.n).before, before: DEFAULT_BEFORE.get(row.n).since } : null
  };
}

/*
 * Text written for the first member of a numbered family, made to name the
 * member at hand: for pull-coord2-type, "pull-coord1-k is minus the force"
 * becomes "pull-coord2-k is minus the force".
 */
function localise(text, row, index) {
  if (!text || !row.f || !index || !index.length) return text;
  const first = row.f[2];
  const [template] = row.f;
  if (index.every(i => i === first)) return text;
  if (template.startsWith('awh{N}-')) {
    const [b, d] = index;
    return text.replace(/\bawh1-dim1-/g, `awh${b}-dim${d ?? 1}-`).replace(/\bawh1-(?!dim)/g, `awh${b}-`);
  }
  if (template.startsWith('pull-coord{N}-')) return text.replace(/\bpull-coord1-/g, `pull-coord${index[0]}-`);
  if (template.startsWith('pull-group{N}-')) return text.replace(/\bpull-group1-/g, `pull-group${index[0]}-`);
  if (template.startsWith('iontype{N}-')) return text.replace(/\biontype0-/g, `iontype${index[0]}-`);
  if (template.startsWith('rot-')) return text.replace(/\b(rot-[a-z-]+)0\b/g, `$1${index[0]}`);
  return text;
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
 * @param {{section?:string, undocumented?:boolean, version?:string}} [options] -
 *   `version`: only the options that GROMACS release reads.
 * @returns {string[]}
 */
export function listOptions(options = {}) {
  const { section = null, undocumented = true } = options;
  const version = options.version ? gromacsVersion(options.version) : null;
  return ROWS.filter(r => (!section || SECTIONS[r.s].id === section) && (undocumented || !r.x) &&
    (!version || rowInVersion(r, version))).map(r => r.n);
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

/*
 * White space as C's isspace() sees it in the "C" locale. grompp trims values
 * and splits lists on these six characters only, so a no-break space (U+00A0,
 * common in text copied from web pages) or a byte-order mark stays part of the
 * word, where JavaScript's trim() and \s would quietly drop it.
 */
const C_SPACE = '[ \\t\\n\\v\\f\\r]';
const LEADING_SPACE = new RegExp(`^${C_SPACE}+`);
const TRAILING_SPACE = new RegExp(`${C_SPACE}+$`);
const SPACES = new RegExp(`${C_SPACE}+`);
const ctrim = (s) => String(s).replace(LEADING_SPACE, '').replace(TRAILING_SPACE, '');

/* One number as strtod reads it: hexadecimal first, since the decimal
   alternative would otherwise stop at the 0 of 0x1p-3. */
const C_NUMBER = new RegExp(`^${C_SPACE}*([+-]?(?:0x(?:[0-9a-f]+\\.?[0-9a-f]*|\\.[0-9a-f]+)(?:p[+-]?\\d+)?|` +
  '(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?|inf(?:inity)?|nan(?:\\([0-9a-z_]*\\))?))', 'i');

/* The largest float: a mixed-precision grompp keeps reals in single precision. */
const FLT_MAX = 3.4028234663852886e38;
const DBL_MIN = 2.2250738585072014e-308;
const INT_MIN = -2147483648;
const INT_MAX = 2147483647;

/*
 * strtol(s, &end, 10) as get_eint and get_eint64 use it: leading blanks, a
 * sign, digits; the rest must be empty. strtol saturates at the 64-bit limits,
 * and get_eint then stores the result in an int, keeping the low 32 bits, so
 * nstlist = 2147483648 becomes -2147483648 (`wrapped`).
 */
function cInteger(s, bits = 32) {
  const m = new RegExp(`^${C_SPACE}*([+-]?\\d+)`).exec(s);
  if (!m) return { value: 0, ok: false, wrapped: false };
  const written = BigInt(m[1]);
  const LIMIT = 1n << 63n;
  let stored = written >= LIMIT ? LIMIT - 1n : written < -LIMIT ? -LIMIT : written;
  if (bits === 32) stored = BigInt.asIntN(32, stored);
  return { value: Number(stored), ok: m[0].length === s.length, wrapped: stored !== written };
}

/* strtod: decimal or hexadecimal, inf, nan. `range` is false where strtod
   sets ERANGE: overflow to infinity, or a non-zero number that underflows. */
function cReal(s) {
  const m = C_NUMBER.exec(s);
  if (!m) return { value: 0, ok: false, range: true };
  const t = m[1];
  let value;
  let nonZero = false;
  if (/^[+-]?0x/i.test(t)) {
    const [, mant, exp] = /0x([0-9a-f.]+)(?:p([+-]?\d+))?/i.exec(t);
    const [ip, fp = ''] = mant.split('.');
    nonZero = /[1-9a-f]/i.test(mant);
    value = (parseInt(ip || '0', 16) + (fp ? parseInt(fp, 16) / 16 ** fp.length : 0)) * 2 ** Number(exp || 0);
    if (t.startsWith('-')) value = -value;
  } else if (/inf/i.test(t)) {
    value = t.startsWith('-') ? -Infinity : Infinity;
  } else if (/nan/i.test(t)) {
    value = NaN;
  } else {
    value = Number(t);
    nonZero = /[1-9]/.test(t.replace(/e.*$/i, ''));
  }
  const overflow = !Number.isFinite(value) && !/inf|nan/i.test(t);
  const underflow = nonZero && Math.abs(value) < DBL_MIN;
  return { value, ok: m[0].length === s.length, range: !overflow && !underflow };
}

/* gmx::fromString<real> (floatFromString): the whole word must be a number,
   without ERANGE and within the range of a float, so inf and 1e39 are
   refused while nan gets through. */
function strictReal(s) {
  const str = String(s);
  const r = cReal(str);
  if (!r.ok || str === '' || !r.range || Math.abs(r.value) > FLT_MAX) return null;
  return r.value;
}

/* gmx::fromString<int> (intFromString): the whole word, within an int. */
function strictInt(s) {
  const m = new RegExp(`^${C_SPACE}*([+-]?\\d+)$`).exec(String(s));
  if (!m) return null;
  const v = Number(m[1]);
  return v < INT_MIN || v > INT_MAX ? null : v;
}

/* splitString: words separated by C white space. */
const words = (s) => String(s || '').split(SPACES).filter(Boolean);

/* Characters that look like white space or nothing but are not C white
   space: a hint for values grompp refuses although they look right. */
function hiddenCharacters(s) {
  const found = [];
  if (/\u00a0/.test(s)) found.push('a no-break space (U+00A0), which grompp does not treat as a space');
  if (/\ufeff/.test(s)) found.push('a byte-order mark (U+FEFF), which grompp reads as part of the text');
  if (/\r/.test(s)) found.push('a lone carriage return (old Mac line ends), which grompp does not treat as a line break');
  if (/[\u2000-\u200b\u202f\u205f\u3000]/.test(s)) found.push('a Unicode space that grompp does not treat as a space');
  return found.length ? ` It contains ${found.join(' and ')}.` : '';
}

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
  // grompp's TextReader breaks lines at \n only: with Windows line ends the \r
  // is trimmed as white space, but a lone \r (old Mac files) is not a line
  // break, so such a file is one long line to grompp and to this reader.
  const raw = String(text == null ? '' : text).split('\n');
  if (raw.length && raw[raw.length - 1] === '') raw.pop();
  const entries = [];
  const lines = [];
  const errors = [];
  const seen = new Map();
  const values = {};

  raw.forEach((fileLine, i) => {
    const line = i + 1;
    const rawLine = fileLine.endsWith('\r') ? fileLine.slice(0, -1) : fileLine;
    const semi = fileLine.indexOf(';');
    // TextReader cuts the comment, then trims " \t\r\n" from the end; the
    // name and value are then trimmed of C white space (stripString).
    const code = (semi < 0 ? fileLine : fileLine.slice(0, semi)).replace(/[ \t\r\n]+$/, '');
    const comment = semi < 0 ? '' : ctrim(rawLine.slice(semi + 1));
    if (!code) {
      lines.push({ line, raw: rawLine, kind: comment || semi >= 0 ? 'comment' : 'blank', comment });
      return;
    }
    const eq = code.indexOf('=');
    if (eq < 0) {
      errors.push({
        line, id: 'no-equals',
        message: `No "=" on this line, so grompp cannot tell the option from its value: "${ctrim(code)}". ` +
          (/^\s*#/.test(code) ? 'An .mdp file is not preprocessed: #include and #define do not work here; ' +
            'use the include and define options instead.' : 'Write it as "name = value".')
      });
      lines.push({ line, raw: rawLine, kind: 'invalid', comment });
      return;
    }
    const k = ctrim(code.slice(0, eq));
    const value = ctrim(code.slice(eq + 1));
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
 *   (SETTLE water; default true, but false when define has -DFLEXIBLE or the
 *   system is coarse-grained), `charged` (default true), `system`
 *   ('all-atom' default, 'coarse-grained', or 'unknown' to skip time-step
 *   estimates), `usedMacros` (names the topology tests with #ifdef; grompp
 *   warns about any other -D in define), `forceField` (a key of {@link FORCE_FIELDS}: GROMOS topologies
 *   always draw a grompp warning, and AMBER, CHARMM and OPLS a note with
 *   constraints = all-bonds), `indexGroups` (names; when given, group names
 *   are checked), `structure` (the coordinates grompp reads with -c and the
 *   index groups built from them, as {@link pullStart} takes them: with pull
 *   = yes, the checks set_pull_init makes of the pull groups and of how far
 *   apart they start).
 * @param {number} [options.maxwarn=0] - grompp -maxwarn.
 * @param {string} [options.version='2025'] - The GROMACS release whose grompp
 *   to answer for, one of {@link GROMACS_VERSIONS}: options it does not read
 *   are unknown to it, defaults and checks are its own.
 * @returns {{issues:MdpIssue[], parsed:ReturnType<typeof parseMdp>,
 *   grompp:{passes:boolean, errors:number, warnings:number, notes:number},
 *   settings:Object<string,*>, version:string}} `settings` holds every option
 *   as grompp resolved it (after its own adjustments, e.g. nstcalcenergy).
 */
export function checkMdp(input, options = {}) {
  const parsed = typeof input === 'string' || input == null ? parseMdp(input) : input;
  const ctx = options.context || {};
  const issues = [];
  const version = gromacsVersion(options.version);
  const run = new Checker(parsed, ctx, issues, version);
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
    settings: run.settings(),
    version
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
/* Keys of the enum spellings with spaces in them: normaliseName keeps the
   spaces, so 'Reaction-Field-nec (unsupported)' is REACTIONFIELDNEC (UNSUPPORTED). */
const CT_GRF = key('Generalized-Reaction-Field (unused)');
const CT_RF_NEC = key('Reaction-Field-nec (unsupported)');
const CT_GB = key('Generalized-Born (unused)');
const I_SD2 = key('sd2 - removed');
const COULOMB = {
  RF: (c) => ['REACTIONFIELD', CT_GRF, CT_RF_NEC, 'REACTIONFIELDZERO'].includes(c),
  PME: (c) => ['PME', 'PMESWITCH', 'PMEUSER', 'PMEUSERSWITCH', 'P3MAD'].includes(c),
  PME_OR_EWALD: (c) => COULOMB.PME(c) || c === 'EWALD',
  FULL: (c) => COULOMB.PME_OR_EWALD(c) || c === 'POISSON',
  USER_TABLE: (c) => ['USER', 'PMEUSER', 'PMEUSERSWITCH'].includes(c)
};
const MIN_STEPS_PER_TAU = 5;
const MIN_STEPS_PER_PERIOD = 20;
const GMX_REAL_EPS = 1.19209290e-07; // GMX_FLOAT_EPS: mixed precision, the usual build
const BOLTZ = 0.0083144626181532; // kJ mol^-1 K^-1

function gcd(x, y) {
  let a = Math.abs(x);
  let b = Math.abs(y);
  while (b) [a, b] = [b, a % b];
  return a;
}

/* lcd3 (md_support.cpp): the largest number dividing each positive input;
   0 when no input is positive, where grompp stops. */
function lcd3(a, b, c) {
  // GROMACS counts down from the smallest input; that number is the greatest
  // common divisor of the positive inputs, found here without the loop.
  return [a, b, c].filter(x => x > 0).reduce(gcd, 0);
}

class Checker {
  constructor(parsed, ctx, issues, version = DEFAULT_GROMACS_VERSION) {
    this.parsed = parsed;
    this.ctx = ctx;
    this.issues = issues;
    // The release whose grompp this is, as a number for comparisons.
    this.version = version;
    this.ver = Number(version);
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
        if (raw === null) { value = row.df ? null : Number(rowDefault(row, this.version)); break; }
        if (this.isModule(row)) {
          // The options framework (fromString<int>) refuses what does not fit.
          value = strictInt(raw);
          if (value === null) {
            const r = cInteger(raw, 64);
            this.add('error', r.ok ? 'integer-overflow' : 'not-integer', name, r.ok
              ? `${name} = ${raw} does not fit in a 32-bit integer (at most ${INT_MAX}). grompp stops here.`
              : `${name} needs a whole number, but "${raw}" is not one.${hiddenCharacters(raw)} grompp stops here.`);
            value = r.value;
          }
          break;
        }
        const r = cInteger(raw, row.i64 ? 64 : 32);
        if (!r.ok) {
          this.add('error', 'not-integer', name, `${name} needs a whole number, but "${raw}" is not one` +
            (/^[+-]?\d*\.\d*([eE][+-]?\d+)?$|^[+-]?\d+[eE]/.test(raw) ? ' (no decimal point or exponent)' : '') +
            `.${hiddenCharacters(raw)} grompp stops here.`);
        } else if (r.wrapped) {
          this.add('warning', 'integer-wrap', name, `${name} = ${raw} does not fit in the ${row.i64 ? '64' : '32'}-bit integer grompp ` +
            `stores it in: grompp reads it, without a message, as ${r.value}.`, { source: 'advice' });
        }
        value = r.value;
        break;
      }
      case 'real': {
        if (raw === null) { value = row.df ? null : Number(rowDefault(row, this.version)); break; }
        const r = cReal(raw);
        if (!r.ok) {
          this.add('error', 'not-real', name, `${name} needs a number, but "${raw}" is not one` +
            (/,/.test(raw) ? ' (use a point, not a comma, for decimals)' : '') + `.${hiddenCharacters(raw)} grompp stops here.`);
        } else if (this.isModule(row) && strictReal(raw) === null) {
          // RealOption (fromString<real>): no overflow, underflow or infinity.
          this.add('error', 'real-range', name, `${name} = ${raw} is outside the range of a single-precision number ` +
            '(an overflow, an underflow or infinity). grompp stops here.');
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
    return isModuleRow(row);
  }

  matchEnum(name, row, raw) {
    const k = key(raw);
    const hit = matchEnumValue(row, raw);
    if (hit) return hit;
    const all = enumSpellings(row);
    const rejected = (row.v || []).find(v => v[3] && v[3][0] === 'rejected' && key(v[0]) === k);
    const shown = (row.v || []).filter(v => !(v[3] && v[3][0] === 'rejected')).map(v => v[0]);
    let message = `"${raw}" is not a value of ${name}.${hiddenCharacters(raw)} ` +
      `grompp stops; use one of: ${shown.join(', ')}` +
      (this.isModule(row) ? ', written exactly so (this option is case-sensitive)' : '') + '.';
    if (rejected) {
      message = `"${raw}" is how the GROMACS manual spells it, but grompp ${this.version} does not accept it: ${rejected[3][1]}`;
    } else if (/^(adress|implicit-solvent)$/.test(name)) {
      message = `${name === 'adress' ? 'AdResS' : 'Implicit solvent'} was removed from GROMACS; grompp accepts only ${name} = no.`;
    } else {
      const near = nearest(raw, all);
      if (near) message += ` Did you mean ${near}?`;
    }
    // The options framework throws on a module value it cannot match
    // (findEnumValue), which stops grompp at once.
    this.add('error', 'bad-enum', name, message, this.isModule(row) ? { fatal: true } : {});
    return row.d;
  }

  /* Read every member of a family (pull-coord{N}-*) for index i. */
  readFamily(template, index) {
    const out = {};
    // Only the members with as many indices as given: awh{N}- is not awh{N}-dim{M}-.
    for (const fam of FAMILIES.filter(f => f.template.startsWith(template) && f.slots.length === index.length)) {
      if (!rowInVersion(fam.row, this.version)) continue;
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
      // An option newer than this grompp is unknown to it (unknownNames).
      if (!rowInVersion(row, this.version)) continue;
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

  /* Why grompp did not read a known option. */
  whyUnread(hit) {
    const row = hit.row;
    if (row.g && !this.gate[row.g]) {
      return `${hit.name} is only read when ${GATE_TEXT[row.g].when}; otherwise grompp does not know it`;
    }
    if (row.f) {
      const fam = FAMILIES.find(f => f.row === row);
      const first = fam.first;
      const n = this.v[fam.count];
      return fam.inner
        ? `${hit.name} is beyond the counts set by ${fam.count} and ${fam.inner.replace('{N}', hit.index[0])}, so grompp does not read it`
        : `${fam.count} = ${n} means grompp reads ${fam.template.replace('{N}', first)} to ${fam.template.replace('{N}', first + n - 1)} only; ` +
          `${hit.name} is not among them`;
    }
    return `grompp did not read ${hit.name}`;
  }

  /* Whatever grompp did not read: "Unknown left-hand '...' in parameter file". */
  unknownNames() {
    for (const e of this.parsed.entries) {
      if (e.empty || e.duplicate) continue;
      const k = key(e.key);
      if (this.used.has(k)) continue;
      if (OBSOLETE.has(k) && !lookup(e.key)) {
        // grompp renames the entry in place (replace_inp_entry) and then
        // reads it under the new name only where that name is read: a
        // renamed pull option is still unknown with pull = no.
        const obs = OBSOLETE.get(k);
        const nk = obs.replacement ? key(obs.replacement) : null;
        if (!nk || this.byKey.get(nk) !== e || this.used.has(nk)) continue;
        const hit = lookup(obs.replacement);
        this.add('warning', 'inactive', hit.name, `"${e.key}" is the old name of ${hit.name}, and ${this.whyUnread(hit)}; grompp warns ` +
          `"Unknown left-hand '${obs.replacement}' in parameter file".`, { line: e.line });
        continue;
      }
      const hit = lookup(e.key);
      if (hit && !rowInVersion(hit.row, this.version)) {
        const since = ADDED_IN.get(hit.row.n).since;
        this.add('warning', 'newer-option', hit.name, `${hit.name} is new in GROMACS ${since}: grompp ${this.version} does not know it and ` +
          `warns "Unknown left-hand '${e.key}' in parameter file", which stops it unless -maxwarn allows it. ` +
          `${VERSION_ADVICE[hit.row.n] || `Leave it out for GROMACS ${this.version}, or run GROMACS ${since} or newer.`}`, { line: e.line });
        continue;
      }
      if (hit) {
        this.add('warning', 'inactive', hit.name, `${this.whyUnread(hit)} and warns "Unknown left-hand '${e.key}' in parameter file".`, { line: e.line });
        continue;
      }
      let hint = '';
      if (key(e.key) === 'LMCMCMOVE') {
        hint = ' The manual documents it as lmc-mc-move, but grompp reads lmc-move.';
      } else {
        let near = nearest(e.key, [...ROWS.filter(r => rowInVersion(r, this.version)).map(r => r.n), ...[...OBSOLETE.values()].map(o => o.name)]);
        // A near miss of an old name points at its replacement.
        const old = near && !ROW_BY_NAME.has(near) ? OBSOLETE.get(key(near)) : null;
        if (old) near = old.replacement || '';
        if (near) hint = ` Did you mean ${near}?`;
      }
      this.add('warning', 'unknown', null, `"${e.key}" is not an option of GROMACS ${this.version}; grompp warns ` +
        `"Unknown left-hand '${e.key}' in parameter file" and stops unless -maxwarn allows it.${hiddenCharacters(e.key)}${hint}`, { line: e.line });
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
      if (ws.length !== 4) {
        this.add('error', 'electric-field', n, `${n} needs four numbers, E0 omega t0 sigma (for a static field: E0 0 0 0). grompp stops.`);
      } else if (ws.some(w => strictReal(w) === null)) {
        this.add('error', 'electric-field', n, `Each of the four numbers of ${n} must be a number within single precision ` +
          `(not inf, nor beyond about 3.4e38); "${ws.find(w => strictReal(w) === null)}" is not. grompp stops.`);
      } else if (strictReal(ws[3]) <= 0 && strictReal(ws[2]) !== 0) {
        // electricfield.cpp tests this before the values are read, so grompp
        // never refuses it; the field is then E0 cos(omega t) whatever t0 is.
        this.add('note', 'electric-field-t0', n, `With sigma = 0 the field in ${n} is not pulsed and t0 has no effect: ` +
          'it is E0 cos(omega t). grompp accepts it; set t0 to 0 to say so.', { source: 'advice' });
      }
    }
    // parsedArrayFromInputString splits at white space only: "0,0,0" is one
    // word to grompp, which then refuses the option.
    for (const [n, need] of [['density-guided-simulation-shift-vector', 3], ['density-guided-simulation-transformation-matrix', 9]]) {
      if (!this.set[n]) continue;
      const parts = words(v[n]);
      if (parts.length !== need || parts.some(w => strictReal(w) === null)) {
        this.add('error', 'density-guided-vector', n, `${n} needs ${need} numbers separated by spaces` +
          `${/,/.test(v[n]) ? ' (not commas: grompp splits the value at spaces only)' : ''}. grompp stops.`);
      }
    }

    // Pulling, AWH and rotation (read_pullparams, AwhParams, read_rotparams)
    if (this.gate.pull) this.pullChecks();
    if (this.hasFatal()) return;
    if (this.gate.awh) this.awhReading();
    if (this.hasFatal()) return;
    if (this.gate.rotation) this.rotationReading();
    if (this.hasFatal()) return;
    if (this.gate.swapcoords && v.iontypes < 1) this.add('error', 'iontypes', 'iontypes', 'At least one ion type is needed for position swapping.');
  }

  /* read_rotparams (readrot.cpp), group by group. */
  rotationReading() {
    const v = this.v;
    if (v['rot-ngroups'] < 1) {
      this.add('error', 'rot-ngroups', 'rot-ngroups', 'rot-ngroups must be 1 or more. grompp stops.', { fatal: true });
      return;
    }
    for (let g = 0; g < v['rot-ngroups']; g++) {
      const p = (s) => `rot-${s}${g}`;
      // string2dvec: sscanf of three numbers, or a fatal error.
      const vec = scanReals(v[p('vec')], 3);
      if (vec.length !== 3) {
        this.add('error', 'rot-vec-count', p('vec'), `${p('vec')} needs three numbers (the rotation axis, x y z); ` +
          `"${v[p('vec')]}" does not give three. grompp stops.`, { fatal: true });
        return;
      }
      if (vec.every(x => x === 0)) this.add('error', 'rot-vec-zero', p('vec'), `${p('vec')} is 0 0 0: the rotation axis needs a direction.`);
      const type = key(v[p('type')]);
      if (['ISO', 'PM', 'RM', 'RM2'].includes(type) && scanReals(v[p('pivot')], 3).length !== 3) {
        this.add('error', 'rot-pivot-count', p('pivot'), `With rot-type ${v[p('type')]}, ${p('pivot')} needs three numbers (x y z in nm). ` +
          'grompp stops.', { fatal: true });
        return;
      }
      if (v[p('k')] <= 0) {
        this.add('note', 'rot-k', p('k'), `${p('k')} is ${v[p('k')]} (the default is 0), so this rotation group feels no force. ` +
          'Set a force constant, such as 500 kJ mol^-1 nm^-2.');
      }
      if (v[p('slab-dist')] <= 0) this.add('error', 'rot-slab-dist', p('slab-dist'), `${p('slab-dist')} must be above 0.`);
      if (v[p('min-gauss')] <= 0) this.add('error', 'rot-min-gauss', p('min-gauss'), `${p('min-gauss')} must be above 0.`);
      if (v[p('eps')] <= 0 && (type === 'RM2' || type === 'FLEX2')) {
        this.add('error', 'rot-eps', p('eps'), `With rot-type ${v[p('type')]}, ${p('eps')} must be above 0.`);
      }
      if (key(v[p('fit-method')]) === 'POTENTIAL' && v[p('potfit-nsteps')] < 1) {
        this.add('error', 'rot-potfit-nsteps', p('potfit-nsteps'), `With the potential fit method, ${p('potfit-nsteps')} must be 1 or more.`);
      }
    }
  }

  /* What the AWH reader checks while reading (AwhParams, read_params.cpp). */
  awhReading() {
    const v = this.v;
    const nbias = v['awh-nbias'];
    if (nbias <= 0) {
      this.add('error', 'awh-nbias', 'awh-nbias', 'awh-nbias must be a whole number above 0. grompp stops.', { fatal: true });
      return;
    }
    const dims = [];
    for (let b = 1; b <= nbias; b++) {
      const q = (s) => `awh${b}-${s}`;
      const target = key(v[q('target')]);
      if (v[q('target-metric-scaling')] === 'yes' && (target === 'BOLTZMANN' || target === 'LOCALBOLTZMANN')) {
        this.add('warning', 'awh-metric-scaling', q('target-metric-scaling'), `Scaling a ${v[q('target')]} target by the friction metric ` +
          'can set up a feedback loop between the two adaptive updates. grompp warns.');
      }
      if (v[q('target-metric-scaling')] === 'yes' && v[q('target-metric-scaling-limit')] <= 1) {
        this.add('warning', 'awh-metric-scaling-limit', q('target-metric-scaling-limit'), `${q('target-metric-scaling-limit')} must be above 1; ` +
          'grompp uses 10 and warns.');
      }
      const ndim = v[q('ndim')];
      if (!(ndim > 0 && ndim <= 4)) {
        this.add('error', 'awh-ndim', q('ndim'), `${q('ndim')} must be between 1 and 4. Note that grompp's default is 0, ` +
          'not 1 as the manual says, so it has to be set. grompp stops.', { fatal: true });
        return;
      }
      for (let d = 1; d <= ndim; d++) {
        const r = (s) => `awh${b}-dim${d}-${s}`;
        if (v[r('coord-index')] < 1) {
          this.add('error', 'awh-coord-index', r('coord-index'), `${r('coord-index')} must be 1 or more: pull coordinates are counted from 1.`);
        }
        if (!this.set[r('diffusion')] || v[r('diffusion')] <= 0) {
          // A note from GROMACS 2023 on; GROMACS 2022 warns.
          this.add(this.ver < 2023 ? 'warning' : 'note', 'awh-diffusion', r('diffusion'), `${r('diffusion')} is not set (or not above 0), so grompp uses 1e-5 nm^2/ps ` +
            `(or rad^2/ps) and ${this.ver < 2023 ? 'warns' : 'notes'} that this may be far from right for the system. Set an estimate.`,
          { line: this.set[r('diffusion')] ? this.set[r('diffusion')].line : (this.set[q('ndim')] ? this.set[q('ndim')].line : null) });
          v[r('diffusion')] = 1e-5;
        }
        const share = v[q('share-group')];
        if (share <= 0 && v[r('cover-diameter')] > 0) {
          this.add('warning', 'awh-cover-diameter', r('cover-diameter'), `${r('cover-diameter')} only matters when simulations share the bias ` +
            `(${q('share-group')} above 0). grompp warns.`);
        }
        if (share > 0 && v[r('cover-diameter')] === 0 && this.ver >= 2024) {
          this.add('warning', 'awh-cover-diameter', r('cover-diameter'), `Simulations share this bias, so set ${r('cover-diameter')} above 0, ` +
            'as grompp strongly recommends (it warns).');
        }
        dims.push({ b, d, pull: key(v[r('coord-provider')]) === 'PULL', index: v[r('coord-index')] });
      }
    }
    // checkInputConsistencyAwh: one pull coordinate per AWH dimension. Pairs
    // within one bias are met twice, as grompp meets them.
    for (const x of dims) {
      for (const y of dims) {
        if (!x.pull || !y.pull || y.b < x.b || (x.b === y.b && x.d === y.d) || x.index !== y.index) continue;
        this.add('error', 'awh-coord-twice', `awh${y.b}-dim${y.d}-coord-index`, `Pull coordinate ${x.index} is used by two AWH dimensions ` +
          `(awh${x.b}-dim${x.d} and awh${y.b}-dim${y.d}); one pull coordinate can bias only one. Duplicate the coordinate if you mean this.`);
      }
    }
    const shares = Array.from({ length: nbias }, (_, i) => v[`awh${i + 1}-share-group`]);
    if (v['awh-share-multisim'] === 'yes' && !shares.some(s => s > 0)) {
      this.add('warning', 'awh-share-multisim', 'awh-share-multisim', 'awh-share-multisim = yes, but no bias has a share-group above 0, ' +
        'so nothing is shared. grompp warns.');
    }
    if (shares.some((s, i) => s > 0 && shares.indexOf(s) !== i)) {
      this.add('warning', 'awh-share-within', 'awh1-share-group', 'Two biases of this simulation have the same share-group, which mdrun ' +
        'does not support (yet). grompp warns.');
    }
  }

  /* checkAwhParams (read_params.cpp), at the end of get_ir. */
  awhProcessing() {
    const v = this.v;
    const nbias = v['awh-nbias'];
    const dims = [];
    for (let b = 1; b <= nbias; b++) {
      for (let d = 1; d <= v[`awh${b}-ndim`]; d++) dims.push({ b, d, fep: key(v[`awh${b}-dim${d}-coord-provider`]) === 'FEPLAMBDA' });
    }
    if (this.useMts && this.validMts) {
      const level = (g) => (this.mtsGroups.includes(g) ? 1 : 0);
      if (dims.some(x => !x.fep) && level('pull') !== level('awh')) {
        this.add('error', 'awh-mts', 'mts-level2-forces', 'With AWH on pull coordinates and multiple time stepping, pull and awh must be ' +
          'in the same MTS level.');
      }
      if (dims.some(x => x.fep) && level('awh') !== 1) {
        this.add('error', 'awh-mts', 'mts-level2-forces', 'With AWH on the free-energy lambda and multiple time stepping, awh must be in ' +
          'mts-level2-forces.');
      }
      if (v['awh-nstsample'] % (level('awh') ? this.mtsFactor : 1) !== 0) {
        this.add('error', 'awh-mts', 'awh-nstsample', 'With AWH in the slow MTS level, awh-nstsample must be a multiple of mts-level2-factor.');
      }
    }
    if (v['awh-nstout'] <= 0) {
      this.add('error', 'awh-nstout', 'awh-nstout', `awh-nstout = ${v['awh-nstout']}: AWH without output makes no sense; set it above 0.`);
    }
    if (v.nstenergy === 0 || v['awh-nstout'] % v.nstenergy !== 0) {
      this.add('error', 'awh-nstout-nstenergy', 'awh-nstout', `awh-nstout (${v['awh-nstout']}) must be a multiple of nstenergy (${v.nstenergy}).`);
    }
    if (v['awh-nsamples-update'] <= 0) this.add('error', 'awh-nsamples-update', 'awh-nsamples-update', 'awh-nsamples-update must be above 0.');
    // grompp checks the biases up to and including the first with a lambda dimension.
    let haveFep = false;
    for (let b = 1; b <= nbias && !haveFep; b++) {
      this.awhBiasChecks(b);
      haveFep = dims.some(x => x.b === b && x.fep);
    }
    if (haveFep) {
      if (v['awh-nstsample'] % v.nstcalcenergy !== 0) {
        this.add('error', 'awh-nstsample-fep', 'awh-nstsample', `With a lambda dimension, awh-nstsample (${v['awh-nstsample']}) must be a ` +
          `multiple of nstcalcenergy (${v.nstcalcenergy}).`);
      }
      if (key(v['awh-potential']) !== 'UMBRELLA') {
        this.add('error', 'awh-potential-fep', 'awh-potential', 'With a lambda dimension, awh-potential must be umbrella.');
      }
    }
    if (v['init-step'] !== 0) this.add('error', 'awh-init-step', 'init-step', 'With AWH, init-step must be 0.');
  }

  /* checkBiasParams and checkDimParams for bias b. */
  awhBiasChecks(b) {
    const v = this.v;
    const q = (s) => `awh${b}-${s}`;
    if (v[q('error-init')] <= 0) this.add('error', 'awh-error-init', q('error-init'), `${q('error-init')} must be above 0.`);
    if (v[q('growth-factor')] <= 1) this.add('error', 'awh-growth-factor', q('growth-factor'), `${q('growth-factor')} must be above 1.`);
    const growthExp = key(v[q('growth')]) === 'EXPLINEAR';
    if (v[q('equilibrate-histogram')] === 'yes' && !growthExp) {
      this.add('warning', 'awh-equilibrate-histogram', q('equilibrate-histogram'), `${q('equilibrate-histogram')} only has an effect with ` +
        `${q('growth')} = exp-linear. grompp warns.`);
    }
    const target = key(v[q('target')]);
    if (target === 'LOCALBOLTZMANN' && growthExp) {
      this.add('warning', 'awh-local-boltzmann', q('growth'), 'The local-boltzmann target with exp-linear growth is not expected to give ' +
        `stable updates; use ${q('growth')} = linear. grompp warns.`);
    }
    const beta = v[q('target-beta-scaling')];
    if (target === 'BOLTZMANN' || target === 'LOCALBOLTZMANN') {
      if (beta < 0 || beta > 1) this.add('error', 'awh-target-beta-scaling', q('target-beta-scaling'), `${q('target-beta-scaling')} must be between 0 and 1.`);
    } else if (beta !== 0) {
      this.add('error', 'awh-target-unused', q('target-beta-scaling'), `${q('target-beta-scaling')} is set but ${q('target')} = ${v[q('target')]} ` +
        'does not use it; grompp stops. Remove it.');
    }
    const cutoff = v[q('target-cutoff')];
    if (target === 'CUTOFF') {
      if (cutoff <= 0) this.add('error', 'awh-target-cutoff', q('target-cutoff'), `${q('target-cutoff')} must be above 0 for the cutoff target.`);
    } else if (cutoff !== 0) {
      this.add('error', 'awh-target-unused', q('target-cutoff'), `${q('target-cutoff')} is set but ${q('target')} = ${v[q('target')]} ` +
        'does not use it; grompp stops. Remove it.');
    }
    if (v[q('share-group')] < 0) this.add('error', 'awh-share-group', q('share-group'), `${q('share-group')} cannot be negative.`);
    const ndim = v[q('ndim')];
    if (ndim > 2) {
      this.add('note', 'awh-ndim-rough', q('ndim'), 'With more than two AWH dimensions the estimate from the diffusion and initial error ' +
        'is only a rough guide; check it before production runs.');
    }
    for (let d = 1; d <= ndim; d++) {
      const r = (s) => `awh${b}-dim${d}-${s}`;
      const start = v[r('start')];
      const end = v[r('end')];
      if (key(v[r('coord-provider')]) === 'PULL') {
        if (!this.gate.pull) {
          this.add('error', 'awh-needs-pull', r('coord-provider'), `${r('coord-provider')} = pull needs pull = yes.`);
          continue;
        }
        const index = v[r('coord-index')];
        const ncoord = v['pull-ncoords'];
        if (index < 1) {
          this.add('error', 'awh-coord-index', r('coord-index'), `${r('coord-index')} must be 1 or more: pull coordinates are counted from 1.`);
        }
        if (index > ncoord) {
          this.add('error', 'awh-coord-range', r('coord-index'), `${r('coord-index')} = ${index}, but there ${ncoord === 1 ? 'is' : 'are'} only ` +
            `${ncoord} pull coordinate${ncoord === 1 ? '' : 's'} (pull-ncoords).`);
        }
        const inRange = index >= 1 && index <= ncoord;
        if (inRange && v[`pull-coord${index}-rate`] !== 0) {
          this.add('error', 'awh-pull-rate', `pull-coord${index}-rate`, `pull-coord${index}-rate must be 0 for a coordinate AWH biases.`);
        }
        if (end - start === 0) {
          this.add('warning', 'awh-interval-zero', r('end'), `${r('start')} and ${r('end')} are equal, so the grid has one point along this ` +
            'dimension. grompp warns.');
        }
        if (v[r('force-constant')] <= 0) {
          this.add('error', 'awh-force-constant', r('force-constant'), `${r('force-constant')} must be above 0 (its default is 0, so it has to be set).`);
        }
        const geom = inRange ? key(v[`pull-coord${index}-geometry`]) : '';
        if (geom === 'DISTANCE' && (start < 0 || end < 0)) {
          this.add('error', 'awh-interval-range', r('start'), `${r('start')} and ${r('end')} cannot be negative with the distance geometry; ` +
            'use geometry direction for signed values.');
        } else if ((geom === 'ANGLE' || geom === 'ANGLEAXIS') && (start < 0 || end > 180)) {
          this.add('error', 'awh-interval-range', r('start'), `${r('start')} and ${r('end')} must lie within 0 to 180 degrees for an angle.`);
        } else if (geom === 'DIHEDRAL' && (start < -180 || end > 180)) {
          this.add('error', 'awh-interval-range', r('start'), `${r('start')} and ${r('end')} must lie within -180 to 180 degrees for a dihedral.`);
        }
      } else {
        const n = this.lambdas.n;
        if (this.efep === 'NO') this.add('error', 'awh-needs-fep', r('coord-provider'), `${r('coord-provider')} = fep-lambda needs free-energy = yes.`);
        if (v['calc-lambda-neighbors'] !== -1) {
          this.add('error', 'awh-lambda-neighbors', 'calc-lambda-neighbors', 'AWH on the lambda state needs calc-lambda-neighbors = -1 (all states).');
        }
        if (this.efep === 'SLOWGROWTH' || v['delta-lambda'] !== 0) {
          this.add('error', 'awh-slow-growth', 'delta-lambda', 'AWH on the lambda state cannot be combined with slow growth: delta-lambda must be 0.');
        }
        if (this.efep === 'EXPANDED') this.add('error', 'awh-expanded', 'free-energy', 'AWH on the lambda state cannot be combined with free-energy = expanded.');
        if (start < 0) this.add('error', 'awh-lambda-range', r('start'), `${r('start')} is a lambda state and cannot be negative.`);
        if (end >= n) this.add('error', 'awh-lambda-range', r('end'), `${r('end')} (${end}) must be below the number of lambda states (${n}).`);
        if (end - start === 0) {
          this.add('warning', 'awh-interval-zero', r('end'), `${r('start')} and ${r('end')} are equal, so only one lambda state is sampled. grompp warns.`);
        }
        if (v[r('force-constant')] !== 0) {
          this.add('error', 'awh-force-constant-fep', r('force-constant'), `${r('force-constant')} is not used with the lambda state; leave it at 0.`);
        }
      }
    }
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
    const couple = ctrim(v['couple-moltype'] || '');
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
    const deformText = ctrim(v.deform || '');
    if (deformText) {
      const nums = scanReals(deformText, 7);
      if (nums.length !== 6) {
        this.add('error', 'deform-count', 'deform', `deform needs exactly six numbers (a b c b(x) c(x) c(y) in nm/ps); ` +
          `"${deformText}" does not give six. grompp stops.`);
      }
      const d = [...nums, 0, 0, 0, 0, 0, 0];
      this.deform = [[d[0], 0, 0], [d[3], d[1], 0], [d[4], d[5], d[2]]];
      if (this.epc !== 'NO') {
        // readir.cpp: an error for each element both deformed and coupled...
        const label = [['a', '', ''], ['b(x)', 'b', ''], ['c(x)', 'c(y)', 'c']];
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j <= i; j++) {
            if (this.deform[i][j] !== 0 && this.compress[i][j] !== 0) {
              this.add('error', 'deform-compressibility', 'deform', `Box element ${label[i][j]} is both deformed (deform) and pressure-coupled ` +
                '(compressibility above 0). Set the compressibility of deformed elements to 0.');
            }
          }
        }
        // ...and a warning for each off-diagonal element deformed while the
        // same component of another box vector is pressure-coupled.
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < i; j++) {
            if (this.deform[i][j] === 0) continue;
            for (let m = j; m < 3; m++) {
              if (this.compress[m][j] !== 0) {
                this.add('warning', 'deform-shear-coupled', 'deform', `Box element ${label[i][j]} is deformed while the ` +
                  `${'xyz'[j]} component of box vector ${'abc'[m]} is pressure-coupled, which can give spurious periodicity effects; ` +
                  'grompp warns. Set that compressibility to 0 (anisotropic coupling) or couple the pressure without deform.');
              }
            }
          }
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

    // AWH: checkAwhParams closes get_ir.
    if (this.gate.awh) this.awhProcessing();
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
        if (!ctrim(v[p('potential-provider')] || '')) {
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
      // string2dvec (readpull.cpp) wants exactly three numbers: a fourth is
      // as fatal as a missing one.
      const origin = scanReals(v[p('origin')], 4);
      if (origin.length !== 3) {
        this.add('error', 'pull-vector-count', p('origin'), `${p('origin')} needs exactly three numbers (x y z); "${v[p('origin')]}" ` +
          `gives ${origin.length}. grompp stops.`, { fatal: true });
        return;
      }
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
      const vec = scanReals(v[p('vec')], 4);
      if (vec.length !== 3) {
        this.add('error', 'pull-vector-count', p('vec'), `${p('vec')} needs exactly three numbers (x y z); "${v[p('vec')]}" ` +
          `gives ${vec.length}. grompp stops.`, { fatal: true });
        return;
      }
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
        const expr = ctrim(v[p('expression')] || '');
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

    // Spellings the reader takes but nothing after it does.
    if (pbc === 'UNSET') {
      this.add('error', 'pbc-unset', 'pbc', 'pbc = unset is an internal placeholder, not a choice: grompp crashes on it (an assertion ' +
        'failure). Use pbc = xyz.', { fatal: true });
      return;
    }
    if (I === I_SD2) {
      this.add('error', 'sd2-removed', 'integrator', 'The sd2 integrator was removed: grompp accepts the name, but mdrun stops ' +
        '("SD2 integrator has been removed"). Use integrator = sd.', { source: 'mdrun' });
    }

    if (dyn && !(v.dt > 0)) this.add('error', 'dt', 'dt', 'dt must be larger than 0 for dynamics.');

    // MTS requirements
    if (this.useMts && this.validMts) {
      const f = this.mtsFactor;
      if (I !== 'MD' && !(I === 'SD' && this.ver < 2023)) {
        this.add('error', 'mts-integrator', 'mts', `Multiple time stepping works only with integrator = md${this.ver < 2023 ? ' or sd' : ''}.`);
      }
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

    if (ct === CT_RF_NEC) this.add('error', 'coulombtype-removed', 'coulombtype', 'Reaction-Field-nec is no longer supported; use Reaction-Field.');

    // Cut-offs
    if (v.rcoulomb < 0) this.add('error', 'rcoulomb-negative', 'rcoulomb', 'rcoulomb cannot be negative.');
    if (v.rvdw < 0) this.add('error', 'rvdw-negative', 'rvdw', 'rvdw cannot be negative.');
    const verlet = key(v['cutoff-scheme']) === 'VERLET';
    // From GROMACS 2024.3 on.
    if (verlet && v.rcoulomb === 0 && v.rvdw === 0 && this.ver >= 2024) {
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
      const nstdhdl = v.nstdhdl;
      const fep = this.efep !== 'NO';
      const automatic2022 = nstcalcenergy < 0 && this.ver < 2023;
      if (automatic2022) {
        // GROMACS 2022 chose -1 itself: nstlist (10 without one), and no more
        // than nstenergy, without a note.
        nstcalcenergy = v.nstlist > 0 ? v.nstlist : 10;
        if (this.useMts && this.validMts) nstcalcenergy = nstcalcenergy * this.mtsFactor / gcd(nstcalcenergy, this.mtsFactor);
        if (v.nstenergy !== 0 && v.nstenergy < nstcalcenergy) nstcalcenergy = v.nstlist > 0 ? gcd(v.nstenergy, v.nstlist) : v.nstenergy;
      } else if (nstcalcenergy < 0) {
        nstcalcenergy = 100;
      }
      if (!automatic2022 && ((v.nstenergy > 0 && nstcalcenergy > v.nstenergy) || (fep && nstdhdl > 0 && nstcalcenergy > nstdhdl))) {
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
      // Before 2024 grompp refused constraints with andersen-massive too.
      if (this.nshake !== 0 && (this.etc === 'ANDERSEN' || this.ver < 2024)) {
        this.add('error', 'andersen-constraints', 'tcoupl', this.etc === 'ANDERSEN'
          ? 'Andersen coupling does not work with constraints; use andersen-massive.'
          : `grompp ${this.version} refuses Andersen coupling with constraints, andersen-massive included (allowed from 2024 on).`);
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
      // grompp checks this from 2023 on; GROMACS 2022's mdrun stops on it.
      this.add('error', 'crescale-type', 'pcoupltype', `C-rescale does not support pcoupltype = ${v.pcoupltype} yet; use Parrinello-Rahman for anisotropic coupling.` +
        (this.ver < 2023 ? ` grompp ${this.version} accepts it, but mdrun stops.` : ''), this.ver < 2023 ? { source: 'mdrun' } : {});
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
    if (ct === CT_GB) this.add('error', 'coulombtype-gb', 'coulombtype', 'Generalized-Born is not a valid coulombtype: implicit solvent was removed.');
    if (v.QMMM === 'yes') {
      this.add('error', 'qmmm-removed', 'QMMM', 'The QM/MM interface this switched on was removed. Use integrator = mimic for MiMiC, or qmmm-cp2k-active = true for CP2K.');
    }
    if (v['cos-acceleration'] !== 0 && I !== 'MD') this.add('error', 'cos-acceleration', 'cos-acceleration', 'cos-acceleration works only with integrator = md.');
    // The flow profile of deform, from GROMACS 2024 on.
    if (this.haveDeform && this.ver >= 2024 && v['deform-init-flow'] !== 'yes') {
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

  /* ir_optimal_nstpcouple and ir_optimal_nsttcouple (inputrec.cpp). GROMACS
     2022 wanted 10 steps, and compared nstpcouple x dt (nsttcouple x dt)
     with tau itself rather than tau over the minimum number of steps. */
  optimalNstpcouple() {
    const v = this.v;
    const min = ['BERENDSEN', 'CRESCALE', 'ISOTROPIC'].includes(this.epc) ? MIN_STEPS_PER_TAU : this.epc === 'NO' ? 0 : MIN_STEPS_PER_PERIOD;
    const old = this.ver < 2023;
    const wanted = old ? 10 : 100;
    const minNst = this.useMts && this.validMts ? this.mtsFactor : 1;
    let n;
    // delta_t is a double in GROMACS; tau-p is single precision (real).
    const dt = Number(v.dt);
    const tauP = f32(v['tau-p']);
    if (min === 0 || wanted * dt <= (old ? tauP : f32(tauP / min))) {
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
    const old = this.ver < 2023;
    const wanted = old ? 10 : 100;
    const dt = Number(this.v.dt);
    if (min === 0 || dt * wanted <= (old ? f32(tauMin) : f32(tauMin / min))) return wanted;
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
    this.rigidWater = this.rigidWaterAssumed();
    const constrained = this.nshake > 0 || this.rigidWater.rigid;
    if (constrained && key(v['constraint-algorithm']) === 'SHAKE') {
      if (I === 'CG' || I === 'LBFGS') {
        this.add('error', 'shake-minimiser', 'constraint-algorithm', `${v.integrator} cannot be used with SHAKE; use LINCS.`,
          { assumes: this.nshake > 0 ? undefined : this.rigidWater.assumes });
      }
      if (v['periodic-molecules'] === 'yes') this.add('error', 'shake-periodic', 'constraint-algorithm', 'SHAKE does not work with periodic molecules; use LINCS.');
    }
    if (this.preprocessorWords()) return;
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

  /*
   * Whether the topology has rigid (SETTLE) water, which counts as a
   * constraint for the SHAKE and MTTK checks. The caller may say; otherwise
   * -DFLEXIBLE (which makes the pdb2gmx water models flexible) or a
   * coarse-grained system (single-bead water) means no, and anything else yes.
   */
  rigidWaterAssumed() {
    const ctx = this.ctx;
    if (ctx.rigidWater !== undefined) return { rigid: !!ctx.rigidWater, assumes: undefined };
    if (words(this.v.define).some(w => /^-DFLEXIBLE(=|$)/.test(w))) {
      return { rigid: false, assumes: 'define has -DFLEXIBLE, so the water is flexible (no SETTLE)' };
    }
    if (ctx.system === 'coarse-grained') return { rigid: false, assumes: 'coarse-grained water has no SETTLE constraints' };
    return { rigid: true, assumes: 'the topology has rigid (SETTLE) water' };
  }

  /*
   * cpp_opts (topio.cpp): each word of define must start with -D and each
   * word of include with -I. A longer word that does not is dropped with a
   * warning. A word of one or two characters is never stepped over, so
   * grompp loops for ever: "-D POSRES" (with a space) hangs it.
   */
  preprocessorWords() {
    for (const [option, flag, example] of [['define', '-D', '-DPOSRES'], ['include', '-I', '-I/path/to/itp-files']]) {
      for (const w of words(this.v[option])) {
        if (w.length <= 2) {
          this.add('error', 'preprocessor-hang', option, `"${w}" in ${option} is a word of ${w.length === 1 ? 'one character' : 'two characters'}, ` +
            `which grompp's parser never steps over: grompp does not stop or finish, it hangs while reading the topology. ` +
            `Write each ${option} as one word, such as ${example}.`, { fatal: true });
          return true;
        }
        if (!w.startsWith(flag)) {
          this.add('warning', 'preprocessor-malformed', option, `"${w}" in ${option} does not start with ${flag}: grompp ignores it and warns ` +
            `"Malformed ${option} option ${w}".` + (option === 'define' && w.startsWith('-I') ? ' Include paths belong in include.'
              : option === 'include' && w.startsWith('-D') ? ' Macros belong in define.'
                : /^["']/.test(w) ? ' Write it without quotes.' : w.startsWith('-') ? '' : ` Write it as ${flag}${w}.`));
        }
      }
    }
    return false;
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
    // Before 2024 grompp has no mass-repartition-factor: masses are the topology's.
    const factor = v['mass-repartition-factor'] ?? 1;
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
        'hydrogen are too fast. ' + (this.ver >= 2024 ? 'Use dt = 0.002, or mass-repartition-factor = 3 for dt = 0.004.'
          : `Use dt = 0.002, unless the topology's hydrogen masses are repartitioned (GROMACS ${this.version} has no mass-repartition-factor).`),
      { source: 'advice' });
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
    if (this.overlaps('tc-grps', 'T-Coupling')) return;
    this.tauMax = 0;
    this.refMax = 0;
    if (hasRefT && tcg.length && tau.length === tcg.length && reft.length === tcg.length) {
      // convertReals: an error for each value that is not a number within
      // single precision (inf and 1e39 included).
      tau.forEach((w, i) => {
        if (this.taus[i] === null) this.add('error', 'tau-t-number', 'tau-t', `"${w}" in tau-t is not a number grompp can read; tau-t should hold only numbers separated by spaces.`);
      });
      reft.forEach((w, i) => {
        if (this.refts[i] === null) this.add('error', 'ref-t-number', 'ref-t', `"${w}" in ref-t is not a number grompp can read; ref-t should hold only numbers separated by spaces.`);
      });
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
          if (this.ver >= 2025) this.add('note', 'mttk-deprecated', 'pcoupl', 'MTTK coupling is deprecated and will soon be removed.');
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
          // tauMin is the float grompp compares; the message shows it as written.
          this.add('warning', 'tau-t-short', 'tau-t', `tau-t (${fmt(tauMin)} ps) should be at least ${nstcmin} times nsttcouple x dt ` +
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

    // Pull, rotation and swap groups are looked up next: an empty name
    // matches no group, so grompp stops.
    if (this.namedGroups()) return;

    // Acceleration and freezing
    const acc = words(v['acc-grps']);
    const accVals = words(v.accelerate);
    if (acc.length * 3 !== accVals.length) {
      this.add('error', 'accelerate-count', 'accelerate', `acc-grps has ${acc.length} group${acc.length === 1 ? '' : 's'}, so accelerate needs ` +
        `${acc.length * 3} numbers (x y z for each); it has ${accVals.length}. grompp stops.`, { fatal: true });
      return;
    }
    if (this.overlaps('acc-grps', 'Acc. not used')) return;
    // convertRvecs: an error for every word that is not a number.
    for (const w of accVals.filter(x => strictReal(x) === null)) {
      this.add('error', 'accelerate-number', 'accelerate', `"${w}" in accelerate is not a number: accelerate holds x y z accelerations ` +
        '(nm ps^-2) for each group in acc-grps.');
    }
    this.useAcceleration = accVals.some(w => strictReal(w));
    const frz = words(v.freezegrps);
    const frzDim = words(v.freezedim);
    if (frzDim.length !== frz.length * 3) {
      this.add('error', 'freezedim-count', 'freezedim', `freezegrps has ${frz.length} group${frz.length === 1 ? '' : 's'}, so freezedim needs ` +
        `${frz.length * 3} entries (Y or N for x, y and z of each); it has ${frzDim.length}. grompp stops.`, { fatal: true });
      return;
    }
    if (this.overlaps('freezegrps', 'Freeze')) return;
    const bad = frzDim.find(w => !/^[YN]/i.test(w));
    if (bad) this.add('warning', 'freezedim-value', 'freezedim', `Use Y or N in freezedim, not "${bad}".`);
    this.frozenAll = [0, 1, 2].map(d => frz.some((_, g) => /^y/i.test(frzDim[g * 3 + d] || '')));
    if (this.overlaps('energygrps', 'Energy Mon.') || this.overlaps('comm-grps', 'VCM')) return;
    if (this.commMode !== 'NONE') this.frozenInComGroups(frz, frzDim);
    for (const [n, title] of [['user1-grps', 'User1'], ['user2-grps', 'User2'], ['compressed-x-grps', 'Compressed X'], ['orire-fitgrp', 'Or. Res. Fit']]) {
      if (this.overlaps(n, title)) return;
    }

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

    // Ensemble temperature (processEnsembleTemperature, from GROMACS 2023 on;
    // before, C-rescale, AWH and MTTK take ref-t of the groups).
    const setting = key(v['ensemble-temperature-setting']);
    const allCoupled = tcg.length > 0;
    let ens = 'NOTAVAILABLE';
    const equalRefT = this.refts.length > 0 && this.refts.every(x => x === this.refts[0]);
    if (this.ver < 2023) {
      ens = hasRefT && equalRefT ? 'CONSTANT' : 'NOTAVAILABLE';
    } else if (setting === 'CONSTANT') {
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
    const v = this.v;
    const options = ['tc-grps', 'comm-grps', 'energygrps', 'compressed-x-grps', 'acc-grps', 'freezegrps', 'user1-grps', 'user2-grps',
      'QMMM-grps', 'orire-fitgrp'];
    // Group options read only when their feature is on: every one grompp read
    // (this.v holds exactly those) is looked up in the index.
    for (const n of Object.keys(v)) {
      if (/^(pull-group\d+-name|rot-group\d+|split-group[01]|solvent-group|iontype\d+-name)$/.test(n)) options.push(n);
    }
    if (v['IMD-group']) options.push('IMD-group');
    // Module groups are looked up only when the module is active.
    for (const [sw, n] of [['density-guided-simulation-active', 'density-guided-simulation-group'], ['qmmm-cp2k-active', 'qmmm-cp2k-qmgroup'],
      ['nnpot-active', 'nnpot-input-group']]) {
      if (v[sw] === true) options.push(n);
    }
    for (const n of options) {
      for (const g of words(v[n])) {
        if (!known.has(g.toLowerCase())) {
          this.add('error', 'group-unknown', n, `Group ${g} in ${n} is not in the index: group names must match [ moleculetype ] names, ` +
            'default groups or groups of the index file given to grompp -n.');
        }
      }
    }
  }

  /*
   * do_numbering puts each atom in at most one group of an option, and stops
   * at the first atom it meets twice ("Atom 1 in multiple T-Coupling groups").
   * A group named twice always does that; System next to any other group
   * does too, as System holds every atom. Names compare ignoring case.
   */
  overlaps(option, title) {
    const names = words(this.v[option]);
    const seen = new Set();
    for (const g of names) {
      if (seen.has(g.toLowerCase())) {
        this.add('error', 'group-twice', option, `${option} names ${g} twice, which puts its atoms in two ${title} groups: grompp stops ` +
          `("Atom ... in multiple ${title} groups"). Name each group once.`, { fatal: true });
        return true;
      }
      seen.add(g.toLowerCase());
    }
    if (names.length > 1 && seen.has('system')) {
      this.add('error', 'group-twice', option, `${option} lists System with other groups, but System holds every atom, so atoms end up in ` +
        `two ${title} groups and grompp stops. Use System alone, or groups that do not overlap.`,
      { fatal: true, assumes: 'System is the default group of all atoms' });
      return true;
    }
    return false;
  }

  /* Pull, rotation and swap groups by name (do_index): a name left empty
     matches no index group, and grompp stops. */
  namedGroups() {
    const v = this.v;
    const fatal = (option, message) => { this.add('error', 'group-unset', option, message, { fatal: true }); return true; };
    if (this.gate.pull) {
      for (let g = 1; g <= v['pull-ngroups']; g++) {
        if (!ctrim(v[`pull-group${g}-name`] || '')) {
          return fatal(`pull-group${g}-name`, `pull-group${g}-name is not set: pull-ngroups = ${v['pull-ngroups']} needs an index group for ` +
            `each pull group. grompp stops ("Pull option pull_group${g} required by grompp has not been set").`);
        }
      }
    }
    if (this.gate.rotation) {
      for (let g = 0; g < v['rot-ngroups']; g++) {
        if (!ctrim(v[`rot-group${g}`] || '')) {
          return fatal(`rot-group${g}`, `rot-group${g} is not set: every rotation group needs the index group it rotates. grompp stops.`);
        }
      }
    }
    if (this.gate.swapcoords) {
      // make_swap_groups compares the two split groups exactly (strcmp).
      if (String(v['split-group0'] || '') === String(v['split-group1'] || '')) {
        return fatal('split-group1', `The two split groups are both "${v['split-group0'] || ''}": split-group0 and split-group1 must be the ` +
          'two channels (index groups) that divide the compartments. grompp stops.');
      }
      const names = ['split-group0', 'split-group1', 'solvent-group'];
      for (let t = 0; t < v.iontypes; t++) names.push(`iontype${t}-name`);
      for (const n of names) {
        if (!ctrim(v[n] || '')) return fatal(n, `${n} is not set: position swapping needs it as an index group. grompp stops.`);
      }
    }
    return false;
  }

  /*
   * checkAndUpdateVcmFreezeGroupConsistency (readir.cpp), with COM removal
   * on: atoms frozen in one or two directions inside a COM-removal group get
   * a warning (unless every atom is frozen that way); fully frozen ones are
   * taken out of the group, with a note.
   */
  frozenInComGroups(frz, frzDim) {
    let partial = false;
    let partialAll = false;
    let full = false;
    frz.forEach((g, i) => {
      const n = [0, 1, 2].filter(d => /^y/i.test(frzDim[i * 3 + d])).length;
      if (n === 3) full = true;
      else if (n > 0) {
        partial = true;
        if (g.toLowerCase() === 'system') partialAll = true;
      }
    });
    const assumes = words(this.v['comm-grps']).length
      ? { assumes: 'the frozen groups overlap the groups in comm-grps' } : { assumes: 'the frozen groups hold atoms (comm-grps is the whole system)' };
    if (full) {
      this.add('note', 'freeze-com-full', 'freezegrps', 'Fully frozen atoms (Y Y Y) are in a centre-of-mass removal group: grompp takes ' +
        'them out of it and notes it.', assumes);
    }
    if (partial && !partialAll) {
      this.add('warning', 'freeze-com-partial', 'freezedim', 'Atoms frozen in only one or two directions are in a centre-of-mass removal ' +
        'group: their mass still counts along the frozen directions, so the correction is too small. grompp warns. Freeze them in all ' +
        'three directions, leave them out of comm-grps, or set comm-mode = None.', assumes);
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
    // convertInts (fromString<int>): whole numbers within an int.
    const npts = np.map(w => {
      const n = strictInt(w);
      if (n === null) this.add('error', 'annealing-npoints-number', 'annealing-npoints', 'annealing-npoints should hold whole numbers only.');
      return n === null ? 0 : n;
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
    for (const w of times.filter((_, i) => tv[i] === null)) {
      this.add('error', 'annealing-time-number', 'annealing-time', `"${w}" in annealing-time is not a number; annealing-time should hold numbers only.`);
    }
    for (const w of temps.filter((_, i) => Tv[i] === null)) {
      this.add('error', 'annealing-temp-number', 'annealing-temp', `"${w}" in annealing-temp is not a number; annealing-temp should hold numbers only.`);
    }
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
    if (this.epc === 'CRESCALE' && this.ver < 2023) {
      // GROMACS 2022: a thermostat (or sd, bd), whose first ref-t it uses.
      if (!EI.RANDOM(I) && this.etc === 'NO') {
        this.add('error', 'crescale-temperature', 'pcoupl', 'C-rescale needs a reference temperature, and there is no thermostat. Use a thermostat, ' +
          'such as tcoupl = V-rescale.');
      } else if (this.hasRefT && !this.equalRefT) {
        this.add('warning', 'crescale-ref-t', 'ref-t', `C-rescale needs one reference temperature, but the groups have different ref-t: grompp ${this.version} ` +
          'uses the first group\'s and warns. Give every group the same ref-t.');
      }
    } else if (this.epc === 'CRESCALE' && !haveEns) {
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
    if (this.epc === 'MTTK' && this.ver >= 2023 && this.ensemble !== 'CONSTANT') {
      this.add('error', 'mttk-temperature', 'pcoupl', 'MTTK needs a constant ensemble temperature.');
    }
    const charged = ctx.charged !== false;
    if (!charged && COULOMB.FULL(this.ct)) {
      this.add('warning', 'full-elec-no-charges', 'coulombtype', `${v.coulombtype} for a system without charges only costs time; use Cut-off.`, { assumes: 'the system has no charges' });
    } else if (charged && this.ct === 'CUTOFF' && v.rcoulomb > 0) {
      this.add('note', 'plain-cutoff', 'coulombtype', 'A plain Coulomb cut-off can cause artefacts; PME is usually better.', { assumes: 'the system has charges' });
    }
    if (this.ct === CT_GRF) {
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
    if (this.gate.awh && this.ver < 2023 && !(this.ensemble === 'CONSTANT' && this.refts[0] > 0)) {
      this.add('error', 'awh-temperature', 'awh', `AWH needs one temperature above 0 for every temperature group: grompp ${this.version} stops ` +
        '("AWH biasing is currently only supported for identical temperatures"). Use a thermostat with one ref-t.', { fatal: true });
    } else if (this.gate.awh && this.ver >= 2023 && this.ensemble !== 'CONSTANT') {
      this.add('error', 'awh-temperature', 'awh', 'AWH needs a constant ensemble temperature: a thermostat with one ref-t, or ensemble-temperature-setting = constant.');
    }
    // The deform and acceleration checks came with the corrected deform of 2024.
    if (this.ver < 2024) return;
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
    const anyConstraints = normalConstraints || this.rigidWater.rigid;
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
        { assumes: normalConstraints ? undefined : this.rigidWater.assumes });
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
        this.nveDrift();
      } else if (this.hasRefT && this.taus.some(t => t !== null && t < 0)) {
        this.add('warning', 'tau-t-uncoupled', 'tau-t', 'Some temperature groups are not coupled (tau-t = -1); grompp assumes they are no hotter ' +
          'than the others when sizing the Verlet buffer, and warns.');
      }
    }
    this.cutoffEvaluation();
  }

  /*
   * grompp.cpp notes an NVE run whose buffer tolerance could let the energy
   * drift by more than about 1%. Known only when gen-vel gives the
   * temperature; otherwise it comes from the velocities in the structure.
   */
  nveDrift() {
    const v = this.v;
    if (v['gen-vel'] !== 'yes' || !(v['gen-temp'] > 0) || !(v.nstlist > 1) || !(v.nsteps > 0)) return;
    const lengthPs = v.nsteps * v.dt;
    const perPs = f32(2 * BOLTZ * f32(v['gen-temp']) / lengthPs);
    const tol = f32(v['verlet-buffer-tolerance']);
    if (tol > 1.1 * f32(0.01) * perPs) {
      this.add('note', 'nve-drift', 'verlet-buffer-tolerance', `verlet-buffer-tolerance = ${fmt(tol)} kJ/mol/ps over an NVE run of ` +
        `${fmt(lengthPs)} ps can let the total energy drift by about ${Math.round(tol / perPs * 100)}%. To conserve energy to 1% ` +
        `(with constraints), grompp suggests verlet-buffer-tolerance = ${(0.01 * perPs).toExponential(1)}.`);
    }
  }

  /* Whether grompp sizes the Verlet buffer, and so evaluates the
     interactions at the cut-off (grompp.cpp, after do_index). */
  sizesBuffer() {
    const v = this.v;
    if (!(key(v['cutoff-scheme']) === 'VERLET' && v['verlet-buffer-tolerance'] > 0 && EI.DYNAMICS(this.I) && this.nbounded === 3)) return false;
    // An NVE run from zero temperature gets a fixed 10% buffer instead.
    return !(EI.MD(this.I) && this.etc === 'NO' && v['gen-vel'] === 'yes' && !(v['gen-temp'] > 0));
  }

  /*
   * Values the checks above let through but that break the evaluation of the
   * interactions at the cut-off: in grompp when it sizes the buffer (an
   * assertion, an internal error or a loop that never ends), otherwise in
   * mdrun, which evaluates them when it starts.
   */
  cutoffEvaluation() {
    const v = this.v;
    const inGrompp = this.sizesBuffer();
    // From GROMACS 2024 on grompp also sizes the buffer for the pressure,
    // which evaluates the interactions in ways a nan epsilon-r or a zero
    // rvdw break; before, grompp passes them and mdrun stops (tried with
    // GROMACS 2023.5: a non-finite energy, a std::length_error).
    const pressureBuffer = inGrompp && this.ver >= 2024;
    const stop = (id, option, what, grompp, mdrun, here = inGrompp) => this.add('error', id, option,
      `${what} ${here ? grompp : mdrun}`, here ? { fatal: true } : { source: 'mdrun' });
    if (Number.isNaN(this.epsR)) {
      stop('epsilon-r-nan', 'epsilon-r', 'epsilon-r is nan, which makes every electrostatic energy nan:',
        'grompp stops with an assertion failure while sizing the Verlet buffer.', 'mdrun stops with a non-finite energy.', pressureBuffer);
    }
    if (COULOMB.PME_OR_EWALD(this.ct) && v['ewald-rtol'] < 0) {
      stop('ewald-rtol', 'ewald-rtol', `ewald-rtol = ${v['ewald-rtol']} cannot be reached (it must be above 0, 1e-5 is usual):`,
        'grompp never finishes while sizing the Verlet buffer.', 'mdrun never finishes setting up PME.');
    }
    if (this.vt === 'PME' && v['ewald-rtol-lj'] < 0) {
      stop('ewald-rtol-lj', 'ewald-rtol-lj', `ewald-rtol-lj = ${v['ewald-rtol-lj']} cannot be reached (it must be above 0, 1e-3 is usual):`,
        'grompp stops with an assertion failure while sizing the Verlet buffer.', 'mdrun stops setting up LJ-PME.');
    }
    if (!inGrompp) return;
    if (this.vmod === 'EXACTCUTOFF') {
      this.add('error', 'vdw-exact-cutoff', 'vdw-modifier', 'vdw-modifier = Exact-cutoff cannot be used for dynamics: grompp stops ' +
        '("Unimplemented VdW modifier") while sizing the Verlet buffer. Use Potential-shift.', { fatal: true });
    } else if (v.rvdw >= 0 && v.rvdw < 0.005 && v.rcoulomb > 0 && !pressureBuffer) {
      this.add('error', 'rvdw-zero', 'rvdw', `rvdw = ${v.rvdw} nm puts the Lennard-Jones cut-off at (almost) zero distance: grompp ` +
        `${this.version} accepts it, but mdrun crashes. Use the force field's cut-off (1.0 to 1.2 nm).`, { source: 'mdrun' });
    } else if (v.rvdw === 0 && v.rcoulomb > 0) {
      this.add('error', 'rvdw-zero', 'rvdw', 'rvdw = 0 puts the Lennard-Jones cut-off at zero distance, where the potential is infinite: ' +
        'grompp stops with an assertion failure while sizing the Verlet buffer. Use the force field\'s cut-off (1.0 to 1.2 nm).', { fatal: true });
    } else if (v.rvdw > 0 && v.rvdw < 0.005) {
      this.add('error', 'rvdw-zero', 'rvdw', `rvdw = ${v.rvdw} nm is so short that the Lennard-Jones terms overflow: grompp stops with an ` +
        'assertion failure while sizing the Verlet buffer. Use the force field\'s cut-off (1.0 to 1.2 nm).',
      { fatal: true, assumes: 'Lennard-Jones parameters of an all-atom force field (grompp 2025 fails below about 0.005 nm with AMBER, CHARMM and OPLS)' });
    }
  }

  /*
   * set_pull_init on the structure given: a group reaching further than a
   * quarter of the box from its reference atom is an error, and groups
   * further apart than 0.49 of the box along the counted dimensions stop
   * grompp at once (gmx_fatal in low_get_pull_coord_dr, pull.cpp). Returns
   * true when grompp stops there.
   */
  pullReach() {
    const s = this.ctx.structure;
    // Martini beads are 72, 54 or 36 u whatever their names say.
    const r = pullStart(this.v, s, { equalMasses: this.ctx.system === 'coarse-grained' });
    if (!r) return false;
    const masses = this.ctx.system === 'coarse-grained' || !Array.isArray(s.masses) ? 'equal atom masses'
      : (s.massNote || 'the atom masses given');
    const assumes = `the coordinates and box of ${s.name || 'the structure given'}, as grompp reads them with -c, and ${masses}`;
    for (const g of r.groups) {
      if (g.obeysPbc !== false) continue;
      const atom = `pull-group${g.group}-pbcatom`;
      // Only a reference the user did not choose, or one without the
      // previous step's centre to follow, is refused (readpull.cpp).
      if (g.pbcatomInput === 0) {
        this.add('error', 'pull-pbcatom', `pull-group${g.group}-name`, `Pull group ${g.group} (${g.name}) reaches further than a quarter ` +
          `of the box from its reference atom, the middle one by number (atom ${g.pbcAtom}), and grompp stops ("a centrally placed atom ` +
          `should be chosen as pbcatom"). Set ${atom} to an atom near the group's centre, with pull-pbc-ref-prev-step-com = yes.`, { assumes });
      } else if (!r.prevStepCom) {
        this.add('error', 'pull-pbcatom', 'pull-pbc-ref-prev-step-com', `Pull group ${g.group} (${g.name}) reaches further than a quarter ` +
          `of the box from its reference atom (${atom} = ${g.pbcAtom}), and grompp stops. Set pull-pbc-ref-prev-step-com = yes: the ` +
          'periodic images are then taken from the centre of mass of the step before.', { assumes });
      }
    }
    const f = (x) => String(Number(x.toFixed(2)));
    for (const c of r.coords) {
      const pair = c.pairs.find(x => x.tooFar);
      if (!pair) continue;
      const p = (o) => `pull-coord${c.coord}-${o}`;
      const directional = c.geometry === 'DIRECTION';
      const counted = [0, 1, 2].filter(d => c.dim[d] && !(directional && !c.vec[d]));
      const apart = counted.map(d => `${f(Math.abs(pair.dr[d]))} nm along ${'xyz'[d]}`);
      const box = r.box.map((row, d) => f(row[d]));
      const fixes = [];
      if (pair.fewerDims) {
        fixes.push(`count only the dimensions you pull along (${p('dim')} = ${pair.fewerDims.dim} puts them ` +
          `${f(pair.fewerDims.distance)} nm apart, within the ${f(pair.fewerDims.limit)} nm that allows)`);
      }
      const need = pair.distance / 0.49;
      const short = counted.filter(d => d < r.npbcdim && r.box[d][d] < need);
      if (short.length) fixes.push(`make the box at least ${f(need + 0.005)} nm along ${andList(short.map(d => 'xyz'[d]))}`);
      if (c.geometry === 'DISTANCE') fixes.push(`pull along a vector (${p('geometry')} = direction, with ${p('vec')}), which counts only its own dimensions`);
      if (directional) fixes.push(`use ${p('geometry')} = direction-periodic, as grompp suggests`);
      const fix = fixes.length ? ` ${fixes[0][0].toUpperCase()}${andList(fixes, 'or').slice(1)}.` : '';
      this.add('error', 'pull-distance', p('dim'), `Distance between pull groups ${pair.groups[0]} and ${pair.groups[1]} ` +
        `(${f(pair.distance)} nm) is larger than 0.49 times the box size (${f(c.limit)} nm), and grompp stops. ` +
        `${p('dim')} = ${c.dim.map(x => (x ? 'Y' : 'N')).join(' ')}${directional ? ` with ${p('vec')} = ${ctrim(this.v[p('vec')])}` : ''} ` +
        `counts ${andList(counted.map(d => 'xyz'[d]))}, and the box is ${box.join(' x ')} nm: the centres of mass are ` +
        `apart by ${andList(apart)}.${fix}`, { assumes, fatal: true });
      return true;
    }
    return false;
  }

  finalChecks() {
    const v = this.v;
    // The values grompp settled on, set before any check below can stop it.
    v.nsttcouple = this.nsttcouple;
    v.nstpcouple = this.nstpcouple;
    v.rlist = this.rlist;
    v['nh-chain-length'] = this.nhchain;
    const nk = [v['fourier-nx'], v['fourier-ny'], v['fourier-nz']];
    if (COULOMB.FULL(this.ct) || this.vt === 'PME') {
      if (!nk.every(x => x > 0) && nk.every(x => x !== 0)) {
        this.add('error', 'fourier-partial', 'fourier-nx', 'Some of the Fourier grid sizes are set, but all of them need to be set.');
      }
      // calcFftGrid: a grid dimension left to fourierspacing needs a spacing above 0.
      if (nk.some(x => x <= 0) && f32(v.fourierspacing) <= 0) {
        this.add('error', 'fourierspacing', 'fourierspacing', `fourierspacing = ${v.fourierspacing} cannot set the PME grid: it must be above 0 ` +
          '(0.12 nm is usual), unless fourier-nx, -ny and -nz are all given. grompp stops.', { fatal: true });
        return;
      }
    }
    // set_pull_init (readpull.cpp) works the pull groups out from the
    // coordinates grompp reads, after the PME grid and before AWH: with the
    // structure at hand, its checks can be made too.
    if (this.gate.pull && this.ctx.structure && this.pullReach()) return;
    // AWH registers its dimensions with the pull code (set_pull_init and
    // setStateDependentAwhParams): each must be an external potential of AWH.
    if (this.gate.awh && this.gate.pull) {
      for (let b = 1; b <= v['awh-nbias']; b++) {
        for (let d = 1; d <= v[`awh${b}-ndim`]; d++) {
          if (key(v[`awh${b}-dim${d}-coord-provider`]) !== 'PULL') continue;
          const c = v[`awh${b}-dim${d}-coord-index`];
          if (key(v[`pull-coord${c}-type`]) !== 'EXTERNALPOTENTIAL') {
            this.add('error', 'awh-pull-type', `pull-coord${c}-type`, `AWH biases pull coordinate ${c}, so pull-coord${c}-type must be ` +
              `external-potential (with pull-coord${c}-potential-provider = awh), not ${v[`pull-coord${c}-type`]}. grompp stops.`, { fatal: true });
            return;
          }
          // register_external_pull_potential compares the name ignoring case only.
          if (String(v[`pull-coord${c}-potential-provider`]).toLowerCase() !== 'awh') {
            this.add('error', 'awh-pull-provider', `pull-coord${c}-potential-provider`, `AWH biases pull coordinate ${c}, so ` +
              `pull-coord${c}-potential-provider must be awh. grompp stops.`, { fatal: true });
            return;
          }
        }
      }
    }
    // The COM removal period against the global communication period
    // (grompp.cpp, computeGlobalCommunicationPeriod), for every integrator.
    if (this.commMode !== 'NONE') {
      let glob = this.nstcalcenergy === 0 && this.etc === 'NO' && this.epc !== 'NO' ? 200
        : lcd3(this.nstcalcenergy, this.etc !== 'NO' ? this.nsttcouple : 0, this.epc !== 'NO' ? this.nstpcouple : 0);
      if (this.ver < 2023) {
        // GROMACS 2022 (md_support.cpp): 10 steps, or nstenergy when shorter,
        // unless a period is chosen; then nstlist counts too (lcd4).
        const nt = this.etc !== 'NO' ? this.nsttcouple : 0;
        const np = this.epc !== 'NO' ? this.nstpcouple : 0;
        glob = !(this.nstcalcenergy > 0 || v.nstlist > 0 || this.etc !== 'NO' || this.epc !== 'NO')
          ? (v.nstenergy > 0 && v.nstenergy < 10 ? v.nstenergy : 10)
          : [this.nstcalcenergy, v.nstlist, nt, np].filter(x => x > 0).reduce(gcd, 0);
      }
      if (glob === 0) {
        const I = this.I;
        const why = EI.EM(I) ? `minimisers keep nstcalcenergy as given (only dynamics turns -1 into 100), and ${v.integrator} has no coupling`
          : this.etc === 'NO' && this.epc === 'NO' ? 'no thermostat or barostat supplies a period' : 'the coupling periods are not above 0 either';
        this.add('error', 'nstglobalcomm', 'nstcalcenergy', `nstcalcenergy = ${this.nstcalcenergy}: grompp needs a positive nstcalcenergy, ` +
          `nsttcouple or nstpcouple to set how often ranks communicate, and ${why}. It stops with "All 3 inputs for determining ` +
          'nstglobalcomm are <= 0". Set nstcalcenergy to 100, or comm-mode = None.', { fatal: true });
        return;
      }
      if (this.ver >= 2023) glob = glob > 200 ? lcd3(glob, 200, 0) : glob;
      if (this.nstcomm % glob !== 0) {
        this.add('note', 'nstcomm-global', 'nstcomm', `nstcomm (${this.nstcomm}) is not a multiple of the global communication period ` +
          `(${glob} steps, from nstcalcenergy, nsttcouple and nstpcouple), which costs extra communication in parallel. Set nstcomm to a multiple of ${glob}.`);
      }
    }
    // do_fepvals, writing the .tpr for every file: only sc-r-power = 6 is left.
    if (f32(v['sc-r-power']) !== 6) {
      this.add('error', 'sc-r-power', 'sc-r-power', `sc-r-power = ${v['sc-r-power']}: only 6 is supported (48 was removed), whether or not ` +
        'free-energy or soft-core is on. grompp stops as it writes the .tpr file. Remove the line or set it to 6.', { fatal: true });
    }
  }
}

/* ------------------------------------------------------------------ *
 * Pull groups in a structure
 * ------------------------------------------------------------------ */

/* c_pullGroupSmallGroupThreshold (pull.h): how far from its reference atom,
   in halves of the box, grompp lets a pull group reach. */
const PULL_GROUP_REACH = 0.5;

/* "a, b and c" */
function andList(items, last = 'and') {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${last} ${items[items.length - 1]}`;
}

const norm2 = (d) => d[0] * d[0] + d[1] * d[1] + d[2] * d[2];

/*
 * pbc_dx (src/gromacs/pbcutil/pbc.cpp): the vector from b to a through the
 * periodic box, shifted one box vector at a time from the last periodic
 * dimension down. A triclinic box can leave a shorter image next door,
 * which GROMACS then looks for among its neighbours; so does this.
 *
 * `box` holds the box as grompp stores it, in single precision. With
 * `single`, the arithmetic is single precision too, as pbc_dx's is in the
 * usual mixed-precision build (pbc_dx_d, between two centres, is double):
 * an atom half a box from the reference goes to one side or the other by
 * the last bit, and in a lattice-built bilayer whole rows of atoms sit
 * there, which moves the centre by hundredths of a nanometre.
 */
function pbcDx(box, npbcdim, single = false) {
  const r = single ? Math.fround : (x) => x;
  const tric = [[1, 0], [2, 0], [2, 1]].some(([i, j]) => i < npbcdim && box[i][j] !== 0);
  const shifts = [];
  if (tric) {
    const range = (d) => (d < npbcdim ? [-1, 0, 1] : [0]);
    for (const i of range(0)) for (const j of range(1)) for (const k of range(2)) {
      if (i || j || k) shifts.push([0, 1, 2].map(m => r(i * box[0][m] + j * box[1][m] + k * box[2][m])));
    }
  }
  return (a, b) => {
    const dx = [r(a[0] - b[0]), r(a[1] - b[1]), r(a[2] - b[2])];
    for (let i = npbcdim - 1; i >= 0; i--) {
      const L = box[i][i];
      const half = Math.fround(0.5 * L);
      // Far outside the box, the whole boxes in one go rather than a loop.
      if (Math.abs(dx[i]) > 4 * L) {
        const k = Math.round(dx[i] / L);
        for (let j = i; j >= 0; j--) dx[j] = r(dx[j] - k * box[i][j]);
      }
      while (dx[i] > half) for (let j = i; j >= 0; j--) dx[j] = r(dx[j] - box[i][j]);
      while (dx[i] <= -half) for (let j = i; j >= 0; j--) dx[j] = r(dx[j] + box[i][j]);
    }
    if (!tric) return dx;
    let best = dx;
    let d2 = norm2(dx);
    for (const s of shifts) {
      const t = [r(dx[0] + s[0]), r(dx[1] + s[1]), r(dx[2] + s[2])];
      const t2 = norm2(t);
      if (t2 < d2) { best = t; d2 = t2; }
    }
    return best;
  };
}

/*
 * max_pull_distance2 (pull.cpp): a quarter of the squared length of the
 * shortest box vector among the dimensions a coordinate counts, those of
 * pull-coord-dim or, pulling along a vector, those the vector has.
 */
function pullLimit2(box, npbcdim, directional, dim, vec) {
  const r = Math.fround;
  let max = Infinity;
  for (let m = 0; m < npbcdim; m++) {
    let d2 = r(box[m][m] * box[m][m]);
    if (directional) {
      if (!vec[m]) continue;
      for (let d = m + 1; d < 3; d++) d2 = r(d2 - r(box[d][m] * box[d][m]));
    } else {
      if (!dim[m]) continue;
      for (let d = 0; d < m; d++) if (dim[d]) d2 = r(d2 + r(box[m][d] * box[m][d]));
    }
    max = Math.min(max, d2);
  }
  return Number.isFinite(max) ? r(0.25 * max) : Infinity;
}

/**
 * @typedef {object} PullStructure
 * What grompp reads besides the .mdp for set_pull_init: the coordinates
 * (-c) and the index groups the pull group names are looked up in (-n).
 * @property {Array<{x:number, y:number, z:number}>} atoms - In file order, nm.
 * @property {number[][]|null} box - Box vectors as rows, nm.
 * @property {Array<{name:string, atoms:number[]}>} groups - Index groups, atoms from 1.
 * @property {number[]} [masses] - One per atom; equal masses when left out.
 * @property {string} [name] - The file, for messages.
 * @property {string} [massNote] - Where the masses come from, for messages.
 */

/**
 * The pull groups' centres of mass and the pull coordinates at the start,
 * as grompp works them out in set_pull_init
 * (src/gromacs/gmxpreprocess/readpull.cpp) from the coordinates it reads:
 *
 * - A group of one atom is that atom. A larger one is summed through the
 *   periodic boundary from its reference atom (pull-groupN-pbcatom; 0 takes
 *   the middle atom of the group, -1 cosine weighting) and, with
 *   pull-pbc-ref-prev-step-com = yes, summed again from the centre that
 *   gives (pull_calc_coms and initPullComFromPrevStep, pullutil.cpp).
 *   grompp refuses a group reaching further than a quarter of the box from
 *   its reference, unless the reference was chosen and the previous step's
 *   centre is followed (`obeysPbc`).
 * - A coordinate's groups are measured through the periodic boundary along
 *   the dimensions it counts, and grompp stops when they are further apart
 *   than 0.49 of the box along them (low_get_pull_coord_dr, pull.cpp);
 *   direction-periodic, and direction with an external potential, are not
 *   limited. The cylinder and direction-relative geometries, whose reference
 *   or vector depends on more than the groups, are not worked out.
 *
 * grompp uses the topology's masses; without them, `masses` (or equal
 * masses) stand in, which moves a centre by little in a group of many atoms.
 *
 * @param {Object<string,*>} settings - The file's options as grompp resolved
 *   them: `checkMdp(...).settings`.
 * @param {PullStructure} structure
 * @param {{equalMasses?:boolean}} [options] - Weigh every atom alike (a
 *   coarse-grained system, whose bead masses no name gives).
 * @returns {null|{npbcdim:number, box:number[][], prevStepCom:boolean,
 *   groups:Array<{group:number, name:string, natoms:number, com:number[]|null,
 *     mode:'none'|'atom'|'prev-step-com'|'cosine', pbcAtom:number, pbcatomInput:number, obeysPbc:boolean|null}>,
 *   coords:Array<{coord:number, geometry:string, dim:number[], vec:number[], checked:boolean,
 *     limit:number|null, value:number|null, tooFar:boolean,
 *     pairs:Array<{groups:number[], dr:number[], distance:number, tooFar:boolean,
 *       fewerDims:{dim:string, distance:number, limit:number}|null}>}>}}
 *   null when pull is off, or the structure has no atoms or no box to go by.
 *   Distances in nm; `limit` is 0.49 of the box along the counted dimensions
 *   (Infinity when none is periodic); `value` the coordinate's value
 *   (distance, or the projection on the vector for direction) for distance
 *   and direction; `pbcAtom` from 1 (0 for none); `fewerDims` the counted
 *   dimensions to keep for grompp to accept the pair, when some do.
 */
export function pullStart(settings, structure, options = {}) {
  const v = settings || {};
  const s = structure || {};
  const atoms = Array.isArray(s.atoms) ? s.atoms : [];
  if (v.pull !== 'yes' || !atoms.length) return null;
  const pbcType = key(v.pbc || 'xyz');
  if (pbcType === 'SCREW') return null;
  const npbcdim = pbcType === 'NO' ? 0 : pbcType === 'XY' ? 2 : 3;
  // Coordinates and box in single precision, as grompp reads them.
  const F = Math.fround;
  const box = [0, 1, 2].map(i => [0, 1, 2].map(j => F(Number(((s.box || [])[i] || [])[j]) || 0)));
  // grompp clears the third box vector for pbc = xy without two walls.
  if (pbcType === 'XY' && Number(v.nwall) !== 2) box[2] = [0, 0, 0];
  for (let d = 0; d < npbcdim; d++) if (!(box[d][d] > 0)) return null;
  const dx = pbcDx(box, npbcdim);
  const dx32 = pbcDx(box, npbcdim, true);
  const xyz = (i) => { const a = atoms[i]; return [F(Number(a.x) || 0), F(Number(a.y) || 0), F(Number(a.z) || 0)]; };
  const equal = !!options.equalMasses || !Array.isArray(s.masses);
  const prevStepCom = v['pull-pbc-ref-prev-step-com'] === 'yes';
  const ngroups = Math.max(0, Math.trunc(Number(v['pull-ngroups'])) || 0);
  const ncoords = Math.max(0, Math.trunc(Number(v['pull-ncoords'])) || 0);

  // Each coordinate as grompp reads it.
  const coords = [];
  for (let c = 1; c <= ncoords; c++) {
    const p = (o) => v[`pull-coord${c}-${o}`];
    const geometry = key(p('geometry') || 'distance');
    const need = geometry === 'DIHEDRAL' ? 6 : (geometry === 'DIRECTIONRELATIVE' || geometry === 'ANGLE') ? 4 : geometry === 'TRANSFORMATION' ? 0 : 2;
    const dim = words(p('dim') || 'Y Y Y').slice(0, 3).map(w => (/^y/i.test(w) ? 1 : 0));
    while (dim.length < 3) dim.push(0);
    const raw = scanReals(p('vec'), 3);
    const len = Math.hypot(...raw);
    const vec = raw.length === 3 && len > 0 ? raw.map(x => x / len) : [0, 0, 0];
    coords.push({ c, geometry, type: key(p('type') || 'umbrella'), groups: scanInts(p('groups'), need).slice(0, need), need, dim, vec,
      origin: scanReals(p('origin'), 3) });
  }

  // The dimensions each group is pulled along (for cosine weighting) and
  // those grompp checks its reach in (the reference group of a cylinder
  // coordinate excepted).
  const pulled = Array.from({ length: ngroups + 1 }, () => [0, 0, 0]);
  const reach = Array.from({ length: ngroups + 1 }, () => [0, 0, 0]);
  for (const co of coords) {
    co.groups.forEach((g, gi) => {
      if (g < 0 || g > ngroups) return;
      for (let d = 0; d < 3; d++) {
        if (!co.dim[d]) continue;
        pulled[g][d] = 1;
        if (!(co.geometry === 'CYLINDER' && gi === 0)) reach[g][d] = 1;
      }
    });
  }

  const lookup = (name) => {
    const want = String(name || '').trim().toLowerCase();
    return (Array.isArray(s.groups) ? s.groups : []).find(g => g && String(g.name).toLowerCase() === want) || null;
  };
  const groups = [{ group: 0, name: '', natoms: 0, com: [0, 0, 0], mode: 'none', pbcAtom: 0, pbcatomInput: -1, obeysPbc: null }];
  for (let g = 1; g <= ngroups; g++) {
    const name = String(v[`pull-group${g}-name`] || '').trim();
    const pbcatomInput = Math.trunc(Number(v[`pull-group${g}-pbcatom`] ?? 0)) || 0;
    const out = { group: g, name, natoms: 0, com: null, mode: 'none', pbcAtom: 0, pbcatomInput, obeysPbc: null };
    groups.push(out);
    const found = lookup(name);
    const ind = found && Array.isArray(found.atoms) ? found.atoms.map(n => Number(n) - 1) : [];
    out.natoms = ind.length;
    if (!ind.length || ind.some(i => !Number.isInteger(i) || i < 0 || i >= atoms.length)) continue;
    const weights = words(v[`pull-group${g}-weights`]).map(Number);
    if (weights.length && (weights.length !== ind.length || weights.some(w => !Number.isFinite(w)))) continue;
    let wm = ind.map((i, k) => F((weights.length ? weights[k] : 1) * (equal ? 1 : Math.max(0, Number(s.masses[i]) || 0))));
    // Atoms of no known mass: weigh them alike rather than divide by zero.
    if (!wm.some(x => x > 0)) wm = ind.map((_, k) => F(weights.length ? weights[k] : 1));
    const total = wm.reduce((a, b) => a + b, 0);
    if (!(total > 0)) continue;
    // Reference atoms: a number from 1, or the middle atom of the group.
    let pbcatom = -1;
    if (ind.length > 1) {
      if (pbcatomInput > 0) pbcatom = pbcatomInput - 1;
      else if (pbcatomInput === 0) pbcatom = ind[Math.floor((ind.length - 1) / 2)];
    }
    if (pbcatom >= atoms.length) continue;
    // sum_com_part: single-precision offsets from the reference, summed in
    // double; the reference itself is single precision.
    const sumFrom = (ref) => {
      const sum = [0, 0, 0];
      ind.forEach((i, k) => {
        const d = ref ? dx32(xyz(i), ref) : xyz(i);
        for (let m = 0; m < 3; m++) sum[m] += F(wm[k] * d[m]);
      });
      return [0, 1, 2].map(m => sum[m] * (1 / total) + (ref ? ref[m] : 0));
    };
    let ref = null;
    if (ind.length === 1 || npbcdim === 0) {
      // One atom, or no periodic boundary: the plain centre.
      out.com = sumFrom(null);
      if (ind.length > 1 && pbcatom >= 0) { out.mode = prevStepCom ? 'prev-step-com' : 'atom'; out.pbcAtom = pbcatom + 1; }
    } else if (pbcatom >= 0) {
      out.mode = prevStepCom ? 'prev-step-com' : 'atom';
      out.pbcAtom = pbcatom + 1;
      ref = xyz(pbcatom);
      out.com = sumFrom(ref);
      if (prevStepCom) {
        ref = out.com.map(F);
        out.com = sumFrom(ref);
      }
    } else {
      // Cosine weighting: the centre along the one periodic dimension the
      // group is pulled in, from the phases of its atoms (atan2_0_2pi);
      // grompp stops for more than one, and fills in no other component.
      out.mode = 'cosine';
      const dims = [0, 1, 2].filter(d => d < npbcdim && pulled[g][d]);
      if (dims.length !== 1) continue;
      const d = dims[0];
      const k = 2 * Math.PI / box[d][d];
      let cs = 0;
      let sn = 0;
      ind.forEach((i, j) => { cs += wm[j] * Math.cos(k * xyz(i)[d]); sn += wm[j] * Math.sin(k * xyz(i)[d]); });
      let phase = Math.atan2(sn, cs);
      if (phase < 0) phase += 2 * Math.PI;
      out.com = [0, 0, 0];
      out.com[d] = phase / k;
    }

    // pullGroupObeysPbcRestrictions, from the reference the sum started
    // from: per dimension in a rectangular box, as one distance in a
    // triclinic one.
    if (ref && ind.length > 1) {
      const uses = [0, 0, 0];
      let rect = true;
      for (let d = 0; d < npbcdim; d++) {
        if (!reach[g][d]) continue;
        uses[d] = 1;
        for (let d2 = d + 1; d2 < npbcdim; d2++) if (box[d2][d] !== 0) { uses[d2] = 1; rect = false; }
      }
      let margin2 = 0;
      for (let d = 0; d < npbcdim; d++) if (uses[d]) margin2 = F(margin2 + F(PULL_GROUP_REACH * 0.25 * norm2(box[d])));
      const margin = box.map((row, d) => F(PULL_GROUP_REACH * F(0.5 * row[d])));
      out.obeysPbc = ind.every((i) => {
        const d = dx32(xyz(i), ref);
        if (rect) return [0, 1, 2].every(m => !uses[m] || (d[m] >= -margin[m] && d[m] <= margin[m]));
        let r2 = 0;
        for (let m = 0; m < npbcdim; m++) if (uses[m]) r2 = F(r2 + F(d[m] * d[m]));
        return r2 <= margin2;
      });
    }
  }

  const out = { npbcdim, box, prevStepCom, groups: groups.slice(1), coords: [] };
  for (const co of coords) {
    const res = { coord: co.c, geometry: co.geometry, dim: co.dim, vec: co.vec, checked: false, limit: null, value: null, tooFar: false, pairs: [] };
    out.coords.push(res);
    if (co.groups.length !== co.need || !co.need || co.groups.some(g => g < 0 || g > ngroups)) continue;
    if (co.geometry === 'CYLINDER' || co.geometry === 'DIRECTIONRELATIVE') continue;
    const directional = co.geometry === 'DIRECTION' || co.geometry === 'DIRECTIONPERIODIC';
    const unlimited = co.geometry === 'DIRECTIONPERIODIC' || (co.geometry === 'DIRECTION' && co.type === 'EXTERNALPOTENTIAL');
    const md2 = unlimited ? Infinity : pullLimit2(box, npbcdim, directional, co.dim, co.vec);
    const coms = co.groups.map(g => groups[g].com);
    if (coms.some(x => !x)) continue;
    res.checked = true;
    res.limit = Number.isFinite(md2) ? 0.98 * Math.sqrt(md2) : Infinity;
    // Only the first group can be an absolute reference: then every pair
    // is measured from the origin (low_get_pull_coord_dr).
    const absolute = co.groups[0] === 0;
    const origin = co.origin.length === 3 ? co.origin : [0, 0, 0];
    for (let k = 0; k + 1 < co.need; k += 2) {
      const from = absolute ? origin : coms[k];
      const dr = dx(coms[k + 1], from).map((x, m) => x * co.dim[m]);
      const counted = [0, 1, 2].filter(m => co.dim[m] && !(directional && co.vec[m] === 0));
      const d2 = counted.reduce((a, m) => a + dr[m] * dr[m], 0);
      const tooFar = d2 > 0.98 * 0.98 * md2;
      // The counted dimensions to keep for grompp to accept the pair, when
      // they keep most of the distance (pulling across a membrane: z, not
      // the plane where the box is short and the membrane's centre is
      // wherever its reference atom is). Of those keeping nearly the most,
      // the one with the most room.
      let fewerDims = null;
      if (tooFar && !directional) {
        const ok = [];
        for (let mask = 1; mask < 8; mask++) {
          const keep = [0, 1, 2].map(m => ((mask >> m) & 1) && co.dim[m] ? 1 : 0);
          if (!keep.some(Boolean) || keep.every((x, m) => x === co.dim[m])) continue;
          const kd2 = keep.reduce((a, x, m) => a + (x ? dr[m] * dr[m] : 0), 0);
          const km2 = pullLimit2(box, npbcdim, false, keep, co.vec);
          if (kd2 > 0.98 * 0.98 * km2) continue;
          ok.push({ dim: keep.map(x => (x ? 'Y' : 'N')).join(' '), distance: Math.sqrt(kd2), limit: 0.98 * Math.sqrt(km2) });
        }
        const most = Math.max(0, ...ok.map(x => x.distance));
        const near = ok.filter(x => x.distance >= 0.9 * most).sort((a, b) => b.limit - a.limit);
        if (near.length && most >= 0.5 * Math.sqrt(d2)) fewerDims = near[0];
      }
      res.pairs.push({ groups: [co.groups[k], co.groups[k + 1]], dr, distance: Math.sqrt(d2), tooFar, fewerDims });
      res.tooFar = res.tooFar || tooFar;
    }
    const first = res.pairs[0];
    if (co.geometry === 'DISTANCE') res.value = first.distance;
    else if (directional) res.value = first.dr[0] * co.vec[0] + first.dr[1] * co.vec[1] + first.dr[2] * co.vec[2];
  }
  return out;
}

/* sscanf("%lf %lf ...") as grompp reads compressibility, ref-p and deform:
   numbers from the start, stopping at the first that does not parse. */
function scanReals(text, max) {
  const out = [];
  let s = String(text || '');
  while (out.length < max) {
    const m = C_NUMBER.exec(s);
    if (!m) break;
    out.push(cReal(m[0]).value);
    s = s.slice(m[0].length);
  }
  return out;
}

function scanInts(text, max) {
  const out = [];
  let s = String(text || '');
  while (out.length < max) {
    const m = new RegExp(`^${C_SPACE}*([+-]?\\d+)`).exec(s);
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
 * @param {{context?:object, version?:string}} [options] - As for {@link checkMdp}.
 * @returns {Array<{line:number, kind:'entry'|'empty'|'comment'|'blank'|'invalid', text:string,
 *   name:string|null, value:string, summary:string, meaning:string, url:string, valueUrl:string,
 *   unit:string, default:string, isDefault:boolean, status:'ok'|'unknown'|'obsolete'|'inactive'|'duplicate'|'ignored',
 *   comment:string, issues:MdpIssue[]}>} One row per line of the file.
 */
export function explainMdp(input, options = {}) {
  const parsed = typeof input === 'string' || input == null ? parseMdp(input) : input;
  const { issues, settings, version } = checkMdp(parsed, options);
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
      row.meaning = `Not an option of GROMACS ${version}; grompp warns "Unknown left-hand".` +
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
      // Renamed to an option that is only read when switched on.
      const gate = info.replacement ? optionInfo(info.replacement).readWhen : null;
      if (gate && row.issues.some(i => i.id === 'inactive')) {
        row.status = 'inactive';
        row.meaning = `Old name of ${info.replacement}, which grompp reads it as; but ${info.replacement} is only used when ${gate.when}, ` +
          'so grompp warns "Unknown left-hand".';
      }
      return row;
    }
    row.name = info.name;
    row.summary = info.summary;
    row.url = info.url;
    row.unit = info.unit;
    row.default = info.olderDefault && Number(version) < Number(info.olderDefault.before) ? info.olderDefault.value : info.default;
    if (e.duplicate) {
      row.status = 'duplicate';
      row.meaning = 'Given twice: grompp stops.';
      return row;
    }
    row.valueUrl = info.values.length ? mdpDocUrl(info.name, e.value) : '';
    if (row.issues.some(i => i.id === 'newer-option')) {
      row.status = 'unknown';
      row.meaning = `New in GROMACS ${info.since}: grompp ${version} does not know it and warns "Unknown left-hand".`;
      return row;
    }
    if (row.issues.some(i => i.id === 'inactive')) {
      row.status = 'inactive';
      row.meaning = `Not read: ${info.readWhen ? `${info.name} is only used when ${info.readWhen.when}`
        : 'it is beyond the count of its numbered family'}, so grompp warns "Unknown left-hand".`;
      return row;
    }
    row.isDefault = isDefaultValue({ ...info, default: row.default }, e.value);
    const unit = unitFor(info, settings);
    row.unit = unit === undefined ? info.unit : unit || '';
    row.meaning = meaningOf(info, e.value, { dt, dynamics, settings, parsed }) +
      (row.isDefault ? ' (This is the default.)' : '');
    return row;
  });
}

function isDefaultValue(info, value) {
  const d = info.default;
  const row = lookup(info.name).row;
  if (d === '' && info.defaultFrom) return false;
  if (info.kind === 'integer') {
    const a = cInteger(value, row.i64 ? 64 : 32);
    return a.ok && d !== '' && a.value === Number(d);
  }
  if (info.kind === 'real') {
    const a = cReal(value);
    return a.ok && d !== '' && a.value === Number(d);
  }
  if (info.kind === 'enum') {
    // As grompp reads it: with case and by prefix for the module options.
    const hit = matchEnumValue(row, value);
    return hit !== null && (key(hit) === key(d) || (info.gromppDefault !== null && key(hit) === key(info.gromppDefault)));
  }
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
  const row = lookup(n).row;
  let num = cReal(value);
  if (info.kind === 'integer') {
    // Whole numbers only, as grompp stores them: nsteps = 5e5 is refused,
    // and a get_eint option keeps only 32 bits.
    const whole = isModuleRow(row) ? strictInt(value) : null;
    const r = isModuleRow(row) ? { ok: whole !== null, value: whole, wrapped: false } : cInteger(value, row.i64 ? 64 : 32);
    if (!r.ok) return `"${value}" is not a whole number${isModuleRow(row) ? ' that fits in 32 bits' : ''}, so grompp stops.`;
    if (r.wrapped) return `${value} does not fit in the integer grompp keeps it in: grompp reads it, without a message, as ${r.value}.`;
    num = { ok: true, value: r.value };
  } else if (info.kind === 'real' && !num.ok) {
    return `"${value}" is not a number, so grompp stops.`;
  }
  const ps = (steps) => formatDuration(steps * ctx.dt);
  if (info.kind === 'enum') {
    const hit = matchEnumValue(row, value);
    if (!hit) {
      const refused = info.values.find(x => x.status === 'rejected' && key(x.value) === key(value));
      if (refused) return `${value}: ${refused.summary || info.summary} ${refused.note}`;
      return `"${value}" is not one of the values of ${n}${isModuleRow(row) ? ' (this option compares values with case)' : ''}, so grompp stops.`;
    }
    const read = isModuleRow(row) && hit !== value ? ` (read as ${hit})` : '';
    const v = info.values.find(x => x.value === hit);
    if (v) return `${value}${read}: ${v.summary || info.summary}${v.status && v.note ? ` ${v.note}` : ''}`;
    const u = info.undocumented.find(x => x.value === hit);
    if (u && u.note) return `${value}${read}: ${u.note}`;
    return `${value}${read}: accepted by grompp, though the manual does not describe it.`;
  }
  if (info.kind === 'boolean') {
    const v = info.values.find(x => key(x.value) === key(value)) ||
      info.values.find(x => x.value === (['1', 'yes', 'true'].includes(value.toLowerCase()) ? 'true' : 'false'));
    if (v) return `${value}: ${v.summary || info.summary}${v.status && v.note ? ` ${v.note}` : ''}`;
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
  if (n === 'define' || n === 'include') {
    // cpp_opts (topio.cpp): only words that start with -D (define) or -I
    // (include) reach the preprocessor.
    const flag = n === 'define' ? '-D' : '-I';
    return words(value).map(f => {
      if (f.length <= 2) return `${f}: too short for grompp's parser, which never finishes on it (grompp hangs).`;
      if (!f.startsWith(flag)) return `${f}: ignored, with a warning ("Malformed ${n} option"), as it does not start with ${flag}.`;
      if (n === 'include') return `${f}: ${f.slice(2)} is searched for #include files.`;
      const m = /^-D([A-Za-z_]\w*)(=(.*))?$/.exec(f);
      if (!m) return `${f}: passed to the topology preprocessor.`;
      const known = DEFINES[m[1]];
      return `-D${m[1]}${m[2] || ''}: ${known || `defines ${m[1]}${m[3] ? ` = ${m[3]}` : ''} for #ifdef blocks in the topology`}.`;
    }).join(' ');
  }
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
  if (/^awh\d+-dim\d+-diffusion$/.test(n) && num.ok && !(num.value > 0)) {
    return `${value}: grompp replaces a diffusion constant of 0 or below by 1e-5 ${unitFor(info, ctx.settings) || 'nm²/ps'} and notes that it was not set.`;
  }
  const special = unitFor(info, ctx.settings);
  if (special === null || special === 'lambda state') {
    return /-end$|-start$/.test(n) ? `Lambda state ${value}.` : `${value}: not used when the coordinate is the lambda state (leave it at 0).`;
  }
  const unit = special === undefined ? info.unit.replace(/ or .*/, '') : special;
  if (unit && num.ok && (info.kind === 'real' || info.kind === 'integer')) {
    return `${value} ${unit}.`;
  }
  if (info.per) return `${words(value).length} value${words(value).length === 1 ? '' : 's'}: ${words(value).join(', ')}.`;
  return value ? `${value}.` : '';
}

/*
 * The unit of a pull or AWH value, which the manual gives as alternatives
 * ("nm or deg"): it follows the coordinate's geometry and type, and for AWH
 * the coordinate provider. Returns undefined for other options, '' where the
 * unit is not known (a transformation coordinate), 'lambda state' for an
 * AWH interval along lambda and null for an AWH value lambda does not use.
 */
function unitFor(info, settings) {
  const n = info.name;
  const angular = (g) => ['ANGLE', 'ANGLEAXIS', 'DIHEDRAL'].includes(g);
  let m = /^pull-coord(\d+)-(init|rate|k|kB)$/.exec(n);
  if (m) {
    const geom = key(settings[`pull-coord${m[1]}-geometry`] ?? 'distance');
    if (geom === 'TRANSFORMATION') return '';
    const ang = angular(geom);
    if (m[2] === 'init') return ang ? 'deg' : 'nm';
    if (m[2] === 'rate') return ang ? 'deg/ps' : 'nm/ps';
    // A constant force is a force, not a force constant (mdp-options, pull-coord1-k).
    const per = key(settings[`pull-coord${m[1]}-type`] ?? 'umbrella') === 'CONSTANTFORCE' ? '⁻¹' : '⁻²';
    return `kJ mol⁻¹ ${ang ? 'rad' : 'nm'}${per}`;
  }
  m = /^awh(\d+)-dim(\d+)-(start|end|force-constant|diffusion|cover-diameter)$/.exec(n);
  if (m) {
    const at = (s) => settings[`awh${m[1]}-dim${m[2]}-${s}`];
    if (key(at('coord-provider') ?? 'pull') === 'FEPLAMBDA') {
      return { start: 'lambda state', end: 'lambda state', 'cover-diameter': 'lambda states', diffusion: 'ps⁻¹', 'force-constant': null }[m[3]];
    }
    const geom = key(settings[`pull-coord${at('coord-index')}-geometry`] ?? 'distance');
    if (geom === 'TRANSFORMATION') return '';
    const ang = angular(geom);
    return {
      start: ang ? 'deg' : 'nm', end: ang ? 'deg' : 'nm', 'cover-diameter': ang ? 'deg' : 'nm',
      'force-constant': ang ? 'kJ mol⁻¹ rad⁻²' : 'kJ mol⁻¹ nm⁻²', diffusion: ang ? 'rad²/ps' : 'nm²/ps'
    }[m[3]];
  }
  return undefined;
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
    // GROMOS was parametrised with every bond length constrained by SHAKE;
    // GROMACS lists only AMBER, CHARMM and OPLS as fitted with h-bonds only
    // (topio.cpp), and notes all-bonds for those three alone.
    dt: 0.002, constraints: 'all-bonds', hmr: true, nstlist: 10,
    coulombtype: 'PME', rcoulomb: 1.4, vdwtype: 'Cut-off', vdwModifier: 'Potential-shift', rvdw: 1.4, rvdwSwitch: null,
    dispCorr: 'no', epsilonR: null, epsilonRf: null,
    tauT: { 'v-rescale': 0.1, 'nose-hoover': 0.5, berendsen: 0.1 },
    tauP: { 'c-rescale': 1.0, 'parrinello-rahman': 5.0, berendsen: 1.0 },
    compressibility: 4.5e-5,
    why: {
      cutoff: 'GROMOS: keep the 1.4 nm cut-off the parameters were fitted with (then with a reaction field; PME is the usual choice now)',
      dispCorr: 'GROMOS was parametrised without a long-range dispersion correction',
      constraints: 'GROMOS was parametrised with all bond lengths constrained (SHAKE), which also allows the time step above'
    },
    notes: ['The GROMACS manual warns that GROMOS was parametrised with a twin-range cut-off scheme GROMACS no longer has, so properties such as the density may differ slightly from the intended values.'],
    references: [
      { text: 'GROMACS manual, force fields: GROMOS (and its warning)', url: `${FF_GUIDE}#gmx-gromos-ff` },
      { text: 'Schmid et al., Eur. Biophys. J. 40, 843 (2011): GROMOS 54A7', url: 'https://doi.org/10.1007/s00249-011-0700-9' },
      { text: 'Oostenbrink et al., J. Comput. Chem. 25, 1656 (2004): GROMOS 53A5/53A6, all bond lengths constrained with SHAKE at 2 fs', url: 'https://doi.org/10.1002/jcc.20090' }
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
    // The recommended Martini 3 mdp (cgmartini.nl, martini_v3.0_prod.mdp):
    // the automatic buffer gives pressure artefacts with Martini, so the
    // buffer is fixed; coupling every nstlist steps; LINCS for the
    // constraint triangles and virtual sites the topologies carry.
    pairList: Object.freeze({ verletBufferTolerance: -1, rlist: 1.35, nstcouple: 20 }),
    lincs: Object.freeze({ order: 8, iter: 2 }),
    topologyConstraints: true,
    coulombtype: 'Reaction-Field', rcoulomb: 1.1, vdwtype: 'Cut-off', vdwModifier: 'Potential-shift', rvdw: 1.1, rvdwSwitch: null,
    dispCorr: 'no', epsilonR: 15, epsilonRf: 0,
    tauT: { 'v-rescale': 1.0, 'nose-hoover': 4.0, berendsen: 1.0 },
    tauP: { 'c-rescale': 4.0, 'parrinello-rahman': 12.0, berendsen: 4.0 },
    compressibility: 3e-4,
    why: {
      cutoff: 'Martini 3: reaction field with epsilon-r = 15, epsilon-rf = 0 (infinity) and 1.1 nm cut-offs (de Jong et al. 2016)',
      dispCorr: 'Martini is used without a dispersion correction',
      pairList: 'Martini 3: the automatic buffer gives pressure artefacts, so the recommended settings fix rlist (cgmartini.nl)',
      lincs: 'Martini 3 recommendation for its constraint triangles and virtual sites at 20 fs'
    },
    notes: ['Martini topologies keep their own [ constraints ] (rings, helices); constraints = none only leaves ordinary bonds flexible.'],
    references: [
      { text: 'de Jong, Baoukina, Ingolfsson and Marrink, Comput. Phys. Commun. 199, 1 (2016): Martini with a 1.1 nm cut-off and the Verlet scheme', url: 'https://doi.org/10.1016/j.cpc.2015.09.014' },
      { text: 'Souza et al., Nat. Methods 18, 382 (2021): Martini 3', url: 'https://doi.org/10.1038/s41592-021-01098-3' },
      { text: 'Martini force field: example input files (martini_v3.0_prod.mdp)', url: 'https://cgmartini.nl' }
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
  // CHARMM-GUI's index groups; its index has SOLU only when there is a solute,
  // so a lipid-only bilayer needs MEMB SOLV.
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
    version: DEFAULT_GROMACS_VERSION,
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
 *   - `version`: the GROMACS release to write for, one of {@link GROMACS_VERSIONS}
 *     ('2025' by default). Options it does not read are left out (and HMR,
 *     which needs 2024, is not applied); every line where the release
 *     changes something says so in its comment
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
 *     dim, vec, k (kJ mol^-1 nm^-2), rateNmPerPs, outputPs, pbcatom1, pbcatom2}`; the
 *     pbcatoms (atom numbers near the centre of each group, 0 for none) are needed
 *     for groups wider than a quarter of the box, and switch on pull-pbc-ref-prev-step-com
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
  const version = gromacsVersion(s.version);
  const ver = Number(version);
  const has = (option) => rowInVersion(ROW_BY_NAME.get(option), version);
  const warnings = [];
  const out = [];
  const cg = ff.resolution === 'coarse-grained';
  let section = '';
  const head = (title) => { section = title; out.push({ section: title, heading: true }); };
  const put = (name, value, comment) => out.push({ name, value: String(value), comment: comment || '', section });

  // Time step and hydrogen mass repartitioning
  let hmr = !!s.hmr && st.dynamics;
  // Hydrogen mass repartitioning asked for, but this release has no
  // mass-repartition-factor: the time step line says so.
  let hmrTooOld = false;
  if (hmr && !ff.hmr) {
    warnings.push(`Hydrogen mass repartitioning does not apply to ${ff.label}: it has no hydrogens to repartition. Ignored.`);
    hmr = false;
  } else if (hmr && !has('mass-repartition-factor')) {
    warnings.push(`Hydrogen mass repartitioning needs GROMACS 2024 or newer (mass-repartition-factor); GROMACS ${version}'s grompp does not ` +
      'know the option and stops on it. The files use the usual time step: for 4 fs with GROMACS ' +
      `${version}, repartition the hydrogen masses in the topology itself (for example with ParmEd's HMassRepartition) and set the time step to 4 fs.`);
    hmr = false;
    hmrTooOld = true;
  }
  const dt = st.dynamics ? (Number(s.dt) > 0 ? Number(s.dt) : (hmr ? 0.004 : ff.dt)) : null;
  if (st.dynamics && !cg && dt > 0.0025 && !hmr) {
    warnings.push(`dt = ${dt} ps without hydrogen mass repartitioning is too long for an ${ff.resolution} force field: angles involving hydrogen become unstable. ` +
      (has('mass-repartition-factor') ? 'Use 0.002 ps, or switch on HMR for 0.004 ps.'
        : `Use 0.002 ps, unless the topology's hydrogen masses are already repartitioned (GROMACS ${version} has no mass-repartition-factor).`));
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
    warnings.push(`C-rescale does not support anisotropic coupling in GROMACS ${version}; Parrinello-Rahman is used instead.`);
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
  if (s.system === 'membrane' && !settings.tcGroups && st.dynamics && tcGroups.includes('SOLU')) {
    warnings.push('tc-grps = SOLU MEMB SOLV follows the index file CHARMM-GUI writes, which has a SOLU group only when the system has ' +
      'a solute: for a lipid-only bilayer use MEMB SOLV, or grompp stops ("Group SOLU referenced in the .mdp file was not found").');
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
  // Coupling every nstlist steps (Martini 3), where the time constants allow
  // it: grompp warns below 5 steps per tau (20 per period for Nose-Hoover and
  // Parrinello-Rahman); v-rescale has no such limit.
  const nstCouple = st.dynamics && ff.pairList ? ff.pairList.nstcouple : 0;
  const couples = (tau, min) => !min || tau / (dt * nstCouple) >= min;
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
  const release = gromacsVersionInfo(version);
  lines.push(`; Written by the STEMKit MD workflow generator for GROMACS ${version === DEFAULT_GROMACS_VERSION ? MDP_RELEASE : version}.`);
  lines.push(`; Every option: ${release.manual}`);
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
    const rigid = ff.constraints === 'all-bonds' ? 'all bonds are constrained' : 'bonds to hydrogen are constrained';
    put('dt', real(dt), hmr ? `4 fs, possible because hydrogens are 3x heavier (mass-repartition-factor) and ${rigid}`
      : cg ? '20 fs, the usual Martini time step' : `2 fs, possible because ${rigid}` +
        (hmrTooOld && dt === ff.dt ? `; no HMR: GROMACS ${version} has no mass-repartition-factor (new in 2024)` : ''));
    put('nsteps', nsteps, `${nsteps} x ${dt} ps = ${formatDuration(nsteps * dt)}`);
    if (hmr) {
      put('mass-repartition-factor', real(3), 'hydrogens become 3x heavier, the mass taken from their bonded atom (GROMACS manual: a factor of 3 ' +
        `with the bonds to hydrogen constrained allows 4 fs${ff.constraints === 'all-bonds' ? '; here all bonds are' : ''})`);
    }
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
  if (st.dynamics && ff.pairList) {
    put('verlet-buffer-tolerance', real(ff.pairList.verletBufferTolerance), ff.why.pairList +
      (has('verlet-buffer-pressure-tolerance') ? '' : `; GROMACS ${version} has no verlet-buffer-pressure-tolerance to switch off (new in 2024)`));
    if (has('verlet-buffer-pressure-tolerance')) {
      put('verlet-buffer-pressure-tolerance', real(-1), 'not used with a fixed rlist; -1 says so (grompp notes a positive value)');
    }
    put('rlist', real(ff.pairList.rlist), `pair-list cut-off (nm): at least ${ff.pairList.rlist} with nstlist = ${ff.nstlist} and ` +
      `${ff.rcoulomb} nm cut-offs, as recommended`);
  } else if (st.dynamics) {
    put('verlet-buffer-tolerance', real(0.005), 'grompp sizes the pair-list buffer (rlist) from this; the default');
  }
  put('coulombtype', ff.coulombtype, ff.why.cutoff);
  put('rcoulomb', real(ff.rcoulomb), 'real-space Coulomb cut-off (nm)');
  if (ff.epsilonR !== null) put('epsilon-r', ff.epsilonR, 'Martini screens electrostatics with a relative dielectric constant of 15');
  if (ff.epsilonRf !== null) put('epsilon-rf', ff.epsilonRf, 'reaction field with infinite dielectric beyond the cut-off');
  put('vdwtype', ff.vdwtype, 'Lennard-Jones with a cut-off');
  put('vdw-modifier', ff.vdwModifier, ff.vdwModifier === 'Force-switch' ? 'CHARMM36 needs the force switched to zero' : 'shift the potential to zero at the cut-off (forces unchanged)');
  if (ff.rvdwSwitch !== null) put('rvdw-switch', real(ff.rvdwSwitch), 'switching starts here (nm)');
  // check_ir: rcoulomb and rvdw may differ with the Verlet scheme only as
  // rcoulomb > rvdw with PME (or Ewald) and cut-off Lennard-Jones.
  put('rvdw', real(ff.rvdw), ff.coulombtype === 'PME'
    ? 'Lennard-Jones cut-off (nm); with PME and the Verlet scheme it may be shorter than rcoulomb, never longer'
    : 'Lennard-Jones cut-off (nm); with reaction field and the Verlet scheme it must equal rcoulomb');
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
    if (nstCouple && couples(tau, { 'v-rescale': 0, berendsen: MIN_STEPS_PER_TAU, 'nose-hoover': MIN_STEPS_PER_PERIOD }[thermostat])) {
      put('nsttcouple', nstCouple, `thermostat every ${nstCouple} steps, a multiple of nstlist, as the Martini 3 settings recommend`);
    }
    const membraneGroups = s.system === 'membrane' && tcGroups.join(' ') === SYSTEM_TYPES.membrane.tcGroups.join(' ');
    put('tc-grps', tcGroups.join(' '), membraneGroups
      ? 'CHARMM-GUI index groups; SOLU exists only with a solute: use MEMB SOLV for a lipid-only bilayer'
      : tcGroups.length > 1 ? 'coupled separately; the names must exist as default or index groups (grompp -n)' : 'the whole system as one group');
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
      if (nstCouple && couples(tauP, barostat === 'parrinello-rahman' ? MIN_STEPS_PER_PERIOD : MIN_STEPS_PER_TAU)) {
        put('nstpcouple', nstCouple, `barostat every ${nstCouple} steps, a multiple of nstlist, as the Martini 3 settings recommend`);
      }
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
    : constraints === 'h-bonds' ? 'bonds to hydrogen are rigid, which allows the time step above'
      : constraints === 'all-bonds' ? (ff.why.constraints || 'all bonds are rigid, which allows the time step above')
        : 'Martini topologies bring their own [ constraints ]');
  put('constraint-algorithm', 'LINCS', 'fast parallel constraint solver');
  if (st.dynamics) {
    put('continuation', continuation ? 'yes' : 'no', continuation ? 'continues the previous stage (grompp -t state.cpt): do not re-constrain the start'
      : 'first dynamics after minimisation: constrain the starting structure');
    put('lincs-iter', ff.lincs ? ff.lincs.iter : 1, ff.lincs ? ff.why.lincs : 'enough with a thermostat');
    put('lincs-order', ff.lincs ? ff.lincs.order : 4, ff.lincs ? ff.why.lincs : 'enough for normal MD');
  } else if (st.integrator === 'cg' && ff.topologyConstraints) {
    // double_check notes lincs-order < 8 for cg with constraints, which
    // Martini topologies bring whatever the constraints option says.
    put('lincs-order', 8, 'accurate conjugate-gradient minimisation with LINCS needs order 8 (the topology has [ constraints ])');
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
    // readpull.cpp: grompp stops when a group reaches further than a quarter
    // of the box from its reference atom, which is the middle atom by number
    // unless pull-groupN-pbcatom names a central one.
    const pbcatoms = [p.pbcatom1, p.pbcatom2].map(x => Math.max(0, Math.round(Number(x)) || 0));
    put('pull-group1-name', p.group1, pbcatoms[0] ? 'reference group (index group name)'
      : 'reference group (index group name); wider than a quarter of the box, it needs pull-group1-pbcatom');
    if (pbcatoms[0]) put('pull-group1-pbcatom', pbcatoms[0], 'an atom near the centre of the reference group, for its periodic images');
    put('pull-group2-name', p.group2, 'pulled group (index group name)');
    if (pbcatoms[1]) put('pull-group2-pbcatom', pbcatoms[1], 'an atom near the centre of the pulled group, for its periodic images');
    if (pbcatoms.some(Boolean)) {
      put('pull-pbc-ref-prev-step-com', 'yes', 'follow the centre of mass of the previous step, starting from the atoms above: for large or flexible groups');
    } else {
      warnings.push('grompp stops when a pull group reaches further than a quarter of the box from its reference atom, which is the middle ' +
        'atom by number unless you choose one. For a large group, such as a membrane or a protein chain, set pull-group1-pbcatom ' +
        '(or pull-group2-pbcatom) to an atom near its centre, with pull-pbc-ref-prev-step-com = yes.');
    }
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
  const { issues } = checkMdp(text, { context, version });
  const expected = issues.filter(i => i.source === 'grompp').map(i => ({ severity: i.severity, id: i.id, message: i.message }));
  for (const i of issues.filter(x => x.source !== 'grompp' && x.severity !== 'note')) warnings.push(i.message);

  return {
    text,
    fileName: `${fileBase(s.stage)}.mdp`,
    stage: s.stage,
    settings: { ...s, version, dt, nsteps, barostat, thermostat, couplingType, tcGroups, hmr, genVel, continuation },
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
 *   output still apply unless given). The first dynamics stage in the list
 *   always draws new velocities and constrains its start (gen-vel = yes,
 *   continuation = no), since what precedes it is a minimisation or nothing;
 *   settings.perStage can say otherwise.
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
  let dynamicsBefore = false;
  return stages.map(stage => {
    const own = (settings.perStage || {})[stage] || {};
    const first = STAGES[stage] && STAGES[stage].dynamics && !dynamicsBefore;
    if (STAGES[stage] && STAGES[stage].dynamics) dynamicsBefore = true;
    // The first dynamics stage follows a minimisation (or nothing), which
    // leaves no velocities and unconstrained bonds: it draws new velocities
    // and constrains the start, whichever stage it is.
    const start = first ? { genVel: true, continuation: false } : {};
    return generateMdp({ ...shared, stage, ...start, ...own });
  });
}
